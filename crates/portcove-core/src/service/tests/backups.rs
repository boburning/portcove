//! Complete backup lifecycle fixture family; production authority stays in its owner.
use super::*;

fn assert_restore_recovers_before_and_after_user_data_publication(point: LifecycleFaultPoint) {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let user_file = library.user_dir("zelda64-recomp").join("general.json");
    fs::create_dir_all(user_file.parent().unwrap()).unwrap();
    fs::write(&user_file, b"wanted").unwrap();
    let original = service_with_release(library.clone(), "v2");
    let backup = original.create_backup("zelda64-recomp").unwrap();
    let versions = stale_restore_versions(&library, &original);

    let service = service_with_fault(library.clone(), point);
    let authorization = backup_authorization(
        &service,
        "zelda64-recomp",
        &backup.id,
        BackupAction::Restore,
    );
    let error = service
        .restore_backup("zelda64-recomp", &backup.id, &authorization.token)
        .unwrap_err();
    assert!(error.message.contains("injected lifecycle failure"));
    assert_eq!(
        service
            .collect_user_data("zelda64-recomp")
            .unwrap_err()
            .code,
        crate::ErrorCode::Conflict
    );
    assert_eq!(
        service
            .launch_spec("zelda64-recomp", None)
            .unwrap_err()
            .code,
        crate::ErrorCode::Conflict
    );

    let recovered = service_with_release(library, "v2");
    assert_eq!(fs::read(&user_file).unwrap(), b"wanted");
    assert!(recovered.repair_plan().unwrap().items.is_empty());
    assert_restored_versions(&recovered, &versions);
}

#[test]
fn recovers_restore_prepared() {
    assert_restore_recovers_before_and_after_user_data_publication(
        LifecycleFaultPoint::RestorePrepared,
    );
}

#[test]
fn recovers_restore_published() {
    assert_restore_recovers_before_and_after_user_data_publication(
        LifecycleFaultPoint::RestorePublished,
    );
}

#[test]
fn recovers_restore_version_synchronized() {
    assert_restore_recovers_before_and_after_user_data_publication(
        LifecycleFaultPoint::RestoreVersionSynchronized,
    );
}

fn assert_half_published_restore(
    activate: bool,
    staged_exists: bool,
    user_exists: bool,
    previous_exists: bool,
) {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let service = service_with_release(library.clone(), "v2");
    let store = OperationStore::new(library.clone());
    let recovery_root = library.recovery_dir().join(format!(
        "restore-{activate}-{staged_exists}-{user_exists}-{previous_exists}"
    ));
    let staged = recovery_root.join("staged-data");
    let previous = recovery_root.join("previous-data");
    let user_root = library.user_dir("zelda64-recomp");
    if staged_exists {
        fs::create_dir_all(&staged).unwrap();
        fs::write(staged.join("general.json"), b"wanted").unwrap();
    }
    if user_exists {
        fs::create_dir_all(&user_root).unwrap();
        fs::write(user_root.join("general.json"), b"wanted").unwrap();
    }
    if previous_exists {
        fs::create_dir_all(&previous).unwrap();
        fs::write(previous.join("general.json"), b"previous").unwrap();
    }
    let mut operation = LifecycleOperation::new(
        recovery_root.file_name().unwrap().to_string_lossy(),
        LifecycleOperationKind::Restore,
        "zelda64-recomp",
    );
    operation.phase = LifecyclePhase::Prepared;
    operation.activate = activate;
    operation.paths.staging = Some(recovery_root.clone());
    operation.paths.final_path = Some(user_root.clone());
    operation.paths.quarantine = Some(previous);
    store.put(&mut operation).unwrap();

    crate::recovery::recover_restore(&service, &store, &mut operation).unwrap();

    assert_eq!(fs::read(user_root.join("general.json")).unwrap(), b"wanted");
    assert!(!recovery_root.exists());
    assert!(store.all().unwrap().is_empty());
}

#[test]
fn restore_recovery_replaces_previous_from_staging() {
    assert_half_published_restore(true, true, false, true);
}

fn assert_restore_recovery_preserves_foreign_paths(phase: LifecyclePhase) {
    let temporary = tempfile::tempdir().unwrap();
    let library = crate::test_fixture::phase("restore guard fixture: open library", || {
        Library::open(temporary.path().join("library")).unwrap()
    });
    let service = service_with_release(library.clone(), "v2");
    let store = OperationStore::new(library.clone());
    let outside = temporary.path().join("unrelated-saves");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("valuable.dat"), b"preserve").unwrap();
    for role in ["staging", "user", "previous"] {
        let mut operation = LifecycleOperation::new(
            Uuid::new_v4().to_string(),
            LifecycleOperationKind::Restore,
            "zelda64-recomp",
        );
        operation.phase = phase;
        let recovery = library.recovery_dir().join(&operation.id);
        operation.paths.staging = Some(recovery.clone());
        operation.paths.final_path = Some(library.user_dir("zelda64-recomp"));
        operation.paths.quarantine = Some(recovery.join("previous-data"));
        match role {
            "staging" => operation.paths.staging = Some(outside.clone()),
            "user" => operation.paths.final_path = Some(outside.clone()),
            "previous" => operation.paths.quarantine = Some(outside.clone()),
            _ => unreachable!(),
        }
        store.put(&mut operation).unwrap();

        service.recover_lifecycle_operations_for_test().unwrap();

        assert_eq!(fs::read(outside.join("valuable.dat")).unwrap(), b"preserve");
        let retained = store.get(&operation.id).unwrap().unwrap();
        assert_eq!(retained.phase, phase);
        assert!(retained.last_error.unwrap().contains("paths do not match"));
        assert!(!recovery.exists());
        store.remove(&operation.id).unwrap();
    }
    for identity in [
        "",
        ".",
        "..",
        "../other",
        "nested/id",
        "id.",
        "CON",
        "id:stream",
        "restore-safe",
    ] {
        let mut operation =
            LifecycleOperation::new(identity, LifecycleOperationKind::Restore, "zelda64-recomp");
        let recovery = library.recovery_dir().join(identity);
        operation.paths.staging = Some(recovery.clone());
        operation.paths.final_path = Some(library.user_dir("zelda64-recomp"));
        operation.paths.quarantine = Some(recovery.join("previous-data"));
        assert_eq!(
            service.validate_restore_operation(&operation).is_ok(),
            identity == "restore-safe",
            "{identity}"
        );
        assert_eq!(fs::read(outside.join("valuable.dat")).unwrap(), b"preserve");
    }
}

#[test]
fn restore_recovery_preserves_foreign_paths_when_prepared() {
    assert_restore_recovery_preserves_foreign_paths(LifecyclePhase::Prepared);
}

#[test]
fn restore_recovery_preserves_foreign_paths_after_publication() {
    assert_restore_recovery_preserves_foreign_paths(LifecyclePhase::PayloadPublished);
}

#[test]
fn restore_recovery_preserves_foreign_paths_after_metadata_commit() {
    assert_restore_recovery_preserves_foreign_paths(LifecyclePhase::MetadataCommitted);
}

#[test]
fn restore_recovery_preserves_foreign_paths_during_cleanup() {
    assert_restore_recovery_preserves_foreign_paths(LifecyclePhase::CleanupPending);
}

