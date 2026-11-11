//! Root-scoped automatic setup.
//!
//! A player can let Portcove set up eligible games it finds in one saved
//! game-file folder. Turning it on is explicit and records a durable
//! enrollment boundary: either every eligible game already in the folder and
//! any found later, or only games found later. "Already there" is the set of
//! matched files in the last complete scan at the moment consent was given,
//! not a clock time, so restarts, rescans, relinking, duplicate events,
//! catalog changes and clock changes never enroll existing content.
//!
//! Consent is policy, never an authorization. Each pass rechecks it, uses
//! only files inside the folder, never replaces a different copy already in
//! use, waits when several implementations could use the same files, and runs
//! each game through an ordinary one-game install batch that re-plans and
//! authorizes it immediately before acting. It never launches a game.

use std::collections::BTreeSet;
use std::path::Path;

use rusqlite::{OptionalExtension, TransactionBehavior, params};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{
    InstallBatchItemState, InstallBatchRecord, InstallBatchRequestItem, Library,
    LibraryMembershipOrigin, OperationEvent, PortIntentMode, PortcoveError, PortcoveService,
    Result, SourceImportMode, SourceRecord,
};

pub const ROOT_SETUP_FORMAT_VERSION: u8 = 1;
/// Games set up for folder consent in one pass; later passes continue.
pub const MAX_ROOT_SETUPS_PER_PASS: usize = 4;
/// Matched files remembered as already present when consent was given.
pub const MAX_ROOT_SETUP_BASELINE: usize = 4096;
const MAX_ROOT_SETUP_FAILURES: usize = 64;
const MAX_ROOT_SETUP_WAITING: usize = 64;
const MAX_RECORD_BYTES: usize = 512 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RootSetupEnrollment {
    /// Eligible games already in the folder and any found later.
    ExistingAndFuture,
    /// Only games whose files were not in the folder's last complete scan.
    FutureOnly,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct RootSetupFailure {
    pub port_id: String,
    pub plan_sha256: String,
    pub attempts: u32,
    pub reason: String,
}

/// The game the player chose for files that several implementations can use.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct RootSetupImplementation {
    pub profile_id: String,
    pub port_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct RootSetupConsent {
    pub format_version: u8,
    pub root_id: String,
    pub enrollment: RootSetupEnrollment,
    pub enabled_at: i64,
    pub updated_at: i64,
    /// Matched files (`profile_id:sha256`) present when consent was given.
    /// Empty for `existing_and_future`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub baseline: Vec<String>,
    /// Explicit implementation choices. Files several games can use wait
    /// until one is chosen; Portcove never sets up every fork.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub implementations: Vec<RootSetupImplementation>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub failures: Vec<RootSetupFailure>,
}

/// An eligible-looking file in a consented folder that is waiting for a person
/// or a requirement.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct RootSetupWaiting {
    pub root_id: String,
    pub profile_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port_id: Option<String>,
    pub reason: String,
}

fn candidate_key(source: &SourceRecord) -> String {
    format!("{}:{}", source.profile_id, source.sha256)
}

fn decode(root_id: &str, json: &str) -> Result<RootSetupConsent> {
    let record: RootSetupConsent = serde_json::from_str(json).map_err(|error| {
        PortcoveError::state("stored folder setup choice is invalid")
            .detail("root_id", root_id)
            .detail("cause", error.to_string())
    })?;
    if record.format_version != ROOT_SETUP_FORMAT_VERSION || record.root_id != root_id {
        return Err(
            PortcoveError::state("stored folder setup choice has an unsupported contract")
                .detail("root_id", root_id),
        );
    }
    Ok(record)
}

impl Library {
    /// Every readable folder setup choice. An unreadable row is skipped so it
    /// cannot stop other folders; turning the choice off again replaces it.
    pub fn root_setup_consents(&self) -> Result<Vec<RootSetupConsent>> {
        let connection = self.connection()?;
        let mut statement = connection
            .prepare("SELECT root_id, record_json FROM game_file_root_setup ORDER BY root_id")?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        let mut consents = Vec::new();
        for row in rows {
            let (root_id, json) = row?;
            match decode(&root_id, &json) {
                Ok(consent) => consents.push(consent),
                Err(error) => {
                    tracing::warn!(root_id, error = %error.message, "skipping an unreadable folder setup choice");
                }
            }
        }
        Ok(consents)
    }

