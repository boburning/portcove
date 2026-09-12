//! Post-exit application-update revalidation for a dedicated helper process.
//!
//! The helper request carries only an expected durable journal revision.
//! Repository locations, trust roots, filesystem paths, candidates, and keys
//! remain host-owned Rust inputs. The fixed command-line mode and explicit
//! renderer action live in `application_update_restart`; this module remains
//! the authority-free revalidation sequence they invoke.

use std::path::Path;
use std::thread;
use std::time::{Duration, Instant};

use async_trait::async_trait;

use crate::application_update::{CandidateState, InstalledApplicationContext};
use crate::application_update_apply::{
    ApplicationUpdateApplyError, ApplicationUpdateApplyStore, ApplicationUpdateRevalidationLease,
};
use crate::application_update_preferences::{
    ApplicationUpdateChoice, ApplicationUpdatePreferenceStore,
};
use crate::application_update_repository::{AuthenticatedCandidateSelection, CandidateLoadError};
use crate::application_update_staging::ApplicationUpdateStagingStore;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ApplicationUpdateHelperRequest {
    expected_revision: u64,
}

impl ApplicationUpdateHelperRequest {
    pub fn new(expected_revision: u64) -> Result<Self, ApplicationUpdateHelperError> {
        if expected_revision == 0 {
            return Err(ApplicationUpdateHelperError::InvalidRequest(
                "the expected apply revision must be nonzero".into(),
            ));
        }
        Ok(Self { expected_revision })
    }

