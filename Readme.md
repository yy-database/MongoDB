# MongoDB

用 `.yyds` / `.yykv` 存储后端模拟 MongoDB 服务端能力：对外是 MongoDB 线协议（OP_MSG / OP_QUERY）与 `mongosh` 风格命令行，对内把文档写进 YYDS 分片存储。

**不是** 通用 MongoDB 客户端库，**不是** 完整 MongoDB 实现。已支持的命令面见下方能力矩阵，未列入的命令一律显式拒绝并带诊断码，不会返回编造的结果。

## 定位

| 项 | 口径 |
|----|------|
| 协议 | MongoDB wire protocol，`OP_MSG` 为主，兼容驱动的首个 `OP_QUERY` handshake 探测 |
| 存储 | YYDS `.yyds` catalog + `.yykv` 分片（`yyds::kv::FileShard`），命名空间 = `<database>.<collection>` |
| 验收 | 同一批 case 同时驱动 TypeScript 与 Python 绑定，逐 case 比对两侧输出 |
| 命令行 | JS/TS 最小入口 `projects/mongo.ts/packages/mongo/bin/mongo.mjs`，只组合 napi 原语；管道模式逐行读命令、逐行输出 JSON |
| 发布 | 当前阶段**不发布**：所有包 `private: true`，未配置 Trusted Publisher |

## 存储兼容口径

只有嵌入式库才要求存储格式双工兼容；服务端数据库只需能读。

| 产品 | 本仓承担 | 说明 |
|------|----------|------|
| MongoDB | 读取 / 导入真库数据形态 | `mongodump` 产出的 `.bson` 文档流可导入；**不回写** MongoDB 原生数据文件（WiredTiger）。运行时数据落在 `.yykv`。 |

## `.yyds` 目录

一次打开对应一个目录，两个文件成对出现：

| 文件 | 角色 | 内容 |
|------|------|------|
| `<stem>.yyds` | catalog | 魔法 `YYDS\x01`、格式版本 `0`、小端 `u32` 字段；schema 槽存 `{"version":1,"namespaces":["<db>.<collection>",…]}`，shard 注册表恰好一个 `ShardId`，指向 `<stem>.yykv` |
| `<stem>.yykv` | 数据分片 | 由 `yyds::kv::FileShard` 读写；`!catalog` 命名空间只保存命名空间标签，用于 catalog 缺失时重建 |

catalog 字节直接走共享契约 `yyds::catalog::encode/decode`（`YYDS\x01` + 小端 `u32` 版本 `0` + 可选 schema / routing / contract / owners 段），字段顺序照抄，不自造。该格式**没有校验和字段**，完整性由魔法、版本、长度与尾部多余字节检查承担。

打开行为：

- **catalog 存在**：解析；要求恰好注册 1 个 shard、schema 版本为 `1`、文档是含 `namespaces` 数组的 JSON，且它指向的 shard 文件存在。任一不满足即结构化拒绝（`StoreError::Catalog`），不静默修复、不猜测。
- **catalog 缺失**：新建一个单 shard 的 catalog，并用 `.yykv` 里的 `!catalog` 标签补齐命名空间后照常打开；已写入的数据不受影响。
- **写入**：新命名空间出现时把注册表回写进 catalog；shard 路径始终由 catalog 的 `ShardId` 决定。
- **写序**：先写 `.yykv`（不存在则立即落盘），后写 `.yyds`；catalog 用“临时文件 + `sync_all` + 原子 rename”替换，不会出现半截 catalog。崩溃落在两次写入之间只会留下 `.yykv`，下次打开自动补 catalog，不会出现“只剩 catalog 永久打不开”的窗口。
- **显式修复**：`repair_shard`（napi / pyo3 对称导出）只处理“catalog 在、shard 不在”的残留：按 catalog 里的 `ShardId` 补写一个空 shard，不改写 catalog 字节、不覆盖已存在的 shard（哪怕它不可读）、健康目录上是 no-op；没有 catalog 时直接拒绝，不会凭空造 catalog。`open` 永远不会调用它，也不会静默新建空分片。

报错与修复对照：

