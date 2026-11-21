//! Inert shared transport for the signed descriptive directory.
//! This crate does not authenticate a repository or grant any behavior.
use std::io::Read as _;

use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::Deserialize;
use sha2::{Digest, Sha256};

mod cover_checkpoint;
pub use cover_checkpoint::{
    COVER_CHECKPOINT_MAX, COVER_CHECKPOINT_TARGET, check_cover_checkpoint,
    check_cover_checkpoint_successor,
};

pub const LEGACY_TARGET: &str = "policy/official/catalog.listings.json";
pub const MAX_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_COMPACT_DECODED_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_LISTING_ENTRIES: usize = 10_000;
pub const MAX_COMPACT_RECORD_BYTES: usize = 1024 * 1024;
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
    if carrier.carrier != COMPACT_CARRIER
        || !(1..=MAX_COMPACT_DECODED_BYTES).contains(&carrier.decoded_bytes)
    {
        return Err(InvalidCarrier);
    }
    let compressed = STANDARD
        .decode(carrier.gzip_base64)
        .map_err(|_| InvalidCarrier)?;
    let mut gzip = flate2::bufread::GzDecoder::new(compressed.as_slice());
    let mut output = Vec::with_capacity(carrier.decoded_bytes);
    gzip.by_ref()
        .take(carrier.decoded_bytes as u64)
        .read_to_end(&mut output)
        .map_err(|_| InvalidCarrier)?;
    let mut extra = [0];
    if output.len() != carrier.decoded_bytes
        || gzip.read(&mut extra).map_err(|_| InvalidCarrier)? != 0
        || !gzip.get_ref().is_empty()
        || hex::encode(Sha256::digest(&output)) != carrier.decoded_sha256
    {
        return Err(InvalidCarrier);
    }
    Ok((output, carrier.decoded_sha256))
}

pub fn bounded_entries<'de, D, T>(deserializer: D) -> std::result::Result<Vec<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    struct Entries<T>(std::marker::PhantomData<T>);

    impl<'de, T: Deserialize<'de>> serde::de::Visitor<'de> for Entries<T> {
        type Value = Vec<T>;

        fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(f, "at most {MAX_LISTING_ENTRIES} listing directory entries")
        }

        fn visit_seq<A: serde::de::SeqAccess<'de>>(
            self,
            mut seq: A,
        ) -> std::result::Result<Vec<T>, A::Error> {
            let mut entries = Vec::new();
            while entries.len() < MAX_LISTING_ENTRIES {
                let Some(value) = seq.next_element()? else {
                    return Ok(entries);
                };
                entries.push(value);
            }
            if seq.next_element::<serde::de::IgnoredAny>()?.is_some() {
                return Err(serde::de::Error::custom(
                    "compact listing directory exceeds its entry bound",
                ));
            }
            Ok(entries)
        }
    }

    deserializer.deserialize_seq(Entries(std::marker::PhantomData))
}
