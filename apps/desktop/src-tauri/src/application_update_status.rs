//! Sanitized application-update status and explicit recovery commands.
//!
//! This adapter reads host-owned cadence, staging and apply journals without
//! exposing authenticated URLs, signatures, keys or filesystem paths to React.
//! Recovery is limited to a named fixed store and proceeds only while that
//! store is still malformed or from an unsupported future schema.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::application_update::ApplicationChannel;
use crate::application_update_apply::{
    ApplicationTerminationKind, ApplicationUpdateApplyError, ApplicationUpdateApplyRequest,
    ApplicationUpdateApplyState, ApplicationUpdateApplyStore,
};
use crate::application_update_schedule::{
    ApplicationUpdateSchedule, ApplicationUpdateScheduleError, ApplicationUpdateScheduleStore,
};
use crate::application_update_staging::{
    ApplicationUpdateStagingError, ApplicationUpdateStagingStore, StagedApplicationUpdate,
};
use crate::{DesktopError, DesktopResult, blocking_worker};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum ApplicationUpdateRecoveryArea {
    Schedule,
    Staging,
    Apply,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, JsonSchema)]
pub struct ApplicationUpdateRecoveryNotice {
    pub area: ApplicationUpdateRecoveryArea,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, JsonSchema)]
pub struct ApplicationUpdateScheduleSummary {
    pub last_success_unix_seconds: Option<u64>,
    pub consecutive_failures: u32,
    pub next_automatic_check_unix_seconds: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, JsonSchema)]
pub struct ApplicationUpdateCandidateSummary {
    pub version: String,
    pub channel: ApplicationChannel,
    pub bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum ApplicationUpdateRequestedAction {
    SafeExit,
    RestartToApply,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum ApplicationUpdateObservedTermination {
    NormalExit,
    RestartToApply,
    Crash,
    OsShutdown,
    SteamStop,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, JsonSchema)]
pub struct ApplicationUpdateApplySummary {
    pub revision: u64,
    pub request: ApplicationUpdateRequestedAction,
    pub termination: Option<ApplicationUpdateObservedTermination>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, JsonSchema)]
pub struct ApplicationUpdateStatus {
    pub schedule: Option<ApplicationUpdateScheduleSummary>,
    pub staged: Option<ApplicationUpdateCandidateSummary>,
    pub apply: Option<ApplicationUpdateApplySummary>,
    pub recovery_required: Vec<ApplicationUpdateRecoveryNotice>,
}

#[derive(Clone)]
struct ApplicationUpdateStatusStores {
    schedule: ApplicationUpdateScheduleStore,
    staging: ApplicationUpdateStagingStore,
    apply: ApplicationUpdateApplyStore,
}

#[derive(Clone)]
pub(crate) struct ApplicationUpdateStatusState {
    stores: DesktopResult<ApplicationUpdateStatusStores>,
}

pub(crate) fn configured_state() -> ApplicationUpdateStatusState {
    ApplicationUpdateStatusState {
        stores: (|| {
            Ok(ApplicationUpdateStatusStores {
                schedule: ApplicationUpdateScheduleStore::open_configured()
                    .map_err(schedule_error)?,
                staging: ApplicationUpdateStagingStore::open_configured().map_err(staging_error)?,
                apply: ApplicationUpdateApplyStore::open_configured().map_err(apply_error)?,
            })
        })(),
    }
}

#[tauri::command]
pub(crate) async fn get_application_update_status(
    state: tauri::State<'_, ApplicationUpdateStatusState>,
) -> DesktopResult<ApplicationUpdateStatus> {
    let stores = state.stores.as_ref().map_err(Clone::clone)?.clone();
    load_status(stores).await
}

#[tauri::command]
pub(crate) async fn recover_application_update_state(
    state: tauri::State<'_, ApplicationUpdateStatusState>,
    area: ApplicationUpdateRecoveryArea,
) -> DesktopResult<ApplicationUpdateStatus> {
    let stores = state.stores.as_ref().map_err(Clone::clone)?.clone();
    match area {
        ApplicationUpdateRecoveryArea::Schedule => {
            let schedule = stores.schedule.clone();
            blocking_worker(move || schedule.recover_invalid().map_err(schedule_error)).await?;
        }
        ApplicationUpdateRecoveryArea::Staging => {
            stores
                .staging
                .recover_invalid()
                .await
                .map_err(staging_error)?;
        }
        ApplicationUpdateRecoveryArea::Apply => {
            let apply = stores.apply.clone();
            blocking_worker(move || apply.recover_invalid().map_err(apply_error)).await?;
        }
    }
    load_status(stores).await
}

