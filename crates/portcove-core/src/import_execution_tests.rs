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

pub(crate) fn fixture_library(root: &Path, installs: &[(&str, bool)]) -> Library {
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
                history: Vec::new(),
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
    let service = PortcoveService::new(restored.clone()).unwrap();
    let backup = service.list_backups("starship").unwrap().backups.remove(0);
    assert!(backup.path.starts_with(&destination));
    fs::write(destination.join("user/starship/data.bin"), b"after import").unwrap();
    let preview = service
        .preview_backup_action("starship", &backup.id, BackupAction::Restore)
        .unwrap();
    let authorization = service
        .authorize_backup_action(
            "starship",
            &backup.id,
            BackupAction::Restore,
            &preview.preview_sha256,
        )
        .unwrap();
    let restored_backup = service
        .restore_backup("starship", &backup.id, &authorization.token)
        .unwrap();
    assert!(restored_backup.safety_backup.is_some());
    assert_eq!(
        fs::read(destination.join("user/starship/data.bin")).unwrap(),
        b"user"
    );
    drop(service);
    drop(restored);
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
    let selection = retained.definition_selection(&port_id).unwrap();
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
    let embedded = Catalog::embedded().unwrap();
    assert!(embedded.listing(&port_id).is_err());
    let mut service = PortcoveService::new(restored).unwrap();
    assert_eq!(
        service.catalog().definition_selection(&port_id),
        Some(selection)
    );
    // Exercise the retained-only renderer path with the bundled catalog while
    // preserving the imported admission receipt for the installed build.
    service.replace_catalog_for_test(embedded.clone());
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
    let mut restarted = PortcoveService::new(service.library().clone()).unwrap();
    assert_eq!(
        restarted.catalog().definition_selection(&port_id),
        Some(selection)
    );
    restarted.replace_catalog_for_test(embedded);
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
        .execute_batch(
            "DELETE FROM definition_subject_selection;
             UPDATE definition_selection_state SET revision=0,replay_floor_json=NULL WHERE singleton=1;",
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
        .execute_batch(
            "DELETE FROM definition_subject_selection;
             UPDATE definition_selection_state SET revision=0,replay_floor_json=NULL WHERE singleton=1;",
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
    let existing = destination.join("unrelated.txt");
    fs::write(&existing, b"retain").unwrap();
    let occupied = test_phase("import recovery: plan", || {
        PortcoveService::plan_library_import(&export, &source, &destination)
    })
    .unwrap_err();
    assert_eq!(occupied.code, crate::ErrorCode::Conflict);
    assert_eq!(
        occupied
            .details
            .get("import_destination_state")
            .map(String::as_str),
        Some("occupied")
    );
    assert_eq!(fs::read(existing).unwrap(), b"retain");
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

fn add_profile(root: &Path, export: &Path, install_id: &str) -> LibraryMetadata {
    let library = Library::open(root).unwrap();
    let install = library
        .all_installs()
        .unwrap()
        .into_iter()
        .find(|install| install.id == install_id)
        .unwrap();
    let build = crate::install::retained_build_identity_for_install(&install).unwrap();
    let mut profile = crate::profile::new_profile("starship", "Default", true);
    profile.current_revision = 1;
    let reference = crate::RetainedBuildReference {
        id: uuid::Uuid::new_v4().to_string(),
        setup_id: profile.id.clone(),
        revision: 1,
        build: build.clone(),
        history: Vec::new(),
        created_at: 1,
        updated_at: 1,
    };
    let mut revision = crate::ProfileRevision {
        profile_id: profile.id.clone(),
        revision: 1,
        parent_revision: None,
        build,
        originals: Vec::new(),
        loader: None,
        packages: Vec::new(),
        recomp_companion_sets_v1: None,
        orderings: Vec::new(),
        settings: Default::default(),
        save_group: uuid::Uuid::new_v4().to_string(),
        limits: Vec::new(),
        created_at: 1,
        digest: String::new(),
    };
    crate::profile::seal(&mut revision).unwrap();
    let mut connection = library.connection().unwrap();
    let transaction = connection.transaction().unwrap();
    crate::retained_build::restore_references(&transaction, &[reference]).unwrap();
    crate::profile::write_profile(&transaction, &profile).unwrap();
    crate::profile::write_revision(&transaction, &revision).unwrap();
    transaction.commit().unwrap();
    let metadata = PortcoveService::new(library)
        .unwrap()
        .export_library_metadata()
        .unwrap();
    fs::write(export, serde_json::to_vec_pretty(&metadata).unwrap()).unwrap();
    metadata
}

#[test]
fn import_carries_profiles_under_schema_six_and_rejects_forgery() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    let export = temp.path().join("export.json");
    let destination = temp.path().join("destination");
    drop(fixture_library(&source, &[("active", false)]));
    let metadata = add_profile(&source, &export, "active");
    assert_eq!(metadata.schema_version, 6);
    assert_eq!(metadata.profiles.len(), 1);
    PortcoveService::plan_library_import(&export, &source, &destination).unwrap();

    let mut cases = Vec::new();
    let mut changed = metadata.clone();
    changed.schema_version = 5;
    cases.push(("older schema", changed));
    let mut changed = metadata.clone();
    changed.profiles[0].revisions[0].save_group = "tampered".into();
    cases.push(("tampered digest", changed));
    let mut changed = metadata.clone();
    changed.retained_build_references.clear();
    cases.push(("missing reference", changed));
    let mut changed = metadata.clone();
    changed.profiles[0].revisions.clear();
    cases.push(("missing revisions", changed));
    let mut changed = metadata.clone();
    changed.profiles.push(changed.profiles[0].clone());
    cases.push(("repeated profile", changed));
    for (case, changed) in cases {
        fs::write(&export, serde_json::to_vec_pretty(&changed).unwrap()).unwrap();
        assert!(
            PortcoveService::plan_library_import(&export, &source, &destination).is_err(),
            "{case}"
        );
        assert!(!destination.exists(), "{case}");
    }

    // A faithful restore reproduces the exact profile, revisions and digests.
    let restored = Library::open(temp.path().join("restored")).unwrap();
    restore_metadata(&restored, &metadata).unwrap();
    let exported = crate::profile::export(&restored.connection().unwrap()).unwrap();
    assert_eq!(exported, metadata.profiles);
}

fn add_memberships(root: &Path, export: &Path) -> LibraryMetadata {
    let library = Library::open(root).unwrap();
    let request = |port: &str| crate::LibraryMembershipRequest {
        port_id: port.into(),
        origin: crate::LibraryMembershipOrigin::GameFileDiscovery,
        sources: vec![crate::LibraryMembershipSource {
            profile_id: "profile".into(),
            sha256: "a".repeat(64),
        }],
    };
    library
        .add_library_memberships(
            &[request("alpha"), request("beta")],
            &std::collections::HashSet::new(),
        )
        .unwrap();
    let metadata = PortcoveService::new(library)
        .unwrap()
        .export_library_metadata()
        .unwrap();
    fs::write(export, serde_json::to_vec_pretty(&metadata).unwrap()).unwrap();
    metadata
}

#[test]
fn import_carries_saved_library_entries_under_schema_seven_and_rejects_forgery() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    let export = temp.path().join("export.json");
    let destination = temp.path().join("destination");
    drop(fixture_library(&source, &[("active", false)]));
    let metadata = add_memberships(&source, &export);
    assert_eq!(metadata.schema_version, 7);
    assert_eq!(metadata.library_memberships.len(), 2);
    PortcoveService::plan_library_import(&export, &source, &destination).unwrap();

    let mut cases = Vec::new();
    // An older reader contract would silently drop the entries.
    let mut changed = metadata.clone();
    changed.schema_version = 6;
    cases.push(("older schema", changed));
    let mut changed = metadata.clone();
    changed
        .library_memberships
        .push(changed.library_memberships[0].clone());
    cases.push(("repeated entry", changed));
    let mut changed = metadata.clone();
    changed.library_memberships[0].port_id = "Not A Port".into();
    cases.push(("invalid port id", changed));
    let mut changed = metadata.clone();
    changed.library_memberships[0].sources[0].sha256 = "xyz".into();
    cases.push(("invalid source digest", changed));
    let mut changed = metadata.clone();
    changed.library_memberships[0].format_version = 99;
    cases.push(("unsupported format", changed));
    for (case, changed) in cases {
        fs::write(&export, serde_json::to_vec_pretty(&changed).unwrap()).unwrap();
        assert!(
            PortcoveService::plan_library_import(&export, &source, &destination).is_err(),
            "{case}"
        );
        assert!(!destination.exists(), "{case}");
    }

    // A faithful restore reproduces the exact saved entries.
    let restored = Library::open(temp.path().join("restored")).unwrap();
    restore_metadata(&restored, &metadata).unwrap();
    assert_eq!(
        restored.library_memberships().unwrap(),
        metadata.library_memberships
    );
}

#[test]
fn mod_portal_choices_round_trip_through_export_and_interrupted_import() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    let export = temp.path().join("export.json");
    let destination = temp.path().join("destination");
    let library = Library::open(&source).unwrap();
    let expected = crate::mod_portal_preferences::record_portability_fixture(&library);
    let service = PortcoveService::new(library).unwrap();
    service.write_library_metadata(&export).unwrap();
    assert_eq!(
        service.export_library_metadata().unwrap().schema_version,
        17
    );
    drop(service);

    let original = fs::read(&export).unwrap();
    let metadata: LibraryMetadata = serde_json::from_slice(&original).unwrap();
    let mut older = metadata.clone();
    older.schema_version = 16;
    let mut duplicate = metadata.clone();
    duplicate.mod_portal_preferences.push(expected.clone());
    let mut duplicate_binding = metadata.clone();
    duplicate_binding.mod_portal_preferences[0]
        .hidden_communities
        .push(expected.hidden_communities[0].clone());
    let mut invalid_scope = metadata.clone();
    invalid_scope.mod_portal_preferences[0].hidden_communities[0].community =
        Some("foreign/scope".into());
    let mut invalid_revision = metadata.clone();
    invalid_revision.mod_portal_preferences[0]
        .preferences
        .revision = 0;
    let mut exhausted_revision = metadata.clone();
    exhausted_revision.mod_portal_preferences[0]
        .preferences
        .revision = (1u64 << 53) - 2;
    let mut imprecise_revision = metadata.clone();
    imprecise_revision.mod_portal_preferences[0]
        .preferences
        .revision = i64::MAX as u64;
    let mut empty_fence = metadata.clone();
    empty_fence.mod_portal_preferences.clear();
    for invalid in [
        older,
        duplicate,
        duplicate_binding,
        invalid_scope,
        invalid_revision,
        exhausted_revision,
        imprecise_revision,
        empty_fence,
    ] {
        fs::write(&export, serde_json::to_vec_pretty(&invalid).unwrap()).unwrap();
        assert!(PortcoveService::plan_library_import(&export, &source, &destination).is_err());
        assert!(!destination.exists());
    }

    fs::write(&export, original).unwrap();
    let plan = PortcoveService::plan_library_import(&export, &source, &destination).unwrap();
    assert_eq!(plan.metadata.mod_portal_preferences, [expected.clone()]);
    start_import(
        &export,
        &source,
        &destination,
        &plan.plan_sha256,
        &|phase| {
            if phase == TransferPhase::Verified {
                return Err(PortcoveError::state(
                    "fixture interruption after metadata restore",
                ));
            }
            Ok(())
        },
    )
    .unwrap_err();
    assert!(
        PortcoveService::resume_library_import(&destination)
            .unwrap()
            .completed
    );
    let restored = PortcoveService::new(Library::open(&destination).unwrap()).unwrap();
    assert_eq!(
        restored
            .export_library_metadata()
            .unwrap()
            .mod_portal_preferences,
        [expected.clone()]
    );
    // A prior reader can write a new raw revision without knowing the sidecar.
    restored
        .library()
        .connection()
        .unwrap()
        .execute(
            "UPDATE mod_portal_preferences SET revision = 8 WHERE port_id=?1",
            [&expected.port_id],
        )
        .unwrap();
    let mut current = expected;
    current.preferences.revision = 8;
    current.hidden_communities.clear();
    assert_eq!(
        restored
            .export_library_metadata()
            .unwrap()
            .mod_portal_preferences,
        [current]
    );
}

