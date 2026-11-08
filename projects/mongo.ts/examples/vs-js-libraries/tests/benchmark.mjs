// Side-by-side benchmark of the official `mongodb` driver and the minimal
// OP_MSG client built on the product's native codec. Both talk to the same
// product server over loopback, one socket each, with no retries and no pool.
//
// Run: `pnpm --dir projects/mongo.ts/examples/vs-js-libraries benchmark`
// Env: BENCH_INSERT (200), BENCH_FIND (200), BENCH_POINT (200),
//      BENCH_UPDATE (200), BENCH_ROUNDS (3)
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MongoClient } from "mongodb";

import { createServer } from "../../../packages/mongo/dist/index.js";
import { numberValue, OpMsgClient } from "../src/mongo-client.mjs";
import { elapsedMs, median, throughput } from "../src/timing.mjs";

const DB = "bench";
const COLLECTION = "items";

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

const ROUNDS = envInt("BENCH_ROUNDS", 3);
const WORKLOADS = [
  { name: "insert-200", count: envInt("BENCH_INSERT", 200) },
  { name: "find-all-200", count: envInt("BENCH_FIND", 200) },
  { name: "find-point", count: envInt("BENCH_POINT", 200) },
  { name: "update-one", count: envInt("BENCH_UPDATE", 200) },
];

const CLIENTS = [
  { key: "official", label: "mongodb (official)" },
  { key: "minimal", label: "@yydb/mongodb (OP_MSG)" },
];

function documentId(index) {
  return `sku-${String(index).padStart(4, "0")}`;
}

function makeDocuments(count) {
  return Array.from({ length: count }, (_, index) => ({
    _id: documentId(index),
    sku: documentId(index),
    name: `Product ${index}`,
    category: index % 4 === 0 ? "sale" : "standard",
    price: 100 + (index % 50),
    stock: index % 20,
    tags: ["alpha", "beta", "gamma"],
    note: "benchmark document payload",
  }));
}

async function openClient(kind, port) {
  if (kind === "minimal") return OpMsgClient.connect(port);
  const client = new MongoClient(`mongodb://127.0.0.1:${port}/?directConnection=true`, {
    directConnection: true,
    maxPoolSize: 1,
    retryWrites: false,
    compressors: [],
    serverSelectionTimeoutMS: 5000,
  });
  await client.connect();
  return client;
}

async function seed(port, documents) {
  const seeder = await OpMsgClient.connect(port);
  try {
    await seeder.insert(DB, COLLECTION, documents);
  } finally {
    seeder.close();
  }
}

async function execute(kind, client, workload, documents) {
  const count = documents.length;
  let observed = 0;
  if (kind === "minimal") {
    switch (workload) {
      case "insert-200":
        observed = numberValue((await client.insert(DB, COLLECTION, documents)).n);
        break;
      case "find-all-200":
        observed = (await client.find(DB, COLLECTION, {}, { batchSize: 250 })).length;
        break;
      case "find-point":
        for (const document of documents) {
          if (!(await client.findOne(DB, COLLECTION, { _id: document._id }))) {
            throw new Error(`point read missed ${document._id}`);
          }
          observed += 1;
        }
        break;
      case "update-one":
        for (const document of documents) {
          observed += numberValue(
            (await client.updateOne(DB, COLLECTION, { _id: document._id }, { $set: { seen: true } })).n,
          );
        }
        break;
      default:
        throw new Error(`unknown workload ${workload}`);
    }
  } else {
    const collection = client.db(DB).collection(COLLECTION);
    switch (workload) {
      case "insert-200":
        observed = (await collection.insertMany(documents)).insertedCount;
        break;
      case "find-all-200":
        observed = (await collection.find({}, { batchSize: 250 }).toArray()).length;
        break;
      case "find-point":
        for (const document of documents) {
          if (!(await collection.findOne({ _id: document._id }))) {
            throw new Error(`point read missed ${document._id}`);
          }
          observed += 1;
        }
        break;
      case "update-one":
        for (const document of documents) {
          observed += (await collection.updateOne({ _id: document._id }, { $set: { seen: true } })).matchedCount;
        }
        break;
      default:
        throw new Error(`unknown workload ${workload}`);
    }
  }
  if (observed !== count) throw new Error(`${workload}: observed ${observed}, expected ${count}`);
}

/** One fresh data dir and server; server start/stop and seeding stay outside the timed region. */
async function measure(workload, kind, count) {
  const dataDir = await mkdtemp(join(tmpdir(), "mongo-bench-"));
  const server = createServer({ dataDir, port: 0 });
  const { port } = await server.listening;
  const documents = makeDocuments(count);
  let client = null;
  try {
    client = await openClient(kind, port);
    if (workload !== "insert-200") await seed(port, documents);
    const start = process.hrtime.bigint();
    await execute(kind, client, workload, documents);
    return elapsedMs(start);
  } finally {
    if (client) await client.close();
    await server.close();
  }
}

function formatRatio(value, fastest) {
  const text = Math.abs(value - 1) < 0.005 ? "1.00x" : `${value.toFixed(2)}x`;
  return value === fastest ? `**${text}**` : text;
}

const results = new Map();
for (const workload of WORKLOADS) {
  const samples = { official: [], minimal: [] };
  for (const client of CLIENTS) {
    for (let round = 0; round <= ROUNDS; round += 1) {
      const ms = await measure(workload.name, client.key, workload.count);
      if (round > 0) samples[client.key].push(ms);
    }
  }
  results.set(workload.name, {
    count: workload.count,
    official: median(samples.official),
    minimal: median(samples.minimal),
    samples,
  });
}

console.log("MongoDB workload benchmark");
console.log(`Defaults: BENCH_INSERT=${WORKLOADS[0].count} BENCH_FIND=${WORKLOADS[1].count} BENCH_POINT=${WORKLOADS[2].count} BENCH_UPDATE=${WORKLOADS[3].count} BENCH_ROUNDS=${ROUNDS}`);
console.log("Baseline: mongodb (official driver) = 1.00x");
console.log("Ratio: subject_time / baseline_time (smaller is faster)");
console.log("Setup: 1 untimed warmup round + measured rounds; fresh data dir and server per run");
console.log("");

console.log("| Workload | mongodb (official) | @yydb/mongodb (OP_MSG) |");
console.log("|---------:|-------:|-------:|");
for (const workload of WORKLOADS) {
  const entry = results.get(workload.name);
  const officialRatio = 1;
  const minimalRatio = entry.minimal / entry.official;
  const fastest = Math.min(officialRatio, minimalRatio);
  console.log(
    `| ${workload.name} | ${formatRatio(officialRatio, fastest)} | ${formatRatio(minimalRatio, fastest)} |`,
  );
}
console.log("");

console.log("| Workload | Client | Median round (ms) | ms/op | ops/s |");
console.log("|---------:|-------|-------:|-------:|-------:|");
for (const workload of WORKLOADS) {
  const entry = results.get(workload.name);
  for (const client of CLIENTS) {
    const ms = entry[client.key];
    console.log(
      `| ${workload.name} | ${client.label} | ${ms.toFixed(2)} | ${(ms / entry.count).toFixed(3)} | ${throughput(entry.count, ms)} |`,
    );
  }
}
console.log("");

for (const workload of WORKLOADS) {
  const entry = results.get(workload.name);
  console.log(
    `${workload.name}: official rounds=[${entry.samples.official.map((ms) => ms.toFixed(2)).join(", ")}] minimal rounds=[${entry.samples.minimal.map((ms) => ms.toFixed(2)).join(", ")}]`,
  );
}
