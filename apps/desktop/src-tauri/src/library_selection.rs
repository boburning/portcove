//! Desktop library choice and live handoff. Durable selection stays in core.

use crate::{
    BootstrapStatus, DesktopError, DesktopResult, DesktopState, blocking_worker, bootstrap_status,
    initialize_desktop_selection, observe_launch_completion, ready, require_no_library_handoff,
};
use portcove_core::{
    ErrorCode, HostPreferenceStore, Library, LibrarySelection, LibrarySelectionContents,
    LibrarySelectionSource, PortcoveError,
};
use schemars::JsonSchema;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::time::{Duration, Instant};

#[tauri::command]
pub(crate) fn get_default_library_root() -> DesktopResult<PathBuf> {
    Library::default_root().map_err(DesktopError::from)
}

#[tauri::command]
pub(crate) async fn get_library_identity(
    state: tauri::State<'_, DesktopState>,
    generation: u64,
) -> DesktopResult<portcove_core::LibraryIdentity> {
    let state = state.inner().clone();
    blocking_worker(move || {
        let service = crate::service_at_generation(&state, generation)?;
        service.library().identity_record().map_err(Into::into)
    })
    .await
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum LibrarySelectionEffect {
    Keep,
    ChangeStartup,
    Open,
}

#[derive(Debug, Serialize, JsonSchema)]
pub(crate) struct LibrarySelectionReview {
    path: PathBuf,
    source: LibrarySelectionSource,
    effect: LibrarySelectionEffect,
    contents: LibrarySelectionContents,
    resets_preferences: bool,
    review_sha256: String,
}

#[tauri::command]
pub(crate) async fn review_library_selection(
    state: tauri::State<'_, DesktopState>,
    path: Option<PathBuf>,
    generation: u64,
) -> DesktopResult<LibrarySelectionReview> {
    let state = state.inner().clone();
    blocking_worker(move || {
        let preferences = state.preferences.as_ref().map_err(Clone::clone)?;
        let selection = selection_request(path)?;
        let initialization = state.initialization.lock().map_err(|_| {
            DesktopError::from(PortcoveError::state("desktop state lock was poisoned"))
        })?;
        require_no_library_handoff(&initialization)?;
        if crate::state_generation(&state) != generation {
            return Err(stale_library_selection());
        }
        let saved_choice = read_saved_choice(preferences, selection.source)?;
        let current = initialization
            .as_ref()
            .ok()
            .map(|ready| (ready.library.root(), ready.selection.source));
        selection_review(&selection, current, &saved_choice, generation)
    })
    .await
}

#[tauri::command]
pub(crate) async fn set_default_library(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
    path: PathBuf,
    expected_review: Option<String>,
) -> DesktopResult<BootstrapStatus> {
    let state = state.inner().clone();
    let worker_state = state.clone();
    let outcome = blocking_worker(move || {
        switch_library(&worker_state, Some(path), expected_review.as_deref())
    })
    .await?;
    finish_selection(outcome, || observe_reopened_library(&app, &state))
}

#[tauri::command]
pub(crate) async fn reset_default_library(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
    expected_review: Option<String>,
) -> DesktopResult<BootstrapStatus> {
    let state = state.inner().clone();
    let worker_state = state.clone();
    let outcome =
        blocking_worker(move || switch_library(&worker_state, None, expected_review.as_deref()))
            .await?;
    finish_selection(outcome, || observe_reopened_library(&app, &state))
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

#[derive(Debug)]
struct LibrarySelectionOutcome {
    status: BootstrapStatus,
    reopened: bool,
}

fn finish_selection(
    outcome: LibrarySelectionOutcome,
    observe: impl FnOnce() -> DesktopResult<()>,
) -> DesktopResult<BootstrapStatus> {
    if outcome.reopened {
        observe()?;
    }
    Ok(outcome.status)
}

fn selection_request(requested: Option<PathBuf>) -> DesktopResult<LibrarySelection> {
    let (root, source) = match requested {
        Some(root) => (
            Library::validate_selection_target(&root).map_err(DesktopError::from)?,
            LibrarySelectionSource::Saved,
        ),
        None => (
            Library::default_root().map_err(DesktopError::from)?,
            LibrarySelectionSource::PlatformDefault,
        ),
    };
    Ok(LibrarySelection { root, source })
}

fn read_saved_choice(
    preferences: &HostPreferenceStore,
    source: LibrarySelectionSource,
) -> DesktopResult<Option<Option<PathBuf>>> {
    // Only an explicit reset may recover an unusable preference document.
    match preferences.load() {
        Ok(preferences) => Ok(Some(preferences.library_root)),
        Err(error)
            if source == LibrarySelectionSource::PlatformDefault
                && HostPreferenceStore::can_reset_invalid_document(&error) =>
        {
            Ok(None)
        }
        Err(error) => Err(error.into()),
    }
}

fn startup_choice_matches(
    selection: &LibrarySelection,
    saved_choice: &Option<Option<PathBuf>>,
) -> bool {
    match (&selection.source, saved_choice) {
        (LibrarySelectionSource::Saved, Some(Some(root))) => {
            same_existing_library(root, &selection.root)
        }
        (LibrarySelectionSource::PlatformDefault, Some(None)) => true,
        _ => false,
    }
}

fn stale_library_selection() -> DesktopError {
    PortcoveError::conflict("the library selection changed after review; check the target again")
        .into()
}

fn selection_review(
    selection: &LibrarySelection,
    active: Option<(&std::path::Path, LibrarySelectionSource)>,
    saved_choice: &Option<Option<PathBuf>>,
    generation: u64,
) -> DesktopResult<LibrarySelectionReview> {
    let (path, contents) = match Library::inspect_selection_target(&selection.root) {
        Ok(target) => {
            if let Some(destination) = target.relocated_to {
                return Err(PortcoveError::conflict(
                    "This library was moved. Choose its current folder before switching.",
                )
                .detail("library_root", target.root.display().to_string())
                .detail("current_library_root", destination.display().to_string())
                .into());
            }
            (target.root, target.contents)
        }
        Err(error)
            if error.code == ErrorCode::NotFound
                && selection.source == LibrarySelectionSource::PlatformDefault
                && !selection.root.exists() =>
        {
            (
                selection.root.clone(),
                LibrarySelectionContents::NewDefaultDirectory,
            )
        }
        Err(error) => return Err(error.into()),
    };
    let effect = match active {
        Some((root, source)) if same_existing_library(root, &path) => {
            if source == selection.source && startup_choice_matches(selection, saved_choice) {
                LibrarySelectionEffect::Keep
            } else {
                LibrarySelectionEffect::ChangeStartup
            }
        }
        _ => LibrarySelectionEffect::Open,
    };
    let binding = serde_json::to_vec(&(
        "portcove-library-selection-review-v1",
        generation,
        &path,
        selection.source,
        contents,
        effect,
        active,
        saved_choice,
    ))
    .map_err(PortcoveError::from)?;
    Ok(LibrarySelectionReview {
        path,
        source: selection.source,
        effect,
        contents,
        resets_preferences: saved_choice.is_none(),
        review_sha256: format!("{:x}", Sha256::digest(binding)),
    })
}

fn switch_library(
    state: &DesktopState,
    requested: Option<PathBuf>,
    expected_review: Option<&str>,
) -> DesktopResult<LibrarySelectionOutcome> {
    let preferences = state.preferences.as_ref().map_err(Clone::clone)?.clone();
    let selection = selection_request(requested)?;

    let (previous, reviewed_choice) = {
        let mut initialization = state.initialization.lock().map_err(|_| {
            DesktopError::from(PortcoveError::state("desktop state lock was poisoned"))
        })?;
        require_no_library_handoff(&initialization)?;
        let saved_choice = read_saved_choice(&preferences, selection.source)?;
        if let Some(expected) = expected_review {
            let current = initialization
                .as_ref()
                .ok()
                .map(|ready| (ready.library.root(), ready.selection.source));
            let fresh = selection_review(
                &selection,
                current,
                &saved_choice,
                crate::state_generation(state),
            )?;
            if fresh.review_sha256 != expected {
                return Err(stale_library_selection());
            }
        }
        if let Ok(current) = initialization.as_mut()
            && same_existing_library(current.library.root(), &selection.root)
        {
            if current.selection.source == selection.source
                && startup_choice_matches(&selection, &saved_choice)
            {
                drop(initialization);
                return Ok(LibrarySelectionOutcome {
                    status: bootstrap_status(state),
                    reopened: false,
                });
            }
            persist_library_choice(
                &preferences,
                &selection,
                expected_review.map(|_| &saved_choice),
            )?;
            current.selection = selection;
            state
                .generation
                .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
            drop(initialization);
            crate::recent_play_shortcuts::refresh(state.clone());
            return Ok(LibrarySelectionOutcome {
                status: bootstrap_status(state),
                reopened: false,
            });
        }
        (
            std::mem::replace(
                &mut *initialization,
                Err(PortcoveError::conflict("library switch is in progress")
                    .detail("library_switch_in_progress", "true")
                    .into()),
            ),
            expected_review.map(|_| saved_choice),
        )
    };

    let previous_selection = previous.as_ref().ok().map(|ready| ready.selection.clone());
    let previous_root = previous
        .as_ref()
        .ok()
        .map(|ready| ready.library.root().to_path_buf());
    drop(previous);

    if let Some(root) = &previous_root
        && let Err(error) = wait_for_outgoing_library(root)
    {
        restore_previous(state, previous_selection);
        return Err(error.into());
    }

    if let Some(expected) = expected_review {
        let previous = previous_root.as_deref().zip(
            previous_selection
                .as_ref()
                .map(|selection| selection.source),
        );
        let fresh_review = read_saved_choice(&preferences, selection.source).and_then(|choice| {
            selection_review(
                &selection,
                previous,
                &choice,
                crate::state_generation(state),
            )
        });
        match fresh_review {
            Ok(review) if review.review_sha256 == expected => {}
            result => {
                restore_previous(state, previous_selection);
                return Err(result.err().unwrap_or_else(stale_library_selection));
            }
        }
    }

    let opened = if expected_review.is_some() {
        Library::open_reviewed_selection(&selection.root)
            .map_err(DesktopError::from)
            .and_then(|library| crate::ready_desktop_selection(selection.clone(), library))
    } else {
        initialize_desktop_selection(selection.clone())
    };
    let next = match opened {
        Ok(next) => next,
        Err(error) => {
            restore_previous(state, previous_selection);
            return Err(error);
        }
    };
    if let Err(error) = persist_library_choice(&preferences, &selection, reviewed_choice.as_ref()) {
        drop(next);
        restore_previous(state, previous_selection);
        return Err(error);
    }
    {
        let mut initialization = state.initialization.lock().map_err(|_| {
            DesktopError::from(PortcoveError::state("desktop state lock was poisoned"))
        })?;
        *initialization = Ok(next);
        state
            .generation
            .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
    }
    crate::recent_play_shortcuts::refresh(state.clone());
    Ok(LibrarySelectionOutcome {
        status: bootstrap_status(state),
        reopened: true,
    })
}

fn same_existing_library(current: &std::path::Path, target: &std::path::Path) -> bool {
    // Core validates existing roots, including aliases. A missing default root
    // must still take the normal initialization path below.
    match (
        Library::validate_selection_target(current),
        Library::validate_selection_target(target),
    ) {
        (Ok(current), Ok(target)) => current == target,
        _ => false,
    }
}

pub(crate) fn wait_for_outgoing_library(root: &std::path::Path) -> portcove_core::Result<()> {
    // The in-progress state stops new readers. Give already-dispatched short
    // reads time to release their shared lease before opening another library.
    const DRAIN_LIMIT: Duration = Duration::from_secs(2);
    let started = Instant::now();
    loop {
        match Library::confirm_idle_for_switch(root) {
            Ok(()) => return Ok(()),
            Err(error)
                if error.code == ErrorCode::Conflict
                    && error.message
                        == "the library is in use by another Portcove operation or process"
                    && started.elapsed() < DRAIN_LIMIT =>
            {
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(error) => return Err(error),
        }
    }
}

fn persist_library_choice(
    preferences: &HostPreferenceStore,
    selection: &LibrarySelection,
    reviewed_choice: Option<&Option<Option<PathBuf>>>,
) -> DesktopResult<()> {
    let Some(choice) = reviewed_choice else {
        return persist_selection(preferences, selection);
    };
    let choice = choice.as_ref().map(|root| root.as_deref());
    match selection.source {
        LibrarySelectionSource::Saved => preferences
            .set_reviewed_library(&selection.root, choice.ok_or_else(stale_library_selection)?),
        LibrarySelectionSource::PlatformDefault => preferences.clear_reviewed_library(choice),
        LibrarySelectionSource::Invocation => {
            return Err(stale_library_selection());
        }
    }
    .map_err(Into::into)
}

fn persist_selection(
    preferences: &portcove_core::HostPreferenceStore,
    selection: &LibrarySelection,
) -> DesktopResult<()> {
    match selection.source {
        LibrarySelectionSource::Saved => preferences
            .set_library(&selection.root)
            .map_err(DesktopError::from),
        LibrarySelectionSource::PlatformDefault => preferences
            .clear_library_or_reset_invalid()
            .map_err(DesktopError::from),
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
    fn existing_library_comparison_handles_ordinary_and_canonical_roots() {
        let temporary = tempfile::tempdir().unwrap();
        let current = temporary.path().join("current");
        let other = temporary.path().join("other");
        let _library = Library::open(current.clone()).unwrap();
        let _other = Library::open(other.clone()).unwrap();
        let canonical = Library::validate_selection_target(&current).unwrap();
        assert!(same_existing_library(&current, &current));
        assert!(same_existing_library(&current, &canonical));
        assert!(same_existing_library(&canonical, &current));
        assert!(!same_existing_library(&current, &other));
        assert!(!same_existing_library(
            &current,
            &temporary.path().join("missing")
        ));
    }

    #[test]
    #[cfg(windows)]
    fn same_library_selection_reuses_active_state_for_a_canonical_alias() {
        let temporary = tempfile::tempdir().unwrap();
        let current = temporary.path().join("current");
        let preferences =
            HostPreferenceStore::new(temporary.path().join("config/preferences.json")).unwrap();
        let state = desktop_state(preferences, current.clone());
        let held = crate::ready(&state).unwrap();
        let canonical = Library::validate_selection_target(&current).unwrap();
        assert_ne!(held.library.root(), canonical);
        let before_identity = held.library.identity_record().unwrap();
        let switched = switch_library(&state, Some(current), None).unwrap().status;
        let after = crate::ready(&state).unwrap();
        assert_eq!(switched.generation, 2);
        assert_eq!(switched.selection.unwrap().root, canonical);
        assert_eq!(after.library.identity_record().unwrap(), before_identity);
        assert!(std::sync::Arc::ptr_eq(
            &held.workspace_observer,
            &after.workspace_observer
        ));
        assert!(std::sync::Arc::ptr_eq(&held.github, &after.github));
        assert!(std::sync::Arc::ptr_eq(&held.releases, &after.releases));
        assert_eq!(after.library.root(), held.library.root());
    }

    #[test]
    fn selecting_the_saved_library_keeps_its_generation_and_preference_bytes() {
        let temporary = tempfile::tempdir().unwrap();
        let current = temporary.path().join("current");
        let preferences_path = temporary.path().join("config/preferences.json");
        let preferences = HostPreferenceStore::new(preferences_path.clone()).unwrap();
        let state = desktop_state(preferences, current.clone());

        // The first selection explicitly replaces the invocation override.
        let saved = switch_library(&state, Some(current.clone()), None).unwrap();
        let saved = finish_selection(saved, || panic!("active library was not reopened")).unwrap();
        assert_eq!(saved.generation, 2);
        let selection = saved.selection.unwrap();
        assert_eq!(selection.source, LibrarySelectionSource::Saved);
        let before = fs::read(&preferences_path).unwrap();
        let mut with_whitespace = before;
        with_whitespace.push(b'\n');
        fs::write(&preferences_path, &with_whitespace).unwrap();
        let held = crate::ready(&state).unwrap();

        let alias = current.join(".");
        assert_ne!(alias.as_os_str(), selection.root.as_os_str());
        let reselected = switch_library(&state, Some(alias), None).unwrap();
        let reselected = finish_selection(reselected, || {
            panic!("no-op must not start launch observers")
        })
        .unwrap();
        assert_eq!(reselected.generation, saved.generation);
        assert_eq!(reselected.selection, Some(selection));
        assert_eq!(fs::read(&preferences_path).unwrap(), with_whitespace);
        assert!(std::sync::Arc::ptr_eq(
            &held.workspace_observer,
            &crate::ready(&state).unwrap().workspace_observer
        ));
    }

    #[test]
    fn reviewed_library_contents_changing_after_read_require_a_new_review() {
        let temporary = tempfile::tempdir().unwrap();
        let current = temporary.path().join("current");
        let candidate = temporary.path().join("candidate");
        fs::create_dir(&candidate).unwrap();
        let preferences =
            HostPreferenceStore::new(temporary.path().join("config/preferences.json")).unwrap();
        let state = desktop_state(preferences, current);
        let ready = crate::ready(&state).unwrap();
        let selection = selection_request(Some(candidate.clone())).unwrap();
        let review = selection_review(
            &selection,
            Some((ready.library.root(), ready.selection.source)),
            &Some(None),
            1,
        )
        .unwrap();
        assert_eq!(review.contents, LibrarySelectionContents::EmptyDirectory);
        assert_eq!(review.effect, LibrarySelectionEffect::Open);
        assert_eq!(fs::read_dir(&candidate).unwrap().count(), 0);
        let opened = Library::open(candidate.clone()).unwrap();
        drop(opened);
        let refusal =
            switch_library(&state, Some(candidate), Some(&review.review_sha256)).unwrap_err();
        assert_eq!(refusal.code, ErrorCode::Conflict);
        assert_eq!(bootstrap_status(&state).generation, 1);
        assert_eq!(
            crate::ready(&state).unwrap().library.root(),
            ready.library.root()
        );
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

        assert!(switch_library(&state, Some(next.clone()), None).is_err());
        assert_eq!(crate::ready(&state).unwrap().library.root(), current);
        assert!(!next.join("portcove.sqlite3").exists());
        drop(pending);

        let switched = switch_library(&state, Some(next.clone()), None)
            .unwrap()
            .status;
        assert_eq!(switched.generation, 2);
        assert_eq!(
            switched.selection.unwrap().root,
            fs::canonicalize(next).unwrap()
        );
    }

    #[test]
    fn switch_waits_for_an_outgoing_read_to_finish() {
        let temporary = tempfile::tempdir().unwrap();
        let current = temporary.path().join("current");
        let next = temporary.path().join("next");
        fs::create_dir(&next).unwrap();
        let preferences =
            HostPreferenceStore::new(temporary.path().join("config/preferences.json")).unwrap();
        let state = desktop_state(preferences, current);
        let held = crate::ready(&state).unwrap().library;
        let reader = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            drop(held);
        });

        let switched = switch_library(&state, Some(next.clone()), None)
            .unwrap()
            .status;
        reader.join().unwrap();
        assert_eq!(switched.generation, 2);
        assert_eq!(
            switched.library_root.unwrap(),
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

        assert!(switch_library(&state, Some(unrelated.clone()), None).is_err());
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

        assert!(switch_library(&state, Some(next.clone()), None).is_err());
        assert_eq!(crate::ready(&state).unwrap().library.root(), current);
        assert_eq!(fs::read(preference_path).unwrap(), b"{");
        assert_eq!(fs::read_dir(next).unwrap().count(), 0);
    }

    #[test]
    fn selecting_default_preserves_other_valid_host_preferences() {
        let temporary = tempfile::tempdir().unwrap();
        let preference_path = temporary.path().join("config/preferences.json");
        fs::create_dir_all(preference_path.parent().unwrap()).unwrap();
        let library = temporary.path().join("saved");
        let tool = temporary.path().join("chdman.exe");
        let original = serde_json::json!({
            "format_version": 1,
            "library_root": library,
            "locale": "fr",
            "host_tool_paths": {
                "chdman": { "path": tool, "sha256": "a".repeat(64) }
            },
            "future_setting": { "enabled": true }
        });
        fs::write(&preference_path, serde_json::to_vec(&original).unwrap()).unwrap();
        let preferences = HostPreferenceStore::new(preference_path).unwrap();
        persist_selection(
            &preferences,
            &LibrarySelection {
                root: temporary.path().join("default"),
                source: LibrarySelectionSource::PlatformDefault,
            },
        )
        .unwrap();
        let result = serde_json::to_value(preferences.load().unwrap()).unwrap();
        assert!(result["library_root"].is_null());
        for key in ["locale", "host_tool_paths", "future_setting"] {
            assert_eq!(result[key], original[key]);
        }
    }

    #[test]
    fn selecting_default_recovers_only_invalid_host_preference_documents() {
        let temporary = tempfile::tempdir().unwrap();
        let preference_path = temporary.path().join("config/preferences.json");
        fs::create_dir_all(preference_path.parent().unwrap()).unwrap();
        let preferences = HostPreferenceStore::new(preference_path.clone()).unwrap();
        let damaged = [
            b"{".to_vec(),
            vec![b'x'; 70 * 1024],
            br#"{"format_version":1,"library_root":"relative"}"#.to_vec(),
            br#"{"format_version":99,"library_root":null}"#.to_vec(),
            serde_json::to_vec(&serde_json::json!({
                "format_version": 1,
                "library_root": null,
                "host_tool_paths": {
                    "chdman": { "path": temporary.path().join("chdman.exe"), "sha256": "invalid" }
                }
            }))
            .unwrap(),
        ];
        for bytes in damaged {
            fs::write(&preference_path, bytes).unwrap();
            persist_selection(
                &preferences,
                &LibrarySelection {
                    root: temporary.path().join("default"),
                    source: LibrarySelectionSource::PlatformDefault,
                },
            )
            .unwrap();
            assert_eq!(
                serde_json::to_value(preferences.load().unwrap()).unwrap(),
                serde_json::to_value(portcove_core::HostPreferences::default()).unwrap()
            );
        }
    }
    #[test]
    fn library_switch_cannot_replace_an_inflight_transfer_or_switch() {
        for marker in ["transfer_in_progress", "library_switch_in_progress"] {
            let temporary = tempfile::tempdir().unwrap();
            let target = temporary.path().join("target");
            fs::create_dir(&target).unwrap();
            let preferences =
                HostPreferenceStore::new(temporary.path().join("preferences.json")).unwrap();
            let state = desktop_state(preferences.clone(), temporary.path().join("current"));
            *state.initialization.lock().unwrap() = Err(PortcoveError::conflict("owned handoff")
                .detail(marker, "true")
                .into());
            let before = preferences.load().unwrap();
            let error = switch_library(&state, Some(target.clone()), None).unwrap_err();
            assert_eq!(error.code, portcove_core::ErrorCode::Conflict);
            assert!(
                crate::ready(&state)
                    .err()
                    .unwrap()
                    .details
                    .contains_key(marker)
            );
            assert_eq!(
                serde_json::to_value(preferences.load().unwrap()).unwrap(),
                serde_json::to_value(before).unwrap()
            );
            assert_eq!(fs::read_dir(target).unwrap().count(), 0);
            assert_eq!(crate::state_generation(&state), 1);
        }
    }
}
