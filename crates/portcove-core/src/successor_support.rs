//! Exact operands for reviewing support inheritance while activation is disabled.

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::{
    Catalog, CatalogAdmissionMode, CatalogEvidenceRole, DefinitionAcquisitionScope, Library,
    Platform, PortSourceRole, PortcoveError, ReleaseChannel, Result, ScopedResolvedRelease,
    SourceCatalog, SourceEvidence, SourceEvidenceKind, SourceEvidenceOutcome, SourceEvidenceScope,
    SourceReleasePolicy,
    definition_repository::publisher_policy::{
        CuratedArtifactOperation, acquisition_scope, require_curated_artifact_operation,
    },
};

const RULE_VERSION: u32 = 1;

/// Conservative comparisons derived from complete typed operational coordinates.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SupportCoordinates {
    pub setup: String,
    pub launch: String,
    pub data: String,
}

/// Immutable operands for a future exact lifecycle evidence check. Preparation
/// has no publication or support authority.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SuccessorEvidencePreparation {
    pub rule_version: u32,
    pub selected_at: i64,
    pub predecessor: SuccessorEvidenceSubject,
    pub successor: SuccessorEvidenceSubject,
    pub anchor_observations: Vec<SourceEvidence>,
}

/// The custody and operational coordinates of one exact managed package.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SuccessorEvidenceSubject {
    pub definition: crate::DefinitionSelectionIdentity,
    pub definition_sha256: String,
    pub policy_sha256: String,
    pub trust_anchor_sha256: String,
    pub repository_id: u64,
    pub release_id: u64,
    pub asset_id: u64,
    pub tag: String,
    pub artifact_sha256: String,
    pub platform: crate::Platform,
    pub channel: ReleaseChannel,
    pub contract_id: String,
    pub variants: Vec<crate::SourceIdentity>,
    pub coordinates: SupportCoordinates,
}

fn evidence_digest(value: &impl Serialize) -> Result<String> {
    // The Value path sorts object keys independently of source serialization.
    Ok(hex::encode(Sha256::digest(serde_json::to_vec(
        &serde_json::to_value(value)?,
    )?)))
}

pub(super) fn compatibility_coordinates(
    catalog: &Catalog,
    port: &crate::PortDefinition,
    sources: &SourceCatalog,
    contract: &crate::PortSourceContract,
    platform: Platform,
) -> Result<SupportCoordinates> {
    let mut operational = serde_json::to_value(port)?;
    let fields = operational
        .as_object_mut()
        .ok_or_else(|| PortcoveError::state("successor operational definition is not an object"))?;
    // Include all operational fields by default. Exclude only display fields,
    // historic platform labels and separately verified exact artifact grants.
    for name in [
        "name",
        "summary",
        "support_tier",
        "presentation",
        "automated_tested_platforms",
        "manually_validated_platforms",
    ] {
        fields.remove(name);
    }
    fields
        .get_mut("release")
        .and_then(serde_json::Value::as_object_mut)
        .ok_or_else(|| PortcoveError::state("successor release definition is not an object"))?
        .remove("curated");

    // Keep exact definition comparisons conservative. BIOS-conditioned,
    // recognition-only and artifact-bound source semantics need their own
    // normalization rules before their coordinates can be compared.
    if port.bios_source_profile.is_some()
        || contract.variant_list_recognition_only
        || !contract.n64_recomp_inputs_v1.is_empty()
        || sources
            .contracts
            .iter()
            .any(|other| other.port_id == port.id && other.id != contract.id)
    {
        return Err(PortcoveError::unsupported(
            "successor comparison requires a single invariant game source contract",
        ));
    }
    let mut normalized_contract = contract.clone();
    normalized_contract.applicability.clear();
    let profile = sources
        .identities
        .iter()
        .find(|item| item.id == contract.profile_id)
        .ok_or_else(|| PortcoveError::state("successor source profile is absent"))?;
    let validator = contract
        .validator_contract_id
        .as_ref()
        .map(|id| {
            sources
                .validators
                .iter()
                .find(|item| &item.id == id)
                .ok_or_else(|| PortcoveError::state("successor source validator is absent"))
        })
        .transpose()?;
    let original = port
        .source_profile
        .as_deref()
        .map(|id| catalog.source_profile(id))
        .transpose()?;
    let common = evidence_digest(&(
        RULE_VERSION,
        platform,
        operational,
        normalized_contract,
        profile,
        validator,
        original,
    ))?;
    Ok(SupportCoordinates {
        setup: evidence_digest(&("setup", &common))?,
        launch: evidence_digest(&("launch", &common))?,
        data: evidence_digest(&("data", &common))?,
    })
}

