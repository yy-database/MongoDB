// Client-compatibility acceptance: OP_COMPRESSED and handshake negotiation.
//
// Unit expectations for the codecs come from `mongod 8.0.9` (the snappy fixture
// below is a real reply captured from it). The end-to-end half drives the
// official Node driver with compression enabled, which is the gate that matters
// for drop-in use.
import assert from 'node:assert/strict'
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'
import { decompress, snappyCompress, snappyDecompress } from '../src/compression.ts'
import { createServer, negotiatedCompressors } from '../src/server.ts'
import { decodeFrame, encodeCompressedFrame, encodeMsgFrame, OP_MSG, OP_QUERY } from '../src/wire.ts'
import { binding } from '../src/binding.ts'

let assertions = 0
function ok(condition, message) {
    assertions += 1
    assert.ok(condition, message)
}
function equal(actual, expected, message) {
    assertions += 1
    assert.deepEqual(actual, expected, message)
}

// --- codecs ----------------------------------------------------------------

// `mongod 8.0.9` answer to `ping` under snappy, compressed and decompressed.
const MONGO_SNAPPY_REPLY =
    '16000001014011000000016f6b00000000000000f03f00'
const MONGO_SNAPPY_BODY = '000000000011000000016f6b00000000000000f03f00'

equal(snappyDecompress(Buffer.from(MONGO_SNAPPY_REPLY, 'hex'), 22).toString('hex'), MONGO_SNAPPY_BODY, 'snappy decodes a real mongod reply')
assert.throws(() => snappyDecompress(Buffer.from(MONGO_SNAPPY_REPLY, 'hex'), 21), /announces/, 'snappy rejects a size mismatch')
assertions += 1

for (const [label, payload] of [
    ['empty', Buffer.alloc(0)],
    ['one byte', Buffer.from([1])],
    ['sixty bytes', Buffer.alloc(60, 7)],
    ['sixty-one bytes', Buffer.alloc(61, 7)],
    ['two hundred', Buffer.alloc(200, 3)],
    ['over one literal chunk', Buffer.alloc(0x1000000 + 9, 5)]
]) {
    const compressed = snappyCompress(payload)
    equal(snappyDecompress(compressed, payload.length).equals(payload), true, `snappy round-trips ${label}`)
}

const sample = Buffer.from('the quick brown fox jumps over the lazy dog', 'utf8')
equal(decompress(2, zlib.deflateSync(sample), sample.length).equals(sample), true, 'zlib round-trips')
equal(decompress(3, zlib.zstdCompressSync(sample), sample.length).equals(sample), true, 'zstd round-trips')
assert.throws(() => decompress(2, zlib.deflateSync(sample), sample.length + 1), /announced/, 'zlib rejects a size mismatch')
assertions += 1

// --- wire envelope ---------------------------------------------------------

const pingBody = binding.encodeOpMsg(JSON.stringify({ ping: 1, $db: 'admin' }))
const compressedPing = encodeCompressedFrame(7, 0, 2, pingBody.length, zlib.deflateSync(pingBody))
const inbound = decodeFrame(compressedPing)
equal(inbound.opcode, OP_MSG, 'compressed frame unwraps to OP_MSG')
equal(inbound.compressorName, 'zlib', 'compressed frame reports its compressor')
equal(inbound.payload.equals(pingBody), true, 'compressed frame payload matches the original body')

const lyingSize = encodeCompressedFrame(7, 0, 2, pingBody.length + 4, zlib.deflateSync(pingBody))
assert.throws(() => decodeFrame(lyingSize), /announced/, 'a lying uncompressedSize errors instead of continuing')
assertions += 1

const wrongOpcode = Buffer.from(encodeCompressedFrame(7, 0, 2, pingBody.length, zlib.deflateSync(pingBody)))
wrongOpcode.writeInt32LE(OP_QUERY, 16)
assert.throws(() => decodeFrame(wrongOpcode), /must wrap OP_MSG/, 'OP_COMPRESSED must wrap OP_MSG only')
assertions += 1

const unknownId = Buffer.from(encodeCompressedFrame(7, 0, 2, pingBody.length, zlib.deflateSync(pingBody)))
unknownId.writeUInt8(9, 24)
assert.throws(() => decodeFrame(unknownId), /unknown compressor id 9/, 'unknown compressor ids are rejected')
assertions += 1

// --- negotiation -----------------------------------------------------------

