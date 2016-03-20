//! Python bindings: thin wrappers over the Rust primitives.
//!
//! The Python host owns the socket loop, the cursor table instance, and the CLI.

use std::sync::Arc;

use mongo_core::{
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
    types::{PyBytes, PyModule},
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
    Ok(PyBytes::new(py, &mongo_core::bson::encode_bson(&decoded)))
}

/// Decodes BSON bytes into extended JSON.
#[pyfunction]
fn decode_document(bytes: &[u8]) -> PyResult<String> {
    mongo_core::bson::parse_bson(bytes)
        .map(|document| reply(&document))
        .map_err(|error| PyValueError::new_err(format!("{error:?}")))
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
    Ok(command_reply(commands::insert(&decode_command(command)?, &store.inner)))
}

/// `find` reply.
#[pyfunction]
fn find(store: PyRef<'_, MongoStore>, cursors: PyRefMut<'_, MongoCursors>, command: &str) -> PyResult<String> {
    let mut cursors = cursors;
    Ok(command_reply(commands::find(&decode_command(command)?, &store.inner, &mut cursors.inner)))
}

/// `count` reply.
#[pyfunction]
fn count(store: PyRef<'_, MongoStore>, command: &str) -> PyResult<String> {
    Ok(command_reply(commands::count(&decode_command(command)?, &store.inner)))
}

/// `explain` reply.
#[pyfunction]
fn explain(store: PyRef<'_, MongoStore>, command: &str) -> PyResult<String> {
    Ok(command_reply(commands::explain(&decode_command(command)?, &store.inner)))
}

/// `aggregate` reply.
#[pyfunction]
fn aggregate(store: PyRef<'_, MongoStore>, command: &str) -> PyResult<String> {
    Ok(command_reply(commands::aggregate(&decode_command(command)?, &store.inner)))
}

/// `delete` reply.
#[pyfunction]
fn delete(store: PyRef<'_, MongoStore>, command: &str) -> PyResult<String> {
    Ok(command_reply(commands::delete(&decode_command(command)?, &store.inner)))
}

/// `update` reply.
#[pyfunction]
fn update(store: PyRef<'_, MongoStore>, command: &str) -> PyResult<String> {
    Ok(command_reply(commands::update(&decode_command(command)?, &store.inner)))
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
    Ok(command_reply(commands::find_and_modify(&decode_command(command)?, &store.inner)))
}

/// `distinct` reply.
#[pyfunction]
fn distinct(store: PyRef<'_, MongoStore>, command: &str) -> PyResult<String> {
    Ok(command_reply(commands::distinct(&decode_command(command)?, &store.inner)))
}

/// `bulkWrite` reply.
#[pyfunction]
fn bulk_write(store: PyRef<'_, MongoStore>, command: &str) -> PyResult<String> {
    Ok(command_reply(commands::bulk_write(&decode_command(command)?, &store.inner)))
}

/// `create` reply.
#[pyfunction]
fn create(store: PyRef<'_, MongoStore>, command: &str) -> PyResult<String> {
    Ok(command_reply(commands::create(&decode_command(command)?, &store.inner)))
}

/// `collMod` reply.
#[pyfunction]
fn coll_mod(store: PyRef<'_, MongoStore>, command: &str) -> PyResult<String> {
    Ok(command_reply(commands::coll_mod(&decode_command(command)?, &store.inner)))
}

/// `listCollections` reply.
#[pyfunction]
fn list_collections(store: PyRef<'_, MongoStore>, command: &str) -> PyResult<String> {
    Ok(command_reply(commands::list_collections(&decode_command(command)?, &store.inner)))
}

/// `commitTransaction` reply.
#[pyfunction]
fn commit_transaction(store: PyRef<'_, MongoStore>, command: &str) -> PyResult<String> {
    Ok(command_reply(commands::commit_transaction(&decode_command(command)?, &store.inner)))
}

/// `abortTransaction` reply.
#[pyfunction]
fn abort_transaction(store: PyRef<'_, MongoStore>, command: &str) -> PyResult<String> {
    Ok(command_reply(commands::abort_transaction(&decode_command(command)?, &store.inner)))
}

/// `listDatabases` reply.
#[pyfunction]
fn list_databases(store: PyRef<'_, MongoStore>) -> String {
    reply(&commands::list_databases(&store.inner))
}

/// `createIndexes` reply.
#[pyfunction]
fn create_indexes(store: PyRef<'_, MongoStore>, command: &str) -> PyResult<String> {
    Ok(command_reply(commands::create_indexes(&decode_command(command)?, &store.inner)))
}

/// `listIndexes` reply.
#[pyfunction]
fn list_indexes(store: PyRef<'_, MongoStore>, command: &str) -> PyResult<String> {
    Ok(command_reply(commands::list_indexes(&decode_command(command)?, &store.inner)))
}

/// `dropIndexes` reply.
#[pyfunction]
fn drop_indexes(store: PyRef<'_, MongoStore>, command: &str) -> PyResult<String> {
    Ok(command_reply(commands::drop_indexes(&decode_command(command)?, &store.inner)))
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
    match commands::ttl_monitor(&store.inner, now) {
        Ok(report) => reply(&commands::ttl_report_document(&report)),
        Err(error) => reply(&commands::error_document(&error)),
    }
}

/// Imports a `mongodump` `.bson` document stream into one namespace.
#[pyfunction]
fn import_bson(store: PyRef<'_, MongoStore>, namespace: &str, bytes: &[u8]) -> PyResult<usize> {
    mongo_core::import_bson_documents(&store.inner, namespace, bytes).map_err(PyValueError::new_err)
}

/// Imports a `mongodump` `.bson` file into one namespace.
#[pyfunction]
fn import_bson_file(store: PyRef<'_, MongoStore>, namespace: &str, path: &str) -> PyResult<usize> {
    mongo_core::import_bson_file(&store.inner, namespace, path).map_err(PyValueError::new_err)
}

/// Creates the empty shard a catalog names when only the catalog survived.
#[pyfunction]
fn repair_shard(path: &str) -> PyResult<String> {
    Store::repair_shard(path).map(|report| report.to_json()).map_err(|error| PyValueError::new_err(error.to_string()))
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
    module.add_function(wrap_pyfunction!(coll_mod, module)?)?;
    module.add_function(wrap_pyfunction!(list_collections, module)?)?;
    module.add_function(wrap_pyfunction!(commit_transaction, module)?)?;
    module.add_function(wrap_pyfunction!(abort_transaction, module)?)?;
    module.add_function(wrap_pyfunction!(list_databases, module)?)?;
    module.add_function(wrap_pyfunction!(create_indexes, module)?)?;
    module.add_function(wrap_pyfunction!(list_indexes, module)?)?;
    module.add_function(wrap_pyfunction!(drop_indexes, module)?)?;
    module.add_function(wrap_pyfunction!(set_ttl_monitor_sleep_seconds, module)?)?;
    module.add_function(wrap_pyfunction!(ttl_monitor, module)?)?;
    module.add_function(wrap_pyfunction!(import_bson, module)?)?;
    module.add_function(wrap_pyfunction!(import_bson_file, module)?)?;
    module.add_function(wrap_pyfunction!(repair_shard, module)?)?;
    Ok(())
}
