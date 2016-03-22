// Client-compatibility acceptance: OP_COMPRESSED and handshake negotiation.
//
// Unit expectations for the codecs come from `mongod 8.0.9` (the snappy fixture
// below is a real reply captured from it). The end-to-end half drives the
// official Node driver with compression enabled, which is the gate that matters
// for drop-in use.
import assert from 'node:assert/strict'
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

await server.close()
console.log(`server acceptance: ${assertions} assertions`)
