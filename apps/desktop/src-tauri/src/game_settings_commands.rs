//! Library-bound adapter; Core owns all settings eligibility and mutation.
use crate::{
    DesktopResult, DesktopState, blocking_worker, require_library_generation,
    service_at_generation, state_generation,
};
use portcove_core::{GameSettingChange, GameSettingReview, GameSettingsView, PortcoveService};

/// Orders settings reads after an in-process settings change instead of letting
/// them meet its exclusive port lock, which refuses a shared reader at once.
/// Order: this lock, then the desktop state lock; readers take it only after
/// releasing the desktop state lock, so the two locks never form a cycle.
static SETTINGS_ACCESS: std::sync::RwLock<()> = std::sync::RwLock::new(());

// The lock guards no data, so a panic in an earlier holder leaves nothing to
// repair; recover the guard instead of refusing every later settings command.
fn settings_read() -> std::sync::RwLockReadGuard<'static, ()> {
    SETTINGS_ACCESS
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn settings_write() -> std::sync::RwLockWriteGuard<'static, ()> {
    SETTINGS_ACCESS
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// A settings change binds like other file-changing commands: it resolves the
/// service at its generation and releases the desktop state lock before Core
/// runs, so a change waiting on Core's port lock (up to the writer yield budget,
/// for example behind a CLI settings read) cannot stall every other command. A
/// library switch still waits for the service's library lease, so the change
/// cannot be redirected; it is not re-checked afterwards because a committed
/// change must not be reported as refused.
pub(crate) fn at_generation<T>(
    state: &DesktopState,
    generation: u64,
    operation: impl FnOnce(PortcoveService) -> portcove_core::Result<T>,
) -> DesktopResult<T> {
    let service = service_at_generation(state, generation)?;
    let _settings = settings_write();
    operation(service).map_err(Into::into)
}

/// Read-only operations bind like every other read: the generation is checked
/// before and after, and a library switch waits for their shared lease. Holding
/// the desktop state lock here serialized every concurrent command behind one
/// slow capability read (hosted traces showed ~10 s per waiter, #4879).
pub(crate) fn read_at_generation<T>(
    state: &DesktopState,
    generation: u64,
    operation: impl FnOnce(PortcoveService) -> portcove_core::Result<T>,
) -> DesktopResult<T> {
    let service = service_at_generation(state, generation)?;
    let _settings = settings_read();
    let value = operation(service)?;
    require_library_generation(state_generation(state), generation)?;
    Ok(value)
}

/// A settings review reads files under Core's exclusive port lock, so it is
/// ordered like a change without holding the desktop state lock.
fn review_at_generation<T>(
    state: &DesktopState,
    generation: u64,
    operation: impl FnOnce(PortcoveService) -> portcove_core::Result<T>,
) -> DesktopResult<T> {
    let service = service_at_generation(state, generation)?;
    let _settings = settings_write();
    let value = operation(service)?;
    require_library_generation(state_generation(state), generation)?;
    Ok(value)
}

#[tauri::command]
pub(crate) async fn get_port_capabilities(
    state: tauri::State<'_, DesktopState>,
    generation: u64,
    port_id: String,
) -> DesktopResult<portcove_core::PortCapabilityReport> {
    let state = state.inner().clone();
    blocking_worker(move || {
        read_at_generation(&state, generation, |service| {
            service.port_capabilities(&port_id)
        })
    })
    .await
}

