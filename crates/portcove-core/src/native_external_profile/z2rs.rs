//! The direct z2rs player and its default desktop data locations.
use std::{
    fs,
    io::{ErrorKind, Read},
    path::{Path, PathBuf},
    process::Command,
};

use crate::{
    ExternalProfilePolicy, Platform, PortDefinition, PortcoveError, ReleaseChannel, Result,
    definition_entry::strict_json::UniqueValue,
};

use super::{environment, require_absolute};

pub(crate) const NATIVE_CAPABILITY: u32 = 20;
pub(super) const FALLBACK_ROOT: &str = ".z2rs-data";
const MAC_PLAYER: &str = "z2rs.app/Contents/MacOS/z2rs";
const MAXIMUM_CONFIG_BYTES: u64 = 64 * 1024;

pub(super) fn validate(port: &PortDefinition) -> Result<()> {
    let valid_route = |platform| {
        let (asset_suffix, player) = match platform {
            Platform::WindowsX86_64 => ("-x86_64-pc-windows-msvc.zip", "z2rs.exe"),
            Platform::LinuxX86_64 => ("-x86_64-unknown-linux-gnu.tar.gz", "z2rs"),
            Platform::MacosX86_64 => ("-x86_64-apple-darwin.zip", MAC_PLAYER),
            Platform::MacosAarch64 => ("-aarch64-apple-darwin.zip", MAC_PLAYER),
        };
        port.release
            .asset_hints
            .get(&platform)
            .is_some_and(|hints| hints == &["z2rs-", asset_suffix])
            && port
                .executable_hints
                .get(&platform)
                .is_some_and(|hints| hints == &[player])
            && (platform == Platform::WindowsX86_64
                || port.reviewed_package_layouts.contains_key(&platform))
    };
    if port.channels != [ReleaseChannel::Stable]
        || port.source_profile.is_some()
        || port.persistent_paths != [FALLBACK_ROOT]
        || !port.release.direct.is_empty()
        || !port.release.curated.is_empty()
        || !port.release.managed_build.is_empty()
        || !port.release.user_prepared.is_empty()
        || !port.platforms.iter().copied().all(valid_route)
    {
        return Err(PortcoveError::verification(
            "z2rs requires the official direct player, package layout and default profile",
        ));
    }
    Ok(())
}

pub(super) fn external_root(platform: Platform, command: &Command) -> Result<Option<PathBuf>> {
    // Upstream uses std::env::var and skips non-Unicode and empty values.
    let variable = |name| {
        environment(command, name).filter(|value| value.to_str().is_some_and(|s| !s.is_empty()))
    };
    let home_path = match platform {
        Platform::MacosX86_64 | Platform::MacosAarch64 => "Library/Application Support/z2rs",
        _ => ".local/share/z2rs",
    };
    if let Some(value) = variable("XDG_DATA_HOME") {
        return Ok(Some(
            require_absolute(Some(&value), "XDG_DATA_HOME")?.join("z2rs"),
        ));
    }
    if platform == Platform::WindowsX86_64
        && let Some(value) = variable("APPDATA")
    {
        return Ok(Some(
            require_absolute(Some(&value), "APPDATA")?.join("z2rs"),
        ));
    }
    if let Some(value) = variable("HOME") {
        return Ok(Some(
            require_absolute(Some(&value), "HOME")?.join(home_path),
        ));
    }
    if matches!(platform, Platform::MacosX86_64 | Platform::MacosAarch64) {
        return Err(PortcoveError::launch(
            "z2rs needs a personal profile outside the Mac application bundle. Use an absolute HOME or XDG_DATA_HOME, or a separately prepared copy.",
        ));
    }
    Ok(None)
}

pub(crate) fn owns_fallback(port: &PortDefinition, platform: Platform) -> bool {
    matches!(platform, Platform::WindowsX86_64 | Platform::LinuxX86_64)
        && port.platforms.contains(&platform)
        && (port.external_profile_policy == Some(ExternalProfilePolicy::Z2rsDesktopV1)
            || (port.external_profile_policy.is_none()
                && port.platforms == [Platform::WindowsX86_64]))
        && super::validate_layout(port, ExternalProfilePolicy::Z2rsDesktopV1).is_ok()
}

