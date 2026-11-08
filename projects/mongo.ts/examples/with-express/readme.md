# with-express

Express 5 REST API backed by the product server through the official
[`mongodb`](https://www.npmjs.com/package/mongodb) Node.js driver.

## What it demonstrates

- Product CRUD over the real wire protocol, not an in-memory fake.
- `POST /products` validation and duplicate `_id` handling (`E11000`, code 11000).
- `_id` cursor pagination with a look-ahead `nextCursor`.
- `$inc` stock updates and 404 handling for missing products.
- Index creation at startup (`category_1`; `_id_` is the default unique index).

## Prerequisites

- From the repository root: `pnpm install` (Express 5 and the official driver
  are root devDependencies).
- Build the product TypeScript surface (`pnpm build:ts`, or `pnpm build`) and
  keep the native platform binding in this checkout. `binding.js` falls back to
  `projects/mongo.ts/platforms/mongo-<platform>` when no installed platform
  package resolves. If a registry package shadows it, run
  `pnpm install --no-optional`.
- Node.js 20 or newer (tested with Node 24).

## Run against the product server

Terminal 1 starts the product listener (defaults shown by the example):

```shell
node projects/mongo.ts/packages/mongo/bin/serve.mjs --data-dir .tmp/mongo-express --port 27017
```

Terminal 2 starts the API with its default configuration:

```shell
pnpm --dir projects/mongo.ts/examples/with-express start
```

Defaults: `MONGO_URL=mongodb://127.0.0.1:27017/?directConnection=true`,
`MONGO_DB=shop`, `PORT=3000`. Override them in the environment when the server
runs elsewhere. The process closes the HTTP server and then the driver on
`SIGINT` / `SIGTERM`.

## Endpoints

| Method | Path | Body | Success | Errors |
|--------|------|------|---------|--------|
| `GET` | `/health` | – | `200` `{ok:true,...}` | – |
| `POST` | `/products` | `{sku,name,category,price,stock}` | `201` product | `400` validation, `409` duplicate `_id` |
| `GET` | `/products/:sku` | – | `200` product | `404` |
| `GET` | `/products?limit=&cursor=` | – | `200` `{items,nextCursor}` | `400` invalid `limit` |
| `PATCH` | `/products/:sku/stock` | `{delta:number}` | `200` updated product | `400` invalid delta, `404` |
| `DELETE` | `/products/:sku` | – | `204` | `404` |

`limit` defaults to 20 and is capped at 100. `cursor` is the last `_id` from the
previous page; results are ordered by `_id` ascending.

## Test

`tests/api.mjs` starts an in-process product server on port 0, connects the
official driver, listens on port 0, and asserts every status above through
`fetch`:

```shell
pnpm --dir projects/mongo.ts/examples/with-express test
```

## Key files

- `src/app.mjs` — `createApp({ client, dbName, collectionName })`, index
  creation, routes, and error mapping.
- `src/server.mjs` — environment config, driver connection, and graceful
  shutdown.
- `tests/api.mjs` — end-to-end status, validation, pagination, and stock checks.
