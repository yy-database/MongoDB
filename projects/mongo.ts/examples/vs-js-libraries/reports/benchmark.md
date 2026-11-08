# Benchmark report

Command: `pnpm --dir projects/mongo.ts/examples/vs-js-libraries benchmark`
Defaults: `BENCH_INSERT=200`, `BENCH_FIND=200`, `BENCH_POINT=200`, `BENCH_UPDATE=200`, `BENCH_ROUNDS=3`
Baseline: official `mongodb` driver = `1.00x`
Ratio: subject_time / baseline_time (smaller is faster). Fastest cell in each row is bold.
Setup: 1 untimed warmup round + 3 measured rounds; fresh data directory and server per run; server start/stop and seeding outside the timed region.

## Relative to the official driver

| Workload | mongodb (official) | @yydb/mongodb (OP_MSG) |
|---------:|-------:|-------:|
| insert-200 | 1.00x | **0.86x** |
| find-all-200 | 1.00x | **0.72x** |
| find-point | 1.00x | **0.40x** |
| update-one | 1.00x | **0.94x** |

## Absolute results

| Workload | Client | Median round (ms) | ms/op | ops/s |
|---------:|-------|-------:|-------:|-------:|
| insert-200 | mongodb (official) | 18.20 | 0.091 | 10,991/s |
| insert-200 | @yydb/mongodb (OP_MSG) | 15.70 | 0.079 | 12,736/s |
| find-all-200 | mongodb (official) | 7.20 | 0.036 | 27,762/s |
| find-all-200 | @yydb/mongodb (OP_MSG) | 5.17 | 0.026 | 38,655/s |
| find-point | mongodb (official) | 59.02 | 0.295 | 3,389/s |
| find-point | @yydb/mongodb (OP_MSG) | 23.77 | 0.119 | 8,412/s |
| update-one | mongodb (official) | 1368.71 | 6.844 | 146/s |
| update-one | @yydb/mongodb (OP_MSG) | 1290.18 | 6.451 | 155/s |

Measured round totals (ms):

- `insert-200`: official `[18.20, 21.93, 15.89]`, minimal `[16.02, 15.70, 11.36]`
- `find-all-200`: official `[6.82, 8.99, 7.20]`, minimal `[7.09, 5.17, 4.80]`
- `find-point`: official `[63.21, 59.02, 50.41]`, minimal `[23.77, 24.77, 22.13]`
- `update-one`: official `[1368.19, 1368.71, 2102.15]`, minimal `[1289.44, 1290.18, 1305.24]`

## Intentional deltas

- Official path = driver (JS BSON serialization, connection management, loopback TCP); minimal path = native BSON codec plus raw OP_MSG over one socket.
- Neither path pools: the official driver runs with `maxPoolSize: 1`, `directConnection: true`, `retryWrites: false`, `compressors: []`; the minimal client owns one socket with no retry layer.
- Both paths use the same product server and storage engine (`.yyds` / `.yykv`), and each measured run starts from a fresh data directory.
- Read and update workloads are seeded with the minimal client before timing, so both columns start from identical documents.
- Extended JSON returned by the native codec is normalized only for conformance checks; benchmark timings use normal payload decoding.
- `update-one` reflects per-operation server-side update cost; the 1.29-1.37 s round totals for 200 updates are dominated by that server cost rather than the client stack.

Regenerate: `pnpm --dir projects/mongo.ts/examples/vs-js-libraries benchmark`
