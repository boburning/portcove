//! Inert inspection of an exact reviewed Recomp wrapper. Results grant no
//! storage, activation or permission to load host libraries.
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File},
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{
    Platform, PortcoveError, RecompModHold, RecompModInspection, Result, inspect_recomp_mod,
    profile_deploy::sha256_file, zip_read,
};

pub(crate) const MAX_WRAPPER_BYTES: u64 = 256 * 1024 * 1024;
pub(crate) const MAX_MEMBER_BYTES: u64 = 64 * 1024 * 1024;
const LIMITS: zip_read::Limits = zip_read::Limits {
    bytes: MAX_WRAPPER_BYTES,
    entries: 256,
    metadata: 1024 * 1024,
    zip64: false,
    prefix: false,
};

#[derive(Clone, Copy)]
pub(crate) struct CompanionLayout {
    pub platform: Platform,
    /// Manifest-declared library stem and its exact same-folder dependencies.
    pub declared_library: &'static str,
    pub files: &'static [&'static str],
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ReviewedRecompCompanion {
    pub file_name: String,
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct RecompCompoundReview {
    pub platform: Platform,
    pub archive_sha256: String,
    pub archive_bytes: u64,
    pub mods: Vec<RecompModInspection>,
    pub companions: Vec<ReviewedRecompCompanion>,
}

fn invalid(reason: &str) -> PortcoveError {
    PortcoveError::verification(format!("Recomp wrapper review failed: {reason}"))
}

fn host_file(name: &str) -> bool {
    [
        ".dll", ".so", ".dylib", ".exe", ".com", ".bat", ".cmd", ".ps1", ".sh", ".msi", ".jar",
        ".scr", ".app",
    ]
    .iter()
    .any(|extension| name.ends_with(extension))
        || name.contains(".so.")
}

fn native_image_matches(file: &Path, platform: Platform) -> Result<bool> {
    let mut file = File::open(file)?;
    let mut header = [0u8; 64];
    file.read_exact(&mut header)?;
    match platform {
        Platform::WindowsX86_64 if &header[..2] == b"MZ" => {
            let offset = u32::from_le_bytes(header[60..64].try_into().unwrap());
            if !(64..=65_536).contains(&offset) {
                return Ok(false);
            }
            file.seek(SeekFrom::Start(u64::from(offset)))?;
            let mut pe = [0u8; 26];
            file.read_exact(&mut pe)?;
            let flags = u16::from_le_bytes(pe[22..24].try_into().unwrap());
            Ok(&pe[..6] == b"PE\0\0\x64\x86" && flags & 0x2000 != 0 && &pe[24..26] == b"\x0b\x02")
        }
        Platform::LinuxX86_64 => {
            Ok(&header[..7] == b"\x7fELF\x02\x01\x01" && &header[16..20] == b"\x03\0\x3e\0")
        }
        _ => Ok(false),
    }
}

pub(crate) struct StagedCompoundReview {
    pub review: RecompCompoundReview,
    pub wrapper: PathBuf,
    pub members: BTreeMap<String, PathBuf>,
    _directory: tempfile::TempDir,
}

#[cfg(test)]
pub(crate) fn review(
    path: &Path,
    archive_size: u64,
    expected_sha256: &str,
    game: &str,
    layout: CompanionLayout,
    all_layouts: &[CompanionLayout],
) -> Result<RecompCompoundReview> {
    Ok(stage(
        path,
        archive_size,
        expected_sha256,
        game,
        layout,
        all_layouts,
    )?
    .review)
}

pub(crate) fn stage(
    path: &Path,
    archive_size: u64,
    expected_sha256: &str,
    game: &str,
    layout: CompanionLayout,
    all_layouts: &[CompanionLayout],
) -> Result<StagedCompoundReview> {
    if !(1..=MAX_WRAPPER_BYTES).contains(&archive_size) || !fs::symlink_metadata(path)?.is_file() {
        return Err(invalid(
            "the source is outside the regular-file or size bound",
        ));
    }
    let directory = tempfile::tempdir()?;
    let wrapper = directory.path().join("exact-wrapper.zip");
    let mut snapshot = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&wrapper)?;
    let copied = std::io::copy(&mut File::open(path)?.take(archive_size + 1), &mut snapshot)?;
    drop(snapshot);
    if copied != archive_size || sha256_file(&wrapper)? != expected_sha256 {
        return Err(invalid(
            "the intact ZIP differs from the reviewed release asset",
        ));
    }
    let mut zip = zip_read::open(File::open(&wrapper)?, LIMITS, &mut |_| Ok(()))?;
    let mut names = BTreeSet::new();
    let mut native_ids = BTreeSet::new();
    let mut mods = Vec::new();
    let mut companions = Vec::new();
    let mut bytes = 0u64;
    let mut members = BTreeMap::new();
    for index in 0..zip.len() {
        let (name, size) = {
            let entry = zip
                .by_index_raw(index)
                .map_err(|_| invalid("unreadable entry"))?;
            if !entry.is_file()
                || entry.encrypted()
                || entry
                    .unix_mode()
                    .is_some_and(|mode| !matches!(mode & 0o170000, 0 | 0o100000))
            {
                return Err(invalid(
                    "the wrapper must contain regular, unencrypted files",
                ));
            }
            let name = entry
                .name()
                .map_err(|_| invalid("unreadable entry name"))?
                .into_owned();
            crate::archive::validate_relative_path(&name, false)?;
            if !crate::profile::valid_native_id(&name) || !names.insert(name.to_ascii_lowercase()) {
                return Err(invalid("unsafe or repeated member name"));
            }
            (name, entry.size())
        };
        let lower = name.to_ascii_lowercase();
        let is_mod = lower.ends_with(".nrm");
        let is_selected_companion = layout.files.contains(&name.as_str());
        if !is_mod && !is_selected_companion {
            if host_file(&lower)
                && !all_layouts
                    .iter()
                    .any(|other| other.files.contains(&name.as_str()))
            {
                return Err(invalid(
                    "the wrapper includes a host executable outside its reviewed layout",
                ));
            }
            continue;
        }
        bytes = bytes
            .checked_add(size)
            .filter(|total| *total <= MAX_WRAPPER_BYTES)
            .ok_or_else(|| invalid("the selected members exceed the expansion bound"))?;
        if !(1..=MAX_MEMBER_BYTES).contains(&size) {
            return Err(invalid("a selected member exceeds the file bound"));
        }
        let staged = directory.path().join(&name);
        let mut entry = zip
            .by_index(index)
            .map_err(|_| invalid("unreadable selected member"))?;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&staged)?;
        let written = std::io::copy(&mut (&mut entry).take(size + 1), &mut file)?;
        if written != size {
            return Err(invalid(
                "a selected member differs from its declared length",
            ));
        }
        drop(file);
        if is_mod {
            let inspection = inspect_recomp_mod(&staged, game)?;
            if inspection.holds.iter().any(|hold| {
                matches!(
                    hold,
                    RecompModHold::OtherGame | RecompModHold::HostExecutableFiles
                )
            }) || inspection
                .execution
                .contains(&crate::RecompExecution::ExternalCode)
                || inspection
                    .native_libraries
                    .keys()
                    .any(|name| name != layout.declared_library)
                || !native_ids.insert(inspection.native_id.clone())
            {
                return Err(invalid(
                    "a mod departs from the reviewed game, native identity or companion binding",
                ));
            }
            let name = format!("{}.nrm", inspection.native_id);
            if !crate::profile::valid_native_id(&name)
                || crate::archive::validate_relative_path(&name, false).is_err()
                || members.insert(name, staged).is_some()
            {
                return Err(invalid("the NRM cannot have a distinct stored identity"));
            }
            mods.push(inspection);
        } else {
            if !native_image_matches(&staged, layout.platform)? {
                return Err(invalid(
                    "a companion image does not match the reviewed platform",
                ));
            }
            companions.push(ReviewedRecompCompanion {
                file_name: name.clone(),
                bytes: size,
                sha256: sha256_file(&staged)?,
            });
            if members.insert(name, staged).is_some() {
                return Err(invalid("duplicate stored companion identity"));
            }
        }
    }
    if companions.len() != layout.files.len()
        || mods
            .iter()
            .filter(|m| m.native_libraries.contains_key(layout.declared_library))
            .count()
            != 1
    {
        return Err(invalid(
            "the wrapper lacks its exact companion set or has ambiguous ownership",
        ));
    }
    mods.sort_by(|a, b| a.native_id.cmp(&b.native_id));
    companions.sort_by(|a, b| a.file_name.cmp(&b.file_name));
    Ok(StagedCompoundReview {
        review: RecompCompoundReview {
            platform: layout.platform,
            archive_sha256: expected_sha256.into(),
            archive_bytes: archive_size,
            mods,
            companions,
        },
        wrapper,
        members,
        _directory: directory,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;

    #[test]
    fn recognized_header_requires_a_platform_library() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("candidate");
        let mut elf = [0u8; 64];
        elf[..7].copy_from_slice(b"\x7fELF\x02\x01\x01");
        elf[16..20].copy_from_slice(b"\x03\0\x3e\0");
        File::create(&file).unwrap().write_all(&elf).unwrap();
        assert!(native_image_matches(&file, Platform::LinuxX86_64).unwrap());
        assert!(!native_image_matches(&file, Platform::WindowsX86_64).unwrap());
        elf[18] = 183;
        File::create(&file).unwrap().write_all(&elf).unwrap();
        assert!(!native_image_matches(&file, Platform::LinuxX86_64).unwrap());
    }

    #[test]
    fn digest_mismatch_stops_before_archive_parsing() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("invalid.zip");
        fs::write(&file, b"not ZIP").unwrap();
        let layout = CompanionLayout {
            platform: Platform::LinuxX86_64,
            declared_library: "mod",
            files: &["mod.so"],
        };
        let error = review(&file, 7, &"0".repeat(64), "mm", layout, &[layout]).unwrap_err();
        assert!(
            error
                .message
                .contains("differs from the reviewed release asset")
        );
    }

    #[test]
    #[ignore = "natural-event observation, not ordinary coverage: requires the externally retained exact predecessor and successor wrapper ZIPs in PORTCOVE_GITHUB_MOD_ARCHIVES"]
    fn real_successor_changes_the_companion_set_without_changing_the_nrms() {
        let dir =
            std::path::PathBuf::from(std::env::var_os("PORTCOVE_GITHUB_MOD_ARCHIVES").unwrap());
        let layouts = [
            CompanionLayout {
                platform: Platform::WindowsX86_64,
                declared_library: "APCpp-Glue",
                files: &["APCpp-Glue.dll", "python311.dll"],
            },
            CompanionLayout {
                platform: Platform::LinuxX86_64,
                declared_library: "APCpp-Glue",
                files: &["APCpp-Glue.so", "libpython3.11.so.1.0"],
            },
        ];
        for layout in layouts {
            let old = review(
                &dir.join("319816241.zip"),
                23_814_109,
                "a7e360e1e01f680316803e729e23e75f54f4d4169b254a28338ba1dc7297ba84",
                "mm",
                layout,
                &layouts,
            )
            .unwrap();
            let new = review(
                &dir.join("337279656.zip"),
                23_239_098,
                "0725c897f7f04eaff8f40447da25a7eb0b0dd2b4e1b74d1919b5097f4157216a",
                "mm",
                layout,
                &layouts,
            )
            .unwrap();
            assert_eq!(old.mods, new.mods);
            assert_eq!(old.mods.len(), 6);
            assert_eq!(new.companions.len(), 2);
            assert_ne!(old.companions, new.companions);
        }
    }
}
