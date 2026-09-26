use super::*;

fn scan(catalog: &Catalog, request: &SourceDiscoveryRequest) -> Result<SourceDiscoveryReport> {
    super::scan(
        catalog,
        request,
        &crate::OperationCoordinator::new("test-source-discovery", None),
        None,
    )
}
use crate::ErrorCode;
use sha2::{Digest, Sha256};
use std::io::Write;

fn catalog(bytes: &[u8]) -> Catalog {
    let mut document = Catalog::from_json(include_str!("../catalog/catalog-schema1-fixture.json"))
        .unwrap()
        .document()
        .clone();
    for id in ["star-fox-64", "ocarina-of-time"] {
        let profile = document
            .source_profiles
            .iter_mut()
            .find(|profile| profile.id == id)
            .unwrap();
        profile.accepted_extensions = vec!["z64".into()];
        profile.accepted_sha1.clear();
        profile.accepted_sha256 = vec![hex::encode(Sha256::digest(bytes))];
    }
    Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap()
}

fn overlapping_catalog(bytes: &[u8], ocarina_bytes: &[u8]) -> Catalog {
    let mut document = catalog(bytes).document().clone();
    let ocarina = document
        .source_profiles
        .iter_mut()
        .find(|profile| profile.id == "ocarina-of-time")
        .unwrap();
    ocarina.accepted_extensions = vec!["z64".into(), "n64".into()];
    ocarina.accepted_sha1 = vec![hex::encode(sha1::Sha1::digest(ocarina_bytes))];
    ocarina.accepted_sha256.clear();
    Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap()
}

fn request(root: &Path) -> SourceDiscoveryRequest {
    SourceDiscoveryRequest {
        roots: vec![root.into()],
        profile_ids: vec!["star-fox-64".into(), "ocarina-of-time".into()],
        limits: SourceDiscoveryLimits::default(),
    }
}

#[test]
fn overlapping_raw_extension_groups_share_one_hash_pass_and_keep_profile_admission() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("selected");
    fs::create_dir(&root).unwrap();
    let payload = b"synthetic supported source";
    fs::write(root.join("renamed.Z64"), payload).unwrap();
    fs::write(root.join("unrelated.txt"), payload).unwrap();
    fs::write(temporary.path().join("outside.z64"), payload).unwrap();
    let mut selected = request(&root);
    selected.limits.max_hash_bytes = payload.len() as u64;
    let report = scan(&overlapping_catalog(payload, payload), &selected).unwrap();
    assert_eq!(report.candidates.len(), 2);
    assert_eq!(report.files_hashed, 1);
    assert_eq!(report.hash_bytes, payload.len() as u64);
    assert_eq!(report.entries_examined, 2);
    assert!(report.limits_reached.is_empty());
    assert!(!root.join("portcove.sqlite3").exists());
    assert_eq!(fs::read(root.join("renamed.Z64")).unwrap(), payload);
}

#[test]
fn shared_raw_identity_keeps_profile_specific_rejection() {
    let temporary = tempfile::tempdir().unwrap();
    let payload = b"synthetic supported source";
    fs::write(temporary.path().join("source.z64"), payload).unwrap();
    let mut selected = request(temporary.path());
    selected.limits.max_hash_bytes = payload.len() as u64;

    let report = scan(
        &overlapping_catalog(payload, b"different accepted source"),
        &selected,
    )
    .unwrap();

    assert_eq!(report.files_hashed, 1);
    assert_eq!(report.hash_bytes, payload.len() as u64);
    assert_eq!(report.candidates.len(), 1);
    assert_eq!(report.candidates[0].profile_id, "star-fox-64");
    assert!(report.limits_reached.is_empty());
}

