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
pub const FILTER_OPERATORS: [&str; 16] = [
    "$eq", "$ne", "$gt", "$gte", "$lt", "$lte", "$in", "$nin", "$exists", "$regex", "$options", "$size", "$type",
    "$elemMatch", "$all", "$not",
];

/// Logical operators accepted at the top of a filter.
pub const LOGICAL_OPERATORS: [&str; 3] = ["$and", "$or", "$nor"];

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
            if LOGICAL_OPERATORS.contains(&field.as_str()) {
                let BsonValue::Array(clauses) = expected else {
                    return Err(CommandError::new(
                        2,
                        format!("{field} requires an array of filter documents (operation: {operation}, fieldIndex: {field_index})"),
                    ));
                };
                if clauses.is_empty() {
                    return Err(CommandError::new(
                        2,
                        format!(
                            "{field} with an empty array is not defined by the MongoDB manual; refusing to guess (operation: {operation}, fieldIndex: {field_index})"
                        ),
                    ));
                }
                for (clause_index, clause) in clauses.iter().enumerate() {
                    let BsonValue::Document(clause) = clause else {
                        return Err(CommandError::new(
                            2,
                            format!("{field} element {clause_index} is not a filter document (operation: {operation})"),
                        ));
                    };
                    validate_filter(clause, operation)?;
                }
                continue;
            }
            return Err(CommandError::new(
                2,
                format!("unknown top level operator: {field} (operation: {operation}, fieldIndex: {field_index})"),
            ));
        }
        let BsonValue::Document(operators) = expected else { continue };
        if !has_operator(operators) {
            continue;
        }
        validate_operator_document(operators, operation, field, field_index)?;
    }
    Ok(())
}

fn has_operator(document: &BsonDocument) -> bool {
    document.fields.iter().any(|(field, _)| field.starts_with('$'))
}

