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
    assert!(backup_deleted(&backup(), &catalog).contains("archive folder is no longer retained"));
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
            "Game update kept for later without activation",
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

#[test]
fn installed_file_check_names_recorded_manifest_scope_without_gameplay_assurance() {
    let catalog = Catalog::embedded().unwrap();
    for valid in [true, false] {
        let report = portcove_core::VerificationReport {
            install_id: "retained-instance".into(),
            checked_files: 3,
            valid,
            failures: if valid {
                vec![]
            } else {
                vec!["changed: game.exe".into()]
            },
        };
        let text = verification_report(&report, "starship", &catalog);
        assert!(text.contains("Scope: All files in the recorded installation manifest; launch-critical checks are separate."));
        assert!(text.contains("Checked files: 3"));
        if valid {
            assert!(text.contains("Recorded file checks passed"));
            assert!(text.contains("does not prove gameplay or saved-data compatibility"));
        } else {
            assert!(text.contains("changed: game.exe"));
            assert!(text.contains("Preserve local files"));
        }
    }
}