#[test]
fn an_export_without_saved_library_entries_keeps_its_older_schema() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    drop(fixture_library(&source, &[("active", false)]));
    let metadata = PortcoveService::new(Library::open(&source).unwrap())
        .unwrap()
        .export_library_metadata()
        .unwrap();
    assert!(metadata.library_memberships.is_empty());
    assert!(metadata.schema_version < 7);
}

#[test]
fn library_import_keeps_customized_original_instances_and_rebases_the_inbox() {
    assert_library_import_keeps_inbox_original(true);
}

#[test]
fn library_import_rebases_the_sole_registered_inbox_original() {
    assert_library_import_keeps_inbox_original(false);
}

fn assert_library_import_keeps_inbox_original(register_external_default: bool) {
    let temporary = tempfile::tempdir().unwrap();
    let source_root = temporary.path().join("source");
    let target_root = temporary.path().join("target");
    let export = temporary.path().join("library.json");
    let external = temporary.path().join("external.z64");
    let service =
        PortcoveService::new(fixture_library(&source_root, &[("active", false)])).unwrap();
    let inbox_original = service.library().source_inbox_dir().join("saved.z64");
    fs::create_dir_all(inbox_original.parent().unwrap()).unwrap();
    fs::write(&inbox_original, [0x80, 0x37, 0x12, 0x40, 1, 2, 3, 4]).unwrap();
    fs::write(&external, [0x80, 0x37, 0x12, 0x40, 5, 6, 7, 8]).unwrap();
    let requirement = "star-fox-64";
    let original = service
        .register_source(requirement, &inbox_original)
        .unwrap();
    let default = service.ensure_default_profile("starship").unwrap();
    let setup = service
        .copy_profile("starship", &default.id, "Inbox original")
        .unwrap();
    let current_default = if register_external_default {
        service.register_source(requirement, &external).unwrap()
    } else {
        original.clone()
    };
    let metadata = service.export_library_metadata().unwrap();
    assert_eq!(metadata.schema_version, 12);
    assert_eq!(
        metadata.source_instances.len(),
        usize::from(register_external_default)
    );
    service.write_library_metadata(&export).unwrap();
    drop(service);

    let plan = PortcoveService::plan_library_import(&export, &source_root, &target_root).unwrap();
    let imported =
        PortcoveService::import_library(&export, &source_root, &target_root, &plan.plan_sha256)
            .unwrap();
    assert!(imported.completed);
    let restored = PortcoveService::new(Library::open(&target_root).unwrap()).unwrap();
    let registry_default = restored.library().source(requirement).unwrap().unwrap();
    let restored_inbox_path = restored.library().source_inbox_dir().join("saved.z64");
    let restored_inbox_path = std::fs::canonicalize(restored_inbox_path).unwrap();
    if register_external_default {
        assert_eq!(registry_default.path, current_default.path);
    } else {
        assert_eq!(
            std::fs::canonicalize(&registry_default.path).unwrap(),
            restored_inbox_path
        );
    }
    assert_eq!(registry_default.sha256, current_default.sha256);
    let binding =
        restored.profile_revisions("starship", &setup.id).unwrap()[0].originals[0].clone();
    assert_eq!(
        binding,
        crate::profile::bind_original(requirement, &original)
    );
    let retained = restored.registered_profile_original(&binding).unwrap();
    assert_eq!(
        std::fs::canonicalize(&retained.path).unwrap(),
        restored_inbox_path
    );
    crate::source_inspection::verify_registered(restored.catalog(), &retained).unwrap();
}

