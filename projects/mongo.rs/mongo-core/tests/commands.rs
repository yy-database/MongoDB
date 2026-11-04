//! Command-primitive tests: no server loop, no global state.

use std::{
    net::SocketAddr,
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};

use mongo_core::{
    bson::{BsonDocument, BsonValue, encode_bson, parse_bson},
    codec::{decode_op_msg_command, encode_op_msg_body},
    commands::{self, CommandError},
    cursor::CursorStore,
    json,
    store::Store,
};
use serde_json::json;

static SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn temporary_dir() -> std::path::PathBuf {
    let unique = SEQUENCE.fetch_add(1, Ordering::SeqCst);
    let path = std::env::temp_dir().join(format!("mongo-core-test-{}-{unique}", std::process::id()));
    let _ = std::fs::remove_dir_all(&path);
    std::fs::create_dir_all(&path).expect("create temp dir");
    path
}

fn store() -> Store {
    Store::open(temporary_dir().join("store.yykv")).expect("open shard")
}

fn document(fields: &[(&str, BsonValue)]) -> BsonDocument {
    let mut document = BsonDocument::new();
    for (key, value) in fields {
        document.push(*key, value.clone());
    }
    document
}

fn text(value: &str) -> BsonValue {
    BsonValue::String(value.to_string())
}

fn command(name: &str, collection: &str, database: &str) -> BsonDocument {
    document(&[(name, text(collection)), ("$db", text(database))])
}

fn int(value: &BsonDocument, key: &str) -> i64 {
    match value.get(key) {
        Some(BsonValue::Int32(number)) => *number as i64,
        Some(BsonValue::Int64(number)) => *number,
        _ => 0,
    }
}