    pub fn root_setup_consent(&self, root_id: &str) -> Result<Option<RootSetupConsent>> {
        let json: Option<String> = self
            .connection()?
            .query_row(
                "SELECT record_json FROM game_file_root_setup WHERE root_id=?1",
                [root_id],
                |row| row.get(0),
            )
            .optional()?;
        json.map(|json| decode(root_id, &json)).transpose()
    }

    fn write_root_setup_consent(&self, consent: &RootSetupConsent) -> Result<()> {
        let encoded = serde_json::to_string(consent)?;
        if encoded.len() > MAX_RECORD_BYTES {
            return Err(PortcoveError::state(
                "folder setup choice exceeds its storage limit",
            ));
        }
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        // Consent belongs to a saved folder; a folder removed meanwhile ends it.
        let exists: bool = transaction
            .query_row(
                "SELECT 1 FROM game_file_roots WHERE id=?1",
                [&consent.root_id],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false);
        if !exists {
            return Err(PortcoveError::not_found("game-file folder is not saved")
                .detail("root_id", &consent.root_id));
        }
        transaction.execute(
            "INSERT INTO game_file_root_setup(root_id,updated_at,record_json) VALUES (?1,?2,?3)
             ON CONFLICT(root_id) DO UPDATE SET updated_at=excluded.updated_at, record_json=excluded.record_json",
            params![consent.root_id, consent.updated_at, encoded],
        )?;
        transaction.commit()?;
        Ok(())
    }

    /// Ends automatic setup for a folder. Installed games are not changed.
    pub fn remove_root_setup_consent(&self, root_id: &str) -> Result<bool> {
        Ok(self.connection()?.execute(
            "DELETE FROM game_file_root_setup WHERE root_id=?1",
            [root_id],
        )? > 0)
    }

    fn update_root_setup_failures(
        &self,
        root_id: &str,
        change: impl FnOnce(&mut Vec<RootSetupFailure>),
    ) -> Result<()> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let json: Option<String> = transaction
            .query_row(
                "SELECT record_json FROM game_file_root_setup WHERE root_id=?1",
                [root_id],
                |row| row.get(0),
            )
            .optional()?;
        // Consent withdrawn meanwhile: nothing to remember.
        let Some(json) = json else { return Ok(()) };
        let mut consent = decode(root_id, &json)?;
        change(&mut consent.failures);
        if consent.failures.len() > MAX_ROOT_SETUP_FAILURES {
            let excess = consent.failures.len() - MAX_ROOT_SETUP_FAILURES;
            consent.failures.drain(..excess);
        }
        consent.updated_at = Self::now();
        transaction.execute(
            "UPDATE game_file_root_setup SET updated_at=?2, record_json=?3 WHERE root_id=?1",
            params![
                root_id,
                consent.updated_at,
                serde_json::to_string(&consent)?
            ],
        )?;
        transaction.commit()?;
        Ok(())
    }
}

/// What a folder pass found for one matched file.
enum RootCandidate {
    Setup { port_id: String },
    Waiting(RootSetupWaiting),
    Skip,
}

