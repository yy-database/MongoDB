#!/usr/bin/env node
// Minimal `mongosh`-style command line over the napi primitives.
//
// This file contains no MongoDB semantics: every command is lowered to one
// primitive exported by `mongo-napi` (`insert` / `find` / `count` / `update` /
// `delete` / `listCollections` / `listDatabases`). It does not spawn a server,
// does not evaluate JavaScript, and rejects everything outside the documented
// command surface.
//
// Pipe mode: `node bin/mongo.mjs --data-dir <dir>` reads one command per line
// from stdin and prints exactly one JSON line per command (errors included).
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..', '..', '..', '..', '..')
const require = createRequire(import.meta.url)
const binding = require(join(repo, 'projects', 'mongo.ts', 'platforms', `mongo-${process.platform}-${process.arch}`, 'index.js'))

class CliError extends Error {
    constructor(code, message) {
        super(message)
        this.code = code
    }
}

const COMMAND_NAMES = [
    'use',
    'show dbs',
    'show collections',
    'insertOne',
    'insertMany',
    'find',
    'updateOne',
    'updateMany',
    'deleteOne',
    'deleteMany',
    'countDocuments',
    'exit',
    'quit',
]

const HELP = `yydb mongo shell (minimal)

usage: mongo.mjs --data-dir <dir> [--db <name>] [--script <file>]

Commands (one per line in pipe mode, one JSON line of output each):
  use <db>
  show dbs
  show collections
  insertOne(<collection>, <document>)
  insertMany(<collection>, [<document>, ...])
  find(<collection>, [<filter>], [<projection>])[.sort(<doc>)][.skip(<n>)][.limit(<n>)]
  updateOne(<collection>, <filter>, <update>)
  updateMany(<collection>, <filter>, <update>)
  deleteOne(<collection>, <filter>)
  deleteMany(<collection>, <filter>)
  countDocuments(<collection>, [<filter>])
  exit | quit

Arguments are JSON / Extended JSON; a bare word is taken as a collection name.
Anything else is rejected with {"ok":{"$numberInt":"0"},"code":{"$numberInt":"59"},"errmsg":"unknown command: ..."}.
The store is <data-dir>/mongo.yykv.
`

function json(value) {
    return JSON.stringify(value)
}

function errorLine(error) {
    const code = error instanceof CliError ? error.code : 2
    return json({ ok: { $numberInt: '0' }, code: { $numberInt: String(code) }, errmsg: String((error && error.message) || error) })
}

function unknownCommand(label) {
    return `unknown command: ${label} (supported: ${COMMAND_NAMES.join(', ')})`
}

function parseArgument(piece) {
    const token = piece.trim()
    if (token === '') throw new CliError(2, 'empty argument')
    if (token === 'true' || token === 'false' || token === 'null') return JSON.parse(token)
    if (/^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(token)) return token
    try {
        return JSON.parse(token)
    } catch {
        throw new CliError(2, `invalid JSON argument: ${token}`)
    }
}

function splitArguments(text) {
    if (text.trim() === '') return []
    const pieces = []
    let depth = 0
    let start = 0
    let inString = false
    let escaped = false
    for (let index = 0; index < text.length; index += 1) {
        const character = text[index]
        if (inString) {
            if (escaped) escaped = false
            else if (character === '\\') escaped = true
            else if (character === '"') inString = false
            continue
        }
        if (character === '"') {
            inString = true
            continue
        }
        if (character === '{' || character === '[' || character === '(') depth += 1
        else if (character === '}' || character === ']' || character === ')') depth -= 1
        else if (character === ',' && depth === 0) {
            pieces.push(text.slice(start, index))
            start = index + 1
        }
    }
    if (inString || depth !== 0) throw new CliError(2, 'unbalanced argument list')
    pieces.push(text.slice(start))
    return pieces.map(parseArgument)
}

function readGroup(text, start) {
    let depth = 0
    let inString = false
    let escaped = false
    for (let index = start; index < text.length; index += 1) {
        const character = text[index]
        if (inString) {
            if (escaped) escaped = false
            else if (character === '\\') escaped = true
            else if (character === '"') inString = false
            continue
        }
        if (character === '"') {
            inString = true
            continue
        }
        if (character === '(') depth += 1
        else if (character === ')') {
            depth -= 1
            if (depth === 0) return { content: text.slice(start + 1, index), next: index + 1 }
        }
    }
    throw new CliError(2, 'unbalanced parentheses')
}

