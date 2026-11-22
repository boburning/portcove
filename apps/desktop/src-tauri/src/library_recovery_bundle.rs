//! Selecting and reopening the active library is a Desktop concern.
//! Core owns every copy, verification and restore decision.
use crate::{
    DesktopError, DesktopResult, DesktopState, blocking_worker,
    library_transfer::transfer_preserving_current_library, require_library_generation,
    require_no_library_handoff, service_at_generation, state_generation,
};
use portcove_core::{
    LibraryImportResult, LibraryRecoveryBundle, LibraryRecoveryBundlePlan, LibraryRecoveryProgress,
    LibraryRecoveryRestorePlan, OperationCoordinator, OperationEvent, OperationResult,
    PortcoveError, PortcoveService, ProgressUnit,
};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU8, Ordering},
    },
    time::{Duration, Instant},
};
use tauri::{Manager, ipc::Channel};

const COPYING: u8 = 0;
const CANCEL_REQUESTED: u8 = 1;
const VERIFYING: u8 = 2;

/// Only live cancellation switches. Durable recovery still uses Core's journals.
#[derive(Default)]
pub(crate) struct RecoveryCopyOperations(Mutex<BTreeMap<String, Arc<AtomicU8>>>);

impl RecoveryCopyOperations {
    pub(crate) fn request(
        &self,
        id: &str,
    ) -> DesktopResult<Option<portcove_core::CancellationState>> {
        let operations = self.0.lock().map_err(|_| {
            DesktopError::from(PortcoveError::state(
                "recovery copy coordination is unavailable",
            ))
        })?;
        Ok(operations.get(id).map(|phase| {
            let accepted = !matches!(
                phase.compare_exchange(
                    COPYING,
                    CANCEL_REQUESTED,
                    Ordering::AcqRel,
                    Ordering::Acquire
                ),
                Err(VERIFYING)
            );
            portcove_core::CancellationState {
                phase: if accepted {
                    portcove_core::CancellationPhase::Preparing
                } else {
                    portcove_core::CancellationPhase::Finishing
                },
                requested: accepted,
            }
        }))
    }
}

type CopyObservation<'a> = dyn FnMut(LibraryRecoveryProgress) -> portcove_core::Result<()> + 'a;

fn observe_copy<T>(
    app: &tauri::AppHandle,
    channel: Option<Channel<OperationEvent>>,
    work: impl FnOnce(&mut CopyObservation<'_>) -> DesktopResult<T>,
) -> DesktopResult<T> {
    let operation = OperationCoordinator::new("copy_recovery_bundle", None);
    let id = operation.operation_id();
    let phase = Arc::new(AtomicU8::new(COPYING));
    let operations = app.state::<RecoveryCopyOperations>();
    operations
        .0
        .lock()
        .map_err(|_| {
            DesktopError::from(PortcoveError::state(
                "recovery copy coordination is unavailable",
            ))
        })?
        .insert(id.to_owned(), phase.clone());
    struct Registration<'a> {
        operations: &'a RecoveryCopyOperations,
        id: &'a str,
    }
    impl Drop for Registration<'_> {
        fn drop(&mut self) {
            if let Ok(mut operations) = self.operations.0.lock() {
                operations.remove(self.id);
            }
        }
    }
    let _registration = Registration {
        operations: &operations,
        id,
    };
    let emit = |event: OperationEvent| {
        // The handoff deliberately advances the library generation. Keep the
        // initiating view bound to its invocation and publish general activity too.
        crate::emit_install_operation(app, &channel, event);
    };
    emit(operation.started());
    let mut previous = None::<(Instant, u64)>;
    let result = work(&mut |progress| {
        let cancel = || {
            PortcoveError::new(
                portcove_core::ErrorCode::Cancelled,
                "Recovery copy cancelled. Files copied so far are kept so you can resume.",
            )
        };
        match progress {
            LibraryRecoveryProgress::Copying {
                copied_bytes,
                total_bytes,
            } => {
                if phase.load(Ordering::Acquire) == CANCEL_REQUESTED {
                    return Err(cancel());
                }
                if previous.is_none_or(|(time, reported)| {
                    reported != copied_bytes
                        && (copied_bytes == total_bytes
                            || time.elapsed() >= Duration::from_millis(120))
                }) {
                    previous = Some((Instant::now(), copied_bytes));
                    emit(operation.progress_with_unit(
                        "Copying recovery data",
                        ProgressUnit::Bytes,
                        copied_bytes,
                        Some(total_bytes),
                    ));
                }
            }
            LibraryRecoveryProgress::Verifying => {
                if phase.compare_exchange(COPYING, VERIFYING, Ordering::AcqRel, Ordering::Acquire)
                    == Err(CANCEL_REQUESTED)
                {
                    return Err(cancel());
                }
                emit(operation.progress("Verifying recovery data", 0, None));
            }
        }
        Ok(())
    });
    phase.store(VERIFYING, Ordering::Release);
    emit(operation.finished(match &result {
        Ok(_) => OperationResult::Succeeded,
        Err(error) if error.code == portcove_core::ErrorCode::Cancelled => {
            OperationResult::Cancelled
        }
        Err(_) => OperationResult::Failed,
    }));
    result
}

