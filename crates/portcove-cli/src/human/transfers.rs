//! Human summaries of Core-owned source and library transfer results.
use portcove_core::{
    Catalog, LibraryContentKind, LibraryImportPlan, LibraryImportResult, LibraryMetadata,
    LibraryMetadataFile, SourceImportMode, SourceImportOutcome, SourceImportPlan,
    SourceImportResult, SourceRecord, SourceRelinkPlan, SourceRemovalPreview,
};

use super::{clean, format_bytes, port_name, profile_name, utc_time};

pub(crate) fn source_record(source: &SourceRecord, catalog: &Catalog) -> String {
    format!(
        "Saved game-file location\nProfile: {}\nPath: {}\nContent SHA-256: {}\nContent size: {} ({} bytes)\nStored file SHA-256: {}\nStored file size: {} ({} bytes)\nUpdated: {}\nNext step: Using the same library, inspect the saved location with portcove source inspect {}.",
        profile_name(catalog, &source.profile_id),
        clean(&source.path.display().to_string()),
        clean(&source.sha256),
        format_bytes(source.size),
        source.size,
        clean(&source.storage_sha256),
        format_bytes(source.storage_size),
        source.storage_size,
        utc_time(source.updated_at),
        clean(&source.profile_id),
    )
}

pub(crate) fn source_relink_plan(plan: &SourceRelinkPlan, catalog: &Catalog) -> String {
    format!(
        "Game-file location review\nProfile: {}\nPrevious location: {}\nReplacement location: {}\nContent SHA-256: {}\nStored file SHA-256: {}\nStored file size: {} ({} bytes)\nReview SHA-256: {}\nReview only; the saved location has not changed. Neither original nor replacement files are moved or deleted.\nNext step: Repeat source relink with the same profile and replacement path, --apply and --expected-plan {}. Current bytes and the saved registration are checked again.",
        profile_name(catalog, &plan.replacement.profile_id),
        clean(&plan.original.path.display().to_string()),
        clean(&plan.replacement.path.display().to_string()),
        clean(&plan.replacement.sha256),
        clean(&plan.replacement.storage_sha256),
        format_bytes(plan.replacement.storage_size),
        plan.replacement.storage_size,
        clean(&plan.preview_sha256),
        clean(&plan.preview_sha256),
    )
}

pub(crate) fn source_import_plan(plan: &SourceImportPlan, catalog: &Catalog) -> String {
    let action = match plan.mode {
        SourceImportMode::Copy => "Copy files; keep the original",
        SourceImportMode::Move => {
            "Copy and check files, save the new location, then remove the original"
        }
        SourceImportMode::UseCurrentLocation => "Save the current location without copying files",
    };
    format!(
        "Game-file import review\nProfile: {}\nAction: {action}\nOriginal: {}\nDestination: {}\nExisting destination reused: {}\nWorking space required: {}\nContent SHA-256: {}\nStored file SHA-256: {}\nSource identity SHA-256: {}\nReview SHA-256: {}\nReview only; no files or saved locations have changed.\nNext step: Repeat source inbox import with the same arguments, --apply and --expected-plan {}. Moving also requires confirmation; --yes confirms the reviewed move without prompting.",
        profile_name(catalog, &plan.profile_id),
        clean(&plan.source.path.display().to_string()),
        clean(&plan.destination.display().to_string()),
        if plan.reuse_existing { "Yes" } else { "No" },
        format_bytes(plan.required_bytes),
        clean(&plan.source.sha256),
        clean(&plan.source.storage_sha256),
        clean(&plan.source_guard_sha256),
        clean(&plan.plan_sha256),
        clean(&plan.plan_sha256),
    )
}

pub(crate) fn source_import_result(result: &SourceImportResult, catalog: &Catalog) -> String {
    let outcome = match result.outcome {
        SourceImportOutcome::Copied => "Game files copied and their new location saved",
        SourceImportOutcome::Moved => "Game files moved and their new location saved",
        SourceImportOutcome::ReusedExisting => {
            "Existing game files reused and their location saved"
        }
        SourceImportOutcome::RegisteredCurrentLocation => "Current game-file location saved",
        SourceImportOutcome::CopiedOriginalRetained => {
            "Game files copied and their new location saved; original retained"
        }
    };
    let mut text = format!(
        "{outcome}\nImport: {}\nProfile: {}\nSaved location: {}\nFiles copied: {}\nOriginal deleted: {}\nOriginal retained: {}\nRecovered earlier work: {}\nContent SHA-256: {}\nStored file SHA-256: {}",
        clean(&result.import_id),
        profile_name(catalog, &result.profile_id),
        clean(&result.registered.path.display().to_string()),
        if result.copied { "Yes" } else { "No" },
        if result.original_deleted { "Yes" } else { "No" },
        if result.original_retained {
            "Yes"
        } else {
            "No"
        },
        if result.recovered { "Yes" } else { "No" },
        clean(&result.registered.sha256),
        clean(&result.registered.storage_sha256),
    );
    if let Some(path) = &result.retained_original_path {
        text.push_str(&format!(
            "\nRetained original: {}",
            clean(&path.display().to_string())
        ));
    }
    text.push_str(&format!(
        "\nNext step: Using the same library, inspect the saved location with portcove source inspect {}.{}",
        clean(&result.profile_id),
        if result.outcome == SourceImportOutcome::CopiedOriginalRetained {
            " The copy and registration succeeded. Review the retained original before any manual cleanup."
        } else { "" },
    ));
    text
}

