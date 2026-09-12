//! Fixed desktop commands for host-owned application-update checks.
//!
//! React may request or cancel a check and observe sanitized phases/results. It
//! cannot provide repository locations, trust roots, installed identity,
//! signatures, payload keys, or filesystem paths.

use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use crate::application_update::ApplicationUpdateCandidateSummary;
use crate::application_update_connectivity::observe_application_update_connectivity;
use crate::application_update_coordinator::{
    ApplicationUpdateCheckEnvironment, ApplicationUpdateCoordinator,
    ApplicationUpdateCoordinatorError,
};
use crate::application_update_download::PayloadDownloadError;
use crate::application_update_host::{
    ApplicationUpdateHostConfigurationError, ApplicationUpdateHostProvider,
};
use crate::application_update_operation::{
    ApplicationUpdateDownloadExpectation, ApplicationUpdateOperation,
    ApplicationUpdateOperationError, ApplicationUpdateOperationOutcome,
    ApplicationUpdateOperationPhase, ApplicationUpdateProgressSink,
    ApplicationUpdateSelectionSummary, GithubApplicationUpdatePayloadSource,
};
use crate::application_update_repository::{CandidateLoadError, CandidateLoadFailureKind};
use crate::application_update_schedule::{
    ApplicationUpdateCheckDecision, ApplicationUpdateCheckHold, ApplicationUpdateCheckRequest,
    MeteredConnection, NetworkAvailability, STARTUP_DELAY_SECONDS,
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

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ApplicationUpdateDownloadRequest {
    pub expected_preference_revision: u64,
    pub expected_candidate: ApplicationUpdateCandidateSummary,
}

enum ApplicationUpdateCommandRequest {
    Check(ApplicationUpdateCheckEnvironment),
    Download(ApplicationUpdateDownloadRequest),
}

#[async_trait]
trait ApplicationUpdateCommandRunner: Send + Sync {
    async fn run(
        &self,
        request: ApplicationUpdateCommandRequest,
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
        request: ApplicationUpdateCommandRequest,
        progress: &dyn ApplicationUpdateProgressSink,
        cancellation: &CancellationToken,
    ) -> Result<ApplicationUpdateOperationOutcome, ApplicationUpdateOperationError> {
        match request {
            ApplicationUpdateCommandRequest::Check(environment) => {
                self.operation
                    .check_and_stage(
                        environment,
                        &self.provider,
                        &GithubApplicationUpdatePayloadSource,
                        progress,
                        cancellation,
                    )
                    .await
            }
            ApplicationUpdateCommandRequest::Download(request) => {
                let environment = manual_environment();
                self.operation
                    .download_expected(
                        environment,
                        &self.provider,
                        &GithubApplicationUpdatePayloadSource,
                        progress,
                        cancellation,
                        ApplicationUpdateDownloadExpectation {
                            preference_revision: request.expected_preference_revision,
                            candidate: &request.expected_candidate,
                        },
                    )
                    .await
            }
        }
    }
}

#[derive(Clone)]
pub(crate) struct ApplicationUpdateCommandState {
    runner: DesktopResult<Option<Arc<dyn ApplicationUpdateCommandRunner>>>,
    activity: Arc<Mutex<ApplicationUpdateCommandActivity>>,
    automatic_wake: Arc<Notify>,
}

enum ApplicationUpdateCommandActivity {
    Idle,
    Checking(CancellationToken),
    #[cfg(any(windows, test))]
    RestartPending,
}

pub(crate) fn configured_state() -> ApplicationUpdateCommandState {
    ApplicationUpdateCommandState {
        runner: configure_runner(),
        activity: Arc::new(Mutex::new(ApplicationUpdateCommandActivity::Idle)),
        automatic_wake: Arc::new(Notify::new()),
    }
}

const AUTOMATIC_REEVALUATION_SECONDS: u64 = 60;
const MAX_AUTOMATIC_SLEEP_SECONDS: u64 = 24 * 60 * 60;

/// Starts the process-local automatic update coordinator. The first observation
/// occurs only after the scheduler's startup delay, and every later network or
/// payload attempt remains governed by the persisted cross-process schedule.
pub(crate) fn start_automatic_checks(state: ApplicationUpdateCommandState) {
    if !state
        .runner
        .as_ref()
        .is_ok_and(|configured| configured.is_some())
    {
        return;
    }
    let Some(startup_unix_seconds) = current_unix_seconds() else {
        tracing::warn!(
            operation_id = "application-update-automatic",
            "automatic application update checks are unavailable because the system clock is invalid"
        );
        return;
    };
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(STARTUP_DELAY_SECONDS)).await;
        loop {
            let connectivity =
                tauri::async_runtime::spawn_blocking(observe_application_update_connectivity)
                    .await
                    .unwrap_or(
                        crate::application_update_connectivity::ApplicationUpdateConnectivity {
                            network: NetworkAvailability::Unknown,
                            metered: MeteredConnection::Unknown,
                        },
                    );
            let environment = ApplicationUpdateCheckEnvironment {
                request: ApplicationUpdateCheckRequest::Automatic,
                startup_unix_seconds,
                network: connectivity.network,
                metered: connectivity.metered,
            };
            let delay = match run_automatic_once(&state, environment).await {
                Ok(outcome) => {
                    log_automatic_outcome(&outcome);
                    automatic_reevaluation_delay(&outcome, current_unix_seconds())
                }
                Err(error) => {
                    log_automatic_error(&error);
                    Duration::from_secs(AUTOMATIC_REEVALUATION_SECONDS)
                }
            };
            tokio::select! {
                _ = tokio::time::sleep(delay) => {}
                _ = state.automatic_wake.notified() => {}
            }
        }
    });
}

