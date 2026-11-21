//! Inert ZIPs and the real staged activation and recovery entry points.

use super::*;
use crate::game_settings::ShippedDefaultGap;
use crate::operation::{LifecycleFaultInjector, NoLifecycleFaults, SettingsFaultPoint};
use std::io::{Cursor, Write};

const PORT: &str = "fragglet-sdl-sopwith";
const FILE: &str = "settings.ini";
const OLD: &[u8] = b"volume=40\r\n";
const NEW: &[u8] = b"volume=70\r\n";
const PLAYER: &[u8] = b"volume=12\r\n; player's comment\r\n";

struct InterruptRuntimeRename;

impl LifecycleFaultInjector for InterruptRuntimeRename {
    fn check(&self, point: LifecycleFaultPoint) -> Result<()> {
        if point == LifecycleFaultPoint::SettingsBoundary(SettingsFaultPoint::RuntimeMoved) {
            Err(PortcoveError::state("interrupted staged settings fixture"))
        } else {
            Ok(())
        }
    }
}

fn archive(version: &str, default: Option<&[u8]>) -> Vec<u8> {
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes) in [
        ("sopwith.exe", b"inert test executable".as_slice()),
        ("build.txt", version.as_bytes()),
    ]
    .into_iter()
    .chain(default.map(|bytes| (FILE, bytes)))
    {
        zip.start_file(name, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(bytes).unwrap();
    }
    zip.finish().unwrap().into_inner()
}

struct Fixture {
    service: PortcoveService,
    library: Library,
    catalog: Catalog,
    old: InstallRecord,
    staged: InstallRecord,
    _temporary: tempfile::TempDir,
}

fn fixture() -> Fixture {
    settings_fixture(false)
}

fn settings_fixture(partitioned: bool) -> Fixture {
    settings_fixture_with_stage(partitioned, true)
}

fn settings_fixture_with_stage(partitioned: bool, register_staged: bool) -> Fixture {
    settings_fixture_with_player(partitioned, register_staged, true, NEW)
}

fn settings_fixture_with_player(
    partitioned: bool,
    register_staged: bool,
    seed_settings: bool,
    incoming: &[u8],
) -> Fixture {
    settings_fixture_packages(
        partitioned,
        register_staged,
        seed_settings,
        [Some(OLD), Some(incoming)],
    )
}

fn settings_fixture_packages(
    partitioned: bool,
    register_staged: bool,
    seed_settings: bool,
    defaults: [Option<&[u8]>; 2],
) -> Fixture {
    settings_fixture_packages_for_contract(
        partitioned,
        register_staged,
        seed_settings,
        defaults,
        false,
    )
}

