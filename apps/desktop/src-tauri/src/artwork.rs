//! Native adapter for core-owned local artwork; no image or selection policy.
use crate::{DesktopResult, DesktopState, blocking_worker, service_at_generation};
use portcove_core::{ArtworkSlot, ArtworkState, ArtworkThumbnail};
use std::path::PathBuf;

#[tauri::command]
pub(crate) async fn get_artwork(
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    slot: ArtworkSlot,
    generation: u64,
) -> DesktopResult<ArtworkState> {
    let state = state.inner().clone();
    blocking_worker(move || {
        service_at_generation(&state, generation)?
            .artwork(&port_id, slot)
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub(crate) async fn get_artwork_thumbnail(
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    slot: ArtworkSlot,
    expected_revision: u64,
    generation: u64,
) -> DesktopResult<ArtworkThumbnail> {
    let state = state.inner().clone();
    blocking_worker(move || {
        service_at_generation(&state, generation)?
            .artwork_thumbnail(&port_id, slot, expected_revision)
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub(crate) async fn import_artwork(
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    slot: ArtworkSlot,
    path: PathBuf,
    expected_revision: u64,
    generation: u64,
) -> DesktopResult<ArtworkState> {
    let state = state.inner().clone();
    blocking_worker(move || {
        service_at_generation(&state, generation)?
            .import_artwork(&port_id, slot, &path, expected_revision)
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub(crate) async fn reset_artwork(
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    slot: ArtworkSlot,
    expected_revision: u64,
    generation: u64,
) -> DesktopResult<ArtworkState> {
    let state = state.inner().clone();
    blocking_worker(move || {
        service_at_generation(&state, generation)?
            .reset_artwork(&port_id, slot, expected_revision)
            .map_err(Into::into)
    })
    .await
}
