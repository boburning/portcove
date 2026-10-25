//! Read-only recognition of closed shared write scopes. Never creates or owns them.
use crate::runtime_path_policy::require_narrow_windows_path;
#[cfg(any(windows, test))]
use std::fs;
use std::path::Path;

use crate::{
    ExternalRuntimeRecord, PortcoveError, PreparedSharedPreferencesContract, Result,
    SharedPreferencesReview, UserPreparedRuntimeSpec,
};

mod smb1r;

pub(crate) fn require_ack(
    preview: &super::ExternalRuntimePreview,
    acknowledged: Option<&str>,
) -> Result<()> {
    require_scoped_ack(
        preview.shared_preferences.is_some(),
        &preview.preview_sha256,
        acknowledged,
    )
}

pub(crate) fn require_scoped_ack(
    shared_preferences_present: bool,
    preview_sha256: &str,
    acknowledged: Option<&str>,
) -> Result<()> {
    match (shared_preferences_present, acknowledged) {
        (true, Some(value)) if value == preview_sha256 => Ok(()),
        (false, None) => Ok(()),
        _ => Err(PortcoveError::usage(
            "explicit acknowledgment of the reviewed shared preferences is required",
        )),
    }
}

pub(crate) fn validate(spec: &UserPreparedRuntimeSpec) -> Result<()> {
    if spec.shared_preferences == Some(PreparedSharedPreferencesContract::GbRecompiledWindowsV1) {
        return Err(PortcoveError::verification(
            "reviewed GB Recompiled preferences require a retained managed release",
        ));
    }
    if spec.shared_preferences == Some(PreparedSharedPreferencesContract::Smb1r11Windows) {
        return smb1r::validate(spec);
    }
    if spec.shared_preferences == Some(PreparedSharedPreferencesContract::Regaiden041Windows)
        && (spec.version != "0.4.1"
            || spec.archive_name != "Resident_Evil_Gaiden_Recomp_v0.4.1_Windows.zip"
            || spec.archive_size != 33_085_815
            || spec.executable != "Resident_Evil_Gaiden__USA_.exe"
            || spec.archive_sha256
                != "d16ba320c75a23765ef1e84c6f70f551612834914c70fd4c542e20ae7ce5dcc6"
            || spec.library_user_data
            || spec.source_argument_extension.as_deref() != Some("gbc")
            || !spec
                .mutable_paths
                .iter()
                .any(|path| path == "runtime_prefs.ini")
            || !spec.mutable_paths.iter().any(|path| path == "config.ini")
            || !spec.mutable_paths.iter().any(|path| path == "saves")
            || !spec.mutable_paths.iter().any(|path| path == "snapshots")
            || !spec.mutable_paths.iter().any(|path| path == "imgui.ini")
            || spec.mutable_paths.len() != 5
            || !spec.required_mutable_files.is_empty()
            || spec.settings_contract.is_some())
    {
        return Err(PortcoveError::verification(
            "shared preferences require the exact reviewed ReGaiden Windows artifact",
        ));
    }
    Ok(())
}

pub(crate) fn validate_route(
    port: &crate::PortDefinition,
    platform: crate::Platform,
    spec: &UserPreparedRuntimeSpec,
) -> Result<()> {
    let Some(contract) = spec.shared_preferences else {
        return Ok(());
    };
    let expected: &[&str] = match contract {
        PreparedSharedPreferencesContract::Regaiden041Windows => &["--save-dir", "saves"],
        PreparedSharedPreferencesContract::GbRecompiledWindowsV1 => {
            return Err(PortcoveError::verification(
                "managed preference policy cannot authorize an external route",
            ));
        }
        PreparedSharedPreferencesContract::Smb1r11Windows => &["--disable-mods"],
    };
    if platform != crate::Platform::WindowsX86_64
        || port.adapter != crate::AdapterKind::StagedSourcePortable
        || port.runtime_subdirectory.is_some()
        || (contract == PreparedSharedPreferencesContract::Smb1r11Windows
            && !port.launch_environment.is_empty())
        || port
            .launch_arguments
            .iter()
            .map(String::as_str)
            .ne(expected.iter().copied())
    {
        return Err(PortcoveError::usage(
            "shared write scope requires its exact Windows root launch route",
        ));
    }
    Ok(())
}

