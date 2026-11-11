//! Official non-portable OpenJK and OpenJO campaign players.
use std::{
    io::Read,
    path::{Path, PathBuf},
    process::Command,
};

use crate::{LaunchSpec, Platform, PortDefinition, PortcoveError, ReleaseChannel, Result};

pub(crate) const NATIVE_CAPABILITY: u32 = 24;
const ACADEMY: &str =
    "star-wars-jedi-knight-jedi-academy-single-player-and-multiplayer-openjk-openjo";
const OUTCAST: &str = "star-wars-jedi-knight-ii-jedi-outcast-single-player-openjk-openjo";

pub(crate) fn applies_to(platform: Platform) -> bool {
    matches!(
        platform,
        Platform::LinuxX86_64 | Platform::MacosX86_64 | Platform::MacosAarch64
    )
}

fn invalid_layout() -> PortcoveError {
    PortcoveError::verification(
        "OpenJK and OpenJO require the reviewed campaign player and module layout",
    )
}

pub(super) fn validate(port: &PortDefinition) -> Result<()> {
    let (package, player, persistent): (&str, &str, &[_]) = match port.id.as_str() {
        ACADEMY => (
            "OpenJK",
            "openjk_sp",
            &[
                "base/assets0.pk3",
                "base/assets1.pk3",
                "base/assets2.pk3",
                "base/assets3.pk3",
            ],
        ),
        OUTCAST => ("OpenJO", "openjo_sp", &["base"]),
        _ => return Err(invalid_layout()),
    };
    let routes = port
        .platforms
        .iter()
        .copied()
        .filter(|&platform| applies_to(platform));
    if !port
        .release
        .repository
        .eq_ignore_ascii_case("JACoders/OpenJK")
        || port.channels != [ReleaseChannel::Rolling]
        || port.release.rolling_tag.as_deref() != Some("latest")
        || port.persistent_paths != persistent
        || port.source_profile.is_some()
        || !port.release.direct.is_empty()
        || !port.release.curated.is_empty()
        || !port.release.managed_build.is_empty()
        || !port.release.user_prepared.is_empty()
        || routes.clone().next().is_none()
    {
        return Err(invalid_layout());
    }
    for platform in routes {
        let (asset, executable) = match platform {
            Platform::LinuxX86_64 => (
                format!("{package}-linux-x86_64.tar.gz"),
                format!("{player}.x86_64"),
            ),
            Platform::MacosX86_64 | Platform::MacosAarch64 if port.id == OUTCAST => {
                let arch = if platform == Platform::MacosAarch64 {
                    "arm64"
                } else {
                    "x86_64"
                };
                (
                    format!("{package}-macos-{arch}.tar.gz"),
                    format!("{player}.{arch}.app/Contents/MacOS/{player}.{arch}"),
                )
            }
            _ => return Err(invalid_layout()),
        };
        if port
            .release
            .asset_hints
            .get(&platform)
            .is_none_or(|hints| hints != &[asset])
            || port
                .executable_hints
                .get(&platform)
                .is_none_or(|hints| hints != &[executable])
            || !port.reviewed_package_layouts.contains_key(&platform)
        {
            return Err(invalid_layout());
        }
    }
    Ok(())
}

fn player(executable: &Path) -> Result<bool> {
    match executable.file_name().and_then(|name| name.to_str()) {
        Some("openjk_sp.x86_64") => Ok(false),
        Some("openjo_sp.x86_64" | "openjo_sp.arm64") => Ok(true),
        _ => Err(invalid_layout()),
    }
}

