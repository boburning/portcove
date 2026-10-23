//! Task-specific summaries. Core records remain the authority for every outcome.
use portcove_core::{
    AdoptionPreview, BackupRecord, CancellationPhase, CancellationState, Catalog,
    ExternalRuntimePreview, ExternalRuntimeRecord, ExternalRuntimeRelinkPreview,
    ExternalRuntimeRemovalPreview, InstallRecord, OutputRelocationResult, PortRemovalPreview,
    ReconcileAction, ReconcileResult, RestoreResult, UpdateCheck, VerificationReport,
};

use super::{clean, format_bytes, platform_name, port_name, release_channel, utc_time};

pub(crate) fn install_result(install: &InstallRecord, catalog: &Catalog) -> String {
    let mut text = format!(
        "Managed installation result\nPort: {}\nInstallation: {}\nVersion: {}\nChannel: {}\nLocation: {}\nInstalled: {}\nStaged: {}\nRecorded file verification: {}",
        port_name(catalog, &install.port_id),
        clean(&install.id),
        clean(&install.version),
        release_channel(install.channel),
        clean(&install.path.display().to_string()),
        utc_time(install.installed_at),
        if install.staged { "Yes" } else { "No" },
        if install.verified {
            "Passed"
        } else {
            "Not established"
        },
    );
    if !install.artifact.sha256.is_empty() {
        text.push_str(&format!(
            "\nRelease file: {}\nRelease SHA-256: {}\nRelease size: {} ({} bytes)",
            clean(&install.artifact.asset_name),
            clean(&install.artifact.sha256),
            format_bytes(install.artifact.size),
            install.artifact.size
        ));
    }
    if !install.manifest_sha256.is_empty() {
        text.push_str(&format!(
            "\nInstallation manifest SHA-256: {}",
            clean(&install.manifest_sha256)
        ));
    }
    if let Some(runtime) = &install.runtime {
        text.push_str(&format!(
            "\nRequired runtime component: {}\nRuntime SHA-256: {}",
            clean(&runtime.artifact.asset_name),
            clean(&runtime.artifact.sha256)
        ));
    }
    text.push_str(&format!(
        "\nNext step: Using the same library, run portcove status {} to inspect the current installation and launch requirements.{}",
        clean(&install.port_id),
        if install.staged { " This release is staged; it has not been activated by this result." } else { "" },
    ));
    text
}

pub(crate) fn verification_report(
    report: &VerificationReport,
    port_id: &str,
    catalog: &Catalog,
) -> String {
    let mut text = format!(
        "Installed file check\nPort: {}\nInstallation: {}\nChecked files: {}\nResult: {}",
        port_name(catalog, port_id),
        clean(&report.install_id),
        report.checked_files,
        if report.valid {
            "Recorded file checks passed"
        } else {
            "Installed files do not match the expected record"
        },
    );
    for failure in &report.failures {
        text.push_str(&format!(
            "\nFinding: {}",
            clean(&portcove_core::redact_diagnostic_text(failure))
        ));
    }
    text.push_str(&format!("\nNext step: Using the same library, run portcove status {} to inspect current readiness.{}", clean(port_id),
        if report.valid { " This checks recorded installation files; it does not prove gameplay or saved-data compatibility." }
        else { " Preserve local files before reviewing a replacement or another recovery action." },
    ));
    text
}

pub(crate) fn update_check(check: &UpdateCheck, catalog: &Catalog) -> String {
    format!(
        "Game update check\nPort: {}\nChannel: {}\nInstalled version: {}\nAvailable version: {}\nUpdate available: {}\nRelease file: {}\nRelease SHA-256: {}\nDownload size: {} ({} bytes)\nNo update was applied by this check.\nNext step: {}",
        port_name(catalog, &check.port_id),
        release_channel(check.channel),
        check
            .installed_version
            .as_deref()
            .map(clean)
            .unwrap_or_else(|| "None".into()),
        clean(&check.release.version),
        if check.update_available { "Yes" } else { "No" },
        clean(&check.release.asset.name),
        clean(&check.release.asset.sha256),
        format_bytes(check.release.asset.size),
        check.release.asset.size,
        if check.update_available {
            format!(
                "Using the same library, run portcove update {} to apply the available update, or add --stage to download and check it without activation.",
                clean(&check.port_id)
            )
        } else {
            format!(
                "Using the same library, run portcove status {} to inspect current readiness.",
                clean(&check.port_id)
            )
        },
    )
}

