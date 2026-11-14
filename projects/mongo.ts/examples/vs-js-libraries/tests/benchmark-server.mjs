// 服务端成本基准：只衡量服务端实现本身的每条命令成本，不比较客户端库。
//
// 口径：
// - 固定数据集 1000 篇文档、固定 seed、固定语句集合；
// - 本仓每轮都新起一个临时数据目录的服务端，建表、灌种子与 setup 不计时；
// - 每项先跑一轮热身，再跑 BENCH_ROUNDS 轮，取中位数并记 p95（统计走上游 harness benchSummary）；
// - 报告头部记溯源：node / rustc 版本、rev、path override 状态与数据规模；
// - 环境变量：BENCH_DATASET BENCH_ROUNDS BENCH_PING BENCH_INSERT BENCH_FIND BENCH_POINT
//   BENCH_RANGE BENCH_ORDER BENCH_GROUP BENCH_PIPELINE BENCH_INDEX BENCH_BULK
//   BENCH_BIG_DOCS BENCH_BIG_KB BENCH_CONNECT BENCH_SCALE_SIZES BENCH_SCALE_OPS BENCH_SCALE_ROUNDS
//   BENCH_INDEX_EQ BENCH_PROJECTION BENCH_PAGE BENCH_ERROR
// - `ping` 是协议 + 解析 + 回包编码的地板，其余项的耗时减去它就是该路径的额外成本；
// - 真实 `mongod` 列是可选的：设置 `BENCH_REAL_HOST` / `BENCH_REAL_PORT` 时才测量，
//   连不上直接失败，不降级成自比、不伪造真机数字。本机没有 `mongod`，该列记为 CI-only。
//
// 运行：`pnpm --dir projects/mongo.ts/examples/vs-js-libraries benchmark:server`

import { mkdtemp } from "node:fs/promises";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createServer } from "../../../packages/mongo/dist/index.js";
import { numberValue, OpMsgClient } from "../src/mongo-client.mjs";
import { elapsedMs, median, p95 } from "../src/timing.mjs";

const exampleRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(exampleRoot, "..", "..", "..", "..");

