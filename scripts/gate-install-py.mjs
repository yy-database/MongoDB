// Installation-state gate for the Python package: build a wheel, install it
// into a fresh virtualenv under the system temp directory, then import and
// execute a real call from that installed copy.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const packageDir = join(root, 'projects', 'mongo.py', 'packages', 'mongo')
const python = process.platform === 'win32' ? 'python' : 'python3'
const work = mkdtempSync(join(tmpdir(), 'mongo-install-py-'))
const wheels = join(work, 'wheels')
const venv = join(work, 'venv')

const run = (command, args, cwd) => {
    const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
    if (result.status !== 0) {
        console.error(`failed: ${command} ${args.join(' ')}`)
        process.exit(result.status ?? 1)
    }
}

run(python, ['-m', 'maturin', 'build', '--release', '--out', wheels], packageDir)
const wheel = readdirSync(wheels).find((name) => name.endsWith('.whl'))
if (!wheel) {
    console.error('maturin produced no wheel')
    process.exit(1)
}

run(python, ['-m', 'venv', venv], work)
const venvPython = join(venv, process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python')
run(venvPython, ['-m', 'pip', 'install', '--quiet', '--no-deps', join(wheels, wheel)], work)

writeFileSync(join(work, 'probe.py'), `
import json
import os
import tempfile

import mongo

assert mongo.__file__.startswith(${JSON.stringify(venv)}), mongo.__file__
encoded = mongo.encode_document(json.dumps({"a": 1}))
assert mongo.decode_document(encoded) == '{"a":{"$numberInt":"1"}}'
assert json.loads(mongo.ping())["ok"]["$numberDouble"] == "1.0"

store = mongo.MongoStore(os.path.join(tempfile.mkdtemp(prefix="mongo-installed-"), "mongo.yykv"))
assert json.loads(mongo.create(store, json.dumps({"create": "probe"})))["ok"]["$numberDouble"] == "1.0"
mongo.insert(store, json.dumps({"insert": "probe", "documents": [{"_id": 1, "score": 10}]}))
reply = json.loads(mongo.update(store, json.dumps({"update": "probe", "updates": [{"q": {"_id": 1}, "u": {"$min": {"score": 3}}}]})))
assert reply["nModified"]["$numberInt"] == "1", reply
print("install-state ok: package at", mongo.__file__)
`)
run(venvPython, ['probe.py'], work)
console.log(`INSTALL PY OK (${work})`)
