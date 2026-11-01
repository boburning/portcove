use super::*;
use crate::test_fixture::phase as test_phase;
use crate::{ArtifactIdentity, ArtworkSlot, BackupAction, Catalog, InstallRecord, ReleaseChannel};

#[test]
fn late_credentials_hold_import_before_the_open_gate() {
    let temporary = tempfile::tempdir().unwrap();
    let source = temporary.path().join("source");
    let export = temporary.path().join("export.json");
    let destination = temporary.path().join("destination");
    fixture(&source, &export);
    let plan = test_phase("credential import: plan", || {
        PortcoveService::plan_library_import(&export, &source, &destination).unwrap()
    });
    let credential = destination.join("user/starship/retroachievements.credentials");
    let error = test_phase("credential import: publication attempt", || {
        start_import(&export, &source, &destination, &plan.plan_sha256, &|at| {
            if at == TransferPhase::Verified {
                fs::create_dir_all(credential.parent().unwrap())?;
                fs::write(&credential, b"synthetic-no-account")?;
            }
            Ok(())
        })
    })
    .unwrap_err();
    assert!(error.details.contains_key("host_local_credential_path"));
    assert!(credential.exists());
    assert!(Library::open(&destination).is_err());
}

// This graph exercises generic retained-definition import, not a real title's
// catalog admission. Keep production-catalog transition fixtures separate.
fn successor_catalog() -> (Catalog, String) {
    let port_id = "post-client-definition-fixture";
    let document = serde_json::json!({
        "schema_version": 2,
        "source_catalog": {
            "evidence": [{
                "id": "fixture-bytes", "role": "byte_identity",
                "authority": "Synthetic import fixture", "authority_ref": "fixture-1",
                "reviewed_at": "2026-09-30", "claim": "Synthetic source byte identity",
                "immutable_url": "https://example.com/fixtures/source-v1"
            }],
            "identities": [{
                "id": "post-client-definition-fixture-source", "label": "Synthetic source",
                "kind": "file", "variants": [{
                    "id": "fixture-1", "title": "Synthetic source",
                    "representations": [{
                        "id": "raw", "extensions": ["bin"], "kind": "raw-file",
                        "identities": [{"scope": "original-file", "sha256": "8".repeat(64)}],
                        "evidence_ids": ["fixture-bytes"]
                    }], "evidence_ids": ["fixture-bytes"]
                }]
            }],
            "contracts": [{
                "id": "post-client-definition-fixture-game", "port_id": port_id,
                "role": "game", "profile_id": "post-client-definition-fixture-source",
                "admission_mode": "enforced", "supported_variant_ids": ["fixture-1"],
                "evidence_ids": ["fixture-bytes"], "authority_ref": "fixture-1",
                "reviewed_at": "2026-09-30",
                "immutable_review_url": "https://example.com/fixtures/source-v1"
            }], "validators": []
        },
        "ports": [{
            "id": port_id, "name": "Post-client definition fixture",
            "summary": "Synthetic retained-definition import contract",
            "project_url": "https://example.com/fixtures/import", "support_tier": "stable",
            "channels": ["stable"],
            "platforms": ["windows-x86-64", "linux-x86-64", "macos-x86-64", "macos-aarch64"],
            "adapter": "libultraship-portable",
            "release": {"repository": "boburning/qualification-fixture"},
            "source_profile": "post-client-definition-fixture-source",
            "executable_hints": {
                "windows-x86-64": ["fixture.exe"], "linux-x86-64": ["fixture"],
                "macos-x86-64": ["fixture"], "macos-aarch64": ["fixture"]
            }, "persistent_paths": ["saves", "config.json"]
        }]
    });
    (
        Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap(),
        port_id.into(),
    )
}

#[test]
fn successor_fixture_retains_a_complete_independent_source_graph() {
    let (catalog, port_id) = successor_catalog();
    assert_eq!(catalog.document().ports.len(), 1);
    let source = catalog.source_catalog().unwrap();
    assert_eq!(source.identities.len(), 1);
    assert_eq!(source.contracts.len(), 1);
    assert_eq!(source.evidence.len(), 1);
    assert!(source.qualification.is_empty());
    let indexed = crate::test_fixture::indexed_catalog(&catalog, &port_id);
    assert_eq!(
        serde_json::to_value(indexed.authoritative_document()).unwrap(),
        serde_json::to_value(catalog.authoritative_document()).unwrap()
    );
    for platform in &catalog.port(&port_id).unwrap().platforms {
        InstallQualification::from_catalog(&indexed, &port_id, *platform).unwrap();
    }
}

#[test]
fn successor_fixture_uses_real_graph_and_unknown_field_validation() {
    let (catalog, _) = successor_catalog();
    let mut document = serde_json::to_value(catalog.authoritative_document()).unwrap();
    document["source_catalog"]["contracts"][0]["profile_id"] = serde_json::json!("missing-profile");
    assert!(Catalog::from_json(&document.to_string()).is_err());
    let mut document = serde_json::to_value(catalog.authoritative_document()).unwrap();
    document["source_catalog"]["identities"][0]["unrecognized_authority"] = serde_json::json!(true);
    assert!(Catalog::from_json(&document.to_string()).is_err());
}