#[test]
fn restore_recovery_preserves_persisted_incompatible_family_payloads() {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let service = service_with_release(library.clone(), "v2");
    let store = OperationStore::new(library.clone());
    let user = library.user_dir("zelda64-recomp");
    fs::create_dir_all(&user).unwrap();
    fs::write(user.join("save.dat"), b"current saves").unwrap();
    let original = temporary.path().join("original-source.dat");
    fs::write(&original, b"preserved original").unwrap();

    for (name, quiesced, original_paths) in [
        ("original-paths", None, vec![original.clone()]),
        ("preparation-running", Some(false), Vec::new()),
        ("preparation-quiesced", Some(true), Vec::new()),
    ] {
        let mut intent = LifecycleOperation::new(
            format!("restore-{name}"),
            LifecycleOperationKind::Restore,
            "zelda64-recomp",
        );
        intent.phase = LifecyclePhase::MetadataCommitted;
        intent.last_error = Some("retained failure evidence".into());
        let recovery = library.recovery_dir().join(&intent.id);
        let previous = recovery.join("previous-data");
        fs::create_dir_all(&previous).unwrap();
        fs::write(previous.join("save.dat"), b"previous saves").unwrap();
        intent.paths.staging = Some(recovery.clone());
        intent.paths.final_path = Some(user.clone());
        intent.paths.quarantine = Some(previous.clone());
        intent.preparation_process_quiesced = quiesced;
        intent.original_paths = original_paths;
        store.put(&mut intent).unwrap();

        // Exercise the persisted compatibility envelope, not only an in-memory guard.
        let mut decoded = store.get(&intent.id).unwrap().unwrap();
        let error = crate::recovery::recover_restore(&service, &store, &mut decoded).unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::State, "{name}");
        assert!(
            error
                .message
                .contains("incompatible identity or family payload")
        );
        let retained = store.get(&intent.id).unwrap().unwrap();
        assert_eq!(retained.phase, LifecyclePhase::MetadataCommitted);
        assert_eq!(retained.last_error, intent.last_error);
        assert_eq!(retained.preparation_process_quiesced, quiesced);
        assert_eq!(retained.original_paths, intent.original_paths);
        assert_eq!(retained.updated_at, intent.updated_at);
        assert_eq!(
            fs::read(previous.join("save.dat")).unwrap(),
            b"previous saves"
        );
        assert_eq!(fs::read(user.join("save.dat")).unwrap(), b"current saves");
        assert_eq!(fs::read(&original).unwrap(), b"preserved original");

        // The identical paths and phase are recoverable with ordinary legacy defaults.
        decoded.preparation_process_quiesced = None;
        decoded.original_paths.clear();
        store.put(&mut decoded).unwrap();
        let mut valid = store.get(&intent.id).unwrap().unwrap();
        crate::recovery::recover_restore(&service, &store, &mut valid).unwrap();
        assert!(store.get(&intent.id).unwrap().is_none());
        assert!(!recovery.exists());
        assert_eq!(fs::read(user.join("save.dat")).unwrap(), b"current saves");
        assert_eq!(fs::read(&original).unwrap(), b"preserved original");
    }
}
#[cfg(unix)]
#[test]
fn restore_preparing_failure_preserves_a_replaced_recovery_root() {
    struct ReplaceRecoveryDuringSafetyBackup {
        library: Library,
        outside: PathBuf,
    }
    impl LifecycleFaultInjector for ReplaceRecoveryDuringSafetyBackup {
        fn check(&self, point: LifecycleFaultPoint) -> Result<()> {
            if point == LifecycleFaultPoint::BackupDataCopied {
                let operation = OperationStore::new(self.library.clone())
                    .all()?
                    .into_iter()
                    .find(|operation| operation.kind == LifecycleOperationKind::Restore)
                    .expect("restore intent precedes its safety backup");
                assert_eq!(operation.phase, LifecyclePhase::Preparing);
                let recovery = operation.paths.staging.unwrap();
                assert!(recovery.join("staged-data/general.json").is_file());
                fs::rename(
                    &recovery,
                    recovery.with_file_name(format!("retained-{}", operation.id)),
                )?;
                std::os::unix::fs::symlink(&self.outside, &recovery)?;
                return Err(PortcoveError::state(
                    "injected failure after recovery root replacement",
                ));
            }
            Ok(())
        }
    }
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let user = library.user_dir("zelda64-recomp");
    fs::create_dir_all(&user).unwrap();
    fs::write(user.join("general.json"), b"wanted").unwrap();
    let original = service_with_release(library.clone(), "v2");
    let backup = original.create_backup("zelda64-recomp").unwrap();
    fs::write(user.join("general.json"), b"live").unwrap();
    let outside = temporary.path().join("unrelated-saves");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("valuable.dat"), b"preserve").unwrap();
    let service = PortcoveService::with_provider_and_faults(
        library.clone(),
        Arc::new(StaticReleaseProvider {
            version: "v2".into(),
        }),
        Arc::new(ReplaceRecoveryDuringSafetyBackup {
            library: library.clone(),
            outside: outside.clone(),
        }),
    )
    .unwrap();
    let authorization = backup_authorization(
        &service,
        "zelda64-recomp",
        &backup.id,
        BackupAction::Restore,
    );

    let error = service
        .restore_backup("zelda64-recomp", &backup.id, &authorization.token)
        .unwrap_err();

    assert!(
        error
            .message
            .contains("injected failure after recovery root replacement")
    );
    assert_eq!(fs::read(outside.join("valuable.dat")).unwrap(), b"preserve");
    assert_eq!(fs::read(user.join("general.json")).unwrap(), b"live");
    let retained = OperationStore::new(library).all().unwrap().remove(0);
    assert_eq!(retained.phase, LifecyclePhase::Preparing);
    assert_eq!(retained.last_error.as_deref(), Some(error.message.as_str()));
    let recovery = retained.paths.staging.unwrap();
    assert!(
        fs::symlink_metadata(&recovery)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert_eq!(
        fs::read(
            recovery
                .with_file_name(format!("retained-{}", retained.id))
                .join("staged-data/general.json")
        )
        .unwrap(),
        b"wanted"
    );
}

#[cfg(unix)]
#[test]
fn restore_refuses_linked_paths_without_cleanup_or_publication() {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let service = service_with_release(library.clone(), "v2");
    let store = OperationStore::new(library.clone());
    let outside = temporary.path().join("unrelated-saves");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("valuable.dat"), b"preserve").unwrap();
    let user = library.user_dir("zelda64-recomp");
    std::os::unix::fs::symlink(&outside, &user).unwrap();

    let error = service
        .restore_backup("zelda64-recomp", "unused", "unauthorized")
        .unwrap_err();

    assert!(error.message.contains("symlink"));
    assert_eq!(fs::read(outside.join("valuable.dat")).unwrap(), b"preserve");
    assert!(store.all().unwrap().is_empty());
    fs::remove_file(&user).unwrap();
    for linked_staging in [false, true] {
        let mut operation = LifecycleOperation::new(
            Uuid::new_v4().to_string(),
            LifecycleOperationKind::Restore,
            "zelda64-recomp",
        );
        operation.phase = LifecyclePhase::MetadataCommitted;
        let recovery = library.recovery_dir().join(&operation.id);
        let link = if linked_staging {
            fs::create_dir(&recovery).unwrap();
            recovery.join("staged-data")
        } else {
            recovery.clone()
        };
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        operation.paths.staging = Some(recovery.clone());
        operation.paths.final_path = Some(user.clone());
        operation.paths.quarantine = Some(recovery.join("previous-data"));
        store.put(&mut operation).unwrap();

        service.recover_lifecycle_operations_for_test().unwrap();

        assert_eq!(fs::read(outside.join("valuable.dat")).unwrap(), b"preserve");
        assert!(
            store
                .get(&operation.id)
                .unwrap()
                .unwrap()
                .last_error
                .unwrap()
                .contains("symlink")
        );
        assert!(
            fs::symlink_metadata(&link)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        store.remove(&operation.id).unwrap();
        fs::remove_file(link).unwrap();
    }
}
#[test]
fn restore_recovery_finishes_published_replacement() {
    assert_half_published_restore(true, false, true, true);
}

#[test]
fn restore_recovery_publishes_initial_staging() {
    assert_half_published_restore(false, true, false, false);
}

#[test]
fn restore_recovery_finishes_initial_publication() {
    assert_half_published_restore(false, false, true, false);
}

#[test]
fn backup_creates_an_independent_snapshot_and_lists_it() {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let user_root = library.user_dir("zelda64-recomp");
    fs::create_dir_all(user_root.join("saves")).unwrap();
    fs::write(user_root.join("saves/save.dat"), b"original").unwrap();
    fs::write(user_root.join("settings.json"), b"{}").unwrap();
    let service = service_with_release(library.clone(), "v1");

    let backup = service.create_backup("zelda64-recomp").unwrap();
    assert_eq!(backup.port_id, "zelda64-recomp");
    assert_eq!(backup.file_count, 2);
    assert_eq!(backup.size, 10);
    assert_eq!(
        fs::read(backup.path.join("data/saves/save.dat")).unwrap(),
        b"original"
    );
    assert!(backup.path.join("backup.json").is_file());

    fs::write(user_root.join("saves/save.dat"), b"changed").unwrap();
    assert_eq!(
        fs::read(backup.path.join("data/saves/save.dat")).unwrap(),
        b"original"
    );
    assert_eq!(
        service.list_backups("zelda64-recomp").unwrap().backups,
        [backup]
    );
    let activity = &library.activities(1).unwrap()[0];
    assert_eq!(activity.operation, ActivityOperation::Backup);
    assert_eq!(activity.status, ActivityStatus::Succeeded);
}

