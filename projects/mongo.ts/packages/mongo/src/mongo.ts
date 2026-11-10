// The local engine owner and the shared `db` / `collection` surface.
//
// `MongoDB` opens one `.yykv` shard through the N-API primitives and answers
// every command in-process; `MongoDBClient` (client.ts) reaches a listener
// over the wire. Both hand the same `CommandRunner` to `MongoDb` and
// `MongoCollection`, so the authoring surface below is written exactly once.
// No BSON codec, command semantics or storage lives in this file: each command
// is one binding call.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { binding } from './binding.ts'
import { decodeDocument, encodeDocument, Int32, ObjectId, type Document } from './bson.ts'
import { asyncDisposeSymbol, FindCursor, type CommandRunner, type FindOptions } from './cursor.ts'
import { MongoError } from './errors.ts'

export interface StorageOptions {
    /** Directory that holds `mongo.yykv`. */
    directory: string
}

export interface MongoDBOptions {
    /** Omitted means an ephemeral store under the system temporary directory. */
    storage?: StorageOptions
}

export interface WriteOptions {
    writeConcern?: { w?: number | string; j?: boolean }
    /** Only meaningful for `insertMany`: stop at the first error. */
    ordered?: boolean
}

export interface UpsertOptions extends WriteOptions {
    upsert?: boolean
}

export interface IndexOptions {
    name?: string
    unique?: boolean
    sparse?: boolean
    expireAfterSeconds?: number | bigint
}

export type InsertOneResult = { acknowledged: true; insertedId: unknown } | { acknowledged: false }

export type InsertManyResult =
    | { acknowledged: true; insertedCount: number; insertedIds: Record<number, unknown> }
    | { acknowledged: false }

export type UpdateResult =
    | { acknowledged: true; matchedCount: number; modifiedCount: number; upsertedId: { _id: unknown } | null }
    | { acknowledged: false }

export type DeleteResult = { acknowledged: true; deletedCount: number } | { acknowledged: false }

/** Unwraps a decoded count field (`Int32`, `bigint` or `number`) to a number. */
export function countOf(value: unknown): number {
    if (value instanceof Int32) return value.value
    if (typeof value === 'bigint') return Number(value)
    if (typeof value === 'number') return value
    return 0
}

/** Serialises a user command to the canonical Extended JSON the ABI expects. */
export function encodeCommandText(command: Document): string {
    try {
        return JSON.stringify(encodeDocument(command))
    } catch (error) {
        throw new MongoError(`cannot encode command: ${(error as Error).message}`, {
            code: 'InvalidDocument',
            phase: 'execute',
            execution: 'not-sent',
            retry: 'never',
            cause: error
        })
    }
}

function scalarNumber(value: unknown): number | null {
    if (typeof value === 'number') return value
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        const tagged = value as Record<string, unknown>
        for (const key of ['$numberInt', '$numberLong', '$numberDouble', '$numberDecimal']) {
            if (Object.hasOwn(tagged, key)) {
                const text = tagged[key]
                if (typeof text === 'string' || typeof text === 'number') return Number(text)
            }
        }
    }
    return null
}

/** The facade's `code_name` table, reached through the `errorReply` primitive. */
function codeNameFor(code: number): string | undefined {
    try {
        const parsed = JSON.parse(binding.errorReply(code, '')) as Record<string, unknown>
        return typeof parsed.codeName === 'string' ? parsed.codeName : undefined
    } catch {
        return undefined
    }
}

function serverError(raw: Record<string, unknown>, fallback: string): MongoError {
    const code = scalarNumber(raw.code)
    const codeName = typeof raw.codeName === 'string' ? raw.codeName : (code === null ? fallback : codeNameFor(code) ?? `Location${code}`)
    const message = typeof raw.errmsg === 'string' ? raw.errmsg : fallback
    const labels = Array.isArray(raw.errorLabels) ? raw.errorLabels.filter((label): label is string => typeof label === 'string') : undefined
    return new MongoError(message, {
        code: code === null ? fallback : String(code),
        codeName,
        phase: 'execute',
        execution: 'replied',
        retry: 'never',
        serverCode: code ?? undefined,
        errorLabels: labels
    })
}

/**
 * Turns a raw Extended JSON reply into a `MongoError` when the engine refused
 * the command (`ok: 0`) or reported a write error (`ok: 1` with
 * `writeErrors`). Returns `null` for a clean reply.
 */
export function replyFailure(raw: Record<string, unknown>): MongoError | null {
    const ok = scalarNumber(raw.ok)
    if (ok === 1) {
        const writeErrors = raw.writeErrors
        if (Array.isArray(writeErrors) && writeErrors.length > 0) {
            const first = writeErrors[0]
            if (first !== null && typeof first === 'object') return serverError(first as Record<string, unknown>, 'WriteError')
        }
        return null
    }
    if (ok === 0) return serverError(raw, 'CommandError')
    return null
}

