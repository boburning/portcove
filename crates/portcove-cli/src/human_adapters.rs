//! Human-only adapters for CLI batch envelopes and task readback.
//! These functions never refresh state or change the serialized Core result.

use portcove_core::{
    Catalog, ErrorCode, ExternalRuntimeRecord, GhostshipRecoveryResult, GithubDeviceLoginResult,
    GithubDeviceLoginState, LaunchSessionOutcome, LaunchSessionPhase, LaunchSessionRecord,
    LibraryIdentity, LibrarySelection, LibrarySelectionSource, PortcoveError,
    PreparationCleanupPreview, SourceInboxPaths, SourceInboxResolution, SourceInboxResolutionState,
};
use schemars::JsonSchema;

use crate::{PortBatchOutcome, SourceBatchOutcome, human};

pub(crate) fn port_batch<T: JsonSchema>(
    label: &str,
    outcomes: &[PortBatchOutcome<T>],
    catalog: &Catalog,
    technical: bool,
    render: impl Fn(&T, &Catalog) -> String,
) -> String {
    if outcomes.is_empty() {
        return format!("{label}: no installed ports to process.");
    }
    let succeeded = outcomes.iter().filter(|item| item.ok).count();
    let mut output = format!(
        "{label}: {} ports; {succeeded} succeeded, {} did not succeed.\nEach result is independent.",
        outcomes.len(),
        outcomes.len() - succeeded,
    );
    for item in outcomes {
        output.push_str(&format!(
            "\n\n{}\n",
            human::port_name(catalog, &item.port_id)
        ));
        match (&item.result, &item.error) {
            (Some(result), _) if item.ok => output.push_str(&render(result, catalog)),
            (_, Some(error)) => output.push_str(&human::failure(error, technical)),
            _ => output.push_str("No result was returned. Next step: Inspect this port's status and activity before trying again."),
        }
    }
    output
}

pub(crate) fn source_batch(
    outcomes: &[SourceBatchOutcome],
    catalog: &Catalog,
    technical: bool,
) -> String {
    if outcomes.is_empty() {
        return "No registered game files to check. Next step: Use portcove source discover with the folders and profiles you want to search.".into();
    }
    let succeeded = outcomes.iter().filter(|item| item.ok).count();
    let mut output = format!(
        "Game-file checks: {} registrations; {succeeded} succeeded, {} did not succeed.",
        outcomes.len(),
        outcomes.len() - succeeded,
    );
    for item in outcomes {
        output.push_str(&format!(
            "\n\n{}\n",
            human::profile_name(catalog, &item.profile_id)
        ));
        match (&item.result, &item.error) {
            (Some(result), _) if item.ok => output.push_str(&human::source_inspection(&result.inspection)),
            (_, Some(error)) => output.push_str(&human::failure(error, technical)),
            _ => output.push_str("No check result was returned. Next step: Inspect the registration before trying again."),
        }
    }
    output
}

pub(crate) fn library_selection(selection: &LibrarySelection) -> String {
    let source = match selection.source {
        LibrarySelectionSource::Invocation => "This invocation (--library or PORTCOVE_LIBRARY)",
        LibrarySelectionSource::Saved => "Saved default",
        LibrarySelectionSource::PlatformDefault => "Platform default",
    };
    format!(
        "Selected library: {}\nSelection: {source}\nNext step: Use portcove library identity to read its durable identity and active location.",
        human::clean(&selection.root.display().to_string())
    )
}

pub(crate) fn library_identity(identity: &LibraryIdentity) -> String {
    format!(
        "Library identity: {}\nActive library: {}",
        human::clean(&identity.id),
        human::clean(&identity.root.display().to_string())
    )
}

pub(crate) fn device_login_result(result: &GithubDeviceLoginResult) -> String {
    let state = match result.state {
        GithubDeviceLoginState::Pending => "GitHub sign-in is waiting for authorization.",
        GithubDeviceLoginState::Complete => "GitHub sign-in completed.",
    };
    result.status.as_ref().map_or_else(
        || format!("{state}\nNext step: Use portcove auth status to inspect the current sign-in."),
        |status| format!("{state}\n{}", human::auth_status(status)),
    )
}

