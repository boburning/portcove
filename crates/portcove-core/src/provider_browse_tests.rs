use super::*;
use crate::GameBananaClient;
use crate::{ErrorCode, retained_build::tests::fixture, test_http::serve_http_bytes};

fn json_response(body: &str) -> Vec<u8> {
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
    .into_bytes()
}

#[tokio::test]
async fn browsing_lists_a_bound_games_mods_and_names_files_to_plan() {
    let (_temporary, service, _first) = fixture();
    let index = serde_json::json!({
        "_aMetadata": {"_nRecordCount": 41, "_bIsComplete": false},
        "_aRecords": [
            {"_idRow": 42, "_sName": "HD Link\u{202e}", "_sVersion": "2.0", "_tsDateUpdated": 5},
            {"_idRow": 43, "_sName": "Recolor", "_tsDateUpdated": 6}
        ]
    })
    .to_string();
    let project = serde_json::json!({
        "_sName": "HD Link", "_sVersion": "2.0", "_bIsObsolete": false,
        "_tsDateUpdated": 5, "_aGame": {"_idRow": 777},
        "_aFiles": [{"_idRow": 10, "_sFile": "pack.zip", "_nFilesize": 9, "_tsDateAdded": 4,
            "_sMd5Checksum": "1c5133f5d7a8d9c72af51bab03452fbb", "_sAvResult": "clean",
            "_bIsArchived": false}]
    })
    .to_string();
    let (root, requests, server) =
        serve_http_bytes(vec![json_response(&index), json_response(&project)]);
    let client = GameBananaClient::with_roots(&root, None).unwrap();
    let page = service
        .browse_provider_mods_with(&client, "starship", 1)
        .await
        .unwrap();
    assert_eq!(page.page.projects.len(), 2);
    assert_eq!(page.page.total, 41);
    assert!(!page.page.complete, "a page is never the whole result");
    assert!(
        !page.page.projects[0].name.contains('\u{202e}'),
        "provider text is sanitized"
    );
    let view = service
        .provider_project_with(&client, "starship", 42)
        .await
        .unwrap();
    server.join().unwrap();
    assert_eq!(view.project.files[0].file_id, "10");
    assert_eq!(view.eligible_file_ids, Some(vec!["10".into()]));
    let first = requests.recv().unwrap();
    assert!(
        first.contains("Generic_Game%5D=777") || first.contains("Generic_Game]=777"),
        "{first}"
    );
}

#[tokio::test]
async fn project_files_remain_visible_when_the_definition_lacks_native_mod_state() {
    let (_temporary, mut service, _) = fixture();
    let mut document = service.catalog().authoritative_document();
    let port = document
        .ports
        .iter_mut()
        .find(|port| port.id == "shipwright")
        .unwrap();
    port.persistent_paths.retain(|path| path != "mods");
    service.replace_catalog_for_test(crate::Catalog::from_document(document).unwrap());

    let project = serde_json::json!({
        "_sName": "HD Link", "_bIsObsolete": false,
        "_tsDateUpdated": 5, "_aGame": {"_idRow": 16121},
        "_aFiles": [{"_idRow": 10, "_sFile": "pack.zip", "_nFilesize": 9,
            "_tsDateAdded": 4, "_sAvResult": "clean", "_bIsArchived": false}]
    })
    .to_string();
    let (root, _requests, server) = serve_http_bytes(vec![json_response(&project)]);
    let client = GameBananaClient::with_roots(&root, None).unwrap();
    let view = service
        .provider_project_with(&client, "shipwright", 42)
        .await
        .unwrap();
    server.join().unwrap();

    assert_eq!(view.project.files[0].file_id, "10");
    assert_eq!(view.eligible_file_ids, Some(Vec::new()));
}

#[tokio::test]
async fn browsing_refuses_unbound_games_bad_pages_and_other_games_projects() {
    let (_temporary, service, _first) = fixture();
    let client = GameBananaClient::with_roots("http://127.0.0.1:9", None).unwrap();
    let error = service
        .browse_provider_mods_with(&client, "shipwright-unknown", 1)
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::NotFound);
    let error = service
        .browse_provider_mods_with(&client, "starship", 0)
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Usage);
    let other = serde_json::json!({
        "_sName": "Elsewhere", "_bIsObsolete": false, "_tsDateUpdated": 5,
        "_aGame": {"_idRow": 1}, "_aFiles": []
    })
    .to_string();
    let (root, _requests, server) = serve_http_bytes(vec![json_response(&other)]);
    let client = GameBananaClient::with_roots(&root, None).unwrap();
    let error = service
        .provider_project_with(&client, "starship", 99)
        .await
        .unwrap_err();
    server.join().unwrap();
    assert_eq!(error.code, ErrorCode::Verification);
}

