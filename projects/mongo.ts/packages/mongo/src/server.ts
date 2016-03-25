// MongoDB wire-protocol listener.
//
// The server owns the socket loop, the cursor table and TTL ticks; each command
// is lowered to one Rust primitive. Compression is transport-only: an
// `OP_COMPRESSED` frame is unwrapped, the payload is decoded by `mongo-core`,
// and the reply is wrapped in the same compressor the request used (which is
// what `mongod 8.0.9` does, even when that compressor was not negotiated).
import { mkdirSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import { join } from 'node:path'
import {
    allowedBeforeAuth,
    anyUserExists,
    authError,
    authenticationRequired,
    createAuthState,
    createUserCommand,
    dropUserCommand,
    logoutCommand,
    saslContinueCommand,
    saslStartCommand,
    saslSupportedMechsFor,
    type AuthState
} from './auth.ts'
import { binding } from './binding.ts'
import { compress } from './compression.ts'
import {
    DEFAULT_MAX_FRAME_SIZE,
    decodeFrame,
    encodeCompressedFrame,
    encodeMsgFrame,
    encodeReplyFrame,
    OP_MSG,
    OP_QUERY,
    peekHeader,
    WireError,
    type InboundFrame
} from './wire.ts'

/** Compressors this server can both decode and encode. */
export const SUPPORTED_COMPRESSORS = ['snappy', 'zlib', 'zstd']

export interface ServerOptions {
    /** Directory that holds `mongo.yykv`. */
    dataDir: string
    port?: number
    host?: string
    /** Defaults to every codec the implementation actually speaks. */
    compressors?: string[]
    /** Background TTL scan period, mirroring `ttlMonitorSleepSecs`. */
    ttlMonitorSleepSecs?: number
    /**
     * Require authentication before non-handshake commands, like `mongod --auth`.
     * When off (the default) credentials are still validated, but no command is
     * refused; that matches `mongod` without `security.authorization`.
     */
    auth?: boolean
}

export interface ServerAddress {
    host: string
    port: number
}

export interface ServerStats {
    connections: number
    compressedRequests: number
    compressedReplies: number
    /** Compression sets negotiated on the most recent handshake. */
    negotiated: string[]
}

export interface MongoServer {
    listening: Promise<ServerAddress>
    address: ServerAddress | null
    stats: ServerStats
    close(): Promise<void>
}

interface Session {
    store: any
    cursors: any
    negotiated: string[]
    /** Authentication state owned by this connection. */
    auth: AuthState
}

interface ServerView {
    port: number | null
    openConnections: number
    totalConnections: number
}

const OK = { $numberDouble: '1.0' }

function hostPrefix(): string {
    return os.hostname()
}

function hasCurrentOpStage(stage: any): boolean {
    return typeof stage === 'object' && stage !== null && Object.hasOwn(stage, '$currentOp')
}

/** Canonical extended JSON for a millisecond timestamp. */
function dateValue(milliseconds: number): any {
    return { $date: { $numberLong: String(milliseconds) } }
}

function document(raw: string): any {
    return JSON.parse(raw)
}

function commandText(command: any): string {
    return JSON.stringify(command)
}

/** Intersection of the client's `compression` array and what this server really does. */
export function negotiatedCompressors(offered: unknown, supported: string[] = SUPPORTED_COMPRESSORS): string[] {
    if (!Array.isArray(offered)) return []
    return offered.filter((name) => typeof name === 'string' && supported.includes(name))
}

/** Inserts extra fields immediately before `ok`, the order `mongod` uses. */
function beforeOk(base: any, extras: [string, any][]): any {
    if (extras.length === 0) return base
    const result: any = {}
    for (const [key, value] of Object.entries(base)) {
        if (key === 'ok') for (const [extraKey, extraValue] of extras) result[extraKey] = extraValue
        result[key] = value
    }
    return result
}

function helloReply(command: any, supported: string[], session: Session): any {
    const negotiated = negotiatedCompressors(command.compression, supported)
    session.negotiated = negotiated
    const extras: [string, any][] = []
    if (negotiated.length > 0) extras.push(['compression', negotiated])
    const mechanisms = saslSupportedMechsFor(session, command.saslSupportedMechs)
    if (mechanisms.error) return mechanisms.error
    if (mechanisms.mechanisms) extras.push(['saslSupportedMechs', mechanisms.mechanisms])
    // Drivers fold the first SCRAM message into the handshake. Answering it here
    // saves a round trip; a failed speculation is omitted, as `mongod` does.
    const speculation = command.speculativeAuthenticate
    if (speculation !== null && typeof speculation === 'object') {
        const started = saslStartCommand(session, speculation)
        const accepted = started.ok === 1 || started.ok?.$numberDouble === '1.0'
        if (accepted) {
            const { conversationId, done, payload } = started
            extras.push(['speculativeAuthenticate', { conversationId, done, payload }])
        }
    }
    return beforeOk(document(binding.hello()), extras)
}

function dispatch(session: Session, supported: string[], command: any, view: ServerView, authRequired: boolean): any {
    const name = Object.keys(command)[0]
    if (typeof name !== 'string') throw new WireError('command document is empty')

    if (authRequired && session.auth.users.length === 0 && !allowedBeforeAuth(name)) {
        // The localhost exception: the very first user may be created without
        // credentials, exactly while no user document exists anywhere.
        const localhostException = name === 'createUser' && !anyUserExists(session.store)
        if (!localhostException) return authenticationRequired(name)
    }

    if (name === 'hello' || name === 'isMaster' || name === 'ismaster') return helloReply(command, supported, session)

    // `db.currentOp()` is an aggregate over `$currentOp`; there are no
    // background operations in this server, so an empty list is the honest
    // answer and keeps the shell helper from failing.
    if (name === 'aggregate') {
        const pipeline = command.pipeline
        if (Array.isArray(pipeline) && pipeline.length > 0 && hasCurrentOpStage(pipeline[0])) {
            return {
                cursor: { firstBatch: [], id: { $numberLong: '0' }, ns: `${command.$db ?? 'admin'}.$cmd.aggregate` },
                ok: OK
            }
        }
    }

    const text = commandText(command)
    switch (name) {
        case 'ping':
            return document(binding.ping())
        case 'saslStart':
            return saslStartCommand(session, command)
        case 'saslContinue':
            return saslContinueCommand(session, command)
        case 'authenticate':
            // The legacy command is in the pre-auth surface, and `mongod 8.0.9`
            // ends it with the same authentication failure.
            return authError(18, 'AuthenticationFailed', 'Authentication failed.')
        case 'createUser':
            return createUserCommand(session, command)
        case 'dropUser':
            return dropUserCommand(session, command)
        case 'logout':
            return logoutCommand(session)
        case 'insert':
            return document(binding.insert(session.store, text))
        case 'find':
            return document(binding.find(session.store, session.cursors, text))
        case 'count':
            return document(binding.count(session.store, text))
        case 'explain':
            return document(binding.explain(session.store, text))
        case 'aggregate':
            return document(binding.aggregate(session.store, text))
        case 'delete':
            return document(binding.delete(session.store, text))
        case 'update':
            return document(binding.update(session.store, text))
        case 'getMore':
            return document(binding.getMore(session.cursors, text))
        case 'killCursors':
            return document(binding.killCursors(session.cursors, text))
        case 'findAndModify':
            return document(binding.findAndModify(session.store, text))
        case 'distinct':
            return document(binding.distinct(session.store, text))
        case 'bulkWrite':
            return document(binding.bulkWrite(session.store, text))
        case 'create':
            return document(binding.create(session.store, text))
        case 'collMod':
            return document(binding.collMod(session.store, text))
        case 'listCollections':
            return document(binding.listCollections(session.store, text))
        case 'commitTransaction':
            return document(binding.commitTransaction(session.store, text))
        case 'abortTransaction':
            return document(binding.abortTransaction(session.store, text))
        case 'listDatabases':
            return document(binding.listDatabases(session.store))
        case 'createIndexes':
            return document(binding.createIndexes(session.store, text))
        case 'listIndexes':
            return document(binding.listIndexes(session.store, text))
        case 'dropIndexes':
            return document(binding.dropIndexes(session.store, text))
        case 'endSessions':
            // Sessions are not cached; `mongod` acknowledges the release.
            return { ok: OK }
        case 'buildInfo':
            // The fields `mongosh` and drivers read; the version mirrors the
            // wire surface this server answers (`mongod 8.0.9`, wire 25).
            return {
                version: '8.0.9',
                versionArray: [8, 0, 9, 0],
                bits: 64,
                debug: false,
                maxBsonObjectSize: 16_777_216,
                modules: [],
                storageEngines: ['yykv'],
                ok: OK
            }
        case 'connectionStatus':
            return {
                authInfo: { authenticatedUsers: session.auth.users, authenticatedUserRoles: session.auth.roles },
                ok: OK
            }
        case 'killOp':
            return { info: 'attempting to kill op', ok: OK }
        case 'currentOp':
            return { inprog: [], ok: OK }
        case 'serverStatus':
            return {
                host: `${hostPrefix()}:${view.port ?? 0}`,
                version: '8.0.9',
                process: 'yydb-mongo',
                pid: process.pid,
                uptime: Math.floor(process.uptime()),
                uptimeMillis: Math.round(process.uptime() * 1000),
                uptimeEstimate: Math.floor(process.uptime()),
                localTime: dateValue(Date.now()),
                connections: {
                    current: view.openConnections,
                    available: 0,
                    totalCreated: view.totalConnections
                },
                ok: OK
            }
        case 'hostInfo':
            return {
                system: {
                    currentTime: dateValue(Date.now()),
                    hostname: os.hostname(),
                    cpuAddrSize: process.arch === 'x64' || process.arch === 'arm64' ? 64 : 32,
                    memSizeMB: Math.round(os.totalmem() / 1_048_576),
                    numCores: os.cpus().length,
                    numPhysicalCores: os.cpus().length,
                    cpuArch: os.arch()
                },
                os: { type: os.type(), name: os.platform(), version: os.release() },
                extra: {},
                ok: OK
            }
        default:
            return document(binding.errorReply(59, `no such command: '${name}'`))
    }
}

export function createServer(options: ServerOptions): MongoServer {
    const host = options.host ?? '127.0.0.1'
    const port = options.port ?? 27017
    const supported = options.compressors ?? SUPPORTED_COMPRESSORS
    mkdirSync(options.dataDir, { recursive: true })

    const store = new binding.MongoStore(join(options.dataDir, 'mongo.yykv'))
    const authRequired = options.auth === true
    const stats: ServerStats = { connections: 0, compressedRequests: 0, compressedReplies: 0, negotiated: [] }
    let replyId = 0
    let closed = false

    const sockets = new Set<net.Socket>()
    const netServer = net.createServer((socket) => {
        stats.connections += 1
        sockets.add(socket)
        const session: Session = {
            store,
            cursors: new binding.MongoCursors(),
            negotiated: [],
            auth: createAuthState()
        }

        let buffer = Buffer.alloc(0)
        const pump = () => {
            while (!closed) {
                if (buffer.length < 16) return
                const total = buffer.readInt32LE(0)
                if (total < 16 || total > DEFAULT_MAX_FRAME_SIZE) {
                    sendProtocolError(socket, buffer, `frame length ${total} is outside the accepted range`)
                    socket.destroy()
                    return
                }
                if (buffer.length < total) return
                const frame = buffer.subarray(0, total)
                buffer = buffer.subarray(total)
                handle(session, frame)
            }
        }

        const reply = (requestId: number, inbound: InboundFrame, body: any) => {
            const json = commandText(body)
            if (inbound.opcode === OP_QUERY) {
                socket.write(encodeReplyFrame(replyId++, requestId, binding.encodeDocument(json)))
                return
            }
            const payload = binding.encodeOpMsg(json)
            if (inbound.envelope === null) {
                socket.write(encodeMsgFrame(replyId++, requestId, payload))
                return
            }
            const compressed = compress(inbound.envelope.compressorId, payload)
            stats.compressedReplies += 1
            socket.write(
                encodeCompressedFrame(
                    replyId++,
                    requestId,
                    inbound.envelope.compressorId,
                    payload.length,
                    compressed
                )
            )
        }

        const handle = (session: Session, frame: Buffer) => {
            let inbound: InboundFrame
            try {
                inbound = decodeFrame(frame)
            } catch (error) {
                stats.negotiated = session.negotiated
                sendProtocolError(socket, frame, (error as Error).message)
                socket.destroy()
                return
            }
            if (inbound.envelope !== null) stats.compressedRequests += 1
            stats.negotiated = session.negotiated
            try {
                const command =
                    inbound.opcode === OP_QUERY
                        ? document(binding.decodeOpQuery(inbound.payload))
                        : document(binding.decodeOpMsg(inbound.payload))
                const body = dispatch(
                    session,
                    supported,
                    command,
                    {
                        port: boundPort(netServer),
                        openConnections: sockets.size,
                        totalConnections: stats.connections
                    },
                    authRequired
                )
                stats.negotiated = session.negotiated
                reply(inbound.header.requestId, inbound, body)
            } catch (error) {
                stats.negotiated = session.negotiated
                const message = (error as Error).message ?? String(error)
                try {
                    reply(inbound.header.requestId, inbound, document(binding.errorReply(2, message)))
                } catch {
                    sendProtocolError(socket, frame, message)
                }
                socket.destroy()
            }
        }

        socket.on('data', (chunk) => {
            buffer = Buffer.concat([buffer, chunk])
            pump()
        })
        socket.on('error', () => socket.destroy())
        socket.on('close', () => sockets.delete(socket))
    })

    const listening = new Promise<ServerAddress>((resolvePromise, rejectPromise) => {
        netServer.once('error', rejectPromise)
        netServer.listen(port, host, () => {
            const address = netServer.address()
            if (address === null || typeof address === 'string') {
                rejectPromise(new Error('server did not bind a TCP address'))
                return
            }
            resolvePromise({ host: address.address, port: address.port })
        })
    })

    const sleepMs = Math.max(1, options.ttlMonitorSleepSecs ?? 60) * 1000
    const ttlTimer = setInterval(() => {
        try {
            binding.ttlMonitor(store, null)
        } catch {
            // A store error must not kill the scan loop; the next tick retries.
        }
    }, sleepMs)
    ttlTimer.unref()

    return {
        listening,
        get address(): ServerAddress | null {
            const address = netServer.address()
            if (address === null || typeof address === 'string') return null
            return { host: address.address, port: address.port }
        },
        stats,
        async close() {
            if (closed) return
            closed = true
            clearInterval(ttlTimer)
            await new Promise<void>((resolvePromise) => netServer.close(() => resolvePromise()))
            for (const socket of sockets) socket.destroy()
            sockets.clear()
        }
    }
}

function boundPort(server: net.Server): number | null {
    const address = server.address()
    if (address === null || typeof address === 'string') return null
    return address.port
}

/** Best-effort error reply for a frame whose header is still readable. */
function sendProtocolError(socket: net.Socket, frame: Buffer, message: string): void {
    const header = peekHeader(frame)
    if (!header) return
    try {
        const body = binding.encodeOpMsg(JSON.stringify(document(binding.errorReply(2, message))))
        socket.write(encodeMsgFrame(0, header.requestId, body))
    } catch {
        // The connection is torn down either way.
    }
}
