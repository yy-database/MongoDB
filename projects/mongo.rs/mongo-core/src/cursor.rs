//! Caller-owned cursor table.
//!
//! No global registry lives here: every host (TypeScript, Python, Rust tests) owns
//! its own [`CursorStore`] and passes it to the command primitives. Reclaim is
//! lazy, an idle cursor is only removed by the next cursor operation.

use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

use crate::bson::BsonValue;

/// Idle time after which a cursor is reclaimed.
pub const DEFAULT_IDLE_TIMEOUT: Duration = Duration::from_secs(600);

/// One open cursor.
#[derive(Debug)]
pub struct Cursor {
    /// Namespace reported back in `cursor.ns` replies.
    pub namespace: String,
    /// Documents the next `getMore` returns.
    pub remaining: Vec<BsonValue>,
    last_used: Instant,
}

/// Per-host cursor table.
#[derive(Debug)]
pub struct CursorStore {
    cursors: HashMap<i64, Cursor>,
    next_id: i64,
    idle_timeout: Duration,
}

impl Default for CursorStore {
    fn default() -> Self {
        Self::new()
    }
}

impl CursorStore {
    /// Creates an empty table with the documented 600 second reclaim window.
    pub fn new() -> Self {
        Self::with_idle_timeout(DEFAULT_IDLE_TIMEOUT)
    }

    /// Creates an empty table with an explicit reclaim window.
    pub fn with_idle_timeout(idle_timeout: Duration) -> Self {
        Self { cursors: HashMap::new(), next_id: 1, idle_timeout }
    }

    /// Number of live cursors.
    pub fn len(&self) -> usize {
        self.cursors.len()
    }

    /// Whether the table is empty.
    pub fn is_empty(&self) -> bool {
        self.cursors.is_empty()
    }

    /// Whether one cursor id is still live.
    pub fn contains(&self, id: i64) -> bool {
        self.cursors.contains_key(&id)
    }

    /// Reclaim window currently in use.
    pub fn idle_timeout(&self) -> Duration {
        self.idle_timeout
    }

    /// Stores the unsent documents and returns the first batch.
    ///
    /// A cursor id of `0` means everything fit into the first batch.
    pub fn open(&mut self, namespace: &str, mut documents: Vec<BsonValue>, batch_size: usize) -> (i64, Vec<BsonValue>) {
        self.reclaim();
        if batch_size == 0 || documents.len() <= batch_size {
            return (0, documents);
        }
        let first_batch: Vec<BsonValue> = documents.drain(..batch_size).collect();
        let id = self.next_id;
        self.next_id += 1;
        self.cursors.insert(id, Cursor { namespace: namespace.to_string(), remaining: documents, last_used: Instant::now() });
        (id, first_batch)
    }

    /// Drains `batch_size` documents (or everything when `batch_size` is zero).
    pub fn get_more(&mut self, id: i64, batch_size: usize) -> Result<(Vec<BsonValue>, String), i64> {
        self.reclaim();
        let Some(cursor) = self.cursors.get_mut(&id)
        else {
            return Err(id);
        };
        cursor.last_used = Instant::now();
        let take = if batch_size == 0 { cursor.remaining.len() } else { batch_size.min(cursor.remaining.len()) };
        let namespace = cursor.namespace.clone();
        let batch: Vec<BsonValue> = cursor.remaining.drain(..take).collect();
        let drained = cursor.remaining.is_empty();
        if drained {
            self.cursors.remove(&id);
        }
        Ok((batch, namespace))
    }

    /// Removes the given cursors and reports which ids were alive.
    pub fn kill(&mut self, identifiers: &[i64]) -> (Vec<i64>, Vec<i64>) {
        let mut killed = Vec::new();
        let mut not_found = Vec::new();
        for id in identifiers {
            if self.cursors.remove(id).is_some() {
                killed.push(*id);
            }
            else {
                not_found.push(*id);
            }
        }
        (killed, not_found)
    }

    /// Drops cursors idle for longer than the reclaim window.
    pub fn reclaim(&mut self) {
        let idle_timeout = self.idle_timeout;
        self.cursors.retain(|_, cursor| cursor.last_used.elapsed() < idle_timeout);
    }
}