fn settings_fixture_packages_for_contract(
    partitioned: bool,
    register_staged: bool,
    seed_settings: bool,
    defaults: [Option<&[u8]>; 2],
    package_only: bool,
) -> Fixture {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let inputs = [
        ("v1.0.0", archive("v1.0.0", defaults[0])),
        ("v2.0.0", archive("v2.0.0", defaults[1])),
    ];
    assert_eq!(inputs[0].1, archive("v1.0.0", defaults[0]));
    let hashes = inputs
        .each_ref()
        .map(|(_, bytes)| hex::encode(Sha256::digest(bytes)));
    let mut port = Catalog::embedded().unwrap().port(PORT).unwrap().clone();
    port.persistent_paths = vec![FILE.into(), "progress.sav".into()];
    port.presentation.as_mut().unwrap().saves_and_settings =
        crate::SavesAndSettingsBehavior::PortcoveManaged;
    if partitioned {
        port.adapter = AdapterKind::StagedSourcePortable;
        port.archive_data_compatibility_v1 = Some(crate::ArchiveDataCompatibilityV1 {
            contract_id: "sopwith-settings-fixture".into(),
            shared_paths: port.persistent_paths.clone(),
            build_specific_progress_paths: Vec::new(),
        });
    }
    if package_only {
        port.adapter = AdapterKind::StagedSourcePortable;
    }
    port.game_settings = Some(serde_json::from_value(serde_json::json!({
        "format_version": if package_only { 2 } else { 1 },
        "releases": inputs.iter().zip(&hashes).map(|((version, _), digest)| serde_json::json!({
            "version":version,"platform":"windows-x86-64","archive_sha256":digest,
            "source_commit":"a".repeat(40),"evidence_urls":["https://example.invalid/inert-fixture"]
        })).collect::<Vec<_>>(),
        "files": [{"id":"preferences","path":FILE,"format":"ini","maximum_bytes":1024,
            "settings":[{"id":"volume","label":"Volume","key":["volume"],
                "value":{"kind":"integer","minimum":0,"maximum":100,"step":1,"default":40}}]}]
    })).unwrap());
    if package_only {
        port.game_settings.as_mut().unwrap().files[0]
            .settings
            .clear();
    }
    let catalog = Catalog::from_json(
        &serde_json::json!({"schema_version":1,"ports":[port.clone()]}).to_string(),
    )
    .unwrap();
    let installer = Installer::new(library.clone()).unwrap();
    let installs = inputs
        .iter()
        .zip(&hashes)
        .enumerate()
        .map(|(index, ((version, bytes), digest))| {
            let archive_path = temporary.path().join(format!("{version}.zip"));
            fs::write(&archive_path, bytes).unwrap();
            let root = library.versions_dir().join(PORT).join(version);
            fs::create_dir_all(&root).unwrap();
            let artifact = crate::ArtifactIdentity {
                asset_name: format!("sopwith-{version}-win64.zip"),
                sha256: digest.clone(),
                size: bytes.len() as u64,
            };
            let downloaded = fs::read(&archive_path).unwrap();
            assert_eq!(downloaded.len() as u64, artifact.size);
            assert_eq!(hex::encode(Sha256::digest(&downloaded)), artifact.sha256);
            crate::archive::extract_archive(
                &archive_path,
                &root,
                &artifact.asset_name,
                artifact.size,
            )
            .unwrap();
            let qualification =
                InstallQualification::from_catalog(&catalog, PORT, Platform::WindowsX86_64)
                    .unwrap();
            let (manifest_sha256, selected_executable, runtime) =
                crate::install::write_downloaded_settings_fixture_manifest(
                    &port,
                    version,
                    &artifact,
                    qualification,
                    &root,
                )
                .unwrap();
            let install = InstallRecord {
                id: (*version).into(),
                port_id: PORT.into(),
                version: (*version).into(),
                path: root,
                channel: ReleaseChannel::Stable,
                installed_at: 1,
                verified: true,
                staged: index == 1,
                artifact,
                runtime,
                manifest_sha256,
                selected_executable,
            };
            let retained = installer
                .retained_settings_defaults(&install)
                .unwrap()
                .unwrap();
            let shipped = retained
                .shipped
                .get(FILE)
                .map(|stock| stock.verified_bytes(&retained.contract.files[0]).unwrap());
            match defaults[index] {
                Some(bytes) if bytes == [0xff] => {
                    assert!(shipped.is_none());
                    assert_eq!(retained.capture_gaps[FILE], ShippedDefaultGap::Malformed);
                }
                Some(bytes) => {
                    assert_eq!(shipped.as_deref(), Some(bytes));
                    assert!(retained.capture_gaps.is_empty());
                }
                None => {
                    assert!(shipped.is_none());
                    assert_eq!(retained.capture_gaps[FILE], ShippedDefaultGap::Omitted);
                }
            }
            if index == 0 || register_staged {
                library.register_install(&install, index == 0).unwrap();
            }
            install
        })
        .collect::<Vec<_>>();
    let [old, staged]: [InstallRecord; 2] = installs.try_into().unwrap();
    let canonical = library.user_dir(PORT);
    fs::create_dir_all(&canonical).unwrap();
    if partitioned {
        // Establish the creating policy while this is still a fresh workspace.
        crate::archive_data::initialize(catalog.port(PORT).unwrap(), &canonical).unwrap();
    }
    if seed_settings {
        fs::write(canonical.join(FILE), OLD).unwrap();
    }
    fs::write(canonical.join("progress.sav"), b"owned saved progress").unwrap();
    fs::write(old.path.join("progress.sav"), b"owned saved progress").unwrap();
    let mut service =
        PortcoveService::with_faults(library.clone(), Arc::new(InterruptRuntimeRename)).unwrap();
    service.replace_catalog_for_test(catalog.clone());
    Fixture {
        _temporary: temporary,
        service,
        library,
        catalog,
        old,
        staged,
    }
}

