/**
 * `writeConcern` evaluation and write-reply decoration.
 *
 * The validation texts, error codes and field order below were captured from
 * `mongod 8.0.9` on a standalone server (28017) and a single-member replica set
 * (28070). They match what a real client sees; the parts this single process
 * cannot reproduce (a second member acknowledging `w: 2`) are documented in
 * `KNOWN-DIFFERENCES.md`.
 */

/** Commands whose reply is acknowledged through `writeConcern`. */
export const WRITE_CONCERN_COMMANDS = new Set([
    'insert',
    'update',
    'delete',
    'findAndModify',
    'bulkWrite',
    'create',
    'drop',
    'collMod',
    'createIndexes',
    'dropIndexes',
    'dropDatabase',
    'createUser',
    'dropUser',
    'commitTransaction'
])

/** Commands that put `n`/`writeErrors` in the reply and can be unacknowledged. */
const COUNTER_COMMANDS = new Set(['insert', 'update', 'delete'])

/** Commands whose reply carries `electionId` and `opTime` on a replica set. */
const STAMPED_COMMANDS = new Set(['insert', 'update', 'delete'])

const READ_PREFERENCE_MODES = new Set([
    'primary',
    'primaryPreferred',
    'secondary',
    'secondaryPreferred',
    'nearest'
])

export interface WriteConcernDecision {
    /** `w: 0`: the write runs, but its counters are not acknowledged. */
    unacknowledged: boolean
    /** Reply to send instead of running the command; the write did not happen. */
    error: { code: number; message: string } | null
    /** `writeConcernError` to attach to a successful reply. */
    writeConcernError: any | null
}

const NO_CONCERN: WriteConcernDecision = { unacknowledged: false, error: null, writeConcernError: null }

/** A BSON scalar's name as `mongod` prints it inside a type error. */
export function bsonTypeName(value: unknown): string {
    if (value === null || value === undefined) return 'null'
    if (typeof value === 'string') return 'string'
    if (typeof value === 'boolean') return 'bool'
    if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'double'
    if (Array.isArray(value)) return 'array'
    if (typeof value === 'object') {
        const tagged = value as Record<string, unknown>
        const names: [string, string][] = [
            ['$numberInt', 'int'],
            ['$numberLong', 'long'],
            ['$numberDouble', 'double'],
            ['$numberDecimal', 'decimal'],
            ['$oid', 'objectId'],
            ['$date', 'date'],
            ['$timestamp', 'timestamp'],
            ['$binary', 'binData'],
            ['$regularExpression', 'regex'],
            ['$minKey', 'minKey'],
            ['$maxKey', 'maxKey']
        ]
        for (const [key, name] of names) {
            if (Object.hasOwn(tagged, key)) return name
        }
        return 'object'
    }
    return 'object'
}

/** Unwraps an extended-JSON number, or `null` when the value is not numeric. */
function unwrapNumber(value: unknown): number | null {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
    const tagged = value as Record<string, unknown>
    for (const key of ['$numberInt', '$numberLong', '$numberDouble', '$numberDecimal']) {
        if (Object.hasOwn(tagged, key)) {
            const parsed = Number(tagged[key])
            return Number.isFinite(parsed) ? parsed : null
        }
    }
    return null
}

function errorReply(code: number, message: string): { code: number; message: string } {
    return { code, message }
}

function concernError(code: number, codeName: string, message: string, w: unknown, wtimeout: number): any {
    return {
        code,
        codeName,
        errmsg: message,
        errInfo: { writeConcern: { w, wtimeout, provenance: 'clientSupplied' } }
    }
}

/** `true` when a string is a numeric type name this server accepts. */
function isPlainObject(value: unknown): value is Record<string, any> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * `true` for the one-key extended-JSON wrappers the decoder emits for BSON
 * scalars. Those wrappers are objects to JavaScript but are scalars on the
 * wire, so a `writeConcern: 5` arrives as `{$numberInt: "5"}` and must still be
 * rejected as a non-document.
 */
function isScalarWrapper(value: unknown): boolean {
    if (!isPlainObject(value)) return false
    const tags = [
        '$numberInt',
        '$numberLong',
        '$numberDouble',
        '$numberDecimal',
        '$oid',
        '$date',
        '$timestamp',
        '$binary',
        '$regularExpression',
        '$code',
        '$symbol',
        '$undefined',
        '$minKey',
        '$maxKey'
    ]
    return tags.some((tag) => Object.hasOwn(value, tag))
}

/**
 * Applies `mongod`'s `writeConcern` validation.
 *
 * `replicaSetName` is `null` on a standalone server. Numeric `w` above 50 and
 * negative values are rejected everywhere; on a standalone a numeric `w > 1`
 * and a non-`majority` name are rejected, and on the single-member set a
 * numeric `w > 1` is unsatisfiable (`100`), while an unknown name is reported
 * as `79` while the write itself succeeds.
 */
