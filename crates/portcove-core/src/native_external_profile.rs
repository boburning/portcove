//! Validate the upstream-selected external roots without changing the child
//! environment, acquiring the profile, or treating it as Portcove data.
use std::{
    ffi::{OsStr, OsString},
    fs,
    path::{Component, Path, PathBuf},
    process::Command,
};

use crate::{
    AdapterKind, ExternalProfilePolicy, LaunchSpec, Library, Platform, PortDefinition,
    PortcoveError, ReleaseSource, Result,
};

pub(crate) fn minimum_capability(policy: ExternalProfilePolicy) -> u32 {
    match policy {
        ExternalProfilePolicy::Openrct2MacV1 => 11,
        ExternalProfilePolicy::DuneDynastyAllegroV1 | ExternalProfilePolicy::Fheroes2V1 => 9,
    }
}

pub(crate) fn applies_to(policy: ExternalProfilePolicy, platform: Platform) -> bool {
    policy != ExternalProfilePolicy::Openrct2MacV1
        || matches!(platform, Platform::MacosX86_64 | Platform::MacosAarch64)
}

pub(crate) fn validate(port: &PortDefinition) -> Result<()> {
    let Some(policy) = port.external_profile_policy else {
        return Ok(());
    };
    validate_layout(port, policy)
}

fn validate_layout(port: &PortDefinition, policy: ExternalProfilePolicy) -> Result<()> {
    let (id, repository, platforms): (_, _, &[_]) = match policy {
        ExternalProfilePolicy::DuneDynastyAllegroV1 => (
            "dune-ii-dune-dynasty",
            "gameflorist/dunedynasty",
            &[Platform::WindowsX86_64, Platform::LinuxX86_64],
        ),
        ExternalProfilePolicy::Fheroes2V1 => (
            "heroes-of-might-and-magic-ii-fheroes2",
            "ihhub/fheroes2",
            &[
                Platform::WindowsX86_64,
                Platform::LinuxX86_64,
                Platform::MacosX86_64,
            ],
        ),
        ExternalProfilePolicy::Openrct2MacV1 => (
            "openrct2-openrct2",
            "OpenRCT2/OpenRCT2",
            &[
                Platform::WindowsX86_64,
                Platform::LinuxX86_64,
                Platform::MacosX86_64,
                Platform::MacosAarch64,
            ],
        ),
    };
    if port.id != id
        || port.adapter != AdapterKind::NativePortable
        || port.release.provider != ReleaseSource::Github
        || !port.release.repository.eq_ignore_ascii_case(repository)
        || port
            .platforms
            .iter()
            .any(|platform| !platforms.contains(platform))
        || !port.launch_arguments.is_empty()
        || !port.launch_environment.is_empty()
        || port.user_data_environment.is_some()
        || port.source_environment.is_some()
        || !port.persistent_paths.is_empty()
        || !port.persistent_file_patterns.is_empty()
        || !port.runtime_mutable_paths.is_empty()
        || !port.runtime_mutable_file_patterns.is_empty()
        || !port.bundled_runtime.is_empty()
        || port.portable_marker
        || port.launch_from_install_root
        || port.runtime_subdirectory.is_some()
    {
        return Err(PortcoveError::verification(
            "external profiles require the reviewed upstream portable player and its external data layout",
        ));
    }
    if policy == ExternalProfilePolicy::Openrct2MacV1 {
        let mut mac_routes = port
            .platforms
            .iter()
            .copied()
            .filter(|&platform| applies_to(policy, platform))
            .peekable();
        if mac_routes.peek().is_none()
            || mac_routes.any(|platform| {
                port.executable_hints
                    .get(&platform)
                    .is_none_or(|hints| hints != &["OpenRCT2.app/Contents/MacOS/OpenRCT2"])
                    || port
                        .release
                        .asset_hints
                        .get(&platform)
                        .is_none_or(|hints| hints != &["openrct2-", "-macos-universal.zip"])
            })
        {
            return Err(PortcoveError::verification(
                "OpenRCT2 Mac profile guard requires the official universal bundle and its exact executable",
            ));
        }
    }
    Ok(())
}

pub(crate) fn launch_policy(
    retained: &PortDefinition,
    current: Option<&PortDefinition>,
) -> Option<ExternalProfilePolicy> {
    retained.external_profile_policy.or_else(|| {
        let policy = current?.external_profile_policy?;
        // Both previously offered managed routes were Windows-only. Apply the
        // current safety check to that exact older layout without recapturing it.
        (applies_to(policy, Platform::WindowsX86_64)
            && retained.platforms == [Platform::WindowsX86_64]
            && validate_layout(retained, policy).is_ok())
        .then_some(policy)
    })
}

