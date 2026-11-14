//! Save protection for installing an application update.
//!
//! Before the updater plugin replaces Portcove, this host proves that no
//! Portcove work can touch the player's library while the installer runs:
//!
//! 1. new backend workers (including game launches) are refused in this process
//!    and none may already be running;
//! 2. the durable idle check passes (no unfinished launch or activity, no
//!    pending migration, no relocation);
//! 3. the desktop swaps its open library for a placeholder and releases its own
//!    shared library lease and shared application runtime lease;
//! 4. Core's exclusive `ApplicationUpdateExclusivityGuard` (no other CLI or
//!    Desktop process) and `ApplicationUpdateQuiescenceGuard` (exclusive library
//!    lease plus the idle check repeated under it) are acquired.
//!
//! All of these are held across `Update::install`. If any step or the install
//! fails, the guards are released, the shared runtime lease is reacquired and
//! the same library is reopened, so Portcove stays usable.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use portcove_core::{
    ApplicationRuntimeGuard, ApplicationUpdateExclusivityGuard, ApplicationUpdateQuiescenceGuard,
    LibrarySelection, PortcoveError,
};

use crate::{
    BlockingWorkerGate, BlockingWorkerRestartGuard, DesktopError, DesktopResult, DesktopState,
};

/// Failure detail naming a known refusal so the renderer can show localized
/// copy. The English message remains the fallback and technical summary.
pub(crate) const REFUSAL_DETAIL: &str = "application_update_refusal";

/// Placeholder detail held in the desktop state while an install owns the library.
pub(crate) const UPDATE_IN_PROGRESS_DETAIL: &str = "application_update_in_progress";

pub(crate) fn refusal(error: PortcoveError, reason: &'static str) -> DesktopError {
    error.detail(REFUSAL_DETAIL, reason).into()
}

/// This process's shared application runtime lease, held for the process
/// lifetime and released only while an update install owns the exclusive lease.
pub(crate) struct RuntimeLease {
    path: PathBuf,
    shared: Mutex<Option<ApplicationRuntimeGuard>>,
}

impl RuntimeLease {
    pub(crate) fn new(path: PathBuf, guard: ApplicationRuntimeGuard) -> Self {
        Self {
            path,
            shared: Mutex::new(Some(guard)),
        }
    }

    fn release_shared(&self) {
        if let Ok(mut shared) = self.shared.lock() {
            shared.take();
        }
    }

    fn reacquire_shared(&self) {
        let Ok(mut shared) = self.shared.lock() else {
            return;
        };
        if shared.is_some() {
            return;
        }
        match ApplicationRuntimeGuard::acquire(&self.path) {
            Ok(guard) => *shared = Some(guard),
            Err(error) => tracing::warn!(
                operation_id = "application-update-install",
                error = %error,
                message = "could not reacquire the shared application runtime lease"
            ),
        }
    }
}

fn library_busy() -> DesktopError {
    refusal(
        PortcoveError::conflict(
            "Portcove is still working on your library, so the update wasn't installed. Wait for installs, backups and running games to finish, then try again.",
        ),
        "library-busy",
    )
}

fn library_in_use() -> DesktopError {
    refusal(
        PortcoveError::conflict(
            "Another Portcove window, the Portcove command line or a running game is using your library, so the update wasn't installed. Close it, then try again.",
        ),
        "library-in-use",
    )
}

/// Maps Core's library refusal to the reason the player can act on.
fn library_refusal(error: &PortcoveError) -> DesktopError {
    tracing::info!(
        operation_id = "application-update-install",
        error = %error.message,
        message = "application update refused to protect the library"
    );
    if error.details.contains_key("library_destination") {
        return refusal(
            PortcoveError::conflict(
                "Your library has moved, so the update wasn't installed. Open the library at its new location, then try again.",
            ),
            "library-relocated",
        );
    }
    if error.details.contains_key("launch_session_id") || error.details.contains_key("activity_id")
    {
        return library_busy();
    }
    if error.details.contains_key("application_update_held") {
        return refusal(
            PortcoveError::conflict(
                "Your library needs to finish an upgrade or recovery first, so the update wasn't installed. Reopen Portcove and let it finish, then try again.",
            ),
            "library-needs-recovery",
        );
    }
    library_in_use()
}

