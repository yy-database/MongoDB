// The remote client. One TCP connection, OP_MSG requests framed by wire.ts,
// command bodies encoded and decoded by the same N-API primitives the server
// host uses. `connect()` performs the `hello` handshake before any command is
// answered, and `db` / `collection` reuse the shared surface from mongo.ts.
import net from 'node:net'
import { binding } from './binding.ts'
import { type Document } from './bson.ts'
import { asyncDisposeSymbol, type CommandRunner } from './cursor.ts'
import { MongoError } from './errors.ts'
import { encodeCommandText, MongoDb, parseReplyText } from './mongo.ts'

export interface TcpEndpoint {
    host: string
    port: number
}

export interface MongoDBClientOptions {
    /** `mongodb://host:port[,host:port]` — mutually exclusive with `seeds`. */
    url?: string
    /** Explicit endpoints — mutually exclusive with `url`. */
    seeds?: readonly TcpEndpoint[]
}

const DEFAULT_PORT = 27017
const MAX_FRAME_SIZE = 48_000_000

interface Pending {
    resolve: (frame: Buffer) => void
    reject: (error: Error) => void
}

class WireRunner implements CommandRunner {
    #socket: net.Socket | null = null
    /** Frame queue rules — ids, pairing, handshake gate — live in `database.client`. */
    #session = new binding.MongoWireSession(MAX_FRAME_SIZE)
    #waiters = new Map<number, Pending>()

    get live(): boolean {
        return this.#session.isLive()
    }

    async attach(endpoint: TcpEndpoint): Promise<void> {
        const socket = net.connect(endpoint.port, endpoint.host)
        await new Promise<void>((resolvePromise, rejectPromise) => {
            socket.once('connect', resolvePromise)
            socket.once('error', (error) => rejectPromise(error))
        })
        socket.on('data', (chunk) => this.#onData(chunk))
        socket.on('error', (error) => this.#fail(error))
        socket.on('close', () => this.#fail(new Error('connection closed')))
        this.#socket = socket
    }

    #onData(chunk: Buffer): void {
        for (const event of this.#session.pushBytes(chunk)) {
            if (event.kind === 'response') {
                const requestId = event.requestId as number
                const waiter = this.#waiters.get(requestId)
                this.#waiters.delete(requestId)
                waiter?.resolve(event.frame as Buffer)
                continue
            }
            // The core liquidated the queue (invalid length or unsolicited
            // reply); settle the rest and drop the socket.
            this.#fail(new Error(event.reason ?? 'connection lost'))
            this.#socket?.destroy()
            return
        }
    }

    #fail(error: Error): void {
        const event = this.#session.failAll(error.message)
        const requestIds = event?.requestIds ?? [...this.#waiters.keys()]
        for (const requestId of requestIds) {
            const waiter = this.#waiters.get(requestId)
            this.#waiters.delete(requestId)
            if (waiter === undefined) continue
            // The request left the socket, so its outcome is genuinely unknown;
            // the caller decides whether repeating it is safe.
            waiter.reject(
                new MongoError(`connection lost: ${error.message}`, {
                    code: 'ConnectionLost',
                    phase: 'execute',
                    execution: 'unknown',
                    retry: 'application-decision',
                    cause: error
                })
            )
        }
    }

    async command(command: Document, unacknowledged = false): Promise<Document | null> {
        if (!this.#session.isLive() || this.#socket === null) {
            throw new MongoError('client is not connected', { code: 'NotConnected', phase: 'execute', execution: 'not-sent', retry: 'never' })
        }
        const text = encodeCommandText(command)
        let body: Buffer
        try {
            body = binding.encodeOpMsg(text)
        } catch (error) {
            throw new MongoError((error as Error).message ?? String(error), {
                code: 'InvalidDocument',
                phase: 'execute',
                execution: 'not-sent',
                retry: 'never',
                cause: error
            })
        }
        let frame: Buffer
        try {
            frame = this.#session.beginRequest(body, unacknowledged)
        } catch (error) {
            // The core refuses before the byte leaves: dead session, or a
            // command that outran the `hello` handshake.
            throw new MongoError((error as Error).message ?? String(error), {
                code: 'NotConnected',
                phase: 'execute',
                execution: 'not-sent',
                retry: 'never',
                cause: error
            })
        }
        if (unacknowledged) {
            this.#socket.write(frame)
            return null
        }
        const requestId = binding.wirePeekHeader(frame).requestId
        return new Promise<Document>((resolvePromise, rejectPromise) => {
            this.#waiters.set(requestId, {
                resolve: (reply) => {
                    try {
                        resolvePromise(parseReplyText(binding.decodeOpMsg(reply.subarray(16))))
                    } catch (error) {
                        rejectPromise(error)
                    }
                },
                reject: rejectPromise
            })
            this.#socket?.write(frame)
        })
    }

    close(): void {
        this.#fail(new Error('client closed'))
        this.#socket?.end()
        this.#socket = null
    }
}

function endpoint(host: string, port: number): TcpEndpoint {
    if (typeof host !== 'string' || host === '') throw clientConfigurationError('endpoint host must be a non-empty string')
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw clientConfigurationError(`endpoint port must be in [1, 65535], got ${port}`)
    return { host, port }
}

