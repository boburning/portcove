use std::{
    path::PathBuf,
    process::{Command, Stdio},
};

use portcove_core::{
    ActivityRecord, AdoptionPreview, BackupRecord, CatalogDocument, CompositeReleaseProvider,
    GithubAuthStatus, GithubDeviceLogin, GithubDeviceLoginResult, GithubReleaseProvider,
    InstallPlan, InstallRecord, Library, OperationEvent, PortStatus, PortcoveError,
    PortcoveService, ReconcileResult, ReleaseChannel, ReleaseProvider, RestoreResult, SourceRecord,
    SourceVerification, StorageSummary, UpdateCheck, UpdatePolicy, VerificationReport,
};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

#[derive(Clone)]
struct DesktopState {
    library: Library,
    github: std::sync::Arc<GithubReleaseProvider>,
    releases: std::sync::Arc<CompositeReleaseProvider>,
}

#[derive(Debug, Serialize)]
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

fn service(state: &DesktopState) -> DesktopResult<PortcoveService> {
    let releases: std::sync::Arc<dyn ReleaseProvider> = state.releases.clone();
    PortcoveService::with_provider(state.library.clone(), releases).map_err(Into::into)
}

async fn blocking_service<T, F>(state: DesktopState, operation: F) -> DesktopResult<T>
where
    T: Send + 'static,
    F: FnOnce(PortcoveService) -> DesktopResult<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || operation(service(&state)?))
        .await
        .map_err(|error| DesktopError::from(PortcoveError::state(error.to_string())))?
}

#[tauri::command]
async fn get_github_auth_status(
    state: tauri::State<'_, DesktopState>,
) -> DesktopResult<GithubAuthStatus> {
    state.github.auth_status().await.map_err(Into::into)
}

#[tauri::command]
async fn plan_port(
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    channel: ReleaseChannel,
) -> DesktopResult<InstallPlan> {
    service(&state)?
        .plan_install(&port_id, Some(channel))
        .await
        .map_err(Into::into)
}

#[tauri::command]
async fn set_github_token(
    state: tauri::State<'_, DesktopState>,
    token: String,
) -> DesktopResult<GithubAuthStatus> {
    state
        .github
        .store_personal_token(&token)
        .await
        .map_err(Into::into)
}

#[tauri::command]
async fn logout_github(state: tauri::State<'_, DesktopState>) -> DesktopResult<GithubAuthStatus> {
    state.github.logout().await.map_err(Into::into)
}

#[tauri::command]
async fn begin_github_device_login(
    state: tauri::State<'_, DesktopState>,
) -> DesktopResult<GithubDeviceLogin> {
    state.github.begin_device_login().await.map_err(Into::into)
}

