//! Read-only interpretation of the existing backup and retained-installation owners.
//! This snapshot is never a collection plan, restore review or mutation authority.
use std::{fs, path::PathBuf};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::PortcoveService;
use crate::{
    BackupRecord, InstallRecord, Installer, PersistentFilePattern, PortDefinition, PortStatus,
    Result, SavesAndSettingsBehavior,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ProtectionDeclaration {
    pub definition_sha256: String,
    pub saves_and_settings: Option<SavesAndSettingsBehavior>,
    pub persistent_paths: Vec<String>,
    pub persistent_file_patterns: Vec<PersistentFilePattern>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum InstallationUpdateOwner {
    Portcove,
    UpstreamOrUser,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProtectionInstallRole {
    Active,
    Previous,
    Staged,
    External,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProtectionPathState {
    Present,
    Missing,
    Unsafe,
    Unreadable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ProtectionPath {
    pub path: PathBuf,
    /// Presence is metadata only; it does not establish readability or backup integrity.
    pub state: ProtectionPathState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProtectionCollectionState {
    /// This active copy passes the existing read-only collection selection.
    SelectedForCollection,
    DirectToManagedData,
    NotInitialized,
    Inactive,
    ExternalNotCollected,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct InstallationProtection {
    pub install_id: String,
    pub version: String,
    pub install_root: PathBuf,
    pub role: ProtectionInstallRole,
    pub update_owner: InstallationUpdateOwner,
    /// None means there is no verified retained declaration, including legacy installs.
    pub retained: Option<ProtectionDeclaration>,
    /// The checked contract used by collection; it can differ from either declaration.
    pub effective: Option<ProtectionDeclaration>,
    pub collection: ProtectionCollectionState,
    pub collection_root: Option<PathBuf>,
    /// Declared fixed entries and current pattern matches, not a recursive backup inventory.
    pub collection_candidates: Vec<ProtectionPath>,
    pub exclusions: Vec<String>,
    pub problem: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct PlayerDataProtection {
    pub port_id: String,
    pub catalog: ProtectionDeclaration,
    pub managed_data: ProtectionPath,
    pub installations: Vec<InstallationProtection>,
    /// Last completed port-scoped snapshot with a valid manifest. Payload integrity and
    /// current restore eligibility are checked by the existing reviewed restore flow.
    pub latest_completed_backup: Option<BackupRecord>,
    pub exclusions: Vec<String>,
    pub problem: Option<String>,
}

fn declaration(port: &PortDefinition) -> Result<ProtectionDeclaration> {
    Ok(ProtectionDeclaration {
        definition_sha256: crate::signed_catalog::digest(&serde_json::to_vec(port)?),
        saves_and_settings: port
            .presentation
            .as_ref()
            .map(|value| value.saves_and_settings),
        persistent_paths: port.persistent_paths.clone(),
        persistent_file_patterns: port.persistent_file_patterns.clone(),
    })
}

fn observed_path(path: PathBuf) -> ProtectionPath {
    let state = if let Err(error) = crate::path::refuse_symlink_ancestors(&path) {
        if matches!(
            error.code,
            crate::ErrorCode::Conflict | crate::ErrorCode::Usage | crate::ErrorCode::Verification
        ) {
            ProtectionPathState::Unsafe
        } else {
            ProtectionPathState::Unreadable
        }
    } else {
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.is_file() || metadata.is_dir() => ProtectionPathState::Present,
            Ok(_) => ProtectionPathState::Unsafe,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                ProtectionPathState::Missing
            }
            Err(_) => ProtectionPathState::Unreadable,
        }
    };
    ProtectionPath { path, state }
}

impl PortcoveService {
    pub(super) fn player_data_protection(
        &self,
        port: &PortDefinition,
        status: &PortStatus,
        backups: &[BackupRecord],
    ) -> Result<PlayerDataProtection> {
        let mut installations = Vec::new();
        for (role, install) in [
            (ProtectionInstallRole::Active, status.active.as_ref()),
            (ProtectionInstallRole::Previous, status.previous.as_ref()),
            (ProtectionInstallRole::Staged, status.staged.as_ref()),
        ] {
            if let Some(install) = install {
                installations.push(self.installation_protection(install, role));
            }
        }
        let external = self.library.external_runtime_with_port(&port.id);
        let problem = external.as_ref().err().map(|error| error.message.clone());
        if let Ok(Some((runtime, retained_catalog))) = external {
            installations.push(InstallationProtection {
                install_id: runtime.id,
                version: runtime.version,
                install_root: runtime.path,
                role: ProtectionInstallRole::External,
                update_owner: InstallationUpdateOwner::UpstreamOrUser,
                retained: retained_catalog.port(&port.id).ok().map(declaration).transpose()?,
                effective: None,
                collection: ProtectionCollectionState::ExternalNotCollected,
                collection_root: None,
                collection_candidates: Vec::new(),
                exclusions: vec!["Portcove does not copy saves from this installation’s folder. Files already in Portcove’s saves and settings folder can be backed up when the backup checks allow it. Back up external profiles and custom save folders separately.".into()],
                problem: None,
            });
        }
        Ok(PlayerDataProtection {
            port_id: port.id.clone(),
            catalog: declaration(port)?,
            managed_data: observed_path(self.library.user_dir(&port.id)),
            installations,
            problem,
            latest_completed_backup: backups.iter().filter(|backup| backup.port_id == port.id)
                .max_by(|a, b| a.created_at.cmp(&b.created_at).then_with(|| a.id.cmp(&b.id)))
                .cloned(),
            exclusions: vec![
                "New backups can include files in Portcove’s saves and settings folder and files selected for copying from the current installation. Saves in other folders aren’t included automatically. Back up those folders separately.".into(),
                "Switching to an older game version does not restore older saves. Exporting library information or updating Portcove does not restore saved data either.".into(),
                "Original game files are included only when this installation’s backup rules list them.".into(),
                "Finding files or listing them in backup rules does not mean a backup completed. Review the backup’s files before restoring. Another game version may not be able to use these saves.".into(),
            ],
        })
    }

    fn installation_protection(
        &self,
        install: &InstallRecord,
        role: ProtectionInstallRole,
    ) -> InstallationProtection {
        let mut result = InstallationProtection {
            install_id: install.id.clone(),
            version: install.version.clone(),
            install_root: install.path.clone(),
            role,
            update_owner: InstallationUpdateOwner::Portcove,
            retained: None,
            effective: None,
            collection: ProtectionCollectionState::Unavailable,
            collection_root: None,
            collection_candidates: Vec::new(),
            exclusions: Vec::new(),
            problem: None,
        };
        let read: Result<()> = (|| {
            let installer = Installer::new(self.library.clone())?;
            let Some(catalog) = installer.retained_catalog(install)? else {
                result.problem = Some("Portcove doesn’t have backup rules saved for this installation, so it can’t confirm which files to collect. The current catalog may describe a different version.".into());
                return Ok(());
            };
            let retained = catalog.port(&install.port_id)?;
            result.retained = Some(declaration(retained)?);
            let contract = self.persistence_contract_for_install(install)?;
            result.effective = Some(declaration(&contract.port)?);
            result.exclusions = crate::runtime_data_policy::notices(&contract.port);
            if contract.port.presentation.as_ref().is_some_and(|p| {
                p.saves_and_settings == SavesAndSettingsBehavior::ExternalUserOwned
            }) {
                result.exclusions.push("This installation’s saves and settings are handled outside Portcove. Only the listed local files and files already in Portcove’s saves and settings folder can be included. Back up external profiles separately.".into());
            }
            if role != ProtectionInstallRole::Active {
                result.collection = ProtectionCollectionState::Inactive;
                return Ok(());
            }
            if self
                .collectible_active_install(&install.port_id)?
                .as_ref()
                .map(|row| &row.id)
                != Some(&install.id)
            {
                result.collection = ProtectionCollectionState::NotInitialized;
                return Ok(());
            }
            let root = if contract.writes_directly {
                self.library.user_dir(&install.port_id)
            } else {
                self.persistence_root(&contract.port, &install.path)?
            };
            let entries = crate::persistence::entries(&contract.port, &[&root])?;
            result.collection_candidates = entries
                .into_iter()
                .map(|relative| observed_path(root.join(relative)))
                .collect();
            if result.collection_candidates.iter().any(|entry| {
                matches!(
                    entry.state,
                    ProtectionPathState::Unsafe | ProtectionPathState::Unreadable
                )
            }) {
                return Err(crate::PortcoveError::conflict(
                    "A file that might be included in a backup couldn’t be read or failed a safety check. Leave it unchanged and check its location before trying a backup.",
                ));
            }
            result.collection_root = Some(root);
            result.collection = if contract.writes_directly {
                ProtectionCollectionState::DirectToManagedData
            } else {
                ProtectionCollectionState::SelectedForCollection
            };
            Ok(())
        })();
        if let Err(error) = read {
            result.collection = ProtectionCollectionState::Unavailable;
            result.collection_root = None;
            result.collection_candidates.clear();
            result.problem = Some(error.message);
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Catalog, Library, ReleaseChannel};

    fn service() -> (tempfile::TempDir, Library, PortcoveService) {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let service = PortcoveService::new(library.clone()).unwrap();
        (temporary, library, service)
    }

    #[test]
    fn player_copy_receipt_matches_the_service_not_a_frontend_eligibility_rule() {
        let receipt: serde_json::Value =
            serde_json::from_str(include_str!("../../tests/fixtures/protection-copy.json"))
                .unwrap();
        let (_temporary, library, service) = service();
        let inventory = service.list_backups("zelda64-recomp").unwrap();
        assert_eq!(
            serde_json::to_value(&inventory.protection.unwrap().exclusions).unwrap(),
            receipt["exclusions"]
        );
        let root = crate::service::tests::register_zelda_install(&library, "legacy", true);
        // Simulate an old installation without a retained manifest contract.
        let status = service.status("zelda64-recomp").unwrap();
        let mut install = status.active.unwrap();
        let manifest_path = root.join(".portcove-manifest.json");
        let mut manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
        manifest["schema_version"] = 5.into();
        manifest["retained_contract"] = serde_json::Value::Null;
        let bytes = serde_json::to_vec(&manifest).unwrap();
        fs::write(manifest_path, &bytes).unwrap();
        install.manifest_sha256 = crate::signed_catalog::digest(&bytes);
        let legacy = service.installation_protection(&install, ProtectionInstallRole::Active);
        assert_eq!(legacy.collection, ProtectionCollectionState::Unavailable);
        assert_eq!(
            legacy.problem.as_deref(),
            receipt["legacy_problem"].as_str()
        );
        assert!(root.exists());
    }

    #[test]
    fn present_managed_data_is_not_a_completed_backup_or_installation() {
        let (_temporary, library, service) = service();
        let port_id = "zelda64-recomp";
        fs::create_dir_all(library.user_dir(port_id)).unwrap();
        fs::write(library.user_dir(port_id).join("settings.json"), b"{}").unwrap();
        let inventory = service.list_backups(port_id).unwrap();
        let protection = inventory.protection.unwrap();
        assert_eq!(protection.managed_data.state, ProtectionPathState::Present);
        assert!(protection.installations.is_empty());
        assert!(protection.latest_completed_backup.is_none());
        assert!(!protection.catalog.persistent_paths.is_empty());
    }

    #[test]
    fn completed_snapshot_is_port_scoped_and_damaged_entries_stay_separate() {
        let (_temporary, library, service) = service();
        let port_id = "zelda64-recomp";
        fs::create_dir_all(library.user_dir(port_id)).unwrap();
        fs::write(library.user_dir(port_id).join("settings.json"), b"{}").unwrap();
        let backup = service.create_backup(port_id).unwrap();
        let damaged = library
            .backups_dir()
            .join(port_id)
            .join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(&damaged).unwrap();
        fs::write(damaged.join("manifest.json"), b"not json").unwrap();
        let inventory = service.list_backups(port_id).unwrap();
        assert!(!inventory.problems.is_empty());
        assert_eq!(
            inventory
                .protection
                .unwrap()
                .latest_completed_backup
                .unwrap(),
            backup
        );
    }

    #[test]
    fn current_and_retained_declarations_are_distinct_and_inactive_is_not_collected() {
        let (_temporary, library, mut service) = service();
        crate::service::tests::register_zelda_install(&library, "v1", true);
        let mut document =
            serde_json::to_value(service.catalog().authoritative_document()).unwrap();
        let port = document["ports"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|port| port["id"] == "zelda64-recomp")
            .unwrap();
        port["summary"] = "A descriptive correction with unchanged player data".into();
        service.replace_catalog_for_test(Catalog::from_json(&document.to_string()).unwrap());
        let inventory = service.list_backups("zelda64-recomp").unwrap();
        let protection = inventory.protection.unwrap();
        let install = &protection.installations[0];
        assert_eq!(install.update_owner, InstallationUpdateOwner::Portcove);
        assert_eq!(install.role, ProtectionInstallRole::Active);
        assert_ne!(
            install.retained.as_ref().unwrap().definition_sha256,
            protection.catalog.definition_sha256
        );
        // The independent #4152 repair owns whether a corrected contract is usable.
        // This read model must preserve retained facts even if that guard refuses it.
        if let Some(effective) = &install.effective {
            assert_eq!(
                effective.persistent_paths,
                install.retained.as_ref().unwrap().persistent_paths
            );
        } else {
            assert_eq!(install.collection, ProtectionCollectionState::Unavailable);
            assert!(install.problem.is_some());
        }
    }

    #[test]
    fn registered_external_runtime_does_not_inherit_managed_collection() {
        let (_temporary, library, service) = service();
        let port_id = "zelda64-recomp";
        let root = library.root().join("external");
        let record = crate::ExternalRuntimeRecord {
            id: uuid::Uuid::new_v4().to_string(),
            port_id: port_id.into(),
            path: root.clone(),
            executable: root.join("game.exe"),
            version: "external-v1".into(),
            platform: crate::Platform::current().unwrap(),
            archive_sha256: "a".repeat(64),
            immutable_tree_sha256: "b".repeat(64),
            registered_at: 1,
            retained_definition: None,
            shared_preferences: None,
            user_selected: None,
        };
        library
            .register_external_runtime(&record, service.catalog())
            .unwrap();
        let inventory = service.list_backups(port_id).unwrap();
        let protection = inventory.protection.unwrap();
        let external = &protection.installations[0];
        assert_eq!(external.install_id, record.id);
        assert_eq!(
            external.update_owner,
            InstallationUpdateOwner::UpstreamOrUser
        );
        assert_eq!(
            external.collection,
            ProtectionCollectionState::ExternalNotCollected
        );
        assert!(external.collection_candidates.is_empty());
        let receipt: serde_json::Value =
            serde_json::from_str(include_str!("../../tests/fixtures/protection-copy.json"))
                .unwrap();
        assert_eq!(
            external.exclusions[0],
            receipt["external_exclusion"].as_str().unwrap()
        );
        assert!(external.effective.is_none());
        assert!(protection.latest_completed_backup.is_none());
        assert_eq!(
            inventory.create_assessment.reason,
            crate::PortActionReason::MissingData
        );

        // An external registration does not erase managed canonical data or its history.
        fs::create_dir_all(library.user_dir(port_id)).unwrap();
        fs::write(library.user_dir(port_id).join("settings.json"), b"{}").unwrap();
        let backup = service.create_backup(port_id).unwrap();
        let inventory = service.list_backups(port_id).unwrap();
        assert_eq!(
            inventory.create_assessment.availability,
            crate::PortActionAvailability::Allowed
        );
        assert_eq!(
            inventory.restore_assessment.availability,
            crate::PortActionAvailability::Allowed
        );
        let protection = inventory.protection.unwrap();
        assert_eq!(
            protection
                .latest_completed_backup
                .as_ref()
                .map(|row| &row.id),
            Some(&backup.id)
        );
        assert_eq!(
            protection.installations[0].collection,
            ProtectionCollectionState::ExternalNotCollected
        );
        assert!(
            protection.installations[0].exclusions[0]
                .contains("can be backed up when the backup checks allow it")
        );
    }

    #[test]
    fn failed_registration_read_keeps_unknown_separate_from_no_registration() {
        let (_temporary, library, service) = service();
        let port_id = "zelda64-recomp";
        let status = library.status(port_id, ReleaseChannel::Stable).unwrap();
        library.connection().unwrap().execute(
            "INSERT INTO external_runtime_registrations(port_id,record_json,retained_catalog_json,registered_at) VALUES (?1,?2,?3,1)",
            [port_id, "invalid-json", "invalid-json"],
        ).unwrap();
        let result = service
            .player_data_protection(service.catalog().port(port_id).unwrap(), &status, &[])
            .unwrap();
        assert!(result.problem.is_some());
        assert!(result.installations.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn linked_path_is_unsafe_and_never_followed() {
        let temporary = tempfile::tempdir().unwrap();
        let link = temporary.path().join("saves");
        std::os::unix::fs::symlink(temporary.path().join("private"), &link).unwrap();
        assert_eq!(observed_path(link).state, ProtectionPathState::Unsafe);
    }
}
