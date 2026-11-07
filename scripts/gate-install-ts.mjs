// Installation-state gate: the published tarball must work from plain Node.
//
// Packs `@yydb/mongodb` and its current-platform binary package into the
// system temp directory, installs both with npm there, then imports the
// package with a bare `node` process (no TypeScript loader) and executes a
// real call. This catches `exports` that only work inside the workspace.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const packageDir = join(root, 'projects', 'mongo.ts', 'packages', 'mongo')
const platformName = `mongo-${process.platform}-${process.arch}`
const platformDir = join(root, 'projects', 'mongo.ts', 'platforms', platformName)
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

if (!existsSync(platformDir)) {
    console.error(`missing platform package for this host: ${platformName}`)
    process.exit(1)
}

const work = mkdtempSync(join(tmpdir(), 'mongo-install-ts-'))
const run = (command, args, cwd) => {
    const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
    if (result.status !== 0) {
        console.error(`failed: ${command} ${args.join(' ')}`)
        process.exit(result.status ?? 1)
    }
}

run(pnpm, ['--dir', packageDir, 'pack', '--pack-destination', work], root)
run(pnpm, ['--dir', platformDir, 'pack', '--pack-destination', work], root)
const tarballs = readdirSync(work).filter((name) => name.endsWith('.tgz'))
if (tarballs.length !== 2) {
    console.error(`expected 2 tarballs, found ${tarballs.join(', ')}`)
    process.exit(1)
}
writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'install-probe', private: true, type: 'module' }))
run(npm, ['install', '--no-audit', '--no-fund', ...tarballs], work)

writeFileSync(join(work, 'probe.mjs'), `
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mod = await import('@yydb/mongodb')
const raw = Buffer.from('install probe payload')

const packed = mod.snappyCompress(raw)
const back = Buffer.from(mod.snappyDecompress(packed, raw.length))
if (!back.equals(raw)) throw new Error('snappy roundtrip mismatch')

for (const [name, id] of Object.entries(mod.COMPRESSOR_IDS)) {
    const body = mod.compress(id, raw)
    const decoded = Buffer.from(mod.decompress(id, body, raw.length))
    if (!decoded.equals(raw)) throw new Error(name + ' roundtrip mismatch')
}

const dataDir = mkdtempSync(join(tmpdir(), 'mongo-installed-'))
const server = mod.createServer({ dataDir, port: 0, host: '127.0.0.1' })
await server.listening
await server.close()

console.log('install-state ok: exports=' + Object.keys(mod).length + ' compressors=' + mod.SUPPORTED_COMPRESSORS.join(','))
`)
run('node', ['probe.mjs'], work)

// The tarball also publishes two executables. Running them here proves the
// `bin` entries resolve against the installed `dist` tree instead of the
// checkout's TypeScript sources.
writeFileSync(join(work, 'probe-cli.mjs'), `
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const cli = join(process.cwd(), 'node_modules', '@yydb', 'mongodb', 'bin', 'mongo.mjs')
const daemon = join(process.cwd(), 'node_modules', '@yydb', 'mongodb', 'bin', 'serve.mjs')

const intValue = (value) => Number(value?.$numberInt ?? value?.$numberLong ?? value)

const dataDir = mkdtempSync(join(tmpdir(), 'mongo-cli-'))
const script = [
    'use cli_probe',
    'insertOne(items, {"_id":1,"name":"install","n":7})',
    'find(items, {"_id":1})',
    'countDocuments(items)',
    'updateOne(items, {"_id":1}, {"$inc":{"n":1}})',
    'exit',
].join('\\n') + '\\n'

const piped = spawnSync(process.execPath, [cli, '--data-dir', dataDir], { input: script, encoding: 'utf8' })
if (piped.status !== 0) throw new Error('mongo.mjs exited ' + piped.status + ': ' + piped.stderr)
const lines = piped.stdout.trim().split(/\\r?\\n/)
if (lines.length !== 6) throw new Error('expected 6 reply lines, got ' + lines.length + ': ' + piped.stdout)
const replies = lines.map((line) => JSON.parse(line))

if (replies[0].db !== 'cli_probe') throw new Error('use did not switch database')
if (intValue(replies[1].n) !== 1) throw new Error('insertOne did not report one inserted document')
const batch = replies[2].cursor?.firstBatch
if (!Array.isArray(batch) || batch.length !== 1) throw new Error('find did not return the inserted document')
if (batch[0].name !== 'install' || intValue(batch[0].n) !== 7) throw new Error('find returned the wrong document')
if (intValue(replies[3].n) !== 1) throw new Error('countDocuments did not count the document')
if (intValue(replies[4].nModified) !== 1) throw new Error('updateOne did not modify the document')
if (replies[5].bye !== true) throw new Error('exit did not terminate the shell')

const address = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [daemon, '--data-dir', mkdtempSync(join(tmpdir(), 'mongo-serve-')), '--port', '0'], {
        stdio: ['ignore', 'pipe', 'inherit'],
    })
    let buffer = ''
    const timer = setTimeout(() => reject(new Error('serve.mjs printed no ready line within 20s')), 20000)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
        buffer += chunk
        const end = buffer.indexOf('\\n')
        if (end < 0) return
        clearTimeout(timer)
        try {
            resolve({ child, ready: JSON.parse(buffer.slice(0, end)) })
        } catch (error) {
            reject(error)
        }
    })
    child.on('exit', (code) => {
        clearTimeout(timer)
        reject(new Error('serve.mjs exited ' + code + ' before binding'))
    })
})

if (address.ready.ready !== true || typeof address.ready.port !== 'number' || address.ready.port <= 0) {
    throw new Error('serve.mjs ready line is ' + JSON.stringify(address.ready))
}

await new Promise((resolve, reject) => {
    const socket = net.connect(address.ready.port, address.ready.host ?? '127.0.0.1')
    socket.on('connect', () => {
        socket.end()
        resolve()
    })
    socket.on('error', reject)
})

address.child.kill('SIGTERM')
await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('serve.mjs did not stop within 10s')), 10000)
    address.child.on('exit', () => {
        clearTimeout(timer)
        resolve()
    })
})

console.log('install-cli ok: mongo.mjs commands=6 serve.mjs port=' + address.ready.port)
`)
run('node', ['probe-cli.mjs'], work)
console.log(`INSTALL TS OK (${work})`)
