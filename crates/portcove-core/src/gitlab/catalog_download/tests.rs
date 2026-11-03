use super::*;
use crate::test_http::{HttpServer, serve_routed_http};
use serde_json::json;
use std::sync::mpsc::Receiver;

#[derive(Clone, Copy)]
enum Mode {
    File,
    External,
    Duplicate,
    Ambiguous,
    RepeatedLink,
    OversizedPackages,
    OversizedReleases,
}

fn fixture(mode: Mode) -> (GitlabReleaseProvider, Receiver<String>, HttpServer) {
    let (root, requests, server) = serve_routed_http(40, move |request| {
        let path = request
            .split_whitespace()
            .nth(1)
            .unwrap()
            .split('?')
            .next()
            .unwrap();
        let host = request
            .lines()
            .find_map(|line| {
                line.split_once(':')
                    .filter(|(name, _)| name.eq_ignore_ascii_case("host"))
                    .map(|(_, host)| host.trim())
            })
            .unwrap();
        let root = format!("http://{host}");
        let duplicate = matches!(mode, Mode::Duplicate | Mode::Ambiguous);
        let link = json!({"id":7,"name":"player.zip", "url": if matches!(mode, Mode::External) {
            "https://pixeldrain.com/u/not-a-registry-file".into()
        } else if duplicate { format!("{root}/api/v4/projects/42/packages/generic/player/v1/player.zip") }
        else { format!("{root}/owner/game/-/package_files/17/download") },
        "direct_asset_url":"https://attacker.invalid/unreviewed", "link_type":"package"});
        let release = json!({"tag_name":"v1", "assets":{"links":[]}});
        if request.starts_with("HEAD ") {
            return format!(
                "HTTP/1.1 200 OK\r\nX-Checksum-Sha256: {}\r\nContent-Length: 1\r\nConnection: close\r\n\r\n",
                "b".repeat(64)
            );
        }
        let body = if path == "/api/v4/projects/owner%2Fgame" {
            json!({"id":42,"path_with_namespace":"owner/game"})
        } else if path.ends_with("/releases") {
            if matches!(mode, Mode::OversizedReleases) {
                json!(vec![release; 101])
            } else {
                json!([release])
            }
        } else if path.ends_with("/releases/v1") {
            release
        } else if path.ends_with("/assets/links/7") {
            link
        } else if path.ends_with("/assets/links") {
            if matches!(mode, Mode::RepeatedLink) {
                json!([link.clone(), link])
            } else {
                json!([link])
            }
        } else if path.ends_with("/packages") {
            if matches!(mode, Mode::OversizedPackages) {
                json!(vec![json!({"id":5,"name":"player","version":"v1"}); 101])
            } else {
                json!([{"id":5,"name":"player","version":"v1"}])
            }
        } else if path.ends_with("/package_files") {
            let first = json!({"id":17,"file_name":"player.zip","size":1,"file_sha256": if matches!(mode, Mode::Ambiguous) {"b".repeat(64)} else {"a".repeat(64)}});
            if duplicate {
                json!([first, {"id":18,"file_name":"player.zip","size":1,"file_sha256":"b".repeat(64)}])
            } else {
                json!([first])
            }
        } else {
            panic!("unexpected fixture request: {request}")
        };
        let body = body.to_string();
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    });
    (
        GitlabReleaseProvider::with_api_root(format!("{root}/api/v4")).unwrap(),
        requests,
        server,
    )
}

#[tokio::test]
async fn registry_catalog_rejects_oversized_shared_inventory_pages() {
    let (provider, _requests, server) = fixture(Mode::OversizedPackages);
    assert!(
        provider
            .catalog_download_options("owner/game", None, ReleaseChannel::Stable, None)
            .await
            .unwrap_err()
            .message
            .contains("package page exceeds")
    );
    server.join().unwrap();
    let (provider, _requests, server) = fixture(Mode::OversizedReleases);
    let project = provider.project_url("owner/game").unwrap();
    assert!(
        provider
            .releases(&project)
            .await
            .unwrap_err()
            .message
            .contains("release page exceeds")
    );
    server.join().unwrap();
}

