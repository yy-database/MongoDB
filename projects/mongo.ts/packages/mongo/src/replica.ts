/**
 * Single-node replica set state.
 *
 * `mongod --replSet` persists the set configuration in `local.system.replset`
 * and keeps the topology counters per process; this server does the same for
 * one member. The shapes below were captured from `mongod 8.0.9`
 * (`replSetInitiate`, `replSetGetConfig`, `replSetGetStatus`, `hello` before
 * and after initiation, and the stored `local.system.replset` document across
 * a restart).
 */
import { randomBytes } from 'node:crypto'

export interface ReplicaState {
    /** `--repl-set` name; `null` means the server is not replication-enabled. */
    name: string | null
    /** Fixed for the process, like `mongod`'s topology process id. */
    processId: string
    /** `topologyVersion.counter`, increased whenever the member state changes. */
    counter: number
    /** Per-connection `connectionId` values, handed out in accept order. */
    connectionCounter: number
    initialized: boolean
    config: any | null
    electionId: string | null
    replicaSetId: string | null
    startedAt: number
    electedAt: number
    seconds: number
    increment: number
    /** Successful writes so far; `optime.t` stays `-1` until the first one. */
    writes: number
}

export function createReplicaState(name: string | null): ReplicaState {
    const now = Date.now()
    return {
        name,
        processId: randomBytes(12).toString('hex'),
        counter: 0,
        connectionCounter: 0,
        initialized: false,
        config: null,
        electionId: null,
        replicaSetId: null,
        startedAt: now,
        electedAt: now,
        seconds: Math.floor(now / 1000),
        increment: 0,
        writes: 0
    }
}

/**
 * Records a write so `optime` advances with the activity this server really
 * has. When the write produced oplog entries, their last timestamp is adopted
 * verbatim so replies and `local.oplog.rs` cannot drift apart.
 */
export function noteWrite(state: ReplicaState, optime?: { t: number; i: number }): void {
    if (state.name === null || !state.initialized) return
    state.writes += 1
    if (optime !== undefined) {
        state.seconds = optime.t
        state.increment = optime.i
        return
    }
    const seconds = Math.floor(Date.now() / 1000)
    if (seconds !== state.seconds) {
        state.seconds = seconds
        state.increment = 0
    }
    else {
        state.increment += 1
    }
}

/**
 * The `electionId` and `opTime` a replica-set write reply carries, or `null`
 * when the member is not an initiated primary (a standalone server, or a set
 * that has not received its configuration yet).
 */
export function writeStamps(state: ReplicaState): { electionId: any; opTime: any } | null {
    if (state.name === null || !state.initialized || state.electionId === null) return null
    return { electionId: objectId(state.electionId), opTime: opTime(state) }
}

function objectId(hex: string | null): any {
    return { $oid: hex }
}

export function numberValue(value: number): any {
    if (value >= -2_147_483_648 && value <= 2_147_483_647) return { $numberInt: String(value) }
    return { $numberLong: String(value) }
}

function dateValue(milliseconds: number): any {
    return { $date: { $numberLong: String(milliseconds) } }
}

function timestamp(seconds: number, increment: number): any {
    return { $timestamp: { t: seconds, i: increment } }
}

function opTime(state: ReplicaState): any {
    // `mongod` reports `t: -1` (uninitialised term) until the first op is written.
    const term = state.writes > 0 ? 1 : -1
    return { ts: timestamp(state.seconds, state.increment), t: { $numberLong: String(term) } }
}

function lastWriteBlock(state: ReplicaState): any {
    const written = dateValue(state.seconds * 1000 + state.increment)
    return {
        opTime: opTime(state),
        lastWriteDate: written,
        majorityOpTime: opTime(state),
        majorityWriteDate: written
    }
}

export function replicaError(code: number, codeName: string, message: string): any {
    return { ok: { $numberDouble: '0.0' }, errmsg: message, code: numberValue(code), codeName }
}

/**
 * The topology part of the handshake, in `mongod`'s field order. `hello` and
 * `isMaster` differ only in the writable-primary field name. `connectionId` and
 * the static limits follow it in {@link helloReply}.
 */
export function topologyHandshake(state: ReplicaState, command: string): [string, any][] {
    const primaryField = command === 'hello' ? 'isWritablePrimary' : 'ismaster'
    const entries: [string, any][] = []
    const topologyVersion = { processId: objectId(state.processId), counter: { $numberLong: String(state.counter) } }
    if (state.name === null) {
        entries.push([primaryField, true])
        entries.push(['topologyVersion', topologyVersion])
        return entries
    }

    entries.push(['topologyVersion', topologyVersion])
    if (!state.initialized) {
        entries.push([primaryField, false])
        entries.push(['secondary', false])
        entries.push(['info', 'Does not have a valid replica set config'])
        entries.push(['isreplicaset', true])
        return entries
    }

    const member = state.config.members[0]
    entries.push(['hosts', state.config.members.map((entry: any) => entry.host)])
    entries.push(['setName', state.name])
    entries.push(['setVersion', numberValue(state.config.version)])
    entries.push([primaryField, true])
    entries.push(['secondary', false])
    entries.push(['primary', member.host])
    entries.push(['me', member.host])
    entries.push(['electionId', objectId(state.electionId)])
    entries.push(['lastWrite', lastWriteBlock(state)])
    return entries
}

