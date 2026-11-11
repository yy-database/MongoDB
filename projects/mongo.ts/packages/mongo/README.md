# `@yydb/mongodb`

MongoDB wire-protocol server assembled in TypeScript on top of the Rust
primitives in `projects/mongo.rs`. Documents live in a `.yykv` shard.

```ts
import { createServer } from '@yydb/mongodb'

const server = createServer({ dataDir: './data', port: 27017 })
console.log(await server.listening)
```

The package is private during the product build. Builds resolve the platform
binding from `@yydb/mongodb-<os>-<arch>`.

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
emits literal-only streams: legal snappy with a compression ratio of 1.0, i.e.
wire compatibility without any size benefit. The decoder handles every tag
libsnappy produces. Deliberate deviations from `mongod` are recorded in
[KNOWN-DIFFERENCES.md](./KNOWN-DIFFERENCES.md).

## Authentication

`createServer({ dataDir, port, auth: true })` (CLI: `--auth`) requires
authentication before any non-handshake command, like `mongod --auth`. Without
the flag credentials are still validated but nothing is refused, matching a
`mongod` started without `security.authorization`.

SCRAM-SHA-256 and SCRAM-SHA-1 are both registered for `createUser`; users are
stored as `<db>.system.users` documents in the same `.yykv` store with the
`credentials` sub-document `mongod` writes (base64 `salt`/`storedKey`/`serverKey`
and `iterationCount`). `hello` answers `saslSupportedMechs` and accepts
`speculativeAuthenticate`, so official drivers pick their mechanism during the
handshake. Failure codes and messages (`Authentication failed.`, code 18;
`MechanismUnavailable`, 334; `No SASL session state found`, 17) were captured
from `mongod 8.0.9`. Built-in roles are expanded into privileges and enforced
on every command once `--auth` is on; only the six built-in roles exist, so
custom roles and authentication restrictions are refused. Deliberate gaps are
listed in [KNOWN-DIFFERENCES.md](./KNOWN-DIFFERENCES.md).

```ts
const server = createServer({ dataDir: './data', port: 27017, auth: true })
```

## Data directory lock

`createServer` takes an exclusive lock on `dataDir` before it opens the store:
it creates `mongo.lock` with `wx` and writes the holder's `pid`, host, port and
start time. A second `createServer` on the same directory — in this process or
in another — is refused synchronously with an `Unable to lock data directory`
error naming the directory and the holder pid, mirroring `mongod`'s startup
failure on a busy `dbpath`. A lock file whose pid is no longer running is
stale: it is removed and the exclusive create is retried once, so a crashed
holder never wedges the directory. `close()` releases the lock.

