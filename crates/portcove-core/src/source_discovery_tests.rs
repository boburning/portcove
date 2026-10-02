use super::*;

fn scan(catalog: &Catalog, request: &SourceDiscoveryRequest) -> Result<SourceDiscoveryReport> {
    super::scan(
        catalog,
        request,
        &crate::OperationCoordinator::new("test-source-discovery", None),
        vec![],
        None,
    )
}
use crate::ErrorCode;
use sha2::{Digest, Sha256};
use std::io::Write;

// Generic discovery needs two identities and one port for catalog snapshot changes.
// Keep real schema-2 admission and embedded-catalog coverage in their dedicated cases.
fn catalog(bytes: &[u8]) -> Catalog {
    let digest = hex::encode(Sha256::digest(bytes));
    let document = serde_json::json!({
        "schema_version": 1,
        "source_profiles": (["star-fox-64", "ocarina-of-time"].map(|id| {
            serde_json::json!({
                "id": id,
                "label": format!("Synthetic {id} source"),
                "accepted_extensions": ["z64"],
                "accepted_sha256": [digest],
            })
        })),
        "ports": [{
            "id": "discovery-fixture",
            "name": "Discovery fixture",
            "summary": "Synthetic source discovery fixture",
            "project_url": "https://example.invalid/discovery-fixture",
            "support_tier": "beta",
            "channels": ["stable"],
            "platforms": ["linux-x86-64"],
            "adapter": "libultraship-portable",
            "release": { "repository": "fixture/discovery" },
            "source_profile": "ocarina-of-time",
            "executable_hints": { "linux-x86-64": ["fixture"] },
        }],
    });
    Catalog::from_json(&document.to_string()).unwrap()
}

#[test]
fn generic_discovery_catalog_has_only_its_valid_fixture_graph() {
    let payload = b"synthetic supported source";
    let fixture = catalog(payload);
    fixture.validate().unwrap();
    assert_eq!(fixture.document().schema_version, 1);
    assert_eq!(fixture.document().ports.len(), 1);
    assert_eq!(fixture.document().ports[0].id, "discovery-fixture");
    assert_eq!(fixture.document().source_profiles.len(), 2);
    for id in ["star-fox-64", "ocarina-of-time"] {
        let profile = fixture.source_profile(id).unwrap();
        assert_eq!(profile.accepted_extensions, ["z64"]);
        assert!(profile.accepted_sha1.is_empty());
        assert_eq!(
            profile.accepted_sha256,
            [hex::encode(Sha256::digest(payload))]
        );
    }

    let mut invalid = fixture.document().clone();
    invalid.ports[0].source_profile = Some("missing-source".into());
    assert!(Catalog::from_json(&serde_json::to_string(&invalid).unwrap()).is_err());
    let mut invalid = fixture.document().clone();
    invalid.source_profiles[0].accepted_sha256 = vec!["invalid-digest".into()];
    assert!(Catalog::from_json(&serde_json::to_string(&invalid).unwrap()).is_err());
}