impl PortcoveService {
    /// Turns on automatic setup for one saved folder. `future_only` records
    /// the files the last complete scan found there, so only games found
    /// later are enrolled; it needs a complete current scan of the folder.
    pub fn set_root_setup_consent(
        &self,
        root_id: &str,
        enrollment: RootSetupEnrollment,
    ) -> Result<RootSetupConsent> {
        let root = self
            .library
            .game_file_roots()?
            .into_iter()
            .find(|root| root.id == root_id)
            .ok_or_else(|| {
                PortcoveError::not_found("game-file folder is not saved").detail("root_id", root_id)
            })?;
        let baseline = match enrollment {
            RootSetupEnrollment::ExistingAndFuture => Vec::new(),
            RootSetupEnrollment::FutureOnly => {
                let snapshot = self.game_file_scan_snapshot()?.ok_or_else(|| {
                    PortcoveError::usage(
                        "scan your game-file folders first, so Portcove knows which games are already there",
                    )
                })?;
                let complete = snapshot.report.limits_reached.is_empty()
                    && snapshot.freshness == crate::GameFileScanFreshness::InputsMatch
                    && snapshot.roots.iter().any(|scanned| scanned.id == root.id)
                    && snapshot.coverage.as_ref().is_none_or(|coverage| {
                        !coverage.can_resume
                            && !coverage.restart_required
                            && coverage.pending_directories == 0
                    });
                if !complete {
                    return Err(PortcoveError::usage(
                        "finish scanning this folder first, so Portcove knows which games are already there",
                    )
                    .detail("root_id", root_id));
                }
                let keys = snapshot
                    .report
                    .candidates
                    .iter()
                    .filter(|candidate| candidate.path.starts_with(&root.path))
                    .map(candidate_key)
                    .collect::<BTreeSet<_>>();
                if keys.len() > MAX_ROOT_SETUP_BASELINE {
                    return Err(PortcoveError::usage(
                        "this folder has too many matched files to remember which are already there",
                    ));
                }
                keys.into_iter().collect()
            }
        };
        let now = Library::now();
        // Changing the boundary is a new decision: earlier failures are
        // forgotten, while implementation choices are kept.
        let implementations = self
            .library
            .root_setup_consent(&root.id)
            .ok()
            .flatten()
            .map(|consent| consent.implementations)
            .unwrap_or_default();
        let consent = RootSetupConsent {
            format_version: ROOT_SETUP_FORMAT_VERSION,
            root_id: root.id,
            enrollment,
            enabled_at: now,
            updated_at: now,
            baseline,
            implementations,
            failures: Vec::new(),
        };
        self.library.write_root_setup_consent(&consent)?;
        Ok(consent)
    }

    /// Chooses which game to set up from this folder for files that several
    /// games can use. The folder must already have automatic setup turned on.
    pub fn set_root_setup_implementation(
        &self,
        root_id: &str,
        profile_id: &str,
        port_id: &str,
    ) -> Result<RootSetupConsent> {
        let uses_profile = self
            .catalog
            .port(port_id)
            .is_ok_and(|port| port.source_profile.as_deref() == Some(profile_id));
        if !uses_profile {
            return Err(PortcoveError::usage("this game cannot use those files")
                .detail("port_id", port_id)
                .detail("profile_id", profile_id));
        }
        let mut consent = self.library.root_setup_consent(root_id)?.ok_or_else(|| {
            PortcoveError::usage("turn on automatic setup for this folder first")
                .detail("root_id", root_id)
        })?;
        consent
            .implementations
            .retain(|choice| choice.profile_id != profile_id);
        consent.implementations.push(RootSetupImplementation {
            profile_id: profile_id.to_owned(),
            port_id: port_id.to_owned(),
        });
        consent.updated_at = Library::now();
        self.library.write_root_setup_consent(&consent)?;
        Ok(consent)
    }

    /// Turns off automatic setup for a folder. Installed games stay installed.
    pub fn remove_root_setup_consent(&self, root_id: &str) -> Result<bool> {
        self.library.remove_root_setup_consent(root_id)
    }

    pub fn root_setup_consents(&self) -> Result<Vec<RootSetupConsent>> {
        self.library.root_setup_consents()
    }

