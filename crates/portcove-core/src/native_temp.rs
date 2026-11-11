//! Native5 Windows temporary files remain inside the existing owned data scope.
//! Native10 sibling platforms reuse the owned directory without Windows environment.
//! No independent scratch lifetime or cleanup authority is introduced. Relative
//! TEMP/TMP values require upstream to preserve the reviewed working directory.
use std::{collections::BTreeMap, fs, path::Path};

use crate::{AdapterKind, LaunchSpec, Platform, PortDefinition, PortcoveError, Result};

pub(crate) fn has_sibling_platforms(port: &PortDefinition) -> bool {
    port.windows_temp_directory.is_some()
        && port.release.provider == crate::ReleaseSource::Github
        && crate::preparation::source::native(port)
        && port.platforms.len() > 1
        && port.platforms.contains(&Platform::WindowsX86_64)
}

pub(crate) fn validate(port: &PortDefinition) -> Result<()> {
    let Some(directory) = &port.windows_temp_directory else {
        return Ok(());
    };
    crate::archive::validate_relative_path(directory, true)?;
    if port.adapter != AdapterKind::NativePortable
        || (port.platforms != [Platform::WindowsX86_64] && !has_sibling_platforms(port))
        || port.windows_runtime_path_policy
            != Some(crate::WindowsRuntimePathPolicy::RelativeFileMaxPath)
        || directory.len() > 64
        || directory.contains(['/', '\\'])
        || port
            .persistent_file_patterns
            .iter()
            .any(|pattern| pattern.matches(directory))
        || crate::path::is_portcove_metadata(Path::new(directory))
        || port
            .persistent_paths
            .iter()
            .filter(|path| *path == directory)
            .count()
            != 1
    {
        return Err(PortcoveError::usage(
            "Windows temporary data requires Native5, a dedicated declared ASCII directory and relative-file-max-path policy",
        ));
    }
    let key = directory.to_ascii_lowercase();
    for path in &port.persistent_paths {
        if path != directory {
            let other = path.to_ascii_lowercase();
            if other == key
                || other.starts_with(&format!("{key}/"))
                || key.starts_with(&format!("{other}/"))
            {
                return Err(PortcoveError::usage(
                    "Windows temporary data overlaps another persistent namespace",
                ));
            }
        }
    }
    Ok(())
}

pub(crate) fn environment(
    port: &PortDefinition,
    platform: Platform,
    environment: &mut BTreeMap<String, String>,
) -> Result<()> {
    validate(port)?;
    if let Some(directory) = &port.windows_temp_directory {
        if platform != Platform::WindowsX86_64 {
            if has_sibling_platforms(port) && port.platforms.contains(&platform) {
                return Ok(());
            }
            return Err(PortcoveError::unsupported(
                "entry-owned Windows temporary data requires Windows",
            ));
        }
        for key in ["TEMP", "TMP"] {
            if environment.insert(key.into(), directory.clone()).is_some() {
                return Err(PortcoveError::verification(
                    "Windows temporary data conflicts with another launch environment authority",
                ));
            }
        }
    }
    Ok(())
}

/// Canonical bytes alone cannot prove the interpretation of a new TEMP scope.
/// Reuse the active creating contract, otherwise preserve any existing name.
pub(crate) fn require_canonical_data(
    port: &PortDefinition,
    library: &crate::Library,
) -> Result<()> {
    let Some(directory) = &port.windows_temp_directory else {
        return Ok(());
    };
    validate(port)?;
    let active = library
        .status(&port.id, crate::ReleaseChannel::Stable)?
        .active;
    if let Some(active) = active {
        let installer = crate::install::Installer::new(library.clone())?;
        let catalog = installer.retained_catalog(&active)?.ok_or_else(|| PortcoveError::conflict(
            "Temporary data needs its exact active creating contract; preserve the existing files",
        ))?;
        if catalog.port(&port.id)?.windows_temp_directory.as_ref() != Some(directory) {
            return Err(PortcoveError::conflict(
                "The new runtime changes the interpretation of temporary data; preserve both copies for review",
            ).with_known_cause(crate::failure::KnownFailureCause::PortableDataContractChanged));
        }
        return Ok(());
    }
    crate::persistence::require_absent_path(&library.user_dir(&port.id), directory).map_err(
        |error| {
            error.with_known_cause(crate::failure::KnownFailureCause::PortableDataContractChanged)
        },
    )
}

