//! Individual command primitives.
//!
//! Every function here is callable on its own by a library user: nothing is
//! dispatched through a hidden entry point and no state is global. Hosts compose
//! these primitives into their own server loop and CLI.

use std::{
    cmp::Ordering,
    collections::{BTreeMap, BTreeSet},
    time::{SystemTime, UNIX_EPOCH},
};

use database_protocol_mongo::bson::{
    BinaryData, BsonDocument, BsonValue, encode_bson, integral_value, parse_bson, value_to_key,
};

use crate::{
    cursor::CursorStore,
    json,
    store::{CollectionOptions, IndexSpec, Store},
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
pub const UPDATE_OPERATORS: [&str; 9] =
    ["$set", "$unset", "$inc", "$mul", "$rename", "$push", "$pop", "$addToSet", "$pull"];

/// Command failure carrying the MongoDB error code.
#[derive(Debug, Clone, PartialEq)]
pub struct CommandError {
    /// MongoDB error code (`59` unsupported, `73` invalid namespace, `43` no such cursor).
    pub code: i32,
    /// Message drivers surface as `errmsg`.
    pub message: String,
    /// Extra top-level fields the real reply carries after `codeName`, such as
    /// `keyPattern` / `keyValue` on an index-build duplicate key failure.
    pub details: Vec<(String, BsonValue)>,
}

impl CommandError {
    /// Builds one command failure.
    pub fn new(code: i32, message: impl Into<String>) -> Self {
        Self { code, message: message.into(), details: Vec::new() }
    }

    /// Appends one top-level field to the error reply.
    pub fn with_detail(mut self, key: &str, value: BsonValue) -> Self {
        self.details.push((key.to_string(), value));
        self
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

/// Result document for a failed command: `{ ok: 0, errmsg, code, codeName, ... }`.
///
/// `codeName` strings below were read from `mongod 8.0.9`, covering every code
/// the index commands, the index-build duplicate key path and the aggregation
/// stages can emit. Codes outside that set keep the three-field shape rather
/// than guessing a name.
pub fn error_document(error: &CommandError) -> BsonDocument {
    let mut document = BsonDocument::new();
    document.push("ok".to_string(), BsonValue::Double(0.0));
    document.push("errmsg".to_string(), BsonValue::String(error.message.clone()));
    document.push("code".to_string(), BsonValue::Int32(error.code));
    if let Some(name) = code_name(error.code) {
        document.push("codeName".to_string(), BsonValue::String(name.to_string()));
    }
    for (key, value) in &error.details {
        document.push(key.clone(), value.clone());
    }
    document
}

/// Symbolic name `mongod` reports next to a numeric error code.
pub fn code_name(code: i32) -> Option<&'static str> {
    Some(match code {
        2 => "BadValue",
        9 => "FailedToParse",
        14 => "TypeMismatch",
        16 => "InvalidLength",
        13 => "Unauthorized",
        26 => "NamespaceNotFound",
        27 => "IndexNotFound",
        48 => "NamespaceExists",
        43 => "CursorNotFound",
        67 => "CannotCreateIndex",
        72 => "InvalidOptions",
        73 => "InvalidNamespace",
        85 => "IndexOptionsConflict",
        86 => "IndexKeySpecsConflict",
        11000 => "DuplicateKey",
        112 => "WriteConflict",
        121 => "DocumentValidationFailure",
        225 => "TransactionTooOld",
        40414 => "IDLFailedToParse",
        40148 => "Location40148",
        40149 => "Location40149",
        _ => return None,
    })
}

/// `hello` / `isMaster` handshake answer.
pub fn hello() -> BsonDocument {
    let mut document = BsonDocument::new();
    document.push("isWritablePrimary".to_string(), BsonValue::Bool(true));
    document.push("maxWireVersion".to_string(), BsonValue::Int32(17));
    document.push("minWireVersion".to_string(), BsonValue::Int32(0));
    document.push("ok".to_string(), BsonValue::Double(1.0));
    document
}

/// `ping` answer.
pub fn ping() -> BsonDocument {
    let mut document = BsonDocument::new();
    document.push("ok".to_string(), BsonValue::Double(1.0));
    document
}

/// Renders an `_id` the way MongoDB's duplicate-key message does.
pub fn describe_id(value: &BsonValue) -> String {
    match value {
        BsonValue::String(text) => format!("\"{text}\""),
        BsonValue::Int32(number) => number.to_string(),
        BsonValue::Int64(number) => number.to_string(),
        BsonValue::Double(number) => {
            if number.is_finite() && number.fract() == 0.0 {
                format!("{number:.1}")
            } else {
                number.to_string()
            }
        }
        BsonValue::ObjectId(bytes) => {
            let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
            format!("ObjectId('{hex}')")
        }
        other => format!("{other:?}"),
    }
}

/// One `writeErrors` entry. Field order follows `mongod 8.0.9`: `index`, `code`,
/// `errmsg`, then `keyPattern` / `keyValue` for duplicate-key failures.
struct WriteError {
    index: usize,
    code: i32,
    message: String,
    key_pattern: Option<BsonDocument>,
    key_value: Option<BsonDocument>,
    err_info: Option<BsonDocument>,
}

impl WriteError {
    fn plain(index: usize, code: i32, message: impl Into<String>) -> Self {
        Self { index, code, message: message.into(), key_pattern: None, key_value: None, err_info: None }
    }

    fn validation(index: usize, err_info: BsonDocument) -> Self {
        Self {
            index,
            code: 121,
            message: "Document failed validation".to_string(),
            key_pattern: None,
            key_value: None,
            err_info: Some(err_info),
        }
    }

    fn duplicate(index: usize, message: impl Into<String>, key_pattern: BsonDocument, key_value: BsonDocument) -> Self {
        Self {
            index,
            code: 11000,
            message: message.into(),
            key_pattern: Some(key_pattern),
            key_value: Some(key_value),
            err_info: None,
        }
    }
}

/// `insert`, with `_id` generation, `11000` duplicate mapping, unique-index
/// enforcement, and ordered / unordered continuation.
pub fn insert(command: &BsonDocument, store: &Store) -> Result<BsonDocument, CommandError> {
    let namespace = namespace_from_command(command, "insert")
        .ok_or_else(|| CommandError::new(73, "insert command missing collection name"))?;

    let Some(BsonValue::Array(documents)) = command.get("documents")
    else {
        return Err(CommandError::new(2, "insert requires a 'documents' array"));
    };
    if documents.is_empty() || documents.len() > 100_000 {
        return Err(CommandError::new(
            16,
            format!("Write batch sizes must be between 1 and 100000. Got {} operations.", documents.len()),
        ));
    }

    let ordered = match command.get("ordered") {
        Some(BsonValue::Bool(ordered)) => *ordered,
        _ => true,
    };

    let index_specs: Vec<IndexSpec> = store.index_specs(&namespace);
    let unique_indexes: Vec<IndexSpec> = index_specs.iter().filter(|index| index.unique).cloned().collect();
    let mut candidates: Vec<(usize, BsonDocument, BsonValue)> = Vec::with_capacity(documents.len());
    let mut write_errors: Vec<WriteError> = Vec::new();

    for (index, item) in documents.iter().enumerate() {
        let BsonValue::Document(sub_document) = item
        else {
            write_errors.push(WriteError::plain(index, 2, "documents must be objects"));
            if ordered {
                break;
            }
            continue;
        };
        let mut stored = sub_document.clone();
        if !stored.fields.iter().any(|(field, _)| field == "_id") {
            stored.push("_id".to_string(), BsonValue::ObjectId(generate_object_id()));
        }
        if let Some(error) = parallel_array_error(&stored, &index_specs) {
            write_errors.push(WriteError::plain(index, error.code, error.message));
            if ordered {
                break;
            }
            continue;
        }
        if let Some(info) = insert_validation_failure(store, &namespace, &stored) {
            write_errors.push(WriteError::validation(index, info));
            if ordered {
                break;
            }
            continue;
        }
        let Some(identifier) = stored.fields.iter().find(|(field, _)| field == "_id").map(|(_, value)| value.clone())
        else {
            continue;
        };
        candidates.push((index, stored, identifier));
    }

    let inserted = if unique_indexes.is_empty() {
        let entries: Vec<(Vec<u8>, Vec<u8>)> =
            candidates.iter().map(|(_, stored, identifier)| (value_to_key(identifier), encode_bson(stored))).collect();
        let positions: Vec<usize> = candidates.iter().map(|(index, _, _)| *index).collect();
        let identifiers: Vec<BsonValue> = candidates.iter().map(|(_, _, identifier)| identifier.clone()).collect();
        let report = store
            .insert(&namespace, &entries, ordered)
            .map_err(|error| CommandError::new(2, format!("insert failed: {error}")))?;
        for duplicate in &report.duplicates {
            write_errors.push(id_duplicate_error(&namespace, positions[*duplicate], &identifiers[*duplicate]));
        }
        report.inserted as usize
    } else {
        commit_insert(store, &namespace, &candidates, &unique_indexes, ordered, &mut write_errors)?
    };
    write_errors.sort_by_key(|error| error.index);

    Ok(write_reply(inserted as i64, None, &write_errors))
}

/// Inserts the candidate documents that satisfy every unique index.
///
/// Documents are evaluated in request order. A rejected document never
/// contributes keys, so an unordered batch may still accept a later document
/// that reuses a rejected one's key, exactly like `mongod`.
fn commit_insert(
    store: &Store,
    namespace: &str,
    candidates: &[(usize, BsonDocument, BsonValue)],
    unique_indexes: &[IndexSpec],
    ordered: bool,
    write_errors: &mut Vec<WriteError>,
) -> Result<usize, CommandError> {
    let mut indexed: Vec<BTreeSet<Vec<u8>>> = vec![BTreeSet::new(); unique_indexes.len()];
    let mut existing: BTreeSet<Vec<u8>> = BTreeSet::new();
    for (key, payload) in store.scan(namespace) {
        existing.insert(key);
        let Ok(document) = parse_bson(&payload) else { continue };
        for (position, specification) in unique_indexes.iter().enumerate() {
            for tuple in index_entries(&document, specification) {
                indexed[position].insert(index_tuple(&tuple));
            }
        }
    }

    let mut staged: BTreeSet<Vec<u8>> = BTreeSet::new();
    let mut accepted: Vec<(Vec<u8>, Vec<u8>)> = Vec::new();
    for (index, document, identifier) in candidates {
        let id_key = value_to_key(identifier);
        if existing.contains(&id_key) || staged.contains(&id_key) {
            write_errors.push(id_duplicate_error(namespace, *index, identifier));
            if ordered {
                break;
            }
            continue;
        }
        let mut conflict: Option<(&IndexSpec, Vec<BsonValue>)> = None;
        'specification: for (position, specification) in unique_indexes.iter().enumerate() {
            for values in index_entries(document, specification) {
                if indexed[position].contains(&index_tuple(&values)) {
                    conflict = Some((specification, values));
                    break 'specification;
                }
            }
        }
        if let Some((specification, values)) = conflict {
            write_errors.push(duplicate_index_error(*index, namespace, specification, &values));
            if ordered {
                break;
            }
            continue;
        }
        staged.insert(id_key.clone());
        for (position, specification) in unique_indexes.iter().enumerate() {
            for tuple in index_entries(document, specification) {
                indexed[position].insert(index_tuple(&tuple));
            }
        }
        accepted.push((id_key, encode_bson(document)));
    }

    if !accepted.is_empty() {
        store.import(namespace, &accepted).map_err(|error| CommandError::new(2, format!("insert failed: {error}")))?;
    }
    Ok(accepted.len())
}

fn id_duplicate_error(namespace: &str, index: usize, identifier: &BsonValue) -> WriteError {
    let mut key_pattern = BsonDocument::new();
    key_pattern.push("_id".to_string(), BsonValue::Int32(1));
    let mut key_value = BsonDocument::new();
    key_value.push("_id".to_string(), identifier.clone());
    WriteError::duplicate(
        index,
        format!(
            "E11000 duplicate key error collection: {namespace} index: _id_ dup key: {{ _id: {} }}",
            describe_id(identifier)
        ),
        key_pattern,
        key_value,
    )
}

/// The index values one field contributes, expanding an array one level.
fn field_values(document: &BsonDocument, field: &str) -> Vec<BsonValue> {
    let candidates = collect_field(document, field);
    if candidates.is_empty() {
        // A missing field is indexed as `null`, which is what makes `{a: null}`
        // and an absent `a` collide in a unique index.
        return vec![BsonValue::Null];
    }
    let mut values = Vec::new();
    for candidate in candidates {
        match candidate {
            BsonValue::Array(items) => {
                if items.is_empty() {
                    // `mongod 8.0.9` indexes an empty array as BSON undefined:
                    // `{a: []}` twice collides as `dup key: { a: undefined }`.
                    values.push(BsonValue::Undefined);
                } else {
                    // Only one level is expanded, so a nested array stays one
                    // element: `{a: [[1, 2]]}` keys on the array `[1, 2]` itself.
                    values.extend(items.iter().cloned());
                }
            }
            other => values.push(other.clone()),
        }
    }
    values
}

/// Whether one key field is array-valued, which is what makes the index multikey.
fn field_array_valued(document: &BsonDocument, field: &str) -> bool {
    collect_field(document, field).iter().any(|candidate| matches!(candidate, BsonValue::Array(_)))
        || (field.contains('.') && path_traverses_array(document, field))
}

/// Whether a dotted path descends through an array before reaching its leaf.
fn path_traverses_array(document: &BsonDocument, path: &str) -> bool {
    let segments: Vec<&str> = path.split('.').collect();
    match document.get(segments[0]) {
        Some(value) => traverses_array(value, &segments[1..]),
        None => false,
    }
}

fn traverses_array(value: &BsonValue, segments: &[&str]) -> bool {
    if segments.is_empty() {
        return false;
    }
    match value {
        BsonValue::Array(_) => true,
        BsonValue::Document(document) => {
            document.get(segments[0]).map(|next| traverses_array(next, &segments[1..])).unwrap_or(false)
        }
        _ => false,
    }
}

/// Every index key one document contributes, in key order and element order.
///
/// A compound key is the cartesian product of its fields. Duplicate elements
/// inside one document are collapsed, which is why `{a: [3, 3]}` can be stored
/// under a unique index while a second document with `a: 3` cannot.
fn index_entries(document: &BsonDocument, specification: &IndexSpec) -> Vec<Vec<BsonValue>> {
    let mut tuples: Vec<Vec<BsonValue>> = vec![Vec::new()];
    for (field, _) in &specification.key.fields {
        let values = field_values(document, field);
        let mut expanded = Vec::with_capacity(tuples.len() * values.len());
        for tuple in &tuples {
            for value in &values {
                let mut next = tuple.clone();
                next.push(value.clone());
                expanded.push(next);
            }
        }
        tuples = expanded;
    }
    let mut seen: BTreeSet<Vec<u8>> = BTreeSet::new();
    tuples.retain(|tuple| seen.insert(index_tuple(tuple)));
    tuples
}

/// Every encoded key one document contributes under one index.
fn tuples_of(document: &BsonDocument, specification: &IndexSpec) -> BTreeSet<Vec<u8>> {
    index_entries(document, specification).into_iter().map(|tuple| index_tuple(&tuple)).collect()
}

/// Code `171` for two array-valued fields under one compound index.
///
/// `mongod 8.0.9` names the two array fields in reverse key order: index
/// `{a: 1, b: 1}` over `{a: [1], b: [2]}` reports `[b] [a]` even when a third
/// field is also an array.
fn parallel_array_error(document: &BsonDocument, indexes: &[IndexSpec]) -> Option<CommandError> {
    for specification in indexes.iter().filter(|index| index.key.fields.len() >= 2) {
        let array_fields: Vec<&str> = specification
            .key
            .fields
            .iter()
            .map(|(field, _)| field.as_str())
            .filter(|field| field_array_valued(document, *field))
            .collect();
        if array_fields.len() >= 2 {
            return Some(CommandError::new(
                171,
                format!(
                    "cannot index parallel arrays [{}] [{}]",
                    array_fields[1], array_fields[0]
                ),
            ));
        }
    }
    None
}

/// Length-prefixed key so two adjacent tuples can never be confused.
fn index_tuple(values: &[BsonValue]) -> Vec<u8> {
    let mut tuple = Vec::new();
    for value in values {
        let key = value_to_key(value);
        tuple.extend_from_slice(&(key.len() as u32).to_be_bytes());
        tuple.extend_from_slice(&key);
    }
    tuple
}

fn duplicate_index_error(index: usize, namespace: &str, specification: &IndexSpec, values: &[BsonValue]) -> WriteError {
    let mut key_value = BsonDocument::new();
    for ((field, _), value) in specification.key.fields.iter().zip(values) {
        key_value.push(field.clone(), value.clone());
    }
    let rendered: Vec<String> = specification
        .key
        .fields
        .iter()
        .zip(values)
        .map(|((field, _), value)| format!("{field}: {}", render_shell_value(value)))
        .collect();
    WriteError::duplicate(
        index,
        format!(
            "E11000 duplicate key error collection: {namespace} index: {} dup key: {{ {} }}",
            specification.name,
            rendered.join(", ")
        ),
        specification.key.clone(),
        key_value,
    )
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

    Ok(write_reply((end - start) as i64, None, &[]))
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
            "$lookup" => documents = lookup_stage(documents, body, store, &namespace)?,
            "$sortByCount" => documents = sort_by_count_stage(&documents, body)?,
            "$group" => {
                let BsonValue::Document(specification) = body
                else {
                    return Err(CommandError::new(2, "$group requires a document"));
                };
                documents = group_stage(&documents, specification)?;
            }
            "$addFields" => {
                let BsonValue::Document(specification) = body
                else {
                    return Err(CommandError::new(2, "$addFields requires a document"));
                };
                documents = add_fields_stage(&documents, specification)?;
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

    Ok(write_reply(deleted, None, &[]))
}

/// `update` with the documented update operators, replacement documents and
/// `upsert`; `multi` toggles updateMany.
pub fn update(command: &BsonDocument, store: &Store) -> Result<BsonDocument, CommandError> {
    let namespace = namespace_from_command(command, "update")
        .ok_or_else(|| CommandError::new(73, "update command missing collection name"))?;
    let Some(BsonValue::Array(specifications)) = command.get("updates")
    else {
        return Err(CommandError::new(2, "update requires an 'updates' array"));
    };

    let mut matched: i64 = 0;
    let mut modified: i64 = 0;
    let index_specs: Vec<IndexSpec> = store.index_specs(&namespace);
    let unique_indexes: Vec<IndexSpec> = index_specs.iter().filter(|index| index.unique).cloned().collect();
    let mut indexed: BTreeMap<Vec<u8>, Vec<BTreeSet<Vec<u8>>>> = BTreeMap::new();
    if !unique_indexes.is_empty() {
        for (key, value) in store.scan(&namespace) {
            if let Ok(document) = parse_bson(&value) {
                indexed.insert(key, unique_indexes.iter().map(|spec| tuples_of(&document, spec)).collect());
            }
        }
    }
    for (index, specification) in specifications.iter().enumerate() {
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
        let operator_update = update_document.fields.iter().any(|(field, _)| field.starts_with('$'));
        let replacement = !operator_update;
        if operator_update {
            if let Some((field, _)) = update_document.fields.iter().find(|(field, _)| !field.starts_with('$')) {
                return Err(CommandError::new(
                    9,
                    format!("Unknown modifier: {field}. Expected a valid update modifier or pipeline-style update specified as an array"),
                ));
            }
            validate_update_document(update_document)?;
        }
        let upsert = matches!(specification.get("upsert"), Some(BsonValue::Bool(true)));
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
            let identifier_value = document.get("_id").cloned();
            let identifier = identifier_value.as_ref().map(describe_id).unwrap_or_else(|| "<missing>".to_string());
            let applied = if replacement {
                build_replacement(update_document, identifier_value.as_ref())
            }
            else {
                apply_update(&document, update_document, &identifier, filter)
            };
            let updated = match applied {
                Ok(updated) => updated,
                Err(error) => {
                    // The real server keeps the writes already applied, reports a
                    // zeroed counter pair plus `writeErrors`, and aborts the rest
                    // of the command.
                    if !changes.is_empty() {
                        store.replace(&namespace, &changes).map_err(|replace| CommandError::new(2, replace.to_string()))?;
                    }
                    return Ok(write_reply(0, Some(0), &[WriteError::plain(index, error.code, error.message.clone())]));
                }
            };
            if let Some(info) = update_validation_failure(store, &namespace, &document, &updated) {
                if !changes.is_empty() {
                    store.replace(&namespace, &changes).map_err(|replace| CommandError::new(2, replace.to_string()))?;
                }
                return Ok(write_reply(0, Some(0), &[WriteError::validation(index, info)]));
            }
            if let Some(error) = parallel_array_error(&updated, &index_specs) {
                // A parallel-array key cannot be indexed at all, so the real
                // server reports a zeroed counter pair plus `writeErrors`.
                if !changes.is_empty() {
                    store.replace(&namespace, &changes).map_err(|replace| CommandError::new(2, replace.to_string()))?;
                }
                return Ok(write_reply(0, Some(0), &[WriteError::plain(index, error.code, error.message)]));
            }
            if !unique_indexes.is_empty() {
                if let Some((specification, values)) = find_unique_conflict(&unique_indexes, &updated, &key, &indexed) {
                    // Same shape as a failing multi-update: already applied writes
                    // stay, counters report zero, and the command stops here.
                    if !changes.is_empty() {
                        store.replace(&namespace, &changes).map_err(|replace| CommandError::new(2, replace.to_string()))?;
                    }
                    return Ok(write_reply(
                        0,
                        Some(0),
                        &[duplicate_index_error(index, &namespace, specification, &values)],
                    ));
                }
                if let Some(entry) = indexed.get_mut(&key) {
                    *entry = unique_indexes.iter().map(|spec| tuples_of(&updated, spec)).collect();
                }
            }
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
        if matched == 0 && upsert {
            let applied = if replacement {
                let query_identifier = match filter.get("_id") {
                    Some(BsonValue::Document(operators)) if has_operator(operators) => None,
                    Some(value) => Some(value.clone()),
                    None => None,
                };
                build_replacement(update_document, query_identifier.as_ref())
            }
            else {
                let base = upsert_base(filter);
                let identifier = base.get("_id").map(describe_id).unwrap_or_else(|| "<missing>".to_string());
                apply_update(&base, update_document, &identifier, filter)
            };
            let mut inserted = match applied {
                Ok(document) => document,
                Err(error) => {
                    return Ok(write_reply(0, Some(0), &[WriteError::plain(index, error.code, error.message)]));
                }
            };
            if inserted.get("_id").is_none() {
                inserted.fields.insert(0, ("_id".to_string(), BsonValue::ObjectId(generate_object_id())));
            }
            if let Some(info) = insert_validation_failure(store, &namespace, &inserted) {
                return Ok(write_reply(0, Some(0), &[WriteError::validation(index, info)]));
            }
            let Some(identifier) = inserted.get("_id").cloned() else {
                return Ok(write_reply(0, Some(0), &[]));
            };
            if let Some(error) = parallel_array_error(&inserted, &index_specs) {
                return Ok(write_reply(0, Some(0), &[WriteError::plain(index, error.code, error.message)]));
            }
            let candidates = vec![(index, inserted, identifier.clone())];
            let mut write_errors = Vec::new();
            let inserted_count = commit_insert(store, &namespace, &candidates, &unique_indexes, true, &mut write_errors)?;
            if inserted_count == 1 {
                return Ok(upsert_reply(index, &identifier));
            }
            return Ok(write_reply(0, Some(0), &write_errors));
        }
    }

    Ok(write_reply(matched, Some(modified), &[]))
}

/// Base document for an operator upsert: the equality clauses of the filter,
/// in filter order. Operator clauses and logical clauses are skipped, matching
/// the server's upsert construction.
fn upsert_base(filter: &BsonDocument) -> BsonDocument {
    let mut base = BsonDocument::new();
    for (field, value) in &filter.fields {
        if field.starts_with('$') {
            continue;
        }
        if let BsonValue::Document(operators) = value {
            if has_operator(operators) {
                continue;
            }
        }
        let segments: Vec<&str> = field.split('.').collect();
        let _ = set_segments(&mut base, &segments, value.clone());
    }
    base
}

/// Replacement document rule: `_id` is kept from the matched or queried
/// document unless the replacement repeats it, and an attempt to change it is
/// rejected with code `66`. Other fields are replaced wholesale.
fn build_replacement(
    specification: &BsonDocument,
    identifier: Option<&BsonValue>,
) -> Result<BsonDocument, CommandError> {
    let replacement_identifier = specification.get("_id");
    if let (Some(current), Some(replacement)) = (identifier, replacement_identifier) {
        if !values_equal(Some(current), replacement) {
            return Err(CommandError::new(
                66,
                format!(
                    "After applying the update, the (immutable) field '_id' was found to have been altered to _id: {}",
                    describe_id(replacement)
                ),
            ));
        }
    }
    let chosen = identifier.cloned().or_else(|| replacement_identifier.cloned());
    let mut result = BsonDocument::new();
    if let Some(identifier) = chosen {
        result.push("_id".to_string(), identifier);
    }
    for (field, value) in &specification.fields {
        if field != "_id" {
            result.push(field.clone(), value.clone());
        }
    }
    Ok(result)
}

/// Reply for an upsert that inserted one document: `n`, `upserted` and a zero
/// `nModified`, in the order the server emits them.
fn upsert_reply(index: usize, identifier: &BsonValue) -> BsonDocument {
    let mut response = BsonDocument::new();
    response.push("n".to_string(), count_value(1));
    let mut entry = BsonDocument::new();
    entry.push("index".to_string(), BsonValue::Int32(index as i32));
    entry.push("_id".to_string(), identifier.clone());
    response.push("upserted".to_string(), BsonValue::Array(vec![BsonValue::Document(entry)]));
    response.push("nModified".to_string(), count_value(0));
    response.push("ok".to_string(), BsonValue::Double(1.0));
    response
}

/// Finds the first unique index key of `document` already held by a different
/// stored document.
fn find_unique_conflict<'a>(
    indexes: &'a [IndexSpec],
    document: &BsonDocument,
    key: &[u8],
    current: &BTreeMap<Vec<u8>, Vec<BTreeSet<Vec<u8>>>>,
) -> Option<(&'a IndexSpec, Vec<BsonValue>)> {
    for (position, specification) in indexes.iter().enumerate() {
        for values in index_entries(document, specification) {
            let tuple = index_tuple(&values);
            for (other, sets) in current {
                if other.as_slice() != key && sets.get(position).is_some_and(|set| set.contains(&tuple)) {
                    return Some((specification, values));
                }
            }
        }
    }
    None
}

/// Reply shape shared by `insert` / `update` / `delete` / `count`, matching
/// `mongod 8.0.9`: `ok` is a double and every counter is int32.
///
/// The field order is also the real server's: `n`, `writeErrors`, `nModified`,
/// `ok`. A successful update therefore stays `n`, `nModified`, `ok`.
fn write_reply(count: i64, modified: Option<i64>, errors: &[WriteError]) -> BsonDocument {
    let mut response = BsonDocument::new();
    response.push("n".to_string(), count_value(count));
    if !errors.is_empty() {
        let entries: Vec<BsonValue> = errors
            .iter()
            .map(|error| {
                let mut entry = BsonDocument::new();
                entry.push("index".to_string(), BsonValue::Int32(error.index as i32));
                entry.push("code".to_string(), BsonValue::Int32(error.code));
                entry.push("errmsg".to_string(), BsonValue::String(error.message.clone()));
                if let Some(pattern) = &error.key_pattern {
                    entry.push("keyPattern".to_string(), BsonValue::Document(pattern.clone()));
                }
                if let Some(value) = &error.key_value {
                    entry.push("keyValue".to_string(), BsonValue::Document(value.clone()));
                }
                if let Some(info) = &error.err_info {
                    entry.push("errInfo".to_string(), BsonValue::Document(info.clone()));
                }
                BsonValue::Document(entry)
            })
            .collect();
        response.push("writeErrors".to_string(), BsonValue::Array(entries));
    }
    if let Some(modified) = modified {
        response.push("nModified".to_string(), count_value(modified));
    }
    response.push("ok".to_string(), BsonValue::Double(1.0));
    response
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
                "replacement updates are not supported; `u` must use an update operator",
            ));
        }
        if !UPDATE_OPERATORS.contains(&operator.as_str()) {
            return Err(CommandError::new(9, format!("Unknown modifier: {operator} (operatorIndex: {operator_index})")));
        }
        let BsonValue::Document(operand) = operand
        else {
            return Err(CommandError::new(9, format!("update operator {operator} requires a document")));
        };
        for (path, value) in &operand.fields {
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
            if operator == "$rename" {
                let BsonValue::String(target) = value
                else {
                    return Err(CommandError::new(2, format!("The 'to' field for $rename must be a string: {path}")));
                };
                if target == "_id" || target.starts_with("_id.") {
                    return Err(CommandError::new(
                        66,
                        format!(
                            "Performing an update on the path '{target}' would modify the immutable field '_id'"
                        ),
                    ));
                }
            }
        }
    }
    Ok(())
}