pub(crate) fn reconcile_result(result: &ReconcileResult, catalog: &Catalog) -> String {
    let outcome = match result.action {
        ReconcileAction::UpToDate => "No game update was needed",
        ReconcileAction::Notify => "Game update available; no update was applied",
        ReconcileAction::Staged => "Game update staged without activation",
        ReconcileAction::Activated => "Game update activated",
    };
    let mut text = format!(
        "{outcome}\nPort: {}\nSaved update policy: {}\nAvailable version: {}",
        port_name(catalog, &result.port_id),
        super::update_policy_name(result.policy),
        clean(&result.check.release.version),
    );
    if let Some(install) = &result.install {
        text.push_str(&format!(
            "\nInstallation: {}\nVersion: {}\nLocation: {}",
            clean(&install.id),
            clean(&install.version),
            clean(&install.path.display().to_string())
        ));
    }
    text.push_str(&format!("\nNext step: Using the same library, run portcove status {} to inspect the resulting readiness.", clean(&result.port_id)));
    text
}

pub(crate) fn adoption_preview(preview: &AdoptionPreview, catalog: &Catalog) -> String {
    let mut text = format!(
        "Copy existing installation review\nOriginal: {}\nSelected port: {}\nDetected ports: {}\nFiles to copy: {}\nFolders to copy: {}\nCopy size: {}\nSkipped entries: {}\nOriginal will be modified: {}\nReview SHA-256: {}",
        clean(&preview.source.display().to_string()),
        preview
            .selected_port_id
            .as_deref()
            .map(|id| port_name(catalog, id))
            .unwrap_or_else(|| "Not selected".into()),
        if preview.detected_port_ids.is_empty() {
            "None".into()
        } else {
            preview
                .detected_port_ids
                .iter()
                .map(|id| port_name(catalog, id))
                .collect::<Vec<_>>()
                .join(", ")
        },
        preview.copy_plan.files.len(),
        preview.copy_plan.directories.len(),
        format_bytes(preview.copy_plan.total_bytes),
        preview.copy_plan.skipped_entries.len(),
        if preview.original_will_be_modified {
            "Yes"
        } else {
            "No"
        },
        clean(&preview.plan_sha256),
    );
    if let Some(destination) = &preview.destination {
        text.push_str(&format!(
            "\nManaged destination: {}\nCurrent managed save/settings files: {}",
            clean(
                &destination
                    .output_location
                    .effective_output_directory
                    .display()
                    .to_string()
            ),
            destination.current_user_data_files
        ));
        if let Some(install) = &destination.active_install {
            text.push_str(&format!(
                "\nCurrent active installation: {} ({})",
                clean(&install.version),
                clean(&install.id)
            ));
        }
        if let Some(digest) = &destination.current_user_data_sha256 {
            text.push_str(&format!(
                "\nCurrent saves/settings SHA-256: {}",
                clean(digest)
            ));
        }
        for path in &destination.imported_user_data_paths {
            text.push_str(&format!(
                "\nSave/settings path to import: {}",
                clean(&path.display().to_string())
            ));
        }
    }
    for entry in &preview.copy_plan.skipped_entries {
        text.push_str(&format!(
            "\nSkipped: {} — {}",
            clean(&entry.relative_path.display().to_string()),
            clean(&entry.reason)
        ));
    }
    text.push_str("\nReview only; no files were copied. Confirmation is bound to this exact copy plan; changed inputs require a new review.");
    text
}

fn backup_details(backup: &BackupRecord, catalog: &Catalog) -> String {
    format!(
        "Port: {}\nBackup: {}\nArchive folder: {}\nCreated: {}\nFiles: {}\nSize: {} ({} bytes)\nBackup SHA-256: {}",
        port_name(catalog, &backup.port_id),
        clean(&backup.id),
        clean(&backup.path.display().to_string()),
        utc_time(backup.created_at),
        backup.file_count,
        format_bytes(backup.size),
        backup.size,
        clean(&backup.sha256),
    )
}

