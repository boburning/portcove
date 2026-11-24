//! Unattended setup runs: standing (set up when ready) and folder setup.
//!
//! Both run one game's install batch at a time in the same background worker,
//! under one per-game time budget, and both need to know why a run stopped:
//!
//! - its time budget was spent (fair scheduling: continue on the next pass);
//! - Portcove was closed, restarted or told to stop, and settled the run first
//!   (a clean stop: never counted, continue on the next pass);
//! - the player cancelled it (recorded as cancelled, nothing else).
//!
//! An unclean stop (a crash) leaves the batch item `Running`, and only the
//! next start can tell; `recover_interrupted_setups` handles it.
//!
//! Player-started installs never come through here, so the budget never cuts
//! them. The registry is process-wide because every Desktop command, the exit
//! handler included, builds its own short-lived service.

use std::{path::PathBuf, sync::Mutex};

use super::port_intent::STANDING_SETUP_GAME_BUDGET;
use crate::{InstallBatchRecord, OperationEvent, OperationEventKind, PortcoveService, Result};

#[cfg(test)]
thread_local! {
    pub(super) static GAME_BUDGET_OVERRIDE: std::cell::Cell<Option<std::time::Duration>> =
        const { std::cell::Cell::new(None) };
}

fn game_budget() -> std::time::Duration {
    #[cfg(test)]
    if let Some(budget) = GAME_BUDGET_OVERRIDE.with(std::cell::Cell::get) {
        return budget;
    }
    STANDING_SETUP_GAME_BUDGET
}

/// Why an unattended run was asked to stop. When several asked, the stronger
/// one is kept: the player's own cancellation wins over a host stop, which
/// wins over the budget.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum UnattendedStop {
    Budget,
    Host,
    Player,
}

struct Run {
    /// This run's own key: a run is reserved before its batch exists.
    key: String,
    /// The library it belongs to.
    root: PathBuf,
    batch_id: Option<String>,
    /// The game's install activity, once its start event was seen.
    activity: Option<String>,
    stop: Option<UnattendedStop>,
}

struct Registry {
    runs: Vec<Run>,
    /// Libraries whose host is closing, restarting or was told to stop. No
    /// unattended run starts for them again in this process.
    stopping: Vec<PathBuf>,
}

/// Unattended runs active in this process, and the stop latch.
static REGISTRY: Mutex<Registry> = Mutex::new(Registry {
    runs: Vec::new(),
    stopping: Vec::new(),
});

fn with_registry<R>(change: impl FnOnce(&mut Registry) -> R) -> R {
    let mut registry = REGISTRY
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    change(&mut registry)
}

fn with_runs<R>(change: impl FnOnce(&mut Vec<Run>) -> R) -> R {
    with_registry(|registry| change(&mut registry.runs))
}

fn raise(stop: &mut Option<UnattendedStop>, to: UnattendedStop) {
    *stop = Some(stop.map_or(to, |current| current.max(to)));
}

/// A reserved unattended run. It is taken before the run's batch is created,
/// so a host stop can never fall between creating a batch and registering it.
/// Removed from the registry when the run ends, however it ends.
pub(crate) struct UnattendedReservation(String);

impl UnattendedReservation {
    fn with_run<R>(&self, read: impl FnOnce(&mut Run) -> R) -> Option<R> {
        with_runs(|runs| runs.iter_mut().find(|run| run.key == self.0).map(read))
    }

    fn attach(&self, batch_id: &str) {
        self.with_run(|run| run.batch_id = Some(batch_id.to_owned()));
    }

    /// Records a stop; returns the activity to cancel, if it already started.
    fn stop(&self, stop: UnattendedStop) -> Option<String> {
        self.with_run(|run| {
            raise(&mut run.stop, stop);
            run.activity.clone()
        })
        .flatten()
    }

