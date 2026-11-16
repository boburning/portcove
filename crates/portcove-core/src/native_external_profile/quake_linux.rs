//! The reviewed Ironwail and vkQuake Linux package and data layouts.
use std::{fs, path::Path};

use crate::{ExternalProfilePolicy, Platform, PortDefinition, PortcoveError, Result};

pub(crate) const SPLIT_IRONWAIL_CAPABILITY: u32 = 39;

const IRONWAIL_TAR: [&str; 2] = ["ironwail-", "-linux-x64.tar.gz"];
const CLASSIC_ORIGINALS: &str = "quake-classic-pc-pak-set";
const IRONWAIL_SPLIT_ARGUMENTS: [&str; 5] = ["-basedir", "originals", "-basedir", ".", "-noaddons"];

pub(crate) fn uses_split_ironwail_originals(port: &PortDefinition) -> bool {
    port.external_profile_policy == Some(ExternalProfilePolicy::IronwailLinuxV1)
        && port.source_profile.as_deref() == Some(CLASSIC_ORIGINALS)
}

pub(crate) fn require_unshadowed_ironwail_originals(root: &Path) -> Result<()> {
    let data = root.join("id1");
    crate::path::refuse_symlink_ancestors(&data)?;
    let entries = match fs::read_dir(&data) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    for entry in entries {
        let name = entry?.file_name().to_string_lossy().to_ascii_lowercase();
        if matches!(name.as_str(), "pak0.pak" | "pak1.pak") {
            return Err(PortcoveError::conflict(
                "The Ironwail save folder already contains a Quake PAK. Keep this copy and its saves together, or use a separate library for verified setup.",
            ));
        }
    }
    Ok(())
}

pub(super) fn applies(policy: ExternalProfilePolicy) -> bool {
    matches!(
        policy,
        ExternalProfilePolicy::IronwailLinuxV1 | ExternalProfilePolicy::VkquakeLinuxV1
    )
}

pub(crate) fn requires_ironwail_tar(port: &PortDefinition, platform: Platform) -> bool {
    port.external_profile_policy == Some(ExternalProfilePolicy::IronwailLinuxV1)
        && platform == Platform::LinuxX86_64
}

pub(crate) fn matches_ironwail_tar(port: &PortDefinition, platform: Platform, name: &str) -> bool {
    !requires_ironwail_tar(port, platform)
        || crate::release::versioned_asset_name_matches(
            name,
            IRONWAIL_TAR[0],
            IRONWAIL_TAR[1],
            false,
        )
}

pub(super) fn validate(port: &PortDefinition, policy: ExternalProfilePolicy) -> Result<()> {
    let (id, repo, asset, executable, last_argument, persistent): (_, _, _, _, _, &[_]) =
        match policy {
            ExternalProfilePolicy::IronwailLinuxV1 => (
                "quake-ironwail",
                "andrei-drexler/ironwail",
                IRONWAIL_TAR,
                "ironwail",
                "-noaddons",
                &["id1", "history.txt"],
            ),
            ExternalProfilePolicy::VkquakeLinuxV1 => (
                "quake-vkquake",
                "Novum/vkQuake",
                ["vkquake-", "-x86_64.appimage"],
                "vkquake.AppImage",
                "-nosteam",
                &["id1", "vkQuake.cfg", "history.txt"],
            ),
            _ => unreachable!("only the reviewed Quake Linux policies are validated here"),
        };
    let source_and_arguments_match = if uses_split_ironwail_originals(port) {
        port.launch_arguments == IRONWAIL_SPLIT_ARGUMENTS
            && port.runtime_source_set.len() == 2
            && ["pak0.pak", "pak1.pak"].iter().all(|name| {
                port.runtime_source_set.iter().any(|target| {
                    target.source_filenames == [*name]
                        && target.destination == format!("originals/id1/{name}")
                        && target.materialization == crate::RuntimeSourceMaterialization::Copy
                })
            })
    } else {
        port.source_profile.is_none() && port.launch_arguments == ["-basedir", ".", last_argument]
    };
    let linux = Platform::LinuxX86_64;
    if port.id != id
        || !port.release.repository.eq_ignore_ascii_case(repo)
        || !port.platforms.contains(&linux)
        || port.channels != [crate::ReleaseChannel::Stable]
        || !source_and_arguments_match
        || port.persistent_paths != persistent
        || port
            .release
            .asset_hints
            .get(&linux)
            .is_none_or(|hints| hints != &asset)
        || port
            .executable_hints
            .get(&linux)
            .is_none_or(|hints| hints != &[executable])
    {
        return Err(PortcoveError::verification(
            "the Quake Linux profile guard requires its reviewed package, fixed launch and original-data paths",
        ));
    }
    Ok(())
}

pub(crate) fn require_payload(executable: &Path, policy: ExternalProfilePolicy) -> Result<()> {
    if policy == ExternalProfilePolicy::VkquakeLinuxV1 {
        return super::require_type2_appimage(executable);
    }
    super::read_amd64_elf_header(executable)?;
    let root = executable.parent().ok_or_else(|| {
        PortcoveError::verification("the Ironwail executable has no package folder")
    })?;
    crate::external_runtime::open_single_link_file(&root.join("ironwail.pak"))?;
    for entry in fs::read_dir(root)? {
        let name = entry?.file_name();
        if name.eq_ignore_ascii_case("id1") || name.eq_ignore_ascii_case("history.txt") {
            return Err(PortcoveError::verification(
                "the Ironwail archive unexpectedly contains a player-data path",
            ));
        }
    }
    Ok(())
}

