//! User-scoped process lifetime coordination for application replacement.

use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};

use fs2::FileExt;

use crate::{PortcoveError, Result};

const APPLICATION_RUNTIME_LOCK_FILE: &str = ".application-runtime.lock";

/// Shared proof retained while a CLI or Desktop process may use any library.
#[derive(Debug)]
pub struct ApplicationRuntimeGuard {
    file: File,
    path: PathBuf,
}

/// Exclusive proof that no other CLI or Desktop process is using any library.
#[derive(Debug)]
pub struct ApplicationUpdateExclusivityGuard {
    file: File,
    path: PathBuf,
}

impl ApplicationRuntimeGuard {
    pub fn acquire(lock_path: &Path) -> Result<Self> {
        let (file, path) = open_lock(lock_path)?;
        FileExt::try_lock_shared(&file).map_err(|error| lock_error(error, &path))?;
        Ok(Self { file, path })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl ApplicationUpdateExclusivityGuard {
    pub fn acquire(lock_path: &Path) -> Result<Self> {
        let (file, path) = open_lock(lock_path)?;
        FileExt::try_lock_exclusive(&file).map_err(|error| lock_error(error, &path))?;
        Ok(Self { file, path })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for ApplicationRuntimeGuard {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.file);
    }
}

impl Drop for ApplicationUpdateExclusivityGuard {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.file);
    }
}

pub(crate) fn sibling_lock_path(preference_path: &Path) -> Result<PathBuf> {
    let parent = preference_path
        .parent()
        .ok_or_else(|| PortcoveError::usage("host preference path needs a parent directory"))?;
    Ok(parent.join(APPLICATION_RUNTIME_LOCK_FILE))
}

fn open_lock(lock_path: &Path) -> Result<(File, PathBuf)> {
    if !lock_path.is_absolute() || lock_path.file_name().is_none() {
        return Err(PortcoveError::usage(
            "application runtime lock path must name an absolute file",
        ));
    }
    let parent = lock_path.parent().ok_or_else(|| {
        PortcoveError::usage("application runtime lock path needs a parent directory")
    })?;
    crate::path::refuse_symlink_ancestors(parent)?;
    fs::create_dir_all(parent)?;
    crate::path::refuse_symlink_ancestors(parent)?;
    let canonical_parent = fs::canonicalize(parent)?;
    let path = canonical_parent.join(
        lock_path
            .file_name()
            .ok_or_else(|| PortcoveError::usage("application runtime lock path needs a file"))?,
    );
    if let Ok(metadata) = fs::symlink_metadata(&path)
        && (!metadata.is_file() || metadata.file_type().is_symlink())
    {
        return Err(PortcoveError::verification(
            "application runtime lock must be a regular file",
        ));
    }
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(PortcoveError::verification(
            "application runtime lock must be a regular file",
        ));
    }
    Ok((file, path))
}

fn lock_error(error: std::io::Error, path: &Path) -> PortcoveError {
    if error.kind() == fs2::lock_contended_error().kind() {
        PortcoveError::conflict("another Portcove process prevents application update replacement")
            .detail("application_runtime_lock", path.display().to_string())
    } else {
        error.into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ErrorCode;

    #[test]
    fn shared_processes_exclude_replacement_across_alternate_libraries() {
        let temporary = tempfile::tempdir().unwrap();
        let lock = temporary.path().join("host/.application-runtime.lock");
        let first = ApplicationRuntimeGuard::acquire(&lock).unwrap();
        let second = ApplicationRuntimeGuard::acquire(&lock).unwrap();
        assert_eq!(first.path(), second.path());

        let error = ApplicationUpdateExclusivityGuard::acquire(&lock).unwrap_err();
        assert_eq!(error.code, ErrorCode::Conflict);
        drop(first);
        assert!(ApplicationUpdateExclusivityGuard::acquire(&lock).is_err());
        drop(second);

        let replacement = ApplicationUpdateExclusivityGuard::acquire(&lock).unwrap();
        assert_eq!(replacement.path(), fs::canonicalize(&lock).unwrap());
        assert_eq!(
            ApplicationRuntimeGuard::acquire(replacement.path())
                .unwrap_err()
                .code,
            ErrorCode::Conflict
        );
        drop(replacement);
        ApplicationRuntimeGuard::acquire(&lock).unwrap();
    }

    #[test]
    fn distinct_user_scopes_do_not_block_each_other() {
        let temporary = tempfile::tempdir().unwrap();
        let first = temporary.path().join("one/runtime.lock");
        let second = temporary.path().join("two/runtime.lock");
        let _runtime = ApplicationRuntimeGuard::acquire(&first).unwrap();
        ApplicationUpdateExclusivityGuard::acquire(&second).unwrap();
    }
}
