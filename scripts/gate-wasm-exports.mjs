// Wasm surface gate: the browser binding must compile for its own target and
// export the five codec primitives the host relies on. Compiling on the host
// target only proves the crate is valid Rust, not that it is a usable wasm
// module, so this gate reads the wasm32 artifact built by the caller.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const artifact = join(root, 'projects', 'mongo.rs', 'target', 'wasm32-unknown-unknown', 'release', 'mongo_wasm.wasm')

const expected = ['decode_op_msg', 'encode_op_msg', 'encode_document', 'decode_document', 'decode_op_query']

if (!existsSync(artifact)) {
    console.error(`missing ${artifact}, run cargo build -p mongo-wasm --target wasm32-unknown-unknown --release first`)
    process.exit(1)
}

const module = new WebAssembly.Module(readFileSync(artifact))
const names = WebAssembly.Module.exports(module).map((entry) => entry.name)
const missing = expected.filter((name) => !names.some((exported) => exported === name || exported.startsWith(`${name}_`)))
if (missing.length > 0) {
    for (const name of missing) console.error(`wasm export: ${name} is not exported`)
    process.exit(1)
}
console.log(`WASM EXPORTS OK (${expected.length} codec exports)`)
