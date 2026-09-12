//! Durable host intent for applying an already verified application update.
//!
//! This journal distinguishes safe exit requests from process termination. It
//! never replaces application files and never turns retained metadata into
//! fresh trust, eligibility, consent, ownership, or permission authority.

use std::collections::BTreeSet;
use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use fs2::FileExt;
use serde::{Deserialize, Serialize};

use crate::application_update::{
    InstallOwner, InstalledApplicationContext, SelectedCandidate, UpdateMetadataError,
    validate_selected_candidate_for_context,
};
use crate::application_update_preferences::{
    ApplicationUpdateChoice, ApplicationUpdateMode, ApplicationUpdatePreferences,
    validate_preferences,
};
use crate::application_update_staging::StagedApplicationUpdate;
use crate::application_update_storage::write_bytes_atomically;

const APPLY_SCHEMA_VERSION: u32 = 1;
const MAX_APPLY_STATE_BYTES: u64 = 512 * 1024;
const APPLY_FILE: &str = "apply.json";
const APPLY_TEMP_FILE: &str = ".apply.json.tmp";
const APPLY_LOCK_FILE: &str = ".apply.lock";

static ACTIVE_APPLY_ROOTS: OnceLock<Mutex<BTreeSet<PathBuf>>> = OnceLock::new();

