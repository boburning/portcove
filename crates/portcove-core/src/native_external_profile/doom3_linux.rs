//! Direct Doom 3 Linux packages and their external id Tech 4 profiles.
use std::{
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
    process::Command,
};

use crate::{LaunchSpec, Platform, PortDefinition, PortcoveError, ReleaseChannel, Result};

pub(crate) const NATIVE_CAPABILITY: u32 = 23;
pub(crate) const LAUNCH_ARGUMENTS: [&str; 6] =
    ["+set", "fs_basepath", ".", "+set", "fs_gameDllPath", "."];
const SYSTEM_MODULES: &str = "/usr/local/lib/dhewm3";
// This also fits the larger startup command buffer. BuildOSPath uses
// 1024 bytes, so leave 256 for game-relative coordinates and one for NUL.
const MAX_PROFILE_ROOT_BYTES: usize = 1024 - 256 - 1;

pub(super) fn validate(port: &PortDefinition) -> Result<()> {
    let (repository, player, prefix, suffix, expansion) = match port.id.as_str() {
        "doom-3-classic-dhewm3" => (
            "dhewm/dhewm3",
            "dhewm3",
            "dhewm3-1.",
            "_Linux_amd64.tar.gz",
            false,
        ),
        "doom-3-resurrection-of-evil-classic-dhewm3" => (
            "dhewm/dhewm3",
            "dhewm3",
            "dhewm3-1.",
            "_Linux_amd64.tar.gz",
            true,
        ),
        "doom-3-classic-dude-doom-3-unified-development-engine" => (
            "Inkub0/dude",
            "dude",
            "dude-0.9.",
            "-linux-x86_64.tar.gz",
            false,
        ),
        "doom-3-resurrection-of-evil-classic-dude-doom-3-unified-development-engine" => (
            "Inkub0/dude",
            "dude",
            "dude-0.9.",
            "-linux-x86_64.tar.gz",
            true,
        ),
        _ => return Err(invalid_layout()),
    };
    let arguments: &[_] = if expansion {
        &["+set", "fs_game", "d3xp"]
    } else {
        &[]
    };
    let mut originals = (0..=8)
        .map(|index| format!("base/pak{index:03}.pk4"))
        .collect::<Vec<_>>();
    if expansion {
        originals.extend(["d3xp/pak000.pk4".into(), "d3xp/pak001.pk4".into()]);
    }
    let linux = Platform::LinuxX86_64;
    if !port.release.repository.eq_ignore_ascii_case(repository)
        || port.channels != [ReleaseChannel::Stable]
        || !port.platforms.contains(&linux)
        || port
            .release
            .asset_hints
            .get(&linux)
            .is_none_or(|hints| hints != &[prefix, suffix])
        || port
            .executable_hints
            .get(&linux)
            .is_none_or(|hints| hints != &[player])
        || !port.reviewed_package_layouts.contains_key(&linux)
        || port.launch_arguments != arguments
        || port.persistent_paths != originals
        || port.source_profile.is_some()
        || !port.release.direct.is_empty()
        || !port.release.curated.is_empty()
        || !port.release.managed_build.is_empty()
        || !port.release.user_prepared.is_empty()
    {
        return Err(invalid_layout());
    }
    Ok(())
}

fn invalid_layout() -> PortcoveError {
    PortcoveError::verification(
        "Doom 3 Linux requires the reviewed direct player, originals and module layout",
    )
}

fn player(executable: &Path) -> Result<&'static str> {
    match executable.file_name().and_then(|name| name.to_str()) {
        Some("dhewm3") => Ok("dhewm3"),
        Some("dude") => Ok("dude"),
        _ => Err(invalid_layout()),
    }
}

pub(crate) fn require_payload(executable: &Path) -> Result<()> {
    let modules: &[_] = match player(executable)? {
        "dude" => &["base.so", "d3xp.so", "d3le.so", "lib/libvulkan.so.1"],
        _ => &["base.so", "d3xp.so"],
    };
    super::read_amd64_elf_header(executable)?;
    let parent = executable.parent().ok_or_else(invalid_layout)?;
    for module in modules {
        let path = parent.join(module);
        crate::install::refuse_symlink_path_within(parent, &path, "Doom 3 module")?;
        let header = super::read_amd64_elf_header(&path)?;
        if header[16..18] != [3, 0] {
            return Err(invalid_layout());
        }
    }
    Ok(())
}

