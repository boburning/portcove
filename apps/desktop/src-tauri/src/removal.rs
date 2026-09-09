//! Generation-bound transport for core-owned installed-version removal reviews.
use crate::{
    DesktopResult, DesktopState, blocking_worker, confirm_destructive, service_at_generation,
};
use portcove_core::{PortRemovalPreview, PortcoveError};
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
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    expected_preview: String,
    generation: u64,
) -> DesktopResult<Option<Vec<PathBuf>>> {
    let review = preview_removal(state.clone(), port_id.clone(), generation).await?;
    if review.preview_sha256 != expected_preview {
        return Err(PortcoveError::conflict(
            "managed installs changed after preview; review removal again",
        )
        .into());
    }
    if !confirm_destructive(&app, "Confirm port removal", format!("Remove {} reviewed managed folders for {port_id}?\n\nSaved data is preserved at {}. Only proceed if this matches the review you just read.", review.managed_paths.len(), review.persistent_data_path.display()), "Remove reviewed folders").await { return Ok(None); }
    let state = state.inner().clone();
    blocking_worker(move || {
        let service = service_at_generation(&state, generation)?;
        let authorization = service.authorize_removal(&port_id, &expected_preview)?;
        service
            .remove(&port_id, &authorization.token)
            .map(Some)
            .map_err(Into::into)
    })
    .await
}
