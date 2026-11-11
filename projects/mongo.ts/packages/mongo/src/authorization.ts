// Role-based authorization for the TypeScript dispatch layer.
//
// `mongod 8.0.9` answers commands only when one of the user's roles grants the
// matching action on the command's resource. The built-in role expansions below
// are transcribed from `usersInfo({showPrivileges: true})` replies read from a
// real server (see `KNOWN-DIFFERENCES.md` for the limits that remain). Custom
// roles are resolved from `<db>.system.roles` through the same expansion, so
// one path produces both the reported and the enforced privilege set;
// privileges that share a resource are merged into one entry with the union of
// actions in `mongod`'s canonical action order, exactly as its replies do.
import type { AuthRole } from './auth.ts'
import { binding } from './binding.ts'

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

/** `dbAdmin`'s `system.profile` actions, reused by `dbOwner`. */
const PROFILE_ACTIONS = [
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
            actions: PROFILE_ACTIONS
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
    ],
    dbOwner: [
        {
            collection: '',
            actions: [
                'analyze',
                'bypassDocumentValidation',
                'changeCustomData',
                'changePassword',
                'changeStream',
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
                'find',
                'grantRole',
                'insert',
                'killCursors',
                'listCollections',
                'listIndexes',
                'listSearchIndexes',
                'updateSearchIndex',
                'planCacheIndexFilter',
                'planCacheRead',
                'planCacheWrite',
                'reIndex',
                'remove',
                'renameCollectionSameDB',
                'revokeRole',
                'setAuthenticationRestriction',
                'storageDetails',
                'update',
                'validate',
                'viewRole',
                'viewUser'
            ]
        },
        { collection: 'system.js', actions: READ_WRITE_ACTIONS },
        { collection: 'system.profile', actions: PROFILE_ACTIONS }
    ]
}

const CLUSTER_READ_ACTIONS = READ_ACTIONS

/** Built-in roles whose resources are fixed rather than scoped to the granting database. */
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

/** `readAnyDatabase`, transcribed from `mongod 8.0.9`'s `showPrivileges`. */
const READ_ANY_DATABASE_PRIVILEGES: Privilege[] = [
    privilege({ db: '', collection: '' }, READ_ACTIONS),
    privilege({ cluster: true }, ['listDatabases']),
    privilege({ db: '', collection: 'system.js' }, READ_ACTIONS),
    privilege({ system_buckets: '' }, READ_ACTIONS)
]

/** `readWriteAnyDatabase`, transcribed from `mongod 8.0.9`'s `showPrivileges`. */
const READ_WRITE_ANY_DATABASE_PRIVILEGES: Privilege[] = [
    privilege({ db: '', collection: '' }, READ_WRITE_ACTIONS),
    privilege({ cluster: true }, ['listDatabases']),
    privilege({ db: '', collection: 'system.js' }, READ_WRITE_ACTIONS),
    privilege({ system_buckets: '' }, READ_WRITE_ACTIONS)
]

