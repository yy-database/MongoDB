# Cross-process replication: pre-assessment

Planning only. Nothing in this document is implemented yet, and no code in
this change makes a member replicate. It lists the commands, session semantics
and capabilities a second process would need, what the oplog consumer still
lacks, why rollback is impossible in the current topology, and the order in
which the gaps have to close before any of it can start.

## What exists today

- One server process owns one `.yykv` shard. `local.oplog.rs` is persisted and
  every successful write appends an entry with `ts/t/op/ns/o/o2/ui`, capped at
  990 MB by default (`--oplog-size-mb`). `replSetGetStatus.optime` follows the
  newest entry and write replies carry the same `opTime`.
- The set configuration is persisted in `local.system.replset` on a successful
  `replSetInitiate` and restored at startup, so a restart keeps the initiated
  set instead of returning to `NotYetInitialized` (94). Election state
  (`electionId`, `term`, oplog-recovered `optime`) is still per-process. The
  set has exactly one member: the local primary.
- Nothing consumes the oplog. `syncSourceHost` is empty and there is no initial
  sync, no second member and no rollback. The deliberate rule is that this
  server never fabricates a SECONDARY (see `KNOWN-DIFFERENCES.md`).

## 1. Initial sync: commands and session semantics

A real initial sync is a sequence of ordinary commands against a sync source;
none of them are new wire verbs. What has to exist is the correct reply and
cursor semantics.

| step | command | semantics this server is missing |
|------|---------|-----------------------------------|
| discover the source | `hello` with `topologyVersion`, `maxAwaitTimeMS`, `exhaustAllowed` | the handshake answers once instead of holding a stream, so streaming monitoring ends immediately; polling mode works |
| read the set | `replSetGetStatus`, `replSetGetConfig` | the reply describes one member and no `initialSync` progress block |
| clone data | `listCollections` then `listIndexes` per collection | present, but the cloning read has to be issued with `$readPreference` and a session, and batches must resume after a reconnect |
| clone documents | `find` + `getMore`, batched by `_id`, `noCursorTimeout` | `find`/`getMore` exist; the clone loop itself does not |
| read the oplog | `find` on `local.oplog.rs` with `tailable`, `awaitData`, `maxAwaitTimeMS`, then `getMore` | the namespace is readable but a normal cursor, not a tailable one |
| apply | `applyOps` on `admin.$cmd`, `mayBypassWriteConcern: true` | `applyOps` is accepted only as an oplog entry, not executed as a command |
| session | `lsid`, `txnNumber` | accepted and ignored; there is no `config.transactions`, so a retried `applyOps` is not deduplicated |

Session semantics that matter for a second member:

- A clone connection uses one `lsid` per thread. Initial sync does not open a
  transaction; it does use retryable writes while cloning, so the receiver must
  either deduplicate `txnNumber` or the clone must not retry.
- `readConcern: "majority"` on the clone read means "up to the last stable
  oplog timestamp". With one member, stable equals the newest entry; a second
  member makes this a real barrier and must not regress.
- `applyOps` from a sync source is not an ordinary write: it bypasses
  write concern, may target `system.*` namespaces, and must be applied in `ts`
  order without re-stamping timestamps.
- `hello` from a syncing member must report `isWritablePrimary: false`,
  `secondary: true`, `setName`, `me`, `primary`, and an `initialSync` progress
  object in `replSetGetStatus` (`stage`, `syncedTo`, `done`). Until all of that
  is true, the server must keep answering as a single primary rather than
  advertise a state it cannot serve.

## 2. What the oplog consumer still needs

1. **Tailable cursor semantics.** `find` has no `tailable`/`awaitData` mode and
   `getMore` has no `maxAwaitTimeMS`. A consumer has to block for a bounded
   time, receive an empty batch, and keep the cursor alive across repeated
   `getMore` calls. `killCursors` and `noCursorTimeout` already exist.
2. **Ordered resume.** Every entry already carries `ts`, `t`, `op`, `ns`, `ui`,
   `o`, `o2`. A consumer needs a stable resume token (`ts` plus `t` plus `i`)
   and the guarantee that the oplog is strictly increasing; the append path
   provides the order today.
3. **Rollback-aware reads.** Capped retention can drop the oldest entries, so a
   consumer must detect a gap and fall back to initial sync. `h` is no longer
   written, so undo information comes only from `o2` and the version 2 diff.
4. **Cluster time.** Replies carry neither `$clusterTime` nor `operationTime`.
   Drivers use them for causal consistency and for retryable-write ordering;
   they must exist before two processes can agree on a "now".
5. **Apply path.** `applyOps` must run under the same storage primitives as
   normal writes (`insert`/`update`/`delete` on the named namespace), keep
   `ui` for collection identity, and be idempotent for a retried batch.

## 3. Rollback in a single-member topology

Rollback is not "missing"; it is **not applicable**. Rollback exists to undo
writes that one member accepted while another member had already advanced
further on a diverging history. A set with one member has one history, so there
is no second oplog to compare against and no common point to roll back to.
Implementing a rollback stage now would either be dead code or, worse, would
roll back writes that were never divergent.

If a second process is ever added, rollback needs all of the following, most of
which do not exist:

- two oplogs with a shared history and a detected divergence point;
- `local.system.replset` persisted with a real `setVersion` and member ids
  (persistence and restore exist; `setVersion` only ever stays 1 until
  `replSetReconfig` lands);
- `applyOps` that can replay the inverse of the losing branch (`o2`, version 2
  diffs) with the original timestamps;
- a barrier that stops writes on the member being rolled back while the
  comparison runs;
- `replSetGetStatus` fields that report the rollback honestly.

Until those exist, `replSetGetStatus` must not claim a rollback happened, and
`w: "majority"` must keep meaning "the only member has accepted it".

## 4. Prerequisites before any replication work starts

Ordered by what blocks what. Phase 0 and Phase 1 can be built without a second
process; Phase 2 cannot.

**Phase 0 — foundations, one process**

1. Done: the set configuration persists in `local.system.replset` and
   `setVersion` and `replicaSetId` survive restarts; `term` and `electionId`
   are still regenerated per process, and `optime` is not recovered from the
   oplog across a restart.
2. Emit `$clusterTime` and `operationTime` on every reply and keep `electionId`
   stable for the life of the primary.
3. Implement `tailable`/`awaitData` on `find` and `maxAwaitTimeMS` on
   `getMore`, scoped to the oplog namespace first.
4. Execute `applyOps` as a command with bypassed write concern, ordered apply and
   retry idempotency.
5. Either stream `hello` (`topologyVersion` + awaitable reply) or document that
   only polling monitors are supported, so a driver does not wait for a stream
   that never arrives.

**Phase 1 — a second member in another process**

6. Member identity and topology fields: `me`, `hosts`, `primary`, `setName`,
   `setVersion`, and honest `secondary: true` only on a real syncing member.
7. Initial sync: collection and index clone, batched document clone with
   resume, then oplog catch-up from the clone's start timestamp.
8. Steady-state apply with a resume token, gap detection and no re-stamping.
9. Sync source selection and `secondary` eligibility, so `readPreference:
   secondary` reaches a member that really has the data.

**Phase 2 — divergence**

10. Oplog comparison, rollback, `replSetReconfig`, elections and failover.

Each phase is gated by a real `mongod 8.0.9` reference topology (two members,
one primary one secondary) driven by the official drivers and `mongosh`; a
green run against this server alone is not evidence.

## Explicit non-goals for the next change

No second process, no fabricated secondary, no initial sync, no rollback, no
failover. The oplog keeps being written and readable; it keeps not being
consumed.
