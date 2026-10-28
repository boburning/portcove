//! Inert retained-output fixtures; no original game, player or upstream code runs.
use super::*;

const ID: &str = "gen1recomp";

fn write(root: &Path, relative: &str, bytes: &[u8]) {
    let path = root.join(relative);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, bytes).unwrap();
}

fn executable(root: &Path, relative: &str) {
    write(root, relative, b"inert executable");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(root.join(relative), fs::Permissions::from_mode(0o755)).unwrap();
    }
}

fn fixture(active: bool) -> (tempfile::TempDir, PortcoveService, InstallRecord) {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let service = PortcoveService::new(library.clone()).unwrap();
    let qualification =
        InstallQualification::from_catalog(&service.catalog, ID, Platform::current().unwrap())
            .unwrap();
    let root = library.versions_dir().join(ID).join("original");
    let executable_name = if cfg!(windows) {
        "gen1recomp.exe"
    } else {
        "gen1recomp"
    };
    executable(&root, executable_name);
    write(&root, "immutable.bin", b"immutable package data");
    let artifact = crate::ArtifactIdentity {
        asset_name: "inert-fixture.zip".into(),
        sha256: "a".repeat(64),
        size: 1,
    };
    let (manifest_sha256, selected_executable, runtime) = Installer::new(library.clone())
        .unwrap()
        .create_manifest("original", ID, "fixture", &artifact, &qualification, &root)
        .unwrap();
    let install = InstallRecord {
        id: "original".into(),
        port_id: ID.into(),
        version: "fixture".into(),
        path: root,
        channel: ReleaseChannel::Stable,
        installed_at: 0,
        verified: true,
        staged: false,
        artifact,
        runtime,
        manifest_sha256,
        selected_executable,
    };
    library.register_install(&install, active).unwrap();
    (temporary, service, install)
}