    /// Folder consent part of a standing-setup pass. The caller holds the
    /// standing-setup lock. `handled` holds games already decided this pass.
    pub(super) async fn run_root_setup(
        &self,
        busy: &BTreeSet<String>,
        handled: &mut BTreeSet<String>,
        batches: &mut Vec<InstallBatchRecord>,
        failures: &mut Vec<crate::StandingSetupFailure>,
        emit: &mut impl FnMut(OperationEvent),
    ) -> Result<Vec<RootSetupWaiting>> {
        let consents = self.library.root_setup_consents()?;
        if consents.is_empty() {
            return Ok(Vec::new());
        }
        let Some(snapshot) = self.game_file_scan_snapshot()? else {
            return Ok(Vec::new());
        };
        let roots = self.library.game_file_roots()?;
        let mut waiting = Vec::new();
        let mut started = 0;
        for consent in consents {
            // An unavailable folder is not deleted content; it simply waits.
            let Some(root) = roots.iter().find(|root| {
                root.id == consent.root_id
                    && root.availability == crate::GameFileRootAvailability::Available
            }) else {
                continue;
            };
            for candidate in &snapshot.report.candidates {
                if started >= MAX_ROOT_SETUPS_PER_PASS {
                    return Ok(waiting);
                }
                if !candidate.path.starts_with(&root.path)
                    || (consent.enrollment == RootSetupEnrollment::FutureOnly
                        && consent.baseline.contains(&candidate_key(candidate)))
                {
                    continue;
                }
                match self.root_candidate(&consent, candidate, busy, handled) {
                    RootCandidate::Skip => {}
                    RootCandidate::Waiting(item) => {
                        if waiting.len() < MAX_ROOT_SETUP_WAITING {
                            waiting.push(item);
                        }
                    }
                    RootCandidate::Setup { port_id } => {
                        handled.insert(port_id.clone());
                        match self
                            .root_setup_one(&root.id, &root.path, candidate, &port_id, emit)
                            .await
                        {
                            Ok(RootSetupOutcome::Started(record)) => {
                                started += 1;
                                batches.push(record);
                            }
                            Ok(RootSetupOutcome::Waiting(reason)) => {
                                if waiting.len() < MAX_ROOT_SETUP_WAITING {
                                    waiting.push(RootSetupWaiting {
                                        root_id: root.id.clone(),
                                        profile_id: candidate.profile_id.clone(),
                                        port_id: Some(port_id),
                                        reason,
                                    });
                                }
                            }
                            Ok(RootSetupOutcome::Skipped) => {}
                            Err(error) => {
                                // Counted per file, so a permanent failure
                                // stops recurring on every refresh.
                                self.remember_root_failure(
                                    &root.id,
                                    &port_id,
                                    &source_attempt(candidate),
                                    &error.message,
                                );
                                failures.push(crate::StandingSetupFailure {
                                    port_id,
                                    reason: error.message,
                                });
                            }
                        }
                    }
                }
            }
        }
        Ok(waiting)
    }

    fn root_candidate(
        &self,
        consent: &RootSetupConsent,
        candidate: &SourceRecord,
        busy: &BTreeSet<String>,
        handled: &BTreeSet<String>,
    ) -> RootCandidate {
        let ports = self
            .catalog
            .ports()
            .iter()
            .filter(|port| port.source_profile.as_deref() == Some(candidate.profile_id.as_str()))
            .map(|port| port.id.clone())
            .collect::<Vec<_>>();
        let waiting = |port_id: Option<String>, reason: &str| {
            RootCandidate::Waiting(RootSetupWaiting {
                root_id: consent.root_id.clone(),
                profile_id: candidate.profile_id.clone(),
                port_id,
                reason: reason.to_owned(),
            })
        };
        let chosen = consent
            .implementations
            .iter()
            .find(|choice| choice.profile_id == candidate.profile_id)
            .map(|choice| choice.port_id.clone())
            .filter(|port_id| ports.contains(port_id));
        let port_id = match (ports.as_slice(), chosen) {
            ([], _) => return RootCandidate::Skip,
            (_, Some(port_id)) => port_id,
            ([port_id], None) => port_id.clone(),
            (_, None) => {
                // A remembered per-game choice for one of them decides; that
                // game is handled by its own intent, never by folder consent.
                let chosen = ports.iter().any(|port_id| {
                    self.library
                        .port_intent(port_id)
                        .ok()
                        .flatten()
                        .is_some_and(|intent| intent.mode != PortIntentMode::DiscoverOnly)
                });
                if chosen {
                    return RootCandidate::Skip;
                }
                return waiting(
                    None,
                    "several versions of this game can use these files; choose which one to set up",
                );
            }
        };
        if handled.contains(&port_id) || busy.contains(&port_id) {
            return RootCandidate::Skip;
        }
        match self.library.port_intent(&port_id) {
            // The player's own choice for this game wins over folder consent.
            Ok(Some(intent))
                if intent.explicitly_uninstalled_at.is_some()
                    || intent.mode != PortIntentMode::DiscoverOnly =>
            {
                return RootCandidate::Skip;
            }
            Ok(_) => {}
            Err(error) => return waiting(Some(port_id), &error.message),
        }
        match self.library.status(&port_id, crate::ReleaseChannel::Stable) {
            Ok(status) if status.active.is_some() || status.external_runtime.is_some() => {
                RootCandidate::Skip
            }
            Ok(_) => RootCandidate::Setup { port_id },
            Err(error) => waiting(Some(port_id), &error.message),
        }
    }

