//! Extended-JSON bridge so non-Rust hosts can call the command primitives.
//!
//! BSON loses precision if it is flattened to plain JSON, so values use the
//! MongoDB extended-JSON forms: `{"$oid": ...}`, `{"$numberInt": ...}`,
//! `{"$numberLong": ...}`, `{"$numberDouble": ...}`, `{"$binary": {...}}`.

use crate::bson::{BsonDocument, BsonValue};
use serde_json::{Map, Value};

/// Converts a BSON value into its extended-JSON form.
pub fn to_json(value: &BsonValue) -> Value {
    match value {
        BsonValue::Document(document) => Value::Object(to_json_document(document)),
        BsonValue::Array(items) => Value::Array(items.iter().map(to_json).collect()),
        BsonValue::String(text) => Value::String(text.clone()),
        BsonValue::Int32(number) => tagged("$numberInt", number.to_string()),
        BsonValue::Int64(number) => tagged("$numberLong", number.to_string()),
        BsonValue::Double(number) => tagged("$numberDouble", format!("{number:?}")),
        BsonValue::Bool(flag) => Value::Bool(*flag),
        BsonValue::Null => Value::Null,
        BsonValue::ObjectId(bytes) => tagged("$oid", hex_encode(bytes)),
        BsonValue::Binary(bytes) => {
            let mut payload = Map::new();
            payload.insert("base64".to_string(), Value::String(base64_encode(bytes)));
            payload.insert("subType".to_string(), Value::String("00".to_string()));
            let mut wrapper = Map::new();
            wrapper.insert("$binary".to_string(), Value::Object(payload));
            Value::Object(wrapper)
        }
    }
}

/// Converts a BSON document into an extended-JSON object.
pub fn to_json_document(document: &BsonDocument) -> Map<String, Value> {
    let mut object = Map::new();
    for (key, value) in &document.fields {
        object.insert(key.clone(), to_json(value));
    }
    object
}

/// Parses an extended-JSON value back into BSON.
pub fn from_json(value: &Value) -> Result<BsonValue, String> {
    match value {
        Value::Null => Ok(BsonValue::Null),
        Value::Bool(flag) => Ok(BsonValue::Bool(*flag)),
        Value::String(text) => Ok(BsonValue::String(text.clone())),
        Value::Array(items) => Ok(BsonValue::Array(items.iter().map(from_json).collect::<Result<Vec<_>, _>>()?)),
        Value::Number(number) => {
            if let Some(integer) = number.as_i64() {
                if i32::try_from(integer).is_ok() {
                    Ok(BsonValue::Int32(integer as i32))
                }
                else {
                    Ok(BsonValue::Int64(integer))
                }
            }
            else {
                number.as_f64().map(BsonValue::Double).ok_or_else(|| "number is not representable".to_string())
            }
        }
        Value::Object(object) => {
            if object.len() == 1 {
                if let Some(tag) = object.keys().next() {
                    if let Some(parsed) = parse_tagged(tag, object.values().next().unwrap())? {
                        return Ok(parsed);
                    }
                }
            }
            let mut document = BsonDocument::new();
            for (key, item) in object {
                document.push(key.clone(), from_json(item)?);
            }
            Ok(BsonValue::Document(document))
        }
    }
}

/// Parses an extended-JSON object into a BSON document.
pub fn from_json_document(object: &Map<String, Value>) -> Result<BsonDocument, String> {
    let mut document = BsonDocument::new();
    for (key, value) in object {
        document.push(key.clone(), from_json(value)?);
    }
    Ok(document)
}

/// Parses an extended-JSON text into a BSON command document.
pub fn document_from_json(text: &str) -> Result<BsonDocument, String> {
    let value: Value = serde_json::from_str(text).map_err(|error| format!("invalid JSON: {error}"))?;
    match from_json(&value)? {
        BsonValue::Document(document) => Ok(document),
        _ => Err("a JSON object is required".to_string()),
    }
}

/// Serializes a BSON document into extended-JSON text.
pub fn document_to_json(document: &BsonDocument) -> String {
    Value::Object(to_json_document(document)).to_string()
}

/// Serializes a BSON value into extended-JSON text.
pub fn value_to_json_text(value: &BsonValue) -> String {
    to_json(value).to_string()
}

fn tagged(tag: &str, payload: String) -> Value {
    let mut object = Map::new();
    object.insert(tag.to_string(), Value::String(payload));
    Value::Object(object)
}

fn parse_tagged(tag: &str, payload: &Value) -> Result<Option<BsonValue>, String> {
    match tag {
        "$oid" => {
            let text = payload.as_str().ok_or_else(|| "`$oid` must be a string".to_string())?;
            let bytes = hex_decode(text)?;
            let identifier: [u8; 12] = bytes.try_into().map_err(|_| "`$oid` must hold 12 bytes".to_string())?;
            Ok(Some(BsonValue::ObjectId(identifier)))
        }
        "$numberInt" => {
            let text = payload.as_str().ok_or_else(|| "`$numberInt` must be a string".to_string())?;
            let number: i32 = text.parse().map_err(|_| format!("invalid `$numberInt` value `{text}`"))?;
            Ok(Some(BsonValue::Int32(number)))
        }
        "$numberLong" => {
            let text = payload.as_str().ok_or_else(|| "`$numberLong` must be a string".to_string())?;
            let number: i64 = text.parse().map_err(|_| format!("invalid `$numberLong` value `{text}`"))?;
            Ok(Some(BsonValue::Int64(number)))
        }
        "$numberDouble" => {
            let text = payload.as_str().ok_or_else(|| "`$numberDouble` must be a string".to_string())?;
            let number: f64 = text.parse().map_err(|_| format!("invalid `$numberDouble` value `{text}`"))?;
            Ok(Some(BsonValue::Double(number)))
        }
        "$binary" => {
            let object = payload.as_object().ok_or_else(|| "`$binary` must be an object".to_string())?;
            let encoded =
                object.get("base64").and_then(Value::as_str).ok_or_else(|| "`$binary.base64` is required".to_string())?;
            Ok(Some(BsonValue::Binary(base64_decode(encoded)?)))
        }
        _ => Ok(None),
    }
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn hex_decode(text: &str) -> Result<Vec<u8>, String> {
    if text.len() % 2 != 0 {
        return Err("hex string must have an even length".to_string());
    }
    let mut bytes = Vec::with_capacity(text.len() / 2);
    let characters: Vec<char> = text.chars().collect();
    for pair in characters.chunks(2) {
        let byte =
            u8::from_str_radix(&format!("{}{}", pair[0], pair[1]), 16).map_err(|_| "hex string is not valid".to_string())?;
        bytes.push(byte);
    }
    Ok(bytes)
}

const BASE64_ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64_encode(bytes: &[u8]) -> String {
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let triple = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let value = (u32::from(triple[0]) << 16) | (u32::from(triple[1]) << 8) | u32::from(triple[2]);
        for position in 0..4 {
            if position <= chunk.len() {
                out.push(BASE64_ALPHABET[((value >> (18 - 6 * position)) & 0x3f) as usize] as char);
            }
            else {
                out.push('=');
            }
        }
    }
    out
}

fn base64_decode(text: &str) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    let mut buffer: u32 = 0;
    let mut bits = 0;
    for character in text.chars() {
        if character == '=' {
            break;
        }
        let index = BASE64_ALPHABET
            .iter()
            .position(|candidate| *candidate as char == character)
            .ok_or_else(|| "invalid base64".to_string())? as u32;
        buffer = (buffer << 6) | index;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            bytes.push(((buffer >> bits) & 0xff) as u8);
        }
    }
    Ok(bytes)
}
