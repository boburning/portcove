//! Explicit user execution intent, independent of curated package admission.
//! Paths are observed without adopting, copying or inventorying the external tree.
use super::*;
use crate::{ExternalRuntimeTrust, UserSelectedLaunch};

fn checked_paths(
    executable: &Path,
    working_directory: &Path,
    library: &Path,
) -> Result<(PathBuf, PathBuf)> {
    if !executable.is_absolute() || !working_directory.is_absolute() {
        return Err(PortcoveError::usage(
            "choose an absolute executable and working directory",
        ));
    }
    for path in [executable, working_directory] {
        crate::path::unicode(path, "user-selected runtime path")?;
        crate::path::refuse_symlink_ancestors(path)?;
    }
    let executable = fs::canonicalize(executable)?;
    let working_directory = fs::canonicalize(working_directory)?;
    let library = fs::canonicalize(library)?;
    if !fs::symlink_metadata(&working_directory)?.is_dir()
        || [executable.as_path(), working_directory.as_path()]
            .iter()
            .any(|path| path.starts_with(&library))
        || library.starts_with(&working_directory)
    {
        return Err(PortcoveError::usage(
            "select an installation outside the Portcove library",
        ));
    }
    let mut file = super::open_single_link_file(&executable)?;
    let mut magic = [0_u8; 4];
    file.read_exact(&mut magic)
        .map_err(|_| PortcoveError::verification("selected file is not a native executable"))?;
    #[cfg(windows)]
    let native = magic.starts_with(b"MZ")
        && executable
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("exe"));
    #[cfg(target_os = "linux")]
    let native = magic == *b"\x7fELF";
    #[cfg(target_os = "macos")]
    let native = matches!(
        magic,
        [0xfe, 0xed, 0xfa, 0xce]
            | [0xce, 0xfa, 0xed, 0xfe]
            | [0xfe, 0xed, 0xfa, 0xcf]
            | [0xcf, 0xfa, 0xed, 0xfe]
            | [0xca, 0xfe, 0xba, 0xbe]
            | [0xbe, 0xba, 0xfe, 0xca]
    );
    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
    let native = false;
    if !native {
        return Err(PortcoveError::verification(
            "select a native game executable or native upstream launcher; scripts are not supported",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if file.metadata()?.permissions().mode() & 0o111 == 0 {
            return Err(PortcoveError::verification(
                "selected executable has no execute permission",
            ));
        }
    }
    Ok((executable, working_directory))
}

pub(crate) fn validate_arguments(arguments: &[String]) -> Result<()> {
    if arguments.len() > 64
        || arguments.iter().map(String::len).sum::<usize>() > 32 * 1024
        || arguments.iter().any(|argument| argument.contains('\0'))
    {
        return Err(PortcoveError::usage(
            "selected launch arguments exceed the supported bound or contain NUL",
        ));
    }
    Ok(())
}

pub(crate) fn preview(
    listing: &crate::PortListing,
    executable: &Path,
    working_directory: &Path,
    arguments: &[String],
    library: &Path,
    checkpoint: &dyn Fn() -> Result<()>,
) -> Result<ExternalRuntimePreview> {
    checkpoint()?;
    validate_arguments(arguments)?;
    let (executable, path) = checked_paths(executable, working_directory, library)?;
    // This local digest binds review to registration only. It is never an
    // official artifact identity and is not a permanent immutable-tree promise.
    let executable_digest = super::hash_stable_regular(&executable, MAX_FILE_BYTES, checkpoint)?;
    checkpoint()?;
    let preview_sha256 = hex::encode(Sha256::digest(serde_json::to_vec(&(
        "portcove-user-selected-v1",
        listing,
        &executable,
        &path,
        arguments,
        executable_digest,
    ))?));
    Ok(ExternalRuntimePreview {
        user_selected: Some(UserSelectedLaunch {
            arguments: arguments.to_vec(),
        }),
        port_id: listing.id.clone(),
        path,
        executable,
        version: "user-managed".into(),
        archive_sha256: String::new(),
        immutable_tree_sha256: String::new(),
        immutable_file_count: 0,
        preview_sha256,
        shared_preferences: None,
    })
}

pub(crate) fn check_record(
    record: &ExternalRuntimeRecord,
    spec: &UserPreparedRuntimeSpec,
    library: &Path,
) -> Result<()> {
    if spec.trust != ExternalRuntimeTrust::UserSelected {
        return Err(PortcoveError::verification(
            "user-selected runtime has no retained execution-intent contract",
        ));
    }
    check_listing_record(record, library)
}

pub(crate) fn check_listing_identity(record: &ExternalRuntimeRecord) -> Result<()> {
    if record.version != "user-managed"
        || !record.archive_sha256.is_empty()
        || !record.immutable_tree_sha256.is_empty()
        || record.shared_preferences.is_some()
    {
        return Err(PortcoveError::verification(
            "user-selected runtime has an inconsistent ownership or trust contract",
        ));
    }
    let selection = record
        .user_selected
        .as_ref()
        .ok_or_else(|| PortcoveError::verification("user-selected execution intent is missing"))?;
    validate_arguments(&selection.arguments)?;
    Ok(())
}

pub(crate) fn check_listing_record(record: &ExternalRuntimeRecord, library: &Path) -> Result<()> {
    check_listing_identity(record)?;
    if record.platform != Platform::current()? {
        return Err(PortcoveError::unsupported(
            "selected installation belongs to another platform",
        ));
    }
    let (executable, path) = checked_paths(&record.executable, &record.path, library)?;
    if executable != record.executable || path != record.path {
        return Err(PortcoveError::verification(
            "selected runtime location changed",
        ));
    }
    Ok(())
}