pub(super) fn require_default_config(
    root: &Path,
    checkpoint: &impl Fn() -> Result<()>,
) -> Result<()> {
    let config = root.join("z2-native.json");
    match fs::symlink_metadata(&config) {
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
        Ok(_) => {}
    }
    let mut bytes = Vec::new();
    crate::external_runtime::stream_single_link_metadata(
        &config,
        MAXIMUM_CONFIG_BYTES,
        checkpoint,
        &mut |chunk| {
            bytes.extend_from_slice(chunk);
            Ok(())
        },
    )?;
    let value: UniqueValue = serde_json::from_slice(&bytes).map_err(|_| {
        PortcoveError::launch(
            "The z2rs settings could not be checked. Preserve them and use a separately prepared copy.",
        )
    })?;
    if !value.0.as_object().is_some_and(|config| {
        config
            .get("data_dir_override")
            .is_none_or(serde_json::Value::is_null)
    }) {
        return Err(PortcoveError::launch(
            "z2rs uses a custom data directory. Preserve your files and use a separately prepared copy for this profile.",
        ));
    }
    Ok(())
}

pub(crate) fn require_unix_player(executable: &Path, platform: Platform) -> Result<()> {
    if platform == Platform::LinuxX86_64 {
        return super::read_amd64_elf_header(executable).map(|_| ());
    }
    let cpu = match platform {
        Platform::MacosX86_64 => [7, 0, 0, 1],
        Platform::MacosAarch64 => [12, 0, 0, 1],
        _ => return Ok(()),
    };
    let mut header = [0; 16];
    crate::external_runtime::open_single_link_file(executable)?.read_exact(&mut header)?;
    if header[..4] != [0xcf, 0xfa, 0xed, 0xfe]
        || header[4..8] != cpu
        || header[12..16] != [2, 0, 0, 0]
    {
        return Err(PortcoveError::verification(
            "z2rs archive does not contain the reviewed Mac player architecture",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn z2rs_profile_precedence_matches_desktop_players() {
        let temporary = tempfile::tempdir().unwrap();
        let home = temporary.path().join("home");
        let appdata = temporary.path().join("appdata");
        let data = temporary.path().join("data");
        let mut command = Command::new("inert-player");
        command
            .env_clear()
            .env("HOME", &home)
            .env("APPDATA", &appdata);
        assert_eq!(
            external_root(Platform::WindowsX86_64, &command).unwrap(),
            Some(appdata.join("z2rs"))
        );
        assert_eq!(
            external_root(Platform::LinuxX86_64, &command).unwrap(),
            Some(home.join(".local/share/z2rs"))
        );
        assert_eq!(
            external_root(Platform::MacosAarch64, &command).unwrap(),
            Some(home.join("Library/Application Support/z2rs"))
        );
        command.env("HOME", "relative").env("XDG_DATA_HOME", &data);
        assert_eq!(
            external_root(Platform::MacosX86_64, &command).unwrap(),
            Some(data.join("z2rs"))
        );
        command.env("XDG_DATA_HOME", "relative");
        assert!(external_root(Platform::WindowsX86_64, &command).is_err());
        command.env("XDG_DATA_HOME", "").env_remove("APPDATA");
        assert!(external_root(Platform::LinuxX86_64, &command).is_err());
        command.env_remove("HOME");
        assert_eq!(
            external_root(Platform::LinuxX86_64, &command).unwrap(),
            None
        );
        assert!(external_root(Platform::MacosAarch64, &command).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn z2rs_non_unicode_environment_values_follow_upstream_fallback() {
        use std::{ffi::OsString, os::unix::ffi::OsStringExt};
        let temporary = tempfile::tempdir().unwrap();
        let home = temporary.path().join("home");
        let non_unicode = OsString::from_vec(vec![b'/', 0xff]);
        let mut command = Command::new("inert-player");
        command
            .env_clear()
            .env("HOME", &home)
            .env("XDG_DATA_HOME", &non_unicode);
        assert_eq!(
            external_root(Platform::MacosAarch64, &command).unwrap(),
            Some(home.join("Library/Application Support/z2rs"))
        );
        command.env("HOME", non_unicode);
        assert!(external_root(Platform::MacosAarch64, &command).is_err());
        assert_eq!(
            external_root(Platform::LinuxX86_64, &command).unwrap(),
            None
        );
    }

    #[test]
    fn z2rs_retained_windows_launch_keeps_its_creating_definition() {
        let catalog = crate::Catalog::embedded().unwrap();
        let current = catalog.port("troyedwardsjr-z2rs").unwrap();
        let windows = Platform::WindowsX86_64;
        let mut retained = current.clone();
        retained.platforms = vec![windows];
        retained.external_profile_policy = None;
        retained.executable_hints.retain(|&key, _| key == windows);
        retained
            .release
            .asset_hints
            .retain(|&key, _| key == windows);
        retained.reviewed_package_layouts.clear();
        assert_eq!(
            super::super::launch_policy(&retained, Some(current)),
            current.external_profile_policy
        );
        assert!(retained.external_profile_policy.is_none());
        assert!(owns_fallback(&retained, windows));
        assert!(!owns_fallback(current, Platform::MacosAarch64));
        retained
            .executable_hints
            .insert(windows, vec!["z2rs-launcher.exe".into()]);
        assert_eq!(super::super::launch_policy(&retained, Some(current)), None);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn z2rs_launch_guard_preserves_default_and_custom_profile_bytes() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let library = crate::Library::open(root.join("library")).unwrap();
        let runtime = library.versions_dir().join("engine");
        fs::create_dir_all(&runtime).unwrap();
        let data = root.join("data");
        let external = data.join("z2rs");
        fs::create_dir_all(&external).unwrap();
        let config = external.join("z2-native.json");
        fs::write(&config, br#"{"data_dir_override":null}"#).unwrap();
        let save = external.join("savestate1.z2snap");
        fs::write(&save, b"external save").unwrap();
        let spec = crate::LaunchSpec {
            executable: runtime.join("z2rs"),
            install_root: runtime.clone(),
            working_directory: runtime.clone(),
            environment: Default::default(),
            arguments: Vec::new(),
            fixed_arguments_only: true,
            launch_kind: crate::LaunchKind::Native,
        };
        let mut command = Command::new("inert-player");
        command.env_clear().env("XDG_DATA_HOME", &data);
        let check = |command: &Command| {
            super::super::require_external_roots(
                crate::ExternalProfilePolicy::Z2rsDesktopV1,
                &library,
                &spec,
                command,
                &|| Ok(()),
            )
        };
        check(&command).unwrap();
        for contents in [
            br#"{"data_dir_override":"relative"}"#.as_slice(),
            br#"{"data_dir_override":""}"#.as_slice(),
            br#"{"data_dir_override":"/external"}"#.as_slice(),
            br#"{"data_dir_override":null,"data_dir_override":"relative"}"#.as_slice(),
        ] {
            fs::write(&config, contents).unwrap();
            assert!(check(&command).is_err());
            assert_eq!(fs::read(&config).unwrap(), contents);
        }
        command.env("XDG_DATA_HOME", library.root());
        assert!(check(&command).is_err());
        command.env_remove("XDG_DATA_HOME");
        let fallback = runtime.join(FALLBACK_ROOT);
        fs::create_dir(&fallback).unwrap();
        fs::write(fallback.join("savestate1.z2snap"), b"owned save").unwrap();
        check(&command).unwrap();
        assert_eq!(
            fs::read(fallback.join("savestate1.z2snap")).unwrap(),
            b"owned save"
        );
        assert_eq!(fs::read(save).unwrap(), b"external save");
    }

    #[cfg(unix)]
    #[test]
    fn z2rs_mac_selects_the_bundle_player_under_one_version_wrapper() {
        let catalog = crate::Catalog::embedded().unwrap();
        let port = catalog.port("troyedwardsjr-z2rs").unwrap();
        for (platform, cpu) in [
            (Platform::MacosX86_64, [7, 0, 0, 1]),
            (Platform::MacosAarch64, [12, 0, 0, 1]),
        ] {
            let temporary = tempfile::tempdir().unwrap();
            let root = temporary.path().canonicalize().unwrap();
            let wrapper = root.join("z2rs-0.6.1-mac");
            let bundle = wrapper.join(MAC_PLAYER);
            fs::create_dir_all(bundle.parent().unwrap()).unwrap();
            let mut header = [0_u8; 16];
            header[..4].copy_from_slice(&[0xcf, 0xfa, 0xed, 0xfe]);
            header[4..8].copy_from_slice(&cpu);
            header[12] = 2;
            for path in [&bundle, &wrapper.join("z2rs")] {
                fs::write(path, header).unwrap();
                crate::permissions::normalize_archive_entry(path, false, true).unwrap();
            }
            let qualification = crate::InstallQualification::from_port(port, platform).unwrap();
            let resolve = || crate::install::resolve_declared_executable(&root, &qualification);
            assert_eq!(resolve().unwrap(), bundle);
            fs::write(&bundle, [0; 16]).unwrap();
            assert!(resolve().is_err());
            fs::write(&bundle, header).unwrap();
            let duplicate = root.join(MAC_PLAYER);
            fs::create_dir_all(duplicate.parent().unwrap()).unwrap();
            fs::write(&duplicate, header).unwrap();
            assert!(resolve().unwrap_err().message.contains("ambiguous"));
        }
    }
}
