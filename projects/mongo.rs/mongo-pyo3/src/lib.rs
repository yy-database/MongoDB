//! Python bindings: thin wrappers over the Rust primitives.
//!
//! The Python host owns the socket loop, the cursor table instance, and the CLI.

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
use pyo3::{
    exceptions::PyValueError,
    prelude::*,
    types::{PyBytes, PyDict, PyModule},
};

fn decode_command(text: &str) -> PyResult<BsonDocument> {
    json::document_from_json(text).map_err(PyValueError::new_err)
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

/// Document store backed by one `.yykv` shard.
#[pyclass]
pub struct MongoStore {
    inner: Arc<Store>,
}

#[pymethods]
impl MongoStore {
    #[new]
    fn new(path: String) -> PyResult<Self> {
        let store = Store::open(path).map_err(|error| PyValueError::new_err(error.to_string()))?;
        Ok(Self { inner: Arc::new(store) })
    }
}

/// Caller-owned cursor table.
#[pyclass]
pub struct MongoCursors {
    inner: CursorStore,
}

#[pymethods]
impl MongoCursors {
    #[new]
    fn new() -> Self {
        Self { inner: CursorStore::new() }
    }

    fn __len__(&self) -> usize {
        self.inner.len()
    }

    /// Marks every cursor on `database` as killed by `dropDatabase`.
    fn drop_database(&mut self, database: &str) -> usize {
        self.inner.drop_database(database)
    }

    /// Marks the cursors of one `db.collection` namespace as killed by a drop.
    fn drop_collection(&mut self, namespace: &str) -> usize {
        self.inner.drop_collection(namespace)
    }
}

/// Decodes an `OP_MSG` body into extended JSON.
#[pyfunction]
fn decode_op_msg(body: &[u8]) -> PyResult<String> {
    decode_op_msg_command(body).map(|document| reply(&document)).map_err(|error| PyValueError::new_err(format!("{error:?}")))
}

/// Encodes an extended-JSON command into an `OP_MSG` body.
#[pyfunction]
fn encode_op_msg<'py>(py: Python<'py>, command: &str) -> PyResult<Bound<'py, PyBytes>> {
    let document = decode_command(command)?;
    Ok(PyBytes::new(py, &encode_op_msg_body(&document)))
}

/// Encodes an extended-JSON document into BSON bytes.
#[pyfunction]
fn encode_document<'py>(py: Python<'py>, document: &str) -> PyResult<Bound<'py, PyBytes>> {
    let decoded = decode_command(document)?;
    Ok(PyBytes::new(py, &mongo::bson::encode_bson(&decoded)))
}

/// Decodes BSON bytes into extended JSON.
#[pyfunction]
fn decode_document(bytes: &[u8]) -> PyResult<String> {
    mongo::bson::parse_bson(bytes).map(|document| reply(&document)).map_err(|error| PyValueError::new_err(format!("{error:?}")))
}

/// Decodes a legacy `OP_QUERY` body into extended JSON.
#[pyfunction]
fn decode_op_query(body: &[u8]) -> PyResult<String> {
    decode_op_query_command(body).map(|document| reply(&document)).map_err(|error| PyValueError::new_err(format!("{error:?}")))
}

/// Name of the command in an extended-JSON document.
#[pyfunction]
fn command_name(command: &str) -> PyResult<String> {
    decode_command(command)?.command_name().map(str::to_string).ok_or_else(|| PyValueError::new_err("empty command"))
}

/// `{ ok: 0, code, errmsg }` as extended JSON.
#[pyfunction]
fn error_reply(code: i32, message: String) -> String {
    reply(&commands::error_document(&CommandError::new(code, message)))
}

/// `hello` / `isMaster` reply.
#[pyfunction]
fn hello() -> String {
    reply(&commands::hello())
}

/// `ping` reply.
#[pyfunction]
fn ping() -> String {
    reply(&commands::ping())
}

/// `insert` reply.
#[pyfunction]
fn insert(store: PyRef<'_, MongoStore>, command: &str) -> PyResult<String> {
    Ok(command_reply(commands::insert(&decode_command(command)?, store.inner.as_ref())))
}