pub(super) fn exact_source_contract<'a>(
    sources: &'a SourceCatalog,
    port_id: &str,
    tag: &str,
    sha256: &str,
) -> Result<&'a crate::PortSourceContract> {
    sources
        .contracts
        .iter()
        .find(|contract| {
            contract.port_id == port_id
                && contract.role == PortSourceRole::Game
                && contract.admission_mode == CatalogAdmissionMode::Enforced
                && contract.release_policy == Some(SourceReleasePolicy::IntegrationContractV1)
                && contract.applicability.iter().any(|binding| {
                    binding.upstream_ref == tag
                        && binding
                            .artifact_sha256
                            .as_deref()
                            .is_some_and(|digest| digest.eq_ignore_ascii_case(sha256))
                })
        })
        .ok_or_else(|| {
            PortcoveError::unsupported("successor subject lacks exact source applicability")
        })
}

pub(super) fn authenticated_subject(
    library: &Library,
    catalog: &Catalog,
    port_id: &str,
    platform: Platform,
    channel: ReleaseChannel,
    operation: CuratedArtifactOperation,
) -> Result<(
    SuccessorEvidenceSubject,
    DefinitionAcquisitionScope,
    Catalog,
)> {
    let port = catalog.port(port_id)?;
    let pin = port
        .release
        .curated
        .get(&platform)
        .filter(|pin| pin.platform == platform)
        .ok_or_else(|| {
            PortcoveError::unsupported("successor subject lacks an exact platform pin")
        })?;
    let scope = acquisition_scope(library, catalog, port_id)?.ok_or_else(|| {
        PortcoveError::unsupported("successor subject lacks authenticated admission")
    })?;
    scope.require_current()?;
    let identity = scope
        .identity
        .as_ref()
        .filter(|value| value.namespace == "official")
        .ok_or_else(|| {
            PortcoveError::unsupported("successor subject lacks an official definition")
        })?;
    crate::curated_acquisition::require_runtime_scope(port, Some(&scope))?;
    require_curated_artifact_operation(
        &library.connection()?,
        scope.repository_id,
        pin,
        operation,
    )?;
    // Read qualification from the admitted projection rather than from the
    // surrounding merged catalog or a submitted evidence document.
    let admitted = catalog
        .definition_snapshot(port_id)
        .ok_or_else(|| PortcoveError::state("successor subject lacks its admitted snapshot"))?
        .catalog()?;
    let signed_port = admitted.port(port_id)?;
    if DefinitionAcquisitionScope::port_digest(signed_port)? != scope.port_sha256 {
        return Err(PortcoveError::verification(
            "successor projection differs from the current operational definition",
        ));
    }
    let sources = admitted.source_catalog().ok_or_else(|| {
        PortcoveError::unsupported("successor subject lacks a signed source catalog")
    })?;
    let contract = exact_source_contract(sources, port_id, &pin.tag, &pin.sha256)?;
    let variants = sources.current_source_identities(contract)?;
    if variants.is_empty()
        || !port.channels.contains(&channel)
        || port.managed_acquisition_hold.is_some()
    {
        return Err(PortcoveError::unsupported(
            "successor subject has no current supported source scope",
        ));
    }
    Ok((
        SuccessorEvidenceSubject {
            definition: identity.clone(),
            definition_sha256: scope.port_sha256.clone(),
            policy_sha256: scope.policy_sha256.clone(),
            trust_anchor_sha256: scope.anchor_sha256.clone(),
            repository_id: scope.repository_id,
            release_id: pin.release_id,
            asset_id: pin.asset_id,
            tag: pin.tag.clone(),
            artifact_sha256: pin.sha256.clone(),
            platform,
            channel,
            contract_id: contract.id.clone(),
            variants,
            coordinates: compatibility_coordinates(
                &admitted,
                signed_port,
                sources,
                contract,
                platform,
            )?,
        },
        scope,
        admitted,
    ))
}

