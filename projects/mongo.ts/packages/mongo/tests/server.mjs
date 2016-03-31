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

const { MongoClient, BSON } = await import('mongodb')
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

// --- dropDatabase -----------------------------------------------------------

{
    const lived = client.db('drop_acceptance')
    await lived.collection('items').deleteMany({})
    await lived.collection('items').insertMany([{ _id: 1 }, { _id: 2 }])
    await lived.collection('items').createIndex({ x: 1 })
    await lived.collection('others').insertOne({ _id: 1 })
    equal((await lived.command({ listCollections: 1 })).cursor.firstBatch.length, 2, 'dropDatabase starts with two collections')

    const reply = await lived.command({ dropDatabase: 1 })
    equal(JSON.stringify(reply), '{"ok":1}', 'dropDatabase replies with ok only, the shell adds dropped')
    equal((await lived.command({ listCollections: 1 })).cursor.firstBatch.length, 0, 'listCollections is empty after the drop')
    equal((await lived.collection('items').find({}).toArray()).length, 0, 'find returns nothing after the drop')
    let missing = null
    try {
        await lived.command({ listIndexes: 'items' })
    } catch (error) {
        missing = error
    }
    equal(missing?.code, 26, 'listIndexes answers NamespaceNotFound after the drop')
    equal(missing?.codeName, 'NamespaceNotFound', 'listIndexes names the error after the drop')
    ok(
        !(await client.db('admin').command({ listDatabases: 1 })).databases.some((entry) => entry.name === 'drop_acceptance'),
        'listDatabases no longer lists the dropped database'
    )
    equal(JSON.stringify(await client.db('never_created').command({ dropDatabase: 1 })), '{"ok":1}', 'dropping a missing database also replies ok')

    // A cursor on a dropped collection is killed for every connection.
    await lived.collection('cursors').insertMany(Array.from({ length: 20 }, (_, index) => ({ _id: index })))
    const cursor = lived.collection('cursors').find({}, { batchSize: 2 })
    await cursor.next()
    await cursor.next()
    const cursorId = cursor.id
    ok(cursorId !== undefined && !cursorId.isZero(), 'the cursor is still open before the drop')
    await lived.command({ dropDatabase: 1 })
    let killed = null
    try {
        await cursor.next()
    } catch (error) {
        killed = error
    }
    equal(killed?.code, 175, 'getMore after dropDatabase answers QueryPlanKilled')
    equal(killed?.codeName, 'QueryPlanKilled', 'QueryPlanKilled carries its code name')
    ok(killed?.message.startsWith('collection dropped. UUID '), 'QueryPlanKilled names the dropped collection UUID')

    let later = null
    try {
        await lived.command({ getMore: cursorId, collection: 'cursors', batchSize: 2 })
    } catch (error) {
        later = error
    }
    equal(later?.code, 43, 'a second getMore is CursorNotFound')

    // Drop guards and argument validation.
    let restricted = null
    try {
        await client.db('admin').command({ dropDatabase: 1 })
    } catch (error) {
        restricted = error
    }
    equal(restricted?.code, 20, 'admin cannot be dropped')
    equal(restricted?.codeName, 'IllegalOperation', 'the admin guard is IllegalOperation')
    let zero = null
    try {
        await client.db('drop_values').command({ dropDatabase: 0 })
    } catch (error) {
        zero = error
    }
    equal(zero?.code, 5255100, 'dropDatabase 0 is rejected')
    let wrongType = null
    try {
        await client.db('drop_values').command({ dropDatabase: 'x' })
    } catch (error) {
        wrongType = error
    }
    equal(wrongType?.code, 14, 'a non-numeric dropDatabase is a type mismatch')
}

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
async function scram(connection, user, password, mechanism = 'SCRAM-SHA-256', db = 'admin', gs2 = 'n,,', proofBinding = null) {
    const digest = mechanism === 'SCRAM-SHA-256' ? 'sha256' : 'sha1'
    const keyLength = mechanism === 'SCRAM-SHA-256' ? 32 : 20
    const processed = mechanism === 'SCRAM-SHA-256' ? password : createHash('md5').update(`${user}:mongo:${password}`, 'utf8').digest('hex')
    const nonce = randomBytes(12).toString('base64').replace(/[^A-Za-z0-9]/g, '')
    const clientFirstBare = `n=${user},r=${nonce}`
    const start = await command(connection, {
        saslStart: 1,
        mechanism,
        payload: binary(`${gs2}${clientFirstBare}`),
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
    const channelBinding = proofBinding ?? Buffer.from(gs2, 'utf8').toString('base64')
    const withoutProof = `c=${channelBinding},r=${serverFirst.split(',')[0].slice(2)}`
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

// --- authorization ----------------------------------------------------------
//
// Every expected action below was read from a real `mongod 8.0.9 --auth`
// instance: the privilege expansions through `showPrivileges`, the refused
// command texts through the official Node driver, and `listDatabases`
// behavior through both the driver and raw commands.

async function loginAs(user, db, gs2 = 'n,,') {
    const connection = await connect(authAddress.port)
    const session = await scram(connection, user, 'secret', 'SCRAM-SHA-256', db, gs2)
    ok(session.finished?.done === true, `${user}@${db} logs in`)
    return { connection, session }
}

async function driverLogin(user, password, db) {
    const uri = `mongodb://${user}:${encodeURIComponent(password)}@${authAddress.host}:${authAddress.port}/?authSource=${db}&directConnection=true`
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 })
    await client.connect()
    await client.close()
}

{
    const database = 'authz'
    const restored = await scram(login, 'root', 'root-pass')
    equal(restored.finished.done, true, 'root logs back in for the authorization checks')
    await command(login, { insert: 'items', documents: [{ _id: 1 }, { _id: 2 }], $db: database })
    for (const [user, role] of [
        ['z_read', 'read'],
        ['z_rw', 'readWrite'],
        ['z_dba', 'dbAdmin'],
        ['z_ua', 'userAdmin']
    ]) {
        const reply = await command(login, { createUser: user, pwd: 'secret', roles: [{ role, db: database }], $db: database })
        equal(reply.ok, { $numberDouble: '1.0' }, `createUser accepts the built-in ${role} role`)
    }
    for (const [user, role] of [
        ['z_ca', 'clusterAdmin'],
        ['z_root', 'root']
    ]) {
        const reply = await command(login, { createUser: user, pwd: 'secret', roles: [{ role, db: 'admin' }], $db: 'admin' })
        equal(reply.ok, { $numberDouble: '1.0' }, `a cluster-scoped ${role} role resolves on admin`)
    }

    // Role validation, with `mongod 8.0.9`'s own texts.
    const unknown = await command(login, { createUser: 'z_bad', pwd: 'x', roles: [{ role: 'nosuchrole', db: database }], $db: database })
    equal(unknown.code, { $numberInt: '31' }, 'an unknown role is RoleNotFound')
    equal(unknown.codeName, 'RoleNotFound', 'the unknown-role codeName matches mongod')
    equal(unknown.errmsg, 'Could not find role: nosuchrole@authz', 'the unknown-role text matches mongod')
    const missingDb = await command(login, { createUser: 'z_bad', pwd: 'x', roles: [{ role: 'read' }], $db: database })
    equal(missingDb.code, { $numberInt: '2' }, 'a role document without db is a bad value')
    equal(missingDb.errmsg, 'RoleName must contain a field named: db', 'the missing-db text matches mongod')
    const numberRole = await command(login, { createUser: 'z_bad', pwd: 'x', roles: [1], $db: database })
    equal(numberRole.errmsg, 'Role name must be either a document or string', 'a non-document role matches mongod')
    const numberName = await command(login, { createUser: 'z_bad', pwd: 'x', roles: [{ role: 123, db: database }], $db: database })
    equal(numberName.errmsg, 'RoleName must contain a string field named: role. But, has type int', 'a non-string role name matches mongod')
    const numberDb = await command(login, { createUser: 'z_bad', pwd: 'x', roles: [{ role: 'read', db: 5 }], $db: database })
    equal(numberDb.errmsg, 'RoleName must contain a string field named: db. But, has type int', 'a non-string role db matches mongod')
    const wrongScope = await command(login, { createUser: 'z_bad', pwd: 'x', roles: [{ role: 'clusterAdmin', db: database }], $db: database })
    equal(wrongScope.code, { $numberInt: '31' }, 'clusterAdmin only resolves on admin')
    const absentDb = await command(login, {
        createUser: 'z_absentdb',
        pwd: 'x',
        roles: [{ role: 'read', db: 'never_created' }],
        $db: database
    })
    equal(absentDb.ok, { $numberDouble: '1.0' }, 'a database role resolves on a database that does not exist')

    // read: reads its database, may not write or administer it.
    const reader = await loginAs('z_read', database)
    equal((await command(reader.connection, { find: 'items', filter: {}, $db: database })).ok, { $numberDouble: '1.0' }, 'read can find')
    const readInsert = await command(reader.connection, { insert: 'items', documents: [{ _id: 3 }], $db: database })
    equal(readInsert.code, { $numberInt: '13' }, 'read cannot insert')
    equal(
        readInsert.errmsg,
        'not authorized on authz to execute command { insert: "items", documents: [ { _id: 3 } ], $db: "authz" }',
        'the refusal text echoes the redacted command'
    )
    const readStats = await command(reader.connection, { dbStats: 1, $db: database })
    equal(readStats.ok, { $numberDouble: '1.0' }, 'read can read dbStats')
    const readUsers = await command(reader.connection, { usersInfo: 1, $db: database })
    equal(readUsers.errmsg, 'not authorized on authz to execute command { usersInfo: 1, $db: "authz" }', 'read cannot inspect users')
    reader.connection.socket.destroy()

    // readWrite: reads and writes, but not administration.
    const writer = await loginAs('z_rw', database)
    equal((await command(writer.connection, { find: 'items', filter: {}, $db: database })).ok, { $numberDouble: '1.0' }, 'readWrite can find')
    equal((await command(writer.connection, { insert: 'items', documents: [{ _id: 3 }], $db: database })).ok, { $numberDouble: '1.0' }, 'readWrite can insert')
    equal((await command(writer.connection, { dbStats: 1, $db: database })).ok, { $numberDouble: '1.0' }, 'readWrite can read dbStats')
    equal((await command(writer.connection, { listCollections: 1, $db: database })).ok, { $numberDouble: '1.0' }, 'readWrite can list collections')
    equal(
        (await command(writer.connection, {
            createIndexes: 'items',
            indexes: [{ key: { f1: 1 }, name: 'f1_1' }],
            $db: database
        })).ok,
        { $numberDouble: '1.0' },
        'readWrite can create an index'
    )
    equal((await command(writer.connection, { dropIndexes: 'items', index: 'f1_1', $db: database })).ok, { $numberDouble: '1.0' }, 'readWrite can drop an index')
    const writerDrop = await command(writer.connection, { dropDatabase: 1, $db: database })
    equal(writerDrop.code, { $numberInt: '13' }, 'readWrite cannot drop the database')
    equal(writerDrop.errmsg, 'not authorized on authz to execute command { dropDatabase: 1, $db: "authz" }', 'the dropDatabase refusal text matches mongod')
    const writerCreate = await command(writer.connection, { createUser: 'z_made_by_rw', pwd: 'x', roles: [], $db: database })
    equal(writerCreate.code, { $numberInt: '13' }, 'readWrite cannot create users')
    equal(
        writerCreate.errmsg,
        'not authorized on authz to execute command { createUser: "z_made_by_rw", pwd: "xxx", roles: [], $db: "authz" }',
        'the createUser refusal text redacts pwd'
    )
    const crossDb = await command(writer.connection, { find: 'items', filter: {}, $db: 'authx' })
    equal(crossDb.code, { $numberInt: '13' }, 'readWrite cannot read another database')
    equal(crossDb.errmsg, 'not authorized on authx to execute command { find: "items", filter: {}, $db: "authx" }', 'the cross-database refusal names its database')
    const listed = await command(writer.connection, { listDatabases: 1, $db: 'admin' })
    equal(listed.databases.map((entry) => entry.name), [database], 'listDatabases returns only authorized databases')
    const named = await command(writer.connection, { listDatabases: 1, nameOnly: true, $db: 'admin' })
    equal(named.databases, [{ name: database }], 'nameOnly strips the size fields')
    equal(Object.hasOwn(named, 'totalSize'), false, 'nameOnly omits totalSize')
    const allDatabases = await command(writer.connection, { listDatabases: 1, authorizedDatabases: false, $db: 'admin' })
    equal(allDatabases.code, { $numberInt: '13' }, 'authorizedDatabases false needs the cluster action')
    equal(allDatabases.errmsg, 'Insufficient permissions to list all databases', 'the listDatabases refusal text matches mongod')
    writer.connection.socket.destroy()

    // userAdmin: manages users, does not read data.
    const userAdmin = await loginAs('z_ua', database)
    equal((await command(userAdmin.connection, { usersInfo: 1, $db: database })).ok, { $numberDouble: '1.0' }, 'userAdmin can inspect users')
    equal(
        (await command(userAdmin.connection, { createUser: 'z_made', pwd: 'x', roles: [], $db: database })).ok,
        { $numberDouble: '1.0' },
        'userAdmin can create users'
    )
    equal((await command(userAdmin.connection, { find: 'items', filter: {}, $db: database })).code, { $numberInt: '13' }, 'userAdmin cannot read data')
    userAdmin.connection.socket.destroy()

    // clusterAdmin: cluster actions, not application data.
    const clusterAdmin = await loginAs('z_ca', 'admin')
    const clusterList = await command(clusterAdmin.connection, { listDatabases: 1, $db: 'admin' })
    ok(clusterList.databases.some((entry) => entry.name === database), 'clusterAdmin sees every database')
    equal(
        (await command(clusterAdmin.connection, { listDatabases: 1, authorizedDatabases: false, $db: 'admin' })).ok,
        { $numberDouble: '1.0' },
        'clusterAdmin can request the unfiltered database list'
    )
    equal((await command(clusterAdmin.connection, { serverStatus: 1, $db: 'admin' })).ok, { $numberDouble: '1.0' }, 'clusterAdmin can read serverStatus')
    equal((await command(clusterAdmin.connection, { find: 'items', filter: {}, $db: database })).code, { $numberInt: '13' }, 'clusterAdmin cannot read application data')
    clusterAdmin.connection.socket.destroy()

    // root: every privilege.
    const root = await loginAs('z_root', 'admin')
    equal((await command(root.connection, { find: 'items', filter: {}, $db: database })).ok, { $numberDouble: '1.0' }, 'root can read')
    equal((await command(root.connection, { usersInfo: { forAllDBs: true }, $db: database })).ok, { $numberDouble: '1.0' }, 'root can list every user')
    equal(
        (await command(root.connection, { listDatabases: 1, authorizedDatabases: false, $db: 'admin' })).ok,
        { $numberDouble: '1.0' },
        'root can request the unfiltered database list'
    )
    root.connection.socket.destroy()

    // `showPrivileges` expands the same table the dispatch layer enforces.
    const writerInfo = await command(login, { usersInfo: { user: 'z_rw', db: database }, showPrivileges: true, $db: database })
    equal(writerInfo.users[0].inheritedRoles, [{ role: 'readWrite', db: 'authz' }], 'inheritedRoles repeats the stored role')
    equal(writerInfo.users[0].inheritedPrivileges.length, 2, 'readWrite expands to two resources')
    equal(writerInfo.users[0].inheritedPrivileges[0].resource, { db: 'authz', collection: '' }, 'the first resource covers the database')
    for (const action of ['find', 'insert', 'update', 'remove']) {
        ok(writerInfo.users[0].inheritedPrivileges[0].actions.includes(action), `readWrite grant includes ${action}`)
    }
    const rootInfo = await command(login, { usersInfo: { user: 'z_root', db: 'admin' }, showPrivileges: true, $db: 'admin' })
    equal(rootInfo.users[0].inheritedPrivileges.length, 26, 'root expands to the 26 privileges mongod reports')
    const clusterInfo = await command(login, { usersInfo: { user: 'z_ca', db: 'admin' }, showPrivileges: true, $db: 'admin' })
    equal(clusterInfo.users[0].inheritedPrivileges.length, 14, 'clusterAdmin expands to the 14 privileges mongod reports')

    // SASLprep: mapping, NFKC and the prohibition tables, checked through the
    // official driver so the preparation happens on both sides.
    equal((await command(login, { createUser: 'sasl_nfc', pwd: 'p\u00e4ssw\u00f6rd', roles: [], $db: 'admin' })).ok, { $numberDouble: '1.0' }, 'a Latin-1 password is accepted')
    await driverLogin('sasl_nfc', 'p\u00e4ssw\u00f6rd', 'admin')
    assertions += 1
    equal((await command(login, { createUser: 'sasl_nfkc', pwd: '\u2163', roles: [], $db: 'admin' })).ok, { $numberDouble: '1.0' }, 'an NFKC password is accepted')
    await driverLogin('sasl_nfkc', 'IV', 'admin')
    assertions += 1
    await driverLogin('sasl_nfkc', '\u2163', 'admin')
    assertions += 1
    equal((await command(login, { createUser: 'sasl_nbsp', pwd: 'pa\u00a0ss', roles: [], $db: 'admin' })).ok, { $numberDouble: '1.0' }, 'a NBSP password is accepted')
    await driverLogin('sasl_nbsp', 'pa ss', 'admin')
    assertions += 1
    equal((await command(login, { createUser: 'sasl_soft', pwd: 'ab\u00adcd', roles: [], $db: 'admin' })).ok, { $numberDouble: '1.0' }, 'a soft-hyphen password is accepted')
    await driverLogin('sasl_soft', 'abcd', 'admin')
    assertions += 1
    equal((await command(login, { createUser: 'sasl_hebrew', pwd: '\u05d0', roles: [], $db: 'admin' })).ok, { $numberDouble: '1.0' }, 'a RandAL-only password is accepted')
    await driverLogin('sasl_hebrew', '\u05d0', 'admin')
    assertions += 1
    const prohibited = await command(login, { createUser: 'sasl_bad', pwd: 'a\u0007b', roles: [], $db: 'admin' })
    equal(prohibited.code, { $numberInt: '50692' }, 'a prohibited code point fails preparation')
    equal(prohibited.errmsg, 'Error preflighting normalization: U_STRINGPREP_PROHIBITED_ERROR', 'the prohibited-code text matches mongod')
    const bidi = await command(login, { createUser: 'sasl_bidi', pwd: '\u05d0a', roles: [], $db: 'admin' })
    equal(bidi.code, { $numberInt: '50692' }, 'a RandAL string with an LCat character fails preparation')
    equal(bidi.errmsg, 'Error preflighting normalization: U_STRINGPREP_CHECK_BIDI_ERROR', 'the bidi text matches mongod')

    // GS2: `n,,` and `y,,` are accepted; `a=` must name the authenticated user.
    const authzid = await connect(authAddress.port)
    const authzidSession = await scram(authzid, 'z_rw', 'secret', 'SCRAM-SHA-256', database, 'n,a=z_rw,')
    equal(authzidSession.finished.done, true, 'a matching GS2 authzid is accepted')
    authzid.socket.destroy()
    const emptyAuthzid = await connect(authAddress.port)
    const emptySession = await scram(emptyAuthzid, 'z_rw', 'secret', 'SCRAM-SHA-256', database, 'n,a=,')
    equal(emptySession.finished.done, true, 'an empty GS2 authzid is accepted')
    emptyAuthzid.socket.destroy()
    const wrongAuthzid = await connect(authAddress.port)
    const wrongSession = await scram(wrongAuthzid, 'z_rw', 'secret', 'SCRAM-SHA-256', database, 'n,a=z_read,')
    equal(wrongSession.start.code, { $numberInt: '18' }, 'a GS2 authzid naming another user fails authentication')
    wrongAuthzid.socket.destroy()
    const noChannelBinding = await connect(authAddress.port)
    const bindingSession = await scram(noChannelBinding, 'z_rw', 'secret', 'SCRAM-SHA-256', database, 'y,,')
    equal(bindingSession.finished.done, true, 'GS2 without channel binding is accepted')
    noChannelBinding.socket.destroy()
    // `mongod 8.0.9` never compares `c=` with the GS2 header it received, so a
    // proof over a different channel binding still logs in; measured with
    // `c=Zm9v`. The nonce and proof are still checked.
    const looseBinding = await connect(authAddress.port)
    const looseSession = await scram(looseBinding, 'z_rw', 'secret', 'SCRAM-SHA-256', database, 'n,,', 'Zm9v')
    equal(looseSession.finished.done, true, 'a proof over an arbitrary c= is accepted like mongod')
    looseBinding.socket.destroy()

    // dbAdmin may drop a database it administers; run it last because it
    // removes the users created above.
    const dbAdmin = await loginAs('z_dba', database)
    equal((await command(dbAdmin.connection, { create: 'z_created', $db: database })).ok, { $numberDouble: '1.0' }, 'dbAdmin can create a collection')
    equal((await command(dbAdmin.connection, { find: 'items', filter: {}, $db: database })).code, { $numberInt: '13' }, 'dbAdmin cannot read data')
    equal((await command(dbAdmin.connection, { dropDatabase: 1, $db: database })).ok, { $numberDouble: '1.0' }, 'dbAdmin can drop the database')
    equal((await command(dbAdmin.connection, { listCollections: 1, $db: database })).cursor.firstBatch, [], 'the dropped database has no collection')
    dbAdmin.connection.socket.destroy()
}

// --- dbStats ----------------------------------------------------------------

// Real byte counts from the stored documents, never a constant. The `acceptance`
// database holds `{_id: 1, v: 'a'}` and `{_id: 2, v: 'z'}` in one collection.
{
    const connection = await connect(address.port)
    const expectedSize = BSON.calculateObjectSize({ _id: 1, v: 'a' }) + BSON.calculateObjectSize({ _id: 2, v: 'z' })
    const stats = await command(connection, { dbStats: 1, $db: 'acceptance' })
    equal(stats.db, 'acceptance', 'dbStats names the database')
    equal(stats.collections, { $numberInt: '1' }, 'dbStats counts the stored collections')
    equal(stats.objects, { $numberInt: '2' }, 'dbStats counts the stored documents')
    equal(Number(stats.dataSize.$numberInt ?? stats.dataSize.$numberLong), expectedSize, 'dbStats sums the encoded document bytes')
    equal(Number(stats.avgObjSize.$numberInt ?? stats.avgObjSize.$numberDouble), expectedSize / 2, 'avgObjSize divides dataSize by objects')
    equal(stats.indexes, { $numberInt: '1' }, 'dbStats counts the implicit _id index')
    ok(Number(stats.indexSize.$numberInt) > 0, 'indexSize counts the key material the _id index holds')
    ok(Number(stats.storageSize.$numberInt) > expectedSize, 'storageSize counts the shard records, keys included')
    ok(Number(stats.fsTotalSize.$numberLong) > 0, 'filesystem sizes come from the host volume')

    const scaled = await command(connection, { dbStats: 1, scale: 1024, $db: 'acceptance' })
    equal(scaled.scaleFactor, { $numberInt: '1024' }, 'dbStats reports the scale factor')
    equal(Number(scaled.dataSize.$numberDouble), expectedSize / 1024, 'scaled dataSize stays a double')
    equal(Number(scaled.storageSize.$numberInt), Math.floor(Number(stats.storageSize.$numberInt) / 1024), 'scaled storageSize shrinks')

    const absent = await command(connection, { dbStats: 1, $db: 'never_created' })
    equal(absent.collections, { $numberInt: '0' }, 'an absent database has no collections')
    equal(absent.fsUsedSize, { $numberLong: '0' }, 'an absent database reports zero filesystem usage')

    const invalid = await command(connection, { dbStats: 1, scale: 0, $db: 'acceptance' })
    equal(invalid.code, { $numberInt: '2' }, 'a zero scale is a bad value')
    equal(invalid.errmsg, 'Scale factor must be greater than zero', 'the scale text matches mongod')

    // `collection.stats()` sends exactly `collStats`, so the three surfaces
    // must report one set of numbers.
    const collection = await command(connection, { collStats: 'compressed', $db: 'acceptance' })
    equal(collection.ns, 'acceptance.compressed', 'collStats names the namespace')
    equal(collection.count, { $numberInt: '2' }, 'collStats counts the stored documents')
    equal(collection.size, stats.dataSize, 'collStats size matches dbStats dataSize')
    equal(collection.nindexes, stats.indexes, 'collStats nindexes matches dbStats indexes')
    equal(collection.totalIndexSize, stats.indexSize, 'collStats totalIndexSize matches dbStats indexSize')
    equal(collection.indexSizes, { _id_: stats.indexSize }, 'the implicit _id index is the only index')
    equal(collection.avgObjSize, stats.avgObjSize, 'collStats truncates avgObjSize like mongod')
    const totalSize = Number(collection.totalSize.$numberInt ?? collection.totalSize.$numberLong)
    const storageSize = Number(collection.storageSize.$numberInt ?? collection.storageSize.$numberLong)
    const indexSize = Number(collection.totalIndexSize.$numberInt ?? collection.totalIndexSize.$numberLong)
    equal(totalSize, storageSize + indexSize, 'totalSize adds the index bytes to the storage bytes')
    const absentCollection = await command(connection, { collStats: 'no_such', $db: 'acceptance' })
    equal(absentCollection.nindexes, { $numberInt: '0' }, 'a missing collection has no indexes')
    equal(absentCollection.indexSizes, {}, 'a missing collection reports no index sizes')
    equal(absentCollection.totalIndexSize, { $numberInt: '0' }, 'a missing collection reports zero index bytes')
    const badScale = await command(connection, { collStats: 'compressed', scale: 0, $db: 'acceptance' })
    equal(badScale.code, { $numberInt: '2' }, 'collStats rejects a zero scale')
    equal(badScale.errmsg, "BSON field 'scale' value must be >= 1, actual value '0'", 'the collStats scale text matches mongod')
    const badName = await command(connection, { collStats: 5, $db: 'acceptance' })
    equal(badName.code, { $numberInt: '14' }, 'collStats rejects a non-string collection name')
    equal(badName.errmsg, 'collection name has invalid type int', 'the collStats name text matches mongod')
    connection.socket.destroy()
}

// --- usersInfo (`show users`) ----------------------------------------------

{
    const inspector = await connect(authAddress.port)
    const session = await scram(inspector, 'root', 'root-pass')
    equal(session.finished.done, true, 'the inspector logs in')

    const all = await command(inspector, { usersInfo: 1, $db: 'admin' })
    ok(Array.isArray(all.users), 'usersInfo answers a users array')
    const root = all.users.find((entry) => entry.user === 'root')
    ok(root !== undefined, 'the root user is listed')
    equal(root._id, 'admin.root', 'the user id names the database')
    equal(root.db, 'admin', 'the user reports its database')
    equal(root.roles, [{ role: 'root', db: 'admin' }], 'the roles are reported as documents')
    equal(root.mechanisms, ['SCRAM-SHA-1', 'SCRAM-SHA-256'], 'both registered mechanisms are reported')
    equal(Object.hasOwn(root, 'credentials'), false, 'credentials stay hidden by default')

    const withCredentials = await command(inspector, { usersInfo: 'root', showCredentials: true, $db: 'admin' })
    ok(withCredentials.users[0].credentials['SCRAM-SHA-1'] !== undefined, 'showCredentials reveals the SHA-1 credential')
    equal(Number(withCredentials.users[0].credentials['SCRAM-SHA-1'].iterationCount.$numberInt), 10000, 'the SHA-1 iteration count is mongod\u2019s')
    equal(Number(withCredentials.users[0].credentials['SCRAM-SHA-256'].iterationCount.$numberInt), 15000, 'the SHA-256 iteration count is mongod\u2019s')

    const byName = await command(inspector, { usersInfo: [{ user: 'root', db: 'admin' }], $db: 'admin' })
    equal(byName.users.length, 1, 'an array of lookups is answered')
    const ghost = await command(inspector, { usersInfo: 'ghost', $db: 'admin' })
    equal(ghost.users, [], 'a missing user yields an empty array')
    const everything = await command(inspector, { usersInfo: { forAllDBs: true }, $db: 'admin' })
    ok(everything.users.length >= 3, 'forAllDBs lists every stored user')

    const wrongType = await command(inspector, { usersInfo: true, $db: 'admin' })
    equal(wrongType.code, { $numberInt: '2' }, 'a boolean lookup is a bad value')
    equal(wrongType.errmsg, 'UserName must be either a string or an object', 'the lookup type text matches mongod')
    const noDatabase = await command(inspector, { usersInfo: { user: 'root' }, $db: 'admin' })
    equal(noDatabase.errmsg, 'UserName must contain a field named: db', 'a lookup without db matches mongod')
    const empty = await command(inspector, { usersInfo: [], $db: 'admin' })
    equal(empty.errmsg, '$or argument must be a non-empty array', 'an empty lookup array matches mongod')
    inspector.socket.destroy()
}

// --- replica set ------------------------------------------------------------

const replicaDir = mkdtempSync(join(tmpdir(), 'mongo-rs-'))
const replicaServer = createServer({ dataDir: replicaDir, port: 0, replSet: 'rs0' })
const replicaAddress = await replicaServer.listening
const replicaConnection = await connect(replicaAddress.port)
const replicaMe = `127.0.0.1:${replicaAddress.port}`

const beforeInitiate = await command(replicaConnection, { hello: 1, $db: 'admin' })
{
    equal(Object.hasOwn(beforeInitiate, 'topologyVersion'), true, 'hello announces the topology version')
    ok(typeof beforeInitiate.topologyVersion.processId.$oid === 'string', 'topologyVersion carries a process id')
    equal(beforeInitiate.isWritablePrimary, false, 'an uninitiated set is not writable')
    equal(beforeInitiate.secondary, false, 'an uninitiated member is not secondary')
    equal(beforeInitiate.info, 'Does not have a valid replica set config', 'the uninitiated text matches mongod')
    equal(beforeInitiate.isreplicaset, true, 'an uninitiated set reports isreplicaset')
    equal(beforeInitiate.maxWireVersion, { $numberInt: '25' }, 'the wire version is 25')
    equal(beforeInitiate.logicalSessionTimeoutMinutes, { $numberInt: '30' }, 'sessions time out in 30 minutes')
    ok(typeof beforeInitiate.connectionId.$numberInt === 'string', 'hello carries a connectionId')

    const legacy = await command(replicaConnection, { isMaster: 1, $db: 'admin' })
    equal(legacy.ismaster, false, 'isMaster uses the legacy writable field')
    equal(Object.hasOwn(legacy, 'isWritablePrimary'), false, 'isMaster omits isWritablePrimary')

    const notYet = await command(replicaConnection, { replSetGetStatus: 1, $db: 'admin' })
    equal(notYet.code, { $numberInt: '94' }, 'status before initiation matches mongod')
    equal(notYet.errmsg, 'no replset config has been received', 'the not-yet text matches mongod')

    const initiated = await command(replicaConnection, { replSetInitiate: {}, $db: 'admin' })
    equal(initiated.ok, { $numberDouble: '1.0' }, 'an empty initiate uses the default configuration')
    equal(initiated.info2, 'no configuration specified. Using a default configuration for the set', 'the default-config text matches mongod')
    equal(initiated.me, replicaMe, 'the default member is the address the client used')

    const repeated = await command(replicaConnection, { replSetInitiate: {}, $db: 'admin' })
    equal(repeated.code, { $numberInt: '23' }, 'a second initiate is rejected')
    equal(repeated.errmsg, 'already initialized', 'the already-initialized text matches mongod')

    const config = (await command(replicaConnection, { replSetGetConfig: 1, $db: 'admin' })).config
    equal(config._id, 'rs0', 'the config carries the command-line set name')
    equal(config.version, { $numberInt: '1' }, 'the config version starts at one')
    equal(config.term, { $numberInt: '0' }, 'a fresh config has no term')
    equal(config.members.length, 1, 'the default config has one member')
    equal(config.members[0]._id, { $numberInt: '0' }, 'the member id is zero')
    equal(config.members[0].host, replicaMe, 'the member host is the connection address')
    equal(config.protocolVersion, { $numberLong: '1' }, 'protocolVersion is a long like mongod')
    ok(typeof config.settings.replicaSetId.$oid === 'string', 'the config carries a replica set id')

    const status = await command(replicaConnection, { replSetGetStatus: 1, $db: 'admin' })
    equal(status.set, 'rs0', 'status names the set')
    equal(status.myState, { $numberInt: '1' }, 'the member is primary')
    equal(status.members.length, 1, 'status lists one member')
    equal(status.members[0]._id, { $numberInt: '0' }, 'the member id is zero')
    equal(status.members[0].stateStr, 'PRIMARY', 'the member state string is PRIMARY')
    equal(status.members[0].syncSourceHost, '', 'a primary has no sync source')
    equal(status.members[0].configVersion, { $numberInt: '1' }, 'the member reports its config version')
    ok(status.members[0].optime.ts.$timestamp !== undefined, 'the member reports an optime')
    equal(status.syncSourceHost, '', 'status has no sync source')

    const after = await command(replicaConnection, { hello: 1, $db: 'admin' })
    equal(after.isWritablePrimary, true, 'initiation makes the member writable')
    equal(after.secondary, false, 'the member is not secondary')
    equal(after.setName, 'rs0', 'hello names the set')
    equal(after.hosts, [replicaMe], 'hello lists the member host')
    equal(after.primary, replicaMe, 'hello names the primary')
    equal(after.me, replicaMe, 'hello names this member')
    ok(
        Number(after.topologyVersion.counter.$numberLong) > Number(beforeInitiate.topologyVersion.counter.$numberLong),
        'the topology counter advances when the member state changes'
    )

    const write = await command(replicaConnection, { insert: 'items', documents: [{ _id: 1, ok: true }], $db: 'rs_accept' })
    equal(write.ok, { $numberDouble: '1.0' }, 'a write lands on the replica set')
    const advanced = await command(replicaConnection, { replSetGetStatus: 1, $db: 'admin' })
    equal(advanced.members[0].optime.t, { $numberLong: '1' }, 'the optime term becomes 1 after a write')
}

{
    const freshDir = mkdtempSync(join(tmpdir(), 'mongo-rs-fresh-'))
    const freshServer = createServer({ dataDir: freshDir, port: 0, replSet: 'rs0' })
    const freshAddress = await freshServer.listening
    const fresh = await connect(freshAddress.port)

    const wrongName = await command(fresh, { replSetInitiate: { _id: 'wrong', members: [{ _id: 0, host: '127.0.0.1:1' }] }, $db: 'admin' })
    equal(wrongName.code, { $numberInt: '93' }, 'a mismatched set name is rejected')
    ok(wrongName.errmsg.includes('initiate set name: wrong, command line set name: rs0'), 'the mismatch text names both sets')

    const missingMembers = await command(fresh, { replSetInitiate: { _id: 'rs0' }, $db: 'admin' })
    equal(missingMembers.errmsg, "BSON field 'ReplSetConfig.members' is missing but a required field", 'a config without members matches mongod')

    const emptyMembers = await command(fresh, { replSetInitiate: { _id: 'rs0', members: [] }, $db: 'admin' })
    equal(
        emptyMembers.errmsg,
        'Replica set configuration contains 0 members, but must have at least 1 and no more than  50',
        'an empty member list matches mongod'
    )

    const noHost = await command(fresh, { replSetInitiate: { _id: 'rs0', members: [{ _id: 0 }] }, $db: 'admin' })
    ok(noHost.errmsg.startsWith("member: { _id: 0 } :: caused by :: BSON field 'MemberConfig.host'"), 'a member without host matches mongod')

    const numeric = await command(fresh, { replSetInitiate: 1, $db: 'admin' })
    equal(numeric.info2, 'no configuration specified. Using a default configuration for the set', 'a numeric initiate also uses the default configuration')
    fresh.socket.destroy()
    await freshServer.close()
}

{
    const standalone = await connect(address.port)
    const status = await command(standalone, { replSetGetStatus: 1, $db: 'admin' })
    equal(status.code, { $numberInt: '76' }, 'a standalone node has no replication')
    equal(status.errmsg, 'not running with --replSet', 'the standalone status text matches mongod')
    const config = await command(standalone, { replSetGetConfig: 1, $db: 'admin' })
    equal(config.code, { $numberInt: '76' }, 'a standalone node has no config')
    const initiate = await command(standalone, { replSetInitiate: {}, $db: 'admin' })
    equal(initiate.code, { $numberInt: '76' }, 'a standalone node cannot be initiated')
    equal(initiate.errmsg, 'This node was not started with replication enabled.', 'the standalone initiate text matches mongod')
    standalone.socket.destroy()
}

{
    const replicaClient = new MongoClient(`mongodb://127.0.0.1:${replicaAddress.port}/?replicaSet=rs0`, {
        serverSelectionTimeoutMS: 5000
    })
    await replicaClient.connect()
    equal(replicaClient.topology.description.type, 'ReplicaSetWithPrimary', 'the driver discovers the primary without directConnection')
    const session = replicaClient.startSession()
    await session.withTransaction(async () => {
        const items = replicaClient.db('rs_accept').collection('items')
        await items.insertOne({ _id: 2, ok: true }, { session })
    })
    await session.endSession()
    equal((await replicaClient.db('rs_accept').collection('items').findOne({ _id: 2 })).ok, true, 'a transaction commits on the replica set')
    // Outside a transaction the driver still stamps `txnNumber`, which makes the
    // write retryable; `mongod` accepts it without an open transaction.
    await replicaClient.db('rs_accept').collection('items').insertOne({ _id: 3, ok: true })
    equal((await replicaClient.db('rs_accept').collection('items').findOne({ _id: 3 })).ok, true, 'a retryable write outside a transaction lands')
    await replicaClient.close()
}

// --- replica set write concern, oplog and readPreference --------------------
//
// Every expected shape below was captured from `mongod 8.0.9` on a single-member
// set: the reply field order, the `writeConcernError` codes and texts, the
// `local.oplog.rs` entries, and the `$readPreference` validation errors.

{
    const db = 'rs_oplog'
    const inserted = await command(replicaConnection, { insert: 'c', documents: [{ _id: 401, a: 1 }], $db: db })
    equal(inserted.n, { $numberInt: '1' }, 'an acknowledged insert reports n')
    ok(typeof inserted.electionId.$oid === 'string', 'the insert reply carries electionId')
    equal(inserted.opTime.t, { $numberLong: '1' }, 'the insert reply carries the term')
    ok(inserted.opTime.ts.$timestamp !== undefined, 'the insert reply carries the optime timestamp')

    const updated = await command(replicaConnection, { update: 'c', updates: [{ q: { _id: 401 }, u: { $set: { a: 2 } } }], $db: db })
    equal(updated.nModified, { $numberInt: '1' }, 'an acknowledged update reports nModified')
    ok(updated.opTime.ts.$timestamp !== undefined, 'the update reply carries the optime')

    const upserted = await command(replicaConnection, { update: 'c', updates: [{ q: { _id: 402 }, u: { $set: { a: 3 } }, upsert: true }], $db: db })
    equal(upserted.upserted, [{ index: { $numberInt: '0' }, _id: { $numberInt: '402' } }], 'an upsert reply lists the inserted id')
    equal(upserted.nModified, { $numberInt: '0' }, 'an upsert reports no modification')

    const removed = await command(replicaConnection, { delete: 'c', deletes: [{ q: { _id: 402 }, limit: 1 }], $db: db })
    equal(removed.n, { $numberInt: '1' }, 'an acknowledged delete reports n')

    const unacknowledged = await command(replicaConnection, { insert: 'c', documents: [{ _id: 403 }], writeConcern: { w: 0 }, $db: db })
    equal(unacknowledged, { n: { $numberInt: '0' }, ok: { $numberDouble: '1.0' } }, 'w: 0 withholds the counters')

    const unsatisfiable = await command(replicaConnection, { insert: 'c', documents: [{ _id: 404 }], writeConcern: { w: 2 }, $db: db })
    equal(unsatisfiable.ok, { $numberDouble: '1.0' }, 'an unsatisfiable w still applies the write')
    equal(unsatisfiable.writeConcernError?.code, { $numberInt: '100' }, 'w: 2 on one member is UnsatisfiableWriteConcern')
    equal(unsatisfiable.writeConcernError?.codeName, 'UnsatisfiableWriteConcern', 'the unsatisfiable code name matches mongod')
    equal(unsatisfiable.writeConcernError?.errmsg, 'Not enough data-bearing nodes', 'the unsatisfiable text matches mongod')
    equal(
        unsatisfiable.writeConcernError?.errInfo.writeConcern,
        { w: { $numberInt: '2' }, wtimeout: { $numberInt: '0' }, provenance: 'clientSupplied' },
        'errInfo repeats the client supply'
    )

    const unknownTag = await command(replicaConnection, { insert: 'c', documents: [{ _id: 405 }], writeConcern: { w: 'tag', wtimeout: 100 }, $db: db })
    equal(unknownTag.ok, { $numberDouble: '1.0' }, 'an unknown write concern still applies the write')
    equal(unknownTag.writeConcernError?.code, { $numberInt: '79' }, 'an unknown tag is UnknownReplWriteConcern')
    equal(
        unknownTag.writeConcernError?.errmsg,
        "No write concern mode named 'tag' found in replica set configuration",
        'the unknown-tag text matches mongod'
    )

    const majority = await command(replicaConnection, { insert: 'c', documents: [{ _id: 406 }], writeConcern: { w: 'majority', j: true }, $db: db })
    equal(majority.ok, { $numberDouble: '1.0' }, 'majority is satisfied by the one member')
    equal(Object.hasOwn(majority, 'writeConcernError'), false, 'a satisfied write concern carries no error')

    const many = await command(replicaConnection, { insert: 'c', documents: [{ _id: 407 }, { _id: 408 }], $db: db })
    equal(many.n, { $numberInt: '2' }, 'a two-document insert reports n: 2')

    await command(replicaConnection, { create: 'logged', $db: db })
    await command(replicaConnection, { createIndexes: 'c', indexes: [{ key: { a: 1 }, name: 'a_1' }], $db: db })

    // The oplog is a real collection, written before the acknowledgement.
    const oplog = await command(replicaConnection, { find: 'oplog.rs', filter: { ns: `${db}.c` }, $db: 'local' })
    const entries = oplog.cursor.firstBatch
    ok(entries.length >= 7, 'every write above produced an oplog entry')

    const insertEntry = entries[0]
    equal(Object.keys(insertEntry), ['op', 'ns', 'ui', 'o', 'o2', 'ts', 't', 'v', 'wall'], 'an insert entry keeps mongod field order')
    equal(insertEntry.op, 'i', 'an insert entry uses op i')
    equal(insertEntry.ns, `${db}.c`, 'an insert entry names its namespace')
    equal(insertEntry.o, { _id: { $numberInt: '401' }, a: { $numberInt: '1' } }, 'an insert entry stores the document')
    equal(insertEntry.o2, { _id: { $numberInt: '401' } }, 'an insert entry carries the id in o2')
    equal(insertEntry.t, { $numberLong: '1' }, 'the oplog entry carries the term')
    equal(insertEntry.v, { $numberInt: '2' }, 'the oplog entry carries v: 2')
    ok(insertEntry.ts.$timestamp !== undefined, 'the oplog entry carries a timestamp')
    ok(insertEntry.wall.$date !== undefined, 'the oplog entry carries wall time')
    equal(Object.hasOwn(insertEntry, 'h'), false, '8.0.9 no longer writes the h field')

    const updateEntry = entries.find((entry) => entry.op === 'u')
    equal(
        updateEntry?.o,
        { $v: { $numberInt: '2' }, diff: { u: { a: { $numberInt: '2' } } } },
        'an update entry stores a $v: 2 diff'
    )
    equal(updateEntry?.o2, { _id: { $numberInt: '401' } }, 'an update entry carries the id in o2')

    const upsertEntry = entries.find((entry) => entry.o?._id?.$numberInt === '402')
    equal(upsertEntry?.op, 'i', 'an upsert is logged as an insert')
    equal(upsertEntry?.o2, { _id: { $numberInt: '402' } }, 'the upsert entry carries the id in o2')

    const deleteEntry = entries.find((entry) => entry.op === 'd' && entry.o?._id?.$numberInt === '402')
    equal(Object.keys(deleteEntry), ['op', 'ns', 'ui', 'o', 'ts', 't', 'v', 'wall'], 'a delete entry has no o2')
    equal(Object.hasOwn(deleteEntry, 'o2'), false, 'a delete entry omits o2')

    const applyOps = (await command(replicaConnection, { find: 'oplog.rs', filter: { ns: 'admin.$cmd' }, $db: 'local' }))
        .cursor.firstBatch.find((entry) => entry.o?.applyOps !== undefined)
    equal(applyOps?.ns, 'admin.$cmd', 'a multi-document insert is logged on admin.$cmd')
    equal(applyOps?.o.applyOps.length, 2, 'a multi-document insert folds both documents into applyOps')
    equal(applyOps?.o.applyOps[0].op, 'i', 'each applyOps entry keeps its op')
    equal(applyOps?.o.applyOps[0].o2, { _id: { $numberInt: '407' } }, 'each applyOps entry keeps its o2')

    const newest = entries[entries.length - 1]
    equal(newest.ts, majority.opTime.ts, 'the last acknowledged reply reported the oplog timestamp')

    const createdEntry = (await command(replicaConnection, { find: 'oplog.rs', filter: { ns: `${db}.$cmd`, 'o.create': 'logged' }, $db: 'local' })).cursor.firstBatch[0]
    equal(createdEntry.op, 'c', 'a create is logged as a command')
    equal(createdEntry.o.idIndex, { v: { $numberInt: '2' }, key: { _id: { $numberInt: '1' } }, name: '_id_' }, 'a create logs the id index')

    const indexEntry = (await command(replicaConnection, { find: 'oplog.rs', filter: { ns: `${db}.$cmd`, 'o.createIndexes': 'c' }, $db: 'local' })).cursor.firstBatch[0]
    equal(indexEntry.o.name, 'a_1', 'a createIndexes logs the index name')
    equal(indexEntry.o.key, { a: { $numberInt: '1' } }, 'a createIndexes logs the key')

    const description = (await command(replicaConnection, { listCollections: 1, filter: { name: 'oplog.rs' }, $db: 'local' })).cursor.firstBatch[0]
    equal(
        description.options,
        { capped: true, size: { $numberLong: '1038090240' }, autoIndexId: false },
        'the oplog is described as a capped collection'
    )
    equal(Object.hasOwn(description, 'idIndex'), false, 'the oplog description carries no idIndex')

    // Drop: counters, guards and texts.
    const dropped = await command(replicaConnection, { drop: 'c', $db: db })
    equal(dropped.nIndexesWas, { $numberInt: '2' }, 'drop counts the id index plus the user index')
    equal(dropped.ns, `${db}.c`, 'drop names its namespace')
    equal(dropped.ok, { $numberDouble: '1.0' }, 'drop is acknowledged')
    equal(Object.hasOwn(dropped, 'electionId'), false, 'drop carries no electionId')

    const droppedMissing = await command(replicaConnection, { drop: 'ghost', $db: db })
    equal(droppedMissing, { ok: { $numberDouble: '1.0' } }, 'dropping a missing collection replies ok only')

    const liveOplog = await command(replicaConnection, { drop: 'oplog.rs', $db: 'local' })
    equal(liveOplog.code, { $numberInt: '5255000' }, 'the live oplog cannot be dropped')
    equal(liveOplog.codeName, 'Location5255000', 'the oplog guard code name matches mongod')
    equal(liveOplog.errmsg, "can't drop live oplog while replicating", 'the oplog guard text matches mongod')

    const systemCollection = await command(replicaConnection, { drop: 'system.replset', $db: 'local' })
    equal(systemCollection.code, { $numberInt: '20' }, 'local system collections cannot be dropped')
    equal(systemCollection.errmsg, 'cannot drop system collection local.system.replset', 'the system guard text matches mongod')

    const version = await command(replicaConnection, { drop: 'system.version', $db: 'admin' })
    equal(version.code, { $numberInt: '20' }, 'admin system collections cannot be dropped')
    equal(version.errmsg, 'cannot drop system collection admin.system.version', 'the admin guard names the namespace')

    const wrongName = await command(replicaConnection, { drop: 1, $db: db })
    equal(wrongName.code, { $numberInt: '14' }, 'a non-string drop name is a type mismatch')
    equal(wrongName.errmsg, 'collection name has invalid type int', 'the drop type text matches mongod')

    // `$readPreference` is validated and then ignored; routing is the client's job.
    const bogus = await command(replicaConnection, { find: 'log', filter: {}, $readPreference: { mode: 'bogus' }, $db: db })
    equal(bogus.code, { $numberInt: '2' }, 'an unknown read preference mode is BadValue')
    equal(
        bogus.errmsg,
        "Enumeration value 'bogus' for field 'readPreference.mode' is not a valid value.",
        'the mode text matches mongod'
    )

    const notObject = await command(replicaConnection, { find: 'log', filter: {}, $readPreference: 'secondary', $db: db })
    equal(notObject.code, { $numberInt: '14' }, 'a non-document read preference is a type mismatch')
    equal(notObject.errmsg, '$readPreference has incorrect type: expected object but got string', 'the type text matches mongod')

    const noMode = await command(replicaConnection, { find: 'log', filter: {}, $readPreference: {}, $db: db })
    equal(noMode.code, { $numberInt: '40414' }, 'a read preference without mode is an IDL failure')
    equal(noMode.errmsg, "BSON field 'readPreference.mode' is missing but a required field", 'the missing-mode text matches mongod')

    const secondary = await command(replicaConnection, { insert: 'rp', documents: [{ _id: 1 }], $db: db })
    equal(secondary.ok, { $numberDouble: '1.0' }, 'the read preference fixture is written')
    const secondaryRead = await command(replicaConnection, { find: 'rp', filter: {}, $readPreference: { mode: 'secondary' }, $db: db })
    equal(secondaryRead.cursor.firstBatch.length, 1, 'secondary is answered by the only member, as the raw server does')
}

// A standalone server refuses `w` and named write concerns before writing.
{
    const standalone = await connect(address.port)
    const replicated = await command(standalone, { insert: 'wc', documents: [{ _id: 1 }], writeConcern: { w: 2 }, $db: 'standalone_wc' })
    equal(replicated.code, { $numberInt: '2' }, 'a standalone rejects w > 1')
    equal(replicated.errmsg, "cannot use 'w' > 1 when a host is not replicated", 'the standalone w text matches mongod')
    equal((await command(standalone, { find: 'wc', filter: {}, $db: 'standalone_wc' })).cursor.firstBatch.length, 0, 'the refused write never lands')

    const tagged = await command(standalone, { insert: 'wc', documents: [{ _id: 2 }], writeConcern: { w: 'tag' }, $db: 'standalone_wc' })
    equal(tagged.code, { $numberInt: '2' }, 'a standalone rejects a named write concern')
    equal(
        tagged.errmsg,
        "cannot use non-majority 'w' mode \"tag\" when a host is not a member of a replica set",
        'the standalone tag text matches mongod'
    )

    const boolW = await command(standalone, { insert: 'wc', documents: [{ _id: 3 }], writeConcern: { w: true }, $db: 'standalone_wc' })
    equal(boolW.code, { $numberInt: '9' }, 'a boolean w is FailedToParse')
    equal(boolW.errmsg, 'w has to be a number, string, or object; found: bool', 'the w type text matches mongod')

    const wrongConcern = await command(standalone, { insert: 'wc', documents: [{ _id: 4 }], writeConcern: 5, $db: 'standalone_wc' })
    equal(wrongConcern.code, { $numberInt: '14' }, 'a non-document writeConcern is a type mismatch')
    equal(wrongConcern.errmsg, '"writeConcern" had the wrong type. Expected object, found int', 'the writeConcern type text matches mongod')

    const majority = await command(standalone, { insert: 'wc', documents: [{ _id: 5 }], writeConcern: { w: 'majority', j: true }, $db: 'standalone_wc' })
    equal(majority.ok, { $numberDouble: '1.0' }, 'majority works on a standalone server')
    standalone.socket.destroy()
}

replicaConnection.socket.destroy()
await replicaServer.close()

login.socket.destroy()
await authServer.close()

await server.close()
console.log(`server acceptance: ${assertions} assertions`)