pub(crate) fn inbox_paths(paths: &SourceInboxPaths, catalog: &Catalog) -> String {
    let mut output = format!(
        "Game-file folder: {}",
        human::clean(&paths.root.display().to_string())
    );
    if let Some(profile) = &paths.profile_id {
        output.push_str(&format!(
            "\nRequired game files: {}",
            human::profile_name(catalog, profile)
        ));
    }
    if let Some(path) = &paths.profile {
        output.push_str(&format!(
            "\nProfile folder: {}",
            human::clean(&path.display().to_string())
        ));
    }
    output.push_str("\nShowing a folder does not register game files. Next step: Scan the profile folder with portcove source inbox scan PROFILE_ID.");
    output
}

pub(crate) fn inbox_resolution(result: &SourceInboxResolution, catalog: &Catalog) -> String {
    let state = match result.state {
        SourceInboxResolutionState::Registered => "Existing registration checked",
        SourceInboxResolutionState::ExactMatch => "Exact match selected",
        SourceInboxResolutionState::ApprovalRequired => "Review and approval required",
        SourceInboxResolutionState::Unresolved => "No game files selected",
        SourceInboxResolutionState::Conflict => "Multiple candidates need review",
        SourceInboxResolutionState::Incomplete => "Scan incomplete",
    };
    let mut output = format!(
        "Game-file folder scan: {state}\nRequired game files: {}\nActivity: {}\nExamined: {} entries; {} candidates checked; {} hashed\nCandidates returned: {}\nSkipped symbolic links: {}\nReported issues: {} ({} omitted)\nLimits reached: {}",
        human::profile_name(catalog, &result.profile_id),
        human::clean(&result.operation_id),
        result.stats.entries_examined,
        result.stats.candidates_inspected,
        human::format_bytes(result.stats.hash_bytes),
        result.candidates.len(),
        result.stats.symlinks_skipped,
        result.stats.issues.len(),
        result.stats.issues_omitted,
        result.stats.limits_reached.len(),
    );
    for candidate in &result.candidates {
        output.push_str(&format!(
            "\nCandidate: {}\nReusable without additional approval: {}",
            human::clean(&candidate.inspection.path.display().to_string()),
            if candidate.automatically_reusable {
                "Yes"
            } else {
                "No"
            }
        ));
        if let Some(record) = &candidate.inspection.record {
            output.push_str(&format!(
                "\nObserved SHA-256: {}",
                human::clean(&record.sha256)
            ));
        }
    }
    if let Some(selected) = &result.selected {
        output.push_str(&format!(
            "\nSelected registration:\n{}",
            human::source_record(selected, catalog)
        ));
    } else {
        output.push_str("\nNo registration was selected. Next step: Review one candidate with portcove source inbox import PROFILE_ID PATH; apply only the exact plan returned by that review.");
    }
    output
}

pub(crate) fn external_removed(record: &ExternalRuntimeRecord, catalog: &Catalog) -> String {
    format!(
        "Stopped using this external installation for {}.\nFormer location: {}\nThe external files remain in place.\nNext step: Use portcove status PORT_ID to inspect current launch readiness.",
        human::port_name(catalog, &record.port_id),
        human::clean(&record.path.display().to_string())
    )
}

pub(crate) fn ghostship_recovery(result: &GhostshipRecoveryResult, catalog: &Catalog) -> String {
    format!(
        "Legacy data recovery completed\n{}\nRestored backup: {}\nSafety backup: {}\nRetained runtime data: {}",
        human::install_result(&result.install, catalog),
        human::clean(&result.restored_backup.id),
        human::clean(&result.safety_backup.id),
        human::clean(&result.runtime_safety_path.display().to_string())
    )
}

pub(crate) fn preparation_cleaned(result: &PreparationCleanupPreview) -> String {
    format!(
        "Retained preparation files discarded\nActivity: {}\nRemoved private folder: {}\nReviewed SHA-256: {}\nThe original installation and registered game files remain at their existing locations.",
        human::clean(&result.operation_id),
        human::clean(&result.retained_path.display().to_string()),
        human::clean(&result.preview_sha256)
    )
}

