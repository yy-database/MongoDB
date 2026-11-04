//! `.yykv` storage adapter for Mongo namespaces.
//!
//! One YYDS file shard holds every namespace; `Key.namespace` is the Mongo
//! `<database>.<collection>` label and `Key.bytes` is the encoded `_id`, so a
//! collection scan is a prefix scan inside one namespace.

use std::{
    path::Path,
    sync::{Mutex, MutexGuard},
};

use yyds::{
    kv::{FileShard, InlineValue, Key, KvStore, ShardChange, StoredValue},
    types::Namespace,
};

/// Namespace label used to remember which Mongo namespaces exist.
///
/// Mongo collection names cannot contain `$` or a NUL byte and a database name
/// cannot be `!catalog`, so this label never collides with user data.
const CATALOG_NAMESPACE: &str = "!catalog";

/// Errors surfaced by the storage adapter.
#[derive(Debug)]
pub enum StoreError {
    /// The shard rejected the command.
    Shard(String),
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Shard(message) => write!(formatter, "{message}"),
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

/// Document store backed by one `.yykv` shard.
#[derive(Debug)]
pub struct Store {
    shard: Mutex<FileShard>,
}

impl Store {
    /// Opens (or creates) the shard at `path`.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        let shard = FileShard::open(path).map_err(|error| StoreError::Shard(error.to_string()))?;
        Ok(Self { shard: Mutex::new(shard) })
    }

    fn lock(&self) -> MutexGuard<'_, FileShard> {
        match self.shard.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
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
        let mut shard = self.lock();
        let mut report = InsertReport::default();
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

    /// Persists one batch without duplicate checks, used by `mongodump` import.
    pub fn import(&self, namespace: &str, documents: &[(Vec<u8>, Vec<u8>)]) -> Result<usize, StoreError> {
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
        Ok(documents.len())
    }

    /// Namespaces recorded in the catalog, sorted.
    pub fn namespaces(&self) -> Vec<String> {
        let shard = self.lock();
        let records = match shard.scan(&Namespace(CATALOG_NAMESPACE.to_string()), b"", None, None, 0) {
            Ok(records) => records,
            Err(_) => return Vec::new(),
        };
        let mut labels: Vec<String> =
            records.into_iter().filter_map(|record| String::from_utf8(record.key.bytes).ok()).collect();
        labels.sort();
        labels
    }
}
