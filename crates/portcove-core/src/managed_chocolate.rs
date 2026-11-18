//! Closed Windows Chocolate profile preparation. Existing settings are never rewritten.
use std::{fs, io::Write, path::Path};

use crate::{ManagedInitialization, Platform, PortDefinition, PortcoveError, Result};

pub(crate) const CAPABILITY: u32 = 38;
const SEED: &[u8] = b"autoload_path \"autoload\"\nmusic_pack_path \"music-packs\"\n";
const LIMIT: u64 = 1024 * 1024;

pub(crate) fn applies(port: &PortDefinition) -> bool {
    port.managed_initialization == Some(ManagedInitialization::ChocolateFamilyPortableV1)
}

fn profile(port: &PortDefinition) -> Result<(&'static str, &'static str, &'static str)> {
    let hints = port.executable_hints.get(&Platform::WindowsX86_64);
    match hints.map(Vec::as_slice) {
        Some([name]) if name == "chocolate-doom.exe" => {
            Ok(("chocolate-doom.exe", "default.cfg", "chocolate-doom.cfg"))
        }
        Some([name]) if name == "chocolate-heretic.exe" => Ok((
            "chocolate-heretic.exe",
            "heretic.cfg",
            "chocolate-heretic.cfg",
        )),
        Some([name]) if name == "chocolate-hexen.exe" => {
            Ok(("chocolate-hexen.exe", "hexen.cfg", "chocolate-hexen.cfg"))
        }
        _ => Err(PortcoveError::verification(
            "Chocolate preparation requires a reviewed single-engine executable",
        )),
    }
}

fn screenshot_patterns(exe: &str) -> Vec<crate::PersistentFilePattern> {
    let prefix = match exe {
        "chocolate-doom.exe" => "DOOM",
        "chocolate-heretic.exe" => "HTIC",
        "chocolate-hexen.exe" => "HEXEN",
        _ => unreachable!("profile() restricts the executable"),
    };
    [".pcx", ".png"]
        .map(|suffix| crate::PersistentFilePattern {
            prefix: prefix.into(),
            suffix: suffix.into(),
            allow_empty_middle: false,
        })
        .to_vec()
}

pub(crate) fn validate(port: &PortDefinition) -> Result<()> {
    let (exe, main, extra) = profile(port)?;
    let expected_args = [
        "-iwad",
        "game.wad",
        "-config",
        main,
        "-extraconfig",
        extra,
        "-savedir",
        "savegames",
    ];
    let expected_asset = exe.trim_end_matches(".exe");
    if port.adapter != crate::AdapterKind::StagedSourcePortable
        || port.platforms != [Platform::WindowsX86_64]
        || port.release.provider != crate::ReleaseSource::Github
        || port.release.repository != "chocolate-doom/chocolate-doom"
        || port.release.asset_hints.get(&Platform::WindowsX86_64)
            != Some(&vec![expected_asset.to_string(), "win64.zip".into()])
        || port.source_profile.is_none()
        || port.runtime_source_filename.as_deref() != Some("game.wad")
        || port.runtime_source_materialization != Some(crate::RuntimeSourceMaterialization::Copy)
        || !port.runtime_source_set.is_empty()
        || !port.runtime_source_hashes.is_empty()
        || port.runtime_subdirectory.is_some()
        || !port.launch_from_install_root
        || port.launch_arguments != expected_args
        || port.source_environment.is_some()
        || port.user_data_environment.is_some()
        || !port.launch_environment.is_empty()
        || port.portable_marker
        || port.portable_marker_file.is_some()
        || port.managed_shared_preferences.is_some()
        || port.runtime_data_policy.is_some()
        || port.bios_source_profile.is_some()
        || !port.runtime_subdirectory_by_platform.is_empty()
        || !port.bundled_runtime.is_empty()
        || port.runtime_disc_image.is_some()
        || port.runtime_stfs_package.is_some()
        || port.runtime_rom_patch.is_some()
        || port.optional_game_source
        || !port.setup_executable_hints.is_empty()
        || !port.setup_arguments.is_empty()
        || port.setup_marker.is_some()
        || !port.setup_output_paths.is_empty()
        || port.external_profile_policy.is_some()
        || port.windows_tracked_handoff
        || port.windows_shipwright_persistence
        || port.linux_portable_data_directory.is_some()
        || port.n64_windows_initial_d3d12
        || port.n64_runtime_at_executable_parent
        || port.launch_disc_choice.is_some()
        || port.windows_runtime_path_policy
            != Some(crate::WindowsRuntimePathPolicy::RelativeFileMaxPath)
        || port.persistent_paths.len() != 6
        || port.persistent_file_patterns != screenshot_patterns(exe)
        || !port.runtime_mutable_file_patterns.is_empty()
        || port.mod_package_policy.is_some()
        || port.game_settings.is_some()
        || [
            "game.wad",
            main,
            extra,
            "savegames",
            "autoload",
            "music-packs",
        ]
        .iter()
        .any(|name| !port.persistent_paths.iter().any(|p| p == name))
    {
        return Err(PortcoveError::verification(
            "Chocolate preparation requires its fixed original, local profile and portable Windows package contract",
        ));
    }
    crate::managed_runtime_policy::validate_release_rules(port)
}