    /// Learns the install activity; returns whether a stop is already pending
    /// (one asked for before the install started still applies).
    fn started(&self, activity: &str) -> bool {
        self.with_run(|run| {
            run.activity.get_or_insert_with(|| activity.to_owned());
            run.stop.is_some()
        })
        .unwrap_or(false)
    }

    fn outcome(&self) -> Option<UnattendedStop> {
        self.with_run(|run| run.stop).flatten()
    }
}

impl Drop for UnattendedReservation {
    fn drop(&mut self) {
        with_runs(|runs| runs.retain(|run| run.key != self.0));
    }
}

/// The player cancelled this activity. An unattended run it belongs to is then
/// recorded as cancelled, even if its budget or a host stop also asked.
pub(crate) fn player_cancelled_activity(activity: &str) {
    with_runs(|runs| {
        for run in runs
            .iter_mut()
            .filter(|run| run.activity.as_deref() == Some(activity))
        {
            raise(&mut run.stop, UnattendedStop::Player);
        }
    });
}

/// The player cancelled this batch.
pub(crate) fn player_cancelled_batch(batch_id: &str) {
    with_runs(|runs| {
        for run in runs
            .iter_mut()
            .filter(|run| run.batch_id.as_deref() == Some(batch_id))
        {
            raise(&mut run.stop, UnattendedStop::Player);
        }
    });
}

/// One finished unattended run.
pub(crate) struct UnattendedRun {
    pub(crate) record: InstallBatchRecord,
    /// Why it was asked to stop, if it was.
    pub(crate) stop: Option<UnattendedStop>,
}

impl UnattendedRun {
    /// The temporary failure to record for an item the run cancelled. A
    /// player's cancellation, or one from outside this process, records
    /// nothing: the choice stands and the next pass decides again.
    pub(crate) fn cancelled_as(&self) -> Option<crate::TemporaryFailure> {
        let cause = match self.stop? {
            UnattendedStop::Budget => crate::TemporaryCause::TimeBudget,
            UnattendedStop::Host => crate::TemporaryCause::CleanStop,
            UnattendedStop::Player => return None,
        };
        Some(crate::TemporaryFailure {
            cause,
            stated_reset: None,
        })
    }
}

impl PortcoveService {
    /// Reserves one unattended run, before its batch is created. `None` once
    /// this library's host is stopping: nothing new starts then.
    pub(crate) fn reserve_unattended_run(&self) -> Option<UnattendedReservation> {
        let root = self.library().root().to_path_buf();
        with_registry(|registry| {
            if registry.stopping.contains(&root) {
                return None;
            }
            let key = uuid::Uuid::new_v4().to_string();
            registry.runs.push(Run {
                key: key.clone(),
                root,
                batch_id: None,
                activity: None,
                stop: None,
            });
            Some(UnattendedReservation(key))
        })
    }

    /// Whether this library's host is stopping. Unattended passes end then.
    pub(crate) fn unattended_stopping(&self) -> bool {
        let root = self.library().root();
        with_registry(|registry| registry.stopping.iter().any(|stopping| stopping == root))
    }

