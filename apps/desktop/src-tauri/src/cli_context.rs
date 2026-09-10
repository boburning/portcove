//! Read-only host discovery for command-line handoff; never execute the CLI.
use std::path::{Path, PathBuf};

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
        let current = std::env::current_exe().ok();
        let search = std::env::var_os("PATH").unwrap_or_default();
        Ok(CliCommandContext {
            library_root: service.library().root().to_path_buf(),
            executable: discover_cli(current.as_deref(), std::env::split_paths(&search)),
            platform: portcove_core::Platform::current()?,
        })
    })
    .await
}

fn discover_cli(current: Option<&Path>, search: impl Iterator<Item = PathBuf>) -> Option<PathBuf> {
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
            let metadata = std::fs::metadata(&candidate).ok()?;
            if !metadata.is_file() {
                return None;
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if metadata.permissions().mode() & 0o111 == 0 {
                    return None;
                }
            }
            let resolved = std::fs::canonicalize(candidate).ok()?;
            resolved.to_str()?;
            Some(resolved)
        })
}

#[cfg(test)]
mod tests {
    use super::*;

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
        std::fs::write(&cli, "not executable test content").unwrap();
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
            Some(std::fs::canonicalize(&cli).unwrap())
        );
        std::fs::rename(&cli, sibling.join(name)).unwrap();
        assert_eq!(
            discover_cli(Some(&desktop), [search].into_iter()),
            Some(std::fs::canonicalize(sibling.join(name)).unwrap())
        );
        assert!(discover_cli(None, [PathBuf::from("."), PathBuf::new()].into_iter()).is_none());
    }
}
