//! Private, bounded staging for already selected application updates.
//!
//! The same payload stream is copied and verified before publication. This
//! module records staged identity only; it cannot download or apply an update.

use std::collections::BTreeSet;
use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};

use crate::application_update::{
    SelectedCandidate, UpdateMetadataError, validate_selected_candidate,
};
use crate::application_update_payload::{
    PayloadVerificationError, PayloadVerificationKey, verify_payload_to_writer,
};
use crate::application_update_storage::{replace_file_atomically, write_bytes_atomically};

const STAGING_SCHEMA_VERSION: u32 = 1;
const MAX_JOURNAL_BYTES: u64 = 512 * 1024;
const JOURNAL_FILE: &str = "staging.json";
const JOURNAL_TEMP_FILE: &str = ".staging.json.tmp";
const ACTIVE_PAYLOAD_FILE: &str = "candidate.payload";
const INCOMING_PAYLOAD_FILE: &str = ".candidate.payload.incoming";
const LOCK_FILE: &str = ".staging.lock";

static ACTIVE_STAGING_ROOTS: OnceLock<Mutex<BTreeSet<PathBuf>>> = OnceLock::new();

#[derive(Debug, thiserror::Error)]
pub enum ApplicationUpdateStagingError {
    #[error("application update staging is already active")]
    Busy,
    #[error("application update staging path is invalid: {0}")]
    InvalidPath(String),
    #[error("application update staging state is invalid: {0}")]
    InvalidState(String),
    #[error("application update staging schema {0} is unsupported")]
    UnsupportedSchema(u32),
    #[error(
        "application update staging needs {required} free bytes but only {available} are available"
    )]
    InsufficientSpace { required: u64, available: u64 },
    #[error(transparent)]
    Metadata(#[from] UpdateMetadataError),
    #[error(transparent)]
    Verification(#[from] PayloadVerificationError),
    #[error("application update staging I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("application update staging serialization failed: {0}")]
    Serialization(#[from] serde_json::Error),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StagedApplicationUpdate {
    pub candidate: SelectedCandidate,
    pub payload_path: PathBuf,
}

pub(crate) struct ApplicationUpdateStagingSnapshot {
    staged: StagedApplicationUpdate,
    _lock: StagingLock,
}

impl ApplicationUpdateStagingSnapshot {
    pub(crate) fn staged(&self) -> &StagedApplicationUpdate {
        &self.staged
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum StagingPhase {
    Empty,
    Staged,
    PayloadVerified,
    Verified,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StagingJournal {
    schema_version: u32,
    phase: StagingPhase,
    candidate: Option<SelectedCandidate>,
    previous_candidate: Option<SelectedCandidate>,
}

impl StagingJournal {
    fn empty() -> Self {
        Self {
            schema_version: STAGING_SCHEMA_VERSION,
            phase: StagingPhase::Empty,
            candidate: None,
            previous_candidate: None,
        }
    }

    fn staged(candidate: SelectedCandidate, previous: Option<SelectedCandidate>) -> Self {
        Self {
            schema_version: STAGING_SCHEMA_VERSION,
            phase: StagingPhase::Staged,
            candidate: Some(candidate),
            previous_candidate: previous,
        }
    }

    fn verified(candidate: SelectedCandidate) -> Self {
        Self {
            schema_version: STAGING_SCHEMA_VERSION,
            phase: StagingPhase::Verified,
            candidate: Some(candidate),
            previous_candidate: None,
        }
    }

    fn payload_verified(candidate: SelectedCandidate, previous: Option<SelectedCandidate>) -> Self {
        Self {
            schema_version: STAGING_SCHEMA_VERSION,
            phase: StagingPhase::PayloadVerified,
            candidate: Some(candidate),
            previous_candidate: previous,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ApplicationUpdateStagingStore {
    root: PathBuf,
}

struct ProcessStagingLock {
    root: PathBuf,
}

impl Drop for ProcessStagingLock {
    fn drop(&mut self) {
        if let Ok(mut active) = ACTIVE_STAGING_ROOTS
            .get_or_init(|| Mutex::new(BTreeSet::new()))
            .lock()
        {
            active.remove(&self.root);
        }
    }
}

struct StagingLock {
    file: File,
    _process: ProcessStagingLock,
}

impl Drop for StagingLock {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.file);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PayloadStatus {
    Missing,
    Matches,
    Mismatch,
}

impl ApplicationUpdateStagingStore {
    pub fn default_root() -> Result<PathBuf, ApplicationUpdateStagingError> {
        let preferences =
            crate::application_update_preferences::ApplicationUpdatePreferenceStore::default_path()
                .map_err(|error| ApplicationUpdateStagingError::InvalidPath(error.to_string()))?;
        Ok(preferences.with_file_name("application-update"))
    }

    pub fn open_configured() -> Result<Self, ApplicationUpdateStagingError> {
        let root = std::env::var_os("PORTCOVE_APPLICATION_UPDATE_STAGING")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .map(Ok)
            .unwrap_or_else(Self::default_root)?;
        Self::new(root)
    }

    pub fn new(root: PathBuf) -> Result<Self, ApplicationUpdateStagingError> {
        validate_root(&root)?;
        Ok(Self { root })
    }

    pub fn payload_path(&self) -> PathBuf {
        self.root.join(ACTIVE_PAYLOAD_FILE)
    }

    /// Reconciles an interrupted staging attempt without granting application
    /// authority. A verified result still requires fresh trust and eligibility
    /// checks immediately before apply.
    pub async fn reconcile(
        &self,
    ) -> Result<Option<StagedApplicationUpdate>, ApplicationUpdateStagingError> {
        let _lock = self.lock()?;
        self.reconcile_locked().await
    }

    /// Reads presentation state without creating an empty staging directory.
    /// Existing journal or payload slots still receive normal restart reconciliation.
    pub(crate) async fn status(
        &self,
    ) -> Result<Option<StagedApplicationUpdate>, ApplicationUpdateStagingError> {
        let metadata = match fs::symlink_metadata(&self.root) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
            Ok(metadata) => metadata,
        };
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(ApplicationUpdateStagingError::InvalidPath(
                "staging root is not a direct directory".into(),
            ));
        }
        let mut has_state = false;
        for name in [JOURNAL_FILE, ACTIVE_PAYLOAD_FILE, INCOMING_PAYLOAD_FILE] {
            match fs::symlink_metadata(self.root.join(name)) {
                Ok(_) => has_state = true,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        if !has_state {
            return Ok(None);
        }
        self.reconcile().await
    }

    pub(crate) async fn snapshot(
        &self,
    ) -> Result<Option<ApplicationUpdateStagingSnapshot>, ApplicationUpdateStagingError> {
        let lock = self.lock()?;
        Ok(self
            .reconcile_locked()
            .await?
            .map(|staged| ApplicationUpdateStagingSnapshot {
                staged,
                _lock: lock,
            }))
    }

    /// Copies and verifies one selected candidate into the private staging
    /// slot. The caller owns payload acquisition; URLs and keys never cross IPC.
    pub async fn stage<R: AsyncRead + Unpin>(
        &self,
        reader: &mut R,
        candidate: &SelectedCandidate,
        key: &PayloadVerificationKey,
    ) -> Result<StagedApplicationUpdate, ApplicationUpdateStagingError> {
        validate_selected_candidate(candidate)?;
        let _lock = self.lock()?;
        let previous = self.reconcile_locked().await?;
        let required = required_staging_bytes(candidate.release.artifact.bytes)?;
        let available = fs2::available_space(&self.root)?;
        if available < required {
            return Err(ApplicationUpdateStagingError::InsufficientSpace {
                required,
                available,
            });
        }

        remove_direct_file(&self.root.join(INCOMING_PAYLOAD_FILE))?;
        let staged = StagingJournal::staged(
            candidate.clone(),
            previous.as_ref().map(|value| value.candidate.clone()),
        );
        self.write_journal(&staged)?;

        let incoming_path = self.root.join(INCOMING_PAYLOAD_FILE);
        let mut incoming = match tokio::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&incoming_path)
            .await
        {
            Ok(file) => file,
            Err(error) => {
                self.restore_previous(previous.as_ref())?;
                return Err(error.into());
            }
        };
        let identity =
            match verify_payload_to_writer(reader, &mut incoming, &candidate.release.artifact, key)
                .await
            {
                Ok(identity) => identity,
                Err(error) => {
                    drop(incoming);
                    let _ = remove_direct_file(&incoming_path);
                    self.restore_previous(previous.as_ref())?;
                    return Err(error.into());
                }
            };
        if let Err(error) = async {
            incoming.flush().await?;
            incoming.sync_all().await
        }
        .await
        {
            drop(incoming);
            let _ = remove_direct_file(&incoming_path);
            self.restore_previous(previous.as_ref())?;
            return Err(error.into());
        }
        if identity.bytes != candidate.release.artifact.bytes
            || identity.sha256 != candidate.release.artifact.sha256
            || identity.payload_key_id != candidate.release.artifact.payload_key_id
        {
            drop(incoming);
            let _ = remove_direct_file(&incoming_path);
            self.restore_previous(previous.as_ref())?;
            return Err(ApplicationUpdateStagingError::InvalidState(
                "verified payload identity changed before publication".into(),
            ));
        }
        self.write_journal(&StagingJournal::payload_verified(
            candidate.clone(),
            previous.as_ref().map(|value| value.candidate.clone()),
        ))?;
        drop(incoming);
        if let Err(error) =
            replace_file_atomically(&self.root, INCOMING_PAYLOAD_FILE, ACTIVE_PAYLOAD_FILE)
        {
            // The platform replacement can report a durability error after the
            // rename has happened. Keep the payload-verified journal so restart
            // reconciliation can inspect both fixed slots and finish safely.
            return Err(error.into());
        }
        let journal = StagingJournal::verified(candidate.clone());
        self.write_journal(&journal)?;
        Ok(StagedApplicationUpdate {
            candidate: candidate.clone(),
            payload_path: self.payload_path(),
        })
    }

    /// Explicitly clears only the fixed application-update staging files.
    pub fn reset(&self) -> Result<(), ApplicationUpdateStagingError> {
        let _lock = self.lock()?;
        self.clear_locked()
    }

    /// Repairs malformed or future state only while it is still invalid.
    /// A stale recovery action cannot discard a candidate another process repaired.
    pub async fn recover_invalid(&self) -> Result<(), ApplicationUpdateStagingError> {
        let _lock = self.lock()?;
        match self.reconcile_locked().await {
            Ok(_) => Err(ApplicationUpdateStagingError::InvalidState(
                "staging state no longer requires recovery".into(),
            )),
            Err(ApplicationUpdateStagingError::InvalidState(_))
            | Err(ApplicationUpdateStagingError::UnsupportedSchema(_)) => self.clear_locked(),
            Err(error) => Err(error),
        }
    }

    fn clear_locked(&self) -> Result<(), ApplicationUpdateStagingError> {
        for path in [
            self.root.join(INCOMING_PAYLOAD_FILE),
            self.root.join(ACTIVE_PAYLOAD_FILE),
        ] {
            remove_direct_file(&path)?;
        }
        self.write_journal(&StagingJournal::empty())
    }

    async fn reconcile_locked(
        &self,
    ) -> Result<Option<StagedApplicationUpdate>, ApplicationUpdateStagingError> {
        let Some(journal) = self.read_journal()? else {
            remove_direct_file(&self.root.join(INCOMING_PAYLOAD_FILE))?;
            remove_direct_file(&self.root.join(ACTIVE_PAYLOAD_FILE))?;
            return Ok(None);
        };
        validate_journal(&journal)?;
        match journal.phase {
            StagingPhase::Empty => {
                remove_direct_file(&self.root.join(INCOMING_PAYLOAD_FILE))?;
                remove_direct_file(&self.root.join(ACTIVE_PAYLOAD_FILE))?;
                Ok(None)
            }
            StagingPhase::Verified => {
                remove_direct_file(&self.root.join(INCOMING_PAYLOAD_FILE))?;
                let candidate = journal.candidate.expect("validated verified candidate");
                if self.payload_status(&candidate).await? != PayloadStatus::Matches {
                    return Err(ApplicationUpdateStagingError::InvalidState(
                        "verified staging payload does not match its journal".into(),
                    ));
                }
                Ok(Some(StagedApplicationUpdate {
                    candidate,
                    payload_path: self.payload_path(),
                }))
            }
            StagingPhase::Staged => {
                remove_direct_file(&self.root.join(INCOMING_PAYLOAD_FILE))?;
                let candidate = journal.candidate.expect("validated staged candidate");
                if let Some(previous) = journal.previous_candidate {
                    if self.payload_status(&previous).await? != PayloadStatus::Matches {
                        return Err(ApplicationUpdateStagingError::InvalidState(
                            "interrupted staging payload matches neither candidate identity".into(),
                        ));
                    }
                    self.write_journal(&StagingJournal::verified(previous.clone()))?;
                    return Ok(Some(StagedApplicationUpdate {
                        candidate: previous,
                        payload_path: self.payload_path(),
                    }));
                }
                match self.payload_status(&candidate).await? {
                    PayloadStatus::Missing => {
                        self.write_journal(&StagingJournal::empty())?;
                        Ok(None)
                    }
                    PayloadStatus::Matches => unreachable!(),
                    PayloadStatus::Mismatch => Err(ApplicationUpdateStagingError::InvalidState(
                        "interrupted staging left an unidentified payload".into(),
                    )),
                }
            }
            StagingPhase::PayloadVerified => {
                let candidate = journal
                    .candidate
                    .expect("validated payload-verified candidate");
                let incoming_path = self.root.join(INCOMING_PAYLOAD_FILE);
                let incoming = self.payload_status_at(&incoming_path, &candidate).await?;
                let active = self.payload_status(&candidate).await?;
                if incoming == PayloadStatus::Matches {
                    replace_file_atomically(
                        &self.root,
                        INCOMING_PAYLOAD_FILE,
                        ACTIVE_PAYLOAD_FILE,
                    )?;
                } else if active != PayloadStatus::Matches {
                    remove_direct_file(&incoming_path)?;
                    if let Some(previous) = journal.previous_candidate {
                        if self.payload_status(&previous).await? != PayloadStatus::Matches {
                            return Err(ApplicationUpdateStagingError::InvalidState(
                                "verified staging recovery lost both candidate slots".into(),
                            ));
                        }
                        self.write_journal(&StagingJournal::verified(previous.clone()))?;
                        return Ok(Some(StagedApplicationUpdate {
                            candidate: previous,
                            payload_path: self.payload_path(),
                        }));
                    }
                    if active == PayloadStatus::Missing {
                        self.write_journal(&StagingJournal::empty())?;
                        return Ok(None);
                    }
                    return Err(ApplicationUpdateStagingError::InvalidState(
                        "verified staging recovery found an unidentified payload".into(),
                    ));
                } else {
                    remove_direct_file(&incoming_path)?;
                }
                self.write_journal(&StagingJournal::verified(candidate.clone()))?;
                Ok(Some(StagedApplicationUpdate {
                    candidate,
                    payload_path: self.payload_path(),
                }))
            }
        }
    }

    fn restore_previous(
        &self,
        previous: Option<&StagedApplicationUpdate>,
    ) -> Result<(), ApplicationUpdateStagingError> {
        match previous {
            Some(previous) => {
                self.write_journal(&StagingJournal::verified(previous.candidate.clone()))
            }
            None => self.write_journal(&StagingJournal::empty()),
        }
    }

    async fn payload_status(
        &self,
        candidate: &SelectedCandidate,
    ) -> Result<PayloadStatus, ApplicationUpdateStagingError> {
        self.payload_status_at(&self.payload_path(), candidate)
            .await
    }

    async fn payload_status_at(
        &self,
        path: &Path,
        candidate: &SelectedCandidate,
    ) -> Result<PayloadStatus, ApplicationUpdateStagingError> {
        refuse_symlink_ancestors(path)?;
        let metadata = match fs::symlink_metadata(path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(PayloadStatus::Missing);
            }
            Err(error) => return Err(error.into()),
            Ok(metadata) => metadata,
        };
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(ApplicationUpdateStagingError::InvalidState(
                "staged payload is not a direct file".into(),
            ));
        }
        if metadata.len() != candidate.release.artifact.bytes {
            return Ok(PayloadStatus::Mismatch);
        }
        let mut file = tokio::fs::File::open(path).await?;
        let mut digest = Sha256::new();
        let mut buffer = vec![0_u8; 64 * 1024];
        loop {
            let count = file.read(&mut buffer).await?;
            if count == 0 {
                break;
            }
            digest.update(&buffer[..count]);
        }
        if hex::encode(digest.finalize()) == candidate.release.artifact.sha256 {
            Ok(PayloadStatus::Matches)
        } else {
            Ok(PayloadStatus::Mismatch)
        }
    }

    fn read_journal(&self) -> Result<Option<StagingJournal>, ApplicationUpdateStagingError> {
        let path = self.root.join(JOURNAL_FILE);
        refuse_symlink_ancestors(&path)?;
        let metadata = match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
            Ok(metadata) => metadata,
        };
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || metadata.len() == 0
            || metadata.len() > MAX_JOURNAL_BYTES
        {
            return Err(ApplicationUpdateStagingError::InvalidState(
                "staging journal is not a bounded direct file".into(),
            ));
        }
        let bytes = fs::read(path)?;
        serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|error| ApplicationUpdateStagingError::InvalidState(error.to_string()))
    }

    fn write_journal(&self, journal: &StagingJournal) -> Result<(), ApplicationUpdateStagingError> {
        validate_journal(journal)?;
        let mut bytes = serde_json::to_vec_pretty(journal)?;
        bytes.push(b'\n');
        if bytes.len() as u64 > MAX_JOURNAL_BYTES {
            return Err(ApplicationUpdateStagingError::InvalidState(
                "serialized staging journal exceeds its limit".into(),
            ));
        }
        write_bytes_atomically(&self.root, JOURNAL_TEMP_FILE, JOURNAL_FILE, &bytes)?;
        Ok(())
    }

    fn lock(&self) -> Result<StagingLock, ApplicationUpdateStagingError> {
        refuse_symlink_ancestors(&self.root)?;
        fs::create_dir_all(&self.root)?;
        refuse_symlink_ancestors(&self.root)?;
        if !fs::symlink_metadata(&self.root)?.is_dir() {
            return Err(ApplicationUpdateStagingError::InvalidPath(
                "staging root is not a directory".into(),
            ));
        }
        let canonical = fs::canonicalize(&self.root)?;
        let process = acquire_process_lock(canonical)?;
        let lock_path = self.root.join(LOCK_FILE);
        refuse_symlink_ancestors(&lock_path)?;
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(lock_path)?;
        match file.try_lock_exclusive() {
            Ok(()) => Ok(StagingLock {
                file,
                _process: process,
            }),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                Err(ApplicationUpdateStagingError::Busy)
            }
            Err(error) => Err(error.into()),
        }
    }
}

fn required_staging_bytes(payload_bytes: u64) -> Result<u64, ApplicationUpdateStagingError> {
    payload_bytes.checked_mul(2).ok_or_else(|| {
        ApplicationUpdateStagingError::InvalidState(
            "payload size exceeds the staging capacity calculation".into(),
        )
    })
}

fn validate_journal(journal: &StagingJournal) -> Result<(), ApplicationUpdateStagingError> {
    if journal.schema_version != STAGING_SCHEMA_VERSION {
        return Err(ApplicationUpdateStagingError::UnsupportedSchema(
            journal.schema_version,
        ));
    }
    match journal.phase {
        StagingPhase::Empty
            if journal.candidate.is_none() && journal.previous_candidate.is_none() => {}
        StagingPhase::Verified
            if journal.candidate.is_some() && journal.previous_candidate.is_none() => {}
        StagingPhase::Staged | StagingPhase::PayloadVerified if journal.candidate.is_some() => {}
        _ => {
            return Err(ApplicationUpdateStagingError::InvalidState(
                "staging phase and candidate identities are inconsistent".into(),
            ));
        }
    }
    if let Some(candidate) = &journal.candidate {
        validate_selected_candidate(candidate)?;
    }
    if let Some(previous) = &journal.previous_candidate {
        validate_selected_candidate(previous)?;
    }
    Ok(())
}

fn acquire_process_lock(
    root: PathBuf,
) -> Result<ProcessStagingLock, ApplicationUpdateStagingError> {
    let mut active = ACTIVE_STAGING_ROOTS
        .get_or_init(|| Mutex::new(BTreeSet::new()))
        .lock()
        .map_err(|_| {
            ApplicationUpdateStagingError::InvalidState("staging process lock was poisoned".into())
        })?;
    if !active.insert(root.clone()) {
        return Err(ApplicationUpdateStagingError::Busy);
    }
    Ok(ProcessStagingLock { root })
}

fn validate_root(root: &Path) -> Result<(), ApplicationUpdateStagingError> {
    if !root.is_absolute()
        || root.file_name().is_none()
        || root
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(ApplicationUpdateStagingError::InvalidPath(
            "staging root must be absolute and contain no parent traversal".into(),
        ));
    }
    Ok(())
}

fn remove_direct_file(path: &Path) -> Result<(), ApplicationUpdateStagingError> {
    refuse_symlink_ancestors(path)?;
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {
            fs::remove_file(path)?;
            Ok(())
        }
        Ok(_) => Err(ApplicationUpdateStagingError::InvalidState(format!(
            "staging entry is not a direct file: {}",
            path.display()
        ))),
    }
}

