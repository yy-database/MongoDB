// Local-only oracle probe: compare the highest-risk semantics against a real
// mongod 8.0.9 started by the operator. Not part of the default test flow and
// no npm dependencies: the OP_MSG frame is built here (the real server requires
// the command name as the first BSON key, which the repo's extended-JSON
// parser would reorder), and the reply is decoded with this repo's napi binding.
//
// Usage:
//   node scripts/oracle-probe.mjs [--host 127.0.0.1] [--port 28017] [--results .tmp/oracle-results.json]
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import net from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')
const require = createRequire(import.meta.url)
const short = `${process.platform}-${process.arch}`
const binding = require(join(repo, 'projects', 'mongo.ts', 'platforms', `mongo-${short}`, `mongodb.${short}.node`))

const args = process.argv.slice(2)
const option = (name, fallback) => {
    const index = args.indexOf(`--${name}`)
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
const HOST = option('host', '127.0.0.1')
const PORT = Number(option('port', '28017'))
const RESULT_PATH = resolve(repo, option('results', '.tmp/oracle-results.json'))
const DB = 'oracle'

// --- BSON writer (commands only) -------------------------------------------
// Values used by the probes: null, bool, string, int32, int64, double, arrays
// and nested documents, including their extended-JSON wrappers.
function element(value) {
    if (value === null) return [0x0a, Buffer.alloc(0)]
    if (typeof value === 'boolean') return [0x08, Buffer.from([value ? 1 : 0])]
    if (typeof value === 'string') {
        const text = Buffer.from(value, 'utf8')
        const size = Buffer.alloc(4)
        size.writeInt32LE(text.length + 1)
        return [0x02, Buffer.concat([size, text, Buffer.from([0])])]
    }
    if (typeof value === 'number') {
        if (Number.isInteger(value) && value >= -2147483648 && value <= 2147483647) {
            const bytes = Buffer.alloc(4)
            bytes.writeInt32LE(value)
            return [0x10, bytes]
        }
        const bytes = Buffer.alloc(8)
        bytes.writeDoubleLE(value)
        return [0x01, bytes]
    }
    if (Array.isArray(value)) {
        const object = {}
        value.forEach((item, index) => {
            object[String(index)] = item
        })
        return [0x04, document(object)]
    }
    if (value && typeof value === 'object') {
        if (typeof value.$numberInt === 'string') {
            const bytes = Buffer.alloc(4)
            bytes.writeInt32LE(Number(value.$numberInt))
            return [0x10, bytes]
        }
        if (typeof value.$numberLong === 'string') {
            const bytes = Buffer.alloc(8)
            bytes.writeBigInt64LE(BigInt(value.$numberLong))
            return [0x12, bytes]
        }
        if (typeof value.$numberDouble === 'string') {
            const bytes = Buffer.alloc(8)
            bytes.writeDoubleLE(Number(value.$numberDouble))
            return [0x01, bytes]
        }
        if (typeof value.$oid === 'string') return [0x07, Buffer.from(value.$oid, 'hex')]
        return [0x03, document(value)]
    }
    throw new Error(`BSON writer cannot encode ${typeof value}`)
}

function document(object) {
    const parts = []
    for (const [key, value] of Object.entries(object)) {
        const [type, bytes] = element(value)
        parts.push(Buffer.from([type]), Buffer.from(`${key}\0`, 'utf8'), bytes)
    }
    const size = Buffer.alloc(4)
    size.writeInt32LE(5 + parts.reduce((total, part) => total + part.length, 0))
    return Buffer.concat([size, ...parts, Buffer.from([0])])
}

function frame(command) {
    const body = Buffer.concat([Buffer.alloc(4), Buffer.from([0]), document(command)])
    const header = Buffer.alloc(16)
    header.writeInt32LE(16 + body.length, 0)
    header.writeInt32LE(1, 4)
    header.writeInt32LE(0, 8)
    header.writeInt32LE(2013, 12)
    return Buffer.concat([header, body])
}

function oracleCommand(command) {
    return new Promise((resolvePromise, rejectPromise) => {
        const socket = net.connect(PORT, HOST)
        const chunks = []
        socket.on('connect', () => socket.write(frame(command)))
        socket.on('data', (chunk) => {
            chunks.push(chunk)
            const buffer = Buffer.concat(chunks)
            if (buffer.length < 4) return
            const length = buffer.readInt32LE(0)
            if (buffer.length < length) return
            socket.end()
            try {
                resolvePromise(JSON.parse(binding.decodeOpMsg(buffer.subarray(16, length))))
            } catch (error) {
                rejectPromise(error)
            }
        })
        socket.on('error', rejectPromise)
    })
}

const directory = mkdtempSync(join(tmpdir(), 'mongo-oracle-'))
const store = new binding.MongoStore(join(directory, 's.yykv'))

function localCommand(command) {
    const name = Object.keys(command)[0]
    const text = JSON.stringify(command)
    switch (name) {
        case 'insert':
            return JSON.parse(binding.insert(store, text))
        case 'find':
            return JSON.parse(binding.find(store, new binding.MongoCursors(), text))
        case 'aggregate':
            return JSON.parse(binding.aggregate(store, text))
        case 'delete':
            return JSON.parse(binding.delete(store, text))
        case 'update':
            return JSON.parse(binding.update(store, text))
        case 'count':
            return JSON.parse(binding.count(store, text))
        case 'createIndexes':
            return JSON.parse(binding.createIndexes(store, text))
        case 'listIndexes':
            return JSON.parse(binding.listIndexes(store, text))
        case 'dropIndexes':
            return JSON.parse(binding.dropIndexes(store, text))
        default:
            throw new Error(`unsupported local command ${name}`)
    }
}

function stable(value) {
    if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
    if (value && typeof value === 'object') {
        const keys = Object.keys(value).sort()
        return `{${keys.map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
    }
    return JSON.stringify(value)
}

function firstBatch(reply) {
    return reply?.cursor?.firstBatch ?? null
}

// `$addToSet` output order is not part of the contract, so sort the set itself.
function sortedKeySet(reply) {
    const batch = firstBatch(reply)
    if (!Array.isArray(batch)) return batch
    return batch.map((document) => ({
        ...document,
        ...(Array.isArray(document.s)
            ? { s: [...document.s].sort((a, b) => stable(a).localeCompare(stable(b))) }
            : {})
    }))
}

function isZero(value) {
    if (value === 0) return true
    if (!value || typeof value !== 'object') return false
    return value.$numberInt === '0' || value.$numberDouble === '0' || value.$numberDouble === '0.0'
}

function errorShape(reply) {
    if (reply && isZero(reply.ok)) return { code: reply.code, errmsg: reply.errmsg }
    return { code: null, errmsg: null }
}

// `mongod` prints random collection and index-build UUIDs in this message.
// Mask them so the byte-level template is compared instead of the values.
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
function maskUuid(value) {
    return typeof value === 'string' ? value.replace(UUID_PATTERN, '<uuid>') : value
}

// Index command errors also assert `codeName`, which the real server emits
// alongside `code`.
function indexErrorShape(reply) {
    if (reply && isZero(reply.ok)) {
        return { code: reply.code, codeName: reply.codeName, errmsg: maskUuid(reply.errmsg) }
    }
    return { code: null, codeName: null, errmsg: null }
}

// Aggregation stage failures use the same `code` / `codeName` / `errmsg` triple.
const stageErrorShape = indexErrorShape

// Write commands report modifier failures through `writeErrors` on an
// `ok: 1` reply; compare only the code so message wording does not mask it.
function writeErrorCode(reply) {
    if (reply?.writeErrors?.length) return { code: reply.writeErrors[0].code }
    return { code: reply?.code ?? null }
}

function errorChannel(reply) {
    if (reply?.writeErrors?.length) return 'writeErrors'
    return isZero(reply?.ok) ? 'top-level' : 'other'
}

function insertOutcome(reply) {
    if (reply?.writeErrors?.length) return { rejected: true, code: reply.writeErrors[0].code }
    if (reply && isZero(reply.ok)) return { rejected: true, code: reply.code }
    return { rejected: false, code: null }
}

const insert = (collection, documents, ordered) => ({
    insert: collection,
    documents,
    ...(ordered === undefined ? {} : { ordered }),
    $db: DB
})
const aggregate = (collection, pipeline) => ({ aggregate: collection, pipeline, cursor: {}, $db: DB })
const find = (collection, filter, options = {}) => ({ find: collection, filter, ...options, $db: DB })
const count = (collection, query) => ({ count: collection, query, $db: DB })
const update = (collection, updates) => ({ update: collection, updates, $db: DB })
const remove = (collection, q, limit) => ({ delete: collection, deletes: [{ q, limit }], $db: DB })
const createIndexes = (collection, indexes) => ({ createIndexes: collection, indexes, $db: DB })
const listIndexes = (collection) => ({ listIndexes: collection, $db: DB })
const dropIndexes = (collection, index) => ({ dropIndexes: collection, index, $db: DB })

const collections = {
    unwind: 'oracle_unwind',
    idnum: 'oracle_idnum',
    nullq: 'oracle_nullq',
    arrayq: 'oracle_arrayq',
    sort: 'oracle_sort',
    group: 'oracle_group',
    count: 'oracle_count',
    project: 'oracle_project',
    typeq: 'oracle_typeq',
    regexq: 'oracle_regexq',
    notq: 'oracle_notq',
    sizeq: 'oracle_sizeq',
    inq: 'oracle_inq',
    norq: 'oracle_norq',
    mergeq: 'oracle_mergeq',
    rangeq: 'oracle_rangeq',
    skipq: 'oracle_skipq',
    groupq2: 'oracle_groupq2',
    updq: 'oracle_updq',
    delq: 'oracle_delq',
    countq: 'oracle_countq',
    idxCreate: 'oracle_idx_create',
    idxIdem: 'oracle_idx_idem',
    idxConflict: 'oracle_idx_conflict',
    idxEquivalent: 'oracle_idx_equivalent',
    idxList: 'oracle_idx_list',
    idxDropName: 'oracle_idx_drop_name',
    idxDropStar: 'oracle_idx_drop_star',
    idxDropId: 'oracle_idx_drop_id',
    idxDropUnknown: 'oracle_idx_drop_unknown',
    idxInsertSingle: 'oracle_idx_insert_single',
    idxInsertCompound: 'oracle_idx_insert_compound',
    idxInsertUnordered: 'oracle_idx_insert_unordered',
    idxUpdateSingle: 'oracle_idx_update_single',
    idxUpdateCompound: 'oracle_idx_update_compound',
    idxNever: 'oracle_idx_never',
    idxNameless: 'oracle_idx_nameless',
    idxKeyless: 'oracle_idx_keyless',
    idxBuildDup: 'oracle_idx_build_dup',
    idxDropPattern: 'oracle_idx_drop_pattern',
    idxEmpty: 'oracle_idx_empty',
    multiKey: 'oracle_idx_multikey',
    multiCompound: 'oracle_idx_multicompound',
    multiNested: 'oracle_idx_multikey_nested',
    multiParallel: 'oracle_idx_multikey_parallel',
    multiList: 'oracle_idx_multikey_list',
    multiBuild: 'oracle_idx_multikey_build',
    lookupLocal: 'oracle_lookup_local',
    lookupForeign: 'oracle_lookup_foreign',
    lookupNone: 'oracle_lookup_none',
    sortByCount: 'oracle_sort_by_count'
}

const sortByCountDocuments = [
    // Six groups with distinct counts: equal counts come back in hash order
    // from `mongod`, so ties are never asserted.
    ...Array.from({ length: 6 }, (_, index) => ({ _id: index + 1, x: 3 })),
    ...Array.from({ length: 5 }, (_, index) => ({ _id: 10 + index, x: 2 })),
    { _id: 20, tag: 'missing-x' },
    { _id: 21, tag: 'missing-x' },
    { _id: 22, x: null },
    { _id: 23, x: null },
    ...Array.from({ length: 3 }, (_, index) => ({ _id: 30 + index, x: [1, 2] })),
    ...Array.from({ length: 2 }, (_, index) => ({ _id: 40 + index, x: [] })),
    { _id: 50, x: { y: 1 } }
]

const probes = [
    {
        id: 'unwind.string_form',
        note: '$unwind string form drops null, missing and empty arrays',
        setup: [
            insert(collections.unwind, [
                { _id: 1, a: [1, 2] },
                { _id: 2, a: [] },
                { _id: 3, a: null },
                { _id: 4 },
                { _id: 5, a: 's' },
                { _id: 6, a: [[7, 8], [9]] }
            ])
        ],
        command: aggregate(collections.unwind, [{ $unwind: '$a' }]),
        pick: firstBatch,
        orderMatters: true
    },
    {
        id: 'unwind.preserve_null_and_empty',
        note: 'preserveNullAndEmptyArrays keeps missing/empty/null; path omitted when absent',
        setup: [
            insert(collections.unwind, [
                { _id: 1, a: [1, 2] },
                { _id: 2, a: [] },
                { _id: 3, a: null },
                { _id: 4 },
                { _id: 5, a: 's' },
                { _id: 6, a: [[7, 8], [9]] }
            ])
        ],
        command: aggregate(collections.unwind, [{ $unwind: { path: '$a', preserveNullAndEmptyArrays: true } }]),
        pick: firstBatch,
        orderMatters: true
    },
    {
        id: 'unwind.include_array_index',
        note: 'includeArrayIndex is 0-based; non-array and dropped docs get null',
        setup: [
            insert(collections.unwind, [
                { _id: 1, a: [1, 2] },
                { _id: 2, a: [] },
                { _id: 3, a: null },
                { _id: 4 },
                { _id: 5, a: 's' },
                { _id: 6, a: [[7, 8], [9]] }
            ])
        ],
        command: aggregate(collections.unwind, [{ $unwind: { path: '$a', includeArrayIndex: 'i' } }]),
        pick: firstBatch,
        orderMatters: true
    },
    {
        id: 'unwind.preserve_and_index',
        note: 'both options together on the same documents',
        setup: [
            insert(collections.unwind, [
                { _id: 1, a: [1, 2] },
                { _id: 2, a: [] },
                { _id: 3, a: null },
                { _id: 4 },
                { _id: 5, a: 's' },
                { _id: 6, a: [[7, 8], [9]] }
            ])
        ],
        command: aggregate(collections.unwind, [
            { $unwind: { path: '$a', preserveNullAndEmptyArrays: true, includeArrayIndex: 'i' } }
        ]),
        pick: firstBatch,
        orderMatters: true
    },
    {
        id: 'idnum.double_matches_int',
        note: '1.0 finds a document inserted with _id: 1 (int32)',
        setup: [insert(collections.idnum, [{ _id: 1, tag: 'int' }])],
        command: find(collections.idnum, { _id: { $numberDouble: '1.0' } }),
        pick: firstBatch,
        orderMatters: false
    },
    {
        id: 'idnum.long_matches_int',
        note: 'NumberLong(1) finds a document inserted with _id: 1 (int32)',
        setup: [insert(collections.idnum, [{ _id: 1, tag: 'int' }])],
        command: find(collections.idnum, { _id: { $numberLong: '1' } }),
        pick: firstBatch,
        orderMatters: false
    },
    {
        id: 'idnum.double_precision_high',
        note: 'Long 9007199254740993 must not equal double 9007199254740992.0',
        setup: [insert(collections.idnum, [{ _id: { $numberLong: '9007199254740993' }, tag: 'long' }])],
        command: find(collections.idnum, { _id: { $numberDouble: '9007199254740992.0' } }),
        pick: firstBatch,
        orderMatters: false
    },
    {
        id: 'idnum.double_exact_match',
        note: 'Long 9007199254740992 equals double 9007199254740992.0',
        setup: [insert(collections.idnum, [{ _id: { $numberLong: '9007199254740992' }, tag: 'long' }])],
        command: find(collections.idnum, { _id: { $numberDouble: '9007199254740992.0' } }),
        pick: firstBatch,
        orderMatters: false
    },
    {
        id: 'idnum.duplicate_double_same_batch',
        note: 'one insert command containing _id: 1 and _id: 1.0; real mongod rejects the second',
        setup: [insert(collections.idnum, [{ _id: 1 }, { _id: { $numberDouble: '1.0' } }])],
        command: find(collections.idnum, {}),
        pick: firstBatch,
        orderMatters: false,
        also: { name: 'duplicate_insert_outcome', pick: null, fromSetup: 0 }
    },
    {
        id: 'idnum.duplicate_double_separate',
        note: 'a second insert command with _id: 1.0 duplicates a stored _id: 1',
        setup: [
            insert(collections.idnum, [{ _id: 1 }]),
            insert(collections.idnum, [{ _id: { $numberDouble: '1.0' } }])
        ],
        command: find(collections.idnum, {}),
        pick: firstBatch,
        orderMatters: false,
        also: { name: 'duplicate_insert_outcome', pick: null, fromSetup: 1 }
    },
    {
        id: 'idnum.duplicate_long_separate',
        note: 'a second insert command with NumberLong(1) duplicates a stored _id: 1',
        setup: [
            insert(collections.idnum, [{ _id: 1 }]),
            insert(collections.idnum, [{ _id: { $numberLong: '1' } }])
        ],
        command: find(collections.idnum, {}),
        pick: firstBatch,
        orderMatters: false,
        also: { name: 'duplicate_insert_outcome', pick: null, fromSetup: 1 }
    },
    {
        id: 'nullq.eq_null',
        note: '{a: null} matches missing, explicit null and arrays containing null; not []',
        setup: [
            insert(collections.nullq, [
                { _id: 1 },
                { _id: 2, a: null },
                { _id: 3, a: [] },
                { _id: 4, a: [null] },
                { _id: 5, a: 1 },
                { _id: 6, a: '' }
            ])
        ],
        command: find(collections.nullq, { a: null }),
        pick: firstBatch,
        orderMatters: false
    },
    {
        id: 'nullq.ne_null',
        note: '{a: {$ne: null}} is the complement of {a: null}',
        setup: [
            insert(collections.nullq, [
                { _id: 1 },
                { _id: 2, a: null },
                { _id: 3, a: [] },
                { _id: 4, a: [null] },
                { _id: 5, a: 1 },
                { _id: 6, a: '' }
            ])
        ],
        command: find(collections.nullq, { a: { $ne: null } }),
        pick: firstBatch,
        orderMatters: false
    },
    {
        id: 'nullq.exists_false',
        note: '{a: {$exists: false}} matches only the missing field',
        setup: [
            insert(collections.nullq, [
                { _id: 1 },
                { _id: 2, a: null },
                { _id: 3, a: [] },
                { _id: 4, a: [null] },
                { _id: 5, a: 1 },
                { _id: 6, a: '' }
            ])
        ],
        command: find(collections.nullq, { a: { $exists: false } }),
        pick: firstBatch,
        orderMatters: false
    },
    {
        id: 'nullq.type_null',
        note: '{a: {$type: 10}} matches explicit null only',
        setup: [
            insert(collections.nullq, [
                { _id: 1 },
                { _id: 2, a: null },
                { _id: 3, a: [] },
                { _id: 4, a: [null] },
                { _id: 5, a: 1 },
                { _id: 6, a: '' }
            ])
        ],
        command: find(collections.nullq, { a: { $type: 10 } }),
        pick: firstBatch,
        orderMatters: false
    },
    {
        id: 'nullq.all_empty',
        note: '$all: [] matches no documents',
        setup: [
            insert(collections.nullq, [
                { _id: 1 },
                { _id: 2, a: null },
                { _id: 3, a: [] },
                { _id: 4, a: [null] },
                { _id: 5, a: 1 },
                { _id: 6, a: '' }
            ])
        ],
        command: find(collections.nullq, { a: { $all: [] } }),
        pick: firstBatch,
        orderMatters: false
    },
    {
        id: 'arrayq.dotted_cross_element',
        note: 'dotted conditions may match different array elements without $elemMatch',
        setup: [
            insert(collections.arrayq, [
                { _id: 1, instock: [{ qty: 1, warehouse: 'a' }, { qty: 5, warehouse: 'b' }] },
                { _id: 2, instock: [{ qty: 5, warehouse: 'a' }] }
            ])
        ],
        command: find(collections.arrayq, { 'instock.qty': { $gt: 3 }, 'instock.warehouse': 'a' }),
        pick: firstBatch,
        orderMatters: false
    },
    {
        id: 'arrayq.elem_match_same_element',
        note: '$elemMatch requires both conditions on one element',
        setup: [
            insert(collections.arrayq, [
                { _id: 1, instock: [{ qty: 1, warehouse: 'a' }, { qty: 5, warehouse: 'b' }] },
                { _id: 2, instock: [{ qty: 5, warehouse: 'a' }] }
            ])
        ],
        command: find(collections.arrayq, { instock: { $elemMatch: { qty: { $gt: 3 }, warehouse: 'a' } } }),
        pick: firstBatch,
        orderMatters: false
    },
    {
        id: 'sort.type_order_ascending',
        note: 'cross-type ascending order; array fields sort by their lowest element',
        setup: [
            insert(collections.sort, [
                { _id: 1, a: 1 },
                { _id: 2, a: 'x' },
                { _id: 3 },
                { _id: 4, a: [3, 5] },
                { _id: 5, a: [2, 9] },
                { _id: 7, a: true }
            ])
        ],
        command: aggregate(collections.sort, [{ $sort: { a: 1 } }]),
        pick: firstBatch,
        orderMatters: true
    },
    {
        id: 'sort.type_order_descending',
        note: 'cross-type descending order; array fields sort by their highest element',
        setup: [
            insert(collections.sort, [
                { _id: 1, a: 1 },
                { _id: 2, a: 'x' },
                { _id: 3 },
                { _id: 4, a: [3, 5] },
                { _id: 5, a: [2, 9] },
                { _id: 7, a: true }
            ])
        ],
        command: aggregate(collections.sort, [{ $sort: { a: -1 } }]),
        pick: firstBatch,
        orderMatters: true
    },
    {
        id: 'sort.missing_equals_null',
        note: 'missing sorts like null, below numbers in ascending order',
        setup: [
            insert(collections.sort, [
                { _id: 1, a: 1 },
                { _id: 2, a: 'x' },
                { _id: 3 }
            ])
        ],
        command: aggregate(collections.sort, [{ $sort: { a: 1 } }]),
        pick: firstBatch,
        orderMatters: true
    },
    {
        id: 'group.avg_ignores_non_numeric',
        note: '$avg/$sum ignore non-numeric values; $min/$max only skip null/missing',
        setup: [
            insert(collections.group, [
                { _id: 1, v: 1 },
                { _id: 2, v: 'x' },
                { _id: 3, v: 2 },
                { _id: 4, v: null },
                { _id: 5 }
            ])
        ],
        command: aggregate(collections.group, [
            {
                $group: {
                    _id: null,
                    total: { $sum: '$v' },
                    avg: { $avg: '$v' },
                    min: { $min: '$v' },
                    max: { $max: '$v' }
                }
            }
        ]),
        pick: firstBatch,
        orderMatters: false
    },
    {
        id: 'group.no_numeric_values',
        note: '$sum returns 0 and $avg null; $min/$max return the lone string',
        setup: [
            insert(collections.group, [{ _id: 1, v: 'x' }, { _id: 2, v: null }, { _id: 3 }])
        ],
        command: aggregate(collections.group, [
            {
                $group: {
                    _id: null,
                    total: { $sum: '$v' },
                    avg: { $avg: '$v' },
                    min: { $min: '$v' },
                    max: { $max: '$v' }
                }
            }
        ]),
        pick: firstBatch,
        orderMatters: false
    },
    {
        id: 'group.first_last_after_sort',
        note: '$first/$last follow the explicit $sort order',
        setup: [
            insert(collections.group, [
                { _id: 1, k: 'a', v: 2 },
                { _id: 2, k: 'a', v: 1 }
            ])
        ],
        command: aggregate(collections.group, [
            { $sort: { v: 1 } },
            { $group: { _id: '$k', first: { $first: '$v' }, last: { $last: '$v' } } }
        ]),
        pick: firstBatch,
        orderMatters: false
    },
    {
        id: 'count.empty_collection',
        note: '$count over an empty/missing collection emits no documents',
        setup: [],
        command: aggregate(collections.count, [{ $count: 'n' }]),
        pick: firstBatch,
        orderMatters: false
    },
    {
        id: 'project.mixing_rejected',
        note: 'mixing exclusion with inclusion is rejected; the real code is what matters here',
        setup: [insert(collections.project, [{ _id: 1, a: 1, b: 2 }])],
        command: aggregate(collections.project, [{ $project: { _id: 0, a: 1, b: 0 } }]),
        pick: errorShape,
        orderMatters: false,
        errorProbe: true
    },
    {
        id: 'insert.batch_int_and_double',
        note: 'same insert batch with _id 1 and 1.0; check reply, written docs and n',
        setup: [insert(collections.idnum, [{ _id: 1, tag: 'int' }, { _id: { $numberDouble: '1.0' }, tag: 'double' }])],
        command: find(collections.idnum, {}),
        pick: firstBatch,
        orderMatters: false,
        also: { name: 'insert_outcome', pick: null, fromSetup: 0 }
    },
    {
        id: 'insert.batch_int_and_long',
        note: 'same insert batch with _id 1 and NumberLong(1)',
        setup: [insert(collections.idnum, [{ _id: 1, tag: 'int' }, { _id: { $numberLong: '1' }, tag: 'long' }])],
        command: find(collections.idnum, {}),
        pick: firstBatch,
        orderMatters: false,
        also: { name: 'insert_outcome', pick: null, fromSetup: 0 }
    },
    {
        id: 'insert.batch_int_and_string',
        note: 'same insert batch with numeric _id 1 and string _id "1": both are allowed',
        setup: [insert(collections.idnum, [{ _id: 1, tag: 'int' }, { _id: '1', tag: 'string' }])],
        command: find(collections.idnum, {}),
        pick: firstBatch,
        orderMatters: false,
        also: { name: 'insert_outcome', pick: null, fromSetup: 0 }
    },
    {
        id: 'insert.batch_identical',
        note: 'same insert batch with two identical _id 1 documents',
        setup: [insert(collections.idnum, [{ _id: 1, tag: 'a' }, { _id: 1, tag: 'b' }])],
        command: find(collections.idnum, {}),
        pick: firstBatch,
        orderMatters: false,
        also: { name: 'insert_outcome', pick: null, fromSetup: 0 }
    },
    {
        id: 'insert.batch_third_conflicts',
        note: 'batch [1, 2, 1]: whether the first two documents are committed',
        setup: [insert(collections.idnum, [{ _id: 1 }, { _id: 2 }, { _id: 1, tag: 'again' }])],
        command: find(collections.idnum, {}),
        pick: firstBatch,
        orderMatters: false,
        also: { name: 'insert_outcome', pick: null, fromSetup: 0 }
    },
    {
        id: 'insert.batch_unordered',
        note: 'ordered: false with a duplicate in the batch keeps the valid documents',
        setup: [insert(collections.idnum, [{ _id: 1 }, { _id: { $numberDouble: '1.0' } }, { _id: 3 }], false)],
        command: find(collections.idnum, {}),
        pick: firstBatch,
        orderMatters: false,
        also: { name: 'insert_outcome', pick: null, fromSetup: 0 }
    },
    {
        id: 'insert.cross_collection_independent',
        note: 'the same _id may exist in two different collections',
        setup: [
            insert(collections.idnum, [{ _id: 1, tag: 'a' }]),
            insert(collections.typeq, [{ _id: 1, tag: 'b' }])
        ],
        command: find(collections.typeq, {}),
        pick: firstBatch,
        orderMatters: false,
        also: { name: 'insert_outcome', pick: null, fromSetup: 1 }
    },
    {
        id: 'type.alias_number',
        note: '$type "number" alias covers int32/int64/double',
        setup: [
            insert(collections.typeq, [
                { _id: 1, v: 1 },
                { _id: 2, v: { $numberLong: '2' } },
                { _id: 3, v: 2.5 },
                { _id: 4, v: 's' },
                { _id: 5, v: [1, 's'] },
                { _id: 6, v: true },
                { _id: 7, v: null },
                { _id: 8 }
            ])
        ],
        command: find(collections.typeq, { v: { $type: 'number' } }),
        pick: firstBatch,
        orderMatters: false
    },
    {
        id: 'type.alias_int_and_array',
        note: '$type "int" alias and $type "array" on the array-valued document',
        setup: [
            insert(collections.typeq, [
                { _id: 1, v: 1 },
                { _id: 5, v: [1, 's'] },
                { _id: 7, v: null }
            ])
        ],
        command: find(collections.typeq, { v: { $type: 'int' } }),
        pick: firstBatch,
        orderMatters: false
    },
    {
        id: 'type.array_of_names',
        note: '$type accepts an array of type names',
        setup: [
            insert(collections.typeq, [
                { _id: 4, v: 's' },
                { _id: 5, v: [1, 's'] },
                { _id: 6, v: true },
                { _id: 7, v: null }
            ])
        ],
        command: find(collections.typeq, { v: { $type: ['string', 'bool'] } }),
        pick: firstBatch,
        orderMatters: false
    },
    {
        id: 'type.array_type_itself',
        note: '$type "array" matches the array document itself',
        setup: [insert(collections.typeq, [{ _id: 5, v: [1, 's'] }, { _id: 1, v: 1 }])],
        command: find(collections.typeq, { v: { $type: 'array' } }),
        pick: firstBatch,
        orderMatters: false
    },
    {
        id: 'type.null_alias_matches_array_null',
        note: '$type "null" matches explicit null, maybe arrays containing null',
        setup: [
            insert(collections.typeq, [
                { _id: 7, v: null },
                { _id: 9, v: [null] },
                { _id: 8 }
            ])
        ],
        command: find(collections.typeq, { v: { $type: 'null' } }),
        pick: firstBatch,
        orderMatters: false
    },
    {
        id: 'regex.array_contains',
        note: '$regex matches an array field when one element matches',
        setup: [
            insert(collections.regexq, [
                { _id: 1, tags: ['apple', 'banana'] },
                { _id: 2, tags: ['cherry'] },
                { _id: 3, tags: 'apple' },
                { _id: 4 }
            ])
        ],
        command: find(collections.regexq, { tags: { $regex: '^a' } }),
        pick: firstBatch,
        orderMatters: false
    },
    {
        id: 'regex.options_case_insensitive',
        note: '$options "i" applies to arrays and strings alike',
        setup: [
            insert(collections.regexq, [
                { _id: 1, tags: ['apple', 'banana'] },
                { _id: 2, tags: ['cherry'] },
                { _id: 3, tags: 'apple' },
                { _id: 4 }
            ])
        ],
        command: find(collections.regexq, { tags: { $regex: 'APPLE', $options: 'i' } }),
        pick: firstBatch,
        orderMatters: false
    },
    {
        id: 'not.gt_includes_missing_and_null',
        note: '$not of a comparison matches missing and null documents',
        setup: [insert(collections.notq, [{ _id: 1, v: 1 }, { _id: 2, v: 5 }, { _id: 3 }, { _id: 4, v: null }])],
        command: find(collections.notq, { v: { $not: { $gt: 5 } } }),
        pick: firstBatch,
        orderMatters: false
    },
    {
        id: 'size.matches_array_length',
        note: '$size matches only an array of exactly that length',
        setup: [insert(collections.sizeq, [{ _id: 1, tags: [1, 2] }, { _id: 2, tags: [1] }, { _id: 3, tags: 'a' }, { _id: 4 }])],
        command: find(collections.sizeq, { tags: { $size: 2 } }),
        pick: firstBatch,
        orderMatters: false
    },
    {
        id: 'in.with_null',
        note: '$in [null, 2] follows the same null semantics as {a: null}',
        setup: [insert(collections.inq, [{ _id: 1, a: 1 }, { _id: 2, a: null }, { _id: 3 }, { _id: 4, a: [null] }, { _id: 5, a: 2 }])],
        command: find(collections.inq, { a: { $in: [null, 2] } }),
        pick: firstBatch,
        orderMatters: false
    },
    {
        id: 'in.numeric_type_equality',
        note: '$in compares numbers by value across BSON numeric types',
        setup: [insert(collections.inq, [{ _id: 1, a: 1 }, { _id: 2, a: { $numberLong: '1' } }, { _id: 3, a: 1.5 }, { _id: 4, a: '1' }])],
        command: find(collections.inq, { a: { $in: [{ $numberDouble: '1.0' }] } }),
        pick: firstBatch,
        orderMatters: false
    },
    {
        id: 'nor.empty_array',
        note: '$nor: [] - does the real server accept it and match everything, or reject it?',
        setup: [insert(collections.norq, [{ _id: 1, a: 1 }, { _id: 2 }])],
        command: find(collections.norq, { a: { $nor: [] } }),
        pick: (reply) => (isZero(reply.ok) ? { code: reply.code } : { ok: true }),
        orderMatters: false,
        errorProbe: true
    },
    {
        id: 'all.with_elem_match',
        note: '$all entries may be $elemMatch expressions',
        setup: [
            insert(collections.mergeq, [
                { _id: 1, tags: [{ n: 1 }, { n: 5 }] },
                { _id: 2, tags: [{ n: 5 }, { n: 9 }] },
                { _id: 3, tags: [{ n: 1 }] }
            ])
        ],
        command: find(collections.mergeq, { tags: { $all: [{ $elemMatch: { n: { $gte: 5 } } }] } }),
        pick: firstBatch,
        orderMatters: false
    },
    {
        id: 'elem_match_with_in',
        note: '$elemMatch with $in requires one element to satisfy the $in',
        setup: [
            insert(collections.mergeq, [
                { _id: 1, tags: [{ n: 1 }, { n: 5 }] },
                { _id: 2, tags: [{ n: 5 }, { n: 9 }] },
                { _id: 3, tags: [{ n: 1 }] }
            ])
        ],
        command: find(collections.mergeq, { tags: { $elemMatch: { n: { $in: [1, 9] } } } }),
        pick: firstBatch,
        orderMatters: false
    },
    {
        id: 'range.gt_numeric_only',
        note: '$gt: 5 compares int/long/double only; the string "5" is never matched',
        setup: [
            insert(collections.rangeq, [
                { _id: 1, a: '5' },
                { _id: 2, a: 6 },
                { _id: 3, a: 5.5 },
                { _id: 4, a: { $numberLong: '6' } },
                { _id: 5, a: 5 },
                { _id: 6, a: null },
                { _id: 7 }
            ])
        ],
        command: find(collections.rangeq, { a: { $gt: 5 } }),
        pick: firstBatch,
        orderMatters: false
    },
    {
        id: 'range.gte_numeric_only',
        note: '$gte: 5 includes int/long/double boundaries but not strings',
        setup: [
            insert(collections.rangeq, [
                { _id: 1, a: '5' },
                { _id: 2, a: 6 },
                { _id: 3, a: 5.5 },
                { _id: 4, a: { $numberLong: '6' } },
                { _id: 5, a: 5 },
                { _id: 6, a: null },
                { _id: 7 }
            ])
        ],
        command: find(collections.rangeq, { a: { $gte: 5 } }),
        pick: firstBatch,
        orderMatters: false
    },
    {
        id: 'range.gt_null',
        note: '$gt: null - what does the real server match?',
        setup: [
            insert(collections.rangeq, [
                { _id: 1, a: 1 },
                { _id: 2, a: 'x' },
                { _id: 3, a: null },
                { _id: 4 },
                { _id: 5, a: false }
            ])
        ],
        command: find(collections.rangeq, { a: { $gt: null } }),
        pick: firstBatch,
        orderMatters: false
    },
    {
        id: 'range.lt_null',
        note: '$lt: null - what does the real server match?',
        setup: [
            insert(collections.rangeq, [
                { _id: 1, a: 1 },
                { _id: 2, a: 'x' },
                { _id: 3, a: null },
                { _id: 4 },
                { _id: 5, a: false }
            ])
        ],
        command: find(collections.rangeq, { a: { $lt: null } }),
        pick: firstBatch,
        orderMatters: false
    },
    {
        id: 'exists.true_on_empty_arrays',
        note: '$exists: true for [], [null], null, missing and a scalar',
        setup: [
            insert(collections.sizeq, [
                { _id: 1, a: [] },
                { _id: 2, a: [null] },
                { _id: 3, a: null },
                { _id: 4 },
                { _id: 5, a: 1 }
            ])
        ],
        command: find(collections.sizeq, { a: { $exists: true } }),
        pick: firstBatch,
        orderMatters: false
    },
    {
        id: 'size.zero_empty_array_only',
        note: '$size: 0 - empty array only, or missing fields too?',
        setup: [
            insert(collections.sizeq, [
                { _id: 1, a: [] },
                { _id: 2, a: [null] },
                { _id: 3, a: null },
                { _id: 4 },
                { _id: 5, a: [1, 2] }
            ])
        ],
        command: find(collections.sizeq, { a: { $size: 0 } }),
        pick: firstBatch,
        orderMatters: false
    },
    {
        id: 'find.sort_skip_limit',
        note: 'find applies sort, then skip, then limit',
        setup: [
            insert(collections.skipq, [
                { _id: 1, a: 7 },
                { _id: 2, a: 2 },
                { _id: 3, a: 5 },
                { _id: 4, a: 1 },
                { _id: 5, a: 4 },
                { _id: 6, a: 6 },
                { _id: 7, a: 3 }
            ])
        ],
        command: find(collections.skipq, {}, { sort: { a: 1 }, skip: 2, limit: 3 }),
        pick: firstBatch,
        orderMatters: true
    },
    {
        id: 'find.limit_then_skip_pipeline',
        note: 'contrast: a $limit stage before $skip truncates first',
        setup: [
            insert(collections.skipq, [
                { _id: 1, a: 7 },
                { _id: 2, a: 2 },
                { _id: 3, a: 5 },
                { _id: 4, a: 1 },
                { _id: 5, a: 4 },
                { _id: 6, a: 6 },
                { _id: 7, a: 3 }
            ])
        ],
        command: aggregate(collections.skipq, [{ $sort: { a: 1 } }, { $limit: 3 }, { $skip: 2 }]),
        pick: firstBatch,
        orderMatters: true
    },
    {
        id: 'find.limit_one_no_sort',
        note: 'find limit 1 without sort returns the first document in natural order',
        setup: [insert(collections.skipq, [{ _id: 1, a: 3 }, { _id: 2, a: 1 }, { _id: 3, a: 2 }])],
        command: find(collections.skipq, {}, { limit: 1 }),
        pick: firstBatch,
        orderMatters: true
    },
    {
        id: 'find.limit_one_with_sort',
        note: 'find limit 1 with a sort returns the sorted first document',
        setup: [insert(collections.skipq, [{ _id: 1, a: 3 }, { _id: 2, a: 1 }, { _id: 3, a: 2 }])],
        command: find(collections.skipq, {}, { sort: { a: -1 }, limit: 1 }),
        pick: firstBatch,
        orderMatters: true
    },
    {
        id: 'group.push_missing_field',
        note: '$push of a missing field - is null pushed or nothing?',
        setup: [
            insert(collections.groupq2, [
                { _id: 1, v: 1 },
                { _id: 2 },
                { _id: 3, v: null },
                { _id: 4, v: 2 }
            ])
        ],
        command: aggregate(collections.groupq2, [{ $group: { _id: null, pushed: { $push: '$v' } } }]),
        pick: firstBatch,
        orderMatters: false
    },
    {
        id: 'group.add_to_set_documents',
        note: '$addToSet equality for documents, arrays and numeric types',
        setup: [
            insert(collections.groupq2, [
                { _id: 1, d: { x: 1, y: 2 } },
                { _id: 2, d: { y: 2, x: 1 } },
                { _id: 3, d: [1, 2] },
                { _id: 4, d: [2, 1] },
                { _id: 5, d: 1 },
                { _id: 6, d: 1.0 },
                { _id: 7, d: 's' },
                { _id: 8 }
            ])
        ],
        command: aggregate(collections.groupq2, [{ $group: { _id: null, s: { $addToSet: '$d' } } }]),
        pick: sortedKeySet,
        orderMatters: false
    },
    {
        id: 'group.sum_ignores_non_numeric',
        note: '$sum over strings, null, missing and booleans',
        setup: [
            insert(collections.groupq2, [
                { _id: 1, v: 'x' },
                { _id: 2, v: null },
                { _id: 3 },
                { _id: 4, v: true },
                { _id: 5, v: false },
                { _id: 6, v: 2 },
                { _id: 7, v: 3.5 }
            ])
        ],
        command: aggregate(collections.groupq2, [{ $group: { _id: null, total: { $sum: '$v' } } }]),
        pick: firstBatch,
        orderMatters: false
    },
    {
        id: 'update.unset_missing',
        note: '$unset a field that does not exist - n vs nModified',
        setup: [insert(collections.updq, [{ _id: 1, a: 1 }])],
        command: update(collections.updq, [{ q: { _id: 1 }, u: { $unset: { b: '' } } }]),
        pick: (reply) => reply,
        orderMatters: false
    },
    {
        id: 'update.inc_null_field',
        note: '$inc on an explicit null - real error code',
        setup: [insert(collections.updq, [{ _id: 1, a: null }])],
        command: update(collections.updq, [{ q: { _id: 1 }, u: { $inc: { a: 1 } } }]),
        pick: writeErrorCode,
        orderMatters: false,
        errorProbe: true
    },
    {
        id: 'update.set_dotted_scalar_array',
        note: '$set a.b where a is an array of scalars - real error code',
        setup: [insert(collections.updq, [{ _id: 1, a: [1, 2] }])],
        command: update(collections.updq, [{ q: { _id: 1 }, u: { $set: { 'a.b': 1 } } }]),
        pick: writeErrorCode,
        orderMatters: false,
        errorProbe: true
    },
    {
        id: 'update.error_channel',
        note: 'modifier failures: does the reply use writeErrors or a top-level ok: 0?',
        setup: [insert(collections.updq, [{ _id: 1, a: [1, 2] }])],
        command: update(collections.updq, [{ q: { _id: 1 }, u: { $set: { 'a.b': 1 } } }]),
        pick: errorChannel,
        orderMatters: false,
        errorProbe: true
    },
    {
        id: 'update.set_dotted_document_array',
        note: '$set a.b where a is an array of documents - applied to each element?',
        setup: [insert(collections.updq, [{ _id: 1, a: [{ b: 1 }, { b: 2 }] }])],
        command: update(collections.updq, [{ q: { _id: 1 }, u: { $set: { 'a.b': 5 } } }]),
        pick: (reply) => reply,
        orderMatters: false
    },
    {
        id: 'delete.many_no_match',
        note: 'deleteMany with no match - n and deletedCount',
        setup: [insert(collections.delq, [{ _id: 1, a: 1 }, { _id: 2, a: 2 }])],
        command: remove(collections.delq, { a: 99 }, 0),
        pick: (reply) => reply,
        orderMatters: false
    },
    {
        id: 'delete.one_no_match',
        note: 'deleteOne with no match - n and deletedCount',
        setup: [insert(collections.delq, [{ _id: 1, a: 1 }, { _id: 2, a: 2 }])],
        command: remove(collections.delq, { a: 99 }, 1),
        pick: (reply) => reply,
        orderMatters: false
    },
    {
        id: 'count.null_filter',
        note: 'count with {a: null} - same null/missing semantics as find',
        setup: [
            insert(collections.countq, [{ _id: 1, a: 1 }, { _id: 2, a: null }, { _id: 3 }, { _id: 4, a: [null] }, { _id: 5, a: 2 }])
        ],
        command: count(collections.countq, { a: null }),
        pick: (reply) => reply,
        orderMatters: false
    },
    {
        id: 'count.aggregate_equivalent',
        note: 'countDocuments equivalence: $match + $count sees the same rows',
        setup: [
            insert(collections.countq, [{ _id: 1, a: 1 }, { _id: 2, a: null }, { _id: 3 }, { _id: 4, a: [null] }, { _id: 5, a: 2 }])
        ],
        command: aggregate(collections.countq, [{ $match: { a: null } }, { $count: 'n' }]),
        pick: firstBatch,
        orderMatters: false
    },
    {
        id: 'in.null_single_element',
        note: '$in: [null] equals {a: null}',
        setup: [insert(collections.inq, [{ _id: 1, a: 1 }, { _id: 2, a: null }, { _id: 3 }, { _id: 4, a: [null] }, { _id: 5, a: [] }])],
        command: find(collections.inq, { a: { $in: [null] } }),
        pick: firstBatch,
        orderMatters: false
    },
    {
        id: 'nin.with_null',
        note: '$nin: [null] excludes missing fields, complement of $in: [null]',
        setup: [insert(collections.inq, [{ _id: 1, a: 1 }, { _id: 2, a: null }, { _id: 3 }, { _id: 4, a: [null] }, { _id: 5, a: [] }])],
        command: find(collections.inq, { a: { $nin: [null] } }),
        pick: firstBatch,
        orderMatters: false
    },
    {
        id: 'nin.null_and_value',
        note: '$nin: [null, 2] vs $ne: null and $ne: 2',
        setup: [insert(collections.inq, [{ _id: 1, a: 1 }, { _id: 2, a: null }, { _id: 3 }, { _id: 4, a: [null] }, { _id: 6, a: 2 }])],
        command: find(collections.inq, { a: { $nin: [null, 2] } }),
        pick: firstBatch,
        orderMatters: false
    },
    {
        id: 'ne.null_on_same_docs',
        note: '$ne: null on the same documents as $nin: [null] - are they equivalent?',
        setup: [insert(collections.inq, [{ _id: 1, a: 1 }, { _id: 2, a: null }, { _id: 3 }, { _id: 4, a: [null] }, { _id: 5, a: [] }])],
        command: find(collections.inq, { a: { $ne: null } }),
        pick: firstBatch,
        orderMatters: false
    },
    {
        id: 'in.null_on_array_field',
        note: '$in: [null] matches an array field containing null',
        setup: [
            insert(collections.inq, [
                { _id: 1, a: [null] },
                { _id: 2, a: [1, null] },
                { _id: 3, a: [] },
                { _id: 4, a: null },
                { _id: 5 }
            ])
        ],
        command: find(collections.inq, { a: { $in: [null] } }),
        pick: firstBatch,
        orderMatters: false
    },
    {
        id: 'insert.duplicate_key_entry',
        note: 'raw _id duplicate writeErrors entry: field order, keyPattern and keyValue',
        setup: [insert(collections.idnum, [{ _id: 5, tag: 'first' }])],
        command: insert(collections.idnum, [{ _id: 5, tag: 'second' }]),
        pick: (reply) => reply,
        exactOrder: true
    },
    {
        id: 'insert.duplicate_key_entry_string',
        note: 'string _id duplicate keeps quotes in errmsg and the raw string in keyValue',
        setup: [insert(collections.idnum, [{ _id: 'x' }])],
        command: insert(collections.idnum, [{ _id: 'x' }]),
        pick: (reply) => reply,
        exactOrder: true
    },
    {
        id: 'insert.duplicate_key_entry_unordered',
        note: 'unordered batch reports one entry per duplicate with its own keyValue',
        setup: [insert(collections.idnum, [{ _id: 1 }, { _id: 2 }])],
        command: insert(collections.idnum, [{ _id: 1 }, { _id: 2, tag: 'dup' }], false),
        pick: (reply) => reply,
        exactOrder: true
    },
    {
        id: 'index.create_reply',
        note: 'createIndexes reply counters and field order for single-field plus compound keys',
        setup: [insert(collections.idxCreate, [{ _id: 1 }]), dropIndexes(collections.idxCreate, '*')],
        command: createIndexes(collections.idxCreate, [
            { key: { a: 1 }, name: 'a_1' },
            { key: { b: -1, a: 1 }, name: 'ba' }
        ]),
        pick: (reply) => reply,
        exactOrder: true
    },
    {
        id: 'index.create_idempotent_reply',
        note: 'repeating an identical specification replies with the all-exist note',
        setup: [
            insert(collections.idxIdem, [{ _id: 1 }]),
            dropIndexes(collections.idxIdem, '*'),
            createIndexes(collections.idxIdem, [
                { key: { a: 1 }, name: 'a_1' },
                { key: { b: -1, a: 1 }, name: 'ba' }
            ])
        ],
        command: createIndexes(collections.idxIdem, [
            { key: { a: 1 }, name: 'a_1' },
            { key: { b: -1, a: 1 }, name: 'ba' }
        ]),
        pick: (reply) => reply,
        exactOrder: true
    },
    {
        id: 'index.create_partial_existing_reply',
        note: 'one existing plus one new index keeps createdCollectionAutomatically and adds the short note',
        setup: [
            insert(collections.idxIdem, [{ _id: 1 }]),
            dropIndexes(collections.idxIdem, '*'),
            createIndexes(collections.idxIdem, [{ key: { a: 1 }, name: 'a_1' }])
        ],
        command: createIndexes(collections.idxIdem, [{ key: { a: 1 }, name: 'a_1' }, { key: { b: 1 }, name: 'b_1' }]),
        pick: (reply) => reply,
        exactOrder: true
    },
    {
        id: 'index.create_conflicting_name_error',
        note: 'same name with a different key is rejected with code 86 and the real message',
        setup: [
            insert(collections.idxConflict, [{ _id: 1 }]),
            dropIndexes(collections.idxConflict, '*'),
            createIndexes(collections.idxConflict, [{ key: { a: 1 }, name: 'a_1' }])
        ],
        command: createIndexes(collections.idxConflict, [{ key: { a: -1 }, name: 'a_1' }]),
        pick: indexErrorShape,
        errorProbe: true
    },
    {
        id: 'index.create_equivalent_key_error',
        note: 'the same key under a new name is rejected with code 85',
        setup: [
            insert(collections.idxEquivalent, [{ _id: 1 }]),
            dropIndexes(collections.idxEquivalent, '*'),
            createIndexes(collections.idxEquivalent, [{ key: { a: 1 }, name: 'a_1' }])
        ],
        command: createIndexes(collections.idxEquivalent, [{ key: { a: 1 }, name: 'a_second' }]),
        pick: indexErrorShape,
        errorProbe: true
    },
    {
        id: 'index.list_shape',
        note: 'listIndexes: cursor first, then _id_ and user indexes in creation order with v/key/name/unique',
        setup: [
            insert(collections.idxList, [{ _id: 1 }]),
            dropIndexes(collections.idxList, '*'),
            createIndexes(collections.idxList, [
                { key: { b: -1, a: 1 }, name: 'ba', unique: true },
                { key: { a: 1 }, name: 'a_1' }
            ])
        ],
        command: listIndexes(collections.idxList),
        pick: (reply) => reply,
        exactOrder: true
    },
    {
        id: 'index.list_missing_namespace_error',
        note: 'listIndexes on an absent namespace replies code 26',
        setup: [],
        command: listIndexes(collections.idxNever),
        pick: indexErrorShape,
        errorProbe: true
    },
    {
        id: 'index.drop_by_name_reply',
        note: 'dropIndexes by name reports nIndexesWas and ok only',
        setup: [
            insert(collections.idxDropName, [{ _id: 1 }]),
            dropIndexes(collections.idxDropName, '*'),
            createIndexes(collections.idxDropName, [
                { key: { a: 1 }, name: 'a_1' },
                { key: { b: 1 }, name: 'b_1' }
            ])
        ],
        command: dropIndexes(collections.idxDropName, 'a_1'),
        pick: (reply) => reply,
        exactOrder: true
    },
    {
        id: 'index.drop_star_reply',
        note: 'dropIndexes * reports nIndexesWas plus the non-_id message',
        setup: [
            insert(collections.idxDropStar, [{ _id: 1 }]),
            dropIndexes(collections.idxDropStar, '*'),
            createIndexes(collections.idxDropStar, [
                { key: { a: 1 }, name: 'a_1' },
                { key: { b: 1 }, name: 'b_1' }
            ])
        ],
        command: dropIndexes(collections.idxDropStar, '*'),
        pick: (reply) => reply,
        exactOrder: true
    },
    {
        id: 'index.drop_star_empty_collection',
        note: 'dropIndexes * on a collection that only has _id_ still carries the message',
        setup: [insert(collections.idxEmpty, [{ _id: 1 }]), dropIndexes(collections.idxEmpty, '*')],
        command: dropIndexes(collections.idxEmpty, '*'),
        pick: (reply) => reply,
        exactOrder: true
    },
    {
        id: 'index.drop_id_error',
        note: '_id_ cannot be dropped',
        setup: [insert(collections.idxDropId, [{ _id: 1 }])],
        command: dropIndexes(collections.idxDropId, '_id_'),
        pick: indexErrorShape,
        errorProbe: true
    },
    {
        id: 'index.drop_unknown_error',
        note: 'dropping a missing index name replies code 27',
        setup: [insert(collections.idxDropUnknown, [{ _id: 1 }])],
        command: dropIndexes(collections.idxDropUnknown, 'zzz'),
        pick: indexErrorShape,
        errorProbe: true
    },
    {
        id: 'index.insert_single_unique_duplicate',
        note: 'single-field unique index duplicate: full writeErrors entry including keyPattern and keyValue',
        setup: [
            insert(collections.idxInsertSingle, [{ _id: 1, a: 7 }]),
            dropIndexes(collections.idxInsertSingle, '*'),
            createIndexes(collections.idxInsertSingle, [{ key: { a: 1 }, name: 'a_1', unique: true }])
        ],
        command: insert(collections.idxInsertSingle, [{ _id: 2, a: 7 }]),
        pick: (reply) => reply.writeErrors,
        exactOrder: true
    },
    {
        id: 'index.insert_compound_unique_duplicate',
        note: 'compound unique duplicate renders key fields in key order, not value order',
        setup: [
            insert(collections.idxInsertCompound, [
                { _id: 1, a: 1, b: 1 },
                { _id: 2, a: 1, b: 2 }
            ]),
            dropIndexes(collections.idxInsertCompound, '*'),
            createIndexes(collections.idxInsertCompound, [{ key: { b: -1, a: 1 }, name: 'ba', unique: true }])
        ],
        command: insert(collections.idxInsertCompound, [{ _id: 3, a: 1, b: 1 }]),
        pick: (reply) => reply.writeErrors,
        exactOrder: true
    },
    {
        id: 'index.insert_unordered_continues_past_duplicate',
        note: 'unordered insert continues after a unique-index duplicate and reports the accepted count',
        setup: [
            insert(collections.idxInsertUnordered, [{ _id: 1, a: 7 }]),
            dropIndexes(collections.idxInsertUnordered, '*'),
            createIndexes(collections.idxInsertUnordered, [{ key: { a: 1 }, name: 'a_1', unique: true }])
        ],
        command: insert(collections.idxInsertUnordered, [{ _id: 2, a: 7 }, { _id: 3, a: 9 }], false),
        pick: (reply) => reply,
        exactOrder: true
    },
    {
        id: 'index.update_single_unique_duplicate',
        note: 'update replies n, writeErrors, nModified, ok; keyValue matches the colliding document',
        setup: [
            insert(collections.idxUpdateSingle, [{ _id: 1, a: 7 }, { _id: 2, a: 8 }]),
            dropIndexes(collections.idxUpdateSingle, '*'),
            createIndexes(collections.idxUpdateSingle, [{ key: { a: 1 }, name: 'a_1', unique: true }])
        ],
        command: update(collections.idxUpdateSingle, [{ q: { _id: 2 }, u: { $set: { a: 7 } } }]),
        pick: (reply) => reply,
        exactOrder: true
    },
    {
        id: 'index.update_compound_unique_duplicate',
        note: 'compound unique update duplicate keeps keyPattern order',
        setup: [
            insert(collections.idxUpdateCompound, [
                { _id: 1, a: 1, b: 1 },
                { _id: 2, a: 1, b: 2 }
            ]),
            dropIndexes(collections.idxUpdateCompound, '*'),
            createIndexes(collections.idxUpdateCompound, [{ key: { b: -1, a: 1 }, name: 'ba', unique: true }])
        ],
        command: update(collections.idxUpdateCompound, [{ q: { _id: 2 }, u: { $set: { b: 1 } } }]),
        pick: (reply) => reply,
        exactOrder: true
    },
    {
        id: 'index.create_missing_name_error',
        note: 'the name field is required by mongod 8.0.9, so no default name is invented',
        setup: [],
        command: createIndexes(collections.idxNameless, [{ key: { a: 1 } }]),
        pick: indexErrorShape,
        errorProbe: true
    },
    {
        id: 'index.create_missing_key_error',
        note: 'the key field is required',
        setup: [],
        command: createIndexes(collections.idxKeyless, [{ name: 'x' }]),
        pick: indexErrorShape,
        errorProbe: true
    },
    {
        id: 'index.create_empty_indexes_error',
        note: 'an empty indexes array is a BadValue',
        setup: [],
        command: createIndexes(collections.idxEmpty, []),
        pick: indexErrorShape,
        errorProbe: true
    },
    {
        id: 'index.create_empty_key_codename',
        note: 'an empty key document is CannotCreateIndex and the reply carries codeName',
        setup: [],
        command: createIndexes(collections.idxKeyless, [{ key: {}, name: 'x' }]),
        pick: indexErrorShape,
        errorProbe: true
    },
    {
        id: 'index.create_missing_indexes_codename',
        note: 'a missing indexes field is IDLFailedToParse with codeName',
        setup: [],
        command: { createIndexes: collections.idxNameless, $db: DB },
        pick: indexErrorShape,
        errorProbe: true
    },
    {
        id: 'index.unique_build_duplicate_error',
        note: 'unique index build over duplicates: UUID template plus keyPattern and keyValue',
        setup: [insert(collections.idxBuildDup, [{ _id: 1, a: 7 }, { _id: 2, a: 7 }])],
        command: createIndexes(collections.idxBuildDup, [{ key: { a: 1 }, name: 'a_1', unique: true }]),
        pick: (reply) => ({
            code: reply.code,
            codeName: reply.codeName,
            errmsg: maskUuid(reply.errmsg),
            keyPattern: reply.keyPattern,
            keyValue: reply.keyValue
        }),
        errorProbe: true
    },
    {
        id: 'index.drop_by_key_pattern_reply',
        note: 'a key pattern drops the index by matching its definition, not its name',
        setup: [
            insert(collections.idxDropPattern, [{ _id: 1 }]),
            dropIndexes(collections.idxDropPattern, '*'),
            createIndexes(collections.idxDropPattern, [
                { key: { a: 1 }, name: 'a_1' },
                { key: { b: 1 }, name: 'b_1' }
            ])
        ],
        command: dropIndexes(collections.idxDropPattern, { a: 1 }),
        pick: (reply) => reply,
        exactOrder: true
    },
    {
        id: 'index.drop_by_key_pattern_compound_reply',
        note: 'a compound key pattern matches when the field order is identical',
        setup: [
            insert(collections.idxDropPattern, [{ _id: 1 }]),
            dropIndexes(collections.idxDropPattern, '*'),
            createIndexes(collections.idxDropPattern, [
                { key: { b: -1, c: 1 }, name: 'bc' },
                { key: { a: 1 }, name: 'a_1' }
            ])
        ],
        command: dropIndexes(collections.idxDropPattern, { b: -1, c: 1 }),
        pick: (reply) => reply,
        exactOrder: true
    },
    {
        id: 'index.drop_by_key_pattern_reversed_error',
        note: 'a reordered compound key pattern does not match and reports IndexNotFound',
        setup: [
            insert(collections.idxDropPattern, [{ _id: 1 }]),
            dropIndexes(collections.idxDropPattern, '*'),
            createIndexes(collections.idxDropPattern, [{ key: { b: -1, c: 1 }, name: 'bc' }])
        ],
        command: dropIndexes(collections.idxDropPattern, { c: 1, b: -1 }),
        pick: indexErrorShape,
        errorProbe: true
    },
    {
        id: 'index.drop_by_key_pattern_numeric_equivalent',
        note: 'a double key value matches the integer index key { a: 1 }',
        setup: [
            insert(collections.idxDropPattern, [{ _id: 1 }]),
            dropIndexes(collections.idxDropPattern, '*'),
            createIndexes(collections.idxDropPattern, [{ key: { a: 1 }, name: 'a_1' }])
        ],
        command: dropIndexes(collections.idxDropPattern, { a: { $numberDouble: '1.0' } }),
        pick: (reply) => reply,
        exactOrder: true
    },
    {
        id: 'index.drop_by_key_pattern_id_error',
        note: 'a key pattern naming _id_ is rejected exactly like the name form',
        setup: [insert(collections.idxDropPattern, [{ _id: 1 }])],
        command: dropIndexes(collections.idxDropPattern, { _id: 1 }),
        pick: indexErrorShape,
        errorProbe: true
    },
    {
        id: 'index.drop_wrong_type_error',
        note: 'a numeric index field is TypeMismatch with the real expected-types wording',
        setup: [insert(collections.idxDropPattern, [{ _id: 1 }])],
        command: dropIndexes(collections.idxDropPattern, 5),
        pick: indexErrorShape,
        errorProbe: true
    },
    {
        id: 'index.multikey.duplicate_across_documents',
        note: 'a unique index expands array elements, so {a: [1, 2]} collides with {a: 2}',
        setup: [
            insert(collections.multiKey, [{ _id: 1, a: [1, 2] }]),
            dropIndexes(collections.multiKey, '*'),
            createIndexes(collections.multiKey, [{ key: { a: 1 }, name: 'a_1', unique: true }])
        ],
        command: insert(collections.multiKey, [{ _id: 2, a: 2 }]),
        pick: (reply) => reply.writeErrors,
        exactOrder: true
    },
    {
        id: 'index.multikey.duplicate_element_within_document',
        note: 'repeated elements in one document do not collide, but a later document with that element does',
        setup: [
            insert(collections.multiKey, [{ _id: 1, a: [3, 3] }]),
            dropIndexes(collections.multiKey, '*'),
            createIndexes(collections.multiKey, [{ key: { a: 1 }, name: 'a_1', unique: true }])
        ],
        command: insert(collections.multiKey, [{ _id: 2, a: 3 }]),
        pick: (reply) => reply.writeErrors,
        exactOrder: true,
        also: { name: 'first_insert_outcome', pick: null, fromSetup: 0 }
    },
    {
        id: 'index.multikey.empty_array_undefined',
        note: 'an empty array is indexed as BSON undefined, so two {a: []} documents collide',
        setup: [
            insert(collections.multiKey, [{ _id: 1, a: [] }]),
            dropIndexes(collections.multiKey, '*'),
            createIndexes(collections.multiKey, [{ key: { a: 1 }, name: 'a_1', unique: true }])
        ],
        command: insert(collections.multiKey, [{ _id: 2, a: [] }]),
        pick: (reply) => reply.writeErrors,
        exactOrder: true
    },
    {
        id: 'index.multikey.null_element',
        note: '{a: [null]} and {a: null} share the null index key',
        setup: [
            insert(collections.multiKey, [{ _id: 1, a: null }]),
            dropIndexes(collections.multiKey, '*'),
            createIndexes(collections.multiKey, [{ key: { a: 1 }, name: 'a_1', unique: true }])
        ],
        command: insert(collections.multiKey, [{ _id: 2, a: [null] }]),
        pick: (reply) => reply.writeErrors,
        exactOrder: true
    },
    {
        id: 'index.multikey.nested_object_element',
        note: 'a document element is indexed as a whole, so {a: [ {b: 1} ]} collides with {a: {b: 1}}',
        setup: [
            insert(collections.multiKey, [{ _id: 1, a: { b: 1 } }]),
            dropIndexes(collections.multiKey, '*'),
            createIndexes(collections.multiKey, [{ key: { a: 1 }, name: 'a_1', unique: true }])
        ],
        command: insert(collections.multiKey, [{ _id: 2, a: [{ b: 1 }] }]),
        pick: (reply) => reply.writeErrors,
        exactOrder: true
    },
    {
        id: 'index.multikey.nested_array_not_expanded',
        note: 'only one level expands, so {a: [[1, 2]]} does not collide with {a: [1, 2]}',
        setup: [
            insert(collections.multiNested, [{ _id: 1, a: [[1, 2]] }]),
            dropIndexes(collections.multiNested, '*'),
            createIndexes(collections.multiNested, [{ key: { a: 1 }, name: 'a_1', unique: true }])
        ],
        command: insert(collections.multiNested, [{ _id: 2, a: [1, 2] }]),
        pick: insertOutcome,
        exactOrder: true
    },
    {
        id: 'index.multikey.nested_array_duplicate',
        note: 'the nested array itself is the key, so two {a: [[1, 2]]} documents collide',
        setup: [
            insert(collections.multiNested, [{ _id: 1, a: [[1, 2]] }]),
            dropIndexes(collections.multiNested, '*'),
            createIndexes(collections.multiNested, [{ key: { a: 1 }, name: 'a_1', unique: true }])
        ],
        command: insert(collections.multiNested, [{ _id: 2, a: [[1, 2]] }]),
        pick: (reply) => reply.writeErrors,
        exactOrder: true
    },
    {
        id: 'index.multikey.empty_nested_array_duplicate',
        note: 'a nested empty array keys on [] rather than undefined',
        setup: [
            insert(collections.multiNested, [{ _id: 1, a: [[]] }]),
            dropIndexes(collections.multiNested, '*'),
            createIndexes(collections.multiNested, [{ key: { a: 1 }, name: 'a_1', unique: true }])
        ],
        command: insert(collections.multiNested, [{ _id: 2, a: [[]] }]),
        pick: (reply) => reply.writeErrors,
        exactOrder: true
    },
    {
        id: 'index.multikey.compound_missing_field_null',
        note: 'the compound key of an expanded array pairs each element with null for a missing field',
        setup: [
            insert(collections.multiCompound, [{ _id: 1, a: [1, 2] }]),
            dropIndexes(collections.multiCompound, '*'),
            createIndexes(collections.multiCompound, [{ key: { a: 1, b: 1 }, name: 'ab', unique: true }])
        ],
        command: insert(collections.multiCompound, [{ _id: 2, a: 1 }]),
        pick: (reply) => reply.writeErrors,
        exactOrder: true
    },
    {
        id: 'index.multikey.compound_empty_array',
        note: 'a compound key over an empty array renders both fields, the first as undefined',
        setup: [
            insert(collections.multiCompound, [{ _id: 1, a: [], b: 1 }]),
            dropIndexes(collections.multiCompound, '*'),
            createIndexes(collections.multiCompound, [{ key: { a: 1, b: 1 }, name: 'ab', unique: true }])
        ],
        command: insert(collections.multiCompound, [{ _id: 2, a: [], b: 1 }]),
        pick: (reply) => reply.writeErrors,
        exactOrder: true
    },
    {
        id: 'index.multikey.parallel_arrays_insert',
        note: 'two array fields under one compound index are rejected with code 171, later field first',
        setup: [
            insert(collections.multiParallel, [{ _id: 1, a: 1 }]),
            dropIndexes(collections.multiParallel, '*'),
            createIndexes(collections.multiParallel, [{ key: { a: 1, b: 1 }, name: 'ab' }])
        ],
        command: insert(collections.multiParallel, [{ _id: 2, a: [1], b: [2] }]),
        pick: (reply) => reply.writeErrors,
        exactOrder: true
    },
    {
        id: 'index.multikey.parallel_arrays_reversed_key',
        note: 'the parallel-array message lists the key order reversed: {b: 1, a: 1} reports [a] [b]',
        setup: [
            insert(collections.multiParallel, [{ _id: 1, a: 1 }]),
            dropIndexes(collections.multiParallel, '*'),
            createIndexes(collections.multiParallel, [{ key: { b: 1, a: 1 }, name: 'ba' }])
        ],
        command: insert(collections.multiParallel, [{ _id: 2, a: [1], b: [2] }]),
        pick: (reply) => reply.writeErrors,
        exactOrder: true
    },
    {
        id: 'index.multikey.parallel_arrays_empty',
        note: 'an empty array still counts as a parallel array',
        setup: [
            insert(collections.multiParallel, [{ _id: 1, a: 1 }]),
            dropIndexes(collections.multiParallel, '*'),
            createIndexes(collections.multiParallel, [{ key: { a: 1, b: 1 }, name: 'ab' }])
        ],
        command: insert(collections.multiParallel, [{ _id: 2, a: [], b: [2] }]),
        pick: (reply) => reply.writeErrors,
        exactOrder: true
    },
    {
        id: 'index.multikey.parallel_arrays_update',
        note: 'an update that produces two array fields answers n: 0 with writeErrors and nModified: 0',
        setup: [
            insert(collections.multiParallel, [{ _id: 1, a: 1, b: 2 }]),
            dropIndexes(collections.multiParallel, '*'),
            createIndexes(collections.multiParallel, [{ key: { a: 1, b: 1 }, name: 'ab' }])
        ],
        command: update(collections.multiParallel, [{ q: { _id: 1 }, u: { $set: { a: [1], b: [2] } } }]),
        pick: (reply) => reply,
        exactOrder: true
    },
    {
        id: 'index.multikey.build_duplicate',
        note: 'building a unique multikey index over an array element that collides keeps the UUID template',
        setup: [insert(collections.multiBuild, [{ _id: 1, a: [8, 9] }, { _id: 2, a: 8 }])],
        command: createIndexes(collections.multiBuild, [{ key: { a: 1 }, name: 'a_1', unique: true }]),
        pick: (reply) => ({
            code: reply.code,
            codeName: reply.codeName,
            errmsg: maskUuid(reply.errmsg),
            keyPattern: reply.keyPattern,
            keyValue: reply.keyValue
        }),
        errorProbe: true
    },
    {
        id: 'index.multikey.build_empty_array_duplicate',
        note: 'building over two empty arrays collides on the undefined index key',
        setup: [insert(collections.multiBuild, [{ _id: 1, a: [] }, { _id: 2, a: [] }])],
        command: createIndexes(collections.multiBuild, [{ key: { a: 1 }, name: 'a_1', unique: true }]),
        pick: (reply) => ({
            code: reply.code,
            codeName: reply.codeName,
            errmsg: maskUuid(reply.errmsg),
            keyPattern: reply.keyPattern,
            keyValue: reply.keyValue
        }),
        errorProbe: true
    },
    {
        id: 'index.multikey.list_shape',
        note: 'listIndexes over an array-valued path is byte-for-byte the real reply, which carries no multikey field',
        setup: [
            insert(collections.multiList, [{ _id: 1, a: [1, 2] }, { _id: 2, a: 3 }]),
            dropIndexes(collections.multiList, '*'),
            createIndexes(collections.multiList, [{ key: { a: 1, b: 1 }, name: 'ab' }])
        ],
        command: listIndexes(collections.multiList),
        pick: (reply) => reply,
        exactOrder: true
    },
    {
        id: 'lookup.equality_form',
        note: 'array local field unions matches in storage order, missing/null matches null and absent, objects match, as replaces an existing field in place',
        setup: [
            insert(collections.lookupForeign, [
                { _id: 'f1', b: 1 },
                { _id: 'f2', b: 2 },
                { _id: 'f3', b: [2, 3] },
                { _id: 'f4', b: null },
                { _id: 'f5', tag: 'missing-b' },
                { _id: 'f6', b: { x: 1 } },
                { _id: 'f7', b: [null, 5] }
            ]),
            insert(collections.lookupLocal, [
                { _id: 1, a: [2, 2] },
                { _id: 2, a: null },
                { _id: 3, tag: 'missing-a' },
                { _id: 4, a: { x: 1 } },
                { _id: 5, a: 1, join: 'overwritten' },
                { _id: 6, a: 99 },
                { _id: 7, a: [] }
            ])
        ],
        command: aggregate(collections.lookupLocal, [
            {
                $lookup: {
                    from: collections.lookupForeign,
                    localField: 'a',
                    foreignField: 'b',
                    as: 'join'
                }
            }
        ]),
        pick: firstBatch,
        orderMatters: true,
        exactOrder: true
    },
    {
        id: 'lookup.nonexistent_from',
        note: 'a from collection that does not exist yields an empty array instead of an error',
        setup: [insert(collections.lookupLocal, [{ _id: 1, a: 1 }, { _id: 2, a: 2 }])],
        command: aggregate(collections.lookupLocal, [
            {
                $lookup: {
                    from: collections.lookupNone,
                    localField: 'a',
                    foreignField: 'b',
                    as: 'join'
                }
            }
        ]),
        pick: firstBatch,
        orderMatters: true,
        exactOrder: true
    },
    {
        id: 'lookup.missing_from_error',
        note: 'from is required unless a pipeline is given',
        setup: [],
        command: aggregate(collections.lookupLocal, [
            { $lookup: { localField: 'a', foreignField: 'b', as: 'join' } }
        ]),
        pick: stageErrorShape,
        errorProbe: true
    },
    {
        id: 'lookup.missing_as_error',
        note: 'as is required for the equality form',
        setup: [],
        command: aggregate(collections.lookupLocal, [
            { $lookup: { from: collections.lookupForeign, localField: 'a', foreignField: 'b' } }
        ]),
        pick: stageErrorShape,
        errorProbe: true
    },
    {
        id: 'lookup.non_string_local_field_error',
        note: 'a numeric localField is rejected with the exact type wording',
        setup: [],
        command: aggregate(collections.lookupLocal, [
            { $lookup: { from: collections.lookupForeign, localField: 1, foreignField: 'b', as: 'join' } }
        ]),
        pick: stageErrorShape,
        errorProbe: true
    },
    {
        id: 'lookup.non_string_from_error',
        note: 'a numeric from is rejected with the exact type wording',
        setup: [],
        command: aggregate(collections.lookupLocal, [
            { $lookup: { from: 1, localField: 'a', foreignField: 'b', as: 'join' } }
        ]),
        pick: stageErrorShape,
        errorProbe: true
    },
    {
        id: 'lookup.non_string_as_error',
        note: 'a numeric as is rejected with the exact type wording',
        setup: [],
        command: aggregate(collections.lookupLocal, [
            { $lookup: { from: collections.lookupForeign, localField: 'a', foreignField: 'b', as: 1 } }
        ]),
        pick: stageErrorShape,
        errorProbe: true
    },
    {
        id: 'lookup.missing_foreign_field_error',
        note: 'localField without foreignField requires a pipeline',
        setup: [],
        command: aggregate(collections.lookupLocal, [
            { $lookup: { from: collections.lookupForeign, localField: 'a', as: 'join' } }
        ]),
        pick: stageErrorShape,
        errorProbe: true
    },
    {
        id: 'sortByCount.field',
        note: 'the whole field value is the group key, missing and null share one null group, counts are Int32 and descending',
        setup: [insert(collections.sortByCount, sortByCountDocuments)],
        command: aggregate(collections.sortByCount, [{ $sortByCount: '$x' }]),
        pick: firstBatch,
        orderMatters: true,
        exactOrder: true
    },
    {
        id: 'sortByCount.empty_collection',
        note: 'an empty input returns an empty batch',
        setup: [],
        command: aggregate(collections.sortByCount, [{ $sortByCount: '$x' }]),
        pick: firstBatch,
        orderMatters: true
    },
    {
        id: 'sortByCount.literal_string_error',
        note: 'a field name without the $ prefix is Location40148',
        setup: [],
        command: aggregate(collections.sortByCount, [{ $sortByCount: 'x' }]),
        pick: stageErrorShape,
        errorProbe: true
    },
    {
        id: 'sortByCount.literal_number_error',
        note: 'a numeric argument is Location40149',
        setup: [],
        command: aggregate(collections.sortByCount, [{ $sortByCount: 1 }]),
        pick: stageErrorShape,
        errorProbe: true
    },
    {
        id: 'unwind.nested_path',
        note: '$unwind on a dotted path expands the inner array and keeps scalars',
        setup: [
            insert(collections.unwind, [
                { _id: 1, a: { b: [1, 2] } },
                { _id: 2, a: { b: [] } },
                { _id: 3, a: { b: 5 } },
                { _id: 4, a: { c: 1 } },
                { _id: 5, a: { b: null } }
            ])
        ],
        command: aggregate(collections.unwind, [{ $unwind: '$a.b' }]),
        pick: firstBatch,
        orderMatters: true,
        exactOrder: true
    },
    {
        id: 'unwind.positional_path',
        note: 'a positional path resolves no values, so the batch is empty',
        setup: [
            insert(collections.unwind, [
                { _id: 1, a: [1, 2] },
                { _id: 2, a: [] },
                { _id: 3, a: 5 }
            ])
        ],
        command: aggregate(collections.unwind, [{ $unwind: '$a.0' }]),
        pick: firstBatch,
        orderMatters: true
    },
    {
        id: 'unwind.empty_collection',
        note: 'an empty input returns an empty batch',
        setup: [],
        command: aggregate(collections.unwind, [{ $unwind: '$a' }]),
        pick: firstBatch,
        orderMatters: true
    }
]

async function runProbe(probe) {
    const resets = Object.values(collections).map((collection) => ({
        delete: collection,
        deletes: [{ q: {}, limit: 0 }],
        $db: DB
    }))
    const oracleReplies = []
    for (const command of [...resets, ...probe.setup]) oracleReplies.push(await oracleCommand(command))
    const oracleReply = await oracleCommand(probe.command)

    const localReplies = []
    for (const command of [...resets, ...probe.setup]) localReplies.push(localCommand(command))
    const localReply = localCommand(probe.command)

    const resetCount = resets.length
    const oracleSetup = oracleReplies.slice(resetCount)
    const localSetup = localReplies.slice(resetCount)

    const format = (value) => (probe.orderMatters ? value : Array.isArray(value) ? [...value].sort((a, b) => stable(a).localeCompare(stable(b))) : value)
    const oracle = format(probe.pick(oracleReply))
    const local = format(probe.pick(localReply))
    // `stable` sorts keys, so probes that also assert field order compare raw JSON.
    const match = probe.exactOrder ? JSON.stringify(oracle) === JSON.stringify(local) : stable(oracle) === stable(local)

    const record = {
        id: probe.id,
        note: probe.note,
        match,
        oracle,
        local,
        oracleRaw: probe.errorProbe ? oracleReply : undefined,
        localRaw: probe.errorProbe ? localReply : undefined
    }
    if (probe.also) {
        record.also = {
            name: probe.also.name,
            oracle: probe.also.pick ? probe.also.pick(oracleSetup[probe.also.fromSetup]) : insertOutcome(oracleSetup[probe.also.fromSetup]),
            local: probe.also.pick ? probe.also.pick(localSetup[probe.also.fromSetup]) : insertOutcome(localSetup[probe.also.fromSetup]),
            oracleRaw: oracleSetup[probe.also.fromSetup],
            localRaw: localSetup[probe.also.fromSetup]
        }
    }
    return record
}

const records = []
for (const probe of probes) records.push(await runProbe(probe))
rmSync(directory, { recursive: true, force: true })

mkdirSync(dirname(RESULT_PATH), { recursive: true })
writeFileSync(
    RESULT_PATH,
    `${JSON.stringify({ host: HOST, port: PORT, database: DB, probes: records }, null, 2)}\n`
)

const mismatches = records.filter((record) => !record.match)
console.log(`oracle: ${records.length - mismatches.length}/${records.length} probes match mongod ${HOST}:${PORT}`)
for (const record of records) {
    const verdict = record.match ? 'MATCH   ' : 'MISMATCH'
    console.log(`${verdict} ${record.id}`)
    if (!record.match || record.also) {
        console.log(`  oracle ${stable(record.oracle)}`)
        console.log(`  local  ${stable(record.local)}`)
        if (record.also) {
            console.log(`  also oracle ${stable(record.also.oracle)} / local ${stable(record.also.local)}`)
        }
    }
}
console.log(`results -> ${RESULT_PATH}`)
process.exitCode = mismatches.length === 0 ? 0 : 1
