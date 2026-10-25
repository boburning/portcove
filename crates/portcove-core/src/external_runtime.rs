//! Read-only identity checks for a player-owned runtime. No path in this module
//! grants Portcove permission to copy, replace, clean up, or back up that tree.
//! Inspection binds byte hashing to filesystem objects, then repeats a bounded
//! metadata inventory without callbacks. Cancellation is checked immediately
//! before that final pass; it cannot interrupt the pass itself. These sequential
//! observations do not freeze external writes or form an atomic tree snapshot.

use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Read,
    path::{Path, PathBuf},
    time::SystemTime,
};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{ExternalRuntimeRecord, Platform, PortcoveError, Result, UserPreparedRuntimeSpec};

const MAX_FILES: usize = 100_000;
const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024 * 1024;
const MAX_TREE_BYTES: u64 = 16 * 1024 * 1024 * 1024;

pub(crate) mod shared_preferences;
pub(crate) mod tfe_settings;
mod user_selected;
pub(crate) use user_selected::{
    check_listing_identity as check_user_selected_identity,
    check_listing_record as check_user_selected_listing_record,
    check_record as check_user_selected_record, preview as preview_user_selected,
};

pub(crate) fn validate_user_selected_route(
    port: &crate::PortDefinition,
    spec: &UserPreparedRuntimeSpec,
) -> Result<()> {
    if port.adapter != crate::AdapterKind::StagedSourcePortable
        || spec.version != "user-managed"
        || !spec.archive_name.is_empty()
        || spec.archive_size != 0
        || !spec.archive_sha256.is_empty()
        || !spec.immutable_tree_sha256.is_empty()
        || !spec.executable.is_empty()
        || spec.source_argument_extension.is_some()
        || spec.source_directory_environment
        || spec.library_user_data
        || !spec.mutable_paths.is_empty()
        || !spec.required_mutable_files.is_empty()
        || spec.settings_contract.is_some()
        || spec.shared_preferences.is_some()
        || port.source_profile.is_some()
        || port.bios_source_profile.is_some()
        || port
            .executable_hints
            .values()
            .any(|hints| !hints.is_empty())
        || !port.persistent_paths.is_empty()
        || !port.persistent_file_patterns.is_empty()
        || !port.runtime_mutable_paths.is_empty()
        || !port.runtime_mutable_file_patterns.is_empty()
        || port.windows_runtime_path_policy.is_some()
        || port.portable_marker
        || port.n64_windows_initial_d3d12
        || port.managed_initialization.is_some()
        || port.runtime_data_policy.is_some()
        || port.managed_shared_preferences.is_some()
        || port.source_environment.is_some()
        || port.user_data_environment.is_some()
        || !port.launch_environment.is_empty()
        || !port.launch_arguments.is_empty()
        || port.runtime_subdirectory.is_some()
        || port.runtime_source_filename.is_some()
        || port.runtime_source_materialization.is_some()
        || !port.runtime_source_hashes.is_empty()
        || !port.runtime_source_set.is_empty()
        || port.launch_from_install_root
        || !port.setup_executable_hints.is_empty()
        || !port.setup_arguments.is_empty()
        || port.setup_marker.is_some()
        || !port.setup_output_paths.is_empty()
    {
        return Err(PortcoveError::usage(
            "user-selected runtime offers execution and registration removal only; package, source, settings and managed lifecycle declarations are not allowed",
        ));
    }
    Ok(())
}

/// Required selectors are existence/type constraints, never content authority.
pub(crate) fn validate_required_mutable_files(spec: &UserPreparedRuntimeSpec) -> Result<()> {
    if spec.required_mutable_files.len() > 64 {
        return Err(PortcoveError::usage("too many required mutable files"));
    }
    let mut seen = BTreeSet::new();
    for required in &spec.required_mutable_files {
        let (_, key) = crate::archive::validate_relative_path(required, false)?;
        let covered = spec.mutable_paths.iter().any(|mutable| {
            let Ok((_, normalized)) = crate::archive::validate_relative_path(mutable, true) else {
                return false;
            };
            // Match the existing inventory exemption exactly. Do not normalize
            // a trailing separator into a broader mutable surface for a retained
            // tree whose immutable identity was computed with literal keys.
            mutable.to_ascii_lowercase() == normalized
                && (key == normalized || key.starts_with(&format!("{normalized}/")))
        });
        if !covered || !seen.insert(key) {
            return Err(PortcoveError::usage(
                "required mutable files must be unique paths within declared mutable data",
            ));
        }
    }
    if spec.settings_contract.is_some() {
        tfe_settings::validate_declaration(spec)?;
    }
    Ok(())
}

fn check_required_mutable_files(root: &Path, spec: &UserPreparedRuntimeSpec) -> Result<()> {
    validate_required_mutable_files(spec)?;
    for required in &spec.required_mutable_files {
        let (relative, _) = crate::archive::validate_relative_path(required, false)?;
        let file = open_object(&root.join(relative), false).map_err(|error| {
            PortcoveError::verification("required mutable selector is missing or unsafe")
                .detail("path", required)
                .detail("cause", error.message)
        })?;
        if link_count(&file)? != 1 {
            return Err(PortcoveError::verification(
                "required mutable selector must not share a hard-linked file",
            )
            .detail("path", required));
        }
        if spec.settings_contract.is_some() && required == "settings.ini" {
            tfe_settings::check(&file)?;
        }
    }
    if spec.settings_contract.is_some() {
        for name in tfe_settings::GOBS {
            open_object(&root.join("GameData").join(name), false).map_err(|error| {
                PortcoveError::verification("TFE immutable GameData is missing or unsafe")
                    .detail("path", name)
                    .detail("cause", error.message)
            })?;
        }
    }
    Ok(())
}

#[cfg(unix)]
pub(crate) fn link_count(file: &fs::File) -> Result<u64> {
    use std::os::unix::fs::MetadataExt;
    Ok(file.metadata()?.nlink())
}

#[cfg(windows)]
pub(crate) fn link_count(file: &fs::File) -> Result<u64> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
    };
    // SAFETY: the initialized output is valid and the borrowed handle stays alive.
    let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut information) } == 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(u64::from(information.nNumberOfLinks))
}

