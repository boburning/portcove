//! Host presentation of core-owned backup review and one-use authorization.
use crate::transport::BackupReview;
use crate::{
    DesktopResult, DesktopState, blocking_worker, confirm_destructive, service_at_generation,
};
use portcove_core::{BackupAction, BackupRecord, PortcoveError, RestoreResult};

#[tauri::command]
pub(crate) async fn preview_backup_action(
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    backup_id: String,
    action: BackupAction,
    generation: u64,
) -> DesktopResult<BackupReview> {
    let state = state.inner().clone();
    blocking_worker(move || {
        let service = service_at_generation(&state, generation)?;
        Ok(BackupReview {
            preview: service.preview_backup_action(&port_id, &backup_id, action)?,
            persistent_data_path: service.port_paths(&port_id)?.user_data_root,
        })
    })
    .await
}

#[tauri::command]
pub(crate) async fn restore_backup(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    backup_id: String,
    expected_preview: String,
    generation: u64,
) -> DesktopResult<Option<RestoreResult>> {
    let review = preview_backup_action(
        state.clone(),
        port_id.clone(),
        backup_id.clone(),
        BackupAction::Restore,
        generation,
    )
    .await?;
    if !confirm_review(&app, review, &expected_preview).await? {
        return Ok(None);
    }
    let state = state.inner().clone();
    blocking_worker(move || {
        let service = service_at_generation(&state, generation)?;
        let authorization = service.authorize_backup_action(
            &port_id,
            &backup_id,
            BackupAction::Restore,
            &expected_preview,
        )?;
        service
            .restore_backup(&port_id, &backup_id, &authorization.token)
            .map(Some)
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub(crate) async fn delete_backup(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    backup_id: String,
    expected_preview: String,
    generation: u64,
) -> DesktopResult<Option<BackupRecord>> {
    let review = preview_backup_action(
        state.clone(),
        port_id.clone(),
        backup_id.clone(),
        BackupAction::Delete,
        generation,
    )
    .await?;
    if !confirm_review(&app, review, &expected_preview).await? {
        return Ok(None);
    }
    let state = state.inner().clone();
    blocking_worker(move || {
        let service = service_at_generation(&state, generation)?;
        let authorization = service.authorize_backup_action(
            &port_id,
            &backup_id,
            BackupAction::Delete,
            &expected_preview,
        )?;
        service
            .delete_backup(&port_id, &backup_id, &authorization.token)
            .map(Some)
            .map_err(Into::into)
    })
    .await
}

async fn confirm_review(
    app: &tauri::AppHandle,
    review: BackupReview,
    expected: &str,
) -> DesktopResult<bool> {
    if review.preview.preview_sha256 != expected {
        return Err(PortcoveError::conflict(
            "backup or saved data changed after review; review again",
        )
        .into());
    }
    let backup = &review.preview.backup;
    let (title, action) = match review.preview.action {
        BackupAction::Restore => ("Confirm backup restore", "Restore reviewed backup"),
        BackupAction::Delete => ("Confirm backup deletion", "Delete reviewed backup"),
    };
    Ok(confirm_destructive(app, title, format!("{action} for {}?\n\nSnapshot: {}\nSaved data: {}\n\nOnly proceed if these match the review you just read.", backup.port_id, backup.path.display(), review.persistent_data_path.display()), action).await)
}
