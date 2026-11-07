// Role-based authorization for the TypeScript dispatch layer.
//
// `mongod 8.0.9` answers commands only when one of the user's roles grants the
// matching action on the command's resource. The built-in role expansions below
// are transcribed from `usersInfo({showPrivileges: true})` replies read from a
// real `--auth` server (see `KNOWN-DIFFERENCES.md` for the roles that are not
// modelled). The same table drives both `showPrivileges` and the dispatch
// checks, so a privilege can never be reported without also being enforced.
import type { AuthRole } from './auth.ts'

export interface Resource {
    db?: string
    collection?: string
    cluster?: true
    anyResource?: true
    system_buckets?: string
}

export interface Privilege {
    resource: Resource
    actions: string[]
}

export interface Requirement {
    action: string
    /** Cluster-wide requirement, e.g. `serverStatus` or `replSetGetStatus`. */
    cluster?: true
    db?: string
    collection?: string
}

/** `read` actions, shared by its two resources. */
const READ_ACTIONS = [
    'changeStream',
    'collStats',
    'dbHash',
    'dbStats',
    'find',
    'killCursors',
    'listCollections',
    'listIndexes',
    'listSearchIndexes',
    'planCacheRead'
]

/** `readWrite` actions, shared by its two resources. */
const READ_WRITE_ACTIONS = [
    'changeStream',
    'cleanupStructuredEncryptionData',
    'collStats',
    'compactStructuredEncryptionData',
    'convertToCapped',
    'createCollection',
    'createIndex',
    'createSearchIndexes',
    'dbHash',
    'dbStats',
    'dropCollection',
    'dropIndex',
    'dropSearchIndex',
    'find',
    'insert',
    'killCursors',
    'listCollections',
    'listIndexes',
    'listSearchIndexes',
    'updateSearchIndex',
    'planCacheRead',
    'remove',
    'renameCollectionSameDB',
    'update'
]

interface DbScopedRole {
    /** Collection name inside the user's database; the empty string covers all. */
    collection: string
    actions: string[]
}

/** Roles whose privileges `mongod` scopes to the database the role is granted on. */
const DB_SCOPED_ROLES: Record<string, DbScopedRole[]> = {
    read: [
        { collection: '', actions: READ_ACTIONS },
        { collection: 'system.js', actions: READ_ACTIONS }
    ],
    readWrite: [
        { collection: '', actions: READ_WRITE_ACTIONS },
        { collection: 'system.js', actions: READ_WRITE_ACTIONS }
    ],
    dbAdmin: [
        {
            collection: '',
            actions: [
                'analyze',
                'bypassDocumentValidation',
                'collMod',
                'collStats',
                'compact',
                'configureQueryAnalyzer',
                'convertToCapped',
                'createCollection',
                'createIndex',
                'createSearchIndexes',
                'dbStats',
                'dropCollection',
                'dropDatabase',
                'dropIndex',
                'dropSearchIndex',
                'enableProfiler',
                'listCollections',
                'listIndexes',
                'listSearchIndexes',
                'updateSearchIndex',
                'planCacheIndexFilter',
                'planCacheRead',
                'planCacheWrite',
                'reIndex',
                'renameCollectionSameDB',
                'storageDetails',
                'validate'
            ]
        },
        {
            collection: 'system.profile',
            actions: [
                'changeStream',
                'collStats',
                'convertToCapped',
                'createCollection',
                'dbHash',
                'dbStats',
                'dropCollection',
                'find',
                'killCursors',
                'listCollections',
                'listIndexes',
                'listSearchIndexes',
                'planCacheRead'
            ]
        }
    ],
    userAdmin: [
        {
            collection: '',
            actions: [
                'changeCustomData',
                'changePassword',
                'createRole',
                'createUser',
                'dropRole',
                'dropUser',
                'grantRole',
                'revokeRole',
                'setAuthenticationRestriction',
                'viewRole',
                'viewUser'
            ]
        }
    ]
}

const CLUSTER_READ_ACTIONS = READ_ACTIONS

/** `clusterAdmin` and `root`, whose resources are fixed rather than db-scoped. */
const CLUSTER_BOUND_ROLES: Record<string, Privilege[]> = {
    clusterAdmin: [],
    root: []
}

function privilege(resource: Resource, actions: string[]): Privilege {
    return { resource, actions }
}

