// SCRAM-SHA-256 / SCRAM-SHA-1 authentication, matched against `mongod 8.0.9`.
//
// Credentials live in `<db>.system.users` inside this server's own store, in the
// same document shape `mongod` writes (`_id`, `userId`, `user`, `db`,
// `credentials`, `roles`). Salts and digests are produced here; the store is
// only reached through the `mongo` primitives, so no authentication state
// leaves the connection that owns it.
import { createHash, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto'
import { binding } from './binding.ts'
import {
    builtinRoleExists,
    BUILTIN_ROLE_NAMES,
    expandRoles,
    makeStoreResolver,
    normalizePrivileges,
    VALID_ACTIONS,
    type Privilege,
    type Resource,
    type RoleResolver
} from './authorization.ts'
import { saslprep, SaslprepError } from './saslprep.ts'

/** Mechanisms this server registers in user credentials. */
export const SCRAM_MECHANISMS = ['SCRAM-SHA-256', 'SCRAM-SHA-1'] as const
export type ScramMechanism = (typeof SCRAM_MECHANISMS)[number]

export interface AuthIdentity {
    user: string
    db: string
}

export interface AuthRole {
    role: string
    db: string
}

interface ScramConversation {
    user: string
    db: string
    mechanism: ScramMechanism
    clientFirstBare: string
    serverFirst: string
    nonce: string
    storedKey: Buffer
    serverKey: Buffer
    roles: AuthRole[]
    /** `final` expects the client proof, `finish` expects the empty continuation. */
    phase: 'final' | 'finish'
}

export interface AuthState {
    users: AuthIdentity[]
    roles: AuthRole[]
    conversation: ScramConversation | null
}

export function createAuthState(): AuthState {
    return { users: [], roles: [], conversation: null }
}

const OK = { $numberDouble: '1.0' }

/** Error document in the same order and spelling `mongod 8.0.9` uses. */
export function authError(code: number, codeName: string, message: string): any {
    return { ok: { $numberDouble: '0.0' }, errmsg: message, code: { $numberInt: String(code) }, codeName }
}

function badValue(message: string): any {
    return authError(2, 'BadValue', message)
}

function binaryPayload(text: string): any {
    return { $binary: { base64: Buffer.from(text, 'utf8').toString('base64'), subType: '00' } }
}

/** Unwraps the extended-JSON numeric forms the store returns. */
function numeric(value: unknown): number {
    if (typeof value === 'number') return value
    if (value && typeof value === 'object') {
        const tag = value as Record<string, unknown>
        for (const key of ['$numberInt', '$numberLong', '$numberDouble', '$numberDecimal']) {
            if (Object.hasOwn(tag, key)) return Number(tag[key])
        }
    }
    return Number.NaN
}

function credentialList(credentials: any): ScramMechanism[] {
    if (!credentials || typeof credentials !== 'object') return []
    return SCRAM_MECHANISMS.filter((mechanism) => credentials[mechanism] !== undefined)
}

function findUser(session: { store: any; cursors: any }, db: string, user: string): any | null {
    const find = JSON.stringify({ find: 'system.users', filter: { user }, limit: 1, $db: db })
    const batch = JSON.parse(binding.find(session.store, session.cursors, find))?.cursor?.firstBatch
    if (!Array.isArray(batch) || batch.length === 0) return null
    return batch[0]
}

/** Reads one base64 payload out of a decoded command. */
function payloadText(payload: unknown): string | null {
    if (payload && typeof payload === 'object') {
        const binary = payload as Record<string, any>
        const data = binary.$binary
        if (data && typeof data.base64 === 'string') return Buffer.from(data.base64, 'base64').toString('utf8')
    }
    if (typeof payload === 'string') {
        // `mongod` accepts a base64 string here; an invalid one is rejected.
        try {
            return Buffer.from(payload, 'base64').toString('utf8')
        } catch {
            return null
        }
    }
    return null
}

/** `md5("<user>:mongo:<pwd>")` for SHA-1, the plain password (saslprep'd) for SHA-256. */
function processedPassword(mechanism: ScramMechanism, user: string, password: string): string {
    // RFC 4013 preparation happens before the SHA-1 digest, as `mongod` does.
    const prepared = saslprep(password)
    return mechanism === 'SCRAM-SHA-256' ? prepared : createHash('md5').update(`${user}:mongo:${prepared}`, 'utf8').digest('hex')
}

function scramParameters(mechanism: ScramMechanism): { digest: 'sha256' | 'sha1'; keyLength: number; saltLength: number; iterations: number } {
    return mechanism === 'SCRAM-SHA-256'
        ? { digest: 'sha256', keyLength: 32, saltLength: 24, iterations: 15000 }
        : { digest: 'sha1', keyLength: 20, saltLength: 16, iterations: 10000 }
}

/** Credential sub-document in `mongod`'s field order. */
function makeCredentials(mechanism: ScramMechanism, user: string, password: string): any {
    const parameters = scramParameters(mechanism)
    const salt = randomBytes(parameters.saltLength)
    const salted = pbkdf2Sync(processedPassword(mechanism, user, password), salt, parameters.iterations, parameters.keyLength, parameters.digest)
    const clientKey = createHmac(parameters.digest, salted).update('Client Key').digest()
    const storedKey = createHash(parameters.digest).update(clientKey).digest()
    const serverKey = createHmac(parameters.digest, salted).update('Server Key').digest()
    return {
        iterationCount: parameters.iterations,
        salt: salt.toString('base64'),
        storedKey: storedKey.toString('base64'),
        serverKey: serverKey.toString('base64')
    }
}

function rolesOf(user: any): AuthRole[] {
    if (!Array.isArray(user?.roles)) return []
    return user.roles
        .map((role: any) => (typeof role === 'string' ? { role, db: user.db } : role))
        .filter((role: any) => role && typeof role.role === 'string' && typeof role.db === 'string')
        .map((role: any) => ({ role: role.role, db: role.db }))
}

/** Whether any user document exists in any database (drives the localhost exception). */
export function anyUserExists(store: any): boolean {
    const databases = JSON.parse(binding.listDatabases(store))?.databases
    if (!Array.isArray(databases)) return false
    for (const entry of databases) {
        const name = entry?.name
        if (typeof name !== 'string') continue
        try {
            const counted = JSON.parse(binding.count(store, JSON.stringify({ count: 'system.users', query: {}, $db: name })))
            if (numeric(counted?.n) > 0) return true
        } catch {
            // A database that cannot be queried holds no user this connection can use.
        }
    }
    return false
}

/**
 * `createUser`, writing the same document `mongod` writes.
 *
 * `mechanisms` defaults to both registered ones; salts and keys are generated
 * per credential so the stored digests never leave this process.
 */
export function createUserCommand(session: { store: any; cursors: any }, command: any): any {
    const db = command.$db ?? 'admin'
    const name = command.createUser
    if (typeof name !== 'string') return badValue('createUser must be a string')
    if (typeof command.pwd !== 'string') {
        return authError(40414, 'IDLFailedToParse', "BSON field 'createUser.pwd' is missing but a required field")
    }
    if (!Array.isArray(command.roles)) {
        return authError(40414, 'IDLFailedToParse', "BSON field 'createUser.roles' is missing but a required field")
    }
    if (findUser(session, db, name) !== null) {
        return authError(51003, 'Location51003', `User "${name}@${db}" already exists`)
    }
    let mechanisms: ScramMechanism[] = []
    if (Array.isArray(command.mechanisms)) {
        for (const requested of command.mechanisms) {
            if (typeof requested !== 'string' || !(SCRAM_MECHANISMS as readonly string[]).includes(requested)) {
                return authError(2, 'BadValue', `Unknown auth mechanism '${String(requested)}'`)
            }
            mechanisms.push(requested as ScramMechanism)
        }
        if (mechanisms.length === 0) return authError(2, 'BadValue', 'mechanisms must not be empty')
    } else {
        mechanisms = [...SCRAM_MECHANISMS]
    }
    // Roles are validated before credentials are generated, as `mongod` does;
    // a string role names the current database. A name that is not a built-in
    // resolves against `<db>.system.roles`, exactly like the authorization
    // layer later does.
    const resolve = makeStoreResolver(session)
    const roles: AuthRole[] = []
    for (const requested of command.roles) {
        let role: AuthRole
        if (typeof requested === 'string') role = { role: requested, db }
        else if (isDocumentValue(requested)) {
            if (!Object.hasOwn(requested, 'role')) return badValue('RoleName must contain a field named: role')
            if (typeof requested.role !== 'string') {
                return badValue(`RoleName must contain a string field named: role. But, has type ${typeName(requested.role)}`)
            }
            if (!Object.hasOwn(requested, 'db')) return badValue('RoleName must contain a field named: db')
            if (typeof requested.db !== 'string') {
                return badValue(`RoleName must contain a string field named: db. But, has type ${typeName(requested.db)}`)
            }
            role = { role: requested.role, db: requested.db }
        } else {
            return badValue('Role name must be either a document or string')
        }
        if (!builtinRoleExists(role) && resolve(role) === null) {
            return authError(31, 'RoleNotFound', `Could not find role: ${role.role}@${role.db}`)
        }
        roles.push(role)
    }
    const credentials: any = {}
    try {
        for (const mechanism of mechanisms) credentials[mechanism] = makeCredentials(mechanism, name, command.pwd)
    } catch (error) {
        const kind = error instanceof SaslprepError && error.kind === 'bidi' ? 'CHECK_BIDI' : 'PROHIBITED'
        return authError(50692, 'Location50692', `Error preflighting normalization: U_STRINGPREP_${kind}_ERROR`)
    }
    const userDocument = {
        _id: `${db}.${name}`,
        userId: { $binary: { base64: randomBytes(16).toString('base64'), subType: '04' } },
        user: name,
        db,
        credentials,
        roles
    }
    const reply = JSON.parse(binding.insert(session.store, JSON.stringify({ insert: 'system.users', documents: [userDocument], $db: db })))
    const writeError = Array.isArray(reply.writeErrors) ? reply.writeErrors[0] : null
    if (writeError) {
        return authError(51003, 'Location51003', `User "${name}@${db}" already exists`)
    }
    return { ok: OK }
}

/** `dropUser`, answering `UserNotFound` exactly when the document is absent. */
export function dropUserCommand(session: { store: any; cursors: any }, command: any): any {
    const db = command.$db ?? 'admin'
    const name = command.dropUser
    if (typeof name !== 'string') return badValue('dropUser must be a string')
    if (findUser(session, db, name) === null) return authError(11, 'UserNotFound', `User '${name}@${db}' not found`)
    binding.delete(session.store, JSON.stringify({ delete: 'system.users', deletes: [{ q: { user: name }, limit: 1 }], $db: db }))
    return { ok: OK }
}

/** `TypeMismatch` in `mongod`'s IDL wording. */
function typeMismatch(field: string, actual: string, expected: string): any {
    return authError(14, 'TypeMismatch', `BSON field '${field}' is the wrong type '${actual}', expected type '${expected}'`)
}

/** `IDLFailedToParse` for a missing required field. */
function idlMissing(field: string): any {
    return authError(40414, 'IDLFailedToParse', `BSON field '${field}' is missing but a required field`)
}

/** `IDLUnknownField` for a field the command IDL does not declare. */
function idlUnknown(field: string): any {
    return authError(40415, 'IDLUnknownField', `BSON field '${field}' is an unknown field.`)
}

/** Command-level fields every `mongod` command accepts next to its own ones. */
const COMMON_COMMAND_FIELDS = new Set([
    '$db', 'lsid', '$lsid', '$readPreference', '$clusterTime', '$audit', '$client', '$configServer', '$shard',
    '$dbVersion', '$direct', 'comment', 'writeConcern', 'readConcern', 'maxTimeMS', 'txnNumber', 'autocommit',
    'startTransaction', 'shellBatch', 'aggregationBatchSize', 'replWriteConcern', 'provenance', 'stmtId'
])

/** Reads one role document out of `<db>.system.roles`. */
function findRole(session: { store: any; cursors: any }, db: string, name: string): any | null {
    const find = JSON.stringify({ find: 'system.roles', filter: { _id: `${db}.${name}` }, limit: 1, $db: db })
    const batch = JSON.parse(binding.find(session.store, session.cursors, find))?.cursor?.firstBatch
    if (!Array.isArray(batch) || batch.length === 0) return null
    return batch[0]
}

/** Whether a `createRole` resource names a shape `mongod` accepts, or the refusal. */
function validateResourceShape(resource: any): any | null {
    if (!isDocumentValue(resource)) return null
    if (Object.hasOwn(resource, 'systemBuckets')) {
        return badValue("resource pattern must contain 'collection' or 'systemBuckets' specifier")
    }
    const cluster = resource.cluster === true
    const anyResource = resource.anyResource === true
    if (cluster && Object.hasOwn(resource, 'db')) return badValue("resource: {cluster: true} conflicts with resource type 'db'")
    if (cluster && Object.hasOwn(resource, 'anyResource')) {
        return badValue("resource: {cluster: true} conflicts with resource type 'anyResource'")
    }
    if (Object.hasOwn(resource, 'db') && typeof resource.db !== 'string') {
        return typeMismatch('createRole.privileges.resource.db', typeName(resource.db), 'string')
    }
    if (Object.hasOwn(resource, 'collection') && typeof resource.collection !== 'string') {
        return typeMismatch('createRole.privileges.resource.collection', typeName(resource.collection), 'string')
    }
    if (cluster || anyResource) return null
    if (typeof resource.db === 'string') {
        if (typeof resource.collection !== 'string') {
            return badValue("resource pattern must contain 'collection' or 'systemBuckets' specifier")
        }
        return null
    }
    if (Object.hasOwn(resource, 'collection')) return badValue("resource {collection: '...'} must include 'db' field as well")
    return badValue("resource pattern must contain 'collection' or 'systemBuckets' specifier")
}

/** Whether a resource reaches past the database a non-`admin` role may govern. */
function resourceInScope(resource: any, roleDb: string): boolean {
    if (roleDb === 'admin') return true
    return typeof resource.db === 'string' && resource.db === roleDb
}

/**
 * `createRole`, storing the same document `mongod` stores.
 *
 * The role lives in `<db>.system.roles` (the per-database layout this server
 * already uses for `<db>.system.users`), its privileges are normalized the way
 * `mongod` normalizes them before writing, and every validation error carries
 * the measured code and wording.
 */
export function createRoleCommand(session: { store: any; cursors: any }, command: any): any {
    const db = command.$db ?? 'admin'
    const name = command.createRole
    if (typeof name !== 'string') {
        return typeMismatch('createRole.createRole', typeName(command.createRole), 'string')
    }
    for (const key of Object.keys(command)) {
        if (!CREATE_ROLE_FIELDS.has(key) && !COMMON_COMMAND_FIELDS.has(key)) return idlUnknown(`createRole.${key}`)
    }
    if (!Object.hasOwn(command, 'privileges')) return idlMissing('createRole.privileges')
    if (!Object.hasOwn(command, 'roles')) return idlMissing('createRole.roles')
    if (!Array.isArray(command.privileges)) return typeMismatch('createRole.privileges', typeName(command.privileges), 'array')
    if (!Array.isArray(command.roles)) return typeMismatch('createRole.roles', typeName(command.roles), 'array')
    if (Object.hasOwn(command, 'authenticationRestrictions') && !Array.isArray(command.authenticationRestrictions)) {
        return typeMismatch('createRole.authenticationRestrictions', typeName(command.authenticationRestrictions), 'array')
    }
    if (name.length === 0) return badValue('Role name must be non-empty')
    if (BUILTIN_ROLE_NAMES.has(name)) return badValue('Cannot create roles with the same name as a built-in role')
    if (findRole(session, db, name) !== null) {
        return authError(51002, 'Location51002', `Role "${name}@${db}" already exists`)
    }

    const resolve = makeStoreResolver(session)
    const granted: AuthRole[] = []
    for (const requested of command.roles) {
        let role: AuthRole
        if (typeof requested === 'string') role = { role: requested, db }
        else if (isDocumentValue(requested)) {
            if (!Object.hasOwn(requested, 'role')) return badValue('RoleName must contain a field named: role')
            if (typeof requested.role !== 'string') {
                return badValue(`RoleName must contain a string field named: role. But, has type ${typeName(requested.role)}`)
            }
            if (!Object.hasOwn(requested, 'db')) return badValue('RoleName must contain a field named: db')
            if (typeof requested.db !== 'string') {
                return badValue(`RoleName must contain a string field named: db. But, has type ${typeName(requested.db)}`)
            }
            role = { role: requested.role, db: requested.db }
        } else {
            return badValue('Role name must be either a document or string')
        }
        if (role.role === name && role.db === db) {
            return authError(49, 'InvalidRoleModification', `Cannot grant role ${name}@${db} to itself.`)
        }
        if (db !== 'admin' && role.db !== db) {
            return authError(49, 'InvalidRoleModification', `Roles on the '${db}' database cannot be granted roles from other databases`)
        }
        if (!builtinRoleExists(role) && resolve(role) === null) {
            return authError(
                31,
                'RoleNotFound',
                `Cannot grant roles to '${name}@${db}': Could not find role: ${role.role}@${role.db}`
            )
        }
        const key = `${role.db}.${role.role}`
        if (!granted.some((entry) => `${entry.db}.${entry.role}` === key)) granted.push(role)
    }

    const privileges: Privilege[] = []
    for (let index = 0; index < command.privileges.length; index += 1) {
        const entry = command.privileges[index]
        if (!isDocumentValue(entry)) {
            return typeMismatch(`createRole.privileges.${index}`, typeName(entry), 'object')
        }
        if (!Object.hasOwn(entry, 'resource')) return idlMissing('createRole.privileges.resource')
        if (!Object.hasOwn(entry, 'actions')) return idlMissing('createRole.privileges.actions')
        if (!Array.isArray(entry.actions)) return typeMismatch('createRole.privileges.actions', typeName(entry.actions), 'array')
        const shape = validateResourceShape(entry.resource)
        if (shape) return shape
        if (!resourceInScope(entry.resource, db)) {
            return authError(
                49,
                'InvalidRoleModification',
                `Roles on the '${db}' database cannot be granted privileges that target other databases or the cluster`
            )
        }
        const actions: string[] = []
        for (let position = 0; position < entry.actions.length; position += 1) {
            const action = entry.actions[position]
            if (typeof action !== 'string') {
                return typeMismatch(`createRole.privileges.actions.${position}`, typeName(action), 'string')
            }
            if (!VALID_ACTIONS.has(action)) return badValue(`Unknown action type in privilege set: '${action}'`)
            actions.push(action)
        }
        if (actions.length === 0) return badValue("'actions' field of privilege resource must not be empty")
        const resource: Resource = isDocumentValue(entry.resource) ? entry.resource : {}
        privileges.push({ resource, actions })
    }

    const roleDocument: any = {
        _id: `${db}.${name}`,
        role: name,
        db,
        privileges: normalizePrivileges(privileges),
        roles: granted
    }
    if (Object.hasOwn(command, 'authenticationRestrictions')) {
        for (const entry of command.authenticationRestrictions) {
            if (!isDocumentValue(entry)) return typeMismatch('createRole.authenticationRestrictions', typeName(entry), 'object')
            for (const key of Object.keys(entry)) {
                if (key !== 'clientSource' && key !== 'serverAddress') return idlUnknown(`createRole.authenticationRestrictions.${key}`)
            }
            for (const key of ['clientSource', 'serverAddress']) {
                if (Object.hasOwn(entry, key) && !Array.isArray(entry[key])) {
                    return typeMismatch(`createRole.authenticationRestrictions.${key}`, typeName(entry[key]), 'array')
                }
            }
        }
        roleDocument.authenticationRestrictions = command.authenticationRestrictions
    }
    const reply = JSON.parse(
        binding.insert(session.store, JSON.stringify({ insert: 'system.roles', documents: [roleDocument], $db: db }))
    )
    if (Array.isArray(reply.writeErrors) && reply.writeErrors.length > 0) {
        return authError(51002, 'Location51002', `Role "${name}@${db}" already exists`)
    }
    return { ok: OK }
}

/** Fields `mongod 8.0.9` declares for `createRole`; anything else is `IDLUnknownField`. */
const CREATE_ROLE_FIELDS = new Set(['createRole', 'privileges', 'roles', 'authenticationRestrictions'])

/**
 * `dropRole`. `mongod 8.0.9` answers `RoleNotFound` for a missing role and
 * `BadValue` for a built-in one; a successful drop removes the document and
 * strips the role from every user and role that still references it (measured:
 * the drop is not refused for dependents, the references are rewritten).
 */
export function dropRoleCommand(session: { store: any; cursors: any }, command: any): any {
    const db = command.$db ?? 'admin'
    const name = command.dropRole
    if (typeof name !== 'string') {
        return typeMismatch('dropRole.dropRole', typeName(command.dropRole), 'string')
    }
    for (const key of Object.keys(command)) {
        if (key !== 'dropRole' && !COMMON_COMMAND_FIELDS.has(key)) return idlUnknown(`dropRole.${key}`)
    }
    if (BUILTIN_ROLE_NAMES.has(name)) {
        return badValue(`${name}@${db} is a built-in role and cannot be modified`)
    }
    if (findRole(session, db, name) === null) {
        return authError(31, 'RoleNotFound', `Could not find role: ${name}@${db}`)
    }
    binding.delete(session.store, JSON.stringify({ delete: 'system.roles', deletes: [{ q: { _id: `${db}.${name}` }, limit: 1 }], $db: db }))
    for (const database of storedDatabases(session.store)) {
        for (const document of storedUsers(session, database)) {
            if (!Array.isArray(document.roles)) continue
            const kept = document.roles.filter((entry: any) => !(entry !== null && typeof entry === 'object' && entry.role === name && entry.db === db))
            if (kept.length !== document.roles.length) {
                binding.update(session.store, JSON.stringify({ update: 'system.users', updates: [{ q: { _id: document._id }, u: { $set: { roles: kept } }, limit: 1 }], $db: database }))
            }
        }
        const find = JSON.stringify({ find: 'system.roles', filter: {}, $db: database })
        const batch = JSON.parse(binding.find(session.store, session.cursors, find))?.cursor?.firstBatch
        for (const document of Array.isArray(batch) ? batch : []) {
            if (!Array.isArray(document.roles)) continue
            const kept = document.roles.filter((entry: any) => !(entry !== null && typeof entry === 'object' && entry.role === name && entry.db === db))
            if (kept.length !== document.roles.length) {
                binding.update(session.store, JSON.stringify({ update: 'system.roles', updates: [{ q: { _id: document._id }, u: { $set: { roles: kept } }, limit: 1 }], $db: database }))
            }
        }
    }
    return { ok: OK }
}

/** `saslSupportedMechs` slice of a `hello` reply, or the error `mongod` returns. */
export function saslSupportedMechsFor(
    session: { store: any; cursors: any },
    databaseUser: unknown
): { mechanisms?: ScramMechanism[]; error?: any } {
    if (typeof databaseUser !== 'string') return {}
    const dot = databaseUser.indexOf('.')
    if (dot <= 0 || dot === databaseUser.length - 1) {
        return { error: badValue("UserName must contain a '.' separated database.user pair") }
    }
    const db = databaseUser.slice(0, dot)
    const user = databaseUser.slice(dot + 1)
    const document = findUser(session, db, user)
    if (document === null) return {}
    return { mechanisms: credentialList(document.credentials) }
}

function startConversation(session: { store: any; cursors: any; auth: AuthState }, command: any): any {
    const mechanism = command.mechanism
    if (typeof mechanism !== 'string') {
        return authError(40414, 'IDLFailedToParse', "BSON field 'saslStart.mechanism' is missing but a required field")
    }
    if (!(SCRAM_MECHANISMS as readonly string[]).includes(mechanism)) {
        return authError(334, 'MechanismUnavailable', `Received authentication for mechanism ${mechanism} which is not enabled`)
    }
    const payload = payloadText(command.payload)
    if (payload === null) {
        if (!Object.hasOwn(command, 'payload')) {
            return authError(40414, 'IDLFailedToParse', "BSON field 'saslStart.payload' is missing but a required field")
        }
        return authError(10270, 'Location10270', 'Failed decoding SASL payload: invalid base64')
    }
    // GS2 header: `n` or `y`, an optional `a=<authzid>`, then a comma; the
    // client-first bare follows. `mongod 8.0.9` accepts `n,a=<user>,` when the
    // authzid names the user being authenticated and rejects any other.
    const comma = payload.indexOf(',')
    const flag = comma < 0 ? '' : payload.slice(0, comma)
    if (flag !== 'n' && flag !== 'y') return authError(18, 'AuthenticationFailed', 'Authentication failed.')
    let rest = payload.slice(comma + 1)
    let authzid = ''
    if (rest.startsWith('a=')) {
        const separator = rest.indexOf(',')
        if (separator < 0) return authError(18, 'AuthenticationFailed', 'Authentication failed.')
        authzid = rest.slice(2, separator)
        rest = rest.slice(separator + 1)
    } else if (rest.startsWith(',')) {
        rest = rest.slice(1)
    } else {
        return authError(18, 'AuthenticationFailed', 'Authentication failed.')
    }
    const clientFirstBare = rest
    const parsed = /^n=([^,]*),r=(.+)$/.exec(clientFirstBare)
    if (!parsed) return authError(18, 'AuthenticationFailed', 'Authentication failed.')
    const user = parsed[1]
    const clientNonce = parsed[2]
    if (user.length === 0) return authError(18, 'AuthenticationFailed', 'Authentication failed.')
    if (authzid !== '' && authzid !== user) return authError(18, 'AuthenticationFailed', 'Authentication failed.')
    const db = command.db ?? command.$db ?? 'admin'
    const document = findUser(session, db, user)
    if (document === null) return authError(18, 'AuthenticationFailed', 'Authentication failed.')
    const mechanismKey = mechanism as ScramMechanism
    const credential = document.credentials?.[mechanismKey]
    if (!credential) {
        return authError(
            334,
            'MechanismUnavailable',
            `Unable to use ${mechanism} based authentication for user without any ${mechanism} credentials registered`
        )
    }
    const salt = typeof credential.salt === 'string' ? credential.salt : ''
    const iterations = numeric(credential.iterationCount)
    const serverFirst = `r=${clientNonce}${randomBytes(24).toString('base64')},s=${salt},i=${iterations}`
    session.auth.conversation = {
        user,
        db,
        mechanism: mechanismKey,
        clientFirstBare,
        serverFirst,
        nonce: serverFirst.slice(2, serverFirst.indexOf(',')),
        storedKey: Buffer.from(String(credential.storedKey ?? ''), 'base64'),
        serverKey: Buffer.from(String(credential.serverKey ?? ''), 'base64'),
        roles: rolesOf(document),
        phase: 'final'
    }
    return { conversationId: { $numberInt: '1' }, done: false, payload: binaryPayload(serverFirst), ok: OK }
}

export function saslStartCommand(session: { store: any; cursors: any; auth: AuthState }, command: any): any {
    return startConversation(session, command)
}

export function saslContinueCommand(session: { auth: AuthState }, command: any): any {
    const conversation = session.auth.conversation
    const identifier = numeric(command.conversationId)
    if (conversation === null || identifier !== 1) return authError(17, 'ProtocolError', 'No SASL session state found')
    if (conversation.phase === 'finish') {
        session.auth.conversation = null
        if (!session.auth.users.some((entry) => entry.user === conversation.user && entry.db === conversation.db)) {
            session.auth.users.push({ user: conversation.user, db: conversation.db })
            session.auth.roles.push(...conversation.roles)
        }
        return { conversationId: { $numberInt: '1' }, done: true, payload: binaryPayload(''), ok: OK }
    }
    const payload = payloadText(command.payload)
    if (payload === null) {
        session.auth.conversation = null
        return authError(10270, 'Location10270', 'Failed decoding SASL payload: invalid base64')
    }
    const fields: Record<string, string> = {}
    for (const part of payload.split(',')) {
        const equals = part.indexOf('=')
        if (equals > 0) fields[part.slice(0, equals)] = part.slice(equals + 1)
    }
    const fail = () => {
        session.auth.conversation = null
        return authError(18, 'AuthenticationFailed', 'Authentication failed.')
    }
    // `mongod 8.0.9` does not verify the `c=` channel-binding field (it accepts
    // a proof built over any `c=` value), so neither do we; the client nonce
    // and the proof still have to match.
    if (fields.r !== conversation.nonce || typeof fields.p !== 'string') return fail()
    const parameters = scramParameters(conversation.mechanism)
    const withoutProof = `c=${fields.c},r=${fields.r}`
    const authMessage = `${conversation.clientFirstBare},${conversation.serverFirst},${withoutProof}`
    const clientSignature = createHmac(parameters.digest, conversation.storedKey).update(authMessage).digest()
    const proof = Buffer.from(fields.p, 'base64')
    if (proof.length !== parameters.keyLength) return fail()
    const clientKey = Buffer.alloc(proof.length)
    for (let index = 0; index < proof.length; index += 1) clientKey[index] = proof[index] ^ clientSignature[index]
    const storedKey = createHash(parameters.digest).update(clientKey).digest()
    if (!timingSafeEqual(storedKey, conversation.storedKey)) return fail()
    const serverSignature = createHmac(parameters.digest, conversation.serverKey).update(authMessage).digest()
    conversation.phase = 'finish'
    return {
        conversationId: { $numberInt: '1' },
        done: false,
        payload: binaryPayload(`v=${serverSignature.toString('base64')}`),
        ok: OK
    }
}

export function logoutCommand(session: { auth: AuthState }): any {
    session.auth.users = []
    session.auth.roles = []
    session.auth.conversation = null
    return { ok: OK }
}

/** Mechanism order `mongod 8.0.9` reports in `usersInfo` and `showCredentials`. */
const USER_REPORT_MECHANISMS: ScramMechanism[] = ['SCRAM-SHA-1', 'SCRAM-SHA-256']

const USER_LOOKUP_FIELDS = new Set(['user', 'db'])

/** Every user document of one database, in stored `_id` order. */
function storedUsers(session: { store: any; cursors: any }, db: string): any[] {
    const find = JSON.stringify({ find: 'system.users', filter: {}, $db: db })
    const batch = JSON.parse(binding.find(session.store, session.cursors, find))?.cursor?.firstBatch
    return Array.isArray(batch) ? batch : []
}

function storedDatabases(store: any): string[] {
    const databases = JSON.parse(binding.listDatabases(store))?.databases
    if (!Array.isArray(databases)) return []
    return databases.map((entry: any) => entry?.name).filter((name: unknown): name is string => typeof name === 'string')
}

/** Tags that canonical extended JSON uses to wrap a non-document value. */
const SCALAR_TAGS = [
    '$numberInt',
    '$numberLong',
    '$numberDouble',
    '$numberDecimal',
    '$oid',
    '$date',
    '$timestamp',
    '$binary',
    '$code',
    '$minKey',
    '$maxKey',
    '$symbol',
    '$dbPointer',
    '$regex'
]

/**
 * Whether a decoded command value is a BSON document. Canonical extended JSON
 * turns scalars such as `1` into `{"$numberInt":"1"}` before they reach this
 * layer, so a wrapped scalar must not be mistaken for a role document.
 */
function isDocumentValue(value: unknown): value is Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
    const keys = Object.keys(value as Record<string, unknown>)
    return !(keys.length === 1 && SCALAR_TAGS.includes(keys[0]))
}

