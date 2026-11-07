# Authorization matrix

Every command this server answers passes through one authorization layer
(`src/authorization.ts`) before the dispatcher in `src/server.ts` runs it. The
N-API, PyO3 and WASM crates export storage primitives only and contain no
authorization code; the TypeScript server is the single implementation used by
the TypeScript, Python and browser paths. There is no second copy to drift.

Expected values in this document come from a real `mongod 8.0.9` started with
`--auth` on an otherwise empty data directory. Every "real" column is an
observed reply code from that instance, not a reading of our own output. The
reproducible side of the matrix lives in `tests/server.mjs` and runs against
this server with real authenticated connections.

Codes used below:

| Code | Meaning |
|------|---------|
| 0 / 1 | command executed |
| 13 | `Unauthorized`, the caller lacks a required action |
| 20 | `IllegalOperation`, the command is refused after authorization |
| 48 | `NamespaceExists` |
| 59 | `CommandNotFound` |
| 17385 | `Location17385`, `$out` to a special collection |
| 31319 | `Location31319`, `$merge` into a special collection |

`root@admin` answers every privilege question. `mongod 8.0.9` lets it reach the
command even for actions its reported privilege list does not enumerate (for
example `updateRole`, which answers 31 rather than 13), and this server copies
that rule.

## 1. Reads and writes inside a database

| Command | Required action | Resource | This server | Real 8.0.9 |
|---------|-----------------|----------|-------------|------------|
| `find`, `count`, `distinct`, `getMore` | `find` | `db.collection` | built-in `read` passes, `dbAdmin`/`userAdmin` answer 13 | same |
| `insert`, `update`, `delete`, `findAndModify`, `bulkWrite` | `insert` / `update` / `remove` per namespace | `db.collection` | `read` answers 13, `readWrite` passes | same |
| `create` | `createCollection` | `db.collection` | `readWrite`/`dbAdmin` pass | same |
| `drop` | `dropCollection` | `db.collection` | `readWrite`/`dbAdmin` pass | same |
| `explain` | the actions of the explained command | `db.collection` | same as the inner command | same |
| `usersInfo` | `viewUser` | `db` (or `forAllDBs`) | `userAdmin`/`root` pass | same |

## 2. Aggregation that reaches another collection

| Command | Required action | Resource | This server | Real 8.0.9 |
|---------|-----------------|----------|-------------|------------|
| `aggregate` source | `find` | command database + source collection | enforced | same |
| `$lookup` / `$graphLookup` / `$unionWith` with a string `from` | `find` | command database + the named collection | enforced (see reachability note) | a collection-scoped `find` role cannot read a collection it was not granted |
| `$out` | `insert` + `remove` | target namespace | `readWrite`/`root` pass | insert-only grant answers 13 |
| `$merge` | `insert` + `update` | target namespace | `readWrite`/`root` pass | insert-only grant answers 13 |
| `$lookup` / `$graphLookup` with an object `from` | rejected by the pipeline validator | — | 9 / 40105 after authorization | same shape |
| `$unionWith` with `{ db, coll }` | rejected by the pipeline validator | — | 40415 after authorization | same shape |

Cross-database reads through `$lookup` / `$graphLookup` are **unreachable** on
`mongod 8.0.9`. The dotted `from` string is resolved as a literal collection
name inside the command database: `from: "otherdb.foreign"` ran as `read@authzm`
and returned an empty join, and `listCollections` showed the literal collection
name `otherdb.foreign` in `authzm`. The object form `{ db, coll }` is refused by
the validator. The same applies to `$unionWith`. The `find` requirement above
is still enforced for same-database reads; it cannot be exercised against this
server because custom roles are not implemented (see section 7).

## 3. Indexes and collection DDL

| Command | Required action | Resource | This server | Real 8.0.9 |
|---------|-----------------|----------|-------------|------------|
| `createIndexes` | `createIndex` | `db.collection` | `readWrite`/`dbAdmin` pass, `read` answers 13 | same |
| `dropIndexes` | `dropIndex` | `db.collection` | `readWrite`/`dbAdmin` pass, `read` answers 13 | same |
| `collMod` | `collMod` | `db.collection` | `dbAdmin`/`root` pass, `readWrite` answers 13 | same |
| `listCollections` | `listCollections` | `db` | `read` can list its own database, another database answers 13 | same |
| `create` view over a collection | `createCollection` + `find` on the viewed collection | both namespaces | `root` only | same |
| `renameCollection`, same database | `renameCollectionSameDB` on source + `dropCollection` on target | source and target namespaces | `readWrite`/`dbAdmin` pass authorization then answer 59 (not implemented); `read`/`userAdmin`/`clusterAdmin` answer 13 | `readWrite`/`dbAdmin` execute, `read` answers 13 |
| `renameCollection`, across databases | same pair (approximation, see note) | source and target namespaces | every non-root role answers 13, `root` answers 59 | `readWrite`, `dbAdmin`, `clusterAdmin`, and roles holding only `renameCollection` both sides answer 13; `anyAction` on both databases and `root` execute |

