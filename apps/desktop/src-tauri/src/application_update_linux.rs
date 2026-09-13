//! Linux AppImage ownership, replacement and installed-context observation.
//!
//! Only a directly executed, user-owned AppImage can opt into Portcove-managed
//! application updates. Package-manager and unpackaged builds have no APPIMAGE
//! identity and remain under their existing owner.

#[cfg(target_os = "linux")]
use std::collections::BTreeSet;
#[cfg(target_os = "linux")]
use std::fs::{self, File, OpenOptions};
#[cfg(target_os = "linux")]
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

#[cfg(target_os = "linux")]
use std::os::unix::ffi::OsStrExt;
#[cfg(target_os = "linux")]
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};

#[cfg(target_os = "linux")]
use rustix::fs::{CWD, RenameFlags, renameat_with};
#[cfg(target_os = "linux")]
use sha2::{Digest, Sha256};

#[cfg(target_os = "linux")]
use crate::application_update::{InstallOwner, InstalledApplicationContext, SelectedCandidate};
#[cfg(any(target_os = "linux", test))]
use crate::application_update_apply::ApplicationUpdateApplyError;
#[cfg(target_os = "linux")]
use crate::application_update_apply::{
    ApplicationUpdateApplyStore, ApplicationUpdateNativeReplacement,
    ApplicationUpdateRevalidationLease,
};
#[cfg(target_os = "linux")]
use crate::application_update_staging::{ApplicationUpdateStagingStore, StagedApplicationUpdate};

#[cfg(target_os = "linux")]
const LINUX_TARGET: &str = "linux-x86_64";
#[cfg(target_os = "linux")]
const LINUX_EXECUTION_CONTEXT: &str = "user-owned-appimage";
#[cfg(target_os = "linux")]
const PRODUCT_ID: &str = "portcove-desktop";

#[derive(Debug, thiserror::Error)]
pub enum LinuxApplicationUpdateError {
    #[error("this process is not running from an AppImage")]
    MissingAppImage,
    #[error("the AppImage execution environment is incomplete")]
    MissingAppDir,
    #[error("this AppImage path is not eligible for in-place updates: {0}")]
    InvalidPath(String),
    #[error("this AppImage is not owned by the current user")]
    DifferentOwner,
    #[error("this AppImage is not readable, executable and writable by its owner")]
    InvalidPermissions,
    #[error("this Linux architecture has no qualified AppImage updater")]
    UnsupportedArchitecture,
    #[error("the Linux kernel version could not be established")]
    MissingKernelVersion,
    #[error("the installed Portcove compatibility context is unavailable: {0}")]
    InstalledContext(String),
    #[error("the selected Linux application update is unsupported: {0}")]
    UnsupportedCandidate(String),
    #[error("the staged Linux application update is invalid: {0}")]
    InvalidPayload(String),
    #[error("Linux AppImage replacement requires recovery: {0}")]
    RecoveryRequired(String),
    #[error("Linux AppImage replacement has an ambiguous result: {0}")]
    Ambiguous(String),
    #[cfg(any(target_os = "linux", test))]
    #[error("Linux application update journal failed: {0}")]
    Apply(#[from] ApplicationUpdateApplyError),
    #[error(
        "Linux AppImage replacement failed before activation: {replacement}; journal update also failed: {journal}"
    )]
    ReplacementAndJournal {
        replacement: String,
        journal: String,
    },
    #[error("Linux AppImage inspection failed: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AppImageExecution {
    source: PathBuf,
    mount: PathBuf,
    executable: PathBuf,
}

#[cfg(target_os = "linux")]
struct LinuxAppImageUpdatePlan {
    source: PathBuf,
    swap: PathBuf,
    source_guard: File,
    staged_payload: File,
    swap_guard: Option<File>,
    expected_bytes: u64,
    expected_sha256: String,
    previous_bytes: u64,
    previous_sha256: String,
    permissions: fs::Permissions,
}