#[test]
fn unrelated_catalog_entries_do_not_change_selected_generic_discovery() {
    let temporary = tempfile::tempdir().unwrap();
    let payload = b"synthetic supported source";
    fs::write(temporary.path().join("source.z64"), payload).unwrap();
    let fixture = catalog(payload);
    let mut extended = fixture.document().clone();
    let mut profile = extended.source_profiles[0].clone();
    profile.id = "unrelated-source".into();
    profile.accepted_sha256 = vec![hex::encode(Sha256::digest(b"unrelated bytes"))];
    extended.source_profiles.push(profile);
    let mut port = extended.ports[0].clone();
    port.id = "unrelated-port".into();
    port.source_profile = Some("unrelated-source".into());
    extended.ports.push(port);
    let extended = Catalog::from_json(&serde_json::to_string(&extended).unwrap()).unwrap();
    let selected = request(temporary.path());
    let before = scan(&fixture, &selected).unwrap();
    let after = scan(&extended, &selected).unwrap();
    assert_eq!(before.candidates.len(), 2);
    assert_eq!(after.candidates.len(), 2);
    assert_eq!(before.searched_profiles, after.searched_profiles);
    assert_eq!(before.files_hashed, after.files_hashed);
    assert_eq!(before.hash_bytes, after.hash_bytes);
    for (before, after) in before.candidates.iter().zip(&after.candidates) {
        assert_eq!(before.profile_id, after.profile_id);
        assert_eq!(before.path, after.path);
        assert_eq!(before.sha256, after.sha256);
        assert_eq!(before.storage_sha256, after.storage_sha256);
    }
    assert!(before.limits_reached.is_empty() && after.limits_reached.is_empty());
    assert!(before.issues.is_empty() && after.issues.is_empty());
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

fn schema2_catalog_with_current_n64(bytes: &[u8]) -> Catalog {
    let mut document: serde_json::Value =
        serde_json::from_str(include_str!("../catalog/catalog.json")).unwrap();
    let sha1 = hex::encode(sha1::Sha1::digest(bytes));
    let sha256 = hex::encode(Sha256::digest(bytes));
    for (profile_id, variant_id) in [
        ("ocarina-of-time", "usa-1-0"),
        ("ghostship-source", "super-mario-64-us"),
    ] {
        let profile = document["source_catalog"]["identities"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|profile| profile["id"] == profile_id)
            .unwrap();
        let variant = profile["variants"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|variant| variant["id"] == variant_id)
            .unwrap();
        let identity = &mut variant["representations"][0]["identities"][0];
        identity["sha1"] = sha1.clone().into();
        identity["sha256"] = sha256.clone().into();
    }
    Catalog::from_json(&document.to_string()).unwrap()
}

#[test]
fn current_schema2_file_identities_and_extensions_are_discoverable_without_legacy_digest() {
    let temporary = tempfile::tempdir().unwrap();
    let canonical = [0x80, 0x37, 0x12, 0x40, 1, 2, 3, 4, 5, 6, 7, 8];
    fs::write(temporary.path().join("game.n64"), canonical).unwrap();
    let catalog = schema2_catalog_with_current_n64(&canonical);
    let ocarina = catalog.source_profile("ocarina-of-time").unwrap();
    assert!(ocarina.accepted_sha1.is_empty() && ocarina.accepted_sha256.is_empty());
    let ghostship = catalog.source_profile("ghostship-source").unwrap();
    assert!(!ghostship.accepted_extensions.contains(&"n64".into()));
    let mut selected = request(temporary.path());
    selected.profile_ids = vec!["ocarina-of-time".into(), "ghostship-source".into()];
    selected.limits.max_hash_bytes = canonical.len() as u64;

    let report = scan(&catalog, &selected).unwrap();
    assert_eq!(report.candidates.len(), 2);
    assert_eq!(report.files_hashed, 1);
    assert_eq!(report.hash_bytes, canonical.len() as u64);
    assert!(report.limits_reached.is_empty());
    assert_eq!(
        report
            .candidates
            .iter()
            .map(|candidate| candidate.profile_id.as_str())
            .collect::<Vec<_>>(),
        ["ghostship-source", "ocarina-of-time"]
    );
    let mut service =
        PortcoveService::new(crate::Library::open(temporary.path().join("library")).unwrap())
            .unwrap();
    service.replace_catalog_for_test(catalog);
    for candidate in &report.candidates {
        let plan = service
            .plan_source_import(
                &candidate.profile_id,
                &candidate.path,
                crate::SourceImportMode::UseCurrentLocation,
            )
            .unwrap();
        assert_eq!(
            plan.admission_mode,
            crate::SourceAdmissionMode::ExactIdentity
        );
    }
}

#[test]
fn current_schema2_cartridge_zip_uses_current_member_extensions_and_exact_admission() {
    let temporary = tempfile::tempdir().unwrap();
    let canonical = [0x80, 0x37, 0x12, 0x40, 1, 2, 3, 4, 5, 6, 7, 8];
    let path = temporary.path().join("game.zip");
    let mut archive = zip::ZipWriter::new(fs::File::create(&path).unwrap());
    archive
        .start_file("game.v64", zip::write::SimpleFileOptions::default())
        .unwrap();
    let mut byte_swapped = canonical;
    for pair in byte_swapped.as_chunks_mut::<2>().0 {
        pair.swap(0, 1);
    }
    archive.write_all(&byte_swapped).unwrap();
    archive.finish().unwrap();
    let catalog = schema2_catalog_with_current_n64(&canonical);
    let mut selected = request(temporary.path());
    selected.profile_ids = vec!["ocarina-of-time".into(), "ghostship-source".into()];
    selected.limits.max_hash_bytes = fs::metadata(&path).unwrap().len() + canonical.len() as u64;

    let report = scan(&catalog, &selected).unwrap();
    assert_eq!(report.candidates.len(), 2);
    assert_eq!(report.files_hashed, 1);
    assert_eq!(report.hash_bytes, selected.limits.max_hash_bytes);
    assert!(
        report
            .candidates
            .iter()
            .all(|candidate| candidate.storage_sha256 != candidate.sha256)
    );
    let mut service =
        PortcoveService::new(crate::Library::open(temporary.path().join("library")).unwrap())
            .unwrap();
    service.replace_catalog_for_test(catalog.clone());
    for candidate in &report.candidates {
        let plan = service
            .plan_source_import(
                &candidate.profile_id,
                &candidate.path,
                crate::SourceImportMode::UseCurrentLocation,
            )
            .unwrap();
        assert_eq!(
            plan.admission_mode,
            crate::SourceAdmissionMode::ExactIdentity
        );
    }

    fs::write(
        temporary.path().join("unrecognized.n64"),
        [0x80, 0x37, 0x12, 0x40, 9, 9, 9, 9],
    )
    .unwrap();
    selected.limits.max_hash_bytes += 8;
    let report = scan(&catalog, &selected).unwrap();
    assert_eq!(report.candidates.len(), 2);
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
    assert_eq!(snapshot.format_version, 5);
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
fn exact_candidates_stream_before_the_saved_root_snapshot_is_published() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("selected");
    fs::create_dir(&root).unwrap();
    let payload = b"synthetic supported source";
    fs::write(root.join("renamed.z64"), payload).unwrap();
    let catalog = overlapping_catalog(payload, payload);
    let library = crate::Library::open(temporary.path().join("library")).unwrap();
    library.add_game_file_root(&root).unwrap();
    let operation = crate::OperationCoordinator::new("saved-root-scan", None);
    let mut events = Vec::new();
    let (snapshot, _) = super::build_game_file_scan_with_registry_events(
        &catalog,
        &library,
        &SourceDiscoveryLimits::default(),
        &operation,
        &mut |event| {
            assert!(library.stored_game_file_scan_snapshot().unwrap().is_none());
            events.push(event);
        },
    )
    .unwrap();
    assert_eq!(events.len(), 2);
    for event in &events {
        assert_eq!(event.schema_version, 3);
        if let crate::OperationEventKind::SourceCandidate {
            profile_id,
            path,
            sha256,
            size,
        } = &event.event
        {
            let candidate = snapshot
                .report
                .candidates
                .iter()
                .find(|candidate| &candidate.profile_id == profile_id)
                .unwrap();
            assert_eq!(profile_id, &candidate.profile_id);
            assert_eq!(path, &candidate.path);
            assert_eq!(sha256, &candidate.sha256);
            assert_eq!(size, &candidate.size);
        } else {
            panic!("expected exact source candidate event");
        }
    }
    assert!(events[0].sequence < events[1].sequence);
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
fn saved_root_excludes_claimed_external_output_without_hiding_other_files() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("selected");
    fs::create_dir(&root).unwrap();
    let payload = b"synthetic supported source";
    fs::write(root.join("external.z64"), payload).unwrap();
    let library = crate::Library::open(temporary.path().join("library")).unwrap();
    let output = root.join("managed-output");
    crate::output_root::prepare_for_install(
        &library,
        "sample",
        &output,
        &uuid::Uuid::new_v4().to_string(),
        0,
    )
    .unwrap();
    fs::write(output.join("owned.z64"), payload).unwrap();
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
        &crate::OperationCoordinator::new("saved-root-managed-output", None),
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
    let canonical_output = fs::canonicalize(&output).unwrap();
    assert!(snapshot.report.issues.iter().any(|issue| {
        issue.path.as_deref() == Some(canonical_output.as_path())
            && issue.message.contains("managed game output is excluded")
    }));
    assert_eq!(fs::read(output.join("owned.z64")).unwrap(), payload);
}

#[test]
fn saved_root_inside_claimed_external_output_is_refused() {
    let temporary = tempfile::tempdir().unwrap();
    let library = crate::Library::open(temporary.path().join("library")).unwrap();
    let output = temporary.path().join("managed-output");
    crate::output_root::prepare_for_install(
        &library,
        "sample",
        &output,
        &uuid::Uuid::new_v4().to_string(),
        0,
    )
    .unwrap();
    let nested = output.join("selected");
    fs::create_dir(&nested).unwrap();
    library.add_game_file_root(&nested).unwrap();
    let error = super::build_game_file_scan(
        &catalog(b"synthetic supported source"),
        &library,
        &SourceDiscoveryLimits::default(),
        &crate::OperationCoordinator::new("saved-root-inside-output", None),
    )
    .unwrap_err();
    assert_eq!(error.code, ErrorCode::Usage);
    assert!(error.message.contains("Portcove-managed game output"));
}

#[test]
fn saved_root_detects_output_claimed_after_initial_exclusions() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("selected");
    fs::create_dir(&root).unwrap();
    let payload = b"synthetic supported source";
    let library = crate::Library::open(temporary.path().join("library")).unwrap();
    let output = root.join("managed-output");
    crate::output_root::prepare_for_install(
        &library,
        "sample",
        &output,
        &uuid::Uuid::new_v4().to_string(),
        0,
    )
    .unwrap();
    fs::write(output.join("owned.z64"), payload).unwrap();
    fs::write(root.join("external.z64"), payload).unwrap();

    // An empty exclusion list models a claim made after the scan's first read.
    let report = super::scan(
        &catalog(payload),
        &SourceDiscoveryRequest {
            roots: vec![root.clone()],
            profile_ids: vec!["star-fox-64".into(), "ocarina-of-time".into()],
            limits: SourceDiscoveryLimits {
                max_entries: 1,
                max_hash_bytes: payload.len() as u64,
                ..SourceDiscoveryLimits::default()
            },
        },
        &crate::OperationCoordinator::new("late-output-claim", None),
        vec![],
        Some(&library),
    )
    .unwrap();
    assert_eq!(report.entries_examined, 1);
    assert_eq!(report.files_hashed, 1);
    assert_eq!(report.hash_bytes, payload.len() as u64);
    assert!(report.candidates.iter().all(|candidate| {
        candidate.path == fs::canonicalize(root.join("external.z64")).unwrap()
    }));
    assert!(report.issues.iter().any(|issue| {
        issue.path.as_deref() == Some(fs::canonicalize(&output).unwrap().as_path())
            && issue.message.contains("managed game output is excluded")
    }));
}

