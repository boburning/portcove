use std::{
    fs,
    sync::{Arc, Mutex},
};

use super::*;
use crate::{
    Catalog, Library, Platform, PortDefinition, ReleaseAsset, ReleaseChannel, ReleaseProvider,
    ResolvedRelease,
};

const PORT: &str = "star-wars-x-wing-openxw";

struct Provider(Mutex<ResolvedRelease>);

#[async_trait::async_trait]
impl ReleaseProvider for Provider {
    async fn resolve(
        &self,
        _: &PortDefinition,
        channel: ReleaseChannel,
        platform: Platform,
    ) -> Result<ResolvedRelease> {
        assert_eq!(channel, ReleaseChannel::Stable);
        assert_eq!(platform, Platform::LinuxX86_64);
        Ok(self.0.lock().unwrap().clone())
    }
}

fn release(version: &str) -> (ResolvedRelease, crate::test_http::HttpServer) {
    let mut tar = tar::Builder::new(Vec::new());
    let mut header = tar::Header::new_ustar();
    let executable = format!("#!/bin/sh\n# Inert fixture {version}\n");
    header.set_mode(0o755);
    header.set_size(executable.len() as u64);
    tar.append_data(
        &mut header,
        format!("player-{version}/OpenXW"),
        executable.as_bytes(),
    )
    .unwrap();
    for (path, mode) in [
        ("lib/libavcodec.so.62", 0o755),
        ("lib/libavformat.so.62", 0o755),
        ("lib/libavutil.so.60", 0o755),
        ("lib/libspeexdsp.so.1", 0o755),
        ("lib/libswresample.so.6", 0o755),
        ("licenses/fixture.txt", 0o644),
        ("resources/fixture.txt", 0o644),
        ("shaders/fixture.txt", 0o644),
        ("share/fixture.txt", 0o644),
    ] {
        header.set_mode(mode);
        header.set_size(1);
        tar.append_data(&mut header, format!("player-{version}/{path}"), &b"x"[..])
            .unwrap();
    }
    let payload = crate::archive::encode_xz_fixture(&tar.into_inner().unwrap());
    let asset_name = format!("openxw-{version}-linux-x86_64-release.tar.xz");
    let size = payload.len() as u64;
    let digest = crate::signed_catalog::digest(&payload);
    let mut response =
        format!("HTTP/1.1 200 OK\r\nContent-Length: {size}\r\nConnection: close\r\n\r\n")
            .into_bytes();
    response.extend(payload);
    let (origin, _, server) = crate::test_http::serve_http_bytes(vec![response]);
    (
        ResolvedRelease {
            version: version.into(),
            channel: ReleaseChannel::Stable,
            published_at: None,
            asset: ReleaseAsset {
                url: format!("{origin}/{asset_name}"),
                name: asset_name,
                size,
                sha256: digest,
            },
        },
        server,
    )
}

