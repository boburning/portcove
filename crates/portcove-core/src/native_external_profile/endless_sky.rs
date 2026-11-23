//! Official Endless Sky portable packages and their SDL player profile.
#[cfg(target_os = "linux")]
use std::{ffi::OsStr, path::PathBuf};

use crate::{
    ExternalProfilePolicy, Platform, PortDefinition, PortcoveError, ReleaseChannel, Result,
};

pub(crate) const NATIVE_CAPABILITY: u32 = 39;

const WINDOWS_ASSET: [&str; 2] = ["endlesssky-win64-", ".zip"];
const LINUX_ASSET: [&str; 2] = ["endless_sky-", "-x86_64.appimage"];

pub(super) fn validate(port: &PortDefinition) -> Result<()> {
    let routes = [
        (Platform::WindowsX86_64, WINDOWS_ASSET, "Endless Sky.exe"),
        (Platform::LinuxX86_64, LINUX_ASSET, "EndlessSky.AppImage"),
    ];
    if port.platforms.is_empty()
        || port.channels != [ReleaseChannel::Stable]
        || port.source_profile.is_some()
        || !port.release.direct.is_empty()
        || !port.release.curated.is_empty()
        || !port.release.user_prepared.is_empty()
        || !port.release.managed_build.is_empty()
        || routes
            .into_iter()
            .filter(|(platform, _, _)| port.platforms.contains(platform))
            .any(|(platform, asset, executable)| {
                port.release
                    .asset_hints
                    .get(&platform)
                    .is_none_or(|hints| hints != &asset)
                    || port
                        .executable_hints
                        .get(&platform)
                        .is_none_or(|hints| hints != &[executable])
            })
    {
        return Err(PortcoveError::verification(
            "Endless Sky requires the official desktop portable release and its reviewed executable",
        ));
    }
    Ok(())
}

pub(crate) fn matches_asset(port: &PortDefinition, platform: Platform, name: &str) -> bool {
    if port.external_profile_policy != Some(ExternalProfilePolicy::EndlessSkyDesktopV1) {
        return true;
    }
    let [prefix, suffix] = match platform {
        Platform::LinuxX86_64 => LINUX_ASSET,
        Platform::WindowsX86_64 => WINDOWS_ASSET,
        _ => return false,
    };
    crate::release::versioned_asset_name_matches(name, prefix, suffix, false)
}

#[cfg(target_os = "linux")]
pub(super) fn linux_profile_root(xdg: Option<&OsStr>, home: Option<&OsStr>) -> Result<PathBuf> {
    let root = match xdg {
        Some(path) => super::require_absolute(Some(path), "XDG_DATA_HOME")?,
        None => super::require_absolute(home, "HOME")?.join(".local/share"),
    };
    Ok(root.join("endless-sky"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_profile_uses_sdl_data_home_and_rejects_relative_override() {
        let temporary = tempfile::tempdir().unwrap();
        let account = temporary.path().join("account");
        let data = temporary.path().join("data");
        let home = Some(account.as_os_str());
        assert_eq!(
            linux_profile_root(Some(data.as_os_str()), home).unwrap(),
            data.join("endless-sky")
        );
        assert_eq!(
            linux_profile_root(None, home).unwrap(),
            account.join(".local/share/endless-sky")
        );
        assert!(linux_profile_root(Some(OsStr::new("")), home).is_err());
        assert!(linux_profile_root(Some(OsStr::new("relative")), home).is_err());
    }

    #[test]
    fn managed_release_selectors_reject_installers_and_other_package_variants() {
        let catalog = crate::Catalog::embedded().unwrap();
        let port = catalog.port("endless-sky").unwrap();
        let windows = Platform::WindowsX86_64;
        let linux = Platform::LinuxX86_64;
        assert!(matches_asset(port, windows, "EndlessSky-win64-v0.11.4.zip"));
        assert!(!matches_asset(
            port,
            windows,
            "EndlessSky-win32-v0.11.4.zip"
        ));
        assert!(!matches_asset(
            port,
            windows,
            "EndlessSky-v0.11.4-win64-setup.exe"
        ));
        assert!(!matches_asset(
            port,
            windows,
            "EndlessSky-win64-v0.11.4-debug.zip"
        ));
        assert!(matches_asset(
            port,
            linux,
            "Endless_Sky-v0.11.4-x86_64.AppImage"
        ));
        assert!(!matches_asset(
            port,
            linux,
            "Endless_Sky-v0.11.4-aarch64.AppImage"
        ));
    }
}