#[tauri::command]
pub(crate) async fn plan_library_recovery_bundle(
    state: tauri::State<'_, DesktopState>,
    generation: u64,
    destination: PathBuf,
) -> DesktopResult<LibraryRecoveryBundlePlan> {
    let state = state.inner().clone();
    blocking_worker(move || {
        let service = service_at_generation(&state, generation)?;
        let review = service.plan_library_recovery_bundle(&destination);
        require_library_generation(state_generation(&state), generation)?;
        Ok(review?)
    })
    .await
}

#[tauri::command]
pub(crate) async fn create_library_recovery_bundle(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    on_event: Option<tauri::ipc::JavaScriptChannelId>,
    state: tauri::State<'_, DesktopState>,
    generation: u64,
    destination: PathBuf,
    expected_plan: String,
) -> DesktopResult<LibraryRecoveryBundle> {
    let state = state.inner().clone();
    blocking_worker(move || {
        observe_copy(&app, on_event.map(|id| id.channel_on(webview)), |observe| {
            transfer_preserving_current_library(&state, generation, |source| {
                PortcoveService::create_library_recovery_bundle_with_progress(
                    source,
                    &destination,
                    &expected_plan,
                    observe,
                )
            })
        })
    })
    .await
}

#[tauri::command]
pub(crate) async fn resume_library_recovery_bundle(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    on_event: Option<tauri::ipc::JavaScriptChannelId>,
    state: tauri::State<'_, DesktopState>,
    generation: u64,
    staging: PathBuf,
) -> DesktopResult<LibraryRecoveryBundle> {
    let state = state.inner().clone();
    blocking_worker(move || {
        observe_copy(&app, on_event.map(|id| id.channel_on(webview)), |observe| {
            transfer_preserving_current_library(&state, generation, |_| {
                PortcoveService::resume_library_recovery_bundle_with_progress(&staging, observe)
            })
        })
    })
    .await
}

#[tauri::command]
pub(crate) async fn inspect_library_recovery_bundle(
    path: PathBuf,
    expected_plan: Option<String>,
) -> DesktopResult<LibraryRecoveryBundle> {
    blocking_worker(move || {
        match expected_plan {
            Some(expected) => {
                PortcoveService::inspect_library_recovery_bundle_for_plan(&path, &expected)
            }
            None => PortcoveService::inspect_library_recovery_bundle(&path),
        }
        .map_err(Into::into)
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
        let active = service.library().root();
        if let Ok(existing) = std::fs::canonicalize(&destination) {
            require_separate_destination(active, &existing)?;
        }
        let review = PortcoveService::review_library_recovery_restore(&path, &destination)
            .and_then(|plan| {
                require_separate_destination(active, &plan.destination_root)?;
                Ok(plan)
            });
        // A structured recovery offer is also a review result. Fence it before use.
        require_library_generation(state_generation(&state), generation)?;
        Ok(review?)
    })
    .await
}

#[tauri::command]
pub(crate) async fn restore_library_recovery_bundle(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    on_event: Option<tauri::ipc::JavaScriptChannelId>,
    state: tauri::State<'_, DesktopState>,
    generation: u64,
    path: PathBuf,
    destination: PathBuf,
    expected_plan: String,
) -> DesktopResult<LibraryImportResult> {
    let state = state.inner().clone();
    blocking_worker(move || {
        observe_copy(&app, on_event.map(|id| id.channel_on(webview)), |observe| {
            transfer_preserving_current_library(&state, generation, |active| {
                let plan = reviewed_destination(active, &path, &destination)?;
                if plan.plan_sha256 != expected_plan {
                    return Err(PortcoveError::conflict(
                        "recovery bundle or restore destination changed; review recovery again",
                    ));
                }
                PortcoveService::restore_library_recovery_bundle_with_progress(
                    &plan.bundle.path,
                    &plan.destination_root,
                    &expected_plan,
                    observe,
                )
            })
        })
    })
    .await
}