    async fn root_setup_one(
        &self,
        root_id: &str,
        root_path: &Path,
        candidate: &SourceRecord,
        port_id: &str,
        emit: &mut impl FnMut(OperationEvent),
    ) -> Result<RootSetupOutcome> {
        // Consent can be withdrawn or narrowed while earlier games run.
        let Some(consent) = self.library.root_setup_consent(root_id)? else {
            return Ok(RootSetupOutcome::Skipped);
        };
        let key = candidate_key(candidate);
        if consent.enrollment == RootSetupEnrollment::FutureOnly && consent.baseline.contains(&key)
        {
            return Ok(RootSetupOutcome::Skipped);
        }
        let exhausted = |attempt: &str| {
            consent.failures.iter().any(|failure| {
                failure.port_id == port_id
                    && failure.plan_sha256 == attempt
                    && failure.attempts >= crate::MAX_STANDING_SETUP_ATTEMPTS
            })
        };
        if exhausted(&source_attempt(candidate)) {
            return Ok(RootSetupOutcome::Skipped);
        }
        // Never retarget a different copy the player is already using.
        match self.library.source(&candidate.profile_id)? {
            Some(registered) if registered.sha256 == candidate.sha256 => {}
            Some(_) => {
                return Ok(RootSetupOutcome::Waiting(
                    "a different copy of these files is already in use; Portcove will not replace it"
                        .to_owned(),
                ));
            }
            None => {
                // Folder consent covers registering files inside this folder
                // where they are, after checking their current bytes.
                if !candidate.path.starts_with(root_path) {
                    return Ok(RootSetupOutcome::Skipped);
                }
                let plan = self.plan_source_import(
                    &candidate.profile_id,
                    &candidate.path,
                    SourceImportMode::UseCurrentLocation,
                )?;
                if plan.source.sha256 != candidate.sha256 {
                    return Ok(RootSetupOutcome::Waiting(
                        "these files changed since the last scan; scan again".to_owned(),
                    ));
                }
                self.import_source(
                    &candidate.profile_id,
                    &candidate.path,
                    SourceImportMode::UseCurrentLocation,
                    &plan.plan_sha256,
                    None,
                )?;
            }
        }
        let plan = self.plan_game_install(port_id).await?;
        if let Some(reason) = self.install_plan_hold(&plan) {
            return Ok(RootSetupOutcome::Waiting(reason));
        }
        if exhausted(&plan.plan_sha256) {
            return Ok(RootSetupOutcome::Skipped);
        }
        let batch = self.start_install_batch(
            &[InstallBatchRequestItem {
                port_id: port_id.to_owned(),
                expected_plan_sha256: plan.plan_sha256.clone(),
            }],
            LibraryMembershipOrigin::GameFileDiscovery,
        )?;
        let record = self.run_install_batch(&batch.id, &mut *emit).await?;
        for item in &record.items {
            match item.state {
                InstallBatchItemState::Failed | InstallBatchItemState::Interrupted => {
                    self.remember_root_failure(
                        root_id,
                        &item.port_id,
                        &item.expected_plan_sha256,
                        item.detail.as_deref().unwrap_or("setup did not finish"),
                    );
                }
                InstallBatchItemState::Ready => {
                    let port_id = item.port_id.clone();
                    let result = self
                        .library
                        .update_root_setup_failures(root_id, |failures| {
                            failures.retain(|failure| failure.port_id != port_id);
                        });
                    if let Err(error) = result {
                        tracing::warn!(root_id, error = %error.message, "could not clear a folder setup failure");
                    }
                }
                _ => {}
            }
        }
        Ok(RootSetupOutcome::Started(record))
    }
}

