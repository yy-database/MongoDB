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
| `db.serverStatus()` | host, version, process, pid, uptime*, localTime, connections, opcounters, mem, asserts, network, ... | OK subset: host, version, process, pid, uptime*, localTime, connections | done (subset); counters are medium |
| `db.hostInfo()` | `system` + `os` + `extra` | OK subset: `system`, `os`, `extra` | done (subset) |
| `db.runCommand({connectionStatus:1})` | `authInfo.authenticatedUsers[]` | OK; empty before login, populated by SCRAM | done |
| `db.createUser` / `dropUser` / `logout` | `{ok:1}` | OK, SCRAM-SHA-256 and SCRAM-SHA-1 | done |
| `show users` (`usersInfo`) | `users[]` from `<db>.system.users` with `_id`, `userId`, `user`, `db`, `roles`, `mechanisms` | OK; same fields and order, `showCredentials`, `showPrivileges` (see below) | done |
| `db.currentOp()` | `inprog[]` (legacy `currentOp`, `$currentOp` aggregate) | OK, empty `inprog` | done |
| `db.killOp(0)` | `{info:"attempting to kill op", ok:1}` | OK ack, no in-flight ops to kill | done |
| `db.getMongo().isWritablePrimary()` | `TypeError: not a function` | same error | not a gap |
| `db.stats()` (`dbStats`) | db, collections, views, objects, avgObjSize, dataSize, storageSize, indexes, indexSize, totalSize, fsUsedSize, fsTotalSize | OK; `objects`/`dataSize`/`avgObjSize` exact, `storageSize` is shard record bytes and `indexSize` is 0 (see KNOWN-DIFFERENCES) | done |
| `db.dropDatabase()` | `{ok:1, dropped:"<db>"}` | OK; server replies `{ok:1}` and the shell adds `dropped`; collections, indexes, users and cursors go with it | done |
| `db.<c>.drop()` | `{ok:1, ns}` | `no such command: 'drop'` | hard |
| `db.adminCommand({serverStatus:1})` counters (`opcounters`, `mem`, `asserts`) | present | absent | medium |
| `rs.status()` (`replSetGetStatus`) | member array, `stateStr: PRIMARY`, `optime`, `syncSourceHost: ""` | OK; single member, PRIMARY, `optime` from real writes (see KNOWN-DIFFERENCES) | done |
| `rs.conf()` (`replSetGetConfig`) | `config` with set name, members, settings | OK, same fields for the single member | done |
| `rs.initiate()` (`replSetInitiate`) | `info2` "no configuration specified...", `me` | OK; the empty/numeric request builds the single-member config from the connection address | done |

## `dbStats` numbers

`objects`, `dataSize` and `avgObjSize` are exact: `dbStats` walks every stored
document and sums its encoded BSON length, which is the same quantity
`mongod 8.0.9` reports (`{_id: 1, v: 'a'}` contributes 23 bytes in both).
`storageSize` is the byte count of the records this database owns in the
`.yykv` shard, keys included, so for two 23-byte documents it is 64 rather than
`mongod`'s 4096-byte allocation unit. `indexSize` is 0 because indexes are
catalog specifications here and nothing materialises them; `mongod` allocates
at least one 4096-byte page per index. `fsUsedSize`/`fsTotalSize` are measured
from the volume that holds `dataDir` and are 0 for a database that does not
exist, which is what `mongod` reports too. The two estimates and the zero index
size are recorded in [KNOWN-DIFFERENCES.md](./KNOWN-DIFFERENCES.md).

## `usersInfo`

`1` (numeric, or any number truncating to 1), a user name, `{user, db}`, an
array of either, and `{forAllDBs: true}` are accepted with `mongod`'s
validation texts. `showCredentials` returns the stored credential document and
`showPrivileges` expands the built-in roles into the same privilege table the
dispatch layer enforces, so `inheritedPrivileges` matches `mongod` for the six
modelled roles.

## Authorization

With `--auth`, commands are checked against the roles stored in
`<db>.system.users`: `read`, `readWrite`, `dbAdmin`, `userAdmin` on any
database, and `clusterAdmin`, `root` on `admin`. A refused command answers
`not authorized on <db> to execute command` (13); `listDatabases` returns the
databases the user's privileges cover. Limits (other built-ins, custom roles,
command-level granularity) are in [KNOWN-DIFFERENCES.md](./KNOWN-DIFFERENCES.md).

## Replica set

Start the listener with `--repl-set <name>`, then `rs.initiate()` (no argument)
in `mongosh`; `rs.status()` and `rs.conf()` answer from the stored single-member
configuration. On a node started without `--repl-set` the three commands answer
`NoReplicationEnabled` (76), as `mongod` does. The configuration lives in memory
only, so a restart needs `rs.initiate()` again; the other limit is that only
member 0 exists. Both are recorded in [KNOWN-DIFFERENCES.md](./KNOWN-DIFFERENCES.md).
