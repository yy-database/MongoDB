//! Node bindings: thin wrappers over the Rust primitives.
//!
//! No global state and no `start` entry: the host owns the socket loop, the
//! cursor table instance, and the CLI.

use std::sync::Arc;

use database::harness::{
    Baseline, BaselineIdentity, CompareMode, DifferenceObservation, Digest, Observed, ObservedBody, ReportEnvelope, Stats,
    TruthProvenance, check_baseline, compare, per_op_ms, render_json, summarize,
};
use mongo::{
    auth,
    authorization,
    bson::{BsonDocument, BsonValue},
    commands::{self, CommandError},
    cursor::CursorStore,
    json,
    replica,
    store::Store,
    wire::{self, decode_op_msg_command, decode_op_query_command, encode_op_msg_body},
    write_concern,
};
use napi::{
    Error, Result, Status,
    bindgen_prelude::{Buffer, FnArgs, Function},
};
use napi_derive::napi;

fn decode_command(text: &str) -> Result<BsonDocument> {
    json::document_from_json(text).map_err(|message| Error::new(Status::InvalidArg, message))
}

fn reply(document: &BsonDocument) -> String {
    json::document_to_json(document)
}

/// 解析一个 Extended JSON 值（数组、标量或文档）。
fn decode_value(text: &str) -> Result<BsonValue> {
    let value: serde_json::Value = serde_json::from_str(text).map_err(|error| Error::new(Status::InvalidArg, error.to_string()))?;
    json::from_json(&value).map_err(|message| Error::new(Status::InvalidArg, message))
}

/// 把 BSON 值渲染成规范 Extended JSON。
fn encode_value(value: &BsonValue) -> String {
    json::to_json(value).to_string()
}

