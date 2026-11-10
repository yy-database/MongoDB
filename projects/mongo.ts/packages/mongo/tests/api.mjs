// Product-surface acceptance for the `MongoDB` / `MongoDBClient` constructors.
//
// The expectations follow MongoDB driver semantics: typed BSON values keep
// their identity through the extended-JSON ABI, `find` stays lazy until the
// first pull, cursors are stateful resources that close on early break, and
// every failure carries the family error envelope. The local half runs the
// engine in-process; the remote half talks to `createServer` over the wire.
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Int32, ObjectId } from '../src/bson.ts'
import { MongoDBClient } from '../src/client.ts'
import { asyncDisposeSymbol } from '../src/cursor.ts'
import { MongoError } from '../src/errors.ts'
import { MongoDB } from '../src/mongo.ts'
import { createServer } from '../src/server.ts'

let assertions = 0
function ok(condition, message) {
    assertions += 1
    assert.ok(condition, message)
}
function equal(actual, expected, message) {
    assertions += 1
    assert.deepEqual(actual, expected, message)
}
function strictEqual(actual, expected, message) {
    assertions += 1
    assert.strictEqual(actual, expected, message)
}

/** Runs a call that must fail and hands the caught error to `validate`. */
async function rejects(call, validate, message) {
    assertions += 1
    let error
    try {
        await (typeof call === 'function' ? call() : call)
    } catch (caught) {
        error = caught
    }
    ok(error !== undefined, `${message}: expected a failure`)
    ok(error instanceof MongoError, `${message}: rejects with MongoError`)
    validate(error)
}

// --- configuration -----------------------------------------------------------

{
    await rejects(
        () => new MongoDBClient({ url: 'mongodb://127.0.0.1:27017', seeds: [{ host: '127.0.0.1', port: 27017 }] }),
        (error) => strictEqual(error.code, 'ConfigurationError', 'url and seeds are mutually exclusive'),
        'url with seeds'
    )
    await rejects(
        () => new MongoDBClient({}),
        (error) => strictEqual(error.phase, 'configuration', 'one of url or seeds is required'),
        'url without seeds'
    )
    await rejects(
        () => new MongoDBClient({ url: 'mongodb+srv://cluster.example' }),
        (error) => strictEqual(error.code, 'ConfigurationError', 'mongodb+srv is rejected'),
        'srv scheme'
    )
    await rejects(
        () => new MongoDB({ storage: { directory: '' } }),
        (error) => strictEqual(error.code, 'ConfigurationError', 'an empty directory is refused'),
        'empty storage directory'
    )
}

// --- local engine lifecycle ---------------------------------------------------

{
    const dataDir = mkdtempSync(join(tmpdir(), 'mongo-api-local-'))
    const engine = new MongoDB({ storage: { directory: dataDir } })
    strictEqual(engine.state, 'new', 'a fresh engine is new')
    const [first, second] = await Promise.all([engine.open(), engine.open()])
    ok(first === engine && second === engine, 'concurrent opens join the same operation')
    strictEqual(engine.state, 'open', 'the engine is open')
    await rejects(
        () => engine.open(),
        (error) => strictEqual(error.code, 'AlreadyOpen', 'a second open refuses'),
        'double open'
    )
    ok(typeof engine[asyncDisposeSymbol] === 'function', 'the engine carries Symbol.asyncDispose')
    await engine.close()
    await engine.close()
    strictEqual(engine.state, 'closed', 'repeat closes succeed')
    await rejects(
        () => engine.open(),
        (error) => strictEqual(error.code, 'Closed', 'a closed engine is final'),
        'reopen'
    )
    await rejects(
        () => engine.db('app').collection('items').insertOne({ v: 1 }),
        (error) => strictEqual(error.code, 'Closed', 'commands after close fail before sending'),
        'command on closed engine'
    )
    ok(existsSync(join(dataDir, 'mongo.yykv')), 'the persistent shard survives the engine')

    // The ephemeral default lives under the system temporary directory.
    const ephemeral = new MongoDB()
    await ephemeral.open()
    await ephemeral.close()
    strictEqual(ephemeral.state, 'closed', 'the ephemeral engine closed')
}

// --- BSON identity through the local engine ------------------------------------