/** BSON type name used by `mongod`'s lookup validation messages. */
function typeName(value: unknown): string {
    if (value === null) return 'null'
    if (Array.isArray(value)) return 'array'
    if (typeof value === 'string') return 'string'
    if (typeof value === 'boolean') return 'bool'
    if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'double'
    if (typeof value === 'object') {
        const tag = value as Record<string, unknown>
        if (Object.hasOwn(tag, '$numberInt')) return 'int'
        if (Object.hasOwn(tag, '$numberLong')) return 'long'
        if (Object.hasOwn(tag, '$numberDouble')) return 'double'
        if (Object.hasOwn(tag, '$numberDecimal')) return 'decimal'
        if (Object.hasOwn(tag, '$binary')) return 'binData'
        return 'object'
    }
    return 'undefined'
}

interface UserSelection {
    db: string
    user: string
}

/**
 * Parses the polymorphic `usersInfo` argument: `1` for every user of the
 * current database, a name, `{user, db}`, an array of either, or
 * `{forAllDBs: true}`. Replies carry the same validation texts
 * `mongod 8.0.9` produces.
 */
function parseUserSelection(value: any, currentDb: string): UserSelection[] | { error: any } | { allDatabases: true } | { allInDb: string } {
    if (typeof value === 'string') return [{ db: currentDb, user: value }]
    if (Array.isArray(value)) {
        if (value.length === 0) return { error: badValue('$or argument must be a non-empty array') }
        const selections: UserSelection[] = []
        for (const element of value) {
            const parsed = parseUserSelection(element, currentDb)
            if (!Array.isArray(parsed)) return parsed
            selections.push(...parsed)
        }
        return selections
    }
    // A numeric lookup means "every user of this database" when it truncates to
    // 1, which is the only numeric form `mongod 8.0.9` accepts.
    const number = numeric(value)
    if (Number.isFinite(number)) {
        if (Math.trunc(number) === 1) return { allInDb: currentDb }
        return { error: badValue('UserName must be either a string or an object') }
    }
    if (value === null || typeof value !== 'object') return { error: badValue('UserName must be either a string or an object') }
    if (Object.hasOwn(value, 'forAllDBs') && value.forAllDBs === true) return { allDatabases: true }
    for (const key of Object.keys(value)) {
        if (!USER_LOOKUP_FIELDS.has(key)) return { error: badValue(`UserName contains an unknown field named: '${key}`) }
    }
    if (!Object.hasOwn(value, 'user')) return { error: badValue('UserName must contain a field named: user') }
    if (typeof value.user !== 'string') {
        return { error: badValue(`UserName must contain a string field named: user. But, has type ${typeName(value.user)}`) }
    }
    if (!Object.hasOwn(value, 'db')) return { error: badValue('UserName must contain a field named: db') }
    if (typeof value.db !== 'string') {
        return { error: badValue(`UserName must contain a string field named: db. But, has type ${typeName(value.db)}`) }
    }
    return [{ db: value.db, user: value.user }]
}