/** `clusterAdmin` privileges, in the order `mongod 8.0.9` reports them. */
const CLUSTER_ADMIN_PRIVILEGES: Privilege[] = [
    privilege({ db: 'config', collection: '' }, [
        'analyzeShardKey',
        'changeStream',
        'clearJumboFlag',
        'collStats',
        'configureQueryAnalyzer',
        'dbHash',
        'dbStats',
        'enableSharding',
        'find',
        'getDatabaseVersion',
        'getShardVersion',
        'indexStats',
        'insert',
        'killCursors',
        'listCollections',
        'listIndexes',
        'listSearchIndexes',
        'moveChunk',
        'moveCollection',
        'planCacheRead',
        'refineCollectionShardKey',
        'remove',
        'reshardCollection',
        'splitChunk',
        'splitVector',
        'unshardCollection',
        'update'
    ]),
    privilege({ db: 'config', collection: 'system.js' }, CLUSTER_READ_ACTIONS),
    privilege({ db: 'local', collection: '' }, [
        'analyzeShardKey',
        'changeStream',
        'clearJumboFlag',
        'collStats',
        'configureQueryAnalyzer',
        'dbHash',
        'dbStats',
        'enableSharding',
        'find',
        'getDatabaseVersion',
        'getShardVersion',
        'indexStats',
        'insert',
        'killCursors',
        'listCollections',
        'listIndexes',
        'listSearchIndexes',
        'moveChunk',
        'moveCollection',
        'planCacheRead',
        'refineCollectionShardKey',
        'remove',
        'reshardCollection',
        'splitChunk',
        'splitVector',
        'unshardCollection',
        'update'
    ]),
    privilege({ db: 'local', collection: 'system.js' }, CLUSTER_READ_ACTIONS),
    privilege({ cluster: true }, [
        'addShard',
        'allCollectionStats',
        'appendOplogNote',
        'applicationMessage',
        'auditConfigure',
        'checkMetadataConsistency',
        'cleanupOrphaned',
        'compact',
        'connPoolStats',
        'connPoolSync',
        'dropConnections',
        'flushRouterConfig',
        'fsync',
        'getClusterParameter',
        'getDefaultRWConcern',
        'getCmdLineOpts',
        'getLog',
        'getParameter',
        'getShardMap',
        'hostInfo',
        'inprog',
        'invalidateUserCache',
        'killAnyCursor',
        'killAnySession',
        'killop',
        'listDatabases',
        'listSampledQueries',
        'listSessions',
        'listShards',
        'logRotate',
        'netstat',
        'oidcListKeys',
        'oidcRefreshKeys',
        'oidReset',
        'operationMetrics',
        'querySettings',
        'queryStatsRead',
        'queryStatsReadTransformed',
        'removeShard',
        'replSetConfigure',
        'replSetGetConfig',
        'replSetGetStatus',
        'replSetResizeOplog',
        'replSetStateChange',
        'resync',
        'rotateCertificates',
        'runTenantMigration',
        'serverStatus',
        'setClusterParameter',
        'setDefaultRWConcern',
        'setFeatureCompatibilityVersion',
        'setParameter',
        'shardedDataDistribution',
        'shardingState',
        'shutdown',
        'top',
        'touch',
        'trafficRecord',
        'transitionFromDedicatedConfigServer',
        'transitionToDedicatedConfigServer',
        'unlock',
        'useUUID',
        'setChangeStreamState',
        'getChangeStreamState'
    ]),
    privilege({ db: '', collection: '' }, [
        'analyzeShardKey',
        'clearJumboFlag',
        'collStats',
        'configureQueryAnalyzer',
        'dbStats',
        'dropDatabase',
        'enableSharding',
        'getDatabaseVersion',
        'getShardVersion',
        'indexStats',
        'killCursors',
        'moveChunk',
        'moveCollection',
        'refineCollectionShardKey',
        'reshardCollection',
        'splitChunk',
        'splitVector',
        'unshardCollection'
    ]),
    privilege({ system_buckets: '' }, [
        'analyzeShardKey',
        'clearJumboFlag',
        'collStats',
        'configureQueryAnalyzer',
        'dbStats',
        'enableSharding',
        'getDatabaseVersion',
        'getShardVersion',
        'indexStats',
        'moveChunk',
        'moveCollection',
        'refineCollectionShardKey',
        'reshardCollection',
        'splitChunk',
        'splitVector',
        'unshardCollection'
    ]),
    privilege({ db: 'config', collection: 'system.sessions' }, [
        'collStats',
        'dbStats',
        'getDatabaseVersion',
        'getShardVersion',
        'indexStats'
    ]),
    privilege({ db: 'local', collection: 'system.replset' }, CLUSTER_READ_ACTIONS),
    privilege({ db: 'local', collection: 'replset.election' }, ['find', 'insert', 'remove', 'update']),
    privilege({ db: 'local', collection: 'replset.minvalid' }, ['find', 'insert', 'remove', 'update']),
    privilege({ db: '', collection: 'system.profile' }, ['find']),
    privilege({ anyResource: true }, ['dbCheck', 'exportCollection', 'importCollection']),
    privilege({ db: 'local', collection: 'system.healthlog' }, CLUSTER_READ_ACTIONS)
]