#[derive(Debug, thiserror::Error)]
pub enum ApplicationUpdateApplyError {
    #[error("application update apply intent is already being changed")]
    Busy,
    #[error("application update apply path is invalid: {0}")]
    InvalidPath(String),
    #[error("application update apply state is invalid: {0}")]
    InvalidState(String),
    #[error("application update apply schema {0} is unsupported")]
    UnsupportedSchema(u32),
    #[error("application update apply state changed from revision {expected} to {actual}")]
    RevisionConflict { expected: u64, actual: u64 },
    #[error("a different application update apply intent already exists")]
    IntentConflict,
    #[error(transparent)]
    Metadata(#[from] UpdateMetadataError),
    #[error("application update library admission failed: {0}")]
    Library(#[from] portcove_core::PortcoveError),
    #[error("application update apply I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("application update apply serialization failed: {0}")]
    Serialization(#[from] serde_json::Error),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ApplicationUpdateApplyRequest {
    SafeExit,
    RestartToApply,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ApplicationTerminationKind {
    NormalExit,
    RestartToApply,
    Crash,
    OsShutdown,
    SteamStop,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ApplicationUpdateApplyIntent {
    pub preference_revision: u64,
    pub preference_choice: ApplicationUpdateChoice,
    pub request: ApplicationUpdateApplyRequest,
    pub candidate: SelectedCandidate,
    pub installed: InstalledApplicationContext,
    pub library_root: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ApplicationUpdateApplyState {
    pub schema_version: u32,
    pub revision: u64,
    pub intent: Option<ApplicationUpdateApplyIntent>,
    pub termination: Option<ApplicationTerminationKind>,
}

impl Default for ApplicationUpdateApplyState {
    fn default() -> Self {
        Self {
            schema_version: APPLY_SCHEMA_VERSION,
            revision: 0,
            intent: None,
            termination: None,
        }
    }
}

impl ApplicationUpdateApplyState {
    /// True only when an observed host action matches the persisted request.
    /// The caller must still revalidate every authority before replacement.
    pub fn may_attempt_revalidation(&self) -> bool {
        matches!(
            (
                self.intent.as_ref().map(|intent| intent.request),
                self.termination
            ),
            (
                Some(ApplicationUpdateApplyRequest::SafeExit),
                Some(ApplicationTerminationKind::NormalExit)
            ) | (
                Some(ApplicationUpdateApplyRequest::RestartToApply),
                Some(ApplicationTerminationKind::RestartToApply)
            )
        )
    }
}

#[derive(Debug, Clone)]
pub struct ApplicationUpdateApplyStore {
    root: PathBuf,
}

struct ProcessApplyLock {
    root: PathBuf,
}

impl Drop for ProcessApplyLock {
    fn drop(&mut self) {
        if let Ok(mut active) = ACTIVE_APPLY_ROOTS
            .get_or_init(|| Mutex::new(BTreeSet::new()))
            .lock()
        {
            active.remove(&self.root);
        }
    }
}

struct ApplyLock {
    file: File,
    _process: ProcessApplyLock,
}

impl Drop for ApplyLock {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.file);
    }
}

impl ApplicationUpdateApplyStore {
    pub fn default_root() -> Result<PathBuf, ApplicationUpdateApplyError> {
        crate::application_update_staging::ApplicationUpdateStagingStore::default_root()
            .map_err(|error| ApplicationUpdateApplyError::InvalidPath(error.to_string()))
    }

    pub fn new(root: PathBuf) -> Result<Self, ApplicationUpdateApplyError> {
        validate_root(&root)?;
        Ok(Self { root })
    }

    pub fn load(&self) -> Result<ApplicationUpdateApplyState, ApplicationUpdateApplyError> {
        let path = self.root.join(APPLY_FILE);
        refuse_symlink_ancestors(&path)?;
        let metadata = match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(ApplicationUpdateApplyState::default());
            }
            Err(error) => return Err(error.into()),
            Ok(metadata) => metadata,
        };
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || metadata.len() == 0
            || metadata.len() > MAX_APPLY_STATE_BYTES
        {
            return Err(ApplicationUpdateApplyError::InvalidState(
                "apply state is not a bounded direct file".into(),
            ));
        }
        let bytes = fs::read(path)?;
        if bytes.is_empty() || bytes.len() as u64 > MAX_APPLY_STATE_BYTES {
            return Err(ApplicationUpdateApplyError::InvalidState(
                "apply state changed size while being read".into(),
            ));
        }
        let state: ApplicationUpdateApplyState = serde_json::from_slice(&bytes)
            .map_err(|error| ApplicationUpdateApplyError::InvalidState(error.to_string()))?;
        validate_state(&state)?;
        Ok(state)
    }

    pub fn prepare(
        &self,
        preferences: &ApplicationUpdatePreferences,
        staged: &StagedApplicationUpdate,
        installed: &InstalledApplicationContext,
        library_root: &Path,
        request: ApplicationUpdateApplyRequest,
    ) -> Result<ApplicationUpdateApplyState, ApplicationUpdateApplyError> {
        validate_preferences(preferences)
            .map_err(|error| ApplicationUpdateApplyError::InvalidState(error.to_string()))?;
        let choice = preferences.choice.clone().ok_or_else(|| {
            ApplicationUpdateApplyError::InvalidState(
                "application update consent has not been recorded".into(),
            )
        })?;
        validate_prepare_policy(preferences.revision, &choice, request)?;
        validate_selected_candidate_for_context(&staged.candidate, choice.channel, installed)?;
        if installed.install_owner != InstallOwner::Portcove
            || staged.candidate.release.package.owner != InstallOwner::Portcove
        {
            return Err(ApplicationUpdateApplyError::InvalidState(
                "only a Portcove-owned application installation can be replaced".into(),
            ));
        }
        let library_root = portcove_core::Library::validate_selection_target(library_root)?;
        let intent = ApplicationUpdateApplyIntent {
            preference_revision: preferences.revision,
            preference_choice: choice,
            request,
            candidate: staged.candidate.clone(),
            installed: installed.clone(),
            library_root,
        };
        validate_intent(&intent)?;

        let _lock = self.lock()?;
        let mut state = self.load()?;
        if state.intent.as_ref() == Some(&intent) && state.termination.is_none() {
            return Ok(state);
        }
        if state.intent.is_some() {
            return Err(ApplicationUpdateApplyError::IntentConflict);
        }
        state.revision = next_revision(state.revision)?;
        state.intent = Some(intent);
        state.termination = None;
        self.publish(&state)?;
        Ok(state)
    }

    pub fn record_termination(
        &self,
        expected_revision: u64,
        termination: ApplicationTerminationKind,
    ) -> Result<ApplicationUpdateApplyState, ApplicationUpdateApplyError> {
        let _lock = self.lock()?;
        let mut state = self.load()?;
        require_revision(&state, expected_revision)?;
        if state.intent.is_none() {
            return Err(ApplicationUpdateApplyError::InvalidState(
                "no application update apply intent exists".into(),
            ));
        }
        if state.termination == Some(termination) {
            return Ok(state);
        }
        if state.termination.is_some() {
            return Err(ApplicationUpdateApplyError::IntentConflict);
        }
        state.revision = next_revision(state.revision)?;
        state.termination = Some(termination);
        self.publish(&state)?;
        Ok(state)
    }

    pub fn clear(
        &self,
        expected_revision: u64,
    ) -> Result<ApplicationUpdateApplyState, ApplicationUpdateApplyError> {
        let _lock = self.lock()?;
        let mut state = self.load()?;
        require_revision(&state, expected_revision)?;
        state.revision = next_revision(state.revision)?;
        state.intent = None;
        state.termination = None;
        self.publish(&state)?;
        Ok(state)
    }

    /// Explicit recovery clears corrupt or future apply state without touching
    /// the staged payload or granting permission to retry it.
    pub fn recover(&self) -> Result<ApplicationUpdateApplyState, ApplicationUpdateApplyError> {
        let _lock = self.lock()?;
        let revision = match self.load() {
            Ok(state) => next_revision(state.revision)?,
            Err(ApplicationUpdateApplyError::InvalidState(_))
            | Err(ApplicationUpdateApplyError::UnsupportedSchema(_)) => {
                next_revision(self.recovery_revision())?
            }
            Err(error) => return Err(error),
        };
        let state = ApplicationUpdateApplyState {
            revision,
            ..ApplicationUpdateApplyState::default()
        };
        self.publish(&state)?;
        Ok(state)
    }

    fn recovery_revision(&self) -> u64 {
        fs::read(self.root.join(APPLY_FILE))
            .ok()
            .filter(|bytes| !bytes.is_empty() && bytes.len() as u64 <= MAX_APPLY_STATE_BYTES)
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
            .and_then(|document| document.get("revision").and_then(serde_json::Value::as_u64))
            .unwrap_or(0)
    }

    fn publish(
        &self,
        state: &ApplicationUpdateApplyState,
    ) -> Result<(), ApplicationUpdateApplyError> {
        validate_state(state)?;
        let mut bytes = serde_json::to_vec_pretty(state)?;
        bytes.push(b'\n');
        if bytes.len() as u64 > MAX_APPLY_STATE_BYTES {
            return Err(ApplicationUpdateApplyError::InvalidState(
                "serialized apply state exceeds its limit".into(),
            ));
        }
        write_bytes_atomically(&self.root, APPLY_TEMP_FILE, APPLY_FILE, &bytes)?;
        Ok(())
    }

    fn lock(&self) -> Result<ApplyLock, ApplicationUpdateApplyError> {
        refuse_symlink_ancestors(&self.root)?;
        fs::create_dir_all(&self.root)?;
        refuse_symlink_ancestors(&self.root)?;
        if !fs::symlink_metadata(&self.root)?.is_dir() {
            return Err(ApplicationUpdateApplyError::InvalidPath(
                "apply root is not a directory".into(),
            ));
        }
        let canonical = fs::canonicalize(&self.root)?;
        let process = acquire_process_lock(canonical)?;
        let path = self.root.join(APPLY_LOCK_FILE);
        refuse_symlink_ancestors(&path)?;
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(path)?;
        match file.try_lock_exclusive() {
            Ok(()) => Ok(ApplyLock {
                file,
                _process: process,
            }),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                Err(ApplicationUpdateApplyError::Busy)
            }
            Err(error) => Err(error.into()),
        }
    }
}

fn validate_prepare_policy(
    revision: u64,
    choice: &ApplicationUpdateChoice,
    request: ApplicationUpdateApplyRequest,
) -> Result<(), ApplicationUpdateApplyError> {
    if revision == 0 {
        return Err(ApplicationUpdateApplyError::InvalidState(
            "application update preference revision is invalid".into(),
        ));
    }
    if request == ApplicationUpdateApplyRequest::SafeExit
        && (choice.mode != ApplicationUpdateMode::Automatic || choice.paused)
    {
        return Err(ApplicationUpdateApplyError::InvalidState(
            "safe-exit application requires active automatic update consent".into(),
        ));
    }
    Ok(())
}

fn validate_state(state: &ApplicationUpdateApplyState) -> Result<(), ApplicationUpdateApplyError> {
    if state.schema_version != APPLY_SCHEMA_VERSION {
        return Err(ApplicationUpdateApplyError::UnsupportedSchema(
            state.schema_version,
        ));
    }
    if state.termination.is_some() && state.intent.is_none() {
        return Err(ApplicationUpdateApplyError::InvalidState(
            "termination exists without an apply intent".into(),
        ));
    }
    if let Some(intent) = &state.intent {
        if state.revision == 0 {
            return Err(ApplicationUpdateApplyError::InvalidState(
                "apply intent exists at revision zero".into(),
            ));
        }
        validate_intent(intent)?;
    }
    Ok(())
}

fn validate_intent(
    intent: &ApplicationUpdateApplyIntent,
) -> Result<(), ApplicationUpdateApplyError> {
    validate_prepare_policy(
        intent.preference_revision,
        &intent.preference_choice,
        intent.request,
    )?;
    validate_selected_candidate_for_context(
        &intent.candidate,
        intent.preference_choice.channel,
        &intent.installed,
    )?;
    if intent.installed.install_owner != InstallOwner::Portcove
        || intent.candidate.release.package.owner != InstallOwner::Portcove
    {
        return Err(ApplicationUpdateApplyError::InvalidState(
            "apply intent does not describe a Portcove-owned installation".into(),
        ));
    }
    validate_library_path(&intent.library_root)
}

fn require_revision(
    state: &ApplicationUpdateApplyState,
    expected: u64,
) -> Result<(), ApplicationUpdateApplyError> {
    if state.revision != expected {
        return Err(ApplicationUpdateApplyError::RevisionConflict {
            expected,
            actual: state.revision,
        });
    }
    Ok(())
}

fn next_revision(revision: u64) -> Result<u64, ApplicationUpdateApplyError> {
    revision.checked_add(1).ok_or_else(|| {
        ApplicationUpdateApplyError::InvalidState("apply state revision is exhausted".into())
    })
}

fn acquire_process_lock(root: PathBuf) -> Result<ProcessApplyLock, ApplicationUpdateApplyError> {
    let mut active = ACTIVE_APPLY_ROOTS
        .get_or_init(|| Mutex::new(BTreeSet::new()))
        .lock()
        .map_err(|_| {
            ApplicationUpdateApplyError::InvalidState("apply lock registry was poisoned".into())
        })?;
    if !active.insert(root.clone()) {
        return Err(ApplicationUpdateApplyError::Busy);
    }
    Ok(ProcessApplyLock { root })
}

fn validate_root(root: &Path) -> Result<(), ApplicationUpdateApplyError> {
    if !root.is_absolute()
        || root.file_name().is_none()
        || root
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(ApplicationUpdateApplyError::InvalidPath(
            "apply root must be absolute and contain no parent traversal".into(),
        ));
    }
    Ok(())
}

