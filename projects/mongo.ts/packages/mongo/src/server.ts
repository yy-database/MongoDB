// MongoDB wire-protocol listener.
//
// The server owns the socket loop, the cursor table and TTL ticks; each command
// is lowered to one Rust primitive. Compression is transport-only: an
// `OP_COMPRESSED` frame is unwrapped, the payload is decoded by `mongo`,
// and the reply is wrapped in the same compressor the request used (which is
// what `mongod 8.0.9` does, even when that compressor was not negotiated).
import { mkdirSync, readFileSync, rmSync, statfsSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import { join, resolve } from 'node:path'
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
    usersInfoCommand,
    type AuthState
} from './auth.ts'
import {
    createReplicaState,
    noteWrite,
    numberValue,
    replicaCommand,
    replicaError,
    restoreReplicaConfig,
    stampReply,
    topologyHandshake,
    writeStamps,
    type ReplicaState
} from './replica.ts'
import {
    evaluateWriteConcern,
    readPreferenceError,
    WRITE_CONCERN_COMMANDS,
    writeConcernReply,
    type WriteConcernDecision
} from './write-concern.ts'
import { authorizeCommand, clusterGrants, databaseInScope, privilegesForRoles } from './authorization.ts'
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
    /** Directory that holds `mongo.yykv` and the `mongo.lock` file. */
    dataDir: string
    port?: number
    host?: string
    /** Defaults to every codec the implementation actually speaks. */
    compressors?: string[]
    /** Background TTL scan period, mirroring `ttlMonitorSleepSecs`. */
    ttlMonitorSleepSecs?: number
    /** Replica set name, mirroring `mongod --replSet`. */
    replSet?: string
    /**
     * Capped size of `local.oplog.rs` in megabytes. Only used with `replSet`;
     * defaults to 990, which is smaller than the 5.3 GB `mongod` reserves on
     * this host but large enough for the writes an acceptance run produces.
     */
    oplogSizeMB?: number
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
    /** `connectionId` reported by the handshake, in accept order. */
    connectionId: number
}

interface ServerView {
    port: number | null
    openConnections: number
    totalConnections: number
    dataDir: string
    replica: ReplicaState
    /** Every live connection's cursor table, so a drop reaches all of them. */
    cursorTables: Set<any>
}

/** Per-request write-concern result, filled by `dispatch` and read by `settleWrite`. */
interface WriteSlot {
    decision: WriteConcernDecision | null
}

const OK = { $numberDouble: '1.0' }

/** Commands that advance the replica-set `optime`, as `mongod`'s writes do. */
const WRITE_COMMANDS = WRITE_CONCERN_COMMANDS

function replyOk(body: any): boolean {
    return body?.ok === 1 || body?.ok?.$numberDouble === '1.0' || body?.ok?.$numberInt === '1'
}

/**
 * `true` for an `OP_MSG` carrying the `moreToCome` flag: drivers set it for
 * unacknowledged writes (`w: 0`) and never read a reply, so answering would
 * desynchronise the next command on that socket.
 */
function moreToCome(inbound: InboundFrame): boolean {
    return inbound.opcode === OP_MSG && inbound.payload.length >= 4 && (inbound.payload.readInt32LE(0) & 2) !== 0
}

/**
 * Commits the oplog entries a write staged, advances the replica-set optime
 * with their timestamp and rewrites the reply in `mongod`'s field order.
 *
 * A failed write staged entries that must never reach the oplog, so they are
 * discarded. A write that changed nothing stages nothing, and its `opTime` is
 * the unchanged last timestamp, which is what `mongod` reports.
 */
function settleWrite(
    store: any,
    state: ReplicaState,
    name: unknown,
    body: any,
    decision: WriteConcernDecision | null
): any {
    if (typeof name !== 'string' || !WRITE_CONCERN_COMMANDS.has(name)) return body
    const ok = replyOk(body)
    if (!ok) {
        binding.discardOplog(store)
        return body
    }
    const last = binding.commitOplog(store, Date.now())
    if (typeof last === 'string') {
        const optime = JSON.parse(last)
        noteWrite(state, { t: optime.t, i: optime.i })
    }
    return writeConcernReply(name, body, decision, writeStamps(state), ok)
}

