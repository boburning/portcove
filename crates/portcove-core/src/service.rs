use std::{
    collections::HashSet,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
};

use futures_util::{StreamExt, stream};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    ActivityOperation, ActivityRecord, ActivityStatus, ActivityTargetKind, AdapterRegistry,
    BackupRecord, Catalog, ChildProcessPolicy, CompositeReleaseProvider, DoctorReport, InstallPlan,
    InstallPlanAction, InstallQualification, InstallRecord, InstallRequest,
    InstallSourceRequirement, Installer, LaunchBlocker, LaunchReadiness, LaunchSessionPhase,
    LaunchSessionRecord, LaunchStdio, Library, OperationCoordinator, OperationEvent,
    OperationResult, Platform, PortDefinition, PortPaths, PortStatus, PortcoveError,
    ReconcileAction, ReconcileResult, ReleaseChannel, ReleaseProvider, RepairItem, RepairItemKind,
    RepairPlan, ResolvedRelease, RestoreResult, Result, SourceRecord, SourceRemovalPreview,
    SourceRequirementRole, SourceVerification, SupervisedLaunchOutcome, UpdateCheck, UpdatePolicy,
    VerificationReport,
    durability::{prepare_backup_publication, publish_backup_directory},
    operation::{
        LifecycleFaultInjector, LifecycleFaultPoint, LifecycleOperation, LifecycleOperationKind,
        LifecyclePhase, NoLifecycleFaults, OperationStore,
    },
};