async fn load_status(
    stores: ApplicationUpdateStatusStores,
) -> DesktopResult<ApplicationUpdateStatus> {
    let schedule_store = stores.schedule.clone();
    let apply_store = stores.apply.clone();
    let (schedule, apply, mut recovery_required) = blocking_worker(move || {
        let (schedule, schedule_recovery) = read_schedule(&schedule_store)?;
        let (apply, apply_recovery) = read_apply(&apply_store)?;
        let recovery_required: Vec<ApplicationUpdateRecoveryNotice> = schedule_recovery
            .into_iter()
            .chain(apply_recovery)
            .collect();
        Ok((schedule, apply, recovery_required))
    })
    .await?;
    let staged = match stores.staging.status().await {
        Ok(staged) => staged.as_ref().map(candidate_summary),
        Err(ApplicationUpdateStagingError::InvalidState(_))
        | Err(ApplicationUpdateStagingError::UnsupportedSchema(_)) => {
            recovery_required.push(recovery_notice(ApplicationUpdateRecoveryArea::Staging));
            None
        }
        Err(error) => return Err(staging_error(error)),
    };
    Ok(ApplicationUpdateStatus {
        schedule,
        staged,
        apply,
        recovery_required,
    })
}

fn read_schedule(
    store: &ApplicationUpdateScheduleStore,
) -> DesktopResult<(
    Option<ApplicationUpdateScheduleSummary>,
    Option<ApplicationUpdateRecoveryNotice>,
)> {
    match store.load() {
        Ok(schedule) => Ok((Some(schedule_summary(&schedule)), None)),
        Err(ApplicationUpdateScheduleError::InvalidState(_))
        | Err(ApplicationUpdateScheduleError::UnsupportedSchema(_)) => Ok((
            None,
            Some(recovery_notice(ApplicationUpdateRecoveryArea::Schedule)),
        )),
        Err(error) => Err(schedule_error(error)),
    }
}

fn read_apply(
    store: &ApplicationUpdateApplyStore,
) -> DesktopResult<(
    Option<ApplicationUpdateApplySummary>,
    Option<ApplicationUpdateRecoveryNotice>,
)> {
    match store.load() {
        Ok(state) => Ok((apply_summary(&state), None)),
        Err(ApplicationUpdateApplyError::InvalidState(_))
        | Err(ApplicationUpdateApplyError::UnsupportedSchema(_)) => Ok((
            None,
            Some(recovery_notice(ApplicationUpdateRecoveryArea::Apply)),
        )),
        Err(error) => Err(apply_error(error)),
    }
}

fn schedule_summary(schedule: &ApplicationUpdateSchedule) -> ApplicationUpdateScheduleSummary {
    ApplicationUpdateScheduleSummary {
        last_success_unix_seconds: schedule.last_success_unix_seconds,
        consecutive_failures: schedule.consecutive_failures,
        next_automatic_check_unix_seconds: schedule.next_automatic_check_unix_seconds,
    }
}

fn candidate_summary(staged: &StagedApplicationUpdate) -> ApplicationUpdateCandidateSummary {
    ApplicationUpdateCandidateSummary {
        version: staged.candidate.release.version.clone(),
        channel: staged.candidate.promotion.channel,
        bytes: staged.candidate.release.artifact.bytes,
    }
}

fn apply_summary(state: &ApplicationUpdateApplyState) -> Option<ApplicationUpdateApplySummary> {
    let intent = state.intent.as_ref()?;
    Some(ApplicationUpdateApplySummary {
        revision: state.revision,
        request: match intent.request {
            ApplicationUpdateApplyRequest::SafeExit => ApplicationUpdateRequestedAction::SafeExit,
            ApplicationUpdateApplyRequest::RestartToApply => {
                ApplicationUpdateRequestedAction::RestartToApply
            }
        },
        termination: state.termination.map(|termination| match termination {
            ApplicationTerminationKind::NormalExit => {
                ApplicationUpdateObservedTermination::NormalExit
            }
            ApplicationTerminationKind::RestartToApply => {
                ApplicationUpdateObservedTermination::RestartToApply
            }
            ApplicationTerminationKind::Crash => ApplicationUpdateObservedTermination::Crash,
            ApplicationTerminationKind::OsShutdown => {
                ApplicationUpdateObservedTermination::OsShutdown
            }
            ApplicationTerminationKind::SteamStop => {
                ApplicationUpdateObservedTermination::SteamStop
            }
        }),
    })
}

fn recovery_notice(area: ApplicationUpdateRecoveryArea) -> ApplicationUpdateRecoveryNotice {
    ApplicationUpdateRecoveryNotice { area }
}

fn schedule_error(error: ApplicationUpdateScheduleError) -> DesktopError {
    let conflict = matches!(
        error,
        ApplicationUpdateScheduleError::Busy
            | ApplicationUpdateScheduleError::RevisionConflict { .. }
    );
    let unsupported = matches!(error, ApplicationUpdateScheduleError::UnsupportedSchema(_));
    domain_error(
        if conflict {
            "Application update check history changed or is busy; refresh and try again."
        } else if unsupported {
            "Application update check history uses a newer unsupported format."
        } else {
            "Application update check history is unavailable."
        },
        conflict,
        unsupported,
    )
}

