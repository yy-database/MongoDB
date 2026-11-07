//! MongoDB protocol and command primitives backed by YYDS `.yykv` shards.
//!
//! This crate ships library primitives only: no binary, no server loop, no CLI.
//! Hosts (TypeScript and Python in this repository) compose the pieces:
//!
//! * [`bson`] — BSON value / document codecs (re-exported from `database-protocol-mongo`)
//! * [`json`] — extended-JSON bridge for non-Rust hosts
//! * [`wire`] — frame headers, framed reads / writes and `OP_MSG` / `OP_QUERY` translation
//!   (re-exported from `database-protocol-mongo`)
//! * [`store`] — `.yykv` document store (one shard, namespace-per-collection)
//! * [`cursor`] — caller-owned cursor table with lazy reclaim
//! * [`commands`] — one function per supported command, each callable alone
#![warn(missing_docs)]

#[cfg(feature = "storage")]
use std::path::Path;

pub use database_protocol_mongo::{bson, json, wire};

#[cfg(feature = "storage")]
pub mod commands;
#[cfg(feature = "storage")]
pub mod cursor;
#[cfg(feature = "storage")]
pub mod oplog;
#[cfg(feature = "storage")]
pub mod store;

#[cfg(feature = "storage")]
use bson::{BsonValue, encode_bson, parse_bson};
#[cfg(feature = "storage")]
use store::Store;

/// Reads a `mongodump`-style `.bson` stream (concatenated documents) and writes
/// every document into `namespace`, generating an ObjectId when `_id` is absent.
#[cfg(feature = "storage")]
pub fn import_bson_documents(store: &Store, namespace: &str, bytes: &[u8]) -> Result<usize, String> {
    if namespace.is_empty() || !namespace.contains('.') {
        return Err("namespace must be `<database>.<collection>`".to_string());
    }
    let mut offset = 0_usize;
    let mut entries = Vec::new();
    while offset < bytes.len() {
        let length = bytes
            .get(offset..offset + 4)
            .and_then(|head| <[u8; 4]>::try_from(head).ok())
            .map(i32::from_le_bytes)
            .filter(|length| *length >= 5)
            .ok_or_else(|| format!("invalid BSON length at offset {offset}"))? as usize;
        let end = offset
            .checked_add(length)
            .filter(|end| *end <= bytes.len())
            .ok_or_else(|| format!("BSON document truncated at offset {offset}"))?;
        let mut document =
            parse_bson(&bytes[offset..end]).map_err(|error| format!("invalid BSON at offset {offset}: {error:?}"))?;
        if !document.fields.iter().any(|(field, _)| field == "_id") {
            document.push("_id".to_string(), BsonValue::ObjectId(commands::generate_object_id()));
        }
        let identifier = document.fields.iter().find(|(field, _)| field == "_id").map(|(_, value)| value.clone()).unwrap();
        entries.push((value_to_key(&identifier), encode_bson(&document)));
        offset = end;
    }
    store.import(namespace, &entries).map_err(|error| error.to_string())
}

/// Reads a `mongodump` `.bson` file into one namespace.
#[cfg(feature = "storage")]
pub fn import_bson_file(store: &Store, namespace: &str, path: impl AsRef<Path>) -> Result<usize, String> {
    let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
    import_bson_documents(store, namespace, &bytes)
}

#[cfg(feature = "storage")]
use bson::value_to_key;