#[cfg(not(any(unix, windows)))]
pub(crate) fn link_count(_file: &fs::File) -> Result<u64> {
    Err(PortcoveError::unsupported(
        "mutable selector identity is unavailable on this platform",
    ))
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ObjectIdentity {
    #[cfg(unix)]
    Unix { device: u64, inode: u64 },
    #[cfg(windows)]
    Windows128 { volume: u64, file: [u8; 16] },
    #[cfg(windows)]
    Windows64 { volume: u32, file: u64 },
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct FileSnapshot {
    identity: ObjectIdentity,
    size: u64,
    modified: SystemTime,
    #[cfg(unix)]
    changed_at: (i64, i64),
}

struct InspectedFile {
    path: PathBuf,
    snapshot: FileSnapshot,
    sha256: String,
}

enum InspectionPass<'a> {
    Hash(&'a dyn Fn() -> Result<()>),
    Recheck(BTreeSet<String>),
}

#[derive(Debug, Clone)]
pub(crate) struct InspectedExternalRuntime {
    pub root: PathBuf,
    pub executable: PathBuf,
    pub immutable_tree_sha256: String,
    pub immutable_file_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ExternalRuntimePreview {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_selected: Option<crate::UserSelectedLaunch>,
    pub port_id: String,
    pub path: PathBuf,
    pub executable: PathBuf,
    pub version: String,
    pub archive_sha256: String,
    pub immutable_tree_sha256: String,
    pub immutable_file_count: usize,
    pub preview_sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shared_preferences: Option<crate::SharedPreferencesReview>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ExternalRuntimeRemovalPreview {
    pub port_id: String,
    pub path: PathBuf,
    pub version: String,
    pub external_files_will_be_preserved: bool,
    pub preview_sha256: String,
}

/// Review of a location change for the same retained external installation.
/// No files are moved, adopted, deleted or upgraded by this operation.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ExternalRuntimeRelinkPreview {
    pub port_id: String,
    pub registration_id: String,
    pub previous_path: PathBuf,
    pub proposed: ExternalRuntimePreview,
    pub external_files_will_be_preserved: bool,
    pub preview_sha256: String,
}

pub(crate) fn require_retained_executable_path(
    root: &Path,
    executable: &Path,
    expected: &str,
) -> Result<()> {
    let relative = executable.strip_prefix(root).map_err(|_| {
        PortcoveError::verification("external executable is outside its registered folder")
    })?;
    let relative = crate::path::unicode(relative, "external executable")?.replace('\\', "/");
    let (_, actual) = crate::archive::validate_relative_path(&relative, false)?;
    let (_, expected) = crate::archive::validate_relative_path(expected, false)?;
    if actual != expected {
        return Err(PortcoveError::verification(
            "external executable differs from its retained contract",
        ));
    }
    Ok(())
}

/// Observe the registered root and executable without reading or hashing the
/// player-owned tree. Status is a point-in-time location assessment, not proof
/// of immutable bytes or execution authority; launch still runs full inspection.
/// Filesystem permission failures while resolving these paths refuse readiness.
pub(crate) fn check_registered_location(
    record: &ExternalRuntimeRecord,
    spec: &UserPreparedRuntimeSpec,
    library_root: &Path,
) -> Result<()> {
    if spec.trust == crate::ExternalRuntimeTrust::UserSelected {
        return check_user_selected_record(record, spec, library_root);
    }
    if record.user_selected.is_some() {
        return Err(PortcoveError::verification(
            "user-selected execution has no retained trust contract",
        ));
    }
    if record.platform != Platform::current()? {
        return Err(PortcoveError::unsupported(
            "external runtime belongs to another platform",
        ));
    }
    crate::path::refuse_symlink_ancestors(&record.path)?;
    let root = fs::canonicalize(&record.path)?;
    if root != record.path || !fs::symlink_metadata(&root)?.is_dir() {
        return Err(PortcoveError::verification(
            "external runtime root is not its registered directory",
        ));
    }
    let library = fs::canonicalize(library_root)?;
    if root.starts_with(&library) || library.starts_with(&root) {
        return Err(PortcoveError::conflict(
            "external runtime must remain outside the Portcove library",
        ));
    }
    crate::path::refuse_symlink_ancestors(&record.executable)?;
    let executable = fs::canonicalize(&record.executable)?;
    if executable != record.executable || !fs::symlink_metadata(&executable)?.is_file() {
        return Err(PortcoveError::verification(
            "external executable is not its registered regular file",
        ));
    }
    let relative = executable.strip_prefix(&root).map_err(|_| {
        PortcoveError::verification("external executable escaped its registered root")
    })?;
    let relative = crate::path::unicode(relative, "external executable")?.replace('\\', "/");
    let (_, actual_key) = crate::archive::validate_relative_path(&relative, false)?;
    let (_, expected_key) = crate::archive::validate_relative_path(&spec.executable, false)?;
    // Admission accepts portable case-insensitive keys but records actual
    // filename spelling. Preserve that contract on case-sensitive filesystems.
    if actual_key != expected_key {
        return Err(PortcoveError::verification(
            "external executable differs from its retained location contract",
        ));
    }
    check_required_mutable_files(&root, spec)?;
    shared_preferences::check_record(record, spec)?;
    Ok(())
}

/// Hash every immutable regular file under one canonical root. Mutable paths
/// are explicit exceptions for game-owned output, not Portcove-owned content.
/// The signed definition supplies the expected digest; a first local scan
/// never blesses itself as authority.
#[cfg(test)]
pub(crate) fn inspect(
    requested_root: &Path,
    spec: &UserPreparedRuntimeSpec,
    library_root: &Path,
) -> Result<InspectedExternalRuntime> {
    inspect_with_checkpoint(requested_root, spec, library_root, &|| Ok(()))
}

pub(crate) fn inspect_with_checkpoint(
    requested_root: &Path,
    spec: &UserPreparedRuntimeSpec,
    library_root: &Path,
    checkpoint: &dyn Fn() -> Result<()>,
) -> Result<InspectedExternalRuntime> {
    checkpoint()?;
    crate::path::refuse_symlink_ancestors(requested_root)?;
    let root = fs::canonicalize(requested_root)?;
    if !fs::symlink_metadata(&root)?.is_dir() {
        return Err(PortcoveError::usage(
            "user-prepared runtime must be a directory",
        ));
    }
    let root_identity = object_identity(&open_object(&root, true)?)?;
    check_required_mutable_files(&root, spec)?;
    let library = fs::canonicalize(library_root)?;
    if root.starts_with(&library) || library.starts_with(&root) {
        return Err(PortcoveError::conflict(
            "user-prepared runtime must be outside the Portcove library",
        ));
    }
    let mut files = BTreeMap::<String, InspectedFile>::new();
    let mut seen = 0_usize;
    let mut total_bytes = 0_u64;
    visit(
        &root,
        &root,
        spec,
        &mut files,
        &mut seen,
        &mut total_bytes,
        &mut InspectionPass::Hash(checkpoint),
    )?;
    let (_, executable_key) = crate::archive::validate_relative_path(&spec.executable, false)?;
    let executable = files
        .get(&executable_key)
        .map(|file| file.path.clone())
        .ok_or_else(|| PortcoveError::verification("user-prepared executable is missing"))?;
    let mut digest = Sha256::new();
    digest.update(b"portcove-external-tree-v1\n");
    for (relative, file) in &files {
        digest.update(relative.as_bytes());
        digest.update([0]);
        digest.update(file.snapshot.size.to_be_bytes());
        digest.update(
            hex::decode(&file.sha256)
                .map_err(|_| PortcoveError::state("external runtime file digest was invalid"))?,
        );
    }
    let immutable_tree_sha256 = hex::encode(digest.finalize());
    if !immutable_tree_sha256.eq_ignore_ascii_case(&spec.immutable_tree_sha256) {
        return Err(PortcoveError::verification(
            "user-prepared runtime differs from the accepted immutable package",
        )
        .detail("expected_tree_sha256", &spec.immutable_tree_sha256)
        .detail("actual_tree_sha256", immutable_tree_sha256));
    }
    // Callbacks may change a previously hashed file. Put the last checkpoint
    // before the sweep, then observe every immutable path again without hashing
    // its bytes or retaining one open descriptor per file. This is a bounded
    // inspection-time observation, not an atomic snapshot of player-owned data
    // or a promise that paths cannot change after inspection returns.
    checkpoint()?;
    let mut recheck = InspectionPass::Recheck(BTreeSet::new());
    visit(&root, &root, spec, &mut files, &mut 0, &mut 0, &mut recheck)?;
    if let InspectionPass::Recheck(observed) = recheck
        && observed.len() != files.len()
    {
        return Err(changed_during_inspection());
    }
    if object_identity(&open_object(&root, true)?)? != root_identity {
        return Err(changed_during_inspection());
    }
    // Required mutable entries do not disappear with the immutable exemptions.
    // This final presence/type observation has no cancellation callback. Settings
    // contents may change, and these sequential checks do not freeze execution.
    check_required_mutable_files(&root, spec)?;
    Ok(InspectedExternalRuntime {
        root,
        executable,
        immutable_tree_sha256,
        immutable_file_count: files.len(),
    })
}

fn visit(
    root: &Path,
    directory: &Path,
    spec: &UserPreparedRuntimeSpec,
    files: &mut BTreeMap<String, InspectedFile>,
    seen: &mut usize,
    total_bytes: &mut u64,
    pass: &mut InspectionPass<'_>,
) -> Result<()> {
    for entry in fs::read_dir(directory)? {
        if let InspectionPass::Hash(checkpoint) = pass {
            checkpoint()?;
        }
        let entry = entry?;
        *seen += 1;
        if *seen > MAX_FILES {
            return Err(PortcoveError::verification(
                "user-prepared runtime has too many entries",
            ));
        }
        let path = entry.path();
        let resolved = fs::canonicalize(&path)?;
        if !resolved.starts_with(root) || entry.file_type()?.is_symlink() {
            return Err(PortcoveError::verification(
                "user-prepared runtime contains a redirected path",
            ));
        }
        let relative = path
            .strip_prefix(root)
            .map_err(|_| PortcoveError::state("external runtime path escaped its root"))?;
        let relative = crate::path::unicode(relative, "user-prepared runtime")?.replace('\\', "/");
        let kind = entry.file_type()?;
        shared_preferences::check_tree_path(spec, &path, kind.is_dir())?;
        let (_, key) = crate::archive::validate_relative_path(&relative, kind.is_dir())?;
        if kind.is_dir() {
            visit(root, &path, spec, files, seen, total_bytes, pass)?;
            continue;
        }
        if !kind.is_file() {
            return Err(PortcoveError::verification(
                "user-prepared runtime contains a non-regular entry",
            ));
        }
        if spec.mutable_paths.iter().any(|mutable| {
            let mutable = mutable.to_ascii_lowercase();
            key == mutable || key.starts_with(&format!("{mutable}/"))
        }) {
            // Mutable bytes are outside the package digest, but a game write
            // must not mutate an aliased file outside this prepared runtime.
            // Repeat this held-object check in both inspection sweeps; launch
            // uses the same inspector as registration.
            if link_count(&open_object(&path, false)?)? != 1 {
                return Err(PortcoveError::verification(
                    "user-prepared mutable data must not share a hard-linked file",
                )
                .detail("path", relative));
            }
            continue;
        }
        let size = entry.metadata()?.len();
        if size > MAX_FILE_BYTES || size > MAX_TREE_BYTES.saturating_sub(*total_bytes) {
            return Err(PortcoveError::verification(
                "user-prepared runtime exceeds the file or tree size limit",
            ));
        }
        *total_bytes += size;
        match pass {
            InspectionPass::Hash(checkpoint) => {
                let file = hash_bounded(&path, size, *checkpoint)?;
                if files.insert(key, file).is_some() {
                    return Err(PortcoveError::verification(
                        "user-prepared runtime contains case-colliding files",
                    ));
                }
            }
            InspectionPass::Recheck(observed) => {
                let expected = files.get(&key).ok_or_else(changed_during_inspection)?;
                if !observed.insert(key)
                    || path != expected.path
                    || file_snapshot(&open_object(&path, false)?)? != expected.snapshot
                {
                    return Err(changed_during_inspection());
                }
            }
        }
    }
    Ok(())
}

fn hash_bounded(
    path: &Path,
    expected_size: u64,
    checkpoint: &dyn Fn() -> Result<()>,
) -> Result<InspectedFile> {
    let mut reader = open_object(path, false)?;
    let snapshot = file_snapshot(&reader)?;
    if snapshot.size != expected_size {
        return Err(changed_during_inspection());
    }
    let mut digest = Sha256::new();
    let mut total = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        checkpoint()?;
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        total += read as u64;
        if total > expected_size || total > MAX_FILE_BYTES {
            return Err(PortcoveError::verification(
                "user-prepared runtime file changed or grew during inspection",
            ));
        }
        digest.update(&buffer[..read]);
    }
    if total != expected_size {
        return Err(PortcoveError::verification(
            "user-prepared runtime file changed during inspection",
        ));
    }
    if file_snapshot(&reader)? != snapshot || file_snapshot(&open_object(path, false)?)? != snapshot
    {
        return Err(changed_during_inspection());
    }
    Ok(InspectedFile {
        path: path.to_owned(),
        snapshot,
        sha256: hex::encode(digest.finalize()),
    })
}

fn changed_during_inspection() -> PortcoveError {
    PortcoveError::verification("user-prepared runtime changed during inspection")
}

/// Reuse the stable read-only object checks for one bounded Core-owned member.
/// Hashing supplies no ownership, preparation provenance or mutation permission.
pub(crate) fn hash_stable_regular(
    path: &Path,
    maximum: u64,
    checkpoint: &dyn Fn() -> Result<()>,
) -> Result<(String, u64)> {
    crate::path::refuse_symlink_ancestors(path)?;
    let canonical = fs::canonicalize(path)?;
    let opened = open_object(&canonical, false)?;
    let size = opened.metadata()?.len();
    if size > maximum || size > MAX_FILE_BYTES || link_count(&opened)? != 1 {
        return Err(PortcoveError::verification(
            "bounded member is oversized or shares a hard-linked file",
        ));
    }
    let inspected = hash_bounded(&canonical, size, checkpoint)?;
    if file_snapshot(&opened)? != inspected.snapshot
        || link_count(&open_object(&canonical, false)?)? != 1
    {
        return Err(changed_during_inspection());
    }
    Ok((inspected.sha256, size))
}

fn open_object(path: &Path, directory: bool) -> Result<fs::File> {
    crate::path::refuse_symlink_ancestors(path)?;
    let metadata = fs::symlink_metadata(path)?;
    if (directory && !metadata.is_dir())
        || (!directory && !metadata.is_file())
        || fs::canonicalize(path)? != path
    {
        return Err(changed_during_inspection());
    }
    let file = open_identity_handle(path)?;
    let opened = file.metadata()?;
    let current = fs::symlink_metadata(path)?;
    if (directory && (!opened.is_dir() || !current.is_dir()))
        || (!directory && (!opened.is_file() || !current.is_file()))
        || opened.file_type().is_symlink()
        || current.file_type().is_symlink()
        || fs::canonicalize(path)? != path
    {
        return Err(changed_during_inspection());
    }
    crate::path::refuse_symlink_ancestors(path)?;
    #[cfg(unix)]
    if metadata_identity(&metadata) != metadata_identity(&opened)
        || metadata_identity(&opened) != metadata_identity(&current)
    {
        return Err(changed_during_inspection());
    }
    #[cfg(windows)]
    {
        // Read the current path through another transient no-reparse handle;
        // never retain an open handle per inspected file.
        let at_path = open_identity_handle(path)?;
        let current = fs::symlink_metadata(path)?;
        if object_identity(&file)? != object_identity(&at_path)?
            || current.file_type().is_symlink()
            || (directory && !current.is_dir())
            || (!directory && !current.is_file())
            || fs::canonicalize(path)? != path
        {
            return Err(changed_during_inspection());
        }
        crate::path::refuse_symlink_ancestors(path)?;
    }
    Ok(file)
}

/// Bounded metadata read using the existing stable, no-follow object authority.
pub(crate) fn read_stable_metadata(path: &Path, limit: u64) -> Result<Vec<u8>> {
    read_metadata(path, limit, false)
}

pub(crate) fn read_single_link_metadata(path: &Path, limit: u64) -> Result<Vec<u8>> {
    read_metadata(path, limit, true)
}

/// Open an ordinary transferable file without following its final link. Refuse
/// hard-link aliases before any payload read, including aliases of credentials.
pub(crate) fn open_single_link_file(path: &Path) -> Result<fs::File> {
    crate::runtime_data_policy::refuse_sensitive_entry(path)?;
    crate::path::refuse_symlink_ancestors(path)?;
    let canonical = fs::canonicalize(path)?;
    crate::runtime_data_policy::refuse_sensitive_entry(&canonical)?;
    let file = open_object(&canonical, false)?;
    if !file.metadata()?.is_file() || link_count(&file)? != 1 {
        return Err(PortcoveError::verification(
            "runtime data must be a single-link regular file",
        ));
    }
    Ok(file)
}

fn read_metadata(path: &Path, limit: u64, single_link: bool) -> Result<Vec<u8>> {
    crate::path::refuse_symlink_ancestors(path)?;
    let canonical = fs::canonicalize(path)?;
    let mut file = open_object(&canonical, false)?;
    let before = file_snapshot(&file)?;
    if single_link && link_count(&file)? != 1 {
        return Err(PortcoveError::verification(
            "metadata must be a single-link regular file",
        ));
    }
    if before.size > limit {
        return Err(PortcoveError::verification(
            "query metadata exceeds its read budget",
        ));
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(limit.saturating_add(1))
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit
        || bytes.len() as u64 != before.size
        || file_snapshot(&file)? != before
        || file_snapshot(&open_object(&canonical, false)?)? != before
        || (single_link && link_count(&file)? != 1)
    {
        return Err(changed_during_inspection());
    }
    crate::path::refuse_symlink_ancestors(path)?;
    if fs::canonicalize(path)? != canonical {
        return Err(changed_during_inspection());
    }
    Ok(bytes)
}

pub(crate) fn open_identity_handle(path: &Path) -> Result<fs::File> {
    let mut options = fs::File::options();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // Refuse a replaced leaf symlink and avoid blocking if a regular file
        // becomes a FIFO between the metadata check and the open.
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        };
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS);
    }
    Ok(options.open(path)?)
}

