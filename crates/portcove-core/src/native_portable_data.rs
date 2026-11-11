//! Owned executable-parent data for Linux players with an upstream directory switch.

use std::{
    fs,
    io::ErrorKind,
    path::{Component, Path, PathBuf},
    process::Command,
};

use crate::{
    AdapterKind, LaunchSpec, Library, Platform, PortDefinition, PortcoveError, ReleaseSource,
    Result,
};

pub(crate) const NATIVE_CAPABILITY: u32 = 25;

pub(crate) fn directory_name(port: &PortDefinition, platform: Platform) -> Option<&str> {
    if platform == Platform::LinuxX86_64 {
        port.linux_portable_data_directory.as_deref()
    } else {
        None
    }
}

fn archive_selector(port: &PortDefinition) -> Option<(&str, &str)> {
    let [prefix, suffix] = port
        .release
        .asset_hints
        .get(&Platform::LinuxX86_64)?
        .as_slice()
    else {
        return None;
    };
    (!prefix.is_empty() && suffix.ends_with(".tar.gz")).then_some((prefix, suffix))
}

pub(crate) fn matches_archive(port: &PortDefinition, platform: Platform, asset: &str) -> bool {
    directory_name(port, platform).is_none()
        || archive_selector(port).is_some_and(|(prefix, suffix)| {
            crate::release::versioned_asset_name_matches(
                asset,
                &prefix.to_ascii_lowercase(),
                &suffix.to_ascii_lowercase(),
                false,
            )
        })
}

pub(crate) fn validate(port: &PortDefinition) -> Result<()> {
    let Some(directory) = port.linux_portable_data_directory.as_deref() else {
        return Ok(());
    };
    let linux = Platform::LinuxX86_64;
    crate::archive::validate_relative_path(directory, true)?;
    if port.adapter != AdapterKind::NativePortable
        || !port.platforms.contains(&linux)
        || port.release.provider != ReleaseSource::Github
        || archive_selector(port).is_none()
        || port.release.direct.contains_key(&linux)
        || port.release.curated.contains_key(&linux)
        || port.release.user_prepared.contains_key(&linux)
        || port.release.managed_build.contains_key(&linux)
        || !port.bundled_runtime.is_empty()
        || crate::preparation::managed(port)
        || port.source_profile.is_some()
        || port.bios_source_profile.is_some()
        || port.runtime_subdirectory.is_some()
        || port.launch_from_install_root
        || port.portable_marker
        || port.portable_marker_file.is_some()
        || port.windows_temp_directory.is_some()
        || port.external_profile_policy.is_some()
        || port.user_data_environment.is_some()
        || !port.launch_arguments.is_empty()
        || !port.launch_environment.is_empty()
        || directory.len() > 64
        || !directory.is_ascii()
        || directory.contains(['/', '\\'])
        || crate::path::is_portcove_metadata(Path::new(directory))
        || port
            .persistent_paths
            .iter()
            .filter(|path| *path == directory)
            .count()
            != 1
        || port
            .persistent_paths
            .iter()
            .any(|path| path != directory && crate::runtime::overlaps(path, directory))
        || port
            .persistent_file_patterns
            .iter()
            .any(|pattern| pattern.matches(directory))
    {
        return Err(PortcoveError::verification(
            "Linux portable data requires an official native archive, executable-parent launch and a dedicated persistent directory",
        ));
    }
    Ok(())
}

fn directory(root: &Path, executable: &Path, name: &str) -> Result<std::path::PathBuf> {
    let parent = executable
        .parent()
        .filter(|parent| parent.starts_with(root))
        .ok_or_else(|| {
            PortcoveError::verification("portable data is outside the managed runtime")
        })?;
    let directory = parent.join(name);
    crate::install::require_staged_path(root, &directory)?;
    let actual_parent = parent.canonicalize()?;
    let actual = crate::path::unicode(&actual_parent, "portable data folder")?;
    if actual.contains('\\') {
        return Err(PortcoveError::verification(
            "the game can reinterpret a backslash in its portable data path; choose a different library folder",
        ));
    }
    for (index, entry) in fs::read_dir(parent)?.enumerate() {
        if index >= 100_000 {
            return Err(PortcoveError::verification(
                "the portable data folder exceeds its directory inspection limit",
            ));
        }
        let sibling = entry?.file_name();
        if sibling
            .to_str()
            .is_some_and(|sibling| sibling != name && sibling.eq_ignore_ascii_case(name))
        {
            return Err(PortcoveError::verification(
                "the portable data path has a case alias",
            ));
        }
    }
    Ok(directory)
}