function normalizeMember(member: any): any {
    return {
        _id: member._id,
        host: member.host,
        arbiterOnly: member.arbiterOnly ?? false,
        buildIndexes: member.buildIndexes ?? true,
        hidden: member.hidden ?? false,
        priority: member.priority ?? 1,
        tags: member.tags ?? {},
        secondaryDelaySecs: { $numberLong: String(member.secondaryDelaySecs ?? 0) },
        votes: member.votes ?? 1
    }
}

function normalizeConfig(config: any, replicaSetId: string): any {
    return {
        _id: config._id,
        version: 1,
        term: 0,
        members: config.members.map(normalizeMember),
        protocolVersion: { $numberLong: '1' },
        writeConcernMajorityJournalDefault: true,
        settings: {
            chainingAllowed: true,
            heartbeatIntervalMillis: 2000,
            heartbeatTimeoutSecs: 10,
            electionTimeoutMillis: 10000,
            catchUpTimeoutMillis: -1,
            catchUpTakeoverDelayMillis: 30000,
            getLastErrorModes: {},
            getLastErrorDefaults: { w: 1, wtimeout: 0 },
            replicaSetId: objectId(replicaSetId)
        }
    }
}

/**
 * Flattens the extended-JSON scalars a stored document comes back with:
 * tagged numbers become plain numbers, `$oid` becomes its hex string.
 */
function unwrapStoredValue(value: any): any {
    if (Array.isArray(value)) return value.map(unwrapStoredValue)
    if (value !== null && typeof value === 'object') {
        const keys = Object.keys(value)
        if (keys.length === 1) {
            const key = keys[0]
            if (key === '$oid') return value[key]
            if (key === '$numberInt' || key === '$numberLong' || key === '$numberDouble' || key === '$numberDecimal') {
                return Number(value[key])
            }
        }
        const result: Record<string, any> = {}
        for (const [name, entry] of Object.entries(value)) result[name] = unwrapStoredValue(entry)
        return result
    }
    return value
}

/**
 * Restores the set configuration persisted in `local.system.replset`, the way
 * `mongod` does at startup: a node started with `--replSet` reads the stored
 * document and comes back as an initiated primary without a second
 * `replSetInitiate`. `replicaSetId` and the member list survive from the
 * stored document; `electionId` is regenerated for the new process, because a
 * restart re-runs the election. A document whose set name does not match the
 * command line, or whose shape is not a usable configuration, is ignored and
 * leaves the member uninitialized.
 */
export function restoreReplicaConfig(state: ReplicaState, stored: any): boolean {
    if (state.name === null || state.initialized) return false
    const config = unwrapStoredValue(stored)
    if (config === null || typeof config !== 'object' || Array.isArray(config)) return false
    if (config._id !== state.name) return false
    if (!Array.isArray(config.members) || config.members.length === 0) return false
    if (config.members.some((member: any) => typeof member?.host !== 'string')) return false
    const replicaSetId =
        typeof config.settings?.replicaSetId === 'string' ? config.settings.replicaSetId : randomBytes(12).toString('hex')
    state.config = normalizeConfig(config, replicaSetId)
    state.replicaSetId = replicaSetId
    state.electionId = `7fffffff${randomBytes(8).toString('hex')}`
    state.initialized = true
    state.electedAt = Date.now()
    state.seconds = Math.floor(state.electedAt / 1000)
    state.increment = 1
    return true
}

/** Renders a BSON scalar the way `mongod` prints it inside an error message. */
function scalarText(value: any): string {
    if (value === null || value === undefined) return 'null'
    if (typeof value === 'number' || typeof value === 'boolean') return String(value)
    if (typeof value === 'string') return value
    if (typeof value === 'object') {
        for (const key of ['$numberInt', '$numberLong', '$numberDouble', '$numberDecimal', '$oid']) {
            if (Object.hasOwn(value, key)) return String(value[key])
        }
    }
    return '[object]'
}

/** `true` for a BSON numeric `1`, however it was encoded. */
function numericOne(value: any): boolean {
    if (typeof value === 'number') return value === 1
    if (value === null || typeof value !== 'object') return false
    for (const key of ['$numberInt', '$numberLong', '$numberDouble', '$numberDecimal']) {
        if (Object.hasOwn(value, key)) return Number(value[key]) === 1
    }
    return false
}

/**
 * `replSetInitiate` moves the member to PRIMARY immediately, which is what a
 * single-member set does. `mongosh`'s `rs.initiate()` sends an empty object and
 * `mongod 8.0.9` answers `info2` with the default single-member configuration.
 * The validation texts mirror `mongod 8.0.9`.
 */