| 现象 | `errmsg` 关键字 | 处理 |
|------|------|------|
| catalog 指向的 `.yykv` 不存在 | `points at missing shard` | 先确认 catalog 是期望的那份，再调 `repair_shard` 补空 shard；原 shard 曾丢失时数据无法从 catalog 恢复 |
| 只剩 `.yykv` | 不报错 | 默认自愈：用 `!catalog` 标签重建 catalog |
| `.yykv` 为空/损坏 | shard 解码错误 | 拒绝且 `repair_shard` 为 no-op（不覆盖已有文件）；需人工介入 |
| catalog 损坏 | `catalog ... is invalid` | 拒绝；不会自动重建，避免把配置错误当成缺失 |

删除全部文档或删掉最后一个集合不会删除 `.yykv`：catalog 与 shard 都保留，reopen 走的是正常路径而不是缺失态。

## 能力矩阵

命令面（`OP_MSG`）。码值按真实 MongoDB 语义：`59` = `CommandNotFound`（未实现一律拒绝而不是伪造），`73` = `InvalidNamespace`，`11000` = `DuplicateKey`。

| 命令 | 状态 | 行为 |
|------|------|------|
| `hello` / `isMaster` | 已支持 | `isWritablePrimary: true`、`minWireVersion: 0`、`maxWireVersion: 17` |
| `ping` | 已支持 | `{ ok: 1 }` |
| `insert` | 已支持 | 缺省 `_id` 自动生成 ObjectId；重复 `_id` 报 `11000` 且保留原文档；`ordered: false` 继续写入后续合法文档 |
| `find` | 已支持 | 过滤算子见“查询算子”一节；`projection`（0/1 包含排除，`_id` 单独规则）、`sort`、`skip`、`limit`、`batchSize`；白名单外的算子回 `2` 并带算子名、操作名与位置 |
| `count` | 已支持 | 读 `query` 过滤，遵守 `skip` / `limit`；未知算子同上拒绝 |
| `aggregate` | 部分支持 | 仅 `$match`、常量 `_id` 的 `$sum: 1` `$group`、`$project`（含/排除）；其他阶段回 `59`；`$match` 的未知算子回 `2` |
| `delete` | 已支持 | `deletes[].q` 与 `limit`（`0` 表示全部）；未知算子回 `2` |
| `update` | 部分支持 | `$set` / `$unset` / `$inc`，`multi` 决定 updateMany；`upsert` 与替换式更新回 `59`，未知修饰符回 `9`，`$inc` 非数值回 `14`，改 `_id` 回 `66`，路径冲突回 `40` |
| `getMore` / `killCursors` | 已支持 | `find` 未取走的批次保存在进程内游标表 |
| `listCollections` / `listDatabases` | 已支持 | 供命令行列目录使用，来源是实际存储命名空间 |
| 其他命令 | 拒绝 | `59`，`errmsg: "unsupported"` |
| 非法集合命名空间 | 拒绝 | `73` |

游标回收：空闲 `600` 秒的游标没有后台定时器，只在后续 `find` / `getMore` 时惰性清扫。

### 查询算子（filter）

`find`、`count`、`update`、`delete`、`aggregate` 的 `$match` 五条路径共用同一份校验与匹配实现（`validate_filter` + `document_matches`），不各写一套。

| 层级 | 算子 | 依据 |
|------|------|------|
| 顶层 | `$and`、`$or`、`$nor` | 手册各页 Syntax：非空 filter 数组 |
| 顶层（拒绝） | `$not` | `$not` 是字段级算子；顶层出现报 `unknown top level operator: $not` |
| 字段级 | `$eq`、`$ne`、`$gt`、`$gte`、`$lt`、`$lte` | 手册各算子页 |
| 字段级 | `$in`、`$nin`、`$exists`、`$regex`、`$options`、`$size`、`$type`、`$elemMatch`、`$all`、`$not` | 手册各算子页；`$options` 只作 `$regex` 的伴生键 |

逐条落实的边界（全部写进 `tests/cases/operators.json`，case 带 `source` 指向手册页面/小节）：