/** `userAdminAnyDatabase`, transcribed from `mongod 8.0.9`'s `showPrivileges`. */
const USER_ADMIN_ANY_DATABASE_PRIVILEGES: Privilege[] = [
    privilege(
        { db: '', collection: '' },
        [
            'changeCustomData',
            'changePassword',
            'createRole',
            'createUser',
            'dropRole',
            'dropUser',
            'grantRole',
            'listCachedAndActiveUsers',
            'revokeRole',
            'setAuthenticationRestriction',
            'viewRole',
            'viewUser'
        ]
    ),
    privilege(
        { db: 'local', collection: '' },
        [
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
    ),
    privilege(
        { db: 'config', collection: '' },
        [
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
    ),
    privilege({ cluster: true }, ['authSchemaUpgrade', 'invalidateUserCache', 'listDatabases', 'viewUser']),
    privilege(
        { db: 'admin', collection: 'system.users' },
        [
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
        ]
    ),
    privilege(
        { db: 'admin', collection: 'system.roles' },
        [
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
        ]
    ),
    privilege({ db: '', collection: 'system.users' }, READ_ACTIONS),
    privilege({ db: 'admin', collection: 'system.version' }, READ_ACTIONS),
    privilege({ db: 'admin', collection: 'system.backup_users' }, READ_ACTIONS)
]

/** `dbAdminAnyDatabase`, transcribed from `mongod 8.0.9`'s `showPrivileges`. */
const DB_ADMIN_ANY_DATABASE_PRIVILEGES: Privilege[] = [
    privilege({ cluster: true }, ['listDatabases', 'applyOps']),
    privilege(
        { db: '', collection: '' },
        [
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
    ),
    privilege({ db: '', collection: 'system.profile' }, PROFILE_ACTIONS),
    privilege(
        { system_buckets: '' },
        [
            'analyze',
            'bypassDocumentValidation',
            'collMod',
            'collStats',
            'compact',
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
    )
]

/** `clusterMonitor`, transcribed from `mongod 8.0.9`'s `showPrivileges`. */
const CLUSTER_MONITOR_PRIVILEGES: Privilege[] = [
    privilege(
        { db: 'config', collection: '' },
        [
            'changeStream',
            'collStats',
            'dbHash',
            'dbStats',
            'find',
            'getDatabaseVersion',
            'getShardVersion',
            'indexStats',
            'killCursors',
            'listCollections',
            'listIndexes',
            'listSearchIndexes',
            'planCacheRead'
        ]
    ),
    privilege({ db: 'config', collection: 'system.js' }, CLUSTER_READ_ACTIONS),
    privilege(
        { db: 'local', collection: '' },
        [
            'changeStream',
            'collStats',
            'dbHash',
            'dbStats',
            'find',
            'getDatabaseVersion',
            'getShardVersion',
            'indexStats',
            'killCursors',
            'listCollections',
            'listIndexes',
            'listSearchIndexes',
            'planCacheRead'
        ]
    ),
    privilege({ db: 'local', collection: 'system.js' }, CLUSTER_READ_ACTIONS),
    privilege(
        { cluster: true },
        [
            'allCollectionStats',
            'connPoolStats',
            'getDefaultRWConcern',
            'getCmdLineOpts',
            'getLog',
            'getParameter',
            'getShardMap',
            'hostInfo',
            'inprog',
            'listDatabases',
            'listSampledQueries',
            'listSessions',
            'listShards',
            'netstat',
            'operationMetrics',
            'queryStatsRead',
            'queryStatsReadTransformed',
            'replSetGetConfig',
            'replSetGetStatus',
            'serverStatus',
            'shardedDataDistribution',
            'shardingState',
            'top',
            'useUUID'
        ]
    ),
    privilege({ db: '', collection: '' }, ['collStats', 'dbStats', 'getDatabaseVersion', 'getShardVersion', 'indexStats']),
    privilege({ system_buckets: '' }, ['collStats', 'dbStats', 'getDatabaseVersion', 'getShardVersion', 'indexStats']),
    privilege({ db: 'config', collection: 'system.sessions' }, ['collStats', 'dbStats', 'getDatabaseVersion', 'getShardVersion', 'indexStats']),
    privilege({ db: 'local', collection: 'system.replset' }, ['find']),
    privilege({ db: 'local', collection: 'replset.election' }, ['find']),
    privilege({ db: 'local', collection: 'replset.minvalid' }, ['find']),
    privilege({ db: '', collection: 'system.profile' }, ['find'])
]

/** `clusterManager`, transcribed from `mongod 8.0.9`'s `showPrivileges`. */
const CLUSTER_MANAGER_PRIVILEGES: Privilege[] = [
    privilege(
        { db: 'config', collection: '' },
        [
            'analyzeShardKey',
            'changeStream',
            'clearJumboFlag',
            'collStats',
            'configureQueryAnalyzer',
            'dbHash',
            'dbStats',
            'enableSharding',
            'find',
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
        ]
    ),
    privilege({ db: 'config', collection: 'system.js' }, CLUSTER_READ_ACTIONS),
    privilege(
        { cluster: true },
        [
            'addShard',
            'appendOplogNote',
            'applicationMessage',
            'checkMetadataConsistency',
            'cleanupOrphaned',
            'flushRouterConfig',
            'getClusterParameter',
            'getDefaultRWConcern',
            'listSessions',
            'listShards',
            'querySettings',
            'removeShard',
            'replSetConfigure',
            'replSetGetConfig',
            'replSetGetStatus',
            'replSetStateChange',
            'resync',
            'runTenantMigration',
            'setClusterParameter',
            'setDefaultRWConcern',
            'setFeatureCompatibilityVersion',
            'transitionFromDedicatedConfigServer',
            'transitionToDedicatedConfigServer',
            'setChangeStreamState',
            'getChangeStreamState'
        ]
    ),
    privilege(
        { db: '', collection: '' },
        [
            'analyzeShardKey',
            'clearJumboFlag',
            'configureQueryAnalyzer',
            'enableSharding',
            'moveChunk',
            'moveCollection',
            'refineCollectionShardKey',
            'reshardCollection',
            'splitChunk',
            'splitVector',
            'unshardCollection'
        ]
    ),
    privilege(
        { system_buckets: '' },
        [
            'analyzeShardKey',
            'clearJumboFlag',
            'configureQueryAnalyzer',
            'enableSharding',
            'moveChunk',
            'moveCollection',
            'refineCollectionShardKey',
            'reshardCollection',
            'splitChunk',
            'splitVector',
            'unshardCollection'
        ]
    ),
    privilege(
        { db: 'local', collection: '' },
        [
            'analyzeShardKey',
            'clearJumboFlag',
            'configureQueryAnalyzer',
            'enableSharding',
            'insert',
            'moveChunk',
            'moveCollection',
            'refineCollectionShardKey',
            'remove',
            'reshardCollection',
            'splitChunk',
            'splitVector',
            'unshardCollection',
            'update'
        ]
    ),
    privilege({ db: 'local', collection: 'system.replset' }, CLUSTER_READ_ACTIONS),
    privilege({ anyResource: true }, ['dbCheck']),
    privilege({ db: 'local', collection: 'system.healthlog' }, CLUSTER_READ_ACTIONS),
    privilege({ db: 'local', collection: 'replset.election' }, ['insert', 'remove', 'update']),
    privilege({ db: 'local', collection: 'replset.minvalid' }, ['insert', 'remove', 'update'])
]

/** `hostManager`, transcribed from `mongod 8.0.9`'s `showPrivileges`. */
const HOST_MANAGER_PRIVILEGES: Privilege[] = [
    privilege(
        { cluster: true },
        [
            'applicationMessage',
            'auditConfigure',
            'compact',
            'connPoolSync',
            'dropConnections',
            'flushRouterConfig',
            'fsync',
            'invalidateUserCache',
            'killAnyCursor',
            'killAnySession',
            'killop',
            'logRotate',
            'oidcListKeys',
            'oidcRefreshKeys',
            'oidReset',
            'replSetResizeOplog',
            'resync',
            'rotateCertificates',
            'setParameter',
            'shutdown',
            'touch',
            'trafficRecord',
            'unlock'
        ]
    ),
    privilege({ db: '', collection: '' }, ['killCursors'])
]

/** `backup`, transcribed from `mongod 8.0.9`'s `showPrivileges`. */
const BACKUP_PRIVILEGES: Privilege[] = [
    privilege({ anyResource: true }, ['collStats', 'listCollections', 'listIndexes', 'listSearchIndexes']),
    privilege({ db: '', collection: '' }, ['find']),
    privilege({ system_buckets: '' }, ['find']),
    privilege({ cluster: true }, ['appendOplogNote', 'getParameter', 'listDatabases', 'serverStatus', 'setUserWriteBlockMode', 'useUUID']),
    privilege({ db: 'config', collection: '' }, ['find']),
    privilege({ db: 'local', collection: '' }, ['find']),
    privilege({ db: 'local', collection: 'replset.election' }, ['find']),
    privilege({ db: 'local', collection: 'replset.minvalid' }, ['find']),
    privilege({ db: '', collection: 'system.js' }, ['find']),
    privilege({ db: '', collection: 'system.users' }, ['find']),
    privilege({ db: '', collection: 'system.profile' }, ['find']),
    privilege({ db: 'admin', collection: 'system.backup_users' }, ['find']),
    privilege({ db: 'admin', collection: 'system.roles' }, ['find']),
    privilege({ db: 'admin', collection: 'system.version' }, ['find']),
    privilege({ db: 'config', collection: 'settings' }, ['find', 'insert', 'update'])
]

/** `restore`, transcribed from `mongod 8.0.9`'s `showPrivileges`. */
const RESTORE_WRITE_ACTIONS = [
    'bypassDocumentValidation',
    'collMod',
    'convertToCapped',
    'createCollection',
    'createIndex',
    'createSearchIndexes',
    'dropCollection',
    'insert',
    'updateSearchIndex'
]
const RESTORE_PRIVILEGES: Privilege[] = [
    privilege({ cluster: true }, ['bypassWriteBlockingMode', 'forceUUID', 'getParameter', 'setUserWriteBlockMode', 'useUUID', 'applyOps']),
    privilege({ db: 'local', collection: '' }, RESTORE_WRITE_ACTIONS),
    privilege({ db: 'config', collection: '' }, RESTORE_WRITE_ACTIONS),
    privilege({ system_buckets: '' }, RESTORE_WRITE_ACTIONS),
    privilege({ db: 'local', collection: 'system.replset' }, RESTORE_WRITE_ACTIONS),
    privilege({ db: 'local', collection: 'replset.election' }, RESTORE_WRITE_ACTIONS),
    privilege({ db: 'local', collection: 'replset.minvalid' }, RESTORE_WRITE_ACTIONS),
    privilege({ anyResource: true }, ['listCollections']),
    privilege(
        { db: '', collection: '' },
        [
            'bypassDocumentValidation',
            'changeCustomData',
            'changePassword',
            'collMod',
            'convertToCapped',
            'createCollection',
            'createIndex',
            'createRole',
            'createSearchIndexes',
            'createUser',
            'dropCollection',
            'dropRole',
            'dropUser',
            'grantRole',
            'insert',
            'updateSearchIndex',
            'revokeRole',
            'setAuthenticationRestriction',
            'viewRole',
            'viewUser'
        ]
    ),
    privilege({ db: '', collection: 'system.js' }, RESTORE_WRITE_ACTIONS),
    privilege({ db: 'admin', collection: 'tempusers' }, ['find']),
    privilege({ db: 'admin', collection: 'temproles' }, ['find']),
    privilege({ db: 'admin', collection: 'system.backup_users' }, RESTORE_WRITE_ACTIONS),
    privilege(
        { db: 'admin', collection: 'system.version' },
        [
            'bypassDocumentValidation',
            'collMod',
            'convertToCapped',
            'createCollection',
            'createIndex',
            'createSearchIndexes',
            'dropCollection',
            'find',
            'insert',
            'updateSearchIndex'
        ]
    ),
    privilege(
        { db: '', collection: 'system.users' },
        [
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
        ]
    ),
    privilege({ db: 'admin', collection: 'system.roles' }, ['createIndex']),
    privilege({ db: '', collection: 'system.views' }, ['dropCollection'])
]

/** `__system`, transcribed from `mongod 8.0.9`'s `showPrivileges`. */
const SYSTEM_PRIVILEGES: Privilege[] = [privilege({ anyResource: true }, ['anyAction'])]

CLUSTER_BOUND_ROLES.clusterAdmin = CLUSTER_ADMIN_PRIVILEGES
CLUSTER_BOUND_ROLES.root = ROOT_PRIVILEGES
CLUSTER_BOUND_ROLES.readAnyDatabase = READ_ANY_DATABASE_PRIVILEGES
CLUSTER_BOUND_ROLES.readWriteAnyDatabase = READ_WRITE_ANY_DATABASE_PRIVILEGES
CLUSTER_BOUND_ROLES.userAdminAnyDatabase = USER_ADMIN_ANY_DATABASE_PRIVILEGES
CLUSTER_BOUND_ROLES.dbAdminAnyDatabase = DB_ADMIN_ANY_DATABASE_PRIVILEGES
CLUSTER_BOUND_ROLES.clusterMonitor = CLUSTER_MONITOR_PRIVILEGES
CLUSTER_BOUND_ROLES.clusterManager = CLUSTER_MANAGER_PRIVILEGES
CLUSTER_BOUND_ROLES.hostManager = HOST_MANAGER_PRIVILEGES
CLUSTER_BOUND_ROLES.backup = BACKUP_PRIVILEGES
CLUSTER_BOUND_ROLES.restore = RESTORE_PRIVILEGES
CLUSTER_BOUND_ROLES.__system = SYSTEM_PRIVILEGES

/** Built-in roles `mongod` resolves without a matching `system.roles` document. */
export const BUILTIN_ROLE_NAMES = new Set(Object.keys(DB_SCOPED_ROLES).concat(Object.keys(CLUSTER_BOUND_ROLES)))

/**
 * Every action name `mongod 8.0.9` accepts in a privilege: the union of the
 * built-in role expansions plus `anyAction`, verified by probing `createRole`
 * with candidate names (anything outside this set answers
 * `Unknown action type in privilege set`).
 */
export const VALID_ACTIONS: Set<string> = (() => {
    const actions = new Set<string>(['anyAction'])
    for (const entries of Object.values(DB_SCOPED_ROLES)) for (const entry of entries) for (const action of entry.actions) actions.add(action)
    for (const entries of Object.values(CLUSTER_BOUND_ROLES)) for (const entry of entries) for (const action of entry.actions) actions.add(action)
    return actions
})()

/**
 * Whether `role` names a built-in role at that database. Cluster-bound roles
 * (`clusterAdmin`, `root`, the `*AnyDatabase` roles, `clusterMonitor`,
 * `clusterManager`, `hostManager`, `backup`, `restore` and `__system`) only
 * resolve on `admin`; database roles resolve on any database, including one
 * that does not exist, as `mongod 8.0.9` does.
 */
export function builtinRoleExists(role: { role: string; db: string }): boolean {
    if (!BUILTIN_ROLE_NAMES.has(role.role)) return false
    if (Object.hasOwn(CLUSTER_BOUND_ROLES, role.role)) return role.db === 'admin'
    return true
}

/** A user-defined role as stored in `<db>.system.roles`. */
export interface StoredRole {
    privileges: Privilege[]
    roles: AuthRole[]
    authenticationRestrictions: any[]
}

/** Resolves one role name to its stored document, or `null` when it does not exist. */
export type RoleResolver = (role: AuthRole) => StoredRole | null

/** Reads custom role documents through the binding, caching one lookup per expansion. */
export function makeStoreResolver(session: { store: any; cursors: any }): RoleResolver {
    const cache = new Map<string, StoredRole | null>()
    return (role) => {
        const key = `${role.db}.${role.role}`
        if (cache.has(key)) return cache.get(key) ?? null
        if (builtinRoleExists(role)) return null
        let resolved: StoredRole | null = null
        try {
            const find = JSON.stringify({ find: 'system.roles', filter: { _id: key }, limit: 1, $db: role.db })
            const batch = JSON.parse(binding.find(session.store, session.cursors, find))?.cursor?.firstBatch
            const document = Array.isArray(batch) && batch.length > 0 ? batch[0] : null
            if (document !== null && typeof document === 'object') {
                resolved = {
                    privileges: Array.isArray(document.privileges) ? document.privileges : [],
                    roles: Array.isArray(document.roles) ? document.roles.filter((entry: any) => entry && typeof entry.role === 'string' && typeof entry.db === 'string') : [],
                    authenticationRestrictions: Array.isArray(document.authenticationRestrictions) ? document.authenticationRestrictions : []
                }
            }
        } catch {
            resolved = null
        }
        cache.set(key, resolved)
        return resolved
    }
}

/** `mongod`'s action enumeration is alphabetical except for three trailing and one pulled-forward action. */
const TRAILING_ACTIONS = ['applyOps', 'setChangeStreamState', 'getChangeStreamState']

function actionSortKey(action: string): string {
    return action === 'updateSearchIndex' ? 'listSearchIndexes~' : action
}

function compareActions(left: string, right: string): number {
    const leftTrailing = TRAILING_ACTIONS.indexOf(left)
    const rightTrailing = TRAILING_ACTIONS.indexOf(right)
    if (leftTrailing !== -1 || rightTrailing !== -1) {
        if (leftTrailing === -1) return -1
        if (rightTrailing === -1) return 1
        return leftTrailing - rightTrailing
    }
    const a = actionSortKey(left)
    const b = actionSortKey(right)
    return a < b ? -1 : a > b ? 1 : 0
}

/** Identity of a resource for merging privileges that name the same target. */
function resourceKey(resource: Resource): string {
    if (resource.cluster === true) return 'C'
    if (resource.anyResource === true) return 'A'
    if (resource.system_buckets !== undefined) return `B:${resource.system_buckets}`
    return `D:${resource.db ?? ''}|${resource.collection ?? ''}`
}

/** Accumulates privileges per resource, merging duplicates the way `mongod` stores them. */
function createPrivilegeMerger() {
    const merged: { resource: Resource; seen: Set<string>; mixed: boolean }[] = []
    const byKey = new Map<string, (typeof merged)[number]>()
    const add = (resource: Resource, actions: string[]) => {
        const key = resourceKey(resource)
        let entry = byKey.get(key)
        if (entry === undefined) {
            entry = { resource, seen: new Set(), mixed: false }
            byKey.set(key, entry)
            merged.push(entry)
        } else {
            entry.mixed = true
        }
        if (entry.seen.has('anyAction')) return
        if (actions.includes('anyAction')) {
            entry.seen.clear()
            entry.seen.add('anyAction')
            return
        }
        for (const action of actions) entry.seen.add(action)
    }
    const finish = (): Privilege[] =>
        merged.map((entry) => {
            const actions = [...entry.seen]
            if (entry.mixed && actions.length > 1) actions.sort(compareActions)
            return { resource: entry.resource, actions }
        })
    return { add, finish }
}

/**
 * Merges duplicate resources and orders actions exactly as `mongod` normalizes
 * a `createRole` privileges array before storing it.
 */
export function normalizePrivileges(privileges: Privilege[]): Privilege[] {
    const merger = createPrivilegeMerger()
    for (const entry of privileges) merger.add(entry.resource, entry.actions)
    return merger.finish()
}

/**
 * Expands stored roles (built-in and custom) into the privilege set, inherited
 * role list and authentication restrictions `showPrivileges` reports. Roles are
 * visited in `(role, db)` order; each custom role contributes its own
 * privileges before its inherited roles' ones, mirroring `mongod`. Privileges
 * that share a resource merge into the first entry, their actions unioned in
 * `mongod`'s canonical order; `anyAction` replaces the whole list, as it does
 * there. Dangling role references expand to nothing, which is what `mongod`
 * reports for a role dropped from under a user.
 */
export function expandRoles(roles: AuthRole[], resolve: RoleResolver = () => null): { privileges: Privilege[]; inheritedRoles: AuthRole[]; authenticationRestrictions: any[] } {
    const merger = createPrivilegeMerger()
    const addPrivilege = merger.add
    const inheritedRoles: AuthRole[] = []
    const authenticationRestrictions: any[] = []
    const visited = new Set<string>()

    const addRole = (role: AuthRole) => {
        const key = `${role.db}.${role.role}`
        if (visited.has(key)) return
        visited.add(key)
        inheritedRoles.push({ role: role.role, db: role.db })
        const scoped = DB_SCOPED_ROLES[role.role]
        if (scoped) {
            for (const entry of scoped) addPrivilege({ db: role.db, collection: entry.collection }, entry.actions)
            return
        }
        const fixed = CLUSTER_BOUND_ROLES[role.role]
        if (fixed) {
            for (const entry of fixed) addPrivilege({ ...entry.resource }, entry.actions)
            return
        }
        const stored = resolve(role)
        if (stored === null) return
        if (stored.authenticationRestrictions.length > 0) authenticationRestrictions.push(stored.authenticationRestrictions)
        for (const entry of stored.privileges) {
            if (entry === null || typeof entry !== 'object' || entry.resource === null || typeof entry.resource !== 'object') continue
            addPrivilege(entry.resource, Array.isArray(entry.actions) ? entry.actions.filter((action: unknown) => typeof action === 'string') : [])
        }
        for (const child of stored.roles) addRole(child)
    }

    for (const role of [...roles].sort((left, right) =>
        left.role < right.role ? -1 : left.role > right.role ? 1 : left.db < right.db ? -1 : left.db > right.db ? 1 : 0
    )) {
        addRole(role)
    }

    return { privileges: merger.finish(), inheritedRoles, authenticationRestrictions }
}

/** Expands stored roles into the privilege set `showPrivileges` reports. */
export function privilegesForRoles(roles: AuthRole[], resolve: RoleResolver = () => null): Privilege[] {
    return expandRoles(roles, resolve).privileges
}

/**
 * Collections `mongod` protects behind explicit namespace grants.
 *
 * A database-wide privilege such as `read@authz` does not reach these even
 * though its resource names the whole database: real `mongod 8.0.9` refuses a
 * `find` on `authz.system.users` to `read` and to `userAdmin`, and allows it to
 * a custom role whose resource is exactly `authz.system.users`.
 */
const CREDENTIAL_COLLECTIONS = new Set(['system.users', 'system.backup_users', 'system.roles'])

/** Whether a privilege's resource covers a `{db, collection}` target. */
function covers(resource: Resource, db: string, collection: string): boolean {
    if (resource.anyResource === true) return true
    if (resource.cluster === true || resource.system_buckets === '') return false
    const resourceDb = resource.db ?? ''
    const resourceCollection = resource.collection ?? ''
    if (resourceDb !== '' && resourceDb !== db) return false
    if (resourceCollection === '' && CREDENTIAL_COLLECTIONS.has(collection)) return false
    if (resourceCollection !== '' && resourceCollection !== collection) return false
    return true
}

/** Whether one privilege's action list answers `action`; `anyAction` answers every one. */
function hasAction(actions: string[], action: string): boolean {
    return actions.includes(action) || actions.includes('anyAction')
}

function grants(privileges: Privilege[], action: string, db: string, collection: string): boolean {
    return privileges.some((entry) => hasAction(entry.actions, action) && covers(entry.resource, db, collection))
}

/** Whether any privilege grants a cluster-wide action, e.g. `listDatabases`. */
export function clusterGrants(privileges: Privilege[], action: string): boolean {
    return privileges.some(
        (entry) => hasAction(entry.actions, action) && (entry.resource.cluster === true || entry.resource.anyResource === true)
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

function credentialCollection(name: unknown): boolean {
    return typeof name === 'string' && CREDENTIAL_COLLECTIONS.has(name)
}

/** An integer that may arrive as a plain number or a tagged BSON number. */
function numberField(value: any): number | null {
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value
    if (value === null || typeof value !== 'object') return null
    const tagged = value.$numberInt ?? value.$numberLong
    if (typeof tagged === 'string' && /^\d+$/.test(tagged)) return Number(tagged)
    return null
}

/** Split a `db.collection` namespace, defaulting a bare name to `database`. */
function namespaceTarget(ns: unknown, database: string): { db: string; collection: string } | null {
    if (typeof ns !== 'string' || ns.length === 0) return null
    const dot = ns.indexOf('.')
    if (dot === -1) return { db: database, collection: ns }
    if (dot === 0 || dot === ns.length - 1) return null
    return { db: ns.slice(0, dot), collection: ns.slice(dot + 1) }
}

/** Every namespace `bulkWrite` can reach through its `nsInfo` table. */
function bulkWriteNamespaces(command: any, database: string): { db: string; collection: string }[] {
    const info = Array.isArray(command.nsInfo) ? command.nsInfo : []
    const targets: { db: string; collection: string }[] = []
    for (const entry of info) {
        if (entry === null || typeof entry !== 'object') continue
        const target = namespaceTarget(entry.ns, database)
        if (target !== null) targets.push(target)
    }
    return targets
}

/**
 * `bulkWrite` requirements: one per op, on the namespace the op's index names.
 *
 * Authorizing the command name alone checks collection `"1"` in `admin`,
 * which is neither the database nor the collection the ops write.
 */
function bulkWriteRequirements(command: any, database: string): Requirement[] {
    const info = Array.isArray(command.nsInfo) ? command.nsInfo : []
    const ops = Array.isArray(command.ops) ? command.ops : []
    const requirements: Requirement[] = []
    for (const op of ops) {
        if (op === null || typeof op !== 'object') continue
        const insert = numberField(op.insert)
        const update = numberField(op.update)
        const remove = numberField(op.delete)
        const index = insert ?? update ?? remove
        if (index === null) continue
        const entry = info[index]
        const target = entry !== null && typeof entry === 'object' ? namespaceTarget(entry.ns, database) : null
        if (target === null) continue
        const action = insert !== null ? 'insert' : update !== null ? 'update' : 'remove'
        requirements.push({ action, db: target.db, collection: target.collection })
    }
    return requirements
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
            return [{ action: 'find', db: database, collection }]
        }
        case 'count': {
            const collection = typeof command.count === 'string' ? command.count : ''
            return [{ action: 'find', db: database, collection }]
        }
        case 'distinct': {
            const collection = typeof command.distinct === 'string' ? command.distinct : ''
            return [{ action: 'find', db: database, collection }]
        }
        case 'aggregate': {
            const pipeline = Array.isArray(command.pipeline) ? command.pipeline : []
            if (pipeline.length > 0 && typeof pipeline[0] === 'object' && pipeline[0] !== null && Object.hasOwn(pipeline[0], '$currentOp')) {
                return [{ action: 'inprog', cluster: true }]
            }
            const source = typeof command.aggregate === 'string' ? command.aggregate : ''
            const requirements: Requirement[] = [{ action: 'find', db: database, collection: source }]
            for (const stage of pipeline) {
                if (stage === null || typeof stage !== 'object') continue
                // `$lookup`, `$graphLookup` and `$unionWith` read another
                // collection of the same database. `mongod` requires `find` on
                // that collection, so a collection-scoped role that can read the
                // source cannot use the pipeline to read past its grant.
                // An object `from` names a foreign database and is rejected by
                // the pipeline validator, so it is not turned into a grant.
                for (const value of [stage.$lookup?.from, stage.$graphLookup?.from, stage.$unionWith]) {
                    if (typeof value === 'string' && value.length > 0) {
                        requirements.push({ action: 'find', db: database, collection: value })
                    }
                }
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
        case 'findAndModify': {
            const collection = typeof command.findAndModify === 'string' ? command.findAndModify : ''
            // `findAndModify` with `remove: true` deletes the matching document,
            // so it needs `remove` rather than `update`.
            return [
                { action: 'find', db: database, collection },
                { action: command.remove === true ? 'remove' : 'update', db: database, collection }
            ]
        }
        case 'bulkWrite':
            return bulkWriteRequirements(command, database)
        case 'create': {
            const collection = typeof command.create === 'string' ? command.create : ''
            const requirements: Requirement[] = [{ action: 'createCollection', db: database, collection }]
            // A view reads its source to answer queries, so `mongod` requires
            // the source's read action on top of creating the view.
            if (typeof command.viewOn === 'string' && command.viewOn.length > 0) {
                requirements.push({ action: 'find', db: database, collection: command.viewOn })
            }
            return requirements
        }
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
            return [{ action: 'find', db: database, collection }]
        }
        case 'killCursors':
            return [{ action: 'killCursors', db: database, collection: typeof command.killCursors === 'string' ? command.killCursors : '' }]
        case 'dbHash':
            return [{ action: 'dbHash', db: database, collection: '' }]
        case 'validate':
            return [{ action: 'validate', db: database, collection: typeof command.validate === 'string' ? command.validate : '' }]
        case 'renameCollection':
            return renameCollectionTargets(command, database)
        case 'createRole':
            return createRoleTargets(command, database)
        case 'updateRole':
            return [{ action: 'updateRole', db: database, collection: '' }]
        case 'dropRole':
            return [{ action: 'dropRole', db: database, collection: '' }]
        case 'grantRolesToUser':
            return grantRolesTargets(command, database, 'grantRole')
        case 'revokeRolesFromUser':
            return grantRolesTargets(command, database, 'revokeRole')
        case 'grantRolesToRole':
            return grantRolesTargets(command, database, 'grantRole')
        case 'revokeRolesFromRole':
            return grantRolesTargets(command, database, 'revokeRole')
        case 'grantPrivilegesToRole':
            return [
                { action: 'grantRole', db: database, collection: '' },
                ...privilegeTargets(command.privileges, 'grantRole', database)
            ]
        case 'updateUser':
            return updateUserTargets(command, database)
        case 'invalidateUserCache':
            return [{ action: 'invalidateUserCache', cluster: true }]
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

/** Roles named by an entry such as `[{ role, db }]`, skipping malformed ones. */
function roleTargets(roles: unknown): { role: string; db: string }[] {
    if (!Array.isArray(roles)) return []
    const targets: { role: string; db: string }[] = []
    for (const entry of roles) {
        if (entry !== null && typeof entry === 'object' && typeof entry.role === 'string' && typeof entry.db === 'string') {
            targets.push({ role: entry.role, db: entry.db })
        }
    }
    return targets
}

/** Requirements for the resources named by a `privileges` array. */
function privilegeTargets(privileges: unknown, action: string, database: string): Requirement[] {
    if (!Array.isArray(privileges)) return []
    const targets: Requirement[] = []
    for (const entry of privileges) {
        if (entry === null || typeof entry !== 'object' || entry.resource === null || typeof entry.resource !== 'object') continue
        const resource = entry.resource
        if (typeof resource.db === 'string') {
            targets.push({ action, db: resource.db, collection: typeof resource.collection === 'string' ? resource.collection : '' })
        } else if (resource.anyResource === true) {
            targets.push({ action, db: database, collection: '' })
        }
    }
    return targets
}

/**
 * `renameCollection` requirements, measured on `mongod 8.0.9`: the source
 * needs `renameCollectionSameDB` and the target `dropCollection`. A
 * `readWrite` grant passes within one database and fails when the target
 * database is outside its grant, which is the observed behaviour; the exact
 * privilege name for cross-database renames is not documented, so this pair is
 * an approximation recorded in AUTHORIZATION-MATRIX.md.
 */
function renameCollectionTargets(command: any, database: string): Requirement[] {
    const from = namespaceTarget(command.renameCollection, database)
    const to = namespaceTarget(command.to, database)
    if (from === null || to === null) return [{ action: 'renameCollectionSameDB', db: database, collection: '' }]
    return [
        { action: 'renameCollectionSameDB', db: from.db, collection: from.collection },
        { action: 'dropCollection', db: to.db, collection: to.collection }
    ]
}

/** `createRole`: the creation action plus `grantRole` on every granted resource. */
function createRoleTargets(command: any, database: string): Requirement[] {
    return [
        { action: 'createRole', db: database, collection: '' },
        ...roleTargets(command.roles).map((role) => ({ action: 'grantRole', db: role.db, collection: '' })),
        ...privilegeTargets(command.privileges, 'grantRole', database)
    ]
}

/** `grantRolesToUser` / `revokeRolesFromUser` / `grantRolesToRole` / `revokeRolesFromRole`. */
function grantRolesTargets(command: any, database: string, action: string): Requirement[] {
    return [
        { action, db: database, collection: '' },
        ...roleTargets(command.roles).map((role) => ({ action, db: role.db, collection: '' }))
    ]
}

/**
 * `updateUser` requirements: a field action for each field it changes and a
 * role action for each role it hands out or takes away. `userAdmin` holds all
 * of them on its own database and none on another, which matches the observed
 * delegation boundary.
 */
function updateUserTargets(command: any, database: string): Requirement[] {
    const requirements: Requirement[] = []
    if (typeof command.pwd === 'string') requirements.push({ action: 'changePassword', db: database, collection: '' })
    if (command.customData !== undefined) requirements.push({ action: 'changeCustomData', db: database, collection: '' })
    if (command.authenticationRestrictions !== undefined) {
        requirements.push({ action: 'setAuthenticationRestriction', db: database, collection: '' })
    }
    if (Array.isArray(command.roles)) {
        requirements.push({ action: 'revokeRole', db: database, collection: '' })
        for (const role of roleTargets(command.roles)) {
            requirements.push({ action: 'grantRole', db: role.db, collection: '' })
        }
    }
    if (requirements.length === 0) requirements.push({ action: 'changeCustomData', db: database, collection: '' })
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
export function authorizeCommand(session: { auth: { roles: AuthRole[] }; store?: any; cursors?: any }, command: any): any | null {
    const resolve: RoleResolver = session.store !== undefined ? makeStoreResolver(session as { store: any; cursors: any }) : () => null
    const name = Object.keys(command)[0]
    if (typeof name !== 'string') return null
    if (name === 'listDatabases') {
        const privileges = privilegesForRoles(session.auth.roles, resolve)
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
    const privileges = privilegesForRoles(session.auth.roles, resolve)
    // `root` answers every privilege question, including actions that its
    // reported privilege list does not enumerate (`updateRole` on `mongod
    // 8.0.9` reaches the role lookup instead of being refused).
    const root = session.auth.roles.some((role) => role.role === 'root' && role.db === 'admin')
    const requirements =
        name === 'usersInfo'
            ? usersInfoTargets(command, database)
            : name === 'createUser'
              ? createUserTargets(command, database)
              : requirementsFor(name, command, database)
    if (requirements === null) return null
    for (const requirement of requirements) {
        // `root` answers every enumerated action, but the credential
        // collections stay namespace-scoped even for it: real `mongod` refuses
        // `root` a `find` on `authz.system.roles` because `root` holds
        // `admin.system.roles`, not an any-database grant. `.system.users` is
        // held explicitly and still passes.
        const rootBypass = root && !(typeof requirement.collection === 'string' && credentialCollection(requirement.collection))
        if (!rootBypass && !check(privileges, requirement)) return notAuthorized(command)
    }
    return credentialRefusal(name, command, database)
}

/**
 * Operations real `mongod` authorizes and then refuses with a dedicated error
 * instead of executing: a credential collection cannot be the target of
 * `$out` / `$merge`, and it cannot be dropped. Authorized callers see these
 * codes; callers that miss the privileges are refused earlier with 13.
 */
function credentialRefusal(name: string, command: any, database: string): any | null {
    if (name === 'drop' && credentialCollection(command.drop)) {
        return {
            ok: { $numberDouble: '0.0' },
            errmsg: `cannot drop system collection ${database}.${command.drop}`,
            code: { $numberInt: '20' },
            codeName: 'IllegalOperation'
        }
    }
    if (name !== 'aggregate') return null
    const pipeline = Array.isArray(command.pipeline) ? command.pipeline : []
    for (const stage of pipeline) {
        if (stage === null || typeof stage !== 'object') continue
        const out = outputTarget(stage.$out, database)
        if (out !== null && credentialCollection(out.collection)) {
            return {
                ok: { $numberDouble: '0.0' },
                errmsg: `Can't $out to special collection: ${out.collection}`,
                code: { $numberInt: '17385' },
                codeName: 'Location17385'
            }
        }
        const merge = outputTarget(stage.$merge?.into, database)
        if (merge !== null && credentialCollection(merge.collection)) {
            return {
                ok: { $numberDouble: '0.0' },
                errmsg: `Cannot $merge to special collection: ${merge.collection}`,
                code: { $numberInt: '31319' },
                codeName: 'Location31319'
            }
        }
    }
    return null
}