fn apply_update(
    document: &BsonDocument,
    specification: &BsonDocument,
    identifier: &str,
    filter: &BsonDocument,
) -> Result<BsonDocument, CommandError> {
    let mut updated = document.clone();
    for (operator, operand) in &specification.fields {
        let BsonValue::Document(operand) = operand
        else { continue };
        if matches!(operator.as_str(), "$set" | "$inc" | "$mul") {
            for path in operand.fields.iter().map(|(path, _)| path) {
                let segments = resolve_segments(path, document, filter)?;
                let path_refs: Vec<&str> = segments.iter().map(String::as_str).collect();
                validate_negative_index(document, &path_refs)?;
            }
        }
        for (path, value) in &operand.fields {
            let segments = resolve_segments(path, &updated, filter)?;
            let path_refs: Vec<&str> = segments.iter().map(String::as_str).collect();
            match operator.as_str() {
                "$set" => set_segments(&mut updated, &path_refs, value.clone())?,
                "$unset" => unset_segments(&mut updated, &path_refs),
                "$inc" => numeric_segments(&mut updated, &path_refs, value, path, identifier, false)?,
                "$mul" => numeric_segments(&mut updated, &path_refs, value, path, identifier, true)?,
                "$rename" => rename_path(&mut updated, &path_refs, value, path)?,
                "$push" => push_path(&mut updated, &path_refs, value, path, identifier)?,
                "$pop" => pop_path(&mut updated, &path_refs, value, path)?,
                "$addToSet" => add_to_set_path(&mut updated, &path_refs, value, path, identifier)?,
                "$pull" => pull_path(&mut updated, &path_refs, value, path)?,
                _ => {}
            }
        }
    }
    Ok(updated)
}

