//! Individual command primitives.
//!
//! Every function here is callable on its own by a library user: nothing is
//! dispatched through a hidden entry point and no state is global. Hosts compose
//! these primitives into their own server loop and CLI.

use std::{
    cmp::Ordering,
    time::{SystemTime, UNIX_EPOCH},
};

use crate::{
    bson::{BsonDocument, BsonValue, encode_bson, integral_value, parse_bson, value_to_key},
    cursor::CursorStore,
    store::Store,
};

/// Filter operators this gateway implements. Anything outside this list is a
/// hard error: an unrecognised operator must never silently match nothing.
pub const FILTER_OPERATORS: [&str; 6] = ["$eq", "$ne", "$gt", "$gte", "$lt", "$lte"];

/// Update operators this gateway implements.
pub const UPDATE_OPERATORS: [&str; 3] = ["$set", "$unset", "$inc"];

/// Command failure carrying the MongoDB error code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandError {
    /// MongoDB error code (`59` unsupported, `73` invalid namespace, `43` no such cursor).
    pub code: i32,
    /// Message drivers surface as `errmsg`.
    pub message: String,
}

impl CommandError {
    /// Builds one command failure.
    pub fn new(code: i32, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }

    /// `CommandNotFound`: the command or stage is outside the documented surface.
    pub fn unsupported(stage: &str) -> Self {
        Self::new(59, stage)
    }
}

impl std::fmt::Display for CommandError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for CommandError {}

/// Rejects every filter that uses an operator outside [`FILTER_OPERATORS`].
///
/// The message always names the operator, the operation that received it, and
/// where it appeared (`fieldIndex` within the filter, `operatorIndex` within
/// the operator document), so a wrong query is reported instead of silently
/// returning an empty cursor.
pub fn validate_filter(filter: &BsonDocument, operation: &str) -> Result<(), CommandError> {
    for (field_index, (field, expected)) in filter.fields.iter().enumerate() {
        if field.starts_with('$') {
            return Err(CommandError::new(
                2,
                format!("unknown top level operator: {field} (operation: {operation}, fieldIndex: {field_index})"),
            ));
        }
        let BsonValue::Document(operators) = expected
        else { continue };
        if !operators.fields.iter().any(|(operator, _)| operator.starts_with('$')) {
            continue;
        }
        for (operator_index, (operator, _)) in operators.fields.iter().enumerate() {
            if !FILTER_OPERATORS.contains(&operator.as_str()) {
                return Err(unknown_operator(operator, operation, field, field_index, operator_index));
            }
        }
    }
    Ok(())
}

fn unknown_operator(
    operator: &str,
    operation: &str,
    field: &str,
    field_index: usize,
    operator_index: usize,
) -> CommandError {
    CommandError::new(
        2,
        format!(
            "unknown operator: {operator} (operation: {operation}, field: \"{field}\", fieldIndex: {field_index}, operatorIndex: {operator_index})"
        ),
    )
}

/// `listCollections` accepts only an exact `name` match.
fn validate_listing_filter(filter: &BsonDocument) -> Result<(), CommandError> {
    for (field_index, (field, expected)) in filter.fields.iter().enumerate() {
        if field != "name" {
            return Err(CommandError::new(
                59,
                format!("unsupported listCollections filter field: {field} (fieldIndex: {field_index})"),
            ));
        }
        if let BsonValue::Document(operators) = expected {
            if let Some((operator, _)) = operators.fields.first() {
                return Err(unknown_operator(operator, "listCollections", field, field_index, 0));
            }
        }
    }
    Ok(())
}

/// Result document for a failed command: `{ ok: 0, code, errmsg }`.
pub fn error_document(error: &CommandError) -> BsonDocument {
    let mut document = BsonDocument::new();
    document.push("ok".to_string(), BsonValue::Int32(0));
    document.push("errmsg".to_string(), BsonValue::String(error.message.clone()));
    document.push("code".to_string(), BsonValue::Int32(error.code));
    document
}

/// `hello` / `isMaster` handshake answer.
pub fn hello() -> BsonDocument {
    let mut document = BsonDocument::new();
    document.push("isWritablePrimary".to_string(), BsonValue::Bool(true));
    document.push("maxWireVersion".to_string(), BsonValue::Int32(17));
    document.push("minWireVersion".to_string(), BsonValue::Int32(0));
    document.push("ok".to_string(), BsonValue::Int32(1));
    document
}

/// `ping` answer.
pub fn ping() -> BsonDocument {
    let mut document = BsonDocument::new();
    document.push("ok".to_string(), BsonValue::Int32(1));
    document
}

/// Renders an `_id` the way MongoDB's duplicate-key message does.
pub fn describe_id(value: &BsonValue) -> String {
    match value {
        BsonValue::String(text) => format!("\"{text}\""),
        BsonValue::Int32(number) => number.to_string(),
        BsonValue::Int64(number) => number.to_string(),
        BsonValue::ObjectId(bytes) => {
            let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
            format!("ObjectId('{hex}')")
        }
        other => format!("{other:?}"),
    }
}

