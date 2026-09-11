//! Stable operation eligibility from independently established definition facts.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DefinitionOperation {
    Availability,
    Install,
    Prepare,
    Launch,
}

/// Facts supplied by core-owned trust, capability, integrity and lifecycle authorities.
/// Candidate definition bytes cannot establish these booleans themselves.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DefinitionEligibilityFacts {
    pub operation: DefinitionOperation,
    pub publisher_scoped: bool,
    pub publisher_revoked: bool,
    pub capability_supported: bool,
    pub unknown_safety_field: bool,
    pub ownership_preserved: bool,
    pub same_identity_changed: bool,
    pub expected_integrity: bool,
    pub local_integrity_valid: bool,
    pub required_source_missing: bool,
    pub source_mismatch: bool,
    pub mandatory_checks_passed: bool,
    pub fresh_metadata: bool,
    pub replayed_metadata: bool,
    pub refresh_interrupted: bool,
    pub retained_contract: bool,
    pub retained_local_authorization: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DefinitionEligibilityOutcome {
    Eligible,
    Hold,
    Escalate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DefinitionEligibilityReason {
    MandatoryChecksPassed,
    PublisherRevoked,
    UnknownSafetySemantics,
    PublisherScopeRequired,
    EngineCapabilityRequired,
    OwnershipMigrationRequired,
    MetadataReplay,
    RefreshIncomplete,
    MetadataStale,
    RecordedIdentityChanged,
    AuthenticatedIntegrityRequired,
    LocalIntegrityFailed,
    MandatoryCheckFailed,
    SourceIdentityMismatch,
    RequiredSourceMissing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct DefinitionEligibility {
    pub outcome: DefinitionEligibilityOutcome,
    pub reason: DefinitionEligibilityReason,
}

impl DefinitionEligibility {
    const fn eligible() -> Self {
        Self {
            outcome: DefinitionEligibilityOutcome::Eligible,
            reason: DefinitionEligibilityReason::MandatoryChecksPassed,
        }
    }

    const fn hold(reason: DefinitionEligibilityReason) -> Self {
        Self {
            outcome: DefinitionEligibilityOutcome::Hold,
            reason,
        }
    }

    const fn escalate(reason: DefinitionEligibilityReason) -> Self {
        Self {
            outcome: DefinitionEligibilityOutcome::Escalate,
            reason,
        }
    }
}

/// Evaluate one operation without mutating trust, catalog, library or lifecycle state.
pub fn evaluate_definition_eligibility(
    facts: &DefinitionEligibilityFacts,
) -> DefinitionEligibility {
    use DefinitionEligibilityReason as Reason;

    if facts.publisher_revoked {
        return DefinitionEligibility::hold(Reason::PublisherRevoked);
    }
    if facts.unknown_safety_field {
        return DefinitionEligibility::hold(Reason::UnknownSafetySemantics);
    }
    if !facts.publisher_scoped {
        return DefinitionEligibility::escalate(Reason::PublisherScopeRequired);
    }
    if !facts.capability_supported {
        return DefinitionEligibility::escalate(Reason::EngineCapabilityRequired);
    }
    if !facts.ownership_preserved {
        return DefinitionEligibility::escalate(Reason::OwnershipMigrationRequired);
    }

    let retained_launch = facts.operation == DefinitionOperation::Launch && facts.retained_contract;
    if !retained_launch {
        if facts.replayed_metadata {
            return DefinitionEligibility::hold(Reason::MetadataReplay);
        }
        if facts.refresh_interrupted {
            return DefinitionEligibility::hold(Reason::RefreshIncomplete);
        }
        if !facts.fresh_metadata {
            return DefinitionEligibility::hold(Reason::MetadataStale);
        }
    }

    if facts.same_identity_changed {
        return DefinitionEligibility::hold(Reason::RecordedIdentityChanged);
    }
    let retained_local_launch = retained_launch && facts.retained_local_authorization;
    if !facts.expected_integrity && !retained_local_launch {
        return DefinitionEligibility::hold(Reason::AuthenticatedIntegrityRequired);
    }
    if !facts.local_integrity_valid {
        return DefinitionEligibility::hold(Reason::LocalIntegrityFailed);
    }
    if !facts.mandatory_checks_passed {
        return DefinitionEligibility::hold(Reason::MandatoryCheckFailed);
    }
    if facts.operation != DefinitionOperation::Availability {
        if facts.source_mismatch {
            return DefinitionEligibility::hold(Reason::SourceIdentityMismatch);
        }
        if facts.required_source_missing {
            return DefinitionEligibility::hold(Reason::RequiredSourceMissing);
        }
    }
    DefinitionEligibility::eligible()
}
