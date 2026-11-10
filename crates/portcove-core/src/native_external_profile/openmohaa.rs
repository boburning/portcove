//! The official flat OpenMoHAA Unix ZIP and its inherited profile contract.
use std::{
    fs,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    process::Command,
};

use crate::{ExternalProfilePolicy, LaunchSpec, Platform, PortDefinition, PortcoveError, Result};

use super::{environment, require_absolute};

const ENGINE: &str = "openmohaa";
const PREFIX: &str = "openmohaa-";

fn suffix(platform: Platform) -> &'static str {
    if platform == Platform::LinuxX86_64 {
        "-linux-amd64.zip"
    } else {
        "-macos-multiarch-arm64-x86_64.zip"
    }
}

pub(super) fn applies_to(platform: Platform) -> bool {
    matches!(
        platform,
        Platform::LinuxX86_64 | Platform::MacosX86_64 | Platform::MacosAarch64
    )
}

pub(crate) fn requires_zip(port: &PortDefinition, platform: Platform) -> bool {
    port.external_profile_policy == Some(ExternalProfilePolicy::OpenmohaaUnixV1)
        && applies_to(platform)
}

pub(crate) fn matches_asset(port: &PortDefinition, platform: Platform, asset_name: &str) -> bool {
    !requires_zip(port, platform)
        || crate::release::versioned_asset_name_matches(asset_name, PREFIX, suffix(platform))
}

fn title(port: &PortDefinition) -> Option<(&'static str, &'static [&'static str])> {
    match port.id.as_str() {
        "medal-of-honor-allied-assault-openmohaa" => Some(("launch_openmohaa_base", &["main"])),
        "medal-of-honor-allied-assault-spearhead-openmohaa" => {
            Some(("launch_openmohaa_spearhead", &["main", "mainta"]))
        }
        "medal-of-honor-allied-assault-breakthrough-openmohaa" => {
            Some(("launch_openmohaa_breakthrough", &["main", "maintt"]))
        }
        _ => None,
    }
}

pub(super) fn validate(port: &PortDefinition) -> Result<()> {
    let incompatible = || {
        PortcoveError::verification(
            "OpenMoHAA Unix requires the official ZIP, title launcher and original-data layout",
        )
    };
    let (launcher, originals) = title(port).ok_or_else(incompatible)?;
    let routes = port
        .platforms
        .iter()
        .copied()
        .filter(|&platform| applies_to(platform));
    if !port
        .release
        .repository
        .eq_ignore_ascii_case("openmoh/openmohaa")
        || port.channels != [crate::ReleaseChannel::Stable]
        || port.persistent_paths != originals
        || port.source_profile.is_some()
        || routes.clone().next().is_none()
        || routes.clone().any(|platform| {
            port.release
                .asset_hints
                .get(&platform)
                .is_none_or(|hints| hints != &[PREFIX, suffix(platform)])
                || port
                    .executable_hints
                    .get(&platform)
                    .is_none_or(|hints| hints != &[launcher])
        })
    {
        return Err(incompatible());
    }
    Ok(())
}

pub(crate) fn prepare_package(
    port: &PortDefinition,
    platform: Platform,
    root: &Path,
) -> Result<()> {
    if !requires_zip(port, platform) {
        return Ok(());
    }
    let (launcher, _) = title(port).ok_or_else(|| {
        PortcoveError::verification("OpenMoHAA package has no reviewed title launcher")
    })?;
    let companions: &[_] = if platform == Platform::LinuxX86_64 {
        &[
            "cgame.so",
            "game.so",
            "libSDL2-2.0.so.0",
            "libopenal.so.1",
            "libcurl.so.4",
        ]
    } else {
        &[
            "cgame.dylib",
            "game.dylib",
            "libSDL2-2.0.0.dylib",
            "libopenal.1.dylib",
            "libcurl.4.dylib",
        ]
    };
    for original in ["main", "mainta", "maintt"] {
        match fs::symlink_metadata(root.join(original)) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
            Ok(_) => {
                return Err(PortcoveError::verification(
                    "OpenMoHAA package unexpectedly contains an original-data path",
                ));
            }
        }
    }
    for name in companions {
        crate::external_runtime::open_single_link_file(&root.join(name))?;
    }
    let programs = [root.join(launcher), root.join(ENGINE)];
    for path in &programs {
        require_native_program(path, platform)?;
    }
    for path in &programs {
        crate::permissions::normalize_archive_entry(path, false, true)?;
    }
    Ok(())
}

