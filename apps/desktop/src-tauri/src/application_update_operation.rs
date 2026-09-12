//! Host-owned orchestration for application-update checks and verified staging.
//!
//! This boundary composes the existing policy, trust, payload and staging
//! authorities. It exposes only fixed progress phases and sanitized outcomes;
//! repository locations, signatures, keys and filesystem paths stay in Rust.
//! Platform replacement remains behind the later native apply adapters.

use async_trait::async_trait;
use tokio::io::AsyncRead;
use tokio_util::sync::CancellationToken;

use crate::application_update::{
    ApplicationUpdateCandidateSummary, CandidateSelection, CandidateState, SelectedCandidate,
};
use crate::application_update_coordinator::{
    ApplicationUpdateCheckCompletion, ApplicationUpdateCheckEnvironment, ApplicationUpdateChecker,
    ApplicationUpdateCoordinator, ApplicationUpdateCoordinatorError,
    ApplicationUpdateCoordinatorOutcome, ApplicationUpdateCoordinatorRunError,
};
use crate::application_update_download::{PayloadDownloadError, download_payload};
use crate::application_update_preferences::ApplicationUpdateMode;
use crate::application_update_schedule::ApplicationUpdateCheckDecision;
use crate::application_update_staging::{
    ApplicationUpdateStagingError, ApplicationUpdateStagingStore,
};

pub type ApplicationUpdatePayloadReader = Box<dyn AsyncRead + Send + Unpin>;

