//! Observation of a directly launched, user-owned macOS application bundle.
//!
//! This grants candidate selection only. Native bundle replacement remains
//! unavailable until the separately journaled apply/recovery adapter is wired.

use std::collections::BTreeSet;
use std::ffi::OsStr;
use std::fs;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::thread;
use std::time::{Duration, Instant};

use portcove_core::{ChildProcessClass, ChildProcessPolicy};

use crate::application_update::{
    APPLICATION_PRODUCT_ID, InstallOwner, InstalledApplicationContext,
    InstalledApplicationContextError,
};

const BUNDLE_NAME: &str = "Portcove.app";
const EXECUTABLE_NAME: &str = "portcove-desktop";
const EXECUTION_CONTEXT: &str = "user-owned-app-bundle";
const TOOL_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_TOOL_OUTPUT: usize = 4096;

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
