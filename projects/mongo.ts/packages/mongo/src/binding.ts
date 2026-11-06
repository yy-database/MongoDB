// Resolves the platform addon the same way `bin/mongo.mjs` does: installed
// packages go through the platform dependency, a plain checkout falls back to
// the repository path. Every MongoDB semantic still lives in Rust.
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const platform = `${process.platform}-${process.arch}`
const platformPackage = `@yydb/mongodb-${platform}`
const require = createRequire(import.meta.url)

function loadBinding(): any {
    try {
        return require(platformPackage)
    } catch (error) {
        const repo = resolve(packageRoot, '..', '..', '..', '..')
        const local = join(repo, 'projects', 'mongo.ts', 'platforms', `mongo-${platform}`, 'index.js')
        if (existsSync(local)) return require(local)
        throw new Error(`cannot resolve ${platformPackage}: install the matching platform package (${(error as Error).message})`)
    }
}

export const binding: any = loadBinding()