/** `root` privileges, in the order `mongod 8.0.9` reports them. */
const ROOT_PRIVILEGES: Privilege[] = [
    privilege({ db: 'config', collection: '' }, [
        'analyzeShardKey',
        'bypassDocumentValidation',
        'changeCustomData',
        'changePassword',
        'changeStream',
        'clearJumboFlag',
        'collMod',
        'collStats',
        'configureQueryAnalyzer',
        'convertToCapped',
        'createCollection',
        'createIndex',
        'createRole',
        'createSearchIndexes',
        'createUser',
        'dbHash',
        'dbStats',
        'dropCollection',
        'dropRole',
        'dropUser',
        'enableSharding',
        'find',
        'getDatabaseVersion',
        'getShardVersion',
        'grantRole',
        'indexStats',
        'insert',
        'killCursors',
        'listCollections',
        'listIndexes',
        'listSearchIndexes',
        'updateSearchIndex',
        'moveChunk',
        'moveCollection',
        'planCacheRead',
        'refineCollectionShardKey',
        'remove',
        'reshardCollection',
        'revokeRole',
        'setAuthenticationRestriction',
        'splitChunk',
        'splitVector',
        'unshardCollection',
        'update',
        'viewRole',
        'viewUser'
    ]),
    privilege({ db: 'config', collection: 'system.js' }, CLUSTER_READ_ACTIONS),
    privilege({ db: 'local', collection: '' }, [
        'analyzeShardKey',
        'bypassDocumentValidation',
        'changeCustomData',
        'changePassword',
        'changeStream',
        'clearJumboFlag',
        'collMod',
        'collStats',
        'configureQueryAnalyzer',
        'convertToCapped',
        'createCollection',
        'createIndex',
        'createRole',
        'createSearchIndexes',
        'createUser',
        'dbHash',
        'dbStats',
        'dropCollection',
        'dropRole',
        'dropUser',
        'enableSharding',
        'find',
        'getDatabaseVersion',
        'getShardVersion',
        'grantRole',
        'indexStats',
        'insert',
        'killCursors',
        'listCollections',
        'listIndexes',
        'listSearchIndexes',
        'updateSearchIndex',
        'moveChunk',
        'moveCollection',
        'planCacheRead',
        'refineCollectionShardKey',
        'remove',
        'reshardCollection',
        'revokeRole',
        'setAuthenticationRestriction',
        'splitChunk',
        'splitVector',
        'unshardCollection',
        'update',
        'viewRole',
        'viewUser'
    ]),
    privilege({ db: 'local', collection: 'system.js' }, CLUSTER_READ_ACTIONS),
    privilege({ cluster: true }, [
        'addShard',
        'allCollectionStats',
        'appendOplogNote',
        'applicationMessage',
        'auditConfigure',
        'authSchemaUpgrade',
        'bypassDefaultMaxTimeMS',
        'bypassWriteBlockingMode',
        'checkMetadataConsistency',
        'cleanupOrphaned',
        'compact',
        'connPoolStats',
        'connPoolSync',
        'dropConnections',
        'flushRouterConfig',
        'forceUUID',
        'fsync',
        'getClusterParameter',
        'getDefaultRWConcern',
        'getCmdLineOpts',
        'getLog',
        'getParameter',
        'getShardMap',
        'hostInfo',
        'inprog',
        'invalidateUserCache',
        'issueDirectShardOperations',
        'killAnyCursor',
        'killAnySession',
        'killop',
        'listDatabases',
        'listSampledQueries',
        'listSessions',
        'listShards',
        'logRotate',
        'netstat',
        'oidcListKeys',
        'oidcRefreshKeys',
        'oidReset',
        'operationMetrics',
        'querySettings',
        'queryStatsRead',
        'queryStatsReadTransformed',
        'removeShard',
        'replSetConfigure',
        'replSetGetConfig',
        'replSetGetStatus',
        'replSetResizeOplog',
        'replSetStateChange',
        'resync',
        'rotateCertificates',
        'runTenantMigration',
        'serverStatus',
        'setClusterParameter',
        'setDefaultRWConcern',
        'setFeatureCompatibilityVersion',
        'setParameter',
        'setUserWriteBlockMode',
        'shardedDataDistribution',
        'shardingState',
        'shutdown',
        'top',
        'touch',
        'trafficRecord',
        'transitionFromDedicatedConfigServer',
        'transitionToDedicatedConfigServer',
        'unlock',
        'useTenant',
        'useUUID',
        'viewUser',
        'applyOps',
        'setChangeStreamState',
        'getChangeStreamState'
    ]),
    privilege({ db: '', collection: '' }, [
        'analyze',
        'analyzeShardKey',
        'bypassDocumentValidation',
        'changeCustomData',
        'changePassword',
        'changeStream',
        'clearJumboFlag',
        'cleanupStructuredEncryptionData',
        'collMod',
        'collStats',
        'compact',
        'compactStructuredEncryptionData',
        'configureQueryAnalyzer',
        'convertToCapped',
        'createCollection',
        'createIndex',
        'createRole',
        'createSearchIndexes',
        'createUser',
        'dbHash',
        'dbStats',
        'dropCollection',
        'dropDatabase',
        'dropIndex',
        'dropRole',
        'dropSearchIndex',
        'dropUser',
        'enableProfiler',
        'enableSharding',
        'find',
        'getDatabaseVersion',
        'getShardVersion',
        'grantRole',
        'indexStats',
        'insert',
        'killCursors',
        'listCachedAndActiveUsers',
        'listCollections',
        'listIndexes',
        'listSearchIndexes',
        'updateSearchIndex',
        'moveChunk',
        'moveCollection',
        'planCacheIndexFilter',
        'planCacheRead',
        'planCacheWrite',
        'refineCollectionShardKey',
        'reIndex',
        'remove',
        'renameCollectionSameDB',
        'reshardCollection',
        'revokeRole',
        'setAuthenticationRestriction',
        'splitChunk',
        'splitVector',
        'storageDetails',
        'unshardCollection',
        'update',
        'validate',
        'viewRole',
        'viewUser'
    ]),
    privilege({ system_buckets: '' }, [
        'analyze',
        'analyzeShardKey',
        'bypassDocumentValidation',
        'changeStream',
        'clearJumboFlag',
        'cleanupStructuredEncryptionData',
        'collMod',
        'collStats',
        'compact',
        'compactStructuredEncryptionData',
        'configureQueryAnalyzer',
        'convertToCapped',
        'createCollection',
        'createIndex',
        'createSearchIndexes',
        'dbHash',
        'dbStats',
        'dropCollection',
        'dropDatabase',
        'dropIndex',
        'dropSearchIndex',
        'enableProfiler',
        'enableSharding',
        'find',
        'getDatabaseVersion',
        'getShardVersion',
        'indexStats',
        'insert',
        'killCursors',
        'listCollections',
        'listIndexes',
        'listSearchIndexes',
        'updateSearchIndex',
        'moveChunk',
        'moveCollection',
        'planCacheIndexFilter',
        'planCacheRead',
        'planCacheWrite',
        'refineCollectionShardKey',
        'reIndex',
        'remove',
        'renameCollectionSameDB',
        'reshardCollection',
        'splitChunk',
        'splitVector',
        'storageDetails',
        'unshardCollection',
        'update',
        'validate'
    ]),
    privilege({ db: 'config', collection: 'system.sessions' }, [
        'collStats',
        'dbStats',
        'getDatabaseVersion',
        'getShardVersion',
        'indexStats'
    ]),
    privilege({ db: 'local', collection: 'system.replset' }, [
        'bypassDocumentValidation',
        'changeStream',
        'collMod',
        'collStats',
        'convertToCapped',
        'createCollection',
        'createIndex',
        'createSearchIndexes',
        'dbHash',
        'dbStats',
        'dropCollection',
        'find',
        'insert',
        'killCursors',
        'listCollections',
        'listIndexes',
        'listSearchIndexes',
        'updateSearchIndex',
        'planCacheRead'
    ]),
    privilege({ db: 'local', collection: 'replset.election' }, [
        'bypassDocumentValidation',
        'collMod',
        'convertToCapped',
        'createCollection',
        'createIndex',
        'createSearchIndexes',
        'dropCollection',
        'find',
        'insert',
        'updateSearchIndex',
        'remove',
        'update'
    ]),
    privilege({ db: 'local', collection: 'replset.minvalid' }, [
        'bypassDocumentValidation',
        'collMod',
        'convertToCapped',
        'createCollection',
        'createIndex',
        'createSearchIndexes',
        'dropCollection',
        'find',
        'insert',
        'updateSearchIndex',
        'remove',
        'update'
    ]),
    privilege({ db: '', collection: 'system.profile' }, [
        'changeStream',
        'collStats',
        'convertToCapped',
        'createCollection',
        'dbHash',
        'dbStats',
        'dropCollection',
        'find',
        'killCursors',
        'listCollections',
        'listIndexes',
        'listSearchIndexes',
        'planCacheRead'
    ]),
    privilege({ anyResource: true }, [
        'collStats',
        'dbCheck',
        'exportCollection',
        'importCollection',
        'listCollections',
        'listIndexes',
        'listSearchIndexes',
        'validate'
    ]),
    privilege({ db: 'local', collection: 'system.healthlog' }, CLUSTER_READ_ACTIONS),
    privilege({ db: 'admin', collection: 'system.users' }, [
        'changeStream',
        'collStats',
        'createIndex',
        'createSearchIndexes',
        'dbHash',
        'dbStats',
        'dropIndex',
        'dropSearchIndex',
        'find',
        'killCursors',
        'listCollections',
        'listIndexes',
        'listSearchIndexes',
        'planCacheRead'
    ]),
    privilege({ db: 'admin', collection: 'system.roles' }, [
        'changeStream',
        'collStats',
        'createIndex',
        'createSearchIndexes',
        'dbHash',
        'dbStats',
        'dropIndex',
        'dropSearchIndex',
        'find',
        'killCursors',
        'listCollections',
        'listIndexes',
        'listSearchIndexes',
        'planCacheRead'
    ]),
    privilege({ db: '', collection: 'system.users' }, [
        'bypassDocumentValidation',
        'changeStream',
        'collMod',
        'collStats',
        'convertToCapped',
        'createCollection',
        'createIndex',
        'createSearchIndexes',
        'dbHash',
        'dbStats',
        'dropCollection',
        'find',
        'insert',
        'killCursors',
        'listCollections',
        'listIndexes',
        'listSearchIndexes',
        'updateSearchIndex',
        'planCacheRead',
        'remove',
        'update'
    ]),
    privilege({ db: 'admin', collection: 'system.version' }, [
        'bypassDocumentValidation',
        'changeStream',
        'collMod',
        'collStats',
        'convertToCapped',
        'createCollection',
        'createIndex',
        'createSearchIndexes',
        'dbHash',
        'dbStats',
        'dropCollection',
        'find',
        'insert',
        'killCursors',
        'listCollections',
        'listIndexes',
        'listSearchIndexes',
        'updateSearchIndex',
        'planCacheRead'
    ]),
    privilege({ db: 'admin', collection: 'system.backup_users' }, [
        'bypassDocumentValidation',
        'changeStream',
        'collMod',
        'collStats',
        'convertToCapped',
        'createCollection',
        'createIndex',
        'createSearchIndexes',
        'dbHash',
        'dbStats',
        'dropCollection',
        'find',
        'insert',
        'killCursors',
        'listCollections',
        'listIndexes',
        'listSearchIndexes',
        'updateSearchIndex',
        'planCacheRead'
    ]),
    privilege({ db: '', collection: 'system.js' }, [
        'bypassDocumentValidation',
        'changeStream',
        'cleanupStructuredEncryptionData',
        'collMod',
        'collStats',
        'compactStructuredEncryptionData',
        'convertToCapped',
        'createCollection',
        'createIndex',
        'createSearchIndexes',
        'dbHash',
        'dbStats',
        'dropCollection',
        'dropIndex',
        'dropSearchIndex',
        'find',
        'insert',
        'killCursors',
        'listCollections',
        'listIndexes',
        'listSearchIndexes',
        'updateSearchIndex',
        'planCacheRead',
        'remove',
        'renameCollectionSameDB',
        'update'
    ]),
    privilege({ db: 'config', collection: 'settings' }, ['find', 'insert', 'update']),
    privilege({ db: 'admin', collection: 'tempusers' }, ['find']),
    privilege({ db: 'admin', collection: 'temproles' }, ['find']),
    privilege({ db: '', collection: 'system.views' }, ['dropCollection']),
    privilege({ db: 'config', collection: 'system.preimages' }, ['find', 'remove']),
    privilege({ db: 'config', collection: 'system.change_collection' }, ['find', 'insert', 'remove', 'update'])
]

