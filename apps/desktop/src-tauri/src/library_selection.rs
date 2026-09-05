//! Desktop library choice and live handoff. Durable selection stays in core.

use crate::{
    BootstrapStatus, DesktopError, DesktopResult, DesktopState, blocking_worker, bootstrap_status,
    initialize_desktop_selection, observe_launch_completion, ready,
};
use portcove_core::{Library, LibrarySelection, LibrarySelectionSource, PortcoveError};
use std::path::PathBuf;

#[tauri::command]
pub(crate) async fn set_default_library(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
    path: PathBuf,
) -> DesktopResult<BootstrapStatus> {
    let state = state.inner().clone();
    let worker_state = state.clone();
    let status = blocking_worker(move || switch_library(&worker_state, Some(path))).await?;
    observe_reopened_library(&app, &state)?;
    Ok(status)
}

#[tauri::command]
pub(crate) async fn reset_default_library(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
) -> DesktopResult<BootstrapStatus> {
    let state = state.inner().clone();
    let worker_state = state.clone();
    let status = blocking_worker(move || switch_library(&worker_state, None)).await?;
    observe_reopened_library(&app, &state)?;
    Ok(status)
}

fn observe_reopened_library(app: &tauri::AppHandle, state: &DesktopState) -> DesktopResult<()> {
    let ready_state = ready(state)?;
    for session in ready_state
        .library
        .launch_sessions()
        .map_err(DesktopError::from)?
    {
        observe_launch_completion(app, state, ready_state.library.clone(), session.id)?;
    }
    Ok(())
}

fn switch_library(
    state: &DesktopState,
    requested: Option<PathBuf>,
) -> DesktopResult<BootstrapStatus> {
    let preferences = state.preferences.as_ref().map_err(Clone::clone)?.clone();
    let (target, source) = match requested {
        Some(root) => (
            Library::validate_selection_target(&root).map_err(DesktopError::from)?,
            LibrarySelectionSource::Saved,
        ),
        None => (
            Library::default_root().map_err(DesktopError::from)?,
            LibrarySelectionSource::PlatformDefault,
        ),
    };
    let selection = LibrarySelection {
        root: target,
        source,
    };
    if selection.source == LibrarySelectionSource::Saved {
        // Refuse a damaged/future document before opening (and potentially
        // initializing) a newly selected empty directory. Reset is the explicit
        // recovery operation for those documents.
        preferences.load().map_err(DesktopError::from)?;
    }

    let previous = {
        let mut initialization = state.initialization.lock().map_err(|_| {
            DesktopError::from(PortcoveError::state("desktop state lock was poisoned"))
        })?;
        if let Ok(current) = initialization.as_mut()
            && current.library.root() == selection.root
        {
            persist_selection(&preferences, &selection)?;
            current.selection = selection;
            state
                .generation
                .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
            drop(initialization);
            return Ok(bootstrap_status(state));
        }
        std::mem::replace(
            &mut *initialization,
            Err(PortcoveError::conflict("library switch is in progress")
                .detail("library_switch_in_progress", "true")
                .into()),
        )
    };

    let previous_selection = previous.as_ref().ok().map(|ready| ready.selection.clone());
    let previous_root = previous
        .as_ref()
        .ok()
        .map(|ready| ready.library.root().to_path_buf());
    drop(previous);

    if let Some(root) = &previous_root
        && let Err(error) = Library::confirm_idle_for_switch(root)
    {
        restore_previous(state, previous_selection);
        return Err(error.into());
    }

    let next = match initialize_desktop_selection(selection.clone()) {
        Ok(next) => next,
        Err(error) => {
            restore_previous(state, previous_selection);
            return Err(error);
        }
    };
    if let Err(error) = persist_selection(&preferences, &selection) {
        drop(next);
        restore_previous(state, previous_selection);
        return Err(error);
    }
    *state.initialization.lock().map_err(|_| {
        DesktopError::from(PortcoveError::state("desktop state lock was poisoned"))
    })? = Ok(next);
    state
        .generation
        .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
    Ok(bootstrap_status(state))
}