/**
 * `commitTransaction` / `abortTransaction` validation, measured on
 * `mongod 8.0.9` (single-member replica set, raw `OP_MSG` probes):
 *
 * - `autocommit: true` answers `72 InvalidOptions` with
 *   "Specifying autocommit=true is not allowed.";
 * - `autocommit: false` without a `txnNumber` answers `72 InvalidOptions`
 *   with "'autocommit' field requires a transaction number to also be
 *   specified";
 * - a `txnNumber` without an `lsid` answers `72 InvalidOptions` with
 *   "Transaction number requires a session ID to also be specified";
 * - a `txnNumber` without `autocommit: false` answers
 *   `50768 NotARetryableWriteCommand` naming the command;
 * - neither `txnNumber` nor `autocommit` answers `125 CommandFailed`
 *   "<name> must be run within a transaction";
 * - a well-formed commit/abort only runs against `admin`: any other command
 *   database answers `13 Unauthorized` "<name> may only be run against the
 *   admin database." (the autocommit checks above win over this one, which
 *   is the measured order).
 */
function transactionCommandError(name: string, command: any): any | null {
    const autocommit = command.autocommit
    const hasTxnNumber = command.txnNumber !== undefined
    const hasLsid = command.lsid !== undefined
    if (autocommit === true) {
        return { ok: { $numberDouble: '0.0' }, errmsg: 'Specifying autocommit=true is not allowed.', code: numberValue(72), codeName: 'InvalidOptions' }
    }
    if (autocommit === false && !hasTxnNumber) {
        return { ok: { $numberDouble: '0.0' }, errmsg: "'autocommit' field requires a transaction number to also be specified", code: numberValue(72), codeName: 'InvalidOptions' }
    }
    if (hasTxnNumber && !hasLsid) {
        return { ok: { $numberDouble: '0.0' }, errmsg: 'Transaction number requires a session ID to also be specified', code: numberValue(72), codeName: 'InvalidOptions' }
    }
    if (hasTxnNumber && autocommit === undefined) {
        return {
            ok: { $numberDouble: '0.0' },
            errmsg: `txnNumber may only be provided for multi-document transactions and retryable write commands. autocommit:false was not provided, and ${name} is not a retryable write command.`,
            code: numberValue(50768),
            codeName: 'NotARetryableWriteCommand'
        }
    }
    if (!hasTxnNumber && autocommit === undefined) {
        return { ok: { $numberDouble: '0.0' }, errmsg: `${name} must be run within a transaction`, code: numberValue(125), codeName: 'CommandFailed' }
    }
    if ((command.$db ?? 'admin') !== 'admin') {
        return { ok: { $numberDouble: '0.0' }, errmsg: `${name} may only be run against the admin database.`, code: numberValue(13), codeName: 'Unauthorized' }
    }
    return null
}

/**
 * Reads the persisted replica-set configuration from `local.system.replset`.
 * A fresh store answers with an empty batch, which is how `mongod` behaves
 * before the set has ever been initiated.
 */
function readStoredReplicaConfig(store: any): any | null {
    const cursors = new binding.MongoCursors()
    const reply = document(binding.find(store, cursors, commandText({ find: 'system.replset', filter: {}, $db: 'local' })))
    const batch = reply?.cursor?.firstBatch
    return Array.isArray(batch) && batch.length > 0 ? batch[0] : null
}

/**
 * Writes the set configuration into `local.system.replset`, like `mongod`'s
 * initiation does. The set document is replication metadata, not data, so any
 * oplog entry the write staged is discarded instead of committed.
 */
