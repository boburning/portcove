//! Explicit application restart dispatch for an already verified update.
//!
//! The renderer supplies only the current library generation. Rust binds the
//! durable request to host-owned preferences, staging, installed identity and
//! library state, then starts a helper carrying only the journal revision.

use std::ffi::OsStr;
#[cfg(any(windows, test))]
use std::process::Stdio;

#[cfg(windows)]
use portcove_core::HostPreferenceStore;
use portcove_core::PortcoveError;
#[cfg(any(windows, test))]
use portcove_core::{ChildProcessClass, ChildProcessPolicy};

#[cfg(windows)]
use crate::DesktopError;
#[cfg(windows)]
use crate::application_update_apply::{
    ApplicationTerminationKind, ApplicationUpdateApplyError, ApplicationUpdateApplyStore,
};
#[cfg(windows)]
use crate::application_update_helper::{
    ApplicationUpdateHelperRequest, BoundedApplicationUpdateRuntimeWaiter,
    revalidate_application_update_after_parent_exit,
};
#[cfg(windows)]
use crate::application_update_host::{
    ApplicationUpdateHostProvider, CurrentInstalledApplicationContext,
    InstalledApplicationContextSource,
};
#[cfg(windows)]
use crate::application_update_preferences::ApplicationUpdatePreferenceStore;
#[cfg(windows)]
use crate::application_update_staging::ApplicationUpdateStagingStore;
#[cfg(any(windows, test))]
use crate::application_update_windows::WindowsApplicationUpdateError;
#[cfg(windows)]
use crate::application_update_windows::WindowsNsisUpdateAdmission;
#[cfg(any(windows, test))]
use crate::configure_independent_process;
use crate::{DesktopResult, DesktopState};

const HELPER_MODE: &str = "--portcove-apply-update";

#[tauri::command]
pub(crate) async fn restart_to_apply_application_update(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
    update_state: tauri::State<
        '_,
        crate::application_update_commands::ApplicationUpdateCommandState,
    >,
    generation: u64,
) -> DesktopResult<()> {
    #[cfg(not(windows))]
    {
        let _ = (app, state, update_state, generation);
        Err(PortcoveError::unsupported(
            "Restart to update is not available for this platform build.",
        )
        .into())
    }

    #[cfg(windows)]
    {
        crate::require_library_generation(crate::state_generation(&state), generation)?;
        if ApplicationUpdateHostProvider::compiled()
            .map_err(|_| configuration_error())?
            .is_none()
        {
            return Err(PortcoveError::unsupported(
                "Application updating is not configured in this build.",
            )
            .into());
        }
        let staging = ApplicationUpdateStagingStore::open_configured().map_err(staging_error)?;
        let staged = staging
            .reconcile()
            .await
            .map_err(staging_error)?
            .ok_or_else(|| {
                DesktopError::from(PortcoveError::state(
                    "No verified application update is staged.",
                ))
            })?;
        let preferences = ApplicationUpdatePreferenceStore::open_configured()
            .map_err(preference_error)?
            .load()
            .map_err(preference_error)?;
        let installed = CurrentInstalledApplicationContext
            .observe()
            .map_err(|_| unsupported_installation())?;

        // Keep the selected library stable from the generation check through
        // durable dispatch and process exit. Library switches use this same
        // mutex, so another selection cannot slip into the restart boundary.
        let initialization = state.initialization.lock().map_err(|_| {
            DesktopError::from(PortcoveError::state(
                "Desktop library state is unavailable.",
            ))
        })?;
        let worker_restart = crate::block_workers_for_restart()?;
        let check_restart = update_state.block_for_restart()?;
        crate::require_library_generation(crate::state_generation(&state), generation)?;
        let ready = initialization.as_ref().map_err(Clone::clone)?;
        ready
            .library
            .require_application_update_idle()
            .map_err(|_| library_busy_error())?;
        let library_root = ready.library.root().to_path_buf();

        let apply = ApplicationUpdateApplyStore::open_configured().map_err(apply_error)?;
        let prepared = apply
            .prepare_explicit_restart(&preferences, &staged, &installed, &library_root)
            .map_err(apply_error)?;
        let terminated = apply
            .record_termination(
                prepared.revision,
                ApplicationTerminationKind::RestartToApply,
            )
            .map_err(apply_error)?;
        spawn_update_helper(terminated.revision)?;
        check_restart.commit();
        worker_restart.commit();
        app.exit(0);
        Ok(())
    }
}