#[test]
fn a_package_only_staged_source_update_reconciles_an_independent_file() {
    let _integrity = crate::game_settings::windows::MediumIntegrityTest::enter();
    let old = b"[Graphics]\r\nWindowSize=Auto\r\nUnknown=keep\r\n";
    let new = b"[Graphics]\r\nWindowSize=1280x720\r\nUnknown=keep\r\n";
    let fixture =
        settings_fixture_packages_for_contract(false, true, false, [Some(old), Some(new)], true);
    assert!(!fixture.service.get_game_settings(PORT).unwrap().available);
    let error = fixture.service.activate_staged(PORT).unwrap_err();
    assert!(
        error
            .message
            .contains("interrupted staged settings fixture"),
        "{error:?}"
    );

    let mut reopened =
        PortcoveService::with_faults(fixture.library.clone(), Arc::new(NoLifecycleFaults)).unwrap();
    reopened.replace_catalog_for_test(fixture.catalog.clone());
    reopened.recover_pending_operations().unwrap();
    let selected = fixture
        .library
        .status(PORT, ReleaseChannel::Stable)
        .unwrap()
        .active
        .unwrap();
    assert_eq!(selected.id, fixture.staged.id);
    assert_eq!(
        fs::read(fixture.library.user_dir(PORT).join(FILE)).unwrap(),
        new
    );
    assert_eq!(fs::read(selected.path.join(FILE)).unwrap(), new);
    assert_eq!(
        fs::read(fixture.library.user_dir(PORT).join("progress.sav")).unwrap(),
        b"owned saved progress"
    );
}

#[test]
fn staged_activation_recovers_two_exact_fake_package_defaults() {
    let _integrity = crate::game_settings::windows::MediumIntegrityTest::enter();
    let fixture = fixture();
    let store = OperationStore::new(fixture.library.clone());
    let error = fixture.service.activate_staged(PORT).unwrap_err();
    assert!(
        error
            .message
            .contains("interrupted staged settings fixture"),
        "{error}"
    );
    let status = fixture
        .library
        .status(PORT, ReleaseChannel::Stable)
        .unwrap();
    assert_eq!(status.active.unwrap().id, fixture.old.id);
    let journals = store.all().unwrap();
    let journal = journals
        .iter()
        .find(|op| op.settings_activation.is_some())
        .unwrap();
    assert_eq!(journal.phase, LifecyclePhase::PayloadPublished);
    assert!(
        journal
            .last_error
            .as_deref()
            .unwrap()
            .contains("interrupted")
    );

    let mut reopened =
        PortcoveService::with_faults(fixture.library.clone(), Arc::new(NoLifecycleFaults)).unwrap();
    reopened.replace_catalog_for_test(fixture.catalog.clone());
    reopened.recover_pending_operations().unwrap();
    let status = fixture
        .library
        .status(PORT, ReleaseChannel::Stable)
        .unwrap();
    assert_eq!(status.active.unwrap().id, fixture.staged.id);
    assert_eq!(status.previous.unwrap().id, fixture.old.id);
    assert_eq!(
        fs::read(fixture.library.user_dir(PORT).join(FILE)).unwrap(),
        NEW
    );
    assert_eq!(fs::read(fixture.staged.path.join(FILE)).unwrap(), NEW);
    assert_eq!(fs::read(fixture.old.path.join(FILE)).unwrap(), OLD);
    assert_eq!(
        fs::read(fixture.staged.path.join("progress.sav")).unwrap(),
        b"owned saved progress"
    );
    assert!(store.get(&journal.id).unwrap().is_none());
}