/// `insert`, with `_id` generation, `11000` duplicate mapping, and ordered /
/// unordered continuation.
pub fn insert(command: &BsonDocument, store: &Store) -> Result<BsonDocument, CommandError> {
    let namespace = namespace_from_command(command, "insert")
        .ok_or_else(|| CommandError::new(73, "insert command missing collection name"))?;

    let Some(BsonValue::Array(documents)) = command.get("documents")
    else {
        return Err(CommandError::new(2, "insert requires a 'documents' array"));
    };

    let ordered = match command.get("ordered") {
        Some(BsonValue::Bool(ordered)) => *ordered,
        _ => true,
    };

    let mut positions = Vec::with_capacity(documents.len());
    let mut entries = Vec::with_capacity(documents.len());
    let mut identifiers = Vec::with_capacity(documents.len());
    let mut write_errors: Vec<(usize, i32, String)> = Vec::new();

    for (index, item) in documents.iter().enumerate() {
        let BsonValue::Document(sub_document) = item
        else {
            write_errors.push((index, 2, "documents must be objects".to_string()));
            if ordered {
                break;
            }
            continue;
        };
        let mut stored = sub_document.clone();
        if !stored.fields.iter().any(|(field, _)| field == "_id") {
            stored.push("_id".to_string(), BsonValue::ObjectId(generate_object_id()));
        }
        let Some(identifier) = stored.fields.iter().find(|(field, _)| field == "_id").map(|(_, value)| value.clone())
        else {
            continue;
        };
        positions.push(index);
        identifiers.push(identifier.clone());
        entries.push((value_to_key(&identifier), encode_bson(&stored)));
    }

    let report =
        store.insert(&namespace, &entries, ordered).map_err(|error| CommandError::new(2, format!("insert failed: {error}")))?;

    for duplicate in &report.duplicates {
        let index = positions[*duplicate];
        let identifier = &identifiers[*duplicate];
        write_errors.push((
            index,
            11000,
            format!(
                "E11000 duplicate key error collection: {namespace} index: _id_ dup key: {{ _id: {} }}",
                describe_id(identifier)
            ),
        ));
    }
    write_errors.sort_by_key(|(index, _, _)| *index);

    let mut response = BsonDocument::new();
    response.push("ok".to_string(), BsonValue::Int32(1));
    response.push("n".to_string(), BsonValue::Int64(report.inserted));
    if !write_errors.is_empty() {
        let errors: Vec<BsonValue> = write_errors
            .into_iter()
            .map(|(index, code, message)| {
                let mut error = BsonDocument::new();
                error.push("index".to_string(), BsonValue::Int32(index as i32));
                error.push("code".to_string(), BsonValue::Int32(code));
                error.push("errmsg".to_string(), BsonValue::String(message));
                BsonValue::Document(error)
            })
            .collect();
        response.push("writeErrors".to_string(), BsonValue::Array(errors));
    }
    Ok(response)
}

/// `find` with filter, sort, skip, limit and cursor batching.
pub fn find(command: &BsonDocument, store: &Store, cursors: &mut CursorStore) -> Result<BsonDocument, CommandError> {
    let namespace =
        namespace_from_command(command, "find").ok_or_else(|| CommandError::new(73, "find command missing collection name"))?;

    let filter = match command.get("filter") {
        Some(BsonValue::Document(filter)) => filter.clone(),
        _ => BsonDocument::new(),
    };
    validate_filter(&filter, "find")?;
    let sort = parse_sort(command.get("sort"));
    let skip = parse_count(command.get("skip"));
    let limit = parse_count(command.get("limit"));
    let batch_size = parse_count(command.get("batchSize"));
    let projection = match command.get("projection") {
        Some(BsonValue::Document(projection)) => Some(projection.clone()),
        _ => None,
    };

    let mut documents = collect_matching(store, &namespace, &filter)?;
    sort_documents(&mut documents, &sort);

    let start = skip.min(documents.len());
    let end = if limit > 0 { (start + limit).min(documents.len()) } else { documents.len() };
    let window: Vec<BsonValue> = documents
        .into_iter()
        .skip(start)
        .take(end - start)
        .map(|document| match &projection {
            Some(projection) => BsonValue::Document(project_document(&document, projection)),
            None => BsonValue::Document(document),
        })
        .collect();

    let (cursor_id, first_batch) = cursors.open(&namespace, window, batch_size);
    Ok(cursor_reply(&namespace, "firstBatch", first_batch, cursor_id))
}

/// `count`, honouring `query`, `skip` and `limit`.
pub fn count(command: &BsonDocument, store: &Store) -> Result<BsonDocument, CommandError> {
    let namespace = namespace_from_command(command, "count")
        .ok_or_else(|| CommandError::new(73, "count command missing collection name"))?;

    let filter = match command.get("query") {
        Some(BsonValue::Document(filter)) => filter.clone(),
        _ => BsonDocument::new(),
    };
    validate_filter(&filter, "count")?;
    let skip = parse_count(command.get("skip"));
    let limit = parse_count(command.get("limit"));

    let matched = collect_matching(store, &namespace, &filter)?.len();
    let start = skip.min(matched);
    let end = if limit > 0 { (start + limit).min(matched) } else { matched };

    let mut response = BsonDocument::new();
    response.push("n".to_string(), BsonValue::Int64((end - start) as i64));
    response.push("ok".to_string(), BsonValue::Int32(1));
    Ok(response)
}

