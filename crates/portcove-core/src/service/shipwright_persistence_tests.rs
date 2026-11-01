//! Inert persistence fixtures: no original game bytes or upstream executable run.
#![cfg(windows)]

use super::*;

const PORT: &str = "shipwright";
const OFFICIAL_SHA256: &str = "429292a0bfbdfcda283b33c1538ecdc49163b9ed53e8702cac80b2489d9fe26c";
// Opaque populated witnesses test byte preservation, not the game's JSON schema.
const SPLITS_A: &[u8] = br#"{"player":"Test player","splits":[{"name":"Forest","best":120}]}"#;
const SPLITS_B: &[u8] = br#"{"player":"Test player","splits":[{"name":"Forest","best":110}]}"#;

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
    // qualification or gameplay. Catalog facts stay unchanged; the exact
    // installed artifact receives a checked runtime-only Save interpretation.
    old_port.source_profile = None;
    old_port.presentation = None;
    old_port.game_settings = None;
    old_port.persistent_paths.retain(|path| path != "Save");
    let qualification =
        crate::test_fixture::retained_qualification(&old_port, Platform::WindowsX86_64).unwrap();
    let active = register(&library, &qualification, "active", true);
    let retained = Installer::new(library.clone())
        .unwrap()
        .retained_catalog(&active)
        .unwrap()
        .unwrap();
    let current = retained.authoritative_document();
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
fn shipwright_frozen_catalog_import_retains_runtime_save_without_rewriting_authority() {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("original")).unwrap();
    let catalog = Catalog::embedded().unwrap();
    let port = catalog.port(PORT).unwrap();
    assert!(!port.persistent_paths.iter().any(|path| path == "Save"));
    let qualification =
        InstallQualification::from_catalog(&catalog, PORT, Platform::WindowsX86_64).unwrap();
    let active = register(&library, &qualification, "original", true);
    game_write(&active, b"game-owned save in retained runtime");
    fs::create_dir_all(active.path.join("logs")).unwrap();
    fs::write(
        active.path.join("logs/Ship of Harkinian.log"),
        b"runtime diagnostics",
    )
    .unwrap();
    fs::write(active.path.join("SoHTimeSplitData.json"), SPLITS_A).unwrap();
    let manifest = fs::read(active.path.join(".portcove-manifest.json")).unwrap();
    let service = PortcoveService::new(library.clone()).unwrap();
    let metadata = temporary.path().join("metadata.json");
    service.write_library_metadata(&metadata).unwrap();
    let destination = temporary.path().join("restored");
    let plan =
        PortcoveService::plan_library_import(&metadata, library.root(), &destination).unwrap();
    assert!(!destination.exists(), "planning must leave D absent");
    PortcoveService::import_library(&metadata, library.root(), &destination, &plan.plan_sha256)
        .unwrap();
    let restored = PortcoveService::new(Library::open(&destination).unwrap()).unwrap();
    let installed = restored.status(PORT).unwrap().active.unwrap();
    assert_eq!(
        fs::read(installed.path.join(".portcove-manifest.json")).unwrap(),
        manifest
    );
    assert!(!restored.library.user_dir(PORT).join("Save").exists());
    assert_eq!(
        fs::read(installed.path.join("Save/file1.sav")).unwrap(),
        b"game-owned save in retained runtime"
    );
    let backup = restored.create_backup(PORT).unwrap();
    assert_eq!(
        fs::read(backup.path.join("data/SoHTimeSplitData.json")).unwrap(),
        SPLITS_A
    );
    assert!(
        !backup.path.join("data/logs").exists(),
        "diagnostics are not player backup data"
    );
    assert!(!restored.library.user_dir(PORT).join("logs").exists());
    assert_eq!(
        fs::read(backup.path.join("data/Save/file1.sav")).unwrap(),
        b"game-owned save in retained runtime"
    );
    assert_eq!(
        fs::read(active.path.join(".portcove-manifest.json")).unwrap(),
        manifest
    );
    assert_eq!(
        fs::read(active.path.join("Save/file1.sav")).unwrap(),
        b"game-owned save in retained runtime"
    );
}

