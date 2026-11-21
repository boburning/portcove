use super::*;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const PAYLOAD: &[u8] = b"reviewed archive fixture";

fn fixture(dialect: &str) -> (ReviewedForge, ReviewedForgeArtifact) {
    let root = match dialect {
        "github-v3" => "https://api.forge.test/",
        "gitlab-v4" => "https://api.forge.test/api/v4",
        _ => "https://other-instance.test/api/v1",
    };
    (
        serde_json::from_value(json!({
            "dialect": dialect, "api_root": root, "web_host": "web.forge.test",
            "asset_hosts": ["web.forge.test", "assets.reviewed.test"]
        }))
        .unwrap(),
        serde_json::from_value(json!({
            "repository": if dialect == "gitlab-v4" {"group/nested/fixture"} else {"group/fixture"},
            "repository_id": 10, "tag": "stable/reviewed",
            "release_id": if dialect == "gitlab-v4" { None } else { Some(20) },
            "asset_id": 30, "name": "fixture.zip", "url": "https://web.forge.test/fixture.zip",
            "size": PAYLOAD.len(), "sha256": hex::encode(Sha256::digest(PAYLOAD))
        }))
        .unwrap(),
    )
}

fn fixtures(dialect: ForgeDialect) -> [Value; 2] {
    let gitlab = matches!(dialect, ForgeDialect::GitlabV4);
    let repo = if gitlab {
        json!({"id":10, "path_with_namespace":"group/nested/fixture", "web_url":"https://web.forge.test/group/nested/fixture"})
    } else {
        json!({"id":10, "full_name":"group/fixture", "html_url":"https://web.forge.test/group/fixture"})
    };
    let release = if gitlab {
        json!({"tag_name":"stable/reviewed", "upcoming_release":false, "assets":{"links":[{
            "id":30, "name":"fixture.zip", "url":"https://web.forge.test/fixture.zip",
            "direct_asset_url":"https://web.forge.test/group/nested/fixture/-/releases/stable%2Freviewed/downloads/fixture.zip"
        }]}})
    } else {
        json!({"id":20, "tag_name":"stable/reviewed", "draft":false, "prerelease":false, "assets":[{
            "id":30, "name":"fixture.zip", "size":PAYLOAD.len(), "browser_download_url":"https://web.forge.test/fixture.zip"
        }]})
    };
    [repo, release]
}

async fn resolve_fixture(
    route: &ForgeRoute<'_>,
    mutate: impl FnOnce(&mut Value),
) -> (Result<()>, Vec<String>) {
    let [repo, mut release] = fixtures(route.instance.dialect);
    mutate(&mut release);
    let mut responses = [repo, release].into_iter();
    let mut urls = Vec::new();
    let result = route
        .resolve(|url| {
            urls.push(url.into());
            let body = serde_json::to_vec(&responses.next().unwrap()).unwrap();
            async move { Ok(body) }
        })
        .await;
    (result, urls)
}

#[tokio::test]
async fn reviewed_dialects_resolve_exact_assets_and_verify_the_stream() {
    for (dialect, base, leaf) in [
        (
            "github-v3",
            "https://api.forge.test/repos/group/fixture",
            "/releases/tags/stable%2Freviewed",
        ),
        (
            "gitlab-v4",
            "https://api.forge.test/api/v4/projects/group%2Fnested%2Ffixture",
            "/releases/stable%2Freviewed",
        ),
        (
            "forgejo-v1",
            "https://other-instance.test/api/v1/repos/group/fixture",
            "/releases/tags/stable%2Freviewed",
        ),
    ] {
        let (instance, artifact) = fixture(dialect);
        let route = instance.route(&artifact).unwrap();
        let (result, urls) = resolve_fixture(&route, |_| {}).await;
        result.unwrap();
        assert_eq!(urls, [base.to_owned(), format!("{base}{leaf}")]);
        let asset = Url::parse("https://assets.reviewed.test/fixture.zip").unwrap();
        assert!(allows_asset(&instance.asset_hosts, &asset));
        let staging = tempfile::tempdir().unwrap();
        let file = staging.path().join("fixture.zip");
        for (bytes, good) in [
            (PAYLOAD, true),
            (b"reviewed archive wrong!!".as_slice(), false),
            (b"".as_slice(), false),
            (
                b"extra length exceeds the reviewed artifact".as_slice(),
                false,
            ),
        ] {
            std::fs::write(&file, bytes).unwrap();
            let (digest, size) =
                crate::adapter::hash_file_bounded_with_checkpoint(&file, artifact.size, || Ok(()))
                    .unwrap();
            assert_eq!(verify_artifact(&artifact, &digest, size).is_ok(), good);
        }
    }
}

