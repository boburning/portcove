//! Default external profiles for the official JGR Patch Pack and OpenGlad archives.
use std::{fs, path::Path};

use crate::{ExternalProfilePolicy, LaunchSpec, Platform, PortDefinition, PortcoveError, Result};

const JGR_TAR: [&str; 2] = ["openttd-jgrpp-", "-linux-generic-amd64.tar.xz"];
const OPENGLAD_ZIP: &str = "openglad-macos-arm64.zip";
const JGR_WINDOWS_FALLBACKS: &[&str] = &[
    "openttd.cfg",
    "hs.dat",
    "hotkeys.cfg",
    "windows.cfg",
    "private.cfg",
    "secrets.cfg",
    "favs.cfg",
    "openttd.log",
    "save",
    "scenario",
    "heightmap",
    "orderlist",
    "newgrf",
    "screenshot",
    "content_download",
];

pub(super) fn applies(policy: ExternalProfilePolicy) -> bool {
    matches!(
        policy,
        ExternalProfilePolicy::JgrppLinuxV1 | ExternalProfilePolicy::OpengladMacV1
    )
}

fn selected_policy(port: &PortDefinition, platform: Platform) -> Option<ExternalProfilePolicy> {
    port.external_profile_policy
        .filter(|&policy| applies(policy) && super::applies_to(policy, platform))
}

pub(crate) fn requires_archive(port: &PortDefinition, platform: Platform) -> bool {
    selected_policy(port, platform).is_some()
}

pub(crate) fn matches_asset(port: &PortDefinition, platform: Platform, name: &str) -> bool {
    match selected_policy(port, platform) {
        Some(ExternalProfilePolicy::JgrppLinuxV1) => {
            crate::release::versioned_asset_name_matches(name, JGR_TAR[0], JGR_TAR[1], false)
        }
        Some(ExternalProfilePolicy::OpengladMacV1) => name.eq_ignore_ascii_case(OPENGLAD_ZIP),
        _ => true,
    }
}

pub(super) fn validate(port: &PortDefinition, policy: ExternalProfilePolicy) -> Result<()> {
    let (platform, hints, executable, needs_tar): (_, &[_], _, _) = match policy {
        ExternalProfilePolicy::JgrppLinuxV1 => (Platform::LinuxX86_64, &JGR_TAR, "openttd", true),
        ExternalProfilePolicy::OpengladMacV1 => {
            (Platform::MacosAarch64, &[OPENGLAD_ZIP], "openglad", false)
        }
        _ => unreachable!("only the reviewed archive siblings are validated here"),
    };
    if !port.platforms.contains(&platform)
        || port.channels != [crate::ReleaseChannel::Stable]
        || port.source_profile.is_some()
        || port.release.linux_tar_xz != needs_tar
        || port.release.archive_file_links != needs_tar
        || (needs_tar && port.persistent_paths != JGR_WINDOWS_FALLBACKS)
        || port
            .release
            .asset_hints
            .get(&platform)
            .is_none_or(|actual| actual != hints)
        || port
            .executable_hints
            .get(&platform)
            .is_none_or(|actual| actual != &[executable])
    {
        return Err(PortcoveError::verification(
            "the external profile requires its official archive, executable and retained data layout",
        ));
    }
    Ok(())
}

#[cfg(unix)]
pub(super) fn profile_roots(
    policy: ExternalProfilePolicy,
    command: &std::process::Command,
) -> Result<Vec<std::path::PathBuf>> {
    use super::{environment, unix_account_home};

    let home = environment(command, "HOME");
    if policy == ExternalProfilePolicy::OpengladMacV1 {
        // The normal game environment omits this override. Detect the caller's
        // explicit choice before launching a different profile.
        let custom = std::env::var_os("OPENGLAD_CONFIG_DIR")
            .filter(|path| !path.is_empty())
            .or_else(|| environment(command, "OPENGLAD_CONFIG_DIR"));
        return Ok(vec![openglad_root(home.as_deref(), custom.as_deref())?]);
    }
    let config = environment(command, "XDG_CONFIG_HOME");
    let data = environment(command, "XDG_DATA_HOME");
    let account = if home.is_none() && (config.is_none() || data.is_none()) {
        unix_account_home()?
    } else {
        None
    };
    jgr_roots(
        config.as_deref(),
        data.as_deref(),
        home.as_deref(),
        account.as_deref(),
    )
}