/// 把命令原语返回的 `Result` 映射成 napi 错误。
fn policy_error(message: String) -> Error {
    Error::new(Status::GenericFailure, message)
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
pub fn get_more(store: &MongoStore, cursors: &mut MongoCursors, command: String) -> Result<String> {
    Ok(command_reply(commands::get_more(&decode_command(&command)?, store_of(store), &mut cursors.inner)))
}

/// `getMore` reply as an `OP_MSG` payload.
#[napi]
pub fn get_more_op_msg(store: &MongoStore, cursors: &mut MongoCursors, command: String) -> Result<Buffer> {
    Ok(command_op_msg(commands::get_more(&decode_command(&command)?, store_of(store), &mut cursors.inner)))
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

/// `findAndModify` reply as an `OP_MSG` payload.
#[napi]
pub fn find_and_modify_op_msg(store: &MongoStore, command: String) -> Result<CommandFrame> {
    Ok(command_frame(commands::find_and_modify(&decode_command(&command)?, store_of(store))))
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

/// `bulkWrite` reply as an `OP_MSG` payload.
#[napi]
pub fn bulk_write_op_msg(store: &MongoStore, command: String) -> Result<CommandFrame> {
    Ok(command_frame(commands::bulk_write(&decode_command(&command)?, store_of(store))))
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

/// 一侧已屏蔽服务端生成值的回复与它触发的屏蔽标记。
#[derive(Default)]
struct NormalizedReply {
    value: serde_json::Value,
    cursor: bool,
    uuid: bool,
    oid: bool,
    hash: bool,
    server_info: bool,
    timing: bool,
}

/// `cursorsKilled` 等字段承载服务端分配的光标 id。
const CURSOR_FIELDS: &[&str] = &["cursorsKilled", "cursorsNotFound", "cursorsAlive", "cursorsUnknown"];
/// `mongod` 自产的计划缓存标识，只比较结构。
const EXPLAIN_HASH_FIELDS: &[&str] = &["queryHash", "planCacheShapeHash", "planCacheKey", "queryShapeHash"];
/// 墙钟耗时在两次运行间变化，只比较结构。
const EXPLAIN_TIMING_FIELDS: &[&str] = &["executionTimeMillis", "executionTimeMillisEstimate", "optimizationTimeMillis"];

fn is_numeric_id(value: &serde_json::Value) -> bool {
    value.as_object().is_some_and(|object| {
        object.contains_key("$numberInt") || object.contains_key("$numberLong") || object.contains_key("$numberDouble")
    })
}

fn is_zero_id(value: &serde_json::Value) -> bool {
    if value.as_f64() == Some(0.0) {
        return true;
    }
    value.as_object().is_some_and(|object| {
        ["$numberInt", "$numberLong", "$numberDouble"].iter().any(|key| {
            object.get(*key).and_then(|inner| inner.as_str()).is_some_and(|text| text == "0" || text == "0.0")
        })
    })
}

fn is_hex(byte: u8) -> bool {
    byte.is_ascii_hexdigit()
}

/// 把字符串里的 UUID 与 `cursor id N not found` 换成模板占位。
fn mask_string(text: &str) -> (String, bool, bool) {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    let mut uuid = false;
    while index < bytes.len() {
        let remaining = &bytes[index..];
        let is_uuid = remaining.len() >= 36
            && (0..36).all(|offset| match offset {
                8 | 13 | 18 | 23 => remaining[offset] == b'-',
                _ => is_hex(remaining[offset]),
            });
        if is_uuid {
            out.extend_from_slice(b"<uuid>");
            uuid = true;
            index += 36;
            continue;
        }
        out.push(bytes[index]);
        index += 1;
    }
    let out = String::from_utf8(out).unwrap_or_else(|error| String::from_utf8_lossy(error.as_bytes()).into_owned());
    let mut cursor = false;
    let mut masked = String::with_capacity(out.len());
    let mut rest = out.as_str();
    while let Some(start) = rest.find("cursor id ") {
        let after = &rest[start + "cursor id ".len()..];
        let digits = after.bytes().take_while(u8::is_ascii_digit).count();
        if digits > 0 && after[digits..].starts_with(" not found") {
            masked.push_str(&rest[..start]);
            masked.push_str("cursor id <cursor> not found");
            cursor = true;
            rest = &after[digits + " not found".len()..];
            continue;
        }
        masked.push_str(&rest[..start + "cursor id ".len()]);
        rest = after;
    }
    masked.push_str(rest);
    (masked, uuid, cursor)
}

fn normalize_reply(reply: &serde_json::Value) -> NormalizedReply {
    let mut normalized = NormalizedReply { value: serde_json::Value::Null, ..NormalizedReply::default() };
    normalized.value = walk_reply(reply, None, &mut normalized);
    normalized
}

fn walk_reply(node: &serde_json::Value, parent: Option<&str>, flags: &mut NormalizedReply) -> serde_json::Value {
    if parent.is_some_and(|key| CURSOR_FIELDS.contains(&key)) && is_numeric_id(node) {
        flags.cursor = true;
        return serde_json::Value::String("<cursor>".into());
    }
    if let Some(items) = node.as_array() {
        return serde_json::Value::Array(items.iter().map(|item| walk_reply(item, parent, flags)).collect());
    }
    if let Some(object) = node.as_object() {
        let mut out = serde_json::Map::new();
        for (key, value) in object {
            if parent == Some("cursor") && key == "id" && !is_zero_id(value) && is_numeric_id(value) {
                flags.cursor = true;
                out.insert(key.clone(), serde_json::Value::String("<cursor>".into()));
                continue;
            }
            if key == "$oid" {
                flags.oid = true;
                out.insert(key.clone(), serde_json::Value::String("<oid>".into()));
                continue;
            }
            if key == "uuid" && value.as_object().is_some_and(|inner| inner.contains_key("$binary")) {
                flags.uuid = true;
                out.insert(key.clone(), serde_json::Value::String("<uuid>".into()));
                continue;
            }
            if EXPLAIN_HASH_FIELDS.contains(&key.as_str()) && value.is_string() {
                flags.hash = true;
                out.insert(key.clone(), serde_json::Value::String("<hash>".into()));
                continue;
            }
            if EXPLAIN_TIMING_FIELDS.contains(&key.as_str())
                && value.as_object().is_some_and(|inner| inner.contains_key("$numberInt"))
            {
                flags.timing = true;
                out.insert(key.clone(), serde_json::Value::String("<millis>".into()));
                continue;
            }
            if parent == Some("serverInfo") && (key == "host" || key == "port") {
                flags.server_info = true;
                out.insert(key.clone(), serde_json::Value::String(if key == "host" { "<host>" } else { "<port>" }.into()));
                continue;
            }
            out.insert(key.clone(), walk_reply(value, Some(key), flags));
        }
        return serde_json::Value::Object(out);
    }
    if let Some(text) = node.as_str() {
        let (masked, uuid, cursor) = mask_string(text);
        flags.uuid |= uuid;
        flags.cursor |= cursor;
        return serde_json::Value::String(masked);
    }
    node.clone()
}

/// `ok` 的和式数字在语义比较里按数值处理，其余字段递归。
fn semantic(value: &serde_json::Value) -> serde_json::Value {
    if let Some(items) = value.as_array() {
        return serde_json::Value::Array(items.iter().map(semantic).collect());
    }
    if let Some(object) = value.as_object() {
        let mut out = serde_json::Map::new();
        for (key, item) in object {
            out.insert(key.clone(), if key == "ok" { numeric_value(item) } else { semantic(item) });
        }
        return serde_json::Value::Object(out);
    }
    value.clone()
}

fn numeric_value(value: &serde_json::Value) -> serde_json::Value {
    let Some(object) = value.as_object()
    else {
        return value.clone();
    };
    for (key, parsed) in [("$numberInt", 0), ("$numberLong", 1), ("$numberDouble", 2)] {
        if let Some(text) = object.get(key).and_then(|inner| inner.as_str()) {
            let number = match parsed {
                0 | 1 => text.parse::<i64>().ok().map(|number| number as f64).or_else(|| text.parse::<f64>().ok()),
                _ => text.parse::<f64>().ok(),
            };
            if let Some(number) = number {
                return serde_json::Number::from_f64(number).map(serde_json::Value::Number).unwrap_or(serde_json::Value::Null);
            }
        }
    }
    value.clone()
}

fn js_number(number: &serde_json::Number) -> String {
    if let Some(integer) = number.as_i64() {
        return integer.to_string();
    }
    if let Some(integer) = number.as_u64() {
        return integer.to_string();
    }
    let float = number.as_f64().unwrap_or_default();
    if float == 0.0 {
        return "0".to_owned();
    }
    if float.fract() == 0.0 && float.abs() < 1e21 {
        return format!("{float:.0}");
    }
    number.to_string()
}

/// JavaScript `stable`：对象键排序、数组保序、数字按 JS 文本。
fn stable(value: &serde_json::Value, out: &mut String) {
    match value {
        serde_json::Value::Null => out.push_str("null"),
        serde_json::Value::Bool(value) => out.push_str(if *value { "true" } else { "false" }),
        serde_json::Value::Number(number) => out.push_str(&js_number(number)),
        serde_json::Value::String(text) => out.push_str(&serde_json::to_string(text).unwrap_or_else(|_| "\"\"".into())),
        serde_json::Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                stable(item, out);
            }
            out.push(']');
        }
        serde_json::Value::Object(object) => {
            let mut keys = object.keys().collect::<Vec<&String>>();
            keys.sort();
            out.push('{');
            for (index, key) in keys.into_iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(key).unwrap_or_else(|_| "\"\"".into()));
                out.push(':');
                stable(&object[key], out);
            }
            out.push('}');
        }
    }
}

