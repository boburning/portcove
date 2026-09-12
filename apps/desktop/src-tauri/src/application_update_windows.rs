//! Windows ownership admission for an already verified NSIS application update.
//!
//! The shared updater stores own trust, consent, staging, and cross-process
//! exclusion. This adapter proves the native installation that would be
//! replaced. It accepts only one exact current-user NSIS registration and
//! launches the locked staged payload with Tauri's documented passive-update
//! arguments. It never chooses a URL, relocates an installation, or elevates.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::application_update::{InstallOwner, InstalledApplicationContext};
use crate::application_update_apply::{
    ApplicationUpdateApplyError, ApplicationUpdateRevalidationLease,
};
use crate::application_update_staging::StagedApplicationUpdate;

const PRODUCT_NAME: &str = "Portcove";
const PRODUCT_ID: &str = "portcove-desktop";
const APPLICATION_FILENAME: &str = "portcove-desktop.exe";
const UNINSTALLER_FILENAME: &str = "uninstall.exe";
const WINDOWS_TARGET: &str = "windows-x86_64";
const WINDOWS_EXECUTION_CONTEXT: &str = "installed-current-user";
#[cfg(windows)]
const NSIS_UPDATE_ARGUMENT_NAMES: [&str; 2] = ["P", "UPDATE"];
const MAX_REGISTRY_SUBKEYS: u32 = 4_096;
const MAX_REGISTRY_NAME_UNITS: usize = 512;
const MAX_REGISTRY_VALUE_BYTES: u32 = 32 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowsInstallScope {
    CurrentUser,
    LocalMachine64,
    LocalMachine32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowsUninstallRegistration {
    pub scope: WindowsInstallScope,
    pub registry_path: String,
    pub display_name: String,
    pub display_version: String,
    pub install_location: PathBuf,
    pub uninstall_executable: PathBuf,
}

#[derive(Debug, thiserror::Error)]
pub enum WindowsApplicationUpdateError {
    #[error("this application update is not a Portcove Windows x64 NSIS package: {0}")]
    UnsupportedCandidate(String),
    #[error("this installation cannot be updated in place: {0}")]
    UnsupportedInstallation(String),
    #[error("Portcove has no registered per-user NSIS installation at the running executable")]
    MissingRegistration,
    #[error("the registered Portcove installation is system-wide and must be updated by its owner")]
    SystemWideInstallation,
    #[error("multiple Portcove installer registrations exist; automatic replacement is ambiguous")]
    AmbiguousRegistration,
    #[error("the Portcove installer registration is invalid: {0}")]
    InvalidRegistration(String),
    #[error("a Windows installer registration could not be inspected: {0}")]
    Registry(String),
    #[error("an application update path is unsafe: {0}")]
    InvalidPath(String),
    #[error("the installed application directory is not writable: {0}")]
    Permission(String),
    #[error("the Windows application update could not be launched: {0}")]
    Launch(String),
    #[error("the Windows application update process could not be observed: {0}")]
    Wait(String),
    #[error("the Windows application update installer exited with code {0}")]
    InstallerExit(i32),
    #[error("the Windows application update launch state could not be recorded: {0}")]
    LaunchJournal(#[from] ApplicationUpdateApplyError),
    #[error(
        "the Windows application update could not be launched ({launch}); its failure could not be recorded ({journal})"
    )]
    LaunchAndJournal { launch: String, journal: String },
    #[error("Windows application update I/O failed: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug)]
struct WindowsNsisUpdatePlan {
    installer: PathBuf,
    install_root: PathBuf,
    current_executable: PathBuf,
    uninstaller: PathBuf,
    registration_path: String,
    _installer_guard: File,
}

/// Holds every shared updater authority until the native installer exits.
pub struct WindowsNsisUpdateAdmission {
    lease: ApplicationUpdateRevalidationLease,
    plan: WindowsNsisUpdatePlan,
}

impl WindowsNsisUpdateAdmission {
    pub fn installer(&self) -> &Path {
        &self.plan.installer
    }

    pub fn install_root(&self) -> &Path {
        &self.plan.install_root
    }

    pub fn registration_path(&self) -> &str {
        &self.plan.registration_path
    }

    pub fn current_executable(&self) -> &Path {
        &self.plan.current_executable
    }

    pub fn uninstaller(&self) -> &Path {
        &self.plan.uninstaller
    }

    /// Runs the verified installer with the passive update arguments
    /// documented by Tauri's NSIS updater contract. The installer receives no
    /// destination override and therefore keeps its registered identity. This
    /// helper retains every updater lock until the child exits and records the
    /// process outcome before returning.
    #[cfg(windows)]
    pub fn launch(self) -> Result<(), WindowsApplicationUpdateError> {
        let Self { lease, plan } = self;
        let launch = lease.begin_native_launch()?;
        match launch_windows_nsis_installer(&plan.installer) {
            Ok(mut child) => {
                let status = child
                    .wait()
                    .map_err(|error| WindowsApplicationUpdateError::Wait(error.to_string()))?;
                let exit_code = status.code().ok_or_else(|| {
                    WindowsApplicationUpdateError::Wait(
                        "the installer exited without a Windows exit code".into(),
                    )
                })?;
                if status.success() {
                    launch.record_succeeded()?;
                    Ok(())
                } else {
                    launch.record_installer_failed(exit_code)?;
                    Err(WindowsApplicationUpdateError::InstallerExit(exit_code))
                }
            }
            Err(error) => match launch.record_failed() {
                Ok(_) => Err(error),
                Err(journal) => Err(WindowsApplicationUpdateError::LaunchAndJournal {
                    launch: error.to_string(),
                    journal: journal.to_string(),
                }),
            },
        }
    }
}

/// Adds native Windows installation authority to an already revalidated
/// updater lease. No filesystem or registry identity supplied by IPC is used.
#[cfg(windows)]
pub fn admit_windows_nsis_update(
    lease: ApplicationUpdateRevalidationLease,
) -> Result<WindowsNsisUpdateAdmission, WindowsApplicationUpdateError> {
    let current_executable = std::env::current_exe()?;
    let registrations = inventory_portcove_registrations()?;
    let intent = lease.state().intent.as_ref().ok_or_else(|| {
        WindowsApplicationUpdateError::UnsupportedInstallation(
            "the retained apply lease has no intent".into(),
        )
    })?;
    let plan = evaluate_windows_nsis_update(
        lease.staged(),
        &intent.installed,
        &current_executable,
        &registrations,
    )?;
    probe_install_root_write(&plan.install_root)?;
    Ok(WindowsNsisUpdateAdmission { lease, plan })
}

fn evaluate_windows_nsis_update(
    staged: &StagedApplicationUpdate,
    installed: &InstalledApplicationContext,
    current_executable: &Path,
    registrations: &[WindowsUninstallRegistration],
) -> Result<WindowsNsisUpdatePlan, WindowsApplicationUpdateError> {
    validate_windows_candidate(staged, installed)?;
    let current_executable = canonical_direct_file(current_executable, APPLICATION_FILENAME)?;
    let installer = canonical_direct_file(&staged.payload_path, "candidate-installer.exe")?;
    let installer_guard = lock_and_verify_installer(
        &installer,
        staged.candidate.release.artifact.bytes,
        &staged.candidate.release.artifact.sha256,
    )?;

    if registrations.len() > 1 {
        return Err(WindowsApplicationUpdateError::AmbiguousRegistration);
    }
    let registration = registrations
        .first()
        .ok_or(WindowsApplicationUpdateError::MissingRegistration)?;
    if registration.scope != WindowsInstallScope::CurrentUser {
        return Err(WindowsApplicationUpdateError::SystemWideInstallation);
    }
    if registration.display_name != PRODUCT_NAME {
        return Err(WindowsApplicationUpdateError::InvalidRegistration(
            "display name does not match Portcove".into(),
        ));
    }
    if registration.display_version != installed.current_version {
        return Err(WindowsApplicationUpdateError::InvalidRegistration(
            "registered version does not match the running application".into(),
        ));
    }

    let install_root = canonical_direct_directory(&registration.install_location)?;
    let registered_executable = canonical_direct_file(
        &install_root.join(APPLICATION_FILENAME),
        APPLICATION_FILENAME,
    )?;
    if registered_executable != current_executable {
        return Err(WindowsApplicationUpdateError::InvalidRegistration(
            "install location does not own the running executable".into(),
        ));
    }
    let expected_uninstaller = canonical_direct_file(
        &install_root.join(UNINSTALLER_FILENAME),
        UNINSTALLER_FILENAME,
    )?;
    let registered_uninstaller =
        canonical_direct_file(&registration.uninstall_executable, UNINSTALLER_FILENAME)?;
    if registered_uninstaller != expected_uninstaller {
        return Err(WindowsApplicationUpdateError::InvalidRegistration(
            "uninstall command is outside the registered install location".into(),
        ));
    }

    Ok(WindowsNsisUpdatePlan {
        installer,
        install_root,
        current_executable,
        uninstaller: registered_uninstaller,
        registration_path: registration.registry_path.clone(),
        _installer_guard: installer_guard,
    })
}

fn validate_windows_candidate(
    staged: &StagedApplicationUpdate,
    installed: &InstalledApplicationContext,
) -> Result<(), WindowsApplicationUpdateError> {
    let release = &staged.candidate.release;
    let candidate_matches = release.target == WINDOWS_TARGET
        && release.os == "windows"
        && release.architecture == "x86_64"
        && release.execution_context == WINDOWS_EXECUTION_CONTEXT
        && release.package.kind == "nsis"
        && release.package.owner == InstallOwner::Portcove
        && release.package.product_id == PRODUCT_ID;
    if !candidate_matches {
        return Err(WindowsApplicationUpdateError::UnsupportedCandidate(
            "target, execution context, package, or owner does not match".into(),
        ));
    }
    let installation_matches = installed.target == WINDOWS_TARGET
        && installed.os == "windows"
        && installed.architecture == "x86_64"
        && installed.execution_context == WINDOWS_EXECUTION_CONTEXT
        && installed.package_kind == "nsis"
        && installed.install_owner == InstallOwner::Portcove
        && installed.product_id == PRODUCT_ID;
    if !installation_matches {
        return Err(WindowsApplicationUpdateError::UnsupportedInstallation(
            "target, execution context, package, or owner does not match".into(),
        ));
    }
    Ok(())
}

fn canonical_direct_file(
    path: &Path,
    expected_name: &str,
) -> Result<PathBuf, WindowsApplicationUpdateError> {
    refuse_reparse_ancestors(path)?;
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        WindowsApplicationUpdateError::InvalidPath(format!("{}: {error}", path.display()))
    })?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(WindowsApplicationUpdateError::InvalidPath(format!(
            "{} is not a direct file",
            path.display()
        )));
    }
    if path
        .file_name()
        .and_then(|name| name.to_str())
        .is_none_or(|name| !name.eq_ignore_ascii_case(expected_name))
    {
        return Err(WindowsApplicationUpdateError::InvalidPath(format!(
            "{} does not have the expected filename",
            path.display()
        )));
    }
    fs::canonicalize(path).map_err(Into::into)
}

