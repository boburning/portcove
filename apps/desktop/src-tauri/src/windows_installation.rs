//! Windows installation identity: whether this process is the executable of
//! Portcove's single registered per-user NSIS installation.
//!
//! The taskbar jump list uses this to adopt the installed application's
//! identity. It was part of the removed custom updater's Windows adapter and is
//! kept here because the jump list still needs it; the updater plugin owns
//! installation itself.
// Only Windows builds inspect the registry; other builds keep the pure checks
// for their tests and the product identifier.
#![cfg_attr(not(windows), allow(dead_code))]

use std::fs;
use std::path::{Path, PathBuf};

/// The configured bundle identifier, also stamped on the installer's shortcuts.
pub(crate) const APPLICATION_PRODUCT_ID: &str = "io.github.portcove.portcove";

const PRODUCT_NAME: &str = "Portcove";
const APPLICATION_FILENAME: &str = "portcove-desktop.exe";
const UNINSTALLER_FILENAME: &str = "uninstall.exe";
#[cfg(windows)]
const MAX_REGISTRY_SUBKEYS: u32 = 4_096;
#[cfg(windows)]
const MAX_REGISTRY_NAME_UNITS: usize = 512;
#[cfg(windows)]
const MAX_REGISTRY_VALUE_BYTES: u32 = 32 * 1024;

#[derive(Debug, thiserror::Error)]
pub(crate) enum WindowsInstallationError {
    #[error("Portcove has no registered per-user NSIS installation at the running executable")]
    MissingRegistration,
    #[error("the registered Portcove installation is system-wide")]
    SystemWideInstallation,
    #[error("multiple Portcove installer registrations exist")]
    AmbiguousRegistration,
    #[error("the Portcove installer registration is invalid: {0}")]
    InvalidRegistration(String),
    #[cfg_attr(not(windows), allow(dead_code))]
    #[error("a Windows installer registration could not be inspected: {0}")]
    Registry(String),
    #[error("an installation path is unsafe: {0}")]
    InvalidPath(String),
    #[error("installation inspection I/O failed: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WindowsInstallScope {
    CurrentUser,
    LocalMachine64,
    LocalMachine32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WindowsUninstallRegistration {
    pub(crate) scope: WindowsInstallScope,
    pub(crate) registry_path: String,
    pub(crate) display_name: String,
    pub(crate) display_version: String,
    pub(crate) install_location: PathBuf,
    pub(crate) uninstall_executable: PathBuf,
}

/// Whether this process is the executable of Portcove's single registered
/// current-version NSIS installation, using the same evaluation as update
/// admission. Development, fixture and portable runs answer `false`.
#[cfg(windows)]
pub(crate) fn running_registered_installation() -> bool {
    // Only the failing stage is logged: errors can name private paths.
    let not_installed = |stage: &'static str| {
        tracing::debug!(
            component = "recent_play_shortcuts",
            stage,
            message = "using the per-executable taskbar identity"
        );
        false
    };
    let Ok(current_executable) = std::env::current_exe() else {
        return not_installed("current_executable");
    };
    let Ok(registrations) = inventory_portcove_registrations() else {
        return not_installed("registration_inventory");
    };
    if evaluate_windows_nsis_installation(
        env!("CARGO_PKG_VERSION"),
        &current_executable,
        &registrations,
    )
    .is_err()
    {
        return not_installed("registered_installation");
    }
    true
}

