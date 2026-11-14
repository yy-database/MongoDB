//! Node bindings: thin wrappers over the Rust primitives.
//!
//! No global state and no `start` entry: the host owns the socket loop, the
//! cursor table instance, and the CLI.

use std::sync::Arc;

use database::harness::{
    Baseline, BaselineIdentity, DifferenceObservation, Digest, ReportEnvelope, Stats, check_baseline, per_op_ms, render_json,
    summarize,
};
use mongo::{
    bson::BsonDocument,
    commands::{self, CommandError},
    cursor::CursorStore,
    json,
    store::Store,
    wire::{decode_op_msg_command, decode_op_query_command, encode_op_msg_body},
};
use napi::{Error, Result, Status, bindgen_prelude::Buffer};
use napi_derive::napi;

fn decode_command(text: &str) -> Result<BsonDocument> {
    json::document_from_json(text).map_err(|message| Error::new(Status::InvalidArg, message))
}

fn reply(document: &BsonDocument) -> String {
    json::document_to_json(document)
}

fn command_reply(result: std::result::Result<BsonDocument, CommandError>) -> String {
    match result {
        Ok(document) => reply(&document),
        Err(error) => reply(&commands::error_document(&error)),
    }
}

/// One `OP_MSG` payload: zero flags, one body section, then the BSON document.
///
/// Read replies reach the host as these bytes, so a document read never has to
/// be rendered to extended JSON and parsed back before it goes on the wire.
fn op_msg_body(document: &BsonDocument) -> Buffer {
    Buffer::from(mongo::wire::encode_op_msg_body(document))
}

fn command_op_msg(result: std::result::Result<BsonDocument, CommandError>) -> Buffer {
    match result {
        Ok(document) => op_msg_body(&document),
        Err(error) => op_msg_body(&commands::error_document(&error)),
    }
}

/// Document store backed by one `.yykv` shard.
#[napi]
pub struct MongoStore {
    inner: Arc<Store>,
}

#[napi]
impl MongoStore {
    /// Opens (or creates) the shard at `path`.
    #[napi(constructor)]
    pub fn new(path: String) -> Result<Self> {
        let store = Store::open(path).map_err(|error| Error::new(Status::GenericFailure, error.to_string()))?;
        Ok(Self { inner: Arc::new(store) })
    }
}

fn store_of(store: &MongoStore) -> &Store {
    &store.inner
}

/// Caller-owned cursor table.
#[napi]
pub struct MongoCursors {
    inner: CursorStore,
}

#[napi]
impl MongoCursors {
    /// Creates an empty cursor table with the documented 600 second window.
    #[napi(constructor)]
    pub fn new() -> Self {
        Self { inner: CursorStore::new() }
    }

    /// Marks every cursor on `database` as killed by `dropDatabase`.
    ///
    /// Returns how many cursors were affected. The next `getMore` answers
    /// `QueryPlanKilled` and removes the entry, as `mongod` does.
    #[napi]
    pub fn drop_database(&mut self, database: String) -> u32 {
        self.inner.drop_database(&database) as u32
    }

    /// Marks the cursors of one `db.collection` namespace as killed by a drop.
    #[napi]
    pub fn drop_collection(&mut self, namespace: String) -> u32 {
        self.inner.drop_collection(&namespace) as u32
    }

    /// Number of live cursors.
    #[napi]
    pub fn len(&self) -> u32 {
        self.inner.len() as u32
    }

    /// Whether the cursor table holds no live cursors.
    #[napi]
    pub fn is_empty(&self) -> bool {
        self.inner.is_empty()
    }
}

impl Default for MongoCursors {
    fn default() -> Self {
        Self::new()
    }
}

/// Decodes an `OP_MSG` body into extended JSON.
#[napi]
pub fn decode_op_msg(body: Buffer) -> Result<String> {
    decode_op_msg_command(&body)
        .map(|document| reply(&document))
        .map_err(|error| Error::new(Status::InvalidArg, format!("{error:?}")))
}

