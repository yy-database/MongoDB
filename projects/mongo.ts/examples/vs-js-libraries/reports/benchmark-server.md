# 服务端成本基准

Command: `pnpm --dir projects/mongo.ts/examples/vs-js-libraries benchmark:server`
数据集：1000 篇，固定 seed；3 轮测量 + 1 轮热身，取中位数并记 p95。
口径：本仓每轮新起临时数据目录的服务端，灌种子、建索引与 setup 不计时；`ping` 是协议 + 解析 + 回包编码地板。
真实 mongod：本机未配置（CI-only 列，不伪造真机数字）。
统计口径：median/p95 走上游 `database.harness` 的 `benchSummary`（nearest-rank，golden vector 钉死），不在脚本里重写算法。

## Workloads

每轮都以「drop 集合并重灌固定种子 → 执行 `setup` → 计时」执行，`setup` 与灌种子不计时。
单位 `commands` / `connections` 记每命令（每连接）耗时，`rows` / `documents` 记每行（每页返回的文档）耗时。

| 工作负载 | 单位 | 每轮量 | 覆盖与断言 |
|---------:|-----:|------:|------------|
| ping | commands | 200 | 空 `ping`；协议解析与回包编码的地板 |
| insert-single | commands | 50 | 单条 `insert`，含一次整快照落盘 |
| insert-multi | rows | 200 | 一次 `insert` 写 200 篇 |
| find-all | commands | 20 | `find {}` 按 `batchSize 250` 抽干整个集合 |
| find-point-pk | commands | 100 | 按 `_id` 单点 `find` |
| find-point-uk | commands | 100 | 按唯一索引 `sku` 单点 `find` |
| find-range-limit | commands | 20 | 无索引区间 `seq`，`limit 20`（早停扫描） |
| find-order-limit | commands | 20 | 无索引排序 `price desc, seq asc` 取 20 |
| find-index-equality | commands | 50 | 建 `grp_1` 后按 `grp` 等值取 10（索引等值路径） |
| find-hint-index | commands | 50 | 显式 `hint: {grp: 1}` 按 `grp` 等值取 10（强制索引路径） |
| count-command | commands | 50 | `count` 空查询，断言计数等于数据集 |
| distinct-command | commands | 50 | `distinct` 取 `grp`，断言 10 个不同值 |
| aggregate-sort | commands | 20 | `$match → $sort → $limit 20`（排序后取前 20） |
| transaction-range | commands | 20 | 只读事务内 20 条区间 `find limit 20`（事务视图分页早停） |
| find-projection-sort | commands | 20 | 投影 `{seq, price}` 加 `price desc, seq asc` 排序取 20 |
| cursor-paginate | documents | 1000 | `batchSize 100` 分页抽干 1000 篇（每页一条 `getMore`） |
| error-command | commands | 100 | 未知命令往返，断言 `code 59 CommandNotFound` |
| aggregate-group | commands | 10 | `$group` 十组计数与求和 |
| bulk-insert | rows | 5000 | 5000 篇按 200 篇/批写入 |
| aggregate-multistage | commands | 10 | `$match → $group → $sort → $limit → $project` |
| create-index | commands | 5 | 5 种键型各建一次 |
| big-doc-write | rows | 20 | 20 篇 64KB 文档逐条写 |
| big-doc-read | rows | 20 | 20 篇 64KB 文档按 `_id` 读并校验长度 |
| update-many | rows | 1000 | 10 条 `multi: true` 更新覆盖 1000 篇 |
| delete-many | rows | 500 | 5 条 `limit: 0` 删除覆盖 500 篇 |
| connect | connections | 20 | 20 次新建 `OP_MSG` 连接 |

## 溯源

| 项 | 值 |
|----|----|
| node | v24.18.0 |
| rustc | rustc 1.101.0-nightly (1c3a65069 2026-11-02) |
| MongoDB rev | c9757d0 |
| facade 钉住的 database.rs rev | 70aee1ebc60e0104a88f214ee46af37477b402a7 |
| 本地 path override | 5373e23 (dirty) |
| addon 产物 | 5239296 bytes, mtime 2026-11-14T13:20:55.729Z |
| 数据规模 | 1000 篇 × ~87B；bulk 5000 篇；大文档 20 × 64KB；规模 200,1000,5000 |

## 按本仓耗时排序