function sortedRoles(document: any): AuthRole[] {
    return rolesOf(document).sort((left, right) =>
        left.role < right.role ? -1 : left.role > right.role ? 1 : left.db < right.db ? -1 : left.db > right.db ? 1 : 0
    )
}

/** One entry of `usersInfo.users`, in `mongod`'s field order. */
function userReport(document: any, showCredentials: boolean, showPrivileges: boolean, resolve: RoleResolver): any {
    const report: any = {
        _id: document._id,
        userId: document.userId,
        user: document.user,
        db: document.db
    }
    const mechanisms = USER_REPORT_MECHANISMS.filter((mechanism) => document.credentials?.[mechanism] !== undefined)
    // `mongod` moves `mechanisms` ahead of the credentials only when privileges
    // are expanded; otherwise it sits after `roles`.
    if (showPrivileges) report.mechanisms = mechanisms
    if (showCredentials) {
        const credentials: any = {}
        for (const mechanism of mechanisms) credentials[mechanism] = document.credentials[mechanism]
        report.credentials = credentials
    }
    report.roles = sortedRoles(document)
    if (!showPrivileges) report.mechanisms = mechanisms
    if (showPrivileges) {
        // The same expansion the dispatch layer enforces answers here, so a
        // reported privilege is always one that would be honoured.
        const expanded = expandRoles(report.roles, resolve)
        report.inheritedRoles = expanded.inheritedRoles
        report.inheritedPrivileges = expanded.privileges
        report.inheritedAuthenticationRestrictions = expanded.authenticationRestrictions
    }
    return report
}

