mod diagnostics;
mod library_transfer;

use std::{
    fs,
    future::Future,
    path::{Path, PathBuf},
    process::Stdio,
    thread,
    time::{Duration, Instant},
};

use portcove_core::{
    ActivityRecord, AdoptionPreview, BackupAction, BackupRecord, CatalogDocument,
    ChildProcessClass, ChildProcessPolicy, CompositeReleaseProvider, DoctorReport,
    GithubAuthStatus, GithubDeviceLogin, GithubDeviceLoginResult, GithubReleaseProvider,
    InstallPlan, InstallRecord, LaunchStdio, Library, LibraryMetadataFile, OperationCoordinator,
    OperationEvent, OperationResult, PortStatus, PortcoveError, PortcoveService, ReconcileResult,
    ReleaseChannel, ReleaseProvider, RestoreResult, SourceRecord, SourceRelinkPlan,
    SourceRemovalPreview, SourceVerification, UpdateCheck, UpdatePolicy, VerificationReport,
};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

#[derive(Clone)]
struct ReadyDesktopState {
    library: Library,
    github: std::sync::Arc<GithubReleaseProvider>,
    releases: std::sync::Arc<CompositeReleaseProvider>,
}

#[derive(Clone)]
struct DesktopState {
    initialization: std::sync::Arc<std::sync::Mutex<DesktopResult<ReadyDesktopState>>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DesktopError {
    code: portcove_core::ErrorCode,
    message: String,
    details: std::collections::BTreeMap<String, String>,
}

#[derive(Debug, Serialize)]
struct BatchOutcome<T> {
    port_id: String,
    ok: bool,
    result: Option<T>,
    error: Option<DesktopError>,
}

#[derive(Debug, Serialize)]
struct SourceBatchOutcome {
    profile_id: String,
    ok: bool,
    result: Option<SourceVerification>,
    error: Option<DesktopError>,
}

impl From<PortcoveError> for DesktopError {
    fn from(error: PortcoveError) -> Self {
        Self {
            code: error.code,
            message: error.message,
            details: error.details,
        }
    }
}

type DesktopResult<T> = std::result::Result<T, DesktopError>;

fn ready(state: &DesktopState) -> DesktopResult<ReadyDesktopState> {
    state
        .initialization
        .lock()
        .map_err(|_| DesktopError::from(PortcoveError::state("desktop state lock was poisoned")))?
        .clone()
}

fn service(state: &DesktopState) -> DesktopResult<PortcoveService> {
    let state = ready(state)?;
    let releases: std::sync::Arc<dyn ReleaseProvider> = state.releases.clone();
    PortcoveService::with_provider(state.library.clone(), releases).map_err(Into::into)
}

#[derive(Debug, Clone, Serialize)]
struct BootstrapStatus {
    ready: bool,
    library_root: Option<PathBuf>,
    error: Option<DesktopError>,
}

#[tauri::command]
fn get_bootstrap_status(state: tauri::State<'_, DesktopState>) -> BootstrapStatus {
    bootstrap_status(&state)
}

fn bootstrap_status(state: &DesktopState) -> BootstrapStatus {
    match ready(state) {
        Ok(state) => BootstrapStatus {
            ready: true,
            library_root: Some(state.library.root().to_path_buf()),
            error: None,
        },
        Err(error) => BootstrapStatus {
            ready: false,
            library_root: None,
            error: Some(error),
        },
    }
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
    blocking_service(state, |service| service.statuses().map_err(Into::into)).await
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
async fn get_backups(
    state: tauri::State<'_, DesktopState>,
    port_id: String,
) -> DesktopResult<Vec<BackupRecord>> {
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
async fn restore_backup(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    backup_id: String,
) -> DesktopResult<Option<RestoreResult>> {
    let worker_state = state.inner().clone();
    let preview = blocking_service(worker_state, {
        let port_id = port_id.clone();
        let backup_id = backup_id.clone();
        move |service| {
            service
                .preview_backup_action(&port_id, &backup_id, BackupAction::Restore)
                .map_err(Into::into)
        }
    })
    .await?;
    let message = if preview.safety_backup_will_be_created {
        format!(
            "Restore backup {backup_id} for {port_id}?\n\nPortcove will preserve the current persistent data as a safety backup first."
        )
    } else {
        format!("Restore backup {backup_id} for {port_id}?")
    };
    if !confirm_destructive(&app, "Confirm backup restore", message, "Restore backup").await {
        return Ok(None);
    }
    let state = state.inner().clone();
    blocking_service(state, move |service| {
        let authorization = service.authorize_backup_action(
            &port_id,
            &backup_id,
            BackupAction::Restore,
            &preview.preview_sha256,
        )?;
        service
            .restore_backup(&port_id, &backup_id, &authorization.token)
            .map(Some)
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
async fn delete_backup(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    backup_id: String,
) -> DesktopResult<Option<BackupRecord>> {
    let worker_state = state.inner().clone();
    let preview = blocking_service(worker_state, {
        let port_id = port_id.clone();
        let backup_id = backup_id.clone();
        move |service| {
            service
                .preview_backup_action(&port_id, &backup_id, BackupAction::Delete)
                .map_err(Into::into)
        }
    })
    .await?;
    if !confirm_destructive(
        &app,
        "Confirm backup deletion",
        format!(
            "Permanently delete backup {backup_id} for {port_id}?\n\nThis backup cannot be recovered after deletion."
        ),
        "Delete backup",
    )
    .await
    {
        return Ok(None);
    }
    let state = state.inner().clone();
    blocking_service(state, move |service| {
        let authorization = service.authorize_backup_action(
            &port_id,
            &backup_id,
            BackupAction::Delete,
            &preview.preview_sha256,
        )?;
        service
            .delete_backup(&port_id, &backup_id, &authorization.token)
            .map(Some)
            .map_err(Into::into)
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
) -> DesktopResult<UpdateCheck> {
    let state = state.inner().clone();
    blocking_async_service(state, move |service| async move {
        service.check_update(&port_id).await.map_err(Into::into)
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
) -> DesktopResult<SourceRecord> {
    let state = state.inner().clone();
    blocking_service(state, move |service| {
        service
            .register_source(&profile_id, &path)
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
async fn preview_source_removal(
    state: tauri::State<'_, DesktopState>,
    profile_id: String,
) -> DesktopResult<SourceRemovalPreview> {
    let state = state.inner().clone();
    blocking_service(state, move |service| {
        service
            .preview_source_removal(&profile_id)
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
async fn remove_source(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
    profile_id: String,
    preview_sha256: String,
) -> DesktopResult<Option<SourceRemovalPreview>> {
    let worker_state = state.inner().clone();
    let preview = blocking_service(worker_state, {
        let profile_id = profile_id.clone();
        move |service| {
            service
                .preview_source_removal(&profile_id)
                .map_err(Into::into)
        }
    })
    .await?;
    if preview.preview_sha256 != preview_sha256 {
        return Err(PortcoveError::conflict(
            "the source or its installed dependents changed after the removal preview",
        )
        .into());
    }
    let impact = if preview.installed_dependent_port_ids.is_empty() {
        "No installed port currently depends on it.".to_owned()
    } else {
        format!(
            "Installed ports will lose this source dependency: {}.",
            preview.installed_dependent_port_ids.join(", ")
        )
    };
    if !confirm_destructive(
        &app,
        "Confirm source removal",
        format!(
            "Remove registered source {profile_id}?\n\n{impact} The source file itself will not be deleted."
        ),
        "Remove source reference",
    )
    .await
    {
        return Ok(None);
    }
    let state = state.inner().clone();
    blocking_service(state, move |service| {
        let authorization = service.authorize_source_removal(&profile_id, &preview_sha256)?;
        service
            .remove_source(&profile_id, &authorization.token)
            .map(Some)
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
async fn set_channel(
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    channel: ReleaseChannel,
) -> DesktopResult<PortStatus> {
    let state = state.inner().clone();
    blocking_service(state, move |service| {
        service.set_channel(&port_id, channel).map_err(Into::into)
    })
    .await
}

#[tauri::command]
async fn set_policy(
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    policy: UpdatePolicy,
) -> DesktopResult<PortStatus> {
    let state = state.inner().clone();
    blocking_service(state, move |service| {
        service
            .set_update_policy(&port_id, policy)
            .map_err(Into::into)
    })
    .await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstallInput {
    port_id: String,
    channel: Option<ReleaseChannel>,
    source: Option<PathBuf>,
    bios: Option<PathBuf>,
    stage: bool,
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
) -> DesktopResult<InstallRecord> {
    let state = state.inner().clone();
    blocking_service(state, move |service| {
        service.activate_staged(&port_id).map_err(Into::into)
    })
    .await
}

#[tauri::command]
async fn preview_adoption(
    state: tauri::State<'_, DesktopState>,
    path: PathBuf,
    port_id: Option<String>,
) -> DesktopResult<AdoptionPreview> {
    let state = state.inner().clone();
    blocking_service(state, move |service| {
        service
            .preview_adoption(&path, port_id.as_deref())
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
async fn adopt_port(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
    path: PathBuf,
    port_id: Option<String>,
    plan_sha256: String,
) -> DesktopResult<Option<InstallRecord>> {
    let worker_state = state.inner().clone();
    let preview = blocking_service(worker_state, {
        let path = path.clone();
        let port_id = port_id.clone();
        move |service| {
            service
                .preview_adoption(&path, port_id.as_deref())
                .map_err(Into::into)
        }
    })
    .await?;
    if preview.plan_sha256 != plan_sha256 {
        return Err(PortcoveError::conflict(
            "adoption contents changed after preview; review the copy plan again",
        )
        .into());
    }
    let skipped = preview.copy_plan.skipped_entries.len();
    let message = format!(
        "Copy {} files ({} bytes) into Portcove?\n\n{} skipped entr{} will remain only in the original folder. The original folder will not be modified.",
        preview.copy_plan.files.len(),
        preview.copy_plan.total_bytes,
        skipped,
        if skipped == 1 { "y" } else { "ies" },
    );
    if !confirm_destructive(&app, "Confirm adoption", message, "Copy into Portcove").await {
        return Ok(None);
    }
    let state = state.inner().clone();
    blocking_service(state, move |service| {
        let authorization = service.authorize_adoption(&path, port_id.as_deref(), &plan_sha256)?;
        service
            .adopt(&path, port_id.as_deref(), &authorization.token)
            .map(Some)
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
async fn remove_port(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
    port_id: String,
) -> DesktopResult<Option<Vec<PathBuf>>> {
    let worker_state = state.inner().clone();
    let preview = blocking_service(worker_state, {
        let port_id = port_id.clone();
        move |service| service.preview_removal(&port_id).map_err(Into::into)
    })
    .await?;
    let message = format!(
        "Remove {} managed version director{} for {}?\n\nPersistent data at {} will be preserved.",
        preview.managed_paths.len(),
        if preview.managed_paths.len() == 1 {
            "y"
        } else {
            "ies"
        },
        port_id,
        preview.persistent_data_path.display(),
    );
    if !confirm_destructive(
        &app,
        "Confirm port removal",
        message,
        "Remove managed versions",
    )
    .await
    {
        return Ok(None);
    }
    let state = state.inner().clone();
    blocking_service(state, move |service| {
        let authorization = service.authorize_removal(&port_id, &preview.preview_sha256)?;
        service
            .remove(&port_id, &authorization.token)
            .map(Some)
            .map_err(Into::into)
    })
    .await
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LaunchResult {
    process_id: u32,
    session_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct LaunchSupervisorRequest {
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
    let result = tauri::async_runtime::spawn_blocking(move || {
        request_supervised_launch(&library, port_id, source, arguments)
    })
    .await
    .map_err(|error| DesktopError::from(PortcoveError::state(error.to_string())))??;
    let observed_session = result.session_id.clone();
    let observed_library = ready(&state)?.library.clone();
    thread::spawn(move || {
        loop {
            match observed_library.launch_sessions() {
                Ok(sessions)
                    if sessions
                        .iter()
                        .any(|session| session.id == observed_session) =>
                {
                    thread::sleep(Duration::from_millis(250));
                }
                _ => break,
            }
        }
        let _ = app.emit("portcove://library-changed", ());
    });
    Ok(result)
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
    let deadline = Instant::now() + Duration::from_secs(300);
    loop {
        if response_path.is_file() {
            let response: LaunchSupervisorResponse =
                serde_json::from_slice(&fs::read(&response_path).map_err(PortcoveError::from)?)
                    .map_err(PortcoveError::from)?;
            let _ = fs::remove_file(&response_path);
            return match (response.result, response.error) {
                (Some(result), None) => Ok(result),
                (None, Some(error)) => Err(error),
                _ => Err(
                    PortcoveError::state("launch supervisor returned an invalid response").into(),
                ),
            };
        }
        if let Some(status) = supervisor.try_wait().map_err(PortcoveError::from)? {
            let _ = fs::remove_file(&request_path);
            return Err(PortcoveError::launch(format!(
                "launch supervisor exited before starting the game ({status})"
            ))
            .into());
        }
        if Instant::now() >= deadline {
            return Err(PortcoveError::launch(
                "launch supervisor did not report a child process within five minutes",
            )
            .into());
        }
        thread::sleep(Duration::from_millis(25));
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
    let response_path = response_path_for(request_path);
    let request = fs::read(request_path)
        .map_err(PortcoveError::from)
        .and_then(|bytes| {
            serde_json::from_slice::<LaunchSupervisorRequest>(&bytes).map_err(Into::into)
        });
    let _ = fs::remove_file(request_path);
    let request = match request {
        Ok(request) => request,
        Err(error) => {
            let _ = publish_json(&response_path, &LaunchSupervisorResponse::failure(error));
            return 1;
        }
    };
    let mut response_written = false;
    let result = Library::open(&request.library_root)
        .and_then(PortcoveService::new)
        .and_then(|service| {
            service.supervise_launch(
                &request.port_id,
                request.source.as_deref(),
                &request.arguments,
                LaunchStdio::Null,
                |session| {
                    if let Some(process_id) = session.child_pid {
                        response_written = publish_json(
                            &response_path,
                            &LaunchSupervisorResponse::success(LaunchResult {
                                process_id,
                                session_id: session.id.clone(),
                            }),
                        )
                        .is_ok();
                    }
                },
            )
        });
    if !response_written {
        let succeeded = result.is_ok();
        let response = match result {
            Ok(outcome) => LaunchSupervisorResponse::success(LaunchResult {
                process_id: outcome.child_pid,
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
    blocking_service(state, |service| service.doctor().map_err(Into::into)).await
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

fn initialize_desktop() -> DesktopResult<ReadyDesktopState> {
    let configured_root = std::env::var_os("PORTCOVE_LIBRARY")
        .filter(|path| !path.is_empty())
        .map(PathBuf::from);
    initialize_desktop_at(configured_root)
}

fn initialize_desktop_at(configured_root: Option<PathBuf>) -> DesktopResult<ReadyDesktopState> {
    let library = configured_root
        .map(Library::open)
        .unwrap_or_else(Library::open_default)
        .map_err(DesktopError::from)?;
    start_stale_launch_recovery(&library).map_err(DesktopError::from)?;
    let releases = std::sync::Arc::new(
        CompositeReleaseProvider::for_library(&library).map_err(DesktopError::from)?,
    );
    let github = releases.github();
    Ok(ReadyDesktopState {
        library,
        github,
        releases,
    })
}

pub fn run() {
    let initialization = std::sync::Arc::new(std::sync::Mutex::new(initialize_desktop().and_then(
        |state| {
            diagnostics::initialize(&state.library.logs_dir()).map_err(DesktopError::from)?;
            tracing::info!(
                operation_id = "desktop-startup",
                library_root = %state.library.root().display(),
                "desktop diagnostics initialized"
            );
            Ok(state)
        },
    )));
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(DesktopState { initialization })
        .invoke_handler(tauri::generate_handler![
            get_bootstrap_status,
            get_github_auth_status,
            plan_port,
            set_github_token,
            logout_github,
            begin_github_device_login,
            poll_github_device_login,
            get_catalog,
            get_statuses,
            get_sources,
            get_activities,
            get_backups,
            create_backup,
            restore_backup,
            delete_backup,
            verify_source,
            plan_source_relink,
            relink_source,
            verify_sources,
            check_port,
            check_installed,
            reconcile_installed,
            add_source,
            preview_source_removal,
            remove_source,
            set_channel,
            set_policy,
            install_port,
            update_port,
            verify_port,
            activate_port,
            rollback_port,
            preview_adoption,
            adopt_port,
            remove_port,
            launch_port,
            get_doctor_report,
            open_user_data,
            open_external_url,
            create_support_bundle,
            export_library_metadata,
            library_transfer::plan_library_move,
            library_transfer::move_library,
            library_transfer::recover_library_move,
            report_frontend_error,
        ])
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                window.set_focus()?;
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