fn require_native_program(path: &Path, platform: Platform) -> Result<()> {
    let mut file = crate::external_runtime::open_single_link_file(path)?;
    let mut header = [0; 48];
    file.read_exact(&mut header)?;
    let native = if platform == Platform::LinuxX86_64 {
        // ELF64 little-endian, ET_EXEC or PIE, AMD64.
        header.starts_with(b"\x7fELF\x02\x01") && matches!(&header[16..20], [2 | 3, 0, 0x3e, 0])
    } else {
        // The selected multiarch ZIP contains two 32-bit fat-header entries.
        // Require both advertised 64-bit architectures, in either order.
        let universal = header.starts_with(&[0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2])
            && matches!(
                (&header[8..12], &header[28..32]),
                ([1, 0, 0, 7], [1, 0, 0, 12]) | ([1, 0, 0, 12], [1, 0, 0, 7])
            );
        universal && mac_executable_slices(&mut file, &header)?
    };
    if !native {
        return Err(PortcoveError::verification(
            "OpenMoHAA package launcher or engine changed native format",
        )
        .detail("path", path.display().to_string()));
    }
    Ok(())
}

fn mac_executable_slices(file: &mut fs::File, header: &[u8; 48]) -> Result<bool> {
    let length = file.metadata()?.len();
    for entry in header[8..].chunks_exact(20) {
        let offset = u64::from(u32::from_be_bytes(entry[8..12].try_into().unwrap()));
        let size = u64::from(u32::from_be_bytes(entry[12..16].try_into().unwrap()));
        if offset < header.len() as u64 || size < 32 || offset + size > length {
            return Ok(false);
        }
        file.seek(SeekFrom::Start(offset))?;
        let mut slice = [0; 16];
        file.read_exact(&mut slice)?;
        if !slice.starts_with(&[0xcf, 0xfa, 0xed, 0xfe])
            || slice[4..8].iter().rev().ne(entry[..4].iter())
            || slice[12..] != [2, 0, 0, 0]
        {
            return Ok(false);
        }
    }
    Ok(true)
}

pub(super) fn profile_root(platform: Platform, command: &Command) -> Result<PathBuf> {
    let home = || require_absolute(environment(command, "HOME").as_deref(), "HOME");
    let root = if platform != Platform::LinuxX86_64 {
        home()?.join("Library/Application Support/openmohaa")
    } else if environment(command, "FLATPAK_ID").is_some_and(|id| !id.is_empty()) {
        match environment(command, "XDG_DATA_HOME").filter(|path| !path.is_empty()) {
            Some(path) => require_absolute(Some(&path), "XDG_DATA_HOME")?.join("openmohaa"),
            None => home()?.join(".local/share/openmohaa"),
        }
    } else {
        home()?.join(".openmohaa")
    };
    require_path_budget(&root, platform)?;
    Ok(root)
}

pub(super) fn require_launch_paths(spec: &LaunchSpec) -> Result<()> {
    if spec.working_directory != spec.install_root
        || spec.executable.parent() != Some(spec.install_root.as_path())
    {
        return Err(PortcoveError::launch(
            "OpenMoHAA requires the managed package root as its working directory.",
        ));
    }
    require_path_budget(&spec.install_root, Platform::current()?)
}

