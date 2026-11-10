//! Validate the upstream-selected external roots without changing the child
//! environment, acquiring the profile, or treating it as Portcove data.
use std::{
    ffi::{OsStr, OsString},
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
    process::Command,
};

use crate::{
    AdapterKind, ExternalProfilePolicy, LaunchSpec, Library, Platform, PortDefinition,
    PortcoveError, ReleaseSource, Result,
};

pub(crate) mod archive_siblings;
pub(crate) mod openmohaa;
pub(crate) mod profile_siblings;
pub(crate) mod quake_linux;

fn read_amd64_elf_header(executable: &Path) -> Result<[u8; 20]> {
    let mut file = crate::external_runtime::open_single_link_file(executable)?;
    let mut header = [0; 20];
    file.read_exact(&mut header)?;
    if !header.starts_with(b"\x7fELF\x02\x01") || !matches!(&header[16..20], [2 | 3, 0, 0x3e, 0]) {
        return Err(PortcoveError::verification(
            "the package no longer contains the expected Linux x86-64 executable",
        ));
    }
    Ok(header)
}

fn require_type2_appimage(executable: &Path) -> Result<()> {
    let header = read_amd64_elf_header(executable)?;
    if &header[8..11] != b"AI\x02" {
        return Err(PortcoveError::verification(
            "the package is not a type-2 AppImage",
        ));
    }
    Ok(())
}

fn require_arm64_macho(executable: &Path, message: &str) -> Result<()> {
    let mut file = crate::external_runtime::open_single_link_file(executable)?;
    let mut header = [0; 16];
    file.read_exact(&mut header)?;
    if !header.starts_with(&[0xcf, 0xfa, 0xed, 0xfe, 12, 0, 0, 1]) || header[12..] != [2, 0, 0, 0] {
        return Err(PortcoveError::verification(message));
    }
    Ok(())
}

pub(crate) fn minimum_capability(policy: ExternalProfilePolicy) -> u32 {
    match policy {
        ExternalProfilePolicy::JgrppLinuxV1 | ExternalProfilePolicy::OpengladMacV1 => 17,
        ExternalProfilePolicy::CorsixthLinuxV1 | ExternalProfilePolicy::OpenlocoUnixV1 => 16,
        ExternalProfilePolicy::IronwailLinuxV1 | ExternalProfilePolicy::VkquakeLinuxV1 => 15,
        ExternalProfilePolicy::OpenmohaaUnixV1 => 13,
        ExternalProfilePolicy::RecompAppimageV1 => 12,
        ExternalProfilePolicy::Openrct2MacV1 => 11,
        ExternalProfilePolicy::DuneDynastyAllegroV1 | ExternalProfilePolicy::Fheroes2V1 => 9,
    }
}

pub(crate) fn applies_to(policy: ExternalProfilePolicy, platform: Platform) -> bool {
    match policy {
        ExternalProfilePolicy::Openrct2MacV1 => {
            matches!(platform, Platform::MacosX86_64 | Platform::MacosAarch64)
        }
        ExternalProfilePolicy::RecompAppimageV1 => platform == Platform::LinuxX86_64,
        ExternalProfilePolicy::OpenmohaaUnixV1 => openmohaa::applies_to(platform),
        ExternalProfilePolicy::IronwailLinuxV1 | ExternalProfilePolicy::VkquakeLinuxV1 => {
            platform == Platform::LinuxX86_64
        }
        ExternalProfilePolicy::CorsixthLinuxV1 | ExternalProfilePolicy::OpenlocoUnixV1 => {
            profile_siblings::applies_to(policy, platform)
        }
        ExternalProfilePolicy::JgrppLinuxV1 => platform == Platform::LinuxX86_64,
        ExternalProfilePolicy::OpengladMacV1 => platform == Platform::MacosAarch64,
        _ => true,
    }
}

pub(crate) fn validate(port: &PortDefinition) -> Result<()> {
    let Some(policy) = port.external_profile_policy else {
        return Ok(());
    };
    validate_layout(port, policy)
}