/// Encodes an extended-JSON command into an `OP_MSG` body.
#[napi]
pub fn encode_op_msg(command: String) -> Result<Buffer> {
    Ok(Buffer::from(encode_op_msg_body(&decode_command(&command)?)))
}

/// Encodes an extended-JSON document into BSON bytes.
#[napi]
pub fn encode_document(document: String) -> Result<Buffer> {
    Ok(Buffer::from(mongo::bson::encode_bson(&decode_command(&document)?)))
}

/// Decodes BSON bytes into extended JSON.
#[napi]
pub fn decode_document(bytes: Buffer) -> Result<String> {
    mongo::bson::parse_bson(&bytes)
        .map(|document| reply(&document))
        .map_err(|error| Error::new(Status::InvalidArg, format!("{error:?}")))
}

/// Decodes a legacy `OP_QUERY` body into extended JSON.
#[napi]
pub fn decode_op_query(body: Buffer) -> Result<String> {
    decode_op_query_command(&body)
        .map(|document| reply(&document))
        .map_err(|error| Error::new(Status::InvalidArg, format!("{error:?}")))
}

/// Name of the command in an extended-JSON document.
#[napi]
pub fn command_name(command: String) -> Result<String> {
    decode_command(&command)?.command_name().map(str::to_string).ok_or_else(|| Error::new(Status::InvalidArg, "empty command"))
}

/// `{ ok: 0, code, errmsg }` as extended JSON.
#[napi]
pub fn error_reply(code: i32, message: String) -> String {
    reply(&commands::error_document(&CommandError::new(code, message)))
}

/// `hello` / `isMaster` reply.
#[napi]
pub fn hello() -> String {
    reply(&commands::hello())
}

/// `ping` reply.
#[napi]
pub fn ping() -> String {
    reply(&commands::ping())
}

/// `ping` reply as an `OP_MSG` payload.
#[napi]
pub fn ping_op_msg() -> Buffer {
    op_msg_body(&commands::ping())
}

/// 写命令的 `OP_MSG` 应答：已编码好的载荷加一个 `ok` 标志。
///
/// 宿主据此决定是否提交 oplog、是否把应答放进重试登记表，不必为了读一个
/// `ok` 再把整份载荷解码回扩展 JSON。
#[napi(object)]
pub struct CommandFrame {
    /// 零标志、一个 body section，然后是 BSON 文档。
    pub payload: Buffer,
    /// 命令是否成功（应答里的 `ok` 为真）。
    pub ok: bool,
}

fn command_frame(result: std::result::Result<BsonDocument, CommandError>) -> CommandFrame {
    match result {
        Ok(document) => CommandFrame { payload: op_msg_body(&document), ok: true },
        Err(error) => CommandFrame { payload: op_msg_body(&commands::error_document(&error)), ok: false },
    }
}

/// `insert` reply.
#[napi]
pub fn insert(store: &MongoStore, command: String) -> Result<String> {
    Ok(command_reply(commands::insert(&decode_command(&command)?, store_of(store))))
}

/// `insert` reply as an `OP_MSG` payload.
#[napi]
pub fn insert_op_msg(store: &MongoStore, command: String) -> Result<CommandFrame> {
    Ok(command_frame(commands::insert(&decode_command(&command)?, store_of(store))))
}

/// `find` reply.
#[napi]
pub fn find(store: &MongoStore, cursors: &mut MongoCursors, command: String) -> Result<String> {
    Ok(command_reply(commands::find(&decode_command(&command)?, store_of(store), &mut cursors.inner)))
}

/// `find` reply as an `OP_MSG` payload.
#[napi]
pub fn find_op_msg(store: &MongoStore, cursors: &mut MongoCursors, command: String) -> Result<Buffer> {
    Ok(command_op_msg(commands::find(&decode_command(&command)?, store_of(store), &mut cursors.inner)))
}

/// `count` reply.
#[napi]
pub fn count(store: &MongoStore, command: String) -> Result<String> {
    Ok(command_reply(commands::count(&decode_command(&command)?, store_of(store))))
}