- `$all: []` **不匹配任何文档**（`$all` 页 Behavior：“When passed an empty array, `$all` matches no documents”）。
- `$and: []`、`$or: []`、`$nor: []`、`$in: []`、`$nin: []` **回 `2` 拒绝**：手册只定义“one or more”，空数组无据可依，代码里写明 `refusing to guess`，不自行认定恒真/恒假。
- `{a: null}` 匹配**缺失字段**、**显式 null**，以及**含 null 元素的数组**；空数组不匹配（`tutorial/query-for-null-fields`）。
- `{a: {$exists: false}}` 只匹配缺失字段；`{a: {$exists: true}}` 含显式 null。`{a: {$ne: null}}` 的补集包含空数组（同页）。
- `{a: {$type: 10}}` 只匹配显式 null，不匹配缺失（同页）。
- 数组字段：`$eq` 先按“整体相等”判（**顺序敏感**，`$eq` 页），再按“任一元素相等”；`$in` 按“任一元素命中”；`$gt`/`$lt` 按“任一元素比较”，且比较前做类型分桶（字符串不会被 `$gt: 5` 命中）。
- `$regex` 对数组按“任一元素匹配”处理，依据是 `tutorial/query-arrays` 的数组查询规则；`$regex` 页本身未单列数组情形的措辞。
- 点路径进入数组会展开（`instock.qty`）；不带 `$elemMatch` 时不同条件可落在不同元素上（`tutorial/query-array-of-documents`），带 `$elemMatch` 时同一元素必须同时满足全部条件。
- `$not` 命中“不匹配该算子表达式”的文档，**包括不含该字段的文档**（`$not` 页）。
- `$type` 数组元素命中任一类型；`$type: "array"` 看字段本身是否为数组；别名与 BSON 码取自 `reference/bson-types`。

未实现（保持 `unknown operator` 报错并带算子名/操作/字段路径，不静默空结果）：`$mod`、`$where`、`$text`、`$expr`、`$geoWithin` 等其余算子；`$in`/`$nin` 中的正则字面量（解析器没有 BSON regex 值类型）；`$regex` 的 PCRE 特性（回引用、环视），Rust `regex` 只覆盖 RE2 子集；存储容纳不了的 BSON 类型（`date`/`decimal`/`timestamp` 等）在 `$type` 中合法但恒不命中，不算静默错误。数字下标点路径已实现但未纳入 case：手册 `core/dot-notation` 页面本轮未取得，不作无来源断言。


## 目录

```
projects/mongo.rs/   Rust 库原语（mongo-core）与绑定（mongo-napi / mongo-pyo3 / mongo-wasm）
projects/mongo.ts/   TypeScript 绑定、安装态验收 runner 与最小命令行 `packages/mongo/bin/mongo.mjs`
projects/mongo.py/   Python 包与同一批 case 的验收 runner
scripts/             构建、BSON case 生成、跨语言门禁与独立 `.yyds` 字节校验脚本 `scripts/verify-yyds.mjs`
tests/cases/         两种语言共用的声明式 case 语料
```

Rust 侧只导出可单独调用的原语：BSON / extended JSON / `OP_MSG` 编解码、`.yyds` catalog + `.yykv` 文档存储、游标表、每条命令一个函数。**没有** `[[bin]]`、没有服务端主循环、没有万能 `run` 入口，游标表由调用方持有而不是全局状态。

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

当前没有接入真实 MongoDB 的在线对比 runner，因此不存在 oracle 计数；需要真库对照时应另起 runner 并单独计数，不能混入上述 300+ 断言。本机也没有 `mongod` 或 `mongodb-memory-server`，本轮新增的查询算子期望值**全部来自官方手册（case 的 `source` 字段指向具体页面/小节），仅文档依据、未在真实 `mongod` 上实机验证**；无法从手册确定语义的空数组形态直接拒绝，而不是猜一个恒真/恒假。

## 命令行（最小面）

`projects/mongo.ts/packages/mongo/bin/mongo.mjs` 是唯一 CLI 入口：用 JS 写解析与分发，每条命令只调用一个 napi 原语，不新增 Rust `[[bin]]`、不做 shell 拼串、不做 JS eval、不提供万能子命令。

```bash
printf 'use app\ninsertMany(items, [{"_id":1},{"_id":2}])\nfind(items, {}).sort({"_id":1})\n' \
  | node projects/mongo.ts/packages/mongo/bin/mongo.mjs --data-dir .tmp/cli --db app
```

