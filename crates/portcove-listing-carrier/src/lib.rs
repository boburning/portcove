//! Inert shared transport for the signed descriptive directory.
//! This crate does not authenticate a repository or grant any behavior.
use std::io::Read as _;

use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::Deserialize;
use sha2::{Digest, Sha256};

pub const LEGACY_TARGET: &str = "policy/official/catalog.listings.json";
pub const MAX_BYTES: usize = 8 * 1024 * 1024;
pub const COMPACT_TARGET: &str = "policy/official/catalog.listings.compact.json";
pub const COMPACT_CARRIER: &str = "gzip-base64-json-v1";
pub fn is_listing_target(name: &str) -> bool {
    matches!(name, LEGACY_TARGET | COMPACT_TARGET)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CompactListingCarrier {
    carrier: String,
    decoded_bytes: usize,
    decoded_sha256: String,
    gzip_base64: String,
}

#[derive(Debug, thiserror::Error)]
#[error("invalid compact listing directory carrier")]
pub struct InvalidCarrier;

/// Decode one bounded gzip stream and check the identity declared in its carrier.
/// Callers independently verify the enclosing signed transport before use.
pub fn decode(bytes: &[u8]) -> Result<(Vec<u8>, String), InvalidCarrier> {
    if bytes.len() > MAX_BYTES {
        return Err(InvalidCarrier);
    }
    let carrier: CompactListingCarrier =
        serde_json::from_slice(bytes).map_err(|_| InvalidCarrier)?;
    if carrier.carrier != COMPACT_CARRIER || !(1..=MAX_BYTES).contains(&carrier.decoded_bytes) {
        return Err(InvalidCarrier);
    }
    let compressed = STANDARD
        .decode(carrier.gzip_base64)
        .map_err(|_| InvalidCarrier)?;
    let mut gzip = flate2::bufread::GzDecoder::new(compressed.as_slice());
    let mut output = Vec::with_capacity(carrier.decoded_bytes);
    gzip.by_ref()
        .take(carrier.decoded_bytes as u64 + 1)
        .read_to_end(&mut output)
        .map_err(|_| InvalidCarrier)?;
    if output.len() != carrier.decoded_bytes
        || !gzip.get_ref().is_empty()
        || hex::encode(Sha256::digest(&output)) != carrier.decoded_sha256
    {
        return Err(InvalidCarrier);
    }
    Ok((output, carrier.decoded_sha256))
}