/// `count` reply as an `OP_MSG` payload.
#[napi]
pub fn count_op_msg(store: &MongoStore, command: String) -> Result<Buffer> {
    Ok(command_op_msg(commands::count(&decode_command(&command)?, store_of(store))))
}

/// `explain` reply.
#[napi]
pub fn explain(store: &MongoStore, command: String) -> Result<String> {
    Ok(command_reply(commands::explain(&decode_command(&command)?, store_of(store))))
}

/// `aggregate` reply.
#[napi]
pub fn aggregate(store: &MongoStore, command: String) -> Result<String> {
    Ok(command_reply(commands::aggregate(&decode_command(&command)?, store_of(store))))
}

/// `aggregate` reply as an `OP_MSG` payload.
#[napi]
pub fn aggregate_op_msg(store: &MongoStore, command: String) -> Result<Buffer> {
    Ok(command_op_msg(commands::aggregate(&decode_command(&command)?, store_of(store))))
}

/// `delete` reply.
#[napi]
pub fn delete(store: &MongoStore, command: String) -> Result<String> {
    Ok(command_reply(commands::delete(&decode_command(&command)?, store_of(store))))
}

/// `delete` reply as an `OP_MSG` payload.
#[napi]
pub fn delete_op_msg(store: &MongoStore, command: String) -> Result<CommandFrame> {
    Ok(command_frame(commands::delete(&decode_command(&command)?, store_of(store))))
}

/// `update` reply.
#[napi]
pub fn update(store: &MongoStore, command: String) -> Result<String> {
    Ok(command_reply(commands::update(&decode_command(&command)?, store_of(store))))
}

/// `update` reply as an `OP_MSG` payload.
#[napi]
pub fn update_op_msg(store: &MongoStore, command: String) -> Result<CommandFrame> {
    Ok(command_frame(commands::update(&decode_command(&command)?, store_of(store))))
}

/// `getMore` reply.
#[napi]
pub fn get_more(cursors: &mut MongoCursors, command: String) -> Result<String> {
    Ok(command_reply(commands::get_more(&decode_command(&command)?, &mut cursors.inner)))
}

/// `getMore` reply as an `OP_MSG` payload.
#[napi]
pub fn get_more_op_msg(cursors: &mut MongoCursors, command: String) -> Result<Buffer> {
    Ok(command_op_msg(commands::get_more(&decode_command(&command)?, &mut cursors.inner)))
}

/// `killCursors` reply.
#[napi]
pub fn kill_cursors(cursors: &mut MongoCursors, command: String) -> Result<String> {
    Ok(command_reply(commands::kill_cursors(&decode_command(&command)?, &mut cursors.inner)))
}

/// `findAndModify` reply.
#[napi]
pub fn find_and_modify(store: &MongoStore, command: String) -> Result<String> {
    Ok(command_reply(commands::find_and_modify(&decode_command(&command)?, store_of(store))))
}

/// `distinct` reply.
#[napi]
pub fn distinct(store: &MongoStore, command: String) -> Result<String> {
    Ok(command_reply(commands::distinct(&decode_command(&command)?, store_of(store))))
}

/// `bulkWrite` reply.
#[napi]
pub fn bulk_write(store: &MongoStore, command: String) -> Result<String> {
    Ok(command_reply(commands::bulk_write(&decode_command(&command)?, store_of(store))))
}

/// `create` reply.
#[napi]
pub fn create(store: &MongoStore, command: String) -> Result<String> {
    Ok(command_reply(commands::create(&decode_command(&command)?, store_of(store))))
}

/// `drop` reply.
#[napi]
pub fn drop_collection(store: &MongoStore, command: String) -> Result<String> {
    Ok(command_reply(commands::drop(&decode_command(&command)?, store_of(store))))
}

/// `collMod` reply.
#[napi]
pub fn coll_mod(store: &MongoStore, command: String) -> Result<String> {
    Ok(command_reply(commands::coll_mod(&decode_command(&command)?, store_of(store))))
}

/// `listCollections` reply.
#[napi]
pub fn list_collections(store: &MongoStore, command: String) -> Result<String> {
    Ok(command_reply(commands::list_collections(&decode_command(&command)?, store_of(store))))
}

