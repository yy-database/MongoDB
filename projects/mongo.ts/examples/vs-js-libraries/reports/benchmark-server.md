# 服务端成本基准

Command: `pnpm --dir projects/mongo.ts/examples/vs-js-libraries benchmark:server`
数据集：1000 篇，固定 seed；5 轮测量 + 1 轮热身，取中位数并记 p95。
口径：本仓每轮新起临时数据目录的服务端，灌种子与建索引不计时；`ping` 是协议 + 解析 + 回包编码地板。
真实 mongod：本机未配置（CI-only 列，不伪造真机数字）。

## 按本仓耗时排序

| 工作负载 | 单位 | 本仓 ms/op | 本仓 p95 ms/op | 真机 ms/op | 倍数 |
|---------:|-----:|-----------:|---------------:|-----------:|-----:|
| find-all | commands | 43.364 | 45.859 | CI-only | n/a |
| find-order-limit | commands | 5.521 | 6.184 | CI-only | n/a |
| insert-single | commands | 4.952 | 10.499 | CI-only | n/a |
| aggregate-group | commands | 4.505 | 4.968 | CI-only | n/a |
| find-range-limit | commands | 3.800 | 3.965 | CI-only | n/a |
| find-point-uk | commands | 3.387 | 3.553 | CI-only | n/a |
| connect | connections | 1.024 | 1.267 | CI-only | n/a |
| find-point-pk | commands | 0.233 | 0.267 | CI-only | n/a |
| update-many | rows | 0.197 | 0.208 | CI-only | n/a |
| ping | commands | 0.151 | 0.172 | CI-only | n/a |
| insert-multi | rows | 0.102 | 0.119 | CI-only | n/a |
| delete-many | rows | 0.086 | 0.100 | CI-only | n/a |

## 阶段差分

以 `ping`（0.151 ms/命令）作为传输 + 解析 + 回包编码地板，其余项的额外成本如下。
线上协议不暴露服务端内部分阶段耗时，这里是差分估计，不是插桩测量。
以行为单位的项先按单条命令的行数折算成每命令耗时，再与地板相减。

| 工作负载 | 额外 ms/命令 |
|---------:|-------------:|
| find-all | 43.214 |
| find-order-limit | 5.370 |
| insert-single | 4.802 |
| aggregate-group | 4.354 |
| find-range-limit | 3.649 |
| find-point-uk | 3.237 |
| connect | 0.874 |
| find-point-pk | 0.082 |
| update-many | 19.591 |
| insert-multi | 20.277 |
| delete-many | 8.492 |

## 规模扩展

同一份实现只改集合文档数，3 轮测量 + 1 轮热身，每项 50 次取中位数。
未命中 `delete` 不改数据，因此不含落盘成本，只看查找路径。

| 文档数 | `_id` 单查 ms/op | 唯一索引单查 ms/op | `updateOne` ms/op | 未命中 `delete` ms/op |
|------:|-----------------:|-------------------:|------------------:|----------------------:|
| 200 | 0.217 | 0.721 | 6.540 | 0.193 |
| 1000 | 0.272 | 3.370 | 13.308 | 0.205 |
| 5000 | 0.267 | 16.340 | 59.668 | 0.215 |

## 根因

- **每条写命令一次整快照落盘**：上游 `database.storage::cluster_kv::FileShard::commit_changes` 每次提交都重新编码整份
  `.yykv` 快照、`sync_all` 后原子替换文件。`insert-single` 与 `ping` 的差就是这条写命令的成本地板（见差分表），
  它与集合规模基本无关，而一条命令写 200 篇的 `insert-multi` 摊到每篇约 0.1ms。上游
  `mongo::commands::bulk_write` 逐条调用 `insert` / `update` / `delete`，不合并提交，所以 `bulkWrite` 省不掉这个地板。
- **唯一索引单查随规模线性增长**：`choose_access` 确实把 `sku` 上的唯一索引选为访问路径，但上游
  `database.storage::cluster_kv::collect_scan` 从整张 `BTreeMap` 的第一条开始按命名空间过滤，没有按命名空间建子索引，
  所以每次索引探针都要线性遍历全部记录（文档 + 索引项）。扩展表里 `_id` 单查基本恒定（走 `BTreeMap` 的按键查找），
  唯一索引单查则随文档数增长。
- **`update` 不做索引定位**：上游 `mongo::commands::update` 用 `namespace_documents`（整命名空间 `scan`）匹配，
  既不走索引也不按 `_id` 直取，命中后再整份提交一次快照。扩展表里 `updateOne` 随规模增长就是这个扫描成本。
- **整集合读、排序与聚合是扫描成本**：`find-all` / `find-order-limit` / `aggregate-group` 都要读出并解码全部文档，
  与 1000 篇的规模成正比，这部分属预期内的线性开销，不是缺陷。

## 预计收益（按差分估算）

- 写路径改成追加或增量落盘：单条写命令从 `insert-single` 的 4.952 ms 降到与 `ping` 同量级，约省 4.802 ms/命令。
- 给命名空间建子索引或按键定位：1000 篇下唯一索引单查从 3.370 ms 回到 `_id` 单查（0.272 ms）同量级，约省 3.099 ms/命令；5000 篇下约省 16.073 ms/命令。
- `update` 改为按 `_id` 直取或复用索引访问：1000 篇下单条 update 从 13.308 ms 降到定位加写地板，
  约省 8.356 ms/命令。
- 以上是方向性估算，实际收益取决于上游落盘与索引改造的范围，本仓不改这块实现。

## 不计入比值的边界

- 本机没有 `mongod`、也没有 Docker，真实服务端对比列为 CI-only；这里的数字只描述本仓服务端成本。
- 本仓服务端是 TypeScript `net` 监听，每条命令的处理路径不含上游 `database.server::yyds::mongo::service` 的
  监听循环，因此该循环的 `WouldBlock` 睡眠不在本基准的测量范围内。

Regenerate: `pnpm --dir projects/mongo.ts/examples/vs-js-libraries benchmark:server`
