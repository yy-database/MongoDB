// Repository layer over the official `mongodb` driver, pointed at the product
// server. Cursor pagination is `_id` based; duplicate inserts surface as
// `DuplicateProductError`.
export class DuplicateProductError extends Error {
  constructor(sku, cause) {
    super(`product ${sku} already exists`);
    this.name = "DuplicateProductError";
    this.code = 11000;
    this.sku = sku;
    this.cause = cause;
  }
}

function documentFrom(product) {
  const sku = product?.sku ?? product?._id;
  if (typeof sku !== "string" || sku.trim() === "") {
    throw new TypeError("product.sku must be a non-empty string");
  }
  const { sku: ignored, ...fields } = product;
  return { _id: sku, ...fields };
}

export class ProductRepository {
  constructor(collection) {
    this.collection = collection;
  }

  static async create({ client, dbName = "shop", collectionName = "products" }) {
    const repository = new ProductRepository(client.db(dbName).collection(collectionName));
    await repository.ensureIndexes();
    return repository;
  }

  async ensureIndexes() {
    await this.collection.createIndex({ category: 1 });
  }

  async insertOne(product) {
    const document = documentFrom(product);
    try {
      await this.collection.insertOne(document);
    } catch (error) {
      if (error?.code === 11000) throw new DuplicateProductError(document._id, error);
      throw error;
    }
    return document;
  }

  async findById(sku) {
    return this.collection.findOne({ _id: sku });
  }

  async list({ limit = 20, cursor = null } = {}) {
    if (!Number.isInteger(limit) || limit <= 0 || limit > 100) {
      throw new RangeError("limit must be an integer between 1 and 100");
    }
    const filter = cursor === null ? {} : { _id: { $gt: cursor } };
    const rows = await this.collection.find(filter).sort({ _id: 1 }).limit(limit + 1).toArray();
    const items = rows.slice(0, limit);
    return {
      items,
      nextCursor: rows.length > limit ? items[items.length - 1]._id : null,
    };
  }

  async upsert(product) {
    const document = documentFrom(product);
    const { _id, ...fields } = document;
    const result = await this.collection.updateOne({ _id }, { $set: fields }, { upsert: true });
    return { ...document, created: result.upsertedCount > 0 };
  }

  async updateStock(sku, delta) {
    if (!Number.isFinite(delta)) throw new TypeError("delta must be a number");
    const result = await this.collection.updateOne({ _id: sku }, { $inc: { stock: delta } });
    if (result.matchedCount === 0) return null;
    return this.findById(sku);
  }

  async bulkUpsert(products) {
    let matchedCount = 0;
    let upsertedCount = 0;
    for (const product of products) {
      const document = documentFrom(product);
      const { _id, ...fields } = document;
      const result = await this.collection.updateOne({ _id }, { $set: fields }, { upsert: true });
      matchedCount += result.matchedCount;
      upsertedCount += result.upsertedCount;
    }
    return { matchedCount, upsertedCount, total: products.length };
  }

  async lowStock(threshold) {
    if (!Number.isFinite(threshold)) throw new TypeError("threshold must be a number");
    return this.collection
      .aggregate([
        { $match: { stock: { $lt: threshold } } },
        { $sort: { stock: 1 } },
        { $project: { _id: 1, name: 1, category: 1, stock: 1 } },
      ])
      .toArray();
  }
}
