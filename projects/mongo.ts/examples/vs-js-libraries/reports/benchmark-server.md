# 服务端成本基准

Command: `pnpm --dir projects/mongo.ts/examples/vs-js-libraries benchmark:server`
数据集：1000 篇，固定 seed；5 轮测量 + 1 轮热身，取中位数并记 p95。
口径：本仓每轮新起临时数据目录的服务端，灌种子、建索引与 setup 不计时；`ping` 是协议 + 解析 + 回包编码地板。
真实 mongod：本机未配置（CI-only 列，不伪造真机数字）。
统计口径：median/p95 走上游 `database.harness` 的 `benchSummary`（nearest-rank，golden vector 钉死），不在脚本里重写算法。

## 溯源

| 项 | 值 |
|----|----|
| node | v24.18.0 |
| rustc | rustc 1.101.0-nightly (1c3a65069 2026-11-02) |
| MongoDB rev | 750e69b |
| facade 钉住的 database.rs rev | ee57adaa0ce12039ad22a80cfee2f4b6cd504ead |
| 本地 path override | 未启用（按钉住的 rev 构建） |
| addon 产物 | 5198848 bytes, mtime 2026-11-14T11:37:12.575Z |
| 数据规模 | 1000 篇 × ~87B；bulk 5000 篇；大文档 20 × 64KB；规模 200,1000,5000 |

## 按本仓耗时排序

| 工作负载 | 单位 | 本仓 ms/op | 本仓 p95 ms/op | 真机 ms/op | 倍数 |
|---------:|-----:|-----------:|---------------:|-----------:|-----:|
| create-index | commands | 16.826 | 18.936 | CI-only | n/a |
| find-all | commands | 10.558 | 10.667 | CI-only | n/a |
| big-doc-write | rows | 6.115 | 12.780 | CI-only | n/a |
| insert-single | commands | 4.218 | 4.229 | CI-only | n/a |
| find-order-limit | commands | 1.896 | 2.818 | CI-only | n/a |
| aggregate-group | commands | 1.699 | 1.862 | CI-only | n/a |
| aggregate-multistage | commands | 1.671 | 2.949 | CI-only | n/a |
| find-range-limit | commands | 1.144 | 1.776 | CI-only | n/a |
| connect | connections | 0.968 | 0.999 | CI-only | n/a |
| big-doc-read | rows | 0.578 | 0.713 | CI-only | n/a |
| update-many | rows | 0.118 | 0.143 | CI-only | n/a |
| delete-many | rows | 0.109 | 0.117 | CI-only | n/a |
| find-point-uk | commands | 0.102 | 0.119 | CI-only | n/a |
| ping | commands | 0.086 | 0.099 | CI-only | n/a |
| bulk-insert | rows | 0.086 | 0.094 | CI-only | n/a |
| find-point-pk | commands | 0.085 | 0.088 | CI-only | n/a |
| insert-multi | rows | 0.055 | 0.063 | CI-only | n/a |

## 阶段差分

以 `ping`（0.086 ms/命令）作为传输 + 解析 + 回包编码地板，其余项的额外成本如下。
线上协议不暴露服务端内部分阶段耗时，这里是差分估计，不是插桩测量。
以行为单位的项先按单条命令的行数折算成每命令耗时，再与地板相减。

| 工作负载 | 额外 ms/命令 |
|---------:|-------------:|
| create-index | 16.739 |
| find-all | 10.472 |
| big-doc-write | 6.028 |
| insert-single | 4.131 |
| find-order-limit | 1.810 |
| aggregate-group | 1.613 |
| aggregate-multistage | 1.584 |
| find-range-limit | 1.058 |
| connect | 0.882 |
| big-doc-read | 0.491 |
| update-many | 11.706 |
| delete-many | 10.806 |
| find-point-uk | 0.016 |
| bulk-insert | 17.089 |
| find-point-pk | -0.002 |
| insert-multi | 10.896 |

## 规模扩展

同一份实现只改集合文档数，3 轮测量 + 1 轮热身，每项 50 次取中位数。
未命中 `delete` 不改数据，因此不含落盘成本，只看查找路径。

| 文档数 | `_id` 单查 ms/op | 唯一索引单查 ms/op | `updateOne` ms/op | 未命中 `delete` ms/op |
|------:|-----------------:|-------------------:|------------------:|----------------------:|
| 200 | 0.152 | 0.123 | 4.199 | 0.076 |
| 1000 | 0.090 | 0.095 | 3.986 | 0.059 |
| 5000 | 0.081 | 0.065 | 6.643 | 0.060 |

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
- **整集合读、排序与聚合是扫描成本**：`find-all` / `find-order-limit` / `aggregate-group` 都要读出并解码全部文档，
  与 1000 篇的规模成正比，这部分属预期内的线性开销，不是缺陷。
- **`create-index` 是两次快照提交加一次全集合回填**：目录写入与索引条目回填各提交一次整份快照，
  摊掉其中一次属于存储层合并提交的改造范围。

## 预计收益（按差分估算）

- 写路径改成追加或增量落盘：单条写命令从 `insert-single` 的 4.218 ms 降到与 `ping` 同量级，约省 4.131 ms/命令；这也是 `updateOne` 与 `big-doc-write` 剩余成本的主体。
- `update` 点读化已落地：修复前每条 `updateOne` 整命名空间扫描匹配并整表建唯一 map，5000 篇下约 43 ms/op（历史捕获，同一脚本旧版数字）；
  现在 6.643 ms/op，剩余增长跟随快照提交随数据量的增长（1000 篇 `insert-single` 地板 4.218 ms/op），不再是匹配扫描。
- 未命中 `delete` 与 `_id` / 唯一索引单查都稳定在 0.060 ms 量级，读路径没有再随规模增长的缺陷。

## 不计入比值的边界

- 本机没有 `mongod`、也没有 Docker，真实服务端对比列为 CI-only；这里的数字只描述本仓服务端成本。
- 本仓服务端是 TypeScript `net` 监听，每条命令的处理路径不含上游 `database.server::yyds::mongo::service` 的
  监听循环，因此该循环的 `WouldBlock` 睡眠不在本基准的测量范围内。

Regenerate: `pnpm --dir projects/mongo.ts/examples/vs-js-libraries benchmark:server`