#[tauri::command]
pub(crate) async fn get_game_settings(
    state: tauri::State<'_, DesktopState>,
    generation: u64,
    port_id: String,
) -> DesktopResult<GameSettingsView> {
    let state = state.inner().clone();
    blocking_worker(move || {
        read_at_generation(&state, generation, |service| {
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
        review_at_generation(&state, generation, |service| {
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
    use crate::DesktopError;
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

    fn ready_state(temporary: &tempfile::TempDir) -> DesktopState {
        DesktopState {
            initialization: Arc::new(Mutex::new(initialize_desktop_selection(LibrarySelection {
                root: temporary.path().join("library"),
                source: LibrarySelectionSource::Invocation,
            }))),
            preferences: HostPreferenceStore::new(temporary.path().join("preferences.json"))
                .map_err(DesktopError::from),
            generation: Arc::new(AtomicU64::new(1)),
            launch_observer: Arc::new(Mutex::new(None)),
        }
    }

    #[test]
    fn a_slow_settings_read_does_not_block_other_commands() {
        use std::sync::mpsc::channel;
        use std::time::Duration;
        let temporary = tempfile::tempdir().unwrap();
        let state = ready_state(&temporary);
        let (entered_tx, entered) = channel();
        let (release, release_rx) = channel::<()>();
        let reader = {
            let state = state.clone();
            std::thread::spawn(move || {
                read_at_generation(&state, 1, |_| {
                    entered_tx.send(()).unwrap();
                    let _ = release_rx.recv_timeout(Duration::from_secs(30));
                    Ok(())
                })
            })
        };
        entered.recv_timeout(Duration::from_secs(30)).unwrap();
        let (done_tx, done) = channel();
        let other = {
            let state = state.clone();
            std::thread::spawn(move || done_tx.send(crate::ready(&state).is_ok()).unwrap())
        };
        let observed = done.recv_timeout(Duration::from_secs(5));
        release.send(()).unwrap();
        assert_eq!(observed, Ok(true), "another command waited for the read");
        other.join().unwrap();
        reader.join().unwrap().unwrap();
    }

    #[test]
    fn a_settings_read_waits_for_an_in_process_settings_change() {
        use std::sync::mpsc::channel;
        use std::time::Duration;
        let temporary = tempfile::tempdir().unwrap();
        let state = ready_state(&temporary);
        let (entered_tx, entered) = channel();
        let (release, release_rx) = channel::<()>();
        let writer = {
            let state = state.clone();
            std::thread::spawn(move || {
                at_generation(&state, 1, |_| {
                    entered_tx.send(()).unwrap();
                    let _ = release_rx.recv_timeout(Duration::from_secs(30));
                    Ok(())
                })
            })
        };
        entered.recv_timeout(Duration::from_secs(30)).unwrap();
        let (done_tx, done) = channel();
        let reader = {
            let state = state.clone();
            std::thread::spawn(move || {
                done_tx
                    .send(read_at_generation(&state, 1, |_| Ok(())).is_ok())
                    .unwrap()
            })
        };
        let early = done.recv_timeout(Duration::from_millis(300));
        release.send(()).unwrap();
        assert!(early.is_err(), "the read overlapped the settings change");
        assert_eq!(done.recv_timeout(Duration::from_secs(30)), Ok(true));
        writer.join().unwrap().unwrap();
        reader.join().unwrap();
    }

    #[test]
    fn a_settings_change_leaves_other_commands_free() {
        use std::sync::mpsc::channel;
        use std::time::Duration;
        let temporary = tempfile::tempdir().unwrap();
        let state = ready_state(&temporary);
        let (entered_tx, entered) = channel();
        let (release, release_rx) = channel::<()>();
        let change = {
            let state = state.clone();
            std::thread::spawn(move || {
                at_generation(&state, 1, |_| {
                    entered_tx.send(()).unwrap();
                    let _ = release_rx.recv_timeout(Duration::from_secs(30));
                    Ok(())
                })
            })
        };
        entered.recv_timeout(Duration::from_secs(30)).unwrap();
        let free = crate::ready(&state).is_ok();
        release.send(()).unwrap();
        assert!(free, "a settings change held the desktop state lock");
        change.join().unwrap().unwrap();
    }

    #[test]
    fn a_settings_read_waits_for_an_in_process_settings_review() {
        use std::sync::mpsc::channel;
        use std::time::Duration;
        let temporary = tempfile::tempdir().unwrap();
        let state = ready_state(&temporary);
        let (entered_tx, entered) = channel();
        let (release, release_rx) = channel::<()>();
        let review = {
            let state = state.clone();
            std::thread::spawn(move || {
                review_at_generation(&state, 1, |_| {
                    entered_tx.send(()).unwrap();
                    let _ = release_rx.recv_timeout(Duration::from_secs(30));
                    Ok(())
                })
            })
        };
        entered.recv_timeout(Duration::from_secs(30)).unwrap();
        // The review leaves the desktop state lock free for other commands.
        assert!(crate::ready(&state).is_ok());
        let (done_tx, done) = channel();
        let reader = {
            let state = state.clone();
            std::thread::spawn(move || {
                done_tx
                    .send(read_at_generation(&state, 1, |_| Ok(())).is_ok())
                    .unwrap()
            })
        };
        let early = done.recv_timeout(Duration::from_millis(300));
        release.send(()).unwrap();
        assert!(early.is_err(), "the read overlapped the settings review");
        assert_eq!(done.recv_timeout(Duration::from_secs(30)), Ok(true));
        review.join().unwrap().unwrap();
        reader.join().unwrap();
    }

    #[test]
    fn a_library_switch_during_a_settings_read_rejects_its_result() {
        let temporary = tempfile::tempdir().unwrap();
        let state = ready_state(&temporary);
        let result = read_at_generation(&state, 1, |_| {
            state
                .generation
                .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
            Ok(())
        });
        assert_eq!(result.unwrap_err().code, ErrorCode::Conflict);
    }
}
