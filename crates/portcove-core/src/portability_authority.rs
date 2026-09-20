//! Host-local proof that a retained definition was admitted before portability.
//!
//! The retained manifest preserves exact semantics, but its serialized admission identity is not
//! independently authoritative. This receipt binds those semantics to an operating-system secure
//! secret. It deliberately does not invent cross-device trust.

use std::{fs, path::Path};

use fs2::FileExt;
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
    let project = directories::ProjectDirs::from("io.github", "Portcove", "Portcove")
        .ok_or_else(|| PortcoveError::state("could not determine the Portcove data directory"))?;
    load_or_create_key_at(
        &project.data_local_dir().join("portability-authority.lock"),
        load_key,
        |key| {
            credential_entry()?
                .set_password(&hex::encode(key))
                .map_err(|error| credential_error("write", error))
        },
        || {
            let mut key = Vec::with_capacity(32);
            key.extend_from_slice(uuid::Uuid::new_v4().as_bytes());
            key.extend_from_slice(uuid::Uuid::new_v4().as_bytes());
            key
        },
    )
}

fn load_or_create_key_at(
    lock_path: &Path,
    mut load: impl FnMut() -> Result<Option<Vec<u8>>>,
    mut store: impl FnMut(&[u8]) -> Result<()>,
    generate: impl FnOnce() -> Vec<u8>,
) -> Result<Vec<u8>> {
    let parent = lock_path
        .parent()
        .ok_or_else(|| PortcoveError::state("portability authority lock has no parent"))?;
    fs::create_dir_all(parent)?;
    let file = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(lock_path)?;
    FileExt::lock_exclusive(&file)?;
    let result = (|| {
        if let Some(key) = load()? {
            return Ok(key);
        }
        let generated = generate();
        store(&generated)?;
        let stored = load()?.ok_or_else(|| {
            PortcoveError::state("stored portability authority key disappeared after creation")
        })?;
        if stored != generated {
            return Err(PortcoveError::state(
                "stored portability authority key changed during creation",
            ));
        }
        Ok(stored)
    })();
    let unlock = FileExt::unlock(&file).map_err(PortcoveError::from);
    match (result, unlock) {
        (Err(error), _) | (Ok(_), Err(error)) => Err(error),
        (Ok(key), Ok(())) => Ok(key),
    }
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

#[cfg(test)]
mod tests {
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    };

    use super::*;

    #[test]
    fn concurrent_first_use_creates_one_stable_host_key() {
        let temporary = tempfile::tempdir().unwrap();
        let lock_path = temporary.path().join("authority.lock");
        let stored = Arc::new(Mutex::new(None::<Vec<u8>>));
        let generations = Arc::new(AtomicUsize::new(0));
        let mut workers = Vec::new();
        for _ in 0..8 {
            let lock_path = lock_path.clone();
            let stored = Arc::clone(&stored);
            let generations = Arc::clone(&generations);
            workers.push(std::thread::spawn(move || {
                load_or_create_key_at(
                    &lock_path,
                    || Ok(stored.lock().unwrap().clone()),
                    |key| {
                        std::thread::sleep(std::time::Duration::from_millis(20));
                        *stored.lock().unwrap() = Some(key.to_vec());
                        Ok(())
                    },
                    || {
                        let generation = generations.fetch_add(1, Ordering::SeqCst) + 1;
                        vec![u8::try_from(generation).unwrap(); 32]
                    },
                )
                .unwrap()
            }));
        }
        let keys = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(generations.load(Ordering::SeqCst), 1);
        assert!(keys.iter().all(|key| key == &keys[0]));
        assert_eq!(stored.lock().unwrap().as_ref(), Some(&keys[0]));
    }
}