fn artwork_asset(asset: &portcove_core::LocalArtworkAsset) -> String {
    format!(
        "Image: {}\nSHA-256: {}\nSize: {} ({} × {} pixels)\nCreated: {}",
        human::clean(&asset.original_name),
        human::clean(&asset.sha256),
        human::format_bytes(asset.byte_size),
        asset.width,
        asset.height,
        human::utc_time(asset.imported_at)
    )
}

pub(crate) fn artwork_state(state: &portcove_core::ArtworkState, catalog: &Catalog) -> String {
    use portcove_core::{ArtworkAvailability, ArtworkResolvedSource, ArtworkSlot};
    let slot = match state.choice.slot {
        ArtworkSlot::Cover => "Cover",
        ArtworkSlot::Detail => "Detail image",
    };
    let availability = match state.availability {
        ArtworkAvailability::Fallback => "Generated fallback",
        ArtworkAvailability::Available => "Available",
        ArtworkAvailability::Unavailable => "Selected image unavailable",
    };
    let source = match state.resolved_source {
        ArtworkResolvedSource::LocalImport { .. } => "Local import",
        ArtworkResolvedSource::IgdbCover { .. } => "Catalog artwork",
        ArtworkResolvedSource::GeneratedFallback => "Generated fallback",
    };
    let mut output = format!(
        "Artwork for {}\nRole: {slot}\nAvailability: {availability}\nSource: {source}\nChoice revision: {}",
        human::port_name(catalog, &state.choice.port_id),
        state.choice.revision
    );
    if let Some(asset) = &state.selection {
        output.push_str(&format!("\n{}", artwork_asset(asset)));
    }
    if let Some(reason) = &state.reason {
        output.push_str(&format!(
            "\nReason: {}",
            human::clean(&portcove_core::redact_diagnostic_text(reason))
        ));
    }
    output
}

pub(crate) fn artwork_handoff(
    handoff: &portcove_core::DestinationArtworkHandoff,
    catalog: &Catalog,
) -> String {
    use portcove_core::{
        DestinationArtworkContent, DestinationArtworkRole, DestinationArtworkSource,
        DestinationArtworkUnavailableReason,
    };
    let role = match handoff.role {
        DestinationArtworkRole::PortraitCover => "Portrait cover",
        DestinationArtworkRole::LandscapeCover => "Landscape cover",
        DestinationArtworkRole::HeroBanner => "Hero banner",
    };
    let source = match handoff.source {
        DestinationArtworkSource::LocalImport { .. } => "Local import",
        DestinationArtworkSource::CatalogDefault { .. } => "Catalog default",
        DestinationArtworkSource::GeneratedFallback => "Generated fallback",
        DestinationArtworkSource::UnassignedRole => "Role not assigned",
    };
    let mut output = format!(
        "Artwork handoff for {}\nRole: {role}\nSource: {source}\nLibrary identity: {}",
        human::port_name(catalog, &handoff.port_id),
        human::clean(&handoff.library.id)
    );
    if let Some(choice) = &handoff.choice {
        output.push_str(&format!("\nChoice revision: {}", choice.revision));
    }
    match &handoff.content {
        DestinationArtworkContent::Available { asset } => output.push_str(&format!(
            "\nLocal original available\n{}",
            artwork_asset(asset)
        )),
        DestinationArtworkContent::Unavailable { reason } => output.push_str(match reason {
            DestinationArtworkUnavailableReason::RoleNotProvided => {
                "\nThis artwork role is not provided."
            }
            DestinationArtworkUnavailableReason::NoLocalOriginal => {
                "\nNo local original is available for this selection."
            }
            DestinationArtworkUnavailableReason::SelectedOriginalUnavailable => {
                "\nThe selected local original is unavailable."
            }
        }),
    }
    output.push_str("\nThis observation does not grant destination ownership, copyright permission, or consent to write there.");
    output
}

pub(crate) fn artwork_bytes(
    result: &portcove_core::DestinationArtworkBytes,
    catalog: &Catalog,
) -> String {
    format!(
        "{}\nOriginal bytes returned: {}\nUse --json or --jsonl to receive the exact original byte array.",
        artwork_handoff(&result.handoff, catalog),
        human::format_bytes(result.original.len() as u64)
    )
}