fn array(value: &BsonDocument, key: &str) -> Vec<BsonDocument> {
    match value.get(key) {
        Some(BsonValue::Array(items)) => items
            .iter()
            .filter_map(|item| match item {
                BsonValue::Document(document) => Some(document.clone()),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn array_len(value: &BsonDocument, key: &str) -> usize {
    match value.get(key) {
        Some(BsonValue::Array(items)) => items.len(),
        _ => 0,
    }
}

fn batch(document: &BsonDocument, key: &str) -> Vec<BsonDocument> {
    match document.get("cursor") {
        Some(BsonValue::Document(cursor)) => array(cursor, key),
        _ => Vec::new(),
    }
}

fn cursor_id(document: &BsonDocument) -> i64 {
    match document.get("cursor") {
        Some(BsonValue::Document(cursor)) => int(cursor, "id"),
        _ => 0,
    }
}

fn insert_documents(store: &Store, collection: &str, documents: Vec<BsonDocument>) -> BsonDocument {
    let mut insert = command("insert", collection, "app");
    insert.push("documents", BsonValue::Array(documents.into_iter().map(BsonValue::Document).collect()));
    commands::insert(&insert, store).expect("insert")
}

fn find_all(store: &Store, collection: &str, cursors: &mut CursorStore) -> Vec<BsonDocument> {
    let mut find = command("find", collection, "app");
    find.push("filter", BsonValue::Document(BsonDocument::new()));
    batch(&commands::find(&find, store, cursors).expect("find"), "firstBatch")
}

#[test]
fn hello_answers_a_primary() {
    let response = commands::hello();
    assert_eq!(response.get("isWritablePrimary"), Some(&BsonValue::Bool(true)));
    assert_eq!(int(&response, "ok"), 1);
    assert_eq!(int(&commands::ping(), "ok"), 1);
}

#[test]
fn insert_assigns_object_id_and_reports_one_document() {
    let store = store();
    let response = insert_documents(&store, "items", vec![document(&[("n", BsonValue::Int32(1))])]);
    assert_eq!(int(&response, "n"), 1);
    assert!(response.get("writeErrors").is_none());

    let mut cursors = CursorStore::new();
    let found = find_all(&store, "items", &mut cursors);
    assert_eq!(found.len(), 1);
    assert!(matches!(found[0].get("_id"), Some(BsonValue::ObjectId(_))));
}

#[test]
fn duplicate_id_maps_to_11000_and_keeps_the_first_document() {
    let store = store();
    insert_documents(&store, "items", vec![document(&[("_id", BsonValue::Int32(1)), ("value", text("first"))])]);

    let response =
        insert_documents(&store, "items", vec![document(&[("_id", BsonValue::Int32(1)), ("value", text("second"))])]);
    assert_eq!(int(&response, "n"), 0);

    let errors = array(&response, "writeErrors");
    assert_eq!(errors.len(), 1);
    assert_eq!(int(&errors[0], "code"), 11000);

    let mut cursors = CursorStore::new();
    let found = find_all(&store, "items", &mut cursors);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].get("value"), Some(&text("first")));
}

#[test]
fn unordered_insert_continues_past_duplicates() {
    let store = store();
    insert_documents(&store, "items", vec![document(&[("_id", BsonValue::Int32(1))])]);

    let mut insert = command("insert", "items", "app");
    insert.push("ordered", BsonValue::Bool(false));
    insert.push(
        "documents",
        BsonValue::Array(vec![
            BsonValue::Document(document(&[("_id", BsonValue::Int32(1))])),
            BsonValue::Document(document(&[("_id", BsonValue::Int32(2))])),
        ]),
    );
    let response = commands::insert(&insert, &store).expect("insert");

    assert_eq!(int(&response, "n"), 1);
    let errors = array(&response, "writeErrors");
    assert_eq!(errors.len(), 1);
    assert_eq!(int(&errors[0], "code"), 11000);
    assert_eq!(int(&errors[0], "index"), 0);
}

#[test]
fn find_filters_with_comparison_operators() {
    let store = store();
    insert_documents(
        &store,
        "items",
        vec![
            document(&[("_id", BsonValue::Int32(1)), ("score", BsonValue::Int32(10))]),
            document(&[("_id", BsonValue::Int32(2)), ("score", BsonValue::Int32(20))]),
            document(&[("_id", BsonValue::Int32(3)), ("score", BsonValue::Int32(30))]),
        ],
    );

    let filter = document(&[("score", BsonValue::Document(document(&[("$gte", BsonValue::Int32(20))])))]);
    let mut find = command("find", "items", "app");
    find.push("filter", BsonValue::Document(filter));
    find.push("sort", BsonValue::Document(document(&[("score", BsonValue::Int32(-1))])));
    let mut cursors = CursorStore::new();
    let found = batch(&commands::find(&find, &store, &mut cursors).expect("find"), "firstBatch");

    assert_eq!(found.len(), 2);
    assert_eq!(found[0].get("score"), Some(&BsonValue::Int32(30)));
}

#[test]
fn count_respects_the_query_filter() {
    let store = store();
    insert_documents(
        &store,
        "items",
        vec![
            document(&[("_id", BsonValue::Int32(1)), ("kind", text("a"))]),
            document(&[("_id", BsonValue::Int32(2)), ("kind", text("b"))]),
            document(&[("_id", BsonValue::Int32(3)), ("kind", text("b"))]),
        ],
    );

    let mut count = command("count", "items", "app");
    count.push("query", BsonValue::Document(document(&[("kind", text("b"))])));
    assert_eq!(int(&commands::count(&count, &store).expect("count"), "n"), 2);
}

#[test]
fn aggregate_matches_groups_and_projects() {
    let store = store();
    insert_documents(
        &store,
        "items",
        vec![
            document(&[("_id", BsonValue::Int32(1)), ("kind", text("b"))]),
            document(&[("_id", BsonValue::Int32(2)), ("kind", text("b"))]),
            document(&[("_id", BsonValue::Int32(3)), ("kind", text("a"))]),
        ],
    );

    let mut aggregate = command("aggregate", "items", "app");
    aggregate.push(
        "pipeline",
        BsonValue::Array(vec![
            BsonValue::Document(document(&[("$match", BsonValue::Document(document(&[("kind", text("b"))])))])),
            BsonValue::Document(document(&[(
                "$group",
                BsonValue::Document(document(&[
                    ("_id", BsonValue::Null),
                    ("total", BsonValue::Document(document(&[("$sum", BsonValue::Int32(1))]))),
                ])),
            )])),
            BsonValue::Document(document(&[(
                "$project",
                BsonValue::Document(document(&[("_id", BsonValue::Int32(0)), ("total", BsonValue::Int32(1))])),
            )])),
        ]),
    );

    let grouped = batch(&commands::aggregate(&aggregate, &store).expect("aggregate"), "firstBatch");
    assert_eq!(grouped.len(), 1);
    assert_eq!(grouped[0].get("total"), Some(&BsonValue::Int32(2)));
    assert!(grouped[0].get("_id").is_none());
}

#[test]
fn aggregate_rejects_unsupported_stages_even_after_match() {
    let store = store();
    let mut aggregate = command("aggregate", "items", "app");
    aggregate.push(
        "pipeline",
        BsonValue::Array(vec![
            BsonValue::Document(document(&[("$match", BsonValue::Document(BsonDocument::new()))])),
            BsonValue::Document(document(&[("$limit", BsonValue::Int32(1))])),
        ]),
    );

    let error = commands::aggregate(&aggregate, &store).expect_err("stage must be rejected");
    assert_eq!(error.code, 59);
    assert_eq!(error.message, "$limit");
}

#[test]
fn delete_honours_limit() {
    let store = store();
    insert_documents(
        &store,
        "items",
        vec![
            document(&[("_id", BsonValue::Int32(1)), ("kind", text("b"))]),
            document(&[("_id", BsonValue::Int32(2)), ("kind", text("b"))]),
        ],
    );

    let mut delete = command("delete", "items", "app");
    delete.push(
        "deletes",
        BsonValue::Array(vec![BsonValue::Document(document(&[
            ("q", BsonValue::Document(document(&[("kind", text("b"))]))),
            ("limit", BsonValue::Int32(1)),
        ]))]),
    );
    assert_eq!(int(&commands::delete(&delete, &store).expect("delete"), "n"), 1);

    let mut count = command("count", "items", "app");
    count.push("query", BsonValue::Document(BsonDocument::new()));
    assert_eq!(int(&commands::count(&count, &store).expect("count"), "n"), 1);
}

#[test]
fn find_batch_leaves_a_get_more_cursor() {
    let store = store();
    insert_documents(&store, "items", (0..6).map(|index| document(&[("_id", BsonValue::Int32(index))])).collect());

    let mut find = command("find", "items", "app");
    find.push("filter", BsonValue::Document(BsonDocument::new()));
    find.push("batchSize", BsonValue::Int32(2));
    let mut cursors = CursorStore::new();
    let response = commands::find(&find, &store, &mut cursors).expect("find");
    assert_eq!(batch(&response, "firstBatch").len(), 2);
    let id = cursor_id(&response);
    assert!(id > 0);

    let mut get_more = document(&[("getMore", BsonValue::Int64(id)), ("collection", text("items")), ("$db", text("app"))]);
    get_more.push("batchSize", BsonValue::Int32(2));
    let next = commands::get_more(&get_more, &mut cursors).expect("getMore");
    assert_eq!(batch(&next, "nextBatch").len(), 2);
}

#[test]
fn kill_cursors_reports_killed_and_unknown_ids() {
    let mut cursors = CursorStore::new();
    let (id, first) = cursors.open("app.items", (0..4).map(BsonValue::Int32).collect(), 2);
    assert!(id > 0);
    assert_eq!(first.len(), 2);

    let mut kill = document(&[("killCursors", text("items")), ("$db", text("app"))]);
    kill.push("cursors", BsonValue::Array(vec![BsonValue::Int64(id), BsonValue::Int64(id + 100)]));
    let response = commands::kill_cursors(&kill, &mut cursors).expect("killCursors");
    assert_eq!(array_len(&response, "cursorsKilled"), 1);
    assert_eq!(array_len(&response, "cursorsNotFound"), 1);
}

#[test]
fn idle_cursors_are_reclaimed_lazily() {
    let mut cursors = CursorStore::with_idle_timeout(Duration::from_millis(1));
    let (id, _) = cursors.open("app.items", (0..4).map(BsonValue::Int32).collect(), 2);
    assert_eq!(cursors.len(), 1);
    std::thread::sleep(Duration::from_millis(20));
    assert!(cursors.get_more(id, 2).is_err());
    assert!(cursors.is_empty());
    assert_eq!(CursorStore::new().idle_timeout(), Duration::from_secs(600));
}

#[test]
fn unknown_command_is_rejected_with_59() {
    let error = CommandError::unsupported("findAndModify");
    assert_eq!(error.code, 59);
    assert_eq!(error.message, "findAndModify");
}

#[test]
fn invalid_collection_name_is_rejected_with_73() {
    let store = store();
    let mut find = command("find", "bad$name", "app");
    find.push("filter", BsonValue::Document(BsonDocument::new()));
    let mut cursors = CursorStore::new();
    let error = commands::find(&find, &store, &mut cursors).expect_err("namespace must be rejected");
    assert_eq!(error.code, 73);
}

#[test]
fn documents_survive_a_reopen() {
    let directory = temporary_dir();
    {
        let store = Store::open(directory.join("store.yykv")).expect("open shard");
        insert_documents(&store, "items", vec![document(&[("_id", BsonValue::Int32(1))])]);
    }
    let store = Store::open(directory.join("store.yykv")).expect("reopen shard");
    assert_eq!(store.scan("app.items").len(), 1);
    assert_eq!(store.namespaces(), vec!["app.items".to_string()]);
}

#[test]
fn mongodump_stream_is_imported() {
    let store = store();
    let mut stream = Vec::new();
    stream.extend_from_slice(&encode_bson(&document(&[("_id", BsonValue::Int32(1)), ("name", text("one"))])));
    stream.extend_from_slice(&encode_bson(&document(&[("_id", BsonValue::Int32(2)), ("name", text("two"))])));
    let imported = mongo_core::import_bson_documents(&store, "app.items", &stream).expect("import");
    assert_eq!(imported, 2);
    assert_eq!(store.scan("app.items").len(), 2);
}

#[test]
fn extended_json_round_trips_every_type() {
    let source = json!({
        "text": "hello",
        "int": {"$numberInt": "42"},
        "long": {"$numberLong": "9007199254740993"},
        "double": {"$numberDouble": "1.5"},
        "flag": true,
        "empty": null,
        "oid": {"$oid": "000000000000000000000001"},
        "bin": {"$binary": {"base64": "AQID", "subType": "00"}},
        "nested": {"a": [{"$numberInt": "1"}]}
    });
    let document = json::from_json(&serde_json::Value::Object(source.as_object().unwrap().clone())).expect("parse");
    let round_trip = json::to_json(&document);
    assert_eq!(round_trip, source);
    assert!(matches!(document, BsonValue::Document(_)));
}

#[test]
fn library_smoke_decodes_op_msg_bytes_and_returns_a_reply() {
    let store = store();
    let mut insert = command("insert", "items", "app");
    insert.push("documents", BsonValue::Array(vec![BsonValue::Document(document(&[("n", BsonValue::Int32(7))]))]));
    let frame = encode_op_msg_body(&insert);
    let decoded = decode_op_msg_command(&frame).expect("decode");
    let response = commands::insert(&decoded, &store).expect("insert");
    assert_eq!(int(&response, "n"), 1);

    let mut find = command("find", "items", "app");
    find.push("filter", BsonValue::Document(BsonDocument::new()));
    let mut cursors = CursorStore::new();
    let reply = commands::find(&find, &store, &mut cursors).expect("find");
    assert_eq!(batch(&reply, "firstBatch").len(), 1);

    let _ = parse_bson(&encode_bson(&reply)).expect("reply is valid BSON");
    let _ = SocketAddr::from(([127, 0, 0, 1], 0));
}
