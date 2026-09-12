//! Strict payload-verification key registry for application updates.

use std::collections::BTreeSet;

use base64::Engine as _;
use minisign_verify::PublicKey;
use serde::Deserialize;
use sha2::{Digest, Sha256};

const REGISTRY_SCHEMA_VERSION: u32 = 1;
const MAX_REGISTRY_BYTES: usize = 64 * 1024;
const MAX_PAYLOAD_KEYS: usize = 16;
const MAX_TAURI_PUBLIC_KEY_BYTES: usize = 16 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum PayloadKeyError {
    #[error("authenticated payload-key registry is invalid: {0}")]
    InvalidRegistry(String),
    #[error("authenticated payload key is unavailable: {0}")]
    MissingKey(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PayloadVerificationKey {
    pub id: String,
    /// Base64 of the exact minisign public-key file bytes accepted by Tauri.
    pub tauri_public_key: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PayloadKeyRegistry {
    schema_version: u32,
    keys: Vec<PayloadKeyRecord>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PayloadKeyRecord {
    id: String,
    tauri_public_key: String,
}

fn lowercase_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn validate_tauri_public_key(encoded: &str, expected_id: &str) -> Result<(), PayloadKeyError> {
    if encoded.is_empty() || encoded.len() > MAX_TAURI_PUBLIC_KEY_BYTES * 2 {
        return Err(PayloadKeyError::InvalidRegistry(
            "Tauri public key encoding exceeds its limit".into(),
        ));
    }
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| PayloadKeyError::InvalidRegistry("Tauri public key is not base64".into()))?;
    if decoded.is_empty() || decoded.len() > MAX_TAURI_PUBLIC_KEY_BYTES {
        return Err(PayloadKeyError::InvalidRegistry(
            "decoded Tauri public key exceeds its limit".into(),
        ));
    }
    let text = std::str::from_utf8(&decoded).map_err(|_| {
        PayloadKeyError::InvalidRegistry("decoded Tauri public key is not UTF-8".into())
    })?;
    let mut lines = text.lines();
    let comment = lines.next().unwrap_or_default();
    let key = lines.next().unwrap_or_default();
    if !comment.starts_with("untrusted comment: ") || key.is_empty() || lines.next().is_some() {
        return Err(PayloadKeyError::InvalidRegistry(
            "decoded Tauri public key must contain one comment and one key line".into(),
        ));
    }
    PublicKey::decode(text)
        .map_err(|_| PayloadKeyError::InvalidRegistry("minisign public key is invalid".into()))?;
    if hex::encode(Sha256::digest(&decoded)) != expected_id {
        return Err(PayloadKeyError::InvalidRegistry(
            "payload key ID does not match the decoded public-key bytes".into(),
        ));
    }
    Ok(())
}

/// Selects an exact Tauri/minisign verification key from offline-authorized,
/// already authenticated registry bytes.
pub fn select_payload_verification_key(
    registry_bytes: &[u8],
    requested_id: &str,
) -> Result<PayloadVerificationKey, PayloadKeyError> {
    if registry_bytes.is_empty() || registry_bytes.len() > MAX_REGISTRY_BYTES {
        return Err(PayloadKeyError::InvalidRegistry(format!(
            "registry must be 1-{MAX_REGISTRY_BYTES} bytes"
        )));
    }
    if !lowercase_sha256(requested_id) {
        return Err(PayloadKeyError::InvalidRegistry(
            "requested payload key ID is not lowercase SHA-256".into(),
        ));
    }
    let registry: PayloadKeyRegistry = serde_json::from_slice(registry_bytes)
        .map_err(|error| PayloadKeyError::InvalidRegistry(error.to_string()))?;
    if registry.schema_version != REGISTRY_SCHEMA_VERSION {
        return Err(PayloadKeyError::InvalidRegistry(
            "unsupported registry schema".into(),
        ));
    }
    if registry.keys.len() > MAX_PAYLOAD_KEYS {
        return Err(PayloadKeyError::InvalidRegistry(format!(
            "registry contains more than {MAX_PAYLOAD_KEYS} keys"
        )));
    }

    let mut seen = BTreeSet::new();
    let mut selected = None;
    for record in registry.keys {
        if !lowercase_sha256(&record.id) {
            return Err(PayloadKeyError::InvalidRegistry(
                "payload key ID is not lowercase SHA-256".into(),
            ));
        }
        if !seen.insert(record.id.clone()) {
            return Err(PayloadKeyError::InvalidRegistry(format!(
                "payload key ID is repeated: {}",
                record.id
            )));
        }
        validate_tauri_public_key(&record.tauri_public_key, &record.id)?;
        if record.id == requested_id {
            selected = Some(PayloadVerificationKey {
                id: record.id,
                tauri_public_key: record.tauri_public_key,
            });
        }
    }
    selected.ok_or_else(|| PayloadKeyError::MissingKey(requested_id.into()))
}

#[cfg(test)]
mod tests {
    use base64::Engine as _;
    use serde_json::json;

    use super::*;

    const PUBLIC_KEY: &str = "untrusted comment: minisign public key E7620F1842B4E81F\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3\n";

    fn encoded_key() -> String {
        base64::engine::general_purpose::STANDARD.encode(PUBLIC_KEY.as_bytes())
    }

    fn key_id() -> String {
        hex::encode(Sha256::digest(PUBLIC_KEY.as_bytes()))
    }

    #[test]
    fn selects_exact_well_formed_tauri_key() {
        let id = key_id();
        let bytes = serde_json::to_vec(&json!({
            "schema_version": 1,
            "keys": [{ "id": id, "tauri_public_key": encoded_key() }]
        }))
        .unwrap();
        let selected = select_payload_verification_key(&bytes, &key_id()).unwrap();
        assert_eq!(selected.id, key_id());
        assert_eq!(selected.tauri_public_key, encoded_key());
    }

    #[test]
    fn rejects_identity_mismatch_duplicates_and_unknown_fields() {
        let mismatch = serde_json::to_vec(&json!({
            "schema_version": 1,
            "keys": [{ "id": "d".repeat(64), "tauri_public_key": encoded_key() }]
        }))
        .unwrap();
        assert!(matches!(
            select_payload_verification_key(&mismatch, &"d".repeat(64)),
            Err(PayloadKeyError::InvalidRegistry(message))
                if message.contains("does not match")
        ));

        let id = key_id();
        let duplicate = serde_json::to_vec(&json!({
            "schema_version": 1,
            "keys": [
                { "id": id, "tauri_public_key": encoded_key() },
                { "id": id, "tauri_public_key": encoded_key() }
            ]
        }))
        .unwrap();
        assert!(matches!(
            select_payload_verification_key(&duplicate, &key_id()),
            Err(PayloadKeyError::InvalidRegistry(message)) if message.contains("repeated")
        ));

        let unknown = serde_json::to_vec(&json!({
            "schema_version": 1,
            "keys": [],
            "fallback_key": encoded_key()
        }))
        .unwrap();
        assert!(matches!(
            select_payload_verification_key(&unknown, &key_id()),
            Err(PayloadKeyError::InvalidRegistry(_))
        ));
    }

    #[test]
    fn missing_or_malformed_key_fails_closed() {
        let empty = br#"{"schema_version":1,"keys":[]}"#;
        assert!(matches!(
            select_payload_verification_key(empty, &key_id()),
            Err(PayloadKeyError::MissingKey(_))
        ));

        let id = key_id();
        let malformed = serde_json::to_vec(&json!({
            "schema_version": 1,
            "keys": [{ "id": id, "tauri_public_key": "not base64" }]
        }))
        .unwrap();
        assert!(matches!(
            select_payload_verification_key(&malformed, &key_id()),
            Err(PayloadKeyError::InvalidRegistry(message)) if message.contains("not base64")
        ));
    }
}
