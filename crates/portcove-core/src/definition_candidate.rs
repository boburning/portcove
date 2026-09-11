//! Composed availability assessment for authenticated successor definitions.

use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use crate::{
    AuthenticatedDefinitionCandidate, AuthenticatedDefinitionProvenance,
    DefinitionCatalogProjection, DefinitionEligibility, DefinitionEligibilityFacts,
    DefinitionEligibilityOutcome, DefinitionOperation, DefinitionReplayDisposition,
    DefinitionReplayFloor, ErrorCode, Result, evaluate_definition_eligibility,
};

/// Installed publisher-policy observation for one exact definition namespace and identity.
///
/// Candidate bytes cannot create or change this observation. A later durable selector must
/// obtain it from core-owned policy bound to the same candidate identity.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DefinitionPublisherStatus {
    Scoped,
    Unscoped,
    Revoked,
}

/// Publisher-policy result bound to the exact repository root and definition identity.
///
/// Production construction currently exposes only the safe unscoped state. A later protected
/// policy implementation will construct scoped and revoked observations from installed grants.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DefinitionPublisherObservation {
    root_sha256: String,
    namespace: String,
    stable_id: String,
    policy_revision: u64,
    grant_id: Option<String>,
    status: DefinitionPublisherStatus,
}

impl DefinitionPublisherObservation {
    pub fn unscoped(
        candidate: &AuthenticatedDefinitionCandidate,
        namespace: &str,
        stable_id: &str,
    ) -> Result<Self> {
        Self::new(
            candidate,
            namespace,
            stable_id,
            0,
            None,
            DefinitionPublisherStatus::Unscoped,
        )
    }

    fn new(
        candidate: &AuthenticatedDefinitionCandidate,
        namespace: &str,
        stable_id: &str,
        policy_revision: u64,
        grant_id: Option<&str>,
        status: DefinitionPublisherStatus,
    ) -> Result<Self> {
        if !candidate
            .index()
            .definitions()
            .iter()
            .any(|entry| entry.namespace() == namespace && entry.stable_id() == stable_id)
        {
            return Err(crate::PortcoveError::not_found(
                "publisher policy identity is outside the candidate",
            ));
        }
        let scoped_record = policy_revision > 0
            && grant_id.is_some_and(|value| {
                !value.is_empty()
                    && value.len() <= 255
                    && value.bytes().all(|byte| {
                        byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-'
                    })
            });
        if (status == DefinitionPublisherStatus::Unscoped
            && (policy_revision != 0 || grant_id.is_some()))
            || (status != DefinitionPublisherStatus::Unscoped && !scoped_record)
        {
            return Err(crate::PortcoveError::state(
                "publisher policy observation has an invalid grant identity",
            ));
        }
        Ok(Self {
            root_sha256: candidate.provenance().root_sha256.clone(),
            namespace: namespace.to_owned(),
            stable_id: stable_id.to_owned(),
            policy_revision,
            grant_id: grant_id.map(str::to_owned),
            status,
        })
    }

    pub fn namespace(&self) -> &str {
        &self.namespace
    }

    pub fn root_sha256(&self) -> &str {
        &self.root_sha256
    }

    pub fn stable_id(&self) -> &str {
        &self.stable_id
    }

    pub fn policy_revision(&self) -> u64 {
        self.policy_revision
    }

    pub fn grant_id(&self) -> Option<&str> {
        self.grant_id.as_deref()
    }

    pub fn status(&self) -> DefinitionPublisherStatus {
        self.status
    }

    #[cfg(test)]
    pub(crate) fn for_test(
        candidate: &AuthenticatedDefinitionCandidate,
        namespace: &str,
        stable_id: &str,
        status: DefinitionPublisherStatus,
    ) -> Result<Self> {
        let (policy_revision, grant_id) = match status {
            DefinitionPublisherStatus::Unscoped => (0, None),
            DefinitionPublisherStatus::Scoped | DefinitionPublisherStatus::Revoked => {
                (1, Some("test-official-grant"))
            }
        };
        Self::new(
            candidate,
            namespace,
            stable_id,
            policy_revision,
            grant_id,
            status,
        )
    }
}

/// Availability result for one authenticated definition identity.
#[derive(Debug)]
pub enum DefinitionCandidateAvailability {
    Eligible(Box<EligibleDefinitionCandidate>),
    Ineligible(DefinitionEligibility),
}

impl DefinitionCandidateAvailability {
    pub fn eligibility(&self) -> DefinitionEligibility {
        match self {
            Self::Eligible(candidate) => candidate.eligibility,
            Self::Ineligible(eligibility) => *eligibility,
        }
    }

    pub fn into_eligible(self) -> Option<EligibleDefinitionCandidate> {
        match self {
            Self::Eligible(candidate) => Some(*candidate),
            Self::Ineligible(_) => None,
        }
    }
}

/// Non-serializable proof that one exact candidate passed the complete availability boundary.
///
/// Only core constructs this type. It is inert until the later catalog-selection transaction
/// consumes its projection and proposed replay floor together.
#[derive(Debug)]
pub struct EligibleDefinitionCandidate {
    eligibility: DefinitionEligibility,
    replay_disposition: DefinitionReplayDisposition,
    replay_floor: DefinitionReplayFloor,
    publisher: DefinitionPublisherObservation,
    provenance: AuthenticatedDefinitionProvenance,
    projection: DefinitionCatalogProjection,
}

impl EligibleDefinitionCandidate {
    pub fn eligibility(&self) -> DefinitionEligibility {
        self.eligibility
    }

    pub fn replay_disposition(&self) -> DefinitionReplayDisposition {
        self.replay_disposition
    }

