//! `.yyds` catalog + `.yykv` shard adapter for Mongo namespaces.
//!
//! The `.yyds` catalog is the product-level registry: it names the single
//! `.yykv` shard that holds the data and records every `<database>.<collection>`
//! namespace in its schema slot. The layout copied from the shared
//! `yyds-formats` contract (magic `YYDS\x01`, little-endian fields, optional
//! schema/routing/contract/owners sections, one `ShardId`).
//!
//! The shard keeps a legacy `!catalog` mirror of the namespace labels; it is
//! only used to seed a catalog that is missing and is merged back into the
//! catalog on every open, so deleting `.yyds` never hides existing collections.
//!
//! Write order is shard first, catalog second, and the catalog is replaced
//! atomically (synced temporary file + rename). A crash between the two writes
//! therefore leaves only the `.yykv`, which the next open repairs by seeding a
//! catalog from the shard's mirror. The opposite residue (catalog but no shard)
//! is never produced by this crate, is rejected by `open`, and is repaired only
//! through the explicit `repair_shard` entry point.

use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
};

use database::{
    cluster::catalog,
    storage::cluster_kv::{FileShard, InlineValue, Key, KvStore, ShardChange, StoredValue},
    types::cluster::{CatalogSchema, Namespace, ShardId, CATALOG_SUFFIX},
};

use crate::{
    bson::BsonDocument,
    json,
};

/// One user-created index. `_id_` is implicit and is never stored here.
#[derive(Debug, Clone)]
pub struct IndexSpec {
    /// Namespace the index belongs to.
    pub namespace: String,
    /// Index name drivers and `listIndexes` report.
    pub name: String,
    /// Ordered key specification, exactly as it was sent.
    pub key: BsonDocument,
    /// Whether the index rejects duplicate keys.
    pub unique: bool,
}

/// Collection-level options kept in the catalog. Only non-default values are
/// stored, so collections without validators keep the original catalog shape.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CollectionOptions {
    /// `$jsonSchema` (or other validator) exactly as it was sent.
    pub validator: Option<serde_json::Value>,
    /// `strict` (default), `moderate`, or `off`.
    pub validation_level: Option<String>,
    /// `error` (default) or `warn`.
    pub validation_action: Option<String>,
}

/// Namespace label used to remember which Mongo namespaces exist.
///
/// Mongo collection names cannot contain `$` or a NUL byte and a database name
/// cannot be `!catalog`, so this label never collides with user data.
const CATALOG_NAMESPACE: &str = "!catalog";

/// Version of the product document stored in the `.yyds` schema slot.
const CATALOG_DOCUMENT_VERSION: u32 = 1;

/// Errors surfaced by the storage adapter.
#[derive(Debug)]
pub enum StoreError {
    /// The shard rejected the command.
    Shard(String),
    /// The catalog is missing pieces, malformed, or points at nothing.
    Catalog(String),
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Shard(message) => write!(formatter, "{message}"),
            Self::Catalog(message) => write!(formatter, "{message}"),
        }
    }
}

impl std::error::Error for StoreError {}

/// Outcome of one `insert` batch.
#[derive(Debug, Default)]
pub struct InsertReport {
    /// Documents written.
    pub inserted: i64,
    /// Positions whose `_id` already existed.
    pub duplicates: Vec<usize>,
    /// Positions that were not documents at all.
    pub invalid: Vec<usize>,
}

#[derive(Debug)]
struct CatalogState {
    path: PathBuf,
    shard_id: String,
    namespaces: BTreeSet<String>,
    indexes: Vec<IndexSpec>,
    collections: BTreeMap<String, CollectionOptions>,
}

impl CatalogState {
    fn document(&self) -> String {
        let mut document = format!("{{\"version\":{CATALOG_DOCUMENT_VERSION},\"namespaces\":[");
        for (index, namespace) in self.namespaces.iter().enumerate() {
            if index > 0 {
                document.push(',');
            }
            document.push_str(&serde_json::to_string(namespace).unwrap_or_else(|_| "\"\"".to_string()));
        }
        document.push(']');
        // The `indexes` array is additive: catalogs without user indexes keep
        // the original byte length, so existing catalog assertions stay valid.
        if !self.indexes.is_empty() {
            document.push_str(",\"indexes\":[");
            for (position, index) in self.indexes.iter().enumerate() {
                if position > 0 {
                    document.push(',');
                }
                document.push_str(&index.to_json());
            }
            document.push(']');
        }
        // The `collections` array is additive for the same reason: it only
        // appears once a validator or a non-default validation level exists.
        if !self.collections.is_empty() {
            document.push_str(",\"collections\":[");
            for (position, (namespace, options)) in self.collections.iter().enumerate() {
                if position > 0 {
                    document.push(',');
                }
                document.push_str(&collection_options_json(namespace, options));
            }
            document.push(']');
        }
        document.push('}');
        document
    }