    /// Runs one unattended batch under the per-game time budget. At the budget
    /// it asks the game's install to stop through ordinary cooperative
    /// cancellation, also when the install has not started yet (it is asked
    /// the moment it starts); the batch future is never dropped mid-install.
    /// Past its cancellation boundary the install finishes. `download_keys`
    /// are the partial-download entries this plan uses, kept on the batch so
    /// an unclean stop can tell whether this plan's downloads advanced.
    pub(crate) async fn run_unattended_install_batch(
        &self,
        reservation: UnattendedReservation,
        batch_id: &str,
        download_keys: Vec<String>,
        emit: &mut impl FnMut(OperationEvent),
    ) -> Result<UnattendedRun> {
        reservation.attach(batch_id);
        if !download_keys.is_empty() {
            self.library.update_install_batch(batch_id, |record| {
                for item in &mut record.items {
                    item.download_keys.clone_from(&download_keys);
                }
            })?;
        }
        // A host stop that came after the reservation and before the batch
        // was attached: record it, and the batch starts nothing.
        if reservation.outcome() == Some(UnattendedStop::Host) {
            self.mark_install_batch_clean_stop(batch_id)?;
        }
        let mut observe = |event: OperationEvent| {
            if event.parent_operation_id.is_none()
                && matches!(event.event, OperationEventKind::Started)
                && reservation.started(&event.operation_id)
            {
                self.stop_unattended_activity(&event.operation_id);
            }
            emit(event);
        };
        // Keep the batch's large async state out of the enclosing pass future.
        // Nested fresh installs exhausted Windows debug worker stacks; the
        // batch still runs serially under the same locks and cancellation.
        let mut run = Box::pin(self.run_install_batch(batch_id, &mut observe));
        let budget = tokio::time::sleep(game_budget());
        tokio::pin!(budget);
        let mut budget_spent = false;
        let record = loop {
            tokio::select! {
                record = &mut run => break record?,
                () = &mut budget, if !budget_spent => {
                    budget_spent = true;
                    if let Some(activity) = reservation.stop(UnattendedStop::Budget) {
                        self.stop_unattended_activity(&activity);
                    }
                }
            }
        };
        drop(run);
        Ok(UnattendedRun {
            record,
            stop: reservation.outcome(),
        })
    }

    fn stop_unattended_activity(&self, activity: &str) {
        if let Err(error) = self.request_activity_cancellation(activity) {
            // Past its cancellation boundary the install finishes.
            tracing::info!(operation_id = activity, error = %error.message, "unattended setup stop reached after the cancellation boundary");
        }
    }

    /// Whether this process runs any unattended setup now; lets a closing host
    /// skip opening a service when there is nothing to stop.
    pub fn unattended_setups_active() -> bool {
        with_runs(|runs| !runs.is_empty())
    }

    /// Stops this library's unattended setup cleanly, for a host that is
    /// closing, restarting or was told to stop. It first latches the stop, so
    /// no further unattended run starts for this library in this process
    /// (including the next game of a pass already under way); then each
    /// running batch durably records the clean stop, so a run the process
    /// ends before it settles is never counted as a crash on the next start;
    /// then each started install is asked to stop at its cancellation
    /// boundary. Returns how many runs were asked. Player-started installs
    /// are not touched.
    pub fn stop_unattended_setups(&self) -> usize {
        let root = self.library().root().to_path_buf();
        let runs = with_registry(|registry| {
            if !registry.stopping.contains(&root) {
                registry.stopping.push(root.clone());
            }
            registry
                .runs
                .iter_mut()
                .filter(|run| run.root == root)
                .map(|run| {
                    raise(&mut run.stop, UnattendedStop::Host);
                    (run.batch_id.clone(), run.activity.clone())
                })
                .collect::<Vec<_>>()
        });
        for (batch_id, activity) in &runs {
            if let Some(batch_id) = batch_id
                && let Err(error) = self.mark_install_batch_clean_stop(batch_id)
            {
                tracing::warn!(batch_id, error = %error.message, "could not record a clean stop for an unattended setup");
            }
            if let Some(activity) = activity {
                self.stop_unattended_activity(activity);
            }
        }
        runs.len()
    }

    /// Lifts this library's stop latch, as a new process starts without it.
    /// Tests use it to stand for a restart.
    #[cfg(test)]
    pub(crate) fn resume_unattended_setups_for_test(&self) {
        let root = self.library().root().to_path_buf();
        with_registry(|registry| registry.stopping.retain(|stopping| *stopping != root));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Library, service::tests::service_with_release};

    fn fresh_service() -> (tempfile::TempDir, PortcoveService) {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        (temporary, service_with_release(library, "v1"))
    }

