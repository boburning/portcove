//! Acquisition-proof fixtures; no game or upstream artifact is executed.
use super::*;
use crate::{Catalog, ReleaseChannel, ReleaseProvider, ReleaseSource};

const ID: &str = "wave-race-64-racewave46";

fn catalog() -> Catalog {
    let mut document = Catalog::embedded().unwrap().authoritative_document();
    let port = document
        .ports
        .iter_mut()
        .find(|port| port.id == ID)
        .unwrap();
    port.release.provider = ReleaseSource::Github;
    port.release.direct.clear();
    port.release.repository = "official/project".into();
    port.release.asset_hints.insert(
        Platform::WindowsX86_64,
        vec!["RaceWave46-".into(), "-Windows-x64.zip".into()],
    );
    Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap()
}

struct Provider(ResolvedRelease);
#[async_trait::async_trait]
impl ReleaseProvider for Provider {
    async fn resolve(
        &self,
        _: &PortDefinition,
        _: ReleaseChannel,
        _: Platform,
    ) -> Result<ResolvedRelease> {
        Ok(self.0.clone())
    }
}

fn request(catalog: &Catalog, library: &Library, url: &str, version: &str) -> InstallRequest {
    InstallRequest {
        port_id: ID.into(),
        release: ResolvedRelease {
            version: version.into(),
            channel: ReleaseChannel::Stable,
            published_at: None,
            asset: ReleaseAsset {
                name: format!("RaceWave46-{version}-Windows-x64.zip"),
                url: url.into(),
                size: 42,
                sha256: "ab".repeat(32),
            },
        },
        output_root: library.versions_dir().join(ID),
        activate: true,
        managed: None,
        qualification: InstallQualification::from_catalog(catalog, ID, Platform::WindowsX86_64)
            .unwrap(),
    }
}

#[tokio::test]
async fn raw_dynamic_policy_request_refuses_before_download_or_staging() {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let catalog = catalog();
    let installer = Installer::new(library.clone()).unwrap();
    let request = request(
        &catalog,
        &library,
        &format!("http://{}/game.zip", listener.local_addr().unwrap()),
        "v2",
    );
    let output = request.output_root.clone();
    let failure = installer
        .install(
            request,
            &OperationCoordinator::new("unbound-dynamic", None),
            |_| {},
        )
        .await
        .unwrap_err();
    assert!(
        failure.message.contains("exact provider resolution"),
        "{failure}"
    );
    assert_eq!(
        listener.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
    assert!(!output.exists());
    assert!(library.all_installs().unwrap().is_empty());
    assert_eq!(fs::read_dir(library.staging_dir()).unwrap().count(), 0);
}

#[tokio::test]
async fn dynamic_policy_proof_binds_definition_platform_channel_and_exact_release() {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let catalog = catalog();
    let installer = Installer::new(library.clone()).unwrap();
    // One unchanged definition accepts both configured resolver observations.
    // This injected-provider test establishes binding, not publisher verification.
    for version in ["v1", "v2"] {
        let mut request = request(
            &catalog,
            &library,
            "https://upstream.invalid/runtime.zip",
            version,
        );
        let provider = Provider(request.release.clone());
        let proof = provider
            .resolve_scoped(
                catalog.port(ID).unwrap(),
                ReleaseChannel::Stable,
                Platform::WindowsX86_64,
                None,
            )
            .await
            .unwrap();
        request.qualification = request
            .qualification
            .with_acquisition_resolution(proof.clone())
            .unwrap();
        assert!(installer.require_acquisition(&request).unwrap().is_none());
        for field in [
            "version",
            "channel",
            "name",
            "url",
            "size",
            "sha256",
            "published_at",
        ] {
            let mut changed = request.clone();
            match field {
                "version" => changed.release.version.push_str("-changed"),
                "channel" => changed.release.channel = ReleaseChannel::Beta,
                "name" => changed.release.asset.name = "RaceWave46-other-Windows-x64.zip".into(),
                "url" => changed.release.asset.url.push_str("?changed"),
                "size" => changed.release.asset.size += 1,
                "sha256" => changed.release.asset.sha256 = "cd".repeat(32),
                _ => changed.release.published_at = Some("2026-10-24".into()),
            }
            assert!(installer.require_acquisition(&changed).is_err(), "{field}");
        }
        let mut other = catalog.authoritative_document();
        other
            .ports
            .iter_mut()
            .find(|port| port.id == ID)
            .unwrap()
            .release
            .asset_hints
            .get_mut(&Platform::WindowsX86_64)
            .unwrap()
            .push("other".into());
        let other = Catalog::from_json(&serde_json::to_string(&other).unwrap()).unwrap();
        assert!(
            InstallQualification::from_catalog(&other, ID, Platform::WindowsX86_64)
                .unwrap()
                .with_acquisition_resolution(proof.clone())
                .is_err()
        );
        let mut wrong_platform =
            InstallQualification::from_catalog(&catalog, ID, Platform::WindowsX86_64).unwrap();
        wrong_platform.platform = Platform::LinuxX86_64;
        assert!(
            wrong_platform
                .with_acquisition_resolution(proof.clone())
                .is_err()
        );
        assert!(
            InstallQualification::from_catalog(&catalog, ID, Platform::WindowsX86_64)
                .unwrap()
                .with_acquisition_resolution(crate::ScopedResolvedRelease::legacy(
                    request.release.clone()
                ))
                .is_err()
        );
        assert!(
            provider
                .resolve_scoped(
                    catalog.port(ID).unwrap(),
                    ReleaseChannel::Beta,
                    Platform::WindowsX86_64,
                    None
                )
                .await
                .is_err()
        );
    }
}
