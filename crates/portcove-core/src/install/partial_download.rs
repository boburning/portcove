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
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

use serde::{Deserialize, Serialize};

use crate::{ReleaseAsset, Result};

const RECORD_BYTES: u64 = 16 * 1024;
const TEMPORARY_PREFIX: &str = ".portcove-partial-";
pub(super) const INDEX_LOCK: &str = "index.lock";

/// Serializes pathname and record changes. Network transfers only hold the
/// individual part lock. While holding this lock, a part lock must never wait.
fn lock_index(root: &Path) -> std::io::Result<File> {
    let path = root.join(INDEX_LOCK);
    if fs::symlink_metadata(&path).is_ok_and(|metadata| !metadata.is_file()) {
        return Err(std::io::Error::other("invalid partial download index lock"));
    }
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)?;
    file.lock()?;
    Ok(file)
}

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
    root: PathBuf,
    part: PathBuf,
    record: PathBuf,
    asset: ReleaseAsset,
    resumed: Option<Received>,
}

/// The kept bytes of every entry that can continue (its bytes and its
/// representation record are both present), keyed by entry. A snapshot taken
/// without the index lock: it is only compared with an earlier snapshot to
/// tell whether downloads advanced, so a racing writer only makes it later.
pub(crate) fn kept_downloads(root: &Path) -> crate::temporary_failure::KeptDownloads {
    let mut kept = crate::temporary_failure::KeptDownloads::new();
    let Ok(entries) = fs::read_dir(root) else {
        return kept;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(key) = name.strip_suffix(".part") else {
            continue;
        };
        if !root.join(format!("{key}.json")).is_file() {
            continue;
        }
        if let Ok(metadata) = fs::symlink_metadata(entry.path())
            && metadata.is_file()
            && metadata.len() > 0
        {
            kept.insert(key.to_owned(), metadata.len());
        }
    }
    kept
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
        fs::create_dir_all(&self.root).ok()?;
        crate::path::refuse_symlink_ancestors(&self.root).ok()?;
        if fs::symlink_metadata(&self.root)
            .map(|metadata| !metadata.is_dir())
            .unwrap_or(true)
        {
            return None;
        }
        let _index = lock_index(&self.root).ok()?;
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
        let received = resumed.as_ref().map_or(0, |entry| entry.bytes);
        if !self.admit(&key, asset.size, received) {
            if resumed.is_none() {
                // No validator or useful bytes can belong to this entry.
                drop(file);
                let _ = fs::remove_file(&part);
            }
            return None;
        }
        Some(Lease {
            file,
            root: self.root.clone(),
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

    /// Makes room for the incoming asset while counting the full declared
    /// length of each other active transfer. Idle entries use their actual size.
    fn admit(&self, keeping: &str, keeping_bytes: u64, received: u64) -> bool {
        let Ok(entries) = fs::read_dir(&self.root) else {
            return false;
        };
        let mut idle = Vec::new();
        let mut count = 1;
        let mut total = keeping_bytes;
        let mut needed = keeping_bytes.saturating_sub(received);
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
            if !metadata.is_file() && self.remove_unheld(key) {
                continue;
            }
            let idle_metadata = metadata
                .is_file()
                .then(|| {
                    let file = OpenOptions::new().read(true).write(true).open(&path).ok()?;
                    file.try_lock().ok()?;
                    // An interrupted transfer can drop its lock after writing
                    // more bytes than the directory walk initially observed.
                    file.metadata().ok()
                })
                .flatten();
            if let Some(metadata) = idle_metadata {
                let modified = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);
                let expired = SystemTime::now()
                    .duration_since(modified)
                    .is_ok_and(|age| age > self.max_age);
                if expired && self.remove_unheld(key) {
                    continue;
                }
                idle.push((modified, key.to_owned(), metadata.len()));
                total = total.saturating_add(metadata.len());
            } else {
                // The size is encoded in every transfer's key, even before a
                // response supplies the validator record. An unreadable
                // entry without a valid size cannot guarantee another lease.
                let Some(size) = key
                    .rsplit_once('-')
                    .and_then(|(_, size)| size.parse::<u64>().ok())
                else {
                    return false;
                };
                total = total.saturating_add(size.max(metadata.len()));
                // A concurrent transfer may reset its representation and
                // truncate after we read the directory entry.
                needed = needed.saturating_add(size);
            }
            count += 1;
        }
        idle.sort();
        // The byte budget bounds what idle entries may keep. One asset larger
        // than the budget still keeps its own progress once everything else
        // has made room, so a large game on a slow link is never the one
        // download that cannot continue after a restart. Free disk space
        // remains the hard bound.
        let budget = self.max_bytes.max(keeping_bytes);
        let fits = |count, total| {
            count <= self.max_entries
                && total <= budget
                && fs4::available_space(&self.root).is_ok_and(|available| needed <= available)
        };
        for (_, key, size) in idle {
            if fits(count, total) {
                return true;
            }
            if self.remove_unheld(&key) {
                total = total.saturating_sub(size);
                count -= 1;
            }
        }
        fits(count, total)
    }

    /// Removes an entry unless another transfer holds it.
    fn remove_unheld(&self, key: &str) -> bool {
        let (part, record) = self.paths(key);
        let _file = match fs::symlink_metadata(&part) {
            Ok(metadata) if metadata.is_file() => {
                let Ok(file) = OpenOptions::new().read(true).write(true).open(&part) else {
                    return false;
                };
                if file.try_lock().is_err() {
                    return false;
                }
                Some(file)
            }
            Ok(_) => None,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(_) => return false,
        };
        let _ = fs::remove_file(record);
        match fs::remove_file(part) {
            Ok(()) => true,
            Err(error) => error.kind() == std::io::ErrorKind::NotFound,
        }
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
        let Ok(_index) = lock_index(&self.root) else {
            return;
        };
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
        if let Ok(_index) = lock_index(&self.root) {
            let _ = fs::remove_file(&self.record);
        }
    }

    /// Moves the complete bytes to `destination` and removes the entry.
    pub(crate) fn finish(
        mut self,
        destination: &Path,
        checkpoint: impl Fn() -> Result<()>,
        validate_destination: impl Fn() -> Result<()>,
    ) -> Result<()> {
        {
            let _index = lock_index(&self.root)?;
            checkpoint()?;
            validate_destination()?;
            let _ = fs::remove_file(&self.record);
            if crate::durability::rename_noreplace(&self.part, destination).is_ok() {
                return Ok(());
            }
        }
        // A different volume still needs a copy. Keep the part locked but
        // leave the index available to other assets during that transfer.
        self.file.rewind()?;
        checkpoint()?;
        validate_destination()?;
        let mut output = File::create_new(destination)?;
        let mut buffer = [0_u8; 128 * 1024];
        loop {
            checkpoint()?;
            let count = self.file.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            output.write_all(&buffer[..count])?;
        }
        let _index = lock_index(&self.root)?;
        fs::remove_file(&self.part)?;
        Ok(())
    }

    /// Removes the entry and its bytes, for example after a rejected file.
    pub(crate) fn discard(self) {
        let Ok(_index) = lock_index(&self.root) else {
            return;
        };
        let _ = fs::remove_file(&self.record);
        let _ = self.file.set_len(0);
        let _ = fs::remove_file(&self.part);
    }
}