/** Parses one reply string and decodes it into typed values. */
export function parseReplyText(text: string): Document {
    let raw: Record<string, unknown>
    try {
        raw = JSON.parse(text) as Record<string, unknown>
    } catch (error) {
        throw new MongoError('the engine answered with unreadable JSON', {
            code: 'MalformedReply',
            phase: 'execute',
            execution: 'replied',
            retry: 'never',
            cause: error
        })
    }
    const failure = replyFailure(raw)
    if (failure !== null) throw failure
    return decodeDocument(raw)
}

type LocalCommand = (engine: LocalEngine, text: string) => string

/** One binding call per command name; nothing else runs here. */
const LOCAL_COMMANDS: Record<string, LocalCommand> = {
    insert: (engine, text) => binding.insert(engine.store, text),
    find: (engine, text) => binding.find(engine.store, engine.cursors, text),
    getMore: (engine, text) => binding.getMore(engine.cursors, text),
    killCursors: (engine, text) => binding.killCursors(engine.cursors, text),
    update: (engine, text) => binding.update(engine.store, text),
    delete: (engine, text) => binding.delete(engine.store, text),
    count: (engine, text) => binding.count(engine.store, text),
    distinct: (engine, text) => binding.distinct(engine.store, text),
    aggregate: (engine, text) => binding.aggregate(engine.store, text),
    explain: (engine, text) => binding.explain(engine.store, text),
    findAndModify: (engine, text) => binding.findAndModify(engine.store, text),
    bulkWrite: (engine, text) => binding.bulkWrite(engine.store, text),
    create: (engine, text) => binding.create(engine.store, text),
    drop: (engine, text) => binding.dropCollection(engine.store, text),
    collMod: (engine, text) => binding.collMod(engine.store, text),
    listCollections: (engine, text) => binding.listCollections(engine.store, text),
    createIndexes: (engine, text) => binding.createIndexes(engine.store, text),
    listIndexes: (engine, text) => binding.listIndexes(engine.store, text),
    dropIndexes: (engine, text) => binding.dropIndexes(engine.store, text),
    listDatabases: (engine) => binding.listDatabases(engine.store),
    dropDatabase: (engine, text) => binding.dropDatabase(engine.store, text),
    commitTransaction: (engine, text) => binding.commitTransaction(engine.store, text),
    abortTransaction: (engine, text) => binding.abortTransaction(engine.store, text),
    ping: () => binding.ping(),
    hello: () => binding.hello()
}

class LocalEngine implements CommandRunner {
    store: any = null
    cursors: any = null
    state: 'new' | 'open' | 'closed' = 'new'

    async command(command: Document, unacknowledged = false): Promise<Document | null> {
        if (this.state !== 'open') {
            throw new MongoError(this.state === 'new' ? 'engine is not open; await open() first' : 'engine is closed', {
                code: this.state === 'new' ? 'NotOpen' : 'Closed',
                phase: 'execute',
                execution: 'not-sent',
                retry: 'never'
            })
        }
        const name = Object.keys(command)[0]
        if (typeof name !== 'string' || !Object.hasOwn(LOCAL_COMMANDS, name)) {
            throw new MongoError(`no such command: '${name ?? ''}'`, {
                code: '59',
                codeName: 'CommandNotFound',
                phase: 'execute',
                execution: 'not-sent',
                retry: 'never'
            })
        }
        const text = encodeCommandText(command)
        let out: string
        try {
            out = LOCAL_COMMANDS[name](this, text)
        } catch (error) {
            throw new MongoError((error as Error).message ?? String(error), {
                code: 'BindingFailure',
                phase: 'execute',
                execution: 'not-sent',
                retry: 'never',
                cause: error
            })
        }
        const reply = parseReplyText(out)
        if (name === 'drop') {
            // A successful drop kills the cursors on that namespace, like `mongod`.
            const database = typeof command.$db === 'string' ? command.$db : 'admin'
            const collection = typeof command.drop === 'string' ? command.drop : ''
            this.cursors.dropCollection(`${database}.${collection}`)
        }
        return unacknowledged ? null : reply
    }
}

function configurationError(message: string): MongoError {
    return new MongoError(message, { code: 'ConfigurationError', phase: 'configuration', execution: 'not-sent', retry: 'never' })
}

function unacknowledged(options?: WriteOptions): boolean {
    return options?.writeConcern?.w === 0
}

function writeConcernField(options?: WriteOptions): Document {
    return options?.writeConcern === undefined ? {} : { writeConcern: options.writeConcern }
}

