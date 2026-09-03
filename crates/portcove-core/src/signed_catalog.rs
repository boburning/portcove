//! Versioned signed metadata. Trust never comes from the downloaded document.
use std::collections::BTreeMap;

use ed25519_dalek::{Signature, VerifyingKey};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{Catalog, CatalogDocument, PortcoveError, Result};

pub(crate) const MAX_CATALOG_BYTES: usize = 4 * 1024 * 1024;
pub(crate) const MAX_SEQUENCE: i64 = 9_007_199_254_740_991;
const SIGNING_DOMAIN: &[u8] = b"Portcove signed catalog v1\n";

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SignedCatalogEnvelope {
    pub format_version: u32,
    pub key_id: String,
    /// Exact UTF-8 bytes are signed; consumers must not reserialize before verification.
    pub payload: String,
    pub signature: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SignedCatalogPayload {
    pub sequence: i64,
    pub issued_at: i64,
    pub expires_at: i64,
    pub catalog: CatalogDocument,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct CatalogTrustKey {
    pub key_id: String,
    pub public_key: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CatalogOrigin {
    Embedded,
    SignedActive,
    SignedPrevious,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct CatalogProvenance {
    pub origin: CatalogOrigin,
    pub catalog_sha256: String,
    pub sequence: Option<i64>,
    pub key_id: Option<String>,
    pub expires_at: Option<i64>,
    pub fallback_reasons: Vec<String>,
}

pub(crate) struct VerifiedCatalog {
    pub catalog: Catalog,
    pub envelope: SignedCatalogEnvelope,
    pub payload: SignedCatalogPayload,
}

pub(crate) fn digest(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

impl CatalogTrustKey {
    pub fn from_public_key(public_key: &str) -> Result<Self> {
        let bytes = decode_hex::<32>(public_key)?;
        let key = VerifyingKey::from_bytes(&bytes)
            .map_err(|_| PortcoveError::verification("invalid Ed25519 public key"))?;
        if key.is_weak() {
            return Err(PortcoveError::verification("weak Ed25519 public key"));
        }
        Ok(CatalogTrustKey {
            key_id: digest(&bytes),
            public_key: hex::encode(bytes),
        })
    }
}

fn decode_hex<const N: usize>(value: &str) -> Result<[u8; N]> {
    let mut bytes = [0; N];
    hex::decode_to_slice(value, &mut bytes).map_err(|_| {
        PortcoveError::verification("invalid signed catalog key or signature encoding")
    })?;
    Ok(bytes)
}

pub(crate) fn signing_message(key_id: &str, payload: &str) -> Vec<u8> {
    [SIGNING_DOMAIN, key_id.as_bytes(), b"\n", payload.as_bytes()].concat()
}

pub(crate) fn verify(bytes: &[u8], keys: &[CatalogTrustKey], now: i64) -> Result<VerifiedCatalog> {
    if bytes.len() > MAX_CATALOG_BYTES {
        return Err(PortcoveError::verification(
            "signed catalog exceeds the 4 MiB limit",
        ));
    }
    let envelope: SignedCatalogEnvelope = serde_json::from_slice(bytes)
        .map_err(|_| PortcoveError::verification("invalid signed catalog envelope"))?;
    if envelope.format_version != 1 {
        return Err(PortcoveError::unsupported(
            "unsupported signed catalog format",
        ));
    }
    let trusted = keys
        .iter()
        .find(|key| key.key_id == envelope.key_id)
        .ok_or_else(|| PortcoveError::verification("catalog signing key is not trusted"))?;
    let checked = CatalogTrustKey::from_public_key(&trusted.public_key)?;
    if checked.key_id != envelope.key_id {
        return Err(PortcoveError::verification(
            "catalog key fingerprint mismatch",
        ));
    }
    let key = VerifyingKey::from_bytes(&decode_hex::<32>(&trusted.public_key)?)
        .map_err(|_| PortcoveError::verification("invalid catalog public key"))?;
    let signature = Signature::from_bytes(&decode_hex::<64>(&envelope.signature)?);
    key.verify_strict(
        &signing_message(&envelope.key_id, &envelope.payload),
        &signature,
    )
    .map_err(|_| PortcoveError::verification("catalog signature verification failed"))?;
    let payload: SignedCatalogPayload = serde_json::from_str(&envelope.payload)
        .map_err(|_| PortcoveError::verification("invalid signed catalog payload"))?;
    if !(1..=MAX_SEQUENCE).contains(&payload.sequence)
        || payload.issued_at < 0
        || payload.issued_at > now
        || payload.expires_at <= now
        || payload.expires_at <= payload.issued_at
        || payload.expires_at - payload.issued_at > 366 * 24 * 60 * 60
    {
        return Err(PortcoveError::verification(
            "catalog sequence or validity interval is invalid, future-dated, or expired",
        ));
    }
    let catalog = Catalog::from_json(&serde_json::to_string(&payload.catalog)?)?;
    validate_update_contract(&catalog, &Catalog::embedded()?)?;
    Ok(VerifiedCatalog {
        catalog,
        envelope,
        payload,
    })
}

/// Delivery v1 updates metadata, not installed-code safety contracts or V1 membership.
/// Comparing the remainder also freezes any future fields until deliberately admitted.
fn validate_update_contract(candidate: &Catalog, baseline: &Catalog) -> Result<()> {
    let profiles = |catalog: &Catalog| -> Result<BTreeMap<String, serde_json::Value>> {
        catalog
            .document()
            .source_profiles
            .iter()
            .map(|profile| Ok((profile.id.clone(), serde_json::to_value(profile)?)))
            .collect()
    };
    if profiles(candidate)? != profiles(baseline)?
        || candidate.ports().len() != baseline.ports().len()
    {
        return Err(PortcoveError::verification(
            "catalog updates cannot change source contracts or V1 membership",
        ));
    }
    for port in candidate.ports() {
        let original = baseline.port(&port.id)?;
        let mut contract = serde_json::to_value(port)?;
        let mut original_contract = serde_json::to_value(original)?;
        for field in [
            "name",
            "summary",
            "project_url",
            "support_tier",
            "channels",
            "platforms",
            "automated_tested_platforms",
            "manually_validated_platforms",
            "release",
            "upstream_status",
        ] {
            contract
                .as_object_mut()
                .expect("port is an object")
                .remove(field);
            original_contract
                .as_object_mut()
                .expect("port is an object")
                .remove(field);
        }
        if contract != original_contract {
            return Err(PortcoveError::verification(format!(
                "{} changes an installed-code source, execution, or persistent-data contract; update Portcove first",
                port.id
            )));
        }
    }
    Ok(())
}

pub(crate) fn provenance(
    catalog: &Catalog,
    origin: CatalogOrigin,
    verified: Option<&VerifiedCatalog>,
    reasons: Vec<String>,
) -> Result<CatalogProvenance> {
    Ok(CatalogProvenance {
        origin,
        catalog_sha256: digest(&serde_json::to_vec(catalog.document())?),
        sequence: verified.map(|value| value.payload.sequence),
        key_id: verified.map(|value| value.envelope.key_id.clone()),
        expires_at: verified.map(|value| value.payload.expires_at),
        fallback_reasons: reasons,
    })
}
