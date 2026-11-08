// 服务端成本基准：只衡量服务端实现本身的每条命令成本，不比较客户端库。
//
// 口径：
// - 固定数据集 1000 篇文档、固定 seed、固定语句集合；
// - 本仓每轮都新起一个临时数据目录的服务端，建表与灌种子不计时；
// - 每项先跑一轮热身，再跑 BENCH_ROUNDS 轮，取中位数并记 p95；
// - `ping` 是协议 + 解析 + 回包编码的地板，其余项的耗时减去它就是该路径的额外成本；
// - 真实 `mongod` 列是可选的：设置 `BENCH_REAL_HOST` / `BENCH_REAL_PORT` 时才测量，
//   连不上直接失败，不降级成自比、不伪造真机数字。本机没有 `mongod`，该列记为 CI-only。
//
// 运行：`pnpm --dir projects/mongo.ts/examples/vs-js-libraries benchmark:server`

import { mkdtemp } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createServer } from "../../../packages/mongo/dist/index.js";
import { numberValue, OpMsgClient } from "../src/mongo-client.mjs";
import { elapsedMs, median, p95 } from "../src/timing.mjs";

const exampleRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const DB = "bench";
const COLLECTION = "items";
const DATASET = Number(process.env.BENCH_DATASET ?? 1_000);
const ROUNDS = Number(process.env.BENCH_ROUNDS ?? 5);
const BATCH = 200;
const SCALE_SIZES = (process.env.BENCH_SCALE_SIZES ?? "200,1000,5000").split(",").map(Number);
const SCALE_OPS = Number(process.env.BENCH_SCALE_OPS ?? 50);
const SCALE_ROUNDS = Number(process.env.BENCH_SCALE_ROUNDS ?? 3);

const REAL = {
  host: process.env.BENCH_REAL_HOST ?? null,
  port: Number(process.env.BENCH_REAL_PORT ?? 27_017),
};

const GROUP_SIZE = Math.floor(DATASET / 10);

/** 固定 seed：`seq` 唯一，`grp` 十组各 `GROUP_SIZE` 篇。 */
function documentOf(index) {
  const suffix = String(index).padStart(5, "0");
  return {
    _id: `sku-${suffix}`,
    sku: `sku-${suffix}`,
    seq: index,
    grp: index % 10,
    price: 100 + (index % 50),
    pad: `payload-${suffix}`,
  };
}

function documents(count) {
  return Array.from({ length: count }, (_, index) => documentOf(index));
}

async function seedCollection(client, count) {
  for (let start = 0; start < count; start += BATCH) {
    const batch = documents(count).slice(start, start + BATCH);
    const reply = await client.insert(DB, COLLECTION, batch);
    if (numberValue(reply.n) !== batch.length) throw new Error(`seed short: ${numberValue(reply.n)}/${batch.length}`);
  }
  const created = await client.command({
    createIndexes: COLLECTION,
    indexes: [{ key: { sku: 1 }, name: "sku_1", unique: true }],
    $db: DB,
  });
  if (numberValue(created.ok) !== 1) throw new Error(`createIndexes failed: ${JSON.stringify(created)}`);
}

async function drain(client, reply) {
  const documents_ = [...(reply.cursor?.firstBatch ?? [])];
  let id = numberValue(reply.cursor?.id);
  while (id !== 0) {
    const more = await client.command({ getMore: id, collection: COLLECTION, $db: DB });
    documents_.push(...(more.cursor?.nextBatch ?? []));
    id = numberValue(more.cursor?.id);
  }
  return documents_;
}

async function aggregateAll(client, pipeline) {
  return drain(client, await client.command({ aggregate: COLLECTION, pipeline, cursor: {}, $db: DB }));
}

function countOf(reply) {
  return numberValue(reply.n);
}

