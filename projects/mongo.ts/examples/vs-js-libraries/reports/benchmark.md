# Benchmark report

Command: `pnpm --dir projects/mongo.ts/examples/vs-js-libraries benchmark`
Defaults: `BENCH_INSERT=200`, `BENCH_FIND=200`, `BENCH_POINT=200`, `BENCH_UPDATE=200`, `BENCH_ROUNDS=3`
Baseline: official `mongodb` driver = `1.00x`
Ratio: subject_time / baseline_time (smaller is faster). Fastest cell in each row is bold.
Setup: 1 untimed warmup round + 3 measured rounds; fresh data directory and server per run; server start/stop and seeding outside the timed region.
Statistics: median over the measured rounds via the upstream `database.harness` `benchSummary` (nearest-rank p95 pinned by golden vectors).

## Relative to the official driver

| Workload | mongodb (official) | @yydb/mongodb (OP_MSG) |
|---------:|-------:|-------:|
| insert-200 | 1.00x | **0.86x** |
| find-all-200 | 1.00x | **0.47x** |
| find-point | 1.00x | **0.35x** |
| update-one | 1.00x | **0.52x** |

## Absolute results

| Workload | Client | Median round (ms) | ms/op | ops/s |
|---------:|-------|-------:|-------:|-------:|
| insert-200 | mongodb (official) | 19.21 | 0.096 | 10,410/s |
| insert-200 | @yydb/mongodb (OP_MSG) | 16.43 | 0.082 | 12,173/s |
| find-all-200 | mongodb (official) | 8.56 | 0.043 | 23,369/s |
| find-all-200 | @yydb/mongodb (OP_MSG) | 4.06 | 0.020 | 49,202/s |
| find-point | mongodb (official) | 53.68 | 0.268 | 3,726/s |
| find-point | @yydb/mongodb (OP_MSG) | 18.83 | 0.094 | 10,621/s |
| update-one | mongodb (official) | 2071.11 | 10.356 | 97/s |
| update-one | @yydb/mongodb (OP_MSG) | 1074.09 | 5.370 | 186/s |

Measured round totals (ms):

- `insert-200`: official `[20.82, 18.87, 19.21]`, minimal `[18.70, 16.43, 15.79]`
- `find-all-200`: official `[8.56, 8.88, 5.08]`, minimal `[3.88, 4.06, 4.10]`
- `find-point`: official `[56.71, 53.68, 42.10]`, minimal `[19.97, 18.05, 18.83]`
- `update-one`: official `[2071.11, 2045.33, 2082.24]`, minimal `[1074.09, 1066.71, 1845.04]`

Provenance: node v24.18.0, addon built from the `mongo` facade with the `_id` point-read update path; 200-document collections per workload; see `benchmark-server.mjs` output for the full rustc/rev/data-scale block.

## Intentional deltas

- Official path = driver (JS BSON serialization, connection management, loopback TCP); minimal path = native BSON codec plus raw OP_MSG over one socket.
- Neither path pools: the official driver runs with `maxPoolSize: 1`, `directConnection: true`, `retryWrites: false`, `compressors: []`; the minimal client owns one socket with no retry layer.
- Both paths use the same product server and storage engine (`.yyds` / `.yykv`), and each measured run starts from a fresh data directory.
- Read and update workloads are seeded with the minimal client before timing, so both columns start from identical documents.
- Extended JSON returned by the native codec is normalized only for conformance checks; benchmark timings use normal payload decoding.
- `update-one` per-operation cost is dominated by the server-side snapshot commit floor (one whole-image `.yykv` write per write command); the update match itself is a point read by `_id`. Absolute round totals swing with host load — the official column moved 6.7 → 10.4 ms/op between captures on the same code path, so read the ratio, not the absolute, across captures.

Regenerate: `pnpm --dir projects/mongo.ts/examples/vs-js-libraries benchmark`
