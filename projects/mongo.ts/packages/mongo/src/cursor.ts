// The lazy `find` builder and the stateful cursor it becomes on first use.
//
// Nothing reaches the engine until `next()`, `toArray()` or the first
// iteration step; from that moment the builder configuration is frozen. The
// cursor holds a server-side resource while its id is non-zero, so `close()`
// answers `killCursors`, an early `break` closes through the iterator's
// `return()`, and `Symbol.asyncDispose` is provided for `await using`.

import { Int32, type Document } from './bson.ts'
import { MongoError } from './errors.ts'

/** Anything that can run one command document and answer the decoded reply. */
export interface CommandRunner {
    /** `unacknowledged` sends the command without waiting for (or reporting) a reply. */
    command(command: Document, unacknowledged?: boolean): Promise<Document | null>
}

export interface FindOptions {
    sort?: Document
    limit?: number
    skip?: number
    projection?: Document
    batchSize?: number
}

export const asyncDisposeSymbol: symbol =
    (Symbol as unknown as { asyncDispose?: symbol }).asyncDispose ?? Symbol.for('nodejs.asyncDispose')

function assertCount(name: string, value: number): void {
    if (!Number.isInteger(value) || value < 0) {
        throw new MongoError(`${name} expects a non-negative integer, got ${value}`, {
            code: 'InvalidState',
            phase: 'execute',
            execution: 'not-sent',
            retry: 'never'
        })
    }
}

function encodeSort(sort: Document): Document {
    const encoded: Document = {}
    for (const [field, direction] of Object.entries(sort)) {
        encoded[field] = typeof direction === 'number' ? new Int32(direction) : direction
    }
    return encoded
}

function encodeProjection(projection: Document): Document {
    const encoded: Document = {}
    for (const [field, value] of Object.entries(projection)) {
        encoded[field] = typeof value === 'number' ? new Int32(value) : value
    }
    return encoded
}

export class FindCursor<T extends Document = Document> {
    readonly #runner: CommandRunner
    readonly #database: string
    readonly #collection: string
    readonly #filter: Document
    #sort: Document | null = null
    #limit: number | null = null
    #skip: number | null = null
    #projection: Document | null = null
    #batchSize: number | null = null
    #batch: Document[] = []
    #cursorId: bigint | null = null
    #opened = false
    #closed = false

    constructor(runner: CommandRunner, database: string, collection: string, filter: Document = {}, options: FindOptions = {}) {
        this.#runner = runner
        this.#database = database
        this.#collection = collection
        this.#filter = filter
        if (options.sort !== undefined) this.#sort = encodeSort(options.sort)
        if (options.projection !== undefined) this.#projection = encodeProjection(options.projection)
        if (options.limit !== undefined) {
            assertCount('limit', options.limit)
            this.#limit = options.limit
        }
        if (options.skip !== undefined) {
            assertCount('skip', options.skip)
            this.#skip = options.skip
        }
        if (options.batchSize !== undefined) {
            assertCount('batchSize', options.batchSize)
            this.#batchSize = options.batchSize
        }
    }

    get closed(): boolean {
        return this.#closed
    }

    sort(spec: Document): this {
        this.#assertNotExecuted('sort')
        this.#sort = encodeSort(spec)
        return this
    }

    projection(spec: Document): this {
        this.#assertNotExecuted('projection')
        this.#projection = encodeProjection(spec)
        return this
    }

    limit(count: number): this {
        this.#assertNotExecuted('limit')
        assertCount('limit', count)
        this.#limit = count
        return this
    }

    skip(count: number): this {
        this.#assertNotExecuted('skip')
        assertCount('skip', count)
        this.#skip = count
        return this
    }

    batchSize(count: number): this {
        this.#assertNotExecuted('batchSize')
        assertCount('batchSize', count)
        this.#batchSize = count
        return this
    }

    /** Advances one document; `{ done: true }` once the cursor is exhausted. */
    async next(): Promise<{ done: boolean; value?: T }> {
        if (this.#closed) {
            throw new MongoError('cursor is closed', { code: 'CursorClosed', phase: 'execute', execution: 'not-sent', retry: 'never' })
        }
        if (!this.#opened) await this.#open()
        while (this.#batch.length === 0 && this.#cursorId !== null && this.#cursorId !== 0n) {
            await this.#getMore()
        }
        if (this.#batch.length === 0) {
            this.#closed = true
            this.#cursorId = 0n
            return { done: true, value: undefined }
        }
        return { done: false, value: this.#batch.shift() as T }
    }

    /** Materialises every remaining document. */
    async toArray(): Promise<T[]> {
        const items: T[] = []
        for (;;) {
            const step = await this.next()
            if (step.done) return items
            items.push(step.value as T)
        }
    }

    /** Releases the server-side cursor; idempotent and safe before opening. */
    async close(): Promise<void> {
        if (this.#closed) return
        this.#closed = true
        const id = this.#cursorId
        this.#cursorId = 0n
        if (this.#opened && id !== null && id !== 0n) {
            await this.#runner.command({ killCursors: this.#collection, cursors: [id], $db: this.#database })
        }
    }

    [asyncDisposeSymbol](): Promise<void> {
        return this.close()
    }

    [Symbol.asyncIterator](): AsyncIterator<T> {
        return {
            next: async (): Promise<IteratorResult<T, undefined>> => {
                const step = await this.next()
                return step.done ? { done: true, value: undefined } : { done: false, value: step.value as T }
            },
            return: async (): Promise<IteratorResult<T, undefined>> => {
                await this.close()
                return { done: true, value: undefined }
            }
        }
    }

    #assertNotExecuted(name: string): void {
        if (this.#opened) {
            throw new MongoError(`find cursor already executed; ${name} cannot change the configuration`, {
                code: 'CursorAlreadyExecuted',
                phase: 'execute',
                execution: 'not-sent',
                retry: 'never'
            })
        }
    }

    async #open(): Promise<void> {
        const command: Document = { find: this.#collection, filter: this.#filter, $db: this.#database }
        if (this.#sort !== null) command.sort = this.#sort
        if (this.#limit !== null) command.limit = new Int32(this.#limit)
        if (this.#skip !== null) command.skip = new Int32(this.#skip)
        if (this.#batchSize !== null) command.batchSize = new Int32(this.#batchSize)
        if (this.#projection !== null) command.projection = this.#projection
        const reply = await this.#runner.command(command)
        if (reply === null) {
            throw new MongoError('find always answers', { code: 'InvalidState', phase: 'execute', execution: 'not-sent', retry: 'never' })
        }
        const cursor = reply.cursor as Document
        this.#batch = (cursor.firstBatch as Document[]) ?? []
        this.#cursorId = (cursor.id as bigint) ?? 0n
        this.#opened = true
    }

    async #getMore(): Promise<void> {
        const command: Document = { getMore: this.#cursorId as bigint, collection: this.#collection, $db: this.#database }
        if (this.#batchSize !== null && this.#batchSize > 0) command.batchSize = new Int32(this.#batchSize)
        const reply = await this.#runner.command(command)
        if (reply === null) {
            throw new MongoError('getMore always answers', { code: 'InvalidState', phase: 'execute', execution: 'not-sent', retry: 'never' })
        }
        const cursor = reply.cursor as Document
        this.#batch.push(...((cursor.nextBatch as Document[]) ?? []))
        this.#cursorId = (cursor.id as bigint) ?? 0n
    }
}