fn canonical_direct_directory(path: &Path) -> Result<PathBuf, WindowsApplicationUpdateError> {
    refuse_reparse_ancestors(path)?;
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        WindowsApplicationUpdateError::InvalidPath(format!("{}: {error}", path.display()))
    })?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(WindowsApplicationUpdateError::InvalidPath(format!(
            "{} is not a direct directory",
            path.display()
        )));
    }
    fs::canonicalize(path).map_err(Into::into)
}

fn refuse_reparse_ancestors(path: &Path) -> Result<(), WindowsApplicationUpdateError> {
    let mut current = Some(path);
    while let Some(candidate) = current {
        match fs::symlink_metadata(candidate) {
            Ok(metadata) => {
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
                    if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                        return Err(WindowsApplicationUpdateError::InvalidPath(format!(
                            "{} has reparse-point ancestry",
                            candidate.display()
                        )));
                    }
                }
                #[cfg(not(windows))]
                if metadata.file_type().is_symlink() {
                    return Err(WindowsApplicationUpdateError::InvalidPath(format!(
                        "{} has symbolic-link ancestry",
                        candidate.display()
                    )));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        current = candidate.parent();
    }
    Ok(())
}

fn lock_and_verify_installer(
    path: &Path,
    expected_bytes: u64,
    expected_sha256: &str,
) -> Result<File, WindowsApplicationUpdateError> {
    let mut file = open_locked_file(path)?;
    let metadata = file.metadata()?;
    if metadata.len() != expected_bytes {
        return Err(WindowsApplicationUpdateError::InvalidPath(
            "staged Windows installer length changed after verification".into(),
        ));
    }
    let mut magic = [0_u8; 2];
    file.read_exact(&mut magic)?;
    if magic != *b"MZ" {
        return Err(WindowsApplicationUpdateError::InvalidPath(
            "staged Windows installer has no PE header".into(),
        ));
    }
    let mut digest = Sha256::new();
    digest.update(magic);
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    if hex::encode(digest.finalize()) != expected_sha256 {
        return Err(WindowsApplicationUpdateError::InvalidPath(
            "staged Windows installer digest changed after verification".into(),
        ));
    }
    Ok(file)
}

fn open_locked_file(path: &Path) -> Result<File, WindowsApplicationUpdateError> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ;
        options.share_mode(FILE_SHARE_READ);
    }
    options.open(path).map_err(Into::into)
}