fn evaluate_windows_nsis_installation(
    current_version: &str,
    current_executable: &Path,
    registrations: &[WindowsUninstallRegistration],
) -> Result<(), WindowsInstallationError> {
    let current_executable = canonical_direct_file(current_executable, APPLICATION_FILENAME)?;
    if registrations.len() > 1 {
        return Err(WindowsInstallationError::AmbiguousRegistration);
    }
    let registration = registrations
        .first()
        .ok_or(WindowsInstallationError::MissingRegistration)?;
    if registration.scope != WindowsInstallScope::CurrentUser {
        return Err(WindowsInstallationError::SystemWideInstallation);
    }
    if registration.display_name != PRODUCT_NAME {
        return Err(WindowsInstallationError::InvalidRegistration(
            "display name does not match Portcove".into(),
        ));
    }
    if registration.display_version != current_version {
        return Err(WindowsInstallationError::InvalidRegistration(
            "registered version does not match the running application".into(),
        ));
    }

    let install_root = canonical_direct_directory(&registration.install_location)?;
    let registered_executable = canonical_direct_file(
        &install_root.join(APPLICATION_FILENAME),
        APPLICATION_FILENAME,
    )?;
    if registered_executable != current_executable {
        return Err(WindowsInstallationError::InvalidRegistration(
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
        return Err(WindowsInstallationError::InvalidRegistration(
            "uninstall command is outside the registered install location".into(),
        ));
    }

    Ok(())
}

fn canonical_direct_file(
    path: &Path,
    expected_name: &str,
) -> Result<PathBuf, WindowsInstallationError> {
    refuse_reparse_ancestors(path)?;
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        WindowsInstallationError::InvalidPath(format!("{}: {error}", path.display()))
    })?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(WindowsInstallationError::InvalidPath(format!(
            "{} is not a direct file",
            path.display()
        )));
    }
    if path
        .file_name()
        .and_then(|name| name.to_str())
        .is_none_or(|name| !name.eq_ignore_ascii_case(expected_name))
    {
        return Err(WindowsInstallationError::InvalidPath(format!(
            "{} does not have the expected filename",
            path.display()
        )));
    }
    fs::canonicalize(path).map_err(Into::into)
}

fn canonical_direct_directory(path: &Path) -> Result<PathBuf, WindowsInstallationError> {
    refuse_reparse_ancestors(path)?;
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        WindowsInstallationError::InvalidPath(format!("{}: {error}", path.display()))
    })?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(WindowsInstallationError::InvalidPath(format!(
            "{} is not a direct directory",
            path.display()
        )));
    }
    fs::canonicalize(path).map_err(Into::into)
}

