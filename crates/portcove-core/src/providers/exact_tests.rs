use std::sync::atomic::{AtomicU8, Ordering};

use serde_json::{Value, json};

use super::*;
use crate::{ExactReleaseIdentity, test_http::serve_routed_http};

const PORT: &str = "diablo-devilutionx";
const REPOSITORY: &str = "group/project";
const FILE: &str = "game-windows-x64.zip";
const COMMIT: &str = "0123456789abcdef0123456789abcdef01234567";
const CHANNEL: ReleaseChannel = ReleaseChannel::Stable;
const PLATFORM: Platform = Platform::WindowsX86_64;

fn fixture_port(provider: ReleaseSource) -> PortDefinition {
    let mut port = crate::Catalog::embedded()
        .unwrap()
        .port(PORT)
        .unwrap()
        .clone();
    port.platforms = vec![PLATFORM];
    port.channels = vec![CHANNEL];
    port.release.provider = provider;
    port.release.repository = REPOSITORY.into();
    port.release.asset_hints.clear();
    port.release.reviewed_package_choices_v2 = None;
    port
}

fn composite(root: &str) -> CompositeReleaseProvider {
    CompositeReleaseProvider {
        github: Arc::new(GithubReleaseProvider::with_api_root(root).unwrap()),
        gitlab: GitlabReleaseProvider::with_api_root(format!("{root}/api/v4")).unwrap(),
    }
}

fn pin(identity: ExactReleaseIdentity) -> ExactReleaseSelection {
    ExactReleaseSelection {
        port_id: PORT.into(),
        platform: PLATFORM,
        channel: CHANNEL,
        version: "v1.0.0".into(),
        filename: FILE.into(),
        size: 42,
        sha256: "a".repeat(64),
        identity,
    }
}

fn response(body: Value) -> String {
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.to_string().len()
    )
}

fn not_found() -> String {
    "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into()
}

fn request_target(request: &str) -> &str {
    request.split_ascii_whitespace().nth(1).unwrap()
}

fn host_root(request: &str) -> String {
    let host = request
        .lines()
        .filter_map(|line| line.split_once(':'))
        .find_map(|(key, value)| key.eq_ignore_ascii_case("host").then_some(value.trim()))
        .unwrap();
    format!("http://{host}")
}

fn github_asset(root: &str, tag: &str, id: u64, digest: &str, name: &str) -> Value {
    json!({
        "id": id,
        "name": name,
        "size": 42,
        "digest": format!("sha256:{digest}"),
        "browser_download_url": format!("{root}/{REPOSITORY}/releases/download/{tag}/{name}"),
        "created_at": "2025-01-01T00:00:00Z",
        "uploader": {"id": 42, "login": "maintainer"}
    })
}

fn github_release(tag: &str, id: u64, asset: Value, draft: bool, prerelease: bool) -> Value {
    json!({
        "id": id, "tag_name": tag, "draft": draft, "prerelease": prerelease,
        "published_at": "2025-01-01T00:00:00Z", "assets": [asset]
    })
}

