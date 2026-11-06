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
console.log(`INSTALL TS OK (${work})`)
