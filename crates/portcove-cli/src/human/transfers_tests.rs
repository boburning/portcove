use super::*;
use std::path::PathBuf;

fn source() -> SourceRecord {
    SourceRecord {
        profile_id: "star-fox-64".into(),
        path: PathBuf::from("/game files/星の狐.z64"),
        sha256: "a".repeat(64),
        size: 2048,
        storage_sha256: "b".repeat(64),
        storage_size: 4096,
        updated_at: 42,
        observed_identity: None,
    }
}

#[test]
fn source_copy_success_keeps_retained_original_and_machine_facts_independent() {
    let catalog = Catalog::embedded().unwrap();
    let mut result = SourceImportResult {
        import_id: "copy-1".into(),
        profile_id: "star-fox-64".into(),
        mode: SourceImportMode::Move,
        outcome: SourceImportOutcome::CopiedOriginalRetained,
        registered: source(),
        copied: true,
        original_deleted: false,
        original_retained: true,
        retained_original_path: Some(PathBuf::from("/original/星の狐.z64")),
        recovered: true,
    };
    let before = serde_json::to_value(&result).unwrap();
    let text = source_import_result(&result, &catalog);
    assert!(text.starts_with("Game files copied and their new location saved; original retained"));
    assert!(text.contains("Original deleted: No"));
    assert!(text.contains("Retained original: /original/星の狐.z64"));
    assert!(text.contains(&"b".repeat(64)));
    assert_eq!(serde_json::to_value(&result).unwrap(), before);
    result.outcome = SourceImportOutcome::RegisteredCurrentLocation;
    result.copied = false;
    assert!(source_import_result(&result, &catalog).contains("Files copied: No"));
}

#[test]
fn source_relink_review_is_not_registration_or_a_move() {
    let source = source();
    let mut replacement = source.clone();
    replacement.path = PathBuf::from("/new\nlocation.z64");
    let plan = SourceRelinkPlan {
        original: source,
        replacement,
        preview_sha256: "c".repeat(64),
    };
    let text = source_relink_plan(&plan, &Catalog::embedded().unwrap());
    assert!(text.contains("Replacement location: /new location.z64"));
    assert!(text.contains("Neither original nor replacement files are moved or deleted"));
    assert!(text.contains(&format!("--expected-plan {}", "c".repeat(64))));
}

#[test]
fn source_removal_review_reports_dependencies_without_predicting_readiness() {
    let catalog = Catalog::embedded().unwrap();
    let mut preview = SourceRemovalPreview {
        source: source(),
        preview_sha256: "c".repeat(64),
        dependent_port_ids: vec!["starship".into()],
        installed_dependent_port_ids: vec!["starship".into()],
    };
    let before = serde_json::to_value(&preview).unwrap();
    let text = source_removal_preview(&preview, &catalog);
    assert!(text.contains(&format!(
        "Installed ports depending on this saved registration: {}",
        port_name(&catalog, "starship")
    )));
    assert!(text.contains("may need the game-file location to be registered again"));
    assert!(text.contains("does not assess their readiness after removal"));
    assert!(text.contains("Original game files stay in place."));
    assert!(!text.contains("will require"));
    assert!(!text.contains("not launchable"));
    assert!(text.contains(&"c".repeat(64)));
    assert_eq!(serde_json::to_value(&preview).unwrap(), before);

    preview.installed_dependent_port_ids.clear();
    let without_installed_dependents = source_removal_preview(&preview, &catalog);
    assert!(
        without_installed_dependents
            .contains("Installed ports depending on this saved registration: None")
    );
    assert!(!without_installed_dependents.contains("These ports may need"));
}

#[test]
fn aborted_restore_retains_files_without_offering_resume() {
    let mut result = LibraryImportResult {
        transfer_id: "restore-1".into(),
        destination_root: PathBuf::from("/restored"),
        completed: false,
        input_retained: true,
    };
    let before = serde_json::to_value(&result).unwrap();
    let text = library_import_result(&result);
    assert!(text.starts_with("Library restore not completed"));
    assert!(text.contains("aborted import cannot resume"));
    assert!(text.contains("Copied files are retained"));
    assert_eq!(serde_json::to_value(&result).unwrap(), before);
    result.completed = true;
    assert!(library_import_result(&result).starts_with("Library restore completed"));
}

#[test]
fn restore_review_keeps_metadata_payload_destination_and_full_fingerprint_separate() {
    let metadata = LibraryMetadata {
        schema_version: 1,
        exported_at: 42,
        original_root: PathBuf::from("/original"),
        content_roots: vec![],
        source_references: vec![source()],
        application_versions: vec![],
        retained_build_references: vec![],
        port_settings: vec![],
        launch_history: vec![],
        artwork: None,
        portability_authority: None,
    };
    let plan = LibraryImportPlan {
        metadata_file: LibraryMetadataFile {
            path: PathBuf::from("/export/metadata.json"),
            sha256: "a".repeat(64),
            size: 1024,
        },
        content_root: PathBuf::from("/copied payload"),
        destination_root: PathBuf::from("/restore target"),
        destination_exists: false,
        metadata,
        content: vec![],
        required_bytes: 2048,
        available_bytes: 4096,
        plan_sha256: "b".repeat(64),
    };
    let before = serde_json::to_value(&plan).unwrap();
    let text = library_import_plan(&plan);
    assert!(text.contains("Metadata file: /export/metadata.json"));
    assert!(text.contains("Payload folder: /copied payload"));
    assert!(text.contains("New or empty destination: /restore target"));
    assert!(text.contains("No managed content files."));
    assert!(text.contains("Metadata alone is not a library backup."));
    assert!(text.contains(&format!("--expected-plan {}", "b".repeat(64))));
    assert!(text.contains("Working space required: 2.0 KiB"));
    assert_eq!(serde_json::to_value(&plan).unwrap(), before);
    let summary = library_metadata(&plan.metadata);
    assert!(summary.contains("Saved game-file references: 1"));
    assert!(summary.contains("no export file was written"));
    assert!(!summary.contains("/game files/"));
    let exported = library_metadata_file(&plan.metadata_file);
    assert!(exported.contains("Library metadata exported"));
    assert!(exported.contains(&"a".repeat(64)));
}
