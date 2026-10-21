//! One export's private staging ownership. A moved/replaced destination must
//! never redirect cleanup into another directory or replace a user's file.

#[cfg(not(unix))]
use std::fs;
use std::{
    ffi::OsString,
    fs::File,
    path::{Path, PathBuf},
};

use crate::{
    PortcoveError, Result,
    external_runtime::{open_identity_handle, same_file},
};

pub(crate) struct SupportStage {
    directory: PathBuf,
    parent: File,
    name: OsString,
    identity: File,
    published: bool,
    // Windows has no Rust std directory-relative rename/unlink. Refuse deletion
    // or replacement of every ancestor while path-based operations own it.
    #[cfg(windows)]
    _parents: Vec<File>,
}

impl SupportStage {
    pub(crate) fn new(directory: &Path) -> Result<(Self, File)> {
        crate::path::refuse_symlink_ancestors(directory)?;
        #[cfg(windows)]
        let parents = hold_windows_parents(directory)?;
        let parent = open_identity_handle(directory)?;
        if !parent.metadata()?.is_dir() {
            return Err(PortcoveError::verification(
                "support destination is not a directory",
            ));
        }
        let name: OsString = format!(".portcove-support-{}.tmp", uuid::Uuid::new_v4()).into();
        #[cfg(unix)]
        let file = File::from(
            rustix::fs::openat(
                &parent,
                &name,
                rustix::fs::OFlags::RDWR
                    | rustix::fs::OFlags::CREATE
                    | rustix::fs::OFlags::EXCL
                    | rustix::fs::OFlags::NOFOLLOW
                    | rustix::fs::OFlags::CLOEXEC,
                rustix::fs::Mode::RUSR | rustix::fs::Mode::WUSR,
            )
            .map_err(std::io::Error::from)?,
        );
        #[cfg(not(unix))]
        let file = File::options()
            .read(true)
            .write(true)
            .create_new(true)
            .open(directory.join(&name))?;
        let stage = Self {
            directory: directory.into(),
            parent,
            name,
            identity: file.try_clone()?,
            published: false,
            #[cfg(windows)]
            _parents: parents,
        };
        stage.check_directory()?;
        Ok((stage, file))
    }

    fn check_directory(&self) -> Result<()> {
        crate::path::refuse_symlink_ancestors(&self.directory)?;
        let current = open_identity_handle(&self.directory)?;
        if !same_file(&self.parent, &current)? {
            return Err(PortcoveError::verification(
                "support destination changed during export",
            ));
        }
        Ok(())
    }

    fn check_staging(&self) -> Result<()> {
        #[cfg(unix)]
        let current = File::from(
            rustix::fs::openat(
                &self.parent,
                &self.name,
                rustix::fs::OFlags::RDONLY
                    | rustix::fs::OFlags::NOFOLLOW
                    | rustix::fs::OFlags::NONBLOCK
                    | rustix::fs::OFlags::CLOEXEC,
                rustix::fs::Mode::empty(),
            )
            .map_err(std::io::Error::from)?,
        );
        #[cfg(not(unix))]
        let current = {
            self.check_directory()?;
            open_identity_handle(&self.directory.join(&self.name))?
        };
        if !current.metadata()?.is_file()
            || crate::external_runtime::link_count(&current)? != 1
            || !same_file(&self.identity, &current)?
        {
            return Err(PortcoveError::verification(
                "support staging ownership changed",
            ));
        }
        Ok(())
    }

    pub(crate) fn publish(&mut self, output: &Path) -> Result<()> {
        self.check_directory()?;
        self.check_staging()?;
        if output.parent() != Some(self.directory.as_path()) {
            return Err(PortcoveError::usage(
                "support publication must remain in its owned directory",
            ));
        }
        #[cfg(unix)]
        rustix::fs::renameat_with(
            &self.parent,
            &self.name,
            &self.parent,
            output
                .file_name()
                .ok_or_else(|| PortcoveError::usage("support publication has no filename"))?,
            rustix::fs::RenameFlags::NOREPLACE,
        )
        .map_err(std::io::Error::from)?;
        #[cfg(not(unix))]
        crate::durability::rename_noreplace(&self.directory.join(&self.name), output)?;
        self.published = true;
        Ok(())
    }
}

impl Drop for SupportStage {
    fn drop(&mut self) {
        if self.published || self.check_staging().is_err() {
            return;
        }
        // On Unix even a renamed parent stays bound to the held directory.
        // On Windows the held ancestors prevent path replacement. If identity
        // or cleanup is unavailable, leave the private file; never broaden it.
        #[cfg(unix)]
        let _ = rustix::fs::unlinkat(&self.parent, &self.name, rustix::fs::AtFlags::empty());
        #[cfg(not(unix))]
        let _ = fs::remove_file(self.directory.join(&self.name));
    }
}

#[cfg(windows)]
fn hold_windows_parents(directory: &Path) -> Result<Vec<File>> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ, FILE_SHARE_WRITE,
    };
    let mut held = Vec::new();
    for parent in directory.ancestors() {
        let file = fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(parent)?;
        if !file.metadata()?.is_dir() {
            return Err(PortcoveError::verification(
                "support destination ancestor is not a directory",
            ));
        }
        held.push(file);
    }
    crate::path::refuse_symlink_ancestors(directory)?;
    Ok(held)
}
