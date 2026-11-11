//! Production install/update-path fixtures for reviewed package-layout holds.
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

fn opensc2k_release(
    version: &str,
    include_empty_data: bool,
    include_packaged_settings: bool,
) -> (ResolvedRelease, crate::test_http::HttpServer) {
    let gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    let mut tar = tar::Builder::new(gzip);
    let wrapper = format!("OpenSC2K-{version}-linux-x64");
    let mut elf = [0_u8; 48];
    elf[..6].copy_from_slice(b"\x7fELF\x02\x01");
    elf[16..20].copy_from_slice(&[3, 0, 0x3e, 0]);
    for (name, mode, bytes) in [
        ("OpenSC2K.x86_64", 0o755, elf.as_slice()),
        ("OpenSC2K.pck", 0o644, version.as_bytes()),
    ] {
        let mut header = tar::Header::new_ustar();
        header.set_mode(mode);
        header.set_size(bytes.len() as u64);
        tar.append_data(&mut header, format!("{wrapper}/{name}"), bytes)
            .unwrap();
    }
    if include_empty_data {
        let mut header = tar::Header::new_ustar();
        header.set_entry_type(tar::EntryType::Directory);
        header.set_mode(0o755);
        header.set_size(0);
        tar.append_data(&mut header, format!("{wrapper}/data"), std::io::empty())
            .unwrap();
    }
    if include_packaged_settings {
        let bytes = b"packaged settings";
        let mut header = tar::Header::new_ustar();
        header.set_mode(0o644);
        header.set_size(bytes.len() as u64);
        tar.append_data(
            &mut header,
            format!("{wrapper}/data/settings.cfg"),
            bytes.as_slice(),
        )
        .unwrap();
    }
    serve_archive(
        version,
        format!("{wrapper}.tar.gz"),
        tar.into_inner().unwrap().finish().unwrap(),
    )
}

#[tokio::test]
async fn opensc2k_linux_portable_directory_keeps_player_data_across_releases() {
    const ID: &str = "nicholas-ochoa-opensc2k";
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let (initial, initial_server) = opensc2k_release("0.3.0", false, false);
    let provider = Arc::new(Provider(Mutex::new(initial)));
    let service = PortcoveService::with_provider(library, provider.clone()).unwrap();
    let first = install(&service, ID).await;
    initial_server.join().unwrap();
    let runtime = |record: &InstallRecord| {
        let retained = service.installed_port(record).unwrap();
        let launch = service
            .prepare_launch_for_install(&retained, record, None, None)
            .unwrap();
        assert_eq!(
            launch.executable,
            launch.working_directory.join("OpenSC2K.x86_64")
        );
        assert!(launch.fixed_arguments_only);
        assert!(launch.working_directory.join("data").is_dir());
        launch.working_directory
    };
    let first_root = runtime(&first);
    fs::write(first_root.join("data/settings.cfg"), b"player settings").unwrap();
    fs::create_dir(first_root.join("data/cities")).unwrap();
    fs::write(first_root.join("data/cities/saved.sc2x"), b"city progress").unwrap();

    let (next, next_server) = opensc2k_release("0.3.1", true, false);
    *provider.0.lock().unwrap() = next;
    let acquired = acquire(&service, ID).await;
    next_server.join().unwrap();
    let updated = apply_update(&service, ID).await.unwrap();
    service
        .discard_game_update_acquisition(ID, &acquired)
        .unwrap();
    let updated_root = runtime(&updated);
    assert_eq!(
        fs::read(updated_root.join("OpenSC2K.pck")).unwrap(),
        b"0.3.1"
    );
    assert_eq!(
        fs::read(updated_root.join("data/settings.cfg")).unwrap(),
        b"player settings"
    );
    assert_eq!(
        fs::read(updated_root.join("data/cities/saved.sc2x")).unwrap(),
        b"city progress"
    );
    fs::write(
        updated_root.join("data/cities/saved.sc2x"),
        b"later progress",
    )
    .unwrap();
    let rolled = service.rollback(ID).unwrap();
    assert_eq!(rolled.id, first.id);
    let rolled_root = runtime(&rolled);
    assert_eq!(
        fs::read(rolled_root.join("OpenSC2K.pck")).unwrap(),
        b"0.3.0"
    );
    assert_eq!(
        fs::read(rolled_root.join("data/cities/saved.sc2x")).unwrap(),
        b"later progress"
    );

    let mut drifted = service.installed_port(&rolled).unwrap();
    drifted.linux_portable_data_directory = None;
    assert!(
        service
            .require_portable_transition_to(&rolled, &drifted, None, None)
            .is_err()
    );

    let (drifted, drifted_server) = opensc2k_release("0.3.2", false, true);
    *provider.0.lock().unwrap() = drifted;
    acquire(&service, ID).await;
    drifted_server.join().unwrap();
    assert!(
        apply_update(&service, ID)
            .await
            .unwrap_err()
            .message
            .contains("player-owned portable data directory")
    );
    assert_eq!(service.status(ID).unwrap().active.unwrap().id, first.id);
    assert_eq!(
        fs::read(rolled_root.join("data/settings.cfg")).unwrap(),
        b"player settings"
    );
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
