use portcove_core::{CapabilityFeature as F, CapabilityMode as M, PortCapabilityReport};

pub(crate) fn port_capabilities(report: &PortCapabilityReport) -> String {
    let mut lines = vec![format!("{} — What works and known issues", report.port_id),
        "Management availability and evidence of successful use are separate. Execution rechecks each operation.".into()];
    for route in &report.routes {
        lines.push(format!(
            "\n{}{}",
            route.route,
            route
                .install_id
                .as_ref()
                .map_or(String::new(), |id| format!(" ({id})"))
        ));
        for row in &route.features {
            let feature = match row.feature {
                F::Setup => "Setup",
                F::OriginalFiles => "Original-file checking",
                F::Launch => "Launch",
                F::Updates => "Game updates",
                F::Settings => "Settings",
                F::Backup => "Backup",
                F::Restore => "Restore",
                F::PreviousVersion => "Previous-version recovery",
                F::Gameplay => "Gameplay",
                F::Controls => "Controls",
                F::Audio => "Audio",
                F::Performance => "Performance",
                F::SaveCompatibility => "Save compatibility",
            };
            let mode = match row.mode {
                M::Automatic => "Available in Portcove",
                M::Manual => "Manual",
                M::Unavailable => "Unavailable in Portcove",
                M::Unknown => "Unknown",
            };
            lines.push(format!(
                "{feature}: {mode}; not tested by this report. {}",
                row.explanation
            ));
            if let Some(action) = &row.action {
                lines.push(super::status_action(action));
            }
            if let Some(reason) = row.listing_action.as_ref().and_then(|a| a.reason.as_ref()) {
                lines.push(reason.clone());
            }
            lines.push(format!("Next step: {}", row.next_step));
        }
    }
    if let Some(guide) = &report.setup_guide {
        lines.push("\nUpstream setup guide".into());
        lines.extend(guide.warnings.iter().cloned());
        lines.extend(
            guide
                .steps
                .iter()
                .map(|step| format!("{}: {}", step.title, step.instruction)),
        );
        for reference in &guide.references {
            lines.push(format!(
                "Reference — {}: {}",
                reference.title, reference.instruction
            ));
        }
        if let Some(url) = &guide.help_url {
            lines.push(format!("Detailed upstream guide: {url}"));
        }
    }
    for record in &report.advisories {
        let notice = &record.notice;
        lines.push(format!("Applicability: {:?}", record.applicability));
        lines.push(format!("\n{}: {}\nScope: {:?} / {}; release {:?}; artifact {:?}; edition {:?}. Later versions do not inherit failure or recovery.\nSource: {}; observed {} ({})", notice.id, notice.explanation, notice.platform, notice.route, notice.release, notice.artifact_sha256, notice.edition, notice.provenance, notice.observed_at, notice.evidence));
        if let Some(workaround) = &notice.workaround {
            lines.push(workaround.clone());
        }
    }
    if !["missing", "available"].contains(&report.advisory_state.as_str()) {
        lines.push(
            "Optional compatibility advice is unavailable; operation eligibility is unchanged."
                .into(),
        );
    }
    for observation in &report.observations {
        lines.push(format!("Historical exact-scope evidence (no matching environment selected): {}\n{}\nSource: {}", observation.explanation, serde_json::to_string(&observation.scope).unwrap_or_default(), observation.source));
    }
    if let Some(settings) = &report.settings {
        if let Some(reason) = &settings.reason {
            lines.push(format!("Settings: {reason}"));
        }
        for file in &settings.files {
            if let Some(reason) = &file.reason {
                lines.push(format!("Settings {}: {reason}", file.id));
            }
        }
    }
    if let Some(protection) = &report.protection {
        lines.push(format!("Latest completed backup: {}. Review effective coverage and exclusions with backup list.", if protection.latest_completed_backup.is_some() { "recorded; restore verifies the selected snapshot" } else { "none recorded" }));
    }
    lines.extend(
        report
            .detail_problems
            .iter()
            .map(|problem| format!("Optional detail unavailable: {problem}")),
    );
    lines.join("\n")
}