pub(crate) fn backup_created(backup: &BackupRecord, catalog: &Catalog) -> String {
    format!(
        "Save/settings backup created\n{}\nNext step: Use backup list {} to inspect retained backups. This backup contains managed saves and settings, not application versions or original game files.",
        backup_details(backup, catalog),
        clean(&backup.port_id)
    )
}

pub(crate) fn backup_deleted(backup: &BackupRecord, catalog: &Catalog) -> String {
    format!(
        "Selected backup deleted\n{}\nThis describes the deleted backup; its archive folder is no longer retained. Live managed saves and settings and other backups are preserved.\nNext step: Use backup list {} to inspect the remaining inventory.",
        backup_details(backup, catalog),
        clean(&backup.port_id)
    )
}

pub(crate) fn backup_restored(result: &RestoreResult, catalog: &Catalog) -> String {
    let mut text = format!(
        "Managed saves and settings restored\n{}\nApplication versions and original game files were not replaced.",
        backup_details(&result.restored_backup, catalog)
    );
    match &result.safety_backup {
        Some(backup) => text.push_str(&format!(
            "\nSafety backup of prior data retained:\n{}",
            backup_details(backup, catalog)
        )),
        None => text.push_str(
            "\nSafety backup: none was created; there were no current files to preserve.",
        ),
    }
    text.push_str(&format!(
        "\nNext step: Use backup list {} to inspect the retained restore and safety backups.",
        clean(&result.restored_backup.port_id)
    ));
    text
}

pub(crate) fn cancellation_requested(state: &CancellationState, operation_id: &str) -> String {
    let observation = match (state.phase, state.requested) {
        (CancellationPhase::Preparing, true) => {
            "Cancellation requested. Work may still be stopping safely."
        }
        (CancellationPhase::Finishing, true) => {
            "Cancellation was requested; the operation is finishing its protected publication step."
        }
        (CancellationPhase::Preparing, false) => {
            "Cancellation has not been requested; the operation is still preparing."
        }
        (CancellationPhase::Finishing, false) => {
            "The operation is finishing its protected publication step; cancellation was not requested."
        }
    };
    format!(
        "{observation}\nActivity: {}\nThis request is not a terminal outcome.\nNext step: Using the same library, run portcove activity and inspect this activity's durable result.",
        clean(operation_id)
    )
}

pub(crate) fn external_preview(preview: &ExternalRuntimePreview, catalog: &Catalog) -> String {
    if let Some(selection) = &preview.user_selected {
        return format!(
            "User-managed installation review\nPort: {}\nExecutable: {}\nWorking directory: {}\nArguments: {}\nReview SHA-256: {}\nYou selected this executable. Portcove has not authenticated it as an official package. You or the upstream launcher own setup and updates. Portcove will launch it and can remove the registration; it does not update, back up, restore, roll back or delete its files.\nNext step: Use external select with the same executable, working directory, arguments and --expected-preview {}.",
            port_name(catalog, &preview.port_id),
            clean(&preview.executable.display().to_string()),
            clean(&preview.path.display().to_string()),
            clean(&serde_json::to_string(&selection.arguments).unwrap_or_default()),
            clean(&preview.preview_sha256),
            clean(&preview.preview_sha256)
        );
    }
    let mut text = format!(
        "Existing installation review\nPort: {}\nFolder: {}\nExecutable: {}\nVersion: {}\nImmutable files checked: {}\nPackage SHA-256: {}\nImmutable tree SHA-256: {}\nReview SHA-256: {}\nReview only; no installation was registered. Portcove will use the selected folder in place. It does not copy, update, back up or delete its external files.",
        port_name(catalog, &preview.port_id),
        clean(&preview.path.display().to_string()),
        clean(&preview.executable.display().to_string()),
        clean(&preview.version),
        preview.immutable_file_count,
        clean(&preview.archive_sha256),
        clean(&preview.immutable_tree_sha256),
        clean(&preview.preview_sha256),
    );
    if let Some(shared) = &preview.shared_preferences {
        match shared.write_scope_disclosure() {
            Ok(disclosure) => text.push_str(&format!("\n{}", clean(&disclosure))),
            Err(_) => text.push_str("\nShared preferences scope could not be displayed. Do not confirm this review; inspect the current state again."),
        }
    }
    text.push_str(&format!("\nNext step: Use external register with this same port and folder and --expected-preview {}. Review any shared preferences scope before explicitly acknowledging it.", clean(&preview.preview_sha256)));
    text
}

