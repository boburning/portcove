//! Complete read-only source inspection shape shared by CLI and desktop adapters.

use std::collections::HashSet;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{
    Catalog, CatalogAdmissionMode, CatalogEvidence, Platform, PortSourceContract, PortSourceRole,
    PortcoveError, Result, SourceAdmission, SourceAdmissionMode, SourceClassification,
    SourceContractResult, SourceEvidence, SourceHealth, SourceIdentityProfile, SourceInspection,
    SourceRecord, SourceRejectionReason, SourceVariantScope,
};

pub const SOURCE_INSPECTION_REPORT_SCHEMA_VERSION: u32 = 1;

/// A stable, complete explanation of selected source bytes. `state_code` is an
/// open string so clients can preserve an unfamiliar future state instead of
/// failing enum deserialization. Detailed enums remain versioned by the report
/// and outer API schema boundaries.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct SourceInspectionReport {
    pub schema_version: u32,
    pub profile_id: String,
    pub health: SourceHealth,
    pub state_code: String,
    pub summary: String,
    pub next_action: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub registered: Option<SourceRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inspection: Option<SourceInspection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub problem: Option<SourceInspectionProblem>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_identity: Option<SourceIdentityProfile>,
    #[serde(default)]
    pub applications: Vec<SourceApplicationInspection>,
    #[serde(default)]
    pub evidence: Vec<SourceEvidenceLink>,
    pub legacy: SourceLegacyCoverage,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct SourceInspectionProblem {
    /// Open, stable machine code. Unknown future values remain readable.
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct SourceApplicationInspection {
    pub port_id: String,
    pub port_name: String,
    pub role: PortSourceRole,
    pub contract: PortSourceContract,
    pub contract_result: SourceContractResult,
    pub release_applicability: SourceReleaseApplicability,
    pub qualification: SourceQualificationCoverage,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct SourceReleaseApplicability {
    /// Open code: `artifact_bound`, `upstream_release_bound`, or `not_rebound`.
    pub state_code: String,
    #[serde(default)]
    pub reviewed_bindings: Vec<crate::SourceContractApplicability>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
pub struct SourceQualificationCoverage {
    /// Conservative legacy port-wide coverage. It is not exact source qualification.
    #[serde(default)]
    pub legacy_automated_platforms: Vec<Platform>,
    /// Conservative legacy port-wide coverage. It is not exact source qualification.
    #[serde(default)]
    pub legacy_hands_on_platforms: Vec<Platform>,
    #[serde(default)]
    pub exact_records: Vec<SourceEvidence>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct SourceEvidenceLink {
    pub id: String,
    pub role: crate::CatalogEvidenceRole,
    pub authority: String,
    pub authority_ref: String,
    pub reviewed_at: String,
    pub claim: String,
    pub immutable_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub live_url: Option<String>,
}

impl From<&CatalogEvidence> for SourceEvidenceLink {
    fn from(value: &CatalogEvidence) -> Self {
        Self {
            id: value.id.clone(),
            role: value.role,
            authority: value.authority.clone(),
            authority_ref: value.authority_ref.clone(),
            reviewed_at: value.reviewed_at.clone(),
            claim: value.claim.clone(),
            immutable_url: value.immutable_url.clone(),
            live_url: value.live_url.clone(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
pub struct SourceLegacyCoverage {
    /// True for an Alpha 1 or other supported row that predates structured observations.
    pub registration_identity_not_recorded: bool,
    /// Historical evidence without an exact variant remains visible but is never exact coverage.
    #[serde(default)]
    pub variant_unspecified_records: Vec<SourceEvidence>,
}

struct ReportStatus<'a> {
    health: SourceHealth,
    state_code: &'a str,
    summary: &'a str,
    next_action: &'a str,
    problem: Option<SourceInspectionProblem>,
}

pub(crate) fn unavailable_report(
    catalog: &Catalog,
    registered: SourceRecord,
    health: SourceHealth,
    problem: &PortcoveError,
) -> Result<SourceInspectionReport> {
    let (state_code, summary, next_action) = match health {
        SourceHealth::Missing => (
            "source_missing",
            "The registered source could not be found.",
            "Reconnect the original storage or relink this source to the reviewed replacement.",
        ),
        _ => (
            "source_could_not_be_checked",
            "The registered source could not be checked.",
            "Review the reported problem, restore access, and inspect the source again.",
        ),
    };
    assemble_report(
        catalog,
        registered.profile_id.clone(),
        Some(registered),
        None,
        ReportStatus {
            health,
            state_code,
            summary,
            next_action,
            problem: Some(SourceInspectionProblem {
                code: error_code(problem),
                message: problem.message.clone(),
            }),
        },
    )
}

pub(crate) fn available_report(
    catalog: &Catalog,
    registered: Option<SourceRecord>,
    mut inspection: SourceInspection,
) -> Result<SourceInspectionReport> {
    if let (Some(baseline), Some(observed_record)) =
        (registered.as_ref(), inspection.record.as_mut())
    {
        // Inspection is read-only. Reuse the durable registration timestamp so
        // equivalent JSON, JSONL, CLI, and desktop reads are byte-stable.
        observed_record.updated_at = baseline.updated_at;
    }
    let health = match registered.as_ref() {
        Some(record) if observation_matches_record(&inspection, record) => SourceHealth::Current,
        Some(_) => SourceHealth::Changed,
        None => SourceHealth::NotBaselined,
    };
    inspection.assessment.health = health;
    let (state_code, summary, next_action) = report_message(health, &inspection);
    assemble_report(
        catalog,
        inspection.profile_id.clone(),
        registered,
        Some(inspection),
        ReportStatus {
            health,
            state_code,
            summary,
            next_action,
            problem: None,
        },
    )
}

fn assemble_report(
    catalog: &Catalog,
    profile_id: String,
    registered: Option<SourceRecord>,
    inspection: Option<SourceInspection>,
    status: ReportStatus<'_>,
) -> Result<SourceInspectionReport> {
    let source_catalog = catalog.source_catalog();
    let expected_identity = source_catalog.and_then(|source_catalog| {
        source_catalog
            .identities
            .iter()
            .find(|profile| profile.id == profile_id)
            .cloned()
    });
    let mut exact_records = source_catalog.map_or_else(Vec::new, |catalog| {
        catalog
            .qualification
            .iter()
            .filter(|record| {
                matches!(&record.scope.variant, SourceVariantScope::Exact { identity }
                    if identity.game_id == profile_id)
            })
            .cloned()
            .collect()
    });
    if let Some(inspection) = inspection.as_ref() {
        for record in &inspection.assessment.evidence {
            if !exact_records.contains(record) {
                exact_records.push(record.clone());
            }
        }
    }
    let mut applications = Vec::new();
    if let Some(source_catalog) = source_catalog {
        for contract in source_catalog
            .contracts
            .iter()
            .filter(|contract| contract.profile_id == profile_id)
        {
            let port = catalog.port(&contract.port_id)?;
            applications.push(SourceApplicationInspection {
                port_id: port.id.clone(),
                port_name: port.name.clone(),
                role: contract.role,
                contract: contract.clone(),
                contract_result: contract_result(contract, inspection.as_ref()),
                release_applicability: SourceReleaseApplicability {
                    state_code: if contract
                        .applicability
                        .iter()
                        .any(|binding| binding.artifact_sha256.is_some())
                    {
                        "artifact_bound"
                    } else if contract.applicability.is_empty() {
                        "not_rebound"
                    } else {
                        "upstream_release_bound"
                    }
                    .into(),
                    reviewed_bindings: contract.applicability.clone(),
                },
                qualification: SourceQualificationCoverage {
                    legacy_automated_platforms: port.automated_tested_platforms.clone(),
                    legacy_hands_on_platforms: port.manually_validated_platforms.clone(),
                    exact_records: exact_records
                        .iter()
                        .filter(|record| record.scope.port_id == port.id)
                        .cloned()
                        .collect(),
                },
            });
        }
    }
    applications.sort_by(|left, right| {
        left.port_id
            .cmp(&right.port_id)
            .then_with(|| role_order(left.role).cmp(&role_order(right.role)))
    });

    let evidence = referenced_evidence(
        source_catalog,
        expected_identity.as_ref(),
        &applications,
        &exact_records,
    );
    let variant_unspecified_records = exact_records
        .iter()
        .filter(|record| matches!(record.scope.variant, SourceVariantScope::Unspecified))
        .cloned()
        .collect();
    Ok(SourceInspectionReport {
        schema_version: SOURCE_INSPECTION_REPORT_SCHEMA_VERSION,
        profile_id,
        health: status.health,
        state_code: status.state_code.into(),
        summary: status.summary.into(),
        next_action: status.next_action.into(),
        legacy: SourceLegacyCoverage {
            registration_identity_not_recorded: registered
                .as_ref()
                .is_some_and(|record| record.observed_identity.is_none()),
            variant_unspecified_records,
        },
        registered,
        inspection,
        problem: status.problem,
        expected_identity,
        applications,
        evidence,
    })
}

fn contract_result(
    contract: &PortSourceContract,
    inspection: Option<&SourceInspection>,
) -> SourceContractResult {
    if contract.admission_mode == CatalogAdmissionMode::Informational {
        return SourceContractResult::Informational {
            contract_id: contract.id.clone(),
        };
    }
    let Some(inspection) = inspection else {
        return SourceContractResult::NotEvaluated;
    };
    match &inspection.assessment.classification {
        SourceClassification::Recognized { identity }
            if contract
                .supported_variant_ids
                .contains(&identity.variant_id) =>
        {
            SourceContractResult::Supported {
                contract_id: contract.id.clone(),
            }
        }
        SourceClassification::Recognized { .. } => SourceContractResult::RecognizedNotListed {
            contract_id: contract.id.clone(),
        },
        SourceClassification::Unrecognized
            if matches!(
                inspection.assessment.admission,
                SourceAdmission::Rejected {
                    reason: SourceRejectionReason::KnownMismatch
                }
            ) =>
        {
            SourceContractResult::KnownIncompatible {
                contract_id: contract.id.clone(),
            }
        }
        SourceClassification::NotEvaluated | SourceClassification::Ambiguous { .. } => {
            SourceContractResult::NotEvaluated
        }
        SourceClassification::Unrecognized => SourceContractResult::NotEvaluated,
    }
}

fn referenced_evidence(
    source_catalog: Option<&crate::SourceCatalog>,
    profile: Option<&SourceIdentityProfile>,
    applications: &[SourceApplicationInspection],
    records: &[SourceEvidence],
) -> Vec<SourceEvidenceLink> {
    let Some(source_catalog) = source_catalog else {
        return Vec::new();
    };
    let mut ids = HashSet::new();
    if let Some(profile) = profile {
        for variant in &profile.variants {
            ids.extend(variant.evidence_ids.iter().cloned());
            for representation in &variant.representations {
                ids.extend(representation.evidence_ids.iter().cloned());
            }
        }
    }
    for application in applications {
        ids.extend(application.contract.evidence_ids.iter().cloned());
    }
    for record in records {
        ids.extend(record.evidence_ids.iter().cloned());
    }
    source_catalog
        .evidence
        .iter()
        .filter(|evidence| ids.contains(&evidence.id))
        .map(SourceEvidenceLink::from)
        .collect()
}

fn observation_matches_record(inspection: &SourceInspection, record: &SourceRecord) -> bool {
    let content_matches = inspection.observed_digests.iter().any(|digest| {
        digest.algorithm == crate::SourceDigestAlgorithm::Sha256
            && digest.value.eq_ignore_ascii_case(&record.sha256)
            && digest.size == record.size
    });
    let storage_matches = (record.storage_sha256.eq_ignore_ascii_case(&record.sha256)
        && record.storage_size == record.size
        && content_matches)
        || inspection.observed_digests.iter().any(|digest| {
            digest.algorithm == crate::SourceDigestAlgorithm::Sha256
                && digest.scope == crate::DigestScope::OriginalContainer
                && digest.value.eq_ignore_ascii_case(&record.storage_sha256)
                && digest.size == record.storage_size
        });
    content_matches && storage_matches
}

fn report_message(
    health: SourceHealth,
    inspection: &SourceInspection,
) -> (&'static str, &'static str, &'static str) {
    if health == SourceHealth::Changed {
        return (
            "source_changed",
            "The selected source differs from the registered baseline.",
            "Review the full actual and expected identities, then relink only if this replacement is intended.",
        );
    }
    if matches!(
        inspection.assessment.classification,
        SourceClassification::Ambiguous { .. }
    ) {
        return (
            "ambiguous_identity",
            "The source matches more than one catalog identity.",
            "Keep the source unchanged and review the candidate editions before continuing.",
        );
    }
    if inspection
        .validator
        .as_ref()
        .is_some_and(|validator| validator.result == crate::SourceValidatorResult::NotRun)
    {
        return (
            "selected_needs_checking",
            "The source passed preliminary selection and still needs its upstream check.",
            "Run the reviewed setup check before treating this source as ready.",
        );
    }
    match (
        &inspection.assessment.classification,
        &inspection.assessment.admission,
    ) {
        (SourceClassification::Recognized { .. }, SourceAdmission::Admitted { .. }) => (
            "recognized_exact",
            "The source matches one exact catalog identity.",
            "Review the dependent port requirements and qualification coverage before setup.",
        ),
        (
            _,
            SourceAdmission::Rejected {
                reason: SourceRejectionReason::KnownMismatch,
            },
        ) => (
            "known_mismatch",
            "The source does not match an accepted catalog identity.",
            "Choose an edition listed by the reviewed requirements.",
        ),
        (
            _,
            SourceAdmission::Rejected {
                reason: SourceRejectionReason::AmbiguousIdentity,
            },
        ) => (
            "ambiguous_identity",
            "The source matches more than one catalog identity.",
            "Keep the source unchanged and review the candidate editions before continuing.",
        ),
        (
            _,
            SourceAdmission::Admitted {
                mode: SourceAdmissionMode::InformationalConsent,
            },
        ) => (
            "accepted_identity_unknown",
            "The source is eligible for informational intake, but its exact edition is unknown.",
            "Review the evidence gap before consenting to setup.",
        ),
        (
            _,
            SourceAdmission::Admitted {
                mode: SourceAdmissionMode::StructuralChecks,
            },
        ) => (
            "accepted_identity_unknown",
            "The source passed structural checks, but its exact edition is unknown.",
            "Review the port requirements before setup.",
        ),
        _ => (
            "not_evaluated",
            "The source identity has not been fully evaluated.",
            "Inspect the expected identities and complete the required source check.",
        ),
    }
}

fn error_code(error: &PortcoveError) -> String {
    match error.code {
        crate::ErrorCode::Usage => "usage",
        crate::ErrorCode::Unsupported => "unsupported",
        crate::ErrorCode::NotFound => "not_found",
        crate::ErrorCode::SourceInvalid => "source_invalid",
        crate::ErrorCode::Network => "network",
        crate::ErrorCode::Verification => "verification",
        crate::ErrorCode::Install => "install",
        crate::ErrorCode::State => "state",
        crate::ErrorCode::Launch => "launch",
        crate::ErrorCode::Conflict => "conflict",
        crate::ErrorCode::Cancelled => "cancelled",
    }
    .into()
}

fn role_order(role: PortSourceRole) -> u8 {
    match role {
        PortSourceRole::Game => 0,
        PortSourceRole::Bios => 1,
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;
    use crate::{ObservedSourceDigest, SourceAssessment, SourceDigestAlgorithm, SourceIdentity};

    fn report_for(
        catalog: &Catalog,
        profile_id: &str,
        classification: SourceClassification,
        admission: SourceAdmission,
    ) -> SourceInspectionReport {
        available_report(
            catalog,
            None,
            SourceInspection {
                profile_id: profile_id.into(),
                path: PathBuf::from("selected.source"),
                observed_digests: vec![ObservedSourceDigest {
                    algorithm: SourceDigestAlgorithm::Sha256,
                    scope: crate::DigestScope::OriginalFile,
                    value: "0".repeat(64),
                    size: 1,
                }],
                archive_member_name: None,
                components: Vec::new(),
                validator: None,
                assessment: SourceAssessment {
                    health: SourceHealth::NotBaselined,
                    classification,
                    contract: SourceContractResult::NotEvaluated,
                    admission,
                    evidence: Vec::new(),
                },
                record: None,
                message: "test inspection".into(),
            },
        )
        .unwrap()
    }

    #[test]
    fn complete_report_carries_expected_hashes_contracts_and_open_state_codes() {
        let catalog = Catalog::embedded().unwrap();
        let source_catalog = catalog.source_catalog().unwrap();
        let profile = source_catalog
            .identities
            .iter()
            .find(|profile| {
                source_catalog
                    .contracts
                    .iter()
                    .any(|contract| contract.profile_id == profile.id)
                    && profile.variants.iter().any(|variant| {
                        !variant.legacy_projection_only && !variant.representations.is_empty()
                    })
            })
            .unwrap();
        let variant = profile
            .variants
            .iter()
            .find(|variant| !variant.legacy_projection_only)
            .unwrap();
        let identity = SourceIdentity {
            game_id: profile.id.clone(),
            variant_id: variant.id.clone(),
            representation_id: variant.representations[0].id.clone(),
        };
        let report = report_for(
            &catalog,
            &profile.id,
            SourceClassification::Recognized { identity },
            SourceAdmission::Admitted {
                mode: SourceAdmissionMode::ExactIdentity,
            },
        );

        assert_eq!(report.schema_version, 1);
        assert_eq!(report.state_code, "recognized_exact");
        assert!(!report.applications.is_empty());
        assert!(report.expected_identity.is_some());
        let value = serde_json::to_value(&report).unwrap();
        let serialized = serde_json::to_string(&value).unwrap();
        let expected = serde_json::to_string(profile).unwrap();
        for digest in profile
            .variants
            .iter()
            .flat_map(|variant| &variant.representations)
            .flat_map(|representation| match &representation.kind {
                crate::SourceRepresentationKind::RawFile { identities }
                | crate::SourceRepresentationKind::CanonicalN64 { identities }
                | crate::SourceRepresentationKind::ArchiveMember { identities, .. }
                | crate::SourceRepresentationKind::GamecubeNormalizedIso { identities }
                | crate::SourceRepresentationKind::OpticalTrackSet { identities, .. }
                | crate::SourceRepresentationKind::Compound { identities, .. } => {
                    identities.as_slice()
                }
                _ => &[],
            })
            .flat_map(|identity| {
                [
                    identity.sha1.as_ref(),
                    identity.sha256.as_ref(),
                    identity.crc32.as_ref(),
                ]
            })
            .flatten()
        {
            assert!(expected.contains(digest));
            assert!(serialized.contains(digest));
        }

        let mut future = value;
        future["state_code"] = serde_json::json!("future_state_added_without_meaning_change");
        let parsed: SourceInspectionReport = serde_json::from_value(future).unwrap();
        assert_eq!(
            parsed.state_code,
            "future_state_added_without_meaning_change"
        );

        let mut optional = serde_json::to_value(&report).unwrap();
        let object = optional.as_object_mut().unwrap();
        for field in ["registered", "inspection", "problem", "expected_identity"] {
            object.remove(field);
        }
        let parsed: SourceInspectionReport = serde_json::from_value(optional).unwrap();
        assert!(parsed.registered.is_none());
        assert!(parsed.inspection.is_none());
        assert!(parsed.expected_identity.is_none());
    }

    #[test]
    fn ambiguous_and_informational_states_stay_distinct() {
        let catalog = Catalog::embedded().unwrap();
        let source_catalog = catalog.source_catalog().unwrap();
        let profile = source_catalog.identities.first().unwrap();
        let candidate = SourceIdentity {
            game_id: profile.id.clone(),
            variant_id: "candidate".into(),
            representation_id: "representation".into(),
        };
        let ambiguous = report_for(
            &catalog,
            &profile.id,
            SourceClassification::Ambiguous {
                candidates: vec![candidate.clone(), candidate],
            },
            SourceAdmission::Rejected {
                reason: SourceRejectionReason::AmbiguousIdentity,
            },
        );
        assert_eq!(ambiguous.state_code, "ambiguous_identity");

        let informational_contract = source_catalog
            .contracts
            .iter()
            .find(|contract| contract.admission_mode == CatalogAdmissionMode::Informational)
            .unwrap();
        let informational = report_for(
            &catalog,
            &informational_contract.profile_id,
            SourceClassification::Unrecognized,
            SourceAdmission::Admitted {
                mode: SourceAdmissionMode::InformationalConsent,
            },
        );
        assert_eq!(informational.state_code, "accepted_identity_unknown");
        assert!(
            informational
                .applications
                .iter()
                .any(|application| matches!(
                    application.contract_result,
                    SourceContractResult::Informational { .. }
                ))
        );
    }

    #[test]
    fn evidence_resolution_revalidates_the_active_catalog_entry() {
        let catalog = Catalog::embedded().unwrap();
        let mut source_catalog = catalog.source_catalog().unwrap().clone();
        let evidence_id = source_catalog.evidence[0].id.clone();
        assert!(
            source_catalog
                .reviewed_evidence_url(&evidence_id)
                .unwrap()
                .starts_with("https://")
        );
        assert!(
            source_catalog
                .reviewed_evidence_url("https://attacker.invalid/evidence")
                .is_err()
        );
        source_catalog.evidence[0].immutable_url = "http://attacker.invalid/evidence".into();
        assert!(source_catalog.reviewed_evidence_url(&evidence_id).is_err());
        source_catalog.evidence.clear();
        assert!(source_catalog.reviewed_evidence_url(&evidence_id).is_err());
    }
}
