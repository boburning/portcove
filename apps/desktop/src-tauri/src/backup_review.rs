//! Host presentation of core-owned backup review and one-use authorization.
use crate::transport::BackupReview;
use crate::{DesktopResult, DesktopState, blocking_worker, service_at_generation};
use portcove_core::{BackupAction, BackupRecord, RestoreResult};

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
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    backup_id: String,
    expected_preview: String,
    generation: u64,
) -> DesktopResult<RestoreResult> {
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
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub(crate) async fn delete_backup(
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    backup_id: String,
    expected_preview: String,
    generation: u64,
) -> DesktopResult<BackupRecord> {
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
            .map_err(Into::into)
    })
    .await
}
