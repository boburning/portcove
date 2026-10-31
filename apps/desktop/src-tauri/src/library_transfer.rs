//! Native handle handoff; copy, verification, and authority remain in core.
use crate::{
    DesktopError, DesktopResult, DesktopState, blocking_service, blocking_worker,
    initialize_desktop_at, require_no_library_handoff,
};
use portcove_core::{PortcoveError, PortcoveService};
use std::path::{Path, PathBuf};

#[tauri::command]
pub(crate) async fn plan_library_import(
    state: tauri::State<'_, DesktopState>,
    metadata: PathBuf,
    content_root: PathBuf,
) -> DesktopResult<portcove_core::LibraryImportPlan> {
    blocking_service(state.inner().clone(), move |service| {
        PortcoveService::plan_library_import(&metadata, &content_root, service.library().root())
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub(crate) async fn import_library(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
    metadata: PathBuf,
    content_root: PathBuf,
    expected_plan: String,
) -> DesktopResult<portcove_core::LibraryImportResult> {
    let plan = plan_library_import(state.clone(), metadata.clone(), content_root.clone()).await?;
    if plan.plan_sha256 != expected_plan {
        return Err(PortcoveError::conflict("import plan changed; review it again").into());
    }
    let message = format!(
        "Restore {} application versions and their local data from {} into {}? Only restore a Portcove export you trust. The input files will be retained.",
        plan.metadata.application_versions.len(),
        plan.content_root.display(),
        plan.destination_root.display()
    );
    if !crate::confirm_destructive(&app, "Confirm library restore", message, "Restore library")
        .await
    {
        return Err(PortcoveError::conflict("library restore was not confirmed").into());
    }
    let state = state.inner().clone();
    blocking_worker(move || {
        transfer_desktop_library(
            &state,
            None,
            |destination| {
                PortcoveService::import_library(
                    &metadata,
                    &content_root,
                    destination,
                    &expected_plan,
                )
            },
            |result| result.destination_root.clone(),
        )
    })
    .await
}

#[tauri::command]
pub(crate) async fn recover_library_import(
    state: tauri::State<'_, DesktopState>,
    destination: PathBuf,
    abort: bool,
) -> DesktopResult<portcove_core::LibraryImportResult> {
    let state = state.inner().clone();
    blocking_worker(move || {
        transfer_desktop_library(
            &state,
            Some(destination),
            |destination| {
                if abort {
                    PortcoveService::abort_library_import(destination)
                } else {
                    PortcoveService::resume_library_import(destination)
                }
            },
            |result| result.destination_root.clone(),
        )
    })
    .await
}

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
        transfer_desktop_library(
            &state,
            None,
            |source| PortcoveService::move_library(source, &destination, &expected_plan),
            |result| result.active_root.clone(),
        )
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
        transfer_desktop_library(
            &state,
            Some(source),
            |source| {
                if abort {
                    PortcoveService::abort_library_move(source)
                } else {
                    PortcoveService::resume_library_move(source)
                }
            },
            |result| result.active_root.clone(),
        )
    })
    .await
}

