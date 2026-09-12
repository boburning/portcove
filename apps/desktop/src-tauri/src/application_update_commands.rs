//! Fixed desktop commands for host-owned application-update checks.
//!
//! React may request or cancel a check and observe sanitized phases/results. It
//! cannot provide repository locations, trust roots, installed identity,
//! signatures, payload keys, or filesystem paths.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use schemars::JsonSchema;
use serde::Serialize;
use tokio_util::sync::CancellationToken;

use crate::application_update::ApplicationUpdateCandidateSummary;
use crate::application_update_coordinator::{
    ApplicationUpdateCheckEnvironment, ApplicationUpdateCoordinator,
    ApplicationUpdateCoordinatorError,
};
use crate::application_update_download::PayloadDownloadError;
use crate::application_update_host::{
    ApplicationUpdateHostConfigurationError, ApplicationUpdateHostProvider,
};
use crate::application_update_operation::{
    ApplicationUpdateOperation, ApplicationUpdateOperationError, ApplicationUpdateOperationOutcome,
    ApplicationUpdateOperationPhase, ApplicationUpdateProgressSink,
    ApplicationUpdateSelectionSummary, GithubApplicationUpdatePayloadSource,
};
use crate::application_update_repository::{CandidateLoadError, CandidateLoadFailureKind};
use crate::application_update_schedule::{
    ApplicationUpdateCheckDecision, ApplicationUpdateCheckHold, ApplicationUpdateCheckRequest,
    MeteredConnection, NetworkAvailability,
};
use crate::application_update_staging::{
    ApplicationUpdateStagingError, ApplicationUpdateStagingStore,
};
use crate::{DesktopError, DesktopResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum ApplicationUpdateCheckPhase {
    Checking,
    AcquiringAndVerifying,
    Staged,
    Complete,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum ApplicationUpdateCheckResultKind {
    ConsentRequired,
    Paused,
    ManualMode,
    Offline,
    Metered,
    MeteredStateUnknown,
    StartupDelay,
    Cadence,
    Superseded,
    Current,
    UpdateAvailable,
    Held,
    Incompatible,
    NoCandidate,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, JsonSchema)]
pub struct ApplicationUpdateCheckResult {
    pub kind: ApplicationUpdateCheckResultKind,
    pub candidate: Option<ApplicationUpdateCandidateSummary>,
    pub reasons: Vec<String>,
    pub staged: bool,
}

#[async_trait]
trait ApplicationUpdateCommandRunner: Send + Sync {
    async fn run(
        &self,
        progress: &dyn ApplicationUpdateProgressSink,
        cancellation: &CancellationToken,
    ) -> Result<ApplicationUpdateOperationOutcome, ApplicationUpdateOperationError>;
}

struct ConfiguredApplicationUpdateCommandRunner {
    operation: ApplicationUpdateOperation,
    provider: ApplicationUpdateHostProvider,
}

#[async_trait]
impl ApplicationUpdateCommandRunner for ConfiguredApplicationUpdateCommandRunner {
    async fn run(
        &self,
        progress: &dyn ApplicationUpdateProgressSink,
        cancellation: &CancellationToken,
    ) -> Result<ApplicationUpdateOperationOutcome, ApplicationUpdateOperationError> {
        self.operation
            .check_and_stage(
                ApplicationUpdateCheckEnvironment {
                    request: ApplicationUpdateCheckRequest::Manual,
                    startup_unix_seconds: 0,
                    network: NetworkAvailability::Unknown,
                    metered: MeteredConnection::Unknown,
                },
                &self.provider,
                &GithubApplicationUpdatePayloadSource,
                progress,
                cancellation,
            )
            .await
    }
}

#[derive(Clone)]
pub(crate) struct ApplicationUpdateCommandState {
    runner: DesktopResult<Option<Arc<dyn ApplicationUpdateCommandRunner>>>,
    active: Arc<Mutex<Option<CancellationToken>>>,
}

pub(crate) fn configured_state() -> ApplicationUpdateCommandState {
    ApplicationUpdateCommandState {
        runner: configure_runner(),
        active: Arc::new(Mutex::new(None)),
    }
}

fn configure_runner() -> DesktopResult<Option<Arc<dyn ApplicationUpdateCommandRunner>>> {
    let Some(provider) = ApplicationUpdateHostProvider::compiled().map_err(configuration_error)?
    else {
        return Ok(None);
    };
    let coordinator = ApplicationUpdateCoordinator::open_configured().map_err(coordinator_error)?;
    let staging = ApplicationUpdateStagingStore::open_configured().map_err(staging_error)?;
    Ok(Some(Arc::new(ConfiguredApplicationUpdateCommandRunner {
        operation: ApplicationUpdateOperation::new(coordinator, staging),
        provider,
    })))
}

struct ActiveApplicationUpdateCheck {
    active: Arc<Mutex<Option<CancellationToken>>>,
}

impl Drop for ActiveApplicationUpdateCheck {
    fn drop(&mut self) {
        if let Ok(mut active) = self.active.lock() {
            *active = None;
        }
    }
}

impl ApplicationUpdateCommandState {
    fn begin(
        &self,
    ) -> DesktopResult<(
        Arc<dyn ApplicationUpdateCommandRunner>,
        CancellationToken,
        ActiveApplicationUpdateCheck,
    )> {
        let runner = self
            .runner
            .as_ref()
            .map_err(Clone::clone)?
            .clone()
            .ok_or_else(|| {
                DesktopError::from(portcove_core::PortcoveError::unsupported(
                    "Application update checking is not configured in this build.",
                ))
            })?;
        let mut active = self.active.lock().map_err(|_| {
            DesktopError::from(portcove_core::PortcoveError::state(
                "Application update check state is unavailable.",
            ))
        })?;
        if active.is_some() {
            return Err(portcove_core::PortcoveError::conflict(
                "An application update check is already active.",
            )
            .into());
        }
        let cancellation = CancellationToken::new();
        *active = Some(cancellation.clone());
        Ok((
            runner,
            cancellation,
            ActiveApplicationUpdateCheck {
                active: self.active.clone(),
            },
        ))
    }

    fn cancel(&self) -> DesktopResult<bool> {
        let active = self.active.lock().map_err(|_| {
            DesktopError::from(portcove_core::PortcoveError::state(
                "Application update check state is unavailable.",
            ))
        })?;
        let Some(cancellation) = active.as_ref() else {
            return Ok(false);
        };
        cancellation.cancel();
        Ok(true)
    }
}

struct ChannelProgress(tauri::ipc::Channel<ApplicationUpdateCheckPhase>);

impl ApplicationUpdateProgressSink for ChannelProgress {
    fn emit(&self, phase: ApplicationUpdateOperationPhase) {
        let phase = match phase {
            ApplicationUpdateOperationPhase::Checking => ApplicationUpdateCheckPhase::Checking,
            ApplicationUpdateOperationPhase::AcquiringAndVerifying => {
                ApplicationUpdateCheckPhase::AcquiringAndVerifying
            }
            ApplicationUpdateOperationPhase::Staged => ApplicationUpdateCheckPhase::Staged,
            ApplicationUpdateOperationPhase::Complete => ApplicationUpdateCheckPhase::Complete,
        };
        let _ = self.0.send(phase);
    }
}

#[tauri::command]
pub(crate) async fn check_application_update(
    state: tauri::State<'_, ApplicationUpdateCommandState>,
    on_event: tauri::ipc::Channel<ApplicationUpdateCheckPhase>,
) -> DesktopResult<ApplicationUpdateCheckResult> {
    run_check(state.inner(), &ChannelProgress(on_event)).await
}

async fn run_check(
    state: &ApplicationUpdateCommandState,
    progress: &dyn ApplicationUpdateProgressSink,
) -> DesktopResult<ApplicationUpdateCheckResult> {
    let (runner, cancellation, _active) = state.begin()?;
    runner
        .run(progress, &cancellation)
        .await
        .map(result_from_outcome)
        .map_err(operation_error)
}

#[tauri::command]
pub(crate) fn cancel_application_update_check(
    state: tauri::State<'_, ApplicationUpdateCommandState>,
) -> DesktopResult<bool> {
    state.cancel()
}

fn result_from_outcome(outcome: ApplicationUpdateOperationOutcome) -> ApplicationUpdateCheckResult {
    match outcome {
        ApplicationUpdateOperationOutcome::Held(decision) => ApplicationUpdateCheckResult {
            kind: match decision {
                ApplicationUpdateCheckDecision::CheckNow => {
                    unreachable!("a completed check cannot be pending")
                }
                ApplicationUpdateCheckDecision::Hold { reason, .. } => match reason {
                    ApplicationUpdateCheckHold::ConsentRequired => {
                        ApplicationUpdateCheckResultKind::ConsentRequired
                    }
                    ApplicationUpdateCheckHold::Paused => ApplicationUpdateCheckResultKind::Paused,
                    ApplicationUpdateCheckHold::ManualMode => {
                        ApplicationUpdateCheckResultKind::ManualMode
                    }
                    ApplicationUpdateCheckHold::Offline => {
                        ApplicationUpdateCheckResultKind::Offline
                    }
                    ApplicationUpdateCheckHold::Metered => {
                        ApplicationUpdateCheckResultKind::Metered
                    }
                    ApplicationUpdateCheckHold::MeteredStateUnknown => {
                        ApplicationUpdateCheckResultKind::MeteredStateUnknown
                    }
                    ApplicationUpdateCheckHold::StartupDelay => {
                        ApplicationUpdateCheckResultKind::StartupDelay
                    }
                    ApplicationUpdateCheckHold::Cadence => {
                        ApplicationUpdateCheckResultKind::Cadence
                    }
                },
            },
            candidate: None,
            reasons: Vec::new(),
            staged: false,
        },
        ApplicationUpdateOperationOutcome::Superseded { .. } => ApplicationUpdateCheckResult {
            kind: ApplicationUpdateCheckResultKind::Superseded,
            candidate: None,
            reasons: Vec::new(),
            staged: false,
        },
        ApplicationUpdateOperationOutcome::Checked {
            selection, staged, ..
        } => result_from_selection(selection, staged),
    }
}

fn result_from_selection(
    selection: ApplicationUpdateSelectionSummary,
    staged: bool,
) -> ApplicationUpdateCheckResult {
    use crate::application_update::CandidateState;
    ApplicationUpdateCheckResult {
        kind: match selection.state {
            CandidateState::UpdateAvailable => ApplicationUpdateCheckResultKind::UpdateAvailable,
            CandidateState::Current => ApplicationUpdateCheckResultKind::Current,
            CandidateState::Held => ApplicationUpdateCheckResultKind::Held,
            CandidateState::Incompatible => ApplicationUpdateCheckResultKind::Incompatible,
            CandidateState::NoCandidate => ApplicationUpdateCheckResultKind::NoCandidate,
        },
        candidate: selection.candidate,
        reasons: selection.reasons,
        staged,
    }
}

fn configuration_error(_error: ApplicationUpdateHostConfigurationError) -> DesktopError {
    portcove_core::PortcoveError::state(
        "Application update configuration is unavailable. Reinstall Portcove or use the documented manual recovery path.",
    )
    .into()
}

fn coordinator_error(error: ApplicationUpdateCoordinatorError) -> DesktopError {
    match error {
        ApplicationUpdateCoordinatorError::Busy
        | ApplicationUpdateCoordinatorError::Preferences(
            crate::application_update_preferences::ApplicationUpdatePreferenceError::Busy
            | crate::application_update_preferences::ApplicationUpdatePreferenceError::RevisionConflict { .. },
        )
        | ApplicationUpdateCoordinatorError::Schedule(
            crate::application_update_schedule::ApplicationUpdateScheduleError::Busy
            | crate::application_update_schedule::ApplicationUpdateScheduleError::RevisionConflict { .. },
        ) => portcove_core::PortcoveError::conflict(
            "Application update state changed or another check is active. Refresh and try again.",
        )
        .into(),
        ApplicationUpdateCoordinatorError::Check {
            source: CandidateLoadError::InstalledContext(_),
            ..
        } => portcove_core::PortcoveError::unsupported(
            "This Portcove installation is not eligible for application updates. Reinstall with a supported package or use the documented manual recovery path.",
        )
        .into(),
        ApplicationUpdateCoordinatorError::Check { failure, .. } => match failure {
            CandidateLoadFailureKind::Unreachable => portcove_core::PortcoveError::network(
                "The application update service could not be reached. Check the connection and try again.",
            )
            .into(),
            CandidateLoadFailureKind::Stale => portcove_core::PortcoveError::verification(
                "Application update metadata is stale. Portcove kept the last trusted state and did not download an update.",
            )
            .into(),
            CandidateLoadFailureKind::Rejected => portcove_core::PortcoveError::verification(
                "Application update metadata was rejected. Portcove kept the last trusted state and did not download an update.",
            )
            .into(),
        },
        ApplicationUpdateCoordinatorError::Preferences(
            crate::application_update_preferences::ApplicationUpdatePreferenceError::UnsupportedSchema(_),
        )
        | ApplicationUpdateCoordinatorError::Schedule(
            crate::application_update_schedule::ApplicationUpdateScheduleError::UnsupportedSchema(_),
        ) => portcove_core::PortcoveError::unsupported(
            "Application update state uses a newer unsupported format.",
        )
        .into(),
        _ => portcove_core::PortcoveError::state(
            "Application update checking is unavailable. Repair the reported update state or use the documented manual recovery path.",
        )
        .into(),
    }
}

fn staging_error(error: ApplicationUpdateStagingError) -> DesktopError {
    match error {
        ApplicationUpdateStagingError::Busy => portcove_core::PortcoveError::conflict(
            "Application update staging is already active.",
        )
        .into(),
        ApplicationUpdateStagingError::UnsupportedSchema(_) => {
            portcove_core::PortcoveError::unsupported(
                "The staged application update uses a newer unsupported format.",
            )
            .into()
        }
        ApplicationUpdateStagingError::InsufficientSpace { .. } => {
            portcove_core::PortcoveError::state(
                "There is not enough free space to safely stage and apply the application update.",
            )
            .into()
        }
        ApplicationUpdateStagingError::Verification(_) | ApplicationUpdateStagingError::Metadata(_) => {
            portcove_core::PortcoveError::verification(
                "The application update payload could not be verified. The previous verified state was preserved.",
            )
            .into()
        }
        _ => portcove_core::PortcoveError::state(
            "Application update staging is unavailable. Repair the staged update state and try again.",
        )
        .into(),
    }
}

fn operation_error(error: ApplicationUpdateOperationError) -> DesktopError {
    match error {
        ApplicationUpdateOperationError::Cancelled => portcove_core::PortcoveError::new(
            portcove_core::ErrorCode::Cancelled,
            "Application update check cancelled.",
        )
        .into(),
        ApplicationUpdateOperationError::Coordinator(error) => coordinator_error(error),
        ApplicationUpdateOperationError::Download(
            PayloadDownloadError::Network(_) | PayloadDownloadError::Deadline,
        ) => portcove_core::PortcoveError::network(
            "The application update download was interrupted. The previous verified state was preserved.",
        )
        .into(),
        ApplicationUpdateOperationError::Download(_) => portcove_core::PortcoveError::verification(
            "The application update download was rejected. The previous verified state was preserved.",
        )
        .into(),
        ApplicationUpdateOperationError::Staging(error) => staging_error(error),
        ApplicationUpdateOperationError::InvalidSelection(_) => {
            portcove_core::PortcoveError::verification(
                "The authenticated application update selection was inconsistent and was rejected.",
            )
            .into()
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use tokio::sync::Semaphore;

    use super::*;
    use crate::application_update::{ApplicationChannel, CandidateState};
    use crate::application_update_operation::NoopApplicationUpdateProgressSink;

    struct CancelledRunner {
        started: Arc<Semaphore>,
    }

    #[async_trait]
    impl ApplicationUpdateCommandRunner for CancelledRunner {
        async fn run(
            &self,
            _progress: &dyn ApplicationUpdateProgressSink,
            cancellation: &CancellationToken,
        ) -> Result<ApplicationUpdateOperationOutcome, ApplicationUpdateOperationError> {
            self.started.add_permits(1);
            cancellation.cancelled().await;
            Err(ApplicationUpdateOperationError::Cancelled)
        }
    }

    fn state_with(
        runner: Arc<dyn ApplicationUpdateCommandRunner>,
    ) -> ApplicationUpdateCommandState {
        ApplicationUpdateCommandState {
            runner: Ok(Some(runner)),
            active: Arc::new(Mutex::new(None)),
        }
    }

    #[tokio::test]
    async fn one_check_can_be_cancelled_and_releases_process_ownership() {
        let started = Arc::new(Semaphore::new(0));
        let state = state_with(Arc::new(CancelledRunner {
            started: started.clone(),
        }));
        let running_state = state.clone();
        let running = tokio::spawn(async move {
            run_check(&running_state, &NoopApplicationUpdateProgressSink).await
        });
        started.acquire().await.unwrap().forget();

        let busy = run_check(&state, &NoopApplicationUpdateProgressSink)
            .await
            .unwrap_err();
        assert_eq!(busy.code, portcove_core::ErrorCode::Conflict);
        assert!(state.cancel().unwrap());

        let cancelled = running.await.unwrap().unwrap_err();
        assert_eq!(cancelled.code, portcove_core::ErrorCode::Cancelled);
        assert!(!state.cancel().unwrap());
    }

    #[test]
    fn disabled_builds_report_unavailable_without_starting_work() {
        let state = ApplicationUpdateCommandState {
            runner: Ok(None),
            active: Arc::new(Mutex::new(None)),
        };
        let error = state.begin().err().unwrap();
        assert_eq!(error.code, portcove_core::ErrorCode::Unsupported);
        assert!(!state.cancel().unwrap());
    }

    #[test]
    fn checked_results_expose_only_sanitized_candidate_summary() {
        let result = result_from_selection(
            ApplicationUpdateSelectionSummary {
                state: CandidateState::UpdateAvailable,
                candidate: Some(ApplicationUpdateCandidateSummary {
                    version: "1.0.0-beta.1".into(),
                    channel: ApplicationChannel::Preview,
                    bytes: 42,
                }),
                reasons: vec!["eligible".into()],
            },
            true,
        );
        assert_eq!(
            result.kind,
            ApplicationUpdateCheckResultKind::UpdateAvailable
        );
        assert_eq!(result.candidate.unwrap().version, "1.0.0-beta.1");
        assert_eq!(result.reasons, ["eligible"]);
        assert!(result.staged);
    }

    #[test]
    fn installed_context_failures_do_not_expose_host_observation_details() {
        let error = coordinator_error(ApplicationUpdateCoordinatorError::Check {
            failure: CandidateLoadFailureKind::Rejected,
            source: CandidateLoadError::InstalledContext("sensitive-host-detail".into()),
        });
        assert_eq!(error.code, portcove_core::ErrorCode::Unsupported);
        assert!(!error.message.contains("sensitive-host-detail"));
    }
}