#[test]
fn saved_roots_scan_the_catalog_and_persist_one_current_snapshot() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("selected");
    fs::create_dir(&root).unwrap();
    let payload = b"synthetic supported source";
    fs::write(root.join("renamed.z64"), payload).unwrap();
    let catalog = overlapping_catalog(payload, payload);
    let library = crate::Library::open(temporary.path().join("library")).unwrap();
    library.add_game_file_root(&root).unwrap();

    let snapshot = super::build_game_file_scan(
        &catalog,
        &library,
        &SourceDiscoveryLimits::default(),
        &crate::OperationCoordinator::new("saved-root-scan", None),
    )
    .unwrap();
    assert_eq!(snapshot.format_version, 2);
    assert_eq!(snapshot.limits.as_ref().unwrap().max_entries, 10_000);
    assert_eq!(snapshot.roots.len(), 1);
    assert_eq!(snapshot.report.files_hashed, 1);
    assert_eq!(snapshot.report.candidates.len(), 2);
    assert!(
        snapshot
            .report
            .searched_profiles
            .contains(&"star-fox-64".into())
    );
    library.replace_game_file_scan_snapshot(&snapshot).unwrap();
    drop(library);

    let reopened = crate::Library::open(temporary.path().join("library")).unwrap();
    let restored = super::current_game_file_scan(&catalog, &reopened)
        .unwrap()
        .unwrap();
    assert_eq!(restored.freshness, GameFileScanFreshness::InputsMatch);
    assert_eq!(restored.report.candidates.len(), 2);

    let mut changed_document = catalog.document().clone();
    changed_document.ports[0].summary.push_str(" changed");
    let changed_catalog =
        Catalog::from_json(&serde_json::to_string(&changed_document).unwrap()).unwrap();
    assert_eq!(
        super::current_game_file_scan(&changed_catalog, &reopened)
            .unwrap()
            .unwrap()
            .freshness,
        GameFileScanFreshness::InputsChanged
    );
}

#[test]
fn saved_root_excludes_its_nested_library_before_entry_and_hash_budgets() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("selected");
    fs::create_dir(&root).unwrap();
    let payload = b"synthetic supported source";
    fs::write(root.join("external.z64"), payload).unwrap();
    let library = crate::Library::open(root.join("portcove-library")).unwrap();
    fs::write(library.root().join("owned.z64"), payload).unwrap();
    library.add_game_file_root(&root).unwrap();

    let limits = SourceDiscoveryLimits {
        max_entries: 1,
        max_hash_bytes: payload.len() as u64,
        ..SourceDiscoveryLimits::default()
    };
    let snapshot = super::build_game_file_scan(
        &catalog(payload),
        &library,
        &limits,
        &crate::OperationCoordinator::new("saved-root-owned-library", None),
    )
    .unwrap();
    assert_eq!(snapshot.report.entries_examined, 1);
    assert_eq!(snapshot.report.files_hashed, 1);
    assert_eq!(snapshot.report.hash_bytes, payload.len() as u64);
    assert_eq!(snapshot.report.candidates.len(), 2);
    let expected = fs::canonicalize(root.join("external.z64")).unwrap();
    assert!(
        snapshot
            .report
            .candidates
            .iter()
            .all(|candidate| candidate.path == expected)
    );
    let canonical_library = fs::canonicalize(library.root()).unwrap();
    assert!(snapshot.report.issues.iter().any(|issue| {
        issue.path.as_deref() == Some(canonical_library.as_path())
            && issue.message.contains("excluded from game-file discovery")
    }));
}

#[test]
fn saved_root_inside_the_library_is_refused_without_scanning_owned_files() {
    let temporary = tempfile::tempdir().unwrap();
    let library = crate::Library::open(temporary.path().join("library")).unwrap();
    let owned = library.root().join("source-inbox");
    fs::create_dir_all(&owned).unwrap();
    library.add_game_file_root(&owned).unwrap();
    let error = super::build_game_file_scan(
        &catalog(b"synthetic supported source"),
        &library,
        &SourceDiscoveryLimits::default(),
        &crate::OperationCoordinator::new("saved-root-inside-library", None),
    )
    .unwrap_err();
    assert_eq!(error.code, ErrorCode::Usage);
    assert!(
        error
            .message
            .contains("cannot be inside the Portcove library")
    );
}

#[test]
fn saved_root_reports_the_owned_library_even_when_entry_limit_stops_early() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("selected");
    fs::create_dir(&root).unwrap();
    fs::write(root.join("first.txt"), b"unrelated").unwrap();
    fs::write(root.join("second.txt"), b"unrelated").unwrap();
    let library = crate::Library::open(root.join("zzz-portcove-library")).unwrap();
    library.add_game_file_root(&root).unwrap();
    let limits = SourceDiscoveryLimits {
        max_entries: 1,
        ..SourceDiscoveryLimits::default()
    };
    let snapshot = super::build_game_file_scan(
        &catalog(b"synthetic supported source"),
        &library,
        &limits,
        &crate::OperationCoordinator::new("saved-root-early-entry-limit", None),
    )
    .unwrap();
    assert_eq!(snapshot.report.entries_examined, 1);
    assert!(
        snapshot
            .report
            .limits_reached
            .contains(&SourceDiscoveryLimit::Entries)
    );
    let canonical_library = fs::canonicalize(library.root()).unwrap();
    assert!(snapshot.report.issues.iter().any(|issue| {
        issue.path.as_deref() == Some(canonical_library.as_path())
            && issue.message.contains("excluded from game-file discovery")
    }));
}

