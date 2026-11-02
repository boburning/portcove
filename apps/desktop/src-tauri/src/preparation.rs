//! Generation-bound transport for core's reviewed preparation operation.
use crate::{
    DesktopResult, DesktopState, blocking_worker, confirm_destructive, service_at_generation,
};
use portcove_core::{
    InstallRecord, OperationEvent, Platform, PortcoveError, PreparationCleanupPreview,
    PreparationMode, PreparationOptions, PreparationPlan,
};

fn options() -> portcove_core::Result<PreparationOptions> {
    Ok(PreparationOptions {
        target: Platform::current()?,
        mode: PreparationMode::Default,
    })
}

#[tauri::command]
pub(crate) async fn plan_preparation(
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    generation: u64,
) -> DesktopResult<PreparationPlan> {
    let state = state.inner().clone();
    blocking_worker(move || {
        service_at_generation(&state, generation)?
            .plan_preparation(&port_id, options()?)
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub(crate) async fn prepare_port(
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    expected_plan: String,
    generation: u64,
    on_event: tauri::ipc::Channel<OperationEvent>,
) -> DesktopResult<InstallRecord> {
    let state = state.inner().clone();
    blocking_worker(move || {
        let service = service_at_generation(&state, generation)?;
        let options = options()?;
        let authorization = service.authorize_preparation(&port_id, options, &expected_plan)?;
        service
            .prepare(&port_id, options, &authorization.token, |event| {
                let _ = on_event.send(event);
            })
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub(crate) async fn preview_preparation_cleanup(
    state: tauri::State<'_, DesktopState>,
    operation_id: String,
    generation: u64,
) -> DesktopResult<PreparationCleanupPreview> {
    let state = state.inner().clone();
    blocking_worker(move || {
        service_at_generation(&state, generation)?
            .preview_preparation_cleanup(&operation_id)
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub(crate) async fn cleanup_preparation(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
    operation_id: String,
    expected_preview: String,
    generation: u64,
) -> DesktopResult<Option<PreparationCleanupPreview>> {
    let preview =
        preview_preparation_cleanup(state.clone(), operation_id.clone(), generation).await?;
    if preview.preview_sha256 != expected_preview {
        return Err(
            PortcoveError::conflict("retained preparation changed; review cleanup again").into(),
        );
    }
    let retained_entry_count = preview.retained.directories.len()
        + preview.retained.files.len()
        + preview.retained.skipped_entries.len();
    let (confirmation_message, confirmation_action) = if retained_entry_count == 0 {
        (
            format!(
                "Remove the empty setup folder and its recovery record for {}?\n\nSetup folder: {}\nEntries: 0 (0 bytes)\n\nThe setup folder is empty or already absent. Portcove removes only that folder if it exists and its unfinished-task record. Your original installation, original game files, saved data, backups and logs stay in place. Portcove must confirm that setup and its child processes have stopped before deleting anything.",
                preview.port_id,
                preview.retained_path.display(),
            ),
            "Remove empty setup record",
        )
    } else {
        (
            format!(
                "Permanently delete the setup working folder for {}?\n\nFolder: {}\nFiles: {} ({} bytes)\n\nYour original installation, original game files, saved data, backups and logs stay in place. Portcove must confirm that setup and its child processes have stopped before deleting anything.",
                preview.port_id,
                preview.retained_path.display(),
                preview.retained.files.len(),
                preview.retained.total_bytes,
            ),
            "Delete setup working files",
        )
    };
    if !confirm_destructive(
        &app,
        "Delete unfinished setup files?",
        confirmation_message,
        confirmation_action,
    )
    .await
    {
        return Ok(None);
    }
    let state = state.inner().clone();
    blocking_worker(move || {
        let service = service_at_generation(&state, generation)?;
        let authorization =
            service.authorize_preparation_cleanup(&operation_id, &expected_preview)?;
        service
            .cleanup_preparation(&operation_id, &authorization.token)
            .map(Some)
            .map_err(Into::into)
    })
    .await
}
