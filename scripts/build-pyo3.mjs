// Builds `mongo-pyo3` and drops the extension module into the Python package.
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const crateDir = join(repo, 'projects', 'mongo.rs')
const packageDir = join(repo, 'projects', 'mongo.py', 'packages', 'mongo', 'mongo')

const artifact = {
    win32: { name: 'mongo_pyo3.dll', extension: 'mongo_pyo3.pyd' },
    darwin: { name: 'libmongo_pyo3.dylib', extension: 'mongo_pyo3.so' },
    linux: { name: 'libmongo_pyo3.so', extension: 'mongo_pyo3.so' },
}[process.platform]

if (!artifact) {
    throw new Error(`unsupported platform ${process.platform}`)
}

execFileSync('cargo', ['build', '--release', '-p', 'mongo-pyo3'], { cwd: crateDir, stdio: 'inherit' })

const source = join(resolve(crateDir, process.env.CARGO_TARGET_DIR ?? 'target'), 'release', artifact.name)
if (!existsSync(source)) {
    throw new Error(`missing build artifact ${source}`)
}

mkdirSync(packageDir, { recursive: true })
copyFileSync(source, join(packageDir, artifact.extension))
console.log(`pyo3 module -> ${join(packageDir, artifact.extension)}`)
