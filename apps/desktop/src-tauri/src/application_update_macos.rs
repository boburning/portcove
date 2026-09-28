//! Observation of a directly launched, user-owned macOS application bundle.
//!
//! Installed-bundle selection and journaled, post-exit native replacement.

use std::collections::BTreeSet;
use std::ffi::OsStr;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::thread;
use std::time::{Duration, Instant};

use portcove_core::{ChildProcessClass, ChildProcessPolicy};
use rustix::fs::{CWD, RenameFlags, renameat_with};
use sha2::{Digest, Sha256};

use crate::application_update::{
    APPLICATION_PRODUCT_ID, InstallOwner, InstalledApplicationContext,
    InstalledApplicationContextError,
};
use crate::application_update_apply::{
    ApplicationUpdateApplyError, ApplicationUpdateApplyStore, ApplicationUpdateNativeLaunchState,
    ApplicationUpdateNativeReplacement, ApplicationUpdateRevalidationLease,
};
use crate::application_update_macos_archive::extract_verified_macos_bundle_file;
use crate::application_update_staging::ApplicationUpdateStagingStore;

const BUNDLE_NAME: &str = "Portcove.app";
const EXECUTABLE_NAME: &str = "portcove-desktop";
const EXECUTION_CONTEXT: &str = "user-owned-app-bundle";
const TOOL_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_TOOL_OUTPUT: usize = 4096;
const MAX_BUNDLE_EXECUTABLE_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum MacosApplicationUpdateError {
    #[error("macOS installed-bundle update is unavailable: {0}")]
    Invalid(String),
    #[error("macOS bundle replacement requires recovery: {0}")]
    RecoveryRequired(String),
    #[error("macOS bundle replacement had an ambiguous result: {0}")]
    Ambiguous(String),
    #[error(
        "macOS bundle replacement failed: {replacement}; journal update also failed: {journal}"
    )]
    ReplacementAndJournal {
        replacement: String,
        journal: String,
    },
    #[error("macOS bundle update journal failed: {0}")]
    Apply(#[from] ApplicationUpdateApplyError),
    #[error("macOS bundle update I/O failed: {0}")]
    Io(#[from] std::io::Error),
}

pub struct MacosBundleUpdateAdmission {
    lease: ApplicationUpdateRevalidationLease,
    source: PathBuf,
    extraction_root: PathBuf,
    backup: PathBuf,
    archive: File,
    previous_bytes: u64,
    previous_sha256: String,
    target_version: String,
    target_architecture: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MacosApplicationUpdateReconciliation {
    NoAttempt,
    CandidateNotInstalled,
    Reconciled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MacosApplicationUpdateRecovery {
    NoAttempt,
    CandidateInstalled,
    RecoveredPreActivation,
}

fn macos_absolute_path(components: &[&str]) -> PathBuf {
    let mut path = PathBuf::from(std::path::MAIN_SEPARATOR.to_string());
    path.extend(components);
    path
}

fn unavailable(message: impl Into<String>) -> InstalledApplicationContextError {
    InstalledApplicationContextError::Unavailable(message.into())
}

fn bundle_from_executable(executable: &Path) -> Result<&Path, InstalledApplicationContextError> {
    let macos = executable
        .parent()
        .ok_or_else(|| unavailable("the running executable is outside Portcove.app"))?;
    let contents = macos
        .parent()
        .ok_or_else(|| unavailable("the running executable is outside Portcove.app"))?;
    let bundle = contents
        .parent()
        .ok_or_else(|| unavailable("the running executable is outside Portcove.app"))?;
    if executable.file_name() != Some(OsStr::new(EXECUTABLE_NAME))
        || macos.file_name() != Some(OsStr::new("MacOS"))
        || contents.file_name() != Some(OsStr::new("Contents"))
        || bundle.file_name() != Some(OsStr::new(BUNDLE_NAME))
    {
        return Err(unavailable(
            "the running executable is outside Portcove.app",
        ));
    }
    if executable
        .components()
        .any(|part| part.as_os_str() == OsStr::new("AppTranslocation"))
    {
        return Err(unavailable(
            "the translocated application must be moved to a writable installation before updating",
        ));
    }
    if executable.starts_with(macos_absolute_path(&["Volumes"])) {
        return Err(unavailable(
            "an application launched from a mounted volume needs a qualified permanent installation",
        ));
    }
    Ok(bundle)
}

fn require_owned_direct_path(
    path: &Path,
    directory: bool,
) -> Result<(), InstalledApplicationContextError> {
    let metadata = fs::symlink_metadata(path).map_err(|error| unavailable(error.to_string()))?;
    if metadata.file_type().is_symlink()
        || (directory && !metadata.is_dir())
        || (!directory && !metadata.is_file())
    {
        return Err(unavailable(
            "the installed bundle contains an indirect or invalid launch path",
        ));
    }
    if metadata.uid() != unsafe { libc::geteuid() } {
        return Err(unavailable(
            "the installed bundle is not owned by the current user",
        ));
    }
    let required = if directory { 0o700 } else { 0o400 };
    if metadata.permissions().mode() & required != required {
        return Err(unavailable(
            "the installed bundle is not readable and writable by its owner",
        ));
    }
    Ok(())
}

fn require_unlinked_ancestors(path: &Path) -> Result<(), InstalledApplicationContextError> {
    for ancestor in path.ancestors() {
        let metadata =
            fs::symlink_metadata(ancestor).map_err(|error| unavailable(error.to_string()))?;
        if metadata.file_type().is_symlink() {
            return Err(unavailable(
                "the installed bundle path has a linked ancestor",
            ));
        }
    }
    Ok(())
}

fn fixed_tool(
    path: &Path,
    arguments: &[&OsStr],
) -> Result<String, InstalledApplicationContextError> {
    let mut command = ChildProcessPolicy::native_command(ChildProcessClass::HostIntegration, path)
        .map_err(|error| unavailable(error.to_string()))?;
    let mut child = command
        .args(arguments)
        .env_clear()
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| unavailable(error.to_string()))?;
    let mut output = child
        .stdout
        .take()
        .ok_or_else(|| unavailable("the macOS inspection output is unavailable"))?;
    let reader = thread::spawn(move || {
        use std::io::Read;
        let mut bytes = Vec::new();
        output
            .take((MAX_TOOL_OUTPUT + 1) as u64)
            .read_to_end(&mut bytes)
            .map(|_| bytes)
    });
    let deadline = Instant::now() + TOOL_TIMEOUT;
    let status = loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| unavailable(error.to_string()))?
        {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            let _ = reader.join();
            return Err(unavailable("the macOS bundle inspection timed out"));
        }
        thread::sleep(Duration::from_millis(10));
    };
    let bytes = reader
        .join()
        .map_err(|_| unavailable("the macOS inspection reader failed"))?
        .map_err(|error| unavailable(error.to_string()))?;
    if !status.success() || bytes.len() > MAX_TOOL_OUTPUT {
        return Err(unavailable("the macOS bundle inspection failed"));
    }
    String::from_utf8(bytes)
        .map(|value| value.trim().to_owned())
        .map_err(|_| unavailable("the macOS inspection output is not UTF-8"))
}

