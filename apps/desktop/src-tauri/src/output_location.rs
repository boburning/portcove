//! Thin desktop transport for the core-owned per-game output contract.

use crate::{DesktopResult, DesktopState, blocking_worker, service_at_generation};
use portcove_core::{OutputDestinationPreview, PortOutputLocation};
use std::path::PathBuf;

#[tauri::command]
pub(crate) async fn get_output_location(
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    generation: u64,
) -> DesktopResult<PortOutputLocation> {
    let state = state.inner().clone();
    blocking_worker(move || {
        service_at_generation(&state, generation)?
            .output_location(&port_id, None)
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub(crate) async fn preview_output_location(
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    path: Option<PathBuf>,
    generation: u64,
) -> DesktopResult<OutputDestinationPreview> {
    let state = state.inner().clone();
    blocking_worker(move || {
        service_at_generation(&state, generation)?
            .preview_output_directory(&port_id, path.as_deref())
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub(crate) async fn set_output_location(
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    path: PathBuf,
    expected_preview: String,
    generation: u64,
) -> DesktopResult<PortOutputLocation> {
    let state = state.inner().clone();
    blocking_worker(move || {
        let service = service_at_generation(&state, generation)?;
        let authorization =
            service.authorize_output_directory_change(&port_id, Some(&path), &expected_preview)?;
        service
            .apply_output_directory_change(&port_id, Some(&path), &authorization.token)
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub(crate) async fn reset_output_location(
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    expected_preview: String,
    generation: u64,
) -> DesktopResult<PortOutputLocation> {
    let state = state.inner().clone();
    blocking_worker(move || {
        let service = service_at_generation(&state, generation)?;
        let authorization =
            service.authorize_output_directory_change(&port_id, None, &expected_preview)?;
        service
            .apply_output_directory_change(&port_id, None, &authorization.token)
            .map_err(Into::into)
    })
    .await
}
