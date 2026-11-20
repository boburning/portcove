//! Selecting and reopening the active library is a Desktop concern.
//! Core owns every copy, verification and restore decision.
use crate::{
    DesktopError, DesktopResult, DesktopState, blocking_worker,
    library_transfer::transfer_preserving_current_library, require_library_generation,
    require_no_library_handoff, service_at_generation, state_generation,
};
use portcove_core::{
    LibraryImportResult, LibraryRecoveryBundle, LibraryRecoveryBundlePlan,
    LibraryRecoveryRestorePlan, PortcoveError, PortcoveService,
};
use std::path::{Path, PathBuf};

#[tauri::command]
pub(crate) async fn plan_library_recovery_bundle(
    state: tauri::State<'_, DesktopState>,
    generation: u64,
    destination: PathBuf,
) -> DesktopResult<LibraryRecoveryBundlePlan> {
    let state = state.inner().clone();
    blocking_worker(move || {
        let service = service_at_generation(&state, generation)?;
        let plan = service.plan_library_recovery_bundle(&destination)?;
        require_library_generation(state_generation(&state), generation)?;
        Ok(plan)
    })
    .await
}

#[tauri::command]
pub(crate) async fn create_library_recovery_bundle(
    state: tauri::State<'_, DesktopState>,
    generation: u64,
    destination: PathBuf,
    expected_plan: String,
) -> DesktopResult<LibraryRecoveryBundle> {
    let state = state.inner().clone();
    blocking_worker(move || {
        transfer_preserving_current_library(&state, generation, |source| {
            PortcoveService::create_library_recovery_bundle(source, &destination, &expected_plan)
        })
    })
    .await
}

#[tauri::command]
pub(crate) async fn resume_library_recovery_bundle(
    state: tauri::State<'_, DesktopState>,
    generation: u64,
    staging: PathBuf,
) -> DesktopResult<LibraryRecoveryBundle> {
    let state = state.inner().clone();
    blocking_worker(move || {
        transfer_preserving_current_library(&state, generation, |_| {
            PortcoveService::resume_library_recovery_bundle(&staging)
        })
    })
    .await
}