fn successor_fixture(root: &Path, export: &Path) -> (LibraryMetadata, String) {
    let library = Library::open(root).unwrap();
    let (post_client, port_id) = test_phase(
        "successor fixture: validate synthetic graph",
        successor_catalog,
    );
    let catalog = crate::test_fixture::admitted_indexed_catalog(&post_client, &port_id);
    crate::definition_candidate::selection::trust_catalog_selection_for_test(
        &library, &catalog, &port_id,
    );
    assert!(Catalog::embedded().unwrap().port(&port_id).is_err());
    let port = catalog.port(&port_id).unwrap();
    let platform = Platform::current().unwrap();
    let path = root.join("versions").join(&port_id).join("successor");
    fs::create_dir_all(&path).unwrap();
    let relative = &port.executable_hints[&platform][0];
    let executable = path.join(relative);
    fs::create_dir_all(executable.parent().unwrap()).unwrap();
    fs::write(&executable, b"admitted successor executable").unwrap();
    crate::permissions::normalize_archive_entry(&executable, false, true).unwrap();
    let artifact = ArtifactIdentity {
        asset_name: "successor.zip".into(),
        sha256: "7".repeat(64),
        size: 29,
    };
    let qualification = InstallQualification::from_catalog(&catalog, &port_id, platform).unwrap();
    let (manifest_sha256, selected_executable, runtime) = Installer::new(library.clone())
        .unwrap()
        .create_manifest(
            "successor",
            &port_id,
            "successor-1",
            &artifact,
            &qualification,
            &path,
        )
        .unwrap();
    library
        .register_install(
            &InstallRecord {
                id: "successor".into(),
                port_id: port_id.clone(),
                version: "successor-1".into(),
                path,
                channel: ReleaseChannel::Stable,
                installed_at: 1,
                verified: true,
                staged: false,
                artifact,
                manifest_sha256,
                selected_executable,
                runtime,
            },
            true,
        )
        .unwrap();
    let profile_id = port.source_profile.clone().unwrap();
    library
        .register_source(&crate::SourceRecord {
            profile_id,
            path: root.with_extension("successor-source"),
            sha256: "8".repeat(64),
            size: 1,
            storage_sha256: "9".repeat(64),
            storage_size: 1,
            updated_at: 1,
            observed_identity: None,
        })
        .unwrap();
    library.record_successful_launch(&port_id).unwrap();
    let mut service = PortcoveService::new(library).unwrap();
    service.replace_catalog_for_test(catalog);
    let artwork = root.with_extension("successor-cover.png");
    image::RgbImage::from_pixel(2, 2, image::Rgb([12, 34, 56]))
        .save(&artwork)
        .unwrap();
    service
        .import_artwork(&port_id, ArtworkSlot::Cover, &artwork, 0)
        .unwrap();
    service.write_library_metadata(export).unwrap();
    (service.export_library_metadata().unwrap(), port_id)
}

fn fixture_library(root: &Path, installs: &[(&str, bool)]) -> Library {
    let library = test_phase("import fixture: open library", || {
        Library::open(root).unwrap()
    });
    let catalog = test_phase("import fixture: embedded catalog", || {
        Catalog::embedded().unwrap()
    });
    let port = catalog.port("starship").unwrap();
    let platform = Platform::current().unwrap();
    let qualification = test_phase("import fixture: retained qualification", || {
        crate::test_fixture::retained_qualification(port, platform).unwrap()
    });
    for &(id, staged) in installs {
        let path = root.join("versions/starship").join(id);
        fs::create_dir_all(&path).unwrap();
        let executable = path.join(&port.executable_hints[&platform][0]);
        fs::write(&executable, format!("synthetic {id}")).unwrap();
        crate::permissions::normalize_archive_entry(&executable, false, true).unwrap();
        let artifact = ArtifactIdentity {
            asset_name: format!("{id}.zip"),
            sha256: "a".repeat(64),
            size: 42,
        };
        let (manifest_sha256, selected_executable, runtime) =
            test_phase("import fixture: create manifest", || {
                Installer::new(library.clone())
                    .unwrap()
                    .create_manifest(id, "starship", id, &artifact, &qualification, &path)
                    .unwrap()
            });
        test_phase("import fixture: register install", || {
            library
                .register_install(
                    &InstallRecord {
                        id: id.into(),
                        port_id: "starship".into(),
                        version: id.into(),
                        path,
                        channel: ReleaseChannel::Stable,
                        installed_at: 1,
                        verified: true,
                        staged,
                        artifact,
                        manifest_sha256,
                        selected_executable,
                        runtime,
                    },
                    !staged,
                )
                .unwrap()
        });
    }
    library
}

fn fixture(root: &Path, export: &Path) -> LibraryMetadata {
    let library = fixture_library(root, &[("old", false), ("active", false), ("staged", true)]);
    for tree in ["user", "toolchains"] {
        fs::create_dir_all(root.join(tree).join("starship/empty")).unwrap();
        fs::write(root.join(tree).join("starship/data.bin"), tree).unwrap();
    }
    library.record_successful_launch("starship").unwrap();
    let service = test_phase("import fixture: open service", || {
        PortcoveService::new(library).unwrap()
    });
    let original_source = root.with_extension("original.z64");
    fs::write(
        &original_source,
        b"\x80\x37\x12\x40synthetic imported source identity\0\0",
    )
    .unwrap();
    service
        .register_source("star-fox-64", &original_source)
        .unwrap();
    test_phase("import fixture: create backup", || {
        service.create_backup("starship").unwrap()
    });
    test_phase("import fixture: set output directory", || {
        service
            .set_output_directory("starship", &root.with_extension("starship-output"))
            .unwrap()
    });
    test_phase("import fixture: write metadata", || {
        service.write_library_metadata(export).unwrap()
    });
    test_phase("import fixture: export metadata", || {
        service.export_library_metadata().unwrap()
    })
}

