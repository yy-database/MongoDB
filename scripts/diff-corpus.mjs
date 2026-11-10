// Fixed-seed differential corpus for the MongoDB wire surface.
//
// The corpus is generated locally from one seed, executed twice — once through
// this repo's napi binding and once against a real `mongod 8.0.9` started by the
// operator — and the two replies are compared. Expectations never come from this
// implementation: matched entries are promoted into gate cases with the replies
// read from the real server, and stable mismatches are pinned as known-difference
// cases with the real reply quoted in their `source`.
//
// Usage:
//   node scripts/diff-corpus.mjs [--host 127.0.0.1] [--port 28017] [--seed 20261106]
//                                [--count 285] [--only <entry-id>]
//                                [--write] [--emit-cases] [--verify] [--check]
//
// `--check` is the regression gate: it verifies the fixed seed, count and corpus
// digest against the committed baseline before starting any engine, then runs
// every entry. An observed difference the baseline does not explain fails, a
// difference whose signal changed fails, and a baseline entry that no longer
// differs fails as stale. Regenerate with `--write --emit-cases`.
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import net from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')
const require = createRequire(import.meta.url)
const short = `${process.platform}-${process.arch}`
const binding = require(join(repo, 'projects', 'mongo.ts', 'platforms', `mongo-${short}`))


