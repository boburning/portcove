//! Inert persistence fixtures: no original game bytes or upstream executable run.
#![cfg(windows)]

use super::*;

const PORT: &str = "shipwright";
const OFFICIAL_SHA256: &str = "429292a0bfbdfcda283b33c1538ecdc49163b9ed53e8702cac80b2489d9fe26c";

fn register(
    library: &Library,
    qualification: &InstallQualification,
    id: &str,
    active: bool,
) -> InstallRecord {
    let root = library.versions_dir().join(PORT).join(id);
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("soh.exe"), b"inert executable, never run").unwrap();
    fs::write(root.join("engine.dll"), b"immutable fixture engine").unwrap();
    let artifact = crate::ArtifactIdentity {
        asset_name: "SoH-Dewey-Bravo-Win64.zip".into(),
        sha256: OFFICIAL_SHA256.into(),
        size: 72_980_600,
    };
    let (manifest_sha256, selected_executable, runtime) = Installer::new(library.clone())
        .unwrap()
        .create_manifest(id, PORT, "9.3.1", &artifact, qualification, &root)
        .unwrap();
    let install = InstallRecord {
        id: id.into(),
        port_id: PORT.into(),
        version: "9.3.1".into(),
        path: root,
        channel: ReleaseChannel::Stable,
        installed_at: 1,
        verified: true,
        staged: !active,
        artifact,
        manifest_sha256,
        selected_executable,
        runtime,
    };
    library.register_install(&install, active).unwrap();
    install
}

fn fixture() -> (
    tempfile::TempDir,
    PortcoveService,
    InstallRecord,
    InstallQualification,
) {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let mut old_port = Catalog::embedded().unwrap().port(PORT).unwrap().clone();
    // A source-less, inert clone exercises persistence/preflight, not source
    // qualification or gameplay. Retained/current facts differ only by Save.
    old_port.source_profile = None;
    old_port.presentation = None;
    old_port.persistent_paths.retain(|path| path != "Save");
    let qualification =
        crate::test_fixture::retained_qualification(&old_port, Platform::WindowsX86_64).unwrap();
    let active = register(&library, &qualification, "active", true);
    let retained = Installer::new(library.clone())
        .unwrap()
        .retained_catalog(&active)
        .unwrap()
        .unwrap();
    let mut current = retained.authoritative_document();
    current
        .ports
        .iter_mut()
        .find(|port| port.id == PORT)
        .unwrap()
        .persistent_paths
        .push("Save".into());
    let mut service = PortcoveService::new(library).unwrap();
    service.replace_catalog_for_test(
        Catalog::from_json(&serde_json::to_string(&current).unwrap()).unwrap(),
    );
    (temporary, service, active, qualification)
}

fn game_write(install: &InstallRecord, contents: &[u8]) {
    fs::create_dir_all(install.path.join("Save")).unwrap();
    fs::write(install.path.join("Save/file1.sav"), contents).unwrap();
    fs::write(install.path.join(LAUNCH_MARKER), b"1").unwrap();
}

#[test]
fn shipwright_retained_save_is_collected_before_launch_restore_without_manifest_rewrite() {
    let (_temporary, service, active, _qualification) = fixture();
    let manifest = fs::read(active.path.join(".portcove-manifest.json")).unwrap();
    game_write(&active, b"game-owned save before repair");
    let canonical = service.library.user_dir(PORT).join("Save/file1.sav");
    assert!(!canonical.exists());
    let spec = service.prepare_launch(PORT, None).unwrap();
    assert_eq!(spec.working_directory, active.path);
    assert_eq!(
        fs::read(&canonical).unwrap(),
        b"game-owned save before repair"
    );
    assert_eq!(
        fs::read(active.path.join("Save/file1.sav")).unwrap(),
        b"game-owned save before repair"
    );
    assert_eq!(
        fs::read(active.path.join(".portcove-manifest.json")).unwrap(),
        manifest
    );
    assert!(
        !service
            .installed_port(&active)
            .unwrap()
            .persistent_paths
            .contains(&"Save".into())
    );
    assert!(service.verify(PORT).unwrap().valid);
}

#[test]
fn shipwright_backup_assessment_observes_then_backup_collects_runtime_save() {
    let (_temporary, service, active, _qualification) = fixture();
    game_write(&active, b"runtime save, not hand-seeded canonical data");
    let canonical = service.library.user_dir(PORT).join("Save/file1.sav");
    let inventory = service.list_backups(PORT).unwrap();
    assert_eq!(
        inventory.create_assessment.availability,
        PortActionAvailability::Allowed
    );
    assert!(!canonical.exists(), "assessment must remain read-only");
    let backup = service.create_backup(PORT).unwrap();
    assert_eq!(
        fs::read(&canonical).unwrap(),
        b"runtime save, not hand-seeded canonical data"
    );
    assert!(backup.file_count > 0);
}

