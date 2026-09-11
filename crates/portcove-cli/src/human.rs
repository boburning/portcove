use std::path::Path;

use portcove_core::{
    ActivityRecord, BackupInventory, BackupInventoryState, BackupProblemKind, CapabilityDocument,
    DoctorReport, GithubAuthSource, GithubAuthStatus, HostToolProbeResult, HostToolSource,
    HostToolState, HostToolStatus, InstallPlan, InstallPlanAction, LaunchBlocker,
    OutputDestinationAvailability, OutputDestinationOwnership, OutputDestinationPreview,
    OutputLocationSource, OutputRelocationPlan, Platform, PortDefinition, PortOutputLocation,
    PortPaths, PortStatus, RepairItemKind, SourceClassification, SourceContractResult,
    SourceInspectionReport, SourceRecord, SourceRequirementRole, StorageSummary, SupportTier,
};
use serde::Serialize;
use serde_json::Value;

pub(crate) fn document<T: Serialize>(data: &T) -> serde_json::Result<String> {
    let mut output = String::new();
    render_value(&serde_json::to_value(data)?, 0, &mut output);
    Ok(output.trim_end().to_owned())
}

pub(crate) fn activity_diagnostic(captures: &[portcove_core::ActivityDiagnostic]) -> String {
    if captures.is_empty() {
        return "No retained diagnostic capture is available for this activity.".into();
    }
    captures
        .iter()
        .map(diagnostic_phase)
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn diagnostic_phase(capture: &portcove_core::ActivityDiagnostic) -> String {
    let status = if capture.complete {
        "Capture reached the end of both streams."
    } else {
        "Capture is incomplete. Only output saved before the last observation is available."
    };
    let truncation = if capture.stdout.truncated || capture.stderr.truncated {
        "\nOutput exceeded the capture limit; some output was omitted."
    } else {
        ""
    };
    format!(
        "Activity: {}\nPhase: {}\n{status}{truncation}\n\nStandard output:\n{}\n\nStandard error:\n{}",
        capture.activity_id, capture.phase, capture.stdout.text, capture.stderr.text
    )
}

pub(crate) fn failure(error: &portcove_core::FailureReport, technical: bool) -> String {
    use portcove_core::{FailureTone, MutationState, RecoveryAction};
    let presentation = &error.presentation;
    let tone = if presentation.tone == FailureTone::Neutral {
        "cancelled"
    } else {
        "error"
    };
    let outcome = match presentation.mutation_state {
        MutationState::NotStarted => "This operation did not start.",
        MutationState::NoChanges => "No files were changed by this operation.",
        MutationState::Committed => {
            "The change was committed. Review the current state before another operation."
        }
        MutationState::RecoveryRequired => {
            "Retained work needs recovery review before another attempt."
        }
        MutationState::Unknown => {
            "The changes could not be confirmed. Review the current state before another attempt."
        }
    };
    let mut output = format!("{tone}: {}\n{outcome}", presentation.summary);
    if presentation
        .recovery_actions
        .contains(&RecoveryAction::ReviewPreparation)
    {
        output.push_str("\nReview game preparation before starting a new attempt.");
    }
    if technical {
        let details = serde_json::json!({"code": error.code, "phase": presentation.phase,
            "message": presentation.technical_message, "context": presentation.technical_context});
        output.push_str("\nTechnical details (redacted):\n");
        output.push_str(
            &serde_json::to_string_pretty(&details)
                .unwrap_or_else(|_| "Details could not be formatted.".into()),
        );
    } else {
        output.push_str("\nUse --technical-details when requesting human output to include redacted technical error details.");
    }
    output
}

pub(crate) fn auth_status(status: &GithubAuthStatus) -> String {
    let source = match status.source {
        GithubAuthSource::Anonymous => "anonymous",
        GithubAuthSource::Environment => "environment",
        GithubAuthSource::CredentialStore => "credential store",
    };
    let mut lines = vec![
        format!(
            "GitHub: {}",
            if status.authenticated {
                status.login.as_deref().unwrap_or("authenticated")
            } else {
                "anonymous"
            }
        ),
        format!("Credential source: {source}"),
        format!(
            "Device login: {}",
            if status.device_login_available {
                "available"
            } else {
                "unavailable"
            }
        ),
    ];
    if let Some(rate) = &status.rate_limit {
        lines.push(format!(
            "API allowance: {}/{} (reset Unix time {})",
            rate.remaining, rate.limit, rate.resets_at
        ));
    }
    lines.join("\n")
}

pub(crate) fn catalog_list(ports: &[PortDefinition]) -> String {
    let rows = ports
        .iter()
        .map(|port| {
            vec![
                port.id.clone(),
                port.name.clone(),
                support_tier(port.support_tier).into(),
                port.channels
                    .iter()
                    .map(ToString::to_string)
                    .collect::<Vec<_>>()
                    .join(","),
            ]
        })
        .collect();
    format!(
        "Ports ({})\n{}",
        ports.len(),
        table(&["ID", "NAME", "TIER", "CHANNELS"], rows)
    )
}

pub(crate) fn catalog_show(port: &PortDefinition) -> String {
    format!(
        "{} ({})\nSupport: {}\nChannels: {}\nPlatforms: {}\nSource: {}\nProject: {}\n{}",
        clean(&port.name),
        clean(&port.id),
        support_tier(port.support_tier),
        port.channels
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join(", "),
        port.platforms
            .iter()
            .map(|platform| platform_name(*platform))
            .collect::<Vec<_>>()
            .join(", "),
        clean(port.source_profile.as_deref().unwrap_or("none")),
        clean(&port.project_url),
        clean(&port.summary),
    )
}

pub(crate) fn backup_list(port_id: &str, inventory: &BackupInventory) -> String {
    if inventory.backups.is_empty() && inventory.problems.is_empty() {
        return format!("No backups for {}.", clean(port_id));
    }
    let rows = inventory
        .backups
        .iter()
        .map(|backup| {
            vec![
                backup.id.clone(),
                backup.created_at.to_string(),
                backup.file_count.to_string(),
                format_bytes(backup.size),
                backup.path.display().to_string(),
            ]
        })
        .collect();
    let healthy = if inventory.backups.is_empty() {
        format!("No verified backups for {}.", clean(port_id))
    } else {
        format!(
            "Backups for {} ({})\n{}",
            clean(port_id),
            inventory.backups.len(),
            table(&["ID", "CREATED (UNIX)", "FILES", "SIZE", "PATH"], rows)
        )
    };
    if inventory.problems.is_empty() {
        return healthy;
    }
    let state = match inventory.state {
        BackupInventoryState::Healthy => "healthy",
        BackupInventoryState::Degraded => "degraded",
        BackupInventoryState::RecoveryRequired => "recovery required",
    };
    let problems = inventory
        .problems
        .iter()
        .map(|problem| {
            format!(
                "- {}: {}\n  Path: {}\n  Next: {}",
                backup_problem_kind(problem.kind),
                clean(&problem.message),
                clean(&problem.path.display().to_string()),
                clean(&problem.proposed_action),
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "{healthy}\nBackup inventory: {state} ({} problem{})\n{problems}",
        inventory.problems.len(),
        if inventory.problems.len() == 1 {
            ""
        } else {
            "s"
        },
    )
}

fn backup_problem_kind(kind: BackupProblemKind) -> &'static str {
    match kind {
        BackupProblemKind::MissingManifest => "missing manifest",
        BackupProblemKind::UnreadableManifest => "unreadable manifest",
        BackupProblemKind::MalformedManifest => "malformed manifest",
        BackupProblemKind::IdentityMismatch => "identity mismatch",
        BackupProblemKind::UnsupportedEntry => "unsupported entry",
        BackupProblemKind::RecoveryRequired => "recovery required",
    }
}

pub(crate) fn source_list(sources: &[SourceRecord]) -> String {
    if sources.is_empty() {
        return "No registered sources.".into();
    }
    let rows = sources
        .iter()
        .map(|source| {
            vec![
                source.profile_id.clone(),
                format_bytes(source.storage_size),
                source.updated_at.to_string(),
                source.path.display().to_string(),
            ]
        })
        .collect();
    format!(
        "Registered sources ({})\n{}",
        sources.len(),
        table(&["PROFILE", "SIZE", "UPDATED (UNIX)", "PATH"], rows)
    )
}

pub(crate) fn source_inspection(report: &SourceInspectionReport) -> String {
    let mut lines = vec![
        format!("Source inspection: {}", clean(&report.profile_id)),
        format!("State: {}", clean(&report.state_code)),
        clean(&report.summary),
    ];
    if let Some(inspection) = &report.inspection {
        lines.push(format!(
            "Path: {}",
            clean(&inspection.path.display().to_string())
        ));
        match &inspection.assessment.classification {
            SourceClassification::Recognized { identity } => lines.push(format!(
                "Recognized identity: {} / {} / {}",
                clean(&identity.game_id),
                clean(&identity.variant_id),
                clean(&identity.representation_id)
            )),
            SourceClassification::Ambiguous { candidates } => lines.push(format!(
                "Candidate identities: {}",
                candidates
                    .iter()
                    .map(|identity| format!(
                        "{} / {} / {}",
                        clean(&identity.game_id),
                        clean(&identity.variant_id),
                        clean(&identity.representation_id)
                    ))
                    .collect::<Vec<_>>()
                    .join(", ")
            )),
            SourceClassification::Unrecognized => lines.push("Recognized identity: unknown".into()),
            SourceClassification::NotEvaluated => {
                lines.push("Recognized identity: not evaluated".into())
            }
        }
        lines.push("Observed identities:".into());
        for digest in &inspection.observed_digests {
            lines.push(format!(
                "- {:?} {:?}: {} ({} bytes)",
                digest.algorithm,
                digest.scope,
                clean(&digest.value),
                digest.size
            ));
        }
        for component in &inspection.components {
            lines.push(format!(
                "- component {}{}",
                clean(&component.id),
                component
                    .name
                    .as_deref()
                    .map_or_else(String::new, |name| format!(" ({})", clean(name)))
            ));
            for digest in &component.digests {
                lines.push(format!(
                    "  {:?} {:?}: {} ({} bytes)",
                    digest.algorithm,
                    digest.scope,
                    clean(&digest.value),
                    digest.size
                ));
            }
        }
    }
    if let Some(problem) = &report.problem {
        lines.push(format!(
            "Problem ({}): {}",
            clean(&problem.code),
            clean(&problem.message)
        ));
    }
    if let Some(expected) = &report.expected_identity {
        lines.push(format!(
            "Expected identity: {} ({})",
            clean(&expected.label),
            clean(&expected.id)
        ));
        for variant in expected
            .variants
            .iter()
            .filter(|variant| !variant.legacy_projection_only)
        {
            lines.push(format!(
                "- {}{}{} ({})",
                clean(&variant.title),
                variant
                    .region
                    .as_deref()
                    .map_or_else(String::new, |value| format!(" — {}", clean(value))),
                variant
                    .revision
                    .as_deref()
                    .map_or_else(String::new, |value| format!(" — {}", clean(value))),
                clean(&variant.id)
            ));
            for representation in &variant.representations {
                lines.push(format!("  representation: {}", clean(&representation.id)));
                let value = serde_json::to_value(&representation.kind).unwrap_or_default();
                collect_expected_digests(&value, &mut lines, "    ");
            }
        }
    } else {
        lines.push("Expected identity: missing from this catalog schema".into());
    }
    if !report.applications.is_empty() {
        lines.push("Reviewed port requirements:".into());
        for application in &report.applications {
            let state = match &application.contract_result {
                SourceContractResult::Supported { .. } => "listed",
                SourceContractResult::RecognizedNotListed { .. } => "recognized but not listed",
                SourceContractResult::KnownIncompatible { .. } => "known mismatch",
                SourceContractResult::Informational { .. } => "informational",
                SourceContractResult::UnreviewedForRelease => "not rechecked for release",
                SourceContractResult::NotEvaluated => "not evaluated",
            };
            lines.push(format!(
                "- {} ({}): {} [{}]",
                clean(&application.port_name),
                clean(&application.port_id),
                state,
                clean(&application.contract.id)
            ));
            lines.push(format!(
                "  Release applicability: {} ({} reviewed binding{})",
                clean(&application.release_applicability.state_code),
                application.release_applicability.reviewed_bindings.len(),
                if application.release_applicability.reviewed_bindings.len() == 1 {
                    ""
                } else {
                    "s"
                }
            ));
            lines.push(format!(
                "  Automated legacy platform coverage: {}",
                platform_list(&application.qualification.legacy_automated_platforms)
            ));
            lines.push(format!(
                "  Hands-on legacy platform coverage: {}",
                platform_list(&application.qualification.legacy_hands_on_platforms)
            ));
            lines.push(format!(
                "  Exact qualification records: {}",
                application.qualification.exact_records.len()
            ));
        }
    }
    if !report.evidence.is_empty() {
        lines.push("Reviewed evidence:".into());
        for evidence in &report.evidence {
            lines.push(format!(
                "- {}: {}\n  {}",
                clean(&evidence.id),
                clean(&evidence.claim),
                clean(&evidence.immutable_url)
            ));
        }
    }
    if report.legacy.registration_identity_not_recorded {
        lines.push("Legacy coverage: the registration predates structured source identity.".into());
    }
    lines.push(format!("Next: {}", clean(&report.next_action)));
    lines.join("\n")
}

fn collect_expected_digests(value: &Value, lines: &mut Vec<String>, indent: &str) {
    match value {
        Value::Object(map) => {
            if let Some(scope) = map.get("scope").and_then(Value::as_str) {
                for algorithm in ["sha1", "sha256", "crc32"] {
                    if let Some(digest) = map.get(algorithm).and_then(Value::as_str) {
                        lines.push(format!(
                            "{indent}{} {}: {}",
                            algorithm.to_ascii_uppercase(),
                            clean(scope),
                            clean(digest)
                        ));
                    }
                }
            }
            for child in map.values() {
                collect_expected_digests(child, lines, indent);
            }
        }
        Value::Array(values) => {
            for child in values {
                collect_expected_digests(child, lines, indent);
            }
        }
        _ => {}
    }
}

fn platform_list(platforms: &[Platform]) -> String {
    if platforms.is_empty() {
        "none recorded".into()
    } else {
        platforms
            .iter()
            .map(|platform| platform_name(*platform))
            .collect::<Vec<_>>()
            .join(", ")
    }
}

pub(crate) fn status(status: &PortStatus) -> String {
    statuses(std::slice::from_ref(status))
}

pub(crate) fn statuses(statuses: &[PortStatus]) -> String {
    if statuses.is_empty() {
        return "No catalog ports.".into();
    }
    let rows = statuses
        .iter()
        .map(|status| {
            vec![
                status.port_id.clone(),
                status.channel.to_string(),
                status.update_policy.to_string(),
                status
                    .active
                    .as_ref()
                    .map_or_else(|| "-".into(), |install| install.version.clone()),
                status
                    .staged
                    .as_ref()
                    .map_or_else(|| "-".into(), |install| install.version.clone()),
                readiness(status),
            ]
        })
        .collect();
    format!(
        "Status ({})\n{}",
        statuses.len(),
        table(
            &["PORT", "CHANNEL", "POLICY", "ACTIVE", "STAGED", "READINESS"],
            rows,
        )
    )
}

pub(crate) fn activities(
    records: &[ActivityRecord],
    catalog: &portcove_core::Catalog,
    technical: bool,
) -> String {
    if records.is_empty() {
        return "No activity records.".into();
    }
    let entries = records
        .iter()
        .map(|record| activity(record, catalog, technical))
        .collect::<Vec<_>>();
    format!(
        "Recent activity ({})\n\n{}",
        records.len(),
        entries.join("\n\n")
    )
}

fn activity(record: &ActivityRecord, catalog: &portcove_core::Catalog, technical: bool) -> String {
    use portcove_core::{ActivityStatus, ActivityTargetKind, redact_diagnostic_text};
    // Failed requests can record arbitrary input as a target. Only catalog-owned
    // identities belong in primary copy; historical/unknown input is opt-in.
    let target = record
        .target_id
        .as_deref()
        .and_then(|id| match record.target_kind {
            ActivityTargetKind::Port => catalog.port(id).ok().map(|port| port.id.as_str()),
            ActivityTargetKind::Source => catalog
                .source_profile(id)
                .ok()
                .map(|profile| profile.id.as_str()),
            ActivityTargetKind::Library => None,
        });
    let mut output = format!(
        "Activity: {}\nStatus: {}\nOperation: {}\nTarget: {}\nStarted (UNIX): {}",
        clean(&record.id),
        record.status,
        record.operation,
        clean(target.unwrap_or(match record.target_kind {
            ActivityTargetKind::Port => "port (not in current catalog)",
            ActivityTargetKind::Source => "source (not in current catalog)",
            ActivityTargetKind::Library => "library",
        })),
        record.started_at,
    );
    output.push('\n');
    if let Some(report) = &record.failure {
        output.push_str(&failure(report, technical));
    } else {
        output.push_str(match record.status {
            ActivityStatus::Running => "No terminal outcome has been recorded.",
            ActivityStatus::Succeeded => "Completed.",
            ActivityStatus::Failed | ActivityStatus::Cancelled =>
                "No structured failure outcome was recorded. Review the current state before another attempt.",
        });
        if technical {
            if let Some(message) = &record.message {
                output.push_str("\nTechnical details (redacted):\n");
                output.push_str(&clean(&redact_diagnostic_text(message)));
            }
        } else if record.message.is_some() || (target.is_none() && record.target_id.is_some()) {
            output.push_str("\nUse --technical-details to include redacted recorded details.");
        }
    }
    if technical {
        if let Some(id) = &record.target_id {
            output.push_str("\nRecorded target (redacted): ");
            output.push_str(&clean(&redact_diagnostic_text(id)));
        }
    }
    output.push_str(&format!(
        "\nRetained logs: activity log {}",
        clean(&record.id)
    ));
    output
}

pub(crate) fn storage(summary: &StorageSummary) -> String {
    format!(
        "Library storage\nRoot: {}\nAvailable: {}\nTotal: {}",
        clean(&summary.library_root.display().to_string()),
        format_bytes(summary.volume_available_bytes),
        format_bytes(summary.volume_total_bytes),
    )
}

pub(crate) fn doctor(report: &DoctorReport) -> String {
    let tool_rows = report
        .host_tools
        .iter()
        .map(|tool| {
            vec![
                tool.id.clone(),
                host_tool_state(tool.state).into(),
                tool.source.map_or("-".into(), |source| match source {
                    HostToolSource::Environment => "environment".into(),
                    HostToolSource::Saved => "saved preference".into(),
                    HostToolSource::Discovery => "discovery".into(),
                }),
                tool.path
                    .as_deref()
                    .map_or_else(|| "-".into(), |path| path.display().to_string()),
            ]
        })
        .collect();
    let repairs = if report.repair.items.is_empty() {
        "Repair review: no items".into()
    } else {
        let rows = report
            .repair
            .items
            .iter()
            .map(|item| {
                vec![
                    repair_kind(item.kind).into(),
                    item.port_id.as_deref().unwrap_or("-").into(),
                    item.message.clone(),
                    item.proposed_action.clone(),
                ]
            })
            .collect();
        format!(
            "Repair review ({})\n{}",
            report.repair.items.len(),
            table(&["KIND", "PORT", "MESSAGE", "PROPOSED ACTION"], rows)
        )
    };
    format!(
        "Portcove doctor\nPlatform: {}\nCatalog: {} ports; {} installed; {} sources\n{}\nHost tools\n{}\n{}",
        platform_name(report.platform),
        report.catalog_port_count,
        report.installed_port_count,
        report.registered_source_count,
        storage(&report.library),
        table(&["TOOL", "STATE", "SOURCE", "PATH"], tool_rows),
        repairs,
    )
}

pub(crate) fn host_tools(tools: &[HostToolStatus]) -> String {
    let rows = tools
        .iter()
        .map(|tool| {
            vec![
                tool.id.clone(),
                tool.display_name.clone(),
                host_tool_state(tool.state).into(),
                tool.source.map_or("-".into(), |source| match source {
                    HostToolSource::Environment => "environment".into(),
                    HostToolSource::Saved => "saved preference".into(),
                    HostToolSource::Discovery => "discovery".into(),
                }),
                tool.path
                    .as_deref()
                    .map_or_else(|| "-".into(), |path| path.display().to_string()),
                tool.official_url.clone(),
            ]
        })
        .collect();
    format!(
        "Disc tools ({})\n{}",
        tools.len(),
        table(
            &["ID", "NAME", "STATUS", "SOURCE", "PATH", "OFFICIAL SITE"],
            rows
        )
    )
}

pub(crate) fn host_tool(tool: &HostToolStatus) -> String {
    host_tools(std::slice::from_ref(tool))
}

pub(crate) fn host_tool_probe(result: &HostToolProbeResult) -> String {
    format!(
        "Disc tool: {}\nStatus: {}\nPath: {}\n{}",
        clean(&result.tool_id),
        match result.state {
            portcove_core::HostToolProbeState::Missing => "missing",
            portcove_core::HostToolProbeState::Invalid => "invalid",
            portcove_core::HostToolProbeState::Blocked => "blocked",
            portcove_core::HostToolProbeState::TimedOut => "timed out",
            portcove_core::HostToolProbeState::ExcessiveOutput => "excessive output",
            portcove_core::HostToolProbeState::FailedProbe => "probe failed",
            portcove_core::HostToolProbeState::IncompatibleVersion => "incompatible",
            portcove_core::HostToolProbeState::Cancelled => "cancelled",
            portcove_core::HostToolProbeState::Success => "ready",
        },
        clean(&result.path.display().to_string()),
        clean(&result.message),
    )
}

pub(crate) fn plan(plan: &InstallPlan) -> String {
    let requirements = if plan.source_requirements.is_empty() {
        "none".into()
    } else {
        plan.source_requirements
            .iter()
            .map(|requirement| {
                format!(
                    "{} ({}, {})",
                    clean(&requirement.label),
                    match requirement.role {
                        SourceRequirementRole::GameSource => "game source",
                        SourceRequirementRole::Bios => "BIOS",
                    },
                    if requirement.registered {
                        "registered"
                    } else {
                        "needed"
                    },
                )
            })
            .collect::<Vec<_>>()
            .join("; ")
    };
    let runtime = plan.bundled_runtime.as_ref().map_or_else(
        || "none".to_owned(),
        |runtime| {
            format!(
                "{} ({})",
                clean(&runtime.asset.name),
                format_bytes(runtime.asset.size)
            )
        },
    );
    format!(
        "Install plan for {}\nAction: {}\nChannel: {}\nPlatform: {}\nRelease: {}\nAsset: {} ({})\nBundled runtime: {}\nTotal download: {}\nSources: {}\nOutput folder: {} ({})\nAvailable library storage: {}",
        clean(&plan.port_id),
        install_action(plan.action),
        plan.channel,
        platform_name(plan.platform),
        clean(&plan.release.version),
        clean(&plan.release.asset.name),
        format_bytes(plan.release.asset.size),
        runtime,
        format_bytes(plan.download_bytes),
        requirements,
        clean(
            &plan
                .output_location
                .effective_output_directory
                .display()
                .to_string()
        ),
        output_location_source(plan.output_location.selection_source),
        format_bytes(plan.storage.volume_available_bytes),
    )
}

pub(crate) fn preparation_plan(plan: &portcove_core::PreparationPlan) -> String {
    format!(
        "Preparation: {}\nInstalled version: {}\nSource: {}\nSource assessment: {}\nSetup tool: {}\nReviewed copy: {} bytes\nPlan: {}\nPlanning starts no setup process and does not change launch readiness.",
        clean(&plan.port_id),
        clean(&plan.inputs.install.version),
        clean(&plan.inputs.source.path.display().to_string()),
        clean(&plan.inputs.source_inspection.summary),
        clean(&plan.inputs.setup_tool.path.display().to_string()),
        plan.copy.total_bytes,
        clean(&plan.plan_sha256),
    )
}

pub(crate) fn paths(paths: &PortPaths) -> String {
    format!(
        "Paths for {}\nLibrary: {}\nPersistent data: {}\nFuture install folder: {} ({})\nActive: {}\nPrevious: {}\nStaged: {}",
        clean(&paths.port_id),
        clean(&paths.library_root.display().to_string()),
        clean(&paths.user_data_root.display().to_string()),
        clean(
            &paths
                .output_location
                .effective_output_directory
                .display()
                .to_string()
        ),
        output_location_source(paths.output_location.selection_source),
        optional_path(paths.active_install_root.as_deref()),
        optional_path(paths.previous_install_root.as_deref()),
        optional_path(paths.staged_install_root.as_deref()),
    )
}

pub(crate) fn output_location(location: &PortOutputLocation) -> String {
    format!(
        "Export / install folder for {}\nEffective: {} ({})\nSaved custom folder: {}\nLibrary default: {}\nExisting installs are not moved when this setting changes.",
        clean(&location.port_id),
        clean(&location.effective_output_directory.display().to_string()),
        output_location_source(location.selection_source),
        optional_path(location.configured_output_directory.as_deref()),
        clean(&location.default_output_directory.display().to_string()),
    )
}

pub(crate) fn output_preview(preview: &OutputDestinationPreview) -> String {
    let availability = match preview.availability {
        OutputDestinationAvailability::Available => "available",
        OutputDestinationAvailability::Full => "full",
        OutputDestinationAvailability::Unavailable => "unavailable",
    };
    let ownership = match preview.ownership {
        OutputDestinationOwnership::LibraryDefault => "library default",
        OutputDestinationOwnership::Unclaimed => "unclaimed",
        OutputDestinationOwnership::OwnedByPort => "owned by this game",
        OutputDestinationOwnership::OwnedByAnotherPort => "owned by another game",
        OutputDestinationOwnership::UnrelatedContent => "contains unrelated data",
        OutputDestinationOwnership::Invalid => "invalid",
        OutputDestinationOwnership::Unknown => "unknown",
    };
    let capacity = preview.available_bytes.map_or_else(
        || "unavailable".into(),
        |available| {
            preview.total_bytes.map_or_else(
                || format_bytes(available),
                |total| {
                    format!(
                        "{} available of {}",
                        format_bytes(available),
                        format_bytes(total)
                    )
                },
            )
        },
    );
    let affected = if preview.affected_installs.is_empty() {
        "none".into()
    } else {
        preview
            .affected_installs
            .iter()
            .map(|install| clean(&install.path.display().to_string()))
            .collect::<Vec<_>>()
            .join(", ")
    };
    let validation = if preview.validation_errors.is_empty() {
        "safe to save".into()
    } else {
        preview
            .validation_errors
            .iter()
            .map(|message| clean(message))
            .collect::<Vec<_>>()
            .join("; ")
    };
    format!(
        "Export / install folder preview for {}\nProposed: {}\nAvailability: {}\nOwnership: {}\nCapacity: {}\nExisting installs: {}\nEffect: future placement only; existing installs will not move\nValidation: {}\nPreview fingerprint: {}",
        clean(&preview.port_id),
        clean(
            &preview
                .proposed
                .effective_output_directory
                .display()
                .to_string()
        ),
        availability,
        ownership,
        capacity,
        affected,
        validation,
        clean(&preview.preview_sha256),
    )
}

pub(crate) fn output_relocation_plan(plan: &OutputRelocationPlan) -> String {
    let availability = match plan.availability {
        OutputDestinationAvailability::Available => "available",
        OutputDestinationAvailability::Full => "full",
        OutputDestinationAvailability::Unavailable => "unavailable",
    };
    let installs = plan
        .installs
        .iter()
        .map(|entry| {
            let role = if entry.active {
                "active"
            } else if entry.previous {
                "previous"
            } else if entry.staged {
                "staged"
            } else {
                "retained"
            };
            format!(
                "{} ({}) -> {}",
                clean(&entry.install.version),
                role,
                clean(&entry.destination_path.display().to_string())
            )
        })
        .collect::<Vec<_>>()
        .join("; ");
    let validation = if plan.validation_errors.is_empty() {
        "safe to relocate".into()
    } else {
        plan.validation_errors
            .iter()
            .map(|message| clean(message))
            .collect::<Vec<_>>()
            .join("; ")
    };
    format!(
        "Output relocation review for {}\nFrom: {}\nTo: {}\nInstalled versions: {}\nRequired space: {}\nDestination: {}\nSources: stay in place\nPersistent data: stays in place\nBackups: stay in place\nValidation: {}\nPlan fingerprint: {}",
        clean(&plan.port_id),
        clean(
            &plan
                .current
                .effective_output_directory
                .display()
                .to_string()
        ),
        clean(&plan.destination_root.display().to_string()),
        installs,
        format_bytes(plan.required_bytes),
        availability,
        validation,
        clean(&plan.plan_sha256),
    )
}

fn output_location_source(source: OutputLocationSource) -> &'static str {
    match source {
        OutputLocationSource::RequestOverride => "this request",
        OutputLocationSource::PortSetting => "saved for this game",
        OutputLocationSource::LibraryDefault => "library default",
    }
}

pub(crate) fn capabilities(capabilities: &CapabilityDocument) -> String {
    format!(
        "{} {} capabilities\nSchema: {}\nPlatforms: {}\nMachine formats: {}\nRaw streams: {}\nFailure-isolated batches: {}\nPort locking: {}",
        clean(&capabilities.product),
        clean(&capabilities.product_version),
        capabilities.schema_version,
        capabilities.platforms.len(),
        capabilities.machine_formats.join(", "),
        capabilities.raw_stream_commands.join(", "),
        capabilities.failure_isolated_batches.join(", "),
        clean(&capabilities.port_operation_locking),
    )
}

fn render_value(value: &Value, indent: usize, output: &mut String) {
    let padding = " ".repeat(indent);
    match value {
        Value::Object(fields) => {
            if fields.is_empty() {
                output.push_str(&format!("{padding}(none)\n"));
            }
            for (key, value) in fields {
                if value.is_array() || value.is_object() {
                    output.push_str(&format!("{padding}{}:\n", human_key(key)));
                    render_value(value, indent + 2, output);
                } else {
                    output.push_str(&format!("{padding}{}: {}\n", human_key(key), scalar(value)));
                }
            }
        }
        Value::Array(items) => {
            if items.is_empty() {
                output.push_str(&format!("{padding}(none)\n"));
            }
            for item in items {
                if item.is_array() || item.is_object() {
                    output.push_str(&format!("{padding}-\n"));
                    render_value(item, indent + 2, output);
                } else {
                    output.push_str(&format!("{padding}- {}\n", scalar(item)));
                }
            }
        }
        value => output.push_str(&format!("{padding}{}\n", scalar(value))),
    }
}

fn scalar(value: &Value) -> String {
    match value {
        Value::Null => "none".into(),
        Value::Bool(value) => {
            if *value {
                "yes".into()
            } else {
                "no".into()
            }
        }
        Value::Number(value) => value.to_string(),
        Value::String(value) => clean(value),
        _ => unreachable!("compound JSON values are rendered recursively"),
    }
}

fn human_key(key: &str) -> String {
    let text = key.replace('_', " ");
    let mut characters = text.chars();
    characters.next().map_or(text.clone(), |first| {
        first.to_uppercase().chain(characters).collect()
    })
}

fn table(headers: &[&str], rows: Vec<Vec<String>>) -> String {
    let sanitized = rows
        .into_iter()
        .map(|row| row.into_iter().map(|cell| clean(&cell)).collect::<Vec<_>>())
        .collect::<Vec<_>>();
    let mut widths = headers
        .iter()
        .map(|header| header.chars().count())
        .collect::<Vec<_>>();
    for row in &sanitized {
        for (index, cell) in row.iter().enumerate() {
            widths[index] = widths[index].max(cell.chars().count());
        }
    }
    let format_row = |row: Vec<String>| {
        row.into_iter()
            .enumerate()
            .map(|(index, cell)| {
                if index + 1 == widths.len() {
                    cell
                } else {
                    format!("{cell:<width$}", width = widths[index])
                }
            })
            .collect::<Vec<_>>()
            .join("  ")
    };
    let mut lines = vec![format_row(
        headers.iter().map(|header| (*header).into()).collect(),
    )];
    lines.push(format_row(
        widths.iter().map(|width| "-".repeat(*width)).collect(),
    ));
    lines.extend(sanitized.into_iter().map(format_row));
    lines.join("\n")
}

fn clean(value: &str) -> String {
    value
        .chars()
        .filter_map(|character| match character {
            '\r' | '\n' | '\t' => Some(' '),
            character if character.is_control() => None,
            character => Some(character),
        })
        .collect::<String>()
}

fn format_bytes(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KiB", "MiB", "GiB", "TiB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit + 1 < UNITS.len() {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} B")
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

fn readiness(status: &PortStatus) -> String {
    let Some(readiness) = &status.readiness else {
        return if status.active.is_some() {
            "unknown"
        } else {
            "not installed"
        }
        .into();
    };
    if readiness.launchable {
        return if readiness.pending_setup {
            "ready; setup pending"
        } else {
            "ready"
        }
        .into();
    }
    if let Some(assessment) = status.definition_operations.iter().find(|assessment| {
        assessment.operation == portcove_core::DefinitionOperation::Launch
            && assessment.eligibility.outcome
                != portcove_core::DefinitionEligibilityOutcome::Eligible
    }) {
        let reason = serde_json::to_value(assessment.eligibility.reason)
            .ok()
            .and_then(|value| value.as_str().map(str::to_owned))
            .unwrap_or_else(|| "unknown_policy_result".into());
        return format!("definition {reason}");
    }
    readiness
        .blockers
        .iter()
        .map(|blocker| match blocker {
            LaunchBlocker::MissingSource => "missing source",
            LaunchBlocker::UnreadableSource => "unreadable source",
            LaunchBlocker::ChangedSource => "changed source",
            LaunchBlocker::MissingBios => "missing BIOS",
            LaunchBlocker::UnreadableBios => "unreadable BIOS",
            LaunchBlocker::ChangedBios => "changed BIOS",
            LaunchBlocker::MissingRuntime => "needs verified runtime (update port)",
            LaunchBlocker::PreparationRequired => "needs game data preparation",
            LaunchBlocker::InvalidInstallation => "installation needs verification or repair",
        })
        .collect::<Vec<_>>()
        .join(", ")
}

fn support_tier(tier: SupportTier) -> &'static str {
    match tier {
        SupportTier::Stable => "stable",
        SupportTier::Beta => "beta",
        SupportTier::Rolling => "rolling",
    }
}

fn platform_name(platform: Platform) -> &'static str {
    match platform {
        Platform::WindowsX86_64 => "windows-x86_64",
        Platform::LinuxX86_64 => "linux-x86_64",
        Platform::MacosX86_64 => "macos-x86_64",
        Platform::MacosAarch64 => "macos-aarch64",
    }
}