支持的命令（`--help` 会原样列出）：

| 命令 | 说明 |
|------|------|
| `use <db>` | 切换 `$db` 命名空间 |
| `show dbs` / `show collections` | 走 `listDatabases` / `listCollections` |
| `insertOne(<coll>, <doc>)` / `insertMany(<coll>, [<doc>...])` | JSON 或 Extended JSON 输入 |
| `find(<coll>, [filter], [projection])[.sort(<doc>)][.skip(<n>)][.limit(<n>)]` | 过滤白名单与 `find` 命令一致 |
| `updateOne` / `updateMany`(`<coll>, <filter>, <update>`) | 仅 `$set` / `$unset` / `$inc` |
| `deleteOne` / `deleteMany`(`<coll>, <filter>`) | `limit` 1 / 0 |
| `countDocuments(<coll>, [filter])` | 走 `count` |
| `exit` / `quit` | 停止读后续行 |

`find` / `updateOne` / `updateMany` / `deleteOne` / `deleteMany` / `countDocuments` 的过滤参数走同一条白名单（与上面的“查询算子”完全一致，`--help` 逐项列出）：

```
logical: $and $or $nor
field:   $eq $ne $gt $gte $lt $lte $in $nin $exists $regex $options $size $type $elemMatch $all $not
```

白名单外的算子（例如 `$mod`、`$where`、`$text`）在命令行里同样回 `2`，`errmsg` 带算子名与操作名。

管道模式每条命令输出一行 Extended JSON；被拒绝的输入也输出一行 `{"ok":{"$numberInt":"0"},"code":...,"errmsg":...}` 并继续处理后续行，进程退出码为 `0`。未知命令回 `59` 且 `errmsg` 含 `unknown command:` 与支持清单；参数形态错误回 `2`；命令语义错误沿用原语错误码（`14` / `66` 等）。存储固定为 `<data-dir>/mongo.yykv`，不监听端口。

测试覆盖性质不同：TypeScript 侧真实启动该进程（`cli` 面 24 个 case）；Python 侧没有同一入口，用同一份 case 把命令行语法映射到 pyo3 原语后比对终态，属于**语义等价**验证，不等同于“同一个入口两侧都跑”。

## 能力边界

- `_id` 数值判等：按 MongoDB 官方文档“所有数值类型在比较时等价”实现（整型走精确 `i128` 比较，避免 `2^53` 以上被 double 折叠），**仅文档依据、未在真实 `mongod` 上实机验证**。
- `update` 的 `upsert` 未实现，显式回 `59`；替换式更新同样回 `59`，不做半实现。
- CLI 不监听网络端口、不做鉴权、不模拟 `mongosh` 的 JavaScript 求值；所有写语义都在 Rust 原语里。
- `find` 的 `projection` 只支持 0/1 包含排除，不支持位置投影与 `$elemMatch`。
- `.yyds` 只读自己的口径：catalog 由本仓写出，读取时按共享契约的小端字段解析。已验证能读 Redis 仓产出的 catalog；PostgreSQL 仓的 `encode_catalog` 用大端 `u32`，与共享契约不一致，本仓按契约解析并拒绝该字节流（跨仓只报告、不修改）。
- `.yyds` 格式无校验和，`tests/cases/catalog.json` 里的“校验和错”用尾部多余字节代替，其余损坏面覆盖魔法、版本、截断、schema 版本与文档形态。

### 本地 `yyds` 联调（可选）

默认不需要任何本地配置：`Cargo.toml` 锁定 `yyds` 的 git revision，`cargo test` 直接按该 revision 解析。只有在你自己也检出 `yyds` 源码时才需要本地覆盖：

1. 复制 `.cargo/config.toml.example` 为 `.cargo/config.toml`（已被 gitignore）；
2. 去掉 `[patch."https://github.com/oovm/database.rs.git"]` 的注释并把路径改成你的检出目录；
3. 该目录不存在时请删掉 `.cargo/config.toml`，否则 `cargo test` 在编译前就会因找不到路径而失败。

`cargo test` 不依赖 `.cargo/` 目录本身；把整个目录临时移走再跑一遍即可验证。

## 许可

MPL-2.0。