/// `find` reply.
#[pyfunction]
fn find(store: PyRef<'_, MongoStore>, cursors: PyRefMut<'_, MongoCursors>, command: &str) -> PyResult<String> {
    let mut cursors = cursors;
    Ok(command_reply(commands::find(&decode_command(command)?, store.inner.as_ref(), &mut cursors.inner)))
}

/// `count` reply.
#[pyfunction]
fn count(store: PyRef<'_, MongoStore>, command: &str) -> PyResult<String> {
    Ok(command_reply(commands::count(&decode_command(command)?, store.inner.as_ref())))
}

/// `explain` reply.
#[pyfunction]
fn explain(store: PyRef<'_, MongoStore>, command: &str) -> PyResult<String> {
    Ok(command_reply(commands::explain(&decode_command(command)?, store.inner.as_ref())))
}

/// `aggregate` reply.
#[pyfunction]
fn aggregate(store: PyRef<'_, MongoStore>, command: &str) -> PyResult<String> {
    Ok(command_reply(commands::aggregate(&decode_command(command)?, store.inner.as_ref())))
}

/// `delete` reply.
#[pyfunction]
fn delete(store: PyRef<'_, MongoStore>, command: &str) -> PyResult<String> {
    Ok(command_reply(commands::delete(&decode_command(command)?, store.inner.as_ref())))
}

/// `update` reply.
#[pyfunction]
fn update(store: PyRef<'_, MongoStore>, command: &str) -> PyResult<String> {
    Ok(command_reply(commands::update(&decode_command(command)?, store.inner.as_ref())))
}

/// `getMore` reply.
#[pyfunction]
fn get_more(cursors: PyRefMut<'_, MongoCursors>, command: &str) -> PyResult<String> {
    let mut cursors = cursors;
    Ok(command_reply(commands::get_more(&decode_command(command)?, &mut cursors.inner)))
}

/// `killCursors` reply.
#[pyfunction]
fn kill_cursors(cursors: PyRefMut<'_, MongoCursors>, command: &str) -> PyResult<String> {
    let mut cursors = cursors;
    Ok(command_reply(commands::kill_cursors(&decode_command(command)?, &mut cursors.inner)))
}

/// `findAndModify` reply.
#[pyfunction]
fn find_and_modify(store: PyRef<'_, MongoStore>, command: &str) -> PyResult<String> {
    Ok(command_reply(commands::find_and_modify(&decode_command(command)?, store.inner.as_ref())))
}

/// `distinct` reply.
#[pyfunction]
fn distinct(store: PyRef<'_, MongoStore>, command: &str) -> PyResult<String> {
    Ok(command_reply(commands::distinct(&decode_command(command)?, store.inner.as_ref())))
}

/// `bulkWrite` reply.
#[pyfunction]
fn bulk_write(store: PyRef<'_, MongoStore>, command: &str) -> PyResult<String> {
    Ok(command_reply(commands::bulk_write(&decode_command(command)?, store.inner.as_ref())))
}

/// `create` reply.
#[pyfunction]
fn create(store: PyRef<'_, MongoStore>, command: &str) -> PyResult<String> {
    Ok(command_reply(commands::create(&decode_command(command)?, store.inner.as_ref())))
}

/// `drop` reply.
#[pyfunction]
fn drop_collection(store: PyRef<'_, MongoStore>, command: &str) -> PyResult<String> {
    Ok(command_reply(commands::drop(&decode_command(command)?, store.inner.as_ref())))
}

/// `collMod` reply.
#[pyfunction]
fn coll_mod(store: PyRef<'_, MongoStore>, command: &str) -> PyResult<String> {
    Ok(command_reply(commands::coll_mod(&decode_command(command)?, store.inner.as_ref())))
}

/// `listCollections` reply.
#[pyfunction]
fn list_collections(store: PyRef<'_, MongoStore>, command: &str) -> PyResult<String> {
    Ok(command_reply(commands::list_collections(&decode_command(command)?, store.inner.as_ref())))
}

