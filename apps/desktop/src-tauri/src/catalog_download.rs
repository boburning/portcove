//! Thin host transport for upstream package handoff. Core owns acquisition and recovery.
use crate::{
    DesktopResult, DesktopState, blocking_service_at_generation, blocking_worker, open_directory,
    open_host_target, require_library_generation, service_at_generation, state_generation,
};
use portcove_core::{
    CatalogDownloadCandidates, CatalogDownloadPreview, CatalogDownloadRequest, OperationEvent,
    PendingSetupRecord,
};
use std::path::PathBuf;

#[tauri::command]
pub(crate) async fn catalog_download_candidates(
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    generation: u64,
    selected_release_id: Option<portcove_core::CatalogDownloadReleaseId>,
    channel: Option<portcove_core::ReleaseChannel>,
) -> DesktopResult<CatalogDownloadCandidates> {
    let state = state.inner().clone();
    blocking_worker(move || {
        let service = service_at_generation(&state, generation)?;
        tauri::async_runtime::block_on(service.catalog_download_options(
            &port_id,
            selected_release_id,
            channel.unwrap_or(service.catalog_download_channel(&port_id)?),
        ))
        .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub(crate) async fn discover_setup_launch_targets(
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    pending_id: String,
    generation: u64,
) -> DesktopResult<portcove_core::SetupLaunchTargets> {
    blocking_service_at_generation(state.inner().clone(), generation, move |service| {
        service
            .discover_setup_launch_targets(&port_id, &pending_id)
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub(crate) async fn preview_catalog_download(
    state: tauri::State<'_, DesktopState>,
    request: CatalogDownloadRequest,
    generation: u64,
) -> DesktopResult<CatalogDownloadPreview> {
    let state = state.inner().clone();
    blocking_worker(move || {
        let service = service_at_generation(&state, generation)?;
        tauri::async_runtime::block_on(service.preview_catalog_download(&request))
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub(crate) async fn download_catalog_package(
    state: tauri::State<'_, DesktopState>,
    request: CatalogDownloadRequest,
    expected_preview_sha256: String,
    generation: u64,
    on_event: tauri::ipc::Channel<OperationEvent>,
) -> DesktopResult<PendingSetupRecord> {
    let state = state.inner().clone();
    blocking_worker(move || {
        let service = service_at_generation(&state, generation)?;
        tauri::async_runtime::block_on(service.download_catalog_package(
            &request,
            &expected_preview_sha256,
            |event| {
                let _ = on_event.send(event);
            },
        ))
        .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub(crate) async fn forget_pending_setup(
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    pending_id: String,
    generation: u64,
) -> DesktopResult<()> {
    blocking_service_at_generation(state.inner().clone(), generation, move |service| {
        service
            .forget_pending_setup(&port_id, &pending_id)
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub(crate) async fn open_pending_setup_folder(
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    pending_id: String,
    generation: u64,
) -> DesktopResult<PathBuf> {
    blocking_service_at_generation(state.inner().clone(), generation, move |service| {
        let path = service.pending_setup_folder(&port_id, &pending_id)?;
        open_directory(&path)?;
        Ok(path)
    })
    .await
}

#[tauri::command]
pub(crate) async fn open_pending_setup_resource(
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    pending_id: String,
    url: String,
    generation: u64,
) -> DesktopResult<()> {
    blocking_service_at_generation(state.inner().clone(), generation, move |service| {
        let url = service.pending_setup_resource(&port_id, &pending_id, &url)?;
        open_host_target(std::ffi::OsStr::new(&url))
    })
    .await
}

#[tauri::command]
pub(crate) async fn open_catalog_download_release_notes(
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    release_id: portcove_core::CatalogDownloadReleaseId,
    asset_id: portcove_core::CatalogDownloadAssetId,
    url: String,
    generation: u64,
) -> DesktopResult<()> {
    let state = state.inner().clone();
    blocking_worker(move || {
        let service = service_at_generation(&state, generation)?;
        let url = tauri::async_runtime::block_on(service.catalog_download_release_notes(
            &port_id,
            &release_id,
            &asset_id,
            &url,
        ))?;
        require_library_generation(state_generation(&state), generation)?;
        open_host_target(std::ffi::OsStr::new(&url))
    })
    .await
}