#[test]
fn shipwright_frozen_catalog_import_still_refuses_unrecorded_immutable_files() {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("original")).unwrap();
    let catalog = Catalog::embedded().unwrap();
    let qualification =
        InstallQualification::from_catalog(&catalog, PORT, Platform::WindowsX86_64).unwrap();
    let active = register(&library, &qualification, "original", true);
    game_write(&active, b"game-owned save in retained runtime");
    fs::write(active.path.join("unrecorded.dll"), b"not a mutable save").unwrap();
    fs::create_dir_all(active.path.join("logs")).unwrap();
    fs::write(
        active.path.join("logs/unrecorded.dll"),
        b"not a runtime log",
    )
    .unwrap();
    let manifest = fs::read(active.path.join(".portcove-manifest.json")).unwrap();
    let metadata = temporary.path().join("metadata.json");
    PortcoveService::new(library.clone())
        .unwrap()
        .write_library_metadata(&metadata)
        .unwrap();
    let destination = temporary.path().join("refused");
    let plan =
        PortcoveService::plan_library_import(&metadata, library.root(), &destination).unwrap();
    assert!(!destination.exists());
    let error =
        PortcoveService::import_library(&metadata, library.root(), &destination, &plan.plan_sha256)
            .unwrap_err();
    assert!(error.message.contains("immutable manifest verification"));
    assert!(error.details["failures"].contains("unexpected: unrecorded.dll"));
    assert!(error.details["failures"].contains("unexpected: logs/unrecorded.dll"));
    assert_eq!(
        fs::read(active.path.join(".portcove-manifest.json")).unwrap(),
        manifest
    );
    assert_eq!(
        fs::read(active.path.join("Save/file1.sav")).unwrap(),
        b"game-owned save in retained runtime"
    );
    assert_eq!(
        fs::read(active.path.join("unrecorded.dll")).unwrap(),
        b"not a mutable save"
    );
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
    fs::write(active.path.join("SoHTimeSplitData.json"), SPLITS_A).unwrap();
    let wanted = service.create_backup(PORT).unwrap();
    eprintln!("Shipwright wanted backup created: {:?}", started.elapsed());
    assert_eq!(b"wanted save".len(), b"newest save".len());
    game_write(&active, b"newest save");
    assert_eq!(SPLITS_A.len(), SPLITS_B.len());
    fs::write(active.path.join("SoHTimeSplitData.json"), SPLITS_B).unwrap();
    let preview = service
        .preview_backup_action(PORT, &wanted.id, BackupAction::Restore)
        .unwrap();
    assert!(preview.safety_backup_will_be_created);
    assert_eq!(
        fs::read(service.library.user_dir(PORT).join("Save/file1.sav")).unwrap(),
        b"wanted save",
        "review must not collect the newer runtime save"
    );
    let approval = service
        .authorize_backup_action(
            PORT,
            &wanted.id,
            BackupAction::Restore,
            &preview.preview_sha256,
        )
        .unwrap();
    // Review binds the newer runtime save without collecting it. One consent
    // collects it into the safety backup and restores the selected snapshot.
    assert_eq!(
        fs::read(active.path.join("Save/file1.sav")).unwrap(),
        b"newest save"
    );
    assert_eq!(
        fs::read(wanted.path.join("data/Save/file1.sav")).unwrap(),
        b"wanted save"
    );
    let restored = service
        .restore_backup(PORT, &wanted.id, &approval.token)
        .unwrap();
    assert_eq!(
        fs::read(active.path.join("SoHTimeSplitData.json")).unwrap(),
        SPLITS_A
    );
    assert_eq!(
        fs::read(service.library.user_dir(PORT).join("SoHTimeSplitData.json")).unwrap(),
        SPLITS_A
    );
    assert_eq!(
        fs::read(
            restored
                .safety_backup
                .as_ref()
                .unwrap()
                .path
                .join("data/SoHTimeSplitData.json")
        )
        .unwrap(),
        SPLITS_B
    );
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
    fs::write(active.path.join("SoHTimeSplitData.json"), SPLITS_A).unwrap();
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
    assert_eq!(
        fs::read(staged.path.join("SoHTimeSplitData.json")).unwrap(),
        SPLITS_A
    );
    fs::write(staged.path.join("SoHTimeSplitData.json"), SPLITS_B).unwrap();
    service.rollback(PORT).unwrap();
    assert_eq!(
        fs::read(active.path.join("SoHTimeSplitData.json")).unwrap(),
        SPLITS_B
    );
    assert_eq!(
        fs::read(service.library.user_dir(PORT).join("SoHTimeSplitData.json")).unwrap(),
        SPLITS_B
    );
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

#[test]
fn shipwright_file_shaped_directories_hold_assessment_and_mutation() {
    for (relative, canonical) in [
        ("SoHTimeSplitData.json", false),
        ("logs/Ship of Harkinian.log", false),
        ("SoHTimeSplitData.json", true),
    ] {
        let (_temporary, service, active, _) = fixture();
        game_write(&active, b"preserved progress");
        let root = if canonical {
            service.library.user_dir(PORT)
        } else {
            active.path.clone()
        };
        let directory = root.join(relative);
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("evil.dll"), b"not an admitted data file").unwrap();
        assert!(service.installed_mutability_port(&active).is_err());
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
            fs::read(directory.join("evil.dll")).unwrap(),
            b"not an admitted data file"
        );
        assert_eq!(
            fs::read(active.path.join("Save/file1.sav")).unwrap(),
            b"preserved progress"
        );
    }
}

