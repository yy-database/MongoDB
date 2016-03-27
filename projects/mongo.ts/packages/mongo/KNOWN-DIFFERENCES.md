# Known differences from `mongod`

Deliberate, reviewed deviations between this server and `mongod 8.0.9`.
Everything not listed here is meant to match the real server.

## `OP_COMPRESSED` malformed frames

Real `mongod 8.0.9` reacts differently depending on how the announced
`uncompressedSize` is wrong:

- announced size larger than the decoded body: replies with an error
  (`Location40430`) and keeps the connection;
- announced size smaller than the decoded body: closes the connection without
  any reply.

This server always answers `ok: 0` with an explicit `errmsg` naming both sizes,
then closes the connection. The deviation is on purpose: a client that gets an
answer can report why it was dropped, while the connection is still torn down
so a lying frame can never be treated as valid.

An original opcode other than `OP_MSG` is rejected outright. Real `mongod`
answers such a frame with a compressed `OP_REPLY` carrying "OP_QUERY is no
longer supported"; rejecting it is stricter and keeps the reply envelope
consistent.

## snappy encoder

The snappy **encoder** emits literal-only streams. That is legal snappy (every
driver and `mongod` accepts it) but it produces a compression ratio of 1.0, so
it buys wire compatibility without any size benefit. The **decoder** fully
supports copy tags (1/2/4 byte offsets), which is what real servers and drivers
emit; the fixture captured from `mongod 8.0.9` exercises them.

Real compression (libsnappy-style matching) is a separate scheduling item and
must not be mixed into a compatibility change.

## SCRAM authentication

The measured surface matches `mongod 8.0.9`: `hello`'s `saslSupportedMechs`
(both mechanisms for a user holding both, field absent for an unknown user),
`speculativeAuthenticate`, the `Authentication failed.` reply (code 18),
`MechanismUnavailable` (334), `No SASL session state found` (17), the credential
layout in `<db>.system.users` (base64 `salt`/`storedKey`/`serverKey`,
`iterationCount` 15000 for SHA-256 and 10000 for SHA-1) and the MongoDB SHA-1
password digest `md5("<user>:mongo:<pwd>")`.

Deliberate limits:

- **No authorization.** A successful login admits every command. `mongod`
  applies role-based authorization and refuses commands the roles do not grant
  (code 13). Roles are stored and reported by `connectionStatus`, but they are
  not enforced; privilege checking is separate scheduling work.
- **No SASLprep.** SCRAM-SHA-256 hashes the password as UTF-8 without RFC 4013
  preparation. ASCII passwords behave identically; non-ASCII passwords can
  disagree with a real server.
- **No GS2 authzid.** A client-first message carrying `a=<authzid>` is rejected
  with `Authentication failed.`; `mongod` accepts it.
- **`createUser` role validation.** Role names are stored verbatim (a string
  role becomes `{role, db: <user db>}`), but unknown roles are accepted;
  `mongod` answers `RoleNotFound` (31). Custom roles do not exist here.
- **`saslStart` payload type.** A base64 string payload is decoded, and an
  invalid one answers `Failed decoding SASL payload: invalid base64` (10270).

## `dbStats`

`objects`, `dataSize` and `avgObjSize` are exact: a document counts its encoded
BSON length, which is what `mongod` sums, and `system.*` collections are
excluded.

`storageSize` is an estimate. Indexes are not stored as separate structures, so
`indexSize` is always 0 and `storageSize` sums document key and value bytes
instead of the `.yykv` page layout `mongod` reports. `fsUsedSize` and
`fsTotalSize` come from the volume that holds the data directory (the host
filesystem, not a database-private quota), and `freeStorage` is not reported.
`scale` follows `mongod`: zero or negative answers code 2, a fractional value
counts as 1, and a non-numeric value answers code 14.

## `usersInfo` / `show users`

`usersInfo: 1`, a user name, `{user, db}`, an array of either and
`{forAllDBs: true}` are answered from `<db>.system.users` with `mongod`'s
validation texts, field order, `roles` sorting and the fixed
`['SCRAM-SHA-1', 'SCRAM-SHA-256']` mechanism list.

**`showPrivileges` is partial.** The reply reports `inheritedRoles` as the
stored roles, `inheritedPrivileges` as an empty array and
`inheritedAuthenticationRestrictions` as an empty array. `mongod` expands
built-in roles into their privilege sets (and `root` into every privilege), so a
client that depends on the expanded privileges sees less than a real server.
Authorization is not enforced yet, so nothing consumes those privileges.

## Replica set

`hello`/`isMaster` and `replSetInitiate` / `replSetGetConfig` /
`replSetGetStatus` reproduce `mongod 8.0.9` for a **single-member** set,
including field order, the default configuration that `rs.initiate()` obtains
from an empty request, and the error codes 76, 93, 94 and 23 with their texts.