pub(crate) fn source_removal_preview(preview: &SourceRemovalPreview, catalog: &Catalog) -> String {
    let affected = preview
        .installed_dependent_port_ids
        .iter()
        .map(|id| port_name(catalog, id))
        .collect::<Vec<_>>();
    format!(
        "Remove saved game-file location review\nProfile: {}\nSaved path: {}\nContent SHA-256: {}\nStored file SHA-256: {}\nReview SHA-256: {}\nInstalled ports depending on this saved registration: {}\nChanges: remove only the saved registration. Original game files stay in place.{}",
        profile_name(catalog, &preview.source.profile_id),
        clean(&preview.source.path.display().to_string()),
        clean(&preview.source.sha256),
        clean(&preview.source.storage_sha256),
        clean(&preview.preview_sha256),
        if affected.is_empty() {
            "None".into()
        } else {
            affected.join(", ")
        },
        if affected.is_empty() {
            ""
        } else {
            "\nThese ports may need the game-file location to be registered again. This review does not assess their readiness after removal."
        },
    )
}

pub(crate) fn library_import_plan(plan: &LibraryImportPlan) -> String {
    let content = plan
        .content
        .iter()
        .map(|tree| {
            format!(
                "  {}: {} files, {} folders, {}",
                content_name(tree.kind),
                tree.copy.files.len(),
                tree.copy.directories.len(),
                format_bytes(tree.copy.total_bytes)
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "Library restore review\nMetadata file: {}\nMetadata SHA-256: {}\nPayload folder: {}\nNew or empty destination: {}\nContent to copy:\n{}\nWorking space required: {}\nAvailable space: {}\nReview SHA-256: {}\nMetadata alone is not a library backup. The selected payload supplies the managed content; external original game-file references retain their recorded paths. Input files remain in place.\nReview only; no restore has been applied.\nNext step: Repeat library import with the same metadata, payload and --library destination, --apply and --expected-plan {}.",
        clean(&plan.metadata_file.path.display().to_string()),
        clean(&plan.metadata_file.sha256),
        clean(&plan.content_root.display().to_string()),
        clean(&plan.destination_root.display().to_string()),
        if content.is_empty() {
            "  No managed content files."
        } else {
            &content
        },
        format_bytes(plan.required_bytes),
        format_bytes(plan.available_bytes),
        clean(&plan.plan_sha256),
        clean(&plan.plan_sha256),
    )
}

pub(crate) fn library_import_result(result: &LibraryImportResult) -> String {
    format!(
        "{}\nTransfer: {}\nDestination: {}\nInput retained: {}\nNext step: {}",
        if result.completed {
            "Library restore completed"
        } else {
            "Library restore not completed"
        },
        clean(&result.transfer_id),
        clean(&result.destination_root.display().to_string()),
        if result.input_retained { "Yes" } else { "No" },
        if result.completed {
            "Select the restored destination with --library and inspect its status. Original game-file references may need a separately reviewed source relink."
        } else {
            "Keep the incomplete destination closed. Copied files are retained, and an aborted import cannot resume. Preserve its contents and choose a new or empty destination for another restore."
        },
    )
}

pub(crate) fn library_metadata_file(file: &LibraryMetadataFile) -> String {
    format!(
        "Library metadata exported\nFile: {}\nSize: {} ({} bytes)\nSHA-256: {}\nThis file contains metadata, not managed payload or original game-file bytes.\nNext step: Preserve the corresponding managed content separately before relying on this export for a restore.",
        clean(&file.path.display().to_string()),
        format_bytes(file.size),
        file.size,
        clean(&file.sha256),
    )
}

pub(crate) fn library_metadata(metadata: &LibraryMetadata) -> String {
    format!(
        "Library metadata\nOriginal library: {}\nExported: {}\nManaged content roots: {}\nApplication versions: {}\nSaved game-file references: {}\nThis is a metadata summary; no export file was written. Metadata contains no payload bytes.\nNext step: Use library export --output <new-file.json> to save the metadata and preserve the corresponding managed content separately. Use --json to read the complete document.",
        clean(&metadata.original_root.display().to_string()),
        utc_time(metadata.exported_at),
        metadata.content_roots.len(),
        metadata.application_versions.len(),
        metadata.source_references.len(),
    )
}

fn content_name(kind: LibraryContentKind) -> &'static str {
    match kind {
        LibraryContentKind::ApplicationVersions => "Application versions",
        LibraryContentKind::UserData => "Saves and settings",
        LibraryContentKind::SourceInbox => "Imported game files",
        LibraryContentKind::Backups => "Backups",
        LibraryContentKind::Toolchains => "Managed tools",
        LibraryContentKind::LocalArtwork => "Local artwork",
    }
}

#[cfg(test)]
mod tests {
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
        assert!(
            text.starts_with("Game files copied and their new location saved; original retained")
        );
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
}
