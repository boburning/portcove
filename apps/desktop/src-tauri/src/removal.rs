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
    if !review.persistent_data_will_be_preserved {
        return Err(PortcoveError::conflict(
            "saved data preservation changed; review uninstall again",
        )
        .into());
    }
    let state_for_name = state.inner().clone();
    let port_id_for_name = port_id.clone();
    let port_name = blocking_worker(move || {
        Ok(service_at_generation(&state_for_name, generation)?
            .catalog()
            .port(&port_id_for_name)?
            .name
            .clone())
    })
    .await?;
    if !confirm_destructive(
        &app,
        "Confirm uninstall",
        removal_consent(&review, &port_name),
        "Uninstall port",
    )
    .await
    {
        return Ok(None);
    }
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

fn removal_consent(review: &PortRemovalPreview, port_name: &str) -> String {
    let paths = review
        .managed_paths
        .iter()
        .map(|path| format!("- {}", path.display()))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "Uninstall all Portcove-managed versions of {port_name} (catalog ID: {})?\n\nFiles inside these installation folders will be deleted:\n{paths}\n\nThis game's saved release-channel and update-policy settings will also be removed. Saved data will remain at {}. Backups and original game files will be kept. This cannot be undone; to use this port again, reinstall it or copy an existing installation. If interrupted after confirmation, removal may finish during recovery.",
        review.port_id,
        review.persistent_data_path.display(),
    )
}

#[cfg(test)]
mod tests {
    use super::removal_consent;
    use portcove_core::PortRemovalPreview;
    use std::path::PathBuf;

    #[test]
    fn native_uninstall_consent_names_deleted_folders_and_preserved_data() {
        let preview = PortRemovalPreview {
            port_id: "sample-port".to_owned(),
            managed_paths: vec![
                PathBuf::from("installed/current"),
                PathBuf::from("installed/old"),
            ],
            persistent_data_path: PathBuf::from("user/sample-port"),
            persistent_data_will_be_preserved: true,
            preview_sha256: "a".repeat(64),
        };
        let consent = removal_consent(&preview, "Sample Port");
        for expected in [
            "Sample Port",
            "sample-port",
            "installed/current",
            "installed/old",
            "user/sample-port",
            "saved release-channel and update-policy settings will also be removed",
            "Backups and original game files will be kept",
            "removal may finish during recovery",
        ] {
            assert!(consent.contains(expected), "missing {expected}");
        }
        assert!(!consent.contains("review you just read"));
    }
}
