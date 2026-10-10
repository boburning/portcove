//! Private library-scoped host choices. Durable preferences remain in Core.
use crate::{
    DesktopError, DesktopResult, DesktopState, blocking_worker, require_library_generation,
    state_generation,
};
use portcove_core::PortcoveError;

#[tauri::command]
pub(crate) async fn get_favorite_ports(
    state: tauri::State<'_, DesktopState>,
    generation: u64,
) -> DesktopResult<Vec<String>> {
    let state = state.inner().clone();
    blocking_worker(move || favorite_ports_at_generation(&state, generation, None)).await
}

#[tauri::command]
pub(crate) async fn set_port_favorite(
    state: tauri::State<'_, DesktopState>,
    generation: u64,
    port_id: String,
    favorite: bool,
) -> DesktopResult<()> {
    let state = state.inner().clone();
    blocking_worker(move || {
        favorite_ports_at_generation(&state, generation, Some((&port_id, favorite))).map(|_| ())
    })
    .await
}

fn favorite_ports_at_generation(
    state: &DesktopState,
    generation: u64,
    change: Option<(&str, bool)>,
) -> DesktopResult<Vec<String>> {
    // Hold the selection binding through the preference operation. A handoff cannot
    // start between identity resolution and writing another library's choices.
    let initialization = state
        .initialization
        .lock()
        .map_err(|_| DesktopError::from(PortcoveError::state("desktop state lock was poisoned")))?;
    require_library_generation(state_generation(state), generation)?;
    let library = &initialization.as_ref().map_err(Clone::clone)?.library;
    let identity = library.identity_record().map_err(DesktopError::from)?;
    let preferences = state.preferences.as_ref().map_err(Clone::clone)?;
    if let Some((port_id, favorite)) = change {
        preferences
            .set_favorite(&identity.id, port_id, favorite)
            .map_err(DesktopError::from)?;
        // Success acknowledges only this committed choice. Do not turn a failed
        // subsequent read into a misleading failed-write response.
        Ok(Vec::new())
    } else {
        preferences
            .favorite_ports(&identity.id)
            .map(|ports| ports.into_iter().collect())
            .map_err(DesktopError::from)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::initialize_desktop_selection;
    use portcove_core::{ErrorCode, HostPreferenceStore, LibrarySelection, LibrarySelectionSource};
    use std::sync::{Arc, Mutex, atomic::AtomicU64};

    fn state(root: std::path::PathBuf, preferences: HostPreferenceStore) -> DesktopState {
        DesktopState {
            initialization: Arc::new(Mutex::new(initialize_desktop_selection(LibrarySelection {
                root,
                source: LibrarySelectionSource::Invocation,
            }))),
            preferences: Ok(preferences),
            generation: Arc::new(AtomicU64::new(0)),
            launch_observer: Arc::new(Mutex::new(None)),
        }
    }

    #[test]
    fn favorites_bind_to_canonical_identity_across_restart_and_library_switch() {
        let tmp = tempfile::tempdir().unwrap();
        let prefs = HostPreferenceStore::new(tmp.path().join("preferences.json")).unwrap();
        let first = tmp.path().join("first");
        let desktop = state(first.clone(), prefs.clone());
        assert!(
            favorite_ports_at_generation(&desktop, 0, None)
                .unwrap()
                .is_empty()
        );
        assert!(!tmp.path().join("preferences.json").exists());
        favorite_ports_at_generation(&desktop, 0, Some(("temporarily-absent-port", true))).unwrap();
        let restarted = state(first, prefs.clone());
        assert_eq!(
            favorite_ports_at_generation(&restarted, 0, None).unwrap(),
            ["temporarily-absent-port"]
        );
        *desktop.initialization.lock().unwrap() = initialize_desktop_selection(LibrarySelection {
            root: tmp.path().join("second"),
            source: LibrarySelectionSource::Invocation,
        });
        desktop
            .generation
            .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
        assert_eq!(
            favorite_ports_at_generation(&desktop, 0, Some(("other-port", true)))
                .unwrap_err()
                .code,
            ErrorCode::Conflict
        );
        assert!(
            favorite_ports_at_generation(&desktop, state_generation(&desktop), None)
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            favorite_ports_at_generation(&restarted, 0, None).unwrap(),
            ["temporarily-absent-port"]
        );
        favorite_ports_at_generation(&restarted, 0, Some(("temporarily-absent-port", false)))
            .unwrap();
        assert!(
            favorite_ports_at_generation(&restarted, 0, None)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn preference_failure_and_unavailable_selection_are_independent_of_browsing() {
        let tmp = tempfile::tempdir().unwrap();
        let prefs = HostPreferenceStore::new(tmp.path().join("preferences.json")).unwrap();
        let desktop = state(tmp.path().join("library"), prefs.clone());
        std::fs::write(
            tmp.path().join("preferences.json"),
            r#"{"format_version":1,"favorites_by_library":false}"#,
        )
        .unwrap();
        assert!(favorite_ports_at_generation(&desktop, 0, None).is_err());
        assert!(crate::service_at_generation(&desktop, 0).is_ok());
        let before = std::fs::read(tmp.path().join("preferences.json")).unwrap();
        assert!(favorite_ports_at_generation(&desktop, 0, Some(("port", true))).is_err());
        assert_eq!(
            before,
            std::fs::read(tmp.path().join("preferences.json")).unwrap()
        );
        *desktop.initialization.lock().unwrap() =
            Err(PortcoveError::conflict("library switch is in progress").into());
        assert!(favorite_ports_at_generation(&desktop, 0, Some(("port", true))).is_err());
        assert_eq!(
            before,
            std::fs::read(tmp.path().join("preferences.json")).unwrap()
        );
    }
}
