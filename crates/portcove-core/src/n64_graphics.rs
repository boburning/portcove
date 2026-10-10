//! Catalog-owned initial renderer choice, without changing retained user settings.
use std::{io::Write, path::Path};

use crate::{AdapterKind, Platform, PortDefinition, PortcoveError, Result};

pub(crate) fn validate(port: &PortDefinition) -> Result<()> {
    if !port.n64_windows_initial_d3d12 {
        return Ok(());
    }
    let prefix = port.runtime_subdirectory.as_deref().unwrap_or("");
    if port.adapter != AdapterKind::N64RecompPortable
        || !port.portable_marker
        || !port.platforms.contains(&Platform::WindowsX86_64)
        || port.user_data_environment.is_some()
        || ["graphics.json", "graphics.json.bak"]
            .into_iter()
            .any(|name| {
                let path = if prefix.is_empty() {
                    name.into()
                } else {
                    format!("{prefix}/{name}")
                };
                !port.persistent_paths.contains(&path)
            })
    {
        return Err(PortcoveError::usage(
            "initial D3D12 requires a Windows N64 portable runtime with persistent graphics settings",
        ));
    }
    Ok(())
}

pub(crate) fn prepare(
    port: &PortDefinition,
    platform: Platform,
    directory: &Path,
    checkpoint: &dyn Fn() -> Result<()>,
) -> Result<()> {
    if !port.n64_windows_initial_d3d12 || platform != Platform::WindowsX86_64 {
        return Ok(());
    }
    validate(port)?;
    checkpoint()?;
    crate::path::refuse_symlink_ancestors(directory)?;
    let destination = directory.join("graphics.json");
    // Upstream reads the backup if the primary is absent or malformed. Preserve
    // both names, including backup-only state; never mask that recovery choice.
    if settings_present(directory)? {
        return Ok(());
    }
    let mut staging = tempfile::NamedTempFile::new_in(directory)?;
    staging.write_all(b"{\"api_option\":\"D3D12\"}\n")?;
    staging.as_file().sync_all()?;
    checkpoint()?;
    crate::path::refuse_symlink_ancestors(directory)?;
    if settings_present(directory)? {
        return Ok(());
    }
    crate::durability::rename_noreplace(staging.path(), &destination)?;
    crate::durability::sync_publication(directory)
}

