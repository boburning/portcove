use super::*;
use crate::{ProviderFreshness, test_http::serve_http};
use serde_json::json;

const WEB: &str = "https://thunderstore.io";

fn ok_json(body: &str, headers: &str) -> String {
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

// Shapes captured from the live community listing on November 12, 2026 (values
// synthetic).
fn version(web: &str, owner: &str, name: &str, number: &str, created: &str, active: bool) -> Value {
    json!({
        "name": name,
        "full_name": format!("{owner}-{name}-{number}"),
        "version_number": number,
        "dependencies": ["Other-Api-1.0.0"],
        "download_url": format!("{web}/package/download/{owner}/{name}/{number}/"),
        "downloads": 3,
        "date_created": created,
        "is_active": active,
        "file_size": 1234,
    })
}

fn package(web: &str, owner: &str, name: &str, versions: Vec<Value>) -> Value {
    json!({
        "name": name,
        "full_name": format!("{owner}-{name}"),
        "owner": owner,
        "package_url": format!("{web}/c/zelda-64-recompiled/p/{owner}/{name}/"),
        "date_updated": "2026-11-10T00:00:00Z",
        "is_deprecated": false,
        "versions": versions,
    })
}

#[test]
fn listings_bind_package_identity_versions_and_canonical_downloads() {
    let listing = json!([
        package(
            WEB,
            "Owner",
            "Timer",
            vec![
                version(WEB, "Owner", "Timer", "1.1.0", "2026-11-02T00:00:00Z", true),
                version(WEB, "Owner", "Timer", "1.0.0", "2026-11-01T00:00:00Z", true),
                version(
                    WEB,
                    "Owner",
                    "Timer",
                    "0.9.0",
                    "2026-10-01T00:00:00Z",
                    false
                ),
            ]
        ),
        // A record whose download location is not canonical is not a candidate.
        package(
            WEB,
            "Owner",
            "Elsewhere",
            vec![{
                let mut v = version(
                    WEB,
                    "Owner",
                    "Elsewhere",
                    "1.0.0",
                    "2026-11-01T00:00:00Z",
                    true,
                );
                v["download_url"] = json!("https://example.com/evil.zip");
                v
            }]
        ),
        // Identities that are not plain names are dropped.
        package(WEB, "Own/er", "Bad", vec![]),
    ]);
    let projects = parse_listing(&listing, "zelda-64-recompiled", WEB).unwrap();
    assert_eq!(projects.len(), 2);
    let timer = &projects[0];
    assert_eq!(timer.project_id, "Owner-Timer");
    assert_eq!(timer.provider, PROVIDER);
    assert_eq!(timer.game_id.as_deref(), Some("zelda-64-recompiled"));
    assert_eq!(
        timer.version.as_deref(),
        Some("1.1.0"),
        "the newest active version"
    );
    assert_eq!(timer.files.len(), 3);
    assert_eq!(timer.files[0].file_name, "Owner-Timer-1.1.0.zip");
    assert_eq!(
        timer.files[0].download_url,
        "https://thunderstore.io/package/download/Owner/Timer/1.1.0/"
    );
    assert!(
        timer.files[2].archived,
        "an inactive version is not offered"
    );
    assert!(timer.files[0].claimed_md5.is_none());
    let elsewhere = &projects[1];
    assert!(elsewhere.files.is_empty());
    assert_eq!(
        elsewhere.unreadable_files, 1,
        "an unreadable version is counted"
    );
    assert!(parse_listing(&json!({}), "c", WEB).is_err());
}

#[test]
fn browsing_pages_the_listing_without_claiming_a_page_is_everything() {
    let listing = json!(
        (0..45)
            .map(|i| {
                let name = format!("Mod{i}");
                package(
                    WEB,
                    "A",
                    &name,
                    vec![version(
                        WEB,
                        "A",
                        &name,
                        "1.0.0",
                        "2026-11-01T00:00:00Z",
                        true,
                    )],
                )
            })
            .collect::<Vec<_>>()
    );
    let projects = parse_listing(&listing, "c", WEB).unwrap();
    let first = page_of(projects.clone(), 1, 20);
    assert_eq!(first.projects.len(), 20);
    assert_eq!(first.total, 45);
    assert!(!first.complete);
    let last = page_of(projects.clone(), 3, 20);
    assert_eq!(last.projects.len(), 5);
    assert_eq!(last.projects[0].project_id, "A-Mod40");
    assert!(last.complete);
    assert!(page_of(projects, 9, 20).projects.is_empty());
}

#[tokio::test]
async fn the_listing_is_read_conditionally_and_falls_back_to_earlier_data_on_outage() {
    let (root, requests, server) = serve_http(vec![
        ok_json("[]", "Last-Modified: Thu, 12 Nov 2026 13:54:50 GMT\r\n"),
        "HTTP/1.1 304 Not Modified\r\nConnection: close\r\n\r\n".into(),
        "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into(),
    ]);
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path()).unwrap();
    let client = ThunderstoreClient::with_root(&root, Some(library)).unwrap();
    let first = client.community("zelda-64-recompiled").await.unwrap();
    assert_eq!(first.freshness, ProviderFreshness::Fresh);
    assert!(first.value.is_empty());
    let second = client.community("zelda-64-recompiled").await.unwrap();
    assert_eq!(second.freshness, ProviderFreshness::Revalidated);
    let third = client.community("zelda-64-recompiled").await.unwrap();
    assert_eq!(
        third.freshness,
        ProviderFreshness::Stale,
        "an outage is earlier data, not empty"
    );
    server.join().unwrap();
    let requests = requests.try_iter().collect::<Vec<_>>();
    assert!(requests[0].starts_with("GET /c/zelda-64-recompiled/api/v1/package/ "));
    assert!(
        requests[1]
            .to_ascii_lowercase()
            .contains("if-modified-since")
    );
    assert!(client.community("../x").await.is_err());
    assert!(
        client
            .project("zelda-64-recompiled", "nodash")
            .await
            .is_err()
    );
}

#[test]
fn only_reviewed_communities_are_bound() {
    assert_eq!(
        thunderstore_community("zelda64-recomp"),
        Some("zelda-64-recompiled")
    );
    assert_eq!(thunderstore_community("shipwright"), None);
}