    fn flush(&self) -> Result<(), StoreError> {
        let schema = CatalogSchema { version: CATALOG_DOCUMENT_VERSION, document: self.document() };
        let bytes = catalog::encode(Some(&schema), None, &[ShardId(self.shard_id.clone())], None, &[])
            .map_err(|error| StoreError::Catalog(format!("cannot encode catalog `{}`: {error}", self.path.display())))?;
        write_catalog(&self.path, &bytes)
    }
}

/// Writes catalog bytes through a synced temporary file and an atomic rename.
///
/// A partially written catalog would be rejected on the next open with no way
/// back, so the catalog never becomes visible in a torn state.
fn write_catalog(path: &Path, bytes: &[u8]) -> Result<(), StoreError> {
    use std::io::Write;

    let temporary = path.with_extension("tmp");
    let write = (|| -> std::io::Result<()> {
        let mut file = std::fs::File::create(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temporary, path)
    })();
    write.map_err(|error| StoreError::Catalog(format!("cannot write catalog `{}`: {error}", path.display())))
}

fn parse_namespaces(document: &str) -> Result<BTreeSet<String>, StoreError> {
    let value: serde_json::Value = serde_json::from_str(document)
        .map_err(|error| StoreError::Catalog(format!("catalog schema document is not JSON: {error}")))?;
    let version = value.get("version").and_then(serde_json::Value::as_u64);
    if version != Some(u64::from(CATALOG_DOCUMENT_VERSION)) {
        return Err(StoreError::Catalog(format!(
            "catalog schema document version {version:?}, expected {CATALOG_DOCUMENT_VERSION}"
        )));
    }
    let Some(entries) = value.get("namespaces").and_then(serde_json::Value::as_array) else {
        return Err(StoreError::Catalog("catalog schema document has no `namespaces` array".to_string()));
    };
    let mut namespaces = BTreeSet::new();
    for entry in entries {
        let Some(label) = entry.as_str() else {
            return Err(StoreError::Catalog("catalog schema document has a non-string namespace".to_string()));
        };
        namespaces.insert(label.to_string());
    }
    Ok(namespaces)
}

fn collection_options_json(namespace: &str, options: &CollectionOptions) -> String {
    let field = |text: &str| serde_json::to_string(text).unwrap_or_else(|_| "\"\"".to_string());
    let mut text = format!("{{\"namespace\":{}", field(namespace));
    if let Some(validator) = &options.validator {
        text.push_str(&format!(",\"validator\":{}", serde_json::to_string(validator).unwrap_or_else(|_| "null".to_string())));
    }
    if let Some(level) = &options.validation_level {
        text.push_str(&format!(",\"validationLevel\":{}", field(level)));
    }
    if let Some(action) = &options.validation_action {
        text.push_str(&format!(",\"validationAction\":{}", field(action)));
    }
    text.push('}');
    text
}

fn parse_collections(document: &str) -> Result<BTreeMap<String, CollectionOptions>, StoreError> {
    let value: serde_json::Value = serde_json::from_str(document)
        .map_err(|error| StoreError::Catalog(format!("catalog schema document is not JSON: {error}")))?;
    let Some(entries) = value.get("collections") else { return Ok(BTreeMap::new()) };
    let Some(entries) = entries.as_array() else {
        return Err(StoreError::Catalog("catalog schema document has a non-array `collections` field".to_string()));
    };
    let mut collections = BTreeMap::new();
    for entry in entries {
        let namespace = entry
            .get("namespace")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| StoreError::Catalog("catalog collection entry has no namespace".to_string()))?;
        let options = CollectionOptions {
            validator: entry.get("validator").cloned(),
            validation_level: entry.get("validationLevel").and_then(serde_json::Value::as_str).map(str::to_string),
            validation_action: entry.get("validationAction").and_then(serde_json::Value::as_str).map(str::to_string),
        };
        collections.insert(namespace.to_string(), options);
    }
    Ok(collections)
}