fn probe_install_root_write(root: &Path) -> Result<(), WindowsApplicationUpdateError> {
    for index in 0..16_u8 {
        let path = root.join(format!(
            ".portcove-update-permission-{}-{index}.tmp",
            std::process::id()
        ));
        let mut file = match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(WindowsApplicationUpdateError::Permission(error.to_string()));
            }
        };
        let operation = file
            .write_all(b"Portcove application update permission probe\n")
            .and_then(|()| file.sync_all());
        drop(file);
        let cleanup = fs::remove_file(&path);
        return match (operation, cleanup) {
            (Ok(()), Ok(())) => Ok(()),
            (Err(error), Ok(())) | (Ok(()), Err(error)) => {
                Err(WindowsApplicationUpdateError::Permission(error.to_string()))
            }
            (Err(operation), Err(cleanup)) => Err(WindowsApplicationUpdateError::Permission(
                format!("{operation}; permission probe cleanup also failed: {cleanup}"),
            )),
        };
    }
    Err(WindowsApplicationUpdateError::Permission(
        "permission probe slots are occupied".into(),
    ))
}

#[cfg(windows)]
fn inventory_portcove_registrations()
-> Result<Vec<WindowsUninstallRegistration>, WindowsApplicationUpdateError> {
    use windows_sys::Win32::System::Registry::{
        HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_WOW64_32KEY, KEY_WOW64_64KEY,
    };

    let mut registrations = Vec::new();
    enumerate_uninstall_root(
        HKEY_CURRENT_USER,
        0,
        WindowsInstallScope::CurrentUser,
        "HKCU",
        &mut registrations,
    )?;
    enumerate_uninstall_root(
        HKEY_LOCAL_MACHINE,
        KEY_WOW64_64KEY,
        WindowsInstallScope::LocalMachine64,
        "HKLM64",
        &mut registrations,
    )?;
    enumerate_uninstall_root(
        HKEY_LOCAL_MACHINE,
        KEY_WOW64_32KEY,
        WindowsInstallScope::LocalMachine32,
        "HKLM32",
        &mut registrations,
    )?;
    Ok(registrations)
}

