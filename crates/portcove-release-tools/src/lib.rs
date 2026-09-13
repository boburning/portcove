//! Offline application artifact verification and update-metadata signing.
//! This crate has no catalog, game, installation, credential-provisioning or publication authority.

pub mod tuf_repository;

use std::fs::{self, File};
use std::io::Read;
use std::path::Path;

use base64::{Engine, engine::general_purpose::STANDARD};
use minisign_verify::{PublicKey, Signature};
use serde::Serialize;
use sha2::{Digest, Sha256};

const MAX_PAYLOAD_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_SIGNATURE_BYTES: u64 = 16 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum VerificationError {
    #[error("artifact verification I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("signature or public-key encoding is invalid")]
    Encoding,
    #[error("updater signature verification failed: {0}")]
    Signature(#[from] minisign_verify::Error),
    #[error("expected a regular, non-linked file")]
    UnsafeFile,
    #[error("artifact or metadata exceeds its verification limit")]
    TooLarge,
    #[error("expected artifact identity is invalid")]
    InvalidIdentity,
    #[error("artifact byte length does not match its expected identity")]
    LengthMismatch,
    #[error("artifact SHA-256 does not match its expected identity")]
    HashMismatch,
}

#[derive(Debug, Serialize)]
pub struct VerifiedArtifact {
    pub schema_version: u32,
    pub bytes: u64,
    pub sha256: String,
    pub public_key_sha256: String,
    pub signature_verified: bool,
}

fn regular_file(path: &Path) -> Result<File, VerificationError> {
    if !fs::symlink_metadata(path)?.file_type().is_file() {
        return Err(VerificationError::UnsafeFile);
    }
    let file = File::open(path)?;
    if !file.metadata()?.is_file() {
        return Err(VerificationError::UnsafeFile);
    }
    Ok(file)
}

fn decode_metadata(path: &Path) -> Result<String, VerificationError> {
    let mut bytes = Vec::new();
    regular_file(path)?
        .take(MAX_SIGNATURE_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_SIGNATURE_BYTES {
        return Err(VerificationError::TooLarge);
    }
    let encoded = std::str::from_utf8(&bytes).map_err(|_| VerificationError::Encoding)?;
    let decoded = STANDARD
        .decode(encoded.trim())
        .map_err(|_| VerificationError::Encoding)?;
    String::from_utf8(decoded).map_err(|_| VerificationError::Encoding)
}

/// Decode and validate Tauri's base64-wrapped Minisign public-key file.
pub fn decode_tauri_public_key(path: &Path) -> Result<String, VerificationError> {
    let decoded = decode_metadata(path)?;
    PublicKey::decode(&decoded)?;
    Ok(decoded)
}

/// Verify Tauri's base64-wrapped Minisign format and the independently supplied
/// expected hash/size over one bounded stream. No payload is executed or modified.
pub fn verify_artifact(
    artifact: &Path,
    signature: &Path,
    public_key: &Path,
    expected_sha256: &str,
    expected_bytes: u64,
) -> Result<VerifiedArtifact, VerificationError> {
    if expected_bytes == 0
        || expected_bytes > MAX_PAYLOAD_BYTES
        || expected_sha256.len() != 64
        || !expected_sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(VerificationError::InvalidIdentity);
    }
    let public_key = decode_tauri_public_key(public_key)?;
    let public_key_sha256 = hex::encode(Sha256::digest(public_key.as_bytes()));
    let key = PublicKey::decode(&public_key)?;
    let signature = Signature::decode(&decode_metadata(signature)?)?;
    // New Tauri signatures are prehashed. Refuse legacy non-streaming signatures
    // instead of allocating an artifact-sized buffer or weakening verification.
    let mut verifier = key.verify_stream(&signature)?;
    let mut file = regular_file(artifact)?;
    if file.metadata()?.len() != expected_bytes {
        return Err(VerificationError::LengthMismatch);
    }
    let mut hash = Sha256::new();
    let mut bytes = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        bytes += count as u64;
        if bytes > expected_bytes {
            return Err(VerificationError::LengthMismatch);
        }
        verifier.update(&buffer[..count]);
        hash.update(&buffer[..count]);
    }
    if bytes != expected_bytes {
        return Err(VerificationError::LengthMismatch);
    }
    let sha256 = hex::encode(hash.finalize());
    if !sha256.eq_ignore_ascii_case(expected_sha256) {
        return Err(VerificationError::HashMismatch);
    }
    verifier.finalize()?;
    Ok(VerifiedArtifact {
        schema_version: 1,
        bytes,
        sha256,
        public_key_sha256,
        signature_verified: true,
    })
}