equal(negotiatedCompressors(['zlib'], ['snappy', 'zlib', 'zstd']), ['zlib'], 'only offered codecs are answered')
equal(negotiatedCompressors(['bogus'], ['snappy', 'zlib', 'zstd']), [], 'unknown codecs are not advertised')
equal(negotiatedCompressors(undefined), [], 'a missing compression array advertises nothing')
equal(negotiatedCompressors(['zstd', 'zlib']), ['zstd', 'zlib'], 'client order is preserved')

// --- raw client -------------------------------------------------------------

function frameBody(command) {
    return binding.encodeOpMsg(JSON.stringify(command))
}

async function connect(port) {
    const socket = net.connect(port, '127.0.0.1')
    await new Promise((resolvePromise, rejectPromise) => {
        socket.once('connect', resolvePromise)
        socket.once('error', rejectPromise)
    })
    let buffer = Buffer.alloc(0)
    const queue = []
    const waiters = []
    socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk])
        while (buffer.length >= 4) {
            const length = buffer.readInt32LE(0)
            if (buffer.length < length) return
            const frame = buffer.subarray(0, length)
            buffer = buffer.subarray(length)
            const waiter = waiters.shift()
            if (waiter) waiter(frame)
            else queue.push(frame)
        }
    })
    const next = () =>
        new Promise((resolvePromise) => {
            if (queue.length > 0) resolvePromise(queue.shift())
            else waiters.push(resolvePromise)
        })
    return { socket, next }
}

const dataDir = mkdtempSync(join(tmpdir(), 'mongo-compress-'))
const server = createServer({ dataDir, port: 0 })
const address = await server.listening

// No compression offered: `mongod` omits the field entirely.
{
    const { socket, next } = await connect(address.port)
    socket.write(encodeMsgFrame(1, 0, frameBody({ hello: 1, $db: 'admin' })))
    const reply = JSON.parse(binding.decodeOpMsg((await next()).subarray(16)))
    equal(Object.hasOwn(reply, 'compression'), false, 'hello without compression keeps the field absent')
    socket.destroy()
}

// Each codec: echoed in hello, accepted inbound, mirrored outbound.
for (const [name, id, compressor] of [
    ['snappy', 1, snappyCompress],
    ['zlib', 2, (buffer) => zlib.deflateSync(buffer)],
    ['zstd', 3, (buffer) => zlib.zstdCompressSync(buffer)]
]) {
    const { socket, next } = await connect(address.port)
    socket.write(encodeMsgFrame(1, 0, frameBody({ hello: 1, compression: [name], $db: 'admin' })))
    const helloReply = JSON.parse(binding.decodeOpMsg((await next()).subarray(16)))
    equal(helloReply.compression, [name], `hello echoes ${name}`)

    const payload = frameBody({ ping: 1, $db: 'admin' })
    const replyFrame = encodeCompressedFrame(2, 0, id, payload.length, compressor(payload))
    socket.write(replyFrame)
    const answer = await next()
    equal(answer.readInt32LE(12), 2012, `${name} reply is OP_COMPRESSED`)
    equal(answer.readUInt8(24), id, `${name} reply mirrors the request compressor`)
    const announced = answer.readInt32LE(20)
    const decoded = decompress(id, answer.subarray(25), announced)
    equal(JSON.stringify(JSON.parse(binding.decodeOpMsg(decoded))), JSON.stringify({ ok: { $numberDouble: '1.0' } }), `${name} ping replied ok`)
    socket.destroy()
}

// Plain requests stay plain after negotiation, as `mongod` does.
{
    const { socket, next } = await connect(address.port)
    socket.write(encodeMsgFrame(1, 0, frameBody({ hello: 1, compression: ['zlib'], $db: 'admin' })))
    await next()
    socket.write(encodeMsgFrame(2, 0, frameBody({ ping: 1, $db: 'admin' })))
    const answer = await next()
    equal(answer.readInt32LE(12), OP_MSG, 'a plain request gets a plain reply even after negotiation')
    socket.destroy()
}

// Malformed compressed frames must error, not continue.
{
    const { socket, next } = await connect(address.port)
    socket.write(encodeMsgFrame(1, 0, frameBody({ hello: 1, compression: ['zlib'], $db: 'admin' })))
    await next()
    const payload = frameBody({ ping: 1, $db: 'admin' })
    socket.write(encodeCompressedFrame(2, 0, 2, payload.length + 5, zlib.deflateSync(payload)))
    const answer = await next()
    const reply = JSON.parse(binding.decodeOpMsg(answer.subarray(16)))
    equal(reply.ok, { $numberDouble: '0.0' }, 'a lying uncompressedSize gets an error reply')
    ok(typeof reply.errmsg === 'string' && reply.errmsg.includes('announced'), 'the error names the announced size')
    socket.destroy()
}