impl IndexSpec {
    /// One catalog entry. The key is stored as ordered `[field, value]` pairs so
    /// a compound index keeps its creation order across a reopen.
    fn to_json(&self) -> String {
        let field = |text: &str| serde_json::to_string(text).unwrap_or_else(|_| "\"\"".to_string());
        let mut text = format!(
            "{{\"namespace\":{},\"name\":{},\"unique\":{},\"key\":[",
            field(&self.namespace),
            field(&self.name),
            self.unique
        );
        for (position, (name, value)) in self.key.fields.iter().enumerate() {
            if position > 0 {
                text.push(',');
            }
            text.push('[');
            text.push_str(&field(name));
            text.push(',');
            text.push_str(&serde_json::to_string(&json::to_json(value)).unwrap_or_else(|_| "null".to_string()));
            text.push(']');
        }
        text.push_str("]}");
        text
    }
}

fn parse_indexes(document: &str) -> Result<Vec<IndexSpec>, StoreError> {
    let value: serde_json::Value = serde_json::from_str(document)
        .map_err(|error| StoreError::Catalog(format!("catalog schema document is not JSON: {error}")))?;
    let Some(entries) = value.get("indexes") else { return Ok(Vec::new()) };
    let Some(entries) = entries.as_array() else {
        return Err(StoreError::Catalog("catalog schema document has a non-array `indexes` field".to_string()));
    };
    let mut indexes = Vec::with_capacity(entries.len());
    for entry in entries {
        let namespace = entry
            .get("namespace")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| StoreError::Catalog("catalog index entry has no namespace".to_string()))?;
        let name = entry
            .get("name")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| StoreError::Catalog("catalog index entry has no name".to_string()))?;
        let unique = entry.get("unique").and_then(serde_json::Value::as_bool).unwrap_or(false);
        let Some(pairs) = entry.get("key").and_then(serde_json::Value::as_array) else {
            return Err(StoreError::Catalog(format!("catalog index `{name}` has no key array")));
        };
        let mut key = BsonDocument::new();
        for pair in pairs {
            let Some(fields) = pair.as_array() else {
                return Err(StoreError::Catalog(format!("catalog index `{name}` has a malformed key entry")));
            };
            if fields.len() != 2 {
                return Err(StoreError::Catalog(format!("catalog index `{name}` has a malformed key entry")));
            }
            let Some(field) = fields[0].as_str() else {
                return Err(StoreError::Catalog(format!("catalog index `{name}` has a non-string key field")));
            };
            let value = json::from_json(&fields[1])
                .map_err(|error| StoreError::Catalog(format!("catalog index `{name}` key value is invalid: {error}")))?;
            key.push(field.to_string(), value);
        }
        indexes.push(IndexSpec { namespace: namespace.to_string(), name: name.to_string(), key, unique });
    }
    Ok(indexes)
}

fn legacy_namespaces(shard: &FileShard) -> Vec<String> {
    match shard.scan(&Namespace(CATALOG_NAMESPACE.to_string()), b"", None, None, 0) {
        Ok(records) => records
            .into_iter()
            .filter_map(|record| String::from_utf8(record.key.bytes).ok())
            .collect(),
        Err(_) => Vec::new(),
    }
}

fn valid_shard_id(shard_id: &str) -> bool {
    !shard_id.is_empty() && shard_id != "." && shard_id != ".." && !shard_id.contains(['/', '\\', '\0'])
}

fn catalog_path_for(requested: &Path) -> PathBuf {
    requested.with_extension(CATALOG_SUFFIX)
}

fn shard_path_for(catalog_path: &Path, shard_id: &str) -> PathBuf {
    let directory = catalog_path.parent().unwrap_or_else(|| Path::new("."));
    directory.join(format!("{shard_id}.yykv"))
}

