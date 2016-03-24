// Shell-level smoke: every command `mongosh` reaches for in normal use.
// Run with: mongosh "<uri>" projects/mongo.ts/packages/mongo/tests/smoke-shell.js
// Output lines are `SMOKE|<name>|OK|...` or `SMOKE|<name>|ERR|...`.
const LIMIT = 320

function summarize(value) {
    try {
        if (value === undefined) return 'undefined'
        if (Array.isArray(value)) return 'array(' + value.length + ') ' + EJSON.stringify(value.slice(0, 2), { relaxed: true })
        const text = EJSON.stringify(value, { relaxed: true })
        return text.length > LIMIT ? text.slice(0, LIMIT) + '...' : text
    } catch (error) {
        return 'unserializable: ' + String(error.message || error)
    }
}

function report(name, fn) {
    try {
        print('SMOKE|' + name + '|OK|' + summarize(fn()))
    } catch (error) {
        print('SMOKE|' + name + '|ERR|' + String(error.message || error).split('\n')[0])
    }
}

const database = db.getSiblingDB('smoke_db')

report('listDatabases', () => db.getMongo().getDBNames())
report('use+getCollectionNames', () => database.getCollectionNames())
report('createCollection', () => database.createCollection('items'))
report('insert', () => database.items.insertMany([{ _id: 1, v: 'a' }, { _id: 2, v: 'b' }]))
report('find', () => database.items.find({}).sort({ _id: 1 }).toArray())
report('getCollectionNames.after', () => database.getCollectionNames())
report('getCollectionInfos', () => database.getCollectionInfos())
report('db.stats', () => database.stats())
report('serverStatus', () => database.runCommand({ serverStatus: 1 }))
report('hostInfo', () => db.hostInfo ? db.hostInfo() : db.runCommand({ hostInfo: 1 }))
report('currentOp', () => database.currentOp())
report('killOp', () => database.killOp(0))
report('isWritablePrimary', () => db.getMongo().isWritablePrimary())
report('rs.status', () => rs.status())
report('ping', () => db.runCommand({ ping: 1 }))
report('connectionStatus', () => db.runCommand({ connectionStatus: 1 }))
report('explain.find', () => database.items.find({ _id: 1 }).explain())
report('dropDatabase', () => database.dropDatabase())
