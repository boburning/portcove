//! Native adapter for Core's player-key SteamGridDB client. Core owns the key,
//! the fixed-origin client, validation and ingestion; this module only moves
//! blocking work off the IPC runtime. The key is accepted for saving but never
//! returned to the renderer.
use crate::{DesktopResult, DesktopState, blocking_worker, service_at_generation};
use base64::Engine as _;
use portcove_core::{
    ArtworkSelectionFraming, ArtworkSlot, ArtworkState, SteamGridDbArtworkRole,
    SteamGridDbCandidate, SteamGridDbGame, SteamGridDbKeyStatus, SteamGridDbListingReport,
};
use serde::Serialize;

#[tauri::command]
pub(crate) async fn get_steamgriddb_key_status() -> DesktopResult<SteamGridDbKeyStatus> {
    blocking_worker(|| portcove_core::steamgriddb_key_status().map_err(Into::into)).await
}

#[tauri::command]
pub(crate) async fn set_steamgriddb_key(key: String) -> DesktopResult<SteamGridDbKeyStatus> {
    blocking_worker(move || portcove_core::set_steamgriddb_key(&key).map_err(Into::into)).await
}

#[tauri::command]
pub(crate) async fn clear_steamgriddb_key() -> DesktopResult<SteamGridDbKeyStatus> {
    blocking_worker(|| portcove_core::clear_steamgriddb_key().map_err(Into::into)).await
}

#[tauri::command]
pub(crate) async fn search_steamgriddb_games(term: String) -> DesktopResult<Vec<SteamGridDbGame>> {
    blocking_worker(move || portcove_core::search_steamgriddb_games(&term).map_err(Into::into))
        .await
}

#[tauri::command]
pub(crate) async fn get_steamgriddb_candidates(
    game_id: u64,
    role: SteamGridDbArtworkRole,
) -> DesktopResult<Vec<SteamGridDbCandidate>> {
    blocking_worker(move || {
        portcove_core::steamgriddb_candidates(game_id, role).map_err(Into::into)
    })
    .await
}

#[derive(Serialize)]
pub(crate) struct DesktopSteamGridDbPreview {
    png_base64: String,
}

/// Previews share the bounded remote-image admission used by catalog covers, so
/// a page of candidates cannot flood the network or the blocking pool.
#[tauri::command]
pub(crate) async fn get_steamgriddb_preview(
    url: String,
) -> DesktopResult<DesktopSteamGridDbPreview> {
    crate::artwork::thumbnail_worker(
        crate::artwork::remote_thumbnail_workers(),
        true,
        move || {
            let png = portcove_core::steamgriddb_preview(&url)?;
            Ok(DesktopSteamGridDbPreview {
                png_base64: base64::engine::general_purpose::STANDARD.encode(png),
            })
        },
    )
    .await
}

/// Checks whether SteamGridDB still lists the library's SteamGridDB images and
/// records the evidence. The service is held only to prepare and to record: the
/// network phase keeps no library lease, so switching, moving or importing a
/// library proceeds at once. The check then stops before its next request and
/// records nothing, returning what it saw.
#[tauri::command]
pub(crate) async fn check_steamgriddb_listings(
    state: tauri::State<'_, DesktopState>,
    generation: u64,
) -> DesktopResult<SteamGridDbListingReport> {
    let state = state.inner().clone();
    blocking_worker(move || {
        let cancelled = || crate::state_generation(&state) != generation;
        let prepared =
            service_at_generation(&state, generation)?.prepare_steamgriddb_listing_check()?;
        let checked = prepared.check(&cancelled)?;
        Ok(match service_at_generation(&state, generation) {
            Ok(service) => service.record_steamgriddb_listings(checked, &cancelled),
            Err(_) => checked.unrecorded(),
        })
    })
    .await
}

#[tauri::command]
pub(crate) async fn preview_steamgriddb_background(
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    game_id: u64,
    candidate_id: u64,
    generation: u64,
) -> DesktopResult<crate::artwork::DesktopArtworkSelectionPreview> {
    let state = state.inner().clone();
    crate::artwork::thumbnail_worker(
        crate::artwork::remote_thumbnail_workers(),
        true,
        move || {
            let preview = service_at_generation(&state, generation)?
                .preview_steamgriddb_background(&port_id, game_id, candidate_id)?;
            crate::require_library_generation(crate::state_generation(&state), generation)?;
            Ok(preview.into())
        },
    )
    .await
}

#[tauri::command]
pub(crate) async fn choose_steamgriddb_artwork(
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    slot: ArtworkSlot,
    game_id: u64,
    candidate_id: u64,
    expected_revision: u64,
    generation: u64,
    framing: Option<ArtworkSelectionFraming>,
) -> DesktopResult<ArtworkState> {
    let state = state.inner().clone();
    blocking_worker(move || {
        let prepared = service_at_generation(&state, generation)?.prepare_steamgriddb_artwork(
            &port_id,
            slot,
            game_id,
            candidate_id,
        )?;
        let service = service_at_generation(&state, generation)?;
        prepared
            .apply(&service, expected_revision, framing)
            .map_err(Into::into)
    })
    .await
}