#[tauri::command]
pub(crate) async fn read_library_recovery_restore(
    destination: PathBuf,
    expected_plan: String,
) -> DesktopResult<LibraryImportResult> {
    blocking_worker(move || {
        PortcoveService::read_library_recovery_restore(&destination, &expected_plan)
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub(crate) async fn resume_library_recovery_restore(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    on_event: Option<tauri::ipc::JavaScriptChannelId>,
    state: tauri::State<'_, DesktopState>,
    generation: u64,
    destination: PathBuf,
    expected_transfer_id: Option<String>,
) -> DesktopResult<LibraryImportResult> {
    let state = state.inner().clone();
    blocking_worker(move || {
        observe_copy(&app, on_event.map(|id| id.channel_on(webview)), |observe| {
            if let Some(result) = resume_bundle_restore_blocking_startup(
                &state,
                generation,
                &destination,
                expected_transfer_id.as_deref(),
                observe,
            )? {
                return Ok(result);
            }
            transfer_preserving_current_library(&state, generation, |active| {
                let destination = std::fs::canonicalize(&destination)?;
                require_separate_destination(active, &destination)?;
                PortcoveService::resume_library_recovery_restore_with_progress(
                    &destination,
                    expected_transfer_id.as_deref(),
                    observe,
                )
            })
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
    expected_transfer_id: Option<&str>,
    observe: &mut CopyObservation<'_>,
) -> DesktopResult<Option<LibraryImportResult>> {
    let lock_error = || DesktopError::from(PortcoveError::state("desktop state lock was poisoned"));
    let (pending, transfer_id) = {
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
        let transfer_id = failure
            .details
            .get("transfer_id")
            .ok_or_else(|| {
                DesktopError::from(PortcoveError::verification(
                    "startup recovery has no recorded restore identity",
                ))
            })?
            .clone();
        if expected_transfer_id.is_some_and(|expected| expected != transfer_id) {
            return Err(PortcoveError::conflict(
                "the interrupted restore changed; review the current recovery",
            )
            .into());
        }
        let failure = failure.clone();
        *startup = Err(PortcoveError::conflict("library transfer is in progress")
            .detail("transfer_in_progress", "true")
            .into());
        (failure, transfer_id)
    };

    let result = PortcoveService::resume_library_recovery_restore_with_progress(
        destination,
        Some(&transfer_id),
        observe,
    );
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
    fn cancel_targets_the_exact_copy_and_refuses_a_verifying_operation() {
        let runtime = RecoveryCopyOperations::default();
        let copying = Arc::new(AtomicU8::new(COPYING));
        let verifying = Arc::new(AtomicU8::new(VERIFYING));
        runtime.0.lock().unwrap().extend([
            ("copying".to_owned(), copying.clone()),
            ("verifying".to_owned(), verifying.clone()),
        ]);

        assert!(runtime.request("unknown").unwrap().is_none());
        let accepted = runtime.request("copying").unwrap().unwrap();
        assert!(accepted.requested);
        assert_eq!(accepted.phase, portcove_core::CancellationPhase::Preparing);
        assert_eq!(copying.load(Ordering::Acquire), CANCEL_REQUESTED);
        let refused = runtime.request("verifying").unwrap().unwrap();
        assert!(!refused.requested);
        assert_eq!(refused.phase, portcove_core::CancellationPhase::Finishing);
        assert_eq!(verifying.load(Ordering::Acquire), VERIFYING);
    }

    #[test]
    fn startup_resume_only_admits_the_selected_interrupted_bundle() {
        let temporary = tempfile::tempdir().unwrap();
        let destination = temporary.path().join("restore");
        std::fs::create_dir(&destination).unwrap();
        let failure: DesktopError = PortcoveError::conflict("bundle restore needs recovery")
            .detail("import_destination", destination.display().to_string())
            .detail("recovery_action", "resume_library_recovery_restore")
            .detail("transfer_id", "fixture-transfer")
            .into();
        let state = DesktopState {
            initialization: Arc::new(Mutex::new(Err(failure.clone()))),
            preferences: Ok(portcove_core::HostPreferenceStore::new(
                temporary.path().join("preferences.json"),
            )
            .unwrap()),
            generation: Arc::new(AtomicU64::new(2)),
            launch_observer: Arc::new(Mutex::new(None)),
        };
        let sibling = temporary.path().join("another-library");
        let wrong =
            resume_bundle_restore_blocking_startup(&state, 2, &sibling, None, &mut |_| Ok(()))
                .unwrap_err();
        assert_eq!(wrong.message, failure.message);
        assert!(!sibling.exists());
        assert!(
            resume_bundle_restore_blocking_startup(&state, 1, &destination, None, &mut |_| Ok(()))
                .is_err()
        );
        let replacement = resume_bundle_restore_blocking_startup(
            &state,
            2,
            &destination,
            Some("other-transfer"),
            &mut |_| Ok(()),
        )
        .unwrap_err();
        assert!(replacement.message.contains("interrupted restore changed"));
        let actual = resume_bundle_restore_blocking_startup(
            &state,
            2,
            &destination,
            Some("fixture-transfer"),
            &mut |_| Ok(()),
        )
        .unwrap_err();
        assert!(actual.message.contains("no library import journal"));
        let startup = crate::bootstrap_status(&state);
        assert!(!startup.ready);
        assert_eq!(startup.generation, 2);
        assert_eq!(startup.error.unwrap().message, failure.message);
    }
}