pub(crate) fn inspect(
    spec: &UserPreparedRuntimeSpec,
    runtime_root: &Path,
) -> Result<Option<SharedPreferencesReview>> {
    validate(spec)?;
    spec.shared_preferences
        .map(|contract| resolve(contract, runtime_root, true, "Resident_Evil_Gaiden__USA_"))
        .transpose()
}

/// Read-only preview for a future managed destination. Missing owned saves are
/// permitted here; the accepted installer creates them later in private staging.
pub(crate) fn inspect_managed(
    runtime_root: &Path,
    port: &crate::PortDefinition,
) -> Result<SharedPreferencesReview> {
    let contract = port
        .managed_shared_preferences
        .ok_or_else(|| PortcoveError::verification("managed preferences have no contract"))?;
    if !matches!(
        contract,
        PreparedSharedPreferencesContract::Regaiden041Windows
            | PreparedSharedPreferencesContract::GbRecompiledWindowsV1
    ) {
        return Err(PortcoveError::verification(
            "unsupported managed shared preference policy",
        ));
    }
    let save_identifier = if contract == PreparedSharedPreferencesContract::GbRecompiledWindowsV1 {
        // Upstream's generated main passes this ID independently of argv[0].
        // Retained catalog review, never an executable filename, owns the fact.
        port.managed_shared_preferences_save_id
            .as_deref()
            .ok_or_else(|| {
                PortcoveError::verification("managed preferences have no reviewed save identifier")
            })?
    } else {
        "Resident_Evil_Gaiden__USA_"
    };
    resolve(contract, runtime_root, false, save_identifier)
}

/// The selected artifact converts SDL UTF-8 paths into narrow Windows paths.
/// Until broader encoding support is proved, accept only the congruent subset.
pub(crate) fn check_runtime_path(spec: &UserPreparedRuntimeSpec, path: &Path) -> Result<()> {
    if spec.shared_preferences == Some(PreparedSharedPreferencesContract::Regaiden041Windows) {
        require_narrow_windows_path(path, "")?;
    }
    Ok(())
}

pub(super) fn check_tree_path(
    spec: &UserPreparedRuntimeSpec,
    path: &Path,
    directory: bool,
) -> Result<()> {
    if spec.shared_preferences.is_none() {
        return Ok(());
    }
    check_runtime_path(spec, path)?;
    #[cfg(any(windows, test))]
    {
        check_path(path, directory)?;
        Ok(())
    }
    #[cfg(not(any(windows, test)))]
    {
        let _ = directory;
        Err(PortcoveError::unsupported(
            "shared preferences require Windows",
        ))
    }
}

pub(crate) fn check_record(
    record: &ExternalRuntimeRecord,
    spec: &UserPreparedRuntimeSpec,
) -> Result<()> {
    check_binding(record, spec)?;
    let actual = inspect(spec, &record.path)?.map(|review| review.binding);
    if record.shared_preferences != actual {
        return Err(PortcoveError::conflict(
            "shared preferences account or location changed; review registration again",
        ));
    }
    Ok(())
}

pub(crate) fn original_ready(
    record: &ExternalRuntimeRecord,
    spec: &UserPreparedRuntimeSpec,
) -> Result<bool> {
    if spec.shared_preferences != Some(PreparedSharedPreferencesContract::Smb1r11Windows) {
        return Ok(true);
    }
    check_binding(record, spec)?;
    let binding = record
        .shared_preferences
        .as_ref()
        .ok_or_else(|| PortcoveError::verification("shared original has no accepted location"))?;
    smb1r::original_ready(spec, &binding.path)
}

pub(crate) fn require_original(
    record: &ExternalRuntimeRecord,
    spec: &UserPreparedRuntimeSpec,
) -> Result<()> {
    if !original_ready(record, spec)? {
        return Err(PortcoveError::verification(
            "SMB1R needs its recognized World original at the reviewed shared directory's baserom.nes; prepare this external file manually",
        ));
    }
    Ok(())
}