/// `aggregate` with `$match`, constant-`_id` `$sum: 1` `$group`, and `$project`.
///
/// Every other stage answers `59`, including stages that follow an already
/// executed `$match`.
pub fn aggregate(command: &BsonDocument, store: &Store) -> Result<BsonDocument, CommandError> {
    let namespace = namespace_from_command(command, "aggregate")
        .ok_or_else(|| CommandError::new(73, "aggregate command missing collection name"))?;

    let stages = match command.get("pipeline") {
        Some(BsonValue::Array(stages)) => stages,
        _ => return Err(CommandError::new(2, "aggregate requires a pipeline array")),
    };

    let mut documents = collect_matching(store, &namespace, &BsonDocument::new())?;
    for stage in stages {
        let BsonValue::Document(stage_document) = stage
        else {
            return Err(CommandError::unsupported("aggregate stage must be a document"));
        };
        let Some((name, body)) = stage_document.fields.first()
        else {
            return Err(CommandError::unsupported("aggregate stage is empty"));
        };
        match name.as_str() {
            "$match" => {
                let BsonValue::Document(filter) = body
                else {
                    return Err(CommandError::unsupported("$match requires a document"));
                };
                validate_filter(filter, "aggregate $match")?;
                let mut kept = Vec::new();
                for candidate in documents {
                    if document_matches(&candidate, filter)? {
                        kept.push(candidate);
                    }
                }
                documents = kept;
            }
            "$group" => {
                let BsonValue::Document(specification) = body
                else {
                    return Err(CommandError::unsupported("$group requires a document"));
                };
                match group_documents(&documents, specification) {
                    Ok(grouped) => documents = grouped,
                    Err(message) => return Err(CommandError::unsupported(&message)),
                }
            }
            "$project" => {
                let BsonValue::Document(specification) = body
                else {
                    return Err(CommandError::unsupported("$project requires a document"));
                };
                documents = documents.iter().map(|candidate| project_document(candidate, specification)).collect();
            }
            other => return Err(CommandError::unsupported(other)),
        }
    }

    Ok(cursor_reply(&namespace, "firstBatch", documents.into_iter().map(BsonValue::Document).collect(), 0))
}

/// `delete` with `limit` (`0` deletes every match).
pub fn delete(command: &BsonDocument, store: &Store) -> Result<BsonDocument, CommandError> {
    let namespace = namespace_from_command(command, "delete")
        .ok_or_else(|| CommandError::new(73, "delete command missing collection name"))?;

    let specifications = match command.get("deletes") {
        Some(BsonValue::Array(deletes)) => deletes.clone(),
        _ => {
            let mut single = BsonDocument::new();
            single.push("q".to_string(), BsonValue::Document(BsonDocument::new()));
            single.push("limit".to_string(), BsonValue::Int32(0));
            vec![BsonValue::Document(single)]
        }
    };

    let mut deleted: i64 = 0;
    for specification in &specifications {
        let BsonValue::Document(specification) = specification
        else {
            continue;
        };
        let empty = BsonDocument::new();
        let filter = match specification.get("q") {
            Some(BsonValue::Document(filter)) => filter,
            _ => &empty,
        };
        let limit = match specification.get("limit") {
            Some(BsonValue::Int32(limit)) if *limit >= 0 => *limit as usize,
            _ => 0,
        };
        validate_filter(filter, "delete")?;

        if let Some(identifier) = single_id_lookup(filter) {
            let key = value_to_key(identifier);
            deleted += store.delete(&namespace, std::slice::from_ref(&key)).unwrap_or(0) as i64;
        }
        else {
            let mut keys = Vec::new();
            for (key, value) in store.scan(&namespace) {
                if limit > 0 && keys.len() >= limit {
                    break;
                }
                let Ok(candidate) = parse_bson(&value)
                else {
                    continue;
                };
                if document_matches(&candidate, filter)? {
                    keys.push(key);
                }
            }
            if !keys.is_empty() {
                deleted += store.delete(&namespace, &keys).unwrap_or(0) as i64;
            }
        }
    }

    let mut response = BsonDocument::new();
    response.push("ok".to_string(), BsonValue::Int32(1));
    response.push("n".to_string(), BsonValue::Int64(deleted));
    response.push("deletedCount".to_string(), BsonValue::Int64(deleted));
    Ok(response)
}

