// TypeScript-side acceptance runner.
//
// Every case in `tests/cases/*.json` is executed through the installed platform
// package (`@yydb/mongo-<os>-<arch>` -> `lib/mongo.node`). Expectations are
// literals in the case files: BSON bytes follow the specification layouts and
// command replies follow MongoDB semantics, so nothing is derived by calling
// this implementation twice.
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..', '..', '..', '..', '..')
const require = createRequire(import.meta.url)
const platform = `${process.platform}-${process.arch}`
const binding = require(join(repo, 'projects', 'mongo.ts', 'platforms', `mongo-${platform}`, 'index.js'))
const cliEntry = join(repo, 'projects', 'mongo.ts', 'packages', 'mongo', 'bin', 'mongo.mjs')
const yydsVerifier = join(repo, 'scripts', 'verify-yyds.mjs')

const caseDir = join(repo, 'tests', 'cases')
const outputPath = process.env.MONGO_TEST_OUT ?? join(repo, '.tmp', 'test-results', 'ts.json')
const MISSING = Symbol('missing')

function stable(value) {
    if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
    if (value && typeof value === 'object') {
        return `{${Object.keys(value)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
            .join(',')}}`
    }
    return JSON.stringify(value)
}

function resolvePath(root, path) {
    if (!path.startsWith('/')) throw new Error(`case path must be absolute: ${path}`)
    return walk(root, path.split('/').slice(1))
}

function walk(node, segments) {
    if (segments.length === 0) return node
    const [head, ...rest] = segments
    if (node === null || node === undefined) return MISSING
    if (Array.isArray(node)) {
        if (head === '#') return walk(node.length, rest)
        if (head === '*') {
            const mapped = node.map((item) => walk(item, rest))
            return mapped.some((item) => item === MISSING) ? MISSING : mapped
        }
        if (/^\d+$/.test(head)) {
            const index = Number(head)
            return index < node.length ? walk(node[index], rest) : MISSING
        }
        return MISSING
    }
    if (typeof node === 'object') {
        if (head === '#') return walk(Object.keys(node).length, rest)
        if (!Object.hasOwn(node, head)) return MISSING
        return walk(node[head], rest)
    }
    if (typeof node === 'string' && head === '#') return walk(node.length, rest)
    return MISSING
}

function hexOf(buffer) {
    return Buffer.from(buffer).toString('hex')
}

function buildSynthetic(spec) {
    if (spec.kind === 'large') {
        const document = { _id: { $numberInt: '9001' } }
        for (let index = 0; index < (spec.fields ?? 1); index += 1) {
            document[`f${index}`] = { $numberInt: String(index) }
        }
        document.pad = 'x'.repeat(spec.bytes)
        return document
    }
    if (spec.kind === 'deep') {
        let node = { v: { $numberInt: '1' } }
        for (let index = 0; index < spec.depth; index += 1) node = { child: node }
        return { _id: { $numberInt: '9002' }, deep: node }
    }
    if (spec.kind === 'wide') {
        const document = { _id: { $numberInt: '9003' } }
        for (let index = 0; index < spec.fields; index += 1) {
            document[`f${String(index).padStart(4, '0')}`] = { $numberInt: String(index) }
        }
        return document
    }
    if (spec.kind === 'series') {
        return Array.from({ length: spec.count }, (_, index) => ({
            _id: { $numberInt: String((spec.offset ?? 0) + index) },
            v: `v${(spec.offset ?? 0) + index}`,
        }))
    }
    throw new Error(`unknown synthetic kind ${spec.kind}`)
}

function commandText(testCase, step, command) {
    if (testCase.noDb) return JSON.stringify(command)
    return JSON.stringify({ ...command, $db: step.db ?? testCase.db ?? 'app' })
}

