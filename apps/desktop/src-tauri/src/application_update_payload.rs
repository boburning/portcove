//! Strict payload-verification key registry and streaming verifier for application updates.

use std::collections::BTreeSet;

use base64::Engine as _;
use minisign_verify::{PublicKey, Signature};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::application_update::ArtifactIdentity;

const REGISTRY_SCHEMA_VERSION: u32 = 1;
const MAX_REGISTRY_BYTES: usize = 64 * 1024;
const MAX_PAYLOAD_KEYS: usize = 16;
const MAX_TAURI_PUBLIC_KEY_BYTES: usize = 16 * 1024;
const MAX_TAURI_SIGNATURE_BYTES: usize = 16 * 1024;
const MAX_PAYLOAD_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const PAYLOAD_READ_BUFFER_BYTES: usize = 64 * 1024;

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

#[derive(Debug, thiserror::Error)]
pub enum PayloadVerificationError {
    #[error("payload verification identity is invalid: {0}")]
    InvalidIdentity(String),
    #[error("payload verification material is invalid: {0}")]
    InvalidVerificationMaterial(String),
    #[error("payload read failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("payload exceeds its authenticated length or the host size limit")]
    TooLarge,
    #[error("payload length mismatch: expected {expected} bytes, received {actual}")]
    LengthMismatch { expected: u64, actual: u64 },
    #[error("payload SHA-256 does not match authenticated metadata")]
    HashMismatch,
    #[error("payload Minisign signature verification failed")]
    SignatureMismatch,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedPayloadIdentity {
    pub bytes: u64,
    pub sha256: String,
    pub payload_key_id: String,
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

fn decode_tauri_public_key(encoded: &str) -> Result<(Vec<u8>, PublicKey), String> {
    if encoded.is_empty() || encoded.len() > MAX_TAURI_PUBLIC_KEY_BYTES * 2 {
        return Err("Tauri public key encoding exceeds its limit".into());
    }
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| "Tauri public key is not base64")?;
    if decoded.is_empty() || decoded.len() > MAX_TAURI_PUBLIC_KEY_BYTES {
        return Err("decoded Tauri public key exceeds its limit".into());
    }
    let text =
        std::str::from_utf8(&decoded).map_err(|_| "decoded Tauri public key is not UTF-8")?;
    let mut lines = text.lines();
    let comment = lines.next().unwrap_or_default();
    let key = lines.next().unwrap_or_default();
    if !comment.starts_with("untrusted comment: ") || key.is_empty() || lines.next().is_some() {
        return Err("decoded Tauri public key must contain one comment and one key line".into());
    }
    let public_key =
        PublicKey::decode(text).map_err(|_| "minisign public key is invalid".to_string())?;
    Ok((decoded, public_key))
}

fn validate_tauri_public_key(encoded: &str, expected_id: &str) -> Result<(), PayloadKeyError> {
    let (decoded, _) =
        decode_tauri_public_key(encoded).map_err(PayloadKeyError::InvalidRegistry)?;
    if hex::encode(Sha256::digest(&decoded)) != expected_id {
        return Err(PayloadKeyError::InvalidRegistry(
            "payload key ID does not match the decoded public-key bytes".into(),
        ));
    }
    Ok(())
}

fn decode_tauri_signature(encoded: &str) -> Result<Signature, PayloadVerificationError> {
    if encoded.is_empty() || encoded.len() > MAX_TAURI_SIGNATURE_BYTES * 2 {
        return Err(PayloadVerificationError::InvalidVerificationMaterial(
            "Tauri signature encoding exceeds its limit".into(),
        ));
    }
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| {
            PayloadVerificationError::InvalidVerificationMaterial(
                "Tauri signature is not base64".into(),
            )
        })?;
    if decoded.is_empty() || decoded.len() > MAX_TAURI_SIGNATURE_BYTES {
        return Err(PayloadVerificationError::InvalidVerificationMaterial(
            "decoded Tauri signature exceeds its limit".into(),
        ));
    }
    let text = std::str::from_utf8(&decoded).map_err(|_| {
        PayloadVerificationError::InvalidVerificationMaterial(
            "decoded Tauri signature is not UTF-8".into(),
        )
    })?;
    let lines = text.lines().collect::<Vec<_>>();
    if lines.len() != 4
        || !lines[0].starts_with("untrusted comment: ")
        || !lines[2].starts_with("trusted comment: ")
    {
        return Err(PayloadVerificationError::InvalidVerificationMaterial(
            "decoded Tauri signature must contain exactly four Minisign lines".into(),
        ));
    }
    Signature::decode(text).map_err(|_| {
        PayloadVerificationError::InvalidVerificationMaterial(
            "minisign signature is invalid".into(),
        )
    })
}