#[test]
fn unavailable_and_relinked_roots_keep_coverage_explicit_and_stale() {
    let temporary = tempfile::tempdir().unwrap();
    let available = temporary.path().join("available");
    let disconnected = temporary.path().join("disconnected");
    fs::create_dir(&available).unwrap();
    fs::create_dir(&disconnected).unwrap();
    let payload = b"synthetic supported source";
    fs::write(available.join("source.z64"), payload).unwrap();
    let catalog = catalog(payload);
    let library = crate::Library::open(temporary.path().join("library")).unwrap();
    library.add_game_file_root(&available).unwrap();
    let disconnected = library.add_game_file_root(&disconnected).unwrap();
    fs::remove_dir(&disconnected.path).unwrap();

    let snapshot = super::build_game_file_scan(
        &catalog,
        &library,
        &SourceDiscoveryLimits::default(),
        &crate::OperationCoordinator::new("saved-root-scan", None),
    )
    .unwrap();
    assert_eq!(snapshot.roots.len(), 2);
    assert!(snapshot.report.issues.iter().any(|issue| {
        issue.path.as_deref() == Some(disconnected.path.as_path())
            && issue.message.contains("not treated as deleted")
    }));
    library.replace_game_file_scan_snapshot(&snapshot).unwrap();

    let replacement = temporary.path().join("replacement");
    fs::create_dir(&replacement).unwrap();
    library
        .relink_game_file_root(&disconnected.id, &replacement)
        .unwrap();
    assert_eq!(
        super::current_game_file_scan(&catalog, &library)
            .unwrap()
            .unwrap()
            .freshness,
        GameFileScanFreshness::InputsChanged
    );
}

#[test]
fn failed_saved_root_scan_preserves_the_previous_snapshot() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("selected");
    fs::create_dir(&root).unwrap();
    let payload = b"synthetic supported source";
    fs::write(root.join("source.z64"), payload).unwrap();
    let catalog = catalog(payload);
    let library = crate::Library::open(temporary.path().join("library")).unwrap();
    library.add_game_file_root(&root).unwrap();
    let snapshot = super::build_game_file_scan(
        &catalog,
        &library,
        &SourceDiscoveryLimits::default(),
        &crate::OperationCoordinator::new("saved-root-scan", None),
    )
    .unwrap();
    library.replace_game_file_scan_snapshot(&snapshot).unwrap();

    fs::remove_file(root.join("source.z64")).unwrap();
    fs::remove_dir(&root).unwrap();
    assert!(
        super::build_game_file_scan(
            &catalog,
            &library,
            &SourceDiscoveryLimits::default(),
            &crate::OperationCoordinator::new("failed-saved-root-scan", None),
        )
        .is_err()
    );
    let preserved = library.stored_game_file_scan_snapshot().unwrap().unwrap();
    assert_eq!(preserved.catalog_sha256, snapshot.catalog_sha256);
    assert_eq!(preserved.report.candidates.len(), 2);
}

#[test]
fn cancellation_before_snapshot_publication_preserves_the_previous_snapshot() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("selected");
    fs::create_dir(&root).unwrap();
    let payload = b"synthetic supported source";
    fs::write(root.join("source.z64"), payload).unwrap();
    let catalog = catalog(payload);
    let library = crate::Library::open(temporary.path().join("library")).unwrap();
    library.add_game_file_root(&root).unwrap();
    let previous = super::build_game_file_scan(
        &catalog,
        &library,
        &SourceDiscoveryLimits::default(),
        &crate::OperationCoordinator::new("previous-saved-root-scan", None),
    )
    .unwrap();
    library.replace_game_file_scan_snapshot(&previous).unwrap();
    let mut replacement = previous.clone();
    replacement.catalog_sha256 = "replacement".into();

    let service = PortcoveService::new(library).unwrap();
    let (activity, operation) = service
        .begin_cancellable_activity(
            ActivityOperation::DiscoverSources,
            ActivityTargetKind::Library,
            None,
        )
        .unwrap();
    service.request_cancellation(&activity.id).unwrap();
    let result = super::publish_game_file_scan(service.library(), &operation, &replacement);
    assert_eq!(result.as_ref().unwrap_err().code, ErrorCode::Cancelled);
    assert_eq!(
        service.finish_activity(activity, result).unwrap_err().code,
        ErrorCode::Cancelled
    );
    let preserved = service
        .library()
        .stored_game_file_scan_snapshot()
        .unwrap()
        .unwrap();
    assert_eq!(preserved.catalog_sha256, previous.catalog_sha256);
}