{
    const { socket, next } = await connect(address.port)
    socket.write(encodeMsgFrame(1, 0, frameBody({ hello: 1, compression: ['zlib'], $db: 'admin' })))
    await next()
    const payload = frameBody({ ping: 1, $db: 'admin' })
    const forged = Buffer.from(encodeCompressedFrame(2, 0, 2, payload.length, zlib.deflateSync(payload)))
    forged.writeInt32LE(OP_QUERY, 16)
    socket.write(forged)
    const answer = await next()
    const reply = JSON.parse(binding.decodeOpMsg(answer.subarray(16)))
    equal(reply.ok, { $numberDouble: '0.0' }, 'OP_QUERY inside OP_COMPRESSED gets an error reply')
    socket.destroy()
}

// `mongosh` calls `buildInfo` for `db.version()`.
{
    const { socket, next } = await connect(address.port)
    socket.write(encodeMsgFrame(1, 0, frameBody({ buildInfo: 1, $db: 'admin' })))
    const reply = JSON.parse(binding.decodeOpMsg((await next()).subarray(16)))
    equal(reply.version, '8.0.9', 'buildInfo reports the emulated wire surface version')
    equal(reply.maxBsonObjectSize, { $numberInt: '16777216' }, 'buildInfo carries the object size limit')
    socket.destroy()
}

// --- official Node driver ---------------------------------------------------

const { MongoClient } = await import('mongodb')
const client = new MongoClient(`mongodb://${address.host}:${address.port}/?directConnection=true`, {
    compressors: ['zlib'],
    serverSelectionTimeoutMS: 5000
})
await client.connect()
const collection = client.db('acceptance').collection('compressed')
await collection.deleteMany({})
const inserted = await collection.insertMany([{ _id: 1, v: 'a' }, { _id: 2, v: 'b' }, { _id: 3, v: 'c' }])
equal(inserted.insertedCount, 3, 'driver insert under zlib')
const found = await collection.find({}).sort({ _id: 1 }).toArray()
equal(found.map((document) => document._id), [1, 2, 3], 'driver find under zlib')
const updated = await collection.updateOne({ _id: 2 }, { $set: { v: 'z' } })
equal(updated.modifiedCount, 1, 'driver update under zlib')
const removed = await collection.deleteOne({ _id: 3 })
equal(removed.deletedCount, 1, 'driver delete under zlib')
equal(await collection.countDocuments({}), 2, 'driver countDocuments under zlib')
ok(server.stats.compressedRequests > 0, 'the driver actually sent compressed requests')
ok(server.stats.compressedReplies > 0, 'the server actually sent compressed replies')
await client.close()

// --- SCRAM-SHA-256 / SCRAM-SHA-1 -------------------------------------------

let requestId = 1
async function command(connection, document) {
    connection.socket.write(encodeMsgFrame(requestId++, 0, frameBody(document)))
    const frame = await connection.next()
    return JSON.parse(binding.decodeOpMsg(frame.subarray(16)))
}

const binary = (text) => ({ $binary: { base64: Buffer.from(text, 'utf8').toString('base64'), subType: '00' } })
const payloadText = (payload) => Buffer.from(payload.$binary.base64, 'base64').toString('utf8')

