use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Arc,
};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    ActivityOperation, ActivityRecord, ActivityStatus, ActivityTargetKind, AdapterRegistry,
    BackupRecord, Catalog, CompositeReleaseProvider, InstallPlan, InstallPlanAction, InstallRecord,
    InstallRequest, InstallSourceRequirement, Installer, LaunchBlocker, LaunchReadiness, Library,
    OperationEvent, Platform, PortDefinition, PortOperationGuard, PortPaths, PortStatus,
    PortcoveError, ReconcileAction, ReconcileResult, ReleaseChannel, ReleaseProvider,
    ResolvedRelease, RestoreResult, Result, SourceRecord, SourceRequirementRole,
    SourceVerification, UpdateCheck, UpdatePolicy, VerificationReport,
};

const LAUNCH_MARKER: &str = ".portcove-launched";

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct AdoptionPreview {
    pub source: PathBuf,
    pub detected_port_ids: Vec<String>,
    pub selected_port_id: Option<String>,
    pub application_files_will_be_copied: bool,
    pub original_will_be_modified: bool,
}

pub struct PortcoveService {
    catalog: Catalog,
    library: Library,
    releases: Arc<dyn ReleaseProvider>,
    adapters: AdapterRegistry,
}

#[derive(Debug, Clone, Copy)]
struct SourceOverrides<'a> {
    source: Option<&'a Path>,
    bios: Option<&'a Path>,
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
        Ok(Self {
            catalog: Catalog::embedded()?,
            library,
            releases,
            adapters: AdapterRegistry,
        })
    }

    pub fn with_provider(library: Library, releases: Arc<dyn ReleaseProvider>) -> Result<Self> {
        Ok(Self {
            catalog: Catalog::embedded()?,
            library,
            releases,
            adapters: AdapterRegistry,
        })
    }

    pub fn catalog(&self) -> &Catalog {
        &self.catalog
    }
    pub fn library(&self) -> &Library {
        &self.library
    }

    fn finish_activity<T>(&self, activity: ActivityRecord, result: Result<T>) -> Result<T> {
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
        let status = self.library.status(port_id, default_channel(port))?;
        self.with_launch_readiness(port, status)
    }

    pub fn statuses(&self) -> Result<Vec<PortStatus>> {
        self.catalog
            .ports()
            .iter()
            .map(|port| {
                let status = self.library.status(&port.id, default_channel(port))?;
                self.with_launch_readiness(port, status)
            })
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
        let staging_path = temporary.keep();
        if let Err(error) = fs::rename(&staging_path, &final_path) {
            let _ = fs::remove_dir_all(&staging_path);
            return Err(error.into());
        }
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
            if !entry.file_type()?.is_dir() || entry.file_name().to_string_lossy().starts_with('.')
            {
                continue;
            }
            let path = entry.path();
            let manifest: BackupManifest =
                serde_json::from_reader(fs::File::open(path.join("backup.json"))?)?;
            let directory_id = entry.file_name().to_string_lossy().into_owned();
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

    pub fn restore_backup(&self, port_id: &str, backup_id: &str) -> Result<RestoreResult> {
        let activity = self.library.begin_activity(
            ActivityOperation::Restore,
            ActivityTargetKind::Port,
            Some(port_id),
        )?;
        let result = (|| {
            self.catalog.port(port_id)?;
            let _operation = self.library.try_lock_port(port_id, "restore-backup")?;
            self.collect_active_user_data_if_launched(port_id)?;
            let restored_backup = self.load_backup(port_id, backup_id)?;

            let user_root = self.library.user_dir(port_id);
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
            let staging = tempfile::Builder::new()
                .prefix(".restore-")
                .tempdir_in(user_parent)?;
            let staged_data = staging.path().join("data");
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
            replace_user_data(&user_root, &staged_data)?;
            Ok(RestoreResult {
                restored_backup,
                safety_backup,
            })
        })();
        self.finish_activity(activity, result)
    }

    pub fn delete_backup(&self, port_id: &str, backup_id: &str) -> Result<BackupRecord> {
        let activity = self.library.begin_activity(
            ActivityOperation::DeleteBackup,
            ActivityTargetKind::Port,
            Some(port_id),
        )?;
        let result = (|| {
            self.catalog.port(port_id)?;
            let _operation = self.library.try_lock_port(port_id, "delete-backup")?;
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
            .is_some_and(|install| install.version == release.version)
        {
            return Ok(InstallPlanAction::AlreadyActive);
        }
        if status
            .staged
            .as_ref()
            .is_some_and(|install| install.version == release.version)
        {
            return Ok(InstallPlanAction::UseStaged);
        }
        let Some(retained) = self
            .library
            .install_by_version(&status.port_id, &release.version)?
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
    ) -> Result<PortStatus> {
        let mut blockers = Vec::new();
        if let Some(profile_id) = &port.source_profile
            && self.library.source(profile_id)?.is_none()
        {
            blockers.push(LaunchBlocker::MissingSource);
        }
        if let Some(profile_id) = &port.bios_source_profile
            && self.library.source(profile_id)?.is_none()
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
        status.last_update_check = self.library.update_snapshot(&port.id)?;
        Ok(status)
    }

    pub async fn check_update(&self, port_id: &str) -> Result<UpdateCheck> {
        let activity = self.library.begin_activity(
            ActivityOperation::CheckUpdate,
            ActivityTargetKind::Port,
            Some(port_id),
        )?;
        let result = async {
            let port = self.catalog.port(port_id)?;
            let status = self.status(port_id)?;
            let release = self
                .releases
                .resolve(port, status.channel, Platform::current()?)
                .await?;
            self.record_update_check(port_id, &status, &release)
        }
        .await;
        self.finish_activity(activity, result)
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
        let update_available = installed_version
            .as_deref()
            .is_none_or(|version| version != release.version);
        let check = UpdateCheck {
            port_id: port_id.into(),
            channel: status.channel,
            installed_version,
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
        self.catalog.port(port_id)?;
        let _operation = self.library.try_lock_port(port_id, "set-policy")?;
        self.library.set_update_policy(port_id, policy)?;
        self.status(port_id)
    }

    pub fn register_source(&self, profile_id: &str, path: &Path) -> Result<SourceRecord> {
        let activity = self.library.begin_activity(
            ActivityOperation::RegisterSource,
            ActivityTargetKind::Source,
            Some(profile_id),
        )?;
        let result = (|| {
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
        let profile = self.catalog.source_profile(profile_id)?;
        let registered = self.library.source(profile_id)?.ok_or_else(|| {
            PortcoveError::not_found(format!("source profile {profile_id} is not registered"))
        })?;
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
        emit: F,
    ) -> Result<InstallRecord>
    where
        F: FnMut(OperationEvent),
    {
        let activity = self.library.begin_activity(
            ActivityOperation::Install,
            ActivityTargetKind::Port,
            Some(port_id),
        )?;
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
            self.apply_resolved_release(
                port,
                status,
                SourceOverrides {
                    source: source_override,
                    bios: bios_override,
                },
                release,
                activate,
                emit,
            )
            .await
        }
        .await;
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
        emit: F,
    ) -> Result<InstallRecord>
    where
        F: FnMut(OperationEvent),
    {
        let activity = self.library.begin_activity(
            ActivityOperation::Update,
            ActivityTargetKind::Port,
            Some(port_id),
        )?;
        let result = async {
            let _operation = self.library.try_lock_port(port_id, "update")?;
            let status = self.status(port_id)?;
            let port = self.catalog.port(port_id)?;
            let release = self
                .releases
                .resolve(port, status.channel, Platform::current()?)
                .await?;
            self.record_update_check(port_id, &status, &release)?;
            self.apply_resolved_release(
                port,
                status,
                SourceOverrides {
                    source: source_override,
                    bios: bios_override,
                },
                release,
                activate,
                emit,
            )
            .await
        }
        .await;
        self.finish_activity(activity, result)
    }

    async fn apply_resolved_release<F>(
        &self,
        port: &PortDefinition,
        status: PortStatus,
        overrides: SourceOverrides<'_>,
        release: ResolvedRelease,
        activate: bool,
        mut emit: F,
    ) -> Result<InstallRecord>
    where
        F: FnMut(OperationEvent),
    {
        if let Some(active) = &status.active
            && active.version == release.version
        {
            return Ok(active.clone());
        }
        if let Some(staged) = &status.staged
            && staged.version == release.version
        {
            return if activate {
                self.activate_staged_locked(&port.id)
            } else {
                Ok(staged.clone())
            };
        }
        if let Some(mut existing) = self
            .library
            .install_by_version(&port.id, &release.version)?
        {
            if !existing.verified {
                return Err(PortcoveError::verification(format!(
                    "existing {} version {} is not verified",
                    port.name, release.version
                )));
            }
            self.collect_active_user_data_if_launched(&port.id)?;
            self.library.register_install(&existing, activate)?;
            existing.staged = !activate;
            return Ok(existing);
        }
        self.collect_active_user_data_if_launched(&port.id)?;
        let source = self.validate_and_remember_source(port, overrides.source)?;
        let bios = self.validate_and_remember_bios(port, overrides.bios)?;
        let platform = Platform::current()?;
        let managed = self
            .managed_preparation(port, source, bios, platform, &mut emit)
            .await?;
        Installer::new(self.library.clone())?
            .install(
                InstallRequest {
                    port_id: port.id.clone(),
                    release,
                    activate,
                    managed,
                },
                emit,
            )
            .await
    }

    pub async fn reconcile<F>(&self, port_id: &str, emit: F) -> Result<ReconcileResult>
    where
        F: FnMut(OperationEvent),
    {
        let activity = self.library.begin_activity(
            ActivityOperation::Reconcile,
            ActivityTargetKind::Port,
            Some(port_id),
        )?;
        let result = async {
            let port = self.catalog.port(port_id)?;
            let status = self.status(port_id)?;
            if status.active.is_none() {
                return Err(PortcoveError::not_found(format!(
                    "{port_id} is not installed"
                )));
            }
            let release = self
                .releases
                .resolve(port, status.channel, Platform::current()?)
                .await?;
            let check = self.record_update_check(port_id, &status, &release)?;
            let update_available = check.update_available;
            if !update_available {
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
            let _operation = self.library.try_lock_port(port_id, "reconcile")?;
            let activate = status.update_policy == UpdatePolicy::Automatic;
            let install = self
                .apply_resolved_release(
                    port,
                    status.clone(),
                    SourceOverrides {
                        source: None,
                        bios: None,
                    },
                    release,
                    activate,
                    emit,
                )
                .await?;
            Ok(ReconcileResult {
                port_id: port_id.into(),
                policy: status.update_policy,
                action: if activate {
                    ReconcileAction::Activated
                } else {
                    ReconcileAction::Staged
                },
                check,
                install: Some(install),
            })
        }
        .await;
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
        let toolchain_root = crate::psx::ensure_toolchain(&self.library, platform, emit).await?;
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
            self.activate_staged_locked(port_id)
        })();
        self.finish_activity(activity, result)
    }

    fn activate_staged_locked(&self, port_id: &str) -> Result<InstallRecord> {
        self.collect_active_user_data_if_launched(port_id)?;
        self.library.activate_staged(port_id)
    }

    pub fn preview_adoption(
        &self,
        source: &Path,
        selected_port_id: Option<&str>,
    ) -> Result<AdoptionPreview> {
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
            self.adapters
                .get(port.adapter)
                .find_executable(port, platform, source)?;
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
                if self
                    .adapters
                    .get(port.adapter)
                    .find_executable(port, platform, source)
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
        Ok(AdoptionPreview {
            source: source.to_path_buf(),
            detected_port_ids: detected,
            selected_port_id: selected,
            application_files_will_be_copied: true,
            original_will_be_modified: false,
        })
    }

    pub fn adopt(&self, source: &Path, selected_port_id: Option<&str>) -> Result<InstallRecord> {
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
        let result = (|| {
            let port = self.catalog.port(&port_id)?;
            let _operation = self.library.try_lock_port(&port_id, "adopt")?;
            let timestamp = Library::now();
            let version = format!("adopted-{timestamp}");
            let destination = self.library.versions_dir().join(&port_id).join(&version);
            if destination.exists() {
                return Err(PortcoveError::conflict(
                    "adoption destination already exists",
                ));
            }
            copy_tree(source, &destination)?;
            let user_root = self.library.user_dir(&port_id);
            let persistent_root = self.persistence_root(port, source)?;
            for relative in &port.persistent_paths {
                let candidate = persistent_root.join(relative);
                if candidate.exists() {
                    copy_entry(&candidate, &user_root.join(relative))?;
                }
            }
            let installer = Installer::new(self.library.clone())?;
            installer.create_manifest(&port_id, &version, &destination)?;
            let install = InstallRecord {
                id: Uuid::new_v4().to_string(),
                port_id: port_id.clone(),
                version,
                path: destination,
                channel: default_channel(port),
                installed_at: timestamp,
                verified: true,
                staged: false,
            };
            self.library.register_install(&install, true)?;
            Ok(install)
        })();
        self.finish_activity(activity, result)
    }

    pub fn remove(&self, port_id: &str) -> Result<Vec<PathBuf>> {
        let activity = self.library.begin_activity(
            ActivityOperation::Remove,
            ActivityTargetKind::Port,
            Some(port_id),
        )?;
        let result = (|| {
            self.catalog.port(port_id)?;
            let _operation = self.library.try_lock_port(port_id, "remove")?;
            self.collect_active_user_data_if_launched(port_id)?;
            let paths = self.library.remove_port(port_id)?;
            for path in &paths {
                if path.starts_with(self.library.versions_dir()) && path.is_dir() {
                    fs::remove_dir_all(path)?;
                }
            }
            Ok(paths)
        })();
        self.finish_activity(activity, result)
    }

    pub fn prepare_launch(
        &self,
        port_id: &str,
        source_override: Option<&Path>,
    ) -> Result<(crate::LaunchSpec, PortOperationGuard)> {
        let operation = self.library.try_lock_port(port_id, "launch")?;
        let spec = self.launch_spec(port_id, source_override)?;
        Ok((spec, operation))
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
        let source = if let Some(path) = source_override {
            let profile_id = port.source_profile.as_deref().ok_or_else(|| {
                PortcoveError::usage(format!("{} does not accept a source override", port.name))
            })?;
            let profile = self.catalog.source_profile(profile_id)?;
            self.adapters
                .get(port.adapter)
                .validate_source(profile, path)?;
            Some(path.to_path_buf())
        } else if let Some(profile) = &port.source_profile {
            if self.library.source(profile)?.is_some() {
                Some(self.verified_source_record(profile)?.path)
            } else {
                None
            }
        } else {
            None
        };
        let launch_marker = active.path.join(LAUNCH_MARKER);
        if launch_marker.is_file() {
            self.collect_user_data_from(port, &active.path)?;
        }
        self.restore_user_data_to(port, &active.path)?;
        let spec = self.adapters.get(port.adapter).launch_spec(
            &self.library,
            port,
            Platform::current()?,
            &active.path,
            source.as_deref(),
        )?;
        fs::write(&launch_marker, b"1")?;
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

    fn collect_active_user_data_if_launched(&self, port_id: &str) -> Result<Vec<PathBuf>> {
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
        if port.adapter == crate::AdapterKind::N64RecompPortable {
            return Ok(install_root.to_path_buf());
        }
        let executable = self.adapters.get(port.adapter).find_executable(
            port,
            Platform::current()?,
            install_root,
        )?;
        Ok(executable.parent().unwrap_or(install_root).to_path_buf())
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

fn replace_user_data(user_root: &Path, staged_data: &Path) -> Result<()> {
    let parent = user_root.parent().ok_or_else(|| {
        PortcoveError::state(format!(
            "persistent data root has no parent: {}",
            user_root.display()
        ))
    })?;
    let previous = parent.join(format!(".restore-rollback-{}", Uuid::new_v4()));
    let had_previous = user_root.exists();
    if had_previous {
        fs::rename(user_root, &previous)?;
    }
    if let Err(install_error) = fs::rename(staged_data, user_root) {
        if had_previous && let Err(rollback_error) = fs::rename(&previous, user_root) {
            return Err(PortcoveError::state(format!(
                "restore failed ({install_error}) and the previous data could not be returned ({rollback_error}); recovery data remains at {}",
                previous.display()
            )));
        }
        return Err(install_error.into());
    }
    if had_previous && let Err(error) = fs::remove_dir_all(&previous) {
        tracing::warn!(path = %previous.display(), "restored data but could not remove the temporary previous copy: {error}");
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
            PortcoveError::conflict(format!(
                "backup source contains a non-Unicode path: {}",
                path.display()
            ))
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

fn copy_tree(source: &Path, destination: &Path) -> Result<()> {
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
    use super::*;

    #[derive(Clone)]
    struct StaticReleaseProvider {
        version: String,
    }

    #[async_trait::async_trait]
    impl ReleaseProvider for StaticReleaseProvider {
        async fn resolve(
            &self,
            _port: &PortDefinition,
            channel: ReleaseChannel,
            _platform: Platform,
        ) -> Result<ResolvedRelease> {
            Ok(ResolvedRelease {
                version: self.version.clone(),
                channel,
                published_at: None,
                asset: crate::ReleaseAsset {
                    name: "test.zip".into(),
                    url: "https://invalid.example/test.zip".into(),
                    size: 1,
                    sha256: "0".repeat(64),
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

    fn register_zelda_install(library: &Library, version: &str, active: bool) -> PathBuf {
        let path = library.versions_dir().join("zelda64-recomp").join(version);
        fs::create_dir_all(&path).unwrap();
        fs::write(path.join("Zelda64Recompiled.exe"), b"test").unwrap();
        library
            .register_install(
                &InstallRecord {
                    id: Uuid::new_v4().to_string(),
                    port_id: "zelda64-recomp".into(),
                    version: version.into(),
                    path: path.clone(),
                    channel: ReleaseChannel::Stable,
                    installed_at: Library::now(),
                    verified: true,
                    staged: !active,
                },
                active,
            )
            .unwrap();
        path
    }

    fn register_gen1_install(library: &Library, version: &str, active: bool) -> PathBuf {
        let path = library.versions_dir().join("gen1recomp").join(version);
        let executable_root = path.join("gen1recomp-win64");
        fs::create_dir_all(&executable_root).unwrap();
        fs::write(executable_root.join("gen1recomp.exe"), b"test").unwrap();
        library
            .register_install(
                &InstallRecord {
                    id: Uuid::new_v4().to_string(),
                    port_id: "gen1recomp".into(),
                    version: version.into(),
                    path: path.clone(),
                    channel: ReleaseChannel::Stable,
                    installed_at: Library::now(),
                    verified: true,
                    staged: !active,
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

        let restored = service
            .restore_backup("zelda64-recomp", &wanted.id)
            .unwrap();

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

        let error = service
            .restore_backup("zelda64-recomp", &backup.id)
            .unwrap_err();

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

        let restored = service
            .restore_backup("zelda64-recomp", &backup.id)
            .unwrap();

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

        let deleted = service.delete_backup("zelda64-recomp", &backup.id).unwrap();

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
        fs::write(install.join("gk.exe"), b"test").unwrap();
        library
            .register_install(
                &InstallRecord {
                    id: Uuid::new_v4().to_string(),
                    port_id: "opengoal-jak1".into(),
                    version: "v1".into(),
                    path: install.clone(),
                    channel: ReleaseChannel::Stable,
                    installed_at: Library::now(),
                    verified: true,
                    staged: false,
                },
                true,
            )
            .unwrap();
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
    fn launch_rejects_a_changed_registered_source_until_it_is_replaced() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let install = library.versions_dir().join("starship/v1");
        fs::create_dir_all(&install).unwrap();
        fs::write(install.join("starship.exe"), b"test").unwrap();
        library
            .register_install(
                &InstallRecord {
                    id: Uuid::new_v4().to_string(),
                    port_id: "starship".into(),
                    version: "v1".into(),
                    path: install.clone(),
                    channel: ReleaseChannel::Stable,
                    installed_at: Library::now(),
                    verified: true,
                    staged: false,
                },
                true,
            )
            .unwrap();
        let source = temporary.path().join("star-fox-64.z64");
        fs::write(&source, b"original source").unwrap();
        let service = PortcoveService::new(library).unwrap();
        service.register_source("star-fox-64", &source).unwrap();

        fs::write(&source, b"changed source").unwrap();
        let error = service.launch_spec("starship", None).unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::SourceInvalid);
        assert!(!install.join(LAUNCH_MARKER).exists());

        service.register_source("star-fox-64", &source).unwrap();
        fs::remove_file(install.join("starship.exe")).unwrap();
        let error = service.launch_spec("starship", None).unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Launch);
        assert!(!install.join(LAUNCH_MARKER).exists());

        fs::write(install.join("starship.exe"), b"test").unwrap();
        let launch = service.launch_spec("starship", None).unwrap();
        assert_eq!(
            launch.environment.get("PORTCOVE_SOURCE"),
            Some(&source.to_string_lossy().into_owned())
        );
        assert!(install.join(LAUNCH_MARKER).exists());
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
        fs::write(install.join("Lighthouse.exe"), b"test").unwrap();
        library
            .register_install(
                &InstallRecord {
                    id: Uuid::new_v4().to_string(),
                    port_id: "lighthouse".into(),
                    version: "v1".into(),
                    path: install,
                    channel: ReleaseChannel::Stable,
                    installed_at: Library::now(),
                    verified: true,
                    staged: false,
                },
                true,
            )
            .unwrap();
        let invalid = temporary.path().join("not-a-rom.txt");
        fs::write(&invalid, b"not a ROM").unwrap();
        let service = PortcoveService::new(library).unwrap();

        let error = service
            .launch_spec("lighthouse", Some(&invalid))
            .unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::SourceInvalid);
    }

    #[test]
    fn a_launch_blocks_mutation_until_post_exit_collection_can_finish() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        register_zelda_install(&library, "v1", true);
        let service = PortcoveService::new(library).unwrap();
        let (_spec, launch_guard) = service.prepare_launch("zelda64-recomp", None).unwrap();

        let settings_conflict = service
            .set_update_policy("zelda64-recomp", UpdatePolicy::Automatic)
            .unwrap_err();
        assert_eq!(settings_conflict.code, crate::ErrorCode::Conflict);
        let conflict = service.remove("zelda64-recomp").unwrap_err();
        assert_eq!(conflict.code, crate::ErrorCode::Conflict);
        assert_eq!(conflict.details["port_id"], "zelda64-recomp");

        drop(launch_guard);
        assert!(!service.remove("zelda64-recomp").unwrap().is_empty());
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
}
