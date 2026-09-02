use std::{
    fs,
    path::{Path, PathBuf},
    process::Stdio,
    thread,
    time::{Duration, Instant},
};

use portcove_core::{
    ActivityRecord, AdoptionPreview, BackupRecord, CatalogDocument, ChildProcessClass,
    ChildProcessPolicy, CompositeReleaseProvider, DoctorReport, GithubAuthStatus,
    GithubDeviceLogin, GithubDeviceLoginResult, GithubReleaseProvider, InstallPlan, InstallRecord,
    LaunchStdio, Library, OperationCoordinator, OperationEvent, OperationResult, PortStatus,
    PortcoveError, PortcoveService, ReconcileResult, ReleaseChannel, ReleaseProvider,
    RestoreResult, SourceRecord, SourceVerification, UpdateCheck, UpdatePolicy, VerificationReport,
};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

#[derive(Clone)]
struct DesktopState {
    library: Library,
    github: std::sync::Arc<GithubReleaseProvider>,
    releases: std::sync::Arc<CompositeReleaseProvider>,
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
    let operation = OperationCoordinator::new("verify_sources", None);
    let _ = app.emit("portcove://operation", operation.started());
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
    service(&state)?
        .check_update(&port_id)
        .await
        .map_err(Into::into)
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
    let operation = OperationCoordinator::new("check_installed", None);
    let _ = app.emit("portcove://operation", operation.started());
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
            operation.progress("Checking installed ports", index as u64 + 1, Some(total)),
        );
    }
    let success = outcomes.iter().all(|outcome| outcome.ok);
    let _ = app.emit(
        "portcove://operation",
        operation.finished(if success {
            OperationResult::Succeeded
        } else {
            OperationResult::Failed
        }),
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
    let operation = OperationCoordinator::new("reconcile_installed", None);
    let _ = app.emit("portcove://operation", operation.started());
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
            operation.progress("Applying update policies", index as u64 + 1, Some(total)),
        );
    }
    let _ = app.emit(
        "portcove://operation",
        operation.finished(if outcomes.iter().all(|outcome| outcome.ok) {
            OperationResult::Succeeded
        } else {
            OperationResult::Failed
        }),
    );
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
    let library = state.library.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        request_supervised_launch(&library, port_id, source, arguments)
    })
    .await
    .map_err(|error| DesktopError::from(PortcoveError::state(error.to_string())))??;
    let observed_session = result.session_id.clone();
    let observed_library = state.library.clone();
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
                    run_recovery_helper(&library, &session_id.to_string_lossy())
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
                    response_written = publish_json(
                        &response_path,
                        &LaunchSupervisorResponse::success(LaunchResult {
                            process_id: session.child_pid.expect("started session has a child PID"),
                            session_id: session.id.clone(),
                        }),
                    )
                    .is_ok();
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
fn get_doctor_report(state: tauri::State<'_, DesktopState>) -> DesktopResult<DoctorReport> {
    service(&state)?.doctor().map_err(Into::into)
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
    ChildProcessPolicy::native_command(ChildProcessClass::HostIntegration, program)?
        .arg(path)
        .spawn()
        .map_err(|error| {
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
    start_stale_launch_recovery(&library).expect("stale launch recovery should initialize");
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
            get_doctor_report,
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