pub(crate) fn unused_artwork(assets: &[portcove_core::LocalArtworkAsset]) -> String {
    if assets.is_empty() {
        return "No unreferenced local artwork images.".into();
    }
    format!(
        "Unreferenced local artwork: {} images\n\n{}\nNext step: Review an image's full SHA-256 before using artwork remove-unused.",
        assets.len(),
        assets
            .iter()
            .map(artwork_asset)
            .collect::<Vec<_>>()
            .join("\n\n")
    )
}

pub(crate) fn launch_record(
    record: Option<&LaunchSessionRecord>,
    request_id: &str,
    catalog: Option<&Catalog>,
    technical: bool,
) -> String {
    let Some(record) = record else {
        return format!(
            "No launch request was found for {}. No game was started by this read.\nNext step: Check the request ID and use the same --library as the original launch.",
            human::clean(request_id)
        );
    };
    let known_catalog = catalog.filter(|catalog| catalog.port(&record.port_id).is_ok());
    let target = known_catalog.map_or_else(
        || "Recorded port; current catalog name unavailable".to_owned(),
        |catalog| human::port_name(catalog, &record.port_id),
    );
    let phase = match record.phase {
        LaunchSessionPhase::Preparing => "Preparing launch",
        LaunchSessionPhase::Spawning => "Starting game process",
        LaunchSessionPhase::Running => "Game process running",
        LaunchSessionPhase::Collecting => "Collecting saves and settings",
        LaunchSessionPhase::Recovering => "Recovering launch state",
    };
    let outcome = match record.outcome {
        Some(LaunchSessionOutcome::Succeeded) => "Succeeded",
        Some(LaunchSessionOutcome::Failed) => "Failed",
        Some(LaunchSessionOutcome::Cancelled) => "Cancelled",
        None => "No terminal outcome recorded",
    };
    let mut output = format!(
        "Launch request: {}\nGame: {target}\nInstallation: {}\nPhase: {phase}\nOutcome: {outcome}\nStarted: {}\nLast recorded update: {}",
        human::clean(&record.id),
        human::clean(&record.install_id),
        human::utc_time(record.started_at),
        human::utc_time(record.updated_at)
    );
    if let Some(finished) = record.finished_at {
        output.push_str(&format!("\nFinished: {}", human::utc_time(finished)));
    }
    if let Some(exit_code) = record.exit_code {
        output.push_str(&format!("\nGame exit code: {exit_code}"));
    }
    if technical && known_catalog.is_none() {
        output.push_str(&format!(
            "\nRecorded port ID (redacted): {}",
            human::clean(&portcove_core::redact_diagnostic_text(&record.port_id))
        ));
    }
    if let Some(message) = &record.message {
        if technical {
            output.push_str(&format!(
                "\nTechnical details (redacted): {}",
                human::clean(&portcove_core::redact_diagnostic_text(message))
            ));
        } else {
            output.push_str("\nUse --technical-details to include redacted recorded details.");
        }
    }
    output
}

