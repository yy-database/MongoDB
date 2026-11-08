# Conformance report

Command: `pnpm --dir projects/mongo.ts/examples/vs-js-libraries test`

Captured output:

```text
PASS official driver writes -> minimal OP_MSG client reads
PASS minimal OP_MSG client writes -> official driver reads
PASS official driver update -> minimal OP_MSG client reads $set fields
PASS minimal OP_MSG client update -> official driver reads $set fields
PASS minimal OP_MSG client drains a getMore cursor
PASS 5/5 conformance checks
```
