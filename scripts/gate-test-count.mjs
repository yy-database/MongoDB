// Acceptance gate: both languages must hit the same corpus, pass every
// assertion, and produce byte-identical per-case outputs (no single-side pass).
// Floor verdicts run in `database.harness` through the napi primitive
// `harnessSuiteVerdict`; parsing of the summaries and the parity comparison
// stay here.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const resultsDir = join(repo, '.tmp', 'test-results')
const binding = createRequire(import.meta.url)(
    join(repo, 'projects', 'mongo.ts', 'platforms', `mongo-${process.platform}-${process.arch}`),
)

// A single-language lane only has that language's results on disk. Pass
// `--language ts|py` to gate one lane, or omit it to gate both plus parity.
const languageIndex = process.argv.indexOf('--language')
const language = languageIndex === -1 ? null : process.argv[languageIndex + 1]
if (language !== null && language !== 'ts' && language !== 'py') {
    console.error(`unknown --language ${language}`)
    process.exit(2)
}
const requested = language ? [language] : ['ts', 'py']
const summaries = Object.fromEntries(
    requested.map((name) => [name, JSON.parse(readFileSync(join(resultsDir, `${name}.json`), 'utf8'))]),
)
const ts = summaries.ts
const py = summaries.py

// Measured floors: keep this number in sync with reality, never lower it.
const MIN_ASSERTIONS = 2894
const MIN_CASES = 850

const problems = []
for (const name of requested) {
    const summary = summaries[name]
    const gate = JSON.parse(binding.harnessSuiteVerdict(
        JSON.stringify({
            cases: summary.cases,
            assertions: summary.assertions,
            passed: Math.max(summary.assertions - summary.failed - summary.skipped, 0),
            failed: summary.failed,
            skipped: summary.skipped,
        }),
        JSON.stringify([{ metric: 'assertions', min: MIN_ASSERTIONS }, { metric: 'cases', min: MIN_CASES }]),
    ))
    const byKind = new Map(gate.problems.map((problem) => [`${problem.kind}:${problem.metric ?? ''}`, problem]))
    if (byKind.has('floor-unmet:assertions')) problems.push(`${name}: ${byKind.get('floor-unmet:assertions').actual} assertions < floor ${byKind.get('floor-unmet:assertions').min}`)
    if (byKind.has('floor-unmet:cases')) problems.push(`${name}: ${byKind.get('floor-unmet:cases').actual} cases < floor ${byKind.get('floor-unmet:cases').min}`)
    if (byKind.has('skipped:')) problems.push(`${name}: ${byKind.get('skipped:').count} skipped assertions`)
    if (byKind.has('failed:')) problems.push(`${name}: ${byKind.get('failed:').count} failed assertions`)
}

const mismatches = []
if (ts && py) {
    const byId = (summary) => new Map(summary.results.map((result) => [result.id, result]))
    const tsCases = byId(ts)
    const pyCases = byId(py)

    for (const id of tsCases.keys()) {
        if (!pyCases.has(id)) problems.push(`parity: ${id} missing from py`)
    }
    for (const id of pyCases.keys()) {
        if (!tsCases.has(id)) problems.push(`parity: ${id} missing from ts`)
    }

    // Server-generated ObjectIds are random by design; every fixture ObjectId stays
    // literal, so only opaque ids are flattened for the parity comparison. The two
    // runners execute in different temporary directories, so catalog and shard
    // paths quoted inside error messages are flattened as well.
    const normalize = (value) =>
        value
            .replace(/"\$oid":"[0-9a-f]{24}"/g, '"$oid":"<generated>"')
            // `hello` reports the wall clock; the two runners never share a millisecond.
            .replace(/"localTime":\{"\$date":\{"\$numberLong":"\d+"\}\}/g, '"localTime":"<now>"')
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
}

console.log(`gate: ts ${ts ? ts.assertions : 'n/a'} assertions / py ${py ? py.assertions : 'n/a'} assertions, ${mismatches.length} cross-language mismatches`)
for (const [surface, stats] of Object.entries((ts ?? py).surfaces)) {
    console.log(`  ${surface}: ${stats.cases} cases / ${stats.assertions} assertions`)
}
if (ts && py) {
    const pyCases = new Map(py.results.map((result) => [result.id, result]))
    const stress = ts.results.filter((result) => result.surface === 'stress')
    for (const result of stress) {
        console.log(`  stress ${result.id}: ts ${result.elapsedMs}ms / py ${pyCases.get(result.id)?.elapsedMs}ms`)
    }
}

if (problems.length > 0) {
    for (const problem of problems.slice(0, 60)) console.log(`GATE FAIL ${problem}`)
    if (problems.length > 60) console.log(`... ${problems.length - 60} more`)
    process.exit(1)
}

console.log('gate: OK')