function runCase(testCase) {
    const directory = mkdtempSync(join(tmpdir(), `mongo-ts-${testCase.id.replace(/[^\w.-]+/g, '-')}-`))
    const stores = new Map()
    let cursors = null
    const outputs = {}
    const started = process.hrtime.bigint()

    const storeOf = (name = 's') => {
        const key = name ?? 's'
        if (!stores.has(key)) throw new Error(`store ${key} is not open`)
        return stores.get(key).handle
    }
    const cursorTable = () => {
        if (!cursors) cursors = new binding.MongoCursors()
        return cursors
    }
    const fileOf = (name = 's') => {
        const entry = stores.get(name ?? 's')
        if (!entry) throw new Error(`store ${name} is not open`)
        return entry.path
    }

    const execute = (step) => {
        switch (step.op) {
            case 'open': {
                const name = step.store ?? 's'
                const path = join(directory, `${name}.yykv`)
                stores.set(name, { path, handle: new binding.MongoStore(path) })
                return { path }
            }
            case 'reopen': {
                const name = step.store ?? 's'
                const entry = stores.get(name)
                if (!entry) throw new Error(`store ${name} is not open`)
                entry.handle = new binding.MongoStore(entry.path)
                return { path: entry.path }
            }
            case 'close': {
                stores.delete(step.store ?? 's')
                return null
            }
            case 'fileSize':
                return statSync(fileOf(step.store)).size
            case 'dataFiles':
                return readdirSync(directory).sort()
            case 'insert': {
                const command = { insert: step.collection }
                if (step.omitDocuments !== true) {
                    let documents = step.documents
                    if (step.synthetic) {
                        const built = buildSynthetic(step.synthetic)
                        documents = Array.isArray(built) ? built : [built]
                    }
                    command.documents = documents
                }
                if (step.ordered !== undefined) command.ordered = step.ordered
                return JSON.parse(binding.insert(storeOf(step.store), commandText(testCase, step, command)))
            }
            case 'find': {
                const command = { find: step.collection }
                for (const key of ['filter', 'projection', 'sort', 'skip', 'limit', 'batchSize']) {
                    if (step[key] !== undefined) command[key] = step[key]
                }
                return JSON.parse(binding.find(storeOf(step.store), cursorTable(), commandText(testCase, step, command)))
            }
            case 'count': {
                const command = { count: step.collection }
                for (const key of ['query', 'skip', 'limit']) {
                    if (step[key] !== undefined) command[key] = step[key]
                }
                return JSON.parse(binding.count(storeOf(step.store), commandText(testCase, step, command)))
            }
            case 'aggregate': {
                const command = { aggregate: step.collection, pipeline: step.pipeline, cursor: {} }
                return JSON.parse(binding.aggregate(storeOf(step.store), commandText(testCase, step, command)))
            }
            case 'delete': {
                const command = { delete: step.collection, deletes: step.deletes }
                return JSON.parse(binding.delete(storeOf(step.store), commandText(testCase, step, command)))
            }
            case 'update': {
                const command = { update: step.collection, updates: step.updates }
                return JSON.parse(binding.update(storeOf(step.store), commandText(testCase, step, command)))
            }
            case 'getMore': {
                const command = { getMore: step.id, collection: step.collection }
                if (step.batchSize !== undefined) command.batchSize = step.batchSize
                return JSON.parse(binding.getMore(cursorTable(), commandText(testCase, step, command)))
            }
            case 'killCursors': {
                const command = { killCursors: step.collection, cursors: step.ids }
                return JSON.parse(binding.killCursors(cursorTable(), commandText(testCase, step, command)))
            }
            case 'listCollections': {
                const command = { listCollections: 1 }
                if (step.filter !== undefined) command.filter = step.filter
                return JSON.parse(binding.listCollections(storeOf(step.store), commandText(testCase, step, command)))
            }
            case 'createIndexes': {
                const command = { createIndexes: step.collection }
                if (step.omitIndexes !== true) command.indexes = step.indexes
                return JSON.parse(binding.createIndexes(storeOf(step.store), commandText(testCase, step, command)))
            }
            case 'listIndexes': {
                const command = { listIndexes: step.collection }
                return JSON.parse(binding.listIndexes(storeOf(step.store), commandText(testCase, step, command)))
            }
            case 'dropIndexes': {
                const command = { dropIndexes: step.collection }
                if (step.index !== undefined) command.index = step.index
                return JSON.parse(binding.dropIndexes(storeOf(step.store), commandText(testCase, step, command)))
            }
            case 'listDatabases':
                return JSON.parse(binding.listDatabases(storeOf(step.store)))
            case 'hello':
                return JSON.parse(binding.hello())
            case 'ping':
                return JSON.parse(binding.ping())
            case 'errorReply':
                return JSON.parse(binding.errorReply(step.code, step.message))
            case 'commandName':
                return binding.commandName(JSON.stringify(step.document))
            case 'commandNameRaw':
                return binding.commandName(step.text)
            case 'encodeDocument':
                return hexOf(binding.encodeDocument(JSON.stringify(step.document)))
            case 'encodeDocumentRaw':
                return hexOf(binding.encodeDocument(step.text))
            case 'decodeDocument':
                return JSON.parse(binding.decodeDocument(Buffer.from(step.hex, 'hex')))
            case 'encodeOpMsg':
                return hexOf(binding.encodeOpMsg(JSON.stringify(step.document)))
            case 'decodeOpMsg':
                return JSON.parse(binding.decodeOpMsg(Buffer.from(step.hex, 'hex')))
            case 'decodeOpQuery':
                return JSON.parse(binding.decodeOpQuery(Buffer.from(step.hex, 'hex')))
            case 'importBson':
                return binding.importBson(storeOf(step.store), step.namespace, Buffer.from(step.hex, 'hex'))
            case 'importBsonFile': {
                const path = join(directory, `${step.file ?? 'dump'}.bson`)
                writeFileSync(path, Buffer.from(step.hex, 'hex'))
                return binding.importBsonFile(storeOf(step.store), step.namespace, path)
            }
            case 'cursorsLen':
                return cursorTable().len()
            case 'writeBytes':
                writeFileSync(join(directory, step.path), Buffer.from(step.hex, 'hex'))
                return null
            case 'readBytes':
                return readFileSync(join(directory, step.path)).toString('hex')
            case 'removeFile':
                rmSync(join(directory, step.path), { force: true })
                return null
            case 'verifyCatalog': {
                const path = join(directory, step.path)
                const run = spawnSync(process.execPath, [yydsVerifier, path], { encoding: 'utf8' })
                if (run.error) throw run.error
                if (run.status !== 0) throw new Error(`yyds verifier exited with ${run.status}: ${run.stderr}`)
                return JSON.parse(run.stdout)
            }
            case 'repairShard':
                return JSON.parse(binding.repairShard(join(directory, `${step.store ?? 's'}.yykv`)))
            case 'cli': {
                const dataDir = join(directory, step.dir ?? 'data')
                mkdirSync(dataDir, { recursive: true })
                const run = spawnSync(process.execPath, [cliEntry, '--data-dir', dataDir, '--db', step.db ?? testCase.db ?? 'app'], {
                    input: `${step.commands.join('\n')}\n`,
                    encoding: 'utf8',
                })
                if (run.error) throw run.error
                if (run.status !== 0) throw new Error(`cli exited with ${run.status}: ${run.stderr}`)
                const lines = run.stdout
                    .split(/\r?\n/)
                    .filter((line) => line.trim() !== '')
                    .map((line) => JSON.parse(line))
                return { exitCode: run.status, lines }
            }
            default:
                throw new Error(`unknown case op ${step.op}`)
        }
    }

    for (const step of testCase.program) {
        const name = step.as
        try {
            const value = execute(step)
            if (name) outputs[name] = value
        } catch (error) {
            if (name) outputs[name] = { __threw: String(error.message ?? error) }
        }
    }

    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6
    const failures = []
    let assertions = 0

    for (const check of testCase.checks) {
        assertions += 1
        const result = evaluate(check, outputs, elapsedMs)
        if (!result.pass) failures.push({ case: testCase.id, check, expected: result.expected, actual: result.actual })
    }

    return {
        id: testCase.id,
        surface: testCase.surface,
        assertions,
        failures,
        outputs: Object.fromEntries(Object.entries(outputs).map(([key, value]) => [key, stable(value)])),
        elapsedMs: Math.round(elapsedMs * 1000) / 1000,
    }
}