pub(crate) fn external_relink_preview(
    preview: &ExternalRuntimeRelinkPreview,
    catalog: &Catalog,
) -> String {
    if let Some(selection) = &preview.proposed.user_selected {
        return format!(
            "Selected launch details review\nPort: {}\nRegistration: {}\nPrevious folder: {}\nExecutable: {}\nWorking directory: {}\nArguments: {}\nPreview SHA-256: {}\nAll old and new files remain user-owned. Portcove has not authenticated this executable as an official package.\nNext step: external select-relink with these same launch details and --expected-preview {}.",
            port_name(catalog, &preview.port_id),
            clean(&preview.registration_id),
            clean(&preview.previous_path.display().to_string()),
            clean(&preview.proposed.executable.display().to_string()),
            clean(&preview.proposed.path.display().to_string()),
            clean(&serde_json::to_string(&selection.arguments).unwrap_or_default()),
            clean(&preview.preview_sha256),
            clean(&preview.preview_sha256),
        );
    }
    let mut text = format!(
        "Existing installation location review\nPort: {}\nRegistration: {}\nPrevious folder: {}\nProposed folder: {}\nVersion: {}\nPackage SHA-256: {}\nImmutable tree SHA-256: {}\nReview SHA-256: {}\nExternal files preserved: {}\nReview only; no saved location changed. This does not copy, update, back up or delete either folder.",
        port_name(catalog, &preview.port_id),
        clean(&preview.registration_id),
        clean(&preview.previous_path.display().to_string()),
        clean(&preview.proposed.path.display().to_string()),
        clean(&preview.proposed.version),
        clean(&preview.proposed.archive_sha256),
        clean(&preview.proposed.immutable_tree_sha256),
        clean(&preview.preview_sha256),
        if preview.external_files_will_be_preserved {
            "Yes"
        } else {
            "No"
        },
    );
    if let Some(shared) = &preview.proposed.shared_preferences {
        match shared.write_scope_disclosure() {
            Ok(disclosure) => text.push_str(&format!("\n{}", clean(&disclosure))),
            Err(_) => text.push_str("\nShared preferences scope could not be displayed. Do not confirm this review; inspect the current state again."),
        }
    }
    text.push_str(&format!("\nNext step: Use external relink with this same port and proposed folder and --expected-preview {}. Shared preferences, when present, require their separate explicit acknowledgement.", clean(&preview.preview_sha256)));
    text
}

pub(crate) fn external_removal_preview(
    preview: &ExternalRuntimeRemovalPreview,
    catalog: &Catalog,
) -> String {
    format!(
        "Stop using existing installation review\nPort: {}\nFolder: {}\nVersion: {}\nExternal files preserved: {}\nReview SHA-256: {}\nReview only; the registration is still present.\nNext step: Use external remove with this port and --expected-preview {} to remove only its Portcove registration.",
        port_name(catalog, &preview.port_id),
        clean(&preview.path.display().to_string()),
        clean(&preview.version),
        if preview.external_files_will_be_preserved {
            "Yes"
        } else {
            "No"
        },
        clean(&preview.preview_sha256),
        clean(&preview.preview_sha256),
    )
}