impl ApplicationUpdateCommandState {
    pub(crate) fn wake_automatic(&self) {
        self.automatic_wake.notify_one();
    }
}

fn manual_environment() -> ApplicationUpdateCheckEnvironment {
    ApplicationUpdateCheckEnvironment {
        request: ApplicationUpdateCheckRequest::Manual,
        startup_unix_seconds: 0,
        network: NetworkAvailability::Unknown,
        metered: MeteredConnection::Unknown,
    }
}

fn current_unix_seconds() -> Option<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_secs())
}

fn automatic_reevaluation_delay(
    outcome: &ApplicationUpdateOperationOutcome,
    now_unix_seconds: Option<u64>,
) -> Duration {
    let retry_at = match outcome {
        ApplicationUpdateOperationOutcome::Held(ApplicationUpdateCheckDecision::Hold {
            retry_at_unix_seconds,
            ..
        }) => *retry_at_unix_seconds,
        _ => None,
    };
    let seconds = retry_at
        .zip(now_unix_seconds)
        .map(|(retry_at, now)| retry_at.saturating_sub(now).max(1))
        .unwrap_or(AUTOMATIC_REEVALUATION_SECONDS)
        .min(MAX_AUTOMATIC_SLEEP_SECONDS);
    Duration::from_secs(seconds)
}

fn log_automatic_outcome(outcome: &ApplicationUpdateOperationOutcome) {
    match outcome {
        ApplicationUpdateOperationOutcome::Checked { staged: true, .. } => tracing::info!(
            operation_id = "application-update-automatic",
            "an authenticated application update was downloaded and verified"
        ),
        ApplicationUpdateOperationOutcome::Checked { .. } => tracing::info!(
            operation_id = "application-update-automatic",
            "automatic application update check completed"
        ),
        ApplicationUpdateOperationOutcome::Superseded { .. } => tracing::info!(
            operation_id = "application-update-automatic",
            "automatic application update result was superseded by a preference change"
        ),
        ApplicationUpdateOperationOutcome::Held(_) => {}
    }
}