struct ExitBackupAt(LifecycleFaultPoint);

impl LifecycleFaultInjector for ExitBackupAt {
    fn check(&self, point: LifecycleFaultPoint) -> Result<()> {
        if point == self.0 {
            // Deliberately bypass TempDir and lock destructors to model an
            // abrupt process stop at this exact publication boundary.
            std::process::exit(77);
        }
        Ok(())
    }
}

#[test]
fn backup_interruption_child() {
    let Some(root) = std::env::var_os("PORTCOVE_BACKUP_INTERRUPTION_ROOT") else {
        return;
    };
    let point = match std::env::var("PORTCOVE_BACKUP_INTERRUPTION_POINT").as_deref() {
        Ok("created") => LifecycleFaultPoint::BackupStagingCreated,
        Ok("copied") => LifecycleFaultPoint::BackupDataCopied,
        Ok("manifest") => LifecycleFaultPoint::BackupManifestSynced,
        Ok("kept") => LifecycleFaultPoint::BackupStagingKept,
        Ok("published") => LifecycleFaultPoint::BackupPublished,
        other => panic!("unexpected backup interruption point: {other:?}"),
    };
    let library = Library::open(PathBuf::from(root)).unwrap();
    let service = PortcoveService::with_provider_and_faults(
        library,
        Arc::new(StaticReleaseProvider {
            version: "v1".into(),
        }),
        Arc::new(ExitBackupAt(point)),
    )
    .unwrap();
    let _ = service.create_backup("zelda64-recomp");
    panic!("backup did not stop at {point:?}");
}

#[test]
fn interrupted_backup_stages_are_visible_without_hiding_verified_backups() {
    for (name, has_data, has_manifest) in [
        ("created", false, false),
        ("copied", true, false),
        ("manifest", true, true),
        ("kept", true, true),
        ("published", false, false),
    ] {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("library");
        let library = Library::open(&root).unwrap();
        let service = service_with_release(library.clone(), "v1");
        let port_id = "zelda64-recomp";
        let user_root = library.user_dir(port_id);
        fs::create_dir_all(&user_root).unwrap();
        fs::write(user_root.join("save.dat"), b"original").unwrap();
        let published = service.create_backup(port_id).unwrap();
        fs::write(user_root.join("save.dat"), b"later save").unwrap();

        let output = ChildProcessPolicy::native_command(
            ChildProcessClass::HostTool,
            std::env::current_exe().unwrap(),
        )
        .unwrap()
        .args([
            "backup_interruption_child",
            "--nocapture",
            "--test-threads=1",
        ])
        .env("PORTCOVE_BACKUP_INTERRUPTION_ROOT", &root)
        .env("PORTCOVE_BACKUP_INTERRUPTION_POINT", name)
        .output()
        .unwrap();
        assert_eq!(output.status.code(), Some(77), "{name}: {output:?}");

        let parent = library.backups_dir().join(port_id);
        let stages = fs::read_dir(&parent)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| {
                path.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with(".backup-")
            })
            .collect::<Vec<_>>();
        assert_eq!(stages.len(), usize::from(name != "published"), "{name}");
        if let Some(stage) = stages.first() {
            assert_eq!(stage.join("data/save.dat").is_file(), has_data, "{name}");
            assert_eq!(stage.join("backup.json").is_file(), has_manifest, "{name}");
            assert_eq!(
                stage.join("preparation.json").is_file(),
                name != "kept",
                "{name}"
            );
        }
        let inventory = service.list_backups(port_id).unwrap();
        assert!(inventory.backups.contains(&published), "{name}");
        if name == "published" {
            assert_eq!(inventory.backups.len(), 2);
            let new_backup = inventory
                .backups
                .iter()
                .find(|backup| backup.id != published.id)
                .unwrap();
            assert_eq!(
                fs::read(new_backup.path.join("data/save.dat")).unwrap(),
                b"later save"
            );
            assert!(!new_backup.path.join("preparation.json").exists());
        } else {
            assert_eq!(
                inventory.backups.as_slice(),
                std::slice::from_ref(&published)
            );
        }
        assert_eq!(
            inventory
                .problems
                .iter()
                .filter(|problem| problem.path.starts_with(&parent))
                .count(),
            usize::from(name != "published"),
            "{name}: {:?}",
            inventory.problems
        );
        if name != "published" {
            assert_eq!(inventory.state, BackupInventoryState::RecoveryRequired);
            assert_eq!(inventory.problems[0].path, stages[0]);
            assert!(
                inventory.problems[0]
                    .message
                    .contains("unpublished backup preparation")
            );
            assert!(
                service
                    .repair_plan()
                    .unwrap()
                    .items
                    .iter()
                    .any(|item| { item.path.as_ref() == Some(&stages[0]) })
            );
            if name == "kept" {
                fs::write(stages[0].join("preparation.json"), b"mismatched marker").unwrap();
                let ambiguous = service.list_backups(port_id).unwrap();
                assert!(
                    ambiguous.problems[0]
                        .message
                        .contains("no consistent Portcove preparation identity")
                );
                assert!(stages[0].join("backup.json").is_file());
            }
        }
        assert_eq!(fs::read(user_root.join("save.dat")).unwrap(), b"later save");
        assert_eq!(
            fs::read(published.path.join("data/save.dat")).unwrap(),
            b"original"
        );
    }
}

#[test]
fn concurrent_backup_stage_is_not_called_abandoned_until_its_owner_releases_the_port() {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let service = service_with_release(library.clone(), "v1");
    let port_id = "zelda64-recomp";
    fs::create_dir_all(library.user_dir(port_id)).unwrap();
    fs::write(library.user_dir(port_id).join("save.dat"), b"original").unwrap();
    let published = service.create_backup(port_id).unwrap();
    let stage = library.backups_dir().join(port_id).join(".backup-live");
    fs::create_dir(&stage).unwrap();
    fs::write(stage.join("partial"), b"still being copied").unwrap();

    let owner = library.try_lock_port(port_id, "backup").unwrap();
    let inventory = service.list_backups(port_id).unwrap();
    assert_eq!(
        inventory.backups.as_slice(),
        std::slice::from_ref(&published)
    );
    assert!(inventory.problems.is_empty());
    assert!(
        !service
            .repair_plan()
            .unwrap()
            .items
            .iter()
            .any(|item| { item.path.as_ref() == Some(&stage) })
    );
    drop(owner);

    let inventory = service.list_backups(port_id).unwrap();
    assert_eq!(inventory.backups, [published]);
    assert_eq!(inventory.state, BackupInventoryState::RecoveryRequired);
    assert_eq!(inventory.problems.len(), 1);
    assert_eq!(inventory.problems[0].path, stage);
    assert!(
        inventory.problems[0]
            .message
            .contains("no consistent Portcove preparation identity")
    );
    assert!(stage.join("partial").is_file());
}

struct CollideBackupDestination(PathBuf);

impl LifecycleFaultInjector for CollideBackupDestination {
    fn check(&self, point: LifecycleFaultPoint) -> Result<()> {
        if point == LifecycleFaultPoint::BackupManifestSynced {
            let stage = fs::read_dir(&self.0)?
                .map(|entry| entry.map(|entry| entry.path()))
                .collect::<std::io::Result<Vec<_>>>()?
                .into_iter()
                .find(|path| {
                    path.file_name()
                        .unwrap()
                        .to_string_lossy()
                        .starts_with(".backup-")
                })
                .unwrap();
            let manifest: serde_json::Value =
                serde_json::from_slice(&fs::read(stage.join("backup.json"))?)?;
            let destination = self.0.join(manifest["id"].as_str().unwrap());
            fs::create_dir(&destination)?;
            fs::write(destination.join("existing"), b"keep me")?;
        }
        Ok(())
    }
}