fn load_catalog(catalog_path: &Path) -> Result<CatalogState, StoreError> {
    let bytes = std::fs::read(catalog_path)
        .map_err(|error| StoreError::Catalog(format!("cannot read catalog `{}`: {error}", catalog_path.display())))?;
    let (schema, _routing, shards, _contract, _owners) = catalog::decode(&bytes)
        .map_err(|error| StoreError::Catalog(format!("catalog `{}` is invalid: {error}", catalog_path.display())))?;
    if shards.len() != 1 {
        return Err(StoreError::Catalog(format!(
            "catalog `{}` registers {} shards, expected 1",
            catalog_path.display(),
            shards.len()
        )));
    }
    let shard_id = shards[0].0.clone();
    if !valid_shard_id(&shard_id) {
        return Err(StoreError::Catalog(format!("catalog `{}` has an unusable shard id", catalog_path.display())));
    }
    let namespaces = match &schema {
        Some(schema) => {
            if schema.version != CATALOG_DOCUMENT_VERSION {
                return Err(StoreError::Catalog(format!(
                    "catalog `{}` schema version {}, expected {CATALOG_DOCUMENT_VERSION}",
                    catalog_path.display(),
                    schema.version
                )));
            }
            parse_namespaces(&schema.document)?
        }
        None => BTreeSet::new(),
    };
    let indexes = match &schema {
        Some(schema) => parse_indexes(&schema.document)?,
        None => Vec::new(),
    };
    let collections = match &schema {
        Some(schema) => parse_collections(&schema.document)?,
        None => BTreeMap::new(),
    };
    Ok(CatalogState { path: catalog_path.to_path_buf(), shard_id, namespaces, indexes, collections })
}

fn new_catalog(requested: &Path, catalog_path: &Path) -> Result<CatalogState, StoreError> {
    let stem = requested
        .file_stem()
        .and_then(|stem| stem.to_str())
        .filter(|stem| !stem.is_empty())
        .ok_or_else(|| StoreError::Catalog(format!("shard path `{}` has no file stem", requested.display())))?;
    Ok(CatalogState {
        path: catalog_path.to_path_buf(),
        shard_id: stem.to_string(),
        namespaces: BTreeSet::new(),
        indexes: Vec::new(),
        collections: BTreeMap::new(),
    })
}

/// One in-flight transaction: staged writes plus the store version it started
/// from. `writes` is `None` for a staged delete.
#[derive(Debug, Clone)]
pub struct TransactionState {
    /// Store version observed when the transaction started.
    pub start_version: u64,
    /// Staged `(namespace, encoded _id) -> document bytes`.
    pub writes: BTreeMap<(String, Vec<u8>), Option<Vec<u8>>>,
    /// Set when a write conflict or `abortTransaction` ended the transaction.
    pub aborted: bool,
}

/// Result of staging one write inside a transaction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransactionWrite {
    /// The write was recorded in the transaction overlay.
    Staged,
    /// Another active transaction already staged the same document.
    Conflict,
}

/// Result of committing a transaction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransactionCommit {
    /// The staged writes were applied.
    Committed,
    /// A document was modified after the transaction started.
    Conflict,
    /// The transaction had already been aborted by a conflict.
    Aborted,
    /// The session has no transaction to commit.
    NoTransaction,
}

/// Sessions, their staged writes, and the per-document write versions used for
/// conflict detection. Kept in memory: it describes in-flight work, not data.
#[derive(Debug, Default)]
struct SessionRegistry {
    transactions: BTreeMap<String, TransactionState>,
    versions: BTreeMap<(String, Vec<u8>), u64>,
    version: u64,
}

/// Document store backed by one `.yyds` catalog and one `.yykv` shard.
#[derive(Debug)]
pub struct Store {
    shard: Mutex<FileShard>,
    catalog: Mutex<CatalogState>,
    sessions: Mutex<SessionRegistry>,
}

impl Store {
    /// Opens the store whose shard would be `path`, reading `<path>.yyds`.
    ///
    /// - Catalog present: its single `ShardId` selects `<dir>/<id>.yykv`; the
    ///   shard must exist. Invalid bytes, a different shard count, a bad
    ///   schema document, or a missing shard are structured rejections.
    /// - Catalog missing: it is created, seeded from the shard's `!catalog`
    ///   mirror, and the shard is created when absent.
    ///
    /// The shard is opened (and created) before the catalog is written, so a
    /// crash in between leaves a self-healing directory instead of a catalog
    /// that can never be opened.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        let requested = path.as_ref().to_path_buf();
        let catalog_path = catalog_path_for(&requested);
        let catalog_exists = catalog_path.exists();

