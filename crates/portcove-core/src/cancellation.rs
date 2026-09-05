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
    operation::{LifecycleOperation, LifecycleOperationKind, LifecyclePhase, OperationStore},
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
                {
                    if let Err(error) = self.request_cancellation(&activity.id) {
                        return self.finish_activity(activity, Err(error));
                    }
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
                discard_private_install(self.library(), operation)?;
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

pub(crate) fn discard_private_install(
    library: &Library,
    operation: &LifecycleOperation,
) -> Result<()> {
    if operation.kind != LifecycleOperationKind::Install
        || operation.phase != LifecyclePhase::Preparing
    {
        return Err(PortcoveError::conflict(
            "only unpublished install preparation may be discarded",
        ));
    }
    uuid::Uuid::parse_str(&operation.id)
        .map_err(|_| PortcoveError::state("invalid private operation identity"))?;
    let expected = library.staging_dir().join(&operation.id);
    if operation.paths.staging.as_ref() != Some(&expected) {
        return Err(PortcoveError::conflict(
            "private staging path does not match the operation identity",
        ));
    }
    match std::fs::symlink_metadata(&expected) {
        Ok(metadata) => {
            let staging_root = std::fs::canonicalize(library.staging_dir())?;
            if !metadata.is_dir()
                || metadata.file_type().is_symlink()
                || staging_root != std::fs::canonicalize(library.root())?.join("staging")
                || std::fs::canonicalize(&expected)?.parent() != Some(staging_root.as_path())
            {
                return Err(PortcoveError::conflict(
                    "private staging directory changed identity",
                ));
            }
            std::fs::remove_dir_all(&expected)?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    OperationStore::new(library.clone()).remove(&operation.id)
}