#[tokio::test]
async fn exact_history_github_respects_cache_channel_stream_and_artifact_identity() {
    let state = Arc::new(AtomicU8::new(0));
    let (root, requests, server) = serve_routed_http(48, {
        let state = state.clone();
        move |request| {
            let root = host_root(request);
            let mode = state.load(Ordering::SeqCst);
            let old_asset = github_asset(
                &root,
                "v1.0.0",
                if mode == 3 { 88 } else { 77 },
                &if mode == 7 { "f" } else { "a" }.repeat(64),
                if mode == 6 {
                    "game-linux-x64.zip"
                } else {
                    FILE
                },
            );
            match request_target(request).split('?').next().unwrap() {
                "/repos/group/project" => response(json!({"id": 11, "archived": false})),
                "/repos/group/project/releases" => response(json!([github_release(
                    "v2.0.0",
                    90,
                    github_asset(&root, "v2.0.0", 95, &"b".repeat(64), FILE),
                    false,
                    false
                )])),
                "/repos/group/project/releases/tags/v1.0.0" if mode == 1 => not_found(),
                "/repos/group/project/releases/tags/v1.0.0" => response(github_release(
                    "v1.0.0",
                    if mode == 2 { 44 } else { 22 },
                    old_asset,
                    mode == 4,
                    mode == 5,
                )),
                "/repos/group/project/releases/22/assets" => response(json!([old_asset])),
                "/repos/group/project/git/ref/tags/v1.0.0" => response(json!({
                    "ref": "refs/tags/v1.0.0",
                    "object": {"type": "commit", "sha": if mode == 8 { "f".repeat(40) } else { COMMIT.into() }}
                })),
                path => panic!("unexpected provider path {path}"),
            }
        }
    });
    let provider = composite(&root);
    let mut port = fixture_port(ReleaseSource::Github);
    let pin = pin(ExactReleaseIdentity::Github {
        repository_id: 11,
        release_id: 22,
        asset_id: 77,
        commit_sha1: COMMIT.into(),
    });
    assert_eq!(
        provider
            .resolve(&port, CHANNEL, PLATFORM)
            .await
            .unwrap()
            .version,
        "v2.0.0"
    );
    assert_eq!(
        provider
            .review_exact(&port, CHANNEL, PLATFORM, None, &pin.version)
            .await
            .unwrap(),
        pin
    );
    let exact = provider
        .resolve_exact(&port, CHANNEL, PLATFORM, None, &pin)
        .await
        .unwrap();
    assert_eq!(exact.release.version, "v1.0.0");
    assert_eq!(exact.github_identity.unwrap().asset_id, 77);
    assert_eq!(
        provider
            .resolve(&port, CHANNEL, PLATFORM)
            .await
            .unwrap()
            .version,
        "v2.0.0"
    );

    for (mode, reason) in [
        (1, "absent tag"),
        (2, "replacement with the same tag"),
        (3, "replacement with the same filename and digest"),
        (4, "draft"),
        (5, "prerelease outside the selected channel"),
        (6, "foreign platform package"),
        (7, "changed digest at the same asset ID"),
        (8, "retagged commit"),
    ] {
        state.store(mode, Ordering::SeqCst);
        assert!(
            provider
                .resolve_exact(&port, CHANNEL, PLATFORM, None, &pin)
                .await
                .is_err(),
            "{reason} must refuse the exact selection"
        );
    }
    state.store(0, Ordering::SeqCst);
    port.release
        .github_other_stream_tag_prefixes
        .insert(PLATFORM, vec!["v1.".into()]);
    assert!(
        provider
            .resolve_exact(&port, CHANNEL, PLATFORM, None, &pin)
            .await
            .is_err()
    );
    server.join().unwrap();
    assert_eq!(
        requests
            .try_iter()
            .filter(|request| {
                request_target(request).split('?').next() == Some("/repos/group/project/releases")
            })
            .count(),
        1,
        "ordinary resolution uses its own cache and refused exact choices never follow latest"
    );
}

fn gitlab_link(root: &str, id: u64, file: u64) -> Value {
    json!({
        "id": id, "link_type": "package", "name": FILE,
        "url": format!("{root}/{REPOSITORY}/-/package_files/{file}/download")
    })
}

fn gitlab_file(id: u64, size: u64) -> Value {
    json!({"id": id, "file_name": FILE, "size": size, "file_sha256": "a".repeat(64)})
}

#[tokio::test]
async fn exact_history_gitlab_revalidates_tag_links_and_registry_without_fallback() {
    let state = Arc::new(AtomicU8::new(0));
    let (root, requests, server) = serve_routed_http(56, {
        let state = state.clone();
        move |request| {
            const PROJECT: &str = "/api/v4/projects/group%2Fproject";
            let root = host_root(request);
            let mode = state.load(Ordering::SeqCst);
            let path = request_target(request).split('?').next().unwrap();
            if let Some(suffix) = path.strip_prefix(PROJECT) {
                return match suffix {
                    "" => response(json!({"id":11,"path_with_namespace":REPOSITORY})),
                    "/releases" => response(json!([{
                        "tag_name":"v2.0.0","upcoming_release":false,"released_at":"2025-01-01T00:00:00Z",
                        "assets":{"links":[gitlab_link(&root, 89, 90)]}
                    }])),
                    "/releases/v1.0.0" if mode == 1 => not_found(),
                    "/releases/v1.0.0" => response(json!({
                        "tag_name":"v1.0.0","upcoming_release":mode == 5,
                        "released_at":if mode == 6 { "9999-01-01T00:00:00Z" } else { "2025-01-01T00:00:00Z" },
                        "assets":{"links":[]}
                    })),
                    "/repository/tags/v1.0.0" => response(json!({
                        "name":"v1.0.0","commit":{"id":if mode == 2 { "f".repeat(40) } else { COMMIT.into() }}
                    })),
                    "/releases/v1.0.0/assets/links" => response(json!([gitlab_link(
                        &root,
                        if mode == 3 { 78 } else { 77 },
                        if mode == 4 { 80 } else { 79 }
                    )])),
                    "/packages" => response(json!([
                        {"id":80,"name":"game","version":"1.0.0"},
                        {"id":81,"name":"game","version":"2.0.0"}
                    ])),
                    _ => panic!("unexpected provider path {path}"),
                };
            }
            match path {
                "/api/v4/projects/11/packages/80/package_files" => response(json!([gitlab_file(
                    if mode == 4 { 80 } else { 79 },
                    if mode == 7 { 43 } else { 42 }
                )])),
                "/api/v4/projects/11/packages/81/package_files" => {
                    response(json!([gitlab_file(90, 42)]))
                }
                _ => panic!("unexpected provider path {path}"),
            }
        }
    });
    let provider = composite(&root);
    let port = fixture_port(ReleaseSource::Gitlab);
    let pin = pin(ExactReleaseIdentity::Gitlab {
        project_id: 11,
        link_id: 77,
        package_file_id: 79,
        commit_sha1: COMMIT.into(),
    });
    assert_eq!(
        provider
            .resolve(&port, CHANNEL, PLATFORM)
            .await
            .unwrap()
            .version,
        "v2.0.0"
    );
    assert_eq!(
        provider
            .review_exact(&port, CHANNEL, PLATFORM, None, &pin.version)
            .await
            .unwrap(),
        pin
    );
    let exact = provider
        .resolve_exact(&port, CHANNEL, PLATFORM, None, &pin)
        .await
        .unwrap();
    assert_eq!(
        exact.release.asset.url,
        format!("{root}/{REPOSITORY}/-/package_files/79/download")
    );
    assert_eq!(
        provider
            .resolve(&port, CHANNEL, PLATFORM)
            .await
            .unwrap()
            .version,
        "v2.0.0"
    );
    for (mode, reason) in [
        (1, "absent tag"),
        (2, "changed commit"),
        (3, "changed link identity"),
        (4, "same link with a different registry file"),
        (5, "upcoming release"),
        (6, "future release"),
        (7, "changed byte length"),
    ] {
        state.store(mode, Ordering::SeqCst);
        assert!(
            provider
                .resolve_exact(&port, CHANNEL, PLATFORM, None, &pin)
                .await
                .is_err(),
            "{reason} must refuse the exact selection"
        );
    }
    server.join().unwrap();
    assert_eq!(
        requests
            .try_iter()
            .filter(|request| {
                request_target(request).split('?').next()
                    == Some("/api/v4/projects/group%2Fproject/releases")
            })
            .count(),
        1
    );
}

