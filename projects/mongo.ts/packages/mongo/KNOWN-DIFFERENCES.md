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

## SCRAM authentication

The measured surface matches `mongod 8.0.9`: `hello`'s `saslSupportedMechs`
(both mechanisms for a user holding both, field absent for an unknown user),
`speculativeAuthenticate`, the `Authentication failed.` reply (code 18),
`MechanismUnavailable` (334), `No SASL session state found` (17), the credential
layout in `<db>.system.users` (base64 `salt`/`storedKey`/`serverKey`,
`iterationCount` 15000 for SHA-256 and 10000 for SHA-1) and the MongoDB SHA-1
password digest `md5("<user>:mongo:<pwd>")`.

Deliberate limits:

- **No authorization.** A successful login admits every command. `mongod`
  applies role-based authorization and refuses commands the roles do not grant
  (code 13). Roles are stored and reported by `connectionStatus`, but they are
  not enforced; privilege checking is separate scheduling work.
- **No SASLprep.** SCRAM-SHA-256 hashes the password as UTF-8 without RFC 4013
  preparation. ASCII passwords behave identically; non-ASCII passwords can
  disagree with a real server.
- **No GS2 authzid.** A client-first message carrying `a=<authzid>` is rejected
  with `Authentication failed.`; `mongod` accepts it.
- **`createUser` role validation.** Role names are stored verbatim (a string
  role becomes `{role, db: <user db>}`), but unknown roles are accepted;
  `mongod` answers `RoleNotFound` (31). Custom roles do not exist here.
- **`saslStart` payload type.** A base64 string payload is decoded, and an
  invalid one answers `Failed decoding SASL payload: invalid base64` (10270).