#[test]
fn backup_publication_collision_preserves_the_existing_destination_and_saves() {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let port_id = "zelda64-recomp";
    let parent = library.backups_dir().join(port_id);
    fs::create_dir_all(library.user_dir(port_id)).unwrap();
    fs::write(library.user_dir(port_id).join("save.dat"), b"save").unwrap();
    let service = PortcoveService::with_provider_and_faults(
        library.clone(),
        Arc::new(StaticReleaseProvider {
            version: "v1".into(),
        }),
        Arc::new(CollideBackupDestination(parent.clone())),
    )
    .unwrap();

    let error = service.create_backup(port_id).unwrap_err();
    assert_eq!(error.code, crate::ErrorCode::Conflict);
    let entries = fs::read_dir(&parent)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect::<Vec<_>>();
    assert_eq!(entries.len(), 1);
    assert_eq!(fs::read(entries[0].join("existing")).unwrap(), b"keep me");
    assert_eq!(
        fs::read(library.user_dir(port_id).join("save.dat")).unwrap(),
        b"save"
    );
    assert!(service.list_backups(port_id).unwrap().backups.is_empty());
}

#[test]
fn reused_backup_snapshot_matches_fresh_inventory_across_diagnostic_states() {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let service = service_with_release(library.clone(), "v1");
    let port_id = "zelda64-recomp";
    let store = OperationStore::new(library.clone());

    let operations = store.all().unwrap();
    assert_eq!(
        service
            .list_backups_with_operations(port_id, &operations)
            .unwrap(),
        service.list_backups(port_id).unwrap()
    );

    let user_root = library.user_dir(port_id);
    fs::create_dir_all(&user_root).unwrap();
    fs::write(user_root.join("save.dat"), b"healthy").unwrap();
    let healthy = service.create_backup(port_id).unwrap();
    let operations = store.all().unwrap();
    assert_eq!(
        service
            .list_backups_with_operations(port_id, &operations)
            .unwrap(),
        service.list_backups(port_id).unwrap()
    );

    let malformed = Uuid::new_v4().to_string();
    let malformed_root = library.backups_dir().join(port_id).join(&malformed);
    fs::create_dir(&malformed_root).unwrap();
    fs::write(malformed_root.join("backup.json"), b"{").unwrap();
    let operations = store.all().unwrap();
    let degraded = service
        .list_backups_with_operations(port_id, &operations)
        .unwrap();
    assert_eq!(degraded, service.list_backups(port_id).unwrap());
    assert_eq!(degraded.state, BackupInventoryState::Degraded);
    assert_eq!(
        degraded.problems[0].kind,
        BackupProblemKind::MalformedManifest
    );

    let mut pending = LifecycleOperation::new(
        "pending-backup-deletion",
        LifecycleOperationKind::DeleteBackup,
        port_id,
    );
    pending.phase = LifecyclePhase::Prepared;
    pending.paths.final_path = Some(healthy.path.clone());
    pending.paths.quarantine = Some(
        library
            .backups_dir()
            .join(port_id)
            .join(".deleting-pending-backup-deletion"),
    );
    store.put(&mut pending).unwrap();
    let operations = store.all().unwrap();
    let recovery_required = service
        .list_backups_with_operations(port_id, &operations)
        .unwrap();
    assert_eq!(recovery_required, service.list_backups(port_id).unwrap());
    assert_eq!(
        recovery_required.state,
        BackupInventoryState::RecoveryRequired
    );
    assert!(recovery_required.problems.iter().any(|problem| {
        problem.kind == BackupProblemKind::RecoveryRequired
            && problem.operation_id.as_deref() == Some("pending-backup-deletion")
    }));
}

#[test]
fn backup_rejects_empty_persistent_data_and_records_failure() {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    fs::create_dir_all(library.user_dir("zelda64-recomp")).unwrap();
    let service = service_with_release(library.clone(), "v1");

    let error = service.create_backup("zelda64-recomp").unwrap_err();
    assert_eq!(error.code, crate::ErrorCode::NotFound);
    assert!(
        service
            .list_backups("zelda64-recomp")
            .unwrap()
            .backups
            .is_empty()
    );
    let activity = &library.activities(1).unwrap()[0];
    assert_eq!(activity.operation, ActivityOperation::Backup);
    assert_eq!(activity.status, ActivityStatus::Failed);
}

#[test]
fn restore_replaces_user_data_and_preserves_an_automatic_safety_backup() {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let user_root = library.user_dir("zelda64-recomp");
    fs::create_dir_all(&user_root).unwrap();
    fs::write(user_root.join("save.dat"), b"wanted").unwrap();
    let service = service_with_release(library.clone(), "v1");
    let wanted = service.create_backup("zelda64-recomp").unwrap();
    fs::write(user_root.join("save.dat"), b"current").unwrap();
    fs::write(user_root.join("new.cfg"), b"setting").unwrap();

    let restored = restore_authorized(&service, "zelda64-recomp", &wanted.id).unwrap();

    assert_eq!(restored.restored_backup, wanted);
    let safety = restored
        .safety_backup
        .expect("current data needs a safety backup");
    assert_eq!(
        fs::read(safety.path.join("data/save.dat")).unwrap(),
        b"current"
    );
    assert_eq!(fs::read(user_root.join("save.dat")).unwrap(), b"wanted");
    assert!(!user_root.join("new.cfg").exists());
    let listed = service.list_backups("zelda64-recomp").unwrap();
    assert_eq!(listed.backups.len(), 2);
    assert_eq!(listed.backups[0], safety);
    let activity = &library.activities(1).unwrap()[0];
    assert_eq!(activity.operation, ActivityOperation::Restore);
    assert_eq!(activity.status, ActivityStatus::Succeeded);
}

fn stale_restore_versions(library: &Library, service: &PortcoveService) -> Vec<PathBuf> {
    let versions = vec![
        register_zelda_install(library, "v1", true),
        register_zelda_install(library, "v2", true),
        register_zelda_install(library, "v3", false),
    ];
    for path in &versions {
        fs::write(path.join("general.json"), b"changed").unwrap();
        fs::create_dir_all(path.join("mods")).unwrap();
        fs::write(path.join("mods/after-backup.rtz"), b"new mod").unwrap();
        fs::write(path.join(LAUNCH_MARKER), b"1").unwrap();
    }
    service.collect_user_data("zelda64-recomp").unwrap();
    versions
}

fn assert_restored_versions(service: &PortcoveService, versions: &[PathBuf]) {
    for path in versions {
        assert_eq!(fs::read(path.join("general.json")).unwrap(), b"wanted");
        assert!(!path.join("mods").exists());
        assert!(!path.join(LAUNCH_MARKER).exists());
    }
    service.launch_spec("zelda64-recomp", None).unwrap();
    service.rollback("zelda64-recomp").unwrap();
    service.launch_spec("zelda64-recomp", None).unwrap();
    service.activate_staged("zelda64-recomp").unwrap();
    service.launch_spec("zelda64-recomp", None).unwrap();
    service.collect_user_data("zelda64-recomp").unwrap();
    let user_root = service.library.user_dir("zelda64-recomp");
    assert_eq!(fs::read(user_root.join("general.json")).unwrap(), b"wanted");
    assert!(!user_root.join("mods").exists());
}

#[test]
fn restore_remains_authoritative_after_launch_rollback_and_staged_activation() {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let user_root = library.user_dir("zelda64-recomp");
    fs::create_dir_all(&user_root).unwrap();
    fs::write(user_root.join("general.json"), b"wanted").unwrap();
    let service = service_with_release(library.clone(), "v2");
    let backup = service.create_backup("zelda64-recomp").unwrap();
    let versions = stale_restore_versions(&library, &service);

    let result = restore_authorized(&service, "zelda64-recomp", &backup.id).unwrap();

    let safety = result.safety_backup.unwrap();
    assert_eq!(
        fs::read(safety.path.join("data/general.json")).unwrap(),
        b"changed"
    );
    assert_eq!(
        fs::read(safety.path.join("data/mods/after-backup.rtz")).unwrap(),
        b"new mod"
    );
    assert_restored_versions(&service, &versions);
}

