use std::path::Path;

mod phases;
mod task_results;
mod transfers;
pub(crate) use phases::phase_name;
pub(crate) use task_results::*;
pub(crate) use transfers::*;

pub(crate) fn game_file_query(
    snapshot: &portcove_core::GameFileQuerySnapshot,
    catalog: &portcove_core::Catalog,
) -> String {
    if snapshot.routes.is_empty() {
        return "No game-file routes were requested.".into();
    }
    snapshot
        .routes
        .iter()
        .map(|route| {
            let state = match route.state {
                portcove_core::GameFileQueryState::FilesAvailable => "Compatible files available",
                portcove_core::GameFileQueryState::FilesMissing => "Files missing",
                portcove_core::GameFileQueryState::NeedsChecking => "Needs checking",
                portcove_core::GameFileQueryState::NoFilesRequired => "No files required",
                portcove_core::GameFileQueryState::UnavailableContext => "Context unavailable",
            };
            let selected = match route.route {
                portcove_core::GameFileRouteKind::ManagedInstall => "managed setup",
                portcove_core::GameFileRouteKind::ExternalRegistration => {
                    "existing installation setup"
                }
                portcove_core::GameFileRouteKind::ManagedLaunch => "managed launch",
                portcove_core::GameFileRouteKind::ExternalLaunch => "existing installation launch",
            };
            format!(
                "{} ({selected}): {state}",
                port_name(catalog, &route.port_id)
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

use portcove_core::{
    ActivityRecord, BackupInventory, BackupInventoryState, BackupProblemKind, CapabilityDocument,
    CatalogOrigin, CatalogStatus, DoctorReport, GameFileRoot, GameFileScanSnapshot,
    GithubAuthSource, GithubAuthStatus, HostToolProbeResult, HostToolSource, HostToolState,
    HostToolStatus, InstallPlan, InstallPlanAction, LaunchBlocker, LibraryContentKind,
    LibraryMovePlan, LibraryMoveResult, OutputDestinationAvailability, OutputDestinationOwnership,
    OutputDestinationPreview, OutputLocationSource, OutputRelocationPlan, Platform, PortDefinition,
    PortOutputLocation, PortPaths, PortStatus, ReleaseChannel, RepairItemKind,
    SourceClassification, SourceContractResult, SourceInspectionReport, SourceRecord,
    SourceRequirementRole, StorageSummary, SupportTier,
};
use serde::Serialize;
use serde_json::Value;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

pub(crate) fn utc_time(seconds: i64) -> String {
    OffsetDateTime::from_unix_timestamp(seconds)
        .ok()
        .and_then(|instant| instant.format(&Rfc3339).ok())
        .unwrap_or_else(|| "Unknown time (invalid Unix timestamp)".into())
}

fn utc_rate_reset(seconds: u64) -> String {
    i64::try_from(seconds).map_or_else(|_| "Unknown time (invalid Unix timestamp)".into(), utc_time)
}

pub(crate) fn document<T: Serialize>(data: &T) -> serde_json::Result<String> {
    let mut output = String::new();
    render_value(&serde_json::to_value(data)?, 0, &mut output);
    Ok(output.trim_end().to_owned())
}

pub(crate) fn library_move_plan(plan: &LibraryMovePlan) -> String {
    let content = plan
        .content
        .iter()
        .map(|tree| {
            let kind = match tree.kind {
                LibraryContentKind::ApplicationVersions => "Application versions",
                LibraryContentKind::UserData => "Saves and settings",
                LibraryContentKind::SourceInbox => "Imported game files",
                LibraryContentKind::Backups => "Backups",
                LibraryContentKind::Toolchains => "Managed tools",
                LibraryContentKind::LocalArtwork => "Local artwork",
            };
            format!(
                "  {kind}: {} {}, {} {}, {}",
                tree.copy.files.len(),
                if tree.copy.files.len() == 1 {
                    "file"
                } else {
                    "files"
                },
                tree.copy.directories.len(),
                if tree.copy.directories.len() == 1 {
                    "folder"
                } else {
                    "folders"
                },
                format_bytes(tree.copy.total_bytes)
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "Library move review\nOriginal library: {}\nNew destination: {}\nContent to copy:\n{}\nWorking space required: {}\nAvailable space: {}\nOriginal retained as a recovery copy: {}\nOriginal game-file references stay at their existing paths.\nReview only; no move has been applied.\nReview SHA-256: {}\nNext step: Close other Portcove clients, then repeat this move with --apply --expected-plan {}.",
        clean(&plan.source_root.display().to_string()),
        clean(&plan.destination_root.display().to_string()),
        if content.is_empty() {
            "  No managed content files."
        } else {
            &content
        },
        format_bytes(plan.required_bytes),
        format_bytes(plan.available_bytes),
        if plan.source_will_be_retained {
            "Yes"
        } else {
            "No"
        },
        clean(&plan.plan_sha256),
        clean(&plan.plan_sha256),
    )
}

pub(crate) fn library_move_result(result: &LibraryMoveResult) -> String {
    let outcome = if result.completed {
        "Library move completed"
    } else {
        "Library move not completed"
    };
    let next = if result.completed {
        "Use the active library shown above for future commands."
    } else {
        "Continue with the active original library. Any copied destination files remain in place; choose a new destination for another move."
    };
    format!(
        "{outcome}\nTransfer: {}\nOriginal library: {}\nDestination: {}\nActive library: {}\nOriginal retained: {}\nNext step: {next}",
        clean(&result.transfer_id),
        clean(&result.source_root.display().to_string()),
        clean(&result.destination_root.display().to_string()),
        clean(&result.active_root.display().to_string()),
        if result.source_retained { "Yes" } else { "No" },
    )
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
        "Both output streams ended. Saved output is shown below."
    } else {
        "Only the output saved before the last observation is available. Later output may be missing."
    };
    let truncation = if capture.stdout.truncated || capture.stderr.truncated {
        "\nOutput exceeded the capture limit; some output was omitted."
    } else {
        ""
    };
    format!(
        "Activity: {}\nPhase: {}\nPhase ID: {}\n{status}{truncation}\n\nStandard output:\n{}\n\nStandard error:\n{}",
        clean(&capture.activity_id),
        phase_name(&capture.phase),
        clean(&portcove_core::redact_diagnostic_text(&capture.phase)),
        diagnostic_text(&capture.stdout.text),
        diagnostic_text(&capture.stderr.text)
    )
}

// Captured tool output is data, not terminal instructions. Keep its layout and
// Unicode text; expose other controls without changing retained machine records.
fn diagnostic_text(text: &str) -> String {
    let mut output = String::with_capacity(text.len());
    for character in text.chars() {
        if character.is_control() && !matches!(character, '\n' | '\t') {
            output.extend(character.escape_default());
        } else {
            output.push(character);
        }
    }
    output
}

pub(crate) fn failure(error: &portcove_core::FailureReport, technical: bool) -> String {
    use portcove_core::{FailureRecoveryTarget, FailureTone, MutationState, RecoveryAction};
    let presentation = &error.presentation;
    let outcome = match presentation.mutation_state {
        MutationState::NotStarted => "This operation did not start.",
        MutationState::NoChanges => "No files were changed by this operation.",
        MutationState::Committed => "The change was saved. Check the result before trying again.",
        MutationState::RecoveryRequired => {
            "An earlier attempt left unfinished work. Review recovery options before trying again."
        }
        MutationState::Unknown => {
            "Portcove couldn't confirm whether anything changed. Check the result before trying again."
        }
    };
    let mut output = if presentation.tone == FailureTone::Neutral {
        format!(
            "Operation cancelled.\n{}\n{outcome}",
            diagnostic_text(&presentation.summary)
        )
    } else {
        format!(
            "Error: {}\n{outcome}",
            diagnostic_text(&presentation.summary)
        )
    };
    if presentation
        .recovery_actions
        .contains(&RecoveryAction::ReviewPreparation)
    {
        output.push_str("\nNext step: Review game preparation before starting a new attempt.");
        if let Some(FailureRecoveryTarget::Preparation { port_id }) = &presentation.recovery_target
            && !port_id.is_empty()
            && port_id
                .as_bytes()
                .first()
                .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
            && port_id
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        {
            output.push_str(&format!("\nUsing the same library selection (including any --library option), inspect the current state with: portcove status {port_id}"));
        }
    } else if presentation
        .recovery_actions
        .contains(&RecoveryAction::ReviewCurrentState)
    {
        output.push_str("\nNext step: Using the same library selection, inspect portcove status and portcove activity before trying again.");
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
        output.push_str("\nTechnical details: Add --technical-details to human output to include redacted diagnostic context.");
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
                status
                    .login
                    .as_deref()
                    .map(clean)
                    .unwrap_or_else(|| "authenticated".into())
            } else {
                "anonymous".into()
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
            "GitHub requests: {}/{} (resets {})",
            rate.remaining,
            rate.limit,
            utc_rate_reset(rate.resets_at)
        ));
    }
    lines.join("\n")
}

pub(crate) fn catalog_list(ports: &[PortDefinition]) -> String {
    if ports.is_empty() {
        return "The active catalog contains no ports.".into();
    }
    let rows = ports
        .iter()
        .map(|port| {
            vec![
                format!("{} ({})", clean(&port.name), clean(&port.id)),
                support_tier(port.support_tier).into(),
                port.channels
                    .iter()
                    .map(|channel| release_channel(*channel))
                    .collect::<Vec<_>>()
                    .join(","),
            ]
        })
        .collect();
    format!(
        "Ports ({})\n{}",
        ports.len(),
        table(&["PORT", "SUPPORT TIER", "CHANNELS"], rows)
    )
}

pub(crate) fn catalog_status(status: &CatalogStatus) -> String {
    let origin = match status.provenance.origin {
        CatalogOrigin::Embedded => "built-in catalog",
        CatalogOrigin::SignedActive => "active signed catalog",
        CatalogOrigin::SignedPrevious => "previous signed catalog",
        CatalogOrigin::DefinitionSelected => "selected definition catalog",
    };
    let mut lines = vec![
        format!("Active catalog: {origin}"),
        format!(
            "Catalog SHA-256: {}",
            clean(&status.provenance.catalog_sha256)
        ),
    ];
    if let Some(key_id) = &status.provenance.key_id {
        lines.push(format!("Publisher: {}", clean(key_id)));
    }
    if let Some(sequence) = status.provenance.sequence {
        lines.push(format!("Sequence: {sequence}"));
    }
    if let Some(expires_at) = status.provenance.expires_at {
        lines.push(format!("Expires: {}", utc_time(expires_at)));
    }
    lines.push(format!(
        "Highest accepted sequence: {}",
        status.highest_sequence
    ));
    lines.push(format!("Trusted publishers: {}", status.trusted_keys.len()));
    for key in &status.trusted_keys {
        lines.push(format!(
            "  {}: {}",
            clean(&key.key_id),
            clean(&key.public_key)
        ));
    }
    lines.push(format!(
        "Catalog updates: {}",
        if status.updates_enabled {
            "enabled"
        } else {
            "disabled"
        }
    ));
    lines.push(format!(
        "Rollback: {}",
        if status.can_rollback {
            "available"
        } else {
            "unavailable"
        }
    ));
    lines.push(format!(
        "Cached signed catalog: {}",
        if status.can_use_cached {
            "available"
        } else {
            "unavailable"
        }
    ));
    for reason in &status.provenance.fallback_reasons {
        lines.push(format!("Fallback reason: {}", clean(reason)));
    }
    lines.push(format!("State SHA-256: {}", clean(&status.state_sha256)));
    lines.join("\n")
}

pub(crate) fn catalog_show(port: &PortDefinition) -> String {
    let user_selected = port
        .release
        .user_prepared
        .values()
        .any(|runtime| runtime.trust == portcove_core::ExternalRuntimeTrust::UserSelected);
    let mut lines = vec![
        format!("{} ({})", clean(&port.name), clean(&port.id)),
        format!("Support tier: {}", support_tier(port.support_tier)),
        format!(
            "Channels: {}",
            port.channels
                .iter()
                .map(|channel| release_channel(*channel))
                .collect::<Vec<_>>()
                .join(", ")
        ),
        format!(
            "Platforms: {}",
            port.platforms
                .iter()
                .map(|platform| platform_name(*platform))
                .collect::<Vec<_>>()
                .join(", ")
        ),
        format!("Upstream state: {}", upstream_status(port.upstream_status)),
    ];
    if let Some(profile_id) = port.source_profile.as_deref() {
        lines.push(format!("Game-file profile ID: {}", clean(profile_id)));
    }
    if let Some(profile_id) = port.bios_source_profile.as_deref() {
        lines.push(format!("BIOS profile ID: {}", clean(profile_id)));
    }
    if let Some(presentation) = &port.presentation {
        lines.push(format!(
            "Installation: {}",
            if user_selected {
                "user-managed existing installation"
            } else {
                installation_method(presentation.installation_method)
            }
        ));
        for requirement in &presentation.source_requirements {
            lines.push(format!(
                "{}: {} (Check method: {})",
                match requirement.role {
                    portcove_core::PortSourceRole::Game => "Game files",
                    portcove_core::PortSourceRole::Bios => "BIOS",
                },
                clean(&requirement.label),
                source_verification(requirement.verification)
            ));
        }
        if let Some(instructions) = &presentation.manual_preparation {
            lines.push(format!("Preparation: {}", clean(instructions)));
        }
        lines.push(match presentation.saves_and_settings {
            portcove_core::SavesAndSettingsBehavior::PortcoveManaged => {
                "Saves and settings: managed by Portcove for backup and restore".into()
            }
            portcove_core::SavesAndSettingsBehavior::ExternalUserOwned => {
                "Saves and settings: user-owned; Portcove does not back up or remove them".into()
            }
        });
    } else {
        lines.push("Presentation details: unavailable in this catalog".into());
    }
    if port.release.provider == portcove_core::ReleaseSource::UserPrepared
        && !port.release.user_prepared.is_empty()
    {
        for (platform, runtime) in &port.release.user_prepared {
            if runtime.trust == portcove_core::ExternalRuntimeTrust::UserSelected {
                lines.push(format!("Existing installation ({}): select the game executable and working directory after upstream setup", platform_name(*platform)));
                continue;
            }
            lines.extend([
                format!(
                    "Accepted runtime ({}): {}",
                    platform_name(*platform),
                    clean(&runtime.version)
                ),
                format!(
                    "Package: {} ({}; {} bytes)",
                    clean(&runtime.archive_name),
                    format_bytes(runtime.archive_size),
                    runtime.archive_size
                ),
                format!("Package SHA-256: {}", clean(&runtime.archive_sha256)),
                format!("Executable: {}", clean(&runtime.executable)),
            ]);
        }
        if user_selected {
            lines.extend([
                "Maintenance: you or the upstream launcher manage setup and updates. Portcove has not authenticated selected bytes as an official package; it does not replace, back up, restore, roll back or delete them.".into(),
                format!("Review launch details: portcove external select-preview {} \"<game-executable>\" --working-directory \"<working-directory>\"", clean(&port.id)),
                format!("Register the same reviewed details: portcove external select {} \"<game-executable>\" --working-directory \"<working-directory>\" --expected-preview \"<review-sha256>\"", clean(&port.id)),
            ]);
        } else {
            lines.extend([
            "Maintenance: user-owned; Portcove does not download or update this runtime".into(),
            format!(
                "Return to Portcove on the matching platform for exact-file review: portcove external preview {} \"<extracted-folder>\"",
                clean(&port.id)
            ),
        ]);
        }
    }
    lines.extend([
        format!("Project: {}", clean(&port.project_url)),
        clean(&port.summary),
    ]);
    lines.join("\n")
}

pub(crate) fn backup_list(
    port_id: &str,
    inventory: &BackupInventory,
    catalog: &portcove_core::Catalog,
) -> String {
    format!(
        "{}\n{}\n{}",
        status_action(&inventory.create_assessment),
        status_action(&inventory.restore_assessment),
        backup_history(&port_name(catalog, port_id), inventory)
    )
}

fn backup_history(port_id: &str, inventory: &BackupInventory) -> String {
    if inventory.backups.is_empty() && inventory.problems.is_empty() {
        return format!("No backups for {}.", clean(port_id));
    }
    let rows = inventory
        .backups
        .iter()
        .map(|backup| {
            vec![
                backup.id.clone(),
                utc_time(backup.created_at),
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
            table(&["ID", "CREATED (UTC)", "FILES", "SIZE", "PATH"], rows)
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

pub(crate) fn backup_action_preview(
    preview: &portcove_core::BackupActionPreview,
    catalog: &portcove_core::Catalog,
) -> String {
    use portcove_core::BackupAction;

    let port = catalog.port(&preview.backup.port_id).map_or_else(
        |_| clean(&preview.backup.port_id),
        |port| format!("{} ({})", clean(&port.name), clean(&port.id)),
    );
    let (action, consequences) = match preview.action {
        BackupAction::Delete => (
            "Delete backup",
            format!(
                "Changes: permanently delete only the selected backup.{}\nPreserved: live managed saved data and other backups.\nPortcove cannot undo this deletion.",
                if preview.retained_runtime_copy_will_be_deleted {
                    "\nThis also permanently deletes its retained Ghostship 3.0.0 runtime saves/settings copy."
                } else {
                    ""
                }
            ),
        ),
        BackupAction::Restore => (
            "Restore backup",
            format!(
                "Changes: replace this port's managed saved data with the selected backup.\nPreserved: the selected backup and other backups.\nBefore replacement: {}",
                if preview.safety_backup_will_be_created {
                    "create a safety backup of current managed saved data."
                } else {
                    "no safety backup is planned."
                },
            ),
        ),
    };
    format!(
        "{action} review\nPort: {port}\nBackup: {}\nArchive folder: {}\nCreated (UTC): {}\nFiles: {}\nSize: {} ({} bytes)\nBackup SHA-256: {}\nCurrent managed saved data exists: {}\n{consequences}\nReview SHA-256: {}\nConsent is bound to the reviewed contents; changed inputs require a new review.",
        clean(&preview.backup.id),
        clean(&preview.backup.path.display().to_string()),
        utc_time(preview.backup.created_at),
        preview.backup.file_count,
        format_bytes(preview.backup.size),
        preview.backup.size,
        clean(&preview.backup.sha256),
        if preview.current_user_data_exists {
            "yes"
        } else {
            "no"
        },
        clean(&preview.preview_sha256),
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

pub(crate) fn source_list(sources: &[SourceRecord], catalog: &portcove_core::Catalog) -> String {
    if sources.is_empty() {
        return "No saved game-file or BIOS locations yet.".into();
    }
    let rows = sources
        .iter()
        .map(|source| {
            vec![
                profile_name(catalog, &source.profile_id),
                format_bytes(source.storage_size),
                utc_time(source.updated_at),
                source.path.display().to_string(),
            ]
        })
        .collect();
    format!(
        "Saved game-file and BIOS locations ({})\n{}",
        sources.len(),
        table(&["PROFILE", "SIZE", "UPDATED (UTC)", "PATH"], rows)
    )
}

pub(crate) fn source_discovery(
    report: &portcove_core::SourceDiscoveryReport,
    catalog: &portcove_core::Catalog,
) -> String {
    let profile_name = |id: &str| {
        catalog.source_profile(id).map_or_else(
            |_| clean(id),
            |profile| format!("{} ({})", clean(&profile.label), clean(id)),
        )
    };
    let mut lines = vec![
        "Source discovery".into(),
        "Only the selected folders, profiles and supported discovery formats were inspected."
            .into(),
        format!("Searched folders: {}", report.searched_roots.len()),
    ];
    for root in &report.searched_roots {
        lines.push(format!("- {}", clean(&root.display().to_string())));
    }
    lines.push(format!(
        "Searched profiles: {}",
        report.searched_profiles.len()
    ));
    for profile in &report.searched_profiles {
        lines.push(format!("- {}", profile_name(profile)));
    }
    lines.extend([
        format!("Entries examined: {}", report.entries_examined),
        format!("Files hashed: {}", report.files_hashed),
        format!(
            "Bytes charged to hash budget: {} ({} bytes)",
            format_bytes(report.hash_bytes),
            report.hash_bytes
        ),
        format!("Symlinks skipped: {}", report.symlinks_skipped),
    ]);
    if report.limits_reached.is_empty() {
        lines.push("No recorded processing limits reached.".into());
    } else {
        lines.push("Search was partial. Reached processing limits:".into());
        for limit in &report.limits_reached {
            use portcove_core::SourceDiscoveryLimit;
            lines.push(
                match limit {
                    SourceDiscoveryLimit::Entries => "- Examined entries (--max-entries)",
                    SourceDiscoveryLimit::Depth => "- Folder depth (--max-depth)",
                    SourceDiscoveryLimit::FileSize => "- File size (--max-file-bytes)",
                    SourceDiscoveryLimit::HashBytes => "- Hashing budget (--max-hash-bytes)",
                    SourceDiscoveryLimit::Candidates => "- Matching candidates (--max-candidates)",
                }
                .into(),
            );
        }
        lines.push("A new search starts again; this search cannot be resumed.".into());
    }
    if !report.issues.is_empty() || report.issues_omitted > 0 {
        lines.push(format!(
            "Scan issues: {} shown, {} omitted. Review these before drawing conclusions about missing files.",
            report.issues.len(), report.issues_omitted
        ));
        for issue in &report.issues {
            let location = issue.path.as_ref().map_or_else(
                || "Location not recorded".into(),
                |path| clean(&path.display().to_string()),
            );
            let profile = issue
                .profile_id
                .as_deref()
                .map_or_else(String::new, |id| format!(" [{}]", profile_name(id)));
            lines.push(format!(
                "- {location}{profile}: {}",
                clean(&portcove_core::redact_diagnostic_text(&issue.message))
            ));
        }
    }
    if report.candidates.is_empty() {
        lines.push("No matching candidates were found in the inspected scope.".into());
    } else {
        lines.push(format!("Matching candidates: {}", report.candidates.len()));
        for candidate in &report.candidates {
            lines.extend([
                format!("Candidate: {}", profile_name(&candidate.profile_id)),
                format!("Path: {}", clean(&candidate.path.display().to_string())),
                format!("Content SHA-256: {}", clean(&candidate.sha256)),
                format!(
                    "Content size: {} ({} bytes)",
                    format_bytes(candidate.size),
                    candidate.size
                ),
                format!("Stored file SHA-256: {}", clean(&candidate.storage_sha256)),
                format!(
                    "Stored file size: {} ({} bytes)",
                    format_bytes(candidate.storage_size),
                    candidate.storage_size
                ),
                format!("Observed (UTC): {}", utc_time(candidate.updated_at)),
            ]);
        }
    }
    if !report.preliminary_selections.is_empty() {
        lines.push(format!(
            "Preliminary selections: {}. These are not exact matches; validation has not run.",
            report.preliminary_selections.len()
        ));
        for selection in &report.preliminary_selections {
            lines.extend([
                format!(
                    "Preliminary selection: {}",
                    profile_name(&selection.profile_id)
                ),
                format!("Path: {}", clean(&selection.path.display().to_string())),
                format!("Selection details: {}", clean(&selection.message)),
            ]);
        }
        lines.push("Next step: Review a chosen preliminary selection without registration using source inbox import PROFILE_ID PATH --mode use-current-location. Apply only its returned review plan if you want to save that location; source inspect PROFILE_ID reads an already registered location. Preliminary selection does not prove compatibility or run the port's validator.".into());
    }
    lines.push(
        "No sources were registered by this search. Discovery does not install or launch games."
            .into(),
    );
    if !report.candidates.is_empty() {
        lines.push("To register a chosen candidate, use source add PROFILE_ID PATH --expected-sha256 SHA256. Registration checks the current bytes again.".into());
    }
    lines.join("\n")
}

pub(crate) fn game_file_roots(roots: &[GameFileRoot]) -> String {
    if roots.is_empty() {
        return "No game-file folders are connected.".into();
    }
    let rows = roots
        .iter()
        .map(|root| {
            vec![
                root.id.clone(),
                match root.availability {
                    portcove_core::GameFileRootAvailability::Available => "Available",
                    portcove_core::GameFileRootAvailability::Unavailable => "Unavailable",
                }
                .into(),
                root.path.display().to_string(),
            ]
        })
        .collect();
    format!(
        "Game-file folders ({})\n{}",
        roots.len(),
        table(&["ID", "STATE", "PATH"], rows)
    )
}

pub(crate) fn game_file_scan_snapshot(snapshot: &Option<GameFileScanSnapshot>) -> String {
    let Some(snapshot) = snapshot else {
        return "No completed game-file folder scan is available.".into();
    };
    game_file_scan(snapshot)
}

pub(crate) fn game_file_scan(snapshot: &GameFileScanSnapshot) -> String {
    let mut output = format!(
        "Game-file folder scan\nFreshness: {}\nCompleted: {}\nFolders: {}\nCandidates: {}\nEntries examined: {}\nFiles hashed: {}",
        match snapshot.freshness {
            portcove_core::GameFileScanFreshness::InputsMatch => "Recorded inputs match",
            portcove_core::GameFileScanFreshness::InputsChanged => "Recorded inputs changed",
        },
        utc_time(snapshot.completed_at),
        snapshot.roots.len(),
        snapshot.report.candidates.len(),
        snapshot.report.entries_examined,
        snapshot.report.files_hashed,
    );
    output.push_str(match snapshot.freshness {
        portcove_core::GameFileScanFreshness::InputsMatch => {
            "\nRecorded inputs match; file contents were not revalidated by this readback."
        }
        portcove_core::GameFileScanFreshness::InputsChanged => {
            "\nRecorded inputs changed; run source roots scan to refresh the evidence."
        }
    });
    if let Some(limits) = &snapshot.limits {
        output.push_str(&format!(
            "\nRecorded scan limits: entries={}, depth={}, file bytes={}, hash bytes={}, candidates={}.",
            limits.max_entries, limits.max_depth, limits.max_file_bytes,
            limits.max_hash_bytes, limits.max_candidates,
        ));
    } else {
        output.push_str("\nRecorded scan limits: not recorded.");
    }
    if let Some(coverage) = &snapshot.coverage {
        output.push_str(&format!(
            "\nScan batches: {}; this batch examined {} entries, re-listed {} entries, and made {} metadata checks.\nPrior-batch file-set members rehashed: {}.\nPending directories: {}. Remaining entries: {}.",
            coverage.batches, coverage.batch_entries_examined, coverage.entries_relisted,
            coverage.metadata_checks, coverage.prior_member_rechecks, coverage.pending_directories,
            coverage.remaining_entries.map_or_else(|| "unknown".into(), |count| count.to_string()),
        ));
        output.push_str(if coverage.restart_required {
            "\nContinuation was refused. Repeat source roots scan to start fresh."
        } else if coverage.can_resume {
            "\nRepeat source roots scan with the same limits to resume the saved checkpoint."
        } else if coverage.frontier_exhausted {
            "\nRecorded directory frontier exhausted; limits and issues may still leave coverage incomplete."
        } else {
            "\nScan stopped at a terminal safety limit; a new scan starts fresh."
        });
    } else {
        output.push_str("\nContinuation coverage: not recorded; a new scan starts fresh.");
    }
    if snapshot.report.limits_reached.is_empty() {
        output.push_str("\nNo recorded scan limits reached.");
    } else {
        use portcove_core::SourceDiscoveryLimit;
        let limits = snapshot
            .report
            .limits_reached
            .iter()
            .map(|limit| match limit {
                SourceDiscoveryLimit::Entries => "entries",
                SourceDiscoveryLimit::Depth => "depth",
                SourceDiscoveryLimit::FileSize => "file size",
                SourceDiscoveryLimit::HashBytes => "hash bytes",
                SourceDiscoveryLimit::Candidates => "candidates",
            })
            .collect::<Vec<_>>()
            .join(", ");
        output.push_str(&format!(
            "\nScan limits reached: {limits}; results may be incomplete."
        ));
    }
    output.push_str(&format!(
        "\nScan issues: {} recorded, {} additional omitted.",
        snapshot.report.issues.len(),
        snapshot.report.issues_omitted,
    ));
    let unavailable = snapshot
        .roots
        .iter()
        .filter(|root| root.availability == portcove_core::GameFileRootAvailability::Unavailable)
        .count();
    output.push_str(&format!("\nUnavailable folders at scan: {unavailable}."));
    if unavailable > 0 {
        output.push_str("\nAn unavailable folder does not mean its files were deleted.");
    }
    if !snapshot.report.limits_reached.is_empty()
        || !snapshot.report.issues.is_empty()
        || snapshot.report.issues_omitted > 0
    {
        output.push_str("\nUse --json source roots snapshot for recorded scan details.");
    }
    output
}

pub(crate) fn source_inspection(report: &SourceInspectionReport) -> String {
    let mut lines = vec![
        format!(
            "Source inspection: {} ({})",
            report
                .expected_identity
                .as_ref()
                .map(|identity| clean(&identity.label))
                .unwrap_or_else(|| "Game-file profile; label unavailable".into()),
            clean(&report.profile_id)
        ),
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
                "- {} of {}: {} ({}; {} bytes)",
                digest_algorithm(digest.algorithm),
                digest_scope(digest.scope),
                clean(&digest.value),
                format_bytes(digest.size),
                digest.size
            ));
        }
        for component in &inspection.components {
            lines.push(format!(
                "- Required component: {} ({})",
                component
                    .name
                    .as_deref()
                    .map(clean)
                    .unwrap_or_else(|| "Name unavailable".into()),
                clean(&component.id),
            ));
            for digest in &component.digests {
                lines.push(format!(
                    "  {} of {}: {} ({}; {} bytes)",
                    digest_algorithm(digest.algorithm),
                    digest_scope(digest.scope),
                    clean(&digest.value),
                    format_bytes(digest.size),
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
    lines.push(format!("Next step: {}", clean(&report.next_action)));
    lines.join("\n")
}

fn digest_algorithm(algorithm: portcove_core::SourceDigestAlgorithm) -> &'static str {
    match algorithm {
        portcove_core::SourceDigestAlgorithm::Sha1 => "SHA-1",
        portcove_core::SourceDigestAlgorithm::Sha256 => "SHA-256",
        portcove_core::SourceDigestAlgorithm::Crc32 => "CRC32",
    }
}

fn digest_scope(scope: portcove_core::DigestScope) -> &'static str {
    use portcove_core::DigestScope;
    match scope {
        DigestScope::OriginalFile => "original file",
        DigestScope::OriginalContainer => "original container",
        DigestScope::NormalizedContent => "normalized content",
        DigestScope::CanonicalN64BigEndian => "normalized N64 content",
        DigestScope::ArchiveMember => "archive member",
        DigestScope::GamecubeNormalizedIso => "normalized GameCube disc",
        DigestScope::PsxNormalizedTrackSet => "normalized PlayStation track set",
        DigestScope::FileSetMember => "file-set member",
        DigestScope::DiscSetMember => "disc-set member",
    }
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

pub(crate) fn status(status: &PortStatus, catalog: &portcove_core::Catalog) -> String {
    statuses(std::slice::from_ref(status), catalog)
}

pub(crate) fn statuses(statuses: &[PortStatus], catalog: &portcove_core::Catalog) -> String {
    if statuses.is_empty() {
        return "The active catalog contains no ports.".into();
    }
    let rows = statuses
        .iter()
        .map(|status| {
            vec![
                port_name(catalog, &status.port_id),
                release_channel(status.channel).into(),
                update_policy_name(status.update_policy).into(),
                status
                    .active
                    .as_ref()
                    .map_or_else(|| "-".into(), |install| install.version.clone()),
                status
                    .staged
                    .as_ref()
                    .map_or_else(|| "-".into(), |install| install.version.clone()),
                status
                    .external_runtime
                    .as_ref()
                    .map_or_else(|| "-".into(), |runtime| runtime.version.clone()),
                readiness(status),
            ]
        })
        .collect();
    let summary = format!(
        "Status ({})\n{}",
        statuses.len(),
        table(
            &[
                "PORT",
                "CHANNEL",
                "POLICY",
                "ACTIVE",
                "STAGED",
                "EXTERNAL (USER-OWNED)",
                "READINESS",
            ],
            rows,
        )
    );
    let actions = statuses
        .iter()
        .filter(|status| !status.port_actions.is_empty())
        .map(|status| {
            format!(
                "{}:\n{}",
                port_name(catalog, &status.port_id),
                status
                    .port_actions
                    .iter()
                    .map(status_action)
                    .collect::<Vec<_>>()
                    .join("\n")
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    let mut output = if actions.is_empty() {
        summary
    } else {
        format!("{summary}\nActions:\n{actions}")
    };
    for status in statuses {
        if let Some(readiness) = &status.readiness {
            if readiness.blockers.contains(&LaunchBlocker::MissingRuntime) {
                output.push_str(&format!("\nNext step for {}: Using the same library, run portcove update {} to acquire the required catalog runtime. Core checks current eligibility before applying it.", port_name(catalog, &status.port_id), clean(&status.port_id)));
            }
            if readiness
                .blockers
                .contains(&LaunchBlocker::InvalidInstallation)
            {
                output.push_str(&format!("\nNext step for {}: Using the same library, run portcove verify {} and preserve local files before reviewing replacement or recovery.", port_name(catalog, &status.port_id), clean(&status.port_id)));
            }
        }
    }
    output
}

pub(crate) fn definition_reason(
    reason: portcove_core::DefinitionEligibilityReason,
) -> &'static str {
    use portcove_core::DefinitionEligibilityReason as Definition;
    match reason {
        Definition::MandatoryChecksPassed => "Required definition checks passed.",
        Definition::PublisherRevoked => "The definition publisher's authority was revoked.",
        Definition::CuratedArtifactRevoked => {
            "This exact release file was revoked; installed files and saves are retained."
        }
        Definition::CuratedDistributionWithdrawn => {
            "Distribution of this release file was withdrawn; permitted installed use remains available."
        }
        Definition::UnknownSafetySemantics => {
            "This client cannot interpret the definition's safety requirements."
        }
        Definition::PublisherScopeRequired => {
            "The definition requires accepted publisher authority."
        }
        Definition::EngineCapabilityRequired => "This client lacks a required engine capability.",
        Definition::OwnershipMigrationRequired => {
            "The definition requires a reviewed ownership migration."
        }
        Definition::MetadataReplay => "The accepted catalog metadata was replayed.",
        Definition::RefreshIncomplete => "The catalog refresh is incomplete.",
        Definition::MetadataStale => "The accepted catalog metadata is stale.",
        Definition::RecordedIdentityChanged => "Bytes changed under a recorded release identity.",
        Definition::AuthenticatedIntegrityRequired => {
            "The release needs accepted authenticated integrity evidence."
        }
        Definition::LocalIntegrityFailed => "Local release integrity verification failed.",
        Definition::MandatoryCheckFailed => "A required definition check failed.",
        Definition::SourceIdentityMismatch => {
            "Required source files do not match the accepted identity."
        }
        Definition::RequiredSourceMissing => "Required source files are missing.",
    }
}

fn status_action(assessment: &portcove_core::PortActionAssessment) -> String {
    use portcove_core::{PortAction, PortActionReason};

    let value = serde_json::to_value(assessment).unwrap_or_default();
    let action_code = value["action"].as_str().unwrap_or("unknown");
    let action = match assessment.action {
        PortAction::Install => "Install",
        PortAction::RegisterExternal => "Register existing installation",
        PortAction::Launch => "Launch",
        PortAction::RemoveManaged => "Remove managed versions",
        PortAction::RemoveExternal => "Remove existing installation registration",
        PortAction::Rollback => "Restore previous release",
        PortAction::BackupCreate => "Create backup",
        PortAction::BackupRestore => "Restore backup",
        PortAction::Update => "Update",
    };
    let availability = match assessment.availability {
        portcove_core::PortActionAvailability::NotOffered => "not offered",
        portcove_core::PortActionAvailability::Waiting => "waiting for review",
        portcove_core::PortActionAvailability::Held => "held",
        portcove_core::PortActionAvailability::Allowed => "allowed",
    };
    let reason = value["definition"]["reason"]
        .as_str()
        .or_else(|| value["reason"].as_str())
        .unwrap_or("unknown");
    let explanation = if let Some(definition) = assessment.definition {
        definition_reason(definition.reason)
    } else {
        match assessment.reason {
            PortActionReason::Available => {
                "No current blocker; execution checks current inputs again."
            }
            PortActionReason::RouteNotOffered => {
                "This operation is not offered for this port's route."
            }
            PortActionReason::AlreadyRegistered if assessment.action == PortAction::Update => {
                "This exact verified release is already active; no update action is offered."
            }
            PortActionReason::AlreadyRegistered => {
                "An installation or external runtime is already registered."
            }
            PortActionReason::UnsupportedPlatform => {
                "This operation is not offered on this platform."
            }
            PortActionReason::NotInstalled => match assessment.action {
                PortAction::Rollback => "No previous managed version is retained for rollback.",
                PortAction::RemoveManaged => "No managed installation is registered.",
                PortAction::RemoveExternal => "No external runtime is registered.",
                PortAction::Update => "Install a managed release before reviewing its update.",
                _ => "Install or register the port before launching.",
            },
            PortActionReason::ReviewRequired => match assessment.action {
                PortAction::Update => {
                    "Review the current update candidate; saved policy is not consent."
                }
                PortAction::RegisterExternal => {
                    "Review the prepared folder with external preview before registration."
                }
                PortAction::RemoveExternal => {
                    "Review registration removal; external files are kept."
                }
                PortAction::RemoveManaged => {
                    "Review managed removal with remove-preview; saved data is kept."
                }
                _ => "Review and confirm this operation before proceeding.",
            },
            PortActionReason::IncompatibleSource => {
                "Select and validate the uncompressed original representation required by this runtime."
            }
            PortActionReason::MissingData => {
                "No owned saves or settings are currently available to back up."
            }
            PortActionReason::MissingBackup => {
                "No usable backup is currently available to review for restore."
            }
            PortActionReason::UnreadableData => {
                "Saved data could not be read; check its location before retrying."
            }
            PortActionReason::AssessmentIncomplete => {
                "The bounded preview is incomplete; no empty-data conclusion or new backup execution limit is established."
            }
            PortActionReason::UnsafeData => {
                "The saved-data location needs a safety check before this action."
            }
            PortActionReason::RecoveryRequired => {
                "Restart Portcove to retry recovery; review doctor output if it remains."
            }
            PortActionReason::MissingSource => "Add the required game files with source add.",
            PortActionReason::UnreadableSource => {
                "The registered game-file location cannot be read."
            }
            PortActionReason::ChangedSource => {
                "The registered game files changed; check their saved location and identity."
            }
            PortActionReason::MissingBios => "Add the required BIOS with source add.",
            PortActionReason::UnreadableBios => "The registered BIOS location cannot be read.",
            PortActionReason::ChangedBios => {
                "The registered BIOS changed; check its saved location and identity."
            }
            PortActionReason::IncompatibleBios => {
                "This BIOS edition is not supported by the installed release; choose a supported BIOS with source add."
            }
            PortActionReason::MissingRuntime if assessment.action == PortAction::Rollback => {
                "The previous version needs its verified runtime before it can be restored."
            }
            PortActionReason::MissingRuntime => "The required verified runtime is unavailable.",
            PortActionReason::PreparationRequired => {
                "Prepare the required game data before launching."
            }
            PortActionReason::InvalidInstallation if assessment.action == PortAction::Rollback => {
                "Portcove could not verify the previous version; rollback is on hold."
            }
            PortActionReason::SharedPreferencesReviewRequired => {
                "Windows account or shared preferences location changed. Remove managed versions with remove-preview and remove, keeping saved data; review a fresh installation. Leave the shared file unchanged."
            }
            PortActionReason::SharedPreferencesUnavailable => {
                "Shared preferences cannot be checked safely. Leave the file unchanged, close other game copies, check Windows profile availability and retry. Reinstalling does not repair an unsafe or unreadable shared location."
            }
            PortActionReason::InvalidInstallation => {
                "The installation or external runtime needs verification or repair."
            }
            PortActionReason::DefinitionIneligible => {
                "The accepted definition does not currently allow this operation."
            }
        }
    };
    format!("  {action} [{action_code}]: {availability} ({reason}): {explanation}")
}

#[cfg(feature = "qualification-fixtures")]
pub(crate) fn game_update_plan(
    review: &portcove_core::GameUpdatePlan,
    catalog: &portcove_core::Catalog,
) -> String {
    format!(
        "{}\nUpdate decision:\n{}",
        plan(&review.plan, catalog),
        status_action(&review.assessment)
    )
}

pub(crate) fn activities(
    feed: &portcove_core::ActivityFeed,
    catalog: &portcove_core::Catalog,
    technical: bool,
) -> String {
    let records = &feed.records;
    if records.is_empty() {
        return "No activity records.".into();
    }
    let entries = records
        .iter()
        .map(|record| activity(record, catalog, technical))
        .collect::<Vec<_>>();
    let terminal_history = if feed.terminal_history_complete {
        format!("all {} terminal records", feed.terminal_history_count)
    } else {
        format!(
            "latest {} terminal records (history is truncated)",
            feed.terminal_history_count
        )
    };
    format!(
        "Recent activity ({})\nCurrent and actionable coverage: {}. Terminal history: {terminal_history}.\n\n{}",
        records.len(),
        if feed.active_and_actionable_complete {
            "complete"
        } else {
            "incomplete"
        },
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
            ActivityTargetKind::Port => catalog.port(id).ok().map(|_| port_name(catalog, id)),
            ActivityTargetKind::Source => catalog
                .source_profile(id)
                .ok()
                .map(|_| profile_name(catalog, id)),
            ActivityTargetKind::Library => None,
        });
    let mut output = format!(
        "Activity: {}\nStatus: {}\nOperation: {}\nTarget: {}\nStarted (UTC): {}",
        clean(&record.id),
        match record.status {
            ActivityStatus::Running => "Running",
            ActivityStatus::Succeeded => "Succeeded",
            ActivityStatus::Failed => "Failed",
            ActivityStatus::Cancelled => "Cancelled",
        },
        operation_name(record.operation),
        target.as_deref().unwrap_or(match record.target_kind {
            ActivityTargetKind::Port => "port (not in current catalog)",
            ActivityTargetKind::Source => "source (not in current catalog)",
            ActivityTargetKind::Library => "library",
        }),
        utc_time(record.started_at),
    );
    if let Some(finished_at) = record.finished_at {
        output.push_str(&format!("\nFinished (UTC): {}", utc_time(finished_at)));
    }
    if let Some(cancellation) = &record.cancellation {
        output.push_str(&format!(
            "\nCancellation requested: {}\nCurrent phase: {}",
            if cancellation.requested { "Yes" } else { "No" },
            match cancellation.phase {
                portcove_core::CancellationPhase::Preparing => "Preparing",
                portcove_core::CancellationPhase::Finishing => "Finishing publication",
            }
        ));
    }
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
    if technical && let Some(id) = &record.target_id {
        output.push_str("\nRecorded target (redacted): ");
        output.push_str(&clean(&redact_diagnostic_text(id)));
    }
    output.push_str(&format!(
        "\nRetained logs: portcove activity log {}",
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

pub(crate) fn doctor(report: &DoctorReport, catalog: &portcove_core::Catalog) -> String {
    let tool_rows = report
        .host_tools
        .iter()
        .map(|tool| {
            vec![
                format!("{} ({})", clean(&tool.display_name), clean(&tool.id)),
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
        "Repair review: no repairs needed.".into()
    } else {
        let rows = report
            .repair
            .items
            .iter()
            .map(|item| {
                vec![
                    repair_kind(item.kind).into(),
                    item.port_id
                        .as_deref()
                        .map(|id| port_name(catalog, id))
                        .unwrap_or_else(|| "Library".into()),
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
                format!("{} ({})", clean(&tool.display_name), clean(&tool.id)),
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
        table(&["TOOL", "STATUS", "SOURCE", "PATH", "OFFICIAL SITE"], rows)
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

pub(crate) fn game_install_plan(
    review: &portcove_core::GameInstallPlan,
    catalog: &portcove_core::Catalog,
) -> String {
    let mut text = plan(&review.plan, catalog);
    if let Some(selected) = &review.selected_install {
        text.push_str(&format!(
            "\nExisting copy to activate: {}\nExisting copy version: {}\nExisting copy channel: {}\nNo artifact download.\n",
            clean(&selected.path.display().to_string()), clean(&selected.version), release_channel(selected.channel),
        ));
    }
    text.push_str(&format!(
        "\nReviewed plan SHA-256: {}\n",
        clean(&review.plan_sha256)
    ));
    text
}

pub(crate) fn plan(plan: &InstallPlan, catalog: &portcove_core::Catalog) -> String {
    let requirements = if plan.source_requirements.is_empty() {
        "none".into()
    } else {
        plan.source_requirements
            .iter()
            .map(|requirement| {
                format!(
                    "{} ({}) — {}, {}",
                    clean(&requirement.label),
                    clean(&requirement.profile_id),
                    match requirement.role {
                        SourceRequirementRole::GameSource => "required game files",
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
                "{} ({}; SHA-256 {})",
                clean(&runtime.asset.name),
                format_bytes(runtime.asset.size),
                clean(&runtime.asset.sha256),
            )
        },
    );
    let temporary_space = plan.temporary_space.as_ref().map_or_else(
        || "checked at installation when acquisition is needed".to_owned(),
        |space| {
            format!(
                "{} at {} (available: {}; execution rechecks)",
                format_bytes(space.required_bytes),
                clean(&space.path.display().to_string()),
                space
                    .available_bytes
                    .map_or_else(|| "unknown".to_owned(), format_bytes)
            )
        },
    );
    let auxiliary = plan
        .auxiliary_downloads
        .iter()
        .map(|asset| {
            format!(
                "{} ({}; SHA-256 {})",
                clean(&asset.name),
                format_bytes(asset.size),
                clean(&asset.sha256)
            )
        })
        .collect::<Vec<_>>()
        .join("; ");
    format!(
        "Install plan for {}\nAction: {}\nChannel: {}\nPlatform: {}\nRelease: {}\nAsset: {} ({})\nRelease SHA-256: {}\nRequired runtime component: {}\nRequired build components: {}\nTotal cold download (cache reuse may reduce): {}\nTemporary free space: {}\nFinal installed size: unknown\nRequired game files and BIOS: {}\nOutput folder: {} ({})\nAvailable library storage: {}{}",
        port_name(catalog, &plan.port_id),
        install_action(plan.action),
        release_channel(plan.channel),
        platform_name(plan.platform),
        clean(&plan.release.version),
        clean(&plan.release.asset.name),
        format_bytes(plan.release.asset.size),
        clean(&plan.release.asset.sha256),
        runtime,
        if auxiliary.is_empty() {
            "none"
        } else {
            &auxiliary
        },
        format_bytes(plan.download_bytes),
        temporary_space,
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
        plan.preservation_notices
            .iter()
            .map(|notice| format!("\n{}", clean(notice)))
            .collect::<String>() + &plan.shared_preferences.as_ref().map(|scope| format!("\n{}\nExplicit acceptance is required. For first installation, use installation run with --acknowledge-shared-preferences and the reviewed plan SHA-256. Desktop reviewed updates ask separately. --yes alone does not accept this scope.", clean(&scope.write_scope_disclosure()))).unwrap_or_default(),
    )
}

pub(crate) fn ghostship_recovery_plan(plan: &portcove_core::GhostshipRecoveryPlan) -> String {
    format!(
        "Ghostship legacy recovery review\nSelected qualified backup: {}\nSnapshot folder: {}\nRetained 2.0.0 installation: {}\nCurrent 3.0.0 installation: {}\nOriginal: {}\nRequired free space: {} ({} bytes)\nPlan SHA-256: {}\nChanges: activate a fresh derivative of the retained 2.0.0 installation and replace canonical data with this qualified legacy snapshot.\nPreserved: both existing installations, the selected backup, other staged installations, and independent safety copies of current canonical data and newer-runtime persistent data.\nThe runtime safety copy is retained alongside the canonical safety backup; ordinary restore uses only its canonical data. Deleting that backup also deletes its runtime safety copy.\nPlanning does not launch a game or prove gameplay/save-load compatibility.",
        clean(&plan.backup.id),
        clean(&plan.backup.path.display().to_string()),
        clean(&plan.legacy_install.path.display().to_string()),
        clean(&plan.active_install.path.display().to_string()),
        clean(&plan.source.path.display().to_string()),
        format_bytes(plan.required_bytes),
        plan.required_bytes,
        clean(&plan.plan_sha256),
    )
}

pub(crate) fn preparation_plan(
    plan: &portcove_core::PreparationPlan,
    catalog: &portcove_core::Catalog,
) -> String {
    format!(
        "Preparation: {}\nInstalled version: {}\nRequired game files: {}\nSource assessment: {}\nSetup tool: {}\nReviewed copy: {} ({} bytes)\nPlan SHA-256: {}\nPlanning starts no setup process and does not change launch readiness.",
        port_name(catalog, &plan.port_id),
        clean(&plan.inputs.install.version),
        clean(&plan.inputs.source.path.display().to_string()),
        clean(&plan.inputs.source_inspection.summary),
        plan.inputs
            .setup_tool
            .as_ref()
            .map(|tool| clean(&tool.path.display().to_string()))
            .unwrap_or_else(|| "None (source materialization only)".into()),
        format_bytes(plan.copy.total_bytes),
        plan.copy.total_bytes,
        clean(&plan.plan_sha256),
    )
}

pub(crate) fn preparation_cleanup(
    preview: &portcove_core::PreparationCleanupPreview,
    catalog: &portcove_core::Catalog,
) -> String {
    let mut entries = preview
        .retained
        .files
        .iter()
        .map(|file| {
            format!(
                "File: {} ({}; {} bytes, SHA-256 {})",
                clean(&file.relative_path.display().to_string()),
                format_bytes(file.size),
                file.size,
                clean(&file.sha256),
            )
        })
        .collect::<Vec<_>>();
    entries.extend(
        preview
            .retained
            .directories
            .iter()
            .map(|directory| format!("Folder: {}", clean(&directory.display().to_string()))),
    );
    entries.extend(preview.retained.skipped_entries.iter().map(|entry| {
        format!(
            "Skipped link or special entry: {} ({})",
            clean(&entry.relative_path.display().to_string()),
            clean(&entry.reason),
        )
    }));
    if entries.is_empty() {
        entries.push("The retained private folder is empty.".into());
    }
    format!(
        "Preparation cleanup: {}\nGame: {}\nRetained private folder: {}\nAffected: {} files, {} folders, {} skipped links or special entries, {}\nAffected entries:\n{}\nPreserved original installation: {}\nPreserved registered source: {}\nPreserved saved data: {}\nPreserved backups: {}\nPreserved logs: {}\nReversibility: removed private files cannot be recovered\nInterruption: an accepted cleanup remains recorded and will be retried\nPreview: {}",
        clean(&preview.operation_id),
        port_name(catalog, &preview.port_id),
        clean(&preview.retained_path.display().to_string()),
        preview.retained.files.len(),
        preview.retained.directories.len(),
        preview.retained.skipped_entries.len(),
        format_bytes(preview.retained.total_bytes),
        entries.join("\n"),
        clean(&preview.original_install_path.display().to_string()),
        clean(&preview.source_path.display().to_string()),
        clean(&preview.persistent_data_path.display().to_string()),
        clean(&preview.backup_path.display().to_string()),
        clean(&preview.logs_path.display().to_string()),
        clean(&preview.preview_sha256),
    )
}

pub(crate) fn paths(paths: &PortPaths, catalog: &portcove_core::Catalog) -> String {
    format!(
        "Paths for {}\nLibrary: {}\nSaves and settings: {}\nFuture install folder: {} ({})\nActive: {}\nPrevious: {}\nDownloaded for later: {}",
        port_name(catalog, &paths.port_id),
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

pub(crate) fn output_location(
    location: &PortOutputLocation,
    catalog: &portcove_core::Catalog,
) -> String {
    format!(
        "Install folder for {}\nEffective: {} ({})\nSaved custom folder: {}\nLibrary default: {}\nExisting installs are not moved when this setting changes.",
        port_name(catalog, &location.port_id),
        clean(&location.effective_output_directory.display().to_string()),
        output_location_source(location.selection_source),
        optional_path(location.configured_output_directory.as_deref()),
        clean(&location.default_output_directory.display().to_string()),
    )
}

pub(crate) fn output_preview(
    preview: &OutputDestinationPreview,
    catalog: &portcove_core::Catalog,
) -> String {
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
        "Install folder preview for {}\nProposed: {}\nAvailability: {}\nOwnership: {}\nCapacity: {}\nExisting installs: {}\nEffect: future placement only; existing installs will not move\nValidation: {}\nPreview fingerprint: {}",
        port_name(catalog, &preview.port_id),
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

pub(crate) fn output_relocation_plan(
    plan: &OutputRelocationPlan,
    catalog: &portcove_core::Catalog,
) -> String {
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
        port_name(catalog, &plan.port_id),
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
        "{} {} capabilities\nSchema: {}\nOperation event schema: {}\nPlatforms: {}\nMachine formats: {}\nRaw streams: {}\nFailure-isolated batches: {}\nPort locking: {}",
        clean(&capabilities.product),
        clean(&capabilities.product_version),
        capabilities.schema_version,
        capabilities.operation_event_schema_version,
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
                    output.push_str(&format!(
                        "{padding}{}: {}\n",
                        human_key(key),
                        field_scalar(key, value)
                    ));
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

pub(crate) fn release_channel(channel: ReleaseChannel) -> &'static str {
    match channel {
        ReleaseChannel::Stable => "Stable",
        ReleaseChannel::Beta => "Preview",
        ReleaseChannel::Rolling => "Rolling",
    }
}

fn field_scalar(key: &str, value: &Value) -> String {
    if key == "channel"
        && let Some(channel) = value
            .as_str()
            .and_then(|value| value.parse::<ReleaseChannel>().ok())
    {
        return release_channel(channel).into();
    }
    if matches!(
        key,
        "created_at"
            | "updated_at"
            | "started_at"
            | "finished_at"
            | "resets_at"
            | "expires_at"
            | "issued_at"
            | "registered_at"
            | "verified_at"
            | "completed_at"
            | "exported_at"
    ) && let Value::Number(number) = value
    {
        if let Some(seconds) = number.as_i64() {
            return utc_time(seconds);
        }
        if let Some(seconds) = number.as_u64() {
            return utc_rate_reset(seconds);
        }
    }
    scalar(value)
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

pub(crate) fn clean(value: &str) -> String {
    value
        .chars()
        .filter_map(|character| match character {
            '\r' | '\n' | '\t' => Some(' '),
            character if character.is_control() => None,
            character => Some(character),
        })
        .collect::<String>()
}

pub(crate) fn port_name(catalog: &portcove_core::Catalog, id: &str) -> String {
    catalog.listing(id).map_or_else(
        |_| format!("Port ({}; name unavailable)", clean(id)),
        |port| format!("{} ({})", clean(&port.name), clean(id)),
    )
}

pub(crate) fn profile_name(catalog: &portcove_core::Catalog, id: &str) -> String {
    catalog.source_profile(id).map_or_else(
        |_| format!("Game-file profile ({}; label unavailable)", clean(id)),
        |profile| format!("{} ({})", clean(&profile.label), clean(id)),
    )
}

pub(crate) fn operation_name(operation: portcove_core::ActivityOperation) -> &'static str {
    use portcove_core::ActivityOperation as Operation;
    match operation {
        Operation::Prepare => "Prepare game data",
        Operation::UpdateCatalog => "Update catalog",
        Operation::DiscoverSources => "Find game files",
        Operation::ImportSource => "Import game files",
        Operation::ImportLibrary => "Restore library",
        Operation::MoveLibrary => "Move library",
        Operation::RelocateOutput => "Relocate installed versions",
        Operation::Launch => "Launch game",
        Operation::CheckUpdate => "Check for game updates",
        Operation::Backup => "Back up saves and settings",
        Operation::Restore => "Restore saves and settings",
        Operation::DeleteBackup => "Delete backup",
        Operation::Install => "Install game port",
        Operation::DownloadPackage => "Download upstream package",
        Operation::Update => "Update game port",
        Operation::Reconcile => "Apply game update policy",
        Operation::VerifyInstall => "Check installed files",
        Operation::Activate => "Apply downloaded update",
        Operation::Rollback => "Restore previous version",
        Operation::Adopt => "Copy existing installation",
        Operation::Remove => "Remove managed versions",
        Operation::RemoveSource => "Remove saved game-file location",
        Operation::RegisterExternal => "Register existing installation",
        Operation::RelinkExternal => "Change existing installation location",
        Operation::RemoveExternal => "Remove existing installation registration",
        Operation::RegisterSource => "Save game-file location",
        Operation::VerifySource => "Check saved game files",
    }
}

pub(crate) fn operation_event_name(operation: &str) -> &'static str {
    operation
        .parse::<portcove_core::ActivityOperation>()
        .map_or("Other operation", operation_name)
}

pub(crate) fn update_policy_name(policy: portcove_core::UpdatePolicy) -> &'static str {
    match policy {
        portcove_core::UpdatePolicy::Notify => "Notify about updates",
        portcove_core::UpdatePolicy::Stage => "Download and check without activation",
        portcove_core::UpdatePolicy::Automatic => "Apply updates automatically",
    }
}

pub(crate) fn format_bytes(bytes: u64) -> String {
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
            "Ready to launch; setup runs during launch"
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
        return format!(
            "Definition restriction: {}",
            definition_reason(assessment.eligibility.reason)
        );
    }
    let blockers = readiness
        .blockers
        .iter()
        .map(|blocker| match blocker {
            LaunchBlocker::MissingSource => "Required game files are missing",
            LaunchBlocker::UnreadableSource => "Required game files cannot be read",
            LaunchBlocker::ChangedSource => "Required game files changed",
            LaunchBlocker::IncompatibleSource => "incompatible source representation",
            LaunchBlocker::MissingBios => "missing BIOS",
            LaunchBlocker::UnreadableBios => "unreadable BIOS",
            LaunchBlocker::ChangedBios => "changed BIOS",
            LaunchBlocker::IncompatibleBios => "unsupported BIOS edition",
            LaunchBlocker::MissingRuntime => "Update required before playing",
            LaunchBlocker::PreparationRequired => "needs game data preparation",
            LaunchBlocker::SharedPreferencesReviewRequired => "needs a fresh shared preferences review after preserving local data and removing managed versions",
            LaunchBlocker::SharedPreferencesUnavailable => "shared preferences cannot be checked safely; leave them unchanged and inspect Windows profile access",
            LaunchBlocker::InvalidInstallation => "Blocked by a local installation that does not match the expected files",
        })
        .collect::<Vec<_>>()
        .join(", ");
    match readiness.required_source_extension.as_deref() {
        Some(extension) => format!("{blockers}; requires uncompressed .{extension} original file"),
        None => blockers,
    }
}

fn support_tier(tier: SupportTier) -> &'static str {
    match tier {
        SupportTier::Stable => "stable",
        SupportTier::Beta => "beta",
        SupportTier::Rolling => "rolling",
    }
}

fn installation_method(method: portcove_core::InstallationMethod) -> &'static str {
    match method {
        portcove_core::InstallationMethod::PortablePackage => "portable upstream package",
        portcove_core::InstallationMethod::PortableRecompilation => "portable native recompilation",
        portcove_core::InstallationMethod::StagedGameFiles => "prepared game files beside the port",
        portcove_core::InstallationMethod::ReferencedDisc => "original disc referenced at launch",
        portcove_core::InstallationMethod::GeneratedGameData => "generated game data",
        portcove_core::InstallationMethod::UpstreamSetup => "managed upstream setup",
        portcove_core::InstallationMethod::ManagedRecompilation => "managed native recompilation",
        portcove_core::InstallationMethod::UserPreparedRuntime => "user-prepared external runtime",
    }
}

fn source_verification(method: portcove_core::SourceVerificationMethod) -> &'static str {
    match method {
        portcove_core::SourceVerificationMethod::CatalogIdentity => "Known file signatures",
        portcove_core::SourceVerificationMethod::UpstreamValidator => "The port’s validation tool",
        portcove_core::SourceVerificationMethod::CatalogRules => "Required files and format checks",
    }
}

fn upstream_status(status: portcove_core::UpstreamStatus) -> &'static str {
    match status {
        portcove_core::UpstreamStatus::Active => "active",
        portcove_core::UpstreamStatus::Retired => "retired",
        portcove_core::UpstreamStatus::Superseded => "superseded",
        portcove_core::UpstreamStatus::Abandoned => "abandoned",
    }
}

pub(crate) fn platform_name(platform: Platform) -> &'static str {
    match platform {
        Platform::WindowsX86_64 => "Windows (x64)",
        Platform::LinuxX86_64 => "Linux (x64)",
        Platform::MacosX86_64 => "macOS (Intel)",
        Platform::MacosAarch64 => "macOS (Apple silicon)",
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
        RepairItemKind::RetainedPreparation => "retained preparation",
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
        InstallPlanAction::UseStaged => "use downloaded version",
        InstallPlanAction::ReuseRetained => "use previous version",
        InstallPlanAction::BlockedUnverified => {
            "Blocked by a local installation that does not match the expected files"
        }
        InstallPlanAction::Download => "Download the catalog release",
    }
}

fn optional_path(path: Option<&Path>) -> String {
    path.map_or_else(|| "-".into(), |path| clean(&path.display().to_string()))
}

#[cfg(test)]
mod tests {
    #[test]
    fn preparation_failure_guidance_is_read_only_and_keeps_the_originating_library_selection() {
        use portcove_core::{FailureRecoveryTarget, MutationState, PortcoveError, RecoveryAction};
        let mut report = PortcoveError::state("diagnostic")
            .with_mutation_state(MutationState::RecoveryRequired)
            .report();
        report
            .presentation
            .recovery_actions
            .push(RecoveryAction::ReviewPreparation);
        let legacy = super::failure(&report, false);
        assert!(!legacy.contains("portcove status"));
        for (id, expected) in [
            ("opengoal-jak1", true),
            ("", false),
            ("--other", false),
            ("port;touch", false),
            ("port\nother", false),
        ] {
            report.presentation.recovery_target =
                Some(FailureRecoveryTarget::Preparation { port_id: id.into() });
            let before = serde_json::to_value(&report).unwrap();
            let output = super::failure(&report, false);
            assert_eq!(
                output
                    .contains("Using the same library selection (including any --library option)"),
                expected
            );
            assert_eq!(output.contains("portcove status"), expected);
            assert!(!output.contains("portcove prepare"));
            assert_eq!(serde_json::to_value(&report).unwrap(), before);
        }
    }
    #[test]
    fn preview_channel_presentation_preserves_compatibility_and_upstream_names() {
        let value = serde_json::json!({"channel": "beta", "version": "Version1.0.5beta12", "upstream_name": "Beta 12", "application_milestone": "Public beta", "support_tier": "beta"});
        let before = value.clone();
        let rendered = super::document(&value).unwrap();
        assert!(rendered.contains("Channel: Preview"));
        assert!(rendered.contains("Version1.0.5beta12"));
        assert!(rendered.contains("Beta 12"));
        assert!(rendered.contains("Public beta"));
        assert!(rendered.contains("Support tier: beta"));
        assert_eq!(value, before);
        assert_eq!(portcove_core::ReleaseChannel::Beta.to_string(), "beta");
        assert_eq!(
            serde_json::to_value(portcove_core::ReleaseChannel::Beta).unwrap(),
            "beta"
        );
        assert!("preview".parse::<portcove_core::ReleaseChannel>().is_err());
        assert_eq!(
            super::release_channel(portcove_core::ReleaseChannel::Stable),
            "Stable"
        );
        assert_eq!(
            super::release_channel(portcove_core::ReleaseChannel::Rolling),
            "Rolling"
        );
    }

    #[test]
    fn retained_install_review_displays_preview_without_changing_json() {
        let review: portcove_core::GameInstallPlan = serde_json::from_value(serde_json::json!({
            "plan": {
                "port_id": "fixture", "channel": "beta", "platform": "windows-x86-64",
                "release": {"version": "Upstream Beta 12", "channel": "beta", "published_at": null,
                    "asset": {"name": "fixture.zip", "url": "https://example.invalid/fixture.zip", "size": 0, "sha256": "a".repeat(64)}},
                "bundled_runtime": null, "download_bytes": 0, "action": "reuse_retained",
                "source_requirements": [],
                "storage": {"library_root": "owned", "volume_total_bytes": 1024, "volume_available_bytes": 1024},
                "output_location": {"port_id": "fixture", "library_root": "owned", "default_output_directory": "owned/ports",
                    "configured_output_directory": null, "effective_output_directory": "owned/ports",
                    "selection_source": "library_default", "user_data_root": "owned/user"}
            },
            "selected_install": {"id": "retained", "port_id": "fixture", "version": "Upstream Beta 12", "path": "owned/retained",
                "channel": "beta", "installed_at": 0, "verified": true, "staged": false},
            "plan_sha256": "b".repeat(64)
        })).unwrap();
        let before = serde_json::to_value(&review).unwrap();
        let text = super::game_install_plan(&review, &portcove_core::Catalog::embedded().unwrap());
        assert!(text.contains("Channel: Preview"));
        assert!(text.contains("Existing copy channel: Preview"));
        assert!(text.contains("Existing copy version: Upstream Beta 12"));
        assert!(text.contains("No artifact download."));
        assert!(text.contains(&format!("Reviewed plan SHA-256: {}", "b".repeat(64))));
        assert!(!text.contains("Existing copy channel: beta"));
        assert_eq!(before["plan"]["channel"], "beta");
        assert_eq!(before["selected_install"]["channel"], "beta");
        assert_eq!(serde_json::to_value(&review).unwrap(), before);
    }

    #[test]
    fn install_plan_displays_core_acquisitions_and_temporary_destination_separately() {
        let plan: portcove_core::InstallPlan = serde_json::from_value(serde_json::json!({
            "port_id": "fixture", "channel": "stable", "platform": "windows-x86-64",
            "release": {"version": "fixture", "channel": "stable", "published_at": null,
                "asset": {"name": "primary.zip", "url": "https://example.invalid/primary.zip", "size": 4, "sha256": "a".repeat(64)}},
            "bundled_runtime": null, "download_bytes": 1024, "action": "download", "source_requirements": [],
            "auxiliary_downloads": [{"name": "auxiliary.zip", "url": "https://example.invalid/auxiliary.zip", "size": 1020, "sha256": "b".repeat(64)}],
            "temporary_space": {"path": "external/game", "required_bytes": 8192, "available_bytes": 4096, "volume_identity": "external", "sufficient": false},
            "storage": {"library_root": "owned", "volume_total_bytes": 1024, "volume_available_bytes": 1024},
            "output_location": {"port_id": "fixture", "library_root": "owned", "default_output_directory": "owned/ports",
                "configured_output_directory": "external/game", "effective_output_directory": "external/game", "selection_source": "port_setting", "user_data_root": "owned/user"}
        })).unwrap();
        let before = serde_json::to_value(&plan).unwrap();
        let text = super::plan(&plan, &portcove_core::Catalog::embedded().unwrap());
        assert!(text.contains("auxiliary.zip"));
        assert!(text.contains("Total cold download (cache reuse may reduce): 1.0 KiB"));
        assert!(
            text.contains("Temporary free space: 8.0 KiB at external/game (available: 4.0 KiB")
        );
        assert!(text.contains("Final installed size: unknown"));
        assert_eq!(serde_json::to_value(&plan).unwrap(), before);
    }

    #[test]
    fn library_move_review_has_scoped_counts_and_full_hash() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("original library");
        let library = portcove_core::Library::open(&root).unwrap();
        let service = portcove_core::PortcoveService::new_read_only(library).unwrap();
        let mut plan = service
            .plan_library_move(&temporary.path().join("new library"))
            .unwrap();
        plan.content.clear();
        plan.plan_sha256 = "a".repeat(64);
        assert!(super::library_move_plan(&plan).contains("No managed content files."));
        plan.content.push(portcove_core::LibraryTreePlan {
            kind: portcove_core::LibraryContentKind::UserData,
            relative_path: "user".into(),
            copy: portcove_core::AdoptionCopyPlan {
                directories: vec!["settings".into()],
                files: vec![portcove_core::AdoptionCopyFile {
                    relative_path: "settings/preferences.json".into(),
                    size: 1024,
                    sha256: "b".repeat(64),
                }],
                skipped_entries: vec![],
                total_bytes: 1024,
            },
        });
        let text = super::library_move_plan(&plan);
        assert!(text.contains("Saves and settings: 1 file, 1 folder, 1.0 KiB"));
        assert!(text.contains(&format!("Review SHA-256: {}", "a".repeat(64))));
        assert!(text.contains(&format!("--apply --expected-plan {}", "a".repeat(64))));
        assert!(!text.contains("preferences.json"));
    }

    #[test]
    fn library_move_result_distinguishes_aborted_and_completed_authority() {
        let mut result = portcove_core::LibraryMoveResult {
            transfer_id: "transfer-id".into(),
            source_root: "original library".into(),
            destination_root: "copied library".into(),
            active_root: "original library".into(),
            source_retained: true,
            completed: false,
        };
        let aborted = super::library_move_result(&result);
        assert!(aborted.starts_with("Library move not completed\n"));
        assert!(aborted.contains("Active library: original library"));
        assert!(aborted.contains("Any copied destination files remain in place"));
        assert!(aborted.contains("choose a new destination"));
        result.completed = true;
        result.active_root = result.destination_root.clone();
        let completed = super::library_move_result(&result);
        assert!(completed.starts_with("Library move completed\n"));
        assert!(completed.contains("Active library: copied library"));
        assert!(!completed.contains("choose a new destination"));
    }

    fn discovery_report() -> portcove_core::SourceDiscoveryReport {
        portcove_core::SourceDiscoveryReport {
            searched_roots: vec!["owned-search-folder".into()],
            searched_profiles: vec!["minish-cap-gba".into()],
            candidates: Vec::new(),
            preliminary_selections: Vec::new(),
            entries_examined: 3,
            files_hashed: 2,
            hash_bytes: 1024,
            symlinks_skipped: 1,
            limits_reached: Vec::new(),
            issues: Vec::new(),
            issues_omitted: 0,
        }
    }

    #[test]
    fn discovery_preliminary_selection_does_not_claim_validation_or_exact_identity() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("disc.iso");
        std::fs::write(&path, b"synthetic preliminary disc").unwrap();
        let service = portcove_core::PortcoveService::new(
            portcove_core::Library::open(temporary.path().join("library")).unwrap(),
        )
        .unwrap();
        let mut report = discovery_report();
        report.preliminary_selections =
            vec![service.inspect_source("opengoal-jak1-disc", &path).unwrap()];
        let text = super::source_discovery(&report, &portcove_core::Catalog::embedded().unwrap());
        assert!(text.contains(
            "Preliminary selections: 1. These are not exact matches; validation has not run."
        ));
        assert!(text.contains("source inbox import PROFILE_ID PATH --mode use-current-location"));
        assert!(text.contains("source inspect PROFILE_ID"));
        assert!(!text.contains("source inspect PROFILE_ID PATH"));
        assert!(!text.contains("To register a chosen candidate"));
        assert!(text.contains("No sources were registered by this search."));
        assert!(service.library().sources().unwrap().is_empty());
    }

    #[test]
    fn discovery_empty_result_describes_only_inspected_scope_without_registration() {
        let catalog = portcove_core::Catalog::embedded().unwrap();
        let report = discovery_report();
        let before = serde_json::to_value(&report).unwrap();
        let text = super::source_discovery(&report, &catalog);
        assert!(text.starts_with("Source discovery\n"));
        assert!(
            text.contains("Only the selected folders, profiles and supported discovery formats")
        );
        assert!(text.contains("No matching candidates were found in the inspected scope."));
        assert!(text.contains("No recorded processing limits reached."));
        assert!(!text.contains("complete search"));
        assert!(!text.contains("invalid game files"));
        assert!(text.contains("No sources were registered by this search."));
        assert!(text.contains("does not install or launch games"));
        assert!(text.contains("Entries examined: 3\nFiles hashed: 2"));
        assert!(text.contains("Bytes charged to hash budget: 1.0 KiB (1024 bytes)"));
        assert!(text.contains("Symlinks skipped: 1"));
        assert!(text.contains(&format!(
            "{} (minish-cap-gba)",
            catalog.source_profile("minish-cap-gba").unwrap().label
        )));
        assert_eq!(serde_json::to_value(&report).unwrap(), before);
    }

    #[test]
    fn discovery_partial_limits_and_omitted_issues_remain_explicit_and_safe() {
        use portcove_core::{SourceDiscoveryIssue, SourceDiscoveryLimit};
        let catalog = portcove_core::Catalog::embedded().unwrap();
        let mut report = discovery_report();
        report.searched_roots = vec!["owned\nfolder\u{1b}[31m\u{9b}2J".into()];
        report.searched_profiles = vec!["future\nprofile".into()];
        report.limits_reached = vec![
            SourceDiscoveryLimit::Entries,
            SourceDiscoveryLimit::Depth,
            SourceDiscoveryLimit::FileSize,
            SourceDiscoveryLimit::HashBytes,
            SourceDiscoveryLimit::Candidates,
        ];
        report.issues = vec![SourceDiscoveryIssue {
            path: None,
            profile_id: Some("future\nprofile".into()),
            message: "Cannot read\nfile token=owned-secret\u{1b}[31m".into(),
        }];
        report.issues_omitted = 7;
        let before = serde_json::to_value(&report).unwrap();
        let text = super::source_discovery(&report, &catalog);
        assert!(text.contains("Search was partial."));
        for flag in [
            "max-entries",
            "max-depth",
            "max-file-bytes",
            "max-hash-bytes",
            "max-candidates",
        ] {
            assert!(text.contains(&format!("(--{flag})")));
        }
        assert!(text.contains("this search cannot be resumed"));
        assert!(text.contains("Scan issues: 1 shown, 7 omitted."));
        assert!(text.contains("Location not recorded [future profile]"));
        assert!(text.contains("[REDACTED]"));
        assert!(!text.contains("owned-secret"));
        assert!(!text.contains('\u{1b}'));
        assert!(!text.contains('\u{9b}'));
        assert!(!text.contains("owned\nfolder"));
        assert_eq!(serde_json::to_value(&report).unwrap(), before);

        report.limits_reached.clear();
        report.issues.clear();
        let text = super::source_discovery(&report, &catalog);
        assert!(text.contains("Scan issues: 0 shown, 7 omitted."));
        assert!(!text.contains("Search was partial."));
    }

    #[test]
    fn discovery_candidates_keep_content_and_storage_identity_separate() {
        let catalog = portcove_core::Catalog::embedded().unwrap();
        let mut report = discovery_report();
        report.candidates = vec![portcove_core::SourceRecord {
            profile_id: "minish-cap-gba".into(),
            path: "owned\ncandidate.zip\u{1b}[31m".into(),
            sha256: "a".repeat(64),
            size: 1024,
            storage_sha256: "b".repeat(64),
            storage_size: 2048,
            updated_at: 42,
            observed_identity: None,
        }];
        let before = serde_json::to_value(&report).unwrap();
        let text = super::source_discovery(&report, &catalog);
        assert!(text.contains("Matching candidates: 1"));
        assert!(text.contains(&format!("Content SHA-256: {}", "a".repeat(64))));
        assert!(text.contains(&format!("Stored file SHA-256: {}", "b".repeat(64))));
        assert!(text.contains("Content size: 1.0 KiB (1024 bytes)"));
        assert!(text.contains("Stored file size: 2.0 KiB (2048 bytes)"));
        assert!(text.contains("Observed (UTC): 1970-01-01T00:00:42Z"));
        assert!(text.contains("source add PROFILE_ID PATH --expected-sha256 SHA256"));
        assert!(text.contains("Registration checks the current bytes again."));
        assert!(!text.contains("Saved game-file"));
        assert!(!text.contains("owned\ncandidate"));
        assert!(!text.contains('\u{1b}'));
        assert_eq!(serde_json::to_value(&report).unwrap(), before);
    }

    use std::path::PathBuf;

    use portcove_core::{
        AdoptionCopyFile, AdoptionCopyPlan, AdoptionSkippedEntry, BackupInventory,
        BackupInventoryState, BackupRecord, PreparationCleanupPreview, StorageSummary,
    };

    use super::{
        backup_history, backup_list, catalog_show, document, storage, table, utc_rate_reset,
        utc_time,
    };

    fn scan_snapshot_fixture() -> portcove_core::GameFileScanSnapshot {
        use portcove_core::{
            GameFileRootAvailability, GameFileScanFreshness, SourceDiscoveryReport,
        };
        portcove_core::GameFileScanSnapshot {
            format_version: 3,
            catalog_sha256: "a".repeat(64),
            roots: vec![portcove_core::GameFileRoot {
                id: "fixture-root".into(),
                path: PathBuf::from("/private/fixture-path"),
                availability: GameFileRootAvailability::Unavailable,
                created_at: 1,
                updated_at: 1,
            }],
            limits: Some(portcove_core::SourceDiscoveryLimits {
                max_entries: 1,
                ..portcove_core::SourceDiscoveryLimits::default()
            }),
            report: SourceDiscoveryReport {
                searched_roots: Vec::new(),
                searched_profiles: Vec::new(),
                candidates: Vec::new(),
                preliminary_selections: Vec::new(),
                entries_examined: 1,
                files_hashed: 0,
                hash_bytes: 0,
                symlinks_skipped: 0,
                limits_reached: vec![portcove_core::SourceDiscoveryLimit::Entries],
                issues: vec![portcove_core::SourceDiscoveryIssue {
                    path: Some(PathBuf::from("/private/fixture-path")),
                    profile_id: None,
                    message: "token=fixture-secret\u{1b}[2J\rprivate diagnostic".into(),
                }],
                issues_omitted: 7,
            },
            completed_at: 2,
            freshness: GameFileScanFreshness::InputsMatch,
            coverage: None,
            continuation: None,
        }
    }

    #[test]
    fn saved_scan_readback_explains_partial_coverage_without_exposing_diagnostics() {
        let snapshot = scan_snapshot_fixture();
        let before = serde_json::to_value(&snapshot).unwrap();
        let output = super::game_file_scan_snapshot(&Some(snapshot.clone()));
        assert_eq!(output, super::game_file_scan(&snapshot));
        assert!(output.contains("Scan limits reached: entries"));
        assert!(output.contains("Recorded scan limits: entries=1, depth=6, file bytes=2147483648, hash bytes=17179869184, candidates=64."));
        assert!(output.contains("results may be incomplete"));
        assert!(output.contains("Scan issues: 1 recorded, 7 additional omitted"));
        assert!(output.contains("Unavailable folders at scan: 1"));
        assert!(output.contains("does not mean its files were deleted"));
        assert!(output.contains("file contents were not revalidated by this readback"));
        for private in ["fixture-path", "fixture-secret", "private diagnostic"] {
            assert!(!output.contains(private));
        }
        assert!(
            output
                .chars()
                .all(|character| !character.is_control() || character == '\n')
        );
        assert_eq!(serde_json::to_value(&snapshot).unwrap(), before);
    }

    #[test]
    fn saved_scan_readback_names_every_limit_and_changed_input_guidance() {
        use portcove_core::SourceDiscoveryLimit;
        let mut snapshot = scan_snapshot_fixture();
        snapshot.freshness = portcove_core::GameFileScanFreshness::InputsChanged;
        snapshot.report.limits_reached = vec![
            SourceDiscoveryLimit::Entries,
            SourceDiscoveryLimit::Depth,
            SourceDiscoveryLimit::FileSize,
            SourceDiscoveryLimit::HashBytes,
            SourceDiscoveryLimit::Candidates,
        ];
        let output = super::game_file_scan_snapshot(&Some(snapshot));
        assert!(
            output
                .contains("Scan limits reached: entries, depth, file size, hash bytes, candidates")
        );
        assert!(
            output.contains(
                "Recorded inputs changed; run source roots scan to refresh the evidence."
            )
        );
        assert!(!output.contains("Recorded inputs match"));
    }

    #[test]
    fn saved_scan_without_recorded_problems_does_not_claim_complete_coverage() {
        let mut snapshot = scan_snapshot_fixture();
        snapshot.roots[0].availability = portcove_core::GameFileRootAvailability::Available;
        snapshot.report.limits_reached.clear();
        snapshot.report.issues.clear();
        snapshot.report.issues_omitted = 0;
        let output = super::game_file_scan_snapshot(&Some(snapshot));
        assert!(output.contains("No recorded scan limits reached."));
        assert!(output.contains("Scan issues: 0 recorded, 0 additional omitted."));
        assert!(output.contains("Unavailable folders at scan: 0."));
        assert!(output.contains("file contents were not revalidated by this readback"));
        assert!(!output.contains("results may be incomplete"));
        assert!(!output.contains("scan is complete"));
        assert_eq!(
            super::game_file_scan_snapshot(&None),
            "No completed game-file folder scan is available."
        );
        let mut legacy = scan_snapshot_fixture();
        legacy.format_version = 1;
        legacy.limits = None;
        legacy.freshness = portcove_core::GameFileScanFreshness::InputsChanged;
        let output = super::game_file_scan_snapshot(&Some(legacy));
        assert!(output.contains("Recorded scan limits: not recorded."));
        assert!(!output.contains("Recorded scan limits: entries="));
    }

    #[test]
    fn saved_scan_readback_distinguishes_resume_restart_and_exhausted_frontier() {
        let mut snapshot = scan_snapshot_fixture();
        snapshot.coverage = Some(portcove_core::GameFileScanCoverage {
            batches: 2,
            batch_entries_examined: 1,
            entries_relisted: 3,
            metadata_checks: 8,
            prior_member_rechecks: 1,
            pending_directories: 2,
            can_resume: true,
            ..Default::default()
        });
        let output = super::game_file_scan(&snapshot);
        assert!(output.contains("Scan batches: 2; this batch examined 1 entries"));
        assert!(output.contains("Remaining entries: unknown"));
        assert!(output.contains("same limits to resume"));
        let coverage = snapshot.coverage.as_mut().unwrap();
        coverage.can_resume = false;
        coverage.restart_required = true;
        snapshot.freshness = portcove_core::GameFileScanFreshness::InputsChanged;
        let output = super::game_file_scan(&snapshot);
        assert!(output.contains("Continuation was refused"));
        assert!(!output.contains("same limits to resume"));
        let coverage = snapshot.coverage.as_mut().unwrap();
        coverage.restart_required = false;
        coverage.frontier_exhausted = true;
        coverage.remaining_entries = Some(0);
        let output = super::game_file_scan(&snapshot);
        assert!(output.contains("Remaining entries: 0"));
        assert!(output.contains("issues may still leave coverage incomplete"));
    }

    #[test]
    fn retained_diagnostics_escape_controls_without_changing_captures() {
        use portcove_core::{ActivityDiagnostic, DiagnosticStream, redact_diagnostic_text};
        let capture = ActivityDiagnostic {
            activity_id: "owned-activity-id".into(),
            phase: "preparation.setup".into(),
            stdout: DiagnosticStream {
                text: "first π 日本語\n\tsecond\u{1b}[31m\rprogress\u{8}\0\u{7f}\u{9b}2J".into(),
                observed_bytes: 4096,
                truncated: true,
            },
            stderr: DiagnosticStream {
                text: redact_diagnostic_text(
                    "password=owned-private-value\nsafe\u{1b}]2;owned-title\u{7}\n",
                ),
                observed_bytes: 1024,
                truncated: false,
            },
            complete: false,
            updated_at: 42,
            stream_limit_bytes: 2048,
        };
        let stored = serde_json::to_value(&capture).unwrap();
        let rendered = super::activity_diagnostic(std::slice::from_ref(&capture));
        assert!(
            rendered
                .chars()
                .all(|c| !c.is_control() || matches!(c, '\n' | '\t'))
        );
        assert!(rendered.contains("first π 日本語\n\tsecond"));
        assert!(rendered.contains(r"\u{1b}[31m\rprogress\u{8}\u{0}\u{7f}\u{9b}2J"));
        assert!(rendered.contains(r"safe\u{1b}]2;owned-title\u{7}"));
        assert!(rendered.contains("password=[REDACTED]"));
        assert!(!rendered.contains("owned-private-value"));
        assert!(rendered.contains("Later output may be missing."));
        let ended_with_omissions = ActivityDiagnostic {
            complete: true,
            ..capture.clone()
        };
        let ended = super::activity_diagnostic(std::slice::from_ref(&ended_with_omissions));
        assert!(ended.contains("Both output streams ended. Saved output is shown below."));
        assert!(ended.contains("Output exceeded the capture limit; some output was omitted."));
        assert!(!ended.contains("Preparation completed"));
        assert!(rendered.contains("Output exceeded the capture limit; some output was omitted."));
        assert_eq!(serde_json::to_value(&capture).unwrap(), stored);
        assert!(
            stored["stdout"]["text"]
                .as_str()
                .unwrap()
                .contains('\u{1b}')
        );
        assert_eq!(stored["stdout"]["observed_bytes"], 4096);
        assert_eq!(stored["stderr"]["observed_bytes"], 1024);
    }

    #[test]
    fn diagnostic_text_preserves_layout_and_unicode_but_escapes_all_controls() {
        let readable = "first π 日本語 🐚\n\tindented\n";
        assert_eq!(super::diagnostic_text(readable), readable);
        assert_eq!(super::diagnostic_text(""), "");
        for code in (0..=0x1f).chain(0x7f..=0x9f) {
            let control = char::from_u32(code).unwrap();
            let rendered = super::diagnostic_text(&control.to_string());
            if matches!(control, '\n' | '\t') {
                assert_eq!(rendered, control.to_string());
            } else {
                assert_eq!(rendered, control.escape_default().to_string());
                assert!(!rendered.chars().any(char::is_control));
            }
        }
    }

    #[test]
    fn retained_diagnostic_headers_are_single_line_and_completion_stays_truthful() {
        use portcove_core::{ActivityDiagnostic, DiagnosticStream};
        let stream = DiagnosticStream {
            text: "ordinary π\n\tsecond line\n".into(),
            observed_bytes: 30,
            truncated: false,
        };
        let capture = ActivityDiagnostic {
            activity_id: "owned-id\u{1b}[31m\nheader".into(),
            phase: "preparation.setup\u{8}\tphase".into(),
            stdout: stream.clone(),
            stderr: stream,
            complete: true,
            updated_at: 42,
            stream_limit_bytes: 2048,
        };
        let rendered = super::activity_diagnostic(&[capture.clone(), capture]);
        assert!(rendered.contains("Activity: owned-id[31m header\nPhase: Other operation phase"));
        assert_eq!(
            rendered
                .matches("Both output streams ended. Saved output is shown below.")
                .count(),
            2
        );
        assert_eq!(rendered.matches("ordinary π\n\tsecond line\n").count(), 4);
        assert!(!rendered.contains("Later output may be missing"));
        assert!(!rendered.contains("some output was omitted"));
        assert!(!rendered.contains('\u{1b}'));
        assert!(!rendered.contains('\u{8}'));
        assert_eq!(
            super::activity_diagnostic(&[]),
            "No retained diagnostic capture is available for this activity."
        );
    }

    #[test]
    fn cartridge_diagnostics_preserve_batch_identity_and_redact_phase_details() {
        use portcove_core::{ActivityDiagnostic, DiagnosticStream};
        let stream = DiagnosticStream {
            text: "captured output".into(),
            observed_bytes: 15,
            truncated: false,
        };
        let phases = [
            "install.cartridge.render96.extract.0",
            "install.cartridge.render96.extract.1",
            "install.cartridge.cvlod.configure.4",
            "install.cartridge.source.AWRE.objects.2",
            "token=private-fixture-value\nphase\u{1b}",
        ];
        let captures = phases
            .iter()
            .map(|phase| ActivityDiagnostic {
                activity_id: "owned-activity".into(),
                phase: (*phase).into(),
                stdout: stream.clone(),
                stderr: stream.clone(),
                complete: false,
                updated_at: 42,
                stream_limit_bytes: 2048,
            })
            .collect::<Vec<_>>();
        let before = serde_json::to_value(&captures).unwrap();
        let rendered = super::activity_diagnostic(&captures);
        assert_eq!(
            rendered
                .matches("Phase: Extracting Render96 game data")
                .count(),
            2
        );
        for phase in &phases[..4] {
            assert!(rendered.contains(&format!("\nPhase ID: {phase}\n")));
        }
        assert!(rendered.contains("Phase: Configuring the Legacy of Darkness build"));
        assert!(rendered.contains("Phase: Compiling cartridge game code from source"));
        assert!(rendered.contains("Phase ID: token=[REDACTED] phase"));
        assert!(!rendered.contains("private-fixture-value"));
        assert!(!rendered.contains('\u{1b}'));
        assert_eq!(serde_json::to_value(&captures).unwrap(), before);
    }

    #[test]
    fn human_times_use_utc_and_report_unrepresentable_values() {
        assert_eq!(utc_time(0), "1970-01-01T00:00:00Z");
        assert_eq!(utc_time(-1), "1969-12-31T23:59:59Z");
        assert_eq!(utc_time(i64::MAX), "Unknown time (invalid Unix timestamp)");
        assert_eq!(utc_rate_reset(42), "1970-01-01T00:00:42Z");
        assert_eq!(
            utc_rate_reset(u64::MAX),
            "Unknown time (invalid Unix timestamp)"
        );
        let status = portcove_core::GithubAuthStatus {
            source: portcove_core::GithubAuthSource::Anonymous,
            authenticated: false,
            login: None,
            rate_limit: Some(portcove_core::GithubRateLimit {
                limit: 60,
                remaining: 12,
                resets_at: 42,
            }),
            device_login_available: false,
        };
        assert!(super::auth_status(&status).contains("resets 1970-01-01T00:00:42Z"));
        let source = portcove_core::SourceRecord {
            profile_id: "fixture".into(),
            path: PathBuf::from("fixture.iso"),
            sha256: "a".repeat(64),
            size: 3,
            storage_sha256: "b".repeat(64),
            storage_size: 3,
            updated_at: 42,
            observed_identity: None,
        };
        let sources = super::source_list(&[source], &portcove_core::Catalog::embedded().unwrap());
        assert!(sources.contains("UPDATED (UTC)"));
        assert!(sources.contains("1970-01-01T00:00:42Z"));
        let document = document(&serde_json::json!({
            "created_at": 42,
            "updated_at": -1,
            "started_at": i64::MAX,
            "finished_at": null,
            "resets_at": u64::MAX,
            "file_count": 42
        }))
        .unwrap();
        assert!(document.contains("Created at: 1970-01-01T00:00:42Z"));
        assert!(document.contains("Updated at: 1969-12-31T23:59:59Z"));
        assert!(document.contains("Started at: Unknown time (invalid Unix timestamp)"));
        assert!(document.contains("Resets at: Unknown time (invalid Unix timestamp)"));
        assert!(document.contains("Finished at: none"));
        assert!(document.contains("File count: 42"));
    }

    #[test]
    fn catalog_show_uses_structured_presentation_without_adapter_ids() {
        let catalog = portcove_core::Catalog::embedded().unwrap();
        let output = catalog_show(catalog.port("shipwright").unwrap());
        assert!(output.contains("Installation: portable upstream package"));
        assert!(output.contains("Game files: The Legend of Zelda: Ocarina of Time source"));
        assert!(output.contains("Check method: Required files and format checks"));
        assert!(!output.contains("catalog-declared file rules"));
        assert!(output.contains("Saves and settings: managed by Portcove"));
        assert!(output.contains("Upstream state: active"));
        assert!(!output.contains("libultraship-portable"));
        let external = catalog_show(catalog.port("wave-race-64-recomp").unwrap());
        assert!(external.contains("Preparation: Extract the official v1.0.2 Windows ZIP"));
        assert!(external.contains("create an empty portable.txt"));
        assert!(external.contains("Saves and settings: user-owned"));
    }

    #[test]
    fn catalog_status_explains_effective_signed_fallback_and_retains_exact_identities() {
        use portcove_core::{CatalogOrigin, CatalogProvenance, CatalogStatus, CatalogTrustKey};

        let status = CatalogStatus {
            provenance: CatalogProvenance {
                origin: CatalogOrigin::SignedPrevious,
                catalog_sha256: "a".repeat(64),
                sequence: Some(7),
                key_id: Some("publisher-id".into()),
                expires_at: Some(42),
                fallback_reasons: vec!["active catalog expired\rcheck trust".into()],
            },
            trusted_keys: vec![CatalogTrustKey {
                key_id: "trusted-id".into(),
                public_key: "b".repeat(64),
            }],
            highest_sequence: 8,
            updates_enabled: true,
            can_rollback: false,
            can_use_cached: true,
            state_sha256: "c".repeat(64),
        };
        let output = super::catalog_status(&status);
        assert!(output.contains("Active catalog: previous signed catalog"));
        assert!(output.contains("Catalog SHA-256: "));
        assert!(output.contains(&"a".repeat(64)));
        assert!(output.contains("Publisher: publisher-id"));
        assert!(output.contains("Sequence: 7"));
        assert!(output.contains("Expires: 1970-01-01T00:00:42Z"));
        assert!(output.contains("Highest accepted sequence: 8"));
        assert!(output.contains("Trusted publishers: 1"));
        assert!(output.contains("trusted-id"));
        assert!(output.contains(&"b".repeat(64)));
        assert!(output.contains("Rollback: unavailable"));
        assert!(output.contains("Cached signed catalog: available"));
        assert!(output.contains("Fallback reason: active catalog expired check trust"));
        assert!(output.contains(&format!("State SHA-256: {}", "c".repeat(64))));
        assert!(!output.contains('\u{1b}'));
        assert!(!output.contains('\r'));
    }

    #[test]
    fn catalog_status_names_built_in_selection_without_claiming_signed_provenance() {
        use portcove_core::{CatalogOrigin, CatalogProvenance, CatalogStatus};

        let status = CatalogStatus {
            provenance: CatalogProvenance {
                origin: CatalogOrigin::Embedded,
                catalog_sha256: "a".repeat(64),
                sequence: None,
                key_id: None,
                expires_at: None,
                fallback_reasons: Vec::new(),
            },
            trusted_keys: Vec::new(),
            highest_sequence: 0,
            updates_enabled: false,
            can_rollback: false,
            can_use_cached: false,
            state_sha256: "b".repeat(64),
        };
        let output = super::catalog_status(&status);
        assert!(output.contains("Active catalog: built-in catalog"));
        assert!(output.contains("Trusted publishers: 0"));
        assert!(output.contains("Catalog updates: disabled"));
        assert!(output.contains("Rollback: unavailable"));
        assert!(output.contains("Cached signed catalog: unavailable"));
        assert!(!output.contains("Publisher:"));
        assert!(!output.contains("Sequence:"));
        assert!(!output.contains("Fallback reason:"));
    }

    #[test]
    fn preparation_cleanup_lists_every_reviewed_entry_before_confirmation() {
        let preview = PreparationCleanupPreview {
            format_version: 1,
            operation_id: "owned-operation".into(),
            port_id: "owned-port".into(),
            retained_path: PathBuf::from("retained/owned-operation"),
            retained: AdoptionCopyPlan {
                directories: vec![
                    PathBuf::from("empty"),
                    PathBuf::from("payload"),
                    PathBuf::from("payload/generated"),
                ],
                files: vec![AdoptionCopyFile {
                    relative_path: PathBuf::from("payload/private.bin"),
                    size: 4,
                    sha256: "a".repeat(64),
                }],
                skipped_entries: vec![AdoptionSkippedEntry {
                    relative_path: PathBuf::from("linked-save"),
                    reason: "symbolic link".into(),
                }],
                total_bytes: 4,
            },
            original_install_path: PathBuf::from("versions/owned-port/original"),
            source_path: PathBuf::from("sources/owned.iso"),
            persistent_data_path: PathBuf::from("user/owned-port"),
            backup_path: PathBuf::from("backups/owned-port"),
            logs_path: PathBuf::from("logs"),
            cleanup_is_irreversible: true,
            interrupted_cleanup_will_retry: true,
            preview_sha256: "b".repeat(64),
        };

        let before = serde_json::to_value(&preview).unwrap();
        let output =
            super::preparation_cleanup(&preview, &portcove_core::Catalog::embedded().unwrap());
        let file = format!(
            "File: payload/private.bin (4 B; 4 bytes, SHA-256 {})",
            "a".repeat(64)
        );
        assert!(output.lines().any(|line| line == file));
        for entry in [
            "Folder: empty",
            "Folder: payload",
            "Folder: payload/generated",
            "Skipped link or special entry: linked-save (symbolic link)",
        ] {
            assert!(
                output.lines().any(|line| line == entry),
                "missing {entry}: {output}"
            );
        }
        assert!(
            output
                .contains("Affected: 1 files, 3 folders, 1 skipped links or special entries, 4 B")
        );
        assert!(output.contains(&format!("Preview: {}", "b".repeat(64))));
        assert_eq!(serde_json::to_value(&preview).unwrap(), before);
    }

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

    fn activity_feed(record: portcove_core::ActivityRecord) -> portcove_core::ActivityFeed {
        let id = record.id.clone();
        let current_activity_ids = (record.status == portcove_core::ActivityStatus::Running)
            .then_some(vec![id.clone()])
            .unwrap_or_default();
        let attention_required_activity_ids = (record.status
            == portcove_core::ActivityStatus::Failed)
            .then_some(vec![id])
            .unwrap_or_default();
        portcove_core::ActivityFeed {
            records: vec![record],
            current_activity_ids,
            attention_required_activity_ids,
            recovery_required_activity_ids: Vec::new(),
            active_and_actionable_complete: true,
            terminal_history_limit: 50,
            terminal_history_count: 1,
            terminal_history_complete: true,
        }
    }

    #[test]
    fn activity_does_not_promote_incomplete_coverage_and_shows_finished_time() {
        let catalog = portcove_core::Catalog::embedded().unwrap();
        let mut record = failed_activity(std::path::Path::new("owned-fixture"));
        record.finished_at = Some(84);
        let mut feed = activity_feed(record);
        feed.active_and_actionable_complete = false;
        let rendered = super::activities(&feed, &catalog, false);
        assert!(rendered.contains("Current and actionable coverage: incomplete."));
        assert!(rendered.contains("Finished (UTC): 1970-01-01T00:01:24Z"));
        assert!(rendered.contains(&super::port_name(&catalog, "opengoal-jak1")));
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
                "Portcove couldn't confirm whether anything changed.",
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
            let plain = super::activities(&activity_feed(record.clone()), &catalog, false);
            assert!(plain.contains(expected));
            assert!(plain.contains("Started (UTC): 1970-01-01T00:00:42Z"));
            assert!(plain.contains(&format!(
                "Target: {}",
                super::port_name(&catalog, "opengoal-jak1")
            )));
            assert!(plain.contains("activity log owned-activity-id"));
            assert!(!plain.contains(&temporary.path().display().to_string()));
            assert!(!plain.contains("owned-secret"));
            assert!(!plain.contains("Technical details (redacted):"));
            let technical = super::activities(&activity_feed(record.clone()), &catalog, true);
            assert!(technical.contains("Technical details (redacted):"));
            assert!(technical.contains("[REDACTED]"));
            assert!(!technical.contains("owned-secret"));
            assert!(!technical.contains('\u{1b}'));
            if status == ActivityStatus::Cancelled {
                assert!(plain.contains("Operation cancelled."));
                assert!(!plain.contains("Error:"));
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
                let plain = super::activities(&activity_feed(record.clone()), &catalog, false);
                assert!(!plain.contains(&temporary.path().display().to_string()));
                assert!(!plain.contains("owned-secret"));
                assert!(!plain.contains("owned-target"));
                assert!(!plain.contains("No files were changed"));
                if matches!(status, ActivityStatus::Failed | ActivityStatus::Cancelled) {
                    assert!(plain.contains("No structured failure outcome was recorded"));
                }
                let technical = super::activities(&activity_feed(record.clone()), &catalog, true);
                assert!(technical.contains(&private_path.display().to_string()));
                assert!(technical.contains("[REDACTED]"));
                assert!(!technical.contains("owned-secret"));
                assert!(!technical.contains("owned-target"));
                assert!(!technical.contains('\u{1b}'));
            }
        }
    }

    fn backup_action_fixture() -> portcove_core::BackupActionPreview {
        portcove_core::BackupActionPreview {
            action: portcove_core::BackupAction::Restore,
            backup: BackupRecord {
                id: "backup-1".into(),
                port_id: "zelda64-recomp".into(),
                path: PathBuf::from("owned/backups/backup-1"),
                created_at: 42,
                file_count: 3,
                size: 2048,
                sha256: "a".repeat(64),
            },
            current_user_data_exists: true,
            safety_backup_will_be_created: true,
            retained_runtime_copy_will_be_deleted: false,
            preview_sha256: "b".repeat(64),
        }
    }

    #[test]
    fn backup_deletion_discloses_the_bound_newer_runtime_copy() {
        let catalog = portcove_core::Catalog::embedded().unwrap();
        let mut preview = backup_action_fixture();
        preview.action = portcove_core::BackupAction::Delete;
        assert!(
            !super::backup_action_preview(&preview, &catalog)
                .contains("runtime saves/settings copy")
        );
        preview.retained_runtime_copy_will_be_deleted = true;
        assert!(super::backup_action_preview(&preview, &catalog).contains(
            "permanently deletes its retained Ghostship 3.0.0 runtime saves/settings copy"
        ));
    }

    #[test]
    fn backup_review_distinguishes_existing_data_from_a_planned_safety_backup() {
        let catalog = portcove_core::Catalog::embedded().unwrap();
        let mut preview = backup_action_fixture();
        for (exists, safety) in [(true, true), (true, false), (false, false)] {
            preview.current_user_data_exists = exists;
            preview.safety_backup_will_be_created = safety;
            let text = super::backup_action_preview(&preview, &catalog);
            assert!(text.contains(&format!(
                "Port: {} (zelda64-recomp)",
                catalog.port("zelda64-recomp").unwrap().name,
            )));
            assert!(text.contains("Created (UTC): 1970-01-01T00:00:42Z"));
            assert!(text.contains("Files: 3\nSize: 2.0 KiB (2048 bytes)"));
            assert!(text.contains(&format!("Backup SHA-256: {}", "a".repeat(64))));
            assert!(text.contains(&format!("Review SHA-256: {}", "b".repeat(64))));
            assert!(text.contains(&format!(
                "Current managed saved data exists: {}",
                if exists { "yes" } else { "no" },
            )));
            assert_eq!(text.contains("create a safety backup"), safety);
            assert_eq!(text.contains("no safety backup is planned"), !safety);
            assert!(text.contains("Preserved: the selected backup and other backups."));
        }
    }

    #[test]
    fn backup_delete_review_cannot_be_spoofed_by_control_characters() {
        let catalog = portcove_core::Catalog::embedded().unwrap();
        let mut preview = backup_action_fixture();
        preview.action = portcove_core::BackupAction::Delete;
        preview.backup.id = "backup\nforged\u{1b}[31m\u{9b}2J".into();
        preview.backup.path = PathBuf::from("owned\r\nfolder\u{1b}");
        let text = super::backup_action_preview(&preview, &catalog);
        assert!(text.starts_with("Delete backup review\n"));
        assert!(text.contains("permanently delete only the selected backup"));
        assert!(text.contains("Preserved: live managed saved data and other backups."));
        assert!(text.contains("Portcove cannot undo this deletion."));
        assert!(!text.contains("create a safety backup"));
        assert!(!text.contains('\u{1b}'));
        assert!(!text.contains('\u{9b}'));
        assert!(!text.contains('\r'));
        assert!(!text.lines().any(|line| line.starts_with("forged")));
    }

    fn backup_fixture_assessment() -> portcove_core::PortActionAssessment {
        portcove_core::PortActionAssessment {
            action: portcove_core::PortAction::BackupCreate,
            availability: portcove_core::PortActionAvailability::Waiting,
            reason: portcove_core::PortActionReason::MissingData,
            definition: None,
        }
    }

    fn backup_restore_fixture_assessment() -> portcove_core::PortActionAssessment {
        portcove_core::PortActionAssessment {
            action: portcove_core::PortAction::BackupRestore,
            availability: portcove_core::PortActionAvailability::Waiting,
            reason: portcove_core::PortActionReason::MissingBackup,
            definition: None,
        }
    }

    #[test]
    fn update_decisions_explain_review_without_launch_or_registration_instructions() {
        use portcove_core::{
            PortAction, PortActionAssessment, PortActionAvailability as Availability,
            PortActionReason as Reason,
        };
        let decision = |availability, reason| {
            super::status_action(&PortActionAssessment {
                action: PortAction::Update,
                availability,
                reason,
                definition: None,
            })
        };
        assert!(
            decision(Availability::Waiting, Reason::ReviewRequired)
                .contains("saved policy is not consent")
        );
        assert!(
            decision(Availability::NotOffered, Reason::NotInstalled)
                .contains("managed release before reviewing its update")
        );
        let active = decision(Availability::NotOffered, Reason::AlreadyRegistered);
        assert!(active.contains("exact verified release is already active"));
        assert!(!active.contains("external runtime"));
    }

    #[test]
    fn read_renderers_have_stable_human_snapshots() {
        assert_eq!(
            backup_history(
                "sample",
                &BackupInventory {
                    port_id: "sample".into(),
                    create_assessment: backup_fixture_assessment(),
                    restore_assessment: backup_restore_fixture_assessment(),
                    state: BackupInventoryState::Healthy,
                    backups: Vec::new(),
                    problems: Vec::new(),
                }
            ),
            "No backups for sample."
        );
        assert_eq!(
            backup_history(
                "sample",
                &BackupInventory {
                    port_id: "sample".into(),
                    create_assessment: backup_fixture_assessment(),
                    restore_assessment: backup_restore_fixture_assessment(),
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
            "Backups for sample (1)\nID        CREATED (UTC)         FILES  SIZE     PATH\n--------  --------------------  -----  -------  ----------------------------\nbackup-1  1970-01-01T00:00:42Z  3      2.0 KiB  C:/Portcove/backups/backup-1",
        );
        let degraded = backup_list(
            "sample",
            &BackupInventory {
                port_id: "sample".into(),
                restore_assessment: backup_restore_fixture_assessment(),
                create_assessment: portcove_core::PortActionAssessment {
                    availability: portcove_core::PortActionAvailability::Held,
                    reason: portcove_core::PortActionReason::RecoveryRequired,
                    ..backup_fixture_assessment()
                },
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
            &portcove_core::Catalog::embedded().unwrap(),
        );
        assert!(degraded.contains("Backup inventory: recovery required (1 problem)"));
        assert!(degraded.contains("backup_create"));
        assert!(degraded.contains("held (recovery_required)"));
        assert!(degraded.contains("Restart Portcove to retry recovery"));
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

    fn status_disclosure_fixture() -> portcove_core::PortStatus {
        serde_json::from_value(serde_json::json!({
            "port_id": "fixture-port",
            "channel": "stable",
            "update_policy": "notify",
            "active": null,
            "previous": null,
            "staged": null
        }))
        .unwrap()
    }

    #[test]
    fn readiness_keeps_setup_during_launch_distinct_from_blocked_preparation() {
        let mut status = status_disclosure_fixture();
        for (launchable, pending_setup, blockers, expected) in [
            (true, false, vec![], "ready"),
            (
                true,
                true,
                vec![],
                "Ready to launch; setup runs during launch",
            ),
            (
                false,
                true,
                vec![portcove_core::LaunchBlocker::PreparationRequired],
                "needs game data preparation",
            ),
        ] {
            status.readiness = Some(
                serde_json::from_value(serde_json::json!({
                    "launchable": launchable,
                    "pending_setup": pending_setup,
                    "blockers": blockers
                }))
                .unwrap(),
            );
            let before = serde_json::to_value(&status).unwrap();
            assert_eq!(super::readiness(&status), expected);
            assert_eq!(serde_json::to_value(&status).unwrap(), before);
        }
    }

    #[test]
    fn status_disclosure_keeps_managed_staged_and_external_versions_separate() {
        // Supplied records test formatting only; no runtime is registered or executed.
        let managed_path = PathBuf::from("fixture-managed");
        let external_path = PathBuf::from("fixture-external");
        let mut managed = status_disclosure_fixture();
        let install = serde_json::json!({
            "id": "fixture-install", "port_id": managed.port_id,
            "version": "managed-v1", "path": managed_path,
            "channel": "stable", "installed_at": 1, "verified": true, "staged": false
        });
        managed.active = Some(serde_json::from_value(install.clone()).unwrap());
        let mut staged = install;
        staged["version"] = "staged-v2".into();
        staged["staged"] = true.into();
        managed.staged = Some(serde_json::from_value(staged).unwrap());
        let mut external = status_disclosure_fixture();
        external.port_id = "external\tport\n\u{1b}".into();
        external.external_runtime = Some(portcove_core::ExternalRuntimeRecord {
            user_selected: None,
            id: "fixture-registration".into(),
            port_id: external.port_id.clone(),
            path: external_path.clone(),
            executable: external_path.join("game"),
            version: "external\tv3\n\u{1b}".into(),
            platform: portcove_core::Platform::LinuxX86_64,
            archive_sha256: "a".repeat(64),
            immutable_tree_sha256: "b".repeat(64),
            registered_at: 1,
            retained_definition: None,
            shared_preferences: None,
        });
        let before = serde_json::to_value((&managed, &external)).unwrap();
        let output = super::statuses(
            &[managed.clone(), external.clone()],
            &portcove_core::Catalog::embedded().unwrap(),
        );
        assert!(output.contains("ACTIVE"));
        assert!(output.contains("STAGED"));
        assert!(output.contains("EXTERNAL (USER-OWNED)"));
        let managed_row = output
            .lines()
            .find(|line| line.starts_with("Port (fixture-port; name unavailable)"))
            .unwrap();
        assert!(managed_row.contains("managed-v1"));
        assert!(managed_row.contains("staged-v2"));
        assert!(!managed_row.contains("external v3"));
        let external_row = output
            .lines()
            .find(|line| line.starts_with("Port (external port ; name unavailable)"))
            .unwrap();
        assert!(external_row.contains("external v3 "));
        assert!(!external_row.contains("managed-v1"));
        assert!(!output.contains(managed_path.to_str().unwrap()));
        assert!(!output.contains(external_path.to_str().unwrap()));
        assert!(!output.contains('\u{1b}'));
        assert!(!output.contains('\t'));
        assert_eq!(before, serde_json::to_value((&managed, &external)).unwrap());
        assert_eq!(
            super::status(&external, &portcove_core::Catalog::embedded().unwrap()),
            super::statuses(&[external], &portcove_core::Catalog::embedded().unwrap())
        );
    }

    #[test]
    fn status_disclosure_preserves_all_core_action_states_and_reason_codes() {
        use portcove_core::{
            PortAction as Action, PortActionAvailability as State, PortActionReason as Reason,
        };
        let reasons = [
            Reason::Available,
            Reason::RouteNotOffered,
            Reason::AlreadyRegistered,
            Reason::UnsupportedPlatform,
            Reason::NotInstalled,
            Reason::ReviewRequired,
            Reason::MissingSource,
            Reason::UnreadableSource,
            Reason::ChangedSource,
            Reason::MissingBios,
            Reason::UnreadableBios,
            Reason::ChangedBios,
            Reason::MissingRuntime,
            Reason::PreparationRequired,
            Reason::InvalidInstallation,
            Reason::DefinitionIneligible,
        ];
        for (action, state) in [
            (Action::Install, State::Allowed),
            (Action::RegisterExternal, State::Waiting),
            (Action::Launch, State::Held),
            (Action::RemoveManaged, State::NotOffered),
            (Action::RemoveExternal, State::Waiting),
            (Action::Rollback, State::Held),
        ] {
            for reason in reasons {
                let assessment = portcove_core::PortActionAssessment {
                    action,
                    availability: state,
                    reason,
                    definition: None,
                };
                let before = serde_json::to_value(assessment).unwrap();
                let rendered = super::status_action(&assessment);
                assert!(rendered.contains(&format!("[{}]", before["action"].as_str().unwrap())));
                let state_label = match state {
                    State::Allowed => "allowed",
                    State::Waiting => "waiting for review",
                    State::Held => "held",
                    State::NotOffered => "not offered",
                };
                let (_, explanation) = rendered
                    .split_once(&format!(
                        "]: {state_label} ({}): ",
                        before["reason"].as_str().unwrap()
                    ))
                    .unwrap();
                assert!(!explanation.is_empty());
                assert_eq!(before, serde_json::to_value(assessment).unwrap());
                match reason {
                    Reason::MissingSource | Reason::UnreadableSource | Reason::ChangedSource => {
                        assert!(
                            explanation.contains("game-file") || explanation.contains("game files")
                        );
                        assert!(!explanation.contains("BIOS"));
                    }
                    Reason::MissingBios | Reason::UnreadableBios | Reason::ChangedBios => {
                        assert!(explanation.contains("BIOS"))
                    }
                    _ => {}
                }
            }
        }
    }

    #[test]
    fn status_disclosure_uses_authoritative_definition_reasons() {
        use portcove_core::{DefinitionEligibilityOutcome, DefinitionEligibilityReason as Reason};
        for reason in [
            Reason::MandatoryChecksPassed,
            Reason::PublisherRevoked,
            Reason::UnknownSafetySemantics,
            Reason::PublisherScopeRequired,
            Reason::EngineCapabilityRequired,
            Reason::OwnershipMigrationRequired,
            Reason::MetadataReplay,
            Reason::RefreshIncomplete,
            Reason::MetadataStale,
            Reason::RecordedIdentityChanged,
            Reason::AuthenticatedIntegrityRequired,
            Reason::LocalIntegrityFailed,
            Reason::MandatoryCheckFailed,
            Reason::SourceIdentityMismatch,
            Reason::RequiredSourceMissing,
        ] {
            let assessment = portcove_core::PortActionAssessment {
                action: portcove_core::PortAction::Launch,
                availability: portcove_core::PortActionAvailability::Held,
                reason: portcove_core::PortActionReason::DefinitionIneligible,
                definition: Some(portcove_core::DefinitionEligibility {
                    outcome: DefinitionEligibilityOutcome::Hold,
                    reason,
                }),
            };
            let value = serde_json::to_value(assessment).unwrap();
            let rendered = super::status_action(&assessment);
            let prefix = format!(
                "  Launch [launch]: held ({}): ",
                value["definition"]["reason"].as_str().unwrap()
            );
            assert!(!rendered.strip_prefix(&prefix).unwrap().is_empty());
            assert!(!rendered.contains("(definition_ineligible)"));
            assert!(!rendered.contains("No current blocker"));
        }
    }

    #[test]
    fn status_disclosure_omits_legacy_empty_actions_and_keeps_groups_with_their_ports() {
        let empty = status_disclosure_fixture();
        assert!(
            !super::status(&empty, &portcove_core::Catalog::embedded().unwrap())
                .contains("Actions:")
        );
        assert!(
            !super::statuses(
                &[empty.clone(), empty.clone()],
                &portcove_core::Catalog::embedded().unwrap()
            )
            .contains("Actions:")
        );
        assert_eq!(
            super::statuses(&[], &portcove_core::Catalog::embedded().unwrap()),
            "The active catalog contains no ports."
        );
        let mut assessed = status_disclosure_fixture();
        assessed.port_id = "assessed\nport\u{1b}".into();
        assessed
            .port_actions
            .push(portcove_core::PortActionAssessment {
                action: portcove_core::PortAction::RemoveExternal,
                availability: portcove_core::PortActionAvailability::Waiting,
                reason: portcove_core::PortActionReason::ReviewRequired,
                definition: None,
            });
        let output = super::statuses(
            &[empty, assessed.clone()],
            &portcove_core::Catalog::embedded().unwrap(),
        );
        assert!(!output.contains("\nfixture-port:\n"));
        assert!(output.contains("\nPort (assessed port; name unavailable):\n"));
        assert!(output.contains("external files are kept"));
        assert_eq!(
            output
                .split_once("\nPort (assessed port; name unavailable):\n")
                .unwrap()
                .1,
            super::status(&assessed, &portcove_core::Catalog::embedded().unwrap())
                .split_once("\nPort (assessed port; name unavailable):\n")
                .unwrap()
                .1
        );
        assert!(!output.contains('\u{1b}'));
    }
}

#[cfg(test)]
mod catalog_detail_tests {
    use super::{catalog_show, clean};
    use portcove_core::{Catalog, Platform, PortDefinition, ReleaseSource};

    fn external_port() -> PortDefinition {
        Catalog::embedded()
            .unwrap()
            .port("wave-race-64-recomp")
            .unwrap()
            .clone()
    }

    #[test]
    fn catalog_detail_distinguishes_declared_profile_ids_from_presentation_labels() {
        use portcove_core::{
            PortSourceRole, SourceRequirementPresentation, SourceVerificationMethod,
        };

        let mut port = external_port();
        port.source_profile = Some("declared-game-profile".into());
        port.bios_source_profile = Some("declared-bios-profile".into());
        port.presentation.as_mut().unwrap().source_requirements = vec![
            SourceRequirementPresentation {
                role: PortSourceRole::Game,
                profile_id: "presentation-game-reference".into(),
                label: "Readable game-file requirement".into(),
                verification: SourceVerificationMethod::CatalogIdentity,
            },
            SourceRequirementPresentation {
                role: PortSourceRole::Bios,
                profile_id: "presentation-bios-reference".into(),
                label: "Readable BIOS requirement".into(),
                verification: SourceVerificationMethod::CatalogIdentity,
            },
        ];
        let before = serde_json::to_value(&port).unwrap();
        let output = catalog_show(&port);
        assert!(
            output
                .lines()
                .any(|line| line == "Game-file profile ID: declared-game-profile")
        );
        assert!(
            output
                .lines()
                .any(|line| line == "BIOS profile ID: declared-bios-profile")
        );
        assert!(output.contains("Game files: Readable game-file requirement (Check method:"));
        assert!(output.contains("BIOS: Readable BIOS requirement (Check method:"));
        assert!(!output.contains("profile ID: Readable"));
        assert!(!output.contains("presentation-game-reference"));
        assert!(!output.contains("presentation-bios-reference"));
        assert_eq!(serde_json::to_value(&port).unwrap(), before);
    }

    #[test]
    fn catalog_detail_discloses_declared_profile_ids_without_presentation() {
        let mut port = external_port();
        port.presentation = None;
        port.source_profile = Some("declared-game-profile".into());
        port.bios_source_profile = Some("declared-bios-profile".into());
        let before = serde_json::to_value(&port).unwrap();
        let output = catalog_show(&port);
        assert!(
            output
                .lines()
                .any(|line| line == "Game-file profile ID: declared-game-profile")
        );
        assert!(
            output
                .lines()
                .any(|line| line == "BIOS profile ID: declared-bios-profile")
        );
        assert!(output.contains("Presentation details: unavailable in this catalog"));
        assert_eq!(serde_json::to_value(&port).unwrap(), before);
    }

    #[test]
    fn catalog_detail_omits_each_absent_profile_id_independently() {
        for (game, bios, expected) in [
            (
                Some("declared-game-profile"),
                None,
                vec!["Game-file profile ID: declared-game-profile"],
            ),
            (
                None,
                Some("declared-bios-profile"),
                vec!["BIOS profile ID: declared-bios-profile"],
            ),
            (None, None, Vec::new()),
        ] {
            let mut port = external_port();
            port.source_profile = game.map(str::to_owned);
            port.bios_source_profile = bios.map(str::to_owned);
            let before = serde_json::to_value(&port).unwrap();
            let output = catalog_show(&port);
            let rows = output
                .lines()
                .filter(|line| {
                    line.starts_with("Game-file profile ID:")
                        || line.starts_with("BIOS profile ID:")
                })
                .collect::<Vec<_>>();
            assert_eq!(rows, expected);
            assert_eq!(serde_json::to_value(&port).unwrap(), before);
        }
    }

    #[test]
    fn catalog_detail_sanitizes_profile_ids_without_changing_the_definition() {
        let mut port = external_port();
        port.source_profile = Some("game\nprofile\t\u{1b}\u{9b}".into());
        port.bios_source_profile = Some("bios\rprofile\u{7}".into());
        let before = serde_json::to_value(&port).unwrap();
        let output = catalog_show(&port);
        assert!(
            output
                .lines()
                .any(|line| line == "Game-file profile ID: game profile ")
        );
        assert!(
            output
                .lines()
                .any(|line| line == "BIOS profile ID: bios profile")
        );
        assert!(
            output
                .chars()
                .all(|character| !character.is_control() || character == '\n')
        );
        assert_eq!(serde_json::to_value(&port).unwrap(), before);
    }

    #[test]
    fn catalog_detail_reads_accepted_runtime_facts_without_presentation() {
        let mut port = external_port();
        port.presentation = None;
        let before = serde_json::to_value(&port).unwrap();
        let runtime = &port.release.user_prepared[&Platform::WindowsX86_64];
        let output = catalog_show(&port);
        assert!(output.contains(&format!(
            "Accepted runtime (Windows (x64)): {}",
            runtime.version
        )));
        assert!(output.contains(&format!(
            "Package: {} ({}; {} bytes)",
            runtime.archive_name,
            super::format_bytes(runtime.archive_size),
            runtime.archive_size
        )));
        assert!(output.contains(&format!("Package SHA-256: {}", runtime.archive_sha256)));
        assert!(output.contains(&format!("Executable: {}", runtime.executable)));
        assert!(
            output.contains("portcove external preview wave-race-64-recomp \"<extracted-folder>\"")
        );
        assert!(output.contains("matching platform"));
        assert!(output.contains(
            "Maintenance: user-owned; Portcove does not download or update this runtime"
        ));
        assert!(output.contains("Presentation details: unavailable in this catalog"));
        assert!(!output.contains("Accepted runtime (Linux"));
        assert_eq!(serde_json::to_value(&port).unwrap(), before);
    }

    #[test]
    fn catalog_detail_keeps_user_selection_separate_from_accepted_package_facts() {
        let catalog = Catalog::embedded().unwrap();
        let selected: Vec<_> = catalog
            .ports()
            .iter()
            .filter(|port| {
                port.release.user_prepared.values().any(|runtime| {
                    runtime.trust == portcove_core::ExternalRuntimeTrust::UserSelected
                })
            })
            .collect();
        assert!(!selected.is_empty());
        for port in selected {
            let output = catalog_show(port);
            assert!(output.contains("Installation: user-managed existing installation"));
            assert!(output.contains("you or the upstream launcher manage setup and updates"));
            assert!(output.contains("external select-preview"));
            assert!(output.contains("--working-directory"));
            assert!(output.contains("--expected-preview"));
            assert!(!output.contains("Accepted runtime ("));
            assert!(!output.contains("Package SHA-256:"));
            assert!(!output.contains("external preview "));
            assert!(!output.contains("Package:  ("));
        }
    }

    #[test]
    fn catalog_detail_keeps_each_platform_with_its_distinct_accepted_package() {
        let mut port = external_port();
        port.platforms = vec![Platform::LinuxX86_64, Platform::WindowsX86_64];
        let mut linux = port.release.user_prepared[&Platform::WindowsX86_64].clone();
        linux.version = "v7.2.1".into();
        linux.archive_name = "fixture-linux-runtime.zip".into();
        linux.archive_size = 321;
        linux.archive_sha256 = "a".repeat(64);
        linux.executable = "bin/fixture-game".into();
        port.release
            .user_prepared
            .insert(Platform::LinuxX86_64, linux);
        let output = catalog_show(&port);
        let windows_heading = "Accepted runtime (Windows (x64)): v1.0.2";
        let linux_heading = "Accepted runtime (Linux (x64)): v7.2.1";
        let windows_position = output.find(windows_heading).unwrap();
        let linux_position = output.find(linux_heading).unwrap();
        assert!(windows_position < linux_position);
        let windows = &output[windows_position..linux_position];
        assert!(
            windows.contains("WaveRace64Recomp-1.0.2-windows-x64.zip (16.6 MiB; 17397538 bytes)")
        );
        assert!(!windows.contains("fixture-linux-runtime"));
        let linux = &output[linux_position..];
        assert!(linux.contains("Package: fixture-linux-runtime.zip (321 B; 321 bytes)"));
        assert!(linux.contains(&format!("Package SHA-256: {}", "a".repeat(64))));
        assert!(linux.contains("Executable: bin/fixture-game"));
        assert!(!linux.contains("WaveRace64Recomp.exe"));
    }

    #[test]
    fn catalog_detail_sanitizes_runtime_facts_without_changing_the_definition() {
        let mut port = external_port();
        let runtime = port
            .release
            .user_prepared
            .get_mut(&Platform::WindowsX86_64)
            .unwrap();
        runtime.version = "v2\nforged\u{1b}".into();
        runtime.archive_name = "package\r\nforged\u{7}.zip".into();
        runtime.archive_sha256 = "digest\tforged\u{1b}".into();
        runtime.executable = "bin/game\nforged\u{7}".into();
        let before = serde_json::to_value(&port).unwrap();
        let runtime = &port.release.user_prepared[&Platform::WindowsX86_64];
        let output = catalog_show(&port);
        for value in [
            &runtime.version,
            &runtime.archive_name,
            &runtime.archive_sha256,
            &runtime.executable,
        ] {
            assert!(
                output.contains(&clean(value)),
                "missing sanitized fact: {output}"
            );
            assert!(!output.contains(value));
        }
        assert!(!output.contains('\u{1b}'));
        assert!(!output.contains('\u{7}'));
        assert_eq!(serde_json::to_value(&port).unwrap(), before);
    }

    #[test]
    fn catalog_detail_does_not_invent_an_external_route_for_managed_or_missing_runtime() {
        let catalog = Catalog::embedded().unwrap();
        let managed = catalog_show(catalog.port("shipwright").unwrap());
        assert!(managed.contains("Installation: portable upstream package"));
        assert!(managed.contains("Saves and settings: managed by Portcove"));
        let mut absent = external_port();
        absent.release.user_prepared.clear();
        absent.presentation = None;
        let missing = catalog_show(&absent);
        let mut other_provider = external_port();
        other_provider.release.provider = ReleaseSource::Github;
        for output in [managed, missing, catalog_show(&other_provider)] {
            assert!(!output.contains("Accepted runtime ("));
            assert!(!output.contains("portcove external preview"));
            assert!(!output.contains("Maintenance: user-owned"));
        }
    }

    #[test]
    fn human_labels_preserve_platform_and_phase_machine_values() {
        for (platform, label, encoded) in [
            (Platform::WindowsX86_64, "Windows (x64)", "windows-x86-64"),
            (Platform::LinuxX86_64, "Linux (x64)", "linux-x86-64"),
            (Platform::MacosX86_64, "macOS (Intel)", "macos-x86-64"),
            (
                Platform::MacosAarch64,
                "macOS (Apple silicon)",
                "macos-aarch64",
            ),
        ] {
            assert_eq!(super::platform_name(platform), label);
            assert_eq!(serde_json::to_value(platform).unwrap(), encoded);
        }
        assert_eq!(
            super::phase_name("psx-toolchain-download"),
            "Downloading PlayStation build tools"
        );
        assert_eq!(
            super::phase_name("preparation.setup"),
            "Preparing game data"
        );
        assert_eq!(
            super::phase_name("unknown/private\u{1b}phase"),
            "Other operation phase"
        );
        assert_eq!(
            super::operation_event_name("check_update"),
            "Check for game updates"
        );
        assert_eq!(
            super::operation_event_name("unknown/private-operation"),
            "Other operation"
        );
    }

    #[test]
    fn failure_summary_keeps_committed_unknown_and_cancelled_outcomes_independent() {
        use portcove_core::{ErrorCode, MutationState, PortcoveError};
        for (state, expected) in [
            (MutationState::Committed, "The change was saved."),
            (
                MutationState::Unknown,
                "couldn't confirm whether anything changed",
            ),
            (MutationState::RecoveryRequired, "unfinished work"),
            (MutationState::NoChanges, "No files were changed"),
            (MutationState::NotStarted, "did not start"),
        ] {
            let report = PortcoveError::state("token=private-fixture-value")
                .with_mutation_state(state)
                .report();
            let before = serde_json::to_value(&report).unwrap();
            let rendered = super::failure(&report, false);
            assert!(rendered.starts_with("Error:"));
            assert!(rendered.contains(expected));
            assert!(!rendered.contains("private-fixture-value"));
            assert!(!rendered.contains("Technical details (redacted):"));
            assert_eq!(serde_json::to_value(&report).unwrap(), before);
        }
        let report = PortcoveError::new(ErrorCode::Cancelled, "token=private-fixture-value")
            .with_mutation_state(MutationState::NoChanges)
            .report();
        let rendered = super::failure(&report, false);
        assert!(rendered.starts_with("Operation cancelled."));
        assert!(!rendered.contains("Error:"));
        assert!(!rendered.contains("private-fixture-value"));
    }

    #[test]
    fn zero_counts_and_named_long_unicode_values_remain_readable() {
        let catalog = portcove_core::Catalog::embedded().unwrap();
        assert_eq!(
            super::catalog_list(&[]),
            "The active catalog contains no ports."
        );
        assert!(super::source_list(&[], &catalog).starts_with("No saved game-file"));
        assert!(super::port_name(&catalog, "starship").ends_with("(starship)"));
        let unknown = format!("{}\u{1b}\nend", "長い名前π".repeat(40));
        let rendered = super::port_name(&catalog, &unknown);
        assert!(rendered.contains("長い名前π"));
        assert!(rendered.contains("name unavailable"));
        assert!(!rendered.chars().any(char::is_control));
        assert_eq!(super::format_bytes(0), "0 B");
        assert_eq!(super::format_bytes(1), "1 B");
        assert_eq!(super::format_bytes(1024), "1.0 KiB");
    }
}