fn log_automatic_error(error: &DesktopError) {
    if error.code == portcove_core::ErrorCode::Conflict {
        tracing::debug!(
            operation_id = "application-update-automatic",
            "automatic application update check deferred while another update action is active"
        );
    } else {
        tracing::warn!(
            operation_id = "application-update-automatic",
            error_code = ?error.code,
            "automatic application update check failed and will follow the persisted retry cadence"
        );
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
    activity: Arc<Mutex<ApplicationUpdateCommandActivity>>,
}

#[cfg(any(windows, test))]
pub(crate) struct ApplicationUpdateCheckRestartGuard {
    activity: Arc<Mutex<ApplicationUpdateCommandActivity>>,
    committed: bool,
}

#[cfg(any(windows, test))]
impl ApplicationUpdateCheckRestartGuard {
    pub(crate) fn commit(mut self) {
        self.committed = true;
    }
}

#[cfg(any(windows, test))]
impl Drop for ApplicationUpdateCheckRestartGuard {
    fn drop(&mut self) {
        if !self.committed
            && let Ok(mut activity) = self.activity.lock()
            && matches!(*activity, ApplicationUpdateCommandActivity::RestartPending)
        {
            *activity = ApplicationUpdateCommandActivity::Idle;
        }
    }
}

impl Drop for ActiveApplicationUpdateCheck {
    fn drop(&mut self) {
        if let Ok(mut activity) = self.activity.lock()
            && matches!(*activity, ApplicationUpdateCommandActivity::Checking(_))
        {
            *activity = ApplicationUpdateCommandActivity::Idle;
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
        let mut activity = self.activity.lock().map_err(|_| {
            DesktopError::from(portcove_core::PortcoveError::state(
                "Application update check state is unavailable.",
            ))
        })?;
        if !matches!(*activity, ApplicationUpdateCommandActivity::Idle) {
            return Err(portcove_core::PortcoveError::conflict(
                "An application update check or download is already active.",
            )
            .into());
        }
        let cancellation = CancellationToken::new();
        *activity = ApplicationUpdateCommandActivity::Checking(cancellation.clone());
        Ok((
            runner,
            cancellation,
            ActiveApplicationUpdateCheck {
                activity: self.activity.clone(),
            },
        ))
    }

    fn cancel(&self) -> DesktopResult<bool> {
        let activity = self.activity.lock().map_err(|_| {
            DesktopError::from(portcove_core::PortcoveError::state(
                "Application update check state is unavailable.",
            ))
        })?;
        let ApplicationUpdateCommandActivity::Checking(cancellation) = &*activity else {
            return Ok(false);
        };
        cancellation.cancel();
        Ok(true)
    }

    #[cfg(any(windows, test))]
    pub(crate) fn block_for_restart(&self) -> DesktopResult<ApplicationUpdateCheckRestartGuard> {
        let mut activity = self.activity.lock().map_err(|_| {
            DesktopError::from(portcove_core::PortcoveError::state(
                "Application update check state is unavailable.",
            ))
        })?;
        if !matches!(*activity, ApplicationUpdateCommandActivity::Idle) {
            return Err(portcove_core::PortcoveError::conflict(
                "An application update check is already active.",
            )
            .into());
        }
        *activity = ApplicationUpdateCommandActivity::RestartPending;
        drop(activity);
        Ok(ApplicationUpdateCheckRestartGuard {
            activity: self.activity.clone(),
            committed: false,
        })
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

#[tauri::command]
pub(crate) async fn download_application_update(
    state: tauri::State<'_, ApplicationUpdateCommandState>,
    request: ApplicationUpdateDownloadRequest,
    on_event: tauri::ipc::Channel<ApplicationUpdateCheckPhase>,
) -> DesktopResult<ApplicationUpdateCheckResult> {
    run_command(
        state.inner(),
        ApplicationUpdateCommandRequest::Download(request),
        &ChannelProgress(on_event),
    )
    .await
}

async fn run_check(
    state: &ApplicationUpdateCommandState,
    progress: &dyn ApplicationUpdateProgressSink,
) -> DesktopResult<ApplicationUpdateCheckResult> {
    run_command(
        state,
        ApplicationUpdateCommandRequest::Check(manual_environment()),
        progress,
    )
    .await
}

async fn run_command(
    state: &ApplicationUpdateCommandState,
    request: ApplicationUpdateCommandRequest,
    progress: &dyn ApplicationUpdateProgressSink,
) -> DesktopResult<ApplicationUpdateCheckResult> {
    run_operation(state, request, progress)
        .await
        .map(result_from_outcome)
}

async fn run_automatic_once(
    state: &ApplicationUpdateCommandState,
    environment: ApplicationUpdateCheckEnvironment,
) -> DesktopResult<ApplicationUpdateOperationOutcome> {
    run_operation(
        state,
        ApplicationUpdateCommandRequest::Check(environment),
        &crate::application_update_operation::NoopApplicationUpdateProgressSink,
    )
    .await
}

async fn run_operation(
    state: &ApplicationUpdateCommandState,
    request: ApplicationUpdateCommandRequest,
    progress: &dyn ApplicationUpdateProgressSink,
) -> DesktopResult<ApplicationUpdateOperationOutcome> {
    let (runner, cancellation, _active) = state.begin()?;
    runner
        .run(request, progress, &cancellation)
        .await
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
        ApplicationUpdateOperationError::ExplicitDownloadSuperseded => {
            portcove_core::PortcoveError::conflict(
                "The available application update changed. Check again before downloading.",
            )
            .into()
        }
        ApplicationUpdateOperationError::ExplicitDownloadPaused => {
            portcove_core::PortcoveError::conflict(
                "Application update staging is paused. Resume update activity before downloading.",
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

    struct EnvironmentRunner {
        observed: Arc<Mutex<Option<ApplicationUpdateCheckEnvironment>>>,
    }

    #[async_trait]
    impl ApplicationUpdateCommandRunner for CancelledRunner {
        async fn run(
            &self,
            _request: ApplicationUpdateCommandRequest,
            _progress: &dyn ApplicationUpdateProgressSink,
            cancellation: &CancellationToken,
        ) -> Result<ApplicationUpdateOperationOutcome, ApplicationUpdateOperationError> {
            self.started.add_permits(1);
            cancellation.cancelled().await;
            Err(ApplicationUpdateOperationError::Cancelled)
        }
    }

    #[async_trait]
    impl ApplicationUpdateCommandRunner for EnvironmentRunner {
        async fn run(
            &self,
            request: ApplicationUpdateCommandRequest,
            _progress: &dyn ApplicationUpdateProgressSink,
            _cancellation: &CancellationToken,
        ) -> Result<ApplicationUpdateOperationOutcome, ApplicationUpdateOperationError> {
            let ApplicationUpdateCommandRequest::Check(environment) = request else {
                panic!("automatic execution must issue a check");
            };
            *self.observed.lock().unwrap() = Some(environment);
            Ok(ApplicationUpdateOperationOutcome::Held(
                ApplicationUpdateCheckDecision::Hold {
                    reason: ApplicationUpdateCheckHold::Cadence,
                    retry_at_unix_seconds: Some(1_500),
                },
            ))
        }
    }

    fn state_with(
        runner: Arc<dyn ApplicationUpdateCommandRunner>,
    ) -> ApplicationUpdateCommandState {
        ApplicationUpdateCommandState {
            runner: Ok(Some(runner)),
            activity: Arc::new(Mutex::new(ApplicationUpdateCommandActivity::Idle)),
            automatic_wake: Arc::new(Notify::new()),
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
        assert_eq!(
            state.block_for_restart().err().unwrap().code,
            portcove_core::ErrorCode::Conflict
        );

        let busy = run_check(&state, &NoopApplicationUpdateProgressSink)
            .await
            .unwrap_err();
        assert_eq!(busy.code, portcove_core::ErrorCode::Conflict);
        assert!(state.cancel().unwrap());

        let cancelled = running.await.unwrap().unwrap_err();
        assert_eq!(cancelled.code, portcove_core::ErrorCode::Cancelled);
        assert!(!state.cancel().unwrap());
        drop(state.block_for_restart().unwrap());
        assert!(state.begin().is_ok());
        state.block_for_restart().unwrap().commit();
        assert_eq!(
            state.begin().err().unwrap().code,
            portcove_core::ErrorCode::Conflict
        );
        assert!(!state.cancel().unwrap());
    }

    #[tokio::test]
    async fn automatic_checks_keep_the_observed_environment_and_exact_retry_time() {
        let observed = Arc::new(Mutex::new(None));
        let state = state_with(Arc::new(EnvironmentRunner {
            observed: observed.clone(),
        }));
        let environment = ApplicationUpdateCheckEnvironment {
            request: ApplicationUpdateCheckRequest::Automatic,
            startup_unix_seconds: 1_000,
            network: NetworkAvailability::Online,
            metered: MeteredConnection::Unmetered,
        };

        let outcome = run_automatic_once(&state, environment).await.unwrap();

        assert_eq!(*observed.lock().unwrap(), Some(environment));
        assert_eq!(
            automatic_reevaluation_delay(&outcome, Some(1_100)),
            Duration::from_secs(400)
        );
        assert_eq!(
            automatic_reevaluation_delay(
                &ApplicationUpdateOperationOutcome::Held(ApplicationUpdateCheckDecision::Hold {
                    reason: ApplicationUpdateCheckHold::Cadence,
                    retry_at_unix_seconds: Some(u64::MAX),
                },),
                Some(1_100),
            ),
            Duration::from_secs(MAX_AUTOMATIC_SLEEP_SECONDS)
        );
    }

    #[test]
    fn disabled_builds_report_unavailable_without_starting_work() {
        let state = ApplicationUpdateCommandState {
            runner: Ok(None),
            activity: Arc::new(Mutex::new(ApplicationUpdateCommandActivity::Idle)),
            automatic_wake: Arc::new(Notify::new()),
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
