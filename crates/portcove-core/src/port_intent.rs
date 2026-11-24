//! Remembered per-game intent and standing setup.
//!
//! A port intent records what the player asked Portcove to do about one game
//! over time: only discover it (the default, stored as no record), tell them
//! when it becomes ready, set it up when ready, or ignore it. It also
//! remembers an explicit uninstall so the game is not set up again without a
//! new choice. An intent is consent policy, never an authorization: every
//! standing setup re-plans the game, checks the intent again, and obtains the
//! ordinary operation-specific authorization immediately before it acts.

use rusqlite::{OptionalExtension, TransactionBehavior, params};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{
    InstallBatchItemState, InstallBatchRecord, InstallBatchRequestItem, Library,
    LibraryMembershipOrigin, OperationEvent, PortcoveError, PortcoveService, Result,
};

pub const PORT_INTENT_FORMAT_VERSION: u8 = 1;
/// Largest number of intents reassessed in one pass. Intents beyond it are
/// reported as not assessed rather than silently dropped.
pub const MAX_PORT_INTENT_ASSESSMENTS: usize = 512;
const MAX_RECORD_BYTES: usize = 16 * 1024;
/// Standing setup tries one unchanged plan at most this many times (across
/// passes, which happen at startup and on changes). A changed plan starts over.
pub const MAX_STANDING_SETUP_ATTEMPTS: u32 = 3;
/// Wall-clock budget one unattended pass (standing or folder setup) gives a
/// single game before it asks that game's install to stop at its cancellation
/// boundary and moves on. Received bytes stay in the partial-download store
/// and continue on the next pass, so a slow or trickling host cannot occupy
/// the single unattended worker for days while other ready games wait. A
/// resource budget for one bounded unit of work (class 3); it never ends the
/// game's setup, and installs the player starts are never under it.
pub const STANDING_SETUP_GAME_BUDGET: std::time::Duration =
    std::time::Duration::from_secs(4 * 60 * 60);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PortIntentMode {
    /// Portcove may show the game in discovery results. Nothing else happens.
    DiscoverOnly,
    /// Tell the player when the game becomes ready to install, again only if
    /// its ready plan changes.
    Notify,
    /// Install the game when it is ready, without another confirmation, as
    /// long as this choice stands. Never launches it.
    SetUpWhenReady,
    /// Do not suggest or set up this game.
    Ignored,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PortIntent {
    pub format_version: u8,
    pub port_id: String,
    pub mode: PortIntentMode,
    pub updated_at: i64,
    /// Set when the player uninstalled the game. Standing setup and
    /// notifications stay quiet until the player chooses a mode again.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub explicitly_uninstalled_at: Option<i64>,
    /// The ready plan the player was last told about; a notification repeats
    /// only when the ready plan changes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acknowledged_plan_sha256: Option<String>,
    /// The plan whose standing setup last failed, and how many times it has
    /// failed for a lasting reason. It is retried on later passes up to a
    /// small limit, then waits until the plan changes, so a permanent failure
    /// does not recur. Temporary failures never count here; see
    /// `temporary_retry`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failed_plan_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub failed_attempts: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure: Option<String>,
    /// Set when the last failure of `failed_plan_sha256` came from a passing
    /// condition (network, provider limit or outage, full disk, interruption).
    /// The same plan runs again after its back-off, without an upstream change.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temporary_retry: Option<crate::TemporaryRetry>,
    /// Set when `failed_attempts` was counted by a Portcove that separates
    /// temporary from lasting failures. A record that reached the limit
    /// before that (it may have counted network outages) gets one more
    /// attempt after upgrade; its next failure is classified normally.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub failure_classified: bool,
    /// The release channel chosen with this choice. A different channel later
    /// waits for the player to choose again.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel: Option<crate::ReleaseChannel>,
    /// The registered copies of this game's files when the choice was made.
    /// A different or removed copy later waits for the player; it is never
    /// silently retargeted. Empty when no files were registered yet: the first
    /// files that arrive are used.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sources: Vec<PortIntentSource>,
}

/// One registered copy a remembered choice is bound to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PortIntentSource {
    pub profile_id: String,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum PortReadiness {
    /// Installed already; standing setup never reinstalls or updates it.
    Installed {
        install_id: String,
        /// The installed game's maintenance state under its own update policy.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        maintenance: Option<PortMaintenance>,
    },
    /// A first install could start now with this exact plan.
    Ready {
        plan_sha256: String,
        version: String,
    },
    /// Something is missing or needs a person; the reason says what.
    Waiting { reason: String },
}

/// An installed game's maintenance state, read from its saved channel and
/// update policy and its last update check. Assessing it downloads, stages or
/// activates nothing; the existing update check and policy own that.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct PortMaintenance {
    pub channel: crate::ReleaseChannel,
    pub update_policy: crate::UpdatePolicy,
    pub active_version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub staged_version: Option<String>,
    /// A newer release the last check found on this channel, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub available_version: Option<String>,
    /// Identity of that release, used to announce it once.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub available_sha256: Option<String>,
    /// The earlier version Portcove keeps for this game, if any. Whether a
    /// rollback to it is allowed right now is decided by the game's actions.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_version: Option<String>,
    /// The game is running or its launch must recover, an update is
    /// downloading or verifying, or an install, update or data change for it
    /// is unfinished or must recover; maintenance waits for it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub busy: bool,
    /// When updates were last checked for this install on this channel;
    /// `None` means not yet.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checked_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct PortIntentAssessment {
    pub port_id: String,
    pub mode: PortIntentMode,
    pub readiness: PortReadiness,
    /// Why this intent will not act or notify right now, if it won't.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suppressed: Option<String>,
    /// While a temporary failure waits: the Unix-second instant of the next
    /// automatic attempt. Each surface shows it in its own form.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_attempt_at: Option<i64>,
    /// Ready with a plan, or installed with an update, the player has not
    /// been told about yet.
    pub newly_ready: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct PortIntentAssessments {
    pub assessments: Vec<PortIntentAssessment>,
    /// Intents left for a later pass because one pass is bounded.
    pub not_assessed: u32,
    /// Whether the player wants ready notices. While off, a game set to be
    /// told is never reported as newly ready; nothing about its choice or its
    /// readiness changes, and set-up-when-ready games are unaffected.
    #[serde(default = "ready_notices_default")]
    pub ready_notices_enabled: bool,
}

fn ready_notices_default() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PortReadinessAcknowledgement {
    pub port_id: String,
    pub plan_sha256: String,
}

fn is_zero(value: &u32) -> bool {
    *value == 0
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct StandingSetupFailure {
    pub port_id: String,
    pub reason: String,
}

/// What one standing pass did for the games and mods it considered.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct StandingSetupResult {
    /// Another process is already running a pass; this one did nothing.
    pub already_running: bool,
    pub assessments: Vec<PortIntentAssessment>,
    pub not_assessed: u32,
    /// One single-game batch per game that started, in order.
    pub batches: Vec<InstallBatchRecord>,
    /// Games that could not start; the others were not affected.
    pub failures: Vec<StandingSetupFailure>,
    /// The game setup queue could not be read. Mod updates still ran.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub game_setup_unavailable: Option<String>,
    /// Matched files in folders with automatic setup that wait for a person
    /// or a requirement.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub root_waiting: Vec<crate::RootSetupWaiting>,
    /// Provider updates for mod setups whose policy allows unattended updates.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mod_updates: Vec<crate::ProviderAutoUpdate>,
}

impl PortIntent {
    fn new(port_id: &str, mode: PortIntentMode, now: i64) -> Self {
        Self {
            format_version: PORT_INTENT_FORMAT_VERSION,
            port_id: port_id.to_owned(),
            mode,
            updated_at: now,
            explicitly_uninstalled_at: None,
            acknowledged_plan_sha256: None,
            failed_plan_sha256: None,
            failed_attempts: 0,
            failure: None,
            temporary_retry: None,
            failure_classified: false,
            channel: None,
            sources: Vec::new(),
        }
    }

    fn clear_failure(&mut self) {
        self.failed_plan_sha256 = None;
        self.failed_attempts = 0;
        self.failure = None;
        self.temporary_retry = None;
        self.failure_classified = false;
    }

    /// The lasting attempt limit for this plan has been reached. A record
    /// from before classification is not trusted to have reached it.
    fn exhausted(&self, plan_sha256: &str) -> bool {
        self.failed_plan_sha256.as_deref() == Some(plan_sha256)
            && self.failed_attempts >= MAX_STANDING_SETUP_ATTEMPTS
            && self.failure_classified
    }
}

fn decode(port_id: &str, json: &str) -> Result<PortIntent> {
    let record: PortIntent = serde_json::from_str(json).map_err(|error| {
        PortcoveError::state("stored game intent is invalid")
            .detail("port_id", port_id)
            .detail("cause", error.to_string())
    })?;
    if record.format_version != PORT_INTENT_FORMAT_VERSION || record.port_id != port_id {
        return Err(
            PortcoveError::state("stored game intent has an unsupported contract")
                .detail("port_id", port_id),
        );
    }
    Ok(record)
}

type IntentAssessmentRow = (String, String);

struct IntentAssessmentPass {
    rows: Vec<IntentAssessmentRow>,
    total: usize,
    revision: i64,
}

#[derive(Clone, Copy)]
enum IntentAssessmentPurpose {
    Readiness,
    StandingSetup,
}

impl IntentAssessmentPurpose {
    fn key(self) -> &'static str {
        match self {
            Self::Readiness => "readiness",
            Self::StandingSetup => "standing_setup",
        }
    }
}

const ASSESSABLE_INTENTS: &str =
    "CASE WHEN typeof(record_json) = 'text' AND json_valid(record_json)
    THEN json_extract(record_json, '$.mode') IN ('notify', 'set_up_when_ready')
    ELSE 0 END";