#[test]
fn current_persistence_cannot_restore_an_unmanifested_companion_into_lifecycle_paths() {
    const PORT: &str = "zelda64-recomp";
    const COMPANION: &str = "late.dll";

    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("launch-library")).unwrap();
    let active = register_zelda_install(&library, "v1", true);
    let user_companion = library.user_dir(PORT).join(COMPANION);
    fs::create_dir_all(user_companion.parent().unwrap()).unwrap();
    fs::write(&user_companion, b"untrusted companion").unwrap();
    let service = service_with_added_persistent_path(library.clone(), "v2", COMPANION);

    service.launch_spec(PORT, None).unwrap();
    assert!(!active.join(COMPANION).exists());
    assert_eq!(service.status(PORT).unwrap().active.unwrap().version, "v1");

    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("activate-library")).unwrap();
    register_zelda_install(&library, "v1", true);
    let staged = register_zelda_install(&library, "v2", false);
    let user_companion = library.user_dir(PORT).join(COMPANION);
    fs::create_dir_all(user_companion.parent().unwrap()).unwrap();
    fs::write(&user_companion, b"untrusted companion").unwrap();
    let service = service_with_added_persistent_path(library, "v2", COMPANION);

    service.activate_staged(PORT).unwrap();
    assert!(!staged.join(COMPANION).exists());
    let status = service.status(PORT).unwrap();
    assert_eq!(status.active.unwrap().version, "v2");
    assert!(status.staged.is_none());

    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("rollback-library")).unwrap();
    let previous = register_zelda_install(&library, "v1", true);
    register_zelda_install(&library, "v2", true);
    let user_companion = library.user_dir(PORT).join(COMPANION);
    fs::create_dir_all(user_companion.parent().unwrap()).unwrap();
    fs::write(&user_companion, b"untrusted companion").unwrap();
    let service = service_with_added_persistent_path(library, "v2", COMPANION);

    service.rollback(PORT).unwrap();
    assert!(!previous.join(COMPANION).exists());
    assert_eq!(service.status(PORT).unwrap().active.unwrap().version, "v1");

    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("recovery-library")).unwrap();
    register_zelda_install(&library, "v1", true);
    let staged = register_zelda_install(&library, "v2", false);
    let user_companion = library.user_dir(PORT).join(COMPANION);
    fs::create_dir_all(user_companion.parent().unwrap()).unwrap();
    fs::write(&user_companion, b"untrusted companion").unwrap();
    let service = service_with_added_persistent_path(library.clone(), "v2", COMPANION);
    let store = OperationStore::new(library);
    let mut operation = LifecycleOperation::new(
        "recover-current-persistence",
        LifecycleOperationKind::Activate,
        PORT,
    );
    operation.install = Some(service.status(PORT).unwrap().staged.unwrap());
    store.put(&mut operation).unwrap();

    service.recover_activation(&store, &mut operation).unwrap();
    assert!(!staged.join(COMPANION).exists());
    assert!(user_companion.is_file());
    assert_eq!(service.status(PORT).unwrap().active.unwrap().version, "v2");
    assert!(service.repair_plan().unwrap().items.is_empty());
}

#[cfg(unix)]
#[test]
fn restore_preserves_its_journal_when_a_retained_save_path_is_a_symlink() {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let user_root = library.user_dir("zelda64-recomp");
    fs::create_dir_all(&user_root).unwrap();
    fs::write(user_root.join("general.json"), b"wanted").unwrap();
    let service = service_with_release(library.clone(), "v2");
    let backup = service.create_backup("zelda64-recomp").unwrap();
    let versions = stale_restore_versions(&library, &service);
    let outside = temporary.path().join("outside.json");
    fs::write(&outside, b"untouched").unwrap();
    let linked = versions[0].join("general.json");
    fs::remove_file(&linked).unwrap();
    std::os::unix::fs::symlink(&outside, &linked).unwrap();

    let error = restore_authorized(&service, "zelda64-recomp", &backup.id).unwrap_err();

    assert_eq!(error.code, crate::ErrorCode::Conflict);
    assert_eq!(fs::read(&outside).unwrap(), b"untouched");
    assert_eq!(
        service
            .collect_user_data("zelda64-recomp")
            .unwrap_err()
            .code,
        crate::ErrorCode::Conflict
    );
    assert!(!service.repair_plan().unwrap().items.is_empty());
    fs::remove_file(linked).unwrap();
    let recovered = service_with_release(library, "v2");
    assert!(recovered.repair_plan().unwrap().items.is_empty());
    assert_restored_versions(&recovered, &versions);
}

#[test]
fn restore_authorization_rejects_live_data_changes_after_review() {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let user_root = library.user_dir("zelda64-recomp");
    fs::create_dir_all(&user_root).unwrap();
    fs::write(user_root.join("save.dat"), b"backup contents").unwrap();
    let service = service_with_release(library, "v1");
    let backup = service.create_backup("zelda64-recomp").unwrap();
    fs::write(user_root.join("save.dat"), b"reviewed live data").unwrap();
    let preview = service
        .preview_backup_action("zelda64-recomp", &backup.id, BackupAction::Restore)
        .unwrap();
    fs::write(user_root.join("save.dat"), b"new live data").unwrap();
    reset_adoption_copy_plan_passes();
    let authorization = service
        .authorize_backup_action(
            "zelda64-recomp",
            &backup.id,
            BackupAction::Restore,
            &preview.preview_sha256,
        )
        .unwrap();
    assert!(reset_adoption_copy_plan_passes().is_empty());

    let error = service
        .restore_backup("zelda64-recomp", &backup.id, &authorization.token)
        .unwrap_err();

    assert_eq!(error.code, crate::ErrorCode::Conflict);
    assert!(error.message.contains("state changed"));
    assert_eq!(
        fs::read(user_root.join("save.dat")).unwrap(),
        b"new live data"
    );
}

#[test]
fn restore_rejects_tampered_backup_before_snapshot_or_live_data_changes() {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let user_root = library.user_dir("zelda64-recomp");
    fs::create_dir_all(&user_root).unwrap();
    fs::write(user_root.join("save.dat"), b"backup").unwrap();
    let service = service_with_release(library.clone(), "v1");
    let backup = service.create_backup("zelda64-recomp").unwrap();
    fs::write(backup.path.join("data/save.dat"), b"damage").unwrap();
    fs::write(user_root.join("save.dat"), b"live").unwrap();

    let error = restore_authorized(&service, "zelda64-recomp", &backup.id).unwrap_err();

    assert_eq!(error.code, crate::ErrorCode::Verification);
    assert_eq!(fs::read(user_root.join("save.dat")).unwrap(), b"live");
    assert_eq!(
        service
            .list_backups("zelda64-recomp")
            .unwrap()
            .backups
            .len(),
        1
    );
    assert_eq!(
        library.activities(1).unwrap()[0].status,
        ActivityStatus::Failed
    );
}

#[test]
fn restore_into_an_empty_root_needs_no_safety_backup() {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let user_root = library.user_dir("zelda64-recomp");
    fs::create_dir_all(&user_root).unwrap();
    fs::write(user_root.join("save.dat"), b"backup").unwrap();
    let service = service_with_release(library.clone(), "v1");
    let backup = service.create_backup("zelda64-recomp").unwrap();
    fs::remove_dir_all(&user_root).unwrap();

    let restored = restore_authorized(&service, "zelda64-recomp", &backup.id).unwrap();

    assert!(restored.safety_backup.is_none());
    assert_eq!(fs::read(user_root.join("save.dat")).unwrap(), b"backup");
}

#[test]
fn delete_backup_removes_only_the_selected_snapshot() {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let user_root = library.user_dir("zelda64-recomp");
    fs::create_dir_all(&user_root).unwrap();
    fs::write(user_root.join("save.dat"), b"live").unwrap();
    let service = service_with_release(library.clone(), "v1");
    let backup = service.create_backup("zelda64-recomp").unwrap();

    let deleted = delete_backup_authorized(&service, "zelda64-recomp", &backup.id).unwrap();

    assert_eq!(deleted, backup);
    assert!(!backup.path.exists());
    assert_eq!(fs::read(user_root.join("save.dat")).unwrap(), b"live");
    assert!(
        service
            .list_backups("zelda64-recomp")
            .unwrap()
            .backups
            .is_empty()
    );
    let activity = &library.activities(1).unwrap()[0];
    assert_eq!(activity.operation, ActivityOperation::DeleteBackup);
    assert_eq!(activity.status, ActivityStatus::Succeeded);
}

