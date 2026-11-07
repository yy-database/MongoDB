// Installation-state gate for the Python package: build a wheel, install it
// into a fresh virtualenv under the system temp directory, then import and
// execute a real call from that installed copy.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
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

// Inspect the wheel before installing it: the metadata and the bundled license
// are what a public index would expose, so assert them on the real archive.
const pyproject = readFileSync(join(packageDir, 'pyproject.toml'), 'utf8')
const pyVersion = pyproject.match(/^version = "([^"]+)"/m)?.[1]
writeFileSync(join(work, 'check_wheel.py'), `
import sys
import zipfile

wheel = sys.argv[1]
version = sys.argv[2]
license_path = sys.argv[3]

with open(license_path, 'rb') as handle:
    repository_license = handle.read()

with zipfile.ZipFile(wheel) as archive:
    names = archive.namelist()
    metadata_name = next((name for name in names if name.endswith('.dist-info/METADATA')), None)
    assert metadata_name, 'wheel carries no METADATA'
    metadata = archive.read(metadata_name).decode('utf-8')
    license_name = metadata_name.replace('METADATA', 'licenses/License.md')
    assert license_name in names, 'wheel is missing ' + license_name
    wheel_license = archive.read(license_name)
    assert wheel_license == repository_license, 'wheel license differs from the repository License.md'
    assert any(name.endswith(('.pyd', '.so')) for name in names), 'wheel carries no compiled extension'

for line in [
    'Name: yydb-mongo',
    'Version: ' + version,
    'License-Expression: MPL-2.0',
    'License-File: License.md',
    'Description-Content-Type: text/markdown',
]:
    assert line in metadata, 'METADATA is missing ' + line
assert 'canonical Extended JSON strings' in metadata, 'METADATA long description does not carry the package README'
print('wheel ok: ' + metadata_name + ' license=' + license_name)
`)
run(python, ['check_wheel.py', join(wheels, wheel), pyVersion ?? '', join(root, 'License.md')], work)

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
