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
| insert-duplicate-key | commands | 20 | 复用种子 `sku` 触发唯一索引冲突，断言 `code 11000`（写错误路径） |
| find-all | commands | 20 | `find {}` 按 `batchSize 250` 抽干整个集合 |
| find-point-pk | commands | 100 | 按 `_id` 单点 `find` |
| find-point-uk | commands | 100 | 按唯一索引 `sku` 单点 `find` |
| find-range-limit | commands | 20 | 无索引区间 `seq`，`limit 20`（早停扫描） |
| find-order-limit | commands | 20 | 无索引排序 `price desc, seq asc` 取 20 |
| find-skip-sort-page | commands | 20 | 排序后 `skip 500 / limit 20` 的偏移分页，断言价格与 `seq` 单调 |
| find-index-equality | commands | 50 | 建 `grp_1` 后按 `grp` 等值取 10（索引等值路径） |
| find-hint-index | commands | 50 | 显式 `hint: {grp: 1}` 按 `grp` 等值取 10（强制索引路径） |
| explain-find | commands | 50 | `explain` 等值过滤，断言 `FETCH` 盖 `IXSCAN`、命中索引名与命名空间、谓词归一为 `$eq` |
| count-command | commands | 50 | 非空 `query {grp: {$gte: 0}}`，断言计数等于数据集 |
| count-window | commands | 50 | 非空 `query` 加 `skip 200 / limit 300`，断言窗口计数为 300（早停边界） |
| distinct-command | commands | 50 | 非空 `query {grp: {$gte: 0}}` 取 `grp`，断言 10 个不同值 |
| aggregate-sort | commands | 20 | `$match → $sort → $limit 20`（排序后取前 20） |
| transaction-range | commands | 20 | 只读事务内 20 条区间 `find limit 20`（事务视图分页早停） |
| transaction-write-read | commands | 10 | 事务内 `insert` 后立即 `find` 回读暂存写入，再 `abortTransaction`（合并视图） |
| find-and-modify | commands | 50 | 按 `seq` 命中一篇后 `$set`，`new: true` 回读（先定位再写） |
| replace-one | commands | 50 | 按 `_id` 整篇替换，断言命中 1、回读新值且 setup 打的 `stale` 字段被丢弃 |
| bulk-write-mixed | commands | 4 | 一条 `bulkWrite` 混合 2 insert / 2 update / 2 delete（`admin` + `nsInfo`） |
| update-one-upsert | commands | 50 | `_id` 不存在时 `updateOne upsert`，断言每条都走 upsert 分支 |
| getMore-pagination | documents | 1000 | 首包 `batchSize 25` 后续每页 `batchSize 100` 抽干（校验页数与游标存活） |
| delete-many-range | rows | 1000 | 10 条 `seq` 区间删除各 100 篇（`limit: 0`） |
| find-projection-sort | commands | 20 | 投影 `{seq, price}` 加 `price desc, seq asc` 排序取 20 |
| find-projection-exclusion | commands | 20 | 排除式投影 `{seq: 0, pad: 0}` 取 20，断言被排除字段不出现、排序键仍生效 |
| cursor-paginate | documents | 1000 | `batchSize 100` 分页抽干 1000 篇（每页一条 `getMore`） |
| error-command | commands | 100 | 未知命令往返，断言 `code 59 CommandNotFound` |
| aggregate-group | commands | 10 | `$group` 十组计数与求和 |
| bulk-insert | rows | 5000 | 5000 篇按 200 篇/批写入 |
| aggregate-multistage | commands | 10 | `$match → $group → $sort → $limit → $project` |
| aggregate-add-fields | commands | 10 | `$addFields` 算 `$concat` / `$subtract` / 字面量三列，逐行比对回种子值 |
| aggregate-window | commands | 10 | `$setWindowFields` 按 `grp` 分区分、`seq` 排序，断言 `$documentNumber` 与累加窗口 |
| aggregate-facet | commands | 10 | 一条 `$facet` 并行算总量、价格前五与十组计数 |
| aggregate-bucket | commands | 10 | `$bucket` 按 `price` 切成五个固定区间并汇总 |
| aggregate-lookup-unwind | commands | 10 | `$match → $lookup → $unwind → $group → $sort` 关联边表 |
| aggregate-graph-lookup | commands | 10 | `$graphLookup` 沿 `parent` 递归十节点链，断言七环祖先与 `depth` 递进 |
| find-in-filter | commands | 20 | 20 个稀疏 `seq` 值的 `$in` 过滤（候选集拼接） |
| find-regex-prefix | commands | 20 | `sku` 前缀正则 `^sku-0001` 命中 10 篇（正则候选集） |
| aggregate-lookup | commands | 10 | `$match → $limit → $lookup` 同集合自连接，断言关联数组长度 |
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
| MongoDB rev | 818ae55 |
| facade 钉住的 database.rs rev | 70aee1ebc60e0104a88f214ee46af37477b402a7 |
| 本地 path override | 0a3b999 (dirty) |
| addon 产物 | 5313536 bytes, mtime 2026-11-15T04:58:20.802Z |
| 数据规模 | 1000 篇 × ~87B；bulk 5000 篇；大文档 20 × 64KB；规模 200,1000,5000 |