/// `update` with `$set`, `$unset` and `$inc`; `multi` toggles updateMany.
///
/// `upsert` and replacement documents are rejected instead of being silently
/// ignored.
pub fn update(command: &BsonDocument, store: &Store) -> Result<BsonDocument, CommandError> {
    let namespace = namespace_from_command(command, "update")
        .ok_or_else(|| CommandError::new(73, "update command missing collection name"))?;
    let Some(BsonValue::Array(specifications)) = command.get("updates")
    else {
        return Err(CommandError::new(2, "update requires an 'updates' array"));
    };

    let mut matched: i64 = 0;
    let mut modified: i64 = 0;
    for specification in specifications {
        let BsonValue::Document(specification) = specification
        else {
            return Err(CommandError::new(2, "update specification must be a document"));
        };
        let empty = BsonDocument::new();
        let filter = match specification.get("q") {
            Some(BsonValue::Document(filter)) => filter,
            _ => &empty,
        };
        validate_filter(filter, "update")?;

        let Some(BsonValue::Document(update_document)) = specification.get("u")
        else {
            return Err(CommandError::new(2, "update specification requires a 'u' document"));
        };
        validate_update_document(update_document)?;

        if matches!(specification.get("upsert"), Some(BsonValue::Bool(true))) {
            return Err(CommandError::new(59, "update upsert is not supported"));
        }
        let multi = matches!(specification.get("multi"), Some(BsonValue::Bool(true)));

        let mut changes = Vec::new();
        for (key, value) in store.scan(&namespace) {
            let Ok(document) = parse_bson(&value)
            else {
                continue;
            };
            if !document_matches(&document, filter)? {
                continue;
            }
            matched += 1;
            let identifier = document.get("_id").map(describe_id).unwrap_or_else(|| "<missing>".to_string());
            let updated = apply_update(&document, update_document, &identifier)?;
            let payload = encode_bson(&updated);
            if payload != value {
                modified += 1;
                changes.push((key, payload));
            }
            if !multi {
                break;
            }
        }
        if !changes.is_empty() {
            store.replace(&namespace, &changes).map_err(|error| CommandError::new(2, error.to_string()))?;
        }
    }

    let mut response = BsonDocument::new();
    response.push("ok".to_string(), BsonValue::Int32(1));
    response.push("n".to_string(), BsonValue::Int64(matched));
    response.push("nModified".to_string(), BsonValue::Int64(modified));
    Ok(response)
}

fn validate_update_document(document: &BsonDocument) -> Result<(), CommandError> {
    if document.fields.is_empty() {
        return Err(CommandError::new(2, "update specification is empty"));
    }
    let mut paths: Vec<&str> = Vec::new();
    for (operator_index, (operator, operand)) in document.fields.iter().enumerate() {
        if !operator.starts_with('$') {
            return Err(CommandError::new(
                59,
                "replacement updates are not supported; `u` must use $set, $unset or $inc",
            ));
        }
        if !UPDATE_OPERATORS.contains(&operator.as_str()) {
            return Err(CommandError::new(9, format!("Unknown modifier: {operator} (operatorIndex: {operator_index})")));
        }
        let BsonValue::Document(operand) = operand
        else {
            return Err(CommandError::new(9, format!("update operator {operator} requires a document")));
        };
        for (path, _) in &operand.fields {
            if path == "_id" || path.starts_with("_id.") {
                return Err(CommandError::new(
                    66,
                    format!("Performing an update on the path '{path}' would modify the immutable field '_id'"),
                ));
            }
            if paths.contains(&path.as_str()) {
                return Err(CommandError::new(
                    40,
                    format!("Updating the path '{path}' would create a conflict at '{path}'"),
                ));
            }
            paths.push(path.as_str());
        }
    }
    Ok(())
}

fn apply_update(
    document: &BsonDocument,
    specification: &BsonDocument,
    identifier: &str,
) -> Result<BsonDocument, CommandError> {
    let mut updated = document.clone();
    for (operator, operand) in &specification.fields {
        let BsonValue::Document(operand) = operand
        else { continue };
        for (path, value) in &operand.fields {
            match operator.as_str() {
                "$set" => set_path(&mut updated, path, value.clone())?,
                "$unset" => {
                    unset_path(&mut updated, path);
                }
                "$inc" => inc_path(&mut updated, path, value, identifier)?,
                _ => {}
            }
        }
    }
    Ok(updated)
}

fn set_path(document: &mut BsonDocument, path: &str, value: BsonValue) -> Result<(), CommandError> {
    match path.split_once('.') {
        None => {
            if let Some(existing) = document.fields.iter_mut().find(|(field, _)| field == path) {
                existing.1 = value;
            }
            else {
                document.push(path.to_string(), value);
            }
            Ok(())
        }
        Some((head, tail)) => {
            if !document.fields.iter().any(|(field, _)| field == head) {
                document.push(head.to_string(), BsonValue::Document(BsonDocument::new()));
            }
            match document.fields.iter_mut().find(|(field, _)| field == head).map(|(_, value)| value) {
                Some(BsonValue::Document(child)) => set_path(child, tail, value),
                _ => Err(CommandError::new(2, format!("cannot create field at path '{path}'"))),
            }
        }
    }
}

fn unset_path(document: &mut BsonDocument, path: &str) {
    match path.split_once('.') {
        None => document.fields.retain(|(field, _)| field != path),
        Some((head, tail)) => {
            if let Some(BsonValue::Document(child)) =
                document.fields.iter_mut().find(|(field, _)| field == head).map(|(_, value)| value)
            {
                unset_path(child, tail);
            }
        }
    }
}

