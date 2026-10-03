//! Cooperative cancellation. SQLite serializes a request against publication admission.
#[cfg(test)]
#[path = "cancellation_tests.rs"]
mod tests;
use std::{
    future::Future,
    sync::Mutex,
    time::{Duration, Instant},
};

use rusqlite::{OptionalExtension, params};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{
    ActivityOperation, ActivityRecord, ActivityStatus, ActivityTargetKind, ErrorCode, Library,
    OperationCoordinator, PortOperationGuard, PortcoveError, PortcoveService, Result, database,
    operation::{
        LifecycleFaultInjector, LifecycleFaultPoint, LifecycleOperation, LifecycleOperationKind,
        LifecyclePhase, NoLifecycleFaults, OperationStore,
    },
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CancellationPhase {
    Preparing,
    Finishing,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct CancellationState {
    pub phase: CancellationPhase,
    pub requested: bool,
}

impl CancellationState {
    pub(crate) fn from_columns(phase: Option<String>, requested: bool) -> Result<Option<Self>> {
        phase
            .map(|value| {
                Ok(Self {
                    phase: match value.as_str() {
                        "preparing" => CancellationPhase::Preparing,
                        "finishing" => CancellationPhase::Finishing,
                        _ => return Err(PortcoveError::state("unknown cancellation phase")),
                    },
                    requested,
                })
            })
            .transpose()
    }
}

pub(crate) struct CancellationScope {
    library: Library,
    id: String,
    _guard: PortOperationGuard,
    checked: Mutex<Option<Instant>>,
}

impl std::fmt::Debug for CancellationScope {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("CancellationScope")
            .field("id", &self.id)
            .finish_non_exhaustive()
    }
}

impl CancellationScope {
    pub fn begin(library: &Library, activity: &ActivityRecord, owner: &str) -> Result<Self> {
        let guard = library.try_lock_activity(&activity.id)?;
        let changed = database::connect(library.root())?.execute(
            "UPDATE activity_history SET cancellation_phase='preparing', cancellation_owner=?2 WHERE id=?1 AND status='running' AND cancellation_phase IS NULL",
            params![activity.id, owner],
        )?;
        if changed != 1 {
            return Err(PortcoveError::conflict(
                "activity is already controlled or finished",
            ));
        }
        Ok(Self {
            library: library.clone(),
            id: activity.id.clone(),
            _guard: guard,
            checked: Mutex::new(None),
        })
    }

    pub fn checkpoint(&self) -> Result<()> {
        let mut checked = self
            .checked
            .lock()
            .map_err(|_| PortcoveError::state("cancellation clock lock poisoned"))?;
        if checked.is_some_and(|last| last.elapsed() < Duration::from_millis(50)) {
            return Ok(());
        }
        self.check_now()?;
        *checked = Some(Instant::now());
        Ok(())
    }

    fn check_now(&self) -> Result<()> {
        let state = cancellation_state(&self.library, &self.id)?;
        if state.is_some_and(|state| state.phase == CancellationPhase::Preparing && state.requested)
        {
            return Err(cancelled(&self.id));
        }
        Ok(())
    }

    pub fn begin_publication(&self) -> Result<()> {
        close_preparation(&self.library, &self.id)
    }

    /// Only use with a read-only network future, never with a spawned mutation worker.
    pub async fn interruptible<T>(&self, future: impl Future<Output = Result<T>>) -> Result<T> {
        self.check_now()?;
        tokio::pin!(future);
        loop {
            tokio::select! {
                result = &mut future => { self.check_now()?; return result; }
                _ = tokio::time::sleep(Duration::from_millis(50)) => self.check_now()?,
            }
        }
    }
}

pub(crate) fn cancellation_state(library: &Library, id: &str) -> Result<Option<CancellationState>> {
    let row = database::connect(library.root())?.query_row(
        "SELECT cancellation_phase, cancel_requested FROM activity_history WHERE id=?1 AND status='running'",
        [id], |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, bool>(1)?)),
    ).optional()?;
    match row {
        Some((phase, requested)) => CancellationState::from_columns(phase, requested),
        None => Ok(None),
    }
}