/// Resolves the positional `$` segment against the document and filter that
/// produced the match. Only the first matching array element is supported.
fn resolve_segments(
    path: &str,
    document: &BsonDocument,
    filter: &BsonDocument,
) -> Result<Vec<String>, CommandError> {
    let segments: Vec<String> = path.split('.').map(str::to_string).collect();
    if !segments.iter().any(|segment| segment == "$") {
        return Ok(segments);
    }
    let mut resolved = Vec::with_capacity(segments.len());
    for (position, segment) in segments.iter().enumerate() {
        if segment == "$" {
            let index = positional_index(document, &resolved, filter);
            resolved.push(index.to_string());
        }
        else {
            resolved.push(segment.clone());
        }
        let _ = position;
    }
    Ok(resolved)
}

/// Index of the first array element selected by the filter clause for the array
/// that precedes the positional operator.
fn positional_index(document: &BsonDocument, prefix: &[String], filter: &BsonDocument) -> usize {
    let prefix_refs: Vec<&str> = prefix.iter().map(String::as_str).collect();
    let Some(BsonValue::Array(items)) = value_at(document, &prefix_refs).cloned() else { return 0 };
    let key = prefix.join(".");
    if let Some(predicate) = filter.get(&key) {
        if let BsonValue::Document(operators) = predicate {
            if has_operator(operators) {
                if let Some(BsonValue::Document(specification)) = operators.get("$elemMatch") {
                    for (index, item) in items.iter().enumerate() {
                        if let BsonValue::Document(element) = item {
                            if document_matches(element, specification).unwrap_or(false) {
                                return index;
                            }
                        }
                    }
                }
                else {
                    for (index, item) in items.iter().enumerate() {
                        if operator_matches(&[item], operators, &key, 0).unwrap_or(false) {
                            return index;
                        }
                    }
                }
                return 0;
            }
        }
        for (index, item) in items.iter().enumerate() {
            if values_equal(Some(item), predicate) {
                return index;
            }
        }
    }
    let mut clauses = BsonDocument::new();
    let mut has_clause = false;
    for (field, expected) in &filter.fields {
        if let Some(rest) = field.strip_prefix(&format!("{key}.")) {
            clauses.push(rest.to_string(), expected.clone());
            has_clause = true;
        }
    }
    if has_clause {
        for (index, item) in items.iter().enumerate() {
            if let BsonValue::Document(element) = item {
                if document_matches(element, &clauses).unwrap_or(false) {
                    return index;
                }
            }
        }
    }
    0
}

fn validate_negative_index(document: &BsonDocument, segments: &[&str]) -> Result<(), CommandError> {
    for position in 1..segments.len() {
        let Some(BsonValue::Array(items)) = value_at(document, &segments[..position]) else { continue };
        let Ok(number) = segments[position].parse::<i64>() else { continue };
        if number < 0 {
            return Err(cannot_create_field_in_array(items, segments[position - 1], segments[position]));
        }
    }
    Ok(())
}

/// Every value reachable by `segments`, traversing arrays field-wise so
/// `a.b` over `[{b: 1}, {b: 2}]` yields both values.
fn collect_values_at<'a>(document: &'a BsonDocument, segments: &[&str], out: &mut Vec<&'a BsonValue>) {
    let Some((head, rest)) = segments.split_first()
    else {
        return;
    };
    if let Some(value) = document.get(head) {
        collect_descend_values(value, rest, out);
    }
}

fn collect_descend_values<'a>(value: &'a BsonValue, segments: &[&str], out: &mut Vec<&'a BsonValue>) {
    let Some((head, rest)) = segments.split_first()
    else {
        out.push(value);
        return;
    };
    match value {
        BsonValue::Document(document) => {
            if let Some(next) = document.get(head) {
                collect_descend_values(next, rest, out);
            }
        }
        BsonValue::Array(items) => {
            if let Ok(index) = head.parse::<usize>() {
                if let Some(next) = items.get(index) {
                    collect_descend_values(next, rest, out);
                }
            }
            else {
                for item in items {
                    collect_descend_values(item, segments, out);
                }
            }
        }
        _ => {}
    }
}

fn value_at<'a>(document: &'a BsonDocument, segments: &[&str]) -> Option<&'a BsonValue> {
    let head = segments.first()?;
    let value = document.get(head)?;
    if segments.len() == 1 {
        return Some(value);
    }
    descend_value(value, &segments[1..])
}

fn descend_value<'a>(value: &'a BsonValue, segments: &[&str]) -> Option<&'a BsonValue> {
    if segments.is_empty() {
        return Some(value);
    }
    match value {
        BsonValue::Document(document) => document.get(segments[0]).and_then(|next| descend_value(next, &segments[1..])),
        BsonValue::Array(items) => {
            let index = segments[0].parse::<usize>().ok()?;
            items.get(index).and_then(|next| descend_value(next, &segments[1..]))
        }
        _ => None,
    }
}

fn value_at_mut<'a>(document: &'a mut BsonDocument, segments: &[&str]) -> Option<&'a mut BsonValue> {
    let head = *segments.first()?;
    let position = document.fields.iter().position(|(field, _)| field == head)?;
    if segments.len() == 1 {
        return Some(&mut document.fields[position].1);
    }
    descend_value_mut(&mut document.fields[position].1, &segments[1..])
}

fn descend_value_mut<'a>(value: &'a mut BsonValue, segments: &[&str]) -> Option<&'a mut BsonValue> {
    if segments.is_empty() {
        return Some(value);
    }
    match value {
        BsonValue::Document(document) => {
            let position = document.fields.iter().position(|(field, _)| field == segments[0])?;
            descend_value_mut(&mut document.fields[position].1, &segments[1..])
        }
        BsonValue::Array(items) => {
            let index = segments[0].parse::<usize>().ok()?;
            let next = items.get_mut(index)?;
            descend_value_mut(next, &segments[1..])
        }
        _ => None,
    }
}

fn set_segments(document: &mut BsonDocument, segments: &[&str], value: BsonValue) -> Result<(), CommandError> {
    let head = segments[0];
    if segments.len() == 1 {
        if let Some(existing) = document.fields.iter_mut().find(|(field, _)| field == head) {
            existing.1 = value;
        }
        else {
            document.push(head.to_string(), value);
        }
        return Ok(());
    }
    let tail = &segments[1..];
    if !document.fields.iter().any(|(field, _)| field == head) {
        let mut child = BsonDocument::new();
        set_segments(&mut child, tail, value)?;
        document.push(head.to_string(), BsonValue::Document(child));
        return Ok(());
    }
    let position = document.fields.iter().position(|(field, _)| field == head).expect("head exists");
    match &mut document.fields[position].1 {
        BsonValue::Document(child) => set_segments(child, tail, value),
        BsonValue::Array(items) => set_array_segments(items, head, tail, value),
        other => {
            let rendered = render_shell_value(other);
            Err(CommandError::new(28, format!("Cannot create field '{}' in element {{{head}: {rendered}}}", tail[0])))
        }
    }
}

fn set_array_segments(
    items: &mut Vec<BsonValue>,
    field: &str,
    segments: &[&str],
    value: BsonValue,
) -> Result<(), CommandError> {
    let part = segments[0];
    let Ok(number) = part.parse::<i64>() else {
        return Err(cannot_create_field_in_array(items, field, part));
    };
    if number < 0 {
        return Err(cannot_create_field_in_array(items, field, part));
    }
    let index = number as usize;
    if index >= items.len() {
        items.resize(index + 1, BsonValue::Null);
    }
    if segments.len() == 1 {
        items[index] = value;
        return Ok(());
    }
    if matches!(items[index], BsonValue::Null) {
        items[index] = BsonValue::Document(BsonDocument::new());
    }
    match &mut items[index] {
        BsonValue::Document(child) => set_segments(child, &segments[1..], value),
        BsonValue::Array(inner) => set_array_segments(inner, part, &segments[1..], value),
        other => {
            let rendered = render_shell_value(other);
            Err(CommandError::new(28, format!("Cannot create field '{}' in element {rendered}", segments[1])))
        }
    }
}

fn cannot_create_field_in_array(items: &[BsonValue], field: &str, child: &str) -> CommandError {
    let rendered = render_shell_value(&BsonValue::Array(items.to_vec()));
    CommandError::new(28, format!("Cannot create field '{child}' in element {{{field}: {rendered}}}"))
}

fn unset_segments(document: &mut BsonDocument, segments: &[&str]) {
    let head = segments[0];
    if segments.len() == 1 {
        document.fields.retain(|(field, _)| field != head);
        return;
    }
    let position = match document.fields.iter().position(|(field, _)| field == head) {
        Some(position) => position,
        None => return,
    };
    match &mut document.fields[position].1 {
        BsonValue::Document(child) => unset_segments(child, &segments[1..]),
        BsonValue::Array(items) => unset_array_segments(items, &segments[1..]),
        _ => {}
    }
}

fn unset_array_segments(items: &mut Vec<BsonValue>, segments: &[&str]) {
    let Ok(index) = segments[0].parse::<usize>() else { return };
    if index >= items.len() {
        return;
    }
    if segments.len() == 1 {
        items[index] = BsonValue::Null;
        return;
    }
    match &mut items[index] {
        BsonValue::Document(child) => unset_segments(child, &segments[1..]),
        BsonValue::Array(inner) => unset_array_segments(inner, &segments[1..]),
        _ => {}
    }
}

