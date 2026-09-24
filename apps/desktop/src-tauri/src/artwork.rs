//! Native adapter for core-owned local artwork; no image or selection policy.
use crate::{DesktopResult, DesktopState, blocking_worker, service_at_generation};
use base64::Engine as _;
use portcove_core::{ArtworkSlot, ArtworkState, ArtworkThumbnail};
use serde::Serialize;
use std::path::PathBuf;

#[derive(Serialize)]
pub(crate) struct DesktopArtworkThumbnail {
    asset_sha256: String,
    choice_revision: u64,
    png_base64: String,
}

fn display_thumbnail(thumbnail: ArtworkThumbnail) -> DesktopArtworkThumbnail {
    DesktopArtworkThumbnail {
        asset_sha256: thumbnail.asset_sha256,
        choice_revision: thumbnail.choice_revision,
        png_base64: base64::engine::general_purpose::STANDARD.encode(thumbnail.png),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_thumbnail_preserves_identity_and_bytes_without_changing_core_shape() {
        let core = ArtworkThumbnail {
            asset_sha256: "a".repeat(64),
            choice_revision: 7,
            png: vec![137, 80, 78, 71],
        };
        let display = display_thumbnail(core);
        assert_eq!(display.asset_sha256, "a".repeat(64));
        assert_eq!(display.choice_revision, 7);
        assert_eq!(display.png_base64, "iVBORw==");
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(display.png_base64)
                .unwrap(),
            [137, 80, 78, 71]
        );
    }
}

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
) -> DesktopResult<DesktopArtworkThumbnail> {
    let state = state.inner().clone();
    blocking_worker(move || {
        service_at_generation(&state, generation)?
            .artwork_thumbnail(&port_id, slot, expected_revision)
            .map(display_thumbnail)
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