#[test]
fn shipwright_frozen_import_refuses_directories_named_as_compatibility_files() {
    for relative in ["SoHTimeSplitData.json", "logs/Ship of Harkinian.log"] {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("original")).unwrap();
        let catalog = Catalog::embedded().unwrap();
        let qualification =
            InstallQualification::from_catalog(&catalog, PORT, Platform::WindowsX86_64).unwrap();
        let active = register(&library, &qualification, "original", true);
        game_write(&active, b"original progress");
        let directory = active.path.join(relative);
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("evil.dll"), b"not a mutable leaf").unwrap();
        let manifest = fs::read(active.path.join(".portcove-manifest.json")).unwrap();
        let metadata = temporary.path().join("metadata.json");
        PortcoveService::new(library.clone())
            .unwrap()
            .write_library_metadata(&metadata)
            .unwrap();
        let destination = temporary.path().join("refused");
        let plan =
            PortcoveService::plan_library_import(&metadata, library.root(), &destination).unwrap();
        let error = PortcoveService::import_library(
            &metadata,
            library.root(),
            &destination,
            &plan.plan_sha256,
        )
        .unwrap_err();
        assert!(error.message.contains("not a regular file"), "{error:?}");
        assert!(
            Library::open(&destination).is_err(),
            "refused import must keep its open gate closed"
        );
        assert_eq!(
            fs::read(directory.join("evil.dll")).unwrap(),
            b"not a mutable leaf"
        );
        assert_eq!(
            fs::read(active.path.join(".portcove-manifest.json")).unwrap(),
            manifest
        );
    }
}

#[test]
fn shipwright_runtime_file_hard_links_hold_without_reading_or_collecting_aliases() {
    for (relative, canonical) in [
        ("SoHTimeSplitData.json", false),
        ("logs/Ship of Harkinian.log", false),
        ("SoHTimeSplitData.json", true),
    ] {
        let (temporary, service, active, _) = fixture();
        game_write(&active, b"owned progress");
        let witness = temporary.path().join("outside.json");
        fs::write(&witness, b"external witness").unwrap();
        let root = if canonical {
            service.library.user_dir(PORT)
        } else {
            active.path.clone()
        };
        let link = root.join(relative);
        fs::create_dir_all(link.parent().unwrap()).unwrap();
        fs::hard_link(&witness, &link).unwrap();
        assert!(service.installed_mutability_port(&active).is_err());
        assert!(service.create_backup(PORT).is_err());
        assert!(service.prepare_launch(PORT, None).is_err());
        assert_eq!(fs::read(&witness).unwrap(), b"external witness");
        assert_eq!(
            fs::read(active.path.join("Save/file1.sav")).unwrap(),
            b"owned progress"
        );
    }
}

#[test]
fn shipwright_runtime_file_junctions_hold_in_working_and_canonical_roots() {
    for (relative, canonical) in [
        ("logs", false),
        ("SoHTimeSplitData.json", false),
        ("SoHTimeSplitData.json", true),
    ] {
        let (temporary, service, active, _) = fixture();
        game_write(&active, b"owned progress");
        let outside = temporary.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("Ship of Harkinian.log"), b"external witness").unwrap();
        let root = if canonical {
            service.library.user_dir(PORT)
        } else {
            active.path.clone()
        };
        let link = root.join(relative);
        fs::create_dir_all(link.parent().unwrap()).unwrap();
        super::tests::create_adoption_test_junction(&outside, &link);
        assert!(service.installed_mutability_port(&active).is_err());
        assert!(service.create_backup(PORT).is_err());
        assert!(service.prepare_launch(PORT, None).is_err());
        assert_eq!(
            fs::read(outside.join("Ship of Harkinian.log")).unwrap(),
            b"external witness"
        );
        assert_eq!(
            fs::read(active.path.join("Save/file1.sav")).unwrap(),
            b"owned progress"
        );
    }
}

