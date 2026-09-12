mod adoption;
pub mod application_update;
pub mod application_update_apply;
pub mod application_update_coordinator;
pub mod application_update_download;
mod application_update_network;
pub mod application_update_payload;
pub mod application_update_preferences;
pub mod application_update_repository;
pub mod application_update_schedule;
pub mod application_update_staging;
pub mod application_update_status;
mod application_update_storage;
mod application_update_transport;
pub mod application_update_trust;
mod artwork;
mod backup_review;
mod catalog;
mod cli_context;
mod diagnostics;
mod game_updates;
mod library_selection;
mod library_transfer;
mod output_location;
mod preparation;
mod removal;
mod source_removal;
mod transport;

use transport::{
    BatchOutcome, BootstrapStatus, DesktopError, InstallInput, LaunchResult, SourceBatchOutcome,
};

use std::{
    fs,
    future::Future,
    path::{Path, PathBuf},
    process::Stdio,
    thread,
    time::Duration,
};

use portcove_core::{
    ActivityRecord, ApplicationRuntimeGuard, BackupInventory, BackupRecord, CatalogDocument,
    ChildProcessClass, ChildProcessPolicy, CompositeReleaseProvider, DoctorReport,
    GithubAuthStatus, GithubDeviceLogin, GithubDeviceLoginResult, GithubReleaseProvider,
    HostPreferenceStore, HostToolProbeResult, HostToolStatus, IdentifiedLaunchRequest, InstallPlan,
    InstallRecord, LaunchStdio, Library, LibraryMetadataFile, LibrarySelection,
    LibrarySelectionSource, OperationCoordinator, OperationEvent, OperationResult, PortStatus,
    PortcoveError, PortcoveService, ReconcileResult, ReleaseChannel, ReleaseProvider,
    SourceDiscoveryLimits, SourceImportMode, SourceImportPlan, SourceImportResult,
    SourceInboxPaths, SourceInboxResolution, SourceInspectionReport, SourceIntakeInspection,
    SourceRecord, SourceRelinkPlan, SourceVerification, UpdateCheck, UpdatePolicy,
    VerificationReport,
};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

type LaunchObservation = (Library, String);
type LaunchObserver =
    std::sync::Arc<std::sync::Mutex<Option<std::sync::mpsc::Sender<LaunchObservation>>>>;
const LAUNCH_ACCEPTANCE_POLL_INTERVAL: Duration = Duration::from_millis(25);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LaunchObservationState {
    Active,
    Complete,
    Retry,
}

#[derive(Clone)]
struct ReadyDesktopState {
    library: Library,
    selection: LibrarySelection,
    github: std::sync::Arc<GithubReleaseProvider>,
    releases: std::sync::Arc<CompositeReleaseProvider>,
}

#[derive(Clone)]
struct DesktopState {
    initialization: std::sync::Arc<std::sync::Mutex<DesktopResult<ReadyDesktopState>>>,
    preferences: DesktopResult<HostPreferenceStore>,
    generation: std::sync::Arc<std::sync::atomic::AtomicU64>,
    launch_observer: LaunchObserver,
}

type DesktopResult<T> = std::result::Result<T, DesktopError>;

fn initialization_snapshot(state: &DesktopState) -> (DesktopResult<ReadyDesktopState>, u64) {
    match state.initialization.lock() {
        Ok(initialization) => (initialization.clone(), state_generation(state)),
        Err(_) => (
            Err(PortcoveError::state("desktop state lock was poisoned").into()),
            state_generation(state),
        ),
    }
}

fn ready(state: &DesktopState) -> DesktopResult<ReadyDesktopState> {
    initialization_snapshot(state).0
}

fn require_no_library_handoff(
    initialization: &DesktopResult<ReadyDesktopState>,
) -> DesktopResult<()> {
    if initialization.as_ref().err().is_some_and(|error| {
        error.details.contains_key("transfer_in_progress")
            || error.details.contains_key("library_switch_in_progress")
    }) {
        return Err(PortcoveError::conflict("a library handoff is already in progress").into());
    }
    Ok(())
}

fn service(state: &DesktopState) -> DesktopResult<PortcoveService> {
    let state = ready(state)?;
    let releases: std::sync::Arc<dyn ReleaseProvider> = state.releases.clone();
    PortcoveService::with_provider(state.library.clone(), releases).map_err(Into::into)
}

fn service_at_generation(
    state: &DesktopState,
    expected_generation: u64,
) -> DesktopResult<PortcoveService> {
    require_library_generation(state_generation(state), expected_generation)?;
    let service = service(state)?;
    require_library_generation(state_generation(state), expected_generation)?;
    Ok(service)
}

fn require_library_generation(actual: u64, expected: u64) -> DesktopResult<()> {
    if actual == expected {
        return Ok(());
    }
    Err(DesktopError::from(PortcoveError::conflict(
        "the open library changed; review the current selection and try again",
    )))
}

#[tauri::command]
fn get_bootstrap_status(state: tauri::State<'_, DesktopState>) -> BootstrapStatus {
    bootstrap_status(&state)
}

fn bootstrap_status(state: &DesktopState) -> BootstrapStatus {
    let (initialization, generation) = initialization_snapshot(state);
    match initialization {
        Ok(ready_state) => BootstrapStatus {
            ready: true,
            library_root: Some(ready_state.library.root().to_path_buf()),
            selection: Some(ready_state.selection),
            generation,
            error: None,
        },
        Err(error) => BootstrapStatus {
            ready: false,
            library_root: None,
            selection: None,
            generation,
            error: Some(error),
        },
    }
}

fn state_generation(state: &DesktopState) -> u64 {
    state.generation.load(std::sync::atomic::Ordering::Acquire)
}

async fn blocking_service<T, F>(state: DesktopState, operation: F) -> DesktopResult<T>
where
    T: Send + 'static,
    F: FnOnce(PortcoveService) -> DesktopResult<T> + Send + 'static,
{
    blocking_worker(move || operation(service(&state)?)).await
}

async fn blocking_async_service<T, F, Fut>(state: DesktopState, operation: F) -> DesktopResult<T>
where
    T: Send + 'static,
    F: FnOnce(PortcoveService) -> Fut + Send + 'static,
    Fut: Future<Output = DesktopResult<T>> + Send + 'static,
{
    blocking_worker(move || {
        let service = service(&state)?;
        tokio::runtime::Handle::current().block_on(operation(service))
    })
    .await
}

async fn blocking_worker<T, F>(operation: F) -> DesktopResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> DesktopResult<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| DesktopError::from(PortcoveError::state(error.to_string())))?
}

async fn confirm_destructive(
    app: &tauri::AppHandle,
    title: &str,
    message: String,
    confirm_label: &str,
) -> bool {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog()
        .message(message)
        .title(title)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            confirm_label.to_owned(),
            "Cancel".to_owned(),
        ))
        .show(move |confirmed| {
            let _ = sender.send(confirmed);
        });
    receiver.await.unwrap_or(false)
}

fn emit_operation(app: &tauri::AppHandle, event: OperationEvent) {
    tracing::info!(
        operation_id = %event.operation_id,
        parent_operation_id = ?event.parent_operation_id,
        sequence = event.sequence,
        operation = %event.operation,
        target = ?event.target,
        event = ?event.event,
        "operation event"
    );
    let _ = app.emit("portcove://operation", event);
}

#[tauri::command]
async fn get_github_auth_status(
    state: tauri::State<'_, DesktopState>,
) -> DesktopResult<GithubAuthStatus> {
    ready(&state)?
        .github
        .auth_status()
        .await
        .map_err(Into::into)
}

