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

    let unknown = program.parent().unwrap().join("fallback-pilot.plt");
    fs::write(&unknown, b"unclaimed pilot").unwrap();
    assert!(service.preview_removal(PORT).is_err());
    assert_eq!(fs::read(&unknown).unwrap(), b"unclaimed pilot");
    assert_eq!(service.status(PORT).unwrap().active.unwrap().id, first.id);
}