    pub fn expected_revision(self) -> u64 {
        self.expected_revision
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ApplicationUpdateRuntimeWaitError {
    #[error("the Portcove application runtime could not be inspected: {0}")]
    Inspection(String),
    #[error("Portcove processes did not exit within the bounded wait")]
    Timeout,
}

#[derive(Debug, thiserror::Error)]
pub enum ApplicationUpdateHelperError {
    #[error("the application update helper request is invalid: {0}")]
    InvalidRequest(String),
    #[error(transparent)]
    Runtime(#[from] ApplicationUpdateRuntimeWaitError),
    #[error(transparent)]
    FreshSelection(#[from] ApplicationUpdateFreshSelectionError),
    #[error("the fresh authenticated repository no longer selects the staged update ({0:?})")]
    CandidateUnavailable(CandidateState),
    #[error(transparent)]
    Apply(#[from] ApplicationUpdateApplyError),
}

#[derive(Debug)]
pub struct ApplicationUpdateFreshSelection {
    pub installed: InstalledApplicationContext,
    pub authenticated: AuthenticatedCandidateSelection,
}

#[derive(Debug, thiserror::Error)]
pub enum ApplicationUpdateFreshSelectionError {
    #[error("the current installed application context could not be observed: {0}")]
    InstalledContext(String),
    #[error(transparent)]
    Candidate(#[from] CandidateLoadError),
}

/// Proves that every Portcove process has released the user-scoped runtime
/// lock. Implementations may block because this runs only in a dedicated
/// helper process, before it takes a shared runtime guard of its own.
pub trait ApplicationUpdateRuntimeWaiter: Send + Sync {
    fn wait_for_release(
        &self,
        application_runtime_lock: &Path,
    ) -> Result<(), ApplicationUpdateRuntimeWaitError>;
}

const DEFAULT_RUNTIME_RELEASE_WAIT: Duration = Duration::from_secs(120);
const RUNTIME_RELEASE_POLL_INTERVAL: Duration = Duration::from_millis(50);

#[derive(Debug, Clone, Copy)]
pub struct BoundedApplicationUpdateRuntimeWaiter {
    timeout: Duration,
}

impl Default for BoundedApplicationUpdateRuntimeWaiter {
    fn default() -> Self {
        Self {
            timeout: DEFAULT_RUNTIME_RELEASE_WAIT,
        }
    }
}

impl BoundedApplicationUpdateRuntimeWaiter {
    #[cfg(test)]
    fn with_timeout(timeout: Duration) -> Self {
        Self { timeout }
    }
}

impl ApplicationUpdateRuntimeWaiter for BoundedApplicationUpdateRuntimeWaiter {
    fn wait_for_release(
        &self,
        application_runtime_lock: &Path,
    ) -> Result<(), ApplicationUpdateRuntimeWaitError> {
        let deadline = Instant::now().checked_add(self.timeout).ok_or_else(|| {
            ApplicationUpdateRuntimeWaitError::Inspection(
                "the runtime wait duration exceeds the system clock range".into(),
            )
        })?;
        loop {
            match portcove_core::ApplicationUpdateExclusivityGuard::acquire(
                application_runtime_lock,
            ) {
                Ok(proof) => {
                    drop(proof);
                    return Ok(());
                }
                Err(error) if error.code == portcove_core::ErrorCode::Conflict => {
                    let now = Instant::now();
                    if now >= deadline {
                        return Err(ApplicationUpdateRuntimeWaitError::Timeout);
                    }
                    thread::sleep(
                        deadline
                            .saturating_duration_since(now)
                            .min(RUNTIME_RELEASE_POLL_INTERVAL),
                    );
                }
                Err(error) => {
                    return Err(ApplicationUpdateRuntimeWaitError::Inspection(
                        error.to_string(),
                    ));
                }
            }
        }
    }
}

/// Reopens the host-owned authenticated repository after the parent exits.
#[async_trait]
pub trait ApplicationUpdateFreshSelectionProvider: Send + Sync {
    async fn select(
        &self,
        choice: &ApplicationUpdateChoice,
    ) -> Result<ApplicationUpdateFreshSelection, ApplicationUpdateFreshSelectionError>;
}

/// Waits until the parent and every peer release the application runtime,
/// obtains a fresh authenticated candidate, and then acquires every durable
/// apply, runtime, and library authority.
///
/// The returned lease must immediately cross a platform ownership boundary;
/// merely retaining or dropping it never starts a replacement.
pub async fn revalidate_application_update_after_parent_exit(
    request: ApplicationUpdateHelperRequest,
    runtime: &dyn ApplicationUpdateRuntimeWaiter,
    fresh: &dyn ApplicationUpdateFreshSelectionProvider,
    apply: &ApplicationUpdateApplyStore,
    preferences: &ApplicationUpdatePreferenceStore,
    staging: &ApplicationUpdateStagingStore,
    application_runtime_lock: &Path,
) -> Result<ApplicationUpdateRevalidationLease, ApplicationUpdateHelperError> {
    let state = apply.load()?;
    if state.revision != request.expected_revision {
        return Err(ApplicationUpdateApplyError::RevisionConflict {
            expected: request.expected_revision,
            actual: state.revision,
        }
        .into());
    }
    if !state.may_attempt_revalidation() {
        return Err(ApplicationUpdateHelperError::InvalidRequest(
            "the durable apply state is not eligible for post-exit revalidation".into(),
        ));
    }
    let intent = state.intent.ok_or_else(|| {
        ApplicationUpdateHelperError::InvalidRequest(
            "the durable apply state has no application update intent".into(),
        )
    })?;

    runtime.wait_for_release(application_runtime_lock)?;
    let selected = fresh.select(&intent.preference_choice).await?;
    let candidate = selected.authenticated.selection.candidate.as_ref().ok_or(
        ApplicationUpdateHelperError::CandidateUnavailable(selected.authenticated.selection.state),
    )?;
    if selected.authenticated.selection.state != CandidateState::UpdateAvailable {
        return Err(ApplicationUpdateHelperError::CandidateUnavailable(
            selected.authenticated.selection.state,
        ));
    }

    apply
        .admit_revalidation(
            request.expected_revision,
            preferences,
            staging,
            candidate,
            &selected.installed,
            application_runtime_lock,
        )
        .await
        .map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::sync::atomic::{AtomicBool, Ordering};

    use base64::Engine as _;
    use serde_json::json;
    use sha2::{Digest, Sha256};

    use super::*;
    use crate::application_update::{
        ApplicationChannel, AuthenticatedRecordPair, CandidateSelection, InstallOwner,
        SelectedCandidate, select_authenticated_candidate,
    };
    use crate::application_update_apply::{
        ApplicationTerminationKind, ApplicationUpdateApplyRequest,
    };
    use crate::application_update_payload::PayloadVerificationKey;
    use crate::application_update_preferences::ApplicationUpdateMode;

    const PUBLIC_KEY: &str = "untrusted comment: minisign public key E7620F1842B4E81F\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3\n";
    const PREHASHED_SIGNATURE: &str = "untrusted comment: signature from minisign secret key\nRUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\ntrusted comment: timestamp:1556193335\tfile:test\ny/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==\n";

    struct NeverWait;

    impl ApplicationUpdateRuntimeWaiter for NeverWait {
        fn wait_for_release(
            &self,
            _application_runtime_lock: &Path,
        ) -> Result<(), ApplicationUpdateRuntimeWaitError> {
            panic!("an invalid helper request must not inspect the runtime lock")
        }
    }

    struct NeverSelect;

    #[async_trait]
    impl ApplicationUpdateFreshSelectionProvider for NeverSelect {
        async fn select(
            &self,
            _choice: &ApplicationUpdateChoice,
        ) -> Result<ApplicationUpdateFreshSelection, ApplicationUpdateFreshSelectionError> {
            panic!("an invalid helper request must not fetch metadata")
        }
    }

    struct RecordingWaiter<'a>(&'a AtomicBool);

    impl ApplicationUpdateRuntimeWaiter for RecordingWaiter<'_> {
        fn wait_for_release(
            &self,
            _application_runtime_lock: &Path,
        ) -> Result<(), ApplicationUpdateRuntimeWaitError> {
            self.0.store(true, Ordering::Release);
            Ok(())
        }
    }

    struct FixtureSelection<'a> {
        waited: &'a AtomicBool,
        candidate: SelectedCandidate,
        installed_version: &'static str,
    }

    #[async_trait]
    impl ApplicationUpdateFreshSelectionProvider for FixtureSelection<'_> {
        async fn select(
            &self,
            choice: &ApplicationUpdateChoice,
        ) -> Result<ApplicationUpdateFreshSelection, ApplicationUpdateFreshSelectionError> {
            assert!(self.waited.load(Ordering::Acquire));
            assert_eq!(choice.channel, ApplicationChannel::Preview);
            Ok(ApplicationUpdateFreshSelection {
                installed: installed(self.installed_version),
                authenticated: AuthenticatedCandidateSelection {
                    selection: CandidateSelection {
                        state: CandidateState::UpdateAvailable,
                        candidate: Some(self.candidate.clone()),
                        reasons: Vec::new(),
                    },
                    payload_key: Some(payload_key()),
                },
            })
        }
    }

    fn installed(version: &str) -> InstalledApplicationContext {
        InstalledApplicationContext {
            current_version: version.into(),
            target: "windows-x86_64".into(),
            os: "windows".into(),
            os_version: "10.0.26200".into(),
            architecture: "x86_64".into(),
            execution_context: "native".into(),
            package_kind: "nsis".into(),
            install_owner: InstallOwner::Portcove,
            product_id: "portcove-desktop".into(),
            capabilities: BTreeSet::from(["host-api-1".into()]),
            cli_protocol: 1,
            catalog_format: 2,
            library_schema: 1,
            library_write_schema: 1,
            lock_protocol: "library-lock-v1".into(),
        }
    }

    fn stageable_candidate(version: &str) -> SelectedCandidate {
        let release = json!({
            "schema_version": 1,
            "version": version,
            "source_commit": "a".repeat(40),
            "source_tree": "b".repeat(40),
            "qualified_run": {
                "workflow": "release.yml",
                "workflow_commit": "e".repeat(40),
                "run_id": 42,
                "attempt": 1,
                "inventory_sha256": "f".repeat(64)
            },
            "target": "windows-x86_64",
            "os": "windows",
            "architecture": "x86_64",
            "execution_context": "native",
            "package": {
                "kind": "nsis",
                "owner": "portcove",
                "product_id": "portcove-desktop"
            },
            "artifact": {
                "url": format!(
                    "https://github.com/boburning/portcove/releases/download/v{version}/Portcove.exe"
                ),
                "sha256": hex::encode(Sha256::digest(b"test")),
                "bytes": 4,
                "tauri_signature": base64::engine::general_purpose::STANDARD
                    .encode(PREHASHED_SIGNATURE.as_bytes()),
                "payload_key_id": payload_key().id
            },
            "compatibility": {
                "minimum_os_version": "10.0.19045",
                "required_capabilities": ["host-api-1"],
                "cli_protocol": { "min": 1, "max": 2 },
                "catalog_formats": [2],
                "library": {
                    "read": { "min": 1, "max": 2 },
                    "write_schema": 1,
                    "lock_protocol": "library-lock-v1"
                }
            },
            "evidence_ids": ["ci-run-42", "windows-package-42"]
        });
        let release_bytes = serde_json::to_vec(&release).unwrap();
        let release_path = format!("releases/{version}/windows-x86_64/nsis.json");
        let promotion = json!({
            "schema_version": 1,
            "channel": "preview",
            "target": "windows-x86_64",
            "package": "nsis",
            "version": version,
            "release_path": release_path,
            "release_sha256": hex::encode(Sha256::digest(&release_bytes)),
            "eligible": true,
            "production_eligible": false,
            "withdrawn": false,
            "reason": null,
            "required_bridge": null
        });
        let promotion_bytes = serde_json::to_vec(&promotion).unwrap();
        select_authenticated_candidate(
            &[AuthenticatedRecordPair {
                release_path: &release_path,
                release_bytes: &release_bytes,
                promotion_bytes: &promotion_bytes,
            }],
            ApplicationChannel::Preview,
            &installed("0.1.0"),
        )
        .unwrap()
        .candidate
        .unwrap()
    }

    fn payload_key() -> PayloadVerificationKey {
        PayloadVerificationKey {
            id: hex::encode(Sha256::digest(PUBLIC_KEY.as_bytes())),
            tauri_public_key: base64::engine::general_purpose::STANDARD
                .encode(PUBLIC_KEY.as_bytes()),
        }
    }

    fn library_root(temporary: &tempfile::TempDir) -> std::path::PathBuf {
        let root = temporary.path().join("library");
        drop(portcove_core::Library::open(&root).unwrap());
        root
    }

    #[test]
    fn request_accepts_only_a_nonzero_revision() {
        assert!(matches!(
            ApplicationUpdateHelperRequest::new(0),
            Err(ApplicationUpdateHelperError::InvalidRequest(_))
        ));
        let request = ApplicationUpdateHelperRequest::new(7).unwrap();
        assert_eq!(request.expected_revision(), 7);
    }

    #[test]
    fn bounded_waiter_uses_the_durable_runtime_lock() {
        let temporary = tempfile::tempdir().unwrap();
        let runtime_lock = temporary.path().join("host/runtime.lock");
        let runtime = portcove_core::ApplicationRuntimeGuard::acquire(&runtime_lock).unwrap();
        assert!(matches!(
            BoundedApplicationUpdateRuntimeWaiter::with_timeout(Duration::ZERO)
                .wait_for_release(&runtime_lock),
            Err(ApplicationUpdateRuntimeWaitError::Timeout)
        ));
        drop(runtime);
        BoundedApplicationUpdateRuntimeWaiter::with_timeout(Duration::ZERO)
            .wait_for_release(&runtime_lock)
            .unwrap();
    }

    #[tokio::test]
    async fn refuses_missing_apply_state_before_wait_or_network() {
        let temporary = tempfile::tempdir().unwrap();
        let apply = ApplicationUpdateApplyStore::new(temporary.path().join("updates")).unwrap();
        let preferences =
            ApplicationUpdatePreferenceStore::new(temporary.path().join("host/preferences.json"))
                .unwrap();
        let staging = ApplicationUpdateStagingStore::new(temporary.path().join("updates")).unwrap();
        let request = ApplicationUpdateHelperRequest::new(1).unwrap();
        let result = revalidate_application_update_after_parent_exit(
            request,
            &NeverWait,
            &NeverSelect,
            &apply,
            &preferences,
            &staging,
            &temporary.path().join("host/runtime.lock"),
        )
        .await;
        assert!(matches!(
            result,
            Err(ApplicationUpdateHelperError::Apply(
                ApplicationUpdateApplyError::RevisionConflict {
                    expected: 1,
                    actual: 0
                }
            ))
        ));
    }

    #[tokio::test]
    async fn waits_then_refreshes_and_retains_every_apply_authority() {
        let temporary = tempfile::tempdir().unwrap();
        let apply = ApplicationUpdateApplyStore::new(temporary.path().join("apply")).unwrap();
        let preferences =
            ApplicationUpdatePreferenceStore::new(temporary.path().join("preferences.json"))
                .unwrap();
        let staging = ApplicationUpdateStagingStore::new(temporary.path().join("staging")).unwrap();
        let candidate = stageable_candidate("0.2.0-beta.1");
        let mut payload = &b"test"[..];
        let staged = staging
            .stage(&mut payload, &candidate, &payload_key())
            .await
            .unwrap();
        let preferences_state = preferences
            .save_choice(
                0,
                ApplicationUpdateChoice {
                    channel: ApplicationChannel::Preview,
                    mode: ApplicationUpdateMode::Automatic,
                    paused: false,
                },
            )
            .unwrap();
        let installed = installed("0.1.0");
        let prepared = apply
            .prepare(
                &preferences_state,
                &staged,
                &installed,
                &library_root(&temporary),
                ApplicationUpdateApplyRequest::SafeExit,
            )
            .unwrap();
        let terminated = apply
            .record_termination(prepared.revision, ApplicationTerminationKind::NormalExit)
            .unwrap();
        let request = ApplicationUpdateHelperRequest::new(terminated.revision).unwrap();
        let waited = AtomicBool::new(false);
        let runtime_lock = temporary.path().join("host/runtime.lock");

        let drift = revalidate_application_update_after_parent_exit(
            request,
            &RecordingWaiter(&waited),
            &FixtureSelection {
                waited: &waited,
                candidate: candidate.clone(),
                installed_version: "0.1.1",
            },
            &apply,
            &preferences,
            &staging,
            &runtime_lock,
        )
        .await;
        assert!(matches!(
            drift,
            Err(ApplicationUpdateHelperError::Apply(
                ApplicationUpdateApplyError::InvalidState(message)
            )) if message.contains("identity changed")
        ));

        let lease = revalidate_application_update_after_parent_exit(
            request,
            &RecordingWaiter(&waited),
            &FixtureSelection {
                waited: &waited,
                candidate,
                installed_version: "0.1.0",
            },
            &apply,
            &preferences,
            &staging,
            &runtime_lock,
        )
        .await
        .unwrap();

        assert!(waited.load(Ordering::Acquire));
        assert_eq!(lease.state(), &terminated);
        assert!(portcove_core::ApplicationRuntimeGuard::acquire(&runtime_lock).is_err());
        assert!(matches!(
            apply.clear(terminated.revision),
            Err(ApplicationUpdateApplyError::Busy)
        ));
        drop(lease);
        assert!(apply.clear(terminated.revision).is_ok());
    }
}
