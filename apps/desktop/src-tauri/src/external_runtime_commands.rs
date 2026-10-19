use crate::{
    DesktopResult, DesktopState, blocking_worker, confirm_destructive, service_at_generation,
};
use portcove_core::{
    ExternalRuntimePreview, ExternalRuntimeRecord, ExternalRuntimeRemovalPreview, PortcoveError,
};
use std::path::PathBuf;

#[tauri::command]
pub(crate) async fn preview_external_runtime(
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    path: PathBuf,
    generation: u64,
) -> DesktopResult<ExternalRuntimePreview> {
    let state = state.inner().clone();
    blocking_worker(move || {
        service_at_generation(&state, generation)?
            .preview_external_runtime(&port_id, &path)
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub(crate) async fn register_external_runtime(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    path: PathBuf,
    expected_preview: String,
    generation: u64,
) -> DesktopResult<Option<ExternalRuntimeRecord>> {
    let review =
        preview_external_runtime(state.clone(), port_id.clone(), path.clone(), generation).await?;
    if review.preview_sha256 != expected_preview {
        return Err(PortcoveError::conflict(
            "external runtime changed after review; inspect it again",
        )
        .into());
    }
    if let Some(shared) = &review.shared_preferences {
        let disclosure = format!(
            "Running this game can rewrite shared preferences at {}. It can discard unknown entries and affect other runtime copies in this Windows account. The file is currently {}. Portcove does not own, migrate, back up, restore, or delete these shared preferences. Accept this shared write scope?",
            shared.binding.path.display(),
            if shared.present {
                "present"
            } else {
                "absent; the game may create it"
            },
        );
        if !confirm_destructive(
            &app,
            "Review shared preferences",
            disclosure,
            "Accept shared preferences",
        )
        .await
        {
            return Ok(None);
        }
    }
    let consent = format!(
        "Register {} version {} at {}? Portcove will verify and launch this exact runtime. It will not copy, update, back up, or delete the external folder. Game-owned output there remains outside Portcove's save management.",
        review.port_id,
        review.version,
        review.path.display(),
    );
    if !confirm_destructive(
        &app,
        "Confirm external runtime",
        consent,
        "Register runtime",
    )
    .await
    {
        return Ok(None);
    }
    let state = state.inner().clone();
    blocking_worker(move || {
        let service = service_at_generation(&state, generation)?;
        let authorization = service.authorize_external_runtime_with_shared_preferences_ack(
            &port_id,
            &path,
            &expected_preview,
            review
                .shared_preferences
                .as_ref()
                .map(|_| expected_preview.as_str()),
        )?;
        service
            .register_external_runtime(&port_id, &path, &authorization.token)
            .map(Some)
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub(crate) async fn preview_external_removal(
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    generation: u64,
) -> DesktopResult<ExternalRuntimeRemovalPreview> {
    let state = state.inner().clone();
    blocking_worker(move || {
        service_at_generation(&state, generation)?
            .preview_external_removal(&port_id)
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub(crate) async fn remove_external_runtime(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    expected_preview: String,
    generation: u64,
) -> DesktopResult<Option<ExternalRuntimeRecord>> {
    let review = preview_external_removal(state.clone(), port_id.clone(), generation).await?;
    if review.preview_sha256 != expected_preview || !review.external_files_will_be_preserved {
        return Err(PortcoveError::conflict(
            "external registration changed after review; inspect it again",
        )
        .into());
    }
    let consent = format!(
        "Remove Portcove's registration for {}? Every file at {} remains untouched, including the game, settings, and saves. Portcove will no longer launch this entry until it is registered again.",
        review.port_id,
        review.path.display(),
    );
    if !confirm_destructive(
        &app,
        "Confirm registration removal",
        consent,
        "Remove registration",
    )
    .await
    {
        return Ok(None);
    }
    let state = state.inner().clone();
    blocking_worker(move || {
        let service = service_at_generation(&state, generation)?;
        let authorization = service.authorize_external_removal(&port_id, &expected_preview)?;
        service
            .remove_external_runtime(&port_id, &authorization.token)
            .map(Some)
            .map_err(Into::into)
    })
    .await
}