fn numeric_segments(
    document: &mut BsonDocument,
    segments: &[&str],
    amount: &BsonValue,
    path: &str,
    identifier: &str,
    multiply: bool,
) -> Result<(), CommandError> {
    let current = value_at(document, segments).cloned();
    let result = match current {
        Some(value) => {
            if multiply {
                multiply_value(&value, amount).ok_or_else(|| {
                    CommandError::new(
                        14,
                        format!(
                            "Cannot apply $mul to a value of non-numeric type. {{_id: {identifier}}} has the field '{path}' of non-numeric type {}",
                            bson_type_name(&value)
                        ),
                    )
                })?
            }
            else {
                increment_value(&value, amount).ok_or_else(|| {
                    CommandError::new(
                        14,
                        format!("Cannot apply $inc to a value of non-numeric type (field: \"{path}\", _id: {identifier})"),
                    )
                })?
            }
        }
        None => {
            if multiply {
                zero_of(amount)
            }
            else {
                if number_of(amount).is_none() {
                    return Err(CommandError::new(
                        14,
                        format!("Cannot apply $inc to a value of non-numeric type (field: \"{path}\", _id: {identifier})"),
                    ));
                }
                amount.clone()
            }
        }
    };
    set_segments(document, segments, result)
}

fn rename_path(
    document: &mut BsonDocument,
    source: &[&str],
    value: &BsonValue,
    path: &str,
) -> Result<(), CommandError> {
    let BsonValue::String(target) = value
    else { return Ok(()) };
    if path == target {
        return Err(CommandError::new(2, format!("The source and target field for $rename must differ: {path}: \"{target}\"")));
    }
    let Some(source_value) = take_path(document, source) else { return Ok(()) };
    let target_segments: Vec<&str> = target.split('.').collect();
    unset_segments(document, &target_segments);
    set_segments(document, &target_segments, source_value)
}

fn take_path(document: &mut BsonDocument, segments: &[&str]) -> Option<BsonValue> {
    let head = *segments.first()?;
    let position = document.fields.iter().position(|(field, _)| field == head)?;
    if segments.len() == 1 {
        return Some(document.fields.remove(position).1);
    }
    match &mut document.fields[position].1 {
        BsonValue::Document(child) => take_path(child, &segments[1..]),
        _ => None,
    }
}

fn push_path(
    document: &mut BsonDocument,
    segments: &[&str],
    value: &BsonValue,
    path: &str,
    identifier: &str,
) -> Result<(), CommandError> {
    let items = ensure_array(document, segments, path, identifier)?;
    if let BsonValue::Document(modifiers) = value {
        if has_operator(modifiers) {
            let values = match modifiers.get("$each") {
                Some(BsonValue::Array(values)) => values.clone(),
                Some(_) => return Err(CommandError::new(2, "$each requires an array")),
                None => return Err(CommandError::new(2, "$slice and $position require $each")),
            };
            for (key, _) in &modifiers.fields {
                if !matches!(key.as_str(), "$each" | "$slice" | "$position") {
                    return Err(CommandError::new(9, format!("Unrecognized clause in $push: {key}")));
                }
            }
            let position = match modifiers.get("$position") {
                Some(operand) => match integer_of(operand) {
                    Some(position) => {
                        if position < 0 {
                            let from_end = items.len() as i128 + position;
                            Some(from_end.max(0) as usize)
                        }
                        else {
                            Some((position as usize).min(items.len()))
                        }
                    }
                    None => return Err(CommandError::new(2, "$position must be an integer")),
                },
                None => None,
            };
            match position {
                Some(position) => {
                    let tail = items.split_off(position);
                    items.extend(values);
                    items.extend(tail);
                }
                None => items.extend(values),
            }
            if let Some(operand) = modifiers.get("$slice") {
                let Some(slice) = integer_of(operand) else {
                    return Err(CommandError::new(2, "$slice must be an integer"));
                };
                if slice >= 0 {
                    items.truncate(slice as usize);
                }
                else {
                    let keep = (-slice) as usize;
                    if items.len() > keep {
                        let drop = items.len() - keep;
                        items.drain(0..drop);
                    }
                }
            }
            return Ok(());
        }
    }
    items.push(value.clone());
    Ok(())
}

fn add_to_set_path(
    document: &mut BsonDocument,
    segments: &[&str],
    value: &BsonValue,
    path: &str,
    identifier: &str,
) -> Result<(), CommandError> {
    ensure_array_with_message(
        document,
        segments,
        path,
        identifier,
        |field, kind| format!("Cannot apply $addToSet to non-array field. Field named '{field}' has non-array type {kind}"),
    )
    .and_then(|items| {
        if let BsonValue::Document(modifiers) = value {
            if has_operator(modifiers) {
                for (key, _) in &modifiers.fields {
                    if key != "$each" {
                        return Err(CommandError::new(9, format!("Found unexpected fields after $each in $addToSet: {key}")));
                    }
                }
                let Some(BsonValue::Array(values)) = modifiers.get("$each") else {
                    return Err(CommandError::new(2, "$each requires an array"));
                };
                for item in values {
                    if !items.iter().any(|existing| values_equal(Some(existing), item)) {
                        items.push(item.clone());
                    }
                }
                return Ok(());
            }
        }
        if !items.iter().any(|existing| values_equal(Some(existing), value)) {
            items.push(value.clone());
        }
        Ok(())
    })
}

fn pop_path(
    document: &mut BsonDocument,
    segments: &[&str],
    value: &BsonValue,
    path: &str,
) -> Result<(), CommandError> {
    let direction = match value {
        BsonValue::Int32(number) => *number,
        BsonValue::Int64(number) => *number as i32,
        _ => 0,
    };
    if direction != 1 && direction != -1 {
        return Err(CommandError::new(9, format!("$pop expects 1 or -1, found: {}", render_shell_value(value))));
    }
    let Some(current) = value_at(document, segments).cloned() else { return Ok(()) };
    let BsonValue::Array(items) = current
    else {
        return Err(CommandError::new(
            14,
            format!("Path '{path}' contains an element of non-array type '{}'", bson_type_name(&current)),
        ));
    };
    if items.is_empty() {
        return Ok(());
    }
    let mut items = items;
    if direction == 1 {
        items.pop();
    }
    else {
        items.remove(0);
    }
    set_segments(document, segments, BsonValue::Array(items))
}

fn pull_path(
    document: &mut BsonDocument,
    segments: &[&str],
    value: &BsonValue,
    path: &str,
) -> Result<(), CommandError> {
    let Some(current) = value_at(document, segments).cloned() else { return Ok(()) };
    let BsonValue::Array(items) = current
    else { return Err(CommandError::new(2, "Cannot apply $pull to a non-array value")) };
    let mut kept = Vec::with_capacity(items.len());
    for item in items {
        if !pull_matches(&item, value, path)? {
            kept.push(item);
        }
    }
    set_segments(document, segments, BsonValue::Array(kept))
}

fn pull_matches(item: &BsonValue, operand: &BsonValue, _path: &str) -> Result<bool, CommandError> {
    if let BsonValue::Document(operand) = operand {
        if has_operator(operand) {
            return operator_matches(&[item], operand, "pull", 0);
        }
        return match item {
            BsonValue::Document(element) => document_matches(element, operand),
            _ => Ok(false),
        };
    }
    Ok(values_equal(Some(item), operand))
}

fn ensure_array<'a>(
    document: &'a mut BsonDocument,
    segments: &[&str],
    path: &str,
    identifier: &str,
) -> Result<&'a mut Vec<BsonValue>, CommandError> {
    ensure_array_with_message(document, segments, path, identifier, |field, kind| {
        format!("The field '{field}' must be an array but is of type {kind} in document {{_id: {identifier}}}")
    })
}

fn ensure_array_with_message<'a>(
    document: &'a mut BsonDocument,
    segments: &[&str],
    path: &str,
    identifier: &str,
    message: impl Fn(&str, &str) -> String,
) -> Result<&'a mut Vec<BsonValue>, CommandError> {
    let _ = identifier;
    if value_at(document, segments).is_none() {
        set_segments(document, segments, BsonValue::Array(Vec::new()))?;
    }
    let value = value_at_mut(document, segments).expect("array path was created");
    match value {
        BsonValue::Array(items) => Ok(items),
        other => {
            let kind = bson_type_name(other);
            Err(CommandError::new(2, message(path, kind)))
        }
    }
}

fn zero_of(amount: &BsonValue) -> BsonValue {
    match amount {
        BsonValue::Int32(_) => BsonValue::Int32(0),
        BsonValue::Int64(_) => BsonValue::Int64(0),
        BsonValue::Double(_) => BsonValue::Double(0.0),
        other => other.clone(),
    }
}

fn multiply_value(current: &BsonValue, amount: &BsonValue) -> Option<BsonValue> {
    let left = number_of(current)?;
    let right = number_of(amount)?;
    let product = left * right;
    if matches!(current, BsonValue::Double(_)) || matches!(amount, BsonValue::Double(_)) {
        return Some(BsonValue::Double(product));
    }
    if matches!(current, BsonValue::Int64(_)) || matches!(amount, BsonValue::Int64(_)) {
        return Some(BsonValue::Int64(product as i64));
    }
    if let Ok(value) = i32::try_from(product as i64) {
        Some(BsonValue::Int32(value))
    }
    else {
        Some(BsonValue::Int64(product as i64))
    }
}

/// Renders one value the way `mongod` prints it inside update error messages.
fn render_shell_value(value: &BsonValue) -> String {
    match value {
        BsonValue::Document(document) => {
            if document.fields.is_empty() {
                "{}".to_string()
            }
            else {
                let fields: Vec<String> =
                    document.fields.iter().map(|(field, value)| format!("{field}: {}", render_shell_value(value))).collect();
                format!("{{ {} }}", fields.join(", "))
            }
        }
        BsonValue::Array(items) => {
            if items.is_empty() {
                "[]".to_string()
            }
            else {
                let items: Vec<String> = items.iter().map(render_shell_value).collect();
                format!("[ {} ]", items.join(", "))
            }
        }
        BsonValue::String(text) => format!("\"{text}\""),
        BsonValue::Int32(number) => number.to_string(),
        BsonValue::Int64(number) => number.to_string(),
        BsonValue::Double(number) => number.to_string(),
        BsonValue::Bool(flag) => if *flag { "true" } else { "false" }.to_string(),
        BsonValue::Null => "null".to_string(),
        BsonValue::Undefined => "undefined".to_string(),
        BsonValue::ObjectId(bytes) => format!("ObjectId('{}')", bytes.iter().map(|byte| format!("{byte:02x}")).collect::<String>()),
        other => format!("{other:?}"),
    }
}

/// Whether a requested key pattern names the same index key as `specification`.
///
/// Field order is significant and each value uses the numeric-equivalence key
/// encoding, so `{ a: 1 }` matches `{ a: 1.0 }` but not `{ a: "1" }` and not
/// a reordered compound key.
fn key_pattern_matches(requested: &BsonDocument, specification: &BsonDocument) -> bool {
    requested.fields.len() == specification.fields.len()
        && requested.fields.iter().zip(&specification.fields).all(|((want, left), (have, right))| {
            want == have && value_to_key(left) == value_to_key(right)
        })
}

/// BSON type name `mongod` prints in a wrong-type error message.
fn bson_type_name(value: &BsonValue) -> &'static str {
    match value {
        BsonValue::Document(_) => "object",
        BsonValue::Array(_) => "array",
        BsonValue::String(_) => "string",
        BsonValue::Int32(_) => "int",
        BsonValue::Int64(_) => "long",
        BsonValue::Double(_) => "double",
        BsonValue::Bool(_) => "bool",
        BsonValue::Null => "null",
        BsonValue::Undefined => "undefined",
        BsonValue::ObjectId(_) => "objectId",
        BsonValue::Binary(_) => "binData",
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
    response.push("ok".to_string(), BsonValue::Double(1.0));
    Ok(response)
}

