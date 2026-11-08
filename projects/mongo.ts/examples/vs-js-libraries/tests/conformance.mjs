// Cross-client conformance: the official `mongodb` driver and the minimal
// OP_MSG client must read each other's writes and updates on the same product
// server. Values are normalized because the minimal client receives extended
// JSON from the native codec.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MongoClient } from "mongodb";

import { createServer } from "../../../packages/mongo/dist/index.js";
import { numberValue, OpMsgClient, toPlain } from "../src/mongo-client.mjs";

const DB = "conformance";

function byId(documents) {
  return [...documents].sort((a, b) => String(a._id).localeCompare(String(b._id)));
}

function check(label, actual, expected) {
  assert.deepEqual(byId(actual.map(toPlain)), byId(expected.map(toPlain)));
  console.log(`PASS ${label}`);
}

const dir = await mkdtemp(join(tmpdir(), "mongo-conformance-"));
const server = createServer({ dataDir: dir, port: 0 });
const { port } = await server.listening;

const official = new MongoClient(`mongodb://127.0.0.1:${port}/?directConnection=true`, {
  directConnection: true,
  maxPoolSize: 1,
  retryWrites: false,
  compressors: [],
});
await official.connect();
const minimal = await OpMsgClient.connect(port);

try {
  const officialDocuments = [
    { _id: "official-1", n: 1, tags: ["a", "b"], active: true },
    { _id: "official-2", n: 2, tags: ["c"], active: false },
  ];
  await official.db(DB).collection("official_writes").insertMany(officialDocuments);
  const readByMinimal = await minimal.find(DB, "official_writes", {});
  check("official driver writes -> minimal OP_MSG client reads", readByMinimal, officialDocuments);

  const minimalDocuments = [
    { _id: "minimal-1", n: 3, tags: ["d"], active: true },
    { _id: "minimal-2", n: 4, tags: ["e", "f"], active: false },
  ];
  await minimal.insert(DB, "minimal_writes", minimalDocuments);
  const readByOfficial = await official.db(DB).collection("minimal_writes").find({}).toArray();
  check("minimal OP_MSG client writes -> official driver reads", readByOfficial, minimalDocuments);

  await official.db(DB).collection("official_writes").updateOne(
    { _id: "official-1" },
    { $set: { n: 10, seen: true } },
  );
  const afterOfficialUpdate = await minimal.findOne(DB, "official_writes", { _id: "official-1" });
  assert.equal(numberValue(afterOfficialUpdate.n), 10);
  assert.equal(toPlain(afterOfficialUpdate.seen), true);
  console.log("PASS official driver update -> minimal OP_MSG client reads $set fields");

  await minimal.updateOne(
    DB,
    "minimal_writes",
    { _id: "minimal-2" },
    { $set: { n: 20, seen: true } },
  );
  const afterMinimalUpdate = await official.db(DB).collection("minimal_writes").findOne({ _id: "minimal-2" });
  assert.equal(afterMinimalUpdate.n, 20);
  assert.equal(afterMinimalUpdate.seen, true);
  console.log("PASS minimal OP_MSG client update -> official driver reads $set fields");

  const cursorDocuments = Array.from({ length: 300 }, (_, index) => ({ _id: `cursor-${index}`, index }));
  await minimal.insert(DB, "cursor_writes", cursorDocuments);
  const cursorRows = await minimal.find(DB, "cursor_writes", {}, { batchSize: 100 });
  assert.equal(cursorRows.length, cursorDocuments.length);
  console.log("PASS minimal OP_MSG client drains a getMore cursor");

  console.log("PASS 5/5 conformance checks");
} finally {
  minimal.close();
  await official.close();
  await server.close();
}
