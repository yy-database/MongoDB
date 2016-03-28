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

Implemented and verified against `mongod 8.0.9`:

- **SASLprep (RFC 4013).** Passwords are mapped (B.1 to nothing, C.1.2 to
  space), NFKC-normalised and checked against the prohibition tables; a
  prohibited code point answers `U_STRINGPREP_PROHIBITED_ERROR` (50692) and a
  bidirectional violation answers `U_STRINGPREP_CHECK_BIDI_ERROR` (50692), with
  `mongod`'s wording. Driver logins for `ä`, `Ⅳ`, NBSP, soft hyphen and a
  Hebrew-only password all match a real `--auth` server.
- **GS2 authzid.** `n,,`, `y,,`, `n,a=<user>,` and an empty `n,a=,` are accepted;
  an authzid naming a different or unknown user answers `Authentication failed.`
  (18) at `saslStart`, exactly as `mongod` does.
- **`c=` is not verified.** `mongod` accepts a proof built over any channel
  binding value (measured by sending `c=Zm9v`), so this server does too; the
  nonce and proof are still checked.
- **`createUser` role validation.** Role elements are validated in `mongod`'s
  order and wording (`RoleName must contain a field named: role` / `: db`,
  `... But, has type int`, `Role name must be either a document or string`),
  and a role that is not one of the built-ins answers `RoleNotFound` (31) with
  `Could not find role: <role>@<db>`.

Remaining limits:

- **Only six built-in roles exist** (`read`, `readWrite`, `dbAdmin`, `userAdmin`,
  `clusterAdmin`, `root`), with `clusterAdmin` and `root` resolved on `admin`
  only. `mongod`'s other built-ins (`dbOwner`, `readAnyDatabase`,
  `readWriteAnyDatabase`, `userAdminAnyDatabase`, `dbAdminAnyDatabase`,
  `clusterMonitor`, `clusterManager`, `hostManager`, `backup`, `restore`,
  `__system`) and user-defined roles answer `RoleNotFound` (31) instead of
  resolving, and `createRole`/`dropRole` are not implemented.
- **SASLprep uses the host's Unicode tables** (Node's `NFKC`), while `mongod`
  uses ICU. Mapping and prohibition coverage is complete for the code points the
  fixtures exercise; an exotic code point whose Unicode version differs could
  prepare differently.
- **`saslStart` payload type.** A base64 string payload is decoded, and an
  invalid one answers `Failed decoding SASL payload: invalid base64` (10270).

## Authorization

`--auth` is now an authorization boundary, not just an identity check. Built-in
roles stored in `<db>.system.users` are expanded into privileges by one table in
`src/authorization.ts`, and the same expansion feeds `showPrivileges`, so the
enforced and reported sets cannot drift. The command-to-action mapping covers
`find`, `count`, `distinct`, `aggregate`, `explain`, `insert`, `update`,
`delete`, `findAndModify`, `bulkWrite`, `create`, `collMod`, `createIndexes`,
`dropIndexes`, `listIndexes`, `listCollections`, `dbStats`, `dropDatabase`,
`createUser`, `dropUser`, `usersInfo`, `getMore`, `killCursors`, `listDatabases`
and the cluster commands (`serverStatus`, `hostInfo`, `currentOp`, `killOp`,
`replSetGetStatus`, `replSetGetConfig`, `replSetConfigure`).

Measured against a real `--auth` instance:

- The six role privilege expansions are deep-equal to `showPrivileges`
  (`read` 2, `readWrite` 2, `dbAdmin` 2, `userAdmin` 1, `clusterAdmin` 14,
  `root` 26).
- A refused command answers `not authorized on <db> to execute command
  { <command>, ... }` (13), with `pwd` redacted to `"xxx"` and the `lsid` binary
  rendered as `UUID("...")`.
- `listDatabases` returns the databases covered by the user's privileges;
  `clusterAdmin`/`root` see every database. `authorizedDatabases: false` without
  the cluster `listDatabases` action answers
  `Insufficient permissions to list all databases` (13). A `readWrite` user
  therefore gets a filtered list, not code 13, which is what `mongod` actually
  does; `nameOnly` strips the size fields and `totalSize`.

