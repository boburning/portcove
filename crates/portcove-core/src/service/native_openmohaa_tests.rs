//! Linux install and maintenance fixture with inert programs and synthetic originals.
use std::{
    fs,
    io::Write,
    sync::{Arc, Mutex},
};

use super::*;
use crate::{
    Catalog, Library, Platform, PortDefinition, ReleaseAsset, ReleaseChannel, ReleaseProvider,
    ResolvedRelease,
};

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

fn release(
    version: &str,
    revision: u8,
    with_engine: bool,
) -> (ResolvedRelease, crate::test_http::HttpServer) {
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let mut program = [0_u8; 48];
    program[47] = revision;
    program[..6].copy_from_slice(b"\x7fELF\x02\x01");
    program[16..20].copy_from_slice(&[3, 0, 0x3e, 0]);
    for name in [
        "launch_openmohaa_breakthrough",
        "openmohaa",
        "game.so",
        "cgame.so",
        "libSDL2-2.0.so.0",
        "libopenal.so.1",
        "libcurl.so.4",
    ] {
        if name == "openmohaa" && !with_engine {
            continue;
        }
        zip.start_file(
            name,
            zip::write::SimpleFileOptions::default().unix_permissions(0o644),
        )
        .unwrap();
        zip.write_all(&program).unwrap();
    }
    let payload = zip.finish().unwrap().into_inner();
    let size = payload.len() as u64;
    let sha256 = crate::signed_catalog::digest(&payload);
    let mut response =
        format!("HTTP/1.1 200 OK\r\nContent-Length: {size}\r\nConnection: close\r\n\r\n")
            .into_bytes();
    response.extend(payload);
    let (origin, _, server) = crate::test_http::serve_http_bytes(vec![response]);
    let name = format!("openmohaa-{version}-linux-amd64.zip");
    (
        ResolvedRelease {
            version: version.into(),
            channel: ReleaseChannel::Stable,
            published_at: None,
            asset: ReleaseAsset {
                url: format!("{origin}/{name}"),
                name,
                size,
                sha256,
            },
        },
        server,
    )
}

#[tokio::test]
async fn openmohaa_unix_lifecycle_preserves_originals_and_leaves_profile_external() {
    let id = "medal-of-honor-allied-assault-breakthrough-openmohaa";
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().canonicalize().unwrap();
    let library = Library::open(root.join("library")).unwrap();
    let catalog = Catalog::embedded().unwrap();
    let (first_release, first_server) = release("v0.82.1", 1, true);
    let provider = Arc::new(Provider(Mutex::new(first_release)));
    let mut service = PortcoveService::with_provider(library.clone(), provider.clone()).unwrap();
    service.replace_catalog_for_test(catalog.clone());
    let first = service
        .install(id, None, None, None, true, |_| {})
        .await
        .unwrap();
    first_server.join().unwrap();
    for directory in ["main", "maintt"] {
        fs::create_dir(first.path.join(directory)).unwrap();
        fs::write(first.path.join(directory).join("original.pk3"), directory).unwrap();
    }
    let port = catalog.port(id).unwrap();
    let spec = service
        .prepare_launch_for_install(port, &first, None, None)
        .unwrap();
    assert_eq!(spec.working_directory, first.path);
    assert_eq!(
        spec.executable,
        first.path.join("launch_openmohaa_breakthrough")
    );
    assert!(spec.fixed_arguments_only);
    assert!(crate::permissions::executable_intent(&spec.executable).unwrap());
    assert!(crate::permissions::executable_intent(&first.path.join("openmohaa")).unwrap());

    let home = root.join("home");
    let save = home.join(".openmohaa/maintt/save/test.sav");
    fs::create_dir_all(save.parent().unwrap()).unwrap();
    fs::write(&save, b"keep external save").unwrap();
    let mut command = crate::ChildProcessPolicy::game_command(&spec.process_spec(), &[]).unwrap();
    command.env("HOME", &home).env_remove("FLATPAK_ID");
    let policy = crate::ExternalProfilePolicy::OpenmohaaUnixV1;
    crate::native_external_profile::require_external_roots(
        policy,
        &library,
        &spec,
        &command,
        &|| Ok(()),
    )
    .unwrap();
    command.env("HOME", &first.path);
    assert!(
        crate::native_external_profile::require_external_roots(
            policy,
            &library,
            &spec,
            &command,
            &|| Ok(())
        )
        .is_err()
    );
    let aliased_home = root.join("aliased-home");
    fs::create_dir(&aliased_home).unwrap();
    std::os::unix::fs::symlink(library.user_dir(id), aliased_home.join(".openmohaa")).unwrap();
    command.env("HOME", aliased_home);
    assert!(
        crate::native_external_profile::require_external_roots(
            policy,
            &library,
            &spec,
            &command,
            &|| Ok(())
        )
        .is_err()
    );
    let backup = service.create_backup(id).unwrap();
    assert!(backup.path.join("data/maintt/original.pk3").is_file());
    assert!(!backup.path.join("data/.openmohaa").exists());

    let (invalid, invalid_server) = release("v0.82.2", 2, false);
    *provider.0.lock().unwrap() = invalid;
    assert!(service.update(id, None, None, true, |_| {}).await.is_err());
    invalid_server.join().unwrap();
    assert_eq!(service.status(id).unwrap().active.unwrap().id, first.id);
    let (successor, successor_server) = release("v0.82.3", 3, true);
    *provider.0.lock().unwrap() = successor;
    let updated = service.update(id, None, None, true, |_| {}).await.unwrap();
    successor_server.join().unwrap();
    let rolled_back = service.rollback(id).unwrap();
    assert_eq!(rolled_back.id, first.id);
    for install in [updated, rolled_back] {
        for directory in ["main", "maintt"] {
            assert_eq!(
                fs::read(install.path.join(directory).join("original.pk3")).unwrap(),
                directory.as_bytes()
            );
        }
    }
    assert_eq!(fs::read(save).unwrap(), b"keep external save");
}