| 工作负载 | 单位 | 本仓 ms/op | 本仓 p95 ms/op | 真机 ms/op | 倍数 |
|---------:|-----:|-----------:|---------------:|-----------:|-----:|
| create-index | commands | 22.027 | 22.348 | CI-only | n/a |
| big-doc-write | rows | 9.738 | 14.900 | CI-only | n/a |
| find-all | commands | 8.678 | 9.016 | CI-only | n/a |
| insert-single | commands | 5.077 | 5.143 | CI-only | n/a |
| find-order-limit | commands | 3.281 | 4.409 | CI-only | n/a |
| aggregate-multistage | commands | 3.090 | 3.633 | CI-only | n/a |
| find-projection-sort | commands | 2.968 | 3.510 | CI-only | n/a |
| aggregate-sort | commands | 2.821 | 3.071 | CI-only | n/a |
| aggregate-group | commands | 2.301 | 3.068 | CI-only | n/a |
| distinct-command | commands | 2.135 | 2.156 | CI-only | n/a |
| find-range-limit | commands | 1.315 | 1.675 | CI-only | n/a |
| big-doc-read | rows | 0.964 | 1.738 | CI-only | n/a |
| connect | connections | 0.855 | 1.137 | CI-only | n/a |
| transaction-range | commands | 0.356 | 6.637 | CI-only | n/a |
| count-command | commands | 0.325 | 0.408 | CI-only | n/a |
| find-hint-index | commands | 0.256 | 0.266 | CI-only | n/a |
| find-index-equality | commands | 0.198 | 0.304 | CI-only | n/a |
| find-point-uk | commands | 0.180 | 0.185 | CI-only | n/a |
| update-many | rows | 0.177 | 0.180 | CI-only | n/a |
| delete-many | rows | 0.137 | 0.138 | CI-only | n/a |
| error-command | commands | 0.129 | 0.145 | CI-only | n/a |
| bulk-insert | rows | 0.127 | 0.131 | CI-only | n/a |
| ping | commands | 0.122 | 0.129 | CI-only | n/a |
| find-point-pk | commands | 0.112 | 0.161 | CI-only | n/a |
| insert-multi | rows | 0.079 | 0.088 | CI-only | n/a |
| cursor-paginate | documents | 0.010 | 0.010 | CI-only | n/a |

## 阶段差分

以 `ping`（0.122 ms/命令）作为传输 + 解析 + 回包编码地板，其余项的额外成本如下。
线上协议不暴露服务端内部分阶段耗时，这里是差分估计，不是插桩测量。
以行为单位的项先按单条命令的行数折算成每命令耗时，再与地板相减。

| 工作负载 | 额外 ms/命令 |
|---------:|-------------:|
| create-index | 21.905 |
| big-doc-write | 9.616 |
| find-all | 8.556 |
| insert-single | 4.955 |
| find-order-limit | 3.159 |
| aggregate-multistage | 2.968 |
| find-projection-sort | 2.846 |
| aggregate-sort | 2.699 |
| aggregate-group | 2.179 |
| distinct-command | 2.013 |
| find-range-limit | 1.193 |
| big-doc-read | 0.842 |
| connect | 0.733 |
| transaction-range | 0.234 |
| count-command | 0.203 |
| find-hint-index | 0.134 |
| find-index-equality | 0.076 |
| find-point-uk | 0.058 |
| update-many | 17.545 |
| delete-many | 13.606 |
| error-command | 0.007 |
| bulk-insert | 25.365 |
| find-point-pk | -0.010 |
| insert-multi | 15.776 |
| cursor-paginate | -0.112 |

## 规模扩展

同一份实现只改集合文档数，3 轮测量 + 1 轮热身，每项 50 次取中位数。
未命中 `delete` 不改数据，因此不含落盘成本，只看查找路径。

| 文档数 | `_id` 单查 ms/op | 唯一索引单查 ms/op | `updateOne` ms/op | 未命中 `delete` ms/op |
|------:|-----------------:|-------------------:|------------------:|----------------------:|
| 200 | 0.163 | 0.215 | 5.426 | 0.152 |
| 1000 | 0.167 | 0.192 | 6.894 | 0.172 |
| 5000 | 0.165 | 0.169 | 12.031 | 0.132 |

## 根因

- **每条写命令一次整快照落盘**：上游 `database.storage::cluster_kv::FileShard::commit_changes` 每次提交都重新编码整份
  `.yykv` 快照、`sync_all` 后原子替换文件。`insert-single` 与 `ping` 的差就是这条写命令的成本地板（见差分表），
  它随集合总字节数增长：扩展表里 `updateOne` 从 200 篇到 5000 篇的增长就是这份快照，而不是匹配扫描。
  上游 `mongo::commands::bulk_write` 逐条调用 `insert` / `update` / `delete`，不合并提交，所以 `bulkWrite` 省不掉这个地板。
  改成追加或增量落盘属于存储层改造，超出 facade 与 yyds/mongo 的范围。
- **唯一索引单查已恒定**：上游 `fa3f55a`（区间下推 + 有界索引扫描）与 `d4a0082`（已落盘索引项探针）之后，
  扩展表里唯一索引单查与 `_id` 单查同量级，不再随文档数增长。