fn require_absolute(value: Option<&OsStr>, name: &str) -> Result<PathBuf> {
    value
        .map(Path::new)
        .filter(|path| path.is_absolute())
        .map(Path::to_path_buf)
        .ok_or_else(|| {
            PortcoveError::launch(format!(
                "{name} does not resolve the game profile outside the managed runtime. Use an absolute personal profile location or a separately prepared copy."
            ))
        })
}

fn environment(command: &Command, name: &str) -> Option<OsString> {
    command
        .get_envs()
        .find(|(key, _)| crate::process::environment_names_equal(key, OsStr::new(name)))
        .and_then(|(_, value)| value)
        .map(OsStr::to_owned)
}

fn linux_root(
    command: &Command,
    policy: ExternalProfilePolicy,
    variable: &str,
    fallback: &str,
) -> Result<PathBuf> {
    let xdg = environment(command, variable);
    let home = || require_absolute(environment(command, "HOME").as_deref(), "HOME");
    let mut root = match xdg.as_deref() {
        Some(path)
            if policy == ExternalProfilePolicy::DuneDynastyAllegroV1
                && !path.is_empty()
                && !Path::new(path).is_absolute() =>
        {
            // Allegro rebases a nonempty relative XDG location against HOME.
            home()?.join(path)
        }
        Some(path) => require_absolute(Some(path), variable)?,
        None => home()?.join(fallback),
    };
    root.push(match policy {
        ExternalProfilePolicy::DuneDynastyAllegroV1 => "dunedynasty",
        ExternalProfilePolicy::Fheroes2V1 => "fheroes2",
        ExternalProfilePolicy::Openrct2MacV1 => {
            return Err(PortcoveError::unsupported(
                "OpenRCT2 profile guard is Mac-only",
            ));
        }
    });
    Ok(root)
}

#[cfg(any(target_os = "macos", test))]
fn openrct2_mac_root(account_home: Option<&OsStr>) -> Result<PathBuf> {
    // The profile prefers the real UID's passwd home. First Play can also
    // probe Steam through that record, so an absent record is unsafe even
    // when HOME could resolve the profile itself.
    let home = require_absolute(account_home, "OpenRCT2 account home")?;
    if home.parent().is_none() {
        return Err(PortcoveError::launch(
            "OpenRCT2 needs a personal profile outside the managed runtime",
        ));
    }
    Ok(home.join("Library/Application Support/OpenRCT2"))
}

#[cfg(any(target_os = "macos", all(test, unix)))]
fn macos_account_home() -> Result<Option<OsString>> {
    use std::{ffi::CStr, mem::MaybeUninit, os::unix::ffi::OsStrExt, ptr};

    let mut entry = MaybeUninit::<libc::passwd>::uninit();
    let mut found = ptr::null_mut();
    let mut buffer = vec![0_u8; 16 * 1024];
    // SAFETY: the storage and output pointer stay valid during lookup.
    // getpwuid_r uses the supplied buffer and does not borrow shared storage.
    let status = unsafe {
        libc::getpwuid_r(
            libc::getuid(),
            entry.as_mut_ptr(),
            buffer.as_mut_ptr().cast(),
            buffer.len(),
            &mut found,
        )
    };
    if status != 0 {
        return Err(std::io::Error::from_raw_os_error(status).into());
    }
    if found.is_null() {
        return Ok(None);
    }
    // SAFETY: a successful, nonempty lookup initialized entry, whose strings
    // live in buffer until copied here.
    let home = unsafe {
        let home = entry.assume_init().pw_dir;
        if home.is_null() {
            return Err(PortcoveError::launch(
                "OpenRCT2 account home is unavailable",
            ));
        }
        CStr::from_ptr(home)
    };
    Ok(Some(OsStr::from_bytes(home.to_bytes()).to_os_string()))
}