/// `commitTransaction` reply.
#[pyfunction]
fn commit_transaction(store: PyRef<'_, MongoStore>, command: &str) -> PyResult<String> {
    Ok(command_reply(commands::commit_transaction(&decode_command(command)?, store.inner.as_ref())))
}

/// `abortTransaction` reply.
#[pyfunction]
fn abort_transaction(store: PyRef<'_, MongoStore>, command: &str) -> PyResult<String> {
    Ok(command_reply(commands::abort_transaction(&decode_command(command)?, store.inner.as_ref())))
}

/// `listDatabases` reply.
#[pyfunction]
fn list_databases(store: PyRef<'_, MongoStore>) -> String {
    command_reply(commands::list_databases(store.inner.as_ref()))
}

/// `dropDatabase` reply.
#[pyfunction]
fn drop_database(store: PyRef<'_, MongoStore>, command: &str) -> PyResult<String> {
    Ok(command_reply(commands::drop_database(&decode_command(command)?, store.inner.as_ref())))
}

/// `dbStats` reply.
///
/// `fs_used` / `fs_total` are filesystem bytes measured by the host; omit both
/// when the database does not exist, which is when `mongod` also reports zero.
#[pyfunction]
#[pyo3(signature = (store, command, fs_used=None, fs_total=None))]
fn db_stats(store: PyRef<'_, MongoStore>, command: &str, fs_used: Option<i64>, fs_total: Option<i64>) -> PyResult<String> {
    let filesystem = fs_used.zip(fs_total);
    Ok(command_reply(commands::db_stats(&decode_command(command)?, store.inner.as_ref(), filesystem)))
}

/// `collStats` reply, the per-collection half of `dbStats`.
#[pyfunction]
fn coll_stats(store: PyRef<'_, MongoStore>, command: &str) -> PyResult<String> {
    Ok(command_reply(commands::coll_stats(&decode_command(command)?, store.inner.as_ref())))
}

/// `createIndexes` reply.
#[pyfunction]
fn create_indexes(store: PyRef<'_, MongoStore>, command: &str) -> PyResult<String> {
    Ok(command_reply(commands::create_indexes(&decode_command(command)?, store.inner.as_ref())))
}

/// `listIndexes` reply.
#[pyfunction]
fn list_indexes(store: PyRef<'_, MongoStore>, command: &str) -> PyResult<String> {
    Ok(command_reply(commands::list_indexes(&decode_command(command)?, store.inner.as_ref())))
}

/// `dropIndexes` reply.
#[pyfunction]
fn drop_indexes(store: PyRef<'_, MongoStore>, command: &str) -> PyResult<String> {
    Ok(command_reply(commands::drop_indexes(&decode_command(command)?, store.inner.as_ref())))
}

/// Changes `ttlMonitorSleepSecs` (whole seconds, at least one).
#[pyfunction]
fn set_ttl_monitor_sleep_seconds(store: PyRef<'_, MongoStore>, seconds: u32) {
    store.inner.set_ttl_monitor_sleep_seconds(seconds);
}

/// One TTL monitor pass; `now_ms` defaults to the wall clock.
#[pyfunction]
#[pyo3(signature = (store, now_ms=None))]
fn ttl_monitor(store: PyRef<'_, MongoStore>, now_ms: Option<i64>) -> String {
    let now = now_ms.unwrap_or_else(|| {
        use std::time::{SystemTime, UNIX_EPOCH};
        SystemTime::now().duration_since(UNIX_EPOCH).map(|duration| duration.as_millis() as i64).unwrap_or(0)
    });
    match commands::ttl_monitor(store.inner.as_ref(), now) {
        Ok(report) => reply(&commands::ttl_report_document(&report)),
        Err(error) => reply(&commands::error_document(&error)),
    }
}

/// Configures the persistent replica-set oplog and its capped size.
#[pyfunction]
fn enable_oplog(store: PyRef<'_, MongoStore>, namespace: &str, max_bytes: i64) -> PyResult<()> {
    store.inner.enable_oplog(namespace, max_bytes).map_err(|error| PyValueError::new_err(error.to_string()))
}