Remaining limits:

- **Enforcement is command level.** Actions are granted per resource exactly like
  `mongod`'s privilege sets, but only the commands listed above consult them; a
  command outside that list is admitted for any authenticated user.
- **`system.*` collections inside a granted database** are treated like user
  collections by `find`/`listCollections`; `mongod` restricts `system.users` to
  its own commands.
- **No authentication restrictions and no custom roles**, so `createUser` does
  not accept `authenticationRestrictions`, and `roles` must name a built-in.

## `showPrivileges`

`inheritedRoles` repeats the stored roles. `inheritedPrivileges` is the built-in
role expansion from the same table the dispatch layer enforces, and
`inheritedAuthenticationRestrictions` is an empty array, which is what `mongod`
reports for the six built-ins.

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

## Replica set

`hello`/`isMaster` and `replSetInitiate` / `replSetGetConfig` /
`replSetGetStatus` reproduce `mongod 8.0.9` for a **single-member** set,
including field order, the default configuration that `rs.initiate()` obtains
from an empty request, and the error codes 76, 93, 94 and 23 with their texts.

Limits a client can observe:

- **Only the primary exists.** A configuration with several members is stored and
  `hello.hosts` lists them, but nothing contacts them; `replSetGetStatus` reports
  member 0 only. There is no election, no sync, no rollback and no failover. See
  the design principle below: this server does not fabricate a SECONDARY.
- **The oplog is written, not consumed.** Every successful write appends an entry
  to the persistent `local.oplog.rs` (see below), but no member replays it, so
  `syncSourceHost` is empty and initial sync does not exist.
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

### Design principle: no fake secondaries

This server never reports a member as `SECONDARY`, never advertises a
`readPreference` route to a member it does not actually serve from, and never
answers a secondary read from primary data. A `rs.status()` that looks complete
while a `readPreference: secondary` read silently returns data that is not
positioned on the oplog is worse than an honest failure: the client cannot tell
the difference from a real secondary that is lagging. Clients therefore see the
real topology (one writable member) and get `server selection` failures for
secondary reads instead of inconsistent data.

## `local.oplog.rs`

Measured against `mongod 8.0.9` on a single-member set:

| Write | Entry |
|---|---|
| one insert | `op: "i"`, `o: <document>`, `o2: {_id}` |
| several inserts | one `op: "c"` on `admin.$cmd` whose `o.applyOps` holds one `i` per document |
| update | `op: "u"`, `o: {$v: 2, diff: {u: {...}, d: {...}}}`, `o2: {_id}` |
| delete | `op: "d"`, `o: {_id}` (no `o2`) |
| `create` | `op: "c"` on `<db>.$cmd`, `o: {create, idIndex}` |
| `createIndexes` / `dropIndexes` | `op: "c"`, `o: {createIndexes, v: 2, key, name}` / `o2` carries the dropped spec |
| `collMod` / `drop` | `op: "c"`, `o2.collectionOptions_old` / `o2.numRecords` |
| `dropDatabase` | `op: "c"` on `<db>.$cmd`, no `ui`, `fromMigrate: false` |

Every entry carries `ts`, `t: 1`, `v: 2` and `wall` (a BSON date) after its
operation fields, and `ui` (the collection UUID) whenever an operation names a
collection. `mongod 8.0.9` no longer writes the historical `h` (hash) field,
and neither does this server. `mongod` also writes a `noop` entry every ten
seconds; this server writes entries only when a command actually changes
something, so an idle `local.oplog.rs` stays empty.

Limits a client can observe:

- **The entry is a second durable write, not part of the data write.** A crash
  between the two can leave a document whose oplog entry is missing. Real
  `mongod` commits both in one transaction.
- **The diff is computed, not planned.** `u` records the fields that changed
  between the stored document and the result; `mongod` records the diff its
  update executor planned. For the update operators this server supports the two
  agree; array-element inserts are recorded as a whole-array `u` rather than an
  `i`.
- **No missing-field lifecycle events.** `create`/`drop` entries carry the
  measured fields, but `startIndexBuild`/`abortIndexBuild`, `commitIndexBuild`,
  `emptycapped` and the `replset.minvalid` / `oplogTruncateAfterPoint`
  bookkeeping collections are not written.