fn add_retained_references(
    root: &Path,
    export: &Path,
    bindings: &[(&str, &str)],
) -> LibraryMetadata {
    let library = Library::open(root).unwrap();
    let installs = library.all_installs().unwrap();
    let references = bindings
        .iter()
        .map(|(install_id, setup_id)| {
            let install = installs
                .iter()
                .find(|install| install.id == *install_id)
                .unwrap();
            crate::RetainedBuildReference {
                id: uuid::Uuid::new_v4().to_string(),
                setup_id: (*setup_id).into(),
                revision: 1,
                build: crate::install::retained_build_identity_for_install(install).unwrap(),
                created_at: 1,
                updated_at: 1,
            }
        })
        .collect::<Vec<_>>();
    let mut connection = library.connection().unwrap();
    let transaction = connection.transaction().unwrap();
    crate::retained_build::restore_references(&transaction, &references).unwrap();
    transaction.commit().unwrap();
    let metadata = PortcoveService::new(library)
        .unwrap()
        .export_library_metadata()
        .unwrap();
    fs::write(export, serde_json::to_vec_pretty(&metadata).unwrap()).unwrap();
    metadata
}

#[test]
fn import_retained_reference_metadata_rejects_forgery() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    let export = temp.path().join("export.json");
    let destination = temp.path().join("destination");
    drop(fixture_library(&source, &[("active", false)]));
    let metadata = add_retained_references(&source, &export, &[("active", "customized")]);
    PortcoveService::plan_library_import(&export, &source, &destination).unwrap();

    let mut cases = Vec::new();
    let mut changed = metadata.clone();
    changed.schema_version = 3;
    cases.push(("older schema", changed));
    let mut changed = metadata.clone();
    changed
        .retained_build_references
        .push(changed.retained_build_references[0].clone());
    cases.push(("duplicate reference", changed));
    let mut changed = metadata.clone();
    let mut repeated_setup = changed.retained_build_references[0].clone();
    repeated_setup.id = uuid::Uuid::new_v4().to_string();
    changed.retained_build_references.push(repeated_setup);
    cases.push(("duplicate setup", changed));
    let mut changed = metadata.clone();
    changed.retained_build_references[0].build.install_id = "missing-install".into();
    cases.push(("missing installation", changed));
    let mut changed = metadata.clone();
    changed.application_versions[0].verified = false;
    cases.push(("unaccepted installation", changed));
    let mut changed = metadata.clone();
    changed.retained_build_references[0].build.artifact.sha256 = "b".repeat(64);
    cases.push(("artifact digest", changed));
    let mut changed = metadata.clone();
    changed.retained_build_references[0]
        .build
        .installed_contract_sha256 = "f".repeat(64);
    cases.push(("retained contract", changed));
    let mut changed = metadata.clone();
    changed.retained_build_references[0].build.platform =
        if changed.retained_build_references[0].build.platform == Platform::WindowsX86_64 {
            Platform::LinuxX86_64
        } else {
            Platform::WindowsX86_64
        };
    cases.push(("manifest platform", changed));
    let mut changed = metadata.clone();
    changed.retained_build_references.resize(
        crate::retained_build::MAX_REFERENCES + 1,
        metadata.retained_build_references[0].clone(),
    );
    cases.push(("reference bound", changed));

    for (case, changed) in cases {
        fs::write(&export, serde_json::to_vec_pretty(&changed).unwrap()).unwrap();
        let error =
            PortcoveService::plan_library_import(&export, &source, &destination).expect_err(case);
        assert!(error.message.contains("retained build"), "{case}: {error}");
        assert!(!destination.exists(), "{case}");
    }
}

#[test]
fn import_retained_reference_changes_invalidate_review() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    let export = temp.path().join("export.json");
    let destination = temp.path().join("destination");
    drop(fixture_library(&source, &[("active", false)]));
    let mut metadata = add_retained_references(&source, &export, &[("active", "customized")]);
    let plan = PortcoveService::plan_library_import(&export, &source, &destination).unwrap();
    metadata.retained_build_references[0].setup_id = "different-setup".into();
    fs::write(&export, serde_json::to_vec_pretty(&metadata).unwrap()).unwrap();
    let updated = PortcoveService::plan_library_import(&export, &source, &destination).unwrap();
    assert_ne!(plan.plan_sha256, updated.plan_sha256);
    assert_eq!(
        PortcoveService::import_library(&export, &source, &destination, &plan.plan_sha256)
            .unwrap_err()
            .code,
        crate::ErrorCode::Conflict
    );
    assert!(!destination.exists());
}

#[test]
fn import_retained_reference_failure_rolls_back_installation_metadata() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    let export = temp.path().join("export.json");
    drop(fixture_library(&source, &[("active", false)]));
    let mut metadata = add_retained_references(&source, &export, &[("active", "customized")]);
    metadata.retained_build_references[0].build.install_id = "missing-install".into();
    let destination = Library::open(temp.path().join("destination")).unwrap();
    assert!(restore_metadata(&destination, &metadata).is_err());
    assert!(destination.all_installs().unwrap().is_empty());
    assert!(
        crate::retained_build::references_from(&destination.connection().unwrap())
            .unwrap()
            .is_empty()
    );
    assert!(
        crate::import_journal::metadata_tables_empty(&destination.connection().unwrap()).unwrap()
    );
}

