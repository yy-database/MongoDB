// End-to-end API test: in-process product server, official driver, Express on port 0.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MongoClient } from "mongodb";

import { createServer } from "../../../packages/mongo/dist/index.js";
import { createApp } from "../src/app.mjs";

const DIR = await mkdtemp(join(tmpdir(), "mongo-express-"));
const server = createServer({ dataDir: DIR, port: 0 });
const { port } = await server.listening;

const client = new MongoClient(`mongodb://127.0.0.1:${port}/?directConnection=true`, {
  maxPoolSize: 1,
  retryWrites: false,
  compressors: [],
});
await client.connect();
const app = await createApp({ client, dbName: "shop" });
const httpServer = app.listen(0);
const base = `http://127.0.0.1:${httpServer.address().port}`;

async function call(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  if (text.length > 0) {
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
  }
  return { status: response.status, json };
}

try {
  const indexes = await client.db("shop").collection("products").indexes();
  assert(indexes.some((index) => index.name === "category_1"));
  console.log("PASS createApp creates the category index");

  const health = await call("GET", "/health");
  assert.equal(health.status, 200);
  assert.equal(health.json.ok, true);
  console.log("PASS GET /health");

  const created = await call("POST", "/products", {
    sku: "sku-1",
    name: "Desk",
    category: "furniture",
    price: 120,
    stock: 5,
  });
  assert.equal(created.status, 201);
  assert.equal(created.json._id, "sku-1");
  console.log("PASS POST /products creates a product");

  const duplicate = await call("POST", "/products", {
    sku: "sku-1",
    name: "Desk",
    category: "furniture",
    price: 120,
    stock: 5,
  });
  assert.equal(duplicate.status, 409);
  console.log("PASS POST /products duplicate _id -> 409");

  const invalid = await call("POST", "/products", { sku: "", name: "Desk", category: "furniture", price: 120, stock: 5 });
  assert.equal(invalid.status, 400);
  const invalidStock = await call("POST", "/products", { sku: "sku-zero", name: "Desk", category: "furniture", price: 120, stock: -1 });
  assert.equal(invalidStock.status, 400);
  console.log("PASS POST /products validation -> 400");

  const fetched = await call("GET", "/products/sku-1");
  assert.equal(fetched.status, 200);
  assert.equal(fetched.json.name, "Desk");
  const missing = await call("GET", "/products/missing");
  assert.equal(missing.status, 404);
  console.log("PASS GET /products/:sku -> 200/404");

  await call("POST", "/products", { sku: "sku-2", name: "Lamp", category: "lighting", price: 40, stock: 12 });
  await call("POST", "/products", { sku: "sku-3", name: "Chair", category: "furniture", price: 80, stock: 3 });

  const pageOne = await call("GET", "/products?limit=2");
  assert.equal(pageOne.status, 200);
  assert.deepEqual(pageOne.json.items.map((item) => item._id), ["sku-1", "sku-2"]);
  assert.equal(pageOne.json.nextCursor, "sku-2");

  const pageTwo = await call("GET", `/products?limit=2&cursor=${pageOne.json.nextCursor}`);
  assert.deepEqual(pageTwo.json.items.map((item) => item._id), ["sku-3"]);
  assert.equal(pageTwo.json.nextCursor, null);
  console.log("PASS GET /products paginates by _id cursor");

  const stock = await call("PATCH", "/products/sku-1/stock", { delta: 5 });
  assert.equal(stock.status, 200);
  assert.equal(stock.json.stock, 10);
  const stockMissing = await call("PATCH", "/products/missing/stock", { delta: 1 });
  assert.equal(stockMissing.status, 404);
  const stockInvalid = await call("PATCH", "/products/sku-1/stock", { delta: "five" });
  assert.equal(stockInvalid.status, 400);
  console.log("PASS PATCH /products/:sku/stock -> 200/404/400");

  const deleted = await call("DELETE", "/products/sku-3");
  assert.equal(deleted.status, 204);
  const deletedAgain = await call("DELETE", "/products/sku-3");
  assert.equal(deletedAgain.status, 404);
  console.log("PASS DELETE /products/:sku -> 204/404");

  console.log("PASS 9/9 API checks");
} finally {
  httpServer.closeAllConnections();
  await new Promise((resolve) => httpServer.close(resolve));
  await client.close();
  await server.close();
}