/// Checks before downloading so a busy library doesn't waste a download. It
/// proves nothing durable; [`admit_install`] repeats every check under locks.
pub(crate) fn preflight(state: &DesktopState, generation: u64) -> DesktopResult<()> {
    crate::require_library_generation(crate::state_generation(state), generation)?;
    let initialization = state.initialization.lock().map_err(|_| {
        DesktopError::from(PortcoveError::state(
            "Desktop library state is unavailable.",
        ))
    })?;
    crate::require_no_library_handoff(&initialization).map_err(|_| library_busy())?;
    if let Ok(ready) = initialization.as_ref() {
        ready
            .library
            .require_application_update_idle()
            .map_err(|error| library_refusal(&error))?;
    }
    Ok(())
}

/// The held save protection for one install attempt. Dropping it without
/// [`InstallAdmission::finish_for_exit`] restores the library and leases.
pub(crate) struct InstallAdmission<'a> {
    state: &'a DesktopState,
    runtime: &'a RuntimeLease,
    restore_to: Option<RestoreTo>,
    workers: Option<BlockingWorkerRestartGuard>,
    application: Option<ApplicationUpdateExclusivityGuard>,
    library: Option<ApplicationUpdateQuiescenceGuard>,
    finished: bool,
}

impl InstallAdmission<'_> {
    /// Keeps new work refused and the library closed for the rest of this
    /// process, then releases the exclusive leases so the restarted build can
    /// take its own runtime lease.
    pub(crate) fn finish_for_exit(mut self) {
        if let Some(workers) = self.workers.take() {
            workers.commit();
        }
        self.library.take();
        self.application.take();
        self.finished = true;
    }

    fn restore(&mut self) {
        self.library.take();
        self.application.take();
        self.runtime.reacquire_shared();
        let reopened = match self.restore_to.take() {
            Some(RestoreTo::Reopen(selection)) => crate::initialize_desktop_selection(selection),
            Some(RestoreTo::Unavailable(error)) => Err(error),
            None => return,
        };
        if let Ok(mut initialization) = self.state.initialization.lock() {
            // Only replace this install's own placeholder.
            if is_update_placeholder(&initialization) {
                *initialization = reopened;
            }
        }
        // Dropping the uncommitted guard admits workers again.
        self.workers.take();
    }
}

impl Drop for InstallAdmission<'_> {
    fn drop(&mut self) {
        if !self.finished {
            self.restore();
        }
    }
}

/// What the desktop state held before the install took the library.
enum RestoreTo {
    Reopen(LibrarySelection),
    Unavailable(DesktopError),
}

fn is_update_placeholder(initialization: &DesktopResult<crate::ReadyDesktopState>) -> bool {
    initialization
        .as_ref()
        .err()
        .is_some_and(|error| error.details.contains_key(UPDATE_IN_PROGRESS_DETAIL))
}

