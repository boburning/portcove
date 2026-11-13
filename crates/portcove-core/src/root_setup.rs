//! Root-scoped automatic setup.
//!
//! A player can let Portcove set up eligible games it finds in one saved
//! game-file folder. Turning it on is explicit and records a durable
//! enrollment boundary: either every eligible game already in the folder and
//! any found later, or only games found later.
//!
//! "Already there" is every regular file in the folder when consent was
//! given, identified by its path inside the folder and its size, whether or
//! not the catalog recognized it then. The boundary is that set of files, not
//! a clock time or a catalog match, so restarts, rescans, duplicate events,
//! catalog changes and clock changes never enroll existing content. Relinking
//! the folder adds the new location's existing files to the boundary, or turns
//! the choice off if that location cannot be listed.
//!
//! Consent is policy, never an authorization. Each pass rechecks it right
//! before registering files and right before installing, uses only files
//! inside the folder, never replaces a different copy already in use, waits
//! when several implementations could use the same files, and runs each game
//! through an ordinary one-game install batch that re-plans and authorizes it
//! immediately before acting. It never launches a game.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
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
/// Identities remembered as already present in a future-only folder: about
/// two per file plus one per folder, so roughly 100,000 files.
pub const MAX_ROOT_SETUP_BASELINE: usize = 200_000;
/// Matched files a pass plans or checks for folder consent; later passes continue.
const MAX_ROOT_CANDIDATES_PER_PASS: usize = 32;
const MAX_BASELINE_DEPTH: usize = 32;
const MAX_ROOT_SETUP_FAILURES: usize = 256;
const MAX_ROOT_SETUP_WAITING: usize = 64;
const MAX_RECORD_BYTES: usize = 512 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RootSetupEnrollment {
    /// Eligible games already in the folder and any found later.
    ExistingAndFuture,
    /// Only games whose files were not in the folder when consent was given.
    FutureOnly,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct RootSetupFailure {
    pub port_id: String,
    /// The install plan, or `source:` and the file, that failed.
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
    /// Files remembered as already in the folder (future-only); they are never
    /// set up by this choice.
    #[serde(default)]
    pub existing_files: u32,
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

fn encode(consent: &RootSetupConsent) -> Result<String> {
    let encoded = serde_json::to_string(consent)?;
    if encoded.len() > MAX_RECORD_BYTES {
        return Err(PortcoveError::state(
            "folder setup choice exceeds its storage limit",
        ));
    }
    Ok(encoded)
}

/// A file's identities for the enrollment boundary. Neither depends on the
/// catalog. `p:` is its path inside the folder and size; `t:` is its size and
/// exact modification time, which renaming or moving it inside the folder
/// keeps. A file matching either is treated as already there.
fn file_identities(relative: &Path, metadata: &std::fs::Metadata) -> Result<Vec<String>> {
    let relative = crate::path::unicode(relative, "game file")?.replace('\\', "/");
    let size = metadata.len();
    let mut identities = vec![format!("p:{relative}\0{size}")];
    if let Some(modified) = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
    {
        identities.push(format!("t:{size}\0{}", modified.as_nanos()));
    }
    Ok(identities)
}

/// A folder's identity: its path inside the root. Games stored as folders
/// also match through the files inside them.
fn directory_identity(relative: &Path) -> Result<String> {
    Ok(format!(
        "d:{}",
        crate::path::unicode(relative, "game folder")?.replace('\\', "/")
    ))
}

fn unreadable(path: &Path, error: impl std::fmt::Display) -> PortcoveError {
    PortcoveError::usage(
        "some files in this folder could not be read, so Portcove can't tell which games are already there",
    )
    .detail("path", path.display().to_string())
    .detail("cause", error.to_string())
}

/// Every regular file and folder in `root` (symbolic links are not
/// followed), bounded.
fn folder_files(root: &Path) -> Result<BTreeSet<String>> {
    let mut identities = BTreeSet::new();
    let mut pending = vec![(root.to_path_buf(), 0usize)];
    while let Some((directory, depth)) = pending.pop() {
        let entries =
            std::fs::read_dir(&directory).map_err(|error| unreadable(&directory, error))?;
        for entry in entries {
            let path = entry.map_err(|error| unreadable(&directory, error))?.path();
            let metadata =
                std::fs::symlink_metadata(&path).map_err(|error| unreadable(&path, error))?;
            let relative = path
                .strip_prefix(root)
                .map(Path::to_path_buf)
                .map_err(|_| PortcoveError::state("a listed file is outside its folder"))?;
            if metadata.is_dir() {
                if depth >= MAX_BASELINE_DEPTH {
                    return Err(PortcoveError::usage(
                        "this folder is nested too deeply to remember which games are already there",
                    ));
                }
                identities.insert(directory_identity(&relative)?);
                pending.push((path, depth + 1));
            } else if metadata.is_file() {
                identities.extend(file_identities(&relative, &metadata)?);
            }
            if identities.len() > MAX_ROOT_SETUP_BASELINE {
                return Err(PortcoveError::usage(
                    "this folder has too many files to remember which games are already there",
                ));
            }
        }
    }
    Ok(identities)
}

fn insert_baseline(
    connection: &Connection,
    root_id: &str,
    identities: &BTreeSet<String>,
) -> Result<()> {
    let mut statement = connection.prepare(
        "INSERT OR IGNORE INTO game_file_root_setup_baseline(root_id,identity) VALUES (?1,?2)",
    )?;
    for identity in identities {
        statement.execute(params![root_id, identity])?;
    }
    Ok(())
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

    /// Whether any of `identities` is remembered, on one connection.
    fn root_setup_baseline_contains_any(
        &self,
        root_id: &str,
        identities: &[String],
    ) -> Result<bool> {
        let connection = self.connection()?;
        let mut statement = connection.prepare_cached(
            "SELECT 1 FROM game_file_root_setup_baseline WHERE root_id=?1 AND identity=?2",
        )?;
        for identity in identities {
            if statement
                .query_row(params![root_id, identity], |_| Ok(()))
                .optional()?
                .is_some()
            {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// Records a new choice and its boundary, replacing any earlier one.
    fn replace_root_setup_consent(
        &self,
        consent: &RootSetupConsent,
        baseline: &BTreeSet<String>,
    ) -> Result<()> {
        let encoded = encode(consent)?;
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
            "DELETE FROM game_file_root_setup_baseline WHERE root_id=?1",
            [&consent.root_id],
        )?;
        insert_baseline(&transaction, &consent.root_id, baseline)?;
        transaction.execute(
            "INSERT INTO game_file_root_setup(root_id,updated_at,record_json) VALUES (?1,?2,?3)
             ON CONFLICT(root_id) DO UPDATE SET updated_at=excluded.updated_at, record_json=excluded.record_json",
            params![consent.root_id, consent.updated_at, encoded],
        )?;
        transaction.commit()?;
        Ok(())
    }

    /// Changes an existing choice in place. Returns `None`, changing nothing,
    /// when the choice was turned off meanwhile, so a later write can never
    /// turn it back on.
    fn update_root_setup_consent<R>(
        &self,
        root_id: &str,
        change: impl FnOnce(&mut RootSetupConsent) -> R,
    ) -> Result<Option<(RootSetupConsent, R)>> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let json: Option<String> = transaction
            .query_row(
                "SELECT record_json FROM game_file_root_setup WHERE root_id=?1",
                [root_id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(json) = json else { return Ok(None) };
        let mut consent = decode(root_id, &json)?;
        let result = change(&mut consent);
        if consent.failures.len() > MAX_ROOT_SETUP_FAILURES {
            let excess = consent.failures.len() - MAX_ROOT_SETUP_FAILURES;
            consent.failures.drain(..excess);
        }
        consent.updated_at = Self::now();
        transaction.execute(
            "UPDATE game_file_root_setup SET updated_at=?2, record_json=?3 WHERE root_id=?1",
            params![root_id, consent.updated_at, encode(&consent)?],
        )?;
        transaction.commit()?;
        Ok(Some((consent, result)))
    }

    /// Ends automatic setup for a folder. Installed games are not changed.
    pub fn remove_root_setup_consent(&self, root_id: &str) -> Result<bool> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute(
            "DELETE FROM game_file_root_setup_baseline WHERE root_id=?1",
            [root_id],
        )?;
        let removed = transaction.execute(
            "DELETE FROM game_file_root_setup WHERE root_id=?1",
            [root_id],
        )? > 0;
        transaction.commit()?;
        Ok(removed)
    }

    /// Before a future-only folder moves to `new_path`, remembers the files
    /// already there, so relinking never enrolls existing content. If the new
    /// location cannot be listed, automatic setup for the folder is turned off.
    pub(crate) fn prepare_root_setup_for_relink(
        &self,
        root_id: &str,
        new_path: &Path,
    ) -> Result<()> {
        let Some(consent) = self.root_setup_consent(root_id).ok().flatten() else {
            // No readable choice: an unreadable one must not survive the move.
            if self.root_setup_consent(root_id).is_err() {
                self.remove_root_setup_consent(root_id)?;
            }
            return Ok(());
        };
        if consent.enrollment != RootSetupEnrollment::FutureOnly {
            return Ok(());
        }
        match folder_files(new_path) {
            Ok(identities) => {
                let mut connection = self.connection()?;
                let transaction =
                    connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
                insert_baseline(&transaction, root_id, &identities)?;
                let count: i64 = transaction.query_row(
                    "SELECT count(*) FROM game_file_root_setup_baseline WHERE root_id=?1 AND identity LIKE 'p:%'",
                    [root_id],
                    |row| row.get(0),
                )?;
                transaction.commit()?;
                self.update_root_setup_consent(root_id, |consent| {
                    consent.existing_files = u32::try_from(count).unwrap_or(u32::MAX);
                })?;
            }
            Err(error) => {
                tracing::warn!(root_id, error = %error.message, "turning off folder setup after relinking to a folder that could not be listed");
                self.remove_root_setup_consent(root_id)?;
            }
        }
        Ok(())
    }
}

/// What a folder pass found for one matched file.
enum RootCandidate {
    Setup { port_id: String },
    Waiting(RootSetupWaiting),
    Skip,
}

enum RootSetupOutcome {
    Started(InstallBatchRecord),
    Waiting(String),
    /// Could not register the files or run the install; recorded and counted.
    Failed(String),
    Skipped,
}

impl PortcoveService {
    /// Turns on automatic setup for one saved folder. `future_only` lists the
    /// folder now and remembers every file in it, so only games whose files
    /// arrive later are enrolled.
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
            RootSetupEnrollment::ExistingAndFuture => BTreeSet::new(),
            RootSetupEnrollment::FutureOnly => {
                if root.availability != crate::GameFileRootAvailability::Available {
                    return Err(PortcoveError::usage(
                        "reconnect this folder first, so Portcove knows which games are already there",
                    )
                    .detail("root_id", root_id));
                }
                folder_files(&root.path)?
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
            existing_files: u32::try_from(
                baseline
                    .iter()
                    .filter(|identity| identity.starts_with("p:"))
                    .count(),
            )
            .unwrap_or(u32::MAX),
            implementations,
            failures: Vec::new(),
        };
        self.library
            .replace_root_setup_consent(&consent, &baseline)?;
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
        self.library
            .update_root_setup_consent(root_id, |consent| {
                consent
                    .implementations
                    .retain(|choice| choice.profile_id != profile_id);
                consent.implementations.push(RootSetupImplementation {
                    profile_id: profile_id.to_owned(),
                    port_id: port_id.to_owned(),
                });
            })?
            .map(|(consent, ())| consent)
            .ok_or_else(|| {
                PortcoveError::usage("turn on automatic setup for this folder first")
                    .detail("root_id", root_id)
            })
    }

    /// Turns off automatic setup for a folder. Installed games stay installed.
    pub fn remove_root_setup_consent(&self, root_id: &str) -> Result<bool> {
        self.library.remove_root_setup_consent(root_id)
    }

    pub fn root_setup_consents(&self) -> Result<Vec<RootSetupConsent>> {
        self.library.root_setup_consents()
    }

    /// Whether this file is still enrolled by the folder's current choice.
    /// Read fresh, so turning the choice off or narrowing it takes effect
    /// before the next registration or install.
    fn still_enrolled(
        &self,
        root_id: &str,
        root_path: &Path,
        candidate: &SourceRecord,
    ) -> Result<bool> {
        let Some(consent) = self.library.root_setup_consent(root_id)? else {
            return Ok(false);
        };
        Ok(match consent.enrollment {
            RootSetupEnrollment::ExistingAndFuture => true,
            RootSetupEnrollment::FutureOnly => match current_identities(root_path, &candidate.path)
            {
                Some(identities) => !self
                    .library
                    .root_setup_baseline_contains_any(root_id, &identities)?,
                // A file that can't be checked now is not enrolled now.
                None => false,
            },
        })
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
        let mut considered = 0;
        for consent in consents {
            // An unavailable folder is not deleted content; it simply waits.
            let Some(root) = roots.iter().find(|root| {
                root.id == consent.root_id
                    && root.availability == crate::GameFileRootAvailability::Available
            }) else {
                continue;
            };
            for candidate in &snapshot.report.candidates {
                if started >= MAX_ROOT_SETUPS_PER_PASS || considered >= MAX_ROOT_CANDIDATES_PER_PASS
                {
                    return Ok(waiting);
                }
                if !candidate.path.starts_with(&root.path) {
                    continue;
                }
                // Checking the boundary reads the file (or game folder), so it
                // counts toward the per-pass bound.
                considered += 1;
                if !self.still_enrolled(&root.id, &root.path, candidate)? {
                    continue;
                }
                let port_id = match self.root_candidate(&consent, candidate, busy, handled) {
                    RootCandidate::Skip => continue,
                    RootCandidate::Waiting(item) => {
                        if waiting.len() < MAX_ROOT_SETUP_WAITING {
                            waiting.push(item);
                        }
                        continue;
                    }
                    RootCandidate::Setup { port_id } => port_id,
                };
                let outcome = match self
                    .root_setup_one(&root.id, &root.path, candidate, &port_id, emit)
                    .await
                {
                    Ok(outcome) => outcome,
                    Err(error) => RootSetupOutcome::Failed(error.message),
                };
                match outcome {
                    RootSetupOutcome::Started(record) => {
                        handled.insert(port_id);
                        started += 1;
                        batches.push(record);
                    }
                    // Another copy of the same game's files may still work.
                    RootSetupOutcome::Waiting(reason) => {
                        if waiting.len() < MAX_ROOT_SETUP_WAITING {
                            waiting.push(RootSetupWaiting {
                                root_id: root.id.clone(),
                                profile_id: candidate.profile_id.clone(),
                                port_id: Some(port_id),
                                reason,
                            });
                        }
                    }
                    RootSetupOutcome::Failed(reason) => {
                        handled.insert(port_id.clone());
                        failures.push(crate::StandingSetupFailure { port_id, reason });
                    }
                    RootSetupOutcome::Skipped => {}
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
                // A game the player asked to set up when ready is handled by
                // its own choice; folder consent never adds another fork.
                let set_up_elsewhere = ports.iter().any(|port_id| {
                    self.library
                        .port_intent(port_id)
                        .ok()
                        .flatten()
                        .is_some_and(|intent| intent.mode == PortIntentMode::SetUpWhenReady)
                });
                if set_up_elsewhere {
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
        // Earlier work for this game must recover before anything new starts.
        if self
            .library
            .has_unfinished_lifecycle(&port_id)
            .unwrap_or(true)
        {
            return waiting(
                Some(port_id),
                "earlier work for this game hasn't finished recovering",
            );
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
        let Some(consent) = self.library.root_setup_consent(root_id)? else {
            return Ok(RootSetupOutcome::Skipped);
        };
        let exhausted = |attempt: &str| {
            consent.failures.iter().any(|failure| {
                failure.port_id == port_id
                    && failure.plan_sha256 == attempt
                    && failure.attempts >= crate::MAX_STANDING_SETUP_ATTEMPTS
            })
        };
        let source_key = source_attempt(candidate);
        if exhausted(&source_key) {
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
                if let Err(error) = self.register_in_folder(root_id, root_path, candidate) {
                    if error.code == crate::ErrorCode::Conflict {
                        return Ok(RootSetupOutcome::Waiting(error.message));
                    }
                    self.remember_root_failure(root_id, port_id, &source_key, &error.message);
                    return Ok(RootSetupOutcome::Failed(error.message));
                }
            }
        }
        // Planning problems (offline, the game busy with another task, a
        // missing requirement) are waits, never counted failures.
        let plan = match self.plan_game_install(port_id).await {
            Ok(plan) => plan,
            Err(error) => return Ok(RootSetupOutcome::Waiting(error.message)),
        };
        if let Some(reason) = self.install_plan_hold(&plan) {
            return Ok(RootSetupOutcome::Waiting(reason));
        }
        if exhausted(&plan.plan_sha256) {
            return Ok(RootSetupOutcome::Skipped);
        }
        if !self.still_enrolled(root_id, root_path, candidate)? {
            return Ok(RootSetupOutcome::Skipped);
        }
        let batch = match self.start_install_batch(
            &[InstallBatchRequestItem {
                port_id: port_id.to_owned(),
                expected_plan_sha256: plan.plan_sha256.clone(),
            }],
            LibraryMembershipOrigin::GameFileDiscovery,
        ) {
            Ok(batch) => batch,
            Err(error) if error.code == crate::ErrorCode::Conflict => {
                return Ok(RootSetupOutcome::Waiting(error.message));
            }
            Err(error) => {
                self.remember_root_failure(root_id, port_id, &plan.plan_sha256, &error.message);
                return Ok(RootSetupOutcome::Failed(error.message));
            }
        };
        let record = match self.run_install_batch(&batch.id, &mut *emit).await {
            Ok(record) => record,
            Err(error) => {
                self.remember_root_failure(root_id, port_id, &plan.plan_sha256, &error.message);
                return Ok(RootSetupOutcome::Failed(error.message));
            }
        };
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
                    if let Err(error) = self.library.update_root_setup_consent(root_id, |consent| {
                        consent
                            .failures
                            .retain(|failure| failure.port_id != port_id);
                    }) {
                        tracing::warn!(root_id, error = %error.message, "could not clear a folder setup failure");
                    }
                }
                _ => {}
            }
        }
        Ok(RootSetupOutcome::Started(record))
    }

    /// Registers a matched file where it is, after checking its current bytes,
    /// only while it is inside the folder and still enrolled.
    fn register_in_folder(
        &self,
        root_id: &str,
        root_path: &Path,
        candidate: &SourceRecord,
    ) -> Result<()> {
        let plan = self.plan_source_import(
            &candidate.profile_id,
            &candidate.path,
            SourceImportMode::UseCurrentLocation,
        )?;
        let inside = |path: &Path| {
            std::fs::canonicalize(path)
                .ok()
                .zip(std::fs::canonicalize(root_path).ok())
                .is_some_and(|(path, root): (PathBuf, PathBuf)| path.starts_with(root))
        };
        if plan.source.sha256 != candidate.sha256 {
            self.library.forget_game_file_observation(&candidate.path);
            return Err(PortcoveError::conflict(
                "these files changed since the last scan; scan again",
            ));
        }
        if !inside(&plan.source.path) {
            return Err(PortcoveError::conflict(
                "these files are no longer inside the folder; scan again",
            ));
        }
        if !self.still_enrolled(root_id, root_path, candidate)? {
            return Err(PortcoveError::conflict(
                "automatic setup for this folder changed; nothing was registered",
            ));
        }
        self.import_source(
            &candidate.profile_id,
            &candidate.path,
            SourceImportMode::UseCurrentLocation,
            &plan.plan_sha256,
            None,
        )?;
        Ok(())
    }

    /// Counts a failed attempt for one game and plan (or file). Best effort:
    /// if it can't be recorded, a later pass tries again within the limits.
    fn remember_root_failure(&self, root_id: &str, port_id: &str, attempt: &str, reason: &str) {
        let reason = reason.chars().take(512).collect::<String>();
        let result = self.library.update_root_setup_consent(root_id, |consent| {
            match consent
                .failures
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
                None => consent.failures.push(RootSetupFailure {
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

/// Entries a folder-shaped game is matched through, at most.
const MAX_DIRECTORY_MEMBERS: usize = 1024;

/// The boundary identities of a matched file or game folder as it is now, or
/// `None` if it can't be read. A game folder that existed, or that holds a
/// file that existed (even renamed or moved), counts as already there.
fn current_identities(root_path: &Path, path: &Path) -> Option<Vec<String>> {
    let relative = path.strip_prefix(root_path).ok()?;
    let metadata = std::fs::symlink_metadata(path).ok()?;
    if metadata.is_file() {
        return file_identities(relative, &metadata).ok();
    }
    if !metadata.is_dir() {
        return None;
    }
    let mut identities = vec![directory_identity(relative).ok()?];
    let mut pending = vec![(path.to_path_buf(), 0usize)];
    let mut entries = 0;
    while let Some((directory, depth)) = pending.pop() {
        for entry in std::fs::read_dir(&directory).ok()? {
            // Bounded by entries and depth; what was read is enough to match.
            entries += 1;
            if entries > MAX_DIRECTORY_MEMBERS {
                return Some(identities);
            }
            let entry_path = entry.ok()?.path();
            let entry_metadata = std::fs::symlink_metadata(&entry_path).ok()?;
            if entry_metadata.is_dir() {
                if depth < MAX_BASELINE_DEPTH {
                    pending.push((entry_path, depth + 1));
                }
            } else if entry_metadata.is_file() {
                identities.extend(
                    file_identities(entry_path.strip_prefix(root_path).ok()?, &entry_metadata)
                        .ok()?,
                );
            }
        }
    }
    Some(identities)
}

/// The failure key for a file that could not be registered: changed bytes
/// make a new attempt.
fn source_attempt(source: &SourceRecord) -> String {
    format!("source:{}:{}", source.profile_id, source.sha256)
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
        let folder = temporary.path().join("games");
        std::fs::create_dir(&folder).unwrap();
        // Use the folder as Core stores it (canonical; `\\?\` on Windows), as
        // a real scan reports matched files under it.
        let saved = service.library().add_game_file_root(&folder).unwrap();
        let (root_id, root) = (saved.id, saved.path);
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
        /// A matched file present in the folder on disk.
        fn file(&self, name: &str, byte: char) -> SourceRecord {
            self.file_in(&self.root, name, byte)
        }

        fn file_in(&self, directory: &Path, name: &str, byte: char) -> SourceRecord {
            let sha256 = byte.to_string().repeat(64);
            let path = directory.join(name);
            // Distinct sizes, so files never share an identity by chance.
            let size = 4 + usize::from(byte as u8 - b'a');
            std::fs::write(&path, byte.to_string().repeat(size)).unwrap();
            SourceRecord {
                profile_id: self.profile.clone(),
                path,
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
        assert_eq!(consent.existing_files, 1);
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
    async fn future_only_remembers_files_the_catalog_did_not_recognize_yet() {
        let folder = folder();
        // The file is in the folder, but no scan has matched it yet.
        let existing = folder.file("old.z64", 'a');
        folder.in_use(&existing);
        folder.scanned(Vec::new());
        folder.consent(RootSetupEnrollment::FutureOnly);
        // A catalog update later recognizes it: it is still existing content.
        folder.scanned(vec![existing]);
        for _ in 0..2 {
            assert!(folder.pass().await.batches.is_empty());
        }
        assert!(!folder.installed());
    }

    #[tokio::test]
    async fn renaming_or_moving_an_existing_file_does_not_enroll_it() {
        let folder = folder();
        let existing = folder.file("zelda.z64", 'a');
        folder.consent(RootSetupEnrollment::FutureOnly);
        let nested = folder.root.join("N64");
        std::fs::create_dir(&nested).unwrap();
        let moved = nested.join("Zelda (USA).z64");
        std::fs::rename(&existing.path, &moved).unwrap();
        let renamed = SourceRecord {
            path: moved,
            ..existing
        };
        folder.in_use(&renamed);
        folder.scanned(vec![renamed]);
        assert!(folder.pass().await.batches.is_empty());
        assert!(!folder.installed());
    }

    #[tokio::test]
    async fn games_stored_as_folders_follow_the_same_boundary() {
        let folder = folder();
        let old_game = folder.root.join("Old Game");
        std::fs::create_dir(&old_game).unwrap();
        let old_member = folder.file_in(&old_game, "data.bin", 'a');
        folder.consent(RootSetupEnrollment::FutureOnly);
        let existing = SourceRecord {
            path: old_game,
            ..old_member
        };
        folder.in_use(&existing);
        folder.scanned(vec![existing]);
        assert!(folder.pass().await.batches.is_empty());
        // A game folder added later is new content and is set up.
        let new_game = folder.root.join("New Game");
        std::fs::create_dir(&new_game).unwrap();
        let new_member = folder.file_in(&new_game, "data.bin", 'b');
        let added = SourceRecord {
            path: new_game,
            ..new_member
        };
        folder.in_use(&added);
        folder.scanned(vec![added]);
        assert_eq!(folder.pass().await.batches.len(), 1);
    }

    #[tokio::test]
    async fn relinking_never_enrolls_what_is_already_at_the_new_location() {
        let folder = folder();
        folder.consent(RootSetupEnrollment::FutureOnly);
        let moved = folder._temporary.path().join("moved");
        std::fs::create_dir(&moved).unwrap();
        let moved = std::fs::canonicalize(&moved).unwrap();
        let existing = folder.file_in(&moved, "old.z64", 'a');
        folder.in_use(&existing);
        let relinked = folder
            .service
            .library()
            .relink_game_file_root(&folder.root_id, &moved)
            .unwrap();
        assert_eq!(relinked.path, moved);
        folder.scanned(vec![existing.clone()]);
        assert!(folder.pass().await.batches.is_empty());
        assert!(!folder.installed());
        assert_eq!(
            folder.service.root_setup_consents().unwrap()[0].existing_files,
            1
        );
        // A file added after the move is new content.
        let later = folder.file_in(&moved, "new.z64", 'b');
        folder.in_use(&later);
        folder.scanned(vec![existing, later]);
        assert_eq!(folder.pass().await.batches.len(), 1);
    }

    #[tokio::test]
    async fn a_busy_game_waits_without_counting_a_failure() {
        let folder = folder();
        let file = folder.file("game.z64", 'a');
        folder.in_use(&file);
        folder.scanned(vec![file]);
        folder.consent(RootSetupEnrollment::ExistingAndFuture);
        {
            let _busy = folder
                .service
                .library()
                .try_lock_port(PORT, "test")
                .unwrap();
            for _ in 0..=crate::MAX_STANDING_SETUP_ATTEMPTS {
                let result = folder.pass().await;
                assert!(
                    result.batches.is_empty() && result.failures.is_empty(),
                    "{result:?}"
                );
                assert_eq!(result.root_waiting.len(), 1);
            }
        }
        assert!(
            folder.service.root_setup_consents().unwrap()[0]
                .failures
                .is_empty()
        );
        assert_eq!(folder.pass().await.batches.len(), 1);
        assert!(folder.installed());
    }

    #[tokio::test]
    async fn turning_folder_setup_off_cannot_be_undone_by_a_later_choice() {
        let folder = folder();
        folder.consent(RootSetupEnrollment::ExistingAndFuture);
        assert!(
            folder
                .service
                .remove_root_setup_consent(&folder.root_id)
                .unwrap()
        );
        assert!(
            folder
                .service
                .set_root_setup_implementation(&folder.root_id, &folder.profile, PORT)
                .is_err()
        );
        assert!(folder.service.root_setup_consents().unwrap().is_empty());
    }

    #[tokio::test]
    async fn future_only_needs_the_folder_to_be_available() {
        let folder = folder();
        std::fs::remove_dir(&folder.root).unwrap();
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
        std::fs::remove_dir_all(&folder.root).unwrap();
        assert!(folder.pass().await.batches.is_empty());
        assert_eq!(folder.service.root_setup_consents().unwrap().len(), 1);
        std::fs::create_dir(&folder.root).unwrap();
        folder.file("game.z64", 'a');
        assert_eq!(folder.pass().await.batches.len(), 1);
    }
}