function writeStoredReplicaConfig(store: any, config: any): boolean {
    const reply = document(
        binding.insert(store, commandText({ insert: 'system.replset', documents: [config], $db: 'local' }))
    )
    binding.discardOplog(store)
    return replyOk(reply)
}

function hostPrefix(): string {
    return os.hostname()
}

/** Commands `mongod` replays from its retry registry instead of running twice. */
const RETRYABLE_WRITE_COMMANDS = new Set(['insert', 'update', 'delete', 'findAndModify', 'bulkWrite'])

/** Entry and age bound of the in-memory retry registry. */
const RETRY_MAX_ENTRIES = 4096
const RETRY_MAX_AGE_MS = 30 * 60 * 1000

interface RetryRecord {
    reply: any
    storedAt: number
}

/** Unwraps an extended-JSON integer into the decimal text the registry keys on. */
function integerText(value: unknown): string {
    if (value !== null && typeof value === 'object') {
        for (const key of ['$numberInt', '$numberLong', '$numberDouble']) {
            if (Object.hasOwn(value, key)) return String((value as any)[key])
        }
    }
    return String(value)
}

/**
 * The `(lsid, txnNumber, stmtId)` identity of a retryable write, or `null` when
 * the command is not retryable or carries no `txnNumber`. A missing `stmtId`
 * keys as `0`, which is what `mongod` stores for single-statement writes.
 */
function retryKey(name: unknown, command: any): string | null {
    if (typeof name !== 'string' || !RETRYABLE_WRITE_COMMANDS.has(name)) return null
    const lsid = command?.lsid?.id?.$binary
    if (typeof lsid?.base64 !== 'string' || command.txnNumber === undefined) return null
    const stmt = command.stmtId === undefined ? '0' : integerText(command.stmtId)
    return `${lsid.subType ?? '04'}|${lsid.base64}|${integerText(command.txnNumber)}|${stmt}`
}

/**
 * The stored reply of a retried write with `retriedStmtIds` inserted before
 * `ok`, exactly where `mongod 8.0.9` puts it. `opTime` and `operationTime` keep
 * the cached timestamps; only `$clusterTime` is re-stamped when the reply is
 * sent again.
 */
function replayedReply(stored: any, stmtId: string): any {
    const result: any = {}
    for (const [key, value] of Object.entries(stored)) {
        if (key === 'ok') result.retriedStmtIds = [{ $numberInt: stmtId }]
        result[key] = value
    }
    return result
}

/**
 * Settled replies of retryable writes, keyed by `retryKey`, kept in process
 * memory: bounded by entry count and age, evicting the oldest entry first.
 * `mongod` persists the same records in `config.transactions`; a restart here
 * forgets them (documented in `KNOWN-DIFFERENCES.md`).
 */
class RetryRegistry {
    private records = new Map<string, RetryRecord>()

    get(key: string): RetryRecord | null {
        const record = this.records.get(key)
        if (record === undefined) return null
        if (Date.now() - record.storedAt > RETRY_MAX_AGE_MS) {
            this.records.delete(key)
            return null
        }
        return record
    }

    store(key: string, reply: any): void {
        const now = Date.now()
        for (const [entry, record] of this.records) {
            if (now - record.storedAt > RETRY_MAX_AGE_MS) this.records.delete(entry)
        }
        while (this.records.size >= RETRY_MAX_ENTRIES) {
            const oldest = this.records.keys().next()
            if (oldest.done === true) break
            this.records.delete(oldest.value)
        }
        this.records.set(key, { reply, storedAt: now })
    }
}

function hasCurrentOpStage(stage: any): boolean {
    return typeof stage === 'object' && stage !== null && Object.hasOwn(stage, '$currentOp')
}

/**
 * The retry-registry key of a command that may be answered from a stored
 * reply, or `null`. The auth gates `dispatch` applies are re-checked here, so
 * a replay never reaches a client that `dispatch` would have refused.
 */