fn refuse_symlink_ancestors(path: &Path) -> Result<(), ApplicationUpdateStagingError> {
    let mut current = Some(path);
    while let Some(candidate) = current {
        match fs::symlink_metadata(candidate) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(ApplicationUpdateStagingError::InvalidPath(format!(
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
    use base64::Engine as _;

    use super::*;
    use crate::application_update::{
        ApplicationChannel, ApplicationCompatibility, ArtifactIdentity,
        AuthenticatedTargetReference, InstallOwner, LibraryCompatibility, PackageIdentity,
        PromotionRecord, QualifiedRun, ReleaseRecord, VersionRange,
    };

    const PUBLIC_KEY: &str = "untrusted comment: minisign public key E7620F1842B4E81F\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3\n";
    const PREHASHED_SIGNATURE: &str = "untrusted comment: signature from minisign secret key\nRUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\ntrusted comment: timestamp:1556193335\tfile:test\ny/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==\n";

    fn key_id() -> String {
        hex::encode(Sha256::digest(PUBLIC_KEY.as_bytes()))
    }

    fn payload_key() -> PayloadVerificationKey {
        PayloadVerificationKey {
            id: key_id(),
            tauri_public_key: base64::engine::general_purpose::STANDARD
                .encode(PUBLIC_KEY.as_bytes()),
        }
    }

    fn candidate(version: &str, payload: &[u8]) -> SelectedCandidate {
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

    #[tokio::test]
    async fn verified_payload_survives_restart_with_exact_candidate_identity() {
        let temporary = tempfile::tempdir().unwrap();
        let store = ApplicationUpdateStagingStore::new(temporary.path().join("staging")).unwrap();
        let selected = candidate("1.0.0", b"test");
        let mut reader = &b"test"[..];

        let staged = store
            .stage(&mut reader, &selected, &payload_key())
            .await
            .unwrap();
        assert_eq!(fs::read(&staged.payload_path).unwrap(), b"test");
        assert_eq!(staged.candidate, selected);

        let restarted = ApplicationUpdateStagingStore::new(store.root.clone()).unwrap();
        assert_eq!(restarted.reconcile().await.unwrap().unwrap(), staged);
    }

    #[tokio::test]
    async fn failed_verification_preserves_the_prior_verified_candidate() {
        let temporary = tempfile::tempdir().unwrap();
        let store = ApplicationUpdateStagingStore::new(temporary.path().join("staging")).unwrap();
        let previous = candidate("1.0.0", b"test");
        let mut reader = &b"test"[..];
        store
            .stage(&mut reader, &previous, &payload_key())
            .await
            .unwrap();

        let next = candidate("1.1.0", b"test");
        let mut tampered = &b"tast"[..];
        assert!(matches!(
            store.stage(&mut tampered, &next, &payload_key()).await,
            Err(ApplicationUpdateStagingError::Verification(
                PayloadVerificationError::HashMismatch
            ))
        ));
        assert_eq!(
            store.reconcile().await.unwrap().unwrap().candidate,
            previous
        );
        assert_eq!(fs::read(store.payload_path()).unwrap(), b"test");
        assert!(!store.root.join(INCOMING_PAYLOAD_FILE).exists());
    }

    #[tokio::test]
    async fn interrupted_attempt_restores_the_prior_slot_and_removes_partial_bytes() {
        let temporary = tempfile::tempdir().unwrap();
        let store = ApplicationUpdateStagingStore::new(temporary.path().join("staging")).unwrap();
        let previous = candidate("1.0.0", b"test");
        let mut reader = &b"test"[..];
        store
            .stage(&mut reader, &previous, &payload_key())
            .await
            .unwrap();

        let next = candidate("1.1.0", b"test");
        store
            .write_journal(&StagingJournal::staged(next, Some(previous.clone())))
            .unwrap();
        fs::write(store.root.join(INCOMING_PAYLOAD_FILE), b"partial").unwrap();

        assert_eq!(
            store.reconcile().await.unwrap().unwrap().candidate,
            previous
        );
        assert_eq!(fs::read(store.payload_path()).unwrap(), b"test");
        assert!(!store.root.join(INCOMING_PAYLOAD_FILE).exists());
    }

    #[tokio::test]
    async fn payload_verified_phase_can_finish_an_identical_byte_candidate() {
        let temporary = tempfile::tempdir().unwrap();
        let store = ApplicationUpdateStagingStore::new(temporary.path().join("staging")).unwrap();
        let previous = candidate("1.0.0", b"test");
        let mut reader = &b"test"[..];
        store
            .stage(&mut reader, &previous, &payload_key())
            .await
            .unwrap();

        let next = candidate("1.1.0", b"test");
        store
            .write_journal(&StagingJournal::payload_verified(
                next.clone(),
                Some(previous),
            ))
            .unwrap();
        fs::write(store.root.join(INCOMING_PAYLOAD_FILE), b"test").unwrap();

        assert_eq!(store.reconcile().await.unwrap().unwrap().candidate, next);
        assert_eq!(fs::read(store.payload_path()).unwrap(), b"test");
        assert!(!store.root.join(INCOMING_PAYLOAD_FILE).exists());
    }

    #[tokio::test]
    async fn an_inflight_stream_exclusively_owns_the_staging_root() {
        let temporary = tempfile::tempdir().unwrap();
        let store = ApplicationUpdateStagingStore::new(temporary.path().join("staging")).unwrap();
        let selected = candidate("1.0.0", b"test");
        let key = payload_key();
        let worker_store = store.clone();
        let (mut writer, mut reader) = tokio::io::duplex(4);
        let worker =
            tokio::spawn(async move { worker_store.stage(&mut reader, &selected, &key).await });
        for _ in 0..100 {
            if store.root.join(JOURNAL_FILE).exists() {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert!(store.root.join(JOURNAL_FILE).exists());
        assert!(matches!(
            store.reconcile().await,
            Err(ApplicationUpdateStagingError::Busy)
        ));

        writer.write_all(b"test").await.unwrap();
        writer.shutdown().await.unwrap();
        worker.await.unwrap().unwrap();
        assert!(store.reconcile().await.unwrap().is_some());
    }

    #[tokio::test]
    async fn corrupt_or_future_journal_requires_explicit_bounded_reset() {
        let temporary = tempfile::tempdir().unwrap();
        let store = ApplicationUpdateStagingStore::new(temporary.path().join("staging")).unwrap();
        let selected = candidate("1.0.0", b"test");
        let mut reader = &b"test"[..];
        store
            .stage(&mut reader, &selected, &payload_key())
            .await
            .unwrap();
        fs::write(store.root.join(JOURNAL_FILE), b"{").unwrap();
        assert!(matches!(
            store.reconcile().await,
            Err(ApplicationUpdateStagingError::InvalidState(_))
        ));
        assert_eq!(fs::read(store.payload_path()).unwrap(), b"test");

        fs::write(
            store.root.join(JOURNAL_FILE),
            br#"{"schema_version":2,"phase":"verified","candidate":null,"previous_candidate":null}"#,
        )
        .unwrap();

        assert!(matches!(
            store.reconcile().await,
            Err(ApplicationUpdateStagingError::UnsupportedSchema(2))
        ));
        assert_eq!(fs::read(store.payload_path()).unwrap(), b"test");

        store.reset().unwrap();
        assert!(store.reconcile().await.unwrap().is_none());
        assert!(!store.payload_path().exists());
        assert_eq!(required_staging_bytes(4).unwrap(), 8);
    }
}