fn transfer_desktop_library<T, F>(
    state: &DesktopState,
    recovery_root: Option<PathBuf>,
    operation: F,
    active_root: impl FnOnce(&T) -> PathBuf,
) -> DesktopResult<T>
where
    F: FnOnce(&Path) -> portcove_core::Result<T>,
{
    let (root, outgoing_root) = {
        let mut initialization = state.initialization.lock().map_err(|_| {
            DesktopError::from(PortcoveError::state("desktop state lock was poisoned"))
        })?;
        require_no_library_handoff(&initialization)?;
        let outgoing_root = initialization
            .as_ref()
            .ok()
            .map(|ready| ready.library.root().to_path_buf());
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
        // Stop new readers and release cached leases before waiting for short
        // dispatched reads. Core still owns the subsequent exclusive operation.
        *initialization = Err(PortcoveError::conflict("library transfer is in progress")
            .detail("transfer_in_progress", "true")
            .detail("retained_source", root.display().to_string())
            .into());
        (root, outgoing_root)
    };
    // Probe only the formerly selected, validated root. An explicit recovery
    // path must reach Core's validation without a host-created lease directory.
    let drained = outgoing_root
        .as_deref()
        .map_or(Ok(()), crate::library_selection::wait_for_outgoing_library);
    let result = drained
        .and_then(|()| operation(&root))
        .map_err(DesktopError::from);
    let active_root = result.as_ref().map_or_else(|_| root.clone(), active_root);
    let reopened = initialize_desktop_at(Some(active_root)).map_err(|mut error| {
        if !error.details.contains_key("import_destination") {
            error
                .details
                .insert("retained_source".into(), root.display().to_string());
        }
        error
    });
    {
        let mut initialization = state.initialization.lock().map_err(|_| {
            DesktopError::from(PortcoveError::state("desktop state lock was poisoned"))
        })?;
        *initialization = reopened;
        // An error may follow committed copy/publication work. Reopening may even
        // follow a relocation receipt, so every attempted transfer expires reviews.
        state
            .generation
            .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{bootstrap_status, service};
    use std::fs;
    #[test]
    fn pending_auth_status_observation_does_not_retain_library_handoff_lease() {
        let temporary = tempfile::tempdir().unwrap();
        let source = temporary.path().join("source");
        let destination = temporary.path().join("destination");
        let state = DesktopState {
            initialization: std::sync::Arc::new(std::sync::Mutex::new(initialize_desktop_at(
                Some(source.clone()),
            ))),
            preferences: portcove_core::HostPreferenceStore::new(
                temporary.path().join("preferences.json"),
            )
            .map_err(DesktopError::from),
            generation: std::sync::Arc::new(std::sync::atomic::AtomicU64::new(1)),
            launch_observer: std::sync::Arc::new(std::sync::Mutex::new(None)),
        };
        let plan = service(&state)
            .unwrap()
            .plan_library_move(&destination)
            .unwrap();
        // The actual command seam must own only HTTP observation inputs while
        // suspended. Its future remains live across the real exclusive handoff.
        let pending = crate::github_status_observation(&state).unwrap();
        let moved = transfer_desktop_library(
            &state,
            None,
            |root| PortcoveService::move_library(root, &destination, &plan.plan_sha256),
            |result| result.active_root.clone(),
        )
        .expect("pending authentication status must not keep the old library in use");
        assert!(moved.completed);
        assert_eq!(bootstrap_status(&state).generation, 2);
        assert_eq!(
            bootstrap_status(&state).library_root.unwrap(),
            fs::canonicalize(destination).unwrap()
        );
        drop(pending);
        assert_eq!(bootstrap_status(&state).generation, 2);
        assert!(crate::service_at_generation(&state, 1).is_err());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn desktop_library_handoff_drops_cached_leases_and_reopens_the_verified_destination() {
        let temporary = tempfile::tempdir().unwrap();
        let source = temporary.path().join("source");
        let destination = temporary.path().join("destination");
        let state = DesktopState {
            initialization: std::sync::Arc::new(std::sync::Mutex::new(initialize_desktop_at(
                Some(source.clone()),
            ))),
            preferences: portcove_core::HostPreferenceStore::new(
                temporary.path().join("preferences.json"),
            )
            .map_err(DesktopError::from),
            generation: std::sync::Arc::new(std::sync::atomic::AtomicU64::new(1)),
            launch_observer: std::sync::Arc::new(std::sync::Mutex::new(None)),
        };
        let plan = service(&state)
            .unwrap()
            .plan_library_move(&destination)
            .unwrap();
        // Previously dispatched work must finish before a move can acquire its lease.
        let pending = service(&state).unwrap();
        let blocked = transfer_desktop_library(
            &state,
            None,
            |root| PortcoveService::move_library(root, &destination, &plan.plan_sha256),
            |result| result.active_root.clone(),
        );
        assert!(blocked.is_err());
        assert!(bootstrap_status(&state).ready);
        assert_eq!(bootstrap_status(&state).generation, 2);
        assert!(crate::service_at_generation(&state, 1).is_err());
        drop(pending);
        let moved = transfer_desktop_library(
            &state,
            None,
            |root| PortcoveService::move_library(root, &destination, &plan.plan_sha256),
            |result| result.active_root.clone(),
        )
        .unwrap();
        assert!(moved.completed);
        assert_eq!(bootstrap_status(&state).generation, 3);
        assert!(crate::service_at_generation(&state, 2).is_err());
        assert!(crate::service_at_generation(&state, 3).is_ok());
        assert_eq!(
            bootstrap_status(&state).library_root.unwrap(),
            fs::canonicalize(destination).unwrap()
        );
    }
    #[test]
    fn transfer_waits_for_a_previously_dispatched_read_to_finish() {
        let temporary = tempfile::tempdir().unwrap();
        let source = temporary.path().join("source");
        let destination = temporary.path().join("destination");
        let state = DesktopState {
            initialization: std::sync::Arc::new(std::sync::Mutex::new(initialize_desktop_at(
                Some(source.clone()),
            ))),
            preferences: portcove_core::HostPreferenceStore::new(
                temporary.path().join("preferences.json"),
            )
            .map_err(DesktopError::from),
            generation: std::sync::Arc::new(std::sync::atomic::AtomicU64::new(1)),
            launch_observer: std::sync::Arc::new(std::sync::Mutex::new(None)),
        };
        let plan = service(&state)
            .unwrap()
            .plan_library_move(&destination)
            .unwrap();
        let held = service(&state).unwrap();
        let reader = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(250));
            drop(held);
        });
        let moved = transfer_desktop_library(
            &state,
            None,
            |root| PortcoveService::move_library(root, &destination, &plan.plan_sha256),
            |result| result.active_root.clone(),
        );
        reader.join().unwrap();
        let moved = moved.expect("a short outgoing read must settle before exclusive transfer");
        assert!(moved.completed);
        let reopened = bootstrap_status(&state);
        assert!(reopened.ready);
        assert_eq!(reopened.generation, 2);
        assert_eq!(
            reopened.library_root.unwrap(),
            fs::canonicalize(destination).unwrap()
        );
        assert!(crate::service_at_generation(&state, 1).is_err());
        assert!(crate::service_at_generation(&state, 2).is_ok());
    }

    #[test]
    fn transfer_does_not_preflight_an_unvalidated_recovery_root() {
        let temporary = tempfile::tempdir().unwrap();
        let source = temporary.path().join("source");
        let recovery = temporary.path().join("unvalidated-recovery");
        let state = DesktopState {
            initialization: std::sync::Arc::new(std::sync::Mutex::new(initialize_desktop_at(
                Some(source),
            ))),
            preferences: portcove_core::HostPreferenceStore::new(
                temporary.path().join("preferences.json"),
            )
            .map_err(DesktopError::from),
            generation: std::sync::Arc::new(std::sync::atomic::AtomicU64::new(1)),
            launch_observer: std::sync::Arc::new(std::sync::Mutex::new(None)),
        };
        let called = std::cell::Cell::new(false);
        let result: DesktopResult<()> = transfer_desktop_library(
            &state,
            Some(recovery.clone()),
            |root| {
                called.set(true);
                assert_eq!(root, recovery);
                assert!(
                    !root.exists(),
                    "host drain must not create an unvalidated recovery path"
                );
                Err(PortcoveError::state("injected Core recovery refusal"))
            },
            |_| unreachable!("the operation refused recovery"),
        );
        assert!(called.get());
        assert!(result.is_err());
        assert_eq!(bootstrap_status(&state).generation, 2);
    }

    #[test]
    fn failed_transfer_after_publication_reopens_destination_and_expires_reviews() {
        let temporary = tempfile::tempdir().unwrap();
        let source = temporary.path().join("source");
        let destination = temporary.path().join("destination");
        let state = DesktopState {
            initialization: std::sync::Arc::new(std::sync::Mutex::new(initialize_desktop_at(
                Some(source.clone()),
            ))),
            preferences: portcove_core::HostPreferenceStore::new(
                temporary.path().join("preferences.json"),
            )
            .map_err(DesktopError::from),
            generation: std::sync::Arc::new(std::sync::atomic::AtomicU64::new(1)),
            launch_observer: std::sync::Arc::new(std::sync::Mutex::new(None)),
        };
        let plan = service(&state)
            .unwrap()
            .plan_library_move(&destination)
            .unwrap();
        let failed: DesktopResult<()> = transfer_desktop_library(
            &state,
            None,
            |root| {
                PortcoveService::move_library(root, &destination, &plan.plan_sha256)?;
                Err(PortcoveError::state("injected error after publication"))
            },
            |_| unreachable!("the operation returned an error"),
        );
        assert!(failed.is_err());
        let reopened = bootstrap_status(&state);
        assert!(reopened.ready);
        assert_eq!(
            reopened.library_root.unwrap(),
            fs::canonicalize(destination).unwrap()
        );
        assert_eq!(reopened.generation, 2);
        assert!(crate::service_at_generation(&state, 1).is_err());
        assert!(crate::service_at_generation(&state, 2).is_ok());
    }
    #[test]
    fn recovery_transfer_cannot_replace_an_inflight_library_switch() {
        let temporary = tempfile::tempdir().unwrap();
        let state = DesktopState {
            initialization: std::sync::Arc::new(std::sync::Mutex::new(Err(
                PortcoveError::conflict("owned switch")
                    .detail("library_switch_in_progress", "true")
                    .into(),
            ))),
            preferences: portcove_core::HostPreferenceStore::new(
                temporary.path().join("preferences.json"),
            )
            .map_err(DesktopError::from),
            generation: std::sync::Arc::new(std::sync::atomic::AtomicU64::new(7)),
            launch_observer: std::sync::Arc::new(std::sync::Mutex::new(None)),
        };
        let called = std::cell::Cell::new(false);
        let result = transfer_desktop_library(
            &state,
            Some(temporary.path().join("recovery")),
            |_| {
                called.set(true);
                Ok(())
            },
            |_| temporary.path().join("destination"),
        );
        assert!(result.is_err());
        assert!(!called.get());
        assert!(
            crate::ready(&state)
                .err()
                .unwrap()
                .details
                .contains_key("library_switch_in_progress")
        );
        assert_eq!(bootstrap_status(&state).generation, 7);
        assert_eq!(fs::read_dir(temporary.path()).unwrap().count(), 0);
    }
}
