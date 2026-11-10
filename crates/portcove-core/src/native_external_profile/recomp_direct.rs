//! Direct RecompFrontend packages with the reviewed default profile.
use std::{
    ffi::OsStr,
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
    process::Command,
};

use crate::{Platform, PortDefinition, PortcoveError, ReleaseChannel, Result};

pub(crate) const NATIVE_CAPABILITY: u32 = 21;
const PLAYER: &str = "BodyHarvestRecompiled";

pub(super) fn validate(port: &PortDefinition) -> Result<()> {
    let valid_route = |platform| {
        let (suffix, executable) = match platform {
            Platform::WindowsX86_64 => ("-Windows.zip", "BodyHarvestRecompiled.exe"),
            Platform::LinuxX86_64 => ("-Linux-X64.tar.gz", PLAYER),
            Platform::MacosX86_64 | Platform::MacosAarch64 => return false,
        };
        port.release
            .asset_hints
            .get(&platform)
            .is_some_and(|hints| hints == &["BodyHarvestRecompiled-", suffix])
            && port
                .executable_hints
                .get(&platform)
                .is_some_and(|hints| hints == &[executable])
            && (platform == Platform::WindowsX86_64
                || port.reviewed_package_layouts.contains_key(&platform))
    };
    if port.channels != [ReleaseChannel::Stable]
        || port.source_profile.is_some()
        || !port.release.direct.is_empty()
        || !port.release.curated.is_empty()
        || !port.release.managed_build.is_empty()
        || !port.release.user_prepared.is_empty()
        || !port.platforms.iter().copied().all(valid_route)
    {
        return Err(PortcoveError::verification(
            "Body Harvest requires the reviewed direct player and package layout",
        ));
    }
    Ok(())
}

pub(crate) fn require_default_profile(working_directory: &Path) -> Result<()> {
    match fs::symlink_metadata(working_directory.join("portable.txt")) {
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
        Ok(_) => Err(PortcoveError::launch(
            "Body Harvest found a portable profile marker. Preserve the player data and use a separately prepared copy for that profile.",
        )),
    }
}

pub(super) fn require_no_profile_override(
    platform: Platform,
    configured_override: Option<&OsStr>,
) -> Result<()> {
    // The child environment intentionally excludes APP_FOLDER_PATH. An explicit
    // host override must not silently fall back to a different remembered ROM.
    if platform == Platform::LinuxX86_64 && configured_override.is_some() {
        return Err(PortcoveError::launch(
            "Body Harvest has an APP_FOLDER_PATH override. Preserve its data and use a separately prepared copy for that profile.",
        ));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
pub(super) fn profile_root(command: &Command) -> Result<PathBuf> {
    use super::{environment, require_absolute};
    let home = match environment(command, "HOME") {
        Some(home) => Some(home),
        None => super::unix_account_home()?,
    };
    Ok(require_absolute(home.as_deref(), "HOME")?
        .join(".config")
        .join(PLAYER))
}

#[cfg(windows)]
pub(super) fn profile_root(_command: &Command) -> Result<PathBuf> {
    // BaseDirs uses the same LocalAppData Known Folder, without creating it.
    // Require it to exist, since the player verifies the folder in its lookup.
    directories::BaseDirs::new()
        .map(|dirs| dirs.data_local_dir().to_path_buf())
        .filter(|path| path.is_absolute() && path.is_dir())
        .map(|path| path.join(PLAYER))
        .ok_or_else(|| PortcoveError::launch(
            "Body Harvest could not resolve the Windows LocalAppData profile. Use a separately prepared copy.",
        ))
}

pub(crate) fn require_linux_player(executable: &Path) -> Result<()> {
    super::read_amd64_elf_header(executable).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recomp_direct_marker_is_held_without_removing_it() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path();
        require_default_profile(root).unwrap();
        let marker = root.join("portable.txt");
        fs::write(&marker, b"preserve me").unwrap();
        assert!(require_default_profile(root).is_err());
        assert_eq!(fs::read(&marker).unwrap(), b"preserve me");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn recomp_direct_profile_holds_host_overrides_and_runtime_overlap() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let library = crate::Library::open(root.join("library")).unwrap();
        let runtime = library.versions_dir().join("body");
        fs::create_dir_all(&runtime).unwrap();
        let home = root.join("home");
        let outside = home.join(".config").join(PLAYER);
        let spec = crate::LaunchSpec {
            executable: runtime.join(PLAYER),
            install_root: runtime.clone(),
            working_directory: runtime.clone(),
            environment: Default::default(),
            arguments: Vec::new(),
            fixed_arguments_only: true,
            launch_kind: crate::LaunchKind::Native,
        };
        let mut command =
            crate::ChildProcessPolicy::game_command(&spec.process_spec(), &[]).unwrap();
        command
            .env_clear()
            .env("HOME", &home)
            .env("XDG_CONFIG_HOME", &runtime);
        assert_eq!(
            profile_root(&command).unwrap(),
            home.join(".config").join(PLAYER)
        );
        let check = |command: &Command| {
            super::super::require_external_roots(
                crate::ExternalProfilePolicy::RecompDirectV1,
                &library,
                &spec,
                command,
                &|| Ok(()),
            )
        };
        fs::create_dir_all(&outside).unwrap();
        let save = outside.join("body.sav");
        fs::write(&save, b"external save").unwrap();
        check(&command).unwrap();
        command.env("HOME", library.root());
        assert!(check(&command).is_err());
        for value in [OsStr::new(""), OsStr::new("relative"), outside.as_os_str()] {
            assert!(require_no_profile_override(Platform::LinuxX86_64, Some(value)).is_err());
            require_no_profile_override(Platform::WindowsX86_64, Some(value)).unwrap();
        }
        command.env("HOME", "relative");
        assert!(check(&command).is_err());
        assert_eq!(fs::read(save).unwrap(), b"external save");
    }

    #[test]
    fn recomp_direct_requires_an_amd64_elf() {
        let temporary = tempfile::tempdir().unwrap();
        let player = temporary.path().join(PLAYER);
        let mut bytes = [0; 20];
        bytes[..6].copy_from_slice(b"\x7fELF\x02\x01");
        bytes[16..20].copy_from_slice(&[3, 0, 0x3e, 0]);
        fs::write(&player, bytes).unwrap();
        require_linux_player(&player).unwrap();
        bytes[18] = 0xb7;
        fs::write(&player, bytes).unwrap();
        assert!(require_linux_player(&player).is_err());
    }

    #[test]
    fn recomp_direct_retained_windows_applies_only_to_the_same_ordinary_player() {
        let catalog = crate::Catalog::embedded().unwrap();
        let current = catalog.port("body-harvest-recompiled").unwrap();
        let mut retained = current.clone();
        retained.external_profile_policy = None;
        retained.platforms = vec![Platform::WindowsX86_64];
        retained
            .release
            .asset_hints
            .retain(|p, _| *p == Platform::WindowsX86_64);
        retained
            .executable_hints
            .retain(|p, _| *p == Platform::WindowsX86_64);
        retained.reviewed_package_layouts.clear();
        assert_eq!(
            super::super::launch_policy(&retained, Some(current)),
            Some(crate::ExternalProfilePolicy::RecompDirectV1)
        );
        retained.portable_marker = true;
        assert_eq!(super::super::launch_policy(&retained, Some(current)), None);
    }
}
