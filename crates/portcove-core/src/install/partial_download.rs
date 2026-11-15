//! Bytes of an interrupted release download, kept so a later transfer of the
//! exact same asset can continue after Portcove restarts (#6222).
//!
//! Resume is only a transport optimization. An entry is bound to the asset's
//! URL, declared size and expected SHA-256, and to the strong validator its
//! bytes came with; the next transfer continues only through the same `Range`
//! and `If-Range` checks as a reconnect within one transfer, and the caller
//! still verifies the complete file. Nothing here publishes, registers or
//! activates anything.
use std::{
    fs,
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

use serde::{Deserialize, Serialize};

use crate::{ReleaseAsset, Result};

/// Entries kept at once; the oldest is dropped first.
const MAX_ENTRIES: usize = 4;
/// Total received bytes kept at once.
const MAX_TOTAL_BYTES: u64 = 16 * 1024 * 1024 * 1024;
/// Entries older than this are discarded unused.
const MAX_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const RECORD_BYTES: u64 = 16 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    format_version: u32,
    url: String,
    size: u64,
    sha256: String,
    validator: String,
    length: Option<u64>,
    received: u64,
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
}

impl PartialDownloads {
    pub(crate) fn new(root: PathBuf) -> Self {
        Self { root }
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

    fn record_for(asset: &ReleaseAsset, received: &Received) -> Record {
        Record {
            format_version: 1,
            url: asset.url.clone(),
            size: asset.size,
            sha256: asset.sha256.to_ascii_lowercase(),
            validator: received.validator.clone(),
            length: received.length,
            received: received.bytes,
        }
    }

    /// Moves a matching entry's bytes to `destination` and returns what they
    /// are; any mismatch, expiry or damage discards the entry instead.
    pub(crate) fn take(&self, asset: &ReleaseAsset, destination: &Path) -> Option<Received> {
        let key = Self::key(asset)?;
        let (part, record_path) = self.paths(&key);
        let restored = Self::restore(asset, &part, &record_path, destination);
        let _ = fs::remove_file(&record_path);
        let _ = fs::remove_file(&part);
        restored.ok().flatten()
    }

    fn restore(
        asset: &ReleaseAsset,
        part: &Path,
        record_path: &Path,
        destination: &Path,
    ) -> Result<Option<Received>> {
        if !record_path.exists() {
            return Ok(None);
        }
        let record: Record = serde_json::from_slice(&crate::path::read_bounded_regular(
            record_path,
            RECORD_BYTES,
        )?)?;
        let metadata = fs::symlink_metadata(part)?;
        let fresh = metadata
            .modified()
            .ok()
            .and_then(|modified| SystemTime::now().duration_since(modified).ok())
            .is_some_and(|age| age <= MAX_AGE);
        if !metadata.is_file()
            || !fresh
            || record.format_version != 1
            || record.url != asset.url
            || record.size != asset.size
            || record.sha256 != asset.sha256.to_ascii_lowercase()
            || record.received == 0
            || record.received >= asset.size
            || metadata.len() != record.received
            || record.length.is_some_and(|length| length != asset.size)
        {
            return Ok(None);
        }
        fs::rename(part, destination)?;
        Ok(Some(Received {
            bytes: record.received,
            validator: record.validator,
            length: record.length,
        }))
    }

    /// Keeps the bytes at `source` for a later transfer of the same asset. The
    /// caller has drained and closed its writer; a failure keeps nothing.
    pub(crate) fn keep(&self, asset: &ReleaseAsset, source: &Path, received: &Received) {
        let Some(key) = Self::key(asset) else {
            return;
        };
        if received.bytes == 0
            || received.bytes >= asset.size
            || received.bytes > MAX_TOTAL_BYTES
            || fs::symlink_metadata(source)
                .map(|metadata| metadata.len())
                .ok()
                != Some(received.bytes)
        {
            return;
        }
        let (part, record_path) = self.paths(&key);
        let kept = self.store(asset, source, received, &key, &part, &record_path);
        if kept.is_err() {
            let _ = fs::remove_file(&record_path);
            let _ = fs::remove_file(&part);
        }
    }

    fn store(
        &self,
        asset: &ReleaseAsset,
        source: &Path,
        received: &Received,
        key: &str,
        part: &Path,
        record_path: &Path,
    ) -> Result<()> {
        fs::create_dir_all(&self.root)?;
        crate::path::refuse_symlink_ancestors(&self.root)?;
        self.make_room(key, received.bytes)?;
        let _ = fs::remove_file(record_path);
        fs::rename(source, part)?;
        crate::durability::write_bytes_atomically_with_prefix(
            record_path,
            &serde_json::to_vec(&Self::record_for(asset, received))?,
            true,
            Some(".portcove-partial-"),
        )
    }

    /// Drops any entry for `asset`, for example after it completed.
    pub(crate) fn discard(&self, asset: &ReleaseAsset) {
        if let Some(key) = Self::key(asset) {
            let (part, record_path) = self.paths(&key);
            let _ = fs::remove_file(record_path);
            let _ = fs::remove_file(part);
        }
    }

    /// Removes expired, unpaired and oldest entries until one more of `bytes`
    /// fits the bounds.
    fn make_room(&self, keeping: &str, bytes: u64) -> Result<()> {
        let mut entries = Vec::new();
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some(key) = name.strip_suffix(".part") else {
                if let Some(key) = name.strip_suffix(".json")
                    && !self.paths(key).0.exists()
                {
                    let _ = fs::remove_file(&path);
                }
                continue;
            };
            let metadata = fs::symlink_metadata(&path)?;
            let modified = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);
            let expired = SystemTime::now()
                .duration_since(modified)
                .is_ok_and(|age| age > MAX_AGE);
            if key == keeping || expired || !metadata.is_file() {
                let (part, record_path) = self.paths(key);
                let _ = fs::remove_file(record_path);
                let _ = fs::remove_file(part);
                continue;
            }
            entries.push((modified, key.to_owned(), metadata.len()));
        }
        entries.sort();
        let mut total: u64 = entries.iter().map(|(_, _, size)| size).sum();
        let mut count = entries.len();
        for (_, key, size) in entries {
            if count < MAX_ENTRIES && total.saturating_add(bytes) <= MAX_TOTAL_BYTES {
                break;
            }
            let (part, record_path) = self.paths(&key);
            fs::remove_file(record_path).or_else(ignore_missing)?;
            fs::remove_file(part).or_else(ignore_missing)?;
            total -= size;
            count -= 1;
        }
        Ok(())
    }
}

fn ignore_missing(error: std::io::Error) -> std::io::Result<()> {
    if error.kind() == std::io::ErrorKind::NotFound {
        Ok(())
    } else {
        Err(error)
    }
}