fn inc_path(
    document: &mut BsonDocument,
    path: &str,
    amount: &BsonValue,
    identifier: &str,
) -> Result<(), CommandError> {
    match path.split_once('.') {
        None => {
            let current = document.get(path).cloned();
            match current {
                Some(value) => {
                    let sum = increment_value(&value, amount).ok_or_else(|| {
                        CommandError::new(
                            14,
                            format!("Cannot apply $inc to a value of non-numeric type (field: \"{path}\", _id: {identifier})"),
                        )
                    })?;
                    set_path(document, path, sum)
                }
                None => {
                    if number_of(amount).is_none() {
                        return Err(CommandError::new(
                            14,
                            format!("Cannot apply $inc to a value of non-numeric type (field: \"{path}\", _id: {identifier})"),
                        ));
                    }
                    set_path(document, path, amount.clone())
                }
            }
        }
        Some((head, tail)) => {
            if !document.fields.iter().any(|(field, _)| field == head) {
                document.push(head.to_string(), BsonValue::Document(BsonDocument::new()));
            }
            match document.fields.iter_mut().find(|(field, _)| field == head).map(|(_, value)| value) {
                Some(BsonValue::Document(child)) => inc_path(child, tail, amount, identifier),
                _ => Err(CommandError::new(2, format!("cannot create field at path '{path}'"))),
            }
        }
    }
}

fn increment_value(current: &BsonValue, amount: &BsonValue) -> Option<BsonValue> {
    match (current, amount) {
        (BsonValue::Int32(left), BsonValue::Int32(right)) => {
            let sum = i128::from(*left) + i128::from(*right);
            if let Ok(value) = i32::try_from(sum) {
                Some(BsonValue::Int32(value))
            }
            else {
                i64::try_from(sum).ok().map(BsonValue::Int64)
            }
        }
        (BsonValue::Int32(_) | BsonValue::Int64(_), BsonValue::Int32(_) | BsonValue::Int64(_)) => {
            let sum = integer_of(current)? + integer_of(amount)?;
            i64::try_from(sum).ok().map(BsonValue::Int64)
        }
        (BsonValue::Int32(_) | BsonValue::Int64(_) | BsonValue::Double(_), BsonValue::Double(_))
        | (BsonValue::Double(_), BsonValue::Int32(_) | BsonValue::Int64(_)) => {
            Some(BsonValue::Double(number_of(current)? + number_of(amount)?))
        }
        _ => None,
    }
}

/// `getMore`: drains the caller-owned cursor table.
pub fn get_more(command: &BsonDocument, cursors: &mut CursorStore) -> Result<BsonDocument, CommandError> {
    let Some(cursor_id) = command.get("getMore").and_then(int_value)
    else {
        return Err(CommandError::new(2, "getMore requires a cursor id"));
    };
    let batch_size = parse_count(command.get("batchSize"));
    let (batch, namespace) =
        cursors.get_more(cursor_id, batch_size).map_err(|id| CommandError::new(43, format!("cursor id {id} not found")))?;
    let remaining = if cursors.contains(cursor_id) { cursor_id } else { 0 };
    Ok(cursor_reply(&namespace, "nextBatch", batch, remaining))
}

/// `killCursors`.
pub fn kill_cursors(command: &BsonDocument, cursors: &mut CursorStore) -> Result<BsonDocument, CommandError> {
    let identifiers = match command.get("cursors") {
        Some(BsonValue::Array(identifiers)) => identifiers.clone(),
        _ => Vec::new(),
    };
    let requested: Vec<i64> = identifiers.iter().filter_map(int_value).collect();
    let (killed, not_found) = cursors.kill(&requested);

    let mut response = BsonDocument::new();
    response.push("cursorsKilled".to_string(), BsonValue::Array(killed.into_iter().map(BsonValue::Int64).collect()));
    response.push("cursorsNotFound".to_string(), BsonValue::Array(not_found.into_iter().map(BsonValue::Int64).collect()));
    response.push("cursorsAlive".to_string(), BsonValue::Array(Vec::new()));
    response.push("cursorsUnknown".to_string(), BsonValue::Array(Vec::new()));
    response.push("ok".to_string(), BsonValue::Int32(1));
    Ok(response)
}

/// `listCollections`, backed by the namespaces actually present in storage.
pub fn list_collections(command: &BsonDocument, store: &Store) -> Result<BsonDocument, CommandError> {
    let database = command.database();
    let prefix = format!("{database}.");
    let wanted = match command.get("filter") {
        Some(BsonValue::Document(filter)) => {
            validate_listing_filter(filter)?;
            match filter.get("name") {
                Some(BsonValue::String(name)) => Some(name.clone()),
                _ => None,
            }
        }
        _ => None,
    };

    let mut entries = Vec::new();
    for namespace in store.namespaces() {
        let Some(collection) = namespace.strip_prefix(&prefix)
        else {
            continue;
        };
        if let Some(wanted) = &wanted {
            if collection != wanted {
                continue;
            }
        }
        let mut entry = BsonDocument::new();
        entry.push("name".to_string(), BsonValue::String(collection.to_string()));
        entry.push("type".to_string(), BsonValue::String("collection".to_string()));
        entry.push("options".to_string(), BsonValue::Document(BsonDocument::new()));
        entries.push(BsonValue::Document(entry));
    }

    Ok(cursor_reply(&format!("{database}.$cmd.listCollections"), "firstBatch", entries, 0))
}