const LAUNCH_MARKER: &str = ".portcove-launched";
const BULK_PROVIDER_CONCURRENCY: usize = 4;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct AdoptionCopyFile {
    pub relative_path: PathBuf,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct AdoptionSkippedEntry {
    pub relative_path: PathBuf,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct AdoptionCopyPlan {
    pub directories: Vec<PathBuf>,
    pub files: Vec<AdoptionCopyFile>,
    pub skipped_entries: Vec<AdoptionSkippedEntry>,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct AdoptionPreview {
    pub source: PathBuf,
    pub detected_port_ids: Vec<String>,
    pub selected_port_id: Option<String>,
    pub application_files_will_be_copied: bool,
    pub original_will_be_modified: bool,
    pub copy_plan: AdoptionCopyPlan,
    pub plan_sha256: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum BackupAction {
    Restore,
    Delete,
}

impl BackupAction {
    fn authorization_action(self) -> &'static str {
        match self {
            Self::Restore => "restore_backup",
            Self::Delete => "delete_backup",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct BackupActionPreview {
    pub action: BackupAction,
    pub backup: BackupRecord,
    pub current_user_data_exists: bool,
    pub safety_backup_will_be_created: bool,
    pub preview_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PortRemovalPreview {
    pub port_id: String,
    pub managed_paths: Vec<PathBuf>,
    pub persistent_data_path: PathBuf,
    pub persistent_data_will_be_preserved: bool,
    pub preview_sha256: String,
}

pub struct PortcoveService {
    catalog: Catalog,
    pub(crate) library: Library,
    releases: Arc<dyn ReleaseProvider>,
    adapters: AdapterRegistry,
    faults: Arc<dyn LifecycleFaultInjector>,
}

#[derive(Debug, Clone, Copy)]
struct SourceOverrides<'a> {
    source: Option<&'a Path>,
    bios: Option<&'a Path>,
}

fn artifact_matches_release(install: &InstallRecord, release: &ResolvedRelease) -> bool {
    install
        .artifact
        .sha256
        .eq_ignore_ascii_case(&release.asset.sha256)
        && install.artifact.asset_name == release.asset.name
        && (release.asset.size == 0 || install.artifact.size == release.asset.size)
}

struct OperationReporter<'a, F> {
    operation: &'a OperationCoordinator,
    emit: &'a mut F,
}

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
    pub fn new(library: Library) -> Result<Self> {
        let releases = Arc::new(CompositeReleaseProvider::for_library(&library)?);
        let service = Self {
            catalog: Catalog::embedded()?,
            library,
            releases,
            adapters: AdapterRegistry,
            faults: Arc::new(NoLifecycleFaults),
        };
        service.recover_lifecycle_operations()?;
        Ok(service)
    }

    pub fn with_provider(library: Library, releases: Arc<dyn ReleaseProvider>) -> Result<Self> {
        let service = Self {
            catalog: Catalog::embedded()?,
            library,
            releases,
            adapters: AdapterRegistry,
            faults: Arc::new(NoLifecycleFaults),
        };
        service.recover_lifecycle_operations()?;
        Ok(service)
    }

    #[cfg(test)]
    fn with_provider_and_faults(
        library: Library,
        releases: Arc<dyn ReleaseProvider>,
        faults: Arc<dyn LifecycleFaultInjector>,
    ) -> Result<Self> {
        Ok(Self {
            catalog: Catalog::embedded()?,
            library,
            releases,
            adapters: AdapterRegistry,
            faults,
        })
    }

    pub fn catalog(&self) -> &Catalog {
        &self.catalog
    }
    pub fn library(&self) -> &Library {
        &self.library
    }

    pub fn doctor(&self) -> Result<DoctorReport> {
        let statuses = self.statuses()?;
        Ok(DoctorReport {
            platform: Platform::current()?,
            library: self.library.storage_summary()?,
            catalog_port_count: self.catalog.ports().len(),
            installed_port_count: statuses
                .iter()
                .filter(|status| status.active.is_some())
                .count(),
            registered_source_count: self.library.sources()?.len(),
            host_tools: crate::adapter::host_tool_statuses(),
            repair: self.repair_plan()?,
        })
    }

    pub fn repair_plan(&self) -> Result<RepairPlan> {
        let operations = OperationStore::new(self.library.clone()).all()?;
        let installs = self.library.all_installs()?;
        let registered_paths = installs
            .iter()
            .map(|install| install.path.clone())
            .collect::<HashSet<_>>();
        let pending_final_paths = operations
            .iter()
            .filter_map(|operation| operation.paths.final_path.clone())
            .collect::<HashSet<_>>();
        let mut items = operations
            .iter()
            .map(|operation| RepairItem {
                kind: if operation.phase == LifecyclePhase::CleanupPending {
                    RepairItemKind::CleanupPending
                } else {
                    RepairItemKind::PartialOperation
                },
                operation_id: Some(operation.id.clone()),
                port_id: Some(operation.port_id.clone()),
                path: operation
                    .paths
                    .quarantine
                    .clone()
                    .or_else(|| operation.paths.final_path.clone())
                    .or_else(|| operation.paths.staging.clone()),
                message: operation.last_error.clone().unwrap_or_else(|| {
                    format!(
                        "{} operation is paused at {}",
                        operation.kind, operation.phase
                    )
                }),
                proposed_action: "retry the recorded idempotent recovery step".into(),
            })
            .collect::<Vec<_>>();
        for install in &installs {
            if !install.path.is_dir() {
                items.push(RepairItem {
                    kind: RepairItemKind::MissingRegisteredPath,
                    operation_id: None,
                    port_id: Some(install.port_id.clone()),
                    path: Some(install.path.clone()),
                    message: format!("registered install {} is missing", install.id),
                    proposed_action: "remove or restore the stale metadata after review".into(),
                });
            }
        }
        if self.library.versions_dir().is_dir() {
            for port_entry in fs::read_dir(self.library.versions_dir())? {
                let port_entry = port_entry?;
                if !port_entry.file_type()?.is_dir() {
                    continue;
                }
                for version_entry in fs::read_dir(port_entry.path())? {
                    let version_entry = version_entry?;
                    let path = version_entry.path();
                    if !registered_paths.contains(&path) && !pending_final_paths.contains(&path) {
                        items.push(RepairItem {
                            kind: RepairItemKind::OrphanedFinalDirectory,
                            operation_id: None,
                            port_id: port_entry.file_name().to_str().map(str::to_owned),
                            path: Some(path.clone()),
                            message: "untracked content exists in the managed versions tree".into(),
                            proposed_action: "quarantine for review; never delete automatically"
                                .into(),
                        });
                    }
                }
            }
        }
        items.sort_by(|left, right| {
            left.path
                .cmp(&right.path)
                .then_with(|| left.operation_id.cmp(&right.operation_id))
        });
        Ok(RepairPlan {
            generated_at: Library::now(),
            items,
        })
    }

    fn recover_lifecycle_operations(&self) -> Result<()> {
        let store = OperationStore::new(self.library.clone());
        for mut operation in store.all()? {
            let _guard = match self
                .library
                .try_lock_port(&operation.port_id, "recover-lifecycle-operation")
            {
                Ok(guard) => guard,
                Err(error) if error.code == crate::ErrorCode::Conflict => continue,
                Err(error) => return Err(error),
            };
            if let Err(error) = self.recover_lifecycle_operation(&store, &mut operation) {
                operation.last_error = Some(error.message.clone());
                store.put(&mut operation)?;
                tracing::warn!(
                    operation_id = operation.id,
                    port_id = operation.port_id,
                    "lifecycle recovery requires review: {error}"
                );
            } else {
                let _ = self.library.finish_activity(
                    &operation.id,
                    ActivityStatus::Succeeded,
                    Some("completed during startup recovery"),
                );
            }
        }
        Ok(())
    }

    fn recover_lifecycle_operation(
        &self,
        store: &OperationStore,
        operation: &mut LifecycleOperation,
    ) -> Result<()> {
        match operation.kind {
            LifecycleOperationKind::Install | LifecycleOperationKind::Adopt => {
                self.recover_published_install(store, operation)
            }
            LifecycleOperationKind::Remove => self.recover_removal(store, operation),
            LifecycleOperationKind::Restore => self.recover_restore(store, operation),
            LifecycleOperationKind::Activate => self.recover_activation(store, operation),
        }
    }

    fn recover_published_install(
        &self,
        store: &OperationStore,
        operation: &mut LifecycleOperation,
    ) -> Result<()> {
        crate::recovery::recover_published_install(self, store, operation)
    }

    fn recover_removal(
        &self,
        store: &OperationStore,
        operation: &mut LifecycleOperation,
    ) -> Result<()> {
        crate::recovery::recover_removal(self, store, operation)
    }

    fn recover_restore(
        &self,
        store: &OperationStore,
        operation: &mut LifecycleOperation,
    ) -> Result<()> {
        crate::recovery::recover_restore(store, operation)
    }

    fn recover_activation(
        &self,
        store: &OperationStore,
        operation: &mut LifecycleOperation,
    ) -> Result<()> {
        crate::recovery::recover_activation(self, store, operation)
    }

    pub(crate) fn finish_activity<T>(
        &self,
        activity: ActivityRecord,
        result: Result<T>,
    ) -> Result<T> {
        let (status, message) = match &result {
            Ok(_) => (ActivityStatus::Succeeded, None),
            Err(error) => (ActivityStatus::Failed, Some(error.message.as_str())),
        };
        if let Err(error) = self.library.finish_activity(&activity.id, status, message) {
            tracing::warn!(
                activity_id = activity.id,
                operation = %activity.operation,
                "could not finish activity record: {error}"
            );
        }
        result
    }

    pub fn status(&self, port_id: &str) -> Result<PortStatus> {
        let port = self.catalog.port(port_id)?;
        let registered_sources = self
            .library
            .source_profile_ids()?
            .into_iter()
            .collect::<HashSet<_>>();
        let (mut statuses, metrics) = self
            .library
            .statuses_with_metrics(&[(port_id.to_owned(), default_channel(port))])?;
        tracing::debug!(
            port_count = 1,
            sqlite_query_count = metrics.sqlite_query_count + 1,
            "loaded status read model"
        );
        let status = statuses
            .pop()
            .ok_or_else(|| PortcoveError::state("status read model returned no row"))?;
        Ok(self.with_launch_readiness(port, status, &registered_sources))
    }

    pub fn statuses(&self) -> Result<Vec<PortStatus>> {
        let ports = self
            .catalog
            .ports()
            .iter()
            .map(|port| (port.id.clone(), default_channel(port)))
            .collect::<Vec<_>>();
        let registered_sources = self
            .library
            .source_profile_ids()?
            .into_iter()
            .collect::<HashSet<_>>();
        let (statuses, metrics) = self.library.statuses_with_metrics(&ports)?;
        tracing::debug!(
            port_count = statuses.len(),
            sqlite_query_count = metrics.sqlite_query_count + 1,
            "loaded status read model"
        );
        self.catalog
            .ports()
            .iter()
            .zip(statuses)
            .map(|(port, status)| Ok(self.with_launch_readiness(port, status, &registered_sources)))
            .collect()
    }

    pub async fn plan_install(
        &self,
        port_id: &str,
        channel: Option<ReleaseChannel>,
    ) -> Result<InstallPlan> {
        let port = self.catalog.port(port_id)?;
        let status = self.status(port_id)?;
        let selected_channel = channel.unwrap_or(status.channel);
        if !port.channels.contains(&selected_channel) {
            return Err(PortcoveError::unsupported(format!(
                "{} does not offer {selected_channel}",
                port.name
            )));
        }
        let platform = Platform::current()?;
        if !port.platforms.contains(&platform) {
            return Err(PortcoveError::unsupported(format!(
                "{} does not publish a release for the current platform",
                port.name
            )));
        }
        let release = self
            .releases
            .resolve(port, selected_channel, platform)
            .await?;
        let action = self.install_plan_action(&status, &release)?;
        let source_requirements = self.install_source_requirements(port)?;
        Ok(InstallPlan {
            port_id: port_id.into(),
            channel: selected_channel,
            platform,
            release,
            action,
            source_requirements,
            storage: self.library.storage_summary()?,
        })
    }

    pub fn port_paths(&self, port_id: &str) -> Result<PortPaths> {
        self.catalog.port(port_id)?;
        let status = self.status(port_id)?;
        Ok(PortPaths {
            port_id: port_id.into(),
            library_root: self.library.root().to_path_buf(),
            user_data_root: self.library.user_dir(port_id),
            active_install_root: status.active.map(|install| install.path),
            previous_install_root: status.previous.map(|install| install.path),
            staged_install_root: status.staged.map(|install| install.path),
        })
    }

    pub fn create_backup(&self, port_id: &str) -> Result<BackupRecord> {
        let activity = self.library.begin_activity(
            ActivityOperation::Backup,
            ActivityTargetKind::Port,
            Some(port_id),
        )?;
        let result = (|| {
            self.catalog.port(port_id)?;
            let _operation = self.library.try_lock_port(port_id, "backup")?;
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
        fs::create_dir_all(&parent)?;
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

    pub fn list_backups(&self, port_id: &str) -> Result<Vec<BackupRecord>> {
        self.catalog.port(port_id)?;
        let parent = self.library.backups_dir().join(port_id);
        if !parent.is_dir() {
            return Ok(Vec::new());
        }
        let mut backups = Vec::new();
        for entry in fs::read_dir(parent)? {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            let directory_id = entry.file_name().into_string().map_err(|_| {
                PortcoveError::unsupported("Portcove V1 requires backup paths to be valid Unicode")
                    .detail("path_role", "backup")
            })?;
            if directory_id.starts_with('.') {
                continue;
            }
            let path = entry.path();
            let manifest: BackupManifest =
                serde_json::from_reader(fs::File::open(path.join("backup.json"))?)?;
            if manifest.id != directory_id || manifest.port_id != port_id {
                return Err(PortcoveError::state(format!(
                    "backup manifest identity does not match {}",
                    path.display()
                )));
            }
            backups.push(backup_record(manifest, path));
        }
        backups.sort_by(|left, right| {
            right
                .created_at
                .cmp(&left.created_at)
                .then_with(|| right.id.cmp(&left.id))
        });
        Ok(backups)
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
        let preview = self.preview_backup_action(port_id, backup_id, action)?;
        if preview.preview_sha256 != expected_preview_sha256 {
            return Err(PortcoveError::conflict(
                "backup or persistent data changed after preview; review the operation again",
            ));
        }
        self.library.issue_authorization(
            action.authorization_action(),
            &backup_authorization_target(port_id, backup_id),
            &preview.preview_sha256,
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
            self.collect_active_user_data_if_launched(port_id)?;
            let locked_preview =
                self.preview_backup_action(port_id, backup_id, BackupAction::Restore)?;
            self.library.consume_authorization(
                authorization_token,
                BackupAction::Restore.authorization_action(),
                &backup_authorization_target(port_id, backup_id),
                &locked_preview.preview_sha256,
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
        let result = (|| {
            self.catalog.port(port_id)?;
            let _operation = self.library.try_lock_port(port_id, "delete-backup")?;
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
            let deleting = parent.join(format!(".deleting-{}", Uuid::new_v4()));
            fs::rename(&backup.path, &deleting)?;
            if let Err(delete_error) = fs::remove_dir_all(&deleting) {
                if let Err(rollback_error) = fs::rename(&deleting, &backup.path) {
                    return Err(PortcoveError::state(format!(
                        "backup deletion failed ({delete_error}) and its directory could not be returned ({rollback_error}); recovery data remains at {}",
                        deleting.display()
                    )));
                }
                return Err(delete_error.into());
            }
            Ok(backup)
        })();
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
        let manifest: BackupManifest =
            serde_json::from_reader(fs::File::open(path.join("backup.json"))?)?;
        if manifest.id != backup_id || manifest.port_id != port_id {
            return Err(PortcoveError::verification(format!(
                "backup manifest identity does not match {}",
                path.display()
            )));
        }
        Ok(backup_record(manifest, path))
    }

    fn install_plan_action(
        &self,
        status: &PortStatus,
        release: &ResolvedRelease,
    ) -> Result<InstallPlanAction> {
        if status
            .active
            .as_ref()
            .is_some_and(|install| artifact_matches_release(install, release))
        {
            return Ok(InstallPlanAction::AlreadyActive);
        }
        if status
            .staged
            .as_ref()
            .is_some_and(|install| artifact_matches_release(install, release))
        {
            return Ok(InstallPlanAction::UseStaged);
        }
        let Some(retained) = self
            .library
            .install_by_artifact(&status.port_id, &release.asset.sha256)?
        else {
            return Ok(InstallPlanAction::Download);
        };
        Ok(if retained.verified {
            InstallPlanAction::ReuseRetained
        } else {
            InstallPlanAction::BlockedUnverified
        })
    }

    fn install_source_requirements(
        &self,
        port: &PortDefinition,
    ) -> Result<Vec<InstallSourceRequirement>> {
        let mut requirements = Vec::new();
        for (profile_id, role) in [
            (
                port.source_profile.as_deref(),
                SourceRequirementRole::GameSource,
            ),
            (
                port.bios_source_profile.as_deref(),
                SourceRequirementRole::Bios,
            ),
        ] {
            let Some(profile_id) = profile_id else {
                continue;
            };
            let profile = self.catalog.source_profile(profile_id)?;
            requirements.push(InstallSourceRequirement {
                profile_id: profile_id.into(),
                label: profile.label.clone(),
                role,
                registered: self.library.source(profile_id)?.is_some(),
            });
        }
        Ok(requirements)
    }

    fn with_launch_readiness(
        &self,
        port: &PortDefinition,
        mut status: PortStatus,
        registered_sources: &HashSet<String>,
    ) -> PortStatus {
        let mut blockers = Vec::new();
        if let Some(profile_id) = &port.source_profile
            && !registered_sources.contains(profile_id)
        {
            blockers.push(LaunchBlocker::MissingSource);
        }
        if let Some(profile_id) = &port.bios_source_profile
            && !registered_sources.contains(profile_id)
        {
            blockers.push(LaunchBlocker::MissingBios);
        }
        let pending_setup = status.active.as_ref().is_some_and(|active| {
            port.setup_marker
                .as_ref()
                .is_some_and(|marker| !active.path.join(marker).is_file())
        });
        status.readiness = Some(LaunchReadiness {
            launchable: status.active.is_some() && blockers.is_empty(),
            blockers,
            pending_setup,
        });
        status
    }

    pub async fn check_update(&self, port_id: &str) -> Result<UpdateCheck> {
        self.check_update_with_status(port_id, None).await
    }

    async fn check_update_with_status(
        &self,
        port_id: &str,
        status: Option<PortStatus>,
    ) -> Result<UpdateCheck> {
        let activity = self.library.begin_activity(
            ActivityOperation::CheckUpdate,
            ActivityTargetKind::Port,
            Some(port_id),
        )?;
        let result = async {
            let port = self.catalog.port(port_id)?;
            let status = match status {
                Some(status) => status,
                None => self.status(port_id)?,
            };
            let release = self
                .releases
                .resolve(port, status.channel, Platform::current()?)
                .await?;
            self.record_update_check(port_id, &status, &release)
        }
        .await;
        self.finish_activity(activity, result)
    }

    pub async fn check_updates(
        &self,
        port_ids: impl IntoIterator<Item = String>,
    ) -> Result<Vec<(String, Result<UpdateCheck>)>> {
        let statuses = self
            .statuses()?
            .into_iter()
            .map(|status| (status.port_id.clone(), status))
            .collect::<std::collections::HashMap<_, _>>();
        let jobs = port_ids
            .into_iter()
            .map(|port_id| {
                let status = statuses.get(&port_id).cloned();
                (port_id, status)
            })
            .collect::<Vec<_>>();
        Ok(stream::iter(jobs)
            .map(|(port_id, status)| async move {
                let result = self.check_update_with_status(&port_id, status).await;
                (port_id, result)
            })
            .buffered(BULK_PROVIDER_CONCURRENCY)
            .collect()
            .await)
    }

    fn record_update_check(
        &self,
        port_id: &str,
        status: &PortStatus,
        release: &ResolvedRelease,
    ) -> Result<UpdateCheck> {
        let installed_version = status
            .active
            .as_ref()
            .map(|install| install.version.clone());
        let installed_artifact = status
            .active
            .as_ref()
            .map(|install| install.artifact.clone());
        let update_available = status
            .active
            .as_ref()
            .is_none_or(|install| !artifact_matches_release(install, release));
        let check = UpdateCheck {
            port_id: port_id.into(),
            channel: status.channel,
            installed_version,
            installed_artifact,
            update_available,
            release: release.clone(),
        };
        self.library.store_update_snapshot(&check)?;
        Ok(check)
    }

    pub fn set_channel(&self, port_id: &str, channel: ReleaseChannel) -> Result<PortStatus> {
        let port = self.catalog.port(port_id)?;
        if !port.channels.contains(&channel) {
            return Err(PortcoveError::unsupported(format!(
                "{} does not offer {channel}",
                port.name
            )));
        }
        let _operation = self.library.try_lock_port(port_id, "set-channel")?;
        self.library.set_channel(port_id, channel)?;
        self.status(port_id)
    }

    pub fn set_update_policy(&self, port_id: &str, policy: UpdatePolicy) -> Result<PortStatus> {
        let port = self.catalog.port(port_id)?;
        let _operation = self.library.try_lock_port(port_id, "set-policy")?;
        self.library
            .set_update_policy(port_id, policy, default_channel(port))?;
        self.status(port_id)
    }

    pub fn register_source(&self, profile_id: &str, path: &Path) -> Result<SourceRecord> {
        let activity = self.library.begin_activity(
            ActivityOperation::RegisterSource,
            ActivityTargetKind::Source,
            Some(profile_id),
        )?;
        let result = (|| {
            let _guards = self.lock_source_dependents(profile_id, None)?;
            let profile = self.catalog.source_profile(profile_id)?;
            let source = self
                .adapters
                .get(crate::AdapterKind::ReferencedDisc)
                .validate_source(profile, path)?;
            self.library.register_source(&source)?;
            Ok(source)
        })();
        self.finish_activity(activity, result)
    }

    pub(crate) fn lock_source_dependents(
        &self,
        profile_id: &str,
        already_locked: Option<&str>,
    ) -> Result<Vec<crate::PortOperationGuard>> {
        let mut guards = vec![self.library.try_lock_source(profile_id)?];
        let mut ports: Vec<_> = self
            .catalog
            .ports()
            .iter()
            .filter(|port| {
                port.source_profile.as_deref() == Some(profile_id)
                    || port.bios_source_profile.as_deref() == Some(profile_id)
            })
            .map(|port| port.id.as_str())
            .collect();
        ports.sort_unstable();
        guards.extend(
            ports
                .into_iter()
                .filter(|id| Some(*id) != already_locked)
                .map(|id| self.library.try_lock_port(id, "change-source-reference"))
                .collect::<Result<Vec<_>>>()?,
        );
        Ok(guards)
    }

    pub fn preview_source_removal(&self, profile_id: &str) -> Result<SourceRemovalPreview> {
        self.catalog.source_profile(profile_id)?;
        let source = self.library.source(profile_id)?.ok_or_else(|| {
            PortcoveError::not_found(format!("source profile {profile_id} is not registered"))
        })?;
        let mut dependent_port_ids = self
            .catalog
            .ports()
            .iter()
            .filter(|port| {
                port.source_profile.as_deref() == Some(profile_id)
                    || port.bios_source_profile.as_deref() == Some(profile_id)
            })
            .map(|port| port.id.clone())
            .collect::<Vec<_>>();
        dependent_port_ids.sort();
        let mut installed_dependent_port_ids = Vec::new();
        for port_id in &dependent_port_ids {
            if self.status(port_id)?.active.is_some() {
                installed_dependent_port_ids.push(port_id.clone());
            }
        }
        Ok(SourceRemovalPreview {
            preview_sha256: source_removal_fingerprint(
                &source,
                &dependent_port_ids,
                &installed_dependent_port_ids,
            )?,
            source,
            dependent_port_ids,
            installed_dependent_port_ids,
        })
    }

    pub fn authorize_source_removal(
        &self,
        profile_id: &str,
        expected_preview_sha256: &str,
    ) -> Result<crate::DestructiveAuthorization> {
        let preview = self.preview_source_removal(profile_id)?;
        if preview.preview_sha256 != expected_preview_sha256 {
            return Err(PortcoveError::conflict(
                "the source or its installed dependents changed after the removal preview",
            )
            .detail("profile_id", profile_id));
        }
        self.library
            .issue_authorization("remove_source", profile_id, &preview.preview_sha256)
    }

    pub fn remove_source(
        &self,
        profile_id: &str,
        authorization_token: &str,
    ) -> Result<SourceRemovalPreview> {
        let activity = self.library.begin_activity(
            ActivityOperation::RemoveSource,
            ActivityTargetKind::Source,
            Some(profile_id),
        )?;
        let result = (|| {
            let _guards = self.lock_source_dependents(profile_id, None)?;
            let locked_preview = self.preview_source_removal(profile_id).map_err(|error| {
                if error.code == crate::ErrorCode::NotFound {
                    PortcoveError::conflict("the registered source was removed after its preview")
                        .detail("profile_id", profile_id)
                } else {
                    error
                }
            })?;
            self.library.consume_authorization(
                authorization_token,
                "remove_source",
                profile_id,
                &locked_preview.preview_sha256,
            )?;
            if !self.library.remove_source(profile_id)? {
                return Err(PortcoveError::conflict(
                    "the registered source was removed concurrently",
                )
                .detail("profile_id", profile_id));
            }
            Ok(locked_preview)
        })();
        self.finish_activity(activity, result)
    }

    pub fn verify_source(&self, profile_id: &str) -> Result<SourceVerification> {
        let activity = self.library.begin_activity(
            ActivityOperation::VerifySource,
            ActivityTargetKind::Source,
            Some(profile_id),
        )?;
        let result = self.verify_source_untracked(profile_id);
        self.finish_activity(activity, result)
    }

    fn verify_source_untracked(&self, profile_id: &str) -> Result<SourceVerification> {
        let registered = self.library.source(profile_id)?.ok_or_else(|| {
            PortcoveError::not_found(format!("source profile {profile_id} is not registered"))
        })?;
        self.verify_source_record(&registered)?;
        Ok(SourceVerification {
            profile_id: registered.profile_id,
            path: registered.path,
            sha256: registered.sha256,
            size: registered.size,
            storage_sha256: registered.storage_sha256,
            storage_size: registered.storage_size,
            registered_at: registered.updated_at,
            verified_at: Library::now(),
        })
    }

    fn verify_source_record(&self, registered: &SourceRecord) -> Result<()> {
        let profile_id = &registered.profile_id;
        let profile = self.catalog.source_profile(profile_id)?;
        let actual = self
            .adapters
            .get(crate::AdapterKind::ReferencedDisc)
            .validate_source(profile, &registered.path)?;
        if actual.sha256 != registered.sha256
            || actual.size != registered.size
            || actual.storage_sha256 != registered.storage_sha256
            || actual.storage_size != registered.storage_size
        {
            return Err(PortcoveError::source(format!(
                "source changed since registration: {}",
                registered.path.display()
            ))
            .detail("profile_id", profile_id)
            .detail("recorded_sha256", registered.sha256.clone())
            .detail("actual_sha256", actual.sha256)
            .detail("recorded_size", registered.size.to_string())
            .detail("actual_size", actual.size.to_string())
            .detail("recorded_storage_sha256", registered.storage_sha256.clone())
            .detail("actual_storage_sha256", actual.storage_sha256)
            .detail("recorded_storage_size", registered.storage_size.to_string())
            .detail("actual_storage_size", actual.storage_size.to_string()));
        }
        Ok(())
    }

    fn verified_source_record(&self, profile_id: &str) -> Result<SourceRecord> {
        let verified = self.verify_source_untracked(profile_id)?;
        Ok(SourceRecord {
            profile_id: verified.profile_id,
            path: verified.path,
            sha256: verified.sha256,
            size: verified.size,
            storage_sha256: verified.storage_sha256,
            storage_size: verified.storage_size,
            updated_at: verified.registered_at,
        })
    }

    pub async fn install<F>(
        &self,
        port_id: &str,
        channel: Option<ReleaseChannel>,
        source_override: Option<&Path>,
        bios_override: Option<&Path>,
        activate: bool,
        mut emit: F,
    ) -> Result<InstallRecord>
    where
        F: FnMut(OperationEvent),
    {
        let activity = self.library.begin_activity(
            ActivityOperation::Install,
            ActivityTargetKind::Port,
            Some(port_id),
        )?;
        let operation = OperationCoordinator::from_activity(&activity);
        emit(operation.started());
        let result = async {
            let port = self.catalog.port(port_id)?;
            let _operation = self.library.try_lock_port(port_id, "install")?;
            let status = self.status(port_id)?;
            let selected_channel = channel.unwrap_or(status.channel);
            if !port.channels.contains(&selected_channel) {
                return Err(PortcoveError::unsupported(format!(
                    "{} does not offer {selected_channel}",
                    port.name
                )));
            }
            let platform = Platform::current()?;
            let release = self
                .releases
                .resolve(port, selected_channel, platform)
                .await?;
            let mut reporter = OperationReporter {
                operation: &operation,
                emit: &mut emit,
            };
            self.apply_resolved_release(
                port,
                status,
                SourceOverrides {
                    source: source_override,
                    bios: bios_override,
                },
                release,
                activate,
                &mut reporter,
            )
            .await
        }
        .await;
        emit(operation.finished(if result.is_ok() {
            OperationResult::Succeeded
        } else {
            OperationResult::Failed
        }));
        self.finish_activity(activity, result)
    }

    pub async fn ensure<F>(
        &self,
        port_id: &str,
        channel: Option<ReleaseChannel>,
        source_override: Option<&Path>,
        bios_override: Option<&Path>,
        emit: F,
    ) -> Result<InstallRecord>
    where
        F: FnMut(OperationEvent),
    {
        if let Some(active) = self.status(port_id)?.active {
            return Ok(active);
        }
        self.install(port_id, channel, source_override, bios_override, true, emit)
            .await
    }

    pub async fn update<F>(
        &self,
        port_id: &str,
        source_override: Option<&Path>,
        bios_override: Option<&Path>,
        activate: bool,
        mut emit: F,
    ) -> Result<InstallRecord>
    where
        F: FnMut(OperationEvent),
    {
        let activity = self.library.begin_activity(
            ActivityOperation::Update,
            ActivityTargetKind::Port,
            Some(port_id),
        )?;
        let operation = OperationCoordinator::from_activity(&activity);
        emit(operation.started());
        let result = async {
            let _operation = self.library.try_lock_port(port_id, "update")?;
            let status = self.status(port_id)?;
            let port = self.catalog.port(port_id)?;
            let release = self
                .releases
                .resolve(port, status.channel, Platform::current()?)
                .await?;
            self.record_update_check(port_id, &status, &release)?;
            let mut reporter = OperationReporter {
                operation: &operation,
                emit: &mut emit,
            };
            self.apply_resolved_release(
                port,
                status,
                SourceOverrides {
                    source: source_override,
                    bios: bios_override,
                },
                release,
                activate,
                &mut reporter,
            )
            .await
        }
        .await;
        emit(operation.finished(if result.is_ok() {
            OperationResult::Succeeded
        } else {
            OperationResult::Failed
        }));
        self.finish_activity(activity, result)
    }

    async fn apply_resolved_release<F>(
        &self,
        port: &PortDefinition,
        status: PortStatus,
        overrides: SourceOverrides<'_>,
        release: ResolvedRelease,
        activate: bool,
        reporter: &mut OperationReporter<'_, F>,
    ) -> Result<InstallRecord>
    where
        F: FnMut(OperationEvent),
    {
        if let Some(active) = &status.active
            && artifact_matches_release(active, &release)
        {
            Installer::new(self.library.clone())?.verify_critical(active)?;
            return Ok(active.clone());
        }
        if let Some(staged) = &status.staged
            && artifact_matches_release(staged, &release)
        {
            Installer::new(self.library.clone())?.verify_critical(staged)?;
            return if activate {
                self.activate_staged_locked(&port.id, reporter.operation.operation_id())
            } else {
                Ok(staged.clone())
            };
        }
        if let Some(mut existing) = self
            .library
            .install_by_artifact(&port.id, &release.asset.sha256)?
        {
            Installer::new(self.library.clone())?.verify_critical(&existing)?;
            self.collect_active_user_data_if_launched(&port.id)?;
            self.library.register_install(&existing, activate)?;
            existing.staged = !activate;
            return Ok(existing);
        }
        self.collect_active_user_data_if_launched(&port.id)?;
        let source = self.validate_and_remember_source(port, overrides.source)?;
        let bios = self.validate_and_remember_bios(port, overrides.bios)?;
        let platform = Platform::current()?;
        let qualification = InstallQualification::from_port(port, platform)?;
        let managed = self
            .managed_preparation(
                port,
                source,
                bios,
                platform,
                reporter.operation,
                &mut *reporter.emit,
            )
            .await?;
        Installer::with_faults(self.library.clone(), self.faults.clone())?
            .install(
                InstallRequest {
                    port_id: port.id.clone(),
                    release,
                    activate,
                    managed,
                    qualification,
                },
                reporter.operation,
                &mut *reporter.emit,
            )
            .await
    }

    pub async fn reconcile<F>(&self, port_id: &str, mut emit: F) -> Result<ReconcileResult>
    where
        F: FnMut(OperationEvent),
    {
        let activity = self.library.begin_activity(
            ActivityOperation::Reconcile,
            ActivityTargetKind::Port,
            Some(port_id),
        )?;
        let operation = OperationCoordinator::from_activity(&activity);
        emit(operation.started());
        let result = async {
            let port = self.catalog.port(port_id)?;
            for attempt in 0..2 {
                let optimistic = self.status(port_id)?;
                if optimistic.active.is_none() {
                    return Err(PortcoveError::not_found(format!(
                        "{port_id} is not installed"
                    )));
                }
                let release = self
                    .releases
                    .resolve(port, optimistic.channel, Platform::current()?)
                    .await?;
                let _port_lock = self.library.try_lock_port(port_id, "reconcile")?;
                let status = self.status(port_id)?;
                if status.channel != optimistic.channel {
                    if attempt == 0 {
                        continue;
                    }
                    return Err(PortcoveError::conflict(
                        "the update channel changed repeatedly while resolving a release",
                    )
                    .detail("port_id", port_id)
                    .detail("resolved_channel", optimistic.channel.to_string())
                    .detail("current_channel", status.channel.to_string()));
                }
                if status.active.is_none() {
                    return Err(PortcoveError::conflict(
                        "the active install changed while resolving an update",
                    )
                    .detail("port_id", port_id));
                }
                let check = self.record_update_check(port_id, &status, &release)?;
                if !check.update_available {
                    return Ok(ReconcileResult {
                        port_id: port_id.into(),
                        policy: status.update_policy,
                        action: ReconcileAction::UpToDate,
                        check,
                        install: status.active,
                    });
                }
                if status.update_policy == UpdatePolicy::Notify {
                    return Ok(ReconcileResult {
                        port_id: port_id.into(),
                        policy: status.update_policy,
                        action: ReconcileAction::Notify,
                        check,
                        install: None,
                    });
                }
                let activate = status.update_policy == UpdatePolicy::Automatic;
                let mut reporter = OperationReporter {
                    operation: &operation,
                    emit: &mut emit,
                };
                let install = self
                    .apply_resolved_release(
                        port,
                        status,
                        SourceOverrides {
                            source: None,
                            bios: None,
                        },
                        release,
                        activate,
                        &mut reporter,
                    )
                    .await?;
                return Ok(ReconcileResult {
                    port_id: port_id.into(),
                    policy: if activate {
                        UpdatePolicy::Automatic
                    } else {
                        UpdatePolicy::Stage
                    },
                    action: if activate {
                        ReconcileAction::Activated
                    } else {
                        ReconcileAction::Staged
                    },
                    check,
                    install: Some(install),
                });
            }
            unreachable!("bounded reconcile loop always returns")
        }
        .await;
        emit(operation.finished(if result.is_ok() {
            OperationResult::Succeeded
        } else {
            OperationResult::Failed
        }));
        self.finish_activity(activity, result)
    }

    fn validate_and_remember_source(
        &self,
        port: &PortDefinition,
        source_override: Option<&Path>,
    ) -> Result<Option<SourceRecord>> {
        let Some(profile_id) = &port.source_profile else {
            return Ok(None);
        };
        let profile = self.catalog.source_profile(profile_id)?;
        let adapter = self.adapters.get(port.adapter);
        if let Some(path) = source_override {
            let _guards = self.lock_source_dependents(profile_id, Some(&port.id))?;
            let source = adapter.validate_source(profile, path)?;
            self.library.register_source(&source)?;
            return Ok(Some(source));
        }
        self.verified_source_record(profile_id)
            .map(Some)
            .map_err(|error| {
                if error.code == crate::ErrorCode::NotFound {
                    PortcoveError::source(format!(
                        "{} requires source profile {profile_id}; pass --source or register it first",
                        port.name
                    ))
                } else {
                    error
                }
            })
    }

    fn validate_and_remember_bios(
        &self,
        port: &PortDefinition,
        bios_override: Option<&Path>,
    ) -> Result<Option<SourceRecord>> {
        let Some(profile_id) = &port.bios_source_profile else {
            return Ok(None);
        };
        let profile = self.catalog.source_profile(profile_id)?;
        let adapter = self.adapters.get(port.adapter);
        if let Some(path) = bios_override {
            let _guards = self.lock_source_dependents(profile_id, Some(&port.id))?;
            let source = adapter.validate_source(profile, path)?;
            self.library.register_source(&source)?;
            return Ok(Some(source));
        }
        self.verified_source_record(profile_id)
            .map(Some)
            .map_err(|error| {
                if error.code == crate::ErrorCode::NotFound {
                    PortcoveError::source(format!(
                        "{} requires BIOS profile {profile_id}; pass --bios or register it first",
                        port.name
                    ))
                } else {
                    error
                }
            })
    }

    async fn managed_preparation<F>(
        &self,
        port: &PortDefinition,
        source: Option<SourceRecord>,
        bios: Option<SourceRecord>,
        platform: Platform,
        operation: &OperationCoordinator,
        emit: &mut F,
    ) -> Result<Option<crate::PsxManagedPreparation>>
    where
        F: FnMut(OperationEvent),
    {
        if port.adapter != crate::AdapterKind::PsxRecompManaged {
            return Ok(None);
        }
        let source = source.ok_or_else(|| {
            PortcoveError::source(format!("{} requires a verified PS1 disc", port.name))
        })?;
        let profile_id = port
            .source_profile
            .as_deref()
            .ok_or_else(|| PortcoveError::state("managed PS1 port has no source profile"))?;
        let profile = self.catalog.source_profile(profile_id)?;
        let expected_discs = profile
            .disc
            .as_ref()
            .map(|disc| disc.discs.len().max(1))
            .unwrap_or(1);
        let source_paths = crate::adapter::psx_source_paths(&source.path, expected_discs)?;
        let hint = port
            .executable_hints
            .get(&platform)
            .and_then(|hints| hints.first())
            .ok_or_else(|| {
                PortcoveError::unsupported(format!(
                    "{} has no managed executable contract for {platform:?}",
                    port.name
                ))
            })?;
        if hint.contains('/') || hint.contains('\\') {
            return Err(PortcoveError::verification(
                "managed executable hint must be a filename",
            ));
        }
        let executable_basename = hint
            .strip_suffix(".exe")
            .or_else(|| hint.strip_suffix(".EXE"))
            .unwrap_or(hint)
            .to_string();
        let toolchain_root =
            crate::psx::ensure_toolchain(&self.library, platform, operation, emit).await?;
        Ok(Some(crate::PsxManagedPreparation {
            source,
            bios,
            source_paths,
            toolchain_root,
            executable_basename,
        }))
    }

    pub fn verify(&self, port_id: &str) -> Result<VerificationReport> {
        let activity = self.library.begin_activity(
            ActivityOperation::VerifyInstall,
            ActivityTargetKind::Port,
            Some(port_id),
        )?;
        let result = (|| {
            let _operation = self.library.try_lock_port(port_id, "verify")?;
            let active = self
                .status(port_id)?
                .active
                .ok_or_else(|| PortcoveError::not_found(format!("{port_id} is not installed")))?;
            Installer::new(self.library.clone())?.verify(&active)
        })();
        self.finish_activity(activity, result)
    }

    pub fn rollback(&self, port_id: &str) -> Result<InstallRecord> {
        let activity = self.library.begin_activity(
            ActivityOperation::Rollback,
            ActivityTargetKind::Port,
            Some(port_id),
        )?;
        let result = (|| {
            self.catalog.port(port_id)?;
            let _operation = self.library.try_lock_port(port_id, "rollback")?;
            let previous = self.status(port_id)?.previous.ok_or_else(|| {
                PortcoveError::not_found(format!("{port_id} has no rollback version"))
            })?;
            Installer::new(self.library.clone())?.verify_critical(&previous)?;
            self.collect_active_user_data_if_launched(port_id)?;
            self.library.rollback(port_id)
        })();
        self.finish_activity(activity, result)
    }

    pub fn activate_staged(&self, port_id: &str) -> Result<InstallRecord> {
        let activity = self.library.begin_activity(
            ActivityOperation::Activate,
            ActivityTargetKind::Port,
            Some(port_id),
        )?;
        let result = (|| {
            self.catalog.port(port_id)?;
            let _operation = self.library.try_lock_port(port_id, "activate")?;
            self.activate_staged_locked(port_id, &activity.id)
        })();
        self.finish_activity(activity, result)
    }

    fn activate_staged_locked(&self, port_id: &str, operation_id: &str) -> Result<InstallRecord> {
        let staged = self
            .status(port_id)?
            .staged
            .ok_or_else(|| PortcoveError::not_found(format!("{port_id} has no staged version")))?;
        Installer::new(self.library.clone())?.verify_critical(&staged)?;
        let store = OperationStore::new(self.library.clone());
        let mut lifecycle =
            LifecycleOperation::new(operation_id, LifecycleOperationKind::Activate, port_id);
        lifecycle.install = Some(staged);
        store.put(&mut lifecycle)?;
        let result: Result<InstallRecord> = (|| {
            self.collect_active_user_data_if_launched(port_id)?;
            let activated = self.library.activate_staged(port_id)?;
            lifecycle.phase = LifecyclePhase::MetadataCommitted;
            store.put(&mut lifecycle)?;
            self.faults
                .check(LifecycleFaultPoint::ActivationMetadataCommitted)?;
            store.remove(&lifecycle.id)?;
            Ok(activated)
        })();
        if let Err(error) = &result {
            if lifecycle.phase == LifecyclePhase::Preparing {
                let _ = store.remove(&lifecycle.id);
            } else {
                lifecycle.last_error = Some(error.message.clone());
                let _ = store.put(&mut lifecycle);
            }
        }
        result
    }

    pub fn preview_adoption(
        &self,
        source: &Path,
        selected_port_id: Option<&str>,
    ) -> Result<AdoptionPreview> {
        crate::path::unicode(source, "adoption source")?;
        if !source.is_dir() {
            return Err(PortcoveError::not_found(format!(
                "adoption path is not a directory: {}",
                source.display()
            )));
        }
        let platform = Platform::current()?;
        let mut detected = Vec::new();
        if let Some(id) = selected_port_id {
            let port = self.catalog.port(id)?;
            let qualification = InstallQualification::from_port(port, platform)?;
            crate::install::resolve_declared_executable(source, &qualification)?;
            detected.push(id.to_owned());
        } else {
            for port in self
                .catalog
                .ports()
                .iter()
                .filter(|port| port.platforms.contains(&platform))
            {
                if port
                    .executable_hints
                    .get(&platform)
                    .is_none_or(Vec::is_empty)
                {
                    continue;
                }
                if InstallQualification::from_port(port, platform)
                    .and_then(|qualification| {
                        crate::install::resolve_declared_executable(source, &qualification)
                    })
                    .is_ok()
                {
                    detected.push(port.id.clone());
                }
            }
        }
        let selected = match detected.as_slice() {
            [only] => Some(only.clone()),
            [] => None,
            _ => None,
        };
        let copy_plan = adoption_copy_plan(source)?;
        let plan_sha256 =
            adoption_plan_fingerprint(source, &detected, selected.as_deref(), &copy_plan)?;
        Ok(AdoptionPreview {
            source: source.to_path_buf(),
            detected_port_ids: detected,
            selected_port_id: selected,
            application_files_will_be_copied: true,
            original_will_be_modified: false,
            copy_plan,
            plan_sha256,
        })
    }

    pub fn authorize_adoption(
        &self,
        source: &Path,
        selected_port_id: Option<&str>,
        expected_plan_sha256: &str,
    ) -> Result<crate::DestructiveAuthorization> {
        let preview = self.preview_adoption(source, selected_port_id)?;
        if preview.plan_sha256 != expected_plan_sha256 {
            return Err(PortcoveError::conflict(
                "adoption contents changed after preview; review the copy plan again",
            ));
        }
        let target = adoption_authorization_target(source, selected_port_id)?;
        self.library
            .issue_authorization("adopt", &target, &preview.plan_sha256)
    }

    pub fn adopt(
        &self,
        source: &Path,
        selected_port_id: Option<&str>,
        authorization_token: &str,
    ) -> Result<InstallRecord> {
        let preview = self.preview_adoption(source, selected_port_id)?;
        let port_id = preview.selected_port_id.ok_or_else(|| {
            if preview.detected_port_ids.is_empty() {
                PortcoveError::not_found(
                    "no supported Portcove installation was detected; provide --port",
                )
            } else {
                PortcoveError::conflict(format!(
                    "multiple ports detected: {}",
                    preview.detected_port_ids.join(", ")
                ))
            }
        })?;
        let activity = self.library.begin_activity(
            ActivityOperation::Adopt,
            ActivityTargetKind::Port,
            Some(&port_id),
        )?;
        let store = OperationStore::new(self.library.clone());
        let mut lifecycle =
            LifecycleOperation::new(&activity.id, LifecycleOperationKind::Adopt, &port_id);
        let operation_root = self.library.staging_dir().join(&activity.id);
        let timestamp = Library::now();
        let version = format!("adopted-{timestamp}");
        lifecycle.paths.staging = Some(operation_root.clone());
        lifecycle.activate = true;
        store.put(&mut lifecycle)?;
        let result = (|| {
            let port = self.catalog.port(&port_id)?;
            let platform = Platform::current()?;
            let qualification = InstallQualification::from_port(port, platform)?;
            let _operation = self.library.try_lock_port(&port_id, "adopt")?;
            let locked_preview = self.preview_adoption(source, selected_port_id)?;
            let target = adoption_authorization_target(source, selected_port_id)?;
            self.library.consume_authorization(
                authorization_token,
                "adopt",
                &target,
                &locked_preview.plan_sha256,
            )?;
            let payload_root = operation_root.join("payload");
            let staged_user = operation_root.join("user");
            fs::create_dir_all(&operation_root)?;
            copy_adoption_plan(source, &payload_root, &locked_preview.copy_plan)?;
            let copied_plan = adoption_copy_plan(&payload_root)?;
            if copied_plan.directories != locked_preview.copy_plan.directories
                || copied_plan.files != locked_preview.copy_plan.files
                || !copied_plan.skipped_entries.is_empty()
            {
                return Err(PortcoveError::conflict(
                    "adoption source changed while it was being copied; no install was activated",
                ));
            }
            let copied_executable =
                crate::install::resolve_declared_executable(&payload_root, &qualification)?;
            let persistent_root = qualification.persistence_root(&payload_root, &copied_executable);
            for relative in &port.persistent_paths {
                let candidate = persistent_root.join(relative);
                if candidate.exists() {
                    copy_entry(&candidate, &staged_user.join(relative))?;
                }
            }
            let installer = Installer::new(self.library.clone())?;
            let artifact = crate::install::local_artifact_identity(&payload_root, &qualification)?;
            let destination = self
                .library
                .versions_dir()
                .join(&port_id)
                .join(&artifact.sha256);
            if destination.exists() {
                return Err(PortcoveError::conflict(
                    "an identical adopted artifact already exists",
                ));
            }
            lifecycle.paths.final_path = Some(destination.clone());
            store.put(&mut lifecycle)?;
            let (manifest_sha256, selected_executable) = installer.create_manifest(
                &activity.id,
                &port_id,
                &version,
                &artifact,
                &qualification,
                &payload_root,
            )?;
            let install = InstallRecord {
                id: activity.id.clone(),
                port_id: port_id.clone(),
                version: version.clone(),
                path: destination.clone(),
                channel: default_channel(port),
                installed_at: timestamp,
                verified: true,
                staged: false,
                artifact,
                manifest_sha256,
                selected_executable,
            };
            let staged_install = InstallRecord {
                path: payload_root.clone(),
                ..install.clone()
            };
            if !installer.verify(&staged_install)?.valid {
                return Err(PortcoveError::verification(
                    "adopted payload failed its post-copy manifest verification",
                ));
            }
            lifecycle.install = Some(install.clone());
            lifecycle.phase = LifecyclePhase::Prepared;
            store.put(&mut lifecycle)?;
            self.faults.check(LifecycleFaultPoint::AdoptionPrepared)?;
            fs::create_dir_all(
                destination
                    .parent()
                    .expect("version directory has a parent"),
            )?;
            fs::rename(&payload_root, &destination)?;
            lifecycle.phase = LifecyclePhase::PayloadPublished;
            store.put(&mut lifecycle)?;
            self.faults.check(LifecycleFaultPoint::AdoptionPublished)?;
            self.library.register_install(&install, true)?;
            lifecycle.phase = LifecyclePhase::MetadataCommitted;
            store.put(&mut lifecycle)?;
            self.faults
                .check(LifecycleFaultPoint::AdoptionMetadataCommitted)?;
            if staged_user.exists() {
                copy_tree(&staged_user, &self.library.user_dir(&port_id))?;
            }
            if let Err(error) = fs::remove_dir_all(&operation_root) {
                lifecycle.phase = LifecyclePhase::CleanupPending;
                lifecycle.last_error = Some(error.to_string());
                store.put(&mut lifecycle)?;
                return Ok(install);
            }
            store.remove(&lifecycle.id)?;
            Ok(install)
        })();
        if let Err(error) = &result {
            if lifecycle.phase == LifecyclePhase::Preparing {
                let _ = fs::remove_dir_all(&operation_root);
                let _ = store.remove(&lifecycle.id);
            } else {
                lifecycle.last_error = Some(error.message.clone());
                let _ = store.put(&mut lifecycle);
            }
        }
        self.finish_activity(activity, result)
    }

    pub fn preview_removal(&self, port_id: &str) -> Result<PortRemovalPreview> {
        self.catalog.port(port_id)?;
        let mut installs = self
            .library
            .all_installs()?
            .into_iter()
            .filter(|install| install.port_id == port_id)
            .collect::<Vec<_>>();
        installs.sort_by(|left, right| left.id.cmp(&right.id));
        if installs.is_empty() {
            return Err(PortcoveError::not_found(format!(
                "{port_id} is not installed"
            )));
        }
        let managed_paths = installs
            .iter()
            .map(|install| install.path.clone())
            .collect();
        let preview_sha256 = hex::encode(Sha256::digest(serde_json::to_vec(&installs)?));
        Ok(PortRemovalPreview {
            port_id: port_id.to_owned(),
            managed_paths,
            persistent_data_path: self.library.user_dir(port_id),
            persistent_data_will_be_preserved: true,
            preview_sha256,
        })
    }

    pub fn authorize_removal(
        &self,
        port_id: &str,
        expected_preview_sha256: &str,
    ) -> Result<crate::DestructiveAuthorization> {
        let preview = self.preview_removal(port_id)?;
        if preview.preview_sha256 != expected_preview_sha256 {
            return Err(PortcoveError::conflict(
                "managed installs changed after preview; review removal again",
            ));
        }
        self.library
            .issue_authorization("remove", port_id, &preview.preview_sha256)
    }

    pub fn remove(&self, port_id: &str, authorization_token: &str) -> Result<Vec<PathBuf>> {
        let activity = self.library.begin_activity(
            ActivityOperation::Remove,
            ActivityTargetKind::Port,
            Some(port_id),
        )?;
        let store = OperationStore::new(self.library.clone());
        let mut lifecycle =
            LifecycleOperation::new(&activity.id, LifecycleOperationKind::Remove, port_id);
        let quarantine = self.library.recovery_dir().join(&activity.id);
        lifecycle.paths.quarantine = Some(quarantine.clone());
        store.put(&mut lifecycle)?;
        let result = (|| {
            self.catalog.port(port_id)?;
            let _operation = self.library.try_lock_port(port_id, "remove")?;
            self.collect_active_user_data_if_launched(port_id)?;
            let locked_preview = self.preview_removal(port_id)?;
            self.library.consume_authorization(
                authorization_token,
                "remove",
                port_id,
                &locked_preview.preview_sha256,
            )?;
            let paths = self.library.port_install_paths(port_id)?;
            for path in &paths {
                if !path.starts_with(self.library.versions_dir()) || !path.is_dir() {
                    return Err(PortcoveError::conflict(format!(
                        "registered install is not a managed version directory: {}",
                        path.display()
                    )));
                }
            }
            lifecycle.original_paths = paths.clone();
            store.put(&mut lifecycle)?;
            for path in &paths {
                let relative = path
                    .strip_prefix(self.library.versions_dir())
                    .map_err(|_| {
                        PortcoveError::state("managed install escaped the versions directory")
                    })?;
                let quarantined = quarantine.join(relative);
                if let Some(parent) = quarantined.parent() {
                    fs::create_dir_all(parent)?;
                }
                fs::rename(path, quarantined)?;
            }
            lifecycle.phase = LifecyclePhase::PayloadPublished;
            store.put(&mut lifecycle)?;
            self.faults.check(LifecycleFaultPoint::RemovalQuarantined)?;
            self.library.remove_port(port_id)?;
            lifecycle.phase = LifecyclePhase::MetadataCommitted;
            store.put(&mut lifecycle)?;
            self.faults
                .check(LifecycleFaultPoint::RemovalMetadataCommitted)?;
            self.faults.check(LifecycleFaultPoint::RemovalCleanup)?;
            if quarantine.exists()
                && let Err(error) = fs::remove_dir_all(&quarantine)
            {
                lifecycle.phase = LifecyclePhase::CleanupPending;
                lifecycle.last_error = Some(error.to_string());
                store.put(&mut lifecycle)?;
                return Ok(paths);
            }
            store.remove(&lifecycle.id)?;
            Ok(paths)
        })();
        if let Err(error) = &result {
            lifecycle.last_error = Some(error.message.clone());
            let _ = store.put(&mut lifecycle);
        }
        self.finish_activity(activity, result)
    }

    /// Owns a launch from preparation through exact-install save collection.
    ///
    /// Callers may use `on_started` to report the durable session after the
    /// child PID has been recorded. The callback is observational only: its
    /// result cannot shorten the supervision lifetime or release the port lock.
    pub fn supervise_launch<F>(
        &self,
        port_id: &str,
        source_override: Option<&Path>,
        arguments: &[String],
        stdio: LaunchStdio,
        on_started: F,
    ) -> Result<SupervisedLaunchOutcome>
    where
        F: FnOnce(&LaunchSessionRecord),
    {
        let _operation = self.library.try_lock_port(port_id, "launch")?;
        let activity = self.library.begin_activity(
            ActivityOperation::Launch,
            ActivityTargetKind::Port,
            Some(port_id),
        )?;
        let mut session_created = false;
        let result = (|| {
            let spec = self.launch_spec(port_id, source_override)?;
            let install = self
                .library
                .all_installs()?
                .into_iter()
                .find(|install| install.port_id == port_id && install.path == spec.install_root)
                .ok_or_else(|| {
                    PortcoveError::state(format!(
                        "the prepared {port_id} launch is not bound to a registered install"
                    ))
                })?;
            let now = Library::now();
            let mut session = LaunchSessionRecord {
                id: activity.id.clone(),
                port_id: port_id.to_owned(),
                install_id: install.id,
                install_root: install.path,
                supervisor_pid: std::process::id(),
                child_pid: None,
                phase: LaunchSessionPhase::Preparing,
                started_at: now,
                updated_at: now,
            };
            let mut command = ChildProcessPolicy::game_command(&spec.process_spec(), arguments)?;
            match stdio {
                LaunchStdio::Inherit => {
                    command
                        .stdin(Stdio::inherit())
                        .stdout(Stdio::inherit())
                        .stderr(Stdio::inherit());
                }
                LaunchStdio::Null => {
                    command
                        .stdin(Stdio::null())
                        .stdout(Stdio::null())
                        .stderr(Stdio::null());
                }
            }
            crate::launch::configure_supervised_game(&mut command);
            self.library.create_launch_session(&session)?;
            session_created = true;
            let mut child = match command.spawn() {
                Ok(child) => child,
                Err(error) => {
                    self.library.remove_launch_session(&session.id)?;
                    session_created = false;
                    return Err(PortcoveError::launch(format!(
                        "failed to start {}: {error}",
                        spec.executable.display()
                    )));
                }
            };
            let child_pid = child.id();
            if let Err(error) = self.library.update_launch_session(
                &session.id,
                Some(child_pid),
                LaunchSessionPhase::Running,
            ) {
                let _ = child.kill();
                let _ = child.wait();
                let _ = self.library.remove_launch_session(&session.id);
                session_created = false;
                return Err(error);
            }
            session.child_pid = Some(child_pid);
            session.phase = LaunchSessionPhase::Running;
            session.updated_at = Library::now();

            let mut first_error = fs::write(spec.install_root.join(LAUNCH_MARKER), b"1")
                .err()
                .map(PortcoveError::from);
            on_started(&session);

            let status = match child.wait() {
                Ok(status) => status,
                Err(error) => {
                    return Err(PortcoveError::launch(format!(
                        "could not observe launched process {child_pid}: {error}"
                    )));
                }
            };
            if let Err(error) = self.library.update_launch_session(
                &session.id,
                None,
                LaunchSessionPhase::Collecting,
            ) && first_error.is_none()
            {
                first_error = Some(error);
            }
            if status.success()
                && let Err(error) = self.library.record_successful_launch(port_id)
                && first_error.is_none()
            {
                first_error = Some(error);
            }
            let collected = self.collect_user_data_from_install(port_id, &session.install_root);
            if let Err(error) = collected {
                if first_error.is_none() {
                    first_error = Some(error);
                }
            } else if let Err(error) = self.library.remove_launch_session(&session.id) {
                if first_error.is_none() {
                    first_error = Some(error);
                }
            } else {
                session_created = false;
            }

            if let Some(error) = first_error {
                Err(error)
            } else {
                Ok(SupervisedLaunchOutcome {
                    session_id: session.id,
                    child_pid,
                    exit_code: status.code(),
                    successful: status.success(),
                })
            }
        })();
        if session_created {
            // An uncertain child or collection state must remain durable and
            // keep the activity running for explicit stale-session recovery.
            return result;
        }
        let status = if result.as_ref().is_ok_and(|outcome| outcome.successful) {
            ActivityStatus::Succeeded
        } else {
            ActivityStatus::Failed
        };
        let message = result.as_ref().err().map(|error| error.message.as_str());
        if let Err(error) = self.library.finish_activity(&activity.id, status, message) {
            return result.and(Err(error));
        }
        result
    }

    pub fn stale_launch_sessions(&self) -> Result<Vec<LaunchSessionRecord>> {
        Ok(self
            .library
            .launch_sessions()?
            .into_iter()
            .filter(|session| !crate::launch::process_alive(session.supervisor_pid))
            .collect())
    }

    /// Recovers a launch whose supervisor no longer exists. The exact recorded
    /// install remains locked until its child exits and collection completes.
    pub fn recover_launch_session(&self, session_id: &str) -> Result<()> {
        let session = self.library.launch_session(session_id)?.ok_or_else(|| {
            PortcoveError::not_found(format!("launch session {session_id} was not found"))
        })?;
        if crate::launch::process_alive(session.supervisor_pid) {
            return Err(PortcoveError::conflict(format!(
                "launch session {session_id} still has a live supervisor"
            ))
            .detail("supervisor_pid", session.supervisor_pid.to_string()));
        }
        let _operation = self
            .library
            .try_lock_port_for_launch_recovery(&session.port_id, session_id)?;
        let session = self.library.launch_session(session_id)?.ok_or_else(|| {
            PortcoveError::not_found(format!(
                "launch session {session_id} was recovered elsewhere"
            ))
        })?;
        let install_is_exact = self.library.all_installs()?.into_iter().any(|install| {
            install.id == session.install_id
                && install.port_id == session.port_id
                && install.path == session.install_root
        });
        if !install_is_exact {
            return Err(PortcoveError::conflict(format!(
                "launch session {session_id} no longer matches its registered install"
            ))
            .detail("install_id", &session.install_id)
            .detail("install_root", session.install_root.display().to_string()));
        }
        self.library
            .update_launch_session(session_id, None, LaunchSessionPhase::Recovering)?;
        if let Some(child_pid) = session.child_pid {
            crate::launch::wait_for_process_exit(child_pid);
            self.collect_user_data_from_install(&session.port_id, &session.install_root)?;
        }
        self.library.remove_launch_session(session_id)?;
        self.library.finish_activity(
            session_id,
            ActivityStatus::Failed,
            Some("launch supervisor exited; the recorded session was recovered"),
        )
    }

    fn launch_spec(
        &self,
        port_id: &str,
        source_override: Option<&Path>,
    ) -> Result<crate::LaunchSpec> {
        let port = self.catalog.port(port_id)?;
        let active = self
            .status(port_id)?
            .active
            .ok_or_else(|| PortcoveError::not_found(format!("{port_id} is not installed")))?;
        let selected_executable = Installer::new(self.library.clone())?.verify_critical(&active)?;
        let source = if let Some(path) = source_override {
            let profile_id = port.source_profile.as_deref().ok_or_else(|| {
                PortcoveError::usage(format!("{} does not accept a source override", port.name))
            })?;
            let profile = self.catalog.source_profile(profile_id)?;
            Some(
                self.adapters
                    .get(port.adapter)
                    .validate_source(profile, path)?,
            )
        } else if let Some(profile) = &port.source_profile {
            if self.library.source(profile)?.is_some() {
                Some(self.verified_source_record(profile)?)
            } else {
                None
            }
        } else {
            None
        };
        if active.path.join(LAUNCH_MARKER).is_file() {
            self.collect_user_data_from(port, &active.path)?;
        }
        self.restore_user_data_to(port, &active.path)?;
        let spec = self
            .adapters
            .get(port.adapter)
            .launch_spec_with_executable(
                &self.library,
                port,
                Platform::current()?,
                &active.path,
                &selected_executable,
                source.as_ref().map(|record| record.path.as_path()),
            )?;
        self.faults.check(LifecycleFaultPoint::SourcePrepared)?;
        if let Some(source) = &source {
            self.verify_source_record(source)?;
        }
        Ok(spec)
    }

    pub fn collect_user_data(&self, port_id: &str) -> Result<Vec<PathBuf>> {
        let port = self.catalog.port(port_id)?;
        let _operation = self.library.try_lock_port(port_id, "collect-user-data")?;
        let active = self
            .status(port_id)?
            .active
            .ok_or_else(|| PortcoveError::not_found(format!("{port_id} is not installed")))?;
        self.collect_user_data_from(port, &active.path)
    }

    pub(crate) fn collect_active_user_data_if_launched(
        &self,
        port_id: &str,
    ) -> Result<Vec<PathBuf>> {
        let port = self.catalog.port(port_id)?;
        let Some(active) = self.status(port_id)?.active else {
            return Ok(Vec::new());
        };
        if !active.path.join(LAUNCH_MARKER).is_file() {
            return Ok(Vec::new());
        }
        self.collect_user_data_from(port, &active.path)
    }

    pub fn collect_user_data_from_install(
        &self,
        port_id: &str,
        install_root: &Path,
    ) -> Result<Vec<PathBuf>> {
        let port = self.catalog.port(port_id)?;
        let expected_parent = self.library.versions_dir().join(port_id);
        if install_root.parent() != Some(expected_parent.as_path()) {
            return Err(PortcoveError::conflict(format!(
                "launch install path is outside the managed {port_id} versions directory"
            )));
        }
        self.collect_user_data_from(port, install_root)
    }

    fn collect_user_data_from(
        &self,
        port: &PortDefinition,
        install_root: &Path,
    ) -> Result<Vec<PathBuf>> {
        let user_root = self.library.user_dir(&port.id);
        let persistent_root = self.persistence_root(port, install_root)?;
        let mut copied = Vec::new();
        for relative in &port.persistent_paths {
            let source = persistent_root.join(relative);
            let destination = user_root.join(relative);
            if source.exists() {
                sync_entry(&source, &destination)?;
                copied.push(destination);
            } else if destination.exists() {
                remove_managed_entry(&destination)?;
            }
        }
        Ok(copied)
    }

    fn restore_user_data_to(&self, port: &PortDefinition, install_root: &Path) -> Result<()> {
        let user_root = self.library.user_dir(&port.id);
        let persistent_root = self.persistence_root(port, install_root)?;
        for relative in &port.persistent_paths {
            let source = user_root.join(relative);
            if source.exists() {
                sync_entry(&source, &persistent_root.join(relative))?;
            }
        }
        Ok(())
    }

    fn persistence_root(&self, port: &PortDefinition, install_root: &Path) -> Result<PathBuf> {
        let qualification = InstallQualification::from_port(port, Platform::current()?)?;
        let executable = crate::install::resolve_declared_executable(install_root, &qualification)?;
        Ok(qualification.persistence_root(install_root, &executable))
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

fn default_channel(port: &PortDefinition) -> ReleaseChannel {
    if port.channels.contains(&ReleaseChannel::Stable) {
        ReleaseChannel::Stable
    } else {
        port.channels[0]
    }
}

fn source_removal_fingerprint(
    source: &SourceRecord,
    dependent_port_ids: &[String],
    installed_dependent_port_ids: &[String],
) -> Result<String> {
    let path = crate::path::unicode(&source.path, "source")?;
    let encoded = serde_json::to_vec(&(
        source.profile_id.as_str(),
        path,
        source.sha256.as_str(),
        source.size,
        source.storage_sha256.as_str(),
        source.storage_size,
        source.updated_at,
        dependent_port_ids,
        installed_dependent_port_ids,
    ))?;
    Ok(hex::encode(Sha256::digest(encoded)))
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

fn adoption_authorization_target(source: &Path, selected_port_id: Option<&str>) -> Result<String> {
    Ok(format!(
        "{}\n{}",
        crate::path::unicode(source, "adoption source")?,
        selected_port_id.unwrap_or_default()
    ))
}

fn adoption_plan_fingerprint(
    source: &Path,
    detected_port_ids: &[String],
    selected_port_id: Option<&str>,
    plan: &AdoptionCopyPlan,
) -> Result<String> {
    let encoded = serde_json::to_vec(&(
        crate::path::unicode(source, "adoption source")?,
        detected_port_ids,
        selected_port_id,
        plan,
    ))?;
    Ok(hex::encode(Sha256::digest(encoded)))
}

fn adoption_copy_plan(source: &Path) -> Result<AdoptionCopyPlan> {
    let mut plan = AdoptionCopyPlan {
        directories: Vec::new(),
        files: Vec::new(),
        skipped_entries: Vec::new(),
        total_bytes: 0,
    };
    collect_adoption_entries(source, source, &mut plan)?;
    plan.directories.sort();
    plan.files
        .sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    plan.skipped_entries
        .sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    Ok(plan)
}

fn collect_adoption_entries(
    root: &Path,
    directory: &Path,
    plan: &mut AdoptionCopyPlan,
) -> Result<()> {
    let mut entries = fs::read_dir(directory)?.collect::<std::io::Result<Vec<_>>>()?;
    entries.sort_by_key(std::fs::DirEntry::file_name);
    for entry in entries {
        let path = entry.path();
        let relative = path
            .strip_prefix(root)
            .map_err(|_| PortcoveError::state("adoption entry escaped its source root"))?
            .to_path_buf();
        crate::path::unicode(&relative, "adoption entry")?;
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            plan.skipped_entries.push(AdoptionSkippedEntry {
                relative_path: relative,
                reason: "symbolic links are not copied".to_owned(),
            });
        } else if file_type.is_dir() {
            plan.directories.push(relative);
            collect_adoption_entries(root, &path, plan)?;
        } else if file_type.is_file() {
            let size = entry.metadata()?.len();
            let sha256 = sha256_file(&path)?;
            plan.total_bytes = plan
                .total_bytes
                .checked_add(size)
                .ok_or_else(|| PortcoveError::state("adoption copy plan byte count overflowed"))?;
            plan.files.push(AdoptionCopyFile {
                relative_path: relative,
                size,
                sha256,
            });
        } else {
            plan.skipped_entries.push(AdoptionSkippedEntry {
                relative_path: relative,
                reason: "special filesystem entries are not copied".to_owned(),
            });
        }
    }
    Ok(())
}

fn copy_adoption_plan(source: &Path, destination: &Path, plan: &AdoptionCopyPlan) -> Result<()> {
    fs::create_dir_all(destination)?;
    for relative in &plan.directories {
        fs::create_dir_all(destination.join(relative))?;
    }
    for file in &plan.files {
        let source_file = source.join(&file.relative_path);
        let destination_file = destination.join(&file.relative_path);
        if let Some(parent) = destination_file.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(source_file, destination_file)?;
    }
    Ok(())
}

fn sha256_file(path: &Path) -> Result<String> {
    let mut file = fs::File::open(path)?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(hex::encode(digest.finalize()))
}

pub(crate) fn copy_tree(source: &Path, destination: &Path) -> Result<()> {
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        if entry.file_type()?.is_symlink() {
            continue;
        }
        copy_entry(&entry.path(), &destination.join(entry.file_name()))?;
    }
    Ok(())
}

fn copy_entry(source: &Path, destination: &Path) -> Result<()> {
    if fs::symlink_metadata(source)?.file_type().is_symlink() {
        return Ok(());
    }
    if source.is_dir() {
        copy_tree(source, destination)
    } else if source.is_file() {
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(source, destination)?;
        Ok(())
    } else {
        Ok(())
    }
}

fn sync_entry(source: &Path, destination: &Path) -> Result<()> {
    if fs::symlink_metadata(source)?.file_type().is_symlink() {
        return Ok(());
    }
    refuse_symlink_ancestors(destination)?;
    if source.is_file() {
        if destination.exists() && !destination.is_file() {
            remove_managed_entry(destination)?;
        }
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(source, destination)?;
        return Ok(());
    }
    if !source.is_dir() {
        return Ok(());
    }
    if destination.exists() && !destination.is_dir() {
        remove_managed_entry(destination)?;
    }
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        if entry.file_type()?.is_symlink() {
            continue;
        }
        sync_entry(&entry.path(), &destination.join(entry.file_name()))?;
    }
    for entry in fs::read_dir(destination)? {
        let entry = entry?;
        let source_entry = source.join(entry.file_name());
        if !source_entry.exists() {
            remove_managed_entry(&entry.path())?;
        }
    }
    Ok(())
}

fn refuse_symlink_ancestors(path: &Path) -> Result<()> {
    for candidate in path.ancestors() {
        if fs::symlink_metadata(candidate).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
            return Err(PortcoveError::conflict(format!(
                "refusing to synchronize through a symlink: {}",
                candidate.display()
            )));
        }
    }
    Ok(())
}

fn remove_managed_entry(path: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() {
        return Err(PortcoveError::conflict(format!(
            "refusing to remove symlink while synchronizing user data: {}",
            path.display()
        )));
    }
    if metadata.is_dir() {
        fs::remove_dir_all(path)?;
    } else {
        fs::remove_file(path)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{
        sync::{
            Arc, Condvar, Mutex,
            atomic::{AtomicBool, AtomicUsize, Ordering},
            mpsc,
        },
        thread,
        time::Duration,
    };

    use crate::{AdapterKind, ArtifactIdentity, ChildProcessClass};

    use super::*;

    #[derive(Clone)]
    struct StaticReleaseProvider {
        version: String,
    }

    struct ConcurrentReleaseProvider {
        active: AtomicUsize,
        max_active: AtomicUsize,
        calls: Mutex<Vec<String>>,
        rate_limited_port: Option<String>,
    }

    impl ConcurrentReleaseProvider {
        fn new(rate_limited_port: Option<String>) -> Self {
            Self {
                active: AtomicUsize::new(0),
                max_active: AtomicUsize::new(0),
                calls: Mutex::new(Vec::new()),
                rate_limited_port,
            }
        }
    }

    #[async_trait::async_trait]
    impl ReleaseProvider for ConcurrentReleaseProvider {
        async fn resolve(
            &self,
            port: &PortDefinition,
            channel: ReleaseChannel,
            _platform: Platform,
        ) -> Result<ResolvedRelease> {
            self.calls.lock().unwrap().push(port.id.clone());
            let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
            self.max_active.fetch_max(active, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(15)).await;
            self.active.fetch_sub(1, Ordering::SeqCst);
            if self.rate_limited_port.as_deref() == Some(&port.id) {
                return Err(PortcoveError::network("provider rate limit exhausted")
                    .detail("rate_remaining", "0")
                    .detail("retry_after", "60"));
            }
            Ok(ResolvedRelease {
                version: "2.0.0".into(),
                channel,
                published_at: None,
                asset: crate::ReleaseAsset {
                    name: format!("{}-2.0.0.zip", port.id),
                    url: "https://invalid.example/concurrent.zip".into(),
                    size: 4,
                    sha256: hex::encode(Sha256::digest(format!("{}:2.0.0", port.id))),
                },
            })
        }
    }

    #[async_trait::async_trait]
    impl ReleaseProvider for StaticReleaseProvider {
        async fn resolve(
            &self,
            port: &PortDefinition,
            channel: ReleaseChannel,
            _platform: Platform,
        ) -> Result<ResolvedRelease> {
            Ok(ResolvedRelease {
                version: self.version.clone(),
                channel,
                published_at: None,
                asset: crate::ReleaseAsset {
                    name: format!("{}-{}.zip", port.id, self.version),
                    url: "https://invalid.example/test.zip".into(),
                    size: 4,
                    sha256: hex::encode(Sha256::digest(format!("{}:{}", port.id, self.version))),
                },
            })
        }
    }

    #[derive(Clone)]
    struct RepublishedReleaseProvider {
        version: String,
        sha256: String,
    }

    #[derive(Clone)]
    struct BlockingReleaseProvider {
        version: String,
        first_started: mpsc::Sender<ReleaseChannel>,
        observed_channels: Arc<Mutex<Vec<ReleaseChannel>>>,
        gate: Arc<(Mutex<bool>, Condvar)>,
        calls: Arc<AtomicUsize>,
    }

    struct BlockingReleaseHarness {
        provider: Arc<BlockingReleaseProvider>,
        started: mpsc::Receiver<ReleaseChannel>,
        gate: Arc<(Mutex<bool>, Condvar)>,
        observed: Arc<Mutex<Vec<ReleaseChannel>>>,
    }

    #[async_trait::async_trait]
    impl ReleaseProvider for BlockingReleaseProvider {
        async fn resolve(
            &self,
            port: &PortDefinition,
            channel: ReleaseChannel,
            _platform: Platform,
        ) -> Result<ResolvedRelease> {
            self.observed_channels.lock().unwrap().push(channel);
            if self.calls.fetch_add(1, Ordering::SeqCst) == 0 {
                self.first_started.send(channel).unwrap();
                let (lock, wake) = &*self.gate;
                let mut released = lock.lock().unwrap();
                while !*released {
                    released = wake.wait(released).unwrap();
                }
            }
            Ok(ResolvedRelease {
                version: self.version.clone(),
                channel,
                published_at: None,
                asset: crate::ReleaseAsset {
                    name: format!("{}-{}.zip", port.id, self.version),
                    url: "https://invalid.example/blocked.zip".into(),
                    size: 4,
                    sha256: hex::encode(Sha256::digest(format!("{}:{}", port.id, self.version))),
                },
            })
        }
    }

    fn release_blocker(version: &str) -> BlockingReleaseHarness {
        let (started, receiver) = mpsc::channel();
        let gate = Arc::new((Mutex::new(false), Condvar::new()));
        let observed = Arc::new(Mutex::new(Vec::new()));
        BlockingReleaseHarness {
            provider: Arc::new(BlockingReleaseProvider {
                version: version.into(),
                first_started: started,
                observed_channels: observed.clone(),
                gate: gate.clone(),
                calls: Arc::new(AtomicUsize::new(0)),
            }),
            started: receiver,
            gate,
            observed,
        }
    }

    fn release_blocker_continue(gate: &Arc<(Mutex<bool>, Condvar)>) {
        let (lock, wake) = &**gate;
        *lock.lock().unwrap() = true;
        wake.notify_all();
    }

    #[async_trait::async_trait]
    impl ReleaseProvider for RepublishedReleaseProvider {
        async fn resolve(
            &self,
            port: &PortDefinition,
            channel: ReleaseChannel,
            _platform: Platform,
        ) -> Result<ResolvedRelease> {
            Ok(ResolvedRelease {
                version: self.version.clone(),
                channel,
                published_at: None,
                asset: crate::ReleaseAsset {
                    name: format!("{}-{}.zip", port.id, self.version),
                    url: "https://invalid.example/republished.zip".into(),
                    size: 4,
                    sha256: self.sha256.clone(),
                },
            })
        }
    }

    fn service_with_release(library: Library, version: &str) -> PortcoveService {
        PortcoveService::with_provider(
            library,
            Arc::new(StaticReleaseProvider {
                version: version.into(),
            }),
        )
        .unwrap()
    }

    #[tokio::test]
    async fn bulk_update_checks_are_bounded_and_preserve_input_order() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let provider = Arc::new(ConcurrentReleaseProvider::new(None));
        let service = PortcoveService::with_provider(library, provider.clone()).unwrap();
        let port_ids = service
            .catalog()
            .ports()
            .iter()
            .take(9)
            .map(|port| port.id.clone())
            .collect::<Vec<_>>();

        let outcomes = service.check_updates(port_ids.clone()).await.unwrap();

        assert_eq!(
            outcomes
                .iter()
                .map(|(port_id, _)| port_id.clone())
                .collect::<Vec<_>>(),
            port_ids
        );
        assert!(outcomes.iter().all(|(_, result)| result.is_ok()));
        assert_eq!(provider.max_active.load(Ordering::SeqCst), 4);
        assert_eq!(provider.calls.lock().unwrap().len(), 9);
    }

    #[tokio::test]
    async fn bulk_update_checks_isolate_rate_limits_without_retrying_items() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let catalog = Catalog::embedded().unwrap();
        let port_ids = catalog
            .ports()
            .iter()
            .take(6)
            .map(|port| port.id.clone())
            .collect::<Vec<_>>();
        let rate_limited_port = port_ids[2].clone();
        let provider = Arc::new(ConcurrentReleaseProvider::new(Some(
            rate_limited_port.clone(),
        )));
        let service = PortcoveService::with_provider(library, provider.clone()).unwrap();

        let outcomes = service.check_updates(port_ids.clone()).await.unwrap();

        assert_eq!(outcomes.len(), port_ids.len());
        for (port_id, result) in outcomes {
            if port_id == rate_limited_port {
                let error = result.unwrap_err();
                assert_eq!(error.code, crate::ErrorCode::Network);
                assert_eq!(error.details["rate_remaining"], "0");
                assert_eq!(error.details["retry_after"], "60");
            } else {
                assert!(result.is_ok(), "{port_id} should remain isolated");
            }
        }
        let calls = provider.calls.lock().unwrap();
        assert_eq!(calls.len(), port_ids.len());
        assert!(
            port_ids
                .iter()
                .all(|port_id| calls.iter().filter(|called| *called == port_id).count() == 1)
        );
    }

    fn backup_authorization(
        service: &PortcoveService,
        port_id: &str,
        backup_id: &str,
        action: BackupAction,
    ) -> crate::DestructiveAuthorization {
        let preview = service
            .preview_backup_action(port_id, backup_id, action)
            .unwrap();
        service
            .authorize_backup_action(port_id, backup_id, action, &preview.preview_sha256)
            .unwrap()
    }

    fn restore_authorized(
        service: &PortcoveService,
        port_id: &str,
        backup_id: &str,
    ) -> Result<RestoreResult> {
        let authorization =
            backup_authorization(service, port_id, backup_id, BackupAction::Restore);
        service.restore_backup(port_id, backup_id, &authorization.token)
    }

    fn delete_backup_authorized(
        service: &PortcoveService,
        port_id: &str,
        backup_id: &str,
    ) -> Result<BackupRecord> {
        let authorization = backup_authorization(service, port_id, backup_id, BackupAction::Delete);
        service.delete_backup(port_id, backup_id, &authorization.token)
    }

    fn removal_authorization(
        service: &PortcoveService,
        port_id: &str,
    ) -> crate::DestructiveAuthorization {
        let preview = service.preview_removal(port_id).unwrap();
        service
            .authorize_removal(port_id, &preview.preview_sha256)
            .unwrap()
    }

    struct FailOnce {
        point: LifecycleFaultPoint,
        fired: AtomicBool,
    }

    impl LifecycleFaultInjector for FailOnce {
        fn check(&self, point: LifecycleFaultPoint) -> Result<()> {
            if point == self.point && !self.fired.swap(true, Ordering::SeqCst) {
                return Err(PortcoveError::state(format!(
                    "injected lifecycle failure at {point:?}"
                )));
            }
            Ok(())
        }
    }

    fn service_with_fault(library: Library, point: LifecycleFaultPoint) -> PortcoveService {
        PortcoveService::with_provider_and_faults(
            library,
            Arc::new(StaticReleaseProvider {
                version: "v2".into(),
            }),
            Arc::new(FailOnce {
                point,
                fired: AtomicBool::new(false),
            }),
        )
        .unwrap()
    }

    struct ReplaceSourceAtFinalCheck {
        path: PathBuf,
        fired: AtomicBool,
    }

    impl LifecycleFaultInjector for ReplaceSourceAtFinalCheck {
        fn check(&self, point: LifecycleFaultPoint) -> Result<()> {
            if point == LifecycleFaultPoint::SourcePrepared
                && !self.fired.swap(true, Ordering::SeqCst)
            {
                fs::write(&self.path, b"source replaced after initial verification")?;
            }
            Ok(())
        }
    }

    #[test]
    fn adoption_recovers_after_every_publication_boundary() {
        for point in [
            LifecycleFaultPoint::AdoptionPrepared,
            LifecycleFaultPoint::AdoptionPublished,
            LifecycleFaultPoint::AdoptionMetadataCommitted,
        ] {
            let temporary = tempfile::tempdir().unwrap();
            let library = Library::open(temporary.path().join("library")).unwrap();
            let source = temporary.path().join("existing-install");
            fs::create_dir_all(&source).unwrap();
            write_host_test_executable(&source, "zelda64-recomp");
            fs::write(source.join("general.json"), b"adopted settings").unwrap();

            let service = service_with_fault(library.clone(), point);
            let preview = service
                .preview_adoption(&source, Some("zelda64-recomp"))
                .unwrap();
            let authorization = service
                .authorize_adoption(&source, Some("zelda64-recomp"), &preview.plan_sha256)
                .unwrap();
            let error = service
                .adopt(&source, Some("zelda64-recomp"), &authorization.token)
                .unwrap_err();
            assert!(error.message.contains("injected lifecycle failure"));

            let recovered = service_with_release(library.clone(), "v2");
            let status = recovered.status("zelda64-recomp").unwrap();
            assert!(
                status
                    .active
                    .as_ref()
                    .is_some_and(|install| install.path.is_dir())
            );
            assert_eq!(
                fs::read(library.user_dir("zelda64-recomp").join("general.json")).unwrap(),
                b"adopted settings"
            );
            assert!(recovered.repair_plan().unwrap().items.is_empty());
        }
    }

    #[test]
    fn adoption_preview_is_content_bound_and_rejects_changes_after_review() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let source = temporary.path().join("existing-install");
        fs::create_dir_all(source.join("settings")).unwrap();
        write_host_test_executable(&source, "zelda64-recomp");
        fs::write(source.join("settings/general.json"), b"reviewed").unwrap();
        let service = service_with_release(library.clone(), "v2");

        let preview = service
            .preview_adoption(&source, Some("zelda64-recomp"))
            .unwrap();
        assert!(preview.copy_plan.files.iter().any(|file| {
            file.relative_path == Path::new("settings/general.json")
                && file.size == b"reviewed".len() as u64
        }));
        assert_eq!(
            preview.copy_plan.total_bytes,
            preview
                .copy_plan
                .files
                .iter()
                .map(|file| file.size)
                .sum::<u64>()
        );
        let authorization = service
            .authorize_adoption(&source, Some("zelda64-recomp"), &preview.plan_sha256)
            .unwrap();

        fs::write(
            source.join("settings/general.json"),
            b"changed after review",
        )
        .unwrap();
        let error = service
            .adopt(&source, Some("zelda64-recomp"), &authorization.token)
            .unwrap_err();

        assert_eq!(error.code, crate::ErrorCode::Conflict);
        assert!(error.message.contains("state changed"));
        assert!(service.status("zelda64-recomp").unwrap().active.is_none());
        assert_eq!(
            fs::read(source.join("settings/general.json")).unwrap(),
            b"changed after review"
        );
    }

    #[cfg(unix)]
    #[test]
    fn adoption_preview_reports_symlinks_as_skipped_entries() {
        use std::os::unix::fs::symlink;

        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let source = temporary.path().join("existing-install");
        fs::create_dir_all(&source).unwrap();
        write_host_test_executable(&source, "zelda64-recomp");
        fs::write(source.join("target.txt"), b"target").unwrap();
        symlink(source.join("target.txt"), source.join("linked.txt")).unwrap();
        let service = service_with_release(library, "v2");

        let preview = service
            .preview_adoption(&source, Some("zelda64-recomp"))
            .unwrap();

        assert_eq!(preview.copy_plan.skipped_entries.len(), 1);
        assert_eq!(
            preview.copy_plan.skipped_entries[0].relative_path,
            PathBuf::from("linked.txt")
        );
        assert!(
            preview.copy_plan.skipped_entries[0]
                .reason
                .contains("symbolic links")
        );
    }

    #[test]
    fn removal_recovers_after_quarantine_metadata_and_cleanup_boundaries() {
        for point in [
            LifecycleFaultPoint::RemovalQuarantined,
            LifecycleFaultPoint::RemovalMetadataCommitted,
            LifecycleFaultPoint::RemovalCleanup,
        ] {
            let temporary = tempfile::tempdir().unwrap();
            let library = Library::open(temporary.path().join("library")).unwrap();
            let install = register_zelda_install(&library, "v1", true);

            let service = service_with_fault(library.clone(), point);
            let authorization = removal_authorization(&service, "zelda64-recomp");
            let error = service
                .remove("zelda64-recomp", &authorization.token)
                .unwrap_err();
            assert!(error.message.contains("injected lifecycle failure"));

            let recovered = service_with_release(library.clone(), "v2");
            assert!(recovered.status("zelda64-recomp").unwrap().active.is_none());
            assert!(!install.exists());
            assert!(recovered.repair_plan().unwrap().items.is_empty());
        }
    }

    #[test]
    fn removal_authorization_rejects_new_managed_versions() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let first = register_zelda_install(&library, "v1", true);
        let service = service_with_release(library.clone(), "v2");
        let preview = service.preview_removal("zelda64-recomp").unwrap();
        let authorization = service
            .authorize_removal("zelda64-recomp", &preview.preview_sha256)
            .unwrap();
        let second = register_zelda_install(&library, "v2", false);

        let error = service
            .remove("zelda64-recomp", &authorization.token)
            .unwrap_err();

        assert_eq!(error.code, crate::ErrorCode::Conflict);
        assert!(error.message.contains("state changed"));
        assert!(first.is_dir());
        assert!(second.is_dir());
    }

    #[test]
    fn removal_recovery_resumes_a_preparing_quarantine() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let install = register_zelda_install(&library, "v1", true);
        let store = OperationStore::new(library.clone());
        let mut operation = LifecycleOperation::new(
            "preparing-removal",
            LifecycleOperationKind::Remove,
            "zelda64-recomp",
        );
        operation.paths.quarantine = Some(library.recovery_dir().join(&operation.id));
        operation.original_paths.push(install.clone());
        store.put(&mut operation).unwrap();

        let recovered = service_with_release(library, "v2");

        assert!(!install.exists());
        assert!(recovered.status("zelda64-recomp").unwrap().active.is_none());
        assert!(recovered.repair_plan().unwrap().items.is_empty());
    }

    #[test]
    fn staged_activation_recovers_after_metadata_commit() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        register_zelda_install(&library, "v1", true);
        register_zelda_install(&library, "v2", false);

        let error = service_with_fault(
            library.clone(),
            LifecycleFaultPoint::ActivationMetadataCommitted,
        )
        .activate_staged("zelda64-recomp")
        .unwrap_err();
        assert!(error.message.contains("injected lifecycle failure"));

        let recovered = service_with_release(library, "v2");
        assert_eq!(
            recovered
                .status("zelda64-recomp")
                .unwrap()
                .active
                .unwrap()
                .version,
            "v2"
        );
        assert!(recovered.repair_plan().unwrap().items.is_empty());
    }

    #[test]
    fn staged_activation_recovery_distinguishes_expected_active_and_staged_identities() {
        for expected_is_active in [false, true] {
            let temporary = tempfile::tempdir().unwrap();
            let library = Library::open(temporary.path().join("library")).unwrap();
            register_zelda_install(&library, "v1", true);
            if !expected_is_active {
                register_zelda_install(&library, "v2", false);
            }
            let status = library
                .status("zelda64-recomp", ReleaseChannel::Stable)
                .unwrap();
            let expected = if expected_is_active {
                status.active.unwrap()
            } else {
                status.staged.unwrap()
            };
            let store = OperationStore::new(library.clone());
            let mut operation = LifecycleOperation::new(
                format!("preparing-activation-{expected_is_active}"),
                LifecycleOperationKind::Activate,
                "zelda64-recomp",
            );
            operation.install = Some(expected.clone());
            store.put(&mut operation).unwrap();

            let recovered = service_with_release(library, "v2");

            assert_eq!(
                recovered
                    .status("zelda64-recomp")
                    .unwrap()
                    .active
                    .unwrap()
                    .id,
                expected.id
            );
            assert!(recovered.repair_plan().unwrap().items.is_empty());
        }
    }

    #[test]
    fn restore_recovers_before_and_after_user_data_publication() {
        for point in [
            LifecycleFaultPoint::RestorePrepared,
            LifecycleFaultPoint::RestorePublished,
        ] {
            let temporary = tempfile::tempdir().unwrap();
            let library = Library::open(temporary.path().join("library")).unwrap();
            let user_file = library.user_dir("zelda64-recomp").join("general.json");
            fs::create_dir_all(user_file.parent().unwrap()).unwrap();
            fs::write(&user_file, b"wanted").unwrap();
            let original = service_with_release(library.clone(), "v2");
            let backup = original.create_backup("zelda64-recomp").unwrap();
            fs::write(&user_file, b"changed").unwrap();

            let service = service_with_fault(library.clone(), point);
            let authorization = backup_authorization(
                &service,
                "zelda64-recomp",
                &backup.id,
                BackupAction::Restore,
            );
            let error = service
                .restore_backup("zelda64-recomp", &backup.id, &authorization.token)
                .unwrap_err();
            assert!(error.message.contains("injected lifecycle failure"));

            let recovered = service_with_release(library, "v2");
            assert_eq!(fs::read(&user_file).unwrap(), b"wanted");
            assert!(recovered.repair_plan().unwrap().items.is_empty());
        }
    }

    #[test]
    fn restore_recovery_handles_each_unambiguous_half_published_state() {
        for (activate, staged_exists, user_exists, previous_exists) in [
            (true, true, false, true),
            (true, false, true, true),
            (false, true, false, false),
            (false, false, true, false),
        ] {
            let temporary = tempfile::tempdir().unwrap();
            let library = Library::open(temporary.path().join("library")).unwrap();
            let store = OperationStore::new(library.clone());
            let recovery_root = library.recovery_dir().join(format!(
                "restore-{activate}-{staged_exists}-{user_exists}-{previous_exists}"
            ));
            let staged = recovery_root.join("staged-data");
            let previous = recovery_root.join("previous-data");
            let user_root = library.user_dir("zelda64-recomp");
            if staged_exists {
                fs::create_dir_all(&staged).unwrap();
                fs::write(staged.join("general.json"), b"wanted").unwrap();
            }
            if user_exists {
                fs::create_dir_all(&user_root).unwrap();
                fs::write(user_root.join("general.json"), b"wanted").unwrap();
            }
            if previous_exists {
                fs::create_dir_all(&previous).unwrap();
                fs::write(previous.join("general.json"), b"previous").unwrap();
            }
            let mut operation = LifecycleOperation::new(
                recovery_root.file_name().unwrap().to_string_lossy(),
                LifecycleOperationKind::Restore,
                "zelda64-recomp",
            );
            operation.phase = LifecyclePhase::Prepared;
            operation.activate = activate;
            operation.paths.staging = Some(recovery_root.clone());
            operation.paths.final_path = Some(user_root.clone());
            operation.paths.quarantine = Some(previous);
            store.put(&mut operation).unwrap();

            crate::recovery::recover_restore(&store, &mut operation).unwrap();

            assert_eq!(fs::read(user_root.join("general.json")).unwrap(), b"wanted");
            assert!(!recovery_root.exists());
            assert!(store.all().unwrap().is_empty());
        }
    }

    #[test]
    fn repair_plan_is_read_only_and_reports_each_ambiguous_state() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let missing = register_zelda_install(&library, "missing", true);
        fs::remove_dir_all(&missing).unwrap();
        let orphan = library.versions_dir().join("zelda64-recomp").join("orphan");
        fs::create_dir_all(&orphan).unwrap();
        let staged = library.staging_dir().join("partial-operation");
        fs::create_dir_all(&staged).unwrap();
        let store = OperationStore::new(library.clone());
        let mut operation = LifecycleOperation::new(
            "partial-operation",
            LifecycleOperationKind::Install,
            "zelda64-recomp",
        );
        operation.paths.staging = Some(staged.clone());
        operation.last_error = Some("validation was interrupted".into());
        store.put(&mut operation).unwrap();
        let service = service_with_release(library, "v2");

        let plan = service.repair_plan().unwrap();

        assert!(
            plan.items
                .iter()
                .any(|item| item.kind == RepairItemKind::PartialOperation)
        );
        assert!(
            plan.items
                .iter()
                .any(|item| item.kind == RepairItemKind::MissingRegisteredPath)
        );
        assert!(
            plan.items
                .iter()
                .any(|item| item.kind == RepairItemKind::OrphanedFinalDirectory)
        );
        assert!(orphan.is_dir());
        assert!(staged.is_dir());
        assert_eq!(
            OperationStore::new(service.library().clone())
                .all()
                .unwrap()
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn failed_operations_emit_a_terminal_event_with_the_activity_identity() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let service = service_with_release(library.clone(), "v2");
        let mut events = Vec::new();

        service
            .install("missing-port", None, None, None, true, |event| {
                events.push(event)
            })
            .await
            .unwrap_err();

        let activity = &library.activities(1).unwrap()[0];
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].operation_id, activity.id);
        assert_eq!(events[1].operation_id, activity.id);
        assert_eq!(events[0].sequence, 0);
        assert_eq!(events[1].sequence, 1);
        assert_eq!(
            events[1].event,
            crate::OperationEventKind::Finished {
                result: OperationResult::Failed
            }
        );
        assert_eq!(activity.status, ActivityStatus::Failed);
    }

    #[test]
    fn doctor_reports_local_library_and_optional_host_tools() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path()).unwrap();
        let service = service_with_release(library, "1.0.0");

        let report = service.doctor().unwrap();

        assert_eq!(report.platform, Platform::current().unwrap());
        assert_eq!(report.library.library_root, temporary.path());
        assert_eq!(report.catalog_port_count, service.catalog().ports().len());
        assert_eq!(report.installed_port_count, 0);
        assert_eq!(report.registered_source_count, 0);
        assert_eq!(
            report
                .host_tools
                .iter()
                .map(|tool| tool.id.as_str())
                .collect::<Vec<_>>(),
            ["chdman", "dolphin_tool"]
        );
    }

    #[test]
    fn status_and_doctor_do_not_initialize_catalog_settings() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let service = PortcoveService::new(library.clone()).unwrap();
        let settings_count = || {
            rusqlite::Connection::open(library.root().join("portcove.sqlite3"))
                .unwrap()
                .query_row("SELECT count(*) FROM port_settings", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap()
        };
        assert_eq!(settings_count(), 0);

        let statuses = service.statuses().unwrap();
        service.doctor().unwrap();

        assert_eq!(settings_count(), 0);
        assert_eq!(
            statuses
                .iter()
                .find(|status| status.port_id == "dkr-r")
                .unwrap()
                .channel,
            ReleaseChannel::Beta
        );
        assert_eq!(
            statuses
                .iter()
                .find(|status| status.port_id == "perfect-dark")
                .unwrap()
                .channel,
            ReleaseChannel::Rolling
        );
    }

    #[test]
    fn policy_initialization_preserves_a_catalog_only_channel() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let service = PortcoveService::new(library.clone()).unwrap();

        let status = service
            .set_update_policy("dkr-r", UpdatePolicy::Stage)
            .unwrap();

        assert_eq!(status.channel, ReleaseChannel::Beta);
        assert_eq!(status.update_policy, UpdatePolicy::Stage);
        assert_eq!(
            library
                .status("dkr-r", ReleaseChannel::Stable)
                .unwrap()
                .channel,
            ReleaseChannel::Beta
        );
    }

    #[test]
    fn capability_adapters_are_complete_and_catalog_backed() {
        let catalog = Catalog::embedded().unwrap();
        let capabilities = crate::CapabilityDocument::current();
        assert_eq!(capabilities.adapters, AdapterKind::ALL);
        let declared = catalog
            .ports()
            .iter()
            .map(|port| port.adapter)
            .collect::<HashSet<_>>();
        assert_eq!(declared, AdapterKind::ALL.into_iter().collect());
    }

    fn write_host_test_executable(root: &Path, port_id: &str) -> PathBuf {
        let catalog = Catalog::embedded().unwrap();
        let port = catalog.port(port_id).unwrap();
        let platform = Platform::current().unwrap();
        let executable_name = port
            .executable_hints
            .get(&platform)
            .and_then(|hints| hints.first())
            .unwrap();
        let executable = root.join(executable_name);
        fs::write(&executable, b"test").unwrap();
        executable
    }

    fn register_existing_test_install(
        library: &Library,
        port_id: &str,
        version: &str,
        path: &Path,
        active: bool,
    ) -> InstallRecord {
        let artifact = ArtifactIdentity {
            asset_name: format!("{port_id}-{version}.zip"),
            sha256: hex::encode(Sha256::digest(format!("{port_id}:{version}"))),
            size: 4,
        };
        register_existing_test_artifact(library, port_id, version, path, artifact, active)
    }

    fn register_existing_test_artifact(
        library: &Library,
        port_id: &str,
        version: &str,
        path: &Path,
        artifact: ArtifactIdentity,
        active: bool,
    ) -> InstallRecord {
        let id = Uuid::new_v4().to_string();
        let catalog = Catalog::embedded().unwrap();
        let port = catalog.port(port_id).unwrap();
        let qualification =
            InstallQualification::from_port(port, Platform::current().unwrap()).unwrap();
        let (manifest_sha256, selected_executable) = Installer::new(library.clone())
            .unwrap()
            .create_manifest(&id, port_id, version, &artifact, &qualification, path)
            .unwrap();
        let install = InstallRecord {
            id,
            port_id: port_id.into(),
            version: version.into(),
            path: path.to_path_buf(),
            channel: ReleaseChannel::Stable,
            installed_at: Library::now(),
            verified: true,
            staged: !active,
            artifact,
            manifest_sha256,
            selected_executable,
        };
        library.register_install(&install, active).unwrap();
        install
    }

    fn register_zelda_install(library: &Library, version: &str, active: bool) -> PathBuf {
        let artifact = ArtifactIdentity {
            asset_name: format!("zelda64-recomp-{version}.zip"),
            sha256: hex::encode(Sha256::digest(format!("zelda64-recomp:{version}"))),
            size: 4,
        };
        let path = library
            .versions_dir()
            .join("zelda64-recomp")
            .join(&artifact.sha256);
        fs::create_dir_all(&path).unwrap();
        write_host_test_executable(&path, "zelda64-recomp");
        fs::write(path.join("engine.dll"), b"critical library").unwrap();
        let id = Uuid::new_v4().to_string();
        let port = Catalog::embedded()
            .unwrap()
            .port("zelda64-recomp")
            .unwrap()
            .clone();
        let qualification =
            InstallQualification::from_port(&port, Platform::current().unwrap()).unwrap();
        let (manifest_sha256, selected_executable) = Installer::new(library.clone())
            .unwrap()
            .create_manifest(&id, &port.id, version, &artifact, &qualification, &path)
            .unwrap();
        library
            .register_install(
                &InstallRecord {
                    id,
                    port_id: "zelda64-recomp".into(),
                    version: version.into(),
                    path: path.clone(),
                    channel: ReleaseChannel::Stable,
                    installed_at: Library::now(),
                    verified: true,
                    staged: !active,
                    artifact,
                    manifest_sha256,
                    selected_executable,
                },
                active,
            )
            .unwrap();
        path
    }

    fn register_launch_probe(library: &Library, version: &str, active: bool) -> InstallRecord {
        let artifact = ArtifactIdentity {
            asset_name: format!("zelda64-recomp-{version}.zip"),
            sha256: hex::encode(Sha256::digest(format!("launch-probe:{version}"))),
            size: 4,
        };
        let path = library
            .versions_dir()
            .join("zelda64-recomp")
            .join(&artifact.sha256);
        fs::create_dir_all(&path).unwrap();
        let executable = Catalog::embedded()
            .unwrap()
            .port("zelda64-recomp")
            .unwrap()
            .executable_hints
            .get(&Platform::current().unwrap())
            .unwrap()[0]
            .clone();
        let executable = path.join(executable);
        fs::create_dir_all(executable.parent().unwrap()).unwrap();
        let source = path.join("launch_probe.rs");
        fs::write(
            &source,
            r#"use std::{env, fs, process, thread, time::Duration};
fn main() {
    let arguments = env::args().skip(1).collect::<Vec<_>>();
    fs::write(&arguments[0], b"started").unwrap();
    thread::sleep(Duration::from_millis(arguments[1].parse().unwrap()));
    fs::write("general.json", arguments[2].as_bytes()).unwrap();
    process::exit(arguments[3].parse().unwrap());
}
"#,
        )
        .unwrap();
        let status = ChildProcessPolicy::native_command(ChildProcessClass::HostTool, "rustc")
            .unwrap()
            .arg(&source)
            .arg("-o")
            .arg(&executable)
            .status()
            .unwrap();
        assert!(status.success());
        fs::remove_file(source).unwrap();
        fs::write(path.join("engine.dll"), b"critical library").unwrap();
        register_existing_test_artifact(library, "zelda64-recomp", version, &path, artifact, active)
    }

    fn register_gen1_install(library: &Library, version: &str, active: bool) -> PathBuf {
        let artifact = ArtifactIdentity {
            asset_name: format!("gen1recomp-{version}.zip"),
            sha256: hex::encode(Sha256::digest(format!("gen1recomp:{version}"))),
            size: 4,
        };
        let path = library
            .versions_dir()
            .join("gen1recomp")
            .join(&artifact.sha256);
        let executable_root = path.join("gen1recomp-win64");
        fs::create_dir_all(&executable_root).unwrap();
        write_host_test_executable(&executable_root, "gen1recomp");
        let id = Uuid::new_v4().to_string();
        let port = Catalog::embedded()
            .unwrap()
            .port("gen1recomp")
            .unwrap()
            .clone();
        let qualification =
            InstallQualification::from_port(&port, Platform::current().unwrap()).unwrap();
        let (manifest_sha256, selected_executable) = Installer::new(library.clone())
            .unwrap()
            .create_manifest(&id, &port.id, version, &artifact, &qualification, &path)
            .unwrap();
        library
            .register_install(
                &InstallRecord {
                    id,
                    port_id: "gen1recomp".into(),
                    version: version.into(),
                    path: path.clone(),
                    channel: ReleaseChannel::Stable,
                    installed_at: Library::now(),
                    verified: true,
                    staged: !active,
                    artifact,
                    manifest_sha256,
                    selected_executable,
                },
                active,
            )
            .unwrap();
        path
    }

    #[test]
    fn backup_creates_an_independent_snapshot_and_lists_it() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let user_root = library.user_dir("zelda64-recomp");
        fs::create_dir_all(user_root.join("saves")).unwrap();
        fs::write(user_root.join("saves/save.dat"), b"original").unwrap();
        fs::write(user_root.join("settings.json"), b"{}").unwrap();
        let service = service_with_release(library.clone(), "v1");

        let backup = service.create_backup("zelda64-recomp").unwrap();
        assert_eq!(backup.port_id, "zelda64-recomp");
        assert_eq!(backup.file_count, 2);
        assert_eq!(backup.size, 10);
        assert_eq!(
            fs::read(backup.path.join("data/saves/save.dat")).unwrap(),
            b"original"
        );
        assert!(backup.path.join("backup.json").is_file());

        fs::write(user_root.join("saves/save.dat"), b"changed").unwrap();
        assert_eq!(
            fs::read(backup.path.join("data/saves/save.dat")).unwrap(),
            b"original"
        );
        assert_eq!(service.list_backups("zelda64-recomp").unwrap(), [backup]);
        let activity = &library.activities(1).unwrap()[0];
        assert_eq!(activity.operation, ActivityOperation::Backup);
        assert_eq!(activity.status, ActivityStatus::Succeeded);
    }

    #[test]
    fn backup_rejects_empty_persistent_data_and_records_failure() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        fs::create_dir_all(library.user_dir("zelda64-recomp")).unwrap();
        let service = service_with_release(library.clone(), "v1");

        let error = service.create_backup("zelda64-recomp").unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::NotFound);
        assert!(service.list_backups("zelda64-recomp").unwrap().is_empty());
        let activity = &library.activities(1).unwrap()[0];
        assert_eq!(activity.operation, ActivityOperation::Backup);
        assert_eq!(activity.status, ActivityStatus::Failed);
    }

    #[test]
    fn restore_replaces_user_data_and_preserves_an_automatic_safety_backup() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let user_root = library.user_dir("zelda64-recomp");
        fs::create_dir_all(&user_root).unwrap();
        fs::write(user_root.join("save.dat"), b"wanted").unwrap();
        let service = service_with_release(library.clone(), "v1");
        let wanted = service.create_backup("zelda64-recomp").unwrap();
        fs::write(user_root.join("save.dat"), b"current").unwrap();
        fs::write(user_root.join("new.cfg"), b"setting").unwrap();

        let restored = restore_authorized(&service, "zelda64-recomp", &wanted.id).unwrap();

        assert_eq!(restored.restored_backup, wanted);
        let safety = restored
            .safety_backup
            .expect("current data needs a safety backup");
        assert_eq!(
            fs::read(safety.path.join("data/save.dat")).unwrap(),
            b"current"
        );
        assert_eq!(fs::read(user_root.join("save.dat")).unwrap(), b"wanted");
        assert!(!user_root.join("new.cfg").exists());
        let listed = service.list_backups("zelda64-recomp").unwrap();
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0], safety);
        let activity = &library.activities(1).unwrap()[0];
        assert_eq!(activity.operation, ActivityOperation::Restore);
        assert_eq!(activity.status, ActivityStatus::Succeeded);
    }

    #[test]
    fn restore_authorization_rejects_live_data_changes_after_review() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let user_root = library.user_dir("zelda64-recomp");
        fs::create_dir_all(&user_root).unwrap();
        fs::write(user_root.join("save.dat"), b"backup contents").unwrap();
        let service = service_with_release(library, "v1");
        let backup = service.create_backup("zelda64-recomp").unwrap();
        fs::write(user_root.join("save.dat"), b"reviewed live data").unwrap();
        let preview = service
            .preview_backup_action("zelda64-recomp", &backup.id, BackupAction::Restore)
            .unwrap();
        let authorization = service
            .authorize_backup_action(
                "zelda64-recomp",
                &backup.id,
                BackupAction::Restore,
                &preview.preview_sha256,
            )
            .unwrap();
        fs::write(user_root.join("save.dat"), b"new live data").unwrap();

        let error = service
            .restore_backup("zelda64-recomp", &backup.id, &authorization.token)
            .unwrap_err();

        assert_eq!(error.code, crate::ErrorCode::Conflict);
        assert!(error.message.contains("state changed"));
        assert_eq!(
            fs::read(user_root.join("save.dat")).unwrap(),
            b"new live data"
        );
    }

    #[test]
    fn restore_rejects_tampered_backup_before_snapshot_or_live_data_changes() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let user_root = library.user_dir("zelda64-recomp");
        fs::create_dir_all(&user_root).unwrap();
        fs::write(user_root.join("save.dat"), b"backup").unwrap();
        let service = service_with_release(library.clone(), "v1");
        let backup = service.create_backup("zelda64-recomp").unwrap();
        fs::write(backup.path.join("data/save.dat"), b"damage").unwrap();
        fs::write(user_root.join("save.dat"), b"live").unwrap();

        let error = restore_authorized(&service, "zelda64-recomp", &backup.id).unwrap_err();

        assert_eq!(error.code, crate::ErrorCode::Verification);
        assert_eq!(fs::read(user_root.join("save.dat")).unwrap(), b"live");
        assert_eq!(service.list_backups("zelda64-recomp").unwrap().len(), 1);
        assert_eq!(
            library.activities(1).unwrap()[0].status,
            ActivityStatus::Failed
        );
    }

    #[test]
    fn restore_into_an_empty_root_needs_no_safety_backup() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let user_root = library.user_dir("zelda64-recomp");
        fs::create_dir_all(&user_root).unwrap();
        fs::write(user_root.join("save.dat"), b"backup").unwrap();
        let service = service_with_release(library.clone(), "v1");
        let backup = service.create_backup("zelda64-recomp").unwrap();
        fs::remove_dir_all(&user_root).unwrap();

        let restored = restore_authorized(&service, "zelda64-recomp", &backup.id).unwrap();

        assert!(restored.safety_backup.is_none());
        assert_eq!(fs::read(user_root.join("save.dat")).unwrap(), b"backup");
    }

    #[test]
    fn delete_backup_removes_only_the_selected_snapshot() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let user_root = library.user_dir("zelda64-recomp");
        fs::create_dir_all(&user_root).unwrap();
        fs::write(user_root.join("save.dat"), b"live").unwrap();
        let service = service_with_release(library.clone(), "v1");
        let backup = service.create_backup("zelda64-recomp").unwrap();

        let deleted = delete_backup_authorized(&service, "zelda64-recomp", &backup.id).unwrap();

        assert_eq!(deleted, backup);
        assert!(!backup.path.exists());
        assert_eq!(fs::read(user_root.join("save.dat")).unwrap(), b"live");
        assert!(service.list_backups("zelda64-recomp").unwrap().is_empty());
        let activity = &library.activities(1).unwrap()[0];
        assert_eq!(activity.operation, ActivityOperation::DeleteBackup);
        assert_eq!(activity.status, ActivityStatus::Succeeded);
    }

    #[cfg(unix)]
    #[test]
    fn backup_rejects_symbolic_links_instead_of_omitting_them() {
        use std::os::unix::fs::symlink;

        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let user_root = library.user_dir("zelda64-recomp");
        fs::create_dir_all(&user_root).unwrap();
        let external = temporary.path().join("external-save");
        fs::write(&external, b"save").unwrap();
        symlink(external, user_root.join("linked-save")).unwrap();
        let service = service_with_release(library, "v1");

        let error = service.create_backup("zelda64-recomp").unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Conflict);
        assert!(error.message.contains("symbolic link"));
    }

    #[tokio::test]
    async fn install_plan_reports_download_source_and_staged_reuse_without_mutation() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let service = service_with_release(library.clone(), "v2");

        let download = service.plan_install("zelda64-recomp", None).await.unwrap();
        assert_eq!(download.action, InstallPlanAction::Download);
        assert_eq!(download.release.version, "v2");
        assert_eq!(download.storage.library_root, library.root());
        assert_eq!(download.source_requirements.len(), 1);
        assert_eq!(
            download.source_requirements[0].role,
            SourceRequirementRole::GameSource
        );
        assert!(!download.source_requirements[0].registered);
        assert!(library.activities(50).unwrap().is_empty());

        register_zelda_install(&library, "v2", false);
        let staged = service.plan_install("zelda64-recomp", None).await.unwrap();
        assert_eq!(staged.action, InstallPlanAction::UseStaged);
        assert!(
            library
                .status("zelda64-recomp", ReleaseChannel::Stable)
                .unwrap()
                .active
                .is_none()
        );
    }

    #[tokio::test]
    async fn install_plan_distinguishes_active_and_retained_versions() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        register_zelda_install(&library, "v1", true);
        let active_service = service_with_release(library.clone(), "v1");
        assert_eq!(
            active_service
                .plan_install("zelda64-recomp", None)
                .await
                .unwrap()
                .action,
            InstallPlanAction::AlreadyActive
        );

        register_zelda_install(&library, "v2", true);
        let retained_service = service_with_release(library, "v1");
        assert_eq!(
            retained_service
                .plan_install("zelda64-recomp", None)
                .await
                .unwrap()
                .action,
            InstallPlanAction::ReuseRetained
        );
    }

    #[test]
    fn port_paths_expose_canonical_persistent_and_version_roots() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let active = register_zelda_install(&library, "v1", true);
        let staged = register_zelda_install(&library, "v2", false);
        let service = service_with_release(library.clone(), "v2");

        let paths = service.port_paths("zelda64-recomp").unwrap();

        assert_eq!(paths.library_root, library.root());
        assert_eq!(paths.user_data_root, library.user_dir("zelda64-recomp"));
        assert_eq!(paths.active_install_root.as_deref(), Some(active.as_path()));
        assert_eq!(paths.staged_install_root.as_deref(), Some(staged.as_path()));
        assert!(paths.previous_install_root.is_none());
    }

    #[test]
    fn post_exit_sync_uses_the_version_that_was_launched() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let first = register_zelda_install(&library, "v1", true);
        let service = PortcoveService::new(library.clone()).unwrap();
        let launch = service.launch_spec("zelda64-recomp", None).unwrap();
        assert_eq!(launch.install_root, first);

        fs::write(first.join("general.json"), b"from-v1-session").unwrap();
        let second = register_zelda_install(&library, "v2", true);
        fs::write(second.join("general.json"), b"from-v2").unwrap();

        service
            .collect_user_data_from_install("zelda64-recomp", &launch.install_root)
            .unwrap();
        assert_eq!(
            fs::read(library.user_dir("zelda64-recomp").join("general.json")).unwrap(),
            b"from-v1-session"
        );

        service.launch_spec("zelda64-recomp", None).unwrap();
        assert_eq!(
            fs::read(second.join("general.json")).unwrap(),
            b"from-v1-session"
        );

        fs::write(second.join("general.json"), b"recovered-after-crash").unwrap();
        fs::write(second.join(LAUNCH_MARKER), b"1").unwrap();
        service.launch_spec("zelda64-recomp", None).unwrap();
        assert_eq!(
            fs::read(library.user_dir("zelda64-recomp").join("general.json")).unwrap(),
            b"recovered-after-crash"
        );
    }

    #[test]
    fn source_verification_detects_changes_without_replacing_the_baseline() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let source = temporary.path().join("star-fox-64.z64");
        fs::write(&source, b"original source").unwrap();
        let service = PortcoveService::new(library.clone()).unwrap();
        let registered = service.register_source("star-fox-64", &source).unwrap();

        let verified = service.verify_source("star-fox-64").unwrap();
        assert_eq!(verified.sha256, registered.sha256);
        assert_eq!(verified.size, registered.size);

        fs::write(&source, b"changed source").unwrap();
        let error = service.verify_source("star-fox-64").unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::SourceInvalid);
        assert_eq!(
            error.details.get("recorded_storage_sha256"),
            Some(&registered.storage_sha256)
        );
        assert_ne!(
            error.details.get("actual_storage_sha256"),
            Some(&registered.storage_sha256)
        );
        assert_eq!(
            library.source("star-fox-64").unwrap().unwrap().sha256,
            registered.sha256
        );
        let activities = library.activities(10).unwrap();
        assert_eq!(activities[0].operation, ActivityOperation::VerifySource);
        assert_eq!(activities[0].status, ActivityStatus::Failed);
        assert_eq!(activities[0].target_id.as_deref(), Some("star-fox-64"));
        assert!(
            activities[0]
                .message
                .as_deref()
                .is_some_and(|message| message.contains("source changed"))
        );
        assert_eq!(activities[1].operation, ActivityOperation::VerifySource);
        assert_eq!(activities[1].status, ActivityStatus::Succeeded);
        assert_eq!(activities[2].operation, ActivityOperation::RegisterSource);
    }

    #[tokio::test]
    async fn successful_update_checks_are_shared_through_persistent_status() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("library");
        let library = Library::open(&root).unwrap();
        register_zelda_install(&library, "v1", true);
        let service = service_with_release(library, "v2");

        let check = service.check_update("zelda64-recomp").await.unwrap();
        assert!(check.update_available);
        drop(service);

        let reopened = service_with_release(Library::open(root).unwrap(), "v2");
        let snapshot = reopened
            .status("zelda64-recomp")
            .unwrap()
            .last_update_check
            .unwrap();
        assert_eq!(snapshot.check.port_id, "zelda64-recomp");
        assert_eq!(snapshot.check.installed_version.as_deref(), Some("v1"));
        assert_eq!(snapshot.check.release.version, "v2");
        assert!(snapshot.check.update_available);
        assert!(snapshot.checked_at > 0);
        let activities = reopened.library().activities(5).unwrap();
        assert_eq!(activities[0].operation, ActivityOperation::CheckUpdate);
        assert_eq!(activities[0].status, ActivityStatus::Succeeded);
    }

    #[test]
    fn status_distinguishes_launch_blockers_from_pending_upstream_setup() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let install = library.versions_dir().join("opengoal-jak1").join("v1");
        fs::create_dir_all(&install).unwrap();
        write_host_test_executable(&install, "opengoal-jak1");
        register_existing_test_install(&library, "opengoal-jak1", "v1", &install, true);
        let service = PortcoveService::new(library.clone()).unwrap();

        let blocked = service.status("opengoal-jak1").unwrap().readiness.unwrap();
        assert!(!blocked.launchable);
        assert_eq!(blocked.blockers, [LaunchBlocker::MissingSource]);
        assert!(blocked.pending_setup);

        library
            .register_source(&SourceRecord {
                profile_id: "opengoal-jak1-disc".into(),
                path: temporary.path().join("jak1.iso"),
                sha256: "0".repeat(64),
                size: 1,
                storage_sha256: "0".repeat(64),
                storage_size: 1,
                updated_at: Library::now(),
            })
            .unwrap();
        let pending = service.status("opengoal-jak1").unwrap().readiness.unwrap();
        assert!(pending.launchable);
        assert!(pending.blockers.is_empty());
        assert!(pending.pending_setup);

        let marker = install.join("data/out/jak1/iso/0COMMON.TXT");
        fs::create_dir_all(marker.parent().unwrap()).unwrap();
        fs::write(marker, b"ready").unwrap();
        let ready = service.status("opengoal-jak1").unwrap().readiness.unwrap();
        assert!(ready.launchable);
        assert!(!ready.pending_setup);
    }

    #[test]
    fn source_verification_revalidates_content_instead_of_trusting_the_record() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let source = temporary.path().join("mario-kart-64.z64");
        fs::write(&source, b"not the supported source").unwrap();
        let (storage_sha256, storage_size) = crate::adapter::hash_file(&source).unwrap();
        library
            .register_source(&SourceRecord {
                profile_id: "mario-kart-64".into(),
                path: source,
                sha256: "d6b8538dd63f0132ecb2856e7d32816ed3c30e3e479aecd23cf83fb6ba17a5da".into(),
                size: storage_size,
                storage_sha256,
                storage_size,
                updated_at: Library::now(),
            })
            .unwrap();
        let service = PortcoveService::new(library).unwrap();

        let error = service.verify_source("mario-kart-64").unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::SourceInvalid);
        assert!(error.message.contains("not a supported"));
    }

    #[test]
    fn source_removal_previews_shared_installed_dependents_and_rejects_stale_consent() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let source_path = temporary.path().join("banjo.z64");
        fs::write(&source_path, b"registered source").unwrap();
        let mut source = SourceRecord {
            profile_id: "banjo-kazooie".into(),
            path: source_path,
            sha256: "1".repeat(64),
            size: 17,
            storage_sha256: "1".repeat(64),
            storage_size: 17,
            updated_at: Library::now(),
        };
        library.register_source(&source).unwrap();
        let lighthouse = library
            .versions_dir()
            .join("lighthouse")
            .join("a".repeat(64));
        fs::create_dir_all(&lighthouse).unwrap();
        write_host_test_executable(&lighthouse, "lighthouse");
        register_existing_test_install(&library, "lighthouse", "v1", &lighthouse, true);
        let service = PortcoveService::new(library.clone()).unwrap();

        let preview = service.preview_source_removal("banjo-kazooie").unwrap();
        assert_eq!(preview.dependent_port_ids, ["banjo-recomp", "lighthouse"]);
        assert_eq!(preview.installed_dependent_port_ids, ["lighthouse"]);
        let authorization = service
            .authorize_source_removal("banjo-kazooie", &preview.preview_sha256)
            .unwrap();

        let banjo_recomp = library
            .versions_dir()
            .join("banjo-recomp")
            .join("b".repeat(64));
        fs::create_dir_all(&banjo_recomp).unwrap();
        write_host_test_executable(&banjo_recomp, "banjo-recomp");
        register_existing_test_install(&library, "banjo-recomp", "v1", &banjo_recomp, true);
        let error = service
            .remove_source("banjo-kazooie", &authorization.token)
            .unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Conflict);
        assert!(error.message.contains("state changed"));

        let impact_preview = service.preview_source_removal("banjo-kazooie").unwrap();
        assert_eq!(
            impact_preview.installed_dependent_port_ids,
            ["banjo-recomp", "lighthouse"]
        );
        let impact_authorization = service
            .authorize_source_removal("banjo-kazooie", &impact_preview.preview_sha256)
            .unwrap();

        source.path = temporary.path().join("replacement.z64");
        source.storage_sha256 = "2".repeat(64);
        source.sha256 = "2".repeat(64);
        source.updated_at += 1;
        fs::write(&source.path, b"replacement source").unwrap();
        library.register_source(&source).unwrap();
        let error = service
            .remove_source("banjo-kazooie", &impact_authorization.token)
            .unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Conflict);
        assert!(library.source("banjo-kazooie").unwrap().is_some());

        let current = service.preview_source_removal("banjo-kazooie").unwrap();
        let current_authorization = service
            .authorize_source_removal("banjo-kazooie", &current.preview_sha256)
            .unwrap();
        let removed = service
            .remove_source("banjo-kazooie", &current_authorization.token)
            .unwrap();
        assert_eq!(removed.preview_sha256, current.preview_sha256);
        assert!(library.source("banjo-kazooie").unwrap().is_none());
    }

    #[test]
    fn launch_rejects_a_changed_registered_source_until_it_is_replaced() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let install = library.versions_dir().join("starship/v1");
        fs::create_dir_all(&install).unwrap();
        let executable = write_host_test_executable(&install, "starship");
        register_existing_test_install(&library, "starship", "v1", &install, true);
        let source = temporary.path().join("star-fox-64.z64");
        fs::write(&source, b"original source").unwrap();
        let service = PortcoveService::new(library).unwrap();
        service.register_source("star-fox-64", &source).unwrap();

        fs::write(&source, b"changed source").unwrap();
        let error = service.launch_spec("starship", None).unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::SourceInvalid);
        assert!(!install.join(LAUNCH_MARKER).exists());

        service.register_source("star-fox-64", &source).unwrap();
        fs::remove_file(&executable).unwrap();
        let error = service.launch_spec("starship", None).unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Verification);
        assert!(!install.join(LAUNCH_MARKER).exists());

        fs::write(executable, b"test").unwrap();
        let launch = service.launch_spec("starship", None).unwrap();
        assert_eq!(
            launch.environment.get("PORTCOVE_SOURCE"),
            Some(&source.to_string_lossy().into_owned())
        );
        assert!(!install.join(LAUNCH_MARKER).exists());
    }

    #[test]
    fn launch_rejects_a_source_replaced_during_adapter_preparation() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let install = library.versions_dir().join("starship/v1");
        fs::create_dir_all(&install).unwrap();
        write_host_test_executable(&install, "starship");
        register_existing_test_install(&library, "starship", "v1", &install, true);
        let source = temporary.path().join("star-fox-64.z64");
        fs::write(&source, b"initial verified source").unwrap();
        let service = PortcoveService::with_provider_and_faults(
            library.clone(),
            Arc::new(StaticReleaseProvider {
                version: "v2".into(),
            }),
            Arc::new(ReplaceSourceAtFinalCheck {
                path: source.clone(),
                fired: AtomicBool::new(false),
            }),
        )
        .unwrap();
        service.register_source("star-fox-64", &source).unwrap();

        let error = service.launch_spec("starship", None).unwrap_err();

        assert_eq!(error.code, crate::ErrorCode::SourceInvalid);
        assert!(error.message.contains("changed since registration"));
        assert!(!install.join(LAUNCH_MARKER).exists());
    }

    #[test]
    fn portable_catalog_storage_tracks_the_executable_directory() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let first = register_gen1_install(&library, "v1", true);
        let first_runtime = first.join("gen1recomp-win64");
        fs::create_dir_all(first_runtime.join("red")).unwrap();
        fs::write(first_runtime.join("red/rom-cache.complete"), b"ready").unwrap();
        let service = PortcoveService::new(library.clone()).unwrap();

        service.collect_user_data("gen1recomp").unwrap();
        assert_eq!(
            fs::read(
                library
                    .user_dir("gen1recomp")
                    .join("red/rom-cache.complete")
            )
            .unwrap(),
            b"ready"
        );

        let second = register_gen1_install(&library, "v2", true);
        let launch = service.launch_spec("gen1recomp", None).unwrap();
        assert_eq!(launch.working_directory, second.join("gen1recomp-win64"));
        assert_eq!(
            fs::read(
                second
                    .join("gen1recomp-win64")
                    .join("red/rom-cache.complete")
            )
            .unwrap(),
            b"ready"
        );
    }

    #[test]
    fn post_exit_sync_rejects_unmanaged_paths() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let service = PortcoveService::new(library).unwrap();
        let outside = temporary.path().join("outside");
        fs::create_dir_all(&outside).unwrap();

        assert!(
            service
                .collect_user_data_from_install("zelda64-recomp", &outside)
                .is_err()
        );
    }

    #[test]
    fn post_exit_sync_propagates_user_data_deletions() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let install = register_zelda_install(&library, "v1", true);
        let service = PortcoveService::new(library.clone()).unwrap();
        let mods = install.join("mods");
        fs::create_dir_all(&mods).unwrap();
        fs::write(mods.join("removed.rtz"), b"mod").unwrap();
        fs::write(install.join("general.json"), b"settings").unwrap();

        service.collect_user_data("zelda64-recomp").unwrap();
        fs::remove_file(mods.join("removed.rtz")).unwrap();
        fs::remove_file(install.join("general.json")).unwrap();
        service.collect_user_data("zelda64-recomp").unwrap();

        assert!(
            !library
                .user_dir("zelda64-recomp")
                .join("mods/removed.rtz")
                .exists()
        );
        assert!(
            !library
                .user_dir("zelda64-recomp")
                .join("general.json")
                .exists()
        );
    }

    #[test]
    fn rollback_collects_the_version_being_deactivated() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        register_zelda_install(&library, "v1", true);
        let second = register_zelda_install(&library, "v2", true);
        fs::write(second.join("general.json"), b"latest-settings").unwrap();
        fs::write(second.join(LAUNCH_MARKER), b"1").unwrap();
        let service = PortcoveService::new(library.clone()).unwrap();

        let active = service.rollback("zelda64-recomp").unwrap();

        assert_eq!(active.version, "v1");
        assert_eq!(
            fs::read(library.user_dir("zelda64-recomp").join("general.json")).unwrap(),
            b"latest-settings"
        );
    }

    #[test]
    fn rollback_preserves_user_data_when_active_version_was_never_launched() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        register_zelda_install(&library, "v1", true);
        register_zelda_install(&library, "v2", true);
        let user_settings = library.user_dir("zelda64-recomp").join("general.json");
        fs::create_dir_all(user_settings.parent().unwrap()).unwrap();
        fs::write(&user_settings, b"preserve-me").unwrap();
        let service = PortcoveService::new(library).unwrap();

        let active = service.rollback("zelda64-recomp").unwrap();

        assert_eq!(active.version, "v1");
        assert_eq!(fs::read(user_settings).unwrap(), b"preserve-me");
    }

    #[test]
    fn launch_rejects_an_invalid_explicit_source() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let install = library.versions_dir().join("lighthouse/v1");
        fs::create_dir_all(&install).unwrap();
        write_host_test_executable(&install, "lighthouse");
        register_existing_test_install(&library, "lighthouse", "v1", &install, true);
        let invalid = temporary.path().join("not-a-rom.txt");
        fs::write(&invalid, b"not a ROM").unwrap();
        let service = PortcoveService::new(library).unwrap();

        let error = service
            .launch_spec("lighthouse", Some(&invalid))
            .unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::SourceInvalid);
    }

    #[test]
    fn launch_rehashes_executable_library_and_manifest_before_side_effects() {
        for target in ["executable", "library", "manifest"] {
            let temporary = tempfile::tempdir().unwrap();
            let library = Library::open(temporary.path().join("library")).unwrap();
            register_zelda_install(&library, "v1", true);
            let before = library
                .status("zelda64-recomp", ReleaseChannel::Stable)
                .unwrap();
            let active = before.active.as_ref().unwrap();
            match target {
                "executable" => fs::write(
                    active.path.join(&active.selected_executable),
                    b"changed executable",
                )
                .unwrap(),
                "library" => fs::write(active.path.join("engine.dll"), b"changed library").unwrap(),
                "manifest" => fs::write(
                    active.path.join(".portcove-manifest.json"),
                    b"changed manifest",
                )
                .unwrap(),
                _ => unreachable!(),
            }
            let service = PortcoveService::new(library.clone()).unwrap();

            let error = service.launch_spec("zelda64-recomp", None).unwrap_err();

            assert_eq!(error.code, crate::ErrorCode::Verification, "{target}");
            assert!(
                !active.path.join(LAUNCH_MARKER).exists(),
                "{target} wrote a launch marker"
            );
            let after = library
                .status("zelda64-recomp", ReleaseChannel::Stable)
                .unwrap();
            assert_eq!(
                after.active.as_ref().map(|install| &install.id),
                before.active.as_ref().map(|install| &install.id),
                "{target}"
            );
        }
    }

    #[test]
    fn launch_never_falls_back_to_an_unmanifested_executable() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        register_zelda_install(&library, "v1", true);
        let active = library
            .status("zelda64-recomp", ReleaseChannel::Stable)
            .unwrap()
            .active
            .unwrap();
        fs::remove_file(active.path.join(&active.selected_executable)).unwrap();
        fs::write(active.path.join("plausible-fallback.exe"), b"untrusted").unwrap();
        let service = PortcoveService::new(library).unwrap();

        let error = service.launch_spec("zelda64-recomp", None).unwrap_err();

        assert_eq!(error.code, crate::ErrorCode::Verification);
        assert!(!active.path.join(LAUNCH_MARKER).exists());
    }

    #[test]
    fn mutable_persistent_files_do_not_invalidate_the_immutable_install() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let path = register_zelda_install(&library, "v1", true);
        fs::write(path.join("general.json"), b"first user settings").unwrap();
        fs::write(path.join("general.json"), b"changed user settings").unwrap();
        let service = PortcoveService::new(library).unwrap();

        let report = service.verify("zelda64-recomp").unwrap();
        let spec = service.launch_spec("zelda64-recomp", None).unwrap();

        assert!(report.valid, "{:?}", report.failures);
        assert!(spec.executable.starts_with(&path));
        assert!(!path.join(LAUNCH_MARKER).is_file());
    }

    #[test]
    fn staged_and_rollback_tamper_leave_install_pointers_unchanged() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        register_zelda_install(&library, "v1", true);
        register_zelda_install(&library, "v2", false);
        let staged_before = library
            .status("zelda64-recomp", ReleaseChannel::Stable)
            .unwrap();
        let staged = staged_before.staged.as_ref().unwrap();
        fs::write(
            staged.path.join(&staged.selected_executable),
            b"changed staged executable",
        )
        .unwrap();
        let service = PortcoveService::new(library.clone()).unwrap();

        let error = service.activate_staged("zelda64-recomp").unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Verification);
        let staged_after = library
            .status("zelda64-recomp", ReleaseChannel::Stable)
            .unwrap();
        assert_eq!(
            staged_after.active.as_ref().map(|install| &install.id),
            staged_before.active.as_ref().map(|install| &install.id)
        );
        assert_eq!(
            staged_after.staged.as_ref().map(|install| &install.id),
            staged_before.staged.as_ref().map(|install| &install.id)
        );

        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        register_zelda_install(&library, "v1", true);
        register_zelda_install(&library, "v2", true);
        let rollback_before = library
            .status("zelda64-recomp", ReleaseChannel::Stable)
            .unwrap();
        let previous = rollback_before.previous.as_ref().unwrap();
        fs::write(
            previous.path.join(&previous.selected_executable),
            b"changed rollback executable",
        )
        .unwrap();
        let service = PortcoveService::new(library.clone()).unwrap();

        let error = service.rollback("zelda64-recomp").unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Verification);
        let rollback_after = library
            .status("zelda64-recomp", ReleaseChannel::Stable)
            .unwrap();
        assert_eq!(
            rollback_after.active.as_ref().map(|install| &install.id),
            rollback_before.active.as_ref().map(|install| &install.id)
        );
        assert_eq!(
            rollback_after.previous.as_ref().map(|install| &install.id),
            rollback_before.previous.as_ref().map(|install| &install.id)
        );
    }

    #[test]
    fn supervised_launch_holds_the_port_and_collects_the_exact_install() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let install = register_launch_probe(&library, "v1", true);
        let started = temporary.path().join("started");
        let (sender, receiver) = mpsc::channel();
        let service = PortcoveService::new(library.clone()).unwrap();
        let arguments = vec![
            started.display().to_string(),
            "400".into(),
            "saved-by-child".into(),
            "0".into(),
        ];
        let handle = thread::spawn(move || {
            service.supervise_launch(
                "zelda64-recomp",
                None,
                &arguments,
                LaunchStdio::Null,
                |session| sender.send(session.clone()).unwrap(),
            )
        });

        let session = receiver.recv_timeout(Duration::from_secs(10)).unwrap();
        assert_eq!(session.install_id, install.id);
        assert_eq!(session.install_root, install.path);
        assert!(install.path.join(LAUNCH_MARKER).is_file());
        let conflict = library
            .try_lock_port("zelda64-recomp", "remove")
            .unwrap_err();
        assert_eq!(conflict.code, crate::ErrorCode::Conflict);

        let outcome = handle.join().unwrap().unwrap();
        assert!(outcome.successful);
        assert!(library.launch_sessions().unwrap().is_empty());
        assert_eq!(
            fs::read(library.user_dir("zelda64-recomp").join("general.json")).unwrap(),
            b"saved-by-child"
        );
        let status = library
            .status("zelda64-recomp", ReleaseChannel::Stable)
            .unwrap();
        assert_eq!(status.successful_launches, 1);
        let activity = library
            .activities(10)
            .unwrap()
            .into_iter()
            .find(|activity| activity.id == outcome.session_id)
            .unwrap();
        assert_eq!(activity.status, ActivityStatus::Succeeded);
    }

    #[test]
    fn failed_spawn_creates_neither_marker_nor_unfinished_session() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let install = register_zelda_install(&library, "v1", true);
        let service = PortcoveService::new(library.clone()).unwrap();

        let error = service
            .supervise_launch("zelda64-recomp", None, &[], LaunchStdio::Null, |_| {
                panic!("an invalid executable must not report a child")
            })
            .unwrap_err();

        assert_eq!(error.code, crate::ErrorCode::Launch);
        assert!(!install.join(LAUNCH_MARKER).exists());
        assert!(library.launch_sessions().unwrap().is_empty());
        assert_eq!(
            library.activities(1).unwrap()[0].status,
            ActivityStatus::Failed
        );
    }

    #[test]
    fn nonzero_child_exit_is_recorded_as_failed_after_save_collection() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        register_launch_probe(&library, "v1", true);
        let service = PortcoveService::new(library.clone()).unwrap();
        let arguments = vec![
            temporary.path().join("started").display().to_string(),
            "0".into(),
            "saved-before-failure".into(),
            "7".into(),
        ];

        let outcome = service
            .supervise_launch(
                "zelda64-recomp",
                None,
                &arguments,
                LaunchStdio::Null,
                |_| {},
            )
            .unwrap();

        assert!(!outcome.successful);
        assert_eq!(outcome.exit_code, Some(7));
        assert!(library.launch_sessions().unwrap().is_empty());
        assert_eq!(
            fs::read(library.user_dir("zelda64-recomp").join("general.json")).unwrap(),
            b"saved-before-failure"
        );
        assert_eq!(
            library
                .status("zelda64-recomp", ReleaseChannel::Stable)
                .unwrap()
                .successful_launches,
            0
        );
        assert_eq!(
            library.activities(1).unwrap()[0].status,
            ActivityStatus::Failed
        );
    }

    #[test]
    fn forwarded_interrupt_still_finishes_supervision_and_clears_the_session() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        register_launch_probe(&library, "v1", true);
        let service = PortcoveService::new(library.clone()).unwrap();
        let arguments = vec![
            temporary
                .path()
                .join("interrupt-started")
                .display()
                .to_string(),
            "10000".into(),
            "should-not-be-written".into(),
            "0".into(),
        ];
        let (sender, receiver) = mpsc::channel();
        let handle = thread::spawn(move || {
            service.supervise_launch(
                "zelda64-recomp",
                None,
                &arguments,
                LaunchStdio::Null,
                |session| sender.send(session.child_pid.unwrap()).unwrap(),
            )
        });
        let child_pid = receiver.recv_timeout(Duration::from_secs(10)).unwrap();

        crate::forward_launch_signal(child_pid, crate::LaunchSignal::Interrupt).unwrap();
        let outcome = handle.join().unwrap().unwrap();

        assert!(!outcome.successful);
        assert!(library.launch_sessions().unwrap().is_empty());
        assert_eq!(
            library.activities(1).unwrap()[0].status,
            ActivityStatus::Failed
        );
    }

    #[test]
    fn stale_session_waits_for_its_recorded_child_and_collects_its_recorded_install() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let launched = register_launch_probe(&library, "v1", true);
        register_zelda_install(&library, "v2", true);
        let started = temporary.path().join("stale-started");
        let mut command = ChildProcessPolicy::native_command(
            ChildProcessClass::Game,
            launched.path.join(&launched.selected_executable),
        )
        .unwrap();
        command.current_dir(&launched.path).args([
            started.display().to_string(),
            "200".into(),
            "recovered-v1-data".into(),
            "0".into(),
        ]);
        crate::launch::configure_supervised_game(&mut command);
        let mut child = command.spawn().unwrap();
        for _ in 0..100 {
            if started.is_file() {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        assert!(started.is_file());
        let child_pid = child.id();
        let reaper = thread::spawn(move || child.wait().unwrap());
        let activity = library
            .begin_activity(
                ActivityOperation::Launch,
                ActivityTargetKind::Port,
                Some("zelda64-recomp"),
            )
            .unwrap();
        let now = Library::now();
        library
            .create_launch_session(&LaunchSessionRecord {
                id: activity.id.clone(),
                port_id: "zelda64-recomp".into(),
                install_id: launched.id.clone(),
                install_root: launched.path.clone(),
                supervisor_pid: u32::MAX,
                child_pid: Some(child_pid),
                phase: LaunchSessionPhase::Running,
                started_at: now,
                updated_at: now,
            })
            .unwrap();
        let service = PortcoveService::new(library.clone()).unwrap();
        assert_eq!(service.stale_launch_sessions().unwrap().len(), 1);
        assert!(library.try_lock_port("zelda64-recomp", "update").is_err());

        service.recover_launch_session(&activity.id).unwrap();
        reaper.join().unwrap();

        assert!(library.launch_sessions().unwrap().is_empty());
        assert_eq!(
            fs::read(library.user_dir("zelda64-recomp").join("general.json")).unwrap(),
            b"recovered-v1-data"
        );
        assert_eq!(
            library.activities(1).unwrap()[0].status,
            ActivityStatus::Failed
        );
    }

    #[test]
    fn stale_pre_spawn_session_recovers_without_marking_or_collecting() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let install = register_zelda_install(&library, "v1", true);
        let activity = library
            .begin_activity(
                ActivityOperation::Launch,
                ActivityTargetKind::Port,
                Some("zelda64-recomp"),
            )
            .unwrap();
        let now = Library::now();
        library
            .create_launch_session(&LaunchSessionRecord {
                id: activity.id.clone(),
                port_id: "zelda64-recomp".into(),
                install_id: library
                    .status("zelda64-recomp", ReleaseChannel::Stable)
                    .unwrap()
                    .active
                    .unwrap()
                    .id,
                install_root: install.clone(),
                supervisor_pid: u32::MAX,
                child_pid: None,
                phase: LaunchSessionPhase::Preparing,
                started_at: now,
                updated_at: now,
            })
            .unwrap();
        let service = PortcoveService::new(library.clone()).unwrap();

        service.recover_launch_session(&activity.id).unwrap();

        assert!(!install.join(LAUNCH_MARKER).exists());
        assert!(library.launch_sessions().unwrap().is_empty());
        assert_eq!(
            library.activities(1).unwrap()[0].status,
            ActivityStatus::Failed
        );
    }

    #[tokio::test]
    async fn install_activates_a_matching_verified_staged_version_without_source_or_download() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        register_zelda_install(&library, "v1", true);
        register_zelda_install(&library, "v2", false);
        let service = service_with_release(library, "v2");

        let installed = service
            .install("zelda64-recomp", None, None, None, true, |_| {})
            .await
            .unwrap();
        let status = service.status("zelda64-recomp").unwrap();

        assert_eq!(installed.version, "v2");
        assert_eq!(status.active.unwrap().version, "v2");
        assert_eq!(status.previous.unwrap().version, "v1");
        assert!(status.staged.is_none());
    }

    #[tokio::test]
    async fn install_reuses_a_matching_verified_retained_version() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        register_zelda_install(&library, "v1", true);
        register_zelda_install(&library, "v2", true);
        library.rollback("zelda64-recomp").unwrap();
        let service = service_with_release(library, "v2");

        let installed = service
            .install("zelda64-recomp", None, None, None, false, |_| {})
            .await
            .unwrap();
        let status = service.status("zelda64-recomp").unwrap();

        assert_eq!(installed.version, "v2");
        assert!(installed.staged);
        assert_eq!(status.active.unwrap().version, "v1");
        assert_eq!(status.staged.unwrap().version, "v2");
    }

    #[tokio::test]
    async fn retained_tamper_fails_before_reuse_or_pointer_change() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        register_zelda_install(&library, "v1", true);
        register_zelda_install(&library, "v2", true);
        library.rollback("zelda64-recomp").unwrap();
        let before = library
            .status("zelda64-recomp", ReleaseChannel::Stable)
            .unwrap();
        let retained = before.previous.as_ref().unwrap();
        fs::write(
            retained.path.join(&retained.selected_executable),
            b"changed retained executable",
        )
        .unwrap();
        let service = service_with_release(library.clone(), "v2");

        let error = service
            .install("zelda64-recomp", None, None, None, false, |_| {})
            .await
            .unwrap_err();

        assert_eq!(error.code, crate::ErrorCode::Verification);
        let after = library
            .status("zelda64-recomp", ReleaseChannel::Stable)
            .unwrap();
        assert_eq!(
            after.active.as_ref().map(|install| &install.id),
            before.active.as_ref().map(|install| &install.id)
        );
        assert_eq!(
            after.previous.as_ref().map(|install| &install.id),
            before.previous.as_ref().map(|install| &install.id)
        );
        assert!(after.staged.is_none());
    }

    #[tokio::test]
    async fn a_republished_tag_is_an_update_and_both_artifacts_can_roll_back() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let old_path = library
            .versions_dir()
            .join("lighthouse")
            .join("a".repeat(64));
        let new_path = library
            .versions_dir()
            .join("lighthouse")
            .join("b".repeat(64));
        fs::create_dir_all(&old_path).unwrap();
        fs::create_dir_all(&new_path).unwrap();
        write_host_test_executable(&old_path, "lighthouse");
        write_host_test_executable(&new_path, "lighthouse");
        let old = register_existing_test_artifact(
            &library,
            "lighthouse",
            "v1",
            &old_path,
            ArtifactIdentity {
                asset_name: "lighthouse-v1.zip".into(),
                sha256: "a".repeat(64),
                size: 4,
            },
            true,
        );
        let new = register_existing_test_artifact(
            &library,
            "lighthouse",
            "v1",
            &new_path,
            ArtifactIdentity {
                asset_name: "lighthouse-v1.zip".into(),
                sha256: "b".repeat(64),
                size: 4,
            },
            false,
        );
        let service = PortcoveService::with_provider(
            library.clone(),
            Arc::new(RepublishedReleaseProvider {
                version: "v1".into(),
                sha256: new.artifact.sha256.clone(),
            }),
        )
        .unwrap();

        let check = service.check_update("lighthouse").await.unwrap();
        assert!(check.update_available);
        assert_eq!(check.installed_version.as_deref(), Some("v1"));
        assert_eq!(check.installed_artifact.as_ref(), Some(&old.artifact));
        assert_eq!(check.release.version, "v1");
        assert_eq!(check.release.asset.sha256, new.artifact.sha256);
        assert_eq!(
            service
                .plan_install("lighthouse", None)
                .await
                .unwrap()
                .action,
            InstallPlanAction::UseStaged
        );

        let activated = service.activate_staged("lighthouse").unwrap();
        assert_eq!(activated.version, "v1");
        assert_eq!(activated.artifact.sha256, "b".repeat(64));
        let rolled_back = service.rollback("lighthouse").unwrap();
        assert_eq!(rolled_back.version, "v1");
        assert_eq!(rolled_back.artifact.sha256, "a".repeat(64));
        assert_ne!(old.path, new.path);
    }

    #[test]
    fn database_artifact_identity_tamper_invalidates_the_manifest() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        register_zelda_install(&library, "v1", true);
        rusqlite::Connection::open(library.root().join("portcove.sqlite3"))
            .unwrap()
            .execute(
                "UPDATE installs SET artifact_sha256=?1 WHERE port_id=?2",
                rusqlite::params!["f".repeat(64), "zelda64-recomp"],
            )
            .unwrap();
        let before = library
            .status("zelda64-recomp", ReleaseChannel::Stable)
            .unwrap();
        let service = PortcoveService::new(library.clone()).unwrap();

        let error = service.launch_spec("zelda64-recomp", None).unwrap_err();

        assert_eq!(error.code, crate::ErrorCode::Verification);
        let after = library
            .status("zelda64-recomp", ReleaseChannel::Stable)
            .unwrap();
        assert_eq!(
            after.active.as_ref().map(|install| &install.id),
            before.active.as_ref().map(|install| &install.id)
        );
    }

    #[tokio::test]
    async fn update_reuses_and_can_activate_the_matching_staged_version() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        register_zelda_install(&library, "v1", true);
        register_zelda_install(&library, "v2", false);
        let service = service_with_release(library.clone(), "v2");

        let staged = service
            .update("zelda64-recomp", None, None, false, |_| {})
            .await
            .unwrap();
        assert_eq!(staged.version, "v2");
        assert_eq!(
            service
                .status("zelda64-recomp")
                .unwrap()
                .active
                .unwrap()
                .version,
            "v1"
        );

        let activated = service
            .update("zelda64-recomp", None, None, true, |_| {})
            .await
            .unwrap();
        let status = service.status("zelda64-recomp").unwrap();
        assert_eq!(activated.version, "v2");
        assert_eq!(status.active.unwrap().version, "v2");
        assert_eq!(status.previous.unwrap().version, "v1");
        assert!(status.staged.is_none());
    }

    #[tokio::test]
    async fn update_reuses_a_matching_rollback_version_without_downloading() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        register_zelda_install(&library, "v1", true);
        register_zelda_install(&library, "v2", true);
        library.rollback("zelda64-recomp").unwrap();
        let service = service_with_release(library, "v2");

        let staged = service
            .update("zelda64-recomp", None, None, false, |_| {})
            .await
            .unwrap();
        let status = service.status("zelda64-recomp").unwrap();
        assert_eq!(staged.version, "v2");
        assert!(staged.staged);
        assert_eq!(status.active.unwrap().version, "v1");
        assert_eq!(status.previous.unwrap().version, "v2");
        assert_eq!(status.staged.unwrap().version, "v2");

        let activated = service
            .update("zelda64-recomp", None, None, true, |_| {})
            .await
            .unwrap();
        let status = service.status("zelda64-recomp").unwrap();
        assert_eq!(activated.version, "v2");
        assert_eq!(status.active.unwrap().version, "v2");
        assert_eq!(status.previous.unwrap().version, "v1");
        assert!(status.staged.is_none());
    }

    #[tokio::test]
    async fn reconcile_reports_notify_and_promotes_a_staged_automatic_update() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        register_zelda_install(&library, "v1", true);
        register_zelda_install(&library, "v2", false);
        let service = service_with_release(library, "v2");

        let notification = service.reconcile("zelda64-recomp", |_| {}).await.unwrap();
        assert_eq!(notification.action, ReconcileAction::Notify);
        assert!(notification.check.update_available);
        assert!(notification.install.is_none());

        service
            .set_update_policy("zelda64-recomp", UpdatePolicy::Stage)
            .unwrap();
        let staged = service.reconcile("zelda64-recomp", |_| {}).await.unwrap();
        assert_eq!(staged.action, ReconcileAction::Staged);
        assert_eq!(staged.install.unwrap().version, "v2");

        service
            .set_update_policy("zelda64-recomp", UpdatePolicy::Automatic)
            .unwrap();
        let activated = service.reconcile("zelda64-recomp", |_| {}).await.unwrap();
        assert_eq!(activated.action, ReconcileAction::Activated);
        assert_eq!(activated.install.unwrap().version, "v2");
        assert_eq!(
            service
                .status("zelda64-recomp")
                .unwrap()
                .active
                .unwrap()
                .version,
            "v2"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn reconcile_uses_post_lock_policy_and_staged_state() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        register_zelda_install(&library, "v1", true);
        let blocker = release_blocker("v2");
        let service =
            Arc::new(PortcoveService::with_provider(library.clone(), blocker.provider).unwrap());
        let task_service = service.clone();
        let reconcile =
            tokio::spawn(async move { task_service.reconcile("zelda64-recomp", |_| {}).await });
        assert_eq!(
            blocker
                .started
                .recv_timeout(Duration::from_secs(5))
                .unwrap(),
            ReleaseChannel::Stable
        );

        register_zelda_install(&library, "v2", false);
        library
            .set_update_policy(
                "zelda64-recomp",
                UpdatePolicy::Automatic,
                ReleaseChannel::Stable,
            )
            .unwrap();
        release_blocker_continue(&blocker.gate);

        let result = reconcile.await.unwrap().unwrap();
        assert_eq!(result.policy, UpdatePolicy::Automatic);
        assert_eq!(result.action, ReconcileAction::Activated);
        assert_eq!(result.install.unwrap().version, "v2");
        let status = service.status("zelda64-recomp").unwrap();
        assert_eq!(status.active.unwrap().version, "v2");
        assert!(status.staged.is_none());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn reconcile_retries_a_changed_channel_before_acting() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let path = library
            .versions_dir()
            .join("g-diffuser")
            .join("a".repeat(64));
        fs::create_dir_all(&path).unwrap();
        write_host_test_executable(&path, "g-diffuser");
        register_existing_test_install(&library, "g-diffuser", "v1", &path, true);
        let blocker = release_blocker("v2");
        let service =
            Arc::new(PortcoveService::with_provider(library.clone(), blocker.provider).unwrap());
        let task_service = service.clone();
        let reconcile =
            tokio::spawn(async move { task_service.reconcile("g-diffuser", |_| {}).await });
        assert_eq!(
            blocker
                .started
                .recv_timeout(Duration::from_secs(5))
                .unwrap(),
            ReleaseChannel::Stable
        );

        library
            .set_channel("g-diffuser", ReleaseChannel::Beta)
            .unwrap();
        release_blocker_continue(&blocker.gate);

        let result = reconcile.await.unwrap().unwrap();
        assert_eq!(result.policy, UpdatePolicy::Notify);
        assert_eq!(result.action, ReconcileAction::Notify);
        assert_eq!(result.check.channel, ReleaseChannel::Beta);
        assert_eq!(result.check.release.channel, ReleaseChannel::Beta);
        assert_eq!(
            *blocker.observed.lock().unwrap(),
            [ReleaseChannel::Stable, ReleaseChannel::Beta]
        );
    }
}