function replayKey(name: unknown, command: any, session: Session, authRequired: boolean): string | null {
    if (typeof name !== 'string' || !RETRYABLE_WRITE_COMMANDS.has(name)) return null
    if (authRequired && session.auth.users.length === 0 && !allowedBeforeAuth(name)) return null
    if (authRequired && session.auth.users.length > 0 && authorizeCommand(session, command) !== null) return null
    return retryKey(name, command)
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

/**
 * `dbStats` reply. The Rust primitive computes every count and byte from the
 * stored documents; this host only contributes the filesystem figures it can
 * measure, and only for a database that exists (which is when `mongod 8.0.9`
 * reports them).
 */
function databaseStatsReply(session: Session, command: any, dataDir: string): any {
    const database = command.$db ?? 'admin'
    const databases = document(binding.listDatabases(session.store)).databases
    const exists = Array.isArray(databases) && databases.some((entry) => entry?.name === database)
    let filesystem: [number, number] | null = null
    if (exists) {
        try {
            const stats = statfsSync(dataDir)
            const total = stats.blocks * stats.bsize
            filesystem = [(stats.blocks - stats.bfree) * stats.bsize, total]
        } catch {
            // An unreadable filesystem reports zero, like an unknown database.
        }
    }
    return document(binding.dbStats(session.store, commandText(command), filesystem?.[0] ?? null, filesystem?.[1] ?? null))
}

/**
 * `dropDatabase`: the Rust store removes every collection, index and user of
 * the database in one atomic step; the reply is `{ ok: 1 }`, and `mongosh`
 * adds the `dropped` field itself. Every live connection's cursors on that
 * database are killed, so a later `getMore` answers `QueryPlanKilled` (175)
 * and then `CursorNotFound`, exactly as `mongod 8.0.9` does.
 */
function dropDatabaseCommand(session: Session, command: any, view: ServerView): any {
    const reply = document(binding.dropDatabase(session.store, commandText(command)))
    if (replyOk(reply)) {
        const database = command.$db ?? 'admin'
        for (const cursors of view.cursorTables) cursors.dropDatabase(database)
    }
    return reply
}

/** `drop`: a successful drop also kills the cursors on that namespace. */
function dropCollectionCommand(session: Session, command: any, view: ServerView): any {
    const reply = document(binding.dropCollection(session.store, commandText(command)))
    if (replyOk(reply)) {
        const database = command.$db ?? 'admin'
        const collection = typeof command.drop === 'string' ? command.drop : ''
        for (const cursors of view.cursorTables) cursors.dropCollection(`${database}.${collection}`)
    }
    return reply
}

/** Unwraps an extended-JSON numeric value. */
function scalarNumber(value: unknown): number {
    if (typeof value === 'number') return value
    if (value && typeof value === 'object') {
        const tagged = value as Record<string, unknown>
        for (const key of ['$numberInt', '$numberLong', '$numberDouble', '$numberDecimal']) {
            if (Object.hasOwn(tagged, key)) return Number(tagged[key])
        }
    }
    return 0
}

/**
 * `listDatabases`, filtered by the authenticated user's scope.
 *
 * `mongod 8.0.9` returns every database when the user holds the cluster-wide
 * `listDatabases` action; otherwise it returns only the databases covered by
 * one of the user's privileges. `authorizedDatabases: false` asks for the
 * unfiltered list, and `authorizeCommand` refuses it without that action.
 */
function listDatabasesCommand(session: Session, command: any, authRequired: boolean): any {
    const reply = document(binding.listDatabases(session.store))
    const databases = Array.isArray(reply.databases) ? reply.databases : null
    if (!authRequired || session.auth.users.length === 0 || databases === null) return reply
    const privileges = privilegesForRoles(session.auth.roles)
    if (clusterGrants(privileges, 'listDatabases')) return reply
    const scoped = databases.filter((entry: any) => typeof entry?.name === 'string' && databaseInScope(privileges, entry.name))
    if (command.nameOnly === true) {
        return { databases: scoped.map((entry: any) => ({ name: entry.name })), ok: reply.ok }
    }
    let totalSize = 0
    for (const entry of scoped) totalSize += scalarNumber(entry?.sizeOnDisk)
    return {
        databases: scoped,
        totalSize: { $numberLong: String(totalSize) },
        totalSizeMb: { $numberLong: String(Math.trunc(totalSize / (1024 * 1024))) },
        ok: reply.ok
    }
}

/** Intersection of the client's `compression` array and what this server really does. */
export function negotiatedCompressors(offered: unknown, supported: string[] = SUPPORTED_COMPRESSORS): string[] {
    if (!Array.isArray(offered)) return []
    return offered.filter((name) => typeof name === 'string' && supported.includes(name))
}

function helloReply(command: any, supported: string[], session: Session, view: ServerView): any {
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

    // `mongod` order: topology first in replica set mode (or the writable-primary
    // flag first standalone), then the static limits, `connectionId` between
    // `logicalSessionTimeoutMinutes` and `minWireVersion`, then negotiated extras.
    const base = document(binding.hello())
    const name = Object.keys(command)[0]
    const result: any = {}
    for (const [key, value] of topologyHandshake(view.replica, name)) result[key] = value
    for (const [key, value] of Object.entries(base)) {
        if (key === 'ok' || key === 'isWritablePrimary') continue
        if (key === 'minWireVersion') result.connectionId = numberValue(session.connectionId)
        result[key] = value
    }
    for (const [key, value] of extras) result[key] = value
    result.ok = base.ok
    return result
}

function dispatch(
    session: Session,
    supported: string[],
    command: any,
    view: ServerView,
    authRequired: boolean,
    me: string,
    write: WriteSlot
): any {
    const name = Object.keys(command)[0]
    if (typeof name !== 'string') throw new WireError('command document is empty')

    if (authRequired && session.auth.users.length === 0 && !allowedBeforeAuth(name)) {
        // The localhost exception: the very first user may be created without
        // credentials, exactly while no user document exists anywhere.
        const localhostException = name === 'createUser' && !anyUserExists(session.store)
        if (!localhostException) return authenticationRequired(name)
    }

    // Once authenticated, every command passes the role check `mongod` applies.
    // The localhost exception above runs before any role exists, so it is not
    // subject to it.
    if (authRequired && session.auth.users.length > 0) {
        const denied = authorizeCommand(session, command)
        if (denied) return denied
    }

    // `$readPreference` is parsed and rejected like `mongod`; routing stays the
    // client's job, so the value is then ignored.
    const preference = readPreferenceError(command)
    if (preference) return document(binding.errorReply(preference.code, preference.message))

    // A rejected write concern must stop the write before it happens, exactly
    // as `mongod` refuses `w: 2` on a standalone server.
    if (WRITE_CONCERN_COMMANDS.has(name)) {
        const decision = evaluateWriteConcern(command, view.replica.name)
        if (decision.error) return document(binding.errorReply(decision.error.code, decision.error.message))
        write.decision = decision
    }

    if (name === 'hello' || name === 'isMaster' || name === 'ismaster') return helloReply(command, supported, session, view)
    if (name === 'replSetInitiate' || name === 'replSetGetConfig' || name === 'replSetGetStatus') {
        const reply = replicaCommand(view.replica, name, command, me)
        // A successful initiation persists the set document, like `mongod`
        // writing `local.system.replset` before it answers.
        if (name === 'replSetInitiate' && replyOk(reply) && !writeStoredReplicaConfig(session.store, view.replica.config)) {
            return replicaError(96, 'OperationFailed', 'replica set configuration could not be persisted')
        }
        return reply
    }

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
        case 'usersInfo':
            return usersInfoCommand(session, command)
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
        case 'drop':
            return dropCollectionCommand(session, command, view)
        case 'collMod':
            return document(binding.collMod(session.store, text))
        case 'listCollections':
            return document(binding.listCollections(session.store, text))
        case 'commitTransaction':
        case 'abortTransaction': {
            const invalid = transactionCommandError(name, command)
            if (invalid) return invalid
            return document(name === 'commitTransaction' ? binding.commitTransaction(session.store, text) : binding.abortTransaction(session.store, text))
        }
        case 'listDatabases':
            return listDatabasesCommand(session, command, authRequired)
        case 'dbStats':
            return databaseStatsReply(session, command, view.dataDir)
        case 'collStats':
            return document(binding.collStats(session.store, text))
        case 'dropDatabase':
            return dropDatabaseCommand(session, command, view)
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
            // `mongod 8.0.9` answers an unknown verb with `59 CommandNotFound`
            // and the `codeName` field; the primitive's table does not carry
            // 59, so the reply is assembled here to keep the field set exact.
            return {
                ok: { $numberDouble: '0.0' },
                errmsg: `no such command: '${name}'`,
                code: numberValue(59),
                codeName: 'CommandNotFound'
            }
    }
}