#[tokio::test]
async fn gitlab_requires_a_published_release_and_its_exact_destination_not_the_alias() {
    let (instance, artifact) = fixture("gitlab-v4");
    let route = instance.route(&artifact).unwrap();
    assert!(resolve_fixture(&route, |_| {}).await.0.is_ok());
    for upcoming in [json!(true), Value::Null, json!("false")] {
        assert!(
            resolve_fixture(&route, |release| {
                release["upcoming_release"] = upcoming;
            })
            .await
            .0
            .is_err()
        );
    }
    assert!(
        resolve_fixture(&route, |release| {
            release.as_object_mut().unwrap().remove("upcoming_release");
        })
        .await
        .0
        .is_err()
    );
    assert!(
        resolve_fixture(&route, |release| {
            let link = release["assets"]["links"][0].as_object_mut().unwrap();
            let destination = link.remove("url").unwrap();
            link.insert("direct_asset_url".into(), destination);
        })
        .await
        .0
        .is_err()
    );
    assert!(
        resolve_fixture(&route, |release| {
            let link = &mut release["assets"]["links"][0];
            link["url"] = json!("https://web.forge.test/another.zip");
            link["direct_asset_url"] = json!(artifact.url);
        })
        .await
        .0
        .is_err()
    );
}

#[tokio::test]
async fn substitutions_and_unreviewed_destinations_hold() {
    let (mut instance, mut artifact) = fixture("forgejo-v1");
    let route = instance.route(&artifact).unwrap();
    for changed in [
        |release: &mut Value| {
            release.as_object_mut().unwrap().remove("draft");
        },
        |release: &mut Value| release["id"] = json!(21),
        |release: &mut Value| release["draft"] = json!(true),
        |release: &mut Value| release["tag_name"] = json!("elsewhere"),
        |release: &mut Value| release["assets"][0]["id"] = json!(31),
        |release: &mut Value| {
            release["assets"][0]["browser_download_url"] =
                json!("https://assets.reviewed.test/other.zip")
        },
        |release: &mut Value| {
            let duplicate = release["assets"][0].clone();
            release["assets"].as_array_mut().unwrap().push(duplicate);
        },
    ] {
        assert!(resolve_fixture(&route, changed).await.0.is_err());
    }
    for forbidden in [
        "https://assets.reviewed.test.evil.test/a",
        "https://cdn.assets.reviewed.test/a",
        "https://fake@assets.reviewed.test/a",
        "http://assets.reviewed.test/a",
        "https://assets.reviewed.test:444/a",
        "https://127.0.0.1/a",
        "https://[::1]/a",
    ] {
        assert!(!allows_asset(
            &instance.asset_hosts,
            &Url::parse(forbidden).unwrap()
        ));
    }
    artifact.repository = "group/../fixture".to_owned();
    assert!(instance.route(&artifact).is_err());
    artifact.repository = "group/fixture".to_owned();
    instance.api_root = "https://localhost/api/v1".to_owned();
    assert!(instance.route(&artifact).is_err());
}

#[test]
fn restricted_dns_addresses_fail_closed() {
    for forbidden in [
        "0.0.0.0",
        "10.0.0.1",
        "100.64.0.1",
        "127.0.0.1",
        "169.254.169.254",
        "172.16.1.1",
        "192.168.0.1",
        "198.18.1.1",
        "203.0.113.1",
        "224.0.0.1",
        "240.0.0.1",
        "::",
        "::1",
        "::ffff:127.0.0.1",
        "64:ff9b::7f00:1",
        "2002:7f00:1::1",
        "2001:db8::1",
        "fc00::1",
        "fe80::1",
        "ff02::1",
    ] {
        assert!(!public_address(forbidden.parse().unwrap()), "{forbidden}");
    }
    for allowed in ["8.8.8.8", "2606:4700::1111"] {
        assert!(public_address(allowed.parse().unwrap()));
    }
}

#[test]
fn qualification_scope_refuses_an_unreviewed_host_before_http() {
    let (instance, mut artifact) = fixture("forgejo-v1");
    artifact.url = "https://unreviewed.test/fixture.zip".into();
    let (port, selection) = fixture_subject(instance, artifact);
    let error = ReviewedForgeReleaseProvider::issue_fixture_scope(
        selection.clone(),
        &selection,
        &port,
        None,
    )
    .err()
    .unwrap();
    assert!(error.message.contains("outside its exact policy"));
}

fn fixture_subject(
    instance: ReviewedForge,
    artifact: ReviewedForgeArtifact,
) -> (PortDefinition, ReviewedForgeSelection) {
    let mut port = embedded_fixture_port();
    let platform = port.platforms[0];
    let channel = ReleaseChannel::Stable;
    port.id = "reviewed-forge-fixture".into();
    port.platforms = vec![platform];
    port.channels = vec![channel];
    port.release.repository = artifact.repository.clone();
    port.release.provider = crate::ReleaseSource::ReviewedForge;
    port.release.user_prepared.clear();
    (
        port,
        ReviewedForgeSelection {
            platform,
            channel,
            instance,
            artifact,
        },
    )
}

fn embedded_fixture_port() -> PortDefinition {
    crate::Catalog::embedded()
        .unwrap()
        .port("naev")
        .unwrap()
        .clone()
}

#[derive(Clone, Copy)]
enum ArchiveCase {
    Verified,
    Changed,
    ForeignRedirect,
}