function initiate(state: ReplicaState, command: any, me: string): any {
    if (state.name === null) {
        return replicaError(76, 'NoReplicationEnabled', 'This node was not started with replication enabled.')
    }
    if (state.initialized) return replicaError(23, 'AlreadyInitialized', 'already initialized')

    const requested = command.replSetInitiate
    const emptyRequest =
        numericOne(requested) ||
        (requested !== null &&
            typeof requested === 'object' &&
            !Array.isArray(requested) &&
            !Object.keys(requested).some((key) => key.startsWith('$number')) &&
            Object.keys(requested).length === 0)
    // An absent member host can only be filled from the connection that
    // initiated the set, which is what `mongod` does for the default config.
    const config = emptyRequest ? { _id: state.name, members: [{ _id: 0, host: me }] } : requested
    if (config === null || typeof config !== 'object' || Array.isArray(config)) {
        return replicaError(93, 'InvalidReplicaSetConfig', 'replSetInitiate requires a configuration document')
    }
    if (config._id === undefined) {
        return replicaError(93, 'InvalidReplicaSetConfig', "BSON field 'ReplSetConfig._id' is missing but a required field")
    }
    if (config._id !== state.name) {
        return replicaError(
            93,
            'InvalidReplicaSetConfig',
            `Rejecting initiate with a set name that differs from command line set name, initiate set name: ${String(config._id)}, command line set name: ${state.name}`
        )
    }
    if (config.members === undefined) {
        return replicaError(93, 'InvalidReplicaSetConfig', "BSON field 'ReplSetConfig.members' is missing but a required field")
    }
    if (!Array.isArray(config.members) || config.members.length === 0) {
        return replicaError(
            93,
            'InvalidReplicaSetConfig',
            `Replica set configuration contains ${Array.isArray(config.members) ? config.members.length : 0} members, but must have at least 1 and no more than  50`
        )
    }
    for (const member of config.members) {
        if (member?.host === undefined) {
            return replicaError(
                93,
                'InvalidReplicaSetConfig',
                `member: { _id: ${scalarText(member?._id)} } :: caused by :: BSON field 'MemberConfig.host' is missing but a required field`
            )
        }
    }

    const now = Date.now()
    const replicaSetId = randomBytes(12).toString('hex')
    state.config = normalizeConfig(config, replicaSetId)
    state.replicaSetId = replicaSetId
    state.electionId = `7fffffff${randomBytes(8).toString('hex')}`
    state.initialized = true
    state.electedAt = now
    state.seconds = Math.floor(now / 1000)
    state.increment = 1
    state.counter += 1
    if (emptyRequest) {
        return {
            info2: 'no configuration specified. Using a default configuration for the set',
            me,
            ok: { $numberDouble: '1.0' }
        }
    }
    return { ok: { $numberDouble: '1.0' } }
}

function memberStatus(state: ReplicaState): any {
    const member = state.config.members[0]
    const written = dateValue(state.seconds * 1000 + state.increment)
    return {
        _id: member._id,
        name: member.host,
        health: 1,
        state: 1,
        stateStr: 'PRIMARY',
        uptime: Math.floor((Date.now() - state.startedAt) / 1000),
        optime: opTime(state),
        optimeDate: written,
        optimeWritten: opTime(state),
        optimeWrittenDate: written,
        lastAppliedWallTime: written,
        lastDurableWallTime: written,
        lastWrittenWallTime: written,
        syncSourceHost: '',
        syncSourceId: { $numberInt: '-1' },
        infoMessage: 'Could not find member to sync from',
        electionTime: timestamp(Math.floor(state.electedAt / 1000), 1),
        electionDate: dateValue(state.electedAt),
        configVersion: state.config.version,
        configTerm: 1,
        self: true,
        lastHeartbeatMessage: ''
    }
}

function getStatus(state: ReplicaState): any {
    const written = dateValue(state.seconds * 1000 + state.increment)
    return {
        set: state.name,
        date: dateValue(Date.now()),
        myState: 1,
        term: { $numberLong: '1' },
        syncSourceHost: '',
        syncSourceId: { $numberInt: '-1' },
        heartbeatIntervalMillis: { $numberLong: '2000' },
        majorityVoteCount: 1,
        writeMajorityCount: 1,
        votingMembersCount: 1,
        writableVotingMembersCount: 1,
        optimes: {
            lastCommittedOpTime: opTime(state),
            lastCommittedWallTime: written,
            readConcernMajorityOpTime: opTime(state),
            appliedOpTime: opTime(state),
            durableOpTime: opTime(state),
            writtenOpTime: opTime(state),
            lastAppliedWallTime: written,
            lastDurableWallTime: written,
            lastWrittenWallTime: written
        },
        lastStableRecoveryTimestamp: timestamp(state.seconds, state.increment),
        members: [memberStatus(state)],
        ok: { $numberDouble: '1.0' }
    }
}

/** `replSetInitiate`, `replSetGetConfig` and `replSetGetStatus`. */
export function replicaCommand(state: ReplicaState, name: string, command: any, me: string): any {
    if (name === 'replSetInitiate') return initiate(state, command, me)

    if (state.name === null) return replicaError(76, 'NoReplicationEnabled', 'not running with --replSet')
    if (!state.initialized) return replicaError(94, 'NotYetInitialized', 'no replset config has been received')

    if (name === 'replSetGetConfig') return { config: state.config, ok: { $numberDouble: '1.0' } }
    return getStatus(state)
}