#[test]
fn stored_scan_snapshot_accepts_legacy_and_rejects_corrupt_and_future_formats() {
    let temporary = tempfile::tempdir().unwrap();
    let library = crate::Library::open(temporary.path().join("library")).unwrap();
    let connection = library.connection().unwrap();
    connection
        .execute(
            "INSERT INTO game_file_scan_state(singleton, snapshot_json) VALUES (1, ?1)",
            ["not json"],
        )
        .unwrap();
    drop(connection);

    assert!(library.stored_game_file_scan_snapshot().is_err());

    let root = temporary.path().join("selected");
    fs::create_dir(&root).unwrap();
    let payload = b"synthetic supported source";
    fs::write(root.join("source.z64"), payload).unwrap();
    library.add_game_file_root(&root).unwrap();
    let catalog = catalog(payload);
    let mut snapshot = super::build_game_file_scan(
        &catalog,
        &library,
        &SourceDiscoveryLimits::default(),
        &crate::OperationCoordinator::new("saved-root-scan", None),
    )
    .unwrap();
    let mut legacy_with_limits = serde_json::to_value(&snapshot).unwrap();
    legacy_with_limits["format_version"] = serde_json::json!(1);
    let connection = library.connection().unwrap();
    connection
        .execute(
            "UPDATE game_file_scan_state SET snapshot_json = ?1 WHERE singleton = 1",
            [serde_json::to_string(&legacy_with_limits).unwrap()],
        )
        .unwrap();
    drop(connection);
    let legacy = super::current_game_file_scan(&catalog, &library)
        .unwrap()
        .unwrap();
    assert_eq!(legacy.format_version, 1);
    assert!(legacy.limits.is_none());

    let mut legacy_without_limits = legacy_with_limits;
    legacy_without_limits
        .as_object_mut()
        .unwrap()
        .remove("limits");
    let connection = library.connection().unwrap();
    connection
        .execute(
            "UPDATE game_file_scan_state SET snapshot_json = ?1 WHERE singleton = 1",
            [serde_json::to_string(&legacy_without_limits).unwrap()],
        )
        .unwrap();
    drop(connection);
    let legacy = super::current_game_file_scan(&catalog, &library)
        .unwrap()
        .unwrap();
    assert!(legacy.limits.is_none());

    let format_two_without_limits = GameFileScanSnapshot {
        format_version: 2,
        ..legacy
    };
    library
        .replace_game_file_scan_snapshot(&format_two_without_limits)
        .unwrap();
    let error = super::current_game_file_scan(&catalog, &library).unwrap_err();
    assert!(error.to_string().contains("missing its scan limits"));

    snapshot.limits.as_mut().unwrap().max_entries = 0;
    library.replace_game_file_scan_snapshot(&snapshot).unwrap();
    let error = super::current_game_file_scan(&catalog, &library).unwrap_err();
    assert!(error.to_string().contains("invalid scan limits"));

    snapshot.limits = Some(SourceDiscoveryLimits::default());
    snapshot.format_version = 3;
    library.replace_game_file_scan_snapshot(&snapshot).unwrap();

    let error = super::current_game_file_scan(&catalog, &library).unwrap_err();
    assert!(error.to_string().contains("version is not supported"));
}

#[test]
fn public_saved_root_scan_uses_the_embedded_catalog_and_survives_restart() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("selected");
    fs::create_dir(&root).unwrap();
    let library_root = temporary.path().join("library");
    let library = crate::Library::open(&library_root).unwrap();
    library.add_game_file_root(&root).unwrap();
    let service = PortcoveService::new(library).unwrap();

    let scanned = service
        .scan_game_file_roots(&SourceDiscoveryLimits::default())
        .unwrap();
    assert_eq!(scanned.freshness, GameFileScanFreshness::InputsMatch);
    assert_eq!(scanned.roots.len(), 1);
    drop(service);

    let reopened = PortcoveService::new(crate::Library::open(&library_root).unwrap()).unwrap();
    let restored = reopened.game_file_scan_snapshot().unwrap().unwrap();
    assert_eq!(restored.freshness, GameFileScanFreshness::InputsMatch);
    assert_eq!(restored.catalog_sha256, scanned.catalog_sha256);
}