impl Library {
    /// Whether this game has a lifecycle operation (an install, update or
    /// data change) that hasn't finished or recovered yet. Such a game is left
    /// to recovery; nothing new starts for it.
    pub(crate) fn has_unfinished_lifecycle(&self, port_id: &str) -> Result<bool> {
        Ok(self.connection()?.query_row(
            // A retained update download is not unfinished work; it waits for
            // the player's review and never needs recovery.
            "SELECT EXISTS(SELECT 1 FROM lifecycle_operations
             WHERE port_id=?1 AND kind<>'acquire_update')",
            [port_id],
            |row| row.get(0),
        )?)
    }

    pub fn port_intents(&self) -> Result<Vec<PortIntent>> {
        let connection = self.connection()?;
        let mut statement =
            connection.prepare("SELECT port_id, record_json FROM port_intents ORDER BY port_id")?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        // One unreadable record must not hide every other choice. It is
        // skipped here and replaced the next time the player chooses a mode.
        Ok(rows
            .iter()
            .filter_map(|(id, json)| match decode(id, json) {
                Ok(intent) => Some(intent),
                Err(error) => {
                    tracing::warn!(port_id = %id, error = %error.message, "skipping unreadable game intent");
                    None
                }
            })
            .collect())
    }

    fn intent_assessment_pass(
        &self,
        purpose: IntentAssessmentPurpose,
    ) -> Result<IntentAssessmentPass> {
        let mut connection = self.connection()?;
        let snapshot = connection.transaction()?;
        let (cursor, revision): (String, i64) = snapshot
            .query_row(
                "SELECT port_id, revision FROM port_intent_assessment_cursor WHERE purpose=?1",
                [purpose.key()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?
            .unwrap_or_default();
        let (total, invalid_storage): (usize, usize) = snapshot.query_row(
            &format!(
                "SELECT COUNT(*) FILTER (WHERE {ASSESSABLE_INTENTS}),
                        COUNT(*) FILTER (WHERE typeof(port_id) <> 'text'
                                               OR typeof(record_json) <> 'text')
                 FROM port_intents"
            ),
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if invalid_storage != 0 {
            return Err(PortcoveError::verification(
                "The remembered game queue contains a record stored in an unsupported format.",
            ));
        }
        let start = if total > MAX_PORT_INTENT_ASSESSMENTS {
            cursor.as_str()
        } else {
            ""
        };
        let mut rows = Vec::with_capacity(total.min(MAX_PORT_INTENT_ASSESSMENTS));
        for range in ["port_id > ?1", "port_id <= ?1"] {
            let remaining = MAX_PORT_INTENT_ASSESSMENTS - rows.len();
            if remaining == 0 {
                break;
            }
            let mut statement = snapshot.prepare(&format!(
                "SELECT port_id, record_json FROM port_intents
                 WHERE {range} AND {ASSESSABLE_INTENTS} ORDER BY port_id LIMIT ?2"
            ))?;
            let selected = statement.query_map(params![start, remaining], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })?;
            rows.extend(selected.collect::<rusqlite::Result<Vec<_>>>()?);
        }
        snapshot.commit()?;
        Ok(IntentAssessmentPass {
            rows,
            total,
            revision,
        })
    }

    fn advance_intent_assessment(
        &self,
        purpose: IntentAssessmentPurpose,
        revision: i64,
        last_port: &str,
    ) -> Result<()> {
        self.connection()?.execute(
            "INSERT INTO port_intent_assessment_cursor (port_id, revision, purpose)
             VALUES (?1, ?2, ?3)
             ON CONFLICT (purpose) DO UPDATE SET port_id=excluded.port_id, revision=excluded.revision
             WHERE port_intent_assessment_cursor.revision=?4",
            params![last_port, revision.wrapping_add(1), purpose.key(), revision],
        )?;
        Ok(())
    }

    /// Whether ready notices are shown. On unless the player turned them off.
    pub fn ready_notices_enabled(&self) -> Result<bool> {
        let enabled: Option<i64> = self
            .connection()?
            .query_row(
                "SELECT enabled FROM ready_notice_preference WHERE id=1",
                [],
                |row| row.get(0),
            )
            .optional()?;
        Ok(enabled != Some(0))
    }

    /// Turns ready notices on or off. Changes no game's choice and
    /// acknowledges nothing, so turning them on again announces games that are
    /// ready and were not yet announced.
    pub fn set_ready_notices_enabled(&self, enabled: bool) -> Result<()> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute(
            "INSERT INTO ready_notice_preference(id,enabled,updated_at) VALUES (1,?1,?2)
             ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled, updated_at=excluded.updated_at",
            params![i64::from(enabled), Self::now()],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn port_intent(&self, port_id: &str) -> Result<Option<PortIntent>> {
        let json: Option<String> = self
            .connection()?
            .query_row(
                "SELECT record_json FROM port_intents WHERE port_id=?1",
                [port_id],
                |row| row.get(0),
            )
            .optional()?;
        json.map(|json| decode(port_id, &json)).transpose()
    }

    /// Read-modify-write one intent under an immediate transaction, so two
    /// processes cannot lose each other's choice or outcome.
    pub(crate) fn update_port_intent<R>(
        &self,
        port_id: &str,
        change: impl FnOnce(&mut Option<PortIntent>, i64) -> R,
    ) -> Result<R> {
        self.update_port_intent_with(port_id, false, change)
    }

    /// `replace_invalid` lets a new explicit choice overwrite a record that no
    /// longer decodes; outcome updates never do.
    fn update_port_intent_with<R>(
        &self,
        port_id: &str,
        replace_invalid: bool,
        change: impl FnOnce(&mut Option<PortIntent>, i64) -> R,
    ) -> Result<R> {
        if port_id.is_empty() || port_id.len() > 128 {
            return Err(PortcoveError::usage("game id must be 1 to 128 characters"));
        }
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let json: Option<String> = transaction
            .query_row(
                "SELECT record_json FROM port_intents WHERE port_id=?1",
                [port_id],
                |row| row.get(0),
            )
            .optional()?;
        let mut record = match json.map(|json| decode(port_id, &json)).transpose() {
            Ok(record) => record,
            Err(_) if replace_invalid => None,
            Err(error) => return Err(error),
        };
        let now = Self::now();
        let result = change(&mut record, now);
        match record {
            Some(mut record) => {
                record.updated_at = now;
                let encoded = serde_json::to_string(&record)?;
                if encoded.len() > MAX_RECORD_BYTES {
                    return Err(PortcoveError::state(
                        "game intent exceeds its storage limit",
                    ));
                }
                transaction.execute(
                    "INSERT INTO port_intents(port_id,updated_at,record_json) VALUES (?1,?2,?3)
                     ON CONFLICT(port_id) DO UPDATE SET updated_at=excluded.updated_at, record_json=excluded.record_json",
                    params![port_id, now, encoded],
                )?;
            }
            None => {
                transaction.execute("DELETE FROM port_intents WHERE port_id=?1", [port_id])?;
            }
        }
        transaction.commit()?;
        Ok(result)
    }

    /// Remembers that the player uninstalled this game, so standing setup and
    /// notifications do not bring it back without a new choice.
    pub(crate) fn record_explicit_uninstall(&self, port_id: &str) -> Result<()> {
        // An uninstall is an explicit decision, so it replaces an unreadable
        // record rather than blocking the removal.
        self.update_port_intent_with(port_id, true, |record, now| {
            let intent = record
                .get_or_insert_with(|| PortIntent::new(port_id, PortIntentMode::DiscoverOnly, now));
            intent.explicitly_uninstalled_at = Some(now);
        })
    }
}

impl PortcoveService {
    /// Records the player's choice for one game. A new choice clears an earlier
    /// uninstall and failure memory. Choosing set-up-when-ready also saves the
    /// game to the Library; nothing is installed until a standing-setup pass
    /// finds it ready.
    pub fn set_port_intent(&self, port_id: &str, mode: PortIntentMode) -> Result<PortIntent> {
        // Only a choice that can act needs the game in the catalog; discover-only
        // and ignore can always be chosen, so a removed game's choice can be cleared.
        if matches!(
            mode,
            PortIntentMode::Notify | PortIntentMode::SetUpWhenReady
        ) {
            self.catalog.listing(port_id)?;
        }
        // A choice that can act remembers what it was made with, so later
        // changes wait for the player instead of silently retargeting it.
        let (channel, sources) = if matches!(
            mode,
            PortIntentMode::Notify | PortIntentMode::SetUpWhenReady
        ) {
            self.intent_binding(port_id)?
        } else {
            (None, Vec::new())
        };
        if mode == PortIntentMode::SetUpWhenReady {
            self.add_games_to_library(&[crate::LibraryMembershipRequest {
                port_id: port_id.to_owned(),
                origin: LibraryMembershipOrigin::Manual,
                sources: Vec::new(),
            }])?;
        }
        self.library
            .update_port_intent_with(port_id, true, |record, now| {
                if mode == PortIntentMode::DiscoverOnly {
                    // The default needs no record unless an uninstall must be kept.
                    if record
                        .as_ref()
                        .is_some_and(|intent| intent.explicitly_uninstalled_at.is_some())
                    {
                        let intent = record.as_mut().expect("checked above");
                        intent.mode = mode;
                        intent.clear_failure();
                        return intent.clone();
                    }
                    *record = None;
                    return PortIntent::new(port_id, mode, now);
                }
                let intent = record.get_or_insert_with(|| PortIntent::new(port_id, mode, now));
                intent.mode = mode;
                intent.explicitly_uninstalled_at = None;
                intent.clear_failure();
                intent.channel = channel;
                intent.sources = sources;
                intent.clone()
            })
    }

    pub fn port_intents(&self) -> Result<Vec<PortIntent>> {
        self.library.port_intents()
    }

    /// Whether ready notices are shown; see [`Library::ready_notices_enabled`].
    pub fn ready_notices_enabled(&self) -> Result<bool> {
        self.library.ready_notices_enabled()
    }

    pub fn set_ready_notices_enabled(&self, enabled: bool) -> Result<()> {
        self.library.set_ready_notices_enabled(enabled)
    }

    /// The channel and registered copies a new choice is made with.
    fn intent_binding(
        &self,
        port_id: &str,
    ) -> Result<(Option<crate::ReleaseChannel>, Vec<PortIntentSource>)> {
        let port = self.catalog.port(port_id)?;
        // A status that can't be read now doesn't block saving the choice; it
        // is simply not bound to a channel.
        let channel = self.status(port_id).ok().map(|status| status.channel);
        // Only the game's own files are bound. A shared prerequisite such as a
        // BIOS is checked by the ordinary install review instead.
        let mut sources = Vec::new();
        if let Some(profile_id) = &port.source_profile
            && let Some(source) = self.library.source(profile_id)?
        {
            sources.push(PortIntentSource {
                profile_id: source.profile_id,
                sha256: source.sha256,
            });
        }
        Ok((channel, sources))
    }

    /// Why a remembered choice no longer matches the current channel or
    /// registered files, if it doesn't. The player chooses again to accept them.
    fn intent_binding_hold(&self, intent: &PortIntent) -> Option<String> {
        if let Some(chosen) = intent.channel {
            match self.status(&intent.port_id) {
                Ok(status) if status.channel != chosen => {
                    return Some(format!(
                        "this game's channel changed from {chosen} to {} since you chose this; choose again to set it up from {}",
                        status.channel, status.channel
                    ));
                }
                Ok(_) => {}
                Err(error) => return Some(error.message),
            }
        }
        for bound in &intent.sources {
            match self.library.source(&bound.profile_id) {
                Ok(Some(current)) if current.sha256 == bound.sha256 => {}
                Ok(Some(_)) => {
                    return Some(
                        "a different copy of this game's files is registered now; choose again to set it up with them"
                            .to_owned(),
                    );
                }
                Ok(None) => {
                    return Some(
                        "the files you chose for this game are no longer registered; register them again, or choose again"
                            .to_owned(),
                    );
                }
                Err(error) => return Some(error.message),
            }
        }
        None
    }

    /// Reassesses a bounded pass of remembered choices. Large sets persist
    /// their scheduling order; assessment does not change the saved choice.
    pub async fn assess_port_intents(&self) -> Result<PortIntentAssessments> {
        self.assess_port_intents_for(IntentAssessmentPurpose::Readiness)
            .await
    }

    async fn assess_port_intents_for(
        &self,
        purpose: IntentAssessmentPurpose,
    ) -> Result<PortIntentAssessments> {
        let IntentAssessmentPass {
            rows,
            total,
            revision,
        } = self.library.intent_assessment_pass(purpose)?;
        let ready_notices_enabled = self.library.ready_notices_enabled()?;
        let mut assessments = Vec::with_capacity(rows.len());
        for (port_id, record_json) in &rows {
            let intent = match decode(port_id, record_json) {
                Ok(intent) => intent,
                Err(error) => {
                    tracing::warn!(port_id = %port_id, error = %error.message, "skipping unreadable game intent");
                    continue;
                }
            };
            let mut assessment = self.assess_port_intent(&intent).await;
            if !ready_notices_enabled && assessment.mode == PortIntentMode::Notify {
                assessment.newly_ready = false;
            }
            assessments.push(assessment);
        }
        if total > MAX_PORT_INTENT_ASSESSMENTS
            && let Some((last_port, _)) = rows.last()
        {
            self.library
                .advance_intent_assessment(purpose, revision, last_port)?;
        }
        let not_assessed = total.saturating_sub(rows.len());
        Ok(PortIntentAssessments {
            assessments,
            not_assessed: u32::try_from(not_assessed).unwrap_or(u32::MAX),
            ready_notices_enabled,
        })
    }

    /// Never fails: a game whose state can't be read is reported as waiting
    /// with the reason, so it cannot stop the others.
    async fn assess_port_intent(&self, intent: &PortIntent) -> PortIntentAssessment {
        let readiness = match self
            .library
            .status(&intent.port_id, crate::ReleaseChannel::Stable)
        {
            Ok(status) if status.active.is_none() => match self.intent_binding_hold(intent) {
                Some(reason) => PortReadiness::Waiting { reason },
                None => self.port_readiness(&intent.port_id, status).await,
            },
            Ok(status) => self.port_readiness(&intent.port_id, status).await,
            Err(error) => PortReadiness::Waiting {
                reason: error.message,
            },
        };
        self.assessment(intent, readiness)
    }

    async fn port_readiness(&self, port_id: &str, status: crate::PortStatus) -> PortReadiness {
        if let Some(active) = status.active {
            // A check counts only if it was made for exactly this install on
            // its current channel; applying, reinstalling or rolling back
            // makes an older check stale.
            let current = status.last_update_check.as_ref().filter(|snapshot| {
                snapshot.check.channel == status.channel
                    && snapshot.check.installed_version.as_deref() == Some(active.version.as_str())
                    && snapshot
                        .check
                        .installed_artifact
                        .as_ref()
                        .is_some_and(|artifact| artifact.sha256 == active.artifact.sha256)
                    && snapshot.check.installed_runtime == active.runtime
            });
            // An update already staged is not "available"; it is staged.
            let available = current.filter(|snapshot| {
                snapshot.check.update_available
                    && status.staged.as_ref().is_none_or(|staged| {
                        staged.artifact.sha256 != snapshot.check.release.asset.sha256
                    })
            });
            PortReadiness::Installed {
                maintenance: Some(PortMaintenance {
                    channel: status.channel,
                    update_policy: status.update_policy,
                    active_version: active.version.clone(),
                    staged_version: status.staged.as_ref().map(|staged| staged.version.clone()),
                    available_version: available
                        .map(|snapshot| snapshot.check.release.version.clone()),
                    available_sha256: available
                        .map(|snapshot| snapshot.check.release.asset.sha256.clone()),
                    checked_at: current.map(|snapshot| snapshot.checked_at),
                    previous_version: status
                        .previous
                        .as_ref()
                        .map(|previous| previous.version.clone()),
                    busy: status.acquisition.as_ref().is_some_and(|acquisition| {
                        matches!(
                            acquisition.phase,
                            crate::GameUpdateAcquisitionPhase::Acquiring
                                | crate::GameUpdateAcquisitionPhase::Verifying
                        )
                    }) || self
                        .library
                        .has_unfinished_lifecycle(port_id)
                        .unwrap_or(true)
                        || self
                            .library
                            .launch_session_for_port(port_id)
                            .map_or(true, |session| session.is_some()),
                }),
                install_id: active.id,
            }
        } else if status.external_runtime.is_some() {
            PortReadiness::Waiting {
                reason: "this game is registered from another launcher; Portcove does not install over it".to_owned(),
            }
        } else if self
            .library
            .has_unfinished_lifecycle(port_id)
            .unwrap_or(true)
        {
            PortReadiness::Waiting {
                reason: "earlier work for this game hasn't finished recovering; it must recover before setup can start".to_owned(),
            }
        } else {
            match self.plan_game_install(port_id).await {
                Ok(plan) => match self.install_plan_hold(&plan) {
                    Some(reason) => PortReadiness::Waiting { reason },
                    None => PortReadiness::Ready {
                        version: plan.plan.release.version.clone(),
                        plan_sha256: plan.plan_sha256,
                    },
                },
                Err(error) => PortReadiness::Waiting {
                    reason: error.message,
                },
            }
        }
    }

    fn assessment(&self, intent: &PortIntent, readiness: PortReadiness) -> PortIntentAssessment {
        let mut next_attempt_at = None;
        let suppressed = if intent.explicitly_uninstalled_at.is_some() {
            Some("you uninstalled this game; choose again to set it up or be told".to_owned())
        } else if let PortReadiness::Ready { plan_sha256, .. } = &readiness
            && intent.exhausted(plan_sha256)
        {
            Some(format!(
                "setup failed {} times with this plan{}; it will try again when the game's files, catalog or requirements change",
                intent.failed_attempts,
                intent
                    .failure
                    .as_deref()
                    .map(|failure| format!(" ({failure})"))
                    .unwrap_or_default()
            ))
        } else if let PortReadiness::Ready { plan_sha256, .. } = &readiness
            && intent.failed_plan_sha256.as_deref() == Some(plan_sha256.as_str())
            && let Some(retry) = intent
                .temporary_retry
                .as_ref()
                .filter(|retry| retry.waiting(Library::now()))
        {
            next_attempt_at = Some(retry.retry_after);
            Some(retry.explanation().to_owned())
        } else {
            None
        };
        let announced = match &readiness {
            PortReadiness::Ready { plan_sha256, .. } => Some(plan_sha256.as_str()),
            // Only a game the player asked to hear about announces updates.
            PortReadiness::Installed {
                maintenance: Some(maintenance),
                ..
            } if intent.mode == PortIntentMode::Notify => maintenance.available_sha256.as_deref(),
            _ => None,
        };
        let newly_ready = suppressed.is_none()
            && announced.is_some_and(|key| intent.acknowledged_plan_sha256.as_deref() != Some(key));
        PortIntentAssessment {
            port_id: intent.port_id.clone(),
            mode: intent.mode,
            readiness,
            suppressed,
            next_attempt_at,
            newly_ready,
        }
    }

    /// Records that the player was told about these ready plans, so the same
    /// opportunity is not announced again.
    pub fn acknowledge_port_readiness(
        &self,
        acknowledgements: &[PortReadinessAcknowledgement],
    ) -> Result<()> {
        for acknowledgement in acknowledgements {
            self.library
                .update_port_intent(&acknowledgement.port_id, |record, _| {
                    if let Some(intent) = record {
                        intent.acknowledged_plan_sha256 = Some(acknowledgement.plan_sha256.clone());
                    }
                })?;
        }
        Ok(())
    }

    /// One standing-setup pass: installs each set-up-when-ready game that is
    /// ready now, one game at a time. Only one process runs a pass at a time.
    /// Before each game it checks the choice still stands, then the batch
    /// re-plans and authorizes it fresh. A game already in an unfinished batch
    /// is left to that batch, and one game's error never stops the others.
    /// Never launches a game.
    pub async fn run_standing_setup(
        &self,
        mut emit: impl FnMut(OperationEvent),
    ) -> Result<StandingSetupResult> {
        let _owner = match self.library.try_lock_activity("standing-setup") {
            Ok(guard) => guard,
            Err(error) if error.code == crate::ErrorCode::Conflict => {
                return Ok(StandingSetupResult {
                    already_running: true,
                    ..Default::default()
                });
            }
            Err(error) => return Err(error),
        };
        let mut result = self
            .run_standing_game_setup(&mut emit)
            .await
            .unwrap_or_else(|error| {
                tracing::warn!(error = %error.message, "game setup queue is unavailable");
                StandingSetupResult {
                    game_setup_unavailable: Some(error.message),
                    ..Default::default()
                }
            });
        // A host that is stopping starts no further unattended work.
        let ports = if self.unattended_stopping() {
            Vec::new()
        } else {
            self.catalog().ports().to_vec()
        };
        for port_id in ports
            .iter()
            .filter(|port| {
                crate::provider_binding::configured_bindings(port).is_some()
                    || crate::provider_binding::default_binding(port).is_some()
            })
            .map(|port| port.id.as_str())
        {
            match self.run_eligible_provider_updates(port_id).await {
                Ok(updates) => result.mod_updates.extend(updates),
                Err(error) => result.mod_updates.push(crate::ProviderAutoUpdate {
                    port_id: port_id.into(),
                    profile_id: String::new(),
                    profile_name: String::new(),
                    native_ids: Vec::new(),
                    outcome: crate::ProviderAutoUpdateOutcome::Unavailable {
                        reason: error.message,
                    },
                }),
            }
        }
        Ok(result)
    }

    async fn run_standing_game_setup(
        &self,
        emit: &mut impl FnMut(OperationEvent),
    ) -> Result<StandingSetupResult> {
        self.recover_interrupted_setups();
        let assessed = self
            .assess_port_intents_for(IntentAssessmentPurpose::StandingSetup)
            .await?;
        let busy = self
            .unfinished_install_batches()?
            .into_iter()
            .flat_map(|batch| batch.items.into_iter().map(|item| item.port_id))
            .collect::<std::collections::BTreeSet<_>>();
        let mut batches = Vec::new();
        let mut failures = Vec::new();
        // Games with their own remembered choice are never handled by folder consent.
        let mut handled = assessed
            .assessments
            .iter()
            .map(|assessment| assessment.port_id.clone())
            .collect::<std::collections::BTreeSet<_>>();
        for (assessment, plan_sha256) in self.standing_order(&assessed.assessments, &busy) {
            // Portcove is closing, restarting or was told to stop: the next
            // game must not start, or it would be left mid-run.
            if self.unattended_stopping() {
                break;
            }
            match self
                .standing_setup_one(&assessment.port_id, plan_sha256, emit)
                .await
            {
                Ok(Some(record)) => batches.push(record),
                Ok(None) => {}
                Err(error) => {
                    self.remember_standing_failure(
                        &assessment.port_id,
                        plan_sha256,
                        &error.message,
                        crate::TemporaryFailure::of(&error),
                    );
                    failures.push(StandingSetupFailure {
                        port_id: assessment.port_id.clone(),
                        reason: error.message,
                    });
                }
            }
        }
        // A folder pass error leaves the per-game results intact.
        let root_waiting = match self
            .run_root_setup(&busy, &mut handled, &mut batches, &mut failures, emit)
            .await
        {
            Ok(_) if self.unattended_stopping() => Vec::new(),
            Ok(waiting) => waiting,
            Err(error) => {
                tracing::warn!(error = %error.message, "folder setup pass did not finish");
                Vec::new()
            }
        };
        Ok(StandingSetupResult {
            assessments: assessed.assessments,
            not_assessed: assessed.not_assessed,
            batches,
            failures,
            root_waiting,
            ..Default::default()
        })
    }

    /// The games this pass sets up, in a fair order: games without a pending
    /// temporary retry first (in assessment order), then those with one, the
    /// oldest attempt first. A game that spent its time budget (or keeps
    /// failing temporarily) therefore never goes first every pass and holds
    /// the worker while the others wait.
    fn standing_order<'a>(
        &self,
        assessments: &'a [PortIntentAssessment],
        busy: &std::collections::BTreeSet<String>,
    ) -> Vec<(&'a PortIntentAssessment, &'a str)> {
        let mut eligible = assessments
            .iter()
            .filter_map(|assessment| {
                let PortReadiness::Ready { plan_sha256, .. } = &assessment.readiness else {
                    return None;
                };
                (assessment.mode == PortIntentMode::SetUpWhenReady
                    && assessment.suppressed.is_none()
                    && !busy.contains(&assessment.port_id))
                .then_some((assessment, plan_sha256.as_str()))
            })
            .collect::<Vec<_>>();
        let pending = |port_id: &str, plan_sha256: &str| {
            self.library
                .port_intent(port_id)
                .ok()
                .flatten()
                .filter(|intent| intent.failed_plan_sha256.as_deref() == Some(plan_sha256))
                .and_then(|intent| intent.temporary_retry)
                .map(|retry| retry.attempted_at)
        };
        // A stable sort keeps the assessment order among equals.
        eligible.sort_by_cached_key(|(assessment, plan_sha256)| {
            let attempted_at = pending(&assessment.port_id, plan_sha256);
            (attempted_at.is_some(), attempted_at.unwrap_or(0))
        });
        eligible
    }

    /// Settles batches left mid-run by an interruption before anything new
    /// starts: a committed install counts as ready, and a game with nothing
    /// committed is marked interrupted. Batches another process is running,
    /// and games another operation holds, are left alone. For a game set up
    /// under standing consent, a batch that recorded a clean stop (Portcove
    /// closed, restarted or was told to stop) records a clean stop, which
    /// never counts. Any other is an unclean stop: temporary, and lasting only
    /// after several in a row with no download progress between them.
    fn recover_interrupted_setups(&self) {
        let batches = match self.unfinished_install_batches() {
            Ok(batches) => batches,
            Err(error) => {
                tracing::warn!(error = %error.message, "could not list unfinished setup batches");
                return;
            }
        };
        for batch in batches {
            let running = batch
                .items
                .iter()
                .filter(|item| item.state == InstallBatchItemState::Running)
                .map(|item| item.port_id.clone())
                .collect::<Vec<_>>();
            if running.is_empty() {
                continue;
            }
            // Work that recovery may still roll forward is never settled here:
            // the batch stays in progress and nothing new starts for its games.
            if running.iter().any(|port_id| {
                self.library
                    .has_unfinished_lifecycle(port_id)
                    .unwrap_or(true)
            }) {
                continue;
            }
            // Only games set up under standing consent are settled, because
            // only they have an attempt limit for interruptions. Other batches
            // stay in progress for the player to continue or review.
            let all_standing = running.iter().all(|port_id| {
                self.library
                    .port_intent(port_id)
                    .ok()
                    .flatten()
                    .is_some_and(|intent| intent.mode == PortIntentMode::SetUpWhenReady)
            });
            if !all_standing {
                continue;
            }
            match self.reconcile_install_batch(&batch.id) {
                Ok(record) => {
                    for item in record.items.iter().filter(|item| {
                        item.state == InstallBatchItemState::Interrupted
                            && running.contains(&item.port_id)
                    }) {
                        // Only standing consent spends attempts; a player's
                        // own interrupted install doesn't.
                        let standing = self
                            .library
                            .port_intent(&item.port_id)
                            .ok()
                            .flatten()
                            .is_some_and(|intent| intent.mode == PortIntentMode::SetUpWhenReady);
                        if standing {
                            let temporary = record.temporary_failure(item);
                            let reason = if temporary.is_some_and(|failure| {
                                failure.cause == crate::TemporaryCause::CleanStop
                            }) {
                                "setup paused when Portcove closed"
                            } else {
                                "setup was interrupted before it finished"
                            };
                            self.remember_standing_failure_of(
                                &item.port_id,
                                &item.expected_plan_sha256,
                                reason,
                                temporary,
                                &item.download_keys,
                            );
                        }
                    }
                }
                Err(error) => {
                    tracing::warn!(batch_id = %batch.id, error = %error.message, "could not reconcile an interrupted setup batch");
                }
            }
        }
    }

    async fn standing_setup_one(
        &self,
        port_id: &str,
        plan_sha256: &str,
        emit: &mut impl FnMut(OperationEvent),
    ) -> Result<Option<InstallBatchRecord>> {
        // The earlier assessment may have preceded another game's install.
        // A source that went offline in the meantime must not spend an attempt.
        let Ok(plan) = self.plan_game_install(port_id).await else {
            return Ok(None);
        };
        if plan.plan_sha256 != plan_sha256 || self.install_plan_hold(&plan).is_some() {
            return Ok(None);
        }
        // Consent can be withdrawn while earlier games run or while replanning.
        let still_wanted = self.library.port_intent(port_id)?.is_some_and(|intent| {
            intent.mode == PortIntentMode::SetUpWhenReady
                && intent.explicitly_uninstalled_at.is_none()
                && self.intent_binding_hold(&intent).is_none()
        });
        if !still_wanted {
            return Ok(None);
        }
        // Reserved before the batch exists, so a host stop is never missed;
        // none once the host is stopping.
        let Some(reservation) = self.reserve_unattended_run() else {
            return Ok(None);
        };
        let batch = self.start_install_batch(
            &[InstallBatchRequestItem {
                port_id: port_id.to_owned(),
                expected_plan_sha256: plan_sha256.to_owned(),
            }],
            LibraryMembershipOrigin::Manual,
        )?;
        let keys = crate::install::plan_download_keys(&plan.plan);
        let run = self
            .run_unattended_install_batch(reservation, &batch.id, keys, emit)
            .await?;
        for item in &run.record.items {
            match item.state {
                InstallBatchItemState::Ready => {
                    self.library
                        .update_port_intent(&item.port_id, |intent, _| {
                            if let Some(intent) = intent {
                                intent.clear_failure();
                            }
                        })?;
                }
                InstallBatchItemState::Failed | InstallBatchItemState::Interrupted => {
                    self.remember_standing_failure_of(
                        &item.port_id,
                        &item.expected_plan_sha256,
                        item.detail.as_deref().unwrap_or("setup did not finish"),
                        run.record.temporary_failure(item),
                        &item.download_keys,
                    );
                }
                // Stopped by this pass's time budget or by Portcove closing,
                // not by the player: continue on the next pass.
                InstallBatchItemState::Cancelled => {
                    if let Some(stopped) = run.cancelled_as() {
                        let reason = if stopped.cause == crate::TemporaryCause::TimeBudget {
                            "setup used this pass's time budget"
                        } else {
                            "setup paused when Portcove closed"
                        };
                        self.remember_standing_failure(
                            &item.port_id,
                            &item.expected_plan_sha256,
                            reason,
                            Some(stopped),
                        );
                    }
                }
                _ => {}
            }
        }
        Ok(Some(run.record))
    }

    /// Records a failed attempt for this plan: a lasting failure counts toward
    /// the attempt limit; a temporary one only schedules the next attempt.
    /// Best effort: if it can't be recorded, the next pass simply tries again
    /// within the same limits.
    fn remember_standing_failure(
        &self,
        port_id: &str,
        plan_sha256: &str,
        reason: &str,
        temporary: Option<crate::TemporaryFailure>,
    ) {
        self.remember_standing_failure_of(port_id, plan_sha256, reason, temporary, &[]);
    }

    /// As [`Self::remember_standing_failure`], for a run whose plan kept its
    /// downloads under `download_keys`: an unclean stop counts as progress
    /// only when one of these grew. With none known, no stop is progress.
    fn remember_standing_failure_of(
        &self,
        port_id: &str,
        plan_sha256: &str,
        reason: &str,
        temporary: Option<crate::TemporaryFailure>,
        download_keys: &[String],
    ) {
        let library = &self.library;
        let result = self.library.update_port_intent(port_id, |intent, now| {
            let Some(intent) = intent else { return };
            if intent.failed_plan_sha256.as_deref() != Some(plan_sha256) {
                intent.failed_plan_sha256 = Some(plan_sha256.to_owned());
                intent.failed_attempts = 0;
                intent.temporary_retry = None;
            }
            // A count from before classification keeps exactly one more try.
            intent.failed_attempts = crate::temporary_failure::classified_attempts(
                intent.failed_attempts,
                intent.failure_classified,
                MAX_STANDING_SETUP_ATTEMPTS,
            );
            let mut reason = reason.to_owned();
            match crate::temporary_failure::FailedAttempt::of(
                intent.temporary_retry.as_ref(),
                temporary,
                || library.kept_downloads_of(download_keys),
                now,
            ) {
                crate::temporary_failure::FailedAttempt::Temporary(retry) => {
                    intent.temporary_retry = Some(retry);
                }
                crate::temporary_failure::FailedAttempt::Lasting => {
                    intent.failed_attempts = intent.failed_attempts.saturating_add(1);
                    intent.temporary_retry = None;
                }
                crate::temporary_failure::FailedAttempt::RepeatedUncleanStops => {
                    intent.failed_attempts = intent
                        .failed_attempts
                        .saturating_add(1)
                        .max(MAX_STANDING_SETUP_ATTEMPTS);
                    intent.temporary_retry = None;
                    reason = format!(
                        "Portcove stopped before setup finished {} times in a row",
                        crate::temporary_failure::MAX_CONSECUTIVE_UNCLEAN_STOPS
                    );
                }
            }
            intent.failure_classified = true;
            intent.failure = Some(reason.chars().take(512).collect());
        });
        if let Err(error) = result {
            tracing::warn!(port_id, error = %error.message, "could not record a standing setup failure");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::service::tests::{register_zelda_install, service_with_release};

    const PORT: &str = "zelda64-recomp";

    async fn ready_service() -> (tempfile::TempDir, PortcoveService) {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        register_zelda_install(&library, "v1", false);
        (temporary, service_with_release(library, "v1"))
    }

    const STACK_PORT: &str = "standing-worker-fixture";

    /// Runs when a port's release is resolved (planning and re-planning).
    type ResolveHook = std::sync::Arc<dyn Fn(&str) + Send + Sync>;

    struct StackRelease(crate::ResolvedRelease, Option<ResolveHook>);

    #[async_trait::async_trait]
    impl crate::ReleaseProvider for StackRelease {
        async fn resolve(
            &self,
            port: &crate::PortDefinition,
            channel: crate::ReleaseChannel,
            platform: crate::Platform,
        ) -> Result<crate::ResolvedRelease> {
            assert_eq!(channel, crate::ReleaseChannel::Stable);
            assert_eq!(platform, crate::Platform::current().unwrap());
            if let Some(hook) = &self.1 {
                hook(&port.id);
            }
            Ok(self.0.clone())
        }
    }

    struct StackInstallFixture {
        temporary: tempfile::TempDir,
        service: PortcoveService,
        server: crate::test_http::HttpServer,
        requests: std::sync::mpsc::Receiver<String>,
        executable: String,
        program: Vec<u8>,
    }

    /// The inert fresh-install payload: executable name, its bytes and the
    /// gzip archive a release serves.
    fn stack_payload() -> (String, Vec<u8>, Vec<u8>) {
        use std::io::Write;
        let executable = if cfg!(windows) { "game.exe" } else { "game" }.to_owned();
        let program = if cfg!(windows) {
            let mut bytes = vec![0_u8; 128];
            bytes[..2].copy_from_slice(b"MZ");
            bytes
        } else {
            b"#!/bin/sh\n# Owned inert standing-setup fixture; never executed.\n".to_vec()
        };
        let mut random = 0x5374_616e_u32;
        let padding = (0..3 * 1024 * 1024)
            .map(|_| {
                random ^= random << 13;
                random ^= random >> 17;
                random ^= random << 5;
                random as u8
            })
            .collect::<Vec<_>>();
        let mut archive = tar::Builder::new(Vec::new());
        for (name, bytes, mode) in [
            (executable.as_str(), program.as_slice(), 0o755),
            ("owned-download-padding.bin", padding.as_slice(), 0o644),
        ] {
            let mut header = tar::Header::new_gnu();
            header.set_size(bytes.len() as u64);
            header.set_mode(mode);
            header.set_cksum();
            archive.append_data(&mut header, name, bytes).unwrap();
        }
        let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        gzip.write_all(&archive.into_inner().unwrap()).unwrap();
        (executable, program, gzip.finish().unwrap())
    }

    /// A service whose one fixture port resolves to `payload` at `origin`.
    fn stack_service_at(
        temporary: &tempfile::TempDir,
        origin: &str,
        payload: &[u8],
        executable: &str,
    ) -> PortcoveService {
        stack_service_for(temporary, origin, payload, executable, &[STACK_PORT])
    }

    /// A service whose fixture ports all resolve to `payload` at `origin`.
    fn stack_service_for(
        temporary: &tempfile::TempDir,
        origin: &str,
        payload: &[u8],
        executable: &str,
        ports: &[&str],
    ) -> PortcoveService {
        stack_service_hooked(temporary, origin, payload, executable, ports, None)
    }

    fn stack_service_hooked(
        temporary: &tempfile::TempDir,
        origin: &str,
        payload: &[u8],
        executable: &str,
        ports: &[&str],
        hook: Option<ResolveHook>,
    ) -> PortcoveService {
        let platform = crate::Platform::current().unwrap();
        let platform_key = serde_json::to_value(platform)
            .unwrap()
            .as_str()
            .unwrap()
            .to_owned();
        let digest = crate::signed_catalog::digest(payload);
        let release = crate::ResolvedRelease {
            version: "1.0.0-stack-fixture".into(),
            channel: crate::ReleaseChannel::Stable,
            published_at: None,
            asset: crate::ReleaseAsset {
                name: "standing-worker-runtime.tar.gz".into(),
                url: format!("{origin}/runtime.tar.gz"),
                size: payload.len() as u64,
                sha256: digest,
            },
            uploader_continuity: None,
        };
        let original = b"Portcove owned inert standing source\n";
        let source = temporary.path().join("original.pcgame");
        std::fs::write(&source, original).unwrap();
        let catalog = crate::Catalog::from_json(&serde_json::json!({
            "schema_version": 1,
            "source_profiles": [{
                "id": "standing-worker-original", "label": "Owned inert original",
                "kind": "file", "accepted_extensions": ["pcgame"],
                "accepted_sha256": [crate::signed_catalog::digest(original)]
            }],
            "ports": ports.iter().map(|port| serde_json::json!({
                "id": port, "name": format!("Standing worker fixture {port}"),
                "summary": "Owned inert fresh-download stack fixture; never launched.",
                "project_url": format!("https://example.invalid/{port}"),
                "support_tier": "beta", "channels": ["stable"], "platforms": [platform],
                "adapter": "libultraship-portable", "source_profile": "standing-worker-original",
                "release": {"repository": format!("example/{port}"), "asset_hints": {(platform_key.clone()): ["runtime"]}},
                "executable_hints": {(platform_key.clone()): [executable]},
                "persistent_paths": ["saves", "settings.ini"]
            })).collect::<Vec<_>>()
        }).to_string()).unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let mut service = PortcoveService::with_provider(
            library,
            std::sync::Arc::new(StackRelease(release, hook)),
        )
        .unwrap();
        service.replace_catalog_for_test(catalog);
        service
            .register_source("standing-worker-original", &source)
            .unwrap();
        service
    }

    /// First connection: a whole answer with a strong validator whose body
    /// sends half quickly, then trickles one byte every 100 ms (never idle
    /// long enough for the read-idle bound). Second connection: an exact
    /// `Range` continuation. Returns the origin and the requests it answered.
    fn serve_trickle_then_range(
        payload: Vec<u8>,
    ) -> (String, std::thread::JoinHandle<Vec<String>>) {
        use std::io::{BufRead, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let mut requests = Vec::new();
            for connection in 0..2 {
                let (stream, _) = listener.accept().unwrap();
                let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
                let mut request = String::new();
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    request.push_str(&line);
                    if line == "\r\n" || line.is_empty() {
                        break;
                    }
                }
                let mut stream = stream;
                if connection == 0 {
                    let half = payload.len() / 2;
                    let _ = stream.write_all(
                        format!(
                            "HTTP/1.1 200 OK\r\nETag: \"v1\"\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            payload.len()
                        )
                        .as_bytes(),
                    );
                    let _ = stream.write_all(&payload[..half]);
                    for byte in &payload[half..] {
                        std::thread::sleep(std::time::Duration::from_millis(100));
                        if stream
                            .write_all(&[*byte])
                            .and_then(|()| stream.flush())
                            .is_err()
                        {
                            break;
                        }
                    }
                } else {
                    let offset: usize = request
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("range: bytes=")
                                .map(str::to_owned)
                        })
                        .and_then(|range| range.strip_suffix('-').map(str::to_owned))
                        .expect("the continuation must ask for the remaining bytes")
                        .parse()
                        .unwrap();
                    let _ = stream.write_all(
                        format!(
                            "HTTP/1.1 206 Partial Content\r\nETag: \"v1\"\r\nContent-Range: bytes {offset}-{}/{}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            payload.len() - 1,
                            payload.len(),
                            payload.len() - offset
                        )
                        .as_bytes(),
                    );
                    let _ = stream.write_all(&payload[offset..]);
                }
                requests.push(request);
            }
            requests
        });
        (origin, server)
    }

    #[test]
    fn a_trickling_download_yields_the_worker_at_its_budget_and_continues_next_pass() {
        // Fresh installs need a large stack on Windows debug workers.
        std::thread::Builder::new()
            .stack_size(32 * 1024 * 1024)
            .spawn(|| {
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .unwrap()
                    .block_on(async {
                        let temporary = tempfile::tempdir().unwrap();
                        let (executable, _, payload) = stack_payload();
                        let (origin, server) = serve_trickle_then_range(payload.clone());
                        let service = stack_service_at(&temporary, &origin, &payload, &executable);
                        service
                            .set_port_intent(STACK_PORT, PortIntentMode::SetUpWhenReady)
                            .unwrap();
                        crate::service::unattended_setup::GAME_BUDGET_OVERRIDE
                            .with(|budget| budget.set(Some(std::time::Duration::from_secs(2))));
                        let started = std::time::Instant::now();
                        let first = service.run_standing_setup(|_| {}).await.unwrap();
                        // The pass yielded at its budget instead of waiting for
                        // the trickle (about 150 seconds) to finish.
                        assert!(started.elapsed() < std::time::Duration::from_secs(60));
                        assert_eq!(first.batches.len(), 1);
                        assert_eq!(
                            first.batches[0].items[0].state,
                            InstallBatchItemState::Cancelled
                        );
                        assert!(service.status(STACK_PORT).unwrap().active.is_none());
                        let intent = service.library.port_intent(STACK_PORT).unwrap().unwrap();
                        assert_eq!(intent.failed_attempts, 0);
                        let retry = intent.temporary_retry.unwrap();
                        assert_eq!(retry.cause, crate::TemporaryCause::TimeBudget);
                        // Fair scheduling, not a penalty: due on the next pass.
                        assert!(!retry.waiting(Library::now()));

                        let second = service.run_standing_setup(|_| {}).await.unwrap();
                        assert_eq!(second.batches.len(), 1);
                        assert_eq!(
                            second.batches[0].items[0].state,
                            InstallBatchItemState::Ready,
                            "{second:?}"
                        );
                        assert!(service.status(STACK_PORT).unwrap().active.is_some());
                        let intent = service.library.port_intent(STACK_PORT).unwrap().unwrap();
                        assert_eq!(intent.temporary_retry, None);
                        crate::service::unattended_setup::GAME_BUDGET_OVERRIDE
                            .with(|budget| budget.set(None));
                        let requests = server.join().unwrap();
                        let continued = requests[1]
                            .lines()
                            .find_map(|line| {
                                line.to_ascii_lowercase()
                                    .strip_prefix("range: bytes=")
                                    .map(str::to_owned)
                            })
                            .unwrap();
                        let offset: usize = continued.trim_end_matches('-').parse().unwrap();
                        // The kept prefix was continued, not downloaded again.
                        assert!(offset >= payload.len() / 2, "{offset}");
                    });
            })
            .unwrap()
            .join()
            .unwrap();
    }

    /// Runs an async test on a large stack (fresh installs need one on
    /// Windows debug workers) with its own current-thread runtime.
    fn on_large_stack<Fut: std::future::Future<Output = ()>>(
        test: impl FnOnce() -> Fut + Send + 'static,
    ) {
        std::thread::Builder::new()
            .stack_size(32 * 1024 * 1024)
            .spawn(|| {
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .unwrap()
                    .block_on(test());
            })
            .unwrap()
            .join()
            .unwrap();
    }

    fn whole_answer(payload: &[u8]) -> Vec<u8> {
        let mut response = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            payload.len()
        )
        .into_bytes();
        response.extend_from_slice(payload);
        response
    }

    /// Answers every connection with the whole payload (no validator), half at
    /// once and the rest after `pause`, until dropped.
    struct PausedServer {
        origin: String,
        stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
        thread: Option<std::thread::JoinHandle<()>>,
    }

    impl Drop for PausedServer {
        fn drop(&mut self) {
            self.stop.store(true, std::sync::atomic::Ordering::SeqCst);
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
    }

    fn serve_paused(payload: Vec<u8>, pause: std::time::Duration) -> PausedServer {
        use std::io::Write;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let stopping = stop.clone();
        let thread = std::thread::spawn(move || {
            let mut answers = Vec::new();
            while !stopping.load(std::sync::atomic::Ordering::SeqCst) {
                let Ok((stream, _)) = listener.accept() else {
                    std::thread::sleep(std::time::Duration::from_millis(5));
                    continue;
                };
                let payload = payload.clone();
                let stopping = stopping.clone();
                answers.push(std::thread::spawn(move || {
                    let stopped = || stopping.load(std::sync::atomic::Ordering::SeqCst);
                    // Short socket timeouts keep every read and write able to
                    // see the stop: a client that stopped reading (its
                    // connection task cannot run while the test tears down)
                    // must never hold this fixture open.
                    let tick = Some(std::time::Duration::from_millis(20));
                    stream.set_nonblocking(false).unwrap();
                    stream.set_read_timeout(tick).unwrap();
                    stream.set_write_timeout(tick).unwrap();
                    let mut stream = stream;
                    let mut request = Vec::new();
                    let mut byte = [0_u8; 1];
                    while !request.ends_with(b"\r\n\r\n") {
                        match std::io::Read::read(&mut stream, &mut byte) {
                            Ok(0) => return,
                            Ok(_) => request.push(byte[0]),
                            Err(error)
                                if matches!(
                                    error.kind(),
                                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                                ) && !stopped() => {}
                            Err(_) => return,
                        }
                    }
                    let mut send = |mut bytes: &[u8]| -> bool {
                        while !bytes.is_empty() {
                            if stopped() {
                                return false;
                            }
                            match stream.write(&bytes[..bytes.len().min(16 * 1024)]) {
                                Ok(0) => return false,
                                Ok(written) => bytes = &bytes[written..],
                                Err(error)
                                    if matches!(
                                        error.kind(),
                                        std::io::ErrorKind::WouldBlock
                                            | std::io::ErrorKind::TimedOut
                                    ) => {}
                                Err(_) => return false,
                            }
                        }
                        stream.flush().is_ok()
                    };
                    let half = payload.len() / 2;
                    let head = format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        payload.len()
                    );
                    if !send(head.as_bytes()) || !send(&payload[..half]) {
                        return;
                    }
                    let resume = std::time::Instant::now() + pause;
                    while std::time::Instant::now() < resume && !stopped() {
                        std::thread::sleep(std::time::Duration::from_millis(5));
                    }
                    send(&payload[half..]);
                }));
            }
            for answer in answers {
                let _ = answer.join();
            }
        });
        PausedServer {
            origin,
            stop,
            thread: Some(thread),
        }
    }

    #[test]
    fn a_game_with_a_pending_retry_goes_after_the_others() {
        const LATER: &str = "standing-worker-fixture-later";
        on_large_stack(|| async {
            let temporary = tempfile::tempdir().unwrap();
            let (executable, _, payload) = stack_payload();
            let answer = whole_answer(&payload);
            let (origin, _requests, _server) =
                crate::test_http::serve_routed_http_bytes(4, move |_| answer.clone());
            let service = stack_service_for(
                &temporary,
                &origin,
                &payload,
                &executable,
                &[STACK_PORT, LATER],
            );
            for port in [STACK_PORT, LATER] {
                service
                    .set_port_intent(port, PortIntentMode::SetUpWhenReady)
                    .unwrap();
            }
            let assessed = service.assess_port_intents().await.unwrap();
            let order = assessed
                .assessments
                .iter()
                .map(|assessment| assessment.port_id.as_str())
                .collect::<Vec<_>>();
            // Without a pending retry, the first game is assessed first.
            assert_eq!(order, [STACK_PORT, LATER]);
            let PortReadiness::Ready { plan_sha256, .. } = &assessed.assessments[0].readiness
            else {
                panic!("expected ready: {assessed:?}");
            };
            // It spent its budget last pass: due now, but after the others.
            service.remember_standing_failure(
                STACK_PORT,
                plan_sha256,
                "setup used this pass's time budget",
                Some(crate::TemporaryFailure {
                    cause: crate::TemporaryCause::TimeBudget,
                    stated_reset: None,
                }),
            );
            let pass = service.run_standing_setup(|_| {}).await.unwrap();
            let ran = pass
                .batches
                .iter()
                .map(|batch| (batch.items[0].port_id.as_str(), batch.items[0].state))
                .collect::<Vec<_>>();
            assert_eq!(
                ran,
                [
                    (LATER, InstallBatchItemState::Ready),
                    (STACK_PORT, InstallBatchItemState::Ready)
                ],
                "{pass:?}"
            );
            // Each unattended batch kept its plan's download entry, derived
            // from the plan by the production path.
            let key = format!(
                "{}-{}",
                crate::signed_catalog::digest(&payload),
                payload.len()
            );
            for batch in &pass.batches {
                assert_eq!(batch.items[0].download_keys, [key.clone()]);
            }
        });
    }

    #[test]
    fn the_players_own_install_is_never_cut_by_the_unattended_budget() {
        on_large_stack(|| async {
            let temporary = tempfile::tempdir().unwrap();
            let (executable, _, payload) = stack_payload();
            let pause = std::time::Duration::from_millis(1500);
            let server = serve_paused(payload.clone(), pause);
            let service = stack_service_at(&temporary, &server.origin, &payload, &executable);
            crate::service::unattended_setup::GAME_BUDGET_OVERRIDE
                .with(|budget| budget.set(Some(std::time::Duration::from_millis(200))));
            let plan = service.plan_game_install(STACK_PORT).await.unwrap();
            let batch = service
                .start_install_batch(
                    &[InstallBatchRequestItem {
                        port_id: STACK_PORT.into(),
                        expected_plan_sha256: plan.plan_sha256,
                    }],
                    LibraryMembershipOrigin::Manual,
                )
                .unwrap();
            let started = std::time::Instant::now();
            let record = service.run_install_batch(&batch.id, |_| {}).await.unwrap();
            // It ran well past the unattended budget and still finished.
            assert!(started.elapsed() >= pause);
            assert_eq!(record.items[0].state, InstallBatchItemState::Ready);
            assert!(service.status(STACK_PORT).unwrap().active.is_some());
            crate::service::unattended_setup::GAME_BUDGET_OVERRIDE.with(|budget| budget.set(None));
        });
    }

    #[test]
    fn a_budget_spent_before_the_install_starts_still_stops_it() {
        on_large_stack(|| async {
            let temporary = tempfile::tempdir().unwrap();
            let (executable, _, payload) = stack_payload();
            let server = serve_paused(payload.clone(), std::time::Duration::from_secs(120));
            let service = stack_service_at(&temporary, &server.origin, &payload, &executable);
            service
                .set_port_intent(STACK_PORT, PortIntentMode::SetUpWhenReady)
                .unwrap();
            // Spent at once: the install is asked to stop as soon as it starts.
            crate::service::unattended_setup::GAME_BUDGET_OVERRIDE
                .with(|budget| budget.set(Some(std::time::Duration::ZERO)));
            let started = std::time::Instant::now();
            let pass = service.run_standing_setup(|_| {}).await.unwrap();
            assert!(started.elapsed() < std::time::Duration::from_secs(60));
            assert_eq!(
                pass.batches[0].items[0].state,
                InstallBatchItemState::Cancelled,
                "{pass:?}"
            );
            let intent = service.library.port_intent(STACK_PORT).unwrap().unwrap();
            assert_eq!(intent.failed_attempts, 0);
            assert_eq!(
                intent.temporary_retry.unwrap().cause,
                crate::TemporaryCause::TimeBudget
            );
            crate::service::unattended_setup::GAME_BUDGET_OVERRIDE.with(|budget| budget.set(None));
        });
    }

    #[test]
    fn closing_portcove_during_setup_is_a_clean_stop_that_continues_next_pass() {
        on_large_stack(|| async {
            let temporary = tempfile::tempdir().unwrap();
            let (executable, _, payload) = stack_payload();
            let server = serve_paused(payload.clone(), std::time::Duration::from_millis(1500));
            let service = stack_service_at(&temporary, &server.origin, &payload, &executable);
            service
                .set_port_intent(STACK_PORT, PortIntentMode::SetUpWhenReady)
                .unwrap();
            let library = service.library().clone();
            for _ in 0..2 * crate::temporary_failure::MAX_CONSECUTIVE_UNCLEAN_STOPS {
                // The host closes as soon as the install starts, as the
                // Desktop exit handler or a CLI interrupt does.
                let host = PortcoveService::new(library.clone()).unwrap();
                let pass = service
                    .run_standing_setup(|event| {
                        if event.parent_operation_id.is_none()
                            && matches!(event.event, crate::OperationEventKind::Started)
                        {
                            assert_eq!(host.stop_unattended_setups(), 1);
                        }
                    })
                    .await
                    .unwrap();
                let batch = &pass.batches[0];
                assert_eq!(batch.items[0].state, InstallBatchItemState::Cancelled);
                assert!(batch.clean_stop_at.is_some());
                let intent = service.library.port_intent(STACK_PORT).unwrap().unwrap();
                // Never counted, never a wait: due on the next pass.
                assert_eq!(intent.failed_attempts, 0);
                let retry = intent.temporary_retry.unwrap();
                assert_eq!(retry.cause, crate::TemporaryCause::CleanStop);
                assert!(!retry.waiting(Library::now()));
                // Nothing more starts in a process that is stopping.
                assert!(
                    service
                        .run_standing_setup(|_| {})
                        .await
                        .unwrap()
                        .batches
                        .is_empty()
                );
                // Portcove starts again.
                service.resume_unattended_setups_for_test();
            }
            let pass = service.run_standing_setup(|_| {}).await.unwrap();
            assert_eq!(pass.batches[0].items[0].state, InstallBatchItemState::Ready);
            let intent = service.library.port_intent(STACK_PORT).unwrap().unwrap();
            assert_eq!(intent.temporary_retry, None);
        });
    }

    #[test]
    fn closing_between_two_games_never_starts_the_second() {
        const LATER: &str = "standing-worker-fixture-later";
        on_large_stack(|| async {
            let temporary = tempfile::tempdir().unwrap();
            let (executable, _, payload) = stack_payload();
            let server = serve_paused(payload.clone(), std::time::Duration::from_millis(1500));
            let service = stack_service_for(
                &temporary,
                &server.origin,
                &payload,
                &executable,
                &[STACK_PORT, LATER],
            );
            for port in [STACK_PORT, LATER] {
                service
                    .set_port_intent(port, PortIntentMode::SetUpWhenReady)
                    .unwrap();
            }
            // The host closes while the first game installs, as the Desktop
            // exit handler does from its own short-lived service.
            let host = PortcoveService::new(service.library().clone()).unwrap();
            let pass = service
                .run_standing_setup(|event| {
                    if event.parent_operation_id.is_none()
                        && matches!(event.event, crate::OperationEventKind::Started)
                    {
                        host.stop_unattended_setups();
                    }
                })
                .await
                .unwrap();
            // Only the first game ran, and it stopped cleanly.
            assert_eq!(pass.batches.len(), 1, "{pass:?}");
            assert_eq!(pass.batches[0].items[0].port_id, STACK_PORT);
            assert!(pass.batches[0].clean_stop_at.is_some());
            // The second game never started: no batch could be left mid-run.
            assert!(
                service
                    .unfinished_install_batches()
                    .unwrap()
                    .iter()
                    .all(|batch| batch.items.iter().all(|item| item.port_id != LATER))
            );
            let later = service.library.port_intent(LATER).unwrap().unwrap();
            assert_eq!((later.failed_attempts, later.temporary_retry), (0, None));
            service.resume_unattended_setups_for_test();
        });
    }

    #[test]
    fn closing_while_the_pass_replans_the_next_game_never_starts_it() {
        const LATER: &str = "standing-worker-fixture-later";
        on_large_stack(|| async {
            let temporary = tempfile::tempdir().unwrap();
            let (executable, _, payload) = stack_payload();
            let answer = whole_answer(&payload);
            let (origin, _requests, _server) =
                crate::test_http::serve_routed_http_bytes(4, move |_| answer.clone());
            let library = Library::open(temporary.path().join("library")).unwrap();
            // Armed once the first game finished: the next resolve of the
            // second game is the pass re-planning it, with no run registered.
            let armed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            let exits = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let hook: ResolveHook = {
                let (library, armed, exits) = (library.clone(), armed.clone(), exits.clone());
                std::sync::Arc::new(move |port: &str| {
                    if port == LATER && armed.load(std::sync::atomic::Ordering::SeqCst) {
                        assert!(!PortcoveService::unattended_setups_registered_for_test(
                            &library
                        ));
                        // The same entry point the Desktop exit handler calls.
                        PortcoveService::stop_unattended_setups_for_exit(&library, || {
                            Some(PortcoveService::new(library.clone()).unwrap())
                        });
                        exits.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    }
                })
            };
            drop(library);
            let service = stack_service_hooked(
                &temporary,
                &origin,
                &payload,
                &executable,
                &[STACK_PORT, LATER],
                Some(hook),
            );
            for port in [STACK_PORT, LATER] {
                service
                    .set_port_intent(port, PortIntentMode::SetUpWhenReady)
                    .unwrap();
            }
            let pass = service
                .run_standing_setup(|event| {
                    if event.parent_operation_id.is_none()
                        && matches!(event.event, crate::OperationEventKind::Finished { .. })
                    {
                        armed.store(true, std::sync::atomic::Ordering::SeqCst);
                    }
                })
                .await
                .unwrap();
            assert_eq!(exits.load(std::sync::atomic::Ordering::SeqCst), 1);
            // The first game finished; the second never started.
            assert_eq!(pass.batches.len(), 1, "{pass:?}");
            assert_eq!(pass.batches[0].items[0].port_id, STACK_PORT);
            assert_eq!(pass.batches[0].items[0].state, InstallBatchItemState::Ready);
            assert!(service.status(LATER).unwrap().active.is_none());
            assert!(service.unfinished_install_batches().unwrap().is_empty());
            service.resume_unattended_setups_for_test();
        });
    }

    #[tokio::test]
    async fn a_host_stop_before_a_pass_starts_nothing() {
        let (_temporary, service) = ready_service().await;
        service
            .set_port_intent(PORT, PortIntentMode::SetUpWhenReady)
            .unwrap();
        // Nothing is running: the stop still latches for this library.
        let host = PortcoveService::new(service.library().clone()).unwrap();
        assert_eq!(host.stop_unattended_setups(), 0);
        let pass = service.run_standing_setup(|_| {}).await.unwrap();
        assert!(pass.batches.is_empty(), "{pass:?}");
        assert!(service.status(PORT).unwrap().active.is_none());
        assert!(service.unfinished_install_batches().unwrap().is_empty());
        service.resume_unattended_setups_for_test();
        let pass = service.run_standing_setup(|_| {}).await.unwrap();
        assert_eq!(pass.batches.len(), 1);
    }

    fn fresh_stack_service() -> StackInstallFixture {
        let temporary = tempfile::tempdir().unwrap();
        let (executable, program, payload) = stack_payload();
        let mut response = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            payload.len()
        )
        .into_bytes();
        response.extend_from_slice(&payload);
        let (origin, requests, server) = crate::test_http::serve_http_bytes(vec![response]);
        let service = stack_service_at(&temporary, &origin, &payload, &executable);
        StackInstallFixture {
            temporary,
            service,
            server,
            requests,
            executable,
            program,
        }
    }

    #[test]
    fn standing_setup_installs_on_default_worker_stack() {
        const CHILD: &str = "PORTCOVE_STANDING_STACK_CHILD";
        if std::env::var(CHILD).as_deref() != Ok("1") {
            let temporary = tempfile::tempdir().unwrap();
            let log_path = temporary.path().join("standing-worker.log");
            let log = std::fs::File::create(&log_path).unwrap();
            let mut child = crate::ChildProcessPolicy::native_command(
                crate::ChildProcessClass::HostTool,
                &std::env::current_exe().unwrap(),
            )
            .unwrap()
            .args([
                "--exact",
                "service::port_intent::tests::standing_setup_installs_on_default_worker_stack",
                "--nocapture",
            ])
            .env(CHILD, "1")
            .env_remove("PORTCOVE_GITHUB_TOKEN")
            .env_remove("GH_TOKEN")
            .env_remove("GITHUB_TOKEN")
            .stdin(std::process::Stdio::null())
            .stdout(log.try_clone().unwrap())
            .stderr(log)
            .spawn()
            .unwrap();
            let started = std::time::Instant::now();
            let observation = loop {
                match child.try_wait() {
                    Ok(Some(_)) => break Ok(()),
                    Ok(None) => {}
                    Err(error) => break Err(format!("could not observe standing worker: {error}")),
                }
                if started.elapsed() >= std::time::Duration::from_secs(60) {
                    break Err("standing worker exceeded 60 seconds".to_owned());
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            };
            if observation.is_err() {
                let _ = child.kill();
            }
            // Join the exact child before consuming its log or cleaning the fixture.
            let status = child.wait().unwrap();
            let stdout = std::fs::read_to_string(&log_path).unwrap();
            assert!(observation.is_ok(), "{observation:?}\n{stdout}");
            assert!(
                status.success(),
                "standing worker status={status:?}\n{stdout}"
            );
            assert!(stdout.contains("running 1 test"), "{stdout}");
            assert!(
                stdout.contains("PORTCOVE_STANDING_WORKER_COMPLETED"),
                "{stdout}"
            );
            return;
        }
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .unwrap();
        let StackInstallFixture {
            temporary: _temporary,
            service,
            server,
            requests,
            executable,
            program,
        } = fresh_stack_service();
        let plan = runtime
            .block_on(service.plan_game_install(STACK_PORT))
            .unwrap();
        assert_eq!(plan.plan.action, crate::InstallPlanAction::Download);
        assert!(plan.selected_install.is_none());
        assert!(service.status(STACK_PORT).unwrap().active.is_none());
        service
            .set_port_intent(STACK_PORT, PortIntentMode::SetUpWhenReady)
            .unwrap();
        let handle = runtime.handle().clone();
        std::thread::Builder::new()
            .name("standing-install-stack-regression".into())
            .stack_size(2 * 1024 * 1024)
            .spawn(move || {
                handle.block_on(async move {
                    let result = service.run_standing_setup(|_| {}).await.unwrap();
                    assert_eq!(result.batches.len(), 1);
                    assert_eq!(
                        result.batches[0].items[0].state,
                        InstallBatchItemState::Ready
                    );
                    let installed = service.status(STACK_PORT).unwrap().active.unwrap();
                    assert_eq!(
                        std::fs::read(installed.path.join(&executable)).unwrap(),
                        program
                    );
                    assert!(service.verify(STACK_PORT).unwrap().valid);
                    let request = requests
                        .recv_timeout(std::time::Duration::from_secs(5))
                        .unwrap();
                    assert!(request.starts_with("GET /runtime.tar.gz "), "{request}");
                    assert!(
                        service
                            .run_standing_setup(|_| {})
                            .await
                            .unwrap()
                            .batches
                            .is_empty()
                    );
                    assert_eq!(
                        service.status(STACK_PORT).unwrap().active.unwrap().id,
                        installed.id
                    );
                    assert!(requests.try_recv().is_err());
                });
            })
            .unwrap()
            .join()
            .unwrap();
        server.join().unwrap();
        println!("PORTCOVE_STANDING_WORKER_COMPLETED");
    }

    #[tokio::test]
    async fn unreadable_game_setup_queue_does_not_abort_the_standing_pass() {
        let (_temporary, service) = ready_service().await;
        service
            .library()
            .connection()
            .unwrap()
            .execute("DROP TABLE port_intents", [])
            .unwrap();

        let result = service.run_standing_setup(|_| {}).await.unwrap();
        assert!(!result.already_running);
        assert!(result.game_setup_unavailable.is_some());
        assert!(result.batches.is_empty());
    }

    #[test]
    fn intent_scan_distinguishes_invalid_storage_from_malformed_text() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path()).unwrap();
        let connection = library.connection().unwrap();
        connection
            .execute_batch(
                "INSERT INTO port_intents VALUES ('good', 1, '{\"mode\":\"notify\"}');
                 INSERT INTO port_intents VALUES ('broken', 1, X'00');",
            )
            .unwrap();

        for purpose in [
            IntentAssessmentPurpose::Readiness,
            IntentAssessmentPurpose::StandingSetup,
        ] {
            assert!(matches!(
                library.intent_assessment_pass(purpose),
                Err(error) if error.code == crate::ErrorCode::Verification
            ));
        }

        connection
            .execute(
                "UPDATE port_intents SET record_json='{' WHERE port_id='broken'",
                [],
            )
            .unwrap();
        let pass = library
            .intent_assessment_pass(IntentAssessmentPurpose::StandingSetup)
            .unwrap();
        assert_eq!(pass.total, 1);
        assert_eq!(pass.rows[0].0, "good");

        for key in [
            rusqlite::types::Value::Blob(vec![b'g']),
            rusqlite::types::Value::Null,
        ] {
            connection
                .execute("INSERT INTO port_intents VALUES (?1, 1, '{')", [key])
                .unwrap();
            assert!(matches!(
                library.intent_assessment_pass(IntentAssessmentPurpose::StandingSetup),
                Err(error) if error.code == crate::ErrorCode::Verification
            ));
            connection
                .execute(
                    "DELETE FROM port_intents WHERE typeof(port_id) <> 'text'",
                    [],
                )
                .unwrap();
        }
    }

    #[tokio::test]
    async fn discover_only_is_the_default_and_stores_nothing() {
        let (_temporary, service) = ready_service().await;
        assert!(service.port_intents().unwrap().is_empty());
        let assessed = service.run_standing_setup(|_| {}).await.unwrap();
        assert!(assessed.assessments.is_empty() && assessed.batches.is_empty());
        assert!(service.status(PORT).unwrap().active.is_none());
        service
            .set_port_intent(PORT, PortIntentMode::DiscoverOnly)
            .unwrap();
        assert!(service.port_intents().unwrap().is_empty());
    }

    #[tokio::test]
    async fn assessment_reaches_the_513th_choice_after_restart_and_preserves_edits() {
        let (temporary, service) = ready_service().await;
        for index in 0..MAX_PORT_INTENT_ASSESSMENTS {
            let id = format!("fixture-{index:03}");
            service
                .library
                .update_port_intent_with(&id, false, |record, now| {
                    *record = Some(PortIntent::new(&id, PortIntentMode::Notify, now));
                })
                .unwrap();
        }
        service
            .set_port_intent(PORT, PortIntentMode::Notify)
            .unwrap();
        let first = service.assess_port_intents().await.unwrap();
        assert_eq!(first.assessments.len(), 512);
        assert_eq!(first.not_assessed, 1);
        assert!(first.assessments.iter().all(|row| row.port_id != PORT));
        service
            .library
            .update_port_intent_with("fixture-000", false, |record, _| {
                record.as_mut().unwrap().mode = PortIntentMode::Ignored;
            })
            .unwrap();
        service
            .library
            .connection()
            .unwrap()
            .execute(
                "UPDATE port_intents SET updated_at='bad time' WHERE port_id='fixture-001'",
                [],
            )
            .unwrap();
        service
            .library
            .update_port_intent_with("zz-fixture", false, |record, now| {
                *record = Some(PortIntent::new("zz-fixture", PortIntentMode::Notify, now));
            })
            .unwrap();

        let edited = service
            .port_intents()
            .unwrap()
            .into_iter()
            .find(|intent| intent.port_id == "fixture-000")
            .unwrap();
        assert_eq!(edited.mode, PortIntentMode::Ignored);

        drop(service);
        let service = service_with_release(
            Library::open(temporary.path().join("library")).unwrap(),
            "v1",
        );
        let second = service.assess_port_intents().await.unwrap();
        let reached = &second.assessments[0];
        assert_eq!(reached.port_id, PORT);
        assert!(matches!(reached.readiness, PortReadiness::Ready { .. }));
        assert!(
            second
                .assessments
                .iter()
                .all(|intent| intent.port_id != "fixture-000")
        );
    }

    #[tokio::test]
    async fn standing_setup_and_readiness_each_visit_both_halves() {
        let (_temporary, service) = ready_service().await;
        for index in 0..1024 {
            let id = format!("fixture-{index:04}");
            service
                .library
                .update_port_intent_with(&id, false, |record, now| {
                    *record = Some(PortIntent::new(&id, PortIntentMode::Notify, now));
                })
                .unwrap();
        }
        for expected in ["fixture-0000", "fixture-0512", "fixture-0000"] {
            let standing = service.run_standing_setup(|_| {}).await.unwrap();
            let readiness = service.assess_port_intents().await.unwrap();
            assert_eq!(standing.assessments[0].port_id, expected);
            assert_eq!(readiness.assessments[0].port_id, expected);
            assert_eq!(standing.not_assessed, 512);
            assert_eq!(readiness.not_assessed, 512);
        }
    }

    #[tokio::test]
    async fn notify_reports_a_ready_game_once_and_installs_nothing() {
        let (_temporary, service) = ready_service().await;
        service
            .set_port_intent(PORT, PortIntentMode::Notify)
            .unwrap();
        let first = service.assess_port_intents().await.unwrap();
        let PortReadiness::Ready { plan_sha256, .. } = &first.assessments[0].readiness else {
            panic!("expected ready: {:?}", first.assessments[0]);
        };
        assert!(first.assessments[0].newly_ready);
        service
            .acknowledge_port_readiness(&[PortReadinessAcknowledgement {
                port_id: PORT.into(),
                plan_sha256: plan_sha256.clone(),
            }])
            .unwrap();
        let again = service.assess_port_intents().await.unwrap();
        assert!(!again.assessments[0].newly_ready);
        // Notify is not consent to install.
        let pass = service.run_standing_setup(|_| {}).await.unwrap();
        assert!(pass.batches.is_empty());
        assert!(service.status(PORT).unwrap().active.is_none());
    }

    #[tokio::test]
    async fn turning_ready_notices_off_withholds_only_the_notice() {
        let (_temporary, service) = ready_service().await;
        assert!(service.ready_notices_enabled().unwrap());
        service
            .set_port_intent(PORT, PortIntentMode::Notify)
            .unwrap();
        service.set_ready_notices_enabled(false).unwrap();
        assert!(!service.ready_notices_enabled().unwrap());
        let off = service.assess_port_intents().await.unwrap();
        assert!(!off.ready_notices_enabled);
        // The game is still ready and still set to be told; only the notice is withheld.
        assert!(matches!(
            off.assessments[0].readiness,
            PortReadiness::Ready { .. }
        ));
        assert_eq!(off.assessments[0].mode, PortIntentMode::Notify);
        assert!(!off.assessments[0].newly_ready);
        assert_eq!(
            service.port_intents().unwrap()[0].acknowledged_plan_sha256,
            None
        );
        // Turning it on again announces the still-unannounced game once.
        service.set_ready_notices_enabled(true).unwrap();
        let on = service.assess_port_intents().await.unwrap();
        assert!(on.ready_notices_enabled);
        assert!(on.assessments[0].newly_ready);
    }

    #[tokio::test]
    async fn turning_ready_notices_off_never_stops_a_set_up_when_ready_install() {
        let (_temporary, service) = ready_service().await;
        service
            .set_port_intent(PORT, PortIntentMode::SetUpWhenReady)
            .unwrap();
        service.set_ready_notices_enabled(false).unwrap();
        let pass = service.run_standing_setup(|_| {}).await.unwrap();
        assert_eq!(pass.batches.len(), 1);
        assert!(service.status(PORT).unwrap().active.is_some());
    }

    #[tokio::test]
    async fn the_ready_notice_preference_survives_reopening_the_library() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("library");
        {
            let library = Library::open(&path).unwrap();
            assert!(library.ready_notices_enabled().unwrap());
            library.set_ready_notices_enabled(false).unwrap();
        }
        let library = Library::open(&path).unwrap();
        assert!(!library.ready_notices_enabled().unwrap());
        library.set_ready_notices_enabled(true).unwrap();
        assert!(
            Library::open(&path)
                .unwrap()
                .ready_notices_enabled()
                .unwrap()
        );
    }

    #[tokio::test]
    async fn set_up_when_ready_installs_once_and_remembers_an_uninstall() {
        let (_temporary, service) = ready_service().await;
        service
            .set_port_intent(PORT, PortIntentMode::SetUpWhenReady)
            .unwrap();
        assert_eq!(service.library_memberships().unwrap()[0].port_id, PORT);
        let pass = service.run_standing_setup(|_| {}).await.unwrap();
        assert_eq!(pass.batches.len(), 1);
        assert_eq!(pass.batches[0].items[0].state, InstallBatchItemState::Ready);
        let installed = service.status(PORT).unwrap().active.unwrap();
        // A second pass sees the game installed and does nothing.
        let again = service.run_standing_setup(|_| {}).await.unwrap();
        assert!(again.batches.is_empty());
        assert!(matches!(
            again.assessments[0].readiness,
            PortReadiness::Installed { .. }
        ));
        assert_eq!(
            service.status(PORT).unwrap().active.unwrap().id,
            installed.id
        );
        // Uninstalling through the ordinary removal is remembered, and the
        // next pass does not set the game up again.
        let preview = service.preview_removal(PORT).unwrap();
        let authorization = service
            .authorize_removal(PORT, &preview.preview_sha256)
            .unwrap();
        service.remove(PORT, &authorization.token).unwrap();
        let intent = service.library.port_intent(PORT).unwrap().unwrap();
        assert!(intent.explicitly_uninstalled_at.is_some());
        assert_eq!(intent.mode, PortIntentMode::SetUpWhenReady);
        let after = service.run_standing_setup(|_| {}).await.unwrap();
        assert!(after.batches.is_empty());
        assert!(after.assessments[0].suppressed.is_some());
        assert!(service.status(PORT).unwrap().active.is_none());
    }

    #[tokio::test]
    async fn an_uninstalled_game_is_not_set_up_again_until_chosen_again() {
        let (_temporary, service) = ready_service().await;
        service
            .set_port_intent(PORT, PortIntentMode::SetUpWhenReady)
            .unwrap();
        service.library.record_explicit_uninstall(PORT).unwrap();
        let pass = service.run_standing_setup(|_| {}).await.unwrap();
        assert!(pass.batches.is_empty());
        assert!(pass.assessments[0].suppressed.is_some());
        assert!(service.status(PORT).unwrap().active.is_none());
        // Choosing again re-enrolls the game.
        service
            .set_port_intent(PORT, PortIntentMode::SetUpWhenReady)
            .unwrap();
        let pass = service.run_standing_setup(|_| {}).await.unwrap();
        assert_eq!(pass.batches.len(), 1);
        assert!(service.status(PORT).unwrap().active.is_some());
    }

    #[tokio::test]
    async fn a_failed_plan_is_not_retried_until_the_plan_changes() {
        let (_temporary, service) = ready_service().await;
        service
            .set_port_intent(PORT, PortIntentMode::SetUpWhenReady)
            .unwrap();
        let assessed = service.assess_port_intents().await.unwrap();
        let PortReadiness::Ready { plan_sha256, .. } = &assessed.assessments[0].readiness else {
            panic!("expected ready");
        };
        service
            .library
            .update_port_intent(PORT, |intent, _| {
                let intent = intent.as_mut().unwrap();
                intent.failed_plan_sha256 = Some(plan_sha256.clone());
                intent.failed_attempts = MAX_STANDING_SETUP_ATTEMPTS;
                intent.failure = Some("download failed".into());
                intent.failure_classified = true;
            })
            .unwrap();
        let pass = service.run_standing_setup(|_| {}).await.unwrap();
        assert!(pass.batches.is_empty());
        assert!(
            pass.assessments[0]
                .suppressed
                .as_deref()
                .unwrap()
                .contains("download failed")
        );
        assert!(service.status(PORT).unwrap().active.is_none());
    }

    #[tokio::test]
    async fn a_failure_below_the_attempt_limit_is_tried_again() {
        let (_temporary, service) = ready_service().await;
        service
            .set_port_intent(PORT, PortIntentMode::SetUpWhenReady)
            .unwrap();
        let assessed = service.assess_port_intents().await.unwrap();
        let PortReadiness::Ready { plan_sha256, .. } = &assessed.assessments[0].readiness else {
            panic!("expected ready");
        };
        service.remember_standing_failure(PORT, plan_sha256, "archive was rejected", None);
        let pass = service.run_standing_setup(|_| {}).await.unwrap();
        assert_eq!(pass.batches.len(), 1);
        assert!(service.status(PORT).unwrap().active.is_some());
        let intent = service.library.port_intent(PORT).unwrap().unwrap();
        assert_eq!((intent.failed_attempts, intent.failure), (0, None));
    }

    #[tokio::test]
    async fn temporary_failures_wait_then_recover_the_same_plan_without_an_upstream_change() {
        let (_temporary, service) = ready_service().await;
        service
            .set_port_intent(PORT, PortIntentMode::SetUpWhenReady)
            .unwrap();
        let assessed = service.assess_port_intents().await.unwrap();
        let PortReadiness::Ready { plan_sha256, .. } = &assessed.assessments[0].readiness else {
            panic!("expected ready");
        };
        // More temporary failures than the lasting-attempt limit allows.
        for _ in 0..=MAX_STANDING_SETUP_ATTEMPTS {
            service.remember_standing_failure(
                PORT,
                plan_sha256,
                "connection reset",
                crate::TemporaryFailure::of(
                    &PortcoveError::network("connection reset").transient_transport(),
                ),
            );
        }
        let intent = service.library.port_intent(PORT).unwrap().unwrap();
        assert_eq!(intent.failed_attempts, 0);
        let retry = intent.temporary_retry.clone().unwrap();
        assert_eq!(retry.cause, crate::TemporaryCause::Network);
        assert_eq!(retry.attempts, MAX_STANDING_SETUP_ATTEMPTS + 1);
        // While its back-off runs the game waits, and says it will retry.
        let waiting = service.run_standing_setup(|_| {}).await.unwrap();
        assert!(waiting.batches.is_empty());
        let reason = waiting.assessments[0].suppressed.as_deref().unwrap();
        assert!(reason.contains("will try again automatically"), "{reason}");
        assert!(!reason.contains("files, catalog or requirements change"));

        // Once the back-off has passed, the unchanged plan runs and succeeds.
        service
            .library
            .update_port_intent(PORT, |intent, now| {
                let retry = intent.as_mut().unwrap().temporary_retry.as_mut().unwrap();
                retry.retry_after = now - 1;
            })
            .unwrap();
        let pass = service.run_standing_setup(|_| {}).await.unwrap();
        assert_eq!(pass.batches.len(), 1);
        assert!(service.status(PORT).unwrap().active.is_some());
        let intent = service.library.port_intent(PORT).unwrap().unwrap();
        assert_eq!(intent.failed_plan_sha256, None);
        assert_eq!(intent.temporary_retry, None);
    }

    #[tokio::test]
    async fn a_rate_limit_waits_for_its_stated_reset_instead_of_refusing() {
        let (_temporary, service) = ready_service().await;
        service
            .set_port_intent(PORT, PortIntentMode::SetUpWhenReady)
            .unwrap();
        let assessed = service.assess_port_intents().await.unwrap();
        let PortReadiness::Ready { plan_sha256, .. } = &assessed.assessments[0].readiness else {
            panic!("expected ready");
        };
        let reset = Library::now() + 2 * 60 * 60;
        service.remember_standing_failure(
            PORT,
            plan_sha256,
            "rate limited",
            Some(crate::TemporaryFailure {
                cause: crate::TemporaryCause::RateLimited,
                stated_reset: Some(reset),
            }),
        );
        let intent = service.library.port_intent(PORT).unwrap().unwrap();
        assert_eq!(intent.temporary_retry.unwrap().retry_after, reset);
        assert_eq!(intent.failed_attempts, 0);
        let pass = service.run_standing_setup(|_| {}).await.unwrap();
        assert!(pass.batches.is_empty() && pass.failures.is_empty());
        assert!(
            pass.assessments[0]
                .suppressed
                .as_deref()
                .unwrap()
                .contains("asked Portcove to wait")
        );
    }

    #[tokio::test]
    async fn a_local_allowance_refusal_never_spends_a_setup_attempt() {
        let (_temporary, service) = ready_service().await;
        service
            .set_port_intent(PORT, PortIntentMode::SetUpWhenReady)
            .unwrap();
        let assessed = service.assess_port_intents().await.unwrap();
        let PortReadiness::Ready { plan_sha256, .. } = &assessed.assessments[0].readiness else {
            panic!("expected ready");
        };
        let reset = Library::now() + 30 * 60;
        let refused = crate::PortcoveError::network("not sent").with_known_cause(
            crate::failure::KnownFailureCause::ProviderAllowanceExhausted {
                provider: crate::failure::FailureProvider::Github,
                resets_at: Some(reset),
                throttled: false,
                reset_reported: true,
                signed_in: Some(false),
            },
        );
        for _ in 0..=MAX_STANDING_SETUP_ATTEMPTS {
            service.remember_standing_failure(
                PORT,
                plan_sha256,
                "not sent",
                crate::TemporaryFailure::of(&refused),
            );
        }
        let intent = service.library.port_intent(PORT).unwrap().unwrap();
        assert_eq!(intent.failed_attempts, 0);
        let retry = intent.temporary_retry.unwrap();
        assert_eq!(retry.cause, crate::TemporaryCause::RateLimited);
        assert!(retry.retry_after >= reset);
    }

    #[tokio::test]
    async fn a_lasting_failure_after_temporary_ones_keeps_its_limit() {
        let (_temporary, service) = ready_service().await;
        service
            .set_port_intent(PORT, PortIntentMode::SetUpWhenReady)
            .unwrap();
        let assessed = service.assess_port_intents().await.unwrap();
        let PortReadiness::Ready { plan_sha256, .. } = &assessed.assessments[0].readiness else {
            panic!("expected ready");
        };
        service.remember_standing_failure(
            PORT,
            plan_sha256,
            "connection reset",
            Some(crate::TemporaryFailure::INTERRUPTED),
        );
        for _ in 0..MAX_STANDING_SETUP_ATTEMPTS {
            service.remember_standing_failure(PORT, plan_sha256, "digest mismatch", None);
        }
        let intent = service.library.port_intent(PORT).unwrap().unwrap();
        assert_eq!(intent.failed_attempts, MAX_STANDING_SETUP_ATTEMPTS);
        assert_eq!(intent.temporary_retry, None);
        let pass = service.run_standing_setup(|_| {}).await.unwrap();
        assert!(pass.batches.is_empty());
        assert!(
            pass.assessments[0]
                .suppressed
                .as_deref()
                .unwrap()
                .contains("digest mismatch")
        );
    }

    #[test]
    fn intents_written_before_temporary_retries_still_read() {
        let old = r#"{"format_version":1,"port_id":"game","mode":"set_up_when_ready","updated_at":5,"failed_plan_sha256":"aa","failed_attempts":2,"failure":"download failed"}"#;
        let intent = decode("game", old).unwrap();
        assert_eq!(intent.failed_attempts, 2);
        assert_eq!(intent.temporary_retry, None);
        // Unchanged records keep their exact stored shape.
        assert_eq!(
            serde_json::to_value(&intent).unwrap(),
            serde_json::from_str::<serde_json::Value>(old).unwrap()
        );
    }

    #[tokio::test]
    async fn an_unreadable_choice_does_not_stop_others_and_can_be_replaced() {
        let (_temporary, service) = ready_service().await;
        service
            .set_port_intent(PORT, PortIntentMode::SetUpWhenReady)
            .unwrap();
        service
            .library
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO port_intents(port_id,updated_at,record_json) VALUES ('broken',1,'{')",
                [],
            )
            .unwrap();
        let pass = service.run_standing_setup(|_| {}).await.unwrap();
        assert_eq!(pass.batches.len(), 1);
        // A new explicit choice replaces the unreadable record.
        service
            .set_port_intent("broken", PortIntentMode::Ignored)
            .unwrap();
        assert_eq!(
            service.library.port_intent("broken").unwrap().unwrap().mode,
            PortIntentMode::Ignored
        );
    }

    #[tokio::test]
    async fn only_one_standing_setup_pass_runs_at_a_time() {
        let (_temporary, service) = ready_service().await;
        service
            .set_port_intent(PORT, PortIntentMode::SetUpWhenReady)
            .unwrap();
        let other = service.library.try_lock_activity("standing-setup").unwrap();
        let pass = service.run_standing_setup(|_| {}).await.unwrap();
        assert!(pass.already_running && pass.batches.is_empty());
        assert!(service.status(PORT).unwrap().active.is_none());
        drop(other);
        let pass = service.run_standing_setup(|_| {}).await.unwrap();
        assert_eq!(pass.batches.len(), 1);
    }

    #[test]
    fn a_removed_game_choice_can_still_be_cleared() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let service = service_with_release(library, "v1");
        service
            .library
            .update_port_intent("gone-from-catalog", |record, now| {
                *record = Some(PortIntent::new(
                    "gone-from-catalog",
                    PortIntentMode::SetUpWhenReady,
                    now,
                ));
            })
            .unwrap();
        service
            .set_port_intent("gone-from-catalog", PortIntentMode::DiscoverOnly)
            .unwrap();
        assert!(service.port_intents().unwrap().is_empty());
    }

    #[tokio::test]
    async fn withdrawn_consent_stops_standing_setup() {
        let (_temporary, service) = ready_service().await;
        service
            .set_port_intent(PORT, PortIntentMode::SetUpWhenReady)
            .unwrap();
        service
            .set_port_intent(PORT, PortIntentMode::Ignored)
            .unwrap();
        let pass = service.run_standing_setup(|_| {}).await.unwrap();
        assert!(pass.batches.is_empty() && pass.assessments.is_empty());
        assert!(service.status(PORT).unwrap().active.is_none());
        // The saved Library entry stays; ignoring removes nothing.
        assert_eq!(service.library_memberships().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_waiting_game_is_set_up_exactly_once_when_its_requirements_arrive() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let service = service_with_release(library.clone(), "v1");
        service
            .set_port_intent(PORT, PortIntentMode::SetUpWhenReady)
            .unwrap();
        // Required originals are missing: the choice persists and waits.
        let waiting = service.run_standing_setup(|_| {}).await.unwrap();
        assert!(waiting.batches.is_empty());
        assert!(matches!(
            waiting.assessments[0].readiness,
            PortReadiness::Waiting { .. }
        ));
        // The requirement is satisfied later; nothing is reselected.
        register_zelda_install(&library, "v1", false);
        let first = service.run_standing_setup(|_| {}).await.unwrap();
        assert_eq!(first.batches.len(), 1);
        assert_eq!(
            first.batches[0].items[0].state,
            InstallBatchItemState::Ready
        );
        let installed = service.status(PORT).unwrap().active.unwrap();
        // Repeated passes (refresh, restart catch-up) never install it twice.
        for _ in 0..2 {
            let again = service.run_standing_setup(|_| {}).await.unwrap();
            assert!(again.batches.is_empty());
        }
        assert_eq!(
            service.status(PORT).unwrap().active.unwrap().id,
            installed.id
        );
    }

    #[tokio::test]
    async fn a_disconnected_registered_original_waits_without_spending_attempts() {
        let (temporary, configured, original) = crate::source_reuse::tests::fixture("ntsc-u-1-0");
        let mut service = service_with_release(configured.library().clone(), "v1");
        service.replace_catalog_for_test(configured.catalog().clone());
        let choice = service
            .set_port_intent(PORT, PortIntentMode::SetUpWhenReady)
            .unwrap();

        let connected = service.assess_port_intents().await.unwrap();
        let PortReadiness::Ready { plan_sha256, .. } = &connected.assessments[0].readiness else {
            panic!("expected ready: {connected:?}");
        };
        let offline = temporary.path().join("disconnected.z64");
        std::fs::rename(&original, &offline).unwrap();

        // The source can disappear after this game's initial assessment,
        // while earlier games in the same pass are being installed.
        assert!(
            service
                .standing_setup_one(PORT, plan_sha256, &mut |_| {})
                .await
                .unwrap()
                .is_none()
        );
        for _ in 0..MAX_STANDING_SETUP_ATTEMPTS {
            let pass = service.run_standing_setup(|_| {}).await.unwrap();
            let PortReadiness::Waiting { reason } = &pass.assessments[0].readiness else {
                panic!("expected waiting: {pass:?}");
            };
            assert!(reason.contains("available"), "{reason}");
            assert!(pass.batches.is_empty());
        }
        let saved = service.library().port_intent(PORT).unwrap().unwrap();
        assert_eq!(saved.sources, choice.sources);
        assert_eq!(saved.mode, PortIntentMode::SetUpWhenReady);
        assert_eq!(saved.failed_attempts, 0);
        assert!(service.status(PORT).unwrap().active.is_none());

        std::fs::rename(&offline, &original).unwrap();
        let returned = service.assess_port_intents().await.unwrap();
        assert!(matches!(
            &returned.assessments[0].readiness,
            PortReadiness::Ready { plan_sha256: returned_digest, .. }
                if returned_digest == plan_sha256
        ));
    }

    fn registered_copy(service: &PortcoveService, byte: char) -> crate::SourceRecord {
        let profile_id = service
            .catalog()
            .port(PORT)
            .unwrap()
            .source_profile
            .clone()
            .unwrap();
        let sha256 = byte.to_string().repeat(64);
        let source = crate::SourceRecord {
            profile_id,
            path: std::env::temp_dir().join(format!("portcove-intent-{byte}.z64")),
            sha256: sha256.clone(),
            size: 4,
            storage_sha256: sha256,
            storage_size: 4,
            updated_at: 0,
            observed_identity: None,
        };
        service.library().register_source(&source).unwrap();
        source
    }

    #[tokio::test]
    async fn a_choice_remembers_its_files_and_never_switches_to_another_copy() {
        let (_temporary, service) = ready_service().await;
        let chosen = registered_copy(&service, 'a');
        let intent = service
            .set_port_intent(PORT, PortIntentMode::SetUpWhenReady)
            .unwrap();
        assert_eq!(intent.sources.len(), 1);
        assert_eq!(intent.sources[0].sha256, chosen.sha256);
        assert_eq!(intent.channel, Some(service.status(PORT).unwrap().channel));
        // Another copy is registered later: the choice waits, nothing installs.
        registered_copy(&service, 'b');
        let result = service.run_standing_setup(|_| {}).await.unwrap();
        assert!(result.batches.is_empty());
        let PortReadiness::Waiting { reason } = &result.assessments[0].readiness else {
            panic!("expected waiting: {result:?}");
        };
        assert!(reason.contains("different copy"), "{reason}");
        assert!(service.status(PORT).unwrap().active.is_none());
        // Choosing again accepts the new copy.
        service
            .set_port_intent(PORT, PortIntentMode::SetUpWhenReady)
            .unwrap();
        assert_eq!(
            service
                .run_standing_setup(|_| {})
                .await
                .unwrap()
                .batches
                .len(),
            1
        );
        assert!(service.status(PORT).unwrap().active.is_some());
    }

    #[tokio::test]
    async fn a_removed_copy_waits_and_the_same_copy_moved_does_not() {
        let (_temporary, service) = ready_service().await;
        let chosen = registered_copy(&service, 'a');
        service
            .set_port_intent(PORT, PortIntentMode::SetUpWhenReady)
            .unwrap();
        // The same bytes registered at another path are still the chosen copy.
        service
            .library()
            .register_source(&crate::SourceRecord {
                path: std::env::temp_dir().join("portcove-intent-moved.z64"),
                ..chosen.clone()
            })
            .unwrap();
        let intent = service.library().port_intent(PORT).unwrap().unwrap();
        assert!(service.intent_binding_hold(&intent).is_none());
        // A removed registration waits.
        service.library().remove_source(&chosen.profile_id).unwrap();
        let reason = service.intent_binding_hold(&intent).unwrap();
        assert!(reason.contains("no longer registered"), "{reason}");
        assert!(
            service
                .run_standing_setup(|_| {})
                .await
                .unwrap()
                .batches
                .is_empty()
        );
    }

    #[tokio::test]
    async fn a_changed_channel_waits_for_a_new_choice() {
        let (_temporary, service) = ready_service().await;
        service
            .set_port_intent(PORT, PortIntentMode::SetUpWhenReady)
            .unwrap();
        let current = service.status(PORT).unwrap().channel;
        let other = [
            crate::ReleaseChannel::Stable,
            crate::ReleaseChannel::Beta,
            crate::ReleaseChannel::Rolling,
        ]
        .into_iter()
        .find(|channel| *channel != current)
        .unwrap();
        // The choice was made while the game followed another channel.
        service
            .library()
            .update_port_intent(PORT, |intent, _| {
                intent.as_mut().unwrap().channel = Some(other);
            })
            .unwrap();
        let result = service.run_standing_setup(|_| {}).await.unwrap();
        assert!(result.batches.is_empty());
        let PortReadiness::Waiting { reason } = &result.assessments[0].readiness else {
            panic!("expected waiting: {result:?}");
        };
        assert!(reason.contains("channel"), "{reason}");
        assert!(service.status(PORT).unwrap().active.is_none());
        // Choosing again adopts the current channel.
        service
            .set_port_intent(PORT, PortIntentMode::SetUpWhenReady)
            .unwrap();
        assert_eq!(
            service
                .run_standing_setup(|_| {})
                .await
                .unwrap()
                .batches
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn an_installed_game_reports_its_maintenance_and_announces_an_update_once() {
        let (_temporary, service) = ready_service().await;
        service
            .set_port_intent(PORT, PortIntentMode::SetUpWhenReady)
            .unwrap();
        assert_eq!(
            service
                .run_standing_setup(|_| {})
                .await
                .unwrap()
                .batches
                .len(),
            1
        );
        service
            .set_port_intent(PORT, PortIntentMode::Notify)
            .unwrap();
        let assessed = service.assess_port_intents().await.unwrap();
        let PortReadiness::Installed {
            maintenance: Some(maintenance),
            ..
        } = &assessed.assessments[0].readiness
        else {
            panic!("expected installed: {assessed:?}");
        };
        assert_eq!(maintenance.active_version, "v1");
        assert!(maintenance.available_version.is_none());
        assert!(!maintenance.busy);
        assert!(maintenance.previous_version.is_none());
        assert!(!assessed.assessments[0].newly_ready);
        // A check finds a newer release on the game's channel.
        let status = service.status(PORT).unwrap();
        let mut release = crate::ResolvedRelease {
            version: "v2".into(),
            channel: status.channel,
            published_at: None,
            asset: crate::ReleaseAsset {
                name: "v2.zip".into(),
                url: "https://example.invalid/v2.zip".into(),
                size: 1,
                sha256: "2".repeat(64),
            },
            uploader_continuity: None,
        };
        let active = status.active.clone().unwrap();
        let check = |installed_version: &str, release: crate::ResolvedRelease| crate::UpdateCheck {
            exact_release: None,
            channel_latest_version: None,
            port_id: PORT.into(),
            channel: status.channel,
            installed_version: Some(installed_version.into()),
            installed_artifact: Some(active.artifact.clone()),
            installed_runtime: active.runtime.clone(),
            required_runtime: None,
            update_available: true,
            release,
            upstream_activity: None,
        };
        service
            .library()
            .store_update_snapshot(&check("v0", release.clone()))
            .unwrap();
        // A check made for another install is stale and ignored.
        assert!(!service.assess_port_intents().await.unwrap().assessments[0].newly_ready);
        service
            .library()
            .store_update_snapshot(&check("v1", release.clone()))
            .unwrap();
        let assessed = service.assess_port_intents().await.unwrap();
        let item = &assessed.assessments[0];
        assert!(item.newly_ready);
        let PortReadiness::Installed {
            maintenance: Some(maintenance),
            ..
        } = &item.readiness
        else {
            panic!("expected installed");
        };
        assert_eq!(maintenance.available_version.as_deref(), Some("v2"));
        // Told once; nothing was downloaded, staged or activated.
        service
            .acknowledge_port_readiness(&[PortReadinessAcknowledgement {
                port_id: PORT.into(),
                plan_sha256: release.asset.sha256.clone(),
            }])
            .unwrap();
        assert!(!service.assess_port_intents().await.unwrap().assessments[0].newly_ready);
        let after = service.status(PORT).unwrap();
        assert_eq!(after.active.unwrap().version, "v1");
        assert!(after.staged.is_none());
        // A different newer release is announced again.
        release.version = "v3".into();
        release.asset.sha256 = "3".repeat(64);
        service
            .library()
            .store_update_snapshot(&check("v1", release))
            .unwrap();
        assert!(service.assess_port_intents().await.unwrap().assessments[0].newly_ready);
        // A set-up-when-ready game is never announced; standing setup never updates.
        service
            .set_port_intent(PORT, PortIntentMode::SetUpWhenReady)
            .unwrap();
        assert!(!service.assess_port_intents().await.unwrap().assessments[0].newly_ready);
        assert!(
            service
                .run_standing_setup(|_| {})
                .await
                .unwrap()
                .batches
                .is_empty()
        );
        // Unfinished lifecycle work marks the installed game busy.
        let now = Library::now();
        service
            .library()
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO lifecycle_operations(id,kind,port_id,phase,created_at,updated_at)
                 VALUES ('pending-update','update',?1,'prepared',?2,?2)",
                params![PORT, now],
            )
            .unwrap();
        let PortReadiness::Installed {
            maintenance: Some(maintenance),
            ..
        } = &service.assess_port_intents().await.unwrap().assessments[0].readiness
        else {
            panic!("expected installed");
        };
        assert!(maintenance.busy);
    }

    #[test]
    fn a_retained_update_download_is_not_unfinished_work() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let now = Library::now();
        library
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO lifecycle_operations(id,kind,port_id,phase,created_at,updated_at)
                 VALUES ('kept-download','acquire_update',?1,'acquired',?2,?2)",
                params![PORT, now],
            )
            .unwrap();
        assert!(!library.has_unfinished_lifecycle(PORT).unwrap());
        library
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO lifecycle_operations(id,kind,port_id,phase,created_at,updated_at)
                 VALUES ('pending-install','install',?1,'prepared',?2,?2)",
                params![PORT, now],
            )
            .unwrap();
        assert!(library.has_unfinished_lifecycle(PORT).unwrap());
    }

    #[tokio::test]
    async fn an_interrupted_standing_setup_is_reconciled_before_anything_else() {
        let (_temporary, service) = ready_service().await;
        service
            .set_port_intent(PORT, PortIntentMode::SetUpWhenReady)
            .unwrap();
        let plan = service.plan_game_install(PORT).await.unwrap();
        // A pass started this game's batch, then the process stopped mid-run.
        let batch = service
            .start_install_batch(
                &[InstallBatchRequestItem {
                    port_id: PORT.into(),
                    expected_plan_sha256: plan.plan_sha256.clone(),
                }],
                LibraryMembershipOrigin::Manual,
            )
            .unwrap();
        service
            .library()
            .update_install_batch(&batch.id, |record| {
                record.items[0].state = InstallBatchItemState::Running;
            })
            .unwrap();
        // The next pass settles it against committed state first: nothing was
        // committed, so it is interrupted, counted once, and then set up
        // afresh with a new plan check and authorization.
        let result = service.run_standing_setup(|_| {}).await.unwrap();
        let settled = service.install_batch(&batch.id).unwrap().unwrap();
        assert_eq!(settled.items[0].state, InstallBatchItemState::Interrupted);
        assert_eq!(result.batches.len(), 1);
        let installed = service.status(PORT).unwrap().active.unwrap();
        // A later pass repeats nothing.
        assert!(
            service
                .run_standing_setup(|_| {})
                .await
                .unwrap()
                .batches
                .is_empty()
        );
        assert_eq!(
            service.status(PORT).unwrap().active.unwrap().id,
            installed.id
        );
        assert!(service.unfinished_install_batches().unwrap().is_empty());
    }

    fn interrupted_batch(service: &PortcoveService, plan_sha256: &str) -> String {
        let batch = service
            .start_install_batch(
                &[InstallBatchRequestItem {
                    port_id: PORT.into(),
                    expected_plan_sha256: plan_sha256.to_owned(),
                }],
                LibraryMembershipOrigin::Manual,
            )
            .unwrap();
        service
            .library()
            .update_install_batch(&batch.id, |record| {
                record.items[0].state = InstallBatchItemState::Running;
            })
            .unwrap();
        batch.id
    }

    #[tokio::test]
    async fn unfinished_install_work_is_left_to_recovery() {
        let (_temporary, service) = ready_service().await;
        service
            .set_port_intent(PORT, PortIntentMode::SetUpWhenReady)
            .unwrap();
        let plan = service.plan_game_install(PORT).await.unwrap();
        let batch_id = interrupted_batch(&service, &plan.plan_sha256);
        // The crash left a publication journal that recovery may roll forward.
        let now = Library::now();
        service
            .library()
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO lifecycle_operations(id,kind,port_id,phase,created_at,updated_at)
                 VALUES ('crashed-install','install',?1,'payload_published',?2,?2)",
                params![PORT, now],
            )
            .unwrap();
        for _ in 0..2 {
            let result = service.run_standing_setup(|_| {}).await.unwrap();
            assert!(result.batches.is_empty(), "{result:?}");
            let PortReadiness::Waiting { reason } = &result.assessments[0].readiness else {
                panic!("expected waiting: {result:?}");
            };
            assert!(reason.contains("recover"), "{reason}");
        }
        // The batch stays in progress, nothing is counted, nothing installs.
        let held = service.install_batch(&batch_id).unwrap().unwrap();
        assert_eq!(held.items[0].state, InstallBatchItemState::Running);
        assert_eq!(
            service
                .library()
                .port_intent(PORT)
                .unwrap()
                .unwrap()
                .failed_attempts,
            0
        );
        assert!(service.status(PORT).unwrap().active.is_none());
    }

    #[tokio::test]
    async fn a_players_own_interrupted_install_spends_no_standing_attempts() {
        let (_temporary, service) = ready_service().await;
        service
            .set_port_intent(PORT, PortIntentMode::Notify)
            .unwrap();
        let plan = service.plan_game_install(PORT).await.unwrap();
        let batch_id = interrupted_batch(&service, &plan.plan_sha256);
        service.recover_interrupted_setups();
        assert_eq!(
            service
                .library()
                .port_intent(PORT)
                .unwrap()
                .unwrap()
                .failed_attempts,
            0
        );
        // Not standing consent: left in progress for the player, as before.
        assert_eq!(
            service.install_batch(&batch_id).unwrap().unwrap().items[0].state,
            InstallBatchItemState::Running
        );
    }

    #[tokio::test]
    async fn repeated_unclean_stops_back_off_then_become_lasting() {
        let (_temporary, service) = ready_service().await;
        service
            .set_port_intent(PORT, PortIntentMode::SetUpWhenReady)
            .unwrap();
        let plan = service.plan_game_install(PORT).await.unwrap();
        let interrupt = |service: &PortcoveService| {
            let batch = service
                .start_install_batch(
                    &[InstallBatchRequestItem {
                        port_id: PORT.into(),
                        expected_plan_sha256: plan.plan_sha256.clone(),
                    }],
                    LibraryMembershipOrigin::Manual,
                )
                .unwrap();
            service
                .library()
                .update_install_batch(&batch.id, |record| {
                    record.items[0].state = InstallBatchItemState::Running;
                })
                .unwrap();
            service.recover_interrupted_setups();
        };
        // Below the limit an unclean stop is temporary: no attempt is spent
        // and the same plan continues after its back-off.
        for stops in 1..crate::temporary_failure::MAX_CONSECUTIVE_UNCLEAN_STOPS {
            interrupt(&service);
            let intent = service.library().port_intent(PORT).unwrap().unwrap();
            assert_eq!(intent.failed_attempts, 0);
            let retry = intent.temporary_retry.unwrap();
            assert_eq!(retry.cause, crate::TemporaryCause::Interrupted);
            assert_eq!(retry.attempts, stops);
        }
        // A setup that keeps ending Portcove must not repeat forever.
        interrupt(&service);
        let intent = service.library().port_intent(PORT).unwrap().unwrap();
        assert_eq!(intent.failed_attempts, MAX_STANDING_SETUP_ATTEMPTS);
        assert_eq!(intent.temporary_retry, None);
        let pass = service.run_standing_setup(|_| {}).await.unwrap();
        assert!(pass.batches.is_empty());
        assert!(
            pass.assessments[0]
                .suppressed
                .as_deref()
                .unwrap()
                .contains("times in a row")
        );
        assert!(service.status(PORT).unwrap().active.is_none());
    }

    #[tokio::test]
    async fn clean_stops_left_unsettled_by_an_exit_never_count() {
        let (_temporary, service) = ready_service().await;
        service
            .set_port_intent(PORT, PortIntentMode::SetUpWhenReady)
            .unwrap();
        let plan = service.plan_game_install(PORT).await.unwrap();
        // Each time, Portcove recorded its clean stop and then exited before
        // the install settled, so the batch was left mid-run.
        for _ in 0..2 * crate::temporary_failure::MAX_CONSECUTIVE_UNCLEAN_STOPS {
            let batch_id = interrupted_batch(&service, &plan.plan_sha256);
            service.mark_install_batch_clean_stop(&batch_id).unwrap();
            service.recover_interrupted_setups();
            assert_eq!(
                service.install_batch(&batch_id).unwrap().unwrap().items[0].state,
                InstallBatchItemState::Interrupted
            );
            let intent = service.library().port_intent(PORT).unwrap().unwrap();
            assert_eq!(intent.failed_attempts, 0);
            let retry = intent.temporary_retry.unwrap();
            assert_eq!(retry.cause, crate::TemporaryCause::CleanStop);
            assert!(!retry.waiting(Library::now()));
        }
        let pass = service.run_standing_setup(|_| {}).await.unwrap();
        assert_eq!(pass.batches.len(), 1, "{pass:?}");
        assert!(service.status(PORT).unwrap().active.is_some());
    }

    #[tokio::test]
    async fn unclean_stops_that_keep_making_download_progress_stay_temporary() {
        let (_temporary, service) = ready_service().await;
        service
            .set_port_intent(PORT, PortIntentMode::SetUpWhenReady)
            .unwrap();
        let plan = service.plan_game_install(PORT).await.unwrap();
        let store = service.library().downloads_dir().join("partial-v1");
        std::fs::create_dir_all(&store).unwrap();
        let own = format!("{}-4096", "c".repeat(64));
        let unrelated = format!("{}-4096", "d".repeat(64));
        for key in [&own, &unrelated] {
            std::fs::write(store.join(format!("{key}.json")), b"{}").unwrap();
        }
        let grow = |key: &str, stop: u32| {
            std::fs::write(
                store.join(format!("{key}.part")),
                vec![0_u8; usize::try_from(stop).unwrap() * 100],
            )
            .unwrap();
        };
        // The crashed batch remembers which downloads its plan uses.
        let crash = || {
            let batch_id = interrupted_batch(&service, &plan.plan_sha256);
            service
                .library()
                .update_install_batch(&batch_id, |record| {
                    record.items[0].download_keys = vec![own.clone()];
                })
                .unwrap();
            service.recover_interrupted_setups();
        };
        for stop in 1..=3 * crate::temporary_failure::MAX_CONSECUTIVE_UNCLEAN_STOPS {
            // This plan's own download kept more bytes than before each crash.
            grow(&own, stop);
            crash();
            let intent = service.library().port_intent(PORT).unwrap().unwrap();
            assert_eq!(intent.failed_attempts, 0, "stop {stop}");
            let retry = intent.temporary_retry.unwrap();
            assert_eq!(retry.cause, crate::TemporaryCause::Interrupted);
            assert_eq!(retry.attempts, 1, "stop {stop}");
        }
        // Another game's download growing is not this setup's progress: the
        // crash loop still reaches its limit.
        for stop in 1..crate::temporary_failure::MAX_CONSECUTIVE_UNCLEAN_STOPS {
            grow(&unrelated, stop);
            crash();
        }
        let intent = service.library().port_intent(PORT).unwrap().unwrap();
        assert_eq!(intent.failed_attempts, MAX_STANDING_SETUP_ATTEMPTS);
        assert_eq!(intent.temporary_retry, None);
    }

    #[tokio::test]
    async fn a_record_at_the_limit_from_before_classification_waits_on_a_temporary_failure() {
        let (_temporary, service) = ready_service().await;
        service
            .set_port_intent(PORT, PortIntentMode::SetUpWhenReady)
            .unwrap();
        let plan = service.plan_game_install(PORT).await.unwrap();
        // As written by an earlier Portcove that counted network outages.
        service
            .library()
            .update_port_intent(PORT, |intent, _| {
                let intent = intent.as_mut().unwrap();
                intent.failed_plan_sha256 = Some(plan.plan_sha256.clone());
                intent.failed_attempts = MAX_STANDING_SETUP_ATTEMPTS;
                intent.failure = Some("network unavailable".into());
                intent.failure_classified = false;
            })
            .unwrap();
        // Its one re-attempt meets a temporary failure: it waits, it is not
        // exhausted.
        service.remember_standing_failure(
            PORT,
            &plan.plan_sha256,
            "connection reset",
            crate::TemporaryFailure::of(
                &PortcoveError::network("connection reset").transient_transport(),
            ),
        );
        let intent = service.library().port_intent(PORT).unwrap().unwrap();
        assert!(intent.failure_classified);
        assert_eq!(intent.failed_attempts, MAX_STANDING_SETUP_ATTEMPTS - 1);
        assert!(!intent.exhausted(&plan.plan_sha256));
        let waiting = service.run_standing_setup(|_| {}).await.unwrap();
        assert!(waiting.batches.is_empty());
        let reason = waiting.assessments[0].suppressed.as_deref().unwrap();
        assert!(reason.contains("will try again automatically"), "{reason}");
        assert!(waiting.assessments[0].next_attempt_at.is_some());

        // Exactly one re-attempt: once its wait passes, a lasting failure
        // reaches the limit, and no later pass or launch tries again.
        service
            .library()
            .update_port_intent(PORT, |intent, now| {
                let retry = intent.as_mut().unwrap().temporary_retry.as_mut().unwrap();
                retry.retry_after = now - 1;
            })
            .unwrap();
        service.remember_standing_failure(PORT, &plan.plan_sha256, "archive was rejected", None);
        let intent = service.library().port_intent(PORT).unwrap().unwrap();
        assert_eq!(intent.failed_attempts, MAX_STANDING_SETUP_ATTEMPTS);
        for _ in 0..2 {
            let pass = service.run_standing_setup(|_| {}).await.unwrap();
            assert!(pass.batches.is_empty());
            assert!(
                pass.assessments[0]
                    .suppressed
                    .as_deref()
                    .unwrap()
                    .contains("archive was rejected")
            );
        }
        assert!(service.status(PORT).unwrap().active.is_none());
    }

    #[tokio::test]
    async fn a_record_at_the_limit_from_before_classification_gets_one_more_attempt() {
        let (_temporary, service) = ready_service().await;
        service
            .set_port_intent(PORT, PortIntentMode::SetUpWhenReady)
            .unwrap();
        let plan = service.plan_game_install(PORT).await.unwrap();
        // As written by an earlier Portcove that counted network outages.
        service
            .library()
            .update_port_intent(PORT, |intent, _| {
                let intent = intent.as_mut().unwrap();
                intent.failed_plan_sha256 = Some(plan.plan_sha256.clone());
                intent.failed_attempts = MAX_STANDING_SETUP_ATTEMPTS;
                intent.failure = Some("network unavailable".into());
                intent.failure_classified = false;
            })
            .unwrap();
        let pass = service.run_standing_setup(|_| {}).await.unwrap();
        assert_eq!(pass.batches.len(), 1);
        assert!(service.status(PORT).unwrap().active.is_some());
        let intent = service.library().port_intent(PORT).unwrap().unwrap();
        assert_eq!((intent.failed_attempts, intent.failure), (0, None));
    }

    #[tokio::test]
    async fn an_incomplete_inventory_never_spends_a_lasting_attempt() {
        let (_temporary, service) = ready_service().await;
        service
            .set_port_intent(PORT, PortIntentMode::SetUpWhenReady)
            .unwrap();
        let plan = service.plan_game_install(PORT).await.unwrap();
        let incomplete = PortcoveError::network("the release list was incomplete")
            .with_known_cause(crate::failure::KnownFailureCause::InventoryIncomplete {
                provider: crate::failure::FailureProvider::Github,
                inventory: "release history",
                read: 2,
                total: None,
                resets_at: None,
                rate_limit: None,
            });
        for _ in 0..=MAX_STANDING_SETUP_ATTEMPTS {
            service.remember_standing_failure(
                PORT,
                &plan.plan_sha256,
                &incomplete.message,
                crate::TemporaryFailure::of(&incomplete),
            );
        }
        let intent = service.library().port_intent(PORT).unwrap().unwrap();
        assert_eq!(intent.failed_attempts, 0);
        assert_eq!(
            intent.temporary_retry.unwrap().cause,
            crate::TemporaryCause::InventoryIncomplete
        );
    }

    #[tokio::test]
    async fn provider_enumeration_cut_off_by_throttling_waits_without_spending_attempts() {
        // The shape the GitLab release walk and the Thunderstore chunk reader
        // raise when a list request is throttled part way: the incomplete
        // listing wraps the 429 and keeps its stated wait.
        let (_temporary, service) = ready_service().await;
        service
            .set_port_intent(PORT, PortIntentMode::SetUpWhenReady)
            .unwrap();
        let plan = service.plan_game_install(PORT).await.unwrap();
        for provider in [
            crate::failure::FailureProvider::Gitlab,
            crate::failure::FailureProvider::Thunderstore,
        ] {
            let now = crate::Library::now();
            let throttled = PortcoveError::network("provider returned 429 Too Many Requests")
                .with_upstream(Some(crate::failure::UpstreamObservation::Status(429)))
                .detail("retry_after", "600");
            let incomplete = crate::failure::inventory_incomplete_after(
                provider,
                "listing",
                3,
                Some(26),
                throttled,
            );
            assert!(incomplete.is_inventory_incomplete());
            for _ in 0..=MAX_STANDING_SETUP_ATTEMPTS {
                service.remember_standing_failure(
                    PORT,
                    &plan.plan_sha256,
                    &incomplete.message,
                    crate::TemporaryFailure::of(&incomplete),
                );
            }
            let intent = service.library().port_intent(PORT).unwrap().unwrap();
            assert_eq!(intent.failed_attempts, 0);
            let retry = intent.temporary_retry.unwrap();
            assert_eq!(retry.cause, crate::TemporaryCause::InventoryIncomplete);
            assert!(retry.retry_after >= now + 600, "{retry:?}");
        }
    }

    #[test]
    fn unknown_games_cannot_get_an_intent() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let service = service_with_release(library, "v1");
        assert!(
            service
                .set_port_intent("no-such-port", PortIntentMode::Notify)
                .is_err()
        );
        assert!(service.port_intents().unwrap().is_empty());
    }
}