fn stable_text(value: &serde_json::Value) -> String {
    let mut out = String::new();
    stable(value, &mut out);
    out
}

fn observed(bytes: &[u8], provenance: Option<TruthProvenance>) -> Observed {
    Observed { provenance, body: ObservedBody::Wire { bytes: bytes.to_vec() } }
}

fn replies_match(oracle: &serde_json::Value, local: &serde_json::Value) -> serde_json::Value {
    let oracle = normalize_reply(oracle);
    let local = normalize_reply(local);
    let oracle_bytes = stable_text(&semantic(&oracle.value)).into_bytes();
    let local_bytes = stable_text(&semantic(&local.value)).into_bytes();
    let verdict = compare(
        &observed(&oracle_bytes, Some(TruthProvenance::ExternalEngine { id: "mongod".into(), version: "oracle".into() })),
        &observed(&local_bytes, None),
        &CompareMode::WireHex,
    );
    serde_json::json!({
        "match": verdict.matched,
        "sameOrder": serde_json::to_string(&oracle.value).ok() == serde_json::to_string(&local.value).ok(),
        "flags": {
            "cursor": oracle.cursor || local.cursor,
            "uuid": oracle.uuid || local.uuid,
            "oid": oracle.oid || local.oid,
            "hash": oracle.hash || local.hash,
            "serverInfo": oracle.server_info || local.server_info,
            "timing": oracle.timing || local.timing,
        },
        "oracle": oracle.value,
        "local": local.value,
    })
}

/// 把一侧回复的 `ok` 编码形态归类，供步骤证据使用。
fn ok_encoding(reply: &serde_json::Value) -> &'static str {
    match reply.as_object().and_then(|object| object.get("ok")) {
        None => "none",
        Some(serde_json::Value::Object(object)) => {
            if object.contains_key("$numberInt") {
                "int32"
            }
            else if object.contains_key("$numberLong") {
                "int64"
            }
            else if object.contains_key("$numberDouble") {
                "double"
            }
            else {
                "other"
            }
        }
        Some(serde_json::Value::Bool(_)) => "boolean",
        Some(serde_json::Value::Number(_)) => "number",
        Some(serde_json::Value::String(_)) => "string",
        Some(_) => "other",
    }
}

/// 屏蔽一侧回复里的服务端生成值并返回模板与命中标记。
#[napi]
pub fn harness_normalize_reply(reply_json: String) -> Result<String> {
    let reply: serde_json::Value = serde_json::from_str(&reply_json).map_err(harness_error)?;
    let normalized = normalize_reply(&reply);
    serde_json::to_string(&serde_json::json!({
        "value": normalized.value,
        "flags": {
            "cursor": normalized.cursor,
            "uuid": normalized.uuid,
            "oid": normalized.oid,
            "hash": normalized.hash,
            "serverInfo": normalized.server_info,
            "timing": normalized.timing,
        },
    }))
    .map_err(harness_error)
}

/// 比较一轮 oracle 与本地回复，比较判定交给 `database.harness`。
#[napi]
pub fn harness_replies_match(oracle_json: String, local_json: String) -> Result<String> {
    let oracle: serde_json::Value = serde_json::from_str(&oracle_json).map_err(harness_error)?;
    let local: serde_json::Value = serde_json::from_str(&local_json).map_err(harness_error)?;
    serde_json::to_string(&replies_match(&oracle, &local)).map_err(harness_error)
}

