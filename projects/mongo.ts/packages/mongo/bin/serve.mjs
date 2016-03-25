#!/usr/bin/env node
// Starts the wire-protocol listener. Prints one JSON line once it is bound,
// which is what the acceptance runners wait on.
//
// usage: node bin/serve.mjs --data-dir <dir> [--port <n>] [--host <addr>]
//                            [--compressors snappy,zlib,zstd] [--auth]
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const built = resolve(here, '..', 'dist', 'server.js')
// Installed packages ship `dist`; a checkout that has not built yet falls back
// to the TypeScript sources (Node strips types natively).
const { createServer } = await import(
    pathToFileURL(existsSync(built) ? built : resolve(here, '..', 'src', 'server.ts')).href
)

const args = process.argv.slice(2)
const option = (name) => {
    const index = args.indexOf(`--${name}`)
    return index >= 0 && args[index + 1] ? args[index + 1] : undefined
}

const dataDir = option('data-dir')
if (!dataDir) {
    console.error('missing --data-dir')
    process.exit(2)
}
const port = Number(option('port') ?? '27017')
const host = option('host') ?? '127.0.0.1'
const compressors = option('compressors')?.split(',').filter(Boolean)
const auth = args.includes('--auth')

const server = createServer({ dataDir, port, host, compressors, auth })
const address = await server.listening
console.log(JSON.stringify({ ready: true, host: address.host, port: address.port }))

const shutdown = async () => {
    await server.close()
    process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