/// Holds every shared update lease plus the exact AppImage paths and file
/// handles needed for one atomic Linux replacement.
#[cfg(target_os = "linux")]
pub struct LinuxAppImageUpdateAdmission {
    lease: ApplicationUpdateRevalidationLease,
    plan: LinuxAppImageUpdatePlan,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinuxApplicationUpdateReconciliation {
    NoAttempt,
    CandidateNotInstalled,
    Reconciled,
}

#[cfg(target_os = "linux")]
impl LinuxAppImageUpdateAdmission {
    /// Publishes a complete candidate with Linux `RENAME_EXCHANGE`, keeping
    /// the previous AppImage in the swap slot until healthy startup.
    pub fn launch(self) -> Result<(), LinuxApplicationUpdateError> {
        let Self { lease, mut plan } = self;
        let launch = lease.begin_native_replacement(ApplicationUpdateNativeReplacement {
            source_path: plan.source.clone(),
            backup_path: plan.swap.clone(),
            previous_bytes: plan.previous_bytes,
            previous_sha256: plan.previous_sha256.clone(),
        })?;
        if let Err(error) = prepare_appimage_swap(&mut plan) {
            return match launch.record_failed() {
                Ok(_) => Err(error),
                Err(journal) => Err(LinuxApplicationUpdateError::ReplacementAndJournal {
                    replacement: error.to_string(),
                    journal: journal.to_string(),
                }),
            };
        }
        if let Err(error) = exchange_appimage(&plan) {
            let _ = fs::remove_file(&plan.swap);
            return match launch.record_failed() {
                Ok(_) => Err(error),
                Err(journal) => Err(LinuxApplicationUpdateError::ReplacementAndJournal {
                    replacement: error.to_string(),
                    journal: journal.to_string(),
                }),
            };
        }
        verify_exchanged_appimage(&plan).map_err(|error| {
            LinuxApplicationUpdateError::Ambiguous(format!(
                "the stable AppImage path was exchanged but its retained identities could not be confirmed: {error}"
            ))
        })?;
        sync_parent(&plan.source).map_err(|error| {
            LinuxApplicationUpdateError::Ambiguous(format!(
                "the stable AppImage path was exchanged but its directory could not be synchronized: {error}"
            ))
        })?;
        launch.record_succeeded().map_err(|error| {
            LinuxApplicationUpdateError::Ambiguous(format!(
                "the stable AppImage path was exchanged but success could not be recorded: {error}"
            ))
        })?;
        Ok(())
    }
}

/// Adds direct, user-owned AppImage replacement authority to an already fresh
/// update lease. No path supplied by IPC participates in this decision.
#[cfg(target_os = "linux")]
pub fn admit_linux_appimage_update(
    lease: ApplicationUpdateRevalidationLease,
) -> Result<LinuxAppImageUpdateAdmission, LinuxApplicationUpdateError> {
    let execution = current_linux_appimage_execution()?;
    let intent = lease.state().intent.as_ref().ok_or_else(|| {
        LinuxApplicationUpdateError::UnsupportedCandidate(
            "the retained apply lease has no intent".into(),
        )
    })?;
    let plan =
        evaluate_linux_appimage_update(lease.staged(), &intent.installed, &execution.source)?;
    Ok(LinuxAppImageUpdateAdmission { lease, plan })
}

/// Clears a native attempt only after the candidate's exact bytes are running
/// from the same direct AppImage path past the normal startup-health boundary.
#[cfg(target_os = "linux")]
pub fn reconcile_linux_application_update(
    apply: &ApplicationUpdateApplyStore,
    staging: &ApplicationUpdateStagingStore,
) -> Result<LinuxApplicationUpdateReconciliation, LinuxApplicationUpdateError> {
    let state = apply.load()?;
    let Some(intent) = state.intent.as_ref() else {
        return Ok(LinuxApplicationUpdateReconciliation::NoAttempt);
    };
    if state.native_launch.is_none() {
        return Ok(LinuxApplicationUpdateReconciliation::NoAttempt);
    }
    validate_linux_candidate(&intent.candidate, &intent.installed)?;
    let current_version = env!("CARGO_PKG_VERSION");
    if current_version != intent.candidate.release.version {
        return Ok(LinuxApplicationUpdateReconciliation::CandidateNotInstalled);
    }
    let execution = current_linux_appimage_execution()?;
    let replacement = state.native_replacement.as_ref().ok_or_else(|| {
        LinuxApplicationUpdateError::RecoveryRequired(
            "the native attempt has no retained AppImage replacement identity".into(),
        )
    })?;
    if replacement.source_path != execution.source {
        return Err(LinuxApplicationUpdateError::RecoveryRequired(
            "the running AppImage source differs from the retained replacement path".into(),
        ));
    }
    verify_file_identity(
        &execution.source,
        intent.candidate.release.artifact.bytes,
        &intent.candidate.release.artifact.sha256,
        true,
    )?;
    let swap = appimage_swap_path(&execution.source, &intent.candidate.release.artifact.sha256)?;
    if replacement.backup_path != swap {
        return Err(LinuxApplicationUpdateError::RecoveryRequired(
            "the retained AppImage backup path differs from the candidate identity".into(),
        ));
    }
    remove_verified_backup_if_present(
        &swap,
        replacement.previous_bytes,
        &replacement.previous_sha256,
    )?;
    sync_parent(&execution.source)?;
    apply.reconcile_installed_application(state.revision, current_version, staging)?;
    Ok(LinuxApplicationUpdateReconciliation::Reconciled)
}

/// Observes only the AppImage identity supplied by the native runtime. APPIMAGE
/// is the stable source path; current_exe points into the temporary mount and
/// must remain below APPDIR so an injected environment cannot claim ownership.
#[cfg(target_os = "linux")]
pub fn current_linux_appimage_context()
-> Result<InstalledApplicationContext, LinuxApplicationUpdateError> {
    let _execution = current_linux_appimage_execution()?;
    let kernel =
        std::fs::read_to_string(linux_absolute_path(&["proc", "sys", "kernel", "osrelease"]))?;
    let os_version = canonical_kernel_version(&kernel)
        .ok_or(LinuxApplicationUpdateError::MissingKernelVersion)?;
    let catalog_format = portcove_core::Catalog::embedded()
        .map_err(|error| LinuxApplicationUpdateError::InstalledContext(error.to_string()))?
        .document()
        .schema_version;

    Ok(InstalledApplicationContext {
        current_version: env!("CARGO_PKG_VERSION").into(),
        target: LINUX_TARGET.into(),
        os: "linux".into(),
        os_version,
        architecture: std::env::consts::ARCH.into(),
        execution_context: LINUX_EXECUTION_CONTEXT.into(),
        package_kind: "appimage".into(),
        install_owner: InstallOwner::Portcove,
        product_id: PRODUCT_ID.into(),
        capabilities: BTreeSet::from([portcove_core::APPLICATION_UPDATE_LOCK_PROTOCOL.to_owned()]),
        cli_protocol: portcove_core::API_SCHEMA_VERSION,
        catalog_format,
        library_schema: portcove_core::MIN_LIBRARY_SCHEMA_VERSION,
        library_write_schema: portcove_core::LIBRARY_SCHEMA_VERSION,
        lock_protocol: portcove_core::APPLICATION_UPDATE_LOCK_PROTOCOL.into(),
    })
}

#[cfg(target_os = "linux")]
fn current_linux_appimage_execution() -> Result<AppImageExecution, LinuxApplicationUpdateError> {
    if std::env::consts::ARCH != "x86_64" {
        return Err(LinuxApplicationUpdateError::UnsupportedArchitecture);
    }
    let execution = inspect_appimage_execution(
        std::env::var_os("APPIMAGE").map(PathBuf::from),
        std::env::var_os("APPDIR").map(PathBuf::from),
        std::env::current_exe()?,
        std::env::temp_dir(),
    )?;
    let mount_table = fs::read(linux_absolute_path(&["proc", "self", "mountinfo"]))?;
    if !is_native_appimage_mount(&execution.mount, &mount_table) {
        return Err(LinuxApplicationUpdateError::InvalidPath(
            "the runtime mount is not a read-only AppImage FUSE mount".into(),
        ));
    }
    require_owned_appimage(&execution.source)?;
    Ok(execution)
}

#[cfg(target_os = "linux")]
pub fn current_linux_appimage_source() -> Result<PathBuf, LinuxApplicationUpdateError> {
    Ok(current_linux_appimage_execution()?.source)
}

#[cfg(target_os = "linux")]
fn evaluate_linux_appimage_update(
    staged: &StagedApplicationUpdate,
    installed: &InstalledApplicationContext,
    source: &Path,
) -> Result<LinuxAppImageUpdatePlan, LinuxApplicationUpdateError> {
    validate_linux_candidate(&staged.candidate, installed)?;
    let source = direct_absolute_path(source)?;
    let source_metadata = require_owned_appimage(&source)?;
    let source_guard = open_path_guard(&source)?;
    require_same_file(&source, &source_guard, "AppImage source")?;
    let (previous_bytes, previous_sha256) = read_appimage_identity(&source)?;
    require_same_file(&source, &source_guard, "AppImage source")?;
    let staged_payload = verify_file_identity(
        &staged.payload_path,
        staged.candidate.release.artifact.bytes,
        &staged.candidate.release.artifact.sha256,
        true,
    )?;
    let swap = appimage_swap_path(&source, &staged.candidate.release.artifact.sha256)?;
    Ok(LinuxAppImageUpdatePlan {
        source,
        swap,
        source_guard,
        staged_payload,
        swap_guard: None,
        expected_bytes: staged.candidate.release.artifact.bytes,
        expected_sha256: staged.candidate.release.artifact.sha256.clone(),
        previous_bytes,
        previous_sha256,
        permissions: fs::Permissions::from_mode(source_metadata.permissions().mode() & 0o777),
    })
}

#[cfg(target_os = "linux")]
fn validate_linux_candidate(
    candidate: &SelectedCandidate,
    installed: &InstalledApplicationContext,
) -> Result<(), LinuxApplicationUpdateError> {
    let release = &candidate.release;
    if release.target != LINUX_TARGET
        || release.os != "linux"
        || release.architecture != "x86_64"
        || release.execution_context != LINUX_EXECUTION_CONTEXT
        || release.package.kind != "appimage"
        || release.package.owner != InstallOwner::Portcove
        || release.package.product_id != PRODUCT_ID
    {
        return Err(LinuxApplicationUpdateError::UnsupportedCandidate(
            "the release target, package or ownership identity does not match".into(),
        ));
    }
    if installed.target != LINUX_TARGET
        || installed.os != "linux"
        || installed.architecture != "x86_64"
        || installed.execution_context != LINUX_EXECUTION_CONTEXT
        || installed.package_kind != "appimage"
        || installed.install_owner != InstallOwner::Portcove
        || installed.product_id != PRODUCT_ID
    {
        return Err(LinuxApplicationUpdateError::UnsupportedCandidate(
            "the installed application is not a Portcove-owned x86_64 AppImage".into(),
        ));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn require_owned_appimage(path: &Path) -> Result<fs::Metadata, LinuxApplicationUpdateError> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(LinuxApplicationUpdateError::InvalidPath(
            "the source is not a direct file".into(),
        ));
    }
    if metadata.uid() != unsafe { libc::geteuid() } {
        return Err(LinuxApplicationUpdateError::DifferentOwner);
    }
    let mode = metadata.permissions().mode();
    if mode & 0o700 != 0o700 {
        return Err(LinuxApplicationUpdateError::InvalidPermissions);
    }
    Ok(metadata)
}

#[cfg(target_os = "linux")]
fn open_path_guard(path: &Path) -> Result<File, LinuxApplicationUpdateError> {
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_PATH | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .map_err(Into::into)
}

#[cfg(target_os = "linux")]
fn read_appimage_identity(path: &Path) -> Result<(u64, String), LinuxApplicationUpdateError> {
    let path = direct_absolute_path(path)?;
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.len() == 0
        || metadata.len() > 2 * 1024 * 1024 * 1024
    {
        return Err(LinuxApplicationUpdateError::InvalidPayload(
            "the current AppImage has no bounded current-user file identity".into(),
        ));
    }
    require_x86_64_appimage_header(&mut file)?;
    file.seek(SeekFrom::Start(0))?;
    let mut digest = Sha256::new();
    let mut bytes = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        bytes = bytes.checked_add(count as u64).ok_or_else(|| {
            LinuxApplicationUpdateError::InvalidPayload(
                "the current AppImage length overflowed".into(),
            )
        })?;
        digest.update(&buffer[..count]);
    }
    if bytes != metadata.len() {
        return Err(LinuxApplicationUpdateError::InvalidPayload(
            "the current AppImage length changed while it was inspected".into(),
        ));
    }
    Ok((bytes, hex::encode(digest.finalize())))
}