/// `listCollections` with `nameOnly`, `authorizedCollections`, and a general
/// `filter` applied to the rendered collection descriptions.
pub fn list_collections(command: &BsonDocument, store: &Store) -> Result<BsonDocument, CommandError> {
    let database = command.database();
    let prefix = format!("{database}.");
    let name_only = match command.get("nameOnly") {
        Some(BsonValue::Bool(flag)) => *flag,
        Some(other) => {
            return Err(CommandError::new(
                14,
                format!("BSON field 'listCollections.nameOnly' is the wrong type '{}', expected type 'bool'", bson_type_name(other)),
            ));
        }
        None => false,
    };
    if let Some(other) = command.get("authorizedCollections") {
        if !matches!(other, BsonValue::Bool(_)) {
            return Err(CommandError::new(
                14,
                format!(
                    "BSON field 'listCollections.authorizedCollections' is the wrong type '{}', expected type 'bool'",
                    bson_type_name(other)
                ),
            ));
        }
    }
    let filter = match command.get("filter") {
        Some(BsonValue::Document(filter)) => {
            validate_filter(filter, "listCollections")?;
            Some(filter)
        }
        _ => None,
    };

    let mut entries = Vec::new();
    for namespace in store.namespaces() {
        let Some(collection) = namespace.strip_prefix(&prefix)
        else {
            continue;
        };
        let mut entry = BsonDocument::new();
        entry.push("name".to_string(), BsonValue::String(collection.to_string()));
        entry.push("type".to_string(), BsonValue::String("collection".to_string()));
        if name_only {
            if let Some(filter) = filter {
                if !document_matches(&entry, filter)? {
                    continue;
                }
            }
            entries.push(BsonValue::Document(entry));
            continue;
        }
        let mut options = BsonDocument::new();
        if let Some(validator) = collection_validator_value(store, &namespace) {
            options.push("validator".to_string(), validator);
        }
        let stored = store.collection_options(&namespace);
        if let Some(level) = &stored.validation_level {
            options.push("validationLevel".to_string(), BsonValue::String(level.clone()));
        }
        if let Some(action) = &stored.validation_action {
            options.push("validationAction".to_string(), BsonValue::String(action.clone()));
        }
        entry.push("options".to_string(), BsonValue::Document(options));
        let mut info = BsonDocument::new();
        info.push("readOnly".to_string(), BsonValue::Bool(false));
        info.push("uuid".to_string(), collection_uuid(&namespace));
        entry.push("info".to_string(), BsonValue::Document(info));
        let mut id_index = BsonDocument::new();
        id_index.push("v".to_string(), BsonValue::Int32(2));
        let mut key = BsonDocument::new();
        key.push("_id".to_string(), BsonValue::Int32(1));
        id_index.push("key".to_string(), BsonValue::Document(key));
        id_index.push("name".to_string(), BsonValue::String("_id_".to_string()));
        entry.push("idIndex".to_string(), BsonValue::Document(id_index));
        if let Some(filter) = filter {
            if !document_matches(&entry, filter)? {
                continue;
            }
        }
        entries.push(BsonValue::Document(entry));
    }

    Ok(cursor_reply(&format!("{database}.$cmd.listCollections"), "firstBatch", entries, 0))
}

/// A stable collection identifier derived from the namespace, so reopening a
/// store keeps the `info.uuid` the catalog reported before.
fn collection_uuid_bytes(namespace: &str) -> [u8; 16] {
    let mut high: u64 = 0xcbf2_9ce4_8422_2325;
    let mut low: u64 = 0x9e37_79b9_7f4a_7c15;
    for byte in namespace.bytes() {
        high ^= u64::from(byte);
        high = high.wrapping_mul(0x0000_0100_0000_01b3);
        low ^= u64::from(byte).wrapping_add(0x9e37_79b9);
        low = low.rotate_left(7).wrapping_mul(0x0000_0100_0000_01b3);
    }
    let mut bytes = [0_u8; 16];
    bytes[..8].copy_from_slice(&high.to_be_bytes());
    bytes[8..].copy_from_slice(&low.to_be_bytes());
    bytes
}

fn collection_uuid(namespace: &str) -> BsonValue {
    BsonValue::Binary(BinaryData::new(4, collection_uuid_bytes(namespace).to_vec()))
}

/// UUID in the `8-4-4-4-12` textual form `mongod` uses inside error messages.
fn collection_uuid_text(namespace: &str) -> String {
    let bytes = collection_uuid_bytes(namespace);
    format!(
        "{}-{}-{}-{}-{}",
        bytes[..4].iter().map(|byte| format!("{byte:02x}")).collect::<String>(),
        bytes[4..6].iter().map(|byte| format!("{byte:02x}")).collect::<String>(),
        bytes[6..8].iter().map(|byte| format!("{byte:02x}")).collect::<String>(),
        bytes[8..10].iter().map(|byte| format!("{byte:02x}")).collect::<String>(),
        bytes[10..].iter().map(|byte| format!("{byte:02x}")).collect::<String>()
    )
}

/// `mongod 8.0.9` refuses a second `create` whose options differ from the
/// stored ones and quotes the stored options in the message, uuid first.
fn create_conflict_message(namespace: &str, options: &CollectionOptions) -> String {
    let mut rendered = vec![format!("uuid: UUID(\"{}\")", collection_uuid_text(namespace))];
    if let Some(validator) = &options.validator {
        if let Ok(value) = json::from_json(validator) {
            rendered.push(format!("validator: {}", render_shell_value(&value)));
        }
    }
    if let Some(level) = &options.validation_level {
        rendered.push(format!("validationLevel: \"{level}\""));
    }
    if let Some(action) = &options.validation_action {
        rendered.push(format!("validationAction: \"{action}\""));
    }
    format!("namespace {namespace} already exists, but with different options: {{ {} }}", rendered.join(", "))
}

fn collection_validator_value(store: &Store, namespace: &str) -> Option<BsonValue> {
    store.collection_options(namespace).validator.and_then(|validator| json::from_json(&validator).ok())
}

/// The validator schema, level, and action in force for a namespace. A missing
/// `$jsonSchema` validator means no schema validation happens.
fn collection_schema(store: &Store, namespace: &str) -> Option<(BsonDocument, String, String)> {
    let options = store.collection_options(namespace);
    let validator = options.validator.and_then(|value| json::from_json(&value).ok())?;
    let BsonValue::Document(validator) = validator
    else {
        return None;
    };
    let schema = match validator.get("$jsonSchema") {
        Some(BsonValue::Document(schema)) => schema.clone(),
        _ => return None,
    };
    let level = options.validation_level.unwrap_or_else(|| "strict".to_string());
    let action = options.validation_action.unwrap_or_else(|| "error".to_string());
    Some((schema, level, action))
}

fn schema_rules(schema: &BsonDocument, document: &BsonDocument) -> Vec<BsonValue> {
    let mut rules = Vec::new();
    if let Some(BsonValue::String(expected)) = schema.get("bsonType") {
        if expected != "object" {
            let mut specified = BsonDocument::new();
            specified.push("$jsonSchema".to_string(), BsonValue::Document(schema.clone()));
            let mut rule = BsonDocument::new();
            rule.push("operatorName".to_string(), BsonValue::String("$jsonSchema".to_string()));
            rule.push("specifiedAs".to_string(), BsonValue::Document(specified));
            rule.push("reason".to_string(), BsonValue::String("expression did not evaluate to true".to_string()));
            rules.push(BsonValue::Document(rule));
            return rules;
        }
    }
    if let Some(BsonValue::Bool(false)) = schema.get("additionalProperties") {
        let properties = match schema.get("properties") {
            Some(BsonValue::Document(properties)) => properties,
            _ => &BsonDocument::new(),
        };
        let extra: Vec<String> =
            document.fields.iter().filter(|(field, _)| properties.get(field).is_none()).map(|(field, _)| field.clone()).collect();
        if !extra.is_empty() {
            let mut specified = BsonDocument::new();
            specified.push("additionalProperties".to_string(), BsonValue::Bool(false));
            let mut rule = BsonDocument::new();
            rule.push("operatorName".to_string(), BsonValue::String("additionalProperties".to_string()));
            rule.push("specifiedAs".to_string(), BsonValue::Document(specified));
            rule.push(
                "additionalProperties".to_string(),
                BsonValue::Array(extra.into_iter().map(BsonValue::String).collect()),
            );
            rules.push(BsonValue::Document(rule));
        }
    }
    if let Some(BsonValue::Array(required)) = schema.get("required") {
        let missing: Vec<BsonValue> = required
            .iter()
            .filter_map(|requirement| match requirement {
                BsonValue::String(field) if document.get(field).is_none() => Some(BsonValue::String(field.clone())),
                _ => None,
            })
            .collect();
        if !missing.is_empty() {
            let mut specified = BsonDocument::new();
            specified.push("required".to_string(), BsonValue::Array(required.clone()));
            let mut rule = BsonDocument::new();
            rule.push("operatorName".to_string(), BsonValue::String("required".to_string()));
            rule.push("specifiedAs".to_string(), BsonValue::Document(specified));
            rule.push("missingProperties".to_string(), BsonValue::Array(missing));
            rules.push(BsonValue::Document(rule));
        }
    }
    if let Some(BsonValue::Document(properties)) = schema.get("properties") {
        let mut unsatisfied = Vec::new();
        for (field, property_schema) in &properties.fields {
            let BsonValue::Document(property_schema) = property_schema else { continue };
            let Some(value) = document.get(field) else { continue };
            let details = schema_details(property_schema, value);
            if details.is_empty() {
                continue;
            }
            let mut entry = BsonDocument::new();
            entry.push("propertyName".to_string(), BsonValue::String(field.clone()));
            entry.push("details".to_string(), BsonValue::Array(details.into_iter().map(BsonValue::Document).collect()));
            unsatisfied.push(BsonValue::Document(entry));
        }
        if !unsatisfied.is_empty() {
            let mut rule = BsonDocument::new();
            rule.push("operatorName".to_string(), BsonValue::String("properties".to_string()));
            rule.push("propertiesNotSatisfied".to_string(), BsonValue::Array(unsatisfied));
            rules.push(BsonValue::Document(rule));
        }
    }
    rules
}

fn schema_details(schema: &BsonDocument, value: &BsonValue) -> Vec<BsonDocument> {
    let mut details = Vec::new();
    if let Some(BsonValue::String(expected)) = schema.get("bsonType") {
        let actual = bson_type_name(value);
        if actual != expected {
            let mut specified = BsonDocument::new();
            specified.push("bsonType".to_string(), BsonValue::String(expected.clone()));
            let mut rule = BsonDocument::new();
            rule.push("operatorName".to_string(), BsonValue::String("bsonType".to_string()));
            rule.push("specifiedAs".to_string(), BsonValue::Document(specified));
            rule.push("reason".to_string(), BsonValue::String("type did not match".to_string()));
            rule.push("consideredValue".to_string(), value.clone());
            rule.push("consideredType".to_string(), BsonValue::String(actual.to_string()));
            details.push(rule);
            return details;
        }
    }
    if let Some(minimum) = schema.get("minimum") {
        if let (Some(current), Some(limit)) = (number_of(value), number_of(minimum)) {
            if current < limit {
                let mut specified = BsonDocument::new();
                specified.push("minimum".to_string(), minimum.clone());
                let mut rule = BsonDocument::new();
                rule.push("operatorName".to_string(), BsonValue::String("minimum".to_string()));
                rule.push("specifiedAs".to_string(), BsonValue::Document(specified));
                rule.push("reason".to_string(), BsonValue::String("comparison failed".to_string()));
                rule.push("consideredValue".to_string(), value.clone());
                details.push(rule);
            }
        }
    }
    if let Some(maximum) = schema.get("maximum") {
        if let (Some(current), Some(limit)) = (number_of(value), number_of(maximum)) {
            if current > limit {
                let mut specified = BsonDocument::new();
                specified.push("maximum".to_string(), maximum.clone());
                let mut rule = BsonDocument::new();
                rule.push("operatorName".to_string(), BsonValue::String("maximum".to_string()));
                rule.push("specifiedAs".to_string(), BsonValue::Document(specified));
                rule.push("reason".to_string(), BsonValue::String("comparison failed".to_string()));
                rule.push("consideredValue".to_string(), value.clone());
                details.push(rule);
            }
        }
    }
    if let (Some(BsonValue::Document(items)), BsonValue::Array(values)) = (schema.get("items"), value) {
        for (index, item) in values.iter().enumerate() {
            let item_details = schema_details(items, item);
            if item_details.is_empty() {
                continue;
            }
            let mut rule = BsonDocument::new();
            rule.push("operatorName".to_string(), BsonValue::String("items".to_string()));
            rule.push(
                "reason".to_string(),
                BsonValue::String("At least one item did not match the sub-schema".to_string()),
            );
            rule.push("itemIndex".to_string(), BsonValue::Int32(index as i32));
            rule.push("details".to_string(), BsonValue::Array(item_details.into_iter().map(BsonValue::Document).collect()));
            details.push(rule);
        }
    }
    details
}

fn validation_err_info(document: &BsonDocument, rules: Vec<BsonValue>) -> BsonDocument {
    let mut details = BsonDocument::new();
    details.push("operatorName".to_string(), BsonValue::String("$jsonSchema".to_string()));
    details.push("schemaRulesNotSatisfied".to_string(), BsonValue::Array(rules));
    let mut info = BsonDocument::new();
    info.push("failingDocumentId".to_string(), document.get("_id").cloned().unwrap_or(BsonValue::Null));
    info.push("details".to_string(), BsonValue::Document(details));
    info
}

/// Insert-path validation: `off` and `warn` never fail a write.
fn insert_validation_failure(store: &Store, namespace: &str, document: &BsonDocument) -> Option<BsonDocument> {
    let (schema, level, action) = collection_schema(store, namespace)?;
    if level == "off" || action == "warn" {
        return None;
    }
    let rules = schema_rules(&schema, document);
    if rules.is_empty() {
        return None;
    }
    Some(validation_err_info(document, rules))
}

/// Update-path validation: `moderate` skips documents that were already
/// invalid before the update, matching the server.
fn update_validation_failure(
    store: &Store,
    namespace: &str,
    original: &BsonDocument,
    updated: &BsonDocument,
) -> Option<BsonDocument> {
    let (schema, level, action) = collection_schema(store, namespace)?;
    if level == "off" || action == "warn" {
        return None;
    }
    if level == "moderate" {
        let before = schema_rules(&schema, original);
        if !before.is_empty() {
            return None;
        }
    }
    let rules = schema_rules(&schema, updated);
    if rules.is_empty() {
        return None;
    }
    Some(validation_err_info(updated, rules))
}

