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
    let selected_port_id = preview
        .selected_port_id
        .as_deref()
        .ok_or_else(|| PortcoveError::conflict("select one detected port before adoption"))?;
    let message = format!(
        "Copy {} files ({} bytes) into Portcove for catalog port {}?\n\nOriginal: {}\nDestination: {}\nSaved-data destination: {}\n\n{}\n\nExisting versions and backups remain; the copy becomes active. The original folder will not be modified. {}",
        preview.copy_plan.files.len(),
        preview.copy_plan.total_bytes,
        selected_port_id,
        preview.source.display(),
        destination
            .output_location
            .effective_output_directory
            .display(),
        destination.output_location.user_data_root.display(),
        saved_data_disclosure(&destination.imported_user_data_paths),
        unsupported_items_disclosure(preview.copy_plan.skipped_entries.len()),
    );
    if !confirm_destructive(
        &app,
        "Confirm existing installation copy",
        message,
        "Copy into Portcove",
    )
    .await
    {
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

fn saved_data_disclosure(paths: &[PathBuf]) -> String {
    if paths.is_empty() {
        return "No catalog-selected saved-data paths will be imported from this folder."
            .to_owned();
    }
    const SHOWN_PATHS: usize = 5;
    let shown = paths
        .iter()
        .take(SHOWN_PATHS)
        .map(|path| format!("- {}", path.display()))
        .collect::<Vec<_>>()
        .join("\n");
    let remaining = paths.len().saturating_sub(SHOWN_PATHS);
    let more = if remaining == 0 {
        String::new()
    } else {
        format!("\n- and {remaining} more; see the full reviewed path list")
    };
    format!(
        "Matching saved files in Portcove will be replaced. Portcove does not create a backup before this copy.\nAffected saved-data paths from the original folder:\n{shown}{more}"
    )
}

fn unsupported_items_disclosure(count: usize) -> String {
    match count {
        0 => "No unsupported items were found in the reviewed copy plan.".to_owned(),
        1 => "1 unsupported item will remain only in the original folder.".to_owned(),
        _ => format!("{count} unsupported items will remain only in the original folder."),
    }
}

#[cfg(test)]
mod tests {
    use super::{saved_data_disclosure, unsupported_items_disclosure};
    use std::path::PathBuf;

    #[test]
    fn confirmation_discloses_replacement_only_for_imported_saved_data() {
        assert!(saved_data_disclosure(&[]).starts_with("No catalog-selected"));
        let paths = [PathBuf::from("settings"), PathBuf::from("saves/slot1")];
        let message = saved_data_disclosure(&paths);
        assert!(message.contains("Matching saved files in Portcove will be replaced"));
        assert!(message.contains("Portcove does not create a backup before this copy"));
        assert!(message.contains("- settings\n- saves/slot1"));
    }

    #[test]
    fn unsupported_copy_items_name_where_they_remain() {
        assert_eq!(
            unsupported_items_disclosure(0),
            "No unsupported items were found in the reviewed copy plan."
        );
        assert_eq!(
            unsupported_items_disclosure(1),
            "1 unsupported item will remain only in the original folder."
        );
        assert_eq!(
            unsupported_items_disclosure(3),
            "3 unsupported items will remain only in the original folder."
        );
    }
}