/// Acquires every save-protection guard, or restores the desktop and refuses.
pub(crate) fn admit_install<'a>(
    state: &'a DesktopState,
    runtime: &'a RuntimeLease,
    workers_gate: &'static BlockingWorkerGate,
    generation: u64,
) -> DesktopResult<InstallAdmission<'a>> {
    let mut initialization = state.initialization.lock().map_err(|_| {
        DesktopError::from(PortcoveError::state(
            "Desktop library state is unavailable.",
        ))
    })?;
    let workers = crate::block_workers_for_restart_in(workers_gate).map_err(|_| library_busy())?;
    crate::require_library_generation(crate::state_generation(state), generation)?;
    crate::require_no_library_handoff(&initialization).map_err(|_| library_busy())?;
    if let Ok(ready) = initialization.as_ref() {
        ready
            .library
            .require_application_update_idle()
            .map_err(|error| library_refusal(&error))?;
    }
    let previous = std::mem::replace(
        &mut *initialization,
        Err(
            PortcoveError::conflict("Portcove is installing an application update")
                .detail(UPDATE_IN_PROGRESS_DETAIL, "true")
                .into(),
        ),
    );
    drop(initialization);
    // A library that failed to open holds no lease to protect; an update may be
    // what repairs it. Other Portcove processes are still excluded below.
    let (restore_to, root) = match previous {
        Ok(ready) => {
            let root = ready.library.root().to_path_buf();
            let selection = ready.selection.clone();
            // Dropping the ready state releases this process's library lease.
            drop(ready);
            (RestoreTo::Reopen(selection), Some(root))
        }
        Err(error) => (RestoreTo::Unavailable(error), None),
    };
    let mut admission = InstallAdmission {
        state,
        runtime,
        restore_to: Some(restore_to),
        workers: Some(workers),
        application: None,
        library: None,
        finished: false,
    };

    if let Some(root) = root.as_deref() {
        crate::library_selection::wait_for_outgoing_library(root)
            .map_err(|error| library_refusal(&error))?;
    }
    runtime.release_shared();
    admission.application = Some(
        ApplicationUpdateExclusivityGuard::acquire(&runtime.path).map_err(|_| library_in_use())?,
    );
    if let Some(root) = root.as_deref() {
        admission.library = Some(acquire_library(root)?);
    }
    Ok(admission)
}