#[cfg(target_os = "linux")]
fn verify_file_identity(
    path: &Path,
    expected_bytes: u64,
    expected_sha256: &str,
    require_appimage: bool,
) -> Result<File, LinuxApplicationUpdateError> {
    let path = direct_absolute_path(path)?;
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(&path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.uid() != unsafe { libc::geteuid() } {
        return Err(LinuxApplicationUpdateError::InvalidPayload(
            "the payload is not a current-user regular file".into(),
        ));
    }
    if metadata.len() != expected_bytes {
        return Err(LinuxApplicationUpdateError::InvalidPayload(
            "the payload length changed after staging".into(),
        ));
    }
    if require_appimage {
        require_x86_64_appimage_header(&mut file)?;
        file.seek(SeekFrom::Start(0))?;
    }
    let mut digest = Sha256::new();
    let mut bytes = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        bytes = bytes.checked_add(count as u64).ok_or_else(|| {
            LinuxApplicationUpdateError::InvalidPayload("the payload length overflowed".into())
        })?;
        digest.update(&buffer[..count]);
    }
    if bytes != expected_bytes || hex::encode(digest.finalize()) != expected_sha256 {
        return Err(LinuxApplicationUpdateError::InvalidPayload(
            "the payload digest changed after staging".into(),
        ));
    }
    file.seek(SeekFrom::Start(0))?;
    Ok(file)
}