/// Compare held objects using the same OS identity policy as stable reads.
pub(crate) fn same_file(left: &fs::File, right: &fs::File) -> Result<bool> {
    Ok(object_identity(left)? == object_identity(right)?)
}

fn file_snapshot(file: &fs::File) -> Result<FileSnapshot> {
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(changed_during_inspection());
    }
    #[cfg(unix)]
    use std::os::unix::fs::MetadataExt;
    Ok(FileSnapshot {
        identity: object_identity(file)?,
        size: metadata.len(),
        modified: metadata.modified()?,
        #[cfg(unix)]
        changed_at: (metadata.ctime(), metadata.ctime_nsec()),
    })
}

#[cfg(unix)]
fn object_identity(file: &fs::File) -> Result<ObjectIdentity> {
    Ok(metadata_identity(&file.metadata()?))
}

#[cfg(unix)]
fn metadata_identity(metadata: &fs::Metadata) -> ObjectIdentity {
    use std::os::unix::fs::MetadataExt;
    ObjectIdentity::Unix {
        device: metadata.dev(),
        inode: metadata.ino(),
    }
}

#[cfg(windows)]
fn object_identity(file: &fs::File) -> Result<ObjectIdentity> {
    use std::{
        mem::{size_of, zeroed},
        os::windows::io::AsRawHandle,
    };
    use windows_sys::Win32::Foundation::{ERROR_INVALID_PARAMETER, ERROR_NOT_SUPPORTED};
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, FILE_ID_INFO, FileIdInfo, GetFileInformationByHandle,
        GetFileInformationByHandleEx,
    };
    // SAFETY: the initialized output is valid for this Win32 structure and the
    // borrowed file handle remains alive throughout the call.
    let mut information: FILE_ID_INFO = unsafe { zeroed() };
    let succeeded = unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle() as _,
            FileIdInfo,
            std::ptr::from_mut(&mut information).cast(),
            size_of::<FILE_ID_INFO>() as u32,
        )
    };
    if succeeded != 0 {
        return Ok(ObjectIdentity::Windows128 {
            volume: information.VolumeSerialNumber,
            file: information.FileId.Identifier,
        });
    }
    let error = std::io::Error::last_os_error();
    if !matches!(error.raw_os_error(), Some(code) if code == ERROR_NOT_SUPPORTED as i32 || code == ERROR_INVALID_PARAMETER as i32)
    {
        return Err(error.into());
    }
    // FAT32/exFAT may not offer FileIdInfo. Preserve their existing OS-provided
    // identity route, refusing the legacy sentinel identifiers. ReFS normally
    // supplies the full ID above. Distinct variants prevent a query-method
    // change from satisfying equality; no pathname-only fallback is permitted.
    // Neither route certifies arbitrary network/third-party filesystem identity.
    let mut legacy: BY_HANDLE_FILE_INFORMATION = unsafe { zeroed() };
    // SAFETY: the output is initialized and the same borrowed handle is alive.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut legacy) } == 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    let file = (u64::from(legacy.nFileIndexHigh) << 32) | u64::from(legacy.nFileIndexLow);
    if file == 0 || file == u64::MAX {
        return Err(changed_during_inspection());
    }
    Ok(ObjectIdentity::Windows64 {
        volume: legacy.dwVolumeSerialNumber,
        file,
    })
}

