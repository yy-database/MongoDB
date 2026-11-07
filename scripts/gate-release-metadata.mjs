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
check(main.license === 'MPL-2.0', `npm main license is ${main.license}`)
check(typeof main.homepage === 'string' && main.homepage.startsWith('https://github.com/yy-database/MongoDB'), 'npm main homepage is missing or points elsewhere')
check(typeof main.bugs?.url === 'string' && main.bugs.url.includes('github.com/yy-database/MongoDB'), 'npm main bugs url is missing or points elsewhere')
check(Array.isArray(main.keywords) && main.keywords.length > 0, 'npm main keywords are missing')
check((main.files ?? []).includes('dist'), 'npm main `files` does not include `dist`')
check((main.files ?? []).includes('bin'), 'npm main `files` does not include `bin`')

const entry = (main.exports ?? {})['.'] ?? {}
check(entry.types === './dist/index.d.ts', 'exports[.].types is not ./dist/index.d.ts')
check(entry.import === './dist/index.js', 'exports[.].import is not ./dist/index.js')
check(entry.default === './dist/index.js', 'exports[.].default is not ./dist/index.js')
check(entry.require === undefined, 'exports[.].require must not exist for the ESM-only package')
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
const nativeDirs = platformDirs.filter((dir) => !dir.includes('unknown-wasm32'))
check(Object.keys(optional).length === nativeDirs.length, `optionalDependencies has ${Object.keys(optional).length} entries for ${nativeDirs.length} native platform packages`)

for (const dir of platformDirs) {
    const manifestPath = `projects/mongo.ts/platforms/${dir}/package.json`
    const platform = readJson(manifestPath)
    check(platform.name === `@yydb/mongodb-${dir.slice('mongo-'.length)}`, `${dir}: package name is ${platform.name}`)
    check(platform.version === rootVersion, `${dir}: version ${platform.version} != workspace ${rootVersion}`)
    check(platform.private === main.private, `${dir}: private flag differs from the main package`)
    check(platform.license === main.license, `${dir}: license ${platform.license} differs from the main package`)
    if (dir.includes('unknown-wasm32')) {
        // The wasm package holds a placeholder binding, so npm must never pull
        // it automatically: without os/cpu it would be installed everywhere.
        check(optional[platform.name] === undefined, `${dir}: placeholder package must not be listed in optionalDependencies`)
        continue
    }
    check(optional[platform.name] === rootVersion, `${dir}: optionalDependencies pins ${optional[platform.name]} instead of ${rootVersion}`)
    const [, os, cpu] = dir.split('-')
    check((platform.os ?? []).join(',') === os, `${dir}: os ${JSON.stringify(platform.os)} != ${os}`)
    check((platform.cpu ?? []).join(',') === cpu, `${dir}: cpu ${JSON.stringify(platform.cpu)} != ${cpu}`)
}

const pyproject = readText('projects/mongo.py/packages/mongo/pyproject.toml')
const pyVersion = pyproject.match(/^version = "([^"]+)"/m)?.[1]
check(pyVersion === rootVersion, `pyproject version ${pyVersion} != workspace ${rootVersion}`)
check(pyproject.includes('manifest-path = "../../../mongo.rs/mongo-pyo3/Cargo.toml"'), 'pyproject manifest-path does not point at mongo-pyo3')
check(pyproject.includes('license = "MPL-2.0"'), 'pyproject license is not the MPL-2.0 SPDX expression')
check(pyproject.includes('license-files = ["License.md"]'), 'pyproject license-files does not ship License.md')
check(/^authors = \[{ name = "([^"]+)" }\]/m.test(pyproject), 'pyproject authors are missing')
const pyUrls = pyproject.match(/^\[project\.urls\]\n([^\[]*)/m)?.[1] ?? ''
check(pyUrls.includes('Homepage = "https://github.com/yy-database/MongoDB"'), 'pyproject Homepage url is missing or points elsewhere')
check(pyUrls.includes('Repository = "https://github.com/yy-database/MongoDB.git"'), 'pyproject Repository url is missing or points elsewhere')
check(pyproject.includes('readme = "README.md"'), 'pyproject readme is not README.md')
const pyReadmePath = 'projects/mongo.py/packages/mongo/README.md'
check(existsSync(join(root, pyReadmePath)), `python package README ${pyReadmePath} is missing`)
if (existsSync(join(root, pyReadmePath))) {
    const pyReadme = readText(pyReadmePath)
    check(pyReadme.startsWith('# `yydb-mongo`'), 'python package README does not open with the package title')
    check(pyReadme.includes('https://github.com/yy-database/MongoDB'), 'python package README does not link to the repository')
}

const cargo = readText('projects/mongo.rs/Cargo.toml')
const cargoVersion = cargo.match(/\[workspace\.package\][^\[]*?version = "([^"]+)"/s)?.[1]
check(cargoVersion === rootVersion, `Cargo workspace version ${cargoVersion} != workspace ${rootVersion}`)

const changelogPath = 'CHANGELOG.md'
check(existsSync(join(root, changelogPath)), `${changelogPath} is missing`)
if (existsSync(join(root, changelogPath))) {
    const changelog = readText(changelogPath)
    check(changelog.startsWith('# Changelog'), 'CHANGELOG.md does not open with the Changelog title')
    const versions = [...changelog.matchAll(/^## (\d+\.\d+\.\d+)$/gm)].map((match) => match[1])
    check(versions.length > 0, 'CHANGELOG.md has no version heading')
    check(versions[0] === rootVersion, `CHANGELOG.md newest version ${versions[0]} != workspace ${rootVersion}`)
    check(new Set(versions).size === versions.length, 'CHANGELOG.md repeats a version heading')
    const section = changelog.split(new RegExp(`^## ${rootVersion.replace(/\./g, '\\.')}$`, 'm'))[1] ?? ''
    check(section.split('\n').some((line) => line.startsWith('### ')), `CHANGELOG.md ${rootVersion} section has no subsections`)
}

// Every publishable package must carry the license text: npm only auto-includes
// LICENSE files that sit in the package directory, and maturin ships whatever
// `license-files` names.
const licenseText = readText('License.md')
const licenseCopies = [
    'projects/mongo.ts/packages/mongo/License.md',
    'projects/mongo.py/packages/mongo/License.md',
    ...platformDirs.map((dir) => `projects/mongo.ts/platforms/${dir}/License.md`),
]
for (const relative of licenseCopies) {
    const present = existsSync(join(root, relative))
    check(present, `${relative} is missing`)
    if (present) check(readText(relative) === licenseText, `${relative} differs from the root License.md`)
}

if (failures.length > 0) {
    for (const failure of failures) console.error(`release metadata: ${failure}`)
    process.exit(1)
}
console.log(`RELEASE METADATA OK (version ${rootVersion}, platforms ${platformDirs.length})`)