#[derive(Debug, thiserror::Error)]
pub enum ApplicationUpdateOperationError {
    #[error("application update operation was cancelled")]
    Cancelled,
    #[error(transparent)]
    Coordinator(#[from] ApplicationUpdateCoordinatorError),
    #[error(transparent)]
    Download(#[from] PayloadDownloadError),
    #[error(transparent)]
    Staging(#[from] ApplicationUpdateStagingError),
    #[error("authenticated application update selection is inconsistent: {0}")]
    InvalidSelection(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApplicationUpdateOperationPhase {
    Checking,
    AcquiringAndVerifying,
    Staged,
    Complete,
}

pub trait ApplicationUpdateProgressSink: Send + Sync {
    fn emit(&self, phase: ApplicationUpdateOperationPhase);
}

#[derive(Debug, Default)]
pub struct NoopApplicationUpdateProgressSink;

impl ApplicationUpdateProgressSink for NoopApplicationUpdateProgressSink {
    fn emit(&self, _phase: ApplicationUpdateOperationPhase) {}
}

#[async_trait]
pub trait ApplicationUpdatePayloadSource: Send + Sync {
    async fn open(
        &self,
        candidate: &SelectedCandidate,
    ) -> Result<ApplicationUpdatePayloadReader, PayloadDownloadError>;
}

#[derive(Debug, Default)]
pub struct GithubApplicationUpdatePayloadSource;

#[async_trait]
impl ApplicationUpdatePayloadSource for GithubApplicationUpdatePayloadSource {
    async fn open(
        &self,
        candidate: &SelectedCandidate,
    ) -> Result<ApplicationUpdatePayloadReader, PayloadDownloadError> {
        Ok(Box::new(download_payload(candidate).await?))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApplicationUpdateSelectionSummary {
    pub state: CandidateState,
    pub candidate: Option<ApplicationUpdateCandidateSummary>,
    pub reasons: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApplicationUpdateOperationOutcome {
    Held(ApplicationUpdateCheckDecision),
    Superseded {
        checked_preference_revision: u64,
        current_preference_revision: u64,
    },
    Checked {
        preference_revision: u64,
        selection: ApplicationUpdateSelectionSummary,
        staged: bool,
    },
}

#[derive(Clone)]
pub struct ApplicationUpdateOperation {
    coordinator: ApplicationUpdateCoordinator,
    staging: ApplicationUpdateStagingStore,
}

struct StageCheckCompletion<'a> {
    staging: &'a ApplicationUpdateStagingStore,
    payload_source: &'a dyn ApplicationUpdatePayloadSource,
    progress: &'a dyn ApplicationUpdateProgressSink,
}

#[async_trait]
impl ApplicationUpdateCheckCompletion for StageCheckCompletion<'_> {
    type Error = ApplicationUpdateOperationError;

    async fn complete(
        &self,
        _preference_revision: u64,
        choice: &crate::application_update_preferences::ApplicationUpdateChoice,
        selection: &crate::application_update_repository::AuthenticatedCandidateSelection,
    ) -> Result<(), Self::Error> {
        validate_selection_shape(&selection.selection, selection.payload_key.is_some())?;
        if choice.mode != ApplicationUpdateMode::Automatic
            || selection.selection.state != CandidateState::UpdateAvailable
        {
            return Ok(());
        }
        let candidate = selection.selection.candidate.as_ref().ok_or_else(|| {
            ApplicationUpdateOperationError::InvalidSelection(
                "an available update omitted its candidate".into(),
            )
        })?;
        let key = selection.payload_key.as_ref().ok_or_else(|| {
            ApplicationUpdateOperationError::InvalidSelection(
                "an available update omitted its payload key".into(),
            )
        })?;
        if self
            .staging
            .reconcile()
            .await?
            .is_some_and(|staged| staged.candidate == *candidate)
        {
            self.progress.emit(ApplicationUpdateOperationPhase::Staged);
            return Ok(());
        }
        self.progress
            .emit(ApplicationUpdateOperationPhase::AcquiringAndVerifying);
        let mut payload = self.payload_source.open(candidate).await?;
        self.staging.stage(&mut payload, candidate, key).await?;
        self.progress.emit(ApplicationUpdateOperationPhase::Staged);
        Ok(())
    }
}

impl ApplicationUpdateOperation {
    pub fn new(
        coordinator: ApplicationUpdateCoordinator,
        staging: ApplicationUpdateStagingStore,
    ) -> Self {
        Self {
            coordinator,
            staging,
        }
    }

    /// Runs one policy-controlled check and stages only an authenticated newer
    /// candidate selected under automatic-download consent. Dropping or
    /// cancelling this future cannot publish unverified bytes; staging restart
    /// reconciliation restores the previous verified slot.
    pub async fn check_and_stage(
        &self,
        environment: ApplicationUpdateCheckEnvironment,
        checker: &dyn ApplicationUpdateChecker,
        payload_source: &dyn ApplicationUpdatePayloadSource,
        progress: &dyn ApplicationUpdateProgressSink,
        cancellation: &CancellationToken,
    ) -> Result<ApplicationUpdateOperationOutcome, ApplicationUpdateOperationError> {
        require_active(cancellation)?;
        progress.emit(ApplicationUpdateOperationPhase::Checking);
        let completion = StageCheckCompletion {
            staging: &self.staging,
            payload_source,
            progress,
        };
        let checked = tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Err(ApplicationUpdateOperationError::Cancelled),
            result = self.coordinator.run_with_completion(environment, checker, &completion) => {
                match result {
                    Ok(outcome) => outcome,
                    Err(ApplicationUpdateCoordinatorRunError::Coordinator(error)) => {
                        return Err(error.into());
                    }
                    Err(ApplicationUpdateCoordinatorRunError::Completion(error)) => {
                        return Err(error);
                    }
                }
            },
        };

        let outcome = match checked {
            ApplicationUpdateCoordinatorOutcome::Held(decision) => {
                ApplicationUpdateOperationOutcome::Held(decision)
            }
            ApplicationUpdateCoordinatorOutcome::Superseded {
                checked_preference_revision,
                current_preference_revision,
                ..
            } => ApplicationUpdateOperationOutcome::Superseded {
                checked_preference_revision,
                current_preference_revision,
            },
            ApplicationUpdateCoordinatorOutcome::Checked {
                preference_revision,
                preference_choice,
                selection,
                ..
            } => {
                let staged = preference_choice.mode == ApplicationUpdateMode::Automatic
                    && selection.selection.state == CandidateState::UpdateAvailable;
                ApplicationUpdateOperationOutcome::Checked {
                    preference_revision,
                    selection: selection_summary(&selection.selection),
                    staged,
                }
            }
        };
        progress.emit(ApplicationUpdateOperationPhase::Complete);
        Ok(outcome)
    }
}

fn require_active(cancellation: &CancellationToken) -> Result<(), ApplicationUpdateOperationError> {
    if cancellation.is_cancelled() {
        Err(ApplicationUpdateOperationError::Cancelled)
    } else {
        Ok(())
    }
}

fn validate_selection_shape(
    selection: &CandidateSelection,
    has_payload_key: bool,
) -> Result<(), ApplicationUpdateOperationError> {
    match (selection.candidate.is_some(), has_payload_key) {
        (true, true) | (false, false) => Ok(()),
        (true, false) => Err(ApplicationUpdateOperationError::InvalidSelection(
            "a selected candidate omitted its payload key".into(),
        )),
        (false, true) => Err(ApplicationUpdateOperationError::InvalidSelection(
            "a payload key was returned without a selected candidate".into(),
        )),
    }
}

fn selection_summary(selection: &CandidateSelection) -> ApplicationUpdateSelectionSummary {
    ApplicationUpdateSelectionSummary {
        state: selection.state,
        candidate: selection.candidate.as_ref().map(Into::into),
        reasons: selection.reasons.clone(),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    use base64::Engine as _;
    use sha2::{Digest, Sha256};

    use super::*;
    use crate::application_update::{
        ApplicationChannel, ApplicationCompatibility, ArtifactIdentity,
        AuthenticatedTargetReference, InstallOwner, LibraryCompatibility, PackageIdentity,
        PromotionRecord, QualifiedRun, ReleaseRecord, VersionRange,
    };
    use crate::application_update_coordinator::ApplicationUpdateClock;
    use crate::application_update_preferences::{
        ApplicationUpdateChoice, ApplicationUpdatePreferenceStore,
    };
    use crate::application_update_repository::{
        AuthenticatedCandidateSelection, CandidateLoadError,
    };
    use crate::application_update_schedule::{
        ApplicationUpdateCheckRequest, ApplicationUpdateScheduleStore, MeteredConnection,
        NetworkAvailability,
    };

    const PUBLIC_KEY: &str = "untrusted comment: minisign public key E7620F1842B4E81F\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3\n";
    const PREHASHED_SIGNATURE: &str = "untrusted comment: signature from minisign secret key\nRUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\ntrusted comment: timestamp:1556193335\tfile:test\ny/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==\n";

    struct FakeClock(AtomicU64);

    impl ApplicationUpdateClock for FakeClock {
        fn now_unix_seconds(&self) -> Result<u64, String> {
            Ok(self.0.load(Ordering::SeqCst))
        }
    }

    struct FakeChecker {
        result: Mutex<Option<Result<AuthenticatedCandidateSelection, CandidateLoadError>>>,
    }

    #[async_trait]
    impl ApplicationUpdateChecker for FakeChecker {
        async fn check(
            &self,
            _choice: ApplicationUpdateChoice,
        ) -> Result<AuthenticatedCandidateSelection, CandidateLoadError> {
            self.result.lock().unwrap().take().unwrap()
        }
    }

    struct FakePayloadSource {
        bytes: Vec<u8>,
        calls: AtomicUsize,
    }

    struct HangingPayloadSource {
        reader: Mutex<Option<tokio::io::DuplexStream>>,
    }

    struct FailingPayloadSource;

    #[async_trait]
    impl ApplicationUpdatePayloadSource for FakePayloadSource {
        async fn open(
            &self,
            _candidate: &SelectedCandidate,
        ) -> Result<ApplicationUpdatePayloadReader, PayloadDownloadError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(Box::new(std::io::Cursor::new(self.bytes.clone())))
        }
    }

    #[async_trait]
    impl ApplicationUpdatePayloadSource for HangingPayloadSource {
        async fn open(
            &self,
            _candidate: &SelectedCandidate,
        ) -> Result<ApplicationUpdatePayloadReader, PayloadDownloadError> {
            Ok(Box::new(self.reader.lock().unwrap().take().unwrap()))
        }
    }

    #[async_trait]
    impl ApplicationUpdatePayloadSource for FailingPayloadSource {
        async fn open(
            &self,
            _candidate: &SelectedCandidate,
        ) -> Result<ApplicationUpdatePayloadReader, PayloadDownloadError> {
            Err(PayloadDownloadError::Network("offline".into()))
        }
    }

    #[derive(Default)]
    struct RecordingProgress(Mutex<Vec<ApplicationUpdateOperationPhase>>);

    impl ApplicationUpdateProgressSink for RecordingProgress {
        fn emit(&self, phase: ApplicationUpdateOperationPhase) {
            self.0.lock().unwrap().push(phase);
        }
    }

    fn key_id() -> String {
        hex::encode(Sha256::digest(PUBLIC_KEY.as_bytes()))
    }

    fn payload_key() -> crate::application_update_payload::PayloadVerificationKey {
        crate::application_update_payload::PayloadVerificationKey {
            id: key_id(),
            tauri_public_key: base64::engine::general_purpose::STANDARD
                .encode(PUBLIC_KEY.as_bytes()),
        }
    }

    fn candidate(payload: &[u8]) -> SelectedCandidate {
        let version = "1.0.0";
        let release_path = format!("releases/{version}/windows-x86_64/nsis.json");
        let release_sha256 = "a".repeat(64);
        SelectedCandidate {
            release_path: release_path.clone(),
            release_sha256: release_sha256.clone(),
            release: ReleaseRecord {
                schema_version: 1,
                version: version.into(),
                source_commit: "b".repeat(40),
                source_tree: "c".repeat(40),
                qualified_run: QualifiedRun {
                    workflow: "release.yml".into(),
                    workflow_commit: "d".repeat(40),
                    run_id: 1,
                    attempt: 1,
                    inventory_sha256: "e".repeat(64),
                },
                target: "windows-x86_64".into(),
                os: "windows".into(),
                architecture: "x86_64".into(),
                execution_context: "desktop".into(),
                package: PackageIdentity {
                    kind: "nsis".into(),
                    owner: InstallOwner::Portcove,
                    product_id: "portcove".into(),
                },
                artifact: ArtifactIdentity {
                    url: format!(
                        "https://github.com/boburning/portcove/releases/download/v{version}/Portcove.exe"
                    ),
                    sha256: hex::encode(Sha256::digest(payload)),
                    bytes: payload.len() as u64,
                    tauri_signature: base64::engine::general_purpose::STANDARD
                        .encode(PREHASHED_SIGNATURE.as_bytes()),
                    payload_key_id: key_id(),
                },
                compatibility: ApplicationCompatibility {
                    minimum_os_version: "10.0.0".into(),
                    required_capabilities: Vec::new(),
                    cli_protocol: VersionRange { min: 1, max: 1 },
                    catalog_formats: vec![1],
                    library: LibraryCompatibility {
                        read: VersionRange { min: 1, max: 1 },
                        write_schema: 1,
                        lock_protocol: "portcove-v1".into(),
                    },
                },
                evidence_ids: vec!["fixture".into()],
            },
            promotion: PromotionRecord {
                schema_version: 1,
                channel: ApplicationChannel::Preview,
                target: "windows-x86_64".into(),
                package: "nsis".into(),
                version: version.into(),
                release_path,
                release_sha256,
                eligible: true,
                production_eligible: false,
                withdrawn: false,
                reason: None,
                required_bridge: None::<AuthenticatedTargetReference>,
            },
        }
    }

    fn authenticated(
        state: CandidateState,
        candidate: Option<SelectedCandidate>,
    ) -> AuthenticatedCandidateSelection {
        AuthenticatedCandidateSelection {
            payload_key: candidate.as_ref().map(|_| payload_key()),
            selection: CandidateSelection {
                state,
                candidate,
                reasons: Vec::new(),
            },
        }
    }

    fn fixture(
        mode: ApplicationUpdateMode,
    ) -> (
        tempfile::TempDir,
        ApplicationUpdateOperation,
        ApplicationUpdatePreferenceStore,
    ) {
        let temporary = tempfile::tempdir().unwrap();
        let preferences = ApplicationUpdatePreferenceStore::new(
            temporary.path().join("application-updates.json"),
        )
        .unwrap();
        preferences
            .save_choice(
                0,
                ApplicationUpdateChoice {
                    channel: ApplicationChannel::Preview,
                    mode,
                    paused: false,
                },
            )
            .unwrap();
        let schedule =
            ApplicationUpdateScheduleStore::new(temporary.path().join("schedule.json")).unwrap();
        let coordinator = ApplicationUpdateCoordinator::new(
            preferences.clone(),
            schedule,
            temporary.path().join("check.lock"),
            Arc::new(FakeClock(AtomicU64::new(2_000))),
        )
        .unwrap();
        let staging = ApplicationUpdateStagingStore::new(temporary.path().join("staging")).unwrap();
        (
            temporary,
            ApplicationUpdateOperation::new(coordinator, staging),
            preferences,
        )
    }

    fn environment() -> ApplicationUpdateCheckEnvironment {
        ApplicationUpdateCheckEnvironment {
            request: ApplicationUpdateCheckRequest::Manual,
            startup_unix_seconds: 1_000,
            network: NetworkAvailability::Online,
            metered: MeteredConnection::Unmetered,
        }
    }

    fn checker(result: AuthenticatedCandidateSelection) -> FakeChecker {
        FakeChecker {
            result: Mutex::new(Some(Ok(result))),
        }
    }

    #[tokio::test]
    async fn automatic_mode_stages_only_the_authenticated_available_payload() {
        let (temporary, operation, _preferences) = fixture(ApplicationUpdateMode::Automatic);
        let selected = candidate(b"test");
        let source = FakePayloadSource {
            bytes: b"test".to_vec(),
            calls: AtomicUsize::new(0),
        };
        let progress = RecordingProgress::default();

        let outcome = operation
            .check_and_stage(
                environment(),
                &checker(authenticated(
                    CandidateState::UpdateAvailable,
                    Some(selected),
                )),
                &source,
                &progress,
                &CancellationToken::new(),
            )
            .await
            .unwrap();

        assert!(matches!(
            outcome,
            ApplicationUpdateOperationOutcome::Checked { staged: true, .. }
        ));
        assert_eq!(source.calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            std::fs::read(temporary.path().join("staging/candidate.payload")).unwrap(),
            b"test"
        );
        assert_eq!(
            *progress.0.lock().unwrap(),
            [
                ApplicationUpdateOperationPhase::Checking,
                ApplicationUpdateOperationPhase::AcquiringAndVerifying,
                ApplicationUpdateOperationPhase::Staged,
                ApplicationUpdateOperationPhase::Complete,
            ]
        );

        let second_progress = RecordingProgress::default();
        let outcome = operation
            .check_and_stage(
                environment(),
                &checker(authenticated(
                    CandidateState::UpdateAvailable,
                    Some(candidate(b"test")),
                )),
                &source,
                &second_progress,
                &CancellationToken::new(),
            )
            .await
            .unwrap();
        assert!(matches!(
            outcome,
            ApplicationUpdateOperationOutcome::Checked { staged: true, .. }
        ));
        assert_eq!(source.calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            *second_progress.0.lock().unwrap(),
            [
                ApplicationUpdateOperationPhase::Checking,
                ApplicationUpdateOperationPhase::Staged,
                ApplicationUpdateOperationPhase::Complete,
            ]
        );
    }

    #[tokio::test]
    async fn notify_and_manual_modes_never_download_or_stage() {
        for mode in [
            ApplicationUpdateMode::NotifyOnly,
            ApplicationUpdateMode::Manual,
        ] {
            let (_temporary, operation, _preferences) = fixture(mode);
            let source = FakePayloadSource {
                bytes: b"test".to_vec(),
                calls: AtomicUsize::new(0),
            };
            let outcome = operation
                .check_and_stage(
                    environment(),
                    &checker(authenticated(
                        CandidateState::UpdateAvailable,
                        Some(candidate(b"test")),
                    )),
                    &source,
                    &NoopApplicationUpdateProgressSink,
                    &CancellationToken::new(),
                )
                .await
                .unwrap();
            assert!(matches!(
                outcome,
                ApplicationUpdateOperationOutcome::Checked { staged: false, .. }
            ));
            assert_eq!(source.calls.load(Ordering::SeqCst), 0);
        }
    }

    #[tokio::test]
    async fn nonavailable_selection_is_reported_without_payload_activity() {
        let (_temporary, operation, _preferences) = fixture(ApplicationUpdateMode::Automatic);
        let source = FakePayloadSource {
            bytes: Vec::new(),
            calls: AtomicUsize::new(0),
        };
        let outcome = operation
            .check_and_stage(
                environment(),
                &checker(authenticated(CandidateState::NoCandidate, None)),
                &source,
                &NoopApplicationUpdateProgressSink,
                &CancellationToken::new(),
            )
            .await
            .unwrap();
        assert!(matches!(
            outcome,
            ApplicationUpdateOperationOutcome::Checked {
                selection: ApplicationUpdateSelectionSummary {
                    state: CandidateState::NoCandidate,
                    ..
                },
                staged: false,
                ..
            }
        ));
        assert_eq!(source.calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn missing_payload_key_fails_before_download() {
        let (_temporary, operation, _preferences) = fixture(ApplicationUpdateMode::Automatic);
        let source = FakePayloadSource {
            bytes: b"test".to_vec(),
            calls: AtomicUsize::new(0),
        };
        let mut selection =
            authenticated(CandidateState::UpdateAvailable, Some(candidate(b"test")));
        selection.payload_key = None;
        assert!(matches!(
            operation
                .check_and_stage(
                    environment(),
                    &checker(selection),
                    &source,
                    &NoopApplicationUpdateProgressSink,
                    &CancellationToken::new(),
                )
                .await,
            Err(ApplicationUpdateOperationError::InvalidSelection(_))
        ));
        assert_eq!(source.calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn payload_failure_records_bounded_retry_without_daily_success() {
        let (temporary, operation, _preferences) = fixture(ApplicationUpdateMode::Automatic);
        assert!(matches!(
            operation
                .check_and_stage(
                    environment(),
                    &checker(authenticated(
                        CandidateState::UpdateAvailable,
                        Some(candidate(b"test")),
                    )),
                    &FailingPayloadSource,
                    &NoopApplicationUpdateProgressSink,
                    &CancellationToken::new(),
                )
                .await,
            Err(ApplicationUpdateOperationError::Download(
                PayloadDownloadError::Network(_)
            ))
        ));
        let schedule = ApplicationUpdateScheduleStore::new(temporary.path().join("schedule.json"))
            .unwrap()
            .load()
            .unwrap();
        assert_eq!(schedule.last_success_unix_seconds, None);
        assert_eq!(schedule.consecutive_failures, 1);
        assert!(schedule.next_automatic_check_unix_seconds.unwrap() < 2_000 + 24 * 60 * 60);
    }

    #[tokio::test]
    async fn precancelled_operation_has_no_check_or_staging_side_effect() {
        let (_temporary, operation, _preferences) = fixture(ApplicationUpdateMode::Automatic);
        let source = FakePayloadSource {
            bytes: b"test".to_vec(),
            calls: AtomicUsize::new(0),
        };
        let cancellation = CancellationToken::new();
        cancellation.cancel();
        assert!(matches!(
            operation
                .check_and_stage(
                    environment(),
                    &checker(authenticated(
                        CandidateState::UpdateAvailable,
                        Some(candidate(b"test")),
                    )),
                    &source,
                    &NoopApplicationUpdateProgressSink,
                    &cancellation,
                )
                .await,
            Err(ApplicationUpdateOperationError::Cancelled)
        ));
        assert_eq!(source.calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn cancellation_during_staging_leaves_only_reconcilable_state() {
        let (temporary, operation, _preferences) = fixture(ApplicationUpdateMode::Automatic);
        let (_writer, reader) = tokio::io::duplex(4);
        let source = Arc::new(HangingPayloadSource {
            reader: Mutex::new(Some(reader)),
        });
        let checker = Arc::new(checker(authenticated(
            CandidateState::UpdateAvailable,
            Some(candidate(b"test")),
        )));
        let cancellation = CancellationToken::new();
        let task_cancellation = cancellation.clone();
        let operation = Arc::new(operation);
        let task_operation = operation.clone();
        let task_source = source.clone();
        let task = tokio::spawn(async move {
            task_operation
                .check_and_stage(
                    environment(),
                    checker.as_ref(),
                    task_source.as_ref(),
                    &NoopApplicationUpdateProgressSink,
                    &task_cancellation,
                )
                .await
        });
        let journal = temporary.path().join("staging/staging.json");
        for _ in 0..100 {
            if journal.exists() {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert!(journal.exists());
        cancellation.cancel();
        assert!(matches!(
            task.await.unwrap(),
            Err(ApplicationUpdateOperationError::Cancelled)
        ));

        let schedule = ApplicationUpdateScheduleStore::new(temporary.path().join("schedule.json"))
            .unwrap()
            .load()
            .unwrap();
        assert_eq!(schedule, Default::default());

        let restarted =
            ApplicationUpdateStagingStore::new(temporary.path().join("staging")).unwrap();
        assert_eq!(restarted.reconcile().await.unwrap(), None);
        assert!(
            !temporary
                .path()
                .join("staging/.candidate.payload.incoming")
                .exists()
        );
    }
}
