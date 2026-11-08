// Express 5 REST API over the official `mongodb` driver, pointed at the
// product server. `createApp` ensures the category index before returning.
import express from "express";

const DEFAULT_DB = "shop";
const DEFAULT_COLLECTION = "products";

function fail(response, status, message) {
  return response.status(status).json({ error: message });
}

function validateProduct(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "body must be a JSON object" };
  }
  const sku = body.sku ?? body._id;
  if (typeof sku !== "string" || sku.trim() === "") {
    return { error: "sku must be a non-empty string" };
  }
  if (typeof body.name !== "string" || body.name.trim() === "") {
    return { error: "name must be a non-empty string" };
  }
  if (typeof body.category !== "string" || body.category.trim() === "") {
    return { error: "category must be a non-empty string" };
  }
  if (!Number.isFinite(body.price) || body.price < 0) {
    return { error: "price must be a non-negative number" };
  }
  if (!Number.isInteger(body.stock) || body.stock < 0) {
    return { error: "stock must be a non-negative integer" };
  }
  return {
    value: {
      _id: sku,
      name: body.name,
      category: body.category,
      price: body.price,
      stock: body.stock,
    },
  };
}

function parseLimit(raw) {
  if (raw === undefined) return 20;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > 100) return null;
  return value;
}

export async function createApp({ client, dbName = DEFAULT_DB, collectionName = DEFAULT_COLLECTION }) {
  const collection = client.db(dbName).collection(collectionName);
  await collection.createIndex({ category: 1 });

  const app = express();
  app.use(express.json());

  app.get("/health", (request, response) => {
    response.json({ ok: true, service: "mongo-products", database: dbName });
  });

  app.post("/products", async (request, response) => {
    const { value, error } = validateProduct(request.body);
    if (error) return fail(response, 400, error);
    try {
      await collection.insertOne(value);
      return response.status(201).json(value);
    } catch (insertError) {
      if (insertError?.code === 11000) {
        return fail(response, 409, `product ${value._id} already exists`);
      }
      throw insertError;
    }
  });

  app.get("/products", async (request, response) => {
    const limit = parseLimit(request.query.limit);
    if (limit === null) return fail(response, 400, "limit must be an integer between 1 and 100");
    const cursor = request.query.cursor;
    if (cursor !== undefined && typeof cursor !== "string") {
      return fail(response, 400, "cursor must be a string");
    }
    const filter = cursor ? { _id: { $gt: cursor } } : {};
    const rows = await collection.find(filter).sort({ _id: 1 }).limit(limit + 1).toArray();
    const items = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? items[items.length - 1]._id : null;
    return response.json({ items, nextCursor });
  });

  app.get("/products/:sku", async (request, response) => {
    const product = await collection.findOne({ _id: request.params.sku });
    if (!product) return fail(response, 404, `product ${request.params.sku} not found`);
    return response.json(product);
  });

  app.patch("/products/:sku/stock", async (request, response) => {
    const delta = request.body?.delta;
    if (!Number.isFinite(delta)) return fail(response, 400, "delta must be a number");
    const result = await collection.updateOne(
      { _id: request.params.sku },
      { $inc: { stock: delta } },
    );
    if (result.matchedCount === 0) {
      return fail(response, 404, `product ${request.params.sku} not found`);
    }
    const product = await collection.findOne({ _id: request.params.sku });
    return response.json(product);
  });

  app.delete("/products/:sku", async (request, response) => {
    const result = await collection.deleteOne({ _id: request.params.sku });
    if (result.deletedCount === 0) {
      return fail(response, 404, `product ${request.params.sku} not found`);
    }
    return response.status(204).end();
  });

  app.use((error, request, response, next) => {
    if (response.headersSent) return next(error);
    console.error(error);
    return response.status(500).json({ error: "internal server error" });
  });

  return app;
}