#[test]
fn staged_activation_holds_conflict_and_unobserved_deletion_before_projection() {
    let _integrity = crate::game_settings::windows::MediumIntegrityTest::enter();
    for player in [Some(PLAYER), None] {
        let fixture = fixture();
        let canonical = fixture.library.user_dir(PORT).join(FILE);
        let old = fixture.old.path.join(FILE);
        for path in [&canonical, &old] {
            if let Some(bytes) = player {
                fs::write(path, bytes).unwrap()
            } else {
                fs::remove_file(path).unwrap()
            }
        }
        let error = fixture.service.activate_staged(PORT).unwrap_err();
        let reason = if player.is_some() {
            "player-and-default-diverged"
        } else {
            "missing-player-evidence"
        };
        assert_eq!(
            error.details.get("settings_reason").map(String::as_str),
            Some(reason),
            "{error}"
        );
        if player.is_some() {
            let presentation = error.report().presentation;
            assert_eq!(presentation.presentation_key, "settings_defaults_conflict");
            assert!(
                presentation
                    .summary
                    .contains("kept your settings and the new defaults")
            );
            assert!(
                presentation
                    .summary
                    .contains("keep using the installed version")
            );
        }
        assert_eq!(fs::read(&canonical).ok().as_deref(), player);
        assert_eq!(fs::read(&old).ok().as_deref(), player);
        assert_eq!(fs::read(fixture.staged.path.join(FILE)).unwrap(), NEW);
        let status = fixture
            .library
            .status(PORT, ReleaseChannel::Stable)
            .unwrap();
        assert_eq!(status.active.unwrap().id, fixture.old.id);
        assert_eq!(status.staged.unwrap().id, fixture.staged.id);
    }
}

struct InterruptPublishedBackupRestore;

impl LifecycleFaultInjector for InterruptPublishedBackupRestore {
    fn check(&self, point: LifecycleFaultPoint) -> Result<()> {
        if point == LifecycleFaultPoint::RestorePublished {
            Err(PortcoveError::state(
                "interrupted reviewed settings restore",
            ))
        } else {
            Ok(())
        }
    }
}

#[test]
fn reviewed_full_snapshot_records_settings_deletion_only_after_recovered_projection() {
    let _integrity = crate::game_settings::windows::MediumIntegrityTest::enter();
    for partitioned in [false, true] {
        check_reviewed_full_snapshot_deletion(partitioned);
    }
}

