//! Backup orchestration behind the stable PortcoveService facade.
//! Manifest decoding and tree-copy machinery are private to this responsibility.
use std::{
    collections::HashSet,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::{
    AdoptionCopyPlan, BackupAction, BackupActionPreview, PortcoveService, adoption_copy_plan,
    validate_reviewed_fingerprint,
};
use crate::{
    ActivityOperation, ActivityTargetKind, BackupInventory, BackupInventoryState, BackupProblem,
    BackupProblemKind, BackupRecord, Library, PortcoveError, RestoreResult, Result,
    durability::{prepare_backup_publication, publish_backup_directory},
    operation::{
        LifecycleFaultPoint, LifecycleOperation, LifecycleOperationKind, LifecyclePhase,
        OperationStore,
    },
    path::refuse_symlink_ancestors,
};

const BACKUP_MANIFEST_MAX_BYTES: u64 = 64 * 1024;

#[derive(Debug, Serialize, Deserialize)]
struct BackupManifest {
    id: String,
    port_id: String,
    created_at: i64,
    file_count: u64,
    size: u64,
    sha256: String,
}

#[derive(Debug, Default)]
struct BackupStats {
    file_count: u64,
    size: u64,
    hasher: Sha256,
}

impl PortcoveService {
    pub fn create_backup(&self, port_id: &str) -> Result<BackupRecord> {
        let activity = self.library.begin_activity(
            ActivityOperation::Backup,
            ActivityTargetKind::Port,
            Some(port_id),
        )?;
        let result: Result<BackupRecord> = (|| {
            self.catalog.port(port_id)?;
            let _operation = self.library.try_lock_port(port_id, "backup")?;
            self.require_completed_backup_deletion(port_id)?;
            self.collect_active_user_data_if_launched(port_id)?;
            self.create_backup_locked(port_id)
        })();
        self.finish_activity(activity, result)
    }

    fn create_backup_locked(&self, port_id: &str) -> Result<BackupRecord> {
        let source = self.library.user_dir(port_id);
        if !source.is_dir() {
            return Err(PortcoveError::not_found(format!(
                "{port_id} has no persistent data to back up"
            )));
        }

        let parent = self.library.backups_dir().join(port_id);
        refuse_symlink_ancestors(&parent)?;
        fs::create_dir_all(&parent)?;
        refuse_symlink_ancestors(&parent)?;
        let temporary = tempfile::Builder::new()
            .prefix(".backup-")
            .tempdir_in(&parent)?;
        let mut stats = BackupStats::default();
        copy_backup_tree(&source, &temporary.path().join("data"), &source, &mut stats)?;
        if stats.file_count == 0 {
            return Err(PortcoveError::not_found(format!(
                "{port_id} has no persistent data to back up"
            )));
        }

        let BackupStats {
            file_count,
            size,
            hasher,
        } = stats;
        let now = Library::now();
        let created_at = self
            .list_backups(port_id)?
            .backups
            .first()
            .map_or(now, |latest| now.max(latest.created_at.saturating_add(1)));
        let manifest = BackupManifest {
            id: Uuid::new_v4().to_string(),
            port_id: port_id.into(),
            created_at,
            file_count,
            size,
            sha256: hex::encode(hasher.finalize()),
        };
        let final_path = parent.join(&manifest.id);
        let manifest_path = temporary.path().join("backup.json");
        let mut manifest_file = fs::File::create(&manifest_path)?;
        serde_json::to_writer_pretty(&mut manifest_file, &manifest)?;
        manifest_file.write_all(b"\n")?;
        manifest_file.sync_all()?;
        drop(manifest_file);
        let directory_sync = prepare_backup_publication(
            self.library.root(),
            &self.library.backups_dir(),
            &parent,
            temporary.path(),
        )?;
        let staging_path = temporary.keep();
        publish_backup_directory(&staging_path, &final_path, &parent, directory_sync)?;
        Ok(backup_record(manifest, final_path))
    }

    pub fn list_backups(&self, port_id: &str) -> Result<BackupInventory> {
        self.catalog.port(port_id)?;
        let operations = OperationStore::new(self.library.clone()).all()?;
        self.list_backups_with_operations(port_id, &operations)
    }

    pub(super) fn list_backups_with_operations(
        &self,
        port_id: &str,
        operations: &[LifecycleOperation],
    ) -> Result<BackupInventory> {
        let parent = self.library.backups_dir().join(port_id);
        let pending_deletions = operations
            .iter()
            .filter(|operation| {
                operation.port_id == port_id
                    && operation.kind == LifecycleOperationKind::DeleteBackup
            })
            .collect::<Vec<_>>();
        let pending_paths = pending_deletions
            .iter()
            .filter_map(|operation| operation.paths.quarantine.as_ref())
            .collect::<HashSet<_>>();
        let mut problems = pending_deletions
            .iter()
            .map(|operation| BackupProblem {
                kind: BackupProblemKind::RecoveryRequired,
                backup_id: operation
                    .paths
                    .final_path
                    .as_ref()
                    .and_then(|path| path.file_name())
                    .and_then(|name| name.to_str())
                    .map(str::to_owned),
                operation_id: Some(operation.id.clone()),
                path: operation
                    .paths
                    .quarantine
                    .clone()
                    .or_else(|| operation.paths.final_path.clone())
                    .unwrap_or_else(|| parent.clone()),
                message: operation
                    .last_error
                    .clone()
                    .unwrap_or_else(|| format!("backup deletion is paused at {}", operation.phase)),
                proposed_action:
                    "restart Portcove to retry recovery; review doctor output if it remains".into(),
            })
            .collect::<Vec<_>>();
        if let Err(error) = refuse_symlink_ancestors(&parent) {
            problems.push(BackupProblem {
                kind: BackupProblemKind::RecoveryRequired,
                backup_id: None,
                operation_id: None,
                path: parent.clone(),
                message: error.message,
                proposed_action: "restore the owned backup directory after review".into(),
            });
            return Ok(BackupInventory {
                port_id: port_id.into(),
                state: BackupInventoryState::RecoveryRequired,
                backups: Vec::new(),
                problems,
            });
        }
        let parent_metadata = match fs::symlink_metadata(&parent) {
            Ok(metadata) => Some(metadata),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => {
                problems.push(backup_problem(
                    BackupProblemKind::UnreadableManifest,
                    None,
                    parent.clone(),
                    format!("backup directory could not be read: {error}"),
                ));
                return Ok(BackupInventory {
                    port_id: port_id.into(),
                    state: backup_inventory_state(&problems),
                    backups: Vec::new(),
                    problems,
                });
            }
        };
        if parent_metadata.is_none() {
            let state = backup_inventory_state(&problems);
            return Ok(BackupInventory {
                port_id: port_id.into(),
                state,
                backups: Vec::new(),
                problems,
            });
        }
        if !parent_metadata.is_some_and(|metadata| metadata.is_dir()) {
            problems.push(backup_problem(
                BackupProblemKind::UnsupportedEntry,
                None,
                parent.clone(),
                "backup root is not an owned directory".into(),
            ));
            return Ok(BackupInventory {
                port_id: port_id.into(),
                state: backup_inventory_state(&problems),
                backups: Vec::new(),
                problems,
            });
        }
        let mut backups = Vec::new();
        let entries = match fs::read_dir(&parent) {
            Ok(entries) => entries,
            Err(error) => {
                problems.push(backup_problem(
                    BackupProblemKind::UnreadableManifest,
                    None,
                    parent.clone(),
                    format!("backup directory could not be listed: {error}"),
                ));
                return Ok(BackupInventory {
                    port_id: port_id.into(),
                    state: backup_inventory_state(&problems),
                    backups,
                    problems,
                });
            }
        };
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => {
                    problems.push(backup_problem(
                        BackupProblemKind::UnreadableManifest,
                        None,
                        parent.clone(),
                        format!("backup entry could not be read: {error}"),
                    ));
                    continue;
                }
            };
            let path = entry.path();
            let directory_id = match entry.file_name().into_string() {
                Ok(directory_id) => directory_id,
                Err(_) => {
                    problems.push(backup_problem(
                        BackupProblemKind::UnsupportedEntry,
                        None,
                        path,
                        "backup path is not valid Unicode".into(),
                    ));
                    continue;
                }
            };
            if directory_id.starts_with(".backup-") {
                continue;
            }
            if directory_id.starts_with('.') {
                if !pending_paths.contains(&path) {
                    problems.push(BackupProblem {
                        kind: BackupProblemKind::RecoveryRequired,
                        backup_id: None,
                        operation_id: None,
                        path,
                        message: "private backup recovery data has no matching lifecycle record"
                            .into(),
                        proposed_action: "review with portcove doctor; do not delete it manually"
                            .into(),
                    });
                }
                continue;
            }
            if !matches!(
                Uuid::parse_str(&directory_id),
                Ok(parsed) if parsed.to_string() == directory_id
            ) {
                problems.push(backup_problem(
                    BackupProblemKind::IdentityMismatch,
                    Some(directory_id),
                    path,
                    "backup directory name is not a canonical backup ID".into(),
                ));
                continue;
            }
            let file_type = match entry.file_type() {
                Ok(file_type) => file_type,
                Err(error) => {
                    problems.push(backup_problem(
                        BackupProblemKind::UnreadableManifest,
                        Some(directory_id),
                        path,
                        format!("backup entry metadata could not be read: {error}"),
                    ));
                    continue;
                }
            };
            if !file_type.is_dir() || file_type.is_symlink() {
                problems.push(backup_problem(
                    BackupProblemKind::UnsupportedEntry,
                    Some(directory_id),
                    path,
                    "backup entry is not an owned directory".into(),
                ));
                continue;
            }
            match read_backup_manifest(&path, port_id, &directory_id) {
                Ok(manifest) => backups.push(backup_record(manifest, path)),
                Err(error) => {
                    let kind = backup_problem_kind(&error);
                    problems.push(backup_problem(
                        kind,
                        Some(directory_id),
                        path,
                        error.message,
                    ));
                }
            }
        }
        backups.sort_by(|left, right| {
            right
                .created_at
                .cmp(&left.created_at)
                .then_with(|| right.id.cmp(&left.id))
        });
        problems.sort_by(|left, right| {
            left.path
                .cmp(&right.path)
                .then_with(|| left.operation_id.cmp(&right.operation_id))
        });
        Ok(BackupInventory {
            port_id: port_id.into(),
            state: backup_inventory_state(&problems),
            backups,
            problems,
        })
    }

    pub fn preview_backup_action(
        &self,
        port_id: &str,
        backup_id: &str,
        action: BackupAction,
    ) -> Result<BackupActionPreview> {
        self.catalog.port(port_id)?;
        let backup = self.load_backup(port_id, backup_id)?;
        let backup_plan = adoption_copy_plan(&backup.path.join("data"))?;
        let user_root = self.library.user_dir(port_id);
        let current_user_data_exists = user_root.exists();
        if current_user_data_exists && !user_root.is_dir() {
            return Err(PortcoveError::conflict(format!(
                "persistent data root is not a directory: {}",
                user_root.display()
            )));
        }
        let user_plan = if action == BackupAction::Restore && current_user_data_exists {
            Some(adoption_copy_plan(&user_root)?)
        } else {
            None
        };
        let preview_sha256 =
            backup_action_fingerprint(action, &backup, &backup_plan, user_plan.as_ref())?;
        Ok(BackupActionPreview {
            action,
            backup,
            current_user_data_exists,
            safety_backup_will_be_created: action == BackupAction::Restore
                && user_plan
                    .as_ref()
                    .is_some_and(|plan| !plan.files.is_empty()),
            preview_sha256,
        })
    }

    pub fn authorize_backup_action(
        &self,
        port_id: &str,
        backup_id: &str,
        action: BackupAction,
        expected_preview_sha256: &str,
    ) -> Result<crate::DestructiveAuthorization> {
        validate_reviewed_fingerprint("backup action", expected_preview_sha256)?;
        self.library.issue_authorization(
            action.authorization_action(),
            &backup_authorization_target(port_id, backup_id),
            expected_preview_sha256,
        )
    }

    pub fn restore_backup(
        &self,
        port_id: &str,
        backup_id: &str,
        authorization_token: &str,
    ) -> Result<RestoreResult> {
        let activity = self.library.begin_activity(
            ActivityOperation::Restore,
            ActivityTargetKind::Port,
            Some(port_id),
        )?;
        let store = OperationStore::new(self.library.clone());
        let mut lifecycle =
            LifecycleOperation::new(&activity.id, LifecycleOperationKind::Restore, port_id);
        let recovery_root = self.library.recovery_dir().join(&activity.id);
        let staged_data = recovery_root.join("staged-data");
        let previous_data = recovery_root.join("previous-data");
        let user_root = self.library.user_dir(port_id);
        lifecycle.paths.staging = Some(recovery_root.clone());
        lifecycle.paths.final_path = Some(user_root.clone());
        lifecycle.paths.quarantine = Some(previous_data.clone());
        store.put(&mut lifecycle)?;
        let result = (|| {
            self.catalog.port(port_id)?;
            let _operation = self.library.try_lock_port(port_id, "restore-backup")?;
            self.require_completed_restore(port_id)?;
            self.require_completed_backup_deletion(port_id)?;
            self.library.consume_authorization_with_state(
                authorization_token,
                BackupAction::Restore.authorization_action(),
                &backup_authorization_target(port_id, backup_id),
                || {
                    self.collect_active_user_data_if_launched(port_id)?;
                    Ok(self
                        .preview_backup_action(port_id, backup_id, BackupAction::Restore)?
                        .preview_sha256)
                },
            )?;
            let restored_backup = self.load_backup(port_id, backup_id)?;

            if user_root.exists() && !user_root.is_dir() {
                return Err(PortcoveError::conflict(format!(
                    "persistent data root is not a directory: {}",
                    user_root.display()
                )));
            }
            let user_parent = user_root.parent().ok_or_else(|| {
                PortcoveError::state(format!(
                    "persistent data root has no parent: {}",
                    user_root.display()
                ))
            })?;
            fs::create_dir_all(user_parent)?;
            let source_data = restored_backup.path.join("data");
            let mut stats = BackupStats::default();
            copy_backup_tree(&source_data, &staged_data, &source_data, &mut stats)?;
            verify_backup_stats(&restored_backup, stats)?;

            let safety_backup = if user_root.exists() {
                match self.create_backup_locked(port_id) {
                    Ok(backup) => Some(backup),
                    Err(error) if error.code == crate::ErrorCode::NotFound => None,
                    Err(error) => return Err(error),
                }
            } else {
                None
            };
            lifecycle.activate = user_root.exists();
            lifecycle.phase = LifecyclePhase::Prepared;
            store.put(&mut lifecycle)?;
            self.faults.check(LifecycleFaultPoint::RestorePrepared)?;
            if lifecycle.activate {
                fs::rename(&user_root, &previous_data)?;
            }
            if let Err(error) = fs::rename(&staged_data, &user_root) {
                if lifecycle.activate {
                    let _ = fs::rename(&previous_data, &user_root);
                }
                return Err(error.into());
            }
            lifecycle.phase = LifecyclePhase::PayloadPublished;
            store.put(&mut lifecycle)?;
            self.faults.check(LifecycleFaultPoint::RestorePublished)?;
            self.synchronize_restored_user_data(port_id)?;
            lifecycle.phase = LifecyclePhase::MetadataCommitted;
            store.put(&mut lifecycle)?;
            if previous_data.exists() {
                fs::remove_dir_all(&previous_data)?;
            }
            if recovery_root.exists() {
                fs::remove_dir_all(&recovery_root)?;
            }
            store.remove(&lifecycle.id)?;
            Ok(RestoreResult {
                restored_backup,
                safety_backup,
            })
        })();
        if let Err(error) = &result {
            if lifecycle.phase == LifecyclePhase::Preparing {
                let _ = fs::remove_dir_all(&recovery_root);
                let _ = store.remove(&lifecycle.id);
            } else {
                lifecycle.last_error = Some(error.message.clone());
                let _ = store.put(&mut lifecycle);
            }
        }
        self.finish_activity(activity, result)
    }

    pub fn delete_backup(
        &self,
        port_id: &str,
        backup_id: &str,
        authorization_token: &str,
    ) -> Result<BackupRecord> {
        let activity = self.library.begin_activity(
            ActivityOperation::DeleteBackup,
            ActivityTargetKind::Port,
            Some(port_id),
        )?;
        let store = OperationStore::new(self.library.clone());
        let mut lifecycle =
            LifecycleOperation::new(&activity.id, LifecycleOperationKind::DeleteBackup, port_id);
        let mut result: Result<BackupRecord> = (|| {
            self.catalog.port(port_id)?;
            let _operation = self.library.try_lock_port(port_id, "delete-backup")?;
            self.require_completed_backup_deletion(port_id)?;
            let locked_preview =
                self.preview_backup_action(port_id, backup_id, BackupAction::Delete)?;
            self.library.consume_authorization(
                authorization_token,
                BackupAction::Delete.authorization_action(),
                &backup_authorization_target(port_id, backup_id),
                &locked_preview.preview_sha256,
            )?;
            let backup = self.load_backup(port_id, backup_id)?;
            let parent = backup.path.parent().ok_or_else(|| {
                PortcoveError::state(format!(
                    "backup path has no parent: {}",
                    backup.path.display()
                ))
            })?;
            refuse_symlink_ancestors(parent)?;
            refuse_symlink_ancestors(&backup.path)?;
            let deleting = parent.join(format!(".deleting-{}", activity.id));
            lifecycle.paths.final_path = Some(backup.path.clone());
            lifecycle.paths.quarantine = Some(deleting.clone());
            lifecycle.phase = LifecyclePhase::Prepared;
            self.validate_backup_deletion_operation(&lifecycle)?;
            store.put(&mut lifecycle)?;
            self.faults
                .check(LifecycleFaultPoint::DeleteBackupPrepared)?;
            crate::durability::rename_noreplace(&backup.path, &deleting)?;
            self.faults
                .check(LifecycleFaultPoint::DeleteBackupQuarantined)?;
            lifecycle.phase = LifecyclePhase::PayloadPublished;
            store.put(&mut lifecycle)?;
            self.faults
                .check(LifecycleFaultPoint::DeleteBackupDeleting)?;
            refuse_symlink_ancestors(&deleting)?;
            fs::remove_dir_all(&deleting)?;
            self.faults
                .check(LifecycleFaultPoint::DeleteBackupDeleted)?;
            lifecycle.phase = LifecyclePhase::MetadataCommitted;
            store.put(&mut lifecycle)?;
            self.faults
                .check(LifecycleFaultPoint::DeleteBackupMetadataCommitted)?;
            store.remove(&lifecycle.id)?;
            Ok(backup)
        })();
        if let Err(error) = &mut result
            && lifecycle.phase != LifecyclePhase::Preparing
        {
            let recovery_path = lifecycle
                .paths
                .quarantine
                .as_ref()
                .map_or_else(|| self.library.backups_dir(), PathBuf::from);
            error
                .details
                .insert("backup_state".into(), "recovery_required".into());
            error
                .details
                .insert("recovery_action".into(), "restart_then_doctor".into());
            error
                .details
                .insert("recovery_path".into(), recovery_path.display().to_string());
            error.message = format!(
                "{}; backup recovery is required at {}. Restart Portcove to retry, then review doctor output if it remains",
                error.message,
                recovery_path.display()
            );
            lifecycle.last_error = Some(error.message.clone());
            let _ = store.put(&mut lifecycle);
        }
        self.finish_activity(activity, result)
    }

    fn load_backup(&self, port_id: &str, backup_id: &str) -> Result<BackupRecord> {
        let parsed = Uuid::parse_str(backup_id).map_err(|_| {
            PortcoveError::not_found(format!("backup {backup_id} was not found for {port_id}"))
        })?;
        if parsed.to_string() != backup_id {
            return Err(PortcoveError::not_found(format!(
                "backup {backup_id} was not found for {port_id}"
            )));
        }
        let path = self.library.backups_dir().join(port_id).join(backup_id);
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(PortcoveError::not_found(format!(
                    "backup {backup_id} was not found for {port_id}"
                )));
            }
            Err(error) => return Err(error.into()),
        };
        if metadata.file_type().is_symlink() {
            return Err(PortcoveError::verification(format!(
                "backup path is a symbolic link: {}",
                path.display()
            )));
        }
        if !metadata.is_dir() {
            return Err(PortcoveError::not_found(format!(
                "backup {backup_id} was not found for {port_id}"
            )));
        }
        refuse_symlink_ancestors(&path)?;
        let manifest = read_backup_manifest(&path, port_id, backup_id)?;
        Ok(backup_record(manifest, path))
    }

    pub(crate) fn validate_backup_directory_identity(
        &self,
        path: &Path,
        port_id: &str,
        backup_id: &str,
    ) -> Result<()> {
        read_backup_manifest(path, port_id, backup_id).map(|_| ())
    }
}

