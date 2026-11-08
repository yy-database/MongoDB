# with-repository

A small repository layer over the official
[`mongodb`](https://www.npmjs.com/package/mongodb) Node.js driver, pointed at
the product server. It keeps persistence concerns out of route handlers while
using only normal driver calls.

## What it demonstrates

- `insertOne`, `findById`, and `_id` cursor `list({limit, cursor})`.
- `upsert` with a `created` flag derived from `upsertedCount`.
- `updateStock` through `$inc`, returning `null` when no document matches.
- `bulkUpsert` over a list of products with per-document results.
- `lowStock(threshold)` as an aggregation over `$match`, `$sort`, and `$project`.
- Explicit duplicate handling: `insertOne` raises `DuplicateProductError`
  (code `11000`) instead of leaking a driver error.

## Prerequisites

- From the repository root: `pnpm install`.
- Build the product TypeScript surface (`pnpm build:ts`, or `pnpm build`) and
  keep the native platform binding in this checkout. `binding.js` falls back to
  `projects/mongo.ts/platforms/mongo-<platform>` when no installed platform
  package resolves. If a registry package shadows it, run
  `pnpm install --no-optional`.
- Node.js 20 or newer (tested with Node 24).

## Run

Both commands start an in-process product server on port 0 and connect the
official driver, so no external server is required:

```shell
pnpm --dir projects/mongo.ts/examples/with-repository demo
pnpm --dir projects/mongo.ts/examples/with-repository test
```

## Design notes

- The document key is `_id`; callers pass `sku` and the repository maps it to
  `_id`.
- `list` asks for `limit + 1` rows and uses the extra row only to decide whether
  a `nextCursor` exists. The cursor is the last returned `_id`, so pages stay
  stable under inserts with higher `_id` values.
- `upsert` applies `$set` without `_id` because `_id` is immutable; the filter
  supplies the key on insert.
- `bulkUpsert` issues one `updateOne` upsert per product instead of the driver's
  bulk command. That keeps every per-document result attributable and matches
  the product server's supported update path.
- `lowStock` returns only `_id`, `name`, `category`, and `stock`, sorted by
  `stock` ascending.
- `ensureIndexes` creates `category_1`; the unique `_id_` index is created by
  the server.
- `create` is the normal entry point: it builds the collection handle and
  ensures indexes before the repository is used.

## Key files

- `src/product-repository.mjs` — repository class and duplicate error.
- `src/demo.mjs` — short trace of every repository method.
- `tests/repository.mjs` — index, CRUD, pagination, duplicate, upsert, bulk,
  stock, and aggregation assertions.
