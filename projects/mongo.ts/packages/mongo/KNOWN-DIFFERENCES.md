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