fn roots(
    policy: ExternalProfilePolicy,
    platform: Platform,
    command: &Command,
) -> Result<Vec<PathBuf>> {
    match (policy, platform) {
        #[cfg(any(target_os = "macos", all(test, unix)))]
        (ExternalProfilePolicy::Openrct2MacV1, Platform::MacosX86_64 | Platform::MacosAarch64) => {
            Ok(vec![openrct2_mac_root(macos_account_home()?.as_deref())?])
        }
        (_, Platform::LinuxX86_64) => Ok(vec![
            linux_root(command, policy, "XDG_CONFIG_HOME", ".config")?,
            linux_root(command, policy, "XDG_DATA_HOME", ".local/share")?,
        ]),
        (ExternalProfilePolicy::Fheroes2V1, Platform::WindowsX86_64) => {
            if let Some(home) = environment(command, "HOME") {
                return Ok(vec![
                    require_absolute(Some(&home), "HOME")?.join(".fheroes2"),
                ]);
            }
            Ok(vec![
                require_absolute(environment(command, "APPDATA").as_deref(), "APPDATA")?
                    .join("fheroes2"),
            ])
        }
        (ExternalProfilePolicy::Fheroes2V1, Platform::MacosX86_64) => Ok(vec![
            require_absolute(environment(command, "HOME").as_deref(), "HOME")?.join(".fheroes2"),
        ]),
        #[cfg(windows)]
        (ExternalProfilePolicy::DuneDynastyAllegroV1, Platform::WindowsX86_64) => Ok(vec![
            crate::external_runtime::shared_preferences::roaming_directory()?.join("Dune Dynasty"),
        ]),
        _ => Err(PortcoveError::unsupported(
            "this upstream profile layout is unavailable on the current platform",
        )),
    }
}

fn check_dune_path(path: &Path, platform: Platform) -> Result<()> {
    let path = crate::path::unicode(path, "Dune Dynasty path")?;
    // Leave room for the profile filenames and campaign save subdirectories.
    let supported = if platform == Platform::WindowsX86_64 {
        path.len() + 64 < 260 && path.bytes().all(|byte| (32..=126).contains(&byte))
    } else {
        path.len() + 512 < 1024
    };
    if !supported {
        return Err(PortcoveError::launch(
            "Dune Dynasty cannot safely represent this runtime or profile path. Use a shorter supported path or a separately prepared copy.",
        ));
    }
    Ok(())
}