pub fn current_macos_installed_application_context()
-> Result<InstalledApplicationContext, InstalledApplicationContextError> {
    let executable = std::env::current_exe().map_err(|error| unavailable(error.to_string()))?;
    let bundle = bundle_from_executable(&executable)?;
    let parent = bundle
        .parent()
        .ok_or_else(|| unavailable("the installed bundle has no parent"))?;
    require_unlinked_ancestors(parent)?;
    let contents = bundle.join("Contents");
    let macos = contents.join("MacOS");
    for path in [parent, bundle, &contents, &macos] {
        require_owned_direct_path(path, true)?;
    }
    require_owned_direct_path(&executable, false)?;
    if fs::symlink_metadata(&executable)
        .map_err(|error| unavailable(error.to_string()))?
        .permissions()
        .mode()
        & 0o100
        == 0
    {
        return Err(unavailable(
            "the installed bundle executable is not owner-executable",
        ));
    }
    let plist = bundle.join("Contents/Info.plist");
    require_owned_direct_path(&plist, false)?;
    let bundle_id = fixed_tool(
        &macos_absolute_path(&["usr", "libexec", "PlistBuddy"]),
        &[
            OsStr::new("-c"),
            OsStr::new("Print CFBundleIdentifier"),
            plist.as_os_str(),
        ],
    )?;
    let version = fixed_tool(
        &macos_absolute_path(&["usr", "libexec", "PlistBuddy"]),
        &[
            OsStr::new("-c"),
            OsStr::new("Print CFBundleShortVersionString"),
            plist.as_os_str(),
        ],
    )?;
    if bundle_id != APPLICATION_PRODUCT_ID || version != env!("CARGO_PKG_VERSION") {
        return Err(unavailable(
            "the installed bundle identity or version does not match this executable",
        ));
    }
    fixed_tool(
        &macos_absolute_path(&["usr", "bin", "codesign"]),
        &[
            OsStr::new("--verify"),
            OsStr::new("--deep"),
            OsStr::new("--strict"),
            bundle.as_os_str(),
        ],
    )?;
    macos_bundle_context_for_version(&version)
}