#[test]
fn backup_inventory_isolates_every_damaged_entry_and_allows_new_backups() {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let user_root = library.user_dir("zelda64-recomp");
    fs::create_dir_all(&user_root).unwrap();
    fs::write(user_root.join("save.dat"), b"live").unwrap();
    let service = service_with_release(library.clone(), "v1");
    let healthy = service.create_backup("zelda64-recomp").unwrap();
    let parent = library.backups_dir().join("zelda64-recomp");
    let missing = Uuid::new_v4().to_string();
    fs::create_dir(parent.join(&missing)).unwrap();
    let unreadable = Uuid::new_v4().to_string();
    fs::create_dir_all(parent.join(&unreadable).join("backup.json")).unwrap();
    let malformed = Uuid::new_v4().to_string();
    fs::create_dir(parent.join(&malformed)).unwrap();
    fs::write(parent.join(&malformed).join("backup.json"), b"{").unwrap();
    let mismatched = Uuid::new_v4().to_string();
    fs::create_dir(parent.join(&mismatched)).unwrap();
    fs::write(
        parent.join(&mismatched).join("backup.json"),
        serde_json::to_vec(&serde_json::json!({
            "id": Uuid::new_v4().to_string(),
            "port_id": "another-port",
            "created_at": 1,
            "file_count": 1,
            "size": 1,
            "sha256": "a".repeat(64),
        }))
        .unwrap(),
    )
    .unwrap();

    let inventory = service.list_backups("zelda64-recomp").unwrap();

    assert_eq!(inventory.state, BackupInventoryState::Degraded);
    assert_eq!(inventory.backups, [healthy]);
    assert_eq!(inventory.problems.len(), 4);
    let kinds = inventory
        .problems
        .iter()
        .map(|problem| problem.kind)
        .collect::<HashSet<_>>();
    assert_eq!(
        kinds,
        HashSet::from([
            BackupProblemKind::MissingManifest,
            BackupProblemKind::UnreadableManifest,
            BackupProblemKind::MalformedManifest,
            BackupProblemKind::IdentityMismatch,
        ])
    );
    assert_eq!(
        service
            .repair_plan()
            .unwrap()
            .items
            .iter()
            .filter(|item| item.kind == RepairItemKind::DegradedBackup)
            .count(),
        4
    );
    for (backup_id, expected) in [
        (&missing, "missing_manifest"),
        (&unreadable, "unreadable_manifest"),
        (&malformed, "malformed_manifest"),
        (&mismatched, "identity_mismatch"),
    ] {
        for action in [BackupAction::Restore, BackupAction::Delete] {
            let error = service
                .preview_backup_action("zelda64-recomp", backup_id, action)
                .unwrap_err();
            assert_eq!(error.details["backup_problem"], expected);
        }
    }

    fs::write(user_root.join("save.dat"), b"new live data").unwrap();
    let newer = service.create_backup("zelda64-recomp").unwrap();
    let after = service.list_backups("zelda64-recomp").unwrap();
    assert_eq!(after.backups.len(), 2);
    assert_eq!(after.backups[0], newer);
    assert_eq!(after.problems.len(), 4);
}

#[cfg(unix)]
#[test]
fn unreadable_backup_manifest_is_reported_without_hiding_other_backups() {
    use std::os::unix::fs::PermissionsExt;

    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let user_root = library.user_dir("zelda64-recomp");
    fs::create_dir_all(&user_root).unwrap();
    fs::write(user_root.join("save.dat"), b"live").unwrap();
    let service = service_with_release(library, "v1");
    let first = service.create_backup("zelda64-recomp").unwrap();
    fs::write(user_root.join("save.dat"), b"newer").unwrap();
    let readable = service.create_backup("zelda64-recomp").unwrap();
    let manifest = first.path.join("backup.json");
    fs::set_permissions(&manifest, fs::Permissions::from_mode(0o000)).unwrap();

    let inventory = service.list_backups("zelda64-recomp").unwrap();

    assert_eq!(inventory.backups, [readable]);
    assert_eq!(inventory.state, BackupInventoryState::Degraded);
    assert_eq!(
        inventory.problems[0].kind,
        BackupProblemKind::UnreadableManifest
    );
    for action in [BackupAction::Restore, BackupAction::Delete] {
        let error = service
            .preview_backup_action("zelda64-recomp", &first.id, action)
            .unwrap_err();
        assert_eq!(error.details["backup_problem"], "unreadable_manifest");
    }
    fs::set_permissions(&manifest, fs::Permissions::from_mode(0o600)).unwrap();
}

#[cfg(unix)]
#[test]
fn symlinked_backup_root_is_recovery_required_and_never_followed() {
    use std::os::unix::fs::symlink;

    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let outside = temporary.path().join("outside");
    let backup_id = Uuid::new_v4().to_string();
    let user_root = library.user_dir("zelda64-recomp");
    fs::create_dir_all(&user_root).unwrap();
    fs::write(user_root.join("save.dat"), b"live").unwrap();
    fs::create_dir_all(outside.join(&backup_id)).unwrap();
    fs::write(outside.join(&backup_id).join("valuable.dat"), b"preserve").unwrap();
    fs::create_dir_all(library.backups_dir()).unwrap();
    symlink(&outside, library.backups_dir().join("zelda64-recomp")).unwrap();
    let service = service_with_release(library, "v1");

    let inventory = service.list_backups("zelda64-recomp").unwrap();

    assert_eq!(inventory.state, BackupInventoryState::RecoveryRequired);
    assert!(inventory.backups.is_empty());
    assert_eq!(
        fs::read(outside.join(&backup_id).join("valuable.dat")).unwrap(),
        b"preserve"
    );
    let create_error = service.create_backup("zelda64-recomp").unwrap_err();
    assert_eq!(create_error.code, crate::ErrorCode::Conflict);
    let error = service
        .delete_backup("zelda64-recomp", &backup_id, "invalid")
        .unwrap_err();
    assert_eq!(error.code, crate::ErrorCode::Conflict);
    assert_eq!(
        fs::read(outside.join(&backup_id).join("valuable.dat")).unwrap(),
        b"preserve"
    );
}

fn assert_backup_deletion_recovers_after_every_recorded_transition(point: LifecycleFaultPoint) {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let user_root = library.user_dir("zelda64-recomp");
    fs::create_dir_all(&user_root).unwrap();
    fs::write(user_root.join("save.dat"), b"live").unwrap();
    let service = service_with_fault(library.clone(), point);
    let backup = service.create_backup("zelda64-recomp").unwrap();

    let error = delete_backup_authorized(&service, "zelda64-recomp", &backup.id).unwrap_err();
    assert!(error.message.contains("injected lifecycle failure"));
    let interrupted = service.list_backups("zelda64-recomp").unwrap();
    assert_eq!(
        interrupted.state,
        BackupInventoryState::RecoveryRequired,
        "{point:?}"
    );

    let recovered = service_with_release(library.clone(), "v1");
    let inventory = recovered.list_backups("zelda64-recomp").unwrap();
    assert_eq!(inventory.state, BackupInventoryState::Healthy, "{point:?}");
    assert!(inventory.backups.is_empty(), "{point:?}");
    assert!(inventory.problems.is_empty(), "{point:?}");
    assert!(
        recovered.repair_plan().unwrap().items.is_empty(),
        "{point:?}"
    );
    assert_eq!(fs::read(user_root.join("save.dat")).unwrap(), b"live");
}

#[test]
fn recovers_delete_backup_prepared() {
    assert_backup_deletion_recovers_after_every_recorded_transition(
        LifecycleFaultPoint::DeleteBackupPrepared,
    );
}

#[test]
fn recovers_delete_backup_quarantined() {
    assert_backup_deletion_recovers_after_every_recorded_transition(
        LifecycleFaultPoint::DeleteBackupQuarantined,
    );
}

#[test]
fn recovers_delete_backup_deleting() {
    assert_backup_deletion_recovers_after_every_recorded_transition(
        LifecycleFaultPoint::DeleteBackupDeleting,
    );
}

#[test]
fn recovers_delete_backup_deleted() {
    assert_backup_deletion_recovers_after_every_recorded_transition(
        LifecycleFaultPoint::DeleteBackupDeleted,
    );
}

#[test]
fn recovers_delete_backup_metadata_committed() {
    assert_backup_deletion_recovers_after_every_recorded_transition(
        LifecycleFaultPoint::DeleteBackupMetadataCommitted,
    );
}