/** File name of the mutual-exclusion lock inside `dataDir`. */
const LOCK_FILE_NAME = 'mongo.lock'

/** Resolved data directories held by a live `createServer` in this process. */
const processDirLocks = new Set<string>()

function lockDirectoryKey(dataDir: string): string {
    const resolved = resolve(dataDir)
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/** `true` when a pid names a process that is still running. */
function pidAlive(pid: unknown): boolean {
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false
    try {
        process.kill(pid, 0)
        return true
    } catch (error) {
        // `EPERM` means the process exists but belongs to another user.
        return (error as NodeJS.ErrnoException).code === 'EPERM'
    }
}

/**
 * Takes the exclusive data-directory lock before the store opens, mirroring
 * `mongod`'s `mongod.lock`: the file is created with `wx` and names the holder
 * (`pid`, host, port, start time). A lock file whose pid is dead is stale and
 * removed, then the exclusive create is retried once; a live holder — another
 * process, or another `createServer` in this one, which no pid check can see —
 * refuses the directory synchronously.
 */
function acquireDirLock(options: ServerOptions): { directory: string; lockPath: string; key: string } {
    const directory = resolve(options.dataDir)
    const key = lockDirectoryKey(options.dataDir)
    if (processDirLocks.has(key)) {
        throw new Error(
            `Unable to lock data directory "${directory}": ${LOCK_FILE_NAME} is already held by process ${process.pid} in this process`
        )
    }
    const lockPath = join(directory, LOCK_FILE_NAME)
    const holder = JSON.stringify({
        pid: process.pid,
        host: options.host ?? '127.0.0.1',
        port: options.port ?? 27017,
        startedAt: new Date().toISOString()
    })
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            writeFileSync(lockPath, `${holder}\n`, { flag: 'wx' })
            processDirLocks.add(key)
            return { directory, lockPath, key }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
            let existing: any = null
            try {
                existing = JSON.parse(readFileSync(lockPath, 'utf8'))
            } catch {
                existing = null
            }
            if (pidAlive(existing?.pid)) {
                throw new Error(
                    `Unable to lock data directory "${directory}": ${LOCK_FILE_NAME} is held by process ${existing.pid}`
                )
            }
            try {
                rmSync(lockPath)
            } catch {
                // A concurrent holder may have taken it back; the retry reports that.
            }
        }
    }
    throw new Error(`Unable to lock data directory "${directory}": the stale ${LOCK_FILE_NAME} keeps reappearing`)
}

