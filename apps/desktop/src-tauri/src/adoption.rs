//! Generation-bound adoption review; core owns copy and persistence semantics.
use crate::{
    DesktopResult, DesktopState, blocking_worker, confirm_destructive, service_at_generation,
};
use portcove_core::{
    AdoptionBatchItem, AdoptionBatchPreview, AdoptionBatchResult, AdoptionPreview, InstallRecord,
    LauncherKind, LauncherLibraryInventory, PortcoveError,
};
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

/// Read-only inventory of another launcher's library; each entry is then reviewed
/// through the ordinary generation-bound adoption preview.
#[tauri::command]
pub(crate) async fn inspect_launcher_library(
    state: tauri::State<'_, DesktopState>,
    launcher: LauncherKind,
    data_root: PathBuf,
    apps_root: Option<PathBuf>,
    generation: u64,
) -> DesktopResult<LauncherLibraryInventory> {
    let state = state.inner().clone();
    blocking_worker(move || {
        service_at_generation(&state, generation)?
            .inspect_launcher_library(launcher, &data_root, apps_root.as_deref())
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
        "Copy {} files ({} bytes) for {} into Portcove?\n\nOriginal: {}\nDestination: {}\nSaved-data destination: {}\n\n{}\n\nExisting versions and backups remain; the copy becomes active. The original folder will not be modified. {}",
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
        "Copy existing installation?",
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

/// One generation-bound review of several existing installations.
#[tauri::command]
pub(crate) async fn preview_adoption_batch(
    state: tauri::State<'_, DesktopState>,
    items: Vec<AdoptionBatchItem>,
    generation: u64,
) -> DesktopResult<AdoptionBatchPreview> {
    let state = state.inner().clone();
    blocking_worker(move || {
        service_at_generation(&state, generation)?
            .preview_adoption_batch(&items)
            .map_err(Into::into)
    })
    .await
}

/// Re-reviews the batch, asks once natively, then copies each unchanged item
/// through Core's ordinary adoption. `None` means the player declined.
#[tauri::command]
pub(crate) async fn adopt_batch(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
    items: Vec<AdoptionBatchItem>,
    generation: u64,
    batch_sha256: String,
) -> DesktopResult<Option<AdoptionBatchResult>> {
    let preview = preview_adoption_batch(state.clone(), items.clone(), generation).await?;
    if preview.batch_sha256 != batch_sha256 {
        return Err(PortcoveError::conflict(
            "an installation or its destination changed after review; review the batch again",
        )
        .into());
    }
    let names = {
        let state = state.inner().clone();
        let ids = items
            .iter()
            .map(|item| item.port_id.clone())
            .collect::<Vec<_>>();
        blocking_worker(move || {
            let service = service_at_generation(&state, generation)?;
            Ok(ids
                .iter()
                .map(|id| {
                    service
                        .catalog()
                        .port(id)
                        .map(|port| format!("{} ({id})", port.name))
                        .unwrap_or_else(|_| id.clone())
                })
                .collect::<Vec<_>>())
        })
        .await?
    };
    if !confirm_destructive(
        &app,
        "Copy several existing installations?",
        batch_disclosure(&preview, &names),
        "Copy into Portcove",
    )
    .await
    {
        return Ok(None);
    }
    let state = state.inner().clone();
    blocking_worker(move || {
        let service = service_at_generation(&state, generation)?;
        let authorization = service.authorize_adoption_batch(&items, &preview.batch_sha256)?;
        service
            .adopt_batch(&items, &preview, &authorization.token)
            .map(Some)
            .map_err(Into::into)
    })
    .await
}

fn batch_disclosure(preview: &AdoptionBatchPreview, names: &[String]) -> String {
    const SHOWN_ITEMS: usize = 8;
    let listed = preview
        .items
        .iter()
        .take(SHOWN_ITEMS)
        .zip(names)
        .map(|(item, name)| format!("- {name}: {}", files(item.copy_plan.files.len())))
        .collect::<Vec<_>>()
        .join("\n");
    let more = match preview.items.len().saturating_sub(SHOWN_ITEMS) {
        0 => String::new(),
        1 => "\n- and 1 more installation".to_owned(),
        more => format!("\n- and {more} more installations"),
    };
    let importing = preview
        .items
        .iter()
        .filter(|item| {
            item.destination
                .as_ref()
                .is_some_and(|destination| !destination.imported_user_data_paths.is_empty())
        })
        .count();
    let imported = match importing {
        0 => "No saved files are copied in.".to_owned(),
        1 => "Saved files are copied in for 1 game.".to_owned(),
        count => format!("Saved files are copied in for {count} games."),
    };
    let replaced = match preview.items_replacing_saved_files {
        0 => "No saved files already in Portcove are replaced.".to_owned(),
        1 => "For 1 game, matching saved files already in Portcove are replaced. Portcove does not create a backup first, and removing the copy later does not restore them.".to_owned(),
        count => format!("For {count} games, matching saved files already in Portcove are replaced. Portcove does not create a backup first, and removing a copy later does not restore them."),
    };
    let skipped = preview
        .items
        .iter()
        .map(|item| item.copy_plan.skipped_entries.len())
        .sum::<usize>();
    let installations = match preview.items.len() {
        1 => "1 installation".to_owned(),
        count => format!("{count} installations"),
    };
    format!(
        "Copy {installations} ({}, {}) into Portcove?\n\n{listed}{more}\n\n{imported} {replaced}\n\n{}\n\nStop the games before copying. Each installation is checked again just before it is copied; one that changed is held, not copied. Each copy becomes that game's active version; existing versions and backups remain. The original folders are not modified.",
        files(preview.total_files),
        iec_bytes(preview.total_bytes),
        unsupported_items_disclosure(skipped),
    )
}

fn files(count: usize) -> String {
    match count {
        1 => "1 file".to_owned(),
        count => format!("{count} files"),
    }
}

/// Human byte quantity in IEC units, as the content-design contract asks.
fn iec_bytes(bytes: u64) -> String {
    const UNITS: [&str; 4] = ["KiB", "MiB", "GiB", "TiB"];
    if bytes < 1024 {
        return format!("{bytes} B");
    }
    let mut value = bytes as f64 / 1024.0;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    format!("{value:.1} {}", UNITS[unit])
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

#[cfg(test)]
mod batch_tests {
    use super::batch_disclosure;
    use portcove_core::AdoptionBatchPreview;

    fn preview(items: usize, replacing: usize) -> AdoptionBatchPreview {
        serde_json::from_value(serde_json::json!({
            "items": (0..items).map(|index| serde_json::json!({
                "source": format!("/apps/{index}"),
                "detected_port_ids": ["p"],
                "selected_port_id": "p",
                "application_files_will_be_copied": true,
                "original_will_be_modified": false,
                "copy_plan": {"directories": [], "files": [], "skipped_entries": [], "total_bytes": 0},
                "destination": null,
                "plan_sha256": "0".repeat(64),
            })).collect::<Vec<_>>(),
            "total_files": 3,
            "total_bytes": 10,
            "items_replacing_saved_files": replacing,
            "original_will_be_modified": false,
            "batch_sha256": "0".repeat(64),
        }))
        .unwrap()
    }

    #[test]
    fn batch_confirmation_names_games_and_discloses_saved_file_replacement() {
        let names = (0..10)
            .map(|index| format!("Game {index} (g{index})"))
            .collect::<Vec<_>>();
        let none = batch_disclosure(&preview(2, 0), &names[..2]);
        assert!(none.starts_with("Copy 2 installations (3 files, 10 B)"));
        assert!(none.contains("- Game 0 (g0): 0 files\n- Game 1 (g1): 0 files"));
        assert!(none.contains("No saved files are copied in."));
        assert!(none.contains("No saved files already in Portcove are replaced."));
        assert!(none.contains("No unsupported items were found"));
        assert!(none.contains("Stop the games before copying."));
        assert!(none.contains("The original folders are not modified."));
        let one = batch_disclosure(&preview(2, 1), &names[..2]);
        assert!(one.contains("For 1 game, matching saved files already in Portcove are replaced"));
        assert!(one.contains("does not create a backup first"));
        let many = batch_disclosure(&preview(10, 3), &names);
        assert!(many.contains("For 3 games"));
        assert!(many.contains("- and 2 more installations"));
        assert!(!many.contains("Game 8"));
    }

    #[test]
    fn batch_sizes_use_complete_counts_and_iec_units() {
        assert_eq!(super::files(1), "1 file");
        assert_eq!(super::files(2), "2 files");
        assert_eq!(super::iec_bytes(512), "512 B");
        assert_eq!(super::iec_bytes(2048), "2.0 KiB");
        assert_eq!(super::iec_bytes(5 * 1024 * 1024), "5.0 MiB");
    }
}
