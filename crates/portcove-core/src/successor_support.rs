//! Read-only qualification claims for an exact, independently admitted successor.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{
    Catalog, CatalogAdmissionMode, CatalogEvidenceRole, DefinitionAcquisitionScope, Library,
    Platform, PortDefinition, PortSourceRole, PortStatus, PortcoveError, ReleaseChannel,
    ReleaseSource, Result, SourceCatalog, SourceEvidence, SourceEvidenceKind,
    SourceEvidenceOutcome, SourceEvidenceScope, SourceReleasePolicy, SourceVariantScope,
};

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

fn passed(sources: &SourceCatalog, scope: &SourceEvidenceScope, kind: SourceEvidenceKind) -> bool {
    sources.qualification.iter().any(|record| {
        record.kind == kind
            && record.outcome == SourceEvidenceOutcome::Passed
            && record.applies_to(scope)
    })
}

fn failed(sources: &SourceCatalog, scope: &SourceEvidenceScope) -> bool {
    sources.qualification.iter().any(|record| {
        record.outcome == SourceEvidenceOutcome::Failed
            && record.scope.port_id == scope.port_id
            && record.scope.platform == scope.platform
            && record.scope.contract_id == scope.contract_id
            && record.scope.artifact_sha256 == scope.artifact_sha256
            && record.scope.upstream_ref == scope.upstream_ref
    })
}

#[derive(Clone, Copy)]
pub(super) struct SelectedSuccessor<'a> {
    pub platform: Platform,
    pub channel: ReleaseChannel,
    pub version: &'a str,
    pub sha256: &'a str,
    pub release_id: u64,
    pub asset_id: u64,
    pub definition_sha256: &'a str,
}

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
            || !passed(sources, &review.anchor, SourceEvidenceKind::HandsOn)
            || !passed(
                sources,
                &review.anchor,
                SourceEvidenceKind::AutomatedLifecycle,
            )
            || !sources.qualification.iter().any(|integrity| {
                integrity.kind == SourceEvidenceKind::StructuralCheck
                    && integrity.outcome == SourceEvidenceOutcome::Passed
                    && integrity.applies_to(&record.scope)
                    && integrity
                        .evidence_ids
                        .contains(&review.integrity_evidence_id)
            })
            || failed(sources, &review.anchor)
            || failed(sources, &record.scope)
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

pub(crate) fn inherited_support(
    library: &Library,
    catalog: &Catalog,
    port: &PortDefinition,
    status: &PortStatus,
) -> Option<InheritedSupport> {
    let platform = Platform::current().ok()?;
    let sources = catalog.source_catalog()?;
    let identity = catalog.definition_selection(&port.id)?;
    if identity.namespace != "official"
        || port.release.provider != ReleaseSource::Github
        || port.managed_acquisition_hold.is_some()
        || !port.platforms.contains(&platform)
        || status.external_runtime.is_some()
    {
        return None;
    }
    let check = &status.last_update_check.as_ref()?.check;
    let pin = port.release.curated.get(&platform)?;
    if check.port_id != port.id
        || check.release.channel != status.channel
        || check.channel != status.channel
        || check.release.version != pin.tag
        || check.release.asset.name != pin.filename
        || check.release.asset.size != pin.size
        || !check.release.asset.sha256.eq_ignore_ascii_case(&pin.sha256)
    {
        return None;
    }
    let definition = DefinitionAcquisitionScope::port_digest(port).ok()?;
    let claim = derive(
        sources,
        port,
        &SelectedSuccessor {
            platform,
            channel: status.channel,
            version: &pin.tag,
            sha256: &pin.sha256,
            release_id: pin.release_id,
            asset_id: pin.asset_id,
            definition_sha256: &definition,
        },
    )?;

    use crate::definition_repository::publisher_policy::{
        CuratedArtifactOperation, acquisition_scope, require_curated_artifact_operation,
    };
    let scope = acquisition_scope(library, catalog, &port.id).ok()??;
    scope.require_current().ok()?;
    scope.require_port(port).ok()?;
    require_curated_artifact_operation(
        &library.connection().ok()?,
        scope.repository_id,
        pin,
        CuratedArtifactOperation::Acquisition,
    )
    .ok()?;
    Some(claim)
}