#[cfg(unix)]
fn personal_base(value: Option<&std::ffi::OsStr>, name: &str) -> Result<std::path::PathBuf> {
    let path = super::require_absolute(value, name)?;
    if path.parent().is_none() {
        return Err(PortcoveError::launch(
            "The game needs a personal profile outside the managed library.",
        ));
    }
    Ok(path)
}

#[cfg(unix)]
fn openglad_root(
    home: Option<&std::ffi::OsStr>,
    custom: Option<&std::ffi::OsStr>,
) -> Result<std::path::PathBuf> {
    if custom.is_some_and(|path| !path.is_empty()) {
        return Err(PortcoveError::launch(
            "OpenGlad is using OPENGLAD_CONFIG_DIR. Preserve that profile and use a separately prepared copy.",
        ));
    }
    Ok(personal_base(home, "HOME")?.join(".openglad"))
}

#[cfg(unix)]
fn jgr_roots(
    config: Option<&std::ffi::OsStr>,
    data: Option<&std::ffi::OsStr>,
    home: Option<&std::ffi::OsStr>,
    account: Option<&std::ffi::OsStr>,
) -> Result<Vec<std::path::PathBuf>> {
    let root = |value, name, default| -> Result<std::path::PathBuf> {
        let base = match value {
            Some(path) => personal_base(Some(path), name)?,
            None => personal_base(home.or(account), "HOME or account home")?.join(default),
        };
        Ok(base.join("openttd"))
    };
    Ok(vec![
        root(config, "XDG_CONFIG_HOME", ".config")?,
        root(data, "XDG_DATA_HOME", ".local/share")?,
    ])
}

pub(super) fn require_launch_layout(
    policy: ExternalProfilePolicy,
    spec: &LaunchSpec,
    command: &std::process::Command,
    checkpoint: &impl Fn() -> Result<()>,
) -> Result<()> {
    if spec.executable.parent() != Some(spec.working_directory.as_path()) {
        return Err(PortcoveError::launch(
            "The game needs to start in the directory containing its packaged executable.",
        ));
    }
    let library_path = if policy == ExternalProfilePolicy::JgrppLinuxV1 {
        "LD_LIBRARY_PATH"
    } else {
        "DYLD_LIBRARY_PATH"
    };
    if super::environment(command, library_path).is_some_and(|path| !path.is_empty()) {
        return Err(PortcoveError::launch(format!(
            "{library_path} changes where the game loads libraries. Use the default loader paths or a separately prepared copy."
        )));
    }
    if policy == ExternalProfilePolicy::JgrppLinuxV1 {
        require_jgr_runtime(&spec.working_directory, checkpoint)?;
    }
    Ok(())
}