#[test]
fn directory_depth_entry_file_size_and_hash_budgets_bound_work() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path();
    let payload = b"synthetic supported source";
    fs::create_dir(root.join("child")).unwrap();
    fs::write(root.join("child/source.z64"), payload).unwrap();
    let mut selected = request(root);
    selected.limits.max_depth = 0;
    let limited = scan(&catalog(payload), &selected).unwrap();
    assert_eq!(limited.hash_bytes, 0);
    assert!(
        limited
            .limits_reached
            .contains(&SourceDiscoveryLimit::Depth)
    );
    selected.limits.max_depth = 1;
    selected.limits.max_entries = 1;
    let limited = scan(&catalog(payload), &selected).unwrap();
    assert_eq!(limited.entries_examined, 1);
    assert!(
        limited
            .limits_reached
            .contains(&SourceDiscoveryLimit::Entries)
    );
    selected.limits.max_entries = 10;
    selected.limits.max_file_bytes = 1;
    let limited = scan(&catalog(payload), &selected).unwrap();
    assert!(
        limited
            .limits_reached
            .contains(&SourceDiscoveryLimit::FileSize)
    );
    assert_eq!(limited.hash_bytes, 0);
    selected.limits.max_file_bytes = 100;
    selected.limits.max_hash_bytes = payload.len() as u64 - 1;
    let limited = scan(&catalog(payload), &selected).unwrap();
    assert!(
        limited
            .limits_reached
            .contains(&SourceDiscoveryLimit::HashBytes)
    );
    assert_eq!(limited.hash_bytes, 0);
    selected.limits.max_hash_bytes = payload.len() as u64;
    selected.limits.max_candidates = 1;
    let limited = scan(&catalog(payload), &selected).unwrap();
    assert_eq!(limited.candidates.len(), 1);
    assert!(
        limited
            .limits_reached
            .contains(&SourceDiscoveryLimit::Candidates)
    );
}

#[test]
fn zip_payload_and_container_hashing_are_both_budgeted_before_expansion() {
    let temporary = tempfile::tempdir().unwrap();
    let payload = b"synthetic cartridge bytes";
    let path = temporary.path().join("source.zip");
    let mut archive = zip::ZipWriter::new(fs::File::create(&path).unwrap());
    archive
        .start_file("game.z64", zip::write::SimpleFileOptions::default())
        .unwrap();
    archive.write_all(payload).unwrap();
    archive.finish().unwrap();
    let bytes = fs::metadata(&path).unwrap().len() + payload.len() as u64;
    let mut selected = request(temporary.path());
    selected.limits.max_hash_bytes = bytes - 1;
    let limited = scan(&catalog(payload), &selected).unwrap();
    assert_eq!(limited.hash_bytes, 0);
    selected.limits.max_hash_bytes = bytes;
    let found = scan(&catalog(payload), &selected).unwrap();
    assert_eq!(found.hash_bytes, bytes);
    assert_eq!(found.candidates.len(), 2);
    assert_ne!(
        found.candidates[0].sha256,
        found.candidates[0].storage_sha256
    );
}

#[test]
fn weak_profiles_are_reported_without_hashing_and_acceptance_revalidates_the_selected_digest() {
    let temporary = tempfile::tempdir().unwrap();
    fs::write(temporary.path().join("source.z64"), b"synthetic").unwrap();
    let mut selected = request(temporary.path());
    selected.profile_ids = vec!["star-fox-64".into()];
    let report = scan(&Catalog::embedded().unwrap(), &selected).unwrap();
    assert!(report.candidates.is_empty());
    assert_eq!(report.hash_bytes, 0);
    assert_eq!(report.issues[0].profile_id.as_deref(), Some("star-fox-64"));
    let service =
        PortcoveService::new(crate::Library::open(temporary.path().join("library")).unwrap())
            .unwrap();
    let path = temporary.path().join("source.z64");
    let expected = hex::encode(Sha256::digest(b"synthetic"));
    fs::write(&path, b"changed").unwrap();
    assert!(
        service
            .register_source_with_digest("star-fox-64", &path, &expected)
            .is_err()
    );
    assert!(service.library().sources().unwrap().is_empty());
    fs::write(&path, b"synthetic").unwrap();
    service
        .register_source_with_digest("star-fox-64", &path, &expected)
        .unwrap();
    assert_eq!(service.library().sources().unwrap().len(), 1);
}

#[cfg(unix)]
#[test]
fn traversal_never_follows_a_symlink_out_of_the_selected_root() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("selected");
    fs::create_dir(&root).unwrap();
    let outside = temporary.path().join("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("source.z64"), b"synthetic").unwrap();
    std::os::unix::fs::symlink(&outside, root.join("shortcut")).unwrap();
    let report = scan(&catalog(b"synthetic"), &request(&root)).unwrap();
    assert_eq!(report.symlinks_skipped, 1);
    assert_eq!(report.hash_bytes, 0);
}
