use std::{
    fs::{self, File, OpenOptions},
    path::Path,
};

use fs2::FileExt;

use crate::{PortcoveError, Result};

#[derive(Debug, Clone, Copy)]
pub(crate) enum LibraryAccess {
    Shared,
    Exclusive,
}

/// A library remains in use until its last clone and service are dropped.
#[derive(Debug)]
pub(crate) struct LibraryLease {
    file: File,
}

impl LibraryLease {
    pub(crate) fn acquire(root: &Path) -> Result<Self> {
        Self::with_access(root, LibraryAccess::Shared)
    }

    pub(crate) fn with_access(root: &Path, access: LibraryAccess) -> Result<Self> {
        let locks = root.join("locks");
        fs::create_dir_all(&locks)?;
        if fs::symlink_metadata(&locks)?.file_type().is_symlink() {
            return Err(PortcoveError::verification(
                "library locks directory must not be a symbolic link",
            ));
        }
        let path = locks.join("library.lock");
        if let Ok(metadata) = fs::symlink_metadata(&path)
            && (!metadata.is_file() || metadata.file_type().is_symlink())
        {
            return Err(PortcoveError::verification(
                "library lease must be a regular file",
            ));
        }
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(path)?;
        let lock = match access {
            LibraryAccess::Shared => FileExt::try_lock_shared(&file),
            LibraryAccess::Exclusive => FileExt::try_lock_exclusive(&file),
        };
        lock.map_err(|error| {
            if error.kind() == fs2::lock_contended_error().kind() {
                PortcoveError::conflict(
                    "the library is in use by another Portcove operation or process",
                )
                .detail("library_root", root.display().to_string())
            } else {
                error.into()
            }
        })?;
        Ok(Self { file })
    }
}

impl Drop for LibraryLease {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.file);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ErrorCode, Library};

    #[test]
    fn every_open_library_and_clone_retains_the_shared_lease() {
        let temporary = tempfile::tempdir().unwrap();
        let first = Library::open(temporary.path()).unwrap();
        let clone = first.clone();
        let second = Library::open(temporary.path()).unwrap();
        let exclusive = OpenOptions::new()
            .read(true)
            .write(true)
            .open(temporary.path().join("locks/library.lock"))
            .unwrap();
        assert!(FileExt::try_lock_exclusive(&exclusive).is_err());
        drop(first);
        drop(second);
        assert!(FileExt::try_lock_exclusive(&exclusive).is_err());
        drop(clone);
        FileExt::try_lock_exclusive(&exclusive).unwrap();
        assert_eq!(
            Library::open(temporary.path()).unwrap_err().code,
            ErrorCode::Conflict
        );
        FileExt::unlock(&exclusive).unwrap();
        Library::open(temporary.path()).unwrap();
    }
}
