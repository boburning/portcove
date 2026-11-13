use std::{fs, io::ErrorKind, path::Path};

use crate::{LaunchSpec, Platform, PortDefinition, PortcoveError, Result};

const ASSET: &str = "VCMI-Windows.zip";

pub(crate) fn requires_archive(port: &PortDefinition, platform: Platform) -> bool {
    port.external_profile_policy == Some(crate::ExternalProfilePolicy::VcmiWindowsV1)
        && platform == Platform::WindowsX86_64
}

pub(crate) fn matches_asset(port: &PortDefinition, platform: Platform, name: &str) -> bool {
    !requires_archive(port, platform) || name.eq_ignore_ascii_case(ASSET)
}

pub(super) fn validate(port: &PortDefinition) -> Result<()> {
    let windows = Platform::WindowsX86_64;
    if port.release.asset_hints.get(&windows).map(Vec::as_slice) != Some(&[ASSET.to_owned()][..])
        || port.executable_hints.get(&windows).map(Vec::as_slice)
            != Some(&["VCMI_client.exe".to_owned()][..])
        || !port.reviewed_package_layouts.contains_key(&windows)
    {
        return Err(PortcoveError::verification(
            "VCMI profile guard requires the official Windows ZIP, direct client and reviewed layout",
        ));
    }
    Ok(())
}

pub(super) fn require_default_paths(spec: &LaunchSpec) -> Result<()> {
    for path in [&spec.executable, &spec.working_directory] {
        // VCMI uses GetModuleFileNameW with a fixed MAX_PATH buffer.
        if crate::path::unicode(path, "VCMI runtime")?
            .encode_utf16()
            .count()
            >= 260
        {
            return Err(PortcoveError::launch("The VCMI runtime path is too long."));
        }
    }
    let root = spec
        .executable
        .parent()
        .ok_or_else(|| PortcoveError::launch("VCMI is missing its package directory."))?;
    if root != spec.working_directory {
        return Err(PortcoveError::launch(
            "VCMI must start in its package directory.",
        ));
    }
    require_no_path_overrides(root)
}

fn require_no_path_overrides(root: &Path) -> Result<()> {
    match fs::symlink_metadata(root.join("config/dirs.json")) {
        Ok(_) => Err(PortcoveError::launch(
            "VCMI has custom profile paths. Keep this profile with a separately prepared copy.",
        )),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

#[cfg(windows)]
pub(super) fn profile_root() -> Result<std::path::PathBuf> {
    use std::{ffi::OsString, os::windows::ffi::OsStringExt};
    use windows_sys::Win32::UI::Shell::{CSIDL_PERSONAL, SHGetSpecialFolderPathW};

    let mut buffer = [0_u16; 260];
    // SAFETY: the writable buffer has MAX_PATH units, and no window or
    // create flag is supplied. This matches the game's Documents lookup.
    let found = unsafe {
        SHGetSpecialFolderPathW(
            std::ptr::null_mut(),
            buffer.as_mut_ptr(),
            CSIDL_PERSONAL as i32,
            0,
        )
    };
    let end = buffer.iter().position(|value| *value == 0).unwrap_or(0);
    if found == 0 || end == 0 {
        return Err(PortcoveError::launch(
            "Windows could not resolve Documents for the VCMI profile.",
        ));
    }
    Ok(
        std::path::PathBuf::from(OsString::from_wide(&buffer[..end]))
            .join("My Games")
            .join("vcmi"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_exact_windows_archive_matches_the_managed_route() {
        let catalog = crate::Catalog::embedded().unwrap();
        let port = catalog.port("vcmi-vcmi").unwrap();
        assert!(matches_asset(port, Platform::WindowsX86_64, ASSET));
        assert!(!matches_asset(
            port,
            Platform::WindowsX86_64,
            "preview-VCMI-Windows.zip"
        ));
    }

    #[test]
    fn custom_directory_config_requires_a_separate_copy() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("config")).unwrap();
        require_no_path_overrides(root.path()).unwrap();
        let override_file = root.path().join("config/dirs.json");
        fs::write(&override_file, "{}").unwrap();
        assert!(require_no_path_overrides(root.path()).is_err());
        assert_eq!(fs::read_to_string(override_file).unwrap(), "{}");
    }
}
