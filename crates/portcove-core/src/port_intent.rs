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
    /// failed. It is retried on later passes up to a small limit, then waits
    /// until the plan changes, so a permanent failure does not recur.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failed_plan_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub failed_attempts: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure: Option<String>,
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
    /// Ready with a plan, or installed with an update, the player has not
    /// been told about yet.
    pub newly_ready: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct PortIntentAssessments {
    pub assessments: Vec<PortIntentAssessment>,
    /// Intents left for a later pass because one pass is bounded.
    pub not_assessed: u32,
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

/// What one standing-setup pass did for each game it considered.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct StandingSetupResult {
    /// Another process is already running a pass; this one did nothing.
    pub already_running: bool,
    pub assessments: Vec<PortIntentAssessment>,
    pub not_assessed: u32,
    /// One single-game batch per game that started, in order.
    pub batches: Vec<InstallBatchRecord>,
    /// Games that could not start; the others were not affected.
    pub failures: Vec<StandingSetupFailure>,
    /// Matched files in folders with automatic setup that wait for a person
    /// or a requirement.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub root_waiting: Vec<crate::RootSetupWaiting>,
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
            channel: None,
            sources: Vec::new(),
        }
    }

    fn clear_failure(&mut self) {
        self.failed_plan_sha256 = None;
        self.failed_attempts = 0;
        self.failure = None;
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

impl Library {
    /// Whether this game has a lifecycle operation (an install, update or
    /// data change) that hasn't finished or recovered yet. Such a game is left
    /// to recovery; nothing new starts for it.
    pub(crate) fn has_unfinished_lifecycle(&self, port_id: &str) -> Result<bool> {
        Ok(self.connection()?.query_row(
            "SELECT EXISTS(SELECT 1 FROM lifecycle_operations WHERE port_id=?1)",
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

    /// Reassesses every remembered notify or set-up-when-ready choice with the
    /// ordinary first-install planner, so changed files, catalog contracts and
    /// prerequisites are reflected without reselecting anything. Reads only.
    pub async fn assess_port_intents(&self) -> Result<PortIntentAssessments> {
        let intents = self
            .library
            .port_intents()?
            .into_iter()
            .filter(|intent| {
                matches!(
                    intent.mode,
                    PortIntentMode::Notify | PortIntentMode::SetUpWhenReady
                )
            })
            .collect::<Vec<_>>();
        let not_assessed = intents.len().saturating_sub(MAX_PORT_INTENT_ASSESSMENTS);
        let mut assessments = Vec::new();
        for intent in intents.into_iter().take(MAX_PORT_INTENT_ASSESSMENTS) {
            assessments.push(self.assess_port_intent(&intent).await);
        }
        Ok(PortIntentAssessments {
            assessments,
            not_assessed: u32::try_from(not_assessed).unwrap_or(u32::MAX),
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
        let suppressed = if intent.explicitly_uninstalled_at.is_some() {
            Some("you uninstalled this game; choose again to set it up or be told".to_owned())
        } else if let PortReadiness::Ready { plan_sha256, .. } = &readiness
            && intent.failed_plan_sha256.as_deref() == Some(plan_sha256.as_str())
            && intent.failed_attempts >= MAX_STANDING_SETUP_ATTEMPTS
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
                    assessments: Vec::new(),
                    not_assessed: 0,
                    batches: Vec::new(),
                    failures: Vec::new(),
                    root_waiting: Vec::new(),
                });
            }
            Err(error) => return Err(error),
        };
        self.recover_interrupted_setups();
        let assessed = self.assess_port_intents().await?;
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
        for assessment in &assessed.assessments {
            let PortReadiness::Ready { plan_sha256, .. } = &assessment.readiness else {
                continue;
            };
            if assessment.mode != PortIntentMode::SetUpWhenReady
                || assessment.suppressed.is_some()
                || busy.contains(&assessment.port_id)
            {
                continue;
            }
            match self
                .standing_setup_one(&assessment.port_id, plan_sha256, &mut emit)
                .await
            {
                Ok(Some(record)) => batches.push(record),
                Ok(None) => {}
                Err(error) => {
                    self.remember_standing_failure(
                        &assessment.port_id,
                        plan_sha256,
                        &error.message,
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
            .run_root_setup(&busy, &mut handled, &mut batches, &mut failures, &mut emit)
            .await
        {
            Ok(waiting) => waiting,
            Err(error) => {
                tracing::warn!(error = %error.message, "folder setup pass did not finish");
                Vec::new()
            }
        };
        Ok(StandingSetupResult {
            already_running: false,
            assessments: assessed.assessments,
            not_assessed: assessed.not_assessed,
            batches,
            failures,
            root_waiting,
        })
    }

    /// Settles batches left mid-run by an interruption before anything new
    /// starts: a committed install counts as ready, and a game with nothing
    /// committed is marked interrupted. Batches another process is running,
    /// and games another operation holds, are left alone. For a game set up
    /// under standing consent, an interruption counts as a failed attempt for
    /// that plan, so repeated interruptions stop at the attempt limit.
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
                            self.remember_standing_failure(
                                &item.port_id,
                                &item.expected_plan_sha256,
                                "setup was interrupted before it finished",
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
        // Consent can be withdrawn while earlier games run.
        let still_wanted = self.library.port_intent(port_id)?.is_some_and(|intent| {
            intent.mode == PortIntentMode::SetUpWhenReady
                && intent.explicitly_uninstalled_at.is_none()
                && self.intent_binding_hold(&intent).is_none()
        });
        if !still_wanted {
            return Ok(None);
        }
        let batch = self.start_install_batch(
            &[InstallBatchRequestItem {
                port_id: port_id.to_owned(),
                expected_plan_sha256: plan_sha256.to_owned(),
            }],
            LibraryMembershipOrigin::Manual,
        )?;
        let record = self.run_install_batch(&batch.id, &mut *emit).await?;
        for item in &record.items {
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
                    self.remember_standing_failure(
                        &item.port_id,
                        &item.expected_plan_sha256,
                        item.detail.as_deref().unwrap_or("setup did not finish"),
                    );
                }
                _ => {}
            }
        }
        Ok(Some(record))
    }

    /// Counts a failed attempt for this plan. Best effort: if it can't be
    /// recorded, the next pass simply tries again within the same limits.
    fn remember_standing_failure(&self, port_id: &str, plan_sha256: &str, reason: &str) {
        let result = self.library.update_port_intent(port_id, |intent, _| {
            let Some(intent) = intent else { return };
            if intent.failed_plan_sha256.as_deref() == Some(plan_sha256) {
                intent.failed_attempts = intent.failed_attempts.saturating_add(1);
            } else {
                intent.failed_plan_sha256 = Some(plan_sha256.to_owned());
                intent.failed_attempts = 1;
            }
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
        service.remember_standing_failure(PORT, plan_sha256, "network unavailable");
        let pass = service.run_standing_setup(|_| {}).await.unwrap();
        assert_eq!(pass.batches.len(), 1);
        assert!(service.status(PORT).unwrap().active.is_some());
        let intent = service.library.port_intent(PORT).unwrap().unwrap();
        assert_eq!((intent.failed_attempts, intent.failure), (0, None));
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
        };
        let active = status.active.clone().unwrap();
        let check = |installed_version: &str, release: crate::ResolvedRelease| crate::UpdateCheck {
            port_id: PORT.into(),
            channel: status.channel,
            installed_version: Some(installed_version.into()),
            installed_artifact: Some(active.artifact.clone()),
            installed_runtime: active.runtime.clone(),
            required_runtime: None,
            update_available: true,
            release,
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
    async fn repeated_interruptions_stop_at_the_attempt_limit() {
        let (_temporary, service) = ready_service().await;
        service
            .set_port_intent(PORT, PortIntentMode::SetUpWhenReady)
            .unwrap();
        let plan = service.plan_game_install(PORT).await.unwrap();
        for _ in 0..MAX_STANDING_SETUP_ATTEMPTS {
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
        }
        let intent = service.library().port_intent(PORT).unwrap().unwrap();
        assert_eq!(intent.failed_attempts, MAX_STANDING_SETUP_ATTEMPTS);
        // The plan now waits for a change instead of being retried.
        assert!(
            service
                .run_standing_setup(|_| {})
                .await
                .unwrap()
                .batches
                .is_empty()
        );
        assert!(service.status(PORT).unwrap().active.is_none());
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
