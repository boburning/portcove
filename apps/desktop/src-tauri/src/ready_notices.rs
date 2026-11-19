//! Generation-bound transport for the per-library ready-notices setting.
//!
//! Core owns the durable value (`Library::ready_notices_enabled`); this adapter
//! only reads and writes it for the library the webview is looking at. It never
//! changes a game's choice or automatic setup.
use crate::{DesktopResult, DesktopState, blocking_worker, library_at_generation};

#[tauri::command]
pub(crate) async fn get_ready_notices_enabled(
    state: tauri::State<'_, DesktopState>,
    generation: u64,
) -> DesktopResult<bool> {
    let state = state.inner().clone();
    blocking_worker(move || Ok(library_at_generation(&state, generation)?.ready_notices_enabled()?))
        .await
}

/// Returns the value now stored, so the caller shows what Core holds.
#[tauri::command]
pub(crate) async fn set_ready_notices_enabled(
    state: tauri::State<'_, DesktopState>,
    enabled: bool,
    generation: u64,
) -> DesktopResult<bool> {
    let state = state.inner().clone();
    blocking_worker(move || {
        let library = library_at_generation(&state, generation)?;
        library.set_ready_notices_enabled(enabled)?;
        Ok(library.ready_notices_enabled()?)
    })
    .await
}