const WORKLOADS = [
  {
    name: "ping",
    unit: "commands",
    ops: Number(process.env.BENCH_PING ?? 200),
    seed: false,
    async run(client, ops) {
      for (let index = 0; index < ops; index += 1) {
        const reply = await client.command({ ping: 1, $db: "admin" });
        if (numberValue(reply.ok) !== 1) throw new Error("ping failed");
      }
      return ops;
    },
  },
  {
    name: "insert-single",
    unit: "commands",
    ops: Number(process.env.BENCH_INSERT ?? 50),
    seed: false,
    async run(client, ops) {
      for (let index = 0; index < ops; index += 1) {
        const reply = await client.insert(DB, COLLECTION, [documentOf(index + DATASET)]);
        if (countOf(reply) !== 1) throw new Error(`insert-single short at ${index}`);
      }
      return ops;
    },
  },
  {
    name: "insert-multi",
    unit: "rows",
    rows: 200,
    rowsPerCommand: 200,
    seed: false,
    async run(client) {
      const batch = documents(200).map((document) => ({ ...document, _id: `multi-${document._id}` }));
      const reply = await client.insert(DB, COLLECTION, batch);
      if (countOf(reply) !== batch.length) throw new Error(`insert-multi short: ${countOf(reply)}`);
      return batch.length;
    },
  },
  {
    name: "find-all",
    unit: "commands",
    ops: Number(process.env.BENCH_FIND ?? 20),
    async run(client, ops) {
      for (let index = 0; index < ops; index += 1) {
        const rows = await client.find(DB, COLLECTION, {}, { batchSize: 250 });
        if (rows.length !== DATASET) throw new Error(`find-all rows=${rows.length}`);
      }
      return ops;
    },
  },
  {
    name: "find-point-pk",
    unit: "commands",
    ops: Number(process.env.BENCH_POINT ?? 100),
    async run(client, ops) {
      for (let index = 0; index < ops; index += 1) {
        const id = documentOf(index % DATASET)._id;
        if (!(await client.findOne(DB, COLLECTION, { _id: id }))) throw new Error(`point-pk miss ${id}`);
      }
      return ops;
    },
  },
  {
    name: "find-point-uk",
    unit: "commands",
    ops: Number(process.env.BENCH_POINT ?? 100),
    async run(client, ops) {
      for (let index = 0; index < ops; index += 1) {
        const sku = documentOf(index % DATASET).sku;
        if (!(await client.findOne(DB, COLLECTION, { sku }))) throw new Error(`point-uk miss ${sku}`);
      }
      return ops;
    },
  },
  {
    name: "find-range-limit",
    unit: "commands",
    ops: Number(process.env.BENCH_RANGE ?? 20),
    async run(client, ops) {
      for (let index = 0; index < ops; index += 1) {
        const from = index * Math.floor((DATASET - 20) / ops);
        const rows = await client.find(
          DB,
          COLLECTION,
          { seq: { $gte: from, $lt: from + 20 } },
          { limit: 20, batchSize: 20 },
        );
        if (rows.length !== 20) throw new Error(`range-limit rows=${rows.length} from=${from}`);
      }
      return ops;
    },
  },
  {
    name: "find-order-limit",
    unit: "commands",
    ops: Number(process.env.BENCH_ORDER ?? 20),
    async run(client, ops) {
      for (let index = 0; index < ops; index += 1) {
        const rows = await client.find(
          DB,
          COLLECTION,
          {},
          { sort: { price: -1, seq: 1 }, limit: 20, batchSize: 20 },
        );
        if (rows.length !== 20) throw new Error(`order-limit rows=${rows.length}`);
      }
      return ops;
    },
  },
  {
    name: "aggregate-group",
    unit: "commands",
    ops: Number(process.env.BENCH_GROUP ?? 10),
    async run(client, ops) {
      for (let index = 0; index < ops; index += 1) {
        const rows = await aggregateAll(client, [
          { $group: { _id: "$grp", n: { $sum: 1 }, total: { $sum: "$price" } } },
        ]);
        if (rows.length !== 10) throw new Error(`group rows=${rows.length}`);
      }
      return ops;
    },
  },
  {
    name: "update-many",
    unit: "rows",
    rows: DATASET,
    rowsPerCommand: GROUP_SIZE,
    async run(client) {
      let matched = 0;
      for (let grp = 0; grp < 10; grp += 1) {
        const reply = await client.command({
          update: COLLECTION,
          updates: [{ q: { grp }, u: { $set: { seen: grp } }, multi: true }],
          $db: DB,
        });
        matched += countOf(reply);
      }
      if (matched !== DATASET) throw new Error(`update-many matched=${matched}`);
      return matched;
    },
  },
  {
    name: "delete-many",
    unit: "rows",
    rows: GROUP_SIZE * 5,
    rowsPerCommand: GROUP_SIZE,
    async run(client) {
      let deleted = 0;
      for (let grp = 0; grp < 5; grp += 1) {
        const reply = await client.command({
          delete: COLLECTION,
          deletes: [{ q: { grp }, limit: 0 }],
          $db: DB,
        });
        deleted += countOf(reply);
      }
      if (deleted !== GROUP_SIZE * 5) throw new Error(`delete-many deleted=${deleted}`);
      return deleted;
    },
  },
  {
    name: "connect",
    unit: "connections",
    ops: Number(process.env.BENCH_CONNECT ?? 20),
    seed: false,
    async connect(port, ops) {
      const samples = [];
      const start = process.hrtime.bigint();
      for (let index = 0; index < ops; index += 1) {
        const client = await OpMsgClient.connect(port);
        client.close();
      }
      samples.push(elapsedMs(start));
      return samples;
    },
  },
];