#[tauri::command]
async fn poll_github_device_login(
    state: tauri::State<'_, DesktopState>,
    session_id: String,
) -> DesktopResult<GithubDeviceLoginResult> {
    state
        .github
        .poll_device_login(&session_id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
fn get_catalog(state: tauri::State<'_, DesktopState>) -> DesktopResult<CatalogDocument> {
    Ok(service(&state)?.catalog().document().clone())
}

#[tauri::command]
fn get_statuses(state: tauri::State<'_, DesktopState>) -> DesktopResult<Vec<PortStatus>> {
    service(&state)?.statuses().map_err(Into::into)
}

#[tauri::command]
fn get_sources(state: tauri::State<'_, DesktopState>) -> DesktopResult<Vec<SourceRecord>> {
    state.library.sources().map_err(Into::into)
}

#[tauri::command]
fn get_activities(state: tauri::State<'_, DesktopState>) -> DesktopResult<Vec<ActivityRecord>> {
    state.library.activities(50).map_err(Into::into)
}

#[tauri::command]
fn get_backups(
    state: tauri::State<'_, DesktopState>,
    port_id: String,
) -> DesktopResult<Vec<BackupRecord>> {
    service(&state)?.list_backups(&port_id).map_err(Into::into)
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
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    backup_id: String,
) -> DesktopResult<RestoreResult> {
    let state = state.inner().clone();
    blocking_service(state, move |service| {
        service
            .restore_backup(&port_id, &backup_id)
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
async fn delete_backup(
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    backup_id: String,
) -> DesktopResult<BackupRecord> {
    let state = state.inner().clone();
    blocking_service(state, move |service| {
        service
            .delete_backup(&port_id, &backup_id)
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
async fn verify_sources(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
) -> DesktopResult<Vec<SourceBatchOutcome>> {
    let _ = app.emit(
        "portcove://operation",
        OperationEvent::Started {
            operation: "verify-sources".into(),
            port_id: None,
        },
    );
    let state = state.inner().clone();
    let outcomes = tauri::async_runtime::spawn_blocking(move || {
        let service = service(&state)?;
        let sources = state.library.sources().map_err(DesktopError::from)?;
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
    let _ = app.emit(
        "portcove://operation",
        OperationEvent::Finished {
            operation: "verify-sources".into(),
            success: outcomes.iter().all(|outcome| outcome.ok),
        },
    );
    Ok(outcomes)
}

#[tauri::command]
async fn check_port(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
    port_id: String,
) -> DesktopResult<UpdateCheck> {
    let check = service(&state)?.check_update(&port_id).await?;
    let message = if check.update_available {
        format!("{} is available", check.release.version)
    } else {
        format!("{} is up to date", check.port_id)
    };
    let _ = app.emit(
        "portcove://operation",
        OperationEvent::Message {
            level: "info".into(),
            message,
        },
    );
    Ok(check)
}

#[tauri::command]
async fn check_installed(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
) -> DesktopResult<Vec<BatchOutcome<UpdateCheck>>> {
    let service = service(&state)?;
    let installed = service
        .statuses()?
        .into_iter()
        .filter(|status| status.active.is_some())
        .collect::<Vec<_>>();
    let total = installed.len() as u64;
    let _ = app.emit(
        "portcove://operation",
        OperationEvent::Started {
            operation: "check-installed".into(),
            port_id: None,
        },
    );
    let mut outcomes = Vec::with_capacity(installed.len());
    for (index, status) in installed.into_iter().enumerate() {
        let port_id = status.port_id;
        outcomes.push(match service.check_update(&port_id).await {
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
        let _ = app.emit(
            "portcove://operation",
            OperationEvent::Progress {
                phase: "Checking installed ports".into(),
                completed: index as u64 + 1,
                total: Some(total),
            },
        );
    }
    let success = outcomes.iter().all(|outcome| outcome.ok);
    let _ = app.emit(
        "portcove://operation",
        OperationEvent::Finished {
            operation: "check-installed".into(),
            success,
        },
    );
    Ok(outcomes)
}

#[tauri::command]
async fn reconcile_installed(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
) -> DesktopResult<Vec<BatchOutcome<ReconcileResult>>> {
    let service = service(&state)?;
    let installed = service
        .statuses()?
        .into_iter()
        .filter(|status| status.active.is_some())
        .collect::<Vec<_>>();
    let total = installed.len() as u64;
    let mut outcomes = Vec::with_capacity(installed.len());
    for (index, status) in installed.into_iter().enumerate() {
        let port_id = status.port_id;
        let result = service
            .reconcile(&port_id, |event| {
                let _ = app.emit("portcove://operation", event);
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
        let _ = app.emit(
            "portcove://operation",
            OperationEvent::Progress {
                phase: "Applying update policies".into(),
                completed: index as u64 + 1,
                total: Some(total),
            },
        );
    }
    Ok(outcomes)
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
fn set_channel(
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    channel: ReleaseChannel,
) -> DesktopResult<PortStatus> {
    service(&state)?
        .set_channel(&port_id, channel)
        .map_err(Into::into)
}

#[tauri::command]
fn set_policy(
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    policy: UpdatePolicy,
) -> DesktopResult<PortStatus> {
    service(&state)?
        .set_update_policy(&port_id, policy)
        .map_err(Into::into)
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
    let service = service(&state)?;
    service
        .install(
            &input.port_id,
            input.channel,
            input.source.as_deref(),
            input.bios.as_deref(),
            !input.stage,
            |event: OperationEvent| {
                let _ = app.emit("portcove://operation", event);
            },
        )
        .await
        .map_err(Into::into)
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
    let service = service(&state)?;
    service
        .update(
            &port_id,
            source.as_deref(),
            bios.as_deref(),
            !stage,
            |event: OperationEvent| {
                let _ = app.emit("portcove://operation", event);
            },
        )
        .await
        .map_err(Into::into)
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
    state: tauri::State<'_, DesktopState>,
    path: PathBuf,
    port_id: Option<String>,
) -> DesktopResult<InstallRecord> {
    let state = state.inner().clone();
    blocking_service(state, move |service| {
        service.adopt(&path, port_id.as_deref()).map_err(Into::into)
    })
    .await
}

#[tauri::command]
async fn remove_port(
    state: tauri::State<'_, DesktopState>,
    port_id: String,
) -> DesktopResult<Vec<PathBuf>> {
    let state = state.inner().clone();
    blocking_service(state, move |service| {
        service.remove(&port_id).map_err(Into::into)
    })
    .await
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LaunchResult {
    process_id: u32,
}

#[tauri::command]
async fn launch_port(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    source: Option<PathBuf>,
    arguments: Vec<String>,
) -> DesktopResult<LaunchResult> {
    let library = state.library.clone();
    let state = state.inner().clone();
    let spec_port_id = port_id.clone();
    let (spec, launch_guard) = blocking_service(state, move |service| {
        service
            .prepare_launch(&spec_port_id, source.as_deref())
            .map_err(Into::into)
    })
    .await?;
    let install_root = spec.install_root.clone();
    let mut child = Command::new(&spec.executable)
        .args(&spec.arguments)
        .args(arguments)
        .current_dir(spec.working_directory)
        .envs(spec.environment)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| DesktopError::from(PortcoveError::launch(error.to_string())))?;
    let process_id = child.id();
    let sync_port_id = port_id.clone();
    std::thread::spawn(move || {
        let _launch_guard = launch_guard;
        match child.wait() {
            Ok(status) if status.success() => {
                if let Err(error) = library.record_successful_launch(&sync_port_id) {
                    let _ = app.emit(
                        "portcove://operation",
                        OperationEvent::Message {
                            level: "error".into(),
                            message: format!("could not record successful launch: {error}"),
                        },
                    );
                } else {
                    let _ = app.emit("portcove://library-changed", &sync_port_id);
                }
            }
            Ok(_) => {}
            Err(error) => {
                let _ = app.emit(
                    "portcove://operation",
                    OperationEvent::Message {
                        level: "error".into(),
                        message: format!("could not observe the launched process: {error}"),
                    },
                );
            }
        }
        if let Err(error) = PortcoveService::new(library).and_then(|service| {
            service.collect_user_data_from_install(&sync_port_id, &install_root)
        }) {
            let _ = app.emit(
                "portcove://operation",
                OperationEvent::Message {
                    level: "error".into(),
                    message: format!("could not preserve user data: {error}"),
                },
            );
        }
    });
    Ok(LaunchResult { process_id })
}

#[tauri::command]
fn get_storage(state: tauri::State<'_, DesktopState>) -> DesktopResult<StorageSummary> {
    state.library.storage_summary().map_err(Into::into)
}

#[tauri::command]
fn open_user_data(
    state: tauri::State<'_, DesktopState>,
    port_id: String,
) -> DesktopResult<PathBuf> {
    let path = service(&state)?.port_paths(&port_id)?.user_data_root;
    std::fs::create_dir_all(&path).map_err(PortcoveError::from)?;
    open_directory(&path)?;
    Ok(path)
}

fn open_directory(path: &std::path::Path) -> DesktopResult<()> {
    #[cfg(target_os = "windows")]
    let program = "explorer.exe";
    #[cfg(target_os = "macos")]
    let program = "open";
    #[cfg(target_os = "linux")]
    let program = "xdg-open";
    Command::new(program).arg(path).spawn().map_err(|error| {
        PortcoveError::state(format!(
            "could not open persistent data folder {}: {error}",
            path.display()
        ))
    })?;
    Ok(())
}

pub fn run() {
    let library = std::env::var_os("PORTCOVE_LIBRARY")
        .filter(|path| !path.is_empty())
        .map(Library::open)
        .unwrap_or_else(Library::open_default)
        .expect("Portcove library should initialize");
    let releases = std::sync::Arc::new(
        CompositeReleaseProvider::for_library(&library)
            .expect("Portcove release provider should initialize"),
    );
    let github = releases.github();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(DesktopState {
            library,
            github,
            releases,
        })
        .invoke_handler(tauri::generate_handler![
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
            verify_sources,
            check_port,
            check_installed,
            reconcile_installed,
            add_source,
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
            get_storage,
            open_user_data,
        ])
        .setup(|app| {
            let window = app
                .get_webview_window("main")
                .expect("main window should exist");
            window.set_focus()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Portcove");
}
