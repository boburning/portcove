//! Early Desktop constructors, independent of Tauri and the selected library.
//! The executable owns logging; these helpers only observe actual Core results.

use std::path::{Path, PathBuf};

use portcove_core::{
    ApplicationRuntimeGuard, ErrorCode, HostPreferenceStore, Library, LibrarySelection, Result,
};

#[derive(Clone, Copy)]
pub(crate) enum EarlyPhase {
    Preferences,
    RuntimeLease,
    Library,
}

pub(crate) fn preference_store() -> Result<HostPreferenceStore> {
    observe("preferences", HostPreferenceStore::open_configured())
}

pub(crate) fn runtime_guard() -> Result<ApplicationRuntimeGuard> {
    observe(
        "runtime_lease",
        HostPreferenceStore::application_runtime_lock_path()
            .and_then(|path| ApplicationRuntimeGuard::acquire(&path)),
    )
}

pub(crate) fn select_library(
    preferences: &HostPreferenceStore,
    configured: Option<PathBuf>,
) -> Result<LibrarySelection> {
    observe(
        "library_selection",
        Library::default_root()
            .and_then(|default| preferences.resolve(configured.as_deref(), &default)),
    )
}

pub(crate) fn open_library(selection: &LibrarySelection) -> Result<Library> {
    open_library_at(&selection.root)
}

pub(crate) fn open_library_at(root: &Path) -> Result<Library> {
    observe("library_open", Library::open(root))
}

fn observe<T>(phase: &'static str, result: Result<T>) -> Result<T> {
    tracing::info!(
        target: "portcove_desktop::host_diagnostics",
        component = "startup",
        operation_id = "desktop-startup",
        phase,
        success = result.is_ok(),
        code = result.as_ref().err().map(|error| portcove_diagnostics::code_label(error.code)).unwrap_or("None"),
        message = "Desktop stage completed"
    );
    result
}

pub(crate) fn failure_message(phase: EarlyPhase, code: ErrorCode) -> String {
    // Preserve the existing early stderr copy, including the closed error code.
    // Neither a Core error's message/details nor a private path is formatted.
    let message = match phase {
        EarlyPhase::Preferences => {
            "Portcove could not open host preferences. Check the preference file setting, then try again."
        }
        EarlyPhase::RuntimeLease if code == ErrorCode::Conflict => {
            "Portcove cannot start while an application update is replacing it. Let the update finish, then try again."
        }
        EarlyPhase::RuntimeLease => {
            "Portcove could not open its runtime lease. Check access to the application state location, then try again."
        }
        EarlyPhase::Library => {
            "Portcove could not open its library. Check the selected library, then try again."
        }
    };
    format!("{message} [{code:?}]")
}