        let mut catalog = if catalog_exists { load_catalog(&catalog_path)? } else { new_catalog(&requested, &catalog_path)? };

        let shard_path = if catalog_exists {
            shard_path_for(&catalog_path, &catalog.shard_id)
        } else {
            requested
        };
        if catalog_exists && !shard_path.exists() {
            return Err(StoreError::Catalog(format!(
                "catalog `{}` points at missing shard `{}`",
                catalog_path.display(),
                shard_path.display()
            )));
        }

        let shard = FileShard::open(&shard_path).map_err(|error| StoreError::Shard(error.to_string()))?;

        let mut changed = !catalog_exists;
        for label in legacy_namespaces(&shard) {
            if catalog.namespaces.insert(label) {
                changed = true;
            }
        }
        if changed {
            catalog.flush()?;
        }

        Ok(Self { shard: Mutex::new(shard), catalog: Mutex::new(catalog), sessions: Mutex::new(SessionRegistry::default()) })
    }

    fn lock(&self) -> MutexGuard<'_, FileShard> {
        match self.shard.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    fn catalog_lock(&self) -> MutexGuard<'_, CatalogState> {
        match self.catalog.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    fn sessions_lock(&self) -> MutexGuard<'_, SessionRegistry> {
        match self.sessions.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    /// Notes one committed batch in the per-document version map. Active
    /// transactions use these versions to detect a write conflict at commit.
    fn note_writes(&self, namespace: &str, keys: &[Vec<u8>]) {
        let mut registry = self.sessions_lock();
        registry.version += 1;
        let version = registry.version;
        for key in keys {
            registry.versions.insert((namespace.to_string(), key.clone()), version);
        }
    }

    /// Starts (or restarts) a transaction for one logical session.
    pub fn begin_transaction(&self, session: &str) {
        let mut registry = self.sessions_lock();
        let start_version = registry.version;
        registry.transactions.insert(
            session.to_string(),
            TransactionState { start_version, writes: BTreeMap::new(), aborted: false },
        );
    }

    /// Whether the session currently has a usable transaction.
    pub fn transaction_active(&self, session: &str) -> bool {
        self.sessions_lock().transactions.get(session).map(|state| !state.aborted).unwrap_or(false)
    }

    /// Stages one write in a transaction, rejecting a document another active
    /// transaction already holds.
    pub fn transaction_write(&self, session: &str, namespace: &str, key: &[u8], value: Option<Vec<u8>>) -> TransactionWrite {
        let mut registry = self.sessions_lock();
        let target = (namespace.to_string(), key.to_vec());
        let mut conflict = false;
        for (other, state) in &registry.transactions {
            if other == session || state.aborted {
                continue;
            }
            if state.writes.contains_key(&target) {
                conflict = true;
                break;
            }
        }
        if conflict {
            if let Some(state) = registry.transactions.get_mut(session) {
                state.aborted = true;
            }
            return TransactionWrite::Conflict;
        }
        if let Some(state) = registry.transactions.get_mut(session) {
            state.writes.insert(target, value);
        }
        TransactionWrite::Staged
    }

    /// The namespace as the transaction sees it, `None` when the session has no
    /// active transaction and the caller should read the committed data.
    pub fn transaction_scan(&self, session: &str, namespace: &str) -> Option<Vec<(Vec<u8>, Vec<u8>)>> {
        let staged: Vec<(Vec<u8>, Option<Vec<u8>>)> = {
            let registry = self.sessions_lock();
            let state = registry.transactions.get(session)?;
            if state.aborted {
                return None;
            }
            state
                .writes
                .iter()
                .filter(|((owner, _), _)| owner == namespace)
                .map(|((_, key), value)| (key.clone(), value.clone()))
                .collect()
        };
        let mut documents = self.scan(namespace);
        for (key, value) in staged {
            match value {
                Some(payload) => match documents.iter_mut().find(|(candidate, _)| candidate == &key) {
                    Some(existing) => existing.1 = payload,
                    None => documents.push((key, payload)),
                },
                None => documents.retain(|(candidate, _)| candidate != &key),
            }
        }
        Some(documents)
    }

    /// One document as the transaction sees it. The outer `Option` is `None`
    /// when the key is not staged, so the caller reads the committed value.
    pub fn transaction_get(&self, session: &str, namespace: &str, key: &[u8]) -> Option<Option<Vec<u8>>> {
        let registry = self.sessions_lock();
        let state = registry.transactions.get(session)?;
        if state.aborted {
            return None;
        }
        state.writes.get(&(namespace.to_string(), key.to_vec())).cloned().map(Some).unwrap_or(None)
    }

    /// Applies every staged write, or reports the conflict that prevents it.
    pub fn transaction_commit(&self, session: &str) -> TransactionCommit {
        let (start_version, aborted, writes) = {
            let registry = self.sessions_lock();
            let Some(state) = registry.transactions.get(session) else {
                return TransactionCommit::NoTransaction;
            };
            (state.start_version, state.aborted, state.writes.clone())
        };
        if aborted {
            let mut registry = self.sessions_lock();
            registry.transactions.remove(session);
            return TransactionCommit::Aborted;
        }
        let conflict = {
            let registry = self.sessions_lock();
            writes.keys().any(|key| registry.versions.get(key).map(|version| *version > start_version).unwrap_or(false))
        };
        if conflict {
            let mut registry = self.sessions_lock();
            if let Some(state) = registry.transactions.get_mut(session) {
                state.aborted = true;
            }
            return TransactionCommit::Conflict;
        }
        let mut by_namespace: BTreeMap<String, Vec<(Vec<u8>, Option<Vec<u8>>)>> = BTreeMap::new();
        for ((namespace, key), value) in writes {
            by_namespace.entry(namespace).or_default().push((key, value));
        }
        for (namespace, entries) in by_namespace {
            let replaced: Vec<(Vec<u8>, Vec<u8>)> =
                entries.iter().filter_map(|(key, value)| value.clone().map(|payload| (key.clone(), payload))).collect();
            if !replaced.is_empty() {
                let _ = self.replace(&namespace, &replaced);
            }
            let deleted: Vec<Vec<u8>> = entries.iter().filter(|(_, value)| value.is_none()).map(|(key, _)| key.clone()).collect();
            if !deleted.is_empty() {
                let _ = self.delete(&namespace, &deleted);
            }
        }
        self.sessions_lock().transactions.remove(session);
        TransactionCommit::Committed
    }

    /// Drops the transaction overlay. Returns `false` when there was nothing to abort.
    pub fn transaction_abort(&self, session: &str) -> bool {
        self.sessions_lock().transactions.remove(session).is_some()
    }

    fn register_namespace(&self, namespace: &str) -> Result<(), StoreError> {
        let mut catalog = self.catalog_lock();
        if !catalog.namespaces.insert(namespace.to_string()) {
            return Ok(());
        }
        catalog.flush()
    }

    /// Reads the collection options, defaulting to no validator and `strict` /
    /// `error` when the catalog has no entry.
    pub fn collection_options(&self, namespace: &str) -> CollectionOptions {
        self.catalog_lock().collections.get(namespace).cloned().unwrap_or_default()
    }

    /// Writes collection options and registers the namespace in one durable
    /// catalog update. An all-default option set removes the entry again.
    pub fn set_collection_options(&self, namespace: &str, options: CollectionOptions) -> Result<(), StoreError> {
        let mut catalog = self.catalog_lock();
        catalog.namespaces.insert(namespace.to_string());
        if options == CollectionOptions::default() {
            catalog.collections.remove(namespace);
        }
        else {
            catalog.collections.insert(namespace.to_string(), options);
        }
        catalog.flush()
    }

    /// Creates a collection. Returns `false` when the namespace already exists.
    pub fn create_collection(&self, namespace: &str, options: CollectionOptions) -> Result<bool, StoreError> {
        let mut catalog = self.catalog_lock();
        if !catalog.namespaces.insert(namespace.to_string()) {
            return Ok(false);
        }
        if options != CollectionOptions::default() {
            catalog.collections.insert(namespace.to_string(), options);
        }
        catalog.flush()?;
        Ok(true)
    }

    /// Reads one document by its encoded `_id`.
    pub fn get(&self, namespace: &str, key: &[u8]) -> Option<Vec<u8>> {
        let shard = self.lock();
        let record = shard.get(&Key::new(namespace, key.to_vec())).ok().flatten()?;
        match record.value {
            StoredValue::Inline(InlineValue(bytes)) => Some(bytes),
            StoredValue::Object(_) => None,
        }
    }

    /// Writes one batch and reports duplicate / invalid positions.
    ///
    /// The whole batch lands through one durable commit. `ordered` stops staging
    /// at the first duplicate, `ordered: false` keeps the remaining valid documents.
    pub fn insert(&self, namespace: &str, documents: &[(Vec<u8>, Vec<u8>)], ordered: bool) -> Result<InsertReport, StoreError> {
        let mut report = InsertReport::default();
        let mut written: Vec<Vec<u8>> = Vec::new();
        {
            let mut shard = self.lock();
            let mut changes = Vec::with_capacity(documents.len());
            let mut staged: BTreeSet<Vec<u8>> = BTreeSet::new();

            for (index, (key_bytes, payload)) in documents.iter().enumerate() {
                let key = Key::new(namespace, key_bytes.clone());
                // `staged.insert` is the same key encoding used for single-document
                // lookups, so intra-batch duplicates share the numeric equivalence
                // rules (int32/int64/integral double) without a second comparator.
                let already_staged = !staged.insert(key_bytes.clone());
                let exists = already_staged || matches!(shard.get(&key), Ok(Some(_)));
                if exists {
                    report.duplicates.push(index);
                    if ordered {
                        break;
                    }
                    continue;
                }
                changes.push(ShardChange::Put { key, value: StoredValue::Inline(InlineValue(payload.clone())), expires_at: None });
                written.push(key_bytes.clone());
                report.inserted += 1;
            }

            if changes.is_empty() {
                return Ok(report);
            }

            let catalog_key = Key::new(CATALOG_NAMESPACE, namespace.as_bytes().to_vec());
            if shard.get(&catalog_key).ok().flatten().is_none() {
                changes.push(ShardChange::Put {
                    key: catalog_key,
                    value: StoredValue::Inline(InlineValue(Vec::new())),
                    expires_at: None,
                });
            }

            shard.commit_changes(changes).map_err(|error| StoreError::Shard(error.to_string()))?;
        }
        self.note_writes(namespace, &written);
        self.register_namespace(namespace)?;
        Ok(report)
    }

    /// Every document in one namespace, ordered by encoded `_id`.
    pub fn scan(&self, namespace: &str) -> Vec<(Vec<u8>, Vec<u8>)> {
        let shard = self.lock();
        let records = match shard.scan(&Namespace(namespace.to_string()), b"", None, None, 0) {
            Ok(records) => records,
            Err(_) => return Vec::new(),
        };
        records
            .into_iter()
            .filter_map(|record| match record.value {
                StoredValue::Inline(InlineValue(bytes)) => Some((record.key.bytes, bytes)),
                StoredValue::Object(_) => None,
            })
            .collect()
    }

    /// Deletes the given encoded `_id` keys and reports how many existed.
    pub fn delete(&self, namespace: &str, keys: &[Vec<u8>]) -> Result<usize, StoreError> {
        let mut shard = self.lock();
        let mut changes = Vec::new();
        for key in keys {
            let candidate = Key::new(namespace, key.clone());
            if matches!(shard.get(&candidate), Ok(Some(_))) {
                changes.push(ShardChange::Delete { key: candidate });
            }
        }
        if changes.is_empty() {
            return Ok(0);
        }
        let removed = changes.len();
        let deleted: Vec<Vec<u8>> = keys.to_vec();
        shard.commit_changes(changes).map_err(|error| StoreError::Shard(error.to_string()))?;
        drop(shard);
        self.note_writes(namespace, &deleted);
        Ok(removed)
    }

    /// Overwrites documents in place without duplicate checks, used by `update`.
    pub fn replace(&self, namespace: &str, documents: &[(Vec<u8>, Vec<u8>)]) -> Result<usize, StoreError> {
        self.write_batch(namespace, documents)
    }

    /// Persists one batch without duplicate checks, used by `mongodump` import.
    pub fn import(&self, namespace: &str, documents: &[(Vec<u8>, Vec<u8>)]) -> Result<usize, StoreError> {
        self.write_batch(namespace, documents)
    }

    fn write_batch(&self, namespace: &str, documents: &[(Vec<u8>, Vec<u8>)]) -> Result<usize, StoreError> {
        {
            let mut shard = self.lock();
            let mut changes = Vec::with_capacity(documents.len() + 1);
            for (key_bytes, payload) in documents {
                changes.push(ShardChange::Put {
                    key: Key::new(namespace, key_bytes.clone()),
                    value: StoredValue::Inline(InlineValue(payload.clone())),
                    expires_at: None,
                });
            }
            changes.push(ShardChange::Put {
                key: Key::new(CATALOG_NAMESPACE, namespace.as_bytes().to_vec()),
                value: StoredValue::Inline(InlineValue(Vec::new())),
                expires_at: None,
            });
            shard.commit_changes(changes).map_err(|error| StoreError::Shard(error.to_string()))?;
        }
        let keys: Vec<Vec<u8>> = documents.iter().map(|(key, _)| key.clone()).collect();
        self.note_writes(namespace, &keys);
        self.register_namespace(namespace)?;
        Ok(documents.len())
    }

    /// Namespaces registered in the `.yyds` catalog, sorted.
    pub fn namespaces(&self) -> Vec<String> {
        self.catalog_lock().namespaces.iter().cloned().collect()
    }

    /// Whether `namespace` is registered in the catalog.
    pub fn namespace_exists(&self, namespace: &str) -> bool {
        self.catalog_lock().namespaces.contains(namespace)
    }

    /// User indexes of one namespace in creation order, `_id_` excluded.
    pub fn index_specs(&self, namespace: &str) -> Vec<IndexSpec> {
        self.catalog_lock().indexes.iter().filter(|index| index.namespace == namespace).cloned().collect()
    }

    /// Registers `namespace` and appends the new index definitions in one flush.
    ///
    /// `createIndexes` creates the collection, so an index can exist on a
    /// namespace that holds no documents yet.
    pub fn add_indexes(&self, namespace: &str, indexes: &[IndexSpec]) -> Result<(), StoreError> {
        let mut catalog = self.catalog_lock();
        catalog.namespaces.insert(namespace.to_string());
        catalog.indexes.extend(indexes.iter().cloned());
        catalog.flush()
    }

    /// Drops the named user index, or every user index when `name` is `*`.
    pub fn drop_indexes(&self, namespace: &str, name: &str) -> Result<usize, StoreError> {
        let mut catalog = self.catalog_lock();
        let before = catalog.indexes.len();
        catalog.indexes.retain(|index| {
            if index.namespace != namespace {
                return true;
            }
            name != "*" && index.name != name
        });
        let removed = before - catalog.indexes.len();
        if removed > 0 {
            catalog.flush()?;
        }
        Ok(removed)
    }

    /// Creates the shard named by the catalog when only the catalog survived.
    ///
    /// Deliberately narrow: it never invents a catalog, never overwrites an
    /// existing shard (even an unreadable one), never touches the catalog
    /// bytes, and is a no-op on a healthy directory. `open` never calls this;
    /// the host has to ask for it explicitly.
    pub fn repair_shard(path: impl AsRef<Path>) -> Result<RepairReport, StoreError> {
        let requested = path.as_ref().to_path_buf();
        let catalog_path = catalog_path_for(&requested);
        if !catalog_path.exists() {
            return Err(StoreError::Catalog(format!(
                "catalog `{}` is missing; repair only rebuilds a shard named by an existing catalog",
                catalog_path.display()
            )));
        }
        let catalog = load_catalog(&catalog_path)?;
        let shard_path = shard_path_for(&catalog_path, &catalog.shard_id);
        if shard_path.exists() {
            return Ok(RepairReport { created: false, shard: catalog.shard_id });
        }
        FileShard::open(&shard_path).map_err(|error| StoreError::Shard(error.to_string()))?;
        Ok(RepairReport { created: true, shard: catalog.shard_id })
    }
}

/// Outcome of an explicit [`Store::repair_shard`].
#[derive(Debug)]
pub struct RepairReport {
    /// Whether an empty shard was written.
    pub created: bool,
    /// Shard id named by the catalog.
    pub shard: String,
}

impl RepairReport {
    /// JSON description exchanged with the language bindings.
    pub fn to_json(&self) -> String {
        serde_json::json!({ "created": self.created, "shard": self.shard }).to_string()
    }
}