/// Describes the fixture identity without asserting that this process is in an
/// eligible bundle. Runtime selection must use `current_macos_installed_application_context`.
pub fn macos_bundle_context_for_version(
    version: &str,
) -> Result<InstalledApplicationContext, InstalledApplicationContextError> {
    let os_version = fixed_tool(
        &macos_absolute_path(&["usr", "bin", "sw_vers"]),
        &[OsStr::new("-productVersion")],
    )?;
    let architecture = std::env::consts::ARCH;
    let target = match architecture {
        "x86_64" => "darwin-x86_64",
        "aarch64" => "darwin-aarch64",
        _ => {
            return Err(unavailable(
                "this macOS process architecture has no qualified updater",
            ));
        }
    };
    let catalog_format = portcove_core::Catalog::embedded()
        .map_err(|error| unavailable(error.to_string()))?
        .document()
        .schema_version;
    Ok(InstalledApplicationContext {
        current_version: version.into(),
        target: target.into(),
        os: "macos".into(),
        os_version,
        architecture: architecture.into(),
        execution_context: EXECUTION_CONTEXT.into(),
        package_kind: "app.tar.gz".into(),
        install_owner: InstallOwner::Portcove,
        product_id: APPLICATION_PRODUCT_ID.into(),
        capabilities: BTreeSet::from([portcove_core::APPLICATION_UPDATE_LOCK_PROTOCOL.to_owned()]),
        cli_protocol: portcove_core::API_SCHEMA_VERSION,
        catalog_format,
        library_schema: portcove_core::MIN_LIBRARY_SCHEMA_VERSION,
        library_write_schema: portcove_core::LIBRARY_SCHEMA_VERSION,
        lock_protocol: portcove_core::APPLICATION_UPDATE_LOCK_PROTOCOL.into(),
    })
}

fn macos_error(message: impl Into<String>) -> MacosApplicationUpdateError {
    MacosApplicationUpdateError::Invalid(message.into())
}

fn current_bundle_path() -> Result<PathBuf, MacosApplicationUpdateError> {
    let executable = std::env::current_exe()?;
    let bundle =
        bundle_from_executable(&executable).map_err(|error| macos_error(error.to_string()))?;
    Ok(bundle.to_path_buf())
}

fn bundle_executable(bundle: &Path) -> PathBuf {
    bundle.join("Contents/MacOS/portcove-desktop")
}