fn acquire_library(root: &Path) -> DesktopResult<ApplicationUpdateQuiescenceGuard> {
    ApplicationUpdateQuiescenceGuard::acquire(root).map_err(|error| library_refusal(&error))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{BlockingWorkerState, initialize_desktop_at};
    use portcove_core::HostPreferenceStore;
    use std::sync::Arc;
    use std::sync::atomic::AtomicU64;

    struct Fixture {
        _temporary: tempfile::TempDir,
        state: DesktopState,
        runtime: RuntimeLease,
        runtime_path: PathBuf,
        gate: &'static BlockingWorkerGate,
        root: PathBuf,
    }

    fn fixture() -> Fixture {
        let temporary = tempfile::tempdir().unwrap();
        let ready = initialize_desktop_at(Some(temporary.path().join("library"))).unwrap();
        let root = ready.library.root().to_path_buf();
        let runtime_path = temporary.path().join(".application-runtime.lock");
        let runtime = RuntimeLease::new(
            runtime_path.clone(),
            ApplicationRuntimeGuard::acquire(&runtime_path).unwrap(),
        );
        let state = DesktopState {
            initialization: Arc::new(Mutex::new(Ok(ready))),
            preferences: HostPreferenceStore::new(temporary.path().join("preferences.json"))
                .map_err(DesktopError::from),
            generation: Arc::new(AtomicU64::new(3)),
            launch_observer: Arc::new(Mutex::new(None)),
        };
        Fixture {
            _temporary: temporary,
            state,
            runtime,
            runtime_path,
            gate: Box::leak(Box::new(Mutex::new(BlockingWorkerState::default()))),
            root,
        }
    }

    fn reason(error: &DesktopError) -> Option<&str> {
        error.details.get(REFUSAL_DETAIL).map(String::as_str)
    }

    /// The desktop is usable again: its library is open, workers run, and this
    /// process again shares the runtime lease, so no exclusive holder remains.
    fn assert_restored(fixture: &Fixture) {
        let initialization = fixture.state.initialization.lock().unwrap();
        let ready = initialization.as_ref().expect("library reopened");
        assert_eq!(ready.library.root(), fixture.root);
        drop(initialization);
        assert!(fixture.gate.lock().unwrap().begin_restart().is_ok());
        fixture.gate.lock().unwrap().restart_pending = false;
        assert!(ApplicationUpdateExclusivityGuard::acquire(&fixture.runtime_path).is_err());
        assert!(ApplicationRuntimeGuard::acquire(&fixture.runtime_path).is_ok());
    }

    #[test]
    fn admission_holds_exclusive_library_and_runtime_leases_through_install() {
        let fixture = fixture();
        let admission = admit_install(&fixture.state, &fixture.runtime, fixture.gate, 3).unwrap();
        // The desktop's own library is closed and no new work can start.
        assert!(is_update_placeholder(
            &fixture.state.initialization.lock().unwrap()
        ));
        assert!(fixture.gate.lock().unwrap().begin_worker().is_err());
        // Nothing else can open the library or start another Portcove process.
        assert!(portcove_core::Library::open(&fixture.root).is_err());
        assert!(ApplicationRuntimeGuard::acquire(&fixture.runtime_path).is_err());
        admission.finish_for_exit();
        // After a successful install the library stays closed and work stays
        // refused, but the restarted build can take its runtime lease.
        assert!(is_update_placeholder(
            &fixture.state.initialization.lock().unwrap()
        ));
        assert!(fixture.gate.lock().unwrap().begin_worker().is_err());
        assert!(ApplicationRuntimeGuard::acquire(&fixture.runtime_path).is_ok());
    }

    #[test]
    fn admission_refuses_while_another_holder_has_the_library_lease() {
        let fixture = fixture();
        let other = portcove_core::Library::open(&fixture.root).unwrap();
        let error = admit_install(&fixture.state, &fixture.runtime, fixture.gate, 3)
            .err()
            .expect("another library holder must refuse the install");
        assert_eq!(reason(&error), Some("library-in-use"));
        drop(other);
        assert_restored(&fixture);
    }

    #[test]
    fn admission_refuses_while_another_portcove_process_holds_the_runtime_lease() {
        let fixture = fixture();
        let other = ApplicationRuntimeGuard::acquire(&fixture.runtime_path).unwrap();
        let error = admit_install(&fixture.state, &fixture.runtime, fixture.gate, 3)
            .err()
            .expect("another Portcove process must refuse the install");
        assert_eq!(reason(&error), Some("library-in-use"));
        drop(other);
        assert_restored(&fixture);
    }

    #[test]
    fn admission_refuses_while_a_worker_or_launch_request_is_active() {
        let fixture = fixture();
        let worker = crate::ActiveBlockingWorker::begin_in(fixture.gate).unwrap();
        let error = admit_install(&fixture.state, &fixture.runtime, fixture.gate, 3)
            .err()
            .expect("an active worker must refuse the install");
        assert_eq!(reason(&error), Some("library-busy"));
        // The refusal happened before the library was released.
        assert!(fixture.state.initialization.lock().unwrap().is_ok());
        drop(worker);
        assert_restored(&fixture);
    }

    #[test]
    fn admission_refuses_while_a_game_launch_is_unfinished() {
        let fixture = fixture();
        let database = rusqlite::Connection::open(fixture.root.join("portcove.sqlite3")).unwrap();
        database
            .execute(
                "INSERT INTO launch_sessions(id, port_id, install_id, install_root, \
                 supervisor_pid, phase, started_at, updated_at) \
                 VALUES ('session', 'sample', 'install', 'install', ?1, 'running', 1, 1)",
                [std::process::id()],
            )
            .unwrap();
        for result in [
            preflight(&fixture.state, 3).err(),
            admit_install(&fixture.state, &fixture.runtime, fixture.gate, 3).err(),
        ] {
            let error = result.expect("an unfinished launch must refuse the install");
            assert_eq!(reason(&error), Some("library-busy"));
        }
        // Neither refusal released the library, so nothing was reopened.
        database
            .execute("DELETE FROM launch_sessions WHERE id = 'session'", [])
            .unwrap();
        assert_restored(&fixture);
    }

    #[test]
    fn install_failure_reopens_the_library_and_releases_every_guard() {
        let fixture = fixture();
        let admission = admit_install(&fixture.state, &fixture.runtime, fixture.gate, 3).unwrap();
        // Simulates Update::install returning an error: the admission is dropped.
        drop(admission);
        assert_restored(&fixture);
        // The reopened library serves ordinary work at the same generation.
        assert!(crate::library_at_generation(&fixture.state, 3).is_ok());
    }

    #[test]
    fn stale_generation_refuses_without_touching_the_library() {
        let fixture = fixture();
        assert!(admit_install(&fixture.state, &fixture.runtime, fixture.gate, 2).is_err());
        assert_restored(&fixture);
    }
}