/// `listDatabases`, derived from the stored namespaces.
pub fn list_databases(store: &Store) -> BsonDocument {
    let mut names: Vec<String> =
        store.namespaces().iter().filter_map(|namespace| namespace.split_once('.').map(|(db, _)| db.to_string())).collect();
    names.sort();
    names.dedup();

    let databases: Vec<BsonValue> = names
        .into_iter()
        .map(|name| {
            let mut entry = BsonDocument::new();
            entry.push("name".to_string(), BsonValue::String(name));
            entry.push("sizeOnDisk".to_string(), BsonValue::Int64(0));
            entry.push("empty".to_string(), BsonValue::Bool(false));
            BsonValue::Document(entry)
        })
        .collect();

    let mut response = BsonDocument::new();
    response.push("databases".to_string(), BsonValue::Array(databases));
    response.push("totalSize".to_string(), BsonValue::Int64(0));
    response.push("totalSizeMb".to_string(), BsonValue::Int64(0));
    response.push("ok".to_string(), BsonValue::Int32(1));
    response
}

/// Generates a 12-byte ObjectId without any global counter.
pub fn generate_object_id() -> [u8; 12] {
    let seconds = SystemTime::now().duration_since(UNIX_EPOCH).map(|duration| duration.as_secs() as u32).unwrap_or(0);
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|duration| duration.subsec_nanos()).unwrap_or(0);
    let entropy = std::hash::RandomState::new();
    let mut identifier = [0_u8; 12];
    identifier[0..4].copy_from_slice(&seconds.to_be_bytes());
    let random = hash_bytes(&entropy, u64::from(nanos));
    identifier[4..9].copy_from_slice(&random[..5]);
    let tail = hash_bytes(&entropy, u64::from(nanos) ^ 0x9e37_79b9_7f4a_7c15);
    identifier[9..12].copy_from_slice(&tail[..3]);
    identifier
}

fn hash_bytes(state: &std::hash::RandomState, seed: u64) -> [u8; 8] {
    use std::hash::{BuildHasher, Hasher};
    let mut hasher = state.build_hasher();
    hasher.write_u64(seed);
    hasher.finish().to_be_bytes()
}

fn namespace_from_command(document: &BsonDocument, command_key: &str) -> Option<String> {
    let database = document.database();
    let collection = match document.get(command_key) {
        Some(BsonValue::String(collection)) if valid_collection_name(collection) => collection.clone(),
        _ => return None,
    };
    Some(format!("{database}.{collection}"))
}

fn valid_collection_name(name: &str) -> bool {
    if name.is_empty() || name.contains('$') || name.contains('\0') {
        return false;
    }
    if name.starts_with('.') || name.ends_with('.') {
        return false;
    }
    !name.contains("..")
}

fn cursor_reply(namespace: &str, batch_key: &str, batch: Vec<BsonValue>, cursor_id: i64) -> BsonDocument {
    let mut cursor = BsonDocument::new();
    cursor.push(batch_key.to_string(), BsonValue::Array(batch));
    cursor.push("id".to_string(), BsonValue::Int64(cursor_id));
    cursor.push("ns".to_string(), BsonValue::String(namespace.to_string()));

    let mut response = BsonDocument::new();
    response.push("ok".to_string(), BsonValue::Int32(1));
    response.push("cursor".to_string(), BsonValue::Document(cursor));
    response
}

fn collect_matching(
    store: &Store,
    namespace: &str,
    filter: &BsonDocument,
) -> Result<Vec<BsonDocument>, CommandError> {
    if let Some(identifier) = single_id_lookup(filter) {
        let key = value_to_key(identifier);
        return match store.get(namespace, &key) {
            Some(bytes) => match parse_bson(&bytes) {
                Ok(document) if document_matches(&document, filter)? => Ok(vec![document]),
                _ => Ok(Vec::new()),
            },
            None => Ok(Vec::new()),
        };
    }

    let mut documents = Vec::new();
    for (_key, value) in store.scan(namespace) {
        if let Ok(candidate) = parse_bson(&value) {
            if document_matches(&candidate, filter)? {
                documents.push(candidate);
            }
        }
    }
    Ok(documents)
}

fn single_id_lookup(filter: &BsonDocument) -> Option<&BsonValue> {
    if filter.fields.len() != 1 {
        return None;
    }
    let (key, value) = filter.fields.first()?;
    if key != "_id" {
        return None;
    }
    match value {
        BsonValue::Document(operators) if operators.fields.iter().any(|(operator, _)| operator.starts_with('$')) => None,
        _ => Some(value),
    }
}