/** SCRAM client used by the acceptance tests, mirroring the Node driver. */
async function scram(connection, user, password, mechanism = 'SCRAM-SHA-256', db = 'admin') {
    const digest = mechanism === 'SCRAM-SHA-256' ? 'sha256' : 'sha1'
    const keyLength = mechanism === 'SCRAM-SHA-256' ? 32 : 20
    const processed = mechanism === 'SCRAM-SHA-256' ? password : createHash('md5').update(`${user}:mongo:${password}`, 'utf8').digest('hex')
    const nonce = randomBytes(12).toString('base64').replace(/[^A-Za-z0-9]/g, '')
    const clientFirstBare = `n=${user},r=${nonce}`
    const start = await command(connection, {
        saslStart: 1,
        mechanism,
        payload: binary(`n,,${clientFirstBare}`),
        autoAuthorize: 1,
        $db: db
    })
    if (start.ok === 0 || start.ok?.$numberDouble === '0.0') return { start }
    const serverFirst = payloadText(start.payload)
    const salt = Buffer.from(serverFirst.split(',')[1].slice(2), 'base64')
    const iterations = Number(serverFirst.split(',')[2].slice(2))
    const salted = pbkdf2Sync(processed, salt, iterations, keyLength, digest)
    const hash = (data) => createHash(digest).update(data).digest()
    const hmac = (key, data) => createHmac(digest, key).update(data).digest()
    const clientKey = hmac(salted, 'Client Key')
    const storedKey = hash(clientKey)
    const withoutProof = `c=biws,r=${serverFirst.split(',')[0].slice(2)}`
    const signature = hmac(storedKey, `${clientFirstBare},${serverFirst},${withoutProof}`)
    const proof = Buffer.alloc(keyLength)
    for (let index = 0; index < keyLength; index += 1) proof[index] = clientKey[index] ^ signature[index]
    const final = await command(connection, {
        saslContinue: 1,
        conversationId: start.conversationId,
        payload: binary(`${withoutProof},p=${proof.toString('base64')}`),
        $db: db
    })
    const finished = await command(connection, {
        saslContinue: 1,
        conversationId: start.conversationId,
        payload: binary(''),
        $db: db
    })
    return { start, final, finished, serverFirst }
}

const authDir = mkdtempSync(join(tmpdir(), 'mongo-auth-'))
const authServer = createServer({ dataDir: authDir, port: 0, auth: true })
const authAddress = await authServer.listening
const login = await connect(authAddress.port)

{
    const denied = await command(login, { find: 'items', filter: {}, $db: 'authdb' })
    equal(denied.ok, { $numberDouble: '0.0' }, 'find is refused before authentication')
    equal(denied.errmsg, 'Command find requires authentication', 'the refusal text matches mongod')
    equal(denied.code, { $numberInt: '13' }, 'the refusal code matches mongod')
    equal(denied.codeName, 'Unauthorized', 'the refusal codeName matches mongod')

    const ping = await command(login, { ping: 1, $db: 'admin' })
    equal(ping.ok, { $numberDouble: '1.0' }, 'ping is answered before authentication')

    const hello = await command(login, { hello: 1, $db: 'admin' })
    equal(Object.hasOwn(hello, 'saslSupportedMechs'), false, 'hello without the field stays without it')

    const created = await command(login, { createUser: 'root', pwd: 'root-pass', roles: [{ role: 'root', db: 'admin' }], $db: 'admin' })
    equal(created.ok, { $numberDouble: '1.0' }, 'the localhost exception creates the first user')

    // Once a user exists the exception is gone, so the same connection is gated.
    const refused = await command(login, { createUser: 'root', pwd: 'other-pass', roles: [], $db: 'admin' })
    equal(refused.code, { $numberInt: '13' }, 'the localhost exception closes after the first user')
    equal(refused.errmsg, 'Command createUser requires authentication', 'the closed exception text matches mongod')
}

{
    const hello = await command(login, { hello: 1, saslSupportedMechs: 'admin.root', $db: 'admin' })
    equal(hello.saslSupportedMechs, ['SCRAM-SHA-256', 'SCRAM-SHA-1'], 'an existing user reports both mechanisms')
    const ghost = await command(login, { hello: 1, saslSupportedMechs: 'admin.ghost', $db: 'admin' })
    equal(Object.hasOwn(ghost, 'saslSupportedMechs'), false, 'a missing user reports no mechanism field')
    const malformed = await command(login, { hello: 1, saslSupportedMechs: 'root', $db: 'admin' })
    equal(malformed.code, { $numberInt: '2' }, 'a name without a database is rejected')
    equal(malformed.errmsg, "UserName must contain a '.' separated database.user pair", 'the malformed name text matches mongod')
}

{
    const unknown = await command(login, { saslStart: 1, mechanism: 'SCRAM-SHA-512', payload: binary('n,,n=root,r=abc'), autoAuthorize: 1, $db: 'admin' })
    equal(unknown.code, { $numberInt: '334' }, 'an unknown mechanism is unavailable')
    equal(unknown.errmsg, 'Received authentication for mechanism SCRAM-SHA-512 which is not enabled', 'the mechanism text matches mongod')
    const missing = await command(login, { saslStart: 1, payload: binary('n,,n=root,r=abc'), autoAuthorize: 1, $db: 'admin' })
    equal(missing.code, { $numberInt: '40414' }, 'a missing mechanism is an IDL parse failure')
    equal(missing.errmsg, "BSON field 'saslStart.mechanism' is missing but a required field", 'the missing-field text matches mongod')
    const noPayload = await command(login, { saslStart: 1, mechanism: 'SCRAM-SHA-256', autoAuthorize: 1, $db: 'admin' })
    equal(noPayload.code, { $numberInt: '40414' }, 'a missing payload is an IDL parse failure')
    equal(noPayload.errmsg, "BSON field 'saslStart.payload' is missing but a required field", 'the missing-payload text matches mongod')
    const ghost = await command(login, { saslStart: 1, mechanism: 'SCRAM-SHA-256', payload: binary('n,,n=ghost,r=abc'), autoAuthorize: 1, $db: 'admin' })
    equal(ghost.code, { $numberInt: '18' }, 'a nonexistent user fails authentication')
    equal(ghost.errmsg, 'Authentication failed.', 'the failure text is byte-identical to mongod')
}