fn validate_library_path(path: &Path) -> Result<(), ApplicationUpdateApplyError> {
    if !path.is_absolute()
        || path.parent().is_none()
        || path
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(ApplicationUpdateApplyError::InvalidPath(
            "library root must be absolute and contain no parent traversal".into(),
        ));
    }
    Ok(())
}

fn refuse_symlink_ancestors(path: &Path) -> Result<(), ApplicationUpdateApplyError> {
    let mut current = Some(path);
    while let Some(candidate) = current {
        match fs::symlink_metadata(candidate) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(ApplicationUpdateApplyError::InvalidPath(format!(
                    "path contains a symbolic link: {}",
                    candidate.display()
                )));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        current = candidate.parent();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use sha2::{Digest, Sha256};

    use super::*;
    use crate::application_update::{
        ApplicationChannel, AuthenticatedRecordPair, CandidateState, select_authenticated_candidate,
    };

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

    fn candidate(version: &str, channel: ApplicationChannel) -> SelectedCandidate {
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
                "sha256": "c".repeat(64),
                "bytes": 1024,
                "tauri_signature": "fixture-signature",
                "payload_key_id": "d".repeat(64)
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
            "channel": channel,
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
        let selection = select_authenticated_candidate(
            &[AuthenticatedRecordPair {
                release_path: &release_path,
                release_bytes: &release_bytes,
                promotion_bytes: &promotion_bytes,
            }],
            channel,
            &installed("0.1.0"),
        )
        .unwrap();
        assert_eq!(selection.state, CandidateState::UpdateAvailable);
        selection.candidate.unwrap()
    }

    fn preferences(mode: ApplicationUpdateMode, paused: bool) -> ApplicationUpdatePreferences {
        ApplicationUpdatePreferences {
            schema_version: 1,
            revision: 1,
            choice: Some(ApplicationUpdateChoice {
                channel: ApplicationChannel::Preview,
                mode,
                paused,
            }),
        }
    }

    fn staged(candidate: SelectedCandidate, root: &Path) -> StagedApplicationUpdate {
        StagedApplicationUpdate {
            candidate,
            payload_path: root.join("candidate.payload"),
        }
    }

    fn library_root(temporary: &tempfile::TempDir) -> PathBuf {
        let root = temporary.path().join("library");
        drop(portcove_core::Library::open(&root).unwrap());
        root
    }

    #[test]
    fn safe_exit_intent_survives_restart_and_requires_matching_normal_exit() {
        let temporary = tempfile::tempdir().unwrap();
        let store = ApplicationUpdateApplyStore::new(temporary.path().join("updates")).unwrap();
        let library = library_root(&temporary);
        let staged = staged(
            candidate("0.2.0-beta.1", ApplicationChannel::Preview),
            temporary.path(),
        );
        let prepared = store
            .prepare(
                &preferences(ApplicationUpdateMode::Automatic, false),
                &staged,
                &installed("0.1.0"),
                &library,
                ApplicationUpdateApplyRequest::SafeExit,
            )
            .unwrap();
        assert_eq!(prepared.revision, 1);
        assert!(!prepared.may_attempt_revalidation());
        assert_eq!(store.load().unwrap(), prepared);

        let exited = store
            .record_termination(prepared.revision, ApplicationTerminationKind::NormalExit)
            .unwrap();
        assert_eq!(exited.revision, 2);
        assert!(exited.may_attempt_revalidation());
        let restarted = ApplicationUpdateApplyStore::new(store.root.clone()).unwrap();
        assert_eq!(restarted.load().unwrap(), exited);
    }

    #[test]
    fn killed_or_unmatched_termination_never_authorizes_an_apply_attempt() {
        for termination in [
            ApplicationTerminationKind::Crash,
            ApplicationTerminationKind::OsShutdown,
            ApplicationTerminationKind::SteamStop,
            ApplicationTerminationKind::RestartToApply,
        ] {
            let temporary = tempfile::tempdir().unwrap();
            let store = ApplicationUpdateApplyStore::new(temporary.path().join("updates")).unwrap();
            let prepared = store
                .prepare(
                    &preferences(ApplicationUpdateMode::Automatic, false),
                    &staged(
                        candidate("0.2.0-beta.1", ApplicationChannel::Preview),
                        temporary.path(),
                    ),
                    &installed("0.1.0"),
                    &library_root(&temporary),
                    ApplicationUpdateApplyRequest::SafeExit,
                )
                .unwrap();
            let observed = store
                .record_termination(prepared.revision, termination)
                .unwrap();
            assert!(!observed.may_attempt_revalidation());
        }
    }

    #[test]
    fn explicit_restart_is_separate_from_automatic_exit_policy() {
        let temporary = tempfile::tempdir().unwrap();
        let library = library_root(&temporary);
        let staged = staged(
            candidate("0.2.0-beta.1", ApplicationChannel::Preview),
            temporary.path(),
        );
        let automatic =
            ApplicationUpdateApplyStore::new(temporary.path().join("automatic")).unwrap();
        assert!(
            automatic
                .prepare(
                    &preferences(ApplicationUpdateMode::Manual, true),
                    &staged,
                    &installed("0.1.0"),
                    &library,
                    ApplicationUpdateApplyRequest::SafeExit,
                )
                .is_err()
        );

        let explicit = ApplicationUpdateApplyStore::new(temporary.path().join("explicit")).unwrap();
        let prepared = explicit
            .prepare(
                &preferences(ApplicationUpdateMode::Manual, true),
                &staged,
                &installed("0.1.0"),
                &library,
                ApplicationUpdateApplyRequest::RestartToApply,
            )
            .unwrap();
        let observed = explicit
            .record_termination(
                prepared.revision,
                ApplicationTerminationKind::RestartToApply,
            )
            .unwrap();
        assert!(observed.may_attempt_revalidation());
    }

    #[test]
    fn ownership_channel_and_installed_version_are_rechecked_before_persistence() {
        let temporary = tempfile::tempdir().unwrap();
        let library = library_root(&temporary);
        let store = ApplicationUpdateApplyStore::new(temporary.path().join("updates")).unwrap();
        let preview = staged(
            candidate("0.2.0-beta.1", ApplicationChannel::Preview),
            temporary.path(),
        );
        let mut stable_preferences = preferences(ApplicationUpdateMode::Automatic, false);
        stable_preferences.choice.as_mut().unwrap().channel = ApplicationChannel::Stable;
        assert!(
            store
                .prepare(
                    &stable_preferences,
                    &preview,
                    &installed("0.1.0"),
                    &library,
                    ApplicationUpdateApplyRequest::SafeExit,
                )
                .is_err()
        );
        assert!(
            store
                .prepare(
                    &preferences(ApplicationUpdateMode::Automatic, false),
                    &preview,
                    &installed("0.2.0-beta.1"),
                    &library,
                    ApplicationUpdateApplyRequest::SafeExit,
                )
                .is_err()
        );

        let mut foreign_candidate = preview.clone();
        foreign_candidate.candidate.release.package.owner = InstallOwner::PackageManager;
        let mut foreign_context = installed("0.1.0");
        foreign_context.install_owner = InstallOwner::PackageManager;
        assert!(matches!(
            store.prepare(
                &preferences(ApplicationUpdateMode::Automatic, false),
                &foreign_candidate,
                &foreign_context,
                &library,
                ApplicationUpdateApplyRequest::SafeExit,
            ),
            Err(ApplicationUpdateApplyError::InvalidState(message))
                if message.contains("Portcove-owned")
        ));
        assert_eq!(
            store.load().unwrap(),
            ApplicationUpdateApplyState::default()
        );
    }

    #[test]
    fn intents_are_immutable_revision_bound_and_explicitly_recoverable() {
        let temporary = tempfile::tempdir().unwrap();
        let store = ApplicationUpdateApplyStore::new(temporary.path().join("updates")).unwrap();
        let library = library_root(&temporary);
        let first = store
            .prepare(
                &preferences(ApplicationUpdateMode::Automatic, false),
                &staged(
                    candidate("0.2.0-beta.1", ApplicationChannel::Preview),
                    temporary.path(),
                ),
                &installed("0.1.0"),
                &library,
                ApplicationUpdateApplyRequest::SafeExit,
            )
            .unwrap();
        assert!(matches!(
            store.record_termination(0, ApplicationTerminationKind::NormalExit),
            Err(ApplicationUpdateApplyError::RevisionConflict { .. })
        ));
        assert!(matches!(
            store.prepare(
                &preferences(ApplicationUpdateMode::Automatic, false),
                &staged(
                    candidate("0.2.0-beta.2", ApplicationChannel::Preview),
                    temporary.path(),
                ),
                &installed("0.1.0"),
                &library,
                ApplicationUpdateApplyRequest::SafeExit,
            ),
            Err(ApplicationUpdateApplyError::IntentConflict)
        ));
        let cleared = store.clear(first.revision).unwrap();
        assert!(cleared.intent.is_none());

        fs::write(
            store.root.join(APPLY_FILE),
            br#"{"schema_version":99,"revision":8,"intent":null,"termination":null}"#,
        )
        .unwrap();
        assert!(matches!(
            store.load(),
            Err(ApplicationUpdateApplyError::UnsupportedSchema(99))
        ));
        let recovered = store.recover().unwrap();
        assert_eq!(recovered.revision, 9);
        assert!(recovered.intent.is_none());
    }
}