Limits a client can observe:

- **Only member 0 is real.** A configuration with several members is stored and
  `hello.hosts` lists them, but nothing contacts them; `replSetGetStatus` reports
  member 0 only. There is no election, no sync, no rollback and no failover.
- **No oplog.** `optime` advances with the writes this server accepts and has
  `t: -1` until the first one; there is no `local.oplog.rs` collection, so
  nothing can replay or tail it.
- **The configuration is in memory.** Real `mongod` persists it in
  `local.system.replset`; here a restart returns to `NotYetInitialized` (94) and
  needs `rs.initiate()` again.
- **`replSetReconfig`, `replSetStepDown` and `replSetFreeze` are not
  implemented** (CommandNotFound). `topologyVersion.counter` advances when the
  member state changes (initiation), not on heartbeats.
- **No cluster time.** Replies carry neither `$clusterTime` nor `operationTime`.
  Sessions, retryable writes and transactions are accepted, but the retry
  metadata a real server attaches to replies is absent.
- **Retryable writes are executed but not deduplicated.** A write stamped with
  `txnNumber` outside a transaction runs normally, as `mongod` does, but there is
  no `config.transactions` record, so a retried write with the same `txnNumber`
  runs a second time instead of being suppressed.
- **`hello` is not streamed.** An awaitable handshake (`topologyVersion` plus
  `maxAwaitTimeMS` and `exhaustAllowed`) gets one immediate reply instead of a
  held-open reply stream, so a client configured with
  `serverMonitoringMode: stream` sees the stream end. The driver's default
  monitoring mode and `mongosh` work against the set once it is initiated.
- **`electionCandidateMetrics` is absent** from `replSetGetStatus`, and
  `electionTime` is the initiation timestamp rather than an election write.

## `dropDatabase`

The command replies `{ ok: 1 }` only, which is what `mongod 8.0.9` sends; the
`dropped` field that `mongosh`'s `db.dropDatabase()` helper prints is added by
the shell, not by the server. `admin` is refused with `IllegalOperation` (20),
`0`/`2` with `Location5255100`, a non-numeric argument with `TypeMismatch` (14),
and a missing/null argument with `IDLFailedToParse` (40414).

The whole database is removed together: every collection's documents, its user
indexes, collection options and the stored `system.users`. Cursors are killed
for every open connection, so a later `getMore` answers `QueryPlanKilled` (175)
naming the collection UUID and then `CursorNotFound` (43); `killCursors` before
that still reports the cursor as killed.

Two limits remain:

- **The collection UUID in the `QueryPlanKilled` text is derived from the
  namespace**, because this server has no per-collection UUID stored. Real
  `mongod` reports a random UUID, so the text never matches byte for byte; the
  code (175) and message shape do.
- **The drop is two atomic writes, not one.** The catalog is replaced first and
  the shard records and their `!catalog` mirror are deleted second. A crash
  exactly between them makes the next `open` merge the mirror back, so the
  database reappears. `mongod` commits the drop in a single transaction.

## Authentication deviations: re-evaluation

After the replica-set block the four open authentication deviations were
reviewed again. Replica-set mode neither widens nor narrows any of them, but it
raises the exposure of the first one: production drivers connect with
`directConnection=false`, so any authenticated client that reaches the set can
read and write every database.

| Deviation | Risk | Plan |
|---|---|---|
| Only authentication, no authorization | **High.** Every authenticated user runs every command; `mongod` answers `not authorized on <db> to execute command` (13) for a role that lacks the action. | Close it in the **first block after `dropDatabase`**, before any external demonstration. Build the built-in role → action table (`read`, `readWrite`, `dbAdmin`, `userAdmin`, `clusterAdmin`, `root`), enforce it in the TypeScript dispatch against the roles already stored in `<db>.system.users`, and expand `showPrivileges` from the same table. Gate: a `readWrite` user is refused `listDatabases` (13) and still reads its own collection. |
| No SASLprep | Medium, non-ASCII passwords only; ASCII passwords are byte-identical to `mongod`. | Same block: RFC 4013 normalisation in `createUser` and in credential verification, proven with a non-ASCII password fixture. |
| No GS2 authzid | Low. No mainstream driver sends `a=`; clients that do get `Authentication failed.` instead of a successful login. | Same block: accept and validate `a=` in the client-first message instead of rejecting it. |
| `createUser` accepts unknown roles | Medium, and it disappears with the role table. | Same block: answer `RoleNotFound` (31) for a role that is neither built-in nor a stored user-defined role. |

Until that block lands, `--auth` protects identities but not data and must not be
described as an authorization boundary.
