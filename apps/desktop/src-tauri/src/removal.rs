//! Generation-bound transport for core-owned installed-version removal reviews.
use crate::{DesktopResult, DesktopState, blocking_worker, service_at_generation};
use portcove_core::PortRemovalPreview;
use std::path::PathBuf;

#[tauri::command]
pub(crate) async fn preview_removal(
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    generation: u64,
) -> DesktopResult<PortRemovalPreview> {
    let state = state.inner().clone();
    blocking_worker(move || {
        service_at_generation(&state, generation)?
            .preview_removal(&port_id)
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub(crate) async fn remove_port(
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    expected_preview: String,
    generation: u64,
) -> DesktopResult<Vec<PathBuf>> {
    let state = state.inner().clone();
    blocking_worker(move || {
        let service = service_at_generation(&state, generation)?;
        let authorization = service.authorize_removal(&port_id, &expected_preview)?;
        service
            .remove(&port_id, &authorization.token)
            .map_err(Into::into)
    })
    .await
}