fn group_documents(documents: &[BsonDocument], specification: &BsonDocument) -> Result<Vec<BsonDocument>, String> {
    let Some(identifier) = specification.get("_id")
    else {
        return Err("$group requires an `_id` expression".to_string());
    };
    if matches!(identifier, BsonValue::Document(_) | BsonValue::Array(_)) {
        return Err("$group only supports a constant `_id`".to_string());
    }

    let mut counters: Vec<String> = Vec::new();
    for (field, accumulator) in specification.fields.iter().filter(|(field, _)| field != "_id") {
        let BsonValue::Document(accumulator) = accumulator
        else {
            return Err(format!("$group field `{field}` is not a `$sum` accumulator"));
        };
        match accumulator.get("$sum") {
            Some(BsonValue::Int32(1) | BsonValue::Int64(1)) => counters.push(field.clone()),
            Some(_) => return Err(format!("$group field `{field}` only supports `$sum: 1`")),
            None => return Err(format!("$group field `{field}` is not a `$sum` accumulator")),
        }
    }
    if counters.is_empty() {
        return Err("$group requires at least one `$sum` accumulator".to_string());
    }
    if documents.is_empty() {
        return Ok(Vec::new());
    }

    let mut grouped = BsonDocument::new();
    grouped.push("_id".to_string(), identifier.clone());
    for field in counters {
        grouped.push(field, count_value(documents.len() as i64));
    }
    Ok(vec![grouped])
}

fn count_value(count: i64) -> BsonValue {
    i32::try_from(count).map(BsonValue::Int32).unwrap_or(BsonValue::Int64(count))
}

fn project_document(document: &BsonDocument, specification: &BsonDocument) -> BsonDocument {
    let inclusion_only = specification.fields.iter().any(|(field, rule)| field != "_id" && rule_is_inclusion(rule));
    let id_excluded = specification.get("_id").map(rule_is_exclusion).unwrap_or(false);
    let mut projected = BsonDocument::new();
    for (field, value) in document.fields.iter() {
        let keep = match specification.get(field) {
            Some(rule) if rule_is_inclusion(rule) => true,
            Some(_) => false,
            None if field == "_id" => !id_excluded,
            None => !inclusion_only,
        };
        if keep {
            projected.push(field.clone(), value.clone());
        }
    }
    projected
}

fn rule_is_inclusion(value: &BsonValue) -> bool {
    matches!(value, BsonValue::Int32(1) | BsonValue::Int64(1) | BsonValue::Bool(true))
        || matches!(value, BsonValue::Double(number) if *number == 1.0)
}

fn rule_is_exclusion(value: &BsonValue) -> bool {
    matches!(value, BsonValue::Int32(0) | BsonValue::Int64(0) | BsonValue::Bool(false))
        || matches!(value, BsonValue::Double(number) if *number == 0.0)
}