{
    const engine = new MongoDB()
    await engine.open()
    const items = engine.db('app').collection('items')

    const identifier = new ObjectId()
    const stamp = new Date(1_700_000_000_123)
    const bytes = new Uint8Array([1, 2, 250, 0])
    const result = await items.insertOne({
        _id: identifier,
        int: new Int32(5),
        plain: 5,
        half: 1.5,
        big: 9007199254740993n,
        at: stamp,
        bin: bytes
    })
    ok(result.acknowledged, 'insertOne is acknowledged')
    ok(result.insertedId instanceof ObjectId && result.insertedId.equals(identifier), 'insertOne answers with the inserted id')

    const stored = await items.findOne({ _id: identifier })
    ok(stored !== null, 'findOne returns the document')
    ok(stored._id instanceof ObjectId && stored._id.toHexString() === identifier.toHexString(), 'ObjectId survives the round trip')
    ok(stored.int instanceof Int32 && stored.int.value === 5, 'Int32 stays Int32')
    strictEqual(typeof stored.plain, 'number', 'a plain number decodes back to number')
    ok(!(stored.plain instanceof Int32), 'a plain number is not Int32')
    strictEqual(stored.half, 1.5, 'Double survives the round trip')
    strictEqual(typeof stored.big, 'bigint', 'Int64 decodes to bigint')
    strictEqual(stored.big, 9007199254740993n, 'Int64 keeps precision a JSON round trip would lose')
    ok(stored.at instanceof Date && stored.at.getTime() === stamp.getTime(), 'DateTime keeps its milliseconds')
    equal(Array.from(stored.bin), Array.from(bytes), 'Binary decodes to Uint8Array')

    await rejects(
        () => items.insertOne({ _id: identifier }),
        (error) => {
            strictEqual(error.product, 'mongodb', 'the envelope names the product')
            strictEqual(error.code, '11000', 'the envelope carries the server code as text')
            strictEqual(error.codeName, 'DuplicateKey', 'the envelope carries codeName')
            strictEqual(error.serverCode, 11000, 'the numeric wire code is preserved')
            strictEqual(error.phase, 'execute', 'a command failure belongs to execute')
            strictEqual(error.execution, 'replied', 'the engine answered')
            strictEqual(error.retry, 'never', 'a duplicate is not blindly retryable')
        },
        'duplicate _id'
    )

    const many = await items.insertMany([{ tag: 'a' }, { tag: 'b' }])
    strictEqual(many.insertedCount, 2, 'insertMany reports the inserted count')
    ok(many.insertedIds[0] instanceof ObjectId && many.insertedIds[1] instanceof ObjectId, 'insertMany answers with per-index ids')

    const silent = await items.insertOne({ tag: 'quiet' }, { writeConcern: { w: 0 } })
    equal(silent, { acknowledged: false }, 'w:0 acknowledges nothing')
    ok(!Object.hasOwn(silent, 'insertedId'), 'the unacknowledged branch carries no counters')
    ok((await items.findOne({ tag: 'quiet' })) !== null, 'the unacknowledged write still landed')

    await engine.close()
}

// --- find builder and cursor state ---------------------------------------------

{
    const engine = new MongoDB()
    await engine.open()
    const logs = engine.db('app').collection('logs')
    for (const value of [3, 1, 2]) await logs.insertOne({ v: value })

    const builder = logs.find({}).sort({ v: 1 })
    ok(typeof builder.next === 'function' && typeof builder.toArray === 'function', 'find returns the lazy builder')
    const ordered = await builder.toArray()
    equal(ordered.map((entry) => entry.v), [1, 2, 3], 'sort orders the documents')
    strictEqual(builder.closed, true, 'an exhausted cursor is closed')

    const windowed = await logs.find({}, { sort: { v: 1 }, skip: 1, limit: 1 }).toArray()
    equal(windowed.map((entry) => entry.v), [2], 'skip and limit slice the window')

    const projected = await logs.findOne({ v: 1 }, { projection: { v: 1 } })
    equal(Object.keys(projected).sort(), ['_id', 'v'], 'projection keeps _id and the named field')

    const paging = logs.find({}, { sort: { v: 1 }, batchSize: 1 })
    const streamed = []
    for await (const document of paging) streamed.push(document.v)
    equal(streamed, [1, 2, 3], 'batchSize 1 drains through getMore inside the iteration')
    strictEqual(paging.closed, true, 'the exhausted cursor reports itself closed')

    const early = logs.find({}, { sort: { v: 1 }, batchSize: 1 })
    for await (const document of early) {
        strictEqual(document.v, 1, 'the first batch arrives before the break')
        break
    }
    strictEqual(early.closed, true, 'an early break closes the cursor')
    await rejects(
        () => early.next(),
        (error) => strictEqual(error.code, 'CursorClosed', 'a closed cursor refuses next()'),
        'next after break'
    )

    const frozen = logs.find({})
    await frozen.next()
    await rejects(
        () => frozen.limit(1),
        (error) => strictEqual(error.code, 'CursorAlreadyExecuted', 'configuration freezes after execution'),
        'mutate after execution'
    )

    const disposed = logs.find({})
    await disposed[asyncDisposeSymbol]()
    strictEqual(disposed.closed, true, 'Symbol.asyncDispose closes the cursor')

    await engine.close()
}