impl PortcoveService {
    /// Counts a failed attempt for one game and plan (or file). Best effort:
    /// if it can't be recorded, a later pass tries again within the limits.
    fn remember_root_failure(&self, root_id: &str, port_id: &str, attempt: &str, reason: &str) {
        let reason = reason.chars().take(512).collect::<String>();
        let result = self
            .library
            .update_root_setup_failures(root_id, |failures| {
                match failures
                    .iter_mut()
                    .find(|failure| failure.port_id == port_id)
                {
                    Some(failure) if failure.plan_sha256 == attempt => {
                        failure.attempts = failure.attempts.saturating_add(1);
                        failure.reason = reason;
                    }
                    Some(failure) => {
                        failure.plan_sha256 = attempt.to_owned();
                        failure.attempts = 1;
                        failure.reason = reason;
                    }
                    None => failures.push(RootSetupFailure {
                        port_id: port_id.to_owned(),
                        plan_sha256: attempt.to_owned(),
                        attempts: 1,
                        reason,
                    }),
                }
            });
        if let Err(error) = result {
            tracing::warn!(root_id, error = %error.message, "could not record a folder setup failure");
        }
    }
}

/// The failure key for a file that could not be registered: changed bytes
/// make a new attempt.
fn source_attempt(source: &SourceRecord) -> String {
    format!("source:{}", candidate_key(source))
}

enum RootSetupOutcome {
    Started(InstallBatchRecord),
    Waiting(String),
    Skipped,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::service::tests::{register_zelda_install, service_with_release};
    use std::path::PathBuf;

    const PORT: &str = "zelda64-recomp";

    struct Folder {
        _temporary: tempfile::TempDir,
        service: PortcoveService,
        root_id: String,
        root: PathBuf,
        profile: String,
    }

    fn folder() -> Folder {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        register_zelda_install(&library, "v1", false);
        let service = service_with_release(library, "v1");
        let root = temporary.path().join("games");
        std::fs::create_dir(&root).unwrap();
        let root_id = service.library().add_game_file_root(&root).unwrap().id;
        let profile = service
            .catalog()
            .port(PORT)
            .unwrap()
            .source_profile
            .clone()
            .unwrap();
        // Majora's Mask files can be used by more than one game here.
        assert!(
            service
                .catalog()
                .ports()
                .iter()
                .filter(|port| port.source_profile.as_deref() == Some(profile.as_str()))
                .count()
                > 1
        );
        Folder {
            _temporary: temporary,
            service,
            root_id,
            root,
            profile,
        }
    }

    impl Folder {
        fn file(&self, name: &str, byte: char) -> SourceRecord {
            let sha256 = byte.to_string().repeat(64);
            SourceRecord {
                profile_id: self.profile.clone(),
                path: self.root.join(name),
                sha256: sha256.clone(),
                size: 4,
                storage_sha256: sha256,
                storage_size: 4,
                updated_at: 0,
                observed_identity: None,
            }
        }

        fn scanned(&self, candidates: Vec<SourceRecord>) {
            let snapshot = crate::source_discovery::complete_test_game_file_scan(
                self.service.catalog(),
                self.service.library(),
                candidates,
            );
            self.service
                .library()
                .replace_game_file_scan_snapshot(&snapshot)
                .unwrap();
        }

        /// The player already uses this copy, so no registration is needed.
        fn in_use(&self, source: &SourceRecord) {
            self.service.library().register_source(source).unwrap();
        }

        /// Turns on folder setup and chooses this game for its files.
        fn consent(&self, enrollment: RootSetupEnrollment) -> RootSetupConsent {
            self.service
                .set_root_setup_consent(&self.root_id, enrollment)
                .unwrap();
            self.service
                .set_root_setup_implementation(&self.root_id, &self.profile, PORT)
                .unwrap()
        }

        async fn pass(&self) -> crate::StandingSetupResult {
            self.service.run_standing_setup(|_| {}).await.unwrap()
        }