- **`update` 按 `_id` 等值走点读 + 索引项探针**：上游 `mongo::commands::update` 对单 `_id` 等值过滤直接点读定位，
  唯一键冲突改为按已落盘索引项前缀探针检查，不再为每条更新命令整命名空间扫描；事务内或索引条目缺失时
  仍退回整表 map，宁可慢也不放行重复键。非 `_id` 过滤（如 `update-many` 按 `grp`）没有可用索引时仍是扫描，属预期。
- **`ping` / `count` / 写确认也走原生 `OP_MSG` 帧**：`insert` / `update` / `delete` 的成功应答由 Rust 直接编码，
  宿主只读一个 `ok` 位决定是否提交 oplog；只有副本集盖章、`writeConcernError` 或 `w: 0` 才解码重写，
  其余路径不再把应答转成 Extended JSON 再序列化回去。`ping` 的独立收益约 5%（对 200 条命令的中位数），
  写命令被整快照落盘淹没，差异在噪声内；本轮保留是为了与读路径统一字节语义，而不是把它记作提速项。
- **空查询 `count` 不再解码整集合**：没有 filter、`skip`、`limit` 与 `hint` 时，计数就是事务视图或已提交数据的条数，
  不必把每篇文档解析成 `BsonDocument`。`count-command` 从整表解析降到 0.325 ms/命令量级，AB 中位数约 5 倍提升。
- **只读事务的分页扫描按已提交数据推进**：事务没有写过该命名空间时，`find` 的 `limit` 早停直接走分页扫描，
  不再先合并整段事务视图；只有本命名空间存在暂存写入时才退回整段读。`transaction-range` 的 AB 中位数约 2.6 倍提升。
- **读命令回复直接写原生 `OP_MSG` 帧**：`find` / `getMore` / `aggregate` 的回复由 Rust 一侧编码成 BSON 载荷，
  宿主写帧时不再把文档转成 Extended JSON、在 JS 里 `JSON.parse` 后再 `JSON.stringify` 回 Rust 重新编码。
  改造前一条 250 篇的回复光这一步 JSON 桥约 1.1 ms（探针拆分：Rust 写文本 0.25 ms、JS 解析 0.25 ms、
  序列化 0.09 ms、Rust 重新解析并编码 BSON 0.93 ms），`find-all` 一轮 1000 篇要付两次。
- **排序每篇只取一次键**：`sort_documents` 改用 `sort_by_cached_key`，`n log n` 次比较不再各解析一次字段路径。
- **早停查询按页扫描**：无排序且带 `limit` 的 `find` 按 256 篇一页推进，凑够命中就停，不再先整集合取回再丢弃；
  索引等值/区间仍走上游索引扫描，不受影响。
- **整集合读、排序与聚合是扫描成本**：`find-all` / `find-order-limit` / `aggregate-group` 都要读出并解码全部文档，
  与 1000 篇的规模成正比，这部分属预期内的线性开销，不是缺陷。
- **`create-index` 是两次快照提交加一次全集合回填**：目录写入与索引条目回填各提交一次整份快照，
  摊掉其中一次属于存储层合并提交的改造范围。

## 预计收益（按差分估算）

- 写路径改成追加或增量落盘：单条写命令从 `insert-single` 的 5.077 ms 降到与 `ping` 同量级，约省 4.955 ms/命令；这也是 `updateOne` 与 `big-doc-write` 剩余成本的主体。
- `update` 点读化已落地：修复前每条 `updateOne` 整命名空间扫描匹配并整表建唯一 map，5000 篇下约 43 ms/op（历史捕获，同一脚本旧版数字）；
  现在 12.031 ms/op，剩余增长跟随快照提交随数据量的增长（1000 篇 `insert-single` 地板 5.077 ms/op），不再是匹配扫描。
- 未命中 `delete` 与 `_id` / 唯一索引单查都稳定在 0.132 ms 量级，读路径没有再随规模增长的缺陷。
- 事务视图分页早停已落地：只读事务的 `limit` 查询不再先合并整段视图，AB 中位数从约 0.75 ms/命令降到约 0.29 ms/命令。
- 空查询 `count` 已跳过整表解码：AB 中位数从约 2.06 ms/命令降到约 0.42 ms/命令。

## 不计入比值的边界

- 本机没有 `mongod`、也没有 Docker，真实服务端对比列为 CI-only；这里的数字只描述本仓服务端成本。
- 本仓服务端是 TypeScript `net` 监听，每条命令的处理路径不含上游 `database.server::yyds::mongo::service` 的
  监听循环，因此该循环的 `WouldBlock` 睡眠不在本基准的测量范围内。

Regenerate: `pnpm --dir projects/mongo.ts/examples/vs-js-libraries benchmark:server`