fn executable_identity(bundle: &Path) -> Result<(u64, String), MacosApplicationUpdateError> {
    let executable = bundle_executable(bundle);
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(&executable)?;
    let metadata = file.metadata()?;
    if !metadata.is_file()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.len() == 0
        || metadata.len() > MAX_BUNDLE_EXECUTABLE_BYTES
        || metadata.permissions().mode() & 0o100 == 0
    {
        return Err(macos_error(
            "the bundle executable has no bounded owned identity",
        ));
    }
    let mut digest = Sha256::new();
    let mut bytes = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        bytes = bytes
            .checked_add(count as u64)
            .ok_or_else(|| macos_error("bundle size overflow"))?;
        digest.update(&buffer[..count]);
    }
    if bytes != metadata.len() {
        return Err(macos_error(
            "the bundle executable changed during inspection",
        ));
    }
    Ok((bytes, hex::encode(digest.finalize())))
}

fn verify_bundle_at(
    bundle: &Path,
    version: &str,
    architecture: &str,
) -> Result<(), MacosApplicationUpdateError> {
    if bundle.file_name() != Some(OsStr::new(BUNDLE_NAME)) {
        return Err(macos_error("the bundle has an unexpected name"));
    }
    let parent = bundle
        .parent()
        .ok_or_else(|| macos_error("the bundle has no parent"))?;
    require_unlinked_ancestors(parent).map_err(|error| macos_error(error.to_string()))?;
    for directory in [
        parent,
        bundle,
        &bundle.join("Contents"),
        &bundle.join("Contents/MacOS"),
    ] {
        require_owned_direct_path(directory, true)
            .map_err(|error| macos_error(error.to_string()))?;
    }
    let executable = bundle_executable(bundle);
    let plist = bundle.join("Contents/Info.plist");
    for file in [&executable, &plist] {
        require_owned_direct_path(file, false).map_err(|error| macos_error(error.to_string()))?;
    }
    let bundle_id = fixed_tool(
        &macos_absolute_path(&["usr", "libexec", "PlistBuddy"]),
        &[
            OsStr::new("-c"),
            OsStr::new("Print CFBundleIdentifier"),
            plist.as_os_str(),
        ],
    )
    .map_err(|error| macos_error(error.to_string()))?;
    let observed_version = fixed_tool(
        &macos_absolute_path(&["usr", "libexec", "PlistBuddy"]),
        &[
            OsStr::new("-c"),
            OsStr::new("Print CFBundleShortVersionString"),
            plist.as_os_str(),
        ],
    )
    .map_err(|error| macos_error(error.to_string()))?;
    let observed_architecture = fixed_tool(
        &macos_absolute_path(&["usr", "bin", "lipo"]),
        &[OsStr::new("-archs"), executable.as_os_str()],
    )
    .map_err(|error| macos_error(error.to_string()))?;
    let expected_architecture = if architecture == "aarch64" {
        "arm64"
    } else {
        architecture
    };
    if bundle_id != APPLICATION_PRODUCT_ID
        || observed_version != version
        || observed_architecture != expected_architecture
    {
        return Err(macos_error(
            "the bundle identifier, version or architecture differs from the authenticated release",
        ));
    }
    fixed_tool(
        &macos_absolute_path(&["usr", "bin", "codesign"]),
        &[
            OsStr::new("--verify"),
            OsStr::new("--deep"),
            OsStr::new("--strict"),
            bundle.as_os_str(),
        ],
    )
    .map_err(|error| macos_error(error.to_string()))?;
    Ok(())
}

fn verified_archive(
    path: &Path,
    expected_bytes: u64,
    expected_sha256: &str,
) -> Result<File, MacosApplicationUpdateError> {
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.len() != expected_bytes
    {
        return Err(macos_error("the staged archive identity changed"));
    }
    // The staging file can change after admission. Extract only the private,
    // unlinked snapshot whose exact bytes were hashed in this copy operation.
    let mut snapshot = tempfile::tempfile()?;
    let mut digest = Sha256::new();
    let mut bytes = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        bytes = bytes
            .checked_add(count as u64)
            .ok_or_else(|| macos_error("archive length overflow"))?;
        if bytes > expected_bytes {
            return Err(macos_error("the staged archive length changed"));
        }
        digest.update(&buffer[..count]);
        snapshot.write_all(&buffer[..count])?;
    }
    if bytes != expected_bytes || hex::encode(digest.finalize()) != expected_sha256 {
        return Err(macos_error("the staged archive hash changed"));
    }
    snapshot.seek(SeekFrom::Start(0))?;
    Ok(snapshot)
}

