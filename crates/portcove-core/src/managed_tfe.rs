//! Closed TFE 1.22.420 initialization. Never imports or replaces player state.
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

use crate::{PortcoveError, Result};

const SETTINGS: &[u8] = b"[Game]\ngame=\"Dark Forces\"\n[Dark_Forces]\nsourcePath=\"GameData/\"\n";
const PILOT_SIZE: usize = 14_943;
const PILOT_HEADER: &[u8] = &[0x50, 0x43, 0x46, 0x12, 0x0e];

pub(crate) fn validate(port: &crate::PortDefinition) -> Result<()> {
    if port.managed_initialization.is_none() {
        return Ok(());
    }
    let exact_release = port
        .release
        .direct
        .get(&crate::Platform::WindowsX86_64)
        .is_some_and(|release| {
            release.version == "1.22.420"
                && release.size == 10_561_878
                && release.sha256
                    == "30ee44b296f18273842c50c2db5d5e5dccb2bba278d4909881273737f90c4eac"
        });
    let sources = port
        .runtime_source_set
        .iter()
        .filter_map(|target| {
            let [path] = target.source_filenames.as_slice() else {
                return None;
            };
            Some(path.as_str())
        })
        .collect::<std::collections::BTreeSet<_>>();
    if !exact_release
        || port.adapter != crate::AdapterKind::StagedSourcePortable
        || port.release.provider != crate::ReleaseSource::DirectManifest
        || port.platforms != [crate::Platform::WindowsX86_64]
        || !port.release.user_prepared.is_empty()
        || port.runtime_subdirectory.is_some()
        || port.source_environment.is_some()
        || port.user_data_environment.is_some()
        || !port.launch_environment.is_empty()
        || !port.launch_arguments.is_empty()
        || !port.launch_from_install_root
        || !port
            .runtime_mutable_paths
            .iter()
            .any(|path| path == ".tfe-preparation")
        || port.runtime_source_filename.is_some()
        || port.runtime_source_materialization.is_some()
        || port.runtime_source_set.len() != 48
        || port.runtime_source_hashes.len() != 48
        || sources.len() != 48
        || ["DARK.GOB", "SOUNDS.GOB", "SPRITES.GOB", "TEXTURES.GOB"]
            .iter()
            .any(|name| !sources.contains(name))
        || sources
            .iter()
            .filter(|name| name.starts_with("LFD/"))
            .count()
            != 44
        || port.runtime_source_set.iter().any(|target| {
            let [path] = target.source_filenames.as_slice() else {
                return true;
            };
            let permitted = ["DARK.GOB", "SOUNDS.GOB", "SPRITES.GOB", "TEXTURES.GOB"]
                .contains(&path.as_str())
                || (path.starts_with("LFD/")
                    && path.ends_with(".LFD")
                    && path.split('/').count() == 2);
            !permitted
                || target.destination != format!("GameData/{path}")
                || target.materialization != crate::RuntimeSourceMaterialization::Copy
        })
        || port
            .executable_hints
            .get(&crate::Platform::WindowsX86_64)
            .is_none_or(|hints| hints != &["TheForceEngine.exe"])
        || ["settings.ini", "DARKPILO.CFG"]
            .iter()
            .any(|name| !port.persistent_paths.iter().any(|path| path == name))
    {
        return Err(PortcoveError::usage(
            "managed TFE initialization requires the exact reviewed Windows engine and portable no-argument route",
        ));
    }
    Ok(())
}

pub(crate) fn staging_root(directory: &Path) -> Result<PathBuf> {
    let root = directory.join(".tfe-preparation");
    crate::path::refuse_symlink_ancestors(&root)?;
    fs::create_dir_all(&root)?;
    crate::path::refuse_symlink_ancestors(&root)?;
    if fs::read_dir(&root)?.take(17).count() > 16 {
        return Err(PortcoveError::conflict(
            "TFE has retained temporary preparation data; close the game and preserve .tfe-preparation outside the installation before retrying",
        ).with_mutation_state(crate::MutationState::RecoveryRequired)
            .with_known_cause(crate::failure::KnownFailureCause::TfePreparationRecovery { directory: root.clone() })
            .detail("recovery_directory", root.display().to_string()));
    }
    Ok(root)
}

