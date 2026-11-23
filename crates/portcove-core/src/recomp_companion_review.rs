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

pub(crate) type CompanionLayout = crate::ModCompanionLayout;

impl CompanionLayout {
    fn names(&self, name: &str) -> bool {
        self.files.iter().any(|file| file == name)
    }
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
    layout: &CompanionLayout,
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
    layout: &CompanionLayout,
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
        let is_selected_companion = layout.names(&name);
        if !is_mod && !is_selected_companion {
            if host_file(&lower) && !all_layouts.iter().any(|other| other.names(&name)) {
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
                    .any(|name| *name != layout.declared_library)
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
            .filter(|m| m.native_libraries.contains_key(&layout.declared_library))
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

/// Synthetic compound wrappers for ordinary CI. Host images are minimal
/// headers only; nothing here is ever loaded.
#[cfg(test)]
pub(crate) mod fixtures {
    use std::io::Write as _;

    use super::*;

    pub(crate) const GAME: &str = "mm";
    pub(crate) const LIBRARY: &str = "Glue";
    pub(crate) fn layout(platform: Platform, library: &str, files: &[&str]) -> CompanionLayout {
        CompanionLayout {
            platform,
            declared_library: library.into(),
            files: files.iter().map(|file| (*file).into()).collect(),
        }
    }

    pub(crate) fn layouts() -> [CompanionLayout; 2] {
        [
            layout(Platform::WindowsX86_64, LIBRARY, &["Glue.dll", "dep.dll"]),
            layout(Platform::LinuxX86_64, LIBRARY, &["Glue.so", "libdep.so.1"]),
        ]
    }

    pub(crate) enum Entry<'a> {
        File(&'a str, Vec<u8>),
        Directory(&'a str),
        Symlink(&'a str, &'a str),
    }

    pub(crate) fn elf() -> Vec<u8> {
        let mut image = vec![0u8; 64];
        image[..7].copy_from_slice(b"\x7fELF\x02\x01\x01");
        image[16..20].copy_from_slice(b"\x03\0\x3e\0");
        image
    }

    pub(crate) fn pe() -> Vec<u8> {
        let mut image = vec![0u8; 90];
        image[..2].copy_from_slice(b"MZ");
        image[60..64].copy_from_slice(&64u32.to_le_bytes());
        image[64..70].copy_from_slice(b"PE\0\0\x64\x86");
        image[86..88].copy_from_slice(&0x2000u16.to_le_bytes());
        image[88..90].copy_from_slice(b"\x0b\x02");
        image
    }

    pub(crate) fn nrm(id: &str, game: &str, library: Option<&str>) -> Vec<u8> {
        let mut manifest = serde_json::json!({
            "game_id": game, "id": id, "display_name": id, "version": "1.0.0",
            "authors": ["someone"], "minimum_recomp_version": "1.2.0",
        });
        if let Some(library) = library {
            manifest["native_libraries"] = serde_json::json!({ library: ["entry"] });
        }
        zip_bytes(&[Entry::File(
            "mod.json",
            serde_json::to_vec(&manifest).unwrap(),
        )])
    }

    pub(crate) fn zip_bytes(entries: &[Entry<'_>]) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default();
        for entry in entries {
            match entry {
                Entry::File(name, bytes) => {
                    writer.start_file(*name, options).unwrap();
                    writer.write_all(bytes).unwrap();
                }
                Entry::Directory(name) => writer.add_directory(*name, options).unwrap(),
                Entry::Symlink(name, target) => {
                    writer.add_symlink(*name, *target, options).unwrap()
                }
            }
        }
        writer.finish().unwrap().into_inner()
    }

    /// The complete reviewed wrapper: two NRMs, both platform layouts and a
    /// harmless document.
    pub(crate) fn complete() -> Vec<Entry<'static>> {
        vec![
            Entry::File("Glue-Mod.nrm", nrm("glue_mod", GAME, Some(LIBRARY))),
            Entry::File("Plain.nrm", nrm("plain_mod", GAME, None)),
            Entry::File("Glue.dll", pe()),
            Entry::File("dep.dll", pe()),
            Entry::File("Glue.so", elf()),
            Entry::File("libdep.so.1", elf()),
            Entry::File("README.txt", b"read me".to_vec()),
        ]
    }

    pub(crate) struct Wrapper {
        pub path: PathBuf,
        pub bytes: u64,
        pub sha256: String,
        _directory: tempfile::TempDir,
    }

    pub(crate) fn write(entries: &[Entry<'_>]) -> Wrapper {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("wrapper.zip");
        fs::write(&path, zip_bytes(entries)).unwrap();
        Wrapper {
            bytes: fs::metadata(&path).unwrap().len(),
            sha256: sha256_file(&path).unwrap(),
            path,
            _directory: directory,
        }
    }

    pub(crate) fn stage_for(
        entries: &[Entry<'_>],
        layout: &CompanionLayout,
    ) -> Result<StagedCompoundReview> {
        let wrapper = write(entries);
        stage(
            &wrapper.path,
            wrapper.bytes,
            &wrapper.sha256,
            GAME,
            layout,
            &layouts(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fixtures::{Entry, GAME, elf, nrm, pe, stage_for};
    use std::io::Write as _;

    fn refusal(entries: &[Entry<'_>], layout: &CompanionLayout) -> String {
        match stage_for(entries, layout) {
            Ok(_) => panic!("the wrapper must be refused"),
            Err(error) => error.message,
        }
    }

    fn replacing(name: &str, entry: Entry<'static>) -> Vec<Entry<'static>> {
        fixtures::complete()
            .into_iter()
            .map(|existing| match &existing {
                Entry::File(current, _) if *current == name => match &entry {
                    Entry::File(new, bytes) => Entry::File(*new, bytes.clone()),
                    Entry::Directory(new) => Entry::Directory(*new),
                    Entry::Symlink(new, target) => Entry::Symlink(*new, *target),
                },
                _ => existing,
            })
            .collect()
    }

    #[test]
    fn synthetic_wrapper_stages_exact_members_for_each_reviewed_platform() {
        for layout in &fixtures::layouts() {
            let staged = stage_for(&fixtures::complete(), layout).unwrap();
            assert_eq!(staged.review.platform, layout.platform);
            assert_eq!(
                staged
                    .review
                    .mods
                    .iter()
                    .map(|item| item.native_id.as_str())
                    .collect::<Vec<_>>(),
                ["glue_mod", "plain_mod"]
            );
            let mut expected: Vec<_> = layout.files.iter().map(String::as_str).collect();
            expected.sort_unstable();
            assert_eq!(
                staged
                    .review
                    .companions
                    .iter()
                    .map(|item| item.file_name.as_str())
                    .collect::<Vec<_>>(),
                expected
            );
            let mut stored = vec!["glue_mod.nrm", "plain_mod.nrm"];
            stored.extend(layout.files.iter().map(String::as_str));
            stored.sort_unstable();
            assert_eq!(
                staged
                    .members
                    .keys()
                    .map(String::as_str)
                    .collect::<Vec<_>>(),
                stored
            );
            for (name, path) in &staged.members {
                assert!(path.is_file(), "{name}");
            }
            for companion in &staged.review.companions {
                assert_eq!(
                    sha256_file(&staged.members[&companion.file_name]).unwrap(),
                    companion.sha256
                );
            }
        }
    }

    #[test]
    fn synthetic_wrapper_refuses_non_regular_entries() {
        let layouts = fixtures::layouts();
        let linux = &layouts[1];
        let mut directory = fixtures::complete();
        directory.push(Entry::Directory("extras/"));
        assert!(refusal(&directory, linux).contains("regular, unencrypted files"));
        let mut symlink = fixtures::complete();
        symlink.push(Entry::Symlink("link.txt", "README.txt"));
        assert!(refusal(&symlink, linux).contains("regular, unencrypted files"));
        let linked_companion = replacing("libdep.so.1", Entry::Symlink("libdep.so.1", "Glue.so"));
        assert!(refusal(&linked_companion, linux).contains("regular, unencrypted files"));
    }

    #[test]
    fn synthetic_wrapper_refuses_unsafe_and_repeated_names() {
        let layouts = fixtures::layouts();
        let linux = &layouts[1];
        let mut nested = fixtures::complete();
        nested.push(Entry::File("docs/notes.txt", b"x".to_vec()));
        assert!(refusal(&nested, linux).contains("unsafe or repeated member name"));
        let mut escaping = fixtures::complete();
        escaping.push(Entry::File("../escape.txt", b"x".to_vec()));
        assert!(stage_for(&escaping, linux).is_err());
        let mut repeated = fixtures::complete();
        repeated.push(Entry::File("readme.TXT", b"x".to_vec()));
        assert!(refusal(&repeated, linux).contains("unsafe or repeated member name"));
    }

    #[test]
    fn synthetic_wrapper_refuses_host_executables_outside_every_layout() {
        for (name, image) in [
            ("tool.exe", pe()),
            ("helper.so", elf()),
            ("run.sh", b"#!".to_vec()),
        ] {
            let mut entries = fixtures::complete();
            entries.push(Entry::File(name, image));
            for layout in &fixtures::layouts() {
                assert!(
                    refusal(&entries, layout)
                        .contains("host executable outside its reviewed layout"),
                    "{name}"
                );
            }
        }
    }

    #[test]
    fn synthetic_wrapper_refuses_a_different_companion_set_or_owner() {
        let layouts = fixtures::layouts();
        let linux = &layouts[1];
        let missing = fixtures::complete()
            .into_iter()
            .filter(|entry| !matches!(entry, Entry::File("libdep.so.1", _)))
            .collect::<Vec<_>>();
        assert!(refusal(&missing, linux).contains("lacks its exact companion set"));
        let unowned = replacing(
            "Glue-Mod.nrm",
            Entry::File("Glue-Mod.nrm", nrm("glue_mod", GAME, None)),
        );
        assert!(refusal(&unowned, linux).contains("lacks its exact companion set"));
        let mut two_owners = fixtures::complete();
        two_owners.push(Entry::File(
            "Second.nrm",
            nrm("second_mod", GAME, Some(fixtures::LIBRARY)),
        ));
        assert!(refusal(&two_owners, linux).contains("ambiguous ownership"));
        let other_library = replacing(
            "Glue-Mod.nrm",
            Entry::File("Glue-Mod.nrm", nrm("glue_mod", GAME, Some("Other"))),
        );
        assert!(refusal(&other_library, linux).contains("companion binding"));
    }

    #[test]
    fn synthetic_wrapper_refuses_duplicate_identity_other_games_and_external_code() {
        let layouts = fixtures::layouts();
        let linux = &layouts[1];
        let mut duplicate = fixtures::complete();
        duplicate.push(Entry::File("Again.nrm", nrm("plain_mod", GAME, None)));
        assert!(refusal(&duplicate, linux).contains("native identity"));
        let other_game = replacing(
            "Plain.nrm",
            Entry::File("Plain.nrm", nrm("plain_mod", "bk", None)),
        );
        assert!(refusal(&other_game, linux).contains("reviewed game"));
        let offline = replacing(
            "Plain.nrm",
            Entry::File("Plain.offline.nrm", nrm("plain_mod", GAME, None)),
        );
        assert!(refusal(&offline, linux).contains("reviewed game"));
    }

    #[test]
    fn synthetic_wrapper_refuses_a_companion_image_for_another_platform() {
        let layouts = fixtures::layouts();
        let (windows, linux) = (&layouts[0], &layouts[1]);
        let windows_image_on_linux = replacing("Glue.so", Entry::File("Glue.so", pe()));
        assert!(refusal(&windows_image_on_linux, linux).contains("reviewed platform"));
        let linux_image_on_windows = replacing("dep.dll", Entry::File("dep.dll", elf()));
        assert!(refusal(&linux_image_on_windows, windows).contains("reviewed platform"));
        let short = replacing("Glue.dll", Entry::File("Glue.dll", b"MZ".to_vec()));
        assert!(stage_for(&short, windows).is_err());
    }

    #[test]
    fn synthetic_wrapper_refuses_changed_bytes_and_non_regular_sources() {
        let wrapper = fixtures::write(&fixtures::complete());
        let layouts = fixtures::layouts();
        let linux = &layouts[1];
        let error = stage(
            &wrapper.path,
            wrapper.bytes - 1,
            &wrapper.sha256,
            GAME,
            linux,
            &layouts,
        )
        .err()
        .unwrap();
        assert!(
            error
                .message
                .contains("differs from the reviewed release asset")
        );
        let directory = tempfile::tempdir().unwrap();
        let error = stage(
            directory.path(),
            wrapper.bytes,
            &wrapper.sha256,
            GAME,
            linux,
            &layouts,
        )
        .err()
        .unwrap();
        assert!(error.message.contains("regular-file or size bound"));
    }

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
        let layout = fixtures::layout(Platform::LinuxX86_64, "mod", &["mod.so"]);
        let error = review(
            &file,
            7,
            &"0".repeat(64),
            "mm",
            &layout,
            std::slice::from_ref(&layout),
        )
        .unwrap_err();
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
            fixtures::layout(
                Platform::WindowsX86_64,
                "APCpp-Glue",
                &["APCpp-Glue.dll", "python311.dll"],
            ),
            fixtures::layout(
                Platform::LinuxX86_64,
                "APCpp-Glue",
                &["APCpp-Glue.so", "libpython3.11.so.1.0"],
            ),
        ];
        for layout in &layouts {
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