CLUSTER_BOUND_ROLES.clusterAdmin = CLUSTER_ADMIN_PRIVILEGES
CLUSTER_BOUND_ROLES.root = ROOT_PRIVILEGES

/** Built-in roles `mongod` resolves without a matching `system.roles` document. */
const BUILTIN_ROLE_NAMES = new Set(Object.keys(DB_SCOPED_ROLES).concat(Object.keys(CLUSTER_BOUND_ROLES)))

/**
 * Whether `role` names a built-in role at that database. Cluster-wide roles
 * (`clusterAdmin`, `root`) only resolve on `admin`; database roles resolve on
 * any database, including one that does not exist, as `mongod 8.0.9` does.
 */
export function builtinRoleExists(role: { role: string; db: string }): boolean {
    if (!BUILTIN_ROLE_NAMES.has(role.role)) return false
    if (Object.hasOwn(CLUSTER_BOUND_ROLES, role.role)) return role.db === 'admin'
    return true
}

/** Expands stored roles into the privilege set `showPrivileges` reports. */
export function privilegesForRoles(roles: AuthRole[]): Privilege[] {
    const privileges: Privilege[] = []
    for (const role of roles) {
        const scoped = DB_SCOPED_ROLES[role.role]
        if (scoped) {
            for (const entry of scoped) {
                privileges.push({ resource: { db: role.db, collection: entry.collection }, actions: [...entry.actions] })
            }
        }
        const fixed = CLUSTER_BOUND_ROLES[role.role]
        if (fixed) {
            for (const entry of fixed) privileges.push({ resource: { ...entry.resource }, actions: [...entry.actions] })
        }
    }
    return privileges
}

