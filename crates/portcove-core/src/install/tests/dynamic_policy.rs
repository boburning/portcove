//! Acquisition-proof fixtures; no game or upstream artifact is executed.
use super::*;
use crate::{Catalog, ReleaseChannel, ReleaseProvider, ReleaseSource};

const ID: &str = "wave-race-64-racewave46";

#[test]
fn recorded_github_asset_identity_rejects_changed_bytes_but_keeps_new_rolling_bindings_distinct() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("payload");
    fs::create_dir_all(&root).unwrap();
    fs::write(
        root.join("game.exe"),
        b"MZ inert first-party manifest fixture",
    )
    .unwrap();
    let mut qualification = InstallQualification::test("game.exe");
    let catalog = qualification
        .retained_contract
        .as_ref()
        .unwrap()
        .catalog("sample")
        .unwrap();
    let port = catalog.port("sample").unwrap();
    let release = ResolvedRelease {
        version: "v1".into(),
        channel: ReleaseChannel::Stable,
        published_at: None,
        asset: ReleaseAsset {
            name: "fixture.zip".into(),
            url: "https://github.com/official/project/releases/download/rolling/fixture.zip".into(),
            size: 32,
            sha256: "a".repeat(64),
        },
    };
    let identity = crate::definition_acquisition::GithubArtifactIdentity {
        repository: port.release.repository.clone(),
        repository_id: 1,
        release_id: 2,
        asset_id: 3,
        tag: "rolling".into(),
    };
    let mut proof = crate::ScopedResolvedRelease::legacy(release.clone())
        .for_selection(port, Platform::WindowsX86_64, ReleaseChannel::Stable)
        .unwrap();
    proof.github_identity = Some(identity.clone());
    qualification = qualification.with_acquisition_resolution(proof).unwrap();
    let (installer, install) = create_test_install(&root, &qualification);
    installer.library.register_install(&install, true).unwrap();
    assert_eq!(
        verified_manifest(&install)
            .unwrap()
            .github_artifact_identity,
        Some(identity.clone())
    );
    installer
        .require_github_artifact_identity("sample", &release, Some(&identity))
        .unwrap();
    let mut changed = release.clone();
    changed.asset.sha256 = "b".repeat(64);
    assert!(
        installer
            .require_github_artifact_identity("sample", &changed, Some(&identity))
            .is_err()
    );
    let mut successor = identity.clone();
    successor.asset_id = 4;
    installer
        .require_github_artifact_identity("sample", &changed, Some(&successor))
        .unwrap();
    let mut rebound = identity.clone();
    rebound.release_id = 5;
    assert!(
        installer
            .require_github_artifact_identity("sample", &release, Some(&rebound))
            .is_err()
    );
    rebound = identity.clone();
    rebound.repository_id = 6;
    assert!(
        installer
            .require_github_artifact_identity("sample", &release, Some(&rebound))
            .is_err()
    );
    assert_eq!(
        verified_manifest(&install)
            .unwrap()
            .github_artifact_identity,
        Some(identity)
    );
}

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

#[tokio::test]
async fn immutable_bytes_cannot_bypass_dynamic_runtime_provider_proof() {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let catalog = catalog();
    let installer = Installer::new(library.clone()).unwrap();
    let mut request = request(
        &catalog,
        &library,
        &format!("http://{}/game.zip", listener.local_addr().unwrap()),
        "v2",
    );
    request.activate = false;
    let private = temporary.path().join("private");
    std::fs::create_dir(&private).unwrap();
    let failure = installer
        .acquire_immutable(
            &request,
            &private,
            &OperationCoordinator::new("immutable-proof-control", None),
            &mut |_| {},
        )
        .await
        .unwrap_err();
    assert!(failure.message.contains("provider resolution"), "{failure}");
    assert!(
        matches!(listener.accept(), Err(error) if error.kind() == std::io::ErrorKind::WouldBlock)
    );
    assert_eq!(std::fs::read_dir(private).unwrap().count(), 0);
    assert!(library.all_installs().unwrap().is_empty());
}
