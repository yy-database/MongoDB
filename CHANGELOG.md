# Changelog

版本号与 `package.json`、`pyproject.toml`、Cargo workspace 保持一致。本仓当前不发布：所有包 `private: true`，未配置 Trusted Publisher。

## 0.0.1

尚未发布。

### 新增

- MongoDB 线协议服务端：`OP_MSG` 为主，兼容驱动首个 `OP_QUERY` handshake 探测；`hello` / `isMaster` 报告 `isWritablePrimary: true`、`minWireVersion: 0`、`maxWireVersion: 17`。
- 存储后端：`.yyds` catalog + `.yykv` 分片（`yyds::kv::FileShard`），命名空间为 `<database>.<collection>`；catalog 缺失时按 `!catalog` 标签自愈重建，catalog 指向的 shard 缺失时由 `repair_shard` 显式补空 shard。
- 命令面：`ping`、`insert`、`find`、`count`、`aggregate`（部分阶段）、`delete`、`update`（部分修饰符）、`getMore`、`killCursors`、`listCollections`、`listDatabases`、`createIndexes`、`listIndexes`、`dropIndexes`；白名单外的命令回 `59` 而不是返回编造结果。
- 查询算子：顶层 `$and` / `$or` / `$nor`，字段级 `$eq` / `$ne` / `$gt` / `$gte` / `$lt` / `$lte` / `$in` / `$nin` / `$exists` / `$regex` / `$options` / `$size` / `$type` / `$elemMatch` / `$all` / `$not`；空数组形态按手册无据一律拒绝。
- 聚合阶段：`$match`、`$sort`、`$limit`、`$skip`、`$count`、`$unwind`、`$lookup`（equality form）、`$sortByCount`、`$group`、`$project`。
- 索引：单字段与复合键、`unique`、显式 `name`、多键展开与 parallel arrays 拒绝；元数据随 catalog 落盘并在重开后保留。
- 绑定：`mongo-napi` 与 `mongo-pyo3` 对称导出原语，TypeScript 与 Python 只做组合与验收；命令行入口 `yydb-mongo` / `yydb-mongod` 在 npm 包里以 `bin/*.mjs` 分发。
- 验收：同一批 case 同时驱动 TypeScript 与 Python 绑定并逐 case 比对；驱动兼容矩阵按 `mongodb@6.22.0`、`pymongo@4.19.0` 实测，CI 按安装口径装驱动直连本仓服务端。

### 兼容口径

- 服务端数据库只需单向读取真库数据形态：`mongodump` 产出的 `.bson` 文档流可导入，不回写 WiredTiger；运行时数据落在 `.yykv`。
- `mongosh` 只做手工冒烟，不入 CI、不固定版本。

### 已知限制

- 聚合只覆盖上列阶段，其余阶段回 `59` 并列出支持清单。
- `update` 只支持 `$set` / `$unset` / `$inc`，`upsert` 与替换式更新回 `59`。
- wasm 平台包只有占位绑定，不列入 npm 主包 `optionalDependencies`。

### 许可

MPL-2.0，见 `License.md`；npm 主包、五个平台包与 Python 包各自携带同一份副本，wheel 记录 `License-Expression: MPL-2.0` 与 `License-File: License.md`。