#[test]
fn saved_root_skips_registered_output_before_marker_is_written() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("selected");
    fs::create_dir(&root).unwrap();
    let output = root.join("managed-output");
    fs::create_dir(&output).unwrap();
    let library = crate::Library::open(temporary.path().join("library")).unwrap();
    library
        .register_output_root(&crate::library::OutputRootRecord {
            path: fs::canonicalize(&output).unwrap(),
            port_id: "sample".into(),
            marker_id: uuid::Uuid::new_v4().to_string(),
            volume_identity: "pending".into(),
        })
        .unwrap();
    let payload = b"synthetic supported source";
    fs::write(root.join("external.z64"), payload).unwrap();
    let report = super::scan(
        &catalog(payload),
        &SourceDiscoveryRequest {
            roots: vec![root.clone()],
            profile_ids: vec!["star-fox-64".into()],
            limits: SourceDiscoveryLimits {
                max_entries: 1,
                max_hash_bytes: payload.len() as u64,
                ..SourceDiscoveryLimits::default()
            },
        },
        &crate::OperationCoordinator::new("claim-before-marker", None),
        vec![],
        Some(&library),
    )
    .unwrap();
    assert_eq!(report.entries_examined, 1);
    assert_eq!(report.files_hashed, 1);
    assert_eq!(report.candidates.len(), 1);
    assert!(report.issues.iter().any(|issue| {
        issue.path.as_deref() == Some(fs::canonicalize(&output).unwrap().as_path())
            && issue.message.contains("managed game output is excluded")
    }));
}

#[cfg(windows)]
#[test]
fn saved_root_excludes_claimed_output_after_case_only_rename() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("selected");
    fs::create_dir(&root).unwrap();
    let library = crate::Library::open(temporary.path().join("library")).unwrap();
    let original = root.join("ManagedOutput");
    crate::output_root::prepare_for_install(
        &library,
        "sample",
        &original,
        &uuid::Uuid::new_v4().to_string(),
        0,
    )
    .unwrap();
    let renamed = root.join("managedoutput");
    fs::rename(&original, &renamed).unwrap();
    let payload = b"synthetic supported source";
    fs::write(renamed.join("owned.z64"), payload).unwrap();
    fs::write(root.join("external.z64"), payload).unwrap();
    library.add_game_file_root(&root).unwrap();
    let snapshot = super::build_game_file_scan(
        &catalog(payload),
        &library,
        &SourceDiscoveryLimits::default(),
        &crate::OperationCoordinator::new("renamed-output", None),
    )
    .unwrap();
    assert!(snapshot.report.candidates.iter().all(|candidate| {
        candidate.path == fs::canonicalize(root.join("external.z64")).unwrap()
    }));
    assert!(
        snapshot
            .report
            .issues
            .iter()
            .any(|issue| { issue.message.contains("managed game output is excluded") })
    );
}