#[test]
fn import_missing_retained_reference_stops_recovery() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    let export = temp.path().join("export.json");
    let destination = temp.path().join("destination");
    drop(fixture_library(&source, &[("active", false)]));
    add_retained_references(&source, &export, &[("active", "customized")]);
    let plan = PortcoveService::plan_library_import(&export, &source, &destination).unwrap();
    start_import(
        &export,
        &source,
        &destination,
        &plan.plan_sha256,
        &|phase| {
            if phase == TransferPhase::Verified {
                Err(PortcoveError::state("synthetic reference interruption"))
            } else {
                Ok(())
            }
        },
    )
    .unwrap_err();
    rusqlite::Connection::open(destination.join("portcove.sqlite3"))
        .unwrap()
        .execute("DELETE FROM retained_build_references", [])
        .unwrap();
    let error = PortcoveService::resume_library_import(&destination).unwrap_err();
    assert!(
        error.message.contains("destination metadata differs"),
        "{error}"
    );
    assert!(Library::open(&destination).is_err());
    assert_eq!(
        crate::retained_build::references_from(
            &Library::open(&source).unwrap().connection().unwrap()
        )
        .unwrap()
        .len(),
        1
    );
}

#[test]
fn import_round_trip_preserves_versions_pointers_payloads_and_history_in_an_empty_library() {
    let observed = std::time::Instant::now();
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    let export = temp.path().join("export.json");
    let destination = temp.path().join("destination");
    fixture(&source, &export);
    let expected = add_retained_references(
        &source,
        &export,
        &[
            ("old", "customized"),
            ("active", "default"),
            ("old", "second-customized"),
        ],
    );
    assert_eq!(expected.schema_version, 5);
    let original_identity = Library::open(&source).unwrap().identity_record().unwrap();
    let open = Library::open(&destination).unwrap();
    let destination_identity = open.identity_record().unwrap();
    let plan = test_phase("import recovery: plan", || {
        PortcoveService::plan_library_import(&export, &source, &destination)
    })
    .unwrap();
    assert!(plan.destination_exists);
    assert!(
        test_phase("import recovery: execute", || {
            PortcoveService::import_library(&export, &source, &destination, &plan.plan_sha256)
        })
        .is_err()
    );
    drop(open);
    let result = test_phase("import recovery: execute", || {
        PortcoveService::import_library(&export, &source, &destination, &plan.plan_sha256)
    })
    .unwrap();
    assert!(result.completed && result.input_retained);
    eprintln!("import roundtrip phase: imported ({:?})", observed.elapsed());
    let restored = Library::open(&destination).unwrap();
    assert_ne!(restored.identity_record().unwrap().id, original_identity.id);
    assert_eq!(restored.identity_record().unwrap(), destination_identity);
    assert_eq!(
        Library::open(&source).unwrap().identity_record().unwrap(),
        original_identity
    );
    crate::transfer_copy::verify_metadata(&restored, &expected).unwrap();
    assert_eq!(
        crate::retained_build::references_from(&restored.connection().unwrap()).unwrap(),
        expected.retained_build_references
    );
    let status = restored.status("starship", ReleaseChannel::Stable).unwrap();
    assert_eq!(status.active.unwrap().id, "active");
    assert_eq!(status.previous.unwrap().id, "old");
    assert_eq!(status.staged.unwrap().id, "staged");
    assert_eq!(
        restored.output_directory("starship").unwrap(),
        expected.port_settings[0].output_directory
    );
    assert_eq!(
        restored
            .source("star-fox-64")
            .unwrap()
            .unwrap()
            .observed_identity,
        expected.source_references[0].observed_identity
    );
    let activity = restored.activities(1).unwrap().remove(0);
    assert_eq!(activity.status, ActivityStatus::Succeeded);
    assert!(activity.target_id.is_none());
    assert!(ImportJournal::read(&destination).unwrap().is_none());
    assert!(destination.join("recovery/library-import.json").is_file());
    assert_eq!(
        ImportJournal::read_recovery(&destination)
            .unwrap()
            .unwrap()
            .phase,
        TransferPhase::Complete,
        "completed import must retain its exact terminal receipt"
    );
    for tree in ["user", "toolchains"] {
        assert_eq!(
            fs::read(source.join(tree).join("starship/data.bin")).unwrap(),
            fs::read(destination.join(tree).join("starship/data.bin")).unwrap()
        );
        assert!(destination.join(tree).join("starship/empty").is_dir());
    }
    eprintln!("import roundtrip phase: metadata verified ({:?})", observed.elapsed());
    let service = PortcoveService::new(restored.clone()).unwrap();
    let backup = service.list_backups("starship").unwrap().backups.remove(0);
    eprintln!("import roundtrip phase: backup listed ({:?})", observed.elapsed());
    assert!(backup.path.starts_with(&destination));
    fs::write(destination.join("user/starship/data.bin"), b"after import").unwrap();
    let preview = service
        .preview_backup_action("starship", &backup.id, BackupAction::Restore)
        .unwrap();
    eprintln!("import roundtrip phase: restore reviewed ({:?})", observed.elapsed());
    let authorization = service
        .authorize_backup_action(
            "starship",
            &backup.id,
            BackupAction::Restore,
            &preview.preview_sha256,
        )
        .unwrap();
    eprintln!("import roundtrip phase: restore authorized ({:?})", observed.elapsed());
    let restored_backup = service
        .restore_backup("starship", &backup.id, &authorization.token)
        .unwrap();
    eprintln!("import roundtrip phase: backup restored ({:?})", observed.elapsed());
    assert!(restored_backup.safety_backup.is_some());
    assert_eq!(
        fs::read(destination.join("user/starship/data.bin")).unwrap(),
        b"user"
    );
    eprintln!("import roundtrip phase: releasing library ({:?})", observed.elapsed());
    drop(service);
    drop(restored);
    eprintln!("import roundtrip phase: library released ({:?})", observed.elapsed());
    // Completed import remains idempotent even when the old input is no longer mounted.
    fs::rename(&source, temp.path().join("offline-source")).unwrap();
    assert_eq!(
        ImportJournal::read_recovery(&destination)
            .unwrap()
            .unwrap()
            .phase,
        TransferPhase::Complete,
        "backup restore must preserve the completed import receipt"
    );
    assert!(
        test_phase("import recovery: resume", || {
            PortcoveService::resume_library_import(&destination)
        })
        .unwrap()
        .completed
    );
    eprintln!("import roundtrip phase: complete ({:?})", observed.elapsed());
}

