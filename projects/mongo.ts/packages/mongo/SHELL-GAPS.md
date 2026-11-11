# `mongosh` shell gaps

Output of [smoke-shell.js](./tests/smoke-shell.js), run with `mongosh 2.14.1`
against this server and against `mongod 8.0.9` (port 28018). The script prints
one `SMOKE|<name>|OK|...` or `SMOKE|<name>|ERR|...` line per operation, so a
missing command or a wrong shape shows up immediately.

Tiers describe what it would take to close a gap, not how important it is.

- **done** — answered by this server, shape checked against `mongod`.
- **easy** — a static or informational reply in the TypeScript listener.
- **medium** — needs a Rust facade primitive (counts, sizes, index stats).
- **hard** — needs storage/catalog changes (removing a collection or database).

| Operation | `mongod 8.0.9` shape | This server | Tier |
|---|---|---|---|
| `show dbs` (`listDatabases`) | `databases[]`, `totalSize` | OK | done |
| `use <db>` | shell-local | OK | done |
| `db.createCollection` | `{ok:1}` | OK | done |
| `db.<c>.insertMany` / `find` / `explain()` | normal write/read/explain | OK | done |
| `db.getCollectionNames()` | `listCollections` nameOnly | OK | done |
| `db.getCollectionInfos()` | name, type, options, info.uuid, idIndex | OK, same fields | done |
| `db.runCommand({ping:1})` | `{ok:1}` | OK | done |
| `db.serverStatus()` | host, version, process, pid, uptime*, localTime, asserts, connections, network, opcounters, opcountersRepl, mem, ... | OK; same sections in `mongod`'s relative order, counters measured per command class (`mem` answers `supported: false`, `asserts` zeros, `opcountersRepl` zeros) | done |
| `db.hostInfo()` | `system` + `os` + `extra` | OK subset: `system`, `os`, `extra` | done (subset) |
| `db.runCommand({connectionStatus:1})` | `authInfo.authenticatedUsers[]` | OK; empty before login, populated by SCRAM | done |
| `db.createUser` / `dropUser` / `logout` | `{ok:1}` | OK, SCRAM-SHA-256 and SCRAM-SHA-1 | done |
| `db.createRole` / `db.dropRole` | `{ok:1}`, `system.roles` documents | OK; stored in `<db>.system.roles` with `mongod`'s validation codes and texts, inheritance resolves in enforcement and `showPrivileges`; `updateRole` / `grantPrivilegesToRole` / `rolesInfo` still 59 | done (subset) |
| `show users` (`usersInfo`) | `users[]` from `<db>.system.users` with `_id`, `userId`, `user`, `db`, `roles`, `mechanisms` | OK; same fields and order, `showCredentials`, `showPrivileges` (see below) | done |
| `db.currentOp()` | `inprog[]` (legacy `currentOp`, `$currentOp` aggregate) | OK, empty `inprog` | done |
| `db.killOp(0)` | `{info:"attempting to kill op", ok:1}` | OK ack, no in-flight ops to kill | done |
| `db.getMongo().isWritablePrimary()` | `TypeError: not a function` | same error | not a gap |
| `db.stats()` (`dbStats`) | db, collections, views, objects, avgObjSize, dataSize, storageSize, indexes, indexSize, totalSize, fsUsedSize, fsTotalSize | OK; `objects`/`dataSize`/`avgObjSize` exact, `storageSize` is shard record bytes, `indexSize` sums the real index key material (see KNOWN-DIFFERENCES) | done |
| `db.<c>.stats()` (`collStats`) | ns, size, count, avgObjSize, storageSize, freeStorageSize, capped, nindexes, totalIndexSize, indexSizes, totalSize, scaleFactor | OK; same numbers as `dbStats`, per-index `indexSizes` included; engine fields omitted | done |
| `db.dropDatabase()` | `{ok:1, dropped:"<db>"}` | OK; server replies `{ok:1}` and the shell adds `dropped`; collections, indexes, users and cursors go with it | done |
| `db.<c>.drop()` | `{ok:1, ns}` | OK; `{nIndexesWas, ns, ok}`, missing collection `{ok:1}`, `system.*` and the live oplog guarded | done |
| `db.<c>.createIndex` (wildcard / hashed / multikey, `unique`+`sparse`) | `indexes[]` in `listIndexes` | OK; same catalog shape, same error codes (see KNOWN-DIFFERENCES) | done |
| `db.<c>.createIndex({body:'text'})` + `$text` | `_fts`/`_ftsx` entry, `weights`, `$meta:"textScore"` | `text indexes are not supported yet` (59) | hard; feasibility in KNOWN-DIFFERENCES |
| `db.adminCommand({serverStatus:1})` counters (`opcounters`, `mem`, `asserts`) | present | OK; counters tracked in the dispatch layer (`mem.supported: false`, zero `asserts`, zero `opcountersRepl` like the measured single-member set) | done |
| `rs.status()` (`replSetGetStatus`) | member array, `stateStr: PRIMARY`, `optime`, `syncSourceHost: ""` | OK; single member, PRIMARY, `optime` from real writes (see KNOWN-DIFFERENCES) | done |
| `rs.conf()` (`replSetGetConfig`) | `config` with set name, members, settings | OK, same fields for the single member | done |
| `rs.initiate()` (`replSetInitiate`) | `info2` "no configuration specified...", `me` | OK; the empty/numeric request builds the single-member config from the connection address | done |