The exact action for a cross-database rename is not documented. `mongod 8.0.9`
grants it to `anyAction` on both databases but refuses `renameCollection` on
both databases, so the matrix models it as the same-database pair; the
authorization verdicts for all built-in roles match the observed ones.

## 4. Cluster and global information

| Command | Required action | Resource | This server | Real 8.0.9 |
|---------|-----------------|----------|-------------|------------|
| `listDatabases` | `listDatabases` | cluster | filtered to authorized databases | same |
| `listDatabases` with `authorizedDatabases: false` | `listDatabases` on every database | cluster | `root` only, everyone else 13 | same |
| `serverStatus` | `serverStatus` | cluster | `clusterAdmin`/`root` pass | same |
| `currentOp` | `inprog` | cluster | `clusterAdmin`/`root` pass | same |
| `invalidateUserCache` | `invalidateUserCache` | cluster | `clusterAdmin`/`root` pass authorization then answer 59 (not implemented) | `clusterAdmin` executes |
| `dbHash` | `dbHash` | `db` | `read`/`readWrite`/`root` pass authorization then answer 59 (not implemented); `dbAdmin`/`userAdmin`/`clusterAdmin` answer 13 | `read`/`readWrite`/`root` execute; `dbAdmin` also answers 13 |
| `validate` | `validate` | `db.collection` | `dbAdmin`/`root` pass authorization then 59; `read`/`readWrite`/`userAdmin`/`clusterAdmin` answer 13 | `dbAdmin`/`root` execute, the rest answer 13 |
| `buildInfo`, `connectionStatus`, `logout`, unknown command | none | — | allowed, unknown answers 59 | unknown answers 59 for every caller |

## 5. User and role writes

The server implements `createUser`, `dropUser` and `usersInfo`. The remaining
commands below are **unreachable** in this implementation: there is no custom
role store, so after authorization passes the dispatcher answers 59. They are
still listed because the authorization layer must not let a caller through
without the action a real server requires.

| Command | Required action | Resource | This server | Real 8.0.9 |
|---------|-----------------|----------|-------------|------------|
| `createUser` | `createUser` on the user's database + `grantRole` on every granted role's database | both databases | `userAdmin`/`root` pass within their database; an out-of-database role answers 13 | same |
| `updateUser` | `changePassword` / `changeCustomData` / `setAuthenticationRestriction`, plus `revokeRole` and `grantRole` for a role replacement | user database, role databases | `userAdmin` passes then 59; delegation outside its database answers 13 | `userAdmin` executes |
| `dropUser` | `dropUser` | user database | `userAdmin`/`root` pass | same |
| `grantRolesToUser`, `revokeRolesFromUser` | `grantRole` / `revokeRole` on the user database and on every role's database | both databases | `userAdmin` passes within its database then 59; a role from another database answers 13 | `userAdmin` executes |
| `createRole` | `createRole` + `grantRole` on every granted role/privilege resource | role database and each resource | `userAdmin` passes within its database then 59; a privilege from another database answers 13 | `userAdmin` executes |
| `updateRole` | `updateRole` (not held by any non-root built-in role) | role database | everyone except `root` answers 13; `root` answers 59 | `userAdmin` answers 13 even inside its database; `root` reaches the role lookup |
| `dropRole` | `dropRole` | role database | `userAdmin`/`root` pass then 59 | `userAdmin` executes |
| `grantPrivilegesToRole` | `grantRole` on the role database and on every privilege resource | role database and each resource | `userAdmin` passes within its database then 59 | `userAdmin` executes |
| `grantRolesToRole`, `revokeRolesFromRole` | `grantRole` / `revokeRole` on the role database and on every role's database | both databases | `userAdmin` passes within its database then 59 | `userAdmin` executes |

`invalidateUserCache` is covered in section 4.

## 6. Credential collections

A database-wide grant does **not** reach `system.users`, `system.backup_users`
or `system.roles`. The resource must name the collection. This reproduces the
real server: `read@authzm` and `userAdmin@authzm` are refused a direct `find`
even though one names the whole database and the other can manage the accounts
through `usersInfo`.

| Command | Required action | Resource | This server | Real 8.0.9 |
|---------|-----------------|----------|-------------|------------|
| `find`, `count`, `distinct`, `getMore` on `system.users` | `find` | exact namespace | only `root` (via `.system.users`) | `read`, `userAdmin` answer 13; an explicit namespace grant executes |
| `find` on `system.roles` in another database | `find` | exact namespace | `root` answers 13, an explicit namespace grant would pass | `root` answers 13 too, because `root` only holds `admin.system.roles` |
| `find` on `admin.system.roles` | `find` | exact namespace | `root` passes | `root` passes |
| `usersInfo` | `viewUser` | database | `userAdmin`/`root` pass | same |
| `insert`, `update`, `delete`, `bulkWrite`, `collMod` | `insert` / `update` / `remove` / `collMod` | exact namespace | only `root` | only `root`; `dbAdmin` answers 13 |
| `create` | `createCollection` | exact namespace | only `root`; existing namespace answers 48 | `dbAdmin` answers 13, `root` reaches 48 when it already exists |
| `drop` | `dropCollection` | exact namespace | only `root`, and the authorized caller gets 20 `IllegalOperation` | `root` gets 20, `dbAdmin` gets 13 |
| `$out` to a credential collection | `insert` + `remove` | exact namespace | only `root`, and the authorized caller gets 17385 | `root` gets 17385 |
| `$merge` into a credential collection | `insert` + `update` | exact namespace | only `root`, and the authorized caller gets 31319 | `root` gets 31319 |