function clientConfigurationError(message: string): MongoError {
    return new MongoError(message, { code: 'ConfigurationError', phase: 'configuration', execution: 'not-sent', retry: 'never' })
}

function parseSeeds(seeds: readonly TcpEndpoint[]): TcpEndpoint[] {
    if (!Array.isArray(seeds) || seeds.length === 0) throw clientConfigurationError('seeds must hold at least one endpoint')
    return seeds.map((seed) => endpoint(String(seed.host), seed.port ?? DEFAULT_PORT))
}

function parseUrl(url: string): TcpEndpoint[] {
    if (url.startsWith('mongodb+srv://')) throw clientConfigurationError('mongodb+srv is not supported; pass explicit seeds')
    if (!url.startsWith('mongodb://')) throw clientConfigurationError('url must use the mongodb:// scheme')
    const authority = url.slice('mongodb://'.length).split('/')[0].split('?')[0]
    const hosts = authority.slice(authority.lastIndexOf('@') + 1)
    if (hosts === '') throw clientConfigurationError('url holds no host')
    return hosts.split(',').map((entry) => {
        const index = entry.lastIndexOf(':')
        if (index === -1) return endpoint(entry, DEFAULT_PORT)
        const port = Number(entry.slice(index + 1))
        return endpoint(entry.slice(0, index), Number.isNaN(port) ? DEFAULT_PORT : port)
    })
}

/**
 * The remote client. `url` and `seeds` are mutually exclusive; `connect()`
 * opens one socket and completes the OP_MSG `hello` handshake before any
 * command runs.
 */
export class MongoDBClient {
    readonly #endpoints: TcpEndpoint[]
    #runner: WireRunner | null = null
    #connecting: Promise<this> | null = null
    #closing: Promise<void> | null = null
    #state: 'new' | 'connecting' | 'ready' | 'closing' | 'closed' | 'failed' = 'new'

    constructor(options: MongoDBClientOptions) {
        const hasUrl = options.url !== undefined
        const hasSeeds = options.seeds !== undefined
        if (hasUrl && hasSeeds) throw clientConfigurationError('url and seeds are mutually exclusive')
        if (!hasUrl && !hasSeeds) throw clientConfigurationError('one of url or seeds is required')
        this.#endpoints = hasUrl ? parseUrl(String(options.url)) : parseSeeds(options.seeds as readonly TcpEndpoint[])
    }

    get state(): 'new' | 'connecting' | 'ready' | 'closing' | 'closed' | 'failed' {
        return this.#state
    }

    /** Connects and handshakes; concurrent calls join the same operation. */
    async connect(): Promise<this> {
        if (this.#connecting !== null) return this.#connecting
        const attempt = (async () => {
            if (this.#state === 'ready') {
                throw new MongoError('client is already connected', { code: 'AlreadyConnected', phase: 'connect', execution: 'not-sent', retry: 'never' })
            }
            if (this.#state === 'closed' || this.#state === 'closing') {
                throw new MongoError('a closed client cannot be reopened; construct a new MongoDBClient', {
                    code: 'Closed',
                    phase: 'connect',
                    execution: 'not-sent',
                    retry: 'never'
                })
            }
            this.#state = 'connecting'
            const failures: string[] = []
            for (const target of this.#endpoints) {
                const runner = new WireRunner()
                try {
                    await runner.attach(target)
                    await runner.command({ hello: 1, $db: 'admin', client: { application: { name: '@yydb/mongodb' } } })
                    this.#runner = runner
                    this.#state = 'ready'
                    return this
                } catch (error) {
                    runner.close()
                    failures.push(`${target.host}:${target.port} — ${(error as Error).message}`)
                }
            }
            this.#state = 'failed'
            throw new MongoError(`cannot reach any seed: ${failures.join('; ')}`, {
                code: 'ConnectionFailure',
                phase: 'connect',
                execution: 'not-sent',
                retry: 'application-decision',
                cause: failures
            })
        })()
        this.#connecting = attempt
        try {
            return await attempt
        } finally {
            this.#connecting = null
        }
    }

    /** A lightweight locator view sharing the local engine's authoring surface. */
    db(name: string): MongoDb {
        if (typeof name !== 'string' || name === '') throw clientConfigurationError('database name must be a non-empty string')
        const runner: CommandRunner = {
            command: (command, unacknowledged) => {
                if (this.#runner === null || this.#state !== 'ready') {
                    throw new MongoError('client is not connected', { code: 'NotConnected', phase: 'execute', execution: 'not-sent', retry: 'never' })
                }
                return this.#runner.command(command, unacknowledged)
            }
        }
        return new MongoDb(name, runner)
    }

    /** Ends the connection; repeat closes succeed. */
    async close(): Promise<void> {
        if (this.#closing !== null) return this.#closing
        if (this.#state === 'closed') return
        this.#closing = (async () => {
            this.#state = 'closing'
            this.#runner?.close()
            this.#runner = null
            this.#state = 'closed'
        })()
        return this.#closing
    }

    [asyncDisposeSymbol](): Promise<void> {
        return this.close()
    }
}