/// `commitTransaction` reply.
#[napi]
pub fn commit_transaction(store: &MongoStore, command: String) -> Result<String> {
    Ok(command_reply(commands::commit_transaction(&decode_command(&command)?, store_of(store))))
}

/// `abortTransaction` reply.
#[napi]
pub fn abort_transaction(store: &MongoStore, command: String) -> Result<String> {
    Ok(command_reply(commands::abort_transaction(&decode_command(&command)?, store_of(store))))
}

/// `listDatabases` reply.
#[napi]
pub fn list_databases(store: &MongoStore) -> String {
    command_reply(commands::list_databases(store_of(store)))
}

/// `dropDatabase` reply.
#[napi]
pub fn drop_database(store: &MongoStore, command: String) -> Result<String> {
    Ok(command_reply(commands::drop_database(&decode_command(&command)?, store_of(store))))
}

/// `dbStats` reply.
///
/// `fsUsed` / `fsTotal` are filesystem bytes measured by the host; `None` when
/// the database does not exist, which is when `mongod` also reports zero.
#[napi]
pub fn db_stats(store: &MongoStore, command: String, fs_used: Option<i64>, fs_total: Option<i64>) -> Result<String> {
    let filesystem = fs_used.zip(fs_total);
    Ok(command_reply(commands::db_stats(&decode_command(&command)?, store_of(store), filesystem)))
}

/// `collStats` reply, the per-collection half of `dbStats`.
#[napi]
pub fn coll_stats(store: &MongoStore, command: String) -> Result<String> {
    Ok(command_reply(commands::coll_stats(&decode_command(&command)?, store_of(store))))
}

/// `createIndexes` reply.
#[napi]
pub fn create_indexes(store: &MongoStore, command: String) -> Result<String> {
    Ok(command_reply(commands::create_indexes(&decode_command(&command)?, store_of(store))))
}

/// `listIndexes` reply.
#[napi]
pub fn list_indexes(store: &MongoStore, command: String) -> Result<String> {
    Ok(command_reply(commands::list_indexes(&decode_command(&command)?, store_of(store))))
}

/// `dropIndexes` reply.
#[napi]
pub fn drop_indexes(store: &MongoStore, command: String) -> Result<String> {
    Ok(command_reply(commands::drop_indexes(&decode_command(&command)?, store_of(store))))
}

/// Changes `ttlMonitorSleepSecs` (whole seconds, at least one).
#[napi]
pub fn set_ttl_monitor_sleep_seconds(store: &MongoStore, seconds: u32) {
    store_of(store).set_ttl_monitor_sleep_seconds(seconds);
}

/// One TTL monitor pass; `nowMs` defaults to the wall clock.
///
/// `mongod` runs the pass from a background thread every `ttlMonitorSleepSecs`,
/// so the host calls this from its own loop. Passing `nowMs` lets hosts and
/// tests compress that window without changing the semantics.
#[napi]
pub fn ttl_monitor(store: &MongoStore, now_ms: Option<i64>) -> String {
    let now = now_ms.unwrap_or_else(wall_clock_millis);
    match commands::ttl_monitor(store_of(store), now) {
        Ok(report) => reply(&commands::ttl_report_document(&report)),
        Err(error) => reply(&commands::error_document(&error)),
    }
}

fn wall_clock_millis() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now().duration_since(UNIX_EPOCH).map(|duration| duration.as_millis() as i64).unwrap_or(0)
}

/// Configures the persistent replica-set oplog and its capped size.
#[napi]
pub fn enable_oplog(store: &MongoStore, namespace: String, max_bytes: i64) -> Result<()> {
    store_of(store).enable_oplog(&namespace, max_bytes).map_err(|error| Error::new(Status::GenericFailure, error.to_string()))
}

/// Persists the entries a write command staged; returns the last `{t,i}` as
/// JSON, or `null` when nothing was staged.
#[napi]
pub fn commit_oplog(store: &MongoStore, wall_millis: i64) -> Result<Option<String>> {
    let last =
        store_of(store).commit_oplog(wall_millis).map_err(|error| Error::new(Status::GenericFailure, error.to_string()))?;
    Ok(last.map(|(t, i)| format!("{{\"t\":{t},\"i\":{i}}}")))
}