fn validation_options(command: &BsonDocument) -> Result<CollectionOptions, CommandError> {
    let mut options = CollectionOptions::default();
    if let Some(validator) = command.get("validator") {
        let BsonValue::Document(validator) = validator
        else {
            return Err(CommandError::new(2, "The 'validator' field must be an object".to_string()));
        };
        options.validator = Some(json::to_json(&BsonValue::Document(validator.clone())));
    }
    if let Some(level) = command.get("validationLevel") {
        let BsonValue::String(level) = level
        else {
            return Err(CommandError::new(2, "The 'validationLevel' field must be a string".to_string()));
        };
        if !matches!(level.as_str(), "off" | "strict" | "moderate") {
            return Err(CommandError::new(2, format!("Enumeration value '{level}' for field 'validationLevel' is not a valid value")));
        }
        options.validation_level = Some(level.clone());
    }
    if let Some(action) = command.get("validationAction") {
        let BsonValue::String(action) = action
        else {
            return Err(CommandError::new(2, "The 'validationAction' field must be a string".to_string()));
        };
        if !matches!(action.as_str(), "error" | "warn") {
            return Err(CommandError::new(2, format!("Enumeration value '{action}' for field 'validationAction' is not a valid value")));
        }
        options.validation_action = Some(action.clone());
    }
    Ok(options)
}

/// `create` with an optional validator, validation level, and action.
pub fn create(command: &BsonDocument, store: &Store) -> Result<BsonDocument, CommandError> {
    let Some(collection) = command.get("create").and_then(|value| match value {
        BsonValue::String(name) => Some(name.clone()),
        _ => None,
    })
    else {
        return Err(CommandError::new(73, "create command missing collection name"));
    };
    let namespace = format!("{}.{collection}", command.database());
    let options = validation_options(command)?;
    // `mongod 8.0.9` treats `create` as idempotent when the stored options
    // match, and refuses only when they differ.
    if store.namespace_exists(&namespace) {
        let existing = store.collection_options(&namespace);
        if existing != options {
            return Err(CommandError::new(48, create_conflict_message(&namespace, &existing)));
        }
        let mut response = BsonDocument::new();
        response.push("ok".to_string(), BsonValue::Double(1.0));
        return Ok(response);
    }
    store
        .create_collection(&namespace, options)
        .map_err(|error| CommandError::new(2, format!("create failed: {error}")))?;
    let mut response = BsonDocument::new();
    response.push("ok".to_string(), BsonValue::Double(1.0));
    Ok(response)
}

/// `collMod` updating validator, validation level, and validation action in
/// place.
pub fn coll_mod(command: &BsonDocument, store: &Store) -> Result<BsonDocument, CommandError> {
    let Some(collection) = command.get("collMod").and_then(|value| match value {
        BsonValue::String(name) => Some(name.clone()),
        _ => None,
    })
    else {
        return Err(CommandError::new(73, "collMod command missing collection name"));
    };
    let namespace = format!("{}.{collection}", command.database());
    if !store.namespace_exists(&namespace) {
        return Err(CommandError::new(26, "ns does not exist".to_string()));
    }
    let mut options = store.collection_options(&namespace);
    let changes = validation_options(command)?;
    if changes.validator.is_some() {
        options.validator = changes.validator;
    }
    if changes.validation_level.is_some() {
        options.validation_level = changes.validation_level;
    }
    if changes.validation_action.is_some() {
        options.validation_action = changes.validation_action;
    }
    store
        .set_collection_options(&namespace, options)
        .map_err(|error| CommandError::new(2, format!("collMod failed: {error}")))?;
    let mut response = BsonDocument::new();
    response.push("ok".to_string(), BsonValue::Double(1.0));
    Ok(response)
}

fn command_bool(command: &BsonDocument, field: &str, default: bool) -> bool {
    match command.get(field) {
        Some(BsonValue::Bool(flag)) => *flag,
        _ => default,
    }
}

fn find_projection(documents: Vec<BsonDocument>, fields: Option<&BsonValue>) -> Result<Vec<BsonDocument>, CommandError> {
    match fields {
        Some(BsonValue::Document(specification)) => project_stage(&documents, specification),
        _ => Ok(documents),
    }
}

/// `findAndModify`: `remove`, `new`, `upsert`, `fields`, and `sort`.
pub fn find_and_modify(command: &BsonDocument, store: &Store) -> Result<BsonDocument, CommandError> {
    let namespace = namespace_from_command(command, "findAndModify")
        .ok_or_else(|| CommandError::new(73, "findAndModify command missing collection name"))?;
    let empty = BsonDocument::new();
    let filter = match command.get("query") {
        Some(BsonValue::Document(filter)) => filter,
        _ => &empty,
    };
    validate_filter(filter, "findAndModify")?;
    let remove = command_bool(command, "remove", false);
    let return_new = command_bool(command, "new", false);
    let upsert = command_bool(command, "upsert", false);
    let update = match command.get("update") {
        Some(BsonValue::Document(update)) => Some(update),
        _ => None,
    };
    if remove && update.is_some() {
        return Err(CommandError::new(
            9,
            "Cannot specify both an update and remove=true".to_string(),
        ));
    }
    if !remove && update.is_none() {
        return Err(CommandError::new(
            9,
            "Either an update or remove=true must be specified".to_string(),
        ));
    }
    if remove && return_new {
        return Err(CommandError::new(
            9,
            "Cannot specify both new=true and remove=true; 'remove' always returns the deleted document".to_string(),
        ));
    }

    let sort = parse_sort(command.get("sort"));
    let mut documents = collect_matching(store, &namespace, filter)?;
    sort_documents(&mut documents, &sort);
    let matched = documents.first().cloned();

    if remove {
        let mut last_error = BsonDocument::new();
        if let Some(document) = &matched {
            last_error.push("n".to_string(), BsonValue::Int32(1));
            if let Some(identifier) = document.get("_id") {
                store.delete(&namespace, &[value_to_key(identifier)]).map_err(|error| CommandError::new(2, error.to_string()))?;
            }
            let value = find_projection(vec![document.clone()], command.get("fields"))?;
            return Ok(find_and_modify_reply(last_error, value.into_iter().next()));
        }
        last_error.push("n".to_string(), BsonValue::Int32(0));
        return Ok(find_and_modify_reply(last_error, None));
    }

    let update_document = update.expect("update checked above");
    let operator_update = update_document.fields.iter().any(|(field, _)| field.starts_with('$'));
    let index_specs = store.index_specs(&namespace);
    if let Some(document) = &matched {
        let identifier_value = document.get("_id").cloned();
        let identifier = identifier_value.as_ref().map(describe_id).unwrap_or_else(|| "<missing>".to_string());
        let updated = if operator_update {
            apply_update(document, update_document, &identifier, filter)?
        }
        else {
            build_replacement(update_document, identifier_value.as_ref())?
        };
        if let Some(info) = update_validation_failure(store, &namespace, document, &updated) {
            return Ok(find_and_modify_validation_failure(info));
        }
        if let Some(error) = parallel_array_error(&updated, &index_specs) {
            return Err(CommandError::new(error.code, error.message));
        }
        let key = value_to_key(identifier_value.as_ref().unwrap_or(&BsonValue::Null));
        store
            .replace(&namespace, &[(key, encode_bson(&updated))])
            .map_err(|error| CommandError::new(2, error.to_string()))?;
        let mut last_error = BsonDocument::new();
        last_error.push("n".to_string(), BsonValue::Int32(1));
        last_error.push("updatedExisting".to_string(), BsonValue::Bool(true));
        let selected = if return_new { updated } else { document.clone() };
        let value = find_projection(vec![selected], command.get("fields"))?;
        return Ok(find_and_modify_reply(last_error, value.into_iter().next()));
    }

    if upsert {
        let mut inserted = if operator_update {
            let base = upsert_base(filter);
            let identifier = base.get("_id").map(describe_id).unwrap_or_else(|| "<missing>".to_string());
            apply_update(&base, update_document, &identifier, filter)?
        }
        else {
            let query_identifier = match filter.get("_id") {
                Some(BsonValue::Document(operators)) if has_operator(operators) => None,
                Some(value) => Some(value.clone()),
                None => None,
            };
            build_replacement(update_document, query_identifier.as_ref())?
        };
        if inserted.get("_id").is_none() {
            inserted.fields.insert(0, ("_id".to_string(), BsonValue::ObjectId(generate_object_id())));
        }
        if let Some(info) = insert_validation_failure(store, &namespace, &inserted) {
            return Ok(find_and_modify_validation_failure(info));
        }
        let identifier = inserted.get("_id").cloned().unwrap_or(BsonValue::Null);
        let candidates = vec![(0_usize, inserted.clone(), identifier.clone())];
        let mut write_errors = Vec::new();
        commit_insert(store, &namespace, &candidates, &Vec::new(), true, &mut write_errors)?;
        if let Some(error) = write_errors.first() {
            return Err(CommandError::new(error.code, error.message.clone()));
        }
        let mut last_error = BsonDocument::new();
        last_error.push("n".to_string(), BsonValue::Int32(1));
        last_error.push("updatedExisting".to_string(), BsonValue::Bool(false));
        last_error.push("upserted".to_string(), identifier);
        let selected = if return_new { Some(inserted) } else { None };
        let value = match selected {
            Some(document) => find_projection(vec![document], command.get("fields"))?.into_iter().next(),
            None => None,
        };
        return Ok(find_and_modify_reply(last_error, value));
    }

    let mut last_error = BsonDocument::new();
    last_error.push("n".to_string(), BsonValue::Int32(0));
    last_error.push("updatedExisting".to_string(), BsonValue::Bool(false));
    Ok(find_and_modify_reply(last_error, None))
}

fn find_and_modify_reply(last_error: BsonDocument, value: Option<BsonDocument>) -> BsonDocument {
    let mut response = BsonDocument::new();
    response.push("lastErrorObject".to_string(), BsonValue::Document(last_error));
    response.push("value".to_string(), value.map(BsonValue::Document).unwrap_or(BsonValue::Null));
    response.push("ok".to_string(), BsonValue::Double(1.0));
    response
}

fn find_and_modify_validation_failure(info: BsonDocument) -> BsonDocument {
    let mut last_error = BsonDocument::new();
    last_error.push("n".to_string(), BsonValue::Int32(0));
    last_error.push("updatedExisting".to_string(), BsonValue::Bool(false));
    let mut response = BsonDocument::new();
    response.push("lastErrorObject".to_string(), BsonValue::Document(last_error));
    response.push("value".to_string(), BsonValue::Null);
    response.push("code".to_string(), BsonValue::Int32(121));
    response.push("errmsg".to_string(), BsonValue::String("Document failed validation".to_string()));
    response.push("errInfo".to_string(), BsonValue::Document(info));
    response.push("ok".to_string(), BsonValue::Double(1.0));
    response
}

/// `distinct`: nested paths, one-level array flattening, query filtering, and
/// first-occurrence ordering.
pub fn distinct(command: &BsonDocument, store: &Store) -> Result<BsonDocument, CommandError> {
    let namespace = namespace_from_command(command, "distinct")
        .ok_or_else(|| CommandError::new(73, "distinct command missing collection name"))?;
    let Some(key) = command.get("key") else {
        return Err(CommandError::new(40414, "BSON field 'distinct.key' is missing but a required field"));
    };
    let BsonValue::String(key) = key
    else {
        return Err(CommandError::new(
            14,
            format!("BSON field 'distinctCommandRequest.key' is the wrong type '{}', expected type 'string'", bson_type_name(key)),
        ));
    };
    let empty = BsonDocument::new();
    let filter = match command.get("query") {
        Some(BsonValue::Document(filter)) => filter,
        _ => &empty,
    };
    validate_filter(filter, "distinct")?;

    let segments: Vec<&str> = key.split('.').collect();
    let mut seen: BTreeSet<Vec<u8>> = BTreeSet::new();
    let mut values = Vec::new();
    for (_key, payload) in store.scan(&namespace) {
        let Ok(document) = parse_bson(&payload)
        else {
            continue;
        };
        if !document_matches(&document, filter)? {
            continue;
        }
        let mut matched = Vec::new();
        collect_values_at(&document, &segments, &mut matched);
        for value in matched {
            collect_distinct(value, &mut seen, &mut values);
        }
    }
    // `mongod` collects distinct values in a sorted BSON set, so the reply is
    // ordered by canonical type and value instead of by scan order.
    values.sort_by(compare_values);
    let mut response = BsonDocument::new();
    response.push("values".to_string(), BsonValue::Array(values));
    response.push("ok".to_string(), BsonValue::Double(1.0));
    Ok(response)
}

fn collect_distinct(value: &BsonValue, seen: &mut BTreeSet<Vec<u8>>, values: &mut Vec<BsonValue>) {
    match value {
        BsonValue::Array(items) => {
            for item in items {
                if seen.insert(value_to_key(item)) {
                    values.push(item.clone());
                }
            }
        }
        other => {
            if seen.insert(value_to_key(other)) {
                values.push(other.clone());
            }
        }
    }
}

