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

use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
};

use yyds::{
    catalog,
    kv::{FileShard, InlineValue, Key, KvStore, ShardChange, StoredValue},
    types::{CatalogSchema, Namespace, ShardId, CATALOG_SUFFIX},
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
        std::fs::write(&self.path, bytes)
            .map_err(|error| StoreError::Catalog(format!("cannot write catalog `{}`: {error}", self.path.display())))
    }
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
    pub fn open(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        let requested = path.as_ref().to_path_buf();
        let catalog_path = requested.with_extension(CATALOG_SUFFIX);
        let catalog_exists = catalog_path.exists();

        let mut catalog = if catalog_exists {
            let bytes = std::fs::read(&catalog_path)
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
            CatalogState { path: catalog_path.clone(), shard_id, namespaces }
        } else {
            let stem = requested
                .file_stem()
                .and_then(|stem| stem.to_str())
                .filter(|stem| !stem.is_empty())
                .ok_or_else(|| StoreError::Catalog(format!("shard path `{}` has no file stem", requested.display())))?;
            CatalogState { path: catalog_path.clone(), shard_id: stem.to_string(), namespaces: BTreeSet::new() }
        };

        let shard_path = if catalog_exists {
            let directory = catalog_path.parent().unwrap_or_else(|| Path::new("."));
            directory.join(format!("{}.yykv", catalog.shard_id))
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

            for (index, (key_bytes, payload)) in documents.iter().enumerate() {
                let key = Key::new(namespace, key_bytes.clone());
                let exists = matches!(shard.get(&key), Ok(Some(_)));
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
}