    fn unattended_run(batch: &str, stop: Option<UnattendedStop>) -> UnattendedRun {
        UnattendedRun {
            record: InstallBatchRecord {
                format_version: crate::INSTALL_BATCH_FORMAT_VERSION,
                id: batch.to_owned(),
                created_at: 0,
                updated_at: 0,
                cancel_requested: false,
                items: Vec::new(),
                clean_stop_at: None,
            },
            stop,
        }
    }

    #[test]
    fn the_players_cancellation_wins_over_the_budget_and_a_host_stop() {
        let (_temporary, service) = fresh_service();
        let batch = uuid::Uuid::new_v4().to_string();
        let activity = uuid::Uuid::new_v4().to_string();
        let reserved = service.reserve_unattended_run().unwrap();
        reserved.attach(&batch);
        // A stop asked for before the install starts applies once it starts.
        assert_eq!(reserved.stop(UnattendedStop::Budget), None);
        assert!(reserved.started(&activity));
        assert_eq!(reserved.outcome(), Some(UnattendedStop::Budget));
        // The player cancels after the budget was spent: recorded as cancelled.
        player_cancelled_activity(&activity);
        assert_eq!(reserved.outcome(), Some(UnattendedStop::Player));
        // Nothing later turns it back into a budget or host stop.
        assert_eq!(reserved.stop(UnattendedStop::Host), Some(activity.clone()));
        assert_eq!(reserved.outcome(), Some(UnattendedStop::Player));
        assert_eq!(
            unattended_run(&batch, Some(UnattendedStop::Player)).cancelled_as(),
            None
        );
        assert_eq!(unattended_run(&batch, None).cancelled_as(), None);
        assert_eq!(
            unattended_run(&batch, Some(UnattendedStop::Budget))
                .cancelled_as()
                .map(|failure| failure.cause),
            Some(crate::TemporaryCause::TimeBudget)
        );
        assert_eq!(
            unattended_run(&batch, Some(UnattendedStop::Host))
                .cancelled_as()
                .map(|failure| failure.cause),
            Some(crate::TemporaryCause::CleanStop)
        );
        drop(reserved);
        assert!(with_runs(|runs| runs
            .iter()
            .all(|run| run.batch_id.as_deref() != Some(batch.as_str()))));
    }

    #[test]
    fn a_host_stop_wins_over_the_budget_and_cancelling_the_batch_is_the_players() {
        let (_temporary, service) = fresh_service();
        let batch = uuid::Uuid::new_v4().to_string();
        let reserved = service.reserve_unattended_run().unwrap();
        reserved.attach(&batch);
        reserved.stop(UnattendedStop::Budget);
        reserved.stop(UnattendedStop::Host);
        assert_eq!(reserved.outcome(), Some(UnattendedStop::Host));
        player_cancelled_batch(&batch);
        assert_eq!(reserved.outcome(), Some(UnattendedStop::Player));
    }

    #[test]
    fn a_host_stop_with_nothing_running_still_prevents_the_next_start() {
        let (_temporary, service) = fresh_service();
        let (_other_temporary, other) = fresh_service();
        // Nothing is registered: the stop still latches for this library.
        assert_eq!(service.stop_unattended_setups(), 0);
        assert!(service.unattended_stopping());
        assert!(service.reserve_unattended_run().is_none());
        // Another library in the same process is not stopped.
        assert!(!other.unattended_stopping());
        assert!(other.reserve_unattended_run().is_some());
        // A new process starts without the latch.
        service.resume_unattended_setups_for_test();
        assert!(service.reserve_unattended_run().is_some());
    }

    #[test]
    fn a_host_stop_reaches_a_run_reserved_before_its_batch_exists() {
        let (_temporary, service) = fresh_service();
        let reserved = service.reserve_unattended_run().unwrap();
        // The stop comes between the reservation and the batch.
        assert_eq!(service.stop_unattended_setups(), 1);
        assert_eq!(reserved.outcome(), Some(UnattendedStop::Host));
        service.resume_unattended_setups_for_test();
    }
}