#[test]
fn shipwright_backup_restore_keeps_the_displaced_runtime_save_in_safety_backup() {
    let started = std::time::Instant::now();
    let (_temporary, service, active, _) = fixture();
    eprintln!("Shipwright restore fixture ready: {:?}", started.elapsed());
    game_write(&active, b"wanted save");
    let wanted = service.create_backup(PORT).unwrap();
    eprintln!("Shipwright wanted backup created: {:?}", started.elapsed());
    assert_eq!(b"wanted save".len(), b"newest save".len());
    game_write(&active, b"newest save");
    let preview = service
        .preview_backup_action(PORT, &wanted.id, BackupAction::Restore)
        .unwrap();
    let approval = service
        .authorize_backup_action(
            PORT,
            &wanted.id,
            BackupAction::Restore,
            &preview.preview_sha256,
        )
        .unwrap();
    // Collection discovers the newer working save after the first review.
    // Preserve the refusal: fresh consequences require fresh authorization.
    let refused = service
        .restore_backup(PORT, &wanted.id, &approval.token)
        .unwrap_err();
    assert_eq!(refused.code, crate::ErrorCode::Conflict);
    assert!(refused.message.contains("state changed"));
    eprintln!(
        "Shipwright stale restore review refused: {:?}",
        started.elapsed()
    );
    assert_eq!(
        fs::read(active.path.join("Save/file1.sav")).unwrap(),
        b"newest save"
    );
    assert_eq!(
        fs::read(wanted.path.join("data/Save/file1.sav")).unwrap(),
        b"wanted save"
    );
    assert_eq!(
        fs::read(service.library.user_dir(PORT).join("Save/file1.sav")).unwrap(),
        b"newest save"
    );
    let preview = service
        .preview_backup_action(PORT, &wanted.id, BackupAction::Restore)
        .unwrap();
    assert!(preview.safety_backup_will_be_created);
    let approval = service
        .authorize_backup_action(
            PORT,
            &wanted.id,
            BackupAction::Restore,
            &preview.preview_sha256,
        )
        .unwrap();
    let restored = service
        .restore_backup(PORT, &wanted.id, &approval.token)
        .unwrap();
    eprintln!(
        "Shipwright freshly reviewed restore complete: {:?}",
        started.elapsed()
    );
    assert_eq!(
        fs::read(active.path.join("Save/file1.sav")).unwrap(),
        b"wanted save"
    );
    assert_eq!(
        fs::read(service.library.user_dir(PORT).join("Save/file1.sav")).unwrap(),
        b"wanted save"
    );
    assert_eq!(
        fs::read(
            restored
                .safety_backup
                .unwrap()
                .path
                .join("data/Save/file1.sav")
        )
        .unwrap(),
        b"newest save"
    );
}

#[test]
fn shipwright_activation_and_rollback_collect_before_replacing_working_save() {
    let started = std::time::Instant::now();
    let (_temporary, service, active, qualification) = fixture();
    eprintln!(
        "Shipwright activation fixture ready: {:?}",
        started.elapsed()
    );
    let staged = register(&service.library, &qualification, "staged", false);
    eprintln!(
        "Shipwright staged fixture registered: {:?}",
        started.elapsed()
    );
    game_write(&active, b"active progress");
    service
        .activate_staged_reviewed(PORT, Some(&active.id), &staged.id)
        .unwrap();
    eprintln!(
        "Shipwright reviewed activation complete: {:?}",
        started.elapsed()
    );
    assert_eq!(
        fs::read(staged.path.join("Save/file1.sav")).unwrap(),
        b"active progress"
    );
    game_write(&staged, b"staged progress");
    service.rollback(PORT).unwrap();
    eprintln!("Shipwright rollback complete: {:?}", started.elapsed());
    assert_eq!(
        fs::read(active.path.join("Save/file1.sav")).unwrap(),
        b"staged progress"
    );
    assert_eq!(
        fs::read(service.library.user_dir(PORT).join("Save/file1.sav")).unwrap(),
        b"staged progress"
    );
    assert!(service.verify(PORT).unwrap().valid);
}

#[test]
fn shipwright_interrupted_activation_recovers_runtime_save() {
    let (_temporary, service, active, qualification) = fixture();
    let staged = register(&service.library, &qualification, "staged", false);
    game_write(&active, b"progress before interrupted activation");
    let store = OperationStore::new(service.library.clone());
    let mut operation = LifecycleOperation::new(
        "shipwright-save-recovery",
        LifecycleOperationKind::Activate,
        PORT,
    );
    operation.install = Some(staged.clone());
    store.put(&mut operation).unwrap();
    service.recover_activation(&store, &mut operation).unwrap();
    assert_eq!(service.status(PORT).unwrap().active.unwrap().id, staged.id);
    assert_eq!(
        fs::read(staged.path.join("Save/file1.sav")).unwrap(),
        b"progress before interrupted activation"
    );
    assert!(store.all().unwrap().is_empty());
}