pub(crate) fn close_preparation(library: &Library, id: &str) -> Result<()> {
    let connection = database::connect(library.root())?;
    let changed = connection.execute(
        "UPDATE activity_history SET cancellation_phase='finishing' WHERE id=?1 AND status='running' AND cancellation_phase='preparing' AND cancel_requested=0",
        [id],
    )?;
    if changed == 0
        && cancellation_state(library, id)?
            .is_some_and(|state| state.phase == CancellationPhase::Preparing && state.requested)
    {
        return Err(cancelled(id));
    }
    Ok(())
}

fn cancelled(id: &str) -> PortcoveError {
    PortcoveError::new(
        ErrorCode::Cancelled,
        "Operation cancelled before publication",
    )
    .detail("operation_id", id)
}

impl PortcoveService {
    /// Host signal handlers affect only work started by this service instance.
    pub fn request_owned_cancellations(&self) -> Result<(usize, usize)> {
        self.cancellation_requested
            .store(true, std::sync::atomic::Ordering::SeqCst);
        let connection = database::connect(self.library().root())?;
        let mut statement = connection.prepare("SELECT id FROM activity_history WHERE status='running' AND cancellation_phase IS NOT NULL AND cancellation_owner=?1")?;
        let ids = statement
            .query_map([&self.cancellation_owner], |row| row.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let mut requested = 0;
        let mut finishing = 0;
        for id in ids {
            match self.request_cancellation(&id) {
                Ok(_) => requested += 1,
                Err(error) if error.code == ErrorCode::Conflict => finishing += 1,
                Err(error) => return Err(error),
            }
        }
        Ok((requested, finishing))
    }

    pub fn request_cancellation(&self, operation_id: &str) -> Result<CancellationState> {
        uuid::Uuid::parse_str(operation_id)
            .map_err(|_| PortcoveError::usage("cancellation requires an activity UUID"))?;
        let changed = database::connect(self.library().root())?.execute(
            "UPDATE activity_history SET cancel_requested=1 WHERE id=?1 AND status='running' AND cancellation_phase='preparing'",
            [operation_id],
        )?;
        if changed == 0 {
            return Err(PortcoveError::conflict(
                "This operation has finished or passed its cancellation boundary",
            )
            .detail("operation_id", operation_id));
        }
        Ok(CancellationState {
            phase: CancellationPhase::Preparing,
            requested: true,
        })
    }

    pub(crate) fn begin_cancellable_activity(
        &self,
        kind: ActivityOperation,
        target: ActivityTargetKind,
        id: Option<&str>,
    ) -> Result<(ActivityRecord, OperationCoordinator)> {
        self.begin_identified_cancellable_activity(uuid::Uuid::new_v4(), kind, target, id)
    }

    pub(crate) fn begin_identified_cancellable_activity(
        &self,
        operation_id: uuid::Uuid,
        kind: ActivityOperation,
        target: ActivityTargetKind,
        id: Option<&str>,
    ) -> Result<(ActivityRecord, OperationCoordinator)> {
        let activity = self
            .library()
            .begin_identified_activity(operation_id, kind, target, id)?;
        match OperationCoordinator::cancellable(self.library(), &activity, &self.cancellation_owner)
        {
            Ok(operation) => {
                if self
                    .cancellation_requested
                    .load(std::sync::atomic::Ordering::SeqCst)
                    && let Err(error) = self.request_cancellation(&activity.id)
                {
                    return self.finish_activity(activity, Err(error));
                }
                Ok((activity, operation))
            }
            Err(error) => self.finish_activity(activity, Err(error)),
        }
    }

    pub(crate) fn recover_cancellations(&self) -> Result<()> {
        let connection = database::connect(self.library().root())?;
        let mut statement = connection.prepare("SELECT id FROM activity_history WHERE status='running' AND cancellation_phase IS NOT NULL")?;
        let ids = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let store = OperationStore::new(self.library().clone());
        let operations = store.all()?;
        for id in ids {
            let _activity_guard = match self.library().try_lock_activity(&id) {
                Ok(guard) => guard,
                Err(error) if error.code == ErrorCode::Conflict => continue,
                Err(error) => return Err(error),
            };
            let Some(state) = cancellation_state(self.library(), &id)? else {
                continue;
            };
            if self.library().active_launch_session(&id)?.is_some() {
                // The launch state machine owns its request through process
                // recovery and exact-install collection.
                continue;
            }
            if let Some(operation) = operations.iter().find(|operation| operation.id == id) {
                // Lifecycle operations other than install own their recovery path.
                // In particular, a source import may have durable private copy state
                // while its activity is still cancellable; treating that state as an
                // install staging directory would discard it with the wrong validator.
                if operation.kind != LifecycleOperationKind::Install {
                    continue;
                }
                if operation.phase != LifecyclePhase::Preparing {
                    continue;
                }
                let _port_guard = match self
                    .library()
                    .try_lock_port(&operation.port_id, "cancel-interrupted-preparation")
                {
                    Ok(guard) => guard,
                    Err(error) if error.code == ErrorCode::Conflict => continue,
                    Err(error) => return Err(error),
                };
                let Some(current) = interrupted_install_journal(self.library(), &store, operation)?
                else {
                    continue;
                };
                match discard_private_install(self.library(), &current) {
                    Ok(()) => {}
                    Err(error)
                        if error.code == ErrorCode::Conflict
                            && error.details.get("cleanup_hold").map(String::as_str)
                                == Some("unproven_process_quiescence")
                            && error.details.get("operation_id") == Some(&id)
                            && error.details.get("recovery_action").map(String::as_str)
                                == Some("manual_review") =>
                    {
                        self.library().finish_activity_once(
                            &id,
                            ActivityStatus::Failed,
                            "PS1 preparation was interrupted; process quiescence is unproven and private work is retained for manual review",
                        )?;
                        continue;
                    }
                    Err(error) => return Err(error),
                }
            }
            let (status, message) = if state.requested {
                (
                    ActivityStatus::Cancelled,
                    "Cancelled preparation recovered after interruption",
                )
            } else {
                (
                    ActivityStatus::Failed,
                    "Worker was interrupted before recording its result; inspect library state before retrying",
                )
            };
            self.library().finish_activity_once(&id, status, message)?;
        }
        Ok(())
    }
}

// Caller holds the activity and inventoried port locks. Inventory is discovery,
// not authority to delete a journal that changed owner, phase or private paths.
fn interrupted_install_journal(
    library: &Library,
    store: &OperationStore,
    operation: &LifecycleOperation,
) -> Result<Option<LifecycleOperation>> {
    let Some(current) = store.get(&operation.id)? else {
        return Ok(None);
    };
    if current.id != operation.id
        || current.kind != operation.kind
        || current.port_id != operation.port_id
        || current.created_at != operation.created_at
        || current.phase != operation.phase
        || current.paths.staging != operation.paths.staging
        || current.paths.final_path != operation.paths.final_path
        || current.paths.quarantine != operation.paths.quarantine
        || current.install.is_some() != operation.install.is_some()
    {
        return Err(PortcoveError::verification(
            "interrupted install journal changed ownership or private state",
        )
        .detail("operation_id", &operation.id));
    }
    let activity_owns_install: bool = database::connect(library.root())?.query_row(
        "SELECT EXISTS(SELECT 1 FROM activity_history WHERE id=?1 AND status='running' AND operation IN ('install','update','reconcile') AND target_kind='port' AND target_id=?2)",
        params![operation.id, current.port_id],
        |row| row.get(0),
    )?;
    if !activity_owns_install {
        return Err(PortcoveError::verification(
            "interrupted install activity differs from its journal owner",
        )
        .detail("operation_id", &operation.id));
    }
    Ok(Some(current))
}

pub(crate) fn discard_private_install(
    library: &Library,
    operation: &LifecycleOperation,
) -> Result<()> {
    discard_private_install_with_faults(library, operation, &NoLifecycleFaults)
}

pub(crate) fn discard_private_install_with_faults(
    library: &Library,
    operation: &LifecycleOperation,
    faults: &dyn LifecycleFaultInjector,
) -> Result<()> {
    if operation.kind != LifecycleOperationKind::Install
        || !matches!(
            operation.phase,
            LifecyclePhase::Preparing | LifecyclePhase::CleanupPending
        )
        || (operation.phase == LifecyclePhase::CleanupPending && operation.install.is_some())
    {
        return Err(PortcoveError::conflict(
            "only unpublished install preparation may be discarded",
        ));
    }
    uuid::Uuid::parse_str(&operation.id)
        .map_err(|_| PortcoveError::state("invalid private operation identity"))?;
    let expected = operation.paths.staging.as_ref().ok_or_else(|| {
        PortcoveError::conflict("private staging path is missing from the operation")
    })?;
    crate::output_root::validate_staging_path(
        library,
        &operation.port_id,
        &operation.id,
        expected,
    )?;
    let staging_exists = match std::fs::symlink_metadata(expected) {
        Ok(metadata) => {
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                return Err(PortcoveError::conflict(
                    "private staging directory changed identity",
                ));
            }
            true
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(error.into()),
    };
    // The existing field also tracks managed PS1 Install workers. Unknown
    // process ownership retains both the private tree and journal, even when
    // the path is currently absent. Legacy/non-managed None keeps its contract.
    if operation.preparation_process_quiesced == Some(false) {
        if operation.install.is_some() {
            return Err(PortcoveError::conflict(
                "tracked private builder operation contains publication metadata",
            )
            .detail("operation_id", &operation.id));
        }
        return Err(PortcoveError::conflict(
            "private builder process quiescence is unproven; cleanup requires review",
        )
        .detail("operation_id", &operation.id)
        .detail("cleanup_hold", "unproven_process_quiescence")
        .detail("recovery_action", "manual_review"));
    }
    if staging_exists {
        faults.check(LifecycleFaultPoint::InstallPrivateCleanup)?;
        std::fs::remove_dir_all(expected)?;
    }
    faults.check(LifecycleFaultPoint::InstallPrivateCleanupJournalRemoval)?;
    OperationStore::new(library.clone()).remove(&operation.id)
}

#[cfg(test)]
mod managed_builder_tests {
    use super::*;
    use std::fs;