pub(crate) fn helper_revision(value: &OsStr) -> Option<u64> {
    let value = value.to_str()?;
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    value.parse::<u64>().ok().filter(|revision| *revision != 0)
}

pub(crate) fn is_helper_mode(value: &OsStr) -> bool {
    value == HELPER_MODE
}

#[cfg(windows)]
fn spawn_update_helper(expected_revision: u64) -> DesktopResult<()> {
    let executable = std::env::current_exe().map_err(PortcoveError::from)?;
    let mut command = update_helper_command(&executable, expected_revision)?;
    command.spawn().map_err(|_| {
        DesktopError::from(PortcoveError::launch(
            "Could not start the application update helper. Portcove stayed open and kept the verified update for retry.",
        ))
    })?;
    Ok(())
}

#[cfg(any(windows, test))]
fn update_helper_command(
    executable: &std::path::Path,
    expected_revision: u64,
) -> DesktopResult<std::process::Command> {
    let mut command =
        ChildProcessPolicy::native_command(ChildProcessClass::HostIntegration, executable)?;
    command
        .arg(HELPER_MODE)
        .arg(expected_revision.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    configure_independent_process(&mut command);
    Ok(command)
}

#[cfg(windows)]
pub(crate) fn run_update_helper(expected_revision: u64) -> i32 {
    let outcome = run_update_helper_inner(expected_revision);
    let restart_result = if outcome != UpdateHelperOutcome::Ambiguous {
        restart_desktop_if_runtime_available()
    } else {
        Err(())
    };
    if outcome == UpdateHelperOutcome::Succeeded && restart_result.is_ok() {
        0
    } else {
        1
    }
}

#[cfg(not(windows))]
pub(crate) fn run_update_helper(_expected_revision: u64) -> i32 {
    1
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg(any(windows, test))]
enum UpdateHelperOutcome {
    Succeeded,
    FailedSafe,
    Ambiguous,
}

#[cfg(windows)]
fn run_update_helper_inner(expected_revision: u64) -> UpdateHelperOutcome {
    let admission = match prepare_update_admission(expected_revision) {
        Ok(admission) => admission,
        Err(()) => return UpdateHelperOutcome::FailedSafe,
    };
    classify_launch_result(admission.launch())
}

#[cfg(windows)]
fn prepare_update_admission(expected_revision: u64) -> Result<WindowsNsisUpdateAdmission, ()> {
    let request = ApplicationUpdateHelperRequest::new(expected_revision).map_err(|_| ())?;
    let provider = ApplicationUpdateHostProvider::compiled()
        .map_err(|_| ())?
        .ok_or(())?;
    let apply = ApplicationUpdateApplyStore::open_configured().map_err(|_| ())?;
    let preferences = ApplicationUpdatePreferenceStore::open_configured().map_err(|_| ())?;
    let staging = ApplicationUpdateStagingStore::open_configured().map_err(|_| ())?;
    let runtime_lock = HostPreferenceStore::application_runtime_lock_path().map_err(|_| ())?;
    let lease = tauri::async_runtime::block_on(revalidate_application_update_after_parent_exit(
        request,
        &BoundedApplicationUpdateRuntimeWaiter::default(),
        &provider,
        &apply,
        &preferences,
        &staging,
        &runtime_lock,
    ))
    .map_err(|_| ())?;
    crate::application_update_windows::admit_windows_nsis_update(lease).map_err(|_| ())
}

#[cfg(any(windows, test))]
fn classify_launch_result(
    result: Result<(), WindowsApplicationUpdateError>,
) -> UpdateHelperOutcome {
    match result {
        Ok(()) => UpdateHelperOutcome::Succeeded,
        Err(WindowsApplicationUpdateError::Wait(_)) => UpdateHelperOutcome::Ambiguous,
        Err(_) => UpdateHelperOutcome::FailedSafe,
    }
}

#[cfg(windows)]
fn restart_desktop_if_runtime_available() -> Result<(), ()> {
    let runtime_lock = HostPreferenceStore::application_runtime_lock_path().map_err(|_| ())?;
    let runtime =
        portcove_core::ApplicationUpdateExclusivityGuard::acquire(&runtime_lock).map_err(|_| ())?;
    let executable = std::env::current_exe().map_err(|_| ())?;
    let mut command =
        ChildProcessPolicy::native_command(ChildProcessClass::HostIntegration, &executable)
            .map_err(|_| ())?;
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    configure_independent_process(&mut command);
    drop(runtime);
    command.spawn().map(|_| ()).map_err(|_| ())
}

#[cfg(windows)]
fn unsupported_installation() -> DesktopError {
    PortcoveError::unsupported(
        "This Portcove installation cannot be updated in place. Use the documented manual recovery path.",
    )
    .into()
}

#[cfg(windows)]
fn library_busy_error() -> DesktopError {
    PortcoveError::conflict(
        "Portcove is using the current library. Finish or recover active work before restarting to update.",
    )
    .into()
}

#[cfg(windows)]
fn configuration_error() -> DesktopError {
    PortcoveError::state(
        "Application update configuration is unavailable. Reinstall Portcove or use the documented manual recovery path.",
    )
    .into()
}

#[cfg(windows)]
fn preference_error(
    error: crate::application_update_preferences::ApplicationUpdatePreferenceError,
) -> DesktopError {
    let conflict = matches!(
        error,
        crate::application_update_preferences::ApplicationUpdatePreferenceError::Busy
            | crate::application_update_preferences::ApplicationUpdatePreferenceError::RevisionConflict { .. }
    );
    if conflict {
        PortcoveError::conflict(
            "Application update settings changed or are busy. Refresh and try again.",
        )
        .into()
    } else {
        PortcoveError::state(
            "Application update settings are unavailable. Repair them and try again.",
        )
        .into()
    }
}

#[cfg(windows)]
fn staging_error(
    error: crate::application_update_staging::ApplicationUpdateStagingError,
) -> DesktopError {
    if matches!(
        error,
        crate::application_update_staging::ApplicationUpdateStagingError::Busy
    ) {
        PortcoveError::conflict(
            "Application update staging is busy. Refresh the update status and try again.",
        )
        .into()
    } else {
        PortcoveError::state(
            "The verified application update is unavailable. Repair its staged state and try again.",
        )
        .into()
    }
}

#[cfg(windows)]
fn apply_error(error: ApplicationUpdateApplyError) -> DesktopError {
    if matches!(
        error,
        ApplicationUpdateApplyError::Busy
            | ApplicationUpdateApplyError::RevisionConflict { .. }
            | ApplicationUpdateApplyError::IntentConflict
    ) {
        PortcoveError::conflict(
            "The application update request changed or is busy. Refresh and try again.",
        )
        .into()
    } else {
        PortcoveError::state(
            "The application update could not be prepared safely. Refresh its status and try again.",
        )
        .into()
    }
}

#[cfg(test)]
mod tests {
    use std::ffi::OsStr;

    use super::*;

    #[test]
    fn helper_revision_accepts_only_one_nonzero_decimal_revision() {
        assert_eq!(helper_revision(OsStr::new("42")), Some(42));
        for invalid in ["0", "-1", "+1", " 1", "1 ", "1.0", "request.json"] {
            assert_eq!(helper_revision(OsStr::new(invalid)), None);
        }
    }

    #[test]
    fn helper_mode_is_exact() {
        assert!(is_helper_mode(OsStr::new("--portcove-apply-update")));
        assert!(!is_helper_mode(OsStr::new("--portcove-apply")));
    }

    #[test]
    fn helper_process_receives_only_the_fixed_mode_and_revision() {
        let executable = std::env::current_exe().unwrap();
        let command = update_helper_command(&executable, 42).unwrap();
        let arguments: Vec<_> = command.get_args().collect();
        assert_eq!(
            arguments,
            [OsStr::new("--portcove-apply-update"), OsStr::new("42")]
        );
    }

    #[test]
    fn desktop_restarts_only_after_a_known_complete_native_outcome() {
        assert_eq!(
            classify_launch_result(Ok(())),
            UpdateHelperOutcome::Succeeded
        );
        assert_eq!(
            classify_launch_result(Err(WindowsApplicationUpdateError::Launch(
                "fixture launch failure".into(),
            ))),
            UpdateHelperOutcome::FailedSafe
        );
        assert_eq!(
            classify_launch_result(Err(WindowsApplicationUpdateError::Wait(
                "fixture wait failure".into(),
            ))),
            UpdateHelperOutcome::Ambiguous
        );
    }
}
