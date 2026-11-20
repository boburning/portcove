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
    AuthenticatedDefinitionProvenance, Catalog, DefinitionEligibility, DefinitionEligibilityFacts,
    DefinitionReplayFloor, Library, PortcoveError, Result,
    definition_eligibility::DefinitionOperationContext, definition_projection::DefinitionSnapshot,
    evaluate_definition_eligibility,
};

const MAX_SELECTION_JSON_BYTES: usize = 16 * 1024 * 1024;
// The stored wrapper adds bounded IDs, fixed digests and an RFC3339 timestamp.
// Reserve space for the complete wrapper before committing publisher bytes.
pub(crate) const MAX_PUBLISHABLE_SNAPSHOT_BYTES: usize = MAX_SELECTION_JSON_BYTES - 4096;

pub(crate) fn publishable_snapshot_size(snapshot: &DefinitionSnapshot) -> Result<usize> {
    let bytes = serde_json::to_vec(snapshot)?.len();
    if bytes > MAX_PUBLISHABLE_SNAPSHOT_BYTES {
        return Err(PortcoveError::verification(
            "escaped definition snapshot exceeds selection storage capacity",
        ));
    }
    Ok(bytes)
}

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
        self.validated_snapshot_projection(snapshot).map(|_| ())
    }

    fn validated_snapshot_projection(
        &self,
        snapshot: &DefinitionSnapshot,
    ) -> Result<crate::DefinitionCatalogProjection> {
        self.validate_snapshot_binding(snapshot)?;
        let projection = snapshot.projection()?;
        self.validate_snapshot_revision(projection.entry().revision())?;
        Ok(projection)
    }

    pub(crate) fn validate_projected_snapshot(
        &self,
        snapshot: &DefinitionSnapshot,
        validated_revision: u64,
    ) -> Result<()> {
        self.validate_snapshot_binding(snapshot)?;
        self.validate_snapshot_revision(validated_revision)
    }

    fn validate_snapshot_binding(&self, snapshot: &DefinitionSnapshot) -> Result<()> {
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
        Ok(())
    }

    fn validate_snapshot_revision(&self, validated_revision: u64) -> Result<()> {
        if self.definition_revision != validated_revision {
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
        // Eligible candidates already own the complete validated projection.
        // Recheck its identity binding without rebuilding those immutable bytes.
        value.identity().validate_projected_snapshot(
            &value.snapshot,
            candidate.projection.entry().revision(),
        )?;
        candidate.projection.catalog().port(&value.stable_id)?;
        Ok(value)
    }

    fn validate(&self) -> Result<crate::DefinitionCatalogProjection> {
        let projection = self
            .identity()
            .validated_snapshot_projection(&self.snapshot)
            .map_err(|error| {
                PortcoveError::state(
                    "stored definition selection has inconsistent identity or policy",
                )
                .detail("cause", error.message)
            })?;
        projection.catalog().port(&self.stable_id)?;
        Ok(projection)
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

struct ValidatedDefinitionSelection {
    stored: StoredDefinitionSelection,
    projection: crate::DefinitionCatalogProjection,
}

impl ValidatedDefinitionSelection {
    fn new(stored: StoredDefinitionSelection) -> Result<Self> {
        let projection = stored.validate()?;
        Ok(Self { stored, projection })
    }
}

struct DefinitionSelectionState {
    revision: u64,
    replay_floor: Option<DefinitionReplayFloor>,
}

struct DefinitionSubjectSelection {
    active: ValidatedDefinitionSelection,
    previous: Option<ValidatedDefinitionSelection>,
    active_json: String,
    historical_only: bool,
}

impl DefinitionSubjectSelection {
    fn read(connection: &Connection, namespace: &str, stable_id: &str) -> Result<Option<Self>> {
        let stored: Option<(String, Option<String>, bool)> = connection
            .query_row(
                "SELECT active_json,previous_json,historical_only FROM definition_subject_selection
                 WHERE namespace=?1 AND stable_id=?2",
                params![namespace, stable_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        stored
            .map(|(active, previous, historical)| {
                Self::decode(namespace, stable_id, active, previous, historical)
            })
            .transpose()
    }

    fn decode(
        namespace: &str,
        stable_id: &str,
        active_json: String,
        previous_json: Option<String>,
        historical_only: bool,
    ) -> Result<Self> {
        let parse = |json: &str, label: &str| -> Result<ValidatedDefinitionSelection> {
            let stored: StoredDefinitionSelection = decode_bounded(Some(json), label)?
                .ok_or_else(|| PortcoveError::state("stored definition selection is missing"))?;
            if stored.namespace != namespace || stored.stable_id != stable_id {
                return Err(PortcoveError::state(
                    "stored definition selection differs from its subject",
                ));
            }
            ValidatedDefinitionSelection::new(stored)
        };
        let active = parse(&active_json, "active selection")?;
        let previous = previous_json
            .as_deref()
            .map(|value| parse(value, "previous selection"))
            .transpose()?;
        Ok(Self {
            active,
            previous,
            active_json,
            historical_only,
        })
    }

    fn require_namespace(connection: &Connection, namespace: &str, stable_id: &str) -> Result<()> {
        let conflict: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM definition_subject_selection
             WHERE stable_id=?1 AND namespace!=?2)",
            params![stable_id, namespace],
            |row| row.get(0),
        )?;
        if conflict {
            return Err(PortcoveError::conflict(
                "definition port is already selected by another namespace",
            ));
        }
        Ok(())
    }

    fn most_recent(connection: &Connection) -> Result<Option<Self>> {
        let subject: Option<(String, String)> = connection
            .query_row(
                "SELECT namespace,stable_id FROM definition_subject_selection
                 WHERE historical_only=0 ORDER BY selected_revision DESC LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        match subject {
            Some((namespace, id)) => Self::read(connection, &namespace, &id),
            None => Ok(None),
        }
    }
}

impl DefinitionSelectionState {
    fn read(connection: &Connection) -> Result<Self> {
        let (revision, replay_floor_json): (i64, Option<String>) = connection.query_row(
            "SELECT revision,replay_floor_json FROM definition_selection_state WHERE singleton=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let revision = u64::try_from(revision)
            .map_err(|_| PortcoveError::state("definition selection revision is invalid"))?;
        let replay_floor: Option<DefinitionReplayFloor> =
            decode_bounded(replay_floor_json.as_deref(), "replay floor")?;
        if let Some(floor) = &replay_floor {
            floor.validate()?;
        }
        if (revision == 0) != replay_floor.is_none() {
            return Err(PortcoveError::state(
                "definition selection revision differs from its replay floor",
            ));
        }
        Ok(Self {
            revision,
            replay_floor,
        })
    }

    fn status(&self, subject: Option<&DefinitionSubjectSelection>) -> DefinitionSelectionStatus {
        let subject = subject.filter(|slot| !slot.historical_only);
        DefinitionSelectionStatus {
            revision: self.revision,
            selected: subject.map(|slot| slot.active.stored.identity()),
            replay_floor: self.replay_floor.clone(),
            can_rollback: subject.is_some_and(|slot| slot.previous.is_some()),
        }
    }

    fn next_revision(&self) -> Result<i64> {
        self.revision
            .checked_add(1)
            .and_then(|revision| i64::try_from(revision).ok())
            .ok_or_else(|| PortcoveError::state("definition selection revision is exhausted"))
    }
}

pub(crate) struct DefinitionOperationAssessment<'a> {
    connection: &'a Connection,
    state: DefinitionSelectionState,
}

impl DefinitionOperationAssessment<'_> {
    pub(crate) fn assess(
        &self,
        identity: &DefinitionSelectionIdentity,
        context: DefinitionOperationContext,
    ) -> Result<DefinitionEligibility> {
        validate_sha256(&identity.repository_root_sha256)?;
        DefinitionReplayFloor::from(&identity.provenance).validate()?;
        if identity.namespace.is_empty()
            || identity.stable_id.is_empty()
            || identity.definition_revision == 0
            || identity.policy_revision == 0
            || !valid_grant_id(&identity.grant_id)
            || identity.repository_root_sha256 != identity.provenance.root_sha256
        {
            return Err(PortcoveError::state(
                "retained definition admission identity is invalid",
            ));
        }

        let transaction = self.connection;
        let state = &self.state;
        let policy =
            PublisherPolicyRecord::read(transaction, &identity.namespace, &identity.stable_id)?;
        let replayed_metadata = if let Some(floor) = &state.replay_floor {
            floor.evaluate(&identity.provenance).is_err()
                && !(floor.covers(&DefinitionReplayFloor::from(&identity.provenance))
                    && DefinitionSubjectSelection::read(
                        transaction,
                        &identity.namespace,
                        &identity.stable_id,
                    )?
                    .is_some_and(|slot| slot.active.stored.identity() == *identity))
        } else {
            false
        };
        let historical_only: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM definition_subject_selection
             WHERE namespace=?1 AND stable_id=?2 AND historical_only=1)",
            params![identity.namespace, identity.stable_id],
            |row| row.get(0),
        )?;
        // A newer global floor blocks incoming replay. It does not invalidate
        // an exact committed subject whose own policy and expiry still apply.
        let publisher_scoped = policy
            .as_ref()
            .is_some_and(|policy| policy.status == DefinitionPublisherStatus::Scoped)
            && crate::definition_repository::publisher_policy::allows_operation(
                transaction,
                identity,
                context,
            )?;
        let publisher_revoked = policy
            .as_ref()
            .is_some_and(|policy| policy.status == DefinitionPublisherStatus::Revoked);
        let retained_launch_continues = context.operation == crate::DefinitionOperation::Launch
            && context.retained_contract
            && publisher_scoped
            && crate::definition_repository::publisher_policy::continues_retained_launch(
                transaction,
                identity,
            )?;
        let same_identity_changed = !retained_launch_continues
            && policy
                .as_ref()
                .is_some_and(|policy| !policy.matches_identity(identity));
        let launch_checks =
            crate::definition_repository::publisher_policy::launch_assessment::checks_passed(
                transaction,
                identity,
                context,
            )?;
        let result = evaluate_definition_eligibility(&DefinitionEligibilityFacts {
            operation: context.operation,
            publisher_scoped,
            publisher_revoked,
            capability_supported: true,
            unknown_safety_field: launch_checks.is_none(),
            ownership_preserved: true,
            same_identity_changed,
            expected_integrity: true,
            local_integrity_valid: context.local_integrity_valid,
            required_source_missing: context.required_source_missing,
            source_mismatch: context.source_mismatch,
            mandatory_checks_passed: launch_checks != Some(false),
            fresh_metadata: !historical_only
                && Library::now() < expiration_unix(&identity.provenance)?
                && crate::definition_repository::publisher_policy::availability_expiration(
                    transaction,
                    &identity.namespace,
                    &identity.stable_id,
                )?
                .is_none_or(|expires| Library::now() < expires),
            replayed_metadata,
            refresh_interrupted: false,
            retained_contract: context.retained_contract,
            retained_local_authorization: context.retained_contract,
        });
        Ok(result)
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
        connection: &Connection,
        candidate: &AuthenticatedDefinitionCandidate,
    ) -> Result<DefinitionPublisherObservation> {
        if self.root_sha256 != candidate.provenance().root_sha256
            || (self.status == DefinitionPublisherStatus::Scoped
                && !crate::definition_repository::publisher_policy::allows_candidate(
                    connection,
                    candidate,
                    &self.namespace,
                    &self.stable_id,
                )?)
        {
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

    fn matches_identity(&self, identity: &DefinitionSelectionIdentity) -> bool {
        self.namespace == identity.namespace
            && self.stable_id == identity.stable_id
            && self.root_sha256 == identity.repository_root_sha256
            && self.policy_revision == identity.policy_revision
            && self.grant_id == identity.grant_id
    }
}

impl Library {
    pub(crate) fn retained_definition_admission_role(
        &self,
        identity: &DefinitionSelectionIdentity,
    ) -> Result<Option<&'static str>> {
        let connection = self.connection()?;
        let subject = DefinitionSubjectSelection::read(
            &connection,
            &identity.namespace,
            &identity.stable_id,
        )?;
        let role = subject.as_ref().and_then(|slot| {
            if slot.active.stored.identity() == *identity {
                Some("active")
            } else {
                slot.previous
                    .as_ref()
                    .filter(|selection| selection.stored.identity() == *identity)
                    .map(|_| "previous")
            }
        });
        Ok(role)
    }

    pub(crate) fn restore_retained_definition_admission(
        &self,
        identity: &DefinitionSelectionIdentity,
        snapshot: &DefinitionSnapshot,
        role: &str,
    ) -> Result<()> {
        identity.validate_snapshot(snapshot)?;
        crate::definition_acquisition::refuse_restricted_portability(&identity.grant_id)?;
        let stored = StoredDefinitionSelection {
            namespace: identity.namespace.clone(),
            stable_id: identity.stable_id.clone(),
            definition_revision: identity.definition_revision,
            repository_root_sha256: identity.repository_root_sha256.clone(),
            grant_id: identity.grant_id.clone(),
            policy_revision: identity.policy_revision,
            provenance: identity.provenance.clone(),
            snapshot: snapshot.clone(),
        };
        let projection = stored.validate()?;
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let state = DefinitionSelectionState::read(&transaction)?;
        let subject = DefinitionSubjectSelection::read(
            &transaction,
            &identity.namespace,
            &identity.stable_id,
        )?;
        let existing = match role {
            "active" => subject.as_ref().map(|slot| &slot.active),
            "previous" => subject.as_ref().and_then(|slot| slot.previous.as_ref()),
            _ => {
                return Err(PortcoveError::verification(
                    "portable definition has an invalid selection role",
                ));
            }
        };
        if existing.is_some_and(|selection| selection.stored.identity() == *identity) {
            return transaction.commit().map_err(Into::into);
        }
        if existing.is_some() || (role == "previous" && subject.is_none()) {
            return Err(PortcoveError::conflict(
                "import destination has a different retained definition authority",
            ));
        }
        let mut historical_only = false;
        if role == "active" {
            historical_only = preflight_portable_selection(&transaction, &projection, Self::now())?;
            if let Some(policy) =
                PublisherPolicyRecord::read(&transaction, &identity.namespace, &identity.stable_id)?
                && (!policy.matches_identity(identity)
                    || policy.status != DefinitionPublisherStatus::Scoped)
            {
                return Err(PortcoveError::conflict(
                    "import destination has a different publisher authority",
                ));
            }
            transaction.execute(
                "INSERT INTO definition_publisher_policy(
                   namespace,stable_id,root_sha256,policy_revision,grant_id,status
                 ) VALUES(?1,?2,?3,?4,?5,'scoped')
                 ON CONFLICT(namespace,stable_id) DO NOTHING",
                params![
                    identity.namespace,
                    identity.stable_id,
                    identity.repository_root_sha256,
                    identity.policy_revision,
                    identity.grant_id,
                ],
            )?;
        }
        let stored_json = encode_bounded(&stored, "portable definition selection")?;
        let next = state.next_revision()?;
        DefinitionSubjectSelection::require_namespace(
            &transaction,
            &identity.namespace,
            &identity.stable_id,
        )?;
        let incoming = DefinitionReplayFloor::from(&identity.provenance);
        let retained_floor = match &state.replay_floor {
            Some(floor) if role == "previous" => floor,
            Some(floor) => floor.newest_compatible(&incoming)?,
            None => &incoming,
        };
        if role == "active" {
            transaction.execute(
                "INSERT INTO definition_subject_selection
                 (namespace,stable_id,selected_revision,active_json,historical_only) VALUES(?1,?2,?3,?4,?5)",
                params![identity.namespace, identity.stable_id, next, stored_json, historical_only],
            )?;
        } else {
            transaction.execute(
                "UPDATE definition_subject_selection SET previous_json=?3
                 WHERE namespace=?1 AND stable_id=?2",
                params![identity.namespace, identity.stable_id, stored_json],
            )?;
        }
        transaction.execute(
            "UPDATE definition_selection_state SET revision=?1,replay_floor_json=?2 WHERE singleton=1",
            params![next, encode_bounded(retained_floor, "portable replay floor")?],
        )?;
        transaction.commit()?;
        Ok(())
    }

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
            Some(policy) => policy.observation(&transaction, candidate)?,
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

    /// Commit an eligible definition only if it can coexist with the current catalog.
    pub fn select_definition_candidate(
        &self,
        candidate: EligibleDefinitionCandidate,
    ) -> Result<DefinitionSelectionStatus> {
        self.commit_definition_candidate(candidate, true)
    }

    pub(crate) fn select_definition_catalog(
        &self,
        candidate: EligibleDefinitionCandidate,
    ) -> Result<DefinitionSelectionStatus> {
        self.select_definition_candidate(candidate)
    }

    #[cfg(test)]
    pub(crate) fn select_definition_candidate_fixture(
        &self,
        candidate: EligibleDefinitionCandidate,
    ) -> Result<DefinitionSelectionStatus> {
        self.commit_definition_candidate(candidate, false)
    }

    fn commit_definition_candidate(
        &self,
        candidate: EligibleDefinitionCandidate,
        validate_transition: bool,
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
            || !crate::definition_repository::publisher_policy::allows_projection(
                &transaction,
                &candidate.projection,
                &candidate.provenance,
            )?
        {
            return Err(PortcoveError::conflict(
                "definition publisher policy changed; assess it again",
            ));
        }
        require_fresh(&candidate.provenance, Self::now())?;
        if let Some(floor) = &state.replay_floor {
            floor.evaluate(&candidate.provenance)?;
        }
        let selected = candidate.publisher.stable_id();
        DefinitionSubjectSelection::require_namespace(&transaction, &stored.namespace, selected)?;
        let has_explicit_scope = candidate
            .projection
            .catalog()
            .port(selected)?
            .mod_provider_bindings
            .is_some();
        let held_legacy_scope: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM definition_provider_scope_floor WHERE port_id=?1)",
            [selected],
            |row| row.get(0),
        )?;
        if held_legacy_scope && !has_explicit_scope {
            return Err(crate::provider_binding::implicit_successor());
        }
        let subject =
            DefinitionSubjectSelection::read(&transaction, &stored.namespace, &stored.stable_id)?;
        let predecessor = subject.as_ref().map(|slot| &slot.active);
        let mut definition_changed = false;
        if let Some(predecessor) = predecessor {
            definition_changed =
                require_definition_revision(&predecessor.projection, &candidate.projection)?;
        }
        if validate_transition {
            require_composable_selection(
                &transaction,
                &candidate.projection,
                predecessor
                    .filter(|_| definition_changed)
                    .map(|slot| &slot.projection),
                Self::now(),
            )?;
        } else if let Some(predecessor) = predecessor.filter(|_| definition_changed) {
            // The lower-level candidate API does not resolve the current baseline.
            // It still cannot replace the exact same-subject safety preimage.
            crate::definition_loader::validate_retained_subject_successor(
                predecessor.projection.catalog(),
                candidate.projection.catalog(),
                selected,
            )?;
        }
        if has_explicit_scope {
            transaction.execute(
                "INSERT INTO definition_provider_scope_floor(port_id) VALUES(?1)
                 ON CONFLICT(port_id) DO NOTHING",
                [selected],
            )?;
        }
        if subject
            .as_ref()
            .is_some_and(|slot| !slot.historical_only && slot.active_json == active_json)
            && state.replay_floor.as_ref() == Some(&proposed_floor)
        {
            transaction.commit()?;
            return Ok(state.status(subject.as_ref()));
        }
        let next = state.next_revision()?;
        transaction.execute(
            "INSERT INTO definition_subject_selection(namespace,stable_id,selected_revision,active_json)
             VALUES(?1,?2,?3,?4)
             ON CONFLICT(namespace,stable_id) DO UPDATE SET
               selected_revision=excluded.selected_revision, previous_json=active_json,
               active_json=excluded.active_json,historical_only=0",
            params![stored.namespace, stored.stable_id, next, active_json],
        )?;
        transaction.execute(
            "UPDATE definition_selection_state SET revision=?1,replay_floor_json=?2 WHERE singleton=1",
            params![next, floor_json],
        )?;
        let result = DefinitionSelectionState::read(&transaction)?.status(
            DefinitionSubjectSelection::read(&transaction, &stored.namespace, &stored.stable_id)?
                .as_ref(),
        );
        transaction.commit()?;
        Ok(result)
    }

    pub fn definition_selection_status(&self) -> Result<DefinitionSelectionStatus> {
        let connection = self.connection()?;
        let transaction = connection.unchecked_transaction()?;
        let result = DefinitionSelectionState::read(&transaction)?
            .status(DefinitionSubjectSelection::most_recent(&transaction)?.as_ref());
        transaction.commit()?;
        Ok(result)
    }

    pub(crate) fn retained_official_definition_subjects(
        &self,
    ) -> Result<std::collections::BTreeSet<String>> {
        let connection = self.connection()?;
        let mut query = connection.prepare(
            "SELECT stable_id FROM definition_subject_selection WHERE namespace='official'",
        )?;
        Ok(query
            .query_map([], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?)
    }

    pub(crate) fn definition_selection_status_for(
        &self,
        namespace: &str,
        stable_id: &str,
    ) -> Result<DefinitionSelectionStatus> {
        let connection = self.connection()?;
        let transaction = connection.unchecked_transaction()?;
        let result = Self::definition_selection_status_from(&transaction, namespace, stable_id)?;
        transaction.commit()?;
        Ok(result)
    }

    pub(crate) fn definition_selection_status_from(
        connection: &Connection,
        namespace: &str,
        stable_id: &str,
    ) -> Result<DefinitionSelectionStatus> {
        let state = DefinitionSelectionState::read(connection)?;
        let subject = DefinitionSubjectSelection::read(connection, namespace, stable_id)?;
        Ok(state.status(subject.as_ref()))
    }

    pub(crate) fn assess_definition_operation(
        &self,
        identity: &DefinitionSelectionIdentity,
        context: DefinitionOperationContext,
    ) -> Result<DefinitionEligibility> {
        self.with_definition_operation_assessment(|assessment| assessment.assess(identity, context))
    }

    /// Reuse immutable selection interpretation only within one fresh SQLite
    /// read transaction. Every operation still evaluates its current policy,
    /// expiry and supplied integrity/source observations.
    pub(crate) fn with_definition_operation_assessment<T>(
        &self,
        action: impl FnOnce(&DefinitionOperationAssessment<'_>) -> Result<T>,
    ) -> Result<T> {
        let connection = self.connection()?;
        let transaction = connection.unchecked_transaction()?;
        let state = DefinitionSelectionState::read(&transaction)?;
        let result = action(&DefinitionOperationAssessment {
            connection: &transaction,
            state,
        })?;
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

#[cfg(test)]
pub(crate) fn trust_catalog_selection_for_test(
    library: &Library,
    catalog: &Catalog,
    port_id: &str,
) {
    let identity = catalog.definition_selection(port_id).unwrap().clone();
    let snapshot = catalog.definition_snapshot(port_id).unwrap().clone();
    let stored = StoredDefinitionSelection {
        namespace: identity.namespace.clone(),
        stable_id: identity.stable_id.clone(),
        definition_revision: identity.definition_revision,
        repository_root_sha256: identity.repository_root_sha256.clone(),
        grant_id: identity.grant_id.clone(),
        policy_revision: identity.policy_revision,
        provenance: identity.provenance.clone(),
        snapshot,
    };
    stored.validate().unwrap();
    let connection = library.connection().unwrap();
    connection
        .execute(
            "INSERT INTO definition_publisher_policy(
               namespace,stable_id,root_sha256,policy_revision,grant_id,status
             ) VALUES(?1,?2,?3,?4,?5,'scoped')
             ON CONFLICT(namespace,stable_id) DO UPDATE SET
               root_sha256=excluded.root_sha256,policy_revision=excluded.policy_revision,
               grant_id=excluded.grant_id,status='scoped'",
            params![
                identity.namespace,
                identity.stable_id,
                identity.repository_root_sha256,
                identity.policy_revision,
                identity.grant_id,
            ],
        )
        .unwrap();
    let revision = DefinitionSelectionState::read(&connection)
        .unwrap()
        .next_revision()
        .unwrap();
    connection
        .execute(
            "INSERT INTO definition_subject_selection(namespace,stable_id,selected_revision,active_json)
             VALUES(?1,?2,?3,?4) ON CONFLICT(namespace,stable_id) DO UPDATE SET
               selected_revision=excluded.selected_revision,active_json=excluded.active_json,previous_json=NULL",
            params![identity.namespace, identity.stable_id, revision, serde_json::to_string(&stored).unwrap()],
        )
        .unwrap();
    connection
        .execute(
            "UPDATE definition_selection_state SET revision=?1,replay_floor_json=?2 WHERE singleton=1",
            params![revision, serde_json::to_string(&DefinitionReplayFloor::from(&identity.provenance)).unwrap()],
        )
        .unwrap();
}

#[cfg(test)]
#[test]
fn portable_restore_keeps_an_older_selection_for_the_same_publisher() {
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();
    let (post_client, port_id) = crate::test_fixture::post_client_catalog();
    let catalog = crate::test_fixture::admitted_indexed_catalog(&post_client, &port_id);
    let active = catalog.definition_selection(&port_id).unwrap().clone();
    let snapshot = catalog.definition_snapshot(&port_id).unwrap().clone();
    let mut previous = active.clone();
    previous.repository_root_sha256 = "f".repeat(64);
    previous.provenance.root_sha256 = previous.repository_root_sha256.clone();
    previous.grant_id = "previous-portability-grant".into();
    previous.policy_revision -= 1;

    library
        .restore_retained_definition_admission(&active, &snapshot, "active")
        .unwrap();
    library
        .restore_retained_definition_admission(&previous, &snapshot, "previous")
        .unwrap();

    assert_eq!(
        library.retained_definition_admission_role(&active).unwrap(),
        Some("active")
    );
    assert_eq!(
        library
            .retained_definition_admission_role(&previous)
            .unwrap(),
        Some("previous")
    );
}

fn require_definition_revision(
    predecessor: &crate::DefinitionCatalogProjection,
    candidate: &crate::DefinitionCatalogProjection,
) -> Result<bool> {
    use std::cmp::Ordering;
    match candidate
        .entry()
        .revision()
        .cmp(&predecessor.entry().revision())
    {
        Ordering::Less => Err(PortcoveError::verification(
            "selected definition revision cannot go backwards",
        )),
        Ordering::Equal
            if candidate.entry().bytes() != predecessor.entry().bytes()
                || candidate.contract_bytes() != predecessor.contract_bytes() =>
        {
            Err(PortcoveError::verification(
                "selected definition changed without a definition revision advance",
            ))
        }
        Ordering::Equal => Ok(false),
        Ordering::Greater => Ok(true),
    }
}

fn require_composable_selection(
    connection: &Connection,
    projection: &crate::DefinitionCatalogProjection,
    predecessor: Option<&crate::DefinitionCatalogProjection>,
    now: i64,
) -> Result<()> {
    let selected = &projection.entry().port().id;
    let (baseline, _) = crate::catalog_store::CatalogState::read(connection)?.resolve(now)?;
    let proposed = projection.catalog_for_selection(&baseline)?;
    if let Some(predecessor) = predecessor {
        // The exact previously committed snapshot remains the safety preimage.
        // Its present publisher policy, trust freshness and load status can
        // have changed during this refresh.
        crate::definition_loader::validate_retained_subject_successor(
            predecessor.catalog(),
            &proposed,
            selected,
        )?;
    }
    let unaffected = load_definition_selections_except(connection, &baseline, now, Some(selected))?;
    if let Some((effective, _)) = unaffected.catalog {
        crate::definition_loader::compose_verified_definition(&effective, &proposed, selected)?;
    }
    Ok(())
}

// A legacy full snapshot can outlive the unrelated baseline it was
// accepted against. Preserve an imported retained execution receipt, but keep
// it out of catalog selection until a compatible successor is admitted.
fn preflight_portable_selection(
    connection: &Connection,
    projection: &crate::DefinitionCatalogProjection,
    now: i64,
) -> Result<bool> {
    let selected = &projection.entry().port().id;
    let (baseline, _) = crate::catalog_store::CatalogState::read(connection)?.resolve(now)?;
    let unaffected = load_definition_selections_except(connection, &baseline, now, Some(selected))?;
    match projection.catalog_for_selection(&baseline) {
        Ok(proposed) => {
            if let Some((effective, _)) = unaffected.catalog {
                crate::definition_loader::compose_verified_definition(
                    &effective, &proposed, selected,
                )?;
            }
            Ok(false)
        }
        Err(error)
            if error.details.contains_key("definition_baseline_drift")
                && (projection.catalog().ports().len() > 1
                    || projection.catalog().document().schema_version
                        < baseline.document().schema_version) =>
        {
            let effective = unaffected
                .catalog
                .as_ref()
                .map_or(&baseline, |(catalog, _)| catalog);
            crate::definition_loader::validate_historical_source_overlap(
                projection.catalog(),
                effective,
                selected,
            )?;
            Ok(true)
        }
        Err(error) => Err(error),
    }
}

pub(crate) struct DefinitionSelectionLoad {
    pub catalog: Option<(Catalog, i64)>,
    pub failures: Vec<(Option<String>, PortcoveError)>,
}

pub(crate) fn load_definition_selections(
    connection: &Connection,
    baseline: &Catalog,
    now_unix: i64,
) -> Result<DefinitionSelectionLoad> {
    load_definition_selections_except(connection, baseline, now_unix, None)
}

fn load_definition_selections_except(
    connection: &Connection,
    baseline: &Catalog,
    now_unix: i64,
    excluded_subject: Option<&str>,
) -> Result<DefinitionSelectionLoad> {
    let state = DefinitionSelectionState::read(connection)?;
    let mut loaded: Option<(Catalog, i64)> = None;
    let mut failures = Vec::new();
    let undecodable_migration: bool = connection.query_row(
        "SELECT active_json IS NOT NULL OR previous_json IS NOT NULL
         FROM definition_selection_state WHERE singleton=1",
        [],
        |row| row.get(0),
    )?;
    if undecodable_migration {
        failures.push((
            None,
            PortcoveError::state("legacy selection could not be decoded during migration"),
        ));
    }
    let mut statement = connection.prepare(
        "SELECT namespace,stable_id FROM definition_subject_selection WHERE historical_only=0 ORDER BY namespace,stable_id",
    )?;
    let subjects = statement.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    for subject in subjects {
        let (namespace, stable_id) = subject?;
        if excluded_subject == Some(stable_id.as_str()) {
            continue;
        }
        let project = || -> Result<(Catalog, i64)> {
            let slot = DefinitionSubjectSelection::read(connection, &namespace, &stable_id)?
                .ok_or_else(|| PortcoveError::state("definition subject selection disappeared"))?;
            let (selected, expiration) =
                project_active_definition(connection, baseline, now_unix, &state, &slot.active)?;
            match &loaded {
                Some((effective, earliest)) => Ok((
                    crate::definition_loader::compose_verified_definition(
                        effective, &selected, &stable_id,
                    )?,
                    expiration.min(*earliest),
                )),
                None => Ok((selected, expiration)),
            }
        };
        match project() {
            Ok(selection) => loaded = Some(selection),
            Err(error) => failures.push((Some(stable_id), error)),
        }
    }
    Ok(DefinitionSelectionLoad {
        catalog: loaded,
        failures,
    })
}

#[cfg(test)]
pub(crate) fn load_selected_definition_catalog(
    connection: &Connection,
    baseline: &Catalog,
    now_unix: i64,
) -> Result<Option<(Catalog, i64)>> {
    let loaded = load_definition_selections(connection, baseline, now_unix)?;
    match (loaded.catalog, loaded.failures.into_iter().next()) {
        (None, Some((_, error))) => Err(error),
        (catalog, _) => Ok(catalog),
    }
}

fn project_active_definition(
    connection: &Connection,
    baseline: &Catalog,
    now_unix: i64,
    state: &DefinitionSelectionState,
    validated: &ValidatedDefinitionSelection,
) -> Result<(Catalog, i64)> {
    let selection = &validated.stored;
    let incoming = DefinitionReplayFloor::from(&selection.provenance);
    if !state
        .replay_floor
        .as_ref()
        .is_some_and(|floor| floor.covers(&incoming))
    {
        return Err(PortcoveError::state(
            "active definition selection exceeds its replay floor",
        ));
    }
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
    let projection = &validated.projection;
    if !crate::definition_repository::publisher_policy::allows_projection(
        connection,
        projection,
        &selection.provenance,
    )? {
        return Err(PortcoveError::conflict(
            "selected definition differs from its protected publisher scope",
        ));
    }
    let mut expiration = expiration_unix(&selection.provenance)?;
    if let Some(policy_expiration) =
        crate::definition_repository::publisher_policy::availability_expiration(
            connection,
            &selection.namespace,
            &selection.stable_id,
        )?
    {
        if policy_expiration <= now_unix {
            return Err(PortcoveError::verification(
                "selected publisher policy metadata is expired",
            ));
        }
        expiration = expiration.min(policy_expiration);
    }
    let mut catalog = projection.catalog_for_selection(baseline)?;
    catalog.retain_definition_selection(std::sync::Arc::new(selection.identity()))?;
    Ok((catalog, expiration))
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

pub(crate) fn migrate_subject_selection(transaction: &rusqlite::Transaction<'_>) -> Result<()> {
    let (revision, floor, active, previous): (i64, Option<String>, Option<String>, Option<String>) =
        transaction.query_row(
            "SELECT revision,replay_floor_json,active_json,previous_json
             FROM definition_selection_state WHERE singleton=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;
    transaction.execute_batch(&format!(
        "ALTER TABLE definition_selection_state RENAME TO definition_selection_legacy;
         CREATE TABLE definition_selection_state(
           singleton INTEGER PRIMARY KEY CHECK(singleton=1),
           revision INTEGER NOT NULL CHECK(revision>=0),
           replay_floor_json TEXT CHECK(length(replay_floor_json)<={MAX_SELECTION_JSON_BYTES}),
           active_json TEXT CHECK(length(active_json)<={MAX_SELECTION_JSON_BYTES}),
           previous_json TEXT CHECK(length(previous_json)<={MAX_SELECTION_JSON_BYTES})
         );
         CREATE TABLE definition_subject_selection(
           namespace TEXT NOT NULL,
           stable_id TEXT NOT NULL UNIQUE,
           selected_revision INTEGER NOT NULL UNIQUE CHECK(selected_revision>=0),
           active_json TEXT NOT NULL CHECK(length(active_json)<={MAX_SELECTION_JSON_BYTES}),
           previous_json TEXT CHECK(length(previous_json)<={MAX_SELECTION_JSON_BYTES}),
           historical_only INTEGER NOT NULL DEFAULT 0 CHECK(historical_only IN (0,1)),
           PRIMARY KEY(namespace,stable_id)
         );"
    ))?;
    // Valid structured bytes retain exact per-subject provenance. A malformed
    // legacy value stays visible for fallback and later diagnosis without
    // preventing the embedded catalog or unrelated new subjects from loading.
    let read_legacy = |json: &str| -> Option<StoredDefinitionSelection> {
        decode_bounded(Some(json), "legacy selection")
            .ok()
            .flatten()
    };
    let active_selection = active.as_deref().and_then(read_legacy);
    let previous_selection = previous.as_deref().and_then(read_legacy);
    let mut previous_migrated = false;
    if let (Some(selected), Some(bytes)) = (&active_selection, &active) {
        let same_subject = previous_selection.as_ref().is_some_and(|prior| {
            prior.namespace == selected.namespace && prior.stable_id == selected.stable_id
        });
        transaction.execute(
            "INSERT INTO definition_subject_selection(namespace,stable_id,selected_revision,active_json,previous_json) VALUES(?1,?2,?3,?4,?5)",
            params![
                selected.namespace,
                selected.stable_id,
                revision,
                bytes,
                previous.as_deref().filter(|_| same_subject)
            ],
        )?;
        previous_migrated = same_subject;
        // Only an independently identified different predecessor lost its
        // active role through the old singleton. Do not infer that distinction
        // from an unverified or inconsistent active selection.
        if !same_subject
            && let (Some(prior), Some(bytes)) = (&previous_selection, &previous)
            && selected.stable_id != prior.stable_id
            && let Ok(Some(floor)) =
                decode_bounded::<DefinitionReplayFloor>(floor.as_deref(), "legacy replay floor")
            && floor == DefinitionReplayFloor::from(&selected.provenance)
            && selected.validate().is_ok()
        {
            transaction.execute(
                "INSERT INTO definition_subject_selection(namespace,stable_id,selected_revision,active_json) VALUES(?1,?2,?3,?4)",
                params![
                    prior.namespace,
                    prior.stable_id,
                    revision.saturating_sub(1),
                    bytes
                ],
            )?;
            previous_migrated = true;
        }
    }
    transaction.execute(
        "INSERT INTO definition_selection_state VALUES(1,?1,?2,?3,?4)",
        params![
            revision,
            floor,
            active.filter(|_| active_selection.is_none()),
            previous.filter(|_| !previous_migrated)
        ],
    )?;
    transaction.execute("DROP TABLE definition_selection_legacy", [])?;
    Ok(())
}

pub(crate) fn require_fresh(
    provenance: &AuthenticatedDefinitionProvenance,
    now_unix: i64,
) -> Result<()> {
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