fn persist_selection(
    preferences: &portcove_core::HostPreferenceStore,
    selection: &LibrarySelection,
) -> DesktopResult<()> {
    match selection.source {
        LibrarySelectionSource::Saved => preferences
            .set_library(&selection.root)
            .map_err(DesktopError::from),
        LibrarySelectionSource::PlatformDefault => preferences.reset().map_err(DesktopError::from),
        LibrarySelectionSource::Invocation => Err(PortcoveError::state(
            "an invocation override cannot be persisted as a desktop selection",
        )
        .into()),
    }
}

fn restore_previous(state: &DesktopState, selection: Option<LibrarySelection>) {
    let restored = selection.map_or_else(
        || Err(PortcoveError::state("no library has been selected").into()),
        initialize_desktop_selection,
    );
    if let Ok(mut initialization) = state.initialization.lock() {
        *initialization = restored;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use portcove_core::HostPreferenceStore;
    use std::fs;

    fn desktop_state(preferences: HostPreferenceStore, root: PathBuf) -> DesktopState {
        DesktopState {
            initialization: std::sync::Arc::new(std::sync::Mutex::new(
                crate::initialize_desktop_at(Some(root)),
            )),
            preferences: Ok(preferences),
            generation: std::sync::Arc::new(std::sync::atomic::AtomicU64::new(1)),
            launch_observer: std::sync::Arc::new(std::sync::Mutex::new(None)),
        }
    }

    #[test]
    fn switch_rejects_inflight_library_and_preserves_selection() {
        let temporary = tempfile::tempdir().unwrap();
        let current = temporary.path().join("current");
        let next = temporary.path().join("next");
        fs::create_dir(&next).unwrap();
        let preferences =
            HostPreferenceStore::new(temporary.path().join("config/preferences.json")).unwrap();
        let state = desktop_state(preferences, current.clone());
        let pending = crate::service(&state).unwrap();

        assert!(switch_library(&state, Some(next.clone())).is_err());
        assert_eq!(crate::ready(&state).unwrap().library.root(), current);
        assert!(!next.join("portcove.sqlite3").exists());
        drop(pending);

        let switched = switch_library(&state, Some(next.clone())).unwrap();
        assert_eq!(switched.generation, 2);
        assert_eq!(
            switched.selection.unwrap().root,
            fs::canonicalize(next).unwrap()
        );
    }

    #[test]
    fn failed_target_and_reset_recovery_do_not_abandon_the_open_library() {
        let temporary = tempfile::tempdir().unwrap();
        let current = temporary.path().join("current");
        let unrelated = temporary.path().join("unrelated");
        fs::create_dir(&unrelated).unwrap();
        fs::write(unrelated.join("keep.txt"), b"preserve").unwrap();
        let preferences =
            HostPreferenceStore::new(temporary.path().join("config/preferences.json")).unwrap();
        let state = desktop_state(preferences, current.clone());

        assert!(switch_library(&state, Some(unrelated.clone())).is_err());
        assert_eq!(crate::ready(&state).unwrap().library.root(), current);
        assert_eq!(fs::read(unrelated.join("keep.txt")).unwrap(), b"preserve");
    }

    #[test]
    fn damaged_preferences_require_reset_before_an_empty_target_is_initialized() {
        let temporary = tempfile::tempdir().unwrap();
        let current = temporary.path().join("current");
        let next = temporary.path().join("next");
        fs::create_dir(&next).unwrap();
        let preference_path = temporary.path().join("config/preferences.json");
        fs::create_dir_all(preference_path.parent().unwrap()).unwrap();
        fs::write(&preference_path, b"{").unwrap();
        let state = desktop_state(
            HostPreferenceStore::new(preference_path.clone()).unwrap(),
            current.clone(),
        );

        assert!(switch_library(&state, Some(next.clone())).is_err());
        assert_eq!(crate::ready(&state).unwrap().library.root(), current);
        assert_eq!(fs::read(preference_path).unwrap(), b"{");
        assert_eq!(fs::read_dir(next).unwrap().count(), 0);
    }
}