#[tokio::test]
async fn an_outage_shows_earlier_data_marked_stale_and_unbound_games_make_no_request() {
    let (_temporary, service, _first) = fixture();
    // A catalog game without a binding is refused before any request.
    let unreachable = GameBananaClient::with_roots("http://127.0.0.1:9", None).unwrap();
    let error = service
        .provider_project_with(&unreachable, "zelda64-recomp", 1)
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Unsupported);

    let project = serde_json::json!({
        "_sName": "HD Link", "_sVersion": "2.0", "_bIsObsolete": false,
        "_tsDateUpdated": 5, "_aGame": {"_idRow": 777}, "_aFiles": []
    })
    .to_string();
    let first = json_response(&project);
    let throttled = b"HTTP/1.1 429 Too Many Requests\r\nRetry-After: 120\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec();
    let (root, _requests, server) = serve_http_bytes(vec![first, throttled]);
    let client = GameBananaClient::with_roots(&root, Some(service.library().clone())).unwrap();
    let fresh = service
        .provider_project_with(&client, "starship", 42)
        .await
        .unwrap();
    let stale = service
        .provider_project_with(&client, "starship", 42)
        .await
        .unwrap();
    server.join().unwrap();
    assert_ne!(fresh.freshness, ProviderFreshness::Stale);
    assert_eq!(stale.freshness, ProviderFreshness::Stale);
    // Earlier data keeps the time it was confirmed (stored within the same second).
    assert!(stale.observed_at <= fresh.observed_at && fresh.observed_at - stale.observed_at <= 1);
}

#[tokio::test]
async fn mods_the_provider_labels_as_another_game_are_not_listed() {
    let (_temporary, service, _first) = fixture();
    let index = serde_json::json!({
        "_aMetadata": {"_nRecordCount": 2, "_bIsComplete": true},
        "_aRecords": [
            {"_idRow": 1, "_sName": "Ours", "_aGame": {"_idRow": 777}},
            {"_idRow": 2, "_sName": "Theirs", "_aGame": {"_idRow": 5}}
        ]
    })
    .to_string();
    let (root, _requests, server) = serve_http_bytes(vec![json_response(&index)]);
    let client = GameBananaClient::with_roots(&root, None).unwrap();
    let page = service
        .browse_provider_mods_with(&client, "starship", 1)
        .await
        .unwrap();
    server.join().unwrap();
    assert!(
        page.page
            .projects
            .iter()
            .all(|project| project.name != "Theirs")
    );
    assert_eq!(page.other_game_records, 1);
    assert_eq!(
        page.game_name,
        service.catalog().port("starship").unwrap().name
    );
}

#[tokio::test]
async fn browsing_follows_provider_continuation_past_fifty_and_handles_an_empty_final_page() {
    let (_temporary, service, _) = fixture();
    let index = serde_json::json!({
        "_aMetadata": {"_nRecordCount": 1020, "_bIsComplete": false},
        "_aRecords": [{"_idRow": 981, "_sName": "Deep listing"}]
    })
    .to_string();
    let final_page = serde_json::json!({
        "_aMetadata": {"_nRecordCount": 1000, "_bIsComplete": true},
        "_aRecords": []
    })
    .to_string();
    let (root, requests, server) =
        serve_http_bytes(vec![json_response(&index), json_response(&final_page)]);
    let client = GameBananaClient::with_roots(&root, None).unwrap();
    let page = service
        .browse_provider_mods_with(&client, "starship", 50)
        .await
        .unwrap();
    assert_eq!(page.last_page, 51);
    assert!(!page.page.complete);
    let final_page = service
        .browse_provider_mods_with(&client, "starship", 51)
        .await
        .unwrap();
    assert_eq!(final_page.last_page, 51);
    assert!(final_page.page.complete);
    assert!(final_page.page.projects.is_empty());
    server.join().unwrap();
    assert!(requests.recv().unwrap().contains("_nPage=50"));
    assert!(requests.recv().unwrap().contains("_nPage=51"));
}

#[tokio::test]
async fn oversized_thunderstore_community_has_a_direct_browse_handoff() {
    let (_temporary, service, _) = fixture();
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        crate::release::PROVIDER_JSON_MAX_BYTES + 1,
    ).into_bytes();
    let (root, _, server) = serve_http_bytes(vec![response]);
    let client = ProviderClient::Thunderstore {
        client: crate::ThunderstoreClient::with_root(&root, None).unwrap(),
        community: "starship-test".into(),
    };
    let error = service
        .browse_provider_mods_via(&client, "starship", 1)
        .await
        .unwrap_err();
    server.join().unwrap();
    assert_eq!(error.code, ErrorCode::Verification);
    let url = "https://thunderstore.io/c/starship-test/";
    assert!(error.message.contains(url));
    assert_eq!(
        error.details.get("provider_browse_url").map(String::as_str),
        Some(url)
    );
}
