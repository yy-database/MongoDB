# @yydb/mongo

MongoDB wire-protocol server assembled in TypeScript on top of the Rust
primitives in `projects/mongo.rs`. Documents live in a `.yykv` shard.

```ts
import { createServer } from '@yydb/mongo'

const server = createServer({ dataDir: './data', port: 27017 })
console.log(server.address)
```

The package is private during the product build. Builds resolve the platform
binding from `@yydb/mongo-<os>-<arch>`.