export function createServer(options: ServerOptions): MongoServer {
    const host = options.host ?? '127.0.0.1'
    const port = options.port ?? 27017
    const supported = options.compressors ?? SUPPORTED_COMPRESSORS
    mkdirSync(options.dataDir, { recursive: true })
    const dirLock = acquireDirLock(options)

    const store = new binding.MongoStore(join(options.dataDir, 'mongo.yykv'))
    // `mongod --replSet` creates the capped oplog at startup, before the set is
    // initiated; this server registers the namespace and its retention budget
    // the same way, so `local.oplog.rs` is readable from the first write.
    if (options.replSet !== undefined) {
        const megabytes = Math.max(1, options.oplogSizeMB ?? 990)
        binding.enableOplog(store, 'local.oplog.rs', megabytes * 1024 * 1024)
    }
    const authRequired = options.auth === true
    const replica = createReplicaState(options.replSet ?? null)
    // `mongod` reads `local.system.replset` at startup and rejoins the set
    // without a second `replSetInitiate`; the same restore happens here, so a
    // restarted member answers `hello` and `replSetGetStatus` as PRIMARY.
    if (options.replSet !== undefined) {
        const stored = readStoredReplicaConfig(store)
        if (stored !== null) restoreReplicaConfig(replica, stored)
    }
    const retries = new RetryRegistry()
    const stats: ServerStats = { connections: 0, compressedRequests: 0, compressedReplies: 0, negotiated: [] }
    let replyId = 0
    let closed = false

    const sockets = new Set<net.Socket>()
    // Cursor tables of every open connection: `dropDatabase` must reach cursors
    // opened by other clients too, not only the caller's own.
    const cursorTables = new Set<any>()
    const netServer = net.createServer((socket) => {
        stats.connections += 1
        sockets.add(socket)
        const cursors = new binding.MongoCursors()
        cursorTables.add(cursors)
        const session: Session = {
            store,
            cursors,
            negotiated: [],
            auth: createAuthState(),
            connectionId: (replica.connectionCounter += 1)
        }

        let buffer = Buffer.alloc(0)
        const pump = () => {
            while (!closed) {
                if (buffer.length < 16) return
                const total = buffer.readInt32LE(0)
                if (total <= 16 || total > DEFAULT_MAX_FRAME_SIZE) {
                    // `mongod 8.0.9` drops the connection for a frame outside
                    // [17, 48 000 000] without sending any reply document.
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
            let command: any = null
            try {
                command =
                    inbound.opcode === OP_QUERY
                        ? document(binding.decodeOpQuery(inbound.payload))
                        : document(binding.decodeOpMsg(inbound.payload))
                const commandName = Object.keys(command)[0]
                const key = replayKey(commandName, command, session, authRequired)
                if (key !== null) {
                    const cached = retries.get(key)
                    if (cached !== null) {
                        // `mongod` replays the stored reply and never runs the write again.
                        const replay = replayedReply(cached.reply, key.slice(key.lastIndexOf('|') + 1))
                        stats.negotiated = session.negotiated
                        if (!moreToCome(inbound)) reply(inbound.header.requestId, inbound, stampReply(replica, command, replay))
                        return
                    }
                }
                const write: WriteSlot = { decision: null }
                const body = dispatch(
                    session,
                    supported,
                    command,
                    {
                        port: boundPort(netServer),
                        openConnections: sockets.size,
                        totalConnections: stats.connections,
                        dataDir: options.dataDir,
                        replica,
                        cursorTables
                    },
                    authRequired,
                    `${socket.localAddress}:${socket.localPort}`,
                    write
                )
                const settled = settleWrite(store, replica, commandName, body, write.decision)
                if (key !== null && replyOk(settled)) retries.store(key, settled)
                stats.negotiated = session.negotiated
                if (!moreToCome(inbound)) reply(inbound.header.requestId, inbound, stampReply(replica, command, settled))
            } catch (error) {
                binding.discardOplog(store)
                stats.negotiated = session.negotiated
                if (moreToCome(inbound)) return
                const message = (error as Error).message ?? String(error)
                try {
                    reply(inbound.header.requestId, inbound, stampReply(replica, command, document(binding.errorReply(2, message))))
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
        socket.on('close', () => {
            sockets.delete(socket)
            cursorTables.delete(cursors)
        })
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
            cursorTables.clear()
            try {
                rmSync(dirLock.lockPath)
            } catch {
                // The lock file is already gone; releasing the directory is what matters.
            }
            processDirLocks.delete(dirLock.key)
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