/// Writes `count` setups for one installation in a single transaction. Each
/// revision carries `limit_bytes` of recorded limits so a large library also
/// crosses the old 16 MiB whole-document ceiling.
pub(crate) fn add_scaled_profiles(root: &Path, install_id: &str, count: usize, limit_bytes: usize) {
    let library = Library::open(root).unwrap();
    let install = library
        .all_installs()
        .unwrap()
        .into_iter()
        .find(|install| install.id == install_id)
        .unwrap();
    let build = crate::install::retained_build_identity_for_install(&install).unwrap();
    let limits = (0..limit_bytes.div_ceil(1000))
        .map(|index| format!("{index:04}{}", "l".repeat(996)))
        .collect::<Vec<_>>();
    let mut connection = library.connection().unwrap();
    let transaction = connection.transaction().unwrap();
    for index in 0..count {
        let mut profile = crate::profile::new_profile("starship", &format!("Setup {index}"), false);
        profile.current_revision = 1;
        let reference = crate::RetainedBuildReference {
            id: uuid::Uuid::new_v4().to_string(),
            setup_id: profile.id.clone(),
            revision: 1,
            build: build.clone(),
            history: Vec::new(),
            created_at: 1,
            updated_at: 1,
        };
        let mut revision = crate::ProfileRevision {
            profile_id: profile.id.clone(),
            revision: 1,
            parent_revision: None,
            build: build.clone(),
            originals: Vec::new(),
            loader: None,
            packages: Vec::new(),
            recomp_companion_sets_v1: None,
            orderings: Vec::new(),
            settings: Default::default(),
            save_group: uuid::Uuid::new_v4().to_string(),
            limits: limits.clone(),
            created_at: 1,
            digest: String::new(),
        };
        crate::profile::seal(&mut revision).unwrap();
        crate::retained_build::restore_references(&transaction, &[reference]).unwrap();
        crate::profile::write_profile(&transaction, &profile).unwrap();
        crate::profile::write_revision(&transaction, &revision).unwrap();
    }
    transaction.commit().unwrap();
}