fn settings_present(directory: &Path) -> Result<bool> {
    let mut retained = false;
    for path in [
        directory.join("graphics.json"),
        directory.join("graphics.json.bak"),
    ] {
        match std::fs::symlink_metadata(path) {
            Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {
                retained = true
            }
            Ok(_) => {
                return Err(PortcoveError::verification(
                    "graphics settings must be regular files; existing state was retained",
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(retained)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adapter_initializes_in_the_runtime_coordinate_and_preserves_restored_settings() {
        use crate::adapter::{AdapterRegistry, LaunchSpecRequest};
        let root = tempfile::tempdir().unwrap();
        let library = crate::Library::open(root.path().join("library")).unwrap();
        let install = root.path().join("install");
        let port = port();
        let runtime = install.join(port.runtime_subdirectory.as_ref().unwrap());
        std::fs::create_dir_all(&runtime).unwrap();
        let executable = runtime.join("drmario64_recomp.exe");
        std::fs::write(&executable, b"nonexecuted fixture").unwrap();
        let request = LaunchSpecRequest {
            library: &library,
            port: &port,
            platform: Platform::WindowsX86_64,
            install_root: &install,
            selected_executable: &executable,
            source: None,
            source_record: None,
        };
        let adapter = AdapterRegistry.get(AdapterKind::N64RecompPortable);
        assert_eq!(
            adapter
                .prepare_launch_with_executable(request, &|| Ok(()))
                .unwrap()
                .working_directory,
            runtime
        );
        assert!(runtime.join("graphics.json").exists());
        assert!(!install.join("graphics.json").exists());
        // Models the canonical persistence restored before a reinstall launch.
        std::fs::write(runtime.join("graphics.json"), b"restored settings").unwrap();
        adapter
            .prepare_launch_with_executable(request, &|| Ok(()))
            .unwrap();
        assert_eq!(
            std::fs::read(runtime.join("graphics.json")).unwrap(),
            b"restored settings"
        );
    }

    #[cfg(windows)]
    #[test]
    fn junction_ancestry_is_refused_without_writing_the_target() {
        use std::os::windows::process::CommandExt;
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("target");
        let junction = root.path().join("junction");
        std::fs::create_dir(&target).unwrap();
        let result = crate::ChildProcessPolicy::native_command(
            crate::ChildProcessClass::HostTool,
            "cmd.exe",
        )
        .unwrap()
        .creation_flags(0x08000000)
        .args(["/C", "mklink", "/J"])
        .arg(&junction)
        .arg(&target)
        .output()
        .unwrap();
        assert!(
            result.status.success(),
            "junction fixture must actually exist: {:?}",
            result
        );
        assert!(prepare(&port(), Platform::WindowsX86_64, &junction, &|| Ok(())).is_err());
        assert_eq!(std::fs::read_dir(&target).unwrap().count(), 0);
    }
    fn port() -> PortDefinition {
        crate::Catalog::embedded()
            .unwrap()
            .port("dr-mario-64-recomp")
            .unwrap()
            .clone()
    }

    #[test]
    fn fresh_windows_uses_d3d12_but_other_platforms_and_absent_declarations_do_not_write() {
        let root = tempfile::tempdir().unwrap();
        prepare(&port(), Platform::LinuxX86_64, root.path(), &|| Ok(())).unwrap();
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
        let mut legacy = port();
        legacy.n64_windows_initial_d3d12 = false;
        assert!(
            serde_json::to_value(&legacy)
                .unwrap()
                .get("n64_windows_initial_d3d12")
                .is_none()
        );
        prepare(&legacy, Platform::WindowsX86_64, root.path(), &|| Ok(())).unwrap();
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
        prepare(&port(), Platform::WindowsX86_64, root.path(), &|| Ok(())).unwrap();
        assert_eq!(
            std::fs::read(root.path().join("graphics.json")).unwrap(),
            b"{\"api_option\":\"D3D12\"}\n"
        );
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 1);
    }

    #[test]
    fn retained_choices_malformed_settings_and_backup_only_recovery_are_never_overwritten() {
        for (name, contents) in [
            ("graphics.json", b"{\"api_option\":\"Vulkan\"}".as_slice()),
            ("graphics.json", b"malformed".as_slice()),
            ("graphics.json.bak", b"{\"api_option\":\"Auto\"}".as_slice()),
        ] {
            let root = tempfile::tempdir().unwrap();
            std::fs::write(root.path().join(name), contents).unwrap();
            prepare(&port(), Platform::WindowsX86_64, root.path(), &|| Ok(())).unwrap();
            assert_eq!(std::fs::read(root.path().join(name)).unwrap(), contents);
            assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 1);
        }
    }

    #[test]
    fn cancellation_and_a_settings_writer_before_publication_preserve_state() {
        use std::cell::Cell;
        for cancel in [true, false] {
            let root = tempfile::tempdir().unwrap();
            let calls = Cell::new(0);
            let checkpoint = || {
                calls.set(calls.get() + 1);
                if calls.get() == 2 {
                    if cancel {
                        return Err(PortcoveError::new(
                            crate::ErrorCode::Cancelled,
                            "fixture cancellation",
                        ));
                    }
                    std::fs::write(root.path().join("graphics.json.bak"), b"retained backup")?;
                }
                Ok(())
            };
            let result = prepare(&port(), Platform::WindowsX86_64, root.path(), &checkpoint);
            assert_eq!(result.is_err(), cancel);
            assert!(!root.path().join("graphics.json").exists());
            assert_eq!(
                std::fs::read_dir(root.path()).unwrap().count(),
                usize::from(!cancel)
            );
        }
    }

    #[test]
    fn a_primary_settings_writer_before_publication_is_preserved() {
        use std::cell::Cell;
        let root = tempfile::tempdir().unwrap();
        let calls = Cell::new(0);
        let checkpoint = || {
            calls.set(calls.get() + 1);
            if calls.get() == 2 {
                std::fs::write(
                    root.path().join("graphics.json"),
                    b"concurrent user settings",
                )?;
            }
            Ok(())
        };
        prepare(&port(), Platform::WindowsX86_64, root.path(), &checkpoint).unwrap();
        assert_eq!(
            std::fs::read(root.path().join("graphics.json")).unwrap(),
            b"concurrent user settings"
        );
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 1);
    }

    #[test]
    fn undeclared_persistence_and_nonregular_settings_are_refused() {
        let mut invalid = port();
        invalid
            .persistent_paths
            .retain(|path| !path.ends_with("graphics.json.bak"));
        assert!(validate(&invalid).is_err());
        invalid = port();
        invalid.adapter = AdapterKind::LibultrashipPortable;
        assert!(validate(&invalid).is_err());
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("graphics.json")).unwrap();
        assert!(prepare(&port(), Platform::WindowsX86_64, root.path(), &|| Ok(())).is_err());
        assert!(root.path().join("graphics.json").is_dir());
    }
}
