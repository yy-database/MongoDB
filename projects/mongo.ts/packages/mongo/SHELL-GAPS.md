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
| `show users` (`usersInfo`) | `users[]` from `<db>.system.users` | `no such command: 'usersInfo'` | easy (catalog query) |
| `db.currentOp()` | `inprog[]` (legacy `currentOp`, `$currentOp` aggregate) | OK, empty `inprog` | done |
| `db.killOp(0)` | `{info:"attempting to kill op", ok:1}` | OK ack, no in-flight ops to kill | done |
| `db.getMongo().isWritablePrimary()` | `TypeError: not a function` | same error | not a gap |
| `db.stats()` (`dbStats`) | db, collections, views, objects, avgObjSize, dataSize, storageSize, indexes, indexSize, totalSize, fsUsedSize, fsTotalSize | `no such command: 'dbStats'` | medium |
| `db.dropDatabase()` | `{ok:1, dropped:"<db>"}` | `no such command: 'dropDatabase'` | hard |
| `db.<c>.drop()` | `{ok:1, ns}` | `no such command: 'drop'` | hard |
| `db.adminCommand({serverStatus:1})` counters (`opcounters`, `mem`, `asserts`) | present | absent | medium |
| `rs.status()` (`replSetGetStatus`) | member array, `stateStr: PRIMARY`, `optime` | `no such command: 'replSetGetStatus'` | pending replica-set work |
