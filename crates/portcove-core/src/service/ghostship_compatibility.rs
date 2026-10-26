//! Exact historical Ghostship reader hold; this is not a save converter.

use std::{fs, io::ErrorKind};

use crate::{PortcoveError, Result, path::refuse_symlink_ancestors};

use super::PortcoveService;

#[path = "ghostship_legacy_save.rs"]
mod legacy_save;

enum DataCheck<'a> {
    Observation,
    Operation,
    Snapshot(&'a std::path::Path),
}

impl PortcoveService {
    pub(crate) fn require_ghostship_legacy_runtime_archive(
        &self,
        target: &crate::InstallRecord,
        working: &std::path::Path,
    ) -> Result<()> {
        if working != target.path {
            return Err(PortcoveError::verification(
                "legacy runtime CWD differs from its managed installation",
            ));
        }
        crate::preparation::require_legacy_no_binary_importer(working)?;
        self.require_ghostship_install_data_compatibility(target, None)?;
        let canonical = self.library.user_dir("ghostship").join("sm64.o2r");
        let runtime = working.join("sm64.o2r");
        let expected = crate::external_runtime::hash_stable_regular(
            &canonical,
            512 * 1024 * 1024,
            &|| Ok(()),
        )?;
        let actual =
            crate::external_runtime::hash_stable_regular(&runtime, 512 * 1024 * 1024, &|| Ok(()))?;
        if actual.1 == 0 || actual != expected {
            return Err(PortcoveError::verification(
                "restored legacy runtime archive differs from its verified canonical data",
            ));
        }
        Ok(())
    }

