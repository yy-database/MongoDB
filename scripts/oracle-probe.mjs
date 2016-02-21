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
const platform = `mongo-${process.platform}-${process.arch}`
const binding = require(join(repo, 'projects', 'mongo.ts', 'platforms', platform, 'index.js'))

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

function isZero(value) {
    if (value === 0) return true
    if (!value || typeof value !== 'object') return false
    return value.$numberInt === '0' || value.$numberDouble === '0' || value.$numberDouble === '0.0'
}

function errorShape(reply) {
    if (reply && isZero(reply.ok)) return { code: reply.code, errmsg: reply.errmsg }
    return { code: null, errmsg: null }
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
const find = (collection, filter) => ({ find: collection, filter, $db: DB })

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
    mergeq: 'oracle_mergeq'
}

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
    const match = stable(oracle) === stable(local)

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