function evaluate(check, outputs, elapsedMs) {
    if (check.elapsedLt !== undefined) {
        const pass = elapsedMs < check.elapsedLt
        return { pass, expected: `< ${check.elapsedLt}ms`, actual: `${elapsedMs}ms` }
    }
    const [rootName, ...rest] = check.at.replace(/^\//, '').split('/')
    const root = outputs[rootName]
    const actual = root === undefined ? MISSING : walk(root, rest)
    const describe = (value) => (value === MISSING ? '<missing>' : value)

    if (check.throws === true) {
        const threw = root && typeof root === 'object' && '__threw' in root
        return { pass: Boolean(threw), expected: 'throws', actual: describe(root) }
    }
    if (check.errorContains !== undefined) {
        const message = root && typeof root === 'object' && '__threw' in root ? root.__threw : ''
        return { pass: String(message).includes(check.errorContains), expected: `error contains ${check.errorContains}`, actual: message || describe(root) }
    }
    if (root && typeof root === 'object' && '__threw' in root) {
        return { pass: false, expected: check.equals ?? 'value', actual: `threw: ${root.__threw}` }
    }
    if (check.absent === true) {
        return { pass: actual === MISSING, expected: '<missing>', actual: describe(actual) }
    }
    if (check.matches !== undefined) {
        const pass = typeof actual === 'string' && new RegExp(check.matches).test(actual)
        return { pass, expected: `/${check.matches}/`, actual: describe(actual) }
    }
    if (check.equals !== undefined) {
        const pass = actual !== MISSING && stable(actual) === stable(check.equals)
        return { pass, expected: check.equals, actual: describe(actual) }
    }
    for (const [operator, comparison] of [
        ['gte', (left, right) => left >= right],
        ['lte', (left, right) => left <= right],
        ['gt', (left, right) => left > right],
        ['lt', (left, right) => left < right],
    ]) {
        if (check[operator] !== undefined) {
            const pass = typeof actual === 'number' && comparison(actual, check[operator])
            return { pass, expected: `${operator} ${check[operator]}`, actual: describe(actual) }
        }
    }
    throw new Error(`unsupported check ${JSON.stringify(check)}`)
}

const files = readdirSync(caseDir)
    .filter((name) => name.endsWith('.json'))
    .sort()
const cases = files.flatMap((name) => {
    const payload = JSON.parse(readFileSync(join(caseDir, name), 'utf8'))
    return payload.cases.map((testCase) => ({ ...testCase, file: name }))
})

const results = cases.map(runCase)
const totalAssertions = results.reduce((sum, item) => sum + item.assertions, 0)
const failed = results.flatMap((item) => item.failures)

const surfaces = {}
for (const item of results) {
    surfaces[item.surface] ??= { cases: 0, assertions: 0 }
    surfaces[item.surface].cases += 1
    surfaces[item.surface].assertions += item.assertions
}

const summary = {
    language: 'ts',
    binding: `@yydb/mongo-${platform}`,
    cases: results.length,
    assertions: totalAssertions,
    passed: totalAssertions - failed.length,
    failed: failed.length,
    skipped: 0,
    surfaces,
    failures: failed,
    results,
}

mkdirSync(dirname(outputPath), { recursive: true })
writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`)

console.log(`ts: ${results.length} cases, ${totalAssertions} assertions, ${failed.length} failed`)
for (const [surface, stats] of Object.entries(surfaces)) {
    console.log(`  ${surface}: ${stats.cases} cases / ${stats.assertions} assertions`)
}
for (const failure of failed.slice(0, 40)) {
    console.log(`FAIL ${failure.case} ${failure.check.at ?? ''} expected=${stable(failure.expected)} actual=${stable(failure.actual)}`)
}
if (failed.length > 40) console.log(`... ${failed.length - 40} more failures`)

process.exitCode = failed.length === 0 ? 0 : 1