/// Streams an already obtained payload through the authenticated size, SHA-256
/// and Tauri/Minisign checks. A successful result is the only input suitable
/// for a later staging or replacement boundary.
pub async fn verify_payload<R: AsyncRead + Unpin>(
    reader: &mut R,
    artifact: &ArtifactIdentity,
    key: &PayloadVerificationKey,
) -> Result<VerifiedPayloadIdentity, PayloadVerificationError> {
    verify_payload_to_writer(reader, &mut tokio::io::sink(), artifact, key).await
}

/// Verifies and copies the same payload stream into a caller-owned private
/// destination. The caller must discard the destination unless this returns
/// successfully.
pub(crate) async fn verify_payload_to_writer<R: AsyncRead + Unpin, W: AsyncWrite + Unpin>(
    reader: &mut R,
    writer: &mut W,
    artifact: &ArtifactIdentity,
    key: &PayloadVerificationKey,
) -> Result<VerifiedPayloadIdentity, PayloadVerificationError> {
    if artifact.bytes == 0 || artifact.bytes > MAX_PAYLOAD_BYTES {
        return Err(PayloadVerificationError::InvalidIdentity(
            "authenticated payload size is outside the host limit".into(),
        ));
    }
    if !lowercase_sha256(&artifact.sha256) {
        return Err(PayloadVerificationError::InvalidIdentity(
            "authenticated payload SHA-256 is invalid".into(),
        ));
    }
    if !lowercase_sha256(&artifact.payload_key_id) || artifact.payload_key_id != key.id {
        return Err(PayloadVerificationError::InvalidIdentity(
            "authenticated payload key ID does not match the selected key".into(),
        ));
    }

    let (decoded_key, public_key) = decode_tauri_public_key(&key.tauri_public_key)
        .map_err(PayloadVerificationError::InvalidVerificationMaterial)?;
    if hex::encode(Sha256::digest(&decoded_key)) != key.id {
        return Err(PayloadVerificationError::InvalidVerificationMaterial(
            "selected payload key ID does not match its exact public-key bytes".into(),
        ));
    }
    let signature = decode_tauri_signature(&artifact.tauri_signature)?;
    let mut signature_verifier = public_key.verify_stream(&signature).map_err(|_| {
        PayloadVerificationError::InvalidVerificationMaterial(
            "signature does not use the selected key or streaming format".into(),
        )
    })?;

    let mut sha256 = Sha256::new();
    let mut received = 0_u64;
    let mut buffer = vec![0_u8; PAYLOAD_READ_BUFFER_BYTES];
    loop {
        let count = reader.read(&mut buffer).await?;
        if count == 0 {
            break;
        }
        received = received
            .checked_add(count as u64)
            .ok_or(PayloadVerificationError::TooLarge)?;
        if received > artifact.bytes || received > MAX_PAYLOAD_BYTES {
            return Err(PayloadVerificationError::TooLarge);
        }
        sha256.update(&buffer[..count]);
        signature_verifier.update(&buffer[..count]);
        writer.write_all(&buffer[..count]).await?;
    }
    if received != artifact.bytes {
        return Err(PayloadVerificationError::LengthMismatch {
            expected: artifact.bytes,
            actual: received,
        });
    }
    let actual_sha256 = hex::encode(sha256.finalize());
    if actual_sha256 != artifact.sha256 {
        return Err(PayloadVerificationError::HashMismatch);
    }
    signature_verifier
        .finalize()
        .map_err(|_| PayloadVerificationError::SignatureMismatch)?;

    Ok(VerifiedPayloadIdentity {
        bytes: received,
        sha256: actual_sha256,
        payload_key_id: key.id.clone(),
    })
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
    use serde_json::json;

    use super::*;

    const PUBLIC_KEY: &str = "untrusted comment: minisign public key E7620F1842B4E81F\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3\n";
    const PREHASHED_SIGNATURE: &str = "untrusted comment: signature from minisign secret key\nRUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\ntrusted comment: timestamp:1556193335\tfile:test\ny/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==\n";
    const LEGACY_SIGNATURE: &str = "untrusted comment: signature from minisign secret key\nRWQf6LRCGA9i59SLOFxz6NxvASXDJeRtuZykwQepbDEGt87ig1BNpWaVWuNrm73YiIiJbq71Wi+dP9eKL8OC351vwIasSSbXxwA=\ntrusted comment: timestamp:1555779966\tfile:test\nQtKMXWyYcwdpZAlPF7tE2ENJkRd1ujvKjlj1m9RtHTBnZPa5WKU5uWRs5GoP5M/VqE81QFuMKI5k/SfNQUaOAA==\n";

    fn encoded_key() -> String {
        base64::engine::general_purpose::STANDARD.encode(PUBLIC_KEY.as_bytes())
    }

    fn key_id() -> String {
        hex::encode(Sha256::digest(PUBLIC_KEY.as_bytes()))
    }

    fn payload_key() -> PayloadVerificationKey {
        PayloadVerificationKey {
            id: key_id(),
            tauri_public_key: encoded_key(),
        }
    }

    fn artifact(payload: &[u8]) -> ArtifactIdentity {
        ArtifactIdentity {
            url: "https://github.com/boburning/portcove/releases/download/v1.0.0/Portcove.exe"
                .into(),
            sha256: hex::encode(Sha256::digest(payload)),
            bytes: payload.len() as u64,
            tauri_signature: base64::engine::general_purpose::STANDARD
                .encode(PREHASHED_SIGNATURE.as_bytes()),
            payload_key_id: key_id(),
        }
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

    #[tokio::test]
    async fn verifies_payload_identity_and_streaming_signature_together() {
        let mut payload = &b"test"[..];
        let verified = verify_payload(&mut payload, &artifact(b"test"), &payload_key())
            .await
            .unwrap();

        assert_eq!(verified.bytes, 4);
        assert_eq!(verified.sha256, hex::encode(Sha256::digest(b"test")));
        assert_eq!(verified.payload_key_id, key_id());
    }

    #[tokio::test]
    async fn rejects_tampered_payload_even_when_its_hash_is_substituted() {
        let tampered = b"tast";
        let mut identity = artifact(tampered);
        let mut payload = &tampered[..];

        assert!(matches!(
            verify_payload(&mut payload, &identity, &payload_key()).await,
            Err(PayloadVerificationError::SignatureMismatch)
        ));

        identity = artifact(b"test");
        let mut payload = &tampered[..];
        assert!(matches!(
            verify_payload(&mut payload, &identity, &payload_key()).await,
            Err(PayloadVerificationError::HashMismatch)
        ));
    }

    #[tokio::test]
    async fn rejects_short_and_overlong_payload_streams() {
        let identity = artifact(b"test");
        let mut short = &b"tes"[..];
        assert!(matches!(
            verify_payload(&mut short, &identity, &payload_key()).await,
            Err(PayloadVerificationError::LengthMismatch {
                expected: 4,
                actual: 3
            })
        ));

        let mut long = &b"tests"[..];
        assert!(matches!(
            verify_payload(&mut long, &identity, &payload_key()).await,
            Err(PayloadVerificationError::TooLarge)
        ));
    }

    #[tokio::test]
    async fn rejects_wrong_key_identity_and_non_streaming_material() {
        let mut identity = artifact(b"test");
        identity.payload_key_id = "d".repeat(64);
        let mut payload = &b"test"[..];
        assert!(matches!(
            verify_payload(&mut payload, &identity, &payload_key()).await,
            Err(PayloadVerificationError::InvalidIdentity(message))
                if message.contains("does not match")
        ));

        let mut identity = artifact(b"test");
        identity.tauri_signature =
            base64::engine::general_purpose::STANDARD.encode(LEGACY_SIGNATURE.as_bytes());
        let mut payload = &b"test"[..];
        assert!(matches!(
            verify_payload(&mut payload, &identity, &payload_key()).await,
            Err(PayloadVerificationError::InvalidVerificationMaterial(message))
                if message.contains("streaming format")
        ));
    }
}