fn backup_record(manifest: BackupManifest, path: PathBuf) -> BackupRecord {
    BackupRecord {
        id: manifest.id,
        port_id: manifest.port_id,
        path,
        created_at: manifest.created_at,
        file_count: manifest.file_count,
        size: manifest.size,
        sha256: manifest.sha256,
    }
}

fn read_backup_manifest(path: &Path, port_id: &str, backup_id: &str) -> Result<BackupManifest> {
    let manifest_path = path.join("backup.json");
    let metadata = match fs::symlink_metadata(&manifest_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(backup_manifest_error(
                BackupProblemKind::MissingManifest,
                format!("backup manifest is missing: {}", manifest_path.display()),
                &manifest_path,
            ));
        }
        Err(error) => {
            return Err(backup_manifest_error(
                BackupProblemKind::UnreadableManifest,
                format!("backup manifest metadata could not be read: {error}"),
                &manifest_path,
            ));
        }
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(backup_manifest_error(
            BackupProblemKind::UnreadableManifest,
            format!(
                "backup manifest is not an owned regular file: {}",
                manifest_path.display()
            ),
            &manifest_path,
        ));
    }
    let bytes = crate::path::read_bounded_regular(&manifest_path, BACKUP_MANIFEST_MAX_BYTES)
        .map_err(|error| {
            backup_manifest_error(
                BackupProblemKind::UnreadableManifest,
                format!("backup manifest could not be read: {}", error.message),
                &manifest_path,
            )
        })?;
    let manifest: BackupManifest = serde_json::from_slice(&bytes).map_err(|error| {
        backup_manifest_error(
            BackupProblemKind::MalformedManifest,
            format!("backup manifest is malformed: {error}"),
            &manifest_path,
        )
    })?;
    if manifest.id != backup_id || manifest.port_id != port_id {
        return Err(backup_manifest_error(
            BackupProblemKind::IdentityMismatch,
            format!("backup manifest identity does not match {}", path.display()),
            &manifest_path,
        ));
    }
    Ok(manifest)
}