fn directory_exists(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() => Ok(true),
        Ok(_) => Err(PortcoveError::verification(
            "the portable data path is not a real directory",
        )),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

pub(crate) fn require_pristine_package(root: &Path, executable: &Path, name: &str) -> Result<()> {
    let path = directory(root, executable, name)?;
    crate::install::require_staged_path(root, executable)?;
    crate::permissions::require_platform_executable(
        executable,
        Platform::LinuxX86_64,
        "portable Linux player",
    )?;
    let header = crate::native_external_profile::read_amd64_elf_header(executable)?;
    if matches!(&header[8..11], b"AI\x01" | b"AI\x02") {
        return Err(PortcoveError::verification(
            "the portable Linux player must run directly from the extracted archive",
        ));
    }
    if directory_exists(&path)? && fs::read_dir(&path)?.next().transpose()?.is_some() {
        return Err(PortcoveError::verification(
            "the publisher package contains files in the player-owned portable data directory",
        ));
    }
    Ok(())
}

pub(crate) fn prepare(
    root: &Path,
    executable: &Path,
    name: &str,
    checkpoint: &dyn Fn() -> Result<()>,
) -> Result<()> {
    checkpoint()?;
    let path = directory(root, executable, name)?;
    match fs::create_dir(&path) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.into()),
    }
    checkpoint()?;
    require_ready(root, executable, name)
}

fn require_ready(root: &Path, executable: &Path, name: &str) -> Result<()> {
    if directory_exists(&directory(root, executable, name)?)? {
        return Ok(());
    }
    Err(PortcoveError::verification(
        "the portable data directory disappeared before launch",
    ))
}

pub(crate) fn require_launch(
    port: &PortDefinition,
    library: &Library,
    spec: &LaunchSpec,
    command: &Command,
    name: &str,
    checkpoint: &impl Fn() -> Result<()>,
) -> Result<()> {
    if command
        .get_envs()
        .any(|(key, value)| key == "LD_LIBRARY_PATH" && value.is_some_and(|path| !path.is_empty()))
    {
        return Err(PortcoveError::launch(
            "LD_LIBRARY_PATH changes where the game loads libraries; use the default loader paths or a separately prepared copy",
        ));
    }
    require_ready(&spec.install_root, &spec.executable, name)?;
    if port.id == "nicholas-ochoa-opensc2k" {
        require_sticky_system_tmp()?;
        require_opensc2k_external_writes(
            library,
            &spec.install_root,
            command,
            Path::new("/tmp/OpenSC2K Autosaves"),
            checkpoint,
        )?;
    }
    Ok(())
}

fn godot_data_base(command: &Command) -> Result<PathBuf> {
    let path = |name: &str| {
        command
            .get_envs()
            .find(|(key, _)| *key == name)
            .and_then(|(_, value)| value)
            .map(PathBuf::from)
            .map(|path| {
                let text = crate::path::unicode(&path, "Godot profile location")?;
                if text.contains('\\') || text.contains(":/") {
                    return Err(PortcoveError::launch(
                        "Godot profile location has ambiguous path separators",
                    ));
                }
                Ok(path)
            })
            .transpose()
    };
    if let Some(data) = path("XDG_DATA_HOME")?.filter(|value| value.is_absolute()) {
        return Ok(data);
    }
    let fallback = if let Some(home) = path("HOME")? {
        home.join(".local/share")
    } else {
        path("XDG_CONFIG_HOME")?.unwrap_or_default()
    };
    if fallback.is_absolute() {
        Ok(fallback)
    } else {
        Err(PortcoveError::launch(
            "Godot's profile would resolve relative to the game folder; use an absolute HOME or XDG_DATA_HOME",
        ))
    }
}