/// Adapt a small, closed set of CLI-owned usage messages without changing the
/// Core failure report used by JSON, JSONL, retained activity, or exit mapping.
pub(crate) fn error(command: &str, error: &PortcoveError, technical: bool) -> String {
    let special = match (error.code, error.message.as_str()) {
        (ErrorCode::Usage, "operation cancelled") => Some((
            "Operation cancelled.",
            "The requested action was not confirmed.",
            true,
        )),
        (ErrorCode::Conflict, "GitHub login was cancelled before authorization completed") => {
            Some((
                "GitHub sign-in was cancelled before it finished.",
                "Run portcove auth login to start again.",
                true,
            ))
        }
        (ErrorCode::Usage, "provide PROFILE_ID or --all") => Some((
            "Provide PROFILE_ID or pass --all.",
            "Use portcove source list to find registered profile IDs, then repeat source verify with one ID or --all.",
            false,
        )),
        (ErrorCode::Usage, "provide PORT_ID or --all") => Some((
            "Provide PORT_ID or pass --all.",
            "Use portcove status to find installed ports, then repeat the command with one ID or --all.",
            false,
        )),
        (ErrorCode::Usage, "confirmation required; pass --yes") => Some((
            "Confirmation is required; pass --yes to continue.",
            "Review the selected action, then repeat it with --yes.",
            false,
        )),
        (
            ErrorCode::Usage,
            "auth set-token requires --stdin under --non-interactive; environment tokens are also supported",
        ) => Some((
            "With --non-interactive, auth set-token requires --stdin.",
            "Supply the token through standard input. You can also set PORTCOVE_GITHUB_TOKEN for this environment.",
            false,
        )),
        (ErrorCode::Usage, "applying an import requires --expected-plan") => Some((
            "This restore requires the plan returned by its preview.",
            "Repeat library import without --apply, review the destination and payload, then pass that --expected-plan value with --apply.",
            false,
        )),
        (ErrorCode::Usage, "applying a move requires --expected-plan") => Some((
            "This move requires the plan returned by its preview.",
            "Repeat library move without --apply, review both locations, then pass that --expected-plan value with --apply.",
            false,
        )),
        (ErrorCode::Usage, "--apply requires --expected-plan") => Some((
            "Apply requires the exact plan returned by the preview.",
            "Repeat this command without --apply, review the current plan, then supply its --expected-plan value.",
            false,
        )),
        _ => None,
    };
    if let Some((summary, next, neutral)) = special {
        let mut report = error.report();
        report.presentation.summary = summary.into();
        if neutral {
            report.presentation.tone = portcove_core::FailureTone::Neutral;
        }
        let mut output = human::failure(&report, technical);
        output.push_str(&format!("\nNext step: {next}"));
        return output;
    }
    let mut output = human::failure(&error.report(), technical);
    if error.code == ErrorCode::Usage {
        // The command comes only from this adapter's fixed command-name map.
        let help = match command {
            "remove.preview" => "remove-preview".into(),
            "library.resume_import" => "library resume-import".into(),
            "library.abort_import" => "library abort-import".into(),
            "library.resume_move" => "library resume-move".into(),
            "library.abort_move" => "library abort-move".into(),
            "parse" | "startup" => String::new(),
            _ => command.split('.').collect::<Vec<_>>().join(" "),
        };
        let command = if help.is_empty() {
            "portcove".into()
        } else {
            format!("portcove {help}")
        };
        let label = if output.contains("Next step:") {
            "Command help"
        } else {
            "Next step"
        };
        output.push_str(&format!(
            "\n{label}: Run {command} --help to review the accepted arguments."
        ));
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launch_readback_names_known_ports_and_keeps_unknown_targets_and_outcomes_honest() {
        let catalog = Catalog::embedded().unwrap();
        let port = &catalog.ports()[0];
        let mut record: LaunchSessionRecord = serde_json::from_value(serde_json::json!({
            "id": "owned-launch-request", "port_id": port.id, "install_id": "owned-install",
            "install_root": "/owned/installation", "supervisor_pid": 1,
            "phase": "running", "started_at": 0, "updated_at": 1,
        }))
        .unwrap();
        let original = serde_json::to_value(&record).unwrap();
        let running = launch_record(Some(&record), &record.id, Some(&catalog), false);
        assert!(running.contains(&format!("{} ({})", port.name, port.id)));
        assert!(running.contains("No terminal outcome recorded"));
        assert!(!running.contains("Game exit code:"));
        assert_eq!(serde_json::to_value(&record).unwrap(), original);
        for (outcome, label) in [
            (LaunchSessionOutcome::Succeeded, "Succeeded"),
            (LaunchSessionOutcome::Failed, "Failed"),
            (LaunchSessionOutcome::Cancelled, "Cancelled"),
        ] {
            record.outcome = Some(outcome);
            record.finished_at = Some(2);
            let before = serde_json::to_value(&record).unwrap();
            let text = launch_record(Some(&record), &record.id, Some(&catalog), false);
            assert!(text.contains(&format!("Outcome: {label}")), "{text}");
            assert!(text.contains("Finished: 1970-01-01T00:00:02Z"));
            assert_eq!(serde_json::to_value(&record).unwrap(), before);
        }
        record.port_id = "token=private-launch-target".into();
        record.message = Some("token=private-launch-message".into());
        for current_catalog in [Some(&catalog), None] {
            let text = launch_record(Some(&record), &record.id, current_catalog, false);
            assert!(text.contains("current catalog name unavailable"));
            assert!(!text.contains("private-launch"), "{text}");
            let details = launch_record(Some(&record), &record.id, current_catalog, true);
            assert!(details.contains("Recorded port ID (redacted):"));
            assert!(!details.contains("private-launch"), "{details}");
        }
    }

    #[test]
    fn human_usage_guidance_preserves_machine_failure_and_committed_outcome() {
        let failure = PortcoveError::usage("confirmation required; pass --yes")
            .with_mutation_state(portcove_core::MutationState::Committed);
        let original = serde_json::to_value(failure.report()).unwrap();
        let text = error("remove", &failure, false);
        assert!(text.starts_with("Error: Confirmation is required; pass --yes to continue."));
        assert!(text.contains("The change was saved."));
        assert!(text.contains("Next step:"));
        assert_eq!(serde_json::to_value(failure.report()).unwrap(), original);
        assert_eq!(crate::exit_code(&failure), 2);
    }

    #[test]
    fn cancellation_is_neutral_without_reclassifying_its_machine_error() {
        for (command, failure, code) in [
            ("remove", PortcoveError::usage("operation cancelled"), 2),
            (
                "auth.login",
                PortcoveError::conflict(
                    "GitHub login was cancelled before authorization completed",
                ),
                14,
            ),
            (
                "install",
                PortcoveError::new(ErrorCode::Cancelled, "caller stopped the operation"),
                130,
            ),
        ] {
            let original = serde_json::to_value(failure.report()).unwrap();
            let text = error(command, &failure, false);
            assert!(!text.starts_with("Error:"), "{text}");
            assert!(text.contains("cancelled"), "{text}");
            assert_eq!(serde_json::to_value(failure.report()).unwrap(), original);
            assert_eq!(crate::exit_code(&failure), code);
        }
    }

    #[test]
    fn batch_failures_do_not_erase_successful_items_or_expose_raw_details() {
        let catalog = Catalog::embedded().unwrap();
        let id = catalog.ports()[0].id.clone();
        let outcomes = vec![
            PortBatchOutcome::success(id.clone(), 7_u32),
            PortBatchOutcome::failure(id, &PortcoveError::network("private-failure-canary")),
        ];
        let original = serde_json::to_value(&outcomes).unwrap();
        let text = port_batch(
            "Fixture results",
            &outcomes,
            &catalog,
            false,
            |result, _| format!("Committed item {result}"),
        );
        assert!(text.contains("2 ports; 1 succeeded, 1 did not succeed"));
        assert!(text.contains("Committed item 7"));
        assert!(!text.contains("private-failure-canary"));
        assert_eq!(serde_json::to_value(&outcomes).unwrap(), original);
        assert!(
            port_batch::<u32>(
                "Fixture results",
                &[],
                &catalog,
                false,
                |_, _| unreachable!()
            )
            .contains("no installed ports")
        );
    }

    #[test]
    fn auth_and_transfer_usage_errors_point_to_real_supported_routes() {
        let text = error(
            "auth.set-token",
            &PortcoveError::usage(
                "auth set-token requires --stdin under --non-interactive; environment tokens are also supported",
            ),
            false,
        );
        assert!(text.contains("--stdin") && text.contains("PORTCOVE_GITHUB_TOKEN"));
        let text = error(
            "library.import",
            &PortcoveError::usage("applying an import requires --expected-plan"),
            false,
        );
        assert!(text.contains("restore") && text.contains("without --apply"));
        for (command, route) in [
            ("library.resume_import", "library resume-import"),
            ("library.abort_import", "library abort-import"),
            ("library.resume_move", "library resume-move"),
            ("library.abort_move", "library abort-move"),
            ("remove.preview", "remove-preview"),
        ] {
            let failure = PortcoveError::usage("private-usage-detail-canary");
            let original = serde_json::to_value(failure.report()).unwrap();
            let text = error(command, &failure, false);
            assert!(text.contains(&format!("portcove {route} --help")), "{text}");
            assert!(
                text.contains("inspect portcove status and portcove activity"),
                "{text}"
            );
            assert!(
                text.contains("couldn't confirm whether anything changed"),
                "{text}"
            );
            assert!(!text.contains("private-usage-detail-canary"), "{text}");
            assert!(
                !text.contains("_import --help") && !text.contains("_move --help"),
                "{text}"
            );
            assert_eq!(serde_json::to_value(failure.report()).unwrap(), original);
            assert_eq!(crate::exit_code(&failure), 2);
        }
    }
}
