use crate::human::{clean, release_channel, utc_time};
use portcove_core::{
    ComparisonReleaseState, GameComparison, PortRecommendationStatus, RecommendationDimension,
    RecommendationDimensionState, RecommendationEvidenceDisposition, RecommendationMetadataState,
    RecommendationOperationEligibility, RecommendationReason, SourceHealth,
};

pub(super) fn render(report: &GameComparison) -> String {
    let evaluated = i64::try_from(report.evaluated_at)
        .map(utc_time)
        .unwrap_or_else(|_| "Unknown time".into());
    let mut lines = vec![
        format!(
            "Game comparison — {}",
            clean(report.game_id.as_deref().unwrap_or("unrelated projects"))
        ),
        format!("Evaluated (UTC): {evaluated}"),
    ];
    if let Some(assessment) = &report.assessment {
        lines.push(match assessment.status {
            PortRecommendationStatus::RecommendedStartingPoint => "Suggested for the options you selected.",
            PortRecommendationStatus::ComparableAlternatives => "These options are worth considering; there isn’t enough information to prefer one.",
            PortRecommendationStatus::AssessedSingleCandidate => "Only one port has been assessed; there isn’t enough information to compare it with the others.",
            PortRecommendationStatus::InsufficientEvidence => "There isn’t enough information to suggest a port.",
            PortRecommendationStatus::NoSuitableCandidate => "None of the assessed ports meets the options you selected.",
        }.into());
        if let Some(scope) = &assessment.recommended {
            let name = report
                .ports
                .iter()
                .find(|port| port.port_id == scope.port_id)
                .map_or(scope.port_id.as_str(), |port| port.name.as_str());
            lines.push(format!(
                "Suggested starting point: {} ({})",
                clean(name),
                clean(&scope.port_id)
            ));
        }
    }
    for limitation in &report.limitations {
        lines.push(format!("Limit: {}", clean(limitation)));
    }
    for port in &report.ports {
        lines.push(format!(
            "\n{} ({})",
            clean(&port.name),
            clean(&port.port_id)
        ));
        let metadata = match port.metadata {
            RecommendationMetadataState::Available => "Available",
            RecommendationMetadataState::Missing => "Not recorded",
            RecommendationMetadataState::Invalid => "Couldn’t use the recorded information",
            RecommendationMetadataState::UnsupportedVersion => {
                "Not understood by this version of Portcove"
            }
        };
        let freshness = match port.freshness.state {
            ComparisonReleaseState::CatalogPinned => "Download listed in the catalog; no new check",
            ComparisonReleaseState::ProviderResolved => "Download found; information may be cached",
            ComparisonReleaseState::CollectionFailed => "Couldn’t check the download",
            ComparisonReleaseState::DefinitionChanged => "Catalog information changed; check again",
            ComparisonReleaseState::Unobserved => "Not checked",
            ComparisonReleaseState::NotOffered => "No download offered for these options",
        };
        lines.push(format!(
            "  Comparison information: {metadata}. Download: {freshness}."
        ));
        let source = match port.source_health {
            None => "Unknown",
            Some(SourceHealth::Unregistered) => "Not added",
            Some(SourceHealth::Current) => "Unchanged since added",
            Some(SourceHealth::Missing) => "Not found at the saved location",
            Some(SourceHealth::Unreadable) => "Couldn’t read",
            Some(SourceHealth::Changed) => "Changed since added",
            Some(SourceHealth::NotChecked) => "Not checked",
            Some(SourceHealth::NotBaselined) => "Not yet saved for later comparison",
        };
        lines.push(format!(
            "  In this library: {}. Play: {}. Original files: {source}.",
            if port.installed { "Added" } else { "Not added" },
            if port.launch_ready {
                "Ready under current library checks"
            } else {
                "Not confirmed ready"
            }
        ));
        match &port.operation {
            RecommendationOperationEligibility::Held { reason }
            | RecommendationOperationEligibility::Unknown { reason } => {
                lines.push(format!("  Action: {}", clean(reason)));
            }
            RecommendationOperationEligibility::Allowed => {}
        }
        if let Some(release) = &port.offered_release {
            lines.push(format!(
                "  Offered version: {} ({})",
                clean(&release.version),
                release_channel(release.channel)
            ));
        }
        for limitation in &port.limitations {
            lines.push(format!("  Limit: {}", clean(limitation)));
        }
        if let Some(candidate) = report.assessment.as_ref().and_then(|assessment| {
            assessment
                .candidates
                .iter()
                .find(|candidate| candidate.scope.port_id == port.port_id)
        }) {
            for reason in &candidate.reasons {
                lines.push(format!("  {}", reason_label(*reason)));
            }
            for dimension in &candidate.dimensions {
                let state = match dimension.state {
                    RecommendationDimensionState::Known => "Test results available",
                    RecommendationDimensionState::Unknown => "Not recorded",
                    RecommendationDimensionState::NotApplicable => "Not applicable",
                    RecommendationDimensionState::Conflicting => "Conflicting results",
                };
                lines.push(format!(
                    "  {}: {state}",
                    dimension_label(dimension.dimension)
                ));
            }
            for record in &candidate.evidence {
                let disposition = match record.disposition {
                    RecommendationEvidenceDisposition::Current => "Applies to this comparison",
                    RecommendationEvidenceDisposition::HistoricalScope => {
                        "Earlier results for a different setup"
                    }
                    RecommendationEvidenceDisposition::FutureObservation => {
                        "Date is after this comparison"
                    }
                    RecommendationEvidenceDisposition::UnsupportedObservationKind => {
                        "Test type not supported by this comparison"
                    }
                    RecommendationEvidenceDisposition::Superseded => "Replaced by newer results",
                    RecommendationEvidenceDisposition::Invalid => "Couldn’t use this result",
                };
                lines.push(format!(
                    "  {disposition}: {} ({})",
                    clean(&record.evidence.explanation),
                    clean(&record.evidence.source)
                ));
            }
        }
    }
    lines.push("These results do not confirm successful play on your device. Use --json for exact download identities, hashes and scoring details.".into());
    lines.join("\n")
}