{
    const session = await scram(login, 'root', 'root-pass')
    equal(session.final.ok, { $numberDouble: '1.0' }, 'the client proof is accepted')
    equal(session.final.done, false, 'the proof reply is not the last step')
    ok(payloadText(session.final.payload).startsWith('v='), 'the proof reply carries the server signature prefix')
    equal(payloadText(session.final.payload).length > 2, true, 'the server signature is not empty')
    equal(session.finished.done, true, 'the empty continuation finishes the exchange')
    const status = await command(login, { connectionStatus: 1, $db: 'admin' })
    equal(status.authInfo.authenticatedUsers, [{ user: 'root', db: 'admin' }], 'connectionStatus lists the authenticated user')
    equal(status.authInfo.authenticatedUserRoles, [{ role: 'root', db: 'admin' }], 'connectionStatus lists the granted roles')
    const visible = await command(login, { find: 'items', filter: {}, $db: 'authdb' })
    equal(visible.ok, { $numberDouble: '1.0' }, 'find is answered after authentication')

    const duplicate = await command(login, { createUser: 'root', pwd: 'other-pass', roles: [], $db: 'admin' })
    equal(duplicate.code, { $numberInt: '51003' }, 'an authenticated duplicate uses createUser\u2019s code')
    equal(duplicate.errmsg, 'User "root@admin" already exists', 'an authenticated duplicate uses createUser\u2019s text')

    const noRoles = await command(login, { createUser: 'noroles', pwd: 'x', $db: 'admin' })
    equal(noRoles.code, { $numberInt: '40414' }, 'a missing roles array is an IDL parse failure')
    equal(noRoles.errmsg, "BSON field 'createUser.roles' is missing but a required field", 'the missing-roles text matches mongod')

    const badMechanism = await command(login, { createUser: 'badmech', pwd: 'x', roles: [], mechanisms: ['BOGUS'], $db: 'admin' })
    equal(badMechanism.code, { $numberInt: '2' }, 'an unregistered mechanism is a bad value')
    equal(badMechanism.errmsg, "Unknown auth mechanism 'BOGUS'", 'the unknown-mechanism text matches mongod')
}

{
    const bad = await scram(login, 'root', 'wrong-pass')
    equal(bad.final.code, { $numberInt: '18' }, 'a wrong password fails authentication')
    equal(bad.final.errmsg, 'Authentication failed.', 'a wrong password uses the real failure text')
    const after = await command(login, { saslContinue: 1, conversationId: { $numberInt: '1' }, payload: binary(''), $db: 'admin' })
    equal(after.code, { $numberInt: '17' }, 'a failed conversation leaves no session state')
    equal(after.errmsg, 'No SASL session state found', 'the protocol error text matches mongod')
}

{
    const sha1 = await scram(login, 'root', 'root-pass', 'SCRAM-SHA-1')
    equal(sha1.final.ok, { $numberDouble: '1.0' }, 'SCRAM-SHA-1 accepts the legacy password digest')
}

{
    const only256 = await command(login, { createUser: 'only256', pwd: 'only-pass', roles: [], mechanisms: ['SCRAM-SHA-256'], $db: 'admin' })
    equal(only256.ok, { $numberDouble: '1.0' }, 'a user can be created with one mechanism')
    const deniedMechanism = await command(login, { saslStart: 1, mechanism: 'SCRAM-SHA-1', payload: binary('n,,n=only256,r=abc'), autoAuthorize: 1, $db: 'admin' })
    equal(deniedMechanism.code, { $numberInt: '334' }, 'a user without SHA-1 credentials rejects SHA-1')
    equal(
        deniedMechanism.errmsg,
        'Unable to use SCRAM-SHA-1 based authentication for user without any SCRAM-SHA-1 credentials registered',
        'the unavailable-mechanism text matches mongod'
    )
    const supported = await command(login, { hello: 1, saslSupportedMechs: 'admin.only256', $db: 'admin' })
    equal(supported.saslSupportedMechs, ['SCRAM-SHA-256'], 'a single-mechanism user reports only that mechanism')
}