const OLD_METADATA_CEILING: u64 = 16 * 1024 * 1024;

fn assert_scaled_library_round_trip(count: usize, limit_bytes: usize, interrupt: TransferPhase) {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    let export = temp.path().join("export.json");
    let destination = temp.path().join("destination");
    drop(fixture_library(&source, &[("active", false)]));
    add_scaled_profiles(&source, "active", count, limit_bytes);

    // Successful creation implies a successful export the supported reader takes.
    let written = PortcoveService::new(Library::open(&source).unwrap())
        .unwrap()
        .write_library_metadata(&export)
        .unwrap();
    let (file, metadata) = crate::library_import::read_metadata(&export).unwrap();
    assert_eq!(
        (file.sha256.as_str(), file.size),
        (written.sha256.as_str(), written.size)
    );
    assert_eq!(metadata.profiles.len(), count);
    // The streamed bytes equal the earlier in-memory encoding, so older receipts
    // and reviewed plans keep verifying.
    assert_eq!(
        fs::read(&export).unwrap(),
        serde_json::to_vec_pretty(&metadata).unwrap()
    );

    // An interrupted import resumes to completion without restarting the copy.
    let plan = PortcoveService::plan_library_import(&export, &source, &destination).unwrap();
    start_import(&export, &source, &destination, &plan.plan_sha256, &|at| {
        if at == interrupt {
            Err(PortcoveError::state("synthetic interruption"))
        } else {
            Ok(())
        }
    })
    .unwrap_err();
    assert!(
        PortcoveService::resume_library_import(&destination)
            .unwrap()
            .completed
    );
    let restored = Library::open(&destination).unwrap();
    let connection = restored.connection().unwrap();
    assert_eq!(
        crate::profile::export(&connection).unwrap(),
        metadata.profiles
    );
    assert_eq!(
        crate::retained_build::references_from(&connection)
            .unwrap()
            .len(),
        count
    );

    // The imported library exports again and that export is importable too.
    let again = temp.path().join("again.json");
    let rewritten = PortcoveService::new(restored)
        .unwrap()
        .write_library_metadata(&again)
        .unwrap();
    PortcoveService::plan_library_import(&again, &destination, &temp.path().join("third")).unwrap();
    if limit_bytes > 0 {
        assert!(rewritten.size > OLD_METADATA_CEILING, "{}", rewritten.size);
    }
}

