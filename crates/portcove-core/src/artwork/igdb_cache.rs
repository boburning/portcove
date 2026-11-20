//! Disposable remote artwork derivatives and blocking work admission.
use std::{
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{Condvar, Mutex},
    time::{Duration, Instant},
};

use sha2::{Digest, Sha256};

use crate::{Library, PortcoveError, Result, artwork_image, signed_catalog::digest};

/// Maximum simultaneous remote original retrievals.
pub const IGDB_ARTWORK_WORK_LIMIT: usize = 6;
const DIGEST_BYTES: usize = 64;
const DERIVATIVE_MARKER: &[u8; 8] = b"PCDERIV1";
const SOURCE_BINDING_BYTES: usize = DERIVATIVE_MARKER.len() + DIGEST_BYTES;
const TRAILER_BYTES: usize = SOURCE_BINDING_BYTES + DIGEST_BYTES;

/// The path keys only reusable bytes. The caller still has to resolve the
/// current listing and choice and verify the admitted original before use.
pub(crate) struct RemoteDerivative {
    key: String,
    source: String,
    path: PathBuf,
}

impl RemoteDerivative {
    pub(crate) fn new(library: &Library, source: &str, recipe: &str) -> Result<Self> {
        crate::artwork_store::validate_hash(source)?;
        // Bump this version whenever the shared EXIF orientation, fit, or
        // static PNG encoding recipe changes.
        let key = digest(format!("oriented-png-v1:{source}:{recipe}").as_bytes());
        let path = super::thumbnail_path(library, &key)?;
        Ok(Self {
            key,
            source: source.into(),
            path,
        })
    }

    pub(crate) fn key(&self) -> &str {
        &self.key
    }

    fn checksum(&self, png: &[u8]) -> String {
        let mut hash = Sha256::new();
        hash.update(self.key.as_bytes());
        hash.update(png);
        hex::encode(hash.finalize())
    }

    /// Read just the source binding when an original is retired. Ordinary
    /// local thumbnails have no binding and keep their existing cache path.
    pub(super) fn retained_source(path: &Path, size: u64) -> Option<String> {
        if path.extension().and_then(|extension| extension.to_str()) != Some("png")
            || !(TRAILER_BYTES as u64..=artwork_image::MAX_THUMBNAIL_BYTES).contains(&size)
        {
            return None;
        }
        crate::path::refuse_symlink_ancestors(path).ok()?;
        let mut file = crate::external_runtime::open_identity_handle(path).ok()?;
        let metadata = file.metadata().ok()?;
        if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() != size {
            return None;
        }
        file.seek(SeekFrom::End(-(TRAILER_BYTES as i64))).ok()?;
        let mut binding = [0_u8; SOURCE_BINDING_BYTES];
        file.read_exact(&mut binding).ok()?;
        let source = std::str::from_utf8(binding.strip_prefix(DERIVATIVE_MARKER)?).ok()?;
        crate::artwork_store::validate_hash(source).ok()?;
        Some(source.into())
    }

    /// Check the recipe-bound digest trailer as well as the existing byte bound.
    pub(crate) fn read(&self) -> Option<Vec<u8>> {
        let started = Instant::now();
        let result =
            crate::path::read_bounded_regular(&self.path, artwork_image::MAX_THUMBNAIL_BYTES)
                .ok()
                .and_then(|mut bytes| {
                    let size = bytes.len().checked_sub(TRAILER_BYTES)?;
                    let (png, trailer) = bytes.split_at(size);
                    let (binding, checksum) = trailer.split_at(SOURCE_BINDING_BYTES);
                    if !png.starts_with(b"\x89PNG\r\n\x1a\n")
                        || binding.strip_prefix(DERIVATIVE_MARKER) != Some(self.source.as_bytes())
                        || checksum != self.checksum(png).as_bytes()
                    {
                        return None;
                    }
                    bytes.truncate(size);
                    Some(bytes)
                });
        tracing::debug!(
            elapsed_us = started.elapsed().as_micros() as u64,
            input_bytes = result.as_ref().map_or(0, |bytes| bytes.len() as u64),
            success = result.is_some(),
            message = "Remote artwork derivative lookup"
        );
        result
    }

    /// The caller holds the library artwork lock. Cache failure cannot hide
    /// artwork that was already accepted and converted for this request.
    pub(crate) fn retain(&self, library: &Library, source: &Path, png: &[u8]) {
        if png.len() + TRAILER_BYTES > artwork_image::MAX_THUMBNAIL_BYTES as usize {
            return;
        }
        // Another publication can retire this original while a cached image
        // is converting outside the lock. Keep the computed result in memory.
        if !std::fs::symlink_metadata(source).is_ok_and(|metadata| {
            metadata.is_file()
                && !metadata.file_type().is_symlink()
                && metadata.len() <= artwork_image::MAX_ORIGINAL_BYTES
        }) {
            return;
        }
        let mut bytes = Vec::with_capacity(png.len() + TRAILER_BYTES);
        bytes.extend_from_slice(png);
        bytes.extend_from_slice(DERIVATIVE_MARKER);
        bytes.extend_from_slice(self.source.as_bytes());
        bytes.extend_from_slice(self.checksum(png).as_bytes());
        if let Err(error) = super::publish_cache_file(
            library,
            &self.path,
            "pending-thumbnail",
            artwork_image::MAX_THUMBNAIL_BYTES,
            &bytes,
            None,
            Some(source),
        ) {
            tracing::debug!(code = ?error.code, "Remote artwork derivative cache publication failed");
        }
    }
}

const CACHE_EPOCH_FILE: &str = "artwork-cache-epoch";
const EPOCH_BYTES: u64 = 16;