pub(crate) fn external_runtime(runtime: &ExternalRuntimeRecord, catalog: &Catalog) -> String {
    if let Some(selection) = &runtime.user_selected {
        return format!(
            "User-managed installation registration saved\nPort: {}\nRegistration: {}\nExecutable: {}\nWorking directory: {}\nArguments: {}\nYou or the upstream launcher manage setup and updates. Portcove has not authenticated these bytes as an official package. External files, saves and settings remain user-owned.\nNext step: Using the same library, run portcove status {} to inspect launch readiness.",
            port_name(catalog, &runtime.port_id),
            clean(&runtime.id),
            clean(&runtime.executable.display().to_string()),
            clean(&runtime.path.display().to_string()),
            clean(&serde_json::to_string(&selection.arguments).unwrap_or_default()),
            clean(&runtime.port_id)
        );
    }
    format!(
        "Existing installation registration saved\nPort: {}\nRegistration: {}\nFolder: {}\nExecutable: {}\nVersion: {}\nPlatform: {}\nRegistered: {}\nPackage SHA-256: {}\nImmutable tree SHA-256: {}\nExternal files, saves and settings remain user-owned.\nNext step: Using the same library, run portcove status {} to inspect launch readiness.",
        port_name(catalog, &runtime.port_id),
        clean(&runtime.id),
        clean(&runtime.path.display().to_string()),
        clean(&runtime.executable.display().to_string()),
        clean(&runtime.version),
        platform_name(runtime.platform),
        utc_time(runtime.registered_at),
        clean(&runtime.archive_sha256),
        clean(&runtime.immutable_tree_sha256),
        clean(&runtime.port_id),
    )
}

pub(crate) fn removal_preview(preview: &PortRemovalPreview, catalog: &Catalog) -> String {
    format!(
        "Managed installation removal review\nPort: {}\nManaged locations to remove: {}\n{}\nSaves and settings: {}\nSaves and settings preserved: {}\nReview SHA-256: {}\nReview only; no installed versions were removed.\nNext step: Use remove with this port and --expected-preview {} to confirm this exact inventory.",
        port_name(catalog, &preview.port_id),
        preview.managed_paths.len(),
        preview
            .managed_paths
            .iter()
            .map(|path| format!("  {}", clean(&path.display().to_string())))
            .collect::<Vec<_>>()
            .join("\n"),
        clean(&preview.persistent_data_path.display().to_string()),
        if preview.persistent_data_will_be_preserved {
            "Yes"
        } else {
            "No"
        },
        clean(&preview.preview_sha256),
        clean(&preview.preview_sha256),
    )
}