pub(super) fn profile_roots(
    spec: &LaunchSpec,
    command: &Command,
    checkpoint: &impl Fn() -> Result<()>,
) -> Result<Vec<PathBuf>> {
    let player = player(&spec.executable)?;
    if super::environment(command, "LD_LIBRARY_PATH").is_some_and(|value| !value.is_empty()) {
        return Err(PortcoveError::launch(
            "Doom 3 found a custom library search path. Use a separately prepared copy for that setup.",
        ));
    }
    if spec.executable.parent() != Some(spec.working_directory.as_path()) {
        return Err(PortcoveError::launch(
            "Doom 3 needs the complete runtime as its working directory.",
        ));
    }
    let [config, saves] = effective_profile_paths(command, player)?;
    if player == "dude" {
        require_no_legacy_copy(&config)?;
    }
    crate::external_runtime::shared_preferences::check_bounded_tree(
        Path::new(SYSTEM_MODULES),
        "system Doom 3 modules",
        |path, _| {
            checkpoint()?;
            refuse_alternate_module(path)
        },
    )?;
    Ok(vec![config, saves])
}

pub(crate) fn pin_profile_paths(executable: &Path, command: &mut Command) -> Result<()> {
    // Use the same child environment checked by the profile guard. DUDE
    // otherwise chooses a runtime-local save path when its external folder
    // does not exist.
    let [config, saves] = effective_profile_paths(command, player(executable)?)?;
    command
        .args(["+set", "fs_configpath"])
        .arg(config)
        .args(["+set", "fs_savepath"])
        .arg(saves);
    Ok(())
}

fn effective_profile_paths(command: &Command, player: &str) -> Result<[PathBuf; 2]> {
    Ok([
        profile_root(command, "XDG_CONFIG_HOME", ".config", player)?,
        profile_root(command, "XDG_DATA_HOME", ".local/share", player)?,
    ])
}

fn profile_root(
    command: &Command,
    variable: &str,
    fallback: &str,
    player: &str,
) -> Result<PathBuf> {
    use super::{environment, require_absolute};
    let base = match environment(command, variable) {
        Some(value) => require_absolute(Some(&value), variable)?,
        None => require_absolute(environment(command, "HOME").as_deref(), "HOME")?.join(fallback),
    };
    let root = base.join(player);
    let encoded = root.as_os_str().as_encoded_bytes();
    if encoded.len() > MAX_PROFILE_ROOT_BYTES || encoded.contains(&b'\\') {
        return Err(PortcoveError::launch(
            "Doom 3 needs a shorter profile path with Linux separators. Preserve the existing data or use a separately prepared copy.",
        ));
    }
    Ok(root)
}

