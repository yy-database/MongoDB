// Builds `mongo-napi` and drops the addon into the matching platform package.
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const crateDir = join(repo, 'projects', 'mongo.rs')
const platform = `${process.platform}-${process.arch}`
const packageDir = join(repo, 'projects', 'mongo.ts', 'platforms', `mongo-${platform}`)

const artifact = {
    win32: { name: 'mongo_napi.dll' },
    darwin: { name: 'libmongo_napi.dylib' },
    linux: { name: 'libmongo_napi.so' },
}[process.platform]

if (!artifact) {
    throw new Error(`unsupported platform ${process.platform}`)
}

execFileSync('cargo', ['build', '--release', '-p', 'mongo-napi'], { cwd: crateDir, stdio: 'inherit' })

const source = join(crateDir, 'target', 'release', artifact.name)
if (!existsSync(source)) {
    throw new Error(`missing build artifact ${source}`)
}

mkdirSync(join(packageDir, 'lib'), { recursive: true })
copyFileSync(source, join(packageDir, 'lib', 'mongo.node'))
console.log(`napi addon -> ${join(packageDir, 'lib', 'mongo.node')}`)