    fn fixture(
        activity_kind: ActivityOperation,
        phase: LifecyclePhase,
        quiesced: Option<bool>,
    ) -> (
        tempfile::TempDir,
        PortcoveService,
        OperationCoordinator,
        LifecycleOperation,
    ) {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let service = PortcoveService::new(library).unwrap();
        let (activity, operation) = service
            .begin_cancellable_activity(activity_kind, ActivityTargetKind::Port, Some("sample"))
            .unwrap();
        let mut journal =
            LifecycleOperation::new(&activity.id, LifecycleOperationKind::Install, "sample");
        journal.phase = phase;
        journal.preparation_process_quiesced = quiesced;
        let staging = service.library().staging_dir().join(&activity.id);
        fs::create_dir_all(&staging).unwrap();
        fs::write(staging.join("owned-private"), b"retained builder input").unwrap();
        journal.paths.staging = Some(staging);
        OperationStore::new(service.library().clone())
            .put(&mut journal)
            .unwrap();
        (temporary, service, operation, journal)
    }

    #[test]
    fn interrupted_builder_checks_fresh_journal_and_activity_ownership() {
        for changed_field in [
            "owner",
            "created",
            "phase",
            "staging",
            "final",
            "quarantine",
            "kind",
        ] {
            let (_temporary, service, _operation, original) = fixture(
                ActivityOperation::Install,
                LifecyclePhase::Preparing,
                Some(false),
            );
            let _port = service
                .library()
                .try_lock_port("sample", "owned-recovery-test")
                .unwrap();
            let store = OperationStore::new(service.library().clone());
            let mut changed = original.clone();
            match changed_field {
                "owner" => changed.port_id = "different-owner".into(),
                "created" => changed.created_at += 1,
                "phase" => changed.phase = LifecyclePhase::Prepared,
                "staging" => {
                    changed.paths.staging = Some(service.library().staging_dir().join("changed"))
                }
                "final" => {
                    changed.paths.final_path =
                        Some(service.library().versions_dir().join("changed"))
                }
                "quarantine" => {
                    changed.paths.quarantine =
                        Some(service.library().staging_dir().join("changed-quarantine"))
                }
                "kind" => changed.kind = LifecycleOperationKind::Prepare,
                _ => unreachable!(),
            }
            if changed_field == "created" {
                // Upsert preserves created_at. Reinsert the owned row to
                // simulate identifier reuse, rather than an ineffective update.
                store.remove(&original.id).unwrap();
            }
            store.put(&mut changed).unwrap();
            assert_eq!(
                interrupted_install_journal(service.library(), &store, &original)
                    .unwrap_err()
                    .code,
                ErrorCode::Verification
            );
            assert!(
                original
                    .paths
                    .staging
                    .as_ref()
                    .unwrap()
                    .join("owned-private")
                    .is_file()
            );
            assert!(store.get(&original.id).unwrap().is_some());
        }
        for wrong_activity in ["port", "operation"] {
            let (_temporary, service, _operation, journal) = fixture(
                ActivityOperation::Install,
                LifecyclePhase::Preparing,
                Some(false),
            );
            let _port = service
                .library()
                .try_lock_port("sample", "owned-recovery-test")
                .unwrap();
            let sql = if wrong_activity == "port" {
                "UPDATE activity_history SET target_id='different-port' WHERE id=?1"
            } else {
                "UPDATE activity_history SET operation='register-source' WHERE id=?1"
            };
            database::connect(service.library().root())
                .unwrap()
                .execute(sql, [&journal.id])
                .unwrap();
            let store = OperationStore::new(service.library().clone());
            let error =
                interrupted_install_journal(service.library(), &store, &journal).unwrap_err();
            assert_eq!(error.code, ErrorCode::Verification);
            assert!(!error.details.contains_key("cleanup_hold"));
            assert!(journal.paths.staging.as_ref().unwrap().is_dir());
        }
    }