        fn installed(&self) -> bool {
            self.service.status(PORT).unwrap().active.is_some()
        }
    }

    #[tokio::test]
    async fn adding_a_folder_sets_up_nothing_until_chosen() {
        let folder = folder();
        let file = folder.file("game.z64", 'a');
        folder.in_use(&file);
        folder.scanned(vec![file]);
        assert!(folder.pass().await.batches.is_empty());
        assert!(!folder.installed());
        assert!(folder.service.root_setup_consents().unwrap().is_empty());
    }

    #[tokio::test]
    async fn existing_and_future_sets_up_an_existing_game_exactly_once() {
        let folder = folder();
        let file = folder.file("game.z64", 'a');
        folder.in_use(&file);
        folder.scanned(vec![file]);
        folder.consent(RootSetupEnrollment::ExistingAndFuture);
        let first = folder.pass().await;
        assert_eq!(first.batches.len(), 1, "{first:?}");
        assert_eq!(
            first.batches[0].items[0].state,
            InstallBatchItemState::Ready
        );
        let installed = folder.service.status(PORT).unwrap().active.unwrap().id;
        for _ in 0..2 {
            assert!(folder.pass().await.batches.is_empty());
        }
        assert_eq!(
            folder.service.status(PORT).unwrap().active.unwrap().id,
            installed
        );
    }

    #[tokio::test]
    async fn files_several_games_can_use_wait_for_a_choice() {
        let folder = folder();
        let file = folder.file("game.z64", 'a');
        folder.in_use(&file);
        folder.scanned(vec![file]);
        folder
            .service
            .set_root_setup_consent(&folder.root_id, RootSetupEnrollment::ExistingAndFuture)
            .unwrap();
        let waiting = folder.pass().await;
        assert!(waiting.batches.is_empty());
        assert_eq!(waiting.root_waiting.len(), 1);
        assert!(waiting.root_waiting[0].reason.contains("choose which one"));
        assert!(
            folder
                .service
                .set_root_setup_implementation(&folder.root_id, &folder.profile, "not-a-game")
                .is_err()
        );
        folder
            .service
            .set_root_setup_implementation(&folder.root_id, &folder.profile, PORT)
            .unwrap();
        // The choice survives a boundary change and sets up only that game.
        folder
            .service
            .set_root_setup_consent(&folder.root_id, RootSetupEnrollment::ExistingAndFuture)
            .unwrap();
        let chosen = folder.pass().await;
        assert_eq!(chosen.batches.len(), 1);
        assert_eq!(chosen.batches[0].items[0].port_id, PORT);
    }

    #[tokio::test]
    async fn future_only_never_enrolls_what_was_already_there() {
        let folder = folder();
        let existing = folder.file("old.z64", 'a');
        folder.in_use(&existing);
        folder.scanned(vec![existing.clone()]);
        let consent = folder.consent(RootSetupEnrollment::FutureOnly);
        assert_eq!(consent.baseline, vec![candidate_key(&existing)]);
        // Restarts, rescans and repeated events keep the boundary.
        folder.scanned(vec![existing.clone()]);
        for _ in 0..2 {
            assert!(folder.pass().await.batches.is_empty());
        }
        assert!(!folder.installed());
        // A copy found later is new content and is set up once.
        let later = folder.file("new.z64", 'b');
        folder.in_use(&later);
        folder.scanned(vec![existing, later]);
        assert_eq!(folder.pass().await.batches.len(), 1);
        assert!(folder.installed());
    }