fn refuse_reparse_ancestors(path: &Path) -> Result<(), WindowsInstallationError> {
    let mut current = Some(path);
    while let Some(candidate) = current {
        match fs::symlink_metadata(candidate) {
            Ok(metadata) => {
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
                    if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                        return Err(WindowsInstallationError::InvalidPath(format!(
                            "{} has reparse-point ancestry",
                            candidate.display()
                        )));
                    }
                }
                #[cfg(not(windows))]
                if metadata.file_type().is_symlink() {
                    return Err(WindowsInstallationError::InvalidPath(format!(
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

#[cfg(windows)]
fn inventory_portcove_registrations()
-> Result<Vec<WindowsUninstallRegistration>, WindowsInstallationError> {
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
) -> Result<(), WindowsInstallationError> {
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
            return Err(WindowsInstallationError::Registry(
                "uninstall inventory exceeds its subkey limit".into(),
            ));
        }
        if status != ERROR_SUCCESS {
            return Err(registry_status("enumerate uninstall inventory", status));
        }
        name.truncate(name_len as usize);
        let name = String::from_utf16(&name).map_err(|_| {
            WindowsInstallationError::Registry(
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
) -> Result<Option<String>, WindowsInstallationError> {
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
    if !(2..=MAX_REGISTRY_VALUE_BYTES).contains(&bytes) || !bytes.is_multiple_of(2) {
        return Err(WindowsInstallationError::Registry(
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
        return Err(WindowsInstallationError::Registry(
            "uninstall value is empty or contains an embedded null".into(),
        ));
    }
    String::from_utf16(&value)
        .map(Some)
        .map_err(|_| WindowsInstallationError::Registry("uninstall value is invalid UTF-16".into()))
}

#[cfg(windows)]
fn required_registry_string(
    key: windows_sys::Win32::System::Registry::HKEY,
    name: &str,
) -> Result<String, WindowsInstallationError> {
    read_registry_string(key, name)?.ok_or_else(|| {
        WindowsInstallationError::InvalidRegistration(format!("required {name} value is missing"))
    })
}

#[cfg(windows)]
fn parse_registry_path(value: &str) -> Result<PathBuf, WindowsInstallationError> {
    let value = value.trim();
    let value = value
        .strip_prefix('"')
        .and_then(|value| value.strip_suffix('"'))
        .unwrap_or(value);
    if value.is_empty() || value.contains('"') {
        return Err(WindowsInstallationError::InvalidRegistration(
            "installer path is empty or contains arguments".into(),
        ));
    }
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        return Err(WindowsInstallationError::InvalidRegistration(
            "installer path is not absolute".into(),
        ));
    }
    Ok(path)
}

#[cfg(windows)]
fn parse_uninstall_command(value: &str) -> Result<PathBuf, WindowsInstallationError> {
    parse_registry_path(value)
}

#[cfg(windows)]
fn registry_status(operation: &str, status: u32) -> WindowsInstallationError {
    WindowsInstallationError::Registry(format!("{operation} failed with Windows error {status}"))
}

#[cfg(windows)]
fn wide(value: &str) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    std::ffi::OsStr::new(value)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, PathBuf, WindowsUninstallRegistration) {
        let temporary = tempfile::tempdir().unwrap();
        let install_root = temporary.path().join("Portcove");
        fs::create_dir(&install_root).unwrap();
        let current = install_root.join(APPLICATION_FILENAME);
        let uninstaller = install_root.join(UNINSTALLER_FILENAME);
        fs::write(&current, b"MZ").unwrap();
        fs::write(&uninstaller, b"MZ").unwrap();
        let registration = WindowsUninstallRegistration {
            scope: WindowsInstallScope::CurrentUser,
            registry_path: "HKCU\\...\\Portcove".into(),
            display_name: PRODUCT_NAME.into(),
            display_version: "0.1.0".into(),
            install_location: install_root,
            uninstall_executable: uninstaller,
        };
        (temporary, current, registration)
    }

    #[test]
    fn accepts_only_the_exact_current_user_installation_of_this_version() {
        let (_temporary, current, registration) = fixture();
        assert!(
            evaluate_windows_nsis_installation(
                "0.1.0",
                &current,
                std::slice::from_ref(&registration)
            )
            .is_ok()
        );
        assert!(matches!(
            evaluate_windows_nsis_installation("0.1.0", &current, &[]),
            Err(WindowsInstallationError::MissingRegistration)
        ));
        assert!(matches!(
            evaluate_windows_nsis_installation(
                "0.1.0",
                &current,
                &[registration.clone(), registration.clone()]
            ),
            Err(WindowsInstallationError::AmbiguousRegistration)
        ));
        assert!(matches!(
            evaluate_windows_nsis_installation(
                "0.2.0",
                &current,
                std::slice::from_ref(&registration)
            ),
            Err(WindowsInstallationError::InvalidRegistration(_))
        ));
        let mut system = registration;
        system.scope = WindowsInstallScope::LocalMachine64;
        assert!(matches!(
            evaluate_windows_nsis_installation("0.1.0", &current, &[system]),
            Err(WindowsInstallationError::SystemWideInstallation)
        ));
    }

    #[test]
    fn rejects_an_executable_outside_the_registered_location() {
        let (temporary, _current, registration) = fixture();
        let elsewhere = temporary.path().join("portable");
        fs::create_dir(&elsewhere).unwrap();
        let portable = elsewhere.join(APPLICATION_FILENAME);
        fs::write(&portable, b"MZ").unwrap();
        assert!(matches!(
            evaluate_windows_nsis_installation("0.1.0", &portable, &[registration]),
            Err(WindowsInstallationError::InvalidRegistration(_))
        ));
    }

    #[test]
    fn product_id_matches_the_configured_bundle_identifier() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(config["identifier"], APPLICATION_PRODUCT_ID);
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