#[tokio::test]
async fn native_linux_tar_xz_managed_lifecycle_preserves_declared_and_unclaimed_data() {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let (first_release, first_server) = release("1.0.0");
    let provider = Arc::new(Provider(Mutex::new(first_release.clone())));
    let mut service = PortcoveService::with_provider(library, provider.clone()).unwrap();
    let catalog = Catalog::from_json(
        &serde_json::json!({
            "schema_version": 3,
            "source_catalog": {
                "evidence": [], "identities": [], "contracts": [], "validators": []
            },
            "ports": [service.catalog.port(PORT).unwrap()]
        })
        .to_string(),
    )
    .unwrap();
    service.replace_catalog_for_test(catalog);
    let review = service.plan_game_install(PORT).await.unwrap();
    let stale = service
        .authorize_game_install(PORT, &review.plan_sha256)
        .await
        .unwrap();
    provider.0.lock().unwrap().version = "0.9.0".into();
    assert_eq!(
        service
            .apply_game_install(PORT, &stale.token, |_| {})
            .await
            .unwrap_err()
            .code,
        crate::ErrorCode::Conflict
    );
    *provider.0.lock().unwrap() = first_release;
    let review = service.plan_game_install(PORT).await.unwrap();
    let authorization = service
        .authorize_game_install(PORT, &review.plan_sha256)
        .await
        .unwrap();
    let first = service
        .apply_game_install(PORT, &authorization.token, |_| {})
        .await
        .unwrap();
    first_server.join().unwrap();
    let program = first.path.join(&first.selected_executable);
    assert!(crate::permissions::executable_intent(&program).unwrap());
    let local = program.parent().unwrap().join("config.yaml");
    service.prepare_launch(PORT, None).unwrap();
    fs::write(&local, b"fixture player settings").unwrap();
    let backup = service.create_backup(PORT).unwrap();
    fs::write(&local, b"changed after backup").unwrap();
    let action = crate::BackupAction::Restore;
    let preview = service
        .preview_backup_action(PORT, &backup.id, action)
        .unwrap();
    let authorization = service
        .authorize_backup_action(PORT, &backup.id, action, &preview.preview_sha256)
        .unwrap();
    service
        .restore_backup(PORT, &backup.id, &authorization.token)
        .unwrap();
    assert_eq!(fs::read(&local).unwrap(), b"fixture player settings");

    let (second_release, second_server) = release("2.0.0");
    *provider.0.lock().unwrap() = second_release;
    let review = service.plan_game_update_acquisition(PORT).await.unwrap();
    let authorization = service
        .authorize_game_update_acquisition(PORT, &review.plan_sha256)
        .await
        .unwrap();
    service
        .acquire_game_update(PORT, &authorization.token, |_| {})
        .await
        .unwrap();
    second_server.join().unwrap();
    let review = service.plan_game_update(PORT, true).await.unwrap();
    let authorization = service
        .authorize_game_update(PORT, true, &review.plan_sha256)
        .await
        .unwrap();
    let second = service
        .apply_game_update(PORT, true, &authorization.token, |_| {})
        .await
        .unwrap();
    assert_ne!(first.artifact.sha256, second.artifact.sha256);
    let second_program = second.path.join(&second.selected_executable);
    assert_eq!(
        fs::read(second_program.parent().unwrap().join("config.yaml")).unwrap(),
        b"fixture player settings"
    );
    assert_eq!(service.rollback(PORT).unwrap().id, first.id);
    assert!(backup.path.is_dir());

    // An unrecognized program still holds removal (#5359 Tier 1).
    let unknown = program.parent().unwrap().join("fallback-pilot.so");
    fs::write(&unknown, b"unclaimed library").unwrap();
    assert!(service.preview_removal(PORT).is_err());
    assert_eq!(fs::read(&unknown).unwrap(), b"unclaimed library");
    assert_eq!(service.status(PORT).unwrap().active.unwrap().id, first.id);
    // An unrecognized data file does not; removal backs it up first.
    fs::remove_file(&unknown).unwrap();
    let pilot = program.parent().unwrap().join("fallback-pilot.plt");
    fs::write(&pilot, b"unclaimed pilot").unwrap();
    let preview = service.preview_removal(PORT).unwrap();
    let consent = service
        .authorize_removal(PORT, &preview.preview_sha256)
        .unwrap();
    service.remove(PORT, &consent.token).unwrap();
    assert!(!first.path.exists());
    let relative = pilot.strip_prefix(&first.path).unwrap();
    let kept = service
        .list_backups(PORT)
        .unwrap()
        .backups
        .into_iter()
        .map(|record| unknown_area(&record, &first).join(relative))
        .find(|path| path.is_file())
        .expect("removal safety backup keeps the unknown file");
    assert_eq!(fs::read(kept).unwrap(), b"unclaimed pilot");
}

fn service(library: Library, provider: Arc<Provider>) -> PortcoveService {
    let mut service = PortcoveService::with_provider(library, provider).unwrap();
    let catalog = Catalog::from_json(
        &serde_json::json!({
            "schema_version": 3,
            "source_catalog": {
                "evidence": [], "identities": [], "contracts": [], "validators": []
            },
            "ports": [service.catalog.port(PORT).unwrap()]
        })
        .to_string(),
    )
    .unwrap();
    service.replace_catalog_for_test(catalog);
    service
}

async fn install(service: &PortcoveService) -> InstallRecord {
    let review = service.plan_game_install(PORT).await.unwrap();
    let authorization = service
        .authorize_game_install(PORT, &review.plan_sha256)
        .await
        .unwrap();
    service
        .apply_game_install(PORT, &authorization.token, |_| {})
        .await
        .unwrap()
}

async fn update(service: &PortcoveService) -> Result<InstallRecord> {
    let review = service.plan_game_update_acquisition(PORT).await?;
    let authorization = service
        .authorize_game_update_acquisition(PORT, &review.plan_sha256)
        .await?;
    service
        .acquire_game_update(PORT, &authorization.token, |_| {})
        .await?;
    let review = service.plan_game_update(PORT, true).await?;
    let authorization = service
        .authorize_game_update(PORT, true, &review.plan_sha256)
        .await?;
    service
        .apply_game_update(PORT, true, &authorization.token, |_| {})
        .await
}

fn unknown_area(backup: &crate::BackupRecord, install: &InstallRecord) -> std::path::PathBuf {
    backup.path.join("unknown-files").join(&install.id)
}