#[cfg(target_os = "linux")]
fn require_x86_64_appimage_header(file: &mut File) -> Result<(), LinuxApplicationUpdateError> {
    let mut header = [0_u8; 20];
    file.read_exact(&mut header).map_err(|_| {
        LinuxApplicationUpdateError::InvalidPayload(
            "the payload is too short to be an x86_64 AppImage".into(),
        )
    })?;
    if header[..4] != *b"\x7fELF"
        || header[4] != 2
        || header[5] != 1
        || header[8..11] != *b"AI\x02"
        || header[18..20] != [0x3e, 0]
    {
        return Err(LinuxApplicationUpdateError::InvalidPayload(
            "the payload is not a little-endian x86_64 type 2 AppImage".into(),
        ));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn appimage_swap_path(
    source: &Path,
    candidate_sha256: &str,
) -> Result<PathBuf, LinuxApplicationUpdateError> {
    if candidate_sha256.len() != 64
        || !candidate_sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(LinuxApplicationUpdateError::InvalidPayload(
            "the candidate SHA-256 is invalid".into(),
        ));
    }
    let parent = source.parent().ok_or_else(|| {
        LinuxApplicationUpdateError::InvalidPath("the source has no parent directory".into())
    })?;
    Ok(parent.join(format!(
        ".portcove-appimage-{}.swap",
        &candidate_sha256[..16]
    )))
}

#[cfg(target_os = "linux")]
fn prepare_appimage_swap(
    plan: &mut LinuxAppImageUpdatePlan,
) -> Result<(), LinuxApplicationUpdateError> {
    match fs::symlink_metadata(&plan.swap) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
        Ok(_) => {
            if verify_file_identity(&plan.swap, plan.expected_bytes, &plan.expected_sha256, true)
                .is_err()
            {
                return Err(LinuxApplicationUpdateError::RecoveryRequired(format!(
                    "the retained swap file {} does not match the pending candidate",
                    plan.swap.display()
                )));
            }
            fs::remove_file(&plan.swap)?;
            sync_parent(&plan.source)?;
        }
    }

    plan.staged_payload.seek(SeekFrom::Start(0))?;
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(&plan.swap)?;
    let operation = (|| -> Result<(), LinuxApplicationUpdateError> {
        let mut digest = Sha256::new();
        let mut bytes = 0_u64;
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let count = plan.staged_payload.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            bytes = bytes.checked_add(count as u64).ok_or_else(|| {
                LinuxApplicationUpdateError::InvalidPayload(
                    "the copied payload length overflowed".into(),
                )
            })?;
            if bytes > plan.expected_bytes {
                return Err(LinuxApplicationUpdateError::InvalidPayload(
                    "the copied payload exceeds its authenticated length".into(),
                ));
            }
            digest.update(&buffer[..count]);
            output.write_all(&buffer[..count])?;
        }
        if bytes != plan.expected_bytes || hex::encode(digest.finalize()) != plan.expected_sha256 {
            return Err(LinuxApplicationUpdateError::InvalidPayload(
                "the copied payload does not match its authenticated identity".into(),
            ));
        }
        output.set_permissions(plan.permissions.clone())?;
        output.sync_all()?;
        require_same_file(&plan.source, &plan.source_guard, "AppImage source")?;
        require_same_file(&plan.swap, &output, "prepared AppImage swap")?;
        Ok(())
    })();
    if let Err(error) = operation {
        drop(output);
        let _ = fs::remove_file(&plan.swap);
        return Err(error);
    }
    plan.swap_guard = Some(output);
    Ok(())
}