pub(crate) fn preflight(
    predecessor: (&Library, &Catalog),
    successor: (&Library, &Catalog),
    port_id: &str,
    platform: Platform,
    channel: ReleaseChannel,
) -> Result<(SuccessorEvidencePreparation, DefinitionAcquisitionScope)> {
    let (previous, _, old) = authenticated_subject(
        predecessor.0,
        predecessor.1,
        port_id,
        platform,
        channel,
        CuratedArtifactOperation::LocalUse,
    )?;
    let (current, scope, new) = authenticated_subject(
        successor.0,
        successor.1,
        port_id,
        platform,
        channel,
        CuratedArtifactOperation::Acquisition,
    )?;
    if previous.trust_anchor_sha256 != current.trust_anchor_sha256
        || previous.definition.definition_revision >= current.definition.definition_revision
        || previous.repository_id != current.repository_id
        || previous.release_id == current.release_id
        || previous.asset_id == current.asset_id
        || previous.tag == current.tag
        || previous
            .artifact_sha256
            .eq_ignore_ascii_case(&current.artifact_sha256)
        || previous.contract_id != current.contract_id
        || previous.variants != current.variants
        || previous.coordinates != current.coordinates
    {
        return Err(PortcoveError::verification(
            "successor provenance or operational coordinates differ",
        ));
    }
    // Apply the latest independently authenticated withdrawal/revocation
    // history to the predecessor as well as to the selected package.
    let old_pin = &predecessor.1.port(port_id)?.release.curated[&platform];
    require_curated_artifact_operation(
        &successor.0.connection()?,
        current.repository_id,
        old_pin,
        CuratedArtifactOperation::LocalUse,
    )?;
    let anchor_observations = reviewed_anchor_observations(&old, &new, &previous, &current)?;
    let preflight_at = Library::now();
    if anchor_observations
        .iter()
        .any(|observation| observation.observed_at >= preflight_at)
    {
        return Err(PortcoveError::verification(
            "predecessor observations must predate successor review",
        ));
    }
    Ok((
        SuccessorEvidencePreparation {
            rule_version: RULE_VERSION,
            selected_at: 0,
            predecessor: previous,
            successor: current,
            anchor_observations,
        },
        scope,
    ))
}

pub(crate) fn bind_live_selection(
    mut preparation: SuccessorEvidencePreparation,
    scope: &DefinitionAcquisitionScope,
    port: &crate::PortDefinition,
    resolved: &ScopedResolvedRelease,
) -> Result<SuccessorEvidencePreparation> {
    let current = &preparation.successor;
    let platform = current.platform;
    let channel = current.channel;
    resolved.require_selection(port, platform, channel)?;
    let selected = resolved.github_identity.as_ref().ok_or_else(|| {
        PortcoveError::verification("successor selector lacks exact GitHub identity")
    })?;
    let pin = &port.release.curated[&platform];
    if !resolved.live_scoped_github_selection
        || !resolved
            .scope
            .as_ref()
            .is_some_and(|observed| observed.same_authorization(scope))
        || resolved.saved_variant.is_some()
        || resolved.fallback_reason.is_some()
        || selected.repository_id != current.repository_id
        || !selected.repository.eq_ignore_ascii_case(&pin.repository)
        || selected.release_id != current.release_id
        || selected.asset_id != current.asset_id
        || selected.tag != current.tag
        || resolved.release.version != current.tag
        || resolved.release.asset.name != pin.filename
        || resolved.release.asset.size != pin.size
        || !resolved
            .release
            .asset
            .sha256
            .eq_ignore_ascii_case(&current.artifact_sha256)
    {
        return Err(PortcoveError::verification(
            "successor selection differs from independently admitted artifact",
        ));
    }
    scope.require_current()?;
    require_curated_artifact_operation(
        &scope.library.connection()?,
        current.repository_id,
        pin,
        CuratedArtifactOperation::Acquisition,
    )?;
    preparation.selected_at = Library::now();
    Ok(preparation)
}