async fn serve_qualification(
    listener: tokio::net::TcpListener,
    dialect: ForgeDialect,
    case: ArchiveCase,
) -> Vec<String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let [repo, release] = fixtures(dialect).map(|value| serde_json::to_vec(&value).unwrap());
    let mut paths = Vec::new();
    let mut responses = vec![(200, repo, ""), (200, release, "")];
    let redirect = match case {
        ArchiveCase::ForeignRedirect => "Location: http://127.0.0.1:1/elsewhere\r\n",
        _ => "Location: /observed/archive.zip\r\n",
    };
    responses.push((302, Vec::new(), redirect));
    match case {
        ArchiveCase::Verified => responses.push((200, PAYLOAD.to_vec(), "")),
        ArchiveCase::Changed => responses.push((200, vec![b'x'; PAYLOAD.len()], "")),
        ArchiveCase::ForeignRedirect => {}
    }
    for (status, bytes, fields) in responses {
        let (mut connection, _) = listener.accept().await.unwrap();
        let mut headers = Vec::new();
        while !headers.ends_with(b"\r\n\r\n") {
            assert!(headers.len() < 4096, "fixture request is too large");
            headers.push(connection.read_u8().await.unwrap());
        }
        let request = String::from_utf8(headers).unwrap();
        let parts: Vec<_> = request.lines().next().unwrap().split_whitespace().collect();
        assert_eq!(parts[0], "GET");
        assert!(!request.to_ascii_lowercase().contains("\nauthorization:"));
        paths.push(parts[1].to_owned());
        let reason = if status == 200 { "OK" } else { "Found" };
        let reply = format!(
            "HTTP/1.1 {status} {reason}\r\nContent-Length: {}\r\nConnection: close\r\n{fields}\r\n",
            bytes.len()
        );
        connection.write_all(reply.as_bytes()).await.unwrap();
        connection.write_all(&bytes).await.unwrap();
        connection.shutdown().await.unwrap();
    }
    paths
}

#[tokio::test]
async fn exact_forge_scope_resolves_downloads_and_verifies_through_shared_paths() {
    for dialect in ["forgejo-v1", "gitlab-v4"] {
        for case in [
            ArchiveCase::Verified,
            ArchiveCase::Changed,
            ArchiveCase::ForeignRedirect,
        ] {
            let (instance, artifact) = fixture(dialect);
            let (port, selection) = fixture_subject(instance, artifact);
            let platform = selection.platform;
            let channel = selection.channel;
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let origin = format!("http://{}", listener.local_addr().unwrap());
            let worker = tokio::spawn(tokio::time::timeout(
                std::time::Duration::from_secs(10),
                serve_qualification(listener, selection.instance.dialect, case),
            ));
            let mut substituted = selection.clone();
            substituted.artifact.sha256 = "a".repeat(64);
            assert!(
                ReviewedForgeReleaseProvider::issue_fixture_scope(
                    substituted,
                    &selection,
                    &port,
                    Some(&origin),
                )
                .is_err()
            );
            let scoped = ReviewedForgeReleaseProvider::issue_fixture_scope(
                selection.clone(),
                &selection,
                &port,
                Some(&origin),
            )
            .unwrap();
            let provider: &dyn ReleaseProvider = &scoped;
            let mut different = port.clone();
            different.id = "unreviewed-subject".into();
            assert!(
                provider
                    .resolve_scoped(&different, channel, platform, None)
                    .await
                    .is_err()
            );
            let resolution = provider
                .resolve_scoped(&port, channel, platform, None)
                .await
                .unwrap();
            assert_eq!(resolution.release.asset, scoped.accepted_asset());
            let staging = tempfile::tempdir().unwrap();
            let result = scoped.acquire(&resolution, &port, staging.path()).await;
            match case {
                ArchiveCase::Verified => {
                    let file = result.unwrap_or_else(|error| panic!("{error:?}"));
                    assert_eq!(std::fs::read(file.path()).unwrap(), PAYLOAD);
                    drop(file);
                }
                ArchiveCase::Changed => {
                    assert!(result.err().unwrap().message.contains("digest differs"))
                }
                ArchiveCase::ForeignRedirect => assert!(result.is_err()),
            }
            assert_eq!(std::fs::read_dir(staging.path()).unwrap().count(), 0);
            let paths = worker.await.unwrap().unwrap();
            assert_eq!(paths[2], "/fixture.zip");
            assert_eq!(
                paths.get(3).map(String::as_str),
                if matches!(case, ArchiveCase::ForeignRedirect) {
                    None
                } else {
                    Some("/observed/archive.zip")
                }
            );
            assert!(paths[1].ends_with("/stable%2Freviewed"), "{paths:?}");
        }
    }
}

#[tokio::test]
async fn normal_provider_keeps_naev_externally_managed() {
    let port = embedded_fixture_port();
    let scratch = tempfile::tempdir().unwrap();
    let library = crate::Library::open(scratch.path()).unwrap();
    let provider = crate::CompositeReleaseProvider::for_library(&library).unwrap();
    let result = provider
        .resolve_scoped(&port, port.channels[0], port.platforms[0], None)
        .await;
    assert!(
        result
            .unwrap_err()
            .message
            .contains("user-prepared runtime")
    );
}