- **Transactions write no `applyOps` at commit.** The transaction commit is
  acknowledged but its operations are not folded into a single oplog entry.

The entries live in the shard under the oplog namespace, so `find` on
`local.oplog.rs` returns them in timestamp order, `listCollections` reports it
as the capped collection `mongod` describes (`capped: true`, `autoIndexId: false`,
no `idIndex`), and the oldest entries are reclaimed once the capped budget is
exceeded (990 MB by default, `--oplog-size-mb`). Because the write reply's
`opTime` is the newest persisted timestamp, a client reading the oplog sees
exactly the timestamps the acknowledgements reported. The budget itself is a
difference: `mongod` reserves 5.3 GB on this host, while this server defaults to
990 MB.

## Write concern

`w`, `wtimeout` and `j` are parsed with `mongod`'s validation rules, and the
rejections a client can trigger are reproduced:

- A `writeConcern` that is not a document answers
  `14 TypeMismatch` (`"writeConcern" had the wrong type. Expected object, found int`).
- `w` must be a number, a string or a document; anything else answers
  `9 FailedToParse` (`w has to be a number, string, or object; found: bool`).
- A numeric `w` below 0 or above 50 answers `9 FailedToParse`
  (`w has to be a non-negative number and not greater than 50; found: X`).
- On a standalone server a numeric `w > 1` answers
  `2 BadValue` (`cannot use 'w' > 1 when a host is not replicated`), and a
  non-`majority` name answers `2 BadValue`
  (`cannot use non-majority 'w' mode "tag" when a host is not a member of a replica set`).
  These are refused before the write runs, as on `mongod`.
- On the single-member set a numeric `w > 1` is unsatisfiable. The write
  succeeds and the reply carries `writeConcernError` `100
  UnsatisfiableWriteConcern` (`Not enough data-bearing nodes`) with
  `errInfo.writeConcern`, immediately, even when a `wtimeout` is supplied (which
  is what the measured server does). An unknown name answers `writeConcernError`
  `79 UnknownReplWriteConcern`, also with the write already applied.
- `w: 0` runs the write but withholds the counters: `insert`/`update`/`delete`
  answer `n: 0` (`nModified: 0` where present) and no `writeErrors`.
- `j`, `wtimeout` values and their signs are accepted; `j: true` is always
  satisfied because every write is committed to the shard before the reply.

Every acknowledged write reply on the set carries `electionId` and `opTime`
after `n` (the timestamp of the last oplog entry, unchanged when the command
changed nothing), and `writeConcernError` sits immediately before `ok`. A
standalone reply keeps the standalone shape without those fields.

One limit: **`64 WriteConcernFailed` after `wtimeout` is not reachable.** That
reply needs a member that could in principle acknowledge but does not, which is
how a real degraded multi-member set times out. Here the only data-bearing
member is the process itself: when it is up a numeric `w > 1` is impossible
(`100`), and when it is down there is no server to answer. Waiting cannot
change either outcome, so this server never makes a client wait for one.

## `readPreference`

`$readPreference` is validated like `mongod` (an unknown `mode` answers
`2 BadValue` naming the value) and otherwise ignored, which is what a real
`mongod` does with the field: routing is the client's job. A driver that selects
the single-member set with `readPreference: secondary` fails server selection,
because the only member reports itself as primary; a `directConnection` to that
member reads normally, as with a real server.

## `drop`

`{drop: <name>}` answers `{nIndexesWas: <n>, ns: "<db>.<name>", ok: 1}` for an
existing collection and `{ok: 1}` for a missing one, leaving `listCollections`
empty. A non-string name answers `14 TypeMismatch`; a collection in `admin`,
`local` or `config` whose name starts with `system.` answers
`20 IllegalOperation` (`cannot drop system collection <ns>`), and
`local.oplog.rs` while replication is enabled answers `5255000`
(`can't drop live oplog while replicating`), both as measured on
`mongod 8.0.9`. A `system.*` name in any other database is droppable, which is
where `mongod` draws the same line. The reply carries the index count this
server actually has (the implicit `_id` index plus the stored user indexes).

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