#[tokio::test]
async fn registry_catalog_binds_project_tag_link_file_and_published_integrity() {
    let (provider, requests, server) = fixture(Mode::File);
    let (candidates, coverage, releases, selected) = provider
        .catalog_download_options("owner/game", None, ReleaseChannel::Stable, None)
        .await
        .unwrap();
    assert_eq!(selected, Some(release_id(42, "v1")));
    assert_eq!(candidates.len(), 1);
    assert!(coverage.candidates_complete && coverage.release_history_complete);
    assert!(releases[0].assets_complete);
    let candidate = &candidates[0];
    assert_eq!(candidate.sha256.as_deref(), Some("a".repeat(64).as_str()));
    assert_eq!(candidate.size, 1);
    assert_eq!(
        candidate.release_url,
        "https://gitlab.com/owner/game/-/releases/v1"
    );
    assert!(candidate.can_extract);
    assert!(
        matches!(&candidate.asset_id, CatalogDownloadAssetId::Foreign(CatalogForeignAssetId::Gitlab { project_id:42, link_id:7, file_id:17, tag }) if tag == "v1")
    );
    let exact = provider
        .catalog_download_candidate("owner/game", &candidate.release_id, &candidate.asset_id)
        .await
        .unwrap();
    assert_eq!(exact, *candidate);
    server.join().unwrap();
    let requests = requests.try_iter().collect::<Vec<_>>();
    assert_eq!(requests.len(), 10);
    assert!(
        requests
            .iter()
            .all(|request| !request.contains("attacker.invalid"))
    );
}

#[tokio::test]
async fn unsupported_gitlab_files_remain_explicit_incomplete_coverage() {
    let (provider, requests, server) = fixture(Mode::External);
    let (candidates, coverage, releases, _) = provider
        .catalog_download_options("owner/game", None, ReleaseChannel::Stable, None)
        .await
        .unwrap();
    assert!(candidates.is_empty());
    assert!(!coverage.candidates_complete);
    assert_eq!(coverage.limitations.len(), 1);
    assert!(coverage.limitations[0].contains("outside supported"));
    assert!(!releases[0].assets_complete);
    server.join().unwrap();
    assert_eq!(requests.try_iter().count(), 3);
}

#[tokio::test]
async fn duplicate_generic_uploads_require_unique_published_header_join_and_reject_stale_file() {
    let (provider, _requests, server) = fixture(Mode::Duplicate);
    let (candidates, _, _, _) = provider
        .catalog_download_options("owner/game", None, ReleaseChannel::Stable, None)
        .await
        .unwrap();
    assert!(matches!(
        &candidates[0].asset_id,
        CatalogDownloadAssetId::Foreign(CatalogForeignAssetId::Gitlab { file_id: 18, .. })
    ));
    assert_eq!(candidates[0].sha256, Some("b".repeat(64)));
    let stale = CatalogDownloadAssetId::Foreign(CatalogForeignAssetId::Gitlab {
        project_id: 42,
        tag: "v1".into(),
        link_id: 7,
        file_id: 17,
    });
    let error = provider
        .catalog_download_candidate("owner/game", &release_id(42, "v1"), &stale)
        .await
        .unwrap_err();
    assert!(error.message.contains("registry file changed"));
    server.join().unwrap();
    let (provider, _requests, server) = fixture(Mode::Ambiguous);
    let error = provider
        .catalog_download_options("owner/game", None, ReleaseChannel::Stable, None)
        .await
        .unwrap_err();
    assert!(error.message.contains("uniquely identify"));
    server.join().unwrap();
}

#[tokio::test]
async fn repeated_gitlab_link_identity_and_foreign_project_are_refused() {
    let (provider, _requests, server) = fixture(Mode::RepeatedLink);
    assert!(
        provider
            .catalog_download_options("owner/game", None, ReleaseChannel::Stable, None)
            .await
            .unwrap_err()
            .message
            .contains("link identity")
    );
    server.join().unwrap();
    let (provider, _requests, server) = fixture(Mode::File);
    assert!(
        provider
            .catalog_download_options(
                "owner/game",
                Some(&release_id(43, "v1")),
                ReleaseChannel::Stable,
                None
            )
            .await
            .unwrap_err()
            .message
            .contains("project changed")
    );
    server.join().unwrap();
}