/** 起一个本仓服务端并返回测量用的连接。 */
async function openOurs() {
  const dataDir = await mkdtemp(join(tmpdir(), "mongo-bench-server-"));
  const server = createServer({ dataDir, port: 0 });
  const { port } = await server.listening;
  const client = await OpMsgClient.connect(port);
  return { port, client, close: async () => {
    client.close();
    await server.close();
  } };
}

async function openReal() {
  const client = await OpMsgClient.connect(REAL.port, REAL.host);
  return { port: REAL.port, client, close: async () => client.close() };
}

async function resetCollection(client, seed) {
  const dropped = await client.command({ drop: COLLECTION, $db: DB });
  if (numberValue(dropped.ok) !== 1 && numberValue(dropped.code) !== 26) {
    throw new Error(`drop failed: ${JSON.stringify(dropped)}`);
  }
  if (seed) await seedCollection(client, DATASET);
}

/** 跑一项：每轮重置集合，热身一轮后记 ROUNDS 轮总耗时。 */
async function measure(workload, engine) {
  const samples = [];
  for (let round = 0; round <= ROUNDS; round += 1) {
    const handle = await engine.open();
    try {
      if (workload.connect) {
        const measured = await workload.connect(handle.port, workload.ops);
        if (round > 0) samples.push(...measured);
        continue;
      }
      await resetCollection(handle.client, workload.seed !== false);
      const start = process.hrtime.bigint();
      const observed = await workload.run(handle.client, workload.ops);
      const elapsed = elapsedMs(start);
      const expected = workload.rows ?? workload.ops;
      if (observed !== expected) throw new Error(`${workload.name}: observed ${observed}, expected ${expected}`);
      if (round > 0) samples.push(elapsed);
    } finally {
      await handle.close();
    }
  }
  const ops = workload.rows ?? workload.ops;
  const total = median(samples);
  return { samples, total, perOp: total / ops, p95: p95(samples) / ops };
}

function format(value) {
  return `${value.toFixed(3)}`;
}

/**
 * 规模扩展：同一份实现只改集合文档数，用来区分「常数成本」与「随规模线性增长」。
 * 每轮都新起服务端并重新灌种子，`_id` 单查、唯一索引单查、单条 update、未命中 delete 各跑 `SCALE_OPS` 次。
 */
async function measureScaling() {
  const results = [];
  for (const size of SCALE_SIZES) {
    const samples = { pointPk: [], pointUk: [], updateOne: [], deleteMiss: [] };
    for (let round = 0; round <= SCALE_ROUNDS; round += 1) {
      const handle = await openOurs();
      try {
        await resetCollection(handle.client, false);
        await seedCollection(handle.client, size);
        const targets = Array.from({ length: SCALE_OPS }, (_, index) => index % size);
        const timed = async (run) => {
          const start = process.hrtime.bigint();
          await run();
          return elapsedMs(start);
        };
        for (const index of targets) {
          await handle.client.updateOne(DB, COLLECTION, { _id: documentOf(index)._id }, { $set: { seen: 0 } });
        }
        const measured = {
          pointPk: await timed(async () => {
            for (const index of targets) {
              if (!(await handle.client.findOne(DB, COLLECTION, { _id: documentOf(index)._id }))) throw new Error("scale pk miss");
            }
          }),
          pointUk: await timed(async () => {
            for (const index of targets) {
              if (!(await handle.client.findOne(DB, COLLECTION, { sku: documentOf(index).sku }))) throw new Error("scale uk miss");
            }
          }),
          updateOne: await timed(async () => {
            for (const index of targets) {
              await handle.client.updateOne(DB, COLLECTION, { _id: documentOf(index)._id }, { $set: { seen: round } });
            }
          }),
          deleteMiss: await timed(async () => {
            for (const index of targets) {
              await handle.client.command({
                delete: COLLECTION,
                deletes: [{ q: { _id: `${documentOf(index)._id}-absent` }, limit: 1 }],
                $db: DB,
              });
            }
          }),
        };
        if (round > 0) {
          for (const [name, value] of Object.entries(measured)) samples[name].push(value);
        }
      } finally {
        await handle.close();
      }
    }
    results.push({
      size,
      pointPk: median(samples.pointPk) / SCALE_OPS,
      pointUk: median(samples.pointUk) / SCALE_OPS,
      updateOne: median(samples.updateOne) / SCALE_OPS,
      deleteMiss: median(samples.deleteMiss) / SCALE_OPS,
    });
  }
  return results;
}