fn require_opensc2k_external_writes(
    library: &Library,
    install: &Path,
    command: &Command,
    autosaves: &Path,
    checkpoint: &impl Fn() -> Result<()>,
) -> Result<()> {
    let profile = godot_data_base(command)?.join("godot/app_userdata/OpenSC2K");
    let logs = profile.join("logs");
    let lock = profile.join(".recovery_mode_lock");
    let owned = library
        .output_roots()?
        .into_iter()
        .map(|root| root.path)
        .chain([library.root().to_owned(), install.to_owned()])
        .map(|root| crate::path::resolve_existing_ancestor(&root))
        .collect::<Result<Vec<_>>>()?;
    for path in [profile.as_path(), &logs, &lock, autosaves] {
        checkpoint()?;
        if path
            .components()
            .any(|component| component == Component::ParentDir)
        {
            return Err(PortcoveError::launch(
                "OpenSC2K's external profile location has an ambiguous parent path",
            ));
        }
        let resolved = crate::path::resolve_existing_ancestor(path)?;
        if owned
            .iter()
            .any(|root| resolved.starts_with(root) || root.starts_with(&resolved))
        {
            return Err(PortcoveError::launch(
                "OpenSC2K's engine logs or temporary autosaves overlap a managed runtime; preserve that data and use an external location",
            ));
        }
    }
    let logs = crate::path::resolve_existing_ancestor(&logs)?;
    crate::external_runtime::shared_preferences::check_bounded_tree(
        &logs,
        "OpenSC2K logs",
        |_, _| checkpoint(),
    )?;
    match fs::symlink_metadata(&lock) {
        Ok(_) => {
            let lock =
                crate::path::resolve_existing_ancestor(&profile)?.join(".recovery_mode_lock");
            crate::external_runtime::open_single_link_file(&lock)?;
        }
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    reserve_personal_autosaves(autosaves)?;
    crate::external_runtime::shared_preferences::check_bounded_tree(
        autosaves,
        "OpenSC2K temporary autosaves",
        |entry, _| {
            checkpoint()?;
            require_personal_autosaves(entry)
        },
    )?;
    Ok(())
}

fn require_sticky_system_tmp() -> Result<()> {
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::MetadataExt;
        let temporary = fs::symlink_metadata("/tmp")?;
        if !temporary.is_dir() || temporary.uid() != 0 || temporary.mode() & 0o1000 == 0 {
            return Err(PortcoveError::launch(
                "OpenSC2K needs a root-owned sticky /tmp for its temporary autosaves",
            ));
        }
    }
    Ok(())
}

fn reserve_personal_autosaves(path: &Path) -> Result<()> {
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::DirBuilderExt;
        // The upstream writer uses a fixed name. Claim only an absent directory
        // under the checked sticky parent before another account can create it.
        match fs::DirBuilder::new().mode(0o700).create(path) {
            Ok(()) => {}
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
    }
    require_personal_autosaves(path)
}

