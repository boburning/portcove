use crate::human::clean;
use portcove_core::GameComparison;

pub(super) fn render(report: &GameComparison) -> String {
    let mut lines = vec![
        format!(
            "Game comparison — {}",
            clean(report.game_id.as_deref().unwrap_or("unrelated project"))
        ),
        format!(
            "Policy: {}; input: {}; evaluated: {}",
            clean(&report.policy_version),
            clean(&report.input_id),
            report.evaluated_at
        ),
    ];
    if let Some(assessment) = &report.assessment {
        lines.push(format!("Outcome: {:?}", assessment.status));
        if let Some(scope) = &assessment.recommended {
            lines.push(format!(
                "Suggested starting point: {}",
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
        lines.push(format!(
            "  Evidence: {:?}; release observation: {:?}",
            port.metadata, port.freshness.state
        ));
        lines.push(format!(
            "  Installed: {}; launch ready: {}; source: {:?}",
            port.installed, port.launch_ready, port.source_health
        ));
        if let Some(release) = &port.offered_release {
            lines.push(format!(
                "  Offered: {} / {} / SHA-256 {}",
                clean(&release.version),
                release.channel,
                clean(&release.artifact_sha256)
            ));
        }
        if let Some(candidate) = report.assessment.as_ref().and_then(|assessment| {
            assessment
                .candidates
                .iter()
                .find(|candidate| candidate.scope.port_id == port.port_id)
        }) {
            lines.push(format!(
                "  Default eligible: {}; evidence coverage: {}/1000; internal score: {:?}/10000",
                candidate.recommendation_eligible,
                candidate.evidence_coverage_permille,
                candidate.ranking_score_basis_points
            ));
            for dimension in &candidate.dimensions {
                lines.push(format!(
                    "  {:?}: {:?}; rating {:?}; strength {}/1000",
                    dimension.dimension,
                    dimension.state,
                    dimension.rating,
                    dimension.strength_permille
                ));
            }
            for reason in &candidate.reasons {
                lines.push(format!("  Reason: {reason:?}"));
            }
            for record in &candidate.evidence {
                lines.push(format!(
                    "  {:?}: {} — {} ({})",
                    record.disposition,
                    clean(&record.evidence.id),
                    clean(&record.evidence.explanation),
                    clean(&record.evidence.source)
                ));
            }
        }
    }
    lines.join("\n")
}