/// Adds user-owned bundle and exact staged archive authority to the shared
/// post-exit revalidation lease. All paths come from installed state, never IPC.
pub fn admit_macos_bundle_update(
    lease: ApplicationUpdateRevalidationLease,
) -> Result<MacosBundleUpdateAdmission, MacosApplicationUpdateError> {
    let intent = lease
        .state()
        .intent
        .as_ref()
        .ok_or_else(|| macos_error("the apply intent is missing"))?;
    let observed = current_macos_installed_application_context()
        .map_err(|error| macos_error(error.to_string()))?;
    if observed != intent.installed {
        return Err(macos_error(
            "the installed bundle changed after update selection",
        ));
    }
    let source = current_bundle_path()?;
    verify_bundle_at(
        &source,
        &intent.installed.current_version,
        &intent.installed.architecture,
    )?;
    let (previous_bytes, previous_sha256) = executable_identity(&source)?;
    let staged = lease.staged();
    let candidate = &staged.candidate.release;
    if candidate.target != observed.target
        || candidate.os != "macos"
        || candidate.architecture != observed.architecture
        || candidate.execution_context != EXECUTION_CONTEXT
        || candidate.package.kind != "app.tar.gz"
        || candidate.package.owner != InstallOwner::Portcove
        || candidate.package.product_id != APPLICATION_PRODUCT_ID
    {
        return Err(macos_error(
            "the staged candidate is not for this installed bundle",
        ));
    }
    let archive = verified_archive(
        &staged.payload_path,
        candidate.artifact.bytes,
        &candidate.artifact.sha256,
    )?;
    let parent = source
        .parent()
        .ok_or_else(|| macos_error("the installed bundle has no parent"))?;
    let digest_prefix = candidate
        .artifact
        .sha256
        .get(..16)
        .ok_or_else(|| macos_error("candidate digest is invalid"))?;
    let extraction_root = parent.join(format!(".portcove-update-{digest_prefix}"));
    let backup = extraction_root.join(BUNDLE_NAME);
    if fs::symlink_metadata(&extraction_root).is_ok() {
        return Err(MacosApplicationUpdateError::RecoveryRequired(
            "an earlier candidate extraction is retained; inspect it before retry".into(),
        ));
    }
    let target_version = candidate.version.clone();
    let target_architecture = candidate.architecture.clone();
    Ok(MacosBundleUpdateAdmission {
        lease,
        source,
        extraction_root,
        backup,
        archive,
        previous_bytes,
        previous_sha256,
        target_version,
        target_architecture,
    })
}

fn sync_parent(path: &Path) -> Result<(), MacosApplicationUpdateError> {
    let parent = path
        .parent()
        .ok_or_else(|| macos_error("the bundle path has no parent"))?;
    File::open(parent)?.sync_all()?;
    Ok(())
}

fn bundle_directory_identity(path: &Path) -> Result<(u64, u64), MacosApplicationUpdateError> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(macos_error("the bundle directory identity is unavailable"));
    }
    Ok((metadata.dev(), metadata.ino()))
}