function assertDocumentValue(label: string, value: unknown): Document {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw configurationError(`${label} must be a document`)
    }
    return value as Document
}

/** A lightweight locator view; it owns no resource and never needs closing. */
export class MongoDb {
    readonly name: string
    readonly #runner: CommandRunner

    constructor(name: string, runner: CommandRunner) {
        this.name = name
        this.#runner = runner
    }

    collection<T extends Document = Document>(name: string): MongoCollection<T> {
        if (typeof name !== 'string' || name === '') throw configurationError('collection name must be a non-empty string')
        return new MongoCollection<T>(this.#runner, this.name, name)
    }
}

/** The authoring surface; every method maps to one command primitive. */
export class MongoCollection<T extends Document = Document> {
    readonly #runner: CommandRunner
    readonly #database: string
    readonly #name: string

    constructor(runner: CommandRunner, database: string, name: string) {
        this.#runner = runner
        this.#database = database
        this.#name = name
    }

    get name(): string {
        return this.#name
    }

    get databaseName(): string {
        return this.#database
    }

    async insertOne(document: Document, options?: WriteOptions): Promise<InsertOneResult> {
        const value = assertDocumentValue('insertOne document', document)
        const stored: Document = Object.hasOwn(value, '_id') && value._id !== undefined ? value : { ...value, _id: new ObjectId() }
        const insertedId = stored._id
        const reply = await this.#runner.command(
            { insert: this.#name, documents: [stored], ordered: true, $db: this.#database, ...writeConcernField(options) },
            unacknowledged(options)
        )
        if (reply === null) return { acknowledged: false }
        return { acknowledged: true, insertedId }
    }

    async insertMany(documents: Document[], options?: WriteOptions): Promise<InsertManyResult> {
        if (!Array.isArray(documents) || documents.length === 0) {
            throw configurationError('insertMany requires at least one document')
        }
        const stored = documents.map((document, index) => {
            const value = assertDocumentValue(`insertMany documents[${index}]`, document)
            return Object.hasOwn(value, '_id') && value._id !== undefined ? value : { ...value, _id: new ObjectId() }
        })
        const insertedIds: Record<number, unknown> = {}
        stored.forEach((document, index) => {
            insertedIds[index] = document._id
        })
        const ordered = options?.ordered !== false
        const reply = await this.#runner.command(
            { insert: this.#name, documents: stored, ordered, $db: this.#database, ...writeConcernField(options) },
            unacknowledged(options)
        )
        if (reply === null) return { acknowledged: false }
        return { acknowledged: true, insertedCount: countOf(reply.n), insertedIds }
    }

    /** Runs a `limit: 1` find and materialises the first document, or `null`. */
    async findOne(filter?: Document, options?: { projection?: Document; sort?: Document }): Promise<T | null> {
        const cursor = new FindCursor<T>(this.#runner, this.#database, this.#name, filter ?? {}, { limit: 1, ...options })
        const step = await cursor.next()
        return step.done ? null : (step.value as T)
    }

    /** Returns the lazy builder; nothing is fetched until the first pull. */
    find(filter?: Document, options?: FindOptions): FindCursor<T> {
        return new FindCursor<T>(this.#runner, this.#database, this.#name, filter ?? {}, options)
    }

    async updateOne(filter: Document, update: Document, options?: UpsertOptions): Promise<UpdateResult> {
        return this.#update(false, filter, update, options)
    }

    async updateMany(filter: Document, update: Document, options?: UpsertOptions): Promise<UpdateResult> {
        return this.#update(true, filter, update, options)
    }

    async #update(multi: boolean, filter: Document, update: Document, options?: UpsertOptions): Promise<UpdateResult> {
        const specification: Document = { q: assertDocumentValue('filter', filter), u: assertDocumentValue('update', update), multi }
        if (options?.upsert === true) specification.upsert = true
        const reply = await this.#runner.command(
            { update: this.#name, updates: [specification], $db: this.#database, ...writeConcernField(options) },
            unacknowledged(options)
        )
        if (reply === null) return { acknowledged: false }
        // `mongod` counts an upserted insert inside `n`; the driver reports it
        // separately, so the match count is `n` minus the upserted entries.
        const upserted = Array.isArray(reply.upserted) ? (reply.upserted as Document[]) : []
        return {
            acknowledged: true,
            matchedCount: countOf(reply.n) - upserted.length,
            modifiedCount: countOf(reply.nModified),
            upsertedId: upserted.length === 0 ? null : { _id: upserted[0]._id }
        }
    }

    async deleteOne(filter: Document, options?: WriteOptions): Promise<DeleteResult> {
        return this.#delete(filter, 1, options)
    }

    async deleteMany(filter: Document, options?: WriteOptions): Promise<DeleteResult> {
        return this.#delete(filter, 0, options)
    }

    async #delete(filter: Document, limit: number, options?: WriteOptions): Promise<DeleteResult> {
        const reply = await this.#runner.command(
            { delete: this.#name, deletes: [{ q: assertDocumentValue('filter', filter), limit: new Int32(limit) }], $db: this.#database, ...writeConcernField(options) },
            unacknowledged(options)
        )
        if (reply === null) return { acknowledged: false }
        return { acknowledged: true, deletedCount: countOf(reply.n) }
    }