/// Deletion protection is rediscovered from the fixed recovery namespace, even
/// after an install's record is removed or its current catalog entry changes.
/// Presence can only refuse deletion; it never grants ownership or authority.
pub(crate) fn require_no_recovery_data(directory: &Path) -> Result<()> {
    let root = directory.join(".tfe-preparation");
    let held = || {
        PortcoveError::conflict(
        "TFE preparation recovery data must be preserved before removal. Close the game, move the indicated .tfe-preparation directory outside all Portcove installation and recovery folders, verify the preserved files, then review removal again. Portcove will not delete these copies automatically.",
    ).with_mutation_state(crate::MutationState::RecoveryRequired)
        .with_known_cause(crate::failure::KnownFailureCause::TfePreparationRecovery { directory: root.clone() })
        .detail("recovery_directory", root.display().to_string())
    };
    crate::path::refuse_symlink_ancestors(&root)
        .map_err(|error| held().detail("recovery_problem", error.message))?;
    let metadata = match fs::symlink_metadata(&root) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(held().detail("recovery_problem", error.to_string())),
        Ok(metadata) => metadata,
    };
    if !metadata.is_dir()
        || fs::read_dir(&root)
            .and_then(|mut entries| entries.next().transpose())
            .map_err(|error| held().detail("recovery_problem", error.to_string()))?
            .is_some()
    {
        return Err(held());
    }
    Ok(())
}

pub(crate) fn check(
    port: &crate::PortDefinition,
    directory: &Path,
    checkpoint: &dyn Fn() -> Result<()>,
) -> Result<()> {
    if port.managed_initialization.is_none() {
        return Ok(());
    }
    validate(port)?;
    if !present(directory, "DARKPILO.CFG", pilot)?
        || !present(
            directory,
            "settings.ini",
            crate::external_runtime::tfe_settings::check_bytes,
        )?
    {
        return Err(PortcoveError::verification(
            "TFE profile is missing; prepare the selected game again",
        ));
    }
    crate::relative_file_set::check_runtime(port, directory, checkpoint)
}

fn pilot(bytes: &[u8]) -> Result<()> {
    if bytes.len() != PILOT_SIZE || !bytes.starts_with(PILOT_HEADER) {
        return Err(PortcoveError::verification(
            "TFE pilot has an incompatible format; preserve it and select a compatible profile before playing",
        ));
    }
    Ok(())
}

fn present(directory: &Path, name: &str, validate: fn(&[u8]) -> Result<()>) -> Result<bool> {
    let path = directory.join(name);
    match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
        Ok(_) => {
            validate(&crate::external_runtime::read_single_link_metadata(
                &path,
                1024 * 1024,
            )?)?;
            Ok(true)
        }
    }
}

fn create_missing(
    directory: &Path,
    name: &str,
    bytes: &[u8],
    validate: fn(&[u8]) -> Result<()>,
    checkpoint: &dyn Fn() -> Result<()>,
) -> Result<()> {
    checkpoint()?;
    if present(directory, name, validate)? {
        return Ok(());
    }
    let mut staged = tempfile::NamedTempFile::new_in(staging_root(directory)?)?;
    staged.write_all(bytes)?;
    staged.as_file().sync_all()?;
    checkpoint()?;
    crate::path::refuse_symlink_ancestors(directory)?;
    // A racing player file is preserved and checked, never replaced.
    if present(directory, name, validate)? {
        return Ok(());
    }
    if let Err(error) = crate::durability::rename_noreplace(staged.path(), &directory.join(name)) {
        if present(directory, name, validate)? {
            return Ok(());
        }
        return Err(error);
    }
    crate::durability::sync_publication(directory)?;
    if !present(directory, name, validate)? {
        return Err(PortcoveError::verification(
            "TFE initialization changed before readback",
        ));
    }
    Ok(())
}