fn backup_manifest_error(kind: BackupProblemKind, message: String, path: &Path) -> PortcoveError {
    let error = match kind {
        BackupProblemKind::MissingManifest => PortcoveError::not_found(message),
        BackupProblemKind::IdentityMismatch
        | BackupProblemKind::MalformedManifest
        | BackupProblemKind::UnsupportedEntry => PortcoveError::verification(message),
        BackupProblemKind::UnreadableManifest | BackupProblemKind::RecoveryRequired => {
            PortcoveError::state(message)
        }
    };
    error
        .detail("backup_problem", backup_problem_name(kind))
        .detail("path", path.display().to_string())
}

fn backup_problem_name(kind: BackupProblemKind) -> &'static str {
    match kind {
        BackupProblemKind::MissingManifest => "missing_manifest",
        BackupProblemKind::UnreadableManifest => "unreadable_manifest",
        BackupProblemKind::MalformedManifest => "malformed_manifest",
        BackupProblemKind::IdentityMismatch => "identity_mismatch",
        BackupProblemKind::UnsupportedEntry => "unsupported_entry",
        BackupProblemKind::RecoveryRequired => "recovery_required",
    }
}

fn backup_problem_kind(error: &PortcoveError) -> BackupProblemKind {
    match error.details.get("backup_problem").map(String::as_str) {
        Some("missing_manifest") => BackupProblemKind::MissingManifest,
        Some("unreadable_manifest") => BackupProblemKind::UnreadableManifest,
        Some("malformed_manifest") => BackupProblemKind::MalformedManifest,
        Some("identity_mismatch") => BackupProblemKind::IdentityMismatch,
        Some("recovery_required") => BackupProblemKind::RecoveryRequired,
        _ => BackupProblemKind::UnsupportedEntry,
    }
}