fn check_reviewed_full_snapshot_deletion(partitioned: bool) {
    let fixture = settings_fixture(partitioned);
    let canonical = fixture.library.user_dir(PORT);
    let player = canonical.join(FILE);
    let active = fixture.old.path.join(FILE);
    let mut service = PortcoveService::with_faults(
        fixture.library.clone(),
        Arc::new(InterruptPublishedBackupRestore),
    )
    .unwrap();
    service.replace_catalog_for_test(fixture.catalog.clone());
    fs::remove_file(&player).unwrap();
    fs::remove_file(&active).unwrap();
    if partitioned {
        // Project the retained data before taking a backup of this ready archive.
        // Independently seeded files have different timestamps before first projection.
        fs::remove_file(fixture.old.path.join("progress.sav")).unwrap();
        service.restore_retained_user_data_to(&fixture.old).unwrap();
        assert!(crate::service::psx_mod_data::initialized(&fixture.old).unwrap());
        assert!(!fixture.old.path.join(LAUNCH_MARKER).exists());
    }
    let backup = service.create_backup(PORT).unwrap();
    assert_eq!(
        fs::read(backup.path.join("data/progress.sav")).unwrap(),
        b"owned saved progress"
    );
    fs::write(&player, PLAYER).unwrap();
    fs::write(&active, PLAYER).unwrap();
    let preview = service
        .preview_backup_action(PORT, &backup.id, BackupAction::Restore)
        .unwrap();
    let consent = service
        .authorize_backup_action(
            PORT,
            &backup.id,
            BackupAction::Restore,
            &preview.preview_sha256,
        )
        .unwrap();
    let refusal = service
        .restore_backup(PORT, &backup.id, &consent.token)
        .unwrap_err();
    assert!(
        refusal
            .message
            .contains("interrupted reviewed settings restore"),
        "{refusal}"
    );
    assert!(!player.exists());
    assert_eq!(fs::read(&active).unwrap(), PLAYER);
    let connection = fixture.library.connection().unwrap();
    let pending: bool = connection
        .query_row(
            "SELECT pending_id IS NOT NULL FROM settings_restore_deletions",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(pending);

    let mut reopened =
        PortcoveService::with_faults(fixture.library.clone(), Arc::new(NoLifecycleFaults)).unwrap();
    reopened.replace_catalog_for_test(fixture.catalog.clone());
    reopened.recover_pending_operations().unwrap();
    reopened.recover_pending_operations().unwrap();
    assert!(!player.exists());
    assert!(!active.exists());
    let (pending, evidence): (bool, Vec<u8>) = connection
        .query_row(
            "SELECT pending_id IS NOT NULL, evidence FROM settings_restore_deletions",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert!(!pending);
    let evidence: serde_json::Value = serde_json::from_slice(&evidence).unwrap();
    assert_eq!(evidence["file_id"], "preferences");
    assert_eq!(
        evidence["scope"],
        serde_json::json!({
            "kind": if partitioned { "partitioned" } else { "native" },
            "policy_sha256": crate::archive_data::policy_sha256(fixture.catalog.port(PORT).unwrap())
                .unwrap(),
        })
    );
    assert_eq!(
        evidence["install_manifest_sha256"],
        fixture.old.manifest_sha256
    );
    assert_eq!(evidence["shipped_sha256"], hex::encode(Sha256::digest(OLD)));
    assert_eq!(
        evidence["player_sha256"],
        hex::encode(Sha256::digest(PLAYER))
    );
    assert_eq!(
        fs::read(canonical.join("progress.sav")).unwrap(),
        b"owned saved progress"
    );
}

#[test]
fn staged_activation_keeps_reviewed_deletion_and_recovers_only_its_owned_default() {
    let _integrity = crate::game_settings::windows::MediumIntegrityTest::enter();
    let fixture = settings_fixture_with_stage(false, false);
    let canonical = fixture.library.user_dir(PORT).join(FILE);
    let previous = fixture.old.path.join(FILE);
    let incoming = fixture.staged.path.join(FILE);
    fs::remove_file(&canonical).unwrap();
    fs::remove_file(&previous).unwrap();
    let backup = fixture.service.create_backup(PORT).unwrap();
    fs::write(&canonical, PLAYER).unwrap();
    fs::write(&previous, PLAYER).unwrap();
    let preview = fixture
        .service
        .preview_backup_action(PORT, &backup.id, BackupAction::Restore)
        .unwrap();
    let authorization = fixture
        .service
        .authorize_backup_action(
            PORT,
            &backup.id,
            BackupAction::Restore,
            &preview.preview_sha256,
        )
        .unwrap();
    fixture
        .service
        .restore_backup(PORT, &backup.id, &authorization.token)
        .unwrap();
    assert!(!canonical.exists());
    assert!(!previous.exists());
    assert_eq!(fs::read(&incoming).unwrap(), NEW);
    fixture
        .library
        .register_install(&fixture.staged, false)
        .unwrap();

    let store = OperationStore::new(fixture.library.clone());
    let interrupted = fixture.service.activate_staged(PORT).unwrap_err();
    assert!(
        interrupted
            .message
            .contains("interrupted staged settings fixture"),
        "{interrupted}"
    );
    let operation = store
        .all()
        .unwrap()
        .into_iter()
        .find(|item| {
            item.settings_activation
                .as_ref()
                .is_some_and(|settings| settings.deletion.is_some())
        })
        .unwrap();
    assert_eq!(operation.phase, LifecyclePhase::Prepared);
    let (_, quarantine) =
        crate::operation::game_settings::owned_names(&incoming, &operation.id, "runtime").unwrap();
    assert!(!incoming.exists());
    assert_eq!(fs::read(&quarantine).unwrap(), NEW);

    // A concurrent player edit stays untouched and holds this operation.
    fs::write(&canonical, PLAYER).unwrap();
    let mut reopened =
        PortcoveService::with_faults(fixture.library.clone(), Arc::new(NoLifecycleFaults)).unwrap();
    reopened.replace_catalog_for_test(fixture.catalog.clone());
    reopened.recover_pending_operations().unwrap();
    assert_eq!(fs::read(&canonical).unwrap(), PLAYER);
    assert_eq!(fs::read(&quarantine).unwrap(), NEW);
    assert!(store.get(&operation.id).unwrap().is_some());
    assert_eq!(
        fixture
            .library
            .status(PORT, ReleaseChannel::Stable)
            .unwrap()
            .active
            .unwrap()
            .id,
        fixture.old.id
    );

    fs::remove_file(&canonical).unwrap();
    reopened.recover_pending_operations().unwrap();
    reopened.recover_pending_operations().unwrap();
    assert_eq!(
        fixture
            .library
            .status(PORT, ReleaseChannel::Stable)
            .unwrap()
            .active
            .unwrap()
            .id,
        fixture.staged.id
    );
    assert!(store.get(&operation.id).unwrap().is_none());
    for path in [&canonical, &previous, &incoming, &quarantine] {
        assert!(!path.exists(), "{}", path.display());
    }
    let installer = Installer::new(fixture.library.clone()).unwrap();
    let defaults = installer
        .retained_settings_defaults(&fixture.staged)
        .unwrap()
        .unwrap();
    assert_eq!(
        defaults.shipped[FILE]
            .verified_bytes(&defaults.contract.files[0])
            .unwrap(),
        NEW
    );
    let successor_evidence: Vec<u8> = fixture.library.connection().unwrap().query_row(
        "SELECT evidence FROM settings_restore_deletions WHERE install_id=?1 AND pending_id IS NULL",
        [&fixture.staged.id], |row| row.get(0)
    ).unwrap();
    let successor_evidence: serde_json::Value =
        serde_json::from_slice(&successor_evidence).unwrap();
    assert_eq!(
        successor_evidence["install_manifest_sha256"],
        fixture.staged.manifest_sha256
    );
    assert_eq!(
        successor_evidence["shipped_sha256"],
        hex::encode(Sha256::digest(NEW))
    );
    assert!(successor_evidence["predecessor_receipt"].is_string());
}

#[test]
fn fresh_native_activation_uses_exact_package_stock_without_mirrored_seed() {
    let _integrity = crate::game_settings::windows::MediumIntegrityTest::enter();
    let fixture = settings_fixture_with_player(false, true, false, NEW);
    let canonical = fixture.library.user_dir(PORT).join(FILE);
    assert!(!canonical.exists());
    assert!(!fixture.old.path.join(LAUNCH_MARKER).exists());
    assert!(
        fixture
            .library
            .latest_finished_launch_session(PORT)
            .unwrap()
            .is_none()
    );
    let interrupted = fixture.service.activate_staged(PORT).unwrap_err();
    assert!(
        interrupted
            .message
            .contains("interrupted staged settings fixture"),
        "{interrupted}"
    );
    let mut reopened =
        PortcoveService::with_faults(fixture.library.clone(), Arc::new(NoLifecycleFaults)).unwrap();
    reopened.replace_catalog_for_test(fixture.catalog.clone());
    reopened.recover_pending_operations().unwrap();
    assert_eq!(fs::read(canonical).unwrap(), NEW);
    assert_eq!(fs::read(fixture.old.path.join(FILE)).unwrap(), OLD);
    assert_eq!(fs::read(fixture.staged.path.join(FILE)).unwrap(), NEW);
    assert_eq!(
        fixture
            .library
            .status(PORT, ReleaseChannel::Stable)
            .unwrap()
            .active
            .unwrap()
            .id,
        fixture.staged.id
    );
}

fn completed_managed_launch(fixture: &Fixture, bytes: &[u8]) {
    let activity = fixture
        .library
        .begin_activity(
            ActivityOperation::Launch,
            ActivityTargetKind::Port,
            Some(PORT),
        )
        .unwrap();
    let now = Library::now();
    fixture
        .library
        .create_launch_session(&LaunchSessionRecord {
            id: activity.id.clone(),
            port_id: PORT.into(),
            install_id: fixture.old.id.clone(),
            install_root: fixture.old.path.clone(),
            owner_kind: crate::LaunchOwnerKind::Managed,
            supervisor_pid: std::process::id(),
            supervisor_identity: None,
            child_pid: None,
            child_identity: None,
            phase: LaunchSessionPhase::Collecting,
            outcome: None,
            exit_code: None,
            message: None,
            started_at: now,
            updated_at: now,
            finished_at: None,
        })
        .unwrap();
    fs::write(fixture.old.path.join(LAUNCH_MARKER), b"1").unwrap();
    fixture
        .library
        .finish_launch_session(
            &activity.id,
            crate::LaunchSessionOutcome::Succeeded,
            Some(0),
            None,
        )
        .unwrap();
    fs::write(fixture.old.path.join(FILE), bytes).unwrap();
}

#[test]
fn exact_launch_allows_owned_runtime_edit_only_if_defaults_are_compatible() {
    let _integrity = crate::game_settings::windows::MediumIntegrityTest::enter();
    for (incoming, player, merges) in [(OLD, PLAYER, true), (NEW, NEW, true), (NEW, PLAYER, false)]
    {
        let fixture = settings_fixture_with_player(false, true, true, incoming);
        completed_managed_launch(&fixture, player);
        let canonical = fixture.library.user_dir(PORT).join(FILE);
        let interrupted = fixture.service.activate_staged(PORT).unwrap_err();
        if !merges {
            assert_eq!(
                interrupted.details["settings_reason"],
                "player-and-default-diverged"
            );
            assert_eq!(fs::read(canonical).unwrap(), OLD);
            assert_eq!(fs::read(fixture.old.path.join(FILE)).unwrap(), player);
            assert_eq!(fs::read(fixture.staged.path.join(FILE)).unwrap(), incoming);
            continue;
        }
        assert!(
            interrupted
                .message
                .contains("interrupted staged settings fixture"),
            "{interrupted}"
        );
        let mut reopened =
            PortcoveService::with_faults(fixture.library.clone(), Arc::new(NoLifecycleFaults))
                .unwrap();
        reopened.replace_catalog_for_test(fixture.catalog.clone());
        reopened.recover_pending_operations().unwrap();
        assert_eq!(fs::read(canonical).unwrap(), player);
        assert_eq!(fs::read(fixture.old.path.join(FILE)).unwrap(), player);
        assert_eq!(fs::read(fixture.staged.path.join(FILE)).unwrap(), player);
        assert_eq!(
            fixture
                .library
                .status(PORT, ReleaseChannel::Stable)
                .unwrap()
                .active
                .unwrap()
                .id,
            fixture.staged.id
        );
    }
}

#[test]
fn restoring_pre_update_backup_keeps_the_runtime_only_player_edit() {
    let _integrity = crate::game_settings::windows::MediumIntegrityTest::enter();
    let fixture = settings_fixture_with_player(false, true, true, OLD);
    completed_managed_launch(&fixture, PLAYER);
    let canonical = fixture.library.user_dir(PORT).join(FILE);
    assert_eq!(fs::read(&canonical).unwrap(), OLD);
    let mut service =
        PortcoveService::with_faults(fixture.library.clone(), Arc::new(NoLifecycleFaults)).unwrap();
    service.replace_catalog_for_test(fixture.catalog.clone());
    let active = service.activate_staged(PORT).unwrap();
    let backup = service
        .list_backups(PORT)
        .unwrap()
        .backups
        .into_iter()
        .find(|backup| {
            backup.automatic.as_ref().is_some_and(|label| {
                label.operation == crate::VersionChangeKind::Activation
                    && label.from_version.as_deref() == Some(fixture.old.version.as_str())
                    && label.to_version == fixture.staged.version
            })
        })
        .expect("the settings update must retain its ordinary pre-update snapshot");
    assert_eq!(
        fs::read(backup.path.join("data").join(FILE)).unwrap(),
        PLAYER
    );

    fs::write(&canonical, NEW).unwrap();
    fs::write(active.path.join(FILE), NEW).unwrap();
    let review = service
        .preview_backup_action(PORT, &backup.id, BackupAction::Restore)
        .unwrap();
    let authorization = service
        .authorize_backup_action(
            PORT,
            &backup.id,
            BackupAction::Restore,
            &review.preview_sha256,
        )
        .unwrap();
    service
        .restore_backup(PORT, &backup.id, &authorization.token)
        .unwrap();
    assert_eq!(fs::read(&canonical).unwrap(), PLAYER);
    assert_eq!(fs::read(active.path.join(FILE)).unwrap(), PLAYER);
}

#[test]
fn two_verified_omissions_remain_scalar_but_malformed_packages_hold() {
    let _integrity = crate::game_settings::windows::MediumIntegrityTest::enter();
    let omitted = settings_fixture_packages(false, true, false, [None, None]);
    assert!(omitted.service.activate_staged(PORT).is_ok());
    assert!(!omitted.library.user_dir(PORT).join(FILE).exists());

    let missing_baseline = settings_fixture_packages(false, true, false, [None, Some(NEW)]);
    let error = missing_baseline.service.activate_staged(PORT).unwrap_err();
    assert_eq!(error.details["settings_reason"], "missing-verified-default");
    let presentation = error.report().presentation;
    assert_eq!(
        presentation.presentation_key,
        "settings_defaults_unverified"
    );
    assert!(
        presentation
            .summary
            .contains("Keep using the installed version")
    );
    let status = missing_baseline
        .library
        .status(PORT, ReleaseChannel::Stable)
        .unwrap();
    assert_eq!(status.active.unwrap().id, missing_baseline.old.id);
    assert_eq!(status.staged.unwrap().id, missing_baseline.staged.id);
    assert_eq!(
        fs::read(missing_baseline.staged.path.join(FILE)).unwrap(),
        NEW
    );

    let invalid = settings_fixture_packages(false, true, false, [None, Some(&[0xff])]);
    let error = invalid.service.activate_staged(PORT).unwrap_err();
    assert_eq!(
        error.details["settings_reason"],
        "malformed-package-default"
    );
    assert_eq!(
        error.report().presentation.presentation_key,
        "settings_defaults_unverified"
    );
    assert_eq!(fs::read(invalid.staged.path.join(FILE)).unwrap(), [0xff]);
    assert!(!invalid.library.user_dir(PORT).join(FILE).exists());
}