    pub fn replay_floor(&self) -> &DefinitionReplayFloor {
        &self.replay_floor
    }

    pub fn publisher(&self) -> &DefinitionPublisherObservation {
        &self.publisher
    }

    pub fn provenance(&self) -> &AuthenticatedDefinitionProvenance {
        &self.provenance
    }

    pub fn projection(&self) -> &DefinitionCatalogProjection {
        &self.projection
    }
}

impl AuthenticatedDefinitionCandidate {
    /// Assess whether one authenticated definition may become discoverable now.
    ///
    /// This composes existing pure boundaries and never selects a catalog or persists a floor.
    pub fn evaluate_availability(
        &self,
        namespace: &str,
        stable_id: &str,
        accepted_floor: Option<&DefinitionReplayFloor>,
        publisher: &DefinitionPublisherObservation,
    ) -> Result<DefinitionCandidateAvailability> {
        let now_unix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| crate::PortcoveError::state("system clock is before the Unix epoch"))?
            .as_secs()
            .try_into()
            .map_err(|_| crate::PortcoveError::state("system clock exceeds the supported range"))?;
        self.evaluate_availability_at_inner(
            namespace,
            stable_id,
            accepted_floor,
            publisher,
            now_unix,
        )
    }

    #[cfg(test)]
    pub(crate) fn evaluate_availability_at(
        &self,
        namespace: &str,
        stable_id: &str,
        accepted_floor: Option<&DefinitionReplayFloor>,
        publisher: &DefinitionPublisherObservation,
        now_unix: i64,
    ) -> Result<DefinitionCandidateAvailability> {
        self.evaluate_availability_at_inner(
            namespace,
            stable_id,
            accepted_floor,
            publisher,
            now_unix,
        )
    }

    fn evaluate_availability_at_inner(
        &self,
        namespace: &str,
        stable_id: &str,
        accepted_floor: Option<&DefinitionReplayFloor>,
        publisher: &DefinitionPublisherObservation,
        now_unix: i64,
    ) -> Result<DefinitionCandidateAvailability> {
        if publisher.root_sha256 != self.provenance().root_sha256
            || publisher.namespace != namespace
            || publisher.stable_id != stable_id
        {
            return Err(crate::PortcoveError::conflict(
                "publisher policy observation belongs to a different repository or definition identity",
            ));
        }
        let publisher_eligibility = availability_eligibility(publisher.status, true, true, false);
        if publisher_eligibility.outcome != DefinitionEligibilityOutcome::Eligible {
            return Ok(DefinitionCandidateAvailability::Ineligible(
                publisher_eligibility,
            ));
        }

        let indexed = self
            .index()
            .definitions()
            .iter()
            .find(|entry| entry.namespace() == namespace && entry.stable_id() == stable_id)
            .ok_or_else(|| {
                crate::PortcoveError::not_found("definition identity is outside the candidate")
            })?;
        let entry = self.index().inspect_entry(
            namespace,
            stable_id,
            self.content_bytes(indexed.target())?,
        )?;
        let capability_eligibility = availability_eligibility(
            publisher.status,
            entry.capabilities().compatible,
            true,
            false,
        );
        if capability_eligibility.outcome != DefinitionEligibilityOutcome::Eligible {
            return Ok(DefinitionCandidateAvailability::Ineligible(
                capability_eligibility,
            ));
        }

        let projection = self.inspect_catalog_projection(namespace, stable_id)?;
        let expires_at = OffsetDateTime::parse(&self.provenance().earliest_expiration, &Rfc3339)
            .map_err(|_| {
                crate::PortcoveError::state(
                    "authenticated definition expiration could not be interpreted",
                )
            })?
            .unix_timestamp();
        let fresh = now_unix < expires_at;
        let replay_disposition = match self.evaluate_replay(accepted_floor) {
            Ok(disposition) => disposition,
            Err(error) if error.code == ErrorCode::Verification => {
                return Ok(DefinitionCandidateAvailability::Ineligible(
                    availability_eligibility(publisher.status, true, fresh, true),
                ));
            }
            Err(error) => return Err(error),
        };
        let eligibility = availability_eligibility(publisher.status, true, fresh, false);
        if eligibility.outcome != DefinitionEligibilityOutcome::Eligible {
            return Ok(DefinitionCandidateAvailability::Ineligible(eligibility));
        }
        Ok(DefinitionCandidateAvailability::Eligible(Box::new(
            EligibleDefinitionCandidate {
                eligibility,
                replay_disposition,
                replay_floor: self.replay_floor(),
                publisher: publisher.clone(),
                provenance: self.provenance().clone(),
                projection,
            },
        )))
    }
}

fn availability_eligibility(
    publisher_status: DefinitionPublisherStatus,
    capability_supported: bool,
    fresh_metadata: bool,
    replayed_metadata: bool,
) -> DefinitionEligibility {
    evaluate_definition_eligibility(&DefinitionEligibilityFacts {
        operation: DefinitionOperation::Availability,
        publisher_scoped: publisher_status == DefinitionPublisherStatus::Scoped,
        publisher_revoked: publisher_status == DefinitionPublisherStatus::Revoked,
        capability_supported,
        unknown_safety_field: false,
        ownership_preserved: true,
        same_identity_changed: false,
        expected_integrity: true,
        local_integrity_valid: true,
        required_source_missing: false,
        source_mismatch: false,
        mandatory_checks_passed: true,
        fresh_metadata,
        replayed_metadata,
        refresh_interrupted: false,
        retained_contract: false,
        retained_local_authorization: false,
    })
}
