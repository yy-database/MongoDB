// Readable trace against an in-process product server.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MongoClient } from "mongodb";

import { createServer } from "../../../packages/mongo/dist/index.js";
import { ProductRepository } from "./product-repository.mjs";

const dir = await mkdtemp(join(tmpdir(), "mongo-repository-demo-"));
const server = createServer({ dataDir: dir, port: 0 });
const { port } = await server.listening;
const client = new MongoClient(`mongodb://127.0.0.1:${port}/?directConnection=true`, {
  maxPoolSize: 1,
  retryWrites: false,
  compressors: [],
});
await client.connect();
const repository = await ProductRepository.create({ client, dbName: "demo" });

try {
  await repository.insertOne({ sku: "sku-1", name: "Desk", category: "furniture", price: 120, stock: 6 });
  await repository.insertOne({ sku: "sku-2", name: "Lamp", category: "lighting", price: 40, stock: 2 });
  await repository.insertOne({ sku: "sku-3", name: "Chair", category: "furniture", price: 80, stock: 0 });
  console.log("insertOne      -> sku-1, sku-2, sku-3");

  console.log("findById       ->", JSON.stringify(await repository.findById("sku-1")));
  console.log("list limit=2   ->", JSON.stringify(await repository.list({ limit: 2 })));
  console.log("upsert new     ->", JSON.stringify(await repository.upsert({ sku: "sku-4", name: "Shelf", category: "storage", price: 60, stock: 9 })));
  console.log("updateStock    ->", JSON.stringify(await repository.updateStock("sku-2", 3)));
  console.log("bulkUpsert     ->", JSON.stringify(await repository.bulkUpsert([
    { sku: "sku-1", name: "Desk", category: "furniture", price: 120, stock: 4 },
    { sku: "sku-5", name: "Stool", category: "furniture", price: 30, stock: 1 },
  ])));
  console.log("lowStock(<5)   ->", (await repository.lowStock(5)).map((product) => `${product._id}:${product.stock}`).join(", "));
  console.log("demo complete");
} finally {
  await client.close();
  await server.close();
}