fn require_path_budget(path: &Path, platform: Platform) -> Result<()> {
    // MAX_OSPATH follows the platform PATH_MAX. Leave room for MAX_QPATH
    // and the longest title folder and separators.
    let maximum = if platform == Platform::LinuxX86_64 {
        4096
    } else {
        1024
    };
    if path.as_os_str().len() >= maximum - 264 {
        return Err(PortcoveError::launch(
            "The OpenMoHAA path is too long for its game and save files. Use a shorter location.",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Catalog;

    #[cfg(unix)]
    #[test]
    fn profile_uses_the_engine_home_and_flatpak_precedence() {
        let mut command =
            crate::ChildProcessPolicy::native_command(crate::ChildProcessClass::Game, ENGINE)
                .unwrap();
        command.env_clear().env("HOME", "/player/home");
        command.env("XDG_DATA_HOME", "relative");
        let linux = Platform::LinuxX86_64;
        let mac = Platform::MacosAarch64;
        assert_eq!(
            profile_root(linux, &command).unwrap(),
            Path::new("/player/home/.openmohaa")
        );
        command.env("FLATPAK_ID", "org.example.Player");
        assert!(profile_root(linux, &command).is_err());
        assert_eq!(
            profile_root(mac, &command).unwrap(),
            Path::new("/player/home/Library/Application Support/openmohaa")
        );
        command.env("XDG_DATA_HOME", "/player/data");
        command.env("HOME", "relative");
        assert_eq!(
            profile_root(linux, &command).unwrap(),
            Path::new("/player/data/openmohaa")
        );
        assert!(profile_root(mac, &command).is_err());
        command.env("XDG_DATA_HOME", "");
        assert!(profile_root(linux, &command).is_err());
        command.env("HOME", "/player/home");
        assert_eq!(
            profile_root(linux, &command).unwrap(),
            Path::new("/player/home/.local/share/openmohaa")
        );
        command.env("HOME", format!("/{}", "a".repeat(800)));
        assert!(profile_root(mac, &command).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn package_only_marks_the_selected_launcher_and_child_executable() {
        let catalog = Catalog::embedded().unwrap();
        let port = catalog
            .port("medal-of-honor-allied-assault-spearhead-openmohaa")
            .unwrap();
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let launcher = root.join("launch_openmohaa_spearhead");
        let other = root.join("launch_openmohaa_base");
        let engine = root.join(ENGINE);
        let platform = Platform::LinuxX86_64;
        let mut elf = [0_u8; 48];
        elf[..6].copy_from_slice(b"\x7fELF\x02\x01");
        elf[16..20].copy_from_slice(&[3, 0, 0x3e, 0]);
        for file in [
            &launcher,
            &other,
            &engine,
            &root.join("game.so"),
            &root.join("cgame.so"),
            &root.join("libSDL2-2.0.so.0"),
            &root.join("libopenal.so.1"),
            &root.join("libcurl.so.4"),
        ] {
            fs::write(file, elf).unwrap();
            crate::permissions::normalize_archive_entry(file, false, false).unwrap();
        }
        fs::write(&engine, [0; 48]).unwrap();
        assert!(prepare_package(port, platform, &root).is_err());
        assert!(!crate::permissions::executable_intent(&launcher).unwrap());
        fs::remove_file(&engine).unwrap();
        std::os::unix::fs::symlink(&other, &engine).unwrap();
        assert!(prepare_package(port, platform, &root).is_err());
        fs::remove_file(&engine).unwrap();
        fs::write(&engine, elf).unwrap();
        fs::create_dir(root.join("mainta")).unwrap();
        assert!(prepare_package(port, platform, &root).is_err());
        fs::remove_dir(root.join("mainta")).unwrap();
        prepare_package(port, platform, &root).unwrap();
        assert!(crate::permissions::executable_intent(&launcher).unwrap());
        assert!(crate::permissions::executable_intent(&engine).unwrap());
        assert!(!crate::permissions::executable_intent(&other).unwrap());
        assert!(!crate::permissions::executable_intent(&root.join("cgame.so")).unwrap());
    }

    #[test]
    fn universal_headers_require_two_matching_executable_slices() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().canonicalize().unwrap().join(ENGINE);
        let mut program = [0; 128];
        program[..8].copy_from_slice(&[0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2]);
        for (entry, offset, cpu) in [(8, 48, 7), (28, 80, 12)] {
            program[entry..entry + 4].copy_from_slice(&[1, 0, 0, cpu]);
            program[entry + 8..entry + 16].copy_from_slice(&[0, 0, 0, offset as u8, 0, 0, 0, 32]);
            program[offset..offset + 8].copy_from_slice(&[0xcf, 0xfa, 0xed, 0xfe, cpu, 0, 0, 1]);
            program[offset + 12] = 2;
        }
        fs::write(&path, program).unwrap();
        for platform in [Platform::MacosX86_64, Platform::MacosAarch64] {
            require_native_program(&path, platform).unwrap();
        }
        program[80 + 12] = 6; // MH_DYLIB
        fs::write(&path, program).unwrap();
        assert!(require_native_program(&path, Platform::MacosAarch64).is_err());
    }

    #[test]
    fn layout_rejects_unreviewed_title_data_launcher_and_selector() {
        let catalog = Catalog::embedded().unwrap();
        let port = catalog
            .port("medal-of-honor-allied-assault-breakthrough-openmohaa")
            .unwrap();
        let mut changed = port.clone();
        changed.persistent_paths.push("mainta".into());
        assert!(validate(&changed).is_err());
        let mut changed = port.clone();
        changed
            .executable_hints
            .insert(Platform::MacosAarch64, vec![ENGINE.into()]);
        assert!(validate(&changed).is_err());
        let mut changed = port.clone();
        changed
            .release
            .asset_hints
            .insert(Platform::LinuxX86_64, vec![".zip".into()]);
        assert!(validate(&changed).is_err());
        let mut changed = port.clone();
        changed.id = "unrelated".into();
        assert!(validate(&changed).is_err());
        assert!(!applies_to(Platform::WindowsX86_64));
        for name in [
            "unrelated-openmohaa-v0.82.1-linux-amd64.zip",
            "openmohaa-v0.82.1-linux-amd64.zip.tar.gz",
            "openmohaa-v0.82.1-test-linux-amd64.zip",
        ] {
            assert!(!matches_asset(port, Platform::LinuxX86_64, name), "{name}");
        }
    }
}