/** Whether a privilege's resource covers a `{db, collection}` target. */
function covers(resource: Resource, db: string, collection: string): boolean {
    if (resource.anyResource === true) return true
    if (resource.cluster === true || resource.system_buckets === '') return false
    const resourceDb = resource.db ?? ''
    const resourceCollection = resource.collection ?? ''
    if (resourceDb !== '' && resourceDb !== db) return false
    if (resourceCollection !== '' && resourceCollection !== collection) return false
    return true
}

function grants(privileges: Privilege[], action: string, db: string, collection: string): boolean {
    return privileges.some((entry) => entry.actions.includes(action) && covers(entry.resource, db, collection))
}

/** Whether any privilege grants a cluster-wide action, e.g. `listDatabases`. */
export function clusterGrants(privileges: Privilege[], action: string): boolean {
    return privileges.some(
        (entry) => entry.actions.includes(action) && (entry.resource.cluster === true || entry.resource.anyResource === true)
    )
}

/** Whether any privilege puts `database` inside the user's authorization scope. */
export function databaseInScope(privileges: Privilege[], database: string): boolean {
    return privileges.some((entry) => entry.actions.length > 0 && covers(entry.resource, database, ''))
}

/** `not authorized` reply, with the command document redacted like `mongod` does. */
function notAuthorized(command: any): any {
    const database = typeof command.$db === 'string' ? command.$db : 'admin'
    return {
        ok: { $numberDouble: '0.0' },
        errmsg: `not authorized on ${database} to execute command ${renderDocument(command)}`,
        code: { $numberInt: '13' },
        codeName: 'Unauthorized'
    }
}