/// Persists staged oplog entries; returns the last `{t,i}` as JSON.
#[pyfunction]
fn commit_oplog(store: PyRef<'_, MongoStore>, wall_millis: i64) -> PyResult<Option<String>> {
    let last = store.inner.commit_oplog(wall_millis).map_err(|error| PyValueError::new_err(error.to_string()))?;
    Ok(last.map(|(t, i)| format!("{{\"t\":{t},\"i\":{i}}}")))
}

/// Drops entries a failed write command staged.
#[pyfunction]
fn discard_oplog(store: PyRef<'_, MongoStore>) {
    store.inner.discard_staged_oplog();
}

/// Imports a `mongodump` `.bson` document stream into one namespace.
#[pyfunction]
fn import_bson(store: PyRef<'_, MongoStore>, namespace: &str, bytes: &[u8]) -> PyResult<usize> {
    mongo::import::import_bson_documents(store.inner.as_ref(), namespace, bytes).map_err(PyValueError::new_err)
}

/// Imports a `mongodump` `.bson` file into one namespace.
#[pyfunction]
fn import_bson_file(store: PyRef<'_, MongoStore>, namespace: &str, path: &str) -> PyResult<usize> {
    mongo::import::import_bson_file(store.inner.as_ref(), namespace, path).map_err(PyValueError::new_err)
}

/// Creates the empty shard a catalog names when only the catalog survived.
#[pyfunction]
fn repair_shard(path: &str) -> PyResult<String> {
    Store::repair_shard(path).map(|report| report.to_json()).map_err(|error| PyValueError::new_err(error.to_string()))
}

fn harness_error(error: impl std::fmt::Display) -> PyErr {
    PyValueError::new_err(error.to_string())
}

/// 对给定字节取 SHA-256，返回小写十六进制。
#[pyfunction]
fn harness_digest(bytes: &[u8]) -> String {
    Digest::of(bytes).to_hex()
}

/// 按已知差异台账判定一次语料运行。
#[pyfunction]
fn harness_check_baseline(baseline_json: &str, current_json: &str, observed_json: &str) -> PyResult<String> {
    let baseline: Baseline = serde_json::from_str(baseline_json).map_err(harness_error)?;
    let current: BaselineIdentity = serde_json::from_str(current_json).map_err(harness_error)?;
    let observed: Vec<DifferenceObservation> = serde_json::from_str(observed_json).map_err(harness_error)?;
    let verdict = check_baseline(&baseline, &current, &observed);
    serde_json::to_string(&verdict).map_err(harness_error)
}

/// 将报告信封渲染为稳定 JSON 文本。
#[pyfunction]
fn harness_render_report(report_json: &str) -> PyResult<String> {
    let report: ReportEnvelope = serde_json::from_str(report_json).map_err(harness_error)?;
    render_json(&report).map_err(harness_error)
}

/// 对一组毫秒样本求 median/p95/极值（nearest-rank，与 TS 既有实现逐字节一致）。
#[pyfunction]
fn harness_bench_summary<'py>(py: Python<'py>, samples_ms: Vec<f64>) -> PyResult<Bound<'py, PyDict>> {
    let stats = summarize(&samples_ms).map_err(harness_error)?;
    let dict = PyDict::new(py);
    dict.set_item("median_ms", stats.median_ms)?;
    dict.set_item("p95_ms", stats.p95_ms)?;
    dict.set_item("min_ms", stats.min_ms)?;
    dict.set_item("max_ms", stats.max_ms)?;
    dict.set_item("rounds", stats.rounds)?;
    Ok(dict)
}

/// 单次操作的归一毫秒（median / ops）。`ops` 为 0 时返回 NaN。
#[pyfunction]
fn harness_bench_per_op(stats: &Bound<'_, PyDict>, ops: u32) -> PyResult<f64> {
    let field = |key: &str| -> PyResult<f64> {
        stats.get_item(key)?.ok_or_else(|| PyValueError::new_err(format!("stats is missing {key}")))?.extract::<f64>()
    };
    let rounds: u32 = stats.get_item("rounds")?.ok_or_else(|| PyValueError::new_err("stats is missing rounds"))?.extract()?;
    per_op_ms(
        &Stats {
            median_ms: field("median_ms")?,
            p95_ms: field("p95_ms")?,
            min_ms: field("min_ms")?,
            max_ms: field("max_ms")?,
            rounds,
        },
        u64::from(ops),
    )
    .map_err(harness_error)
}