fn staging_error(error: ApplicationUpdateStagingError) -> DesktopError {
    let conflict = matches!(error, ApplicationUpdateStagingError::Busy);
    let unsupported = matches!(error, ApplicationUpdateStagingError::UnsupportedSchema(_));
    domain_error(
        if conflict {
            "Application update staging is busy; refresh and try again."
        } else if unsupported {
            "Application update staging uses a newer unsupported format."
        } else {
            "Application update staging is unavailable."
        },
        conflict,
        unsupported,
    )
}

fn apply_error(error: ApplicationUpdateApplyError) -> DesktopError {
    let conflict = matches!(
        error,
        ApplicationUpdateApplyError::Busy
            | ApplicationUpdateApplyError::RevisionConflict { .. }
            | ApplicationUpdateApplyError::IntentConflict
    );
    let unsupported = matches!(error, ApplicationUpdateApplyError::UnsupportedSchema(_));
    domain_error(
        if conflict {
            "Application update request changed or is busy; refresh and try again."
        } else if unsupported {
            "Application update request uses a newer unsupported format."
        } else {
            "Application update request is unavailable."
        },
        conflict,
        unsupported,
    )
}

fn domain_error(message: &str, conflict: bool, unsupported: bool) -> DesktopError {
    if conflict {
        portcove_core::PortcoveError::conflict(message).into()
    } else if unsupported {
        portcove_core::PortcoveError::unsupported(message).into()
    } else {
        portcove_core::PortcoveError::state(message).into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[tokio::test]
    async fn empty_status_is_idle_and_contains_no_paths() {
        let temporary = tempfile::tempdir().unwrap();
        let status = load_status(ApplicationUpdateStatusStores {
            schedule: ApplicationUpdateScheduleStore::new(temporary.path().join("schedule.json"))
                .unwrap(),
            staging: ApplicationUpdateStagingStore::new(temporary.path().join("staging")).unwrap(),
            apply: ApplicationUpdateApplyStore::new(temporary.path().join("staging")).unwrap(),
        })
        .await
        .unwrap();

        assert_eq!(status.schedule.as_ref().unwrap().consecutive_failures, 0);
        assert_eq!(status.staged, None);
        assert_eq!(status.apply, None);
        assert!(status.recovery_required.is_empty());
        let encoded = serde_json::to_string(&status).unwrap();
        let temporary_path = temporary.path().to_string_lossy();
        assert!(!encoded.contains(&*temporary_path));
        assert!(!encoded.contains("url"));
        assert!(!encoded.contains("signature"));
        assert!(!encoded.contains("payload_key"));
        assert!(!temporary.path().join("staging").exists());
    }

    #[tokio::test]
    async fn corrupt_stores_are_reported_and_repaired_only_while_invalid() {
        let temporary = tempfile::tempdir().unwrap();
        let schedule_path = temporary.path().join("schedule.json");
        let staging_root = temporary.path().join("staging");
        fs::create_dir_all(&staging_root).unwrap();
        fs::write(&schedule_path, b"not-json").unwrap();
        fs::write(staging_root.join("staging.json"), b"not-json").unwrap();
        fs::write(staging_root.join("apply.json"), b"not-json").unwrap();
        let stores = ApplicationUpdateStatusStores {
            schedule: ApplicationUpdateScheduleStore::new(schedule_path).unwrap(),
            staging: ApplicationUpdateStagingStore::new(staging_root.clone()).unwrap(),
            apply: ApplicationUpdateApplyStore::new(staging_root).unwrap(),
        };

        let status = load_status(stores.clone()).await.unwrap();
        let encoded = serde_json::to_string(&status).unwrap();
        assert!(!encoded.contains(&*temporary.path().to_string_lossy()));
        assert_eq!(
            status
                .recovery_required
                .iter()
                .map(|notice| notice.area)
                .collect::<Vec<_>>(),
            vec![
                ApplicationUpdateRecoveryArea::Schedule,
                ApplicationUpdateRecoveryArea::Apply,
                ApplicationUpdateRecoveryArea::Staging,
            ]
        );

        stores.schedule.recover_invalid().unwrap();
        stores.apply.recover_invalid().unwrap();
        stores.staging.recover_invalid().await.unwrap();
        assert!(
            load_status(stores.clone())
                .await
                .unwrap()
                .recovery_required
                .is_empty()
        );
        assert!(stores.schedule.recover_invalid().is_err());
        assert!(stores.apply.recover_invalid().is_err());
        assert!(stores.staging.recover_invalid().await.is_err());
    }

    #[test]
    fn operational_errors_do_not_expose_storage_paths() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary
            .path()
            .join("private")
            .join("application-update")
            .display()
            .to_string();
        for error in [
            schedule_error(ApplicationUpdateScheduleError::InvalidPath(path.clone())),
            staging_error(ApplicationUpdateStagingError::InvalidPath(path.clone())),
            apply_error(ApplicationUpdateApplyError::InvalidPath(path.clone())),
        ] {
            assert!(!error.message.contains(&path));
            assert!(!error.presentation.technical_message.contains(&path));
            assert!(error.details.values().all(|value| !value.contains(&path)));
        }
    }
}
