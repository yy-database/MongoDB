// SCRAM-SHA-256 / SCRAM-SHA-1 authentication, matched against `mongod 8.0.9`.
//
// Credentials live in `<db>.system.users` inside this server's own store, in the
// same document shape `mongod` writes (`_id`, `userId`, `user`, `db`,
// `credentials`, `roles`). Salts and digests are produced here; the store is
// only reached through the `mongo-core` primitives, so no authentication state
// leaves the connection that owns it.
import { createHash, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto'
import { binding } from './binding.ts'

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
    return mechanism === 'SCRAM-SHA-256' ? password : createHash('md5').update(`${user}:mongo:${password}`, 'utf8').digest('hex')
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
    const credentials: any = {}
    for (const mechanism of mechanisms) credentials[mechanism] = makeCredentials(mechanism, name, command.pwd)
    // A string role names the current database, as `mongod` stores it.
    const roles = Array.isArray(command.roles)
        ? command.roles.map((role: unknown) => (typeof role === 'string' ? { role, db } : role))
        : []
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
    // GS2 header is `n,,` or `y,,`; the client-first bare follows.
    if (!payload.startsWith('n,,') && !payload.startsWith('y,,')) return authError(18, 'AuthenticationFailed', 'Authentication failed.')
    const clientFirstBare = payload.slice(3)
    const parsed = /^n=([^,]*),r=(.+)$/.exec(clientFirstBare)
    if (!parsed) return authError(18, 'AuthenticationFailed', 'Authentication failed.')
    const user = parsed[1]
    const clientNonce = parsed[2]
    if (user.length === 0) return authError(18, 'AuthenticationFailed', 'Authentication failed.')
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
    if (fields.c !== 'biws' || fields.r !== conversation.nonce || typeof fields.p !== 'string') return fail()
    const parameters = scramParameters(conversation.mechanism)
    const withoutProof = `c=biws,r=${fields.r}`
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
function userReport(document: any, showCredentials: boolean, showPrivileges: boolean): any {
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
        // Role inheritance is not modelled: the stored roles are the inherited
        // roles, and no privilege is expanded from them.
        report.inheritedRoles = report.roles
        report.inheritedPrivileges = []
        report.inheritedAuthenticationRestrictions = []
    }
    return report
}

/**
 * `usersInfo`, the command behind `show users`.
 *
 * Credentials are read back from `<db>.system.users`; `showCredentials` returns
 * the stored document and `showPrivileges` reports stored roles without
 * expanding built-in privileges (see `KNOWN-DIFFERENCES.md`).
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
    return { users: documents.map((document) => userReport(document, showCredentials, showPrivileges)), ok: OK }
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
