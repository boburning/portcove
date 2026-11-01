//! Windows handle-bound custody primitives for settings. A move followed by
//! no-clobber publication has a pathname gap; these primitives do not promise
//! arbitrary external compare-and-swap or power-loss durability. The caller
//! must persist a checked Core operation before moving any original object.

use std::{
    fs::{File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    mem::{offset_of, size_of},
    os::windows::{
        ffi::OsStrExt,
        fs::{MetadataExt, OpenOptionsExt},
        io::AsRawHandle,
    },
    path::{Path, PathBuf},
};

use windows_sys::Win32::Storage::FileSystem::{
    DELETE, FILE_ATTRIBUTE_REPARSE_POINT, FILE_DISPOSITION_INFO, FILE_FLAG_BACKUP_SEMANTICS,
    FILE_FLAG_OPEN_REPARSE_POINT, FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_ID_INFO,
    FILE_RENAME_INFO, FILE_SHARE_READ, FILE_SHARE_WRITE, FileDispositionInfo, FileIdInfo,
    FileRenameInfo, GetFileInformationByHandleEx, SetFileInformationByHandle, WRITE_DAC,
};

use crate::{PortcoveError, Result};

mod security;

fn changed() -> PortcoveError {
    PortcoveError::conflict(
        "configuration object changed or cannot be exclusively held; preserve it and review again",
    )
}

pub(crate) fn physical_identity(file: &File) -> Result<String> {
    let mut information = FILE_ID_INFO::default();
    // SAFETY: initialized output has the exact Win32 buffer size and the
    // borrowed handle remains alive for the synchronous call.
    let succeeded = unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle() as _,
            FileIdInfo,
            std::ptr::from_mut(&mut information).cast(),
            size_of::<FILE_ID_INFO>() as u32,
        )
    };
    if succeeded == 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    if information.FileId.Identifier.iter().all(|byte| *byte == 0)
        || information
            .FileId
            .Identifier
            .iter()
            .all(|byte| *byte == 255)
    {
        return Err(changed());
    }
    Ok(format!(
        "win128:{:016x}:{}",
        information.VolumeSerialNumber,
        hex::encode(information.FileId.Identifier)
    ))
}

fn ordinary(file: &File, directory: bool) -> Result<()> {
    let metadata = file.metadata()?;
    if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || (directory && !metadata.is_dir())
        || (!directory && (!metadata.is_file() || crate::external_runtime::link_count(file)? != 1))
    {
        return Err(changed());
    }
    Ok(())
}

/// Pin each ancestor against pathname replacement, including ancestors above
/// the library/output root. Only local drive paths are supported by this v1.
fn pin_parents(parent: &Path) -> Result<Vec<File>> {
    crate::path::refuse_symlink_ancestors(parent)?;
    let canonical = std::fs::canonicalize(parent)?;
    if canonical != parent {
        return Err(changed());
    }
    let Some(std::path::Component::Prefix(prefix)) = canonical.components().next() else {
        return Err(changed());
    };
    if !matches!(
        prefix.kind(),
        std::path::Prefix::Disk(_) | std::path::Prefix::VerbatimDisk(_)
    ) {
        return Err(PortcoveError::unsupported(
            "settings changes require a supported local Windows drive",
        ));
    }
    let mut ancestors: Vec<_> = canonical.ancestors().collect();
    ancestors.reverse();
    let mut held = Vec::new();
    for path in ancestors {
        let file = OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)?;
        ordinary(&file, true)?;
        let current = crate::external_runtime::open_identity_handle(path)?;
        if !crate::external_runtime::same_file(&file, &current)? {
            return Err(changed());
        }
        held.push(file);
    }
    Ok(held)
}

pub(crate) struct HeldFile {
    pub(crate) file: File,
    pub(crate) path: PathBuf,
    pub(crate) identity: String,
    pub(crate) parent_identity: String,
    exclusive: bool,
    _parents: Vec<File>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StageCheckpoint {
    PartialWrite,
    BeforeFlush,
    Flushed,
}

impl HeldFile {
    pub(crate) fn open(path: &Path) -> Result<Self> {
        Self::open_existing(path, false)
    }

    pub(crate) fn open_stage(path: &Path) -> Result<Self> {
        Self::open_existing(path, true)
    }

    fn open_existing(path: &Path, writable: bool) -> Result<Self> {
        let parent = path.parent().ok_or_else(changed)?;
        let parents = pin_parents(parent)?;
        if !writable && std::fs::symlink_metadata(path)?.permissions().readonly() {
            return Err(PortcoveError::unsupported(
                "read-only configuration files cannot be edited",
            ));
        }
        let file = OpenOptions::new()
            .read(true)
            .access_mode(
                FILE_GENERIC_READ
                    | DELETE
                    | if writable {
                        FILE_GENERIC_WRITE | WRITE_DAC
                    } else {
                        0
                    },
            )
            .share_mode(if writable { 0 } else { FILE_SHARE_READ })
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)?;
        ordinary(&file, false)?;
        Self::from_held(path, file, parents, writable)
    }