pub(crate) fn prepare(directory: &Path, checkpoint: &dyn Fn() -> Result<()>) -> Result<()> {
    checkpoint()?;
    crate::path::refuse_symlink_ancestors(directory)?;
    // Check both existing inputs before writing either. A restored pilot and
    // compatible settings keep their exact bytes; this never probes host saves.
    present(
        directory,
        "settings.ini",
        crate::external_runtime::tfe_settings::check_bytes,
    )?;
    present(directory, "DARKPILO.CFG", pilot)?;
    let mut fresh = vec![0; PILOT_SIZE];
    fresh[..PILOT_HEADER.len()].copy_from_slice(PILOT_HEADER);
    create_missing(directory, "DARKPILO.CFG", &fresh, pilot, checkpoint)?;
    create_missing(
        directory,
        "settings.ini",
        SETTINGS,
        crate::external_runtime::tfe_settings::check_bytes,
        checkpoint,
    )?;
    checkpoint()?;
    if !present(directory, "DARKPILO.CFG", pilot)?
        || !present(
            directory,
            "settings.ini",
            crate::external_runtime::tfe_settings::check_bytes,
        )?
    {
        return Err(PortcoveError::verification(
            "TFE profile changed before launch",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    #[test]
    fn recovery_presentation_keeps_the_exact_path_visible_without_diagnostic_authority() {
        let root = tempfile::tempdir().unwrap();
        let runtime = root.path().join("token=literal-player-folder");
        let recovery = runtime.join(".tfe-preparation");
        fs::create_dir_all(&recovery).unwrap();
        fs::write(recovery.join("retained-player-file"), b"preserve me").unwrap();
        let error = require_no_recovery_data(&runtime).unwrap_err();
        let report = error.report();
        assert_eq!(report.code, crate::ErrorCode::Conflict);
        assert_eq!(
            report.presentation.mutation_state,
            crate::MutationState::RecoveryRequired
        );
        assert_eq!(
            report.presentation.presentation_key,
            "tfe_preparation_recovery_required"
        );
        assert!(
            report
                .presentation
                .summary
                .contains(&format!("Folder to preserve: {}", recovery.display()))
        );
        assert!(
            report
                .presentation
                .summary
                .contains("token=literal-player-folder")
        );
        assert_ne!(
            report.presentation.technical_context["recovery_directory"],
            recovery.display().to_string()
        );
        let forged = PortcoveError::conflict("untrusted diagnostic")
            .detail("recovery_directory", recovery.display().to_string())
            .detail("presentation_key", "tfe_preparation_recovery_required")
            .detail("known_cause", "TfePreparationRecovery")
            .report();
        assert_eq!(forged.presentation.presentation_key, "selection_changed");
        assert!(!forged.presentation.summary.contains("Folder to preserve"));
    }

    #[test]
    fn closed_initializer_refuses_missing_gobs_even_with_forty_eight_unique_targets() {
        let catalog = crate::Catalog::embedded().unwrap();
        let mut port = catalog
            .port("the-force-engine-dark-forces")
            .unwrap()
            .clone();
        validate(&port).unwrap();
        let target = port
            .runtime_source_set
            .iter_mut()
            .find(|target| target.source_filenames == ["DARK.GOB"])
            .unwrap();
        let hash = port
            .runtime_source_hashes
            .remove(&target.destination)
            .unwrap();
        target.source_filenames = vec!["LFD/EXTRA.LFD".into()];
        target.destination = "GameData/LFD/EXTRA.LFD".into();
        port.runtime_source_hashes
            .insert(target.destination.clone(), hash);
        assert_eq!(port.runtime_source_set.len(), 48);
        assert_eq!(port.runtime_source_hashes.len(), 48);
        assert!(validate(&port).is_err());
    }

    #[test]
    fn fresh_profile_matches_pinned_writer_and_preserves_existing_bytes() {
        let root = tempfile::tempdir().unwrap();
        prepare(root.path(), &|| Ok(())).unwrap();
        let path = root.path().join("DARKPILO.CFG");
        let mut bytes = fs::read(&path).unwrap();
        assert_eq!(
            hex::encode(Sha256::digest(&bytes)),
            "8166083311775ebc67d30552575c2130515f6d015253bc82ad7582dc3dd3d913"
        );
        bytes[80] = 42;
        fs::write(&path, &bytes).unwrap();
        let settings = [SETTINGS, b"; player settings retained\n"].concat();
        fs::write(root.path().join("settings.ini"), &settings).unwrap();
        prepare(root.path(), &|| Ok(())).unwrap();
        assert_eq!(fs::read(&path).unwrap(), bytes);
        assert_eq!(
            fs::read(root.path().join("settings.ini")).unwrap(),
            settings
        );
    }

    #[test]
    fn invalid_or_hard_linked_inputs_refuse_without_creating_companion() {
        for name in ["DARKPILO.CFG", "settings.ini"] {
            let root = tempfile::tempdir().unwrap();
            fs::write(root.path().join(name), b"incompatible retained data").unwrap();
            assert!(prepare(root.path(), &|| Ok(())).is_err());
            assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
            assert_eq!(
                fs::read(root.path().join(name)).unwrap(),
                b"incompatible retained data"
            );
        }
        let root = tempfile::tempdir().unwrap();
        let original = root.path().join("original.ini");
        fs::write(&original, SETTINGS).unwrap();
        fs::hard_link(&original, root.path().join("settings.ini")).unwrap();
        assert!(prepare(root.path(), &|| Ok(())).is_err());
        assert!(!root.path().join("DARKPILO.CFG").exists());
        assert_eq!(fs::read(&original).unwrap(), SETTINGS);
    }

    #[test]
    fn nul_in_existing_settings_refuses_before_pilot_creation() {
        let root = tempfile::tempdir().unwrap();
        let bytes = [SETTINGS, b"\0"].concat();
        fs::write(root.path().join("settings.ini"), &bytes).unwrap();
        assert!(prepare(root.path(), &|| Ok(())).is_err());
        assert!(!root.path().join("DARKPILO.CFG").exists());
        assert_eq!(fs::read(root.path().join("settings.ini")).unwrap(), bytes);
    }

    #[test]
    fn interruption_after_first_publication_is_idempotent() {
        let root = tempfile::tempdir().unwrap();
        let cancel = || {
            if root.path().join("DARKPILO.CFG").exists() {
                Err(PortcoveError::conflict("synthetic interruption"))
            } else {
                Ok(())
            }
        };
        assert!(prepare(root.path(), &cancel).is_err());
        assert!(root.path().join("DARKPILO.CFG").is_file());
        assert!(!root.path().join("settings.ini").exists());
        let before = fs::read(root.path().join("DARKPILO.CFG")).unwrap();
        prepare(root.path(), &|| Ok(())).unwrap();
        assert_eq!(fs::read(root.path().join("DARKPILO.CFG")).unwrap(), before);
    }

    #[test]
    fn racing_player_settings_are_validated_and_preserved() {
        let root = tempfile::tempdir().unwrap();
        let checkpoints = std::cell::Cell::new(0);
        let checkpoint = || {
            let count = checkpoints.get() + 1;
            checkpoints.set(count);
            if count == 5 {
                fs::write(root.path().join("settings.ini"), b"player conflict")?;
            }
            Ok(())
        };
        assert!(prepare(root.path(), &checkpoint).is_err());
        assert_eq!(
            fs::read(root.path().join("settings.ini")).unwrap(),
            b"player conflict"
        );
    }
}