function readCall(text, start) {
    const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(text.slice(start))
    if (!match) return null
    const name = match[0]
    let index = start + name.length
    while (index < text.length && text[index] === ' ') index += 1
    if (text[index] !== '(') return null
    const group = readGroup(text, index)
    return { name, args: splitArguments(group.content), next: group.next }
}

function parseCallForm(text) {
    const head = readCall(text, 0)
    if (!head) return null
    const calls = []
    let index = head.next
    while (true) {
        while (index < text.length && text[index] === ' ') index += 1
        if (index >= text.length) break
        if (text[index] !== '.') throw new CliError(2, `unexpected input: ${text.slice(index)}`)
        index += 1
        while (index < text.length && text[index] === ' ') index += 1
        const call = readCall(text, index)
        if (!call) throw new CliError(2, `invalid find method: ${text.slice(index)}`)
        calls.push(call)
        index = call.next
    }
    return { name: head.name, args: head.args, calls }
}

function isDocument(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function collectionArgument(args, index, command) {
    const value = args[index]
    if (typeof value !== 'string' || value === '') {
        throw new CliError(2, `${command} requires a collection name as argument ${index + 1}`)
    }
    return value
}

function documentArgument(args, index, command, label) {
    const value = args[index]
    if (!isDocument(value)) throw new CliError(2, `${command} requires a ${label} as argument ${index + 1}`)
    return value
}

function argumentCount(args, minimum, maximum, command) {
    if (args.length < minimum || args.length > maximum) {
        const expected = minimum === maximum ? `${minimum}` : `${minimum}..${maximum}`
        throw new CliError(2, `${command} expects ${expected} argument(s), got ${args.length}`)
    }
}

function noChain(call) {
    if (call.calls.length > 0) throw new CliError(2, `${call.name} does not accept chained methods`)
}

class Session {
    constructor(store, database) {
        this.store = store
        this.database = database
        this.cursors = new binding.MongoCursors()
    }

    run(line) {
        const text = line.trim()
        if (text === '' || text.startsWith('//') || text.startsWith('#')) return null
        if (text === 'exit' || text === 'quit') {
            return { text: json({ ok: { $numberInt: '1' }, bye: true }), stop: true }
        }
        if (text === 'show dbs') return { text: this.showDatabases() }
        if (text === 'show collections') return { text: this.showCollections() }
        if (text === 'show' || text.startsWith('show ')) throw new CliError(59, unknownCommand(text))
        if (text === 'use' || text.startsWith('use ')) {
            return { text: this.useDatabase(text.slice(3).trim()) }
        }
        const call = parseCallForm(text)
        if (!call) throw new CliError(59, unknownCommand(text))
        return { text: this.dispatch(call) }
    }

    useDatabase(name) {
        if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new CliError(2, 'use expects a single database name')
        this.database = name
        return json({ ok: { $numberInt: '1' }, db: name })
    }

    showDatabases() {
        return binding.listDatabases(this.store)
    }

    showCollections() {
        return binding.listCollections(this.store, json({ listCollections: 1, $db: this.database }))
    }

    dispatch(call) {
        const { name, args } = call
        switch (name) {
            case 'insertOne': {
                noChain(call)
                argumentCount(args, 2, 2, name)
                const collection = collectionArgument(args, 0, name)
                const document = documentArgument(args, 1, name, 'document')
                return binding.insert(this.store, json({ insert: collection, documents: [document], $db: this.database }))
            }
            case 'insertMany': {
                noChain(call)
                if (args.length < 2) throw new CliError(2, 'insertMany expects a collection name and at least one document')
                const collection = collectionArgument(args, 0, name)
                const documents = args.length === 2 && Array.isArray(args[1]) ? args[1] : args.slice(1)
                if (documents.length === 0) throw new CliError(2, 'insertMany requires at least one document')
                for (const document of documents) {
                    if (!isDocument(document)) throw new CliError(2, 'insertMany documents must be objects')
                }
                return binding.insert(this.store, json({ insert: collection, documents, $db: this.database }))
            }
            case 'find':
                return this.find(call)
            case 'updateOne':
            case 'updateMany': {
                noChain(call)
                argumentCount(args, 3, 3, name)
                const collection = collectionArgument(args, 0, name)
                const filter = documentArgument(args, 1, name, 'filter')
                const update = documentArgument(args, 2, name, 'update')
                const updates = [{ q: filter, u: update, multi: name === 'updateMany' }]
                return binding.update(this.store, json({ update: collection, updates, $db: this.database }))
            }
            case 'deleteOne':
            case 'deleteMany': {
                noChain(call)
                argumentCount(args, 1, 2, name)
                const collection = collectionArgument(args, 0, name)
                const filter = args.length > 1 ? documentArgument(args, 1, name, 'filter') : {}
                const deletes = [{ q: filter, limit: name === 'deleteOne' ? 1 : 0 }]
                return binding.delete(this.store, json({ delete: collection, deletes, $db: this.database }))
            }
            case 'countDocuments': {
                noChain(call)
                argumentCount(args, 1, 2, name)
                const collection = collectionArgument(args, 0, name)
                const query = args.length > 1 ? documentArgument(args, 1, name, 'filter') : {}
                return binding.count(this.store, json({ count: collection, query, $db: this.database }))
            }
            default:
                throw new CliError(59, unknownCommand(name))
        }
    }

    find(call) {
        const { args } = call
        argumentCount(args, 1, 3, 'find')
        const collection = collectionArgument(args, 0, 'find')
        const filter = args.length > 1 ? documentArgument(args, 1, 'find', 'filter') : {}
        const command = { find: collection, filter, $db: this.database }
        if (args.length > 2) command.projection = documentArgument(args, 2, 'find', 'projection')
        const seen = new Set()
        for (const method of call.calls) {
            if (seen.has(method.name)) throw new CliError(2, `find method ${method.name} used twice`)
            seen.add(method.name)
            if (method.name === 'sort') {
                argumentCount(method.args, 1, 1, 'sort')
                command.sort = documentArgument(method.args, 0, 'sort', 'sort')
            } else if (method.name === 'skip' || method.name === 'limit') {
                argumentCount(method.args, 1, 1, method.name)
                const value = method.args[0]
                if (!Number.isInteger(value) || value < 0) {
                    throw new CliError(2, `${method.name} expects a non-negative integer`)
                }
                command[method.name] = value
            } else {
                throw new CliError(2, `unknown find method: ${method.name}`)
            }
        }
        return binding.find(this.store, this.cursors, json(command))
    }
}

function parseOptions(argv) {
    const options = { dataDir: null, database: 'app', script: null, help: false }
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index]
        if (argument === '--help' || argument === '-h') {
            options.help = true
            continue
        }
        if (argument === '--data-dir' || argument === '--db' || argument === '--script') {
            const value = argv[index + 1]
            if (value === undefined) throw new CliError(2, `${argument} requires a value`)
            index += 1
            if (argument === '--data-dir') options.dataDir = value
            else if (argument === '--db') options.database = value
            else options.script = value
            continue
        }
        throw new CliError(2, `unknown option: ${argument}`)
    }
    if (!options.help && !options.dataDir) throw new CliError(2, '--data-dir is required')
    return options
}

