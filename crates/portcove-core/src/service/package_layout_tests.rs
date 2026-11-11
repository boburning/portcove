//! Production install/update-path fixtures over served packages: reviewed
//! package-layout holds, player-file preservation and automatic snapshots.
//! The archives are inert fixtures, not upstream artifacts or gameplay evidence.
use std::{
    fs,
    io::Write,
    sync::{Arc, Mutex},
};

use super::*;
use crate::{
    Catalog, Library, Platform, PortDefinition, ReleaseAsset, ReleaseChannel, ReleaseProvider,
    ResolvedRelease, ReviewedPackageLayout,
};

const PORT: &str = "star-wars-x-wing-openxw";

struct Provider(Mutex<ResolvedRelease>);

#[async_trait::async_trait]
impl ReleaseProvider for Provider {
    async fn resolve(
        &self,
        _: &PortDefinition,
        _: ReleaseChannel,
        _: Platform,
    ) -> Result<ResolvedRelease> {
        Ok(self.0.lock().unwrap().clone())
    }
}

/// Builds an archive whose single wrapper directory is versioned; each entry is
/// a path inside the wrapper and its Unix mode.
fn release(
    version: &str,
    entries: &[(&str, u32)],
) -> (ResolvedRelease, crate::test_http::HttpServer) {
    archive_release(
        version,
        format!("openxw-{version}-linux-x86_64-release.tar.xz"),
        entries,
    )
}

fn archive_release(
    version: &str,
    asset_name: String,
    entries: &[(&str, u32)],
) -> (ResolvedRelease, crate::test_http::HttpServer) {
    let mut tar = tar::Builder::new(Vec::new());
    for (path, mode) in entries {
        let body = format!("#!/bin/sh\n# Inert fixture {version} {path}\n");
        let mut header = tar::Header::new_ustar();
        header.set_mode(*mode);
        header.set_size(body.len() as u64);
        tar.append_data(
            &mut header,
            format!("player-{version}/{path}"),
            body.as_bytes(),
        )
        .unwrap();
    }
    let tar = tar.into_inner().unwrap();
    let payload = if asset_name.ends_with(".tar.xz") {
        crate::archive::encode_xz_fixture(&tar)
    } else {
        assert!(asset_name.ends_with(".tar.gz"));
        let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        gzip.write_all(&tar).unwrap();
        gzip.finish().unwrap()
    };
    serve_archive(version, asset_name, payload)
}