#[test]
fn a_library_export_past_the_old_profile_ceiling_round_trips_after_interruption() {
    // 1,024 profiles was the export ceiling; 1,025 crosses it.
    assert_scaled_library_round_trip(1_025, 0, TransferPhase::Copying);
}

#[test]
fn a_ten_thousand_profile_library_beyond_the_old_document_ceiling_round_trips() {
    // 10,000 profiles with about 2 KB each is a document well past 16 MiB.
    assert_scaled_library_round_trip(10_000, 2_000, TransferPhase::Verified);
}

#[test]
fn a_hostile_multi_million_record_document_is_refused_before_it_is_decoded() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    let export = temp.path().join("hostile.json");
    let destination = temp.path().join("destination");
    drop(fixture_library(&source, &[("active", false)]));
    // Three million records of the smallest shape: about 9 MB of JSON that
    // would decode into far more memory than the bytes suggest.
    let mut document = String::from(
        r#"{"schema_version":6,"exported_at":0,"original_root":"x","content_roots":[],"source_references":[],"application_versions":[],"port_settings":[],"launch_history":[],"profiles":["#,
    );
    document.push_str(&"{},".repeat(3_000_000));
    document.push_str("{}]}");
    fs::write(&export, &document).unwrap();
    let error = crate::library_metadata_document::with_admission_budget(1024 * 1024, || {
        PortcoveService::plan_library_import(&export, &source, &destination).unwrap_err()
    });
    assert_eq!(error.code, crate::ErrorCode::Unsupported, "{error:?}");
    assert_eq!(
        error.failure.mutation_state,
        crate::MutationState::NoChanges
    );
    assert_eq!(
        error.details["document_bytes"],
        document.len().to_string(),
        "{error:?}"
    );
    assert!(!destination.exists());
}