#[cfg(windows)]
fn enumerate_uninstall_root(
    hive: windows_sys::Win32::System::Registry::HKEY,
    view: u32,
    scope: WindowsInstallScope,
    hive_label: &str,
    output: &mut Vec<WindowsUninstallRegistration>,
) -> Result<(), WindowsApplicationUpdateError> {
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Foundation::{
        ERROR_FILE_NOT_FOUND, ERROR_NO_MORE_ITEMS, ERROR_SUCCESS,
    };
    use windows_sys::Win32::System::Registry::{HKEY, KEY_READ, RegEnumKeyExW, RegOpenKeyExW};

    const UNINSTALL: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall";
    let uninstall_wide = wide(UNINSTALL);
    let mut root: HKEY = null_mut();
    // SAFETY: the name is null terminated and `root` is a live output slot.
    let status =
        unsafe { RegOpenKeyExW(hive, uninstall_wide.as_ptr(), 0, KEY_READ | view, &mut root) };
    if status == ERROR_FILE_NOT_FOUND {
        return Ok(());
    }
    if status != ERROR_SUCCESS {
        return Err(registry_status("open uninstall inventory", status));
    }
    let root = RegistryKey(root);

    for index in 0..=MAX_REGISTRY_SUBKEYS {
        let mut name = vec![0_u16; MAX_REGISTRY_NAME_UNITS];
        let mut name_len = name.len() as u32;
        // SAFETY: `root` is owned below and the output buffer and length match.
        let status = unsafe {
            RegEnumKeyExW(
                root.0,
                index,
                name.as_mut_ptr(),
                &mut name_len,
                null(),
                null_mut(),
                null_mut(),
                null_mut(),
            )
        };
        if status == ERROR_NO_MORE_ITEMS {
            return Ok(());
        }
        if index == MAX_REGISTRY_SUBKEYS {
            return Err(WindowsApplicationUpdateError::Registry(
                "uninstall inventory exceeds its subkey limit".into(),
            ));
        }
        if status != ERROR_SUCCESS {
            return Err(registry_status("enumerate uninstall inventory", status));
        }
        name.truncate(name_len as usize);
        let name = String::from_utf16(&name).map_err(|_| {
            WindowsApplicationUpdateError::Registry(
                "uninstall inventory contains an invalid UTF-16 key name".into(),
            )
        })?;
        let name_wide = wide(&name);
        let mut child: HKEY = null_mut();
        // SAFETY: the parent and null-terminated name remain live and `child`
        // is a valid output slot.
        let status =
            unsafe { RegOpenKeyExW(root.0, name_wide.as_ptr(), 0, KEY_READ | view, &mut child) };
        if status != ERROR_SUCCESS {
            return Err(registry_status("open uninstall entry", status));
        }
        let child = RegistryKey(child);
        let Some(display_name) = read_registry_string(child.0, "DisplayName")? else {
            continue;
        };
        if display_name != PRODUCT_NAME {
            continue;
        }
        let display_version = required_registry_string(child.0, "DisplayVersion")?;
        let install_location =
            parse_registry_path(&required_registry_string(child.0, "InstallLocation")?)?;
        let uninstall_executable =
            parse_uninstall_command(&required_registry_string(child.0, "UninstallString")?)?;
        output.push(WindowsUninstallRegistration {
            scope,
            registry_path: format!("{hive_label}\\{UNINSTALL}\\{name}"),
            display_name,
            display_version,
            install_location,
            uninstall_executable,
        });
    }
    unreachable!("bounded registry enumeration always returns")
}