## 按本仓耗时排序

| 工作负载 | 单位 | 本仓 ms/op | 本仓 p95 ms/op | 真机 ms/op | 倍数 |
|---------:|-----:|-----------:|---------------:|-----------:|-----:|
| create-index | commands | 15.953 | 16.077 | CI-only | n/a |
| find-regex-prefix | commands | 15.261 | 15.347 | CI-only | n/a |
| bulk-write-mixed | commands | 10.894 | 12.798 | CI-only | n/a |
| big-doc-write | rows | 6.327 | 10.501 | CI-only | n/a |
| find-and-modify | commands | 4.948 | 5.048 | CI-only | n/a |
| replace-one | commands | 4.038 | 5.221 | CI-only | n/a |
| update-one-upsert | commands | 3.988 | 4.952 | CI-only | n/a |
| find-all | commands | 3.962 | 4.277 | CI-only | n/a |
| aggregate-facet | commands | 3.864 | 3.865 | CI-only | n/a |
| insert-single | commands | 3.808 | 4.322 | CI-only | n/a |
| aggregate-lookup-unwind | commands | 2.268 | 2.333 | CI-only | n/a |
| aggregate-lookup | commands | 2.185 | 2.310 | CI-only | n/a |
| aggregate-add-fields | commands | 2.004 | 2.383 | CI-only | n/a |
| aggregate-multistage | commands | 1.905 | 2.128 | CI-only | n/a |
| aggregate-window | commands | 1.888 | 2.002 | CI-only | n/a |
| aggregate-bucket | commands | 1.501 | 1.715 | CI-only | n/a |
| aggregate-sort | commands | 1.495 | 1.598 | CI-only | n/a |
| aggregate-group | commands | 1.433 | 1.499 | CI-only | n/a |
| find-projection-exclusion | commands | 1.323 | 1.605 | CI-only | n/a |
| explain-find | commands | 1.245 | 1.292 | CI-only | n/a |
| find-in-filter | commands | 1.198 | 1.225 | CI-only | n/a |
| find-projection-sort | commands | 1.188 | 1.472 | CI-only | n/a |
| find-skip-sort-page | commands | 1.085 | 1.116 | CI-only | n/a |
| find-order-limit | commands | 1.056 | 1.235 | CI-only | n/a |
| find-range-limit | commands | 0.493 | 0.511 | CI-only | n/a |
| distinct-command | commands | 0.485 | 0.593 | CI-only | n/a |
| big-doc-read | rows | 0.414 | 0.489 | CI-only | n/a |
| connect | connections | 0.389 | 0.392 | CI-only | n/a |
| count-command | commands | 0.343 | 0.349 | CI-only | n/a |
| transaction-write-read | commands | 0.281 | 0.434 | CI-only | n/a |
| count-window | commands | 0.206 | 0.208 | CI-only | n/a |
| transaction-range | commands | 0.203 | 0.298 | CI-only | n/a |
| aggregate-graph-lookup | commands | 0.156 | 0.182 | CI-only | n/a |
| insert-duplicate-key | commands | 0.128 | 0.152 | CI-only | n/a |
| find-index-equality | commands | 0.112 | 0.142 | CI-only | n/a |
| update-many | rows | 0.106 | 0.109 | CI-only | n/a |
| find-hint-index | commands | 0.097 | 0.116 | CI-only | n/a |
| find-point-uk | commands | 0.085 | 0.100 | CI-only | n/a |
| find-point-pk | commands | 0.077 | 0.080 | CI-only | n/a |
| error-command | commands | 0.070 | 0.073 | CI-only | n/a |
| insert-multi | rows | 0.068 | 0.069 | CI-only | n/a |
| delete-many | rows | 0.064 | 0.065 | CI-only | n/a |
| bulk-insert | rows | 0.055 | 0.066 | CI-only | n/a |
| delete-many-range | rows | 0.053 | 0.068 | CI-only | n/a |
| ping | commands | 0.052 | 0.065 | CI-only | n/a |
| cursor-paginate | documents | 0.006 | 0.006 | CI-only | n/a |
| getMore-pagination | documents | 0.005 | 0.007 | CI-only | n/a |

