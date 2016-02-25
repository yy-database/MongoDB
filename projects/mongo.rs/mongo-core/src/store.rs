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
    collections::BTreeSet,
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
};

use database::{
    cluster::catalog,
    storage::cluster_kv::{FileShard, InlineValue, Key, KvStore, ShardChange, StoredValue},
    types::cluster::{CatalogSchema, Namespace, ShardId, CATALOG_SUFFIX},
};

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
        document.push_str("]}");
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
    let namespaces = match schema {
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
    Ok(CatalogState { path: catalog_path.to_path_buf(), shard_id, namespaces })
}

fn new_catalog(requested: &Path, catalog_path: &Path) -> Result<CatalogState, StoreError> {
    let stem = requested
        .file_stem()
        .and_then(|stem| stem.to_str())
        .filter(|stem| !stem.is_empty())
        .ok_or_else(|| StoreError::Catalog(format!("shard path `{}` has no file stem", requested.display())))?;
    Ok(CatalogState { path: catalog_path.to_path_buf(), shard_id: stem.to_string(), namespaces: BTreeSet::new() })
}

/// Document store backed by one `.yyds` catalog and one `.yykv` shard.
#[derive(Debug)]
pub struct Store {
    shard: Mutex<FileShard>,
    catalog: Mutex<CatalogState>,
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

        Ok(Self { shard: Mutex::new(shard), catalog: Mutex::new(catalog) })
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

    fn register_namespace(&self, namespace: &str) -> Result<(), StoreError> {
        let mut catalog = self.catalog_lock();
        if !catalog.namespaces.insert(namespace.to_string()) {
            return Ok(());
        }
        catalog.flush()
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
        shard.commit_changes(changes).map_err(|error| StoreError::Shard(error.to_string()))?;
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
        self.register_namespace(namespace)?;
        Ok(documents.len())
    }

    /// Namespaces registered in the `.yyds` catalog, sorted.
    pub fn namespaces(&self) -> Vec<String> {
        self.catalog_lock().namespaces.iter().cloned().collect()
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