#[cfg(windows)]
struct RegistryKey(windows_sys::Win32::System::Registry::HKEY);

#[cfg(windows)]
impl Drop for RegistryKey {
    fn drop(&mut self) {
        // SAFETY: this wrapper owns a successful registry handle exactly once.
        unsafe {
            windows_sys::Win32::System::Registry::RegCloseKey(self.0);
        }
    }
}

#[cfg(windows)]
fn read_registry_string(
    key: windows_sys::Win32::System::Registry::HKEY,
    name: &str,
) -> Result<Option<String>, WindowsApplicationUpdateError> {
    use std::ffi::c_void;
    use std::ptr::null_mut;
    use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
    use windows_sys::Win32::System::Registry::{RRF_RT_REG_SZ, RegGetValueW};

    let name = wide(name);
    let mut bytes = 0_u32;
    // SAFETY: the name is null terminated; null data asks only for its size.
    let status = unsafe {
        RegGetValueW(
            key,
            std::ptr::null(),
            name.as_ptr(),
            RRF_RT_REG_SZ,
            null_mut(),
            null_mut(),
            &mut bytes,
        )
    };
    if status == ERROR_FILE_NOT_FOUND {
        return Ok(None);
    }
    if status != ERROR_SUCCESS {
        return Err(registry_status("read uninstall value size", status));
    }
    if !(2..=MAX_REGISTRY_VALUE_BYTES).contains(&bytes) || bytes % 2 != 0 {
        return Err(WindowsApplicationUpdateError::Registry(
            "uninstall value has an invalid size".into(),
        ));
    }
    let mut value = vec![0_u16; bytes as usize / 2];
    // SAFETY: `value` has the exact capacity Windows reported above and every
    // other pointer remains live for the call.
    let status = unsafe {
        RegGetValueW(
            key,
            std::ptr::null(),
            name.as_ptr(),
            RRF_RT_REG_SZ,
            null_mut(),
            value.as_mut_ptr().cast::<c_void>(),
            &mut bytes,
        )
    };
    if status != ERROR_SUCCESS {
        return Err(registry_status("read uninstall value", status));
    }
    while value.last() == Some(&0) {
        value.pop();
    }
    if value.is_empty() || value.contains(&0) {
        return Err(WindowsApplicationUpdateError::Registry(
            "uninstall value is empty or contains an embedded null".into(),
        ));
    }
    String::from_utf16(&value).map(Some).map_err(|_| {
        WindowsApplicationUpdateError::Registry("uninstall value is invalid UTF-16".into())
    })
}