/// 逐步骤比较并汇总门禁可用性；`steps` 只需 `op` 与是否引用先前光标。
#[napi]
pub fn harness_classify_steps(
    steps_json: String,
    oracle_json: String,
    local_json: String,
    gateable: bool,
) -> Result<String> {
    #[derive(serde::Deserialize)]
    struct Step {
        op: String,
        #[serde(default, rename = "cursorFrom")]
        cursor_from: Option<serde_json::Value>,
    }
    let steps: Vec<Step> = serde_json::from_str(&steps_json).map_err(harness_error)?;
    let oracle: Vec<serde_json::Value> = serde_json::from_str(&oracle_json).map_err(harness_error)?;
    let local: Vec<serde_json::Value> = serde_json::from_str(&local_json).map_err(harness_error)?;
    let mut matched = true;
    let mut gateable = gateable;
    let mut results = Vec::new();
    for (index, step) in steps.iter().enumerate() {
        if step.op == "killCursors" || (step.op == "getMore" && step.cursor_from.is_some()) {
            gateable = false;
        }
        let (Some(oracle_reply), Some(local_reply)) = (oracle.get(index), local.get(index))
        else {
            return Err(harness_error("回复数量少于步骤数量"));
        };
        let comparison = replies_match(oracle_reply, local_reply);
        let step_matched = comparison["match"].as_bool().unwrap_or(false);
        let flags = &comparison["flags"];
        if ["cursor", "uuid", "oid", "hash", "serverInfo", "timing"]
            .iter()
            .any(|flag| flags[*flag].as_bool().unwrap_or(false))
        {
            gateable = false;
        }
        if !step_matched {
            matched = false;
        }
        results.push(serde_json::json!({
            "index": index,
            "match": step_matched,
            "sameOrder": comparison["sameOrder"],
            "oracle": comparison["oracle"],
            "local": comparison["local"],
            "okSame": ok_encoding(oracle_reply) == ok_encoding(local_reply),
            "flags": comparison["flags"],
        }));
    }
    serde_json::to_string(&serde_json::json!({
        "matched": matched,
        "gateable": matched && gateable,
        "steps": results,
    }))
    .map_err(harness_error)
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

// ---------------------------------------------------------------------------
// 授权判定、副本集状态与 writeConcern 语义
//
// 这些领域规则都在 `mongo` 库里，绑定只做 JSON 形态转换：入参是 Extended JSON
// 文本，出参是可直接写回线的应答片段。
// ---------------------------------------------------------------------------

/// 从 JSON 文本读出角色列表。
fn roles_of(text: &str) -> Result<Vec<authorization::RoleRef>> {
    let value = decode_value(text)?;
    Ok(authorization::roles_from_value(Some(&value)))
}

/// 从 JSON 文本读出权限列表。
fn privileges_of(text: &str) -> Result<Vec<authorization::Privilege>> {
    let value = decode_value(text)?;
    Ok(authorization::privileges_from_value(Some(&value)))
}

/// 命令授权判定：允许时返回 `null`，否则返回 `Unauthorized` 应答。
#[napi]
pub fn authorization_authorize(store: &MongoStore, roles: String, command: String) -> Result<Option<String>> {
    let roles = roles_of(&roles)?;
    let command = decode_command(&command)?;
    let resolver = authorization::StoreRoleResolver::new(store_of(store));
    Ok(authorization::authorize_command(&roles, &command, &resolver).map(|document| reply(&document)))
}

/// 展开角色集合：`{ privileges, inheritedRoles, authenticationRestrictions }`。
#[napi]
pub fn authorization_expand_roles(store: &MongoStore, roles: String) -> Result<String> {
    let roles = roles_of(&roles)?;
    let resolver = authorization::StoreRoleResolver::new(store_of(store));
    let expansion = authorization::expand_roles(&roles, &resolver);
    let mut document = BsonDocument::new();
    document.push("privileges".to_string(), authorization::privileges_to_value(&expansion.privileges));
    document.push("inheritedRoles".to_string(), authorization::roles_to_value(&expansion.inherited_roles));
    document.push("authenticationRestrictions".to_string(), BsonValue::Array(expansion.authentication_restrictions));
    Ok(reply(&document))
}

/// 角色集合展开后的权限数组。
#[napi]
pub fn authorization_privileges_for_roles(store: &MongoStore, roles: String) -> Result<String> {
    let roles = roles_of(&roles)?;
    let resolver = authorization::StoreRoleResolver::new(store_of(store));
    Ok(encode_value(&authorization::privileges_to_value(&authorization::privileges_for_roles(&roles, &resolver))))
}

/// 合并重复资源并按 `mongod` 规范顺序排列动作。
#[napi]
pub fn authorization_normalize_privileges(privileges: String) -> Result<String> {
    let privileges = privileges_of(&privileges)?;
    Ok(encode_value(&authorization::privileges_to_value(&authorization::normalize_privileges(&privileges))))
}

/// `role@db` 是否内置角色。
#[napi]
pub fn authorization_builtin_role_exists(role: String, db: String) -> bool {
    authorization::builtin_role_exists(&role, &db)
}

/// 全部内置角色名。
#[napi]
pub fn authorization_builtin_role_names() -> Vec<String> {
    authorization::builtin_role_names()
}

/// `action` 是否是 `mongod` 接受的 action 名。
#[napi]
pub fn authorization_valid_action(action: String) -> bool {
    authorization::is_valid_action(&action)
}

/// `role@db` 是否存在（内置或 `<db>.system.roles` 里）。
#[napi]
pub fn authorization_role_exists(store: &MongoStore, role: String, db: String) -> bool {
    if authorization::builtin_role_exists(&role, &db) {
        return true;
    }
    let resolver = authorization::StoreRoleResolver::new(store_of(store));
    authorization::RoleResolver::resolve(&resolver, &role, &db).is_some()
}

/// `listDatabases` 的可见范围：`null` 表示全部可见，否则是允许看到的库名。
#[napi]
pub fn authorization_database_scope(store: &MongoStore, roles: String, databases: String) -> Result<Option<Vec<String>>> {
    let roles = roles_of(&roles)?;
    let databases = match decode_value(&databases)? {
        BsonValue::Array(entries) => entries
            .iter()
            .filter_map(|entry| match entry {
                BsonValue::String(name) => Some(name.clone()),
                _ => None,
            })
            .collect::<Vec<_>>(),
        _ => Vec::new(),
    };
    let resolver = authorization::StoreRoleResolver::new(store_of(store));
    Ok(authorization::database_scope(&roles, &databases, &resolver))
}

/// 该命令的应答是否经 `writeConcern` 确认。
#[napi]
pub fn write_concern_command(name: String) -> bool {
    write_concern::is_write_concern_command(&name)
}

/// `writeConcern` 判定：`{ unacknowledged, error, writeConcernError }`。
#[napi]
pub fn write_concern_decision(command: String, replica_set_name: Option<String>) -> Result<String> {
    let command = decode_command(&command)?;
    let decision = write_concern::evaluate_write_concern(&command, replica_set_name.as_deref());
    let mut document = BsonDocument::new();
    document.push("unacknowledged".to_string(), BsonValue::Bool(decision.unacknowledged));
    document.push(
        "error".to_string(),
        match &decision.error {
            Some(error) => BsonValue::Document(commands::error_document(error)),
            None => BsonValue::Null,
        },
    );
    document.push("writeConcernError".to_string(), decision.write_concern_error.clone().unwrap_or(BsonValue::Null));
    Ok(reply(&document))
}

/// `$readPreference` 校验：合法返回 `null`，否则返回错误应答。
#[napi]
pub fn read_preference_error(command: String) -> Result<Option<String>> {
    let command = decode_command(&command)?;
    Ok(write_concern::read_preference_error(&command).map(|error| reply(&commands::error_document(&error))))
}

/// 按 `mongod` 的字段顺序重写成功的写应答。
#[napi]
pub fn write_concern_reply(
    name: String,
    body: String,
    decision: Option<String>,
    stamps: Option<String>,
    ok: bool,
) -> Result<String> {
    let body = decode_command(&body)?;
    let stamps = match stamps {
        Some(text) => Some(decode_command(&text)?),
        None => None,
    };
    let decision = match decision {
        Some(text) => {
            let document = decode_command(&text)?;
            let unacknowledged = matches!(document.get("unacknowledged"), Some(BsonValue::Bool(true)));
            let write_concern_error = match document.get("writeConcernError") {
                Some(BsonValue::Null) | None => None,
                Some(value) => Some(value.clone()),
            };
            Some(write_concern::WriteConcernDecision { unacknowledged, error: None, write_concern_error })
        }
        None => None,
    };
    let reply_document = write_concern::write_concern_reply(&name, &body, decision.as_ref(), stamps.as_ref(), ok);
    Ok(reply(&reply_document))
}

/// `commitTransaction` / `abortTransaction` 的参数校验。
#[napi]
pub fn transaction_command_error(name: String, command: String) -> Result<Option<String>> {
    let command = decode_command(&command)?;
    Ok(commands::transaction_command_error(&name, &command).map(|error| reply(&commands::error_document(&error))))
}

/// 单成员副本集状态。
#[napi]
pub struct MongoReplicaSet {
    inner: replica::ReplicaSet,
}

#[napi]
impl MongoReplicaSet {
    /// 创建一个副本集状态；`name` 为空表示单机。
    #[napi(constructor)]
    pub fn new(name: Option<String>) -> Result<Self> {
        let inner = replica::ReplicaSet::new(name).map_err(policy_error)?;
        Ok(Self { inner })
    }

    /// `--replSet` 名字。
    #[napi(getter)]
    pub fn name(&self) -> Option<String> {
        self.inner.name().map(str::to_string)
    }

    /// 应答是否携带 `$clusterTime`。
    #[napi(getter)]
    pub fn stamping(&self) -> bool {
        self.inner.replies_are_stamped()
    }

    /// 按接受顺序分配连接标识。
    #[napi]
    pub fn next_connection_id(&mut self) -> u32 {
        self.inner.next_connection_id()
    }

    /// 记录一次写入；`optime` 是 `{"t":…,"i":…}` 或 `null`。
    #[napi]
    pub fn note_write(&mut self, optime: Option<String>) -> Result<()> {
        let optime = match optime {
            Some(text) => {
                let document = decode_command(&text)?;
                let t = document.get("t").map(|value| match value {
                    BsonValue::Int32(number) => *number as u32,
                    BsonValue::Int64(number) => *number as u32,
                    _ => 0,
                });
                let i = document.get("i").map(|value| match value {
                    BsonValue::Int32(number) => *number as u32,
                    BsonValue::Int64(number) => *number as u32,
                    _ => 0,
                });
                Some((t.unwrap_or(0), i.unwrap_or(0)))
            }
            None => None,
        };
        self.inner.note_write(optime);
        Ok(())
    }

    /// 追加 `$clusterTime` 与 `operationTime`。
    #[napi]
    pub fn stamp_reply(&mut self, command: String, body: String) -> Result<String> {
        let command = decode_command(&command)?;
        let body = decode_command(&body)?;
        Ok(reply(&self.inner.stamp_reply(&command, &body)))
    }

    /// 写应答的 `electionId` 与 `opTime`；未初始化返回 `null`。
    #[napi]
    pub fn write_stamps(&self) -> Option<String> {
        self.inner.write_stamps().map(|document| reply(&document))
    }

    /// `hello` / `isMaster` 的拓扑字段。
    #[napi]
    pub fn handshake(&self, command: String) -> String {
        reply(&self.inner.topology_handshake(&command))
    }

    /// `replSetInitiate` / `replSetGetConfig` / `replSetGetStatus`。
    #[napi]
    pub fn command(&mut self, name: String, command: String, me: String) -> Result<String> {
        let command = decode_command(&command)?;
        self.inner.command(&name, &command, &me).map(|document| reply(&document)).map_err(policy_error)
    }

    /// 当前集合配置。
    #[napi]
    pub fn config(&self) -> Option<String> {
        self.inner.config().map(reply)
    }

    /// 从 `local.system.replset` 恢复集合配置。
    #[napi]
    pub fn restore_config(&mut self, stored: String) -> Result<bool> {
        let stored = decode_command(&stored)?;
        self.inner.restore_config(&stored).map_err(policy_error)
    }
}

/// 一条重试写命令的登记身份：登记键文本与实际语句号。
#[napi(object)]
pub struct RetryKey {
    /// 登记表使用的键文本。
    pub key: String,
    /// 缺失 `stmtId` 时为 `0`。
    pub stmt_id: i64,
}

/// 一条重试写命令的登记键；不可重试或没有 `txnNumber` 时返回 `null`。
#[napi]
pub fn retry_key(name: String, command: String) -> Result<Option<RetryKey>> {
    let command = decode_command(&command)?;
    Ok(mongo::retry::retry_key(&name, &command).map(|key| RetryKey { key: key.text().to_string(), stmt_id: key.stmt_id() }))
}

/// 已落定写应答的登记表；宿主自己持有实例。
#[napi]
pub struct MongoRetryRegistry {
    inner: mongo::retry::RetryRegistry,
}

#[napi]
impl MongoRetryRegistry {
    /// 空登记表。
    #[napi(constructor)]
    pub fn new() -> Self {
        Self { inner: mongo::retry::RetryRegistry::new() }
    }

    /// 取一条未过期的已落定应答，返回带 `retriedStmtIds` 的 Extended JSON。
    #[napi]
    pub fn get(&mut self, key: String, stmt_id: i64, now_ms: i64) -> Option<String> {
        self.inner.get(&key, now_ms).map(|stored| reply(&mongo::retry::replayed_reply(&stored, stmt_id)))
    }

    /// 记下一次成功的写应答。
    #[napi]
    pub fn store(&mut self, key: String, reply: String, now_ms: i64) -> Result<()> {
        let stored = decode_command(&reply)?;
        self.inner.store(&key, &stored, now_ms);
        Ok(())
    }

    /// 当前条目数。
    #[napi(getter)]
    pub fn len(&self) -> u32 {
        self.inner.len() as u32
    }
}

/// 一次写命令落定后的 oplog 提交或丢弃，并推进副本集 optime。
///
/// 返回最后一条 oplog 条目的 `{t,i}`，没有提交任何条目时为 `null`。
#[napi]
pub fn settle_write(store: &MongoStore, replica: &mut MongoReplicaSet, name: String, ok: bool, wall_millis: i64) -> Result<Option<String>> {
    let last = mongo::replica::settle_write(store_of(store), &mut replica.inner, &name, ok, wall_millis)
        .map_err(|error| policy_error(error.to_string()))?;
    Ok(last.map(|(t, i)| format!("{{\"t\":{t},\"i\":{i}}}")))
}

/// 从 `local.system.replset` 读回集合配置并恢复到 `replica`。
#[napi]
pub fn restore_replica_config(store: &MongoStore, replica: &mut MongoReplicaSet) -> Result<bool> {
    mongo::replica::restore_stored_config(store_of(store), &mut replica.inner).map_err(|error| policy_error(error.to_string()))
}

/// 把当前集合配置写进 `local.system.replset`。
#[napi]
pub fn persist_replica_config(store: &MongoStore, replica: &MongoReplicaSet) -> Result<bool> {
    mongo::replica::persist_config(store_of(store), &replica.inner).map_err(|error| policy_error(error.to_string()))
}

// ---------------------------------------------------------------------------
// 帧原语：组帧、封套展开与压缩器分派唯一归 `protocol.mongo`
// ---------------------------------------------------------------------------

/// 16 字节帧头的字段。
#[napi(object)]
pub struct WireFrameHeader {
    /// 整帧长度，含 4 字节长度前缀自身。
    pub total_length: u32,
    /// 请求标识。
    pub request_id: i32,
    /// 应答对象标识。
    pub response_to: i32,
    /// 线协议操作码。
    pub opcode: i32,
}

/// 一条完成展开的入站帧；`OP_COMPRESSED` 已解封套并按 id 分派解压。
#[napi(object)]
pub struct InboundWireFrame {
    /// 帧头声明的整帧长度，已验证与实际字节数一致。
    pub total_length: u32,
    /// 服务端需要应答的操作码；压缩帧展开后为 OP_MSG。
    pub opcode: i32,
    /// 帧头里的请求标识。
    pub request_id: i32,
    /// 帧头里的应答对象标识。
    pub response_to: i32,
    /// 解压后的载荷；OP_MSG 时为 flags 加 sections。
    pub payload: Buffer,
    /// 压缩帧的压缩器 id；未压缩帧为 `null`。
    pub compressor_id: Option<u32>,
    /// 压缩帧封套声明的被包裹操作码。
    pub original_opcode: Option<i32>,
    /// 压缩帧封套声明的解压后字节数。
    pub uncompressed_size: Option<i32>,
}

fn frame_error(error: wire::FrameError) -> Error {
    Error::new(Status::InvalidArg, format!("mongo frame rejected: {error:?}"))
}

/// 只读帧头；不足 16 字节返回 `null`。
#[napi]
pub fn wire_peek_header(frame: Buffer) -> Option<WireFrameHeader> {
    wire::peek_header(&frame).map(|header| WireFrameHeader {
        total_length: header.total_length,
        request_id: header.request_id,
        response_to: header.response_to,
        opcode: header.opcode,
    })
}

/// 展开一条完整帧。Snappy 与 Zstd 走 `boost.data.compression`；
/// Zlib 由宿主回调提供（如 `node:zlib`）。
#[napi]
pub fn wire_decode_frame(
    frame: Buffer,
    max_frame_size: Option<u32>,
    mut zlib_decompress: Option<Function<FnArgs<(Buffer, u32)>, Buffer>>,
) -> Result<InboundWireFrame> {
    let limits = wire::FrameLimits { max_frame_size: max_frame_size.unwrap_or(48 * 1024 * 1024) };
    let mut decompress = |compressed: &[u8], announced: usize| -> std::result::Result<Vec<u8>, String> {
        let Some(callback) = &mut zlib_decompress else {
            return Err("host provides no zlib decompressor".to_string());
        };
        match callback.call(FnArgs { data: (Buffer::from(compressed), announced as u32) }) {
            Ok(output) => Ok(output.to_vec()),
            Err(error) => Err(error.reason),
        }
    };
    let inbound = wire::decode_frame(&frame, limits, &mut decompress).map_err(frame_error)?;
    Ok(InboundWireFrame {
        total_length: inbound.header.total_length,
        opcode: inbound.opcode,
        request_id: inbound.header.request_id,
        response_to: inbound.header.response_to,
        payload: Buffer::from(inbound.payload),
        compressor_id: inbound.envelope.map(|envelope| u32::from(envelope.compressor_id)),
        original_opcode: inbound.envelope.map(|envelope| envelope.original_opcode),
        uncompressed_size: inbound.envelope.map(|envelope| envelope.uncompressed_size),
    })
}

/// 组一条 OP_MSG 帧：16 字节头加原始 body。
#[napi]
pub fn wire_encode_msg_frame(request_id: i32, response_to: i32, body: Buffer) -> Buffer {
    Buffer::from(wire::encode_msg_frame(request_id, response_to, &body))
}

/// 组一条 `OP_COMPRESSED` 帧。
#[napi]
pub fn wire_encode_compressed_frame(
    request_id: i32,
    response_to: i32,
    compressor_id: u32,
    uncompressed_size: i32,
    compressed: Buffer,
) -> Buffer {
    Buffer::from(wire::encode_compressed_frame(request_id, response_to, compressor_id as u8, uncompressed_size, &compressed))
}

/// 组一条遗留 OP_REPLY 帧。
#[napi]
pub fn wire_encode_reply_frame(request_id: i32, response_to: i32, document: Buffer) -> Buffer {
    Buffer::from(wire::encode_reply_frame(request_id, response_to, &document))
}

// ---------------------------------------------------------------------------
// Snappy：`OP_COMPRESSED` 的 block 编解码唯一归 `boost.data.compression`
// ---------------------------------------------------------------------------

fn compression_error(error: impl std::fmt::Debug) -> Error {
    Error::new(Status::InvalidArg, format!("snappy codec rejected the input: {error:?}"))
}

/// 压缩为 snappy block 格式。
#[napi]
pub fn snappy_compress(input: Buffer) -> Buffer {
    Buffer::from(data_compression::snappy::encode(&input))
}

/// 解压 snappy block 格式；`expected_size` 来自帧封套，产出必须精确一致。
#[napi]
pub fn snappy_decompress(input: Buffer, expected_size: u32) -> Result<Buffer> {
    data_compression::snappy::decode(&input, usize::try_from(expected_size).unwrap_or(usize::MAX))
        .map(Buffer::from)
        .map_err(compression_error)
}

// ---------------------------------------------------------------------------
// 认证：SCRAM 状态机与用户、角色命令唯一归 `execution::mongo::auth`
// ---------------------------------------------------------------------------

/// 单连接的认证状态：已认证用户、角色与进行中的 SASL 会话。
#[napi]
pub struct MongoAuthState {
    pub(crate) inner: auth::AuthState,
}

#[napi]
impl MongoAuthState {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self { inner: auth::AuthState::new() }
    }

    /// 是否已有认证用户（`mongod --auth` 门禁判断）。
    #[napi]
    pub fn has_users(&self) -> bool {
        !self.inner.users.is_empty()
    }

    /// 已认证用户，Extended JSON 数组 `[{user, db}]`（`connectionStatus` 用）。
    #[napi]
    pub fn users_json(&self) -> String {
        serde_json::to_string(
            &self
                .inner
                .users
                .iter()
                .map(|identity| serde_json::json!({ "user": &identity.user, "db": &identity.db }))
                .collect::<Vec<_>>(),
        )
        .unwrap_or_else(|_| "[]".to_string())
    }

    /// 生效角色，Extended JSON 数组 `[{role, db}]`（授权判定与 `connectionStatus` 用）。
    #[napi]
    pub fn roles_json(&self) -> String {
        serde_json::to_string(
            &self
                .inner
                .roles
                .iter()
                .map(|role| serde_json::json!({ "role": &role.role, "db": &role.db }))
                .collect::<Vec<_>>(),
        )
        .unwrap_or_else(|_| "[]".to_string())
    }
}