function uuidText(base64: string): string {
    const hex = Buffer.from(base64, 'base64').toString('hex')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Extended JSON as `mongod` prints it inside an authorization failure. */
function renderValue(value: any): string {
    if (value === null || value === undefined) return 'null'
    if (typeof value === 'string') return JSON.stringify(value)
    if (typeof value === 'boolean') return value ? 'true' : 'false'
    if (typeof value === 'number') return String(value)
    if (Array.isArray(value)) {
        return value.length === 0 ? '[]' : `[ ${value.map(renderValue).join(', ')} ]`
    }
    if (typeof value === 'object') {
        const tagged = value as Record<string, any>
        const binary = tagged.$binary
        if (binary && typeof binary.base64 === 'string') {
            if (binary.subType === '04' && Buffer.from(binary.base64, 'base64').length === 16) {
                return `UUID("${uuidText(binary.base64)}")`
            }
            return `BinData(${Number.parseInt(binary.subType, 16) || 0}, "${binary.base64}")`
        }
        for (const [tag, prefix] of [
            ['$numberInt', ''],
            ['$numberLong', ''],
            ['$numberDouble', ''],
            ['$numberDecimal', '']
        ]) {
            if (tagged[tag] !== undefined) return `${prefix}${tagged[tag]}`
        }
        if (typeof tagged.$oid === 'string') return `ObjectId('${tagged.$oid}')`
        const keys = Object.keys(value)
        if (keys.length === 0) return '{}'
        return `{ ${keys.map((key) => `${key}: ${renderValue(tagged[key])}`).join(', ')} }`
    }
    return String(value)
}

/** The command as `mongod` echoes it, with `pwd` replaced by `"xxx"`. */
function renderDocument(command: any): string {
    const redacted: any = {}
    for (const [key, value] of Object.entries(command)) redacted[key] = key === 'pwd' ? 'xxx' : value
    return renderValue(redacted)
}

/** Credential collections, whose reads `mongod` gates by `viewUser` / `viewRole`. */
const CREDENTIAL_READ_ACTIONS: Record<string, string> = {
    'system.users': 'viewUser',
    'system.backup_users': 'viewUser',
    'system.roles': 'viewRole'
}

/** Commands that would write a credential collection directly. */
const CREDENTIAL_WRITE_COMMANDS = new Set(['insert', 'update', 'delete', 'bulkWrite', 'findAndModify'])

/**
 * Action a read of `collection` needs. A plain `read` role covers every
 * collection in its database, but `mongod` answers `find` on the credential
 * collections only to `viewUser` / `viewRole` holders, so those reads are not
 * satisfiable by `find` alone.
 */
function readAction(collection: string): string {
    return CREDENTIAL_READ_ACTIONS[collection] ?? 'find'
}

function credentialCollection(name: unknown): boolean {
    return typeof name === 'string' && Object.hasOwn(CREDENTIAL_READ_ACTIONS, name)
}

/** The collection a `$out` or `$merge.into` value names, defaulting to the command database. */
function outputTarget(value: any, database: string): { db: string; collection: string } | null {
    if (typeof value === 'string') return value.length > 0 ? { db: database, collection: value } : null
    if (value === null || typeof value !== 'object') return null
    if (typeof value.coll !== 'string' || value.coll.length === 0) return null
    return { db: typeof value.db === 'string' ? value.db : database, collection: value.coll }
}

/** Actions `mongod` requires for a command this server answers. */
function requirementsFor(name: string, command: any, database: string): Requirement[] | null {
    switch (name) {
        case 'find': {
            const collection = typeof command.find === 'string' ? command.find : ''
            return [{ action: readAction(collection), db: database, collection }]
        }
        case 'count': {
            const collection = typeof command.count === 'string' ? command.count : ''
            return [{ action: readAction(collection), db: database, collection }]
        }
        case 'distinct': {
            const collection = typeof command.distinct === 'string' ? command.distinct : ''
            return [{ action: readAction(collection), db: database, collection }]
        }
        case 'aggregate': {
            const pipeline = Array.isArray(command.pipeline) ? command.pipeline : []
            if (pipeline.length > 0 && typeof pipeline[0] === 'object' && pipeline[0] !== null && Object.hasOwn(pipeline[0], '$currentOp')) {
                return [{ action: 'inprog', cluster: true }]
            }
            const source = typeof command.aggregate === 'string' ? command.aggregate : ''
            const requirements: Requirement[] = [{ action: readAction(source), db: database, collection: source }]
            for (const stage of pipeline) {
                if (stage === null || typeof stage !== 'object') continue
                // `$out` and `$merge` write to another collection. Without their
                // write actions a read-only user could run a pipeline that
                // rewrites data, so the output target is authorized too.
                const out = outputTarget(stage.$out, database)
                if (out !== null) {
                    requirements.push(
                        { action: 'insert', db: out.db, collection: out.collection },
                        { action: 'remove', db: out.db, collection: out.collection }
                    )
                }
                const merge = outputTarget(stage.$merge?.into, database)
                if (merge !== null) {
                    requirements.push(
                        { action: 'insert', db: merge.db, collection: merge.collection },
                        { action: 'update', db: merge.db, collection: merge.collection }
                    )
                }
            }
            return requirements
        }
        case 'explain': {
            // `explain` requires the privileges of the explained command.
            const explained = command.explain
            if (explained !== null && typeof explained === 'object') {
                const inner = Object.keys(explained)[0]
                if (typeof inner === 'string' && inner !== 'explain') {
                    const innerRequirements = requirementsFor(inner, explained, database)
                    if (innerRequirements !== null) return innerRequirements
                }
            }
            return [{ action: 'find', db: database, collection: '' }]
        }
        case 'insert':
            return [{ action: 'insert', db: database, collection: typeof command.insert === 'string' ? command.insert : '' }]
        case 'update':
            return [{ action: 'update', db: database, collection: typeof command.update === 'string' ? command.update : '' }]
        case 'delete':
            return [{ action: 'remove', db: database, collection: typeof command.delete === 'string' ? command.delete : '' }]
        case 'findAndModify':
            return [
                { action: 'find', db: database, collection: typeof command.findAndModify === 'string' ? command.findAndModify : '' },
                { action: 'update', db: database, collection: typeof command.findAndModify === 'string' ? command.findAndModify : '' }
            ]
        case 'bulkWrite':
            return [
                { action: 'insert', db: database, collection: typeof command.bulkWrite === 'string' ? command.bulkWrite : '' },
                { action: 'update', db: database, collection: typeof command.bulkWrite === 'string' ? command.bulkWrite : '' },
                { action: 'remove', db: database, collection: typeof command.bulkWrite === 'string' ? command.bulkWrite : '' }
            ]
        case 'create':
            return [{ action: 'createCollection', db: database, collection: typeof command.create === 'string' ? command.create : '' }]
        case 'drop':
            return [{ action: 'dropCollection', db: database, collection: typeof command.drop === 'string' ? command.drop : '' }]
        case 'collMod':
            return [{ action: 'collMod', db: database, collection: typeof command.collMod === 'string' ? command.collMod : '' }]
        case 'createIndexes':
            return [{ action: 'createIndex', db: database, collection: typeof command.createIndexes === 'string' ? command.createIndexes : '' }]
        case 'dropIndexes':
            return [{ action: 'dropIndex', db: database, collection: typeof command.dropIndexes === 'string' ? command.dropIndexes : '' }]
        case 'listIndexes':
            return [{ action: 'listIndexes', db: database, collection: typeof command.listIndexes === 'string' ? command.listIndexes : '' }]
        case 'listCollections':
            return [{ action: 'listCollections', db: database, collection: '' }]
        case 'dbStats':
            return [{ action: 'dbStats', db: database, collection: '' }]
        case 'collStats':
            return [{ action: 'collStats', db: database, collection: typeof command.collStats === 'string' ? command.collStats : '' }]
        case 'dropDatabase':
            return [{ action: 'dropDatabase', db: database, collection: '' }]
        case 'createUser':
            return [{ action: 'createUser', db: database, collection: '' }]
        case 'dropUser':
            return [{ action: 'dropUser', db: database, collection: '' }]
        case 'usersInfo':
            return [{ action: 'viewUser', db: database, collection: '' }]
        case 'getMore': {
            const collection = typeof command.collection === 'string' ? command.collection : ''
            return [{ action: readAction(collection), db: database, collection }]
        }
        case 'killCursors':
            return [{ action: 'killCursors', db: database, collection: typeof command.killCursors === 'string' ? command.killCursors : '' }]
        case 'serverStatus':
            return [{ action: 'serverStatus', cluster: true }]
        case 'hostInfo':
            return [{ action: 'hostInfo', cluster: true }]
        case 'currentOp':
            return [{ action: 'inprog', cluster: true }]
        case 'killOp':
            return [{ action: 'killop', cluster: true }]
        case 'replSetGetStatus':
            return [{ action: 'replSetGetStatus', cluster: true }]
        case 'replSetGetConfig':
            return [{ action: 'replSetGetConfig', cluster: true }]
        case 'replSetInitiate':
            return [{ action: 'replSetConfigure', cluster: true }]
        default:
            return null
    }
}

/**
 * `createUser` requirements: the action that creates the user plus, for every
 * role it hands out, `grantRole` on the database that role lives on.
 *
 * Without the per-role check a `userAdmin@app` user could mint a `root@admin`
 * user and then use it, which is a privilege escalation rather than a delegated
 * administration.
 */
function createUserTargets(command: any, database: string): Requirement[] {
    const requirements: Requirement[] = [{ action: 'createUser', db: database, collection: '' }]
    const roles = Array.isArray(command.roles) ? command.roles : []
    for (const role of roles) {
        // Malformed role entries are left to the command validator, which
        // answers them with `BadValue` rather than an authorization failure.
        if (typeof role === 'string') {
            requirements.push({ action: 'grantRole', db: database, collection: '' })
            continue
        }
        if (role !== null && typeof role === 'object' && typeof role.role === 'string' && typeof role.db === 'string') {
            requirements.push({ action: 'grantRole', db: role.db, collection: '' })
        }
    }
    return requirements
}

/** `usersInfo` databases the caller must be allowed to inspect. */
function usersInfoTargets(command: any, database: string): Requirement[] {
    if (command.usersInfo && typeof command.usersInfo === 'object' && command.usersInfo.forAllDBs === true) {
        return [{ action: 'viewUser', cluster: true }]
    }
    const selections: string[] = []
    const collect = (value: any) => {
        if (typeof value === 'string') selections.push(database)
        else if (Array.isArray(value)) value.forEach(collect)
        else if (value && typeof value === 'object' && typeof value.db === 'string') selections.push(value.db)
        else selections.push(database)
    }
    collect(command.usersInfo)
    return selections.map((db) => ({ action: 'viewUser', db, collection: '' }))
}

function check(privileges: Privilege[], requirement: Requirement): boolean {
    if (requirement.cluster === true) return clusterGrants(privileges, requirement.action)
    return grants(privileges, requirement.action, requirement.db ?? '', requirement.collection ?? '')
}

/**
 * Authorization verdict for an authenticated session.
 *
 * Returns `null` when the command may run, an error document otherwise. The
 * `listDatabases` refusal keeps its own message, as `mongod` does not echo the
 * command document for it.
 */
export function authorizeCommand(session: { auth: { roles: AuthRole[] } }, command: any): any | null {
    const name = Object.keys(command)[0]
    if (typeof name !== 'string') return null
    if (name === 'listDatabases') {
        const privileges = privilegesForRoles(session.auth.roles)
        if (command.authorizedDatabases === false && !clusterGrants(privileges, 'listDatabases')) {
            return {
                ok: { $numberDouble: '0.0' },
                errmsg: 'Insufficient permissions to list all databases',
                code: { $numberInt: '13' },
                codeName: 'Unauthorized'
            }
        }
        return null
    }
    const database = typeof command.$db === 'string' ? command.$db : 'admin'
    if (CREDENTIAL_WRITE_COMMANDS.has(name) && credentialCollection(command[name])) {
        // Credentials are written only by `createUser` / `updateUser` /
        // `dropUser`, which check the roles being granted. A generic write would
        // bypass that check, so it is refused even for `root`.
        return notAuthorized(command)
    }
    const privileges = privilegesForRoles(session.auth.roles)
    const requirements =
        name === 'usersInfo'
            ? usersInfoTargets(command, database)
            : name === 'createUser'
              ? createUserTargets(command, database)
              : requirementsFor(name, command, database)
    if (requirements === null) return null
    for (const requirement of requirements) {
        if (!check(privileges, requirement)) return notAuthorized(command)
    }
    return null
}