fn validate_operator_document(
    operators: &BsonDocument,
    operation: &str,
    field: &str,
    field_index: usize,
) -> Result<(), CommandError> {
    for (operator_index, (operator, operand)) in operators.fields.iter().enumerate() {
        if !FILTER_OPERATORS.contains(&operator.as_str()) {
            return Err(unknown_operator(operator, operation, field, field_index, operator_index));
        }
        let bad = |detail: &str| {
            CommandError::new(
                2,
                format!(
                    "{operator} {detail} (operation: {operation}, field: \"{field}\", fieldIndex: {field_index}, operatorIndex: {operator_index})"
                ),
            )
        };
        match operator.as_str() {
            "$in" | "$nin" => {
                let BsonValue::Array(values) = operand else {
                    return Err(bad("requires an array"));
                };
                if values.is_empty() {
                    return Err(bad("with an empty array is not defined by the MongoDB manual; refusing to guess"));
                }
            }
            "$all" => {
                if !matches!(operand, BsonValue::Array(_)) {
                    return Err(bad("requires an array"));
                }
            }
            "$exists" => {
                if !matches!(operand, BsonValue::Bool(_)) {
                    return Err(bad("requires a boolean"));
                }
            }
            "$size" => {
                if integer_of(operand).filter(|size| *size >= 0).is_none() {
                    return Err(bad("requires a non-negative integer"));
                }
            }
            "$regex" => {
                let BsonValue::String(pattern) = operand else {
                    return Err(bad("requires a string pattern"));
                };
                let options = match operators.get("$options") {
                    Some(BsonValue::String(options)) => options.as_str(),
                    _ => "",
                };
                // Compile during validation: a bad pattern or option must fail even
                // when the collection has no documents to scan.
                compile_regex(pattern, options).map_err(|error| bad(&error.message))?;
            }
            "$options" => {
                if !matches!(operand, BsonValue::String(_)) {
                    return Err(bad("requires a string"));
                }
                if !operators.fields.iter().any(|(name, _)| name == "$regex") {
                    return Err(bad("requires a $regex in the same operator document"));
                }
            }
            "$type" => {
                parse_type_operand(operand).map_err(|error| bad(&error.message))?;
            }
            "$elemMatch" => {
                let BsonValue::Document(specification) = operand else {
                    return Err(bad("requires a document"));
                };
                if has_operator(specification) {
                    validate_operator_document(specification, operation, field, field_index)?;
                } else {
                    validate_filter(specification, operation)?;
                }
            }
            "$not" => {
                let BsonValue::Document(specification) = operand else {
                    return Err(bad("requires an operator document"));
                };
                if !has_operator(specification) || specification.fields.iter().any(|(name, _)| !name.starts_with('$')) {
                    return Err(bad("requires an operator document"));
                }
                validate_operator_document(specification, operation, field, field_index)?;
            }
            _ => {}
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
    let mut window: Vec<BsonValue> = Vec::new();
    for document in documents.into_iter().skip(start).take(end - start) {
        match &projection {
            Some(projection) => {
                if let Some(projected) = project_stage(&[document], projection)?.into_iter().next() {
                    window.push(BsonValue::Document(projected));
                }
            }
            None => window.push(BsonValue::Document(document)),
        }
    }

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
            return Err(CommandError::new(2, "aggregate stage must be a document"));
        };
        if stage_document.fields.len() != 1 {
            return Err(CommandError::new(2, "aggregate stage must contain exactly one field"));
        }
        let Some((name, body)) = stage_document.fields.first()
        else {
            return Err(CommandError::new(2, "aggregate stage is empty"));
        };
        // Each stage consumes the previous stage's output: the pipeline is applied
        // in order, never collected and matched in one pass.
        match name.as_str() {
            "$match" => {
                let BsonValue::Document(filter) = body
                else {
                    return Err(CommandError::new(2, "$match requires a document"));
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
            "$sort" => {
                let BsonValue::Document(specification) = body
                else {
                    return Err(CommandError::new(2, "$sort requires a document"));
                };
                let sort = parse_sort_stage(specification)?;
                sort_documents(&mut documents, &sort);
            }
            "$limit" => {
                let limit = positive_stage_integer("$limit", body)?;
                documents.truncate(limit);
            }
            "$skip" => {
                let skip = positive_stage_integer("$skip", body)?;
                documents = documents.into_iter().skip(skip).collect();
            }
            "$count" => {
                let BsonValue::String(name) = body
                else {
                    return Err(CommandError::new(2, "$count requires a field name string"));
                };
                validate_count_name(name)?;
                // "If the input dataset is empty, $count doesn't return a result."
                if documents.is_empty() {
                    documents.clear();
                } else {
                    let mut counted = BsonDocument::new();
                    counted.push(name.clone(), count_value(documents.len() as i64));
                    documents = vec![counted];
                }
            }
            "$unwind" => documents = unwind_stage(&documents, body)?,
            "$group" => {
                let BsonValue::Document(specification) = body
                else {
                    return Err(CommandError::new(2, "$group requires a document"));
                };
                documents = group_stage(&documents, specification)?;
            }
            "$project" => {
                let BsonValue::Document(specification) = body
                else {
                    return Err(CommandError::new(2, "$project requires a document"));
                };
                documents = project_stage(&documents, specification)?;
            }
            other => return Err(unsupported_stage(other)),
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

/// Thrown for a pipeline stage this gateway does not implement, naming both the
/// stage and the supported surface.
fn unsupported_stage(stage: &str) -> CommandError {
    CommandError::new(
        59,
        format!(
            "unknown aggregation stage: {stage} (supported: $match, $sort, $limit, $skip, $count, $unwind, $group, $project)"
        ),
    )
}

/// `$limit` / `$skip` take a positive integer.
fn positive_stage_integer(stage: &str, value: &BsonValue) -> Result<usize, CommandError> {
    match int_value(value) {
        Some(number) if number > 0 => Ok(number as usize),
        _ => Err(CommandError::new(2, format!("{stage} requires a positive integer"))),
    }
}

/// `$count` output field name: non-empty, no leading `$`, no `.`.
fn validate_count_name(name: &str) -> Result<(), CommandError> {
    if name.is_empty() || name.starts_with('$') || name.contains('.') {
        return Err(CommandError::new(
            2,
            format!("$count output field name `{name}` must be non-empty, must not start with `$` and must not contain `.`"),
        ));
    }
    Ok(())
}

/// `$sort` accepts 1/-1 directions, rejects duplicates and caps the key count at 32.
fn parse_sort_stage(specification: &BsonDocument) -> Result<Vec<(String, i32)>, CommandError> {
    if specification.fields.is_empty() {
        return Err(CommandError::new(2, "$sort requires at least one field"));
    }
    if specification.fields.len() > 32 {
        return Err(CommandError::new(2, "$sort accepts at most 32 keys"));
    }
    let mut sort: Vec<(String, i32)> = Vec::new();
    for (field, direction) in specification.fields.iter() {
        if sort.iter().any(|(existing, _)| existing == field) {
            return Err(CommandError::new(2, format!("$sort field `{field}` appears more than once")));
        }
        match int_value(direction) {
            Some(value) if value == 1 || value == -1 => sort.push((field.clone(), value as i32)),
            _ => return Err(CommandError::new(2, format!("$sort direction for `{field}` must be 1 or -1"))),
        }
    }
    Ok(sort)
}

/// Sorts one stage input. Array fields use the lowest element ascending and the
/// highest element descending, as the `$sort` page specifies.
fn sort_key(document: &BsonDocument, path: &str, direction: i32) -> BsonValue {
    let value = lookup_field(document, path);
    let Some(value) = value else {
        // Missing fields compare like null; the manual states two documents that
        // both lack the field sort on "the same" value.
        return BsonValue::Null;
    };
    match value {
        BsonValue::Array(items) if !items.is_empty() => {
            let mut keys = items.iter();
            let mut chosen = keys.next().unwrap().clone();
            for item in keys {
                let ordering = compare_values(&chosen, item);
                if (direction >= 0 && ordering == Ordering::Greater) || (direction < 0 && ordering == Ordering::Less) {
                    chosen = item.clone();
                }
            }
            chosen
        }
        other => other.clone(),
    }
}

/// `$unwind`: string form drops null/missing/empty-array documents; the document
/// form adds `preserveNullAndEmptyArrays` and `includeArrayIndex`.
fn unwind_stage(documents: &[BsonDocument], body: &BsonValue) -> Result<Vec<BsonDocument>, CommandError> {
    let (path, preserve, index_field) = match body {
        BsonValue::String(path) => (unwind_path(path)?, false, None),
        BsonValue::Document(specification) => {
            let BsonValue::String(path) = specification.get("path").unwrap_or(&BsonValue::Null) else {
                return Err(CommandError::new(2, "$unwind requires a `path` string"));
            };
            let path = unwind_path(path)?;
            let preserve = match specification.get("preserveNullAndEmptyArrays") {
                None => false,
                Some(BsonValue::Bool(flag)) => *flag,
                Some(_) => return Err(CommandError::new(2, "$unwind `preserveNullAndEmptyArrays` must be a boolean")),
            };
            let index_field = match specification.get("includeArrayIndex") {
                None => None,
                Some(BsonValue::String(field)) if !field.is_empty() && !field.starts_with('$') => Some(field.clone()),
                Some(_) => {
                    return Err(CommandError::new(
                        2,
                        "$unwind `includeArrayIndex` must be a non-empty string that does not start with `$`",
                    ));
                }
            };
            (path, preserve, index_field)
        }
        _ => return Err(CommandError::new(2, "$unwind requires a path string or a document")),
    };

    let mut output = Vec::new();
    for document in documents {
        let value = lookup_field(document, &path).cloned();
        match value {
            Some(BsonValue::Array(items)) if !items.is_empty() => {
                for (index, item) in items.into_iter().enumerate() {
                    let mut expanded = document.clone();
                    set_field_path(&mut expanded, &path, item);
                    if let Some(field) = &index_field {
                        expanded.push(field.clone(), BsonValue::Int64(index as i64));
                    }
                    output.push(expanded);
                }
            }
            Some(BsonValue::Array(_)) => {
                // Empty array: preserved only with the flag, and then the path is omitted.
                if preserve {
                    let mut expanded = document.clone();
                    remove_field_path(&mut expanded, &path);
                    if let Some(field) = &index_field {
                        expanded.push(field.clone(), BsonValue::Null);
                    }
                    output.push(expanded);
                }
            }
            Some(BsonValue::Null) => {
                if preserve {
                    let mut expanded = document.clone();
                    if let Some(field) = &index_field {
                        expanded.push(field.clone(), BsonValue::Null);
                    }
                    output.push(expanded);
                }
            }
            None => {
                if preserve {
                    let mut expanded = document.clone();
                    if let Some(field) = &index_field {
                        expanded.push(field.clone(), BsonValue::Null);
                    }
                    output.push(expanded);
                }
            }
            Some(scalar) => {
                let mut expanded = document.clone();
                set_field_path(&mut expanded, &path, scalar);
                if let Some(field) = &index_field {
                    expanded.push(field.clone(), BsonValue::Null);
                }
                output.push(expanded);
            }
        }
    }
    Ok(output)
}

fn unwind_path(path: &str) -> Result<String, CommandError> {
    match path.strip_prefix('$') {
        Some(rest) if !rest.is_empty() => Ok(rest.to_string()),
        _ => Err(CommandError::new(2, "$unwind path must start with `$`")),
    }
}

/// Accumulator kinds backed by a documented behavior sentence.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AccumulatorKind {
    Sum,
    Avg,
    Min,
    Max,
    Push,
    AddToSet,
    First,
    Last,
}

impl AccumulatorKind {
    fn parse(operator: &str) -> Option<Self> {
        match operator {
            "$sum" => Some(Self::Sum),
            "$avg" => Some(Self::Avg),
            "$min" => Some(Self::Min),
            "$max" => Some(Self::Max),
            "$push" => Some(Self::Push),
            "$addToSet" => Some(Self::AddToSet),
            "$first" => Some(Self::First),
            "$last" => Some(Self::Last),
            _ => None,
        }
    }
}

struct Accumulator {
    field: String,
    kind: AccumulatorKind,
    argument: BsonValue,
}

/// `$group` groups by `_id` (null, constant, or `"$field"`) and applies the
/// supported accumulators to each group. Output order is unspecified by the
/// manual, so callers must sort if they need one.
fn group_stage(documents: &[BsonDocument], specification: &BsonDocument) -> Result<Vec<BsonDocument>, CommandError> {
    let Some(identifier) = specification.get("_id") else {
        return Err(CommandError::new(2, "$group requires an `_id` expression"));
    };
    match identifier {
        BsonValue::Document(_) => {
            return Err(CommandError::new(
                59,
                "$group `_id` document expressions are not implemented; use null, a constant, or a \"$field\" path",
            ));
        }
        BsonValue::Array(_) => {
            return Err(CommandError::new(
                59,
                "$group `_id` array expressions are not implemented; use null, a constant, or a \"$field\" path",
            ));
        }
        _ => {}
    }

    let mut accumulators: Vec<Accumulator> = Vec::new();
    for (field, accumulator) in specification.fields.iter().filter(|(field, _)| field != "_id") {
        let BsonValue::Document(operator_document) = accumulator
        else {
            return Err(CommandError::new(2, format!("$group field `{field}` must be an accumulator document")));
        };
        if operator_document.fields.len() != 1 {
            return Err(CommandError::new(2, format!("$group field `{field}` must contain exactly one accumulator")));
        }
        let (operator, argument) = &operator_document.fields[0];
        let Some(kind) = AccumulatorKind::parse(operator) else {
            return Err(CommandError::new(
                59,
                format!(
                    "unknown accumulator: {operator} (supported: $sum, $avg, $min, $max, $push, $addToSet, $first, $last)"
                ),
            ));
        };
        accumulators.push(Accumulator { field: field.clone(), kind, argument: argument.clone() });
    }

    // "If there are no documents from the prior pipeline stage, the $group stage
    // returns nothing."
    if documents.is_empty() {
        return Ok(Vec::new());
    }

    let mut groups: Vec<(BsonValue, Vec<usize>)> = Vec::new();
    for (index, document) in documents.iter().enumerate() {
        let key = evaluate_group_id(document, identifier);
        match groups.iter_mut().find(|(existing, _)| values_equal(Some(existing), &key)) {
            Some((_, members)) => members.push(index),
            None => groups.push((key, vec![index])),
        }
    }

    let mut output = Vec::new();
    for (key, members) in groups {
        let mut grouped = BsonDocument::new();
        grouped.push("_id".to_string(), key);
        for accumulator in &accumulators {
            grouped.push(accumulator.field.clone(), accumulate(accumulator, documents, &members)?);
        }
        output.push(grouped);
    }
    Ok(output)
}

fn evaluate_group_id(document: &BsonDocument, identifier: &BsonValue) -> BsonValue {
    match identifier {
        BsonValue::String(path) if path.starts_with('$') => {
            lookup_field(document, &path[1..]).cloned().unwrap_or(BsonValue::Null)
        }
        other => other.clone(),
    }
}

fn accumulate(accumulator: &Accumulator, documents: &[BsonDocument], members: &[usize]) -> Result<BsonValue, CommandError> {
    // `$push` and `$addToSet` skip a missing field entirely while still keeping an
    // explicit `null`; every other accumulator treats missing as `null`.
    let optional_values: Vec<Option<BsonValue>> = members
        .iter()
        .map(|index| evaluate_expression_optional(&documents[*index], &accumulator.argument))
        .collect::<Result<Vec<_>, _>>()?;
    let values: Vec<BsonValue> = optional_values.iter().cloned().map(|value| value.unwrap_or(BsonValue::Null)).collect();

    match accumulator.kind {
        AccumulatorKind::Sum => {
            let mut total: i128 = 0;
            let mut double_total: Option<f64> = None;
            for value in values {
                match value {
                    BsonValue::Int32(number) => total += i128::from(number),
                    BsonValue::Int64(number) => total += i128::from(number),
                    BsonValue::Double(number) => *double_total.get_or_insert(0.0) += number,
                    // "$sum ignores the non-numeric values"
                    _ => {}
                }
            }
            Ok(match double_total {
                Some(double) => BsonValue::Double(double + total as f64),
                None => match i64::try_from(total) {
                    Ok(exact) => count_value(exact),
                    Err(_) => BsonValue::Double(total as f64),
                },
            })
        }
        AccumulatorKind::Avg => {
            let mut total = 0.0_f64;
            let mut count = 0_u64;
            for value in values {
                if let Some(number) = number_of(&value) {
                    total += number;
                    count += 1;
                }
            }
            // "$avg returns null if all input values are non-numeric"
            Ok(if count == 0 { BsonValue::Null } else { BsonValue::Double(total / count as f64) })
        }
        AccumulatorKind::Min | AccumulatorKind::Max => {
            let wanted = if accumulator.kind == AccumulatorKind::Min { Ordering::Less } else { Ordering::Greater };
            let mut chosen: Option<BsonValue> = None;
            for value in values {
                // "$min/$max ignore null or missing values"
                if matches!(value, BsonValue::Null) {
                    continue;
                }
                chosen = Some(match chosen {
                    None => value,
                    Some(current) => {
                        if compare_values(&value, &current) == wanted {
                            value
                        } else {
                            current
                        }
                    }
                });
            }
            Ok(chosen.unwrap_or(BsonValue::Null))
        }
        AccumulatorKind::Push => Ok(BsonValue::Array(optional_values.into_iter().flatten().collect())),
        AccumulatorKind::AddToSet => {
            let mut unique: Vec<BsonValue> = Vec::new();
            for value in optional_values.into_iter().flatten() {
                if !unique.iter().any(|existing| values_equal(Some(existing), &value)) {
                    unique.push(value);
                }
            }
            Ok(BsonValue::Array(unique))
        }
        AccumulatorKind::First => Ok(values.first().cloned().unwrap_or(BsonValue::Null)),
        AccumulatorKind::Last => Ok(values.last().cloned().unwrap_or(BsonValue::Null)),
    }
}

fn project_stage(documents: &[BsonDocument], specification: &BsonDocument) -> Result<Vec<BsonDocument>, CommandError> {
    // The projection mode is fixed by the first non-`_id` field, and a later
    // field of the other mode is rejected with the same code and message as
    // `mongod 8.0.9`. Boolean/numeric `_id` rules never count as a conflict.
    let mut exclusion_projection: Option<bool> = None;
    for (field, rule) in specification.fields.iter() {
        if field == "_id" && (rule_is_exclusion(rule) || rule_is_inclusion(rule)) {
            continue;
        }
        let is_exclusion = rule_is_exclusion(rule);
        match exclusion_projection {
            None => exclusion_projection = Some(is_exclusion),
            Some(true) if !is_exclusion => {
                if rule_is_inclusion(rule) {
                    return Err(CommandError::new(
                        31253,
                        format!("Invalid $project :: caused by :: Cannot do inclusion on field {field} in exclusion projection"),
                    ));
                }
                return Err(CommandError::new(
                    31252,
                    "Invalid $project :: caused by :: Cannot use expression other than $meta in exclusion projection".to_string(),
                ));
            }
            Some(false) if is_exclusion => {
                return Err(CommandError::new(
                    31254,
                    format!("Invalid $project :: caused by :: Cannot do exclusion on field {field} in inclusion projection"),
                ));
            }
            _ => {}
        }
    }
    let has_exclusion = exclusion_projection.unwrap_or(false);
    if has_exclusion {
        let mut projected = Vec::new();
        for document in documents {
            let mut kept = document.clone();
            for (field, rule) in specification.fields.iter() {
                if rule_is_exclusion(rule) {
                    remove_field_path(&mut kept, field);
                }
            }
            projected.push(kept);
        }
        return Ok(projected);
    }

    let id_excluded = specification.get("_id").map(rule_is_exclusion).unwrap_or(false);
    let mut projected = Vec::new();
    for document in documents {
        let mut result = BsonDocument::new();
        if !id_excluded {
            if let Some(identifier) = document.get("_id") {
                result.push("_id".to_string(), identifier.clone());
            }
        }
        for (field, rule) in specification.fields.iter() {
            if field == "_id" {
                continue;
            }
            if rule_is_inclusion(rule) {
                if let Some(value) = lookup_field(document, field) {
                    set_field_path(&mut result, field, value.clone());
                }
                continue;
            }
            if rule_is_exclusion(rule) {
                continue;
            }
            let value = evaluate_expression(document, rule)?;
            set_field_path(&mut result, field, value);
        }
        projected.push(result);
    }
    Ok(projected)
}

/// Minimal fixpoint helpers used by `$project`, `$unwind` and `$sort`.
fn set_field_path(document: &mut BsonDocument, path: &str, value: BsonValue) {
    let (head, tail) = match path.split_once('.') {
        Some((head, tail)) => (head, tail),
        None => {
            if let Some(entry) = document.fields.iter_mut().find(|(key, _)| key == path) {
                entry.1 = value;
            } else {
                document.push(path.to_string(), value);
            }
            return;
        }
    };
    if let Some(entry) = document.fields.iter_mut().find(|(key, _)| key == head) {
        if let BsonValue::Document(inner) = &mut entry.1 {
            set_field_path(inner, tail, value);
            return;
        }
    }
    let mut nested = BsonDocument::new();
    set_field_path(&mut nested, tail, value);
    document.push(head.to_string(), BsonValue::Document(nested));
}

fn remove_field_path(document: &mut BsonDocument, path: &str) {
    match path.split_once('.') {
        None => document.fields.retain(|(key, _)| key != path),
        Some((head, tail)) => {
            if let Some(entry) = document.fields.iter_mut().find(|(key, _)| key == head) {
                if let BsonValue::Document(inner) = &mut entry.1 {
                    remove_field_path(inner, tail);
                }
            }
        }
    }
}

/// A field-path expression evaluates to `None` when the field is missing, so
/// `$push` / `$addToSet` can skip it instead of turning it into `null`.
fn evaluate_expression_optional(document: &BsonDocument, expression: &BsonValue) -> Result<Option<BsonValue>, CommandError> {
    match expression {
        BsonValue::String(path) if path.starts_with('$') => Ok(lookup_field(document, &path[1..]).cloned()),
        other => evaluate_expression(document, other).map(Some),
    }
}

fn evaluate_expression(document: &BsonDocument, expression: &BsonValue) -> Result<BsonValue, CommandError> {
    match expression {
        BsonValue::String(path) if path.starts_with('$') => {
            Ok(lookup_field(document, &path[1..]).cloned().unwrap_or(BsonValue::Null))
        }
        BsonValue::Document(operator_document)
            if operator_document.fields.len() == 1 && operator_document.fields[0].0.starts_with('$') =>
        {
            let (operator, argument) = &operator_document.fields[0];
            match operator.as_str() {
                "$add" => {
                    let BsonValue::Array(arguments) = argument else {
                        return Err(CommandError::new(2, "$add requires an array of expressions"));
                    };
                    let mut total: i128 = 0;
                    let mut double_total: Option<f64> = None;
                    for expression in arguments {
                        match evaluate_expression(document, expression)? {
                            BsonValue::Int32(number) => total += i128::from(number),
                            BsonValue::Int64(number) => total += i128::from(number),
                            BsonValue::Double(number) => *double_total.get_or_insert(0.0) += number,
                            other => {
                                return Err(CommandError::new(2, format!("$add requires numeric arguments, got {other:?}")));
                            }
                        }
                    }
                    Ok(match double_total {
                        Some(double) => BsonValue::Double(double + total as f64),
                        None => match i64::try_from(total) {
                            Ok(exact) => count_value(exact),
                            Err(_) => BsonValue::Double(total as f64),
                        },
                    })
                }
                "$concat" => {
                    let BsonValue::Array(arguments) = argument else {
                        return Err(CommandError::new(2, "$concat requires an array of expressions"));
                    };
                    let mut joined = String::new();
                    for expression in arguments {
                        match evaluate_expression(document, expression)? {
                            BsonValue::String(text) => joined.push_str(&text),
                            // "$concat returns null if any argument is null or missing"
                            BsonValue::Null => return Ok(BsonValue::Null),
                            other => {
                                return Err(CommandError::new(2, format!("$concat requires string arguments, got {other:?}")));
                            }
                        }
                    }
                    Ok(BsonValue::String(joined))
                }
                "$ifNull" => {
                    let BsonValue::Array(arguments) = argument else {
                        return Err(CommandError::new(2, "$ifNull requires an array of expressions"));
                    };
                    if arguments.len() < 2 {
                        return Err(CommandError::new(2, "$ifNull requires at least two arguments"));
                    }
                    for expression in arguments {
                        let value = evaluate_expression(document, expression)?;
                        if !matches!(value, BsonValue::Null) {
                            return Ok(value);
                        }
                    }
                    Ok(BsonValue::Null)
                }
                other => Err(CommandError::new(
                    59,
                    format!("unknown $project expression: {other} (supported: $add, $concat, $ifNull)"),
                )),
            }
        }
        other => Ok(other.clone()),
    }
}

fn rule_is_inclusion(value: &BsonValue) -> bool {
    matches!(value, BsonValue::Int32(1) | BsonValue::Int64(1) | BsonValue::Bool(true))
        || matches!(value, BsonValue::Double(number) if *number == 1.0)
}

fn rule_is_exclusion(value: &BsonValue) -> bool {
    matches!(value, BsonValue::Int32(0) | BsonValue::Int64(0) | BsonValue::Bool(false))
        || matches!(value, BsonValue::Double(number) if *number == 0.0)
}

fn count_value(count: i64) -> BsonValue {
    i32::try_from(count).map(BsonValue::Int32).unwrap_or(BsonValue::Int64(count))
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
    documents.sort_by(|left, right| {
        for (field, direction) in sort {
            let ordering = compare_values(&sort_key(left, field, *direction), &sort_key(right, field, *direction));
            if ordering != Ordering::Equal {
                return if *direction < 0 { ordering.reverse() } else { ordering };
            }
        }
        Ordering::Equal
    });
}

fn document_matches(document: &BsonDocument, filter: &BsonDocument) -> Result<bool, CommandError> {
    for (field_index, (field, expected)) in filter.fields.iter().enumerate() {
        match field.as_str() {
            "$and" => {
                let BsonValue::Array(clauses) = expected else {
                    return Err(CommandError::new(2, format!("$and requires an array of filter documents (fieldIndex: {field_index})")));
                };
                for clause in clauses {
                    let BsonValue::Document(clause) = clause else {
                        return Err(CommandError::new(2, format!("$and requires filter documents (fieldIndex: {field_index})")));
                    };
                    if !document_matches(document, clause)? {
                        return Ok(false);
                    }
                }
            }
            "$or" => {
                let BsonValue::Array(clauses) = expected else {
                    return Err(CommandError::new(2, format!("$or requires an array of filter documents (fieldIndex: {field_index})")));
                };
                let mut matched = false;
                for clause in clauses {
                    let BsonValue::Document(clause) = clause else {
                        return Err(CommandError::new(2, format!("$or requires filter documents (fieldIndex: {field_index})")));
                    };
                    if document_matches(document, clause)? {
                        matched = true;
                        break;
                    }
                }
                if !matched {
                    return Ok(false);
                }
            }
            "$nor" => {
                let BsonValue::Array(clauses) = expected else {
                    return Err(CommandError::new(2, format!("$nor requires an array of filter documents (fieldIndex: {field_index})")));
                };
                for clause in clauses {
                    let BsonValue::Document(clause) = clause else {
                        return Err(CommandError::new(2, format!("$nor requires filter documents (fieldIndex: {field_index})")));
                    };
                    if document_matches(document, clause)? {
                        return Ok(false);
                    }
                }
            }
            _ if field.starts_with('$') => {
                return Err(CommandError::new(
                    2,
                    format!("unknown top level operator: {field} (fieldIndex: {field_index})"),
                ));
            }
            _ => {
                let candidates = collect_field(document, field);
                let matched = match expected {
                    BsonValue::Document(operators) if has_operator(operators) => {
                        operator_matches(&candidates, operators, field, field_index)?
                    }
                    _ => equality_candidates(&candidates, expected),
                };
                if !matched {
                    return Ok(false);
                }
            }
        }
    }
    Ok(true)
}

/// Resolves a (possibly dotted) field path into every value the path selects.
///
/// A dotted segment below an array descends into every element, which is what
/// lets `a.b` match an array of documents; an all-digit segment indexes the
/// array instead. A missing path yields no candidates, which is how `$exists:
/// false`, `{a: null}` and `$nin` tell "absent" apart from "explicit null".
fn collect_field<'a>(document: &'a BsonDocument, path: &str) -> Vec<&'a BsonValue> {
    if let Some(value) = document.get(path) {
        return vec![value];
    }
    let segments: Vec<&str> = path.split('.').collect();
    let mut values = Vec::new();
    if let Some(first) = document.get(segments[0]) {
        descend(first, &segments[1..], &mut values);
    }
    values
}

fn descend<'a>(value: &'a BsonValue, segments: &[&str], values: &mut Vec<&'a BsonValue>) {
    if segments.is_empty() {
        values.push(value);
        return;
    }
    match value {
        BsonValue::Document(document) => {
            if let Some(next) = document.get(segments[0]) {
                descend(next, &segments[1..], values);
            }
        }
        BsonValue::Array(items) => {
            if let Ok(index) = segments[0].parse::<usize>() {
                if let Some(next) = items.get(index) {
                    descend(next, &segments[1..], values);
                }
            } else {
                for item in items {
                    descend(item, segments, values);
                }
            }
        }
        _ => {}
    }
}

fn operator_matches(
    candidates: &[&BsonValue],
    operators: &BsonDocument,
    field: &str,
    field_index: usize,
) -> Result<bool, CommandError> {
    let options = match operators.get("$options") {
        Some(BsonValue::String(options)) => options.as_str(),
        _ => "",
    };
    for (operator_index, (operator, operand)) in operators.fields.iter().enumerate() {
        if operator == "$options" {
            continue;
        }
        let matched = match operator.as_str() {
            "$eq" => equality_candidates(candidates, operand),
            "$ne" => !equality_candidates(candidates, operand),
            "$gt" => comparison_candidates(candidates, operand, |ordering| ordering == Ordering::Greater),
            "$gte" => comparison_candidates(candidates, operand, |ordering| ordering != Ordering::Less),
            "$lt" => comparison_candidates(candidates, operand, |ordering| ordering == Ordering::Less),
            "$lte" => comparison_candidates(candidates, operand, |ordering| ordering != Ordering::Greater),
            "$in" => in_candidates(candidates, operand),
            "$nin" => !in_candidates(candidates, operand),
            "$exists" => exists_candidates(candidates, operand),
            "$regex" => regex_candidates(candidates, operand, options)?,
            "$size" => size_candidates(candidates, operand),
            "$type" => type_candidates(candidates, operand)?,
            "$elemMatch" => elem_match_candidates(candidates, operand)?,
            "$all" => all_candidates(candidates, operand)?,
            "$not" => not_candidates(candidates, operand)?,
            other => return Err(unknown_operator(other, "filter", field, field_index, operator_index)),
        };
        if !matched {
            return Ok(false);
        }
    }
    Ok(true)
}

fn equality_candidates(candidates: &[&BsonValue], expected: &BsonValue) -> bool {
    if candidates.is_empty() {
        return matches!(expected, BsonValue::Null);
    }
    candidates.iter().any(|candidate| equality_one(candidate, expected))
}

fn equality_one(candidate: &BsonValue, expected: &BsonValue) -> bool {
    if values_equal(Some(candidate), expected) {
        return true;
    }
    match (candidate, expected) {
        (BsonValue::Array(items), _) => items.iter().any(|item| values_equal(Some(item), expected)),
        _ => false,
    }
}

fn in_candidates(candidates: &[&BsonValue], operand: &BsonValue) -> bool {
    let BsonValue::Array(values) = operand else { return false };
    // One `$eq` predicate per list element, so `$in` containing `null` also
    // matches a missing field exactly like `{field: null}` does.
    values.iter().any(|value| equality_candidates(candidates, value))
}

fn exists_candidates(candidates: &[&BsonValue], operand: &BsonValue) -> bool {
    let BsonValue::Bool(exists) = operand else { return false };
    candidates.is_empty() != *exists
}

fn comparison_candidates(
    candidates: &[&BsonValue],
    operand: &BsonValue,
    accept: impl Fn(Ordering) -> bool,
) -> bool {
    candidates.iter().any(|candidate| {
        if same_type_bracket(candidate, operand) && accept(compare_values(candidate, operand)) {
            return true;
        }
        if let BsonValue::Array(items) = candidate {
            return items
                .iter()
                .any(|item| same_type_bracket(item, operand) && accept(compare_values(item, operand)));
        }
        false
    })
}

/// Comparison operators are type-bracketed: `{$gt: 5}` never matches a string,
/// even though strings sort after numbers in BSON order.
fn same_type_bracket(left: &BsonValue, right: &BsonValue) -> bool {
    value_rank(left) == value_rank(right)
}

fn regex_candidates(candidates: &[&BsonValue], operand: &BsonValue, options: &str) -> Result<bool, CommandError> {
    let BsonValue::String(pattern) = operand else { return Ok(false) };
    let regex = compile_regex(pattern, options)?;
    Ok(candidates.iter().any(|candidate| match candidate {
        BsonValue::String(text) => regex.is_match(text),
        BsonValue::Array(items) => items
            .iter()
            .any(|item| matches!(item, BsonValue::String(text) if regex.is_match(text))),
        _ => false,
    }))
}

fn compile_regex(pattern: &str, options: &str) -> Result<regex::Regex, CommandError> {
    let mut builder = regex::RegexBuilder::new(pattern);
    for option in options.chars() {
        match option {
            'i' => {
                builder.case_insensitive(true);
            }
            'm' => {
                builder.multi_line(true);
            }
            's' => {
                builder.dot_matches_new_line(true);
            }
            'x' => {
                builder.ignore_whitespace(true);
            }
            // `u` is documented as accepted but redundant for UTF-8 strings.
            'u' => {}
            other => return Err(CommandError::new(2, format!("unsupported $regex option: {other}"))),
        }
    }
    builder
        .build()
        .map_err(|error| CommandError::new(2, format!("invalid $regex pattern: {error}")))
}

fn size_candidates(candidates: &[&BsonValue], operand: &BsonValue) -> bool {
    let Some(size) = integer_of(operand) else { return false };
    candidates
        .iter()
        .any(|candidate| matches!(candidate, BsonValue::Array(items) if items.len() as i128 == size))
}

fn all_candidates(candidates: &[&BsonValue], operand: &BsonValue) -> Result<bool, CommandError> {
    let BsonValue::Array(values) = operand else { return Ok(false) };
    // The manual states an empty `$all` array matches no documents.
    if values.is_empty() {
        return Ok(false);
    }
    for candidate in candidates {
        let BsonValue::Array(items) = candidate else {
            if values.len() == 1 && equality_one(candidate, &values[0]) {
                return Ok(true);
            }
            continue;
        };
        let mut matches_all = true;
        for value in values {
            let satisfied = match value {
                BsonValue::Document(entry) if entry.fields.len() == 1 && entry.get("$elemMatch").is_some() => {
                    elem_match_candidates(&[*candidate], entry.get("$elemMatch").unwrap())?
                }
                _ => items.iter().any(|item| values_equal(Some(item), value)),
            };
            if !satisfied {
                matches_all = false;
                break;
            }
        }
        if matches_all {
            return Ok(true);
        }
    }
    Ok(false)
}

fn elem_match_candidates(candidates: &[&BsonValue], operand: &BsonValue) -> Result<bool, CommandError> {
    let BsonValue::Document(specification) = operand else { return Ok(false) };
    let operator_form = has_operator(specification);
    for candidate in candidates {
        let BsonValue::Array(items) = candidate else { continue };
        for item in items {
            let matched = if operator_form {
                operator_matches(&[item], specification, "filter", 0)?
            } else {
                match item {
                    BsonValue::Document(document) => document_matches(document, specification)?,
                    _ => false,
                }
            };
            if matched {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

fn not_candidates(candidates: &[&BsonValue], operand: &BsonValue) -> Result<bool, CommandError> {
    let BsonValue::Document(specification) = operand else { return Ok(false) };
    Ok(!operator_matches(candidates, specification, "filter", 0)?)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TypeFilter {
    Number,
    Null,
    Bool,
    Int32,
    Int64,
    Double,
    String,
    Document,
    Array,
    Binary,
    ObjectId,
    Never,
}

fn parse_type_operand(operand: &BsonValue) -> Result<Vec<TypeFilter>, CommandError> {
    match operand {
        BsonValue::Array(values) => values.iter().map(parse_type_value).collect(),
        other => Ok(vec![parse_type_value(other)?]),
    }
}

fn parse_type_value(value: &BsonValue) -> Result<TypeFilter, CommandError> {
    if let BsonValue::String(name) = value {
        let filter = match name.as_str() {
            "double" => TypeFilter::Double,
            "string" => TypeFilter::String,
            "object" => TypeFilter::Document,
            "array" => TypeFilter::Array,
            "binData" => TypeFilter::Binary,
            "objectId" => TypeFilter::ObjectId,
            "bool" => TypeFilter::Bool,
            "null" => TypeFilter::Null,
            "int" => TypeFilter::Int32,
            "long" => TypeFilter::Int64,
            "number" => TypeFilter::Number,
            // Documented BSON types this store cannot hold: the query is valid
            // but can never match, exactly like a real server with no such value.
            "undefined" | "date" | "regex" | "dbPointer" | "javascript" | "symbol" | "javascriptWithScope"
            | "timestamp" | "decimal" | "minKey" | "maxKey" => TypeFilter::Never,
            other => return Err(CommandError::new(2, format!("unknown $type alias: {other}"))),
        };
        return Ok(filter);
    }
    let code = integer_of(value).ok_or_else(|| CommandError::new(2, "$type requires a type alias or a BSON type code"))?;
    let filter = match code {
        1 => TypeFilter::Double,
        2 => TypeFilter::String,
        3 => TypeFilter::Document,
        4 => TypeFilter::Array,
        5 => TypeFilter::Binary,
        7 => TypeFilter::ObjectId,
        8 => TypeFilter::Bool,
        10 => TypeFilter::Null,
        16 => TypeFilter::Int32,
        18 => TypeFilter::Int64,
        6 | 9 | 11 | 12 | 13 | 14 | 15 | 17 | 19 | -1 | 127 => TypeFilter::Never,
        other => return Err(CommandError::new(2, format!("unknown $type code: {other}"))),
    };
    Ok(filter)
}

fn type_candidates(candidates: &[&BsonValue], operand: &BsonValue) -> Result<bool, CommandError> {
    let filters = parse_type_operand(operand)?;
    let wanted = |value: &BsonValue| filters.iter().any(|filter| type_filter_matches(value, *filter));
    Ok(candidates.iter().any(|candidate| {
        if wanted(candidate) {
            return true;
        }
        match candidate {
            BsonValue::Array(items) => items.iter().any(|item| wanted(item)),
            _ => false,
        }
    }))
}

fn type_filter_matches(value: &BsonValue, filter: TypeFilter) -> bool {
    match filter {
        TypeFilter::Number => matches!(value, BsonValue::Int32(_) | BsonValue::Int64(_) | BsonValue::Double(_)),
        TypeFilter::Null => matches!(value, BsonValue::Null),
        TypeFilter::Bool => matches!(value, BsonValue::Bool(_)),
        TypeFilter::Int32 => matches!(value, BsonValue::Int32(_)),
        TypeFilter::Int64 => matches!(value, BsonValue::Int64(_)),
        TypeFilter::Double => matches!(value, BsonValue::Double(_)),
        TypeFilter::String => matches!(value, BsonValue::String(_)),
        TypeFilter::Document => matches!(value, BsonValue::Document(_)),
        TypeFilter::Array => matches!(value, BsonValue::Array(_)),
        TypeFilter::Binary => matches!(value, BsonValue::Binary(_)),
        TypeFilter::ObjectId => matches!(value, BsonValue::ObjectId(_)),
        TypeFilter::Never => false,
    }
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

/// BSON sort order between the value types this store can hold.
fn value_rank(value: &BsonValue) -> u8 {
    match value {
        BsonValue::Null => 1,
        BsonValue::Int32(_) | BsonValue::Int64(_) | BsonValue::Double(_) => 2,
        BsonValue::String(_) => 3,
        BsonValue::Document(_) => 4,
        BsonValue::Array(_) => 5,
        BsonValue::Binary(_) => 6,
        BsonValue::ObjectId(_) => 7,
        BsonValue::Bool(_) => 8,
    }
}

fn compare_values(left: &BsonValue, right: &BsonValue) -> Ordering {
    let rank = value_rank;
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