impl MacosBundleUpdateAdmission {
    /// Atomically exchanges the fully verified candidate with the installed
    /// bundle. The former installed bundle stays in the journaled backup slot
    /// until the candidate completes ordinary healthy startup.
    pub fn launch(self) -> Result<(), MacosApplicationUpdateError> {
        let Self {
            lease,
            source,
            extraction_root,
            backup,
            archive,
            previous_bytes,
            previous_sha256,
            target_version,
            target_architecture,
        } = self;
        let launch = lease.begin_native_replacement(ApplicationUpdateNativeReplacement {
            source_path: source.clone(),
            backup_path: backup.clone(),
            previous_bytes,
            previous_sha256: previous_sha256.clone(),
        })?;
        let candidate_identity = (|| -> Result<(u64, String), MacosApplicationUpdateError> {
            fs::create_dir(&extraction_root)?;
            let extracted = extract_verified_macos_bundle_file(archive, &extraction_root)?;
            if extracted != backup {
                return Err(macos_error(
                    "the extracted bundle path differs from the journal",
                ));
            }
            verify_bundle_at(&backup, &target_version, &target_architecture)?;
            let candidate_identity = executable_identity(&backup)?;
            if executable_identity(&source)? != (previous_bytes, previous_sha256.clone()) {
                return Err(macos_error(
                    "the installed predecessor changed before replacement",
                ));
            }
            sync_parent(&backup)?;
            Ok(candidate_identity)
        })();
        let candidate_identity = match candidate_identity {
            Ok(identity) => identity,
            Err(error) => {
                return match launch.record_failed() {
                    Ok(_) => Err(error),
                    Err(journal) => Err(MacosApplicationUpdateError::ReplacementAndJournal {
                        replacement: error.to_string(),
                        journal: journal.to_string(),
                    }),
                };
            }
        };
        let source_directory = bundle_directory_identity(&source)?;
        let backup_directory = bundle_directory_identity(&backup)?;
        if let Err(error) = renameat_with(CWD, &source, CWD, &backup, RenameFlags::EXCHANGE) {
            if bundle_directory_identity(&source).ok() != Some(source_directory)
                || bundle_directory_identity(&backup).ok() != Some(backup_directory)
            {
                return Err(MacosApplicationUpdateError::Ambiguous(format!(
                    "atomic bundle exchange returned an error and unchanged directory identities could not be proven: {error}"
                )));
            }
            return match launch.record_failed() {
                Ok(_) => Err(macos_error(format!(
                    "atomic bundle exchange was refused: {error}"
                ))),
                Err(journal) => Err(MacosApplicationUpdateError::ReplacementAndJournal {
                    replacement: error.to_string(),
                    journal: journal.to_string(),
                }),
            };
        }
        let observed_candidate = executable_identity(&source).map_err(|error| {
            MacosApplicationUpdateError::Ambiguous(format!(
                "the bundle exchanged but candidate identity is unavailable: {error}"
            ))
        })?;
        let observed_predecessor = executable_identity(&backup).map_err(|error| {
            MacosApplicationUpdateError::Ambiguous(format!(
                "the bundle exchanged but predecessor identity is unavailable: {error}"
            ))
        })?;
        let observed_source_directory = bundle_directory_identity(&source).map_err(|error| {
            MacosApplicationUpdateError::Ambiguous(format!(
                "the bundle exchanged but the installed directory identity is unavailable: {error}"
            ))
        })?;
        let observed_backup_directory = bundle_directory_identity(&backup).map_err(|error| {
            MacosApplicationUpdateError::Ambiguous(format!(
                "the bundle exchanged but the backup directory identity is unavailable: {error}"
            ))
        })?;
        if observed_candidate != candidate_identity
            || observed_predecessor != (previous_bytes, previous_sha256)
            || observed_source_directory != backup_directory
            || observed_backup_directory != source_directory
        {
            return Err(MacosApplicationUpdateError::Ambiguous(
                "the atomic bundle exchange completed but its retained executable identities differ".into(),
            ));
        }
        sync_parent(&source).map_err(|error| {
            MacosApplicationUpdateError::Ambiguous(format!(
                "the bundle exchanged but its containing directory could not be synchronized: {error}"
            ))
        })?;
        sync_parent(&backup).map_err(|error| {
            MacosApplicationUpdateError::Ambiguous(format!(
                "the bundle exchanged but its backup directory could not be synchronized: {error}"
            ))
        })?;
        #[cfg(feature = "application-update-qualification")]
        if std::env::var_os("PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_INTERRUPT").as_deref()
            == Some(OsStr::new("after-bundle-swap"))
        {
            std::process::exit(86);
        }
        launch.record_succeeded().map_err(|error| {
            MacosApplicationUpdateError::Ambiguous(format!(
                "the bundle exchanged but success could not be recorded: {error}"
            ))
        })?;
        Ok(())
    }
}