#[test]
fn backup_deletion_recovery_completes_a_partially_removed_quarantine() {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let user_root = library.user_dir("zelda64-recomp");
    fs::create_dir_all(&user_root).unwrap();
    fs::write(user_root.join("save.dat"), b"live").unwrap();
    let service = service_with_fault(library.clone(), LifecycleFaultPoint::DeleteBackupDeleting);
    let backup = service.create_backup("zelda64-recomp").unwrap();
    delete_backup_authorized(&service, "zelda64-recomp", &backup.id).unwrap_err();
    let quarantine = service.list_backups("zelda64-recomp").unwrap().problems[0]
        .path
        .clone();
    fs::remove_file(quarantine.join("data/save.dat")).unwrap();

    let recovered = service_with_release(library, "v1");

    assert!(!quarantine.exists());
    assert!(
        recovered
            .list_backups("zelda64-recomp")
            .unwrap()
            .problems
            .is_empty()
    );
}

#[test]
fn ambiguous_backup_deletion_state_requires_review_without_deleting_either_path() {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let user_root = library.user_dir("zelda64-recomp");
    fs::create_dir_all(&user_root).unwrap();
    fs::write(user_root.join("save.dat"), b"live").unwrap();
    let service = service_with_fault(library.clone(), LifecycleFaultPoint::DeleteBackupPrepared);
    let backup = service.create_backup("zelda64-recomp").unwrap();
    delete_backup_authorized(&service, "zelda64-recomp", &backup.id).unwrap_err();
    let operation = OperationStore::new(library.clone())
        .all()
        .unwrap()
        .remove(0);
    let quarantine = operation.paths.quarantine.unwrap();
    fs::create_dir(&quarantine).unwrap();
    fs::copy(
        backup.path.join("backup.json"),
        quarantine.join("backup.json"),
    )
    .unwrap();

    let recovered = service_with_release(library, "v1");
    let inventory = recovered.list_backups("zelda64-recomp").unwrap();

    assert!(backup.path.exists());
    assert!(quarantine.exists());
    assert_eq!(inventory.state, BackupInventoryState::RecoveryRequired);
    assert!(inventory.backups.contains(&backup));
    assert!(!recovered.repair_plan().unwrap().items.is_empty());
}

#[test]
fn backup_deletion_recovery_never_mutates_paths_outside_the_backup_root() {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let service = service_with_release(library.clone(), "v1");
    let outside = temporary.path().join(Uuid::new_v4().to_string());
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("valuable.dat"), b"preserve").unwrap();
    let mut operation = LifecycleOperation::new(
        Uuid::new_v4().to_string(),
        LifecycleOperationKind::DeleteBackup,
        "zelda64-recomp",
    );
    operation.phase = LifecyclePhase::Prepared;
    operation.paths.final_path = Some(outside.clone());
    operation.paths.quarantine = Some(temporary.path().join(format!(".deleting-{}", operation.id)));
    OperationStore::new(library.clone())
        .put(&mut operation)
        .unwrap();

    let recovered = service_with_release(library, "v1");

    assert_eq!(fs::read(outside.join("valuable.dat")).unwrap(), b"preserve");
    assert!(!recovered.repair_plan().unwrap().items.is_empty());
    drop(service);
}

#[test]
fn backup_deletion_keeps_authorization_and_lock_failures_non_mutating() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("library");
    let library = Library::open(&root).unwrap();
    let user_root = library.user_dir("zelda64-recomp");
    fs::create_dir_all(&user_root).unwrap();
    fs::write(user_root.join("save.dat"), b"live").unwrap();
    let service = service_with_release(library.clone(), "v1");
    let backup = service.create_backup("zelda64-recomp").unwrap();

    let unauthorized = service
        .delete_backup("zelda64-recomp", &backup.id, "invalid")
        .unwrap_err();
    assert_eq!(unauthorized.code, crate::ErrorCode::Conflict);
    assert!(backup.path.exists());

    let preview = service
        .preview_backup_action("zelda64-recomp", &backup.id, BackupAction::Delete)
        .unwrap();
    let authorization = service
        .authorize_backup_action(
            "zelda64-recomp",
            &backup.id,
            BackupAction::Delete,
            &preview.preview_sha256,
        )
        .unwrap();
    let competing = Library::open(root).unwrap();
    let _guard = competing
        .try_lock_port("zelda64-recomp", "competing-operation")
        .unwrap();
    let locked = service
        .delete_backup("zelda64-recomp", &backup.id, &authorization.token)
        .unwrap_err();
    assert_eq!(locked.code, crate::ErrorCode::Conflict);
    assert!(backup.path.exists());
    assert!(
        service
            .list_backups("zelda64-recomp")
            .unwrap()
            .problems
            .is_empty()
    );
}

#[cfg(unix)]
#[test]
fn backup_rejects_symbolic_links_instead_of_omitting_them() {
    use std::os::unix::fs::symlink;

    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let user_root = library.user_dir("zelda64-recomp");
    fs::create_dir_all(&user_root).unwrap();
    let external = temporary.path().join("external-save");
    fs::write(&external, b"save").unwrap();
    symlink(external, user_root.join("linked-save")).unwrap();
    let service = service_with_release(library, "v1");

    let error = service.create_backup("zelda64-recomp").unwrap_err();
    assert_eq!(error.code, crate::ErrorCode::Conflict);
    assert!(error.message.contains("symbolic link"));
}

#[test]
fn restore_family_decodes_all_released_phases_without_mutation() {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let service = service_with_release(library.clone(), "v2");
    let store = OperationStore::new(library.clone());
    let mut operation = LifecycleOperation::new(
        "legacy-restore",
        LifecycleOperationKind::Restore,
        "zelda64-recomp",
    );
    let recovery = library.recovery_dir().join(&operation.id);
    let user = library.user_dir(&operation.port_id);
    let previous = recovery.join("previous-data");
    operation.paths.staging = Some(recovery.clone());
    operation.paths.final_path = Some(user.clone());
    operation.paths.quarantine = Some(previous.clone());
    operation.last_error = Some("retained diagnostic".into());
    for (stored, typed) in [
        (LifecyclePhase::Preparing, RestorePhase::Unverified),
        (LifecyclePhase::Prepared, RestorePhase::ReadyToPublish),
        (LifecyclePhase::PayloadPublished, RestorePhase::Published),
        (LifecyclePhase::MetadataCommitted, RestorePhase::Committed),
        (LifecyclePhase::CleanupPending, RestorePhase::CleanupPending),
    ] {
        for replaces_existing_data in [false, true] {
            operation.phase = stored;
            operation.activate = replaces_existing_data;
            store.put(&mut operation).unwrap();
            let persisted = store.get(&operation.id).unwrap().unwrap();
            let restore = service.validate_restore_operation(&persisted).unwrap();
            assert_eq!(restore.phase, typed);
            assert_eq!(restore.replaces_existing_data, replaces_existing_data);
            assert_eq!(restore.recovery_root, recovery);
            assert_eq!(restore.staged_data, recovery.join("staged-data"));
            assert_eq!(restore.user_root, user);
            assert_eq!(restore.previous_data, previous);
            let unchanged = store.get(&operation.id).unwrap().unwrap();
            assert_eq!(unchanged.phase, stored);
            assert_eq!(unchanged.activate, replaces_existing_data);
            assert_eq!(unchanged.last_error, operation.last_error);
            assert_eq!(unchanged.updated_at, operation.updated_at);
            assert!(!recovery.exists());
            assert!(!user.exists());
        }
    }
}