    #[test]
    fn interrupted_builder_uses_current_proof_and_skips_retired_journal() {
        let (_temporary, service, _operation, original) = fixture(
            ActivityOperation::Install,
            LifecyclePhase::Preparing,
            Some(false),
        );
        let _port = service
            .library()
            .try_lock_port("sample", "owned-recovery-test")
            .unwrap();
        let store = OperationStore::new(service.library().clone());
        let mut completed = original.clone();
        completed.preparation_process_quiesced = Some(true);
        store.put(&mut completed).unwrap();
        let fresh = interrupted_install_journal(service.library(), &store, &original)
            .unwrap()
            .unwrap();
        assert_eq!(fresh.preparation_process_quiesced, Some(true));
        store.remove(&original.id).unwrap();
        assert!(
            interrupted_install_journal(service.library(), &store, &original)
                .unwrap()
                .is_none()
        );
        assert!(original.paths.staging.as_ref().unwrap().is_dir());
    }

    #[test]
    fn tracked_builder_publication_metadata_is_a_hard_envelope_error() {
        let (_temporary, service, _operation, mut journal) = fixture(
            ActivityOperation::Install,
            LifecyclePhase::Preparing,
            Some(false),
        );
        journal.install = Some(crate::InstallRecord {
            id: "owned-install".into(),
            port_id: "sample".into(),
            version: "v1".into(),
            path: service.library().versions_dir().join("sample"),
            channel: crate::ReleaseChannel::Stable,
            installed_at: 1,
            verified: true,
            staged: true,
            artifact: crate::ArtifactIdentity {
                asset_name: "owned.zip".into(),
                sha256: "a".repeat(64),
                size: 1,
            },
            runtime: None,
            manifest_sha256: "b".repeat(64),
            selected_executable: "owned.exe".into(),
        });
        let error = discard_private_install(service.library(), &journal).unwrap_err();
        assert_eq!(error.code, ErrorCode::Conflict);
        assert!(!error.details.contains_key("cleanup_hold"));
        assert!(
            journal
                .paths
                .staging
                .as_ref()
                .unwrap()
                .join("owned-private")
                .is_file()
        );
        assert!(
            OperationStore::new(service.library().clone())
                .get(&journal.id)
                .unwrap()
                .is_some()
        );
    }