fn parse_sort(sort: Option<&BsonValue>) -> Vec<(String, i32)> {
    match sort {
        Some(BsonValue::Document(document)) => document
            .fields
            .iter()
            .filter_map(|(field, direction)| {
                int_value(direction).filter(|value| *value != 0).map(|value| (field.clone(), value as i32))
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn sort_documents(documents: &mut [BsonDocument], sort: &[(String, i32)]) {
    if sort.is_empty() {
        return;
    }
    documents.sort_by(|left, right| compare_documents(left, right, sort));
}

fn compare_documents(left: &BsonDocument, right: &BsonDocument, sort: &[(String, i32)]) -> Ordering {
    for (field, direction) in sort {
        let ordering = match (lookup_field(left, field), lookup_field(right, field)) {
            (Some(left), Some(right)) => compare_values(left, right),
            (Some(_), None) => Ordering::Greater,
            (None, Some(_)) => Ordering::Less,
            (None, None) => Ordering::Equal,
        };
        if ordering != Ordering::Equal {
            return if *direction < 0 { ordering.reverse() } else { ordering };
        }
    }
    Ordering::Equal
}

fn document_matches(document: &BsonDocument, filter: &BsonDocument) -> Result<bool, CommandError> {
    for (field_index, (field, expected)) in filter.fields.iter().enumerate() {
        let (path, operators) = match expected {
            BsonValue::Document(operators) if operators.fields.iter().any(|(operator, _)| operator.starts_with('$')) => {
                (field.as_str(), Some(operators))
            }
            _ => (field.as_str(), None),
        };
        let actual = lookup_field(document, path);
        match operators {
            Some(operators) => {
                for (operator_index, (operator, operand)) in operators.fields.iter().enumerate() {
                    let matched = match operator.as_str() {
                        "$eq" => values_equal(actual, operand),
                        "$ne" => !values_equal(actual, operand),
                        "$gt" => actual.map(|value| compare_values(value, operand)) == Some(Ordering::Greater),
                        "$gte" => matches!(
                            actual.map(|value| compare_values(value, operand)),
                            Some(Ordering::Greater | Ordering::Equal)
                        ),
                        "$lt" => actual.map(|value| compare_values(value, operand)) == Some(Ordering::Less),
                        "$lte" => {
                            matches!(actual.map(|value| compare_values(value, operand)), Some(Ordering::Less | Ordering::Equal))
                        }
                        other => {
                            return Err(unknown_operator(other, "filter", field, field_index, operator_index));
                        }
                    };
                    if !matched {
                        return Ok(false);
                    }
                }
            }
            None => {
                if !values_equal(actual, expected) {
                    return Ok(false);
                }
            }
        }
    }
    Ok(true)
}

fn lookup_field<'a>(document: &'a BsonDocument, path: &str) -> Option<&'a BsonValue> {
    if let Some(value) = document.get(path) {
        return Some(value);
    }
    let (head, tail) = path.split_once('.')?;
    match document.get(head)? {
        BsonValue::Document(inner) => inner.get(tail),
        _ => None,
    }
}

fn values_equal(actual: Option<&BsonValue>, expected: &BsonValue) -> bool {
    match (actual, expected) {
        (None, BsonValue::Null) => true,
        (None, _) => false,
        (Some(left), right) => match (left, right) {
            (BsonValue::Document(left), BsonValue::Document(right)) => encode_bson(left) == encode_bson(right),
            (BsonValue::Array(left), BsonValue::Array(right)) => {
                left.len() == right.len() && left.iter().zip(right.iter()).all(|(left, right)| values_equal(Some(left), right))
            }
            (BsonValue::Null, BsonValue::Null) => true,
            _ => numeric_equal(left, right).unwrap_or_else(|| scalar_key(left) == scalar_key(right)),
        },
    }
}

/// MongoDB compares `int32`, `int64` and `double` by numeric value, so `1`,
/// `NumberLong(1)` and `1.0` are the same value. Integral doubles are compared
/// through their exact integer value, which keeps values above `2^53` exact
/// instead of collapsing them through `f64`.
fn numeric_equal(left: &BsonValue, right: &BsonValue) -> Option<bool> {
    if let (Some(left), Some(right)) = (integer_of(left), integer_of(right)) {
        return Some(left == right);
    }
    let (integer, double) = match (integer_of(left), double_of(right)) {
        (Some(integer), Some(double)) => (integer, double),
        _ => match (double_of(left), integer_of(right)) {
            (Some(double), Some(integer)) => (integer, double),
            _ => return None,
        },
    };
    Some(integral_value(double).map(|exact| i128::from(exact) == integer).unwrap_or(false))
}

fn scalar_key(value: &BsonValue) -> String {
    match value {
        BsonValue::String(text) => format!("s:{text}"),
        BsonValue::Bool(flag) => format!("b:{flag}"),
        BsonValue::ObjectId(bytes) => format!("o:{bytes:?}"),
        BsonValue::Binary(binary) => format!("y:{:02x}:{:?}", binary.subtype, binary.bytes),
        other => format!("x:{other:?}"),
    }
}

fn integer_of(value: &BsonValue) -> Option<i128> {
    match value {
        BsonValue::Int32(number) => Some(i128::from(*number)),
        BsonValue::Int64(number) => Some(i128::from(*number)),
        _ => None,
    }
}

fn double_of(value: &BsonValue) -> Option<f64> {
    match value {
        BsonValue::Double(number) => Some(*number),
        _ => None,
    }
}

fn number_of(value: &BsonValue) -> Option<f64> {
    match value {
        BsonValue::Int32(number) => Some(*number as f64),
        BsonValue::Int64(number) => Some(*number as f64),
        BsonValue::Double(number) => Some(*number),
        _ => None,
    }
}

fn compare_values(left: &BsonValue, right: &BsonValue) -> Ordering {
    let rank = |value: &BsonValue| match value {
        BsonValue::Null => 1,
        BsonValue::Int32(_) | BsonValue::Int64(_) | BsonValue::Double(_) => 2,
        BsonValue::String(_) => 3,
        BsonValue::Document(_) => 4,
        BsonValue::Array(_) => 5,
        BsonValue::Binary(_) => 6,
        BsonValue::ObjectId(_) => 7,
        BsonValue::Bool(_) => 8,
    };
    if rank(left) != rank(right) {
        return rank(left).cmp(&rank(right));
    }
    match (left, right) {
        (BsonValue::Int32(_) | BsonValue::Int64(_) | BsonValue::Double(_), _) => {
            if let (Some(left), Some(right)) = (integer_of(left), integer_of(right)) {
                return left.cmp(&right);
            }
            let left = number_of(left).unwrap_or(0.0);
            let right = number_of(right).unwrap_or(0.0);
            left.partial_cmp(&right).unwrap_or(Ordering::Equal)
        }
        (BsonValue::String(left), BsonValue::String(right)) => left.cmp(right),
        (BsonValue::Bool(left), BsonValue::Bool(right)) => left.cmp(right),
        (BsonValue::ObjectId(left), BsonValue::ObjectId(right)) => left.cmp(right),
        (BsonValue::Binary(left), BsonValue::Binary(right)) => {
            (left.bytes.len(), left.subtype, &left.bytes).cmp(&(right.bytes.len(), right.subtype, &right.bytes))
        }
        (BsonValue::Document(left), BsonValue::Document(right)) => encode_bson(left).cmp(&encode_bson(right)),
        (BsonValue::Array(left), BsonValue::Array(right)) => {
            for (left, right) in left.iter().zip(right.iter()) {
                let ordering = compare_values(left, right);
                if ordering != Ordering::Equal {
                    return ordering;
                }
            }
            left.len().cmp(&right.len())
        }
        _ => Ordering::Equal,
    }
}

fn parse_count(value: Option<&BsonValue>) -> usize {
    value.and_then(int_value).filter(|count| *count > 0).map(|count| count as usize).unwrap_or(0)
}

fn int_value(value: &BsonValue) -> Option<i64> {
    match value {
        BsonValue::Int32(number) => Some(*number as i64),
        BsonValue::Int64(number) => Some(*number),
        BsonValue::Double(number) => Some(*number as i64),
        _ => None,
    }
}