#[cfg(target_os = "linux")]
pub(super) fn ironwail_profile_root(
    account: Option<&std::ffi::OsStr>,
    home: Option<&std::ffi::OsStr>,
) -> Result<std::path::PathBuf> {
    let base = super::require_absolute(account.or(home), "account home or HOME")?;
    let path = base.join(".ironwail");
    if path.as_os_str().len() >= 4096 - 50 {
        return Err(PortcoveError::launch(
            "The Ironwail profile path is too long for its game and save files. Use a shorter location.",
        ));
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Adapter;

    #[cfg(target_os = "linux")]
    #[test]
    fn quake_linux_ironwail_account_home_precedes_home_without_relocating_profiles() {
        use std::ffi::OsStr;

        let account = Some(OsStr::new("/accounts/player"));
        let fallback = Some(OsStr::new("/environment/player"));
        assert_eq!(
            ironwail_profile_root(account, fallback).unwrap(),
            Path::new("/accounts/player/.ironwail")
        );
        assert_eq!(
            ironwail_profile_root(None, fallback).unwrap(),
            Path::new("/environment/player/.ironwail")
        );
        assert!(ironwail_profile_root(Some(OsStr::new("relative")), fallback).is_err());
        assert!(ironwail_profile_root(None, Some(OsStr::new("relative"))).is_err());
    }

    #[test]
    fn quake_linux_policies_require_reviewed_flags_and_persistence() {
        let catalog = crate::Catalog::embedded().unwrap();
        for id in ["quake-ironwail", "quake-vkquake"] {
            let port = catalog.port(id).unwrap();
            let policy = port.external_profile_policy.unwrap();
            validate(port, policy).unwrap();
            assert!(!crate::native_external_profile::applies_to(
                policy,
                Platform::WindowsX86_64
            ));
            let mut changed = port.clone();
            changed.launch_arguments.push("-multiuser".into());
            assert!(validate(&changed, policy).is_err());
            let mut changed = port.clone();
            changed.persistent_paths.push(".vkquake".into());
            assert!(validate(&changed, policy).is_err());
        }
    }

    #[test]
    fn managed_ironwail_protects_its_verified_originals_from_writable_paks() {
        let catalog = crate::Catalog::embedded().unwrap();
        let port = catalog.port("quake-ironwail").unwrap();
        let retained = crate::test_fixture::retained_manual_ironwail_catalog();
        let old = retained.port("quake-ironwail").unwrap();
        assert!(uses_split_ironwail_originals(port));
        assert!(!uses_split_ironwail_originals(old));
        assert_eq!(port.persistent_paths, old.persistent_paths);
        assert_eq!(old.launch_arguments, ["-basedir", ".", "-noaddons"]);

        let temporary = tempfile::tempdir().unwrap();
        let saves = temporary.path().join("id1");
        fs::create_dir(&saves).unwrap();
        let slot = saves.join("slot.sav");
        fs::write(&slot, b"preserve this save").unwrap();
        require_unshadowed_ironwail_originals(temporary.path()).unwrap();
        let pak = saves.join("PAK0.PAK");
        fs::write(&pak, b"user original").unwrap();
        assert!(require_unshadowed_ironwail_originals(temporary.path()).is_err());
        assert_eq!(fs::read(pak).unwrap(), b"user original");
        assert_eq!(fs::read(slot).unwrap(), b"preserve this save");
    }

    #[test]
    fn quake_linux_vkquake_keeps_the_managed_working_folder() {
        let catalog = crate::Catalog::embedded().unwrap();
        let port = catalog.port("quake-vkquake").unwrap();
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let library = crate::Library::open(root.join("library")).unwrap();
        let install = root.join("player");
        fs::create_dir(&install).unwrap();
        let adapter = crate::adapter::standard(port.adapter);
        for (platform, name, arguments) in [
            (
                Platform::LinuxX86_64,
                "vkquake.AppImage",
                &["-basedir", ".", "-nosteam", "-userdir", "."][..],
            ),
            (
                Platform::WindowsX86_64,
                "vkQuake.exe",
                &["-basedir", ".", "-nosteam"][..],
            ),
        ] {
            let executable = install.join(name);
            fs::write(&executable, b"inert launcher").unwrap();
            let spec = adapter
                .launch_spec_with_executable(
                    crate::LaunchSpecRequest {
                        library: &library,
                        port,
                        platform,
                        install_root: &install,
                        selected_executable: &executable,
                        source: None,
                        source_record: None,
                        disc_progress: None,
                    },
                    &|| Ok(()),
                )
                .unwrap();
            assert_eq!(spec.arguments, arguments);
            assert_eq!(spec.working_directory, install);
        }
        assert!(!crate::process::is_reviewed_session_variable(
            "APPIMAGE_EXTRACT_AND_RUN"
        ));
        assert!(!crate::process::is_reviewed_session_variable("NO_CLEANUP"));
    }

    #[test]
    fn quake_linux_payload_requires_native_layout_and_unclaimed_originals() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let executable = root.join("ironwail");
        let policy = ExternalProfilePolicy::IronwailLinuxV1;
        let mut header = [0; 20];
        header[..6].copy_from_slice(b"\x7fELF\x02\x01");
        header[16..20].copy_from_slice(&[3, 0, 0x3e, 0]);
        fs::write(&executable, header).unwrap();
        assert!(require_payload(&executable, policy).is_err());
        fs::write(root.join("ironwail.pak"), b"fixture engine package").unwrap();
        require_payload(&executable, policy).unwrap();
        fs::create_dir(root.join("ID1")).unwrap();
        assert!(require_payload(&executable, policy).is_err());

        let policy = ExternalProfilePolicy::VkquakeLinuxV1;
        assert!(require_payload(&executable, policy).is_err());
        header[8..11].copy_from_slice(b"AI\x02");
        fs::write(&executable, header).unwrap();
        require_payload(&executable, policy).unwrap();
    }
}