/// #5359 Tier 1: a settings file the game writes beside itself no longer
/// holds update, rollback, removal or backup, and backups keep it apart.
#[tokio::test]
async fn harmless_unknown_files_do_not_hold_and_are_backed_up_separately() {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let (first_release, first_server) = release("1.0.0");
    let provider = Arc::new(Provider(Mutex::new(first_release)));
    let service = service(library.clone(), provider.clone());
    let first = install(&service).await;
    first_server.join().unwrap();
    service.prepare_launch(PORT, None).unwrap();
    let folder = first.path.join(&first.selected_executable);
    let folder = folder.parent().unwrap();
    let relative = folder.strip_prefix(&first.path).unwrap().to_path_buf();
    fs::write(folder.join("config.yaml"), b"declared settings").unwrap();
    fs::write(folder.join("easy-access.ini"), b"lives=9").unwrap();
    fs::create_dir_all(folder.join("logs")).unwrap();
    fs::write(folder.join("logs/replay.txt"), b"replay").unwrap();

    let report = service.verify(PORT).unwrap();
    assert!(!report.valid, "an exact match still excludes unknown files");
    assert!(!report.has_hazards(), "{:?}", report.failures);
    assert_eq!(report.unknown_file_count, 2);
    let named = |name: &str| format!("{}/{name}", relative.display());
    assert_eq!(
        report.unknown_files,
        [named("easy-access.ini"), named("logs/replay.txt")]
    );
    // Launch trust is unchanged: it still requires an exact match.
    assert!(service.prepare_launch(PORT, None).is_err());

    let backup = service.create_backup(PORT).unwrap();
    let area = unknown_area(&backup, &first).join(&relative);
    assert_eq!(fs::read(area.join("easy-access.ini")).unwrap(), b"lives=9");
    assert_eq!(fs::read(area.join("logs/replay.txt")).unwrap(), b"replay");
    assert_eq!(
        fs::read(backup.path.join("data/config.yaml")).unwrap(),
        b"declared settings"
    );
    let manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(backup.path.join("backup.json")).unwrap()).unwrap();
    assert_eq!(manifest["unknown_files_v1"]["file_count"], 2);
    assert_eq!(
        manifest["file_count"], 1,
        "declared data count is unchanged"
    );

    let (second_release, second_server) = release("2.0.0");
    *provider.0.lock().unwrap() = second_release;
    let second = update(&service).await.unwrap();
    second_server.join().unwrap();
    assert_ne!(second.id, first.id);
    // Tier 1 carries nothing: the unknown file stays in the old version.
    assert_eq!(
        fs::read(folder.join("easy-access.ini")).unwrap(),
        b"lives=9"
    );
    let second_folder = second.path.join(&second.selected_executable);
    let second_folder = second_folder.parent().unwrap();
    assert!(!second_folder.join("easy-access.ini").exists());
    assert_eq!(
        fs::read(second_folder.join("config.yaml")).unwrap(),
        b"declared settings"
    );

    assert_eq!(service.rollback(PORT).unwrap().id, first.id);

    // Restore publishes only declared data; the unknown area stays put.
    fs::write(folder.join("config.yaml"), b"changed after backup").unwrap();
    let action = crate::BackupAction::Restore;
    let preview = service
        .preview_backup_action(PORT, &backup.id, action)
        .unwrap();
    let authorization = service
        .authorize_backup_action(PORT, &backup.id, action, &preview.preview_sha256)
        .unwrap();
    service
        .restore_backup(PORT, &backup.id, &authorization.token)
        .unwrap();
    assert_eq!(
        fs::read(folder.join("config.yaml")).unwrap(),
        b"declared settings"
    );
    assert!(!library.user_dir(PORT).join("easy-access.ini").exists());
    assert!(!library.user_dir(PORT).join("logs").exists());
    assert_eq!(
        fs::read(folder.join("easy-access.ini")).unwrap(),
        b"lives=9"
    );

    let before = service.list_backups(PORT).unwrap().backups;
    let preview = service.preview_removal(PORT).unwrap();
    let consent = service
        .authorize_removal(PORT, &preview.preview_sha256)
        .unwrap();
    service.remove(PORT, &consent.token).unwrap();
    assert!(!first.path.exists() && !second.path.exists());
    let after = service.list_backups(PORT).unwrap().backups;
    assert_eq!(after.len(), before.len() + 1, "one removal safety backup");
    let safety = after
        .iter()
        .find(|record| before.iter().all(|old| old.id != record.id))
        .unwrap();
    assert!(safety.automatic.is_none());
    let area = unknown_area(safety, &first).join(&relative);
    assert_eq!(fs::read(area.join("easy-access.ini")).unwrap(), b"lives=9");
    assert_eq!(fs::read(area.join("logs/replay.txt")).unwrap(), b"replay");
    assert!(!unknown_area(safety, &second).exists());
}