pub(crate) fn output_relocation_result(
    result: &OutputRelocationResult,
    catalog: &Catalog,
) -> String {
    let retained = result
        .old_paths_retained
        .iter()
        .map(|path| format!("  {}", clean(&path.display().to_string())))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "Installed versions relocated\nPort: {}\nOperation: {}\nAuthoritative install folder: {}\nRelocated installations: {}\nOld locations retained: {}\n{}\nCleanup pending: {}\nNext step: {}",
        port_name(catalog, &result.port_id),
        clean(&result.operation_id),
        clean(
            &result
                .output_location
                .effective_output_directory
                .display()
                .to_string()
        ),
        result.relocated_installs.len(),
        result.old_paths_retained.len(),
        if retained.is_empty() {
            "  None"
        } else {
            &retained
        },
        if result.cleanup_pending { "Yes" } else { "No" },
        if result.cleanup_pending {
            "The relocation succeeded. Restart Portcove to retry cleanup, then inspect doctor before deleting any retained location manually.".into()
        } else {
            format!(
                "Using the same library, run portcove paths {} to inspect the current locations.",
                clean(&result.port_id)
            )
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn backup() -> BackupRecord {
        BackupRecord {
            id: "backup-1".into(),
            port_id: "starship".into(),
            path: PathBuf::from("/library/备份/backup-1"),
            created_at: 42,
            file_count: 1,
            size: 1536,
            sha256: "f".repeat(64),
        }
    }

    #[test]
    fn adoption_review_binds_named_ports_copy_inventory_and_current_saves_without_mutation() {
        use portcove_core::{
            AdoptionCopyFile, AdoptionCopyPlan, AdoptionDestinationPreview, AdoptionSkippedEntry,
            OutputLocationSource, PortOutputLocation, ReleaseChannel,
        };
        let catalog = Catalog::embedded().unwrap();
        let destination = PathBuf::from("/managed\nゲーム\u{1b}");
        let mut preview = AdoptionPreview {
            source: PathBuf::from("/original\nゲーム\u{1b}"),
            detected_port_ids: vec!["starship".into(), "shipwright".into()],
            selected_port_id: Some("starship".into()),
            application_files_will_be_copied: true,
            original_will_be_modified: false,
            copy_plan: AdoptionCopyPlan {
                directories: vec!["saves".into(), "settings".into(), "empty".into()],
                files: vec![
                    AdoptionCopyFile {
                        relative_path: "game".into(),
                        size: 1024,
                        sha256: "a".repeat(64),
                    },
                    AdoptionCopyFile {
                        relative_path: "saves/slot.bin".into(),
                        size: 512,
                        sha256: "b".repeat(64),
                    },
                ],
                skipped_entries: vec![AdoptionSkippedEntry {
                    relative_path: "linked\nentry\u{1b}".into(),
                    reason: "symbolic\tlink".into(),
                }],
                total_bytes: 1536,
            },
            destination: Some(AdoptionDestinationPreview {
                output_location: PortOutputLocation {
                    port_id: "starship".into(),
                    library_root: "/library".into(),
                    default_output_directory: "/library/ports".into(),
                    configured_output_directory: Some(destination.clone()),
                    effective_output_directory: destination,
                    selection_source: OutputLocationSource::PortSetting,
                    user_data_root: "/library/user/starship".into(),
                },
                active_install: Some(InstallRecord {
                    id: "retained-install".into(),
                    port_id: "starship".into(),
                    version: "upstream\nversion\u{1b}".into(),
                    path: "/managed/retained-install".into(),
                    channel: ReleaseChannel::Stable,
                    installed_at: 42,
                    verified: true,
                    staged: false,
                    artifact: Default::default(),
                    runtime: None,
                    manifest_sha256: "c".repeat(64),
                    selected_executable: "game".into(),
                }),
                imported_user_data_paths: vec![
                    "saves/セーブ\nslot.bin".into(),
                    "settings/preferences.json".into(),
                ],
                current_user_data_files: 5,
                current_user_data_sha256: Some("d".repeat(64)),
            }),
            plan_sha256: "e".repeat(64),
        };
        for modifies_original in [false, true] {
            preview.original_will_be_modified = modifies_original;
            let before = serde_json::to_value(&preview).unwrap();
            let text = adoption_preview(&preview, &catalog);
            let selected_name = &catalog.port("starship").unwrap().name;
            let other_name = &catalog.port("shipwright").unwrap().name;
            assert!(text.contains(&format!("Selected port: {selected_name} (starship)")));
            assert!(text.contains(&format!(
                "Detected ports: {selected_name} (starship), {other_name} (shipwright)"
            )));
            for line in [
                "Original: /original ゲーム",
                "Managed destination: /managed ゲーム",
                "Files to copy: 2",
                "Folders to copy: 3",
                "Copy size: 1.5 KiB",
                "Skipped entries: 1",
                "Current managed save/settings files: 5",
                "Current active installation: upstream version (retained-install)",
                "Save/settings path to import: saves/セーブ slot.bin",
                "Save/settings path to import: settings/preferences.json",
                "Skipped: linked entry — symbolic link",
            ] {
                assert!(
                    text.lines().any(|actual| actual == line),
                    "missing {line}: {text}"
                );
            }
            assert!(text.contains(&format!(
                "Current saves/settings SHA-256: {}",
                "d".repeat(64)
            )));
            assert!(text.contains(&format!("Review SHA-256: {}", "e".repeat(64))));
            assert!(text.contains(&format!(
                "Original will be modified: {}",
                if modifies_original { "Yes" } else { "No" }
            )));
            assert!(text.contains("Review only; no files were copied."));
            assert!(!text.contains("Installation copied"));
            assert!(
                text.chars()
                    .all(|character| !character.is_control() || character == '\n')
            );
            assert_eq!(serde_json::to_value(&preview).unwrap(), before);
        }
    }

    #[test]
    fn removal_review_keeps_exact_inventory_and_core_preservation_flag_without_claiming_removal() {
        let catalog = Catalog::embedded().unwrap();
        let mut preview = PortRemovalPreview {
            port_id: "starship".into(),
            managed_paths: vec![
                "/managed/active\nゲーム\u{1b}".into(),
                "/managed/previous π".into(),
            ],
            persistent_data_path: "/library/セーブ\tsettings\u{1b}".into(),
            persistent_data_will_be_preserved: true,
            preview_sha256: "f".repeat(64),
        };
        for preserves_data in [true, false] {
            preview.persistent_data_will_be_preserved = preserves_data;
            let before = serde_json::to_value(&preview).unwrap();
            let text = removal_preview(&preview, &catalog);
            assert!(text.starts_with("Managed installation removal review\n"));
            assert!(text.contains(&format!(
                "Port: {} (starship)",
                catalog.port("starship").unwrap().name
            )));
            assert!(text.contains("Managed locations to remove: 2"));
            assert!(text.lines().any(|line| line == "  /managed/active ゲーム"));
            assert!(text.lines().any(|line| line == "  /managed/previous π"));
            assert!(
                text.lines()
                    .any(|line| line == "Saves and settings: /library/セーブ settings")
            );
            assert!(text.contains(&format!(
                "Saves and settings preserved: {}",
                if preserves_data { "Yes" } else { "No" }
            )));
            assert!(text.contains(&format!("Review SHA-256: {}", "f".repeat(64))));
            assert!(text.contains(&format!("--expected-preview {}", "f".repeat(64))));
            assert!(text.contains("Review only; no installed versions were removed."));
            assert!(!text.contains("Managed versions removed"));
            assert!(
                text.chars()
                    .all(|character| !character.is_control() || character == '\n')
            );
            assert_eq!(serde_json::to_value(&preview).unwrap(), before);
        }
        preview.managed_paths.clear();
        assert!(removal_preview(&preview, &catalog).contains("Managed locations to remove: 0"));
    }

    #[test]
    fn backup_completion_keeps_restore_and_safety_copy_distinct() {
        let catalog = Catalog::embedded().unwrap();
        let mut result = RestoreResult {
            restored_backup: backup(),
            safety_backup: None,
        };
        let before = serde_json::to_value(&result).unwrap();
        let text = backup_restored(&result, &catalog);
        assert!(text.starts_with("Managed saves and settings restored\n"));
        assert!(text.contains("Application versions and original game files were not replaced."));
        assert!(!text.contains("next Portcove launch"));
        assert!(!text.contains("active release"));
        assert!(text.contains("Backup: backup-1"));
        assert!(text.contains("Safety backup: none was created"));
        assert!(text.contains("1970-01-01T00:00:42Z"));
        assert!(text.contains("1.5 KiB (1536 bytes)"));
        assert!(text.contains(&"f".repeat(64)));
        assert_eq!(serde_json::to_value(&result).unwrap(), before);
        result.safety_backup = Some(BackupRecord {
            id: "safety-2".into(),
            ..backup()
        });
        let with_safety = backup_restored(&result, &catalog);
        assert!(with_safety.contains("Backup: backup-1"));
        assert!(with_safety.contains("Safety backup of prior data retained:\n"));
        assert!(with_safety.contains("Backup: safety-2"));
        assert!(
            backup_deleted(&backup(), &catalog).contains("archive folder is no longer retained")
        );
    }

    #[test]
    fn cancellation_request_never_claims_terminal_cancellation() {
        for phase in [CancellationPhase::Preparing, CancellationPhase::Finishing] {
            for requested in [false, true] {
                let state = CancellationState { phase, requested };
                let before = serde_json::to_value(&state).unwrap();
                let text = cancellation_requested(&state, "operation-1");
                assert!(text.contains("This request is not a terminal outcome."));
                assert!(!text.contains("Operation cancelled"));
                assert_eq!(serde_json::to_value(&state).unwrap(), before);
            }
        }
    }

    #[test]
    fn installation_result_does_not_invent_download_or_current_activation() {
        let record = InstallRecord {
            id: "install-1".into(),
            port_id: "starship".into(),
            version: "Beta upstream build".into(),
            path: PathBuf::from("/library/ゲーム"),
            channel: portcove_core::ReleaseChannel::Beta,
            installed_at: 42,
            verified: true,
            staged: true,
            artifact: Default::default(),
            runtime: None,
            manifest_sha256: "a".repeat(64),
            selected_executable: PathBuf::from("game"),
        };
        let before = serde_json::to_value(&record).unwrap();
        let text = install_result(&record, &Catalog::embedded().unwrap());
        assert!(text.contains("Channel: Preview"));
        assert!(text.contains("Version: Beta upstream build"));
        assert!(text.contains("has not been activated by this result"));
        assert!(!text.contains("downloaded"));
        assert_eq!(serde_json::to_value(&record).unwrap(), before);
    }

    #[test]
    fn update_policy_summaries_follow_each_core_outcome_without_inventing_an_install() {
        let catalog = Catalog::embedded().unwrap();
        let check: UpdateCheck = serde_json::from_value(serde_json::json!({
            "port_id": "starship", "channel": "stable", "installed_version": "1",
            "update_available": true, "release": { "version": "2", "channel": "stable", "published_at": null,
                "asset": { "name": "release.zip", "url": "https://example.invalid/release", "size": 1024, "sha256": "a".repeat(64) } }
        })).unwrap();
        for (action, headline) in [
            (ReconcileAction::UpToDate, "No game update was needed"),
            (
                ReconcileAction::Notify,
                "Game update available; no update was applied",
            ),
            (
                ReconcileAction::Staged,
                "Game update staged without activation",
            ),
            (ReconcileAction::Activated, "Game update activated"),
        ] {
            let result = ReconcileResult {
                port_id: "starship".into(),
                policy: portcove_core::UpdatePolicy::Notify,
                action,
                check: check.clone(),
                install: None,
            };
            let before = serde_json::to_value(&result).unwrap();
            let text = reconcile_result(&result, &catalog);
            assert!(text.starts_with(headline));
            assert!(!text.contains("Installation:"));
            assert!(text.contains("(starship)"));
            assert_eq!(serde_json::to_value(&result).unwrap(), before);
        }
        let text = update_check(&check, &catalog);
        assert!(text.contains("No update was applied by this check."));
        assert!(text.contains(&"a".repeat(64)));
        assert!(text.contains("1.0 KiB (1024 bytes)"));
    }

    #[test]
    fn relocation_success_retains_cleanup_paths_and_does_not_report_a_failed_move() {
        let result: OutputRelocationResult = serde_json::from_value(serde_json::json!({
            "operation_id": "relocate-1", "port_id": "starship",
            "output_location": { "port_id": "starship", "library_root": "/library", "default_output_directory": "/library/ports",
                "configured_output_directory": "/new", "effective_output_directory": "/new", "selection_source": "port_setting", "user_data_root": "/library/user" },
            "relocated_installs": [], "old_paths_retained": ["/old/one", "/old/二"], "cleanup_pending": true
        })).unwrap();
        let before = serde_json::to_value(&result).unwrap();
        let text = output_relocation_result(&result, &Catalog::embedded().unwrap());
        assert!(text.starts_with("Installed versions relocated"));
        assert!(text.contains("Authoritative install folder: /new"));
        assert!(text.contains("Old locations retained: 2"));
        assert!(text.contains("/old/one"));
        assert!(text.contains("/old/二"));
        assert!(text.contains("The relocation succeeded."));
        assert!(text.contains("Cleanup pending: Yes"));
        assert_eq!(serde_json::to_value(&result).unwrap(), before);
    }

    #[test]
    fn external_review_and_result_keep_registered_state_distinct_and_sanitize_controls() {
        let catalog = Catalog::embedded().unwrap();
        let preview = ExternalRuntimePreview {
            user_selected: None,
            port_id: "starship".into(),
            path: PathBuf::from("/owned/ゲーム\nfolder"),
            executable: PathBuf::from("/owned/ゲーム/game"),
            version: "2\u{1b}[31m".into(),
            archive_sha256: "a".repeat(64),
            immutable_tree_sha256: "b".repeat(64),
            immutable_file_count: 3,
            preview_sha256: "c".repeat(64),
            shared_preferences: None,
        };
        let before = serde_json::to_value(&preview).unwrap();
        let text = external_preview(&preview, &catalog);
        assert!(text.contains("Review only; no installation was registered."));
        assert!(text.contains("Immutable files checked: 3"));
        for digest in ["a".repeat(64), "b".repeat(64), "c".repeat(64)] {
            assert!(text.contains(&digest));
        }
        assert!(text.contains("/owned/ゲーム folder"));
        assert!(!text.contains('\u{1b}'));
        assert_eq!(serde_json::to_value(&preview).unwrap(), before);
    }
}
