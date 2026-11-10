//! Generation-bound transport for the per-library automatic-snapshots setting.
//!
//! Core owns the durable value (`Library::automatic_snapshots_enabled`); this
//! adapter only reads and writes it for the library the webview is looking at.
use crate::{DesktopResult, DesktopState, blocking_worker, library_at_generation};

#[tauri::command]
pub(crate) async fn get_automatic_snapshots(
    state: tauri::State<'_, DesktopState>,
    generation: u64,
) -> DesktopResult<bool> {
    let state = state.inner().clone();
    blocking_worker(move || {
        Ok(library_at_generation(&state, generation)?.automatic_snapshots_enabled()?)
    })
    .await
}

/// Returns the value now stored, so the caller shows what Core holds.
#[tauri::command]
pub(crate) async fn set_automatic_snapshots(
    state: tauri::State<'_, DesktopState>,
    enabled: bool,
    generation: u64,
) -> DesktopResult<bool> {
    let state = state.inner().clone();
    blocking_worker(move || {
        let library = library_at_generation(&state, generation)?;
        library.set_automatic_snapshots(enabled)?;
        Ok(library.automatic_snapshots_enabled()?)
    })
    .await
}
