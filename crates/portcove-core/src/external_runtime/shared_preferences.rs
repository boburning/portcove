//! Read-only recognition of one shared preference scope. Never creates or owns it.
#[cfg(any(windows, test))]
use std::fs;
use std::path::Path;

use crate::{
    ExternalRuntimeRecord, PortcoveError, PreparedSharedPreferencesContract, Result,
    SharedPreferencesReview, UserPreparedRuntimeSpec,
};

pub(crate) fn require_ack(
    preview: &super::ExternalRuntimePreview,
    acknowledged: Option<&str>,
) -> Result<()> {
    match (preview.shared_preferences.is_some(), acknowledged) {
        (true, Some(value)) if value == preview.preview_sha256 => Ok(()),
        (false, None) => Ok(()),
        _ => Err(PortcoveError::usage(
            "explicit acknowledgment of the reviewed shared preferences is required",
        )),
    }
}

pub(crate) fn validate(spec: &UserPreparedRuntimeSpec) -> Result<()> {
    if spec.shared_preferences.is_some()
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
            || spec.mutable_paths.len() != 4
            || !spec.required_mutable_files.is_empty()
            || spec.settings_contract.is_some())
    {
        return Err(PortcoveError::verification(
            "shared preferences require the exact reviewed ReGaiden Windows artifact",
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
        .map(|contract| resolve(contract, runtime_root))
        .transpose()
}

/// The selected artifact converts SDL UTF-8 paths into narrow Windows paths.
/// Until broader encoding support is proved, accept only the congruent subset.
pub(crate) fn check_runtime_path(spec: &UserPreparedRuntimeSpec, path: &Path) -> Result<()> {
    if spec.shared_preferences.is_some() {
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
    require_narrow_windows_path(path, "")?;
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

fn require_narrow_windows_path(path: &Path, suffix: &str) -> Result<()> {
    let text = path.to_str().ok_or_else(|| {
        PortcoveError::unsupported("this runtime requires a printable ASCII Windows path")
    })?;
    let ordinary = text.strip_prefix("\\\\?\\").unwrap_or(text);
    let length = if text.starts_with("\\\\?\\UNC\\") {
        ordinary.len().saturating_sub(2)
    } else {
        ordinary.len()
    };
    if ordinary.is_empty()
        || !ordinary.bytes().all(|byte| (32..127).contains(&byte))
        || length.saturating_add(suffix.len()) >= 260
    {
        return Err(PortcoveError::unsupported(
            "this exact runtime requires printable ASCII Windows paths shorter than MAX_PATH",
        ));
    }
    Ok(())
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
) -> Result<SharedPreferencesReview> {
    Err(PortcoveError::unsupported(
        "this shared preference contract requires Windows",
    ))
}

#[cfg(windows)]
fn resolve(
    contract: PreparedSharedPreferencesContract,
    runtime_root: &Path,
) -> Result<SharedPreferencesReview> {
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
        "\\saves\\Resident_Evil_Gaiden__USA_.state2147483647.tmp-v1",
    )?;
    require_narrow_windows_path(&local_fallback_path, "")?;
    let local_fallback_present = check_path(&local_fallback_path, false)?;
    check_path(&runtime_root.join("config.ini"), false)?;
    if !check_path(&runtime_root.join("saves"), true)? {
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
        local_fallback_path,
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
mod tests {
    use super::*;
    #[test]
    fn narrow_windows_paths_refuse_encoding_control_and_max_path_boundaries() {
        for path in ["", "C:\\caf\u{e9}", "C:\\game\nfile", "C:\\game\u{0}file"] {
            assert!(require_narrow_windows_path(Path::new(path), "").is_err());
        }
        assert!(require_narrow_windows_path(Path::new(&"a".repeat(259)), "").is_ok());
        assert!(require_narrow_windows_path(Path::new(&"a".repeat(260)), "").is_err());
        assert!(
            require_narrow_windows_path(Path::new(&format!("\\\\?\\{}", "a".repeat(259))), "")
                .is_ok()
        );
        assert!(require_narrow_windows_path(Path::new(&"a".repeat(258)), "ab").is_err());
    }
    #[test]
    fn retained_shared_scope_requires_binding_and_refuses_unknown_semantics() {
        let spec: UserPreparedRuntimeSpec = serde_json::from_value(serde_json::json!({
            "version":"0.4.1", "archive_name":"Resident_Evil_Gaiden_Recomp_v0.4.1_Windows.zip",
            "archive_size":33085815, "archive_sha256":"d16ba320c75a23765ef1e84c6f70f551612834914c70fd4c542e20ae7ce5dcc6",
            "executable":"Resident_Evil_Gaiden__USA_.exe", "immutable_tree_sha256":"a".repeat(64),
            "shared_preferences":"regaiden041-windows", "source_argument_extension":"gbc",
            "mutable_paths":["runtime_prefs.ini", "config.ini", "saves", "snapshots"]
        })).unwrap();
        validate(&spec).unwrap();
        let mut wrong_artifact = spec.clone();
        wrong_artifact.archive_sha256 = "f".repeat(64);
        assert!(validate(&wrong_artifact).is_err());
        wrong_artifact = spec.clone();
        wrong_artifact.executable = "other.exe".into();
        assert!(validate(&wrong_artifact).is_err());
        let mut record: ExternalRuntimeRecord = serde_json::from_value(serde_json::json!({
            "id":"fixture", "port_id":"fixture", "path":"external", "executable":"fixture.exe",
            "version":"0.4.1", "platform":"windows-x86-64", "archive_sha256":"a".repeat(64),
            "immutable_tree_sha256":"b".repeat(64), "registered_at":1
        }))
        .unwrap();
        assert!(check_binding(&record, &spec).is_err());
        record.shared_preferences = Some(crate::AcceptedSharedPreferencesBinding {
            contract: PreparedSharedPreferencesContract::Regaiden041Windows,
            account_sid_sha256: "c".repeat(64),
            path: "shared-fixture".into(),
        });
        check_binding(&record, &spec).unwrap();
        let mut legacy = spec.clone();
        legacy.shared_preferences = None;
        assert!(check_binding(&record, &legacy).is_err());
        record
            .shared_preferences
            .as_mut()
            .unwrap()
            .account_sid_sha256 = "unrecognized-account".into();
        assert!(check_binding(&record, &spec).is_err());
        let mut unknown = serde_json::to_value(&spec).unwrap();
        unknown["shared_preferences"] = "arbitrary-shared-path".into();
        assert!(serde_json::from_value::<UserPreparedRuntimeSpec>(unknown).is_err());
    }
    #[test]
    fn generic_confirmation_and_stale_ack_cannot_accept_shared_scope() {
        let mut preview = crate::ExternalRuntimePreview {
            port_id: "scope-probe".into(),
            path: "external".into(),
            executable: "game.exe".into(),
            version: "0.4.1".into(),
            archive_sha256: "a".repeat(64),
            immutable_tree_sha256: "b".repeat(64),
            immutable_file_count: 1,
            preview_sha256: "c".repeat(64),
            shared_preferences: Some(crate::SharedPreferencesReview {
                binding: crate::AcceptedSharedPreferencesBinding {
                    contract: crate::PreparedSharedPreferencesContract::Regaiden041Windows,
                    account_sid_sha256: "d".repeat(64),
                    path: "shared-preferences".into(),
                },
                present: false,
                local_fallback_path: "external/runtime_prefs.ini".into(),
                local_fallback_present: false,
            }),
        };
        assert!(require_ack(&preview, None).is_err());
        assert!(require_ack(&preview, Some(&"e".repeat(64))).is_err());
        assert!(require_ack(&preview, Some(&preview.preview_sha256)).is_ok());
        preview.shared_preferences = None;
        assert!(require_ack(&preview, None).is_ok());
        assert!(require_ack(&preview, Some(&preview.preview_sha256)).is_err());
    }
    #[test]
    fn missing_shared_data_is_not_created_and_ordinary_edits_are_allowed() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("runtime").join("runtime_prefs.ini");
        assert!(!check_path(&file, false).unwrap());
        assert!(!file.parent().unwrap().exists());
        fs::create_dir(file.parent().unwrap()).unwrap();
        fs::write(&file, b"audio=1").unwrap();
        assert!(check_path(&file, false).unwrap());
        fs::write(&file, b"audio=0\nunknown=player-owned").unwrap();
        assert!(check_path(&file, false).unwrap());
        assert_eq!(fs::read(&file).unwrap(), b"audio=0\nunknown=player-owned");
    }
    #[test]
    fn shared_data_refuses_file_ancestors_directories_and_hard_links() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("runtime_prefs.ini");
        fs::create_dir(&file).unwrap();
        assert!(check_path(&file, false).is_err());
        fs::remove_dir(&file).unwrap();
        fs::write(&file, b"data").unwrap();
        assert!(check_path(&file.join("child"), false).is_err());
        fs::hard_link(&file, root.path().join("alias")).unwrap();
        assert!(check_path(&file, false).is_err());
    }
}
