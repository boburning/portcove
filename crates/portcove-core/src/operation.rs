use std::{
    fmt,
    path::PathBuf,
    str::FromStr,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{Instant, SystemTime, UNIX_EPOCH},
};

use rusqlite::params;
use uuid::Uuid;

#[cfg(test)]
thread_local! {
    static ALL_READ_COUNT: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

use crate::{
    ActivityRecord, InstallRecord, Library, OperationEvent, OperationEventKind, OperationResult,
    OperationTarget, OutputRelocationPlan, PortcoveError, Result, SourceImportPlan, database,
};

pub const OPERATION_EVENT_SCHEMA_VERSION: u32 = 3;

#[cfg(test)]
pub(crate) fn reset_all_read_count() {
    ALL_READ_COUNT.with(|count| count.set(0));
}

#[cfg(test)]
pub(crate) fn all_read_count() -> usize {
    ALL_READ_COUNT.with(std::cell::Cell::get)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LifecycleOperationKind {
    Install,
    AcquireUpdate,
    Prepare,
    Adopt,
    Remove,
    Restore,
    DeleteBackup,
    Activate,
    Relocate,
    ImportSource,
    GhostshipRecovery,
}

impl fmt::Display for LifecycleOperationKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Install => "install",
            Self::AcquireUpdate => "acquire_update",
            Self::Prepare => "prepare",
            Self::Adopt => "adopt",
            Self::Remove => "remove",
            Self::Restore => "restore",
            Self::DeleteBackup => "delete_backup",
            Self::Activate => "activate",
            Self::Relocate => "relocate",
            Self::ImportSource => "import_source",
            Self::GhostshipRecovery => "ghostship_recovery",
        })
    }
}

impl FromStr for LifecycleOperationKind {
    type Err = PortcoveError;

    fn from_str(value: &str) -> Result<Self> {
        let kind = match value {
            "install" => Some(Self::Install),
            "acquire_update" => Some(Self::AcquireUpdate),
            "prepare" => Some(Self::Prepare),
            "adopt" => Some(Self::Adopt),
            "remove" => Some(Self::Remove),
            "restore" => Some(Self::Restore),
            "delete_backup" => Some(Self::DeleteBackup),
            "activate" => Some(Self::Activate),
            "relocate" => Some(Self::Relocate),
            "import_source" => Some(Self::ImportSource),
            "ghostship_recovery" => Some(Self::GhostshipRecovery),
            _ => None,
        };
        kind.ok_or_else(|| {
            PortcoveError::state(format!("unknown lifecycle operation kind: {value}"))
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LifecyclePhase {
    Preparing,
    Prepared,
    PayloadPublished,
    MetadataCommitted,
    CleanupPending,
}

impl fmt::Display for LifecyclePhase {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Preparing => "preparing",
            Self::Prepared => "prepared",
            Self::PayloadPublished => "payload_published",
            Self::MetadataCommitted => "metadata_committed",
            Self::CleanupPending => "cleanup_pending",
        })
    }
}

impl FromStr for LifecyclePhase {
    type Err = PortcoveError;