## 阶段差分

以 `ping`（0.052 ms/命令）作为传输 + 解析 + 回包编码地板，其余项的额外成本如下。
线上协议不暴露服务端内部分阶段耗时，这里是差分估计，不是插桩测量。
以行为单位的项先按单条命令的行数折算成每命令耗时，再与地板相减。

| 工作负载 | 额外 ms/命令 |
|---------:|-------------:|
| create-index | 15.901 |
| find-regex-prefix | 15.210 |
| bulk-write-mixed | 10.842 |
| big-doc-write | 6.275 |
| find-and-modify | 4.896 |
| replace-one | 3.986 |
| update-one-upsert | 3.936 |
| find-all | 3.910 |
| aggregate-facet | 3.812 |
| insert-single | 3.756 |
| aggregate-lookup-unwind | 2.216 |
| aggregate-lookup | 2.133 |
| aggregate-add-fields | 1.952 |
| aggregate-multistage | 1.853 |
| aggregate-window | 1.837 |
| aggregate-bucket | 1.450 |
| aggregate-sort | 1.443 |
| aggregate-group | 1.381 |
| find-projection-exclusion | 1.272 |
| explain-find | 1.193 |
| find-in-filter | 1.146 |
| find-projection-sort | 1.136 |
| find-skip-sort-page | 1.033 |
| find-order-limit | 1.004 |
| find-range-limit | 0.441 |
| distinct-command | 0.433 |
| big-doc-read | 0.362 |
| connect | 0.337 |
| count-command | 0.291 |
| transaction-write-read | 0.229 |
| count-window | 0.154 |
| transaction-range | 0.151 |
| aggregate-graph-lookup | 0.104 |
| insert-duplicate-key | 0.076 |
| find-index-equality | 0.060 |
| update-many | 10.528 |
| find-hint-index | 0.045 |
| find-point-uk | 0.034 |
| find-point-pk | 0.025 |
| error-command | 0.018 |
| insert-multi | 13.463 |
| delete-many | 6.348 |
| bulk-insert | 11.010 |
| delete-many-range | 5.213 |
| cursor-paginate | -0.046 |
| getMore-pagination | -0.046 |

## 规模扩展

同一份实现只改集合文档数，3 轮测量 + 1 轮热身，每项 50 次取中位数。
未命中 `delete` 不改数据，因此不含落盘成本，只看查找路径。

| 文档数 | `_id` 单查 ms/op | 唯一索引单查 ms/op | `updateOne` ms/op | 未命中 `delete` ms/op |
|------:|-----------------:|-------------------:|------------------:|----------------------:|
| 200 | 0.065 | 0.078 | 3.854 | 0.063 |
| 1000 | 0.063 | 0.070 | 4.350 | 0.082 |
| 5000 | 0.081 | 0.055 | 7.403 | 0.087 |

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
  不必把每篇文档解析成 `BsonDocument`。`count-command`（非空 query）从整表解析降到 0.343 ms/命令量级。
