use std::{
    fs,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

use crate::{PortcoveError, Result};

const AUTHORITY_FILE: &str = ".portcove-authority.json";
const RECEIPT_FILE: &str = ".portcove-transfer-receipt.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AuthorityState {
    Pending,
    Moved,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct LibraryAuthority {
    pub schema_version: u32,
    pub transfer_id: String,
    pub state: AuthorityState,
    pub destination: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct TransferReceipt {
    schema_version: u32,
    transfer_id: String,
}

pub(crate) fn authority(root: &Path) -> Result<Option<LibraryAuthority>> {
    let marker: Option<LibraryAuthority> = read_marker(&root.join(AUTHORITY_FILE))?;
    if let Some(marker) = &marker {
        validate_marker(marker.schema_version, &marker.transfer_id)?;
        if !marker.destination.is_absolute() {
            return Err(PortcoveError::state(
                "library authority has a relative destination",
            ));
        }
    }
    Ok(marker)
}

pub(crate) fn open_target(root: &Path) -> Result<Option<PathBuf>> {
    crate::import_journal::check_open(root)?;
    let Some(marker) = authority(root)? else {
        return Ok(None);
    };
    if marker.state == AuthorityState::Pending {
        return Err(PortcoveError::conflict(
            "library transfer needs recovery before this library can open",
        )
        .detail("transfer_id", marker.transfer_id)
        .detail("retained_source", root.display().to_string())
        .detail("recovery_action", "resume_library_move"));
    }
    verify_receipt(&marker.destination, &marker.transfer_id)?;
    Ok(Some(marker.destination))
}

pub(crate) fn write_authority(root: &Path, marker: &LibraryAuthority, replace: bool) -> Result<()> {
    crate::durability::write_json_atomically(&root.join(AUTHORITY_FILE), marker, replace)
}

pub(crate) fn write_receipt(root: &Path, transfer_id: &str) -> Result<()> {
    crate::durability::write_json_atomically(
        &root.join(RECEIPT_FILE),
        &TransferReceipt {
            schema_version: 1,
            transfer_id: transfer_id.into(),
        },
        false,
    )
}

pub(crate) fn verify_receipt(root: &Path, transfer_id: &str) -> Result<()> {
    let receipt: TransferReceipt = read_marker(&root.join(RECEIPT_FILE))?.ok_or_else(|| {
        PortcoveError::conflict(
            "the moved library has not finished publication; resume its transfer",
        )
    })?;
    validate_marker(receipt.schema_version, &receipt.transfer_id)?;
    if receipt.transfer_id != transfer_id {
        return Err(PortcoveError::verification(
            "destination library receipt does not match this transfer",
        ));
    }
    Ok(())
}

pub(crate) fn activate_destination(root: &Path, transfer_id: &str) -> Result<()> {
    verify_receipt(root, transfer_id)?;
    let marker = authority(root)?
        .ok_or_else(|| PortcoveError::state("destination authority marker is missing"))?;
    if marker.transfer_id != transfer_id || marker.state != AuthorityState::Pending {
        return Err(PortcoveError::verification(
            "destination authority belongs to another transfer",
        ));
    }
    fs::remove_file(root.join(AUTHORITY_FILE))?;
    crate::durability::sync_publication(root)?;
    Ok(())
}

pub(crate) fn abort_source(root: &Path, transfer_id: &str) -> Result<()> {
    if let Some(marker) = authority(root)? {
        if marker.transfer_id != transfer_id || marker.state != AuthorityState::Pending {
            return Err(PortcoveError::conflict(
                "the source can no longer be reactivated safely",
            ));
        }
        fs::remove_file(root.join(AUTHORITY_FILE))?;
        crate::durability::sync_publication(root)?;
    }
    Ok(())
}

fn validate_marker(version: u32, transfer_id: &str) -> Result<()> {
    if version != 1 || uuid::Uuid::parse_str(transfer_id).is_err() {
        return Err(PortcoveError::state(
            "library authority marker is invalid or unsupported",
        ));
    }
    Ok(())
}

fn read_marker<T: serde::de::DeserializeOwned>(path: &Path) -> Result<Option<T>> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 16 * 1024 {
        return Err(PortcoveError::state(
            "library authority marker is not a bounded regular file",
        ));
    }
    Ok(Some(serde_json::from_slice(
        &crate::path::read_bounded_regular(path, 16 * 1024)?,
    )?))
}
