//! Windows may create this legacy cache junction in the private build profile.
//! Its list-directory deny ACL can prevent recursive cleanup. Unlink only the
//! exact owned junction; never enumerate it, follow its target or change ACLs.
use crate::{PortcoveError, Result};
use std::{fs, os::windows::fs::MetadataExt, path::Path};

pub(crate) const CACHE: &str = "cartridge-build/home/AppData/Local/Microsoft/Windows/INetCache";

/// Caller must validate CVLoD staging ownership/phase and hold
/// durable Some(true) builder quiescence before allowing this exception.
pub(crate) fn unlink_private_wininet_junction(staging: &Path) -> Result<()> {
    let cache = staging.join(CACHE);
    crate::path::refuse_symlink_ancestors(&cache)?;
    let link = cache.join("Content.IE5");
    let metadata = match fs::symlink_metadata(&link) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    if metadata.file_attributes() & 0x400 == 0 {
        return Ok(());
    }
    // Open the reparse entry itself with no data/list access. The Windows-created
    // deny-list ACL permits this metadata query and nonrecursive deletion.
    use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_ATTRIBUTE_TAG_INFO, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        FileAttributeTagInfo, GetFileInformationByHandleEx,
    };
    let handle = fs::OpenOptions::new()
        .access_mode(0)
        .share_mode(7)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
        .open(&link)?;
    let mut information = FILE_ATTRIBUTE_TAG_INFO::default();
    // SAFETY: output has the exact API layout and size; handle remains alive.
    let succeeded = unsafe {
        GetFileInformationByHandleEx(
            handle.as_raw_handle() as _,
            FileAttributeTagInfo,
            std::ptr::from_mut(&mut information).cast(),
            std::mem::size_of::<FILE_ATTRIBUTE_TAG_INFO>() as u32,
        )
    };
    if succeeded == 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    // IO_REPARSE_TAG_MOUNT_POINT: refuse symbolic links and other reparse types.
    if information.ReparseTag != 0xa000_0003
        || normalized_target(&fs::read_link(&link)?)? != normalized_target(&cache.join("IE"))?
    {
        return Err(PortcoveError::conflict(
            "CVLoD private cache junction changed identity; retain preparation",
        ));
    }
    // RemoveDirectory unlinks the junction entry without visiting target files.
    fs::remove_dir(link)?;
    Ok(())
}

fn normalized_target(path: &Path) -> Result<String> {
    if !path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                std::path::Component::ParentDir | std::path::Component::CurDir
            )
        })
    {
        return Err(PortcoveError::conflict("unexpected private cache target"));
    }
    let text = crate::path::unicode(path, "private cache target")?;
    // Pure spelling comparison, without canonicalization or target traversal.
    Ok(text
        .strip_prefix(r"\\?\")
        .unwrap_or(&text)
        .replace('\\', "/")
        .to_ascii_lowercase())
}

/// Published cleanup has a different journal shape from cancellation. Validate
/// that shape before reusing the same single-entry Windows cache exception.
pub(crate) fn unlink_published_private_wininet_junction(
    library: &crate::Library,
    operation: &crate::operation::LifecycleOperation,
    staging: &Path,
) -> Result<()> {
    use crate::operation::{LifecycleOperationKind, LifecyclePhase};
    let install = operation.install.as_ref().ok_or_else(|| {
        PortcoveError::conflict("published CVLoD cleanup requires its install record")
    })?;
    if operation.port_id != "cvlod-recomp"
        || operation.kind != LifecycleOperationKind::Install
        || !matches!(
            operation.phase,
            LifecyclePhase::MetadataCommitted | LifecyclePhase::CleanupPending
        )
        || operation.preparation_process_quiesced != Some(true)
        || operation.paths.staging.as_deref() != Some(staging)
        || install.id != operation.id
        || install.port_id != operation.port_id
        || operation.paths.final_path.as_ref() != Some(&install.path)
    {
        return Err(PortcoveError::conflict(
            "published CVLoD cleanup ownership or builder quiescence is unproven",
        ));
    }
    crate::output_root::validate_staging_path(library, &operation.port_id, &operation.id, staging)?;
    crate::output_root::validate_install_path(library, &operation.port_id, &install.path)?;
    let connection = crate::database::connect(library.root())?;
    let committed = crate::Library::install_by_id(&connection, Some(&install.id))?
        .ok_or_else(|| PortcoveError::conflict("published CVLoD install is not committed"))?;
    if serde_json::to_value(&committed)? != serde_json::to_value(install)? {
        return Err(PortcoveError::conflict(
            "published CVLoD install differs from committed metadata",
        ));
    }
    unlink_private_wininet_junction(staging)
}