#[tauri::command]
async fn plan_port(
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    channel: ReleaseChannel,
) -> DesktopResult<InstallPlan> {
    let state = state.inner().clone();
    blocking_async_service(state, move |service| async move {
        service
            .plan_install(&port_id, Some(channel))
            .await
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
async fn set_github_token(
    state: tauri::State<'_, DesktopState>,
    token: String,
) -> DesktopResult<GithubAuthStatus> {
    ready(&state)?
        .github
        .store_personal_token(&token)
        .await
        .map_err(Into::into)
}

#[tauri::command]
async fn logout_github(state: tauri::State<'_, DesktopState>) -> DesktopResult<GithubAuthStatus> {
    ready(&state)?.github.logout().await.map_err(Into::into)
}

#[tauri::command]
async fn begin_github_device_login(
    state: tauri::State<'_, DesktopState>,
) -> DesktopResult<GithubDeviceLogin> {
    ready(&state)?
        .github
        .begin_device_login()
        .await
        .map_err(Into::into)
}

#[tauri::command]
async fn poll_github_device_login(
    state: tauri::State<'_, DesktopState>,
    session_id: String,
) -> DesktopResult<GithubDeviceLoginResult> {
    ready(&state)?
        .github
        .poll_device_login(&session_id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
async fn get_catalog(state: tauri::State<'_, DesktopState>) -> DesktopResult<CatalogDocument> {
    let state = state.inner().clone();
    blocking_service(state, |service| Ok(service.catalog().document().clone())).await
}

#[tauri::command]
async fn get_statuses(state: tauri::State<'_, DesktopState>) -> DesktopResult<Vec<PortStatus>> {
    let state = state.inner().clone();
    blocking_service(state, |service| statuses_with_service(&service)).await
}

fn statuses_with_service(service: &PortcoveService) -> DesktopResult<Vec<PortStatus>> {
    service.statuses().map_err(Into::into)
}

#[tauri::command]
async fn get_sources(state: tauri::State<'_, DesktopState>) -> DesktopResult<Vec<SourceRecord>> {
    let state = state.inner().clone();
    blocking_worker(move || ready(&state)?.library.sources().map_err(Into::into)).await
}

#[tauri::command]
async fn get_activities(
    state: tauri::State<'_, DesktopState>,
) -> DesktopResult<Vec<ActivityRecord>> {
    let state = state.inner().clone();
    blocking_worker(move || ready(&state)?.library.activities(50).map_err(Into::into)).await
}

#[tauri::command]
async fn get_activity_diagnostic(
    state: tauri::State<'_, DesktopState>,
    activity_id: String,
    generation: u64,
) -> DesktopResult<Vec<portcove_core::ActivityDiagnostic>> {
    let state = state.inner().clone();
    blocking_worker(move || {
        service_at_generation(&state, generation)?
            .library()
            .activity_diagnostic(&activity_id)
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
async fn cancel_operation(
    state: tauri::State<'_, DesktopState>,
    operation_id: String,
) -> DesktopResult<portcove_core::CancellationState> {
    blocking_service(state.inner().clone(), move |service| {
        service
            .request_cancellation(&operation_id)
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
async fn get_backups(
    state: tauri::State<'_, DesktopState>,
    port_id: String,
) -> DesktopResult<BackupInventory> {
    let state = state.inner().clone();
    blocking_service(state, move |service| {
        service.list_backups(&port_id).map_err(Into::into)
    })
    .await
}

#[tauri::command]
async fn create_backup(
    state: tauri::State<'_, DesktopState>,
    port_id: String,
) -> DesktopResult<BackupRecord> {
    let state = state.inner().clone();
    blocking_service(state, move |service| {
        service.create_backup(&port_id).map_err(Into::into)
    })
    .await
}

#[tauri::command]
async fn verify_source(
    state: tauri::State<'_, DesktopState>,
    profile_id: String,
) -> DesktopResult<SourceVerification> {
    let state = state.inner().clone();
    blocking_service(state, move |service| {
        service.verify_source(&profile_id).map_err(Into::into)
    })
    .await
}

#[tauri::command]
async fn inspect_source(
    state: tauri::State<'_, DesktopState>,
    profile_id: String,
) -> DesktopResult<SourceInspectionReport> {
    let state = state.inner().clone();
    blocking_service(state, move |service| {
        inspect_source_with_service(&service, &profile_id)
    })
    .await
}

#[tauri::command]
async fn inspect_source_intake(
    state: tauri::State<'_, DesktopState>,
    profile_id: String,
    paths: Vec<PathBuf>,
) -> DesktopResult<SourceIntakeInspection> {
    let state = state.inner().clone();
    blocking_service(state, move |service| {
        inspect_source_intake_with_service(&service, &profile_id, &paths)
    })
    .await
}

fn inspect_source_intake_with_service(
    service: &PortcoveService,
    profile_id: &str,
    paths: &[PathBuf],
) -> DesktopResult<SourceIntakeInspection> {
    service
        .inspect_source_intake(profile_id, paths)
        .map_err(Into::into)
}

fn inspect_source_with_service(
    service: &PortcoveService,
    profile_id: &str,
) -> DesktopResult<SourceInspectionReport> {
    service
        .inspect_registered_source(profile_id)
        .map_err(Into::into)
}

#[tauri::command]
async fn plan_source_relink(
    state: tauri::State<'_, DesktopState>,
    profile_id: String,
    path: PathBuf,
) -> DesktopResult<SourceRelinkPlan> {
    let state = state.inner().clone();
    blocking_service(state, move |service| {
        service
            .plan_source_relink(&profile_id, &path)
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
async fn relink_source(
    state: tauri::State<'_, DesktopState>,
    profile_id: String,
    path: PathBuf,
    preview_sha256: String,
) -> DesktopResult<SourceRecord> {
    let state = state.inner().clone();
    blocking_service(state, move |service| {
        service
            .relink_source(&profile_id, &path, &preview_sha256)
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
async fn verify_sources(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
) -> DesktopResult<Vec<SourceBatchOutcome>> {
    let operation = OperationCoordinator::new("verify_sources", None);
    emit_operation(&app, operation.started());
    let state = state.inner().clone();
    let outcomes = tauri::async_runtime::spawn_blocking(move || {
        let service = service(&state)?;
        let sources = ready(&state)?
            .library
            .sources()
            .map_err(DesktopError::from)?;
        Ok::<_, DesktopError>(
            sources
                .into_iter()
                .map(|source| {
                    let profile_id = source.profile_id;
                    match service.verify_source(&profile_id) {
                        Ok(result) => SourceBatchOutcome {
                            profile_id,
                            ok: true,
                            result: Some(result),
                            error: None,
                        },
                        Err(error) => SourceBatchOutcome {
                            profile_id,
                            ok: false,
                            result: None,
                            error: Some(error.into()),
                        },
                    }
                })
                .collect::<Vec<_>>(),
        )
    })
    .await
    .map_err(|error| DesktopError::from(PortcoveError::state(error.to_string())))??;
    emit_operation(
        &app,
        operation.finished(if outcomes.iter().all(|outcome| outcome.ok) {
            OperationResult::Succeeded
        } else {
            OperationResult::Failed
        }),
    );
    Ok(outcomes)
}

#[tauri::command]
async fn check_port(
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    generation: u64,
) -> DesktopResult<UpdateCheck> {
    let state = state.inner().clone();
    blocking_worker(move || {
        let service = service_at_generation(&state, generation)?;
        tauri::async_runtime::block_on(service.check_update(&port_id)).map_err(Into::into)
    })
    .await
}

#[tauri::command]
async fn check_installed(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
) -> DesktopResult<Vec<BatchOutcome<UpdateCheck>>> {
    let state = state.inner().clone();
    blocking_async_service(state, move |service| async move {
        let installed = service
            .statuses()?
            .into_iter()
            .filter(|status| status.active.is_some())
            .map(|status| status.port_id)
            .collect::<Vec<_>>();
        let total = installed.len() as u64;
        let operation = OperationCoordinator::new("check_installed", None);
        emit_operation(&app, operation.started());
        let mut outcomes = Vec::with_capacity(installed.len());
        for (index, (port_id, result)) in service
            .check_updates(installed)
            .await?
            .into_iter()
            .enumerate()
        {
            outcomes.push(match result {
                Ok(result) => BatchOutcome {
                    port_id,
                    ok: true,
                    result: Some(result),
                    error: None,
                },
                Err(error) => BatchOutcome {
                    port_id,
                    ok: false,
                    result: None,
                    error: Some(error.into()),
                },
            });
            emit_operation(
                &app,
                operation.progress("Checking installed ports", index as u64 + 1, Some(total)),
            );
        }
        let success = outcomes.iter().all(|outcome| outcome.ok);
        emit_operation(
            &app,
            operation.finished(if success {
                OperationResult::Succeeded
            } else {
                OperationResult::Failed
            }),
        );
        Ok(outcomes)
    })
    .await
}

#[tauri::command]
async fn reconcile_installed(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
) -> DesktopResult<Vec<BatchOutcome<ReconcileResult>>> {
    let state = state.inner().clone();
    blocking_async_service(state, move |service| async move {
        let installed = service
            .statuses()?
            .into_iter()
            .filter(|status| status.active.is_some())
            .collect::<Vec<_>>();
        let total = installed.len() as u64;
        let operation = OperationCoordinator::new("reconcile_installed", None);
        emit_operation(&app, operation.started());
        let mut outcomes = Vec::with_capacity(installed.len());
        for (index, status) in installed.into_iter().enumerate() {
            let port_id = status.port_id;
            let result = service
                .reconcile(&port_id, |event| {
                    emit_operation(&app, event);
                })
                .await;
            outcomes.push(match result {
                Ok(result) => BatchOutcome {
                    port_id,
                    ok: true,
                    result: Some(result),
                    error: None,
                },
                Err(error) => BatchOutcome {
                    port_id,
                    ok: false,
                    result: None,
                    error: Some(error.into()),
                },
            });
            emit_operation(
                &app,
                operation.progress("Applying update policies", index as u64 + 1, Some(total)),
            );
        }
        emit_operation(
            &app,
            operation.finished(if outcomes.iter().all(|outcome| outcome.ok) {
                OperationResult::Succeeded
            } else {
                OperationResult::Failed
            }),
        );
        Ok(outcomes)
    })
    .await
}

#[tauri::command]
async fn add_source(
    state: tauri::State<'_, DesktopState>,
    profile_id: String,
    path: PathBuf,
    expected_sha256: Option<String>,
) -> DesktopResult<SourceRecord> {
    let state = state.inner().clone();
    blocking_service(state, move |service| {
        if let Some(digest) = expected_sha256 {
            service
                .register_source_with_digest(&profile_id, &path, &digest)
                .map_err(Into::into)
        } else {
            service
                .register_source(&profile_id, &path)
                .map_err(Into::into)
        }
    })
    .await
}

#[tauri::command]
async fn discover_sources(
    state: tauri::State<'_, DesktopState>,
    request: portcove_core::SourceDiscoveryRequest,
    on_event: tauri::ipc::Channel<OperationEvent>,
) -> DesktopResult<portcove_core::SourceDiscoveryReport> {
    blocking_service(state.inner().clone(), move |service| {
        service
            .discover_sources_with_progress(&request, |event| {
                let _ = on_event.send(event);
            })
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
async fn get_source_inbox_paths(
    state: tauri::State<'_, DesktopState>,
    profile_id: String,
) -> DesktopResult<SourceInboxPaths> {
    blocking_service(state.inner().clone(), move |service| {
        service
            .source_inbox_paths(Some(&profile_id))
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
async fn open_source_inbox(
    state: tauri::State<'_, DesktopState>,
    profile_id: String,
) -> DesktopResult<SourceInboxPaths> {
    blocking_service(state.inner().clone(), move |service| {
        let paths = service.prepare_source_inbox_profile(&profile_id)?;
        open_directory(
            paths
                .profile
                .as_deref()
                .ok_or_else(|| PortcoveError::state("prepared Source Inbox has no profile path"))?,
        )?;
        Ok(paths)
    })
    .await
}

#[tauri::command]
async fn scan_source_inbox(
    state: tauri::State<'_, DesktopState>,
    profile_id: String,
    limits: SourceDiscoveryLimits,
    on_event: tauri::ipc::Channel<OperationEvent>,
) -> DesktopResult<SourceInboxResolution> {
    blocking_service(state.inner().clone(), move |service| {
        scan_source_inbox_for(&service, &profile_id, &limits, |event| {
            let _ = on_event.send(event);
        })
    })
    .await
}

fn scan_source_inbox_for<F>(
    service: &PortcoveService,
    profile_id: &str,
    limits: &SourceDiscoveryLimits,
    emit: F,
) -> DesktopResult<SourceInboxResolution>
where
    F: FnMut(OperationEvent),
{
    service
        .scan_source_inbox_with_progress(profile_id, limits, emit)
        .map_err(Into::into)
}

#[tauri::command]
async fn plan_source_import(
    state: tauri::State<'_, DesktopState>,
    profile_id: String,
    path: PathBuf,
    mode: SourceImportMode,
) -> DesktopResult<SourceImportPlan> {
    blocking_service(state.inner().clone(), move |service| {
        plan_source_import_for(&service, &profile_id, &path, mode)
    })
    .await
}

fn plan_source_import_for(
    service: &PortcoveService,
    profile_id: &str,
    path: &Path,
    mode: SourceImportMode,
) -> DesktopResult<SourceImportPlan> {
    service
        .plan_source_import(profile_id, path, mode)
        .map_err(Into::into)
}

#[tauri::command]
async fn import_source(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
    profile_id: String,
    path: PathBuf,
    mode: SourceImportMode,
    expected_plan: String,
    on_event: tauri::ipc::Channel<OperationEvent>,
) -> DesktopResult<Option<SourceImportResult>> {
    if mode == SourceImportMode::Move {
        let reviewed = blocking_service(state.inner().clone(), {
            let profile_id = profile_id.clone();
            let path = path.clone();
            move |service| plan_source_import_for(&service, &profile_id, &path, mode)
        })
        .await?;
        if reviewed.plan_sha256 != expected_plan {
            return Err(PortcoveError::conflict(
                "the source import changed after review; review the move again",
            )
            .into());
        }
        if !confirm_destructive(
            &app,
            "Move original source",
            format!(
                "Move the original source for {profile_id} into its Source Inbox?\n\nPortcove removes the original only after the Inbox copy is verified and registered."
            ),
            "Move source",
        )
        .await
        {
            return Ok(None);
        }
    }
    blocking_service(state.inner().clone(), move |service| {
        import_source_for(
            &service,
            &profile_id,
            &path,
            mode,
            &expected_plan,
            mode == SourceImportMode::Move,
            |event| {
                let _ = on_event.send(event);
            },
        )
        .map(Some)
    })
    .await
}

fn import_source_for<F>(
    service: &PortcoveService,
    profile_id: &str,
    path: &Path,
    mode: SourceImportMode,
    expected_plan: &str,
    authorize_move: bool,
    emit: F,
) -> DesktopResult<SourceImportResult>
where
    F: FnMut(OperationEvent),
{
    let authorization = if authorize_move && mode == SourceImportMode::Move {
        Some(
            service
                .authorize_source_move(profile_id, path, expected_plan)?
                .token,
        )
    } else {
        None
    };
    service
        .import_source_with_progress(
            profile_id,
            path,
            mode,
            expected_plan,
            authorization.as_deref(),
            emit,
        )
        .map_err(Into::into)
}

#[tauri::command]
async fn set_channel(
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    channel: ReleaseChannel,
    generation: u64,
) -> DesktopResult<PortStatus> {
    let state = state.inner().clone();
    blocking_worker(move || {
        service_at_generation(&state, generation)?
            .set_channel(&port_id, channel)
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
async fn set_policy(
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    policy: UpdatePolicy,
    generation: u64,
) -> DesktopResult<PortStatus> {
    let state = state.inner().clone();
    blocking_worker(move || {
        service_at_generation(&state, generation)?
            .set_update_policy(&port_id, policy)
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
async fn install_port(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
    input: InstallInput,
) -> DesktopResult<InstallRecord> {
    let state = state.inner().clone();
    blocking_async_service(state, move |service| async move {
        service
            .install(
                &input.port_id,
                input.channel,
                input.source.as_deref(),
                input.bios.as_deref(),
                !input.stage,
                |event: OperationEvent| {
                    emit_operation(&app, event);
                },
            )
            .await
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
async fn update_port(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    source: Option<PathBuf>,
    bios: Option<PathBuf>,
    stage: bool,
) -> DesktopResult<InstallRecord> {
    let state = state.inner().clone();
    blocking_async_service(state, move |service| async move {
        service
            .update(
                &port_id,
                source.as_deref(),
                bios.as_deref(),
                !stage,
                |event: OperationEvent| {
                    emit_operation(&app, event);
                },
            )
            .await
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
async fn verify_port(
    state: tauri::State<'_, DesktopState>,
    port_id: String,
) -> DesktopResult<VerificationReport> {
    let state = state.inner().clone();
    blocking_service(state, move |service| {
        service.verify(&port_id).map_err(Into::into)
    })
    .await
}

#[tauri::command]
async fn rollback_port(
    state: tauri::State<'_, DesktopState>,
    port_id: String,
) -> DesktopResult<InstallRecord> {
    let state = state.inner().clone();
    blocking_service(state, move |service| {
        service.rollback(&port_id).map_err(Into::into)
    })
    .await
}

#[tauri::command]
async fn activate_port(
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    expected_active: Option<String>,
    expected_staged: String,
    generation: u64,
) -> DesktopResult<InstallRecord> {
    let state = state.inner().clone();
    blocking_worker(move || {
        service_at_generation(&state, generation)?
            .activate_staged_reviewed(&port_id, expected_active.as_deref(), &expected_staged)
            .map_err(Into::into)
    })
    .await
}

#[derive(Debug, Serialize, Deserialize)]
struct LaunchSupervisorRequest {
    request_id: String,
    library_root: PathBuf,
    port_id: String,
    source: Option<PathBuf>,
    arguments: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct LaunchSupervisorResponse {
    result: Option<LaunchResult>,
    error: Option<DesktopError>,
}

impl LaunchSupervisorResponse {
    fn success(result: LaunchResult) -> Self {
        Self {
            result: Some(result),
            error: None,
        }
    }

    fn failure(error: impl Into<DesktopError>) -> Self {
        Self {
            result: None,
            error: Some(error.into()),
        }
    }
}

#[tauri::command]
async fn launch_port(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    source: Option<PathBuf>,
    arguments: Vec<String>,
) -> DesktopResult<LaunchResult> {
    let library = ready(&state)?.library.clone();
    let supervisor_library = library.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        request_supervised_launch(&supervisor_library, port_id, source, arguments)
    })
    .await
    .map_err(|error| DesktopError::from(PortcoveError::state(error.to_string())))??;
    observe_launch_completion(&app, state.inner(), library, result.session_id.clone())?;
    Ok(result)
}

fn observe_launch_completion(
    app: &tauri::AppHandle,
    state: &DesktopState,
    library: Library,
    request_id: String,
) -> DesktopResult<()> {
    let mut observer = state.launch_observer.lock().map_err(|_| {
        DesktopError::from(PortcoveError::state("launch observer lock was poisoned"))
    })?;
    if observer.is_none() {
        let (sender, receiver) = std::sync::mpsc::channel::<LaunchObservation>();
        let app = app.clone();
        thread::spawn(move || {
            let mut pending = Vec::<(Library, String)>::new();
            loop {
                match receiver.recv_timeout(Duration::from_millis(250)) {
                    Ok(observation) => pending.push(observation),
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) if pending.is_empty() => {
                        break;
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {}
                }
                while let Ok(observation) = receiver.try_recv() {
                    pending.push(observation);
                }
                let completed =
                    retain_launch_observations(&mut pending, |(library, request_id)| match library
                        .launch_request(request_id)
                    {
                        Ok(Some(request)) if request.outcome.is_none() => {
                            LaunchObservationState::Active
                        }
                        Ok(_) => LaunchObservationState::Complete,
                        Err(_) => LaunchObservationState::Retry,
                    });
                if completed {
                    let _ = app.emit("portcove://library-changed", ());
                }
            }
        });
        *observer = Some(sender);
    }
    observer
        .as_ref()
        .expect("launch observer was initialized")
        .send((library, request_id))
        .map_err(|_| {
            DesktopError::from(PortcoveError::state("launch observer stopped unexpectedly"))
        })
}

fn retain_launch_observations<T>(
    pending: &mut Vec<T>,
    mut observe: impl FnMut(&T) -> LaunchObservationState,
) -> bool {
    let mut completed = false;
    pending.retain(|observation| match observe(observation) {
        LaunchObservationState::Active | LaunchObservationState::Retry => true,
        LaunchObservationState::Complete => {
            completed = true;
            false
        }
    });
    completed
}

fn request_supervised_launch(
    library: &Library,
    port_id: String,
    source: Option<PathBuf>,
    arguments: Vec<String>,
) -> DesktopResult<LaunchResult> {
    let request_id = OperationCoordinator::new("launch-supervisor-request", None)
        .operation_id()
        .to_owned();
    let directory = library.root().join("launch-requests");
    fs::create_dir_all(&directory).map_err(PortcoveError::from)?;
    let request_path = directory.join(format!("{request_id}.json"));
    let response_path = directory.join(format!("{request_id}.response.json"));
    publish_json(
        &request_path,
        &LaunchSupervisorRequest {
            request_id,
            library_root: library.root().to_path_buf(),
            port_id,
            source,
            arguments,
        },
    )?;
    let executable = std::env::current_exe().map_err(PortcoveError::from)?;
    let mut command =
        ChildProcessPolicy::native_command(ChildProcessClass::HostIntegration, &executable)?;
    command
        .arg("--portcove-supervise")
        .arg(&request_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    configure_independent_process(&mut command);
    let mut supervisor = command.spawn().map_err(|error| {
        let _ = fs::remove_file(&request_path);
        PortcoveError::launch(format!("could not start the launch supervisor: {error}"))
    })?;
    let result = wait_for_launch_acceptance(
        || {
            if !response_path.is_file() {
                return Ok(None);
            }
            let response =
                serde_json::from_slice(&fs::read(&response_path).map_err(PortcoveError::from)?)
                    .map_err(PortcoveError::from)?;
            let _ = fs::remove_file(&response_path);
            Ok(Some(response))
        },
        || {
            supervisor
                .try_wait()
                .map(|status| status.map(|status| status.to_string()))
                .map_err(PortcoveError::from)
                .map_err(DesktopError::from)
        },
        || thread::sleep(LAUNCH_ACCEPTANCE_POLL_INTERVAL),
    );
    if result.is_err() {
        let _ = fs::remove_file(&request_path);
    }
    result
}

fn wait_for_launch_acceptance<R, S, W>(
    mut read_response: R,
    mut supervisor_status: S,
    mut wait: W,
) -> DesktopResult<LaunchResult>
where
    R: FnMut() -> DesktopResult<Option<LaunchSupervisorResponse>>,
    S: FnMut() -> DesktopResult<Option<String>>,
    W: FnMut(),
{
    loop {
        if let Some(response) = read_response()? {
            return match (response.result, response.error) {
                (Some(result), None) => Ok(result),
                (None, Some(error)) => Err(error),
                _ => Err(
                    PortcoveError::state("launch supervisor returned an invalid response").into(),
                ),
            };
        }
        if let Some(status) = supervisor_status()? {
            return Err(PortcoveError::launch(format!(
                "launch supervisor exited before starting the game ({status})"
            ))
            .into());
        }
        wait();
    }
}

fn response_path_for(request_path: &Path) -> PathBuf {
    request_path.with_extension("response.json")
}

fn publish_json(path: &Path, value: &impl Serialize) -> DesktopResult<()> {
    let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
    fs::write(
        &temporary,
        serde_json::to_vec(value).map_err(PortcoveError::from)?,
    )
    .map_err(PortcoveError::from)?;
    fs::rename(&temporary, path).map_err(PortcoveError::from)?;
    Ok(())
}

fn configure_independent_process(command: &mut std::process::Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        command.creation_flags(CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
}

pub fn run_hidden_helper() -> Option<i32> {
    let mut arguments = std::env::args_os();
    let _program = arguments.next();
    match arguments.next().as_deref() {
        Some(mode) if mode == "--portcove-supervise" => {
            let request = arguments.next().map(PathBuf::from);
            Some(match request {
                Some(request) if arguments.next().is_none() => run_supervisor_request(&request),
                _ => 2,
            })
        }
        Some(mode) if mode == "--portcove-recover" => {
            let library = arguments.next().map(PathBuf::from);
            let session_id = arguments.next();
            Some(match (library, session_id) {
                (Some(library), Some(session_id)) if arguments.next().is_none() => {
                    match session_id.to_str() {
                        Some(session_id) => run_recovery_helper(&library, session_id),
                        None => 2,
                    }
                }
                _ => 2,
            })
        }
        _ => None,
    }
}

fn run_supervisor_request(request_path: &Path) -> i32 {
    let _application_runtime = match application_runtime_guard() {
        Ok(guard) => guard,
        Err(_) => return 1,
    };
    let response_path = response_path_for(request_path);
    let request = fs::read(request_path)
        .map_err(PortcoveError::from)
        .and_then(|bytes| {
            serde_json::from_slice::<LaunchSupervisorRequest>(&bytes).map_err(Into::into)
        });
    let request = match request {
        Ok(request) => request,
        Err(error) => {
            let _ = fs::remove_file(request_path);
            let _ = publish_json(&response_path, &LaunchSupervisorResponse::failure(error));
            return 1;
        }
    };
    let mut response_written = false;
    let result = Library::open(&request.library_root)
        .and_then(PortcoveService::new)
        .and_then(|service| {
            service.supervise_launch_identified(
                IdentifiedLaunchRequest {
                    request_id: &request.request_id,
                    port_id: &request.port_id,
                    source_override: request.source.as_deref(),
                    arguments: &request.arguments,
                    stdio: LaunchStdio::Null,
                },
                |session| {
                    let _ = fs::remove_file(request_path);
                    response_written = publish_json(
                        &response_path,
                        &LaunchSupervisorResponse::success(LaunchResult {
                            process_id: None,
                            session_id: session.id.clone(),
                        }),
                    )
                    .is_ok();
                },
                |_| {},
            )
        });
    if !response_written {
        let _ = fs::remove_file(request_path);
        let succeeded = result.is_ok();
        let response = match result {
            Ok(outcome) => LaunchSupervisorResponse::success(LaunchResult {
                process_id: Some(outcome.child_pid),
                session_id: outcome.session_id,
            }),
            Err(error) => LaunchSupervisorResponse::failure(error),
        };
        if publish_json(&response_path, &response).is_err() {
            return 1;
        }
        return if succeeded { 0 } else { 1 };
    }
    if result.is_ok() { 0 } else { 1 }
}

fn run_recovery_helper(library_root: &Path, session_id: &str) -> i32 {
    let _application_runtime = match application_runtime_guard() {
        Ok(guard) => guard,
        Err(_) => return 1,
    };
    match Library::open(library_root)
        .and_then(PortcoveService::new)
        .and_then(|service| service.recover_launch_session(session_id))
    {
        Ok(()) => 0,
        Err(_) => 1,
    }
}

fn start_stale_launch_recovery(library: &Library) -> portcove_core::Result<()> {
    let sessions = PortcoveService::new(library.clone())?.stale_launch_sessions()?;
    if sessions.is_empty() {
        return Ok(());
    }
    let executable = std::env::current_exe()?;
    for session in sessions {
        let mut command =
            ChildProcessPolicy::native_command(ChildProcessClass::HostIntegration, &executable)?;
        command
            .arg("--portcove-recover")
            .arg(library.root())
            .arg(&session.id)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        configure_independent_process(&mut command);
        command.spawn().map_err(|error| {
            PortcoveError::state(format!(
                "could not start recovery for launch session {}: {error}",
                session.id
            ))
        })?;
    }
    Ok(())
}

#[tauri::command]
async fn get_doctor_report(state: tauri::State<'_, DesktopState>) -> DesktopResult<DoctorReport> {
    let state = state.inner().clone();
    blocking_worker(move || {
        let preferences = state.preferences.as_ref().map_err(Clone::clone)?;
        service(&state)?
            .doctor_with_preferences(preferences)
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
async fn get_host_tools(
    state: tauri::State<'_, DesktopState>,
) -> DesktopResult<Vec<HostToolStatus>> {
    let state = state.inner().clone();
    blocking_worker(move || {
        let preferences = state.preferences.as_ref().map_err(Clone::clone)?;
        host_tools_for(preferences)
    })
    .await
}

#[tauri::command]
async fn set_host_tool_path(
    state: tauri::State<'_, DesktopState>,
    tool_id: String,
    path: PathBuf,
) -> DesktopResult<HostToolProbeResult> {
    let state = state.inner().clone();
    blocking_worker(move || {
        let preferences = state.preferences.as_ref().map_err(Clone::clone)?;
        set_host_tool_path_for(preferences, &tool_id, &path)
    })
    .await
}

#[tauri::command]
async fn clear_host_tool_path(
    state: tauri::State<'_, DesktopState>,
    tool_id: String,
) -> DesktopResult<HostToolStatus> {
    let state = state.inner().clone();
    blocking_worker(move || {
        let preferences = state.preferences.as_ref().map_err(Clone::clone)?;
        clear_host_tool_for(preferences, &tool_id)
    })
    .await
}

#[tauri::command]
async fn recheck_host_tool(
    state: tauri::State<'_, DesktopState>,
    tool_id: String,
) -> DesktopResult<HostToolProbeResult> {
    let state = state.inner().clone();
    blocking_worker(move || {
        let preferences = state.preferences.as_ref().map_err(Clone::clone)?;
        recheck_host_tool_for(preferences, &tool_id)
    })
    .await
}

#[tauri::command]
async fn open_host_tool_official_site(tool_id: String) -> DesktopResult<()> {
    let url = host_tool_official_url(&tool_id)?;
    blocking_worker(move || open_host_target(std::ffi::OsStr::new(&url))).await
}

fn host_tool_official_url(tool_id: &str) -> DesktopResult<String> {
    portcove_core::host_tool_definitions()
        .into_iter()
        .find(|definition| definition.id == tool_id)
        .map(|definition| definition.official_url)
        .ok_or_else(|| DesktopError::from(PortcoveError::usage("unknown host tool")))
}

fn host_tools_for(preferences: &HostPreferenceStore) -> DesktopResult<Vec<HostToolStatus>> {
    portcove_core::host_tool_statuses(preferences).map_err(Into::into)
}

fn set_host_tool_path_for(
    preferences: &HostPreferenceStore,
    tool_id: &str,
    path: &Path,
) -> DesktopResult<HostToolProbeResult> {
    portcove_core::configure_host_tool(preferences, tool_id, path).map_err(Into::into)
}

fn recheck_host_tool_for(
    preferences: &HostPreferenceStore,
    tool_id: &str,
) -> DesktopResult<HostToolProbeResult> {
    portcove_core::recheck_host_tool(preferences, tool_id).map_err(Into::into)
}

fn clear_host_tool_for(
    preferences: &HostPreferenceStore,
    tool_id: &str,
) -> DesktopResult<HostToolStatus> {
    portcove_core::clear_host_tool(preferences, tool_id)?;
    host_tools_for(preferences)?
        .into_iter()
        .find(|status| status.id == tool_id)
        .ok_or_else(|| PortcoveError::usage(format!("unknown host tool: {tool_id}")).into())
}

#[tauri::command]
async fn open_user_data(
    state: tauri::State<'_, DesktopState>,
    port_id: String,
) -> DesktopResult<PathBuf> {
    let state = state.inner().clone();
    blocking_service(state, move |service| {
        let path = service.port_paths(&port_id)?.user_data_root;
        std::fs::create_dir_all(&path).map_err(PortcoveError::from)?;
        open_directory(&path)?;
        Ok(path)
    })
    .await
}

#[tauri::command]
async fn open_external_url(
    state: tauri::State<'_, DesktopState>,
    url: String,
) -> DesktopResult<()> {
    let state = state.inner().clone();
    blocking_service(state, move |service| {
        validate_external_url(service.catalog().document(), &url)?;
        open_host_target(std::ffi::OsStr::new(&url))
    })
    .await
}

#[tauri::command]
async fn open_source_evidence(
    state: tauri::State<'_, DesktopState>,
    evidence_id: String,
) -> DesktopResult<()> {
    let state = state.inner().clone();
    blocking_service(state, move |service| {
        let url = resolve_source_evidence_url(service.catalog(), &evidence_id)?;
        open_host_target(std::ffi::OsStr::new(&url))
    })
    .await
}

fn resolve_source_evidence_url(
    catalog: &portcove_core::Catalog,
    evidence_id: &str,
) -> DesktopResult<String> {
    catalog
        .reviewed_source_evidence_url(evidence_id)
        .map(str::to_owned)
        .map_err(Into::into)
}

fn validate_external_url(catalog: &CatalogDocument, url: &str) -> DesktopResult<()> {
    let known = matches!(
        url,
        "https://github.com/boburning/portcove" | "https://github.com/login/device"
    ) || catalog.ports.iter().any(|port| port.project_url == url);
    if !url.starts_with("https://") || !known {
        return Err(PortcoveError::usage(
            "only reviewed project and GitHub sign-in links may be opened",
        )
        .into());
    }
    Ok(())
}

#[tauri::command]
async fn create_support_bundle(state: tauri::State<'_, DesktopState>) -> DesktopResult<PathBuf> {
    let state = state.inner().clone();
    blocking_service(state, |service| {
        diagnostics::create_support_bundle(&service).map_err(Into::into)
    })
    .await
}

#[tauri::command]
async fn export_library_metadata(
    state: tauri::State<'_, DesktopState>,
    path: PathBuf,
) -> DesktopResult<LibraryMetadataFile> {
    let state = state.inner().clone();
    blocking_service(state, move |service| {
        service.write_library_metadata(&path).map_err(Into::into)
    })
    .await
}

#[tauri::command]
fn report_frontend_error(message: String, component_stack: String) -> DesktopResult<()> {
    tracing::error!(
        operation_id = "frontend-render",
        %message,
        %component_stack,
        "frontend render failed"
    );
    Ok(())
}

fn open_directory(path: &std::path::Path) -> DesktopResult<()> {
    open_host_target(path.as_os_str())
}

fn open_host_target(target: &std::ffi::OsStr) -> DesktopResult<()> {
    #[cfg(target_os = "windows")]
    let program = "explorer.exe";
    #[cfg(target_os = "macos")]
    let program = "open";
    #[cfg(target_os = "linux")]
    let program = "xdg-open";
    ChildProcessPolicy::native_command(ChildProcessClass::HostIntegration, program)?
        .arg(target)
        .spawn()
        .map_err(|error| {
            PortcoveError::state(format!(
                "could not open {} with the system application: {error}",
                target.to_string_lossy()
            ))
        })?;
    Ok(())
}

fn initialize_desktop_at(configured_root: Option<PathBuf>) -> DesktopResult<ReadyDesktopState> {
    let selection = match configured_root {
        Some(root) => LibrarySelection {
            root,
            source: LibrarySelectionSource::Invocation,
        },
        None => LibrarySelection {
            root: Library::default_root().map_err(DesktopError::from)?,
            source: LibrarySelectionSource::PlatformDefault,
        },
    };
    initialize_desktop_selection(selection)
}

fn initialize_desktop_with(
    preferences: &HostPreferenceStore,
    configured_root: Option<PathBuf>,
) -> DesktopResult<ReadyDesktopState> {
    let default = Library::default_root().map_err(DesktopError::from)?;
    let selection = preferences
        .resolve(configured_root.as_deref(), &default)
        .map_err(DesktopError::from)?;
    initialize_desktop_selection(selection)
}

fn host_preference_store() -> DesktopResult<HostPreferenceStore> {
    HostPreferenceStore::open_configured().map_err(DesktopError::from)
}

fn application_runtime_guard() -> portcove_core::Result<ApplicationRuntimeGuard> {
    ApplicationRuntimeGuard::acquire(&HostPreferenceStore::application_runtime_lock_path()?)
}

fn initialize_desktop_selection(selection: LibrarySelection) -> DesktopResult<ReadyDesktopState> {
    let library = Library::open(&selection.root).map_err(DesktopError::from)?;
    start_stale_launch_recovery(&library).map_err(DesktopError::from)?;
    let releases = std::sync::Arc::new(
        CompositeReleaseProvider::for_library(&library).map_err(DesktopError::from)?,
    );
    let github = releases.github();
    Ok(ReadyDesktopState {
        library,
        selection,
        github,
        releases,
    })
}

pub fn run() {
    let preferences = host_preference_store();
    let application_runtime = preferences.as_ref().map_err(Clone::clone).and_then(|_| {
        HostPreferenceStore::application_runtime_lock_path()
            .and_then(|path| ApplicationRuntimeGuard::acquire(&path))
            .map_err(DesktopError::from)
    });
    let _application_runtime = match application_runtime {
        Ok(guard) => guard,
        Err(error) => {
            eprintln!(
                "Portcove desktop could not acquire its runtime lease: {}",
                error.message
            );
            return;
        }
    };
    let configured_root = std::env::var_os("PORTCOVE_LIBRARY")
        .filter(|path| !path.is_empty())
        .map(PathBuf::from);
    let initialization_result = preferences
        .as_ref()
        .map_err(Clone::clone)
        .and_then(|store| initialize_desktop_with(store, configured_root));
    let initialization = std::sync::Arc::new(std::sync::Mutex::new(
        initialization_result.and_then(|state| {
            diagnostics::initialize(&state.library.logs_dir()).map_err(DesktopError::from)?;
            tracing::info!(
                operation_id = "desktop-startup",
                library_root = %state.library.root().display(),
                "desktop diagnostics initialized"
            );
            Ok(state)
        }),
    ));
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(application_update_preferences::configured_state())
        .manage(application_update_status::configured_state())
        .manage(DesktopState {
            initialization,
            preferences,
            generation: std::sync::Arc::new(std::sync::atomic::AtomicU64::new(1)),
            launch_observer: std::sync::Arc::new(std::sync::Mutex::new(None)),
        })
        .invoke_handler(tauri::generate_handler![
            get_bootstrap_status,
            application_update_preferences::get_application_update_preferences,
            application_update_preferences::set_application_update_preferences,
            application_update_preferences::reset_application_update_preferences,
            application_update_preferences::recover_application_update_preferences,
            application_update_status::get_application_update_status,
            application_update_status::recover_application_update_state,
            cli_context::get_cli_command_context,
            library_selection::get_library_identity,
            library_selection::set_default_library,
            library_selection::reset_default_library,
            get_github_auth_status,
            plan_port,
            set_github_token,
            logout_github,
            begin_github_device_login,
            poll_github_device_login,
            get_catalog,
            catalog::get_catalog_status,
            catalog::get_engine_capabilities,
            catalog::check_definition_capabilities,
            catalog::trust_catalog_key,
            catalog::revoke_catalog_key,
            catalog::plan_catalog_update,
            catalog::apply_catalog_update,
            catalog::rollback_catalog,
            catalog::use_embedded_catalog,
            catalog::use_cached_catalog,
            get_statuses,
            output_location::get_output_location,
            preparation::plan_preparation,
            preparation::prepare_port,
            game_updates::plan_game_update,
            game_updates::apply_game_update,
            output_location::preview_output_location,
            output_location::set_output_location,
            output_location::reset_output_location,
            output_location::plan_output_relocation,
            output_location::relocate_output,
            output_location::get_output_relocation_status,
            get_sources,
            get_activities,
            get_activity_diagnostic,
            cancel_operation,
            get_backups,
            create_backup,
            backup_review::preview_backup_action,
            artwork::get_artwork,
            artwork::get_artwork_thumbnail,
            artwork::import_artwork,
            artwork::reset_artwork,
            backup_review::restore_backup,
            backup_review::delete_backup,
            verify_source,
            inspect_source,
            inspect_source_intake,
            plan_source_relink,
            relink_source,
            verify_sources,
            check_port,
            check_installed,
            reconcile_installed,
            add_source,
            discover_sources,
            get_source_inbox_paths,
            open_source_inbox,
            scan_source_inbox,
            plan_source_import,
            import_source,
            source_removal::preview_source_removal,
            source_removal::remove_source,
            set_channel,
            set_policy,
            install_port,
            update_port,
            verify_port,
            activate_port,
            rollback_port,
            adoption::preview_adoption,
            adoption::adopt_port,
            removal::preview_removal,
            removal::remove_port,
            launch_port,
            get_doctor_report,
            get_host_tools,
            set_host_tool_path,
            clear_host_tool_path,
            recheck_host_tool,
            open_host_tool_official_site,
            open_user_data,
            open_external_url,
            open_source_evidence,
            create_support_bundle,
            export_library_metadata,
            library_transfer::plan_library_move,
            library_transfer::plan_library_import,
            library_transfer::import_library,
            library_transfer::recover_library_import,
            library_transfer::move_library,
            library_transfer::recover_library_move,
            report_frontend_error,
        ])
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                window.set_focus()?;
            }
            let state = app.state::<DesktopState>();
            if let Ok(ready_state) = ready(&state) {
                for session in ready_state.library.launch_sessions()? {
                    observe_launch_completion(
                        app.handle(),
                        state.inner(),
                        ready_state.library.clone(),
                        session.id,
                    )
                    .map_err(|error| std::io::Error::other(error.message))?;
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .unwrap_or_else(|error| eprintln!("Portcove desktop stopped: {error}"));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn storage_commands_reject_a_stale_library_generation() {
        assert!(require_library_generation(7, 7).is_ok());
        let error = require_library_generation(8, 7).unwrap_err();
        assert_eq!(error.code, portcove_core::ErrorCode::Conflict);
        assert!(error.message.contains("open library changed"));
    }

    #[test]
    fn launch_acceptance_can_arrive_after_the_former_five_minute_deadline() {
        let elapsed = std::cell::Cell::new(Duration::ZERO);

        let result = wait_for_launch_acceptance(
            || {
                Ok((elapsed.get() >= Duration::from_secs(301)).then(|| {
                    LaunchSupervisorResponse::success(LaunchResult {
                        process_id: None,
                        session_id: "durable-request".into(),
                    })
                }))
            },
            || Ok(None),
            || elapsed.set(elapsed.get() + LAUNCH_ACCEPTANCE_POLL_INTERVAL),
        )
        .unwrap();

        assert_eq!(result.session_id, "durable-request");
        assert!(elapsed.get() > Duration::from_secs(300));
    }

    #[test]
    fn concurrent_launch_observation_is_linear_and_coalesces_completion() {
        let mut pending = (0_u32..16).collect::<Vec<_>>();
        let queries = std::cell::Cell::new(0_u32);

        let completed = retain_launch_observations(&mut pending, |request| {
            queries.set(queries.get() + 1);
            match request % 4 {
                0 => LaunchObservationState::Complete,
                1 => LaunchObservationState::Retry,
                _ => LaunchObservationState::Active,
            }
        });

        assert!(completed);
        assert_eq!(queries.get(), 16);
        assert_eq!(pending.len(), 12);
    }

    #[test]
    fn external_links_are_limited_to_reviewed_https_destinations() {
        let catalog = portcove_core::Catalog::embedded().unwrap();
        for url in [
            "https://github.com/boburning/portcove",
            "https://github.com/login/device",
            &catalog.document().ports[0].project_url,
        ] {
            validate_external_url(catalog.document(), url).unwrap();
        }
        for url in [
            "file:///C:/Windows",
            "javascript:alert(1)",
            "https://example.com",
            "https://github.com/login/device?redirect=elsewhere",
            "https://github.com/boburning/portcove.evil",
        ] {
            assert!(
                validate_external_url(catalog.document(), url).is_err(),
                "{url}"
            );
        }
    }

    #[test]
    fn source_evidence_navigation_accepts_only_an_active_catalog_id() {
        let catalog = portcove_core::Catalog::embedded().unwrap();
        let evidence = &catalog.source_catalog().unwrap().evidence[0];
        assert_eq!(
            resolve_source_evidence_url(&catalog, &evidence.id).unwrap(),
            evidence.immutable_url
        );
        for renderer_input in [
            evidence.immutable_url.as_str(),
            evidence
                .live_url
                .as_deref()
                .unwrap_or("https://example.invalid/live"),
            "https://attacker.invalid/reviewed-looking-link",
            "file:///C:/Windows",
            "stale-evidence-id",
        ] {
            assert!(
                resolve_source_evidence_url(&catalog, renderer_input).is_err(),
                "renderer input unexpectedly resolved: {renderer_input}"
            );
        }
    }

    #[test]
    fn desktop_source_inspection_is_the_exact_core_result() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let selected = temporary.path().join("source.z64");
        std::fs::write(&selected, b"adapter parity source").unwrap();
        let service = PortcoveService::new(library).unwrap();
        service.register_source("star-fox-64", &selected).unwrap();

        let core = service.inspect_registered_source("star-fox-64").unwrap();
        let desktop = inspect_source_with_service(&service, "star-fox-64").unwrap();
        assert_eq!(
            serde_json::to_value(desktop).unwrap(),
            serde_json::to_value(core).unwrap()
        );
    }

    #[test]
    fn desktop_statuses_are_the_exact_core_results() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let service = PortcoveService::new(library).unwrap();

        let core = service.statuses().unwrap();
        let desktop = statuses_with_service(&service).unwrap();

        assert_eq!(
            serde_json::to_value(desktop).unwrap(),
            serde_json::to_value(core).unwrap()
        );
    }

    #[test]
    fn desktop_source_intake_is_the_exact_read_only_core_result() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let selected = temporary.path().join("source.z64");
        fs::write(&selected, b"desktop read-only intake source").unwrap();
        let before = fs::read(&selected).unwrap();
        let service = PortcoveService::new(library.clone()).unwrap();
        let paths = vec![selected.clone()];

        let core = service
            .inspect_source_intake("star-fox-64", &paths)
            .unwrap();
        let desktop = inspect_source_intake_with_service(&service, "star-fox-64", &paths).unwrap();
        assert_eq!(
            serde_json::to_value(desktop).unwrap(),
            serde_json::to_value(core).unwrap()
        );
        assert!(library.sources().unwrap().is_empty());
        assert_eq!(fs::read(selected).unwrap(), before);
    }

    #[test]
    fn desktop_source_inbox_adapters_preserve_core_results_and_activity_ids() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let service = PortcoveService::new(library.clone()).unwrap();
        let profile = "opengoal-jak1-disc";

        let mut scan_events = Vec::new();
        let scan = scan_source_inbox_for(
            &service,
            profile,
            &SourceDiscoveryLimits::default(),
            |event| scan_events.push(event),
        )
        .unwrap();
        assert_eq!(scan_events[0].operation_id, scan.operation_id);
        assert_eq!(
            library
                .activities(10)
                .unwrap()
                .into_iter()
                .find(|activity| activity.id == scan.operation_id)
                .unwrap()
                .operation,
            portcove_core::ActivityOperation::DiscoverSources
        );

        let source = temporary.path().join("selected.iso");
        fs::write(&source, b"desktop adapter source import").unwrap();
        let core_plan = service
            .plan_source_import(profile, &source, SourceImportMode::Copy)
            .unwrap();
        let desktop_plan =
            plan_source_import_for(&service, profile, &source, SourceImportMode::Copy).unwrap();
        let mut desktop_plan_json = serde_json::to_value(&desktop_plan).unwrap();
        let mut core_plan_json = serde_json::to_value(&core_plan).unwrap();
        desktop_plan_json["source"]["updated_at"] = serde_json::Value::Null;
        core_plan_json["source"]["updated_at"] = serde_json::Value::Null;
        assert_eq!(desktop_plan_json, core_plan_json);
        let mut import_events = Vec::new();
        let imported = import_source_for(
            &service,
            profile,
            &source,
            SourceImportMode::Copy,
            &desktop_plan.plan_sha256,
            false,
            |event| import_events.push(event),
        )
        .unwrap();
        assert_eq!(import_events[0].operation_id, imported.import_id);
        assert_eq!(
            library.source(profile).unwrap().unwrap().path,
            imported.registered.path
        );

        let move_source = temporary.path().join("move.iso");
        fs::write(&move_source, b"desktop unauthorized move").unwrap();
        let move_plan = service
            .plan_source_import(profile, &move_source, SourceImportMode::Move)
            .unwrap();
        let error = import_source_for(
            &service,
            profile,
            &move_source,
            SourceImportMode::Move,
            &move_plan.plan_sha256,
            false,
            |_| {},
        )
        .unwrap_err();
        assert_eq!(error.code, portcove_core::ErrorCode::Conflict);
        assert!(move_source.exists());
    }

    #[test]
    fn disc_tool_navigation_uses_only_fixed_registry_ids() {
        assert_eq!(
            host_tool_official_url("chdman").unwrap(),
            "https://docs.mamedev.org/tools/chdman.html"
        );
        assert_eq!(
            host_tool_official_url("dolphin_tool").unwrap(),
            "https://dolphin-emu.org/download/"
        );
        for supplied in [
            "https://example.com",
            "chdman?redirect=https://example.com",
            "unknown",
        ] {
            assert!(host_tool_official_url(supplied).is_err());
        }
    }

    #[test]
    fn disc_tool_controls_are_library_free_and_unknown_ids_do_not_mutate_preferences() {
        let temporary = tempfile::tempdir().unwrap();
        let preference_path = temporary.path().join("preferences.json");
        let preferences = HostPreferenceStore::new(preference_path.clone()).unwrap();

        let tools = host_tools_for(&preferences).unwrap();
        assert_eq!(tools.len(), 2);
        assert!(tools.iter().any(|tool| tool.id == "chdman"));
        assert!(tools.iter().any(|tool| tool.id == "dolphin_tool"));
        assert!(!preference_path.exists());

        let error = clear_host_tool_for(&preferences, "https://example.com").unwrap_err();
        assert_eq!(error.code, portcove_core::ErrorCode::Usage);
        assert!(!preference_path.exists());

        let source = temporary.path().join("host_tool_probe.rs");
        fs::write(
            &source,
            include_str!("../../../../crates/portcove-core/src/testdata/host_tool_probe.rs.txt"),
        )
        .unwrap();
        let executable = temporary.path().join(if cfg!(windows) {
            "chdman-fixture.exe"
        } else {
            "chdman-fixture"
        });
        let mut rustc =
            ChildProcessPolicy::native_command(ChildProcessClass::ManagedBuilder, "rustc").unwrap();
        let compiled = rustc
            .arg(&source)
            .arg("-o")
            .arg(&executable)
            .output()
            .unwrap();
        assert!(
            compiled.status.success(),
            "fixture compilation failed: {}",
            String::from_utf8_lossy(&compiled.stderr)
        );

        let configured = set_host_tool_path_for(&preferences, "chdman", &executable).unwrap();
        assert_eq!(configured.state, portcove_core::HostToolProbeState::Success);
        assert!(configured.persisted);

        let restarted = HostPreferenceStore::new(preference_path).unwrap();
        let status = host_tools_for(&restarted)
            .unwrap()
            .into_iter()
            .find(|tool| tool.id == "chdman")
            .unwrap();
        assert_eq!(status.source, Some(portcove_core::HostToolSource::Saved));
        let checked = recheck_host_tool_for(&restarted, "chdman").unwrap();
        assert_eq!(checked.state, portcove_core::HostToolProbeState::Success);
        assert!(checked.clear_action_available);

        fs::write(&executable, b"changed after selection").unwrap();
        let changed = recheck_host_tool_for(&restarted, "chdman").unwrap();
        assert_eq!(changed.state, portcove_core::HostToolProbeState::Invalid);
        assert!(changed.clear_action_available);
        assert_eq!(
            restarted.host_tool_path("chdman").unwrap(),
            Some(executable)
        );

        let cleared = clear_host_tool_for(&restarted, "chdman").unwrap();
        assert_ne!(cleared.source, Some(portcove_core::HostToolSource::Saved));
    }

    #[test]
    fn invalid_library_initialization_becomes_a_recoverable_desktop_state() {
        let temporary = tempfile::tempdir().unwrap();
        let blocked = temporary.path().join("not-a-directory");
        fs::write(&blocked, b"file blocks the configured library directory").unwrap();
        let error = match initialize_desktop_at(Some(blocked.clone())) {
            Ok(_) => panic!("a file cannot be opened as a Portcove library"),
            Err(error) => error,
        };
        let state = DesktopState {
            initialization: std::sync::Arc::new(std::sync::Mutex::new(Err(error.clone()))),
            preferences: HostPreferenceStore::new(temporary.path().join("preferences.json"))
                .map_err(DesktopError::from),
            generation: std::sync::Arc::new(std::sync::atomic::AtomicU64::new(1)),
            launch_observer: std::sync::Arc::new(std::sync::Mutex::new(None)),
        };

        let status = bootstrap_status(&state);

        assert!(!status.ready);
        assert_eq!(status.error.unwrap().message, error.message);
        assert!(status.library_root.is_none());
        assert!(service(&state).is_err());
        assert_eq!(
            fs::read(blocked).unwrap(),
            b"file blocks the configured library directory"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn blocking_worker_keeps_the_ipc_runtime_responsive() {
        let (started, observed_start) = tokio::sync::oneshot::channel();
        let worker = tokio::spawn(blocking_worker(move || {
            let _ = started.send(());
            thread::sleep(Duration::from_millis(75));
            Ok(7_u8)
        }));
        observed_start.await.unwrap();

        tokio::time::timeout(
            Duration::from_millis(30),
            tokio::time::sleep(Duration::from_millis(5)),
        )
        .await
        .expect("a blocking filesystem phase must not occupy the IPC runtime");
        assert!(!worker.is_finished());
        assert_eq!(worker.await.unwrap().unwrap(), 7);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn cancelling_an_ipc_waiter_does_not_interrupt_inflight_worker_mutation() {
        let (started, observed_start) = tokio::sync::oneshot::channel();
        let (finished, observed_finish) = std::sync::mpsc::channel();
        let waiter = tokio::spawn(blocking_worker(move || {
            let _ = started.send(());
            thread::sleep(Duration::from_millis(40));
            finished.send(()).unwrap();
            Ok(())
        }));
        observed_start.await.unwrap();

        waiter.abort();
        assert!(waiter.await.unwrap_err().is_cancelled());
        observed_finish
            .recv_timeout(Duration::from_secs(1))
            .expect("the lifecycle worker must finish after its IPC waiter is cancelled");
    }
}