- **非空 filter 的 `count` / `distinct` 只解码谓词与取值字段**：谓词引用的顶层字段之外按 BSON 长度跳过，
  `$where` / `$expr` 一类无法静态分析的算子自动退回整篇解码；`count` 同时复用 `skip + limit` 早停边界。
  AB 中位数：非空 `count` 约 2.0–2.6 ms → 0.8–0.9 ms，`distinct` 约 1.9–2.7 ms → 1.1–1.8 ms。
- **`findAndModify` 不再整表扫描两遍**：无排序时只读到第一篇命中，唯一键冲突改用已落盘索引项前缀探针，
  与 `update` 同一条路径；事务内或索引条目缺失时仍退回整表 map。AB 中位数约 12.2–14.5 ms → 7.5–9.1 ms。
- **`findAndModify` / `bulkWrite` 回复也走原生 `OP_MSG` 帧**：与 `insert` / `update` / `delete` 一致，
  宿主只读 `ok` 位，不再把应答转成 Extended JSON 再序列化回去。`bulkWrite` 每条操作仍各触发一次整快照落盘，
  所以这项收益被写地板淹没，AB 中位数在噪声内，保留是为了统一写路径的字节语义。
- **`getMore` 增量分页**：无排序、无 `skip` / `limit` 的普通集合扫描不再在 `find` 时物化整个结果集，
  首包只读一页，续扫位置（`after` + filter + projection）留在游标里，`getMore` 按需取下一页。
  抽干整个游标的总解码量不变，因此 `getMore-pagination` / `cursor-paginate` 的每文档中位数持平；
  收益在首包延迟与峰值内存：客户端只读首包时不再为未读文档付费。
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

- 写路径改成追加或增量落盘：单条写命令从 `insert-single` 的 3.808 ms 降到与 `ping` 同量级，约省 3.756 ms/命令；这也是 `updateOne` 与 `big-doc-write` 剩余成本的主体。
- `update` 点读化已落地：修复前每条 `updateOne` 整命名空间扫描匹配并整表建唯一 map，5000 篇下约 43 ms/op（历史捕获，同一脚本旧版数字）；
  现在 7.403 ms/op，剩余增长跟随快照提交随数据量的增长（1000 篇 `insert-single` 地板 3.808 ms/op），不再是匹配扫描。
- 未命中 `delete` 与 `_id` / 唯一索引单查都稳定在 0.087 ms 量级，读路径没有再随规模增长的缺陷。
- 事务视图分页早停已落地：只读事务的 `limit` 查询不再先合并整段视图，AB 中位数从约 0.75 ms/命令降到约 0.29 ms/命令。
- 空查询 `count` 已跳过整表解码：AB 中位数从约 2.06 ms/命令降到约 0.42 ms/命令。
- 非空 filter 的 `count` / `distinct` 已按谓词字段投影解码：AB 中位数 `count` 约 2.0–2.6 → 0.8–0.9 ms，`distinct` 约 1.9–2.7 → 1.1–1.8 ms。
- `findAndModify` 已改为单命中早停 + 索引项探针：AB 中位数约 12.2–14.5 → 7.5–9.1 ms，剩余成本仍是每次更新的整快照提交。
- `getMore` 已改为增量续扫：抽干游标的每文档成本持平，首包之外的文档不再在 `find` 时读入内存。
- `bulkWrite` 的原生帧未带来可测收益：一条混合 6 操作约 70–100 ms，主体是 6 次整快照提交，帧编码占比在噪声内。

## 不计入比值的边界

- 本机没有 `mongod`、也没有 Docker，真实服务端对比列为 CI-only；这里的数字只描述本仓服务端成本。
- 本仓服务端是 TypeScript `net` 监听，每条命令的处理路径不含上游 `database.server::yyds::mongo::service` 的
  监听循环，因此该循环的 `WouldBlock` 睡眠不在本基准的测量范围内。
- 本轮改动在共享开发机上做新旧交替 AB（legacy 与新路径各 3 轮取中位）；表格绝对值取自最后一次完整运行，
  若同时有其他仓的 benchmark 在跑会整体漂移，判断收益以 AB 成对中位为准。

Regenerate: `pnpm --dir projects/mongo.ts/examples/vs-js-libraries benchmark:server`