// --- update / delete / index surface --------------------------------------------

{
    const engine = new MongoDB()
    await engine.open()
    const users = engine.db('app').collection('users')
    const alice = await users.insertOne({ name: 'Alice', age: 30 })
    const bob = await users.insertOne({ name: 'Bob', age: 20 })

    const updated = await users.updateOne({ _id: alice.insertedId }, { $inc: { age: 5 } })
    equal(updated, { acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedId: null }, 'updateOne counts match and modify')

    const missed = await users.updateOne({ name: 'Nobody' }, { $set: { seen: true } })
    equal(missed, { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedId: null }, 'a miss counts zero')

    const upserted = await users.updateOne({ name: 'Carol' }, { $set: { age: 40 } }, { upsert: true })
    strictEqual(upserted.matchedCount, 0, 'an upsert matches nothing first')
    strictEqual(upserted.modifiedCount, 0, 'an upsert modifies nothing')
    ok(upserted.upsertedId !== null && upserted.upsertedId._id instanceof ObjectId, 'upsertedId is the generated id')

    const bulk = await users.updateMany({ age: { $gte: 20 } }, { $set: { senior: true } })
    strictEqual(bulk.matchedCount, 3, 'updateMany matches every candidate')
    strictEqual(bulk.modifiedCount, 3, 'updateMany modifies every candidate')

    const silent = await users.updateOne({ _id: bob.insertedId }, { $set: { name: 'Bobby' } }, { writeConcern: { w: 0 } })
    equal(silent, { acknowledged: false }, 'w:0 update acknowledges nothing')
    ok(!Object.hasOwn(silent, 'matchedCount'), 'the unacknowledged update branch has no counters')

    const one = await users.deleteOne({ name: 'Bobby' })
    equal(one, { acknowledged: true, deletedCount: 1 }, 'deleteOne removes exactly one')
    const rest = await users.deleteMany({})
    strictEqual(rest.deletedCount, 2, 'deleteMany drains the collection')
    const quiet = await users.deleteMany({}, { writeConcern: { w: 0 } })
    equal(quiet, { acknowledged: false }, 'w:0 delete acknowledges nothing')

    // A unique index is built on a fresh collection so the missing-field
    // documents of `users` cannot poison the uniqueness check.
    const contacts = engine.db('app').collection('contacts')
    const indexName = await contacts.createIndex({ email: 1 }, { unique: true })
    strictEqual(indexName, 'email_1', 'createIndex answers with the generated name')
    await contacts.insertOne({ email: 'a@example' })
    await rejects(
        () => contacts.insertOne({ email: 'a@example' }),
        (error) => {
            strictEqual(error.codeName, 'DuplicateKey', 'the unique index rejects the duplicate')
            strictEqual(error.execution, 'replied', 'the engine answered the write error')
        },
        'unique index'
    )
    await contacts.dropIndex('email_1')
    await rejects(
        () => contacts.dropIndex('email_1'),
        (error) => {
            strictEqual(error.code, '27', 'a missing index is IndexNotFound')
            strictEqual(error.codeName, 'IndexNotFound', 'the codeName survives the reply')
        },
        'dropIndex twice'
    )

    await engine.close()
}

// --- remote client over the wire --------------------------------------------------

