// BSON value types and the typed bridge to the extended-JSON ABI.
//
// The N-API primitives accept and answer canonical MongoDB Extended JSON
// strings; this module is the only place that walks user documents in and
// replies out. Values keep their BSON identity instead of collapsing through
// a JSON round trip: a plain `number` always encodes as Double, `bigint` as
// Int64, and the tagged forms decode back to `Int32`, `bigint`, `Date`,
// `Uint8Array` and `ObjectId`.

import { randomBytes } from 'node:crypto'

export type Document = Record<string, unknown>

const OBJECT_ID_HEX = /^[0-9a-fA-F]{24}$/

/** Canonical Extended JSON tags the facade's codec understands. */
const EXTENDED_JSON_TAGS = new Set([
    '$oid',
    '$numberInt',
    '$numberLong',
    '$numberDouble',
    '$numberDecimal',
    '$binary',
    '$date',
    '$timestamp',
    '$minKey',
    '$maxKey',
    '$symbol',
    '$regularExpression',
    '$code',
    '$undefined',
    '$dbPointer'
])

const PROCESS_RANDOM = randomBytes(5)
let identifierCounter = randomBytes(3).readUInt8(0)

/** A 12-byte BSON ObjectId. Generated client-side, exactly like the drivers. */
export class ObjectId {
    readonly bytes: Uint8Array

    constructor(value?: string | Uint8Array | ObjectId) {
        if (value === undefined) {
            identifierCounter = (identifierCounter + 1) & 0xff_ffff
            const seconds = Math.floor(Date.now() / 1000)
            const bytes = new Uint8Array(12)
            bytes[0] = (seconds >>> 24) & 0xff
            bytes[1] = (seconds >>> 16) & 0xff
            bytes[2] = (seconds >>> 8) & 0xff
            bytes[3] = seconds & 0xff
            bytes.set(PROCESS_RANDOM, 4)
            bytes[9] = (identifierCounter >>> 16) & 0xff
            bytes[10] = (identifierCounter >>> 8) & 0xff
            bytes[11] = identifierCounter & 0xff
            this.bytes = bytes
        }
        else if (typeof value === 'string') {
            if (!OBJECT_ID_HEX.test(value)) throw new TypeError('ObjectId expects a 24-character hex string')
            this.bytes = hexToBytes(value)
        }
        else if (value instanceof ObjectId) {
            this.bytes = Uint8Array.prototype.slice.call(value.bytes)
        }
        else if (value instanceof Uint8Array) {
            if (value.length !== 12) throw new TypeError('ObjectId expects exactly 12 bytes')
            this.bytes = Uint8Array.prototype.slice.call(value)
        }
        else {
            throw new TypeError('ObjectId accepts a hex string, 12 bytes or another ObjectId')
        }
    }

    static generate(): ObjectId {
        return new ObjectId()
    }

    toHexString(): string {
        let text = ''
        for (const byte of this.bytes) text += byte.toString(16).padStart(2, '0')
        return text
    }

    get timestamp(): Date {
        const seconds = (this.bytes[0] << 24) + (this.bytes[1] << 16) + (this.bytes[2] << 8) + this.bytes[3]
        return new Date(seconds * 1000)
    }

    equals(other: unknown): boolean {
        if (!(other instanceof ObjectId)) return false
        for (let index = 0; index < 12; index += 1) {
            if (this.bytes[index] !== other.bytes[index]) return false
        }
        return true
    }

    toString(): string {
        return this.toHexString()
    }
}

/** A forced 32-bit integer; plain `number` is always Double. */
export class Int32 {
    readonly value: number

    constructor(value: number) {
        if (!Number.isInteger(value) || value < -2_147_483_648 || value > 2_147_483_647) {
            throw new TypeError('Int32 expects an integer in [-2^31, 2^31)')
        }
        this.value = value
    }
}

function hexToBytes(text: string): Uint8Array {
    const bytes = new Uint8Array(text.length / 2)
    for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = Number.parseInt(text.slice(index * 2, index * 2 + 2), 16)
    }
    return bytes
}

/** Turns one user value into its canonical Extended JSON form. */
export function encodeValue(value: unknown): unknown {
    if (value === null) return null
    if (typeof value === 'boolean' || typeof value === 'string') return value
    if (typeof value === 'number') return { $numberDouble: String(value) }
    if (typeof value === 'bigint') return { $numberLong: String(value) }
    if (typeof value !== 'object') {
        throw new TypeError(`cannot encode BSON value of type ${typeof value}`)
    }
    if (value instanceof ObjectId) return { $oid: value.toHexString() }
    if (value instanceof Int32) return { $numberInt: String(value.value) }
    if (value instanceof Date) {
        const milliseconds = value.getTime()
        if (Number.isNaN(milliseconds)) throw new TypeError('cannot encode an invalid Date')
        return { $date: { $numberLong: String(milliseconds) } }
    }
    if (value instanceof Uint8Array) {
        return { $binary: { base64: Buffer.from(value).toString('base64'), subType: '00' } }
    }
    if (Array.isArray(value)) return value.map(encodeValue)
    const record = value as Record<string, unknown>
    const keys = Object.keys(record)
    if (keys.length === 1 && EXTENDED_JSON_TAGS.has(keys[0])) return record
    const encoded: Record<string, unknown> = {}
    for (const key of keys) encoded[key] = encodeValue(record[key])
    return encoded
}

/** Turns one whole user document into its canonical Extended JSON form. */
export function encodeDocument(document: Document): Record<string, unknown> {
    if (document === null || typeof document !== 'object' || Array.isArray(document)) {
        throw new TypeError('a BSON document is required')
    }
    const encoded: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(document)) encoded[key] = encodeValue(value)
    return encoded
}

function decodeDate(payload: unknown): Date {
    if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
        const text = (payload as Record<string, unknown>).$numberLong
        if (typeof text === 'string' || typeof text === 'number') return new Date(Number(text))
    }
    if (typeof payload === 'string' || typeof payload === 'number') return new Date(payload)
    throw new TypeError('cannot decode `$date`')
}

/** Turns one canonical Extended JSON value back into its typed form. */
export function decodeValue(value: unknown): unknown {
    if (value === null) return null
    if (typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
        return value
    }
    if (typeof value !== 'object') return value
    if (Array.isArray(value)) return value.map(decodeValue)
    const record = value as Record<string, unknown>
    const keys = Object.keys(record)
    if (keys.length === 1 && EXTENDED_JSON_TAGS.has(keys[0])) {
        const payload = record[keys[0]]
        switch (keys[0]) {
            case '$oid':
                return new ObjectId(String(payload))
            case '$numberInt':
                return new Int32(Number(payload))
            case '$numberLong':
                return BigInt(String(payload))
            case '$numberDouble':
                return Number(payload)
            case '$date':
                return decodeDate(payload)
            case '$binary': {
                const base64 = (payload as Record<string, unknown>).base64
                return new Uint8Array(Buffer.from(String(base64), 'base64'))
            }
            default:
                // Decimal128, Timestamp, Regex and the remaining tags keep their
                // Extended JSON shape; the typed wrappers for them are not part
                // of this surface yet.
                return record
        }
    }
    const decoded: Record<string, unknown> = {}
    for (const key of keys) decoded[key] = decodeValue(record[key])
    return decoded
}

/** Turns one whole canonical Extended JSON reply into typed values. */
export function decodeDocument(raw: Record<string, unknown>): Document {
    const decoded: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(raw)) decoded[key] = decodeValue(value)
    return decoded
}