{
    const speculative = await command(login, {
        hello: 1,
        saslSupportedMechs: 'admin.root',
        speculativeAuthenticate: { saslStart: 1, mechanism: 'SCRAM-SHA-256', payload: binary('n,,n=root,r=abcdefgh'), autoAuthorize: 1, db: 'admin' },
        $db: 'admin'
    })
    ok(speculative.speculativeAuthenticate, 'hello answers a speculative SCRAM start')
    ok(payloadText(speculative.speculativeAuthenticate.payload).startsWith('r=abcdefgh'), 'the speculative reply is server-first')
    equal(Object.hasOwn(speculative.speculativeAuthenticate, 'ok'), false, 'the speculative reply omits ok like mongod')
    const ghost = await command(login, {
        hello: 1,
        saslSupportedMechs: 'admin.ghost',
        speculativeAuthenticate: { saslStart: 1, mechanism: 'SCRAM-SHA-256', payload: binary('n,,n=ghost,r=abcdefgh'), autoAuthorize: 1, db: 'admin' },
        $db: 'admin'
    })
    equal(Object.hasOwn(ghost, 'speculativeAuthenticate'), false, 'a failed speculation is omitted')
}

// A string role names the current database, as `mongod` stores it.
{
    const created = await command(login, { createUser: 'stringrole', pwd: 'role-pass', roles: ['readWrite'], $db: 'admin' })
    equal(created.ok, { $numberDouble: '1.0' }, 'a string role is accepted')
    const rolesConnection = await connect(authAddress.port)
    const session = await scram(rolesConnection, 'stringrole', 'role-pass')
    equal(session.finished.done, true, 'the string-role user logs in')
    const status = await command(rolesConnection, { connectionStatus: 1, $db: 'admin' })
    equal(status.authInfo.authenticatedUserRoles, [{ role: 'readWrite', db: 'admin' }], 'a string role is reported with its database')
    rolesConnection.socket.destroy()
}

{
    const out = await command(login, { logout: 1, $db: 'admin' })
    equal(out.ok, { $numberDouble: '1.0' }, 'logout is acknowledged')
    const status = await command(login, { connectionStatus: 1, $db: 'admin' })
    equal(status.authInfo.authenticatedUsers, [], 'logout clears the authenticated user')
    const denied = await command(login, { find: 'items', filter: {}, $db: 'authdb' })
    equal(denied.code, { $numberInt: '13' }, 'logout puts the connection back behind the gate')
}

// A fresh connection cannot create users once one exists.
{
    const fresh = await connect(authAddress.port)
    const denied = await command(fresh, { createUser: 'second', pwd: 'x', roles: [], $db: 'admin' })
    equal(denied.code, { $numberInt: '13' }, 'createUser past the localhost exception needs authentication')
    equal(denied.errmsg, 'Command createUser requires authentication', 'the createUser gate text matches mongod')
    fresh.socket.destroy()
}

// Official drivers: default mechanism (hello negotiation + speculative start)
// and the explicit SCRAM-SHA-1 path.
{
    const uri = `mongodb://root:root-pass@${authAddress.host}:${authAddress.port}/?authSource=admin&directConnection=true`
    const authenticated = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 })
    await authenticated.connect()
    const collection = authenticated.db('secured').collection('items')
    await collection.insertMany([{ _id: 1, v: 'a' }, { _id: 2, v: 'b' }])
    equal((await collection.find({}).sort({ _id: 1 }).toArray()).map((document) => document._id), [1, 2], 'a driver authenticated with SCRAM-SHA-256 runs CRUD')
    equal((await collection.updateOne({ _id: 1 }, { $set: { v: 'z' } })).modifiedCount, 1, 'an authenticated driver updates')
    await authenticated.close()

    const legacy = new MongoClient(uri + '&authMechanism=SCRAM-SHA-1', { serverSelectionTimeoutMS: 5000 })
    await legacy.connect()
    equal(await legacy.db('secured').collection('items').countDocuments({}), 2, 'a driver authenticated with SCRAM-SHA-1 runs reads')
    await legacy.close()
}

login.socket.destroy()
await authServer.close()

await server.close()
console.log(`server acceptance: ${assertions} assertions`)