fn check_directory(
    port: &PortDefinition,
    platform: Platform,
    install: &Path,
    working: &Path,
    executable: &Path,
    require_present: bool,
) -> Result<()> {
    validate(port)?;
    let Some(directory) = &port.windows_temp_directory else {
        return Ok(());
    };
    if !working.starts_with(install)
        || working != crate::runtime::working_root_for_executable(port, install, executable)
    {
        return Err(PortcoveError::verification(
            "the managed profile lost its owned runtime/data namespace",
        ));
    }
    let target = working.join(directory);
    crate::runtime_path_policy::check_prepared_path(port, platform, &target)?;
    crate::install::require_staged_path(install, &target)?;
    let mut found = false;
    for (index, entry) in fs::read_dir(working)?.enumerate() {
        if index >= 100_000 {
            return Err(PortcoveError::verification(
                "managed profile namespace inspection exceeds its entry bound",
            ));
        }
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_str().ok_or_else(|| {
            PortcoveError::verification("managed profile namespace has a non-Unicode member")
        })?;
        if name.eq_ignore_ascii_case(directory) {
            if name != directory || found {
                return Err(PortcoveError::conflict(
                    "the managed profile directory has a case alias",
                ));
            }
            found = true;
            if !fs::symlink_metadata(entry.path())?.is_dir() {
                return Err(PortcoveError::conflict(
                    "the managed profile path is not an owned directory",
                ));
            }
        }
    }
    if require_present && !found {
        return Err(PortcoveError::verification(
            "the managed profile directory disappeared before launch",
        ));
    }
    Ok(())
}

pub(crate) fn require_pristine_package(
    port: &PortDefinition,
    platform: Platform,
    install: &Path,
    executable: &Path,
) -> Result<()> {
    let Some(directory) = &port.windows_temp_directory else {
        return Ok(());
    };
    let working = crate::runtime::working_root_for_executable(port, install, executable);
    check_directory(port, platform, install, &working, executable, false)?;
    match fs::symlink_metadata(working.join(directory)) {
        Ok(_) => {
            return Err(PortcoveError::verification(
                "publisher package occupies the managed profile namespace",
            ));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    Ok(())
}

pub(crate) fn prepare(
    port: &PortDefinition,
    platform: Platform,
    install: &Path,
    working: &Path,
    executable: &Path,
    checkpoint: &dyn Fn() -> Result<()>,
) -> Result<()> {
    let Some(directory) = &port.windows_temp_directory else {
        return Ok(());
    };
    checkpoint()?;
    check_directory(port, platform, install, working, executable, false)?;
    match fs::create_dir(working.join(directory)) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.into()),
    }
    // Interrupted preparation may leave only declared data. Nothing is deleted;
    // the existing data collection/recovery authority retains these bytes.
    checkpoint()?;
    check_directory(port, platform, install, working, executable, true)
}