#[test]
fn shipwright_removal_collects_runtime_save_without_removing_backup_or_original() {
    let (temporary, service, active, _) = fixture();
    let original = temporary.path().join("original.z64");
    fs::write(&original, b"inert original witness").unwrap();
    game_write(&active, b"initial progress");
    let backup = service.create_backup(PORT).unwrap();
    game_write(&active, b"last progress before uninstall");
    let preview = service.preview_removal(PORT).unwrap();
    let approval = service
        .authorize_removal(PORT, &preview.preview_sha256)
        .unwrap();
    service.remove(PORT, &approval.token).unwrap();
    assert!(!active.path.exists());
    assert_eq!(
        fs::read(service.library.user_dir(PORT).join("Save/file1.sav")).unwrap(),
        b"last progress before uninstall"
    );
    assert_eq!(
        fs::read(backup.path.join("data/Save/file1.sav")).unwrap(),
        b"initial progress"
    );
    assert_eq!(fs::read(original).unwrap(), b"inert original witness");
}

#[test]
fn shipwright_known_windows_route_does_not_generalize_artifact_or_environment() {
    let (_temporary, service, active, _) = fixture();
    let port = service.installed_mutability_port(&active).unwrap();
    assert!(shipwright_windows_cwd_persistence(
        &port,
        &active,
        Platform::WindowsX86_64
    ));
    for platform in [
        Platform::LinuxX86_64,
        Platform::MacosX86_64,
        Platform::MacosAarch64,
    ] {
        assert!(!shipwright_windows_cwd_persistence(
            &port, &active, platform
        ));
    }
    for version in ["9.2.3", "9.3.2", "unverified"] {
        let mut unknown = active.clone();
        unknown.version = version.into();
        assert!(!shipwright_windows_cwd_persistence(
            &port,
            &unknown,
            Platform::WindowsX86_64
        ));
    }
    let mut unknown = active.clone();
    unknown.artifact.sha256 = "0".repeat(64);
    assert!(!shipwright_windows_cwd_persistence(
        &port,
        &unknown,
        Platform::WindowsX86_64
    ));
    unknown = active.clone();
    unknown.artifact.asset_name = "unverified-fork.zip".into();
    assert!(!shipwright_windows_cwd_persistence(
        &port,
        &unknown,
        Platform::WindowsX86_64
    ));
    unknown = active.clone();
    unknown.artifact.size += 1;
    assert!(!shipwright_windows_cwd_persistence(
        &port,
        &unknown,
        Platform::WindowsX86_64
    ));
    let mut explicit = port.clone();
    explicit.user_data_environment = Some("EXPLICIT_OWNED_ROOT".into());
    assert!(!shipwright_windows_cwd_persistence(
        &explicit,
        &active,
        Platform::WindowsX86_64
    ));
    assert!(writes_directly_to_user_root(&explicit));
    let mut other = port.clone();
    other.id = "lighthouse".into();
    assert!(!shipwright_windows_cwd_persistence(
        &other,
        &active,
        Platform::WindowsX86_64
    ));
    assert!(writes_directly_to_user_root(
        Catalog::embedded().unwrap().port("lighthouse").unwrap()
    ));
}

#[test]
fn shipwright_unexpected_working_save_file_is_not_collected_over_canonical_directory() {
    let (_temporary, service, active, _) = fixture();
    fs::write(active.path.join("Save"), b"unexpected working file").unwrap();
    fs::write(active.path.join(LAUNCH_MARKER), b"1").unwrap();
    let canonical = service.library.user_dir(PORT).join("Save");
    fs::create_dir_all(&canonical).unwrap();
    fs::write(canonical.join("file1.sav"), b"preserved canonical progress").unwrap();
    assert_eq!(
        service
            .list_backups(PORT)
            .unwrap()
            .create_assessment
            .availability,
        PortActionAvailability::Held
    );
    assert!(service.create_backup(PORT).is_err());
    assert_eq!(
        fs::read(active.path.join("Save")).unwrap(),
        b"unexpected working file"
    );
    assert_eq!(
        fs::read(canonical.join("file1.sav")).unwrap(),
        b"preserved canonical progress"
    );
}

