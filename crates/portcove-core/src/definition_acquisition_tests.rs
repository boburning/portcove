use super::*;

fn scope() -> (tempfile::TempDir, DefinitionAcquisitionScope) {
    let directory = tempfile::tempdir().unwrap();
    let scope = DefinitionAcquisitionScope {
        library: crate::Library::open(directory.path()).unwrap(),
        identity: None,
        policy_sha256: String::new(),
        anchor_sha256: String::new(),
        port_sha256: String::new(),
        stable_id: "fixture".into(),
        repository: "fixture/game".into(),
        repository_id: 1,
        artifact_hosts: vec![
            "github.com".into(),
            "release-assets.githubusercontent.com".into(),
        ],
        max_redirects: 5,
        grant_id: "managed-github-v1-fixture".into(),
        policy_revision: 1,
        fixture_origin: None,
    };
    (directory, scope)
}

#[test]
fn artifact_scope_rejects_ambiguous_or_wider_urls() {
    let (_directory, scope) = scope();
    for url in [
        "http://github.com/game.zip",
        "https://github.com:444/game.zip",
        "https://user@github.com/game.zip",
        "https://github.com/game.zip#fragment",
        "https://github.com.evil.invalid/game.zip",
        "https://evil.invalid/?github.com",
        "https://github.com./game.zip",
        "https://127.0.0.1/game.zip",
    ] {
        assert!(scope.require_asset_url(url).is_err(), "{url}");
    }
    for url in [
        "https://github.com/game.zip",
        "https://release-assets.githubusercontent.com/game.zip?signature=fixture",
    ] {
        scope.require_asset_url(url).unwrap();
    }
}

#[test]
fn fixture_origin_refuses_nonloopback_acquisition() {
    let (_directory, mut scope) = scope();
    for origin in ["http://example.invalid:8123", "https://github.com"] {
        scope.fixture_origin = Some(origin.to_owned());
        let url = format!("{origin}/owned-fixture.zip");
        assert!(scope.require_asset_url(&url).is_err(), "{url}");
    }
}

#[test]
fn managed_scope_cannot_parse_independent_or_auxiliary_permissions() {
    let operations = MANAGED_OPERATIONS.map(str::to_owned).to_vec();
    let hosts = vec!["github.com".to_owned()];
    DefinitionAcquisitionScope::validate_parameters(1, &hosts, 5, &operations).unwrap();
    for excluded in 0..operations.len() {
        let mut partial = operations.clone();
        partial.remove(excluded);
        assert!(DefinitionAcquisitionScope::validate_parameters(1, &hosts, 5, &partial).is_err());
    }
    for hosts in [
        vec!["*.github.com".into()],
        vec!["github.com".into(), "github.com".into()],
        vec!["127.0.0.1".into()],
    ] {
        assert!(
            DefinitionAcquisitionScope::validate_parameters(1, &hosts, 5, &operations).is_err()
        );
    }
    assert!(DefinitionAcquisitionScope::validate_parameters(0, &hosts, 5, &operations).is_err());
    assert!(DefinitionAcquisitionScope::validate_parameters(1, &hosts, 6, &operations).is_err());
}

#[test]
fn fixture_origin_is_exact_and_never_falls_back_to_ordinary_hosts() {
    let (_directory, mut scope) = scope();
    for origin in [
        "http://localhost:8123",
        "http://127.0.0.1",
        "http://127.0.0.1:0",
        "http://127.0.0.1:8123/",
        "http://127.0.0.1:8123/path",
        "http://user@127.0.0.1:8123",
        "http://127.0.0.1:8123?x=1",
        "http://127.0.0.1:8123#x",
        "http://127.1:8123",
        "not-a-url",
    ] {
        scope.fixture_origin = Some(origin.into());
        assert!(
            scope
                .require_asset_url("https://github.com/game.zip")
                .is_err(),
            "{origin}"
        );
    }
    for origin in ["http://127.0.0.1:8123", "http://[::1]:8123"] {
        scope.fixture_origin = Some(origin.into());
        scope
            .require_asset_url(&format!("{origin}/game.zip"))
            .unwrap();
        for url in [
            "https://github.com/game.zip",
            "http://127.0.0.1:8124/game.zip",
            "http://user@127.0.0.1:8123/game.zip",
            "http://127.0.0.1:8123/game.zip#x",
        ] {
            assert!(scope.require_asset_url(url).is_err(), "{origin}: {url}");
        }
    }
}

#[cfg(feature = "qualification-fixtures")]
#[tokio::test]
async fn qualification_provider_requires_exact_library_and_managed_scope() {
    let (_directory, scope) = scope();
    let other = tempfile::tempdir().unwrap();
    assert!(
        crate::GithubReleaseProvider::for_qualification_library(
            &scope.library,
            other.path(),
            "http://127.0.0.1:8123"
        )
        .is_err()
    );
    assert!(
        crate::GithubReleaseProvider::for_qualification_library(
            &scope.library,
            scope.library.root(),
            "https://github.com"
        )
        .is_err()
    );
    let provider = crate::GithubReleaseProvider::for_qualification_library(
        &scope.library,
        scope.library.root(),
        "http://127.0.0.1:8123",
    )
    .unwrap();
    use crate::ReleaseProvider;
    let catalog = crate::Catalog::embedded().unwrap();
    assert!(
        provider
            .resolve_scoped(
                &catalog.ports()[0],
                crate::ReleaseChannel::Stable,
                crate::Platform::current().unwrap(),
                None,
            )
            .await
            .is_err()
    );
}