#[cfg(target_os = "linux")]
fn exchange_appimage(plan: &LinuxAppImageUpdatePlan) -> Result<(), LinuxApplicationUpdateError> {
    let swap_guard = plan.swap_guard.as_ref().ok_or_else(|| {
        LinuxApplicationUpdateError::InvalidPayload("the prepared swap file is unavailable".into())
    })?;
    require_same_file(&plan.source, &plan.source_guard, "AppImage source")?;
    require_same_file(&plan.swap, swap_guard, "prepared AppImage swap")?;
    renameat_with(CWD, &plan.source, CWD, &plan.swap, RenameFlags::EXCHANGE)
        .map_err(std::io::Error::from)?;
    Ok(())
}

#[cfg(target_os = "linux")]
fn verify_exchanged_appimage(
    plan: &LinuxAppImageUpdatePlan,
) -> Result<(), LinuxApplicationUpdateError> {
    let swap_guard = plan.swap_guard.as_ref().ok_or_else(|| {
        LinuxApplicationUpdateError::InvalidPayload("the prepared swap file is unavailable".into())
    })?;
    require_same_file(&plan.source, swap_guard, "activated AppImage")?;
    require_same_file(&plan.swap, &plan.source_guard, "retained AppImage backup")?;
    Ok(())
}

#[cfg(target_os = "linux")]
fn require_same_file(
    path: &Path,
    guard: &File,
    label: &str,
) -> Result<(), LinuxApplicationUpdateError> {
    let path_metadata = fs::symlink_metadata(path)?;
    let guard_metadata = guard.metadata()?;
    if !path_metadata.is_file()
        || path_metadata.file_type().is_symlink()
        || path_metadata.dev() != guard_metadata.dev()
        || path_metadata.ino() != guard_metadata.ino()
    {
        return Err(LinuxApplicationUpdateError::InvalidPath(format!(
            "the {label} path changed during replacement"
        )));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn remove_verified_backup_if_present(
    path: &Path,
    expected_bytes: u64,
    expected_sha256: &str,
) -> Result<(), LinuxApplicationUpdateError> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
        Ok(_) => {}
    }
    verify_file_identity(path, expected_bytes, expected_sha256, true).map_err(|error| {
        LinuxApplicationUpdateError::RecoveryRequired(format!(
            "the retained AppImage backup {} does not match its recorded identity: {error}",
            path.display()
        ))
    })?;
    fs::remove_file(path)?;
    Ok(())
}

#[cfg(target_os = "linux")]
fn sync_parent(path: &Path) -> Result<(), LinuxApplicationUpdateError> {
    let parent = path.parent().ok_or_else(|| {
        LinuxApplicationUpdateError::InvalidPath("the AppImage has no parent directory".into())
    })?;
    File::open(parent)?.sync_all()?;
    Ok(())
}

#[cfg(target_os = "linux")]
fn linux_absolute_path(components: &[&str]) -> PathBuf {
    let mut path = PathBuf::from(std::path::MAIN_SEPARATOR.to_string());
    path.extend(components);
    path
}