#[cfg(windows)]
fn required_registry_string(
    key: windows_sys::Win32::System::Registry::HKEY,
    name: &str,
) -> Result<String, WindowsApplicationUpdateError> {
    read_registry_string(key, name)?.ok_or_else(|| {
        WindowsApplicationUpdateError::InvalidRegistration(format!(
            "required {name} value is missing"
        ))
    })
}

#[cfg(windows)]
fn parse_registry_path(value: &str) -> Result<PathBuf, WindowsApplicationUpdateError> {
    let value = value.trim();
    let value = value
        .strip_prefix('"')
        .and_then(|value| value.strip_suffix('"'))
        .unwrap_or(value);
    if value.is_empty() || value.contains('"') {
        return Err(WindowsApplicationUpdateError::InvalidRegistration(
            "installer path is empty or contains arguments".into(),
        ));
    }
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        return Err(WindowsApplicationUpdateError::InvalidRegistration(
            "installer path is not absolute".into(),
        ));
    }
    Ok(path)
}

#[cfg(windows)]
fn parse_uninstall_command(value: &str) -> Result<PathBuf, WindowsApplicationUpdateError> {
    parse_registry_path(value)
}

#[cfg(windows)]
fn registry_status(operation: &str, status: u32) -> WindowsApplicationUpdateError {
    WindowsApplicationUpdateError::Registry(format!(
        "{operation} failed with Windows error {status}"
    ))
}

#[cfg(windows)]
fn wide(value: &str) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    std::ffi::OsStr::new(value)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

#[cfg(windows)]
fn launch_windows_nsis_installer(
    path: &Path,
) -> Result<std::process::Child, WindowsApplicationUpdateError> {
    use std::process::Stdio;

    let mut command = portcove_core::ChildProcessPolicy::native_command(
        portcove_core::ChildProcessClass::HostIntegration,
        path,
    )
    .map_err(|error| WindowsApplicationUpdateError::Launch(error.to_string()))?;
    command
        .args(nsis_update_arguments())
        .current_dir(path.parent().ok_or_else(|| {
            WindowsApplicationUpdateError::InvalidPath(
                "staged Windows installer has no parent directory".into(),
            )
        })?)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command
        .spawn()
        .map_err(|error| WindowsApplicationUpdateError::Launch(error.to_string()))
}