## `dbStats` / `collStats` numbers

`objects`, `dataSize` and `avgObjSize` are exact: both commands walk every
stored document and sum its encoded BSON length, which is the same quantity
`mongod 8.0.9` reports (`{_id: 1, v: 'a'}` contributes 23 bytes in both).
`collStats` truncates `avgObjSize` to an integer, exactly as `mongod` does;
`dbStats` keeps the fraction.

`storageSize` is the byte count of the records this database owns in the
`.yykv` shard, keys included, so for two 23-byte documents it is 64 rather than
`mongod`'s 4096-byte allocation unit.

`indexSize` and `indexSizes` count the index key material every stored
document really contributes: the `listIndexes` definition plus the
length-prefixed key tuple and an 8-byte record id per entry. `_id_` is always
included first, TTL, compound, unique and multikey indexes follow through the
same `index_entries` expansion the write path uses, and `dbStats.indexSize` is
exactly the sum of the per-collection `totalIndexSize` values. An empty
collection reports only its definition bytes instead of zero.

`mongod` reports WiredTiger page allocation instead (4096-byte minimum per
index), so tiny indexes differ by one to two orders of magnitude even though
large collections land within a few tens of percent. The measured comparison
and the reason the number is not interchangeable with `mongod` are in
[KNOWN-DIFFERENCES.md](./KNOWN-DIFFERENCES.md).

`fsUsedSize`/`fsTotalSize` are measured from the volume that holds `dataDir`
and are 0 for a database that does not exist, which is what `mongod` reports
too.

## `usersInfo`

`1` (numeric, or any number truncating to 1), a user name, `{user, db}`, an
array of either, and `{forAllDBs: true}` are accepted with `mongod`'s
validation texts. `showCredentials` returns the stored credential document and
`showPrivileges` expands built-in and custom roles through the same path the
dispatch layer enforces, so `inheritedPrivileges` matches `mongod` for all
seventeen built-ins and for custom-role chains (fixtures:
`tests/oracle-showprivileges.json`).

## Authorization

With `--auth`, commands are checked against the roles stored in
`<db>.system.users`: the seventeen built-ins (`read`, `readWrite`, `dbAdmin`,
`userAdmin` and `dbOwner` on any database; `clusterAdmin`, `root`,
`readAnyDatabase`, `readWriteAnyDatabase`, `userAdminAnyDatabase`,
`dbAdminAnyDatabase`, `clusterMonitor`, `clusterManager`, `hostManager`,
`backup`, `restore` and `__system` on `admin`) plus custom roles stored in
`<db>.system.roles` with inheritance. A refused command answers
`not authorized on <db> to execute command` (13); `listDatabases` returns the
databases the user's privileges cover. Limits (role administration commands
beyond `createRole`/`dropRole`, unenforced authentication restrictions) are in
[KNOWN-DIFFERENCES.md](./KNOWN-DIFFERENCES.md).

## Replica set

Start the listener with `--repl-set <name>`, then `rs.initiate()` (no argument)
in `mongosh`; `rs.status()` and `rs.conf()` answer from the stored single-member
configuration. On a node started without `--repl-set` the three commands answer
`NoReplicationEnabled` (76), as `mongod` does. The configuration is persisted in
`local.system.replset` and restored at startup, so `rs.initiate()` is only
needed once and a restart keeps reporting PRIMARY; the other limit is that only
member 0 exists. Both are recorded in [KNOWN-DIFFERENCES.md](./KNOWN-DIFFERENCES.md).