#[test]
fn an_export_this_machine_could_not_import_is_refused_before_publication() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    let export = temp.path().join("export.json");
    drop(fixture_library(&source, &[("active", false)]));
    add_scaled_profiles(&source, "active", 200, 2_000);
    let service = PortcoveService::new(Library::open(&source).unwrap()).unwrap();
    let error = crate::library_metadata_document::with_admission_budget(64 * 1024, || {
        service.write_library_metadata(&export).unwrap_err()
    });
    assert_eq!(error.code, crate::ErrorCode::Unsupported, "{error:?}");
    assert!(!export.exists());
    // The same library exports and imports under the real budget.
    service.write_library_metadata(&export).unwrap();
    PortcoveService::plan_library_import(&export, &source, &temp.path().join("destination"))
        .unwrap();
}

#[test]
fn transfer_capacity_reserves_the_actual_journal_size_beyond_the_old_flat_reserve() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    let export = temp.path().join("export.json");
    let metadata = fixture(&source, &export);
    // A synthetic inventory of 250,000 files with long relative paths encodes
    // to well over the 64 MiB the preflight used to reserve.
    let files = (0..250_000)
        .map(|index| crate::AdoptionCopyFile {
            relative_path: std::path::PathBuf::from(format!("{index:08}-{}", "p".repeat(200))),
            size: 1,
            sha256: "a".repeat(64),
        })
        .collect();
    let content = vec![crate::LibraryTreePlan {
        kind: crate::LibraryContentKind::UserData,
        relative_path: "user".into(),
        copy: crate::AdoptionCopyPlan {
            directories: Vec::new(),
            files,
            skipped_entries: Vec::new(),
            total_bytes: 250_000,
        },
    }];
    let journal = crate::library_metadata_document::encoded_size(&(&metadata, &content)).unwrap();
    assert!(journal > 64 * 1024 * 1024, "{journal}");
    let reserve =
        crate::library_metadata_document::transfer_reserve(&metadata, &content, 2).unwrap();
    assert_eq!(reserve, 2 * journal + 1024 * 1024);
}