/**
 * `usersInfo`, the command behind `show users`.
 *
 * Credentials are read back from `<db>.system.users`; `showCredentials` returns
 * the stored document and `showPrivileges` expands the built-in roles through
 * the same table the dispatch layer authorizes against.
 */
export function usersInfoCommand(session: { store: any; cursors: any }, command: any): any {
    const currentDb = command.$db ?? 'admin'
    const parsed = parseUserSelection(command.usersInfo, currentDb)
    if ('error' in parsed) return parsed.error
    const showCredentials = command.showCredentials === true
    const showPrivileges = command.showPrivileges === true

    const documents: any[] = []
    if ('allDatabases' in parsed) {
        for (const db of storedDatabases(session.store)) documents.push(...storedUsers(session, db))
    }
    else if ('allInDb' in parsed) {
        documents.push(...storedUsers(session, parsed.allInDb))
    }
    else {
        const groups = new Map<string, Set<string>>()
        for (const selection of parsed) {
            const users = groups.get(selection.db) ?? new Set<string>()
            users.add(selection.user)
            groups.set(selection.db, users)
        }
        for (const [db, names] of groups) {
            for (const document of storedUsers(session, db)) {
                if (names.has(document.user)) documents.push(document)
            }
        }
    }
    return { users: documents.map((document) => userReport(document, showCredentials, showPrivileges, makeStoreResolver(session))), ok: OK }
}

/** Commands `mongod 8.0.9` answers before authentication. */
const PRE_AUTH_COMMANDS = new Set(['hello', 'isMaster', 'ismaster', 'ping', 'buildInfo', 'connectionStatus', 'saslStart', 'saslContinue', 'authenticate'])

export function allowedBeforeAuth(name: string): boolean {
    return PRE_AUTH_COMMANDS.has(name)
}

/** Reply for a command outside the pre-authentication surface. */
export function authenticationRequired(name: string): any {
    return authError(13, 'Unauthorized', `Command ${name} requires authentication`)
}