    #[tokio::test]
    async fn future_only_needs_a_complete_scan_of_the_folder() {
        let folder = folder();
        assert!(
            folder
                .service
                .set_root_setup_consent(&folder.root_id, RootSetupEnrollment::FutureOnly)
                .is_err()
        );
        let file = folder.file("game.z64", 'a');
        let snapshot = crate::source_discovery::complete_test_game_file_scan(
            folder.service.catalog(),
            folder.service.library(),
            vec![file],
        );
        let mut partial = snapshot;
        partial
            .report
            .limits_reached
            .push(crate::SourceDiscoveryLimit::Entries);
        folder
            .service
            .library()
            .replace_game_file_scan_snapshot(&partial)
            .unwrap();
        assert!(
            folder
                .service
                .set_root_setup_consent(&folder.root_id, RootSetupEnrollment::FutureOnly)
                .is_err()
        );
        assert!(folder.service.root_setup_consents().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_different_copy_in_use_is_never_replaced() {
        let folder = folder();
        let used = folder.file("elsewhere.z64", 'c');
        folder.in_use(&used);
        folder.scanned(vec![folder.file("game.z64", 'a')]);
        folder.consent(RootSetupEnrollment::ExistingAndFuture);
        let result = folder.pass().await;
        assert!(result.batches.is_empty());
        assert_eq!(result.root_waiting.len(), 1);
        assert!(result.root_waiting[0].reason.contains("different copy"));
        assert_eq!(
            folder
                .service
                .library()
                .source(&folder.profile)
                .unwrap()
                .unwrap()
                .sha256,
            used.sha256
        );
        assert!(!folder.installed());
    }

    #[tokio::test]
    async fn files_that_fail_their_check_are_not_registered_or_installed() {
        let folder = folder();
        let file = folder.file("game.z64", 'a');
        std::fs::write(&file.path, b"not the expected game").unwrap();
        folder.scanned(vec![file]);
        folder.consent(RootSetupEnrollment::ExistingAndFuture);
        for _ in 0..crate::MAX_STANDING_SETUP_ATTEMPTS {
            let result = folder.pass().await;
            assert!(result.batches.is_empty());
            assert_eq!(result.failures.len(), 1, "{result:?}");
        }
        // A permanent failure stops recurring on every refresh.
        assert!(folder.pass().await.failures.is_empty());
        assert!(
            folder
                .service
                .library()
                .source(&folder.profile)
                .unwrap()
                .is_none()
        );
        assert!(!folder.installed());
    }

    #[tokio::test]
    async fn the_players_own_choices_win_over_folder_consent() {
        let folder = folder();
        let file = folder.file("game.z64", 'a');
        folder.in_use(&file);
        folder.scanned(vec![file]);
        folder.consent(RootSetupEnrollment::ExistingAndFuture);
        folder
            .service
            .set_port_intent(PORT, PortIntentMode::Ignored)
            .unwrap();
        assert!(folder.pass().await.batches.is_empty());
        folder
            .service
            .set_port_intent(PORT, PortIntentMode::DiscoverOnly)
            .unwrap();
        folder
            .service
            .library()
            .record_explicit_uninstall(PORT)
            .unwrap();
        assert!(folder.pass().await.batches.is_empty());
        assert!(!folder.installed());
    }

    #[tokio::test]
    async fn turning_off_or_removing_the_folder_stops_future_setup() {
        let folder = folder();
        let file = folder.file("game.z64", 'a');
        folder.in_use(&file);
        folder.scanned(vec![file]);
        folder.consent(RootSetupEnrollment::ExistingAndFuture);
        assert!(
            folder
                .service
                .remove_root_setup_consent(&folder.root_id)
                .unwrap()
        );
        assert!(folder.pass().await.batches.is_empty());
        folder.consent(RootSetupEnrollment::ExistingAndFuture);
        assert!(
            folder
                .service
                .library()
                .remove_game_file_root(&folder.root_id)
                .unwrap()
        );
        assert!(folder.service.root_setup_consents().unwrap().is_empty());
        assert!(folder.pass().await.batches.is_empty());
        assert!(!folder.installed());
    }

    #[tokio::test]
    async fn an_unavailable_folder_waits_without_losing_consent() {
        let folder = folder();
        let file = folder.file("game.z64", 'a');
        folder.in_use(&file);
        folder.scanned(vec![file]);
        folder.consent(RootSetupEnrollment::ExistingAndFuture);
        std::fs::remove_dir(&folder.root).unwrap();
        assert!(folder.pass().await.batches.is_empty());
        assert_eq!(folder.service.root_setup_consents().unwrap().len(), 1);
        std::fs::create_dir(&folder.root).unwrap();
        assert_eq!(folder.pass().await.batches.len(), 1);
    }
}
