//! Production install/update-path fixtures for reviewed package-layout holds.
//! The archives are inert fixtures, not upstream artifacts or gameplay evidence.
use std::sync::{Arc, Mutex};

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

async fn acquire(service: &PortcoveService) -> String {
    let review = service.plan_game_update_acquisition(PORT).await.unwrap();
    let authorization = service
        .authorize_game_update_acquisition(PORT, &review.plan_sha256)
        .await
        .unwrap();
    service
        .acquire_game_update(PORT, &authorization.token, |_| {})
        .await
        .unwrap()
        .id
}

async fn apply_update(service: &PortcoveService) -> Result<InstallRecord> {
    let review = service.plan_game_update(PORT, true).await.unwrap();
    let authorization = service
        .authorize_game_update(PORT, true, &review.plan_sha256)
        .await
        .unwrap();
    service
        .apply_game_update(PORT, true, &authorization.token, |_| {})
        .await
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
    let installed = install(&service).await;
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
    let acquired = acquire(&service).await;
    compatible_server.join().unwrap();
    let updated = apply_update(&service).await.unwrap();
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
    acquire(&service).await;
    drifted_server.join().unwrap();
    let refusal = apply_update(&service).await.unwrap_err();
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