fn serve_archive(
    version: &str,
    asset_name: String,
    payload: Vec<u8>,
) -> (ResolvedRelease, crate::test_http::HttpServer) {
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

async fn install(service: &PortcoveService, port: &str) -> InstallRecord {
    let review = service.plan_game_install(port).await.unwrap();
    let authorization = service
        .authorize_game_install(port, &review.plan_sha256)
        .await
        .unwrap();
    service
        .apply_game_install(port, &authorization.token, |_| {})
        .await
        .unwrap()
}

async fn acquire(service: &PortcoveService, port: &str) -> String {
    let review = service.plan_game_update_acquisition(port).await.unwrap();
    let authorization = service
        .authorize_game_update_acquisition(port, &review.plan_sha256)
        .await
        .unwrap();
    service
        .acquire_game_update(port, &authorization.token, |_| {})
        .await
        .unwrap()
        .id
}

async fn apply_update(service: &PortcoveService, port: &str) -> Result<InstallRecord> {
    let review = service.plan_game_update(port, true).await.unwrap();
    let authorization = service
        .authorize_game_update(port, true, &review.plan_sha256)
        .await
        .unwrap();
    service
        .apply_game_update(port, true, &authorization.token, |_| {})
        .await
}

fn rsdkv4_release(
    version: &str,
    fixture_byte: u8,
) -> (ResolvedRelease, crate::test_http::HttpServer) {
    let gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    let mut tar = tar::Builder::new(gzip);
    let mut header = tar::Header::new_ustar();
    let mut elf = [0_u8; 48];
    elf[..6].copy_from_slice(b"\x7fELF\x02\x01");
    elf[16..20].copy_from_slice(&[3, 0, 0x3e, 0]);
    elf[47] = fixture_byte;
    header.set_mode(0o755);
    header.set_size(elf.len() as u64);
    tar.append_data(&mut header, "./RSDKv4", elf.as_slice())
        .unwrap();
    let inner = tar.into_inner().unwrap().finish().unwrap();

    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    zip.start_file("linux.tar.gz", zip::write::SimpleFileOptions::default())
        .unwrap();
    zip.write_all(&inner).unwrap();
    serve_archive(
        version,
        "v4-linux.zip".into(),
        zip.finish().unwrap().into_inner(),
    )
}

#[tokio::test]
async fn rsdkv4_nested_linux_packages_keep_each_titles_originals_and_progress() {
    let ids = [
        "sonic-the-hedgehog-2013-mobile-edition-rsdkv4-decompilation",
        "sonic-the-hedgehog-2-2013-mobile-edition-rsdkv4-decompilation",
    ];
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let catalog = Catalog::embedded().unwrap();
    let (initial, initial_server) = rsdkv4_release("1.3.3", 1);
    let provider = Arc::new(Provider(Mutex::new(initial)));
    let mut service = PortcoveService::with_provider(library, provider.clone()).unwrap();
    service.replace_catalog_for_test(catalog.clone());
    let first = install(&service, ids[0]).await;
    initial_server.join().unwrap();

    let (other_release, other_server) = rsdkv4_release("1.3.3", 2);
    *provider.0.lock().unwrap() = other_release;
    let other = install(&service, ids[1]).await;
    other_server.join().unwrap();
    assert_ne!(first.path, other.path);

    let installs = [first, other];
    let originals = ids.map(|id| format!("synthetic original for {id}"));
    let mut progress = ids.map(|id| format!("progress for {id}"));
    for (index, installed) in installs.iter().enumerate() {
        fs::write(installed.path.join("Data.rsdk"), &originals[index]).unwrap();
        fs::write(installed.path.join("UData.bin"), &progress[index]).unwrap();
    }
    for (index, old) in installs.iter().enumerate() {
        let id = ids[index];
        let original = &originals[index];
        let spec = service
            .prepare_launch_for_install(catalog.port(id).unwrap(), old, None, None)
            .unwrap();
        assert_eq!(spec.working_directory, old.path);
        assert_eq!(spec.executable, old.path.join("RSDKv4"));
        assert!(crate::permissions::executable_intent(&spec.executable).unwrap());

        let (next, next_server) = rsdkv4_release("1.3.4", 3 + index as u8);
        *provider.0.lock().unwrap() = next;
        acquire(&service, id).await;
        next_server.join().unwrap();
        let updated = apply_update(&service, id).await.unwrap();
        assert_eq!(updated.version, "1.3.4");
        assert_eq!(
            fs::read(updated.path.join("Data.rsdk")).unwrap(),
            original.as_bytes()
        );
        assert_eq!(
            fs::read(updated.path.join("UData.bin")).unwrap(),
            progress[index].as_bytes()
        );

        progress[index] = format!("later progress for {id}");
        fs::write(updated.path.join("UData.bin"), &progress[index]).unwrap();
        let rolled_back = service.rollback(id).unwrap();
        assert_eq!(rolled_back.id, old.id);
        assert_eq!(
            fs::read(rolled_back.path.join("Data.rsdk")).unwrap(),
            original.as_bytes()
        );
        assert_eq!(
            fs::read(rolled_back.path.join("UData.bin")).unwrap(),
            progress[index].as_bytes()
        );
        let other_index = 1 - index;
        let other_root = &installs[other_index].path;
        assert_eq!(
            fs::read(other_root.join("Data.rsdk")).unwrap(),
            originals[other_index].as_bytes()
        );
        assert_eq!(
            fs::read(other_root.join("UData.bin")).unwrap(),
            progress[other_index].as_bytes()
        );
    }
}

#[tokio::test]
async fn a_reviewed_layout_admits_compatible_releases_and_holds_drifted_ones() {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let (first, first_server) = release("1.0.0", &[("OpenXW", 0o755), ("config.yaml", 0o644)]);
    let provider = Arc::new(Provider(Mutex::new(first)));
    let mut service = PortcoveService::with_provider(library, provider.clone()).unwrap();
    let mut port = service.catalog.port(PORT).unwrap().clone();
    port.reviewed_package_layouts.insert(
        Platform::LinuxX86_64,
        ReviewedPackageLayout {
            directories: vec![],
            executables: vec!["openxw".to_owned()],
        },
    );
    service.replace_catalog_for_test(
        Catalog::from_json(
            &serde_json::json!({
                "schema_version": 3,
                "source_catalog": {
                    "evidence": [], "identities": [], "contracts": [], "validators": []
                },
                "ports": [port]
            })
            .to_string(),
        )
        .unwrap(),
    );

    // N: the reviewed layout installs.
    let installed = install(&service, PORT).await;
    first_server.join().unwrap();
    assert_eq!(installed.version, "1.0.0");

    // N+1 compatible: a renamed wrapper, new data and a new non-executable file
    // proceed as an ordinary update.
    let (compatible, compatible_server) = release(
        "2.0.0",
        &[
            ("OpenXW", 0o755),
            ("config.yaml", 0o644),
            ("CHANGELOG.md", 0o644),
        ],
    );
    *provider.0.lock().unwrap() = compatible;
    let acquired = acquire(&service, PORT).await;
    compatible_server.join().unwrap();
    let updated = apply_update(&service, PORT).await.unwrap();
    assert_eq!(updated.version, "2.0.0");
    // A consumed acquisition is discarded before the next release is acquired.
    let _ = service.discard_game_update_acquisition(PORT, &acquired);

    // N+1 drifted: a new updater program is held with a player-facing reason and
    // the active copy is left alone.
    let (drifted, drifted_server) = release(
        "3.0.0",
        &[
            ("OpenXW", 0o755),
            ("config.yaml", 0o644),
            ("Updater", 0o755),
        ],
    );
    *provider.0.lock().unwrap() = drifted;
    acquire(&service, PORT).await;
    drifted_server.join().unwrap();
    let refusal = apply_update(&service, PORT).await.unwrap_err();
    assert_eq!(refusal.code, crate::ErrorCode::Unsupported);
    assert!(
        refusal.message.contains("new programs: updater"),
        "{}",
        refusal.message
    );
    assert!(
        refusal
            .message
            .contains("Nothing on your computer was changed"),
        "{}",
        refusal.message
    );
    let status = service.status(PORT).unwrap();
    assert_eq!(status.active.unwrap().version, "2.0.0");
}

#[tokio::test]
async fn nhl94_linux_update_and_rollback_preserve_default_player_files() {
    const NHL: &str = "nhl-94-genesis-ninety-four";
    const DATA: [&str; 6] = [
        "out/nhl94.srm",
        "rosters/player.txt",
        "screenshots/shot.png",
        "settings.ini",
        "states/autosave.state",
        "videos/replay.gif",
    ];
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let package = |version| {
        archive_release(
            version,
            format!("ninety-four-{version}-linux-x86_64.tar.gz"),
            &[("nhl94", 0o755), ("licenses/ninety-four-MIT.txt", 0o644)],
        )
    };
    let (first, first_server) = package("0.3.5");
    let provider = Arc::new(Provider(Mutex::new(first)));
    let service = PortcoveService::with_provider(library, provider.clone()).unwrap();
    let installed = install(&service, NHL).await;
    first_server.join().unwrap();
    let working_directory = |record: &InstallRecord| {
        let port = service.installed_port(record).unwrap();
        let launch = service
            .prepare_launch_for_install(&port, record, None, None)
            .unwrap();
        assert_eq!(launch.executable, launch.working_directory.join("nhl94"));
        assert!(launch.arguments.is_empty());
        launch.working_directory
    };
    let initial = working_directory(&installed);
    for path in DATA {
        let file = initial.join(path);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, path).unwrap();
    }
    let (second, second_server) = package("0.3.6");
    *provider.0.lock().unwrap() = second;
    acquire(&service, NHL).await;
    second_server.join().unwrap();
    let updated = apply_update(&service, NHL).await.unwrap();
    assert_eq!(updated.version, "0.3.6");
    let updated_root = working_directory(&updated);
    for path in DATA {
        assert_eq!(
            std::fs::read_to_string(updated_root.join(path)).unwrap(),
            path
        );
    }
    std::fs::write(updated_root.join("settings.ini"), "updated settings").unwrap();
    let restored = service.rollback(NHL).unwrap();
    assert_eq!(restored.id, installed.id);
    let restored_root = working_directory(&restored);
    assert_eq!(
        std::fs::read_to_string(restored_root.join("settings.ini")).unwrap(),
        "updated settings"
    );
    for path in DATA.into_iter().filter(|path| *path != "settings.ini") {
        assert_eq!(
            std::fs::read_to_string(restored_root.join(path)).unwrap(),
            path
        );
    }
}