/// Drops entries a failed write command staged.
#[napi]
pub fn discard_oplog(store: &MongoStore) {
    store_of(store).discard_staged_oplog();
}

/// Imports a `mongodump` `.bson` document stream into one namespace.
#[napi]
pub fn import_bson(store: &MongoStore, namespace: String, bytes: Buffer) -> Result<u32> {
    mongo::import::import_bson_documents(store_of(store), &namespace, &bytes)
        .map(|count| count as u32)
        .map_err(|message| Error::new(Status::GenericFailure, message))
}

/// Imports a `mongodump` `.bson` file into one namespace.
#[napi]
pub fn import_bson_file(store: &MongoStore, namespace: String, path: String) -> Result<u32> {
    mongo::import::import_bson_file(store_of(store), &namespace, path)
        .map(|count| count as u32)
        .map_err(|message| Error::new(Status::GenericFailure, message))
}

/// Creates the empty shard a catalog names when only the catalog survived.
#[napi]
pub fn repair_shard(path: String) -> Result<String> {
    Store::repair_shard(path)
        .map(|report| report.to_json())
        .map_err(|error| Error::new(Status::GenericFailure, error.to_string()))
}

fn harness_error(error: impl std::fmt::Display) -> Error {
    Error::from_reason(error.to_string())
}

/// 对给定字节取 SHA-256，返回小写十六进制。
#[napi]
pub fn harness_digest(bytes: Buffer) -> String {
    Digest::of(bytes.as_ref()).to_hex()
}

/// 按已知差异台账判定一次语料运行。
#[napi]
pub fn harness_check_baseline(baseline_json: String, current_json: String, observed_json: String) -> Result<String> {
    let baseline: Baseline = serde_json::from_str(&baseline_json).map_err(harness_error)?;
    let current: BaselineIdentity = serde_json::from_str(&current_json).map_err(harness_error)?;
    let observed: Vec<DifferenceObservation> = serde_json::from_str(&observed_json).map_err(harness_error)?;
    let verdict = check_baseline(&baseline, &current, &observed);
    serde_json::to_string(&verdict).map_err(harness_error)
}

/// 将报告信封渲染为稳定 JSON 文本。
#[napi]
pub fn harness_render_report(report_json: String) -> Result<String> {
    let report: ReportEnvelope = serde_json::from_str(&report_json).map_err(harness_error)?;
    render_json(&report).map_err(harness_error)
}

/// 基准统计的 JS 形态。字段名由本 DTO 负责 camelCase，核心 `Stats` 说 Rust。
#[napi(object)]
pub struct BenchStats {
    pub median_ms: f64,
    pub p95_ms: f64,
    pub min_ms: f64,
    pub max_ms: f64,
    pub rounds: u32,
}

impl From<Stats> for BenchStats {
    fn from(stats: Stats) -> Self {
        Self {
            median_ms: stats.median_ms,
            p95_ms: stats.p95_ms,
            min_ms: stats.min_ms,
            max_ms: stats.max_ms,
            rounds: stats.rounds,
        }
    }
}

/// 对一组毫秒样本求 median/p95/极值（nearest-rank，与 TS 既有实现逐字节一致）。
#[napi]
pub fn harness_bench_summary(samples_ms: Vec<f64>) -> Result<BenchStats> {
    summarize(&samples_ms).map(Into::into).map_err(harness_error)
}

/// 单次操作的归一毫秒（median / ops）。`ops` 为 0 时返回 NaN。
#[napi]
pub fn harness_bench_per_op(stats: BenchStats, ops: u32) -> Result<f64> {
    per_op_ms(
        &Stats {
            median_ms: stats.median_ms,
            p95_ms: stats.p95_ms,
            min_ms: stats.min_ms,
            max_ms: stats.max_ms,
            rounds: stats.rounds,
        },
        u64::from(ops),
    )
    .map_err(harness_error)
}