/// Match the upstream fscanf grammar conservatively. In particular, Unicode
/// whitespace and overlong records cannot disguise a second effective setting.
fn check_bytes(bytes: &[u8]) -> Result<()> {
    let bad = || {
        PortcoveError::verification(
            "Chocolate settings must retain local autoload and music-pack paths; preserve the file before selecting a compatible profile",
        )
    };
    if bytes.len() as u64 > LIMIT || bytes.contains(&0) {
        return Err(bad());
    }
    let text = std::str::from_utf8(bytes).map_err(|_| bad())?;
    let mut found = [false; 2];
    for line in text.split('\n') {
        // A long key/value can make fscanf resume in the middle of a record.
        if line.len() > 98 || line.bytes().any(|b| b < 32 && !matches!(b, b'\r' | b'\t')) {
            return Err(bad());
        }
        let line = line.trim_start_matches(|c: char| c.is_ascii_whitespace());
        if line.is_empty() {
            continue;
        }
        let Some(split) = line.find(|c: char| c.is_ascii_whitespace()) else {
            // fscanf can consume the next line as this key's value.
            return Err(bad());
        };
        let (key, value) = line.split_at(split);
        if key.len() > 79 {
            return Err(bad());
        }
        let value = value
            .trim_start_matches(|c: char| c.is_ascii_whitespace())
            .trim_end_matches('\r');
        if value.is_empty() {
            return Err(bad());
        }
        for (i, (name, expected)) in [
            ("autoload_path", "\"autoload\""),
            ("music_pack_path", "\"music-packs\""),
        ]
        .iter()
        .enumerate()
        {
            if key == *name {
                if found[i] || value != *expected {
                    return Err(bad());
                }
                found[i] = true;
            }
        }
    }
    if found != [true, true] {
        return Err(bad());
    }
    Ok(())
}

fn present(root: &Path, name: &str) -> Result<bool> {
    let path = root.join(name);
    crate::path::refuse_symlink_ancestors(&path)?;
    match fs::symlink_metadata(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e.into()),
        Ok(_) => {
            check_bytes(&crate::external_runtime::read_single_link_metadata(
                &path, LIMIT,
            )?)?;
            Ok(true)
        }
    }
}