fn require_personal_autosaves(path: &Path) -> Result<()> {
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::MetadataExt;
        let metadata = fs::symlink_metadata(path)?;
        // SAFETY: geteuid has no pointer arguments and does not modify state.
        if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o022 != 0 {
            return Err(PortcoveError::launch(
                "OpenSC2K found temporary autosaves with shared or foreign ownership; preserve them before using the managed player",
            ));
        }
    }
    #[cfg(not(target_os = "linux"))]
    let _ = path;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn linux_portable_directory_declares_one_owned_executable_parent() {
        let catalog = crate::Catalog::embedded().unwrap();
        let port = catalog.port("nicholas-ochoa-opensc2k").unwrap();
        assert_eq!(directory_name(port, Platform::LinuxX86_64), Some("data"));
        assert_eq!(directory_name(port, Platform::WindowsX86_64), None);
        assert!(validate(port).is_ok());
        for directory in ["", ".", "../data", "data/nested", "Data", "other"] {
            let mut invalid = port.clone();
            invalid.linux_portable_data_directory = Some(directory.into());
            assert!(validate(&invalid).is_err(), "{directory}");
        }
        let mut invalid = port.clone();
        invalid
            .release
            .asset_hints
            .insert(Platform::LinuxX86_64, vec!["game.AppImage".into()]);
        assert!(validate(&invalid).is_err());
        let mut invalid = port.clone();
        invalid.persistent_paths.push("data/nested".into());
        assert!(validate(&invalid).is_err());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn opensc2k_godot_data_fallback_requires_an_external_absolute_base() {
        use std::os::unix::fs::PermissionsExt;

        let mut command = crate::ChildProcessPolicy::native_command(
            crate::ChildProcessClass::Game,
            "inert-player",
        )
        .unwrap();
        command
            .env_clear()
            .env("HOME", "relative")
            .env("XDG_DATA_HOME", "relative");
        assert!(godot_data_base(&command).is_err());
        command.env("XDG_DATA_HOME", "/profiles");
        assert_eq!(godot_data_base(&command).unwrap(), Path::new("/profiles"));
        command
            .env("HOME", "/home/player")
            .env("XDG_DATA_HOME", "relative");
        assert_eq!(
            godot_data_base(&command).unwrap(),
            Path::new("/home/player/.local/share")
        );
        command.env_remove("HOME").env("XDG_CONFIG_HOME", "/config");
        assert_eq!(godot_data_base(&command).unwrap(), Path::new("/config"));
        command.env("XDG_DATA_HOME", "C:/redirect");
        assert!(godot_data_base(&command).is_err());

        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let data = temporary.path().join("xdg");
        let profile = data.join("godot/app_userdata/OpenSC2K");
        let logs = profile.join("logs");
        let autosaves = temporary.path().join("autosaves");
        fs::create_dir_all(&logs).unwrap();
        command.env("XDG_DATA_HOME", &data);
        let check = || {
            require_opensc2k_external_writes(
                &library,
                library.root(),
                &command,
                &autosaves,
                &|| Ok(()),
            )
        };
        assert!(check().is_ok());
        assert_eq!(
            fs::metadata(&autosaves).unwrap().permissions().mode() & 0o777,
            0o700
        );

        let managed = library.root().join("sentinel");
        fs::write(&managed, b"keep").unwrap();
        let log = logs.join("godot.log");
        std::os::unix::fs::symlink(&managed, &log).unwrap();
        assert!(check().is_err());
        fs::remove_file(&log).unwrap();
        fs::hard_link(&managed, profile.join(".recovery_mode_lock")).unwrap();
        assert!(check().is_err());
        fs::remove_file(profile.join(".recovery_mode_lock")).unwrap();

        std::os::unix::fs::symlink(&managed, autosaves.join("city.sc2x")).unwrap();
        assert!(check().is_err());
        assert_eq!(fs::read(&managed).unwrap(), b"keep");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn portable_directory_creation_preserves_data_and_refuses_redirects() {
        use std::os::unix::fs::PermissionsExt;

        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("runtime");
        let executable = root.join("player");
        let path = root.join("data");
        fs::create_dir(&root).unwrap();
        let mut header = [0_u8; 20];
        header[..6].copy_from_slice(b"\x7fELF\x02\x01");
        header[16..20].copy_from_slice(&[3, 0, 0x3e, 0]);
        fs::write(&executable, header).unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        require_pristine_package(&root, &executable, "data").unwrap();
        header[8..11].copy_from_slice(b"AI\x02");
        fs::write(&executable, header).unwrap();
        assert!(require_pristine_package(&root, &executable, "data").is_err());
        assert!(require_ready(&root, &executable, "data").is_err());
        prepare(&root, &executable, "data", &|| Ok(())).unwrap();
        fs::write(path.join("settings.cfg"), b"keep").unwrap();
        prepare(&root, &executable, "data", &|| Ok(())).unwrap();
        assert_eq!(fs::read(path.join("settings.cfg")).unwrap(), b"keep");

        fs::rename(&path, root.join("Data")).unwrap();
        assert!(prepare(&root, &executable, "data", &|| Ok(())).is_err());
        assert!(!path.exists());
        let foreign = temporary.path().join("foreign");
        fs::rename(root.join("Data"), &foreign).unwrap();
        std::os::unix::fs::symlink(&foreign, &path).unwrap();
        assert!(prepare(&root, &executable, "data", &|| Ok(())).is_err());
        assert_eq!(fs::read(foreign.join("settings.cfg")).unwrap(), b"keep");

        let ambiguous = temporary.path().join("a\\b");
        fs::create_dir(&ambiguous).unwrap();
        assert!(prepare(&ambiguous, &ambiguous.join("player"), "data", &|| Ok(())).is_err());
        assert!(!ambiguous.join("data").exists());
    }
}