#[cfg(target_os = "linux")]
fn is_native_appimage_mount(mount: &Path, mount_table: &[u8]) -> bool {
    let expected_mount = mount.as_os_str().as_bytes();
    mount_table.split(|byte| *byte == b'\n').any(|line| {
        let fields = line
            .split(|byte| byte.is_ascii_whitespace())
            .filter(|field| !field.is_empty())
            .collect::<Vec<_>>();
        let Some(separator) = fields.iter().position(|field| *field == b"-") else {
            return false;
        };
        fields
            .get(4)
            .is_some_and(|field| unescape_mountinfo_field(field).as_slice() == expected_mount)
            && fields
                .get(5)
                .is_some_and(|options| mount_option(options, b"ro"))
            && fields
                .get(separator + 1)
                .is_some_and(|filesystem| filesystem.starts_with(b"fuse."))
    })
}

#[cfg(target_os = "linux")]
fn mount_option(options: &[u8], expected: &[u8]) -> bool {
    options
        .split(|byte| *byte == b',')
        .any(|option| option == expected)
}

#[cfg(target_os = "linux")]
fn unescape_mountinfo_field(field: &[u8]) -> Vec<u8> {
    let mut decoded = Vec::with_capacity(field.len());
    let mut index = 0;
    while index < field.len() {
        if field[index] == b'\\' && index + 3 < field.len() {
            let octal = &field[index + 1..index + 4];
            if octal.iter().all(|byte| (b'0'..=b'7').contains(byte)) {
                let value = u16::from(octal[0] - b'0') * 64
                    + u16::from(octal[1] - b'0') * 8
                    + u16::from(octal[2] - b'0');
                if let Ok(value) = u8::try_from(value) {
                    decoded.push(value);
                    index += 4;
                    continue;
                }
            }
        }
        decoded.push(field[index]);
        index += 1;
    }
    decoded
}

fn inspect_appimage_execution(
    source: Option<PathBuf>,
    mount: Option<PathBuf>,
    executable: PathBuf,
    temporary_directory: PathBuf,
) -> Result<AppImageExecution, LinuxApplicationUpdateError> {
    let source = source.ok_or(LinuxApplicationUpdateError::MissingAppImage)?;
    let mount = mount.ok_or(LinuxApplicationUpdateError::MissingAppDir)?;
    for (path, label) in [
        (&source, "source"),
        (&mount, "mount"),
        (&executable, "executable"),
        (&temporary_directory, "temporary directory"),
    ] {
        if !path.is_absolute() {
            return Err(LinuxApplicationUpdateError::InvalidPath(format!(
                "the {label} path is not absolute"
            )));
        }
    }
    let mount = std::fs::canonicalize(mount)?;
    let temporary_directory = std::fs::canonicalize(temporary_directory)?;
    if mount.parent() != Some(temporary_directory.as_path())
        || !mount
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with(".mount_") && name.len() > ".mount_".len())
    {
        return Err(LinuxApplicationUpdateError::InvalidPath(
            "the runtime mount is not a native AppImage mount".into(),
        ));
    }
    let executable = std::fs::canonicalize(executable)?;
    if !executable.starts_with(&mount) || executable == mount {
        return Err(LinuxApplicationUpdateError::InvalidPath(
            "the running executable is outside the AppImage mount".into(),
        ));
    }
    let source = direct_absolute_path(&source)?;
    Ok(AppImageExecution {
        source,
        mount,
        executable,
    })
}

fn direct_absolute_path(path: &Path) -> Result<PathBuf, LinuxApplicationUpdateError> {
    let parent = path.parent().ok_or_else(|| {
        LinuxApplicationUpdateError::InvalidPath("the source has no parent directory".into())
    })?;
    let name = path.file_name().ok_or_else(|| {
        LinuxApplicationUpdateError::InvalidPath("the source has no filename".into())
    })?;
    refuse_symlink_ancestors(parent)?;
    let parent = std::fs::canonicalize(parent)?;
    let direct = parent.join(name);
    let canonical = std::fs::canonicalize(path)?;
    if direct != canonical {
        return Err(LinuxApplicationUpdateError::InvalidPath(
            "the source resolves through a link".into(),
        ));
    }
    Ok(direct)
}

fn refuse_symlink_ancestors(path: &Path) -> Result<(), LinuxApplicationUpdateError> {
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component.as_os_str());
        let metadata = std::fs::symlink_metadata(&current)?;
        if metadata.file_type().is_symlink() {
            return Err(LinuxApplicationUpdateError::InvalidPath(
                "the source has a linked ancestor".into(),
            ));
        }
    }
    Ok(())
}