fn backup_problem(
    kind: BackupProblemKind,
    backup_id: Option<String>,
    path: PathBuf,
    message: String,
) -> BackupProblem {
    BackupProblem {
        kind,
        backup_id,
        operation_id: None,
        path,
        message,
        proposed_action: match kind {
            BackupProblemKind::RecoveryRequired => {
                "restart Portcove to retry recovery; review doctor output if it remains"
            }
            _ => "repair or remove this backup entry after review",
        }
        .into(),
    }
}

fn backup_inventory_state(problems: &[BackupProblem]) -> BackupInventoryState {
    if problems
        .iter()
        .any(|problem| problem.kind == BackupProblemKind::RecoveryRequired)
    {
        BackupInventoryState::RecoveryRequired
    } else if problems.is_empty() {
        BackupInventoryState::Healthy
    } else {
        BackupInventoryState::Degraded
    }
}

fn verify_backup_stats(backup: &BackupRecord, stats: BackupStats) -> Result<()> {
    let BackupStats {
        file_count,
        size,
        hasher,
    } = stats;
    let sha256 = hex::encode(hasher.finalize());
    if file_count != backup.file_count || size != backup.size || sha256 != backup.sha256 {
        return Err(PortcoveError::verification(format!(
            "backup {} failed its integrity check",
            backup.id
        ))
        .detail("expected_files", backup.file_count.to_string())
        .detail("actual_files", file_count.to_string())
        .detail("expected_size", backup.size.to_string())
        .detail("actual_size", size.to_string())
        .detail("expected_sha256", &backup.sha256)
        .detail("actual_sha256", sha256));
    }
    Ok(())
}

