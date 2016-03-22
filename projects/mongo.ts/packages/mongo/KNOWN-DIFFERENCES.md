# Known differences from `mongod`

Deliberate, reviewed deviations between this server and `mongod 8.0.9`.
Everything not listed here is meant to match the real server.

## `OP_COMPRESSED` malformed frames

Real `mongod 8.0.9` reacts differently depending on how the announced
`uncompressedSize` is wrong:

- announced size larger than the decoded body: replies with an error
  (`Location40430`) and keeps the connection;
- announced size smaller than the decoded body: closes the connection without
  any reply.

This server always answers `ok: 0` with an explicit `errmsg` naming both sizes,
then closes the connection. The deviation is on purpose: a client that gets an
answer can report why it was dropped, while the connection is still torn down
so a lying frame can never be treated as valid.

An original opcode other than `OP_MSG` is rejected outright. Real `mongod`
answers such a frame with a compressed `OP_REPLY` carrying "OP_QUERY is no
longer supported"; rejecting it is stricter and keeps the reply envelope
consistent.

## snappy encoder

The snappy **encoder** emits literal-only streams. That is legal snappy (every
driver and `mongod` accepts it) but it produces a compression ratio of 1.0, so
it buys wire compatibility without any size benefit. The **decoder** fully
supports copy tags (1/2/4 byte offsets), which is what real servers and drivers
emit; the fixture captured from `mongod 8.0.9` exercises them.

Real compression (libsnappy-style matching) is a separate scheduling item and
must not be mixed into a compatibility change.