## Aggregation stages

`$unionWith` (string form, `{coll, pipeline}`, `$documents` as the first
sub-pipeline stage), `$sample`, `$densify` (numeric and date ranges, `full` and
`partition` bounds, month/year calendar steps), `$fill` (`value`, `locf`,
`linear`), `$redact`, `$merge` and `$out` were measured against `mongod 8.0.9`
and the corpus gate compares them per field.

Two limits remain:

- **Natural order is `_id` order.** Unsorted scans here return documents in
  `_id` order; `mongod` returns insertion order. `$merge` applies its input as it
  goes and does not roll back. A run that fails half-way may therefore have
  written a different prefix of source documents than `mongod` would, and **the
  set of documents already written before a failure is not guaranteed to have a
  consistent order**: callers must not rely on which prefix survived, only on
  the fact that some prefix may have survived. Adding a `$sort` before `$merge`
  (or inserting documents in `_id` order) makes the two identical; the
  insertion-order difference itself is visible in any unsorted
  `find`/`$limit`/`$skip` as well.
- **`$merge` pipeline expressions are the shared expression subset.** A
  `whenMatched` pipeline may use only the operators the expression evaluator
  knows; `mongod` accepts the full aggregation expression set.

## Index types

Wildcard (`$**`, `path.$**`, `wildcardProjection` reported by `listIndexes`),
hashed (one hashed field per index, no `unique`) and compound multikey indexes,
including `unique` + `sparse` combinations, are stored, listed and enforced with
the same catalog shape and error codes (`31303`, `16764`, `67`, `11000`) as
`mongod 8.0.9`. Hashed validation errors carry the index-builder wrapper text
(`Index build failed: <uuid>: ... 1 index specs provided. First index spec: ...`).

**Text indexes are not implemented.** `createIndexes` with a `text` key answers
`59 text indexes are not supported yet` instead of storing the `_fts` / `_ftsx`
catalog entry, so `$text`, `$meta: "textScore"` and weights are unavailable.

### Text index feasibility (measured, not implemented)

What a real `mongod 8.0.9` does, captured from `createIndexes` / `listIndexes`:

| Aspect | Measured behaviour |
|---|---|
| Catalog key | `{ _fts: "text", _ftsx: 1 }` for every text index |
| `weights` | one entry per text field, default `1`; `weights: {title: 5}` is preserved |
| `default_language` | `"english"` |
| `language_override` | `"language"` |
| `textIndexVersion` | `3` |
| Compound form | `{a: 1, body: "text"}` keeps the prefix key and indexes only text fields |
| Field order | `weights`, `default_language`, `language_override`, `textIndexVersion` after `name` |
| Options | a text index cannot be `unique`; it is always sparse; one text index per collection |

What would have to be built before the stage is worth attempting:

1. **Catalog shape**: the two-part `_fts`/`_ftsx` entry plus weights/language
   fields, and `listIndexes` rendering (the corpus gate would then cover it).
2. **Tokenizer and stemmer per language**: `mongod` uses ICU-backed Snowball
   stemmers and stop-word lists for ~15 languages; mapping every language is a
   large, separate block. An English-only tokenizer would be a visible deviation
   as soon as `default_language` differs.
3. **Query parser**: `$text: {$search}` supports phrases (`"..."`), negation
   (`-term`), OR (`term1 term2` is OR by default in `$text`), case folding, and
   `$caseSensitive` / `$diacriticSensitive`; each needs its own oracle pass.
4. **Scoring**: `$meta: "textScore"` projection and `$sort: {score: {$meta: ...}}`
   need the TF-IDF-ish score `mongod` computes; matching the *ordering* is the
   hard part, not the number.
5. **Planner interaction**: `$text` requires an existing text index (error 27
   otherwise), cannot be combined with `$near`, and `hint` by name has to route
   to it.

Conclusion: the catalog part is small; the language/analyzer and scoring parts
are the bulk of the work and are where compatibility would be graded. This is
deliberately deferred rather than approximated, because an English-only
implementation would silently disagree with `mongod` for every other language.