pub(super) fn reviewed_anchor_observations(
    predecessor: &Catalog,
    successor: &Catalog,
    previous: &SuccessorEvidenceSubject,
    current: &SuccessorEvidenceSubject,
) -> Result<Vec<SourceEvidence>> {
    use crate::SourceVariantScope;
    let old = predecessor
        .source_catalog()
        .ok_or_else(|| PortcoveError::state("missing predecessor source catalog"))?;
    let new = successor
        .source_catalog()
        .ok_or_else(|| PortcoveError::state("missing successor source catalog"))?;
    let mut result = Vec::new();
    for variant in &previous.variants {
        let mut prior_scope = SourceEvidenceScope {
            port_id: previous.definition.stable_id.clone(),
            platform: previous.platform,
            artifact_sha256: Some(previous.artifact_sha256.clone()),
            upstream_ref: Some(previous.tag.clone()),
            contract_id: Some(previous.contract_id.clone()),
            variant: SourceVariantScope::Exact {
                identity: variant.clone(),
            },
            check_version: None,
        };
        let same_artifact = |record: &SourceEvidence, scope: &SourceEvidenceScope| {
            let mut comparable = record.scope.clone();
            comparable.check_version.clone_from(&scope.check_version);
            comparable == *scope
        };
        let latest_prior = |kind| {
            let candidates = || {
                old.qualification
                    .iter()
                    .filter(|record| same_artifact(record, &prior_scope) && record.kind == kind)
            };
            candidates()
                .max_by_key(|record| record.observed_at)
                .filter(|latest| {
                    latest.outcome == SourceEvidenceOutcome::Passed
                        && latest
                            .scope
                            .check_version
                            .as_ref()
                            .is_some_and(|version| !version.is_empty())
                        && !candidates()
                            .chain(new.qualification.iter().filter(|record| {
                                same_artifact(record, &prior_scope) && record.kind == kind
                            }))
                            .any(|record| {
                                record.observed_at >= latest.observed_at && record != *latest
                            })
                        && latest.evidence_ids.iter().any(|id| {
                            old.evidence.iter().any(|evidence| {
                                &evidence.id == id
                                    && evidence.role == CatalogEvidenceRole::PortcoveQualification
                                    && old.reviewed_evidence_url(id).is_ok()
                            })
                        })
                })
        };
        let hands_on = latest_prior(SourceEvidenceKind::HandsOn).ok_or_else(|| {
            PortcoveError::verification("predecessor lacks a current exact reviewed hands-on pass")
        })?;
        let lifecycle = latest_prior(SourceEvidenceKind::AutomatedLifecycle)
            .filter(|record| record.scope.check_version == hands_on.scope.check_version)
            .ok_or_else(|| {
                PortcoveError::verification(
                    "predecessor lacks a current exact reviewed lifecycle pass",
                )
            })?;
        prior_scope
            .check_version
            .clone_from(&hands_on.scope.check_version);
        let mut next_scope = prior_scope.clone();
        next_scope.artifact_sha256 = Some(current.artifact_sha256.clone());
        next_scope.upstream_ref = Some(current.tag.clone());
        if old
            .qualification
            .iter()
            .chain(&new.qualification)
            .any(|record| {
                (record.kind == SourceEvidenceKind::KnownFailure
                    && record.outcome == SourceEvidenceOutcome::Failed
                    && (same_artifact(record, &prior_scope) || same_artifact(record, &next_scope)))
                    || (matches!(
                        record.kind,
                        SourceEvidenceKind::StructuralCheck
                            | SourceEvidenceKind::AutomatedLifecycle
                    ) && same_artifact(record, &next_scope)
                        && (record.scope.check_version != next_scope.check_version
                            || record.outcome == SourceEvidenceOutcome::Failed))
            })
        {
            return Err(PortcoveError::verification(
                "exact successor evidence failed or changed check contract",
            ));
        }
        result.extend([hands_on.clone(), lifecycle.clone()]);
    }
    Ok(result)
}
