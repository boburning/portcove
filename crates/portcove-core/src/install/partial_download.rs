//! Bytes of a release download kept so a later transfer of the exact same
//! asset can continue after Portcove stops, crashes or the transfer fails
//! (#6222).
//!
//! A transfer that may use the store writes straight into its entry while it
//! holds an exclusive lock on it, and records the strong validator as soon as
//! it is known, so received bytes survive a process exit. Resume is only a
//! transport optimization: an entry is bound to the asset's URL, declared size
//! and expected SHA-256 and to its validator; the next transfer continues only
//! through the same `Range` and `If-Range` checks as a reconnect within one
//! transfer, and the caller still verifies the complete file. Nothing here
//! publishes, registers or activates anything.
use std::{
    fs::{self, File, OpenOptions},
    io::{Seek, SeekFrom},
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

use serde::{Deserialize, Serialize};

use crate::{ReleaseAsset, Result};

const RECORD_BYTES: u64 = 16 * 1024;
const TEMPORARY_PREFIX: &str = ".portcove-partial-";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    format_version: u32,
    url: String,
    size: u64,
    sha256: String,
    validator: String,
    length: Option<u64>,
}

/// Received bytes and the representation facts they belong to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Received {
    pub(crate) bytes: u64,
    pub(crate) validator: String,
    pub(crate) length: Option<u64>,
}

#[derive(Debug, Clone)]
pub(crate) struct PartialDownloads {
    root: PathBuf,
    max_entries: usize,
    max_bytes: u64,
    max_age: Duration,
}

/// Exclusive use of one asset's entry for the length of one transfer. Dropping
/// it keeps the bytes for a later transfer.
#[derive(Debug)]
pub(crate) struct Lease {
    file: File,
    part: PathBuf,
    record: PathBuf,
    asset: ReleaseAsset,
    resumed: Option<Received>,
}

impl PartialDownloads {
    pub(crate) fn new(root: PathBuf) -> Self {
        Self {
            root,
            max_entries: 4,
            max_bytes: 16 * 1024 * 1024 * 1024,
            max_age: Duration::from_secs(7 * 24 * 60 * 60),
        }
    }

    #[cfg(test)]
    pub(crate) fn with_bounds(
        root: PathBuf,
        max_entries: usize,
        max_bytes: u64,
        max_age: Duration,
    ) -> Self {
        Self {
            root,
            max_entries,
            max_bytes,
            max_age,
        }
    }

    /// Only an asset with an expected digest the caller verifies may continue.
    fn key(asset: &ReleaseAsset) -> Option<String> {
        let sha256 = asset.sha256.to_ascii_lowercase();
        (sha256.len() == 64
            && sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
            && asset.size > 0)
            .then(|| format!("{sha256}-{}", asset.size))
    }

    fn paths(&self, key: &str) -> (PathBuf, PathBuf) {
        (
            self.root.join(format!("{key}.part")),
            self.root.join(format!("{key}.json")),
        )
    }