    pub(crate) fn create_stage(path: &Path) -> Result<Self> {
        let parents = pin_parents(path.parent().ok_or_else(changed)?)?;
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .access_mode(FILE_GENERIC_READ | FILE_GENERIC_WRITE | DELETE | WRITE_DAC)
            .share_mode(0)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)?;
        ordinary(&file, false)?;
        Self::from_held(path, file, parents, true)
    }

    /// Caller has positively read back this physical identity from the durable
    /// Preparing journal. Only an exact existing postimage prefix can resume;
    /// unrelated bytes are never truncated or overwritten.
    pub(crate) fn fill_stage(
        &mut self,
        bytes: &[u8],
        checkpoint: &dyn Fn(StageCheckpoint) -> Result<()>,
    ) -> Result<()> {
        if bytes.len() as u64 > super::MAX_SETTINGS_BYTES {
            return Err(changed());
        }
        let prefix = self.bytes(super::MAX_SETTINGS_BYTES)?;
        if !bytes.starts_with(&prefix) {
            return Err(changed());
        }
        self.file.seek(SeekFrom::End(0))?;
        let remaining = &bytes[prefix.len()..];
        let split = remaining.len().div_ceil(2);
        self.file.write_all(&remaining[..split])?;
        checkpoint(StageCheckpoint::PartialWrite)?;
        self.file.write_all(&remaining[split..])?;
        checkpoint(StageCheckpoint::BeforeFlush)?;
        self.file.sync_all()?;
        checkpoint(StageCheckpoint::Flushed)?;
        if self.bytes(super::MAX_SETTINGS_BYTES)? != bytes {
            return Err(changed());
        }
        Ok(())
    }

    #[cfg(test)]
    fn stage(path: &Path, bytes: &[u8]) -> Result<Self> {
        let mut held = Self::create_stage(path)?;
        held.fill_stage(bytes, &|_| Ok(()))?;
        Ok(held)
    }

    fn from_held(path: &Path, file: File, parents: Vec<File>, exclusive: bool) -> Result<Self> {
        if !exclusive {
            let current = crate::external_runtime::open_identity_handle(path)?;
            if !crate::external_runtime::same_file(&file, &current)? {
                return Err(changed());
            }
        }
        let identity = physical_identity(&file)?;
        let parent_identity = physical_identity(parents.last().ok_or_else(changed)?)?;
        Ok(Self {
            file,
            path: path.into(),
            identity,
            parent_identity,
            exclusive,
            _parents: parents,
        })
    }

    pub(crate) fn bytes(&mut self, maximum: u64) -> Result<Vec<u8>> {
        if maximum > super::MAX_SETTINGS_BYTES || self.file.metadata()?.len() > maximum {
            return Err(changed());
        }
        ordinary(&self.file, false)?;
        let before = self.file.metadata()?;
        self.file.seek(SeekFrom::Start(0))?;
        let mut bytes = Vec::new();
        Read::by_ref(&mut self.file)
            .take(maximum + 1)
            .read_to_end(&mut bytes)?;
        let after = self.file.metadata()?;
        if bytes.len() as u64 > maximum
            || bytes.len() as u64 != before.len()
            || before.len() != after.len()
            || before.modified()? != after.modified()?
            || physical_identity(&self.file)? != self.identity
        {
            return Err(changed());
        }
        Ok(bytes)
    }

    /// Rename the held object into a vacant sibling name. This never replaces
    /// another pathname and never reopens the original for mutation.
    pub(crate) fn move_to(&mut self, destination: &Path) -> Result<()> {
        ordinary(&self.file, false)?;
        if self.path.parent() != destination.parent() {
            return Err(changed());
        }
        let units: Vec<u16> = destination.as_os_str().encode_wide().collect();
        if units.contains(&0) {
            return Err(changed());
        }
        let name_bytes = units.len().checked_mul(2).ok_or_else(changed)?;
        let length = offset_of!(FILE_RENAME_INFO, FileName)
            .checked_add(name_bytes)
            .ok_or_else(changed)?;
        let length_u32 = u32::try_from(length).map_err(|_| changed())?;
        // usize storage supplies the C structure's pointer alignment. Reserve
        // at least sizeof(struct), including its flexible-array first member.
        let capacity = length
            .max(size_of::<FILE_RENAME_INFO>())
            .div_ceil(size_of::<usize>());
        let mut buffer = vec![0usize; capacity];
        let information = buffer.as_mut_ptr().cast::<FILE_RENAME_INFO>();
        // SAFETY: buffer is zeroed/aligned and large enough for the complete
        // header plus all UTF-16 bytes. Source/destination do not overlap.
        unsafe {
            (*information).Anonymous.ReplaceIfExists = false;
            (*information).RootDirectory = std::ptr::null_mut();
            (*information).FileNameLength = name_bytes as u32;
            let name = buffer
                .as_mut_ptr()
                .cast::<u8>()
                .add(offset_of!(FILE_RENAME_INFO, FileName))
                .cast::<u16>();
            std::ptr::copy_nonoverlapping(units.as_ptr(), name, units.len());
        }
        // SAFETY: live borrowed handle, initialized bounded buffer and exact
        // FileRenameInfo layout. ReplaceIfExists is deliberately false.
        if unsafe {
            SetFileInformationByHandle(
                self.file.as_raw_handle() as _,
                FileRenameInfo,
                information.cast(),
                length_u32,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
        self.path = destination.into();
        if !self.exclusive {
            let current = crate::external_runtime::open_identity_handle(destination)?;
            if !crate::external_runtime::same_file(&self.file, &current)? {
                return Err(changed());
            }
        }
        Ok(())
    }

    /// Delete only this already-verified held object. No later pathname lookup
    /// can accidentally delete a replacement supplied by another writer.
    pub(crate) fn retire(self) -> Result<()> {
        ordinary(&self.file, false)?;
        let information = FILE_DISPOSITION_INFO { DeleteFile: true };
        // SAFETY: initialized structure and borrowed handle remain alive for
        // the synchronous call; DELETE access was acquired on this object.
        if unsafe {
            SetFileInformationByHandle(
                self.file.as_raw_handle() as _,
                FileDispositionInfo,
                std::ptr::from_ref(&information).cast(),
                size_of::<FILE_DISPOSITION_INFO>() as u32,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn held_config_refuses_writer_leaf_replacement_and_parent_replacement() {
        let temporary = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(temporary.path()).unwrap();
        let parent = root.join("config");
        fs::create_dir(&parent).unwrap();
        let path = parent.join("prefs.ini");
        fs::write(&path, b"ui_scale=1.0\n").unwrap();
        let mut held = HeldFile::open(&path).unwrap();
        assert!(OpenOptions::new().write(true).open(&path).is_err());
        assert!(fs::rename(&path, parent.join("replaced.ini")).is_err());
        assert!(fs::rename(&parent, root.join("renamed")).is_err());
        assert_eq!(held.bytes(1024).unwrap(), b"ui_scale=1.0\n");
        drop(held);
        fs::write(&path, b"ui_scale=1.25\n").unwrap();
        assert_eq!(
            HeldFile::open(&path).unwrap().bytes(1024).unwrap(),
            b"ui_scale=1.25\n"
        );
    }

    #[test]
    fn vacant_name_publication_preserves_intervening_foreign_config_and_old_preimage() {
        let temporary = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(temporary.path()).unwrap();
        let path = root.join("prefs.ini");
        let stage = root.join("owned.new");
        let backup = root.join("owned.old");
        fs::write(&path, b"old usable config").unwrap();
        let mut old = HeldFile::open(&path).unwrap();
        let mut replacement = HeldFile::stage(&stage, b"proposed config").unwrap();
        old.move_to(&backup).unwrap();
        fs::write(&path, b"intervening editor file").unwrap();
        assert!(replacement.move_to(&path).is_err());
        assert!(old.move_to(&path).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"intervening editor file");
        assert_eq!(old.bytes(1024).unwrap(), b"old usable config");
        assert_eq!(replacement.bytes(1024).unwrap(), b"proposed config");
        fs::remove_file(&path).unwrap();
        old.move_to(&path).unwrap();
        assert_eq!(old.bytes(1024).unwrap(), b"old usable config");
        replacement.retire().unwrap();
        assert!(!stage.exists());
    }

    #[test]
    fn publication_moves_the_same_held_object_and_retires_only_owned_backup() {
        let temporary = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(temporary.path()).unwrap();
        let path = root.join("prefs.json");
        let stage = root.join("owned.new");
        let backup = root.join("owned.old");
        fs::write(&path, b"old").unwrap();
        let mut original = HeldFile::open(&path).unwrap();
        let original_id = original.identity.clone();
        let mut replacement = HeldFile::stage(&stage, b"new").unwrap();
        let replacement_id = replacement.identity.clone();
        original.move_to(&backup).unwrap();
        replacement.move_to(&path).unwrap();
        assert_eq!(physical_identity(&original.file).unwrap(), original_id);
        assert_eq!(
            physical_identity(&replacement.file).unwrap(),
            replacement_id
        );
        assert_eq!(replacement.bytes(1024).unwrap(), b"new");
        assert_eq!(original.bytes(1024).unwrap(), b"old");
        original.retire().unwrap();
        assert!(!backup.exists());
        assert!(path.is_file());
    }

    #[test]
    fn hard_link_alias_and_preexisting_stage_are_refused_without_replacing_bytes() {
        let temporary = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(temporary.path()).unwrap();
        let path = root.join("prefs.ini");
        fs::write(&path, b"preserved").unwrap();
        fs::hard_link(&path, root.join("alias.ini")).unwrap();
        assert!(HeldFile::open(&path).is_err());
        assert!(HeldFile::stage(&path, b"overwrite").is_err());
        assert_eq!(fs::read(&path).unwrap(), b"preserved");
    }
}