pub(crate) fn recheck(
    port: &PortDefinition,
    platform: Platform,
    spec: &LaunchSpec,
    checkpoint: &dyn Fn() -> Result<()>,
) -> Result<()> {
    let Some(directory) = &port.windows_temp_directory else {
        return Ok(());
    };
    check_directory(
        port,
        platform,
        &spec.install_root,
        &spec.working_directory,
        &spec.executable,
        true,
    )?;
    if platform == Platform::WindowsX86_64 {
        for key in ["TEMP", "TMP"] {
            if spec.environment.get(key) != Some(directory) {
                return Err(PortcoveError::verification(
                    "Windows temporary launch environment changed before spawn",
                ));
            }
        }
    }
    if platform != Platform::WindowsX86_64 {
        crate::external_runtime::shared_preferences::check_bounded_tree(
            &spec.working_directory.join(directory),
            "managed profile",
            |_, _| checkpoint(),
        )?;
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::{Adapter, LaunchSpecRequest, Library};

    const WINDOWS: Platform = Platform::WindowsX86_64;

    pub(crate) fn port() -> PortDefinition {
        serde_json::from_value(serde_json::json!({
            "id":"native-temp-fixture", "name":"Native temporary data fixture",
            "summary":"Synthetic native temporary data contract", "project_url":"https://example.invalid/native-temp",
            "support_tier":"beta", "channels":["stable"], "platforms":["windows-x86-64"],
            "adapter":"native-portable", "release":{"repository":"fixture/native-temp"},
            "executable_hints":{"windows-x86-64":["player.exe"]},
            "persistent_paths":["temp","saves"],
            "windows_runtime_path_policy":"relative-file-max-path", "windows_temp_directory":"temp"
        })).unwrap()
    }

    #[cfg(unix)]
    fn spec(root: &Path) -> LaunchSpec {
        let mut environment = BTreeMap::new();
        super::environment(&port(), WINDOWS, &mut environment).unwrap();
        LaunchSpec {
            executable: root.join("player.exe"),
            install_root: root.into(),
            working_directory: root.into(),
            environment,
            arguments: Vec::new(),
            fixed_arguments_only: false,
            launch_kind: crate::LaunchKind::Native,
        }
    }

    #[test]
    fn directory_is_a_dedicated_windows_data_namespace_not_an_environment_escape() {
        let valid = port();
        validate(&valid).unwrap();
        for invalid in [
            "",
            ".",
            "..",
            "a/b",
            "a\\b",
            "CON",
            "con.txt",
            "aux",
            "NUL",
            "LPT9",
            "temp:stream",
            "temp.",
            "temp ",
            "tëmp",
            ".portcove-manifest.json",
        ] {
            let mut changed = valid.clone();
            changed.windows_temp_directory = Some(invalid.into());
            changed.persistent_paths = vec![invalid.into()];
            assert!(validate(&changed).is_err(), "{invalid}");
        }
        for paths in [
            vec!["saves"],
            vec!["Temp"],
            vec!["temp", "TEMP"],
            vec!["temp", "temp/saves"],
        ] {
            let mut changed = valid.clone();
            changed.persistent_paths = paths.into_iter().map(str::to_owned).collect();
            assert!(validate(&changed).is_err());
        }
        let mut changed = valid.clone();
        changed.platforms = vec![Platform::LinuxX86_64];
        assert!(validate(&changed).is_err());
        changed = valid.clone();
        changed.adapter = AdapterKind::StagedSourcePortable;
        assert!(validate(&changed).is_err());
        changed = valid;
        changed.windows_runtime_path_policy = None;
        assert!(validate(&changed).is_err());
        let mut patterned = port();
        patterned.windows_temp_directory = Some("temp1.cfg".into());
        patterned.persistent_paths = vec!["temp1.cfg".into()];
        patterned.persistent_file_patterns = serde_json::from_value(serde_json::json!([
            {"prefix":"temp", "suffix":".cfg"}
        ]))
        .unwrap();
        assert!(validate(&patterned).is_err());
    }

    #[test]
    fn adoption_requires_an_absent_temp_namespace_before_publishing_a_manifest() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("runtime");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("player.exe"), b"inert executable fixture").unwrap();
        let port = port();
        let catalog = crate::Catalog::from_json(
            &serde_json::json!({
            "schema_version":1, "ports":[port]
            })
            .to_string(),
        )
        .unwrap();
        let qualification =
            crate::install::InstallQualification::from_catalog(&catalog, &port.id, WINDOWS)
                .unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let installer = crate::install::Installer::new(library.clone()).unwrap();
        let artifact = crate::ArtifactIdentity {
            asset_name: "native-fixture.zip".into(),
            sha256: "a".repeat(64),
            size: 24,
        };
        let publish = || {
            installer.create_manifest("adopted", &port.id, "v1", &artifact, &qualification, &root)
        };
        fs::create_dir(root.join("temp")).unwrap();
        fs::write(root.join("temp/witness.bin"), b"foreign bytes").unwrap();
        assert!(publish().is_err());
        assert_eq!(
            fs::read(root.join("temp/witness.bin")).unwrap(),
            b"foreign bytes"
        );
        assert!(!root.join(".portcove-manifest.json").exists());
        fs::remove_file(root.join("temp/witness.bin")).unwrap();
        assert!(publish().is_err());
        fs::remove_dir(root.join("temp")).unwrap();
        let canonical = library.user_dir(&port.id);
        fs::create_dir_all(canonical.join("temp")).unwrap();
        fs::write(
            canonical.join("temp/witness.bin"),
            b"unproven canonical bytes",
        )
        .unwrap();
        assert!(publish().is_err());
        assert_eq!(
            fs::read(canonical.join("temp/witness.bin")).unwrap(),
            b"unproven canonical bytes"
        );
        assert!(!root.join(".portcove-manifest.json").exists());
        fs::remove_file(canonical.join("temp/witness.bin")).unwrap();
        assert!(publish().is_err());
        fs::remove_dir(canonical.join("temp")).unwrap();
        publish().unwrap();
        assert!(root.join(".portcove-manifest.json").is_file());
        assert!(!root.join("temp").exists());
    }

    #[test]
    fn readonly_launch_inspection_does_not_create_the_directory_and_preparation_is_explicit() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("runtime-ü");
        fs::create_dir(&root).unwrap();
        let executable = root.join("player.exe");
        fs::write(&executable, b"inert fixture, never executed").unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let port = port();
        let request = LaunchSpecRequest {
            library: &library,
            port: &port,
            platform: WINDOWS,
            install_root: &root,
            selected_executable: &executable,
            source: None,
            source_record: None,
            disc_progress: None,
        };
        let readonly = crate::adapter::standard(AdapterKind::NativePortable)
            .launch_spec_with_executable(request, &|| Ok(()))
            .unwrap();
        assert_eq!(readonly.environment["TEMP"], "temp");
        assert_eq!(readonly.environment["TMP"], "temp");
        assert!(!root.join("temp").exists());
        assert!(recheck(&port, WINDOWS, &readonly, &|| Ok(())).is_err());
        require_pristine_package(&port, WINDOWS, &root, &executable).unwrap();
        prepare(&port, WINDOWS, &root, &root, &executable, &|| Ok(())).unwrap();
        recheck(&port, WINDOWS, &readonly, &|| Ok(())).unwrap();
        assert!(root.join("temp").is_dir());
        assert!(require_pristine_package(&port, WINDOWS, &root, &executable).is_err());
        let mut changed = readonly;
        changed
            .environment
            .insert("TEMP".into(), "../foreign".into());
        assert!(recheck(&port, WINDOWS, &changed, &|| Ok(())).is_err());
    }

    #[test]
    fn existing_bytes_survive_interrupted_preparation_without_cleanup_or_namespace_adoption() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path();
        let executable = root.join("player.exe");
        fs::write(&executable, b"inert").unwrap();
        let calls = std::cell::Cell::new(0);
        let checkpoint = || {
            calls.set(calls.get() + 1);
            if calls.get() == 2 {
                Err(PortcoveError::state("injected interrupted preparation"))
            } else {
                Ok(())
            }
        };
        assert!(prepare(&port(), WINDOWS, root, root, &executable, &checkpoint).is_err());
        assert!(root.join("temp").is_dir());
        let witness = root.join("temp/witness.bin");
        fs::write(&witness, b"retained temporary bytes").unwrap();
        prepare(&port(), WINDOWS, root, root, &executable, &|| Ok(())).unwrap();
        assert_eq!(fs::read(&witness).unwrap(), b"retained temporary bytes");
        assert!(require_pristine_package(&port(), WINDOWS, root, &executable).is_err());
        fs::remove_file(&witness).unwrap();
        fs::remove_dir(root.join("temp")).unwrap();
        fs::write(root.join("temp"), b"foreign occupied file").unwrap();
        assert!(prepare(&port(), WINDOWS, root, root, &executable, &|| Ok(())).is_err());
        assert_eq!(
            fs::read(root.join("temp")).unwrap(),
            b"foreign occupied file"
        );
    }

    #[test]
    fn aliases_wrapper_changes_and_legacy_omission_keep_their_interpretation() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path();
        let executable = root.join("player.exe");
        fs::write(&executable, b"inert").unwrap();
        fs::create_dir(root.join("TEMP")).unwrap();
        assert!(prepare(&port(), WINDOWS, root, root, &executable, &|| Ok(())).is_err());
        fs::remove_dir(root.join("TEMP")).unwrap();
        let mut wrapped = port();
        wrapped.runtime_subdirectory = Some("wrapper".into());
        fs::create_dir(root.join("wrapper")).unwrap();
        let player = root.join("wrapper/player.exe");
        fs::write(&player, b"inert").unwrap();
        prepare(
            &wrapped,
            WINDOWS,
            root,
            &root.join("wrapper"),
            &player,
            &|| Ok(()),
        )
        .unwrap();
        assert!(root.join("wrapper/temp").is_dir());
        assert!(!root.join("temp").exists());
        assert!(prepare(&wrapped, WINDOWS, root, root, &player, &|| Ok(())).is_err());
        let mut old = port();
        old.windows_temp_directory = None;
        assert!(
            serde_json::to_value(&old)
                .unwrap()
                .get("windows_temp_directory")
                .is_none()
        );
        let mut inherited = BTreeMap::from([("EXISTING".into(), "value".into())]);
        super::environment(&old, Platform::LinuxX86_64, &mut inherited).unwrap();
        assert_eq!(inherited.len(), 1);
        prepare(
            &old,
            WINDOWS,
            Path::new("absent"),
            Path::new("absent"),
            Path::new("absent"),
            &|| panic!("legacy must remain inert"),
        )
        .unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn windows_junction_cannot_redirect_owned_temporary_data() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("runtime");
        let foreign = temporary.path().join("foreign");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&foreign).unwrap();
        fs::write(foreign.join("witness"), b"foreign bytes").unwrap();
        let executable = root.join("player.exe");
        fs::write(&executable, b"inert").unwrap();
        let target = root.join("temp");
        for path in [&target, &foreign] {
            assert!(
                !path
                    .to_str()
                    .unwrap()
                    .contains(['"', '%', '!', '&', '|', '<', '>', '^', '\r', '\n'])
            );
        }
        let mut command = crate::ChildProcessPolicy::native_tool_spec(
            crate::ChildProcessClass::HostTool,
            "cmd.exe",
        )
        .unwrap();
        command.raw_arg(format!(
            "/D /V:OFF /C mklink /J \"{}\" \"{}\"",
            target.display(),
            foreign.display()
        ));
        let started = std::time::Instant::now();
        let result = crate::tool_process::run_tool(
            &mut command,
            &|| {
                if started.elapsed() >= std::time::Duration::from_secs(2) {
                    Err(PortcoveError::state(
                        "temporary-data junction fixture exceeded two seconds",
                    ))
                } else {
                    Ok(())
                }
            },
            crate::tool_process::ToolProcessObserver {
                diagnostics: None,
                quiesced: None,
            },
        )
        .unwrap();
        assert!(result.status.success(), "{}", result.output);
        assert!(prepare(&port(), WINDOWS, &root, &root, &executable, &|| Ok(())).is_err());
        assert_eq!(fs::read(foreign.join("witness")).unwrap(), b"foreign bytes");
        assert_eq!(fs::read_dir(&foreign).unwrap().count(), 1);
        fs::remove_dir(target).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn windows_real_child_overrides_inherited_temp_and_writes_inside_unicode_working_directory() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("runtime-ü");
        fs::create_dir(&root).unwrap();
        let executable = root.join("player.exe");
        fs::write(&executable, b"inert").unwrap();
        prepare(&port(), WINDOWS, &root, &root, &executable, &|| Ok(())).unwrap();
        let inherited = std::env::var_os("TEMP");
        assert_ne!(inherited.as_deref(), Some(std::ffi::OsStr::new("temp")));
        let mut environment = BTreeMap::new();
        super::environment(&port(), WINDOWS, &mut environment).unwrap();
        environment.insert("PORTCOVE_NATIVE_TEMP_CHILD".into(), "1".into());
        let specification = crate::GameProcessSpec {
            executable: std::env::current_exe().unwrap(),
            launch_kind: crate::LaunchKind::Native,
            working_directory: root.clone(),
            environment,
            fixed_arguments: vec![
                "--exact".into(),
                "native_temp::tests::windows_temp_child".into(),
                "--ignored".into(),
                "--nocapture".into(),
            ],
            fixed_arguments_only: true,
        };
        let output = crate::ChildProcessPolicy::game_command(&specification, &[])
            .unwrap()
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            fs::read(root.join("temp/child-witness.bin")).unwrap(),
            b"owned temporary bytes"
        );
        assert_eq!(std::env::var_os("TEMP"), inherited);
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "invoked only by the owned native temporary-data process fixture"]
    fn windows_temp_child() {
        if std::env::var("PORTCOVE_NATIVE_TEMP_CHILD").as_deref() != Ok("1") {
            return;
        }
        assert_eq!(std::env::var("TEMP").unwrap(), "temp");
        assert_eq!(std::env::var("TMP").unwrap(), "temp");
        assert!(std::env::current_dir().unwrap().ends_with("runtime-ü"));
        fs::write(
            Path::new(&std::env::var("TEMP").unwrap()).join("child-witness.bin"),
            b"owned temporary bytes",
        )
        .unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn redirects_are_refused_before_preparation_and_again_before_spawn() {
        use std::os::unix::fs::symlink;
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("runtime");
        let foreign = temporary.path().join("foreign");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&foreign).unwrap();
        fs::write(foreign.join("witness"), b"unrelated").unwrap();
        let executable = root.join("player.exe");
        fs::write(&executable, b"inert").unwrap();
        symlink(&foreign, root.join("temp")).unwrap();
        assert!(prepare(&port(), WINDOWS, &root, &root, &executable, &|| Ok(())).is_err());
        assert!(recheck(&port(), WINDOWS, &spec(&root), &|| Ok(())).is_err());
        assert_eq!(fs::read(foreign.join("witness")).unwrap(), b"unrelated");
    }
}