impl Default for MongoAuthState {
    fn default() -> Self {
        Self::new()
    }
}

fn auth_session<'a>(
    store: &'a MongoStore,
    cursors: &'a mut MongoCursors,
    state: &'a mut MongoAuthState,
    entropy: &'a mut auth::SystemEntropy,
) -> auth::AuthSession<'a> {
    auth::AuthSession::new(store_of(store), &mut cursors.inner, &mut state.inner, entropy)
}

/// 逐个包装认证命令原语：入参与应答都是 Extended JSON。
macro_rules! auth_command {
    ($name:ident, $function:ident) => {
        #[napi]
        pub fn $name(
            store: &MongoStore,
            cursors: &mut MongoCursors,
            auth_state: &mut MongoAuthState,
            command: String,
        ) -> Result<String> {
            let command = decode_command(&command)?;
            let mut entropy = auth::SystemEntropy::new();
            let mut session = auth_session(store, cursors, auth_state, &mut entropy);
            Ok(reply(&auth::$function(&mut session, &command)))
        }
    };
}

auth_command!(auth_create_user, create_user);
auth_command!(auth_drop_user, drop_user);
auth_command!(auth_create_role, create_role);
auth_command!(auth_drop_role, drop_role);
auth_command!(auth_users_info, users_info);
auth_command!(auth_sasl_start, sasl_start);
auth_command!(auth_sasl_continue, sasl_continue);