async function main() {
    let options
    try {
        options = parseOptions(process.argv.slice(2))
    } catch (error) {
        process.stderr.write(`${errorLine(error)}\n`)
        process.exitCode = 2
        return
    }
    if (options.help) {
        process.stdout.write(HELP)
        return
    }

    mkdirSync(options.dataDir, { recursive: true })
    const session = new Session(new binding.MongoStore(join(options.dataDir, 'mongo.yykv')), options.database)

    const handle = (line) => {
        let outcome
        try {
            outcome = session.run(line)
        } catch (error) {
            process.stdout.write(`${errorLine(error)}\n`)
            return false
        }
        if (!outcome) return false
        process.stdout.write(`${outcome.text}\n`)
        return outcome.stop === true
    }

    if (options.script) {
        const lines = readFileSync(options.script, 'utf8').split(/\r?\n/)
        for (const line of lines) {
            if (handle(line)) break
        }
        return
    }

    const interactive = Boolean(process.stdin.isTTY)
    const reader = createInterface({ input: process.stdin, crlfDelay: Infinity })
    if (interactive) {
        process.stdout.write('yydb mongo shell (minimal), type `exit` to quit\n')
        reader.setPrompt('> ')
        reader.prompt()
    }
    for await (const line of reader) {
        const stopped = handle(line)
        if (stopped) {
            reader.close()
            break
        }
        if (interactive) reader.prompt()
    }
}

main().catch((error) => {
    process.stderr.write(`${errorLine(error)}\n`)
    process.exitCode = 1
})