#[tokio::test]
async fn exact_history_direct_matches_only_its_catalog_pin_and_current_scope() {
    let (root, requests, server) =
        serve_routed_http(4, |_| panic!("pin validation must not contact a host"));
    let provider = composite(&root);
    let mut port = fixture_port(ReleaseSource::DirectManifest);
    let pin = pin(ExactReleaseIdentity::DirectManifest);
    port.release.direct.insert(
        PLATFORM,
        crate::DirectReleaseSpec {
            version: pin.version.clone(),
            url: format!("https://downloads.example/{FILE}"),
            size: pin.size,
            sha256: pin.sha256.clone(),
            published_at: None,
        },
    );
    assert_eq!(
        provider
            .resolve_exact(&port, CHANNEL, PLATFORM, None, &pin)
            .await
            .unwrap()
            .release
            .asset
            .name,
        FILE
    );
    assert!(
        provider
            .resolve_exact(&port, ReleaseChannel::Beta, PLATFORM, None, &pin)
            .await
            .is_err()
    );
    assert!(
        provider
            .resolve_exact(&port, CHANNEL, Platform::LinuxX86_64, None, &pin)
            .await
            .is_err()
    );
    let mut previous = pin.clone();
    previous.version = "v0.9.0".into();
    assert!(
        provider
            .resolve_exact(&port, CHANNEL, PLATFORM, None, &previous)
            .await
            .is_err()
    );

    port.managed_acquisition_hold = Some(crate::ManagedAcquisitionHold {
        reason: "review hold".into(),
        activation_reason: "review hold".into(),
        reviewed_artifacts: Vec::new(),
        excluded_artifacts: Vec::new(),
    });
    assert!(
        provider
            .resolve_exact(&port, CHANNEL, PLATFORM, None, &pin)
            .await
            .unwrap_err()
            .to_string()
            .contains("review hold")
    );

    let mut curated = fixture_port(ReleaseSource::Github);
    curated
        .release
        .curated
        .insert(PLATFORM, crate::curated_acquisition::fixture_record());
    curated.platforms.push(Platform::LinuxX86_64);
    let curated_pin = ExactReleaseSelection {
        identity: ExactReleaseIdentity::Github {
            repository_id: 11,
            release_id: 22,
            asset_id: 77,
            commit_sha1: COMMIT.into(),
        },
        ..pin.clone()
    };
    for platform in curated.platforms.iter().copied() {
        let mut candidate = curated_pin.clone();
        candidate.platform = platform;
        assert!(
            provider
                .resolve_exact(&curated, candidate.channel, platform, None, &candidate)
                .await
                .unwrap_err()
                .to_string()
                .contains("authorized curated")
        );
    }
    server.join().unwrap();
    assert_eq!(requests.try_iter().count(), 0);
}