    /// Takes this asset's entry for one transfer: its kept bytes when they
    /// still match, otherwise an empty entry. `None` when the asset cannot use
    /// the store, another transfer holds it, or the store is unusable; the
    /// caller then downloads without it.
    pub(crate) fn lease(&self, asset: &ReleaseAsset) -> Option<Lease> {
        let key = Self::key(asset)?;
        if asset.size > self.max_bytes {
            return None;
        }
        fs::create_dir_all(&self.root).ok()?;
        crate::path::refuse_symlink_ancestors(&self.root).ok()?;
        if fs::symlink_metadata(&self.root)
            .map(|metadata| !metadata.is_dir())
            .unwrap_or(true)
        {
            return None;
        }
        let (part, record) = self.paths(&key);
        if fs::symlink_metadata(&part).is_ok_and(|metadata| !metadata.is_file()) {
            return None;
        }
        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&part)
            .ok()?;
        file.try_lock().ok()?;
        let resumed = self.matching(asset, &file, &record);
        if resumed.is_none() {
            let _ = fs::remove_file(&record);
            file.set_len(0).ok()?;
        }
        file.seek(SeekFrom::End(0)).ok()?;
        // Bounds apply to everything else in the store, including entries a
        // crash left behind.
        self.sweep(&key, asset.size);
        Some(Lease {
            file,
            part,
            record,
            asset: asset.clone(),
            resumed,
        })
    }

    fn matching(&self, asset: &ReleaseAsset, file: &File, record_path: &Path) -> Option<Received> {
        let record: Record = serde_json::from_slice(
            &crate::path::read_bounded_regular(record_path, RECORD_BYTES).ok()?,
        )
        .ok()?;
        let metadata = file.metadata().ok()?;
        let bytes = metadata.len();
        let fresh = metadata
            .modified()
            .ok()
            .and_then(|modified| SystemTime::now().duration_since(modified).ok())
            .is_some_and(|age| age <= self.max_age);
        (fresh
            && record.format_version == 1
            && record.url == asset.url
            && record.size == asset.size
            && record.sha256 == asset.sha256.to_ascii_lowercase()
            && bytes > 0
            && bytes < asset.size
            && record.length.is_none_or(|length| length == asset.size))
        .then_some(Received {
            bytes,
            validator: record.validator,
            length: record.length,
        })
    }

    /// Removes expired, unpaired, leftover and surplus entries other than
    /// `keeping`, so `keeping` plus the rest fits the bounds. An entry another
    /// transfer holds is left alone.
    fn sweep(&self, keeping: &str, keeping_bytes: u64) {
        let Ok(entries) = fs::read_dir(&self.root) else {
            return;
        };
        let mut kept = Vec::new();
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let path = entry.path();
            if name.starts_with(TEMPORARY_PREFIX) {
                let _ = fs::remove_file(&path);
                continue;
            }
            if let Some(key) = name.strip_suffix(".json") {
                if !self.paths(key).0.exists() {
                    let _ = fs::remove_file(&path);
                }
                continue;
            }
            let Some(key) = name.strip_suffix(".part") else {
                continue;
            };
            if key == keeping {
                continue;
            }
            let Ok(metadata) = fs::symlink_metadata(&path) else {
                continue;
            };
            let modified = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);
            let expired = SystemTime::now()
                .duration_since(modified)
                .is_ok_and(|age| age > self.max_age);
            if expired || !metadata.is_file() {
                self.remove_unheld(key);
                continue;
            }
            kept.push((modified, key.to_owned(), metadata.len()));
        }
        kept.sort();
        let mut total = kept
            .iter()
            .map(|(_, _, size)| size)
            .sum::<u64>()
            .saturating_add(keeping_bytes);
        let mut count = kept.len() + 1;
        for (_, key, size) in kept {
            if count <= self.max_entries && total <= self.max_bytes {
                break;
            }
            if self.remove_unheld(&key) {
                total = total.saturating_sub(size);
                count -= 1;
            }
        }
    }

    /// Removes an entry unless another transfer holds it.
    fn remove_unheld(&self, key: &str) -> bool {
        let (part, record) = self.paths(key);
        let held = File::open(&part).is_ok_and(|file| file.try_lock().is_err());
        if held {
            return false;
        }
        let _ = fs::remove_file(record);
        let _ = fs::remove_file(part);
        true
    }
}

impl Lease {
    /// Kept bytes this transfer continues from, if any.
    pub(crate) fn resumed(&self) -> Option<&Received> {
        self.resumed.as_ref()
    }

    /// A second handle the transfer writes through; the lock stays on this lease.
    pub(crate) fn writer(&self) -> std::io::Result<File> {
        let mut file = self.file.try_clone()?;
        file.seek(SeekFrom::End(0))?;
        Ok(file)
    }

    /// Records the representation the bytes now belong to. Without a strong
    /// validator they cannot continue, so no record is kept.
    pub(crate) fn describe(&self, validator: Option<&str>, length: Option<u64>) {
        let _ = fs::remove_file(&self.record);
        let Some(validator) = validator else {
            return;
        };
        let record = Record {
            format_version: 1,
            url: self.asset.url.clone(),
            size: self.asset.size,
            sha256: self.asset.sha256.to_ascii_lowercase(),
            validator: validator.to_owned(),
            length,
        };
        if let Ok(bytes) = serde_json::to_vec(&record) {
            let _ = crate::durability::write_bytes_atomically_with_prefix(
                &self.record,
                &bytes,
                true,
                Some(TEMPORARY_PREFIX),
            );
        }
    }

    /// Drops the representation record before received bytes are discarded.
    pub(crate) fn forget(&self) {
        let _ = fs::remove_file(&self.record);
    }

    /// Moves the complete bytes to `destination` and removes the entry.
    pub(crate) fn finish(self, destination: &Path) -> Result<()> {
        let _ = fs::remove_file(&self.record);
        let Self { file, part, .. } = self;
        // The lock and handle go before the file moves (Windows refuses
        // renaming an open file).
        drop(file);
        if fs::rename(&part, destination).is_err() {
            // A game output folder on another volume.
            fs::copy(&part, destination)?;
            fs::remove_file(&part)?;
        }
        Ok(())
    }

    /// Removes the entry and its bytes, for example after a rejected file.
    pub(crate) fn discard(self) {
        let _ = fs::remove_file(&self.record);
        let _ = self.file.set_len(0);
        let Self { file, part, .. } = self;
        drop(file);
        let _ = fs::remove_file(part);
    }
}
