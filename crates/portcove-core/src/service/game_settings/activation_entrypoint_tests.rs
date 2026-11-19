//! Inert ZIPs and the real staged activation and recovery entry points.

use super::*;
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

fn archive(version: &str, default: &[u8]) -> Vec<u8> {
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes) in [
        ("sopwith.exe", b"inert test executable".as_slice()),
        (FILE, default),
        ("build.txt", version.as_bytes()),
    ] {
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
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let inputs = [
        ("v1.0.0", archive("v1.0.0", OLD)),
        ("v2.0.0", archive("v2.0.0", NEW)),
    ];
    assert_eq!(inputs[0].1, archive("v1.0.0", OLD));
    let hashes = inputs
        .each_ref()
        .map(|(_, bytes)| hex::encode(Sha256::digest(bytes)));
    let mut port = Catalog::embedded().unwrap().port(PORT).unwrap().clone();
    port.persistent_paths = vec![FILE.into(), "progress.sav".into()];
    if partitioned {
        port.adapter = AdapterKind::StagedSourcePortable;
        port.archive_data_compatibility_v1 = Some(crate::ArchiveDataCompatibilityV1 {
            contract_id: "sopwith-settings-fixture".into(),
            shared_paths: port.persistent_paths.clone(),
            build_specific_progress_paths: Vec::new(),
        });
    }
    port.game_settings = Some(serde_json::from_value(serde_json::json!({
        "format_version": 1,
        "releases": inputs.iter().zip(&hashes).map(|((version, _), digest)| serde_json::json!({
            "version":version,"platform":"windows-x86-64","archive_sha256":digest,
            "source_commit":"a".repeat(40),"evidence_urls":["https://example.invalid/inert-fixture"]
        })).collect::<Vec<_>>(),
        "files": [{"id":"preferences","path":FILE,"format":"ini","maximum_bytes":1024,
            "settings":[{"id":"volume","label":"Volume","key":["volume"],
                "value":{"kind":"integer","minimum":0,"maximum":100,"step":1,"default":40}}]}]
    })).unwrap());
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
            crate::archive::extract_archive(
                &archive_path,
                &root,
                &artifact.asset_name,
                artifact.size,
            )
            .unwrap();
            let defaults = crate::game_settings::capture_shipped_defaults(
                &port,
                Platform::WindowsX86_64,
                version,
                digest,
                &root,
            );
            assert!(defaults.contains_key(FILE));
            let qualification =
                InstallQualification::from_catalog(&catalog, PORT, Platform::WindowsX86_64)
                    .unwrap()
                    .with_fixture_shipped_settings_defaults(defaults);
            let (manifest_sha256, selected_executable, runtime) = installer
                .create_manifest(version, PORT, version, &artifact, &qualification, &root)
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
            library.register_install(&install, index == 0).unwrap();
            install
        })
        .collect::<Vec<_>>();
    let [old, staged]: [InstallRecord; 2] = installs.try_into().unwrap();
    let canonical = library.user_dir(PORT);
    fs::create_dir_all(&canonical).unwrap();
    fs::write(canonical.join(FILE), OLD).unwrap();
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
fn staged_activation_recovers_two_exact_fake_package_defaults() {
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
    let fixture = settings_fixture(true);
    let canonical = fixture.library.user_dir(PORT);
    let player = canonical.join(FILE);
    let active = fixture.old.path.join(FILE);
    let mut service = PortcoveService::with_faults(
        fixture.library.clone(),
        Arc::new(InterruptPublishedBackupRestore),
    )
    .unwrap();
    service.replace_catalog_for_test(fixture.catalog.clone());
    crate::archive_data::initialize(fixture.catalog.port(PORT).unwrap(), &canonical).unwrap();
    fs::remove_file(&player).unwrap();
    fs::remove_file(&active).unwrap();
    let backup = service.create_backup(PORT).unwrap();
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
