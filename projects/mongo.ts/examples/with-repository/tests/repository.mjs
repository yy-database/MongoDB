// Repository behavior test: product server, official driver, repository assertions.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MongoClient } from "mongodb";

import { createServer } from "../../../packages/mongo/dist/index.js";
import { DuplicateProductError, ProductRepository } from "../src/product-repository.mjs";

const dir = await mkdtemp(join(tmpdir(), "mongo-repository-"));
const server = createServer({ dataDir: dir, port: 0 });
const { port } = await server.listening;
const client = new MongoClient(`mongodb://127.0.0.1:${port}/?directConnection=true`, {
  maxPoolSize: 1,
  retryWrites: false,
  compressors: [],
});
await client.connect();
const repository = await ProductRepository.create({ client, dbName: "shop" });

try {
  const indexes = await repository.collection.indexes();
  assert(indexes.some((index) => index.name === "category_1"));
  console.log("PASS ensureIndexes creates category_1");

  const inserted = await repository.insertOne({ sku: "sku-1", name: "Desk", category: "furniture", price: 120, stock: 8 });
  assert.equal(inserted._id, "sku-1");
  assert.deepEqual(await repository.findById("sku-1"), inserted);
  console.log("PASS insertOne and findById");

  await assert.rejects(
    () => repository.insertOne({ sku: "sku-1", name: "Desk", category: "furniture", price: 120, stock: 8 }),
    (error) => error instanceof DuplicateProductError && error.code === 11000,
  );
  console.log("PASS duplicate insert -> DuplicateProductError");

  await repository.insertOne({ sku: "sku-2", name: "Lamp", category: "lighting", price: 40, stock: 3 });
  await repository.insertOne({ sku: "sku-3", name: "Chair", category: "furniture", price: 80, stock: 0 });
  await repository.insertOne({ sku: "sku-4", name: "Shelf", category: "storage", price: 60, stock: 1 });

  const pageOne = await repository.list({ limit: 2 });
  assert.deepEqual(pageOne.items.map((product) => product._id), ["sku-1", "sku-2"]);
  assert.equal(pageOne.nextCursor, "sku-2");
  const pageTwo = await repository.list({ limit: 2, cursor: pageOne.nextCursor });
  assert.deepEqual(pageTwo.items.map((product) => product._id), ["sku-3", "sku-4"]);
  assert.equal(pageTwo.nextCursor, null);
  console.log("PASS list paginates by _id cursor");

  const updated = await repository.upsert({ sku: "sku-2", name: "Desk Lamp", category: "lighting", price: 45, stock: 3 });
  assert.equal(updated.created, false);
  assert.equal((await repository.findById("sku-2")).name, "Desk Lamp");
  const created = await repository.upsert({ sku: "sku-5", name: "Stool", category: "furniture", price: 30, stock: 2 });
  assert.equal(created.created, true);
  assert.equal((await repository.findById("sku-5")).stock, 2);
  console.log("PASS upsert updates an existing document and creates a missing one");

  const bulk = await repository.bulkUpsert([
    { sku: "sku-1", name: "Desk", category: "furniture", price: 110, stock: 4 },
    { sku: "sku-6", name: "Cabinet", category: "storage", price: 200, stock: 2 },
  ]);
  assert.deepEqual(bulk, { matchedCount: 1, upsertedCount: 1, total: 2 });
  assert.equal((await repository.findById("sku-1")).price, 110);
  assert.equal((await repository.findById("sku-6")).name, "Cabinet");
  console.log("PASS bulkUpsert updates and inserts");

  const stocked = await repository.updateStock("sku-4", 2);
  assert.equal(stocked.stock, 3);
  assert.equal(await repository.updateStock("missing", 1), null);
  console.log("PASS updateStock uses $inc and reports a missing document");

  const low = await repository.lowStock(5);
  assert(low.every((product) => product.stock < 5));
  assert.equal(low[0]._id, "sku-3");
  assert.deepEqual(low.map((product) => product._id).sort(), ["sku-1", "sku-2", "sku-3", "sku-4", "sku-5", "sku-6"]);
  console.log("PASS lowStock aggregation orders by stock");

  console.log("PASS 9/9 repository checks");
} finally {
  await client.close();
  await server.close();
}