#[pymodule]
fn mongo_pyo3(module: &Bound<'_, PyModule>) -> PyResult<()> {
    module.add_class::<MongoStore>()?;
    module.add_class::<MongoCursors>()?;
    module.add_function(wrap_pyfunction!(decode_op_msg, module)?)?;
    module.add_function(wrap_pyfunction!(encode_op_msg, module)?)?;
    module.add_function(wrap_pyfunction!(encode_document, module)?)?;
    module.add_function(wrap_pyfunction!(decode_document, module)?)?;
    module.add_function(wrap_pyfunction!(decode_op_query, module)?)?;
    module.add_function(wrap_pyfunction!(command_name, module)?)?;
    module.add_function(wrap_pyfunction!(error_reply, module)?)?;
    module.add_function(wrap_pyfunction!(hello, module)?)?;
    module.add_function(wrap_pyfunction!(ping, module)?)?;
    module.add_function(wrap_pyfunction!(insert, module)?)?;
    module.add_function(wrap_pyfunction!(find, module)?)?;
    module.add_function(wrap_pyfunction!(count, module)?)?;
    module.add_function(wrap_pyfunction!(explain, module)?)?;
    module.add_function(wrap_pyfunction!(aggregate, module)?)?;
    module.add_function(wrap_pyfunction!(delete, module)?)?;
    module.add_function(wrap_pyfunction!(update, module)?)?;
    module.add_function(wrap_pyfunction!(get_more, module)?)?;
    module.add_function(wrap_pyfunction!(kill_cursors, module)?)?;
    module.add_function(wrap_pyfunction!(find_and_modify, module)?)?;
    module.add_function(wrap_pyfunction!(distinct, module)?)?;
    module.add_function(wrap_pyfunction!(bulk_write, module)?)?;
    module.add_function(wrap_pyfunction!(create, module)?)?;
    module.add_function(wrap_pyfunction!(drop_collection, module)?)?;
    module.add_function(wrap_pyfunction!(enable_oplog, module)?)?;
    module.add_function(wrap_pyfunction!(commit_oplog, module)?)?;
    module.add_function(wrap_pyfunction!(discard_oplog, module)?)?;
    module.add_function(wrap_pyfunction!(coll_mod, module)?)?;
    module.add_function(wrap_pyfunction!(list_collections, module)?)?;
    module.add_function(wrap_pyfunction!(commit_transaction, module)?)?;
    module.add_function(wrap_pyfunction!(abort_transaction, module)?)?;
    module.add_function(wrap_pyfunction!(list_databases, module)?)?;
    module.add_function(wrap_pyfunction!(drop_database, module)?)?;
    module.add_function(wrap_pyfunction!(db_stats, module)?)?;
    module.add_function(wrap_pyfunction!(coll_stats, module)?)?;
    module.add_function(wrap_pyfunction!(create_indexes, module)?)?;
    module.add_function(wrap_pyfunction!(list_indexes, module)?)?;
    module.add_function(wrap_pyfunction!(drop_indexes, module)?)?;
    module.add_function(wrap_pyfunction!(set_ttl_monitor_sleep_seconds, module)?)?;
    module.add_function(wrap_pyfunction!(ttl_monitor, module)?)?;
    module.add_function(wrap_pyfunction!(import_bson, module)?)?;
    module.add_function(wrap_pyfunction!(import_bson_file, module)?)?;
    module.add_function(wrap_pyfunction!(repair_shard, module)?)?;
    module.add_function(wrap_pyfunction!(harness_digest, module)?)?;
    module.add_function(wrap_pyfunction!(harness_check_baseline, module)?)?;
    module.add_function(wrap_pyfunction!(harness_render_report, module)?)?;
    module.add_function(wrap_pyfunction!(harness_bench_summary, module)?)?;
    module.add_function(wrap_pyfunction!(harness_bench_per_op, module)?)?;
    Ok(())
}