## 7. Unreachable entries and capability gaps

- `cloneCollection` was removed from `mongod`. The real 8.0.9 instance answers
  59 to `read`, `clusterAdmin` and `root`; this server answers 59 to every
  role. It is not a missing feature.
- Custom roles are not implemented. Every collection-scoped scenario above
  (`$lookup` past a grant, exact-namespace credential access) is enforced by
  the matrix but cannot be exercised through this server because a user can
  only hold built-in, database-wide roles.
- `dbHash`, `renameCollection`, `validate`, `invalidateUserCache`,
  `updateUser`, `createRole`, `updateRole`, `dropRole`, `grantRolesToUser`,
  `revokeRolesFromUser`, `grantRolesToRole`, `revokeRolesFromRole`,
  `grantPrivilegesToRole` have authorization entries but no handler; an
  authorized caller sees 59 where the real server executes.
- Commands that have no authorization entry fall through to the dispatcher.
  An unknown command answers 59 for every caller, which matches the real
  server. A real command that is neither implemented nor listed here would
  also answer 59 instead of 13 for an underprivileged caller; no such command
  is used by the supported driver surface.

## 8. Evidence

Real instance: `mongod 8.0.9`, `--auth`, empty data directory, loopback only,
one `root@admin` bootstrap user. Fixtures: `authzm` with `items`, `secret`,
`rename_a`; `otherdb` with `foreign`; users holding `read`, `readWrite`,
`dbAdmin`, `userAdmin`, `clusterAdmin`, `root`, plus custom roles whose
resources are single collections.

Observed, in the order used by the tables:

- `find` on `secret` with a role holding `find` only on `items`: 13.
- `$lookup` / `$graphLookup` from `secret` with that role: 13; with `find` on
  both collections: executes.
- `$lookup` / `$graphLookup` / `$unionWith` with a dotted `from`: executes and
  returns an empty join; the dotted name is a literal collection of the command
  database.
- `$out` with `insert` only: 13; with `insert` + `remove`: executes.
- `$merge` with `insert` only: 13; with `insert` + `update`: executes.
- `createIndexes` / `dropIndexes` as `read`: 13, as `readWrite`: executes.
- `collMod` as `readWrite`: 13, as `dbAdmin`: executes.
- `renameCollection` same database: `readWrite` executes, a role holding only
  `renameCollectionSameDB` answers 13, a role holding
  `renameCollectionSameDB` + `dropCollection` executes.
- `renameCollection` across databases: `readWrite`, `dbAdmin`,
  `clusterAdmin`, `renameCollection` on both databases answer 13; `anyAction`
  on both databases and `root` execute.
- `cloneCollection` as `read`, `clusterAdmin`, `root`: 59.
- `dbHash`: `read`, `readWrite`, `root` execute; `dbAdmin`, `userAdmin`,
  `clusterAdmin` answer 13.
- `serverStatus` / `currentOp`: `read` answers 13, `clusterAdmin` executes.
- `listDatabases` with `authorizedDatabases: false` as `read`: 13,
  `clusterAdmin` executes.
- `updateUser`, `grantRolesToUser`, `revokeRolesFromUser`, `dropUser`,
  `createRole`, `grantPrivilegesToRole`, `grantRolesToRole`,
  `revokeRolesFromRole`, `dropRole` as `userAdmin` in its database: execute;
  as `read`: 13; as `userAdmin@admin` creating a role in another database: 13;
  granting a role from another database: 13.
- `updateRole` as `userAdmin` in its database: 13; as `root`: reaches the role
  lookup (31 for an absent role).
- `invalidateUserCache`: `userAdmin` 13, `clusterAdmin` executes.
- Direct `find` on `authzm.system.users`: `read` 13, `userAdmin` 13, an
  explicit `find` grant on the namespace executes, `root` executes. The same
  namespace grant on `authzm.system.roles` executes while `root` answers 13;
  `root` executes on `admin.system.roles`.
- Direct `insert` / `bulkWrite` insert / `collMod` on a credential collection:
  `root` executes, `read` and `userAdmin` answer 13; `create` as `dbAdmin` 13,
  as `root` 48 when the namespace exists; `drop` as `dbAdmin` 13, as `root` 20.
- `$out` to `system.users` as `root`: 17385; `$merge` into it: 31319.
- `validate`: `read` 13, `dbAdmin` executes, `clusterAdmin` 13.
- Unknown command: 59 as `read` and as `root`.

The long-form probe that produced these replies lives outside the package test
suite because it needs a separately seeded `--auth` instance. `tests/server.mjs`
encodes the same verdict per built-in role and runs them over real connections
to this server.