const args = process.argv.slice(2)
const option = (name, fallback) => {
    const index = args.indexOf(`--${name}`)
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
const HOST = option('host', '127.0.0.1')
const PORT = Number(option('port', '28017'))
const SEED = Number(option('seed', '20261106'))
const COUNT = Number(option('count', '317'))
const ONLY = option('only', null)
const VERIFY = args.includes('--verify')
const CHECK = args.includes('--check')
const WRITE = args.includes('--write')
const EMIT = args.includes('--emit-cases')
const DB = 'diff'

const CORPUS_PATH = resolve(repo, 'tests', 'diff', 'corpus.json')
const BASELINE_PATH = resolve(repo, 'tests', 'diff', 'baseline.json')
const CASE_PATH = resolve(repo, 'tests', 'cases', 'diff.json')
const KNOWN_CASE_PATH = resolve(repo, 'tests', 'cases', 'diff-known.json')
const REPORT_PATH = resolve(repo, '.tmp', 'diff-report.json')

// --- BSON writer (commands only) -------------------------------------------
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
        if (value.$date !== undefined) {
            const milliseconds = typeof value.$date === 'object' ? BigInt(value.$date.$numberLong) : BigInt(value.$date)
            const bytes = Buffer.alloc(8)
            bytes.writeBigInt64LE(milliseconds)
            return [0x09, bytes]
        }
        if (value.$timestamp !== undefined) {
            // On the wire the increment comes first, the seconds second.
            const bytes = Buffer.alloc(8)
            bytes.writeUInt32LE(Number(value.$timestamp.i), 0)
            bytes.writeUInt32LE(Number(value.$timestamp.t), 4)
            return [0x11, bytes]
        }
        if (value.$minKey !== undefined) return [0xff, Buffer.alloc(0)]
        if (value.$maxKey !== undefined) return [0x7f, Buffer.alloc(0)]
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

// --- local execution --------------------------------------------------------
function localCommand(store, cursors, command) {
    const name = Object.keys(command)[0]
    const text = JSON.stringify(command)
    switch (name) {
        case 'insert':
            return JSON.parse(binding.insert(store, text))
        case 'find':
            return JSON.parse(binding.find(store, cursors, text))
        case 'aggregate':
            return JSON.parse(binding.aggregate(store, text))
        case 'delete':
            return JSON.parse(binding.delete(store, text))
        case 'update':
            return JSON.parse(binding.update(store, text))
        case 'createIndexes':
            return JSON.parse(binding.createIndexes(store, text))
        case 'listIndexes':
            return JSON.parse(binding.listIndexes(store, text))
        case 'dropIndexes':
            return JSON.parse(binding.dropIndexes(store, text))
        case 'getMore':
            return JSON.parse(binding.getMore(cursors, text))
        case 'killCursors':
            return JSON.parse(binding.killCursors(cursors, text))
        case 'findAndModify':
            return JSON.parse(binding.findAndModify(store, text))
        case 'distinct':
            return JSON.parse(binding.distinct(store, text))
        case 'bulkWrite':
            return JSON.parse(binding.bulkWrite(store, text))
        case 'count':
            return JSON.parse(binding.count(store, text))
        case 'explain':
            return JSON.parse(binding.explain(store, text))
        case 'create':
            return JSON.parse(binding.create(store, text))
        case 'collMod':
            return JSON.parse(binding.collMod(store, text))
        case 'listCollections':
            return JSON.parse(binding.listCollections(store, text))
        default:
            throw new Error(`unsupported local command ${name}`)
    }
}

// --- comparison helpers -----------------------------------------------------
function stable(value) {
    if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
    if (value && typeof value === 'object') {
        const keys = Object.keys(value).sort()
        return `{${keys.map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
    }
    return JSON.stringify(value)
}

function digest(value) {
    return createHash('sha256').update(stable(value)).digest('hex')
}

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

function zeroId(value) {
    if (value === 0) return true
    if (!value || typeof value !== 'object') return false
    return value.$numberInt === '0' || value.$numberLong === '0' || value.$numberDouble === '0' || value.$numberDouble === '0.0'
}

function numericId(value) {
    if (!value || typeof value !== 'object') return false
    return value.$numberInt !== undefined || value.$numberLong !== undefined || value.$numberDouble !== undefined
}

// Masks server-assigned identifiers (cursor ids, build UUIDs, generated ObjectIds)
// so the reply template is compared instead of the values. Any mask means the
// entry cannot become a gate case whose expectation is a literal reply.
const CURSOR_FIELDS = new Set(['cursorsKilled', 'cursorsNotFound', 'cursorsAlive', 'cursorsUnknown'])

// Planner hashes are minted by `mongod` from internal plan state, so the gateway
// derives its own deterministic stand-ins and the corpus compares structure only.
const EXPLAIN_HASH_FIELDS = new Set(['queryHash', 'planCacheShapeHash', 'planCacheKey', 'queryShapeHash'])

// Wall-clock measurements move between runs even on the same oracle, so they
// are compared structurally and never used as gate material.
const EXPLAIN_TIMING_FIELDS = new Set(['executionTimeMillis', 'executionTimeMillisEstimate', 'optimizationTimeMillis'])

function normalizeReply(reply) {
    const flags = { cursor: false, uuid: false, oid: false, hash: false, serverInfo: false, timing: false }
    function walk(node, parentKey) {
        if (CURSOR_FIELDS.has(parentKey) && numericId(node)) {
            flags.cursor = true
            return '<cursor>'
        }
        if (Array.isArray(node)) return node.map((item) => walk(item, parentKey))
        if (node && typeof node === 'object') {
            const out = {}
            for (const [key, value] of Object.entries(node)) {
                if (parentKey === 'cursor' && key === 'id' && !zeroId(value) && numericId(value)) {
                    flags.cursor = true
                    out[key] = '<cursor>'
                    continue
                }
                if (key === '$oid') {
                    flags.oid = true
                    out[key] = '<oid>'
                    continue
                }
                // `listCollections` reports a server-assigned collection UUID.
                if (key === 'uuid' && value && typeof value === 'object' && value.$binary) {
                    flags.uuid = true
                    out[key] = '<uuid>'
                    continue
                }
                if (EXPLAIN_HASH_FIELDS.has(key) && typeof value === 'string') {
                    flags.hash = true
                    out[key] = '<hash>'
                    continue
                }
                if (EXPLAIN_TIMING_FIELDS.has(key) && typeof value === 'object' && value !== null && '$numberInt' in value) {
                    flags.timing = true
                    out[key] = '<millis>'
                    continue
                }
                // `serverInfo` describes where the oracle happens to listen.
                if (parentKey === 'serverInfo' && (key === 'host' || key === 'port')) {
                    flags.serverInfo = true
                    out[key] = key === 'host' ? '<host>' : '<port>'
                    continue
                }
                out[key] = walk(value, key)
            }
            return out
        }
        if (CURSOR_FIELDS.has(parentKey) && numericId(node)) {
            flags.cursor = true
            return '<cursor>'
        }
        if (typeof node === 'string') {
            let replaced = node.replace(UUID_PATTERN, '<uuid>')
            if (replaced !== node) flags.uuid = true
            const withCursor = replaced.replace(/cursor id \d+ not found/, 'cursor id <cursor> not found')
            if (withCursor !== replaced) flags.cursor = true
            return withCursor
        }
        return node
    }
    return { value: walk(reply, null), flags }
}

function numeric(value) {
    if (!value || typeof value !== 'object') return value
    if (value.$numberInt !== undefined) return Number(value.$numberInt)
    if (value.$numberLong !== undefined) return Number(value.$numberLong)
    if (value.$numberDouble !== undefined) return Number(value.$numberDouble)
    return value
}

function semantic(value) {
    if (Array.isArray(value)) return value.map(semantic)
    if (value && typeof value === 'object') {
        const out = {}
        for (const [key, item] of Object.entries(value)) {
            out[key] = key === 'ok' ? numeric(item) : semantic(item)
        }
        return out
    }
    return value
}

function okEncoding(reply) {
    const ok = reply?.ok
    if (!ok || typeof ok !== 'object') return ok === undefined ? 'none' : typeof ok
    if (ok.$numberInt !== undefined) return 'int32'
    if (ok.$numberLong !== undefined) return 'int64'
    if (ok.$numberDouble !== undefined) return 'double'
    return 'other'
}

function repliesMatch(oracle, local) {
    const normalizedOracle = normalizeReply(oracle)
    const normalizedLocal = normalizeReply(local)
    return {
        match: stable(semantic(normalizedOracle.value)) === stable(semantic(normalizedLocal.value)),
        sameOrder: JSON.stringify(normalizedOracle.value) === JSON.stringify(normalizedLocal.value),
        flags: {
            cursor: normalizedOracle.flags.cursor || normalizedLocal.flags.cursor,
            uuid: normalizedOracle.flags.uuid || normalizedLocal.flags.uuid,
            oid: normalizedOracle.flags.oid || normalizedLocal.flags.oid,
            hash: normalizedOracle.flags.hash || normalizedLocal.flags.hash,
            serverInfo: normalizedOracle.flags.serverInfo || normalizedLocal.flags.serverInfo,
            timing: normalizedOracle.flags.timing || normalizedLocal.flags.timing
        },
        oracle: normalizedOracle.value,
        local: normalizedLocal.value
    }
}

// --- corpus generator -------------------------------------------------------
function mulberry32(seed) {
    let state = seed >>> 0
    return () => {
        state = (state + 0x6d2b79f5) >>> 0
        let value = Math.imul(state ^ (state >>> 15), 1 | state)
        value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296
    }
}

const pick = (rng, values) => values[Math.floor(rng() * values.length)]

const BASE_DOCS = () => [
    { _id: 1, name: 'alpha', score: 10, grp: 'a', tags: ['red', 'blue'], a: { b: 5 }, items: [{ qty: 2 }, { qty: 5 }], active: true },
    { _id: 2, name: 'beta', score: 20, grp: 'a', tags: ['blue'], a: { b: 7 }, items: [{ qty: 1 }], active: false },
    { _id: 3, name: 'gamma', score: 30, grp: 'b', tags: ['green', 'red'], a: { b: 9 }, items: [{ qty: 4 }], active: true },
    { _id: 4, name: 'delta', score: 40, grp: 'b', tags: [], a: { b: 11 }, items: [], active: false },
    { _id: 5, name: 'epsilon', score: 50, grp: 'c', tags: ['red'], a: { b: 13 }, items: [{ qty: 6 }], active: true }
]

function buildFind(seed) {
    const rng = mulberry32(seed)
    const entries = []
    let n = 0
    function add(suffix, docs, steps) {
        const collection = `diff_find_${n}`
        entries.push({
            id: `diff.find.${suffix}`,
            cluster: 'find',
            collection,
            setup: [{ op: 'insert', collection, documents: docs }],
            steps: steps.map((step) => ({ ...step, collection }))
        })
        n += 1
    }
    const docs = BASE_DOCS()
    const score = pick(rng, [10, 20, 30, 40, 50])
    add('eq_int', BASE_DOCS(), [{ op: 'find', filter: { score }, sort: { _id: 1 } }])
    add('eq_string', BASE_DOCS(), [{ op: 'find', filter: { name: 'gamma' }, sort: { _id: 1 } }])
    add('gt_int', BASE_DOCS(), [{ op: 'find', filter: { score: { $gt: 25 } }, sort: { _id: 1 } }])
    add('lte_double', docs.map((item) => ({ ...item, ratio: { $numberDouble: `${item._id % 3 === 0 ? '0.5' : '1.5'}` } })), [
        { op: 'find', filter: { ratio: { $lte: { $numberDouble: '1.0' } } }, sort: { _id: 1 } }
    ])
    add('in_list', BASE_DOCS(), [{ op: 'find', filter: { score: { $in: [10, 30] } }, sort: { _id: 1 } }])
    add('nin_list', BASE_DOCS(), [{ op: 'find', filter: { score: { $nin: [20, 40] } }, sort: { _id: 1 } }])
    add('exists_true', BASE_DOCS().map((item) => (item._id % 2 === 0 ? item : { ...item, opt: 1 })), [
        { op: 'find', filter: { opt: { $exists: true } }, sort: { _id: 1 } }
    ])
    add('exists_false', BASE_DOCS().map((item) => (item._id % 2 === 0 ? item : { ...item, opt: 1 })), [
        { op: 'find', filter: { opt: { $exists: false } }, sort: { _id: 1 } }
    ])
    add('type_int', [
        { _id: 1, v: 7 },
        { _id: 2, v: 'seven' },
        { _id: 3, v: { $numberDouble: '7.5' } },
        { _id: 4, v: true }
    ], [{ op: 'find', filter: { v: { $type: 16 } }, sort: { _id: 1 } }])
    add('type_alias', [
        { _id: 1, v: 7 },
        { _id: 2, v: 'seven' },
        { _id: 3, v: { $numberDouble: '7.5' } },
        { _id: 4, v: true }
    ], [{ op: 'find', filter: { v: { $type: 'string' } }, sort: { _id: 1 } }])
    add('regex_anchor', BASE_DOCS(), [{ op: 'find', filter: { name: { $regex: '^a' } }, sort: { _id: 1 } }])
    add('regex_array', BASE_DOCS(), [{ op: 'find', filter: { tags: { $regex: '^b' } }, sort: { _id: 1 } }])
    add('array_elem', BASE_DOCS(), [{ op: 'find', filter: { tags: 'red' }, sort: { _id: 1 } }])
    add('array_all', BASE_DOCS(), [{ op: 'find', filter: { tags: { $all: ['red', 'blue'] } }, sort: { _id: 1 } }])
    add('array_size', BASE_DOCS(), [{ op: 'find', filter: { tags: { $size: 2 } }, sort: { _id: 1 } }])
    add('elem_match', BASE_DOCS(), [{ op: 'find', filter: { items: { $elemMatch: { qty: { $gte: 4 } } } }, sort: { _id: 1 } }])
    add('dotted_nested', BASE_DOCS(), [{ op: 'find', filter: { 'a.b': 9 }, sort: { _id: 1 } }])
    add('dotted_array', BASE_DOCS(), [{ op: 'find', filter: { 'items.qty': { $gte: 4 } }, sort: { _id: 1 } }])
    add('logical_and', BASE_DOCS(), [{ op: 'find', filter: { $and: [{ score: { $gte: 20 } }, { name: { $ne: 'beta' } }] }, sort: { _id: 1 } }])
    add('logical_or', BASE_DOCS(), [{ op: 'find', filter: { $or: [{ score }, { score: 50 }] }, sort: { _id: 1 } }])
    add('projection_include', BASE_DOCS(), [{ op: 'find', filter: {}, projection: { name: 1, score: 1 }, sort: { _id: 1 } }])
    add('projection_exclude', BASE_DOCS(), [{ op: 'find', filter: {}, projection: { score: 0, tags: 0 }, sort: { _id: 1 } }])
    add('projection_expr_add', BASE_DOCS(), [{ op: 'find', filter: {}, projection: { name: 1, total: { $add: ['$score', 5] } }, sort: { _id: 1 } }])
    add('sort_skip_limit', BASE_DOCS(), [{ op: 'find', filter: {}, sort: { score: -1, _id: 1 }, skip: 1, limit: 2 }])
    return entries
}

function buildAggregate(seed) {
    const rng = mulberry32(seed)
    const entries = []
    let n = 0
    const docs = [
        { _id: 1, name: 'alpha', score: 10, grp: 'a', tags: ['red', 'blue'] },
        { _id: 2, name: 'beta', score: 20, grp: 'a', tags: ['blue'] },
        { _id: 3, name: 'gamma', score: 30, grp: 'b', tags: ['green'] },
        { _id: 4, name: 'delta', score: 40, grp: 'b', tags: [] },
        { _id: 5, name: 'epsilon', score: 50, grp: 'a', tags: ['red'] },
        { _id: 6, name: 'zeta', score: 60, grp: 'a', tags: ['red', 'blue'] },
        { _id: 7, name: 'eta', score: 70, grp: 'a', tags: null },
        { _id: 8, name: 'theta', score: 80, grp: 'a', tags: ['blue'] }
    ]
    function add(suffix, pipeline, options = {}) {
        const collection = `diff_agg_${n}`
        const entry = {
            id: `diff.aggregate.${suffix}`,
            cluster: 'aggregate',
            collection,
            setup: [{ op: 'insert', collection, documents: options.docs ?? docs }, ...(options.setup ?? [])],
            steps: [{ op: 'aggregate', collection, pipeline }]
        }
        if (options.unordered) entry.unordered = options.unordered
        entries.push(entry)
        n += 1
    }
    const threshold = pick(rng, [20, 30, 40])
    add('match_sort_project', [
        { $match: { score: { $gte: threshold } } },
        { $sort: { _id: 1 } },
        { $project: { _id: 1, name: 1 } }
    ])
    add('limit_skip_order', [{ $limit: 3 }, { $skip: 1 }])
    add('group_sum', [{ $group: { _id: '$grp', total: { $sum: '$score' } } }, { $sort: { _id: 1 } }])
    add('group_avg', [{ $group: { _id: '$grp', average: { $avg: '$score' } } }, { $sort: { _id: 1 } }])
    add('group_min_max', [
        { $group: { _id: '$grp', low: { $min: '$score' }, high: { $max: '$score' } } },
        { $sort: { _id: 1 } }
    ])
    add('group_push', [{ $group: { _id: '$grp', values: { $push: '$score' } } }, { $sort: { _id: 1 } }])
    add('group_add_to_set', [{ $group: { _id: '$grp', values: { $addToSet: '$score' } } }, { $sort: { _id: 1 } }], { unordered: ['values'] })
    add('group_first_last', [
        { $sort: { _id: 1 } },
        { $group: { _id: '$grp', first: { $first: '$name' }, last: { $last: '$name' } } },
        { $sort: { _id: 1 } }
    ])
    add('count_all', [{ $count: 'n' }])
    add('count_empty', [{ $match: { score: { $gte: 1000 } } }, { $count: 'n' }])
    add('unwind_string', [{ $unwind: '$tags' }, { $sort: { _id: 1, tags: 1 } }])
    add('unwind_preserve', [{ $unwind: { path: '$tags', preserveNullAndEmptyArrays: true } }, { $sort: { _id: 1, tags: 1 } }])
    add('unwind_index', [{ $unwind: { path: '$tags', includeArrayIndex: 'slot' } }, { $sort: { _id: 1, slot: 1 } }])
    add('lookup', [
        { $lookup: { from: `diff_agg_${n}_foreign`, localField: 'grp', foreignField: 'key', as: 'joined' } },
        { $sort: { _id: 1 } },
        { $project: { _id: 1, joined: 1 } }
    ], {
        setup: [{
            op: 'insert',
            collection: `diff_agg_${n}_foreign`,
            documents: [{ _id: 1, key: 'a', label: 'first' }, { _id: 2, key: 'b', label: 'second' }]
        }]
    })
    add('lookup_missing', [
        { $lookup: { from: `diff_agg_${n}_foreign`, localField: 'name', foreignField: 'key', as: 'joined' } },
        { $sort: { _id: 1 } },
        { $project: { _id: 1, joined: 1 } }
    ], {
        setup: [{
            op: 'insert',
            collection: `diff_agg_${n}_foreign`,
            documents: [{ _id: 1, key: 'alpha' }, { _id: 2, key: 'beta' }]
        }]
    })
    add('sort_by_count', [{ $sortByCount: '$tags' }], {
        docs: [
            { _id: 1, tags: ['red'] },
            { _id: 2, tags: ['red'] },
            { _id: 3, tags: ['red'] },
            { _id: 4, tags: ['blue'] },
            { _id: 5, tags: ['blue'] },
            { _id: 6, tags: ['green'] }
        ]
    })
    add('project_concat', [
        { $sort: { _id: 1 } },
        { $project: { label: { $concat: ['$name', '-x'] }, _id: 0 } }
    ])
    add('project_ifnull', [
        { $sort: { _id: 1 } },
        { $project: { tag: { $ifNull: ['$tags', 'none'] }, _id: 1 } }
    ])
    add('project_add', [
        { $sort: { _id: 1 } },
        { $project: { _id: 1, bumped: { $add: ['$score', 1] } } }
    ])
    add('group_avg_double', [
        { $group: { _id: '$grp', average: { $avg: '$score' } } },
        { $sort: { _id: 1 } }
    ])
    add('addfields_basic', [{ $addFields: { extra: 1 } }, { $sort: { _id: 1 } }])
    add('addfields_multi', [{ $addFields: { extra: 1, doubled: { $add: ['$score', '$score'] } } }, { $sort: { _id: 1 } }])
    add('addfields_then_match', [
        { $addFields: { bumped: { $add: ['$score', 10] } } },
        { $match: { bumped: { $gte: 40 } } },
        { $sort: { _id: 1 } }
    ])
    add('match_unwind_group', [
        { $match: { score: { $gte: 30 } } },
        { $unwind: '$tags' },
        { $group: { _id: '$tags', total: { $sum: '$score' } } },
        { $sort: { _id: 1 } }
    ])
    add('sort_multi_key', [{ $sort: { score: -1, name: 1 } }])
    add('lookup_pipeline_let', [
        {
            $lookup: {
                from: `diff_agg_${n}_foreign`,
                let: { bucket: '$grp' },
                pipeline: [{ $match: { $expr: { $eq: ['$key', '$$bucket'] } } }, { $project: { _id: 0, key: 1, label: 1 } }],
                as: 'joined'
            }
        },
        { $sort: { _id: 1 } },
        { $project: { _id: 1, joined: 1 } }
    ], {
        setup: [{
            op: 'insert',
            collection: `diff_agg_${n}_foreign`,
            documents: [{ _id: 1, key: 'a', label: 'first' }, { _id: 2, key: 'b', label: 'second' }]
        }]
    })
    add('lookup_combined', [
        {
            $lookup: {
                from: `diff_agg_${n}_foreign`,
                localField: 'grp',
                foreignField: 'key',
                pipeline: [{ $project: { _id: 0, key: 1 } }],
                as: 'joined'
            }
        },
        { $sort: { _id: 1 } },
        { $project: { _id: 1, joined: 1 } }
    ], {
        setup: [{
            op: 'insert',
            collection: `diff_agg_${n}_foreign`,
            documents: [{ _id: 1, key: 'a', label: 'first' }, { _id: 2, key: 'b', label: 'second' }, { _id: 3, key: 'c', label: 'third' }]
        }]
    })
    add('facet_two', [
        {
            $facet: {
                low: [{ $match: { score: { $lt: 40 } } }, { $count: 'n' }],
                high: [{ $match: { score: { $gte: 40 } } }, { $count: 'n' }]
            }
        }
    ])
    add('bucket_default', [
        { $bucket: { groupBy: '$score', boundaries: [20, 50], default: 'other', output: { n: { $sum: 1 } } } }
    ])
    add('bucket_no_output', [
        { $bucket: { groupBy: '$score', boundaries: [20, 50] } }
    ], {
        docs: [
            { _id: 1, score: 20 },
            { _id: 2, score: 30 },
            { _id: 3, score: 40 },
            { _id: 4, score: 45 }
        ]
    })
    add('bucket_no_default_out_of_range', [
        { $bucket: { groupBy: '$score', boundaries: [20, 50] } }
    ])
    add('bucket_auto', [
        { $bucketAuto: { groupBy: '$score', buckets: 3 } }
    ], {
        docs: [
            { _id: 1, score: 10 },
            { _id: 2, score: 20 },
            { _id: 3, score: 30 },
            { _id: 4, score: 40 },
            { _id: 5, score: 50 }
        ]
    })
    add('window_document_number', [
        {
            $setWindowFields: {
                partitionBy: '$grp',
                sortBy: { score: 1 },
                output: { row: { $documentNumber: {} }, total: { $sum: '$score' } }
            }
        },
        { $project: { _id: 1, grp: 1, score: 1, row: 1, total: 1 } }
    ])
    add('window_rank', [
        {
            $setWindowFields: {
                partitionBy: '$grp',
                sortBy: { score: 1 },
                output: { rank: { $rank: {} }, row: { $documentNumber: {} } }
            }
        },
        { $project: { _id: 1, grp: 1, score: 1, rank: 1, row: 1 } }
    ])
    add('window_cumulative_sum', [
        {
            $setWindowFields: {
                partitionBy: '$grp',
                sortBy: { score: 1 },
                output: { running: { $sum: '$score', window: { documents: ['unbounded', 'current'] } } }
            }
        },
        { $project: { _id: 1, grp: 1, score: 1, running: 1 } }
    ])
    add('window_requires_sort', [
        { $setWindowFields: { output: { row: { $documentNumber: {} } } } }
    ])
    return entries
}

function buildUpdate(seed) {
    const rng = mulberry32(seed)
    const entries = []
    let n = 0
    const docs = () => [
        { _id: 1, grp: 'a', score: 10, a: { b: 5 }, items: [{ qty: 2 }, { qty: 5 }], name: 'alpha', tags: ['old', 'mid'] },
        { _id: 2, grp: 'a', score: 20, a: { b: 7 }, items: [{ qty: 1 }], name: 'beta', tags: ['red'] },
        { _id: 3, grp: 'b', score: 30, a: { b: 9 }, items: [], name: 'gamma', tags: [] },
        { _id: 4, grp: 'b', score: 40, a: { b: 11 }, items: [{ qty: 4 }], name: 'delta', tags: ['blue', 'old'] },
        { _id: 5, grp: 'c', score: 50, a: { b: 13 }, items: [{ qty: 6 }], name: 'epsilon', tags: ['mid', 'green'] }
    ]
    const target = pick(rng, [1, 2, 3])
    function add(suffix, updates) {
        const collection = `diff_update_${n}`
        entries.push({
            id: `diff.update.${suffix}`,
            cluster: 'update',
            collection,
            setup: [{ op: 'insert', collection, documents: docs() }],
            steps: [{ op: 'update', collection, updates }]
        })
        n += 1
    }
    add('set_scalar', [{ q: { _id: target }, u: { $set: { name: 'renamed' } } }])
    add('set_multi', [{ q: { grp: 'a' }, u: { $set: { score: 99 } }, multi: true }])
    add('set_omit_multi', [{ q: { grp: 'a' }, u: { $set: { score: 99 } } }])
    add('inc_positive', [{ q: { _id: target }, u: { $inc: { score: 5 } } }])
    add('inc_negative', [{ q: { grp: 'a' }, u: { $inc: { score: -5 } }, multi: true }])
    add('unset_field', [{ q: { _id: target }, u: { $unset: { name: '' } } }])
    add('unset_nested', [{ q: { _id: target }, u: { $unset: { 'a.b': '' } } }])
    add('set_nested', [{ q: { _id: target }, u: { $set: { 'a.b': 42 } } }])
    add('set_array_index', [{ q: { _id: target }, u: { $set: { 'items.0.qty': 7 } } }])
    add('no_match', [{ q: { _id: 99 }, u: { $set: { name: 'nobody' } } }])
    add('push', [{ q: { _id: target }, u: { $push: { tags: 'new' } } }])
    add('pop', [{ q: { _id: target }, u: { $pop: { tags: 1 } } }])
    add('add_to_set', [{ q: { _id: target }, u: { $addToSet: { tags: 'new' } } }])
    add('pull', [{ q: { _id: target }, u: { $pull: { tags: 'old' } } }])
    add('rename', [{ q: { _id: target }, u: { $rename: { name: 'label' } } }])
    add('mul', [{ q: { _id: target }, u: { $mul: { score: 2 } } }])
    add('upsert', [{ q: { _id: 99 }, u: { $set: { name: 'fresh' } }, upsert: true }])
    add('replacement', [{ q: { _id: target }, u: { name: 'replaced', score: 1 } }])
    add('push_each_position_slice', [{ q: { _id: 1 }, u: { $push: { tags: { $each: ['x', 'y'], $position: 0, $slice: 2 } } } }])
    add('push_each_slice_negative', [{ q: { _id: 1 }, u: { $push: { tags: { $each: ['p'], $slice: -1 } } } }])
    add('push_missing_field', [{ q: { _id: 3 }, u: { $push: { extra: 'z' } } }])
    add('pop_first', [{ q: { _id: 1 }, u: { $pop: { tags: -1 } } }])
    add('pop_zero_error', [{ q: { _id: 1 }, u: { $pop: { tags: 0 } } }])
    add('add_to_set_each', [{ q: { _id: 1 }, u: { $addToSet: { tags: { $each: ['old', 'green'] } } } }])
    add('pull_condition', [{ q: { _id: 1 }, u: { $pull: { tags: { $in: ['old', 'mid'] } } } }])
    add('pull_document', [{ q: { _id: 1 }, u: { $pull: { items: { qty: { $gte: 5 } } } } }])
    add('rename_missing', [{ q: { _id: 1 }, u: { $rename: { ghost: 'label' } } }])
    add('rename_same_error', [{ q: { _id: 1 }, u: { $rename: { name: 'name' } } }])
    add('mul_double', [{ q: { _id: 1 }, u: { $mul: { score: { $numberDouble: '1.5' } } } }])
    add('min_lower', [{ q: { _id: 1 }, u: { $min: { score: 5 } } }])
    add('min_keep', [{ q: { _id: 1 }, u: { $min: { score: 15 } } }])
    add('min_missing', [{ q: { _id: 1 }, u: { $min: { ghost: 3 } } }])
    add('max_raise', [{ q: { _id: 1 }, u: { $max: { score: 25 } } }])
    add('max_keep', [{ q: { _id: 1 }, u: { $max: { score: 5 } } }])
    add('max_missing', [{ q: { _id: 1 }, u: { $max: { ghost: 4 } } }])
    add('set_on_insert_upsert', [{ q: { _id: 97 }, u: { $set: { name: 'ins' }, $setOnInsert: { score: 1 } }, upsert: true }])
    add('set_on_insert_match', [{ q: { _id: 1 }, u: { $set: { score: 12 }, $setOnInsert: { name: 'ignored' } }, upsert: true }])
    add('array_index_inc', [{ q: { _id: 1 }, u: { $inc: { 'items.0.qty': 1 } } }])
    add('array_index_unset', [{ q: { _id: 1 }, u: { $unset: { 'items.0.qty': '' } } }])
    add('array_index_pad', [{ q: { _id: 3 }, u: { $set: { 'items.5.qty': 1 } } }])
    add('array_index_negative_error', [{ q: { _id: 1 }, u: { $set: { 'items.-1.qty': 3 } } }])
    add('positional_dotted', [{ q: { _id: 1, 'items.qty': { $gte: 5 } }, u: { $set: { 'items.$.qty': 0 } } }])
    add('positional_elem_match', [{ q: { _id: 1, items: { $elemMatch: { qty: 2 } } }, u: { $inc: { 'items.$.qty': 10 } } }])
    add('push_nonarray_error', [{ q: { _id: 1 }, u: { $push: { score: 1 } } }])
    add('pull_nonarray_error', [{ q: { _id: 1 }, u: { $pull: { score: 1 } } }])
    add('upsert_operator_fields', [{ q: { _id: 99, grp: 'z' }, u: { $inc: { score: 1 } }, upsert: true }])
    add('upsert_replacement', [{ q: { _id: 98 }, u: { grp: 'r', score: 7 }, upsert: true }])
    add('upsert_match_existing', [{ q: { _id: 1 }, u: { $set: { score: 11 } }, upsert: true }])
    add('replacement_keep_id', [{ q: { _id: 1 }, u: { score: 1 } }])
    add('replacement_alter_id_error', [{ q: { _id: 1 }, u: { _id: 9, score: 1 } }])
    add('replacement_empty', [{ q: { _id: 1 }, u: {} }])
    return entries
}

function buildDelete(seed) {
    const entries = []
    let n = 0
    const docs = () => [
        { _id: 1, grp: 'a', score: 10, tags: ['red'] },
        { _id: 2, grp: 'a', score: 20, tags: ['blue'] },
        { _id: 3, grp: 'b', score: 30, tags: [] },
        { _id: 4, grp: 'b', score: 40, tags: ['red'] },
        { _id: 5, grp: 'c', score: 50, tags: [] }
    ]
    function add(suffix, deletes, steps) {
        const collection = `diff_delete_${n}`
        entries.push({
            id: `diff.delete.${suffix}`,
            cluster: 'delete',
            collection,
            setup: [{ op: 'insert', collection, documents: docs() }],
            steps: steps ?? [{ op: 'delete', collection, deletes }]
        })
        n += 1
    }
    add('one_match', [{ q: { grp: 'a' }, limit: 1 }])
    add('many_match', [{ q: { grp: 'a' }, limit: 0 }])
    add('no_match', [{ q: { _id: 99 }, limit: 0 }])
    add('in_filter', [{ q: { score: { $in: [10, 30] } }, limit: 0 }])
    add('regex_filter', [{ q: { tags: { $regex: '^r' } }, limit: 0 }])
    add('nested_filter', [{ q: { 'a.b': 9 }, limit: 0 }])
    add('multi_specs', [
        { q: { _id: 1 }, limit: 1 },
        { q: { _id: 2 }, limit: 1 }
    ])
    add('one_then_many', [
        { q: { grp: 'b' }, limit: 1 },
        { q: { grp: 'b' }, limit: 0 }
    ], [
        { op: 'delete', collection: `diff_delete_${n}`, deletes: [{ q: { grp: 'b' }, limit: 1 }] },
        { op: 'delete', collection: `diff_delete_${n}`, deletes: [{ q: { grp: 'b' }, limit: 0 }] },
        { op: 'find', collection: `diff_delete_${n}`, filter: {}, sort: { _id: 1 } }
    ])
    return entries
}

function buildInsert(seed) {
    const entries = []
    let n = 0
    const single = (id) => ({ _id: id, name: `doc${id}` })
    function add(suffix, documents, steps, setup = []) {
        const collection = `diff_insert_${n}`
        entries.push({
            id: `diff.insert.${suffix}`,
            cluster: 'insert',
            collection,
            setup: [{ op: 'insert', collection, documents }, ...setup],
            steps: steps ?? [{ op: 'find', collection, filter: {}, sort: { _id: 1 } }]
        })
        n += 1
    }
    add('plain_batch', [single(1), single(2), single(3)])
    add('plain_single', [single(7)])
    add('ordered_false_dup_within', [single(1), single(1), single(2)], [
        { op: 'insert', collection: `diff_insert_${n}`, documents: [single(1), single(1), single(2)], ordered: false },
        { op: 'find', collection: `diff_insert_${n}`, filter: {}, sort: { _id: 1 } }
    ])
    add('ordered_true_dup_within', [single(1), single(1), single(2)], [
        { op: 'insert', collection: `diff_insert_${n}`, documents: [single(1), single(1), single(2)], ordered: true },
        { op: 'find', collection: `diff_insert_${n}`, filter: {}, sort: { _id: 1 } }
    ])
    add('duplicate_across_commands', [single(5)], [
        { op: 'insert', collection: `diff_insert_${n}`, documents: [single(5), single(6)], ordered: false },
        { op: 'find', collection: `diff_insert_${n}`, filter: {}, sort: { _id: 1 } }
    ])
    add('duplicate_int_vs_double', [single(1)], [
        { op: 'insert', collection: `diff_insert_${n}`, documents: [{ _id: { $numberDouble: '1.0' }, name: 'x' }] },
        { op: 'find', collection: `diff_insert_${n}`, filter: {}, sort: { _id: 1 } }
    ])
    add('empty_batch', [single(1)], [
        { op: 'insert', collection: `diff_insert_${n}`, documents: [] }
    ])
    add('string_vs_int_id', [single(1)], [
        { op: 'insert', collection: `diff_insert_${n}`, documents: [{ _id: '1', name: 'string-id' }] },
        { op: 'find', collection: `diff_insert_${n}`, filter: {}, sort: { _id: 1 } }
    ])
    add('ordered_false_multi_conflicts', [single(1)], [
        { op: 'insert', collection: `diff_insert_${n}`, documents: [single(1), single(1), single(1), single(2)], ordered: false },
        { op: 'find', collection: `diff_insert_${n}`, filter: {}, sort: { _id: 1 } }
    ])
    add('duplicate_extra_fields', [{ _id: 1, name: 'first' }], [
        { op: 'insert', collection: `diff_insert_${n}`, documents: [{ _id: 1, name: 'second' }] },
        { op: 'find', collection: `diff_insert_${n}`, filter: {}, sort: { _id: 1 } }
    ])
    return entries
}

function buildIndexes(seed) {
    const entries = []
    let n = 0
    const docs = () => [
        { _id: 1, a: 10, b: 'x', tags: ['red', 'blue'] },
        { _id: 2, a: 20, b: 'y', tags: ['blue'] },
        { _id: 3, a: 30, b: 'z', tags: ['green'] }
    ]
    function add(suffix, setupIndexes, steps) {
        const collection = `diff_index_${n}`
        const setup = [{ op: 'insert', collection, documents: docs() }]
        if (setupIndexes) setup.push({ op: 'createIndexes', collection, indexes: setupIndexes })
        entries.push({ id: `diff.index.${suffix}`, cluster: 'indexes', collection, setup, steps })
        n += 1
    }
    add('single_create_list', null, [
        { op: 'createIndexes', collection: `diff_index_${n}`, indexes: [{ key: { a: 1 }, name: 'a_1' }] },
        { op: 'listIndexes', collection: `diff_index_${n}` }
    ])
    add('compound_create_list', null, [
        { op: 'createIndexes', collection: `diff_index_${n}`, indexes: [{ key: { a: 1, b: -1 }, name: 'ab_1_-1' }] },
        { op: 'listIndexes', collection: `diff_index_${n}` }
    ])
    add('unique_create_clean', null, [
        { op: 'createIndexes', collection: `diff_index_${n}`, indexes: [{ key: { a: 1 }, name: 'a_unique', unique: true }] },
        { op: 'listIndexes', collection: `diff_index_${n}` }
    ])
    add('unique_insert_conflict', [{ key: { a: 1 }, name: 'a_unique', unique: true }], [
        { op: 'insert', collection: `diff_index_${n}`, documents: [{ _id: 9, a: 10, b: 'dup' }] },
        { op: 'find', collection: `diff_index_${n}`, filter: {}, sort: { _id: 1 } }
    ])
    add('unique_compound_conflict', [{ key: { a: 1, b: 1 }, name: 'ab_unique', unique: true }], [
        { op: 'insert', collection: `diff_index_${n}`, documents: [{ _id: 9, a: 10, b: 'x' }] }
    ])
    add('unique_multikey_conflict', [{ key: { tags: 1 }, name: 'tags_unique', unique: true }], [
        { op: 'insert', collection: `diff_index_${n}`, documents: [{ _id: 9, tags: ['blue'] }] }
    ])
    add('unique_multikey_within_doc', [{ key: { tags: 1 }, name: 'tags_unique', unique: true }], [
        { op: 'insert', collection: `diff_index_${n}`, documents: [{ _id: 9, tags: ['solo', 'solo'] }] }
    ])
    add('parallel_arrays', null, [
        { op: 'createIndexes', collection: `diff_index_${n}`, indexes: [{ key: { left: 1, right: 1 }, name: 'left_right' }] },
        { op: 'insert', collection: `diff_index_${n}`, documents: [{ _id: 9, left: [1, 2], right: ['x', 'y'] }] }
    ])
    add('drop_by_name_then_list', [{ key: { a: 1 }, name: 'a_1' }], [
        { op: 'dropIndexes', collection: `diff_index_${n}`, index: 'a_1' },
        { op: 'listIndexes', collection: `diff_index_${n}` }
    ])
    add('drop_all_then_list', [{ key: { a: 1 }, name: 'a_1' }, { key: { b: 1 }, name: 'b_1' }], [
        { op: 'dropIndexes', collection: `diff_index_${n}`, index: '*' },
        { op: 'listIndexes', collection: `diff_index_${n}` }
    ])
    add('create_then_conflict_ordered_false', [{ key: { a: 1 }, name: 'a_unique', unique: true }], [
        { op: 'insert', collection: `diff_index_${n}`, documents: [{ _id: 8, a: 15 }, { _id: 9, a: 10 }, { _id: 10, a: 25 }], ordered: false },
        { op: 'find', collection: `diff_index_${n}`, filter: {}, sort: { _id: 1 } }
    ])
    add('unique_build_on_duplicates', null, [
        { op: 'insert', collection: `diff_index_${n}`, documents: [{ _id: 8, a: 10 }] },
        { op: 'createIndexes', collection: `diff_index_${n}`, indexes: [{ key: { a: 1 }, name: 'a_unique', unique: true }] }
    ])
    function addWithDocs(suffix, documents, setupIndexes, steps) {
        const collection = `diff_index_${n}`
        const setup = [{ op: 'insert', collection, documents }]
        if (setupIndexes) setup.push({ op: 'createIndexes', collection, indexes: setupIndexes })
        entries.push({ id: `diff.index.${suffix}`, cluster: 'indexes', collection, setup, steps })
        n += 1
    }
    addWithDocs('options_shape', docs(), [{
        key: { a: 1 }, name: 'a_unique', unique: true
    }, {
        key: { b: 1 }, name: 'b_sparse', sparse: true
    }, {
        key: { b: 1 }, name: 'b_sparse_false', sparse: false
    }, {
        key: { tags: 1 }, name: 'tags_hidden', hidden: true
    }, {
        key: { tags: 1 }, name: 'tags_visible'
    }, {
        key: { name: 1 }, name: 'name_ci', collation: { locale: 'en', strength: 2 }
    }, {
        key: { score: 1 }, name: 'score_partial', partialFilterExpression: { score: { $gt: 5 } }
    }, {
        key: { active: 1 }, name: 'active_ttl', expireAfterSeconds: 60
    }], [
        { op: 'createIndexes', collection: `diff_index_${n}`, indexes: [{
            key: { a: 1 }, name: 'a_unique', unique: true
        }, {
            key: { b: 1 }, name: 'b_sparse', sparse: true
        }, {
            key: { b: 1 }, name: 'b_sparse_false', sparse: false
        }, {
            key: { tags: 1 }, name: 'tags_hidden', hidden: true
        }, {
            key: { tags: 1 }, name: 'tags_visible'
        }, {
            key: { name: 1 }, name: 'name_ci', collation: { locale: 'en', strength: 2 }
        }, {
            key: { score: 1 }, name: 'score_partial', partialFilterExpression: { score: { $gt: 5 } }
        }, {
            key: { active: 1 }, name: 'active_ttl', expireAfterSeconds: 60
        }, {
            key: { grp: 1 }, name: 'grp_defaults', unique: false, hidden: false
        }] },
        { op: 'listIndexes', collection: `diff_index_${n}` }
    ])
    addWithDocs('sparse_unique_null_and_missing', [
        { _id: 1, a: 10, b: 'x' },
        { _id: 2, a: 20, b: 'y' },
        { _id: 3, b: 'z' }
    ], [{ key: { a: 1 }, name: 'a_sparse', unique: true, sparse: true }], [
        { op: 'insert', collection: `diff_index_${n}`, documents: [{ _id: 4, a: null }] },
        { op: 'insert', collection: `diff_index_${n}`, documents: [{ _id: 5, a: null }] },
        { op: 'insert', collection: `diff_index_${n}`, documents: [{ _id: 6 }] },
        { op: 'insert', collection: `diff_index_${n}`, documents: [{ _id: 7, a: 10 }] },
        { op: 'find', collection: `diff_index_${n}`, filter: {}, sort: { _id: 1 } }
    ])
    addWithDocs('partial_unique_outside_filter', [
        { _id: 1, a: 10 },
        { _id: 2, a: 5 },
        { _id: 3, a: 5 }
    ], [{ key: { a: 1 }, name: 'a_partial', unique: true, partialFilterExpression: { a: { $gt: 7 } } }], [
        { op: 'insert', collection: `diff_index_${n}`, documents: [{ _id: 4, a: 5 }, { _id: 5, a: 5 }] },
        { op: 'insert', collection: `diff_index_${n}`, documents: [{ _id: 6, a: 10 }] },
        { op: 'find', collection: `diff_index_${n}`, filter: {}, sort: { _id: 1 } }
    ])
    addWithDocs('partial_build_outside_only', [
        { _id: 1, a: 10 },
        { _id: 2, a: 5 },
        { _id: 3, a: 5 }
    ], null, [
        { op: 'createIndexes', collection: `diff_index_${n}`, indexes: [{ key: { a: 1 }, name: 'a_partial', unique: true, partialFilterExpression: { a: { $gt: 7 } } }] },
        { op: 'listIndexes', collection: `diff_index_${n}` }
    ])
    addWithDocs('partial_build_inside_duplicates', [
        { _id: 1, a: 10 },
        { _id: 2, a: 10 }
    ], null, [
        { op: 'createIndexes', collection: `diff_index_${n}`, indexes: [{ key: { a: 1 }, name: 'a_partial', unique: true, partialFilterExpression: { a: { $gt: 7 } } }] }
    ])
    addWithDocs('drop_errors', docs(), [{ key: { a: 1 }, name: 'a_1' }], [
        { op: 'dropIndexes', collection: `diff_index_${n}`, index: '_id_' },
        { op: 'dropIndexes', collection: `diff_index_${n}`, index: 'missing_name' },
        { op: 'dropIndexes', collection: `diff_index_${n}`, index: { a: -1 } },
        { op: 'dropIndexes', collection: `diff_index_ghost`, index: 'a_1' },
        { op: 'dropIndexes', collection: `diff_index_${n}`, index: { a: 1 } },
        { op: 'listIndexes', collection: `diff_index_${n}` }
    ])
    addWithDocs('conflicts', docs(), [{ key: { a: 1 }, name: 'a_1' }], [
        { op: 'createIndexes', collection: `diff_index_${n}`, indexes: [{ key: { a: 1 }, name: 'a_2' }] },
        { op: 'createIndexes', collection: `diff_index_${n}`, indexes: [{ key: { a: 1 }, name: 'a_1', unique: true }] },
        { op: 'listIndexes', collection: `diff_index_${n}` }
    ])
    addWithDocs('recreate_id_custom', docs(), null, [
        { op: 'createIndexes', collection: `diff_index_${n}`, indexes: [{ key: { _id: 1 }, name: 'id_custom' }] }
    ])
    addWithDocs('bad_options', docs(), null, [
        { op: 'createIndexes', collection: `diff_index_${n}`, indexes: [{ key: { a: 1 }, name: 'p_str', partialFilterExpression: 'x' }] },
        { op: 'createIndexes', collection: `diff_index_${n}`, indexes: [{ key: { a: 1 }, name: 'p_op', partialFilterExpression: { a: { $unknown: 1 } } }] },
        { op: 'createIndexes', collection: `diff_index_${n}`, indexes: [{ key: { a: 1 }, name: 'u_str', unique: 'yes' }] },
        { op: 'createIndexes', collection: `diff_index_${n}`, indexes: [{ key: { a: 1 }, name: 'c_bad', collation: { locale: 'bogus' } }] },
        { op: 'createIndexes', collection: `diff_index_${n}`, indexes: [{ key: { a: 1, b: 1 }, name: 'ab_ttl', expireAfterSeconds: 60 }] },
        { op: 'createIndexes', collection: `diff_index_${n}`, indexes: [{ key: { a: 1 }, name: 'a_ttl_neg', expireAfterSeconds: -1 }] }
    ])
    addWithDocs('wildcard_list', docs(), null, [
        { op: 'createIndexes', collection: `diff_index_${n}`, indexes: [{ key: { '$**': 1 }, name: 'wild', wildcardProjection: { a: 1 } }] },
        { op: 'createIndexes', collection: `diff_index_${n}`, indexes: [{ key: { 'tags.$**': 1 }, name: 'tags_wild' }] },
        { op: 'listIndexes', collection: `diff_index_${n}` }
    ])
    addWithDocs('wildcard_errors', docs(), null, [
        { op: 'createIndexes', collection: `diff_index_${n}`, indexes: [{ key: { '$**': 1 }, name: 'wild_unique', unique: true }] },
        { op: 'createIndexes', collection: `diff_index_${n}`, indexes: [{ key: { '$**': 1 }, name: 'wild_sparse', sparse: true }] }
    ])
    addWithDocs('hashed_list', docs(), null, [
        { op: 'createIndexes', collection: `diff_index_${n}`, indexes: [{ key: { a: 'hashed' }, name: 'a_hashed' }] },
        { op: 'listIndexes', collection: `diff_index_${n}` }
    ])
    addWithDocs('hashed_errors', docs(), null, [
        { op: 'createIndexes', collection: `diff_index_${n}`, indexes: [{ key: { a: 'hashed', b: 'hashed' }, name: 'ab_hashed' }] },
        { op: 'createIndexes', collection: `diff_index_${n}`, indexes: [{ key: { a: 'hashed' }, name: 'a_hashed_unique', unique: true }] }
    ])
    addWithDocs('multikey_compound_unique_sparse', docs(), [
        { key: { tags: 1, a: 1 }, name: 'tags_a_unique_sparse', unique: true, sparse: true }
    ], [
        { op: 'insert', collection: `diff_index_${n}`, documents: [{ _id: 9, tags: ['blue'], a: 10 }] },
        { op: 'insert', collection: `diff_index_${n}`, documents: [{ _id: 10, tags: ['blue', 'green'], a: 20 }] },
        { op: 'insert', collection: `diff_index_${n}`, documents: [{ _id: 11, tags: ['red'], a: 40 }] },
        { op: 'find', collection: `diff_index_${n}`, filter: {}, sort: { _id: 1 } }
    ])
    return entries
}

function buildCursor(seed) {
    const entries = []
    let n = 0
    const docs = () => [
        { _id: 1, v: 'a' },
        { _id: 2, v: 'b' },
        { _id: 3, v: 'c' },
        { _id: 4, v: 'd' },
        { _id: 5, v: 'e' }
    ]
    function add(suffix, steps) {
        const collection = `diff_cursor_${n}`
        entries.push({
            id: `diff.cursor.${suffix}`,
            cluster: 'cursor',
            collection,
            setup: [{ op: 'insert', collection, documents: docs() }],
            steps: steps.map((step) => ({ ...step, collection }))
        })
        n += 1
    }
    add('batch2_once', [
        { op: 'find', filter: {}, sort: { _id: 1 }, batchSize: 2 },
        { op: 'getMore', batchSize: 2, cursorFrom: 0 }
    ])
    add('batch2_drain', [
        { op: 'find', filter: {}, sort: { _id: 1 }, batchSize: 2 },
        { op: 'getMore', batchSize: 2, cursorFrom: 0 },
        { op: 'getMore', batchSize: 2, cursorFrom: 0 }
    ].map((step, index) => ({ ...step, cursorFrom: index === 0 ? undefined : 0 })))
    add('batch1_three', [
        { op: 'find', filter: {}, sort: { _id: 1 }, batchSize: 1 },
        { op: 'getMore', batchSize: 1, cursorFrom: 0 },
        { op: 'getMore', batchSize: 1, cursorFrom: 0 },
        { op: 'getMore', batchSize: 1, cursorFrom: 0 }
    ])
    add('batch10_all', [{ op: 'find', filter: {}, sort: { _id: 1 }, batchSize: 10 }])
    add('limit2_batch1', [
        { op: 'find', filter: {}, sort: { _id: 1 }, limit: 2, batchSize: 1 },
        { op: 'getMore', batchSize: 1, cursorFrom: 0 }
    ])
    add('kill_then_getmore', [
        { op: 'find', filter: {}, sort: { _id: 1 }, batchSize: 2 },
        { op: 'killCursors', cursorsFrom: [0] },
        { op: 'getMore', batchSize: 2, cursorFrom: 0 }
    ])
    add('getmore_unknown', [{ op: 'getMore', batchSize: 2, id: { $numberLong: '999' } }])
    add('default_batch', [{ op: 'find', filter: {}, sort: { _id: 1 } }])
    return entries
}

function buildFindAndModify(seed) {
    const entries = []
    let n = 0
    const docs = () => [
        { _id: 1, name: 'alpha', score: 10, grp: 'a' },
        { _id: 2, name: 'beta', score: 20, grp: 'a' },
        { _id: 3, name: 'gamma', score: 30, grp: 'b' },
        { _id: 4, name: 'delta', score: 40, grp: 'b' },
        { _id: 5, name: 'epsilon', score: 50, grp: 'c' }
    ]
    function add(suffix, steps) {
        const collection = `diff_famod_${n}`
        entries.push({
            id: `diff.findAndModify.${suffix}`,
            cluster: 'findAndModify',
            collection,
            setup: [{ op: 'insert', collection, documents: docs() }],
            steps: steps.map((step) => ({ ...step, collection }))
        })
        n += 1
    }
    add('update_old', [{ op: 'findAndModify', query: { _id: 1 }, update: { $set: { score: 11 } } }])
    add('update_new', [{ op: 'findAndModify', query: { _id: 1 }, update: { $set: { score: 11 } }, new: true }])
    add('update_inc', [{ op: 'findAndModify', query: { _id: 2 }, update: { $inc: { score: 5 } }, new: true }])
    add('fields_include', [
        { op: 'findAndModify', query: { _id: 3 }, update: { $set: { score: 31 } }, fields: { name: 1, score: 1 }, new: true }
    ])
    add('fields_exclude', [
        { op: 'findAndModify', query: { _id: 4 }, update: { $set: { score: 41 } }, fields: { grp: 0 }, new: true }
    ])
    add('sort_desc', [
        { op: 'findAndModify', query: { grp: 'a' }, sort: { score: -1 }, update: { $set: { picked: true } }, new: true }
    ])
    add('sort_asc_fields', [
        { op: 'findAndModify', query: { grp: 'b' }, sort: { score: 1 }, update: { $set: { picked: true } }, fields: { score: 1 } }
    ])
    add('no_match', [{ op: 'findAndModify', query: { _id: 99 }, update: { $set: { name: 'nobody' } } }])
    add('upsert_new', [
        { op: 'findAndModify', query: { _id: 99 }, update: { $set: { score: 7 } }, upsert: true, new: true },
        { op: 'find', filter: { _id: 99 } }
    ])
    add('upsert_old_null', [
        { op: 'findAndModify', query: { _id: 98 }, update: { $set: { score: 8 } }, upsert: true }
    ])
    add('upsert_equality_fields', [
        { op: 'findAndModify', query: { name: 'zeta' }, update: { $set: { score: 9 } }, upsert: true, new: true }
    ])
    add('upsert_replacement', [
        { op: 'findAndModify', query: { _id: 97 }, update: { score: 5, grp: 'z' }, upsert: true, new: true }
    ])
    add('remove_old', [{ op: 'findAndModify', query: { _id: 3 }, remove: true }, { op: 'find', filter: { _id: 3 } }])
    add('remove_no_match', [{ op: 'findAndModify', query: { _id: 99 }, remove: true }])
    add('remove_fields', [{ op: 'findAndModify', query: { _id: 4 }, remove: true, fields: { grp: 1 } }])
    add('error_update_and_remove', [
        { op: 'findAndModify', query: { _id: 1 }, update: { $set: { score: 1 } }, remove: true }
    ])
    add('error_remove_new', [{ op: 'findAndModify', query: { _id: 1 }, remove: true, new: true }])
    add('error_missing_update', [{ op: 'findAndModify', query: { _id: 1 } }])
    return entries
}

function buildDistinct(seed) {
    const entries = []
    let n = 0
    const docs = () => [
        { _id: 1, tags: ['red', 'blue'], a: { b: 1 }, items: [{ qty: 2 }, { qty: 5 }], grp: 'a' },
        { _id: 2, tags: ['blue', 'red'], a: { b: 2 }, items: [{ qty: 2 }], grp: 'b' },
        { _id: 3, tags: [], a: { b: 3 }, items: [], grp: 'a' },
        { _id: 4, tags: 'green', grp: 'b' },
        { _id: 5, a: { b: 1 }, grp: 'a' }
    ]
    function add(suffix, steps, collectionDocs = docs()) {
        const collection = `diff_distinct_${n}`
        entries.push({
            id: `diff.distinct.${suffix}`,
            cluster: 'distinct',
            collection,
            setup: [{ op: 'insert', collection, documents: collectionDocs }],
            steps: steps.map((step) => ({ ...step, collection }))
        })
        n += 1
    }
    add('array_flatten', [{ op: 'distinct', key: 'tags' }])
    add('array_reversed', [
        { op: 'distinct', key: 'tags' },
        { op: 'find', filter: { _id: 2 }, projection: { tags: 1 } }
    ])
    add('nested_path', [{ op: 'distinct', key: 'a.b' }])
    add('missing_key', [{ op: 'distinct', key: 'ghost' }])
    add('query_filter', [{ op: 'distinct', key: 'tags', query: { grp: 'a' } }])
    add('query_no_match', [{ op: 'distinct', key: 'tags', query: { grp: 'z' } }])
    add('dotted_into_array', [{ op: 'distinct', key: 'items.qty' }])
    add('empty_and_scalar', [{ op: 'distinct', key: 'items' }])
    add('numeric_equivalence', [{ op: 'distinct', key: 'v' }], [
        { _id: 1, v: 1 },
        { _id: 2, v: { $numberDouble: '1.0' } },
        { _id: 3, v: { $numberLong: '1' } },
        { _id: 4, v: { $numberDouble: '2.5' } }
    ])
    add('nested_arrays', [{ op: 'distinct', key: 'n' }], [
        { _id: 1, n: [[1, 2], [3]] },
        { _id: 2, n: [[2], 4] }
    ])
    add('bad_key_type', [{ op: 'distinct', key: 5 }])
    return entries
}

function buildBulkWrite(seed) {
    const entries = []
    let n = 0
    const docs = () => [
        { _id: 1, score: 10, grp: 'a' },
        { _id: 2, score: 20, grp: 'a' },
        { _id: 3, score: 30, grp: 'b' }
    ]
    function add(suffix, steps, setupDocs = docs()) {
        const collection = `diff_bulk_${n}`
        const nsInfo = [{ ns: `${DB}.${collection}` }]
        entries.push({
            id: `diff.bulkWrite.${suffix}`,
            cluster: 'bulkWrite',
            collection,
            setup: setupDocs.length > 0 ? [{ op: 'insert', collection, documents: setupDocs }] : [],
            steps: steps.map((step) => ({ collection, nsInfo, ...step }))
        })
        n += 1
    }
    add('insert_single', [{ op: 'bulkWrite', ops: [{ insert: 0, document: { _id: 10, score: 100 } }] }])
    add('insert_batch', [
        { op: 'bulkWrite', ops: [{ insert: 0, document: { _id: 11, score: 110 } }, { insert: 0, document: { _id: 12, score: 120 } }] },
        { op: 'find', filter: { _id: { $gte: 11 } }, sort: { _id: 1 } }
    ])
    add('mixed_ops', [
        { op: 'bulkWrite', ops: [
            { insert: 0, document: { _id: 4, score: 40 } },
            { update: 0, filter: { _id: 1 }, updateMods: { $inc: { score: 1 } } },
            { delete: 0, filter: { _id: 3 } }
        ] },
        { op: 'find', filter: {}, sort: { _id: 1 } }
    ])
    add('update_multi', [
        { op: 'bulkWrite', ops: [{ update: 0, filter: { grp: 'a' }, updateMods: { $set: { flag: true } }, multi: true }] },
        { op: 'find', filter: {}, sort: { _id: 1 } }
    ])
    add('update_no_match', [
        { op: 'bulkWrite', ops: [{ update: 0, filter: { _id: 99 }, updateMods: { $set: { flag: true } } }] }
    ])
    add('upsert_missing', [{ op: 'bulkWrite', ops: [{ update: 0, filter: { _id: 7 }, updateMods: { $set: { score: 70 } }, upsert: true }] }])
    add('upsert_match_existing', [
        { op: 'bulkWrite', ops: [{ update: 0, filter: { _id: 2 }, updateMods: { $set: { score: 21 } }, upsert: true }] }
    ])
    add('ordered_duplicate_stops', [
        { op: 'bulkWrite', ordered: true, ops: [
            { insert: 0, document: { _id: 1 } },
            { insert: 0, document: { _id: 20 } },
            { insert: 0, document: { _id: 21 } }
        ] }
    ])
    add('unordered_continues', [
        { op: 'bulkWrite', ordered: false, ops: [
            { insert: 0, document: { _id: 1 } },
            { insert: 0, document: { _id: 20 } },
            { update: 0, filter: { _id: 2 }, updateMods: { $set: { score: 21 } } },
            { delete: 0, filter: { _id: 3 } }
        ] },
        { op: 'find', filter: {}, sort: { _id: 1 } }
    ])
    add('errors_only', [
        { op: 'bulkWrite', ordered: false, errorsOnly: true, ops: [
            { insert: 0, document: { _id: 1 } },
            { insert: 0, document: { _id: 30 } }
        ] }
    ])
    add('delete_many', [
        { op: 'bulkWrite', ops: [{ delete: 0, filter: { grp: 'a' }, multi: true }] },
        { op: 'find', filter: {}, sort: { _id: 1 } }
    ])
    add('bad_namespace_index', [{ op: 'bulkWrite', ops: [{ insert: 1, document: { _id: 5 } }] }])
    add('empty_ops', [{ op: 'bulkWrite', ops: [] }])
    add('not_admin', [{ op: 'bulkWrite', db: DB, ops: [{ insert: 0, document: { _id: 6 } }] }])
    add('duplicate_after_failure_order', [
        { op: 'bulkWrite', ordered: false, ops: [
            { insert: 0, document: { _id: 2 } },
            { insert: 0, document: { _id: 40 } },
            { insert: 0, document: { _id: 2 } }
        ] }
    ])
    return entries
}

const VALIDATOR_SCHEMA = {
    $jsonSchema: {
        bsonType: 'object',
        required: ['name'],
        properties: {
            _id: { bsonType: 'int' },
            name: { bsonType: 'string' },
            age: { bsonType: 'int', minimum: 0, maximum: 120 },
            tags: { bsonType: 'array', items: { bsonType: 'string' } }
        },
        additionalProperties: false
    }
}

function buildValidators(seed) {
    const entries = []
    let n = 0
    function add(suffix, setup, steps) {
        const collection = `diff_valid_${n}`
        entries.push({
            id: `diff.validators.${suffix}`,
            cluster: 'validators',
            collection,
            setup: setup.map((step) => ({ ...step, collection })),
            steps: steps.map((step) => ({ ...step, collection }))
        })
        n += 1
    }
    add('create_then_valid_insert', [
        { op: 'create', validator: VALIDATOR_SCHEMA }
    ], [
        { op: 'insert', documents: [{ _id: 1, name: 'alpha', age: 30 }] },
        { op: 'find', filter: {} }
    ])
    add('missing_required', [
        { op: 'create', validator: VALIDATOR_SCHEMA }
    ], [{ op: 'insert', documents: [{ _id: 2, other: 1 }] }])
    add('wrong_type', [
        { op: 'create', validator: VALIDATOR_SCHEMA }
    ], [{ op: 'insert', documents: [{ _id: 3, name: 5 }] }])
    add('below_minimum', [
        { op: 'create', validator: VALIDATOR_SCHEMA }
    ], [{ op: 'insert', documents: [{ _id: 4, name: 'beta', age: -1 }] }])
    add('above_maximum', [
        { op: 'create', validator: VALIDATOR_SCHEMA }
    ], [{ op: 'insert', documents: [{ _id: 5, name: 'gamma', age: 200 }] }])
    add('item_type', [
        { op: 'create', validator: VALIDATOR_SCHEMA }
    ], [{ op: 'insert', documents: [{ _id: 6, name: 'delta', tags: ['ok', 2] }] }])
    add('additional_property', [
        { op: 'create', validator: VALIDATOR_SCHEMA }
    ], [{ op: 'insert', documents: [{ _id: 7, name: 'epsilon', extra: 1 }] }])
    add('additional_property_without_id_declared', [
        { op: 'create', validator: { $jsonSchema: { bsonType: 'object', required: ['name'], properties: { name: { bsonType: 'string' } } } } }
    ], [{ op: 'insert', documents: [{ _id: 8, name: 'zeta' }] }])
    add('update_to_invalid', [
        { op: 'create', validator: VALIDATOR_SCHEMA },
        { op: 'insert', documents: [{ _id: 9, name: 'eta', age: 30 }] }
    ], [{ op: 'update', updates: [{ q: { _id: 9 }, u: { $set: { age: 300 } } }] }])
    add('create_duplicate', [
        { op: 'create', validator: VALIDATOR_SCHEMA }
    ], [{ op: 'create', validator: VALIDATOR_SCHEMA }])
    add('warn_action_allows_write', [
        { op: 'create', validator: VALIDATOR_SCHEMA, validationAction: 'warn' }
    ], [
        { op: 'insert', documents: [{ _id: 10, name: 5 }] },
        { op: 'find', filter: {} }
    ])
    add('collmod_action_off_then_write', [
        { op: 'create', validator: VALIDATOR_SCHEMA, validationAction: 'error' },
        { op: 'collMod', validationAction: 'warn' }
    ], [
        { op: 'insert', documents: [{ _id: 11, name: 6 }] },
        { op: 'collMod', validationLevel: 'off' },
        { op: 'insert', documents: [{ _id: 12, name: 7 }] }
    ])
    add('moderate_skips_existing_invalid', [
        { op: 'create', validator: VALIDATOR_SCHEMA, validationLevel: 'off' },
        { op: 'insert', documents: [{ _id: 13, name: 'theta' }, { _id: 14, name: 5 }] },
        { op: 'collMod', validationLevel: 'moderate' }
    ], [
        { op: 'update', updates: [{ q: { _id: 14 }, u: { $set: { name: 8 } } }] }
    ])
    add('moderate_blocks_valid_to_invalid', [
        { op: 'create', validator: VALIDATOR_SCHEMA, validationLevel: 'off' },
        { op: 'insert', documents: [{ _id: 15, name: 'iota' }] },
        { op: 'collMod', validationLevel: 'moderate' }
    ], [{ op: 'update', updates: [{ q: { _id: 15 }, u: { $set: { name: 9 } } }] }])
    add('collmod_missing_namespace', [], [{ op: 'collMod', validationLevel: 'off' }])
    add('collmod_validator_replaces', [
        { op: 'create', validator: { $jsonSchema: { bsonType: 'object', required: ['name'], properties: { name: { bsonType: 'string' } } } } }
    ], [
        { op: 'collMod', validator: { $jsonSchema: { bsonType: 'object', required: ['code'], properties: { code: { bsonType: 'int' } } } } },
        { op: 'insert', documents: [{ _id: 16, name: 'kappa' }] },
        { op: 'insert', documents: [{ _id: 17, code: 7 }] }
    ])
    return entries
}

function buildListCollections(seed) {
    const entries = []
    let n = 0
    function add(suffix, setup, steps) {
        const collection = `diff_list_${n}`
        entries.push({
            id: `diff.listCollections.${suffix}`,
            cluster: 'listCollections',
            collection,
            setup: setup.map((step) => ({ ...step, collection })),
            steps: [{ collection, ...steps[0] }, ...steps.slice(1)]
        })
        n += 1
    }
    add('default_shape', [
        { op: 'create' },
        { op: 'insert', documents: [{ _id: 1 }, { _id: 2 }] }
    ], [{ op: 'listCollections', filter: { name: `diff_list_${n}` } }])
    add('name_only', [
        { op: 'insert', documents: [{ _id: 1 }] }
    ], [{ op: 'listCollections', nameOnly: true, filter: { name: `diff_list_${n}` } }])
    add('authorized_true', [
        { op: 'insert', documents: [{ _id: 1 }] }
    ], [{ op: 'listCollections', nameOnly: true, authorizedCollections: true, filter: { name: `diff_list_${n}` } }])
    add('filter_type_gt', [
        { op: 'insert', documents: [{ _id: 1 }] }
    ], [{
        op: 'listCollections',
        nameOnly: true,
        // Bound the range to this exact name so other collections in the
        // database cannot leak into the batch.
        filter: {
            type: 'collection',
            $and: [{ name: { $gte: `diff_list_${n}` } }, { name: { $lt: `diff_list_${n}z` } }]
        }
    }])
    add('filter_no_match', [
        { op: 'insert', documents: [{ _id: 1 }] }
    ], [{ op: 'listCollections', filter: { name: 'definitely-not-present' } }])
    add('bad_name_only_type', [
        { op: 'insert', documents: [{ _id: 1 }] }
    ], [{ op: 'listCollections', nameOnly: 1 }])
    add('bad_authorized_type', [
        { op: 'insert', documents: [{ _id: 1 }] }
    ], [{ op: 'listCollections', authorizedCollections: 'yes' }])
    add('options_after_collmod', [
        { op: 'create', validator: VALIDATOR_SCHEMA },
        { op: 'collMod', validationLevel: 'moderate', validationAction: 'warn' }
    ], [{ op: 'listCollections', filter: { name: `diff_list_${n}` } }])
    return entries
}

function buildCountExplain(seed) {
    const entries = []
    let n = 0
    const docs = () => [
        { _id: 1, grp: 'a', v: 1 },
        { _id: 2, grp: 'a', v: 2 },
        { _id: 3, grp: 'b', v: 3 },
        { _id: 4, grp: 'b', v: 4 },
        { _id: 5, grp: 'c', v: 5 }
    ]
    function add(suffix, steps) {
        const collection = `diff_count_${n}`
        entries.push({
            id: `diff.count.${suffix}`,
            cluster: 'count',
            collection,
            setup: [{ op: 'insert', collection, documents: docs() }],
            steps: steps.map((step) => {
                if (step.op !== 'explain') return { ...step, collection }
                const inner = { ...step.explain }
                for (const key of ['find', 'count']) if (inner[key] !== undefined) inner[key] = collection
                return { ...step, explain: inner, collection }
            })
        })
        n += 1
    }
    add('query_skip_limit', [
        { op: 'count', query: { grp: { $in: ['a', 'b'] } }, skip: 2, limit: 2 },
        { op: 'count', query: { grp: 'a' } }
    ])
    add('skip_negative', [{ op: 'count', skip: { $numberInt: '-1' } }])
    add('limit_negative', [{ op: 'count', limit: { $numberInt: '-2' } }])
    add('skip_beyond', [{ op: 'count', skip: 9 }])
    add('explain_find_planner', [
        { op: 'explain', explain: { find: 'items', filter: { grp: 'a' } }, verbosity: 'queryPlanner' }
    ])
    add('explain_count_planner', [
        { op: 'explain', explain: { count: 'items', query: { grp: 'a' }, skip: 1, limit: 2 }, verbosity: 'queryPlanner' }
    ])
    add('explain_find_stats', [
        { op: 'explain', explain: { find: 'items', filter: { grp: 'a' }, skip: 1, limit: 2 }, verbosity: 'executionStats' }
    ])
    add('explain_count_stats', [
        { op: 'explain', explain: { count: 'items', query: { grp: 'a' }, skip: 1, limit: 2 }, verbosity: 'executionStats' }
    ])
    add('explain_all_plans', [
        { op: 'explain', explain: { find: 'items', filter: { grp: 'a' } }, verbosity: 'allPlansExecution' }
    ])
    add('explain_bad_verbosity', [
        { op: 'explain', explain: { find: 'items' }, verbosity: 'bogus' }
    ])
    return entries
}

// `hint` against `mongod 8.0.9`: valid, natural, error and plan-shape cases.
//
// Every case uses the same four documents and two indexes unless a case needs
// different index options. `explain` entries compare the whole reply with the
// server's own plan, including `indexBounds`, `direction` and executionStats.
function buildHint(seed) {
    let n = 0
    const entries = []
    const baseDocuments = () => [
        { _id: 1, a: 10, b: 'x' },
        { _id: 2, a: 20, b: 'y' },
        { _id: 3, a: 30, b: 'x' },
        { _id: 4, a: 40, b: 'z' }
    ]
    const baseIndexes = () => [
        { key: { a: 1 }, name: 'a_1' },
        { key: { b: 1, a: 1 }, name: 'ba' }
    ]
    function add(suffix, steps, options = {}) {
        const collection = `diff_hint_${n}`
        entries.push({
            id: `diff.hint.${suffix}`,
            cluster: 'hint',
            collection,
            setup: [
                { op: 'insert', collection, documents: options.documents ?? baseDocuments() },
                { op: 'createIndexes', collection, indexes: options.indexes ?? baseIndexes() }
            ],
            steps: steps.map((step) => {
                if (step.op !== 'explain') return { ...step, collection }
                const inner = { ...step.explain }
                for (const key of ['find', 'count']) if (inner[key] !== undefined) inner[key] = collection
                return { ...step, explain: inner, collection }
            })
        })
        n += 1
    }
    const explain = (inner, verbosity) => ({ op: 'explain', explain: inner, verbosity })

    add('planner_eq', [explain({ find: 'items', filter: { a: 10 }, hint: 'a_1' }, 'queryPlanner')])
    add('planner_empty', [explain({ find: 'items', filter: {}, hint: 'a_1' }, 'queryPlanner')])
    add('planner_range_forward', [explain({ find: 'items', filter: { a: { $gte: 20 } }, hint: 'a_1' }, 'queryPlanner')])
    add('planner_range_backward', [
        explain({ find: 'items', filter: { a: { $gte: 20 } }, sort: { a: -1 }, hint: 'a_1' }, 'queryPlanner')
    ])
    add('planner_residual', [explain({ find: 'items', filter: { a: 10, b: 'x' }, hint: 'a_1' }, 'queryPlanner')])
    add('planner_compound', [explain({ find: 'items', filter: { a: 10, b: 'x' }, hint: 'ba' }, 'queryPlanner')])
    add('planner_sort', [explain({ find: 'items', filter: { a: 10 }, sort: { _id: 1 }, hint: 'a_1' }, 'queryPlanner')])
    add(
        'planner_multikey',
        [explain({ find: 'items', filter: { a: 1 }, hint: 'a_1' }, 'queryPlanner')],
        {
            documents: [
                { _id: 1, a: [1, 2], b: 'x' },
                { _id: 2, a: [3], b: 'y' }
            ],
            indexes: [{ key: { a: 1 }, name: 'a_1' }]
        }
    )
    add(
        'planner_unique',
        [explain({ find: 'items', filter: { a: 10 }, hint: 'u' }, 'queryPlanner')],
        {
            documents: [
                { _id: 1, a: 10 },
                { _id: 2, a: 20 },
                { _id: 3, a: 30 }
            ],
            indexes: [{ key: { a: 1 }, name: 'u', unique: true }]
        }
    )
    add(
        'planner_sparse',
        [explain({ find: 'items', filter: { b: 1 }, hint: 'sp' }, 'queryPlanner')],
        {
            documents: [
                { _id: 1, b: 1 },
                { _id: 2, b: 2 },
                { _id: 3, c: 1 }
            ],
            indexes: [{ key: { b: 1 }, name: 'sp', sparse: true }]
        }
    )
    const partialOptions = {
        documents: [
            { _id: 1, c: 10 },
            { _id: 2, c: 1 }
        ],
        indexes: [{ key: { c: 1 }, name: 'p', partialFilterExpression: { c: { $gt: 5 } } }]
    }
    add('planner_partial', [explain({ find: 'items', filter: { c: 10 }, hint: 'p' }, 'queryPlanner')], partialOptions)
    add('planner_partial_outside', [explain({ find: 'items', filter: { c: 1 }, hint: 'p' }, 'queryPlanner')], partialOptions)

    add('stats_eq', [explain({ find: 'items', filter: { a: 10 }, hint: 'a_1' }, 'executionStats')])
    add('stats_limit', [
        explain({ find: 'items', filter: { b: 'x' }, limit: 2, hint: 'ba' }, 'executionStats')
    ])
    add('stats_skip', [explain({ find: 'items', filter: { a: { $gte: 20 } }, skip: 1, hint: 'a_1' }, 'executionStats')])
    add('count_planner', [explain({ count: 'items', query: { a: 10 }, hint: 'a_1' }, 'queryPlanner')])
    add('count_stats', [explain({ count: 'items', query: { a: 10 }, hint: 'a_1' }, 'executionStats')])
    add('count_skip_stats', [
        explain({ count: 'items', query: { a: { $gte: 20 } }, skip: 1, limit: 1, hint: 'a_1' }, 'executionStats')
    ])
    add('count_residual_stats', [
        explain({ count: 'items', query: { a: 10, b: 'x' }, hint: 'a_1' }, 'executionStats')
    ])
    add('natural_find', [{ op: 'find', filter: {}, hint: { $natural: -1 } }])
    add('natural_planner', [explain({ find: 'items', filter: { a: 10 }, hint: { $natural: -1 } }, 'queryPlanner')])
    add('natural_count_stats', [explain({ count: 'items', query: { a: 10 }, hint: { $natural: 1 } }, 'executionStats')])
    add('errors', [
        { op: 'find', filter: { a: 10 }, hint: 'ghost' },
        { op: 'find', filter: { a: 10 }, hint: '$natural' },
        { op: 'find', filter: { a: 10 }, hint: null },
        { op: 'find', filter: { a: 10 }, hint: 5 },
        { op: 'find', filter: { a: 10 }, hint: { a: 1, b: 1 } },
        { op: 'find', filter: { a: 10 }, hint: { a: -1 } },
        { op: 'find', filter: { b: 'x' }, sort: { a: -1 }, projection: { _id: 1, a: 1 }, hint: 'ghost' },
        { op: 'count', query: { a: 10 }, skip: 1, limit: 2, hint: 'ghost' },
        { op: 'find', filter: { a: 10 }, hint: {} },
        { op: 'find', filter: { a: 10 }, hint: { $natural: 0 } }
    ])
    add(
        'hidden_hint',
        [{ op: 'find', filter: { b: 'x' }, hint: 'h' }],
        {
            indexes: [...baseIndexes(), { key: { b: 1 }, name: 'h', hidden: true }]
        }
    )
    entries.push({
        id: 'diff.hint.missing_namespace',
        cluster: 'hint',
        collection: 'diff_hint_missing',
        setup: [],
        steps: [{ op: 'find', collection: 'diff_hint_missing', filter: { a: 10 }, hint: 'a_1' }]
    })
    return entries
}

// Remaining aggregation stages: `$graphLookup`, `$replaceWith`/`$set`,
// `$merge` and `$out`. `mongod 8.0.9` does not define the order of
// `$graphLookup` arrays, so those entries assert `$size` or single-element
// chains instead.
function buildRemainingStages(seed) {
    const entries = []
    const errors = (steps) => steps
    const chain = [
        { _id: 1, name: 'a', next: 'b' },
        { _id: 2, name: 'b', next: 'c' },
        { _id: 3, name: 'c', next: null }
    ]
    entries.push({
        id: 'graph_maxdepth0',
        setup: [{ op: 'insert', collection: 'gl', documents: chain }],
        steps: [
            {
                op: 'aggregate',
                collection: 'gl',
                pipeline: [
                    { $match: { _id: 1 } },
                    {
                        $graphLookup: {
                            from: 'gl',
                            startWith: '$next',
                            connectFromField: 'next',
                            connectToField: 'name',
                            as: 'chain',
                            maxDepth: 0,
                            depthField: 'd'
                        }
                    },
                    { $project: { _id: 1, chain: 1 } }
                ]
            },
            {
                op: 'aggregate',
                collection: 'gl',
                pipeline: [
                    { $match: { _id: 1 } },
                    {
                        $graphLookup: {
                            from: 'gl',
                            startWith: '$name',
                            connectFromField: 'next',
                            connectToField: 'name',
                            as: 'nested.chain',
                            maxDepth: 0
                        }
                    }
                ]
            }
        ]
    })
    entries.push({
        id: 'graph_sizes',
        setup: [{ op: 'insert', collection: 'gl2', documents: chain }],
        steps: [
            {
                op: 'aggregate',
                collection: 'gl2',
                pipeline: [
                    { $match: { _id: 1 } },
                    {
                        $graphLookup: {
                            from: 'gl2',
                            startWith: '$name',
                            connectFromField: 'next',
                            connectToField: 'name',
                            as: 'chain'
                        }
                    },
                    { $project: { _id: 1, n: { $size: '$chain' } } }
                ]
            },
            {
                op: 'aggregate',
                collection: 'gl2',
                pipeline: [
                    { $match: { _id: 1 } },
                    {
                        $graphLookup: {
                            from: 'gl2',
                            startWith: '$name',
                            connectFromField: 'next',
                            connectToField: 'name',
                            as: 'chain',
                            maxDepth: 1
                        }
                    },
                    { $project: { _id: 1, n: { $size: '$chain' } } }
                ]
            },
            {
                op: 'aggregate',
                collection: 'gl2',
                pipeline: [
                    { $match: { _id: 1 } },
                    {
                        $graphLookup: {
                            from: 'nope',
                            startWith: '$name',
                            connectFromField: 'next',
                            connectToField: 'name',
                            as: 'chain'
                        }
                    },
                    { $project: { _id: 1, n: { $size: '$chain' } } }
                ]
            }
        ]
    })
    entries.push({
        id: 'graph_restrict',
        setup: [
            {
                op: 'insert',
                collection: 'gr',
                documents: [
                    { _id: 1, name: 'a', next: 'b', dept: 'x' },
                    { _id: 2, name: 'b', next: 'c', dept: 'y' },
                    { _id: 3, name: 'c', next: null, dept: 'x' }
                ]
            }
        ],
        steps: [
            {
                op: 'aggregate',
                collection: 'gr',
                pipeline: [
                    { $match: { _id: 1 } },
                    {
                        $graphLookup: {
                            from: 'gr',
                            startWith: '$next',
                            connectFromField: 'next',
                            connectToField: 'name',
                            as: 'chain',
                            restrictSearchWithMatch: { dept: 'y' }
                        }
                    },
                    { $project: { _id: 1, n: { $size: '$chain' } } }
                ]
            },
            {
                op: 'aggregate',
                collection: 'gr',
                pipeline: [
                    { $match: { _id: 1 } },
                    {
                        $graphLookup: {
                            from: 'gr',
                            startWith: '$next',
                            connectFromField: 'next',
                            connectToField: 'name',
                            as: 'chain',
                            restrictSearchWithMatch: { dept: 'x' },
                            maxDepth: 1
                        }
                    },
                    { $project: { _id: 1, n: { $size: '$chain' } } }
                ]
            }
        ]
    })
    entries.push({
        id: 'graph_cycle',
        setup: [
            {
                op: 'insert',
                collection: 'gc',
                documents: [
                    { _id: 1, name: 'a', next: 'b' },
                    { _id: 2, name: 'b', next: 'a' }
                ]
            }
        ],
        steps: [
            {
                op: 'aggregate',
                collection: 'gc',
                pipeline: [
                    { $match: { _id: 1 } },
                    {
                        $graphLookup: {
                            from: 'gc',
                            startWith: '$name',
                            connectFromField: 'next',
                            connectToField: 'name',
                            as: 'chain'
                        }
                    },
                    { $project: { _id: 1, n: { $size: '$chain' } } }
                ]
            }
        ]
    })
    entries.push({
        id: 'graph_start_array',
        setup: [
            {
                op: 'insert',
                collection: 'ga',
                documents: [
                    { _id: 1, keys: ['a', 'b'], tag: 'x' },
                    { _id: 2, name: 'a', tag: 'x', link: 'z' },
                    { _id: 3, name: 'b', tag: 'y', link: 'z' },
                    { _id: 4, name: 'z', tag: 'x', link: null }
                ]
            }
        ],
        steps: [
            {
                op: 'aggregate',
                collection: 'ga',
                pipeline: [
                    { $match: { _id: 1 } },
                    {
                        $graphLookup: {
                            from: 'ga',
                            startWith: '$keys',
                            connectFromField: 'link',
                            connectToField: 'name',
                            as: 'chain'
                        }
                    },
                    { $project: { _id: 1, n: { $size: '$chain' } } }
                ]
            },
            {
                op: 'aggregate',
                collection: 'ga',
                pipeline: [
                    { $match: { _id: 1 } },
                    {
                        $graphLookup: {
                            from: 'ga',
                            startWith: '$keys',
                            connectFromField: 'link',
                            connectToField: 'name',
                            as: 'chain',
                            restrictSearchWithMatch: { tag: 'x' }
                        }
                    },
                    { $project: { _id: 1, n: { $size: '$chain' } } }
                ]
            }
        ]
    })
    entries.push({
        id: 'graph_errors',
        setup: [{ op: 'insert', collection: 'ge', documents: chain }],
        steps: errors([
            { op: 'aggregate', collection: 'ge', pipeline: [{ $graphLookup: { from: 'ge', startWith: '$name', connectFromField: 'next', connectToField: 'name' } }] },
            { op: 'aggregate', collection: 'ge', pipeline: [{ $match: { _id: 1 } }, { $graphLookup: { from: 'ge', startWith: '$name', connectFromField: 'next', connectToField: 'name', as: 'chain', maxDepth: -2 } }] },
            { op: 'aggregate', collection: 'ge', pipeline: [{ $match: { _id: 1 } }, { $graphLookup: { from: 'ge', startWith: '$name', connectFromField: 'next', connectToField: 'name', as: 'chain', maxDepth: 1.5 } }] },
            { op: 'aggregate', collection: 'ge', pipeline: [{ $match: { _id: 1 } }, { $graphLookup: { from: 'ge', startWith: '$name', connectFromField: 'next', connectToField: 'name', as: 'chain', restrictSearchWithMatch: { $where: 'true' } } }] }
        ])
    })

    const replaceSource = [
        { _id: 1, a: 1, b: 2, sub: { c: 3 } },
        { _id: 2, a: 4, b: 5, sub: { c: 6 } }
    ]
    entries.push({
        id: 'replace_with',
        setup: [{ op: 'insert', collection: 'rw', documents: replaceSource }],
        steps: [
            { op: 'aggregate', collection: 'rw', pipeline: [{ $sort: { _id: 1 } }, { $replaceWith: { x: '$a', y: '$b' } }] },
            { op: 'aggregate', collection: 'rw', pipeline: [{ $sort: { _id: 1 } }, { $replaceWith: { _id: '$_id', nested: { v: '$a' } } }] },
            { op: 'aggregate', collection: 'rw', pipeline: [{ $sort: { _id: 1 } }, { $replaceWith: '$sub' }] },
            { op: 'aggregate', collection: 'rw', pipeline: [{ $sort: { _id: 1 } }, { $replaceWith: { a: '$a', ghost: '$missing' } }] },
            { op: 'aggregate', collection: 'rw', pipeline: [{ $sort: { _id: 1 } }, { $replaceWith: {} }] }
        ]
    })
    entries.push({
        id: 'replace_errors',
        setup: [{ op: 'insert', collection: 're', documents: replaceSource }],
        steps: errors([
            { op: 'aggregate', collection: 're', pipeline: [{ $replaceWith: 'plain' }] },
            { op: 'aggregate', collection: 're', pipeline: [{ $replaceWith: 5 }] },
            { op: 'aggregate', collection: 're', pipeline: [{ $replaceWith: null }] },
            { op: 'aggregate', collection: 're', pipeline: [{ $replaceWith: [] }] }
        ])
    })
    entries.push({
        id: 'set_alias',
        setup: [{ op: 'insert', collection: 'sa', documents: replaceSource }],
        steps: [
            { op: 'aggregate', collection: 'sa', pipeline: [{ $sort: { _id: 1 } }, { $set: { c: { $add: ['$a', '$b'] }, z: 1 } }] },
            { op: 'aggregate', collection: 'sa', pipeline: [{ $sort: { _id: 1 } }, { $set: { 'a.b': 1 } }] },
            { op: 'aggregate', collection: 'sa', pipeline: [{ $sort: { _id: 1 } }, { $set: {} }] }
        ]
    })

    const mergeSource = [
        { _id: 1, a: 10, b: 1, src: true },
        { _id: 2, a: 20, b: 2, src: true },
        { _id: 3, a: 30, b: 3, src: true }
    ]
    const mergeTarget = [
        { _id: 1, a: 10, b: 1, tag: 'old' },
        { _id: 9, a: 99, b: 9, tag: 'only' }
    ]
    const mergeSetup = (source, target, indexes = [{ key: { a: 1 }, name: 'a_1', unique: true }]) => [
        { op: 'insert', collection: `${source}`, documents: mergeSource },
        { op: 'insert', collection: `${target}`, documents: mergeTarget },
        ...(indexes.length ? [{ op: 'createIndexes', collection: target, indexes }] : [])
    ]
    const mergeThenFind = (id, source, target, specification, indexes) => ({
        id,
        setup: mergeSetup(source, target, indexes),
        steps: [
            { op: 'aggregate', collection: source, pipeline: [{ $merge: specification }] },
            { op: 'find', collection: target, filter: {}, sort: { _id: 1 } }
        ]
    })
    entries.push(mergeThenFind('merge_default', 'n1', 'n1_t', { into: 'n1_t', on: 'a' }))
    entries.push(
        mergeThenFind('merge_replace_discard', 'n2', 'n2_t', {
            into: 'n2_t',
            on: 'a',
            whenMatched: 'replace',
            whenNotMatched: 'discard'
        })
    )
    entries.push(
        mergeThenFind('merge_keep_existing', 'n3', 'n3_t', {
            into: 'n3_t',
            on: 'a',
            whenMatched: 'keepExisting',
            whenNotMatched: 'insert'
        })
    )
    entries.push({
        id: 'merge_pipeline',
        setup: mergeSetup('n4', 'n4_t'),
        steps: [
            {
                op: 'aggregate',
                collection: 'n4',
                pipeline: [{ $merge: { into: 'n4_t', on: 'a', whenMatched: [{ $set: { tag: 'piped' } }], whenNotMatched: 'discard' } }]
            },
            { op: 'find', collection: 'n4_t', filter: {}, sort: { _id: 1 } },
            {
                op: 'aggregate',
                collection: 'n4',
                pipeline: [{ $merge: { into: 'n4_t', on: 'a', whenMatched: [{ $unset: ['tag'] }], whenNotMatched: 'discard' } }]
            },
            { op: 'find', collection: 'n4_t', filter: {}, sort: { _id: 1 } },
            {
                op: 'aggregate',
                collection: 'n4',
                pipeline: [
                    { $merge: { into: 'n4_t', on: 'a', whenMatched: [{ $replaceWith: { a: '$a', b: '$b' } }], whenNotMatched: 'discard' } }
                ]
            },
            { op: 'find', collection: 'n4_t', filter: {}, sort: { _id: 1 } }
        ]
    })
    entries.push(
        mergeThenFind('merge_compound', 'n5', 'n5_t', { into: 'n5_t', on: ['a', 'b'], whenMatched: 'merge', whenNotMatched: 'discard' }, [
            { key: { a: 1, b: 1 }, name: 'ab', unique: true }
        ])
    )
    entries.push({
        id: 'merge_new_target',
        setup: [{ op: 'insert', collection: 'n6', documents: mergeSource }],
        steps: [
            { op: 'aggregate', collection: 'n6', pipeline: [{ $merge: { into: 'n6_t', on: '_id' } }] },
            { op: 'find', collection: 'n6_t', filter: {}, sort: { _id: 1 } }
        ]
    })
    entries.push({
        id: 'merge_object_target',
        setup: mergeSetup('n7', 'n7_t'),
        steps: [
            { op: 'aggregate', collection: 'n7', pipeline: [{ $merge: { into: { db: 'diff', coll: 'n7_t' }, on: 'a' } }] },
            { op: 'find', collection: 'n7_t', filter: {}, sort: { _id: 1 } }
        ]
    })
    entries.push({
        id: 'merge_errors',
        setup: [
            { op: 'insert', collection: 'me', documents: [{ _id: 1, a: 10 }, { _id: 2 }] },
            { op: 'insert', collection: 'me_t', documents: [{ _id: 1, a: 10 }] },
            { op: 'createIndexes', collection: 'me_t', indexes: [{ key: { a: 1 }, name: 'a_1', unique: true }] }
        ],
        steps: errors([
            { op: 'aggregate', collection: 'me', pipeline: [{ $merge: { into: 'me_none', on: 'a' } }] },
            { op: 'find', collection: 'me_none', filter: {}, sort: { _id: 1 } },
            { op: 'aggregate', collection: 'me', pipeline: [{ $merge: { into: 'me_t', on: 5 } }] },
            { op: 'aggregate', collection: 'me', pipeline: [{ $merge: { into: 'me_t', on: [] } }] },
            { op: 'aggregate', collection: 'me', pipeline: [{ $merge: { into: 5 } }] },
            { op: 'aggregate', collection: 'me', pipeline: [{ $merge: { into: 'me_t', on: 'a', whenMatched: 'keepExisting', whenNotMatched: 'discard' } }] },
            { op: 'aggregate', collection: 'me', pipeline: [{ $merge: { into: 'me_t', on: 'a', whenMatched: 'fail', whenNotMatched: 'discard' } }] },
            { op: 'aggregate', collection: 'me', pipeline: [{ $merge: { into: 'me_t', on: 'a', whenMatched: 'bogus' } }] },
            { op: 'aggregate', collection: 'me', pipeline: [{ $merge: { into: 'me_t', on: 'a', whenNotMatched: 'bogus' } }] },
            { op: 'aggregate', collection: 'me', pipeline: [{ $merge: { into: 'me_t', on: 'a', whenMatched: [{ $match: { a: 1 } }] } }] },
            { op: 'aggregate', collection: 'me', pipeline: [{ $match: { _id: 2 } }, { $merge: { into: 'me_t', on: 'a' } }] }
        ])
    })
    entries.push({
        id: 'merge_pipeline_match_error',
        setup: mergeSetup('n8', 'n8_t'),
        steps: errors([
            { op: 'aggregate', collection: 'n8', pipeline: [{ $merge: { into: 'n8_t', on: 'a', whenMatched: [{ $match: { a: 1 } }] } }] }
        ])
    })
    entries.push({
        id: 'merge_duplicate_fail',
        setup: [
            { op: 'insert', collection: 'md', documents: [{ _id: 1, a: 10 }] },
            { op: 'insert', collection: 'md_t', documents: [{ _id: 1, a: 10 }] },
            { op: 'createIndexes', collection: 'md_t', indexes: [{ key: { a: 1 }, name: 'a_1', unique: true }] }
        ],
        steps: errors([
            { op: 'aggregate', collection: 'md', pipeline: [{ $merge: { into: 'md_t', on: 'a', whenMatched: 'fail' } }] },
            { op: 'find', collection: 'md_t', filter: {}, sort: { _id: 1 } }
        ])
    })
    entries.push({
        id: 'merge_duplicate_insert',
        setup: [
            { op: 'insert', collection: 'mi', documents: [{ _id: 2, a: 50 }] },
            { op: 'insert', collection: 'mi_t', documents: [{ _id: 2, a: 60 }] },
            { op: 'createIndexes', collection: 'mi_t', indexes: [{ key: { a: 1 }, name: 'a_1', unique: true }] }
        ],
        steps: errors([
            { op: 'aggregate', collection: 'mi', pipeline: [{ $merge: { into: 'mi_t', on: 'a' } }] },
            { op: 'find', collection: 'mi_t', filter: {}, sort: { _id: 1 } }
        ])
    })

    entries.push({
        id: 'out_replace',
        setup: [
            { op: 'insert', collection: 'oo', documents: [{ _id: 1, a: 1 }, { _id: 2, a: 2 }] },
            { op: 'insert', collection: 'oo_t', documents: [{ _id: 9, a: 9 }] },
            { op: 'createIndexes', collection: 'oo_t', indexes: [{ key: { a: 1 }, name: 'a_1' }] }
        ],
        steps: [
            { op: 'aggregate', collection: 'oo', pipeline: [{ $sort: { _id: 1 } }, { $out: 'oo_t' }] },
            { op: 'find', collection: 'oo_t', filter: {}, sort: { _id: 1 } },
            { op: 'listIndexes', collection: 'oo_t' }
        ]
    })
    entries.push({
        id: 'out_same_collection',
        setup: [{ op: 'insert', collection: 'os', documents: [{ _id: 1, a: 1 }, { _id: 2, a: 2 }] }],
        steps: [
            { op: 'aggregate', collection: 'os', pipeline: [{ $sort: { _id: -1 } }, { $out: 'os' }] },
            { op: 'find', collection: 'os', filter: {}, sort: { _id: 1 } }
        ]
    })
    entries.push({
        id: 'out_create',
        setup: [{ op: 'insert', collection: 'oc', documents: [{ _id: 1, a: 1 }, { _id: 2, a: 2 }] }],
        steps: [
            { op: 'aggregate', collection: 'oc', pipeline: [{ $out: 'oc_t' }] },
            { op: 'find', collection: 'oc_t', filter: {}, sort: { _id: 1 } },
            { op: 'listIndexes', collection: 'oc_t' }
        ]
    })
    entries.push({
        id: 'out_object_target',
        setup: [{ op: 'insert', collection: 'ob', documents: [{ _id: 1, a: 1 }, { _id: 2, a: 2 }] }],
        steps: [
            { op: 'aggregate', collection: 'ob', pipeline: [{ $out: { db: 'diff', coll: 'ob_t' } }] },
            { op: 'find', collection: 'ob_t', filter: {}, sort: { _id: 1 } }
        ]
    })
    entries.push({
        id: 'out_errors',
        setup: [{ op: 'insert', collection: 'oe', documents: [{ _id: 1, a: 1 }] }],
        steps: errors([
            { op: 'aggregate', collection: 'oe', pipeline: [{ $out: 5 }] },
            { op: 'aggregate', collection: 'oe', pipeline: [{ $out: '' }] },
            { op: 'aggregate', collection: 'oe', pipeline: [{ $out: [] }] },
            { op: 'aggregate', collection: 'oe', pipeline: [{ $out: { coll: 'oe_x' } }] },
            { op: 'aggregate', collection: 'oe', pipeline: [{ $out: { db: 'diff', coll: '' } }] },
            { op: 'aggregate', collection: 'oe', pipeline: [{ $out: { db: 'diff', coll: 'oe_x', extra: 1 } }] }
        ])
    })

    entries.push({
        id: 'union_with_pipeline',
        setup: [
            { op: 'insert', collection: 'uw', documents: [{ _id: 1, g: 'a' }, { _id: 2, g: 'b' }, { _id: 3, g: 'a' }] },
            { op: 'insert', collection: 'uw2', documents: [{ _id: 4, g: 'a' }, { _id: 5, g: 'c' }] }
        ],
        steps: [
            {
                op: 'aggregate',
                collection: 'uw',
                pipeline: [
                    { $sort: { _id: 1 } },
                    { $project: { _id: 1 } },
                    { $unionWith: { coll: 'uw2', pipeline: [{ $match: { g: 'a' } }, { $project: { _id: 1 } }] } }
                ]
            }
        ]
    })
    entries.push({
        id: 'union_with_string_and_self',
        setup: [{ op: 'insert', collection: 'uw3', documents: [{ _id: 1 }, { _id: 2 }] }],
        steps: [
            {
                op: 'aggregate',
                collection: 'uw3',
                pipeline: [
                    { $project: { _id: 1 } },
                    { $unionWith: 'uw3_missing' },
                    { $sort: { _id: 1 } }
                ]
            },
            {
                op: 'aggregate',
                collection: 'uw3',
                pipeline: [{ $unionWith: { coll: 'uw3' } }, { $project: { _id: 1 } }, { $sort: { _id: 1 } }]
            }
        ]
    })
    entries.push({
        id: 'union_with_documents',
        setup: [{ op: 'insert', collection: 'uw4', documents: [{ _id: 1 }, { _id: 2 }] }],
        steps: [
            {
                op: 'aggregate',
                collection: 'uw4',
                pipeline: [
                    { $sort: { _id: 1 } },
                    {
                        $unionWith: {
                            pipeline: [{ $documents: [{ _id: 9, g: 'x' }] }, { $project: { _id: 1 } }]
                        }
                    },
                    { $sort: { _id: 1 } }
                ]
            }
        ]
    })
    entries.push({
        id: 'union_with_errors',
        setup: [{ op: 'insert', collection: 'ue', documents: [{ _id: 1 }] }],
        steps: errors([
            { op: 'aggregate', collection: 'ue', pipeline: [{ $unionWith: 5 }] },
            { op: 'aggregate', collection: 'ue', pipeline: [{ $unionWith: { coll: '' } }] },
            { op: 'aggregate', collection: 'ue', pipeline: [{ $unionWith: { coll: 'ue', pipeline: 5 } }] },
            { op: 'aggregate', collection: 'ue', pipeline: [{ $unionWith: { coll: 'ue', extra: 1 } }] },
            { op: 'aggregate', collection: 'ue', pipeline: [{ $unionWith: { pipeline: [{ $match: {} }] } }] }
        ])
    })

    entries.push({
        id: 'sample_counts',
        setup: [{ op: 'insert', collection: 'sp', documents: [{ _id: 1 }, { _id: 2 }, { _id: 3 }, { _id: 4 }] }],
        steps: [
            { op: 'aggregate', collection: 'sp', pipeline: [{ $sample: { size: 2 } }, { $count: 'n' }] },
            { op: 'aggregate', collection: 'sp', pipeline: [{ $sample: { size: 9 } }, { $count: 'n' }] },
            { op: 'aggregate', collection: 'sp', pipeline: [{ $sample: { size: 0 } }, { $count: 'n' }] }
        ]
    })
    entries.push({
        id: 'sample_errors',
        setup: [{ op: 'insert', collection: 'se', documents: [{ _id: 1 }] }],
        steps: errors([
            { op: 'aggregate', collection: 'se', pipeline: [{ $sample: { size: -1 } }] },
            { op: 'aggregate', collection: 'se', pipeline: [{ $sample: { size: 'two' } }] },
            { op: 'aggregate', collection: 'se', pipeline: [{ $sample: {} }] },
            { op: 'aggregate', collection: 'se', pipeline: [{ $sample: { size: 1, extra: 1 } }] },
            { op: 'aggregate', collection: 'se', pipeline: [{ $sample: 5 }] }
        ])
    })

    entries.push({
        id: 'densify_numeric',
        setup: [{ op: 'insert', collection: 'dn', documents: [{ _id: 1, x: 1 }, { _id: 2, x: 3 }] }],
        steps: [
            { op: 'aggregate', collection: 'dn', pipeline: [{ $densify: { field: 'x', range: { step: 1, bounds: 'full' } } }] }
        ]
    })
    entries.push({
        id: 'densify_partition',
        setup: [
            {
                op: 'insert',
                collection: 'dp',
                documents: [
                    { _id: 1, g: 'a', x: 1 },
                    { _id: 2, g: 'a', x: 3 },
                    { _id: 3, g: 'b', x: 2 },
                    { _id: 4, g: 'b', x: 6 }
                ]
            }
        ],
        steps: [
            {
                op: 'aggregate',
                collection: 'dp',
                pipeline: [{ $densify: { field: 'x', partitionByFields: ['g'], range: { step: 1, bounds: 'partition' } } }]
            }
        ]
    })
    entries.push({
        id: 'densify_dates',
        setup: [
            {
                op: 'insert',
                collection: 'dd',
                documents: [
                    { _id: 1, d: { $date: { $numberLong: '1704067200000' } } },
                    { _id: 2, d: { $date: { $numberLong: '1704326400000' } } }
                ]
            }
        ],
        steps: [
            {
                op: 'aggregate',
                collection: 'dd',
                pipeline: [{ $densify: { field: 'd', range: { step: 1, unit: 'day', bounds: 'full' } } }]
            }
        ]
    })
    entries.push({
        id: 'densify_errors',
        setup: [{ op: 'insert', collection: 'de', documents: [{ _id: 1, x: 1 }, { _id: 2, x: 'two' }] }],
        steps: errors([
            { op: 'aggregate', collection: 'de', pipeline: [{ $densify: { field: 'x', range: { step: 0, bounds: 'full' } } }] },
            { op: 'aggregate', collection: 'de', pipeline: [{ $densify: { field: 'x', range: { step: 1, bounds: 'partition' } } }] },
            { op: 'aggregate', collection: 'de', pipeline: [{ $densify: { field: 'x', range: { step: 1, bounds: [3, 1] } } }] },
            { op: 'aggregate', collection: 'de', pipeline: [{ $densify: { field: '$x', range: { step: 1, bounds: 'full' } } }] },
            { op: 'aggregate', collection: 'de', pipeline: [{ $densify: { field: 'x', range: { step: 1, bounds: 'bogus' } } }] }
        ])
    })

    entries.push({
        id: 'fill_value_and_locf',
        setup: [
            {
                op: 'insert',
                collection: 'fl',
                documents: [
                    { _id: 1, t: 1, v: 10, w: 5 },
                    { _id: 2, t: 2, v: null },
                    { _id: 3, t: 3, v: 30, w: 7 }
                ]
            }
        ],
        steps: [
            {
                op: 'aggregate',
                collection: 'fl',
                pipeline: [{ $fill: { sortBy: { t: 1 }, output: { v: { method: 'locf' }, w: { value: 0 } } } }]
            },
            {
                op: 'aggregate',
                collection: 'fl',
                pipeline: [{ $fill: { sortBy: { t: 1 }, output: { w: { method: 'linear' } } } }]
            }
        ]
    })
    entries.push({
        id: 'fill_errors',
        setup: [{ op: 'insert', collection: 'fe', documents: [{ _id: 1, t: 1, v: 'text' }, { _id: 2, t: 2, v: null }] }],
        steps: errors([
            { op: 'aggregate', collection: 'fe', pipeline: [{ $fill: { output: { v: { method: 'bogus' } } } }] },
            { op: 'aggregate', collection: 'fe', pipeline: [{ $fill: { output: { v: { method: 'locf', value: 5 } } } }] },
            { op: 'aggregate', collection: 'fe', pipeline: [{ $fill: { sortBy: { t: 1 }, output: { v: { method: 'linear' } } } }] }
        ])
    })

    entries.push({
        id: 'redact_prune_descend',
        setup: [
            {
                op: 'insert',
                collection: 'rd',
                documents: [
                    { _id: 1, secret: true, v: 'hidden' },
                    { _id: 2, v: 'shown' },
                    { _id: 3, child: { secret: true, v: 'nested' } }
                ]
            }
        ],
        steps: [
            {
                op: 'aggregate',
                collection: 'rd',
                pipeline: [
                    {
                        $redact: {
                            $cond: [{ $eq: ['$secret', true] }, '$$PRUNE', '$$DESCEND']
                        }
                    }
                ]
            },
            {
                op: 'aggregate',
                collection: 'rd',
                pipeline: [
                    { $match: { _id: 1 } },
                    { $redact: { $cond: [{ $eq: ['$secret', true] }, '$$PRUNE', '$$KEEP'] } }
                ]
            }
        ]
    })

    entries.push({
        id: 'sort_by_count_missing',
        setup: [
            {
                op: 'insert',
                collection: 'sb',
                documents: [
                    { _id: 1, g: 'a' },
                    { _id: 2, g: 'a' },
                    { _id: 3, g: 'a' },
                    { _id: 4, g: 'b' },
                    { _id: 5, g: 'b' },
                    { _id: 6 }
                ]
            }
        ],
        steps: [{ op: 'aggregate', collection: 'sb', pipeline: [{ $sortByCount: '$g' }] }]
    })

    return entries
}

// Unique-index consistency: conflict shapes outside `insert`, plus partial
// filters on non-insert paths. TTL deletion needs a Date BSON type that the
// shared protocol crate does not decode yet, so it stays out of the corpus.
function buildConsistency(seed) {
    const entries = []
    const uniqueA = [{ key: { a: 1 }, name: 'a_unique', unique: true }]
    entries.push({
        id: 'unique_update_conflict',
        setup: [
            { op: 'insert', collection: 'u1', documents: [{ _id: 1, a: 10 }, { _id: 2, a: 20 }] },
            { op: 'createIndexes', collection: 'u1', indexes: uniqueA }
        ],
        steps: [
            { op: 'update', collection: 'u1', updates: [{ q: { _id: 2 }, u: { $set: { a: 10 } } }] },
            { op: 'find', collection: 'u1', filter: {}, sort: { _id: 1 } },
            { op: 'update', collection: 'u1', updates: [{ q: { a: 30 }, u: { $set: { a: 10 } }, upsert: true }] },
            { op: 'find', collection: 'u1', filter: {}, sort: { _id: 1 } }
        ]
    })
    entries.push({
        id: 'unique_find_and_modify_conflict',
        setup: [
            { op: 'insert', collection: 'u2', documents: [{ _id: 1, a: 10 }, { _id: 2, a: 20 }] },
            { op: 'createIndexes', collection: 'u2', indexes: uniqueA }
        ],
        steps: [
            { op: 'findAndModify', collection: 'u2', query: { _id: 2 }, update: { $set: { a: 10 } } },
            { op: 'find', collection: 'u2', filter: {}, sort: { _id: 1 } }
        ]
    })
    entries.push({
        id: 'partial_unique_exists',
        setup: [
            {
                op: 'insert',
                collection: 'p1',
                documents: [
                    { _id: 1, a: 5, active: true },
                    { _id: 2, a: 5 },
                    { _id: 3, a: 5, active: false }
                ]
            },
            {
                op: 'createIndexes',
                collection: 'p1',
                indexes: [{ key: { a: 1 }, name: 'a_partial', unique: true, partialFilterExpression: { active: true } }]
            }
        ],
        steps: [
            {
                op: 'insert',
                collection: 'p1',
                documents: [
                    { _id: 4, a: 5 },
                    { _id: 5, a: 5, active: false },
                    { _id: 6, a: 5, active: true }
                ]
            },
            { op: 'find', collection: 'p1', filter: {}, sort: { _id: 1 } }
        ]
    })
    entries.push({
        id: 'partial_unique_compound',
        setup: [
            {
                op: 'insert',
                collection: 'p2',
                documents: [
                    { _id: 1, a: 1, b: 2 },
                    { _id: 2, a: 1 },
                    { _id: 3, a: 1 }
                ]
            },
            {
                op: 'createIndexes',
                collection: 'p2',
                indexes: [{ key: { a: 1, b: 1 }, name: 'ab_partial', unique: true, partialFilterExpression: { b: { $exists: true } } }]
            }
        ],
        steps: [
            {
                op: 'insert',
                collection: 'p2',
                documents: [
                    { _id: 4, a: 1, b: 2 },
                    { _id: 5, a: 1, b: 3 },
                    { _id: 6, a: 1 }
                ]
            },
            { op: 'find', collection: 'p2', filter: {}, sort: { _id: 1 } }
        ]
    })
    entries.push({
        id: 'unique_null_and_missing',
        setup: [
            { op: 'insert', collection: 'u3', documents: [{ _id: 1, a: null }] },
            { op: 'createIndexes', collection: 'u3', indexes: uniqueA }
        ],
        steps: [
            { op: 'insert', collection: 'u3', documents: [{ _id: 2 }, { _id: 3, a: null }] },
            { op: 'find', collection: 'u3', filter: {}, sort: { _id: 1 } }
        ]
    })
    entries.push({
        id: 'unique_build_missing_null',
        setup: [
            { op: 'insert', collection: 'u4', documents: [{ _id: 1 }, { _id: 2, a: null }] }
        ],
        steps: [
            { op: 'createIndexes', collection: 'u4', indexes: uniqueA },
            { op: 'listIndexes', collection: 'u4' }
        ]
    })
    return entries
}

function buildBsonTypes(seed) {
    const entries = []
    const date = { $date: { $numberLong: '1700000000000' } }
    const timestamp = { $timestamp: { t: 7, i: 3 } }

    entries.push({
        id: 'diff.bson.date_timestamp_keys_round_trip',
        cluster: 'bsonTypes',
        collection: 'diff_bson_types',
        setup: [{
            op: 'insert',
            collection: 'diff_bson_types',
            documents: [
                { _id: 1, d: date },
                { _id: 2, t: timestamp },
                { _id: 3, lo: { $minKey: 1 }, hi: { $maxKey: 1 } }
            ]
        }],
        steps: [{ op: 'find', collection: 'diff_bson_types', filter: {}, sort: { _id: 1 } }]
    })

    entries.push({
        id: 'diff.bson.mixed_type_sort_order',
        cluster: 'bsonTypes',
        collection: 'diff_bson_sort',
        setup: [{
            op: 'insert',
            collection: 'diff_bson_sort',
            documents: [
                { _id: 1, v: { $minKey: 1 } },
                { _id: 2, v: null },
                { _id: 3, v: -5 },
                { _id: 4, v: 'abc' },
                { _id: 5, v: { a: 1 } },
                { _id: 6, v: { $oid: '000000000000000000000002' } },
                { _id: 7, v: true },
                { _id: 8, v: date },
                { _id: 9, v: { $timestamp: { t: 7, i: 3 } } },
                { _id: 10, v: { $timestamp: { t: 7, i: 5 } } },
                { _id: 11, v: { $timestamp: { t: 8, i: 0 } } },
                { _id: 12, v: { $maxKey: 1 } }
            ]
        }],
        // `Timestamp` compares by `(t, i)`, `Date` by milliseconds, and
        // `MinKey` / `MaxKey` bracket every other type.
        steps: [{ op: 'find', collection: 'diff_bson_sort', filter: {}, sort: { v: 1 } }]
    })

    // The duplicate-key `errmsg` renders each value the way `mongod` prints it,
    // so these entries pin the shell rendering at the same time.
    for (const [suffix, value] of [['date', date], ['timestamp', timestamp], ['minkey', { $minKey: 1 }], ['maxkey', { $maxKey: 1 }]]) {
        const collection = `diff_bson_dup_${suffix}`
        entries.push({
            id: `diff.bson.duplicate_${suffix}_key_message`,
            cluster: 'bsonTypes',
            collection,
            setup: [
                { op: 'insert', collection, documents: [{ _id: 1, v: value }] },
                { op: 'createIndexes', collection, indexes: [{ key: { v: 1 }, name: 'v_unique', unique: true }] }
            ],
            steps: [
                { op: 'insert', collection, documents: [{ _id: 2, v: value }] },
                { op: 'find', collection, filter: {}, sort: { _id: 1 } }
            ]
        })
    }
    return entries
}

const CLUSTERS = [
    ['find', buildFind],
    ['aggregate', buildAggregate],
    ['update', buildUpdate],
    ['delete', buildDelete],
    ['insert', buildInsert],
    ['indexes', buildIndexes],
    ['cursor', buildCursor],
    ['findAndModify', buildFindAndModify],
    ['distinct', buildDistinct],
    ['bulkWrite', buildBulkWrite],
    ['validators', buildValidators],
    ['listCollections', buildListCollections],
    ['count', buildCountExplain],
    ['hint', buildHint],
    ['stages', buildRemainingStages],
    ['consistency', buildConsistency],
    ['bsonTypes', buildBsonTypes]
]

function generate(seed) {
    const entries = []
    CLUSTERS.forEach(([name, builder], index) => {
        const built = builder((seed + index * 7919) >>> 0)
        for (const entry of built) {
            entries.push({ ...entry, seed: (seed + index * 7919) >>> 0 })
        }
    })
    // Drop keys that carry `undefined` so the in-memory value and the committed
    // JSON file hash to the same digest.
    return JSON.parse(JSON.stringify(entries))
}

// --- command construction ---------------------------------------------------
function commandOf(step, replies) {
    const collection = step.collection
    const resolveCursor = (index) => {
        if (step.id) return step.id
        const reply = replies[index]
        return reply?.cursor?.id
    }
    switch (step.op) {
        case 'insert': {
            const command = { insert: collection, documents: step.documents }
            if (step.ordered !== undefined) command.ordered = step.ordered
            return { ...command, $db: DB }
        }
        case 'find': {
            const command = { find: collection, filter: step.filter ?? {} }
            for (const key of ['projection', 'sort', 'skip', 'limit', 'batchSize', 'hint']) {
                if (step[key] !== undefined) command[key] = step[key]
            }
            return { ...command, $db: DB }
        }
        case 'aggregate':
            return { aggregate: collection, pipeline: step.pipeline, cursor: {}, $db: DB }
        case 'update':
            return { update: collection, updates: step.updates, $db: DB }
        case 'delete':
            return { delete: collection, deletes: step.deletes, $db: DB }
        case 'createIndexes':
            return { createIndexes: collection, indexes: step.indexes, $db: DB }
        case 'listIndexes':
            return { listIndexes: collection, $db: DB }
        case 'dropIndexes':
            return { dropIndexes: collection, index: step.index, $db: DB }
        case 'getMore': {
            const command = { getMore: resolveCursor(step.cursorFrom), collection }
            if (step.batchSize !== undefined) command.batchSize = step.batchSize
            return { ...command, $db: DB }
        }
        case 'killCursors':
            return {
                killCursors: collection,
                cursors: step.cursorsFrom.map((index) => resolveCursor(index)),
                $db: DB
            }
        case 'findAndModify': {
            const command = { findAndModify: collection }
            for (const key of ['query', 'sort', 'remove', 'update', 'new', 'fields', 'upsert']) {
                if (step[key] !== undefined) command[key] = step[key]
            }
            return { ...command, $db: DB }
        }
        case 'distinct': {
            const command = { distinct: collection, key: step.key }
            if (step.query !== undefined) command.query = step.query
            return { ...command, $db: DB }
        }
        case 'bulkWrite': {
            const command = { bulkWrite: 1, ops: step.ops, nsInfo: step.nsInfo }
            if (step.ordered !== undefined) command.ordered = step.ordered
            if (step.errorsOnly !== undefined) command.errorsOnly = step.errorsOnly
            return { ...command, $db: step.db ?? 'admin' }
        }
        case 'count': {
            const command = { count: collection }
            for (const key of ['query', 'skip', 'limit', 'hint']) {
                if (step[key] !== undefined) command[key] = step[key]
            }
            return { ...command, $db: DB }
        }
        case 'explain': {
            const command = { explain: step.explain }
            if (step.verbosity !== undefined) command.verbosity = step.verbosity
            return { ...command, $db: DB }
        }
        case 'create': {
            const command = { create: collection }
            for (const key of ['validator', 'validationLevel', 'validationAction']) {
                if (step[key] !== undefined) command[key] = step[key]
            }
            return { ...command, $db: DB }
        }
        case 'collMod': {
            const command = { collMod: collection }
            for (const key of ['validator', 'validationLevel', 'validationAction']) {
                if (step[key] !== undefined) command[key] = step[key]
            }
            return { ...command, $db: DB }
        }
        case 'listCollections': {
            const command = { listCollections: 1 }
            for (const key of ['filter', 'nameOnly', 'authorizedCollections']) {
                if (step[key] !== undefined) command[key] = step[key]
            }
            return { ...command, $db: DB }
        }
        case 'drop':
            return { drop: collection, $db: DB }
        default:
            throw new Error(`unknown step op ${step.op}`)
    }
}

// --- execution --------------------------------------------------------------
// `$addToSet` and other unordered outputs are canonicalized before the
// comparison, because the real server does not order them deterministically.
function canonicalizeReply(reply, entry) {
    if (!entry.unordered || entry.unordered.length === 0) return reply
    function walk(node) {
        if (Array.isArray(node)) return node.map(walk)
        if (node && typeof node === 'object') {
            const out = {}
            for (const [key, value] of Object.entries(node)) {
                out[key] = entry.unordered.includes(key) && Array.isArray(value)
                    ? [...value].sort((left, right) => stable(left).localeCompare(stable(right)))
                    : walk(value)
            }
            return out
        }
        return node
    }
    return walk(JSON.parse(JSON.stringify(reply)))
}

async function runOnOracle(entry) {
    // Drop every namespace the entry touches, so `create` entries start from a
    // clean database and the entry can be replayed for the stability rerun.
    const touched = new Set(entry.setup.map((step) => step.collection))
    for (const step of entry.steps) if (step.collection) touched.add(step.collection)
    for (const step of entry.setup) if (step.op === 'bulkWrite') for (const ns of step.nsInfo ?? []) touched.add(ns.ns.split('.')[1])
    for (const collection of touched) {
        await oracleCommand({ drop: collection, $db: DB }).catch(() => {})
    }
    for (const step of entry.setup) await oracleCommand(commandOf(step, []))
    const replies = []
    for (const step of entry.steps) {
        replies.push(canonicalizeReply(await oracleCommand(commandOf(step, replies)), entry))
    }
    return replies
}

function runOnLocal(entry) {
    const directory = mkdtempSync(join(tmpdir(), 'mongo-diff-'))
    const store = new binding.MongoStore(join(directory, 's.yykv'))
    const cursors = new binding.MongoCursors()
    try {
        for (const step of entry.setup) localCommand(store, cursors, commandOf(step, []))
        const replies = []
        for (const step of entry.steps) {
            replies.push(canonicalizeReply(localCommand(store, cursors, commandOf(step, replies)), entry))
        }
        return replies
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
}

async function classify(entry, oracleReplies, localReplies) {
    const steps = []
    let matched = true
    let gateable = !entry.unordered
    if (entry.steps.some((step) => step.op === 'killCursors' || (step.op === 'getMore' && step.cursorFrom !== undefined))) {
        gateable = false
    }
    for (let index = 0; index < entry.steps.length; index += 1) {
        const result = repliesMatch(oracleReplies[index], localReplies[index])
        const okSame = okEncoding(oracleReplies[index]) === okEncoding(localReplies[index])
        if (!result.match) matched = false
        if (
            result.flags.cursor ||
            result.flags.uuid ||
            result.flags.oid ||
            result.flags.hash ||
            result.flags.serverInfo ||
            result.flags.timing
        ) {
            gateable = false
        }
        steps.push({
            index,
            op: entry.steps[index].op,
            command: commandOf(entry.steps[index], oracleReplies),
            match: result.match,
            sameOrder: result.sameOrder,
            oracle: result.oracle,
            local: result.local,
            okSame,
            flags: result.flags
        })
    }
    return { matched, gateable: matched && gateable, steps }
}

async function rerunOracle(entry) {
    return runOnOracle(entry)
}

function oracleStable(first, second) {
    if (first.length !== second.length) return false
    return first.every((reply, index) => stable(normalizeReply(reply).value) === stable(normalizeReply(second[index]).value))
}

// --- gate case emission -----------------------------------------------------
function replyChecks(steps, expectedReplies, referenceReplies) {
    const checks = []
    for (let index = 0; index < steps.length; index += 1) {
        const reply = expectedReplies[index]
        const reference = referenceReplies[index]
        const skipOk = okEncoding(reply) !== okEncoding(reference)
        for (const [key, value] of Object.entries(reply)) {
            if (key === 'ok' && skipOk) continue
            checks.push({ at: `/r${index}/${key}`, equals: value })
        }
    }
    return checks
}

function programForCases(entry, resolvedReplies) {
    const program = [{ op: 'open', store: 's' }]
    for (const step of entry.setup) program.push({ ...step })
    entry.steps.forEach((step, index) => {
        const copy = { ...step }
        delete copy.cursorFrom
        delete copy.cursorsFrom
        if (step.op === 'killCursors') {
            copy.ids = step.cursorsFrom.map((from) => resolvedReplies[from]?.cursor?.id)
        }
        if (step.op === 'getMore' && !step.id) copy.id = resolvedReplies[step.cursorFrom]?.cursor?.id
        program.push({ ...copy, as: `r${index}` })
    })
    return program
}

// --- main -------------------------------------------------------------------
function readJson(path) {
    return JSON.parse(readFileSync(path, 'utf8'))
}

function writeJson(path, value) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function verify() {
    if (!existsSync(CORPUS_PATH) || !existsSync(BASELINE_PATH)) {
        console.error('corpus or baseline missing; run with --write first')
        process.exit(1)
    }
    const corpus = readJson(CORPUS_PATH)
    const baseline = readJson(BASELINE_PATH)
    const regenerated = generate(SEED)
    const problems = corpusIdentityProblems(corpus, baseline, regenerated)
    console.log(`corpus entries: ${regenerated.length}`)
    console.log(`corpus digest: ${corpus.digest}`)
    console.log(`baseline digest: ${baseline.replyDigest}`)
    if (problems.length > 0) {
        for (const problem of problems) console.error(`FAIL ${problem}`)
        process.exit(1)
    }
    console.log('VERIFY OK')
}

function corpusIdentityProblems(corpus, baseline, regenerated) {
    const problems = []
    if (corpus.seed !== SEED) problems.push(`corpus seed ${corpus.seed} != ${SEED}`)
    if (corpus.count !== undefined && corpus.count !== COUNT) problems.push(`corpus count ${corpus.count} != ${COUNT}`)
    if (regenerated.length !== COUNT) {
        problems.push(`generated ${regenerated.length} entries but --count declared ${COUNT}`)
    }
    if (stable(regenerated) !== stable(corpus.entries)) problems.push('corpus does not match the generator output for this seed')
    if (digest(regenerated) !== corpus.digest) problems.push('corpus digest mismatch')
    if (baseline.seed !== SEED) problems.push(`baseline seed ${baseline.seed} != ${SEED}`)
    if (baseline.count !== undefined && baseline.count !== COUNT) problems.push(`baseline count ${baseline.count} != ${COUNT}`)
    if (baseline.corpusDigest !== corpus.digest) problems.push('baseline does not belong to this corpus')
    if (digest(baseline.replies) !== baseline.replyDigest) problems.push('baseline reply digest mismatch')
    for (const entry of regenerated) {
        if (!baseline.replies[entry.id]) problems.push(`baseline misses ${entry.id}`)
    }
    for (const id of Object.keys(baseline.replies)) {
        if (!regenerated.some((entry) => entry.id === id)) problems.push(`baseline has stale entry ${id}`)
    }
    return problems
}

function regenerationCommand() {
    return `node scripts/diff-corpus.mjs --seed ${SEED} --count ${COUNT} --write --emit-cases`
}

/// Signature of one stable difference: the normalized oracle and local replies
/// of every mismatching step. Changing this signal means the difference itself
/// changed shape.
function differenceSignal(steps) {
    return digest(steps.filter((step) => !step.match).map((step) => ({ index: step.index, oracle: step.oracle, local: step.local })))
}

/// 旧台账规则：逐条观测按输入顺序检查，最后按基线登记顺序补 stale。
function ledgerProblems(known, observed) {
    const problems = []
    for (const [id, signal] of observed) {
        if (!known[id]) {
            problems.push(`unexpected difference ${id}; it has no baseline entry (until the corpus labeled it as a known difference)\n  repro: node scripts/diff-corpus.mjs --port ${PORT} --seed ${SEED} --only ${id}`)
            continue
        }
        if (known[id].signal !== signal) {
            problems.push(`known difference changed shape: ${id}\n  baseline signal ${known[id].signal}\n  current  signal ${signal}`)
        }
    }
    for (const id of Object.keys(known)) {
        if (!observed.has(id)) problems.push(`stale baseline entry ${id}; the entry no longer differs, remove it from baseline`)
    }
    return problems
}

async function check() {
    if (!existsSync(CORPUS_PATH) || !existsSync(BASELINE_PATH)) {
        console.error('corpus or baseline missing; run with --write first')
        process.exit(1)
    }
    const corpus = readJson(CORPUS_PATH)
    const baseline = readJson(BASELINE_PATH)
    const regenerated = generate(SEED)
    const problems = corpusIdentityProblems(corpus, baseline, regenerated)
    console.log(`corpus entries: ${regenerated.length}`)
    console.log(`corpus digest: ${corpus.digest}`)
    if (problems.length > 0) {
        for (const problem of problems) console.error(`FAIL ${problem}`)
        console.error(`regenerate with: ${regenerationCommand()}`)
        process.exit(1)
    }

    const known = baseline.knownDifferences ?? {}
    const observed = new Map()
    for (const entry of regenerated) {
        const oracleReplies = await runOnOracle(entry)
        const localReplies = runOnLocal(entry)
        const result = await classify(entry, oracleReplies, localReplies)
        if (result.matched) continue
        const second = await rerunOracle(entry)
        const localSecond = runOnLocal(entry)
        if (!oracleStable(oracleReplies, second) || !oracleStable(localReplies, localSecond)) {
            problems.push(`unstable difference ${entry.id}; the corpus cannot gate a reply that changes between runs`)
            continue
        }
        observed.set(entry.id, differenceSignal(result.steps))
    }

    problems.push(...ledgerProblems(known, observed))

    console.log(`match ${regenerated.length - observed.size} known-difference ${observed.size} unexpected ${problems.length}`)
    if (problems.length > 0) {
        for (const problem of problems) console.error(`FAIL ${problem}`)
        console.error(`regenerate with: ${regenerationCommand()}`)
        process.exit(1)
    }
    console.log('CORPUS CHECK OK')
}

// 影子模式：只比较纯数据层，引擎启动前退出，不替换既有调用路径。
if (process.env.HARNESS_SHADOW === '1') {
    const corpus = readJson(CORPUS_PATH)
    const baseline = readJson(BASELINE_PATH)
    const regenerated = generate(SEED)
    const failures = []
    const compare = (label, legacy, candidate) => {
        if (legacy !== candidate) failures.push({ label, legacy, candidate })
    }

    const nodeDigest = digest(regenerated)
    const candidateDigest = binding.harnessDigest(Buffer.from(stable(regenerated)))
    compare('digest/node', nodeDigest, candidateDigest)
    compare('digest/corpus', corpus.digest, candidateDigest)
    compare('digest/baseline', baseline.corpusDigest, candidateDigest)

    const known = { ...(baseline.knownDifferences ?? {}), 'shadow/known': { signal: digest(['shadow-known']) } }
    const entries = Object.entries(known).map(([key, value]) => ({ key, signal: [value.signal], reason: 'known-difference' }))
    const identity = {
        spec: { version: baseline.version, seed: baseline.seed, count: baseline.count },
        digest: baseline.corpusDigest,
    }
    const harnessBaseline = { identity, entries }

    const legacyIdentityKinds = (current) => {
        const kinds = []
        if (baseline.seed !== current.spec.seed) kinds.push('seed-drift')
        if (baseline.count !== current.spec.count) kinds.push('count-drift')
        if (baseline.corpusDigest !== current.digest) kinds.push('digest-drift')
        return kinds
    }
    const legacyLedgerKind = (message) => {
        if (message.startsWith('unexpected difference')) return 'unlisted'
        if (message.startsWith('known difference changed shape:')) return 'signal-changed'
        if (message.startsWith('stale baseline entry')) return 'stale'
        throw new Error(`unknown ledger problem: ${message}`)
    }

    const scenario = (label, current, observed) => {
        const legacyProblems = ledgerProblems(known, observed)
        const matched = observed.size - legacyProblems.filter((problem) =>
            problem.startsWith('unexpected difference') || problem.startsWith('known difference changed shape:')).length
        const verdict = JSON.parse(binding.harnessCheckBaseline(
            JSON.stringify(harnessBaseline),
            JSON.stringify(current),
            JSON.stringify([...observed].map(([key, signal]) => ({ key, signal: [signal], reason: 'known-difference' }))),
        ))
        const normalizedLegacy = JSON.stringify({
            matched,
            problems: [
                ...legacyIdentityKinds(current),
                ...legacyProblems.map(legacyLedgerKind),
            ],
        })
        const normalizedCandidate = JSON.stringify({
            matched: verdict.matched,
            problems: verdict.problems.map((problem) => problem.kind),
        })
        compare(`ledger/${label}`, normalizedLegacy, normalizedCandidate)
        return normalizedCandidate
    }

    const allObserved = () => new Map(Object.entries(known).map(([id, value]) => [id, value.signal]))
    const cleanRun = scenario('clean', identity, allObserved())

    const unlistedObserved = allObserved()
    unlistedObserved.set('shadow/unlisted', digest(['shadow-unlisted']))
    const unlistedRun = scenario('unlisted', identity, unlistedObserved)

    const changedObserved = allObserved()
    changedObserved.set([...changedObserved.keys()][0], digest(['shadow-extra']))
    const changedRun = scenario('signal-changed', identity, changedObserved)

    const staleObserved = allObserved()
    staleObserved.delete([...staleObserved.keys()].at(-1))
    const staleRun = scenario('stale', identity, staleObserved)

    const driftRun = scenario('identity-drift', {
        spec: { ...identity.spec, seed: identity.spec.seed + 1 },
        digest: identity.digest,
    }, allObserved())

    const legacyReport = {
        version: 1,
        command: 'corpus',
        corpus: {
            spec: identity.spec,
            digest: candidateDigest,
            matched: Object.keys(known).length,
            problems: [],
            clean: true,
        },
    }
    const legacyText = `${JSON.stringify(legacyReport, null, 2)}\n`
    const candidateText = binding.harnessRenderReport(JSON.stringify(legacyReport))
    compare('report/corpus', legacyText, candidateText)

    console.log(JSON.stringify({
        digest: nodeDigest,
        scenarios: {
            clean: cleanRun,
            unlisted: unlistedRun,
            'signal-changed': changedRun,
            stale: staleRun,
            'identity-drift': driftRun,
        },
        failures,
    }, null, 2))
    if (failures.length > 0) {
        console.error(`harness shadow mismatch: ${failures.length} difference(s)`)
        process.exit(1)
    }
    process.exit(0)
}

async function main() {
    if (VERIFY) return verify()
    if (CHECK) {
        if (WRITE || EMIT || ONLY) {
            console.error('--check cannot be combined with --write, --emit-cases or --only')
            process.exit(1)
        }
        return check()
    }
    if (ONLY && (WRITE || EMIT)) {
        console.error('--only cannot be combined with --write or --emit-cases')
        process.exit(1)
    }

    const entries = generate(SEED)
    const selected = ONLY ? entries.filter((entry) => entry.id === ONLY) : entries
    if (ONLY && selected.length === 0) {
        console.error(`no corpus entry ${ONLY}`)
        process.exit(1)
    }

    const report = {
        seed: SEED,
        mongod: '8.0.9',
        host: HOST,
        port: PORT,
        generated: entries.length,
        clusters: {},
        entries: [],
        matches: 0,
        gateable: 0,
        replyEncoding: 0,
        knownDifferences: 0,
        unstable: 0
    }
    const baselineReplies = {}
    const baselineKnown = {}
    const knownCases = []
    const matchedCases = []

    for (const entry of selected) {
        report.clusters[entry.cluster] = report.clusters[entry.cluster] ?? { entries: 0 }
        report.clusters[entry.cluster].entries += 1

        const oracleReplies = await runOnOracle(entry)
        const localReplies = runOnLocal(entry)
        const result = await classify(entry, oracleReplies, localReplies)
        if (ONLY) {
            const recorded = existsSync(BASELINE_PATH) ? readJson(BASELINE_PATH).replies?.[entry.id] : null
            const fresh = oracleReplies.map((reply) => normalizeReply(reply).value)
            if (!recorded) {
                console.log(`no baseline for ${entry.id}`)
                process.exitCode = 1
            } else if (stable(fresh) === stable(recorded)) {
                console.log(`MATCH baseline ${entry.id}`)
            } else {
                console.log(`DIFF baseline ${entry.id}`)
                process.exitCode = 1
            }
        }
        if (result.steps.some((step) => !step.okSame)) report.replyEncoding += 1
        const record = {
            id: entry.id,
            cluster: entry.cluster,
            matched: result.matched,
            gateable: result.gateable,
            classification: result.matched ? 'match' : 'pending',
            steps: result.steps
        }
        report.entries.push(record)
        baselineReplies[entry.id] = oracleReplies.map((reply) => normalizeReply(reply).value)

        if (result.matched) {
            report.matches += 1
            if (result.gateable) {
                report.gateable += 1
                if (WRITE || EMIT) {
                    matchedCases.push({
                        id: entry.id,
                        surface: 'diff',
                        db: DB,
                        source: `mongod 8.0.9 seed ${SEED} corpus ${entry.id}`,
                        program: programForCases(entry, localReplies),
                        checks: replyChecks(entry.steps, oracleReplies, localReplies)
                    })
                }
            }
        } else {
            const second = await rerunOracle(entry)
            const localSecond = runOnLocal(entry)
            const stableOracle = oracleStable(oracleReplies, second)
            const stableLocal = oracleStable(localReplies, localSecond)
            const classification = stableOracle && stableLocal ? 'known-difference' : 'unstable'
            record.classification = classification
            if (classification === 'known-difference') {
                report.knownDifferences += 1
                baselineKnown[entry.id] = { signal: differenceSignal(result.steps) }
                if (WRITE || EMIT) {
                    knownCases.push({
                        id: entry.id,
                        surface: 'diff-known',
                        db: DB,
                        knownDifference: true,
                        reason: `stable difference against mongod 8.0.9 (seed ${SEED}); the real reply is quoted in source`,
                        source: result.steps
                            .filter((step) => !step.match)
                            .map((step) => `#${step.index} ${JSON.stringify(step.command)} oracle=${stable(step.oracle)}`)
                            .join(' | '),
                        program: programForCases(entry, localReplies),
                        checks: replyChecks(entry.steps, localReplies, localReplies)
                    })
                }
            } else {
                report.unstable += 1
            }
            for (const step of result.steps) {
                if (step.match) continue
                console.log(`DIFF ${entry.id} step#${step.index} ${step.op}`)
                console.log(`  command ${JSON.stringify(step.command)}`)
                console.log(`  local   ${stable(step.local)}`)
                console.log(`  oracle  ${stable(step.oracle)}`)
                console.log(`  repro   node scripts/diff-corpus.mjs --port ${PORT} --seed ${SEED} --only ${entry.id}`)
            }
        }
    }

    writeJson(REPORT_PATH, report)
    console.log(`corpus ${report.generated} entries across ${Object.keys(report.clusters).length} clusters`)
    console.log(`match ${report.matches} gateable ${report.gateable} known-difference ${report.knownDifferences} unstable ${report.unstable}`)

    if (WRITE) {
        writeJson(CORPUS_PATH, {
            version: 1,
            seed: SEED,
            count: entries.length,
            mongod: '8.0.9',
            counts: Object.fromEntries(Object.entries(report.clusters).map(([cluster, value]) => [cluster, value.entries])),
            digest: digest(entries),
            entries
        })
        writeJson(BASELINE_PATH, {
            version: 1,
            seed: SEED,
            count: entries.length,
            mongod: '8.0.9',
            corpusDigest: digest(entries),
            replyDigest: digest(baselineReplies),
            knownDifferences: baselineKnown,
            replies: baselineReplies
        })
        console.log(`wrote ${CORPUS_PATH}`)
        console.log(`wrote ${BASELINE_PATH}`)
    }

    if (EMIT) {
        writeJson(CASE_PATH, { suite: 'diff corpus', surface: 'diff', cases: matchedCases })
        writeJson(KNOWN_CASE_PATH, { suite: 'diff known differences', surface: 'diff-known', cases: knownCases })
        console.log(`wrote ${CASE_PATH} (${matchedCases.length} cases)`)
        console.log(`wrote ${KNOWN_CASE_PATH} (${knownCases.length} cases)`)
    }
}

main().catch((error) => {
    console.error(error)
    process.exit(1)
})