#[test]
fn restore_family_refuses_skipped_or_stale_transitions_before_journal_write() {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let service = service_with_release(library.clone(), "v2");
    let store = OperationStore::new(library.clone());
    let mut operation = LifecycleOperation::new(
        "checked-restore",
        LifecycleOperationKind::Restore,
        "zelda64-recomp",
    );
    let recovery = library.recovery_dir().join(&operation.id);
    operation.paths.staging = Some(recovery.clone());
    operation.paths.final_path = Some(library.user_dir(&operation.port_id));
    operation.paths.quarantine = Some(recovery.join("previous-data"));
    operation.last_error = Some("preserved fault".into());
    store.put(&mut operation).unwrap();
    let mut restore = service.validate_restore_operation(&operation).unwrap();
    let error = restore
        .advance(RestorePhase::Committed, &mut operation, &store)
        .unwrap_err();
    assert_eq!(error.code, crate::ErrorCode::State);
    assert_eq!(operation.phase, LifecyclePhase::Preparing);
    assert_eq!(
        store.get(&operation.id).unwrap().unwrap().last_error,
        operation.last_error
    );
    operation.activate = true;
    assert!(
        restore
            .advance(RestorePhase::ReadyToPublish, &mut operation, &store)
            .is_err()
    );
    assert!(!store.get(&operation.id).unwrap().unwrap().activate);
    operation.activate = false;
    operation.preparation_process_quiesced = Some(false);
    assert!(
        restore
            .advance(RestorePhase::ReadyToPublish, &mut operation, &store)
            .is_err()
    );
    assert!(
        store
            .get(&operation.id)
            .unwrap()
            .unwrap()
            .preparation_process_quiesced
            .is_none()
    );
    operation.preparation_process_quiesced = None;
    restore
        .advance(RestorePhase::ReadyToPublish, &mut operation, &store)
        .unwrap();
    restore
        .advance(RestorePhase::Published, &mut operation, &store)
        .unwrap();
    restore
        .advance(RestorePhase::Committed, &mut operation, &store)
        .unwrap();
    let committed = store.get(&operation.id).unwrap().unwrap();
    assert_eq!(committed.phase, LifecyclePhase::MetadataCommitted);
    assert!(committed.last_error.is_none());
    assert!(!recovery.exists());
}

fn assert_backup_deletion_family_rejects_payload(variant: u8) {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let user_root = library.user_dir("zelda64-recomp");
    fs::create_dir_all(&user_root).unwrap();
    fs::write(user_root.join("save.dat"), b"live").unwrap();
    let service = service_with_fault(library.clone(), LifecycleFaultPoint::DeleteBackupPrepared);
    let backup = service.create_backup("zelda64-recomp").unwrap();
    delete_backup_authorized(&service, "zelda64-recomp", &backup.id).unwrap_err();
    let store = OperationStore::new(library.clone());
    let mut operation = store.all().unwrap().remove(0);
    let quarantine = operation.paths.quarantine.clone().unwrap();
    let manifest = fs::read(backup.path.join("backup.json")).unwrap();
    match variant {
        0 => operation.preparation_process_quiesced = Some(false),
        1 => operation.preparation_process_quiesced = Some(true),
        2 => operation.activate = true,
        3 => operation.paths.staging = Some(temporary.path().join("unrelated")),
        _ => operation.original_paths.push(user_root.clone()),
    }
    store.put(&mut operation).unwrap();
    let persisted = store.get(&operation.id).unwrap().unwrap();
    let before = format!("{persisted:?}");
    let mut rejected = persisted.clone();
    crate::recovery::recover_backup_deletion(&service, &store, &mut rejected)
        .expect_err("incompatible deletion payload must not authorize recovery");
    assert_eq!(
        format!("{:?}", store.get(&operation.id).unwrap().unwrap()),
        before
    );
    assert_eq!(fs::read(backup.path.join("backup.json")).unwrap(), manifest);
    assert_eq!(fs::read(user_root.join("save.dat")).unwrap(), b"live");
    assert!(!quarantine.exists());
    let mut valid = persisted;
    valid.preparation_process_quiesced = None;
    valid.activate = false;
    valid.paths.staging = None;
    valid.original_paths.clear();
    store.put(&mut valid).unwrap();
    crate::recovery::recover_backup_deletion(&service, &store, &mut valid).unwrap();
    assert!(!backup.path.exists());
    assert!(!quarantine.exists());
    assert!(store.get(&valid.id).unwrap().is_none());
    assert_eq!(fs::read(user_root.join("save.dat")).unwrap(), b"live");
}

#[test]
fn backup_deletion_family_rejects_unproven_quiescence() {
    assert_backup_deletion_family_rejects_payload(0);
}

#[test]
fn backup_deletion_family_rejects_proven_quiescence() {
    assert_backup_deletion_family_rejects_payload(1);
}

#[test]
fn backup_deletion_family_rejects_activation_flag() {
    assert_backup_deletion_family_rejects_payload(2);
}

#[test]
fn backup_deletion_family_rejects_staging_path() {
    assert_backup_deletion_family_rejects_payload(3);
}

#[test]
fn backup_deletion_family_rejects_original_paths() {
    assert_backup_deletion_family_rejects_payload(4);
}

#[test]
fn backup_deletion_family_decodes_legacy_phases_and_checks_transitions() {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let service = service_with_release(library.clone(), "v2");
    let store = OperationStore::new(library.clone());
    let mut operation = LifecycleOperation::new(
        "legacy-deletion",
        LifecycleOperationKind::DeleteBackup,
        "zelda64-recomp",
    );
    let original = library
        .backups_dir()
        .join(&operation.port_id)
        .join(Uuid::new_v4().to_string());
    let quarantine = original
        .parent()
        .unwrap()
        .join(format!(".deleting-{}", operation.id));
    operation.paths.final_path = Some(original.clone());
    operation.paths.quarantine = Some(quarantine.clone());
    operation.last_error = Some("retained fault".into());
    for (stored, typed) in [
        (LifecyclePhase::Preparing, BackupDeletionPhase::Unconfirmed),
        (LifecyclePhase::Prepared, BackupDeletionPhase::Authorized),
        (
            LifecyclePhase::PayloadPublished,
            BackupDeletionPhase::Quarantined,
        ),
        (
            LifecyclePhase::MetadataCommitted,
            BackupDeletionPhase::Deleted,
        ),
        (
            LifecyclePhase::CleanupPending,
            BackupDeletionPhase::CleanupPending,
        ),
    ] {
        operation.phase = stored;
        store.put(&mut operation).unwrap();
        let persisted = store.get(&operation.id).unwrap().unwrap();
        let deletion = service
            .validate_backup_deletion_operation(&persisted)
            .unwrap();
        assert_eq!(deletion.phase, typed);
        assert_eq!(deletion.original, original);
        assert_eq!(deletion.quarantine, quarantine);
        assert_eq!(
            format!("{:?}", store.get(&operation.id).unwrap().unwrap()),
            format!("{persisted:?}")
        );
        assert!(!original.exists());
        assert!(!quarantine.exists());
    }
    operation.phase = LifecyclePhase::Preparing;
    store.put(&mut operation).unwrap();
    let before = format!("{:?}", store.get(&operation.id).unwrap().unwrap());
    assert!(crate::recovery::recover_backup_deletion(&service, &store, &mut operation).is_err());
    assert_eq!(
        format!("{:?}", store.get(&operation.id).unwrap().unwrap()),
        before
    );
    operation.phase = LifecyclePhase::Prepared;
    store.put(&mut operation).unwrap();
    let mut deletion = service
        .validate_backup_deletion_operation(&operation)
        .unwrap();
    let before = format!("{:?}", store.get(&operation.id).unwrap().unwrap());
    assert!(
        deletion
            .advance(BackupDeletionPhase::Deleted, &mut operation, &store)
            .is_err()
    );
    operation.paths.quarantine = Some(temporary.path().join("unrelated"));
    assert!(
        deletion
            .advance(BackupDeletionPhase::Quarantined, &mut operation, &store)
            .is_err()
    );
    operation.paths.quarantine = Some(quarantine.clone());
    operation.activate = true;
    assert!(
        deletion
            .advance(BackupDeletionPhase::Quarantined, &mut operation, &store)
            .is_err()
    );
    assert_eq!(
        format!("{:?}", store.get(&operation.id).unwrap().unwrap()),
        before
    );
    operation.activate = false;
    deletion
        .advance(BackupDeletionPhase::Quarantined, &mut operation, &store)
        .unwrap();
    deletion
        .advance(BackupDeletionPhase::Deleted, &mut operation, &store)
        .unwrap();
    assert_eq!(
        store.get(&operation.id).unwrap().unwrap().phase,
        LifecyclePhase::MetadataCommitted
    );
    assert!(
        store
            .get(&operation.id)
            .unwrap()
            .unwrap()
            .last_error
            .is_none()
    );
    // Released cleanup-pending records may contain only a partially removed quarantine.
    fs::create_dir_all(&quarantine).unwrap();
    fs::write(quarantine.join("partial-data"), b"remaining").unwrap();
    operation.phase = LifecyclePhase::CleanupPending;
    store.put(&mut operation).unwrap();
    crate::recovery::recover_backup_deletion(&service, &store, &mut operation).unwrap();
    assert!(!quarantine.exists());
    assert!(store.get(&operation.id).unwrap().is_none());
}