    #[cfg(unix)]
    #[test]
    fn tracked_builder_symlink_error_preserves_external_tree_and_journal() {
        let (temporary, service, _operation, journal) = fixture(
            ActivityOperation::Install,
            LifecyclePhase::Preparing,
            Some(false),
        );
        let external = temporary.path().join("external");
        fs::create_dir(&external).unwrap();
        fs::write(external.join("sentinel"), b"external bytes").unwrap();
        let staging = journal.paths.staging.as_ref().unwrap();
        fs::remove_dir_all(staging).unwrap();
        std::os::unix::fs::symlink(&external, staging).unwrap();
        let error = discard_private_install(service.library(), &journal).unwrap_err();
        assert!(!error.details.contains_key("cleanup_hold"));
        assert_eq!(
            fs::read(external.join("sentinel")).unwrap(),
            b"external bytes"
        );
        assert!(
            OperationStore::new(service.library().clone())
                .get(&journal.id)
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn unproven_builder_retains_tree_and_journal_even_when_staging_is_absent() {
        for exists in [true, false] {
            let (_temporary, service, _operation, journal) = fixture(
                ActivityOperation::Install,
                LifecyclePhase::Preparing,
                Some(false),
            );
            let staging = journal.paths.staging.as_ref().unwrap();
            if !exists {
                fs::remove_dir_all(staging).unwrap();
            }
            let error = discard_private_install(service.library(), &journal).unwrap_err();
            assert_eq!(error.code, ErrorCode::Conflict);
            assert_eq!(
                error.details.get("cleanup_hold").map(String::as_str),
                Some("unproven_process_quiescence")
            );
            assert_eq!(staging.exists(), exists);
            assert_eq!(
                OperationStore::new(service.library().clone())
                    .get(&journal.id)
                    .unwrap()
                    .unwrap()
                    .preparation_process_quiesced,
                Some(false)
            );
        }
    }

    #[test]
    fn interrupted_builder_retains_work_for_install_update_and_reconcile() {
        for kind in [
            ActivityOperation::Install,
            ActivityOperation::Update,
            ActivityOperation::Reconcile,
        ] {
            for requested in [false, true] {
                let (_temporary, service, operation, journal) =
                    fixture(kind, LifecyclePhase::Preparing, Some(false));
                if requested {
                    service.request_cancellation(&journal.id).unwrap();
                }
                drop(operation);
                let recovered = PortcoveService::new(service.library().clone()).unwrap();
                assert!(
                    journal
                        .paths
                        .staging
                        .as_ref()
                        .unwrap()
                        .join("owned-private")
                        .is_file()
                );
                let retained = OperationStore::new(recovered.library().clone())
                    .get(&journal.id)
                    .unwrap()
                    .unwrap();
                assert_eq!(retained.preparation_process_quiesced, Some(false));
                let activities = recovered.library().activities(1).unwrap();
                assert_eq!(activities[0].operation, kind);
                assert_eq!(activities[0].status, ActivityStatus::Failed);
                assert!(
                    activities[0]
                        .message
                        .as_deref()
                        .unwrap()
                        .contains("retained for manual review")
                );
            }
        }
    }

    #[test]
    fn failed_builder_cleanup_pending_stays_retained_across_restarts() {
        let (_temporary, service, operation, journal) = fixture(
            ActivityOperation::Install,
            LifecyclePhase::CleanupPending,
            Some(false),
        );
        drop(operation);
        let first = PortcoveService::new(service.library().clone()).unwrap();
        let store = OperationStore::new(first.library().clone());
        let retained = store.get(&journal.id).unwrap().unwrap();
        assert!(
            journal
                .paths
                .staging
                .as_ref()
                .unwrap()
                .join("owned-private")
                .is_file()
        );
        let message = retained.last_error.unwrap();
        assert!(message.contains("quiescence"));
        let second = PortcoveService::new(first.library().clone()).unwrap();
        let retained_again = OperationStore::new(second.library().clone())
            .get(&journal.id)
            .unwrap()
            .unwrap();
        assert_eq!(retained_again.last_error.as_deref(), Some(message.as_str()));
        assert_eq!(retained_again.preparation_process_quiesced, Some(false));
        assert!(journal.paths.staging.as_ref().unwrap().is_dir());
    }

    #[test]
    fn proven_and_legacy_install_cleanup_keep_their_contract() {
        for quiesced in [None, Some(true)] {
            for kind in [
                ActivityOperation::Install,
                ActivityOperation::Update,
                ActivityOperation::Reconcile,
            ] {
                let (_temporary, service, operation, journal) =
                    fixture(kind, LifecyclePhase::Preparing, quiesced);
                service.request_cancellation(&journal.id).unwrap();
                drop(operation);
                let recovered = PortcoveService::new(service.library().clone()).unwrap();
                assert!(!journal.paths.staging.as_ref().unwrap().exists());
                assert!(
                    OperationStore::new(recovered.library().clone())
                        .get(&journal.id)
                        .unwrap()
                        .is_none()
                );
                assert_eq!(
                    recovered.library().activities(1).unwrap()[0].status,
                    ActivityStatus::Cancelled
                );
            }
        }
    }

    #[test]
    fn private_builder_validation_errors_never_become_quiescence_holds() {
        let (temporary, service, _operation, journal) = fixture(
            ActivityOperation::Install,
            LifecyclePhase::Preparing,
            Some(false),
        );
        let external = temporary.path().join("external");
        fs::create_dir(&external).unwrap();
        fs::write(external.join("sentinel"), b"external bytes").unwrap();
        for invalid in ["kind", "uuid", "path", "phase", "file"] {
            let mut changed = journal.clone();
            match invalid {
                "kind" => changed.kind = LifecycleOperationKind::Prepare,
                "uuid" => changed.id = "invalid identity".into(),
                "path" => changed.paths.staging = Some(external.clone()),
                "phase" => changed.phase = LifecyclePhase::Prepared,
                "file" => {
                    let staging = changed.paths.staging.as_ref().unwrap();
                    fs::remove_dir_all(staging).unwrap();
                    fs::write(staging, b"changed object").unwrap();
                }
                _ => unreachable!(),
            }
            let error = discard_private_install(service.library(), &changed).unwrap_err();
            assert!(!error.details.contains_key("cleanup_hold"), "{invalid}");
            assert!(
                OperationStore::new(service.library().clone())
                    .get(&journal.id)
                    .unwrap()
                    .is_some()
            );
            assert_eq!(
                fs::read(external.join("sentinel")).unwrap(),
                b"external bytes"
            );
        }
    }
}