// #4879: an update that downloads a new version and activates it in place (an
// adapter without staged activation) takes its own automatic snapshot. The
// rollback, staged-activation, reuse and staged-update routes are covered in
// `service/tests/backups.rs`.

const NHL_IN_PLACE: &str = "nhl-94-genesis-ninety-four";

struct InPlaceUpdate {
    service: PortcoveService,
    provider: Arc<Provider>,
    installed: InstallRecord,
    saves: std::path::PathBuf,
    _temporary: tempfile::TempDir,
}

fn ninety_four(version: &str) -> (ResolvedRelease, crate::test_http::HttpServer) {
    archive_release(
        version,
        format!("ninety-four-{version}-linux-x86_64.tar.gz"),
        &[("nhl94", 0o755), ("licenses/ninety-four-MIT.txt", 0o644)],
    )
}

/// Installs 0.3.5 from a served package, then plays it: the game has written a
/// save and left the launch marker that collection trusts.
async fn played_in_place_install(
    faults: Arc<dyn crate::operation::LifecycleFaultInjector>,
) -> InPlaceUpdate {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let (first, first_server) = ninety_four("0.3.5");
    let provider = Arc::new(Provider(Mutex::new(first)));
    let mut service =
        PortcoveService::with_provider_and_faults(library, provider.clone(), faults).unwrap();
    // The same inert package under an adapter that activates in place, so the
    // update takes the direct install branch rather than staged activation.
    let mut port = service.catalog.port(NHL_IN_PLACE).unwrap().clone();
    port.adapter = crate::AdapterKind::N64RecompPortable;
    assert!(!crate::persistence::requires_restore_receipt(&port));
    service.replace_catalog_for_test(
        Catalog::from_json(
            &serde_json::json!({
                "schema_version": 3,
                "source_catalog": {
                    "evidence": [], "identities": [], "contracts": [], "validators": []
                },
                "ports": [port.clone()]
            })
            .to_string(),
        )
        .unwrap(),
    );
    let installed = install(&service, NHL_IN_PLACE).await;
    first_server.join().unwrap();
    let launch = service
        .prepare_launch_for_install(&port, &installed, None, None)
        .unwrap();
    let saves = launch.working_directory.join("states/autosave.state");
    fs::create_dir_all(saves.parent().unwrap()).unwrap();
    fs::write(&saves, "progress before the update").unwrap();
    // A real launch leaves this marker; collection only trusts a played version.
    fs::write(installed.path.join(LAUNCH_MARKER), b"1").unwrap();
    InPlaceUpdate {
        service,
        provider,
        installed,
        saves,
        _temporary: temporary,
    }
}

