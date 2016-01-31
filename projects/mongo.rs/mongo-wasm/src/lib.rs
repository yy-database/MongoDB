//! WASM codec exports.
//!
//! Storage is native-only: the wasm build carries the BSON / extended-JSON /
//! `OP_MSG` translation primitives so a browser host can shape replies itself.

use wasm_bindgen::prelude::*;

/// Decodes an `OP_MSG` body into extended JSON.
#[wasm_bindgen]
pub fn decode_op_msg(body: &[u8]) -> Result<String, JsValue> {
    mongo_core::codec::decode_op_msg_command(body)
        .map(|document| mongo_core::json::document_to_json(&document))
        .map_err(|message| JsValue::from_str(&message))
}

/// Encodes an extended-JSON command into an `OP_MSG` body.
#[wasm_bindgen]
pub fn encode_op_msg(command: &str) -> Result<Vec<u8>, JsValue> {
    let document = mongo_core::json::document_from_json(command).map_err(|message| JsValue::from_str(&message))?;
    Ok(mongo_core::codec::encode_op_msg_body(&document))
}

/// Encodes an extended-JSON document into BSON bytes.
#[wasm_bindgen]
pub fn encode_document(document: &str) -> Result<Vec<u8>, JsValue> {
    let decoded = mongo_core::json::document_from_json(document).map_err(|message| JsValue::from_str(&message))?;
    Ok(mongo_core::bson::encode_bson(&decoded))
}

/// Decodes BSON bytes into extended JSON.
#[wasm_bindgen]
pub fn decode_document(bytes: &[u8]) -> Result<String, JsValue> {
    mongo_core::bson::parse_bson(bytes)
        .map(|document| mongo_core::json::document_to_json(&document))
        .map_err(|error| JsValue::from_str(&format!("{error:?}")))
}

/// Decodes a legacy `OP_QUERY` body into extended JSON.
#[wasm_bindgen]
pub fn decode_op_query(body: &[u8]) -> Result<String, JsValue> {
    mongo_core::codec::decode_op_query_command(body)
        .map(|document| mongo_core::json::document_to_json(&document))
        .map_err(|message| JsValue::from_str(&message))
}