#[tokio::test]
async fn removal_without_unknown_files_takes_no_extra_backup() {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let (first_release, first_server) = release("1.0.0");
    let service = service(library, Arc::new(Provider(Mutex::new(first_release))));
    install(&service).await;
    first_server.join().unwrap();
    let preview = service.preview_removal(PORT).unwrap();
    let consent = service
        .authorize_removal(PORT, &preview.preview_sha256)
        .unwrap();
    service.remove(PORT, &consent.token).unwrap();
    assert!(service.list_backups(PORT).unwrap().backups.is_empty());
}

#[tokio::test]
async fn unknown_programs_libraries_links_and_changed_files_still_hold() {
    for case in [
        "helper.exe",
        "tools/setup.ps1",
        "plugin.dll",
        "lib/libmod.so.1",
        "mode-bit",
        "link",
        "changed",
        "missing",
    ] {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let (first_release, first_server) = release("1.0.0");
        let provider = Arc::new(Provider(Mutex::new(first_release)));
        let service = service(library, provider.clone());
        let first = install(&service).await;
        first_server.join().unwrap();
        service.prepare_launch(PORT, None).unwrap();
        let (second_release, second_server) = release("2.0.0");
        *provider.0.lock().unwrap() = second_release;
        let second = update(&service).await.unwrap();
        second_server.join().unwrap();
        service.prepare_launch(PORT, None).unwrap();
        let hazard = |install: &InstallRecord| {
            let program = install.path.join(&install.selected_executable);
            let root = program.parent().unwrap();
            // A harmless file beside the hazard must not change the outcome.
            fs::write(root.join("easy-access.ini"), b"lives=9").unwrap();
            match case {
                "changed" => fs::write(root.join("resources/fixture.txt"), b"edited").unwrap(),
                "missing" => fs::remove_file(root.join("resources/fixture.txt")).unwrap(),
                "link" => std::os::unix::fs::symlink(
                    root.join("resources/fixture.txt"),
                    root.join("settings-link.ini"),
                )
                .unwrap(),
                "mode-bit" => {
                    use std::os::unix::fs::PermissionsExt;
                    let path = root.join("run-me");
                    fs::write(&path, b"#!/bin/true").unwrap();
                    fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
                }
                name => {
                    let path = root.join(name);
                    fs::create_dir_all(path.parent().unwrap()).unwrap();
                    fs::write(path, b"unreviewed code").unwrap();
                }
            }
        };
        hazard(&first);
        assert!(service.rollback(PORT).is_err(), "{case}: rollback");
        assert!(service.preview_removal(PORT).is_err(), "{case}: removal");
        hazard(&second);
        assert!(service.create_backup(PORT).is_err(), "{case}: backup");
        assert!(
            service.collect_active_user_data_if_launched(PORT).is_err(),
            "{case}: collection"
        );
        let (third_release, _third_server) = release("3.0.0");
        *provider.0.lock().unwrap() = third_release;
        assert!(update(&service).await.is_err(), "{case}: update");
        assert_eq!(service.status(PORT).unwrap().active.unwrap().id, second.id);
        if case != "link" {
            let report = service.verify(PORT).unwrap();
            assert!(report.has_hazards(), "{case}: {report:?}");
            assert_eq!(report.unknown_file_count, 1, "{case}: {report:?}");
        }
    }
}

#[tokio::test]
async fn unknown_files_past_a_cap_hold_instead_of_truncating() {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let (first_release, first_server) = release("1.0.0");
    let provider = Arc::new(Provider(Mutex::new(first_release)));
    let service = service(library, provider.clone());
    let first = install(&service).await;
    first_server.join().unwrap();
    service.prepare_launch(PORT, None).unwrap();
    // A sparse file reports its full length without using that disk space.
    let oversized = first.path.join("replay.dat");
    fs::File::create(&oversized)
        .unwrap()
        .set_len(super::backups::MAX_UNKNOWN_FILE_BYTES + 1)
        .unwrap();
    for error in [
        service.create_backup(PORT).unwrap_err(),
        service.preview_removal(PORT).unwrap_err(),
        service
            .collect_active_user_data_if_launched(PORT)
            .unwrap_err(),
    ] {
        assert_eq!(error.code, crate::ErrorCode::Conflict);
        assert_eq!(error.details["oversized_unknown_file"], "replay.dat");
    }
    assert!(oversized.is_file());
    fs::remove_file(&oversized).unwrap();
    service.preview_removal(PORT).unwrap();
    service.collect_active_user_data_if_launched(PORT).unwrap();
}