#[test]
fn saved_root_refuses_more_owned_paths_than_can_be_reported() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("selected");
    fs::create_dir(&root).unwrap();
    let library = crate::Library::open(temporary.path().join("library")).unwrap();
    library.add_game_file_root(&root).unwrap();
    for index in 0..65 {
        library
            .register_output_root(&crate::library::OutputRootRecord {
                path: fs::canonicalize(&root)
                    .unwrap()
                    .join(format!("offline-{index}")),
                port_id: "sample".into(),
                marker_id: uuid::Uuid::new_v4().to_string(),
                volume_identity: "offline".into(),
            })
            .unwrap();
    }
    let error = super::build_game_file_scan(
        &catalog(b"synthetic supported source"),
        &library,
        &SourceDiscoveryLimits::default(),
        &crate::OperationCoordinator::new("too-many-owned-paths", None),
    )
    .unwrap_err();
    assert_eq!(error.code, ErrorCode::Usage);
    assert!(error.message.contains("too many owned paths"));
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
    let result = super::publish_game_file_scan(
        service.library(),
        &operation,
        &replacement,
        &service.library().output_roots().unwrap(),
    );
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
fn output_claim_after_traversal_refuses_snapshot_publication() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("selected");
    fs::create_dir(&root).unwrap();
    let payload = b"synthetic supported source";
    fs::write(root.join("source.z64"), payload).unwrap();
    let library = crate::Library::open(temporary.path().join("library")).unwrap();
    library.add_game_file_root(&root).unwrap();
    let operation = crate::OperationCoordinator::new("ownership-publication", None);
    let (mut snapshot, expected_outputs) = super::build_game_file_scan_with_registry(
        &catalog(payload),
        &library,
        &SourceDiscoveryLimits::default(),
        &operation,
    )
    .unwrap();
    let mut previous = snapshot.clone();
    previous.catalog_sha256 = "previous".into();
    library.replace_game_file_scan_snapshot(&previous).unwrap();

    crate::output_root::prepare_for_install(
        &library,
        "sample",
        &root.join("new-managed-output"),
        &uuid::Uuid::new_v4().to_string(),
        0,
    )
    .unwrap();
    snapshot.catalog_sha256 = "replacement".into();
    let error = super::publish_game_file_scan(&library, &operation, &snapshot, &expected_outputs)
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Conflict);
    assert!(error.message.contains("ownership changed"));
    assert_eq!(
        library
            .stored_game_file_scan_snapshot()
            .unwrap()
            .unwrap()
            .catalog_sha256,
        "previous"
    );
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
    assert_eq!(legacy.freshness, GameFileScanFreshness::InputsChanged);

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
    assert_eq!(legacy.freshness, GameFileScanFreshness::InputsChanged);

    let format_two = GameFileScanSnapshot {
        format_version: 2,
        limits: Some(SourceDiscoveryLimits::default()),
        ..legacy.clone()
    };
    library
        .replace_game_file_scan_snapshot(&format_two)
        .unwrap();
    let previous = super::current_game_file_scan(&catalog, &library)
        .unwrap()
        .unwrap();
    assert_eq!(previous.format_version, 2);
    assert_eq!(previous.freshness, GameFileScanFreshness::InputsChanged);
    assert_eq!(
        previous.report.candidates.len(),
        snapshot.report.candidates.len()
    );
    assert_eq!(
        previous.report.candidates[0].sha256,
        snapshot.report.candidates[0].sha256
    );
    assert_eq!(
        previous.limits.unwrap().max_entries,
        format_two.limits.unwrap().max_entries
    );

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
    snapshot.format_version = 6;
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
fn informational_profiles_are_reported_without_hashing_and_acceptance_revalidates_the_selected_digest()
 {
    let temporary = tempfile::tempdir().unwrap();
    fs::write(temporary.path().join("source.z64"), b"synthetic").unwrap();
    let mut selected = request(temporary.path());
    selected.profile_ids = vec!["twilight-princess".into()];
    let report = scan(&Catalog::embedded().unwrap(), &selected).unwrap();
    assert!(report.candidates.is_empty());
    assert_eq!(report.hash_bytes, 0);
    assert_eq!(
        report.issues[0].profile_id.as_deref(),
        Some("twilight-princess")
    );
    let service =
        PortcoveService::new(crate::Library::open(temporary.path().join("library")).unwrap())
            .unwrap();
    let path = temporary.path().join("source.iso");
    let expected = hex::encode(Sha256::digest(b"synthetic"));
    fs::write(&path, b"changed").unwrap();
    assert!(
        service
            .register_source_with_digest("twilight-princess", &path, &expected)
            .is_err()
    );
    assert!(service.library().sources().unwrap().is_empty());
    fs::write(&path, b"synthetic").unwrap();
    service
        .register_source_with_digest("twilight-princess", &path, &expected)
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

// This regression intentionally retains the catalog's real directory-set member contract.
fn directory_set_catalog() -> (Catalog, Vec<(&'static str, Vec<u8>)>) {
    let cartridge = vec![0x80, 0x37, 0x12, 0x40, 1, 2, 3, 4];
    let fixtures = vec![
        ("baserom.us.rev0.z64", cartridge.clone()),
        ("baserom.translated.ek.ndd", b"synthetic expansion".to_vec()),
        ("N64DDIPLROM.n64", b"synthetic IPL".to_vec()),
    ];
    let mut document = schema2_catalog_with_current_n64(&cartridge)
        .document()
        .clone();
    let profile = document
        .source_catalog
        .as_mut()
        .unwrap()
        .identities
        .iter_mut()
        .find(|profile| profile.id == "g-diffuser-source-set")
        .unwrap();
    let crate::SourceRepresentationKind::FileSet { members } =
        &mut profile.variants[0].representations[0].kind
    else {
        panic!("expected file set")
    };
    assert_eq!(members.len(), fixtures.len());
    for (member, (name, bytes)) in members.iter_mut().zip(&fixtures) {
        assert!(member.filenames.iter().any(|filename| filename == name));
        member.identities = vec![crate::DigestIdentity {
            scope: crate::DigestScope::FileSetMember,
            sha1: Some(hex::encode(sha1::Sha1::digest(bytes))),
            sha256: Some(hex::encode(Sha256::digest(bytes))),
            crc32: Some(format!("{:08x}", crc32fast::hash(bytes))),
        }];
    }
    (
        Catalog::from_json(&{
            let mut json = serde_json::to_value(&document).unwrap();
            json.as_object_mut().unwrap().remove("source_profiles");
            json.to_string()
        })
        .unwrap(),
        fixtures,
    )
}

#[test]
fn directory_file_set_discovery_shares_raw_observations_and_preserves_review() {
    let temporary = tempfile::tempdir().unwrap();
    let sources = temporary.path().join("set");
    fs::create_dir(&sources).unwrap();
    let (catalog, fixtures) = directory_set_catalog();
    for (name, bytes) in &fixtures {
        fs::write(sources.join(name), bytes).unwrap();
    }
    let mut selected = request(&sources);
    selected.profile_ids = vec!["g-diffuser-source-set".into(), "ocarina-of-time".into()];
    selected.limits.max_hash_bytes = fixtures.iter().map(|(_, bytes)| bytes.len() as u64).sum();
    let report = scan(&catalog, &selected).unwrap();
    assert_eq!(report.candidates.len(), 2);
    assert_eq!(report.hash_bytes, selected.limits.max_hash_bytes);
    assert_eq!(report.files_hashed, 3);
    assert!(report.limits_reached.is_empty());
    let candidate = report
        .candidates
        .iter()
        .find(|candidate| candidate.profile_id == "g-diffuser-source-set")
        .unwrap();
    assert_eq!(candidate.path, fs::canonicalize(&sources).unwrap());
    let manual =
        crate::source_inspection::inspect_file_set(&catalog, &candidate.profile_id, &sources)
            .unwrap()
            .record
            .unwrap();
    assert_eq!(candidate.sha256, manual.sha256);
    assert_eq!(candidate.storage_sha256, manual.storage_sha256);
    let mut service =
        PortcoveService::new(crate::Library::open(temporary.path().join("library")).unwrap())
            .unwrap();
    service.replace_catalog_for_test(catalog);
    let plan = service
        .plan_source_import(
            &candidate.profile_id,
            &candidate.path,
            crate::SourceImportMode::UseCurrentLocation,
        )
        .unwrap();
    assert_eq!(
        plan.admission_mode,
        crate::SourceAdmissionMode::ExactIdentity
    );
    assert!(service.library().sources().unwrap().is_empty());
    for (name, bytes) in fixtures {
        assert_eq!(fs::read(sources.join(name)).unwrap(), bytes);
    }
}

fn write_file_set_zip(path: &Path, fixtures: &[(&str, Vec<u8>)]) {
    let mut zip = zip::ZipWriter::new(fs::File::create(path).unwrap());
    for (name, bytes) in fixtures {
        zip.start_file(*name, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(bytes).unwrap();
    }
    zip.finish().unwrap();
}

#[test]
fn zip_file_set_discovery_preserves_exact_inspection_and_explicit_review() {
    let temporary = tempfile::tempdir().unwrap();
    let (catalog, fixtures) = directory_set_catalog();
    let path = temporary.path().join("set.zip");
    write_file_set_zip(&path, &fixtures);
    let original = fs::read(&path).unwrap();
    let mut selected = request(temporary.path());
    selected.profile_ids = vec!["g-diffuser-source-set".into()];
    selected.limits.max_hash_bytes = original.len() as u64
        + fixtures
            .iter()
            .map(|(_, bytes)| bytes.len() as u64)
            .sum::<u64>();
    let report = scan(&catalog, &selected).unwrap();
    assert_eq!(report.candidates.len(), 1);
    assert_eq!(report.files_hashed, 1);
    assert_eq!(report.hash_bytes, selected.limits.max_hash_bytes);
    assert!(report.limits_reached.is_empty());
    let candidate = &report.candidates[0];
    let manual = crate::source_inspection::inspect_file_set(&catalog, &candidate.profile_id, &path)
        .unwrap()
        .record
        .unwrap();
    assert_eq!(candidate.path, fs::canonicalize(&path).unwrap());
    assert_eq!(candidate.sha256, manual.sha256);
    assert_eq!(candidate.size, manual.size);
    assert_eq!(
        candidate.storage_sha256,
        hex::encode(Sha256::digest(&original))
    );
    assert_eq!(candidate.storage_sha256, manual.storage_sha256);
    assert_eq!(candidate.storage_size, original.len() as u64);
    let mut service =
        PortcoveService::new(crate::Library::open(temporary.path().join("library")).unwrap())
            .unwrap();
    service.replace_catalog_for_test(catalog);
    let plan = service
        .plan_source_import(
            &candidate.profile_id,
            &candidate.path,
            crate::SourceImportMode::UseCurrentLocation,
        )
        .unwrap();
    assert_eq!(
        plan.admission_mode,
        crate::SourceAdmissionMode::ExactIdentity
    );
    assert!(service.library().sources().unwrap().is_empty());
    assert_eq!(fs::read(&path).unwrap(), original);
}

#[test]
fn directory_file_sets_reject_missing_mismatched_and_ambiguous_members() {
    for case in ["missing", "mismatch", "ambiguous", "split", "zip"] {
        let temporary = tempfile::tempdir().unwrap();
        let (catalog, fixtures) = directory_set_catalog();
        for (index, (name, bytes)) in fixtures.iter().enumerate() {
            if case == "missing" && index == 2 {
                continue;
            }
            let directory = if case == "split" && index == 2 {
                temporary.path().join("other")
            } else {
                temporary.path().to_path_buf()
            };
            fs::create_dir_all(&directory).unwrap();
            fs::write(
                directory.join(name),
                if case == "mismatch" && index == 2 {
                    b"wrong".as_slice()
                } else {
                    bytes
                },
            )
            .unwrap();
        }
        if case == "ambiguous" {
            fs::write(temporary.path().join("64DD_IPL_US_MJR.n64"), &fixtures[2].1).unwrap();
        }
        if case == "zip" {
            for (name, _) in &fixtures {
                fs::remove_file(temporary.path().join(name)).unwrap();
            }
            let mut zip =
                zip::ZipWriter::new(fs::File::create(temporary.path().join("set.zip")).unwrap());
            for (name, bytes) in &fixtures {
                zip.start_file(*name, zip::write::SimpleFileOptions::default())
                    .unwrap();
                zip.write_all(bytes).unwrap();
            }
            zip.finish().unwrap();
        }
        let mut selected = request(temporary.path());
        selected.profile_ids = vec!["g-diffuser-source-set".into()];
        let report = scan(&catalog, &selected).unwrap();
        if case == "zip" {
            assert_eq!(report.candidates.len(), 1);
            assert_eq!(report.files_hashed, 1);
            assert_eq!(
                report.hash_bytes,
                fs::metadata(temporary.path().join("set.zip"))
                    .unwrap()
                    .len()
                    + fixtures
                        .iter()
                        .map(|(_, bytes)| bytes.len() as u64)
                        .sum::<u64>()
            );
        } else {
            assert!(report.candidates.is_empty(), "{case}");
        }
        if case != "mismatch" && case != "zip" {
            assert_eq!(report.hash_bytes, 0, "{case}");
        }
    }
}

#[test]
fn directory_file_sets_keep_request_wide_limits_and_prior_snapshot_freshness() {
    let temporary = tempfile::tempdir().unwrap();
    let (catalog, fixtures) = directory_set_catalog();
    for child in ["one", "two"] {
        let directory = temporary.path().join(child);
        fs::create_dir(&directory).unwrap();
        for (name, bytes) in &fixtures {
            fs::write(directory.join(name), bytes).unwrap();
        }
    }
    let mut selected = request(temporary.path());
    selected.profile_ids = vec!["g-diffuser-source-set".into()];
    let size: u64 = fixtures.iter().map(|(_, bytes)| bytes.len() as u64).sum();
    selected.limits.max_hash_bytes = size;
    let report = scan(&catalog, &selected).unwrap();
    assert_eq!(report.candidates.len(), 1);
    assert_eq!(report.hash_bytes, size);
    assert!(
        report
            .limits_reached
            .contains(&SourceDiscoveryLimit::HashBytes)
    );
    selected.limits.max_hash_bytes = size * 2;
    selected.limits.max_entries = 3;
    let report = scan(&catalog, &selected).unwrap();
    assert!(report.candidates.is_empty());
    assert!(
        report
            .limits_reached
            .contains(&SourceDiscoveryLimit::Entries)
    );
    selected.limits.max_entries = 100;
    selected.limits.max_file_bytes = 1;
    let report = scan(&catalog, &selected).unwrap();
    assert!(report.candidates.is_empty());
    assert_eq!(report.hash_bytes, 0);
    assert!(
        report
            .limits_reached
            .contains(&SourceDiscoveryLimit::FileSize)
    );
    selected.limits.max_file_bytes = 100;
    selected.limits.max_candidates = 1;
    let report = scan(&catalog, &selected).unwrap();
    assert_eq!(report.candidates.len(), 1);
    assert!(
        report
            .limits_reached
            .contains(&SourceDiscoveryLimit::Candidates)
    );

    let library = crate::Library::open(temporary.path().join("library")).unwrap();
    library
        .add_game_file_root(&temporary.path().join("one"))
        .unwrap();
    let operation = crate::OperationCoordinator::new("directory-snapshot", None);
    let mut snapshot = build_game_file_scan(
        &catalog,
        &library,
        &SourceDiscoveryLimits::default(),
        &operation,
    )
    .unwrap();
    snapshot.format_version = 3;
    library.replace_game_file_scan_snapshot(&snapshot).unwrap();
    let old = super::current_game_file_scan(&catalog, &library)
        .unwrap()
        .unwrap();
    assert_eq!(old.format_version, 3);
    assert_eq!(old.freshness, GameFileScanFreshness::InputsChanged);
    snapshot.format_version = 4;
    library.replace_game_file_scan_snapshot(&snapshot).unwrap();
    let prior_zip_coverage = super::current_game_file_scan(&catalog, &library)
        .unwrap()
        .unwrap();
    assert_eq!(prior_zip_coverage.format_version, 4);
    assert_eq!(
        prior_zip_coverage.freshness,
        GameFileScanFreshness::InputsChanged
    );
    assert_eq!(
        old.report.candidates[0].sha256,
        snapshot.report.candidates[0].sha256
    );
}

#[test]
fn directory_file_set_candidate_is_provisional_and_cancellation_stops_the_scan() {
    let temporary = tempfile::tempdir().unwrap();
    let sources = temporary.path().join("sources");
    fs::create_dir(&sources).unwrap();
    let (catalog, fixtures) = directory_set_catalog();
    for (name, bytes) in &fixtures {
        fs::write(sources.join(name), bytes).unwrap();
    }
    let library = crate::Library::open(temporary.path().join("library")).unwrap();
    library.add_game_file_root(&sources).unwrap();
    let mut prior = build_game_file_scan(
        &catalog,
        &library,
        &SourceDiscoveryLimits::default(),
        &crate::OperationCoordinator::new("prior-set", None),
    )
    .unwrap();
    prior.completed_at = 1;
    library.replace_game_file_scan_snapshot(&prior).unwrap();
    let mut service = PortcoveService::new(library).unwrap();
    service.replace_catalog_for_test(catalog);
    let mut seen = false;
    let result =
        service.scan_game_file_roots_with_progress(&SourceDiscoveryLimits::default(), |event| {
            if let crate::OperationEventKind::SourceCandidate { profile_id, .. } = &event.event
                && profile_id == "g-diffuser-source-set"
            {
                seen = true;
                service.request_cancellation(&event.operation_id).unwrap();
            }
        });
    assert!(seen);
    assert_eq!(result.unwrap_err().code, ErrorCode::Cancelled);
    assert_eq!(
        service
            .library()
            .stored_game_file_scan_snapshot()
            .unwrap()
            .unwrap()
            .completed_at,
        1
    );
    assert!(service.library().sources().unwrap().is_empty());
}

#[test]
fn directory_file_sets_preserve_case_aliases_and_owned_tree_exclusions() {
    let temporary = tempfile::tempdir().unwrap();
    let (catalog, fixtures) = directory_set_catalog();
    for child in ["visible", "owned"] {
        let root = temporary.path().join(child);
        fs::create_dir(&root).unwrap();
        for (name, bytes) in &fixtures {
            fs::write(root.join(name.to_ascii_lowercase()), bytes).unwrap();
        }
    }
    let mut selected = request(temporary.path());
    selected.profile_ids = vec![
        "g-diffuser-source-set".into(),
        "g-diffuser-source-set".into(),
    ];
    selected.limits.max_hash_bytes = fixtures.iter().map(|(_, bytes)| bytes.len() as u64).sum();
    let report = super::scan(
        &catalog,
        &selected,
        &crate::OperationCoordinator::new("directory-exclusions", None),
        vec![DiscoveryExclusion {
            path: fs::canonicalize(temporary.path().join("owned")).unwrap(),
            kind: DiscoveryExclusionKind::ManagedOutput,
        }],
        None,
    )
    .unwrap();
    assert_eq!(report.candidates.len(), 1);
    assert_eq!(report.files_hashed, 3);
    assert_eq!(report.hash_bytes, selected.limits.max_hash_bytes);
    assert_eq!(report.searched_profiles, ["g-diffuser-source-set"]);
    assert_eq!(
        report.candidates[0].path,
        fs::canonicalize(temporary.path().join("visible")).unwrap()
    );
    assert!(
        report
            .issues
            .iter()
            .any(|issue| issue.message.contains("managed game output"))
    );
}

#[cfg(unix)]
#[test]
fn directory_file_set_symlink_members_are_not_followed() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("set");
    fs::create_dir(&root).unwrap();
    let (catalog, fixtures) = directory_set_catalog();
    for (name, bytes) in &fixtures[..2] {
        fs::write(root.join(name), bytes).unwrap();
    }
    let outside = temporary.path().join("outside");
    fs::write(&outside, &fixtures[2].1).unwrap();
    std::os::unix::fs::symlink(&outside, root.join(fixtures[2].0)).unwrap();
    let mut selected = request(&root);
    selected.profile_ids = vec!["g-diffuser-source-set".into()];
    let report = scan(&catalog, &selected).unwrap();
    assert!(report.candidates.is_empty());
    assert_eq!(report.symlinks_skipped, 1);
    assert_eq!(fs::read(outside).unwrap(), fixtures[2].1);
}

#[test]
fn directory_file_set_facts_do_not_share_admission_between_profiles_or_variants() {
    let temporary = tempfile::tempdir().unwrap();
    let (catalog, fixtures) = directory_set_catalog();
    for (name, bytes) in &fixtures {
        fs::write(temporary.path().join(name), bytes).unwrap();
    }
    let mut document = catalog.document().clone();
    let source = document.source_catalog.as_mut().unwrap();
    let mut rejected = source
        .identities
        .iter()
        .find(|identity| identity.id == "g-diffuser-source-set")
        .unwrap()
        .clone();
    rejected.id = "directory-rejected".into();
    let crate::SourceRepresentationKind::FileSet { members } =
        &mut rejected.variants[0].representations[0].kind
    else {
        unreachable!()
    };
    members[2].identities[0].crc32 = Some("ffffffff".into());
    source.identities.push(rejected);
    let mut json = serde_json::to_value(document).unwrap();
    json.as_object_mut().unwrap().remove("source_profiles");
    let catalog = Catalog::from_json(&json.to_string()).unwrap();
    let mut selected = request(temporary.path());
    selected.profile_ids = vec!["g-diffuser-source-set".into(), "directory-rejected".into()];
    selected.limits.max_hash_bytes = fixtures.iter().map(|(_, bytes)| bytes.len() as u64).sum();
    let report = scan(&catalog, &selected).unwrap();
    assert_eq!(report.candidates.len(), 1);
    assert_eq!(report.candidates[0].profile_id, "g-diffuser-source-set");
    assert_eq!(report.hash_bytes, selected.limits.max_hash_bytes);
    assert_eq!(report.files_hashed, 3);
    let mut document = catalog.document().clone();
    let identity = document
        .source_catalog
        .as_mut()
        .unwrap()
        .identities
        .iter_mut()
        .find(|identity| identity.id == "g-diffuser-source-set")
        .unwrap();
    let mut duplicate = identity.variants[0].clone();
    duplicate.id = "ambiguous-exact-copy".into();
    identity.variants.push(duplicate);
    let mut json = serde_json::to_value(document).unwrap();
    json.as_object_mut().unwrap().remove("source_profiles");
    let error = Catalog::from_json(&json.to_string()).unwrap_err();
    assert!(
        error
            .to_string()
            .contains("ambiguous deterministic identity")
    );
}

#[test]
fn zip_file_sets_share_facts_without_sharing_profile_admission() {
    let temporary = tempfile::tempdir().unwrap();
    let (catalog, fixtures) = directory_set_catalog();
    let path = temporary.path().join("SET.ZIP");
    let aliases = fixtures
        .iter()
        .map(|(name, bytes)| (name.to_ascii_lowercase(), bytes.clone()))
        .collect::<Vec<_>>();
    write_file_set_zip(
        &path,
        &aliases
            .iter()
            .map(|(name, bytes)| (name.as_str(), bytes.clone()))
            .collect::<Vec<_>>(),
    );
    let mut document = catalog.document().clone();
    let source = document.source_catalog.as_mut().unwrap();
    let original = source
        .identities
        .iter()
        .find(|profile| profile.id == "g-diffuser-source-set")
        .unwrap()
        .clone();
    let mut accepted = original.clone();
    accepted.id = "zip-accepted".into();
    let mut rejected = original;
    rejected.id = "a-zip-rejected".into();
    let crate::SourceRepresentationKind::FileSet { members } =
        &mut rejected.variants[0].representations[0].kind
    else {
        unreachable!()
    };
    members[2].identities[0].crc32 = Some("ffffffff".into());
    source.identities.extend([accepted, rejected]);
    let mut json = serde_json::to_value(document).unwrap();
    json.as_object_mut().unwrap().remove("source_profiles");
    let catalog = Catalog::from_json(&json.to_string()).unwrap();
    let mut selected = request(temporary.path());
    selected.profile_ids = vec![
        "g-diffuser-source-set".into(),
        "zip-accepted".into(),
        "a-zip-rejected".into(),
        "g-diffuser-source-set".into(),
    ];
    selected.limits.max_hash_bytes = fs::metadata(&path).unwrap().len()
        + fixtures
            .iter()
            .map(|(_, bytes)| bytes.len() as u64)
            .sum::<u64>();
    let report = scan(&catalog, &selected).unwrap();
    assert_eq!(
        report
            .candidates
            .iter()
            .map(|candidate| candidate.profile_id.as_str())
            .collect::<Vec<_>>(),
        ["g-diffuser-source-set", "zip-accepted"]
    );
    assert_eq!(report.hash_bytes, selected.limits.max_hash_bytes);
    assert_eq!(report.files_hashed, 1);
    assert!(report.limits_reached.is_empty());
    assert_eq!(report.searched_profiles.len(), 3);
    selected.limits.max_candidates = 1;
    let limited = scan(&catalog, &selected).unwrap();
    assert_eq!(limited.candidates.len(), 1);
    assert!(
        limited
            .limits_reached
            .contains(&SourceDiscoveryLimit::Candidates)
    );
}

#[test]
fn zip_file_sets_reject_incomplete_ambiguous_unsafe_and_corrupt_members() {
    for case in [
        "missing",
        "mismatch",
        "duplicate",
        "nested",
        "unsafe",
        "crc",
        "symlink",
    ] {
        let temporary = tempfile::tempdir().unwrap();
        let (catalog, mut fixtures) = directory_set_catalog();
        let path = temporary.path().join("set.zip");
        match case {
            "missing" => {
                fixtures.pop();
            }
            "mismatch" => fixtures[2].1 = b"wrong".to_vec(),
            "duplicate" => fixtures.push(("64DD_IPL_US_MJR.n64", fixtures[2].1.clone())),
            "nested" => fixtures[2].0 = "nested/N64DDIPLROM.n64",
            "unsafe" => fixtures[2].0 = "../N64DDIPLROM.n64",
            _ => {}
        }
        if case == "symlink" {
            let mut zip = zip::ZipWriter::new(fs::File::create(&path).unwrap());
            for (name, bytes) in &fixtures[..2] {
                zip.start_file(*name, zip::write::SimpleFileOptions::default())
                    .unwrap();
                zip.write_all(bytes).unwrap();
            }
            zip.add_symlink(
                fixtures[2].0,
                "outside",
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
            zip.finish().unwrap();
        } else {
            write_file_set_zip(&path, &fixtures);
        }
        if case == "crc" {
            let mut zip = zip::ZipArchive::new(fs::File::open(&path).unwrap()).unwrap();
            let offset = zip.by_index(0).unwrap().data_start().unwrap() as usize;
            let mut bytes = fs::read(&path).unwrap();
            bytes[offset] ^= 1;
            fs::write(&path, bytes).unwrap();
        }
        let original = fs::read(&path).unwrap();
        let mut selected = request(temporary.path());
        selected.profile_ids = vec!["g-diffuser-source-set".into()];
        let report = scan(&catalog, &selected).unwrap();
        assert!(report.candidates.is_empty(), "{case}");
        if matches!(
            case,
            "missing" | "duplicate" | "nested" | "unsafe" | "symlink"
        ) {
            assert_eq!(report.hash_bytes, 0, "{case}");
        }
        assert_eq!(fs::read(&path).unwrap(), original, "{case}");
        if case == "crc" || case == "symlink" {
            assert!(!report.issues.is_empty(), "{case}");
        }
    }
}

#[test]
fn zip_file_sets_keep_container_member_and_request_budgets() {
    let temporary = tempfile::tempdir().unwrap();
    let (catalog, fixtures) = directory_set_catalog();
    let path = temporary.path().join("set.zip");
    write_file_set_zip(&path, &fixtures);
    let length = fs::metadata(&path).unwrap().len();
    let mut selected = request(temporary.path());
    selected.profile_ids = vec!["g-diffuser-source-set".into()];
    selected.limits.max_hash_bytes = length
        + fixtures
            .iter()
            .map(|(_, bytes)| bytes.len() as u64)
            .sum::<u64>()
        - 1;
    let report = scan(&catalog, &selected).unwrap();
    assert!(report.candidates.is_empty());
    assert!(report.hash_bytes <= selected.limits.max_hash_bytes);
    assert!(
        report
            .limits_reached
            .contains(&SourceDiscoveryLimit::HashBytes)
    );
    selected.limits.max_hash_bytes = 1;
    let report = scan(&catalog, &selected).unwrap();
    assert_eq!(report.hash_bytes, 0);
    assert!(report.candidates.is_empty());
    assert!(
        report
            .limits_reached
            .contains(&SourceDiscoveryLimit::HashBytes)
    );
    selected.limits = SourceDiscoveryLimits::default();
    selected.limits.max_file_bytes = length - 1;
    let report = scan(&catalog, &selected).unwrap();
    assert_eq!(report.hash_bytes, 0);
    assert!(report.candidates.is_empty());
    assert!(
        report
            .limits_reached
            .contains(&SourceDiscoveryLimit::FileSize)
    );

    // A small compressed container cannot bypass the expanded-member bound.
    let mut zip = zip::ZipWriter::new(fs::File::create(&path).unwrap());
    for (name, _) in &fixtures {
        zip.start_file(
            *name,
            zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated),
        )
        .unwrap();
        zip.write_all(&[0; 4096]).unwrap();
    }
    zip.finish().unwrap();
    selected.limits.max_file_bytes = 1024;
    assert!(fs::metadata(&path).unwrap().len() < 1024);
    let report = scan(&catalog, &selected).unwrap();
    assert!(report.candidates.is_empty());
    assert!(
        report
            .limits_reached
            .contains(&SourceDiscoveryLimit::FileSize)
    );
    assert_eq!(report.hash_bytes, fs::metadata(&path).unwrap().len());
}

#[test]
fn zip_file_set_inventory_limit_precedes_hashing() {
    let temporary = tempfile::tempdir().unwrap();
    let (catalog, _) = directory_set_catalog();
    let path = temporary.path().join("set.zip");
    let mut zip = zip::ZipWriter::new(fs::File::create(&path).unwrap());
    for index in 0..4097 {
        zip.start_file(
            format!("unrelated-{index}"),
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
    }
    zip.finish().unwrap();
    let mut selected = request(temporary.path());
    selected.profile_ids = vec!["g-diffuser-source-set".into()];
    let report = scan(&catalog, &selected).unwrap();
    assert!(report.candidates.is_empty());
    assert_eq!(report.hash_bytes, 0);
    assert!(
        report
            .issues
            .iter()
            .any(|issue| issue.message.contains("too many entries"))
    );
}

#[test]
fn zip_file_set_changed_length_invalidates_observed_candidate() {
    for grows in [true, false] {
        let temporary = tempfile::tempdir().unwrap();
        let (catalog, fixtures) = directory_set_catalog();
        let path = temporary.path().join("set.zip");
        write_file_set_zip(&path, &fixtures);
        let path = fs::canonicalize(path).unwrap();
        let original = fs::read(&path).unwrap();
        let mut budget = HashBudget {
            operation: None,
            limit: 1_000_000,
            hashed: 0,
            max_zip_entries: 4096,
        };
        let mut archive = super::zip_file_sets::ZipFileSet::open(
            &path,
            &catalog,
            &["g-diffuser-source-set"],
            1_000_000,
            &mut budget,
        )
        .unwrap()
        .unwrap();
        let mut changed = original.clone();
        if grows {
            changed.push(0);
        } else {
            changed.pop();
        }
        fs::write(&path, &changed).unwrap();
        let error = archive
            .inspect(
                &catalog,
                "g-diffuser-source-set",
                &path,
                1_000_000,
                &mut budget,
            )
            .unwrap_err();
        assert!(error.message.contains("changed") || error.message.contains("shrank"));
        assert_eq!(fs::read(&path).unwrap(), changed);
    }
}

#[test]
fn zip_file_set_progress_cancellation_keeps_previous_snapshot() {
    let temporary = tempfile::tempdir().unwrap();
    let roots = temporary.path().join("sources");
    fs::create_dir(&roots).unwrap();
    let (catalog, fixtures) = directory_set_catalog();
    write_file_set_zip(&roots.join("set.zip"), &fixtures);
    let library = crate::Library::open(temporary.path().join("library")).unwrap();
    library.add_game_file_root(&roots).unwrap();
    let mut prior = build_game_file_scan(
        &catalog,
        &library,
        &SourceDiscoveryLimits::default(),
        &crate::OperationCoordinator::new("zip-prior", None),
    )
    .unwrap();
    prior.completed_at = 1;
    library.replace_game_file_scan_snapshot(&prior).unwrap();
    let mut service = PortcoveService::new(library).unwrap();
    service.replace_catalog_for_test(catalog);
    let mut seen = false;
    let result =
        service.scan_game_file_roots_with_progress(&SourceDiscoveryLimits::default(), |event| {
            if let crate::OperationEventKind::SourceCandidate { profile_id, .. } = &event.event
                && profile_id == "g-diffuser-source-set"
            {
                seen = true;
                service.request_cancellation(&event.operation_id).unwrap();
            }
        });
    assert!(seen);
    assert_eq!(result.unwrap_err().code, ErrorCode::Cancelled);
    assert_eq!(
        service
            .library()
            .stored_game_file_scan_snapshot()
            .unwrap()
            .unwrap()
            .completed_at,
        1
    );
    assert!(service.library().sources().unwrap().is_empty());
}

#[test]
fn zip_profile_limit_does_not_hide_a_later_independent_small_set() {
    let temporary = tempfile::tempdir().unwrap();
    let (catalog, fixtures) = directory_set_catalog();
    let path = temporary.path().join("set.zip");
    let large = vec![0; 4096];
    let mut zip = zip::ZipWriter::new(fs::File::create(&path).unwrap());
    for (name, bytes) in fixtures
        .iter()
        .map(|(name, bytes)| (*name, bytes.as_slice()))
        .chain([("large.bin", large.as_slice())])
    {
        zip.start_file(
            name,
            zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated),
        )
        .unwrap();
        zip.write_all(bytes).unwrap();
    }
    zip.finish().unwrap();
    let original = fs::read(&path).unwrap();
    assert!(original.len() < 1024);
    let mut document = catalog.document().clone();
    let source = document.source_catalog.as_mut().unwrap();
    let mut earlier = source
        .identities
        .iter()
        .find(|profile| profile.id == "g-diffuser-source-set")
        .unwrap()
        .clone();
    earlier.id = "a-expanded-set".into();
    let crate::SourceRepresentationKind::FileSet { members } =
        &mut earlier.variants[0].representations[0].kind
    else {
        unreachable!()
    };
    members[2].filenames = vec!["large.bin".into()];
    members[2].identities = vec![crate::DigestIdentity {
        scope: crate::DigestScope::FileSetMember,
        sha1: Some(hex::encode(sha1::Sha1::digest(&large))),
        sha256: Some(hex::encode(Sha256::digest(&large))),
        crc32: Some(format!("{:08x}", crc32fast::hash(&large))),
    }];
    source.identities.push(earlier);
    let mut json = serde_json::to_value(document).unwrap();
    json.as_object_mut().unwrap().remove("source_profiles");
    let catalog = Catalog::from_json(&json.to_string()).unwrap();
    for (maximum, expected_limit) in [
        (1024, SourceDiscoveryLimit::FileSize),
        (6000, SourceDiscoveryLimit::HashBytes),
    ] {
        let mut selected = request(temporary.path());
        selected.profile_ids = vec!["g-diffuser-source-set".into(), "a-expanded-set".into()];
        selected.limits.max_file_bytes = maximum;
        selected.limits.max_hash_bytes = original.len() as u64
            + fixtures
                .iter()
                .map(|(_, bytes)| bytes.len() as u64)
                .sum::<u64>();
        let report = scan(&catalog, &selected).unwrap();
        assert_eq!(report.candidates.len(), 1);
        assert_eq!(report.candidates[0].profile_id, "g-diffuser-source-set");
        assert_eq!(report.hash_bytes, selected.limits.max_hash_bytes);
        assert_eq!(report.files_hashed, 1);
        assert!(report.limits_reached.contains(&expected_limit));
        assert_eq!(fs::read(&path).unwrap(), original);
    }
}