#[test]
fn import_preflight_reserves_its_journal_and_refuses_before_any_copy() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    let export = temp.path().join("export.json");
    let destination = temp.path().join("destination");
    let metadata = fixture(&source, &export);
    let plan = PortcoveService::plan_library_import(&export, &source, &destination).unwrap();
    let content_bytes = plan
        .content
        .iter()
        .map(|tree| tree.copy.total_bytes)
        .sum::<u64>();
    let reserve =
        crate::library_metadata_document::transfer_reserve(&metadata, &plan.content, 2).unwrap();
    assert_eq!(
        plan.required_bytes,
        plan.metadata_file.size * 4 + reserve + content_bytes
    );
    assert!(reserve > 1024 * 1024);

    // One byte short of the requirement: refused at review, nothing written.
    let error = crate::path::with_available_space(plan.required_bytes - 1, || {
        PortcoveService::plan_library_import(&export, &source, &destination).unwrap_err()
    });
    assert!(
        error.message.contains("insufficient free space"),
        "{error:?}"
    );
    assert_eq!(
        error.details["required_bytes"],
        plan.required_bytes.to_string()
    );
    let error = crate::path::with_available_space(plan.required_bytes - 1, || {
        PortcoveService::import_library(&export, &source, &destination, &plan.plan_sha256)
            .unwrap_err()
    });
    assert!(
        error.message.contains("insufficient free space"),
        "{error:?}"
    );
    assert!(!destination.exists());
}

/// One setup at `packages` packages, saved `revisions` times: the history a
/// player accumulates by editing a large setup. Every revision is kept and
/// exported; none is pruned.
fn add_setup_with_history(root: &Path, install_id: &str, packages: usize, revisions: u64) {
    let library = Library::open(root).unwrap();
    let install = library
        .all_installs()
        .unwrap()
        .into_iter()
        .find(|install| install.id == install_id)
        .unwrap();
    let build = crate::install::retained_build_identity_for_install(&install).unwrap();
    let mut connection = library.connection().unwrap();
    let transaction = connection.transaction().unwrap();
    let mut profile = crate::profile::new_profile("starship", "Large setup", false);
    profile.current_revision = revisions;
    let save_group = uuid::Uuid::new_v4().to_string();
    let references = (1..=revisions)
        .map(|revision| crate::RetainedBuildReference {
            id: uuid::Uuid::new_v4().to_string(),
            setup_id: profile.id.clone(),
            revision,
            build: build.clone(),
            history: Vec::new(),
            created_at: 1,
            updated_at: 1,
        })
        .collect::<Vec<_>>();
    crate::retained_build::restore_references(&transaction, &references).unwrap();
    crate::profile::write_profile(&transaction, &profile).unwrap();
    for revision in 1..=revisions {
        let mut record = crate::ProfileRevision {
            profile_id: profile.id.clone(),
            revision,
            parent_revision: revision.checked_sub(1).filter(|parent| *parent > 0),
            build: build.clone(),
            originals: Vec::new(),
            loader: None,
            // Each save toggles one package, as an edit of a large setup does.
            packages: (0..packages)
                .map(|index| crate::ResolvedPackage {
                    native_id: format!("mod-{index:05}.o2r"),
                    native_version: Some("1.0.0".into()),
                    provider: None,
                    sha256: format!("{index:064x}"),
                    size: 1024,
                    enabled: index as u64 != revision,
                    requires: Vec::new(),
                    provider_requires: Vec::new(),
                })
                .collect(),
            recomp_companion_sets_v1: None,
            orderings: Vec::new(),
            settings: Default::default(),
            save_group: save_group.clone(),
            limits: Vec::new(),
            created_at: revision as i64,
            digest: String::new(),
        };
        crate::profile::seal(&mut record).unwrap();
        crate::profile::write_revision(&transaction, &record).unwrap();
    }
    transaction.commit().unwrap();
}

