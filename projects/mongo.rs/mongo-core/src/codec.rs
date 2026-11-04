//! Command encoding: `OP_MSG` / `OP_QUERY` bodies to and from BSON documents.
//!
//! These functions only translate bytes. Dispatch belongs to the host, so each
//! command primitive can be called on its own.

use crate::bson::{BsonDocument, BsonValue, encode_bson, parse_bson};

/// `OP_MSG` flag bit 0: the frame ends with a CRC-32C checksum.
const OP_MSG_CHECKSUM_PRESENT: u32 = 0x0000_0001;

/// Decodes an [`OP_MSG`](crate::wire::OP_MSG) body into its command document.
///
/// Document-sequence sections (`0x01`) are folded back into the command as the
/// array named by their identifier, which is how real drivers send
/// `insert.documents` and `delete.deletes`.
pub fn decode_op_msg_command(op_msg_body: &[u8]) -> Result<BsonDocument, String> {
    let flags = op_msg_body
        .get(..4)
        .and_then(|head| <[u8; 4]>::try_from(head).ok())
        .map(u32::from_le_bytes)
        .ok_or_else(|| "OP_MSG body too short".to_string())?;

    let mut sections = op_msg_body.get(4..).ok_or_else(|| "OP_MSG body too short".to_string())?;
    if flags & OP_MSG_CHECKSUM_PRESENT != 0 {
        sections = sections
            .len()
            .checked_sub(4)
            .and_then(|end| sections.get(..end))
            .ok_or_else(|| "OP_MSG checksum section truncated".to_string())?;
    }

    let mut body: Option<BsonDocument> = None;
    let mut sequences: Vec<(String, Vec<BsonValue>)> = Vec::new();

    while let Some((kind, rest)) = sections.split_first() {
        match kind {
            0x00 => {
                let document = parse_bson(rest).map_err(|error| format!("BSON parse error: {error:?}"))?;
                let length = bson_document_length(rest)?;
                sections = rest.get(length..).ok_or_else(|| "OP_MSG body section truncated".to_string())?;
                if body.replace(document).is_some() {
                    return Err("OP_MSG carries more than one body section".to_string());
                }
            }
            0x01 => {
                let size =
                    rest.get(..4)
                        .and_then(|head| <[u8; 4]>::try_from(head).ok())
                        .map(|head| i32::from_le_bytes(head))
                        .filter(|size| *size > 4)
                        .ok_or_else(|| "document sequence section missing its size".to_string())? as usize;
                let section = rest.get(..size).ok_or_else(|| "document sequence section truncated".to_string())?;
                let header = &section[4..];
                let name_end = header
                    .iter()
                    .position(|byte| *byte == 0)
                    .ok_or_else(|| "document sequence identifier has no terminator".to_string())?;
                let identifier = std::str::from_utf8(&header[..name_end])
                    .map_err(|_| "document sequence identifier is not UTF-8".to_string())?
                    .to_string();
                let mut documents = &header[name_end + 1..];
                let mut values = Vec::new();
                while !documents.is_empty() {
                    let length = bson_document_length(documents)?;
                    let document = parse_bson(documents).map_err(|error| format!("BSON parse error: {error:?}"))?;
                    values.push(BsonValue::Document(document));
                    documents = &documents[length..];
                }
                sequences.push((identifier, values));
                sections = &rest[size..];
            }
            other => return Err(format!("unsupported OP_MSG section kind {other}")),
        }
    }

    let mut command = body.ok_or_else(|| "OP_MSG carries no body section".to_string())?;
    for (identifier, values) in sequences {
        if command.get(&identifier).is_none() {
            command.push(identifier, BsonValue::Array(values));
        }
    }
    Ok(command)
}

/// Encodes one command document into an `OP_MSG` body (flags `0`, one body
/// section). Hosts append the checksum themselves when they ask for one.
pub fn encode_op_msg_body(command: &BsonDocument) -> Vec<u8> {
    let mut body = vec![0_u8; 4];
    body.push(0x00);
    body.extend_from_slice(&encode_bson(command));
    body
}

/// Decodes a legacy `OP_QUERY` body into its command document.
///
/// Layout: flags (u32), full collection name (cstring), skip (i32), number to
/// return (i32), then the query document (optionally under `$query`).
pub fn decode_op_query_command(op_query_body: &[u8]) -> Result<BsonDocument, String> {
    let rest = op_query_body.get(4..).ok_or_else(|| "OP_QUERY body too short".to_string())?;
    let name_end = rest.iter().position(|byte| *byte == 0).ok_or_else(|| "OP_QUERY namespace has no terminator".to_string())?;
    let query = rest.get(name_end + 1 + 8..).ok_or_else(|| "OP_QUERY carries no query document".to_string())?;
    let mut document = parse_bson(query).map_err(|error| format!("BSON parse error: {error:?}"))?;
    if let Some(BsonValue::Document(inner)) = document.get("$query").cloned() {
        document = inner;
    }
    Ok(document)
}

/// Encodes the document bytes a legacy `OP_REPLY` carries (`numberReturned: 1`).
///
/// The host writes the 16-byte header and the 20-byte reply prefix itself.
pub fn encode_op_reply_document(document: &BsonDocument) -> Vec<u8> {
    encode_bson(document)
}

/// Name of the command: the first field of a command document.
pub fn command_name(command: &BsonDocument) -> Option<&str> {
    command.command_name()
}

fn bson_document_length(bytes: &[u8]) -> Result<usize, String> {
    let length = bytes
        .get(..4)
        .and_then(|head| <[u8; 4]>::try_from(head).ok())
        .map(|head| i32::from_le_bytes(head))
        .filter(|length| *length >= 5)
        .ok_or_else(|| "BSON document length missing".to_string())? as usize;
    if length > bytes.len() {
        return Err("BSON document length exceeds the section".to_string());
    }
    Ok(length)
}
