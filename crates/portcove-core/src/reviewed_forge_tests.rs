use super::*;
use serde_json::{Value, json};

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

async fn resolve_fixture(
    route: &ForgeRoute<'_>,
    mutate: impl FnOnce(&mut Value),
) -> (Result<()>, Vec<String>) {
    let gitlab = matches!(route.instance.dialect, ForgeDialect::GitlabV4);
    let repo = if gitlab {
        json!({"id":10, "path_with_namespace":"group/nested/fixture", "web_url":"https://web.forge.test/group/nested/fixture"})
    } else {
        json!({"id":10, "full_name":"group/fixture", "html_url":"https://web.forge.test/group/fixture"})
    };
    let mut release = if gitlab {
        json!({"tag_name":"stable/reviewed", "assets":{"links":[{
            "id":30, "name":"fixture.zip", "direct_asset_url":"https://web.forge.test/fixture.zip"
        }]}})
    } else {
        json!({"id":20, "tag_name":"stable/reviewed", "draft":false, "prerelease":false, "assets":[{
            "id":30, "name":"fixture.zip", "size":PAYLOAD.len(), "browser_download_url":"https://web.forge.test/fixture.zip"
        }]})
    };
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
        let asset = route
            .redirect(
                &route.download,
                "https://assets.reviewed.test/fixture.zip?signature=test",
            )
            .unwrap();
        assert_eq!(asset.host_str(), Some("assets.reviewed.test"));
        let staging = tempfile::tempdir().unwrap();
        let (first, second) = PAYLOAD.split_at(5);
        let file = route
            .verify_to_stage(
                futures_util::stream::iter([Ok(first), Ok(second)]),
                staging.path(),
            )
            .await
            .unwrap();
        assert_eq!(std::fs::read(file.path()).unwrap(), PAYLOAD);
        drop(file);
        for bytes in [
            b"reviewed archive wrong!!".as_slice(),
            b"",
            b"extra length exceeds the reviewed artifact",
        ] {
            assert!(
                route
                    .verify_to_stage(futures_util::stream::iter([Ok(bytes)]), staging.path())
                    .await
                    .is_err()
            );
        }
    }
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
        assert!(route.redirect(&route.download, forbidden).is_err());
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
