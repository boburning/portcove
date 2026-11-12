use super::*;
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
    let first = requests.recv().unwrap();
    assert!(
        first.contains("Generic_Game%5D=777") || first.contains("Generic_Game]=777"),
        "{first}"
    );
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
    for page in [0, 51] {
        let error = service
            .browse_provider_mods_with(&client, "starship", page)
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::Usage);
    }
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