#[test]
fn admitted_post_client_definition_survives_offline_import_with_its_full_graph() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    let export = temp.path().join("successor.json");
    let destination = temp.path().join("destination");
    let (_, port_id) = successor_fixture(&source, &export);
    let expected = add_retained_references(&source, &export, &[("successor", "customized")]);
    assert_eq!(expected.schema_version, 5);
    assert!(expected.portability_authority.is_some());
    assert!(
        expected.retained_build_references[0]
            .build
            .definition
            .is_some()
    );

    let mut forged = expected.clone();
    forged.retained_build_references[0]
        .build
        .definition
        .as_mut()
        .unwrap()
        .definition_revision += 1;
    fs::write(&export, serde_json::to_vec_pretty(&forged).unwrap()).unwrap();
    let error = PortcoveService::plan_library_import(&export, &source, &destination).unwrap_err();
    assert!(
        error.message.contains("verified installation contract"),
        "{error}"
    );
    assert!(!destination.exists());
    fs::write(&export, serde_json::to_vec_pretty(&expected).unwrap()).unwrap();

    let plan = PortcoveService::plan_library_import(&export, &source, &destination).unwrap();
    PortcoveService::import_library(&export, &source, &destination, &plan.plan_sha256).unwrap();

    let restored = Library::open(&destination).unwrap();
    crate::transfer_copy::verify_metadata(&restored, &expected).unwrap();
    let status = restored.status(&port_id, ReleaseChannel::Stable).unwrap();
    let install = status.active.unwrap();
    let retained = Installer::new(restored.clone())
        .unwrap()
        .retained_catalog(&install)
        .unwrap()
        .unwrap();
    assert!(retained.definition_selection(&port_id).is_some());
    assert_eq!(
        restored.sources().unwrap()[0].profile_id,
        retained
            .port(&port_id)
            .unwrap()
            .source_profile
            .clone()
            .unwrap()
    );
    assert_eq!(
        restored
            .status(&port_id, ReleaseChannel::Stable)
            .unwrap()
            .successful_launches,
        1
    );

    // The renderer's public input must use destination-owned bytes, even for a
    // definition that this client did not embed. Metadata equality alone does
    // not exercise resolution or thumbnail regeneration after import.
    fs::rename(&source, temp.path().join("source-unavailable")).unwrap();
    fs::rename(
        source.with_extension("successor-cover.png"),
        temp.path().join("original-cover-unavailable.png"),
    )
    .unwrap();
    let expected_choice = expected
        .artwork
        .as_ref()
        .unwrap()
        .choices
        .iter()
        .find(|choice| choice.port_id == port_id && choice.slot == ArtworkSlot::Cover)
        .unwrap();
    let service = PortcoveService::new(restored).unwrap();
    assert!(service.catalog().port(&port_id).is_err());
    let artwork = service.artwork(&port_id, ArtworkSlot::Cover).unwrap();
    assert_eq!(&artwork.choice, expected_choice);
    assert_eq!(artwork.availability, crate::ArtworkAvailability::Available);
    assert!(matches!(
        artwork.resolved_source,
        crate::ArtworkResolvedSource::LocalImport { .. }
    ));
    let thumbnail = service
        .artwork_thumbnail(&port_id, ArtworkSlot::Cover, expected_choice.revision)
        .unwrap();
    assert_eq!(
        Some(&thumbnail.asset_sha256),
        expected_choice.asset_sha256.as_ref()
    );
    assert_eq!(thumbnail.choice_revision, expected_choice.revision);
    assert_eq!(
        image::load_from_memory(&thumbnail.png)
            .unwrap()
            .to_rgb8()
            .get_pixel(0, 0),
        &image::Rgb([12, 34, 56])
    );
    service.clear_artwork_cache().unwrap();
    let restarted = PortcoveService::new(service.library().clone()).unwrap();
    let regenerated = restarted
        .artwork_thumbnail(&port_id, ArtworkSlot::Cover, expected_choice.revision)
        .unwrap();
    assert_eq!(regenerated.png, thumbnail.png);
    assert_eq!(
        &restarted
            .artwork(&port_id, ArtworkSlot::Cover)
            .unwrap()
            .choice,
        expected_choice
    );

    let reset = restarted
        .reset_artwork(&port_id, ArtworkSlot::Cover, expected_choice.revision)
        .unwrap();
    assert_eq!(reset.availability, crate::ArtworkAvailability::Fallback);
    assert!(reset.choice.asset_sha256.is_none());
    let imported = restarted
        .import_artwork(
            &port_id,
            ArtworkSlot::Cover,
            &temp.path().join("original-cover-unavailable.png"),
            reset.choice.revision,
        )
        .unwrap();
    assert_eq!(imported.availability, crate::ArtworkAvailability::Available);
    assert_eq!(imported.choice.asset_sha256, expected_choice.asset_sha256);
    assert!(
        restarted
            .reset_artwork(&port_id, ArtworkSlot::Cover, reset.choice.revision)
            .is_err()
    );

    // A registered installation alone is insufficient: validate the current
    // manifest and the destination's retained admission before using its title.
    let manifest_path = install.path.join(".portcove-manifest.json");
    let manifest = fs::read(&manifest_path).unwrap();
    fs::write(&manifest_path, b"invalid retained contract").unwrap();
    assert!(restarted.artwork(&port_id, ArtworkSlot::Cover).is_err());
    fs::write(&manifest_path, &manifest).unwrap();
    restarted
        .library()
        .connection()
        .unwrap()
        .execute(
            "UPDATE definition_selection_state SET revision=0,replay_floor_json=NULL,active_json=NULL,previous_json=NULL WHERE singleton=1",
            [],
        )
        .unwrap();
    assert!(restarted.artwork(&port_id, ArtworkSlot::Cover).is_err());
    assert!(
        restarted
            .artwork_thumbnail(&port_id, ArtworkSlot::Cover, imported.choice.revision)
            .is_err()
    );
    assert!(
        restarted
            .reset_artwork(&port_id, ArtworkSlot::Cover, imported.choice.revision)
            .is_err()
    );
    assert!(
        restarted
            .import_artwork(
                &port_id,
                ArtworkSlot::Cover,
                &temp.path().join("original-cover-unavailable.png"),
                imported.choice.revision,
            )
            .is_err()
    );
    assert_eq!(
        crate::artwork_store::choice(
            &restarted.library().connection().unwrap(),
            &port_id,
            ArtworkSlot::Cover,
        )
        .unwrap(),
        imported.choice
    );

    // Current catalog presentation wins without consulting the retired install.
    let mut document = retained.authoritative_document().clone();
    document.ports[0].name = "Current artwork title".into();
    let mut restarted = restarted;
    restarted.replace_catalog_for_test(
        Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap(),
    );
    fs::write(&manifest_path, b"invalid retained contract").unwrap();
    let current = restarted.artwork(&port_id, ArtworkSlot::Cover).unwrap();
    assert_eq!(current.generated_fallback.initials, "CA");
    assert_eq!(current.choice, imported.choice);
}