    pub(crate) fn prepare_ghostship_legacy_archive(
        &self,
        target: &crate::InstallRecord,
    ) -> Result<()> {
        if target.port_id != "ghostship"
            || target.version != "2.0.0"
            || crate::Installer::new(self.library.clone())?.retained_preparation_mode(target)?
                != Some(crate::PreparationMode::Ghostship200Legacy)
        {
            return Ok(());
        }
        self.require_ghostship_install_data_compatibility(target, None)?;
        let user = self.library.user_dir("ghostship");
        let destination = user.join("sm64.o2r");
        match fs::symlink_metadata(&destination) {
            Ok(_) => return Ok(()),
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        let source_root = target.path.join("prepared-game-data");
        let source = source_root.join("sm64.o2r");
        crate::Installer::new(self.library.clone())?.verify_recorded_member(target, &source)?;
        let identity =
            crate::external_runtime::hash_stable_regular(&source, 512 * 1024 * 1024, &|| Ok(()))?;
        let reviewed = crate::library_transfer::reviewed_tree(&source_root)?;
        if !reviewed.directories.is_empty()
            || reviewed.files.len() != 1
            || reviewed.files[0].relative_path != std::path::Path::new("sm64.o2r")
            || reviewed.files[0].sha256 != identity.0
            || reviewed.files[0].size != identity.1
        {
            return Err(PortcoveError::verification(
                "legacy generated member differs from its exact reviewed seed",
            ));
        }
        refuse_symlink_ancestors(&user)?;
        fs::create_dir_all(&user)?;
        refuse_symlink_ancestors(&user)?;
        let staging = self.library.staging_dir();
        refuse_symlink_ancestors(&staging)?;
        fs::create_dir_all(&staging)?;
        let work = tempfile::Builder::new()
            .prefix("ghostship-legacy-seed-")
            .tempdir_in(staging)?;
        // Existing checked copy publishes one complete file without replacing any
        // player data. A failed copy cannot expose a partial canonical archive.
        crate::transfer_copy::copy_reviewed_tree(&source_root, &user, &reviewed, work.path())?;
        self.require_ghostship_install_data_compatibility(target, None)
    }

    pub(crate) fn require_ghostship_data_compatibility(
        &self,
        port_id: &str,
        target_version: &str,
        active_version: Option<&str>,
    ) -> Result<()> {
        self.require_ghostship_data_compatibility_for_target(
            port_id,
            target_version,
            active_version,
            None,
            None,
            DataCheck::Operation,
        )
    }

    pub(crate) fn require_ghostship_install_data_compatibility(
        &self,
        target: &crate::InstallRecord,
        active_version: Option<&str>,
    ) -> Result<()> {
        self.require_ghostship_data_compatibility_for_target(
            &target.port_id,
            &target.version,
            active_version,
            Some(target),
            None,
            DataCheck::Operation,
        )
    }

    pub(crate) fn inspect_ghostship_install_data_compatibility(
        &self,
        target: &crate::InstallRecord,
        active_version: Option<&str>,
    ) -> Result<()> {
        self.require_ghostship_data_compatibility_for_target(
            &target.port_id,
            &target.version,
            active_version,
            Some(target),
            None,
            DataCheck::Observation,
        )
    }

    pub(crate) fn require_ghostship_staged_preparation_compatibility(
        &self,
        operation: &crate::operation::LifecycleOperation,
        target: &crate::InstallRecord,
        active_version: Option<&str>,
    ) -> Result<()> {
        use crate::operation::{LifecycleOperationKind, LifecyclePhase};
        let invalid = || PortcoveError::state("invalid staged legacy preparation binding");
        let staging = operation.paths.staging.as_ref().ok_or_else(invalid)?;
        let original = operation.install.as_ref().ok_or_else(invalid)?;
        let plan = operation.preparation.as_ref().ok_or_else(invalid)?;
        let mut expected = original.clone();
        expected.path = staging.join("payload");
        if operation.kind != LifecycleOperationKind::Prepare
            || operation.phase != LifecyclePhase::Prepared
            || operation.port_id != "ghostship"
            || operation.id != original.id
            || original.port_id != operation.port_id
            || operation.paths.final_path.as_ref() != Some(&original.path)
            || operation.paths.quarantine.is_some()
            || operation.relocation.is_some()
            || operation.source_import.is_some()
            || !operation.original_paths.is_empty()
            || !operation.activate
            || operation.preparation_process_quiesced != Some(true)
            || plan.port_id != operation.port_id
            || plan.inputs.install.port_id != operation.port_id
            || plan.format_version != 2
            || plan.inputs.options.mode != crate::PreparationMode::Ghostship200Legacy
            || original.artifact != plan.inputs.install.artifact
            || original.version != plan.inputs.install.version
            || original.runtime != plan.inputs.install.runtime
            || serde_json::to_value(&expected)? != serde_json::to_value(target)?
        {
            return Err(invalid());
        }
        crate::output_root::validate_staging_path(
            &self.library,
            &operation.port_id,
            &operation.id,
            staging,
        )?;
        let installer = crate::Installer::new(self.library.clone())?;
        if !installer.verify(target)?.valid
            || installer.retained_preparation_mode(target)?
                != Some(crate::PreparationMode::Ghostship200Legacy)
        {
            return Err(PortcoveError::verification(
                "staged legacy preparation differs from its journal manifest",
            ));
        }
        let catalog = installer.retained_catalog(target)?.ok_or_else(invalid)?;
        let port = catalog.port(&operation.port_id)?;
        crate::preparation::legacy_execution_contract(port, target, crate::Platform::current()?)?;
        let source = self.library.source("ghostship-source")?.ok_or_else(|| {
            PortcoveError::source("the staged preparation's exact original is not registered")
        })?;
        crate::source_inspection::verify_registered(&catalog, &source)?;
        // Run these even when canonical O2R is absent: location proof is not a
        // shortcut around the closed receipt, executable or generated member.
        self.validate_preparation_receipt_in_retained_catalog(
            &catalog,
            target,
            Some(&source),
            Some(plan),
        )?;
        self.require_ghostship_data_compatibility_for_target(
            &target.port_id,
            &target.version,
            active_version,
            Some(target),
            Some(&catalog),
            DataCheck::Operation,
        )
    }

    /// Content checks only; callers establish the selected backup or private
    /// recovery-stage ownership. This does not grant an ordinary 3→2 activation.
    pub(crate) fn require_ghostship_snapshot_compatibility(
        &self,
        target: &crate::InstallRecord,
        data_root: &std::path::Path,
    ) -> Result<()> {
        let installer = crate::Installer::new(self.library.clone())?;
        if target.port_id != "ghostship"
            || target.version != "2.0.0"
            || installer.retained_preparation_mode(target)?
                != Some(crate::PreparationMode::Ghostship200Legacy)
        {
            return Err(PortcoveError::verification(
                "snapshot target is not the exact prepared legacy runtime",
            ));
        }
        let catalog = installer.retained_catalog(target)?.ok_or_else(|| {
            PortcoveError::verification("snapshot target has no retained contract")
        })?;
        crate::preparation::require_legacy_no_binary_importer(&target.path)?;
        let archive = crate::external_runtime::hash_stable_regular(
            &data_root.join("sm64.o2r"),
            512 * 1024 * 1024,
            &|| Ok(()),
        )?;
        if archive.1 == 0 {
            return Err(PortcoveError::verification(
                "legacy snapshot has no generated archive",
            ));
        }
        self.require_ghostship_data_compatibility_for_target(
            "ghostship",
            "2.0.0",
            None,
            Some(target),
            Some(&catalog),
            DataCheck::Snapshot(data_root),
        )
    }

    fn require_ghostship_data_compatibility_for_target(
        &self,
        port_id: &str,
        target_version: &str,
        active_version: Option<&str>,
        target: Option<&crate::InstallRecord>,
        staged_catalog: Option<&crate::Catalog>,
        check: DataCheck<'_>,
    ) -> Result<()> {
        if port_id != "ghostship" || target_version != "2.0.0" {
            return Ok(());
        }
        let held = |reason: &str| {
            PortcoveError::conflict(format!(
                "Ghostship 2.0.0 data compatibility is held: {reason}. Keep the current \
                 installation and user data; a reviewed pre-transition data recovery route \
                 is required before using this legacy runtime (Portcove #53)"
            ))
        };
        // O2R and settings transitions also remain unqualified for this exact
        // pair. Absence of save files cannot turn that transition into a pass.
        if active_version == Some("3.0.0") {
            return Err(held(
                "the older runtime cannot read schema-2 saves and generated O2R compatibility is not established",
            ));
        }
        // Installation history can disappear after removal. Inspect the shared
        // SHIP_HOME data as well, before any mutation or old-reader execution.
        let user = match check {
            DataCheck::Snapshot(root) => root.to_path_buf(),
            _ => self.library.user_dir(port_id),
        };
        let legacy_binary = user.join("default.sav");
        refuse_symlink_ancestors(&legacy_binary)
            .map_err(|_| held("legacy binary save data contains an unsafe path"))?;
        match fs::symlink_metadata(&legacy_binary) {
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(_) => return Err(held("legacy binary save data is unreadable")),
            Ok(_) => {
                return Err(held(
                    "the legacy binary importer would replace JSON saves and has not been qualified",
                ));
            }
        }
        for name in [
            "save_0.json",
            "save_1.json",
            "save_2.json",
            "save_3.json",
            "global.json",
        ] {
            let path = user.join("saves").join(name);
            refuse_symlink_ancestors(&path)
                .map_err(|_| held("save data contains an unsafe path"))?;
            match fs::symlink_metadata(&path) {
                Err(error) if error.kind() == ErrorKind::NotFound => continue,
                Err(_) => return Err(held("save data is unreadable")),
                Ok(_) => {}
            }
            let bytes = crate::path::read_bounded_regular(&path, 1024 * 1024)
                .map_err(|_| held("save data is not a bounded readable regular file"))?;
            let value: serde_json::Value =
                serde_json::from_slice(&bytes).map_err(|_| held("save data is malformed"))?;
            legacy_save::validate(&value, name == "global.json")
                .map_err(|reason| held(&format!("schema-1 reader: {reason}")))?;
        }
        let archive = user.join("sm64.o2r");
        refuse_symlink_ancestors(&archive).map_err(|_| held("generated O2R has an unsafe path"))?;
        match fs::symlink_metadata(&archive) {
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
            Err(_) => Err(held("generated O2R is unreadable")),
            Ok(_) => {
                let target = target.ok_or_else(|| held("the retained generated O2R has no reviewed legacy-reader compatibility proof"))?;
                let catalog = match staged_catalog {
                    Some(catalog) => catalog.clone(),
                    None => self.installed_catalog(target)?,
                };
                let source = self.library.source("ghostship-source")?.ok_or_else(|| {
                    held("the prepared archive's exact original is not registered")
                })?;
                if !matches!(check, DataCheck::Observation) {
                    crate::source_inspection::verify_registered(&catalog, &source)?;
                }
                self.validate_preparation_receipt_in_retained_catalog(
                    &catalog,
                    target,
                    Some(&source),
                    None,
                )?;
                let generated = crate::preparation::legacy_generated_path(&target.path);
                let expected = crate::external_runtime::hash_stable_regular(
                    &generated,
                    512 * 1024 * 1024,
                    &|| Ok(()),
                )?;
                let actual = crate::external_runtime::hash_stable_regular(
                    &archive,
                    512 * 1024 * 1024,
                    &|| Ok(()),
                )?;
                if actual.1 == 0 || actual != expected {
                    return Err(held(
                        "the retained generated O2R does not match the exact prepared legacy archive",
                    ));
                }
                Ok(())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Library;

    #[test]
    fn ghostship_legacy_reader_checks_each_save_after_install_history_is_lost() {
        for name in [
            "save_0.json",
            "save_1.json",
            "save_2.json",
            "save_3.json",
            "global.json",
        ] {
            let temporary = tempfile::tempdir().unwrap();
            let library = Library::open(temporary.path()).unwrap();
            let path = library.user_dir("ghostship").join("saves").join(name);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            let service = PortcoveService::new(library).unwrap();
            for bytes in [
                br#"{"version":2}"#.as_slice(),
                b"{",
                b"{}",
                br#"{"version":"1"}"#,
                br#"{"version":1}"#,
            ] {
                fs::write(&path, bytes).unwrap();
                assert!(
                    service
                        .require_ghostship_data_compatibility("ghostship", "2.0.0", None)
                        .is_err()
                );
                assert_eq!(fs::read(&path).unwrap(), bytes);
            }
            let valid = legacy_save::tests::vanilla(name == "global.json");
            fs::write(&path, serde_json::to_vec(&valid).unwrap()).unwrap();
            service
                .require_ghostship_data_compatibility("ghostship", "2.0.0", None)
                .unwrap();
            let mut invalid = valid;
            if name == "global.json" {
                invalid["coinScoreAges"][2] = serde_json::json!(-1);
            } else {
                invalid["courseStars"].as_object_mut().unwrap().remove("CG");
            }
            let bytes = serde_json::to_vec(&invalid).unwrap();
            fs::write(&path, &bytes).unwrap();
            assert!(
                service
                    .require_ghostship_data_compatibility("ghostship", "2.0.0", None)
                    .is_err()
            );
            assert_eq!(fs::read(&path).unwrap(), bytes);
        }
    }

    #[test]
    fn ghostship_legacy_binary_import_is_held_without_touching_any_save() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path()).unwrap();
        let user = library.user_dir("ghostship");
        fs::create_dir_all(user.join("saves")).unwrap();
        let binary = user.join("default.sav");
        let json = user.join("saves/save_0.json");
        let bytes = serde_json::to_vec(&legacy_save::tests::vanilla(false)).unwrap();
        fs::write(&binary, b"retained legacy binary").unwrap();
        fs::write(&json, &bytes).unwrap();
        let service = PortcoveService::new(library).unwrap();
        let error = service
            .require_ghostship_data_compatibility("ghostship", "2.0.0", None)
            .unwrap_err();
        assert!(error.message.contains("legacy binary importer"));
        assert_eq!(fs::read(&binary).unwrap(), b"retained legacy binary");
        assert_eq!(fs::read(&json).unwrap(), bytes);
        assert!(!user.join("default.sav.bak").exists());
    }

    #[test]
    fn ghostship_legacy_reader_holds_unbounded_nonregular_and_unproven_data() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path()).unwrap();
        let user = library.user_dir("ghostship");
        let saves = user.join("saves");
        fs::create_dir_all(&saves).unwrap();
        let service = PortcoveService::new(library).unwrap();
        let path = saves.join("global.json");
        fs::create_dir(&path).unwrap();
        assert!(
            service
                .require_ghostship_data_compatibility("ghostship", "2.0.0", None)
                .is_err()
        );
        fs::remove_dir(&path).unwrap();
        fs::write(&path, vec![b' '; 1024 * 1024 + 1]).unwrap();
        assert!(
            service
                .require_ghostship_data_compatibility("ghostship", "2.0.0", None)
                .is_err()
        );
        fs::remove_file(path).unwrap();
        let archive = user.join("sm64.o2r");
        fs::write(&archive, b"unproven producer identity").unwrap();
        assert!(
            service
                .require_ghostship_data_compatibility("ghostship", "2.0.0", None)
                .is_err()
        );
        assert_eq!(fs::read(archive).unwrap(), b"unproven producer identity");
        service
            .require_ghostship_data_compatibility("ghostship", "3.0.0", None)
            .unwrap();
        service
            .require_ghostship_data_compatibility("lighthouse", "2.0.0", None)
            .unwrap();
    }
}
