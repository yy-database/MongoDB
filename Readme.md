# MongoDB

用 `.yyds` / `.yykv` 存储后端模拟 MongoDB 服务端能力：对外是 MongoDB 线协议（OP_MSG / OP_QUERY）与 `mongosh` 风格命令行，对内把文档写进 YYDS 分片存储。

**不是** 通用 MongoDB 客户端库，**不是** 完整 MongoDB 实现。已支持的命令面见下方能力矩阵，未列入的命令一律显式拒绝并带诊断码，不会返回编造的结果。

## 定位

| 项 | 口径 |
|----|------|
| 协议 | MongoDB wire protocol，`OP_MSG` 为主，兼容驱动的首个 `OP_QUERY` handshake 探测 |
| 存储 | YYDS `.yykv` 分片（`yyds::kv::FileShard`），命名空间 = `<database>.<collection>` |
| 驱动 | 真实驱动验收：TypeScript `mongodb`、Python `pymongo` |
| 命令行 | `mongod`（起服务）与 `mongosh` 风格 `mongo`（交互 / `--eval`） |
| 发布 | 当前阶段**不发布**：所有包 `private: true`，未配置 Trusted Publisher |

## 存储兼容口径

只有嵌入式库才要求存储格式双工兼容；服务端数据库只需能读。

| 产品 | 本仓承担 | 说明 |
|------|----------|------|
| MongoDB | 读取 / 导入真库数据形态 | `mongodump` 产出的 `.bson` 文档流可导入；**不回写** MongoDB 原生数据文件（WiredTiger）。运行时数据落在 `.yykv`。 |

## 能力矩阵

命令面（`OP_MSG`）。码值按真实 MongoDB 语义：`59` = `CommandNotFound`（未实现一律拒绝而不是伪造），`73` = `InvalidNamespace`，`11000` = `DuplicateKey`。

| 命令 | 状态 | 行为 |
|------|------|------|
| `hello` / `isMaster` | 已支持 | `isWritablePrimary: true`、`minWireVersion: 0`、`maxWireVersion: 17` |
| `ping` | 已支持 | `{ ok: 1 }` |
| `insert` | 已支持 | 缺省 `_id` 自动生成 ObjectId；重复 `_id` 报 `11000` 且保留原文档；`ordered: false` 继续写入后续合法文档 |
| `find` | 已支持 | 任意字段过滤（`$eq`/`$ne`/`$gt`/`$gte`/`$lt`/`$lte`、一级点号嵌套）、`sort`、`skip`、`limit`、`batchSize` |
| `count` | 已支持 | 读 `query` 过滤，遵守 `skip` / `limit` |
| `aggregate` | 部分支持 | 仅 `$match`、常量 `_id` 的 `$sum: 1` `$group`、`$project`（含/排除）；其他阶段回 `59`，包括跟在已执行 `$match` 之后的阶段 |
| `delete` | 已支持 | `deletes[].q` 与 `limit`（`0` 表示全部） |
| `getMore` / `killCursors` | 已支持 | `find` 未取走的批次保存在进程内游标表 |
| `listCollections` / `listDatabases` | 已支持 | 供命令行列目录使用，来源是实际存储命名空间 |
| 其他命令 | 拒绝 | `59`，`errmsg: "unsupported"` |
| 非法集合命名空间 | 拒绝 | `73` |

游标回收：空闲 `600` 秒的游标没有后台定时器，只在后续 `find` / `getMore` 时惰性清扫。

## 目录

```
projects/mongo.rs/   Rust 库原语（mongo-core）与绑定（mongo-napi / mongo-pyo3 / mongo-wasm）
projects/mongo.ts/   TypeScript 产品面：服务端组装、驱动面、`mongosh` 风格 CLI
projects/mongo.py/   Python 包、服务端组装与示例
scripts/             构建与门禁脚本
```

Rust 侧只导出可单独调用的原语：BSON / extended JSON / `OP_MSG` 编解码、`.yykv` 文档存储、游标表、每条命令一个函数。**没有** `[[bin]]`、没有服务端主循环、没有万能 `run` 入口，游标表由调用方持有而不是全局状态。服务端组装与命令行都在 TypeScript / Python 侧组合这些导出。

平台包目录 = `mongo-<os>-<arch>`，包名与目录同构：`mongo-win32-x64` → `@yydb/mongo-win32-x64`；WASM 为 `mongo-unknown-wasm32`。所有包 `private: true`，到产品级之前不发布。

## 开发

```bash
npm run build:napi        # 构建本机平台 .node
npm run test:rust         # Rust 内核测试
npm run test:ts           # TypeScript 安装态验收（真实 mongodb 驱动）
npm run test:py           # Python 安装态验收（真实 pymongo）
```

真实 MongoDB 作为期望值来源，通过 `MONGO_ORACLE_URL` 指认（例如 `mongodb://127.0.0.1:27017`）。指不到真库时验收输出 `unverified`，加 `--require-oracle` 转为失败，**不会**用本实现自身的结果当期望值。

## 许可

MPL-2.0。