fn automatic_snapshots(service: &PortcoveService) -> Vec<crate::BackupRecord> {
    service
        .list_backups(NHL_IN_PLACE)
        .unwrap()
        .backups
        .into_iter()
        .filter(|backup| backup.automatic.is_some())
        .collect()
}

#[tokio::test]
async fn an_in_place_update_snapshots_the_saves_once_before_replacing_the_version() {
    let game = played_in_place_install(Arc::new(crate::operation::NoLifecycleFaults)).await;
    let (second, second_server) = ninety_four("0.3.6");
    *game.provider.0.lock().unwrap() = second;

    let updated = game
        .service
        .update(NHL_IN_PLACE, None, None, true, |_| {})
        .await
        .unwrap();
    second_server.join().unwrap();

    assert_eq!(updated.version, "0.3.6");
    assert!(!updated.staged, "the in-place route activates directly");
    let status = game.service.status(NHL_IN_PLACE).unwrap();
    assert_eq!(status.active.unwrap().id, updated.id);
    let snapshots = automatic_snapshots(&game.service);
    assert_eq!(snapshots.len(), 1, "one version change, one snapshot");
    let label = snapshots[0].automatic.as_ref().unwrap();
    assert_eq!(label.operation, crate::VersionChangeKind::Update);
    assert_eq!(label.from_version.as_deref(), Some("0.3.5"));
    assert_eq!(label.to_version, "0.3.6");
    assert_eq!(
        fs::read_to_string(snapshots[0].path.join("data/states/autosave.state")).unwrap(),
        "progress before the update"
    );
}

struct FailSnapshotCopy;

impl crate::operation::LifecycleFaultInjector for FailSnapshotCopy {
    fn check(&self, point: crate::operation::LifecycleFaultPoint) -> Result<()> {
        if point == crate::operation::LifecycleFaultPoint::BackupDataCopied {
            return Err(PortcoveError::state("injected snapshot failure"));
        }
        Ok(())
    }
}

#[tokio::test]
async fn a_failed_snapshot_stops_an_in_place_update_before_anything_is_installed() {
    let game = played_in_place_install(Arc::new(FailSnapshotCopy)).await;
    let (second, _second_server) = ninety_four("0.3.6");
    *game.provider.0.lock().unwrap() = second;

    let error = game
        .service
        .update(NHL_IN_PLACE, None, None, true, |_| {})
        .await
        .unwrap_err();

    assert!(
        error.message.contains("the version was not changed")
            && error.message.contains("turn off automatic snapshots"),
        "the player is told the version did not change and how to continue: {error:?}"
    );
    assert_eq!(
        error.details.get("recovery_action").map(String::as_str),
        Some("retry_or_disable_snapshots")
    );
    let status = game.service.status(NHL_IN_PLACE).unwrap();
    assert_eq!(status.active.unwrap().id, game.installed.id);
    assert!(status.staged.is_none(), "no new version was installed");
    assert!(status.previous.is_none(), "no new version was installed");
    assert!(automatic_snapshots(&game.service).is_empty());
    assert_eq!(
        fs::read_to_string(&game.saves).unwrap(),
        "progress before the update",
        "the played version's saves are untouched"
    );
}
