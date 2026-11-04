// Generates `tests/cases/bson.json`.
//
// Expected byte layouts come from the official `bson` package (an independent
// implementation of the BSON specification), not from this repository. The case
// files only keep the resulting literals, so the acceptance runners never call
// the implementation to decide what is correct.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BSON, EJSON } from 'bson'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const target = join(repo, 'tests', 'cases', 'bson.json')

const documents = [
    ['empty', {}],
    ['int32', { a: { $numberInt: '5' } }],
    ['int32_min', { a: { $numberInt: '-2147483648' } }],
    ['int32_max', { a: { $numberInt: '2147483647' } }],
    ['int64_big', { a: { $numberLong: '9007199254740993' } }],
    ['int64_min', { a: { $numberLong: '-9223372036854775808' } }],
    ['int64_max', { a: { $numberLong: '9223372036854775807' } }],
    ['double_zero', { a: { $numberDouble: '0.0' } }],
    ['double_negative_zero', { a: { $numberDouble: '-0.0' } }],
    ['double_positive', { a: { $numberDouble: '1.5' } }],
    ['double_negative', { a: { $numberDouble: '-2.5' } }],
    ['double_round', { a: { $numberDouble: '100.0' } }],
    ['bool_true', { a: true }],
    ['bool_false', { a: false }],
    ['null', { a: null }],
    ['object_id', { a: { $oid: '00112233445566778899aabb' } }],
    ['binary_empty', { a: { $binary: { base64: '', subType: '00' } } }],
    ['binary_one', { a: { $binary: { base64: 'AQ==', subType: '00' } } }],
    ['binary_three', { a: { $binary: { base64: 'AQID', subType: '00' } } }],
    ['binary_five', { a: { $binary: { base64: 'AAECAwQ=', subType: '00' } } }],
    ['string_empty', { a: '' }],
    ['string_ascii', { a: 'hello' }],
    ['string_utf8', { a: '中文' }],
    ['string_emoji', { a: '🙂' }],
    ['nested_document', { a: { b: { $numberInt: '7' }, c: 'x' } }],
    ['nested_array', { a: [{ $numberInt: '1' }, { $numberInt: '2' }, { $numberInt: '3' }] }],
    [
        'mixed_array',
        { a: [{ $numberInt: '1' }, 'two', null, true, { b: { $numberInt: '2' } }] },
    ],
    ['all_types', {
        a: { $numberInt: '1' },
        b: { $numberLong: '2' },
        c: { $numberDouble: '3.5' },
        d: 'four',
        e: true,
        f: null,
        g: { $oid: 'ffeeddccbbaa998877665544' },
        h: { $binary: { base64: 'AQIDBA==', subType: '00' } },
        i: [{ $numberInt: '5' }],
    }],
    ['many_fields', Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`f${String(index).padStart(2, '0')}`, { $numberInt: String(index) }]))],
    ['deep_eight', nest(8)],
    ['large_string', { a: 'x'.repeat(4096), b: { $numberInt: '9' } }],
]

function nest(depth) {
    let value = { leaf: { $numberInt: '1' } }
    for (let index = 0; index < depth; index += 1) value = { child: value }
    return { a: value }
}

function sortKeys(value) {
    if (Array.isArray(value)) return value.map(sortKeys)
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.keys(value)
                .sort()
                .map((key) => [key, sortKeys(value[key])]),
        )
    }
    return value
}

function ejson(value) {
    return EJSON.parse(JSON.stringify(value), { relaxed: false })
}

function bytesOf(document) {
    return BSON.serialize(ejson(sortKeys(document))).toString('hex')
}

const cases = []

for (const [name, document] of documents) {
    const sorted = sortKeys(document)
    const hex = bytesOf(sorted)
    cases.push({
        id: `bson.encode.${name}`,
        surface: 'bson',
        program: [{ op: 'encodeDocument', document: sorted, as: 'r' }],
        checks: [{ at: '/r', equals: hex }],
    })
    cases.push({
        id: `bson.decode.${name}`,
        surface: 'bson',
        program: [{ op: 'decodeDocument', hex, as: 'r' }],
        checks: [{ at: '/r', equals: sorted }],
    })
}

const messages = [
    ['ping', { ping: { $numberInt: '1' } }],
    ['find', { find: 'items', $db: 'app' }],
    ['filtered', { find: 'items', $db: 'app', filter: { a: { $numberInt: '5' } }, limit: { $numberInt: '1' } }],
    ['insert', { insert: 'items', $db: 'app' }],
]

for (const [name, document] of messages) {
    const sorted = sortKeys(document)
    const hex = `0000000000${bytesOf(sorted)}`
    cases.push({
        id: `opmsg.encode.${name}`,
        surface: 'bson',
        program: [{ op: 'encodeOpMsg', document: sorted, as: 'r' }],
        checks: [{ at: '/r', equals: hex }],
    })
    cases.push({
        id: `opmsg.decode.${name}`,
        surface: 'bson',
        program: [{ op: 'decodeOpMsg', hex, as: 'r' }],
        checks: [{ at: '/r', equals: sorted }],
    })
}

// OP_MSG flags 0, one body section, then one document-sequence section carrying
// `insert.documents`; the decoder must fold the sequence into the command.
{
    const body = sortKeys({ insert: 'items', $db: 'app' })
    const sequenceDocuments = [sortKeys({ _id: { $numberInt: '1' }, v: 'a' }), sortKeys({ _id: { $numberInt: '2' }, v: 'b' })]
    const identifier = 'documents'
    const documentBytes = sequenceDocuments.flatMap((document) => Array.from(BSON.serialize(ejson(document))))
    const size = 4 + identifier.length + 1 + documentBytes.length
    const sizeBytes = i32(size)
    const header = Buffer.from([0x01, ...sizeBytes, ...Array.from(Buffer.from(`${identifier}\0`, 'utf8'))])
    const hex = `0000000000${bytesOf(body)}${header.toString('hex')}${Buffer.from(documentBytes).toString('hex')}`
    cases.push({
        id: 'opmsg.decode.document_sequence',
        surface: 'bson',
        program: [{ op: 'decodeOpMsg', hex, as: 'r' }],
        checks: [{ at: '/r', equals: { ...body, documents: sequenceDocuments } }],
    })
}

function i32(value) {
    const buffer = Buffer.alloc(4)
    buffer.writeInt32LE(value)
    return Array.from(buffer)
}

const queries = [
    ['plain', { ping: { $numberInt: '1' } }],
    ['wrapped', { $query: { ping: { $numberInt: '1' } }, foo: { $numberInt: '2' } }, { ping: { $numberInt: '1' } }],
    ['find', { find: 'items', $db: 'app' }],
]

for (const [name, document, expected] of queries) {
    const sorted = sortKeys(document)
    const hex = `00000000${Buffer.from('app.items\0', 'utf8').toString('hex')}00000000ffffffff${bytesOf(sorted)}`
    cases.push({
        id: `opquery.decode.${name}`,
        surface: 'bson',
        program: [{ op: 'decodeOpQuery', hex, as: 'r' }],
        checks: [{ at: '/r', equals: expected ?? sorted }],
    })
}

mkdirSync(dirname(target), { recursive: true })
writeFileSync(target, `${JSON.stringify({ version: 1, cases }, null, 4)}\n`)
console.log(`bson cases -> ${target} (${cases.length} cases, ${cases.length} assertions)`)