/// Validate before copying the original or creating any profile file.
pub(crate) fn inspect(
    port: &PortDefinition,
    root: &Path,
    checkpoint: &dyn Fn() -> Result<()>,
) -> Result<()> {
    validate(port)?;
    let (_, main, extra) = profile(port)?;
    crate::path::refuse_symlink_ancestors(root)?;
    let names = [
        main,
        extra,
        "game.wad",
        "savegames",
        "autoload",
        "music-packs",
    ];
    let mut seen = std::collections::HashSet::new();
    for (index, entry) in fs::read_dir(root)?.enumerate() {
        checkpoint()?;
        if index >= 65_536 {
            return Err(PortcoveError::unsupported(
                "Chocolate runtime entry limit reached",
            ));
        }
        let entry = entry?;
        let name = entry.file_name();
        if let Some(name) = name.to_str()
            && names
                .iter()
                .any(|expected| name.eq_ignore_ascii_case(expected))
        {
            if !seen.insert(name.to_ascii_lowercase()) {
                return Err(PortcoveError::verification(
                    "Chocolate profile has ambiguous case aliases",
                ));
            }
            crate::path::refuse_symlink_ancestors(&entry.path())?;
        }
    }
    for name in [main, "game.wad"] {
        let path = root.join(name);
        match fs::symlink_metadata(&path) {
            Ok(_) => {
                drop(crate::external_runtime::open_single_link_file(&path)?);
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
    }
    for name in ["savegames", "autoload", "music-packs"] {
        let path = root.join(name);
        match fs::symlink_metadata(&path) {
            Ok(metadata) if !metadata.is_dir() => {
                return Err(PortcoveError::verification(
                    "Chocolate profile directory is occupied by another object",
                ));
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
        // These trees are game-writable, including title-created save and
        // autoload subdirectories. Never hand an existing link to the player.
        if path.is_dir() {
            check_tree(&path, checkpoint)?;
        }
    }
    present(root, extra)?;
    Ok(())
}

fn check_tree(root: &Path, checkpoint: &dyn Fn() -> Result<()>) -> Result<()> {
    let mut pending = vec![(root.to_path_buf(), 0_u32)];
    let mut entries = 0_u32;
    while let Some((directory, depth)) = pending.pop() {
        if depth > 64 {
            return Err(PortcoveError::unsupported(
                "Chocolate profile depth limit reached",
            ));
        }
        crate::path::refuse_symlink_ancestors(&directory)?;
        for entry in fs::read_dir(directory)? {
            checkpoint()?;
            entries += 1;
            if entries > 65_536 {
                return Err(PortcoveError::unsupported(
                    "Chocolate profile entry limit reached",
                ));
            }
            let entry = entry?;
            crate::path::refuse_symlink_ancestors(&entry.path())?;
            if entry.file_type()?.is_dir() {
                pending.push((entry.path(), depth + 1));
            } else {
                drop(crate::external_runtime::open_single_link_file(
                    &entry.path(),
                )?);
            }
        }
    }
    Ok(())
}

fn dataset(
    port: &PortDefinition,
    root: &Path,
    checkpoint: &dyn Fn() -> Result<()>,
) -> Result<Option<(String, u64)>> {
    checkpoint()?;
    match fs::symlink_metadata(root) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
        Ok(_) => {}
    }
    inspect(port, root, checkpoint)?;
    match fs::symlink_metadata(root.join("game.wad")) {
        Ok(_) => {
            return crate::external_runtime::hash_stable_regular(
                &root.join("game.wad"),
                128 * 1024 * 1024,
                checkpoint,
            )
            .map(Some);
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    let (_, main, extra) = profile(port)?;
    for name in [main, extra, "savegames", "autoload", "music-packs"] {
        let path = root.join(name);
        match fs::symlink_metadata(&path) {
            Ok(metadata) => {
                if !metadata.is_dir() || fs::read_dir(&path)?.next().transpose()?.is_some() {
                    return Err(PortcoveError::verification(
                        "Chocolate data has no matching IWAD; restore its original game.wad before continuing",
                    ));
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
    }
    Ok(None)
}

pub(crate) fn require_original(
    port: &PortDefinition,
    root: &Path,
    source: &crate::SourceRecord,
    checkpoint: &dyn Fn() -> Result<()>,
) -> Result<()> {
    if source.sha256 != source.storage_sha256 || source.size != source.storage_size {
        return Err(PortcoveError::verification(
            "Chocolate requires a complete raw IWAD original",
        ));
    }
    if let Some(actual) = dataset(port, root, checkpoint)?
        && actual != (source.sha256.clone(), source.size)
    {
        return Err(PortcoveError::verification(
            "This setup uses a different original game file; keep its data and select the matching original before playing",
        ));
    }
    Ok(())
}

/// Collection and ordinary restoration cannot merge datasets for different
/// originals. Profile markers do not grant replacement authority for this recipe.
pub(crate) fn require_compatible_data(
    port: &PortDefinition,
    user: &Path,
    runtime: &Path,
    checkpoint: &dyn Fn() -> Result<()>,
) -> Result<()> {
    let canonical = dataset(port, user, checkpoint)?;
    let installed = dataset(port, runtime, checkpoint)?;
    if let (Some(canonical), Some(installed)) = (canonical, installed)
        && canonical != installed
    {
        return Err(PortcoveError::verification(
            "Chocolate copies use different IWADs; preserve both datasets and restore the matching original before continuing",
        ));
    }
    Ok(())
}

pub(crate) fn arguments(
    port: &PortDefinition,
    root: &Path,
    checkpoint: &dyn Fn() -> Result<()>,
) -> Result<Vec<String>> {
    validate(port)?;
    let (sha256, _) = crate::external_runtime::hash_stable_regular(
        &root.join("game.wad"),
        128 * 1024 * 1024,
        checkpoint,
    )?;
    let mut arguments = port.launch_arguments.clone();
    // Each exact IWAD gets independent slots. The 74-byte relative directory
    // also leaves room for Hexen's map filenames in its 100-byte path buffer.
    arguments[7] = format!("savegames/{sha256}");
    crate::runtime_path_policy::check(
        port,
        Platform::WindowsX86_64,
        &root.join(&arguments[7]).join("hex99999.hxs"),
    )?;
    Ok(arguments)
}

pub(crate) fn check_spec(
    port: &PortDefinition,
    spec: &crate::LaunchSpec,
    checkpoint: &dyn Fn() -> Result<()>,
) -> Result<()> {
    validate(port)?;
    if spec.arguments != arguments(port, &spec.working_directory, checkpoint)?
        || spec.executable != spec.working_directory.join(profile(port)?.0)
    {
        return Err(PortcoveError::verification(
            "Chocolate requires its fixed local profile and original-file launch",
        ));
    }
    Ok(())
}

pub(crate) fn prepare(
    port: &PortDefinition,
    root: &Path,
    checkpoint: &dyn Fn() -> Result<()>,
) -> Result<()> {
    checkpoint()?;
    inspect(port, root, checkpoint)?;
    let (_, _, extra) = profile(port)?;
    if !present(root, extra)? {
        let mut staged = tempfile::NamedTempFile::new_in(root)?;
        staged.write_all(SEED)?;
        staged.as_file().sync_all()?;
        checkpoint()?;
        inspect(port, root, checkpoint)?;
        if !present(root, extra)? {
            if let Err(error) =
                crate::durability::rename_noreplace(staged.path(), &root.join(extra))
            {
                if !present(root, extra)? {
                    return Err(error);
                }
            }
            crate::durability::sync_publication(root)?;
        }
    }
    checkpoint()?;
    if !present(root, extra)? {
        return Err(PortcoveError::verification(
            "Chocolate profile changed during preparation",
        ));
    }
    let arguments = arguments(port, root, checkpoint)?;
    let saves = root.join(&arguments[7]);
    checkpoint()?;
    crate::path::refuse_symlink_ancestors(&saves)?;
    fs::create_dir_all(&saves)?;
    crate::path::refuse_symlink_ancestors(&saves)?;
    Ok(())
}

pub(crate) fn check(
    port: &PortDefinition,
    root: &Path,
    checkpoint: &dyn Fn() -> Result<()>,
) -> Result<()> {
    checkpoint()?;
    inspect(port, root, checkpoint)?;
    if !present(root, profile(port)?.2)? {
        return Err(PortcoveError::verification(
            "Chocolate profile requires preparation before Play",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(super) fn port() -> PortDefinition {
        serde_json::from_value(serde_json::json!({
            "id":"chocolate-profile-fixture", "name":"Chocolate fixture", "summary":"Synthetic profile contract",
            "project_url":"https://github.com/chocolate-doom/chocolate-doom", "support_tier":"beta",
            "channels":["stable"], "platforms":["windows-x86-64"], "adapter":"staged-source-portable",
            "release":{"provider":"github", "repository":"chocolate-doom/chocolate-doom",
                "asset_hints":{"windows-x86-64":["chocolate-doom","win64.zip"]}},
            "managed_initialization":"chocolate-family-portable-v1",
            "windows_runtime_path_policy":"relative-file-max-path",
            "source_profile":"synthetic-wad", "runtime_source_filename":"game.wad",
            "runtime_source_materialization":"copy", "launch_from_install_root":true,
            "executable_hints":{"windows-x86-64":["chocolate-doom.exe"]},
            "launch_arguments":["-iwad","game.wad","-config","default.cfg","-extraconfig","chocolate-doom.cfg","-savedir","savegames"],
            "persistent_paths":["game.wad","default.cfg","chocolate-doom.cfg","savegames","autoload","music-packs"]
            ,"persistent_file_patterns":[{"prefix":"DOOM","suffix":".pcx"},{"prefix":"DOOM","suffix":".png"}]
        })).unwrap()
    }

    #[test]
    fn fixed_recipe_seeds_missing_profile_and_preserves_existing_settings() {
        let root = tempfile::tempdir().unwrap();
        let port = port();
        fs::write(root.path().join("game.wad"), b"synthetic IWAD bytes").unwrap();
        prepare(&port, root.path(), &|| Ok(())).unwrap();
        assert_eq!(
            fs::read(root.path().join("chocolate-doom.cfg")).unwrap(),
            SEED
        );
        assert!(!root.path().join("settings.ini").exists());
        assert!(!root.path().join("DARKPILO.CFG").exists());
        let mut customized = b"screen_width 800\r\n".to_vec();
        customized.extend_from_slice(SEED);
        fs::write(root.path().join("chocolate-doom.cfg"), &customized).unwrap();
        fs::write(root.path().join("default.cfg"), b"player-owned config").unwrap();
        prepare(&port, root.path(), &|| Ok(())).unwrap();
        assert_eq!(
            fs::read(root.path().join("chocolate-doom.cfg")).unwrap(),
            customized
        );
        assert_eq!(
            fs::read(root.path().join("default.cfg")).unwrap(),
            b"player-owned config"
        );
        check(&port, root.path(), &|| Ok(())).unwrap();
    }

    #[test]
    fn relative_windows_paths_require_the_complete_closed_v38_recipe() {
        let mut port = port();
        crate::runtime_path_policy::validate(&port).unwrap();
        assert_eq!(
            crate::runtime_path_policy::minimum_capability(&port),
            CAPABILITY
        );
        port.managed_initialization = None;
        assert!(crate::runtime_path_policy::validate(&port).is_err());
        port.managed_initialization = Some(ManagedInitialization::ChocolateFamilyPortableV1);
        port.launch_arguments.push("-savedir".into());
        assert!(crate::runtime_path_policy::validate(&port).is_err());
    }

    #[test]
    fn upstream_configuration_grammar_cannot_hide_a_profile_escape() {
        for bytes in [
            b"".as_slice(),
            b"autoload_path \"\"\nmusic_pack_path \"music-packs\"\n",
            b"autoload_path \"../autoload\"\nmusic_pack_path \"music-packs\"\n",
            b"autoload_path \"autoload\"\nmusic_pack_path \"C:\\music\"\n",
            b"autoload_path \"autoload\"\nmusic_pack_path \"music-packs\"\nautoload_path \"outside\"\n",
            b"autoload_path\nmusic_pack_path \"music-packs\"\n",
            b"autoload_path \"autoload\"\nmusic_pack_path \"music-packs\"\0",
            b"\xc2\xa0autoload_path \"autoload\"\nmusic_pack_path \"music-packs\"\n",
        ] { assert!(check_bytes(bytes).is_err(), "accepted unsafe bytes: {bytes:?}"); }
        let mut overlong = SEED.to_vec();
        overlong.extend_from_slice(&[b'x'; 100]);
        assert!(check_bytes(&overlong).is_err());
    }

    fn original(bytes: &[u8]) -> crate::SourceRecord {
        use sha2::Digest;
        let sha256 = hex::encode(sha2::Sha256::digest(bytes));
        crate::SourceRecord {
            profile_id: "synthetic-wad".into(),
            path: "unused-fixture-path".into(),
            sha256: sha256.clone(),
            size: bytes.len() as u64,
            storage_sha256: sha256,
            storage_size: bytes.len() as u64,
            updated_at: 0,
            observed_identity: None,
        }
    }

    #[test]
    fn actual_iwad_bytes_guard_existing_saves_and_stale_copy_markers() {
        let root = tempfile::tempdir().unwrap();
        let port = port();
        fs::write(root.path().join("game.wad"), b"original A").unwrap();
        prepare(&port, root.path(), &|| Ok(())).unwrap();
        let args = arguments(&port, root.path(), &|| Ok(())).unwrap();
        assert_eq!(
            args[7],
            format!("savegames/{}", original(b"original A").sha256)
        );
        assert_eq!(args[7].len(), 74);
        fs::write(
            root.path().join(&args[7]).join("slot.dsg"),
            b"earned save A",
        )
        .unwrap();
        assert!(
            require_original(&port, root.path(), &original(b"original B"), &|| Ok(())).is_err()
        );
        assert_eq!(
            fs::read(root.path().join("game.wad")).unwrap(),
            b"original A"
        );
        assert_eq!(
            fs::read(root.path().join(&args[7]).join("slot.dsg")).unwrap(),
            b"earned save A"
        );
        fs::write(root.path().join("game.wad"), b"drifted IWAD").unwrap();
        assert!(
            require_original(&port, root.path(), &original(b"original A"), &|| Ok(())).is_err()
        );
        let changed_args = arguments(&port, root.path(), &|| Ok(())).unwrap();
        assert_ne!(changed_args[7], args[7]);
        fs::remove_file(root.path().join("game.wad")).unwrap();
        assert!(
            require_original(&port, root.path(), &original(b"original A"), &|| Ok(())).is_err()
        );
        assert!(arguments(&port, root.path(), &|| Ok(())).is_err());
    }

    #[test]
    fn collection_and_restore_refuse_to_merge_different_originals() {
        let user = tempfile::tempdir().unwrap();
        let runtime = tempfile::tempdir().unwrap();
        let port = port();
        fs::write(user.path().join("game.wad"), b"A").unwrap();
        fs::write(runtime.path().join("game.wad"), b"B").unwrap();
        assert!(require_compatible_data(&port, user.path(), runtime.path(), &|| Ok(())).is_err());
        assert_eq!(fs::read(user.path().join("game.wad")).unwrap(), b"A");
        assert_eq!(fs::read(runtime.path().join("game.wad")).unwrap(), b"B");
        fs::remove_file(user.path().join("game.wad")).unwrap();
        fs::create_dir(user.path().join("savegames")).unwrap();
        fs::write(
            user.path().join("savegames/slot.dsg"),
            b"save without its original",
        )
        .unwrap();
        assert!(require_compatible_data(&port, user.path(), runtime.path(), &|| Ok(())).is_err());
    }

    #[test]
    fn incompatible_existing_profile_is_held_without_modification() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("chocolate-doom.cfg");
        let bytes = b"autoload_path \"\"\nmusic_pack_path \"\"\n";
        fs::write(&path, bytes).unwrap();
        assert!(prepare(&port(), root.path(), &|| Ok(())).is_err());
        assert_eq!(fs::read(path).unwrap(), bytes);
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
    }

    #[test]
    fn cancellation_before_publication_leaves_no_seed_or_temporary_file() {
        let root = tempfile::tempdir().unwrap();
        let calls = std::cell::Cell::new(0);
        let result = prepare(&port(), root.path(), &|| {
            calls.set(calls.get() + 1);
            if calls.get() == 2 {
                Err(PortcoveError::new(
                    crate::ErrorCode::Cancelled,
                    "fixture cancelled",
                ))
            } else {
                Ok(())
            }
        });
        assert!(result.is_err());
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
    }

    #[test]
    fn racing_profile_is_preserved_and_checked_without_replacement() {
        let root = tempfile::tempdir().unwrap();
        let calls = std::cell::Cell::new(0);
        let bytes = b"autoload_path \"elsewhere\"\nmusic_pack_path \"music-packs\"\n";
        assert!(
            prepare(&port(), root.path(), &|| {
                calls.set(calls.get() + 1);
                if calls.get() == 2 {
                    fs::write(root.path().join("chocolate-doom.cfg"), bytes)?;
                }
                Ok(())
            })
            .is_err()
        );
        assert_eq!(
            fs::read(root.path().join("chocolate-doom.cfg")).unwrap(),
            bytes
        );
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
    }
}