/// `logout` 清空本连接的认证状态。
#[napi]
pub fn auth_logout(store: &MongoStore, cursors: &mut MongoCursors, auth_state: &mut MongoAuthState) -> String {
    let mut entropy = auth::SystemEntropy::new();
    let mut session = auth_session(store, cursors, auth_state, &mut entropy);
    reply(&auth::logout(&mut session))
}

/// `saslSupportedMechs` 的应答面：`null`、`{mechanisms}` 或 `{error}`。
#[napi]
pub fn auth_sasl_supported_mechs(
    store: &MongoStore,
    cursors: &mut MongoCursors,
    auth_state: &mut MongoAuthState,
    spec: String,
) -> Result<String> {
    let value = decode_value(&spec)?;
    let mut entropy = auth::SystemEntropy::new();
    let mut session = auth_session(store, cursors, auth_state, &mut entropy);
    Ok(match auth::sasl_supported_mechs(&mut session, &value) {
        auth::SupportedMechs::None => "null".to_string(),
        auth::SupportedMechs::Mechanisms(mechanisms) => serde_json::json!({ "mechanisms": mechanisms }).to_string(),
        auth::SupportedMechs::Error(error) => {
            let document: serde_json::Value = serde_json::from_str(&reply(&error)).unwrap_or(serde_json::Value::Null);
            serde_json::json!({ "error": document }).to_string()
        }
    })
}