#[test]
fn copied_successor_snapshot_without_admission_cannot_grant_unknown_port_authority() {
    use sha2::{Digest, Sha256};

    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    let export = temp.path().join("successor.json");
    let destination = temp.path().join("destination");
    let (mut metadata, _) = successor_fixture(&source, &export);
    let install = &mut metadata.application_versions[0];
    let manifest_path = source.join(&install.path).join(".portcove-manifest.json");
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
    manifest["retained_contract"]["format"] = serde_json::json!(2);
    manifest["retained_contract"]
        .as_object_mut()
        .unwrap()
        .remove("admission");
    let bytes = serde_json::to_vec_pretty(&manifest).unwrap();
    fs::write(&manifest_path, &bytes).unwrap();
    install.manifest_sha256 = hex::encode(Sha256::digest(&bytes));
    fs::write(&export, serde_json::to_vec_pretty(&metadata).unwrap()).unwrap();

    let error = PortcoveService::plan_library_import(&export, &source, &destination).unwrap_err();
    assert!(error.message.contains("no admitted authority"), "{error}");
    assert!(!destination.exists());
}

#[test]
fn forged_but_self_consistent_successor_admission_cannot_reuse_portability_authority() {
    use sha2::{Digest, Sha256};

    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    let export = temp.path().join("successor.json");
    let destination = temp.path().join("destination");
    let (mut metadata, _) = successor_fixture(&source, &export);
    let install = &mut metadata.application_versions[0];
    let manifest_path = source.join(&install.path).join(".portcove-manifest.json");
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
    manifest["retained_contract"]["admission"]["grant_id"] =
        serde_json::json!("forged-portability-grant");
    let bytes = serde_json::to_vec_pretty(&manifest).unwrap();
    fs::write(&manifest_path, &bytes).unwrap();
    install.manifest_sha256 = hex::encode(Sha256::digest(&bytes));
    fs::write(&export, serde_json::to_vec_pretty(&metadata).unwrap()).unwrap();

    let error = PortcoveService::plan_library_import(&export, &source, &destination).unwrap_err();
    assert!(error.message.contains("portability authority"), "{error}");
    assert!(!destination.exists());
}

#[test]
fn successor_manifest_cannot_be_exported_after_source_admission_is_removed() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    let original = temp.path().join("successor.json");
    let forged = temp.path().join("forged.json");
    successor_fixture(&source, &original);
    let library = Library::open(&source).unwrap();
    library
        .connection()
        .unwrap()
        .execute(
            "UPDATE definition_selection_state
             SET revision=0,replay_floor_json=NULL,active_json=NULL,previous_json=NULL
             WHERE singleton=1",
            [],
        )
        .unwrap();

    let error = PortcoveService::new(library)
        .unwrap()
        .write_library_metadata(&forged)
        .unwrap_err();
    assert!(error.message.contains("source library"), "{error}");
    assert!(!forged.exists());
}

#[test]
fn admitted_post_client_definition_survives_interrupted_import_resume() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    let export = temp.path().join("successor.json");
    let destination = temp.path().join("destination");
    let (_, port_id) = successor_fixture(&source, &export);
    let plan = PortcoveService::plan_library_import(&export, &source, &destination).unwrap();

    start_import(
        &export,
        &source,
        &destination,
        &plan.plan_sha256,
        &|phase| {
            if phase == TransferPhase::Verified {
                Err(PortcoveError::state("synthetic successor interruption"))
            } else {
                Ok(())
            }
        },
    )
    .unwrap_err();
    assert!(
        PortcoveService::resume_library_import(&destination)
            .unwrap()
            .completed
    );
    assert!(
        Library::open(&destination)
            .unwrap()
            .status(&port_id, ReleaseChannel::Stable)
            .unwrap()
            .active
            .is_some()
    );
}

