use std::{fs, path::Path};

use crate::{PortcoveError, Result};

/// Flush a private sibling file before an atomic namespace publication.
/// Replacement is only for core-owned journals, never user export files.
pub(crate) fn write_json_atomically<T: serde::Serialize>(
    destination: &Path,
    value: &T,
    replace: bool,
) -> Result<()> {
    write_bytes_atomically(destination, &serde_json::to_vec_pretty(value)?, replace)
}

pub(crate) fn write_bytes_atomically(
    destination: &Path,
    bytes: &[u8],
    replace: bool,
) -> Result<()> {
    use std::io::Write;
    let parent = destination
        .parent()
        .ok_or_else(|| PortcoveError::usage("publication path has no parent"))?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    temporary.write_all(bytes)?;
    temporary.as_file().sync_all()?;
    let result = if replace {
        temporary.persist(destination)
    } else {
        temporary.persist_noclobber(destination)
    };
    result.map_err(|error| PortcoveError::from(error.error))?;
    sync_directory(parent)?;
    Ok(())
}

pub(crate) fn sync_publication(directory: &Path) -> Result<()> {
    sync_directory(directory).map_err(Into::into)
}

/// Flush the directory entries that make a staged backup reachable.
///
/// Linux is the only V1 host where Portcove makes this durability claim. A
/// filesystem may still decline directory synchronization, in which case the
/// caller retains process-level atomic publication without claiming power-loss
/// durability.
pub(crate) fn prepare_backup_publication(
    library_root: &Path,
    backups_root: &Path,
    backup_parent: &Path,
    staging_root: &Path,
) -> Result<bool> {
    #[cfg(target_os = "linux")]
    {
        for directory in [library_root, backups_root, backup_parent] {
            if !try_sync_directory(directory)? {
                return Ok(false);
            }
        }
        sync_directory_tree(staging_root)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (library_root, backups_root, backup_parent, staging_root);
        Ok(false)
    }
}

/// Publish a staged backup with a same-filesystem rename and, when supported,
/// synchronize the directory entry that makes it visible.
pub(crate) fn publish_backup_directory(
    staging_path: &Path,
    final_path: &Path,
    backup_parent: &Path,
    directory_sync: bool,
) -> Result<()> {
    if let Err(error) = fs::rename(staging_path, final_path) {
        let _ = fs::remove_dir_all(staging_path);
        return Err(error.into());
    }

    if directory_sync && let Err(sync_error) = sync_directory(backup_parent) {
        if let Err(rollback_error) = fs::rename(final_path, staging_path) {
            return Err(PortcoveError::state(format!(
                "backup publication could not synchronize its parent directory ({sync_error}) or roll back the visible snapshot ({rollback_error})"
            ))
            .detail("backup_path", final_path.display().to_string())
            .detail("staging_path", staging_path.display().to_string()));
        }
        let _ = fs::remove_dir_all(staging_path);
        return Err(sync_error.into());
    }

    Ok(())
}

#[cfg(target_os = "linux")]
fn sync_directory_tree(root: &Path) -> Result<bool> {
    let mut children = fs::read_dir(root)?.collect::<std::io::Result<Vec<_>>>()?;
    children.sort_by_key(|entry| entry.file_name());
    for child in children {
        if child.file_type()?.is_dir() && !sync_directory_tree(&child.path())? {
            return Ok(false);
        }
    }
    Ok(try_sync_directory(root)?)
}

#[cfg(target_os = "linux")]
fn try_sync_directory(path: &Path) -> std::io::Result<bool> {
    match sync_directory(path) {
        Ok(()) => Ok(true),
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::InvalidInput | std::io::ErrorKind::Unsupported
            ) =>
        {
            Ok(false)
        }
        Err(error) => Err(error),
    }
}

#[cfg(target_os = "linux")]
fn sync_directory(path: &Path) -> std::io::Result<()> {
    fs::File::open(path)?.sync_all()
}

#[cfg(not(target_os = "linux"))]
fn sync_directory(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backup_directory_durability_support_is_explicit_for_the_host() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path();
        let backups = root.join("backups");
        let parent = backups.join("sample");
        let staging = parent.join(".backup-staged");
        fs::create_dir_all(staging.join("data/nested")).unwrap();
        fs::write(staging.join("data/nested/save.dat"), b"save").unwrap();

        let supported = prepare_backup_publication(root, &backups, &parent, &staging).unwrap();

        #[cfg(target_os = "linux")]
        assert!(
            supported,
            "the CI/local Linux filesystem must accept directory synchronization"
        );
        #[cfg(not(target_os = "linux"))]
        assert!(
            !supported,
            "unsupported hosts must not imply directory durability"
        );
    }

    #[test]
    fn byte_publication_replaces_an_existing_file() {
        let temporary = tempfile::tempdir().unwrap();
        let destination = temporary.path().join("state.json");
        fs::write(&destination, b"old").unwrap();

        write_bytes_atomically(&destination, b"new", true).unwrap();

        assert_eq!(fs::read(destination).unwrap(), b"new");
    }
}