pub(crate) fn require_payload(executable: &Path, platform: Platform) -> Result<()> {
    let outcast = player(executable)?;
    let parent = executable.parent().ok_or_else(invalid_layout)?;
    let (game, renderer) = if outcast {
        ("jospgame", "rdjosp-vanilla")
    } else {
        ("jagame", "rdsp-vanilla")
    };
    if platform == Platform::LinuxX86_64 {
        super::read_amd64_elf_header(executable)?;
        for relative in [
            format!("OpenJK/{game}x86_64.so"),
            format!("{renderer}_x86_64.so"),
        ] {
            let path = parent.join(relative);
            crate::install::refuse_symlink_path_within(parent, &path, "OpenJK module")?;
            if super::read_amd64_elf_header(&path)?[16..18] != [3, 0] {
                return Err(invalid_layout());
            }
        }
    } else {
        let (arch, cpu) = match platform {
            Platform::MacosX86_64 => ("x86_64", 0x0100_0007_u32),
            Platform::MacosAarch64 => ("arm64", 0x0100_000c),
            _ => return Err(invalid_layout()),
        };
        let contents = parent.parent().ok_or_else(invalid_layout)?;
        for (path, kind) in [
            (executable.to_path_buf(), 2_u32),
            (parent.join(format!("OpenJK/{game}{arch}.dylib")), 6),
            (parent.join(format!("{renderer}_{arch}.dylib")), 6),
            (contents.join("Frameworks/libSDL2-2.0.0.dylib"), 6),
        ] {
            crate::install::refuse_symlink_path_within(contents, &path, "OpenJO bundle member")?;
            let mut header = [0; 16];
            crate::external_runtime::open_single_link_file(&path)?.read_exact(&mut header)?;
            if header[..4] != [0xcf, 0xfa, 0xed, 0xfe]
                || header[4..8] != cpu.to_le_bytes()
                || header[12..] != kind.to_le_bytes()
            {
                return Err(invalid_layout());
            }
        }
    }
    Ok(())
}

pub(crate) fn requires_archive(port: &PortDefinition, platform: Platform) -> bool {
    port.external_profile_policy == Some(crate::ExternalProfilePolicy::OpenjkUnixV1)
        && applies_to(platform)
}

pub(crate) fn matches_asset(port: &PortDefinition, platform: Platform, asset: &str) -> bool {
    !requires_archive(port, platform)
        || port
            .release
            .asset_hints
            .get(&platform)
            .is_some_and(|hints| hints == &[asset])
}

pub(super) fn profile_root(
    spec: &LaunchSpec,
    command: &Command,
    platform: Platform,
) -> Result<PathBuf> {
    require_payload(&spec.executable, platform)?;
    require_default_loader_path(command, platform)?;
    effective_root(command, platform, player(&spec.executable)?)
}

fn require_default_loader_path(command: &Command, platform: Platform) -> Result<()> {
    let library_path = if platform == Platform::LinuxX86_64 {
        "LD_LIBRARY_PATH"
    } else {
        "DYLD_LIBRARY_PATH"
    };
    if super::environment(command, library_path).is_some_and(|value| !value.is_empty()) {
        return Err(PortcoveError::launch(format!(
            "{library_path} changes where the game loads libraries. Use the default loader paths or a separately prepared copy."
        )));
    }
    Ok(())
}

fn effective_root(command: &Command, platform: Platform, outcast: bool) -> Result<PathBuf> {
    let home = || super::require_absolute(super::environment(command, "HOME").as_deref(), "HOME");
    let root = if platform == Platform::LinuxX86_64 {
        let data = match super::environment(command, "XDG_DATA_HOME") {
            Some(value) => super::require_absolute(Some(&value), "XDG_DATA_HOME")?,
            None => home()?.join(".local/share"),
        };
        data.join(if outcast { "openjo" } else { "openjk" })
    } else {
        home()?.join("Library/Application Support/OpenJO")
    };
    // The engine also uses this root in file buffers with a fallback size of
    // 256 bytes. Reserve a separator and its maximum 64-byte relative path.
    let bytes = root.as_os_str().as_encoded_bytes();
    // FS_CreatePath treats backslashes as separators and refuses any ".." or
    // "::" in its destination, even where the host would accept those names.
    if bytes.contains(&b'\\') || bytes.windows(2).any(|part| matches!(part, b".." | b"::")) {
        return Err(PortcoveError::launch(
            "The OpenJK or OpenJO profile uses an unsupported path. Use a personal profile location without backslashes, double periods or double colons.",
        ));
    }
    if bytes.len() >= 256 - 65 {
        return Err(PortcoveError::launch(
            "The OpenJK or OpenJO profile path is too long. Use a shorter personal profile location.",
        ));
    }
    Ok(root)
}