fn dimension_label(value: RecommendationDimension) -> &'static str {
    match value {
        RecommendationDimension::Gameplay => "Gameplay",
        RecommendationDimension::Stability => "Stability and saves",
        RecommendationDimension::Performance => "Performance",
        RecommendationDimension::Controls => "Controls",
        RecommendationDimension::Setup => "Setup and updates",
        RecommendationDimension::Maintenance => "Project maintenance",
    }
}

fn reason_label(value: RecommendationReason) -> &'static str {
    match value {
        RecommendationReason::DifferentGameOrEdition => {
            "This port uses a different game or edition."
        }
        RecommendationReason::DifferentPlatformOrEnvironment => {
            "These tests used a different platform or setup."
        }
        RecommendationReason::SourceNotSelected => "Required original game files are not selected.",
        RecommendationReason::OperationUnknown => {
            "Action availability could not be confirmed; check the game’s status."
        }
        RecommendationReason::OperationHeld => {
            "This action is currently unavailable; see its reason above."
        }
        RecommendationReason::RequirementUnknown => {
            "A feature you need has not been confirmed for this version."
        }
        RecommendationReason::RequirementUnsupported => {
            "This tested version does not support a feature you need."
        }
        RecommendationReason::InvalidEvidence => {
            "Some test results can’t be matched to this exact version or setup."
        }
        RecommendationReason::ConflictingEvidence => "The test results disagree.",
        RecommendationReason::CriticalRegression => {
            "A reported gameplay or save problem remains unresolved."
        }
        RecommendationReason::InsufficientCoverage => {
            "There aren’t enough relevant test results to suggest this port."
        }
        RecommendationReason::GameplayUnobserved => {
            "Gameplay has not been confirmed for this exact version."
        }
        RecommendationReason::StabilityUnobserved => {
            "Stability and save reliability have not been confirmed for this exact version."
        }
        RecommendationReason::GameplayBelowDefaultFloor => "Tests found gameplay limitations.",
        RecommendationReason::StabilityBelowDefaultFloor => {
            "Tests found stability or save problems."
        }
        RecommendationReason::MateriallyWorsePlayingExperience => {
            "Another available port has stronger gameplay test results."
        }
    }
}
