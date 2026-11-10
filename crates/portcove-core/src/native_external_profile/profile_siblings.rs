//! The official CorsixTH and OpenLoco packages and their upstream profile roots.
use std::{fs, io::Read, path::Path};

use crate::{ExternalProfilePolicy, Platform, PortDefinition, PortcoveError, Result};

pub(crate) const CORSIXTH_APPIMAGE: [&str; 2] = ["corsixth-", "-x86_64.appimage"];
pub(crate) const OPENLOCO_APPIMAGE: [&str; 2] = ["openloco-", "-linux-x64.appimage"];
const OPENLOCO_MAC: [&str; 2] = ["openloco-", "-macos-arm64.zip"];

pub(super) fn applies(policy: ExternalProfilePolicy) -> bool {
    matches!(
        policy,
        ExternalProfilePolicy::CorsixthLinuxV1 | ExternalProfilePolicy::OpenlocoUnixV1
    )
}

pub(super) fn applies_to(policy: ExternalProfilePolicy, platform: Platform) -> bool {
    matches!(
        (policy, platform),
        (
            ExternalProfilePolicy::CorsixthLinuxV1,
            Platform::LinuxX86_64
        ) | (
            ExternalProfilePolicy::OpenlocoUnixV1,
            Platform::LinuxX86_64 | Platform::MacosAarch64
        )
    )
}

pub(crate) fn requires_openloco_zip(port: &PortDefinition, platform: Platform) -> bool {
    port.external_profile_policy == Some(ExternalProfilePolicy::OpenlocoUnixV1)
        && platform == Platform::MacosAarch64
}

pub(crate) fn matches_openloco_zip(port: &PortDefinition, platform: Platform, name: &str) -> bool {
    !requires_openloco_zip(port, platform)
        || crate::release::versioned_asset_name_matches(
            name,
            OPENLOCO_MAC[0],
            OPENLOCO_MAC[1],
            true,
        )
}

pub(super) fn validate(port: &PortDefinition, policy: ExternalProfilePolicy) -> Result<()> {
    const LINUX: Platform = Platform::LinuxX86_64;
    const MAC: Platform = Platform::MacosAarch64;
    let (id, repo, routes): (_, _, &[(Platform, [&str; 2], &str)]) = match policy {
        ExternalProfilePolicy::CorsixthLinuxV1 => (
            "corsixth-corsixth",
            "CorsixTH/CorsixTH",
            &[(LINUX, CORSIXTH_APPIMAGE, "corsix-th.AppImage")],
        ),
        ExternalProfilePolicy::OpenlocoUnixV1 => (
            "openloco-openloco",
            "OpenLoco/OpenLoco",
            &[
                (LINUX, OPENLOCO_APPIMAGE, "OpenLoco.AppImage"),
                (MAC, OPENLOCO_MAC, "OpenLoco.app/Contents/MacOS/OpenLoco"),
            ],
        ),
        _ => unreachable!("only the reviewed external-profile siblings are validated here"),
    };
    let mut checked = routes
        .iter()
        .filter(|(platform, _, _)| port.platforms.contains(platform))
        .peekable();
    if port.id != id
        || !port.release.repository.eq_ignore_ascii_case(repo)
        || port.channels != [crate::ReleaseChannel::Stable]
        || port.source_profile.is_some()
        || checked.peek().is_none()
        || checked.any(|(platform, asset, executable)| {
            port.release
                .asset_hints
                .get(platform)
                .is_none_or(|hints| hints != asset)
                || port
                    .executable_hints
                    .get(platform)
                    .is_none_or(|hints| hints != &[*executable])
        })
    {
        return Err(PortcoveError::verification(
            "the external profile requires the reviewed official package and its exact executable",
        ));
    }
    Ok(())
}

#[cfg(unix)]
pub(super) fn profile_root(
    policy: ExternalProfilePolicy,
    platform: Platform,
    command: &std::process::Command,
) -> Result<std::path::PathBuf> {
    use super::{environment, unix_account_home};
    let xdg = environment(command, "XDG_CONFIG_HOME");
    let home = environment(command, "HOME");
    let needs_account = policy == ExternalProfilePolicy::OpenlocoUnixV1
        && (platform == Platform::MacosAarch64 || xdg.as_ref().is_none_or(|path| path.is_empty()));
    let account = if needs_account {
        unix_account_home()?
    } else {
        None
    };
    profile_root_from_inputs(
        policy,
        platform,
        xdg.as_deref(),
        account.as_deref(),
        home.as_deref(),
    )
}