pub(super) fn refuse_alternate_module(path: &Path) -> Result<()> {
    let name = path.file_name().unwrap_or_default().as_encoded_bytes();
    if [b".so".as_slice(), b".dylib"].iter().any(|suffix| {
        name.len() >= suffix.len() && name[name.len() - suffix.len()..].eq_ignore_ascii_case(suffix)
    }) {
        return Err(PortcoveError::launch(
            "OpenJK or OpenJO could load a native module from your external profile. Preserve that profile and use a separately prepared copy for it.",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ChildProcessClass, ChildProcessPolicy};

    #[test]
    fn unix_profiles_exclude_windows_originals_from_managed_persistence() {
        let catalog = crate::Catalog::embedded().unwrap();
        for id in [ACADEMY, OUTCAST] {
            let port = catalog.port(id).unwrap();
            assert!(!port.persistent_paths.is_empty());
            assert_eq!(
                crate::persistence::declared_paths(port, Platform::WindowsX86_64),
                port.persistent_paths
            );
            #[cfg(unix)]
            assert!(
                crate::persistence::local_declared_paths(port)
                    .unwrap()
                    .is_empty()
            );
            for platform in port
                .platforms
                .iter()
                .copied()
                .filter(|&platform| applies_to(platform))
            {
                assert!(crate::persistence::declared_paths(port, platform).is_empty());
            }
        }
    }

    #[test]
    fn linux_payload_requires_the_game_module_and_renderer_for_the_selected_player() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        std::fs::create_dir(root.join("OpenJK")).unwrap();
        let player = root.join("openjo_sp.x86_64");
        let renderer = root.join("rdjosp-vanilla_x86_64.so");
        let game = root.join("OpenJK/jospgamex86_64.so");
        let mut header = [0; 20];
        header[..6].copy_from_slice(b"\x7fELF\x02\x01");
        header[16..20].copy_from_slice(&[3, 0, 0x3e, 0]);
        for path in [&player, &renderer] {
            std::fs::write(path, header).unwrap();
        }
        assert!(require_payload(&player, Platform::LinuxX86_64).is_err());
        std::fs::write(&game, header).unwrap();
        require_payload(&player, Platform::LinuxX86_64).unwrap();
        header[18] = 0xb7;
        std::fs::write(&game, header).unwrap();
        assert!(require_payload(&player, Platform::LinuxX86_64).is_err());
        assert!(refuse_alternate_module(Path::new("base/JOSPGAME.dylib")).is_err());
        assert!(refuse_alternate_module(Path::new("base/assets0.pk3")).is_ok());
    }

    #[test]
    fn explicit_loader_path_overrides_hold_the_affected_route() {
        let mut command =
            ChildProcessPolicy::native_command(ChildProcessClass::Game, "inert").unwrap();
        command.env_clear().env("LD_LIBRARY_PATH", "alternate");
        assert!(require_default_loader_path(&command, Platform::LinuxX86_64).is_err());
        assert!(require_default_loader_path(&command, Platform::MacosX86_64).is_ok());
        command
            .env_remove("LD_LIBRARY_PATH")
            .env("DYLD_LIBRARY_PATH", "alternate");
        assert!(require_default_loader_path(&command, Platform::LinuxX86_64).is_ok());
        assert!(require_default_loader_path(&command, Platform::MacosAarch64).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn external_root_uses_the_environment_that_the_campaign_receives() {
        let home = Path::new("/personal");
        let mut command =
            ChildProcessPolicy::native_command(ChildProcessClass::Game, "inert").unwrap();
        command.env_clear().env("HOME", home);
        assert_eq!(
            effective_root(&command, Platform::LinuxX86_64, false).unwrap(),
            home.join(".local/share/openjk")
        );
        let alternate = home.join("alternate");
        command.env("XDG_DATA_HOME", &alternate);
        assert_eq!(
            effective_root(&command, Platform::LinuxX86_64, true).unwrap(),
            alternate.join("openjo")
        );
        for invalid in [
            "",
            "relative",
            "/back\\slash",
            "/double..period",
            "/double::colon",
        ] {
            command.env("XDG_DATA_HOME", invalid);
            assert!(effective_root(&command, Platform::LinuxX86_64, true).is_err());
        }
        assert_eq!(
            effective_root(&command, Platform::MacosAarch64, true).unwrap(),
            home.join("Library/Application Support/OpenJO")
        );
        command.env_remove("HOME");
        assert!(effective_root(&command, Platform::MacosAarch64, true).is_err());
    }
}