fn require_no_legacy_copy(config: &Path) -> Result<()> {
    match fs::symlink_metadata(config) {
        Ok(metadata) if metadata.is_dir() => return Ok(()),
        Ok(_) => {
            return Err(PortcoveError::launch(
                "Use a separately prepared copy for this DUDE profile.",
            ));
        }
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    match fs::symlink_metadata(config.with_file_name("dhewm3")) {
        Ok(_) => Err(PortcoveError::launch(
            "DUDE would copy a legacy dhewm3 profile on first Play. Preserve both profiles and use a separately prepared copy for that migration.",
        )),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

pub(super) fn refuse_alternate_module(path: &Path) -> Result<()> {
    let name = path.file_name().unwrap_or_default().as_encoded_bytes();
    if name.ends_with(b".so") || name.windows(4).any(|window| window == b".so.") {
        return Err(PortcoveError::launch(
            "Doom 3 found another native module outside its managed runtime. Preserve it and use a separately prepared copy for that setup.",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use crate::{ChildProcessClass, ChildProcessPolicy};

    #[cfg(unix)]
    #[test]
    fn doom3_linux_rejects_relative_empty_and_truncated_profile_roots() {
        let directory = tempfile::tempdir().unwrap();
        let home = directory.path().canonicalize().unwrap();
        let mut command =
            ChildProcessPolicy::native_command(ChildProcessClass::Game, "inert-player").unwrap();
        command.env_clear().env("HOME", &home);
        assert_eq!(
            profile_root(&command, "XDG_DATA_HOME", ".local/share", "dhewm3").unwrap(),
            home.join(".local/share/dhewm3")
        );
        let config = home.join("custom");
        command.env("XDG_CONFIG_HOME", &config);
        assert_eq!(
            profile_root(&command, "XDG_CONFIG_HOME", ".config", "dude").unwrap(),
            config.join("dude")
        );
        let maximum = format!("/{}", "x".repeat(MAX_PROFILE_ROOT_BYTES - 6));
        command.env("XDG_CONFIG_HOME", &maximum);
        let root = profile_root(&command, "XDG_CONFIG_HOME", ".config", "dude").unwrap();
        assert_eq!(
            root.as_os_str().as_encoded_bytes().len(),
            MAX_PROFILE_ROOT_BYTES
        );
        for invalid in ["", "relative", "/with\\backslash", &format!("{maximum}x")] {
            command.env("XDG_CONFIG_HOME", invalid);
            assert!(profile_root(&command, "XDG_CONFIG_HOME", ".config", "dude").is_err());
        }
    }

    #[cfg(unix)]
    #[test]
    fn doom3_linux_pins_fresh_du_de_paths_before_the_player_can_choose_a_runtime_fallback() {
        use std::ffi::OsStr;

        let directory = tempfile::tempdir().unwrap();
        let home = directory.path().canonicalize().unwrap();
        let mut command =
            ChildProcessPolicy::native_command(ChildProcessClass::Game, "inert-player").unwrap();
        command.env_clear().env("HOME", &home);
        pin_profile_paths(Path::new("dude"), &mut command).unwrap();
        let config = home.join(".config/dude");
        let saves = home.join(".local/share/dude");
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            [
                OsStr::new("+set"),
                OsStr::new("fs_configpath"),
                config.as_os_str(),
                OsStr::new("+set"),
                OsStr::new("fs_savepath"),
                saves.as_os_str(),
            ]
        );
        assert!(!config.exists());
        assert!(!saves.exists());
    }

    #[test]
    fn doom3_linux_holds_legacy_du_de_copy_without_touching_either_profile() {
        let directory = tempfile::tempdir().unwrap();
        let legacy = directory.path().join("dhewm3");
        let current = directory.path().join("dude");
        require_no_legacy_copy(&current).unwrap();
        fs::create_dir(&legacy).unwrap();
        let save = legacy.join("profile.cfg");
        fs::write(&save, b"legacy settings").unwrap();
        assert!(require_no_legacy_copy(&current).is_err());
        assert!(!current.exists());
        fs::create_dir(&current).unwrap();
        require_no_legacy_copy(&current).unwrap();
        assert_eq!(fs::read(save).unwrap(), b"legacy settings");
        assert!(refuse_alternate_module(&current.join("base.so")).is_err());
        assert!(refuse_alternate_module(&current.join("libgame.so.1")).is_err());
        refuse_alternate_module(&current.join("profile.cfg")).unwrap();
    }

    #[test]
    fn doom3_linux_requires_exact_amd64_program_and_shared_modules() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let mut elf = [0; 20];
        elf[..6].copy_from_slice(b"\x7fELF\x02\x01");
        elf[16..20].copy_from_slice(&[3, 0, 0x3e, 0]);
        fs::create_dir(root.join("lib")).unwrap();
        for member in [
            "dude",
            "base.so",
            "d3xp.so",
            "d3le.so",
            "lib/libvulkan.so.1",
        ] {
            fs::write(root.join(member), elf).unwrap();
        }
        let executable = root.join("dude");
        require_payload(&executable).unwrap();
        elf[16] = 2;
        fs::write(root.join("base.so"), elf).unwrap();
        assert!(require_payload(&executable).is_err());
    }

    #[test]
    fn doom3_linux_contract_preserves_originals_and_windows_role() {
        let catalog = crate::Catalog::embedded().unwrap();
        for (id, expansion) in [
            ("doom-3-classic-dhewm3", false),
            ("doom-3-resurrection-of-evil-classic-dhewm3", true),
            (
                "doom-3-classic-dude-doom-3-unified-development-engine",
                false,
            ),
            (
                "doom-3-resurrection-of-evil-classic-dude-doom-3-unified-development-engine",
                true,
            ),
        ] {
            let port = catalog.port(id).unwrap();
            assert_eq!(
                port.external_profile_policy,
                Some(crate::ExternalProfilePolicy::Doom3LinuxV1)
            );
            super::super::validate(port).unwrap();
            assert!(!super::super::applies_to(
                port.external_profile_policy.unwrap(),
                Platform::WindowsX86_64
            ));
            let mut changed = port.clone();
            changed.persistent_paths.push("base/config.cfg".into());
            assert!(super::super::validate(&changed).is_err());
            let mut changed = port.clone();
            if expansion {
                changed.launch_arguments.clear();
            } else {
                changed.launch_arguments = vec!["+set".into(), "fs_game".into(), "d3xp".into()];
            }
            assert!(super::super::validate(&changed).is_err());
        }
    }
}
