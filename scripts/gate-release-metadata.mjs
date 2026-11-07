// Release-metadata gate: every publishable artifact must agree on one version,
// the main package must point at the local platform packages by that exact
// version, and compiled entry points must stay outside the source tree.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const failures = []
const check = (condition, message) => {
    if (!condition) failures.push(message)
}
const readJson = (relative) => JSON.parse(readFileSync(join(root, relative), 'utf8'))
const readText = (relative) => readFileSync(join(root, relative), 'utf8')

const rootVersion = readJson('package.json').version
check(rootVersion !== '0.0.0', 'workspace version is still the 0.0.0 placeholder')

const main = readJson('projects/mongo.ts/packages/mongo/package.json')
const platformRoot = join(root, 'projects/mongo.ts/platforms')
const platformDirs = readdirSync(platformRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)

check(main.version === rootVersion, `npm main version ${main.version} != workspace ${rootVersion}`)
check(main.private === true, 'npm main package is not marked private')
check((main.files ?? []).includes('dist'), 'npm main `files` does not include `dist`')
check((main.files ?? []).includes('bin'), 'npm main `files` does not include `bin`')

const entry = (main.exports ?? {})['.'] ?? {}
check(entry.types === './dist/index.d.ts', 'exports[.].types is not ./dist/index.d.ts')
check(entry.import === './dist/index.js', 'exports[.].import is not ./dist/index.js')
for (const [condition, target] of Object.entries(entry)) {
    const source = typeof target === 'string' && target.endsWith('.ts') && !target.endsWith('.d.ts')
    check(!source, `exports[.].${condition} points at TypeScript source`)
    check(typeof target === 'string' && target.startsWith('./dist/'), `exports[.].${condition} leaves dist`)
}
for (const [name, target] of Object.entries(main.bin ?? {})) {
    check(existsSync(join(root, 'projects/mongo.ts/packages/mongo', target)), `bin ${name} target ${target} is missing`)
}
check(existsSync(join(root, 'projects/mongo.ts/packages/mongo/dist/index.js')), 'dist/index.js is missing, run build:ts first')
check(existsSync(join(root, 'projects/mongo.ts/packages/mongo/dist/index.d.ts')), 'dist/index.d.ts is missing, run build:ts first')

const compilerPackages = ['typescript', '@types/node']
for (const name of compilerPackages) {
    check(!(main.dependencies ?? {})[name], `compiler package ${name} leaked into dependencies`)
    check((main.devDependencies ?? {})[name], `compiler package ${name} is missing from devDependencies`)
}

const optional = main.optionalDependencies ?? {}
check(Object.keys(optional).length === platformDirs.length, `optionalDependencies has ${Object.keys(optional).length} entries for ${platformDirs.length} platform packages`)

for (const dir of platformDirs) {
    const manifestPath = `projects/mongo.ts/platforms/${dir}/package.json`
    const platform = readJson(manifestPath)
    check(platform.name === `@yydb/mongodb-${dir.slice('mongo-'.length)}`, `${dir}: package name is ${platform.name}`)
    check(platform.version === rootVersion, `${dir}: version ${platform.version} != workspace ${rootVersion}`)
    check(optional[platform.name] === rootVersion, `${dir}: optionalDependencies pins ${optional[platform.name]} instead of ${rootVersion}`)
    check(platform.private === main.private, `${dir}: private flag differs from the main package`)
    if (!dir.includes('unknown-wasm32')) {
        const [, os, cpu] = dir.split('-')
        check((platform.os ?? []).join(',') === os, `${dir}: os ${JSON.stringify(platform.os)} != ${os}`)
        check((platform.cpu ?? []).join(',') === cpu, `${dir}: cpu ${JSON.stringify(platform.cpu)} != ${cpu}`)
    }
}

const pyproject = readText('projects/mongo.py/packages/mongo/pyproject.toml')
const pyVersion = pyproject.match(/^version = "([^"]+)"/m)?.[1]
check(pyVersion === rootVersion, `pyproject version ${pyVersion} != workspace ${rootVersion}`)
check(pyproject.includes('manifest-path = "../../../mongo.rs/mongo-pyo3/Cargo.toml"'), 'pyproject manifest-path does not point at mongo-pyo3')

const cargo = readText('projects/mongo.rs/Cargo.toml')
const cargoVersion = cargo.match(/\[workspace\.package\][^\[]*?version = "([^"]+)"/s)?.[1]
check(cargoVersion === rootVersion, `Cargo workspace version ${cargoVersion} != workspace ${rootVersion}`)

if (failures.length > 0) {
    for (const failure of failures) console.error(`release metadata: ${failure}`)
    process.exit(1)
}
console.log(`RELEASE METADATA OK (version ${rootVersion}, platforms ${platformDirs.length})`)