#[test]
fn shipwright_descriptive_catalog_changes_keep_retained_save_correction_for_backup() {
    let (_temporary, mut service, active, _) = fixture();
    let manifest = fs::read(active.path.join(".portcove-manifest.json")).unwrap();
    let engine = fs::read(active.path.join("engine.dll")).unwrap();
    let executable = fs::read(active.path.join("soh.exe")).unwrap();
    let mut current = service.catalog.authoritative_document();
    let port = current
        .ports
        .iter_mut()
        .find(|port| port.id == PORT)
        .unwrap();
    port.support_tier = if port.support_tier == crate::SupportTier::Stable {
        crate::SupportTier::Rolling
    } else {
        crate::SupportTier::Stable
    };
    port.name = "New descriptive name".into();
    port.summary = "Corrected summary".into();
    port.project_url = "https://example.invalid/shipwright".into();
    port.automated_tested_platforms = vec![Platform::WindowsX86_64];
    port.manually_validated_platforms = vec![Platform::WindowsX86_64];
    port.upstream_status = crate::UpstreamStatus::Retired;
    service.replace_catalog_for_test(
        Catalog::from_json(&serde_json::to_string(&current).unwrap()).unwrap(),
    );
    assert_ne!(
        service.catalog.port(PORT).unwrap().support_tier,
        service.installed_port(&active).unwrap().support_tier,
    );
    game_write(&active, b"runtime save after catalog description changed");
    fs::write(active.path.join("SoHTimeSplitData.json"), SPLITS_A).unwrap();
    let interpreted = service.installed_mutability_port(&active).unwrap();
    assert!(interpreted.persistent_paths.contains(&"Save".into()));
    let backup = service.create_backup(PORT).unwrap();
    assert_eq!(
        fs::read(backup.path.join("data/Save/file1.sav")).unwrap(),
        b"runtime save after catalog description changed"
    );
    assert_eq!(
        fs::read(backup.path.join("data/SoHTimeSplitData.json")).unwrap(),
        SPLITS_A
    );
    assert_eq!(
        fs::read(active.path.join("Save/file1.sav")).unwrap(),
        b"runtime save after catalog description changed"
    );
    assert_eq!(
        fs::read(active.path.join(".portcove-manifest.json")).unwrap(),
        manifest
    );
    assert_eq!(fs::read(active.path.join("engine.dll")).unwrap(), engine);
    assert_eq!(fs::read(active.path.join("soh.exe")).unwrap(), executable);
    assert!(
        !service
            .installed_port(&active)
            .unwrap()
            .persistent_paths
            .contains(&"Save".into())
    );
}

#[test]
fn optional_current_settings_preserve_only_the_retained_artifact_save_correction() {
    for other_operational_drift in [false, true] {
        let (_temporary, mut service, active, _) = fixture();
        let manifest = fs::read(active.path.join(".portcove-manifest.json")).unwrap();
        let executable = fs::read(active.path.join("soh.exe")).unwrap();
        let engine = fs::read(active.path.join("engine.dll")).unwrap();
        assert!(
            service
                .installed_port(&active)
                .unwrap()
                .game_settings
                .is_none()
        );
        let mut current = service.catalog.authoritative_document();
        let port = current
            .ports
            .iter_mut()
            .find(|port| port.id == PORT)
            .unwrap();
        port.game_settings = Catalog::embedded()
            .unwrap()
            .port(PORT)
            .unwrap()
            .game_settings
            .clone();
        assert!(port.game_settings.is_some());
        port.persistent_paths.push("current-only-unreviewed".into());
        if other_operational_drift {
            port.launch_arguments.push("--unreviewed".into());
        }
        service.replace_catalog_for_test(
            Catalog::from_json(&serde_json::to_string(&current).unwrap()).unwrap(),
        );
        game_write(
            &active,
            b"runtime progress after optional settings appeared",
        );
        fs::write(active.path.join("SoHTimeSplitData.json"), SPLITS_A).unwrap();
        let interpreted = service.installed_mutability_port(&active).unwrap();
        assert!(interpreted.game_settings.is_none());
        assert!(
            !interpreted
                .persistent_paths
                .contains(&"current-only-unreviewed".into())
        );
        assert_eq!(
            interpreted.persistent_paths.contains(&"Save".into()),
            !other_operational_drift
        );
        if !other_operational_drift {
            assert!(
                interpreted
                    .runtime_mutable_paths
                    .contains(&"logs/Ship of Harkinian.log".into())
            );
            let backup = service.create_backup(PORT).unwrap();
            assert_eq!(
                fs::read(backup.path.join("data/Save/file1.sav")).unwrap(),
                b"runtime progress after optional settings appeared"
            );
            assert_eq!(
                fs::read(backup.path.join("data/SoHTimeSplitData.json")).unwrap(),
                SPLITS_A
            );
        } else {
            let spec = service.prepare_launch(PORT, None).unwrap();
            assert!(!spec.arguments.contains(&"--unreviewed".into()));
            assert!(!service.library.user_dir(PORT).join("Save").exists());
        }
        assert_eq!(
            fs::read(active.path.join(".portcove-manifest.json")).unwrap(),
            manifest
        );
        assert_eq!(fs::read(active.path.join("soh.exe")).unwrap(), executable);
        assert_eq!(fs::read(active.path.join("engine.dll")).unwrap(), engine);
    }
}
