#!/usr/bin/env node
// Independent `.yyds` catalog reader.
//
// This file is deliberately not part of the Store implementation: it re-reads
// the canonical `yyds-formats` catalog layout from the specification
// (`magic`, little-endian fields, optional schema/routing/contract/owners
// sections, shard ids) and prints the parsed fields as JSON. Tests use it to
// check catalogs written by the Rust store byte by byte, without asking the
// store to parse its own output.
import { readFileSync } from 'node:fs'

const MAGIC = Buffer.from('YYDS\x01', 'latin1')

function main(path) {
    const bytes = readFileSync(path)
    const errors = []
    let offset = 0
    const readU32 = (label) => {
        if (offset + 4 > bytes.length) {
            errors.push(`truncated ${label}`)
            return null
        }
        const value = bytes.readUInt32LE(offset)
        offset += 4
        return value
    }
    const readU64 = (label) => {
        if (offset + 8 > bytes.length) {
            errors.push(`truncated ${label}`)
            return null
        }
        const value = bytes.readBigUInt64LE(offset)
        offset += 8
        return Number(value)
    }
    const readString = (label) => {
        const length = readU32(`${label} length`)
        if (length === null) return null
        if (offset + length > bytes.length) {
            errors.push(`truncated ${label}`)
            return null
        }
        const text = bytes.subarray(offset, offset + length).toString('utf8')
        offset += length
        return text
    }

    if (bytes.length < MAGIC.length || !bytes.subarray(0, MAGIC.length).equals(MAGIC)) {
        errors.push('bad magic')
    }
    offset = MAGIC.length

    const version = readU32('version')
    const schemaPresent = readU32('schema flag')
    let schema = null
    if (schemaPresent === 1) {
        const schemaVersion = readU32('schema version')
        const document = readString('schema document')
        schema = { version: schemaVersion, document }
    } else if (schemaPresent !== 0) {
        errors.push(`bad schema flag ${schemaPresent}`)
    }
    const routingPresent = readU32('routing flag')
    let routingEpoch = null
    if (routingPresent === 1) routingEpoch = readU64('routing epoch')
    else if (routingPresent !== 0) errors.push(`bad routing flag ${routingPresent}`)
    const shardCount = readU32('shard count')
    const shards = []
    if (shardCount !== null) {
        for (let index = 0; index < shardCount; index += 1) {
            shards.push(readString(`shard ${index}`))
        }
    }
    const contractPresent = readU32('contract flag')
    let contractLength = null
    if (contractPresent === 1) {
        contractLength = readU32('contract length')
        if (contractLength !== null) {
            if (offset + contractLength > bytes.length) errors.push('truncated contract')
            else offset += contractLength
        }
    } else if (contractPresent !== 0) {
        errors.push(`bad contract flag ${contractPresent}`)
    }
    const ownerCount = readU32('owner count')
    const owners = []
    if (ownerCount !== null) {
        for (let index = 0; index < ownerCount; index += 1) {
            const shard = readString(`owner ${index} shard`)
            const node = readString(`owner ${index} node`)
            const term = readU64(`owner ${index} term`)
            owners.push({ shard, node, term })
        }
    }
    const trailing = bytes.length - offset
    if (trailing !== 0) errors.push(`trailing ${trailing} byte(s)`)

    let namespaces = null
    if (schema && typeof schema.document === 'string') {
        try {
            const parsed = JSON.parse(schema.document)
            if (Array.isArray(parsed.namespaces)) namespaces = parsed.namespaces
            else errors.push('schema document has no namespaces array')
            if (parsed.version !== 1) errors.push(`schema document version ${parsed.version}`)
        } catch {
            errors.push('schema document is not JSON')
        }
    }

    return {
        ok: errors.length === 0,
        byteLength: bytes.length,
        version,
        schema: schema && { present: true, version: schema.version, length: schema.document === null ? null : Buffer.byteLength(schema.document) },
        namespaces,
        routingEpoch,
        shardCount,
        shards,
        contractPresent: contractPresent === 1,
        contractLength,
        ownerCount,
        owners,
        trailing,
        errors,
    }
}

const report = main(process.argv[2])
process.stdout.write(`${JSON.stringify(report)}\n`)