fn expected_backup_path(
    source: &Path,
    candidate_sha256: &str,
) -> Result<PathBuf, MacosApplicationUpdateError> {
    let parent = source
        .parent()
        .ok_or_else(|| macos_error("the installed bundle has no parent"))?;
    let prefix = candidate_sha256
        .get(..16)
        .ok_or_else(|| macos_error("candidate digest is invalid"))?;
    Ok(parent
        .join(format!(".portcove-update-{prefix}"))
        .join(BUNDLE_NAME))
}

/// Clears the native intent only after the candidate itself has completed the
/// normal healthy startup boundary from the exact installed bundle path.
pub fn reconcile_macos_application_update(
    apply: &ApplicationUpdateApplyStore,
    staging: &ApplicationUpdateStagingStore,
) -> Result<MacosApplicationUpdateReconciliation, MacosApplicationUpdateError> {
    let state = apply.load()?;
    let Some(intent) = state.intent.as_ref() else {
        return Ok(MacosApplicationUpdateReconciliation::NoAttempt);
    };
    if state.native_launch.is_none() {
        return Ok(MacosApplicationUpdateReconciliation::NoAttempt);
    }
    if env!("CARGO_PKG_VERSION") != intent.candidate.release.version {
        return Ok(MacosApplicationUpdateReconciliation::CandidateNotInstalled);
    }
    let source = current_bundle_path()?;
    let replacement = state.native_replacement.as_ref().ok_or_else(|| {
        MacosApplicationUpdateError::RecoveryRequired(
            "the native attempt has no retained bundle identity".into(),
        )
    })?;
    if replacement.source_path != source
        || replacement.backup_path
            != expected_backup_path(&source, &intent.candidate.release.artifact.sha256)?
    {
        return Err(MacosApplicationUpdateError::RecoveryRequired(
            "the running bundle path differs from the retained replacement".into(),
        ));
    }
    verify_bundle_at(
        &source,
        &intent.candidate.release.version,
        &intent.candidate.release.architecture,
    )?;
    verify_bundle_at(
        &replacement.backup_path,
        &intent.installed.current_version,
        &intent.installed.architecture,
    )?;
    if executable_identity(&replacement.backup_path)?
        != (
            replacement.previous_bytes,
            replacement.previous_sha256.clone(),
        )
    {
        return Err(MacosApplicationUpdateError::RecoveryRequired(
            "the retained predecessor bundle identity changed".into(),
        ));
    }
    // Retire the apply journal before deleting the only retained predecessor.
    // An interruption here leaves a recoverable extra bundle, not an intent
    // that names a predecessor already removed from disk.
    apply.reconcile_installed_application(state.revision, env!("CARGO_PKG_VERSION"), staging)?;
    fs::remove_dir_all(&replacement.backup_path)?;
    fs::remove_dir(
        replacement
            .backup_path
            .parent()
            .ok_or_else(|| macos_error("backup has no parent"))?,
    )?;
    sync_parent(&source)?;
    Ok(MacosApplicationUpdateReconciliation::Reconciled)
}

