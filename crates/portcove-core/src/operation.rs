use std::{
    fmt,
    path::PathBuf,
    str::FromStr,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};

use rusqlite::params;
use uuid::Uuid;

use crate::{
    ActivityRecord, InstallRecord, Library, OperationEvent, OperationEventKind, OperationResult,
    OperationTarget, PortcoveError, Result, database,
};

pub const OPERATION_EVENT_SCHEMA_VERSION: u32 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LifecycleOperationKind {
    Install,
    Adopt,
    Remove,
    Restore,
    DeleteBackup,
    Activate,
}

impl fmt::Display for LifecycleOperationKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Install => "install",
            Self::Adopt => "adopt",
            Self::Remove => "remove",
            Self::Restore => "restore",
            Self::DeleteBackup => "delete_backup",
            Self::Activate => "activate",
        })
    }
}

impl FromStr for LifecycleOperationKind {
    type Err = PortcoveError;

    fn from_str(value: &str) -> Result<Self> {
        let kind = match value {
            "install" => Some(Self::Install),
            "adopt" => Some(Self::Adopt),
            "remove" => Some(Self::Remove),
            "restore" => Some(Self::Restore),
            "delete_backup" => Some(Self::DeleteBackup),
            "activate" => Some(Self::Activate),
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
        let original_paths_json = serde_json::to_string(&operation.original_paths)?;
        database::connect(self.library.root())?.execute(
            "INSERT INTO lifecycle_operations(
               id, kind, port_id, phase, staging_path, final_path, quarantine_path,
               install_json, original_paths_json, activate, last_error, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
             ON CONFLICT(id) DO UPDATE SET
               kind=excluded.kind,
               port_id=excluded.port_id,
               phase=excluded.phase,
               staging_path=excluded.staging_path,
               final_path=excluded.final_path,
               quarantine_path=excluded.quarantine_path,
               install_json=excluded.install_json,
               original_paths_json=excluded.original_paths_json,
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
                original_paths_json,
                operation.activate as i64,
                operation.last_error,
                operation.created_at,
                operation.updated_at,
            ],
        )?;
        Ok(())
    }

    pub fn remove(&self, id: &str) -> Result<()> {
        database::connect(self.library.root())?
            .execute("DELETE FROM lifecycle_operations WHERE id=?1", [id])?;
        Ok(())
    }

    pub fn all(&self) -> Result<Vec<LifecycleOperation>> {
        let connection = database::connect(self.library.root())?;
        let mut statement = connection.prepare(
            "SELECT id, kind, port_id, phase, staging_path, final_path, quarantine_path,
                    install_json, original_paths_json, activate, last_error, created_at, updated_at
             FROM lifecycle_operations
             ORDER BY created_at, rowid",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, Option<String>>(7)?,
                row.get::<_, String>(8)?,
                row.get::<_, i64>(9)?,
                row.get::<_, Option<String>>(10)?,
                row.get::<_, i64>(11)?,
                row.get::<_, i64>(12)?,
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
                original_paths_json,
                activate,
                last_error,
                created_at,
                updated_at,
            ) = row?;
            Ok(LifecycleOperation {
                id,
                kind: kind.parse()?,
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
                original_paths: serde_json::from_str(&original_paths_json)?,
                activate: activate != 0,
                last_error,
                created_at,
                updated_at,
            })
        })
        .collect()
    }
}

fn path_string(path: Option<&PathBuf>) -> Result<Option<String>> {
    path.map(|path| crate::path::unicode(path, "lifecycle"))
        .transpose()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LifecycleFaultPoint {
    SourcePrepared,
    LaunchReadyToSpawn,
    LaunchChildStarted,
    LaunchCollecting,
    InstallPrepared,
    InstallReadyToPublish,
    InstallPublished,
    InstallMetadataCommitted,
    AdoptionPrepared,
    AdoptionPublished,
    AdoptionMetadataCommitted,
    RemovalQuarantined,
    RemovalMetadataCommitted,
    RemovalCleanup,
    RestorePrepared,
    RestorePublished,
    RestoreVersionSynchronized,
    DeleteBackupPrepared,
    DeleteBackupQuarantined,
    DeleteBackupDeleting,
    DeleteBackupDeleted,
    DeleteBackupMetadataCommitted,
    ActivationMetadataCommitted,
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

    fn event(&self, event: OperationEventKind) -> OperationEvent {
        OperationEvent {
            schema_version: OPERATION_EVENT_SCHEMA_VERSION,
            operation_id: self.operation_id.clone(),
            parent_operation_id: self.parent_operation_id.clone(),
            sequence: self.next_sequence.fetch_add(1, Ordering::Relaxed),
            timestamp_ms: now_millis(),
            operation: self.operation.clone(),
            target: self.target.clone(),
            event,
        }
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
