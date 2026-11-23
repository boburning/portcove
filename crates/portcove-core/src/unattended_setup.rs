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

use std::sync::Mutex;

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
    batch_id: String,
    /// The game's install activity, once its start event was seen.
    activity: Option<String>,
    stop: Option<UnattendedStop>,
}

/// Unattended runs active in this process.
static RUNS: Mutex<Vec<Run>> = Mutex::new(Vec::new());

fn with_runs<R>(change: impl FnOnce(&mut Vec<Run>) -> R) -> R {
    let mut runs = RUNS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    change(&mut runs)
}

fn raise(stop: &mut Option<UnattendedStop>, to: UnattendedStop) {
    *stop = Some(stop.map_or(to, |current| current.max(to)));
}

/// Removes the run from the registry when the run ends, however it ends.
struct Registered<'a>(&'a str);

impl<'a> Registered<'a> {
    fn new(batch_id: &'a str) -> Self {
        with_runs(|runs| {
            runs.retain(|run| run.batch_id != batch_id);
            runs.push(Run {
                batch_id: batch_id.to_owned(),
                activity: None,
                stop: None,
            });
        });
        Self(batch_id)
    }

    /// Records a stop; returns the activity to cancel, if it already started.
    fn stop(&self, stop: UnattendedStop) -> Option<String> {
        with_runs(|runs| {
            let run = runs.iter_mut().find(|run| run.batch_id == self.0)?;
            raise(&mut run.stop, stop);
            run.activity.clone()
        })
    }

    /// Learns the install activity; returns whether a stop is already pending
    /// (one asked for before the install started still applies).
    fn started(&self, activity: &str) -> bool {
        with_runs(|runs| {
            runs.iter_mut()
                .find(|run| run.batch_id == self.0)
                .is_some_and(|run| {
                    run.activity.get_or_insert_with(|| activity.to_owned());
                    run.stop.is_some()
                })
        })
    }

    fn outcome(&self) -> Option<UnattendedStop> {
        with_runs(|runs| {
            runs.iter()
                .find(|run| run.batch_id == self.0)
                .and_then(|run| run.stop)
        })
    }
}

impl Drop for Registered<'_> {
    fn drop(&mut self) {
        with_runs(|runs| runs.retain(|run| run.batch_id != self.0));
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
        for run in runs.iter_mut().filter(|run| run.batch_id == batch_id) {
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
    /// Runs one unattended batch under the per-game time budget. At the budget
    /// it asks the game's install to stop through ordinary cooperative
    /// cancellation, also when the install has not started yet (it is asked
    /// the moment it starts); the batch future is never dropped mid-install.
    /// Past its cancellation boundary the install finishes.
    pub(crate) async fn run_unattended_install_batch(
        &self,
        batch_id: &str,
        emit: &mut impl FnMut(OperationEvent),
    ) -> Result<UnattendedRun> {
        let registered = Registered::new(batch_id);
        let mut observe = |event: OperationEvent| {
            if event.parent_operation_id.is_none()
                && matches!(event.event, OperationEventKind::Started)
                && registered.started(&event.operation_id)
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
                    if let Some(activity) = registered.stop(UnattendedStop::Budget) {
                        self.stop_unattended_activity(&activity);
                    }
                }
            }
        };
        drop(run);
        Ok(UnattendedRun {
            record,
            stop: registered.outcome(),
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

    /// Stops this process's unattended setup runs cleanly, for a host that is
    /// closing, restarting or was told to stop. Each run's batch durably
    /// records the clean stop first, so a run the process ends before it
    /// settles is never counted as a crash on the next start; then each
    /// started install is asked to stop at its cancellation boundary. Returns
    /// how many runs were asked. Player-started installs are not touched.
    pub fn stop_unattended_setups(&self) -> usize {
        let runs = with_runs(|runs| {
            runs.iter_mut()
                .map(|run| {
                    raise(&mut run.stop, UnattendedStop::Host);
                    (run.batch_id.clone(), run.activity.clone())
                })
                .collect::<Vec<_>>()
        });
        for (batch_id, activity) in &runs {
            if let Err(error) = self.mark_install_batch_clean_stop(batch_id) {
                tracing::warn!(batch_id, error = %error.message, "could not record a clean stop for an unattended setup");
            }
            if let Some(activity) = activity {
                self.stop_unattended_activity(activity);
            }
        }
        runs.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_players_cancellation_wins_over_the_budget_and_a_host_stop() {
        let batch = uuid::Uuid::new_v4().to_string();
        let activity = uuid::Uuid::new_v4().to_string();
        let registered = Registered::new(&batch);
        // A stop asked for before the install starts applies once it starts.
        assert_eq!(registered.stop(UnattendedStop::Budget), None);
        assert!(registered.started(&activity));
        assert_eq!(registered.outcome(), Some(UnattendedStop::Budget));
        // The player cancels after the budget was spent: recorded as cancelled.
        player_cancelled_activity(&activity);
        assert_eq!(registered.outcome(), Some(UnattendedStop::Player));
        // Nothing later turns it back into a budget or host stop.
        assert_eq!(
            registered.stop(UnattendedStop::Host),
            Some(activity.clone())
        );
        assert_eq!(registered.outcome(), Some(UnattendedStop::Player));
        let run = |stop| UnattendedRun {
            record: InstallBatchRecord {
                format_version: crate::INSTALL_BATCH_FORMAT_VERSION,
                id: batch.clone(),
                created_at: 0,
                updated_at: 0,
                cancel_requested: false,
                items: Vec::new(),
                clean_stop_at: None,
            },
            stop,
        };
        assert_eq!(run(Some(UnattendedStop::Player)).cancelled_as(), None);
        assert_eq!(run(None).cancelled_as(), None);
        assert_eq!(
            run(Some(UnattendedStop::Budget))
                .cancelled_as()
                .map(|failure| failure.cause),
            Some(crate::TemporaryCause::TimeBudget)
        );
        assert_eq!(
            run(Some(UnattendedStop::Host))
                .cancelled_as()
                .map(|failure| failure.cause),
            Some(crate::TemporaryCause::CleanStop)
        );
        drop(registered);
        assert!(with_runs(|runs| runs
            .iter()
            .all(|run| run.batch_id != batch)));
    }

    #[test]
    fn a_host_stop_wins_over_the_budget_and_cancelling_the_batch_is_the_players() {
        let batch = uuid::Uuid::new_v4().to_string();
        let registered = Registered::new(&batch);
        registered.stop(UnattendedStop::Budget);
        registered.stop(UnattendedStop::Host);
        assert_eq!(registered.outcome(), Some(UnattendedStop::Host));
        player_cancelled_batch(&batch);
        assert_eq!(registered.outcome(), Some(UnattendedStop::Player));
    }
}