#[cfg(unix)]
fn profile_root_from_inputs(
    policy: ExternalProfilePolicy,
    platform: Platform,
    xdg: Option<&std::ffi::OsStr>,
    account: Option<&std::ffi::OsStr>,
    home: Option<&std::ffi::OsStr>,
) -> Result<std::path::PathBuf> {
    let base = |value, name| {
        let path = super::require_absolute(value, name)?;
        if path.parent().is_none() {
            return Err(PortcoveError::launch(
                "The game needs a personal profile outside the managed library.",
            ));
        }
        Ok(path)
    };
    if platform == Platform::MacosAarch64 {
        return Ok(base(account, "account home")?.join("Library/Application Support/OpenLoco"));
    }
    if policy == ExternalProfilePolicy::CorsixthLinuxV1 {
        let root = match xdg {
            // Lua treats a defined empty value as present.
            Some(path) => base(Some(path), "XDG_CONFIG_HOME")?,
            None => base(home, "HOME")?.join(".config"),
        };
        return Ok(root.join("CorsixTH"));
    }
    let root = match xdg.filter(|path| !path.is_empty()) {
        Some(path) => base(Some(path), "XDG_CONFIG_HOME")?,
        None => base(account.or(home), "account home or HOME")?.join(".config"),
    };
    Ok(root.join("OpenLoco"))
}

pub(crate) fn require_payload(executable: &Path, platform: Platform) -> Result<()> {
    if platform == Platform::LinuxX86_64 {
        return super::require_type2_appimage(executable);
    }
    let mut file = crate::external_runtime::open_single_link_file(executable)?;
    let mut header = [0; 16];
    file.read_exact(&mut header)?;
    // The upstream ARM64 ZIP contains a thin little-endian MH_EXECUTE.
    if !header.starts_with(&[0xcf, 0xfa, 0xed, 0xfe, 12, 0, 0, 1]) || header[12..] != [2, 0, 0, 0] {
        return Err(PortcoveError::verification(
            "the OpenLoco bundle no longer contains its expected Mac ARM64 executable",
        ));
    }
    let contents = executable
        .parent()
        .and_then(Path::parent)
        .ok_or_else(|| PortcoveError::verification("the OpenLoco bundle has no Contents folder"))?;
    crate::external_runtime::open_single_link_file(&contents.join("Info.plist"))?;
    if !fs::symlink_metadata(contents.join("Resources"))?.is_dir() {
        return Err(PortcoveError::verification(
            "the OpenLoco bundle has no Resources directory",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn profile_siblings_preserve_distinct_xdg_home_and_account_precedence() {
        use std::ffi::OsStr;

        let linux = Platform::LinuxX86_64;
        let mac = Platform::MacosAarch64;
        let corsix = ExternalProfilePolicy::CorsixthLinuxV1;
        let loco = ExternalProfilePolicy::OpenlocoUnixV1;
        let xdg = Some(OsStr::new("/player/settings"));
        let empty = Some(OsStr::new(""));
        let relative = Some(OsStr::new("relative"));
        let home = Some(OsStr::new("/player/home"));
        let account = Some(OsStr::new("/account/home"));
        let root = |policy, platform, xdg, account, home| {
            profile_root_from_inputs(policy, platform, xdg, account, home)
        };
        assert_eq!(
            root(corsix, linux, None, account, home).unwrap(),
            Path::new("/player/home/.config/CorsixTH")
        );
        assert_eq!(
            root(corsix, linux, xdg, account, home).unwrap(),
            Path::new("/player/settings/CorsixTH")
        );
        assert!(root(corsix, linux, empty, account, home).is_err());
        assert!(root(corsix, linux, relative, account, home).is_err());
        assert_eq!(
            root(loco, linux, empty, account, home).unwrap(),
            Path::new("/account/home/.config/OpenLoco")
        );
        assert_eq!(
            root(loco, linux, None, None, home).unwrap(),
            Path::new("/player/home/.config/OpenLoco")
        );
        assert!(root(loco, linux, relative, account, home).is_err());
        assert_eq!(
            root(loco, mac, relative, account, home).unwrap(),
            Path::new("/account/home/Library/Application Support/OpenLoco")
        );
        assert!(root(loco, mac, xdg, None, home).is_err());
    }

    #[test]
    fn profile_siblings_mac_payload_requires_the_arm64_bundle_coordinates() {
        let temporary = tempfile::tempdir().unwrap();
        let contents = temporary
            .path()
            .canonicalize()
            .unwrap()
            .join("OpenLoco.app/Contents");
        let executable = contents.join("MacOS/OpenLoco");
        fs::create_dir_all(executable.parent().unwrap()).unwrap();
        fs::create_dir(contents.join("Resources")).unwrap();
        let mut header = [0; 16];
        header[..8].copy_from_slice(&[0xcf, 0xfa, 0xed, 0xfe, 12, 0, 0, 1]);
        header[12] = 2;
        fs::write(&executable, header).unwrap();
        let mac = Platform::MacosAarch64;
        assert!(require_payload(&executable, mac).is_err());
        fs::write(contents.join("Info.plist"), b"inert fixture").unwrap();
        require_payload(&executable, mac).unwrap();
        header[4] = 7;
        fs::write(&executable, header).unwrap();
        assert!(require_payload(&executable, mac).is_err());
    }
}
