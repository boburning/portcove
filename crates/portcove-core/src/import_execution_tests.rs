use super::*;
use crate::{ArtifactIdentity, BackupAction, InstallRecord, ReleaseChannel};

fn fixture(root: &Path, export: &Path) -> LibraryMetadata {
    let library = Library::open(root).unwrap();
    let catalog = Catalog::embedded().unwrap();
    let port = catalog.port("starship").unwrap();
    let platform = Platform::current().unwrap();
    let qualification = InstallQualification::from_port(port, platform).unwrap();
    for (id, staged) in [("old", false), ("active", false), ("staged", true)] {
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
        let (manifest_sha256, selected_executable, runtime) = Installer::new(library.clone())
            .unwrap()
            .create_manifest(id, "starship", id, &artifact, &qualification, &path)
            .unwrap();
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
            .unwrap();
    }
    for tree in ["user", "toolchains"] {
        fs::create_dir_all(root.join(tree).join("starship/empty")).unwrap();
        fs::write(root.join(tree).join("starship/data.bin"), tree).unwrap();
    }
    library.record_successful_launch("starship").unwrap();
    let service = PortcoveService::new(library).unwrap();
    service.create_backup("starship").unwrap();
    service.write_library_metadata(export).unwrap();
    service.export_library_metadata().unwrap()
}

#[test]
fn import_round_trip_preserves_versions_pointers_payloads_and_history_in_an_empty_library() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    let export = temp.path().join("export.json");
    let destination = temp.path().join("destination");
    let expected = fixture(&source, &export);
    let open = Library::open(&destination).unwrap();
    let plan = PortcoveService::plan_library_import(&export, &source, &destination).unwrap();
    assert!(plan.destination_exists);
    assert!(
        PortcoveService::import_library(&export, &source, &destination, &plan.plan_sha256).is_err()
    );
    drop(open);
    let result =
        PortcoveService::import_library(&export, &source, &destination, &plan.plan_sha256).unwrap();
    assert!(result.completed && result.input_retained);
    let restored = Library::open(&destination).unwrap();
    crate::transfer_copy::verify_metadata(&restored, &expected).unwrap();
    let status = restored.status("starship", ReleaseChannel::Stable).unwrap();
    assert_eq!(status.active.unwrap().id, "active");
    assert_eq!(status.previous.unwrap().id, "old");
    assert_eq!(status.staged.unwrap().id, "staged");
    assert_eq!(
        restored.activities(1).unwrap()[0].status,
        ActivityStatus::Succeeded
    );
    assert!(ImportJournal::read(&destination).unwrap().is_none());
    assert!(destination.join("recovery/library-import.json").is_file());
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
    assert!(
        PortcoveService::resume_library_import(&destination)
            .unwrap()
            .completed
    );
}

#[test]
fn interrupted_imports_recover_and_published_copies_never_replay_old_saves() {
    for phase in [
        TransferPhase::Copying,
        TransferPhase::Verified,
        TransferPhase::Published,
    ] {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        let export = temp.path().join("export.json");
        let destination = temp.path().join("destination");
        fixture(&source, &export);
        let plan = PortcoveService::plan_library_import(&export, &source, &destination).unwrap();
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
            assert!(PortcoveService::abort_library_import(&destination).is_err());
        } else {
            assert!(Library::open(&destination).is_err());
        }
        assert!(
            PortcoveService::resume_library_import(&destination)
                .unwrap()
                .completed
        );
        if phase == TransferPhase::Published {
            assert_eq!(
                fs::read(destination.join("user/starship/data.bin")).unwrap(),
                b"new save"
            );
        }
    }
}

#[test]
fn changed_import_input_or_destination_is_retained_and_never_published() {
    for change_input in [true, false] {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        let export = temp.path().join("export.json");
        let destination = temp.path().join("destination");
        fixture(&source, &export);
        let plan = PortcoveService::plan_library_import(&export, &source, &destination).unwrap();
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
        assert!(PortcoveService::resume_library_import(&destination).is_err());
        assert!(
            !PortcoveService::abort_library_import(&destination)
                .unwrap()
                .completed
        );
        assert!(
            !PortcoveService::abort_library_import(&destination)
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
}

#[test]
fn stale_plan_and_existing_data_are_rejected_before_creating_an_import() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    let export = temp.path().join("export.json");
    let destination = temp.path().join("destination");
    fixture(&source, &export);
    let plan = PortcoveService::plan_library_import(&export, &source, &destination).unwrap();
    fs::write(source.join("user/starship/data.bin"), b"changed").unwrap();
    assert!(
        PortcoveService::import_library(&export, &source, &destination, &plan.plan_sha256).is_err()
    );
    assert!(!destination.exists());
    fs::create_dir(&destination).unwrap();
    fs::write(destination.join("unrelated.txt"), b"retain").unwrap();
    assert!(PortcoveService::plan_library_import(&export, &source, &destination).is_err());
    assert!(!destination.join("locks").exists());
}

#[test]
fn interrupted_abort_cannot_be_resumed_as_a_successful_import() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    let export = temp.path().join("export.json");
    let destination = temp.path().join("destination");
    fixture(&source, &export);
    let plan = PortcoveService::plan_library_import(&export, &source, &destination).unwrap();
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
    assert!(PortcoveService::resume_library_import(&destination).is_err());
    assert!(Library::open(&destination).is_err());
    assert!(
        !PortcoveService::abort_library_import(&destination)
            .unwrap()
            .completed
    );
    assert_eq!(
        ImportJournal::read(&destination).unwrap().unwrap().phase,
        TransferPhase::Aborted
    );
}

#[test]
fn a_self_consistent_manifest_cannot_select_an_undeclared_executable_on_import() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    let export = temp.path().join("export.json");
    let destination = temp.path().join("destination");
    let mut metadata = fixture(&source, &export);
    let library = Library::open(&source).unwrap();
    let install = &mut metadata.application_versions[0];
    let path = source.join(&install.path);
    fs::write(path.join("undeclared.exe"), b"not a declared application").unwrap();
    let (hash, executable, runtime) = Installer::new(library)
        .unwrap()
        .create_manifest(
            &install.id,
            &install.port_id,
            &install.version,
            &install.artifact,
            &InstallQualification::test("undeclared.exe"),
            &path,
        )
        .unwrap();
    install.manifest_sha256 = hash;
    install.selected_executable = executable;
    install.runtime = runtime;
    fs::write(&export, serde_json::to_vec_pretty(&metadata).unwrap()).unwrap();
    let plan = PortcoveService::plan_library_import(&export, &source, &destination).unwrap();
    let error = PortcoveService::import_library(&export, &source, &destination, &plan.plan_sha256)
        .unwrap_err();
    assert!(error.message.contains("current platform"), "{error}");
    assert!(Library::open(&destination).is_err());
}
