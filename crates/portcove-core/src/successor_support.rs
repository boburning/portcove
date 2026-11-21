//! Draft qualification evidence for offline successor review.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{
    CatalogAdmissionMode, CatalogEvidenceRole, PortSourceRole, PortcoveError, ReleaseChannel,
    Result, SourceCatalog, SourceEvidence, SourceEvidenceKind, SourceEvidenceOutcome,
    SourceEvidenceScope, SourceReleasePolicy,
};

#[cfg(test)]
use crate::{Platform, PortDefinition, SourceVariantScope};

const RULE_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SupportCoordinates {
    pub setup: String,
    pub launch: String,
    pub data: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SuccessorSupportReview {
    pub rule_version: u32,
    pub anchor: SourceEvidenceScope,
    pub anchor_coordinates: SupportCoordinates,
    pub successor_coordinates: SupportCoordinates,
    /// Identity returned by the ordinary selector under the reviewed definition.
    pub channel: ReleaseChannel,
    pub release_id: u64,
    pub asset_id: u64,
    /// Reviewed content identity evidence referenced by the successor's structural check.
    pub integrity_evidence_id: String,
    /// The exact operational definition used for the selector and coordinate review.
    pub definition_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[cfg(test)]
pub struct InheritedSupport {
    pub inherited_from: String,
    pub successor_version: String,
    pub platform: Platform,
}

fn digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub(crate) fn validate_review(
    sources: &SourceCatalog,
    successor: &SourceEvidence,
    review: &SuccessorSupportReview,
) -> Result<()> {
    let anchor = &review.anchor;
    let mut comparable = successor.scope.clone();
    comparable.upstream_ref.clone_from(&anchor.upstream_ref);
    comparable
        .artifact_sha256
        .clone_from(&anchor.artifact_sha256);
    let anchor_digest = anchor.artifact_sha256.as_deref().is_some_and(digest);
    let anchor_ref = anchor
        .upstream_ref
        .as_ref()
        .is_some_and(|name| !name.is_empty() && name.len() <= 255);
    if review.rule_version != RULE_VERSION
        || successor.kind != SourceEvidenceKind::AutomatedLifecycle
        || successor.outcome != SourceEvidenceOutcome::Passed
        || review.release_id == 0
        || review.asset_id == 0
        || !sources.evidence.iter().any(|record| {
            record.id == review.integrity_evidence_id
                && record.role == CatalogEvidenceRole::ByteIdentity
        })
        || !digest(&review.definition_sha256)
        || !anchor_digest
        || !anchor_ref
        || *anchor != comparable
        || anchor.upstream_ref == successor.scope.upstream_ref
        || anchor.artifact_sha256 == successor.scope.artifact_sha256
        || [&review.anchor_coordinates, &review.successor_coordinates]
            .into_iter()
            .any(|coordinates| {
                [&coordinates.setup, &coordinates.launch, &coordinates.data]
                    .into_iter()
                    .any(|value| !digest(value))
            })
        || !sources.contracts.iter().any(|contract| {
            anchor.contract_id.as_deref() == Some(contract.id.as_str())
                && contract.port_id == anchor.port_id
                && contract.role == PortSourceRole::Game
                && contract.admission_mode == CatalogAdmissionMode::Enforced
                && contract.release_policy == Some(SourceReleasePolicy::IntegrationContractV1)
        })
    {
        return Err(PortcoveError::verification(
            "invalid exact successor support review",
        ));
    }
    Ok(())
}

#[cfg(test)]
fn passed_before(
    sources: &SourceCatalog,
    scope: &SourceEvidenceScope,
    kind: SourceEvidenceKind,
    successor_observed_at: i64,
) -> bool {
    sources.qualification.iter().any(|record| {
        record.kind == kind
            && record.outcome == SourceEvidenceOutcome::Passed
            && record.applies_to(scope)
            && record.observed_at < successor_observed_at
    })
}

#[cfg(test)]
fn failed(
    sources: &SourceCatalog,
    scope: &SourceEvidenceScope,
    required: &[SourceEvidenceKind],
) -> bool {
    sources.qualification.iter().any(|record| {
        record.outcome == SourceEvidenceOutcome::Failed
            && record.applies_to(scope)
            && (record.kind == SourceEvidenceKind::KnownFailure || required.contains(&record.kind))
    })
}

#[derive(Clone, Copy)]
#[cfg(test)]
pub(super) struct SelectedSuccessor<'a> {
    pub platform: Platform,
    pub channel: ReleaseChannel,
    pub version: &'a str,
    pub sha256: &'a str,
    pub release_id: u64,
    pub asset_id: u64,
    pub definition_sha256: &'a str,
}

#[cfg(test)]
pub(super) fn derive(
    sources: &SourceCatalog,
    port: &PortDefinition,
    selection: &SelectedSuccessor<'_>,
) -> Option<InheritedSupport> {
    let SelectedSuccessor {
        platform,
        channel,
        version,
        sha256,
        release_id,
        asset_id,
        definition_sha256,
    } = *selection;
    let contract = sources
        .contracts
        .iter()
        .find(|contract| contract.port_id == port.id && contract.role == PortSourceRole::Game)?;
    let mut anchor_ref = None;
    for identity in sources.current_source_identities(contract).ok()? {
        let mut candidates = sources.qualification.iter().filter(|record| {
            record.scope.port_id == port.id
                && record.scope.platform == platform
                && record.scope.contract_id.as_deref() == Some(contract.id.as_str())
                && record.scope.upstream_ref.as_deref() == Some(version)
                && record.scope.artifact_sha256.as_deref() == Some(sha256)
                && record.scope.variant
                    == (SourceVariantScope::Exact {
                        identity: identity.clone(),
                    })
                && record.successor_support.is_some()
        });
        let record = candidates.next()?;
        if candidates.next().is_some() {
            return None;
        }
        let review = record.successor_support.as_ref()?;
        validate_review(sources, record, review).ok()?;
        if review.channel != channel
            || review.release_id != release_id
            || review.asset_id != asset_id
            || review.definition_sha256 != definition_sha256
            || review.anchor_coordinates != review.successor_coordinates
            || !passed_before(
                sources,
                &review.anchor,
                SourceEvidenceKind::HandsOn,
                record.observed_at,
            )
            || !passed_before(
                sources,
                &review.anchor,
                SourceEvidenceKind::AutomatedLifecycle,
                record.observed_at,
            )
            || !sources.qualification.iter().any(|integrity| {
                integrity.kind == SourceEvidenceKind::StructuralCheck
                    && integrity.outcome == SourceEvidenceOutcome::Passed
                    && integrity.applies_to(&record.scope)
                    && integrity.observed_at <= record.observed_at
                    && integrity
                        .evidence_ids
                        .contains(&review.integrity_evidence_id)
            })
            || failed(
                sources,
                &review.anchor,
                &[
                    SourceEvidenceKind::HandsOn,
                    SourceEvidenceKind::AutomatedLifecycle,
                ],
            )
            || failed(
                sources,
                &record.scope,
                &[
                    SourceEvidenceKind::StructuralCheck,
                    SourceEvidenceKind::AutomatedLifecycle,
                ],
            )
        {
            return None;
        }
        let inherited_from = review.anchor.upstream_ref.as_deref()?;
        if anchor_ref.is_some_and(|previous| previous != inherited_from) {
            return None;
        }
        anchor_ref = Some(inherited_from);
    }
    Some(InheritedSupport {
        inherited_from: anchor_ref?.into(),
        successor_version: version.into(),
        platform,
    })
}
