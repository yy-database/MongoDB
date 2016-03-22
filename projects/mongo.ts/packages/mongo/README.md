# @yydb/mongo

MongoDB wire-protocol server assembled in TypeScript on top of the Rust
primitives in `projects/mongo.rs`. Documents live in a `.yykv` shard.

```ts
import { createServer } from '@yydb/mongo'

const server = createServer({ dataDir: './data', port: 27017 })
console.log(await server.listening)
```

The package is private during the product build. Builds resolve the platform
binding from `@yydb/mongo-<os>-<arch>`.

## Compression

`OP_COMPRESSED` (2012) is decoded for compressor ids 1 (snappy), 2 (zlib) and 3
(zstd); the handshake echoes the intersection of the client's `compression`
array and the codecs this server really implements. Replies are wrapped in the
same compressor the request used, which is what `mongod 8.0.9` does: a plain
`OP_MSG` request gets a plain reply even after negotiation, and an
`OP_COMPRESSED` request is answered in kind. A frame whose original opcode is
not `OP_MSG`, whose `uncompressedSize` does not match the decoded length, or
whose compressor id is unknown is answered with an error and the connection is
closed instead of continuing.

`node:zlib` supplies zlib and zstd. Snappy has no Node built-in, so the encoder
emits literal-only streams (legal snappy, ratio 1.0) and the decoder handles
every tag libsnappy produces.

