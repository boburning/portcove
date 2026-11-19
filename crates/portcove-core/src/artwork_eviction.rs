//! Removal of originals whose SteamGridDB images were confirmed withdrawn (#527
//! slice 2b). The eviction marker is committed first and is the authority for
//! every reader; deleting the files follows and is finished by later calls when
//! it is bounded, interrupted or refused. Callers hold the artwork lock.

use std::{fs, io, path::Path};

use crate::{Library, Result};

/// How many originals one check deletes while it holds the library, so a large
/// removal never keeps a library switch waiting; the rest are deferred.
pub(crate) const REMOVALS_PER_CHECK: usize = 32;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct RemovalCounts {
    /// Evicted assets whose files are now all gone.
    pub(crate) removed: u32,
    /// Left for a later call by the bound.
    pub(crate) deferred: u32,
    /// A file could not be deleted, usually because another program holds it.
    pub(crate) failed: u32,
}

/// Deletes a regular file without reading it. A missing file is already done;
/// a symlink or directory in its place is refused rather than followed.
fn remove_regular(path: &Path) -> io::Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() => fs::remove_file(path).map(|()| true),
        Ok(_) => Err(io::Error::other("not a regular file")),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

/// Whether any file of an evicted asset is still on disk.
fn has_files(library: &Library, id: &str) -> Result<bool> {
    Ok([
        crate::artwork::original_path(library, id)?,
        crate::artwork_ingestion::staging_path(library, id)?,
        crate::artwork::thumbnail_path(library, id)?,
    ]
    .iter()
    .any(|path| fs::symlink_metadata(path).is_ok()))
}

/// Deletes the original, staged copy and thumbnail of every evicted asset that
/// still has one, at most `limit` assets (`None` for all). Each asset's
/// thumbnail row goes with its files. Errors are counted, never returned, so a
/// held file cannot block the check or the caller that asked.
pub(crate) fn complete_pending_evictions(
    library: &Library,
    limit: Option<usize>,
) -> Result<RemovalCounts> {
    let connection = library.connection()?;
    let evicted = crate::artwork_store::evicted_assets(&connection)?;
    let mut counts = RemovalCounts::default();
    let mut attempted = 0;
    let mut removed_any = false;
    for (id, _) in evicted {
        if !has_files(library, &id)? {
            continue;
        }
        if limit.is_some_and(|limit| attempted >= limit) {
            counts.deferred += 1;
            continue;
        }
        attempted += 1;
        let mut failed = false;
        for path in [
            crate::artwork::original_path(library, &id)?,
            crate::artwork_ingestion::staging_path(library, &id)?,
            crate::artwork::thumbnail_path(library, &id)?,
        ] {
            match remove_regular(&path) {
                Ok(removed) => removed_any |= removed,
                Err(_) => failed = true,
            }
        }
        connection.execute(
            "DELETE FROM artwork_thumbnails WHERE asset_sha256=?1",
            [&id],
        )?;
        if failed {
            counts.failed += 1;
        } else {
            counts.removed += 1;
        }
    }
    if removed_any {
        // Best effort: the deletions already happened; durability is a bonus.
        for directory in ["artwork", "artwork-staging"] {
            let path = library.root().join(directory);
            if path.exists() {
                let _ = crate::durability::sync_publication(&path);
            }
        }
    }
    Ok(counts)
}

/// Before an export or move is reviewed: every pending removal is finished,
/// without the per-check bound, and a removed original that is still present
/// stops the transfer, because it must not travel.
pub(crate) fn prepare_transfer(library: &Library) -> Result<()> {
    // Most libraries have no removed copies; they never wait for the lock.
    if crate::artwork_store::evicted_assets(&library.connection()?)?.is_empty() {
        return Ok(());
    }
    // Thumbnails and handoffs take the artwork lock briefly and routinely.
    let mut attempts = 0;
    let _guard = loop {
        match library.try_lock_artwork() {
            Ok(guard) => break guard,
            Err(error) if error.code == crate::ErrorCode::Conflict && attempts < 8 => {
                attempts += 1;
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
            Err(error) => return Err(error),
        }
    };
    complete_pending_evictions(library, None)?;
    let present = present_evicted_originals(library)?;
    if present.is_empty() {
        return Ok(());
    }
    let count = present.len();
    let mut error = crate::PortcoveError::conflict(format!(
        "Portcove couldn't finish removing {count} {} that SteamGridDB no longer lists. Close any program that may be using Portcove's artwork folder, then try again.",
        if count == 1 { "image" } else { "images" }
    ));
    for (index, path) in present.iter().enumerate().take(8) {
        error = error.detail(format!("path_{index}"), path.display().to_string());
    }
    Err(error)
}

/// The paths of evicted originals still on disk, for a transfer that must not
/// carry them.
fn present_evicted_originals(library: &Library) -> Result<Vec<std::path::PathBuf>> {
    let connection = library.connection()?;
    let mut present = Vec::new();
    for (id, _) in crate::artwork_store::evicted_assets(&connection)? {
        let path = crate::artwork::original_path(library, &id)?;
        if fs::symlink_metadata(&path).is_ok() {
            present.push(path);
        }
    }
    Ok(present)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn regular_file_removal_tolerates_absence_and_refuses_other_kinds() {
        let temporary = tempfile::tempdir().unwrap();
        let file = temporary.path().join("original");
        fs::write(&file, b"bytes").unwrap();
        assert!(remove_regular(&file).unwrap());
        assert!(!remove_regular(&file).unwrap());
        let directory = temporary.path().join("directory");
        fs::create_dir(&directory).unwrap();
        assert!(remove_regular(&directory).is_err());
        assert!(directory.exists());
    }
}