    async createIndex(key: Document, options?: IndexOptions): Promise<string> {
        const value = assertDocumentValue('index key', key)
        const fields = Object.entries(value)
        if (fields.length === 0) throw configurationError('index key must name at least one field')
        const normalized: Document = {}
        for (const [field, direction] of fields) {
            normalized[field] = typeof direction === 'number' ? new Int32(direction) : direction
        }
        const name = options?.name ?? fields.map(([field, direction]) => `${field}_${String(direction)}`).join('_')
        const specification: Document = { key: normalized, name }
        if (options?.unique !== undefined) specification.unique = options.unique
        if (options?.sparse !== undefined) specification.sparse = options.sparse
        if (options?.expireAfterSeconds !== undefined) {
            specification.expireAfterSeconds = typeof options.expireAfterSeconds === 'bigint' ? options.expireAfterSeconds : new Int32(options.expireAfterSeconds)
        }
        await this.#runner.command({ createIndexes: this.#name, indexes: [specification], $db: this.#database })
        return name
    }

    async dropIndex(index: string | Document): Promise<Document> {
        const reply = await this.#runner.command({ dropIndexes: this.#name, index, $db: this.#database })
        return reply ?? {}
    }
}

/**
 * The local engine owner. `open()` creates or reopens one `.yykv` shard and
 * a cursor table; every command runs in-process through the N-API primitives.
 */
export class MongoDB {
    readonly #options: MongoDBOptions
    readonly #engine = new LocalEngine()
    #ephemeral: string | null = null
    #opening: Promise<this> | null = null
    #closing: Promise<void> | null = null
    #state: 'new' | 'open' | 'closing' | 'closed' = 'new'

    constructor(options: MongoDBOptions = {}) {
        if (options.storage !== undefined) {
            const directory = options.storage.directory
            if (typeof directory !== 'string' || directory === '') throw configurationError('storage.directory must be a non-empty string')
        }
        this.#options = options
    }

    get state(): 'new' | 'open' | 'closing' | 'closed' {
        return this.#state
    }

    /** Opens the engine; concurrent calls join the same operation. */
    async open(): Promise<this> {
        if (this.#opening !== null) return this.#opening
        const attempt = (async () => {
            if (this.#state === 'open') {
                throw new MongoError('engine is already open', { code: 'AlreadyOpen', phase: 'open', execution: 'not-sent', retry: 'never' })
            }
            if (this.#state === 'closed' || this.#state === 'closing') {
                throw new MongoError('a closed engine cannot be reopened; construct a new MongoDB', {
                    code: 'Closed',
                    phase: 'open',
                    execution: 'not-sent',
                    retry: 'never'
                })
            }
            const directory = this.#options.storage?.directory ?? mkdtempSync(join(tmpdir(), 'yydb-mongo-'))
            if (this.#options.storage === undefined) this.#ephemeral = directory
            mkdirSync(directory, { recursive: true })
            this.#engine.store = new binding.MongoStore(join(directory, 'mongo.yykv'))
            this.#engine.cursors = new binding.MongoCursors()
            this.#engine.state = 'open'
            this.#state = 'open'
            return this
        })()
        this.#opening = attempt
        try {
            return await attempt
        } finally {
            this.#opening = null
        }
    }

    /** A lightweight locator view; it needs no closing of its own. */
    db(name: string): MongoDb {
        if (typeof name !== 'string' || name === '') throw configurationError('database name must be a non-empty string')
        return new MongoDb(name, this.#engine)
    }

    /** Releases the engine; a closed engine is final and repeat closes succeed. */
    async close(): Promise<void> {
        if (this.#closing !== null) return this.#closing
        if (this.#state === 'closed') return
        this.#closing = (async () => {
            this.#state = 'closing'
            this.#engine.store = null
            this.#engine.cursors = null
            this.#engine.state = 'closed'
            if (this.#ephemeral !== null) {
                rmSync(this.#ephemeral, { recursive: true, force: true })
                this.#ephemeral = null
            }
            this.#state = 'closed'
        })()
        return this.#closing
    }

    [asyncDisposeSymbol](): Promise<void> {
        return this.close()
    }
}
