//! Keep OpenOMF's actual Linux AppImage profile outside replaceable runtimes.
use crate::{Platform, PortDefinition, PortcoveError, Result};

pub(crate) const NATIVE_CAPABILITY: u32 = 27;
const ASSET_HINTS: [&str; 2] = ["openomf-", "-x86_64.appimage"];

pub(super) fn validate(port: &PortDefinition) -> Result<()> {
    let linux = Platform::LinuxX86_64;
    let windows = Platform::WindowsX86_64;
    if !port.platforms.contains(&linux)
        || port.channels != [crate::ReleaseChannel::Stable]
        || port.source_profile.is_some()
        || !port.release.direct.is_empty()
        || !port.release.curated.is_empty()
        || !port.release.managed_build.is_empty()
        || !port.release.user_prepared.is_empty()
        || port.release.requires_tar_xz(linux)
        || port.release.archive_file_links
        || port
            .release
            .asset_hints
            .get(&linux)
            .is_none_or(|hints| hints != &ASSET_HINTS)
        || port
            .executable_hints
            .get(&linux)
            .is_none_or(|hints| hints != &["OpenOMF.AppImage"])
        || (port.platforms.contains(&windows)
            && (port
                .release
                .asset_hints
                .get(&windows)
                .is_none_or(|hints| hints != &["openomf_", "_windows.zip"])
                || port
                    .executable_hints
                    .get(&windows)
                    .is_none_or(|hints| hints != &["openomf.exe"])))
    {
        return Err(PortcoveError::verification(
            "OpenOMF requires its stable official AppImage and reviewed Windows sibling layout",
        ));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
mod linux {
    use std::{
        fs,
        path::{Path, PathBuf},
        process::Command,
    };

    use super::{PortcoveError, Result};
    use crate::LaunchSpec;
    use crate::external_runtime::{open_single_link_file, shared_preferences::check_bounded_tree};
    use crate::native_external_profile::{
        appimage_mount_root, check_appimage_directory, check_appimage_mount_root,
        check_appimage_profile_entry, environment, require_absolute, require_appimage_layout,
    };

    const OVERRIDES: [&str; 3] = [
        "OPENOMF_CONFIG_PATH",
        "OPENOMF_STATE_PATH",
        "OPENOMF_RESOURCE_PATH",
    ];
    const SYSTEM_RESOURCES: [&str; 4] = [
        "/usr/local/share/games",
        "/usr/share/games",
        "/usr/local/share",
        "/usr/share",
    ];
    const UPSTREAM_PATH_BYTES: usize = 255;
    // Screenshot and recording names use a 64-byte buffer in a child directory.
    const STATE_SUFFIX_BYTES: usize = 1 + "screenshot".len() + 1 + 63;
    // The AppImage adds a .mount_ name, then OpenOMF appends resource paths.
    // The observed package's longest relative resource path is 61 bytes.
    const APPIMAGE_SUFFIX_BYTES: usize = 128;

    fn require_path_length(path: &Path, suffix: usize) -> Result<()> {
        if path.as_os_str().as_encoded_bytes().len() > UPSTREAM_PATH_BYTES - suffix {
            return Err(PortcoveError::launch(
                "OpenOMF cannot represent this path. Use a shorter profile or AppImage mount location.",
            ));
        }
        Ok(())
    }

    fn preference_roots(command: &Command) -> Result<(PathBuf, PathBuf, Option<PathBuf>)> {
        let home = environment(command, "HOME")
            .map(|path| require_absolute(Some(&path), "HOME"))
            .transpose()?;
        let data = environment(command, "XDG_DATA_HOME")
            .map(|path| {
                // OpenOMF treats this as a resource search list. SDL treats it
                // as one directory. The managed route accepts the common case.
                if path.as_encoded_bytes().contains(&b':') {
                    return Err(PortcoveError::launch(
                        "OpenOMF needs a single absolute XDG_DATA_HOME for managed Play",
                    ));
                }
                require_absolute(Some(&path), "XDG_DATA_HOME")
            })
            .transpose()?;
        let preference = |name| -> Result<PathBuf> {
            if let Some(path) = environment(command, name) {
                return require_absolute(Some(&path), name);
            }
            // The bundled SDL 2.30 resolver uses XDG_DATA_HOME, then HOME.
            if let Some(path) = &data {
                return Ok(path.join("OpenOMF"));
            }
            let home = home.as_ref().ok_or_else(|| {
                PortcoveError::launch("OpenOMF needs HOME or XDG_DATA_HOME for its default profile")
            })?;
            Ok(home.join(".local/share/OpenOMF"))
        };
        Ok((
            preference("XDG_CONFIG_HOME")?,
            preference("XDG_STATE_HOME")?,
            data,
        ))
    }

    fn check_profile_root(root: &Path, uid: u32, owned: &[PathBuf]) -> Result<()> {
        check_appimage_directory(root, uid, false)?;
        let resolved = crate::path::resolve_existing_ancestor(root)?;
        if owned
            .iter()
            .any(|path| resolved.starts_with(path) || path.starts_with(&resolved))
        {
            return Err(PortcoveError::launch(
                "The OpenOMF profile overlaps a managed location. Preserve it and choose a location outside the runtime or use a separate copy.",
            ));
        }
        Ok(())
    }

    fn check_file(path: &Path, uid: u32) -> Result<()> {
        match fs::symlink_metadata(path) {
            Ok(_) => {
                check_appimage_profile_entry(path, uid)?;
                open_single_link_file(path)?;
                Ok(())
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
        }
    }

    fn check_writers(
        config: &Path,
        state: &Path,
        uid: u32,
        owned: &[PathBuf],
        checkpoint: &impl Fn() -> Result<()>,
    ) -> Result<()> {
        require_path_length(config, 1 + "openomf.conf".len())?;
        require_path_length(state, STATE_SUFFIX_BYTES)?;
        check_profile_root(config, uid, owned)?;
        if state != config {
            check_profile_root(state, uid, owned)?;
        }
        // An explicit XDG base may be shared with other applications. Only
        // inspect the OpenOMF leaves the player can write.
        check_file(&config.join("openomf.conf"), uid)?;
        for file in ["openomf.log", "SCORES.DAT"] {
            checkpoint()?;
            check_file(&state.join(file), uid)?;
        }
        for name in ["screenshot", "rec", "save", "mods"] {
            checkpoint()?;
            let directory = state.join(name);
            check_appimage_directory(&directory, uid, false)?;
            check_bounded_tree(&directory, "OpenOMF profile", |path, _| {
                checkpoint()?;
                require_path_length(path, 0)?;
                check_appimage_profile_entry(path, uid)
            })?;
        }
        Ok(())
    }

    fn check_resource_base(base: &Path, suffix: &str) -> Result<()> {
        require_path_length(base, 0)?;
        // The tagged resolver realpaths each search base before adding its
        // relative marker. Both copies need to fit the upstream buffer.
        let resolved = match fs::canonicalize(base) {
            Ok(path) => path,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.into()),
        };
        let marker = resolved.join(suffix).join("resources/openomf.bk");
        require_path_length(&marker, 0)?;
        match fs::metadata(&marker) {
            Ok(metadata) if metadata.is_file() => Err(PortcoveError::launch(
                "OpenOMF would load resources outside the managed AppImage. Keep that resource set with a separate copy.",
            )),
            Ok(_) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
        }
    }

    pub(in crate::native_external_profile) fn check_launch(
        spec: &LaunchSpec,
        command: &Command,
        uid: u32,
        owned: &[PathBuf],
        checkpoint: &impl Fn() -> Result<()>,
    ) -> Result<()> {
        if OVERRIDES
            .iter()
            .any(|name| std::env::var_os(name).is_some() || environment(command, name).is_some())
        {
            return Err(PortcoveError::launch(
                "OpenOMF has a custom profile or resource override. Keep it with a separate copy.",
            ));
        }
        let (config, state, data) = preference_roots(command)?;
        require_appimage_layout(spec)?;
        let temporary = appimage_mount_root(command)?;
        require_path_length(&temporary, APPIMAGE_SUFFIX_BYTES)?;
        check_appimage_mount_root(&temporary, uid, owned)?;
        if let Some(data) = data {
            check_resource_base(&data, "")?;
        }
        for root in SYSTEM_RESOURCES {
            checkpoint()?;
            check_resource_base(Path::new(root), "openomf")?;
        }
        check_writers(&config, &state, uid, owned, checkpoint)
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use crate::process::{ChildProcessClass, ChildProcessPolicy};
        use std::os::unix::fs::symlink;

        #[test]
        fn preferences_follow_openomf_and_sdl_precedence() {
            let temporary = tempfile::tempdir().unwrap();
            let home = temporary.path().join("home");
            let data_root = temporary.path().join("data");
            let settings = temporary.path().join("settings");
            let shared_state = temporary.path().join("shared-state");
            let mut command =
                ChildProcessPolicy::native_command(ChildProcessClass::Game, "OpenOMF.AppImage")
                    .unwrap();
            command.env_clear().env("HOME", &home);
            let fallback = home.join(".local/share/OpenOMF");
            let (config, state, data) = preference_roots(&command).unwrap();
            assert_eq!(config, fallback);
            assert_eq!(state, fallback);
            assert!(data.is_none());
            command
                .env("XDG_DATA_HOME", &data_root)
                .env("XDG_STATE_HOME", &shared_state);
            let (config, state, data) = preference_roots(&command).unwrap();
            assert_eq!(config, data_root.join("OpenOMF"));
            assert_eq!(state, shared_state);
            assert_eq!(data, Some(data_root.clone()));
            command.env("XDG_CONFIG_HOME", "relative");
            assert!(preference_roots(&command).is_err());
            command.env("XDG_CONFIG_HOME", settings).env(
                "XDG_DATA_HOME",
                format!("{}:{}", home.display(), data_root.display()),
            );
            assert!(preference_roots(&command).is_err());
            command.env_remove("XDG_DATA_HOME").env("HOME", "relative");
            assert!(preference_roots(&command).is_err());
        }

        #[test]
        fn writer_checks_scope_only_openomf_files_and_reject_aliases_and_overlap() {
            let temporary = tempfile::tempdir().unwrap();
            let root = temporary.path().canonicalize().unwrap();
            let config = root.join("config");
            let state = root.join("state");
            let managed = root.join("managed");
            for path in [&config, &state, &managed] {
                fs::create_dir(path).unwrap();
            }
            // SAFETY: getuid has no arguments and does not borrow process state.
            let uid = unsafe { libc::getuid() };
            let outside = config.join("another-app");
            symlink(&managed, &outside).unwrap();
            fs::write(config.join("openomf.conf"), b"keep").unwrap();
            let owned = [managed.clone()];
            check_writers(&config, &state, uid, &owned, &|| Ok(())).unwrap();
            assert_eq!(fs::read(config.join("openomf.conf")).unwrap(), b"keep");
            symlink(&managed, state.join("save")).unwrap();
            assert!(check_writers(&config, &state, uid, &owned, &|| Ok(())).is_err());
            assert!(check_writers(&config, &managed, uid, &owned, &|| Ok(())).is_err());
        }

        #[test]
        fn upstream_path_budget_and_resource_precedence_are_checked_before_launch() {
            let temporary = tempfile::tempdir().unwrap();
            let base = temporary.path();
            let resources = base.join("resources");
            fs::create_dir(&resources).unwrap();
            check_resource_base(base, "").unwrap();
            fs::write(resources.join("openomf.bk"), b"inert fixture").unwrap();
            assert!(check_resource_base(base, "").is_err());

            let long_base = base.join("x".repeat(120)).join("y".repeat(120));
            fs::create_dir_all(&long_base).unwrap();
            let alias = base.join("resource-alias");
            symlink(long_base, &alias).unwrap();
            assert!(check_resource_base(&alias, "").is_err());

            let long_path = base.join("x".repeat(UPSTREAM_PATH_BYTES - STATE_SUFFIX_BYTES));
            assert!(require_path_length(&long_path, STATE_SUFFIX_BYTES).is_err());
            let mounted = base.join("x".repeat(UPSTREAM_PATH_BYTES - APPIMAGE_SUFFIX_BYTES));
            assert!(require_path_length(&mounted, APPIMAGE_SUFFIX_BYTES).is_err());
        }
    }
}

#[cfg(target_os = "linux")]
pub(super) use linux::check_launch;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn managed_openomf_retains_windows_and_selects_compatible_linux_appimages() {
        let catalog = crate::Catalog::embedded().unwrap();
        let port = catalog.port("omf2097-openomf").unwrap();
        let linux = Platform::LinuxX86_64;
        let windows = Platform::WindowsX86_64;
        validate(port).unwrap();
        let appimage = crate::release::native_appimage(port, linux).unwrap();
        assert!(appimage.matches("OpenOMF-0.8.6-x86_64.AppImage"));
        assert!(appimage.matches("OpenOMF-0.8.7-x86_64.AppImage"));
        assert!(!appimage.matches("OpenOMF-0.8.7-ARM64.AppImage"));
        assert!(!appimage.matches("OpenOMF-0.8.7-x86_64.tar.gz"));
        assert!(crate::release::native_appimage(port, windows).is_none());
        assert_eq!(port.executable_hints[&windows], ["openomf.exe"]);
        assert_eq!(
            port.release.asset_hints[&windows],
            ["openomf_", "_windows.zip"]
        );
        let mut changed = port.clone();
        changed.release.asset_hints.get_mut(&linux).unwrap()[0] = "other-".into();
        assert!(validate(&changed).is_err());
    }
}