#[test]
fn journal_phase_cannot_manufacture_import_publication() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    let export = temp.path().join("export.json");
    let destination = temp.path().join("destination");
    fixture(&source, &export);
    let plan = PortcoveService::plan_library_import(&export, &source, &destination).unwrap();
    start_import(
        &export,
        &source,
        &destination,
        &plan.plan_sha256,
        &|phase| {
            if phase == TransferPhase::Copying {
                Err(PortcoveError::state("synthetic pre-copy interruption"))
            } else {
                Ok(())
            }
        },
    )
    .unwrap_err();
    let historical_id = uuid::Uuid::new_v4().to_string();
    rusqlite::Connection::open(destination.join("portcove.sqlite3"))
        .unwrap()
        .execute(
            "INSERT INTO activity_history(
               id, operation, target_kind, status, started_at, finished_at,
               import_receipt_sha256
             ) VALUES (?1, 'import_library', 'library', 'succeeded', 1, 2, ?2)",
            rusqlite::params![historical_id, "0".repeat(64)],
        )
        .unwrap();
    let path = destination.join(".portcove-import.json");
    let mut journal: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    journal["transfer_id"] = serde_json::json!(historical_id);
    journal["phase"] = serde_json::json!("published");
    fs::write(&path, serde_json::to_vec_pretty(&journal).unwrap()).unwrap();

    let error = PortcoveService::resume_library_import(&destination).unwrap_err();
    assert!(error.message.contains("publication record"), "{error}");
    assert!(Library::open(&destination).is_err());
}

fn assert_interrupted_import_recovery(phase: TransferPhase) {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    let export = temp.path().join("export.json");
    let destination = temp.path().join("destination");
    fixture(&source, &export);
    let expected = add_retained_references(
        &source,
        &export,
        &[("old", "customized"), ("active", "default")],
    );
    let plan = test_phase("import recovery: plan", || {
        PortcoveService::plan_library_import(&export, &source, &destination)
    })
    .unwrap();
    let failure = start_import(&export, &source, &destination, &plan.plan_sha256, &|at| {
        if at == phase {
            Err(PortcoveError::state("synthetic interruption"))
        } else {
            Ok(())
        }
    })
    .unwrap_err();
    assert!(failure.details.contains_key("import_destination"));
    if phase == TransferPhase::Published {
        drop(Library::open(&destination).unwrap());
        fs::write(destination.join("user/starship/data.bin"), b"new save").unwrap();
        fs::rename(&source, temp.path().join("offline-source")).unwrap();
        assert!(
            test_phase("import recovery: abort", || {
                PortcoveService::abort_library_import(&destination)
            })
            .is_err()
        );
    } else {
        assert!(Library::open(&destination).is_err());
    }
    assert!(
        test_phase("import recovery: resume", || {
            PortcoveService::resume_library_import(&destination)
        })
        .unwrap()
        .completed
    );
    if phase == TransferPhase::Published {
        assert_eq!(
            fs::read(destination.join("user/starship/data.bin")).unwrap(),
            b"new save"
        );
    }
    assert_eq!(
        crate::retained_build::references_from(
            &Library::open(&destination).unwrap().connection().unwrap()
        )
        .unwrap(),
        expected.retained_build_references
    );
}

#[test]
fn copying_import_recovers_without_replaying_old_saves() {
    assert_interrupted_import_recovery(TransferPhase::Copying);
}

#[test]
fn verified_import_recovers_without_replaying_old_saves() {
    assert_interrupted_import_recovery(TransferPhase::Verified);
}

#[test]
fn published_import_recovers_without_replaying_old_saves() {
    assert_interrupted_import_recovery(TransferPhase::Published);
}

fn assert_changed_import_retained(change_input: bool) {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    let export = temp.path().join("export.json");
    let destination = temp.path().join("destination");
    fixture(&source, &export);
    let plan = test_phase("import recovery: plan", || {
        PortcoveService::plan_library_import(&export, &source, &destination)
    })
    .unwrap();
    start_import(&export, &source, &destination, &plan.plan_sha256, &|at| {
        if at == TransferPhase::Verified {
            Err(PortcoveError::state("interruption"))
        } else {
            Ok(())
        }
    })
    .unwrap_err();
    let changed = if change_input { &source } else { &destination };
    fs::write(changed.join("user/starship/data.bin"), b"changed").unwrap();
    assert!(
        test_phase("import recovery: resume", || {
            PortcoveService::resume_library_import(&destination)
        })
        .is_err()
    );
    assert!(
        !test_phase("import recovery: abort", || {
            PortcoveService::abort_library_import(&destination)
        })
        .unwrap()
        .completed
    );
    assert!(
        !test_phase("import recovery: abort", || {
            PortcoveService::abort_library_import(&destination)
        })
        .unwrap()
        .completed
    );
    assert!(Library::open(&destination).is_err());
    assert_eq!(
        fs::read(changed.join("user/starship/data.bin")).unwrap(),
        b"changed"
    );
    assert!(Library::open(&source).is_ok());
}

#[test]
fn changed_import_input_is_retained_and_never_published() {
    assert_changed_import_retained(true);
}