pub(super) fn cache_epoch(library: &Library) -> Result<Option<uuid::Uuid>> {
    let path = library.locks_dir().join(CACHE_EPOCH_FILE);
    crate::path::refuse_symlink_ancestors(&path)?;
    match path.symlink_metadata() {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
        Ok(_) => {
            let bytes = crate::path::read_bounded_regular(&path, EPOCH_BYTES)?;
            uuid::Uuid::from_slice(&bytes)
                .map(Some)
                .map_err(|_| PortcoveError::verification("invalid artwork cache epoch"))
        }
    }
}

/// The caller holds the artwork lock. A fixed staged name bounds debris after
/// interruption. Existing processes compare this token before publishing.
pub(super) fn advance_cache_epoch(library: &Library) -> Result<()> {
    let directory = library.locks_dir();
    let path = directory.join(CACHE_EPOCH_FILE);
    let pending = directory.join("artwork-cache-epoch.pending");
    crate::path::refuse_symlink_ancestors(&path)?;
    crate::path::refuse_symlink_ancestors(&pending)?;
    if pending.exists() {
        crate::path::read_bounded_regular(&pending, EPOCH_BYTES)?;
        std::fs::remove_file(&pending)?;
    }
    crate::artwork_ingestion::write_staged_file(&pending, uuid::Uuid::new_v4().as_bytes())?;
    tempfile::TempPath::try_from_path(pending)?
        .persist(&path)
        .map_err(|error| PortcoveError::from(error.error))?;
    crate::durability::sync_publication(&directory)
}

pub(super) struct WorkBudget {
    active: Mutex<usize>,
    available: Condvar,
}

impl WorkBudget {
    pub(super) const fn new() -> Self {
        Self {
            active: Mutex::new(0),
            available: Condvar::new(),
        }
    }

    pub(super) fn try_acquire(&self) -> Result<WorkPermit<'_>> {
        self.acquire_until(Duration::ZERO)
    }

    pub(super) fn acquire_until(&self, wait: Duration) -> Result<WorkPermit<'_>> {
        let unavailable = |_| PortcoveError::state("artwork work budget is unavailable");
        let mut active = self.active.lock().map_err(unavailable)?;
        if *active == IGDB_ARTWORK_WORK_LIMIT && !wait.is_zero() {
            (active, _) = self
                .available
                .wait_timeout_while(active, wait, |active| *active == IGDB_ARTWORK_WORK_LIMIT)
                .map_err(|_| PortcoveError::state("artwork work budget is unavailable"))?;
        }
        if *active == IGDB_ARTWORK_WORK_LIMIT {
            return Err(PortcoveError::conflict(
                "artwork retrieval is busy; retry shortly",
            ));
        }
        *active += 1;
        Ok(WorkPermit(self))
    }
}

pub(crate) struct WorkPermit<'a>(&'a WorkBudget);

impl Drop for WorkPermit<'_> {
    fn drop(&mut self) {
        let mut active = self
            .0
            .active
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *active -= 1;
        self.0.available.notify_one();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disk_derivative_refuses_wrong_recipe_and_repairs_interrupted_publication() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let source = "1".repeat(64);
        let first = RemoteDerivative::new(&library, &source, "header:1280x720").unwrap();
        let other = RemoteDerivative::new(&library, &source, "logo:568x320").unwrap();
        let png = b"\x89PNG\r\n\x1a\nfixture";
        let original = library
            .root()
            .join("artwork-cache")
            .join(format!("{source}.image"));
        let lock = library.try_lock_artwork().unwrap();
        std::fs::create_dir_all(original.parent().unwrap()).unwrap();
        std::fs::write(&original, b"source bytes").unwrap();
        first.retain(&library, &original, png);
        assert_eq!(first.read().unwrap(), png);
        let size = std::fs::metadata(&first.path).unwrap().len();
        assert_eq!(
            RemoteDerivative::retained_source(&first.path, size).as_deref(),
            Some(source.as_str())
        );

        std::fs::copy(&first.path, &other.path).unwrap();
        assert!(other.read().is_none());
        std::fs::write(&first.path, b"partial").unwrap();
        assert!(first.read().is_none());
        let pending = first.path.with_file_name("pending-thumbnail");
        std::fs::write(&pending, b"partial").unwrap();
        first.retain(&library, &original, png);
        assert!(!pending.exists());
        drop(lock);

        let reopened = RemoteDerivative::new(&library, &source, "header:1280x720").unwrap();
        assert_eq!(reopened.read().unwrap(), png);

        let _lock = library.try_lock_artwork().unwrap();
        std::fs::remove_file(&original).unwrap();
        std::fs::remove_file(&first.path).unwrap();
        first.retain(&library, &original, png);
        assert!(!first.path.exists());
    }

    #[test]
    fn work_budget_refuses_excess_without_waiting_and_releases_permits() {
        let budget = WorkBudget::new();
        let mut held: Vec<_> = (0..IGDB_ARTWORK_WORK_LIMIT)
            .map(|_| budget.try_acquire().unwrap())
            .collect();
        assert!(
            matches!(budget.try_acquire(), Err(error) if error.code == crate::ErrorCode::Conflict)
        );
        drop(held.pop());
        let replacement = budget.try_acquire().unwrap();
        drop((held, replacement));
        assert_eq!(*budget.active.lock().unwrap(), 0);
    }

    #[test]
    fn cover_http_client_is_reused_across_requests() {
        let client = super::super::igdb_http_client()
            .map_err(|failure| failure.error)
            .unwrap();
        let next = super::super::igdb_http_client()
            .map_err(|failure| failure.error)
            .unwrap();
        assert!(std::ptr::eq(client, next));
    }
}