fn copy_backup_tree(
    source: &Path,
    destination: &Path,
    source_root: &Path,
    stats: &mut BackupStats,
) -> Result<()> {
    let metadata = fs::symlink_metadata(source)?;
    if metadata.file_type().is_symlink() {
        return Err(PortcoveError::conflict(format!(
            "backup source contains a symbolic link: {}",
            source.display()
        )));
    }
    if metadata.is_file() {
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }
        let relative = source.strip_prefix(source_root).map_err(|_| {
            PortcoveError::state(format!(
                "backup source escaped its root: {}",
                source.display()
            ))
        })?;
        let relative = backup_relative_path(relative)?;
        stats.hasher.update(b"file\0");
        stats.hasher.update(relative.as_bytes());
        stats.hasher.update(b"\0");
        let mut input = fs::File::open(source)?;
        let mut output = fs::File::create(destination)?;
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let read = input.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            output.write_all(&buffer[..read])?;
            stats.hasher.update(&buffer[..read]);
            stats.size += read as u64;
        }
        output.sync_all()?;
        stats.file_count += 1;
        return Ok(());
    }
    if !metadata.is_dir() {
        return Err(PortcoveError::conflict(format!(
            "backup source contains an unsupported entry: {}",
            source.display()
        )));
    }
    let relative = source.strip_prefix(source_root).map_err(|_| {
        PortcoveError::state(format!(
            "backup source escaped its root: {}",
            source.display()
        ))
    })?;
    stats.hasher.update(b"dir\0");
    stats
        .hasher
        .update(backup_relative_path(relative)?.as_bytes());
    stats.hasher.update(b"\0");
    fs::create_dir_all(destination)?;
    let mut entries = fs::read_dir(source)?.collect::<std::io::Result<Vec<_>>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        copy_backup_tree(
            &entry.path(),
            &destination.join(entry.file_name()),
            source_root,
            stats,
        )?;
    }
    Ok(())
}

fn backup_relative_path(path: &Path) -> Result<String> {
    let mut components = Vec::new();
    for component in path.components() {
        let component = component.as_os_str().to_str().ok_or_else(|| {
            PortcoveError::unsupported("Portcove V1 requires backup paths to be valid Unicode")
                .detail("path_role", "backup")
        })?;
        components.push(component);
    }
    Ok(components.join("/"))
}

fn backup_authorization_target(port_id: &str, backup_id: &str) -> String {
    format!("{port_id}\n{backup_id}")
}

fn backup_action_fingerprint(
    action: BackupAction,
    backup: &BackupRecord,
    backup_plan: &AdoptionCopyPlan,
    user_plan: Option<&AdoptionCopyPlan>,
) -> Result<String> {
    let encoded = serde_json::to_vec(&(action, backup, backup_plan, user_plan))?;
    Ok(hex::encode(Sha256::digest(encoded)))
}
