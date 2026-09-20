//! Host-local proof that a retained definition was admitted before portability.
//!
//! The retained manifest preserves exact semantics, but its serialized admission identity is not
//! independently authoritative. This receipt binds those semantics to an operating-system secure
//! secret. It deliberately does not invent cross-device trust.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{Catalog, LibraryMetadata, PortcoveError, Result};

#[cfg(not(test))]
const CREDENTIAL_SERVICE: &str = "io.github.portcove.Portcove";
#[cfg(not(test))]
const CREDENTIAL_USER: &str = "portability-authority-v1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PortabilityAuthority {
    format: u32,
    entries: Vec<PortabilityAdmission>,
    mac_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct PortabilityAdmission {
    install_id: String,
    port_id: String,
    manifest_sha256: String,
    selection_sha256: String,
    role: String,
}

impl PortabilityAdmission {
    pub(crate) fn from_catalog(
        install: &crate::InstallRecord,
        catalog: &Catalog,
        role: &str,
    ) -> Result<Option<Self>> {
        let Some(selection) = catalog.definition_selection(&install.port_id) else {
            return Ok(None);
        };
        Ok(Some(Self {
            install_id: install.id.clone(),
            port_id: install.port_id.clone(),
            manifest_sha256: install.manifest_sha256.clone(),
            selection_sha256: hex::encode(Sha256::digest(serde_json::to_vec(selection)?)),
            role: role.into(),
        }))
    }
}

impl PortabilityAuthority {
    pub(crate) fn claimed_role(&self, install_id: &str) -> Option<&str> {
        self.entries
            .iter()
            .find(|entry| entry.install_id == install_id)
            .map(|entry| entry.role.as_str())
    }
}

pub(crate) fn seal(
    metadata: &mut LibraryMetadata,
    entries: Vec<PortabilityAdmission>,
) -> Result<()> {
    if entries.is_empty() {
        metadata.portability_authority = None;
        metadata.schema_version = 3;
        return Ok(());
    }
    let entries = canonical_entries(entries)?;
    let key = load_or_create_key()?;
    metadata.schema_version = 4;
    metadata.portability_authority = Some(PortabilityAuthority {
        format: 1,
        mac_sha256: hmac_sha256(&key, &serde_json::to_vec(&entries)?),
        entries,
    });
    Ok(())
}

pub(crate) fn verify(metadata: &LibraryMetadata, entries: Vec<PortabilityAdmission>) -> Result<()> {
    let entries = canonical_entries(entries)?;
    match (&metadata.portability_authority, entries.is_empty()) {
        (None, true) if metadata.schema_version <= 3 => return Ok(()),
        (Some(authority), false) if metadata.schema_version == 4 => {
            if authority.format != 1 || authority.entries != entries {
                return Err(PortcoveError::verification(
                    "portability authority does not match the retained installations",
                ));
            }
            let key = load_key()?.ok_or_else(|| {
                PortcoveError::verification(
                    "this host did not admit the retained successor definition",
                )
            })?;
            let expected = hmac_sha256(&key, &serde_json::to_vec(&entries)?);
            if !constant_time_eq(expected.as_bytes(), authority.mac_sha256.as_bytes()) {
                return Err(PortcoveError::verification(
                    "portability authority is not valid on this host",
                ));
            }
            return Ok(());
        }
        _ => {}
    }
    Err(PortcoveError::verification(
        "retained definition admission has no matching portability authority",
    ))
}

pub(crate) fn seal_import_publication(transfer_id: &str, plan_sha256: &str) -> Result<String> {
    let key = load_or_create_key()?;
    Ok(hmac_sha256(
        &key,
        format!("import-publication-v1\0{transfer_id}\0{plan_sha256}").as_bytes(),
    ))
}

pub(crate) fn verify_import_publication(
    transfer_id: &str,
    plan_sha256: &str,
    proof: &str,
) -> Result<()> {
    let key = load_key()?.ok_or_else(|| {
        PortcoveError::verification("this host did not verify the imported library")
    })?;
    let expected = hmac_sha256(
        &key,
        format!("import-publication-v1\0{transfer_id}\0{plan_sha256}").as_bytes(),
    );
    if !constant_time_eq(expected.as_bytes(), proof.as_bytes()) {
        return Err(PortcoveError::verification(
            "import publication proof is invalid",
        ));
    }
    Ok(())
}

fn canonical_entries(mut entries: Vec<PortabilityAdmission>) -> Result<Vec<PortabilityAdmission>> {
    entries.sort_by(|left, right| left.install_id.cmp(&right.install_id));
    if entries
        .windows(2)
        .any(|pair| pair[0].install_id == pair[1].install_id)
    {
        return Err(PortcoveError::verification(
            "portability authority repeats an installation identity",
        ));
    }
    if entries
        .iter()
        .any(|entry| !matches!(entry.role.as_str(), "active" | "previous"))
    {
        return Err(PortcoveError::verification(
            "portability authority has an invalid selection role",
        ));
    }
    Ok(entries)
}

fn hmac_sha256(key: &[u8], message: &[u8]) -> String {
    let mut block = [0_u8; 64];
    if key.len() > block.len() {
        block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let mut inner_pad = [0x36_u8; 64];
    let mut outer_pad = [0x5c_u8; 64];
    for index in 0..64 {
        inner_pad[index] ^= block[index];
        outer_pad[index] ^= block[index];
    }
    let inner = Sha256::new()
        .chain_update(inner_pad)
        .chain_update(message)
        .finalize();
    hex::encode(
        Sha256::new()
            .chain_update(outer_pad)
            .chain_update(inner)
            .finalize(),
    )
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

#[cfg(test)]
fn load_key() -> Result<Option<Vec<u8>>> {
    Ok(Some(vec![0x91; 32]))
}

#[cfg(test)]
fn load_or_create_key() -> Result<Vec<u8>> {
    Ok(vec![0x91; 32])
}

#[cfg(not(test))]
fn load_key() -> Result<Option<Vec<u8>>> {
    let entry = credential_entry()?;
    match entry.get_password() {
        Ok(value) => {
            let key = hex::decode(value).map_err(|_| {
                PortcoveError::verification("stored portability authority key is invalid")
            })?;
            if key.len() != 32 {
                return Err(PortcoveError::verification(
                    "stored portability authority key is invalid",
                ));
            }
            Ok(Some(key))
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(credential_error("read", error)),
    }
}

#[cfg(not(test))]
fn load_or_create_key() -> Result<Vec<u8>> {
    if let Some(key) = load_key()? {
        return Ok(key);
    }
    let mut key = Vec::with_capacity(32);
    key.extend_from_slice(uuid::Uuid::new_v4().as_bytes());
    key.extend_from_slice(uuid::Uuid::new_v4().as_bytes());
    credential_entry()?
        .set_password(&hex::encode(&key))
        .map_err(|error| credential_error("write", error))?;
    Ok(key)
}

#[cfg(not(test))]
fn credential_entry() -> Result<keyring::Entry> {
    keyring::Entry::new(CREDENTIAL_SERVICE, CREDENTIAL_USER)
        .map_err(|error| credential_error("open", error))
}

#[cfg(not(test))]
fn credential_error(action: &str, error: keyring::Error) -> PortcoveError {
    PortcoveError::state(format!(
        "could not {action} the portability authority in operating-system secure storage: {error}"
    ))
}