fn host_tool_state(state: HostToolState) -> &'static str {
    match state {
        HostToolState::Available => "available",
        HostToolState::Missing => "missing",
        HostToolState::Misconfigured => "misconfigured",
        HostToolState::Unsupported => "unsupported",
    }
}

fn repair_kind(kind: RepairItemKind) -> &'static str {
    match kind {
        RepairItemKind::PartialOperation => "partial operation",
        RepairItemKind::CleanupPending => "cleanup pending",
        RepairItemKind::OrphanedFinalDirectory => "orphaned directory",
        RepairItemKind::MissingRegisteredPath => "missing path",
        RepairItemKind::DegradedBackup => "degraded backup",
        RepairItemKind::BackupRecoveryRequired => "backup recovery required",
    }
}

fn install_action(action: InstallPlanAction) -> &'static str {
    match action {
        InstallPlanAction::AlreadyActive => "already active",
        InstallPlanAction::UseStaged => "activate staged release",
        InstallPlanAction::ReuseRetained => "reuse retained release",
        InstallPlanAction::BlockedUnverified => "blocked by unverified install",
        InstallPlanAction::Download => "download",
    }
}

fn optional_path(path: Option<&Path>) -> String {
    path.map_or_else(|| "-".into(), |path| clean(&path.display().to_string()))
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use portcove_core::{BackupInventory, BackupInventoryState, BackupRecord, StorageSummary};

    use super::{backup_list, document, storage, table};

    fn failed_activity(private_path: &std::path::Path) -> portcove_core::ActivityRecord {
        portcove_core::ActivityRecord {
            id: "owned-activity-id".into(),
            operation: portcove_core::ActivityOperation::Prepare,
            target_kind: portcove_core::ActivityTargetKind::Port,
            target_id: Some("opengoal-jak1".into()),
            status: portcove_core::ActivityStatus::Failed,
            message: Some(format!(
                "{} failed with token=owned-secret\u{1b}[31m",
                private_path.display()
            )),
            failure: None,
            started_at: 42,
            finished_at: Some(43),
            cancellation: None,
        }
    }

    #[test]
    fn activity_reports_use_core_outcomes_and_opt_in_redacted_details() {
        use portcove_core::{ActivityStatus, Catalog, ErrorCode, MutationState, PortcoveError};
        let catalog = Catalog::embedded().unwrap();
        let temporary = tempfile::tempdir().unwrap();
        let private_path = temporary.path().join("owned-private-game");
        let mut record = failed_activity(&private_path);
        for (error, status, expected) in [
            (
                PortcoveError::state(record.message.clone().unwrap()),
                ActivityStatus::Failed,
                "The changes could not be confirmed.",
            ),
            (
                PortcoveError::new(ErrorCode::Cancelled, "token=owned-secret")
                    .with_mutation_state(MutationState::NoChanges),
                ActivityStatus::Cancelled,
                "No files were changed by this operation.",
            ),
        ] {
            record.failure = Some(error.report());
            record.status = status;
            let plain = super::activities(&[record.clone()], &catalog, false);
            assert!(plain.contains(expected));
            assert!(plain.contains("Target: opengoal-jak1"));
            assert!(plain.contains("activity log owned-activity-id"));
            assert!(!plain.contains(&temporary.path().display().to_string()));
            assert!(!plain.contains("owned-secret"));
            assert!(!plain.contains("Technical details (redacted):"));
            let technical = super::activities(&[record.clone()], &catalog, true);
            assert!(technical.contains("Technical details (redacted):"));
            assert!(technical.contains("[REDACTED]"));
            assert!(!technical.contains("owned-secret"));
            assert!(!technical.contains('\u{1b}'));
            if status == ActivityStatus::Cancelled {
                assert!(plain.contains("cancelled: The operation was cancelled."));
                assert!(!plain.contains("error:"));
            }
        }
    }

    #[test]
    fn legacy_activity_hides_raw_messages_and_unrecognized_targets_without_inventing_outcomes() {
        use portcove_core::{ActivityStatus, ActivityTargetKind, Catalog};
        let catalog = Catalog::embedded().unwrap();
        let temporary = tempfile::tempdir().unwrap();
        let private_path = temporary.path().join("owned-private-game");
        let mut record = failed_activity(&private_path);
        record.target_id = Some(
            temporary
                .path()
                .join("token=owned-target")
                .display()
                .to_string(),
        );
        for kind in [
            ActivityTargetKind::Port,
            ActivityTargetKind::Source,
            ActivityTargetKind::Library,
        ] {
            record.target_kind = kind;
            for status in [
                ActivityStatus::Failed,
                ActivityStatus::Cancelled,
                ActivityStatus::Running,
                ActivityStatus::Succeeded,
            ] {
                record.status = status;
                let plain = super::activities(&[record.clone()], &catalog, false);
                assert!(!plain.contains(&temporary.path().display().to_string()));
                assert!(!plain.contains("owned-secret"));
                assert!(!plain.contains("owned-target"));
                assert!(!plain.contains("No files were changed"));
                if matches!(status, ActivityStatus::Failed | ActivityStatus::Cancelled) {
                    assert!(plain.contains("No structured failure outcome was recorded"));
                }
                let technical = super::activities(&[record.clone()], &catalog, true);
                assert!(technical.contains(&private_path.display().to_string()));
                assert!(technical.contains("[REDACTED]"));
                assert!(!technical.contains("owned-secret"));
                assert!(!technical.contains("owned-target"));
                assert!(!technical.contains('\u{1b}'));
            }
        }
    }

    #[test]
    fn read_renderers_have_stable_human_snapshots() {
        assert_eq!(
            backup_list(
                "sample",
                &BackupInventory {
                    port_id: "sample".into(),
                    state: BackupInventoryState::Healthy,
                    backups: Vec::new(),
                    problems: Vec::new(),
                }
            ),
            "No backups for sample."
        );
        assert_eq!(
            backup_list(
                "sample",
                &BackupInventory {
                    port_id: "sample".into(),
                    state: BackupInventoryState::Healthy,
                    backups: vec![BackupRecord {
                        id: "backup-1".into(),
                        port_id: "sample".into(),
                        path: PathBuf::from("C:/Portcove/backups/backup-1"),
                        created_at: 42,
                        file_count: 3,
                        size: 2048,
                        sha256: "a".repeat(64),
                    }],
                    problems: Vec::new(),
                },
            ),
            "Backups for sample (1)\nID        CREATED (UNIX)  FILES  SIZE     PATH\n--------  --------------  -----  -------  ----------------------------\nbackup-1  42              3      2.0 KiB  C:/Portcove/backups/backup-1",
        );
        let degraded = backup_list(
            "sample",
            &BackupInventory {
                port_id: "sample".into(),
                state: BackupInventoryState::RecoveryRequired,
                backups: Vec::new(),
                problems: vec![portcove_core::BackupProblem {
                    kind: portcove_core::BackupProblemKind::RecoveryRequired,
                    backup_id: Some("backup-1".into()),
                    operation_id: Some("operation-1".into()),
                    path: PathBuf::from("C:/Portcove/backups/sample/.deleting-operation-1"),
                    message: "deletion was interrupted".into(),
                    proposed_action: "restart Portcove, then review doctor output".into(),
                }],
            },
        );
        assert!(degraded.contains("Backup inventory: recovery required (1 problem)"));
        assert!(degraded.contains("deletion was interrupted"));
        assert!(degraded.contains(".deleting-operation-1"));
        assert_eq!(
            storage(&StorageSummary {
                library_root: PathBuf::from("C:/Portcove"),
                volume_total_bytes: 2 * 1024 * 1024,
                volume_available_bytes: 1024 * 1024,
            }),
            "Library storage\nRoot: C:/Portcove\nAvailable: 1.0 MiB\nTotal: 2.0 MiB",
        );
    }

    #[test]
    fn tables_and_generic_documents_neutralize_terminal_controls() {
        assert_eq!(
            table(
                &["NAME", "VALUE"],
                vec![vec!["unsafe\u{1b}[31m".into(), "two\nlines".into()]]
            ),
            "NAME        VALUE\n----------  ---------\nunsafe[31m  two lines",
        );
        assert_eq!(
            document(&serde_json::json!({"some_value": "line\nnext", "ready": true})).unwrap(),
            "Ready: yes\nSome value: line next",
        );
    }
}
