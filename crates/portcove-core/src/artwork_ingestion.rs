use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

use crate::{Library, LocalArtworkAsset, PortcoveError, Result};

pub(crate) fn staging_path(library: &Library, id: &str) -> Result<PathBuf> {
    crate::artwork_store::validate_hash(id)?;
    let path = library.root().join("artwork-staging").join(id);
    crate::path::refuse_symlink_ancestors(&path)?;
    Ok(path)
}

/// The inventory reservation precedes this fixed path. Repeated process crashes
/// cannot accumulate random temporary files for the same reserved image.
pub(crate) fn publish_original(
    library: &Library,
    id: &str,
    destination: &Path,
    bytes: &[u8],
) -> Result<()> {
    let staged = staging_path(library, id)?;
    if staged.exists() {
        let partial = crate::path::read_bounded_regular(&staged, bytes.len() as u64)?;
        if !bytes.starts_with(&partial) {
            return Err(PortcoveError::verification(
                "incomplete artwork differs from the selected image; it was retained for explicit unused-image removal",
            ));
        }
        fs::remove_file(&staged)?;
    }
    write_staged_file(&staged, bytes)?;
    crate::path::refuse_symlink_ancestors(destination)?;
    crate::durability::rename_noreplace(&staged, destination)?;
    crate::durability::sync_publication(&library.root().join("artwork"))?;
    crate::durability::sync_publication(&library.root().join("artwork-staging"))
}

pub(crate) fn write_staged_file(path: &Path, bytes: &[u8]) -> Result<()> {
    crate::path::refuse_symlink_ancestors(path)?;
    let parent = path
        .parent()
        .ok_or_else(|| PortcoveError::state("artwork staging needs a parent"))?;
    fs::create_dir_all(parent)?;
    crate::path::refuse_symlink_ancestors(path)?;
    let mut file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    if crate::path::read_bounded_regular(path, bytes.len() as u64)? != bytes {
        return Err(PortcoveError::verification(
            "staged artwork changed before publication",
        ));
    }
    Ok(())
}

/// Explicit retirement also discards the tracked incomplete copy. Published
/// originals keep their separate digest check; outside source files are untouched.
pub(crate) fn remove_staged_original(library: &Library, asset: &LocalArtworkAsset) -> Result<()> {
    let staged = staging_path(library, &asset.sha256)?;
    if staged.exists() {
        crate::path::read_bounded_regular(&staged, asset.byte_size)?;
        fs::remove_file(staged)?;
        crate::durability::sync_publication(&library.root().join("artwork-staging"))?;
    }
    Ok(())
}