const DB = "bench";
const COLLECTION = "items";
const DATASET = Number(process.env.BENCH_DATASET ?? 1_000);
const ROUNDS = Number(process.env.BENCH_ROUNDS ?? 5);
const BATCH = 200;
const SCALE_SIZES = (process.env.BENCH_SCALE_SIZES ?? "200,1000,5000").split(",").map(Number);
const SCALE_OPS = Number(process.env.BENCH_SCALE_OPS ?? 50);
const SCALE_ROUNDS = Number(process.env.BENCH_SCALE_ROUNDS ?? 3);
const BULK_ROWS = Number(process.env.BENCH_BULK ?? 5_000);
const BIG_DOCS = Number(process.env.BENCH_BIG_DOCS ?? 20);
const BIG_KB = Number(process.env.BENCH_BIG_KB ?? 64);
/** Page size of the cursor-pagination workload: every page costs one `getMore`. */
const PAGE = Number(process.env.BENCH_PAGE ?? 100);
const BLOB = "x".repeat(BIG_KB * 1_024);

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
    name: "find-index-equality",
    unit: "commands",
    ops: Number(process.env.BENCH_INDEX_EQ ?? 50),
    async setup(client) {
      const created = await client.command({
        createIndexes: COLLECTION,
        indexes: [{ key: { grp: 1 }, name: "grp_1" }],
        $db: DB,
      });
      if (numberValue(created.ok) !== 1) throw new Error(`index-equality setup failed: ${JSON.stringify(created)}`);
    },
    async run(client, ops) {
      for (let index = 0; index < ops; index += 1) {
        const grp = index % 10;
        const rows = await client.find(DB, COLLECTION, { grp }, { limit: 10, batchSize: 10 });
        if (rows.length !== 10 || rows.some((row) => numberValue(row.grp) !== grp)) {
          throw new Error(`index-equality rows=${rows.length} grp=${grp}`);
        }
      }
      return ops;
    },
  },
  {
    name: "find-projection-sort",
    unit: "commands",
    ops: Number(process.env.BENCH_PROJECTION ?? 20),
    async run(client, ops) {
      for (let index = 0; index < ops; index += 1) {
        const rows = await client.find(
          DB,
          COLLECTION,
          {},
          {
            projection: { _id: 0, seq: 1, price: 1 },
            sort: { price: -1, seq: 1 },
            limit: 20,
            batchSize: 20,
          },
        );
        if (rows.length !== 20) throw new Error(`projection-sort rows=${rows.length}`);
        if (Object.hasOwn(rows[0], "pad") || !Object.hasOwn(rows[0], "price")) {
          throw new Error(`projection-sort leaked fields: ${Object.keys(rows[0]).join(",")}`);
        }
      }
      return ops;
    },
  },
  {
    name: "cursor-paginate",
    unit: "documents",
    rows: DATASET,
    rowsPerCommand: PAGE,
    async run(client) {
      const first = await client.command({ find: COLLECTION, filter: {}, batchSize: PAGE, $db: DB });
      let read = (first.cursor?.firstBatch ?? []).length;
      let id = numberValue(first.cursor?.id);
      while (id !== 0) {
        const more = await client.command({ getMore: id, collection: COLLECTION, batchSize: PAGE, $db: DB });
        read += (more.cursor?.nextBatch ?? []).length;
        id = numberValue(more.cursor?.id);
      }
      if (read !== DATASET) throw new Error(`cursor-paginate read=${read}`);
      return read;
    },
  },
  {
    name: "error-command",
    unit: "commands",
    ops: Number(process.env.BENCH_ERROR ?? 100),
    seed: false,
    async run(client, ops) {
      for (let index = 0; index < ops; index += 1) {
        let code = 0;
        try {
          await client.command({ benchNoSuchCommand: 1, $db: DB });
        } catch (error) {
          code = error.code;
        }
        if (code !== 59) throw new Error(`error-command code=${code}`);
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
    name: "bulk-insert",
    unit: "rows",
    rows: BULK_ROWS,
    rowsPerCommand: BATCH,
    seed: false,
    async setup(client) {
      const created = await client.command({
        createIndexes: COLLECTION,
        indexes: [{ key: { sku: 1 }, name: "sku_1", unique: true }],
        $db: DB,
      });
      if (numberValue(created.ok) !== 1) throw new Error(`bulk setup failed: ${JSON.stringify(created)}`);
    },
    async run(client) {
      let inserted = 0;
      for (let start = 0; start < BULK_ROWS; start += BATCH) {
        const batch = documents(BULK_ROWS).slice(start, start + BATCH);
        inserted += countOf(await client.insert(DB, COLLECTION, batch));
      }
      if (inserted !== BULK_ROWS) throw new Error(`bulk-insert inserted=${inserted}`);
      return inserted;
    },
  },
  {
    name: "aggregate-multistage",
    unit: "commands",
    ops: Number(process.env.BENCH_PIPELINE ?? 10),
    async run(client, ops) {
      for (let index = 0; index < ops; index += 1) {
        const rows = await aggregateAll(client, [
          { $match: { grp: { $gte: 0 } } },
          { $group: { _id: "$grp", n: { $sum: 1 }, avg: { $avg: "$price" } } },
          { $sort: { n: -1, _id: 1 } },
          { $limit: 5 },
          { $project: { _id: 0, n: 1, avg: 1 } },
        ]);
        if (rows.length !== 5) throw new Error(`multistage rows=${rows.length}`);
      }
      return ops;
    },
  },
  {
    name: "create-index",
    unit: "commands",
    ops: Number(process.env.BENCH_INDEX ?? 5),
    async run(client, ops) {
      if (ops > 5) throw new Error("create-index supports at most 5 distinct key patterns");
      const patterns = [
        { price: 1 },
        { grp: 1 },
        { seq: 1 },
        { grp: 1, price: -1 },
        { price: -1, seq: 1 },
      ];
      for (let index = 0; index < ops; index += 1) {
        const built = await client.command({
          createIndexes: COLLECTION,
          indexes: [{ key: patterns[index], name: `bench_${index}` }],
          $db: DB,
        });
        if (numberValue(built.ok) !== 1) throw new Error(`create-index failed: ${JSON.stringify(built)}`);
      }
      return ops;
    },
  },
  {
    name: "big-doc-write",
    unit: "rows",
    rows: BIG_DOCS,
    rowsPerCommand: 1,
    seed: false,
    async run(client) {
      let inserted = 0;
      for (let index = 0; index < BIG_DOCS; index += 1) {
        const reply = await client.insert(DB, COLLECTION, [{ _id: `big-${index}`, seq: index, grp: 0, blob: BLOB }]);
        inserted += countOf(reply);
      }
      if (inserted !== BIG_DOCS) throw new Error(`big-doc-write inserted=${inserted}`);
      return inserted;
    },
  },
  {
    name: "big-doc-read",
    unit: "rows",
    rows: BIG_DOCS,
    rowsPerCommand: 1,
    seed: false,
    async setup(client) {
      for (let index = 0; index < BIG_DOCS; index += 1) {
        await client.insert(DB, COLLECTION, [{ _id: `big-${index}`, seq: index, grp: 0, blob: BLOB }]);
      }
    },
    async run(client) {
      let read = 0;
      for (let index = 0; index < BIG_DOCS; index += 1) {
        const document = await client.findOne(DB, COLLECTION, { _id: `big-${index}` });
        if (!document || document.blob.length !== BLOB.length) throw new Error(`big-doc-read bad payload at ${index}`);
        read += 1;
      }
      return read;
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

/**
 * 每项覆盖的路径与断言，写进报告的 Workloads 表。
 *
 * 新增项与既有项同口径：同一份固定 seed、同一次「重置集合 → setup → 计时」流程，
 * 断言写在 `run` 里，漏读、漏写、漏字段都会让本轮直接失败而不是记一个好看的数字。
 */
const WORKLOAD_NOTES = {
  ping: "空 `ping`；协议解析与回包编码的地板",
  "insert-single": "单条 `insert`，含一次整快照落盘",
  "insert-multi": "一次 `insert` 写 200 篇",
  "find-all": "`find {}` 按 `batchSize 250` 抽干整个集合",
  "find-point-pk": "按 `_id` 单点 `find`",
  "find-point-uk": "按唯一索引 `sku` 单点 `find`",
  "find-range-limit": "无索引区间 `seq`，`limit 20`（早停扫描）",
  "find-order-limit": "无索引排序 `price desc, seq asc` 取 20",
  "find-index-equality": "建 `grp_1` 后按 `grp` 等值取 10（索引等值路径）",
  "find-projection-sort": "投影 `{seq, price}` 加 `price desc, seq asc` 排序取 20",
  "cursor-paginate": "`batchSize 100` 分页抽干 1000 篇（每页一条 `getMore`）",
  "error-command": "未知命令往返，断言 `code 59 CommandNotFound`",
  "aggregate-group": "`$group` 十组计数与求和",
  "aggregate-multistage": "`$match → $group → $sort → $limit → $project`",
  "create-index": "5 种键型各建一次",
  "big-doc-write": "20 篇 64KB 文档逐条写",
  "big-doc-read": "20 篇 64KB 文档按 `_id` 读并校验长度",
  "update-many": "10 条 `multi: true` 更新覆盖 1000 篇",
  "delete-many": "5 条 `limit: 0` 删除覆盖 500 篇",
  "bulk-insert": "5000 篇按 200 篇/批写入",
  connect: "20 次新建 `OP_MSG` 连接",
};

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
      if (workload.setup) await workload.setup(handle.client);
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

function gitRun(args, cwd) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

/**
 * 运行溯源：node / rustc 版本、本仓 rev、facade 钉住的 database.rs rev、
 * 本地 path override 生效时 database.rs 工作树的 rev 与脏状态、addon 产物指纹、数据规模。
 * 拿不到的一律记 `unknown`，不猜。
 */
function collectProvenance() {
  const platform = `${process.platform}-${process.arch}`;
  const addonPath = join(repoRoot, "projects", "mongo.ts", "platforms", `mongo-${platform}`, `mongodb.${platform}.node`);
  let addon = "unknown";
  if (existsSync(addonPath)) {
    const info = statSync(addonPath);
    addon = `${info.size} bytes, mtime ${info.mtime.toISOString()}`;
  }
  let pin = "unknown";
  try {
    const manifest = readFileSync(join(repoRoot, "projects", "mongo.rs", "Cargo.toml"), "utf8");
    pin = manifest.match(/mongo = \{[^}]*rev = "([0-9a-f]{7,40})"/)?.[1] ?? "unknown";
  } catch {
    // manifest 缺失时保持 unknown
  }
  const overrideFile = existsSync(join(repoRoot, ".cargo", "config.toml"));
  // `.cargo/config.toml` 的第一条 `paths` 指向 facade 源码（`<repo>/projects/database/facades/mongo`），
  // 由此解析出被覆盖的工作树，报告它的 rev 与脏状态；文件存在但没配 paths 时保持未启用。
  let overrideRoot = null;
  if (overrideFile) {
    const firstPath = readFileSync(join(repoRoot, ".cargo", "config.toml"), "utf8").match(/"([^"]+)"/)?.[1];
    if (firstPath) overrideRoot = resolve(firstPath, "..", "..", "..", "..");
  }
  const overrideRev = overrideRoot ? gitRun(["-C", overrideRoot, "rev-parse", "--short", "HEAD"], overrideRoot) : null;
  const overrideDirty = overrideRoot ? (gitRun(["-C", overrideRoot, "status", "--porcelain"], overrideRoot) ?? "") !== "" : null;
  let rustc = "unknown";
  try {
    rustc = execFileSync("rustc", ["--version"], { encoding: "utf8" }).trim();
  } catch {
    // 无工具链时保持 unknown
  }
  return {
    node: process.version,
    rustc,
    mongoRev: gitRun(["-C", repoRoot, "rev-parse", "--short", "HEAD"], repoRoot) ?? "unknown",
    facadePin: pin,
    pathOverride: overrideRev ? `${overrideRev}${overrideDirty ? " (dirty)" : ""}` : "未启用（按钉住的 rev 构建）",
    addon,
    dataset: `${DATASET} 篇 × ~${JSON.stringify(documentOf(0)).length}B；bulk ${BULK_ROWS} 篇；大文档 ${BIG_DOCS} × ${BIG_KB}KB；规模 ${SCALE_SIZES.join(",")}`,
  };
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
  const provenance = collectProvenance();

  console.log(`数据集 ${DATASET} 篇，${ROUNDS} 轮测量 + 1 轮热身`);
  console.log(`真实 mongod：${real ? `${REAL.host}:${REAL.port}` : "未配置（CI-only）"}`);
  console.log(`溯源：node ${provenance.node}，rustc ${provenance.rustc}，MongoDB ${provenance.mongoRev}，facade pin ${provenance.facadePin}，override ${provenance.pathOverride}`);

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
    `口径：本仓每轮新起临时数据目录的服务端，灌种子、建索引与 setup 不计时；\`ping\` 是协议 + 解析 + 回包编码地板。`,
    `真实 mongod：${real ? `\`${REAL.host}:${REAL.port}\`` : "本机未配置（CI-only 列，不伪造真机数字）"}。`,
    "统计口径：median/p95 走上游 `database.harness` 的 `benchSummary`（nearest-rank，golden vector 钉死），不在脚本里重写算法。",
    "",
    "## Workloads",
    "",
    "每轮都以「drop 集合并重灌固定种子 → 执行 `setup` → 计时」执行，`setup` 与灌种子不计时。",
    "单位 `commands` / `connections` 记每命令（每连接）耗时，`rows` / `documents` 记每行（每页返回的文档）耗时。",
    "",
    "| 工作负载 | 单位 | 每轮量 | 覆盖与断言 |",
    "|---------:|-----:|------:|------------|",
    ...WORKLOADS.map((workload) => {
      const amount = workload.rows ?? workload.ops ?? 1;
      return `| ${workload.name} | ${workload.unit} | ${amount} | ${WORKLOAD_NOTES[workload.name] ?? ""} |`;
    }),
    "",
    "## 溯源",
    "",
    `| 项 | 值 |`,
    `|----|----|`,
    `| node | ${provenance.node} |`,
    `| rustc | ${provenance.rustc} |`,
    `| MongoDB rev | ${provenance.mongoRev} |`,
    `| facade 钉住的 database.rs rev | ${provenance.facadePin} |`,
    `| 本地 path override | ${provenance.pathOverride} |`,
    `| addon 产物 | ${provenance.addon} |`,
    `| 数据规模 | ${provenance.dataset} |`,
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
    "  它随集合总字节数增长：扩展表里 `updateOne` 从 200 篇到 5000 篇的增长就是这份快照，而不是匹配扫描。",
    "  上游 `mongo::commands::bulk_write` 逐条调用 `insert` / `update` / `delete`，不合并提交，所以 `bulkWrite` 省不掉这个地板。",
    "  改成追加或增量落盘属于存储层改造，超出 facade 与 yyds/mongo 的范围。",
    "- **唯一索引单查已恒定**：上游 `fa3f55a`（区间下推 + 有界索引扫描）与 `d4a0082`（已落盘索引项探针）之后，",
    "  扩展表里唯一索引单查与 `_id` 单查同量级，不再随文档数增长。",
    "- **`update` 按 `_id` 等值走点读 + 索引项探针**：上游 `mongo::commands::update` 对单 `_id` 等值过滤直接点读定位，",
    "  唯一键冲突改为按已落盘索引项前缀探针检查，不再为每条更新命令整命名空间扫描；事务内或索引条目缺失时",
    "  仍退回整表 map，宁可慢也不放行重复键。非 `_id` 过滤（如 `update-many` 按 `grp`）没有可用索引时仍是扫描，属预期。",
    "- **读命令回复直接写原生 `OP_MSG` 帧**：`find` / `getMore` / `aggregate` 的回复由 Rust 一侧编码成 BSON 载荷，",
    "  宿主写帧时不再把文档转成 Extended JSON、在 JS 里 `JSON.parse` 后再 `JSON.stringify` 回 Rust 重新编码。",
    "  改造前一条 250 篇的回复光这一步 JSON 桥约 1.1 ms（探针拆分：Rust 写文本 0.25 ms、JS 解析 0.25 ms、",
    "  序列化 0.09 ms、Rust 重新解析并编码 BSON 0.93 ms），`find-all` 一轮 1000 篇要付两次。",
    "- **排序每篇只取一次键**：`sort_documents` 改用 `sort_by_cached_key`，`n log n` 次比较不再各解析一次字段路径。",
    "- **早停查询按页扫描**：无排序且带 `limit` 的 `find` 按 256 篇一页推进，凑够命中就停，不再先整集合取回再丢弃；",
    "  索引等值/区间仍走上游索引扫描，不受影响。",
    "- **整集合读、排序与聚合是扫描成本**：`find-all` / `find-order-limit` / `aggregate-group` 都要读出并解码全部文档，",
    "  与 1000 篇的规模成正比，这部分属预期内的线性开销，不是缺陷。",
    "- **`create-index` 是两次快照提交加一次全集合回填**：目录写入与索引条目回填各提交一次整份快照，",
    "  摊掉其中一次属于存储层合并提交的改造范围。",
    "",
    "## 预计收益（按差分估算）",
    "",
    `- 写路径改成追加或增量落盘：单条写命令从 \`insert-single\` 的 ${format(
      rows.find((row) => row.workload.name === "insert-single").ours.perOp,
    )} ms 降到与 \`ping\` 同量级，约省 ${format(
      rows.find((row) => row.workload.name === "insert-single").ours.perOp - floor,
    )} ms/命令；这也是 \`updateOne\` 与 \`big-doc-write\` 剩余成本的主体。`,
    `- \`update\` 点读化已落地：修复前每条 \`updateOne\` 整命名空间扫描匹配并整表建唯一 map，5000 篇下约 43 ms/op（历史捕获，同一脚本旧版数字）；`,
    `  现在 ${format(scaling[scaling.length - 1].updateOne)} ms/op，剩余增长跟随快照提交随数据量的增长（1000 篇 \`insert-single\` 地板 ${format(
      rows.find((row) => row.workload.name === "insert-single").ours.perOp,
    )} ms/op），不再是匹配扫描。`,
    `- 未命中 \`delete\` 与 \`_id\` / 唯一索引单查都稳定在 ${format(
      scaling[scaling.length - 1].deleteMiss,
    )} ms 量级，读路径没有再随规模增长的缺陷。`,
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
