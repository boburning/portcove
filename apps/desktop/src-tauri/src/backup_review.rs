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
            port_name: service.catalog().port(&port_id)?.name.clone(),
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
    let (title, message, action) = backup_consent(&review);
    Ok(confirm_destructive(app, title, message, action).await)
}

fn backup_consent(review: &BackupReview) -> (&'static str, String, &'static str) {
    let backup = &review.preview.backup;
    let date = jiff::Timestamp::from_second(backup.created_at).map_or_else(
        |_| format!("timestamp {}", backup.created_at),
        |time| time.to_string(),
    );
    let saved_data = review.persistent_data_path.display();
    let snapshot = backup.path.display();
    match review.preview.action {
        BackupAction::Restore => {
            let (consequence, safety_backup) = if review.preview.safety_backup_will_be_created {
                (
                    "This will replace the current saved data.",
                    "Portcove will back up the current saved data before replacing it.",
                )
            } else {
                (
                    "This will make the selected snapshot the current saved data.",
                    "There is no current saved data to back up. A safety backup will not be created.",
                )
            };
            (
                "Confirm backup restore",
                format!(
                    "Restore the backup from {date} for {} (catalog ID: {})?\n\nSelected backup: {snapshot}\nSaved-data destination: {saved_data}\n\n{consequence} {safety_backup} The selected backup remains available.",
                    review.port_name, backup.port_id,
                ),
                "Restore backup",
            )
        }
        BackupAction::Delete => (
            "Confirm backup deletion",
            format!(
                "Delete the backup from {date} for {} (catalog ID: {})? This cannot be undone.\n\nSelected backup: {snapshot}\nCurrent saved data: {saved_data}\n\nCurrent saved data and other backups remain. Portcove does not create a safety copy of the deleted backup.",
                review.port_name, backup.port_id,
            ),
            "Delete backup permanently",
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::backup_consent;
    use crate::transport::BackupReview;
    use portcove_core::{BackupAction, BackupActionPreview, BackupRecord};
    use std::path::PathBuf;

    fn review(action: BackupAction, safety_backup_will_be_created: bool) -> BackupReview {
        BackupReview {
            preview: BackupActionPreview {
                action,
                backup: BackupRecord {
                    id: "selected".to_owned(),
                    port_id: "sample-port".to_owned(),
                    path: PathBuf::from("backups/sample-port/selected"),
                    created_at: 1_700_000_000,
                    file_count: 1,
                    size: 4,
                    sha256: "a".repeat(64),
                },
                current_user_data_exists: safety_backup_will_be_created,
                safety_backup_will_be_created,
                preview_sha256: "b".repeat(64),
            },
            port_name: "Sample Port".to_owned(),
            persistent_data_path: PathBuf::from("user/sample-port"),
        }
    }

    #[test]
    fn backup_consent_names_date_paths_and_applicable_consequence() {
        let (_, restore, action) = backup_consent(&review(BackupAction::Restore, true));
        assert_eq!(action, "Restore backup");
        assert!(restore.contains("2023-11-14"));
        assert!(restore.contains("sample-port"));
        assert!(restore.contains("Sample Port"));
        assert!(restore.contains("backups/sample-port/selected"));
        assert!(restore.contains("user/sample-port"));
        assert!(restore.contains("Portcove will back up the current saved data"));

        let (_, empty_restore, _) = backup_consent(&review(BackupAction::Restore, false));
        assert!(empty_restore.contains("There is no current saved data to back up"));
        assert!(empty_restore.contains("make the selected snapshot the current saved data"));
        assert!(!empty_restore.contains("This will replace the current saved data"));
        assert!(!empty_restore.contains("Portcove will back up the current saved data"));

        let (_, delete, action) = backup_consent(&review(BackupAction::Delete, false));
        assert_eq!(action, "Delete backup permanently");
        assert!(delete.contains("This cannot be undone"));
        assert!(delete.contains("backups/sample-port/selected"));
        assert!(delete.contains("Current saved data and other backups remain"));
    }
}
