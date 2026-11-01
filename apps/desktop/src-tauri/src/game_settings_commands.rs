//! Library-bound adapter; Core owns all settings eligibility and mutation.
use crate::{
    DesktopError, DesktopResult, DesktopState, blocking_worker, require_library_generation,
    state_generation,
};
use portcove_core::{
    GameSettingChange, GameSettingReview, GameSettingsView, PortcoveError, PortcoveService,
    ReleaseProvider,
};

fn at_generation<T>(
    state: &DesktopState,
    generation: u64,
    operation: impl FnOnce(PortcoveService) -> portcove_core::Result<T>,
) -> DesktopResult<T> {
    // Keep the selection binding through the complete synchronous operation.
    // Library switching cannot redirect or retire it after the generation check.
    let initialization = state
        .initialization
        .lock()
        .map_err(|_| DesktopError::from(PortcoveError::state("desktop state lock was poisoned")))?;
    require_library_generation(state_generation(state), generation)?;
    let ready = initialization.as_ref().map_err(Clone::clone)?;
    let releases: std::sync::Arc<dyn ReleaseProvider> = ready.releases.clone();
    let service = PortcoveService::with_provider_read_only(ready.library.clone(), releases)?;
    operation(service).map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn get_game_settings(
    state: tauri::State<'_, DesktopState>,
    generation: u64,
    port_id: String,
) -> DesktopResult<GameSettingsView> {
    let state = state.inner().clone();
    blocking_worker(move || {
        at_generation(&state, generation, |service| {
            service.get_game_settings(&port_id)
        })
    })
    .await
}

#[tauri::command]
pub(crate) async fn review_game_setting(
    state: tauri::State<'_, DesktopState>,
    generation: u64,
    port_id: String,
    file_id: String,
    setting_id: String,
    change: GameSettingChange,
) -> DesktopResult<GameSettingReview> {
    let state = state.inner().clone();
    blocking_worker(move || {
        at_generation(&state, generation, |service| {
            service.review_game_setting(&port_id, &file_id, &setting_id, change)
        })
    })
    .await
}

#[tauri::command]
pub(crate) async fn apply_game_setting(
    state: tauri::State<'_, DesktopState>,
    generation: u64,
    port_id: String,
    file_id: String,
    setting_id: String,
    change: GameSettingChange,
    review_sha256: String,
) -> DesktopResult<GameSettingsView> {
    let state = state.inner().clone();
    blocking_worker(move || {
        at_generation(&state, generation, |service| {
            service.apply_game_setting(&port_id, &file_id, &setting_id, change, &review_sha256)
        })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::initialize_desktop_selection;
    use portcove_core::{ErrorCode, HostPreferenceStore, LibrarySelection, LibrarySelectionSource};
    use std::sync::{Arc, Mutex, atomic::AtomicU64};

    #[test]
    fn stale_settings_generation_never_enters_the_core_operation() {
        let temporary = tempfile::tempdir().unwrap();
        let state = DesktopState {
            initialization: Arc::new(Mutex::new(initialize_desktop_selection(LibrarySelection {
                root: temporary.path().join("library"),
                source: LibrarySelectionSource::Invocation,
            }))),
            preferences: HostPreferenceStore::new(temporary.path().join("preferences.json"))
                .map_err(DesktopError::from),
            generation: Arc::new(AtomicU64::new(2)),
            launch_observer: Arc::new(Mutex::new(None)),
        };
        let mut entered = false;
        let result = at_generation(&state, 1, |_| {
            entered = true;
            Ok(())
        });
        assert!(!entered);
        assert_eq!(result.unwrap_err().code, ErrorCode::Conflict);
    }
}
