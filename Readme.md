# MongoDB

用 `.yyds` / `.yykv` 存储后端模拟 MongoDB 服务端能力：对外是 MongoDB 线协议（OP_MSG / OP_QUERY）与 `mongosh` 风格命令行，对内把文档写进 YYDS 分片存储。

**不是** 通用 MongoDB 客户端库，**不是** 完整 MongoDB 实现。已支持的命令面见下方能力矩阵，未列入的命令一律显式拒绝并带诊断码，不会返回编造的结果。

## 定位

| 项 | 口径 |
|----|------|
| 协议 | MongoDB wire protocol，`OP_MSG` 为主，兼容驱动的首个 `OP_QUERY` handshake 探测 |
| 存储 | YYDS `.yykv` 分片（`yyds::kv::FileShard`），命名空间 = `<database>.<collection>` |
| 验收 | 同一批 case 同时驱动 TypeScript 与 Python 绑定，逐 case 比对两侧输出 |
| 命令行 | 尚未实现（当前只有库原语与验收 runner），不提供万能入口 |
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
| `find` | 已支持 | 字段过滤（`$eq`/`$ne`/`$gt`/`$gte`/`$lt`/`$lte`、一级点号嵌套）、`sort`、`skip`、`limit`、`batchSize`；白名单外的算子回 `2` 并带算子名、操作名与位置 |
| `count` | 已支持 | 读 `query` 过滤，遵守 `skip` / `limit`；未知算子同上拒绝 |
| `aggregate` | 部分支持 | 仅 `$match`、常量 `_id` 的 `$sum: 1` `$group`、`$project`（含/排除）；其他阶段回 `59`；`$match` 的未知算子回 `2` |
| `delete` | 已支持 | `deletes[].q` 与 `limit`（`0` 表示全部）；未知算子回 `2` |
| `update` | 部分支持 | `$set` / `$unset` / `$inc`，`multi` 决定 updateMany；`upsert` 与替换式更新回 `59`，未知修饰符回 `9`，`$inc` 非数值回 `14`，改 `_id` 回 `66`，路径冲突回 `40` |
| `getMore` / `killCursors` | 已支持 | `find` 未取走的批次保存在进程内游标表 |
| `listCollections` / `listDatabases` | 已支持 | 供命令行列目录使用，来源是实际存储命名空间 |
| 其他命令 | 拒绝 | `59`，`errmsg: "unsupported"` |
| 非法集合命名空间 | 拒绝 | `73` |

游标回收：空闲 `600` 秒的游标没有后台定时器，只在后续 `find` / `getMore` 时惰性清扫。

## 目录

```
projects/mongo.rs/   Rust 库原语（mongo-core）与绑定（mongo-napi / mongo-pyo3 / mongo-wasm）
projects/mongo.ts/   TypeScript 绑定与安装态验收 runner
projects/mongo.py/   Python 包与同一批 case 的验收 runner
scripts/             构建、BSON case 生成与跨语言门禁脚本
tests/cases/         两种语言共用的声明式 case 语料
```

Rust 侧只导出可单独调用的原语：BSON / extended JSON / `OP_MSG` 编解码、`.yykv` 文档存储、游标表、每条命令一个函数。**没有** `[[bin]]`、没有服务端主循环、没有万能 `run` 入口，游标表由调用方持有而不是全局状态。

平台包目录 = `mongo-<os>-<arch>`，包名与目录同构：`mongo-win32-x64` → `@yydb/mongo-win32-x64`；WASM 为 `mongo-unknown-wasm32`。所有包 `private: true`，到产品级之前不发布。

## 开发

```bash
npm run build:napi        # 构建本机平台 .node
npm run build:pyo3        # 构建 Python 扩展
npm run test:rust         # Rust 内核测试
npm run test:ts           # TypeScript 绑定验收（同一批 case）
npm run test:py           # Python 绑定验收（同一批 case）
npm test                  # Rust + TS + PY + 跨语言门禁
```

期望值全部以字面量写进 `tests/cases/*.json`：BSON 字节布局来自参考实现的产物，命令与查询语义来自 MongoDB 规则，不调用本实现推导期望值。门禁要求两侧逐 case 输出一致、断言数不低于实测下限、`skipped` 为 0。

当前没有接入真实 MongoDB 的在线对比 runner，因此不存在 oracle 计数；需要真库对照时应另起 runner 并单独计数，不能混入上述 300+ 断言。

### 本地 `yyds` 联调（可选）

默认不需要任何本地配置：`Cargo.toml` 锁定 `yyds` 的 git revision，`cargo test` 直接按该 revision 解析。只有在你自己也检出 `yyds` 源码时才需要本地覆盖：

1. 复制 `.cargo/config.toml.example` 为 `.cargo/config.toml`（已被 gitignore）；
2. 去掉 `[patch."https://github.com/oovm/database.rs.git"]` 的注释并把路径改成你的检出目录；
3. 该目录不存在时请删掉 `.cargo/config.toml`，否则 `cargo test` 在编译前就会因找不到路径而失败。

`cargo test` 不依赖 `.cargo/` 目录本身；把整个目录临时移走再跑一遍即可验证。

## 许可

MPL-2.0。