/// `bulkWrite` over `admin`, with ordered / unordered execution and the
/// aggregate counters the server reports alongside per-operation results.
pub fn bulk_write(command: &BsonDocument, store: &Store) -> Result<BsonDocument, CommandError> {
    if command.database() != "admin" {
        return Err(CommandError::new(13, "bulkWrite may only be run against the admin database.".to_string()));
    }
    let Some(BsonValue::Array(operations)) = command.get("ops") else {
        return Err(CommandError::new(40414, "BSON field 'bulkWrite.ops' is missing but a required field"));
    };
    if operations.is_empty() || operations.len() > 100_000 {
        return Err(CommandError::new(
            16,
            format!("Write batch sizes must be between 1 and 100000. Got {} operations.", operations.len()),
        ));
    }
    let Some(BsonValue::Array(namespaces)) = command.get("nsInfo") else {
        return Err(CommandError::new(40414, "BSON field 'bulkWrite.nsInfo' is missing but a required field"));
    };
    let names: Vec<String> = namespaces
        .iter()
        .map(|entry| match entry {
            BsonValue::Document(entry) => match entry.get("ns") {
                Some(BsonValue::String(name)) => Ok(name.clone()),
                _ => Err(CommandError::new(2, "nsInfo entries require a string 'ns' field".to_string())),
            },
            _ => Err(CommandError::new(2, "nsInfo entries must be documents".to_string())),
        })
        .collect::<Result<_, _>>()?;
    let ordered = command_bool(command, "ordered", true);
    let errors_only = command_bool(command, "errorsOnly", false);

    let mut results = Vec::new();
    let mut n_errors = 0_i64;
    let mut n_inserted = 0_i64;
    let mut n_matched = 0_i64;
    let mut n_modified = 0_i64;
    let mut n_upserted = 0_i64;
    let mut n_deleted = 0_i64;

    for (index, operation) in operations.iter().enumerate() {
        let BsonValue::Document(operation) = operation
        else {
            return Err(CommandError::new(2, "BulkWrite ops entry must be a document".to_string()));
        };
        let kind = ["insert", "update", "delete"]
            .into_iter()
            .find(|field| operation.get(field).is_some())
            .ok_or_else(|| CommandError::new(2, "BulkWrite ops entry must be an insert, update, or delete".to_string()))?;
        let Some(BsonValue::Int32(namespace_index)) = operation.get(kind) else {
            return Err(CommandError::new(
                2,
                format!(
                    "BulkWrite ops entry {} has an invalid nsInfo index.",
                    render_shell_value(&BsonValue::Document(operation.clone()))
                ),
            ));
        };
        let namespace_index = usize::try_from(*namespace_index).ok();
        let Some(namespace_index) = namespace_index.filter(|index| *index < names.len()) else {
            return Err(CommandError::new(
                2,
                format!(
                    "BulkWrite ops entry {} has an invalid nsInfo index.",
                    render_shell_value(&BsonValue::Document(operation.clone()))
                ),
            ));
        };
        let namespace = &names[namespace_index];
        let (database, collection) = namespace
            .split_once('.')
            .ok_or_else(|| CommandError::new(2, format!("nsInfo namespace '{namespace}' is not fully qualified")))?;

        let reply = match kind {
            "insert" => {
                let Some(document) = operation.get("document") else {
                    return Err(CommandError::new(2, "BulkWrite insert entry requires a 'document' field".to_string()));
                };
                let mut request = BsonDocument::new();
                request.push("insert".to_string(), BsonValue::String(collection.to_string()));
                request.push("documents".to_string(), BsonValue::Array(vec![document.clone()]));
                request.push("$db".to_string(), BsonValue::String(database.to_string()));
                insert(&request, store)?
            }
            "update" => {
                let Some(filter) = operation.get("filter") else {
                    return Err(CommandError::new(2, "BulkWrite update entry requires a 'filter' field".to_string()));
                };
                let Some(update_mods) = operation.get("updateMods") else {
                    return Err(CommandError::new(2, "BulkWrite update entry requires an 'updateMods' field".to_string()));
                };
                let mut specification = BsonDocument::new();
                specification.push("q".to_string(), filter.clone());
                specification.push("u".to_string(), update_mods.clone());
                if let Some(value) = operation.get("multi") {
                    specification.push("multi".to_string(), value.clone());
                }
                if let Some(value) = operation.get("upsert") {
                    specification.push("upsert".to_string(), value.clone());
                }
                let mut request = BsonDocument::new();
                request.push("update".to_string(), BsonValue::String(collection.to_string()));
                request.push("updates".to_string(), BsonValue::Array(vec![BsonValue::Document(specification)]));
                request.push("$db".to_string(), BsonValue::String(database.to_string()));
                update(&request, store)?
            }
            _ => {
                let Some(filter) = operation.get("filter") else {
                    return Err(CommandError::new(2, "BulkWrite delete entry requires a 'filter' field".to_string()));
                };
                let limit = if command_bool(operation, "multi", false) { 0 } else { 1 };
                let mut specification = BsonDocument::new();
                specification.push("q".to_string(), filter.clone());
                specification.push("limit".to_string(), BsonValue::Int32(limit));
                let mut request = BsonDocument::new();
                request.push("delete".to_string(), BsonValue::String(collection.to_string()));
                request.push("deletes".to_string(), BsonValue::Array(vec![BsonValue::Document(specification)]));
                request.push("$db".to_string(), BsonValue::String(database.to_string()));
                delete(&request, store)?
            }
        };

        let write_errors = match reply.get("writeErrors") {
            Some(BsonValue::Array(errors)) => errors,
            _ => &Vec::new(),
        };
        let failed = !write_errors.is_empty();
        let mut result = BsonDocument::new();
        result.push("ok".to_string(), BsonValue::Double(if failed { 0.0 } else { 1.0 }));
        result.push("idx".to_string(), BsonValue::Int32(index as i32));
        if let Some(first) = write_errors.first() {
            let BsonValue::Document(first) = first else {
                return Err(CommandError::new(2, "writeErrors entries must be documents".to_string()));
            };
            for (field, value) in &first.fields {
                if field == "index" {
                    continue;
                }
                result.push(field.clone(), value.clone());
            }
            result.push("n".to_string(), BsonValue::Int32(0));
            n_errors += 1;
        }
        else {
            let n = reply_count(&reply, "n");
            match kind {
                "insert" => {
                    n_inserted += n;
                    result.push("n".to_string(), count_value(n));
                }
                "update" => {
                    if let Some(upserted) = reply.get("upserted") {
                        n_upserted += 1;
                        result.push("n".to_string(), count_value(n));
                        let modified = reply_count(&reply, "nModified");
                        n_modified += modified;
                        result.push("nModified".to_string(), count_value(modified));
                        let upserted = match upserted {
                            BsonValue::Array(items) => items.first().and_then(|item| match item {
                                BsonValue::Document(entry) => entry.get("_id").cloned(),
                                _ => None,
                            }),
                            other => Some(other.clone()),
                        };
                        if let Some(identifier) = upserted {
                            let mut entry = BsonDocument::new();
                            entry.push("_id".to_string(), identifier);
                            result.push("upserted".to_string(), BsonValue::Document(entry));
                        }
                    }
                    else {
                        n_matched += n;
                        let modified = reply_count(&reply, "nModified");
                        n_modified += modified;
                        result.push("n".to_string(), count_value(n));
                        result.push("nModified".to_string(), count_value(modified));
                    }
                }
                _ => {
                    n_deleted += n;
                    result.push("n".to_string(), count_value(n));
                }
            }
        }

        if !errors_only || failed {
            results.push(BsonValue::Document(result));
        }
        if failed && ordered {
            break;
        }
    }

    let mut cursor = BsonDocument::new();
    cursor.push("id".to_string(), BsonValue::Int64(0));
    cursor.push("firstBatch".to_string(), BsonValue::Array(results));
    cursor.push("ns".to_string(), BsonValue::String("admin.$cmd.bulkWrite".to_string()));
    let mut response = BsonDocument::new();
    response.push("cursor".to_string(), BsonValue::Document(cursor));
    response.push("nErrors".to_string(), count_value(n_errors));
    response.push("nInserted".to_string(), count_value(n_inserted));
    response.push("nMatched".to_string(), count_value(n_matched));
    response.push("nModified".to_string(), count_value(n_modified));
    response.push("nUpserted".to_string(), count_value(n_upserted));
    response.push("nDeleted".to_string(), count_value(n_deleted));
    response.push("ok".to_string(), BsonValue::Double(1.0));
    Ok(response)
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
    response.push("ok".to_string(), BsonValue::Double(1.0));
    response
}

/// `createIndexes` for single-field and compound keys, `unique`, and explicit
/// names.
///
/// `name` is required: `mongod 8.0.9` rejects a specification without it, so
/// this gateway does not invent a default name either.
pub fn create_indexes(command: &BsonDocument, store: &Store) -> Result<BsonDocument, CommandError> {
    let namespace = namespace_from_command(command, "createIndexes")
        .ok_or_else(|| CommandError::new(73, "createIndexes command missing collection name"))?;
    let Some(BsonValue::Array(specifications)) = command.get("indexes")
    else {
        return Err(CommandError::new(40414, "BSON field 'createIndexes.indexes' is missing but a required field"));
    };
    if specifications.is_empty() {
        return Err(CommandError::new(2, "Must specify at least one index to create"));
    }

    let existing = store.index_specs(&namespace);
    let existed = store.namespace_exists(&namespace);
    let mut known = existing.clone();
    let mut accepted: Vec<IndexSpec> = Vec::new();
    let mut skipped = 0_usize;

    for item in specifications {
        let BsonValue::Document(specification) = item
        else {
            return Err(CommandError::new(2, "index specification must be a document"));
        };
        let Some(BsonValue::Document(key)) = specification.get("key")
        else {
            return Err(CommandError::new(
                9,
                format!(
                    "Error in specification {} :: caused by :: The 'key' field is a required property of an index specification",
                    render_shell_value(&BsonValue::Document(specification.clone()))
                ),
            ));
        };
        if key.fields.is_empty() {
            return Err(CommandError::new(
                67,
                format!(
                    "Error in specification {} :: caused by :: Index keys cannot be empty.",
                    render_shell_value(&BsonValue::Document(specification.clone()))
                ),
            ));
        }
        let Some(BsonValue::String(name)) = specification.get("name")
        else {
            return Err(CommandError::new(
                9,
                format!(
                    "Error in specification {} :: caused by :: The 'name' field is a required property of an index specification",
                    render_shell_value(&BsonValue::Document(specification.clone()))
                ),
            ));
        };
        if name.is_empty() {
            let mut rendered = specification.clone();
            rendered.push("v".to_string(), BsonValue::Int32(2));
            return Err(CommandError::new(
                67,
                format!(
                    "Error in specification {} :: caused by :: index name cannot be empty",
                    render_shell_value(&BsonValue::Document(rendered))
                ),
            ));
        }
        let unique = matches!(specification.get("unique"), Some(BsonValue::Bool(true)));

        if let Some(hit) = known.iter().find(|index| index.name == *name) {
            if hit.key == *key && hit.unique == unique {
                skipped += 1;
                continue;
            }
            let requested = render_index_definition(key, name, unique);
            let present = render_index_definition(&hit.key, &hit.name, hit.unique);
            return Err(CommandError::new(
                86,
                format!(
                    "An existing index has the same name as the requested index. When index names are not specified, they are auto generated and can cause conflicts. Please refer to our documentation. Requested index: {requested}, existing index: {present}"
                ),
            ));
        }
        if let Some(hit) = known.iter().find(|index| index.key == *key && index.unique == unique) {
            return Err(CommandError::new(85, format!("Index already exists with a different name: {}", hit.name)));
        }

        let candidate = IndexSpec {
            namespace: namespace.clone(),
            name: name.clone(),
            key: key.clone(),
            unique,
        };
        if unique {
            verify_unique_build(store, &namespace, &candidate)?;
        }
        known.push(candidate.clone());
        accepted.push(candidate);
    }

    if !accepted.is_empty() {
        store
            .add_indexes(&namespace, &accepted)
            .map_err(|error| CommandError::new(2, format!("createIndexes failed: {error}")))?;
    }

    let before = 1 + existing.len() as i64;
    let after = before + accepted.len() as i64;
    let mut reply = BsonDocument::new();
    reply.push("numIndexesBefore".to_string(), count_value(before));
    reply.push("numIndexesAfter".to_string(), count_value(after));
    if accepted.is_empty() {
        reply.push("note".to_string(), BsonValue::String("all indexes already exist".to_string()));
    } else {
        reply.push("createdCollectionAutomatically".to_string(), BsonValue::Bool(!existed));
        if skipped > 0 {
            reply.push("note".to_string(), BsonValue::String("index already exists".to_string()));
        }
    }
    reply.push("ok".to_string(), BsonValue::Double(1.0));
    Ok(reply)
}

fn render_index_definition(key: &BsonDocument, name: &str, unique: bool) -> String {
    let mut specification = BsonDocument::new();
    specification.push("v".to_string(), BsonValue::Int32(2));
    if unique {
        specification.push("unique".to_string(), BsonValue::Bool(true));
    }
    specification.push("key".to_string(), BsonValue::Document(key.clone()));
    specification.push("name".to_string(), BsonValue::String(name.to_string()));
    render_shell_value(&BsonValue::Document(specification))
}

/// Refuses to build a unique index over documents that already collide.
fn verify_unique_build(store: &Store, namespace: &str, specification: &IndexSpec) -> Result<(), CommandError> {
    let mut seen: BTreeSet<Vec<u8>> = BTreeSet::new();
    for (_, payload) in store.scan(namespace) {
        let Ok(document) = parse_bson(&payload)
        else {
            continue;
        };
        for values in index_entries(&document, specification) {
            if !seen.insert(index_tuple(&values)) {
                let key_value = specification.key.fields.iter().zip(values.iter()).fold(
                    BsonDocument::new(),
                    |mut document, ((field, _), value)| {
                        document.push(field.clone(), value.clone());
                        document
                    },
                );
                return Err(CommandError::new(
                    11000,
                    format!(
                        "Index build failed: {}: Collection {} ( {} ) :: caused by :: {}",
                        seeded_uuid(&format!("{namespace}|{}|build", specification.name)),
                        namespace,
                        seeded_uuid(namespace),
                        duplicate_message(namespace, specification, &values)
                    ),
                )
                .with_detail("keyPattern", BsonValue::Document(specification.key.clone()))
                .with_detail("keyValue", BsonValue::Document(key_value)));
            }
        }
    }
    Ok(())
}