/// 库中是否已有任何用户（localhost exception 判定）。
#[napi]
pub fn auth_any_user_exists(store: &MongoStore) -> bool {
    auth::any_user_exists(store_of(store))
}

/// 认证前放行的命令名。
#[napi]
pub fn auth_allowed_before_auth(name: String) -> bool {
    auth::allowed_before_auth(&name)
}

/// 未认证执行命令时的 `13 Unauthorized` 应答，Extended JSON。
#[napi]
pub fn auth_authentication_required(name: String) -> String {
    reply(&auth::authentication_required(&name))
}

// ---------------------------------------------------------------------------
// 远程会话帧队列：拼帧、请求标识与 pending 配对唯一归 `database.client`
// ---------------------------------------------------------------------------

use database_client::mongo::session::{MongoWireSession as ClientWireSession, SessionError, WireEvent};

fn session_error(error: SessionError) -> Error {
    Error::new(Status::InvalidArg, error.to_string())
}

/// 一次会话事件的传输形态。
#[napi(object)]
pub struct WireEventDto {
    /// `response` 或 `abandoned`。
    pub kind: String,
    /// `response` 事件：原请求的 `requestId`。
    pub request_id: Option<i32>,
    /// `response` 事件：完整应答帧字节。
    pub frame: Option<Buffer>,
    /// `abandoned` 事件：被清算的请求 `requestId` 列表。
    pub request_ids: Option<Vec<i32>>,
    /// `abandoned` 事件：中断原因。
    pub reason: Option<String>,
}

