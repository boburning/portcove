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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PortIntentMode {
    /// Portcove may show the game in discovery results. Nothing else happens.
    DiscoverOnly,
    /// Tell the player once each time the game becomes ready to install.
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
    /// The plan whose standing setup last failed. It is not retried until the
    /// plan changes, so a permanent failure does not recur on every refresh.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failed_plan_sha256: Option<String>,
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

/// What one standing-setup pass did for each game it considered.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct StandingSetupResult {
    pub assessments: Vec<PortIntentAssessment>,
    pub not_assessed: u32,
    /// One single-game batch per game that started, in order.
    pub batches: Vec<InstallBatchRecord>,
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
            failure: None,
        }
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
        rows.iter().map(|(id, json)| decode(id, json)).collect()
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
        let mut record = json.map(|json| decode(port_id, &json)).transpose()?;
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
        self.update_port_intent(port_id, |record, now| {
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
        self.catalog.listing(port_id)?;
        if mode == PortIntentMode::SetUpWhenReady {
            self.add_games_to_library(&[crate::LibraryMembershipRequest {
                port_id: port_id.to_owned(),
                origin: LibraryMembershipOrigin::Manual,
                sources: Vec::new(),
            }])?;
        }
        self.library.update_port_intent(port_id, |record, now| {
            if mode == PortIntentMode::DiscoverOnly {
                // The default needs no record unless an uninstall must be kept.
                if record
                    .as_ref()
                    .is_some_and(|intent| intent.explicitly_uninstalled_at.is_some())
                {
                    let intent = record.as_mut().expect("checked above");
                    intent.mode = mode;
                    intent.failed_plan_sha256 = None;
                    intent.failure = None;
                    return intent.clone();
                }
                *record = None;
                return PortIntent::new(port_id, mode, now);
            }
            let intent = record.get_or_insert_with(|| PortIntent::new(port_id, mode, now));
            intent.mode = mode;
            intent.explicitly_uninstalled_at = None;
            intent.failed_plan_sha256 = None;
            intent.failure = None;
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
            assessments.push(self.assess_port_intent(&intent).await?);
        }
        Ok(PortIntentAssessments {
            assessments,
            not_assessed: u32::try_from(not_assessed).unwrap_or(u32::MAX),
        })
    }

    async fn assess_port_intent(&self, intent: &PortIntent) -> Result<PortIntentAssessment> {
        let status = self
            .library
            .status(&intent.port_id, crate::ReleaseChannel::Stable)?;
        let readiness = if let Some(active) = status.active {
            PortReadiness::Installed {
                install_id: active.id,
            }
        } else if status.external_runtime.is_some() {
            PortReadiness::Waiting {
                reason: "this game is registered from another launcher; Portcove does not install over it".to_owned(),
            }
        } else {
            match self.plan_game_install(&intent.port_id).await {
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
        };
        let suppressed = if intent.explicitly_uninstalled_at.is_some() {
            Some("you uninstalled this game; choose again to set it up or be told".to_owned())
        } else if let PortReadiness::Ready { plan_sha256, .. } = &readiness
            && intent.failed_plan_sha256.as_deref() == Some(plan_sha256.as_str())
        {
            Some(format!(
                "setup failed with this plan{}; it will try again when the plan changes",
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
        Ok(PortIntentAssessment {
            port_id: intent.port_id.clone(),
            mode: intent.mode,
            readiness,
            suppressed,
            newly_ready,
        })
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
    /// ready now, one game at a time. Before each game it checks the choice
    /// still stands, then the batch re-plans and authorizes it fresh. A game
    /// already in an unfinished batch is left to that batch. Never launches.
    pub async fn run_standing_setup(
        &self,
        mut emit: impl FnMut(OperationEvent),
    ) -> Result<StandingSetupResult> {
        let assessed = self.assess_port_intents().await?;
        let busy = self
            .unfinished_install_batches()?
            .into_iter()
            .flat_map(|batch| batch.items.into_iter().map(|item| item.port_id))
            .collect::<std::collections::BTreeSet<_>>();
        let mut batches = Vec::new();
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
            // Consent can be withdrawn while earlier games run.
            let still_wanted =
                self.library
                    .port_intent(&assessment.port_id)?
                    .is_some_and(|intent| {
                        intent.mode == PortIntentMode::SetUpWhenReady
                            && intent.explicitly_uninstalled_at.is_none()
                    });
            if !still_wanted {
                continue;
            }
            let batch = self.start_install_batch(
                &[InstallBatchRequestItem {
                    port_id: assessment.port_id.clone(),
                    expected_plan_sha256: plan_sha256.clone(),
                }],
                LibraryMembershipOrigin::Manual,
            )?;
            let record = self.run_install_batch(&batch.id, &mut emit).await?;
            self.remember_standing_outcome(&record)?;
            batches.push(record);
        }
        Ok(StandingSetupResult {
            assessments: assessed.assessments,
            not_assessed: assessed.not_assessed,
            batches,
        })
    }

    fn remember_standing_outcome(&self, record: &InstallBatchRecord) -> Result<()> {
        for item in &record.items {
            self.library
                .update_port_intent(&item.port_id, |intent, _| {
                    let Some(intent) = intent else { return };
                    match item.state {
                        InstallBatchItemState::Ready => {
                            intent.failed_plan_sha256 = None;
                            intent.failure = None;
                        }
                        // A failed or interrupted attempt is not repeated with the
                        // same plan; a changed plan (new files, catalog or tools)
                        // makes it eligible again.
                        InstallBatchItemState::Failed | InstallBatchItemState::Interrupted => {
                            intent.failed_plan_sha256 = Some(item.expected_plan_sha256.clone());
                            intent.failure = item.detail.clone();
                        }
                        _ => {}
                    }
                })?;
        }
        Ok(())
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
