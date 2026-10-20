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
    let state_for_review = state.inner().clone();
    let profile_for_review = profile_id.clone();
    let (preview, label, affected_names) = blocking_worker(move || {
        let service = service_at_generation(&state_for_review, generation)?;
        let preview = service.preview_source_removal(&profile_for_review)?;
        let catalog = service.catalog();
        let label = catalog
            .source_profile(&profile_for_review)
            .map(|profile| profile.label.clone())
            .unwrap_or_else(|_| format!("Saved file requirement ({profile_for_review})"));
        let names = preview
            .installed_dependent_port_ids
            .iter()
            .map(|id| {
                catalog
                    .port(id)
                    .map(|port| {
                        let game = port
                            .presentation
                            .as_ref()
                            .and_then(|value| value.original_game_title.as_deref());
                        match game.filter(|game| *game != port.name) {
                            Some(game) => format!("{game} · {}", port.name),
                            None => port.name.clone(),
                        }
                    })
                    .unwrap_or_else(|_| format!("Unavailable port ({id})"))
            })
            .collect::<Vec<_>>();
        Ok((preview, label, names))
    })
    .await?;
    if preview.preview_sha256 != preview_sha256 {
        return Err(PortcoveError::conflict(
            "the saved file location or affected games changed after review",
        )
        .into());
    }
    if !confirm_destructive(
        &app,
        "Remove saved location?",
        source_removal_consent(&preview.source.path, &label, &affected_names),
        "Remove saved location",
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

fn source_removal_consent(
    path: &std::path::Path,
    label: &str,
    affected_names: &[String],
) -> String {
    let impact = if affected_names.is_empty() {
        "No installed entry currently needs this saved location.".to_owned()
    } else {
        let shown = affected_names
            .iter()
            .take(5)
            .map(|name| format!("- {name}"))
            .collect::<Vec<_>>()
            .join("\n");
        let remaining = affected_names.len().saturating_sub(5);
        let more = if remaining > 0 {
            format!(
                "\nAnd {remaining} more; the full affected set is available in the inline impact preview."
            )
        } else {
            String::new()
        };
        format!(
            "{} installed entries may ask you to add their files again:\n{shown}{more}",
            affected_names.len()
        )
    };
    format!(
        "Remove the saved location for {label}?\n\nExact location: {}\n\n{impact}\n\nOnly this library's saved location is removed. Original files, installations, game saves, backups and other saved locations are preserved.",
        path.display()
    )
}

#[cfg(test)]
mod tests {
    use super::source_removal_consent;
    use std::path::Path;

    #[test]
    fn consent_names_the_location_impact_and_preserved_data() {
        let names = (1..=7)
            .map(|index| format!("Game ü · Port {index}"))
            .collect::<Vec<_>>();
        let text = source_removal_consent(
            Path::new("D:/Original ü/game.iso"),
            "Known game files",
            &names,
        );
        for expected in [
            "D:/Original ü/game.iso",
            "Known game files",
            "7 installed entries",
            "Game ü · Port 1",
            "And 2 more",
            "full affected set",
            "Original files, installations, game saves, backups",
        ] {
            assert!(text.contains(expected), "missing {expected}");
        }
        assert!(!text.contains("Game ü · Port 6"));
        assert!(
            source_removal_consent(Path::new("D:/game.iso"), "Files", &[])
                .contains("No installed entry")
        );
    }
}