async function main() {
  const ours = { open: openOurs };
  const real = REAL.host ? { open: openReal } : null;

  console.log(`数据集 ${DATASET} 篇，${ROUNDS} 轮测量 + 1 轮热身`);
  console.log(`真实 mongod：${real ? `${REAL.host}:${REAL.port}` : "未配置（CI-only）"}`);

  const rows = [];
  for (const workload of WORKLOADS) {
    const measured = await measure(workload, ours);
    const realMeasured = real ? await measure(workload, real) : null;
    rows.push({ workload, ours: measured, real: realMeasured, ops: workload.rows ?? workload.ops });
    console.log(
      `${workload.name.padEnd(18)} ${format(measured.perOp).padStart(9)} ms/op  p95 ${format(measured.p95).padStart(9)}` +
        (realMeasured ? `  真机 ${format(realMeasured.perOp)} ms/op  ${(measured.perOp / realMeasured.perOp).toFixed(2)}x` : ""),
    );
  }

  const floor = rows.find((row) => row.workload.name === "ping").ours.perOp;
  const sorted = [...rows].sort((a, b) => b.ours.perOp - a.ours.perOp);

  console.log("\n规模扩展：");
  const scaling = await measureScaling();
  for (const row of scaling) {
    console.log(
      `${row.size} 篇  _id ${format(row.pointPk)}  唯一索引 ${format(row.pointUk)}  updateOne ${format(row.updateOne)}  delete-miss ${format(row.deleteMiss)} ms/op`,
    );
  }
  const scale1000 = scaling.find((row) => row.size === 1000) ?? scaling[Math.floor(scaling.length / 2)];

  const lines = [
    "# 服务端成本基准",
    "",
    `Command: \`pnpm --dir projects/mongo.ts/examples/vs-js-libraries benchmark:server\``,
    `数据集：${DATASET} 篇，固定 seed；${ROUNDS} 轮测量 + 1 轮热身，取中位数并记 p95。`,
    `口径：本仓每轮新起临时数据目录的服务端，灌种子与建索引不计时；\`ping\` 是协议 + 解析 + 回包编码地板。`,
    `真实 mongod：${real ? `\`${REAL.host}:${REAL.port}\`` : "本机未配置（CI-only 列，不伪造真机数字）"}。`,
    "",
    "## 按本仓耗时排序",
    "",
    "| 工作负载 | 单位 | 本仓 ms/op | 本仓 p95 ms/op | 真机 ms/op | 倍数 |",
    "|---------:|-----:|-----------:|---------------:|-----------:|-----:|",
    ...sorted.map(
      (row) =>
        `| ${row.workload.name} | ${row.workload.unit} | ${format(row.ours.perOp)} | ${format(row.ours.p95)} | ${
          row.real ? format(row.real.perOp) : "CI-only"
        } | ${row.real ? `${(row.ours.perOp / row.real.perOp).toFixed(2)}x` : "n/a"} |`,
    ),
    "",
    "## 阶段差分",
    "",
    `以 \`ping\`（${format(floor)} ms/命令）作为传输 + 解析 + 回包编码地板，其余项的额外成本如下。`,
    "线上协议不暴露服务端内部分阶段耗时，这里是差分估计，不是插桩测量。",
    "以行为单位的项先按单条命令的行数折算成每命令耗时，再与地板相减。",
    "",
    "| 工作负载 | 额外 ms/命令 |",
    "|---------:|-------------:|",
    ...sorted
      .filter((row) => row.workload.name !== "ping")
      .map((row) => {
        const perCommand =
          row.workload.unit === "rows" ? row.ours.perOp * row.workload.rowsPerCommand : row.ours.perOp;
        return `| ${row.workload.name} | ${format(perCommand - floor)} |`;
      }),
    "",
    "## 规模扩展",
    "",
    `同一份实现只改集合文档数，${SCALE_ROUNDS} 轮测量 + 1 轮热身，每项 ${SCALE_OPS} 次取中位数。`,
    "未命中 `delete` 不改数据，因此不含落盘成本，只看查找路径。",
    "",
    "| 文档数 | `_id` 单查 ms/op | 唯一索引单查 ms/op | `updateOne` ms/op | 未命中 `delete` ms/op |",
    "|------:|-----------------:|-------------------:|------------------:|----------------------:|",
    ...scaling.map(
      (row) =>
        `| ${row.size} | ${format(row.pointPk)} | ${format(row.pointUk)} | ${format(row.updateOne)} | ${format(row.deleteMiss)} |`,
    ),
    "",
    "## 根因",
    "",
    "- **每条写命令一次整快照落盘**：上游 `database.storage::cluster_kv::FileShard::commit_changes` 每次提交都重新编码整份",
    "  `.yykv` 快照、`sync_all` 后原子替换文件。`insert-single` 与 `ping` 的差就是这条写命令的成本地板（见差分表），",
    "  它与集合规模基本无关，而一条命令写 200 篇的 `insert-multi` 摊到每篇约 0.1ms。上游",
    "  `mongo::commands::bulk_write` 逐条调用 `insert` / `update` / `delete`，不合并提交，所以 `bulkWrite` 省不掉这个地板。",
    "- **唯一索引单查随规模线性增长**：`choose_access` 确实把 `sku` 上的唯一索引选为访问路径，但上游",
    "  `database.storage::cluster_kv::collect_scan` 从整张 `BTreeMap` 的第一条开始按命名空间过滤，没有按命名空间建子索引，",
    "  所以每次索引探针都要线性遍历全部记录（文档 + 索引项）。扩展表里 `_id` 单查基本恒定（走 `BTreeMap` 的按键查找），",
    "  唯一索引单查则随文档数增长。",
    "- **`update` 不做索引定位**：上游 `mongo::commands::update` 用 `namespace_documents`（整命名空间 `scan`）匹配，",
    "  既不走索引也不按 `_id` 直取，命中后再整份提交一次快照。扩展表里 `updateOne` 随规模增长就是这个扫描成本。",
    "- **整集合读、排序与聚合是扫描成本**：`find-all` / `find-order-limit` / `aggregate-group` 都要读出并解码全部文档，",
    "  与 1000 篇的规模成正比，这部分属预期内的线性开销，不是缺陷。",
    "",
    "## 预计收益（按差分估算）",
    "",
    `- 写路径改成追加或增量落盘：单条写命令从 \`insert-single\` 的 ${format(
      rows.find((row) => row.workload.name === "insert-single").ours.perOp,
    )} ms 降到与 \`ping\` 同量级，约省 ${format(
      rows.find((row) => row.workload.name === "insert-single").ours.perOp - floor,
    )} ms/命令。`,
    `- 给命名空间建子索引或按键定位：1000 篇下唯一索引单查从 ${format(scale1000.pointUk)} ms 回到 \`_id\` 单查（${format(
      scale1000.pointPk,
    )} ms）同量级，约省 ${format(scale1000.pointUk - scale1000.pointPk)} ms/命令；5000 篇下约省 ${format(
      scaling[scaling.length - 1].pointUk - scaling[scaling.length - 1].pointPk,
    )} ms/命令。`,
    `- \`update\` 改为按 \`_id\` 直取或复用索引访问：1000 篇下单条 update 从 ${format(scale1000.updateOne)} ms 降到定位加写地板，`,
    `  约省 ${format(scale1000.updateOne - (rows.find((row) => row.workload.name === "insert-single").ours.perOp))} ms/命令。`,
    "- 以上是方向性估算，实际收益取决于上游落盘与索引改造的范围，本仓不改这块实现。",
    "",
    "## 不计入比值的边界",
    "",
    "- 本机没有 `mongod`、也没有 Docker，真实服务端对比列为 CI-only；这里的数字只描述本仓服务端成本。",
    "- 本仓服务端是 TypeScript `net` 监听，每条命令的处理路径不含上游 `database.server::yyds::mongo::service` 的",
    "  监听循环，因此该循环的 `WouldBlock` 睡眠不在本基准的测量范围内。",
    "",
    "Regenerate: `pnpm --dir projects/mongo.ts/examples/vs-js-libraries benchmark:server`",
  ];
  writeFileSync(join(exampleRoot, "reports", "benchmark-server.md"), `${lines.join("\n")}\n`, "utf8");
}

await main();