fn validate_layout(port: &PortDefinition, policy: ExternalProfilePolicy) -> Result<()> {
    let (identity, platforms): (_, &[_]) = match policy {
        ExternalProfilePolicy::DuneDynastyAllegroV1 => (
            Some(("dune-ii-dune-dynasty", "gameflorist/dunedynasty")),
            &[Platform::WindowsX86_64, Platform::LinuxX86_64],
        ),
        ExternalProfilePolicy::Fheroes2V1 => (
            Some(("heroes-of-might-and-magic-ii-fheroes2", "ihhub/fheroes2")),
            &[
                Platform::WindowsX86_64,
                Platform::LinuxX86_64,
                Platform::MacosX86_64,
            ],
        ),
        ExternalProfilePolicy::Openrct2MacV1 => (
            Some(("openrct2-openrct2", "OpenRCT2/OpenRCT2")),
            &[
                Platform::WindowsX86_64,
                Platform::LinuxX86_64,
                Platform::MacosX86_64,
                Platform::MacosAarch64,
            ],
        ),
        ExternalProfilePolicy::RecompAppimageV1 => {
            (None, &[Platform::WindowsX86_64, Platform::LinuxX86_64])
        }
        ExternalProfilePolicy::OpenmohaaUnixV1 => (
            None,
            &[
                Platform::WindowsX86_64,
                Platform::LinuxX86_64,
                Platform::MacosX86_64,
                Platform::MacosAarch64,
            ],
        ),
        ExternalProfilePolicy::IronwailLinuxV1
        | ExternalProfilePolicy::VkquakeLinuxV1
        | ExternalProfilePolicy::CorsixthLinuxV1 => {
            (None, &[Platform::WindowsX86_64, Platform::LinuxX86_64])
        }
        ExternalProfilePolicy::OpenlocoUnixV1 => (
            None,
            &[
                Platform::WindowsX86_64,
                Platform::LinuxX86_64,
                Platform::MacosAarch64,
            ],
        ),
        ExternalProfilePolicy::JgrppLinuxV1 => (
            Some(("jgrennison-openttd-patches", "JGRennison/OpenTTD-patches")),
            &[Platform::WindowsX86_64, Platform::LinuxX86_64],
        ),
        ExternalProfilePolicy::OpengladMacV1 => (
            Some(("gladiator-openglad", "openglad/openglad")),
            &[
                Platform::WindowsX86_64,
                Platform::LinuxX86_64,
                Platform::MacosAarch64,
            ],
        ),
    };
    if identity.is_some_and(|(id, repo)| {
        port.id != id || !port.release.repository.eq_ignore_ascii_case(repo)
    }) || port.adapter != AdapterKind::NativePortable
        || port.release.provider != ReleaseSource::Github
        || port
            .platforms
            .iter()
            .any(|platform| !platforms.contains(platform))
        || (!quake_linux::applies(policy) && !port.launch_arguments.is_empty())
        || !port.launch_environment.is_empty()
        || port.user_data_environment.is_some()
        || port.source_environment.is_some()
        || (!matches!(
            policy,
            ExternalProfilePolicy::RecompAppimageV1
                | ExternalProfilePolicy::OpenmohaaUnixV1
                | ExternalProfilePolicy::JgrppLinuxV1
        ) && !quake_linux::applies(policy)
            && !port.persistent_paths.is_empty())
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
    if policy == ExternalProfilePolicy::RecompAppimageV1 {
        validate_recomp_appimage_layout(port)?;
    }
    if policy == ExternalProfilePolicy::OpenmohaaUnixV1 {
        openmohaa::validate(port)?;
    }
    if quake_linux::applies(policy) {
        quake_linux::validate(port, policy)?;
    }
    if profile_siblings::applies(policy) {
        profile_siblings::validate(port, policy)?;
    }
    if archive_siblings::applies(policy) {
        archive_siblings::validate(port, policy)?;
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

fn appimage_stem(executable: &str) -> Option<&str> {
    let stem = executable.strip_suffix(".AppImage")?;
    (!stem.is_empty()
        && stem.len() <= 64
        && stem.as_bytes()[0].is_ascii_alphanumeric()
        && stem
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-'))
    .then_some(stem)
}

fn validate_recomp_appimage_layout(port: &PortDefinition) -> Result<()> {
    let linux = Platform::LinuxX86_64;
    let windows = Platform::WindowsX86_64;
    let valid = || {
        let [executable] = port.executable_hints.get(&linux)?.as_slice() else {
            return None;
        };
        let stem = appimage_stem(executable)?;
        let lower = stem.to_ascii_lowercase();
        let repository = port.release.repository.rsplit_once('/')?.1;
        (port.platforms.len() == 2
            && port.platforms.contains(&linux)
            && port.platforms.contains(&windows)
            && crate::definition_acquisition::valid_github_repository(&port.release.repository)
            && repository.eq_ignore_ascii_case(stem)
            && port.release.direct.is_empty()
            && port.release.curated.is_empty()
            && port.release.managed_build.is_empty()
            && port.release.user_prepared.is_empty()
            && !port.release.linux_tar_xz
            && port.release.asset_hints.get(&linux)?
                == &[format!("{lower}-"), "-linux-x86_64.appimage".to_owned()]
            && port.executable_hints.get(&windows)? == &[format!("{stem}.exe")]
            && port.persistent_paths == [format!("{lower}-data")])
        .then_some(())
    };
    valid().ok_or_else(|| {
        PortcoveError::verification(
            "the recomp AppImage profile requires the direct Linux package and its matching Windows fallback",
        )
    })
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
        ExternalProfilePolicy::Openrct2MacV1
        | ExternalProfilePolicy::RecompAppimageV1
        | ExternalProfilePolicy::OpenmohaaUnixV1
        | ExternalProfilePolicy::IronwailLinuxV1
        | ExternalProfilePolicy::VkquakeLinuxV1
        | ExternalProfilePolicy::CorsixthLinuxV1
        | ExternalProfilePolicy::OpenlocoUnixV1
        | ExternalProfilePolicy::JgrppLinuxV1
        | ExternalProfilePolicy::OpengladMacV1 => {
            return Err(PortcoveError::unsupported(
                "this profile uses a different upstream layout",
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

#[cfg(unix)]
fn unix_account_home() -> Result<Option<OsString>> {
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
            return Ok(None);
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
        #[cfg(unix)]
        (policy, platform) if archive_siblings::applies(policy) && applies_to(policy, platform) => {
            archive_siblings::profile_roots(policy, command)
        }
        #[cfg(unix)]
        (policy, platform) if profile_siblings::applies_to(policy, platform) => {
            Ok(vec![profile_siblings::profile_root(
                policy, platform, command,
            )?])
        }
        #[cfg(target_os = "linux")]
        (ExternalProfilePolicy::IronwailLinuxV1, Platform::LinuxX86_64) => {
            Ok(vec![quake_linux::ironwail_profile_root(
                unix_account_home()?.as_deref(),
                environment(command, "HOME").as_deref(),
            )?])
        }
        (ExternalProfilePolicy::VkquakeLinuxV1, Platform::LinuxX86_64) => Ok(Vec::new()),
        (ExternalProfilePolicy::OpenmohaaUnixV1, platform) if openmohaa::applies_to(platform) => {
            Ok(vec![openmohaa::profile_root(platform, command)?])
        }
        #[cfg(any(target_os = "macos", all(test, unix)))]
        (ExternalProfilePolicy::Openrct2MacV1, Platform::MacosX86_64 | Platform::MacosAarch64) => {
            Ok(vec![openrct2_mac_root(unix_account_home()?.as_deref())?])
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

#[cfg(target_os = "linux")]
fn require_appimage_layout(spec: &LaunchSpec) -> Result<&str> {
    let stem = spec
        .executable
        .file_name()
        .and_then(OsStr::to_str)
        .and_then(appimage_stem)
        .ok_or_else(|| PortcoveError::launch("the managed AppImage name changed"))?;
    if spec.executable.as_os_str().len() >= 4088 {
        return Err(PortcoveError::launch(
            "the AppImage executable path is too long",
        ));
    }
    // The AppImage runtime itself changes HOME and XDG_CONFIG_HOME when
    // these adjacent folders are writable. Refuse any form, including aliases.
    for suffix in [".home", ".config"] {
        let mut sibling = spec.executable.as_os_str().to_os_string();
        sibling.push(suffix);
        match fs::symlink_metadata(&sibling) {
            Ok(_) => {
                return Err(PortcoveError::launch(
                    "The AppImage has an adjacent portable profile. Preserve it and use a separate copy for that profile.",
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(stem)
}

#[cfg(target_os = "linux")]
fn recomp_appimage_roots(
    spec: &LaunchSpec,
    command: &Command,
    uid: u32,
) -> Result<(Vec<PathBuf>, PathBuf)> {
    let stem = require_appimage_layout(spec)?;
    let personal_base = |value: Option<&OsStr>, name| {
        let path = require_absolute(value, name)?;
        if path.parent().is_none() {
            return Err(PortcoveError::launch(format!(
                "{name} needs a personal AppImage profile location"
            )));
        }
        Ok(path)
    };
    let data = stem.to_ascii_lowercase();
    let home = environment(command, "HOME").filter(|value| !value.is_empty());
    let config = match environment(command, "XDG_CONFIG_HOME").filter(|value| !value.is_empty()) {
        Some(path) => personal_base(Some(&path), "XDG_CONFIG_HOME")?,
        None => personal_base(home.as_deref(), "HOME")?.join(".config"),
    };
    let state = match environment(command, "XDG_STATE_HOME").filter(|value| !value.is_empty()) {
        Some(path) => personal_base(Some(&path), "XDG_STATE_HOME")?,
        // AppRun substitutes /tmp for HOME. A shared .local hierarchy under
        // /tmp is not a personal state root.
        None => personal_base(home.as_deref(), "HOME")?.join(".local/state"),
    };
    Ok((
        vec![
            config.join(&data),
            state.join(&data),
            PathBuf::from("/tmp").join(format!("{data}-{uid}")),
        ],
        appimage_mount_root(command)?,
    ))
}

#[cfg(target_os = "linux")]
fn appimage_mount_root(command: &Command) -> Result<PathBuf> {
    // An explicitly empty TMPDIR would put the AppImage mount under "/".
    let temporary = environment(command, "TMPDIR");
    let temporary = require_absolute(
        Some(temporary.as_deref().unwrap_or(OsStr::new("/tmp"))),
        "TMPDIR",
    )?;
    if temporary.as_os_str().len() >= 4036 {
        return Err(PortcoveError::launch("the AppImage mount path is too long"));
    }
    Ok(temporary)
}

#[cfg(target_os = "linux")]
fn check_appimage_mount_root(temporary: &Path, uid: u32, owned: &[PathBuf]) -> Result<()> {
    check_appimage_directory(temporary, uid, true)?;
    let resolved = crate::path::resolve_existing_ancestor(temporary)?;
    if owned.iter().any(|root| resolved.starts_with(root)) {
        return Err(PortcoveError::launch(
            "The AppImage needs a temporary mount location outside the managed runtime.",
        ));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn check_appimage_directory(path: &Path, uid: u32, temporary: bool) -> Result<()> {
    use std::os::unix::fs::MetadataExt;

    let unsafe_path = || {
        PortcoveError::launch(
            "The AppImage needs a personal profile and a safe temporary mount location. Preserve any existing data and choose a location with safe ownership and permissions.",
        )
    };
    if path.parent().is_none() || path.components().any(|part| part == Component::ParentDir) {
        return Err(unsafe_path());
    }
    let mut child_exists = false;
    for (depth, ancestor) in path.ancestors().enumerate() {
        match fs::symlink_metadata(ancestor) {
            Ok(metadata) => {
                let owner = metadata.uid();
                // A sticky system directory can protect a child already
                // owned by the player, or a fresh mkdtemp mount name. It
                // cannot protect a predictable missing profile name.
                let safe_sticky = owner == 0
                    && metadata.mode() & 0o1000 != 0
                    && (child_exists || (depth == 0 && temporary));
                if !metadata.is_dir()
                    || (owner != 0 && owner != uid)
                    || (depth == 0 && !temporary && owner != uid)
                    || (metadata.mode() & 0o022 != 0 && !safe_sticky)
                {
                    return Err(unsafe_path());
                }
                child_exists = true;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if temporary {
                    return Err(unsafe_path());
                }
                child_exists = false;
            }
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn check_appimage_profile_entry(path: &Path, uid: u32) -> Result<()> {
    use std::os::unix::fs::MetadataExt;

    let entry = fs::symlink_metadata(path)?;
    if entry.uid() != uid || entry.mode() & 0o022 != 0 {
        return Err(PortcoveError::launch(
            "The AppImage profile contains a file or directory with unsafe ownership or permissions.",
        ));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn reserve_appimage_log_fallback(root: &Path, uid: u32) -> Result<()> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt};

    let unsafe_fallback = || {
        PortcoveError::launch(
            "The AppImage log fallback is not a safe user-owned directory. Preserve any existing files and use a separate copy until the directory is safe.",
        )
    };
    // AppRun uses a predictable fallback name. Reserve it atomically under
    // sticky /tmp, so another local account cannot claim an absent directory
    // between verification and the upstream mkdir.
    match fs::DirBuilder::new().mode(0o700).create(root) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.into()),
    }
    let directory = fs::symlink_metadata(root)?;
    if !directory.is_dir() || directory.uid() != uid || directory.mode() & 0o022 != 0 {
        return Err(unsafe_fallback());
    }
    match fs::symlink_metadata(root.join("appimage-launch.log")) {
        Ok(log)
            if !log.is_file()
                || log.uid() != uid
                || log.mode() & 0o022 != 0
                || log.nlink() != 1 =>
        {
            Err(unsafe_fallback())
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

#[cfg(target_os = "linux")]
pub(crate) fn reserve_recomp_appimage_fallback(spec: &LaunchSpec) -> Result<()> {
    use std::os::unix::fs::MetadataExt;

    let root = Path::new("/tmp");
    let parent = fs::symlink_metadata(root)?;
    if !parent.is_dir() || parent.uid() != 0 || parent.mode() & 0o1000 == 0 {
        return Err(PortcoveError::launch(
            "the AppImage needs a safe system /tmp",
        ));
    }
    let stem = spec
        .executable
        .file_name()
        .and_then(OsStr::to_str)
        .and_then(appimage_stem)
        .ok_or_else(|| PortcoveError::launch("the managed recomp AppImage name changed"))?
        .to_ascii_lowercase();
    // SAFETY: getuid does not take pointers or borrow process state.
    let uid = unsafe { libc::getuid() };
    reserve_appimage_log_fallback(&root.join(format!("{stem}-{uid}")), uid)
}

pub(crate) fn require_external_roots(
    policy: ExternalProfilePolicy,
    library: &Library,
    spec: &LaunchSpec,
    command: &Command,
    checkpoint: &impl Fn() -> Result<()>,
) -> Result<()> {
    let platform = Platform::current()?;
    #[cfg(target_os = "linux")]
    // SAFETY: getuid does not take pointers or borrow process state.
    let uid = unsafe { libc::getuid() };
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
    if policy == ExternalProfilePolicy::OpenmohaaUnixV1 {
        openmohaa::require_launch_paths(spec)?;
    }
    if archive_siblings::applies(policy) {
        archive_siblings::require_launch_layout(policy, spec, command, checkpoint)?;
    }
    let owned = library
        .output_roots()?
        .into_iter()
        .map(|record| record.path)
        .chain([library.versions_dir(), spec.install_root.clone()])
        .chain(
            (quake_linux::applies(policy)
                || profile_siblings::applies(policy)
                || archive_siblings::applies(policy)
                || matches!(
                    policy,
                    ExternalProfilePolicy::RecompAppimageV1
                        | ExternalProfilePolicy::OpenmohaaUnixV1
                ))
            .then(|| library.root().to_path_buf()),
        )
        .map(|path| crate::path::resolve_existing_ancestor(&path))
        .collect::<Result<Vec<_>>>()?;
    let profile_roots = if policy == ExternalProfilePolicy::RecompAppimageV1 {
        #[cfg(target_os = "linux")]
        {
            let (roots, temporary) = recomp_appimage_roots(spec, command, uid)?;
            checkpoint()?;
            check_appimage_mount_root(&temporary, uid, &owned)?;
            for root in &roots[..2] {
                checkpoint()?;
                check_appimage_directory(root, uid, false)?;
            }
            roots
        }
        #[cfg(not(target_os = "linux"))]
        return Err(PortcoveError::unsupported(
            "the recomp AppImage requires Linux",
        ));
    } else {
        #[cfg(target_os = "linux")]
        if policy == ExternalProfilePolicy::VkquakeLinuxV1
            || (platform == Platform::LinuxX86_64 && profile_siblings::applies(policy))
        {
            require_appimage_layout(spec)?;
            checkpoint()?;
            check_appimage_mount_root(&appimage_mount_root(command)?, uid, &owned)?;
        }
        roots(policy, platform, command)?
    };
    #[cfg(target_os = "linux")]
    if profile_siblings::applies(policy) && platform == Platform::LinuxX86_64 {
        for root in &profile_roots {
            checkpoint()?;
            check_appimage_directory(root, uid, false)?;
        }
    }
    let mut checked = Vec::new();
    for root in profile_roots {
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
                |path, _| {
                    checkpoint()?;
                    if policy == ExternalProfilePolicy::JgrppLinuxV1 {
                        archive_siblings::check_jgr_profile_plugin(&root, path)?;
                    }
                    #[cfg(target_os = "linux")]
                    if policy == ExternalProfilePolicy::RecompAppimageV1
                        || (platform == Platform::LinuxX86_64 && profile_siblings::applies(policy))
                    {
                        check_appimage_profile_entry(path, uid)?;
                    }
                    #[cfg(not(target_os = "linux"))]
                    let _ = path;
                    Ok(())
                },
            )?;
            checked.push(root);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ChildProcessClass, ChildProcessPolicy};

    #[cfg(target_os = "linux")]
    #[test]
    fn profile_siblings_hold_library_overlap_and_preserve_external_files() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let library = Library::open(root.join("library")).unwrap();
        let runtime = library.versions_dir().join("engine");
        fs::create_dir_all(&runtime).unwrap();
        let outside = root.join("settings");
        fs::create_dir(&outside).unwrap();
        for (policy, leaf) in [
            (ExternalProfilePolicy::CorsixthLinuxV1, "CorsixTH"),
            (ExternalProfilePolicy::OpenlocoUnixV1, "OpenLoco"),
        ] {
            let external = outside.join(leaf);
            fs::create_dir(&external).unwrap();
            let save = external.join("save");
            fs::write(&save, b"external save").unwrap();
            let spec = LaunchSpec {
                executable: runtime.join(format!("{leaf}.AppImage")),
                install_root: runtime.clone(),
                working_directory: runtime.clone(),
                environment: Default::default(),
                arguments: Vec::new(),
                fixed_arguments_only: true,
                launch_kind: crate::LaunchKind::Native,
            };
            let mut command = ChildProcessPolicy::game_command(&spec.process_spec(), &[]).unwrap();
            command
                .env("XDG_CONFIG_HOME", &outside)
                .env("TMPDIR", &root);
            require_external_roots(policy, &library, &spec, &command, &|| Ok(())).unwrap();
            command.env("XDG_CONFIG_HOME", library.root());
            assert!(require_external_roots(policy, &library, &spec, &command, &|| Ok(())).is_err());
            assert_eq!(fs::read(save).unwrap(), b"external save");
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn archive_siblings_guard_jgr_default_roots_without_touching_player_files() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let library = Library::open(root.join("library")).unwrap();
        let runtime = library.versions_dir().join("jgr");
        fs::create_dir_all(&runtime).unwrap();
        let data = root.join("data");
        let save = data.join("openttd/save/player.sav");
        fs::create_dir_all(save.parent().unwrap()).unwrap();
        fs::write(&save, b"external save").unwrap();
        let spec = LaunchSpec {
            executable: runtime.join("openttd"),
            install_root: runtime.clone(),
            working_directory: runtime,
            environment: Default::default(),
            arguments: vec!["-X".into()],
            fixed_arguments_only: true,
            launch_kind: crate::LaunchKind::Native,
        };
        let mut command = ChildProcessPolicy::game_command(&spec.process_spec(), &[]).unwrap();
        command
            .env("XDG_CONFIG_HOME", root.join("config"))
            .env("XDG_DATA_HOME", &data)
            .env_remove("LD_LIBRARY_PATH");
        let policy = ExternalProfilePolicy::JgrppLinuxV1;
        let check = |command: &Command| {
            require_external_roots(policy, &library, &spec, command, &|| Ok(()))
        };
        check(&command).unwrap();
        command.env("LD_LIBRARY_PATH", "/custom/libs");
        assert!(
            check(&command)
                .unwrap_err()
                .message
                .contains("LD_LIBRARY_PATH")
        );
        command.env_remove("LD_LIBRARY_PATH");

        let plugin = data.join("openttd/content_download/social_integration/user-social.so");
        fs::create_dir_all(plugin.parent().unwrap()).unwrap();
        fs::write(&plugin, b"external plugin").unwrap();
        assert!(
            check(&command)
                .unwrap_err()
                .message
                .contains("native social plugin")
        );
        assert_eq!(fs::read(&plugin).unwrap(), b"external plugin");
        command.env("XDG_DATA_HOME", library.root());
        assert!(check(&command).unwrap_err().message.contains("overlaps"));
        assert_eq!(fs::read(save).unwrap(), b"external save");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn quake_linux_appimage_refuses_portable_profiles_and_owned_mounts() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let spec = LaunchSpec {
            executable: root.join("vkquake.AppImage"),
            install_root: root.clone(),
            working_directory: root.clone(),
            environment: Default::default(),
            arguments: Vec::new(),
            fixed_arguments_only: true,
            launch_kind: crate::LaunchKind::Native,
        };
        assert_eq!(require_appimage_layout(&spec).unwrap(), "vkquake");
        let mut command = ChildProcessPolicy::game_command(&spec.process_spec(), &[]).unwrap();
        command.env("TMPDIR", "relative");
        assert!(appimage_mount_root(&command).is_err());
        command.env("TMPDIR", "");
        assert!(appimage_mount_root(&command).is_err());
        command.env("TMPDIR", &root);
        let mount = appimage_mount_root(&command).unwrap();
        // SAFETY: getuid does not take pointers or borrow process state.
        let uid = unsafe { libc::getuid() };
        check_appimage_mount_root(&mount, uid, &[]).unwrap();
        assert!(check_appimage_mount_root(&mount, uid, std::slice::from_ref(&root)).is_err());
        std::os::unix::fs::symlink(&root, root.join("vkquake.AppImage.home")).unwrap();
        assert!(require_appimage_layout(&spec).is_err());
    }

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
        let mut command =
            ChildProcessPolicy::native_command(ChildProcessClass::Game, "openrct2").unwrap();
        command.env("HOME", temporary.path());
        let observed = roots(
            ExternalProfilePolicy::Openrct2MacV1,
            Platform::MacosAarch64,
            &command,
        );
        match openrct2_mac_root(unix_account_home().unwrap().as_deref()) {
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
    fn recomp_appimage_layout_keeps_distinct_windows_fallbacks() {
        let catalog = crate::Catalog::embedded().unwrap();
        for (id, fallback) in [
            ("thatguymcd-glover-r", "glover-r-data"),
            ("rocket-robot-on-wheels-rocket-r", "rocket-r-data"),
        ] {
            let port = catalog.port(id).unwrap();
            let policy = port.external_profile_policy.unwrap();
            assert_eq!(policy, ExternalProfilePolicy::RecompAppimageV1);
            assert!(applies_to(policy, Platform::LinuxX86_64));
            assert!(!applies_to(policy, Platform::WindowsX86_64));
            assert_eq!(port.persistent_paths, [fallback]);
            validate(port).unwrap();

            let mut changed = port.clone();
            changed.persistent_paths.push("mods".into());
            assert!(validate(&changed).is_err());
            let mut changed = port.clone();
            changed
                .release
                .asset_hints
                .insert(Platform::LinuxX86_64, vec![".tar.gz".into()]);
            assert!(validate(&changed).is_err());
            let mut changed = port.clone();
            changed.platforms.retain(|p| *p == Platform::WindowsX86_64);
            assert!(validate(&changed).is_err());
            changed.external_profile_policy = None;
            assert_eq!(launch_policy(&changed, Some(port)), None);
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn recomp_appimage_profile_refuses_mount_and_portable_profile_overlap() {
        use std::os::unix::fs::PermissionsExt;

        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let runtime = library.versions_dir().join("glover").join("version");
        fs::create_dir_all(&runtime).unwrap();
        let stem = format!("Glover-R-{}", std::process::id());
        let data = stem.to_ascii_lowercase();
        let spec = LaunchSpec {
            executable: runtime.join(format!("{stem}.AppImage")),
            install_root: runtime.clone(),
            working_directory: runtime.clone(),
            environment: Default::default(),
            arguments: Vec::new(),
            fixed_arguments_only: true,
            launch_kind: crate::LaunchKind::Native,
        };
        let home = temporary.path().join("home");
        let mut command = ChildProcessPolicy::game_command(&spec.process_spec(), &[]).unwrap();
        command.env_clear().env("HOME", &home);
        let check = |command: &Command| {
            require_external_roots(
                ExternalProfilePolicy::RecompAppimageV1,
                &library,
                &spec,
                command,
                &|| Ok(()),
            )
        };
        assert_eq!(
            recomp_appimage_roots(&spec, &command, 123).unwrap(),
            (
                vec![
                    home.join(".config").join(&data),
                    home.join(".local/state").join(&data),
                    PathBuf::from("/tmp").join(format!("{data}-123")),
                ],
                PathBuf::from("/tmp"),
            )
        );
        check(&command).unwrap();
        for variable in ["XDG_CONFIG_HOME", "XDG_STATE_HOME", "TMPDIR"] {
            command.env(variable, &runtime);
            assert!(check(&command).is_err(), "{variable}");
            command.env(variable, "relative");
            assert!(check(&command).is_err(), "{variable}");
            command.env_remove(variable);
        }
        command.env("TMPDIR", "");
        assert!(check(&command).unwrap_err().message.contains("TMPDIR"));
        command.env_remove("TMPDIR");
        command.env("XDG_CONFIG_HOME", "").env("XDG_STATE_HOME", "");
        check(&command).unwrap();
        command.env("XDG_CONFIG_HOME", library.user_dir("thatguymcd-glover-r"));
        assert!(check(&command).unwrap_err().message.contains("overlaps"));
        command.env_remove("XDG_CONFIG_HOME");
        command
            .env_remove("HOME")
            .env("XDG_CONFIG_HOME", home.join("config"));
        assert!(check(&command).unwrap_err().message.contains("HOME"));
        command.env("HOME", &home).env_remove("XDG_CONFIG_HOME");
        command.env("HOME", "/");
        assert!(check(&command).unwrap_err().message.contains("personal"));
        command.env("HOME", &home);
        let unsafe_state = temporary.path().join("shared-state");
        fs::create_dir(&unsafe_state).unwrap();
        fs::set_permissions(&unsafe_state, fs::Permissions::from_mode(0o777)).unwrap();
        command.env("XDG_STATE_HOME", &unsafe_state);
        assert!(check(&command).unwrap_err().message.contains("ownership"));
        fs::set_permissions(&unsafe_state, fs::Permissions::from_mode(0o700)).unwrap();
        let state = unsafe_state.join(&data);
        fs::create_dir(&state).unwrap();
        let log = state.join("appimage-launch.log");
        fs::write(&log, b"keep primary").unwrap();
        fs::set_permissions(&log, fs::Permissions::from_mode(0o666)).unwrap();
        assert!(check(&command).unwrap_err().message.contains("ownership"));
        assert_eq!(fs::read(log).unwrap(), b"keep primary");
        command.env_remove("XDG_STATE_HOME");

        let alias = temporary.path().join("alias");
        std::os::unix::fs::symlink(&runtime, &alias).unwrap();
        command.env("TMPDIR", &alias);
        assert!(check(&command).is_err());
        command.env_remove("TMPDIR");
        let portable = runtime.join(format!("{stem}.AppImage.config"));
        fs::create_dir(&portable).unwrap();
        let save = portable.join("save");
        fs::write(&save, b"keep").unwrap();
        assert!(
            check(&command)
                .unwrap_err()
                .message
                .contains("portable profile")
        );
        assert_eq!(fs::read(save).unwrap(), b"keep");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn recomp_appimage_fallback_reservation_preserves_existing_data() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};

        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("fallback");
        let uid = fs::metadata(temporary.path()).unwrap().uid();
        reserve_appimage_log_fallback(&root, uid).unwrap();
        assert_eq!(fs::metadata(&root).unwrap().mode() & 0o077, 0);
        let log = root.join("appimage-launch.log");
        fs::write(&log, b"existing log").unwrap();
        reserve_appimage_log_fallback(&root, uid).unwrap();
        assert!(reserve_appimage_log_fallback(&root, uid ^ 1).is_err());
        fs::set_permissions(&root, fs::Permissions::from_mode(0o777)).unwrap();
        assert!(reserve_appimage_log_fallback(&root, uid).is_err());
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let alias = temporary.path().join("alias");
        fs::hard_link(&log, &alias).unwrap();
        assert!(reserve_appimage_log_fallback(&root, uid).is_err());
        assert_eq!(fs::read(alias).unwrap(), b"existing log");
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
        let mut command =
            ChildProcessPolicy::native_command(ChildProcessClass::Game, "inert-player").unwrap();
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
        let mut command =
            ChildProcessPolicy::native_command(ChildProcessClass::Game, "inert-player").unwrap();
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
        let mut command = ChildProcessPolicy::game_command(&spec.process_spec(), &[]).unwrap();
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
