//! Native handle handoff; copy, verification, and authority remain in core.
use crate::{
    DesktopError, DesktopResult, DesktopState, blocking_service, blocking_worker,
    initialize_desktop_at,
};
use portcove_core::{PortcoveError, PortcoveService};
use std::path::{Path, PathBuf};

#[tauri::command]
pub(crate) async fn plan_library_move(
    state: tauri::State<'_, DesktopState>,
    destination: PathBuf,
) -> DesktopResult<portcove_core::LibraryMovePlan> {
    blocking_service(state.inner().clone(), move |service| {
        service.plan_library_move(&destination).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub(crate) async fn move_library(
    state: tauri::State<'_, DesktopState>,
    destination: PathBuf,
    expected_plan: String,
) -> DesktopResult<portcove_core::LibraryMoveResult> {
    let state = state.inner().clone();
    blocking_worker(move || {
        transfer_desktop_library(&state, None, |source| {
            PortcoveService::move_library(source, &destination, &expected_plan)
        })
    })
    .await
}

#[tauri::command]
pub(crate) async fn recover_library_move(
    state: tauri::State<'_, DesktopState>,
    source: PathBuf,
    abort: bool,
) -> DesktopResult<portcove_core::LibraryMoveResult> {
    let state = state.inner().clone();
    blocking_worker(move || {
        transfer_desktop_library(&state, Some(source), |source| {
            if abort {
                PortcoveService::abort_library_move(source)
            } else {
                PortcoveService::resume_library_move(source)
            }
        })
    })
    .await
}

fn transfer_desktop_library<F>(
    state: &DesktopState,
    recovery_root: Option<PathBuf>,
    operation: F,
) -> DesktopResult<portcove_core::LibraryMoveResult>
where
    F: FnOnce(&Path) -> portcove_core::Result<portcove_core::LibraryMoveResult>,
{
    let root = {
        let mut initialization = state.initialization.lock().map_err(|_| {
            DesktopError::from(PortcoveError::state("desktop state lock was poisoned"))
        })?;
        if initialization
            .as_ref()
            .err()
            .is_some_and(|error| error.details.contains_key("transfer_in_progress"))
        {
            return Err(
                PortcoveError::conflict("a library transfer is already in progress").into(),
            );
        }
        let root = if let Some(root) = recovery_root {
            root
        } else {
            initialization
                .as_ref()
                .map_err(Clone::clone)?
                .library
                .root()
                .to_path_buf()
        };
        // Release the adapter's providers and library lease. Previously dispatched work
        // keeps its own leases, causing core's exclusive operation to fail safely.
        *initialization = Err(PortcoveError::conflict("library transfer is in progress")
            .detail("transfer_in_progress", "true")
            .detail("retained_source", root.display().to_string())
            .into());
        root
    };
    let result = operation(&root).map_err(DesktopError::from);
    let active_root = result
        .as_ref()
        .map_or_else(|_| root.clone(), |result| result.active_root.clone());
    let reopened = initialize_desktop_at(Some(active_root)).map_err(|mut error| {
        error
            .details
            .insert("retained_source".into(), root.display().to_string());
        error
    });
    *state.initialization.lock().map_err(|_| {
        DesktopError::from(PortcoveError::state("desktop state lock was poisoned"))
    })? = reopened;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{bootstrap_status, service};
    use std::fs;
    #[tokio::test(flavor = "current_thread")]
    async fn desktop_library_handoff_drops_cached_leases_and_reopens_the_verified_destination() {
        let temporary = tempfile::tempdir().unwrap();
        let source = temporary.path().join("source");
        let destination = temporary.path().join("destination");
        let state = DesktopState {
            initialization: std::sync::Arc::new(std::sync::Mutex::new(initialize_desktop_at(
                Some(source.clone()),
            ))),
        };
        let plan = service(&state)
            .unwrap()
            .plan_library_move(&destination)
            .unwrap();
        // Previously dispatched work must finish before a move can acquire its lease.
        let pending = service(&state).unwrap();
        let blocked = transfer_desktop_library(&state, None, |root| {
            PortcoveService::move_library(root, &destination, &plan.plan_sha256)
        });
        assert!(blocked.is_err());
        assert!(bootstrap_status(&state).ready);
        drop(pending);
        let moved = transfer_desktop_library(&state, None, |root| {
            PortcoveService::move_library(root, &destination, &plan.plan_sha256)
        })
        .unwrap();
        assert!(moved.completed);
        assert_eq!(
            bootstrap_status(&state).library_root.unwrap(),
            fs::canonicalize(destination).unwrap()
        );
    }
}