#[tauri::command]
pub(crate) async fn inspect_library_recovery_bundle(
    path: PathBuf,
) -> DesktopResult<LibraryRecoveryBundle> {
    blocking_worker(move || {
        PortcoveService::inspect_library_recovery_bundle(&path).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub(crate) async fn plan_library_recovery_restore(
    state: tauri::State<'_, DesktopState>,
    generation: u64,
    path: PathBuf,
    destination: PathBuf,
) -> DesktopResult<LibraryRecoveryRestorePlan> {
    let state = state.inner().clone();
    blocking_worker(move || {
        let service = service_at_generation(&state, generation)?;
        let plan = reviewed_destination(service.library().root(), &path, &destination)?;
        require_library_generation(state_generation(&state), generation)?;
        Ok(plan)
    })
    .await
}

#[tauri::command]
pub(crate) async fn restore_library_recovery_bundle(
    state: tauri::State<'_, DesktopState>,
    generation: u64,
    path: PathBuf,
    destination: PathBuf,
    expected_plan: String,
) -> DesktopResult<LibraryImportResult> {
    let state = state.inner().clone();
    blocking_worker(move || {
        transfer_preserving_current_library(&state, generation, |active| {
            let plan = reviewed_destination(active, &path, &destination)?;
            if plan.plan_sha256 != expected_plan {
                return Err(PortcoveError::conflict(
                    "recovery bundle or restore destination changed; review recovery again",
                ));
            }
            PortcoveService::restore_library_recovery_bundle(
                &plan.bundle.path,
                &plan.destination_root,
                &expected_plan,
            )
        })
    })
    .await
}

#[tauri::command]
pub(crate) async fn resume_library_recovery_restore(
    state: tauri::State<'_, DesktopState>,
    generation: u64,
    destination: PathBuf,
) -> DesktopResult<LibraryImportResult> {
    let state = state.inner().clone();
    blocking_worker(move || {
        if let Some(result) =
            resume_bundle_restore_blocking_startup(&state, generation, &destination)?
        {
            return Ok(result);
        }
        transfer_preserving_current_library(&state, generation, |active| {
            let destination = std::fs::canonicalize(&destination)?;
            require_separate_destination(active, &destination)?;
            PortcoveService::resume_library_recovery_restore(&destination)
        })
    })
    .await
}

/// A previously selected library may be gated by an interrupted restore. Release
/// that gate without opening the restored library or replacing the saved choice.
fn resume_bundle_restore_blocking_startup(
    state: &DesktopState,
    generation: u64,
    destination: &Path,
) -> DesktopResult<Option<LibraryImportResult>> {
    let lock_error = || DesktopError::from(PortcoveError::state("desktop state lock was poisoned"));
    let pending = {
        let mut startup = state.initialization.lock().map_err(|_| lock_error())?;
        require_no_library_handoff(&startup)?;
        require_library_generation(state_generation(state), generation)?;
        let Err(failure) = startup.as_ref() else {
            return Ok(None);
        };
        let is_reviewed_destination = failure
            .details
            .get("import_destination")
            .is_some_and(|path| Path::new(path) == destination);
        if !is_reviewed_destination
            || failure.details.get("recovery_action").map(String::as_str)
                != Some("resume_library_recovery_restore")
        {
            return Err(failure.clone());
        }
        let failure = failure.clone();
        *startup = Err(PortcoveError::conflict("library transfer is in progress")
            .detail("transfer_in_progress", "true")
            .into());
        failure
    };

    let result = PortcoveService::resume_library_recovery_restore(destination);
    // A later explicit open retries normal startup. Until then the blocked
    // startup view owns the result rather than treating it as an open library.
    *state.initialization.lock().map_err(|_| lock_error())? = Err(pending);
    result.map(Some).map_err(Into::into)
}

fn reviewed_destination(
    active: &Path,
    path: &Path,
    destination: &Path,
) -> portcove_core::Result<LibraryRecoveryRestorePlan> {
    let plan = PortcoveService::plan_library_recovery_restore(path, destination)?;
    require_separate_destination(active, &plan.destination_root)?;
    Ok(plan)
}

fn require_separate_destination(active: &Path, destination: &Path) -> portcove_core::Result<()> {
    let active = std::fs::canonicalize(active)?;
    if destination.starts_with(&active) || active.starts_with(destination) {
        return Err(PortcoveError::usage(
            "choose a restore destination outside the open library",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex, atomic::AtomicU64};

    #[test]
    fn startup_resume_only_admits_the_selected_interrupted_bundle() {
        let temporary = tempfile::tempdir().unwrap();
        let destination = temporary.path().join("restore");
        std::fs::create_dir(&destination).unwrap();
        let failure = PortcoveError::conflict("bundle restore needs recovery")
            .detail("import_destination", destination.display().to_string())
            .detail("recovery_action", "resume_library_recovery_restore");
        let state = DesktopState {
            initialization: Arc::new(Mutex::new(Err(failure.clone().into()))),
            preferences: Ok(portcove_core::HostPreferenceStore::new(
                temporary.path().join("preferences.json"),
            )
            .unwrap()),
            generation: Arc::new(AtomicU64::new(2)),
            launch_observer: Arc::new(Mutex::new(None)),
        };
        let sibling = temporary.path().join("another-library");
        let wrong = resume_bundle_restore_blocking_startup(&state, 2, &sibling).unwrap_err();
        assert_eq!(wrong.message, failure.message);
        assert!(!sibling.exists());
        assert!(resume_bundle_restore_blocking_startup(&state, 1, &destination).is_err());
        let actual = resume_bundle_restore_blocking_startup(&state, 2, &destination).unwrap_err();
        assert!(actual.message.contains("no library import journal"));
        let startup = crate::bootstrap_status(&state);
        assert!(!startup.ready);
        assert_eq!(startup.generation, 2);
        assert_eq!(startup.error.unwrap().message, failure.message);
    }
}
