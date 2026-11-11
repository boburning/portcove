//! One confirmed, recoverable first-install batch over the ordinary setup services.
//!
//! A batch is only an association between reviewed plans and their outcomes. It
//! stores no authorization: every item re-plans and obtains its own
//! operation-specific authorization immediately before the existing installer
//! runs, so a changed plan holds that item for renewed review while unrelated
//! items continue. Items run one at a time, claimed atomically in the library
//! database, and nothing is retried automatically.

use rusqlite::{OptionalExtension, TransactionBehavior, params};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{
    ErrorCode, GameInstallPlan, Library, OperationEvent, PortcoveError, PortcoveService, Result,
};

pub const INSTALL_BATCH_FORMAT_VERSION: u8 = 1;
/// Largest reviewed selection one batch may carry; larger selections are split
/// into several batches rather than truncated.
pub const MAX_INSTALL_BATCH_ITEMS: usize = 512;
const MAX_RECORD_BYTES: usize = 512 * 1024;
const MAX_RECENT_BATCHES: i64 = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum InstallBatchItemState {
    Queued,
    Running,
    /// The ordinary installer reached its supported prepared state. Never launched.
    Ready,
    /// Needs renewed review or input before it can run; nothing was changed.
    Held,
    Failed,
    Cancelled,
    /// A restart found the item mid-run with no live owner and no committed
    /// install. Review again before another mutation.
    Interrupted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct InstallBatchRequestItem {
    pub port_id: String,
    /// Digest of the plan the player reviewed for this game.
    pub expected_plan_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct InstallBatchItem {
    pub port_id: String,
    pub expected_plan_sha256: String,
    pub state: InstallBatchItemState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub install_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct InstallBatchRecord {
    pub format_version: u8,
    pub id: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub cancel_requested: bool,
    pub items: Vec<InstallBatchItem>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct InstallBatchSummary {
    pub queued: u32,
    pub running: u32,
    pub ready: u32,
    pub held: u32,
    pub failed: u32,
    pub cancelled: u32,
    pub interrupted: u32,
}

impl InstallBatchRecord {
    pub fn summary(&self) -> InstallBatchSummary {
        let mut summary = InstallBatchSummary::default();
        for item in &self.items {
            let counter = match item.state {
                InstallBatchItemState::Queued => &mut summary.queued,
                InstallBatchItemState::Running => &mut summary.running,
                InstallBatchItemState::Ready => &mut summary.ready,
                InstallBatchItemState::Held => &mut summary.held,
                InstallBatchItemState::Failed => &mut summary.failed,
                InstallBatchItemState::Cancelled => &mut summary.cancelled,
                InstallBatchItemState::Interrupted => &mut summary.interrupted,
            };
            *counter += 1;
        }
        summary
    }
}

/// One game in a batch review: its exact plan, or why it cannot run yet.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct InstallBatchReviewItem {
    pub port_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<GameInstallPlan>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hold: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct InstallBatchReview {
    pub items: Vec<InstallBatchReviewItem>,
}

fn validate_selection(port_ids: impl Iterator<Item = String>) -> Result<()> {
    let mut seen = std::collections::BTreeSet::new();
    let mut count = 0usize;
    for port_id in port_ids {
        count += 1;
        if !seen.insert(port_id) {
            return Err(PortcoveError::usage(
                "a batch lists each game once; remove the repeated game",
            ));
        }
    }
    if count == 0 || count > MAX_INSTALL_BATCH_ITEMS {
        return Err(PortcoveError::usage(
            "a batch needs between 1 and 512 reviewed games; split a larger selection",
        )
        .detail("requested", count.to_string()));
    }
    Ok(())
}

enum ItemOutcome {
    Ready(String),
    Held(String),
    Failed(String),
    Cancelled,
}

fn validate_request(items: &[InstallBatchRequestItem]) -> Result<()> {
    validate_selection(items.iter().map(|item| item.port_id.clone()))?;
    let digest = |value: &str| {
        value.len() == 64
            && value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    };
    if items.iter().any(|item| !digest(&item.expected_plan_sha256)) {
        return Err(PortcoveError::usage(
            "each reviewed game needs its lowercase SHA-256 plan digest",
        ));
    }
    Ok(())
}

impl Library {
    pub fn create_install_batch(
        &self,
        items: &[InstallBatchRequestItem],
    ) -> Result<InstallBatchRecord> {
        validate_request(items)?;
        let now = Self::now();
        let record = InstallBatchRecord {
            format_version: INSTALL_BATCH_FORMAT_VERSION,
            id: uuid::Uuid::new_v4().to_string(),
            created_at: now,
            updated_at: now,
            cancel_requested: false,
            items: items
                .iter()
                .map(|item| InstallBatchItem {
                    port_id: item.port_id.clone(),
                    expected_plan_sha256: item.expected_plan_sha256.clone(),
                    state: InstallBatchItemState::Queued,
                    detail: None,
                    install_id: None,
                })
                .collect(),
        };
        let json = serde_json::to_string(&record)?;
        if json.len() > MAX_RECORD_BYTES {
            return Err(PortcoveError::usage("batch is too large to save"));
        }
        self.connection()?.execute(
            "INSERT INTO install_batches(id,created_at,updated_at,record_json) VALUES (?1,?2,?2,?3)",
            params![record.id, now, json],
        )?;
        Ok(record)
    }

    pub fn install_batch(&self, id: &str) -> Result<Option<InstallBatchRecord>> {
        let json: Option<String> = self
            .connection()?
            .query_row(
                "SELECT record_json FROM install_batches WHERE id=?1",
                [id],
                |row| row.get(0),
            )
            .optional()?;
        json.map(|json| decode_batch(id, &json)).transpose()
    }

    /// Batches that still have unstarted or running games, newest first. Only
    /// the most recent batches are considered; older finished ones stay readable
    /// by id.
    pub fn unfinished_install_batches(&self) -> Result<Vec<InstallBatchRecord>> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, record_json FROM install_batches ORDER BY updated_at DESC, id LIMIT ?1",
        )?;
        let rows = statement
            .query_map([MAX_RECENT_BATCHES], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut unfinished = Vec::new();
        for (id, json) in rows {
            // One unreadable batch must not hide the others; it stays readable
            // (and reports its error) by id.
            let record = match decode_batch(&id, &json) {
                Ok(record) => record,
                Err(error) => {
                    tracing::warn!(batch_id = %id, error = %error.message, "skipping unreadable install batch");
                    continue;
                }
            };
            if record.items.iter().any(|item| {
                matches!(
                    item.state,
                    InstallBatchItemState::Queued | InstallBatchItemState::Running
                )
            }) {
                unfinished.push(record);
            }
        }
        Ok(unfinished)
    }

    /// Read-modify-write under one immediate transaction, so concurrent
    /// processes cannot both claim the same item or lose each other's outcome.
    pub(crate) fn update_install_batch<R>(
        &self,
        id: &str,
        change: impl FnOnce(&mut InstallBatchRecord) -> R,
    ) -> Result<R> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let json: Option<String> = transaction
            .query_row(
                "SELECT record_json FROM install_batches WHERE id=?1",
                [id],
                |row| row.get(0),
            )
            .optional()?;
        let json = json.ok_or_else(|| {
            PortcoveError::state("install batch does not exist").detail("batch_id", id)
        })?;
        let mut record = decode_batch(id, &json)?;
        let result = change(&mut record);
        record.updated_at = Self::now();
        let encoded = serde_json::to_string(&record)?;
        if encoded.len() > MAX_RECORD_BYTES {
            return Err(PortcoveError::state(
                "install batch exceeds its storage limit",
            ));
        }
        transaction.execute(
            "UPDATE install_batches SET updated_at=?2, record_json=?3 WHERE id=?1",
            params![id, record.updated_at, encoded],
        )?;
        transaction.commit()?;
        Ok(result)
    }
}

fn decode_batch(id: &str, json: &str) -> Result<InstallBatchRecord> {
    let record: InstallBatchRecord = serde_json::from_str(json).map_err(|error| {
        PortcoveError::state("stored install batch is invalid")
            .detail("batch_id", id)
            .detail("cause", error.to_string())
    })?;
    if record.format_version != INSTALL_BATCH_FORMAT_VERSION || record.id != id {
        return Err(
            PortcoveError::state("stored install batch has an unsupported contract")
                .detail("batch_id", id),
        );
    }
    Ok(record)
}

impl PortcoveService {
    /// Reviews every selected game with the ordinary first-install planner. A
    /// game that cannot run yet is returned with its reason and keeps its place
    /// in the selection; it never blocks the others.
    pub async fn plan_install_batch(&self, port_ids: &[String]) -> Result<InstallBatchReview> {
        validate_selection(port_ids.iter().cloned())?;
        let mut items = Vec::with_capacity(port_ids.len());
        for port_id in port_ids {
            let item = match self.plan_game_install(port_id).await {
                Ok(plan) => match self.install_plan_hold(&plan) {
                    Some(hold) => InstallBatchReviewItem {
                        port_id: port_id.clone(),
                        plan: Some(plan),
                        hold: Some(hold),
                    },
                    None => InstallBatchReviewItem {
                        port_id: port_id.clone(),
                        plan: Some(plan),
                        hold: None,
                    },
                },
                Err(error) => InstallBatchReviewItem {
                    port_id: port_id.clone(),
                    plan: None,
                    hold: Some(error.message),
                },
            };
            items.push(item);
        }
        Ok(InstallBatchReview { items })
    }

    /// Persists exactly the reviewed games and their plan digests, and saves
    /// each catalog game to the Library so a held or failed install keeps its
    /// place. No authorization is stored and nothing runs until
    /// `run_install_batch`.
    pub fn start_install_batch(
        &self,
        items: &[InstallBatchRequestItem],
        origin: crate::LibraryMembershipOrigin,
    ) -> Result<InstallBatchRecord> {
        // Validate before writing anything, then save memberships before the
        // batch, so a failed start never leaves a batch that could run later.
        validate_request(items)?;
        // A game no longer in the catalog cannot be saved; its batch item is
        // held with the planner's reason instead.
        let memberships = items
            .iter()
            .filter(|item| self.catalog.listing(&item.port_id).is_ok())
            .map(|item| crate::LibraryMembershipRequest {
                port_id: item.port_id.clone(),
                origin,
                sources: Vec::new(),
            })
            .collect::<Vec<_>>();
        if !memberships.is_empty() {
            self.add_games_to_library(&memberships)?;
        }
        self.library.create_install_batch(items)
    }

    pub fn install_batch(&self, batch_id: &str) -> Result<Option<InstallBatchRecord>> {
        self.library.install_batch(batch_id)
    }

    pub fn unfinished_install_batches(&self) -> Result<Vec<InstallBatchRecord>> {
        self.library.unfinished_install_batches()
    }

    /// Runs every queued item once, in order. Safe to call again after an
    /// interruption: finished items are never repeated and an interrupted item
    /// is reconciled, not blindly retried.
    pub async fn run_install_batch(
        &self,
        batch_id: &str,
        mut emit: impl FnMut(OperationEvent),
    ) -> Result<InstallBatchRecord> {
        // One process owns a batch for its whole run. Another process that is
        // already running it keeps its items; this call only reports them.
        let Some(_owner) = self.try_own_install_batch(batch_id)? else {
            return self.existing_install_batch(batch_id);
        };
        self.reconcile_owned_install_batch(batch_id)?;
        loop {
            let claimed = self.library.update_install_batch(batch_id, |record| {
                if record.cancel_requested {
                    cancel_queued(record);
                    return None;
                }
                let item = record
                    .items
                    .iter_mut()
                    .find(|item| item.state == InstallBatchItemState::Queued)?;
                item.state = InstallBatchItemState::Running;
                Some((item.port_id.clone(), item.expected_plan_sha256.clone()))
            })?;
            let Some((port_id, expected)) = claimed else {
                break;
            };
            let outcome = self
                .run_install_batch_item(&port_id, &expected, &mut emit)
                .await;
            self.library.update_install_batch(batch_id, |record| {
                if let Some(item) = record.items.iter_mut().find(|item| {
                    item.port_id == port_id && item.state == InstallBatchItemState::Running
                }) {
                    match outcome {
                        ItemOutcome::Ready(install_id) => {
                            item.state = InstallBatchItemState::Ready;
                            item.install_id = Some(install_id);
                            item.detail = None;
                        }
                        ItemOutcome::Held(reason) => {
                            item.state = InstallBatchItemState::Held;
                            item.detail = Some(reason);
                        }
                        ItemOutcome::Failed(reason) => {
                            item.state = InstallBatchItemState::Failed;
                            item.detail = Some(reason);
                        }
                        ItemOutcome::Cancelled => {
                            item.state = InstallBatchItemState::Cancelled;
                            item.detail = Some("cancelled while running".to_owned());
                        }
                    }
                }
            })?;
        }
        self.existing_install_batch(batch_id)
    }

    fn existing_install_batch(&self, batch_id: &str) -> Result<InstallBatchRecord> {
        self.library.install_batch(batch_id)?.ok_or_else(|| {
            PortcoveError::state("install batch does not exist").detail("batch_id", batch_id)
        })
    }

    /// Takes the batch's ownership lock, or `None` while another process runs it.
    fn try_own_install_batch(&self, batch_id: &str) -> Result<Option<crate::PortOperationGuard>> {
        self.existing_install_batch(batch_id)?;
        match self
            .library
            .try_lock_activity(&format!("install-batch-{batch_id}"))
        {
            Ok(guard) => Ok(Some(guard)),
            Err(error) if error.code == ErrorCode::Conflict => Ok(None),
            Err(error) => Err(error),
        }
    }

    async fn run_install_batch_item(
        &self,
        port_id: &str,
        expected_plan_sha256: &str,
        emit: &mut impl FnMut(OperationEvent),
    ) -> ItemOutcome {
        let authorization = match self
            .authorize_game_install(port_id, expected_plan_sha256)
            .await
        {
            Ok(authorization) => authorization,
            // A changed plan, unverified copy or unregistered input is not
            // consent: hold for renewed review and leave the game unchanged.
            Err(error) => return ItemOutcome::Held(error.message),
        };
        match self
            .apply_game_install(port_id, &authorization.token, &mut *emit)
            .await
        {
            Ok(install) => ItemOutcome::Ready(install.id),
            Err(error) if error.code == ErrorCode::Cancelled => ItemOutcome::Cancelled,
            Err(error) => ItemOutcome::Failed(error.message),
        }
    }

    /// Stops unstarted work. A running item keeps its existing cancellation and
    /// cleanup boundaries; successful installs stay intact.
    pub fn cancel_install_batch(&self, batch_id: &str) -> Result<InstallBatchRecord> {
        self.library.update_install_batch(batch_id, |record| {
            record.cancel_requested = true;
            cancel_queued(record);
            record.clone()
        })
    }

    /// Resolves items left Running by an interruption against authoritative
    /// state: committed install -> Ready; nothing committed -> Interrupted
    /// (review again). Changes nothing while another process runs the batch,
    /// and leaves an item alone while another operation holds its game. Never
    /// retries.
    pub fn reconcile_install_batch(&self, batch_id: &str) -> Result<InstallBatchRecord> {
        let Some(_owner) = self.try_own_install_batch(batch_id)? else {
            return self.existing_install_batch(batch_id);
        };
        self.reconcile_owned_install_batch(batch_id)
    }

    fn reconcile_owned_install_batch(&self, batch_id: &str) -> Result<InstallBatchRecord> {
        let record = self.existing_install_batch(batch_id)?;
        let mut decisions = Vec::new();
        for item in record
            .items
            .iter()
            .filter(|item| item.state == InstallBatchItemState::Running)
        {
            // Committed state comes from the library itself, so a game that has
            // since left the catalog still reconciles instead of wedging the batch.
            let committed = self
                .library
                .status(&item.port_id, crate::ReleaseChannel::Stable)?
                .active;
            if let Some(active) = committed {
                decisions.push((item.port_id.clone(), Ok(active.id)));
                continue;
            }
            match self
                .library
                .try_lock_port(&item.port_id, "reconcile-install-batch")
            {
                Ok(_) => decisions.push((
                    item.port_id.clone(),
                    Err("interrupted before completion; review installation again".to_owned()),
                )),
                // Another operation is changing this game now; check again later.
                Err(error) if error.code == ErrorCode::Conflict => {}
                Err(error) => decisions.push((
                    item.port_id.clone(),
                    Err(format!(
                        "interrupted before completion; review installation again ({})",
                        error.message
                    )),
                )),
            }
        }
        self.library.update_install_batch(batch_id, |record| {
            for (port_id, install_id) in decisions {
                if let Some(item) = record.items.iter_mut().find(|item| {
                    item.port_id == port_id && item.state == InstallBatchItemState::Running
                }) {
                    match install_id {
                        Ok(id) => {
                            item.state = InstallBatchItemState::Ready;
                            item.install_id = Some(id);
                        }
                        Err(reason) => {
                            item.state = InstallBatchItemState::Interrupted;
                            item.detail = Some(reason);
                        }
                    }
                }
            }
            record.clone()
        })
    }

    pub(crate) fn install_plan_hold(&self, plan: &GameInstallPlan) -> Option<String> {
        if plan.plan.action == crate::InstallPlanAction::BlockedUnverified {
            return Some("verify or repair the retained copy before installation".to_owned());
        }
        // Shared preferences need their own explicit acknowledgment, which a
        // batch never gives on the player's behalf.
        if plan.plan.shared_preferences.is_some() {
            return Some(
                "review this game's shared preferences in its own setup before installing"
                    .to_owned(),
            );
        }
        Self::require_registered_install_inputs(plan)
            .err()
            .map(|error| error.message)
    }
}

fn cancel_queued(record: &mut InstallBatchRecord) {
    for item in &mut record.items {
        if item.state == InstallBatchItemState::Queued {
            item.state = InstallBatchItemState::Cancelled;
            item.detail = Some("cancelled before it started".to_owned());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::service::tests::{register_zelda_install, service_with_release};

    const PORT: &str = "zelda64-recomp";

    fn request(port: &str, digest: &str) -> InstallBatchRequestItem {
        InstallBatchRequestItem {
            port_id: port.into(),
            expected_plan_sha256: digest.into(),
        }
    }

    async fn reviewed_service() -> (tempfile::TempDir, PortcoveService, String) {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        register_zelda_install(&library, "v1", false);
        let service = service_with_release(library, "v1");
        let plan = service.plan_game_install(PORT).await.unwrap();
        (temporary, service, plan.plan_sha256)
    }

    #[tokio::test]
    async fn one_confirmed_batch_installs_the_reviewed_game_and_holds_the_rest_without_repeating() {
        let (_temporary, service, digest) = reviewed_service().await;
        let review = service
            .plan_install_batch(&[PORT.to_owned(), "no-such-port".to_owned()])
            .await
            .unwrap();
        assert!(review.items[0].plan.is_some() && review.items[0].hold.is_none());
        assert!(review.items[1].plan.is_none() && review.items[1].hold.is_some());
        let batch = service
            .start_install_batch(
                &[request(PORT, &digest), request("no-such-port", &digest)],
                crate::LibraryMembershipOrigin::Manual,
            )
            .unwrap();
        let finished = service.run_install_batch(&batch.id, |_| {}).await.unwrap();
        let summary = finished.summary();
        assert_eq!((summary.ready, summary.held, summary.queued), (1, 1, 0));
        let active = service.status(PORT).unwrap().active.unwrap();
        assert_eq!(
            finished.items[0].install_id.as_deref(),
            Some(active.id.as_str())
        );
        assert!(finished.items[1].detail.is_some());
        // Running the same batch again repeats nothing and installs nothing new.
        let again = service.run_install_batch(&batch.id, |_| {}).await.unwrap();
        assert_eq!(again.items, finished.items);
        assert_eq!(service.status(PORT).unwrap().active.unwrap().id, active.id);
    }

    #[tokio::test]
    async fn a_changed_plan_holds_that_game_without_installing_it() {
        let (_temporary, service, _digest) = reviewed_service().await;
        let batch = service
            .start_install_batch(
                &[request(PORT, &"0".repeat(64))],
                crate::LibraryMembershipOrigin::Manual,
            )
            .unwrap();
        let finished = service.run_install_batch(&batch.id, |_| {}).await.unwrap();
        assert_eq!(finished.items[0].state, InstallBatchItemState::Held);
        assert!(service.status(PORT).unwrap().active.is_none());
        // The held game keeps its saved Library entry without being installed.
        let saved = service.library_memberships().unwrap();
        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0].port_id, PORT);
    }

    #[tokio::test]
    async fn cancellation_stops_unstarted_items_and_persists() {
        let (_temporary, service, digest) = reviewed_service().await;
        let batch = service
            .start_install_batch(
                &[request(PORT, &digest), request("other", &digest)],
                crate::LibraryMembershipOrigin::Manual,
            )
            .unwrap();
        let cancelled = service.cancel_install_batch(&batch.id).unwrap();
        assert_eq!(cancelled.summary().cancelled, 2);
        let finished = service.run_install_batch(&batch.id, |_| {}).await.unwrap();
        assert_eq!(finished.summary().cancelled, 2);
        assert!(service.status(PORT).unwrap().active.is_none());
    }

    #[tokio::test]
    async fn restart_reconciles_running_items_against_authoritative_state() {
        let (_temporary, service, digest) = reviewed_service().await;
        let batch = service
            .start_install_batch(
                &[request(PORT, &digest), request("other", &digest)],
                crate::LibraryMembershipOrigin::Manual,
            )
            .unwrap();
        service
            .library
            .update_install_batch(&batch.id, |record| {
                for item in &mut record.items {
                    item.state = InstallBatchItemState::Running;
                }
            })
            .unwrap();
        assert_eq!(
            service.unfinished_install_batches().unwrap()[0].id,
            batch.id,
            "a batch interrupted mid-run is offered for continuation"
        );
        let reconciled = service.reconcile_install_batch(&batch.id).unwrap();
        // Nothing was committed and no operation owns either game: review again.
        assert_eq!(reconciled.summary().interrupted, 2);
        assert!(service.status(PORT).unwrap().active.is_none());
        // An interrupted item is never silently re-run by a later run.
        let finished = service.run_install_batch(&batch.id, |_| {}).await.unwrap();
        assert_eq!(finished.summary().interrupted, 2);
        assert!(service.status(PORT).unwrap().active.is_none());
        assert!(service.unfinished_install_batches().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_batch_owned_by_another_process_is_reported_not_reconciled_or_run() {
        let (_temporary, service, digest) = reviewed_service().await;
        let batch = service
            .start_install_batch(
                &[request(PORT, &digest)],
                crate::LibraryMembershipOrigin::Manual,
            )
            .unwrap();
        service
            .library
            .update_install_batch(&batch.id, |record| {
                record.items[0].state = InstallBatchItemState::Running;
            })
            .unwrap();
        // Simulates a live owner: the same lock a running process holds.
        let owner = service
            .library
            .try_lock_activity(&format!("install-batch-{}", batch.id))
            .unwrap();
        let observed = service.run_install_batch(&batch.id, |_| {}).await.unwrap();
        assert_eq!(observed.items[0].state, InstallBatchItemState::Running);
        let observed = service.reconcile_install_batch(&batch.id).unwrap();
        assert_eq!(observed.items[0].state, InstallBatchItemState::Running);
        drop(owner);
        let reconciled = service.reconcile_install_batch(&batch.id).unwrap();
        assert_eq!(
            reconciled.items[0].state,
            InstallBatchItemState::Interrupted
        );
        assert!(service.status(PORT).unwrap().active.is_none());
    }

    #[test]
    fn a_failed_start_writes_nothing() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let service = crate::service::tests::service_with_release(library, "v1");
        assert!(
            service
                .start_install_batch(
                    &[request(PORT, "not-a-digest")],
                    crate::LibraryMembershipOrigin::Manual,
                )
                .is_err()
        );
        assert!(service.library_memberships().unwrap().is_empty());
        assert!(service.unfinished_install_batches().unwrap().is_empty());
    }

    #[test]
    fn selections_are_bounded_unique_and_non_empty() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path()).unwrap();
        let digest = "a".repeat(64);
        assert!(library.create_install_batch(&[]).is_err());
        assert!(
            library
                .create_install_batch(&[request("a", &digest), request("a", &digest)])
                .is_err()
        );
        assert!(
            library
                .create_install_batch(&[request("a", "not-a-digest")])
                .is_err()
        );
        let too_many = (0..=MAX_INSTALL_BATCH_ITEMS)
            .map(|index| request(&format!("game-{index}"), &digest))
            .collect::<Vec<_>>();
        assert!(library.create_install_batch(&too_many).is_err());
    }
}