#[test]
fn shipwright_new_save_path_cannot_override_an_immutable_manifest_entry() {
    let (_temporary, service, _, qualification) = fixture();
    let root = service.library.versions_dir().join(PORT).join("immutable");
    fs::create_dir_all(root.join("Save")).unwrap();
    fs::write(root.join("Save/file1.sav"), b"immutable packaged witness").unwrap();
    let immutable = register(&service.library, &qualification, "immutable", true);
    assert!(
        !service
            .installed_mutability_port(&immutable)
            .unwrap()
            .persistent_paths
            .contains(&"Save".into())
    );
    game_write(&immutable, b"changed packaged witness");
    assert!(!service.verify(PORT).unwrap().valid);
    // Ordinary launch verifies its critical executable set; the full check
    // above still reports this noncritical immutable witness as changed.
    service.prepare_launch(PORT, None).unwrap();
    assert!(!service.library.user_dir(PORT).join("Save").exists());
    assert_eq!(
        fs::read(immutable.path.join("Save/file1.sav")).unwrap(),
        b"changed packaged witness"
    );
}

#[test]
fn shipwright_unrelated_catalog_drift_does_not_admit_new_save_path() {
    let (_temporary, mut service, active, _) = fixture();
    let mut current = service.catalog.authoritative_document();
    current
        .ports
        .iter_mut()
        .find(|port| port.id == PORT)
        .unwrap()
        .launch_arguments
        .push("--unreviewed".into());
    service.replace_catalog_for_test(
        Catalog::from_json(&serde_json::to_string(&current).unwrap()).unwrap(),
    );
    game_write(&active, b"unadmitted runtime save");
    assert!(
        !service
            .installed_mutability_port(&active)
            .unwrap()
            .persistent_paths
            .contains(&"Save".into())
    );
    // Retained launch authority remains usable; the changed current catalog
    // must not expand its persistent paths or launch arguments.
    let spec = service.prepare_launch(PORT, None).unwrap();
    assert!(!spec.arguments.contains(&"--unreviewed".into()));
    assert!(!service.library.user_dir(PORT).join("Save").exists());
    assert_eq!(
        fs::read(active.path.join("Save/file1.sav")).unwrap(),
        b"unadmitted runtime save"
    );
}

#[test]
fn shipwright_save_root_shape_conflict_holds_without_overwriting_either_side() {
    let (_temporary, service, active, _) = fixture();
    game_write(&active, b"runtime progress");
    let canonical = service.library.user_dir(PORT).join("Save");
    fs::create_dir_all(canonical.parent().unwrap()).unwrap();
    fs::write(&canonical, b"preserve unexpected canonical file").unwrap();
    assert_eq!(
        service
            .list_backups(PORT)
            .unwrap()
            .create_assessment
            .availability,
        PortActionAvailability::Held
    );
    assert!(service.create_backup(PORT).is_err());
    assert!(service.prepare_launch(PORT, None).is_err());
    assert_eq!(
        fs::read(canonical).unwrap(),
        b"preserve unexpected canonical file"
    );
    assert_eq!(
        fs::read(active.path.join("Save/file1.sav")).unwrap(),
        b"runtime progress"
    );
}

fn assert_save_root_links_refused(create_link: fn(&Path, &Path)) {
    for canonical_link in [false, true] {
        let (temporary, service, active, _) = fixture();
        let outside = temporary.path().join("outside-save");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("file1.sav"), b"external witness").unwrap();
        let canonical = service.library.user_dir(PORT).join("Save");
        let (link, ordinary) = if canonical_link {
            (canonical, active.path.join("Save"))
        } else {
            (active.path.join("Save"), canonical)
        };
        fs::create_dir_all(link.parent().unwrap()).unwrap();
        create_link(&outside, &link);
        fs::create_dir_all(&ordinary).unwrap();
        fs::write(ordinary.join("file1.sav"), b"owned progress").unwrap();
        fs::write(active.path.join(LAUNCH_MARKER), b"1").unwrap();
        assert_eq!(
            service
                .list_backups(PORT)
                .unwrap()
                .create_assessment
                .availability,
            PortActionAvailability::Held
        );
        assert!(service.create_backup(PORT).is_err());
        assert!(service.prepare_launch(PORT, None).is_err());
        assert!(
            fs::symlink_metadata(&link)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert_eq!(
            fs::read(outside.join("file1.sav")).unwrap(),
            b"external witness"
        );
        assert_eq!(
            fs::read(ordinary.join("file1.sav")).unwrap(),
            b"owned progress"
        );
    }
}

#[test]
fn shipwright_save_root_symlinks_hold_without_following_or_writing_external_data() {
    assert_save_root_links_refused(|target, link| {
        super::tests::create_adoption_test_symlink(target, link, true);
    });
}

#[test]
fn shipwright_save_root_junctions_hold_without_following_or_writing_external_data() {
    assert_save_root_links_refused(super::tests::create_adoption_test_junction);
}
