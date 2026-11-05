// Acceptance gate: both languages must hit the same corpus, pass every
// assertion, and produce byte-identical per-case outputs (no single-side pass).
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const resultsDir = join(repo, '.tmp', 'test-results')
const ts = JSON.parse(readFileSync(join(resultsDir, 'ts.json'), 'utf8'))
const py = JSON.parse(readFileSync(join(resultsDir, 'py.json'), 'utf8'))

// Measured floors: keep this number in sync with reality, never lower it.
const MIN_ASSERTIONS = 721
const MIN_CASES = 338

const problems = []
for (const [name, summary] of [['ts', ts], ['py', py]]) {
    if (summary.assertions < MIN_ASSERTIONS) {
        problems.push(`${name}: ${summary.assertions} assertions < floor ${MIN_ASSERTIONS}`)
    }
    if (summary.cases < MIN_CASES) problems.push(`${name}: ${summary.cases} cases < floor ${MIN_CASES}`)
    if (summary.skipped !== 0) problems.push(`${name}: ${summary.skipped} skipped assertions`)
    if (summary.failed !== 0) problems.push(`${name}: ${summary.failed} failed assertions`)
}

const byId = (summary) => new Map(summary.results.map((result) => [result.id, result]))
const tsCases = byId(ts)
const pyCases = byId(py)

for (const id of tsCases.keys()) {
    if (!pyCases.has(id)) problems.push(`parity: ${id} missing from py`)
}
for (const id of pyCases.keys()) {
    if (!tsCases.has(id)) problems.push(`parity: ${id} missing from ts`)
}

const mismatches = []
// Server-generated ObjectIds are random by design; every fixture ObjectId stays
// literal, so only opaque ids are flattened for the parity comparison. The two
// runners execute in different temporary directories, so catalog and shard
// paths quoted inside error messages are flattened as well.
const normalize = (value) =>
    value
        .replace(/"\$oid":"[0-9a-f]{24}"/g, '"$oid":"<generated>"')
        .replace(/`[^`"]*(?:\.yyds|\.yykv)`/g, '`<path>`')
for (const [id, tsResult] of tsCases) {
    const pyResult = pyCases.get(id)
    if (!pyResult) continue
    const keys = new Set([...Object.keys(tsResult.outputs), ...Object.keys(pyResult.outputs)])
    for (const key of keys) {
        if (normalize(tsResult.outputs[key] ?? '') !== normalize(pyResult.outputs[key] ?? '')) {
            mismatches.push({ case: id, output: key, ts: tsResult.outputs[key], py: pyResult.outputs[key] })
        }
    }
}

for (const mismatch of mismatches) {
    const trim = (value) => (value.length > 300 ? `${value.slice(0, 300)}...` : value)
    problems.push(`parity: ${mismatch.case}/${mismatch.output} ts=${trim(mismatch.ts)} py=${trim(mismatch.py)}`)
}

for (const surface of Object.keys(ts.surfaces)) {
    const left = ts.surfaces[surface]
    const right = py.surfaces[surface]
    if (!right) {
        problems.push(`parity: surface ${surface} missing from py`)
        continue
    }
    if (left.cases !== right.cases || left.assertions !== right.assertions) {
        problems.push(`parity: surface ${surface} ts=${left.cases}/${left.assertions} py=${right.cases}/${right.assertions}`)
    }
}

console.log(`gate: ts ${ts.assertions} assertions / py ${py.assertions} assertions, ${mismatches.length} cross-language mismatches`)
for (const [surface, stats] of Object.entries(ts.surfaces)) {
    console.log(`  ${surface}: ${stats.cases} cases / ${stats.assertions} assertions`)
}
const stress = ts.results.filter((result) => result.surface === 'stress')
for (const result of stress) {
    console.log(`  stress ${result.id}: ts ${result.elapsedMs}ms / py ${pyCases.get(result.id)?.elapsedMs}ms`)
}

if (problems.length > 0) {
    for (const problem of problems.slice(0, 60)) console.log(`GATE FAIL ${problem}`)
    if (problems.length > 60) console.log(`... ${problems.length - 60} more`)
    process.exit(1)
}

console.log('gate: OK')