fn event_dto(event: WireEvent) -> WireEventDto {
    match event {
        WireEvent::Response { request_id, frame } => {
            WireEventDto { kind: "response".to_string(), request_id: Some(request_id), frame: Some(Buffer::from(frame)), request_ids: None, reason: None }
        }
        WireEvent::Abandoned { request_ids, reason } => {
            WireEventDto { kind: "abandoned".to_string(), request_id: None, frame: None, request_ids: Some(request_ids), reason: Some(reason) }
        }
    }
}

/// 单连接的客户端帧会话：宿主喂字节、写回帧，本类型拥有配对规则。
#[napi(js_name = "MongoWireSession")]
pub struct NapiWireSession {
    inner: ClientWireSession,
}

#[napi]
impl NapiWireSession {
    #[napi(constructor)]
    pub fn new(max_frame_size: Option<i64>) -> Self {
        Self {
            inner: max_frame_size.map_or_else(ClientWireSession::new, ClientWireSession::with_max_frame_size),
        }
    }

    /// 登记一条请求并返回写往 socket 的完整帧字节。
    #[napi]
    pub fn begin_request(&mut self, body: Buffer, more_to_come: Option<bool>) -> Result<Buffer> {
        self.inner.begin_request(&body, more_to_come.unwrap_or(false)).map(Buffer::from).map_err(session_error)
    }

    /// 喂入收到的字节，返回本次凑齐的应答帧与中断事件。
    #[napi]
    pub fn push_bytes(&mut self, chunk: Buffer) -> Vec<WireEventDto> {
        self.inner.push_bytes(&chunk).into_iter().map(event_dto).collect()
    }

    /// socket 错误 / 关闭：清算 pending 并中断会话。
    #[napi]
    pub fn fail_all(&mut self, reason: String) -> Option<WireEventDto> {
        self.inner.fail_all(&reason).map(event_dto)
    }

    /// `hello` 握手是否已完成。
    #[napi]
    pub fn is_handshaked(&self) -> bool {
        self.inner.is_handshaked()
    }

    /// 会话是否仍可发请求。
    #[napi]
    pub fn is_live(&self) -> bool {
        self.inner.is_live()
    }
}