/// Recovers an interrupted pre-swap helper only while the current process
/// holds the configured shared runtime guard and the predecessor still owns
/// the exact stable path. A post-swap candidate remains for reconciliation.
pub fn recover_macos_application_update_before_startup(
    runtime: &portcove_core::ApplicationRuntimeGuard,
    apply: &ApplicationUpdateApplyStore,
) -> Result<MacosApplicationUpdateRecovery, MacosApplicationUpdateError> {
    let configured = portcove_core::HostPreferenceStore::application_runtime_lock_path()
        .map_err(|error| macos_error(error.to_string()))?;
    if fs::canonicalize(configured)? != runtime.path() {
        return Err(MacosApplicationUpdateError::RecoveryRequired(
            "the runtime guard does not cover the configured update lock".into(),
        ));
    }
    let state = apply.load()?;
    if state.native_launch != Some(ApplicationUpdateNativeLaunchState::Starting) {
        return Ok(MacosApplicationUpdateRecovery::NoAttempt);
    }
    let intent = state.intent.as_ref().ok_or_else(|| {
        MacosApplicationUpdateError::RecoveryRequired("the interrupted update has no intent".into())
    })?;
    if env!("CARGO_PKG_VERSION") == intent.candidate.release.version {
        return Ok(MacosApplicationUpdateRecovery::CandidateInstalled);
    }
    if env!("CARGO_PKG_VERSION") != intent.installed.current_version {
        return Err(MacosApplicationUpdateError::RecoveryRequired(
            "the running bundle matches neither the predecessor nor candidate version".into(),
        ));
    }
    let source = current_bundle_path()?;
    let replacement = state.native_replacement.as_ref().ok_or_else(|| {
        MacosApplicationUpdateError::RecoveryRequired(
            "the interrupted update has no retained bundle identity".into(),
        )
    })?;
    if source != replacement.source_path
        || replacement.backup_path
            != expected_backup_path(&source, &intent.candidate.release.artifact.sha256)?
        || executable_identity(&source)?
            != (
                replacement.previous_bytes,
                replacement.previous_sha256.clone(),
            )
    {
        return Err(MacosApplicationUpdateError::RecoveryRequired(
            "the predecessor or backup path differs from the interrupted update".into(),
        ));
    }
    let extraction_root = replacement
        .backup_path
        .parent()
        .ok_or_else(|| macos_error("backup has no parent"))?;
    match fs::symlink_metadata(extraction_root) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
            verify_bundle_at(
                &replacement.backup_path,
                &intent.candidate.release.version,
                &intent.candidate.release.architecture,
            )
            .map_err(|error| {
                MacosApplicationUpdateError::RecoveryRequired(format!(
                    "the interrupted extraction is retained for inspection: {error}"
                ))
            })?;
            fs::remove_dir_all(&replacement.backup_path)?;
            fs::remove_dir(extraction_root)?;
            sync_parent(&source)?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Ok(_) => {
            return Err(MacosApplicationUpdateError::RecoveryRequired(
                "the interrupted extraction has an unexpected path type".into(),
            ));
        }
        Err(error) => return Err(error.into()),
    }
    apply.record_interrupted_native_replacement_failed(state.revision, replacement)?;
    Ok(MacosApplicationUpdateRecovery::RecoveredPreActivation)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_direct_portcove_bundle_launches_are_eligible() {
        assert_eq!(
            bundle_from_executable(Path::new(
                "/Users/a/Applications/Portcove.app/Contents/MacOS/portcove-desktop"
            ))
            .unwrap(),
            Path::new("/Users/a/Applications/Portcove.app")
        );
        assert!(
            bundle_from_executable(Path::new(
                "/Volumes/Portcove/Portcove.app/Contents/MacOS/portcove-desktop"
            ))
            .is_err()
        );
        assert!(
            bundle_from_executable(Path::new(
                "/private/var/AppTranslocation/Portcove.app/Contents/MacOS/portcove-desktop"
            ))
            .is_err()
        );
        assert!(
            bundle_from_executable(Path::new(
                "/Users/a/Applications/Other.app/Contents/MacOS/portcove-desktop"
            ))
            .is_err()
        );
    }

    #[test]
    fn linked_install_ancestor_is_refused() {
        let root = tempfile::tempdir().unwrap();
        let direct = root.path().join("direct");
        fs::create_dir(&direct).unwrap();
        fs::create_dir(direct.join("Portcove.app")).unwrap();
        let linked = root.path().join("linked");
        std::os::unix::fs::symlink(&direct, &linked).unwrap();
        assert!(require_unlinked_ancestors(&linked.join("Portcove.app")).is_err());
        assert!(require_unlinked_ancestors(&direct).is_ok());
    }
}
