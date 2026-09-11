//! Durable, atomic selection of an already authenticated and eligible definition.

use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use super::{
    AuthenticatedDefinitionCandidate, DefinitionCandidateAvailability,
    DefinitionPublisherObservation, DefinitionPublisherStatus, EligibleDefinitionCandidate,
};
use crate::{
    AuthenticatedDefinitionProvenance, Catalog, DefinitionReplayFloor, Library, PortcoveError,
    Result, definition_projection::DefinitionSnapshot,
};

const MAX_SELECTION_JSON_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DefinitionSelectionIdentity {
    pub namespace: String,
    pub stable_id: String,
    pub definition_revision: u64,
    pub repository_root_sha256: String,
    pub grant_id: String,
    pub policy_revision: u64,
    pub provenance: AuthenticatedDefinitionProvenance,
}

impl DefinitionSelectionIdentity {
    pub(crate) fn validate_snapshot(&self, snapshot: &DefinitionSnapshot) -> Result<()> {
        if self.namespace != snapshot.namespace()
            || self.stable_id != snapshot.port_id()
            || self.repository_root_sha256 != self.provenance.root_sha256
            || self.provenance.index_sha256 != snapshot.index_sha256()
            || self.definition_revision == 0
            || self.policy_revision == 0
            || !valid_grant_id(&self.grant_id)
        {
            return Err(PortcoveError::verification(
                "definition admission provenance differs from its exact snapshot",
            ));
        }
        validate_sha256(&self.repository_root_sha256)?;
        DefinitionReplayFloor::from(&self.provenance).validate()?;
        expiration_unix(&self.provenance)?;
        if self.definition_revision != snapshot.projection()?.entry().revision() {
            return Err(PortcoveError::verification(
                "definition admission revision differs from its exact entry",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct DefinitionSelectionStatus {
    pub revision: u64,
    pub selected: Option<DefinitionSelectionIdentity>,
    pub replay_floor: Option<DefinitionReplayFloor>,
    pub can_rollback: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredDefinitionSelection {
    namespace: String,
    stable_id: String,
    definition_revision: u64,
    repository_root_sha256: String,
    grant_id: String,
    policy_revision: u64,
    provenance: AuthenticatedDefinitionProvenance,
    snapshot: DefinitionSnapshot,
}

impl StoredDefinitionSelection {
    fn from_eligible(candidate: &EligibleDefinitionCandidate) -> Result<Self> {
        if candidate.publisher.status != DefinitionPublisherStatus::Scoped {
            return Err(PortcoveError::conflict(
                "definition selection requires a currently scoped publisher",
            ));
        }
        let grant_id = candidate.publisher.grant_id.clone().ok_or_else(|| {
            PortcoveError::state("eligible definition is missing its publisher grant identity")
        })?;
        let value = Self {
            namespace: candidate.publisher.namespace.clone(),
            stable_id: candidate.publisher.stable_id.clone(),
            definition_revision: candidate.projection.entry().revision(),
            repository_root_sha256: candidate.publisher.root_sha256.clone(),
            grant_id,
            policy_revision: candidate.publisher.policy_revision,
            provenance: candidate.provenance.clone(),
            snapshot: candidate.projection.snapshot().clone(),
        };
        value.validate()?;
        Ok(value)
    }

    fn validate(&self) -> Result<()> {
        self.identity()
            .validate_snapshot(&self.snapshot)
            .map_err(|error| {
                PortcoveError::state(
                    "stored definition selection has inconsistent identity or policy",
                )
                .detail("cause", error.message)
            })?;
        let projection = self.snapshot.projection()?;
        projection.catalog().port(&self.stable_id)?;
        Ok(())
    }

    fn identity(&self) -> DefinitionSelectionIdentity {
        DefinitionSelectionIdentity {
            namespace: self.namespace.clone(),
            stable_id: self.stable_id.clone(),
            definition_revision: self.definition_revision,
            repository_root_sha256: self.repository_root_sha256.clone(),
            grant_id: self.grant_id.clone(),
            policy_revision: self.policy_revision,
            provenance: self.provenance.clone(),
        }
    }
}

struct DefinitionSelectionState {
    revision: u64,
    replay_floor: Option<DefinitionReplayFloor>,
    active: Option<StoredDefinitionSelection>,
    previous: Option<StoredDefinitionSelection>,
    active_json: Option<String>,
}

impl DefinitionSelectionState {
    fn read(connection: &Connection) -> Result<Self> {
        let (revision, replay_floor_json, active_json, previous_json): (
            i64,
            Option<String>,
            Option<String>,
            Option<String>,
        ) = connection.query_row(
            "SELECT revision,replay_floor_json,active_json,previous_json
             FROM definition_selection_state WHERE singleton=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;
        let revision = u64::try_from(revision)
            .map_err(|_| PortcoveError::state("definition selection revision is invalid"))?;
        let replay_floor: Option<DefinitionReplayFloor> =
            decode_bounded(replay_floor_json.as_deref(), "replay floor")?;
        let active: Option<StoredDefinitionSelection> =
            decode_bounded(active_json.as_deref(), "active selection")?;
        let previous: Option<StoredDefinitionSelection> =
            decode_bounded(previous_json.as_deref(), "previous selection")?;
        if let Some(floor) = &replay_floor {
            floor.validate()?;
        }
        if let Some(selection) = &active {
            selection.validate()?;
        }
        if let Some(selection) = &previous {
            selection.validate()?;
        }
        if active.is_some() != replay_floor.is_some()
            || (revision == 0) != active.is_none()
            || (previous.is_some() && active.is_none())
        {
            return Err(PortcoveError::state(
                "definition selection revision, active value, previous value and replay floor are inconsistent",
            ));
        }
        if let (Some(active), Some(floor)) = (&active, &replay_floor)
            && *floor != DefinitionReplayFloor::from(&active.provenance)
        {
            return Err(PortcoveError::state(
                "active definition selection differs from its replay floor",
            ));
        }
        Ok(Self {
            revision,
            replay_floor,
            active,
            previous,
            active_json,
        })
    }

    fn status(&self) -> DefinitionSelectionStatus {
        DefinitionSelectionStatus {
            revision: self.revision,
            selected: self
                .active
                .as_ref()
                .map(StoredDefinitionSelection::identity),
            replay_floor: self.replay_floor.clone(),
            can_rollback: self.previous.is_some(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PublisherPolicyRecord {
    namespace: String,
    stable_id: String,
    root_sha256: String,
    policy_revision: u64,
    grant_id: String,
    status: DefinitionPublisherStatus,
}

impl PublisherPolicyRecord {
    fn read(connection: &Connection, namespace: &str, stable_id: &str) -> Result<Option<Self>> {
        let row: Option<(String, String, String, i64, String, String)> = connection
            .query_row(
                "SELECT namespace,stable_id,root_sha256,policy_revision,grant_id,status
                 FROM definition_publisher_policy WHERE namespace=?1 AND stable_id=?2",
                params![namespace, stable_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
            .optional()?;
        row.map(
            |(namespace, stable_id, root_sha256, policy_revision, grant_id, status)| {
                let policy_revision = u64::try_from(policy_revision).map_err(|_| {
                    PortcoveError::state("stored definition publisher policy revision is invalid")
                })?;
                let status = match status.as_str() {
                    "scoped" => DefinitionPublisherStatus::Scoped,
                    "revoked" => DefinitionPublisherStatus::Revoked,
                    _ => {
                        return Err(PortcoveError::state(
                            "stored definition publisher policy status is invalid",
                        ));
                    }
                };
                if policy_revision == 0
                    || !valid_grant_id(&grant_id)
                    || validate_sha256(&root_sha256).is_err()
                {
                    return Err(PortcoveError::state(
                        "stored definition publisher policy identity is invalid",
                    ));
                }
                Ok(Self {
                    namespace,
                    stable_id,
                    root_sha256,
                    policy_revision,
                    grant_id,
                    status,
                })
            },
        )
        .transpose()
    }

    fn observation(
        &self,
        candidate: &AuthenticatedDefinitionCandidate,
    ) -> Result<DefinitionPublisherObservation> {
        if self.root_sha256 != candidate.provenance().root_sha256 {
            return DefinitionPublisherObservation::unscoped(
                candidate,
                &self.namespace,
                &self.stable_id,
            );
        }
        DefinitionPublisherObservation::new(
            candidate,
            &self.namespace,
            &self.stable_id,
            self.policy_revision,
            Some(&self.grant_id),
            self.status,
        )
    }

    fn matches(&self, observation: &DefinitionPublisherObservation) -> bool {
        self.namespace == observation.namespace
            && self.stable_id == observation.stable_id
            && self.root_sha256 == observation.root_sha256
            && self.policy_revision == observation.policy_revision
            && Some(self.grant_id.as_str()) == observation.grant_id.as_deref()
            && self.status == observation.status
    }

    fn matches_selection(&self, selection: &StoredDefinitionSelection) -> bool {
        self.namespace == selection.namespace
            && self.stable_id == selection.stable_id
            && self.root_sha256 == selection.repository_root_sha256
            && self.policy_revision == selection.policy_revision
            && self.grant_id == selection.grant_id
            && self.status == DefinitionPublisherStatus::Scoped
    }
}

impl Library {
    pub fn assess_definition_candidate(
        &self,
        candidate: &AuthenticatedDefinitionCandidate,
        namespace: &str,
        stable_id: &str,
    ) -> Result<DefinitionCandidateAvailability> {
        let connection = self.connection()?;
        let transaction = connection.unchecked_transaction()?;
        let state = DefinitionSelectionState::read(&transaction)?;
        let publisher = match PublisherPolicyRecord::read(&transaction, namespace, stable_id)? {
            Some(policy) => policy.observation(candidate)?,
            None => DefinitionPublisherObservation::unscoped(candidate, namespace, stable_id)?,
        };
        let result = candidate.evaluate_availability(
            namespace,
            stable_id,
            state.replay_floor.as_ref(),
            &publisher,
        )?;
        transaction.commit()?;
        Ok(result)
    }

    pub fn select_definition_candidate(
        &self,
        candidate: EligibleDefinitionCandidate,
    ) -> Result<DefinitionSelectionStatus> {
        require_fresh(&candidate.provenance, Self::now())?;
        let proposed_floor = DefinitionReplayFloor::from(&candidate.provenance);
        if candidate.replay_floor != proposed_floor {
            return Err(PortcoveError::state(
                "eligible definition proof differs from its proposed replay floor",
            ));
        }
        let stored = StoredDefinitionSelection::from_eligible(&candidate)?;
        let active_json = encode_bounded(&stored, "active selection")?;
        let floor_json = encode_bounded(&proposed_floor, "replay floor")?;

        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let state = DefinitionSelectionState::read(&transaction)?;
        let policy = PublisherPolicyRecord::read(
            &transaction,
            candidate.publisher.namespace(),
            candidate.publisher.stable_id(),
        )?
        .ok_or_else(|| {
            PortcoveError::conflict("definition publisher policy changed; assess it again")
        })?;
        if !policy.matches(&candidate.publisher)
            || policy.status != DefinitionPublisherStatus::Scoped
        {
            return Err(PortcoveError::conflict(
                "definition publisher policy changed; assess it again",
            ));
        }
        require_fresh(&candidate.provenance, Self::now())?;
        if let Some(floor) = &state.replay_floor {
            floor.evaluate(&candidate.provenance)?;
        }
        if state.active_json.as_deref() == Some(active_json.as_str())
            && state.replay_floor.as_ref() == Some(&proposed_floor)
        {
            transaction.commit()?;
            return Ok(state.status());
        }
        let next_revision = state
            .revision
            .checked_add(1)
            .ok_or_else(|| PortcoveError::state("definition selection revision is exhausted"))?;
        let next_revision = i64::try_from(next_revision)
            .map_err(|_| PortcoveError::state("definition selection revision exceeds SQLite"))?;
        transaction.execute(
            "UPDATE definition_selection_state
             SET revision=?1,replay_floor_json=?2,previous_json=active_json,active_json=?3
             WHERE singleton=1",
            params![next_revision, floor_json, active_json],
        )?;
        let result = DefinitionSelectionState::read(&transaction)?.status();
        transaction.commit()?;
        Ok(result)
    }

    pub fn definition_selection_status(&self) -> Result<DefinitionSelectionStatus> {
        let connection = self.connection()?;
        let transaction = connection.unchecked_transaction()?;
        let result = DefinitionSelectionState::read(&transaction)?.status();
        transaction.commit()?;
        Ok(result)
    }

    #[cfg(test)]
    pub(crate) fn install_definition_policy_for_test(
        &self,
        candidate: &AuthenticatedDefinitionCandidate,
        namespace: &str,
        stable_id: &str,
        policy_revision: u64,
        grant_id: &str,
        status: DefinitionPublisherStatus,
    ) -> Result<()> {
        DefinitionPublisherObservation::new(
            candidate,
            namespace,
            stable_id,
            policy_revision,
            Some(grant_id),
            status,
        )?;
        let policy_revision = i64::try_from(policy_revision)
            .map_err(|_| PortcoveError::state("test publisher policy revision exceeds SQLite"))?;
        let status = match status {
            DefinitionPublisherStatus::Scoped => "scoped",
            DefinitionPublisherStatus::Revoked => "revoked",
            DefinitionPublisherStatus::Unscoped => {
                return Err(PortcoveError::usage(
                    "unscoped test policy is represented by an absent row",
                ));
            }
        };
        self.connection()?.execute(
            "INSERT INTO definition_publisher_policy(
               namespace,stable_id,root_sha256,policy_revision,grant_id,status
             ) VALUES(?1,?2,?3,?4,?5,?6)
             ON CONFLICT(namespace,stable_id) DO UPDATE SET
               root_sha256=excluded.root_sha256,
               policy_revision=excluded.policy_revision,
               grant_id=excluded.grant_id,
               status=excluded.status",
            params![
                namespace,
                stable_id,
                candidate.provenance().root_sha256,
                policy_revision,
                grant_id,
                status
            ],
        )?;
        Ok(())
    }
}

pub(crate) fn load_selected_definition_catalog(
    connection: &Connection,
    baseline: &Catalog,
    now_unix: i64,
) -> Result<Option<(Catalog, i64)>> {
    let state = DefinitionSelectionState::read(connection)?;
    let Some(selection) = state.active.as_ref() else {
        return Ok(None);
    };
    let policy =
        PublisherPolicyRecord::read(connection, &selection.namespace, &selection.stable_id)?
            .ok_or_else(|| {
                PortcoveError::conflict("selected definition publisher is not scoped")
            })?;
    if !policy.matches_selection(selection) {
        return Err(PortcoveError::conflict(
            "selected definition publisher policy changed",
        ));
    }
    require_fresh(&selection.provenance, now_unix)?;
    let mut catalog = selection.snapshot.catalog()?;
    crate::definition_loader::validate_definition_transition(
        baseline,
        &catalog,
        &selection.stable_id,
    )?;
    catalog.retain_definition_selection(std::sync::Arc::new(selection.identity()))?;
    Ok(Some((catalog, expiration_unix(&selection.provenance)?)))
}

pub(crate) fn migrate(transaction: &rusqlite::Transaction<'_>) -> Result<()> {
    transaction.execute_batch(&format!(
        "CREATE TABLE definition_publisher_policy(
           namespace TEXT NOT NULL,
           stable_id TEXT NOT NULL,
           root_sha256 TEXT NOT NULL CHECK(length(root_sha256)=64),
           policy_revision INTEGER NOT NULL CHECK(policy_revision>0),
           grant_id TEXT NOT NULL CHECK(length(grant_id) BETWEEN 1 AND 255),
           status TEXT NOT NULL CHECK(status IN ('scoped','revoked')),
           PRIMARY KEY(namespace,stable_id)
         );
         CREATE TABLE definition_selection_state(
           singleton INTEGER PRIMARY KEY CHECK(singleton=1),
           revision INTEGER NOT NULL CHECK(revision>=0),
           replay_floor_json TEXT CHECK(length(replay_floor_json)<={MAX_SELECTION_JSON_BYTES}),
           active_json TEXT CHECK(length(active_json)<={MAX_SELECTION_JSON_BYTES}),
           previous_json TEXT CHECK(length(previous_json)<={MAX_SELECTION_JSON_BYTES}),
           CHECK((active_json IS NULL)=(replay_floor_json IS NULL))
         );
         INSERT INTO definition_selection_state VALUES(1,0,NULL,NULL,NULL);"
    ))?;
    Ok(())
}

fn require_fresh(provenance: &AuthenticatedDefinitionProvenance, now_unix: i64) -> Result<()> {
    let expires_at = expiration_unix(provenance)?;
    if now_unix >= expires_at {
        return Err(PortcoveError::verification(
            "definition metadata expired before selection committed",
        ));
    }
    Ok(())
}

fn expiration_unix(provenance: &AuthenticatedDefinitionProvenance) -> Result<i64> {
    Ok(
        OffsetDateTime::parse(&provenance.earliest_expiration, &Rfc3339)
            .map_err(|_| PortcoveError::state("selected definition expiration is invalid"))?
            .unix_timestamp(),
    )
}

fn encode_bounded(value: &impl Serialize, label: &str) -> Result<String> {
    let json = serde_json::to_string(value)?;
    if json.len() > MAX_SELECTION_JSON_BYTES {
        return Err(PortcoveError::verification(format!(
            "definition {label} exceeds its storage bound"
        )));
    }
    Ok(json)
}

fn decode_bounded<T: for<'de> Deserialize<'de>>(
    json: Option<&str>,
    label: &str,
) -> Result<Option<T>> {
    json.map(|json| {
        if json.len() > MAX_SELECTION_JSON_BYTES {
            return Err(PortcoveError::state(format!(
                "stored definition {label} exceeds its bound"
            )));
        }
        serde_json::from_str(json).map_err(|error| {
            PortcoveError::state(format!("stored definition {label} is invalid"))
                .detail("cause", error.to_string())
        })
    })
    .transpose()
}

fn valid_grant_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 255
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn validate_sha256(value: &str) -> Result<()> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(PortcoveError::state(
            "stored definition repository root identity is invalid",
        ));
    }
    Ok(())
}