pub(crate) fn require_external_roots(
    policy: ExternalProfilePolicy,
    library: &Library,
    spec: &LaunchSpec,
    command: &Command,
    checkpoint: &impl Fn() -> Result<()>,
) -> Result<()> {
    let platform = Platform::current()?;
    if policy == ExternalProfilePolicy::DuneDynastyAllegroV1 {
        check_dune_path(&spec.executable, platform)?;
        check_dune_path(&spec.working_directory, platform)?;
        // The managed package uses the selected executable directory as CWD.
        // A portable config takes precedence over Allegro's external profile.
        match fs::symlink_metadata(spec.working_directory.join("dunedynasty.cfg")) {
            Ok(_) => {
                return Err(PortcoveError::launch(
                    "Dune Dynasty found a portable config in its managed runtime. Preserve it with its player data and use a separately prepared copy for that profile.",
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    let owned = library
        .output_roots()?
        .into_iter()
        .map(|record| record.path)
        .chain([library.versions_dir(), spec.install_root.clone()])
        .map(|path| crate::path::resolve_existing_ancestor(&path))
        .collect::<Result<Vec<_>>>()?;
    let mut checked = Vec::new();
    for root in roots(policy, platform, command)? {
        checkpoint()?;
        if policy == ExternalProfilePolicy::DuneDynastyAllegroV1 {
            check_dune_path(&root, platform)?;
        }
        if !root.is_absolute() || root.components().any(|part| part == Component::ParentDir) {
            return Err(PortcoveError::launch(
                "The selected game profile has an ambiguous path. Use an absolute personal profile location or a separately prepared copy.",
            ));
        }
        let root = crate::path::resolve_existing_ancestor(&root)?;
        if owned
            .iter()
            .any(|path| root.starts_with(path) || path.starts_with(&root))
        {
            return Err(PortcoveError::launch(
                "The selected game profile overlaps a managed runtime location. Preserve the existing profile and use a location outside the runtime or a separately prepared copy.",
            ));
        }
        if !checked.contains(&root) {
            crate::external_runtime::shared_preferences::check_bounded_tree(
                &root,
                "game profile",
                |_, _| checkpoint(),
            )?;
            checked.push(root);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openrct2_mac_requires_an_absolute_account_home_for_the_profile_and_steam_probe() {
        let temporary = tempfile::tempdir().unwrap();
        let account = temporary.path().join("account");
        assert_eq!(
            openrct2_mac_root(Some(account.as_os_str())).unwrap(),
            account.join("Library/Application Support/OpenRCT2")
        );
        for unsafe_home in [None, Some(OsStr::new("")), Some(OsStr::new("relative"))] {
            assert!(openrct2_mac_root(unsafe_home).is_err());
        }
    }

    #[cfg(unix)]
    #[test]
    fn openrct2_mac_account_lookup_does_not_substitute_inherited_home() {
        let temporary = tempfile::tempdir().unwrap();
        let mut command = Command::new("openrct2");
        command.env("HOME", temporary.path());
        let observed = roots(
            ExternalProfilePolicy::Openrct2MacV1,
            Platform::MacosAarch64,
            &command,
        );
        match openrct2_mac_root(macos_account_home().unwrap().as_deref()) {
            Ok(expected) => assert_eq!(observed.unwrap(), [expected]),
            Err(_) => assert!(observed.is_err()),
        }
    }

    #[test]
    fn openrct2_profile_guard_covers_only_its_exact_mac_bundle() {
        let catalog = crate::Catalog::embedded().unwrap();
        let port = catalog.port("openrct2-openrct2").unwrap();
        let policy = port.external_profile_policy.unwrap();
        validate(port).unwrap();
        for platform in [Platform::WindowsX86_64, Platform::LinuxX86_64] {
            assert!(!applies_to(policy, platform));
        }
        for platform in [Platform::MacosX86_64, Platform::MacosAarch64] {
            assert!(applies_to(policy, platform));
            let mut changed = port.clone();
            changed
                .executable_hints
                .insert(platform, vec!["Other.app/Contents/MacOS/OpenRCT2".into()]);
            assert!(validate(&changed).is_err());
            let mut changed = port.clone();
            changed
                .release
                .asset_hints
                .insert(platform, vec![".dmg".into()]);
            assert!(validate(&changed).is_err());
        }
        let mut old = port.clone();
        old.platforms = vec![Platform::WindowsX86_64];
        old.external_profile_policy = None;
        assert_eq!(launch_policy(&old, Some(port)), None);
    }

    #[test]
    fn older_windows_contract_reuses_only_the_matching_current_guard() {
        let catalog = crate::Catalog::embedded().unwrap();
        let current = catalog.port("dune-ii-dune-dynasty").unwrap();
        let mut retained = current.clone();
        retained.external_profile_policy = None;
        retained.platforms = vec![Platform::WindowsX86_64];
        assert_eq!(
            launch_policy(&retained, Some(current)),
            current.external_profile_policy
        );
        assert_eq!(launch_policy(&retained, None), None);
        retained.launch_arguments.push("alternate-profile".into());
        assert_eq!(launch_policy(&retained, Some(current)), None);
    }

    #[test]
    fn linux_uses_the_engine_specific_relative_xdg_contract() {
        let temporary = tempfile::tempdir().unwrap();
        let home = temporary.path().join("home");
        let data = temporary.path().join("data");
        let mut command = Command::new("inert-player");
        command
            .env_clear()
            .env("HOME", &home)
            .env("XDG_CONFIG_HOME", "config")
            .env("XDG_DATA_HOME", &data);
        assert_eq!(
            roots(
                ExternalProfilePolicy::DuneDynastyAllegroV1,
                Platform::LinuxX86_64,
                &command,
            )
            .unwrap(),
            [home.join("config/dunedynasty"), data.join("dunedynasty")]
        );
        assert!(
            roots(
                ExternalProfilePolicy::Fheroes2V1,
                Platform::LinuxX86_64,
                &command
            )
            .unwrap_err()
            .message
            .contains("XDG_CONFIG_HOME")
        );
        command
            .env("HOME", "relative-home")
            .env("XDG_CONFIG_HOME", home.join("config"));
        assert_eq!(
            roots(
                ExternalProfilePolicy::Fheroes2V1,
                Platform::LinuxX86_64,
                &command
            )
            .unwrap(),
            [home.join("config/fheroes2"), data.join("fheroes2")]
        );
        command.env("XDG_DATA_HOME", "");
        assert!(
            roots(
                ExternalProfilePolicy::Fheroes2V1,
                Platform::LinuxX86_64,
                &command
            )
            .unwrap_err()
            .message
            .contains("XDG_DATA_HOME")
        );
        command.env_remove("XDG_DATA_HOME");
        assert!(
            roots(
                ExternalProfilePolicy::Fheroes2V1,
                Platform::LinuxX86_64,
                &command
            )
            .unwrap_err()
            .message
            .contains("HOME")
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_home_precedence_and_appdata_fallback_use_the_child_values() {
        let temporary = tempfile::tempdir().unwrap();
        let home = temporary.path().join("home");
        let appdata = temporary.path().join("roaming");
        let mut command = Command::new("inert-player");
        command
            .env_clear()
            .env("home", "relative-home")
            .env("APPDATA", &appdata);
        let resolved = |command: &Command| {
            roots(
                ExternalProfilePolicy::Fheroes2V1,
                Platform::WindowsX86_64,
                command,
            )
        };
        assert!(resolved(&command).unwrap_err().message.contains("HOME"));
        command.env("HOME", &home);
        assert_eq!(resolved(&command).unwrap(), [home.join(".fheroes2")]);
        command.env_remove("HOME");
        assert_eq!(resolved(&command).unwrap(), [appdata.join("fheroes2")]);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn managed_runtime_overlap_and_portable_config_hold_without_moving_data() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let runtime = library.versions_dir().join("synthetic").join("version");
        let home = temporary.path().join("home");
        fs::create_dir_all(&runtime).unwrap();
        fs::create_dir_all(&home).unwrap();
        let external_save = home.join("keep");
        fs::write(&external_save, b"external profile").unwrap();
        let spec = LaunchSpec {
            executable: runtime.join("inert-player"),
            install_root: runtime.clone(),
            working_directory: runtime.clone(),
            environment: Default::default(),
            arguments: Vec::new(),
            fixed_arguments_only: true,
            launch_kind: crate::LaunchKind::Native,
        };
        let catalog = crate::Catalog::embedded().unwrap();
        let dune = catalog.port("dune-ii-dune-dynasty").unwrap();
        let fheroes = catalog
            .port("heroes-of-might-and-magic-ii-fheroes2")
            .unwrap();
        assert!(dune.external_profile_policy.is_some());
        assert!(fheroes.external_profile_policy.is_some());
        let mut command = Command::new(&spec.executable);
        command.env_clear().env("HOME", &home);
        let dune = dune.external_profile_policy.unwrap();
        let fheroes = fheroes.external_profile_policy.unwrap();
        require_external_roots(dune, &library, &spec, &command, &|| Ok(())).unwrap();
        require_external_roots(fheroes, &library, &spec, &command, &|| Ok(())).unwrap();

        let alias = temporary.path().join("alias");
        std::os::unix::fs::symlink(&runtime, &alias).unwrap();
        command.env("XDG_DATA_HOME", alias.join("missing-profile"));
        assert!(
            require_external_roots(fheroes, &library, &spec, &command, &|| Ok(()))
                .unwrap_err()
                .message
                .contains("overlaps")
        );
        assert!(!runtime.join("missing-profile").exists());
        command.env_remove("XDG_DATA_HOME");
        let saves = home.join(".local/share/fheroes2/files");
        fs::create_dir_all(&saves).unwrap();
        let managed_file = runtime.join("original");
        fs::write(&managed_file, b"managed runtime").unwrap();
        let save = saves.join("save");
        std::os::unix::fs::symlink(&managed_file, &save).unwrap();
        assert!(require_external_roots(fheroes, &library, &spec, &command, &|| Ok(())).is_err());
        fs::remove_file(&save).unwrap();
        fs::hard_link(&managed_file, &save).unwrap();
        assert!(require_external_roots(fheroes, &library, &spec, &command, &|| Ok(())).is_err());
        assert_eq!(fs::read(&managed_file).unwrap(), b"managed runtime");
        let long_home = home
            .join("a".repeat(180))
            .join("b".repeat(180))
            .join("c".repeat(180));
        command.env("HOME", long_home);
        assert!(
            require_external_roots(dune, &library, &spec, &command, &|| Ok(()))
                .unwrap_err()
                .message
                .contains("cannot safely represent")
        );
        command.env("HOME", &home);
        let portable = runtime.join("dunedynasty.cfg");
        fs::write(&portable, b"existing portable config").unwrap();
        assert!(
            require_external_roots(dune, &library, &spec, &command, &|| Ok(()))
                .unwrap_err()
                .message
                .contains("portable config")
        );
        assert_eq!(fs::read(portable).unwrap(), b"existing portable config");
        assert_eq!(fs::read(external_save).unwrap(), b"external profile");
    }
}