#[cfg(not(any(unix, windows)))]
fn object_identity(_file: &fs::File) -> Result<ObjectIdentity> {
    Err(PortcoveError::unsupported(
        "external runtime inspection needs filesystem object identity on this platform",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stable_member_hash_refuses_oversize_links_and_same_size_replacement() {
        let temporary = tempfile::tempdir().unwrap();
        let file = temporary.path().join("generated.o2r");
        fs::write(&file, b"fixture").unwrap();
        assert_eq!(
            hash_stable_regular(&file, 7, &|| Ok(())).unwrap(),
            (hex::encode(Sha256::digest(b"fixture")), 7)
        );
        assert!(hash_stable_regular(&file, 6, &|| Ok(())).is_err());
        let alias = temporary.path().join("alias.o2r");
        fs::hard_link(&file, &alias).unwrap();
        assert!(hash_stable_regular(&file, 7, &|| Ok(())).is_err());
        fs::remove_file(alias).unwrap();
        let original_modified = fs::metadata(&file).unwrap().modified().unwrap();
        let changed = std::cell::Cell::new(false);
        assert!(
            hash_stable_regular(&file, 7, &|| {
                if !changed.replace(true) {
                    fs::write(&file, b"changed").expect("same-size fixture mutation must succeed");
                    // A same-tick write can retain identical observable metadata
                    // on Linux. Exercise a definite same-size metadata change,
                    // without sleeping or changing the production inspection.
                    fs::OpenOptions::new()
                        .write(true)
                        .open(&file)
                        .expect("modified fixture must open for timestamp setup")
                        .set_modified(original_modified + std::time::Duration::from_secs(2))
                        .expect("fixture timestamp must visibly change");
                }
                Ok(())
            })
            .is_err()
        );
        assert_ne!(
            fs::metadata(&file).unwrap().modified().unwrap(),
            original_modified
        );
        assert_eq!(fs::read(file).unwrap(), b"changed");
    }

    #[test]
    fn stable_query_metadata_enforces_byte_budget_and_regular_object() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("manifest.json");
        fs::write(&path, b"fixture metadata").unwrap();
        assert_eq!(
            read_stable_metadata(&path, 16).unwrap(),
            b"fixture metadata"
        );
        assert!(read_stable_metadata(&path, 15).is_err());
        assert!(read_stable_metadata(temporary.path(), 16).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn stable_query_metadata_refuses_symlink_and_fifo_without_blocking() {
        use std::os::unix::ffi::OsStrExt;
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("manifest.json");
        fs::write(&path, b"fixture").unwrap();
        let alias = temporary.path().join("alias.json");
        std::os::unix::fs::symlink(&path, &alias).unwrap();
        assert!(read_stable_metadata(&alias, 16).is_err());
        let fifo = temporary.path().join("fifo");
        let name = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        assert!(read_stable_metadata(&fifo, 16).is_err());
    }

    fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf, UserPreparedRuntimeSpec) {
        let temporary = tempfile::tempdir().unwrap();
        let library = temporary.path().join("library");
        let runtime = temporary.path().join("player-runtime");
        fs::create_dir(&library).unwrap();
        fs::create_dir(&runtime).unwrap();
        fs::write(runtime.join("game.exe"), b"accepted executable").unwrap();
        let mut spec = UserPreparedRuntimeSpec {
            trust: crate::ExternalRuntimeTrust::AcceptedPackage,
            version: "1.0".into(),
            archive_name: "game-windows.zip".into(),
            archive_size: 100,
            archive_sha256: "a".repeat(64),
            executable: "game.exe".into(),
            immutable_tree_sha256: "0".repeat(64),
            source_argument_extension: None,
            source_directory_environment: false,
            library_user_data: false,
            required_mutable_files: vec![],
            settings_contract: None,
            shared_preferences: None,
            mutable_paths: vec!["runtime-state".into()],
        };
        let mismatch = inspect(&runtime, &spec, &library).unwrap_err();
        spec.immutable_tree_sha256 = mismatch.details["actual_tree_sha256"].clone();
        (temporary, library, runtime, spec)
    }

    fn location_record(
        runtime: &Path,
        spec: &UserPreparedRuntimeSpec,
        library: &Path,
    ) -> ExternalRuntimeRecord {
        let inspected = inspect(runtime, spec, library).unwrap();
        ExternalRuntimeRecord {
            user_selected: None,
            id: "location-probe".into(),
            port_id: "location-probe".into(),
            path: inspected.root,
            executable: inspected.executable,
            version: spec.version.clone(),
            platform: Platform::current().unwrap(),
            archive_sha256: spec.archive_sha256.clone(),
            immutable_tree_sha256: inspected.immutable_tree_sha256,
            registered_at: 1,
            retained_definition: None,
            shared_preferences: None,
        }
    }

    #[test]
    fn tfe_selection_rechecks_content_and_immutable_data_before_launch() {
        let (_temporary, library, runtime, mut spec) = fixture();
        spec.mutable_paths.push("settings.ini".into());
        spec.required_mutable_files.push("settings.ini".into());
        spec.settings_contract = Some(crate::PreparedRuntimeSettingsContract::TfeDarkForces122420);
        spec.version = "1.22.420".into();
        let settings = runtime.join("settings.ini");
        let valid = b"[Game]\ngame=\"Dark Forces\"\n[Dark_Forces]\nsourcePath=\"GameData/\"\n";
        fs::write(&settings, valid).unwrap();
        assert!(inspect(&runtime, &spec, &library).is_err());
        fs::create_dir(runtime.join("GameData")).unwrap();
        for name in tfe_settings::GOBS {
            fs::write(runtime.join("GameData").join(name), name).unwrap();
        }
        let mismatch = inspect(&runtime, &spec, &library).unwrap_err();
        spec.immutable_tree_sha256 = mismatch.details["actual_tree_sha256"].clone();
        let record = location_record(&runtime, &spec, &library);
        let calls = std::cell::Cell::new(0);
        inspect_with_checkpoint(&runtime, &spec, &library, &|| {
            calls.set(calls.get() + 1);
            Ok(())
        })
        .unwrap();
        assert!(
            inspect_at_checkpoint(&runtime, &spec, &library, calls.get(), || {
                fs::write(
                    &settings,
                    String::from_utf8_lossy(valid).replace("GameData/", "ElseData/"),
                )
                .unwrap();
            })
            .is_err()
        );
        assert!(check_registered_location(&record, &spec, &library).is_err());
        fs::write(&settings, valid).unwrap();
        check_registered_location(&record, &spec, &library).unwrap();
        fs::remove_file(runtime.join("GameData/DARK.GOB")).unwrap();
        assert!(check_registered_location(&record, &spec, &library).is_err());
    }

    #[test]
    fn required_mutable_selector_preserves_content_and_requires_presence() {
        let (_temporary, library, runtime, mut spec) = fixture();
        spec.mutable_paths.push("settings.ini".into());
        spec.required_mutable_files.push("settings.ini".into());
        assert!(inspect(&runtime, &spec, &library).is_err());
        fs::write(runtime.join("settings.ini"), b"").unwrap();
        let accepted = inspect(&runtime, &spec, &library).unwrap();
        let record = location_record(&runtime, &spec, &library);
        fs::write(runtime.join("settings.ini"), b"player preference changed").unwrap();
        assert_eq!(
            inspect(&runtime, &spec, &library)
                .unwrap()
                .immutable_tree_sha256,
            accepted.immutable_tree_sha256
        );
        check_registered_location(&record, &spec, &library).unwrap();
        fs::remove_file(runtime.join("settings.ini")).unwrap();
        assert!(inspect(&runtime, &spec, &library).is_err());
        assert!(check_registered_location(&record, &spec, &library).is_err());
        assert_eq!(
            fs::read(runtime.join("game.exe")).unwrap(),
            b"accepted executable"
        );
    }

    #[test]
    fn required_mutable_selector_refuses_directory_hardlink_and_final_deletion() {
        let (_temporary, library, runtime, mut spec) = fixture();
        spec.mutable_paths.push("settings.ini".into());
        spec.required_mutable_files.push("settings.ini".into());
        let selector = runtime.join("settings.ini");
        fs::create_dir(&selector).unwrap();
        assert!(inspect(&runtime, &spec, &library).is_err());
        fs::remove_dir(&selector).unwrap();
        fs::hard_link(runtime.join("game.exe"), &selector).unwrap();
        assert!(inspect(&runtime, &spec, &library).is_err());
        fs::remove_file(&selector).unwrap();
        fs::write(&selector, b"player settings").unwrap();
        let calls = std::cell::Cell::new(0);
        inspect_with_checkpoint(&runtime, &spec, &library, &|| {
            calls.set(calls.get() + 1);
            Ok(())
        })
        .unwrap();
        let final_checkpoint = calls.get();
        assert!(
            inspect_at_checkpoint(&runtime, &spec, &library, final_checkpoint, || {
                fs::remove_file(&selector).unwrap()
            })
            .is_err()
        );
        assert!(!selector.exists());
    }

    #[cfg(unix)]
    #[test]
    fn required_mutable_selector_refuses_redirected_leaf() {
        let (_temporary, library, runtime, mut spec) = fixture();
        spec.mutable_paths.push("settings.ini".into());
        spec.required_mutable_files.push("settings.ini".into());
        let outside = library.join("player-settings");
        fs::write(&outside, b"preserve outside data").unwrap();
        std::os::unix::fs::symlink(&outside, runtime.join("settings.ini")).unwrap();
        assert!(inspect(&runtime, &spec, &library).is_err());
        assert_eq!(fs::read(&outside).unwrap(), b"preserve outside data");
    }

    #[test]
    fn required_mutable_selector_validates_exact_portable_boundaries() {
        let (_temporary, _library, _runtime, mut spec) = fixture();
        spec.required_mutable_files = vec!["runtime-state/settings.ini".into()];
        validate_required_mutable_files(&spec).unwrap();
        spec.mutable_paths = vec!["runtime-state/".into()];
        assert!(validate_required_mutable_files(&spec).is_err());
        spec.mutable_paths = vec!["runtime-state".into()];
        for paths in [
            vec!["runtime-state-elsewhere/settings.ini"],
            vec!["../settings.ini"],
            vec!["game.exe"],
            vec!["runtime-state/settings.ini", "RUNTIME-STATE/SETTINGS.INI"],
        ] {
            spec.required_mutable_files = paths.into_iter().map(str::to_owned).collect();
            assert!(validate_required_mutable_files(&spec).is_err());
        }
        spec.required_mutable_files = (0..65)
            .map(|index| format!("runtime-state/{index}.ini"))
            .collect();
        assert!(validate_required_mutable_files(&spec).is_err());
    }

    #[test]
    fn required_mutable_selector_nested_content_remains_mutable() {
        let (_temporary, library, runtime, mut spec) = fixture();
        fs::create_dir(runtime.join("runtime-state")).unwrap();
        let selector = runtime.join("runtime-state/settings.ini");
        fs::write(&selector, b"").unwrap();
        spec.required_mutable_files = vec!["runtime-state/settings.ini".into()];
        let original = inspect(&runtime, &spec, &library).unwrap();
        fs::write(&selector, b"legitimate nested preferences").unwrap();
        assert_eq!(
            inspect(&runtime, &spec, &library)
                .unwrap()
                .immutable_tree_sha256,
            original.immutable_tree_sha256
        );
    }

    #[test]
    fn mutable_data_refuses_external_hardlinks_without_required_selector() {
        for nested in [false, true] {
            let (_temporary, library, runtime, mut spec) = fixture();
            assert!(spec.required_mutable_files.is_empty());
            let relative = if nested {
                fs::create_dir(runtime.join("runtime-state")).unwrap();
                "runtime-state/save.dat"
            } else {
                spec.mutable_paths.push("settings.ini".into());
                "settings.ini"
            };
            let outside = library.join("original-player-data");
            fs::write(&outside, b"preserve original").unwrap();
            let mutable = runtime.join(relative);
            fs::hard_link(&outside, &mutable).unwrap();
            let refused = inspect(&runtime, &spec, &library).unwrap_err();
            assert!(refused.message.contains("mutable data"));
            assert_eq!(refused.details["path"], relative);
            assert_eq!(fs::read(&outside).unwrap(), b"preserve original");
            assert_eq!(fs::read(&mutable).unwrap(), b"preserve original");
            fs::remove_file(&mutable).unwrap();
            fs::write(&mutable, b"independent player output").unwrap();
            let accepted = inspect(&runtime, &spec, &library).unwrap();
            fs::write(&mutable, b"changed legitimate player output").unwrap();
            assert_eq!(
                inspect(&runtime, &spec, &library)
                    .unwrap()
                    .immutable_tree_sha256,
                accepted.immutable_tree_sha256
            );
            assert_eq!(fs::read(&outside).unwrap(), b"preserve original");
        }
    }

    #[test]
    fn mutable_data_rechecks_hardlinks_created_after_the_hash_sweep() {
        let (_temporary, library, runtime, spec) = fixture();
        assert!(spec.required_mutable_files.is_empty());
        fs::create_dir(runtime.join("runtime-state")).unwrap();
        let mutable = runtime.join("runtime-state/save.dat");
        fs::write(&mutable, b"preserve player output").unwrap();
        let outside = library.join("late-player-alias");
        let calls = std::cell::Cell::new(0);
        inspect_with_checkpoint(&runtime, &spec, &library, &|| {
            calls.set(calls.get() + 1);
            Ok(())
        })
        .unwrap();
        let final_checkpoint = calls.get();
        let refused = inspect_at_checkpoint(&runtime, &spec, &library, final_checkpoint, || {
            fs::hard_link(&mutable, &outside).unwrap();
        })
        .unwrap_err();
        assert!(refused.message.contains("mutable data"));
        assert_eq!(fs::read(&mutable).unwrap(), b"preserve player output");
        assert_eq!(fs::read(&outside).unwrap(), b"preserve player output");
    }

    fn inspect_at_checkpoint(
        runtime: &Path,
        spec: &UserPreparedRuntimeSpec,
        library: &Path,
        at: usize,
        mutation: impl Fn(),
    ) -> Result<InspectedExternalRuntime> {
        let calls = std::cell::Cell::new(0);
        let result = inspect_with_checkpoint(runtime, spec, library, &|| {
            let next = calls.get() + 1;
            calls.set(next);
            if next == at {
                mutation();
            }
            Ok(())
        });
        assert!(calls.get() >= at, "the mutation checkpoint was not reached");
        result
    }

    #[test]
    fn inspection_identity_refuses_same_size_replacement_during_hash() {
        let (_temporary, library, runtime, spec) = fixture();
        let executable = runtime.join("game.exe");
        let displaced = runtime.with_extension("displaced.exe");
        let modified = fs::metadata(&executable).unwrap().modified().unwrap();
        let result = inspect_at_checkpoint(&runtime, &spec, &library, 3, || {
            fs::rename(&executable, &displaced).unwrap();
            fs::write(&executable, b"replaced executable").unwrap();
            fs::File::options()
                .write(true)
                .open(&executable)
                .unwrap()
                .set_modified(modified)
                .unwrap();
        });
        assert!(result.is_err(), "inspection accepted a replaced executable");
        assert_eq!(fs::read(&displaced).unwrap(), b"accepted executable");
        assert_eq!(fs::read(&executable).unwrap(), b"replaced executable");
    }

    #[test]
    fn inspection_identity_refuses_replacement_after_accepted_bytes_are_read() {
        let (_temporary, library, runtime, spec) = fixture();
        let executable = runtime.join("game.exe");
        let displaced = runtime.with_extension("displaced.exe");
        let result = inspect_at_checkpoint(&runtime, &spec, &library, 4, || {
            fs::rename(&executable, &displaced).unwrap();
            fs::write(&executable, b"replaced executable").unwrap();
        });
        assert!(result.is_err(), "inspection accepted the old handle digest");
        assert_eq!(fs::read(&displaced).unwrap(), b"accepted executable");
        assert_eq!(fs::read(&executable).unwrap(), b"replaced executable");
    }

    #[test]
    fn inspection_identity_rechecks_already_hashed_files_after_later_checkpoints() {
        let (_temporary, library, runtime, mut spec) = fixture();
        fs::write(runtime.join("companion.dll"), b"accepted companion").unwrap();
        let mismatch = inspect(&runtime, &spec, &library).unwrap_err();
        spec.immutable_tree_sha256 = mismatch.details["actual_tree_sha256"].clone();
        let displaced = runtime.with_extension("displaced");
        fs::create_dir(&displaced).unwrap();
        // The fifth checkpoint is the second directory entry, regardless of
        // filesystem enumeration order. One of these objects is already hashed.
        let result = inspect_at_checkpoint(&runtime, &spec, &library, 5, || {
            for name in ["game.exe", "companion.dll"] {
                let path = runtime.join(name);
                let bytes = fs::read(&path).unwrap();
                let modified = fs::metadata(&path).unwrap().modified().unwrap();
                fs::rename(&path, displaced.join(name)).unwrap();
                fs::write(&path, bytes).unwrap();
                fs::File::options()
                    .write(true)
                    .open(&path)
                    .unwrap()
                    .set_modified(modified)
                    .unwrap();
            }
        });
        assert!(
            result.is_err(),
            "inspection ignored a previously hashed object"
        );
        for name in ["game.exe", "companion.dll"] {
            assert_eq!(
                fs::read(runtime.join(name)).unwrap(),
                fs::read(displaced.join(name)).unwrap()
            );
        }
    }

    #[test]
    fn inspection_identity_refuses_root_substitution_with_identical_files() {
        let (_temporary, library, runtime, spec) = fixture();
        let displaced = runtime.with_extension("displaced");
        // Root substitution occurs after root validation but before the first
        // entry is opened. Every newly observed file has accepted bytes.
        let result = inspect_at_checkpoint(&runtime, &spec, &library, 2, || {
            fs::rename(&runtime, &displaced).unwrap();
            fs::create_dir(&runtime).unwrap();
            fs::copy(displaced.join("game.exe"), runtime.join("game.exe")).unwrap();
        });
        assert!(
            result.is_err(),
            "inspection accepted a replacement runtime root"
        );
        assert_eq!(
            fs::read(displaced.join("game.exe")).unwrap(),
            b"accepted executable"
        );
        assert_eq!(
            fs::read(runtime.join("game.exe")).unwrap(),
            b"accepted executable"
        );
    }

    #[cfg(unix)]
    #[test]
    fn inspection_identity_refuses_symlink_substitution_without_touching_target() {
        let (temporary, library, runtime, spec) = fixture();
        let executable = runtime.join("game.exe");
        let displaced = temporary.path().join("displaced.exe");
        let outside = temporary.path().join("outside.exe");
        fs::write(&outside, b"replaced executable").unwrap();
        let result = inspect_at_checkpoint(&runtime, &spec, &library, 3, || {
            fs::rename(&executable, &displaced).unwrap();
            std::os::unix::fs::symlink(&outside, &executable).unwrap();
        });
        assert!(
            result.is_err(),
            "inspection accepted a redirected executable"
        );
        assert_eq!(fs::read(displaced).unwrap(), b"accepted executable");
        assert_eq!(fs::read(outside).unwrap(), b"replaced executable");
        assert!(
            fs::symlink_metadata(executable)
                .unwrap()
                .file_type()
                .is_symlink()
        );
    }

    #[test]
    fn inspection_identity_allows_unchanged_files_and_declared_mutable_writes() {
        let (_temporary, library, runtime, spec) = fixture();
        let inspected = inspect_at_checkpoint(&runtime, &spec, &library, 3, || {
            fs::create_dir(runtime.join("runtime-state")).unwrap();
            fs::write(runtime.join("runtime-state/save.dat"), b"player progress").unwrap();
        })
        .unwrap();
        assert_eq!(inspected.immutable_tree_sha256, spec.immutable_tree_sha256);
        assert_eq!(inspected.immutable_file_count, 1);
        inspect(&runtime, &spec, &library).unwrap();
        assert_eq!(
            fs::read(runtime.join("runtime-state/save.dat")).unwrap(),
            b"player progress"
        );
    }

    #[test]
    fn inspection_identity_final_inventory_refuses_added_removed_and_colliding_files() {
        for mutation in ["added", "removed", "collision"] {
            let (_temporary, library, runtime, spec) = fixture();
            let result = inspect_at_checkpoint(&runtime, &spec, &library, 5, || match mutation {
                "added" => fs::write(runtime.join("unexpected.dll"), b"foreign loader").unwrap(),
                "removed" => fs::remove_file(runtime.join("game.exe")).unwrap(),
                "collision" => fs::write(runtime.join("GAME.EXE"), b"foreign loader").unwrap(),
                _ => unreachable!(),
            });
            assert!(
                result.is_err(),
                "accepted final inventory mutation {mutation}"
            );
            if mutation == "added" {
                assert_eq!(
                    fs::read(runtime.join("unexpected.dll")).unwrap(),
                    b"foreign loader"
                );
            }
        }
    }

    #[test]
    fn inspection_identity_final_root_check_refuses_same_file_under_replaced_directory() {
        let (_temporary, library, runtime, spec) = fixture();
        let displaced = runtime.with_extension("displaced");
        let result = inspect_at_checkpoint(&runtime, &spec, &library, 5, || {
            fs::rename(&runtime, &displaced).unwrap();
            fs::create_dir(&runtime).unwrap();
            fs::hard_link(displaced.join("game.exe"), runtime.join("game.exe")).unwrap();
        });
        assert!(
            result.is_err(),
            "accepted a replaced root with the same executable object"
        );
        assert_eq!(
            fs::read(displaced.join("game.exe")).unwrap(),
            b"accepted executable"
        );
        assert_eq!(
            fs::read(runtime.join("game.exe")).unwrap(),
            b"accepted executable"
        );
    }

    #[test]
    fn inspection_identity_propagates_cancellation_before_hash_and_final_inventory() {
        for at in [1, 3, 5] {
            let (_temporary, library, runtime, spec) = fixture();
            let calls = std::cell::Cell::new(0);
            let error = inspect_with_checkpoint(&runtime, &spec, &library, &|| {
                calls.set(calls.get() + 1);
                if calls.get() == at {
                    return Err(PortcoveError::new(
                        crate::ErrorCode::Cancelled,
                        "fixture cancellation",
                    ));
                }
                Ok(())
            })
            .unwrap_err();
            assert_eq!(error.code, crate::ErrorCode::Cancelled);
            assert_eq!(error.message, "fixture cancellation");
            assert_eq!(calls.get(), at);
            assert_eq!(
                fs::read(runtime.join("game.exe")).unwrap(),
                b"accepted executable"
            );
        }
    }

    #[test]
    fn inspection_identity_refuses_growth_and_truncation_without_rewriting_bytes() {
        for bytes in [b"grown executable with extra bytes".as_slice(), b"short"] {
            let (_temporary, library, runtime, spec) = fixture();
            let result = inspect_at_checkpoint(&runtime, &spec, &library, 3, || {
                fs::write(runtime.join("game.exe"), bytes).unwrap();
            });
            assert!(result.is_err());
            assert_eq!(fs::read(runtime.join("game.exe")).unwrap(), bytes);
        }
    }

    #[test]
    fn inspection_identity_preserves_file_tree_and_entry_budgets() {
        let (_temporary, library, runtime, spec) = fixture();
        let original = fs::read(runtime.join("game.exe")).unwrap();
        for (mut seen, mut total_bytes) in [(MAX_FILES, 0), (0, MAX_TREE_BYTES)] {
            let result = visit(
                &runtime,
                &runtime,
                &spec,
                &mut BTreeMap::new(),
                &mut seen,
                &mut total_bytes,
                &mut InspectionPass::Hash(&|| Ok(())),
            );
            assert!(result.is_err());
            assert_eq!(fs::read(runtime.join("game.exe")).unwrap(), original);
        }
        fs::File::options()
            .write(true)
            .open(runtime.join("game.exe"))
            .unwrap()
            .set_len(MAX_FILE_BYTES + 1)
            .unwrap();
        assert!(inspect(&runtime, &spec, &library).is_err());
        assert_eq!(
            fs::metadata(runtime.join("game.exe")).unwrap().len(),
            MAX_FILE_BYTES + 1
        );
    }

    #[test]
    fn registered_location_observer_preserves_case_contract_and_defers_byte_identity() {
        let (_temporary, library, runtime, mut spec) = fixture();
        let record = location_record(&runtime, &spec, &library);
        spec.executable = "GAME.EXE".into();
        check_registered_location(&record, &spec, &library).unwrap();
        fs::write(record.path.join("runtime-state"), b"player data").unwrap();
        fs::write(&record.executable, b"changed executable").unwrap();
        // Status observes availability only. Full launch inspection must still
        // reject changed immutable bytes, even when the same path remains.
        check_registered_location(&record, &spec, &library).unwrap();
        assert!(inspect(&runtime, &spec, &library).is_err());
        assert_eq!(fs::read(record.executable).unwrap(), b"changed executable");
        assert_eq!(
            fs::read(runtime.join("runtime-state")).unwrap(),
            b"player data"
        );
    }

    #[test]
    fn registered_location_observer_refuses_missing_and_nonregular_paths_then_recovers() {
        let (_temporary, library, runtime, spec) = fixture();
        let record = location_record(&runtime, &spec, &library);
        fs::remove_file(&record.executable).unwrap();
        assert!(check_registered_location(&record, &spec, &library).is_err());
        fs::create_dir(&record.executable).unwrap();
        assert!(check_registered_location(&record, &spec, &library).is_err());
        fs::remove_dir(&record.executable).unwrap();
        fs::remove_dir(&runtime).unwrap();
        assert!(check_registered_location(&record, &spec, &library).is_err());
        fs::write(&runtime, b"not a directory").unwrap();
        assert!(check_registered_location(&record, &spec, &library).is_err());
        assert_eq!(fs::read(&runtime).unwrap(), b"not a directory");
        fs::remove_file(&runtime).unwrap();
        fs::create_dir(&runtime).unwrap();
        fs::write(&record.executable, b"accepted executable").unwrap();
        check_registered_location(&record, &spec, &library).unwrap();
    }

    #[test]
    fn registered_location_observer_refuses_platform_containment_and_contract_mismatch() {
        let (temporary, library, runtime, mut spec) = fixture();
        let record = location_record(&runtime, &spec, &library);
        let mut changed = record.clone();
        changed.platform = if record.platform == Platform::WindowsX86_64 {
            Platform::LinuxX86_64
        } else {
            Platform::WindowsX86_64
        };
        assert!(check_registered_location(&changed, &spec, &library).is_err());
        changed = record.clone();
        let foreign = temporary.path().join("foreign.exe");
        fs::write(&foreign, b"foreign runtime").unwrap();
        changed.executable = foreign.clone();
        assert!(check_registered_location(&changed, &spec, &library).is_err());
        changed = record.clone();
        changed.path = fs::canonicalize(&library).unwrap();
        assert!(check_registered_location(&changed, &spec, &library).is_err());
        assert!(check_registered_location(&record, &spec, &runtime).is_err());
        spec.executable = "different.exe".into();
        assert!(check_registered_location(&record, &spec, &library).is_err());
        assert_eq!(fs::read(foreign).unwrap(), b"foreign runtime");
        assert_eq!(fs::read(record.executable).unwrap(), b"accepted executable");
    }

    #[cfg(unix)]
    #[test]
    fn registered_location_observer_refuses_symlink_redirection_without_mutation() {
        use std::os::unix::fs::symlink;
        let (temporary, library, runtime, spec) = fixture();
        let record = location_record(&runtime, &spec, &library);
        let foreign = temporary.path().join("foreign.exe");
        fs::write(&foreign, b"foreign runtime").unwrap();
        fs::remove_file(&record.executable).unwrap();
        symlink(&foreign, &record.executable).unwrap();
        assert!(check_registered_location(&record, &spec, &library).is_err());
        assert!(
            fs::symlink_metadata(&record.executable)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert_eq!(fs::read(&foreign).unwrap(), b"foreign runtime");
        fs::remove_file(&record.executable).unwrap();
        fs::write(&record.executable, b"accepted executable").unwrap();
        let moved = temporary.path().join("moved-runtime");
        fs::rename(&runtime, &moved).unwrap();
        symlink(&moved, &runtime).unwrap();
        assert!(check_registered_location(&record, &spec, &library).is_err());
        assert!(
            fs::symlink_metadata(&runtime)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert_eq!(
            fs::read(moved.join("game.exe")).unwrap(),
            b"accepted executable"
        );
    }

    #[cfg(unix)]
    #[test]
    fn registered_location_observer_refuses_inaccessible_directory_then_recovers() {
        use std::os::unix::fs::PermissionsExt;
        let (_temporary, library, runtime, spec) = fixture();
        let record = location_record(&runtime, &spec, &library);
        let permissions = fs::metadata(&runtime).unwrap().permissions();
        fs::set_permissions(&runtime, fs::Permissions::from_mode(0o000)).unwrap();
        let refused = check_registered_location(&record, &spec, &library);
        fs::set_permissions(&runtime, permissions).unwrap();
        assert!(refused.is_err());
        check_registered_location(&record, &spec, &library).unwrap();
        assert_eq!(fs::read(record.executable).unwrap(), b"accepted executable");
    }

    #[test]
    fn accepted_external_runtime_rechecks_immutable_bytes_and_ignores_only_declared_output() {
        let (_temporary, library, runtime, spec) = fixture();
        let first = inspect(&runtime, &spec, &library).unwrap();
        assert_eq!(first.immutable_file_count, 1);
        fs::create_dir(runtime.join("runtime-state")).unwrap();
        fs::write(
            runtime.join("runtime-state").join("save.dat"),
            b"player data",
        )
        .unwrap();
        inspect(&runtime, &spec, &library).unwrap();
        fs::write(runtime.join("game.exe"), b"changed executable").unwrap();
        assert!(inspect(&runtime, &spec, &library).is_err());
        assert_eq!(
            fs::read(runtime.join("runtime-state").join("save.dat")).unwrap(),
            b"player data"
        );
    }

    #[test]
    fn unknown_extra_content_and_library_overlap_refuse_without_mutation() {
        let (_temporary, library, runtime, spec) = fixture();
        fs::write(runtime.join("other.dll"), b"foreign loader").unwrap();
        assert!(inspect(&runtime, &spec, &library).is_err());
        assert_eq!(
            fs::read(runtime.join("other.dll")).unwrap(),
            b"foreign loader"
        );
        assert!(inspect(&library, &spec, &library).is_err());
    }
}
