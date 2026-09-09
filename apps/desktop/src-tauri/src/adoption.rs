//! Generation-bound adoption review; core owns copy and persistence semantics.
use crate::{
    DesktopResult, DesktopState, blocking_worker, confirm_destructive, service_at_generation,
};
use portcove_core::{AdoptionPreview, InstallRecord, PortcoveError};
use std::path::PathBuf;

#[tauri::command]
pub(crate) async fn preview_adoption(
    state: tauri::State<'_, DesktopState>,
    path: PathBuf,
    port_id: Option<String>,
    generation: u64,
) -> DesktopResult<AdoptionPreview> {
    let state = state.inner().clone();
    blocking_worker(move || {
        service_at_generation(&state, generation)?
            .preview_adoption(&path, port_id.as_deref())
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub(crate) async fn adopt_port(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
    path: PathBuf,
    port_id: Option<String>,
    generation: u64,
    plan_sha256: String,
) -> DesktopResult<Option<InstallRecord>> {
    let preview =
        preview_adoption(state.clone(), path.clone(), port_id.clone(), generation).await?;
    if preview.plan_sha256 != plan_sha256 {
        return Err(PortcoveError::conflict(
            "adoption contents or destination changed after preview; review the copy plan again",
        )
        .into());
    }
    let destination = preview
        .destination
        .as_ref()
        .ok_or_else(|| PortcoveError::conflict("select one detected port before adoption"))?;
    let message = format!(
        "Copy {} files ({} bytes) into Portcove?\n\nOriginal: {}\nDestination: {}\nSaved data: {}\n\nCatalog-selected saved data will be merged, replacing matching saved files. No automatic safety backup is created. Existing versions and backups remain; the copy becomes active. The original folder will not be modified. {} entries are skipped.",
        preview.copy_plan.files.len(),
        preview.copy_plan.total_bytes,
        preview.source.display(),
        destination
            .output_location
            .effective_output_directory
            .display(),
        destination.output_location.user_data_root.display(),
        preview.copy_plan.skipped_entries.len(),
    );
    if !confirm_destructive(&app, "Confirm adoption", message, "Copy into Portcove").await {
        return Ok(None);
    }
    let state = state.inner().clone();
    blocking_worker(move || {
        let service = service_at_generation(&state, generation)?;
        let authorization = service.authorize_adoption(&path, port_id.as_deref(), &plan_sha256)?;
        service
            .adopt(&path, port_id.as_deref(), &authorization.token)
            .map(Some)
            .map_err(Into::into)
    })
    .await
}