fn assert_preserved(service: &PortcoveService, install: &InstallRecord) {
    assert_eq!(
        fs::read(install.path.join("save.lua")).unwrap(),
        b"runtime progress"
    );
    assert_eq!(
        fs::read(service.library.user_dir(ID).join("save.lua")).unwrap(),
        b"canonical progress"
    );
    assert_eq!(service.library.all_installs().unwrap().len(), 1);
    assert!(
        OperationStore::new(service.library.clone())
            .all()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn generated_cache_declared_outputs_and_exact_metadata_remain_usable() {
    let (_temporary, service, install) = fixture(true);
    write(&install.path, "save.lua", b"progress");
    write(&install.path, "red/generated.bin", b"generated output");
    write(
        &install.path,
        "portcove-import.gb",
        b"inert original placeholder",
    );
    write(&install.path, "portable.txt", b"");
    write(&install.path, LAUNCH_MARKER, b"");
    service
        .require_portable_runtime_unchanged(&install)
        .unwrap();
    service
        .collect_user_data_from_install(ID, &install.path)
        .unwrap();
    assert_eq!(
        fs::read(service.library.user_dir(ID).join("save.lua")).unwrap(),
        b"progress"
    );
    service.restore_retained_user_data_to(&install).unwrap();
    service.prepare_retained_install_data(&install).unwrap();
}

#[test]
fn generated_cache_unclaimed_outputs_hold_every_prewrite_data_route() {
    let clock = std::time::Instant::now();
    for active in [false, true] {
        for unknown in [
            "saves/red/slot1.lua",
            "options.lua.bak",
            "options.lua.tmp",
            "save.lua.tmp",
        ] {
            eprintln!(
                "generated-cache-matrix phase=fixture-begin active={active} path={unknown} elapsed_ms={}",
                clock.elapsed().as_millis()
            );
            let (_temporary, service, install) = fixture(active);
            eprintln!(
                "generated-cache-matrix phase=fixture-ready active={active} path={unknown} elapsed_ms={}",
                clock.elapsed().as_millis()
            );
            write(&install.path, "save.lua", b"runtime progress");
            write(
                &service.library.user_dir(ID),
                "save.lua",
                b"canonical progress",
            );
            write(
                &install.path,
                unknown,
                b"unclaimed progress or recovery witness",
            );
            assert!(
                service
                    .collect_user_data_from_install(ID, &install.path)
                    .is_err()
            );
            eprintln!(
                "generated-cache-matrix phase=collect-refused elapsed_ms={}",
                clock.elapsed().as_millis()
            );
            assert!(
                service
                    .restore_user_data_to(service.catalog.port(ID).unwrap(), &install.path)
                    .is_err()
            );
            eprintln!(
                "generated-cache-matrix phase=restore-refused elapsed_ms={}",
                clock.elapsed().as_millis()
            );
            assert!(service.prepare_retained_install_data(&install).is_err());
            eprintln!(
                "generated-cache-matrix phase=prepare-refused elapsed_ms={}",
                clock.elapsed().as_millis()
            );
            assert!(service.preview_removal(ID).is_err());
            eprintln!(
                "generated-cache-matrix phase=preview-refused elapsed_ms={}",
                clock.elapsed().as_millis()
            );
            assert!(service.create_backup(ID).is_err());
            eprintln!(
                "generated-cache-matrix phase=backup-refused elapsed_ms={}",
                clock.elapsed().as_millis()
            );
            assert!(service.create_backup_locked(ID).is_err());
            eprintln!(
                "generated-cache-matrix phase=locked-backup-refused elapsed_ms={}",
                clock.elapsed().as_millis()
            );
            assert_preserved(&service, &install);
            assert_eq!(
                fs::read(install.path.join(unknown)).unwrap(),
                b"unclaimed progress or recovery witness"
            );
            eprintln!(
                "generated-cache-matrix phase=assertions-complete active={active} path={unknown} elapsed_ms={}",
                clock.elapsed().as_millis()
            );
        }
    }
    eprintln!(
        "generated-cache-matrix phase=complete elapsed_ms={}",
        clock.elapsed().as_millis()
    );
}

#[test]
fn generated_cache_no_launch_marker_is_not_evidence_of_no_output() {
    let (_temporary, service, install) = fixture(true);
    write(
        &install.path,
        "saves/red/slot1.lua",
        b"outside-Core progress",
    );
    assert!(service.collect_active_user_data_if_launched(ID).is_err());
    assert!(service.create_backup(ID).is_err());
    assert!(install.path.join("saves/red/slot1.lua").is_file());
    assert!(!service.library.user_dir(ID).exists());
}

#[test]
fn generated_cache_new_catalog_paths_cannot_enroll_old_outputs() {
    let (_temporary, mut service, install) = fixture(true);
    let mut catalog = serde_json::to_value(service.catalog.document()).unwrap();
    let ports = catalog["ports"].as_array_mut().unwrap();
    let port = ports.iter_mut().find(|port| port["id"] == ID).unwrap();
    port["persistent_paths"]
        .as_array_mut()
        .unwrap()
        .push(serde_json::json!("saves"));
    service.replace_catalog_for_test(
        Catalog::from_json(&serde_json::to_string(&catalog).unwrap()).unwrap(),
    );
    write(
        &install.path,
        "saves/red/slot1.lua",
        b"must not auto-enroll",
    );
    assert!(
        !service
            .installed_mutability_port(&install)
            .unwrap()
            .persistent_paths
            .contains(&"saves".into())
    );
    assert!(
        service
            .collect_user_data_from_install(ID, &install.path)
            .is_err()
    );
}

#[test]
fn generated_cache_missing_or_malformed_retained_authority_cannot_borrow_current_contract() {
    for missing in [true, false] {
        let (_temporary, service, mut install) = fixture(true);
        let path = install.path.join(".portcove-manifest.json");
        let mut manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        if missing {
            manifest
                .as_object_mut()
                .unwrap()
                .remove("retained_contract");
            manifest["schema_version"] = serde_json::json!(5);
        } else {
            manifest["retained_contract"]["catalog_json"] = serde_json::json!("malformed");
        }
        let bytes = serde_json::to_vec(&manifest).unwrap();
        fs::write(&path, &bytes).unwrap();
        install.manifest_sha256 = crate::signed_catalog::digest(&bytes);
        service.library.update_install_manifest(&install).unwrap();
        assert!(
            service
                .require_portable_runtime_unchanged(&install)
                .is_err()
        );
        assert!(
            service
                .collect_user_data_from_install(ID, &install.path)
                .is_err()
        );
        assert!(service.preview_removal(ID).is_err());
        assert!(install.path.is_dir());
    }
}

#[test]
fn generated_cache_changed_immutable_or_unregistered_roots_refuse_synchronization() {
    let (_temporary, service, install) = fixture(true);
    write(&install.path, "immutable.bin", b"modified immutable");
    assert!(
        service
            .require_portable_runtime_unchanged(&install)
            .is_err()
    );
    assert!(service.prepare_retained_install_data(&install).is_err());
    let unregistered = service.library.versions_dir().join(ID).join("unregistered");
    fs::create_dir_all(&unregistered).unwrap();
    assert!(
        service
            .collect_user_data_from_install(ID, &unregistered)
            .is_err()
    );
    assert!(
        service
            .restore_user_data_to(service.catalog.port(ID).unwrap(), &unregistered)
            .is_err()
    );
}

#[cfg(unix)]
#[test]
fn generated_cache_redirect_inside_declared_output_is_not_skipped() {
    let (_temporary, service, install) = fixture(true);
    let outside = service.library.root().join("outside");
    write(&outside, "progress", b"outside progress");
    fs::create_dir_all(install.path.join("red")).unwrap();
    std::os::unix::fs::symlink(&outside, install.path.join("red/redirect")).unwrap();
    assert!(
        service
            .require_portable_runtime_unchanged(&install)
            .is_err()
    );
    assert!(
        service
            .collect_user_data_from_install(ID, &install.path)
            .is_err()
    );
    assert_eq!(
        fs::read(outside.join("progress")).unwrap(),
        b"outside progress"
    );
}

fn removal_journal(
    service: &PortcoveService,
    install: &InstallRecord,
    phase: LifecyclePhase,
    retained: bool,
) -> LifecycleOperation {
    let mut operation =
        LifecycleOperation::new("generated-removal", LifecycleOperationKind::Remove, ID);
    operation.phase = phase;
    operation.paths.quarantine = Some(service.library.recovery_dir().join(&operation.id));
    operation.original_paths = vec![install.path.clone()];
    operation.removal_installs = retained.then(|| vec![install.clone()]);
    operation
}

#[test]
fn generated_cache_removal_recovery_preserves_unclaimed_output_in_every_phase() {
    for phase in [
        LifecyclePhase::Preparing,
        LifecyclePhase::PayloadPublished,
        LifecyclePhase::MetadataCommitted,
        LifecyclePhase::CleanupPending,
    ] {
        let (_temporary, service, install) = fixture(true);
        write(
            &service.library.user_dir(ID),
            "save.lua",
            b"canonical progress",
        );
        write(&install.path, "saves/red/slot1.lua", b"unclaimed progress");
        let mut operation = removal_journal(&service, &install, phase, true);
        let paths =
            crate::output_root::removal_paths(&service.library, ID, &operation.id, &install.path)
                .unwrap();
        let actual = if phase == LifecyclePhase::Preparing {
            install.path.clone()
        } else {
            fs::create_dir_all(paths.quarantined.parent().unwrap()).unwrap();
            fs::rename(&install.path, &paths.quarantined).unwrap();
            paths.quarantined.clone()
        };
        if matches!(
            phase,
            LifecyclePhase::MetadataCommitted | LifecyclePhase::CleanupPending
        ) {
            service.library.remove_port(ID).unwrap();
        }
        let store = OperationStore::new(service.library.clone());
        store.put(&mut operation).unwrap();
        let before = format!("{:?}", store.all().unwrap());
        assert!(crate::recovery::recover_removal(&service, &store, &mut operation).is_err());
        assert_eq!(before, format!("{:?}", store.all().unwrap()));
        assert_eq!(
            fs::read(actual.join("saves/red/slot1.lua")).unwrap(),
            b"unclaimed progress"
        );
        assert_eq!(
            fs::read(service.library.user_dir(ID).join("save.lua")).unwrap(),
            b"canonical progress"
        );
    }
}

#[test]
fn generated_cache_removal_recovery_uses_retained_records_after_database_deletion() {
    let (_temporary, service, install) = fixture(true);
    write(
        &service.library.user_dir(ID),
        "save.lua",
        b"collected progress",
    );
    let mut operation =
        removal_journal(&service, &install, LifecyclePhase::MetadataCommitted, true);
    let paths =
        crate::output_root::removal_paths(&service.library, ID, &operation.id, &install.path)
            .unwrap();
    fs::create_dir_all(paths.quarantined.parent().unwrap()).unwrap();
    fs::rename(&install.path, &paths.quarantined).unwrap();
    service.library.remove_port(ID).unwrap();
    let store = OperationStore::new(service.library.clone());
    store.put(&mut operation).unwrap();
    let mut loaded = store.all().unwrap().remove(0);
    assert_eq!(
        loaded.removal_installs.as_ref().unwrap()[0].manifest_sha256,
        install.manifest_sha256
    );
    crate::recovery::recover_removal(&service, &store, &mut loaded).unwrap();
    assert!(!paths.quarantined.exists());
    assert!(store.all().unwrap().is_empty());
    assert_eq!(
        fs::read(service.library.user_dir(ID).join("save.lua")).unwrap(),
        b"collected progress"
    );
}

#[test]
fn historical_committed_removal_without_identity_preserves_quarantine_even_if_catalog_reclassifies()
{
    let (_temporary, mut service, install) = fixture(true);
    let mut operation =
        removal_journal(&service, &install, LifecyclePhase::MetadataCommitted, false);
    let paths =
        crate::output_root::removal_paths(&service.library, ID, &operation.id, &install.path)
            .unwrap();
    fs::create_dir_all(paths.quarantined.parent().unwrap()).unwrap();
    fs::rename(&install.path, &paths.quarantined).unwrap();
    service.library.remove_port(ID).unwrap();
    service.replace_catalog_for_test(
        Catalog::from_json(r#"{"schema_version":1,"source_profiles":[],"ports":[]}"#).unwrap(),
    );
    let store = OperationStore::new(service.library.clone());
    store.put(&mut operation).unwrap();
    assert!(crate::recovery::recover_removal(&service, &store, &mut operation).is_err());
    assert!(paths.quarantined.join("immutable.bin").is_file());
    assert_eq!(store.all().unwrap().len(), 1);
}

#[test]
fn generated_cache_backup_restore_rechecks_inactive_outputs_before_replacing_canonical_data() {
    let (_temporary, service, install) = fixture(false);
    write(
        &service.library.user_dir(ID),
        "save.lua",
        b"backup progress",
    );
    let backup = service.create_backup(ID).unwrap();
    write(
        &service.library.user_dir(ID),
        "save.lua",
        b"new canonical progress",
    );
    let preview = service
        .preview_backup_action(ID, &backup.id, crate::BackupAction::Restore)
        .unwrap();
    let authorization = service
        .authorize_backup_action(
            ID,
            &backup.id,
            crate::BackupAction::Restore,
            &preview.preview_sha256,
        )
        .unwrap();

    write(
        &install.path,
        "saves/red/slot1.lua",
        b"unclaimed newer progress",
    );
    assert!(
        service
            .restore_backup(ID, &backup.id, &authorization.token)
            .is_err()
    );
    assert_eq!(
        fs::read(service.library.user_dir(ID).join("save.lua")).unwrap(),
        b"new canonical progress"
    );
    assert_eq!(
        fs::read(install.path.join("saves/red/slot1.lua")).unwrap(),
        b"unclaimed newer progress"
    );
    assert_eq!(service.library.all_installs().unwrap().len(), 1);
}

#[cfg(windows)]
#[test]
fn generated_cache_junction_inside_declared_output_preserves_target() {
    let (_temporary, service, install) = fixture(true);
    let outside = service.library.root().join("outside");
    write(&outside, "progress", b"outside progress");
    fs::create_dir_all(install.path.join("red")).unwrap();
    let link = install.path.join("red/redirect");
    let output = crate::ChildProcessPolicy::native_command(
        crate::ChildProcessClass::HostTool,
        Path::new("cmd.exe"),
    )
    .unwrap()
    .args(["/d", "/c", "mklink", "/J"])
    .arg(link.to_str().unwrap().replace('/', "\\"))
    .arg(outside.to_str().unwrap().replace('/', "\\"))
    .output()
    .unwrap();
    assert!(output.status.success(), "junction fixture: {output:?}");
    assert!(
        service
            .require_portable_runtime_unchanged(&install)
            .is_err()
    );
    assert!(
        service
            .collect_user_data_from_install(ID, &install.path)
            .is_err()
    );
    assert_eq!(
        fs::read(outside.join("progress")).unwrap(),
        b"outside progress"
    );
    fs::remove_dir(link).unwrap();
}

#[test]
fn retained_removal_cleanup_can_retire_after_payload_was_already_deleted() {
    for phase in [
        LifecyclePhase::MetadataCommitted,
        LifecyclePhase::CleanupPending,
    ] {
        let (_temporary, service, install) = fixture(true);
        let mut operation = removal_journal(&service, &install, phase, true);
        fs::remove_dir_all(&install.path).unwrap();
        service.library.remove_port(ID).unwrap();
        let store = OperationStore::new(service.library.clone());
        store.put(&mut operation).unwrap();
        crate::recovery::recover_removal(&service, &store, &mut operation).unwrap();
        assert!(store.all().unwrap().is_empty());
    }
}

#[test]
fn removal_identity_bindings_reject_missing_duplicate_and_wrong_port_records() {
    for fault in 0..3 {
        let (_temporary, service, install) = fixture(true);
        let mut operation = removal_journal(&service, &install, LifecyclePhase::Preparing, true);
        match fault {
            0 => operation.removal_installs = Some(vec![]),
            1 => operation
                .removal_installs
                .as_mut()
                .unwrap()
                .push(install.clone()),
            _ => operation.removal_installs.as_mut().unwrap()[0].port_id = "other".into(),
        }
        let removal = RemovalOperation::decode(&service.library, &operation).unwrap();
        assert!(
            removal
                .require_retained_outputs(&service, &operation)
                .is_err()
        );
        assert!(install.path.join("immutable.bin").is_file());
        assert_eq!(service.library.all_installs().unwrap().len(), 1);
    }
}

#[test]
fn retained_removal_partial_cleanup_verifies_remaining_payload_then_retires() {
    let (_temporary, service, first) = fixture(true);
    let root = service.library.versions_dir().join(ID).join("second");
    executable(&root, first.selected_executable.to_str().unwrap());
    write(&root, "immutable.bin", b"immutable package data");
    let qualification =
        InstallQualification::from_catalog(&service.catalog, ID, Platform::current().unwrap())
            .unwrap();
    let (manifest_sha256, selected_executable, runtime) = Installer::new(service.library.clone())
        .unwrap()
        .create_manifest(
            "second",
            ID,
            &first.version,
            &first.artifact,
            &qualification,
            &root,
        )
        .unwrap();
    let second = InstallRecord {
        id: "second".into(),
        path: root,
        manifest_sha256,
        selected_executable,
        runtime,
        ..first.clone()
    };
    service.library.register_install(&second, false).unwrap();
    let mut operation = removal_journal(&service, &first, LifecyclePhase::CleanupPending, true);
    operation.original_paths.push(second.path.clone());
    operation
        .removal_installs
        .as_mut()
        .unwrap()
        .push(second.clone());
    fs::remove_dir_all(&first.path).unwrap();
    let paths =
        crate::output_root::removal_paths(&service.library, ID, &operation.id, &second.path)
            .unwrap();
    fs::create_dir_all(paths.quarantined.parent().unwrap()).unwrap();
    fs::rename(&second.path, &paths.quarantined).unwrap();
    service.library.remove_port(ID).unwrap();
    let store = OperationStore::new(service.library.clone());
    store.put(&mut operation).unwrap();
    crate::recovery::recover_removal(&service, &store, &mut operation).unwrap();
    assert!(!paths.quarantined.exists());
    assert!(store.all().unwrap().is_empty());
}

#[test]
fn removal_recovery_holds_unexpected_live_payload_after_quarantine_phase() {
    for phase in [
        LifecyclePhase::PayloadPublished,
        LifecyclePhase::MetadataCommitted,
        LifecyclePhase::CleanupPending,
    ] {
        let (_temporary, service, install) = fixture(true);
        let mut operation = removal_journal(&service, &install, phase, true);
        if phase != LifecyclePhase::PayloadPublished {
            service.library.remove_port(ID).unwrap();
        }
        let store = OperationStore::new(service.library.clone());
        store.put(&mut operation).unwrap();
        assert!(crate::recovery::recover_removal(&service, &store, &mut operation).is_err());
        assert!(install.path.join("immutable.bin").is_file());
        assert_eq!(store.all().unwrap().len(), 1);
    }
}

#[test]
fn absent_generated_runtime_does_not_block_ordinary_canonical_backup() {
    let (_temporary, service, install) = fixture(true);
    write(
        &service.library.user_dir(ID),
        "save.lua",
        b"canonical progress",
    );
    fs::remove_dir_all(&install.path).unwrap();
    let backup = service.create_backup(ID).unwrap();
    assert_eq!(
        fs::read(backup.path.join("data/save.lua")).unwrap(),
        b"canonical progress"
    );
    assert!(service.preview_removal(ID).is_err());
}

#[cfg(windows)]
#[test]
fn removal_binds_extended_and_ordinary_windows_paths_to_the_same_owned_tree() {
    let (_temporary, service, install) = fixture(true);
    let mut operation = removal_journal(&service, &install, LifecyclePhase::Preparing, true);
    let raw = install.path.to_str().unwrap();
    operation.original_paths[0] = if let Some(ordinary) = raw.strip_prefix(r"\\?\") {
        PathBuf::from(ordinary)
    } else {
        PathBuf::from(format!(r"\\?\{raw}"))
    };
    let removal = RemovalOperation::decode(&service.library, &operation).unwrap();
    removal
        .require_retained_outputs(&service, &operation)
        .unwrap();
    assert!(install.path.join("immutable.bin").is_file());
}
