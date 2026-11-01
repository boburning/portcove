use std::{
    collections::{HashMap, HashSet},
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
};

use crate::installed_mutability::shipwright_windows_cwd_persistence;
use futures_util::{StreamExt, stream};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

#[cfg(any(test, not(feature = "qualification-fixtures")))]
use crate::operation::NoLifecycleFaults;
use crate::{
    ActivityOperation, ActivityRecord, ActivityStatus, ActivityTargetKind, BackupProblemKind,
    BackupRecord, Catalog, ChildProcessPolicy, CompositeReleaseProvider,
    DefinitionEligibilityOutcome, DefinitionOperation, DefinitionOperationAssessment, DoctorReport,
    ExternalRuntimePreview, ExternalRuntimeRecord, ExternalRuntimeRemovalPreview, InstallPlan,
    InstallPlanAction, InstallQualification, InstallRecord, InstallRequest,
    InstallSourceRequirement, Installer, LaunchBlocker, LaunchReadiness, LaunchSessionOutcome,
    LaunchSessionPhase, LaunchSessionRecord, LaunchStdio, Library, OperationCoordinator,
    OperationEvent, OperationResult, OutputAffectedInstall, OutputDestinationPreview,
    OutputLocationSource, Platform, PortAction, PortActionAssessment, PortActionAvailability,
    PortActionReason, PortDefinition, PortOutputLocation, PortPaths, PortStatus, PortcoveError,
    ReconcileAction, ReconcileResult, ReleaseChannel, ReleaseProvider, ReleaseSource, RepairItem,
    RepairItemKind, RepairPlan, ResolvedRelease, Result, SourceHealth, SourceRecord,
    SourceRequirementRole, SupervisedLaunchOutcome, UpdateCheck, UpdatePolicy, VerificationReport,
    WorkspaceSnapshot,
    definition_eligibility::DefinitionOperationContext,
    operation::{
        LifecycleFaultInjector, LifecycleFaultPoint, LifecycleOperation, LifecycleOperationKind,
        LifecyclePhase, OperationStore,
    },
    path::refuse_symlink_ancestors,
};

mod backups;
mod protection;
use crate::AdapterKind;
pub use protection::{InstallationProtection, PlayerDataProtection, ProtectionDeclaration};
mod catalog_download;
mod native_portable;
pub(crate) mod package_selection;
mod retained_direct_compatibility;
mod setup_discovery;
pub use catalog_download::{
    CatalogDownloadCandidate, CatalogDownloadCandidates, CatalogDownloadCoverage,
    CatalogDownloadPreview, CatalogDownloadRequest, PendingSetupRecord, PendingSetupState,
};
pub use package_selection::{CatalogDownloadRelease, CatalogPackageAssessment};
pub use setup_discovery::{SetupLaunchTarget, SetupLaunchTargets};
mod external_relink;
mod installation_route_change;
pub use installation_route_change::{ManagedRouteChangePreview, ManagedRouteChangeResult};
#[cfg(test)]
mod generated_cache_tests;
mod ghostship_compatibility;
#[cfg(test)]
mod ghostship_persistence_tests;
mod ghostship_recovery;
mod ghostship_recovery_execution;
mod ghostship_safety;
#[cfg(test)]
mod shipwright_persistence_tests;
mod user_selected;
pub(crate) use backups::{BackupDeletionPhase, RestorePhase};
#[cfg(any(test, feature = "qualification-fixtures"))]
mod forbidden_memories_qualification;
mod launch_preparation;
mod listings;
mod psx_mod_data;
pub(crate) use psx_mod_data::metadata_name as psx_data_metadata_name;
mod removal;
mod sources;
pub(crate) use removal::{RemovalOperation, RemovalPhase};

const LAUNCH_MARKER: &str = ".portcove-launched";
pub(crate) const PSX_DATA_RECEIPT: &str = ".portcove-psx-data-restored.json";
pub(crate) const PSX_DATA_WRITE_PREFIX: &str = ".portcove-psx-data-write-";
const BULK_PROVIDER_CONCURRENCY: usize = 4;

struct RollbackTargetFailure {
    reason: PortActionReason,
    error: PortcoveError,
    definition: Option<crate::DefinitionEligibility>,
}

struct PersistenceContract {
    port: PortDefinition,
    writes_directly: bool,
}

#[cfg(test)]
std::thread_local! {
    static ADOPTION_COPY_PLAN_PASSES: std::cell::RefCell<std::collections::BTreeMap<PathBuf, usize>> =
        const { std::cell::RefCell::new(std::collections::BTreeMap::new()) };
}

#[path = "game_install_review.rs"]
mod game_install_review;
#[path = "game_update_acquisition.rs"]
pub(crate) mod game_update_acquisition;
#[path = "game_update_review.rs"]
mod game_update_review;

fn add_source_blocker(blockers: &mut Vec<LaunchBlocker>, health: Option<SourceHealth>, bios: bool) {
    let blocker = match (health, bios) {
        (Some(SourceHealth::Unregistered | SourceHealth::Missing), false) => {
            Some(LaunchBlocker::MissingSource)
        }
        (Some(SourceHealth::Unreadable), false) => Some(LaunchBlocker::UnreadableSource),
        (Some(SourceHealth::Changed), false) => Some(LaunchBlocker::ChangedSource),
        (Some(SourceHealth::Unregistered | SourceHealth::Missing), true) => {
            Some(LaunchBlocker::MissingBios)
        }
        (Some(SourceHealth::Unreadable), true) => Some(LaunchBlocker::UnreadableBios),
        (Some(SourceHealth::Changed), true) => Some(LaunchBlocker::ChangedBios),
        _ => None,
    };
    if let Some(blocker) = blocker {
        blockers.push(blocker);
    }
}

fn restore_setup_manifest(
    manifest_path: &Path,
    previous_manifest: &[u8],
    install: &InstallRecord,
    refresh_error: PortcoveError,
) -> Result<()> {
    match crate::durability::write_bytes_atomically(manifest_path, previous_manifest, true) {
        Ok(()) => Err(refresh_error),
        Err(restore_error) => Err(PortcoveError::state(
            "setup manifest refresh failed and its prior bytes could not be restored",
        )
        .detail("install_id", &install.id)
        .detail("refresh_error", refresh_error.message)
        .detail("restore_error", restore_error.to_string())),
    }
}

#[cfg(test)]
#[path = "runtime_tests.rs"]
mod runtime_tests;

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
pub struct AdoptionDestinationPreview {
    pub output_location: PortOutputLocation,
    pub active_install: Option<InstallRecord>,
    pub imported_user_data_paths: Vec<PathBuf>,
    pub current_user_data_files: usize,
    pub current_user_data_sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct AdoptionPreview {
    pub source: PathBuf,
    pub detected_port_ids: Vec<String>,
    pub selected_port_id: Option<String>,
    pub application_files_will_be_copied: bool,
    pub original_will_be_modified: bool,
    pub copy_plan: AdoptionCopyPlan,
    pub destination: Option<AdoptionDestinationPreview>,
    pub plan_sha256: String,
}

/// Public reviewed backup actions; persisted manifests remain an implementation detail.
///
/// ```
/// use portcove_core::{BackupAction, PortcoveService};
/// let action = BackupAction::Restore;
/// let _ = action;
/// ```
///
/// ```compile_fail,E0432
/// use portcove_core::BackupManifest;
/// ```
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
    pub retained_runtime_copy_will_be_deleted: bool,
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
    pub(crate) cancellation_owner: String,
    pub(crate) cancellation_requested: std::sync::atomic::AtomicBool,
    catalog: Catalog,
    catalog_provenance: crate::CatalogProvenance,
    pub(crate) library: Library,
    releases: Arc<dyn ReleaseProvider>,
    faults: Arc<dyn LifecycleFaultInjector>,
}

#[derive(Debug, Clone, Copy)]
pub struct IdentifiedLaunchRequest<'a> {
    pub request_id: &'a str,
    pub port_id: &'a str,
    pub source_override: Option<&'a Path>,
    pub arguments: &'a [String],
    pub stdio: LaunchStdio,
}

#[derive(Debug, Clone, Copy)]
pub struct InstallOverrides<'a> {
    pub source: Option<&'a Path>,
    pub bios: Option<&'a Path>,
    pub output_directory: Option<&'a Path>,
}

/// Ephemeral reviewed publication intent; durable authority stays in the
/// consumed authorization and retained installation manifest.
struct ReleaseIntent {
    activate: bool,
    shared_preferences: Option<crate::managed_shared_preferences::Acceptance>,
    acquired: Option<game_update_acquisition::AcquiredInputs>,
}

fn enum_value(value: impl Serialize) -> Result<String> {
    serde_json::to_value(value)?
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| PortcoveError::state("operation eligibility enum did not serialize as text"))
}

fn artifact_matches_release(
    install: &InstallRecord,
    release: &ResolvedRelease,
    runtime: Option<&crate::RuntimeIdentity>,
) -> bool {
    install
        .artifact
        .sha256
        .eq_ignore_ascii_case(&release.asset.sha256)
        && install.runtime.as_ref() == runtime
        && install.artifact.asset_name == release.asset.name
        && (release.asset.size == 0 || install.artifact.size == release.asset.size)
}

struct OperationReporter<'a, F> {
    operation: &'a OperationCoordinator,
    emit: &'a mut F,
}

fn install_cleanup_retry_message(previous: Option<&str>, current: &str) -> String {
    const RETRY_SEPARATOR: &str = "; private preparation cleanup retry failed: ";
    const MAX_CAUSE_CHARS: usize = 1024;
    let original = previous
        .unwrap_or("install cleanup failed")
        .split_once(RETRY_SEPARATOR)
        .map_or(
            previous.unwrap_or("install cleanup failed"),
            |(cause, _)| cause,
        );
    format!(
        "{}{}{}",
        original.chars().take(MAX_CAUSE_CHARS).collect::<String>(),
        RETRY_SEPARATOR,
        current.chars().take(MAX_CAUSE_CHARS).collect::<String>()
    )
}

impl PortcoveService {
    pub fn new(library: Library) -> Result<Self> {
        let service = Self::new_read_only(library)?;
        service.recover_pending_operations()?;
        Ok(service)
    }

    /// Open core state for observation without advancing durable recovery.
    pub fn new_read_only(library: Library) -> Result<Self> {
        let releases = Arc::new(CompositeReleaseProvider::for_library(&library)?);
        let (catalog, catalog_provenance) = library.load_catalog()?;
        #[cfg(feature = "qualification-fixtures")]
        let faults = crate::qualification_checkpoint::faults(library.root());
        #[cfg(not(feature = "qualification-fixtures"))]
        let faults = Arc::new(NoLifecycleFaults);
        Ok(Self {
            cancellation_owner: Uuid::new_v4().to_string(),
            cancellation_requested: std::sync::atomic::AtomicBool::new(false),
            catalog,
            catalog_provenance,
            library,
            releases,
            faults,
        })
    }

    pub fn with_provider(library: Library, releases: Arc<dyn ReleaseProvider>) -> Result<Self> {
        let service = Self::with_provider_read_only(library, releases)?;
        service.recover_pending_operations()?;
        Ok(service)
    }

    /// Use a supplied provider for observation without advancing recovery.
    pub fn with_provider_read_only(
        library: Library,
        releases: Arc<dyn ReleaseProvider>,
    ) -> Result<Self> {
        let (catalog, catalog_provenance) = library.load_catalog()?;
        #[cfg(feature = "qualification-fixtures")]
        let faults = crate::qualification_checkpoint::faults(library.root());
        #[cfg(not(feature = "qualification-fixtures"))]
        let faults = Arc::new(NoLifecycleFaults);
        Ok(Self {
            cancellation_owner: Uuid::new_v4().to_string(),
            cancellation_requested: std::sync::atomic::AtomicBool::new(false),
            catalog,
            catalog_provenance,
            library,
            releases,
            faults,
        })
    }

    /// Explicitly discover and retry orphaned work under its existing locks.
    pub fn recover_pending_operations(&self) -> Result<()> {
        self.recover_catalog_downloads()?;
        self.recover_cancellations()?;
        self.recover_lifecycle_operations()?;
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn with_provider_and_faults(
        library: Library,
        releases: Arc<dyn ReleaseProvider>,
        faults: Arc<dyn LifecycleFaultInjector>,
    ) -> Result<Self> {
        let (catalog, catalog_provenance) = library.load_catalog()?;
        Ok(Self {
            cancellation_owner: Uuid::new_v4().to_string(),
            cancellation_requested: std::sync::atomic::AtomicBool::new(false),
            catalog,
            catalog_provenance,
            library,
            releases,
            faults,
        })
    }

    #[cfg(test)]
    pub(crate) fn with_faults(
        library: Library,
        faults: Arc<dyn LifecycleFaultInjector>,
    ) -> Result<Self> {
        let releases = Arc::new(CompositeReleaseProvider::for_library(&library)?);
        let (catalog, catalog_provenance) = library.load_catalog()?;
        Ok(Self {
            cancellation_owner: Uuid::new_v4().to_string(),
            cancellation_requested: std::sync::atomic::AtomicBool::new(false),
            catalog,
            catalog_provenance,
            library,
            releases,
            faults,
        })
    }

    pub fn catalog(&self) -> &Catalog {
        &self.catalog
    }
    #[cfg(test)]
    pub(crate) fn replace_catalog_for_test(&mut self, catalog: Catalog) {
        self.catalog = catalog;
    }
    pub fn library(&self) -> &Library {
        &self.library
    }

    pub fn doctor(&self) -> Result<DoctorReport> {
        self.doctor_with_preferences(&crate::HostPreferenceStore::open_configured()?)
    }

    pub fn doctor_with_preferences(
        &self,
        preferences: &crate::HostPreferenceStore,
    ) -> Result<DoctorReport> {
        // Doctor needs durable active pointers, not hydrated readiness/acquisition
        // assessments: malformed journals must not block their own diagnosis.
        let installed_port_count = self.library.connection()?.query_row(
            "SELECT count(*) FROM port_settings AS settings
             JOIN installs ON installs.id=settings.active_install_id
             AND installs.port_id=settings.port_id",
            [],
            |row| row.get(0),
        )?;
        Ok(DoctorReport {
            platform: Platform::current()?,
            library: self.library.storage_summary()?,
            catalog_port_count: self.catalog.ports().len(),
            catalog_provenance: self.catalog_provenance.clone(),
            installed_port_count,
            registered_source_count: self.library.sources()?.len(),
            host_tools: crate::adapter::host_tool_statuses(preferences)?,
            repair: self.repair_plan()?,
        })
    }

    pub fn repair_plan(&self) -> Result<RepairPlan> {
        // Diagnostic observations cannot stand in for the strict operation
        // inventory required by recovery, cleanup or mutation.
        let inventory = OperationStore::new(self.library.clone()).diagnostic_inventory()?;
        let operations = &inventory.decoded;
        let related_complete = inventory.report.related_assessments_complete;
        let installs = self.library.all_installs()?;
        let registered_paths = installs
            .iter()
            .map(|install| repair_path_identity(&install.path))
            .collect::<HashSet<_>>();
        let pending_final_paths = operations
            .iter()
            .filter_map(|operation| operation.paths.final_path.clone())
            .map(|path| repair_path_identity(&path))
            .collect::<HashSet<_>>();
        let mut items = operations
            .iter()
            .map(|operation| {
                let private_preparation = operation.kind == LifecycleOperationKind::Prepare
                    && operation.install.is_none()
                    && matches!(
                        operation.phase,
                        LifecyclePhase::Preparing | LifecyclePhase::CleanupPending
                    );
                RepairItem {
                kind: if private_preparation {
                    RepairItemKind::RetainedPreparation
                } else if operation.phase == LifecyclePhase::CleanupPending {
                    RepairItemKind::CleanupPending
                } else {
                    RepairItemKind::PartialOperation
                },
                operation_id: Some(operation.id.clone()),
                port_id: Some(operation.port_id.clone()),
                path: if private_preparation {
                    operation.paths.staging.clone()
                } else {
                    operation
                        .paths
                        .quarantine
                        .clone()
                        .or_else(|| operation.paths.final_path.clone())
                        .or_else(|| operation.paths.staging.clone())
                },
                message: operation.last_error.clone().unwrap_or_else(|| {
                    if private_preparation {
                        "preparation is in its private phase; check its current activity".into()
                    } else { format!(
                        "{} operation is paused at {}",
                        operation.kind, operation.phase
                    ) }
                }),
                proposed_action: if private_preparation
                    && operation.phase == LifecyclePhase::CleanupPending
                {
                    "restart Portcove to retry the accepted private cleanup; review the retained files again if cleanup remains blocked"
                } else if private_preparation {
                    "review the current activity; this interrupted setup cannot resume, so review its unfinished work and current requirements before trying again"
                } else {
                    "restart Portcove to reconcile this unfinished operation; if it remains held, review recovery and doctor output before further changes"
                }.into(),
                }
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
        if related_complete && self.library.versions_dir().is_dir() {
            for port_entry in fs::read_dir(self.library.versions_dir())? {
                let port_entry = port_entry?;
                if !port_entry.file_type()?.is_dir() {
                    continue;
                }
                for version_entry in fs::read_dir(port_entry.path())? {
                    let version_entry = version_entry?;
                    let path = version_entry.path();
                    let identity = repair_path_identity(&path);
                    if !registered_paths.contains(&identity)
                        && !pending_final_paths.contains(&identity)
                    {
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
        if related_complete {
            for port in self.catalog.ports() {
                for problem in self
                    .backup_history_with_operations(&port.id, operations)?
                    .problems
                {
                    if problem.operation_id.is_some() {
                        continue;
                    }
                    items.push(RepairItem {
                        kind: if problem.kind == BackupProblemKind::RecoveryRequired {
                            RepairItemKind::BackupRecoveryRequired
                        } else {
                            RepairItemKind::DegradedBackup
                        },
                        operation_id: None,
                        port_id: Some(port.id.clone()),
                        path: Some(problem.path),
                        message: problem.message,
                        proposed_action: problem.proposed_action,
                    });
                }
            }
        }
        if !related_complete {
            for item in &mut items {
                item.proposed_action = "review the malformed retained journal state before further operations; this report has not attempted recovery".into();
            }
        }
        items.extend(inventory.report.problems.iter().map(|problem| RepairItem {
            kind: RepairItemKind::MalformedJournal,
            // The SQLite locator is observation data, never a resumable operation ID.
            operation_id: None,
            port_id: None,
            path: None,
            message: format!(
                "lifecycle row {} (observed kind: {}, observed port: {}) requires review: {:?}: {}",
                problem.rowid,
                problem.operation_kind.as_deref().unwrap_or("unreadable or unknown"),
                problem.port_id.as_deref().unwrap_or("unreadable"),
                problem.stage, problem.reason,
            ),
            proposed_action: "preserve retained journal rows and files and obtain support for manual review; orphan and backup assessments are not evaluated while ownership is unknown; this report authorizes no repair".into(),
        }));
        items.sort_by(|left, right| {
            left.path
                .cmp(&right.path)
                .then_with(|| left.operation_id.cmp(&right.operation_id))
        });
        Ok(RepairPlan {
            generated_at: Library::now(),
            items,
            journal_diagnostics: Some(inventory.report),
        })
    }

    fn recover_lifecycle_operations(&self) -> Result<()> {
        let store = OperationStore::new(self.library.clone());
        for candidate in store.all()? {
            if candidate.kind == LifecycleOperationKind::AcquireUpdate {
                let acquisition = crate::operation::acquisition::AcquisitionOperation::decode(
                    &self.library,
                    candidate,
                )?;
                self.recover_game_update_acquisition(&store, &acquisition)?;
                continue;
            }
            #[cfg(test)]
            self.faults
                .check(LifecycleFaultPoint::RecoveryInventoried)?;
            let _guards = if candidate.kind == LifecycleOperationKind::ImportSource {
                match self.lock_source_dependents(&candidate.port_id, None) {
                    Ok(guards) => guards,
                    Err(error) if error.code == crate::ErrorCode::Conflict => continue,
                    Err(error) => return Err(error),
                }
            } else if candidate.kind == LifecycleOperationKind::GhostshipRecovery {
                match self
                    .library
                    .try_lock_port_for_ghostship_recovery(&candidate.id)
                {
                    Ok(guard) => vec![guard],
                    Err(error) if error.code == crate::ErrorCode::Conflict => continue,
                    Err(error) => return Err(error),
                }
            } else {
                match self
                    .library
                    .try_lock_port(&candidate.port_id, "recover-lifecycle-operation")
                {
                    Ok(guard) => vec![guard],
                    Err(error) if error.code == crate::ErrorCode::Conflict => continue,
                    Err(error) => return Err(error),
                }
            };
            let Some(mut operation) = store.get(&candidate.id)? else {
                continue;
            };
            // The inventory only discovers candidates. A reused or reassigned ID
            // cannot be recovered under locks chosen for its former owner/kind.
            if operation.created_at != candidate.created_at
                || operation.kind != candidate.kind
                || operation.port_id != candidate.port_id
                || self.is_reviewable_retained_preparation(&operation)?
            {
                continue;
            }
            let unstarted_removal = operation.kind == LifecycleOperationKind::Remove
                && operation.phase == LifecyclePhase::Preparing
                && operation.original_paths.is_empty();
            let reviewed_private_cleanup = operation.kind == LifecycleOperationKind::Prepare
                && operation.phase == LifecyclePhase::CleanupPending
                && operation.install.is_none();
            let failed_install_cleanup = operation.kind == LifecycleOperationKind::Install
                && operation.phase == LifecyclePhase::CleanupPending
                && operation.install.is_none();
            match self.recover_lifecycle_operation(&store, &mut operation) {
                Err(error) => {
                    // A recovery handler may retire its own journal before a later
                    // result/diagnostic step fails. Never recreate that retired row.
                    let Some(mut current) = store.get(&candidate.id)? else {
                        tracing::warn!(
                            operation_id = candidate.id,
                            port_id = candidate.port_id,
                            "lifecycle recovery retired its journal before reporting: {error}"
                        );
                        continue;
                    };
                    if current.created_at != candidate.created_at
                        || current.kind != candidate.kind
                        || current.port_id != candidate.port_id
                    {
                        continue;
                    }
                    let new_error = if failed_install_cleanup {
                        install_cleanup_retry_message(current.last_error.as_deref(), &error.message)
                    } else {
                        error.message.clone()
                    };
                    if current.last_error.as_deref() != Some(new_error.as_str()) {
                        current.last_error = Some(new_error);
                        store.put(&mut current)?;
                    }
                    tracing::warn!(
                        operation_id = operation.id,
                        port_id = operation.port_id,
                        "lifecycle recovery requires review: {error}"
                    );
                }
                Ok(recovery_message) => {
                    let message = recovery_message.as_deref().unwrap_or({
                        if unstarted_removal {
                            "removal ended before managed-file publication; no versions were removed"
                        } else if reviewed_private_cleanup || failed_install_cleanup {
                            "failed preparation remained failed; reviewed private cleanup completed"
                        } else {
                            "completed during startup recovery"
                        }
                    });
                    let _ = self.library.finish_activity(
                        &operation.id,
                        if unstarted_removal || reviewed_private_cleanup || failed_install_cleanup {
                            ActivityStatus::Failed
                        } else {
                            ActivityStatus::Succeeded
                        },
                        Some(message),
                    );
                }
            }
        }
        Ok(())
    }

    fn is_reviewable_retained_preparation(&self, operation: &LifecycleOperation) -> Result<bool> {
        if operation.kind != LifecycleOperationKind::Prepare
            || operation.phase != LifecyclePhase::Preparing
            || operation.install.is_some()
            || operation.preparation_process_quiesced != Some(true)
            || operation.last_error.is_none()
        {
            return Ok(false);
        }
        self.library
            .connection()?
            .query_row(
                "SELECT EXISTS(
               SELECT 1 FROM activity_history
               WHERE id=?1 AND operation='prepare' AND target_kind='port' AND target_id=?2
                 AND status IN ('failed', 'cancelled')
             )",
                rusqlite::params![operation.id, operation.port_id],
                |row| row.get(0),
            )
            .map_err(Into::into)
    }

    fn recover_lifecycle_operation(
        &self,
        store: &OperationStore,
        operation: &mut LifecycleOperation,
    ) -> Result<Option<String>> {
        match operation.kind {
            LifecycleOperationKind::AcquireUpdate => Err(PortcoveError::state(
                "acquisition requires its activity-owner recovery route",
            )),
            LifecycleOperationKind::Prepare => {
                crate::preparation::recover(self, store, operation).map(|()| None)
            }
            LifecycleOperationKind::Install | LifecycleOperationKind::Adopt => self
                .recover_published_install(store, operation)
                .map(|()| None),
            LifecycleOperationKind::Remove => self.recover_removal(store, operation).map(|()| None),
            LifecycleOperationKind::Restore => {
                self.recover_restore(store, operation).map(|()| None)
            }
            LifecycleOperationKind::DeleteBackup => {
                crate::recovery::recover_backup_deletion(self, store, operation).map(|()| None)
            }
            LifecycleOperationKind::Activate => {
                self.recover_activation(store, operation).map(|()| None)
            }
            LifecycleOperationKind::Relocate => {
                crate::output_relocation::recover(self, store, operation).map(|()| None)
            }
            LifecycleOperationKind::ImportSource => {
                crate::source_import::recover(self, store, operation)
                    .map(|result| Some(crate::source_import::import_message(result.outcome).into()))
            }
            LifecycleOperationKind::GhostshipRecovery => self
                .recover_ghostship_legacy(store, operation)
                .map(|()| None),
        }
    }

    pub(crate) fn check_lifecycle_fault(&self, point: LifecycleFaultPoint) -> Result<()> {
        self.faults.check(point)
    }

    pub(crate) fn lifecycle_faults(&self) -> &dyn LifecycleFaultInjector {
        self.faults.as_ref()
    }

    #[cfg(test)]
    pub(crate) fn recover_lifecycle_operations_for_test(&self) -> Result<()> {
        self.recover_lifecycle_operations()
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
        crate::recovery::recover_restore(self, store, operation)
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
        mut result: Result<T>,
    ) -> Result<T> {
        if result.is_ok()
            && let Err(error) = crate::cancellation::close_preparation(&self.library, &activity.id)
        {
            result = Err(if activity.operation == ActivityOperation::Prepare {
                // A successful preparation result is returned only after its derivative is published.
                error.with_mutation_state(crate::MutationState::Committed)
            } else {
                error
            });
        }
        let (status, message) = match &result {
            Ok(_) => (ActivityStatus::Succeeded, None),
            Err(error) if error.code == crate::ErrorCode::Cancelled => {
                (ActivityStatus::Cancelled, Some(error.message.as_str()))
            }
            Err(error) => (ActivityStatus::Failed, Some(error.message.as_str())),
        };
        let failure = result.as_ref().err().map(PortcoveError::report);
        let recorded =
            self.library
                .finish_activity_report(&activity.id, status, message, failure.as_ref());
        crate::runtime_diagnostics::observe_activity(
            &activity,
            status,
            failure.as_ref(),
            recorded.is_ok(),
        );
        if let Err(error) = recorded {
            if status == ActivityStatus::Cancelled {
                return Err(
                    PortcoveError::state("Cancellation could not be recorded durably")
                        .detail("operation_id", activity.id)
                        .detail("cause", error.message),
                );
            }
            tracing::warn!(
                component = "activity",
                phase = "activity_record",
                activity_id = activity.id.as_str(),
                error_code = crate::runtime_diagnostics::code_label(error.code),
                message = "Activity outcome persistence failed",
            );
        }
        result
    }

    fn catalog_for_installed_fallback(
        &self,
        port_id: &str,
    ) -> Result<std::borrow::Cow<'_, Catalog>> {
        if self.catalog.port(port_id).is_ok() {
            return Ok(std::borrow::Cow::Borrowed(&self.catalog));
        }
        if self.catalog.listing(port_id).is_err()
            && let Some((pending, _)) = self.pending_setup_registration(port_id)?
        {
            return Ok(std::borrow::Cow::Owned(Catalog::for_user_selected_listing(
                pending.listing,
            )?));
        }
        let durable = self.library.status(port_id, ReleaseChannel::Stable)?;
        if durable.active.is_none()
            && durable
                .external_runtime
                .as_ref()
                .is_none_or(|record| record.user_selected.is_some())
            && self.catalog.listing(port_id).is_ok()
        {
            return Ok(std::borrow::Cow::Borrowed(&self.catalog));
        }
        // Catalog lookup must survive a missing external location so the
        // subsequent eligibility assessment can return Held, rather than error.
        let retained = if durable.active.is_none() && durable.external_runtime.is_some() {
            self.library
                .external_runtime_with_port(port_id)?
                .map(|(_, catalog)| catalog)
        } else {
            self.retained_catalog_for_status(&durable)?
        }
        .ok_or_else(|| PortcoveError::not_found(format!("unknown port id: {port_id}")))?;
        Ok(std::borrow::Cow::Owned(retained))
    }

    pub fn status(&self, port_id: &str) -> Result<PortStatus> {
        self.status_without_rollback_assessment(port_id)
            .map(|status| self.with_rollback_assessment(status))
    }

    // Execution retains the original status checks, then verifies its rollback
    // target once under the operation lock instead of discarding that assessment.
    fn status_without_rollback_assessment(&self, port_id: &str) -> Result<PortStatus> {
        let status_catalog = match self.catalog_for_installed_fallback(port_id) {
            Ok(catalog) => catalog,
            Err(error) if error.code == crate::ErrorCode::NotFound => {
                let status = self.library.status(port_id, ReleaseChannel::Stable)?;
                if status.acquisition.is_some() {
                    return Ok(Self::acquisition_metadata_status(status));
                }
                return Err(error);
            }
            Err(error) => return Err(error),
        };
        let catalog = status_catalog.as_ref();
        let port = catalog.port(port_id).ok();
        let (mut statuses, metrics) = self.status_rows_with_recommendations(
            catalog,
            &[(
                port_id.to_owned(),
                port.map_or(ReleaseChannel::Stable, default_channel),
            )],
            false,
        )?;
        let status = statuses
            .pop()
            .ok_or_else(|| PortcoveError::state("status read model returned no row"))?;
        if port.is_none()
            || status
                .external_runtime
                .as_ref()
                .is_some_and(|record| record.user_selected.is_some())
        {
            return Ok(self.with_user_selected_readiness(status));
        }
        let port = port.expect("operational port checked above");
        let retained_catalog = self.retained_catalog_for_status(&status);
        let mut source_profiles = self.launch_source_profiles(port, retained_catalog.as_ref())?;
        for profile in [
            port.source_profile.as_ref(),
            port.bios_source_profile.as_ref(),
        ]
        .into_iter()
        .flatten()
        {
            if !source_profiles.contains(profile) {
                source_profiles.push(profile.clone());
            }
        }
        let source_query_count = usize::from(!source_profiles.is_empty());
        let registered_sources = self
            .library
            .sources_for(&source_profiles)?
            .into_iter()
            .map(|source| (source.profile_id.clone(), source))
            .collect::<HashMap<_, _>>();
        tracing::debug!(
            port_count = 1,
            sqlite_query_count = metrics.sqlite_query_count + source_query_count,
            settings_row_count = metrics.settings_row_count,
            install_row_count = metrics.install_row_count,
            launch_history_row_count = metrics.launch_history_row_count,
            update_snapshot_row_count = metrics.update_snapshot_row_count,
            "loaded status read model"
        );
        let status = self.with_launch_readiness(
            catalog,
            port,
            status,
            &registered_sources,
            &mut HashMap::new(),
            retained_catalog.as_ref(),
        )?;
        let status = self.with_definition_operations(
            catalog,
            port,
            status,
            retained_catalog.as_ref().ok().and_then(Option::as_ref),
        )?;
        self.with_port_actions(port, status, &registered_sources)
    }

    pub fn statuses(&self) -> Result<Vec<PortStatus>> {
        let sources = self.library.sources()?;
        self.statuses_with_sources(&sources)
    }

    fn statuses_with_sources(&self, sources: &[SourceRecord]) -> Result<Vec<PortStatus>> {
        let ports = self
            .catalog
            .ports()
            .iter()
            .map(|port| (port.id.clone(), default_channel(port)))
            .collect::<Vec<_>>();
        let (statuses, metrics) =
            self.status_rows_with_recommendations(&self.catalog, &ports, true)?;
        tracing::debug!(
            port_count = statuses.len(),
            sqlite_query_count = metrics.sqlite_query_count + 1,
            settings_row_count = metrics.settings_row_count,
            install_row_count = metrics.install_row_count,
            launch_history_row_count = metrics.launch_history_row_count,
            update_snapshot_row_count = metrics.update_snapshot_row_count,
            "loaded status read model"
        );
        self.hydrate_statuses(&self.catalog, statuses, sources)
    }

    fn apply_fresh_native_channel_recommendations(
        catalog: &Catalog,
        connection: &rusqlite::Connection,
        statuses: &mut [PortStatus],
    ) -> Result<usize> {
        let recommendations = statuses
            .iter()
            .filter_map(|status| {
                let port = catalog.port(&status.port_id).ok()?;
                if port.adapter != AdapterKind::NativePortable {
                    return None;
                }
                let channel = catalog
                    .listing(&port.id)
                    .ok()?
                    .recommended_download_channel?;
                (port.channels.contains(&channel) && channel != default_channel(port))
                    .then_some((port.id.clone(), channel))
            })
            .collect::<HashMap<_, _>>();
        let ids = recommendations.keys().cloned().collect::<Vec<_>>();
        let (occupied, queries) = Library::port_state_footprints(connection, &ids)?;
        for status in statuses {
            if !occupied.contains(&status.port_id)
                && let Some(channel) = recommendations.get(&status.port_id)
            {
                status.channel = *channel;
            }
        }
        Ok(queries)
    }

    fn status_rows_with_recommendations(
        &self,
        catalog: &Catalog,
        ports: &[(String, ReleaseChannel)],
        include_acquisition_owners: bool,
    ) -> Result<(Vec<PortStatus>, crate::library::StatusReadMetrics)> {
        let mut connection = self.library.connection()?;
        let transaction = connection.transaction()?;
        let (mut statuses, mut metrics) = if include_acquisition_owners {
            self.library
                .statuses_from_with_acquisitions_and_barrier(&transaction, ports, || {})?
        } else {
            self.library
                .statuses_from_with_metrics(&transaction, ports)?
        };
        metrics.sqlite_query_count +=
            Self::apply_fresh_native_channel_recommendations(catalog, &transaction, &mut statuses)?;
        transaction.commit()?;
        Ok((statuses, metrics))
    }

    fn settings_channel(&self, port_id: &str) -> Result<ReleaseChannel> {
        let port = self.catalog.port(port_id)?;
        let (mut statuses, _) = self.status_rows_with_recommendations(
            &self.catalog,
            &[(port_id.into(), default_channel(port))],
            false,
        )?;
        statuses
            .pop()
            .map(|status| status.channel)
            .ok_or_else(|| PortcoveError::state("status read model returned no row"))
    }

    /// An archive is display metadata, never a replacement operational definition.
    fn acquisition_metadata_status(mut status: PortStatus) -> PortStatus {
        status.readiness = None;
        status.definition_operations.clear();
        status.port_actions = [
            PortAction::Install,
            PortAction::Launch,
            PortAction::Update,
            PortAction::RegisterExternal,
            PortAction::RemoveManaged,
            PortAction::Rollback,
        ]
        .into_iter()
        .map(|action| PortActionAssessment {
            action,
            availability: PortActionAvailability::Held,
            reason: PortActionReason::DefinitionIneligible,
            definition: None,
        })
        .collect();
        status
    }

    fn hydrate_statuses(
        &self,
        catalog: &Catalog,
        statuses: Vec<PortStatus>,
        sources: &[SourceRecord],
    ) -> Result<Vec<PortStatus>> {
        let mut checked_sources = HashMap::new();
        let registered_sources = sources
            .iter()
            .cloned()
            .map(|source| (source.profile_id.clone(), source))
            .collect::<HashMap<_, _>>();
        statuses
            .into_iter()
            .map(|status| {
                let port = match catalog.port(&status.port_id) {
                    Ok(port) => port,
                    Err(_) if status.acquisition.is_some() => {
                        return Ok(Self::acquisition_metadata_status(status));
                    }
                    Err(error) => return Err(error),
                };
                if status
                    .external_runtime
                    .as_ref()
                    .is_some_and(|record| record.user_selected.is_some())
                {
                    return Ok(
                        self.with_rollback_assessment(self.with_user_selected_readiness(status))
                    );
                }
                let retained_catalog = self.retained_catalog_for_status(&status);
                let status = self.with_launch_readiness(
                    catalog,
                    port,
                    status,
                    &registered_sources,
                    &mut checked_sources,
                    retained_catalog.as_ref(),
                )?;
                let status = self.with_definition_operations(
                    catalog,
                    port,
                    status,
                    retained_catalog.as_ref().ok().and_then(Option::as_ref),
                )?;
                self.with_port_actions(port, status, &registered_sources)
                    .map(|status| self.with_rollback_assessment(status))
            })
            .collect()
    }

    pub fn workspace_snapshot(&self, activity_limit: usize) -> Result<WorkspaceSnapshot> {
        self.workspace_snapshot_with_barriers(activity_limit, || {}, |_| {})
    }

    #[cfg(test)]
    fn workspace_snapshot_with_read_barrier(
        &self,
        activity_limit: usize,
        after_status_settings: impl FnOnce(),
    ) -> Result<WorkspaceSnapshot> {
        self.workspace_snapshot_with_barriers(activity_limit, after_status_settings, |_| {})
    }

    fn workspace_snapshot_with_barriers(
        &self,
        activity_limit: usize,
        after_status_settings: impl FnOnce(),
        mut before_consistency_check: impl FnMut(usize),
    ) -> Result<WorkspaceSnapshot> {
        let mut after_status_settings = Some(after_status_settings);
        for attempt in 0..2 {
            let mut connection = self.library.connection()?;
            let observed_before_catalog = data_version(&connection)?;
            let (catalog, _) = self.library.load_catalog()?;
            let transaction = connection.transaction()?;
            let _: i64 =
                transaction
                    .query_row("SELECT count(*) FROM sqlite_schema", [], |row| row.get(0))?;
            let observed_at_snapshot = data_version(&transaction)?;
            if observed_at_snapshot != observed_before_catalog {
                transaction.rollback()?;
                continue;
            }
            let catalog = self.catalog_with_registered_listings(catalog, &transaction)?;
            let mut ports = catalog
                .ports()
                .iter()
                .map(|port| (port.id.clone(), default_channel(port)))
                .collect::<Vec<_>>();
            let strict_ids = ports
                .iter()
                .map(|(id, _)| id.clone())
                .collect::<HashSet<_>>();
            ports.extend(
                catalog
                    .listings()
                    .iter()
                    .filter(|listing| !strict_ids.contains(&listing.id))
                    .map(|listing| (listing.id.clone(), ReleaseChannel::Stable)),
            );
            let sources = Library::sources_from(&transaction)?;
            let (mut statuses, mut metrics) = self
                .library
                .statuses_from_with_acquisitions_and_barrier(&transaction, &ports, || {
                    if let Some(after_status_settings) = after_status_settings.take() {
                        after_status_settings();
                    }
                })?;
            metrics.sqlite_query_count += Self::apply_fresh_native_channel_recommendations(
                &catalog,
                &transaction,
                &mut statuses,
            )?;
            let mut activities = Library::activity_feed_from(&transaction, activity_limit)?;
            let pending_setups = Self::pending_setups_from(&transaction)?;
            transaction.commit()?;
            self.library
                .observe_activity_liveness(&mut activities.records);
            tracing::debug!(
                port_count = statuses.len(),
                sqlite_query_count = metrics.sqlite_query_count + 2,
                settings_row_count = metrics.settings_row_count,
                install_row_count = metrics.install_row_count,
                launch_history_row_count = metrics.launch_history_row_count,
                update_snapshot_row_count = metrics.update_snapshot_row_count,
                consistency_attempt = attempt + 1,
                "loaded transactional workspace read model"
            );
            let listing_raw = statuses
                .iter()
                .filter(|status| catalog.listing(&status.port_id).is_ok())
                .cloned()
                .collect();
            let statuses = self.hydrate_statuses(
                &catalog,
                statuses
                    .into_iter()
                    .filter(|status| {
                        strict_ids.contains(&status.port_id) || status.acquisition.is_some()
                    })
                    .collect(),
                &sources,
            )?;
            let listing_statuses = self.listing_statuses_from(&catalog, &statuses, listing_raw)?;
            // Archive-only orphan rows belong to Activity, not accepted browsing membership.
            // Retain the browsing owner's exact current-definition identity invariant.
            let browsing_statuses = statuses
                .iter()
                .filter(|status| strict_ids.contains(&status.port_id))
                .cloned()
                .collect::<Vec<_>>();
            let browsing =
                self.browsing_contexts_for_workspace(&catalog, &browsing_statuses, &sources)?;
            before_consistency_check(attempt);
            if data_version(&connection)? != observed_at_snapshot {
                continue;
            }
            return Ok(WorkspaceSnapshot {
                catalog: catalog.document().clone(),
                statuses,
                listing_catalog: Some(catalog.listing_document().clone()),
                listing_statuses,
                pending_setups,
                sources,
                activities,
                browsing,
            });
        }
        Err(PortcoveError::conflict(
            "the library changed while its workspace snapshot was being assembled; retry the read",
        )
        .detail("workspace_snapshot_stale", "true")
        .detail("retryable", "true"))
    }

    pub async fn plan_install(
        &self,
        port_id: &str,
        channel: Option<ReleaseChannel>,
    ) -> Result<InstallPlan> {
        self.plan_install_at(port_id, channel, None).await
    }

    pub async fn plan_install_at(
        &self,
        port_id: &str,
        channel: Option<ReleaseChannel>,
        output_directory: Option<&Path>,
    ) -> Result<InstallPlan> {
        let port = self.catalog.port(port_id)?;
        let status = self.status(port_id)?;
        self.require_definition_operation(
            &self.catalog,
            port,
            DefinitionOperationContext::observed(DefinitionOperation::Install, false, true),
        )?;
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
        let output_location = self.output_location(port_id, output_directory)?;
        crate::runtime_path_policy::check_output_root(
            port,
            platform,
            &output_location.effective_output_directory,
        )?;
        if port.release.managed_build.contains_key(&platform) {
            return Err(crate::cartridge_build::retired_creation());
        }
        let release = self
            .resolve_release(port, selected_channel, platform)
            .await?
            .release;
        let action = self.install_plan_action(&status, &release)?;
        let bundled_runtime = port.bundled_runtime.get(&platform).cloned();
        let auxiliary_downloads: Vec<crate::ReleaseAsset> = Vec::new();
        let primary_and_runtime_bytes = release.asset.size.saturating_add(
            bundled_runtime
                .as_ref()
                .map_or(0, |runtime| runtime.asset.size),
        );
        let download_bytes = auxiliary_downloads
            .iter()
            .fold(primary_and_runtime_bytes, |total, asset| {
                total.saturating_add(asset.size)
            });
        let temporary_space = if action == InstallPlanAction::Download {
            let required_bytes = primary_and_runtime_bytes;
            let capacity = crate::output_root::assess_destination(
                &self.library,
                port_id,
                &output_location.effective_output_directory,
            );
            Some(crate::InstallSpaceRequirement {
                path: output_location.effective_output_directory.clone(),
                required_bytes,
                available_bytes: capacity.available_bytes,
                volume_identity: capacity.volume_identity,
                sufficient: capacity
                    .available_bytes
                    .map(|available| available >= required_bytes),
            })
        } else {
            None
        };
        let source_requirements = self.install_source_requirements(port)?;
        let shared_preferences = if port.managed_shared_preferences.is_some() {
            let root = self.shared_preferences_install_root(
                port,
                &status,
                &release,
                &output_location.effective_output_directory,
            )?;
            crate::managed_shared_preferences::review(port, &root)?
        } else {
            None
        };
        Ok(InstallPlan {
            port_id: port_id.into(),
            channel: selected_channel,
            platform,
            release,
            action,
            source_requirements,
            bundled_runtime,
            download_bytes,
            auxiliary_downloads,
            temporary_space,
            storage: self.library.storage_summary()?,
            output_location,
            preservation_notices: crate::runtime_data_policy::notices(port),
            shared_preferences,
        })
    }

    fn shared_preferences_install_root(
        &self,
        port: &PortDefinition,
        status: &PortStatus,
        release: &ResolvedRelease,
        output: &Path,
    ) -> Result<PathBuf> {
        crate::managed_shared_preferences::require_artifact(
            port,
            &release.version,
            &crate::ArtifactIdentity {
                asset_name: release.asset.name.clone(),
                sha256: release.asset.sha256.clone(),
                size: release.asset.size,
            },
            Some(Platform::current()?),
        )?;
        for install in [&status.active, &status.staged].into_iter().flatten() {
            if self.install_matches_release(install, release, None)? {
                return Ok(install.path.clone());
            }
        }
        if let Some(install) =
            self.library
                .install_by_artifact(&port.id, &release.asset.sha256, None)?
            && self.install_matches_release(&install, release, None)?
        {
            return Ok(install.path);
        }
        // The closed route has no bundled runtime, composite build or transformed key.
        Ok(output.join(release.asset.sha256.to_ascii_lowercase()))
    }

    pub(crate) fn require_installed_shared_preferences(
        &self,
        install: &InstallRecord,
    ) -> Result<()> {
        let catalog = self.installed_catalog(install)?;
        let port = catalog.port(&install.port_id)?;
        if port.managed_shared_preferences.is_some() {
            let accepted =
                Installer::new(self.library.clone())?.retained_shared_preferences(install)?;
            crate::managed_shared_preferences::require_acceptance(
                port,
                accepted.as_ref(),
                &install.path,
            )?;
        }
        Ok(())
    }

    fn shared_preferences_launch_blocker(
        &self,
        port: &PortDefinition,
        install: &InstallRecord,
    ) -> Option<LaunchBlocker> {
        port.managed_shared_preferences?;
        let accepted = (|| {
            let proof =
                Installer::new(self.library.clone())?.retained_shared_preferences(install)?;
            match proof {
                Some(proof) => proof.matches_current(port, &install.path),
                None => Ok(false),
            }
        })();
        match accepted {
            Ok(true) => None,
            Ok(false) => Some(LaunchBlocker::SharedPreferencesReviewRequired),
            Err(_) => Some(LaunchBlocker::SharedPreferencesUnavailable),
        }
    }

    pub fn output_location(
        &self,
        port_id: &str,
        request_override: Option<&Path>,
    ) -> Result<PortOutputLocation> {
        self.catalog.port(port_id)?;
        let configured_output_directory = self.library.output_directory(port_id)?;
        let default_output_directory = self.library.versions_dir().join(port_id);
        if request_override.is_some_and(|path| !path.is_absolute()) {
            return Err(PortcoveError::usage(
                "port output directory must be an absolute path",
            ));
        }
        let request_override = request_override
            .map(|path| crate::path::normalized_absolute(path, "port output directory"))
            .transpose()?;
        if let Some(path) = request_override.as_deref() {
            crate::path::unicode(path, "port output directory")?;
        }
        let (effective_output_directory, selection_source) = request_override.map_or_else(
            || {
                configured_output_directory.clone().map_or_else(
                    || {
                        (
                            default_output_directory.clone(),
                            OutputLocationSource::LibraryDefault,
                        )
                    },
                    |path| (path, OutputLocationSource::PortSetting),
                )
            },
            |path| (path, OutputLocationSource::RequestOverride),
        );
        Ok(PortOutputLocation {
            port_id: port_id.into(),
            library_root: self.library.root().to_path_buf(),
            default_output_directory,
            configured_output_directory,
            effective_output_directory,
            selection_source,
            user_data_root: self.library.user_dir(port_id),
        })
    }

    pub fn preview_output_directory(
        &self,
        port_id: &str,
        output_directory: Option<&Path>,
    ) -> Result<OutputDestinationPreview> {
        let current = self.output_location(port_id, None)?;
        let proposed = match output_directory {
            Some(path) => self.preview_output_location(port_id, path)?,
            None => PortOutputLocation {
                port_id: current.port_id.clone(),
                library_root: current.library_root.clone(),
                default_output_directory: current.default_output_directory.clone(),
                configured_output_directory: None,
                effective_output_directory: current.default_output_directory.clone(),
                selection_source: OutputLocationSource::LibraryDefault,
                user_data_root: current.user_data_root.clone(),
            },
        };
        let assessment = crate::output_root::assess_destination(
            &self.library,
            port_id,
            &proposed.effective_output_directory,
        );
        let status = self.status(port_id)?;
        let installs = [
            status
                .active
                .as_ref()
                .map(|install| (install, true, false, false)),
            status
                .previous
                .as_ref()
                .map(|install| (install, false, true, false)),
            status
                .staged
                .as_ref()
                .map(|install| (install, false, false, true)),
        ];
        let mut affected_installs = Vec::new();
        for (install, active, previous, staged) in installs.into_iter().flatten() {
            if let Some(existing) = affected_installs
                .iter_mut()
                .find(|existing: &&mut OutputAffectedInstall| existing.install_id == install.id)
            {
                existing.active |= active;
                existing.previous |= previous;
                existing.staged |= staged;
            } else {
                affected_installs.push(OutputAffectedInstall {
                    install_id: install.id.clone(),
                    version: install.version.clone(),
                    path: install.path.clone(),
                    active,
                    previous,
                    staged,
                });
            }
        }
        let mut preview = OutputDestinationPreview {
            port_id: port_id.into(),
            current,
            proposed,
            reset_to_default: output_directory.is_none(),
            availability: assessment.availability,
            ownership: assessment.ownership,
            available_bytes: assessment.available_bytes,
            total_bytes: assessment.total_bytes,
            volume_identity: assessment.volume_identity,
            validation_errors: assessment.validation_errors,
            affected_installs,
            moves_existing_install: false,
            preview_sha256: String::new(),
        };
        preview.preview_sha256 = output_destination_fingerprint(&preview)?;
        Ok(preview)
    }

    pub fn authorize_output_directory_change(
        &self,
        port_id: &str,
        output_directory: Option<&Path>,
        expected_preview_sha256: &str,
    ) -> Result<crate::DestructiveAuthorization> {
        let preview = self.preview_output_directory(port_id, output_directory)?;
        if preview.preview_sha256 != expected_preview_sha256 {
            return Err(PortcoveError::conflict(
                "output destination changed after preview; review it again",
            ));
        }
        require_valid_output_preview(&preview)?;
        self.library.issue_authorization(
            "set_output_directory",
            &output_authorization_target(port_id, output_directory)?,
            &preview.preview_sha256,
        )
    }

    pub fn apply_output_directory_change(
        &self,
        port_id: &str,
        output_directory: Option<&Path>,
        authorization_token: &str,
    ) -> Result<PortOutputLocation> {
        self.catalog.port(port_id)?;
        let _guard = self
            .library
            .try_lock_port(port_id, "set-output-directory")?;
        let target = output_authorization_target(port_id, output_directory)?;
        self.library.consume_authorization_with_state(
            authorization_token,
            "set_output_directory",
            &target,
            || {
                let preview = self.preview_output_directory(port_id, output_directory)?;
                require_valid_output_preview(&preview)?;
                Ok(preview.preview_sha256)
            },
        )?;
        self.library.set_output_directory(
            port_id,
            output_directory,
            self.settings_channel(port_id)?,
        )?;
        self.output_location(port_id, None)
    }

    fn preview_output_location(&self, port_id: &str, path: &Path) -> Result<PortOutputLocation> {
        if path.as_os_str().is_empty() || !path.is_absolute() {
            return Err(PortcoveError::usage(
                "port output directory must be a nonempty absolute path",
            ));
        }
        crate::path::unicode(path, "port output directory")?;
        let effective_output_directory =
            crate::path::normalized_absolute(path, "port output directory")
                .unwrap_or_else(|_| path.to_path_buf());
        Ok(PortOutputLocation {
            port_id: port_id.into(),
            library_root: self.library.root().to_path_buf(),
            default_output_directory: self.library.versions_dir().join(port_id),
            configured_output_directory: Some(effective_output_directory.clone()),
            effective_output_directory,
            selection_source: OutputLocationSource::PortSetting,
            user_data_root: self.library.user_dir(port_id),
        })
    }

    #[cfg(test)]
    pub(crate) fn set_output_directory(
        &self,
        port_id: &str,
        output_directory: &Path,
    ) -> Result<PortOutputLocation> {
        self.catalog.port(port_id)?;
        self.library.set_output_directory(
            port_id,
            Some(output_directory),
            self.settings_channel(port_id)?,
        )?;
        self.output_location(port_id, None)
    }

    #[cfg(test)]
    pub(crate) fn reset_output_directory(&self, port_id: &str) -> Result<PortOutputLocation> {
        self.catalog.port(port_id)?;
        self.library
            .set_output_directory(port_id, None, self.settings_channel(port_id)?)?;
        self.output_location(port_id, None)
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
            output_location: self.output_location(port_id, None)?,
        })
    }

    fn install_matches_release(
        &self,
        install: &InstallRecord,
        release: &ResolvedRelease,
        runtime: Option<&crate::RuntimeIdentity>,
    ) -> Result<bool> {
        if !artifact_matches_release(install, release, runtime) {
            return Ok(false);
        }
        let current = &self.catalog.port(&install.port_id)?.release.managed_build;
        // A legacy install without a retained contract cannot establish a
        // locally built recipe. Never infer its origin from today's catalog.
        let retained = Installer::new(self.library.clone())?.retained_catalog(install)?;
        Ok(match retained {
            Some(catalog) => catalog.port(&install.port_id)?.release.managed_build == *current,
            None => current.is_empty(),
        })
    }

    fn install_plan_action(
        &self,
        status: &PortStatus,
        release: &ResolvedRelease,
    ) -> Result<InstallPlanAction> {
        let runtime =
            crate::runtime::required(self.catalog.port(&status.port_id)?, Platform::current()?);
        if status
            .active
            .as_ref()
            .map(|install| self.install_matches_release(install, release, runtime.as_ref()))
            .transpose()?
            .unwrap_or(false)
        {
            return Ok(InstallPlanAction::AlreadyActive);
        }
        if let Some(staged) = status.staged.as_ref()
            && self.install_matches_release(staged, release, runtime.as_ref())?
        {
            return Ok(if staged.verified {
                InstallPlanAction::UseStaged
            } else {
                InstallPlanAction::BlockedUnverified
            });
        }
        let Some(retained) = self.library.install_by_artifact(
            &status.port_id,
            &release.asset.sha256,
            runtime.as_ref(),
        )?
        else {
            return Ok(InstallPlanAction::Download);
        };
        if !self.install_matches_release(&retained, release, runtime.as_ref())? {
            return Ok(InstallPlanAction::Download);
        }
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
        current_catalog: &Catalog,
        port: &PortDefinition,
        mut status: PortStatus,
        registered_sources: &HashMap<String, SourceRecord>,
        checked_sources: &mut HashMap<String, SourceHealth>,
        retained_catalog: std::result::Result<&Option<Catalog>, &PortcoveError>,
    ) -> Result<PortStatus> {
        let mut blockers = Vec::new();
        let retained_catalog = match retained_catalog {
            Ok(catalog) => catalog,
            Err(_) => {
                status.readiness = Some(LaunchReadiness {
                    setup_contract: None,
                    launchable: false,
                    blockers: vec![LaunchBlocker::InvalidInstallation],
                    pending_setup: false,
                    preparation_mode: None,
                    required_source_extension: None,
                    source: None,
                    bios: None,
                    source_assessment: None,
                    bios_assessment: None,
                });
                return Ok(status);
            }
        };
        let catalog = retained_catalog.as_ref().unwrap_or(current_catalog);
        let port = catalog.port(&port.id)?;
        let installed = status.active.is_some() || status.external_runtime.is_some();
        if let Some(active) = &status.active
            && let Some(blocker) = self.shared_preferences_launch_blocker(port, active)
        {
            blockers.push(blocker);
        }
        let source = port
            .source_profile
            .as_deref()
            .map(|profile_id| {
                Self::source_health(
                    catalog,
                    profile_id,
                    installed,
                    registered_sources,
                    checked_sources,
                )
            })
            .transpose()?;
        let bios = port
            .bios_source_profile
            .as_deref()
            .map(|profile_id| {
                Self::source_health(
                    catalog,
                    profile_id,
                    installed,
                    registered_sources,
                    checked_sources,
                )
            })
            .transpose()?;
        add_source_blocker(&mut blockers, source, false);
        add_source_blocker(&mut blockers, bios, true);
        let required_source_extension = if port.release.provider == ReleaseSource::UserPrepared {
            Platform::current().ok().and_then(|platform| {
                port.release
                    .user_prepared
                    .get(&platform)
                    .and_then(|runtime| runtime.source_argument_extension.clone())
            })
        } else {
            None
        };
        let requires_source_directory = port.release.provider == ReleaseSource::UserPrepared
            && Platform::current().ok().is_some_and(|platform| {
                port.release
                    .user_prepared
                    .get(&platform)
                    .is_some_and(|runtime| runtime.source_directory_environment)
            });
        if matches!(
            source,
            Some(SourceHealth::Current | SourceHealth::NotChecked)
        ) && requires_source_directory
            && port
                .source_profile
                .as_ref()
                .and_then(|profile| registered_sources.get(profile))
                .is_some_and(|record| require_prepared_source_directory(&record.path).is_err())
        {
            blockers.push(LaunchBlocker::IncompatibleSource);
        }
        if matches!(
            source,
            Some(SourceHealth::Current | SourceHealth::NotChecked)
        ) && required_source_extension
            .as_deref()
            .is_some_and(|extension| {
                port.source_profile
                    .as_ref()
                    .and_then(|profile| registered_sources.get(profile))
                    .is_some_and(|record| !source_path_has_extension(&record.path, extension))
            })
        {
            blockers.push(LaunchBlocker::IncompatibleSource);
        }
        if status.active.as_ref().is_some_and(|active| {
            Platform::current().is_ok_and(|platform| !crate::runtime::ready(port, platform, active))
        }) {
            blockers.push(LaunchBlocker::MissingRuntime);
        }
        if let Some(record) = status.external_runtime.as_ref() {
            if Self::check_external_runtime_paths(
                port,
                record.platform,
                &record.path,
                &record.executable,
            )
            .is_err()
            {
                blockers.push(LaunchBlocker::MissingRuntime);
            }
            if (required_source_extension.is_some() || requires_source_directory)
                && port
                    .source_profile
                    .as_ref()
                    .and_then(|profile| registered_sources.get(profile))
                    .is_some_and(|source| {
                        crate::runtime_path_policy::check_prepared_path(
                            port,
                            record.platform,
                            &source.path,
                        )
                        .is_err()
                    })
                && !blockers.contains(&LaunchBlocker::IncompatibleSource)
            {
                blockers.push(LaunchBlocker::IncompatibleSource);
            }
        }
        let pending_setup = status.active.as_ref().is_some_and(|active| {
            if crate::preparation::managed_install(port, active) {
                let source = port
                    .source_profile
                    .as_ref()
                    .and_then(|profile| registered_sources.get(profile));
                return self
                    .validate_preparation_receipt(port, active, source)
                    .is_err();
            }
            if crate::preparation::has_manual_marker(port) {
                return crate::preparation::require_manual_setup(port, active).is_err();
            }
            port.setup_marker
                .as_ref()
                .is_some_and(|marker| !active.path.join(marker).is_file())
        });
        if pending_setup
            && status.active.as_ref().is_some_and(|active| {
                crate::preparation::managed_install(port, active)
                    || crate::preparation::has_manual_marker(port)
            })
        {
            blockers.push(LaunchBlocker::PreparationRequired);
        }
        if let Some(record) = status.external_runtime.as_ref()
            && let Some(spec) = port.release.user_prepared.get(&record.platform)
            && !crate::external_runtime::shared_preferences::original_ready(record, spec)
                .unwrap_or(false)
        {
            // Manual external setup is not corruption of the registered runtime
            // or a request for Core to seed files in an unowned shared directory.
            blockers.push(LaunchBlocker::PreparationRequired);
        }
        if status.active.as_ref().is_some_and(|active| {
            self.inspect_ghostship_install_data_compatibility(active, None)
                .is_err()
        }) {
            blockers.push(LaunchBlocker::InvalidInstallation);
        }
        let release = status
            .active
            .as_ref()
            .map(|install| (install.version.as_str(), install.artifact.sha256.as_str()))
            .or_else(|| {
                status
                    .external_runtime
                    .as_ref()
                    .map(|runtime| (runtime.version.as_str(), runtime.archive_sha256.as_str()))
            });
        let source_assessment = port
            .source_profile
            .as_deref()
            .zip(source)
            .map(|(id, health)| {
                crate::source_inspection::registered_launch_assessment(
                    catalog,
                    id,
                    health,
                    registered_sources.get(id),
                    &port.id,
                    crate::PortSourceRole::Game,
                    release,
                )
            });
        let bios_assessment = port
            .bios_source_profile
            .as_deref()
            .zip(bios)
            .map(|(id, health)| {
                crate::source_inspection::registered_launch_assessment(
                    catalog,
                    id,
                    health,
                    registered_sources.get(id),
                    &port.id,
                    crate::PortSourceRole::Bios,
                    release,
                )
            });
        for (assessment, blocker) in [
            (&source_assessment, LaunchBlocker::IncompatibleSource),
            (&bios_assessment, LaunchBlocker::IncompatibleBios),
        ] {
            if assessment
                .as_ref()
                .is_some_and(crate::SourceAssessment::known_input_failure)
                && !blockers.contains(&blocker)
            {
                blockers.push(blocker);
            }
        }
        status.readiness = Some(LaunchReadiness {
            setup_contract: retained_catalog
                .as_ref()
                .map(|_| -> Result<crate::SetupExplanation> {
                    Ok(crate::SetupExplanation {
                        definition_sha256: crate::catalog::observation_definition_sha256(port)?,
                        retained: true,
                        platforms: port.platforms.clone(),
                        installation_method: port
                            .presentation
                            .as_ref()
                            .map(|presentation| presentation.installation_method),
                        source_requirements: port
                            .presentation
                            .as_ref()
                            .map(|presentation| presentation.source_requirements.clone())
                            .unwrap_or_default(),
                        saves_and_settings: port
                            .presentation
                            .as_ref()
                            .map(|presentation| presentation.saves_and_settings),
                        persistent_paths: port.persistent_paths.clone(),
                        persistent_file_patterns: port.persistent_file_patterns.clone(),
                        manual_preparation: port
                            .presentation
                            .as_ref()
                            .and_then(|presentation| presentation.manual_preparation.clone()),
                        manual_setup: port
                            .presentation
                            .as_ref()
                            .and_then(|presentation| presentation.manual_setup.clone()),
                    })
                })
                .transpose()?,
            launchable: installed && blockers.is_empty(),
            blockers,
            pending_setup,
            preparation_mode: status
                .active
                .as_ref()
                .and_then(|active| crate::preparation::managed_mode(port, active)),
            required_source_extension,
            source,
            bios,
            source_assessment,
            bios_assessment,
        });
        Ok(status)
    }

    fn retained_catalog_for_status(&self, status: &PortStatus) -> Result<Option<Catalog>> {
        if let Some(active) = status.active.as_ref() {
            return self.installed_catalog(active).map(Some);
        }
        if let Some(published) = status.external_runtime.as_ref() {
            let (record, catalog) = self
                .library
                .external_runtime_with_port(&status.port_id)?
                .ok_or_else(|| PortcoveError::state("external registration disappeared"))?;
            if record.id != published.id {
                return Err(PortcoveError::conflict(
                    "external registration changed during status read",
                ));
            }
            if published.user_selected.is_some() {
                self.check_user_selected_retained_runtime(published, &catalog)?;
                return Ok(Some(catalog));
            }
            let spec = catalog
                .port(&status.port_id)?
                .release
                .user_prepared
                .get(&published.platform)
                .ok_or_else(|| {
                    PortcoveError::state("external runtime platform contract is missing")
                })?;
            if spec.trust == crate::ExternalRuntimeTrust::UserSelected {
                self.check_user_selected_runtime_record(published, spec)?;
            } else {
                crate::external_runtime::check_registered_location(
                    published,
                    spec,
                    self.library.root(),
                )?;
            }
            return Ok(Some(catalog));
        }
        Ok(None)
    }

    fn launch_source_profiles(
        &self,
        current_port: &PortDefinition,
        retained_catalog: std::result::Result<&Option<Catalog>, &PortcoveError>,
    ) -> Result<Vec<String>> {
        let Ok(retained_catalog) = retained_catalog else {
            return Ok(Vec::new());
        };
        let catalog = retained_catalog.as_ref().unwrap_or(&self.catalog);
        if catalog.is_user_selected_listing(&current_port.id) {
            return Ok(Vec::new());
        }
        let port = catalog.port(&current_port.id)?;
        Ok([
            port.source_profile.as_ref(),
            port.bios_source_profile.as_ref(),
        ]
        .into_iter()
        .flatten()
        .cloned()
        .collect())
    }

    fn with_definition_operations(
        &self,
        current_catalog: &Catalog,
        current_port: &PortDefinition,
        mut status: PortStatus,
        retained_catalog: Option<&Catalog>,
    ) -> Result<PortStatus> {
        status.definition_operations.clear();
        if current_catalog
            .definition_selection(&current_port.id)
            .is_none()
            && !status
                .external_runtime
                .as_ref()
                .is_some_and(|record| record.retained_definition.is_some())
            && retained_catalog
                .and_then(|catalog| catalog.definition_selection(&current_port.id))
                .is_none()
        {
            return Ok(status);
        }
        self.library
            .with_definition_operation_assessment(|assessment| {
                self.assess_status_definition_operations(
                    current_catalog,
                    current_port,
                    status,
                    retained_catalog,
                    assessment,
                )
            })
    }

    fn assess_status_definition_operations(
        &self,
        current_catalog: &Catalog,
        current_port: &PortDefinition,
        mut status: PortStatus,
        retained_catalog: Option<&Catalog>,
        assessment: &crate::definition_candidate::selection::DefinitionOperationAssessment<'_>,
    ) -> Result<PortStatus> {
        let admission_operation = if current_port.release.provider == ReleaseSource::UserPrepared {
            DefinitionOperation::RegisterExternal
        } else {
            DefinitionOperation::Install
        };
        if let Some(identity) = current_catalog.definition_selection(&current_port.id) {
            let mut eligibility = assessment.assess(
                identity,
                DefinitionOperationContext::observed(admission_operation, false, true),
            )?;
            if eligibility.outcome == DefinitionEligibilityOutcome::Eligible
                && admission_operation == DefinitionOperation::Install
                && let Some(record) = current_port.release.curated.get(&Platform::current()?)
            {
                let connection = self.library.connection()?;
                let repository_id = crate::curated_acquisition::repository_for_retained_record(
                    &connection,
                    record,
                )?;
                eligibility = crate::definition_repository::publisher_policy::assess_curated_artifact_operation(
                    &connection, repository_id, record,
                    crate::definition_repository::publisher_policy::CuratedArtifactOperation::Acquisition,
                )?;
            }
            status
                .definition_operations
                .push(DefinitionOperationAssessment {
                    operation: admission_operation,
                    eligibility,
                    retained: false,
                });
        }

        let Some(active) = status.active.as_ref() else {
            if let Some(external) = status.external_runtime.as_ref()
                && let Some(identity) = external.retained_definition.as_ref()
            {
                let launch = assessment.assess(
                    identity,
                    DefinitionOperationContext::observed(DefinitionOperation::Launch, true, true),
                )?;
                if launch.outcome != DefinitionEligibilityOutcome::Eligible
                    && let Some(readiness) = status.readiness.as_mut()
                {
                    readiness.launchable = false;
                }
                status
                    .definition_operations
                    .push(DefinitionOperationAssessment {
                        operation: DefinitionOperation::Launch,
                        eligibility: launch,
                        retained: true,
                    });
            }
            return Ok(status);
        };
        if status.readiness.as_ref().is_some_and(|readiness| {
            readiness
                .blockers
                .contains(&LaunchBlocker::InvalidInstallation)
        }) {
            return Ok(status);
        }
        // This exact immutable interpretation was already read and checked for
        // launch readiness in the same status calculation. Execution retains
        // its independent manifest, policy and filesystem checks.
        let installed_catalog = retained_catalog.ok_or_else(|| {
            PortcoveError::state("installed status has no retained catalog interpretation")
        })?;
        let Some(identity) = installed_catalog.definition_selection(&active.port_id) else {
            return Ok(status);
        };
        let installed_port = installed_catalog.port(&active.port_id)?;
        if crate::preparation::managed_install(installed_port, active) {
            status
                .definition_operations
                .push(DefinitionOperationAssessment {
                    operation: DefinitionOperation::Prepare,
                    eligibility: self.with_curated_local_assessment(
                        assessment.assess(
                            identity,
                            DefinitionOperationContext::observed(
                                DefinitionOperation::Prepare,
                                true,
                                active.verified,
                            ),
                        )?,
                        active,
                    )?,
                    retained: true,
                });
        }
        let launch = self.with_curated_local_assessment(
            assessment.assess(
                identity,
                self.managed_launch_context(Some(identity), active)?,
            )?,
            active,
        )?;
        if launch.outcome != DefinitionEligibilityOutcome::Eligible
            && let Some(readiness) = status.readiness.as_mut()
        {
            readiness.launchable = false;
        }
        status
            .definition_operations
            .push(DefinitionOperationAssessment {
                operation: DefinitionOperation::Launch,
                eligibility: launch,
                retained: true,
            });
        Ok(status)
    }

    fn with_curated_local_assessment(
        &self,
        eligibility: crate::DefinitionEligibility,
        install: &InstallRecord,
    ) -> Result<crate::DefinitionEligibility> {
        if eligibility.outcome != DefinitionEligibilityOutcome::Eligible {
            return Ok(eligibility);
        }
        Installer::new(self.library.clone())?.assess_curated_operation(
            install,
            crate::definition_repository::publisher_policy::CuratedArtifactOperation::LocalUse,
        )
    }

    fn with_port_actions(
        &self,
        current_port: &PortDefinition,
        mut status: PortStatus,
        registered_sources: &HashMap<String, SourceRecord>,
    ) -> Result<PortStatus> {
        use PortAction as Action;
        use PortActionAvailability as Availability;
        use PortActionReason as Reason;

        let assessed = |action, availability, reason, definition| PortActionAssessment {
            action,
            availability,
            reason,
            definition,
        };
        let definition = |operation| {
            status
                .definition_operations
                .iter()
                .find(|item| item.operation == operation)
                .map(|item| item.eligibility)
                .filter(|eligibility| eligibility.outcome != DefinitionEligibilityOutcome::Eligible)
        };
        let source_blocker = status.readiness.as_ref().and_then(|readiness| {
            readiness
                .blockers
                .iter()
                .find(|blocker| **blocker == LaunchBlocker::InvalidInstallation)
                .or_else(|| readiness.blockers.first())
                .copied()
        });
        let source_reason = source_blocker.map(port_action_blocker);
        let platform = Platform::current()?;
        // Install evaluates the current definition. Launch readiness may have
        // inspected a different, retained installed contract.
        let current_missing = [
            (current_port.source_profile.as_ref(), Reason::MissingSource),
            (
                current_port.bios_source_profile.as_ref(),
                Reason::MissingBios,
            ),
        ]
        .into_iter()
        .find_map(|(profile, reason)| {
            profile
                .filter(|id| !registered_sources.contains_key(*id))
                .map(|_| reason)
        });
        let install = if let Some(reason) = crate::definition_eligibility::admission_route_exclusion(
            current_port,
            &status,
            platform,
            Action::Install,
        ) {
            assessed(Action::Install, Availability::NotOffered, reason, None)
        } else if let Some(ineligible) = definition(DefinitionOperation::Install) {
            assessed(
                Action::Install,
                Availability::Held,
                Reason::DefinitionIneligible,
                Some(ineligible),
            )
        } else if let Some(reason) = current_missing {
            assessed(Action::Install, Availability::Waiting, reason, None)
        } else {
            assessed(
                Action::Install,
                Availability::Allowed,
                Reason::Available,
                None,
            )
        };

        let register_external = if let Some(reason) =
            crate::definition_eligibility::admission_route_exclusion(
                current_port,
                &status,
                platform,
                Action::RegisterExternal,
            ) {
            assessed(
                Action::RegisterExternal,
                Availability::NotOffered,
                reason,
                None,
            )
        } else if let Some(ineligible) = definition(DefinitionOperation::RegisterExternal) {
            assessed(
                Action::RegisterExternal,
                Availability::Held,
                Reason::DefinitionIneligible,
                Some(ineligible),
            )
        } else {
            assessed(
                Action::RegisterExternal,
                Availability::Waiting,
                Reason::ReviewRequired,
                None,
            )
        };

        let launch = if status.active.is_none() && status.external_runtime.is_none() {
            assessed(
                Action::Launch,
                Availability::Waiting,
                Reason::NotInstalled,
                None,
            )
        } else if let Some(ineligible) = definition(DefinitionOperation::Launch) {
            assessed(
                Action::Launch,
                Availability::Held,
                Reason::DefinitionIneligible,
                Some(ineligible),
            )
        } else if status.active.as_ref().is_some_and(|active| {
            self.inspect_ghostship_install_data_compatibility(active, None)
                .is_err()
        }) {
            assessed(Action::Launch, Availability::Held, Reason::UnsafeData, None)
        } else if status
            .readiness
            .as_ref()
            .is_some_and(|readiness| readiness.launchable)
        {
            assessed(
                Action::Launch,
                Availability::Allowed,
                Reason::Available,
                None,
            )
        } else if let Some((availability, reason)) = source_reason {
            assessed(Action::Launch, availability, reason, None)
        } else {
            assessed(
                Action::Launch,
                Availability::Held,
                Reason::InvalidInstallation,
                None,
            )
        };

        let removal =
            if status.active.is_some() || status.previous.is_some() || status.staged.is_some() {
                assessed(
                    Action::RemoveManaged,
                    Availability::Waiting,
                    Reason::ReviewRequired,
                    None,
                )
            } else {
                assessed(
                    Action::RemoveManaged,
                    Availability::NotOffered,
                    Reason::NotInstalled,
                    None,
                )
            };

        let remove_external = if status.external_runtime.is_some() {
            assessed(
                Action::RemoveExternal,
                Availability::Waiting,
                Reason::ReviewRequired,
                None,
            )
        } else {
            assessed(
                Action::RemoveExternal,
                Availability::NotOffered,
                Reason::NotInstalled,
                None,
            )
        };

        // Candidate resolution remains explicit: a status snapshot never checks
        // upstream or infers update eligibility from a cached observation.
        let user_prepared = current_port.release.provider == ReleaseSource::UserPrepared;
        let on_platform = current_port.platforms.contains(&platform);
        let update = if status.external_runtime.is_some() || user_prepared {
            assessed(
                Action::Update,
                Availability::NotOffered,
                Reason::RouteNotOffered,
                None,
            )
        } else if status.active.is_none() {
            assessed(
                Action::Update,
                Availability::NotOffered,
                Reason::NotInstalled,
                None,
            )
        } else if !on_platform {
            assessed(
                Action::Update,
                Availability::NotOffered,
                Reason::UnsupportedPlatform,
                None,
            )
        } else if let Some(ineligible) = definition(DefinitionOperation::Install) {
            assessed(
                Action::Update,
                Availability::Held,
                Reason::DefinitionIneligible,
                Some(ineligible),
            )
        } else {
            assessed(
                Action::Update,
                Availability::Waiting,
                Reason::ReviewRequired,
                None,
            )
        };
        status.port_actions = vec![
            install,
            register_external,
            launch,
            removal,
            remove_external,
            update,
        ];
        let pending: bool = self.library.connection()?.query_row(
            "SELECT EXISTS(SELECT 1 FROM catalog_downloads WHERE port_id=?1)",
            [&status.port_id],
            |row| row.get(0),
        )?;
        if pending {
            for assessment in &mut status.port_actions {
                if matches!(
                    assessment.action,
                    Action::Install | Action::RegisterExternal | Action::Update
                ) {
                    assessment.availability = Availability::NotOffered;
                    assessment.reason = Reason::RouteNotOffered;
                    assessment.definition = None;
                }
            }
        }
        Ok(status)
    }

    fn with_rollback_assessment(&self, mut status: PortStatus) -> PortStatus {
        let (availability, reason, definition) = match status.previous.as_ref() {
            None => (
                PortActionAvailability::NotOffered,
                PortActionReason::NotInstalled,
                None,
            ),
            Some(previous) => {
                match self.rollback_target(&status.port_id, previous, status.active.as_ref(), false)
                {
                    Ok(_) => (
                        PortActionAvailability::Allowed,
                        PortActionReason::Available,
                        None,
                    ),
                    Err(failure) if failure.reason == PortActionReason::RouteNotOffered => (
                        PortActionAvailability::NotOffered,
                        failure.reason,
                        failure.definition,
                    ),
                    Err(failure) => (
                        PortActionAvailability::Held,
                        failure.reason,
                        failure.definition,
                    ),
                }
            }
        };
        status.port_actions.push(PortActionAssessment {
            action: PortAction::Rollback,
            availability,
            reason,
            definition,
        });
        status
    }

    async fn resolve_release(
        &self,
        port: &PortDefinition,
        channel: ReleaseChannel,
        platform: Platform,
    ) -> Result<crate::ScopedResolvedRelease> {
        let scope = crate::definition_repository::publisher_policy::acquisition_scope(
            &self.library,
            &self.catalog,
            &port.id,
        )?;
        crate::curated_acquisition::require_runtime_scope(port, scope.as_ref())?;
        self.releases
            .resolve_scoped(port, channel, platform, scope.as_ref())
            .await
    }

    pub(crate) fn require_definition_adoption(
        &self,
        catalog: &Catalog,
        port: &PortDefinition,
    ) -> Result<()> {
        crate::runtime_data_policy::refuse_adoption(port)?;
        crate::managed_tfe::refuse_adoption(port)?;
        crate::managed_shared_preferences::refuse_scope_transfer(port)?;
        crate::definition_acquisition::refuse_restricted_adoption(catalog, &port.id)?;
        self.require_definition_operation(
            catalog,
            port,
            DefinitionOperationContext::observed(DefinitionOperation::Install, false, true),
        )
    }

    pub(crate) fn require_definition_operation(
        &self,
        catalog: &Catalog,
        port: &PortDefinition,
        context: DefinitionOperationContext,
    ) -> Result<()> {
        if catalog.definition_selection(&port.id).is_none() {
            // A catalog fallback cannot erase a live restriction on this identity.
            crate::definition_repository::publisher_policy::acquisition_scope(
                &self.library,
                catalog,
                &port.id,
            )?;
        }
        self.require_definition_identity(catalog.definition_selection(&port.id), context)
    }

    fn require_definition_identity(
        &self,
        identity: Option<&crate::DefinitionSelectionIdentity>,
        context: DefinitionOperationContext,
    ) -> Result<()> {
        let Some(identity) = identity else {
            return Ok(());
        };
        let eligibility = self
            .library
            .assess_definition_operation(identity, context)?;
        if eligibility.outcome == DefinitionEligibilityOutcome::Eligible {
            return Ok(());
        }
        let operation = enum_value(context.operation)?;
        let outcome = enum_value(eligibility.outcome)?;
        let reason = enum_value(eligibility.reason)?;
        let error = match eligibility.outcome {
            DefinitionEligibilityOutcome::Eligible => unreachable!(),
            DefinitionEligibilityOutcome::Hold => {
                PortcoveError::conflict("definition operation is on hold")
            }
            DefinitionEligibilityOutcome::Escalate => PortcoveError::unsupported(
                "definition operation requires an engine or authority change",
            ),
        };
        Err(error
            .detail("definition_operation", operation)
            .detail("definition_eligibility", outcome)
            .detail("definition_reason", reason))
    }

    fn source_health(
        catalog: &Catalog,
        profile_id: &str,
        installed: bool,
        registered_sources: &HashMap<String, SourceRecord>,
        checked_sources: &mut HashMap<String, SourceHealth>,
    ) -> Result<SourceHealth> {
        let Some(source) = registered_sources.get(profile_id) else {
            return Ok(SourceHealth::Unregistered);
        };
        if !installed {
            return Ok(SourceHealth::NotChecked);
        }
        let profile = catalog.source_profile(profile_id)?;
        // A status batch can contain installations retaining different contracts
        // for one profile ID. Reuse only the same interpretation of this snapshot.
        let contract = crate::signed_catalog::digest(&serde_json::to_vec(profile)?);
        if let Some(health) = checked_sources.get(&contract) {
            return Ok(*health);
        }
        let health = match std::fs::metadata(&source.path) {
            Ok(metadata) if metadata.is_file() && std::fs::File::open(&source.path).is_err() => {
                SourceHealth::Unreadable
            }
            Ok(metadata) if metadata.is_file() && metadata.len() != source.storage_size => {
                SourceHealth::Changed
            }
            Ok(metadata) if metadata.is_dir() && std::fs::read_dir(&source.path).is_err() => {
                SourceHealth::Unreadable
            }
            Ok(_) => SourceHealth::NotChecked,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => SourceHealth::Missing,
            Err(_) => SourceHealth::Unreadable,
        };
        checked_sources.insert(contract, health);
        Ok(health)
    }

    pub async fn check_update(&self, port_id: &str) -> Result<UpdateCheck> {
        self.check_update_with_status(port_id, None).await
    }

    async fn check_update_with_status(
        &self,
        port_id: &str,
        status: Option<PortStatus>,
    ) -> Result<UpdateCheck> {
        let (activity, operation) = self.begin_cancellable_activity(
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
            self.require_managed_runtime_ownership(&status)?;
            let release = operation
                .interruptible(self.resolve_release(port, status.channel, Platform::current()?))
                .await?;
            self.record_update_check(port_id, &status, &release.release)
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
        let runtime = crate::runtime::required(self.catalog.port(port_id)?, Platform::current()?);
        let installed_runtime = status
            .active
            .as_ref()
            .and_then(|install| install.runtime.clone());
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
            .map(|install| self.install_matches_release(install, release, runtime.as_ref()))
            .transpose()?
            .is_none_or(|matches| !matches);
        let check = UpdateCheck {
            port_id: port_id.into(),
            channel: status.channel,
            installed_version,
            installed_artifact,
            installed_runtime,
            required_runtime: runtime,
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
        self.library
            .set_update_policy(port_id, policy, self.settings_channel(port_id)?)?;
        self.status(port_id)
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
        self.install_at(
            port_id,
            channel,
            InstallOverrides {
                source: source_override,
                bios: bios_override,
                output_directory: None,
            },
            activate,
            emit,
        )
        .await
    }

    pub async fn install_at<F>(
        &self,
        port_id: &str,
        channel: Option<ReleaseChannel>,
        overrides: InstallOverrides<'_>,
        activate: bool,
        mut emit: F,
    ) -> Result<InstallRecord>
    where
        F: FnMut(OperationEvent),
    {
        let (activity, operation) = self.begin_cancellable_activity(
            ActivityOperation::Install,
            ActivityTargetKind::Port,
            Some(port_id),
        )?;
        emit(operation.started());
        let result = async {
            let port = self.catalog.port(port_id)?;
            self.output_location(port_id, overrides.output_directory)?;
            let _operation = self.library.try_lock_port(port_id, "install")?;
            let status = self.status(port_id)?;
            self.require_managed_runtime_ownership(&status)?;
            self.require_definition_operation(
                &self.catalog,
                port,
                DefinitionOperationContext::observed(DefinitionOperation::Install, false, true),
            )?;
            let selected_channel = channel.unwrap_or(status.channel);
            if !port.channels.contains(&selected_channel) {
                return Err(PortcoveError::unsupported(format!(
                    "{} does not offer {selected_channel}",
                    port.name
                )));
            }
            self.library.ensure_settings(port_id, selected_channel)?;
            let platform = Platform::current()?;
            let release = operation
                .interruptible(self.resolve_release(port, selected_channel, platform))
                .await?;
            operation.observe_release(&release.release.version, None);
            let mut reporter = OperationReporter {
                operation: &operation,
                emit: &mut emit,
            };
            self.apply_scoped_release(port, status, overrides, release, activate, &mut reporter)
                .await
        }
        .await;
        let result = self.finish_activity(activity, result);
        emit(operation.finished(OperationResult::from_result(&result)));
        result
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
        self.ensure_at(port_id, channel, source_override, bios_override, None, emit)
            .await
    }

    pub async fn ensure_at<F>(
        &self,
        port_id: &str,
        channel: Option<ReleaseChannel>,
        source_override: Option<&Path>,
        bios_override: Option<&Path>,
        output_directory: Option<&Path>,
        emit: F,
    ) -> Result<InstallRecord>
    where
        F: FnMut(OperationEvent),
    {
        self.output_location(port_id, output_directory)?;
        let port = self.catalog.port(port_id)?;
        self.require_definition_operation(
            &self.catalog,
            port,
            DefinitionOperationContext::observed(DefinitionOperation::Install, false, true),
        )?;
        if let Some(active) = self.status(port_id)?.active
            && crate::runtime::ready(port, Platform::current()?, &active)
        {
            self.managed_install_root(port_id, &active.path)?;
            self.require_installed_shared_preferences(&active)?;
            return Ok(active);
        }
        self.install_at(
            port_id,
            channel,
            InstallOverrides {
                source: source_override,
                bios: bios_override,
                output_directory,
            },
            true,
            emit,
        )
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
        let (activity, operation) = self.begin_cancellable_activity(
            ActivityOperation::Update,
            ActivityTargetKind::Port,
            Some(port_id),
        )?;
        emit(operation.started());
        let result = async {
            let _operation = self.library.try_lock_port(port_id, "update")?;
            let status = self.status(port_id)?;
            self.require_managed_runtime_ownership(&status)?;
            let port = self.catalog.port(port_id)?;
            self.require_definition_operation(
                &self.catalog,
                port,
                DefinitionOperationContext::observed(DefinitionOperation::Install, false, true),
            )?;
            let release = operation
                .interruptible(self.resolve_release(port, status.channel, Platform::current()?))
                .await?;
            operation.observe_release(&release.release.version, None);
            self.record_update_check(port_id, &status, &release.release)?;
            let mut reporter = OperationReporter {
                operation: &operation,
                emit: &mut emit,
            };
            self.apply_scoped_release(
                port,
                status,
                InstallOverrides {
                    source: source_override,
                    bios: bios_override,
                    output_directory: None,
                },
                release,
                activate,
                &mut reporter,
            )
            .await
        }
        .await;
        let result = self.finish_activity(activity, result);
        emit(operation.finished(OperationResult::from_result(&result)));
        result
    }

    // Reviewed client plans retain their existing serialized release contract.
    // A managed grant requires fresh opaque provider evidence for those exact bytes.
    async fn apply_resolved_release<F>(
        &self,
        port: &PortDefinition,
        status: PortStatus,
        overrides: InstallOverrides<'_>,
        release: ResolvedRelease,
        intent: ReleaseIntent,
        reporter: &mut OperationReporter<'_, F>,
    ) -> Result<InstallRecord>
    where
        F: FnMut(OperationEvent),
    {
        let scope = crate::definition_repository::publisher_policy::acquisition_scope(
            &self.library,
            &self.catalog,
            &port.id,
        )?;
        let resolution = if scope.is_some()
            || crate::managed_runtime_policy::requires_provider_resolution(port)
        {
            let resolved = reporter
                .operation
                .interruptible(self.resolve_release(port, release.channel, Platform::current()?))
                .await?;
            if resolved.release.asset != release.asset
                || resolved.release.version != release.version
                || resolved.release.channel != release.channel
                || resolved.release.published_at != release.published_at
            {
                return Err(PortcoveError::conflict(
                    "reviewed release changed; obtain a new review before acquisition",
                ));
            }
            resolved
        } else {
            crate::ScopedResolvedRelease::legacy(release)
        };
        self.apply_scoped_release_with_shared(port, status, overrides, resolution, intent, reporter)
            .await
    }

    async fn apply_scoped_release<F>(
        &self,
        port: &PortDefinition,
        status: PortStatus,
        overrides: InstallOverrides<'_>,
        resolution: crate::ScopedResolvedRelease,
        activate: bool,
        reporter: &mut OperationReporter<'_, F>,
    ) -> Result<InstallRecord>
    where
        F: FnMut(OperationEvent),
    {
        self.apply_scoped_release_with_shared(
            port,
            status,
            overrides,
            resolution,
            ReleaseIntent {
                activate,
                shared_preferences: None,
                acquired: None,
            },
            reporter,
        )
        .await
    }

    async fn apply_scoped_release_with_shared<F>(
        &self,
        port: &PortDefinition,
        status: PortStatus,
        overrides: InstallOverrides<'_>,
        resolution: crate::ScopedResolvedRelease,
        intent: ReleaseIntent,
        reporter: &mut OperationReporter<'_, F>,
    ) -> Result<InstallRecord>
    where
        F: FnMut(OperationEvent),
    {
        let ReleaseIntent {
            activate,
            shared_preferences,
            acquired,
        } = intent;
        let output_location = self.output_location(&port.id, overrides.output_directory)?;
        crate::runtime_path_policy::check_output_root(
            port,
            Platform::current()?,
            &output_location.effective_output_directory,
        )?;
        let release = resolution.release.clone();
        let shared_root = if port.managed_shared_preferences.is_some() {
            self.shared_preferences_install_root(
                port,
                &status,
                &release,
                &output_location.effective_output_directory,
            )?
        } else {
            output_location.effective_output_directory.clone()
        };
        let shared_preferences = if port.managed_shared_preferences.is_some() {
            let accepted = match shared_preferences {
                Some(accepted) => Some(accepted),
                None => {
                    let expected =
                        crate::path::normalized_absolute(&shared_root, "reviewed shared scope")?;
                    let mut target = None;
                    for install in self
                        .library
                        .all_installs()?
                        .into_iter()
                        .filter(|install| install.port_id == port.id)
                    {
                        if crate::path::normalized_absolute(
                            &install.path,
                            "installed shared scope",
                        )? == expected
                        {
                            target = Some(install);
                            break;
                        }
                    }
                    match target {
                        Some(target) => Installer::new(self.library.clone())?
                            .retained_shared_preferences(&target)?,
                        None => None,
                    }
                }
            };
            crate::managed_shared_preferences::require_acceptance(
                port,
                accepted.as_ref(),
                &shared_root,
            )?;
            accepted
        } else {
            if shared_preferences.is_some() {
                return Err(PortcoveError::verification(
                    "unexpected shared preferences acceptance",
                ));
            }
            None
        };
        self.require_definition_operation(
            &self.catalog,
            port,
            DefinitionOperationContext::observed(DefinitionOperation::Install, false, true),
        )?;
        if let Some(active) = &status.active {
            self.require_portable_runtime_unchanged(active)?;
        }
        if let Some(active) = &status.active {
            self.require_portable_transition(active, port)?;
        }
        if status.active.is_none() && status.staged.is_none() {
            self.require_direct_fresh_data(port)?;
        }
        crate::preparation::source::require_fresh_canonical_data(port, &self.library)?;
        crate::native_temp::require_canonical_data(port, &self.library)?;
        let runtime = crate::runtime::required(port, Platform::current()?);
        let active_matches = status
            .active
            .as_ref()
            .map(|active| self.install_matches_release(active, &release, runtime.as_ref()))
            .transpose()?
            .unwrap_or(false);
        if let Some(active) = status.active.as_ref().filter(|_| active_matches) {
            self.require_ghostship_install_data_compatibility(active, Some(&active.version))?;
        } else {
            self.require_ghostship_data_compatibility(
                &port.id,
                &release.version,
                status
                    .active
                    .as_ref()
                    .map(|install| install.version.as_str()),
            )?;
        }
        if let Some(active) = &status.active
            && active_matches
        {
            self.require_installed_shared_preferences(active)?;
            self.managed_install_root(&port.id, &active.path)?;
            let qualification = self.installed_mutability_qualification(active)?;
            Installer::new(self.library.clone())?.verify_critical(active, &qualification)?;
            return Ok(active.clone());
        }
        if let Some(staged) = &status.staged
            && self.install_matches_release(staged, &release, runtime.as_ref())?
        {
            self.require_installed_shared_preferences(staged)?;
            self.managed_install_root(&port.id, &staged.path)?;
            if let Some(active) = &status.active {
                self.require_portable_target_transition(active, staged)?;
            }
            let qualification = self.installed_mutability_qualification(staged)?;
            Installer::new(self.library.clone())?.verify_critical(staged, &qualification)?;
            reporter.operation.begin_publication()?;
            return if activate {
                self.activate_staged_locked(&port.id, reporter.operation.operation_id())
            } else {
                Ok(staged.clone())
            };
        }
        if let Some(mut existing) =
            self.library
                .install_by_artifact(&port.id, &release.asset.sha256, runtime.as_ref())?
            && self.install_matches_release(&existing, &release, runtime.as_ref())?
        {
            self.require_installed_shared_preferences(&existing)?;
            self.managed_install_root(&port.id, &existing.path)?;
            if let Some(active) = &status.active {
                // Reuse publishes the target's retained contract, not today's definition.
                self.require_portable_target_transition(active, &existing)?;
            }
            let qualification = self.installed_mutability_qualification(&existing)?;
            Installer::new(self.library.clone())?.verify_critical(&existing, &qualification)?;
            reporter.operation.begin_publication()?;
            self.prepare_retained_install_data(&existing)?;
            self.library.register_install(&existing, activate)?;
            existing.staged = !activate;
            return Ok(existing);
        }
        let qualification =
            InstallQualification::from_catalog(&self.catalog, &port.id, Platform::current()?)?
                .with_acquisition_resolution(resolution)?
                .with_shared_preferences(shared_preferences, &shared_root)?;
        self.collect_active_user_data_if_launched(&port.id)?;
        let source =
            self.validate_and_remember_source(port, overrides.source, reporter.operation)?;
        reporter.operation.checkpoint()?;
        let bios = self.validate_and_remember_bios(port, overrides.bios, reporter.operation)?;
        reporter.operation.checkpoint()?;
        let platform = Platform::current()?;
        let qualification = qualification
            .with_cartridge_build_source(source.as_ref())?
            .with_runtime_source(source.as_ref())?;
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
        let staged_activation = port.adapter == AdapterKind::NativePortable
            || crate::persistence::requires_restore_receipt(port);
        let installed = Installer::with_faults(self.library.clone(), self.faults.clone())?
            .install_acquired(
                InstallRequest {
                    port_id: port.id.clone(),
                    release,
                    output_root: self
                        .output_location(&port.id, overrides.output_directory)?
                        .effective_output_directory,
                    activate: activate && !staged_activation,
                    managed,
                    qualification,
                },
                acquired.as_ref(),
                reporter.operation,
                &mut *reporter.emit,
            )
            .await?;
        if staged_activation && let Some(active) = &status.active {
            self.require_portable_target_transition(active, &installed)
                .map_err(|error| error.detail("staged_install_id", &installed.id))?;
        }
        if staged_activation && activate {
            self.activate_staged_locked(&port.id, &Uuid::new_v4().to_string())
        } else {
            Ok(installed)
        }
    }

    pub async fn reconcile<F>(&self, port_id: &str, mut emit: F) -> Result<ReconcileResult>
    where
        F: FnMut(OperationEvent),
    {
        let (activity, operation) = self.begin_cancellable_activity(
            ActivityOperation::Reconcile,
            ActivityTargetKind::Port,
            Some(port_id),
        )?;
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
                let release = operation
                    .interruptible(self.resolve_release(
                        port,
                        optimistic.channel,
                        Platform::current()?,
                    ))
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
                let check = self.record_update_check(port_id, &status, &release.release)?;
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
                    .apply_scoped_release(
                        port,
                        status,
                        InstallOverrides {
                            source: None,
                            bios: None,
                            output_directory: None,
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
        let result = self.finish_activity(activity, result);
        emit(operation.finished(OperationResult::from_result(&result)));
        result
    }

    fn validate_and_remember_source(
        &self,
        port: &PortDefinition,
        source_override: Option<&Path>,
        operation: &OperationCoordinator,
    ) -> Result<Option<SourceRecord>> {
        let Some(profile_id) = &port.source_profile else {
            return Ok(None);
        };
        if let Some(path) = source_override {
            let _guards = self.lock_source_dependents(profile_id, Some(&port.id))?;
            let source = self.inspect_source_record(profile_id, path)?;
            self.library.register_source(&source)?;
            return Ok(Some(source));
        }
        match self.verified_source_record(profile_id) {
            Ok(source) => Ok(Some(source)),
            Err(error) if error.code == crate::ErrorCode::NotFound => self
                .resolve_and_register_inbox_source(profile_id, Some(&port.id), operation)
                .map(Some)
                .map_err(|error| {
                    if error.code == crate::ErrorCode::NotFound {
                        PortcoveError::source(format!(
                            "{} needs game files for profile {profile_id}; add them in Portcove's game-file folder, use --source, or save the file location first",
                            port.name
                        ))
                        .detail("profile_id", profile_id)
                        .detail("source_inbox", self.library.source_inbox_dir().display().to_string())
                    } else {
                        error
                    }
                }),
            Err(error) => Err(error),
        }
    }

    fn validate_and_remember_bios(
        &self,
        port: &PortDefinition,
        bios_override: Option<&Path>,
        operation: &OperationCoordinator,
    ) -> Result<Option<SourceRecord>> {
        let Some(profile_id) = &port.bios_source_profile else {
            return Ok(None);
        };
        if let Some(path) = bios_override {
            let _guards = self.lock_source_dependents(profile_id, Some(&port.id))?;
            let source = self.inspect_source_record(profile_id, path)?;
            self.library.register_source(&source)?;
            return Ok(Some(source));
        }
        match self.verified_source_record(profile_id) {
            Ok(source) => Ok(Some(source)),
            Err(error) if error.code == crate::ErrorCode::NotFound => self
                .resolve_and_register_inbox_source(profile_id, Some(&port.id), operation)
                .map(Some)
                .map_err(|error| {
                    if error.code == crate::ErrorCode::NotFound {
                        PortcoveError::source(format!(
                            "{} requires BIOS profile {profile_id}; place it in the Source Inbox, pass --bios, or register it first",
                            port.name
                        ))
                        .detail("profile_id", profile_id)
                        .detail("source_inbox", self.library.source_inbox_dir().display().to_string())
                    } else {
                        error
                    }
                }),
            Err(error) => Err(error),
        }
    }

    pub(crate) fn resolve_and_register_inbox_source(
        &self,
        profile_id: &str,
        already_locked: Option<&str>,
        operation: &OperationCoordinator,
    ) -> Result<SourceRecord> {
        let _guards = self.lock_source_dependents(profile_id, already_locked)?;
        if let Some(registered) = self.library.source(profile_id)? {
            self.verify_source_record(&registered)?;
            return Ok(registered);
        }
        let resolution = self.scan_source_inbox_untracked(
            profile_id,
            &crate::SourceDiscoveryLimits::default(),
            operation,
        )?;
        match resolution.state {
            crate::SourceInboxResolutionState::ExactMatch => {
                let selected = resolution.selected.ok_or_else(|| {
                    PortcoveError::state("an exact Source Inbox result omitted its source record")
                })?;
                let inspection = self.inspect_source(profile_id, &selected.path)?;
                if !matches!(
                    inspection.assessment.admission,
                    crate::SourceAdmission::Admitted {
                        mode: crate::SourceAdmissionMode::ExactIdentity
                    }
                ) {
                    return Err(PortcoveError::conflict(
                        "the Source Inbox candidate changed after inspection",
                    )
                    .detail("profile_id", profile_id)
                    .detail("path", selected.path.display().to_string()));
                }
                let source = inspection.require_admitted_record()?;
                self.library.register_source(&source)?;
                Ok(source)
            }
            crate::SourceInboxResolutionState::Conflict => {
                let paths = resolution
                    .candidates
                    .iter()
                    .filter(|candidate| candidate.automatically_reusable)
                    .map(|candidate| candidate.inspection.path.display().to_string())
                    .collect::<Vec<_>>();
                Err(PortcoveError::conflict(
                    "more than one exact source matches in the profile Source Inbox",
                )
                .detail("profile_id", profile_id)
                .detail("candidate_paths", serde_json::to_string(&paths)?))
            }
            crate::SourceInboxResolutionState::ApprovalRequired => Err(PortcoveError::source(
                "the Source Inbox candidate needs explicit approval before first registration",
            )
            .detail("profile_id", profile_id)
            .detail("inbox_state", "approval_required")),
            crate::SourceInboxResolutionState::Incomplete => Err(PortcoveError::source(
                "the Source Inbox scan was incomplete and cannot select a source safely",
            )
            .detail("profile_id", profile_id)
            .detail(
                "limits_reached",
                serde_json::to_string(&resolution.stats.limits_reached)?,
            )
            .detail("issue_count", resolution.stats.issues.len().to_string())),
            crate::SourceInboxResolutionState::Unresolved
            | crate::SourceInboxResolutionState::Registered => Err(PortcoveError::not_found(
                "the profile Source Inbox has no reusable exact source",
            )
            .detail("profile_id", profile_id)),
        }
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
        let runtime_source_directory = (port.runtime_source_materialization
            == Some(crate::RuntimeSourceMaterialization::PsxRawSet))
        .then(|| port.runtime_source_filename.as_ref().map(PathBuf::from))
        .flatten();
        Ok(Some(crate::PsxManagedPreparation {
            source,
            bios,
            source_paths,
            runtime_source_directory,
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
            let qualification = self.installed_mutability_qualification(&active)?;
            self.managed_install_root(port_id, &active.path)?;
            Installer::new(self.library.clone())?.verify_managed(&active, &qualification)
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
            let status = self.status_without_rollback_assessment(port_id)?;
            let previous = status.previous.ok_or_else(|| {
                PortcoveError::not_found(format!("{port_id} has no rollback version"))
            })?;
            let (port, qualification) = self
                .rollback_target(port_id, &previous, status.active.as_ref(), true)
                .map_err(|failure| failure.error)?;
            self.collect_active_user_data_if_launched(port_id)?;
            if let Some(active) = &status.active {
                self.require_portable_rollback_transition(active, &previous)?;
            }
            self.restore_user_data_to(&port, &previous.path)?;
            Installer::new(self.library.clone())?.verify_critical(&previous, &qualification)?;
            self.library.rollback(port_id)
        })();
        self.finish_activity(activity, result)
    }

    /// The same read-only retained-target checks used by status and locked execution.
    /// Neither a current definition nor the active version's launch readiness
    /// substitutes for the previous installation's contract and bytes.
    fn rollback_target(
        &self,
        port_id: &str,
        previous: &InstallRecord,
        active: Option<&InstallRecord>,
        verify_original: bool,
    ) -> std::result::Result<(PortDefinition, InstallQualification), RollbackTargetFailure> {
        // Preview must preserve execution's current-catalog route gate. A
        // retained contract proves the target's identity, not a newly offered
        // rollback route after its port has left the current catalog.
        self.catalog
            .port(port_id)
            .map_err(|error| RollbackTargetFailure {
                reason: PortActionReason::RouteNotOffered,
                error,
                definition: None,
            })?;
        let active_version = active.map(|install| install.version.as_str());
        let compatibility = if verify_original {
            self.require_ghostship_install_data_compatibility(previous, active_version)
        } else {
            self.inspect_ghostship_install_data_compatibility(previous, active_version)
        };
        compatibility.map_err(|error| RollbackTargetFailure {
            reason: PortActionReason::UnsafeData,
            error,
            definition: None,
        })?;
        let invalid = |error| RollbackTargetFailure {
            reason: PortActionReason::InvalidInstallation,
            error,
            definition: None,
        };
        let port = self.installed_port(previous).map_err(invalid)?;
        crate::install::check_retained_runtime_paths(previous, &previous.path).map_err(invalid)?;
        self.require_portable_runtime_unchanged(previous)
            .map_err(invalid)?;
        if let Some(active) = active {
            self.require_portable_rollback_transition(active, previous)
                .map_err(|error| RollbackTargetFailure {
                    reason: PortActionReason::UnsafeData,
                    error,
                    definition: None,
                })?;
        }
        self.require_installed_shared_preferences(previous)
            .map_err(invalid)?;
        let qualification = self
            .installed_mutability_qualification(previous)
            .map_err(invalid)?;
        let platform = Platform::current().map_err(invalid)?;
        crate::runtime::require_ready(&port, platform, previous).map_err(|error| {
            RollbackTargetFailure {
                reason: PortActionReason::MissingRuntime,
                error,
                definition: None,
            }
        })?;
        self.managed_install_root(port_id, &previous.path)
            .map_err(invalid)?;
        let installer = Installer::new(self.library.clone()).map_err(invalid)?;
        let operation =
            crate::definition_repository::publisher_policy::CuratedArtifactOperation::LocalUse;
        let assessment = installer
            .assess_curated_operation(previous, operation)
            .map_err(invalid)?;
        if assessment.outcome != DefinitionEligibilityOutcome::Eligible {
            let error = installer
                .require_curated_operation(previous, operation)
                .err()
                .unwrap_or_else(|| {
                    PortcoveError::conflict(
                        "artifact authority changed during rollback assessment; assess it again",
                    )
                });
            return Err(RollbackTargetFailure {
                reason: PortActionReason::DefinitionIneligible,
                error,
                definition: Some(assessment),
            });
        }
        installer
            .verify_critical(previous, &qualification)
            .map_err(invalid)?;
        Ok((port, qualification))
    }

    pub fn activate_staged(&self, port_id: &str) -> Result<InstallRecord> {
        self.activate_staged_with_review(port_id, None)
    }

    pub fn activate_staged_reviewed(
        &self,
        port_id: &str,
        expected_active: Option<&str>,
        expected_staged: &str,
    ) -> Result<InstallRecord> {
        self.activate_staged_with_review(port_id, Some((expected_active, expected_staged)))
    }

    fn activate_staged_with_review(
        &self,
        port_id: &str,
        expected: Option<(Option<&str>, &str)>,
    ) -> Result<InstallRecord> {
        let activity = self.library.begin_activity(
            ActivityOperation::Activate,
            ActivityTargetKind::Port,
            Some(port_id),
        )?;
        let result = (|| {
            self.catalog.port(port_id)?;
            let _operation = self.library.try_lock_port(port_id, "activate")?;
            if let Some((active, staged)) = expected {
                let status = self.status(port_id)?;
                if status.active.as_ref().map(|install| install.id.as_str()) != active
                    || status.staged.as_ref().map(|install| install.id.as_str()) != Some(staged)
                {
                    return Err(PortcoveError::conflict(
                        "installed versions changed; review staged activation again",
                    ));
                }
            }
            self.activate_staged_locked(port_id, &activity.id)
        })();
        self.finish_activity(activity, result)
    }

    fn activate_staged_locked(&self, port_id: &str, operation_id: &str) -> Result<InstallRecord> {
        let status = self.status_without_rollback_assessment(port_id)?;
        let staged = status
            .staged
            .ok_or_else(|| PortcoveError::not_found(format!("{port_id} has no staged version")))?;
        self.require_ghostship_install_data_compatibility(
            &staged,
            status
                .active
                .as_ref()
                .map(|install| install.version.as_str()),
        )?;
        let port = self.installed_port(&staged)?;
        if let Some(active) = &status.active {
            self.require_portable_target_transition(active, &staged)?;
        }
        self.require_installed_shared_preferences(&staged)?;
        let qualification = self.installed_mutability_qualification(&staged)?;
        crate::runtime::require_ready(&port, Platform::current()?, &staged)?;
        self.managed_install_root(port_id, &staged.path)?;
        Installer::new(self.library.clone())?.verify_critical(&staged, &qualification)?;
        let store = OperationStore::new(self.library.clone());
        let mut lifecycle =
            LifecycleOperation::new(operation_id, LifecycleOperationKind::Activate, port_id);
        lifecycle.install = Some(staged.clone());
        let mut activation = crate::recovery::ActivationOperation::decode(self, &lifecycle)?;
        store.put(&mut lifecycle)?;
        let result: Result<InstallRecord> = (|| {
            self.prepare_retained_install_data(&staged)?;
            let commit = activation.prepare_commit(self, &mut lifecycle)?;
            let activated = self.library.activate_staged(port_id)?;
            commit.persist(&store)?;
            self.faults
                .check(LifecycleFaultPoint::ActivationMetadataCommitted)?;
            store.remove(&lifecycle.id)?;
            Ok(activated)
        })();
        if let Err(error) = &result {
            if activation.is_preparing() {
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
        let detected = self.detect_adoption_ports(source, selected_port_id)?;
        let selected = match detected.as_slice() {
            [only] => Some(only.clone()),
            _ => None,
        };
        if let Some(id) = &selected {
            crate::runtime_data_policy::refuse_adoption(self.catalog.port(id)?)?;
        }
        let copy_plan = adoption_copy_plan(source)?;
        let destination = selected
            .as_deref()
            .map(|id| self.adoption_destination(source, id, &copy_plan))
            .transpose()?;
        let plan_sha256 = adoption_plan_fingerprint(
            source,
            &detected,
            selected.as_deref(),
            &copy_plan,
            destination.as_ref(),
        )?;
        Ok(AdoptionPreview {
            source: source.to_path_buf(),
            detected_port_ids: detected,
            selected_port_id: selected,
            application_files_will_be_copied: true,
            original_will_be_modified: false,
            copy_plan,
            destination,
            plan_sha256,
        })
    }

    fn detect_adoption_ports(
        &self,
        source: &Path,
        selected_port_id: Option<&str>,
    ) -> Result<Vec<String>> {
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
            if port.release.provider == ReleaseSource::UserPrepared {
                return Err(PortcoveError::unsupported(
                    "user-prepared runtimes use non-owning external registration, not adoption",
                ));
            }
            let qualification = InstallQualification::from_port(port, platform)?;
            crate::install::resolve_declared_executable(source, &qualification)?;
            detected.push(id.to_owned());
        } else {
            for port in self.catalog.ports().iter().filter(|port| {
                port.platforms.contains(&platform)
                    && port.release.provider != ReleaseSource::UserPrepared
            }) {
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
        Ok(detected)
    }

    fn adoption_destination(
        &self,
        source: &Path,
        port_id: &str,
        copy_plan: &AdoptionCopyPlan,
    ) -> Result<AdoptionDestinationPreview> {
        let port = self.catalog.port(port_id)?;
        let qualification = InstallQualification::from_port(port, Platform::current()?)?;
        let executable = crate::install::resolve_declared_executable(source, &qualification)?;
        let persistent_root = qualification.persistence_root(source, &executable);
        let prefix = persistent_root
            .strip_prefix(source)
            .map_err(|_| PortcoveError::state("adoption persistence escaped its source"))?;
        let imported_user_data_paths = crate::persistence::entries(port, &[&persistent_root])?
            .into_iter()
            .filter(|relative| {
                let copied = prefix.join(relative);
                copy_plan.directories.contains(&copied)
                    || copy_plan
                        .files
                        .iter()
                        .any(|file| file.relative_path == copied)
            })
            .map(PathBuf::from)
            .collect();
        let output_location = self.output_location(port_id, None)?;
        let user_root = &output_location.user_data_root;
        crate::path::refuse_symlink_ancestors(user_root)?;
        let user_plan = if user_root.exists() {
            Some(adoption_copy_plan(user_root)?)
        } else {
            None
        };
        Ok(AdoptionDestinationPreview {
            output_location,
            active_install: self.library.status(port_id, default_channel(port))?.active,
            imported_user_data_paths,
            current_user_data_files: user_plan.as_ref().map_or(0, |plan| plan.files.len()),
            current_user_data_sha256: user_plan
                .as_ref()
                .map(|plan| {
                    serde_json::to_vec(plan).map(|bytes| hex::encode(Sha256::digest(bytes)))
                })
                .transpose()?,
        })
    }

    pub fn authorize_adoption(
        &self,
        source: &Path,
        selected_port_id: Option<&str>,
        expected_plan_sha256: &str,
    ) -> Result<crate::DestructiveAuthorization> {
        validate_reviewed_fingerprint("adoption plan", expected_plan_sha256)?;
        let target = adoption_authorization_target(source, selected_port_id)?;
        self.library
            .issue_authorization("adopt", &target, expected_plan_sha256)
    }

    pub fn adopt(
        &self,
        source: &Path,
        selected_port_id: Option<&str>,
        authorization_token: &str,
    ) -> Result<InstallRecord> {
        let detected = self.detect_adoption_ports(source, selected_port_id)?;
        let port_id = match detected.as_slice() {
            [only] => Ok(only.clone()),
            [] => Err(PortcoveError::not_found(
                "no supported Portcove installation was detected; provide --port",
            )),
            _ => Err(PortcoveError::conflict(format!(
                "multiple ports detected: {}",
                detected.join(", ")
            ))
            .with_known_cause(crate::failure::KnownFailureCause::AmbiguousAdoption)),
        }?;
        let activity = self.library.begin_activity(
            ActivityOperation::Adopt,
            ActivityTargetKind::Port,
            Some(&port_id),
        )?;
        let store = OperationStore::new(self.library.clone());
        let mut lifecycle =
            LifecycleOperation::new(&activity.id, LifecycleOperationKind::Adopt, &port_id);
        let mut operation_root = None;
        let timestamp = Library::now();
        let version = format!("adopted-{timestamp}");
        lifecycle.activate = true;
        let mut lifecycle = crate::operation::publication::PublicationJournal::begin(lifecycle)?;
        let mut result = (|| {
            let port = self.catalog.port(&port_id)?;
            let platform = Platform::current()?;
            let qualification =
                InstallQualification::from_catalog(&self.catalog, &port_id, platform)?;
            let _operation = self.library.try_lock_port(&port_id, "adopt")?;
            self.require_definition_adoption(&self.catalog, port)?;
            if let Some(active) = self.status(&port_id)?.active {
                self.require_portable_transition(&active, port)?;
            }
            crate::preparation::source::require_fresh_canonical_data(port, &self.library)?;
            crate::native_temp::require_canonical_data(port, &self.library)?;
            let locked_preview = self.preview_adoption(source, selected_port_id)?;
            let target = adoption_authorization_target(source, selected_port_id)?;
            self.library.consume_authorization(
                authorization_token,
                "adopt",
                &target,
                &locked_preview.plan_sha256,
            )?;
            let prepared_root = crate::output_root::prepare_for_install(
                &self.library,
                &port_id,
                &locked_preview
                    .destination
                    .as_ref()
                    .ok_or_else(|| PortcoveError::state("adoption destination was not selected"))?
                    .output_location
                    .effective_output_directory,
                &activity.id,
                locked_preview.copy_plan.total_bytes,
            )?;
            operation_root = Some(prepared_root.operation_root);
            let operation_root = operation_root.as_ref().expect("operation root assigned");
            lifecycle.set_staging(operation_root.clone())?;
            lifecycle.persist(&store)?;
            let payload_root = operation_root.join("payload");
            let staged_user = operation_root.join("user");
            fs::create_dir_all(operation_root)?;
            copy_adoption_plan(source, &payload_root, &locked_preview.copy_plan)?;
            self.faults.check(LifecycleFaultPoint::AdoptionCopied)?;
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
            crate::preparation::source::require_pristine_adoption(
                port,
                &payload_root,
                &copied_executable,
            )?;
            for relative in crate::persistence::entries(port, &[&persistent_root])? {
                let candidate = persistent_root.join(&relative);
                if candidate.exists() {
                    copy_entry(&candidate, &staged_user.join(relative))?;
                }
            }
            let installer = Installer::new(self.library.clone())?;
            let artifact = crate::install::local_artifact_identity(&payload_root, &qualification)?;
            let destination = prepared_root.root.join(&artifact.sha256);
            if destination.exists() {
                return Err(PortcoveError::conflict(
                    "an identical adopted artifact already exists",
                ));
            }
            lifecycle.set_destination(destination.clone())?;
            lifecycle.persist(&store)?;
            let (manifest_sha256, selected_executable, runtime) = installer.create_manifest(
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
                runtime,
            };
            let staged_install = InstallRecord {
                path: payload_root.clone(),
                ..install.clone()
            };
            crate::install::check_retained_runtime_paths(&staged_install, &install.path)?;
            if !installer.verify(&staged_install)?.valid {
                return Err(PortcoveError::verification(
                    "adopted payload failed its post-copy manifest verification",
                ));
            }
            let current_destination =
                self.adoption_destination(source, &port_id, &locked_preview.copy_plan)?;
            if serde_json::to_vec(&Some(current_destination))?
                != serde_json::to_vec(&locked_preview.destination)?
            {
                return Err(PortcoveError::conflict(
                    "adoption destination or saved data changed while copying; review the copy plan again",
                ));
            }
            lifecycle.prepare(install.clone(), &store)?;
            self.faults.check(LifecycleFaultPoint::AdoptionPrepared)?;
            self.require_definition_adoption(&self.catalog, port)?;
            crate::runtime_data_policy::refuse_sensitive_tree(&payload_root)?;
            crate::runtime_data_policy::refuse_sensitive_tree(&staged_user)?;
            fs::create_dir_all(
                destination
                    .parent()
                    .expect("version directory has a parent"),
            )?;
            crate::durability::rename_noreplace(&payload_root, &destination)?;
            lifecycle.advance(LifecyclePhase::PayloadPublished, &store)?;
            self.faults.check(LifecycleFaultPoint::AdoptionPublished)?;
            self.library.register_install(&install, true)?;
            lifecycle.advance(LifecyclePhase::MetadataCommitted, &store)?;
            self.faults
                .check(LifecycleFaultPoint::AdoptionMetadataCommitted)?;
            if staged_user.exists() {
                copy_tree(&staged_user, &self.library.user_dir(&port_id))?;
            }
            crate::runtime_data_policy::refuse_sensitive_tree(operation_root)?;
            if let Err(error) = fs::remove_dir_all(operation_root) {
                lifecycle.retain_cleanup(error.to_string(), &store)?;
                return Ok(install);
            }
            store.remove(&lifecycle.id)?;
            Ok(install)
        })();
        if let Err(error) = &mut result {
            if lifecycle.phase == LifecyclePhase::Preparing {
                let cleanup = if let Some(operation_root) = &operation_root {
                    self.faults
                        .check(LifecycleFaultPoint::AdoptionPrivateCleanup)
                        .and_then(|()| {
                            crate::runtime_data_policy::refuse_sensitive_tree(operation_root)
                        })
                        .and_then(|()| match fs::remove_dir_all(operation_root) {
                            Ok(()) => Ok(()),
                            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                            Err(error) => Err(error.into()),
                        })
                } else {
                    Ok(())
                };
                if let Err(cleanup) = cleanup {
                    let retained_error = format!(
                        "{}; private adoption cleanup failed: {}",
                        error.message, cleanup.message
                    );
                    error.failure.mutation_state = crate::MutationState::RecoveryRequired;
                    error
                        .details
                        .insert("operation_id".into(), lifecycle.id.clone());
                    error
                        .details
                        .insert("cleanup_error".into(), cleanup.message);
                    if let Err(persist) = lifecycle.record_error(retained_error, &store) {
                        error
                            .details
                            .insert("persistence_error".into(), persist.message);
                    }
                } else if let Err(retire) = store.remove(&lifecycle.id) {
                    // Do not recreate a journal after an ambiguous retirement error.
                    error.failure.mutation_state = crate::MutationState::RecoveryRequired;
                    error
                        .details
                        .insert("operation_id".into(), lifecycle.id.clone());
                    error
                        .details
                        .insert("journal_retirement_error".into(), retire.message);
                }
            } else {
                error.failure.mutation_state = crate::MutationState::RecoveryRequired;
                error
                    .details
                    .entry("operation_id".into())
                    .or_insert_with(|| lifecycle.id.clone());
                let _ = lifecycle.record_error(error.message.clone(), &store);
            }
        }
        self.finish_activity(activity, result)
    }

    pub fn preview_removal(&self, port_id: &str) -> Result<PortRemovalPreview> {
        self.catalog.port(port_id)?;
        crate::retained_build::require_no_references(&self.library.connection()?, port_id)?;
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
        for install in &installs {
            self.require_portable_runtime_unchanged(install)?;
            let paths = crate::output_root::removal_paths(
                &self.library,
                port_id,
                "removal-preview",
                &install.path,
            )?;
            crate::managed_tfe::require_no_recovery_data(&paths.live)?;
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
            )
            .with_known_cause(crate::failure::KnownFailureCause::StaleRemoval));
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
        let mut intent_persisted = false;
        let mut result: Result<Vec<PathBuf>> = (|| {
            self.catalog.port(port_id)?;
            let _operation = self.library.try_lock_port(port_id, "remove")?;
            let locked_preview = self.preview_removal(port_id)?;
            self.library.consume_authorization(
                authorization_token,
                "remove",
                port_id,
                &locked_preview.preview_sha256,
            )?;
            self.collect_active_user_data_if_launched(port_id)?;
            let paths = self.library.port_install_paths(port_id)?;
            let removals = paths
                .iter()
                .map(|path| {
                    crate::output_root::removal_paths(&self.library, port_id, &activity.id, path)
                })
                .collect::<Result<Vec<_>>>()?;
            lifecycle.original_paths = removals
                .iter()
                .map(|removal| removal.live.clone())
                .collect();
            lifecycle.removal_installs = Some(
                self.library
                    .all_installs()?
                    .into_iter()
                    .filter(|install| install.port_id == port_id)
                    .collect(),
            );
            let mut removal = RemovalOperation::decode(&self.library, &lifecycle)?;
            removal.require_retained_outputs(self, &lifecycle)?;
            store.put(&mut lifecycle)?;
            intent_persisted = true;
            for removal in &removals {
                if let Some(parent) = removal.quarantined.parent() {
                    fs::create_dir_all(parent)?;
                }
                crate::durability::rename_noreplace(&removal.live, &removal.quarantined)?;
            }
            removal.advance(RemovalPhase::Quarantined, &mut lifecycle, &store)?;
            self.faults.check(LifecycleFaultPoint::RemovalQuarantined)?;
            for paths in removal.paths(&self.library)? {
                crate::managed_tfe::require_no_recovery_data(&paths.quarantined)?;
            }
            removal.require_retained_outputs(self, &lifecycle)?;
            self.library.remove_port(port_id)?;
            removal.advance(RemovalPhase::Committed, &mut lifecycle, &store)?;
            self.faults
                .check(LifecycleFaultPoint::RemovalMetadataCommitted)?;
            self.faults.check(LifecycleFaultPoint::RemovalCleanup)?;
            crate::retained_build::require_no_references(&self.library.connection()?, port_id)?;
            for paths in removal.paths(&self.library)? {
                crate::managed_tfe::require_no_recovery_data(&paths.quarantined)?;
            }
            removal.require_retained_outputs(self, &lifecycle)?;
            for cleanup_root in removal
                .paths(&self.library)?
                .iter()
                .map(|path| &path.cleanup_root)
            {
                if cleanup_root.exists()
                    && let Err(error) = fs::remove_dir_all(cleanup_root)
                {
                    lifecycle.last_error = Some(error.to_string());
                    removal.advance(RemovalPhase::CleanupPending, &mut lifecycle, &store)?;
                    return Ok(paths);
                }
            }
            store.remove(&lifecycle.id)?;
            Ok(paths)
        })();
        if let Err(error) = &mut result
            && intent_persisted
        {
            if error.failure.mutation_state == crate::MutationState::Unknown {
                error.failure.mutation_state = crate::MutationState::RecoveryRequired;
            }
            lifecycle.last_error = Some(error.message.clone());
            let _ = store.put(&mut lifecycle);
        }
        self.finish_activity(activity, result)
    }

    pub fn preview_external_runtime(
        &self,
        port_id: &str,
        requested_root: &Path,
    ) -> Result<ExternalRuntimePreview> {
        self.preview_external_runtime_with_checkpoint(port_id, requested_root, &|| Ok(()))
    }

    fn preview_external_runtime_with_checkpoint(
        &self,
        port_id: &str,
        requested_root: &Path,
        checkpoint: &dyn Fn() -> Result<()>,
    ) -> Result<ExternalRuntimePreview> {
        self.require_no_pending_setup(port_id)?;
        let port = self.catalog.port(port_id)?;
        if port.release.provider != ReleaseSource::UserPrepared {
            return Err(PortcoveError::unsupported(format!(
                "{} does not offer user-prepared runtime registration",
                port.name
            )));
        }
        let platform = Platform::current()?;
        let spec = port.release.user_prepared.get(&platform).ok_or_else(|| {
            PortcoveError::unsupported("no user-prepared runtime for this platform")
        })?;
        self.require_definition_operation(
            &self.catalog,
            port,
            DefinitionOperationContext::observed(
                DefinitionOperation::RegisterExternal,
                false,
                true,
            ),
        )?;
        self.inspect_external_runtime_preview(port, spec, requested_root, checkpoint)
    }

    fn inspect_external_runtime_preview(
        &self,
        port: &PortDefinition,
        spec: &crate::UserPreparedRuntimeSpec,
        requested_root: &Path,
        checkpoint: &dyn Fn() -> Result<()>,
    ) -> Result<ExternalRuntimePreview> {
        if spec.trust != crate::ExternalRuntimeTrust::AcceptedPackage {
            return Err(PortcoveError::unsupported(
                "select the executable and working directory explicitly for this user-managed installation",
            ));
        }
        let inspected = crate::external_runtime::inspect_with_checkpoint(
            requested_root,
            spec,
            self.library.root(),
            checkpoint,
        )?;
        crate::external_runtime::shared_preferences::check_runtime_path(spec, &inspected.root)?;
        Self::check_external_runtime_paths(
            port,
            Platform::current()?,
            &inspected.root,
            &inspected.executable,
        )?;
        let shared_preferences =
            crate::external_runtime::shared_preferences::inspect(spec, &inspected.root)?;
        let identity = (
            port,
            &inspected.root,
            &inspected.immutable_tree_sha256,
            inspected.immutable_file_count,
        );
        let preview_bytes = if let Some(shared) = &shared_preferences {
            serde_json::to_vec(&(identity, shared))?
        } else {
            serde_json::to_vec(&identity)?
        };
        let preview_sha256 = hex::encode(Sha256::digest(preview_bytes));
        Ok(ExternalRuntimePreview {
            user_selected: None,
            port_id: port.id.clone(),
            path: inspected.root,
            executable: inspected.executable,
            version: spec.version.clone(),
            archive_sha256: spec.archive_sha256.clone(),
            immutable_tree_sha256: inspected.immutable_tree_sha256,
            immutable_file_count: inspected.immutable_file_count,
            preview_sha256,
            shared_preferences,
        })
    }

    fn check_external_runtime_paths(
        port: &PortDefinition,
        platform: Platform,
        root: &Path,
        executable: &Path,
    ) -> Result<()> {
        if port.windows_runtime_path_policy.is_none() {
            return Ok(());
        }
        crate::runtime_path_policy::check_executable(port, platform, executable)?;
        crate::runtime_path_policy::check_prepared_path(port, platform, executable)?;
        let directory = if port.runtime_subdirectory.is_some() {
            crate::adapter::launch_working_directory(port.adapter, port, root, executable)?
        } else {
            root.to_path_buf()
        };
        crate::runtime_path_policy::check_working_directory(port, platform, &directory)?;
        crate::runtime_path_policy::check_prepared_path(
            port,
            platform,
            &directory.join(".snesrecomp_write_probe"),
        )
    }

    pub fn authorize_external_runtime(
        &self,
        port_id: &str,
        requested_root: &Path,
        expected_preview_sha256: &str,
    ) -> Result<crate::DestructiveAuthorization> {
        self.authorize_external_runtime_with_shared_preferences_ack(
            port_id,
            requested_root,
            expected_preview_sha256,
            None,
        )
    }

    /// The acknowledgment must come from a consumer that disclosed the shared
    /// scope. Legacy generic confirmation cannot authorize this new write scope.
    pub fn authorize_external_runtime_with_shared_preferences_ack(
        &self,
        port_id: &str,
        requested_root: &Path,
        expected_preview_sha256: &str,
        acknowledged_preview_sha256: Option<&str>,
    ) -> Result<crate::DestructiveAuthorization> {
        let preview = self.preview_external_runtime(port_id, requested_root)?;
        if preview.preview_sha256 != expected_preview_sha256 {
            return Err(PortcoveError::conflict(
                "user-prepared runtime changed after review",
            ));
        }
        crate::external_runtime::shared_preferences::require_ack(
            &preview,
            acknowledged_preview_sha256,
        )?;
        self.library
            .issue_authorization("register_external", port_id, &preview.preview_sha256)
    }

    pub fn register_external_runtime(
        &self,
        port_id: &str,
        requested_root: &Path,
        authorization_token: &str,
    ) -> Result<ExternalRuntimeRecord> {
        let (activity, operation) = self.begin_cancellable_activity(
            ActivityOperation::RegisterExternal,
            ActivityTargetKind::Port,
            Some(port_id),
        )?;
        let result = (|| {
            let _lock = self.library.try_lock_port(port_id, "register-external")?;
            let preview =
                self.preview_external_runtime_with_checkpoint(port_id, requested_root, &|| {
                    operation.checkpoint()
                })?;
            self.library.consume_authorization(
                authorization_token,
                "register_external",
                port_id,
                &preview.preview_sha256,
            )?;
            operation.begin_publication()?;
            let record = ExternalRuntimeRecord {
                user_selected: None,
                id: Uuid::new_v4().to_string(),
                port_id: port_id.to_owned(),
                path: preview.path,
                executable: preview.executable,
                version: preview.version,
                platform: Platform::current()?,
                archive_sha256: preview.archive_sha256,
                immutable_tree_sha256: preview.immutable_tree_sha256,
                registered_at: Library::now(),
                retained_definition: self.catalog.definition_selection(port_id).cloned(),
                shared_preferences: preview.shared_preferences.map(|review| review.binding),
            };
            self.library
                .register_external_runtime(&record, &self.catalog)?;
            Ok(record)
        })();
        self.finish_activity(activity, result)
    }

    pub fn preview_external_removal(&self, port_id: &str) -> Result<ExternalRuntimeRemovalPreview> {
        let (record, _) = self
            .library
            .external_runtime_with_port(port_id)?
            .ok_or_else(|| {
                PortcoveError::not_found("external runtime registration was not found")
            })?;
        let preview_sha256 = hex::encode(Sha256::digest(serde_json::to_vec(&record)?));
        Ok(ExternalRuntimeRemovalPreview {
            port_id: port_id.to_owned(),
            path: record.path,
            version: record.version,
            external_files_will_be_preserved: true,
            preview_sha256,
        })
    }

    pub fn authorize_external_removal(
        &self,
        port_id: &str,
        expected_preview_sha256: &str,
    ) -> Result<crate::DestructiveAuthorization> {
        let preview = self.preview_external_removal(port_id)?;
        if preview.preview_sha256 != expected_preview_sha256 {
            return Err(PortcoveError::conflict(
                "external registration changed after removal review",
            ));
        }
        self.library
            .issue_authorization("remove_external", port_id, &preview.preview_sha256)
    }

    pub fn remove_external_runtime(
        &self,
        port_id: &str,
        authorization_token: &str,
    ) -> Result<ExternalRuntimeRecord> {
        let activity = self.library.begin_activity(
            ActivityOperation::RemoveExternal,
            ActivityTargetKind::Port,
            Some(port_id),
        )?;
        let result = (|| {
            let _lock = self.library.try_lock_port(port_id, "remove-external")?;
            let (record, _) = self
                .library
                .external_runtime_with_port(port_id)?
                .ok_or_else(|| {
                    PortcoveError::not_found("external runtime registration was not found")
                })?;
            let fingerprint = hex::encode(Sha256::digest(serde_json::to_vec(&record)?));
            self.library.consume_authorization(
                authorization_token,
                "remove_external",
                port_id,
                &fingerprint,
            )?;
            self.library.remove_external_runtime(&record)?;
            Ok(record)
        })();
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
        let request_id = Uuid::new_v4().to_string();
        self.supervise_launch_identified(
            IdentifiedLaunchRequest {
                request_id: &request_id,
                port_id,
                source_override,
                arguments,
                stdio,
            },
            |_| {},
            on_started,
        )
    }

    /// Supervises a launch under a caller-known durable request identity.
    /// `on_accepted` runs only after the preparing session is committed, while
    /// `on_started` runs only after the exact child identity is committed.
    pub fn supervise_launch_identified<A, F>(
        &self,
        request: IdentifiedLaunchRequest<'_>,
        on_accepted: A,
        on_started: F,
    ) -> Result<SupervisedLaunchOutcome>
    where
        A: FnOnce(&LaunchSessionRecord),
        F: FnOnce(&LaunchSessionRecord),
    {
        let IdentifiedLaunchRequest {
            request_id,
            port_id,
            source_override,
            arguments,
            stdio,
        } = request;
        let request_id = Uuid::parse_str(request_id)
            .map_err(|_| PortcoveError::usage("launch request ID must be a UUID"))?;
        let _operation = self.library.try_lock_port(port_id, "launch")?;
        let (activity, operation) = self.begin_identified_cancellable_activity(
            request_id,
            ActivityOperation::Launch,
            ActivityTargetKind::Port,
            Some(port_id),
        )?;
        let observed_at = std::time::Instant::now();
        let _ = operation.started();
        let mut session_created = false;
        let mut child_state_uncertain = false;
        let mut legacy_data_seal = None;
        let result = (|| {
            self.require_completed_restore(port_id)?;
            let launch_catalog = self.catalog_for_installed_fallback(port_id)?;
            let port = launch_catalog.port(port_id).ok();
            let active = self
                .library
                .status(
                    port_id,
                    port.map_or(ReleaseChannel::Stable, default_channel),
                )?
                .active;
            let external = self.library.external_runtime_with_port(port_id)?;
            if !arguments.is_empty()
                && active.as_ref().is_some_and(|install| {
                    install.port_id == "ghostship" && install.version == "2.0.0"
                })
            {
                return Err(PortcoveError::usage(
                    "the exact Ghostship 2.0.0 runtime requires zero added arguments",
                ));
            }
            if !arguments.is_empty()
                && let Some(install) = &active
                && !self
                    .installed_catalog(install)?
                    .port(port_id)?
                    .release
                    .managed_build
                    .is_empty()
            {
                return Err(PortcoveError::usage(
                    "this cartridge build recipe does not allow forwarded launch arguments",
                ));
            }
            if !arguments.is_empty()
                && let Some((record, retained_catalog)) = &external
                && record.user_selected.is_none()
                && retained_catalog
                    .port(port_id)?
                    .release
                    .user_prepared
                    .get(&record.platform)
                    .is_some_and(|runtime| {
                        runtime.settings_contract.is_some() || runtime.shared_preferences.is_some()
                    })
            {
                return Err(PortcoveError::usage(
                    "this prepared settings contract does not allow forwarded launch arguments",
                ));
            }
            let (install_id, install_root, owner_kind) = match (&active, &external) {
                (Some(_), Some(_)) => {
                    return Err(PortcoveError::state(
                        "managed installation and external registration both exist for this port",
                    ));
                }
                (Some(install), None) => (
                    install.id.clone(),
                    install.path.clone(),
                    crate::LaunchOwnerKind::Managed,
                ),
                (None, Some((record, _))) => (
                    record.id.clone(),
                    record.path.clone(),
                    crate::LaunchOwnerKind::External,
                ),
                (None, None) => {
                    return Err(PortcoveError::not_found(format!(
                        "{port_id} has no installed or registered runtime"
                    )));
                }
            };
            let supervisor_identity = crate::launch::process_identity(std::process::id())?
                .ok_or_else(|| PortcoveError::state("launch supervisor identity disappeared"))?;
            let now = Library::now();
            let mut session = LaunchSessionRecord {
                id: activity.id.clone(),
                port_id: port_id.to_owned(),
                install_id,
                install_root: install_root.clone(),
                owner_kind,
                supervisor_pid: std::process::id(),
                supervisor_identity: Some(supervisor_identity),
                child_pid: None,
                child_identity: None,
                phase: LaunchSessionPhase::Preparing,
                outcome: None,
                exit_code: None,
                message: None,
                started_at: now,
                updated_at: now,
                finished_at: None,
            };
            self.library.create_launch_session(&session)?;
            session_created = true;
            if let Some(install) = &active {
                operation.observe_release(&install.version, Some(&install.id));
            }
            tracing::debug!(
                component = "launch",
                observation = "launch_session",
                phase = "accepted",
                activity_id = activity.id.as_str(),
                operation_id = activity.id.as_str(),
                port_id,
                activity_recorded = true
            );
            on_accepted(&session);

            operation.checkpoint()?;
            let spec = match (&active, &external) {
                (Some(install), None) => self.prepare_launch_for_install(
                    port.ok_or_else(|| {
                        PortcoveError::state("managed launch has no retained definition")
                    })?,
                    install,
                    source_override,
                    Some(&operation),
                )?,
                (None, Some((record, retained_catalog))) => self.prepare_launch_for_external(
                    record,
                    retained_catalog,
                    source_override,
                    &operation,
                )?,
                _ => unreachable!("runtime ownership was checked above"),
            };
            if spec.install_root != install_root {
                return Err(PortcoveError::state(format!(
                    "the prepared {port_id} launch changed its registered install identity"
                )));
            }
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
            operation.checkpoint()?;
            if let Some((record, retained_catalog)) = external.as_ref() {
                if record.user_selected.is_some() {
                    self.check_user_selected_retained_runtime(record, retained_catalog)?;
                } else {
                    let accepted = retained_catalog
                        .port(&record.port_id)?
                        .release
                        .user_prepared
                        .get(&record.platform)
                        .ok_or_else(|| {
                            PortcoveError::verification(
                                "retained external runtime has no platform contract",
                            )
                        })?;
                    if accepted.trust == crate::ExternalRuntimeTrust::UserSelected {
                        self.check_user_selected_runtime_record(record, accepted)?;
                    } else {
                        let inspected = crate::external_runtime::inspect_with_checkpoint(
                            &record.path,
                            accepted,
                            self.library.root(),
                            &|| operation.checkpoint(),
                        )?;
                        if inspected.root != spec.install_root
                            || inspected.executable != spec.executable
                        {
                            return Err(PortcoveError::verification(
                                "external runtime changed before launch",
                            ));
                        }
                    }
                }
            }
            operation.begin_publication()?;
            self.library.update_launch_session(
                &session.id,
                None,
                None,
                LaunchSessionPhase::Spawning,
            )?;
            session.phase = LaunchSessionPhase::Spawning;
            session.updated_at = Library::now();
            self.faults.check(LifecycleFaultPoint::LaunchReadyToSpawn)?;
            // Admission uses immediate transactions too. Keep the final read
            // and child creation in one writer exclusion interval; a hold is
            // ordered either before this launch or after child creation.
            // Release it before publishing subsequent session database writes.
            let mut spawn = || {
                if let Some((record, retained_catalog)) = external.as_ref() {
                    if record.user_selected.is_some() {
                        self.check_user_selected_retained_runtime(record, retained_catalog)?;
                    } else {
                        crate::runtime_path_policy::check_prepared_launch(
                            retained_catalog.port(&record.port_id)?,
                            record.platform,
                            &spec.executable,
                            &spec.working_directory,
                            &spec.arguments,
                        )?;
                        let accepted = retained_catalog
                            .port(&record.port_id)?
                            .release
                            .user_prepared
                            .get(&record.platform)
                            .ok_or_else(|| {
                                PortcoveError::verification(
                                    "retained external runtime has no platform contract",
                                )
                            })?;
                        if accepted.trust == crate::ExternalRuntimeTrust::UserSelected {
                            self.check_user_selected_runtime_record(record, accepted)?;
                        } else {
                            crate::external_runtime::shared_preferences::check_record(
                                record, accepted,
                            )?;
                            crate::external_runtime::shared_preferences::require_original(
                                record, accepted,
                            )?;
                        }
                    }
                }
                if let Some(install) = active.as_ref() {
                    Installer::new(self.library.clone())?.require_curated_operation(
                        install,
                        crate::definition_repository::publisher_policy::CuratedArtifactOperation::LocalUse,
                    )?;
                    let retained_catalog = self.installed_catalog(install)?;
                    let retained_port = retained_catalog.port(&install.port_id)?;
                    crate::native_temp::recheck(retained_port, &spec)?;
                    self.require_installed_shared_preferences(install)?;
                    if retained_port.managed_shared_preferences.is_some()
                        && (spec.arguments != retained_port.launch_arguments
                            || spec.working_directory != install.path)
                    {
                        return Err(PortcoveError::verification(
                            "managed ReGaiden requires its reviewed fixed launch and installation folder",
                        ));
                    }
                    crate::managed_tfe::check(retained_port, &spec.working_directory, &|| {
                        operation.checkpoint()
                    })?;
                    crate::runtime_data_policy::check_launch(
                        retained_port,
                        &spec.working_directory,
                        &self.library.user_dir(&install.port_id),
                        &spec.arguments,
                    )?;
                    if retained_port.managed_initialization.is_some() && !spec.arguments.is_empty()
                    {
                        return Err(PortcoveError::verification(
                            "managed TFE requires its fixed no-argument launch",
                        ));
                    }
                    if install.port_id == "ghostship" && install.version == "2.0.0" {
                        self.require_ghostship_legacy_runtime_archive(
                            install,
                            &spec.working_directory,
                        )?;
                        if !spec.arguments.is_empty() {
                            return Err(PortcoveError::conflict(
                                "prepared legacy archive or zero-argument launch changed before spawning",
                            ));
                        }
                    }
                    self.require_definition_operation(
                        &retained_catalog,
                        retained_port,
                        self.managed_launch_context(
                            retained_catalog.definition_selection(&install.port_id),
                            install,
                        )?,
                    )?;
                }
                Ok(match command.spawn() {
                    Ok(child) => child,
                    Err(error) => {
                        return Err(PortcoveError::launch(format!(
                            "failed to start {}: {error}",
                            spec.executable.display()
                        )));
                    }
                })
            };
            let mut child = if active.is_some() {
                crate::definition_repository::publisher_policy::launch_assessment::with_launch_admission(
                    &self.library, spawn,
                )?
            } else {
                spawn()?
            };
            let child_pid = child.id();
            #[cfg(test)]
            crate::launch::child_diagnostic::spawned(&mut child);
            let observed_identity = crate::launch::process_identity_for_child(&child);
            #[cfg(test)]
            let observed_identity =
                crate::launch::child_diagnostic::identity(child_pid, observed_identity);
            let child_identity = match observed_identity {
                Ok(identity) => identity,
                Err(error) => {
                    #[cfg(test)]
                    crate::launch::child_diagnostic::cleanup(&mut child);
                    #[cfg(not(test))]
                    {
                        let _ = child.kill();
                        let _ = child.wait();
                    }
                    return Err(error);
                }
            };
            let (status, mut first_error) = if let Some(child_identity) = child_identity {
                if let Err(error) = self.library.update_launch_session(
                    &session.id,
                    Some(child_pid),
                    Some(&child_identity),
                    LaunchSessionPhase::Running,
                ) {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(error);
                }
                session.child_pid = Some(child_pid);
                session.child_identity = Some(child_identity);
                session.phase = LaunchSessionPhase::Running;
                session.updated_at = Library::now();
                tracing::debug!(
                    component = "launch",
                    observation = "launch_session",
                    phase = "running",
                    activity_id = activity.id.as_str(),
                    operation_id = activity.id.as_str(),
                    port_id,
                    activity_recorded = true,
                    elapsed_ms = observed_at.elapsed().as_millis().min(u128::from(u64::MAX)) as u64
                );
                child_state_uncertain = true;
                self.faults.check(LifecycleFaultPoint::LaunchChildStarted)?;

                let first_error = if owner_kind == crate::LaunchOwnerKind::Managed {
                    fs::write(spec.install_root.join(LAUNCH_MARKER), b"1")
                        .err()
                        .map(PortcoveError::from)
                } else {
                    None
                };
                on_started(&session);

                let observed_wait = child.wait();
                #[cfg(test)]
                crate::launch::child_diagnostic::waited(child_pid, "running_wait", &observed_wait);
                let status = match observed_wait {
                    Ok(status) => status,
                    Err(error) => {
                        return Err(PortcoveError::launch(format!(
                            "could not observe launched process {child_pid}: {error}"
                        )));
                    }
                };
                (status, first_error)
            } else {
                let observed_wait = child.try_wait();
                #[cfg(test)]
                let observed_wait =
                    crate::launch::child_diagnostic::tried_wait(child_pid, observed_wait);
                let status = match observed_wait {
                    Ok(Some(status)) => status,
                    Ok(None) => {
                        #[cfg(test)]
                        crate::launch::child_diagnostic::cleanup(&mut child);
                        #[cfg(not(test))]
                        {
                            let _ = child.kill();
                            let _ = child.wait();
                        }
                        return Err(PortcoveError::state(format!(
                            "child process {child_pid} was still running after its start identity disappeared"
                        )));
                    }
                    Err(error) => {
                        return Err(PortcoveError::launch(format!(
                            "could not observe launched process {child_pid}: {error}"
                        )));
                    }
                };
                self.library.update_launch_session(
                    &session.id,
                    Some(child_pid),
                    None,
                    LaunchSessionPhase::Collecting,
                )?;
                session.child_pid = Some(child_pid);
                session.phase = LaunchSessionPhase::Collecting;
                session.updated_at = Library::now();
                child_state_uncertain = true;
                let first_error = if owner_kind == crate::LaunchOwnerKind::Managed {
                    fs::write(spec.install_root.join(LAUNCH_MARKER), b"1")
                        .err()
                        .map(PortcoveError::from)
                } else {
                    None
                };
                (status, first_error)
            };
            if session.phase != LaunchSessionPhase::Collecting {
                if let Err(error) = self.library.update_launch_session(
                    &session.id,
                    None,
                    None,
                    LaunchSessionPhase::Collecting,
                ) && first_error.is_none()
                {
                    first_error = Some(error);
                }
                session.phase = LaunchSessionPhase::Collecting;
                session.updated_at = Library::now();
            }
            self.faults.check(LifecycleFaultPoint::LaunchCollecting)?;
            if status.success()
                && let Err(error) = self.library.record_successful_launch(port_id)
                && first_error.is_none()
            {
                first_error = Some(error);
            }
            if owner_kind == crate::LaunchOwnerKind::Managed {
                let collected = self
                    .collect_user_data_from_install_already_locked(port_id, &session.install_root);
                if let Err(error) = collected
                    && first_error.is_none()
                {
                    first_error = Some(error);
                }
            }

            if let Some(error) = first_error {
                Err(error)
            } else {
                if status.success() && owner_kind == crate::LaunchOwnerKind::Managed {
                    legacy_data_seal = self.qualify_legacy_consumption(&session)?;
                }
                child_state_uncertain = false;
                Ok(SupervisedLaunchOutcome {
                    session_id: session.id,
                    child_pid,
                    exit_code: status.code(),
                    successful: status.success(),
                })
            }
        })();
        if session_created && child_state_uncertain {
            // An uncertain child or collection state must remain durable and
            // keep the activity running for explicit stale-session recovery.
            tracing::debug!(
                component = "launch",
                observation = "launch_session",
                phase = "returned",
                activity_id = activity.id.as_str(),
                operation_id = activity.id.as_str(),
                port_id,
                observed_result = "unknown",
                activity_recorded = false,
                error_code = result
                    .as_ref()
                    .err()
                    .map(|error| crate::runtime_diagnostics::code_label(error.code)),
                elapsed_ms = observed_at.elapsed().as_millis().min(u128::from(u64::MAX)) as u64
            );
            return result;
        }
        if session_created {
            let (outcome, exit_code, message) = match &result {
                Ok(value) if value.successful => {
                    (LaunchSessionOutcome::Succeeded, value.exit_code, None)
                }
                Ok(value) => (
                    LaunchSessionOutcome::Failed,
                    value.exit_code,
                    Some("the game process did not exit successfully"),
                ),
                Err(error) if error.code == crate::ErrorCode::Cancelled => (
                    LaunchSessionOutcome::Cancelled,
                    None,
                    Some(error.message.as_str()),
                ),
                Err(error) => (
                    LaunchSessionOutcome::Failed,
                    None,
                    Some(error.message.as_str()),
                ),
            };
            if let Err(error) = self.library.finish_launch_session_with_legacy_seal(
                &activity.id,
                outcome,
                exit_code,
                message,
                legacy_data_seal.as_ref(),
            ) {
                tracing::debug!(
                    component = "launch",
                    observation = "launch_session",
                    phase = "returned",
                    activity_id = activity.id.as_str(),
                    operation_id = activity.id.as_str(),
                    port_id,
                    observed_result = "unknown",
                    activity_recorded = false,
                    error_code = crate::runtime_diagnostics::code_label(error.code),
                    elapsed_ms = observed_at.elapsed().as_millis().min(u128::from(u64::MAX)) as u64
                );
                return result.and(Err(error));
            }
            let observed_result = match outcome {
                LaunchSessionOutcome::Succeeded => "succeeded",
                LaunchSessionOutcome::Failed => "failed",
                LaunchSessionOutcome::Cancelled => "cancelled",
            };
            tracing::debug!(
                component = "launch",
                observation = "launch_session",
                phase = "finished",
                activity_id = activity.id.as_str(),
                operation_id = activity.id.as_str(),
                port_id,
                observed_result,
                activity_recorded = true,
                exit_code = exit_code.map(i64::from),
                error_code = result
                    .as_ref()
                    .err()
                    .map(|error| crate::runtime_diagnostics::code_label(error.code)),
                elapsed_ms = observed_at.elapsed().as_millis().min(u128::from(u64::MAX)) as u64
            );
        } else {
            return self.finish_activity(activity, result);
        }
        result
    }

    pub fn stale_launch_sessions(&self) -> Result<Vec<LaunchSessionRecord>> {
        let mut stale = Vec::new();
        for session in self.library.launch_sessions()? {
            let live = match session.supervisor_identity.as_deref() {
                Some(identity) => crate::launch::process_matches(session.supervisor_pid, identity)?,
                None => false,
            };
            if !live {
                stale.push(session);
            }
        }
        Ok(stale)
    }

    /// Recovers a launch whose supervisor no longer exists. The exact recorded
    /// install remains locked until its child exits and collection completes.
    pub fn recover_launch_session(&self, session_id: &str) -> Result<()> {
        let session = self
            .library
            .active_launch_session(session_id)?
            .ok_or_else(|| {
                PortcoveError::not_found(format!("launch session {session_id} was not found"))
            })?;
        if let Some(identity) = session.supervisor_identity.as_deref()
            && crate::launch::process_matches(session.supervisor_pid, identity)?
        {
            return Err(PortcoveError::conflict(format!(
                "launch session {session_id} still has a live supervisor"
            ))
            .detail("supervisor_pid", session.supervisor_pid.to_string()));
        }
        let _operation = self
            .library
            .try_lock_port_for_launch_recovery(&session.port_id, session_id)?;
        let session = self
            .library
            .active_launch_session(session_id)?
            .ok_or_else(|| {
                PortcoveError::not_found(format!(
                    "launch session {session_id} was recovered elsewhere"
                ))
            })?;
        let install_is_exact = match session.owner_kind {
            crate::LaunchOwnerKind::Managed => {
                self.library.all_installs()?.into_iter().any(|install| {
                    install.id == session.install_id
                        && install.port_id == session.port_id
                        && install.path == session.install_root
                })
            }
            crate::LaunchOwnerKind::External => self
                .library
                .external_runtime_with_port(&session.port_id)?
                .is_some_and(|(record, _)| {
                    record.id == session.install_id && record.path == session.install_root
                }),
        };
        if !install_is_exact {
            return Err(PortcoveError::conflict(format!(
                "launch session {session_id} no longer matches its registered install"
            ))
            .detail("install_id", &session.install_id)
            .detail("install_root", session.install_root.display().to_string()));
        }
        if session.phase == LaunchSessionPhase::Preparing {
            let cancelled = crate::cancellation::cancellation_state(&self.library, session_id)?
                .is_some_and(|state| state.requested);
            return self.library.finish_launch_session(
                session_id,
                if cancelled {
                    LaunchSessionOutcome::Cancelled
                } else {
                    LaunchSessionOutcome::Failed
                },
                None,
                Some(if cancelled {
                    "launch preparation was cancelled and recovered after supervisor exit"
                } else {
                    "launch supervisor exited before the child process started"
                }),
            );
        }
        if session.phase == LaunchSessionPhase::Spawning {
            return Err(PortcoveError::conflict(format!(
                "launch session {session_id} stopped while child creation was in progress"
            ))
            .detail("launch_session_id", session_id)
            .detail("recovery_action", "manual_review"));
        }
        if matches!(
            session.phase,
            LaunchSessionPhase::Running | LaunchSessionPhase::Recovering
        ) {
            let child_pid = session.child_pid.ok_or_else(|| {
                PortcoveError::conflict("a running launch recovery has no recorded child process")
                    .detail("launch_session_id", session_id)
                    .detail("recovery_action", "manual_review")
            })?;
            let child_identity = session.child_identity.as_deref().ok_or_else(|| {
                PortcoveError::conflict(
                    "the recorded child predates process-start identity and cannot be recovered automatically",
                )
                .detail("launch_session_id", session_id)
                .detail("process_id", child_pid.to_string())
                .detail("recovery_action", "manual_review")
            })?;
            crate::launch::wait_for_process_exit(child_pid, child_identity)?;
            self.library.update_launch_session(
                session_id,
                None,
                None,
                LaunchSessionPhase::Collecting,
            )?;
        }
        if session.owner_kind == crate::LaunchOwnerKind::Managed {
            self.collect_user_data_from_install_already_locked(
                &session.port_id,
                &session.install_root,
            )?;
        }
        self.library.finish_launch_session(
            session_id,
            LaunchSessionOutcome::Failed,
            None,
            Some("launch supervisor exited; the recorded session was recovered"),
        )
    }

    #[cfg(test)]
    pub(crate) fn prepare_launch(
        &self,
        port_id: &str,
        source_override: Option<&Path>,
    ) -> Result<crate::LaunchSpec> {
        self.require_completed_restore(port_id)?;
        let port = self.catalog.port(port_id)?;
        let active = self
            .status(port_id)?
            .active
            .ok_or_else(|| PortcoveError::not_found(format!("{port_id} is not installed")))?;
        self.prepare_launch_for_install(port, &active, source_override, None)
    }

    fn prepare_launch_for_external(
        &self,
        record: &ExternalRuntimeRecord,
        retained_catalog: &Catalog,
        source_override: Option<&Path>,
        operation: &OperationCoordinator,
    ) -> Result<crate::LaunchSpec> {
        if let Some(user_selected) = &record.user_selected {
            if source_override.is_some() {
                return Err(PortcoveError::usage(
                    "user-managed setup supplies its own original files; source overrides are not offered",
                ));
            }
            self.check_user_selected_retained_runtime(record, retained_catalog)?;
            self.require_definition_identity(
                record.retained_definition.as_ref(),
                DefinitionOperationContext::observed(DefinitionOperation::Launch, true, true),
            )?;
            operation.checkpoint()?;
            return Ok(crate::LaunchSpec {
                executable: record.executable.clone(),
                install_root: record.path.clone(),
                working_directory: record.path.clone(),
                environment: std::collections::BTreeMap::new(),
                arguments: user_selected.arguments.clone(),
                fixed_arguments_only: true,
                launch_kind: crate::LaunchKind::Native,
            });
        }
        let retained_port = retained_catalog.port(&record.port_id)?;
        let platform = Platform::current()?;
        if record.port_id != retained_port.id
            || record.platform != platform
            || retained_port.release.provider != ReleaseSource::UserPrepared
        {
            return Err(PortcoveError::verification(
                "external runtime retained contract does not match the current platform",
            ));
        }
        let spec = retained_port
            .release
            .user_prepared
            .get(&platform)
            .ok_or_else(|| {
                PortcoveError::verification("retained external runtime has no platform contract")
            })?;
        if record.version != spec.version
            || !record
                .archive_sha256
                .eq_ignore_ascii_case(&spec.archive_sha256)
            || !record
                .immutable_tree_sha256
                .eq_ignore_ascii_case(&spec.immutable_tree_sha256)
        {
            return Err(PortcoveError::verification(
                "external runtime record differs from its retained accepted identity",
            ));
        }
        crate::external_runtime::shared_preferences::check_record(record, spec)?;
        crate::external_runtime::shared_preferences::require_original(record, spec)?;
        let inspected = crate::external_runtime::inspect_with_checkpoint(
            &record.path,
            spec,
            self.library.root(),
            &|| operation.checkpoint(),
        )?;
        if inspected.root != record.path || inspected.executable != record.executable {
            return Err(PortcoveError::verification(
                "external runtime path changed since registration",
            ));
        }
        Self::check_external_runtime_paths(
            retained_port,
            platform,
            &inspected.root,
            &inspected.executable,
        )?;
        self.require_definition_identity(
            record.retained_definition.as_ref(),
            DefinitionOperationContext::observed(DefinitionOperation::Launch, true, true),
        )?;
        let mut arguments = Vec::new();
        let mut source_directory = None;
        if let Some(profile_id) = retained_port.source_profile.as_deref() {
            let source = if let Some(path) = source_override {
                crate::source_inspection::inspect_with_checkpoint(
                    retained_catalog,
                    profile_id,
                    path,
                    &|| operation.checkpoint(),
                )?
                .require_admitted_record()?
            } else {
                self.verified_source_record_with_checkpoint(retained_catalog, profile_id, &|| {
                    operation.checkpoint()
                })?
            };
            crate::source_inspection::require_launch_source_compatibility(
                retained_catalog,
                &retained_port.id,
                &source,
                crate::PortSourceRole::Game,
                (&record.version, &record.archive_sha256),
            )?;
            if let Some(extension) = spec.source_argument_extension.as_deref() {
                crate::runtime_path_policy::check_prepared_path(
                    retained_port,
                    platform,
                    &source.path,
                )?;
                crate::external_runtime::shared_preferences::check_runtime_path(
                    spec,
                    &source.path,
                )?;
                if !source_path_has_extension(&source.path, extension) {
                    return Err(PortcoveError::source(format!(
                        "{} requires an uncompressed .{extension} original source",
                        retained_port.name
                    )));
                }
                if spec.shared_preferences
                    == Some(crate::PreparedSharedPreferencesContract::Regaiden041Windows)
                {
                    arguments.push("--rom".into());
                }
                arguments.push(crate::path::unicode(
                    &source.path,
                    "external launch source",
                )?);
            }
            if spec.source_directory_environment {
                require_prepared_source_directory(&source.path)?;
                crate::runtime_path_policy::check_prepared_path(
                    retained_port,
                    platform,
                    &source.path,
                )?;
                source_directory = Some(crate::path::unicode(
                    &source.path,
                    "external source directory",
                )?);
            }
            Self::verify_source_record_with_checkpoint(retained_catalog, &source, &|| {
                operation.checkpoint()
            })?;
        } else if source_override.is_some() {
            return Err(PortcoveError::usage(
                "this external runtime does not accept a source override",
            ));
        }
        arguments.extend(retained_port.launch_arguments.iter().cloned());
        let launch_kind = crate::LaunchKind::for_executable(&record.executable);
        if launch_kind != crate::LaunchKind::Native {
            return Err(PortcoveError::unsupported(
                "user-prepared runtime launch requires a native executable",
            ));
        }
        operation.checkpoint()?;
        let working_directory = if retained_port.runtime_subdirectory.is_some() {
            crate::adapter::launch_working_directory(
                retained_port.adapter,
                retained_port,
                &record.path,
                &record.executable,
            )?
        } else {
            record.path.clone()
        };
        crate::runtime_path_policy::check_prepared_launch(
            retained_port,
            platform,
            &record.executable,
            &working_directory,
            &arguments,
        )?;
        let mut environment = retained_port.launch_environment.clone();
        if let Some(directory) = source_directory {
            let variable = retained_port.source_environment.as_ref().ok_or_else(|| {
                PortcoveError::verification("prepared source directory has no retained binding")
            })?;
            environment.insert(variable.clone(), directory);
        }
        if spec.library_user_data {
            let variable = retained_port
                .user_data_environment
                .as_ref()
                .ok_or_else(|| {
                    PortcoveError::verification(
                        "prepared private user data has no retained binding",
                    )
                })?;
            let directory = self
                .library
                .prepare_user_directory(&record.port_id, &|| operation.checkpoint())?;
            environment.insert(
                variable.clone(),
                crate::path::unicode(&directory, "private user data")?,
            );
        }
        operation.checkpoint()?;
        Ok(crate::LaunchSpec {
            fixed_arguments_only: spec.shared_preferences
                == Some(crate::PreparedSharedPreferencesContract::Smb1r11Windows)
                || retained_port.windows_runtime_path_policy.is_some()
                || spec.source_directory_environment,
            executable: record.executable.clone(),
            install_root: record.path.clone(),
            working_directory,
            environment,
            arguments,
            launch_kind,
        })
    }

    fn refresh_upstream_setup_manifest(
        &self,
        port: &PortDefinition,
        active: &InstallRecord,
        working_directory: &Path,
    ) -> Result<()> {
        if port.adapter != crate::AdapterKind::UpstreamManagedSetup
            || !crate::adapter::upstream_setup_manifest_needs_refresh(
                working_directory,
                &active.manifest_sha256,
            )?
        {
            return Ok(());
        }
        let manifest_path = active.path.join(".portcove-manifest.json");
        let previous_manifest = fs::read(&manifest_path)?;
        let installer = Installer::new(self.library.clone())?;
        let retained = installer.retained_catalog(active)?;
        let qualification = InstallQualification::from_catalog(
            retained.as_ref().unwrap_or(&self.catalog),
            &port.id,
            Platform::current()?,
        )?;
        let refreshed = installer.refresh_verified_manifest(active, &qualification)?;
        if let Err(error) = installer.verify_critical(&refreshed, &qualification) {
            return restore_setup_manifest(&manifest_path, &previous_manifest, active, error);
        }
        if let Err(error) = self.library.update_install_manifest(&refreshed) {
            return restore_setup_manifest(&manifest_path, &previous_manifest, active, error);
        }
        crate::adapter::bind_upstream_setup_manifest(
            working_directory,
            &refreshed.manifest_sha256,
        )?;
        Ok(())
    }

    pub fn collect_user_data(&self, port_id: &str) -> Result<Vec<PathBuf>> {
        let _operation = self.library.try_lock_port(port_id, "collect-user-data")?;
        let active = self
            .status(port_id)?
            .active
            .ok_or_else(|| PortcoveError::not_found(format!("{port_id} is not installed")))?;
        let port = self.installed_mutability_port(&active)?;
        self.collect_user_data_from(&port, &active.path)
    }

    pub(crate) fn collect_active_user_data_if_launched(
        &self,
        port_id: &str,
    ) -> Result<Vec<PathBuf>> {
        let Some(active) = self.collectible_active_install(port_id)? else {
            return Ok(Vec::new());
        };
        let port = self.installed_mutability_port(&active)?;
        self.collect_user_data_from(&port, &active.path)
    }

    /// Read-only selection shared by collection and destructive-action review.
    fn collectible_active_install(&self, port_id: &str) -> Result<Option<InstallRecord>> {
        let Some(active) = self.status_without_rollback_assessment(port_id)?.active else {
            return Ok(None);
        };
        self.require_generated_cache_install_unchanged(&active)?;
        if !active.path.join(LAUNCH_MARKER).is_file() {
            // Preserve the historical unlaunched path for deeper integrations.
            // Only verified retained ready-archive/PS1 contracts collect before launch;
            // today's catalog cannot silently grant that ownership to a legacy row.
            let retained = self
                .managed_install_root(port_id, &active.path)
                .and_then(|_| Installer::new(self.library.clone())?.retained_catalog(&active));
            let requires_retained_data = self
                .catalog
                .port(port_id)
                .is_ok_and(crate::persistence::collect_before_first_launch);
            match retained {
                Ok(Some(catalog)) => {
                    if !crate::persistence::collect_before_first_launch(catalog.port(port_id)?) {
                        return Ok(None);
                    }
                }
                Ok(None) if requires_retained_data => {
                    return Err(PortcoveError::verification(
                        "Managed player data cannot be collected without its retained installation contract. Preserve the installation and review its current state.",
                    ));
                }
                Err(error) if requires_retained_data => return Err(error),
                _ => return Ok(None),
            }
        }
        self.require_portable_runtime_unchanged(&active)?;
        Ok(Some(active))
    }

    /// Collect from the exact registered installation under exclusive port ownership.
    /// A live supervised session also refuses this public operation.
    pub fn collect_user_data_from_install(
        &self,
        port_id: &str,
        install_root: &Path,
    ) -> Result<Vec<PathBuf>> {
        let _operation = self.library.try_lock_port(port_id, "collect-user-data")?;
        self.collect_user_data_from_install_already_locked(port_id, install_root)
    }

    /// The supervised launch/recovery owner holds the port lock across this call.
    /// Keep this private so public callers cannot bypass operation exclusion.
    fn collect_user_data_from_install_already_locked(
        &self,
        port_id: &str,
        install_root: &Path,
    ) -> Result<Vec<PathBuf>> {
        let install_root = self.managed_install_root(port_id, install_root)?;
        let catalog = self.catalog_for_installed_fallback(port_id)?;
        let port = catalog.port(port_id)?;
        self.collect_user_data_from(port, &install_root)
    }

    fn managed_install_root(&self, port_id: &str, install_root: &Path) -> Result<PathBuf> {
        crate::output_root::validate_install_path(&self.library, port_id, install_root)
    }

    pub(crate) fn installed_port(&self, install: &InstallRecord) -> Result<PortDefinition> {
        Ok(self
            .installed_catalog(install)?
            .port(&install.port_id)?
            .clone())
    }

    /// Admit only checked additive mutable paths from current catalog facts or
    /// a closed runtime compatibility interpretation. Retained source/launch
    /// authority and every recorded immutable byte remain unchanged.
    fn installed_mutability_port(&self, install: &InstallRecord) -> Result<PortDefinition> {
        self.installed_mutability_port_for_platform(install, Platform::current()?)
    }

    fn installed_mutability_port_for_platform(
        &self,
        install: &InstallRecord,
        platform: Platform,
    ) -> Result<PortDefinition> {
        let retained = self.installed_port(install)?;
        // New declarations cannot enroll populated generated output from an older runtime.
        if retained.adapter == AdapterKind::GeneratedCache {
            return Ok(retained);
        }
        let Ok(current) = self.catalog.port(&install.port_id) else {
            return Ok(retained);
        };
        crate::installed_mutability::checked_port(
            &Installer::new(self.library.clone())?,
            install,
            &retained,
            current,
            platform,
        )
    }

    pub(crate) fn installed_mutability_qualification(
        &self,
        install: &InstallRecord,
    ) -> Result<InstallQualification> {
        self.installed_mutability_qualification_for_platform(install, Platform::current()?)
    }

    pub(crate) fn installed_mutability_qualification_for_platform(
        &self,
        install: &InstallRecord,
        platform: Platform,
    ) -> Result<InstallQualification> {
        InstallQualification::from_port(
            &self.installed_mutability_port_for_platform(install, platform)?,
            platform,
        )
    }

    pub(crate) fn installed_catalog(&self, install: &InstallRecord) -> Result<Catalog> {
        self.managed_install_root(&install.port_id, &install.path)?;
        match Installer::new(self.library.clone())?.retained_catalog(install)? {
            Some(catalog) => Ok(catalog),
            None => {
                if self.catalog.port(&install.port_id).is_ok_and(|current| {
                    current.runtime_data_policy.is_some()
                        || current.managed_shared_preferences.is_some()
                        || current.n64_runtime_at_executable_parent
                }) {
                    return Err(PortcoveError::verification(
                        "legacy installation cannot inherit today's runtime-coordinate, credential or shared-preferences policy; retain its original route or review a fresh managed installation",
                    ));
                }
                Ok(self.catalog.clone())
            }
        }
    }

    fn persistence_contract_for_install(
        &self,
        install: &InstallRecord,
    ) -> Result<PersistenceContract> {
        let retained_catalog = Installer::new(self.library.clone())?.retained_catalog(install)?;
        let retained = self.installed_port(install)?;
        if retained.adapter == AdapterKind::GeneratedCache {
            self.require_portable_runtime_unchanged(install)?;
        }
        let port = self.installed_mutability_port(install)?;
        if crate::persistence::requires_restore_receipt(&retained)
            && (retained_catalog.is_none()
                || retained.persistent_paths != port.persistent_paths
                || retained.persistent_file_patterns != port.persistent_file_patterns)
        {
            return Err(PortcoveError::conflict(
                "Portcove cannot verify which player-data paths were synchronized for this installed copy. Preserve both copies and review a supported data transition before synchronizing them.",
            )
            .detail("install_id", &install.id)
            .detail("directory", install.path.display().to_string())
            .detail("retained_paths", if retained_catalog.is_some() { serde_json::to_string(&retained.persistent_paths)? } else { "unknown (no retained contract)".into() })
            .detail("proposed_paths", serde_json::to_string(&port.persistent_paths)?)
            .with_known_cause(crate::failure::KnownFailureCause::PortableDataContractChanged));
        }
        let legacy = Installer::new(self.library.clone())?.retained_preparation_mode(install)?
            == Some(crate::PreparationMode::Ghostship200Legacy);
        let writes_directly = if legacy {
            // This interpretation is retained separately from catalog facts.
            // The pinned Windows runtime ignores SHIP_HOME and uses its CWD.
            crate::preparation::legacy_execution_contract(&port, install, Platform::current()?)?;
            false
        } else if shipwright_windows_cwd_persistence(&port, install, Platform::current()?) {
            // The verified portable Windows payload ignores SHIP_HOME. Keep
            // this closed compatibility interpretation outside catalog facts.
            // Assessment and mutation share the same non-writing shape check.
            for root in [
                self.persistence_root(&port, &install.path)?,
                self.library.user_dir(&port.id),
            ] {
                let saves = root.join("Save");
                refuse_symlink_ancestors(&saves)?;
                match fs::symlink_metadata(&saves) {
                    Ok(metadata) if !metadata.is_dir() => {
                        return Err(PortcoveError::conflict(format!(
                            "Shipwright Save root is not a directory; preserve it and review the conflict: {}",
                            saves.display()
                        )));
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error.into()),
                    Ok(_) => {}
                }
            }
            false
        } else {
            writes_directly_to_user_root(&port)
        };
        Ok(PersistenceContract {
            port,
            writes_directly,
        })
    }

    fn persistence_contract(
        &self,
        fallback: &PortDefinition,
        install_root: &Path,
    ) -> Result<PersistenceContract> {
        let root = self.managed_install_root(&fallback.id, install_root)?;
        for install in self.library.all_installs()? {
            if install.port_id != fallback.id {
                continue;
            }
            refuse_symlink_ancestors(&install.path)?;
            let registered = match fs::canonicalize(&install.path) {
                Ok(path) => path,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error.into()),
            };
            if registered == root {
                return self.persistence_contract_for_install(&install);
            }
        }
        if fallback.adapter == AdapterKind::GeneratedCache {
            return Err(PortcoveError::verification(
                "Generated-cache synchronization requires an identified retained installation; preserve its runtime and data for review",
            ));
        }
        // An unpublished payload has no library record yet. Its caller owns
        // the qualification captured for that installation operation.
        Ok(PersistenceContract {
            port: fallback.clone(),
            writes_directly: writes_directly_to_user_root(fallback),
        })
    }

    fn retained_persistence_contracts(
        &self,
        port_id: &str,
    ) -> Result<Vec<(PathBuf, PersistenceContract)>> {
        let fallback = self.catalog.port(port_id)?;
        let mut contracts = Vec::new();
        for path in self.library.port_install_paths(port_id)? {
            refuse_symlink_ancestors(&path)?;
            match fs::symlink_metadata(&path) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                result => {
                    result?;
                }
            }
            let install_root = self.managed_install_root(port_id, &path)?;
            let contract = self.persistence_contract(fallback, &install_root)?;
            contracts.push((install_root, contract));
        }
        Ok(contracts)
    }

    fn require_completed_restore(&self, port_id: &str) -> Result<()> {
        if OperationStore::new(self.library.clone())
            .all()?
            .iter()
            .any(|operation| {
                operation.port_id == port_id
                    && operation.kind == LifecycleOperationKind::Restore
                    && operation.phase != LifecyclePhase::Preparing
            })
        {
            return Err(PortcoveError::conflict(format!(
                "{port_id} has an unfinished backup restore; complete recovery before launch or save collection"
            )).with_known_cause(crate::failure::KnownFailureCause::RestoreRecovery));
        }
        Ok(())
    }

    fn require_completed_backup_deletion(&self, port_id: &str) -> Result<()> {
        if OperationStore::new(self.library.clone())
            .all()?
            .iter()
            .any(|operation| {
                operation.port_id == port_id
                    && operation.kind == LifecycleOperationKind::DeleteBackup
            })
        {
            return Err(PortcoveError::conflict(format!(
                "{port_id} has an unfinished backup deletion; restart Portcove to retry recovery and review doctor output if it remains"
            ))
            .with_known_cause(crate::failure::KnownFailureCause::BackupDeletionRecovery)
            .detail("recovery_action", "restart_then_doctor"));
        }
        Ok(())
    }

    pub(crate) fn validate_backup_deletion_operation(
        &self,
        operation: &LifecycleOperation,
    ) -> Result<backups::BackupDeletionOperation> {
        backups::BackupDeletionOperation::validate_envelope(operation)?;
        self.catalog.port(&operation.port_id)?;
        let expected_parent = self.library.backups_dir().join(&operation.port_id);
        refuse_symlink_ancestors(&expected_parent)?;
        let original = operation.paths.final_path.clone().ok_or_else(|| {
            PortcoveError::state("recoverable backup deletion is missing its original path")
        })?;
        let quarantine = operation.paths.quarantine.clone().ok_or_else(|| {
            PortcoveError::state("recoverable backup deletion is missing its quarantine path")
        })?;
        if original.parent() != Some(expected_parent.as_path())
            || quarantine.parent() != Some(expected_parent.as_path())
        {
            return Err(PortcoveError::conflict(
                "backup deletion paths are outside the registered backup root",
            ));
        }
        let backup_id = original
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| {
                PortcoveError::unsupported("Portcove V1 requires backup paths to be valid Unicode")
            })?
            .to_owned();
        let parsed = Uuid::parse_str(&backup_id)
            .map_err(|_| PortcoveError::state("recoverable backup ID is invalid"))?;
        if parsed.to_string() != backup_id
            || quarantine.file_name().and_then(|name| name.to_str())
                != Some(format!(".deleting-{}", operation.id).as_str())
        {
            return Err(PortcoveError::conflict(
                "backup deletion paths do not match the recorded operation identity",
            ));
        }
        refuse_symlink_ancestors(&original)?;
        refuse_symlink_ancestors(&quarantine)?;
        if let Some(binding) = &operation.backup_deletion {
            if binding.backup.id != backup_id
                || binding.backup.port_id != operation.port_id
                || binding.backup.path != original
            {
                return Err(PortcoveError::verification(
                    "runtime safety deletion binding differs from its journal backup identity",
                ));
            }
            ghostship_safety::validate_binding(binding)?;
        }
        Ok(backups::BackupDeletionOperation::from_validated_paths(
            operation, original, quarantine, backup_id,
        ))
    }

    pub(crate) fn synchronize_restored_user_data(&self, port_id: &str) -> Result<()> {
        self.library.require_no_ghostship_recovery(port_id)?;
        let port = self.catalog.port(port_id)?;
        let user_root = self.library.user_dir(port_id);
        let mut mods = self.preflight_psx_mod_restores(port_id, &user_root)?;
        for path in self.library.port_install_paths(port_id)? {
            refuse_symlink_ancestors(&path)?;
            match fs::symlink_metadata(&path) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                result => {
                    result?;
                }
            }
            let install_root = self.managed_install_root(port_id, &path)?;
            let contract = self.persistence_contract(port, &install_root)?;
            let port = &contract.port;
            let persistent_root = self.persistence_root(port, &install_root)?;
            if !contract.writes_directly {
                for relative in crate::persistence::entries(port, &[&user_root, &persistent_root])?
                {
                    let source = user_root.join(&relative);
                    let destination = persistent_root.join(&relative);
                    refuse_symlink_ancestors(&source)?;
                    refuse_symlink_ancestors(&destination)?;
                    if relative == "mods" && psx_mod_data::owns_mods(port) {
                        if let Some(restore) = mods.remove(&install_root) {
                            restore.apply(&self.library, port_id, &install_root)?;
                        }
                        continue;
                    }
                    if port.runtime_data_policy.is_some() {
                        crate::runtime_data_policy::mirror(
                            port,
                            &source,
                            &destination,
                            &user_root,
                            crate::runtime_data_policy::CanonicalSide::Source,
                        )?;
                    } else if source.exists() {
                        sync_entry(&source, &destination)?;
                    } else if destination.exists() {
                        remove_managed_entry(&destination)?;
                    }
                }
            }
            self.record_psx_data_restored(port, &install_root)?;
            let marker = install_root.join(LAUNCH_MARKER);
            refuse_symlink_ancestors(&marker)?;
            match fs::remove_file(&marker) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                result => result?,
            }
            self.faults
                .check(LifecycleFaultPoint::RestoreVersionSynchronized)?;
        }
        Ok(())
    }

    fn collect_user_data_from(
        &self,
        port: &PortDefinition,
        install_root: &Path,
    ) -> Result<Vec<PathBuf>> {
        self.library.require_no_ghostship_recovery(&port.id)?;
        let contract = self.persistence_contract(port, install_root)?;
        let port = &contract.port;
        self.require_completed_restore(&port.id)?;
        let user_root = self.library.user_dir(&port.id);
        let persistent_root = self.persistence_root(port, install_root)?;
        self.require_psx_data_receipt_readable(port, install_root)?;
        if crate::persistence::requires_restore_receipt(port)
            && !install_root.join(LAUNCH_MARKER).is_file()
            && let Some(copied) = self.collect_uninitialized_psx_data(
                port,
                install_root,
                &persistent_root,
                &user_root,
            )?
        {
            return Ok(copied);
        }
        let mods = if !contract.writes_directly && psx_mod_data::owns_mods(port) {
            Some(psx_mod_data::ModRestore::prepare(
                &persistent_root.join("mods"),
                &user_root.join("mods"),
            )?)
        } else {
            None
        };
        let mut copied = Vec::new();
        for relative in crate::persistence::entries(port, &[&persistent_root, &user_root])? {
            let source = persistent_root.join(&relative);
            let destination = user_root.join(&relative);
            if contract.writes_directly {
                if destination.exists() {
                    copied.push(destination);
                }
                continue;
            }
            if relative == "mods"
                && let Some(plan) = &mods
            {
                plan.require_unchanged(&|| Ok(()))?;
            }
            if port.runtime_data_policy.is_some() {
                crate::runtime_data_policy::mirror(
                    port,
                    &source,
                    &destination,
                    &user_root,
                    crate::runtime_data_policy::CanonicalSide::Destination,
                )?;
                if destination.exists() {
                    copied.push(destination);
                }
            } else if source.exists() {
                sync_entry(&source, &destination)?;
                copied.push(destination);
            } else if destination.exists() {
                remove_managed_entry(&destination)?;
            }
        }
        Ok(copied)
    }

    pub(crate) fn restore_user_data_to(
        &self,
        port: &PortDefinition,
        install_root: &Path,
    ) -> Result<()> {
        self.library.require_no_ghostship_recovery(&port.id)?;
        let contract = self.persistence_contract(port, install_root)?;
        self.restore_user_data_with_contract(&contract, install_root)
    }

    fn restore_retained_user_data_to(&self, install: &InstallRecord) -> Result<()> {
        self.library
            .require_no_ghostship_recovery(&install.port_id)?;
        let contract = self.persistence_contract_for_install(install)?;
        self.restore_user_data_with_contract(&contract, &install.path)
    }

    fn restore_user_data_with_contract(
        &self,
        contract: &PersistenceContract,
        install_root: &Path,
    ) -> Result<()> {
        let port = &contract.port;
        let install_root = self.managed_install_root(&port.id, install_root)?;
        let user_root = self.library.user_dir(&port.id);
        let persistent_root = self.persistence_root(port, &install_root)?;
        crate::preparation::source::require_canonical_originals(port, &self.library)?;
        crate::native_temp::require_canonical_data(port, &self.library)?;
        self.require_psx_data_receipt_readable(port, &install_root)?;
        let marker = install_root.join(LAUNCH_MARKER);
        refuse_symlink_ancestors(&marker)?;
        let previously_launched = marker.is_file();
        if port.runtime_data_policy.is_some() {
            crate::runtime_data_policy::refuse_sensitive_tree(&user_root)?;
        }
        if !contract.writes_directly {
            let mut mods = if psx_mod_data::owns_mods(port)
                && (user_root.join("mods").try_exists()? || previously_launched)
            {
                Some(psx_mod_data::ModRestore::prepare(
                    &user_root.join("mods"),
                    &persistent_root.join("mods"),
                )?)
            } else {
                None
            };
            for relative in crate::persistence::entries(port, &[&user_root, &persistent_root])? {
                let source = user_root.join(&relative);
                let destination = persistent_root.join(&relative);
                refuse_symlink_ancestors(&source)?;
                refuse_symlink_ancestors(&destination)?;
                if relative == "mods" && psx_mod_data::owns_mods(port) {
                    if let Some(restore) = mods.take() {
                        restore.apply(&self.library, &port.id, &install_root)?;
                    }
                    continue;
                }
                if port.runtime_data_policy.is_some() {
                    if source.exists() || previously_launched {
                        crate::runtime_data_policy::mirror(
                            port,
                            &source,
                            &destination,
                            &user_root,
                            crate::runtime_data_policy::CanonicalSide::Source,
                        )?;
                    }
                } else if source.exists() {
                    sync_entry(&source, &destination)?;
                } else if previously_launched && destination.exists() {
                    remove_managed_entry(&destination)?;
                }
            }
        }
        self.record_psx_data_restored(port, &install_root)?;
        Ok(())
    }

    fn persistence_root(&self, port: &PortDefinition, install_root: &Path) -> Result<PathBuf> {
        let qualification = InstallQualification::from_port(port, Platform::current()?)?;
        let executable = crate::install::resolve_declared_executable(install_root, &qualification)?;
        Ok(qualification.persistence_root(install_root, &executable))
    }
}

fn port_action_blocker(blocker: LaunchBlocker) -> (PortActionAvailability, PortActionReason) {
    use PortActionAvailability as Availability;
    use PortActionReason as Reason;
    match blocker {
        LaunchBlocker::MissingSource => (Availability::Waiting, Reason::MissingSource),
        LaunchBlocker::UnreadableSource => (Availability::Held, Reason::UnreadableSource),
        LaunchBlocker::ChangedSource => (Availability::Held, Reason::ChangedSource),
        LaunchBlocker::IncompatibleSource => (Availability::Waiting, Reason::IncompatibleSource),
        LaunchBlocker::MissingBios => (Availability::Waiting, Reason::MissingBios),
        LaunchBlocker::UnreadableBios => (Availability::Held, Reason::UnreadableBios),
        LaunchBlocker::ChangedBios => (Availability::Held, Reason::ChangedBios),
        LaunchBlocker::IncompatibleBios => (Availability::Waiting, Reason::IncompatibleBios),
        LaunchBlocker::MissingRuntime => (Availability::Held, Reason::MissingRuntime),
        LaunchBlocker::PreparationRequired => (Availability::Waiting, Reason::PreparationRequired),
        LaunchBlocker::SharedPreferencesReviewRequired => {
            (Availability::Held, Reason::SharedPreferencesReviewRequired)
        }
        LaunchBlocker::SharedPreferencesUnavailable => {
            (Availability::Held, Reason::SharedPreferencesUnavailable)
        }
        LaunchBlocker::InvalidInstallation => (Availability::Held, Reason::InvalidInstallation),
    }
}

fn source_path_has_extension(path: &Path, extension: &str) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|actual| actual.eq_ignore_ascii_case(extension))
}

fn require_prepared_source_directory(path: &Path) -> Result<()> {
    crate::path::refuse_symlink_ancestors(path)?;
    if !fs::symlink_metadata(path)?.is_dir() {
        return Err(PortcoveError::source(
            "this prepared runtime requires an authenticated original-data directory, not an archive",
        ));
    }
    Ok(())
}

fn repair_path_identity(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        use std::path::{Component, Prefix};

        let Some(Component::Prefix(prefix)) = path.components().next() else {
            return path.to_path_buf();
        };
        let Some(text) = path.to_str() else {
            return path.to_path_buf();
        };
        match prefix.kind() {
            Prefix::VerbatimDisk(_) => PathBuf::from(&text[4..]),
            Prefix::VerbatimUNC(_, _) => PathBuf::from(format!("\\\\{}", &text[8..])),
            _ => path.to_path_buf(),
        }
    }
    #[cfg(not(windows))]
    path.to_path_buf()
}

fn default_channel(port: &PortDefinition) -> ReleaseChannel {
    if port.channels.contains(&ReleaseChannel::Stable) {
        ReleaseChannel::Stable
    } else {
        port.channels[0]
    }
}

fn writes_directly_to_user_root(port: &PortDefinition) -> bool {
    port.user_data_environment.is_some()
        || (port.adapter == crate::AdapterKind::LibultrashipPortable
            && (!cfg!(windows) || !crate::preparation::managed(port)))
}

fn data_version(connection: &rusqlite::Connection) -> Result<i64> {
    Ok(connection.query_row("PRAGMA data_version", [], |row| row.get(0))?)
}

fn output_authorization_target(port_id: &str, output_directory: Option<&Path>) -> Result<String> {
    let destination = output_directory
        .map(|path| crate::path::unicode(path, "port output directory"))
        .transpose()?
        .unwrap_or_else(|| "<library-default>".into());
    Ok(format!("{port_id}\n{destination}"))
}

fn output_destination_fingerprint(preview: &OutputDestinationPreview) -> Result<String> {
    // Free-space counts are useful preview facts, but unrelated writes on the
    // selected volume must not invalidate consent while the destination stays
    // usable. Availability is bound below and every apply recomputes it, while
    // install and relocation operations perform their own exact sufficiency check.
    let bound = (
        &preview.port_id,
        &preview.current,
        &preview.proposed,
        preview.reset_to_default,
        preview.availability,
        preview.ownership,
        &preview.volume_identity,
        &preview.validation_errors,
        &preview.affected_installs,
        preview.moves_existing_install,
    );
    Ok(hex::encode(Sha256::digest(serde_json::to_vec(&bound)?)))
}

fn require_valid_output_preview(preview: &OutputDestinationPreview) -> Result<()> {
    if preview.validation_errors.is_empty()
        && preview.availability == crate::OutputDestinationAvailability::Available
        && !matches!(
            preview.ownership,
            crate::OutputDestinationOwnership::OwnedByAnotherPort
                | crate::OutputDestinationOwnership::UnrelatedContent
                | crate::OutputDestinationOwnership::Invalid
                | crate::OutputDestinationOwnership::Unknown
        )
    {
        return Ok(());
    }
    Err(PortcoveError::conflict(
        "output destination is not safe to save; review the validation results",
    )
    .detail("preview_sha256", preview.preview_sha256.clone())
    .detail("validation_errors", preview.validation_errors.join("; ")))
}

fn validate_reviewed_fingerprint(label: &str, fingerprint: &str) -> Result<()> {
    if fingerprint.len() != 64
        || !fingerprint
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    {
        return Err(PortcoveError::usage(format!(
            "reviewed {label} fingerprint is not a canonical SHA-256 digest"
        )));
    }
    Ok(())
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
    destination: Option<&AdoptionDestinationPreview>,
) -> Result<String> {
    let encoded = serde_json::to_vec(&(
        crate::path::unicode(source, "adoption source")?,
        detected_port_ids,
        selected_port_id,
        plan,
        destination,
    ))?;
    Ok(hex::encode(Sha256::digest(encoded)))
}

pub(crate) fn adoption_copy_plan(source: &Path) -> Result<AdoptionCopyPlan> {
    crate::runtime_data_policy::refuse_sensitive_tree(source)?;
    #[cfg(test)]
    ADOPTION_COPY_PLAN_PASSES.with(|passes| {
        *passes.borrow_mut().entry(source.to_path_buf()).or_default() += 1;
    });
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

#[cfg(test)]
fn reset_adoption_copy_plan_passes() -> std::collections::BTreeMap<PathBuf, usize> {
    ADOPTION_COPY_PLAN_PASSES.with(|passes| std::mem::take(&mut *passes.borrow_mut()))
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
        crate::runtime_data_policy::refuse_sensitive_entry(&path)?;
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
    crate::runtime_data_policy::refuse_sensitive_tree(source)?;
    crate::runtime_data_policy::refuse_sensitive_tree(destination)?;
    fs::create_dir_all(destination)?;
    for relative in &plan.directories {
        crate::runtime_data_policy::refuse_sensitive_entry(&source.join(relative))?;
        crate::runtime_data_policy::refuse_sensitive_entry(&destination.join(relative))?;
        fs::create_dir_all(destination.join(relative))?;
    }
    for file in &plan.files {
        let source_file = source.join(&file.relative_path);
        let destination_file = destination.join(&file.relative_path);
        crate::runtime_data_policy::refuse_sensitive_entry(&source_file)?;
        crate::runtime_data_policy::refuse_sensitive_entry(&destination_file)?;
        if let Some(parent) = destination_file.parent() {
            fs::create_dir_all(parent)?;
        }
        crate::runtime_data_policy::copy_ordinary_file(&source_file, &destination_file)?;
    }
    Ok(())
}

pub(crate) fn sha256_file(path: &Path) -> Result<String> {
    crate::runtime_data_policy::refuse_sensitive_entry(path)?;
    let mut file = crate::external_runtime::open_single_link_file(path)?;
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
    crate::runtime_data_policy::refuse_sensitive_tree(source)?;
    crate::runtime_data_policy::refuse_sensitive_tree(destination)?;
    copy_tree_checked(source, destination)
}

fn copy_tree_checked(source: &Path, destination: &Path) -> Result<()> {
    crate::runtime_data_policy::refuse_sensitive_entry(source)?;
    crate::runtime_data_policy::refuse_sensitive_entry(destination)?;
    refuse_symlink_ancestors(destination)?;
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        crate::runtime_data_policy::refuse_sensitive_entry(&entry.path())?;
        if entry.file_type()?.is_symlink() {
            continue;
        }
        copy_entry(&entry.path(), &destination.join(entry.file_name()))?;
    }
    Ok(())
}

fn copy_entry(source: &Path, destination: &Path) -> Result<()> {
    crate::runtime_data_policy::refuse_sensitive_entry(source)?;
    crate::runtime_data_policy::refuse_sensitive_entry(destination)?;
    if fs::symlink_metadata(source)?.file_type().is_symlink() {
        return Ok(());
    }
    if source.is_dir() {
        copy_tree_checked(source, destination)
    } else if source.is_file() {
        refuse_symlink_ancestors(destination)?;
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }
        crate::runtime_data_policy::copy_ordinary_file(source, destination)?;
        Ok(())
    } else {
        Ok(())
    }
}

fn sync_entry(source: &Path, destination: &Path) -> Result<()> {
    crate::runtime_data_policy::refuse_sensitive_tree(source)?;
    crate::runtime_data_policy::refuse_sensitive_tree(destination)?;
    sync_entry_checked(source, destination)
}

fn sync_entry_checked(source: &Path, destination: &Path) -> Result<()> {
    crate::runtime_data_policy::refuse_sensitive_entry(source)?;
    crate::runtime_data_policy::refuse_sensitive_entry(destination)?;
    if fs::symlink_metadata(source)?.file_type().is_symlink() {
        return Ok(());
    }
    refuse_symlink_ancestors(destination)?;
    if source.is_file() {
        if destination.exists() && !destination.is_file() {
            remove_managed_entry(destination)?;
        }
        if destination.is_file()
            && fs::metadata(source)?.len() == fs::metadata(destination)?.len()
            && fs::metadata(source)?.modified()? == fs::metadata(destination)?.modified()?
            && sha256_file(source)? == sha256_file(destination)?
        {
            return Ok(());
        }
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }
        crate::runtime_data_policy::copy_ordinary_file(source, destination)?;
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
        crate::runtime_data_policy::refuse_sensitive_entry(&entry.path())?;
        if entry.file_type()?.is_symlink() {
            continue;
        }
        sync_entry_checked(&entry.path(), &destination.join(entry.file_name()))?;
    }
    for entry in fs::read_dir(destination)? {
        let entry = entry?;
        crate::runtime_data_policy::refuse_sensitive_entry(&entry.path())?;
        let source_entry = source.join(entry.file_name());
        if !source_entry.exists() {
            remove_managed_entry(&entry.path())?;
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
    mod backups;
    mod channel_recommendations;
    #[cfg(windows)]
    mod dynamic_policy;

    use std::{
        sync::{
            Arc, Condvar, Mutex,
            atomic::{AtomicBool, AtomicUsize, Ordering},
            mpsc,
        },
        thread,
        time::Duration,
    };

    use crate::{
        AdapterKind, ArtifactIdentity, BackupInventoryState, ChildProcessClass, RestoreResult,
    };

    use super::*;

    fn retained_cartridge_install_fixture() -> (tempfile::TempDir, Library, Catalog, InstallRecord)
    {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let catalog = crate::cartridge_build::tests::fixture_catalog();
        let port = catalog.port("yoshis-cookie-recomp").unwrap();
        let root = library.versions_dir().join(&port.id).join("inert-build");
        fs::create_dir_all(&root).unwrap();
        for name in [
            "YoshisCookieRecomp.exe",
            "SDL2.dll",
            "game.nes",
            crate::cartridge_build::RECEIPT,
        ] {
            fs::write(root.join(name), b"inert fixture bytes").unwrap();
        }
        let qualification =
            InstallQualification::from_catalog(&catalog, &port.id, Platform::WindowsX86_64)
                .unwrap();
        let artifact = ArtifactIdentity {
            asset_name: "fixture.zip".into(),
            sha256: "a".repeat(64),
            size: 10,
        };
        let (manifest_sha256, selected_executable, runtime) = Installer::new(library.clone())
            .unwrap()
            .create_manifest(
                "inert-build",
                &port.id,
                "v1",
                &artifact,
                &qualification,
                &root,
            )
            .unwrap();
        let install = InstallRecord {
            id: "inert-build".into(),
            port_id: port.id.clone(),
            version: "v1".into(),
            path: root,
            channel: ReleaseChannel::Stable,
            installed_at: 1,
            verified: true,
            staged: false,
            artifact,
            manifest_sha256,
            selected_executable,
            runtime,
        };
        library.register_install(&install, true).unwrap();
        (temporary, library, catalog, install)
    }

    #[test]
    fn cartridge_artifact_reuse_requires_its_retained_build_recipe() {
        let (_temporary, library, catalog, install) = retained_cartridge_install_fixture();
        let port = catalog.port("yoshis-cookie-recomp").unwrap();
        let mut service = PortcoveService::new(library).unwrap();
        service.catalog = catalog.clone();
        let release = ResolvedRelease {
            version: "v1".into(),
            channel: ReleaseChannel::Stable,
            published_at: None,
            asset: crate::ReleaseAsset {
                name: "fixture.zip".into(),
                sha256: install.artifact.sha256.clone(),
                size: 10,
                url: "https://invalid.example/never-requested".into(),
            },
        };
        assert!(
            service
                .install_matches_release(&install, &release, None)
                .unwrap()
        );
        let before = service
            .library
            .status(&port.id, ReleaseChannel::Stable)
            .unwrap();
        assert_eq!(
            service.install_plan_action(&before, &release).unwrap(),
            InstallPlanAction::AlreadyActive
        );
        let mut document = catalog.authoritative_document();
        document.ports[0].release.managed_build.clear();
        service.catalog = Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap();
        assert!(
            !service
                .install_matches_release(&install, &release, None)
                .unwrap()
        );
        assert_eq!(
            service.install_plan_action(&before, &release).unwrap(),
            InstallPlanAction::Download
        );
        assert_eq!(
            service
                .library
                .status(&port.id, ReleaseChannel::Stable)
                .unwrap()
                .active
                .unwrap()
                .id,
            install.id
        );
        // An equal archive digest cannot turn a downloaded runtime into this
        // original-driven build (or vice versa); no publication occurred.
    }

    #[cfg(windows)]
    #[test]
    fn retained_custom_runtime_preserves_launch_collection_and_recovery_after_route_change() {
        // Inert runtime files and synthetic exited-child collection state; no
        // game runs and no private original is required for these Core contracts.
        let (temporary, library, legacy, install) = retained_cartridge_install_fixture();
        let service = PortcoveService::new(library.clone()).unwrap();
        let id = &install.port_id;
        let current = service.catalog.port(id).unwrap();
        assert_eq!(current.release.provider, ReleaseSource::UserPrepared);
        assert!(current.source_profile.is_none());
        let retained = service.installed_mutability_port(&install).unwrap();
        assert_eq!(
            serde_json::to_value(&retained).unwrap(),
            serde_json::to_value(legacy.port(id).unwrap()).unwrap()
        );
        let user = library.user_dir(id);
        fs::create_dir_all(user.join("saves")).unwrap();
        fs::write(user.join("config.ini"), b"preexisting config").unwrap();
        fs::write(user.join("saves/slot"), b"preexisting save").unwrap();
        let source_before = fs::read(install.path.join("game.nes")).unwrap();
        let executable_before = fs::read(install.path.join(&install.selected_executable)).unwrap();
        let spec = service
            .prepare_launch_for_install(current, &install, None, None)
            .unwrap();
        assert_eq!(spec.arguments, ["game.nes"]);
        assert_eq!(
            spec.environment
                .get("NESRECOMP_NO_LAUNCHER")
                .map(String::as_str),
            Some("1")
        );
        assert_eq!(
            fs::read(install.path.join("saves/slot")).unwrap(),
            b"preexisting save"
        );

        let wrong_source = temporary.path().join("wrong.nes");
        fs::write(&wrong_source, b"wrong original remains untouched").unwrap();
        assert!(
            service
                .prepare_launch_for_install(current, &install, Some(&wrong_source), None)
                .is_err()
        );
        assert_eq!(
            fs::read(&wrong_source).unwrap(),
            b"wrong original remains untouched"
        );
        for name in ["game.nes", "YoshisCookieRecomp.exe"] {
            let path = install.path.join(name);
            let before = fs::read(&path).unwrap();
            fs::write(&path, b"changed immutable fixture").unwrap();
            assert!(
                service
                    .prepare_launch_for_install(current, &install, None, None)
                    .is_err()
            );
            fs::write(path, before).unwrap();
        }
        let debug = install.path.join("debug.ini");
        fs::write(&debug, b"unoffered listener control").unwrap();
        assert!(
            service
                .prepare_launch_for_install(current, &install, None, None)
                .is_err()
        );
        assert_eq!(fs::read(&debug).unwrap(), b"unoffered listener control");
        fs::remove_file(debug).unwrap();

        // Exercise the exact collection entry point used after ordinary exit.
        fs::write(install.path.join("config.ini"), b"ordinary exit config").unwrap();
        fs::write(install.path.join("saves/slot"), b"ordinary exit save").unwrap();
        service
            .collect_user_data_from_install(id, &install.path)
            .unwrap();
        assert_eq!(
            fs::read(user.join("config.ini")).unwrap(),
            b"ordinary exit config"
        );
        assert_eq!(
            fs::read(user.join("saves/slot")).unwrap(),
            b"ordinary exit save"
        );
        let foreign = temporary.path().join("external-runtime");
        fs::create_dir(&foreign).unwrap();
        fs::write(foreign.join("config.ini"), b"external data").unwrap();
        assert!(
            service
                .collect_user_data_from_install(id, &foreign)
                .is_err()
        );
        assert_eq!(
            fs::read(foreign.join("config.ini")).unwrap(),
            b"external data"
        );

        // Recovery is bound to the recorded install, not today's setup route.
        let activity = library
            .begin_activity(
                ActivityOperation::Launch,
                ActivityTargetKind::Port,
                Some(id),
            )
            .unwrap();
        let now = Library::now();
        library
            .create_launch_session(&LaunchSessionRecord {
                id: activity.id.clone(),
                port_id: id.clone(),
                install_id: install.id.clone(),
                install_root: install.path.clone(),
                owner_kind: crate::LaunchOwnerKind::Managed,
                supervisor_pid: u32::MAX,
                supervisor_identity: None,
                child_pid: None,
                child_identity: None,
                phase: LaunchSessionPhase::Collecting,
                outcome: None,
                exit_code: None,
                message: None,
                started_at: now,
                updated_at: now,
                finished_at: None,
            })
            .unwrap();
        fs::write(install.path.join("config.ini"), b"recovered config").unwrap();
        fs::write(install.path.join("saves/slot"), b"recovered save").unwrap();
        service.recover_launch_session(&activity.id).unwrap();
        assert!(
            library
                .active_launch_session(&activity.id)
                .unwrap()
                .is_none()
        );
        assert_eq!(
            fs::read(user.join("config.ini")).unwrap(),
            b"recovered config"
        );
        assert_eq!(
            fs::read(user.join("saves/slot")).unwrap(),
            b"recovered save"
        );
        let backup = service.create_backup(id).unwrap();
        assert_eq!(backup.port_id, *id);
        let status = service.status(id).unwrap();
        assert_eq!(status.active.as_ref().unwrap().id, install.id);
        assert!(status.external_runtime.is_none());
        for action in [PortAction::Update, PortAction::RegisterExternal] {
            assert_eq!(
                status
                    .port_actions
                    .iter()
                    .find(|item| item.action == action)
                    .unwrap()
                    .availability,
                PortActionAvailability::NotOffered
            );
        }
        assert_eq!(
            status
                .port_actions
                .iter()
                .find(|item| item.action == PortAction::RemoveManaged)
                .unwrap()
                .availability,
            PortActionAvailability::Waiting
        );
        assert_eq!(
            fs::read(install.path.join("game.nes")).unwrap(),
            source_before
        );
        assert_eq!(
            fs::read(install.path.join(&install.selected_executable)).unwrap(),
            executable_before
        );
    }

    #[test]
    fn libultraship_persistence_matches_the_host_storage_contract() {
        let catalog = Catalog::embedded().unwrap();
        let port = catalog.port("paperboat").unwrap().clone();
        assert_eq!(writes_directly_to_user_root(&port), !cfg!(windows));
        assert!(writes_directly_to_user_root(
            catalog.port("lighthouse").unwrap()
        ));

        let mut explicit = port;
        explicit.user_data_environment = Some("PORTCOVE_OWNED_USER_ROOT".into());
        assert!(writes_directly_to_user_root(&explicit));
    }

    #[test]
    fn channel_choices_follow_catalog_and_survive_restart_without_installation_changes() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("library");
        let service = PortcoveService::new(Library::open(&root).unwrap()).unwrap();
        let cases = [
            ("ghostship", vec![ReleaseChannel::Stable]),
            (
                "re-blue",
                vec![ReleaseChannel::Stable, ReleaseChannel::Rolling],
            ),
            (
                "g-diffuser",
                vec![ReleaseChannel::Stable, ReleaseChannel::Beta],
            ),
        ];
        for (port_id, channels) in cases {
            assert_eq!(service.catalog.port(port_id).unwrap().channels, channels);
            let before = service.status(port_id).unwrap();
            for channel in &channels {
                let changed = service.set_channel(port_id, *channel).unwrap();
                assert_eq!(changed.channel, *channel);
                assert_eq!(
                    serde_json::to_value(&changed.active).unwrap(),
                    serde_json::to_value(&before.active).unwrap()
                );
                assert_eq!(
                    serde_json::to_value(&changed.previous).unwrap(),
                    serde_json::to_value(&before.previous).unwrap()
                );
                assert_eq!(
                    serde_json::to_value(&changed.staged).unwrap(),
                    serde_json::to_value(&before.staged).unwrap()
                );
                let reopened = PortcoveService::new(Library::open(&root).unwrap()).unwrap();
                assert_eq!(reopened.status(port_id).unwrap().channel, *channel);
            }
            let selected = service.status(port_id).unwrap().channel;
            for unsupported in [
                ReleaseChannel::Stable,
                ReleaseChannel::Beta,
                ReleaseChannel::Rolling,
            ] {
                if !channels.contains(&unsupported) {
                    assert_eq!(
                        service.set_channel(port_id, unsupported).unwrap_err().code,
                        crate::ErrorCode::Unsupported
                    );
                    assert_eq!(service.status(port_id).unwrap().channel, selected);
                }
            }
        }
    }

    #[test]
    fn beta_only_channel_comes_from_catalog_and_busy_changes_preserve_selection() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let mut service = PortcoveService::new(library.clone()).unwrap();
        let mut document = service.catalog.authoritative_document();
        let port = document
            .ports
            .iter_mut()
            .find(|port| port.id == "ghostship")
            .unwrap();
        port.channels = vec![ReleaseChannel::Beta];
        // A display name is not a provider classification.
        port.name = "Stable-looking fixture name".into();
        service.replace_catalog_for_test(
            Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap(),
        );
        assert_eq!(
            service.status("ghostship").unwrap().channel,
            ReleaseChannel::Beta
        );
        assert_eq!(
            service
                .set_channel("ghostship", ReleaseChannel::Stable)
                .unwrap_err()
                .code,
            crate::ErrorCode::Unsupported
        );
        service
            .set_channel("g-diffuser", ReleaseChannel::Stable)
            .unwrap();
        let guard = library
            .try_lock_port("g-diffuser", "fixture-operation")
            .unwrap();
        assert!(
            service
                .set_channel("g-diffuser", ReleaseChannel::Beta)
                .is_err()
        );
        assert_eq!(
            service.status("g-diffuser").unwrap().channel,
            ReleaseChannel::Stable
        );
        drop(guard);
        assert_eq!(
            service
                .set_channel("g-diffuser", ReleaseChannel::Beta)
                .unwrap()
                .channel,
            ReleaseChannel::Beta
        );
    }

    #[tokio::test]
    async fn channel_change_refreshes_release_metadata_without_changing_active_installation() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        register_zelda_install(&library, "v1", true);
        let mut service = service_with_release(library, "v2");
        let mut document = service.catalog.authoritative_document();
        document
            .ports
            .iter_mut()
            .find(|port| port.id == "zelda64-recomp")
            .unwrap()
            .channels = vec![ReleaseChannel::Stable, ReleaseChannel::Beta];
        service.replace_catalog_for_test(
            Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap(),
        );
        let before = service.status("zelda64-recomp").unwrap();
        assert_eq!(
            service
                .check_update("zelda64-recomp")
                .await
                .unwrap()
                .channel,
            ReleaseChannel::Stable
        );
        let reviewed = service
            .plan_game_update("zelda64-recomp", false)
            .await
            .unwrap();
        service
            .set_channel("zelda64-recomp", ReleaseChannel::Beta)
            .unwrap();
        assert_eq!(
            service
                .authorize_game_update("zelda64-recomp", false, &reviewed.plan_sha256)
                .await
                .unwrap_err()
                .code,
            crate::ErrorCode::Conflict
        );
        let check = service.check_update("zelda64-recomp").await.unwrap();
        assert_eq!(check.channel, ReleaseChannel::Beta);
        assert_eq!(check.release.channel, ReleaseChannel::Beta);
        let after = service.status("zelda64-recomp").unwrap();
        assert_eq!(
            serde_json::to_value(&after.active).unwrap(),
            serde_json::to_value(&before.active).unwrap()
        );
        assert_eq!(
            serde_json::to_value(&after.previous).unwrap(),
            serde_json::to_value(&before.previous).unwrap()
        );
        assert_eq!(
            serde_json::to_value(&after.staged).unwrap(),
            serde_json::to_value(&before.staged).unwrap()
        );
        assert_eq!(
            after.last_update_check.unwrap().check.channel,
            ReleaseChannel::Beta
        );
    }

    #[derive(Clone)]
    struct StaticReleaseProvider {
        version: String,
    }

    struct ConcurrentReleaseProvider {
        active: AtomicUsize,
        max_active: AtomicUsize,
        calls: Mutex<Vec<String>>,
        rate_limited_port: Option<String>,
        first_batch: tokio::sync::Barrier,
    }

    impl ConcurrentReleaseProvider {
        fn new(rate_limited_port: Option<String>) -> Self {
            Self {
                active: AtomicUsize::new(0),
                max_active: AtomicUsize::new(0),
                calls: Mutex::new(Vec::new()),
                rate_limited_port,
                first_batch: tokio::sync::Barrier::new(4),
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
            let call_number = {
                let mut calls = self.calls.lock().unwrap();
                calls.push(port.id.clone());
                calls.len()
            };
            let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
            self.max_active.fetch_max(active, Ordering::SeqCst);
            // Prove four requests overlap without depending on wall-clock scheduling.
            // Later batches can contain fewer than four requests.
            if call_number <= 4 {
                self.first_batch.wait().await;
            } else {
                tokio::task::yield_now().await;
            }
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

    #[tokio::test]
    async fn curated_declaration_refuses_custom_provider_before_resolution() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let service = PortcoveService::with_provider(
            library,
            Arc::new(StaticReleaseProvider {
                version: "provider-would-succeed".into(),
            }),
        )
        .unwrap();
        // The current DKR route delegates replacement to its selected launcher;
        // this acquisition-authority fixture still exercises the old GitHub route.
        let historical =
            Catalog::from_json(include_str!("../catalog/catalog-schema1-fixture.json")).unwrap();
        let mut port = historical.port("dkr-r").unwrap().clone();
        assert!(
            service
                .resolve_release(&port, ReleaseChannel::Stable, Platform::WindowsX86_64)
                .await
                .is_ok()
        );
        port.release.curated.insert(
            Platform::WindowsX86_64,
            crate::curated_acquisition::fixture_record(),
        );
        let error = service
            .resolve_release(&port, ReleaseChannel::Stable, Platform::WindowsX86_64)
            .await
            .unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Unsupported);
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

    pub(super) fn service_with_release(library: Library, version: &str) -> PortcoveService {
        PortcoveService::with_provider(
            library,
            Arc::new(StaticReleaseProvider {
                version: version.into(),
            }),
        )
        .unwrap()
    }

    fn service_with_added_persistent_path(
        library: Library,
        version: &str,
        relative: &str,
    ) -> PortcoveService {
        let mut service = service_with_release(library, version);
        let mut document = service.catalog().authoritative_document();
        document
            .ports
            .iter_mut()
            .find(|port| port.id == "zelda64-recomp")
            .unwrap()
            .persistent_paths
            .push(relative.into());
        service.replace_catalog_for_test(
            Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap(),
        );
        service
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

    struct FailAdoptionPrivateWork {
        cleanup_fails: bool,
    }

    impl LifecycleFaultInjector for FailAdoptionPrivateWork {
        fn check(&self, point: LifecycleFaultPoint) -> Result<()> {
            match point {
                LifecycleFaultPoint::AdoptionCopied => {
                    Err(PortcoveError::state("injected adoption copy failure"))
                }
                LifecycleFaultPoint::AdoptionPrivateCleanup if self.cleanup_fails => Err(
                    PortcoveError::state("injected adoption private cleanup failure"),
                ),
                _ => Ok(()),
            }
        }
    }

    fn assert_adoption_private_cleanup_outcome(cleanup_fails: bool) {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let installed = register_zelda_install(&library, "v1", true);
        let source = temporary.path().join("existing-install");
        fs::create_dir_all(&source).unwrap();
        write_host_test_executable(&source, "zelda64-recomp");
        fs::write(source.join("general.json"), b"adopted settings").unwrap();
        let user = library.user_dir("zelda64-recomp").join("general.json");
        fs::create_dir_all(user.parent().unwrap()).unwrap();
        fs::write(&user, b"canonical original settings").unwrap();
        let source_before = format!("{:?}", adoption_copy_plan(&source).unwrap());
        let installed_before = format!("{:?}", adoption_copy_plan(&installed).unwrap());
        let installs_before = serde_json::to_vec(&library.all_installs().unwrap()).unwrap();
        let service = PortcoveService::with_provider_and_faults(
            library.clone(),
            Arc::new(StaticReleaseProvider {
                version: "v2".into(),
            }),
            Arc::new(FailAdoptionPrivateWork { cleanup_fails }),
        )
        .unwrap();
        let sources_before = serde_json::to_vec(&service.library.sources().unwrap()).unwrap();
        let preview = service
            .preview_adoption(&source, Some("zelda64-recomp"))
            .unwrap();
        let authorization = service
            .authorize_adoption(&source, Some("zelda64-recomp"), &preview.plan_sha256)
            .unwrap();
        let error = service
            .adopt(&source, Some("zelda64-recomp"), &authorization.token)
            .unwrap_err();
        assert_eq!(error.message, "injected adoption copy failure");
        let activity = library
            .activities(20)
            .unwrap()
            .into_iter()
            .find(|activity| activity.operation == ActivityOperation::Adopt)
            .unwrap();
        assert_eq!(activity.status, ActivityStatus::Failed);
        let staging = library.staging_dir().join(&activity.id);
        let store = OperationStore::new(library.clone());
        if cleanup_fails {
            assert_eq!(
                store.all().unwrap().len(),
                1,
                "failed private adoption cleanup must retain its journal"
            );
            let journal = store.get(&activity.id).unwrap().unwrap();
            assert_eq!(journal.kind, LifecycleOperationKind::Adopt);
            assert_eq!(journal.phase, LifecyclePhase::Preparing);
            assert!(journal.install.is_none());
            assert_eq!(journal.paths.staging.as_ref(), Some(&staging));
            assert_eq!(error.details.get("operation_id"), Some(&activity.id));
            assert_eq!(
                error.details.get("cleanup_error").map(String::as_str),
                Some("injected adoption private cleanup failure")
            );
            assert_eq!(
                error.presentation().mutation_state,
                crate::MutationState::RecoveryRequired
            );
            assert_eq!(
                serde_json::to_vec(activity.failure.as_ref().unwrap()).unwrap(),
                serde_json::to_vec(&error.report()).unwrap()
            );
            let diagnostic = journal.last_error.as_ref().unwrap();
            assert!(diagnostic.contains("injected adoption copy failure"));
            assert!(diagnostic.contains("injected adoption private cleanup failure"));
            let private_before = format!("{:?}", adoption_copy_plan(&staging).unwrap());
            let restarted = PortcoveService::new(library.clone()).unwrap();
            let retained = store.get(&activity.id).unwrap().unwrap();
            assert_eq!(retained.kind, journal.kind);
            assert_eq!(retained.phase, LifecyclePhase::Preparing);
            assert_eq!(retained.created_at, journal.created_at);
            assert!(retained.install.is_none());
            assert_eq!(retained.paths.staging.as_ref(), Some(&staging));
            assert_eq!(
                format!("{:?}", adoption_copy_plan(&staging).unwrap()),
                private_before
            );
            assert_eq!(
                serde_json::to_vec(&restarted.library.sources().unwrap()).unwrap(),
                sources_before
            );
            let retained_activity = library
                .activities(20)
                .unwrap()
                .into_iter()
                .find(|current| current.id == activity.id)
                .unwrap();
            assert_eq!(retained_activity.status, ActivityStatus::Failed);
            assert_eq!(
                serde_json::to_vec(&retained_activity.failure).unwrap(),
                serde_json::to_vec(&activity.failure).unwrap()
            );
        } else {
            assert!(store.all().unwrap().is_empty());
            assert!(!staging.exists());
            assert!(!error.details.contains_key("cleanup_error"));
            PortcoveService::new(library.clone()).unwrap();
            assert!(store.all().unwrap().is_empty());
        }
        assert_eq!(
            format!("{:?}", adoption_copy_plan(&source).unwrap()),
            source_before
        );
        assert_eq!(
            format!("{:?}", adoption_copy_plan(&installed).unwrap()),
            installed_before
        );
        assert_eq!(fs::read(&user).unwrap(), b"canonical original settings");
        assert_eq!(
            serde_json::to_vec(&library.all_installs().unwrap()).unwrap(),
            installs_before
        );
        assert_eq!(
            serde_json::to_vec(&service.library.sources().unwrap()).unwrap(),
            sources_before
        );
    }

    #[test]
    fn adoption_private_cleanup_failure_retains_owned_recovery_intent() {
        assert_adoption_private_cleanup_outcome(true);
    }

    #[test]
    fn adoption_private_cleanup_success_retires_failed_attempt() {
        assert_adoption_private_cleanup_outcome(false);
    }

    fn assert_external_adoption_recovers_after_every_publication_boundary(
        point: LifecycleFaultPoint,
    ) {
        assert_external_adoption_destination_recovery(point, None);
    }

    fn assert_external_adoption_destination_recovery(
        point: LifecycleFaultPoint,
        destination_case: Option<(LifecyclePhase, bool)>,
    ) {
        let started = std::time::Instant::now();
        let observe = |step: &str| {
            eprintln!(
                "[adoption-recovery] format=1 point={point:?} destination={destination_case:?} step={step} elapsed={:?}",
                started.elapsed()
            );
        };
        observe("fixture-start");
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let source = temporary.path().join("existing-install");
        fs::create_dir_all(&source).unwrap();
        write_host_test_executable(&source, "zelda64-recomp");
        fs::write(source.join("general.json"), b"adopted settings").unwrap();

        let user = library.user_dir("zelda64-recomp").join("general.json");
        fs::create_dir_all(user.parent().unwrap()).unwrap();
        fs::write(&user, b"canonical original settings").unwrap();
        let original = format!("{:?}", adoption_copy_plan(&source).unwrap());
        let sources = serde_json::to_vec(&library.sources().unwrap()).unwrap();
        let service = service_with_fault(library.clone(), point);
        let output_root = temporary.path().join("external-output");
        service
            .set_output_directory("zelda64-recomp", &output_root)
            .unwrap();
        let preview = service
            .preview_adoption(&source, Some("zelda64-recomp"))
            .unwrap();
        let authorization = service
            .authorize_adoption(&source, Some("zelda64-recomp"), &preview.plan_sha256)
            .unwrap();
        let error = service
            .adopt(&source, Some("zelda64-recomp"), &authorization.token)
            .unwrap_err();
        observe("adoption-fault-returned");
        assert!(error.message.contains("injected lifecycle failure"));
        assert_eq!(
            error.presentation().mutation_state,
            crate::MutationState::RecoveryRequired
        );
        let store = OperationStore::new(library.clone());
        let journal = store.all().unwrap().pop().unwrap();
        assert_eq!(error.details.get("operation_id"), Some(&journal.id));
        let expected_phase = match point {
            LifecycleFaultPoint::AdoptionPrepared => LifecyclePhase::Prepared,
            LifecycleFaultPoint::AdoptionPublished => LifecyclePhase::PayloadPublished,
            LifecycleFaultPoint::AdoptionMetadataCommitted => LifecyclePhase::MetadataCommitted,
            _ => unreachable!("only publication boundaries use this fixture"),
        };
        assert_eq!(journal.phase, expected_phase);
        assert_eq!(journal.last_error.as_deref(), Some(error.message.as_str()));
        let activity = library
            .activities(20)
            .unwrap()
            .into_iter()
            .find(|activity| activity.id == journal.id)
            .unwrap();
        assert_eq!(activity.status, ActivityStatus::Failed);
        assert_eq!(
            serde_json::to_vec(activity.failure.as_ref().unwrap()).unwrap(),
            serde_json::to_vec(&error.report()).unwrap()
        );
        let staging = journal.paths.staging.as_ref().unwrap();
        let install = journal.install.as_ref().unwrap();
        assert_eq!(
            staging.join("payload").exists(),
            expected_phase == LifecyclePhase::Prepared
        );
        assert_eq!(
            install.path.exists(),
            expected_phase != LifecyclePhase::Prepared
        );
        let registered = library
            .status("zelda64-recomp", ReleaseChannel::Stable)
            .unwrap()
            .active;
        assert_eq!(
            registered.as_ref().map(|install| &install.id),
            (expected_phase == LifecyclePhase::MetadataCommitted).then_some(&journal.id)
        );
        assert_eq!(
            fs::read(staging.join("user/general.json")).unwrap(),
            b"adopted settings"
        );
        assert_eq!(fs::read(&user).unwrap(), b"canonical original settings");
        assert_eq!(
            format!("{:?}", adoption_copy_plan(&source).unwrap()),
            original
        );
        assert_eq!(
            serde_json::to_vec(&library.sources().unwrap()).unwrap(),
            sources
        );

        if let Some((phase, omitted)) = destination_case {
            let store = OperationStore::new(library.clone());
            let mut journal = store.all().unwrap().pop().unwrap();
            let destination = journal.paths.final_path.clone().unwrap();
            let staging = journal.paths.staging.clone().unwrap();
            let private = staging.join("destination-sentinel");
            fs::write(&private, b"private adoption evidence").unwrap();
            let unrelated = temporary.path().join("unrelated-destination");
            fs::create_dir_all(&unrelated).unwrap();
            fs::write(unrelated.join("sentinel"), b"unrelated original").unwrap();
            let user = library.user_dir("zelda64-recomp").join("general.json");
            fs::create_dir_all(user.parent().unwrap()).unwrap();
            fs::write(&user, b"canonical original settings").unwrap();
            let payload = fs::read(staging.join("payload/general.json")).ok();
            let published = fs::read(destination.join("general.json")).ok();
            let registered = serde_json::to_vec(&library.all_installs().unwrap()).unwrap();
            journal.phase = phase;
            journal.paths.final_path = (!omitted).then(|| unrelated.clone());
            store.put(&mut journal).unwrap();
            if !omitted {
                PortcoveService::new(library.clone()).unwrap();
                let retained = store.get(&journal.id).unwrap().unwrap();
                assert_eq!(retained.phase, phase);
                assert_eq!(retained.paths.final_path, Some(unrelated.clone()));
                assert_eq!(
                    serde_json::to_vec(&retained.install).unwrap(),
                    serde_json::to_vec(&journal.install).unwrap()
                );
                assert!(retained.last_error.unwrap().contains("journal destination"));
                assert_eq!(fs::read(&private).unwrap(), b"private adoption evidence");
                assert_eq!(fs::read(staging.join("payload/general.json")).ok(), payload);
                assert_eq!(fs::read(destination.join("general.json")).ok(), published);
                assert_eq!(
                    serde_json::to_vec(&library.all_installs().unwrap()).unwrap(),
                    registered
                );
                assert_eq!(fs::read(&user).unwrap(), b"canonical original settings");
                assert_eq!(
                    fs::read(source.join("general.json")).unwrap(),
                    b"adopted settings"
                );
                assert_eq!(
                    fs::read(staging.join("user/general.json")).unwrap(),
                    b"adopted settings"
                );
                observe("contradictory-destination-preserved");
                journal = store.get(&journal.id).unwrap().unwrap();
                journal.paths.final_path = Some(destination);
                store.put(&mut journal).unwrap();
            }
            PortcoveService::new(library.clone()).unwrap();
            assert!(!staging.exists());
            assert_eq!(
                fs::read(unrelated.join("sentinel")).unwrap(),
                b"unrelated original"
            );
            assert_eq!(
                fs::read(source.join("general.json")).unwrap(),
                b"adopted settings"
            );
            observe("destination-recovery-verified");
        }

        let recovered = service_with_release(library.clone(), "v2");
        let status = recovered.status("zelda64-recomp").unwrap();
        assert!(
            status
                .active
                .as_ref()
                .is_some_and(|install| install.path.is_dir())
        );
        assert_eq!(
            status.active.as_ref().unwrap().path.parent(),
            Some(fs::canonicalize(&output_root).unwrap().as_path())
        );
        assert_eq!(
            fs::read(library.user_dir("zelda64-recomp").join("general.json")).unwrap(),
            b"adopted settings"
        );
        assert!(recovered.repair_plan().unwrap().items.is_empty());
        assert!(store.get(&journal.id).unwrap().is_none());
        assert!(!staging.exists());
        observe("recovered-status-verified");
        let recovered_installs = serde_json::to_vec(&library.all_installs().unwrap()).unwrap();
        let reopened = PortcoveService::new(library.clone()).unwrap();
        assert_eq!(
            serde_json::to_vec(&library.all_installs().unwrap()).unwrap(),
            recovered_installs
        );
        assert!(reopened.repair_plan().unwrap().items.is_empty());
        assert!(store.get(&journal.id).unwrap().is_none());
        assert_eq!(fs::read(&user).unwrap(), b"adopted settings");
        assert_eq!(
            format!("{:?}", adoption_copy_plan(&source).unwrap()),
            original
        );
        assert_eq!(
            serde_json::to_vec(&library.sources().unwrap()).unwrap(),
            sources
        );
        let retained_activity = library
            .activities(20)
            .unwrap()
            .into_iter()
            .find(|activity| activity.id == journal.id)
            .unwrap();
        assert_eq!(retained_activity.status, ActivityStatus::Failed);
        assert_eq!(
            serde_json::to_vec(&retained_activity.failure).unwrap(),
            serde_json::to_vec(&activity.failure).unwrap()
        );
        observe("assertions-complete");
    }

    #[test]
    fn external_adoption_recovery_retains_contradictory_destinations() {
        for (point, phase) in [
            (
                LifecycleFaultPoint::AdoptionPrepared,
                LifecyclePhase::Prepared,
            ),
            (
                LifecycleFaultPoint::AdoptionPublished,
                LifecyclePhase::PayloadPublished,
            ),
            (
                LifecycleFaultPoint::AdoptionMetadataCommitted,
                LifecyclePhase::MetadataCommitted,
            ),
            (
                LifecycleFaultPoint::AdoptionMetadataCommitted,
                LifecyclePhase::CleanupPending,
            ),
        ] {
            assert_external_adoption_destination_recovery(point, Some((phase, false)));
        }
    }

    #[test]
    fn external_adoption_recovery_preserves_omitted_destination_compatibility() {
        for (point, phase) in [
            (
                LifecycleFaultPoint::AdoptionPublished,
                LifecyclePhase::PayloadPublished,
            ),
            (
                LifecycleFaultPoint::AdoptionMetadataCommitted,
                LifecyclePhase::CleanupPending,
            ),
        ] {
            assert_external_adoption_destination_recovery(point, Some((phase, true)));
        }
    }

    #[test]
    fn publication_recovery_refuses_a_foreign_owner_while_the_install_owner_is_locked() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let source = temporary.path().join("existing-install");
        fs::create_dir_all(&source).unwrap();
        write_host_test_executable(&source, "zelda64-recomp");
        fs::write(source.join("general.json"), b"original settings").unwrap();
        let service = service_with_fault(library.clone(), LifecycleFaultPoint::AdoptionPublished);
        let preview = service
            .preview_adoption(&source, Some("zelda64-recomp"))
            .unwrap();
        let authorization = service
            .authorize_adoption(&source, Some("zelda64-recomp"), &preview.plan_sha256)
            .unwrap();
        assert!(
            service
                .adopt(&source, Some("zelda64-recomp"), &authorization.token)
                .is_err()
        );
        let store = OperationStore::new(library.clone());
        let mut journal = store.all().unwrap().pop().unwrap();
        assert_eq!(journal.kind, LifecycleOperationKind::Adopt);
        assert_eq!(journal.phase, LifecyclePhase::PayloadPublished);
        let install = journal.install.clone().unwrap();
        assert!(
            Installer::new(library.clone())
                .unwrap()
                .verify(&install)
                .unwrap()
                .valid
        );
        let staging = journal.paths.staging.clone().unwrap();
        let sentinel = staging.join("owner-sentinel");
        fs::write(&sentinel, b"private publication state").unwrap();
        // Change only the recorded lock owner; the published install stays valid.
        journal.port_id = "starship".into();
        store.put(&mut journal).unwrap();
        let held = library
            .try_lock_port("zelda64-recomp", "owned-test-install-lock")
            .unwrap();
        assert!(
            library
                .try_lock_port("zelda64-recomp", "competing-test-lock")
                .is_err()
        );
        PortcoveService::new(library.clone()).unwrap();
        assert!(
            library
                .status("zelda64-recomp", ReleaseChannel::Stable)
                .unwrap()
                .active
                .is_none(),
            "startup registered the embedded install without its held owner lock"
        );
        let refused = store.get(&journal.id).unwrap().unwrap();
        assert_eq!(refused.phase, LifecyclePhase::PayloadPublished);
        assert_eq!(refused.port_id, "starship");
        assert_eq!(refused.install.as_ref().unwrap().id, install.id);
        assert!(refused.last_error.as_deref().unwrap().contains("owner"));
        assert_eq!(fs::read(&sentinel).unwrap(), b"private publication state");
        assert_eq!(
            fs::read(source.join("general.json")).unwrap(),
            b"original settings"
        );
        assert!(
            Installer::new(library.clone())
                .unwrap()
                .verify(&install)
                .unwrap()
                .valid
        );
        assert!(library.all_installs().unwrap().is_empty());
        // The otherwise-identical valid record is still deferred under its lock.
        journal.port_id = install.port_id.clone();
        store.put(&mut journal).unwrap();
        PortcoveService::new(library.clone()).unwrap();
        assert!(store.get(&journal.id).unwrap().is_some());
        assert!(library.all_installs().unwrap().is_empty());
        assert_eq!(fs::read(&sentinel).unwrap(), b"private publication state");
        drop(held);
        PortcoveService::new(library.clone()).unwrap();
        assert_eq!(
            library
                .status("zelda64-recomp", ReleaseChannel::Stable)
                .unwrap()
                .active
                .unwrap()
                .id,
            install.id
        );
        assert!(store.get(&journal.id).unwrap().is_none());
        assert!(!staging.exists());
        assert_eq!(
            fs::read(library.user_dir("zelda64-recomp").join("general.json")).unwrap(),
            b"original settings"
        );
        assert_eq!(
            fs::read(source.join("general.json")).unwrap(),
            b"original settings"
        );
    }

    #[test]
    fn publication_recovery_retains_foreign_install_and_adoption_owners_in_every_phase() {
        let started = std::time::Instant::now();
        for kind in [
            LifecycleOperationKind::Install,
            LifecycleOperationKind::Adopt,
        ] {
            for phase in [
                LifecyclePhase::Preparing,
                LifecyclePhase::Prepared,
                LifecyclePhase::PayloadPublished,
                LifecyclePhase::MetadataCommitted,
                LifecyclePhase::CleanupPending,
            ] {
                eprintln!(
                    "foreign publication owners {kind:?} {phase:?}: fixture begin elapsed={:?}",
                    started.elapsed()
                );
                let temporary = tempfile::tempdir().unwrap();
                let library = Library::open(temporary.path().join("library")).unwrap();
                let live = register_zelda_install(&library, "v1", true);
                let install = library
                    .status("zelda64-recomp", ReleaseChannel::Stable)
                    .unwrap()
                    .active
                    .unwrap();
                let mut journal =
                    LifecycleOperation::new(Uuid::new_v4().to_string(), kind, "starship");
                let staging = library.staging_dir().join(&journal.id);
                fs::create_dir_all(staging.join("user")).unwrap();
                fs::write(staging.join("user/general.json"), b"private settings").unwrap();
                fs::create_dir_all(library.user_dir("starship")).unwrap();
                fs::write(
                    library.user_dir("starship").join("general.json"),
                    b"foreign original settings",
                )
                .unwrap();
                journal.phase = phase;
                journal.install = Some(install.clone());
                journal.paths.staging = Some(staging.clone());
                journal.activate = true;
                let created_at = journal.created_at;
                let store = OperationStore::new(library.clone());
                store.put(&mut journal).unwrap();
                let held = library
                    .try_lock_port("zelda64-recomp", "owned-test-install-lock")
                    .unwrap();
                eprintln!(
                    "foreign publication owners {kind:?} {phase:?}: recovery begin elapsed={:?}",
                    started.elapsed()
                );
                PortcoveService::new(library.clone()).unwrap();
                eprintln!(
                    "foreign publication owners {kind:?} {phase:?}: recovery complete elapsed={:?}",
                    started.elapsed()
                );
                let refused = store.get(&journal.id).unwrap().unwrap();
                assert_eq!(refused.kind, kind);
                assert_eq!(refused.phase, phase);
                assert_eq!(refused.created_at, created_at);
                assert_eq!(refused.port_id, "starship");
                assert_eq!(refused.install.as_ref().unwrap().id, install.id);
                assert_eq!(refused.paths.staging.as_ref().unwrap(), &staging);
                assert!(refused.last_error.as_deref().unwrap().contains("owner"));
                assert_eq!(
                    fs::read(staging.join("user/general.json")).unwrap(),
                    b"private settings"
                );
                assert_eq!(
                    fs::read(library.user_dir("starship").join("general.json")).unwrap(),
                    b"foreign original settings"
                );
                let after = library
                    .status("zelda64-recomp", ReleaseChannel::Stable)
                    .unwrap()
                    .active
                    .unwrap();
                assert_eq!(after.id, install.id);
                assert_eq!(after.path, live);
                assert_eq!(library.all_installs().unwrap().len(), 1);
                assert!(
                    Installer::new(library.clone())
                        .unwrap()
                        .verify(&after)
                        .unwrap()
                        .valid
                );
                assert!(
                    library
                        .try_lock_port("zelda64-recomp", "competing-test-lock")
                        .is_err()
                );
                drop(held);
                eprintln!(
                    "foreign publication owners {kind:?} {phase:?}: assertions complete elapsed={:?}",
                    started.elapsed()
                );
            }
        }
    }

    #[derive(Clone, Copy)]
    enum ConflictingPublicationIntent {
        Relocation,
        SourceImport,
        OriginalPaths,
        Quarantine,
    }

    fn assert_publication_retains_family_intent(
        kind: LifecycleOperationKind,
        phase: LifecyclePhase,
        conflict: ConflictingPublicationIntent,
        private_cleanup: bool,
    ) {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let installed = register_zelda_install(&library, "v1", true);
        let install = library
            .status("zelda64-recomp", ReleaseChannel::Stable)
            .unwrap()
            .active
            .unwrap();
        let source = temporary.path().join("original-source");
        fs::write(&source, b"\x80\x37\x12\x40original source\0").unwrap();
        let (sha256, size) = crate::adapter::hash_file(&source).unwrap();
        library
            .register_source(&SourceRecord {
                profile_id: "opengoal-jak1-disc".into(),
                path: source.clone(),
                sha256: sha256.clone(),
                size,
                storage_sha256: sha256,
                storage_size: size,
                updated_at: Library::now(),
                observed_identity: None,
            })
            .unwrap();
        let saved = library.user_dir("zelda64-recomp").join("general.json");
        fs::create_dir_all(saved.parent().unwrap()).unwrap();
        fs::write(&saved, b"original saved settings").unwrap();
        let store = OperationStore::new(library.clone());
        let point = match phase {
            LifecyclePhase::Prepared => LifecycleFaultPoint::AdoptionPrepared,
            LifecyclePhase::PayloadPublished => LifecycleFaultPoint::AdoptionPublished,
            LifecyclePhase::MetadataCommitted | LifecyclePhase::CleanupPending => {
                LifecycleFaultPoint::AdoptionMetadataCommitted
            }
            LifecyclePhase::Preparing => unreachable!(),
        };
        let service = service_with_fault(library.clone(), point);
        let adoption_source = temporary.path().join("existing-install");
        let mut journal = if kind == LifecycleOperationKind::Adopt {
            fs::create_dir_all(&adoption_source).unwrap();
            write_host_test_executable(&adoption_source, "zelda64-recomp");
            fs::write(adoption_source.join("general.json"), b"adopted settings").unwrap();
            let preview = service
                .preview_adoption(&adoption_source, Some("zelda64-recomp"))
                .unwrap();
            let authorization = service
                .authorize_adoption(
                    &adoption_source,
                    Some("zelda64-recomp"),
                    &preview.plan_sha256,
                )
                .unwrap();
            assert!(
                service
                    .adopt(
                        &adoption_source,
                        Some("zelda64-recomp"),
                        &authorization.token
                    )
                    .unwrap_err()
                    .message
                    .contains("injected lifecycle failure")
            );
            store.all().unwrap().pop().unwrap()
        } else {
            let id = if private_cleanup {
                let activity = library
                    .begin_activity(
                        ActivityOperation::Install,
                        ActivityTargetKind::Port,
                        Some("zelda64-recomp"),
                    )
                    .unwrap();
                library
                    .finish_activity(
                        &activity.id,
                        ActivityStatus::Failed,
                        Some("private preparation failed"),
                    )
                    .unwrap();
                activity.id
            } else {
                install.id.clone()
            };
            let mut journal = LifecycleOperation::new(id, kind, "zelda64-recomp");
            if !private_cleanup {
                journal.paths.final_path = Some(installed.clone());
                journal.install = Some(install);
                journal.activate = true;
            } else {
                journal.preparation_process_quiesced = Some(true);
            }
            journal
        };
        let staging = library.staging_dir().join(&journal.id);
        fs::create_dir_all(&staging).unwrap();
        fs::write(staging.join("sentinel"), b"private publication evidence").unwrap();
        let quarantine = library.recovery_dir().join(&journal.id);
        fs::create_dir_all(&quarantine).unwrap();
        fs::write(quarantine.join("sentinel"), b"other family intent").unwrap();
        journal.phase = phase;
        journal.paths.staging = Some(staging.clone());
        match conflict {
            ConflictingPublicationIntent::Relocation => {
                journal.relocation = Some(
                    service
                        .plan_output_relocation(
                            "zelda64-recomp",
                            &temporary.path().join("relocation-target"),
                        )
                        .unwrap(),
                );
            }
            ConflictingPublicationIntent::SourceImport => {
                let source_record = library.source("opengoal-jak1-disc").unwrap().unwrap();
                // A typed synthetic import payload tests family ownership, not source admission.
                journal.source_import = Some(crate::SourceImportPlan {
                    schema_version: 1,
                    profile_id: source_record.profile_id.clone(),
                    mode: crate::SourceImportMode::Copy,
                    admission_mode: crate::SourceAdmissionMode::ExactIdentity,
                    destination: temporary.path().join("import-target"),
                    destination_exists: false,
                    reuse_existing: false,
                    required_bytes: source_record.storage_size,
                    existing_registration: Some(source_record.clone()),
                    source_guard_sha256: source_record.storage_sha256.clone(),
                    plan_sha256: source_record.storage_sha256.clone(),
                    source: source_record,
                });
            }
            ConflictingPublicationIntent::OriginalPaths => {
                journal.original_paths = vec![source.clone()];
            }
            ConflictingPublicationIntent::Quarantine => {
                journal.paths.quarantine = Some(quarantine.clone());
            }
        }
        let codec_refuses = matches!(
            conflict,
            ConflictingPublicationIntent::Relocation | ConflictingPublicationIntent::SourceImport
        );
        if codec_refuses {
            assert_eq!(
                store.put(&mut journal).unwrap_err().code,
                crate::ErrorCode::State
            );
            let mut baseline = journal.clone();
            baseline.relocation = None;
            baseline.source_import = None;
            store.put(&mut baseline).unwrap();
            library.connection().unwrap().execute(
                "UPDATE lifecycle_operations SET relocation_json=?2,source_import_json=?3 WHERE id=?1",
                rusqlite::params![journal.id, journal.relocation.as_ref().map(serde_json::to_string).transpose().unwrap(), journal.source_import.as_ref().map(serde_json::to_string).transpose().unwrap()],
            ).unwrap();
        } else {
            store.put(&mut journal).unwrap();
        }
        let row_snapshot = || {
            library
                .connection()
                .unwrap()
                .query_row(
                    "SELECT * FROM lifecycle_operations WHERE id=?1",
                    [&journal.id],
                    |row| {
                        (0..row.as_ref().column_count())
                            .map(|index| row.get::<_, rusqlite::types::Value>(index))
                            .collect::<rusqlite::Result<Vec<_>>>()
                    },
                )
                .unwrap()
        };
        let malformed_before = codec_refuses.then(row_snapshot);
        if codec_refuses {
            let observer = PortcoveService::new_read_only(library.clone()).unwrap();
            let preferences =
                crate::HostPreferenceStore::new(temporary.path().join("preferences.json")).unwrap();
            let report = observer.doctor_with_preferences(&preferences).unwrap();
            let diagnostic = report.repair.journal_diagnostics.unwrap();
            assert!(
                diagnostic
                    .problems
                    .iter()
                    .any(|problem| problem.stage == crate::JournalValidationStage::Family)
            );
            assert!(!diagnostic.related_assessments_complete);
            assert_eq!(Some(row_snapshot()), malformed_before);
        }
        let installs = serde_json::to_vec(&library.all_installs().unwrap()).unwrap();
        let sources = serde_json::to_vec(&library.sources().unwrap()).unwrap();
        let private_tree = serde_json::to_vec(&adoption_copy_plan(&staging).unwrap()).unwrap();
        let tree_snapshot = |path: &Path| {
            path.exists()
                .then(|| serde_json::to_vec(&adoption_copy_plan(path).unwrap()).unwrap())
        };
        let destination_tree = journal.paths.final_path.as_deref().and_then(tree_snapshot);
        let original_install_tree = tree_snapshot(&installed);
        let adoption_source_tree = tree_snapshot(&adoption_source);

        if codec_refuses {
            assert_eq!(
                PortcoveService::new(library.clone()).err().unwrap().code,
                crate::ErrorCode::State
            );
            assert!(store.get(&journal.id).is_err());
            let mut decoded = journal.clone();
            let error = crate::recovery::recover_published_install(&service, &store, &mut decoded)
                .unwrap_err();
            assert_eq!(error.code, crate::ErrorCode::State);
            assert!(error.message.contains("missing or foreign family payload"));
            assert_eq!(format!("{decoded:?}"), format!("{journal:?}"));
            assert_eq!(row_snapshot(), *malformed_before.as_ref().unwrap());
        } else {
            PortcoveService::new(library.clone()).unwrap();
        }

        assert!(
            staging.is_dir(),
            "conflicting intent must retain private staging"
        );
        let mut retained = if codec_refuses {
            journal.clone()
        } else {
            store.get(&journal.id).unwrap().unwrap()
        };
        assert_eq!(retained.kind, kind);
        assert_eq!(retained.phase, phase);
        assert_eq!(retained.created_at, journal.created_at);
        if codec_refuses {
            assert_eq!(row_snapshot(), *malformed_before.as_ref().unwrap());
        } else {
            assert!(
                retained
                    .last_error
                    .as_deref()
                    .unwrap()
                    .contains("family's intent")
            );
        }
        let diagnostic = retained.last_error.take();
        retained.updated_at = journal.updated_at;
        assert_eq!(
            format!("{retained:?}"),
            format!(
                "{:?}",
                LifecycleOperation {
                    last_error: None,
                    ..journal.clone()
                }
            )
        );
        retained.last_error = diagnostic;
        assert_eq!(
            fs::read(staging.join("sentinel")).unwrap(),
            b"private publication evidence"
        );
        assert_eq!(
            fs::read(quarantine.join("sentinel")).unwrap(),
            b"other family intent"
        );
        assert_eq!(
            fs::read(&source).unwrap(),
            b"\x80\x37\x12\x40original source\0"
        );
        assert_eq!(fs::read(&saved).unwrap(), b"original saved settings");
        assert_eq!(
            serde_json::to_vec(&library.all_installs().unwrap()).unwrap(),
            installs
        );
        assert_eq!(
            serde_json::to_vec(&library.sources().unwrap()).unwrap(),
            sources
        );
        assert!(installed.is_dir());
        assert_eq!(
            serde_json::to_vec(&adoption_copy_plan(&staging).unwrap()).unwrap(),
            private_tree
        );
        assert_eq!(
            journal.paths.final_path.as_deref().and_then(tree_snapshot),
            destination_tree
        );
        assert_eq!(tree_snapshot(&installed), original_install_tree);
        assert_eq!(tree_snapshot(&adoption_source), adoption_source_tree);

        match conflict {
            ConflictingPublicationIntent::Relocation => retained.relocation = None,
            ConflictingPublicationIntent::SourceImport => retained.source_import = None,
            ConflictingPublicationIntent::OriginalPaths => retained.original_paths.clear(),
            ConflictingPublicationIntent::Quarantine => retained.paths.quarantine = None,
        }
        let recovered_install = retained.install.as_ref().map(|record| record.id.clone());
        store.put(&mut retained).unwrap();
        PortcoveService::new(library.clone()).unwrap();
        assert!(store.get(&journal.id).unwrap().is_none());
        assert!(!staging.exists());
        assert_eq!(
            fs::read(quarantine.join("sentinel")).unwrap(),
            b"other family intent"
        );
        assert_eq!(
            fs::read(&source).unwrap(),
            b"\x80\x37\x12\x40original source\0"
        );
        assert_eq!(
            serde_json::to_vec(&library.sources().unwrap()).unwrap(),
            sources
        );
        if let Some(id) = recovered_install {
            assert_eq!(
                library
                    .status("zelda64-recomp", ReleaseChannel::Stable)
                    .unwrap()
                    .active
                    .unwrap()
                    .id,
                id
            );
        } else {
            assert_eq!(
                serde_json::to_vec(&library.all_installs().unwrap()).unwrap(),
                installs
            );
            assert_eq!(
                library.activities(1).unwrap()[0].status,
                ActivityStatus::Failed
            );
        }
        if kind == LifecycleOperationKind::Adopt {
            assert_eq!(fs::read(&saved).unwrap(), b"adopted settings");
            assert_eq!(
                fs::read(adoption_source.join("general.json")).unwrap(),
                b"adopted settings"
            );
        } else {
            assert_eq!(fs::read(&saved).unwrap(), b"original saved settings");
        }
        assert_eq!(tree_snapshot(&installed), original_install_tree);
        assert_eq!(tree_snapshot(&adoption_source), adoption_source_tree);
        PortcoveService::new(library).unwrap();
        assert!(store.get(&journal.id).unwrap().is_none());
    }

    fn assert_conflicting_publication_phases(conflict: ConflictingPublicationIntent) {
        let started = std::time::Instant::now();
        for kind in [
            LifecycleOperationKind::Install,
            LifecycleOperationKind::Adopt,
        ] {
            for phase in [
                LifecyclePhase::MetadataCommitted,
                LifecyclePhase::Prepared,
                LifecyclePhase::PayloadPublished,
                LifecyclePhase::CleanupPending,
            ] {
                eprintln!(
                    "publication recovery {kind:?}/{phase:?}: start at {:?}",
                    started.elapsed()
                );
                assert_publication_retains_family_intent(kind, phase, conflict, false);
                eprintln!(
                    "publication recovery {kind:?}/{phase:?}: complete at {:?}",
                    started.elapsed()
                );
            }
        }
    }

    #[test]
    fn publication_recovery_retains_conflicting_quarantine_intent() {
        assert_conflicting_publication_phases(ConflictingPublicationIntent::Quarantine);
    }

    #[test]
    fn publication_recovery_retains_conflicting_relocation_intent() {
        assert_conflicting_publication_phases(ConflictingPublicationIntent::Relocation);
    }

    #[test]
    fn publication_recovery_retains_conflicting_source_import_intent() {
        assert_conflicting_publication_phases(ConflictingPublicationIntent::SourceImport);
    }

    #[test]
    fn publication_recovery_retains_conflicting_original_paths_intent() {
        assert_conflicting_publication_phases(ConflictingPublicationIntent::OriginalPaths);
    }

    #[test]
    fn unpublished_install_cleanup_retains_conflicting_family_intent() {
        for conflict in [
            ConflictingPublicationIntent::Relocation,
            ConflictingPublicationIntent::SourceImport,
            ConflictingPublicationIntent::OriginalPaths,
            ConflictingPublicationIntent::Quarantine,
        ] {
            assert_publication_retains_family_intent(
                LifecycleOperationKind::Install,
                LifecyclePhase::CleanupPending,
                conflict,
                true,
            );
        }
    }

    #[test]
    fn recovers_adoption_prepared() {
        assert_external_adoption_recovers_after_every_publication_boundary(
            LifecycleFaultPoint::AdoptionPrepared,
        );
    }

    #[test]
    fn recovers_adoption_published() {
        assert_external_adoption_recovers_after_every_publication_boundary(
            LifecycleFaultPoint::AdoptionPublished,
        );
    }

    #[test]
    fn recovers_adoption_metadata_committed() {
        assert_external_adoption_recovers_after_every_publication_boundary(
            LifecycleFaultPoint::AdoptionMetadataCommitted,
        );
    }

    #[derive(Clone, Copy)]
    enum AdoptionDestinationLink {
        File,
        DanglingFile,
        Directory,
        Root,
        Ancestor,
        #[cfg(windows)]
        JunctionDirectory,
        #[cfg(windows)]
        JunctionRoot,
    }

    impl AdoptionDestinationLink {
        fn includes_source_file_link(self) -> bool {
            match self {
                #[cfg(windows)]
                Self::JunctionDirectory | Self::JunctionRoot => false,
                _ => true,
            }
        }
    }

    struct AdoptionDestinationFixture {
        temporary: tempfile::TempDir,
        library: Library,
        source: PathBuf,
        user: PathBuf,
        outside: PathBuf,
        previous: InstallRecord,
        source_file_link: bool,
    }

    impl AdoptionDestinationFixture {
        fn new(kind: AdoptionDestinationLink) -> Self {
            let temporary = tempfile::tempdir().unwrap();
            let source_file_link = kind.includes_source_file_link();
            let source = temporary.path().join("existing-install");
            let outside = temporary.path().join("outside-user-parent/zelda64-recomp");
            fs::create_dir_all(&source).unwrap();
            fs::create_dir_all(&outside).unwrap();
            fs::write(outside.join("graphics.json"), b"outside source-link target").unwrap();
            if source_file_link {
                create_adoption_test_symlink(
                    &outside.join("graphics.json"),
                    &source.join("graphics.json"),
                    false,
                );
            }
            let library = Library::open(temporary.path().join("library")).unwrap();
            register_zelda_install(&library, "v1", true);
            let previous = library
                .status("zelda64-recomp", ReleaseChannel::Stable)
                .unwrap()
                .active
                .unwrap();
            let user = library.user_dir("zelda64-recomp");
            for root in [&source, &user, &outside] {
                fs::create_dir_all(root.join("saves")).unwrap();
            }
            write_host_test_executable(&source, "zelda64-recomp");
            fs::write(source.join("general.json"), b"incoming settings").unwrap();
            fs::write(source.join("saves/slot.bin"), b"incoming save").unwrap();
            fs::write(user.join("general.json"), b"current settings").unwrap();
            fs::write(user.join("saves/slot.bin"), b"current save").unwrap();
            fs::write(user.join("unrelated-save"), b"preserved unrelated save").unwrap();
            fs::write(outside.join("general.json"), b"outside settings").unwrap();
            fs::write(outside.join("saves/slot.bin"), b"outside save").unwrap();
            Self {
                temporary,
                library,
                source,
                user,
                outside,
                previous,
                source_file_link,
            }
        }

        fn link_destination(&self, kind: AdoptionDestinationLink) -> (PathBuf, PathBuf, bool) {
            let (link, target, directory) = match kind {
                AdoptionDestinationLink::File => (
                    self.user.join("general.json"),
                    self.outside.join("general.json"),
                    false,
                ),
                AdoptionDestinationLink::DanglingFile => (
                    self.user.join("general.json"),
                    self.outside.join("missing.json"),
                    false,
                ),
                AdoptionDestinationLink::Directory => {
                    (self.user.join("saves"), self.outside.join("saves"), true)
                }
                AdoptionDestinationLink::Root => (self.user.clone(), self.outside.clone(), true),
                AdoptionDestinationLink::Ancestor => (
                    self.user.parent().unwrap().to_path_buf(),
                    self.outside.parent().unwrap().to_path_buf(),
                    true,
                ),
                #[cfg(windows)]
                AdoptionDestinationLink::JunctionDirectory => {
                    (self.user.join("saves"), self.outside.join("saves"), true)
                }
                #[cfg(windows)]
                AdoptionDestinationLink::JunctionRoot => {
                    (self.user.clone(), self.outside.clone(), true)
                }
            };
            let retained = self.temporary.path().join("retained-destination");
            fs::rename(&link, &retained).unwrap();
            #[cfg(windows)]
            if matches!(
                kind,
                AdoptionDestinationLink::JunctionDirectory | AdoptionDestinationLink::JunctionRoot
            ) {
                create_adoption_test_junction(&target, &link);
            } else {
                create_adoption_test_symlink(&target, &link, directory);
            }
            #[cfg(unix)]
            create_adoption_test_symlink(&target, &link, directory);
            assert!(
                fs::symlink_metadata(&link)
                    .unwrap()
                    .file_type()
                    .is_symlink()
            );
            (link, retained, directory)
        }

        fn assert_outside_and_source_intact(&self) {
            assert_eq!(
                fs::read(self.outside.join("general.json")).unwrap(),
                b"outside settings"
            );
            assert_eq!(
                fs::read(self.outside.join("saves/slot.bin")).unwrap(),
                b"outside save"
            );
            assert_eq!(
                fs::read(self.outside.join("graphics.json")).unwrap(),
                b"outside source-link target"
            );
            assert!(!self.outside.join("missing.json").exists());
            assert_eq!(
                fs::read(self.source.join("general.json")).unwrap(),
                b"incoming settings"
            );
            assert_eq!(
                fs::read(self.source.join("saves/slot.bin")).unwrap(),
                b"incoming save"
            );
            let source_link = fs::symlink_metadata(self.source.join("graphics.json"));
            if self.source_file_link {
                assert!(source_link.unwrap().file_type().is_symlink());
            } else {
                assert_eq!(
                    source_link.unwrap_err().kind(),
                    std::io::ErrorKind::NotFound
                );
            }
            assert_eq!(
                fs::read(self.previous.path.join("engine.dll")).unwrap(),
                b"critical library"
            );
        }

        fn assert_committed_refusal(&self, journal: &LifecycleOperation) {
            self.assert_outside_and_source_intact();
            let retained = OperationStore::new(self.library.clone())
                .get(&journal.id)
                .unwrap()
                .expect("refused save transfer must retain its journal");
            assert_eq!(retained.kind, LifecycleOperationKind::Adopt);
            assert_eq!(retained.phase, journal.phase);
            assert_eq!(
                retained.install.as_ref().unwrap().id,
                journal.install.as_ref().unwrap().id
            );
            assert!(retained.last_error.as_deref().unwrap().contains("symlink"));
            let staged_user = retained.paths.staging.unwrap().join("user");
            assert_eq!(
                fs::read(staged_user.join("general.json")).unwrap(),
                b"incoming settings"
            );
            assert_eq!(
                fs::read(staged_user.join("saves/slot.bin")).unwrap(),
                b"incoming save"
            );
            assert!(!staged_user.join("graphics.json").exists());
            let active = self
                .library
                .status("zelda64-recomp", ReleaseChannel::Stable)
                .unwrap()
                .active
                .unwrap();
            assert_eq!(active.id, journal.install.as_ref().unwrap().id);
            assert!(
                Installer::new(self.library.clone())
                    .unwrap()
                    .verify(&active)
                    .unwrap()
                    .valid
            );
            assert_eq!(self.library.all_installs().unwrap().len(), 2);
            assert!(self.previous.path.is_dir());
        }

        fn assert_unrelated_save_retained(&self, link: &Path, retained: &Path) {
            let original_user = match self.user.strip_prefix(link) {
                Ok(relative) => retained.join(relative),
                Err(_) => self.user.clone(),
            };
            assert_eq!(
                fs::read(original_user.join("unrelated-save")).unwrap(),
                b"preserved unrelated save"
            );
        }

        fn correct_destination_and_recover(
            &self,
            link: &Path,
            retained: &Path,
            directory: bool,
            journal: &LifecycleOperation,
        ) {
            #[cfg(windows)]
            if directory {
                fs::remove_dir(link).unwrap();
            } else {
                fs::remove_file(link).unwrap();
            }
            #[cfg(unix)]
            {
                let _ = directory;
                fs::remove_file(link).unwrap();
            }
            fs::rename(retained, link).unwrap();
            PortcoveService::new(self.library.clone()).unwrap();
            assert!(
                OperationStore::new(self.library.clone())
                    .all()
                    .unwrap()
                    .is_empty()
            );
            assert!(!journal.paths.staging.as_ref().unwrap().exists());
            assert_eq!(
                fs::read(self.user.join("general.json")).unwrap(),
                b"incoming settings"
            );
            assert_eq!(
                fs::read(self.user.join("saves/slot.bin")).unwrap(),
                b"incoming save"
            );
            assert_eq!(
                fs::read(self.user.join("unrelated-save")).unwrap(),
                b"preserved unrelated save"
            );
            assert!(!self.user.join("graphics.json").exists());
            assert_eq!(
                self.library
                    .status("zelda64-recomp", ReleaseChannel::Stable)
                    .unwrap()
                    .active
                    .unwrap()
                    .id,
                journal.install.as_ref().unwrap().id
            );
            self.assert_outside_and_source_intact();
            assert_eq!(self.library.all_installs().unwrap().len(), 2);
        }
    }

    pub(super) fn create_adoption_test_symlink(target: &Path, link: &Path, directory: bool) {
        #[cfg(unix)]
        {
            let _ = directory;
            std::os::unix::fs::symlink(target, link).unwrap();
        }
        #[cfg(windows)]
        if directory {
            std::os::windows::fs::symlink_dir(target, link).unwrap_or_else(|error| {
                panic!(
                    "Windows directory symlink fixture requires a symlink-capable executor: {error}"
                )
            });
        } else {
            std::os::windows::fs::symlink_file(target, link).unwrap_or_else(|error| {
                panic!("Windows file symlink fixture requires a symlink-capable executor: {error}")
            });
        }
    }

    #[cfg(windows)]
    pub(super) fn create_adoption_test_junction(target: &Path, link: &Path) {
        let target = target.to_str().unwrap();
        let link = link.to_str().unwrap();
        for path in [target, link] {
            assert!(!path.contains(['"', '%', '!', '&', '|', '<', '>', '^', '\r', '\n']));
        }
        let mut command =
            ChildProcessPolicy::native_tool_spec(ChildProcessClass::HostTool, "cmd.exe").unwrap();
        command.raw_arg(format!("/D /V:OFF /C mklink /J \"{link}\" \"{target}\""));
        let started = std::time::Instant::now();
        let checkpoint = || {
            if started.elapsed() >= Duration::from_secs(2) {
                Err(PortcoveError::state(
                    "junction fixture construction exceeded two seconds",
                ))
            } else {
                Ok(())
            }
        };
        let mut final_capture = None;
        let output = crate::tool_process::run_tool(
            &mut command,
            &checkpoint,
            crate::tool_process::ToolProcessObserver {
                diagnostics: Some(crate::tool_process::ToolDiagnosticSink {
                    activity_id: "adoption-junction-fixture",
                    phase: "fixture.junction",
                    record: &mut |capture| {
                        final_capture = Some(capture.clone());
                        Ok(())
                    },
                }),
                quiesced: None,
            },
        )
        .unwrap();
        assert!(
            output.status.success(),
            "junction fixture construction failed: {}",
            output.output
        );
        let captured = final_capture.unwrap();
        assert!(captured.complete && !captured.stdout.truncated && !captured.stderr.truncated);
        assert_eq!(
            captured.stdout.text.len() + 1 + captured.stderr.text.len(),
            output.output.len()
        );
    }

    fn assert_adoption_refuses_destination_link(kind: AdoptionDestinationLink) {
        let fixture = AdoptionDestinationFixture::new(kind);
        let (link, retained, directory) = fixture.link_destination(kind);
        let service = service_with_release(fixture.library.clone(), "v2");
        let preview = service
            .preview_adoption(&fixture.source, Some("zelda64-recomp"))
            .unwrap();
        let authorization = service
            .authorize_adoption(
                &fixture.source,
                Some("zelda64-recomp"),
                &preview.plan_sha256,
            )
            .unwrap();
        let result = service.adopt(
            &fixture.source,
            Some("zelda64-recomp"),
            &authorization.token,
        );
        fixture.assert_outside_and_source_intact();
        let error = result.unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Conflict);
        assert!(error.message.contains("symlink"));
        let journal = OperationStore::new(fixture.library.clone())
            .all()
            .unwrap()
            .pop()
            .unwrap();
        assert_eq!(journal.phase, LifecyclePhase::MetadataCommitted);
        fixture.assert_committed_refusal(&journal);
        fixture.assert_unrelated_save_retained(&link, &retained);
        fixture.correct_destination_and_recover(&link, &retained, directory, &journal);
    }

    fn assert_adoption_recovery_refuses_destination_link(kind: AdoptionDestinationLink) {
        for phase in [
            LifecyclePhase::MetadataCommitted,
            LifecyclePhase::CleanupPending,
        ] {
            let fixture = AdoptionDestinationFixture::new(kind);
            let service = service_with_fault(
                fixture.library.clone(),
                LifecycleFaultPoint::AdoptionMetadataCommitted,
            );
            let preview = service
                .preview_adoption(&fixture.source, Some("zelda64-recomp"))
                .unwrap();
            let authorization = service
                .authorize_adoption(
                    &fixture.source,
                    Some("zelda64-recomp"),
                    &preview.plan_sha256,
                )
                .unwrap();
            let error = service
                .adopt(
                    &fixture.source,
                    Some("zelda64-recomp"),
                    &authorization.token,
                )
                .unwrap_err();
            assert!(error.message.contains("injected lifecycle failure"));
            let store = OperationStore::new(fixture.library.clone());
            let mut journal = store.all().unwrap().pop().unwrap();
            assert_eq!(journal.phase, LifecyclePhase::MetadataCommitted);
            journal.phase = phase;
            store.put(&mut journal).unwrap();
            let (link, retained, directory) = fixture.link_destination(kind);
            // Recovery must retain the persisted transfer while another owner holds the port.
            let held = fixture
                .library
                .try_lock_port("zelda64-recomp", "adoption-save-owner")
                .unwrap();
            PortcoveService::new(fixture.library.clone()).unwrap();
            assert_eq!(store.get(&journal.id).unwrap().unwrap().phase, phase);
            fixture.assert_outside_and_source_intact();
            drop(held);
            PortcoveService::new(fixture.library.clone()).unwrap();
            fixture.assert_committed_refusal(&journal);
            fixture.assert_unrelated_save_retained(&link, &retained);
            fixture.correct_destination_and_recover(&link, &retained, directory, &journal);
        }
    }

    #[test]
    fn adoption_refuses_existing_destination_file_link() {
        assert_adoption_refuses_destination_link(AdoptionDestinationLink::File);
    }

    #[test]
    fn adoption_refuses_existing_destination_directory_link() {
        assert_adoption_refuses_destination_link(AdoptionDestinationLink::Directory);
    }

    #[test]
    fn adoption_refuses_dangling_destination_file_link() {
        assert_adoption_refuses_destination_link(AdoptionDestinationLink::DanglingFile);
    }

    #[test]
    fn adoption_preview_refuses_destination_root_and_ancestor_links() {
        for kind in [
            AdoptionDestinationLink::Root,
            AdoptionDestinationLink::Ancestor,
        ] {
            let fixture = AdoptionDestinationFixture::new(kind);
            fixture.link_destination(kind);
            let service = service_with_release(fixture.library.clone(), "v2");
            assert_eq!(
                service
                    .preview_adoption(&fixture.source, Some("zelda64-recomp"))
                    .unwrap_err()
                    .code,
                crate::ErrorCode::Conflict
            );
            fixture.assert_outside_and_source_intact();
            assert!(
                OperationStore::new(fixture.library.clone())
                    .all()
                    .unwrap()
                    .is_empty()
            );
            assert_eq!(fixture.library.all_installs().unwrap().len(), 1);
        }
    }

    #[test]
    fn adoption_recovery_refuses_existing_destination_file_link() {
        assert_adoption_recovery_refuses_destination_link(AdoptionDestinationLink::File);
    }

    #[test]
    fn adoption_recovery_refuses_existing_destination_directory_link() {
        assert_adoption_recovery_refuses_destination_link(AdoptionDestinationLink::Directory);
    }

    #[test]
    fn adoption_recovery_refuses_dangling_destination_file_link() {
        assert_adoption_recovery_refuses_destination_link(AdoptionDestinationLink::DanglingFile);
    }

    #[test]
    fn adoption_recovery_refuses_existing_destination_root_link() {
        assert_adoption_recovery_refuses_destination_link(AdoptionDestinationLink::Root);
    }

    #[test]
    fn adoption_recovery_refuses_existing_destination_ancestor_link() {
        assert_adoption_recovery_refuses_destination_link(AdoptionDestinationLink::Ancestor);
    }

    #[cfg(windows)]
    #[test]
    fn adoption_refuses_existing_destination_directory_junction() {
        assert_adoption_refuses_destination_link(AdoptionDestinationLink::JunctionDirectory);
    }

    #[cfg(windows)]
    #[test]
    fn adoption_recovery_refuses_existing_destination_directory_junction() {
        assert_adoption_recovery_refuses_destination_link(
            AdoptionDestinationLink::JunctionDirectory,
        );
    }

    #[cfg(windows)]
    #[test]
    fn adoption_recovery_refuses_existing_destination_root_junction() {
        assert_adoption_recovery_refuses_destination_link(AdoptionDestinationLink::JunctionRoot);
    }

    #[test]
    fn adoption_execution_hashes_each_tree_only_at_required_boundaries() {
        const ASSET_COUNT: usize = 256;

        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let source = temporary.path().join("existing-install");
        let assets = source.join("assets");
        fs::create_dir_all(&assets).unwrap();
        write_host_test_executable(&source, "zelda64-recomp");
        for index in 0..ASSET_COUNT {
            fs::write(
                assets.join(format!("asset-{index:03}.bin")),
                format!("synthetic adoption asset {index}"),
            )
            .unwrap();
        }
        let user = library.user_dir("zelda64-recomp");
        fs::create_dir_all(&user).unwrap();
        fs::write(user.join("general.json"), b"current settings").unwrap();
        let service = service_with_release(library, "v2");
        let preview = service
            .preview_adoption(&source, Some("zelda64-recomp"))
            .unwrap();
        assert_eq!(
            preview
                .copy_plan
                .files
                .iter()
                .filter(|file| file.relative_path.starts_with("assets"))
                .count(),
            ASSET_COUNT
        );
        reset_adoption_copy_plan_passes();
        let authorization = service
            .authorize_adoption(&source, Some("zelda64-recomp"), &preview.plan_sha256)
            .unwrap();
        assert!(reset_adoption_copy_plan_passes().is_empty());

        reset_adoption_copy_plan_passes();
        service
            .adopt(&source, Some("zelda64-recomp"), &authorization.token)
            .unwrap();
        let execution_passes = reset_adoption_copy_plan_passes();

        assert_eq!(execution_passes.get(&source), Some(&1));
        assert_eq!(execution_passes.get(&user), Some(&2));
        assert_eq!(execution_passes.len(), 3);
        assert_eq!(execution_passes.values().sum::<usize>(), 4);
    }

    #[test]
    fn adoption_execution_rejects_changed_destination_or_saved_data_after_review() {
        for change_output in [true, false] {
            let temporary = tempfile::tempdir().unwrap();
            let library = Library::open(temporary.path().join("library")).unwrap();
            let source = temporary.path().join("existing-install");
            fs::create_dir_all(&source).unwrap();
            write_host_test_executable(&source, "zelda64-recomp");
            fs::write(source.join("general.json"), b"incoming settings").unwrap();
            let user = library.user_dir("zelda64-recomp");
            fs::create_dir_all(&user).unwrap();
            fs::write(user.join("general.json"), b"current settings").unwrap();
            let service = service_with_release(library.clone(), "v2");
            let preview = service
                .preview_adoption(&source, Some("zelda64-recomp"))
                .unwrap();
            let destination = preview.destination.as_ref().unwrap();
            assert_eq!(destination.output_location.user_data_root, user);
            assert_eq!(destination.current_user_data_files, 1);
            assert!(
                destination
                    .imported_user_data_paths
                    .contains(&PathBuf::from("general.json"))
            );
            if change_output {
                service
                    .set_output_directory("zelda64-recomp", &temporary.path().join("other-output"))
                    .unwrap();
            } else {
                fs::write(user.join("general.json"), b"newer settings").unwrap();
            }
            let authorization = service
                .authorize_adoption(&source, Some("zelda64-recomp"), &preview.plan_sha256)
                .unwrap();
            assert_eq!(
                service
                    .adopt(&source, Some("zelda64-recomp"), &authorization.token)
                    .unwrap_err()
                    .code,
                crate::ErrorCode::Conflict
            );
            assert!(service.status("zelda64-recomp").unwrap().active.is_none());
            assert_eq!(
                fs::read(source.join("general.json")).unwrap(),
                b"incoming settings"
            );
            assert_eq!(
                fs::read(user.join("general.json")).unwrap(),
                if change_output {
                    b"current settings".as_slice()
                } else {
                    b"newer settings".as_slice()
                }
            );
        }
    }

    #[test]
    fn adoption_review_matches_saved_data_merge_and_retains_existing_install() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let source = temporary.path().join("existing-install");
        fs::create_dir_all(&source).unwrap();
        write_host_test_executable(&source, "zelda64-recomp");
        fs::write(source.join("general.json"), b"incoming settings").unwrap();
        let service = service_with_release(library.clone(), "v2");
        let preview = service
            .preview_adoption(&source, Some("zelda64-recomp"))
            .unwrap();
        let authorization = service
            .authorize_adoption(&source, Some("zelda64-recomp"), &preview.plan_sha256)
            .unwrap();
        let previous = service
            .adopt(&source, Some("zelda64-recomp"), &authorization.token)
            .unwrap();
        fs::write(
            source.join("new-application-file"),
            b"different application version",
        )
        .unwrap();
        let user = library.user_dir("zelda64-recomp");
        fs::write(user.join("general.json"), b"current settings").unwrap();
        fs::write(user.join("unrelated-save"), b"preserved").unwrap();
        let preview = service
            .preview_adoption(&source, Some("zelda64-recomp"))
            .unwrap();
        let destination = preview.destination.as_ref().unwrap();
        assert_eq!(destination.active_install.as_ref().unwrap().id, previous.id);
        assert_eq!(destination.current_user_data_files, 2);
        let authorization = service
            .authorize_adoption(&source, Some("zelda64-recomp"), &preview.plan_sha256)
            .unwrap();
        let adopted = service
            .adopt(&source, Some("zelda64-recomp"), &authorization.token)
            .unwrap();
        assert_eq!(
            adopted.path.parent(),
            Some(
                fs::canonicalize(&destination.output_location.effective_output_directory)
                    .unwrap()
                    .as_path()
            )
        );
        assert_eq!(
            service.status("zelda64-recomp").unwrap().active.unwrap().id,
            adopted.id
        );
        assert!(previous.path.is_dir());
        assert_eq!(
            fs::read(user.join("general.json")).unwrap(),
            b"incoming settings"
        );
        assert_eq!(fs::read(user.join("unrelated-save")).unwrap(), b"preserved");
        assert_eq!(
            fs::read(source.join("general.json")).unwrap(),
            b"incoming settings"
        );
        assert!(
            service
                .list_backups("zelda64-recomp")
                .unwrap()
                .backups
                .is_empty()
        );
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

    fn assert_external_removal_recovers_after_quarantine_metadata_and_cleanup_boundaries(
        point: LifecycleFaultPoint,
    ) {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let default_install = register_zelda_install(&library, "v1", true);
        let output_root = temporary.path().join("external-output");
        crate::output_root::prepare_for_install(
            &library,
            "zelda64-recomp",
            &output_root,
            &Uuid::new_v4().to_string(),
            0,
        )
        .unwrap();
        let install = fs::canonicalize(&output_root)
            .unwrap()
            .join(default_install.file_name().unwrap());
        fs::rename(&default_install, &install).unwrap();
        let mut record = library
            .install_by_version("zelda64-recomp", "v1")
            .unwrap()
            .unwrap();
        record.path = install.clone();
        library.register_install(&record, true).unwrap();

        let service = service_with_fault(library.clone(), point);
        let authorization = removal_authorization(&service, "zelda64-recomp");
        let error = service
            .remove("zelda64-recomp", &authorization.token)
            .unwrap_err();
        assert!(error.message.contains("injected lifecycle failure"));

        let recovered = service_with_release(library.clone(), "v2");
        assert!(recovered.status("zelda64-recomp").unwrap().active.is_none());
        assert!(!install.exists());
        assert!(output_root.join(".portcove-game-output.json").is_file());
        assert!(recovered.repair_plan().unwrap().items.is_empty());
    }

    #[test]
    fn recovers_removal_quarantined() {
        assert_external_removal_recovers_after_quarantine_metadata_and_cleanup_boundaries(
            LifecycleFaultPoint::RemovalQuarantined,
        );
    }

    #[test]
    fn recovers_removal_metadata_committed() {
        assert_external_removal_recovers_after_quarantine_metadata_and_cleanup_boundaries(
            LifecycleFaultPoint::RemovalMetadataCommitted,
        );
    }

    #[test]
    fn recovers_removal_cleanup() {
        assert_external_removal_recovers_after_quarantine_metadata_and_cleanup_boundaries(
            LifecycleFaultPoint::RemovalCleanup,
        );
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
    fn tfe_recovery_hold_protects_inactive_versions_and_invalidates_earlier_removal_consent() {
        let began = std::time::Instant::now();
        let phase = |label| {
            eprintln!(
                "TFE recovery preservation: {label} at {:?}",
                began.elapsed()
            )
        };
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        phase("library opened");
        let inactive = register_zelda_install(&library, "v1", false);
        let active = register_zelda_install(&library, "v2", true);
        let service = service_with_release(library.clone(), "v2");
        let authorization = removal_authorization(&service, "zelda64-recomp");
        phase("two versions and prior authorization created");
        let recovery = inactive.join(".tfe-preparation/previous-data-fixture");
        fs::create_dir_all(&recovery).unwrap();
        fs::write(recovery.join("late-player-file"), b"retained recovery data").unwrap();
        let preview_error = service.preview_removal("zelda64-recomp").unwrap_err();
        assert_eq!(
            preview_error.failure.mutation_state,
            crate::MutationState::RecoveryRequired
        );
        let error = service
            .remove("zelda64-recomp", &authorization.token)
            .unwrap_err();
        assert_eq!(
            error.failure.mutation_state,
            crate::MutationState::RecoveryRequired
        );
        assert!(active.is_dir());
        phase("inactive capture held both preview and earlier authorization");
        assert_eq!(
            fs::read(recovery.join("late-player-file")).unwrap(),
            b"retained recovery data"
        );
        let preserved = temporary.path().join("manually-preserved");
        fs::rename(inactive.join(".tfe-preparation"), &preserved).unwrap();
        phase("manual preservation completed");
        let authorization = removal_authorization(&service, "zelda64-recomp");
        service
            .remove("zelda64-recomp", &authorization.token)
            .unwrap();
        phase("fresh guarded removal completed");
        assert!(!inactive.exists());
        assert!(!active.exists());
        assert_eq!(
            fs::read(preserved.join("previous-data-fixture/late-player-file")).unwrap(),
            b"retained recovery data"
        );
    }

    #[test]
    fn tfe_recovery_hold_survives_quarantine_reopen_and_committed_metadata_removal() {
        let began = std::time::Instant::now();
        for phase in [
            LifecyclePhase::Preparing,
            LifecyclePhase::PayloadPublished,
            LifecyclePhase::MetadataCommitted,
            LifecyclePhase::CleanupPending,
        ] {
            eprintln!(
                "TFE resumed removal: {phase:?} starting at {:?}",
                began.elapsed()
            );
            let temporary = tempfile::tempdir().unwrap();
            let library = Library::open(temporary.path().join("library")).unwrap();
            let install = register_zelda_install(&library, "v1", true);
            let service = service_with_release(library.clone(), "v2");
            let store = OperationStore::new(library.clone());
            let mut operation = LifecycleOperation::new(
                "tfe-recovery-hold",
                LifecycleOperationKind::Remove,
                "zelda64-recomp",
            );
            operation.paths.quarantine = Some(library.recovery_dir().join(&operation.id));
            operation.original_paths.push(install.clone());
            operation.removal_installs = Some(library.all_installs().unwrap());
            operation.phase = phase;
            let paths = crate::output_root::removal_paths(
                &library,
                "zelda64-recomp",
                &operation.id,
                &install,
            )
            .unwrap();
            fs::create_dir_all(paths.quarantined.parent().unwrap()).unwrap();
            fs::rename(&paths.live, &paths.quarantined).unwrap();
            let recovery = paths
                .quarantined
                .join(".tfe-preparation/previous-data-fixture");
            fs::create_dir_all(&recovery).unwrap();
            fs::write(
                recovery.join("late-player-file"),
                b"preserve after metadata deletion",
            )
            .unwrap();
            if matches!(
                phase,
                LifecyclePhase::MetadataCommitted | LifecyclePhase::CleanupPending
            ) {
                library.remove_port("zelda64-recomp").unwrap();
                assert!(library.all_installs().unwrap().is_empty());
            }
            store.put(&mut operation).unwrap();
            let error = service.recover_removal(&store, &mut operation).unwrap_err();
            assert_eq!(
                error.failure.mutation_state,
                crate::MutationState::RecoveryRequired
            );
            assert!(store.get(&operation.id).unwrap().is_some());
            let reopened = service_with_release(library.clone(), "v2");
            assert_eq!(
                fs::read(recovery.join("late-player-file")).unwrap(),
                b"preserve after metadata deletion"
            );
            assert!(store.get(&operation.id).unwrap().is_some());
            let preserved = temporary.path().join("manually-preserved");
            fs::rename(paths.quarantined.join(".tfe-preparation"), &preserved).unwrap();
            let mut resumed = store.get(&operation.id).unwrap().unwrap();
            reopened.recover_removal(&store, &mut resumed).unwrap();
            assert!(!paths.quarantined.exists());
            assert!(store.get(&operation.id).unwrap().is_none());
            assert_eq!(
                fs::read(preserved.join("previous-data-fixture/late-player-file")).unwrap(),
                b"preserve after metadata deletion"
            );
            eprintln!(
                "TFE resumed removal: {phase:?} preserved and completed at {:?}",
                began.elapsed()
            );
        }
    }

    #[test]
    fn tfe_recovery_created_after_quarantine_is_not_deleted_by_normal_remove() {
        struct CaptureAfterQuarantine {
            library: Library,
            version_name: std::ffi::OsString,
        }
        impl LifecycleFaultInjector for CaptureAfterQuarantine {
            fn check(&self, point: LifecycleFaultPoint) -> Result<()> {
                if point == LifecycleFaultPoint::RemovalQuarantined {
                    let operation = fs::read_dir(self.library.recovery_dir())?
                        .next()
                        .transpose()?
                        .unwrap()
                        .path();
                    let capture = operation
                        .join("zelda64-recomp")
                        .join(&self.version_name)
                        .join(".tfe-preparation/previous-data-fixture");
                    fs::create_dir_all(&capture)?;
                    fs::write(
                        capture.join("late-player-file"),
                        b"preserve after quarantine",
                    )?;
                }
                Ok(())
            }
        }
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let install = register_zelda_install(&library, "v1", true);
        let service = PortcoveService::with_provider_and_faults(
            library.clone(),
            Arc::new(StaticReleaseProvider {
                version: "v2".into(),
            }),
            Arc::new(CaptureAfterQuarantine {
                library: library.clone(),
                version_name: install.file_name().unwrap().to_owned(),
            }),
        )
        .unwrap();
        let authorization = removal_authorization(&service, "zelda64-recomp");
        let error = service
            .remove("zelda64-recomp", &authorization.token)
            .unwrap_err();
        assert_eq!(
            error.failure.mutation_state,
            crate::MutationState::RecoveryRequired
        );
        assert!(!install.exists());
        assert!(!library.all_installs().unwrap().is_empty());
        let held = PathBuf::from(&error.details["recovery_directory"]);
        assert_eq!(
            fs::read(held.join("previous-data-fixture/late-player-file")).unwrap(),
            b"preserve after quarantine"
        );
        assert!(!OperationStore::new(library).all().unwrap().is_empty());
    }

    #[test]
    fn rejected_removal_does_not_collect_live_data_before_authorization() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let install = register_zelda_install(&library, "v1", true);
        let user = library.user_dir("zelda64-recomp");
        fs::create_dir_all(&user).unwrap();
        fs::write(user.join("general.json"), b"canonical settings").unwrap();
        fs::write(install.join("general.json"), b"latest live settings").unwrap();
        fs::write(install.join(LAUNCH_MARKER), b"launched").unwrap();
        let service = service_with_release(library, "v2");

        let error = service
            .remove("zelda64-recomp", "invalid-token")
            .unwrap_err();

        assert_eq!(error.code, crate::ErrorCode::Conflict);
        assert_eq!(
            fs::read(user.join("general.json")).unwrap(),
            b"canonical settings"
        );
        assert_eq!(
            fs::read(install.join("general.json")).unwrap(),
            b"latest live settings"
        );
        assert!(install.is_dir());
        assert!(service.repair_plan().unwrap().items.is_empty());
    }

    #[test]
    fn removal_recovery_rejects_foreign_family_state_before_mutation() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let install = register_zelda_install(&library, "v1", true);
        fs::write(install.join("retained.txt"), b"installed bytes").unwrap();
        let service = service_with_release(library.clone(), "v2");
        let store = OperationStore::new(library.clone());
        let mut operation = LifecycleOperation::new(
            "foreign-family-removal",
            LifecycleOperationKind::Remove,
            "zelda64-recomp",
        );
        operation.paths.quarantine = Some(library.recovery_dir().join(&operation.id));
        operation.original_paths.push(install.clone());
        let active = library
            .status("zelda64-recomp", ReleaseChannel::Stable)
            .unwrap()
            .active
            .unwrap();
        let original = temporary.path().join("original.bin");
        let unrelated = temporary.path().join("unrelated.bin");
        let saved = library.user_dir("zelda64-recomp").join("saved.bin");
        fs::create_dir_all(saved.parent().unwrap()).unwrap();
        for path in [&original, &unrelated, &saved] {
            fs::write(path, b"preserved bytes").unwrap();
        }
        for case in 0..8 {
            let mut invalid = operation.clone();
            match case {
                0 => invalid.preparation_process_quiesced = Some(false),
                1 => invalid.preparation_process_quiesced = Some(true),
                2 => invalid.activate = true,
                3 => invalid.paths.staging = Some(unrelated.clone()),
                4 => invalid.paths.final_path = Some(unrelated.clone()),
                5 => invalid.phase = LifecyclePhase::Prepared,
                6 => invalid.paths.quarantine = Some(unrelated.clone()),
                7 => invalid.install = Some(active.clone()),
                _ => unreachable!(),
            }
            let mut persisted = if matches!(case, 0 | 1 | 7) {
                assert_eq!(
                    store.put(&mut invalid).unwrap_err().code,
                    crate::ErrorCode::State
                );
                // Invalid released bytes arrive through the codec, never the
                // checked writer. Preserve direct recovery and read-refusal proof.
                store.put(&mut operation).unwrap();
                library.connection().unwrap().execute(
                    "UPDATE lifecycle_operations SET preparation_process_quiesced=?2,install_json=?3 WHERE id=?1",
                    rusqlite::params![operation.id, invalid.preparation_process_quiesced.map(i64::from), invalid.install.as_ref().map(serde_json::to_string).transpose().unwrap()],
                ).unwrap();
                assert!(store.get(&operation.id).is_err());
                invalid.clone()
            } else {
                store.put(&mut invalid).unwrap();
                store.get(&operation.id).unwrap().unwrap()
            };
            let error = service.recover_removal(&store, &mut persisted).unwrap_err();
            assert_eq!(error.code, crate::ErrorCode::State);
            assert_eq!(
                fs::read(install.join("retained.txt")).unwrap(),
                b"installed bytes"
            );
            assert!(
                library
                    .status("zelda64-recomp", ReleaseChannel::Stable)
                    .unwrap()
                    .active
                    .is_some()
            );
            if matches!(case, 0 | 1 | 7) {
                assert!(store.get(&operation.id).is_err());
                let retained: (Option<i64>, Option<String>, String, Option<String>, i64) = library.connection().unwrap().query_row(
                    "SELECT preparation_process_quiesced,install_json,phase,quarantine_path,updated_at FROM lifecycle_operations WHERE id=?1",
                    [&operation.id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
                ).unwrap();
                assert_eq!(
                    retained,
                    (
                        invalid.preparation_process_quiesced.map(i64::from),
                        invalid
                            .install
                            .as_ref()
                            .map(serde_json::to_string)
                            .transpose()
                            .unwrap(),
                        operation.phase.to_string(),
                        operation
                            .paths
                            .quarantine
                            .as_ref()
                            .map(|path| path.to_str().unwrap().to_owned()),
                        operation.updated_at,
                    )
                );
            } else {
                let retained = store.get(&operation.id).unwrap().unwrap();
                assert_eq!(retained.phase, invalid.phase);
                assert_eq!(
                    retained.preparation_process_quiesced,
                    invalid.preparation_process_quiesced
                );
                assert_eq!(retained.updated_at, invalid.updated_at);
                assert_eq!(retained.paths.quarantine, invalid.paths.quarantine);
            }
            assert!(!library.recovery_dir().join(&operation.id).exists());
            for path in [&original, &unrelated, &saved] {
                assert_eq!(fs::read(path).unwrap(), b"preserved bytes");
            }
        }
        store.put(&mut operation).unwrap();
        let mut valid = store.get(&operation.id).unwrap().unwrap();
        service.recover_removal(&store, &mut valid).unwrap();
        assert!(store.get(&operation.id).unwrap().is_none());
        assert!(!install.exists());
        for path in [&original, &unrelated, &saved] {
            assert_eq!(fs::read(path).unwrap(), b"preserved bytes");
        }
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
    fn removal_recovery_does_not_promote_an_unstarted_legacy_intent() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let install = register_zelda_install(&library, "v1", true);
        let activity = library
            .begin_activity(
                ActivityOperation::Remove,
                ActivityTargetKind::Port,
                Some("zelda64-recomp"),
            )
            .unwrap();
        let store = OperationStore::new(library.clone());
        let mut operation = LifecycleOperation::new(
            &activity.id,
            LifecycleOperationKind::Remove,
            "zelda64-recomp",
        );
        operation.paths.quarantine = Some(library.recovery_dir().join(&activity.id));
        store.put(&mut operation).unwrap();

        let recovered = service_with_release(library.clone(), "v2");

        assert!(install.is_dir());
        assert!(recovered.status("zelda64-recomp").unwrap().active.is_some());
        assert!(recovered.repair_plan().unwrap().items.is_empty());
        let activities = library.activities(1).unwrap();
        assert_eq!(activities[0].status, ActivityStatus::Failed);
        assert!(
            activities[0]
                .message
                .as_deref()
                .unwrap()
                .contains("no versions were removed")
        );
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
    fn activation_recovery_refuses_foreign_family_before_mutation() {
        for phase in [LifecyclePhase::Preparing, LifecyclePhase::MetadataCommitted] {
            let temporary = tempfile::tempdir().unwrap();
            let library = Library::open(temporary.path().join("library")).unwrap();
            let active_path = register_zelda_install(&library, "v1", true);
            let staged_path = register_zelda_install(&library, "v2", false);
            let status = library
                .status("zelda64-recomp", ReleaseChannel::Stable)
                .unwrap();
            let staged = status.staged.unwrap();
            let mut operation = LifecycleOperation::new(
                format!("foreign-activation-{phase}"),
                LifecycleOperationKind::Activate,
                "zelda64-recomp",
            );
            operation.install = Some(staged.clone());
            operation.phase = phase;
            operation.preparation_process_quiesced = Some(true);
            if phase == LifecyclePhase::MetadataCommitted {
                library.activate_staged("zelda64-recomp").unwrap();
            }
            let expected_active = library
                .status("zelda64-recomp", ReleaseChannel::Stable)
                .unwrap()
                .active
                .unwrap()
                .id;
            fs::write(
                active_path.join("owned-preservation.txt"),
                b"original fixture bytes",
            )
            .unwrap();
            fs::write(
                staged_path.join("owned-preservation.txt"),
                b"staged fixture bytes",
            )
            .unwrap();
            let store = OperationStore::new(library.clone());
            assert_eq!(
                store.put(&mut operation).unwrap_err().code,
                crate::ErrorCode::State
            );
            let mut baseline = operation.clone();
            baseline.preparation_process_quiesced = None;
            store.put(&mut baseline).unwrap();
            library
                .connection()
                .unwrap()
                .execute(
                    "UPDATE lifecycle_operations SET preparation_process_quiesced=1 WHERE id=?1",
                    [&operation.id],
                )
                .unwrap();
            let row_snapshot = || {
                library
                    .connection()
                    .unwrap()
                    .query_row(
                        "SELECT * FROM lifecycle_operations WHERE id=?1",
                        [&operation.id],
                        |row| {
                            (0..row.as_ref().column_count())
                                .map(|index| row.get::<_, rusqlite::types::Value>(index))
                                .collect::<rusqlite::Result<Vec<_>>>()
                        },
                    )
                    .unwrap()
            };
            let before = row_snapshot();
            assert_eq!(
                PortcoveService::new(library.clone()).err().unwrap().code,
                crate::ErrorCode::State
            );
            let service = PortcoveService::new_read_only(library.clone()).unwrap();
            let mut rejected = operation.clone();
            assert!(crate::recovery::recover_activation(&service, &store, &mut rejected).is_err());
            assert_eq!(row_snapshot(), before);
            let after = library
                .status("zelda64-recomp", ReleaseChannel::Stable)
                .unwrap()
                .active
                .unwrap();
            assert!(
                store.get(&operation.id).is_err(),
                "{phase}: recovery retired incompatible journal; active version={}",
                after.version
            );
            assert_eq!(after.id, expected_active);
            assert_eq!(
                fs::read(active_path.join("owned-preservation.txt")).unwrap(),
                b"original fixture bytes"
            );
            assert_eq!(
                fs::read(staged_path.join("owned-preservation.txt")).unwrap(),
                b"staged fixture bytes"
            );
        }
    }

    #[test]
    fn activation_recovery_refuses_a_verified_foreign_copy_of_the_staged_tree() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        register_zelda_install(&library, "v1", true);
        let staged_path = register_zelda_install(&library, "v2", false);
        let status = library
            .status("zelda64-recomp", ReleaseChannel::Stable)
            .unwrap();
        let expected_active = status.active.unwrap().id;
        let mut foreign = status.staged.unwrap();
        let copied = library
            .versions_dir()
            .join("zelda64-recomp")
            .join("unregistered-owned-copy");
        copy_tree(&staged_path, &copied).unwrap();
        foreign.path = copied.clone();
        let service = service_with_release(library.clone(), "v2");
        let qualification = service
            .installed_mutability_qualification(&foreign)
            .unwrap();
        Installer::new(library.clone())
            .unwrap()
            .verify_critical(&foreign, &qualification)
            .unwrap();
        fs::write(
            copied.join("owned-preservation.txt"),
            b"foreign fixture bytes",
        )
        .unwrap();
        let mut operation = LifecycleOperation::new(
            "foreign-path-activation",
            LifecycleOperationKind::Activate,
            "zelda64-recomp",
        );
        operation.install = Some(foreign);
        let store = OperationStore::new(library.clone());
        store.put(&mut operation).unwrap();
        let _recovered = service_with_release(library.clone(), "v2");
        let after = library
            .status("zelda64-recomp", ReleaseChannel::Stable)
            .unwrap()
            .active
            .unwrap();
        assert_eq!(
            after.id, expected_active,
            "recovery activated despite the journal pointing to a foreign verified copy"
        );
        assert!(store.get(&operation.id).unwrap().is_some());
        assert_eq!(
            fs::read(copied.join("owned-preservation.txt")).unwrap(),
            b"foreign fixture bytes"
        );
        assert!(staged_path.is_dir());
    }

    #[test]
    fn activation_recovery_retains_ambiguous_envelopes_and_unused_phases() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let original = register_zelda_install(&library, "v1", true);
        let staged_path = register_zelda_install(&library, "v2", false);
        let status = library
            .status("zelda64-recomp", ReleaseChannel::Stable)
            .unwrap();
        let expected_active = status.active.unwrap().id;
        let staged = status.staged.unwrap();
        fs::write(
            original.join("owned-preservation.txt"),
            b"original fixture bytes",
        )
        .unwrap();
        let store = OperationStore::new(library.clone());
        for phase in [LifecyclePhase::Preparing, LifecyclePhase::MetadataCommitted] {
            for variation in [
                "owner",
                "activate",
                "staging",
                "final",
                "quarantine",
                "original",
                "quiescence",
            ] {
                let mut operation = LifecycleOperation::new(
                    format!("ambiguous-{phase}-{variation}"),
                    LifecycleOperationKind::Activate,
                    "zelda64-recomp",
                );
                operation.install = Some(staged.clone());
                operation.phase = phase;
                match variation {
                    "owner" => operation.install.as_mut().unwrap().port_id = "paperboat".into(),
                    "activate" => operation.activate = true,
                    "staging" => operation.paths.staging = Some(staged_path.clone()),
                    "final" => operation.paths.final_path = Some(staged_path.clone()),
                    "quarantine" => operation.paths.quarantine = Some(staged_path.clone()),
                    "original" => operation.original_paths.push(original.clone()),
                    "quiescence" => operation.preparation_process_quiesced = Some(false),
                    _ => unreachable!(),
                }
                if variation == "quiescence" {
                    assert_eq!(
                        store.put(&mut operation).unwrap_err().code,
                        crate::ErrorCode::State
                    );
                    let mut baseline = operation.clone();
                    baseline.preparation_process_quiesced = None;
                    store.put(&mut baseline).unwrap();
                    library.connection().unwrap().execute(
                        "UPDATE lifecycle_operations SET preparation_process_quiesced=0 WHERE id=?1", [&operation.id],
                    ).unwrap();
                    let row_snapshot = || {
                        library
                            .connection()
                            .unwrap()
                            .query_row(
                                "SELECT * FROM lifecycle_operations WHERE id=?1",
                                [&operation.id],
                                |row| {
                                    (0..row.as_ref().column_count())
                                        .map(|index| row.get::<_, rusqlite::types::Value>(index))
                                        .collect::<rusqlite::Result<Vec<_>>>()
                                },
                            )
                            .unwrap()
                    };
                    let before = row_snapshot();
                    assert_eq!(
                        PortcoveService::new(library.clone()).err().unwrap().code,
                        crate::ErrorCode::State
                    );
                    assert!(store.get(&operation.id).is_err());
                    let service = PortcoveService::new_read_only(library.clone()).unwrap();
                    let mut rejected = operation.clone();
                    assert!(
                        crate::recovery::recover_activation(&service, &store, &mut rejected)
                            .is_err()
                    );
                    assert_eq!(row_snapshot(), before);
                } else {
                    store.put(&mut operation).unwrap();
                    let _recovered = service_with_release(library.clone(), "v2");
                    let retained = store.get(&operation.id).unwrap().unwrap();
                    assert_eq!(retained.phase, phase, "{variation}");
                    assert!(retained.last_error.is_some(), "{variation}");
                }
                assert_eq!(
                    library
                        .status("zelda64-recomp", ReleaseChannel::Stable)
                        .unwrap()
                        .active
                        .unwrap()
                        .id,
                    expected_active
                );
                assert_eq!(
                    fs::read(original.join("owned-preservation.txt")).unwrap(),
                    b"original fixture bytes"
                );
                assert!(staged_path.is_dir());
                store.remove(&operation.id).unwrap();
            }
        }
        for phase in [
            LifecyclePhase::Prepared,
            LifecyclePhase::PayloadPublished,
            LifecyclePhase::CleanupPending,
        ] {
            let mut operation = LifecycleOperation::new(
                format!("unused-activation-{phase}"),
                LifecycleOperationKind::Activate,
                "zelda64-recomp",
            );
            operation.install = Some(staged.clone());
            operation.phase = phase;
            assert_eq!(
                store.put(&mut operation).unwrap_err().code,
                crate::ErrorCode::State
            );
            let mut baseline = operation.clone();
            baseline.phase = LifecyclePhase::Preparing;
            store.put(&mut baseline).unwrap();
            library
                .connection()
                .unwrap()
                .execute(
                    "UPDATE lifecycle_operations SET phase=?2 WHERE id=?1",
                    rusqlite::params![operation.id, phase.to_string()],
                )
                .unwrap();
            let row_snapshot = || {
                library
                    .connection()
                    .unwrap()
                    .query_row(
                        "SELECT * FROM lifecycle_operations WHERE id=?1",
                        [&operation.id],
                        |row| {
                            (0..row.as_ref().column_count())
                                .map(|index| row.get::<_, rusqlite::types::Value>(index))
                                .collect::<rusqlite::Result<Vec<_>>>()
                        },
                    )
                    .unwrap()
            };
            let before = row_snapshot();
            assert_eq!(
                PortcoveService::new(library.clone()).err().unwrap().code,
                crate::ErrorCode::State
            );
            assert!(store.get(&operation.id).is_err());
            let service = PortcoveService::new_read_only(library.clone()).unwrap();
            let mut rejected = operation.clone();
            assert!(crate::recovery::recover_activation(&service, &store, &mut rejected).is_err());
            assert_eq!(row_snapshot(), before);
            assert_eq!(
                library
                    .status("zelda64-recomp", ReleaseChannel::Stable)
                    .unwrap()
                    .active
                    .unwrap()
                    .id,
                expected_active
            );
            store.remove(&operation.id).unwrap();
        }
    }

    #[test]
    fn activation_checked_commit_refuses_changed_identity_and_repeated_transition() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        register_zelda_install(&library, "v1", true);
        register_zelda_install(&library, "v2", false);
        let service = service_with_release(library.clone(), "v2");
        let staged = library
            .status("zelda64-recomp", ReleaseChannel::Stable)
            .unwrap()
            .staged
            .unwrap();
        let store = OperationStore::new(library.clone());
        for variation in ["id", "created", "phase"] {
            let mut operation = LifecycleOperation::new(
                format!("checked-activation-{variation}"),
                LifecycleOperationKind::Activate,
                "zelda64-recomp",
            );
            operation.install = Some(staged.clone());
            store.put(&mut operation).unwrap();
            let mut activation =
                crate::recovery::ActivationOperation::decode(&service, &operation).unwrap();
            let original_id = operation.id.clone();
            match variation {
                "id" => operation.id.push_str("-changed"),
                "created" => operation.created_at += 1,
                "phase" => operation.phase = LifecyclePhase::MetadataCommitted,
                _ => unreachable!(),
            }
            assert!(activation.prepare_commit(&service, &mut operation).is_err());
            assert_eq!(
                store.get(&original_id).unwrap().unwrap().phase,
                LifecyclePhase::Preparing
            );
            assert_eq!(
                library
                    .status("zelda64-recomp", ReleaseChannel::Stable)
                    .unwrap()
                    .staged
                    .unwrap()
                    .id,
                staged.id
            );
            store.remove(&original_id).unwrap();
        }
        let mut operation = LifecycleOperation::new(
            "checked-activation-control",
            LifecycleOperationKind::Activate,
            "zelda64-recomp",
        );
        operation.install = Some(staged.clone());
        store.put(&mut operation).unwrap();
        let mut activation =
            crate::recovery::ActivationOperation::decode(&service, &operation).unwrap();
        // These mutable read-model flags may differ from the durable journal snapshot.
        operation.install.as_mut().unwrap().verified = false;
        operation.install.as_mut().unwrap().staged = false;
        let commit = activation.prepare_commit(&service, &mut operation).unwrap();
        library.activate_staged("zelda64-recomp").unwrap();
        commit.persist(&store).unwrap();
        assert_eq!(
            store.get(&operation.id).unwrap().unwrap().phase,
            LifecyclePhase::MetadataCommitted
        );
        assert!(activation.prepare_commit(&service, &mut operation).is_err());
        assert_eq!(
            store.get(&operation.id).unwrap().unwrap().phase,
            LifecyclePhase::MetadataCommitted
        );
        assert_eq!(
            library
                .status("zelda64-recomp", ReleaseChannel::Stable)
                .unwrap()
                .active
                .unwrap()
                .id,
            staged.id
        );
    }

    #[test]
    fn activation_committed_recovery_keeps_cleanup_only_legacy_behavior() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        register_zelda_install(&library, "v1", true);
        let old = register_zelda_install(&library, "v2", false);
        let error = service_with_fault(
            library.clone(),
            LifecycleFaultPoint::ActivationMetadataCommitted,
        )
        .activate_staged("zelda64-recomp")
        .unwrap_err();
        assert!(error.message.contains("injected lifecycle failure"));
        let store = OperationStore::new(library.clone());
        let operation = store
            .all()
            .unwrap()
            .into_iter()
            .find(|operation| operation.kind == LifecycleOperationKind::Activate)
            .unwrap();
        assert_eq!(operation.phase, LifecyclePhase::MetadataCommitted);
        let latest = register_zelda_install(&library, "v3", true);
        fs::remove_dir_all(&old).unwrap();
        fs::write(
            latest.join("owned-preservation.txt"),
            b"latest fixture bytes",
        )
        .unwrap();
        let _recovered = service_with_release(library.clone(), "v3");
        assert!(store.get(&operation.id).unwrap().is_none());
        assert_eq!(
            library
                .status("zelda64-recomp", ReleaseChannel::Stable)
                .unwrap()
                .active
                .unwrap()
                .version,
            "v3"
        );
        assert_eq!(
            fs::read(latest.join("owned-preservation.txt")).unwrap(),
            b"latest fixture bytes"
        );
        assert!(!old.exists());
    }

    #[test]
    fn activation_keeps_its_journal_when_the_committed_phase_write_fails() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        register_zelda_install(&library, "v1", true);
        register_zelda_install(&library, "v2", false);
        let service = service_with_release(library.clone(), "v2");
        library
            .connection()
            .unwrap()
            .execute_batch(
                "CREATE TRIGGER refuse_activation_phase_write BEFORE UPDATE ON lifecycle_operations
             WHEN NEW.phase = 'metadata_committed'
             BEGIN SELECT RAISE(ABORT, 'synthetic activation phase write failure'); END;",
            )
            .unwrap();
        let error = service.activate_staged("zelda64-recomp").unwrap_err();
        assert!(
            error
                .message
                .contains("synthetic activation phase write failure")
        );
        let store = OperationStore::new(library.clone());
        let operation = store
            .all()
            .unwrap()
            .into_iter()
            .find(|operation| operation.kind == LifecycleOperationKind::Activate)
            .unwrap();
        assert_eq!(operation.phase, LifecyclePhase::Preparing);
        assert_eq!(
            library
                .status("zelda64-recomp", ReleaseChannel::Stable)
                .unwrap()
                .active
                .unwrap()
                .version,
            "v2"
        );
        library
            .connection()
            .unwrap()
            .execute_batch("DROP TRIGGER refuse_activation_phase_write")
            .unwrap();
        let _recovered = service_with_release(library.clone(), "v2");
        assert!(store.get(&operation.id).unwrap().is_none());
        assert_eq!(
            library
                .status("zelda64-recomp", ReleaseChannel::Stable)
                .unwrap()
                .active
                .unwrap()
                .version,
            "v2"
        );
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

        let partial = plan
            .items
            .iter()
            .find(|item| item.kind == RepairItemKind::PartialOperation)
            .unwrap();
        assert!(partial.proposed_action.contains("restart Portcove"));
        assert!(partial.proposed_action.contains("doctor output"));
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

    #[test]
    fn repair_plan_reads_the_lifecycle_journal_once_independent_of_catalog_size() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let mut service = PortcoveService::new(library).unwrap();
        let embedded_port_count = service.catalog.ports().len();
        crate::operation::reset_all_read_count();
        service.repair_plan().unwrap();
        assert_eq!(crate::operation::all_read_count(), 1);

        let (expanded_catalog, _) = crate::test_fixture::post_client_catalog();
        assert_eq!(expanded_catalog.ports().len(), embedded_port_count + 1);
        service.replace_catalog_for_test(expanded_catalog);
        crate::operation::reset_all_read_count();
        service.repair_plan().unwrap();
        assert_eq!(crate::operation::all_read_count(), 1);
    }

    struct PauseRecoveryInventory {
        entered: mpsc::Sender<()>,
        proceed: Mutex<mpsc::Receiver<()>>,
    }

    impl LifecycleFaultInjector for PauseRecoveryInventory {
        fn check(&self, point: LifecycleFaultPoint) -> Result<()> {
            if point == LifecycleFaultPoint::RecoveryInventoried {
                self.entered.send(()).unwrap();
                self.proceed
                    .lock()
                    .unwrap()
                    .recv_timeout(Duration::from_secs(5))
                    .unwrap();
            }
            Ok(())
        }
    }

    #[test]
    fn recovery_does_not_recreate_a_journal_removed_after_inventory() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let id = Uuid::new_v4();
        let activity = library
            .begin_identified_activity(
                id,
                ActivityOperation::Remove,
                ActivityTargetKind::Port,
                Some("zelda64-recomp"),
            )
            .unwrap();
        let store = OperationStore::new(library.clone());
        let mut operation = LifecycleOperation::new(
            id.to_string(),
            LifecycleOperationKind::Remove,
            "zelda64-recomp",
        );
        operation.paths.quarantine = Some(library.recovery_dir().join(&operation.id));
        store.put(&mut operation).unwrap();

        let (entered, observed) = mpsc::channel();
        let (proceed, resume) = mpsc::channel();
        let recovery = PortcoveService::with_faults(
            library.clone(),
            Arc::new(PauseRecoveryInventory {
                entered,
                proceed: Mutex::new(resume),
            }),
        )
        .unwrap();
        let worker = thread::spawn(move || recovery.recover_lifecycle_operations_for_test());
        observed.recv_timeout(Duration::from_secs(5)).unwrap();
        store.remove(&operation.id).unwrap();
        proceed.send(()).unwrap();
        worker.join().unwrap().unwrap();

        assert!(store.get(&operation.id).unwrap().is_none());
        assert_eq!(library.activities(1).unwrap()[0].id, activity.id);
        assert_eq!(
            library.activities(1).unwrap()[0].status,
            ActivityStatus::Running
        );
    }

    #[test]
    fn recovery_uses_fresh_phase_and_skips_changed_lock_ownership() {
        for change in ["phase", "kind", "owner", "identity"] {
            let temporary = tempfile::tempdir().unwrap();
            let library = Library::open(temporary.path().join("library")).unwrap();
            let store = OperationStore::new(library.clone());
            let mut operation = LifecycleOperation::new(
                Uuid::new_v4().to_string(),
                LifecycleOperationKind::Remove,
                "zelda64-recomp",
            );
            operation.paths.quarantine = Some(library.recovery_dir().join(&operation.id));
            store.put(&mut operation).unwrap();
            let (entered, observed) = mpsc::channel();
            let (proceed, resume) = mpsc::channel();
            let recovery = PortcoveService::with_faults(
                library.clone(),
                Arc::new(PauseRecoveryInventory {
                    entered,
                    proceed: Mutex::new(resume),
                }),
            )
            .unwrap();
            let worker = thread::spawn(move || recovery.recover_lifecycle_operations_for_test());
            observed.recv_timeout(Duration::from_secs(5)).unwrap();
            match change {
                "phase" => operation.phase = LifecyclePhase::CleanupPending,
                "kind" => operation.kind = LifecycleOperationKind::Install,
                "owner" => operation.port_id = "paperboat".into(),
                "identity" => {
                    crate::database::connect(library.root())
                        .unwrap()
                        .execute(
                            "UPDATE lifecycle_operations SET created_at=created_at-1 WHERE id=?1",
                            [&operation.id],
                        )
                        .unwrap();
                }
                _ => unreachable!(),
            }
            if change != "identity" {
                store.put(&mut operation).unwrap();
            }
            proceed.send(()).unwrap();
            worker.join().unwrap().unwrap();
            assert_eq!(
                store.get(&operation.id).unwrap().is_none(),
                change == "phase",
                "{change}"
            );
        }
    }

    #[test]
    fn second_recovery_client_can_complete_while_first_waits_after_inventory() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let id = Uuid::new_v4();
        library
            .begin_identified_activity(
                id,
                ActivityOperation::Remove,
                ActivityTargetKind::Port,
                Some("zelda64-recomp"),
            )
            .unwrap();
        let store = OperationStore::new(library.clone());
        let mut operation = LifecycleOperation::new(
            id.to_string(),
            LifecycleOperationKind::Remove,
            "zelda64-recomp",
        );
        operation.paths.quarantine = Some(library.recovery_dir().join(&operation.id));
        store.put(&mut operation).unwrap();
        let (entered, observed) = mpsc::channel();
        let (proceed, resume) = mpsc::channel();
        let recovery = PortcoveService::with_faults(
            library.clone(),
            Arc::new(PauseRecoveryInventory {
                entered,
                proceed: Mutex::new(resume),
            }),
        )
        .unwrap();
        let worker = thread::spawn(move || recovery.recover_lifecycle_operations_for_test());
        observed.recv_timeout(Duration::from_secs(5)).unwrap();
        PortcoveService::new(library.clone()).unwrap();
        proceed.send(()).unwrap();
        worker.join().unwrap().unwrap();
        assert!(store.get(&operation.id).unwrap().is_none());
        assert_eq!(
            library.activities(1).unwrap()[0].status,
            ActivityStatus::Failed
        );
    }

    #[test]
    fn read_only_construction_and_live_worker_preserve_an_orphan_until_explicit_retry() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let store = OperationStore::new(library.clone());
        let mut operation = LifecycleOperation::new(
            Uuid::new_v4().to_string(),
            LifecycleOperationKind::Remove,
            "zelda64-recomp",
        );
        operation.paths.quarantine = Some(library.recovery_dir().join(&operation.id));
        store.put(&mut operation).unwrap();

        let observer = PortcoveService::new_read_only(library.clone()).unwrap();
        observer.statuses().unwrap();
        observer.repair_plan().unwrap();
        assert!(store.get(&operation.id).unwrap().is_some());

        let worker_guard = library
            .try_lock_port("zelda64-recomp", "live-worker")
            .unwrap();
        observer.recover_pending_operations().unwrap();
        assert!(store.get(&operation.id).unwrap().is_some());
        drop(worker_guard);
        observer.recover_pending_operations().unwrap();
        assert!(store.get(&operation.id).unwrap().is_none());
    }

    #[cfg(windows)]
    #[test]
    fn repair_plan_matches_extended_registered_paths_without_hiding_real_orphans() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let active = library.versions_dir().join("zelda64-recomp").join("active");
        fs::create_dir_all(&active).unwrap();
        write_host_test_executable(&active, "zelda64-recomp");
        fs::write(active.join("engine.dll"), b"critical library").unwrap();
        let extended_active = PathBuf::from(format!(r"\\?\{}", active.display()));
        register_existing_test_install(
            &library,
            "zelda64-recomp",
            "extended-path",
            &extended_active,
            true,
        );
        let orphan = library.versions_dir().join("zelda64-recomp").join("orphan");
        fs::create_dir_all(&orphan).unwrap();
        let service = service_with_release(library, "v2");

        let plan = service.repair_plan().unwrap();
        let orphaned = plan
            .items
            .iter()
            .filter(|item| item.kind == RepairItemKind::OrphanedFinalDirectory)
            .collect::<Vec<_>>();

        assert_eq!(orphaned.len(), 1);
        assert_eq!(orphaned[0].path.as_deref(), Some(orphan.as_path()));
        assert!(active.is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn repair_plan_reports_a_link_to_an_active_install_as_an_orphan() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let active = register_zelda_install(&library, "active", true);
        let linked = library
            .versions_dir()
            .join("zelda64-recomp")
            .join("linked-orphan");
        std::os::unix::fs::symlink(&active, &linked).unwrap();
        let service = service_with_release(library, "v2");

        let plan = service.repair_plan().unwrap();

        assert!(plan.items.iter().any(|item| {
            item.kind == RepairItemKind::OrphanedFinalDirectory
                && item.path.as_deref() == Some(linked.as_path())
        }));
        assert!(active.is_dir());
        assert!(
            fs::symlink_metadata(&linked)
                .unwrap()
                .file_type()
                .is_symlink()
        );
    }

    #[cfg(windows)]
    #[test]
    fn repair_plan_retains_missing_and_partial_items_for_unavailable_paths() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let install = register_zelda_install(&library, "unavailable", true);
        let mut unavailable_text = String::from_iter(['\\', '\\', '?', '\\']);
        unavailable_text.push_str(r"Volume{00000000-0000-0000-0000-000000000000}\portcove\missing");
        let unavailable = PathBuf::from(unavailable_text);
        rusqlite::Connection::open(library.root().join("portcove.sqlite3"))
            .unwrap()
            .execute(
                "UPDATE installs SET path=?1 WHERE path=?2",
                rusqlite::params![unavailable.to_string_lossy(), install.to_string_lossy()],
            )
            .unwrap();
        let store = OperationStore::new(library.clone());
        let mut operation = LifecycleOperation::new(
            "unavailable-publication",
            LifecycleOperationKind::Install,
            "zelda64-recomp",
        );
        operation.paths.final_path = Some(unavailable.join("pending"));
        store.put(&mut operation).unwrap();
        let service = service_with_release(library, "v2");

        let plan = service.repair_plan().unwrap();

        assert!(plan.items.iter().any(|item| {
            item.kind == RepairItemKind::MissingRegisteredPath
                && item.path.as_deref() == Some(unavailable.as_path())
        }));
        assert!(plan.items.iter().any(|item| {
            item.kind == RepairItemKind::PartialOperation
                && item.operation_id.as_deref() == Some("unavailable-publication")
        }));
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
    fn workspace_snapshot_hydrates_the_essential_read_model() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let service = PortcoveService::new(library).unwrap();

        let snapshot = service.workspace_snapshot(50).unwrap();

        assert_eq!(
            serde_json::to_value(&snapshot.catalog).unwrap(),
            serde_json::to_value(service.catalog().document()).unwrap()
        );
        assert_eq!(snapshot.statuses.len(), snapshot.catalog.ports.len());
        assert!(snapshot.sources.is_empty());
        assert!(snapshot.activities.records.is_empty());
        let browsing = snapshot.browsing.unwrap();
        assert_eq!(browsing.host_platform, Platform::current().unwrap());
        assert_eq!(
            browsing.library,
            service.library().identity_record().unwrap()
        );
        assert!(browsing.retained_metadata_complete);
        assert!(!browsing.contexts.is_empty());
        assert!(
            browsing
                .contexts
                .iter()
                .all(|context| !context.member_context && !context.port_member)
        );
    }

    #[test]
    fn workspace_snapshot_does_not_mix_concurrent_activity_completion_and_start() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let old = library
            .begin_activity(
                ActivityOperation::Install,
                ActivityTargetKind::Port,
                Some("zelda64-recomp"),
            )
            .unwrap();
        let service = PortcoveService::new(library.clone()).unwrap();
        let (start_writer, writer_started) = mpsc::channel();
        let (writer_finished, wait_for_writer) = mpsc::channel();
        let (send_ids, receive_ids) = mpsc::channel();
        let writer = thread::spawn(move || {
            writer_started.recv().unwrap();
            library
                .finish_activity(&old.id, ActivityStatus::Succeeded, None)
                .unwrap();
            let next = library
                .begin_activity(
                    ActivityOperation::Update,
                    ActivityTargetKind::Port,
                    Some("zelda64-recomp"),
                )
                .unwrap();
            send_ids.send((old.id, next.id)).unwrap();
            writer_finished.send(()).unwrap();
        });

        let snapshot = service
            .workspace_snapshot_with_read_barrier(50, || {
                start_writer.send(()).unwrap();
                wait_for_writer.recv().unwrap();
            })
            .unwrap();
        let (old_id, next_id) = receive_ids.recv().unwrap();
        writer.join().unwrap();

        assert_eq!(
            snapshot.activities.current_activity_ids.as_slice(),
            std::slice::from_ref(&next_id)
        );
        assert_eq!(
            snapshot
                .activities
                .records
                .iter()
                .filter(|record| record.id == next_id)
                .count(),
            1
        );
        assert!(
            snapshot.activities.records.iter().any(|record| {
                record.id == old_id && record.status == ActivityStatus::Succeeded
            })
        );

        let refreshed = service.workspace_snapshot(50).unwrap();
        assert_eq!(
            refreshed.activities.current_activity_ids.as_slice(),
            std::slice::from_ref(&next_id)
        );
        assert_eq!(
            refreshed
                .activities
                .records
                .iter()
                .filter(|record| record.id == next_id)
                .count(),
            1
        );
        assert!(
            refreshed.activities.records.iter().any(|record| {
                record.id == old_id && record.status == ActivityStatus::Succeeded
            })
        );
    }

    #[test]
    fn workspace_snapshot_uses_one_durable_library_revision_during_cli_write() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        register_zelda_install(&library, "before", true);
        register_zelda_install(&library, "after", false);
        let service = PortcoveService::new(library.clone()).unwrap();
        let (start_writer, writer_started) = mpsc::channel();
        let (writer_finished, wait_for_writer) = mpsc::channel();
        let writer = thread::spawn(move || {
            writer_started.recv().unwrap();
            library.activate_staged("zelda64-recomp").unwrap();
            library
                .connection()
                .unwrap()
                .execute(
                    "UPDATE definition_selection_state SET revision=revision+1 WHERE singleton=1",
                    [],
                )
                .unwrap();
            writer_finished.send(()).unwrap();
        });

        let snapshot = service
            .workspace_snapshot_with_read_barrier(50, || {
                start_writer.send(()).unwrap();
                wait_for_writer.recv().unwrap();
            })
            .unwrap();
        writer.join().unwrap();

        let status = snapshot
            .statuses
            .iter()
            .find(|status| status.port_id == "zelda64-recomp")
            .unwrap();
        assert_eq!(status.active.as_ref().unwrap().version, "after");
        assert_eq!(status.previous.as_ref().unwrap().version, "before");
        assert!(status.staged.is_none());
    }

    #[test]
    fn workspace_snapshot_retries_source_and_port_removal_without_mixing_rows() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        register_zelda_install(&library, "installed", true);
        library
            .register_source(&SourceRecord {
                profile_id: "snapshot-source".into(),
                path: temporary.path().join("source.bin"),
                sha256: "a".repeat(64),
                size: 1,
                storage_sha256: "a".repeat(64),
                storage_size: 1,
                updated_at: 7,
                observed_identity: None,
            })
            .unwrap();
        let service = PortcoveService::new(library.clone()).unwrap();
        let (start_writer, writer_started) = mpsc::channel();
        let (writer_finished, wait_for_writer) = mpsc::channel();
        let writer = thread::spawn(move || {
            writer_started.recv().unwrap();
            library.remove_source("snapshot-source").unwrap();
            library.remove_port("zelda64-recomp").unwrap();
            writer_finished.send(()).unwrap();
        });

        let snapshot = service
            .workspace_snapshot_with_read_barrier(50, || {
                start_writer.send(()).unwrap();
                wait_for_writer.recv().unwrap();
            })
            .unwrap();
        writer.join().unwrap();

        assert!(snapshot.sources.is_empty());
        let status = snapshot
            .statuses
            .iter()
            .find(|status| status.port_id == "zelda64-recomp")
            .unwrap();
        assert!(status.active.is_none());
        assert!(status.previous.is_none());
        assert!(status.staged.is_none());
    }

    #[test]
    fn workspace_snapshot_decode_error_releases_its_read_transaction() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let service = PortcoveService::new(library.clone()).unwrap();
        library
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO port_settings(port_id, channel, update_policy)
                 VALUES ('zelda64-recomp', 'invalid', 'notify')",
                [],
            )
            .unwrap();

        let error = service.workspace_snapshot(50).unwrap_err();
        assert!(error.message.contains("unknown release channel"));

        library
            .connection()
            .unwrap()
            .execute(
                "UPDATE port_settings SET channel='stable'
                 WHERE port_id='zelda64-recomp'",
                [],
            )
            .unwrap();
        assert!(service.workspace_snapshot(50).is_ok());
    }

    #[test]
    fn workspace_snapshot_bounds_retries_during_sustained_writes() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let service = PortcoveService::new(library.clone()).unwrap();
        let revisions = AtomicUsize::new(0);

        let error = service
            .workspace_snapshot_with_barriers(
                50,
                || {},
                |_| {
                    let revision = revisions.fetch_add(1, Ordering::SeqCst);
                    library
                        .connection()
                        .unwrap()
                        .execute(
                            "INSERT INTO port_settings(port_id, channel, update_policy)
                             VALUES ('zelda64-recomp', 'stable', ?1)
                             ON CONFLICT(port_id) DO UPDATE SET update_policy=excluded.update_policy",
                            [if revision == 0 { "stage" } else { "automatic" }],
                        )
                        .unwrap();
                },
            )
            .unwrap_err();

        assert_eq!(revisions.load(Ordering::SeqCst), 2);
        assert_eq!(error.code, crate::ErrorCode::Conflict);
        assert_eq!(
            error
                .details
                .get("workspace_snapshot_stale")
                .map(String::as_str),
            Some("true")
        );
        assert!(service.workspace_snapshot(50).is_ok());
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
                .find(|status| status.port_id == "tomba-recompiled")
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
        use crate::test_fixture::phase;
        let temporary = tempfile::tempdir().unwrap();
        let library = phase("policy fixture: library open", || {
            Library::open(temporary.path().join("library"))
        })
        .unwrap();
        let service = phase("policy fixture: service open", || {
            PortcoveService::new(library.clone())
        })
        .unwrap();

        let status = phase("policy fixture: set policy", || {
            service.set_update_policy("tomba-recompiled", UpdatePolicy::Stage)
        })
        .unwrap();

        assert_eq!(status.channel, ReleaseChannel::Beta);
        assert_eq!(status.update_policy, UpdatePolicy::Stage);
        assert_eq!(
            phase("policy fixture: read status", || library
                .status("tomba-recompiled", ReleaseChannel::Stable))
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
        write_host_test_executable_with_contents(root, port_id, b"test")
    }

    fn write_host_test_executable_with_contents(
        root: &Path,
        port_id: &str,
        contents: &[u8],
    ) -> PathBuf {
        let catalog = Catalog::embedded().unwrap();
        let port = catalog.port(port_id).unwrap();
        let platform = Platform::current().unwrap();
        let executable_name = port
            .executable_hints
            .get(&platform)
            .and_then(|hints| hints.first())
            .unwrap();
        let executable = root.join(executable_name);
        fs::write(&executable, contents).unwrap();
        crate::permissions::normalize_archive_entry(&executable, false, true).unwrap();
        executable
    }

    fn tamper_host_test_executable(path: &Path, replacement: &[u8]) {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            let _ = replacement;
            fs::set_permissions(path, fs::Permissions::from_mode(0o644)).unwrap();
        }
        #[cfg(not(unix))]
        fs::write(path, replacement).unwrap();
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
            crate::test_fixture::retained_qualification(port, Platform::current().unwrap())
                .unwrap();
        let (manifest_sha256, selected_executable, runtime) = Installer::new(library.clone())
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
            runtime,
        };
        library.register_install(&install, active).unwrap();
        install
    }

    pub(super) fn register_zelda_install(
        library: &Library,
        version: &str,
        active: bool,
    ) -> PathBuf {
        register_zelda_install_with_executable(library, version, active, b"test")
    }

    fn register_zelda_install_with_executable(
        library: &Library,
        version: &str,
        active: bool,
        executable_contents: &[u8],
    ) -> PathBuf {
        register_zelda_install_contract(library, version, active, executable_contents, None)
    }

    fn register_zelda_install_contract(
        library: &Library,
        version: &str,
        active: bool,
        executable_contents: &[u8],
        catalog: Option<&Catalog>,
    ) -> PathBuf {
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
        write_host_test_executable_with_contents(&path, "zelda64-recomp", executable_contents);
        fs::write(path.join("engine.dll"), b"critical library").unwrap();
        let id = Uuid::new_v4().to_string();
        let port = Catalog::embedded()
            .unwrap()
            .port("zelda64-recomp")
            .unwrap()
            .clone();
        let qualification = match catalog {
            Some(catalog) => {
                InstallQualification::from_catalog(catalog, &port.id, Platform::current().unwrap())
                    .unwrap()
            }
            None => {
                crate::test_fixture::retained_qualification(&port, Platform::current().unwrap())
                    .unwrap()
            }
        };
        let (manifest_sha256, selected_executable, runtime) = Installer::new(library.clone())
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
                    runtime,
                },
                active,
            )
            .unwrap();
        path
    }

    #[tokio::test]
    async fn unavailable_artwork_does_not_block_reviewed_install_update_or_supervised_launch() {
        let trace_started = std::time::Instant::now();
        let trace_phase = |phase: &str| {
            eprintln!("unavailable artwork {phase}: {:?}", trace_started.elapsed());
        };
        trace_phase("fixture started");
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("library");
        let library = Library::open(&root).unwrap();
        trace_phase("first fixture compile begins");
        let first = register_launch_probe(&library, "v1", false);
        trace_phase("first fixture compiled");
        let service = PortcoveService::with_provider(
            library.clone(),
            Arc::new(RepublishedReleaseProvider {
                version: "v1".into(),
                sha256: first.artifact.sha256.clone(),
            }),
        )
        .unwrap();
        let png = temporary.path().join("cover.png");
        image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
            12,
            24,
            image::Rgb([24, 80, 160]),
        ))
        .save(&png)
        .unwrap();
        let selected = service
            .import_artwork("zelda64-recomp", crate::ArtworkSlot::Cover, &png, 0)
            .unwrap();
        let detail_png = temporary.path().join("detail.png");
        image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
            12,
            24,
            image::Rgb([160, 80, 24]),
        ))
        .save(&detail_png)
        .unwrap();
        let detail_before = service
            .import_artwork("zelda64-recomp", crate::ArtworkSlot::Detail, &detail_png, 0)
            .unwrap();
        assert_ne!(
            selected.choice.asset_sha256,
            detail_before.choice.asset_sha256
        );
        let original = crate::artwork::original_path(
            &library,
            selected.choice.asset_sha256.as_deref().unwrap(),
        )
        .unwrap();
        fs::remove_file(&original).unwrap();
        let unavailable = service
            .artwork("zelda64-recomp", crate::ArtworkSlot::Cover)
            .unwrap();
        assert_eq!(
            unavailable.availability,
            crate::ArtworkAvailability::Unavailable
        );
        assert_eq!(unavailable.choice, selected.choice);
        assert!(
            service
                .artwork_thumbnail(
                    "zelda64-recomp",
                    crate::ArtworkSlot::Cover,
                    selected.choice.revision
                )
                .is_err()
        );

        let review = service.plan_game_install("zelda64-recomp").await.unwrap();
        assert_eq!(review.plan.action, crate::InstallPlanAction::UseStaged);
        assert_eq!(review.selected_install.as_ref().unwrap().id, first.id);
        let grant = service
            .authorize_game_install("zelda64-recomp", &review.plan_sha256)
            .await
            .unwrap();
        let installed = service
            .apply_game_install("zelda64-recomp", &grant.token, |_| {})
            .await
            .unwrap();
        trace_phase("reviewed install applied");
        assert_eq!(installed.id, first.id);
        assert_eq!(
            service.status("zelda64-recomp").unwrap().active.unwrap().id,
            first.id
        );
        assert_eq!(
            service
                .artwork("zelda64-recomp", crate::ArtworkSlot::Cover)
                .unwrap()
                .choice,
            selected.choice
        );
        drop(service);

        trace_phase("second fixture compile begins");
        let second = register_launch_probe(&library, "v2", false);
        trace_phase("second fixture compiled");
        let service = PortcoveService::with_provider(
            library.clone(),
            Arc::new(RepublishedReleaseProvider {
                version: "v2".into(),
                sha256: second.artifact.sha256.clone(),
            }),
        )
        .unwrap();
        let review = service
            .plan_game_update("zelda64-recomp", true)
            .await
            .unwrap();
        assert_eq!(review.plan.action, crate::InstallPlanAction::UseStaged);
        assert_eq!(
            review.assessment.availability,
            crate::PortActionAvailability::Allowed
        );
        let grant = service
            .authorize_game_update("zelda64-recomp", true, &review.plan_sha256)
            .await
            .unwrap();
        service
            .apply_game_update("zelda64-recomp", true, &grant.token, |_| {})
            .await
            .unwrap();
        trace_phase("reviewed update applied");
        let status = service.status("zelda64-recomp").unwrap();
        assert_eq!(status.active.unwrap().id, second.id);
        assert_eq!(status.previous.unwrap().id, first.id);
        assert_eq!(
            service
                .artwork("zelda64-recomp", crate::ArtworkSlot::Cover)
                .unwrap()
                .choice,
            selected.choice
        );

        let started = temporary.path().join("started");
        let outcome = service
            .supervise_launch(
                "zelda64-recomp",
                None,
                &[
                    started.display().to_string(),
                    "0".into(),
                    "saved-without-artwork".into(),
                    "0".into(),
                ],
                LaunchStdio::Null,
                |_| {},
            )
            .unwrap();
        trace_phase("supervised launch completed");
        assert!(outcome.successful);
        assert_eq!(outcome.exit_code, Some(0));
        assert!(started.is_file());
        assert_eq!(
            fs::read(library.user_dir("zelda64-recomp").join("general.json")).unwrap(),
            b"saved-without-artwork"
        );
        assert!(library.launch_sessions().unwrap().is_empty());
        assert_eq!(
            service
                .status("zelda64-recomp")
                .unwrap()
                .successful_launches,
            1
        );
        let request = library
            .launch_request(&outcome.session_id)
            .unwrap()
            .unwrap();
        assert_eq!(request.install_id, second.id);
        assert_eq!(request.install_root, second.path);
        assert_eq!(request.outcome, Some(LaunchSessionOutcome::Succeeded));
        assert_eq!(request.exit_code, Some(0));
        assert!(request.finished_at.is_some());
        drop(service);
        drop(library);
        let reopened = PortcoveService::new(Library::open(&root).unwrap()).unwrap();
        assert_eq!(
            reopened
                .status("zelda64-recomp")
                .unwrap()
                .active
                .unwrap()
                .id,
            second.id
        );
        trace_phase("library reopened");
        let retained = reopened
            .artwork("zelda64-recomp", crate::ArtworkSlot::Cover)
            .unwrap();
        assert_eq!(
            retained.availability,
            crate::ArtworkAvailability::Unavailable
        );
        assert_eq!(retained.choice, selected.choice);
        assert_eq!(retained.selection, selected.selection);
        let detail_after = reopened
            .artwork("zelda64-recomp", crate::ArtworkSlot::Detail)
            .unwrap();
        assert_eq!(
            detail_after.availability,
            crate::ArtworkAvailability::Available
        );
        assert_eq!(detail_after.choice, detail_before.choice);
        assert_eq!(detail_after.selection, detail_before.selection);
        assert!(png.is_file());
        assert!(detail_png.is_file());
        trace_phase("retained slots verified");
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

    // Admit an inert regular-file runtime through the production review path;
    // these status tests grant no executable or gameplay qualification.
    #[test]
    fn external_relink_preserves_retained_identity_when_current_catalog_changes() {
        let (temporary, mut service, record) = external_location_fixture();
        let before = service.library.connection().unwrap().query_row(
            "SELECT retained_catalog_json, registered_at FROM external_runtime_registrations WHERE port_id=?1",
            [&record.port_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        ).unwrap();
        let moved = temporary.path().join("moved-player-folder");
        fs::rename(&record.path, &moved).unwrap();
        fs::write(moved.join("player-save"), b"keep my save").unwrap();
        // The retained registration survives even if this ID leaves the current catalog.
        service.replace_catalog_for_test(Catalog::embedded().unwrap());
        let preview = service
            .preview_external_runtime_relink(&record.port_id, &moved)
            .unwrap();
        assert_eq!(preview.previous_path, record.path);
        assert!(preview.external_files_will_be_preserved);
        let authorization = service
            .authorize_external_runtime_relink(
                &record.port_id,
                &moved,
                &preview.preview_sha256,
                None,
            )
            .unwrap();
        let relinked = service
            .relink_external_runtime(&record.port_id, &moved, &authorization.token)
            .unwrap();
        assert_eq!(relinked.id, record.id);
        assert_eq!(relinked.registered_at, record.registered_at);
        assert_eq!(relinked.version, record.version);
        assert_eq!(relinked.immutable_tree_sha256, record.immutable_tree_sha256);
        assert_eq!(relinked.path, fs::canonicalize(&moved).unwrap());
        assert_eq!(
            fs::read(relinked.path.join("player-save")).unwrap(),
            b"keep my save"
        );
        assert!(!record.path.exists());
        let after = service.library.connection().unwrap().query_row(
            "SELECT retained_catalog_json, registered_at FROM external_runtime_registrations WHERE port_id=?1",
            [&record.port_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        ).unwrap();
        assert_eq!(before, after);
    }

    #[test]
    fn external_relink_rejects_changed_runtime_and_registration_without_losing_original() {
        let (temporary, service, record) = external_location_fixture();
        let moved = temporary.path().join("moved-player-folder");
        fs::rename(&record.path, &moved).unwrap();
        let preview = service
            .preview_external_runtime_relink(&record.port_id, &moved)
            .unwrap();
        let authorization = service
            .authorize_external_runtime_relink(
                &record.port_id,
                &moved,
                &preview.preview_sha256,
                None,
            )
            .unwrap();
        fs::write(moved.join("Game.exe"), b"changed runtime").unwrap();
        assert!(
            service
                .relink_external_runtime(&record.port_id, &moved, &authorization.token)
                .is_err()
        );
        assert_eq!(
            service
                .library
                .external_runtime_with_port(&record.port_id)
                .unwrap()
                .unwrap()
                .0
                .path,
            record.path
        );
        fs::write(moved.join("Game.exe"), b"accepted runtime").unwrap();
        // Even an otherwise equivalent retained row must invalidate an earlier consent.
        service.library.connection().unwrap().execute(
            "UPDATE external_runtime_registrations SET retained_catalog_json=retained_catalog_json || ' ' WHERE port_id=?1",
            [&record.port_id],
        ).unwrap();
        assert!(
            service
                .relink_external_runtime(&record.port_id, &moved, &authorization.token)
                .is_err()
        );
        assert_eq!(
            service
                .library
                .external_runtime_with_port(&record.port_id)
                .unwrap()
                .unwrap()
                .0
                .path,
            record.path
        );
        let current = service
            .preview_external_runtime_relink(&record.port_id, &moved)
            .unwrap();
        let authorization = service
            .authorize_external_runtime_relink(
                &record.port_id,
                &moved,
                &current.preview_sha256,
                None,
            )
            .unwrap();
        service
            .relink_external_runtime(&record.port_id, &moved, &authorization.token)
            .unwrap();
    }

    #[tokio::test]
    async fn external_ownership_allows_route_inspection_but_refuses_managed_mutations() {
        struct UnexpectedProvider(Arc<AtomicUsize>);
        #[async_trait::async_trait]
        impl ReleaseProvider for UnexpectedProvider {
            async fn resolve(
                &self,
                _port: &PortDefinition,
                _channel: ReleaseChannel,
                _platform: Platform,
            ) -> Result<ResolvedRelease> {
                self.0.fetch_add(1, Ordering::SeqCst);
                Err(PortcoveError::state(
                    "external registration reached managed provider",
                ))
            }
        }
        let (_temporary, mut service, record) = external_location_fixture();
        let calls = Arc::new(AtomicUsize::new(0));
        service.releases = Arc::new(UnexpectedProvider(calls.clone()));
        let inspection_failure = service
            .plan_install(&record.port_id, None)
            .await
            .unwrap_err();
        assert!(
            inspection_failure
                .message
                .contains("external registration reached managed provider")
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let results = [
            service
                .install_at(
                    &record.port_id,
                    None,
                    InstallOverrides {
                        source: None,
                        bios: None,
                        output_directory: None,
                    },
                    true,
                    |_| {},
                )
                .await
                .map(|_| ()),
            service
                .ensure(&record.port_id, None, None, None, |_| {})
                .await
                .map(|_| ()),
            service
                .update(&record.port_id, None, None, true, |_| {})
                .await
                .map(|_| ()),
            service.check_update(&record.port_id).await.map(|_| ()),
        ];
        for result in results {
            let failure = result.unwrap_err();
            assert!(
                failure.message.contains("external folder")
                    || failure.message.contains("externally owned folder"),
                "{}",
                failure.message
            );
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            serde_json::to_value(
                service
                    .library
                    .external_runtime_with_port(&record.port_id)
                    .unwrap()
                    .unwrap()
                    .0
            )
            .unwrap(),
            serde_json::to_value(&record).unwrap()
        );
    }

    #[test]
    fn external_relink_refuses_generic_registration_consent_and_pending_game() {
        let (_temporary, service, record) = external_location_fixture();
        let generic = service
            .preview_external_runtime(&record.port_id, &record.path)
            .unwrap();
        let generic_authorization = service
            .authorize_external_runtime(&record.port_id, &record.path, &generic.preview_sha256)
            .unwrap();
        assert!(
            service
                .relink_external_runtime(
                    &record.port_id,
                    &record.path,
                    &generic_authorization.token
                )
                .is_err()
        );
        let review = service
            .preview_external_runtime_relink(&record.port_id, &record.path)
            .unwrap();
        let authorization = service
            .authorize_external_runtime_relink(
                &record.port_id,
                &record.path,
                &review.preview_sha256,
                None,
            )
            .unwrap();
        let now = Library::now();
        service
            .library
            .create_launch_session(&LaunchSessionRecord {
                id: "pending-external-relink".into(),
                port_id: record.port_id.clone(),
                install_id: record.id.clone(),
                install_root: record.path.clone(),
                owner_kind: crate::LaunchOwnerKind::External,
                supervisor_pid: 1,
                supervisor_identity: None,
                child_pid: None,
                child_identity: None,
                phase: LaunchSessionPhase::Preparing,
                outcome: None,
                exit_code: None,
                message: None,
                started_at: now,
                updated_at: now,
                finished_at: None,
            })
            .unwrap();
        let error = service
            .relink_external_runtime(&record.port_id, &record.path, &authorization.token)
            .unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Conflict);
        assert_eq!(
            error.details["launch_session_id"],
            "pending-external-relink"
        );
        assert_eq!(
            serde_json::to_value(
                service
                    .library
                    .external_runtime_with_port(&record.port_id)
                    .unwrap()
                    .unwrap()
                    .0
            )
            .unwrap(),
            serde_json::to_value(&record).unwrap()
        );
    }

    #[test]
    #[cfg(windows)]
    fn external_relink_shared_scope_checks_new_folder_without_requiring_old_saves() {
        // Inert files exercise the real Windows scope resolver. No shared file
        // is written and this fixture grants no runtime/gameplay qualification.
        let (temporary, mut service, record) = external_location_fixture();
        let removal = service.preview_external_removal(&record.port_id).unwrap();
        let authorization = service
            .authorize_external_removal(&record.port_id, &removal.preview_sha256)
            .unwrap();
        service
            .remove_external_runtime(&record.port_id, &authorization.token)
            .unwrap();
        let mut spec = service
            .catalog
            .port(&record.port_id)
            .unwrap()
            .release
            .user_prepared[&Platform::WindowsX86_64]
            .clone();
        spec.version = "0.4.1".into();
        spec.archive_name = "Resident_Evil_Gaiden_Recomp_v0.4.1_Windows.zip".into();
        spec.archive_size = 33_085_815;
        spec.archive_sha256 =
            "d16ba320c75a23765ef1e84c6f70f551612834914c70fd4c542e20ae7ce5dcc6".into();
        spec.executable = "Resident_Evil_Gaiden__USA_.exe".into();
        spec.source_argument_extension = Some("gbc".into());
        spec.shared_preferences =
            Some(crate::PreparedSharedPreferencesContract::Regaiden041Windows);
        spec.mutable_paths = [
            "runtime_prefs.ini",
            "config.ini",
            "saves",
            "snapshots",
            "imgui.ini",
        ]
        .into_iter()
        .map(str::to_owned)
        .collect();
        fs::rename(&record.executable, record.path.join(&spec.executable)).unwrap();
        fs::create_dir(record.path.join("saves")).unwrap();
        let mismatch =
            crate::external_runtime::inspect(&record.path, &spec, service.library.root())
                .unwrap_err();
        spec.immutable_tree_sha256 = mismatch.details["actual_tree_sha256"].clone();
        service.replace_catalog_for_test(external_location_catalog(Platform::WindowsX86_64, spec));
        let preview = service
            .preview_external_runtime(&record.port_id, &record.path)
            .unwrap();
        let authorization = service
            .authorize_external_runtime_with_shared_preferences_ack(
                &record.port_id,
                &record.path,
                &preview.preview_sha256,
                Some(&preview.preview_sha256),
            )
            .unwrap();
        let registered = service
            .register_external_runtime(&record.port_id, &record.path, &authorization.token)
            .unwrap();
        let moved = temporary.path().join("moved-shared-runtime");
        fs::rename(&registered.path, &moved).unwrap();
        assert!(!registered.path.exists());
        let relink = service
            .preview_external_runtime_relink(&record.port_id, &moved)
            .unwrap();
        assert!(
            service
                .authorize_external_runtime_relink(
                    &record.port_id,
                    &moved,
                    &relink.preview_sha256,
                    None
                )
                .is_err()
        );
        assert!(
            service
                .authorize_external_runtime_relink(
                    &record.port_id,
                    &moved,
                    &relink.preview_sha256,
                    Some(&relink.proposed.preview_sha256)
                )
                .is_err()
        );
        let authorization = service
            .authorize_external_runtime_relink(
                &record.port_id,
                &moved,
                &relink.preview_sha256,
                Some(&relink.preview_sha256),
            )
            .unwrap();
        let changed = service
            .relink_external_runtime(&record.port_id, &moved, &authorization.token)
            .unwrap();
        assert_eq!(changed.id, registered.id);
        assert_eq!(changed.shared_preferences, registered.shared_preferences);
        assert_eq!(changed.path, fs::canonicalize(moved).unwrap());
    }

    fn external_location_fixture() -> (tempfile::TempDir, PortcoveService, ExternalRuntimeRecord) {
        external_location_fixture_with_private_data(false)
    }

    fn external_location_fixture_with_private_data(
        private: bool,
    ) -> (tempfile::TempDir, PortcoveService, ExternalRuntimeRecord) {
        external_location_fixture_with_flags(private, None)
    }

    fn external_location_fixture_with_flags(
        private: bool,
        other: Option<bool>,
    ) -> (tempfile::TempDir, PortcoveService, ExternalRuntimeRecord) {
        external_location_fixture_with_layout(private, other, None, "game.exe")
    }

    fn external_location_fixture_with_layout(
        private: bool,
        other: Option<bool>,
        runtime_directory: Option<&str>,
        executable: &str,
    ) -> (tempfile::TempDir, PortcoveService, ExternalRuntimeRecord) {
        external_location_fixture_with_selector(
            private,
            other,
            runtime_directory,
            executable,
            false,
        )
    }

    fn external_location_fixture_with_selector(
        private: bool,
        other: Option<bool>,
        runtime_directory: Option<&str>,
        executable: &str,
        required_selector: bool,
    ) -> (tempfile::TempDir, PortcoveService, ExternalRuntimeRecord) {
        let temporary = tempfile::tempdir().unwrap();
        let library_root = temporary.path().join("library");
        let library = Library::open(&library_root).unwrap();
        let external = temporary.path().join("player-owned");
        fs::create_dir(&external).unwrap();
        let physical_executable = if executable == "game.exe" {
            "Game.exe"
        } else {
            executable
        };
        fs::create_dir_all(external.join(physical_executable).parent().unwrap()).unwrap();
        fs::write(external.join(physical_executable), b"accepted runtime").unwrap();
        let platform = Platform::current().unwrap();
        let mut runtime = crate::UserPreparedRuntimeSpec {
            trust: crate::ExternalRuntimeTrust::AcceptedPackage,
            version: "probe-v1".into(),
            archive_name: "probe.zip".into(),
            archive_size: 1,
            archive_sha256: "a".repeat(64),
            executable: executable.into(),
            immutable_tree_sha256: "0".repeat(64),
            source_argument_extension: None,
            source_directory_environment: false,
            library_user_data: private,
            required_mutable_files: vec![],
            settings_contract: None,
            shared_preferences: None,
            mutable_paths: vec!["player-save".into()],
        };
        if required_selector {
            runtime.mutable_paths.push("settings.ini".into());
            runtime.required_mutable_files.push("settings.ini".into());
            fs::write(external.join("settings.ini"), b"").unwrap();
        }
        let mismatch =
            crate::external_runtime::inspect(&external, &runtime, &library_root).unwrap_err();
        runtime.immutable_tree_sha256 = mismatch.details["actual_tree_sha256"].clone();
        let mut service = service_with_release(library, "v1");
        let mut document = external_location_catalog(platform, runtime).authoritative_document();
        let port = &mut document.ports[0];
        port.executable_hints
            .insert(platform, vec![executable.into()]);
        port.runtime_subdirectory = runtime_directory.map(str::to_owned);
        if runtime_directory.is_some() {
            port.adapter = AdapterKind::StagedSourcePortable;
        }
        if let Some(other_private) = other {
            let alternate = if platform == Platform::WindowsX86_64 {
                Platform::LinuxX86_64
            } else {
                Platform::WindowsX86_64
            };
            let port = &mut document.ports[0];
            let mut runtime = port.release.user_prepared[&platform].clone();
            runtime.library_user_data = other_private;
            port.platforms.push(alternate);
            port.release.user_prepared.insert(alternate, runtime);
            port.executable_hints
                .insert(alternate, vec!["game.exe".into()]);
            if private || other_private {
                port.adapter = AdapterKind::StagedSourcePortable;
            }
        }
        service.replace_catalog_for_test(
            Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap(),
        );
        let preview = service
            .preview_external_runtime("external-location-probe", &external)
            .unwrap();
        let authorization = service
            .authorize_external_runtime(
                "external-location-probe",
                &external,
                &preview.preview_sha256,
            )
            .unwrap();
        let record = service
            .register_external_runtime("external-location-probe", &external, &authorization.token)
            .unwrap();
        (temporary, service, record)
    }

    // Declare the source-free contract independently of live title definitions.
    // The fixture still performs the real service bootstrap before replacement.
    fn external_location_catalog(
        platform: Platform,
        runtime: crate::UserPreparedRuntimeSpec,
    ) -> Catalog {
        let platform_key = serde_json::to_value(platform).unwrap();
        let platform_key = platform_key.as_str().unwrap();
        let executable = runtime.executable.clone();
        let source_extension = runtime.source_argument_extension.clone();
        let mut document = serde_json::json!({
            "schema_version": 2,
            "source_catalog": {
                "evidence": [], "identities": [], "contracts": [],
                "validators": [], "qualification": []
            },
            "ports": [{
                "id": "external-location-probe",
                "name": "External location probe",
                "summary": "Inert external registration status fixture.",
                "project_url": "https://example.invalid/external-location-probe",
                "support_tier": "stable",
                "channels": ["stable"],
                "platforms": [platform],
                "adapter": if runtime.library_user_data || !runtime.required_mutable_files.is_empty() || runtime.shared_preferences.is_some() { "staged-source-portable" } else { "n64-recomp-portable" },
                "launch_arguments": if runtime.shared_preferences.is_some() { vec!["--save-dir", "saves"] } else { vec![] },
                "user_data_environment": "FIXTURE_USER_DIR",
                "release": {
                    "provider": "user-prepared",
                    "user_prepared": { (platform_key): runtime }
                },
                "executable_hints": { (platform_key): [executable] }
            }]
        });
        if let Some(extension) = source_extension {
            // Independently authored legacy input is normalized into the same
            // retained schema-2 contract; no live title definition is borrowed.
            document["schema_version"] = 1.into();
            document.as_object_mut().unwrap().remove("source_catalog");
            document["source_profiles"] = serde_json::json!([{
                "id": "external-location-source",
                "label": "Inert external source fixture",
                "kind": "file",
                "accepted_extensions": [extension]
            }]);
            document["ports"][0]["source_profile"] = "external-location-source".into();
        }
        Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap()
    }

    fn prepare_external_location_fixture_launch(
        service: &PortcoveService,
        record: &ExternalRuntimeRecord,
    ) -> Result<crate::LaunchSpec> {
        let (_, catalog) = service
            .library
            .external_runtime_with_port(&record.port_id)?
            .unwrap();
        service.prepare_launch_for_external(
            record,
            &catalog,
            None,
            &OperationCoordinator::new("launch", None),
        )
    }

    #[test]
    #[cfg(windows)]
    fn prepared_source_directory_binds_retained_source_and_refuses_zip_before_user_data() {
        // Prepare a LaunchSpec with inert bytes; never spawn a child.
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let external = temporary.path().join("runtime");
        fs::create_dir(&external).unwrap();
        fs::write(external.join("game.exe"), b"inert executable").unwrap();
        let mut document: serde_json::Value = serde_json::from_str(include_str!(
            "../tests/fixtures/prepared-source-directory.json"
        ))
        .unwrap();
        let runtime_value = &mut document["ports"][0]["release"]["user_prepared"]["windows-x86-64"];
        let runtime: crate::UserPreparedRuntimeSpec =
            serde_json::from_value(runtime_value.clone()).unwrap();
        runtime_value["immutable_tree_sha256"] =
            crate::external_runtime::inspect(&external, &runtime, library.root())
                .unwrap_err()
                .details["actual_tree_sha256"]
                .clone()
                .into();
        let catalog = Catalog::from_json(&document.to_string()).unwrap();
        let mut service = service_with_release(library.clone(), "v1");
        service.replace_catalog_for_test(catalog);
        let id = "prepared-directory-fixture";
        let preview = service.preview_external_runtime(id, &external).unwrap();
        let token = service
            .authorize_external_runtime(id, &external, &preview.preview_sha256)
            .unwrap();
        let record = service
            .register_external_runtime(id, &external, &token.token)
            .unwrap();
        let source = temporary.path().join("original");
        fs::create_dir_all(source.join("nested")).unwrap();
        fs::write(source.join("nested/data.bin"), b"abc").unwrap();
        fs::write(source.join("unknown-save"), b"preserve").unwrap();
        let zipped = temporary.path().join("original.zip");
        let mut zip = zip::ZipWriter::new(fs::File::create(&zipped).unwrap());
        zip.start_file("nested/data.bin", zip::write::SimpleFileOptions::default())
            .unwrap();
        std::io::Write::write_all(&mut zip, b"abc").unwrap();
        zip.finish().unwrap();
        service
            .register_source("directory-source", &zipped)
            .unwrap();
        assert!(!service.status(id).unwrap().readiness.unwrap().launchable);
        assert!(prepare_external_location_fixture_launch(&service, &record).is_err());
        assert!(!library.root().join("user").join(id).exists());
        service
            .register_source("directory-source", &source)
            .unwrap();
        let registered = library.source("directory-source").unwrap().unwrap();
        let calls = std::cell::Cell::new(0);
        let cancelled = PortcoveService::verify_source_record_with_checkpoint(
            service.catalog(),
            &registered,
            &|| {
                calls.set(calls.get() + 1);
                if calls.get() >= 3 {
                    Err(PortcoveError::new(
                        crate::ErrorCode::Cancelled,
                        "fixture cancellation inside relative inspection",
                    ))
                } else {
                    Ok(())
                }
            },
        )
        .unwrap_err();
        assert_eq!(cancelled.code, crate::ErrorCode::Cancelled);
        assert!(service.status(id).unwrap().readiness.unwrap().launchable);
        // A current definition cannot disable retained directory/source semantics.
        document["ports"][0]["release"]["user_prepared"]["windows-x86-64"]["source_directory_environment"] =
            false.into();
        document["ports"][0]["source_environment"] = "CHANGED_SOURCE_DIR".into();
        service.replace_catalog_for_test(Catalog::from_json(&document.to_string()).unwrap());
        let launch = prepare_external_location_fixture_launch(&service, &record).unwrap();
        assert!(launch.fixed_arguments_only);
        assert_eq!(launch.arguments, ["--reviewed"]);
        let process = launch.process_spec();
        assert!(
            crate::ChildProcessPolicy::game_command(&process, &["--source=other".into()]).is_err()
        );
        let command = crate::ChildProcessPolicy::game_command(&process, &[]).unwrap();
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            [std::ffi::OsStr::new("--reviewed")]
        );
        assert_eq!(
            fs::canonicalize(&launch.environment["FIXTURE_SOURCE_DIR"]).unwrap(),
            fs::canonicalize(&source).unwrap()
        );
        assert!(!launch.environment.contains_key("CHANGED_SOURCE_DIR"));
        let user = Path::new(&launch.environment["FIXTURE_USER_DIR"]);
        assert!(user.is_dir());
        fs::write(user.join("player-save"), b"private save").unwrap();
        let (_, retained) = library.external_runtime_with_port(id).unwrap().unwrap();
        assert!(
            service
                .prepare_launch_for_external(
                    &record,
                    &retained,
                    Some(&zipped),
                    &OperationCoordinator::new("launch", None)
                )
                .is_err()
        );
        fs::write(source.join("nested/data.bin"), b"bad").unwrap();
        assert!(prepare_external_location_fixture_launch(&service, &record).is_err());
        assert_eq!(fs::read(source.join("unknown-save")).unwrap(), b"preserve");
        assert_eq!(fs::read(user.join("player-save")).unwrap(), b"private save");
        assert_eq!(
            fs::read(external.join("game.exe")).unwrap(),
            b"inert executable"
        );
    }

    #[test]
    #[cfg(windows)]
    fn prepared_windows_paths_retain_refusals_for_registration_source_override_and_relink() {
        let (temporary, mut service, previous) = external_location_fixture();
        let removal = service.preview_external_removal(&previous.port_id).unwrap();
        let authorization = service
            .authorize_external_removal(&previous.port_id, &removal.preview_sha256)
            .unwrap();
        service
            .remove_external_runtime(&previous.port_id, &authorization.token)
            .unwrap();
        let mut runtime = service
            .catalog()
            .port(&previous.port_id)
            .unwrap()
            .release
            .user_prepared[&previous.platform]
            .clone();
        runtime.source_argument_extension = Some("sfc".into());
        let mut document =
            external_location_catalog(previous.platform, runtime).authoritative_document();
        document.ports[0].adapter = AdapterKind::StagedSourcePortable;
        document.ports[0].windows_runtime_path_policy =
            Some(crate::WindowsRuntimePathPolicy::PrintableAsciiMaxPath);
        let accepted_catalog =
            Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap();
        service.replace_catalog_for_test(accepted_catalog.clone());
        let mut missing_directory = document.clone();
        missing_directory.ports[0].runtime_subdirectory = Some("missing".into());
        service.replace_catalog_for_test(
            Catalog::from_json(&serde_json::to_string(&missing_directory).unwrap()).unwrap(),
        );
        let missing = service
            .preview_external_runtime(&previous.port_id, &previous.path)
            .unwrap_err();
        assert_eq!(missing.code, crate::ErrorCode::Launch);
        assert!(missing.message.contains("runtime subdirectory missing"));
        assert!(!service.library.user_dir(&previous.port_id).exists());
        service.replace_catalog_for_test(accepted_catalog.clone());
        let lossy = temporary.path().join("runtime-ゲーム");
        fs::create_dir(&lossy).unwrap();
        fs::write(lossy.join("Game.exe"), b"accepted runtime").unwrap();
        assert!(
            service
                .preview_external_runtime(&previous.port_id, &lossy)
                .is_err()
        );
        assert!(
            service
                .library
                .external_runtime_with_port(&previous.port_id)
                .unwrap()
                .is_none()
        );
        let preview = service
            .preview_external_runtime(&previous.port_id, &previous.path)
            .unwrap();
        let token = service
            .authorize_external_runtime(&previous.port_id, &previous.path, &preview.preview_sha256)
            .unwrap();
        let record = service
            .register_external_runtime(&previous.port_id, &previous.path, &token.token)
            .unwrap();
        let original = temporary.path().join("original.sfc");
        fs::write(&original, b"inert source; never executed").unwrap();
        service
            .register_source("external-location-source", &original)
            .unwrap();
        let launch = prepare_external_location_fixture_launch(&service, &record).unwrap();
        assert!(launch.fixed_arguments_only);
        assert!(
            service
                .status(&record.port_id)
                .unwrap()
                .readiness
                .unwrap()
                .launchable
        );
        let lossy_source = temporary.path().join("original-ゲーム.sfc");
        fs::copy(&original, &lossy_source).unwrap();
        service
            .register_source("external-location-source", &lossy_source)
            .unwrap();
        // Current catalog drift cannot erase the registered runtime's restriction.
        document.ports[0].windows_runtime_path_policy = None;
        service.replace_catalog_for_test(
            Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap(),
        );
        assert!(
            !service
                .status(&record.port_id)
                .unwrap()
                .readiness
                .unwrap()
                .launchable
        );
        assert!(prepare_external_location_fixture_launch(&service, &record).is_err());
        assert!(
            service
                .prepare_launch_for_external(
                    &record,
                    &accepted_catalog,
                    Some(&lossy_source),
                    &OperationCoordinator::new("launch", None)
                )
                .is_err()
        );
        assert!(
            service
                .preview_external_runtime_relink(&record.port_id, &lossy)
                .is_err()
        );
        assert_eq!(
            fs::read(&original).unwrap(),
            b"inert source; never executed"
        );
        assert_eq!(
            fs::read(lossy.join("Game.exe")).unwrap(),
            b"accepted runtime"
        );
    }

    #[test]
    #[cfg(windows)]
    fn tfe_settings_retain_source_guard_and_do_not_spend_failed_consent() {
        let (_temporary, mut service, record) =
            external_location_fixture_with_selector(false, None, None, "game.exe", true);
        let removal = service.preview_external_removal(&record.port_id).unwrap();
        let authorization = service
            .authorize_external_removal(&record.port_id, &removal.preview_sha256)
            .unwrap();
        service
            .remove_external_runtime(&record.port_id, &authorization.token)
            .unwrap();
        let valid = b"[Game]\ngame=\"Dark Forces\"\n[Dark_Forces]\nsourcePath=\"GameData/\"\n";
        fs::write(record.path.join("settings.ini"), valid).unwrap();
        fs::create_dir(record.path.join("GameData")).unwrap();
        for name in ["DARK.GOB", "SOUNDS.GOB", "SPRITES.GOB", "TEXTURES.GOB"] {
            fs::write(record.path.join("GameData").join(name), name).unwrap();
        }
        let mut document = service.catalog.authoritative_document();
        let spec = document.ports[0]
            .release
            .user_prepared
            .values_mut()
            .next()
            .unwrap();
        spec.version = "1.22.420".into();
        spec.settings_contract = Some(crate::PreparedRuntimeSettingsContract::TfeDarkForces122420);
        let mismatch = crate::external_runtime::inspect(&record.path, spec, service.library.root())
            .unwrap_err();
        spec.immutable_tree_sha256 = mismatch.details["actual_tree_sha256"].clone();
        service.replace_catalog_for_test(
            Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap(),
        );
        let preview = service
            .preview_external_runtime(&record.port_id, &record.path)
            .unwrap();
        let authorization = service
            .authorize_external_runtime(&record.port_id, &record.path, &preview.preview_sha256)
            .unwrap();
        fs::write(
            record.path.join("settings.ini"),
            String::from_utf8_lossy(valid).replace("GameData/", "ElseData/"),
        )
        .unwrap();
        assert!(
            service
                .register_external_runtime(&record.port_id, &record.path, &authorization.token)
                .is_err()
        );
        fs::write(record.path.join("settings.ini"), valid).unwrap();
        let registered = service
            .register_external_runtime(&record.port_id, &record.path, &authorization.token)
            .unwrap();
        prepare_external_location_fixture_launch(&service, &registered).unwrap();
        for runtime in document.ports[0].release.user_prepared.values_mut() {
            runtime.settings_contract = None;
        }
        service.replace_catalog_for_test(
            Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap(),
        );
        let forwarded = service
            .supervise_launch(
                &record.port_id,
                None,
                &["-gOUTLAWS".into()],
                LaunchStdio::Null,
                |_| panic!("must refuse before spawn"),
            )
            .unwrap_err();
        assert!(forwarded.message.contains("forwarded launch arguments"));
        let sessions: usize = service
            .library
            .connection()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM launch_sessions WHERE port_id=?1",
                [&record.port_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(sessions, 0);
        fs::write(
            record.path.join("settings.ini"),
            String::from_utf8_lossy(valid).replace("Dark Forces", "Outlaws"),
        )
        .unwrap();
        assert!(prepare_external_location_fixture_launch(&service, &registered).is_err());
        assert_external_location_readiness(&service, true);
        let removal = service.preview_external_removal(&record.port_id).unwrap();
        let authorization = service
            .authorize_external_removal(&record.port_id, &removal.preview_sha256)
            .unwrap();
        service
            .remove_external_runtime(&record.port_id, &authorization.token)
            .unwrap();
        assert!(record.path.join("GameData/DARK.GOB").is_file());
        assert!(record.path.join("settings.ini").is_file());
    }

    #[test]
    fn required_mutable_files_retain_launch_guard_and_allow_registration_only_removal() {
        let (_temporary, mut service, record) =
            external_location_fixture_with_selector(false, None, None, "game.exe", true);
        let retained: String = service
            .library
            .connection()
            .unwrap()
            .query_row(
                "SELECT retained_catalog_json FROM external_runtime_registrations WHERE port_id=?1",
                [&record.port_id],
                |row| row.get(0),
            )
            .unwrap();
        assert!(Catalog::from_json(&retained).is_err());
        let mut browsing_budget = crate::signed_catalog::MAX_CATALOG_BYTES as u64;
        let (_, bounded_catalog) = service
            .library
            .external_runtime_with_port_bounded(&record.port_id, &mut browsing_budget)
            .unwrap()
            .unwrap();
        assert!(
            !bounded_catalog
                .port(&record.port_id)
                .unwrap()
                .release
                .user_prepared
                .values()
                .next()
                .unwrap()
                .required_mutable_files
                .is_empty()
        );
        fs::write(record.path.join("settings.ini"), b"player settings").unwrap();
        fs::write(record.path.join("player-save"), b"player save").unwrap();
        prepare_external_location_fixture_launch(&service, &record).unwrap();
        service
            .preview_external_runtime(&record.port_id, &record.path)
            .unwrap();
        let mut current = service.catalog.authoritative_document();
        for spec in current.ports[0].release.user_prepared.values_mut() {
            spec.required_mutable_files.clear();
        }
        service.replace_catalog_for_test(
            Catalog::from_json(&serde_json::to_string(&current).unwrap()).unwrap(),
        );
        fs::remove_file(record.path.join("settings.ini")).unwrap();
        assert!(prepare_external_location_fixture_launch(&service, &record).is_err());
        assert_external_location_readiness(&service, true);
        let removal = service.preview_external_removal(&record.port_id).unwrap();
        let authorization = service
            .authorize_external_removal(&record.port_id, &removal.preview_sha256)
            .unwrap();
        service
            .remove_external_runtime(&record.port_id, &authorization.token)
            .unwrap();
        assert!(!record.path.join("settings.ini").exists());
        assert_eq!(fs::read(&record.executable).unwrap(), b"accepted runtime");
        assert_eq!(
            fs::read(record.path.join("player-save")).unwrap(),
            b"player save"
        );
    }

    #[test]
    fn required_mutable_files_revalidate_before_spending_registration_consent() {
        let (_temporary, service, record) =
            external_location_fixture_with_selector(false, None, None, "game.exe", true);
        let removal = service.preview_external_removal(&record.port_id).unwrap();
        let removal_authorization = service
            .authorize_external_removal(&record.port_id, &removal.preview_sha256)
            .unwrap();
        service
            .remove_external_runtime(&record.port_id, &removal_authorization.token)
            .unwrap();
        let preview = service
            .preview_external_runtime(&record.port_id, &record.path)
            .unwrap();
        let authorization = service
            .authorize_external_runtime(&record.port_id, &record.path, &preview.preview_sha256)
            .unwrap();
        fs::remove_file(record.path.join("settings.ini")).unwrap();
        assert!(
            service
                .preview_external_runtime(&record.port_id, &record.path)
                .is_err()
        );
        assert!(
            service
                .register_external_runtime(&record.port_id, &record.path, &authorization.token)
                .is_err()
        );
        fs::write(record.path.join("settings.ini"), b"new legitimate content").unwrap();
        let registered = service
            .register_external_runtime(&record.port_id, &record.path, &authorization.token)
            .unwrap();
        prepare_external_location_fixture_launch(&service, &registered).unwrap();
        assert_eq!(
            fs::read(record.path.join("settings.ini")).unwrap(),
            b"new legitimate content"
        );
    }

    #[test]
    fn prepared_nested_directory_uses_retained_contract_and_whole_tree_root() {
        let (_root, mut service, record) = external_location_fixture_with_layout(
            false,
            None,
            Some("Install/Base"),
            "Install/Base/game.exe",
        );
        let launch = prepare_external_location_fixture_launch(&service, &record).unwrap();
        assert_eq!(launch.working_directory, record.path.join("Install/Base"));
        assert_eq!(launch.install_root, record.path);
        assert_eq!(launch.executable, record.executable);
        let mut changed = service.catalog.authoritative_document();
        changed.ports[0].runtime_subdirectory = None;
        service.replace_catalog_for_test(
            Catalog::from_json(&serde_json::to_string(&changed).unwrap()).unwrap(),
        );
        assert_eq!(
            prepare_external_location_fixture_launch(&service, &record)
                .unwrap()
                .working_directory,
            launch.working_directory
        );
    }

    #[test]
    fn prepared_nested_executable_without_declaration_keeps_root_directory() {
        let (_root, service, record) =
            external_location_fixture_with_layout(false, None, None, "Install/Base/game.exe");
        assert_eq!(
            prepare_external_location_fixture_launch(&service, &record)
                .unwrap()
                .working_directory,
            record.path
        );
    }

    #[test]
    fn prepared_directory_refusals_precede_private_data_creation() {
        for directory in ["missing", "Other"] {
            let (_root, service, record) = external_location_fixture_with_layout(
                true,
                None,
                Some(directory),
                "Install/Base/game.exe",
            );
            if directory == "Other" {
                fs::create_dir(record.path.join(directory)).unwrap();
            }
            assert!(prepare_external_location_fixture_launch(&service, &record).is_err());
            assert!(!service.library.user_dir(&record.port_id).exists());
            assert_eq!(fs::read(&record.executable).unwrap(), b"accepted runtime");
        }
    }

    #[test]
    fn prepared_directory_redirection_refuses_before_private_data_creation() {
        let (_root, service, record) = external_location_fixture_with_layout(
            true,
            None,
            Some("Install/Base"),
            "Install/Base/game.exe",
        );
        let directory = record.path.join("Install/Base");
        let retained = record.path.join("retained-base");
        fs::rename(&directory, &retained).unwrap();
        create_adoption_test_symlink(&retained, &directory, true);
        assert!(prepare_external_location_fixture_launch(&service, &record).is_err());
        assert!(!service.library.user_dir(&record.port_id).exists());
        assert_eq!(
            fs::read(retained.join("game.exe")).unwrap(),
            b"accepted runtime"
        );
    }

    #[test]
    fn prepared_private_data_is_opt_in_and_bound_to_the_retained_library() {
        let (_legacy_root, legacy, record) = external_location_fixture();
        assert!(!legacy.library.user_dir(&record.port_id).exists());
        let launch = prepare_external_location_fixture_launch(&legacy, &record).unwrap();
        assert!(!launch.environment.contains_key("FIXTURE_USER_DIR"));
        assert!(!legacy.library.user_dir(&record.port_id).exists());
        let (_root, mut service, record) = external_location_fixture_with_private_data(true);
        let private = service.library.user_dir(&record.port_id);
        assert!(!private.exists());
        // Changing the current declaration cannot replace retained launch authority.
        let mut changed = service.catalog.authoritative_document();
        changed.ports[0]
            .release
            .user_prepared
            .values_mut()
            .for_each(|runtime| runtime.library_user_data = false);
        service.replace_catalog_for_test(
            Catalog::from_json(&serde_json::to_string(&changed).unwrap()).unwrap(),
        );
        let launch = prepare_external_location_fixture_launch(&service, &record).unwrap();
        assert_eq!(
            launch.environment["FIXTURE_USER_DIR"],
            private.to_str().unwrap()
        );
        assert!(private.is_dir());
        assert_ne!(private, record.path);
        fs::write(private.join("unknown-save.dat"), b"private save").unwrap();
        let library_root = service.library.root().to_path_buf();
        drop(service);
        let reopened = service_with_release(Library::open(&library_root).unwrap(), "v1");
        let launch = prepare_external_location_fixture_launch(&reopened, &record).unwrap();
        assert_eq!(
            launch.environment["FIXTURE_USER_DIR"],
            private.to_str().unwrap()
        );
        let preview = reopened.preview_external_removal(&record.port_id).unwrap();
        let authorization = reopened
            .authorize_external_removal(&record.port_id, &preview.preview_sha256)
            .unwrap();
        reopened
            .remove_external_runtime(&record.port_id, &authorization.token)
            .unwrap();
        assert_eq!(
            fs::read(private.join("unknown-save.dat")).unwrap(),
            b"private save"
        );
        assert_eq!(fs::read(&record.executable).unwrap(), b"accepted runtime");
    }

    #[test]
    fn prepared_private_data_revalidates_package_before_directory_creation() {
        let (_root, service, record) = external_location_fixture_with_private_data(true);
        let private = service.library.user_dir(&record.port_id);
        fs::write(&record.executable, b"changed immutable runtime").unwrap();
        assert!(prepare_external_location_fixture_launch(&service, &record).is_err());
        assert!(!private.exists());
    }

    #[test]
    fn prepared_private_data_refuses_non_directory_without_replacing_it() {
        let (_root, service, record) = external_location_fixture_with_private_data(true);
        let private = service.library.user_dir(&record.port_id);
        fs::write(&private, b"retained unknown file").unwrap();
        assert!(prepare_external_location_fixture_launch(&service, &record).is_err());
        assert_eq!(fs::read(&private).unwrap(), b"retained unknown file");
    }

    #[test]
    fn prepared_private_data_contract_rejects_missing_binding_wrong_adapter_and_reserved_names() {
        let (_root, service, _) = external_location_fixture_with_private_data(true);
        let document = serde_json::to_value(service.catalog.authoritative_document()).unwrap();
        for (key, value) in [
            ("user_data_environment", serde_json::Value::Null),
            ("user_data_environment", "PORTCOVE_PREFERENCES".into()),
            ("adapter", "n64-recomp-portable".into()),
        ] {
            let mut malformed = document.clone();
            malformed["ports"][0][key] = value;
            assert!(Catalog::from_json(&malformed.to_string()).is_err());
        }
        let runtime =
            &service.catalog.ports()[0].release.user_prepared[&Platform::current().unwrap()];
        let mut legacy = runtime.clone();
        legacy.library_user_data = false;
        let projection = serde_json::to_value(&legacy).unwrap();
        assert!(projection.get("library_user_data").is_none());
        assert!(
            !serde_json::from_value::<crate::UserPreparedRuntimeSpec>(projection)
                .unwrap()
                .library_user_data
        );
    }

    #[test]
    fn prepared_private_data_selects_only_the_current_platform_contract() {
        for private in [false, true] {
            let (_root, service, record) =
                external_location_fixture_with_flags(private, Some(!private));
            let path = service.library.user_dir(&record.port_id);
            let launch = prepare_external_location_fixture_launch(&service, &record).unwrap();
            assert_eq!(launch.environment.contains_key("FIXTURE_USER_DIR"), private);
            assert_eq!(path.exists(), private);
        }
    }

    fn assert_external_location_readiness(service: &PortcoveService, held: bool) {
        let retained_row = || {
            service.library.connection().unwrap().query_row(
            "SELECT record_json, retained_catalog_json FROM external_runtime_registrations WHERE port_id = ?1",
            ["external-location-probe"],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        ).unwrap()
        };
        let before = retained_row();
        let status = service.status("external-location-probe").unwrap();
        let readiness = status.readiness.as_ref().unwrap();
        assert_eq!(readiness.launchable, !held);
        assert_eq!(
            readiness.blockers,
            if held {
                vec![LaunchBlocker::InvalidInstallation]
            } else {
                vec![]
            }
        );
        let launch = status
            .port_actions
            .iter()
            .find(|item| item.action == crate::PortAction::Launch)
            .unwrap();
        assert_eq!(
            launch.availability,
            if held {
                crate::PortActionAvailability::Held
            } else {
                crate::PortActionAvailability::Allowed
            }
        );
        if held {
            assert_eq!(launch.reason, crate::PortActionReason::InvalidInstallation);
        }
        let listed = service
            .statuses()
            .unwrap()
            .into_iter()
            .find(|item| item.port_id == status.port_id);
        if service.catalog.port(&status.port_id).is_ok() {
            let listed = listed.unwrap();
            assert_eq!(listed.readiness, status.readiness);
            assert_eq!(
                listed.external_runtime.unwrap().id,
                status.external_runtime.unwrap().id
            );
        } else {
            // Aggregate status deliberately enumerates current catalog ports;
            // the direct retained-only status must still return an assessment.
            assert!(listed.is_none());
        }
        assert_eq!(retained_row(), before);
    }

    #[test]
    fn external_location_fixture_contains_only_its_source_free_registration_contract() {
        let started = std::time::Instant::now();
        let (_temporary, service, record) = external_location_fixture();
        let document = service.catalog().authoritative_document();
        let bytes = serde_json::to_vec(&document).unwrap();
        eprintln!(
            "external fixture: ports={}, profiles={}, bytes={}, setup={:?}",
            document.ports.len(),
            document.source_profiles.len(),
            bytes.len(),
            started.elapsed()
        );
        assert_eq!(document.ports.len(), 1);
        assert!(document.source_profiles.is_empty());
        let source = document.source_catalog.as_ref().unwrap();
        assert!(source.evidence.is_empty());
        assert!(source.identities.is_empty());
        assert!(source.contracts.is_empty());
        assert!(source.validators.is_empty());
        assert!(source.qualification.is_empty());
        let port = service.catalog().port(&record.port_id).unwrap();
        assert_eq!(port.id, "external-location-probe");
        assert!(port.source_profile.is_none());
        assert!(port.bios_source_profile.is_none());
        assert!(port.persistent_paths.is_empty());
        assert_external_location_readiness(&service, false);
        assert!(service.catalog().port("zelda64-recomp").is_err());
    }

    #[test]
    fn external_location_status_missing_executable_and_recovery_preserve_registration() {
        let (_temporary, service, record) = external_location_fixture();
        fs::write(record.path.join("player-save"), b"player data").unwrap();
        assert_external_location_readiness(&service, false);
        fs::remove_file(&record.executable).unwrap();
        assert_external_location_readiness(&service, true);
        assert_eq!(
            service
                .library
                .external_runtime_with_port(&record.port_id)
                .unwrap()
                .unwrap()
                .0
                .id,
            record.id
        );
        assert_eq!(
            fs::read(record.path.join("player-save")).unwrap(),
            b"player data"
        );
        assert!(prepare_external_location_fixture_launch(&service, &record).is_err());
        fs::write(&record.executable, b"accepted runtime").unwrap();
        assert_external_location_readiness(&service, false);
        prepare_external_location_fixture_launch(&service, &record).unwrap();
        assert_eq!(
            fs::read(record.path.join("player-save")).unwrap(),
            b"player data"
        );
    }

    #[test]
    fn external_location_retained_only_missing_root_remains_held_and_removable() {
        let (_temporary, mut service, record) = external_location_fixture();
        let mut document = service.catalog().authoritative_document();
        document.ports.retain(|port| port.id != record.port_id);
        service.replace_catalog_for_test(
            Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap(),
        );
        assert_external_location_readiness(&service, false);
        fs::remove_dir_all(&record.path).unwrap();
        assert_external_location_readiness(&service, true);
        assert!(prepare_external_location_fixture_launch(&service, &record).is_err());
        let preview = service.preview_external_removal(&record.port_id).unwrap();
        assert!(preview.external_files_will_be_preserved);
        let authorization = service
            .authorize_external_removal(&record.port_id, &preview.preview_sha256)
            .unwrap();
        assert_eq!(
            service
                .remove_external_runtime(&record.port_id, &authorization.token)
                .unwrap()
                .id,
            record.id
        );
        assert!(!record.path.exists());
        assert!(
            service
                .library
                .external_runtime_with_port(&record.port_id)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn external_location_replacement_cannot_validate_a_stale_status_snapshot() {
        let (temporary, service, first) = external_location_fixture();
        let stale = service
            .library
            .status(&first.port_id, ReleaseChannel::Stable)
            .unwrap();
        fs::remove_file(&first.executable).unwrap();
        let removal = service.preview_external_removal(&first.port_id).unwrap();
        let authorization = service
            .authorize_external_removal(&first.port_id, &removal.preview_sha256)
            .unwrap();
        service
            .remove_external_runtime(&first.port_id, &authorization.token)
            .unwrap();
        let replacement = temporary.path().join("replacement-runtime");
        fs::create_dir(&replacement).unwrap();
        fs::write(replacement.join("Game.exe"), b"accepted runtime").unwrap();
        let preview = service
            .preview_external_runtime(&first.port_id, &replacement)
            .unwrap();
        let authorization = service
            .authorize_external_runtime(&first.port_id, &replacement, &preview.preview_sha256)
            .unwrap();
        let second = service
            .register_external_runtime(&first.port_id, &replacement, &authorization.token)
            .unwrap();
        assert_ne!(first.id, second.id);
        assert_external_location_readiness(&service, false);
        let row = || {
            service.library.connection().unwrap().query_row(
            "SELECT record_json, retained_catalog_json FROM external_runtime_registrations WHERE port_id = ?1",
            [&first.port_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        ).unwrap()
        };
        let before = row();
        let retained_catalog = service.retained_catalog_for_status(&stale);
        assert!(retained_catalog.is_err());
        let status = service
            .with_launch_readiness(
                &service.catalog,
                service.catalog.port(&first.port_id).unwrap(),
                stale,
                &HashMap::new(),
                &mut HashMap::new(),
                retained_catalog.as_ref(),
            )
            .unwrap();
        let status = service
            .with_port_actions(
                service.catalog.port(&first.port_id).unwrap(),
                status,
                &HashMap::new(),
            )
            .unwrap();
        let launch = status
            .port_actions
            .iter()
            .find(|action| action.action == PortAction::Launch)
            .unwrap();
        assert_eq!(launch.availability, PortActionAvailability::Held);
        assert_eq!(launch.reason, PortActionReason::InvalidInstallation);
        let readiness = status.readiness.unwrap();
        assert!(!readiness.launchable);
        assert_eq!(readiness.blockers, vec![LaunchBlocker::InvalidInstallation]);
        assert!(readiness.setup_contract.is_none());
        assert!(
            service
                .statuses()
                .unwrap()
                .iter()
                .filter(|row| row.active.is_none() && row.external_runtime.is_none())
                .all(|row| row
                    .readiness
                    .as_ref()
                    .is_none_or(|ready| ready.setup_contract.is_none()))
        );
        assert_eq!(status.external_runtime.unwrap().id, first.id);
        assert_eq!(row(), before);
        assert_eq!(fs::read(second.executable).unwrap(), b"accepted runtime");
        assert!(!first.executable.exists());
    }

    #[test]
    fn dkc3_prepared_positional_source_preflight_and_removal_preserve_external_files() {
        prepared_positional_source_fixture(false);
    }

    #[test]
    fn prepared_private_data_source_refusal_precedes_directory_creation() {
        // Synthetic private binding is not an upstream DKC3 capability claim.
        prepared_positional_source_fixture(true);
    }

    fn prepared_positional_source_fixture(private: bool) {
        // Redistributable inert bytes exercise the real admitted definition and
        // Core operation path. No upstream executable or game source is run.
        let temporary = tempfile::tempdir().unwrap();
        let library_root = temporary.path().join("library");
        let library = Library::open(&library_root).unwrap();
        let external = temporary.path().join("player owned runtime");
        fs::create_dir(&external).unwrap();
        let expected_external = fs::canonicalize(&external).unwrap();
        fs::write(external.join("DKC3Recomp.exe"), b"inert executable fixture").unwrap();
        fs::write(external.join("SDL2.dll"), b"inert immutable dependency").unwrap();
        fs::create_dir(external.join("saves")).unwrap();
        fs::write(external.join("saves/unknown-save.dat"), b"player save").unwrap();
        let source = temporary.path().join("original source ; literal.sfc");
        let source_bytes = b"inert exact headerless source fixture";
        fs::write(&source, source_bytes).unwrap();
        let mut service = service_with_release(library.clone(), "v1");
        let mut document = Catalog::from_json(include_str!(
            "../tests/fixtures/dkc3-006-prepared-historical.json"
        ))
        .unwrap()
        .authoritative_document();
        // Preserve the real port/source contract, excluding unrelated catalog work
        // from this bounded inert preflight/removal control.
        document.ports.retain(|port| port.id == "dkc3-recomp");
        let source_catalog = document.source_catalog.as_mut().unwrap();
        source_catalog
            .contracts
            .retain(|contract| contract.port_id == "dkc3-recomp");
        source_catalog
            .qualification
            .retain(|record| record.scope.port_id == "dkc3-recomp");
        source_catalog
            .identities
            .retain(|profile| profile.id == "dkc3-na-en-fr");
        document
            .source_profiles
            .retain(|profile| profile.id == "dkc3-na-en-fr");

        let profile = document
            .source_catalog
            .as_mut()
            .unwrap()
            .identities
            .iter_mut()
            .find(|profile| profile.id == "dkc3-na-en-fr")
            .unwrap();
        let crate::SourceRepresentationKind::RawFile { identities } =
            &mut profile.variants[0].representations[0].kind
        else {
            panic!("DKC3 must retain exact original-file admission")
        };
        identities[0].sha256 = Some(hex::encode(Sha256::digest(source_bytes)));
        let platform = Platform::current().unwrap();
        let port = document
            .ports
            .iter_mut()
            .find(|port| port.id == "dkc3-recomp")
            .unwrap();
        let mut runtime = port.release.user_prepared[&Platform::WindowsX86_64].clone();
        runtime.library_user_data = private;
        if private {
            port.user_data_environment = Some("FIXTURE_USER_DIR".into());
        }
        // Only fixture bytes/platform replace the accepted real-package pin.
        let mismatch =
            crate::external_runtime::inspect(&external, &runtime, &library_root).unwrap_err();
        runtime.immutable_tree_sha256 = mismatch.details["actual_tree_sha256"].clone();
        port.platforms = vec![platform];
        port.release.user_prepared = [(platform, runtime)].into();
        port.executable_hints = [(platform, vec!["DKC3Recomp.exe".into()])].into();
        // This inert fixture substitutes the host platform for the real Windows
        // package. Its source-qualification scope must describe the same fixture.
        for record in &mut document.source_catalog.as_mut().unwrap().qualification {
            record.scope.platform = platform;
        }
        service.replace_catalog_for_test(
            Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap(),
        );
        service.register_source("dkc3-na-en-fr", &source).unwrap();
        assert!(
            service
                .preview_external_runtime("dkc3-recomp", &library_root)
                .is_err()
        );
        let preview = service
            .preview_external_runtime("dkc3-recomp", &external)
            .unwrap();
        assert!(
            service
                .register_external_runtime("dkc3-recomp", &external, "unreviewed")
                .is_err()
        );
        fs::write(external.join("SDL2.dll"), b"changed after review").unwrap();
        assert!(
            service
                .authorize_external_runtime("dkc3-recomp", &external, &preview.preview_sha256)
                .is_err()
        );
        fs::write(external.join("SDL2.dll"), b"inert immutable dependency").unwrap();
        let authorization = service
            .authorize_external_runtime("dkc3-recomp", &external, &preview.preview_sha256)
            .unwrap();
        let record = service
            .register_external_runtime("dkc3-recomp", &external, &authorization.token)
            .unwrap();
        assert!(
            service
                .register_external_runtime("dkc3-recomp", &external, &authorization.token)
                .is_err()
        );
        drop(service);
        let mut reopened = service_with_release(Library::open(&library_root).unwrap(), "v1");
        reopened.replace_catalog_for_test(
            Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap(),
        );
        let (retained_record, catalog) = reopened
            .library
            .external_runtime_with_port("dkc3-recomp")
            .unwrap()
            .unwrap();
        assert_eq!(retained_record.id, record.id);
        let prepare = |source_override| {
            reopened.prepare_launch_for_external(
                &retained_record,
                &catalog,
                source_override,
                &OperationCoordinator::new("launch", None),
            )
        };
        let private_path = reopened.library.user_dir("dkc3-recomp");
        assert!(!private_path.exists());
        fs::write(&source, b"wrong original source").unwrap();
        assert!(prepare(None).is_err());
        assert!(!private_path.exists());
        fs::write(&source, source_bytes).unwrap();
        let launch = prepare(None).unwrap();
        assert_eq!(launch.arguments, [source.to_str().unwrap()]);
        assert_eq!(launch.executable, expected_external.join("DKC3Recomp.exe"));
        assert_eq!(launch.working_directory, expected_external);
        let mut expected_environment = [("SNESRECOMP_NO_LAUNCHER".into(), "1".into())]
            .into_iter()
            .collect::<std::collections::BTreeMap<String, String>>();
        if private {
            expected_environment.insert(
                "FIXTURE_USER_DIR".into(),
                private_path.to_str().unwrap().into(),
            );
        }
        assert_eq!(launch.environment, expected_environment);
        assert_eq!(launch.launch_kind, crate::LaunchKind::Native);
        let command = ChildProcessPolicy::game_command(&launch.process_spec(), &[]).unwrap();
        assert_eq!(command.get_args().collect::<Vec<_>>(), [source.as_os_str()]);
        assert!(prepare(Some(&source)).is_ok());
        for changed in [
            b"changed original".to_vec(),
            [vec![0_u8; 512], source_bytes.to_vec()].concat(),
        ] {
            fs::write(&source, changed).unwrap();
            assert!(prepare(None).is_err());
            assert!(prepare(Some(&source)).is_err());
        }
        fs::write(&source, source_bytes).unwrap();
        let wrong_extension = temporary.path().join("wrong.smc");
        fs::write(&wrong_extension, source_bytes).unwrap();
        assert!(prepare(Some(&wrong_extension)).is_err());
        fs::rename(&source, temporary.path().join("moved.sfc")).unwrap();
        assert!(prepare(None).is_err());
        fs::rename(temporary.path().join("moved.sfc"), &source).unwrap();
        fs::write(external.join("DKC3Recomp.exe"), b"altered executable").unwrap();
        assert!(prepare(None).is_err());
        fs::write(external.join("DKC3Recomp.exe"), b"inert executable fixture").unwrap();
        fs::write(external.join("SDL2.dll"), b"altered dependency").unwrap();
        assert!(prepare(None).is_err());
        fs::write(external.join("SDL2.dll"), b"inert immutable dependency").unwrap();
        fs::write(external.join("rom.cfg"), source.to_str().unwrap()).unwrap();
        fs::write(external.join("launcher.cfg"), b"player settings").unwrap();
        assert!(prepare(None).is_ok());
        fs::write(external.join("unknown-save.out"), b"unmapped user data").unwrap();
        assert!(prepare(None).is_err());
        assert!(
            reopened
                .remove_external_runtime("dkc3-recomp", "unreviewed")
                .is_err()
        );
        let removal = reopened.preview_external_removal("dkc3-recomp").unwrap();
        assert!(removal.external_files_will_be_preserved);
        let authorization = reopened
            .authorize_external_removal("dkc3-recomp", &removal.preview_sha256)
            .unwrap();
        reopened
            .remove_external_runtime("dkc3-recomp", &authorization.token)
            .unwrap();
        assert!(
            reopened
                .library
                .external_runtime_with_port("dkc3-recomp")
                .unwrap()
                .is_none()
        );
        for (relative, bytes) in [
            ("DKC3Recomp.exe", b"inert executable fixture".as_slice()),
            ("SDL2.dll", b"inert immutable dependency".as_slice()),
            ("saves/unknown-save.dat", b"player save".as_slice()),
            ("launcher.cfg", b"player settings".as_slice()),
            ("unknown-save.out", b"unmapped user data".as_slice()),
            ("rom.cfg", source.to_str().unwrap().as_bytes()),
        ] {
            assert_eq!(fs::read(external.join(relative)).unwrap(), bytes);
        }
        assert_eq!(fs::read(&source).unwrap(), source_bytes);
    }

    #[test]
    fn external_source_representation_uses_retained_contract_without_changing_source_health() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let external = temporary.path().join("player-owned");
        fs::create_dir(&external).unwrap();
        let platform = Platform::current().unwrap();
        // This test inspects readiness and launch arguments, never executes a child.
        let executable_name = "game.exe".to_owned();
        fs::write(external.join(&executable_name), b"inert reviewed runtime").unwrap();
        let mut runtime = crate::UserPreparedRuntimeSpec {
            trust: crate::ExternalRuntimeTrust::AcceptedPackage,
            version: "probe-v1".into(),
            archive_name: "probe.zip".into(),
            archive_size: 1,
            archive_sha256: "a".repeat(64),
            executable: executable_name.clone(),
            immutable_tree_sha256: "0".repeat(64),
            source_argument_extension: Some("z64".into()),
            source_directory_environment: false,
            library_user_data: false,
            required_mutable_files: vec![],
            settings_contract: None,
            shared_preferences: None,
            mutable_paths: vec!["general.json".into()],
        };
        runtime.immutable_tree_sha256 =
            crate::external_runtime::inspect(&external, &runtime, library.root())
                .unwrap_err()
                .details["actual_tree_sha256"]
                .clone();
        let mut service = service_with_release(library.clone(), "v1");
        let mut document = service.catalog().authoritative_document();
        let mut port = service.catalog().port("zelda64-recomp").unwrap().clone();
        port.id = "external-source-probe".into();
        port.platforms = vec![platform];
        port.automated_tested_platforms.clear();
        port.manually_validated_platforms.clear();
        port.source_profile = Some("star-fox-64".into());
        port.bios_source_profile = None;
        port.launch_arguments = vec!["--launch".into()];
        port.runtime_source_filename = None;
        port.persistent_paths.clear();
        port.presentation = None;
        port.release.provider = ReleaseSource::UserPrepared;
        port.release.asset_hints.clear();
        port.release.user_prepared.insert(platform, runtime);
        port.executable_hints = [(platform, vec![executable_name.clone()])].into();
        document.ports.push(port.clone());
        let mut sibling = port.clone();
        sibling.id = "external-source-sibling".into();
        sibling
            .release
            .user_prepared
            .get_mut(&platform)
            .unwrap()
            .source_argument_extension = None;
        document.ports.push(sibling);
        let source_catalog = document.source_catalog.as_mut().unwrap();
        let binding = source_catalog
            .contracts
            .iter()
            .find(|contract| contract.profile_id == "star-fox-64")
            .unwrap()
            .clone();
        for id in [port.id.as_str(), "external-source-sibling"] {
            let mut binding = binding.clone();
            binding.id = format!("{id}-game-source");
            binding.port_id = id.into();
            source_catalog.contracts.push(binding);
        }
        service.replace_catalog_for_test(
            Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap(),
        );
        for id in [port.id.as_str(), "external-source-sibling"] {
            let token = service
                .authorize_external_runtime(
                    id,
                    &external,
                    &service
                        .preview_external_runtime(id, &external)
                        .unwrap()
                        .preview_sha256,
                )
                .unwrap();
            service
                .register_external_runtime(id, &external, &token.token)
                .unwrap();
        }
        let raw = temporary.path().join("original.Z64");
        fs::write(&raw, b"\x80\x37\x12\x40synthetic original source\0\0\0").unwrap();
        let zipped = temporary.path().join("original.zip");
        let mut archive = zip::ZipWriter::new(fs::File::create(&zipped).unwrap());
        archive
            .start_file("original.z64", zip::write::SimpleFileOptions::default())
            .unwrap();
        std::io::Write::write_all(
            &mut archive,
            b"\x80\x37\x12\x40synthetic original source\0\0\0",
        )
        .unwrap();
        archive.finish().unwrap();
        service.register_source("star-fox-64", &zipped).unwrap();
        let zip_bytes = fs::read(&zipped).unwrap();
        let database_before = fs::read(library.root().join("portcove.sqlite3")).unwrap();
        let batch = service.statuses().unwrap();
        let sibling = batch
            .iter()
            .find(|status| status.port_id == "external-source-sibling")
            .unwrap();
        assert!(
            sibling.readiness.as_ref().unwrap().launchable,
            "per-runtime incompatibility must not contaminate shared source-health cache"
        );
        assert!(
            service
                .status("zelda64-recomp")
                .unwrap()
                .readiness
                .unwrap()
                .required_source_extension
                .is_none(),
            "managed runtimes keep their source materialization contract"
        );
        for status in [
            service.status(&port.id).unwrap(),
            batch
                .into_iter()
                .find(|status| status.port_id == port.id)
                .unwrap(),
        ] {
            let readiness = status.readiness.unwrap();
            assert_eq!(readiness.source, Some(SourceHealth::NotChecked));
            assert_eq!(readiness.required_source_extension.as_deref(), Some("z64"));
            assert_eq!(readiness.blockers, [LaunchBlocker::IncompatibleSource]);
            assert!(!readiness.launchable);
            let launch = status
                .port_actions
                .iter()
                .find(|action| action.action == PortAction::Launch)
                .unwrap();
            assert_eq!(launch.availability, PortActionAvailability::Waiting);
            assert_eq!(launch.reason, PortActionReason::IncompatibleSource);
        }
        assert_eq!(
            fs::read(library.root().join("portcove.sqlite3")).unwrap(),
            database_before
        );
        let sibling_readiness = service
            .status("external-source-sibling")
            .unwrap()
            .readiness
            .unwrap();
        assert!(sibling_readiness.launchable);
        assert_eq!(sibling_readiness.source, Some(SourceHealth::NotChecked));
        assert!(sibling_readiness.required_source_extension.is_none());
        assert_eq!(
            service
                .supervise_launch(&port.id, None, &[], LaunchStdio::Null, |_| panic!(
                    "incompatible ZIP must fail before a game child starts"
                ))
                .unwrap_err()
                .code,
            crate::ErrorCode::SourceInvalid
        );
        // A catalog update cannot reinterpret the already registered runtime.
        let changed_port = document
            .ports
            .iter_mut()
            .find(|entry| entry.id == port.id)
            .unwrap();
        changed_port.launch_arguments = vec!["--different-catalog-launch".into()];
        changed_port
            .release
            .user_prepared
            .get_mut(&platform)
            .unwrap()
            .source_argument_extension = Some("n64".into());
        service.replace_catalog_for_test(
            Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap(),
        );
        assert_eq!(
            service
                .status(&port.id)
                .unwrap()
                .readiness
                .unwrap()
                .required_source_extension
                .as_deref(),
            Some("z64")
        );
        service.register_source("star-fox-64", &raw).unwrap();
        let ready = service.status(&port.id).unwrap();
        assert!(ready.readiness.unwrap().launchable);
        assert_eq!(
            ready
                .port_actions
                .iter()
                .find(|action| action.action == PortAction::Launch)
                .unwrap()
                .availability,
            PortActionAvailability::Allowed
        );
        let (record, retained) = library
            .external_runtime_with_port(&port.id)
            .unwrap()
            .unwrap();
        let launch = service
            .prepare_launch_for_external(
                &record,
                &retained,
                None,
                &OperationCoordinator::new("launch", None),
            )
            .unwrap();
        assert_eq!(
            launch.arguments,
            [raw.to_string_lossy().into_owned(), "--launch".into()]
        );
        assert_eq!(
            service
                .supervise_launch(&port.id, Some(&zipped), &[], LaunchStdio::Null, |_| panic!(
                    "incompatible override must fail before child launch"
                ))
                .unwrap_err()
                .code,
            crate::ErrorCode::SourceInvalid
        );
        assert_eq!(
            fs::read(&raw).unwrap(),
            b"\x80\x37\x12\x40synthetic original source\0\0\0"
        );
        assert_eq!(fs::read(&zipped).unwrap(), zip_bytes);
        assert!(
            !external.join("general.json").exists(),
            "no game child or source materialization"
        );
        fs::write(&raw, b"changed").unwrap();
        assert_eq!(
            service
                .status(&port.id)
                .unwrap()
                .readiness
                .unwrap()
                .blockers,
            [LaunchBlocker::ChangedSource]
        );
        fs::remove_file(&raw).unwrap();
        assert_eq!(
            service
                .status(&port.id)
                .unwrap()
                .readiness
                .unwrap()
                .blockers,
            [LaunchBlocker::MissingSource]
        );
    }

    #[cfg(windows)]
    #[test]
    fn shared_preferences_service_requires_fresh_ack_and_retains_nonowning_scope() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let external = temporary.path().join("external");
        fs::create_dir(&external).unwrap();
        let executable = "Resident_Evil_Gaiden__USA_.exe";
        fs::create_dir(external.join("saves")).unwrap();
        // Inert fixture: exact artifact metadata exercises consent, not executable acceptance.
        fs::write(external.join(executable), b"inert fixture").unwrap();
        let mut runtime: crate::UserPreparedRuntimeSpec = serde_json::from_value(serde_json::json!({
            "version":"0.4.1", "archive_name":"Resident_Evil_Gaiden_Recomp_v0.4.1_Windows.zip",
            "archive_size":33085815, "archive_sha256":"d16ba320c75a23765ef1e84c6f70f551612834914c70fd4c542e20ae7ce5dcc6",
            "executable":executable, "immutable_tree_sha256":"0".repeat(64),
            "source_argument_extension":"gbc", "shared_preferences":"regaiden041-windows",
            "mutable_paths":["config.ini", "runtime_prefs.ini", "saves", "snapshots", "imgui.ini"]
        })).unwrap();
        runtime.immutable_tree_sha256 =
            crate::external_runtime::inspect(&external, &runtime, library.root())
                .unwrap_err()
                .details["actual_tree_sha256"]
                .clone();
        let mut service = service_with_release(library.clone(), "v1");
        let mut document = Catalog::from_json(include_str!(
            "../tests/fixtures/dkc3-006-prepared-historical.json"
        ))
        .unwrap()
        .authoritative_document();
        let source = temporary.path().join("original.gbc");
        let source_bytes = b"inert GBC source fixture";
        fs::write(&source, source_bytes).unwrap();
        let source_profile = document
            .source_catalog
            .as_mut()
            .unwrap()
            .identities
            .iter_mut()
            .find(|profile| profile.id == "dkc3-na-en-fr")
            .unwrap();
        source_profile.variants[0].representations[0].extensions = vec!["gbc".into()];
        let crate::SourceRepresentationKind::RawFile { identities } =
            &mut source_profile.variants[0].representations[0].kind
        else {
            panic!("raw fixture required")
        };
        identities[0].sha1 = None;
        identities[0].crc32 = None;
        identities[0].sha256 = Some(hex::encode(Sha256::digest(source_bytes)));
        let port = document
            .ports
            .iter_mut()
            .find(|p| p.id == "dkc3-recomp")
            .unwrap();
        port.platforms = vec![Platform::WindowsX86_64];
        port.release.user_prepared = [(Platform::WindowsX86_64, runtime)].into();
        port.executable_hints = [(Platform::WindowsX86_64, vec![executable.into()])].into();
        port.launch_arguments = vec!["--save-dir".into(), "saves".into()];
        let mut wrong_argv = document.clone();
        wrong_argv
            .ports
            .iter_mut()
            .find(|p| p.id == "dkc3-recomp")
            .unwrap()
            .launch_arguments
            .push("--rom".into());
        assert!(Catalog::from_json(&serde_json::to_string(&wrong_argv).unwrap()).is_err());
        service.replace_catalog_for_test(
            Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap(),
        );
        let preview = service
            .preview_external_runtime("dkc3-recomp", &external)
            .unwrap();
        let shared = preview.shared_preferences.as_ref().unwrap();
        let global_before = fs::read(&shared.binding.path).ok();
        let parent_before = shared.binding.path.parent().unwrap().exists();
        assert!(!shared.local_fallback_path.as_ref().unwrap().exists());
        assert!(
            service
                .authorize_external_runtime("dkc3-recomp", &external, &preview.preview_sha256)
                .is_err()
        );
        assert!(
            service
                .authorize_external_runtime_with_shared_preferences_ack(
                    "dkc3-recomp",
                    &external,
                    &preview.preview_sha256,
                    Some(&"f".repeat(64))
                )
                .is_err()
        );
        assert!(
            service
                .authorize_external_runtime_with_shared_preferences_ack(
                    "dkc3-recomp",
                    &external,
                    &"f".repeat(64),
                    Some(&preview.preview_sha256)
                )
                .is_err()
        );
        assert!(
            library
                .external_runtime_with_port("dkc3-recomp")
                .unwrap()
                .is_none()
        );
        let authorization = service
            .authorize_external_runtime_with_shared_preferences_ack(
                "dkc3-recomp",
                &external,
                &preview.preview_sha256,
                Some(&preview.preview_sha256),
            )
            .unwrap();
        let record = service
            .register_external_runtime("dkc3-recomp", &external, &authorization.token)
            .unwrap();
        service.register_source("dkc3-na-en-fr", &source).unwrap();
        let launch = prepare_external_location_fixture_launch(&service, &record).unwrap();
        assert_eq!(
            launch.arguments,
            [
                "--rom".to_owned(),
                source.display().to_string(),
                "--save-dir".into(),
                "saves".into()
            ]
        );
        for relative in [
            "config.ini",
            "imgui.ini",
            "saves/state.tmp-v1",
            "snapshots/state_00.bin",
        ] {
            let target = external.join(relative);
            fs::create_dir_all(target.parent().unwrap()).unwrap();
            fs::hard_link(external.join(executable), &target).unwrap();
            assert!(prepare_external_location_fixture_launch(&service, &record).is_err());
            fs::remove_file(target).unwrap();
        }
        fs::create_dir(external.join("imgui.ini")).unwrap();
        assert!(prepare_external_location_fixture_launch(&service, &record).is_err());
        fs::remove_dir(external.join("imgui.ini")).unwrap();
        fs::write(external.join("imgui.ini"), b"player window preferences").unwrap();
        prepare_external_location_fixture_launch(&service, &record).unwrap();
        fs::remove_dir(external.join("saves")).unwrap();
        assert!(prepare_external_location_fixture_launch(&service, &record).is_err());
        fs::create_dir(external.join("saves")).unwrap();
        let unicode_source = temporary.path().join("original-\u{e9}.gbc");
        fs::write(&unicode_source, source_bytes).unwrap();
        let (_, retained) = library
            .external_runtime_with_port("dkc3-recomp")
            .unwrap()
            .unwrap();
        assert!(
            service
                .prepare_launch_for_external(
                    &record,
                    &retained,
                    Some(&unicode_source),
                    &OperationCoordinator::new("launch", None)
                )
                .is_err()
        );
        let retained_json: String = library.connection().unwrap().query_row(
            "SELECT retained_catalog_json FROM external_runtime_registrations WHERE port_id = ?1",
            ["dkc3-recomp"], |row| row.get(0)).unwrap();
        assert!(
            serde_json::from_str::<serde_json::Value>(&retained_json)
                .unwrap()
                .get("format")
                .is_some()
        );
        assert!(
            Catalog::from_json(&retained_json).is_err(),
            "legacy raw catalog reader must refuse strict retained envelope"
        );
        struct RedirectPreferencesAtSpawn(std::path::PathBuf);
        impl LifecycleFaultInjector for RedirectPreferencesAtSpawn {
            fn check(&self, point: LifecycleFaultPoint) -> Result<()> {
                if point == LifecycleFaultPoint::LaunchReadyToSpawn {
                    fs::create_dir(&self.0)?;
                }
                Ok(())
            }
        }
        service.faults = Arc::new(RedirectPreferencesAtSpawn(
            shared.local_fallback_path.clone().unwrap(),
        ));
        let refusal = service
            .supervise_launch("dkc3-recomp", None, &[], LaunchStdio::Null, |_| {
                panic!("unsafe preferences must refuse before child creation")
            })
            .unwrap_err();
        assert_eq!(refusal.code, crate::ErrorCode::Verification);
        assert!(shared.local_fallback_path.as_ref().unwrap().is_dir());
        fs::remove_dir(shared.local_fallback_path.as_ref().unwrap()).unwrap();
        service.faults = Arc::new(crate::operation::NoLifecycleFaults);
        assert_eq!(record.shared_preferences.as_ref().unwrap(), &shared.binding);
        assert!(
            service
                .register_external_runtime("dkc3-recomp", &external, &authorization.token)
                .is_err()
        );
        let mut wrong_account = record.clone();
        wrong_account
            .shared_preferences
            .as_mut()
            .unwrap()
            .account_sid_sha256 = "f".repeat(64);
        let spec = &document
            .ports
            .iter()
            .find(|p| p.id == "dkc3-recomp")
            .unwrap()
            .release
            .user_prepared[&Platform::WindowsX86_64];
        assert!(
            crate::external_runtime::shared_preferences::check_record(&wrong_account, spec)
                .is_err()
        );
        let mut missing_binding = record.clone();
        missing_binding.shared_preferences = None;
        assert!(
            crate::external_runtime::shared_preferences::check_binding(&missing_binding, spec)
                .is_err()
        );
        assert!(!shared.local_fallback_path.as_ref().unwrap().exists());
        // Player changes remain mutable. An alias at the fallback still refuses readiness.
        fs::write(
            shared.local_fallback_path.as_ref().unwrap(),
            b"player preferences",
        )
        .unwrap();
        crate::external_runtime::shared_preferences::check_record(&record, spec).unwrap();
        fs::hard_link(
            shared.local_fallback_path.as_ref().unwrap(),
            external.join("alias"),
        )
        .unwrap();
        assert!(crate::external_runtime::shared_preferences::check_record(&record, spec).is_err());
        fs::remove_file(external.join("alias")).unwrap();
        let mut reopened = service_with_release(Library::open(library.root()).unwrap(), "v1");
        // Current catalog removal cannot erase the retained consent or prevent removal.
        document.ports.retain(|p| p.id != "dkc3-recomp");
        document
            .source_catalog
            .as_mut()
            .unwrap()
            .qualification
            .retain(|record| record.scope.port_id != "dkc3-recomp");
        document
            .source_catalog
            .as_mut()
            .unwrap()
            .contracts
            .retain(|record| record.port_id != "dkc3-recomp");
        reopened.replace_catalog_for_test(
            Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap(),
        );
        assert_eq!(
            library
                .external_runtime_with_port("dkc3-recomp")
                .unwrap()
                .unwrap()
                .0
                .shared_preferences,
            record.shared_preferences
        );
        let removal = reopened.preview_external_removal("dkc3-recomp").unwrap();
        let authorization = reopened
            .authorize_external_removal("dkc3-recomp", &removal.preview_sha256)
            .unwrap();
        reopened
            .remove_external_runtime("dkc3-recomp", &authorization.token)
            .unwrap();
        assert_eq!(
            fs::read(shared.local_fallback_path.as_ref().unwrap()).unwrap(),
            b"player preferences"
        );
        assert_eq!(fs::read(&shared.binding.path).ok(), global_before);
        assert_eq!(
            shared.binding.path.parent().unwrap().exists(),
            parent_before
        );
        assert!(external.join(executable).is_file());
        assert_eq!(
            fs::read(external.join("imgui.ini")).unwrap(),
            b"player window preferences"
        );
    }

    #[test]
    fn external_runtime_register_launch_restart_and_remove_preserve_player_files() {
        let temporary = tempfile::tempdir().unwrap();
        let library_root = temporary.path().join("library");
        let library = Library::open(&library_root).unwrap();
        let probe = register_launch_probe(&library, "v1", true);
        let external = temporary.path().join("player-owned");
        fs::create_dir(&external).unwrap();
        let executable_name = if cfg!(windows) {
            "zelda64recompiled.exe"
        } else {
            "zelda64recompiled"
        };
        let executable = external.join(executable_name);
        fs::copy(probe.path.join(executable_name), &executable).unwrap();

        let platform = Platform::current().unwrap();
        let mut runtime = crate::UserPreparedRuntimeSpec {
            trust: crate::ExternalRuntimeTrust::AcceptedPackage,
            version: "probe-v1".into(),
            archive_name: "probe.zip".into(),
            archive_size: 1,
            archive_sha256: "a".repeat(64),
            executable: executable_name.into(),
            immutable_tree_sha256: "0".repeat(64),
            source_argument_extension: None,
            source_directory_environment: false,
            library_user_data: false,
            required_mutable_files: vec![],
            settings_contract: None,
            shared_preferences: None,
            mutable_paths: vec!["general.json".into()],
        };
        let mismatch =
            crate::external_runtime::inspect(&external, &runtime, &library_root).unwrap_err();
        runtime.immutable_tree_sha256 = mismatch.details["actual_tree_sha256"].clone();

        let mut service = service_with_release(library.clone(), "v1");
        let mut document = service.catalog().authoritative_document();
        let mut port = document
            .ports
            .iter()
            .find(|port| port.id == "zelda64-recomp")
            .unwrap()
            .clone();
        port.id = "external-probe".into();
        port.name = "External probe".into();
        port.platforms = vec![platform];
        port.automated_tested_platforms.clear();
        port.manually_validated_platforms.clear();
        port.source_profile = None;
        port.bios_source_profile = None;
        port.runtime_source_filename = None;
        port.persistent_paths.clear();
        port.presentation = None;
        port.release.provider = ReleaseSource::UserPrepared;
        port.release.asset_hints.clear();
        port.release.user_prepared.insert(platform, runtime);
        port.executable_hints = [(platform, vec![executable_name.into()])].into();
        document.ports.push(port);
        let catalog = Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap();
        service.replace_catalog_for_test(catalog);

        let preview = service
            .preview_external_runtime("external-probe", &external)
            .unwrap();
        let accepted_bytes = fs::read(&executable).unwrap();
        fs::write(&executable, b"changed after review").unwrap();
        assert_eq!(
            service
                .authorize_external_runtime("external-probe", &external, &preview.preview_sha256)
                .unwrap_err()
                .code,
            crate::ErrorCode::Verification
        );
        fs::write(&executable, &accepted_bytes).unwrap();
        let mut changed_review = document.clone();
        changed_review
            .ports
            .iter_mut()
            .find(|port| port.id == "external-probe")
            .unwrap()
            .release
            .user_prepared
            .get_mut(&platform)
            .unwrap()
            .version = "probe-v2".into();
        service.replace_catalog_for_test(
            Catalog::from_json(&serde_json::to_string(&changed_review).unwrap()).unwrap(),
        );
        assert_eq!(
            service
                .authorize_external_runtime("external-probe", &external, &preview.preview_sha256)
                .unwrap_err()
                .code,
            crate::ErrorCode::Conflict
        );
        assert!(
            service
                .status("external-probe")
                .unwrap()
                .external_runtime
                .is_none()
        );
        service.replace_catalog_for_test(
            Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap(),
        );
        let authorization = service
            .authorize_external_runtime("external-probe", &external, &preview.preview_sha256)
            .unwrap();
        let record = service
            .register_external_runtime("external-probe", &external, &authorization.token)
            .unwrap();
        assert_eq!(record.path, fs::canonicalize(&external).unwrap());
        assert_eq!(
            service
                .preview_adoption(&external, Some("external-probe"))
                .unwrap_err()
                .code,
            crate::ErrorCode::Unsupported
        );
        let mut conflicting_install = probe.clone();
        conflicting_install.id = Uuid::new_v4().to_string();
        conflicting_install.port_id = "external-probe".into();
        assert_eq!(
            library
                .register_install(&conflicting_install, true)
                .unwrap_err()
                .code,
            crate::ErrorCode::Conflict
        );
        assert!(
            service
                .status("external-probe")
                .unwrap()
                .external_runtime
                .is_some()
        );

        drop(service);
        let mut reopened = service_with_release(Library::open(&library_root).unwrap(), "v1");
        reopened.replace_catalog_for_test(
            Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap(),
        );
        assert_eq!(
            reopened
                .status("external-probe")
                .unwrap()
                .external_runtime
                .unwrap()
                .id,
            record.id
        );
        let mut changed_definition = document.clone();
        changed_definition
            .ports
            .iter_mut()
            .find(|port| port.id == "external-probe")
            .unwrap()
            .release
            .user_prepared
            .get_mut(&platform)
            .unwrap()
            .immutable_tree_sha256 = "f".repeat(64);
        reopened.replace_catalog_for_test(
            Catalog::from_json(&serde_json::to_string(&changed_definition).unwrap()).unwrap(),
        );
        assert_eq!(
            reopened
                .status("external-probe")
                .unwrap()
                .external_runtime
                .unwrap()
                .immutable_tree_sha256,
            record.immutable_tree_sha256
        );
        let marker = temporary.path().join("started");
        let arguments = vec![
            marker.display().to_string(),
            "0".into(),
            "player settings".into(),
            "0".into(),
        ];
        let request_id = Uuid::new_v4().to_string();
        let outcome = reopened
            .supervise_launch_identified(
                IdentifiedLaunchRequest {
                    request_id: &request_id,
                    port_id: "external-probe",
                    source_override: None,
                    arguments: &arguments,
                    stdio: LaunchStdio::Null,
                },
                |session| assert_eq!(session.owner_kind, crate::LaunchOwnerKind::External),
                |_| {},
            )
            .unwrap();
        assert!(outcome.successful);
        assert_eq!(fs::read(&marker).unwrap(), b"started");
        assert_eq!(
            fs::read(external.join("general.json")).unwrap(),
            b"player settings"
        );
        assert!(!external.join(LAUNCH_MARKER).exists());
        assert!(
            reopened
                .supervise_launch_identified(
                    IdentifiedLaunchRequest {
                        request_id: &Uuid::new_v4().to_string(),
                        port_id: "external-probe",
                        source_override: None,
                        arguments: &arguments,
                        stdio: LaunchStdio::Null,
                    },
                    |_| {},
                    |_| {},
                )
                .unwrap()
                .successful
        );

        fs::write(external.join("foreign.dll"), b"unrecognized loader").unwrap();
        assert_eq!(
            reopened
                .supervise_launch_identified(
                    IdentifiedLaunchRequest {
                        request_id: &Uuid::new_v4().to_string(),
                        port_id: "external-probe",
                        source_override: None,
                        arguments: &arguments,
                        stdio: LaunchStdio::Null,
                    },
                    |_| {},
                    |_| panic!("changed external tree must not start"),
                )
                .unwrap_err()
                .code,
            crate::ErrorCode::Verification
        );

        let removal = reopened.preview_external_removal("external-probe").unwrap();
        assert!(removal.external_files_will_be_preserved);
        library.remove_external_runtime(&record).unwrap();
        let mut replacement = record.clone();
        replacement.id = Uuid::new_v4().to_string();
        library
            .register_external_runtime(
                &replacement,
                &Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap(),
            )
            .unwrap();
        assert_eq!(
            reopened
                .authorize_external_removal("external-probe", &removal.preview_sha256)
                .unwrap_err()
                .code,
            crate::ErrorCode::Conflict
        );
        assert_eq!(
            reopened
                .status("external-probe")
                .unwrap()
                .external_runtime
                .unwrap()
                .id,
            replacement.id
        );
        let removal = reopened.preview_external_removal("external-probe").unwrap();
        let authorization = reopened
            .authorize_external_removal("external-probe", &removal.preview_sha256)
            .unwrap();
        reopened
            .remove_external_runtime("external-probe", &authorization.token)
            .unwrap();
        assert!(
            reopened
                .status("external-probe")
                .unwrap()
                .external_runtime
                .is_none()
        );
        assert!(executable.is_file());
        assert_eq!(
            fs::read(external.join("foreign.dll")).unwrap(),
            b"unrecognized loader"
        );
        assert_eq!(
            fs::read(external.join("general.json")).unwrap(),
            b"player settings"
        );
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
            crate::test_fixture::retained_qualification(&port, Platform::current().unwrap())
                .unwrap();
        let (manifest_sha256, selected_executable, runtime) = Installer::new(library.clone())
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
                    runtime,
                },
                active,
            )
            .unwrap();
        path
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
        assert_eq!(
            download.output_location.effective_output_directory,
            library.versions_dir().join("zelda64-recomp")
        );
        assert_eq!(
            download.output_location.selection_source,
            OutputLocationSource::LibraryDefault
        );
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

    #[test]
    fn per_port_output_resolution_is_independent_and_never_reinterprets_existing_installs() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let service = service_with_release(library.clone(), "v1");
        let active = register_zelda_install(&library, "v1", true);
        let zelda_output = temporary.path().join("outputs/zelda");
        let starship_output = temporary.path().join("outputs/starship");
        let request_output = temporary.path().join("one-request");

        let zelda = service
            .set_output_directory("zelda64-recomp", &zelda_output)
            .unwrap();
        let starship = service
            .set_output_directory("starship", &starship_output)
            .unwrap();

        assert_eq!(zelda.selection_source, OutputLocationSource::PortSetting);
        assert_eq!(
            zelda.effective_output_directory,
            crate::path::resolve_existing_ancestor(&zelda_output).unwrap()
        );
        assert_eq!(
            starship.effective_output_directory,
            crate::path::resolve_existing_ancestor(&starship_output).unwrap()
        );
        let requested = service
            .output_location("zelda64-recomp", Some(&request_output))
            .unwrap();
        assert_eq!(
            requested.selection_source,
            OutputLocationSource::RequestOverride
        );
        assert_eq!(
            requested.configured_output_directory,
            Some(crate::path::resolve_existing_ancestor(&zelda_output).unwrap())
        );
        assert_eq!(
            requested.effective_output_directory,
            crate::path::resolve_existing_ancestor(&request_output).unwrap()
        );
        assert!(!zelda_output.exists());
        assert!(!starship_output.exists());
        assert!(!request_output.exists());
        assert_eq!(
            service
                .status("zelda64-recomp")
                .unwrap()
                .active
                .unwrap()
                .path,
            active
        );

        let reset = service.reset_output_directory("zelda64-recomp").unwrap();
        assert_eq!(reset.selection_source, OutputLocationSource::LibraryDefault);
        assert_eq!(
            reset.effective_output_directory,
            library.versions_dir().join("zelda64-recomp")
        );
        assert_eq!(
            service
                .status("zelda64-recomp")
                .unwrap()
                .active
                .unwrap()
                .path,
            active
        );
        assert_eq!(
            service
                .output_location("starship", None)
                .unwrap()
                .effective_output_directory,
            crate::path::resolve_existing_ancestor(&starship_output).unwrap()
        );
        let empty = service
            .set_output_directory("starship", Path::new(""))
            .unwrap_err();
        assert_eq!(empty.code, crate::ErrorCode::Usage);
        assert_eq!(
            service
                .output_location("starship", None)
                .unwrap()
                .effective_output_directory,
            crate::path::resolve_existing_ancestor(&starship_output).unwrap()
        );
    }

    #[test]
    fn output_preview_is_read_only_state_bound_and_never_relocates_an_install() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let service = service_with_release(library.clone(), "v1");
        let active = register_zelda_install(&library, "v1", true);
        let destination = temporary.path().join("future-output");

        let preview = service
            .preview_output_directory("zelda64-recomp", Some(&destination))
            .unwrap();

        assert_eq!(
            preview.ownership,
            crate::OutputDestinationOwnership::Unclaimed
        );
        assert_eq!(
            preview.availability,
            crate::OutputDestinationAvailability::Available
        );
        assert!(preview.available_bytes.is_some());
        assert_eq!(preview.affected_installs.len(), 1);
        assert!(preview.affected_installs[0].active);
        assert!(!preview.moves_existing_install);
        assert!(!destination.exists());
        assert!(
            library
                .output_directory("zelda64-recomp")
                .unwrap()
                .is_none()
        );

        let authorization = service
            .authorize_output_directory_change(
                "zelda64-recomp",
                Some(&destination),
                &preview.preview_sha256,
            )
            .unwrap();
        service
            .set_output_directory("zelda64-recomp", &temporary.path().join("changed"))
            .unwrap();
        let stale = service
            .apply_output_directory_change(
                "zelda64-recomp",
                Some(&destination),
                &authorization.token,
            )
            .unwrap_err();
        assert_eq!(stale.code, crate::ErrorCode::Conflict);

        let current = service
            .preview_output_directory("zelda64-recomp", Some(&destination))
            .unwrap();
        let authorization = service
            .authorize_output_directory_change(
                "zelda64-recomp",
                Some(&destination),
                &current.preview_sha256,
            )
            .unwrap();
        let saved = service
            .apply_output_directory_change(
                "zelda64-recomp",
                Some(&destination),
                &authorization.token,
            )
            .unwrap();
        assert_eq!(saved.selection_source, OutputLocationSource::PortSetting);
        assert_eq!(
            service
                .status("zelda64-recomp")
                .unwrap()
                .active
                .unwrap()
                .path,
            active
        );
        assert!(!destination.exists());
        assert!(
            service
                .apply_output_directory_change(
                    "zelda64-recomp",
                    Some(&destination),
                    &authorization.token,
                )
                .is_err()
        );
    }

    #[test]
    fn output_preview_reports_unsafe_content_and_rejects_relative_paths() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let service = service_with_release(library, "v1");
        let unrelated = temporary.path().join("unrelated");
        fs::create_dir(&unrelated).unwrap();
        fs::write(unrelated.join("keep.txt"), b"keep").unwrap();

        let preview = service
            .preview_output_directory("zelda64-recomp", Some(&unrelated))
            .unwrap();
        assert_eq!(
            preview.ownership,
            crate::OutputDestinationOwnership::UnrelatedContent
        );
        assert!(!preview.validation_errors.is_empty());
        assert!(
            service
                .authorize_output_directory_change(
                    "zelda64-recomp",
                    Some(&unrelated),
                    &preview.preview_sha256,
                )
                .is_err()
        );
        assert_eq!(fs::read(unrelated.join("keep.txt")).unwrap(), b"keep");

        let relative = service
            .preview_output_directory("zelda64-recomp", Some(Path::new("relative")))
            .unwrap_err();
        assert_eq!(relative.code, crate::ErrorCode::Usage);
    }

    #[test]
    fn output_change_revalidates_after_lock_contention_without_spending_consent() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("library");
        let library = Library::open(&root).unwrap();
        let service = service_with_release(library.clone(), "v1");
        let destination = temporary.path().join("future-output");
        let preview = service
            .preview_output_directory("zelda64-recomp", Some(&destination))
            .unwrap();
        let authorization = service
            .authorize_output_directory_change(
                "zelda64-recomp",
                Some(&destination),
                &preview.preview_sha256,
            )
            .unwrap();
        let competing = Library::open(root).unwrap();
        let guard = competing
            .try_lock_port("zelda64-recomp", "competing-operation")
            .unwrap();

        let busy = service
            .apply_output_directory_change(
                "zelda64-recomp",
                Some(&destination),
                &authorization.token,
            )
            .unwrap_err();
        assert_eq!(busy.code, crate::ErrorCode::Conflict);
        assert!(
            library
                .output_directory("zelda64-recomp")
                .unwrap()
                .is_none()
        );

        drop(guard);
        service
            .apply_output_directory_change(
                "zelda64-recomp",
                Some(&destination),
                &authorization.token,
            )
            .unwrap();
    }

    #[test]
    fn output_preview_matrix_is_read_only_for_inherited_custom_missing_and_owned_roots() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let service = service_with_release(library.clone(), "v1");

        let before = crate::test_fixture::library_file_snapshot(&library);
        let inherited = service
            .preview_output_directory("zelda64-recomp", None)
            .unwrap();
        assert_eq!(
            inherited.ownership,
            crate::OutputDestinationOwnership::LibraryDefault
        );
        assert_eq!(before, crate::test_fixture::library_file_snapshot(&library));

        let default_root = library.versions_dir().join("zelda64-recomp");
        fs::write(&default_root, b"tampered default root").unwrap();
        let default_file = service
            .preview_output_directory("zelda64-recomp", None)
            .unwrap();
        assert_eq!(
            default_file.ownership,
            crate::OutputDestinationOwnership::Invalid
        );
        assert!(!default_file.validation_errors.is_empty());
        fs::remove_file(default_root).unwrap();

        let custom = temporary.path().join("custom-output");
        fs::create_dir(&custom).unwrap();
        service
            .set_output_directory("zelda64-recomp", &custom)
            .unwrap();
        let before = crate::test_fixture::library_file_snapshot(&library);
        let custom_preview = service
            .preview_output_directory("zelda64-recomp", Some(&custom))
            .unwrap();
        assert_eq!(
            custom_preview.current.selection_source,
            OutputLocationSource::PortSetting
        );
        assert_eq!(
            custom_preview.ownership,
            crate::OutputDestinationOwnership::Unclaimed
        );
        assert_eq!(before, crate::test_fixture::library_file_snapshot(&library));

        let missing = temporary.path().join("missing-output");
        let before = crate::test_fixture::library_file_snapshot(&library);
        let missing_preview = service
            .preview_output_directory("zelda64-recomp", Some(&missing))
            .unwrap();
        assert_eq!(
            missing_preview.ownership,
            crate::OutputDestinationOwnership::Unclaimed
        );
        assert!(!missing.exists());
        assert_eq!(before, crate::test_fixture::library_file_snapshot(&library));

        let owned = temporary.path().join("owned-output");
        crate::output_root::prepare_for_install(
            &library,
            "zelda64-recomp",
            &owned,
            &Uuid::new_v4().to_string(),
            0,
        )
        .unwrap();
        let marker = owned.join(".portcove-game-output.json");
        let marker_before = fs::read(&marker).unwrap();
        let before = crate::test_fixture::library_file_snapshot(&library);
        let owned_preview = service
            .preview_output_directory("zelda64-recomp", Some(&owned))
            .unwrap();
        assert_eq!(
            owned_preview.ownership,
            crate::OutputDestinationOwnership::OwnedByPort
        );
        assert_eq!(marker_before, fs::read(marker).unwrap());
        assert_eq!(before, crate::test_fixture::library_file_snapshot(&library));
    }

    #[test]
    fn output_preview_reports_full_and_unavailable_volumes_without_mutation() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let service = service_with_release(library.clone(), "v1");
        let destination = temporary.path().join("future-output");
        let before = crate::test_fixture::library_file_snapshot(&library);

        {
            let _volume = crate::output_root::override_volume_details(
                crate::output_root::TestVolumeDetails::Available {
                    available_bytes: 0,
                    total_bytes: 1024,
                    volume_identity: "full-volume".into(),
                },
            );
            let full = service
                .preview_output_directory("zelda64-recomp", Some(&destination))
                .unwrap();
            assert_eq!(
                full.availability,
                crate::OutputDestinationAvailability::Full
            );
            assert_eq!(full.available_bytes, Some(0));
            assert!(!full.validation_errors.is_empty());
        }
        assert!(!destination.exists());
        assert_eq!(before, crate::test_fixture::library_file_snapshot(&library));

        {
            let _volume = crate::output_root::override_volume_details(
                crate::output_root::TestVolumeDetails::Unavailable(
                    "selected drive is unavailable".into(),
                ),
            );
            let unavailable = service
                .preview_output_directory("zelda64-recomp", Some(&destination))
                .unwrap();
            assert_eq!(
                unavailable.availability,
                crate::OutputDestinationAvailability::Unavailable
            );
            assert_eq!(unavailable.available_bytes, None);
            assert!(
                unavailable
                    .validation_errors
                    .iter()
                    .any(|message| message.contains("unavailable"))
            );
        }
        assert!(!destination.exists());
        assert_eq!(before, crate::test_fixture::library_file_snapshot(&library));
    }

    #[test]
    fn output_apply_rejects_changed_install_state() {
        let install_case = tempfile::tempdir().unwrap();
        let install_library = Library::open(install_case.path().join("library")).unwrap();
        let install_service = service_with_release(install_library.clone(), "v1");
        let install_destination = install_case.path().join("future-output");
        let preview = install_service
            .preview_output_directory("zelda64-recomp", Some(&install_destination))
            .unwrap();
        let authorization = install_service
            .authorize_output_directory_change(
                "zelda64-recomp",
                Some(&install_destination),
                &preview.preview_sha256,
            )
            .unwrap();
        register_zelda_install(&install_library, "v1", true);
        assert_eq!(
            install_service
                .apply_output_directory_change(
                    "zelda64-recomp",
                    Some(&install_destination),
                    &authorization.token,
                )
                .unwrap_err()
                .code,
            crate::ErrorCode::Conflict
        );
    }

    #[test]
    fn output_apply_rejects_changed_ownership_marker() {
        let marker_case = tempfile::tempdir().unwrap();
        let marker_library = Library::open(marker_case.path().join("library")).unwrap();
        let marker_service = service_with_release(marker_library.clone(), "v1");
        let owned = marker_case.path().join("owned-output");
        crate::output_root::prepare_for_install(
            &marker_library,
            "zelda64-recomp",
            &owned,
            &Uuid::new_v4().to_string(),
            0,
        )
        .unwrap();
        let preview = marker_service
            .preview_output_directory("zelda64-recomp", Some(&owned))
            .unwrap();
        let authorization = marker_service
            .authorize_output_directory_change(
                "zelda64-recomp",
                Some(&owned),
                &preview.preview_sha256,
            )
            .unwrap();
        fs::write(owned.join(".portcove-game-output.json"), b"{}").unwrap();
        assert_eq!(
            marker_service
                .apply_output_directory_change(
                    "zelda64-recomp",
                    Some(&owned),
                    &authorization.token,
                )
                .unwrap_err()
                .code,
            crate::ErrorCode::Conflict
        );
    }

    #[test]
    fn output_apply_accepts_capacity_changes_with_sufficient_space() {
        const CAPACITY_BAND: u64 = 256 * 1024 * 1024;
        let capacity_case = tempfile::tempdir().unwrap();
        let capacity_library = Library::open(capacity_case.path().join("library")).unwrap();
        let capacity_service = service_with_release(capacity_library.clone(), "v1");
        let capacity_destination = capacity_case.path().join("future-output");
        let initial_capacity = crate::output_root::override_volume_details(
            crate::output_root::TestVolumeDetails::Available {
                available_bytes: CAPACITY_BAND * 3,
                total_bytes: CAPACITY_BAND * 8,
                volume_identity: "capacity-volume".into(),
            },
        );
        let preview = capacity_service
            .preview_output_directory("zelda64-recomp", Some(&capacity_destination))
            .unwrap();
        let authorization = capacity_service
            .authorize_output_directory_change(
                "zelda64-recomp",
                Some(&capacity_destination),
                &preview.preview_sha256,
            )
            .unwrap();
        let changed_capacity = crate::output_root::override_volume_details(
            crate::output_root::TestVolumeDetails::Available {
                available_bytes: CAPACITY_BAND,
                total_bytes: CAPACITY_BAND * 8,
                volume_identity: "capacity-volume".into(),
            },
        );
        capacity_service
            .apply_output_directory_change(
                "zelda64-recomp",
                Some(&capacity_destination),
                &authorization.token,
            )
            .unwrap();
        drop(changed_capacity);
        drop(initial_capacity);
        assert!(
            capacity_library
                .output_directory("zelda64-recomp")
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn output_apply_rejects_exhausted_capacity() {
        const CAPACITY_BAND: u64 = 256 * 1024 * 1024;
        let full_case = tempfile::tempdir().unwrap();
        let full_library = Library::open(full_case.path().join("library")).unwrap();
        let full_service = service_with_release(full_library.clone(), "v1");
        let full_destination = full_case.path().join("future-output");
        let initial_capacity = crate::output_root::override_volume_details(
            crate::output_root::TestVolumeDetails::Available {
                available_bytes: CAPACITY_BAND * 3,
                total_bytes: CAPACITY_BAND * 8,
                volume_identity: "capacity-volume".into(),
            },
        );
        let preview = full_service
            .preview_output_directory("zelda64-recomp", Some(&full_destination))
            .unwrap();
        let authorization = full_service
            .authorize_output_directory_change(
                "zelda64-recomp",
                Some(&full_destination),
                &preview.preview_sha256,
            )
            .unwrap();
        let exhausted_capacity = crate::output_root::override_volume_details(
            crate::output_root::TestVolumeDetails::Available {
                available_bytes: 0,
                total_bytes: CAPACITY_BAND * 8,
                volume_identity: "capacity-volume".into(),
            },
        );
        assert_eq!(
            full_service
                .apply_output_directory_change(
                    "zelda64-recomp",
                    Some(&full_destination),
                    &authorization.token,
                )
                .unwrap_err()
                .code,
            crate::ErrorCode::Conflict
        );
        drop(exhausted_capacity);
        drop(initial_capacity);
        assert!(
            full_library
                .output_directory("zelda64-recomp")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn output_apply_rejects_a_disconnected_drive() {
        const CAPACITY_BAND: u64 = 256 * 1024 * 1024;
        let drive_case = tempfile::tempdir().unwrap();
        let drive_library = Library::open(drive_case.path().join("library")).unwrap();
        let drive_service = service_with_release(drive_library.clone(), "v1");
        let drive_destination = drive_case.path().join("future-output");
        let initial_drive = crate::output_root::override_volume_details(
            crate::output_root::TestVolumeDetails::Available {
                available_bytes: CAPACITY_BAND * 3,
                total_bytes: CAPACITY_BAND * 8,
                volume_identity: "removable-volume".into(),
            },
        );
        let preview = drive_service
            .preview_output_directory("zelda64-recomp", Some(&drive_destination))
            .unwrap();
        let authorization = drive_service
            .authorize_output_directory_change(
                "zelda64-recomp",
                Some(&drive_destination),
                &preview.preview_sha256,
            )
            .unwrap();
        let unavailable_drive = crate::output_root::override_volume_details(
            crate::output_root::TestVolumeDetails::Unavailable(
                "selected drive was disconnected".into(),
            ),
        );
        assert_eq!(
            drive_service
                .apply_output_directory_change(
                    "zelda64-recomp",
                    Some(&drive_destination),
                    &authorization.token,
                )
                .unwrap_err()
                .code,
            crate::ErrorCode::Conflict
        );
        drop(unavailable_drive);
        drop(initial_drive);
        assert!(
            drive_library
                .output_directory("zelda64-recomp")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn output_apply_rejects_a_different_port_identity() {
        let port_case = tempfile::tempdir().unwrap();
        let port_library = Library::open(port_case.path().join("library")).unwrap();
        let port_service = service_with_release(port_library.clone(), "v1");
        let port_destination = port_case.path().join("future-output");
        let preview = port_service
            .preview_output_directory("zelda64-recomp", Some(&port_destination))
            .unwrap();
        let authorization = port_service
            .authorize_output_directory_change(
                "zelda64-recomp",
                Some(&port_destination),
                &preview.preview_sha256,
            )
            .unwrap();
        assert_eq!(
            port_service
                .apply_output_directory_change(
                    "starship",
                    Some(&port_destination),
                    &authorization.token,
                )
                .unwrap_err()
                .code,
            crate::ErrorCode::Conflict
        );
        assert!(port_library.output_directory("starship").unwrap().is_none());
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
        assert_eq!(
            paths.output_location.effective_output_directory,
            library.versions_dir().join("zelda64-recomp")
        );
    }

    #[test]
    fn managed_launch_observation_preserves_files_before_explicit_preparation() {
        fn inventory(root: &Path) -> std::collections::BTreeMap<PathBuf, Option<Vec<u8>>> {
            fn visit(
                root: &Path,
                directory: &Path,
                entries: &mut std::collections::BTreeMap<PathBuf, Option<Vec<u8>>>,
            ) {
                for entry in fs::read_dir(directory).unwrap() {
                    let path = entry.unwrap().path();
                    let bytes = path.is_file().then(|| fs::read(&path).unwrap());
                    entries.insert(path.strip_prefix(root).unwrap().to_path_buf(), bytes);
                    if path.is_dir() {
                        visit(root, &path, entries);
                    }
                }
            }
            let mut entries = std::collections::BTreeMap::new();
            visit(root, root, &mut entries);
            entries
        }

        for previously_launched in [false, true] {
            let temporary = tempfile::tempdir().unwrap();
            let library = Library::open(temporary.path().join("library")).unwrap();
            let install = register_zelda_install(&library, "v1", true);
            let user_data = library.user_dir("zelda64-recomp");
            fs::create_dir_all(&user_data).unwrap();
            fs::write(user_data.join("general.json"), b"durable-settings").unwrap();
            fs::write(install.join("general.json"), b"last-session-settings").unwrap();
            if previously_launched {
                fs::write(install.join(LAUNCH_MARKER), b"1").unwrap();
            }
            let service = PortcoveService::new(library.clone()).unwrap();
            let port = service.catalog.port("zelda64-recomp").unwrap();
            let before = library.status(&port.id, ReleaseChannel::Stable).unwrap();
            let active = before.active.as_ref().unwrap();
            let files = inventory(temporary.path());

            let observed = service
                .observe_managed_launch_inputs(port, active, None, None)
                .unwrap();
            drop(observed);

            assert_eq!(inventory(temporary.path()), files, "{previously_launched}");
            assert_eq!(
                serde_json::to_value(library.status(&port.id, ReleaseChannel::Stable).unwrap())
                    .unwrap(),
                serde_json::to_value(&before).unwrap(),
            );
            let executable = active.path.join(&active.selected_executable);
            let original = fs::read(&executable).unwrap();
            fs::write(&executable, b"changed executable").unwrap();
            let invalid_files = inventory(temporary.path());
            let refusal = service
                .observe_managed_launch_inputs(port, active, None, None)
                .err()
                .expect("changed executable must fail observation");
            assert_eq!(refusal.code, crate::ErrorCode::Verification);
            assert_eq!(inventory(temporary.path()), invalid_files);
            fs::write(&executable, original).unwrap();

            let prepared = service.prepare_launch(&port.id, None).unwrap();
            assert_eq!(prepared.install_root, install);
            let expected = if previously_launched {
                b"last-session-settings".as_slice()
            } else {
                b"durable-settings".as_slice()
            };
            assert_eq!(fs::read(install.join("general.json")).unwrap(), expected);
            assert_eq!(fs::read(user_data.join("general.json")).unwrap(), expected);
        }
    }

    #[test]
    fn post_exit_sync_uses_the_version_that_was_launched() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let first = register_zelda_install(&library, "v1", true);
        let service = PortcoveService::new(library.clone()).unwrap();
        let launch = service.prepare_launch("zelda64-recomp", None).unwrap();
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

        service.prepare_launch("zelda64-recomp", None).unwrap();
        assert_eq!(
            fs::read(second.join("general.json")).unwrap(),
            b"from-v1-session"
        );

        fs::write(second.join("general.json"), b"recovered-after-crash").unwrap();
        fs::write(second.join(LAUNCH_MARKER), b"1").unwrap();
        service.prepare_launch("zelda64-recomp", None).unwrap();
        assert_eq!(
            fs::read(library.user_dir("zelda64-recomp").join("general.json")).unwrap(),
            b"recovered-after-crash"
        );
    }

    #[test]
    fn source_verification_is_read_only_and_preserves_the_registered_baseline() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let source = temporary.path().join("star-fox-64.z64");
        fs::write(&source, b"\x80\x37\x12\x40original source\0").unwrap();
        let service = PortcoveService::new(library.clone()).unwrap();
        let registered = service.register_source("star-fox-64", &source).unwrap();
        assert_eq!(
            registered
                .observed_identity
                .as_ref()
                .map(|identity| identity.schema_version),
            Some(1)
        );
        let database = library.root().join("portcove.sqlite3");
        let registered_json = serde_json::to_vec(&registered).unwrap();
        let database_before_success = fs::read(&database).unwrap();
        let source_before_success = fs::read(&source).unwrap();

        let verified = service.verify_source("star-fox-64").unwrap();
        assert_eq!(verified.sha256, registered.sha256);
        assert_eq!(verified.size, registered.size);
        assert_eq!(fs::read(&database).unwrap(), database_before_success);
        assert_eq!(fs::read(&source).unwrap(), source_before_success);
        assert_eq!(
            serde_json::to_vec(&library.source("star-fox-64").unwrap().unwrap()).unwrap(),
            registered_json
        );

        fs::write(&source, b"changed source").unwrap();
        let database_before_failure = fs::read(&database).unwrap();
        let source_before_failure = fs::read(&source).unwrap();
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
            serde_json::to_vec(&library.source("star-fox-64").unwrap().unwrap()).unwrap(),
            registered_json
        );
        assert_eq!(fs::read(&database).unwrap(), database_before_failure);
        assert_eq!(fs::read(&source).unwrap(), source_before_failure);
        let activities = library.activities(10).unwrap();
        assert_eq!(activities.len(), 1);
        assert_eq!(activities[0].operation, ActivityOperation::RegisterSource);
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
    fn status_requires_explicit_preparation_as_well_as_current_sources() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let install = library.versions_dir().join("opengoal-jak1").join("v1");
        fs::create_dir_all(&install).unwrap();
        write_host_test_executable(&install, "opengoal-jak1");
        register_existing_test_install(&library, "opengoal-jak1", "v1", &install, true);
        let service = PortcoveService::new(library.clone()).unwrap();

        let blocked = service.status("opengoal-jak1").unwrap().readiness.unwrap();
        assert!(!blocked.launchable);
        assert_eq!(
            blocked.blockers,
            [
                LaunchBlocker::MissingSource,
                LaunchBlocker::PreparationRequired
            ]
        );
        assert_eq!(blocked.source, Some(SourceHealth::Unregistered));
        assert!(blocked.pending_setup);

        let source_path = temporary.path().join("jak1.iso");
        fs::write(&source_path, b"registered source").unwrap();
        let (storage_sha256, storage_size) = crate::adapter::hash_file(&source_path).unwrap();
        library
            .register_source(&SourceRecord {
                profile_id: "opengoal-jak1-disc".into(),
                path: source_path.clone(),
                sha256: storage_sha256.clone(),
                size: storage_size,
                storage_sha256,
                storage_size,
                updated_at: Library::now(),
                observed_identity: None,
            })
            .unwrap();
        let pending = service.status("opengoal-jak1").unwrap().readiness.unwrap();
        assert!(!pending.launchable);
        assert_eq!(pending.blockers, [LaunchBlocker::PreparationRequired]);
        assert_eq!(pending.source, Some(SourceHealth::NotChecked));
        assert!(pending.pending_setup);

        fs::write(&source_path, b"registered sourcf longer").unwrap();
        let changed = service.status("opengoal-jak1").unwrap().readiness.unwrap();
        assert!(!changed.launchable);
        assert_eq!(
            changed.blockers,
            [
                LaunchBlocker::ChangedSource,
                LaunchBlocker::PreparationRequired
            ]
        );
        assert_eq!(changed.source, Some(SourceHealth::Changed));

        fs::remove_file(&source_path).unwrap();
        let missing = service.status("opengoal-jak1").unwrap().readiness.unwrap();
        assert!(!missing.launchable);
        assert_eq!(
            missing.blockers,
            [
                LaunchBlocker::MissingSource,
                LaunchBlocker::PreparationRequired
            ]
        );
        assert_eq!(missing.source, Some(SourceHealth::Missing));

        let marker = install.join("data/out/jak1/iso/0COMMON.TXT");
        fs::create_dir_all(marker.parent().unwrap()).unwrap();
        fs::write(marker, b"ready").unwrap();
        let still_missing = service.status("opengoal-jak1").unwrap().readiness.unwrap();
        assert!(!still_missing.launchable);
        // An unadmitted marker alone cannot establish prepared readiness.
        assert!(still_missing.pending_setup);
    }

    #[test]
    fn uninstalled_registered_sources_are_explicitly_not_checked() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let source_path = temporary.path().join("star-fox-64.z64");
        fs::write(&source_path, b"registered source").unwrap();
        let (storage_sha256, storage_size) = crate::adapter::hash_file(&source_path).unwrap();
        library
            .register_source(&SourceRecord {
                profile_id: "star-fox-64".into(),
                path: source_path,
                sha256: storage_sha256.clone(),
                size: storage_size,
                storage_sha256,
                storage_size,
                updated_at: Library::now(),
                observed_identity: None,
            })
            .unwrap();

        let readiness = PortcoveService::new(library)
            .unwrap()
            .status("starship")
            .unwrap()
            .readiness
            .unwrap();
        assert!(!readiness.launchable);
        assert!(readiness.blockers.is_empty());
        assert_eq!(readiness.source, Some(SourceHealth::NotChecked));
    }

    #[test]
    fn operation_projection_distinguishes_inputs_holds_and_review_without_granting_ownership() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let service = PortcoveService::new(library.clone()).unwrap();
        let action = |status: &PortStatus, wanted| {
            *status
                .port_actions
                .iter()
                .find(|item| item.action == wanted)
                .unwrap()
        };

        let empty = service.status("opengoal-jak1").unwrap();
        assert_eq!(
            action(&empty, PortAction::Rollback).availability,
            PortActionAvailability::NotOffered
        );
        assert_eq!(
            action(&empty, PortAction::Rollback).reason,
            PortActionReason::NotInstalled
        );
        assert_eq!(
            action(&empty, PortAction::Install).availability,
            PortActionAvailability::Waiting
        );
        assert_eq!(
            action(&empty, PortAction::Install).reason,
            PortActionReason::MissingSource
        );
        assert_eq!(
            action(&empty, PortAction::Launch).reason,
            PortActionReason::NotInstalled
        );
        assert_eq!(
            action(&empty, PortAction::RemoveManaged).availability,
            PortActionAvailability::NotOffered
        );

        let install = library.versions_dir().join("opengoal-jak1").join("v1");
        fs::create_dir_all(&install).unwrap();
        write_host_test_executable(&install, "opengoal-jak1");
        register_existing_test_install(&library, "opengoal-jak1", "v1", &install, true);
        let installed = service.status("opengoal-jak1").unwrap();
        assert_eq!(
            action(&installed, PortAction::Launch).availability,
            PortActionAvailability::Waiting
        );
        assert_eq!(
            action(&installed, PortAction::RemoveManaged).reason,
            PortActionReason::ReviewRequired
        );
        assert_eq!(
            service
                .statuses()
                .unwrap()
                .into_iter()
                .find(|status| status.port_id == installed.port_id)
                .unwrap()
                .port_actions,
            installed.port_actions
        );

        let source_path = temporary.path().join("jak1.iso");
        fs::write(&source_path, b"registered source").unwrap();
        let (storage_sha256, storage_size) = crate::adapter::hash_file(&source_path).unwrap();
        library
            .register_source(&SourceRecord {
                profile_id: "opengoal-jak1-disc".into(),
                path: source_path.clone(),
                sha256: storage_sha256.clone(),
                size: storage_size,
                storage_sha256,
                storage_size,
                updated_at: Library::now(),
                observed_identity: None,
            })
            .unwrap();
        let pending = service.status("opengoal-jak1").unwrap();
        assert_eq!(
            action(&pending, PortAction::Launch).reason,
            PortActionReason::PreparationRequired
        );
        fs::write(&source_path, b"\x80\x37\x12\x40changed source\0\0").unwrap();
        let held = service.status("opengoal-jak1").unwrap();
        assert_eq!(
            action(&held, PortAction::Launch).availability,
            PortActionAvailability::Held
        );
        assert_eq!(
            action(&held, PortAction::Launch).reason,
            PortActionReason::ChangedSource
        );
        // The presentation projection cannot turn a changed source into permission.
        assert!(service.prepare_launch("opengoal-jak1", None).is_err());
    }

    #[test]
    fn source_health_states_map_to_explicit_role_blockers() {
        let cases = [
            (
                SourceHealth::Unregistered,
                Some(LaunchBlocker::MissingSource),
            ),
            (SourceHealth::Missing, Some(LaunchBlocker::MissingSource)),
            (
                SourceHealth::Unreadable,
                Some(LaunchBlocker::UnreadableSource),
            ),
            (SourceHealth::Changed, Some(LaunchBlocker::ChangedSource)),
            (SourceHealth::Current, None),
            (SourceHealth::NotChecked, None),
        ];
        for (health, expected) in cases {
            let mut blockers = Vec::new();
            add_source_blocker(&mut blockers, Some(health), false);
            assert_eq!(blockers.first().copied(), expected);
        }

        let mut bios_blockers = Vec::new();
        add_source_blocker(&mut bios_blockers, Some(SourceHealth::Unreadable), true);
        add_source_blocker(&mut bios_blockers, Some(SourceHealth::Changed), true);
        assert_eq!(
            bios_blockers,
            [LaunchBlocker::UnreadableBios, LaunchBlocker::ChangedBios]
        );
    }

    #[test]
    fn status_source_metadata_never_hashes_same_size_originals() {
        let temporary = tempfile::tempdir().unwrap();
        let catalog = Catalog::embedded().unwrap();
        let profile_id = catalog
            .port("zelda64-recomp")
            .unwrap()
            .source_profile
            .as_ref()
            .unwrap();
        let path = temporary.path().join("game.z64");
        fs::write(&path, b"original bytes").unwrap();
        let (sha256, size) = crate::adapter::hash_file(&path).unwrap();
        let source = SourceRecord {
            profile_id: profile_id.clone(),
            path: path.clone(),
            sha256: sha256.clone(),
            size,
            storage_sha256: sha256,
            storage_size: size,
            updated_at: Library::now(),
            observed_identity: None,
        };
        let sources = HashMap::from([(profile_id.clone(), source.clone())]);
        fs::write(&path, b"tampered bytes").unwrap();
        let reads = std::rc::Rc::new(std::cell::Cell::new(0));
        let observed = reads.clone();
        crate::source_file::HASH_READ_OBSERVER.with(|observer| {
            *observer.borrow_mut() = Some(Box::new(move |_| observed.set(observed.get() + 1)));
        });
        let health = PortcoveService::source_health(
            &catalog,
            profile_id,
            true,
            &sources,
            &mut HashMap::new(),
        )
        .unwrap();
        let automatic_reads = reads.get();
        let explicit = crate::adapter::inspect_source_health(
            catalog.source_profile(profile_id).unwrap(),
            &source,
        );
        let verified = crate::source_inspection::verify_registered(&catalog, &source);
        crate::source_file::HASH_READ_OBSERVER.with(|observer| observer.borrow_mut().take());
        assert_eq!(health, SourceHealth::NotChecked);
        assert_eq!(automatic_reads, 0);
        assert_eq!(explicit, SourceHealth::Changed);
        assert!(verified.is_err());
    }

    #[test]
    fn status_observes_shared_source_metadata_without_rechecking_installed_contracts() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let source_root = temporary.path().join("owned-source-set");
        fs::create_dir(&source_root).unwrap();
        let mut document = Catalog::embedded().unwrap().authoritative_document();
        let host = Platform::current().unwrap();
        let executable_name = if host == Platform::WindowsX86_64 {
            "owned-game.exe"
        } else {
            "owned-game"
        };
        let fixture_port = document
            .ports
            .iter_mut()
            .find(|port| port.id == "g-diffuser")
            .unwrap();
        // This inert status fixture needs a host path; it does not qualify an
        // upstream artifact or inherit G-Diffuser's shipping-platform coverage.
        fixture_port.platforms = vec![host];
        fixture_port.executable_hints.clear();
        fixture_port
            .executable_hints
            .insert(host, vec![executable_name.into()]);
        let mut second_port = fixture_port.clone();
        second_port.id = "g-diffuser-fixture".into();
        document.ports.push(second_port);
        let source_catalog = document.source_catalog.as_mut().unwrap();
        let mut second_contract = source_catalog
            .contracts
            .iter()
            .find(|contract| contract.port_id == "g-diffuser")
            .unwrap()
            .clone();
        second_contract.id = "g-diffuser-fixture-source".into();
        second_contract.port_id = "g-diffuser-fixture".into();
        source_catalog.contracts.push(second_contract);
        let profile = document
            .source_catalog
            .as_mut()
            .unwrap()
            .identities
            .iter_mut()
            .find(|profile| profile.id == "g-diffuser-source-set")
            .unwrap();
        let crate::SourceRepresentationKind::FileSet { members } =
            &mut profile.variants[0].representations[0].kind
        else {
            panic!("file-set fixture")
        };
        for member in members {
            let bytes = member.id.as_bytes();
            fs::write(source_root.join(&member.filenames[0]), bytes).unwrap();
            member.identities = vec![crate::DigestIdentity {
                scope: crate::DigestScope::FileSetMember,
                sha256: Some(crate::signed_catalog::digest(bytes)),
                sha1: None,
                crc32: None,
            }];
        }
        let original = Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap();
        let mut service = service_with_release(library.clone(), "v2");
        service.catalog = original.clone();
        let registered = service
            .register_source("g-diffuser-source-set", &source_root)
            .unwrap();
        let profile = document
            .source_catalog
            .as_mut()
            .unwrap()
            .identities
            .iter_mut()
            .find(|profile| profile.id == "g-diffuser-source-set")
            .unwrap();
        let crate::SourceRepresentationKind::FileSet { members } =
            &mut profile.variants[0].representations[0].kind
        else {
            panic!("file-set fixture")
        };
        members[0].identities[0].sha256 =
            Some(crate::signed_catalog::digest(b"different required bytes"));
        let changed = Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap();
        let installer = Installer::new(library.clone()).unwrap();
        for (port_id, catalog) in [("g-diffuser", &original), ("g-diffuser-fixture", &changed)] {
            let path = library.versions_dir().join(port_id).join("v1");
            fs::create_dir_all(&path).unwrap();
            let executable = path.join(executable_name);
            fs::write(&executable, b"owned inert status fixture").unwrap();
            crate::permissions::normalize_archive_entry(&executable, false, true).unwrap();
            let artifact = ArtifactIdentity {
                asset_name: "owned-fixture.zip".into(),
                sha256: crate::signed_catalog::digest(port_id.as_bytes()),
                size: 4,
            };
            let id = Uuid::new_v4().to_string();
            let qualification =
                InstallQualification::from_catalog(catalog, port_id, Platform::current().unwrap())
                    .unwrap();
            let (manifest_sha256, selected_executable, runtime) = installer
                .create_manifest(&id, port_id, "v1", &artifact, &qualification, &path)
                .unwrap();
            library
                .register_install(
                    &InstallRecord {
                        id,
                        port_id: port_id.into(),
                        version: "v1".into(),
                        path,
                        channel: ReleaseChannel::Stable,
                        installed_at: Library::now(),
                        verified: true,
                        staged: false,
                        artifact,
                        manifest_sha256,
                        selected_executable,
                        runtime,
                    },
                    true,
                )
                .unwrap();
        }
        service.catalog = changed;
        crate::source_file::HASH_READ_OBSERVER.with(|observer| {
            *observer.borrow_mut() = Some(Box::new(|_| {
                panic!("automatic status hashed source content")
            }));
        });
        for reverse in [false, true] {
            if reverse {
                document.ports.reverse();
                service.catalog =
                    Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap();
            }
            let statuses = service.statuses().unwrap();
            for (id, expected) in [
                ("g-diffuser", SourceHealth::NotChecked),
                ("g-diffuser-fixture", SourceHealth::NotChecked),
            ] {
                let single = service.status(id).unwrap().readiness.unwrap();
                let batched = statuses
                    .iter()
                    .find(|status| status.port_id == id)
                    .unwrap()
                    .readiness
                    .as_ref()
                    .unwrap();
                assert_eq!(single.source, Some(expected), "single {id}");
                assert_eq!(
                    batched.source,
                    Some(expected),
                    "batch {id}; reversed={reverse}"
                );
                assert_eq!(single.blockers, batched.blockers);
                assert!(!single.launchable);
                assert!(single.pending_setup);
                assert_eq!(
                    single.preparation_mode,
                    Some(crate::PreparationMode::SourceOnly)
                );
                assert!(
                    single
                        .blockers
                        .contains(&LaunchBlocker::PreparationRequired)
                );
            }
        }
        assert_eq!(
            serde_json::to_value(library.source(&registered.profile_id).unwrap()).unwrap(),
            serde_json::to_value(&registered).unwrap()
        );
        crate::source_file::HASH_READ_OBSERVER.with(|observer| observer.borrow_mut().take());
        fs::remove_dir_all(&source_root).unwrap();
        for id in ["g-diffuser", "g-diffuser-fixture"] {
            assert_eq!(
                service.status(id).unwrap().readiness.unwrap().source,
                Some(SourceHealth::Missing)
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn status_distinguishes_an_unreadable_registered_source() {
        use std::os::unix::fs::PermissionsExt;

        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        register_zelda_install(&library, "v1", true);
        let source_path = temporary.path().join("zelda.z64");
        fs::write(&source_path, b"registered source").unwrap();
        let (storage_sha256, storage_size) = crate::adapter::hash_file(&source_path).unwrap();
        library
            .register_source(&SourceRecord {
                profile_id: "majoras-mask".into(),
                path: source_path.clone(),
                sha256: storage_sha256.clone(),
                size: storage_size,
                storage_sha256,
                storage_size,
                updated_at: Library::now(),
                observed_identity: None,
            })
            .unwrap();
        fs::set_permissions(&source_path, fs::Permissions::from_mode(0o000)).unwrap();

        let readiness = PortcoveService::new(library)
            .unwrap()
            .status("zelda64-recomp")
            .unwrap()
            .readiness
            .unwrap();
        assert!(!readiness.launchable);
        assert_eq!(readiness.blockers, [LaunchBlocker::UnreadableSource]);
        assert_eq!(readiness.source, Some(SourceHealth::Unreadable));

        fs::set_permissions(source_path, fs::Permissions::from_mode(0o600)).unwrap();
    }

    #[test]
    fn source_verification_revalidates_content_instead_of_trusting_the_record() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let source = temporary.path().join("mario-kart-64.z64");
        fs::write(&source, b"\x80\x37\x12\x40not the supported source").unwrap();
        let (storage_sha256, storage_size) = crate::adapter::hash_file(&source).unwrap();
        library
            .register_source(&SourceRecord {
                profile_id: "mario-kart-64".into(),
                path: source,
                sha256: "d6b8538dd63f0132ecb2856e7d32816ed3c30e3e479aecd23cf83fb6ba17a5da".into(),
                size: storage_size,
                storage_sha256: storage_sha256.clone(),
                storage_size,
                updated_at: Library::now(),
                observed_identity: None,
            })
            .unwrap();
        let service = PortcoveService::new(library).unwrap();

        let error = service.verify_source("mario-kart-64").unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::SourceInvalid);
        assert!(error.message.contains("changed since registration"));
        assert_eq!(
            error.details.get("actual_storage_sha256"),
            Some(&storage_sha256)
        );
        let mut baseline = service.library().source("mario-kart-64").unwrap().unwrap();
        assert_eq!(error.details.get("recorded_sha256"), Some(&baseline.sha256));

        // Even a baseline matching the actual bytes cannot manufacture input
        // compatibility. Verification still inspects the unsupported content.
        baseline.sha256 = storage_sha256;
        service.library().register_source(&baseline).unwrap();
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
            observed_identity: None,
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
    fn source_removal_preserves_bytes_when_the_catalog_profile_is_absent() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let source_path = temporary.path().join("retired-source.bin");
        let source_bytes = b"registered source from a retired catalog profile";
        fs::write(&source_path, source_bytes).unwrap();
        let (storage_sha256, storage_size) = crate::adapter::hash_file(&source_path).unwrap();
        library
            .register_source(&SourceRecord {
                profile_id: "retired-catalog-profile".into(),
                path: source_path.clone(),
                sha256: storage_sha256.clone(),
                size: storage_size,
                storage_sha256,
                storage_size,
                updated_at: Library::now(),
                observed_identity: None,
            })
            .unwrap();
        let service = PortcoveService::new(library.clone()).unwrap();
        assert!(
            service
                .catalog()
                .source_profile("retired-catalog-profile")
                .is_err()
        );

        let preview = service
            .preview_source_removal("retired-catalog-profile")
            .unwrap();
        assert!(preview.dependent_port_ids.is_empty());
        assert!(preview.installed_dependent_port_ids.is_empty());
        let authorization = service
            .authorize_source_removal("retired-catalog-profile", &preview.preview_sha256)
            .unwrap();
        let removed = service
            .remove_source("retired-catalog-profile", &authorization.token)
            .unwrap();

        assert_eq!(removed.preview_sha256, preview.preview_sha256);
        assert!(library.source("retired-catalog-profile").unwrap().is_none());
        assert_eq!(fs::read(source_path).unwrap(), source_bytes);
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
        fs::write(&source, b"\x80\x37\x12\x40original source\0").unwrap();
        let service = PortcoveService::new(library).unwrap();
        service.register_source("star-fox-64", &source).unwrap();

        fs::write(&source, b"\x80\x37\x12\x40changed source\0\0").unwrap();
        let error = service.prepare_launch("starship", None).unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::SourceInvalid);
        assert!(!install.join(LAUNCH_MARKER).exists());

        service.register_source("star-fox-64", &source).unwrap();
        fs::remove_file(&executable).unwrap();
        let error = service.prepare_launch("starship", None).unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Verification);
        assert!(!install.join(LAUNCH_MARKER).exists());

        assert_eq!(write_host_test_executable(&install, "starship"), executable);
        let launch = service.prepare_launch("starship", None).unwrap();
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
        fs::write(&source, b"\x80\x37\x12\x40initial verified source\0").unwrap();
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

        let error = service.prepare_launch("starship", None).unwrap_err();

        assert_eq!(error.code, crate::ErrorCode::SourceInvalid);
        assert!(error.message.contains("changed since registration"));
        assert!(!install.join(LAUNCH_MARKER).exists());
    }

    #[test]
    fn installed_launch_retains_source_inspection_after_catalog_changes() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let install = library.versions_dir().join("starship/v1");
        fs::create_dir_all(&install).unwrap();
        write_host_test_executable(&install, "starship");
        register_existing_test_install(&library, "starship", "v1", &install, true);
        let source = temporary.path().join("owned-source.z64");
        fs::write(&source, b"\x80\x37\x12\x40original source\0").unwrap();
        let mut service = PortcoveService::with_provider(
            library.clone(),
            Arc::new(StaticReleaseProvider {
                version: "v2".into(),
            }),
        )
        .unwrap();
        let registered = service.register_source("star-fox-64", &source).unwrap();
        let mut document = service.catalog.authoritative_document();
        let profile = document
            .source_catalog
            .as_mut()
            .unwrap()
            .identities
            .iter_mut()
            .find(|profile| profile.id == "star-fox-64")
            .unwrap();
        for variant in &mut profile.variants {
            for representation in &mut variant.representations {
                representation.extensions = vec!["future".into()];
            }
        }
        let current_port = document
            .ports
            .iter_mut()
            .find(|port| port.id == "starship")
            .unwrap();
        current_port.source_profile = Some("majoras-mask".into());
        let requirement = current_port
            .presentation
            .as_mut()
            .unwrap()
            .source_requirements
            .iter_mut()
            .find(|requirement| requirement.role == crate::PortSourceRole::Game)
            .unwrap();
        requirement.profile_id = "majoras-mask".into();
        requirement.label = "The Legend of Zelda: Majora's Mask source".into();
        let current_binding = document
            .source_catalog
            .as_mut()
            .unwrap()
            .contracts
            .iter_mut()
            .find(|contract| contract.port_id == "starship")
            .unwrap();
        current_binding.profile_id = "majoras-mask".into();
        current_binding.supported_variant_ids = vec!["ntsc-u-1-0".into()];
        service.catalog = Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap();

        let status = service.status("starship").unwrap();
        let install_action = status
            .port_actions
            .iter()
            .find(|item| item.action == PortAction::Install)
            .unwrap();
        assert_eq!(install_action.availability, PortActionAvailability::Waiting);
        assert_eq!(install_action.reason, PortActionReason::MissingSource);
        assert_eq!(
            status.readiness.unwrap().source,
            Some(SourceHealth::NotChecked),
            "status retains the source contract without claiming current contents"
        );
        let mut current_record = registered.clone();
        current_record.profile_id = "majoras-mask".into();
        current_record.observed_identity = None;
        library.register_source(&current_record).unwrap();
        library.remove_source("star-fox-64").unwrap();
        let status = service.status("starship").unwrap();
        let install_action = status
            .port_actions
            .iter()
            .find(|item| item.action == PortAction::Install)
            .unwrap();
        assert_eq!(install_action.availability, PortActionAvailability::Allowed);
        assert_eq!(
            status.readiness.unwrap().source,
            Some(SourceHealth::Unregistered),
            "retained launch cannot borrow the current source registration"
        );
        library.register_source(&registered).unwrap();
        assert!(
            service
                .inspect_source_record("star-fox-64", &source)
                .is_err()
        );
        for selected in [None, Some(source.as_path())] {
            let spec = service.prepare_launch("starship", selected).unwrap();
            assert_eq!(
                spec.environment.get("PORTCOVE_SOURCE"),
                Some(&source.to_string_lossy().into_owned())
            );
        }
        assert_eq!(
            serde_json::to_value(library.source("star-fox-64").unwrap().unwrap()).unwrap(),
            serde_json::to_value(registered).unwrap()
        );
        assert_eq!(
            fs::read(&source).unwrap(),
            b"\x80\x37\x12\x40original source\0"
        );
        fs::write(&source, b"changed after registration").unwrap();
        assert_eq!(
            service.prepare_launch("starship", None).unwrap_err().code,
            crate::ErrorCode::SourceInvalid
        );
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
        let launch = service.prepare_launch("gen1recomp", None).unwrap();
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
    fn direct_user_data_roots_are_not_mirrored_into_immutable_installs() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let service = PortcoveService::new(library.clone()).unwrap();
        let port = service.catalog().port("snap64-recomp").unwrap();
        if !port.platforms.contains(&Platform::current().unwrap()) {
            return;
        }
        let install = library.versions_dir().join("snap64-recomp").join("fixture");
        fs::create_dir_all(&install).unwrap();
        write_host_test_executable_with_contents(&install, "snap64-recomp", b"test");
        register_existing_test_install(&library, "snap64-recomp", "v1.0.5", &install, true);
        let user_rom = library.user_dir("snap64-recomp").join("pokemonsnap.z64");
        fs::create_dir_all(user_rom.parent().unwrap()).unwrap();
        fs::write(&user_rom, b"verified source").unwrap();

        service.restore_user_data_to(port, &install).unwrap();
        service
            .synchronize_restored_user_data("snap64-recomp")
            .unwrap();

        assert_eq!(fs::read(user_rom).unwrap(), b"verified source");
        assert!(!install.join("pokemonsnap.z64").exists());
    }

    #[test]
    fn post_exit_sync_accepts_the_canonical_path_of_a_relative_library() {
        let current = std::env::current_dir().unwrap();
        let temporary = tempfile::tempdir_in(&current).unwrap();
        let root = temporary.path().join("library");
        let library = Library::open(root.strip_prefix(&current).unwrap()).unwrap();
        let install = register_zelda_install(&library, "v1", true);
        fs::write(install.join("general.json"), b"collected settings").unwrap();
        let canonical_install = fs::canonicalize(&install).unwrap();
        let service = PortcoveService::new(library.clone()).unwrap();
        service
            .collect_user_data_from_install("zelda64-recomp", &canonical_install)
            .unwrap();
        assert_eq!(
            fs::read(library.user_dir("zelda64-recomp").join("general.json")).unwrap(),
            b"collected settings"
        );
    }

    #[test]
    #[cfg(unix)]
    fn post_exit_sync_rejects_an_install_symlink_before_canonical_comparison() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let outside = temporary.path().join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("general.json"), b"outside").unwrap();
        let parent = library.versions_dir().join("zelda64-recomp");
        fs::create_dir_all(&parent).unwrap();
        let alias = parent.join("alias");
        std::os::unix::fs::symlink(&outside, &alias).unwrap();
        let service = PortcoveService::new(library.clone()).unwrap();
        assert!(
            service
                .collect_user_data_from_install("zelda64-recomp", &alias)
                .is_err()
        );
        assert!(
            !library
                .user_dir("zelda64-recomp")
                .join("general.json")
                .exists()
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
    fn post_exit_sync_preserves_source_times_and_detects_same_size_and_time_changes() {
        let temporary = tempfile::tempdir().unwrap();
        let source = temporary.path().join("source");
        let destination = temporary.path().join("destination");
        fs::write(&source, b"save-one").unwrap();
        fs::write(&destination, b"save-one").unwrap();
        let source_stamp = fs::metadata(&source).unwrap().modified().unwrap();
        let stamp = std::time::UNIX_EPOCH + Duration::from_secs(86400);
        let times = fs::FileTimes::new().set_modified(stamp);
        fs::File::options()
            .write(true)
            .open(&destination)
            .unwrap()
            .set_times(times)
            .unwrap();
        sync_entry(&source, &destination).unwrap();
        assert_eq!(
            fs::metadata(&destination).unwrap().modified().unwrap(),
            source_stamp
        );
        // Set equal timestamps before changing only the payload. Neither equal
        // size nor equal time may skip the byte comparison.
        fs::File::options()
            .write(true)
            .open(&destination)
            .unwrap()
            .set_times(times)
            .unwrap();

        fs::write(&source, b"save-two").unwrap();
        fs::File::options()
            .write(true)
            .open(&source)
            .unwrap()
            .set_times(times)
            .unwrap();
        sync_entry(&source, &destination).unwrap();
        assert_eq!(fs::read(&destination).unwrap(), b"save-two");
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
    fn post_exit_sync_preserves_direct_libultraship_user_data() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let install = library.versions_dir().join("lighthouse/v1");
        fs::create_dir_all(&install).unwrap();
        write_host_test_executable(&install, "lighthouse");
        register_existing_test_install(&library, "lighthouse", "v1", &install, true);
        let user_archive = library.user_dir("lighthouse").join("bk.o2r");
        fs::create_dir_all(user_archive.parent().unwrap()).unwrap();
        fs::write(&user_archive, b"generated by the running port").unwrap();
        fs::write(install.join("bk.o2r"), b"stale restored copy").unwrap();
        let service = PortcoveService::new(library).unwrap();

        service.collect_user_data("lighthouse").unwrap();
        assert_eq!(
            fs::read(&user_archive).unwrap(),
            b"generated by the running port"
        );

        fs::remove_file(install.join("bk.o2r")).unwrap();
        service.collect_user_data("lighthouse").unwrap();
        assert_eq!(
            fs::read(&user_archive).unwrap(),
            b"generated by the running port"
        );

        fs::write(install.join("bk.o2r"), b"stale restored copy").unwrap();
        fs::remove_file(&user_archive).unwrap();
        service.collect_user_data("lighthouse").unwrap();
        assert!(!user_archive.exists());
    }

    #[test]
    fn corrupt_retained_manifest_blocks_only_its_own_status_and_launch() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let path = register_zelda_install(&library, "v1", true);
        let service = PortcoveService::new(library).unwrap();
        fs::write(
            path.join(".portcove-manifest.json"),
            b"corrupt retained contract",
        )
        .unwrap();
        let statuses = service.statuses().unwrap();
        let status = statuses
            .iter()
            .find(|status| status.port_id == "zelda64-recomp")
            .unwrap();
        let readiness = status.readiness.as_ref().unwrap();
        assert!(!readiness.launchable);
        assert_eq!(readiness.blockers, vec![LaunchBlocker::InvalidInstallation]);
        assert!(
            statuses
                .iter()
                .any(|status| status.port_id != "zelda64-recomp")
        );
        assert!(service.prepare_launch("zelda64-recomp", None).is_err());
        assert!(!path.join(LAUNCH_MARKER).exists());
    }

    #[test]
    fn installed_versions_keep_execution_and_saves_after_catalog_contract_changes() {
        assert_catalog_contract_retention(1);
    }

    #[test]
    fn successor_staged_and_rollback_versions_keep_exact_contracts() {
        assert_catalog_contract_retention(2);
    }

    #[test]
    fn authenticated_admission_survives_staging_rollback_activation_and_refresh() {
        assert_catalog_contract_retention(3);
    }

    #[test]
    fn authenticated_adoption_retains_exact_definition_and_publisher_identity() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let indexed = authenticated_indexed_catalog(&library);
        let original = indexed.port("zelda64-recomp").unwrap().clone();
        let identity = indexed
            .definition_selection("zelda64-recomp")
            .unwrap()
            .clone();
        let source = temporary.path().join("existing-install");
        fs::create_dir_all(&source).unwrap();
        write_host_test_executable(&source, "zelda64-recomp");
        fs::write(source.join("general.json"), b"adopted settings").unwrap();
        let mut service = PortcoveService::new(library).unwrap();
        service.replace_catalog_for_test(indexed);

        let preview = service
            .preview_adoption(&source, Some("zelda64-recomp"))
            .unwrap();
        let authorization = service
            .authorize_adoption(&source, Some("zelda64-recomp"), &preview.plan_sha256)
            .unwrap();
        let adopted = service
            .adopt(&source, Some("zelda64-recomp"), &authorization.token)
            .unwrap();

        let manifest: serde_json::Value = serde_json::from_slice(
            &fs::read(adopted.path.join(".portcove-manifest.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(manifest["retained_contract"]["format"], 3);
        assert_eq!(
            manifest["retained_contract"]["admission"],
            serde_json::to_value(identity).unwrap()
        );

        let mut changed = service.catalog.authoritative_document();
        changed
            .ports
            .iter_mut()
            .find(|port| port.id == original.id)
            .unwrap()
            .launch_arguments
            .push("--future-contract".into());
        service.catalog = Catalog::from_json(&serde_json::to_string(&changed).unwrap()).unwrap();
        assert_eq!(
            serde_json::to_value(service.installed_port(&adopted).unwrap()).unwrap(),
            serde_json::to_value(original).unwrap()
        );
    }

    fn authenticated_indexed_catalog(library: &Library) -> Catalog {
        let mut catalog =
            crate::test_fixture::indexed_catalog(&Catalog::embedded().unwrap(), "zelda64-recomp");
        let snapshot = catalog.definition_snapshot("zelda64-recomp").unwrap();
        let selection = crate::DefinitionSelectionIdentity {
            namespace: snapshot.namespace().into(),
            stable_id: snapshot.port_id().into(),
            definition_revision: snapshot.projection().unwrap().entry().revision(),
            repository_root_sha256: "a".repeat(64),
            grant_id: "test-official-grant".into(),
            policy_revision: 7,
            provenance: crate::AuthenticatedDefinitionProvenance {
                root_version: 1,
                root_sha256: "a".repeat(64),
                timestamp_version: 2,
                timestamp_sha256: "b".repeat(64),
                snapshot_version: 3,
                snapshot_sha256: "c".repeat(64),
                targets_version: 4,
                targets_sha256: "d".repeat(64),
                definitions_version: 5,
                definitions_sha256: "e".repeat(64),
                earliest_expiration: "2099-01-01T00:00:00Z".into(),
                index_sha256: snapshot.index_sha256(),
            },
        };
        catalog
            .retain_definition_selection(Arc::new(selection.clone()))
            .unwrap();
        library
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO definition_publisher_policy(
                   namespace,stable_id,root_sha256,policy_revision,grant_id,status
                 ) VALUES(?1,?2,?3,?4,?5,'scoped')",
                rusqlite::params![
                    selection.namespace,
                    selection.stable_id,
                    selection.repository_root_sha256,
                    selection.policy_revision,
                    selection.grant_id,
                ],
            )
            .unwrap();
        catalog
    }

    fn assert_catalog_contract_retention(retained_format: u32) {
        let started = std::time::Instant::now();
        let phase = |name: &str| {
            if retained_format == 3 {
                eprintln!("[authenticated-retention] {name}: {:?}", started.elapsed());
            } else if retained_format == 2 {
                eprintln!("[indexed-retention] {name}: {:?}", started.elapsed());
            } else if retained_format == 1 {
                eprintln!("[legacy-retention] {name}: {:?}", started.elapsed());
            }
        };
        phase("start");
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("library");
        fs::create_dir_all(&root).unwrap();
        // Exercise the same canonical-path distinction as Windows runner
        // short names and differently cased user/temp directory prefixes.
        #[cfg(windows)]
        let root = PathBuf::from(root.to_str().unwrap().to_uppercase());
        let library = Library::open(root).unwrap();
        phase("library-opened");
        let indexed = match retained_format {
            1 => None,
            2 => Some(crate::test_fixture::indexed_catalog(
                &Catalog::embedded().unwrap(),
                "zelda64-recomp",
            )),
            3 => Some(authenticated_indexed_catalog(&library)),
            _ => panic!("unsupported retained contract format {retained_format}"),
        };
        phase("catalog-authenticated");
        let register = |version, active| {
            register_zelda_install_contract(&library, version, active, b"test", indexed.as_ref())
        };
        let first = register("v1", true);
        let second = register("v2", true);
        let staged = register("v3", false);
        phase("three-versions-registered");
        let manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(first.join(".portcove-manifest.json")).unwrap())
                .unwrap();
        let exact_contract = &manifest["retained_contract"];
        assert_eq!(exact_contract["format"], retained_format);
        assert_eq!(
            exact_contract.get("admission").is_some(),
            retained_format == 3
        );
        fs::write(second.join("general.json"), b"version-owned-settings").unwrap();
        fs::write(second.join(LAUNCH_MARKER), b"1").unwrap();
        let mut service = PortcoveService::new(library.clone()).unwrap();
        phase("service-opened");
        if retained_format == 3 {
            service.replace_catalog_for_test(indexed.as_ref().unwrap().clone());
            let status = service.status("zelda64-recomp").unwrap();
            let install = status
                .definition_operations
                .iter()
                .find(|assessment| assessment.operation == DefinitionOperation::Install)
                .unwrap();
            assert!(!install.retained);
            assert_eq!(
                install.eligibility.outcome,
                DefinitionEligibilityOutcome::Eligible
            );
        }
        let original = service.catalog.port("zelda64-recomp").unwrap().clone();
        let mut document = service.catalog.authoritative_document();
        let changed = document
            .ports
            .iter_mut()
            .find(|port| port.id == original.id)
            .unwrap();
        changed
            .executable_hints
            .insert(Platform::current().unwrap(), vec!["future-game.exe".into()]);
        changed.launch_arguments.push("--future-contract".into());
        changed
            .persistent_paths
            .retain(|path| path != "general.json");
        changed.persistent_paths.push("future-settings.json".into());
        service.catalog = Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap();
        phase("changed-catalog-loaded");
        let explained = service
            .status(&original.id)
            .unwrap()
            .readiness
            .unwrap()
            .setup_contract
            .unwrap();
        assert!(explained.retained);
        assert!(
            explained
                .persistent_paths
                .iter()
                .any(|path| path == "general.json")
        );
        assert!(
            !explained
                .persistent_paths
                .iter()
                .any(|path| path == "future-settings.json")
        );
        assert_eq!(
            explained.manual_preparation,
            original
                .presentation
                .as_ref()
                .and_then(|presentation| presentation.manual_preparation.clone())
        );

        assert!(service.verify(&original.id).unwrap().valid);
        phase("retained-install-verified");
        let spec = service.prepare_launch(&original.id, None).unwrap();
        assert!(!format!("{spec:?}").contains("--future-contract"));
        phase("retained-launch-prepared");
        let rolled_back = service.rollback(&original.id).unwrap();
        phase("rollback-finished");
        assert_eq!(rolled_back.path, first);
        assert_eq!(
            fs::read(first.join("general.json")).unwrap(),
            b"version-owned-settings"
        );
        let activated = service.activate_staged(&original.id).unwrap();
        phase("activation-finished");
        assert_eq!(activated.path, staged);
        assert_eq!(
            fs::read(staged.join("general.json")).unwrap(),
            b"version-owned-settings"
        );
        for install in library.all_installs().unwrap() {
            let manifest: serde_json::Value = serde_json::from_slice(
                &fs::read(install.path.join(".portcove-manifest.json")).unwrap(),
            )
            .unwrap();
            assert_eq!(&manifest["retained_contract"], exact_contract);
            assert_eq!(
                serde_json::to_value(service.installed_port(&install).unwrap()).unwrap(),
                serde_json::to_value(&original).unwrap()
            );
        }
        phase("all-retained-contracts-verified");
        if retained_format == 3 {
            let status = service.status(&original.id).unwrap();
            let launch = status
                .definition_operations
                .iter()
                .find(|assessment| assessment.operation == DefinitionOperation::Launch)
                .unwrap();
            assert!(launch.retained);
            assert_eq!(
                launch.eligibility.outcome,
                DefinitionEligibilityOutcome::Eligible
            );

            library
                .connection()
                .unwrap()
                .execute(
                    "UPDATE definition_publisher_policy SET status='revoked'
                     WHERE namespace='official' AND stable_id='zelda64-recomp'",
                    [],
                )
                .unwrap();
            let status = service.status(&original.id).unwrap();
            let assessed_launch = status
                .port_actions
                .iter()
                .find(|item| item.action == PortAction::Launch)
                .unwrap();
            assert_eq!(assessed_launch.availability, PortActionAvailability::Held);
            assert_eq!(
                assessed_launch.reason,
                PortActionReason::DefinitionIneligible
            );
            assert_eq!(
                assessed_launch.definition.unwrap().reason,
                crate::DefinitionEligibilityReason::PublisherRevoked
            );
            assert!(!status.readiness.unwrap().launchable);
            let error = service.prepare_launch(&original.id, None).unwrap_err();
            assert_eq!(error.code, crate::ErrorCode::Conflict);
            assert_eq!(error.details["definition_reason"], "publisher_revoked");
            phase("revoked-publisher-refused");
        }
    }

    #[test]
    fn ghostship_incompatible_rollback_is_held_without_touching_data() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        for version in ["2.0.0", "3.0.0"] {
            let root = library.versions_dir().join("ghostship").join(version);
            fs::create_dir_all(&root).unwrap();
            write_host_test_executable(&root, "ghostship");
            register_existing_test_install(&library, "ghostship", version, &root, true);
            fs::write(root.join(LAUNCH_MARKER), b"1").unwrap();
        }
        let user = library.user_dir("ghostship");
        fs::create_dir_all(user.join("saves")).unwrap();
        fs::write(
            user.join("saves/save_0.json"),
            br#"{"version":2,"flags":42}"#,
        )
        .unwrap();
        fs::write(user.join("sm64.o2r"), b"retained generated data").unwrap();
        fs::write(user.join("ghostship.cfg.json"), b"retained settings").unwrap();
        let service = PortcoveService::new(library.clone()).unwrap();
        let before = crate::test_fixture::library_file_snapshot(&library);

        let status = service.status("ghostship").unwrap();
        let action = status
            .port_actions
            .iter()
            .find(|item| item.action == PortAction::Rollback)
            .unwrap();
        assert_eq!(action.availability, PortActionAvailability::Held);
        assert_eq!(action.reason, PortActionReason::UnsafeData);
        assert_eq!(crate::test_fixture::library_file_snapshot(&library), before);

        let error = service.rollback("ghostship").unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Conflict);
        assert!(error.message.contains("schema-2 saves"));
        let data_files = |files: Vec<(PathBuf, String)>| {
            files
                .into_iter()
                .filter(|(path, _)| path.starts_with("versions") || path.starts_with("user"))
                .collect::<Vec<_>>()
        };
        // The failed activity is recorded in SQLite; game data remains intact.
        assert_eq!(
            data_files(crate::test_fixture::library_file_snapshot(&library)),
            data_files(before)
        );
        let status = library.status("ghostship", ReleaseChannel::Stable).unwrap();
        assert_eq!(status.active.unwrap().version, "3.0.0");
        assert_eq!(status.previous.unwrap().version, "2.0.0");
    }

    #[test]
    fn ghostship_rollback_hold_does_not_block_the_reverse_transition() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        for version in ["3.0.0", "2.0.0"] {
            let root = library.versions_dir().join("ghostship").join(version);
            fs::create_dir_all(&root).unwrap();
            write_host_test_executable(&root, "ghostship");
            register_existing_test_install(&library, "ghostship", version, &root, true);
        }
        let service = PortcoveService::new(library).unwrap();
        let status = service.status("ghostship").unwrap();
        let action = status
            .port_actions
            .iter()
            .find(|item| item.action == PortAction::Rollback)
            .unwrap();
        assert_eq!(action.availability, PortActionAvailability::Allowed);
        assert_eq!(service.rollback("ghostship").unwrap().version, "3.0.0");
        // Fixture bytes establish only the scoped guard, not upstream migration.
    }

    #[tokio::test]
    async fn ghostship_staged_and_retained_reactivation_cannot_bypass_the_hold() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        for version in ["3.0.0", "2.0.0"] {
            let root = library.versions_dir().join("ghostship").join(version);
            fs::create_dir_all(&root).unwrap();
            write_host_test_executable(&root, "ghostship");
            register_existing_test_install(
                &library,
                "ghostship",
                version,
                &root,
                version == "3.0.0",
            );
        }
        let service = service_with_release(library.clone(), "2.0.0");
        let error = service.activate_staged("ghostship").unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Conflict);
        assert!(error.message.contains("schema-2 saves"));
        let status = library.status("ghostship", ReleaseChannel::Stable).unwrap();
        assert_eq!(status.active.unwrap().version, "3.0.0");
        assert_eq!(status.staged.unwrap().version, "2.0.0");
        let error = service
            .install("ghostship", None, None, None, true, |_| {})
            .await
            .unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Conflict);
        assert!(error.message.contains("schema-2 saves"));
        assert_eq!(
            library
                .status("ghostship", ReleaseChannel::Stable)
                .unwrap()
                .active
                .unwrap()
                .version,
            "3.0.0"
        );
    }

    #[test]
    fn ghostship_old_launch_checks_retained_data_before_preparation() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let root = library.versions_dir().join("ghostship/2.0.0");
        fs::create_dir_all(&root).unwrap();
        write_host_test_executable(&root, "ghostship");
        let active = register_existing_test_install(&library, "ghostship", "2.0.0", &root, true);
        let save = library.user_dir("ghostship").join("saves/save_0.json");
        fs::create_dir_all(save.parent().unwrap()).unwrap();
        fs::write(&save, br#"{"version":2}"#).unwrap();
        let service = PortcoveService::new(library.clone()).unwrap();
        let port = service.catalog.port("ghostship").unwrap();
        let before = crate::test_fixture::library_file_snapshot(&library);
        let error = service
            .prepare_launch_for_install(port, &active, None, None)
            .unwrap_err();
        assert!(error.message.contains("schema-1 reader"));
        assert!(
            !service
                .status("ghostship")
                .unwrap()
                .readiness
                .unwrap()
                .launchable
        );
        assert_eq!(crate::test_fixture::library_file_snapshot(&library), before);
    }

    #[test]
    fn ghostship_legacy_reader_refuses_linked_save_data() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let saves = library.user_dir("ghostship").join("saves");
        fs::create_dir_all(saves.parent().unwrap()).unwrap();
        let outside_directory = temporary.path().join("outside-saves");
        fs::create_dir(&outside_directory).unwrap();
        let outside = outside_directory.join("global.json");
        fs::write(&outside, br#"{"version":1}"#).unwrap();
        #[cfg(windows)]
        create_adoption_test_junction(&outside_directory, &saves);
        #[cfg(unix)]
        create_adoption_test_symlink(&outside_directory, &saves, true);
        let service = PortcoveService::new(library).unwrap();
        let error = service
            .require_ghostship_data_compatibility("ghostship", "2.0.0", None)
            .unwrap_err();
        assert!(error.message.contains("unsafe path"));
        assert_eq!(fs::read(outside).unwrap(), br#"{"version":1}"#);
    }

    #[test]
    fn ghostship_interrupted_publication_and_activation_preserve_the_hold_and_journal() {
        for kind in [
            LifecycleOperationKind::Install,
            LifecycleOperationKind::Activate,
        ] {
            let temporary = tempfile::tempdir().unwrap();
            let library = Library::open(temporary.path().join("library")).unwrap();
            let service = PortcoveService::new(library.clone()).unwrap();
            let mut target = None;
            for version in ["3.0.0", "2.0.0"] {
                let root = library.versions_dir().join("ghostship").join(version);
                fs::create_dir_all(&root).unwrap();
                write_host_test_executable(&root, "ghostship");
                let record = register_existing_test_install(
                    &library,
                    "ghostship",
                    version,
                    &root,
                    version == "3.0.0",
                );
                if version == "2.0.0" {
                    target = Some(record);
                }
            }
            let store = OperationStore::new(library.clone());
            let mut operation =
                LifecycleOperation::new(Uuid::new_v4().to_string(), kind, "ghostship");
            operation.install = target.clone();
            operation.activate = kind == LifecycleOperationKind::Install;
            if kind == LifecycleOperationKind::Install {
                operation.phase = LifecyclePhase::PayloadPublished;
                let staging = library.staging_dir().join(&operation.id);
                fs::create_dir_all(&staging).unwrap();
                operation.paths.staging = Some(staging);
            }
            store.put(&mut operation).unwrap();
            let phase = operation.phase;
            let _lock = library.try_lock_port("ghostship", "test-recovery").unwrap();
            let result = if kind == LifecycleOperationKind::Install {
                crate::recovery::recover_published_install(&service, &store, &mut operation)
            } else {
                crate::recovery::recover_activation(&service, &store, &mut operation)
            };
            let error = result.unwrap_err();
            assert!(
                error.message.contains("schema-2 saves"),
                "{kind:?}: {error:?}"
            );
            assert_eq!(store.all().unwrap()[0].phase, phase);
            assert_eq!(
                library
                    .status("ghostship", ReleaseChannel::Stable)
                    .unwrap()
                    .active
                    .unwrap()
                    .version,
                "3.0.0"
            );

            // A crash after actual metadata commit must still retire the journal.
            library.register_install(&target.unwrap(), true).unwrap();
            if kind == LifecycleOperationKind::Install {
                operation.phase = LifecyclePhase::MetadataCommitted;
                store.put(&mut operation).unwrap();
                crate::recovery::recover_published_install(&service, &store, &mut operation)
                    .unwrap();
            } else {
                crate::recovery::recover_activation(&service, &store, &mut operation).unwrap();
            }
            assert!(store.all().unwrap().is_empty());
        }
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
    fn rollback_assessment_preserves_removed_catalog_route_refusal() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        register_zelda_install(&library, "v1", true);
        register_zelda_install(&library, "v2", true);
        let mut service = PortcoveService::new(library.clone()).unwrap();
        let before = library
            .status("zelda64-recomp", ReleaseChannel::Stable)
            .unwrap();
        let mut document = service.catalog.authoritative_document();
        document.ports.retain(|port| port.id != "zelda64-recomp");
        let sources = document.source_catalog.as_mut().unwrap();
        sources
            .contracts
            .retain(|contract| contract.port_id != "zelda64-recomp");
        sources
            .qualification
            .retain(|record| record.scope.port_id != "zelda64-recomp");
        service.catalog = Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap();
        let files = crate::test_fixture::library_file_snapshot(&library);

        let status = service.status("zelda64-recomp").unwrap();
        let rollback = status
            .port_actions
            .iter()
            .find(|item| item.action == PortAction::Rollback)
            .unwrap();
        assert_eq!(rollback.availability, PortActionAvailability::NotOffered);
        assert_eq!(rollback.reason, PortActionReason::RouteNotOffered);
        assert_eq!(crate::test_fixture::library_file_snapshot(&library), files);
        assert_eq!(
            service.rollback("zelda64-recomp").unwrap_err().code,
            crate::ErrorCode::NotFound
        );
        let after = library
            .status("zelda64-recomp", ReleaseChannel::Stable)
            .unwrap();
        assert_eq!(after.active.unwrap().id, before.active.unwrap().id);
        assert_eq!(after.previous.unwrap().id, before.previous.unwrap().id);
    }

    #[test]
    fn rollback_rejects_previous_runtime_identity_mismatch_read_only() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        register_zelda_install(&library, "v1", true);
        register_zelda_install(&library, "v2", true);
        let mut previous = library
            .status("zelda64-recomp", ReleaseChannel::Stable)
            .unwrap()
            .previous
            .unwrap();
        // A runtime identity that does not match the retained target must not
        // be interpreted using the active version's runtime or launch readiness.
        previous.runtime = Some(crate::RuntimeIdentity {
            origin: crate::RuntimeOrigin::VerifiedDownload,
            artifact: ArtifactIdentity {
                asset_name: "unexpected-runtime.zip".into(),
                sha256: "a".repeat(64),
                size: 1,
            },
            archive_root: "runtime".into(),
            target_directory: "runtime".into(),
            executable: "runtime.exe".into(),
        });
        library.update_install_manifest(&previous).unwrap();
        let service = PortcoveService::new(library.clone()).unwrap();
        let before = crate::test_fixture::library_file_snapshot(&library);
        let status = service.status("zelda64-recomp").unwrap();
        let rollback = status
            .port_actions
            .iter()
            .find(|item| item.action == PortAction::Rollback)
            .unwrap();
        assert_eq!(rollback.availability, PortActionAvailability::Held);
        assert_eq!(rollback.reason, PortActionReason::InvalidInstallation);
        assert_eq!(crate::test_fixture::library_file_snapshot(&library), before);
        assert_eq!(
            service.rollback("zelda64-recomp").unwrap_err().code,
            crate::ErrorCode::Verification
        );
        let after = library
            .status("zelda64-recomp", ReleaseChannel::Stable)
            .unwrap();
        assert_eq!(after.previous.unwrap().id, previous.id);
        assert_eq!(after.active.unwrap().version, "v2");
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
            .prepare_launch("lighthouse", Some(&invalid))
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

            let error = service.prepare_launch("zelda64-recomp", None).unwrap_err();

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

        let error = service.prepare_launch("zelda64-recomp", None).unwrap_err();

        assert_eq!(error.code, crate::ErrorCode::Verification);
        assert!(!active.path.join(LAUNCH_MARKER).exists());
    }

    #[test]
    fn launch_rejects_a_new_loader_companion_before_child_preparation() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        register_zelda_install(&library, "v1", true);
        let active = library
            .status("zelda64-recomp", ReleaseChannel::Stable)
            .unwrap()
            .active
            .unwrap();
        fs::write(
            active.path.join("unmanifested.dll"),
            b"untrusted loader input",
        )
        .unwrap();
        let service = PortcoveService::new(library).unwrap();

        let error = service.prepare_launch("zelda64-recomp", None).unwrap_err();

        assert_eq!(error.code, crate::ErrorCode::Verification);
        assert!(error.details["failures"].contains("unmanifested.dll"));
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
        let spec = service.prepare_launch("zelda64-recomp", None).unwrap();

        assert!(report.valid, "{:?}", report.failures);
        assert!(spec.executable.starts_with(&path));
        assert!(!path.join(LAUNCH_MARKER).is_file());
    }

    #[test]
    fn additive_current_mutability_recovers_a_retained_install_and_survives_rollback() {
        const PORT: &str = "zelda64-recomp";
        let fixture_started = std::time::Instant::now();
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let previous = register_zelda_install(&library, "v1", true);
        let active = register_zelda_install(&library, "v2", true);
        eprintln!(
            "Additive current mutability fixtures registered: {:?}",
            fixture_started.elapsed()
        );
        let active_install = library
            .status(PORT, ReleaseChannel::Stable)
            .unwrap()
            .active
            .unwrap();
        let original_manifest = fs::read(active.join(".portcove-manifest.json")).unwrap();
        fs::write(active.join("new-settings.ini"), b"player preference").unwrap();
        fs::create_dir(active.join("logs")).unwrap();
        fs::write(active.join("logs/game.log"), b"runtime output").unwrap();
        fs::write(active.join(LAUNCH_MARKER), b"1").unwrap();
        let mut service = PortcoveService::new(library.clone()).unwrap();
        assert!(!service.verify(PORT).unwrap().valid);
        assert!(
            service
                .preview_retained_build_binding(PORT, "additive-active", &active_install.id)
                .is_err()
        );

        eprintln!(
            "Additive current mutability original refusal verified: {:?}",
            fixture_started.elapsed()
        );
        let mut document = service.catalog().authoritative_document();
        let current = document
            .ports
            .iter_mut()
            .find(|port| port.id == PORT)
            .unwrap();
        current.persistent_paths.push("new-settings.ini".into());
        current.runtime_mutable_paths.push("logs/game.log".into());
        service.replace_catalog_for_test(
            Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap(),
        );

        assert!(service.verify(PORT).unwrap().valid);
        assert!(service.prepare_launch(PORT, None).is_ok());
        let preview = service
            .preview_retained_build_binding(PORT, "additive-active", &active_install.id)
            .unwrap();
        let consent = service
            .authorize_retained_build_binding(
                PORT,
                "additive-active",
                &active_install.id,
                &preview.preview_sha256,
            )
            .unwrap();
        let active_reference = service
            .bind_retained_build(PORT, "additive-active", &active_install.id, &consent.token)
            .unwrap();
        assert_eq!(
            active_reference.build.manifest_sha256,
            active_install.manifest_sha256
        );
        assert_eq!(
            service
                .resolve_retained_build(PORT, "additive-active")
                .unwrap()
                .availability,
            crate::RetainedBuildAvailability::Verified
        );
        assert_eq!(
            fs::read(library.user_dir(PORT).join("new-settings.ini")).unwrap(),
            b"player preference"
        );
        assert!(!library.user_dir(PORT).join("logs/game.log").exists());
        assert_eq!(
            fs::read(active.join(".portcove-manifest.json")).unwrap(),
            original_manifest
        );
        assert!(
            !service
                .installed_port(&active_install)
                .unwrap()
                .persistent_paths
                .contains(&"new-settings.ini".into())
        );

        eprintln!(
            "Additive current mutability active binding assertions complete: {:?}",
            fixture_started.elapsed()
        );
        service.rollback(PORT).unwrap();
        assert_eq!(
            fs::read(previous.join("new-settings.ini")).unwrap(),
            b"player preference"
        );
        assert!(!previous.join("logs/game.log").exists());
        assert!(service.verify(PORT).unwrap().valid);
        let previous_install = library
            .status(PORT, ReleaseChannel::Stable)
            .unwrap()
            .active
            .unwrap();
        let preview = service
            .preview_retained_build_binding(PORT, "additive-previous", &previous_install.id)
            .unwrap();
        let consent = service
            .authorize_retained_build_binding(
                PORT,
                "additive-previous",
                &previous_install.id,
                &preview.preview_sha256,
            )
            .unwrap();
        let previous_reference = service
            .bind_retained_build(
                PORT,
                "additive-previous",
                &previous_install.id,
                &consent.token,
            )
            .unwrap();
        fs::write(previous.join("engine.dll"), b"changed engine").unwrap();
        assert!(!service.verify(PORT).unwrap().valid);
        assert!(service.prepare_launch(PORT, None).is_err());
        let changed = service
            .resolve_retained_build(PORT, "additive-previous")
            .unwrap();
        assert_eq!(
            changed.availability,
            crate::RetainedBuildAvailability::Changed
        );
        assert_eq!(changed.reference, previous_reference);
        assert!(changed.install.is_none());
        assert_eq!(
            service
                .resolve_retained_build(PORT, "additive-active")
                .unwrap()
                .reference,
            active_reference
        );
        eprintln!(
            "Additive current mutability assertions complete: {:?}",
            fixture_started.elapsed()
        );
    }

    #[test]
    fn richer_managed_activation_keeps_non_ready_persistence_changes_applicable() {
        const PORT: &str = "zelda64-recomp";
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let old = Catalog::embedded().unwrap();
        let port = old.port(PORT).unwrap();
        assert!(!crate::persistence::ready_staged_archive(port));
        assert!(!crate::persistence::requires_restore_receipt(port));
        assert_ne!(port.adapter, AdapterKind::NativePortable);
        let executable = b"inert richer-adapter fixture";
        register_zelda_install_contract(&library, "v1", true, executable, Some(&old));
        let mut document = old.authoritative_document();
        document
            .ports
            .iter_mut()
            .find(|port| port.id == PORT)
            .unwrap()
            .persistent_paths
            .push("new-settings.ini".into());
        let current = Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap();
        let path =
            register_zelda_install_contract(&library, "v2", false, executable, Some(&current));
        let mut service = PortcoveService::new(library.clone()).unwrap();
        service.replace_catalog_for_test(current);
        let before = library.status(PORT, ReleaseChannel::Stable).unwrap();
        service
            .require_portable_target_transition(
                before.active.as_ref().unwrap(),
                before.staged.as_ref().unwrap(),
            )
            .unwrap();
        let activated = service.activate_staged(PORT).unwrap();
        assert_eq!(activated.path, path);
        assert_eq!(
            library
                .status(PORT, ReleaseChannel::Stable)
                .unwrap()
                .active
                .unwrap()
                .id,
            activated.id
        );
        assert!(OperationStore::new(library).all().unwrap().is_empty());
    }

    #[test]
    fn descriptive_catalog_changes_preserve_additive_backup_collection() {
        const PORT: &str = "zelda64-recomp";
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let active = register_zelda_install(&library, "v1", true);
        let manifest = fs::read(active.join(".portcove-manifest.json")).unwrap();
        let installed = library
            .status(PORT, ReleaseChannel::Stable)
            .unwrap()
            .active
            .unwrap();
        let executable = fs::read(active.join(&installed.selected_executable)).unwrap();
        fs::write(
            active.join("new-settings.ini"),
            b"retained runtime preference",
        )
        .unwrap();
        fs::write(active.join(LAUNCH_MARKER), b"1").unwrap();
        let mut service = PortcoveService::new(library.clone()).unwrap();
        let retained = service.status(PORT).unwrap().active.unwrap();
        let mut document = service
            .installed_catalog(&retained)
            .unwrap()
            .authoritative_document();
        let current = document
            .ports
            .iter_mut()
            .find(|port| port.id == PORT)
            .unwrap();
        current.support_tier = if current.support_tier == crate::SupportTier::Stable {
            crate::SupportTier::Rolling
        } else {
            crate::SupportTier::Stable
        };
        current.name = "Updated display name".into();
        current.summary = "Updated descriptive summary".into();
        current.project_url = "https://example.invalid/project".into();
        current.automated_tested_platforms = vec![Platform::current().unwrap()];
        current.manually_validated_platforms = current.automated_tested_platforms.clone();
        current.upstream_status = crate::UpstreamStatus::Retired;
        current.presentation = None;
        current.persistent_paths.push("new-settings.ini".into());
        service.replace_catalog_for_test(
            Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap(),
        );
        assert_ne!(
            service.catalog.port(PORT).unwrap().support_tier,
            service.installed_port(&retained).unwrap().support_tier,
        );
        let backup = service.create_backup(PORT).unwrap();
        assert_eq!(
            fs::read(backup.path.join("data/new-settings.ini")).unwrap(),
            b"retained runtime preference"
        );
        assert_eq!(
            fs::read(active.join("new-settings.ini")).unwrap(),
            b"retained runtime preference"
        );
        assert_eq!(
            fs::read(active.join(".portcove-manifest.json")).unwrap(),
            manifest
        );
        assert_eq!(
            fs::read(active.join(&installed.selected_executable)).unwrap(),
            executable
        );
        assert!(
            !service
                .installed_port(&retained)
                .unwrap()
                .persistent_paths
                .contains(&"new-settings.ini".into())
        );
    }

    #[test]
    fn public_collection_refuses_a_lock_held_by_another_library_handle() {
        const PORT: &str = "zelda64-recomp";
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let active = register_zelda_install(&library, "v1", true);
        fs::write(active.join("general.json"), b"runtime preference").unwrap();
        let canonical = library.user_dir(PORT).join("general.json");
        fs::create_dir_all(canonical.parent().unwrap()).unwrap();
        fs::write(&canonical, b"canonical witness").unwrap();
        let other = Library::open(library.root()).unwrap();
        let service = PortcoveService::new(other).unwrap();
        let held = library
            .try_lock_port(PORT, "test-collection-owner")
            .unwrap();
        for result in [
            service.collect_user_data(PORT),
            service.collect_user_data_from_install(PORT, &active),
        ] {
            assert_eq!(result.unwrap_err().code, crate::ErrorCode::Conflict);
            assert_eq!(fs::read(&canonical).unwrap(), b"canonical witness");
            assert_eq!(
                fs::read(active.join("general.json")).unwrap(),
                b"runtime preference"
            );
        }
        drop(held);
        service
            .collect_user_data_from_install(PORT, &active)
            .unwrap();
        assert_eq!(fs::read(canonical).unwrap(), b"runtime preference");
    }

    #[test]
    fn unrelated_catalog_drift_cannot_expand_retained_mutability() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let active = register_zelda_install(&library, "v1", true);
        let mut service = PortcoveService::new(library).unwrap();
        let mut document = service.catalog().authoritative_document();
        let current = document
            .ports
            .iter_mut()
            .find(|port| port.id == "zelda64-recomp")
            .unwrap();
        current
            .launch_arguments
            .push("--new-launch-contract".into());
        current.persistent_paths.push("new-settings.ini".into());
        service.replace_catalog_for_test(
            Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap(),
        );
        fs::write(active.join("new-settings.ini"), b"unadmitted preference").unwrap();
        let report = service.verify("zelda64-recomp").unwrap();
        assert!(!report.valid);
        assert!(
            report
                .failures
                .contains(&"unexpected: new-settings.ini".into())
        );
        assert!(service.prepare_launch("zelda64-recomp", None).is_err());
        assert!(
            !service
                .library
                .user_dir("zelda64-recomp")
                .join("new-settings.ini")
                .exists()
        );
    }

    #[test]
    fn interrupted_activation_recovers_with_newly_admitted_retained_preferences() {
        const PORT: &str = "zelda64-recomp";
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let active = register_zelda_install(&library, "v1", true);
        let staged = register_zelda_install(&library, "v2", false);
        fs::write(active.join("new-settings.ini"), b"player preference").unwrap();
        fs::write(active.join(LAUNCH_MARKER), b"1").unwrap();
        let service = service_with_added_persistent_path(library.clone(), "v3", "new-settings.ini");
        let store = OperationStore::new(library.clone());
        let mut operation = LifecycleOperation::new(
            "recover-additive-persistence",
            LifecycleOperationKind::Activate,
            PORT,
        );
        operation.install = Some(service.status(PORT).unwrap().staged.unwrap());
        store.put(&mut operation).unwrap();

        service.recover_activation(&store, &mut operation).unwrap();
        assert_eq!(service.status(PORT).unwrap().active.unwrap().path, staged);
        assert_eq!(
            fs::read(staged.join("new-settings.ini")).unwrap(),
            b"player preference"
        );
        assert!(service.verify(PORT).unwrap().valid);
        assert!(store.all().unwrap().is_empty());
    }

    #[test]
    fn staged_and_rollback_tamper_leave_install_pointers_unchanged() {
        let started = std::time::Instant::now();
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        register_zelda_install(&library, "v1", true);
        register_zelda_install(&library, "v2", false);
        eprintln!(
            "Tamper lifecycle staged fixtures ready: {:?}",
            started.elapsed()
        );
        let staged_before = library
            .status("zelda64-recomp", ReleaseChannel::Stable)
            .unwrap();
        let staged = staged_before.staged.as_ref().unwrap();
        tamper_host_test_executable(
            &staged.path.join(&staged.selected_executable),
            b"changed staged executable",
        );
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
        eprintln!(
            "Tamper lifecycle staged refusal verified: {:?}",
            started.elapsed()
        );

        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        register_zelda_install(&library, "v1", true);
        register_zelda_install(&library, "v2", true);
        eprintln!(
            "Tamper lifecycle rollback fixtures ready: {:?}",
            started.elapsed()
        );
        let rollback_before = library
            .status("zelda64-recomp", ReleaseChannel::Stable)
            .unwrap();
        let service = PortcoveService::new(library.clone()).unwrap();
        let assessment = |status: PortStatus| {
            status
                .port_actions
                .into_iter()
                .find(|item| item.action == PortAction::Rollback)
                .unwrap()
        };
        let original_files = crate::test_fixture::library_file_snapshot(&library);
        let original_activity = serde_json::to_value(library.activity_feed(200).unwrap()).unwrap();
        let observed = assessment(service.status("zelda64-recomp").unwrap());
        assert_eq!(observed.availability, PortActionAvailability::Allowed);
        assert_eq!(observed.reason, PortActionReason::Available);
        assert_eq!(
            crate::test_fixture::library_file_snapshot(&library),
            original_files
        );
        assert_eq!(
            serde_json::to_value(library.activity_feed(200).unwrap()).unwrap(),
            original_activity
        );
        eprintln!(
            "Tamper lifecycle allowed preflight verified: {:?}",
            started.elapsed()
        );
        let previous = rollback_before.previous.as_ref().unwrap();
        let previous_executable = previous.path.join(&previous.selected_executable);
        let original_executable = fs::read(&previous_executable).unwrap();
        tamper_host_test_executable(
            &previous.path.join(&previous.selected_executable),
            b"changed rollback executable",
        );
        let held_files = crate::test_fixture::library_file_snapshot(&library);
        let held = assessment(service.status("zelda64-recomp").unwrap());
        assert_eq!(held.availability, PortActionAvailability::Held);
        assert_eq!(held.reason, PortActionReason::InvalidInstallation);
        let batched = service
            .statuses()
            .unwrap()
            .into_iter()
            .find(|status| status.port_id == "zelda64-recomp")
            .unwrap();
        assert_eq!(assessment(batched), held);
        assert_eq!(
            crate::test_fixture::library_file_snapshot(&library),
            held_files
        );
        assert_eq!(
            serde_json::to_value(library.activity_feed(200).unwrap()).unwrap(),
            original_activity
        );
        eprintln!(
            "Tamper lifecycle held preflight verified: {:?}",
            started.elapsed()
        );

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
        eprintln!(
            "Tamper lifecycle rollback refusal verified: {:?}",
            started.elapsed()
        );
        fs::write(&previous_executable, &original_executable).unwrap();
        crate::permissions::normalize_archive_entry(&previous_executable, false, true).unwrap();
        assert_eq!(
            assessment(service.status("zelda64-recomp").unwrap()),
            observed
        );
        assert_eq!(service.rollback("zelda64-recomp").unwrap().id, previous.id);
        eprintln!(
            "Tamper lifecycle recovered rollback verified: {:?}",
            started.elapsed()
        );
    }

    struct CancelLaunchAt {
        controller: PortcoveService,
        request_id: String,
        point: LifecycleFaultPoint,
        accepted: bool,
    }

    impl LifecycleFaultInjector for CancelLaunchAt {
        fn check(&self, point: LifecycleFaultPoint) -> Result<()> {
            if point == self.point {
                assert_eq!(
                    self.controller
                        .request_cancellation(&self.request_id)
                        .is_ok(),
                    self.accepted
                );
            }
            Ok(())
        }
    }

    struct FailLaunchAt(LifecycleFaultPoint);

    impl LifecycleFaultInjector for FailLaunchAt {
        fn check(&self, point: LifecycleFaultPoint) -> Result<()> {
            if point == self.0 {
                return Err(PortcoveError::state("simulated supervisor crash"));
            }
            Ok(())
        }
    }

    fn launch_service_with_faults(
        library: Library,
        faults: Arc<dyn LifecycleFaultInjector>,
    ) -> PortcoveService {
        PortcoveService::with_provider_and_faults(
            library,
            Arc::new(StaticReleaseProvider {
                version: "v1".into(),
            }),
            faults,
        )
        .unwrap()
    }

    #[test]
    fn pre_spawn_cancellation_is_durable_and_never_creates_a_child() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        register_launch_probe(&library, "v1", true);
        let request_id = Uuid::new_v4().to_string();
        let controller = PortcoveService::new(library.clone()).unwrap();
        let service = launch_service_with_faults(
            library.clone(),
            Arc::new(CancelLaunchAt {
                controller,
                request_id: request_id.clone(),
                point: LifecycleFaultPoint::SourcePrepared,
                accepted: true,
            }),
        );
        let started = temporary.path().join("cancelled-started");
        let arguments = vec![
            started.display().to_string(),
            "0".into(),
            "must-not-run".into(),
            "0".into(),
        ];

        let error = service
            .supervise_launch_identified(
                IdentifiedLaunchRequest {
                    request_id: &request_id,
                    port_id: "zelda64-recomp",
                    source_override: None,
                    arguments: &arguments,
                    stdio: LaunchStdio::Null,
                },
                |_| {},
                |_| panic!("cancelled preparation must not report a child"),
            )
            .unwrap_err();

        assert_eq!(error.code, crate::ErrorCode::Cancelled);
        assert!(!started.exists());
        assert!(library.launch_sessions().unwrap().is_empty());
        let library_root = library.root().to_path_buf();
        drop(service);
        drop(library);
        let reconnected = Library::open(library_root).unwrap();
        let request = reconnected.launch_request(&request_id).unwrap().unwrap();
        assert_eq!(request.outcome, Some(LaunchSessionOutcome::Cancelled));
        assert!(request.child_pid.is_none());
        assert_eq!(
            reconnected.activities(1).unwrap()[0].status,
            ActivityStatus::Cancelled
        );
    }

    #[test]
    fn cancellation_loses_exactly_at_the_final_pre_spawn_boundary() {
        let _diagnostic = crate::launch::child_diagnostic::Guard::begin(
            crate::launch::child_diagnostic::Control::Observe,
        );
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        register_launch_probe(&library, "v1", true);
        let request_id = Uuid::new_v4().to_string();
        let controller = PortcoveService::new(library.clone()).unwrap();
        let service = launch_service_with_faults(
            library.clone(),
            Arc::new(CancelLaunchAt {
                controller,
                request_id: request_id.clone(),
                point: LifecycleFaultPoint::LaunchReadyToSpawn,
                accepted: false,
            }),
        );
        let arguments = vec![
            temporary.path().join("started").display().to_string(),
            "0".into(),
            "completed".into(),
            "0".into(),
        ];

        let outcome = service
            .supervise_launch_identified(
                IdentifiedLaunchRequest {
                    request_id: &request_id,
                    port_id: "zelda64-recomp",
                    source_override: None,
                    arguments: &arguments,
                    stdio: LaunchStdio::Null,
                },
                |_| {},
                |_| {},
            )
            .unwrap();

        assert!(outcome.successful);
        assert_eq!(
            library
                .launch_request(&request_id)
                .unwrap()
                .unwrap()
                .outcome,
            Some(LaunchSessionOutcome::Succeeded)
        );
    }

    #[test]
    fn missing_child_identity_with_pending_exit_refuses_and_reaps_owned_child() {
        assert_missing_child_identity_control(
            crate::launch::child_diagnostic::Control::MissingPending,
        );
    }

    #[test]
    fn missing_child_identity_with_completed_exit_collects_exact_result() {
        assert_missing_child_identity_control(
            crate::launch::child_diagnostic::Control::MissingCompleted,
        );
    }

    fn assert_missing_child_identity_control(control: crate::launch::child_diagnostic::Control) {
        use crate::launch::child_diagnostic::{Control, Guard};
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        register_launch_probe(&library, "v1", true);
        let service = launch_service_with_faults(library.clone(), Arc::new(NoLifecycleFaults));
        let request_id = Uuid::new_v4().to_string();
        let diagnostic = Guard::begin(control);
        let arguments = vec![
            temporary.path().join("started").display().to_string(),
            "0".into(),
            "completed-control".into(),
            "0".into(),
        ];
        let mut started = false;
        let result = service.supervise_launch_identified(
            IdentifiedLaunchRequest {
                request_id: &request_id,
                port_id: "zelda64-recomp",
                source_override: None,
                arguments: &arguments,
                stdio: LaunchStdio::Null,
            },
            |_| {},
            |_| started = true,
        );
        assert!(
            !started,
            "missing identity cannot publish an identified running child"
        );
        let events = diagnostic.events();
        assert!(
            events
                .iter()
                .any(|event| event.stage == "identity_control"
                    && event.outcome == "injected_missing")
        );
        assert!(
            events
                .windows(2)
                .all(|pair| pair[0].elapsed_us <= pair[1].elapsed_us)
        );
        let request = library.launch_request(&request_id).unwrap().unwrap();
        if control == Control::MissingPending {
            let error = result.unwrap_err();
            assert_eq!(error.code, crate::ErrorCode::State);
            assert!(
                error
                    .message
                    .contains("was still running after its start identity disappeared")
            );
            assert_eq!(request.outcome, Some(LaunchSessionOutcome::Failed));
            assert!(
                events.iter().any(|event| event.stage == "try_wait_control"
                    && event.outcome == "injected_pending")
            );
            assert!(events.iter().any(|event| event.stage == "kill"));
            assert!(
                events
                    .iter()
                    .any(|event| event.stage == "cleanup_wait" && event.outcome == "reaped")
            );
        } else {
            let outcome = result.unwrap();
            assert!(outcome.successful);
            assert_eq!(outcome.exit_code, Some(0));
            assert_eq!(request.outcome, Some(LaunchSessionOutcome::Succeeded));
            assert_eq!(
                fs::read(library.user_dir("zelda64-recomp").join("general.json")).unwrap(),
                b"completed-control",
            );
            assert!(
                events
                    .iter()
                    .any(|event| event.stage == "control_wait" && event.outcome == "reaped")
            );
            assert!(
                events
                    .iter()
                    .any(|event| event.stage == "try_wait_original" && event.outcome == "completed")
            );
            assert!(!events.iter().any(|event| event.stage == "kill"));
        }
    }

    fn assert_supervisor_crashes_after_spawn_or_during_collection_never_become_success(
        point: LifecycleFaultPoint,
    ) {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        register_launch_probe(&library, "v1", true);
        let request_id = Uuid::new_v4().to_string();
        let service = launch_service_with_faults(library.clone(), Arc::new(FailLaunchAt(point)));
        let arguments = vec![
            temporary.path().join("started").display().to_string(),
            "50".into(),
            "recovered".into(),
            "0".into(),
        ];

        let error = service
            .supervise_launch_identified(
                IdentifiedLaunchRequest {
                    request_id: &request_id,
                    port_id: "zelda64-recomp",
                    source_override: None,
                    arguments: &arguments,
                    stdio: LaunchStdio::Null,
                },
                |_| {},
                |_| {},
            )
            .unwrap_err();
        assert_eq!(error.message, "simulated supervisor crash");
        assert_eq!(library.launch_sessions().unwrap().len(), 1);
        library
            .connection()
            .unwrap()
            .execute(
                "UPDATE launch_sessions
                 SET supervisor_pid=?2, supervisor_identity=NULL
                 WHERE id=?1",
                rusqlite::params![request_id, u32::MAX],
            )
            .unwrap();

        PortcoveService::new(library.clone())
            .unwrap()
            .recover_launch_session(&request_id)
            .unwrap();
        let request = library.launch_request(&request_id).unwrap().unwrap();
        assert_eq!(request.outcome, Some(LaunchSessionOutcome::Failed));
        assert_eq!(
            fs::read(library.user_dir("zelda64-recomp").join("general.json")).unwrap(),
            b"recovered"
        );
    }

    #[test]
    fn recovers_launch_child_started() {
        assert_supervisor_crashes_after_spawn_or_during_collection_never_become_success(
            LifecycleFaultPoint::LaunchChildStarted,
        );
    }

    #[test]
    fn recovers_launch_collecting() {
        assert_supervisor_crashes_after_spawn_or_during_collection_never_become_success(
            LifecycleFaultPoint::LaunchCollecting,
        );
    }

    #[test]
    fn recovery_collection_failure_preserves_retry_without_child_identity() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let install = register_launch_probe(&library, "v1", true);
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
                install_id: install.id,
                install_root: install.path.clone(),
                owner_kind: crate::LaunchOwnerKind::Managed,
                supervisor_pid: u32::MAX,
                supervisor_identity: None,
                child_pid: None,
                child_identity: None,
                phase: LaunchSessionPhase::Collecting,
                outcome: None,
                exit_code: None,
                message: None,
                started_at: now,
                updated_at: now,
                finished_at: None,
            })
            .unwrap();
        fs::write(install.path.join("general.json"), b"recovered save").unwrap();
        let user = library.user_dir("zelda64-recomp");
        fs::create_dir_all(user.parent().unwrap()).unwrap();
        fs::write(&user, b"block creation of the save destination").unwrap();
        let service = PortcoveService::new(library.clone()).unwrap();

        assert!(service.recover_launch_session(&activity.id).is_err());
        let retained = library
            .active_launch_session(&activity.id)
            .unwrap()
            .unwrap();
        assert_eq!(retained.phase, LaunchSessionPhase::Collecting);
        assert!(retained.child_identity.is_none());
        assert!(library.try_lock_port("zelda64-recomp", "update").is_err());
        fs::remove_file(&user).unwrap();
        drop(service);

        PortcoveService::new(library.clone())
            .unwrap()
            .recover_launch_session(&activity.id)
            .unwrap();

        assert!(
            library
                .active_launch_session(&activity.id)
                .unwrap()
                .is_none()
        );
        assert_eq!(
            fs::read(user.join("general.json")).unwrap(),
            b"recovered save"
        );
        assert_eq!(
            library
                .launch_request(&activity.id)
                .unwrap()
                .unwrap()
                .outcome,
            Some(LaunchSessionOutcome::Failed)
        );
    }

    #[test]
    fn recovered_pid_identity_mismatch_fails_closed_and_keeps_the_port_blocked() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let install = register_launch_probe(&library, "v1", true);
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
                install_id: install.id,
                install_root: install.path,
                owner_kind: crate::LaunchOwnerKind::Managed,
                supervisor_pid: u32::MAX,
                supervisor_identity: None,
                child_pid: Some(std::process::id()),
                child_identity: Some("different-process-start".into()),
                phase: LaunchSessionPhase::Running,
                outcome: None,
                exit_code: None,
                message: None,
                started_at: now,
                updated_at: now,
                finished_at: None,
            })
            .unwrap();
        let service = PortcoveService::new(library.clone()).unwrap();

        let error = service.recover_launch_session(&activity.id).unwrap_err();

        assert_eq!(error.code, crate::ErrorCode::Conflict);
        assert_eq!(error.details["recovery_action"], "manual_review");
        assert_eq!(library.launch_sessions().unwrap().len(), 1);
        assert!(library.try_lock_port("zelda64-recomp", "update").is_err());
        assert_eq!(
            library.activities(1).unwrap()[0].status,
            ActivityStatus::Running
        );
    }

    #[test]
    fn recovered_spawning_phase_remains_blocked_when_child_identity_is_ambiguous() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let install = register_launch_probe(&library, "v1", true);
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
                install_id: install.id,
                install_root: install.path,
                owner_kind: crate::LaunchOwnerKind::Managed,
                supervisor_pid: u32::MAX,
                supervisor_identity: None,
                child_pid: None,
                child_identity: None,
                phase: LaunchSessionPhase::Spawning,
                outcome: None,
                exit_code: None,
                message: None,
                started_at: now,
                updated_at: now,
                finished_at: None,
            })
            .unwrap();

        let error = PortcoveService::new(library.clone())
            .unwrap()
            .recover_launch_session(&activity.id)
            .unwrap_err();

        assert_eq!(error.code, crate::ErrorCode::Conflict);
        assert_eq!(error.details["recovery_action"], "manual_review");
        assert_eq!(library.launch_sessions().unwrap().len(), 1);
        assert!(library.try_lock_port("zelda64-recomp", "update").is_err());
        assert_eq!(
            library.activities(1).unwrap()[0].status,
            ActivityStatus::Running
        );
    }

    #[test]
    fn recovered_install_identity_mismatch_fails_closed() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let install = register_launch_probe(&library, "v1", true);
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
                install_id: "replaced-install".into(),
                install_root: install.path,
                owner_kind: crate::LaunchOwnerKind::Managed,
                supervisor_pid: u32::MAX,
                supervisor_identity: None,
                child_pid: None,
                child_identity: None,
                phase: LaunchSessionPhase::Collecting,
                outcome: None,
                exit_code: None,
                message: None,
                started_at: now,
                updated_at: now,
                finished_at: None,
            })
            .unwrap();

        let error = PortcoveService::new(library.clone())
            .unwrap()
            .recover_launch_session(&activity.id)
            .unwrap_err();

        assert_eq!(error.code, crate::ErrorCode::Conflict);
        assert_eq!(error.details["install_id"], "replaced-install");
        assert_eq!(library.launch_sessions().unwrap().len(), 1);
        assert_eq!(
            library.activities(1).unwrap()[0].status,
            ActivityStatus::Running
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

        let session = receiver.recv_timeout(Duration::from_secs(30)).unwrap();
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
        let request = library
            .launch_request(&outcome.session_id)
            .unwrap()
            .unwrap();
        assert_eq!(request.outcome, Some(LaunchSessionOutcome::Succeeded));
        assert_eq!(request.exit_code, Some(0));
        assert!(request.child_identity.is_some());
        assert!(request.finished_at.is_some());
    }

    #[test]
    fn failed_spawn_creates_neither_marker_nor_unfinished_session() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        #[cfg(unix)]
        let unspawnable = b"#!/portcove-test-missing-interpreter\n".as_slice();
        #[cfg(not(unix))]
        let unspawnable = b"not a Windows executable".as_slice();
        let install = register_zelda_install_with_executable(&library, "v1", true, unspawnable);
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
        let request = library
            .launch_request(&outcome.session_id)
            .unwrap()
            .unwrap();
        assert_eq!(request.outcome, Some(LaunchSessionOutcome::Failed));
        assert_eq!(request.exit_code, Some(7));
    }

    #[test]
    fn forwarded_interrupt_still_finishes_supervision_and_clears_the_session() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let install = register_launch_probe(&library, "v1", true);
        let service = PortcoveService::new(library.clone()).unwrap();
        let started = temporary.path().join("interrupt-started");
        let arguments = vec![
            started.display().to_string(),
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

        // The callback commits child identity; it does not witness the controlled
        // child's main entry. Observe its existing marker before sending the signal.
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        let readiness = loop {
            let observed = fs::read(&started);
            if handle.is_finished() {
                break Err("launch supervision finished before interruption".to_string());
            }
            if observed
                .as_ref()
                .is_ok_and(|bytes| bytes.as_slice() == b"started")
            {
                break Ok(());
            }
            if std::time::Instant::now() >= deadline {
                break Err(format!(
                    "launch probe did not reach its entry marker: {observed:?}"
                ));
            }
            thread::sleep(Duration::from_millis(10));
        };
        let forwarded = if readiness.is_ok() && !handle.is_finished() {
            Some(crate::forward_launch_signal(
                child_pid,
                crate::LaunchSignal::Interrupt,
            ))
        } else {
            None
        };
        // Settle owned supervision even when readiness or forwarding failed.
        // The existing outer test runner contains a supervisor that cannot join.
        let completed = handle.join();
        assert!(readiness.is_ok(), "{readiness:?}; signal: {forwarded:?}");
        forwarded
            .expect("launch supervision finished before the signal")
            .unwrap();
        let outcome = completed.unwrap().unwrap();

        assert!(!outcome.successful);
        for root in [install.path, library.user_dir("zelda64-recomp")] {
            match fs::read(root.join("general.json")) {
                Ok(bytes) => assert_ne!(bytes.as_slice(), b"should-not-be-written"),
                Err(error) => assert_eq!(error.kind(), std::io::ErrorKind::NotFound, "{error}"),
            }
        }
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
        let child_pid = child.id();
        let child_identity = crate::launch::process_identity_for_child(&child)
            .unwrap()
            .unwrap();
        for _ in 0..100 {
            if started.is_file() {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        assert!(started.is_file());
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
                owner_kind: crate::LaunchOwnerKind::Managed,
                supervisor_pid: u32::MAX,
                supervisor_identity: None,
                child_pid: Some(child_pid),
                child_identity: Some(child_identity),
                phase: LaunchSessionPhase::Running,
                outcome: None,
                exit_code: None,
                message: None,
                started_at: now,
                updated_at: now,
                finished_at: None,
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
                owner_kind: crate::LaunchOwnerKind::Managed,
                supervisor_pid: u32::MAX,
                supervisor_identity: None,
                child_pid: None,
                child_identity: None,
                phase: LaunchSessionPhase::Preparing,
                outcome: None,
                exit_code: None,
                message: None,
                started_at: now,
                updated_at: now,
                finished_at: None,
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

        let error = service.prepare_launch("zelda64-recomp", None).unwrap_err();

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
        let started = std::time::Instant::now();
        eprintln!(
            "Rollback reuse fixture: setup began at {:?}",
            started.elapsed()
        );
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        eprintln!(
            "Rollback reuse fixture: library opened at {:?}",
            started.elapsed()
        );
        register_zelda_install(&library, "v1", true);
        eprintln!(
            "Rollback reuse fixture: first version registered at {:?}",
            started.elapsed()
        );
        register_zelda_install(&library, "v2", true);
        eprintln!(
            "Rollback reuse fixture: second version registered at {:?}",
            started.elapsed()
        );
        library.rollback("zelda64-recomp").unwrap();
        eprintln!(
            "Rollback reuse fixture: rollback prepared at {:?}",
            started.elapsed()
        );
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
        eprintln!(
            "Rollback reuse fixture: staging assertions complete at {:?}",
            started.elapsed()
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
        eprintln!(
            "Rollback reuse fixture: activation assertions complete at {:?}",
            started.elapsed()
        );
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
        let platform = Platform::current().unwrap();
        if !Catalog::embedded()
            .unwrap()
            .port("g-diffuser")
            .unwrap()
            .platforms
            .contains(&platform)
        {
            return;
        }
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

#[cfg(test)]
mod journal_diagnostic_tests {
    use super::*;
    use crate::{HostPreferenceStore, JournalValidationStage as Stage};

    fn rows(library: &Library) -> Vec<Vec<rusqlite::types::Value>> {
        let db = library.connection().unwrap();
        let mut query = db
            .prepare("SELECT * FROM lifecycle_operations ORDER BY rowid")
            .unwrap();
        query
            .query_map([], |row| {
                (0..row.as_ref().column_count())
                    .map(|i| row.get(i))
                    .collect()
            })
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    }

    fn database_state(library: &Library) -> Vec<(String, Vec<Vec<rusqlite::types::Value>>)> {
        let db = library.connection().unwrap();
        let tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").unwrap()
            .query_map([], |r| r.get::<_,String>(0)).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap();
        tables
            .into_iter()
            .map(|table| {
                let sql = format!(
                    "SELECT * FROM \"{}\" ORDER BY rowid",
                    table.replace('"', "\"\"")
                );
                let mut q = db.prepare(&sql).unwrap();
                let values = q
                    .query_map([], |row| {
                        (0..row.as_ref().column_count())
                            .map(|i| row.get(i))
                            .collect()
                    })
                    .unwrap()
                    .collect::<rusqlite::Result<_>>()
                    .unwrap();
                (table, values)
            })
            .collect()
    }

    #[test]
    fn doctor_counts_retained_active_metadata_without_hydrating_journal_status() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        super::tests::register_zelda_install(&library, "previous", true);
        super::tests::register_zelda_install(&library, "active", true);
        super::tests::register_zelda_install(&library, "staged", false);
        let mut service = PortcoveService::new_read_only(library.clone()).unwrap();
        let mut document = service.catalog.authoritative_document();
        document.ports.retain(|port| port.id != "zelda64-recomp");
        let sources = document.source_catalog.as_mut().unwrap();
        sources
            .contracts
            .retain(|contract| contract.port_id != "zelda64-recomp");
        sources
            .qualification
            .retain(|record| record.scope.port_id != "zelda64-recomp");
        service.catalog = Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap();
        assert_eq!(library.all_installs().unwrap().len(), 3);
        let preferences =
            HostPreferenceStore::new(temporary.path().join("preferences.json")).unwrap();
        assert_eq!(
            service
                .doctor_with_preferences(&preferences)
                .unwrap()
                .installed_port_count,
            1
        );
        library
            .connection()
            .unwrap()
            .execute_batch(
                "INSERT INTO lifecycle_operations(id,kind,port_id,phase,created_at,updated_at)
             VALUES ('retained-corrupt','install','zelda64-recomp','prepared',1,2)",
            )
            .unwrap();
        let before = database_state(&library);
        // Compare application/runtime files, not SQLite/WAL mechanics.
        // Logical database rows are compared separately above and below.
        let files = || {
            crate::test_fixture::library_file_snapshot(&library)
                .into_iter()
                .filter(|(path, _)| {
                    !path
                        .file_name()
                        .is_some_and(|name| name.to_string_lossy().starts_with("portcove.sqlite3"))
                })
                .collect::<Vec<_>>()
        };
        let files_before = files();
        let report = service.doctor_with_preferences(&preferences).unwrap();
        assert_eq!(report.installed_port_count, 1);
        assert!(
            !report
                .repair
                .journal_diagnostics
                .unwrap()
                .problems
                .is_empty()
        );
        assert_eq!(database_state(&library), before);
        assert_eq!(files(), files_before);
    }

    #[test]
    fn doctor_reports_mixed_malformed_state_without_recovery_or_mutation() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let preferences =
            HostPreferenceStore::new(temporary.path().join("preferences.json")).unwrap();
        let staging = library.staging_dir().join("pending-install");
        fs::create_dir_all(&staging).unwrap();
        fs::write(staging.join("sentinel"), b"retained runtime bytes").unwrap();
        let store = OperationStore::new(library.clone());
        let mut pending = LifecycleOperation::new(
            "valid-pending",
            LifecycleOperationKind::Install,
            "zelda64-recomp",
        );
        pending.paths.staging = Some(staging.clone());
        store.put(&mut pending).unwrap();
        let mut missing = LifecycleOperation::new(
            "missing-required",
            LifecycleOperationKind::Install,
            "zelda64-recomp",
        );
        missing.phase = LifecyclePhase::Prepared;
        assert!(store.put(&mut missing).is_err());
        let service = PortcoveService::new_read_only(library.clone()).unwrap();
        let db = library.connection().unwrap();
        db.execute_batch("INSERT INTO lifecycle_operations(id,kind,port_id,phase,created_at,updated_at) VALUES
          ('missing-required','install','zelda64-recomp','prepared',1,2),
          ('unknown-kind','unknown-secret-kind','zelda64-recomp','preparing',3,4),
          ('unknown-phase','install','zelda64-recomp','unknown-secret-phase',5,6),
          ('malformed-json','install','zelda64-recomp','preparing',7,8),
          ('missing-acquisition','acquire_update','zelda64-recomp','preparing',9,10),
          ('bad-column','install','zelda64-recomp','preparing',13,14);
          UPDATE lifecycle_operations SET install_json='{\"secret\":\"payload-canary\"' WHERE id='malformed-json';
          UPDATE lifecycle_operations SET created_at=X'ff',port_id='token=port-canary',last_error='token=error-canary' WHERE id='bad-column';").unwrap();
        let unknown_destination = library
            .versions_dir()
            .join("zelda64-recomp")
            .join("uninterpreted-owner");
        fs::create_dir_all(&unknown_destination).unwrap();
        fs::write(
            unknown_destination.join("sentinel"),
            b"retained destination bytes",
        )
        .unwrap();
        db.execute(
            "UPDATE lifecycle_operations SET final_path=?1 WHERE id='missing-required'",
            [unknown_destination.to_str().unwrap()],
        )
        .unwrap();
        let before = database_state(&library);
        assert!(store.all().is_err());
        assert!(PortcoveService::new(library.clone()).is_err());
        let report = service.doctor_with_preferences(&preferences).unwrap();
        let diagnostic = report.repair.journal_diagnostics.as_ref().unwrap();
        assert!(diagnostic.enumeration_complete);
        assert!(!diagnostic.related_assessments_complete);
        assert_eq!(diagnostic.enumerated_rows, 7);
        assert_eq!(diagnostic.decoded_rows, 1);
        assert_eq!(diagnostic.problems.len(), 6);
        for stage in [
            Stage::Columns,
            Stage::Kind,
            Stage::Phase,
            Stage::Payload,
            Stage::Family,
            Stage::Acquisition,
        ] {
            assert!(
                diagnostic
                    .problems
                    .iter()
                    .any(|problem| problem.stage == stage),
                "{stage:?}"
            );
        }
        assert!(
            report
                .repair
                .items
                .iter()
                .any(|item| item.operation_id.as_deref() == Some("valid-pending"))
        );
        assert_eq!(
            report
                .repair
                .items
                .iter()
                .filter(|item| item.kind == RepairItemKind::MalformedJournal)
                .count(),
            6
        );
        for item in report
            .repair
            .items
            .iter()
            .filter(|item| item.kind == RepairItemKind::MalformedJournal)
        {
            assert!(item.path.is_none() && item.port_id.is_none() && item.operation_id.is_none());
            assert!(!item.proposed_action.contains("restart"));
        }
        let serialized = serde_json::to_string(&report).unwrap();
        for secret in [
            "payload-canary",
            "port-canary",
            "error-canary",
            "unknown-secret-kind",
            "unknown-secret-phase",
        ] {
            assert!(!serialized.contains(secret), "{secret}");
        }
        assert!(
            !report
                .repair
                .items
                .iter()
                .any(|item| item.kind == RepairItemKind::OrphanedFinalDirectory)
        );
        assert_eq!(database_state(&library), before);
        assert_eq!(
            fs::read(unknown_destination.join("sentinel")).unwrap(),
            b"retained destination bytes"
        );
        assert_eq!(
            fs::read(staging.join("sentinel")).unwrap(),
            b"retained runtime bytes"
        );
        assert!(store.all().is_err());
    }

    #[test]
    fn doctor_propagates_query_failure_and_diagnostic_row_limit() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let service = PortcoveService::new_read_only(library.clone()).unwrap();
        let db = library.connection().unwrap();
        db.execute_batch(
            "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<4097)
          INSERT INTO lifecycle_operations(id,kind,port_id,phase,created_at,updated_at)
          SELECT 'bound-'||i,'install','zelda64-recomp','preparing',i,i FROM n;",
        )
        .unwrap();
        let before = rows(&library);
        assert!(
            service
                .repair_plan()
                .unwrap_err()
                .message
                .contains("coverage is incomplete")
        );
        assert_eq!(rows(&library), before);
        db.execute_batch("ALTER TABLE lifecycle_operations RENAME TO retained_broken_schema")
            .unwrap();
        let error = service.repair_plan().unwrap_err();
        assert!(error.message.contains("lifecycle_operations"));
        assert_eq!(
            db.query_row("SELECT count(*) FROM retained_broken_schema", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            4097
        );
    }
}
