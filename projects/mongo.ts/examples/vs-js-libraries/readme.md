# vs-js-libraries

Cross-client conformance and a side-by-side benchmark of the product server
(`@yydb/mongodb`) against the official
[`mongodb`](https://www.npmjs.com/package/mongodb) Node.js driver.

The product exposes a wire-protocol server and a native BSON codec but no
high-level client, so "our side" is a minimal OP_MSG client in
`src/mongo-client.mjs`: one TCP socket, `binding.encodeOpMsg` /
`binding.decodeOpMsg`, and explicit `getMore` cursor draining.

## Prerequisites

- Node.js 20 or newer (tested with Node 24).
- From the repository root: `pnpm install`.
- Build the TypeScript surface used by the examples (`pnpm build:ts`, or the
  full `pnpm build`) and keep a native platform binding in this checkout.
  `binding.js` resolves `@yydb/mongodb-<platform>` when installed and otherwise
  falls back to `projects/mongo.ts/platforms/mongo-<platform>`.
- If a registry platform package shadows the checkout binding, run
  `pnpm install --no-optional` so the fallback path is used.
- The official `mongodb` driver (6.x) is a root devDependency and resolves from
  the repository `node_modules`.

## Layout

- `src/timing.mjs` — hrtime elapsed milliseconds, throughput, and median/p95 via
  the upstream `database.harness` `benchSummary` (native addon export
  `harnessBenchSummary`; no local re-implementation of the statistics)
- `src/mongo-client.mjs` — minimal OP_MSG client over the product native codec
- `tests/conformance.mjs` — both directions, updates, and cursor paging
- `tests/benchmark.mjs` — insert, full find, point find, and update workloads
- `tests/benchmark-server.mjs` — per-command server cost, scaling table and provenance
- `reports/` — captured conformance and benchmark output

## Conformance (`test`)

The official driver and the minimal client share a fresh product server:

1. Write with the official driver, read with the minimal client.
2. Write with the minimal client, read with the official driver.
3. Update through each client and read through the other.
4. Insert 300 documents and drain the minimal client's `getMore` cursor.

Values are normalized because the native codec returns extended JSON (`$numberInt`,
`$numberLong`, and so on); conformance unwraps those wrappers before comparing.

```shell
pnpm --dir projects/mongo.ts/examples/vs-js-libraries test
```

Expected output is captured in [reports/conformance.md](./reports/conformance.md).

## Benchmark (`benchmark`)

Both clients talk to the same product server over loopback. Each measured run
gets a fresh `mkdtemp` data directory and a fresh server; server start/stop,
seeding, and connection setup stay outside the timed region. There is one
untimed warmup round plus the measured rounds.

Workloads:

- `insert-200` — one insert command / `insertMany` of 200 documents.
- `find-all-200` — `find({})` with `batchSize: 250`, all rows materialized.
- `find-point` — 200 awaited point reads by `_id`.
- `update-one` — 200 awaited `updateOne` `$set: {seen: true}` by `_id`.

Fairness settings: the official driver uses `directConnection: true`,
`maxPoolSize: 1`, `retryWrites: false`, `compressors: []`. The minimal client
uses one socket, the native BSON codec, and no retry/pool layer.

Counts are configurable: `BENCH_INSERT`, `BENCH_FIND`, `BENCH_POINT`,
`BENCH_UPDATE` (default 200) and `BENCH_ROUNDS` (default 3).

```shell
pnpm --dir projects/mongo.ts/examples/vs-js-libraries benchmark
```

Results and the ratio table are captured in
[reports/benchmark.md](./reports/benchmark.md).

## Server benchmark (`benchmark:server`)

Server-side cost of each command on the product server alone (no client
comparison). Each measured run gets a fresh `mkdtemp` data directory and a
fresh server; seeding, index creation and `setup` hooks stay outside the timed
region. Median and p95 come from the upstream `database.harness`
`benchSummary` (nearest-rank, golden-vector pinned); the report header also
records node / rustc versions, repo revs, the local path-override state and
the data scale.

Workloads:

- `ping` — round-trip floor (protocol + parse + reply encode).
- `insert-single` — one insert per command.
- `insert-multi` — 200 documents in one insert command.
- `find-all` — full collection scan.
- `find-point-pk` — point read by `_id`.
- `find-point-uk` — point read by a unique secondary index.
- `find-range-limit` — range filter + `limit`.
- `find-order-limit` — `sort` + `limit`.
- `aggregate-group` — single-stage `$group`.
- `aggregate-multistage` — `$match` → `$group` → `$sort` → `$limit` → `$project`.
- `create-index` — build one new secondary index per command.
- `bulk-insert` — 5000 documents in 200-document batches with a unique index.
- `big-doc-write` — 20 × 64 KB documents, one per command.
- `big-doc-read` — point-read the 20 × 64 KB documents.
- `update-many` — multi-update per group.
- `delete-many` — multi-delete per group.
- `connect` — open + close one socket.

Scaling table: `_id` point read, unique-index point read, `updateOne` and
missed `delete` at 200 / 1000 / 5000 documents, to separate constant-cost
from linear-cost paths.

Counts are configurable via `BENCH_*` (see the script header for the full
list).

```shell
pnpm --dir projects/mongo.ts/examples/vs-js-libraries benchmark:server
```

Results and the root-cause analysis are captured in
[reports/benchmark-server.md](./reports/benchmark-server.md).

## Intentional deltas

- The official path includes the driver's JS BSON serialization, connection
  management, and loopback TCP. The minimal path is the product's native BSON
  codec plus raw OP_MSG over one socket.
- Neither path pools connections. The official driver is pinned to
  `maxPoolSize: 1`; the minimal client owns a single socket.
- Both paths use the same product server and storage engine, and both start
  from an empty data directory. Seeding for read/update workloads uses the
  minimal client so the starting documents are identical for both columns.
- Extended JSON is normalized only for conformance assertions; benchmark timings
  use the payloads each client normally decodes.
- `update-one` is dominated by the server's snapshot commit per write command
  (one whole-image `.yykv` write per command); the update match itself is a
  point read by `_id`. Client stack differences are small compared with the
  per-operation server cost.