    fn from_str(value: &str) -> Result<Self> {
        match value {
            "preparing" => Ok(Self::Preparing),
            "prepared" => Ok(Self::Prepared),
            "payload_published" => Ok(Self::PayloadPublished),
            "metadata_committed" => Ok(Self::MetadataCommitted),
            "cleanup_pending" => Ok(Self::CleanupPending),
            _ => Err(PortcoveError::state(format!(
                "unknown lifecycle operation phase: {value}"
            ))),
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct LifecyclePaths {
    pub staging: Option<PathBuf>,
    pub final_path: Option<PathBuf>,
    pub quarantine: Option<PathBuf>,
}

#[derive(Debug, Clone)]
pub(crate) struct LifecycleOperation {
    pub id: String,
    pub kind: LifecycleOperationKind,
    pub port_id: String,
    pub phase: LifecyclePhase,
    pub paths: LifecyclePaths,
    pub install: Option<InstallRecord>,
    pub update_acquisition: Option<crate::service::game_update_acquisition::AcquisitionJournal>,
    pub relocation: Option<OutputRelocationPlan>,
    pub source_import: Option<SourceImportPlan>,
    pub preparation: Option<crate::PreparationPlan>,
    pub ghostship_recovery: Option<crate::ghostship_data_store::GhostshipRecoveryIntent>,
    pub backup_deletion: Option<crate::ghostship_data_store::BackupDeletionBinding>,
    /// `Some(true)` is durable proof that no setup process from this operation
    /// can still own the private tree. `None` is legacy or non-preparation state.
    pub preparation_process_quiesced: Option<bool>,
    /// Exact registration replaced only by a verified, separately published
    /// native runtime. Absent for ordinary installs and earlier journals.
    pub external_registration_sha256: Option<String>,
    pub original_paths: Vec<PathBuf>,
    pub activate: bool,
    pub last_error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

impl LifecycleOperation {
    pub fn new(
        id: impl Into<String>,
        kind: LifecycleOperationKind,
        port_id: impl Into<String>,
    ) -> Self {
        let now = Library::now();
        Self {
            id: id.into(),
            kind,
            port_id: port_id.into(),
            phase: LifecyclePhase::Preparing,
            paths: LifecyclePaths {
                staging: None,
                final_path: None,
                quarantine: None,
            },
            install: None,
            update_acquisition: None,
            relocation: None,
            source_import: None,
            preparation: None,
            ghostship_recovery: None,
            backup_deletion: None,
            preparation_process_quiesced: None,
            external_registration_sha256: None,
            original_paths: Vec::new(),
            activate: false,
            last_error: None,
            created_at: now,
            updated_at: now,
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct OperationStore {
    library: Library,
}

impl OperationStore {
    pub fn new(library: Library) -> Self {
        Self { library }
    }

    pub fn put(&self, operation: &mut LifecycleOperation) -> Result<()> {
        validate_external_replacement(
            operation.kind,
            operation.activate,
            operation.external_registration_sha256.as_deref(),
        )?;
        validate_private_family(
            operation.kind,
            &operation.port_id,
            operation.ghostship_recovery.is_some(),
            operation.backup_deletion.is_some(),
        )?;
        crate::service::game_update_acquisition::validate_journal(&self.library, operation)?;
        operation.updated_at = Library::now();
        for path in operation
            .paths
            .staging
            .iter()
            .chain(operation.paths.final_path.iter())
            .chain(operation.paths.quarantine.iter())
            .chain(operation.original_paths.iter())
        {
            crate::path::unicode(path, "lifecycle")?;
        }
        let install_json = operation
            .install
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        let relocation_json = operation
            .relocation
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        let source_import_json = operation
            .source_import
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        let original_paths_json = serde_json::to_string(&operation.original_paths)?;
        let preparation_json = operation
            .preparation
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        let ghostship_recovery_json = operation
            .ghostship_recovery
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        let backup_deletion_json = operation
            .backup_deletion
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        let update_acquisition_json = operation
            .update_acquisition
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        let mut connection = database::connect(self.library.root())?;
        let transaction =
            connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        crate::service::game_update_acquisition::require_capacity(
            &transaction,
            operation,
            update_acquisition_json.as_deref(),
        )?;
        if operation.kind != LifecycleOperationKind::AcquireUpdate {
            crate::ghostship_data_store::invalidate(&transaction, &operation.port_id)?;
        }
        transaction.execute(
            "INSERT INTO lifecycle_operations(
               id, kind, port_id, phase, staging_path, final_path, quarantine_path,
               install_json, relocation_json, source_import_json, original_paths_json, activate, last_error, created_at, updated_at, preparation_json,
               preparation_process_quiesced, ghostship_recovery_json, backup_deletion_json, external_registration_sha256, update_acquisition_json
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)
             ON CONFLICT(id) DO UPDATE SET
               kind=excluded.kind,
               port_id=excluded.port_id,
               phase=excluded.phase,
               staging_path=excluded.staging_path,
               final_path=excluded.final_path,
               quarantine_path=excluded.quarantine_path,
               install_json=excluded.install_json,
                relocation_json=excluded.relocation_json,
                source_import_json=excluded.source_import_json,
               original_paths_json=excluded.original_paths_json,
               preparation_json=excluded.preparation_json,
               preparation_process_quiesced=excluded.preparation_process_quiesced,
               ghostship_recovery_json=excluded.ghostship_recovery_json,
               backup_deletion_json=excluded.backup_deletion_json,
               external_registration_sha256=excluded.external_registration_sha256,
               update_acquisition_json=excluded.update_acquisition_json,
               activate=excluded.activate,
               last_error=excluded.last_error,
               updated_at=excluded.updated_at",
            params![
                operation.id,
                operation.kind.to_string(),
                operation.port_id,
                operation.phase.to_string(),
                path_string(operation.paths.staging.as_ref())?,
                path_string(operation.paths.final_path.as_ref())?,
                path_string(operation.paths.quarantine.as_ref())?,
                install_json,
                relocation_json,
                source_import_json,
                original_paths_json,
                operation.activate as i64,
                operation.last_error,
                operation.created_at,
                operation.updated_at,
                preparation_json,
                operation.preparation_process_quiesced.map(i64::from),
                ghostship_recovery_json,
                backup_deletion_json,
                operation.external_registration_sha256,
                update_acquisition_json,
            ],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn remove(&self, id: &str) -> Result<()> {
        database::connect(self.library.root())?
            .execute("DELETE FROM lifecycle_operations WHERE id=?1", [id])?;
        Ok(())
    }

    pub fn all(&self) -> Result<Vec<LifecycleOperation>> {
        #[cfg(test)]
        ALL_READ_COUNT.with(|count| count.set(count.get() + 1));
        self.read(None)
    }

    pub fn get(&self, id: &str) -> Result<Option<LifecycleOperation>> {
        Ok(self.read(Some(id))?.pop())
    }

    fn read(&self, id: Option<&str>) -> Result<Vec<LifecycleOperation>> {
        let connection = database::connect(self.library.root())?;
        let where_or_order = if id.is_some() {
            "WHERE id=?1"
        } else {
            "ORDER BY created_at, rowid"
        };
        let mut statement = connection.prepare(&format!(
            "SELECT id, kind, port_id, phase, staging_path, final_path, quarantine_path,
                    install_json, relocation_json, source_import_json, original_paths_json, activate, last_error, created_at, updated_at, preparation_json,
                    preparation_process_quiesced, ghostship_recovery_json, backup_deletion_json, external_registration_sha256, update_acquisition_json
             FROM lifecycle_operations
             {where_or_order}"
        ))?;
        let rows = statement.query_map(rusqlite::params_from_iter(id), |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, Option<String>>(7)?,
                row.get::<_, Option<String>>(8)?,
                row.get::<_, Option<String>>(9)?,
                row.get::<_, String>(10)?,
                row.get::<_, i64>(11)?,
                row.get::<_, Option<String>>(12)?,
                row.get::<_, i64>(13)?,
                row.get::<_, i64>(14)?,
                row.get::<_, Option<String>>(15)?,
                row.get::<_, Option<i64>>(16)?,
                row.get::<_, Option<String>>(17)?,
                row.get::<_, Option<String>>(18)?,
                row.get::<_, Option<String>>(19)?,
                row.get::<_, Option<String>>(20)?,
            ))
        })?;
        rows.map(|row| {
            let (
                id,
                kind,
                port_id,
                phase,
                staging_path,
                final_path,
                quarantine_path,
                install_json,
                relocation_json,
                source_import_json,
                original_paths_json,
                activate,
                last_error,
                created_at,
                updated_at,
                preparation_json,
                preparation_process_quiesced,
                ghostship_recovery_json,
                backup_deletion_json,
                external_registration_sha256,
                update_acquisition_json,
            ) = row?;
            let kind = kind.parse()?;
            validate_external_replacement(
                kind,
                activate != 0,
                external_registration_sha256.as_deref(),
            )?;
            validate_private_family(
                kind,
                &port_id,
                ghostship_recovery_json.is_some(),
                backup_deletion_json.is_some(),
            )?;
            let operation = LifecycleOperation {
                id,
                kind,
                port_id,
                phase: phase.parse()?,
                paths: LifecyclePaths {
                    staging: staging_path.map(PathBuf::from),
                    final_path: final_path.map(PathBuf::from),
                    quarantine: quarantine_path.map(PathBuf::from),
                },
                install: install_json
                    .map(|value| serde_json::from_str(&value))
                    .transpose()?,
                relocation: relocation_json
                    .map(|value| serde_json::from_str(&value))
                    .transpose()?,
                source_import: source_import_json
                    .map(|value| serde_json::from_str(&value))
                    .transpose()?,
                original_paths: serde_json::from_str(&original_paths_json)?,
                preparation: preparation_json
                    .map(|value| serde_json::from_str(&value))
                    .transpose()?,
                preparation_process_quiesced: preparation_process_quiesced.map(|value| value != 0),
                external_registration_sha256,
                update_acquisition: crate::service::game_update_acquisition::decode_journal(
                    update_acquisition_json.as_deref(),
                )?,
                ghostship_recovery: ghostship_recovery_json
                    .map(|value| serde_json::from_str(&value))
                    .transpose()?,
                backup_deletion: backup_deletion_json
                    .map(|value| serde_json::from_str(&value))
                    .transpose()?,
                activate: activate != 0,
                last_error,
                created_at,
                updated_at,
            };
            crate::service::game_update_acquisition::validate_journal(&self.library, &operation)?;
            Ok(operation)
        })
        .collect()
    }
}

fn validate_external_replacement(
    kind: LifecycleOperationKind,
    activate: bool,
    expected: Option<&str>,
) -> Result<()> {
    if let Some(expected) = expected
        && (kind != LifecycleOperationKind::Install
            || !activate
            || expected.len() != 64
            || !expected
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()))
    {
        return Err(PortcoveError::state(
            "external replacement journal has an invalid owner or registration identity",
        ));
    }
    Ok(())
}

fn validate_private_family(
    kind: LifecycleOperationKind,
    port_id: &str,
    ghostship: bool,
    deletion: bool,
) -> Result<()> {
    if ghostship != (kind == LifecycleOperationKind::GhostshipRecovery)
        || (deletion && kind != LifecycleOperationKind::DeleteBackup)
        || (ghostship && port_id != "ghostship")
    {
        return Err(PortcoveError::state(
            "lifecycle journal has a missing or foreign recovery-family payload",
        ));
    }
    Ok(())
}

fn path_string(path: Option<&PathBuf>) -> Result<Option<String>> {
    path.map(|path| crate::path::unicode(path, "lifecycle"))
        .transpose()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LifecycleFaultPoint {
    #[cfg(test)]
    RecoveryInventoried,
    PreparationJournaled,
    PreparationCopied,
    PreparationToolCompleted,
    PreparationOutputsValidated,
    PreparationPrepared,
    PreparationPublished,
    PreparationRegistered,
    GhostshipRecoveryJournaled,
    GhostshipRecoverySafetyRecorded,
    GhostshipRecoverySafetyPublished,
    GhostshipRecoveryDataStaged,
    GhostshipRecoveryPrepared,
    GhostshipRecoveryBeforePublication,
    GhostshipRecoveryPayloadPublished,
    GhostshipRecoveryCanonicalQuarantined,
    GhostshipRecoveryCanonicalPublished,
    GhostshipRecoveryPublicationRecorded,
    GhostshipRecoveryMetadataCommitted,
    GhostshipRecoveryCleanup,
    #[cfg(test)]
    SourceVerificationCaptured,
    SourcePrepared,
    LaunchReadyToSpawn,
    LaunchChildStarted,
    LaunchCollecting,
    InstallPrepared,
    InstallReadyToPublish,
    UpdateArchiveCopyStarted,
    InstallPrivateCleanup,
    InstallPrivateCleanupJournalRemoval,
    InstallPublished,
    InstallMetadataCommitted,
    AdoptionCopied,
    AdoptionPrivateCleanup,
    AdoptionPrepared,
    AdoptionPublished,
    AdoptionMetadataCommitted,
    RemovalQuarantined,
    RemovalMetadataCommitted,
    RemovalCleanup,
    RetainedBuildBeforeCommit,
    RetainedBuildCommitted,
    RestoreManifestRecordLoaded,
    RestoreAuthorized,
    RestorePrepared,
    RestorePublished,
    RestoreVersionSynchronized,
    BackupStagingCreated,
    BackupDataCopied,
    BackupManifestSynced,
    BackupStagingKept,
    BackupPublished,
    DeleteBackupPrepared,
    DeleteBackupQuarantined,
    DeleteBackupDeleting,
    DeleteBackupDeleted,
    DeleteBackupMetadataCommitted,
    ActivationMetadataCommitted,
    RelocationJournaled,
    RelocationCopyStarted,
    RelocationCopied,
    RelocationPrepared,
    RelocationPublicationPrepared,
    RelocationPublished,
    RelocationMetadataCommitted,
    RelocationCleanupCompleted,
    SourceImportJournaled,
    SourceImportCopyStarted,
    SourceImportCopied,
    SourceImportVerified,
    SourceImportPublicationPrepared,
    SourceImportBeforePublicationRecorded,
    SourceImportBeforePublicationOwnershipRecorded,
    SourceImportPublished,
    SourceImportRegistered,
    SourceImportOriginalQuarantined,
    SourceImportDeleteAttempt,
    SourceImportCleanupCompleted,
}

pub(crate) trait LifecycleFaultInjector: Send + Sync {
    fn check(&self, point: LifecycleFaultPoint) -> Result<()>;
}

#[derive(Debug, Default)]
pub(crate) struct NoLifecycleFaults;

impl LifecycleFaultInjector for NoLifecycleFaults {
    fn check(&self, _point: LifecycleFaultPoint) -> Result<()> {
        Ok(())
    }
}

/// Core-owned identity and ordering for one durable or transient operation.
///
/// Clones share one sequence. Child operations receive their own identity and
/// sequence while retaining the parent's ID for correlation.
#[derive(Debug, Clone)]
pub struct OperationCoordinator {
    operation_id: String,
    parent_operation_id: Option<String>,
    operation: String,
    target: Option<OperationTarget>,
    next_sequence: Arc<AtomicU64>,
    cancellation: Option<Arc<crate::cancellation::CancellationScope>>,
    observed_at: Instant,
    durable_activity: bool,
}

impl OperationCoordinator {
    pub fn new(operation: impl Into<String>, target: Option<OperationTarget>) -> Self {
        Self {
            operation_id: Uuid::new_v4().to_string(),
            parent_operation_id: None,
            operation: operation.into(),
            target,
            next_sequence: Arc::new(AtomicU64::new(0)),
            cancellation: None,
            observed_at: Instant::now(),
            durable_activity: false,
        }
    }

    pub fn from_activity(activity: &ActivityRecord) -> Self {
        Self {
            operation_id: activity.id.clone(),
            parent_operation_id: None,
            operation: activity.operation.to_string(),
            target: activity.target_id.as_ref().map(|id| OperationTarget {
                kind: activity.target_kind,
                id: id.clone(),
            }),
            next_sequence: Arc::new(AtomicU64::new(0)),
            cancellation: None,
            observed_at: Instant::now(),
            durable_activity: true,
        }
    }

    pub(crate) fn resume(
        operation_id: impl Into<String>,
        operation: impl Into<String>,
        target: Option<OperationTarget>,
    ) -> Self {
        Self {
            operation_id: operation_id.into(),
            parent_operation_id: None,
            operation: operation.into(),
            target,
            next_sequence: Arc::new(AtomicU64::new(0)),
            cancellation: None,
            observed_at: Instant::now(),
            durable_activity: false,
        }
    }

    pub fn child(&self, operation: impl Into<String>, target: Option<OperationTarget>) -> Self {
        Self {
            operation_id: Uuid::new_v4().to_string(),
            parent_operation_id: Some(self.operation_id.clone()),
            operation: operation.into(),
            target,
            next_sequence: Arc::new(AtomicU64::new(0)),
            cancellation: self.cancellation.clone(),
            observed_at: Instant::now(),
            durable_activity: false,
        }
    }

    pub(crate) fn cancellable(
        library: &Library,
        activity: &ActivityRecord,
        owner: &str,
    ) -> Result<Self> {
        let mut operation = Self::from_activity(activity);
        operation.cancellation = Some(Arc::new(crate::cancellation::CancellationScope::begin(
            library, activity, owner,
        )?));
        Ok(operation)
    }

    pub(crate) fn resume_cancellation(&mut self, library: &Library) -> Result<()> {
        self.cancellation = Some(Arc::new(crate::cancellation::CancellationScope::resume(
            library,
            &self.operation_id,
        )?));
        Ok(())
    }

    pub(crate) fn checkpoint(&self) -> Result<()> {
        self.cancellation
            .as_ref()
            .map_or(Ok(()), |scope| scope.checkpoint())
    }

    pub(crate) fn begin_publication(&self) -> Result<()> {
        self.cancellation
            .as_ref()
            .map_or(Ok(()), |scope| scope.begin_publication())
    }

    pub(crate) async fn interruptible<T>(
        &self,
        future: impl std::future::Future<Output = Result<T>>,
    ) -> Result<T> {
        match &self.cancellation {
            Some(scope) => scope.interruptible(future).await,
            None => future.await,
        }
    }

    pub fn operation_id(&self) -> &str {
        &self.operation_id
    }

    pub fn started(&self) -> OperationEvent {
        self.event(OperationEventKind::Started)
    }

    pub fn source_candidate(&self, candidate: &crate::SourceRecord) -> OperationEvent {
        self.event(OperationEventKind::SourceCandidate {
            profile_id: candidate.profile_id.clone(),
            path: candidate.path.clone(),
            sha256: candidate.sha256.clone(),
            size: candidate.size,
        })
    }

    pub fn progress(
        &self,
        phase: impl Into<String>,
        completed: u64,
        total: Option<u64>,
    ) -> OperationEvent {
        self.event(OperationEventKind::Progress {
            phase: phase.into(),
            completed,
            total,
        })
    }

    pub fn message(&self, level: impl Into<String>, message: impl Into<String>) -> OperationEvent {
        self.event(OperationEventKind::Message {
            level: level.into(),
            message: message.into(),
        })
    }

    pub fn finished(&self, result: OperationResult) -> OperationEvent {
        self.event(OperationEventKind::Finished { result })
    }

    pub(crate) fn observe_release(&self, release: &str, install_id: Option<&str>) {
        tracing::debug!(
            component = "operation",
            observation = "event",
            phase = "resolved",
            operation_id = self.operation_id.as_str(),
            activity_id = self.durable_activity.then_some(self.operation_id.as_str()),
            operation = self.operation.as_str(),
            release,
            install_id,
            elapsed_ms = self
                .observed_at
                .elapsed()
                .as_millis()
                .min(u128::from(u64::MAX)) as u64,
        );
    }

    pub(crate) fn observe_phase(&self, phase: &'static str) {
        tracing::debug!(
            component = "operation",
            observation = "event",
            operation_id = self.operation_id.as_str(),
            parent_operation_id = self.parent_operation_id.as_deref(),
            activity_id = self.durable_activity.then_some(self.operation_id.as_str()),
            operation = self.operation.as_str(),
            phase,
            elapsed_ms = self
                .observed_at
                .elapsed()
                .as_millis()
                .min(u128::from(u64::MAX)) as u64,
        );
    }

    fn event(&self, event: OperationEventKind) -> OperationEvent {
        let event = OperationEvent {
            schema_version: OPERATION_EVENT_SCHEMA_VERSION,
            operation_id: self.operation_id.clone(),
            parent_operation_id: self.parent_operation_id.clone(),
            sequence: self.next_sequence.fetch_add(1, Ordering::Relaxed),
            timestamp_ms: now_millis(),
            operation: self.operation.clone(),
            target: self.target.clone(),
            event,
        };
        // One instrumentation owner for Desktop and CLI. Operation events stay
        // best effort; only existing activity/outcome/capture writes own truth.
        let observation = match &event.event {
            OperationEventKind::Started => Some(("started", None)),
            OperationEventKind::Progress {
                phase,
                completed: 0,
                ..
            } => Some((phase.as_str(), None)),
            OperationEventKind::Finished { result } => Some((
                "finished",
                Some(match result {
                    OperationResult::Succeeded => "succeeded",
                    OperationResult::Failed => "failed",
                    OperationResult::Cancelled => "cancelled",
                }),
            )),
            _ => None,
        };
        if let Some((phase, result)) = observation {
            tracing::debug!(
                component = "operation",
                observation = "event",
                operation_id = event.operation_id.as_str(),
                parent_operation_id = event.parent_operation_id.as_deref(),
                activity_id = self.durable_activity.then_some(event.operation_id.as_str()),
                event_schema_version = event.schema_version,
                sequence = event.sequence,
                operation = event.operation.as_str(),
                port_id = event
                    .target
                    .as_ref()
                    .filter(|target| target.kind == crate::ActivityTargetKind::Port)
                    .map(|target| target.id.as_str()),
                phase,
                observed_result = result,
                elapsed_ms = self
                    .observed_at
                    .elapsed()
                    .as_millis()
                    .min(u128::from(u64::MAX)) as u64,
            );
        }
        event
    }
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(i64::MAX)
}

#[cfg(test)]
mod tests {
    use crate::{ActivityOperation, ActivityStatus, ActivityTargetKind};

    use super::*;

    fn activity() -> ActivityRecord {
        ActivityRecord {
            id: "durable-activity".into(),
            operation: ActivityOperation::Install,
            target_kind: ActivityTargetKind::Port,
            target_id: Some("lighthouse".into()),
            status: ActivityStatus::Running,
            message: None,
            failure: None,
            started_at: 1,
            finished_at: None,
            cancellation: None,
        }
    }

    #[test]
    fn durable_activity_identity_and_sequence_are_reused() {
        let operation = OperationCoordinator::from_activity(&activity());

        let started = operation.started();
        let progress = operation.progress("download", 4, Some(8));
        let finished = operation.finished(OperationResult::Succeeded);

        assert_eq!(started.operation_id, "durable-activity");
        assert_eq!(started.target.unwrap().id, "lighthouse");
        assert_eq!(started.sequence, 0);
        assert_eq!(progress.sequence, 1);
        assert_eq!(finished.sequence, 2);
    }

    #[test]
    fn overlapping_and_nested_operations_remain_independently_ordered() {
        let first = OperationCoordinator::new("first", None);
        let second = OperationCoordinator::new("second", None);
        let child = first.child("nested", None);

        let events = [
            second.started(),
            child.started(),
            first.started(),
            second.finished(OperationResult::Failed),
            child.finished(OperationResult::Succeeded),
            first.finished(OperationResult::Succeeded),
        ];

        assert_ne!(first.operation_id(), second.operation_id());
        assert_eq!(
            events[1].parent_operation_id.as_deref(),
            Some(first.operation_id())
        );
        assert_eq!(events[0].sequence, 0);
        assert_eq!(events[3].sequence, 1);
        assert_eq!(events[1].sequence, 0);
        assert_eq!(events[4].sequence, 1);
        assert_eq!(events[2].sequence, 0);
        assert_eq!(events[5].sequence, 1);
    }
}