#[test]
fn accumulated_setup_history_is_refused_early_by_the_admission_budget_and_round_trips_when_it_fits()
{
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    let export = temp.path().join("export.json");
    let bundle = temp.path().join("bundle");
    drop(fixture_library(&source, &[("active", false)]));
    // 1,000 packages saved 12 times: past every former per-setup bound, within
    // the shared capacity and the stored revision budget.
    add_setup_with_history(&source, "active", 1_000, 12);
    let service = PortcoveService::new(Library::open(&source).unwrap()).unwrap();
    let document =
        crate::library_metadata_document::digest(&service.export_library_metadata().unwrap())
            .unwrap()
            .size;
    // The history alone is about 3 MiB of metadata.
    assert!(document > 2 * 1024 * 1024, "{document}");

    let refused_with_reason = |error: crate::PortcoveError| {
        assert_eq!(error.code, crate::ErrorCode::Unsupported, "{error:?}");
        assert_eq!(
            error.failure.mutation_state,
            crate::MutationState::NoChanges
        );
        assert_eq!(error.details["admission_basis"], "physical_memory_div_32");
        assert!(error.details.contains_key("document_bytes"), "{error:?}");
    };
    let tight = document / 2;

    // Too much history for the budget: every stage refuses before it changes
    // anything, naming the document size, the budget and its basis.
    crate::library_metadata_document::with_admission_budget(tight, || {
        refused_with_reason(service.write_library_metadata(&export).unwrap_err());
        assert!(!export.exists());
        refused_with_reason(service.plan_library_recovery_bundle(&bundle).unwrap_err());
        assert!(!bundle.exists());
    });

    // Within the budget the same history exports, imports completely and is
    // admitted for a recovery bundle.
    let fits = document + 1024 * 1024;
    let destination = temp.path().join("destination");
    let metadata = crate::library_metadata_document::with_admission_budget(fits, || {
        let written = service.write_library_metadata(&export).unwrap();
        assert_eq!(written.size, document);
        let plan = PortcoveService::plan_library_import(&export, &source, &destination).unwrap();
        start_import(&export, &source, &destination, &plan.plan_sha256, &|_| {
            Ok(())
        })
        .unwrap();
        service.plan_library_recovery_bundle(&bundle).unwrap();
        crate::library_import::read_metadata(&export).unwrap().1
    });
    let restored = Library::open(&destination).unwrap();
    let connection = restored.connection().unwrap();
    let profiles = crate::profile::export(&connection).unwrap();
    assert_eq!(profiles, metadata.profiles);
    let setup = profiles
        .iter()
        .find(|setup| setup.profile.display_name == "Large setup")
        .unwrap();
    assert_eq!(setup.revisions.len(), 12);
    assert!(
        setup
            .revisions
            .iter()
            .all(|revision| revision.packages.len() == 1_000)
    );

    // The export, read back on a machine with less memory, is refused before it is decoded.
    crate::library_metadata_document::with_admission_budget(tight, || {
        refused_with_reason(
            PortcoveService::plan_library_import(&export, &source, &temp.path().join("other"))
                .unwrap_err(),
        );
    });
    assert!(!temp.path().join("other").exists());
}