#[cfg(windows)]
fn nsis_update_arguments() -> [String; 2] {
    NSIS_UPDATE_ARGUMENT_NAMES.map(|name| {
        let mut argument = String::with_capacity(name.len() + 1);
        argument.push('/');
        argument.push_str(name);
        argument
    })
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use crate::application_update::{
        ApplicationChannel, ApplicationCompatibility, ArtifactIdentity, LibraryCompatibility,
        PackageIdentity, PromotionRecord, QualifiedRun, ReleaseRecord, SelectedCandidate,
        VersionRange,
    };

    use super::*;

    fn installed(version: &str) -> InstalledApplicationContext {
        InstalledApplicationContext {
            current_version: version.into(),
            target: WINDOWS_TARGET.into(),
            os: "windows".into(),
            os_version: "10.0.26100".into(),
            architecture: "x86_64".into(),
            execution_context: WINDOWS_EXECUTION_CONTEXT.into(),
            package_kind: "nsis".into(),
            install_owner: InstallOwner::Portcove,
            product_id: PRODUCT_ID.into(),
            capabilities: BTreeSet::from(["library-lock-v1".into()]),
            cli_protocol: 47,
            catalog_format: 2,
            library_schema: 27,
            library_write_schema: 27,
            lock_protocol: "library-lock-v1".into(),
        }
    }

    fn staged(root: &Path, version: &str) -> StagedApplicationUpdate {
        let release_path = format!("releases/{version}/{WINDOWS_TARGET}/nsis.json");
        let release_sha256 = "a".repeat(64);
        StagedApplicationUpdate {
            candidate: SelectedCandidate {
                release_path: release_path.clone(),
                release_sha256: release_sha256.clone(),
                release: ReleaseRecord {
                    schema_version: 1,
                    version: version.into(),
                    source_commit: "b".repeat(40),
                    source_tree: "c".repeat(40),
                    qualified_run: QualifiedRun {
                        workflow: "release.yml".into(),
                        workflow_commit: "d".repeat(40),
                        run_id: 42,
                        attempt: 1,
                        inventory_sha256: "e".repeat(64),
                    },
                    target: WINDOWS_TARGET.into(),
                    os: "windows".into(),
                    architecture: "x86_64".into(),
                    execution_context: WINDOWS_EXECUTION_CONTEXT.into(),
                    package: PackageIdentity {
                        kind: "nsis".into(),
                        owner: InstallOwner::Portcove,
                        product_id: PRODUCT_ID.into(),
                    },
                    artifact: ArtifactIdentity {
                        url: format!(
                            "https://github.com/boburning/portcove/releases/download/v{version}/Portcove_{version}_x64-setup.exe"
                        ),
                        sha256: hex::encode(Sha256::digest(b"MZ")),
                        bytes: 2,
                        tauri_signature: "fixture-signature".into(),
                        payload_key_id: "1".repeat(64),
                    },
                    compatibility: ApplicationCompatibility {
                        minimum_os_version: "10.0.19045".into(),
                        required_capabilities: vec!["library-lock-v1".into()],
                        cli_protocol: VersionRange { min: 47, max: 47 },
                        catalog_formats: vec![2],
                        library: LibraryCompatibility {
                            read: VersionRange { min: 1, max: 27 },
                            write_schema: 27,
                            lock_protocol: "library-lock-v1".into(),
                        },
                    },
                    evidence_ids: vec!["windows-package-42".into()],
                },
                promotion: PromotionRecord {
                    schema_version: 1,
                    channel: ApplicationChannel::Preview,
                    target: WINDOWS_TARGET.into(),
                    package: "nsis".into(),
                    version: version.into(),
                    release_path,
                    release_sha256,
                    eligible: true,
                    production_eligible: false,
                    withdrawn: false,
                    reason: None,
                    required_bridge: None,
                },
            },
            payload_path: root.join("candidate-installer.exe"),
        }
    }

    fn fixture() -> (
        tempfile::TempDir,
        StagedApplicationUpdate,
        InstalledApplicationContext,
        PathBuf,
        WindowsUninstallRegistration,
    ) {
        let temporary = tempfile::tempdir().unwrap();
        let install_root = temporary.path().join("Portcove");
        fs::create_dir(&install_root).unwrap();
        let current = install_root.join(APPLICATION_FILENAME);
        let uninstaller = install_root.join(UNINSTALLER_FILENAME);
        fs::write(&current, b"MZ").unwrap();
        fs::write(&uninstaller, b"MZ").unwrap();
        let staged = staged(temporary.path(), "0.2.0-beta.1");
        fs::write(&staged.payload_path, b"MZ").unwrap();
        let registration = WindowsUninstallRegistration {
            scope: WindowsInstallScope::CurrentUser,
            registry_path: "HKCU\\...\\Portcove".into(),
            display_name: PRODUCT_NAME.into(),
            display_version: "0.1.0-alpha.2".into(),
            install_location: install_root,
            uninstall_executable: uninstaller,
        };
        (
            temporary,
            staged,
            installed("0.1.0-alpha.2"),
            current,
            registration,
        )
    }

    #[test]
    fn admits_one_exact_current_user_nsis_installation() {
        let (_temporary, staged, installed, current, registration) = fixture();
        let plan = evaluate_windows_nsis_update(
            &staged,
            &installed,
            &current,
            std::slice::from_ref(&registration),
        )
        .unwrap();

        assert_eq!(
            plan.install_root,
            fs::canonicalize(registration.install_location).unwrap()
        );
        assert_eq!(plan.current_executable, fs::canonicalize(current).unwrap());
        assert_eq!(
            plan.uninstaller,
            fs::canonicalize(registration.uninstall_executable).unwrap()
        );
        assert_eq!(plan.registration_path, registration.registry_path);
        assert_eq!(
            plan.installer,
            fs::canonicalize(staged.payload_path).unwrap()
        );
        probe_install_root_write(&plan.install_root).unwrap();
    }

    #[test]
    fn rejects_system_wide_custom_and_ambiguous_installations() {
        let (_temporary, staged, installed, current, mut registration) = fixture();
        registration.scope = WindowsInstallScope::LocalMachine64;
        assert!(matches!(
            evaluate_windows_nsis_update(
                &staged,
                &installed,
                &current,
                std::slice::from_ref(&registration)
            ),
            Err(WindowsApplicationUpdateError::SystemWideInstallation)
        ));

        registration.scope = WindowsInstallScope::CurrentUser;
        assert!(matches!(
            evaluate_windows_nsis_update(&staged, &installed, &current, &[]),
            Err(WindowsApplicationUpdateError::MissingRegistration)
        ));
        assert!(matches!(
            evaluate_windows_nsis_update(
                &staged,
                &installed,
                &current,
                &[registration.clone(), registration]
            ),
            Err(WindowsApplicationUpdateError::AmbiguousRegistration)
        ));
    }

    #[test]
    fn rejects_registry_identity_or_payload_path_drift() {
        let (temporary, mut staged, installed, current, mut registration) = fixture();
        registration.display_version = "0.0.9".into();
        assert!(matches!(
            evaluate_windows_nsis_update(&staged, &installed, &current, &[registration]),
            Err(WindowsApplicationUpdateError::InvalidRegistration(_))
        ));

        staged.payload_path = temporary.path().join("missing.payload");
        assert!(matches!(
            evaluate_windows_nsis_update(&staged, &installed, &current, &[]),
            Err(WindowsApplicationUpdateError::InvalidPath(_))
        ));
    }

    #[test]
    fn rejects_non_pe_or_non_windows_candidate() {
        let (_temporary, mut staged, installed, current, registration) = fixture();
        fs::write(&staged.payload_path, b"no").unwrap();
        staged.candidate.release.artifact.sha256 = hex::encode(Sha256::digest(b"no"));
        assert!(matches!(
            evaluate_windows_nsis_update(
                &staged,
                &installed,
                &current,
                std::slice::from_ref(&registration)
            ),
            Err(WindowsApplicationUpdateError::InvalidPath(_))
        ));

        fs::write(&staged.payload_path, b"MZ").unwrap();
        staged.candidate.release.artifact.sha256 = hex::encode(Sha256::digest(b"MZ"));
        staged.candidate.release.package.kind = "msi".into();
        assert!(matches!(
            evaluate_windows_nsis_update(&staged, &installed, &current, &[registration]),
            Err(WindowsApplicationUpdateError::UnsupportedCandidate(_))
        ));
    }

    #[test]
    fn rejects_staged_installer_digest_or_length_drift() {
        let (_temporary, mut staged, installed, current, registration) = fixture();
        staged.candidate.release.artifact.sha256 = "0".repeat(64);
        assert!(matches!(
            evaluate_windows_nsis_update(
                &staged,
                &installed,
                &current,
                std::slice::from_ref(&registration)
            ),
            Err(WindowsApplicationUpdateError::InvalidPath(_))
        ));

        staged.candidate.release.artifact.sha256 = hex::encode(Sha256::digest(b"MZ"));
        staged.candidate.release.artifact.bytes = 3;
        assert!(matches!(
            evaluate_windows_nsis_update(&staged, &installed, &current, &[registration]),
            Err(WindowsApplicationUpdateError::InvalidPath(_))
        ));
    }

    #[cfg(windows)]
    #[test]
    fn uses_tauri_supported_passive_nsis_update_arguments() {
        let arguments = nsis_update_arguments();
        assert_eq!(arguments[0].as_bytes(), &[47, 80]);
        assert_eq!(arguments[1].as_bytes(), &[47, 85, 80, 68, 65, 84, 69]);
    }

    #[cfg(windows)]
    #[test]
    fn registry_path_parser_accepts_only_one_absolute_path() {
        let root = std::env::temp_dir().join("Portcove");
        let raw = root.to_string_lossy();
        assert_eq!(parse_registry_path(&raw).unwrap(), root);
        assert_eq!(parse_registry_path(&format!("\"{raw}\"")).unwrap(), root);
        assert!(parse_registry_path("relative\\Portcove").is_err());
        assert!(parse_uninstall_command(&format!("\"{raw}\" /S")).is_err());
    }
}
