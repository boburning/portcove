//! Linux AppImage ownership and installed-context observation.
//!
//! Only a directly executed, user-owned AppImage can opt into Portcove-managed
//! application updates. Package-manager and unpackaged builds have no APPIMAGE
//! identity and remain under their existing owner.

#[cfg(target_os = "linux")]
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

#[cfg(target_os = "linux")]
use std::os::unix::ffi::OsStrExt;

#[cfg(target_os = "linux")]
use crate::application_update::{InstallOwner, InstalledApplicationContext};

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
    #[error("this AppImage is not executable and writable by its owner")]
    InvalidPermissions,
    #[error("this Linux architecture has no qualified AppImage updater")]
    UnsupportedArchitecture,
    #[error("the Linux kernel version could not be established")]
    MissingKernelVersion,
    #[error("the installed Portcove compatibility context is unavailable: {0}")]
    InstalledContext(String),
    #[error("Linux AppImage inspection failed: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AppImageExecution {
    source: PathBuf,
    mount: PathBuf,
    executable: PathBuf,
}

/// Observes only the AppImage identity supplied by the native runtime. APPIMAGE
/// is the stable source path; current_exe points into the temporary mount and
/// must remain below APPDIR so an injected environment cannot claim ownership.
#[cfg(target_os = "linux")]
pub fn current_linux_appimage_context()
-> Result<InstalledApplicationContext, LinuxApplicationUpdateError> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    if std::env::consts::ARCH != "x86_64" {
        return Err(LinuxApplicationUpdateError::UnsupportedArchitecture);
    }
    let execution = inspect_appimage_execution(
        std::env::var_os("APPIMAGE").map(PathBuf::from),
        std::env::var_os("APPDIR").map(PathBuf::from),
        std::env::current_exe()?,
        std::env::temp_dir(),
    )?;
    let mount_table = std::fs::read(linux_absolute_path(&["proc", "self", "mountinfo"]))?;
    if !is_native_appimage_mount(&execution.mount, &mount_table) {
        return Err(LinuxApplicationUpdateError::InvalidPath(
            "the runtime mount is not a read-only AppImage FUSE mount".into(),
        ));
    }
    let metadata = std::fs::symlink_metadata(&execution.source)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(LinuxApplicationUpdateError::InvalidPath(
            "the source is not a direct file".into(),
        ));
    }
    if metadata.uid() != unsafe { libc::geteuid() } {
        return Err(LinuxApplicationUpdateError::DifferentOwner);
    }
    let mode = metadata.permissions().mode();
    if mode & 0o100 == 0 || mode & 0o200 == 0 {
        return Err(LinuxApplicationUpdateError::InvalidPermissions);
    }
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