{
    const dataDir = mkdtempSync(join(tmpdir(), 'mongo-api-server-'))
    const server = createServer({ dataDir, port: 0 })
    const address = await server.listening

    const client = new MongoDBClient({ seeds: [{ host: '127.0.0.1', port: address.port }] })
    strictEqual(client.state, 'new', 'a fresh client is new')
    const [a, b] = await Promise.all([client.connect(), client.connect()])
    ok(a === client && b === client, 'concurrent connects join the same handshake')
    strictEqual(client.state, 'ready', 'the client is ready after the hello handshake')

    const remote = client.db('app').collection('events')
    const inserted = await remote.insertOne({ kind: 'click', at: new Date(1_600_000_000_000) })
    ok(inserted.insertedId instanceof ObjectId, 'the remote insert answers with the client-side id')
    const found = await remote.findOne({ _id: inserted.insertedId })
    ok(found.at instanceof Date && found.at.getTime() === 1_600_000_000_000, 'DateTime survives the wire round trip')

    for (const value of [2, 3]) await remote.insertOne({ kind: 'view', v: value })
    const drained = remote.find({ kind: 'view' }, { sort: { v: 1 }, batchSize: 1 })
    const seen = []
    for await (const document of drained) seen.push(document.v)
    equal(seen, [2, 3], 'the wire cursor drains batches through getMore')
    strictEqual(drained.closed, true, 'the wire cursor closed on exhaustion')

    const earlyBreak = remote.find({})
    for await (const document of earlyBreak) {
        ok(document.kind === 'click' || document.kind === 'view', 'the first wire batch arrives')
        break
    }
    strictEqual(earlyBreak.closed, true, 'an early break closes the wire cursor')

    const changed = await remote.updateOne({ _id: inserted.insertedId }, { $set: { kind: 'press' } })
    strictEqual(changed.matchedCount, 1, 'the wire update matched')
    strictEqual(changed.modifiedCount, 1, 'the wire update modified')
    const removed = await remote.deleteMany({ kind: 'press' })
    strictEqual(removed.deletedCount, 1, 'the wire delete removed the document')

    const name = await remote.createIndex({ kind: 1 })
    strictEqual(name, 'kind_1', 'createIndex works over the wire')
    await remote.dropIndex(name)

    await remote.insertOne({ _id: 7 })
    await rejects(
        () => remote.insertOne({ _id: 7 }),
        (error) => {
            strictEqual(error.product, 'mongodb', 'the wire failure carries the same envelope')
            strictEqual(error.code, '11000', 'the wire duplicate reports code 11000')
            strictEqual(error.codeName, 'DuplicateKey', 'the wire duplicate reports DuplicateKey')
            strictEqual(error.execution, 'replied', 'the server answered over the wire')
        },
        'wire duplicate'
    )

    const silent = await remote.insertOne({ kind: 'silent' }, { writeConcern: { w: 0 } })
    equal(silent, { acknowledged: false }, 'w:0 over the wire acknowledges nothing')
    ok((await remote.findOne({ kind: 'silent' })) !== null, 'the moreToCome write still landed')

    // Laziness proof: a builder created after close never reached the server
    // at creation time, and materialising it fails with the state error.
    await client.close()
    const late = remote.find({})
    await rejects(
        () => late.toArray(),
        (error) => strictEqual(error.code, 'NotConnected', 'commands after close fail before sending'),
        'lazy find after close'
    )
    await client.close()
    strictEqual(client.state, 'closed', 'repeat closes succeed')

    const viaUrl = new MongoDBClient({ url: `mongodb://127.0.0.1:${address.port}` })
    await viaUrl.connect()
    strictEqual(viaUrl.state, 'ready', 'the url form reaches the same listener')
    const nothing = await viaUrl.db('app').collection('nowhere').findOne({})
    ok(nothing === null, 'the url client answers queries')
    await viaUrl.close()

    const unreachable = new MongoDBClient({ url: 'mongodb://127.0.0.1:1' })
    await rejects(
        () => unreachable.connect(),
        (error) => {
            strictEqual(error.code, 'ConnectionFailure', 'an unreachable seed fails the connect phase')
            strictEqual(error.phase, 'connect', 'the failure is located in connect')
            strictEqual(error.execution, 'not-sent', 'no command was ever sent')
            strictEqual(error.retry, 'application-decision', "retrying the connect is the caller's decision")
        },
        'unreachable seed'
    )

    await server.close()
}

console.log(`api acceptance: ${assertions} assertions`)
