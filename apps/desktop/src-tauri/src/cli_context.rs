//! Read-only host discovery for command-line handoff; never execute the CLI.
use sha2::{Digest, Sha256};
use std::{
    fs::{File, OpenOptions},
    io::Read,
    path::{Path, PathBuf},
};

use crate::transport::CliCommandContext;
use crate::{DesktopResult, DesktopState, blocking_worker, service_at_generation};

#[tauri::command]
pub(crate) async fn get_cli_command_context(
    state: tauri::State<'_, DesktopState>,
    generation: u64,
) -> DesktopResult<CliCommandContext> {
    let state = state.inner().clone();
    blocking_worker(move || {
        let service = service_at_generation(&state, generation)?;
        Ok(CliCommandContext {
            library_root: service.library().root().to_path_buf(),
            executable: discover_cli_from_environment(),
            platform: portcove_core::Platform::current()?,
        })
    })
    .await
}

const MAX_CLI_BYTES: u64 = 256 * 1024 * 1024;

/// Assemble the CLI capability marker at runtime so the Desktop scanner does
/// not itself advertise the capability it is trying to verify.
pub(crate) fn cli_steam_exec_identity() -> Vec<u8> {
    let mut marker = Vec::new();
    for part in [
        "PORTCOVE_CLI_STEAM_EXEC_IDENTITY_V1",
        "|product=",
        env!("CARGO_PKG_VERSION"),
        "|capability=",
        "exec",
    ] {
        marker.extend_from_slice(std::hint::black_box(part).as_bytes());
    }
    marker
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CliExecutableIdentity {
    pub(crate) path: PathBuf,
    pub(crate) sha256: String,
    pub(crate) product_version: String,
}

pub(crate) fn discover_cli_from_environment() -> Option<PathBuf> {
    discover_cli_identity_from_environment().map(|identity| identity.path)
}

pub(crate) fn discover_cli_identity_from_environment() -> Option<CliExecutableIdentity> {
    let current = std::env::current_exe().ok();
    let search = std::env::var_os("PATH").unwrap_or_default();
    discover_cli(current.as_deref(), std::env::split_paths(&search))
}

fn discover_cli(
    current: Option<&Path>,
    search: impl Iterator<Item = PathBuf>,
) -> Option<CliExecutableIdentity> {
    let name = if cfg!(windows) {
        "portcove.exe"
    } else {
        "portcove"
    };
    current
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .into_iter()
        .chain(search)
        .filter(|directory| directory.is_absolute())
        .map(|directory| directory.join(name))
        .find_map(|candidate| {
            let resolved = std::fs::canonicalize(candidate).ok()?;
            resolved.to_str()?;
            inspect_cli(&resolved).ok()
        })
}

pub(crate) fn inspect_cli(path: &Path) -> std::io::Result<CliExecutableIdentity> {
    let file = open_read_nofollow(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() > MAX_CLI_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "standalone CLI is not a bounded regular file",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "standalone CLI is not executable",
            ));
        }
    }
    let expected_marker = cli_steam_exec_identity();
    let mut reader = file.take(MAX_CLI_BYTES + 1);
    let mut hasher = Sha256::new();
    let mut chunk = [0_u8; 64 * 1024];
    let mut overlap = Vec::new();
    let mut total = 0_u64;
    let mut marker_found = false;
    loop {
        let count = reader.read(&mut chunk)?;
        if count == 0 {
            break;
        }
        total += count as u64;
        if total > MAX_CLI_BYTES {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "standalone CLI grew beyond the safety limit",
            ));
        }
        hasher.update(&chunk[..count]);
        overlap.extend_from_slice(&chunk[..count]);
        if overlap
            .windows(expected_marker.len())
            .any(|window| window == expected_marker.as_slice())
        {
            marker_found = true;
        }
        let retain = expected_marker.len().saturating_sub(1);
        if overlap.len() > retain {
            overlap.drain(..overlap.len() - retain);
        }
    }
    if !marker_found {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "standalone CLI does not advertise the compatible Steam exec contract",
        ));
    }
    Ok(CliExecutableIdentity {
        path: path.to_path_buf(),
        sha256: hex::encode(hasher.finalize()),
        product_version: env!("CARGO_PKG_VERSION").into(),
    })
}

#[cfg(windows)]
fn open_read_nofollow(path: &Path) -> std::io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;

    OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
}

#[cfg(unix)]
fn open_read_nofollow(path: &Path) -> std::io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;

    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
}

#[cfg(not(any(windows, unix)))]
fn open_read_nofollow(path: &Path) -> std::io::Result<File> {
    OpenOptions::new().read(true).open(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn compatible_cli_fixture() -> Vec<u8> {
        let mut bytes = b"prefix".to_vec();
        bytes.extend_from_slice(&cli_steam_exec_identity());
        bytes.extend_from_slice(b"suffix");
        bytes
    }

    #[test]
    fn discovers_separate_cli_without_executing_it_or_searching_relative_directories() {
        let temp = tempfile::tempdir().unwrap();
        let sibling = temp.path().join("desktop folder");
        let search = temp.path().join("command folder");
        std::fs::create_dir(&sibling).unwrap();
        std::fs::create_dir(&search).unwrap();
        let desktop = sibling.join("portcove-desktop");
        let name = if cfg!(windows) {
            "portcove.exe"
        } else {
            "portcove"
        };
        let cli = search.join(name);
        std::fs::write(&cli, compatible_cli_fixture()).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        assert_eq!(
            discover_cli(
                Some(&desktop),
                [PathBuf::from("."), search.clone()].into_iter()
            ),
            Some(inspect_cli(&std::fs::canonicalize(&cli).unwrap()).unwrap())
        );
        std::fs::rename(&cli, sibling.join(name)).unwrap();
        assert_eq!(
            discover_cli(Some(&desktop), [search].into_iter()),
            Some(inspect_cli(&std::fs::canonicalize(sibling.join(name)).unwrap()).unwrap())
        );
        assert!(discover_cli(None, [PathBuf::from("."), PathBuf::new()].into_iter()).is_none());
    }

    #[test]
    fn rejects_wrong_or_stale_named_executables_without_running_them() {
        let temp = tempfile::tempdir().unwrap();
        let name = if cfg!(windows) {
            "portcove.exe"
        } else {
            "portcove"
        };
        let cli = temp.path().join(name);
        std::fs::write(&cli, b"unrelated bytes").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        assert!(discover_cli(None, [temp.path().to_path_buf()].into_iter()).is_none());

        std::fs::write(
            &cli,
            b"PORTCOVE_CLI_STEAM_EXEC_IDENTITY_V1|product=0.0.0|capability=exec",
        )
        .unwrap();
        assert!(discover_cli(None, [temp.path().to_path_buf()].into_iter()).is_none());
    }

    #[test]
    fn rejects_the_desktop_scanner_binary_as_a_cli_capability_provider() {
        let temp = tempfile::tempdir().unwrap();
        let renamed_desktop = temp.path().join(if cfg!(windows) {
            "portcove.exe"
        } else {
            "portcove"
        });
        std::fs::copy(std::env::current_exe().unwrap(), &renamed_desktop).unwrap();

        assert!(discover_cli(None, [temp.path().to_path_buf()].into_iter()).is_none());
        let error = inspect_cli(&renamed_desktop).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
        assert_eq!(
            error.to_string(),
            "standalone CLI does not advertise the compatible Steam exec contract"
        );
    }
}