fn require_jgr_runtime(root: &Path, checkpoint: &impl Fn() -> Result<()>) -> Result<()> {
    match fs::symlink_metadata(root.join("openttd.cfg")) {
        Ok(_) => {
            return Err(PortcoveError::launch(
                "JGR Patch Pack found a configuration in its managed runtime. Preserve it and use a separately prepared copy for that profile.",
            ));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    crate::external_runtime::shared_preferences::check_bounded_tree(
        &root.join("social_integration"),
        "JGR Patch Pack packaged social plugins",
        |path, _| {
            checkpoint()?;
            check_jgr_profile_plugin(root, path)
        },
    )
}

pub(super) fn check_jgr_profile_plugin(root: &Path, path: &Path) -> Result<()> {
    if path.strip_prefix(root).is_ok_and(|relative| {
        (relative.starts_with("social_integration")
            || relative.starts_with("content_download/social_integration"))
            && relative.file_name().is_some_and(|name| {
                name.to_string_lossy()
                    .to_ascii_lowercase()
                    .ends_with("-social.so")
            })
    }) {
        return Err(PortcoveError::launch(
            "JGR Patch Pack found a native social plugin. Keep it with a separately prepared copy.",
        ));
    }
    Ok(())
}

pub(crate) fn require_payload(
    executable: &Path,
    platform: Platform,
    checkpoint: &impl Fn() -> Result<()>,
) -> Result<()> {
    let parent = executable.parent().ok_or_else(|| {
        PortcoveError::verification("the upstream player has no package directory")
    })?;
    if platform == Platform::LinuxX86_64 {
        super::read_amd64_elf_header(executable)?;
        return require_jgr_runtime(parent, checkpoint);
    }
    super::require_arm64_macho(
        executable,
        "the OpenGlad archive no longer contains its expected Mac ARM64 executable",
    )?;
    crate::external_runtime::open_single_link_file(&parent.join("cfg/openglad.yaml"))?;
    if !fs::symlink_metadata(parent.join("packs/core"))?.is_dir() {
        return Err(PortcoveError::verification(
            "the OpenGlad archive has no core campaign pack directory",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn archive_siblings_follow_upstream_profile_precedence() {
        use std::ffi::OsStr;

        let home = Some(OsStr::new("/player/home"));
        let account = Some(OsStr::new("/account/home"));
        let config = Some(OsStr::new("/player/config"));
        let data = Some(OsStr::new("/player/data"));
        let empty = Some(OsStr::new(""));
        let relative = Some(OsStr::new("relative"));
        assert_eq!(
            jgr_roots(None, data, home, account).unwrap(),
            [
                Path::new("/player/home/.config/openttd"),
                Path::new("/player/data/openttd")
            ]
        );
        assert_eq!(
            jgr_roots(config, None, None, account).unwrap(),
            [
                Path::new("/player/config/openttd"),
                Path::new("/account/home/.local/share/openttd")
            ]
        );
        assert!(jgr_roots(config, data, relative, account).is_ok());
        assert!(jgr_roots(empty, data, home, account).is_err());
        assert!(jgr_roots(config, relative, home, account).is_err());
        assert!(jgr_roots(config, None, relative, account).is_err());
        assert_eq!(
            openglad_root(home, empty).unwrap(),
            Path::new("/player/home/.openglad")
        );
        assert!(openglad_root(home, config).is_err());
        assert!(openglad_root(None, None).is_err());
        assert!(openglad_root(empty, None).is_err());
        assert!(openglad_root(relative, None).is_err());
    }

    #[test]
    fn archive_siblings_require_reviewed_payload_shapes() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path();
        let jgr = root.join("openttd");
        let mut elf = [0; 20];
        elf[..6].copy_from_slice(b"\x7fELF\x02\x01");
        elf[16..].copy_from_slice(&[3, 0, 0x3e, 0]);
        fs::write(&jgr, elf).unwrap();
        require_payload(&jgr, Platform::LinuxX86_64, &|| Ok(())).unwrap();
        fs::write(root.join("openttd.cfg"), b"preserve portable settings").unwrap();
        assert!(require_payload(&jgr, Platform::LinuxX86_64, &|| Ok(())).is_err());
        fs::remove_file(root.join("openttd.cfg")).unwrap();
        let plugins = root.join("social_integration/nested");
        fs::create_dir_all(&plugins).unwrap();
        fs::write(plugins.join("example-social.so"), b"plugin").unwrap();
        assert!(require_payload(&jgr, Platform::LinuxX86_64, &|| Ok(())).is_err());
        assert!(
            check_jgr_profile_plugin(
                root,
                &root.join("content_download/social_integration/plugin-social.so")
            )
            .is_err()
        );
        assert!(check_jgr_profile_plugin(root, &root.join("other/example-social.so")).is_ok());

        let openglad = root.join("openglad");
        let macho = [0xcf, 0xfa, 0xed, 0xfe, 12, 0, 0, 1, 0, 0, 0, 0, 2, 0, 0, 0];
        fs::write(&openglad, macho).unwrap();
        assert!(require_payload(&openglad, Platform::MacosAarch64, &|| Ok(())).is_err());
        fs::create_dir(root.join("cfg")).unwrap();
        fs::write(root.join("cfg/openglad.yaml"), b"profile defaults").unwrap();
        fs::create_dir_all(root.join("packs/core")).unwrap();
        require_payload(&openglad, Platform::MacosAarch64, &|| Ok(())).unwrap();
        fs::write(&openglad, elf).unwrap();
        assert!(require_payload(&openglad, Platform::MacosAarch64, &|| Ok(())).is_err());
    }
}
