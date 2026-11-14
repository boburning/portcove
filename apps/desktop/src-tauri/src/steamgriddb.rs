//! Native adapter for Core's player-key SteamGridDB client. Core owns the key,
//! the fixed-origin client, validation and ingestion; this module only moves
//! blocking work off the IPC runtime. The key is accepted for saving but never
//! returned to the renderer.
use crate::{DesktopResult, DesktopState, blocking_worker, service_at_generation};
use base64::Engine as _;
use portcove_core::{
    ArtworkSlot, ArtworkState, DestinationArtworkRole, SteamGridDbCandidate, SteamGridDbGame,
    SteamGridDbKeyStatus, SteamGridDbListingReport,
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
    role: DestinationArtworkRole,
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
/// records the evidence. It stops before the next request, and records nothing,
/// once the library generation changes.
#[tauri::command]
pub(crate) async fn check_steamgriddb_listings(
    state: tauri::State<'_, DesktopState>,
    generation: u64,
) -> DesktopResult<SteamGridDbListingReport> {
    let state = state.inner().clone();
    blocking_worker(move || {
        let service = service_at_generation(&state, generation)?;
        let cancelled = || crate::state_generation(&state) != generation;
        service
            .check_steamgriddb_listings_until(&cancelled)
            .map_err(Into::into)
    })
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
) -> DesktopResult<ArtworkState> {
    let state = state.inner().clone();
    blocking_worker(move || {
        service_at_generation(&state, generation)?
            .choose_steamgriddb_artwork(&port_id, slot, game_id, candidate_id, expected_revision)
            .map_err(Into::into)
    })
    .await
}