/// Structural consistency is also checked when retained metadata is read for
/// browsing. OS/account/path revalidation is reserved for readiness and launch.
pub(crate) fn check_binding(
    record: &ExternalRuntimeRecord,
    spec: &UserPreparedRuntimeSpec,
) -> Result<()> {
    if record
        .shared_preferences
        .as_ref()
        .map(|binding| binding.contract)
        != spec.shared_preferences
        || record.shared_preferences.as_ref().is_some_and(|binding| {
            binding.path.as_os_str().is_empty()
                || binding.account_sid_sha256.len() != 64
                || !binding
                    .account_sid_sha256
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit())
        })
    {
        return Err(PortcoveError::verification(
            "retained shared preferences consent is missing or inconsistent",
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
fn resolve(
    _contract: PreparedSharedPreferencesContract,
    _runtime_root: &Path,
    _require_saves: bool,
    _save_identifier: &str,
) -> Result<SharedPreferencesReview> {
    Err(PortcoveError::unsupported(
        "this shared preference contract requires Windows",
    ))
}

#[cfg(windows)]
fn resolve(
    contract: PreparedSharedPreferencesContract,
    runtime_root: &Path,
    require_saves: bool,
    save_identifier: &str,
) -> Result<SharedPreferencesReview> {
    if contract == PreparedSharedPreferencesContract::Smb1r11Windows {
        return smb1r::resolve();
    }
    use crate::AcceptedSharedPreferencesBinding;
    use std::{ffi::OsString, os::windows::ffi::OsStringExt};
    use windows_sys::Win32::UI::Shell::{CSIDL_APPDATA, SHGFP_TYPE_CURRENT, SHGetFolderPathW};
    let mut buffer = [0_u16; 260];
    // SAFETY: writable MAX_PATH buffer, no token/window override, and no CREATE
    // flag. This is SDL's OS folder resolution, independent of APPDATA overrides.
    let result = unsafe {
        SHGetFolderPathW(
            std::ptr::null_mut(),
            CSIDL_APPDATA as i32,
            std::ptr::null_mut(),
            SHGFP_TYPE_CURRENT as u32,
            buffer.as_mut_ptr(),
        )
    };
    if result < 0 {
        return Err(PortcoveError::state(
            "cannot resolve shared roaming preferences",
        ));
    }
    let end = buffer
        .iter()
        .position(|value| *value == 0)
        .ok_or_else(|| PortcoveError::verification("unterminated roaming directory"))?;
    if end == 0 {
        return Err(PortcoveError::verification("empty roaming directory"));
    }
    let raw = std::path::PathBuf::from(OsString::from_wide(&buffer[..end]));
    // This final-file bound is stricter than SDL's organization/application
    // directory bound and also leaves the terminating NUL inside MAX_PATH.
    require_narrow_windows_path(&raw, "\\gbrecompiled\\runtime\\runtime_prefs.ini")?;
    check_path(&raw, true)?;
    let root = fs::canonicalize(raw)?;
    let path = root
        .join("gbrecompiled")
        .join("runtime")
        .join("runtime_prefs.ini");
    require_narrow_windows_path(&path, "")?;
    let present = check_path(&path, false)?;
    let local_fallback_path = runtime_root.join("runtime_prefs.ini");
    // Leave room for ordinary save-state transaction names that do not exist
    // during review. The selected artifact uses this fixed save identifier.
    require_narrow_windows_path(
        runtime_root,
        &format!("\\saves\\{save_identifier}.state2147483647.tmp-v1"),
    )?;
    require_narrow_windows_path(&local_fallback_path, "")?;
    let local_fallback_present = check_path(&local_fallback_path, false)?;
    check_path(&runtime_root.join("config.ini"), false)?;
    check_path(&runtime_root.join("imgui.ini"), false)?;
    if !check_path(&runtime_root.join("saves"), true)? && require_saves {
        return Err(PortcoveError::verification(
            "this runtime requires an existing safe saves directory",
        ));
    }
    Ok(SharedPreferencesReview {
        binding: AcceptedSharedPreferencesBinding {
            contract,
            account_sid_sha256: account_sid_sha256()?,
            path,
        },
        present,
        local_fallback_path: Some(local_fallback_path),
        local_fallback_present,
    })
}

/// Missing game-owned components are allowed. Every existing ancestor is checked
/// without following a reparse leaf; the preference file must be single-link.
#[cfg(any(windows, test))]
fn check_path(path: &Path, directory: bool) -> Result<bool> {
    let mut present = false;
    for (index, candidate) in path.ancestors().enumerate() {
        let metadata = match fs::symlink_metadata(candidate) {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        let is_directory = index != 0 || directory;
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
            if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                return Err(PortcoveError::verification(
                    "shared preferences must not traverse reparse points",
                ));
            }
        }
        if metadata.file_type().is_symlink()
            || (is_directory && !metadata.is_dir())
            || (!is_directory && !metadata.is_file())
        {
            return Err(PortcoveError::verification(
                "shared preferences location has an unsafe type",
            ));
        }
        let canonical = fs::canonicalize(candidate)?;
        let handle = super::open_object(&canonical, is_directory)?;
        if !is_directory && super::link_count(&handle)? != 1 {
            return Err(PortcoveError::verification(
                "shared preferences must not be hard linked",
            ));
        }
        if index == 0 {
            present = true;
        }
    }
    Ok(present)
}

#[cfg(windows)]
fn account_sid_sha256() -> Result<String> {
    use sha2::{Digest, Sha256};
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows_sys::Win32::{
        Security::{
            GetLengthSid, GetTokenInformation, IsValidSid, TOKEN_QUERY, TOKEN_USER, TokenUser,
        },
        System::Threading::{GetCurrentProcess, OpenProcessToken},
    };
    let mut raw_token = std::ptr::null_mut();
    // SAFETY: valid output pointer and the current process pseudo handle. The
    // returned token is query-only and receives exactly one OwnedHandle owner.
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw_token) } == 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    let token = unsafe { OwnedHandle::from_raw_handle(raw_token) };
    // Aligned fixed storage bounds TOKEN_USER and the maximum Windows SID.
    let mut storage = [0_usize; 128];
    let mut length = 0_u32;
    // SAFETY: aligned writable storage and the borrowed query token remain alive.
    // No impersonation or token mutation is requested.
    let success = unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            TokenUser,
            storage.as_mut_ptr().cast(),
            std::mem::size_of_val(&storage) as u32,
            &mut length,
        )
    };
    if success == 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    if length as usize > std::mem::size_of_val(&storage)
        || (length as usize) < std::mem::size_of::<TOKEN_USER>()
    {
        return Err(PortcoveError::verification("invalid account token size"));
    }
    // SAFETY: the OS initialized a complete TOKEN_USER in aligned storage.
    let sid = unsafe { (&*storage.as_ptr().cast::<TOKEN_USER>()).User.Sid };
    let start = storage.as_ptr() as usize;
    let address = sid as usize;
    if address < start
        || address
            .checked_add(8)
            .is_none_or(|end| end > start + length as usize)
    {
        return Err(PortcoveError::verification("invalid account SID location"));
    }
    // SAFETY: SID header is within the returned OS buffer; check its subauthority
    // count before asking Windows to inspect the complete variable-length SID.
    let count = unsafe { *sid.cast::<u8>().add(1) } as usize;
    let sid_bytes = 8 + count * 4;
    if count > 15
        || address + sid_bytes > start + length as usize
        || unsafe { IsValidSid(sid) } == 0
        || unsafe { GetLengthSid(sid) } as usize != sid_bytes
    {
        return Err(PortcoveError::verification("invalid account SID"));
    }
    // SAFETY: the complete validated SID remains within the live storage.
    Ok(hex::encode(Sha256::digest(unsafe {
        std::slice::from_raw_parts(sid.cast::<u8>(), sid_bytes)
    })))
}

#[cfg(test)]
#[path = "shared_preferences_tests.rs"]
mod tests;
