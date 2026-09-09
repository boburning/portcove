//! Generation-bound source-reference removal with native consent and core authority.
use crate::{
    DesktopResult, DesktopState, blocking_worker, confirm_destructive, service_at_generation,
};
use portcove_core::{PortcoveError, SourceRemovalPreview};

#[tauri::command]
pub(crate) async fn preview_source_removal(
    state: tauri::State<'_, DesktopState>,
    profile_id: String,
    generation: u64,
) -> DesktopResult<SourceRemovalPreview> {
    let state = state.inner().clone();
    blocking_worker(move || {
        service_at_generation(&state, generation)?
            .preview_source_removal(&profile_id)
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub(crate) async fn remove_source(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
    profile_id: String,
    preview_sha256: String,
    generation: u64,
) -> DesktopResult<Option<SourceRemovalPreview>> {
    let preview = preview_source_removal(state.clone(), profile_id.clone(), generation).await?;
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
            "Remove registered source {profile_id}?\n\nSource: {}\n\n{impact} The source file itself will not be deleted.", preview.source.path.display()
        ),
        "Remove source reference",
    )
    .await
    {
        return Ok(None);
    }
    let state = state.inner().clone();
    blocking_worker(move || {
        let service = service_at_generation(&state, generation)?;
        let authorization = service.authorize_source_removal(&profile_id, &preview_sha256)?;
        service
            .remove_source(&profile_id, &authorization.token)
            .map(Some)
            .map_err(Into::into)
    })
    .await
}