fn canonical_kernel_version(value: &str) -> Option<String> {
    let mut numbers = value
        .trim()
        .split(|character: char| !character.is_ascii_digit());
    let major = numbers.next()?.parse::<u64>().ok()?;
    let minor = numbers.next()?.parse::<u64>().ok()?;
    let patch = numbers.next().unwrap_or("0").parse::<u64>().ok()?;
    Some(format!("{major}.{minor}.{patch}"))
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::TempDir;

    use super::*;

    #[test]
    fn appimage_execution_requires_complete_absolute_runtime_identity() {
        let root = TempDir::new().unwrap();
        let source = root.path().join("Portcove.AppImage");
        let temporary_directory = root.path().join("temp");
        let mount = temporary_directory.join(".mount_Portcove");
        let executable = mount.join("usr/bin/portcove-desktop");
        fs::write(&source, b"appimage").unwrap();
        fs::create_dir(&temporary_directory).unwrap();
        fs::create_dir_all(executable.parent().unwrap()).unwrap();
        fs::write(&executable, b"binary").unwrap();
        let outside = root.path().join("outside");
        fs::write(&outside, b"binary").unwrap();

        let observed = inspect_appimage_execution(
            Some(source.clone()),
            Some(mount.clone()),
            executable.clone(),
            temporary_directory.clone(),
        )
        .unwrap();
        assert_eq!(observed.source, fs::canonicalize(&source).unwrap());
        assert!(matches!(
            inspect_appimage_execution(
                None,
                Some(mount.clone()),
                executable.clone(),
                temporary_directory.clone()
            ),
            Err(LinuxApplicationUpdateError::MissingAppImage)
        ));
        assert!(matches!(
            inspect_appimage_execution(
                Some(source.clone()),
                None,
                executable.clone(),
                temporary_directory.clone()
            ),
            Err(LinuxApplicationUpdateError::MissingAppDir)
        ));
        assert!(matches!(
            inspect_appimage_execution(
                Some(source.clone()),
                Some(mount.clone()),
                outside,
                temporary_directory.clone()
            ),
            Err(LinuxApplicationUpdateError::InvalidPath(_))
        ));
        assert!(matches!(
            inspect_appimage_execution(
                Some(PathBuf::from("Portcove.AppImage")),
                Some(mount.clone()),
                executable.clone(),
                temporary_directory.clone()
            ),
            Err(LinuxApplicationUpdateError::InvalidPath(_))
        ));
        let forged_mount = temporary_directory.join("ordinary-directory");
        let forged_executable = forged_mount.join("portcove-desktop");
        fs::create_dir(&forged_mount).unwrap();
        fs::write(&forged_executable, b"binary").unwrap();
        assert!(matches!(
            inspect_appimage_execution(
                Some(source),
                Some(forged_mount),
                forged_executable,
                temporary_directory,
            ),
            Err(LinuxApplicationUpdateError::InvalidPath(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn appimage_source_and_ancestors_must_be_direct() {
        use std::os::unix::fs::symlink;

        let root = TempDir::new().unwrap();
        let actual = root.path().join("actual");
        fs::create_dir(&actual).unwrap();
        let source = actual.join("Portcove.AppImage");
        fs::write(&source, b"appimage").unwrap();

        let linked_source = root.path().join("linked.AppImage");
        symlink(&source, &linked_source).unwrap();
        assert!(matches!(
            direct_absolute_path(&linked_source),
            Err(LinuxApplicationUpdateError::InvalidPath(_))
        ));

        let linked_parent = root.path().join("linked-parent");
        symlink(&actual, &linked_parent).unwrap();
        assert!(matches!(
            direct_absolute_path(&linked_parent.join("Portcove.AppImage")),
            Err(LinuxApplicationUpdateError::InvalidPath(_))
        ));
    }

    #[cfg(target_os = "linux")]
    fn fake_appimage(marker: u8) -> Vec<u8> {
        let mut bytes = vec![marker; 128];
        bytes[..4].copy_from_slice(b"\x7fELF");
        bytes[4] = 2;
        bytes[5] = 1;
        bytes[8..11].copy_from_slice(b"AI\x02");
        bytes[18] = 0x3e;
        bytes[19] = 0;
        bytes
    }

    #[cfg(target_os = "linux")]
    fn replacement_plan(root: &TempDir) -> (LinuxAppImageUpdatePlan, Vec<u8>, Vec<u8>) {
        let source = root.path().join("Portcove.AppImage");
        let staged = root.path().join("candidate.payload");
        let old = fake_appimage(0x11);
        let candidate = fake_appimage(0x22);
        fs::write(&source, &old).unwrap();
        fs::set_permissions(&source, fs::Permissions::from_mode(0o750)).unwrap();
        fs::write(&staged, &candidate).unwrap();
        let expected_sha256 = hex::encode(Sha256::digest(&candidate));
        let source_guard = open_path_guard(&source).unwrap();
        let staged_payload =
            verify_file_identity(&staged, candidate.len() as u64, &expected_sha256, true).unwrap();
        let swap = appimage_swap_path(&source, &expected_sha256).unwrap();
        (
            LinuxAppImageUpdatePlan {
                source,
                swap,
                source_guard,
                staged_payload,
                swap_guard: None,
                expected_bytes: candidate.len() as u64,
                expected_sha256,
                previous_bytes: old.len() as u64,
                previous_sha256: hex::encode(Sha256::digest(&old)),
                permissions: fs::Permissions::from_mode(0o750),
            },
            old,
            candidate,
        )
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn appimage_replacement_keeps_a_complete_stable_path_and_backup() {
        let root = TempDir::new().unwrap();
        let (mut plan, old, candidate) = replacement_plan(&root);

        prepare_appimage_swap(&mut plan).unwrap();
        assert_eq!(fs::read(&plan.source).unwrap(), old);
        assert_eq!(fs::read(&plan.swap).unwrap(), candidate);
        exchange_appimage(&plan).unwrap();
        verify_exchanged_appimage(&plan).unwrap();
        sync_parent(&plan.source).unwrap();

        assert_eq!(fs::read(&plan.source).unwrap(), candidate);
        assert_eq!(fs::read(&plan.swap).unwrap(), old);
        assert_eq!(
            fs::metadata(&plan.source).unwrap().permissions().mode() & 0o777,
            0o750
        );

        remove_verified_backup_if_present(&plan.swap, plan.previous_bytes, &plan.previous_sha256)
            .unwrap();
        assert!(!plan.swap.exists());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn mismatched_retained_backup_is_never_removed() {
        let root = TempDir::new().unwrap();
        let (mut plan, old, _candidate) = replacement_plan(&root);
        prepare_appimage_swap(&mut plan).unwrap();
        exchange_appimage(&plan).unwrap();
        fs::write(&plan.swap, fake_appimage(0x44)).unwrap();

        assert!(matches!(
            remove_verified_backup_if_present(
                &plan.swap,
                plan.previous_bytes,
                &plan.previous_sha256,
            ),
            Err(LinuxApplicationUpdateError::RecoveryRequired(_))
        ));
        assert!(plan.swap.exists());
        assert_ne!(fs::read(&plan.swap).unwrap(), old);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn source_path_drift_aborts_before_exchange_and_removes_candidate_swap() {
        let root = TempDir::new().unwrap();
        let (mut plan, _old, candidate) = replacement_plan(&root);
        let moved = root.path().join("moved.AppImage");
        fs::rename(&plan.source, &moved).unwrap();
        fs::write(&plan.source, fake_appimage(0x33)).unwrap();

        assert!(matches!(
            prepare_appimage_swap(&mut plan),
            Err(LinuxApplicationUpdateError::InvalidPath(_))
        ));
        assert_eq!(fs::read(&moved).unwrap(), fake_appimage(0x11));
        assert_ne!(fs::read(&plan.source).unwrap(), candidate);
        assert!(!plan.swap.exists());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn staged_payload_must_be_an_exact_x86_64_type_2_appimage() {
        let root = TempDir::new().unwrap();
        let payload = root.path().join("candidate.payload");
        fs::write(&payload, b"not an AppImage payload").unwrap();
        let digest = hex::encode(Sha256::digest(b"not an AppImage payload"));
        assert!(matches!(
            verify_file_identity(&payload, 23, &digest, true),
            Err(LinuxApplicationUpdateError::InvalidPayload(_))
        ));

        let mut generic_elf = fake_appimage(0x55);
        generic_elf[8..11].fill(0);
        fs::write(&payload, &generic_elf).unwrap();
        let digest = hex::encode(Sha256::digest(&generic_elf));
        assert!(matches!(
            verify_file_identity(&payload, generic_elf.len() as u64, &digest, true),
            Err(LinuxApplicationUpdateError::InvalidPayload(_))
        ));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn appimage_mount_must_be_an_exact_read_only_fuse_mount() {
        let mount = linux_absolute_path(&["tmp", ".mount_Port cove"]);
        let native = b"297 41 0:54 / /tmp/.mount_Port\\040cove ro,nosuid,nodev - fuse.Portcove.AppImage Portcove.AppImage ro,user_id=1000\n";
        assert!(is_native_appimage_mount(&mount, native));

        let writable = b"297 41 0:54 / /tmp/.mount_Port\\040cove rw,nosuid,nodev - fuse.Portcove.AppImage Portcove.AppImage rw,user_id=1000\n";
        assert!(!is_native_appimage_mount(&mount, writable));
        let ordinary = b"297 41 0:54 / /tmp/.mount_Port\\040cove ro - tmpfs tmpfs ro\n";
        assert!(!is_native_appimage_mount(&mount, ordinary));
        let sibling = b"297 41 0:54 / /tmp/.mount_Port\\040cove-copy ro - fuse.Portcove.AppImage Portcove.AppImage ro\n";
        assert!(!is_native_appimage_mount(&mount, sibling));
        assert_eq!(
            unescape_mountinfo_field(br"/tmp/a\040b\134c"),
            br"/tmp/a b\c"
        );
        assert_eq!(unescape_mountinfo_field(br"\777"), br"\777");
    }

    #[test]
    fn kernel_release_becomes_canonical_semver() {
        assert_eq!(
            canonical_kernel_version("6.8.0-1018-azure\n"),
            Some("6.8.0".into())
        );
        assert_eq!(canonical_kernel_version("5.15\n"), Some("5.15.0".into()));
        assert_eq!(canonical_kernel_version("unknown"), None);
    }
}