/// Deterministic UUID-shaped identifier.
///
/// `mongod` prints its random collection UUID and index-build operation UUID in
/// this message. Their concrete values are opaque and change per build, so this
/// gateway derives stable ones from the namespace instead: the message template
/// is byte-identical while the two UUID slots stay reproducible for tests.
fn seeded_uuid(seed: &str) -> String {
    let high = fnv1a64(0xcbf2_9ce4_8422_2325, seed);
    let low = fnv1a64(0x8422_2325_cbf2_9ce4, seed);
    let high = (high & 0xffff_ffff_ffff_0fff) | 0x0000_0000_0000_4000;
    let low = (low & 0x3fff_ffff_ffff_ffff) | 0x8000_0000_0000_0000;
    format!(
        "{:08x}-{:04x}-{:04x}-{:04x}-{:012x}",
        high >> 32,
        (high >> 16) & 0xffff,
        high & 0xffff,
        low >> 48,
        low & 0xffff_ffff_ffff
    )
}

fn fnv1a64(offset: u64, text: &str) -> u64 {
    let mut hash = offset;
    for byte in text.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

fn duplicate_message(namespace: &str, specification: &IndexSpec, values: &[BsonValue]) -> String {
    let rendered: Vec<String> = specification
        .key
        .fields
        .iter()
        .zip(values)
        .map(|((field, _), value)| format!("{field}: {}", render_shell_value(value)))
        .collect();
    format!(
        "E11000 duplicate key error collection: {namespace} index: {} dup key: {{ {} }}",
        specification.name,
        rendered.join(", ")
    )
}

/// `listIndexes`: `_id_` first, then user indexes in creation order.
pub fn list_indexes(command: &BsonDocument, store: &Store) -> Result<BsonDocument, CommandError> {
    let namespace = namespace_from_command(command, "listIndexes")
        .ok_or_else(|| CommandError::new(73, "listIndexes command missing collection name"))?;
    if !store.namespace_exists(&namespace) {
        return Err(CommandError::new(26, format!("ns does not exist: {namespace}")));
    }

    let mut first_batch: Vec<BsonValue> = Vec::new();
    let mut identifier = BsonDocument::new();
    identifier.push("_id".to_string(), BsonValue::Int32(1));
    let mut entry = BsonDocument::new();
    entry.push("v".to_string(), BsonValue::Int32(2));
    entry.push("key".to_string(), BsonValue::Document(identifier));
    entry.push("name".to_string(), BsonValue::String("_id_".to_string()));
    first_batch.push(BsonValue::Document(entry));

    for specification in store.index_specs(&namespace) {
        let mut entry = BsonDocument::new();
        entry.push("v".to_string(), BsonValue::Int32(2));
        entry.push("key".to_string(), BsonValue::Document(specification.key));
        entry.push("name".to_string(), BsonValue::String(specification.name));
        if specification.unique {
            entry.push("unique".to_string(), BsonValue::Bool(true));
        }
        first_batch.push(BsonValue::Document(entry));
    }

    let mut cursor = BsonDocument::new();
    cursor.push("id".to_string(), BsonValue::Int64(0));
    cursor.push("ns".to_string(), BsonValue::String(namespace));
    cursor.push("firstBatch".to_string(), BsonValue::Array(first_batch));
    let mut reply = BsonDocument::new();
    reply.push("cursor".to_string(), BsonValue::Document(cursor));
    reply.push("ok".to_string(), BsonValue::Double(1.0));
    Ok(reply)
}

/// `dropIndexes` by name, `*`, or key pattern; `_id_` is never droppable.
pub fn drop_indexes(command: &BsonDocument, store: &Store) -> Result<BsonDocument, CommandError> {
    let namespace = namespace_from_command(command, "dropIndexes")
        .ok_or_else(|| CommandError::new(73, "dropIndexes command missing collection name"))?;
    if !store.namespace_exists(&namespace) {
        return Err(CommandError::new(26, format!("ns not found {namespace}")));
    }
    let existing = store.index_specs(&namespace);
    let name = match command.get("index") {
        Some(BsonValue::String(name)) => name.clone(),
        Some(BsonValue::Document(key)) => {
            let mut identifier = BsonDocument::new();
            identifier.push("_id".to_string(), BsonValue::Int32(1));
            if key_pattern_matches(key, &identifier) {
                return Err(CommandError::new(72, "cannot drop _id index"));
            }
            match existing.iter().find(|index| key_pattern_matches(key, &index.key)) {
                Some(index) => index.name.clone(),
                None => {
                    return Err(CommandError::new(
                        27,
                        format!("can't find index with key: {}", render_shell_value(&BsonValue::Document(key.clone()))),
                    ))
                }
            }
        }
        Some(other) => {
            return Err(CommandError::new(
                14,
                format!(
                    "BSON field 'dropIndexes.index' is the wrong type '{}', expected types '[string']",
                    bson_type_name(other)
                ),
            ))
        }
        None => return Err(CommandError::new(40414, "BSON field 'dropIndexes.index' is missing but a required field")),
    };

    let before = 1 + existing.len() as i64;
    if name == "_id_" {
        return Err(CommandError::new(72, "cannot drop _id index"));
    }
    if name != "*" && !existing.iter().any(|index| index.name == name) {
        return Err(CommandError::new(27, format!("index not found with name [{name}]")));
    }

    store.drop_indexes(&namespace, &name).map_err(|error| CommandError::new(2, format!("dropIndexes failed: {error}")))?;

    let mut reply = BsonDocument::new();
    reply.push("nIndexesWas".to_string(), count_value(before));
    if name == "*" {
        reply.push("msg".to_string(), BsonValue::String("non-_id indexes dropped for collection".to_string()));
    }
    reply.push("ok".to_string(), BsonValue::Double(1.0));
    Ok(reply)
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
    response.push("ok".to_string(), BsonValue::Double(1.0));
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
            "unknown aggregation stage: {stage} (supported: $match, $sort, $limit, $skip, $count, $unwind, $lookup, $sortByCount, $group, $project)"
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

/// `$lookup` equality form (`from` / `localField` / `foreignField` / `as`).
///
/// A local array is expanded element by element and the matching foreign
/// documents are unioned in storage order, which is what `mongod 8.0.9` returns
/// for the equality form. Sub-pipelines are a different implementation and stay
/// outside this gateway.
fn lookup_stage(
    documents: Vec<BsonDocument>,
    body: &BsonValue,
    store: &Store,
    namespace: &str,
) -> Result<Vec<BsonDocument>, CommandError> {
    let BsonValue::Document(specification) = body
    else {
        return Err(CommandError::new(9, "$lookup requires a document"));
    };
    if specification.get("pipeline").is_some() || specification.get("let").is_some() {
        return Err(CommandError::new(
            59,
            "$lookup sub-pipelines are outside this gateway (coordinate: only `from` + `localField` + `foreignField` + `as` is supported)",
        ));
    }

    let from = match specification.get("from") {
        Some(BsonValue::String(name)) if !name.is_empty() => name.clone(),
        Some(BsonValue::String(_)) | None => {
            return Err(CommandError::new(9, "must specify 'pipeline' when 'from' is empty"));
        }
        Some(other) => {
            return Err(CommandError::new(
                9,
                format!("$lookup 'from' field must be a string, but found {}", bson_type_name(other)),
            ));
        }
    };
    let as_field = match specification.get("as") {
        Some(BsonValue::String(field)) if !field.is_empty() => field.clone(),
        Some(other) => {
            return Err(CommandError::new(
                9,
                format!(
                    "$lookup argument 'as' must be a string, found as: {}: {}",
                    render_shell_value(other),
                    bson_type_name(other)
                ),
            ));
        }
        None => return Err(CommandError::new(9, "must specify 'as' field for a $lookup")),
    };
    let (Some(local_field), Some(foreign_field)) = (specification.get("localField"), specification.get("foreignField"))
    else {
        return Err(CommandError::new(
            9,
            "$lookup requires either 'pipeline' or both 'localField' and 'foreignField' to be specified",
        ));
    };
    let BsonValue::String(local_field) = local_field else {
        return Err(CommandError::new(
            9,
            format!(
                "$lookup argument 'localField' must be a string, found localField: {}: {}",
                render_shell_value(local_field),
                bson_type_name(local_field)
            ),
        ));
    };
    let BsonValue::String(foreign_field) = foreign_field else {
        return Err(CommandError::new(
            9,
            format!(
                "$lookup argument 'foreignField' must be a string, found foreignField: {}: {}",
                render_shell_value(foreign_field),
                bson_type_name(foreign_field)
            ),
        ));
    };

    let database = namespace.split_once('.').map(|(database, _)| database).unwrap_or("admin");
    let foreign_namespace = format!("{database}.{from}");
    let foreign_documents = collect_matching(store, &foreign_namespace, &BsonDocument::new())?;

    let mut output = Vec::with_capacity(documents.len());
    for document in documents {
        let value = lookup_field(&document, local_field).cloned().unwrap_or(BsonValue::Null);
        let mut matched = vec![false; foreign_documents.len()];
        let mut joined: Vec<BsonValue> = Vec::new();
        let local_values: Vec<&BsonValue> = match &value {
            BsonValue::Array(items) if !items.is_empty() => items.iter().collect(),
            // An empty local array matches the same foreign values as a missing
            // or null local field does, which is what `mongod 8.0.9` returns.
            BsonValue::Array(_) => vec![&BsonValue::Null],
            other => vec![other],
        };
        for (index, foreign_document) in foreign_documents.iter().enumerate() {
            let candidates = collect_field(foreign_document, foreign_field);
            if local_values.iter().any(|local| equality_candidates(&candidates, local)) && !matched[index] {
                matched[index] = true;
                joined.push(BsonValue::Document(foreign_document.clone()));
            }
        }
        let mut expanded = document;
        set_field_path(&mut expanded, &as_field, BsonValue::Array(joined));
        output.push(expanded);
    }
    Ok(output)
}

/// `$sortByCount` over a `$`-prefixed field path.
///
/// The whole value is one group key, including an array or an empty array, and a
/// missing field groups as `null`, matching `mongod 8.0.9`. Expression objects
/// are a separate implementation and stay outside this gateway.
fn sort_by_count_stage(documents: &[BsonDocument], body: &BsonValue) -> Result<Vec<BsonDocument>, CommandError> {
    let path = match body {
        BsonValue::String(path) if path.starts_with('$') && path.len() > 1 => path[1..].to_string(),
        BsonValue::String(_) => {
            return Err(CommandError::new(
                40148,
                "the sortByCount field must be defined as a $-prefixed path or an expression inside an object",
            ));
        }
        BsonValue::Document(_) => {
            return Err(CommandError::new(
                59,
                "$sortByCount expressions are outside this gateway (coordinate: only `$`-prefixed field paths are supported)",
            ));
        }
        _ => {
            return Err(CommandError::new(
                40149,
                "the sortByCount field must be specified as a string or as an object",
            ));
        }
    };

    let mut groups: Vec<(BsonValue, i32)> = Vec::new();
    let mut positions: BTreeMap<Vec<u8>, usize> = BTreeMap::new();
    for document in documents {
        let value = lookup_field(document, &path).cloned().unwrap_or(BsonValue::Null);
        match positions.get(&value_to_key(&value)) {
            Some(position) => groups[*position].1 += 1,
            None => {
                positions.insert(value_to_key(&value), groups.len());
                groups.push((value, 1));
            }
        }
    }
    // Descending count, ties in first-appearance order. `mongod` leaves equal
    // counts in hash order, so equal counts are never asserted.
    groups.sort_by(|left, right| right.1.cmp(&left.1));
    Ok(groups
        .into_iter()
        .map(|(value, count)| {
            let mut grouped = BsonDocument::new();
            grouped.push("_id".to_string(), value);
            grouped.push("count".to_string(), count_value(i64::from(count)));
            grouped
        })
        .collect())
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

/// `$addFields`: keeps every input field and adds or replaces the specified
/// paths. Expressions are evaluated against the input document, so fields in
/// the same specification never observe each other.
fn add_fields_stage(documents: &[BsonDocument], specification: &BsonDocument) -> Result<Vec<BsonDocument>, CommandError> {
    let mut output = Vec::with_capacity(documents.len());
    for document in documents {
        let mut result = document.clone();
        for (field, expression) in &specification.fields {
            if field.starts_with('$') {
                return Err(CommandError::new(
                    2,
                    "FieldPath field names may not start with '$'. Consider using $getField or $setField.",
                ));
            }
            let value = evaluate_expression(document, expression)?;
            let segments: Vec<&str> = field.split('.').collect();
            set_segments(&mut result, &segments, value)?;
        }
        output.push(result);
    }
    Ok(output)
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

fn reply_count(reply: &BsonDocument, field: &str) -> i64 {
    match reply.get(field) {
        Some(BsonValue::Int32(value)) => i64::from(*value),
        Some(BsonValue::Int64(value)) => *value,
        Some(BsonValue::Double(value)) => *value as i64,
        _ => 0,
    }
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
        BsonValue::Undefined => 0,
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