#[test]
fn changed_import_destination_is_retained_and_never_published() {
    assert_changed_import_retained(false);
}

#[test]
fn stale_plan_and_existing_data_are_rejected_before_creating_an_import() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    let export = temp.path().join("export.json");
    let destination = temp.path().join("destination");
    fixture(&source, &export);
    let plan = test_phase("import recovery: plan", || {
        PortcoveService::plan_library_import(&export, &source, &destination)
    })
    .unwrap();
    fs::write(source.join("user/starship/data.bin"), b"changed").unwrap();
    assert!(
        test_phase("import recovery: execute", || {
            PortcoveService::import_library(&export, &source, &destination, &plan.plan_sha256)
        })
        .is_err()
    );
    assert!(!destination.exists());
    fs::create_dir(&destination).unwrap();
    fs::write(destination.join("unrelated.txt"), b"retain").unwrap();
    assert!(
        test_phase("import recovery: plan", || {
            PortcoveService::plan_library_import(&export, &source, &destination)
        })
        .is_err()
    );
    assert!(!destination.join("locks").exists());
}

#[test]
fn interrupted_abort_cannot_be_resumed_as_a_successful_import() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    let export = temp.path().join("export.json");
    let destination = temp.path().join("destination");
    fixture(&source, &export);
    let plan = test_phase("import recovery: plan", || {
        PortcoveService::plan_library_import(&export, &source, &destination)
    })
    .unwrap();
    start_import(&export, &source, &destination, &plan.plan_sha256, &|at| {
        if at == TransferPhase::Verified {
            Err(PortcoveError::state("interrupted"))
        } else {
            Ok(())
        }
    })
    .unwrap_err();
    let journal = ImportJournal::read(&destination).unwrap().unwrap();
    let target = Library::open_exclusive(&destination).unwrap();
    target
        .finish_activity(
            &journal.transfer_id,
            ActivityStatus::Failed,
            Some("aborting"),
        )
        .unwrap();
    drop(target);
    assert!(
        test_phase("import recovery: resume", || {
            PortcoveService::resume_library_import(&destination)
        })
        .is_err()
    );
    assert!(Library::open(&destination).is_err());
    assert!(
        !test_phase("import recovery: abort", || {
            PortcoveService::abort_library_import(&destination)
        })
        .unwrap()
        .completed
    );
    assert_eq!(
        ImportJournal::read(&destination).unwrap().unwrap().phase,
        TransferPhase::Aborted
    );
}

#[test]
fn imported_retained_arguments_cannot_grant_themselves_execution_authority() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    let export = temp.path().join("export.json");
    let destination = temp.path().join("destination");
    let library = fixture_library(&source, &[("active", false)]);
    let mut metadata = PortcoveService::new(library.clone())
        .unwrap()
        .export_library_metadata()
        .unwrap();
    let install = &mut metadata.application_versions[0];
    let mut forged_port = Catalog::embedded()
        .unwrap()
        .port(&install.port_id)
        .unwrap()
        .clone();
    forged_port
        .launch_arguments
        .push("--unreviewed-command".into());
    let qualification =
        crate::test_fixture::retained_qualification(&forged_port, Platform::current().unwrap())
            .unwrap();
    let (hash, executable, runtime) = Installer::new(library)
        .unwrap()
        .create_manifest(
            &install.id,
            &install.port_id,
            &install.version,
            &install.artifact,
            &qualification,
            &source.join(&install.path),
        )
        .unwrap();
    install.manifest_sha256 = hash;
    install.selected_executable = executable;
    install.runtime = runtime;
    fs::write(&export, serde_json::to_vec_pretty(&metadata).unwrap()).unwrap();
    let error = test_phase("import recovery: plan", || {
        PortcoveService::plan_library_import(&export, &source, &destination)
    })
    .unwrap_err();
    assert!(error.message.contains("execution"), "{error}");
    assert!(!destination.exists());
}

#[test]
fn a_self_consistent_manifest_cannot_select_an_undeclared_executable_on_import() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    let export = temp.path().join("export.json");
    let destination = temp.path().join("destination");
    let library = fixture_library(&source, &[("active", false)]);
    let mut metadata = PortcoveService::new(library.clone())
        .unwrap()
        .export_library_metadata()
        .unwrap();
    let install = &mut metadata.application_versions[0];
    let path = source.join(&install.path);
    fs::write(path.join("undeclared.exe"), b"not a declared application").unwrap();
    crate::permissions::normalize_archive_entry(&path.join("undeclared.exe"), false, true).unwrap();
    let mut forged_port = Catalog::embedded()
        .unwrap()
        .port(&install.port_id)
        .unwrap()
        .clone();
    forged_port
        .executable_hints
        .insert(Platform::current().unwrap(), vec!["undeclared.exe".into()]);
    let forged =
        crate::test_fixture::retained_qualification(&forged_port, Platform::current().unwrap())
            .unwrap();
    let (hash, executable, runtime) = Installer::new(library)
        .unwrap()
        .create_manifest(
            &install.id,
            &install.port_id,
            &install.version,
            &install.artifact,
            &forged,
            &path,
        )
        .unwrap();
    install.manifest_sha256 = hash;
    install.selected_executable = executable;
    install.runtime = runtime;
    fs::write(&export, serde_json::to_vec_pretty(&metadata).unwrap()).unwrap();
    let error = test_phase("import recovery: plan", || {
        PortcoveService::plan_library_import(&export, &source, &destination)
    })
    .unwrap_err();
    assert!(error.message.contains("execution"), "{error}");
    assert!(!destination.exists());
}
