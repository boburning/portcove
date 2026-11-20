//! Selecting and reopening the active library is a Desktop concern.
//! Core owns every copy, verification and restore decision.
use crate::{
    DesktopResult, DesktopState, blocking_worker,
    library_transfer::transfer_preserving_current_library, require_library_generation,
    service_at_generation, state_generation,
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
        transfer_preserving_current_library(&state, generation, |active| {
            let destination = std::fs::canonicalize(&destination)?;
            require_separate_destination(active, &destination)?;
            PortcoveService::resume_library_recovery_restore(&destination)
        })
    })
    .await
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