export function evaluateWriteConcern(command: any, replicaSetName: string | null): WriteConcernDecision {
    const raw = isPlainObject(command) ? command.writeConcern : undefined
    if (raw === undefined) return NO_CONCERN
    if (!isPlainObject(raw) || isScalarWrapper(raw)) {
        return {
            ...NO_CONCERN,
            error: errorReply(14, `"writeConcern" had the wrong type. Expected object, found ${bsonTypeName(raw)}`)
        }
    }

    const wtimeout = unwrapNumber(raw.wtimeout) ?? 0
    const rawW = raw.w
    const w = rawW === undefined ? 1 : unwrapNumber(rawW)

    if (w === null) {
        if (typeof rawW === 'string') {
            // Named write concerns are only meaningful on a replica set.
            if (replicaSetName === null) {
                if (rawW !== 'majority') {
                    return {
                        ...NO_CONCERN,
                        error: errorReply(
                            2,
                            `cannot use non-majority 'w' mode "${rawW}" when a host is not a member of a replica set`
                        )
                    }
                }
                return NO_CONCERN
            }
            if (rawW === 'majority') return NO_CONCERN
            return {
                ...NO_CONCERN,
                writeConcernError: concernError(
                    79,
                    'UnknownReplWriteConcern',
                    `No write concern mode named '${rawW}' found in replica set configuration`,
                    rawW,
                    wtimeout
                )
            }
        }
        if (isPlainObject(rawW)) return NO_CONCERN
        return {
            ...NO_CONCERN,
            error: errorReply(9, `w has to be a number, string, or object; found: ${bsonTypeName(rawW)}`)
        }
    }

    if (w < 0 || w > 50) {
        return {
            ...NO_CONCERN,
            error: errorReply(9, `w has to be a non-negative number and not greater than 50; found: ${w}`)
        }
    }
    if (replicaSetName === null && w > 1) {
        return { ...NO_CONCERN, error: errorReply(2, "cannot use 'w' > 1 when a host is not replicated") }
    }
    if (w === 0) return { ...NO_CONCERN, unacknowledged: true }
    if (w > 1) {
        // The set has one data-bearing member, so `w > 1` can never be met;
        // `mongod` answers UnsatisfiableWriteConcern immediately, even when a
        // `wtimeout` is supplied.
        return {
            ...NO_CONCERN,
            writeConcernError: concernError(
                100,
                'UnsatisfiableWriteConcern',
                'Not enough data-bearing nodes',
                rawW,
                wtimeout
            )
        }
    }
    return NO_CONCERN
}

/** `$readPreference` is validated and then ignored: routing is the client's job. */
export function readPreferenceError(command: any): any | null {
    const raw = isPlainObject(command) ? command.$readPreference : undefined
    if (raw === undefined) return null
    if (!isPlainObject(raw) || isScalarWrapper(raw)) {
        return errorReply(14, `$readPreference has incorrect type: expected object but got ${bsonTypeName(raw)}`)
    }
    const mode = raw.mode
    if (mode === undefined) {
        return errorReply(40414, "BSON field 'readPreference.mode' is missing but a required field")
    }
    if (typeof mode !== 'string' || !READ_PREFERENCE_MODES.has(mode)) {
        return errorReply(2, `Enumeration value '${String(mode)}' for field 'readPreference.mode' is not a valid value.`)
    }
    return null
}

/**
 * Rewrites a successful write reply into `mongod`'s field order:
 * `n`, `electionId`, `opTime`, the remaining counters, `writeConcernError`, `ok`.
 * Unacknowledged replies (`w: 0`) keep `n`/`nModified` at zero and drop the
 * error list, as the real server does.
 */
export function writeConcernReply(
    name: string,
    body: any,
    decision: WriteConcernDecision | null,
    stamps: { electionId: any; opTime: any } | null,
    ok: boolean
): any {
    if (!ok) return body
    const unacknowledged = decision?.unacknowledged === true && COUNTER_COMMANDS.has(name)
    const result: any = {}
    for (const [key, value] of Object.entries(body)) {
        if (key === 'ok' || key === 'writeConcernError') continue
        if (unacknowledged) {
            if (key === 'writeErrors' || key === 'upserted' || key === 'electionId' || key === 'opTime') continue
            if (key === 'n') {
                result.n = 0
                continue
            }
            if (key === 'nModified') {
                result.nModified = 0
                continue
            }
        }
        result[key] = value
        if (key === 'n' && !unacknowledged && stamps !== null && STAMPED_COMMANDS.has(name)) {
            result.electionId = stamps.electionId
            result.opTime = stamps.opTime
        }
    }
    if (!unacknowledged && decision?.writeConcernError) result.writeConcernError = decision.writeConcernError
    result.ok = body.ok
    return result
}
