# Benchmark report

Command: `pnpm --dir projects/mongo.ts/examples/vs-js-libraries benchmark`
Defaults: `BENCH_INSERT=200`, `BENCH_FIND=200`, `BENCH_POINT=200`, `BENCH_UPDATE=200`, `BENCH_PROJECTION=200`, `BENCH_PAGES=200`, `BENCH_GROUP=20`, `BENCH_ROUNDS=3`
Baseline: official `mongodb` driver = `1.00x`
Ratio: subject_time / baseline_time (smaller is faster). Fastest cell in each row is bold.
Setup: 1 untimed warmup round + 3 measured rounds; fresh data directory and server per run; server start/stop and seeding outside the timed region.
Statistics: median over the measured rounds via the upstream `database.harness` `benchSummary` (nearest-rank p95 pinned by golden vectors).

## Workloads

Both columns run the same statement over the same 200-document seed, so each row is a like-for-like
round trip. Every workload asserts its own result inside the timed function: a short read, a leaked
projection field or a wrong group count fails the round instead of recording a fast number.

| Workload | What it drives | Assertion |
|---------:|----------------|-----------|
| insert-200 | one `insertMany` of 200 documents | `insertedCount === 200` |
| find-all-200 | `find {}` with `batchSize 250`, drained | 200 documents |
| find-point | 200 `findOne({_id})` point reads | every read hits |
| update-one | 200 `updateOne({_id}, {$set})` | every update matches |
| find-projection | `find` with `projection {_id:0, sku:1, price:1}`, `sort {price:-1, sku:1}`, `limit 200` | 200 rows, no `name` field, `price` present |
| cursor-paginate | `find {}` with `batchSize 25`, drained through `getMore` pages | 200 documents across 8 pages |
| aggregate-group | `$group` by `category` with `$sum` count and price | one row per category |

## Relative to the official driver

| Workload | mongodb (official) | @yydb/mongodb (OP_MSG) |
|---------:|-------:|-------:|
| insert-200 | 1.00x | **0.90x** |
| find-all-200 | 1.00x | **0.57x** |
| find-point | 1.00x | **0.24x** |
| update-one | 1.00x | **0.59x** |
| find-projection | 1.00x | **0.40x** |
| cursor-paginate | 1.00x | **0.48x** |
| aggregate-group | 1.00x | **0.69x** |

## Absolute results

| Workload | Client | Median round (ms) | ms/op | ops/s |
|---------:|-------|-------:|-------:|-------:|
| insert-200 | mongodb (official) | 16.24 | 0.081 | 12,312/s |
| insert-200 | @yydb/mongodb (OP_MSG) | 14.61 | 0.073 | 13,694/s |
| find-all-200 | mongodb (official) | 3.31 | 0.017 | 60,507/s |
| find-all-200 | @yydb/mongodb (OP_MSG) | 1.87 | 0.009 | 107,003/s |
| find-point | mongodb (official) | 61.71 | 0.309 | 3,241/s |
| find-point | @yydb/mongodb (OP_MSG) | 14.51 | 0.073 | 13,783/s |
| update-one | mongodb (official) | 1420.28 | 7.101 | 141/s |
| update-one | @yydb/mongodb (OP_MSG) | 833.91 | 4.170 | 240/s |
| find-projection | mongodb (official) | 2.31 | 0.012 | 86,636/s |
| find-projection | @yydb/mongodb (OP_MSG) | 0.93 | 0.005 | 214,892/s |
| cursor-paginate | mongodb (official) | 4.03 | 0.020 | 49,650/s |
| cursor-paginate | @yydb/mongodb (OP_MSG) | 1.94 | 0.010 | 102,960/s |
| aggregate-group | mongodb (official) | 16.50 | 0.825 | 1,212/s |
| aggregate-group | @yydb/mongodb (OP_MSG) | 11.45 | 0.573 | 1,746/s |

Measured round totals (ms):

- `insert-200`: official `[16.41, 16.24, 14.88]`, minimal `[15.51, 14.61, 13.72]`
- `find-all-200`: official `[3.83, 3.31, 3.19]`, minimal `[1.52, 2.01, 1.87]`
- `find-point`: official `[62.38, 61.71, 48.46]`, minimal `[14.51, 15.50, 11.25]`
- `update-one`: official `[1420.28, 1365.01, 2071.70]`, minimal `[875.38, 833.91, 822.12]`
- `find-projection`: official `[2.95, 2.26, 2.31]`, minimal `[0.97, 0.93, 0.89]`
- `cursor-paginate`: official `[4.03, 3.89, 4.97]`, minimal `[2.47, 1.94, 1.80]`
- `aggregate-group`: official `[17.92, 16.50, 16.45]`, minimal `[11.45, 12.43, 8.95]`

Provenance: node v24.18.0, addon built from the `mongo` facade with the `_id` point-read update path and the
native `OP_MSG` read-reply path; 200-document collections per workload; see `benchmark-server.mjs` output for
the full rustc/rev/data-scale block.

## Intentional deltas

- Official path = driver (JS BSON serialization, connection management, loopback TCP); minimal path = native BSON codec plus raw OP_MSG over one socket.
- Neither path pools: the official driver runs with `maxPoolSize: 1`, `directConnection: true`, `retryWrites: false`, `compressors: []`; the minimal client owns one socket with no retry layer.
- Both paths use the same product server and storage engine (`.yyds` / `.yykv`), and each measured run starts from a fresh data directory.
- Read and update workloads are seeded with the minimal client before timing, so both columns start from identical documents.
- `cursor-paginate` pages with `batchSize 25` so the round pays 8 `getMore` round trips; `find-all-200` pays the batched path instead.
- `aggregate-group` runs 20 aggregates per round over the 200-document set, so its ms/op is per aggregate command.
- Extended JSON returned by the native codec is normalized only for conformance checks; benchmark timings use normal payload decoding.
- `update-one` per-operation cost is dominated by the server-side snapshot commit floor (one whole-image `.yykv` write per write command); the update match itself is a point read by `_id`. Absolute round totals swing with host load — the official column moved 6.7 → 10.4 ms/op between captures on the same code path, so read the ratio, not the absolute, across captures.

Regenerate: `pnpm --dir projects/mongo.ts/examples/vs-js-libraries benchmark`
