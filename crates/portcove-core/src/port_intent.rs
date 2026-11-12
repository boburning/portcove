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
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum PortReadiness {
    /// Installed already; standing setup never reinstalls or updates it.
    Installed { install_id: String },
    /// A first install could start now with this exact plan.
    Ready {
        plan_sha256: String,
        version: String,
    },
    /// Something is missing or needs a person; the reason says what.
    Waiting { reason: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct PortIntentAssessment {
    pub port_id: String,
    pub mode: PortIntentMode,
    pub readiness: PortReadiness,
    /// Why this intent will not act or notify right now, if it won't.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suppressed: Option<String>,
    /// Ready with a plan the player has not been told about yet.
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
                intent.clone()
            })
    }

    pub fn port_intents(&self) -> Result<Vec<PortIntent>> {
        self.library.port_intents()
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
            Ok(status) => self.port_readiness(&intent.port_id, status).await,
            Err(error) => PortReadiness::Waiting {
                reason: error.message,
            },
        };
        self.assessment(intent, readiness)
    }

    async fn port_readiness(&self, port_id: &str, status: crate::PortStatus) -> PortReadiness {
        if let Some(active) = status.active {
            PortReadiness::Installed {
                install_id: active.id,
            }
        } else if status.external_runtime.is_some() {
            PortReadiness::Waiting {
                reason: "this game is registered from another launcher; Portcove does not install over it".to_owned(),
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
        let newly_ready = suppressed.is_none()
            && matches!(&readiness, PortReadiness::Ready { plan_sha256, .. }
                if intent.acknowledged_plan_sha256.as_deref() != Some(plan_sha256.as_str()));
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
