use super::*;
use crate::test_http::serve_http;
use crate::{ProviderFreshness, provider_http::download_deadline};
use serde_json::json;
use std::time::Duration;

const WEB: &str = "https://gamebanana.com";

fn ok_json(body: &str, headers: &str) -> String {
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

// Shapes captured from the live API on November 11, 2026 (values synthetic).
fn file(id: u64) -> Value {
    json!({
        "_idRow": id, "_sFile": "hd-link.zip", "_nFilesize": 5587036u64,
        "_tsDateAdded": 1735499678, "_sDownloadUrl": format!("https://gamebanana.com/dl/{id}"),
        "_sMd5Checksum": "1C5133F5D7A8D9C72AF51BAB03452FBB", "_sAvResult": "clean",
        "_bIsArchived": false
    })
}

// For client tests whose web root is a local server: omit the provider URL so the
// canonical one derived from that root is used.
fn local_file(id: u64) -> Value {
    let mut value = file(id);
    value.as_object_mut().unwrap().remove("_sDownloadUrl");
    value
}

fn project_json(version: &str, files: Vec<Value>) -> String {
    json!({
        "_sName": "HD Link", "_sVersion": version, "_bIsObsolete": false,
        "_tsDateUpdated": 1788847027, "_aFiles": files,
        "_aSubmitter": {"_sName": "Someone"}
    })
    .to_string()
}

#[test]
fn project_separates_project_file_version_and_claims() {
    let value: Value = serde_json::from_str(&project_json("6.0.2", vec![file(1351992)])).unwrap();
    let project = parse_project(&value, 477979, WEB).unwrap();
    assert_eq!(project.project_id, "477979");
    assert_eq!(project.version.as_deref(), Some("6.0.2"));
    let file = &project.files[0];
    assert_eq!(file.file_id, "1351992");
    assert_eq!(file.download_url, "https://gamebanana.com/dl/1351992");
    assert_eq!(
        file.claimed_md5.as_deref(),
        Some("1c5133f5d7a8d9c72af51bab03452fbb")
    );
    assert_eq!(file.claimed_scan.as_deref(), Some("clean"));
}

#[test]
fn same_version_with_a_new_file_id_is_visibly_a_different_candidate() {
    let before: Value = serde_json::from_str(&project_json("1.0", vec![file(10)])).unwrap();
    let after: Value = serde_json::from_str(&project_json("1.0", vec![file(11)])).unwrap();
    let a = parse_project(&before, 1, WEB).unwrap();
    let b = parse_project(&after, 1, WEB).unwrap();
    assert_eq!(a.version, b.version);
    assert_ne!(a.files[0].file_id, b.files[0].file_id);
}

#[test]
fn hostile_or_inconsistent_records_never_become_candidates() {
    let mut mismatched = file(5);
    mismatched["_sDownloadUrl"] = json!("https://evil.example/dl/5");
    let mut traversal = file(6);
    traversal["_sFile"] = json!("../../etc/passwd");
    let mut bad_md5 = file(7);
    bad_md5["_sMd5Checksum"] = json!("not-a-checksum");
    let mut zero = file(8);
    zero["_idRow"] = json!(0);
    // A drive-relative name would replace the staging path on Windows.
    let mut drive = file(9);
    drive["_sFile"] = json!("C:x.o2r");
    let mut hidden = file(10);
    hidden["_sFile"] = json!(".x.o2r");
    let value: Value = serde_json::from_str(&project_json(
        "1\u{202E}evil\u{0007}",
        vec![mismatched, traversal, bad_md5, zero, drive, hidden],
    ))
    .unwrap();
    let project = parse_project(&value, 1, WEB).unwrap();
    assert_eq!(
        project.version.as_deref(),
        Some("1evil"),
        "control and bidi characters stripped"
    );
    assert_eq!(
        project.files.len(),
        1,
        "only the record with a bad checksum claim survives"
    );
    assert_eq!(project.files[0].file_id, "7");
    assert_eq!(
        project.unreadable_files, 5,
        "dropped records are counted so coverage is never assumed complete"
    );
    assert_eq!(
        project.files[0].claimed_md5, None,
        "a malformed checksum claim is dropped"
    );
}

#[test]
fn index_pages_report_total_and_incompleteness() {
    let value = json!({
        "_aMetadata": {"_nRecordCount": 414, "_bIsComplete": false, "_nPerpage": 2},
        "_aRecords": [
            {"_idRow": 1, "_sName": "A", "_sVersion": "1", "_tsDateUpdated": 5},
            {"_idRow": "bad", "_sName": "dropped"},
            {"_idRow": 2, "_sName": "B", "_tsDateModified": 9}
        ]
    });
    let page = parse_index(&value, 1, WEB).unwrap();
    assert_eq!(page.projects.len(), 2);
    assert_eq!(page.total, 414);
    assert!(!page.complete, "a page is never the whole result");
    assert_eq!(page.projects[1].updated_at, 9);
    assert!(parse_index(&json!({}), 1, WEB).is_err());
    let oversized = json!({"_aRecords": (0..51).map(|i| json!({"_idRow": i + 1, "_sName": "x"})).collect::<Vec<_>>()});
    assert!(parse_index(&oversized, 1, WEB).is_err());
}

#[tokio::test]
async fn project_fetch_binds_identity_and_revalidates_with_conditional_headers() {
    let body = project_json("1.0", vec![local_file(10)]);
    let (root, requests, server) = serve_http(vec![
        ok_json(&body, "ETag: \"v1\"\r\n"),
        "HTTP/1.1 304 Not Modified\r\nConnection: close\r\n\r\n".into(),
    ]);
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path()).unwrap();
    let client = GameBananaClient::with_roots(&root, Some(library)).unwrap();
    let first = client.project(42).await.unwrap();
    assert_eq!(first.freshness, ProviderFreshness::Fresh);
    assert_eq!(first.value.project_id, "42");
    let second = client.project(42).await.unwrap();
    assert_eq!(second.freshness, ProviderFreshness::Revalidated);
    assert_eq!(second.value, first.value);
    server.join().unwrap();
    let first_request = requests.recv().unwrap();
    assert!(first_request.contains("/apiv11/Mod/42?"));
    assert!(first_request.contains("_csvProperties="));
    // Without the game field every live plan would be refused as another game's.
    assert!(
        first_request.contains("_aGame"),
        "the project request must ask for the game binding"
    );
    assert!(
        requests
            .recv()
            .unwrap()
            .to_ascii_lowercase()
            .contains("if-none-match: \"v1\"")
    );
}

#[tokio::test]
async fn outage_falls_back_to_marked_stale_data_and_throttling_stops_further_requests() {
    let body = project_json("1.0", vec![local_file(10)]);
    let (root, requests, server) = serve_http(vec![
        ok_json(&body, "ETag: \"v1\"\r\n"),
        "HTTP/1.1 429 Too Many Requests\r\nRetry-After: 120\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            .into(),
    ]);
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path()).unwrap();
    let client = GameBananaClient::with_roots(&root, Some(library)).unwrap();
    client.project(42).await.unwrap();
    let stale = client.project(42).await.unwrap();
    assert_eq!(stale.freshness, ProviderFreshness::Stale);
    assert_eq!(stale.value.files.len(), 1);
    // The server accepts exactly two requests; a third would hang or fail the join,
    // so this proves provider backoff holds without touching the network.
    let again = client.project(42).await.unwrap();
    assert_eq!(again.freshness, ProviderFreshness::Stale);
    server.join().unwrap();
    assert_eq!(requests.iter().count(), 2);
}

#[tokio::test]
async fn an_outage_with_no_cache_is_an_error_not_an_empty_result() {
    let (root, _requests, server) = serve_http(vec![
        "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into(),
    ]);
    let client = GameBananaClient::with_roots(&root, None).unwrap();
    assert!(client.search(16121, 1, 10).await.is_err());
    server.join().unwrap();
}

#[tokio::test]
async fn a_malformed_success_never_replaces_a_good_cache_entry() {
    let good = project_json("1.0", vec![local_file(10)]);
    let (root, _requests, server) = serve_http(vec![
        ok_json(&good, "ETag: \"good\"\r\n"),
        ok_json("{malformed", "ETag: \"bad\"\r\n"),
        "HTTP/1.1 304 Not Modified\r\nConnection: close\r\n\r\n".into(),
    ]);
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path()).unwrap();
    let client = GameBananaClient::with_roots(&root, Some(library)).unwrap();
    client.project(42).await.unwrap();
    assert!(client.project(42).await.is_err());
    // The next conditional read still revalidates against the good validator.
    let third = client.project(42).await.unwrap();
    assert_eq!(third.freshness, ProviderFreshness::Revalidated);
    server.join().unwrap();
}

fn candidate(root: &str, id: u64, size: u64) -> ProviderFileCandidate {
    ProviderFileCandidate {
        file_id: id.to_string(),
        file_name: "pack.zip".into(),
        size,
        added_at: 0,
        download_url: format!("{root}/dl/{id}"),
        claimed_md5: None,
        archived: false,
        claimed_scan: None,
    }
}

fn bytes_response(status: &str, headers: &str, body: &[u8]) -> Vec<u8> {
    let mut response = format!(
        "HTTP/1.1 {status}\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )
    .into_bytes();
    response.extend_from_slice(body);
    response
}

#[tokio::test]
async fn download_follows_provider_redirects_and_binds_computed_digest_and_size() {
    let body = b"synthetic package bytes".to_vec();
    let (root, requests, server) = crate::test_http::serve_http_bytes(vec![
        bytes_response("302 Found", "Location: /files/pack.zip\r\n", b""),
        bytes_response("200 OK", "Content-Type: application/zip\r\n", &body),
    ]);
    let client = GameBananaClient::with_roots(&root, None).unwrap();
    let directory = tempfile::tempdir().unwrap();
    let target = directory.path().join("pack.zip");
    let (sha256, size) = client
        .download_file(&candidate(&root, 10, body.len() as u64), &target, 1 << 20)
        .await
        .unwrap();
    server.join().unwrap();
    assert_eq!(size, body.len() as u64);
    assert_eq!(
        sha256,
        hex::encode(<sha2::Sha256 as sha2::Digest>::digest(&body))
    );
    assert_eq!(std::fs::read(&target).unwrap(), body);
    assert!(requests.recv().unwrap().starts_with("GET /dl/10 "));
}

#[tokio::test]
async fn download_refuses_redirects_off_the_provider_and_size_disagreements() {
    let (root, _requests, server) = crate::test_http::serve_http_bytes(vec![bytes_response(
        "302 Found",
        "Location: http://evil.example/steal.zip\r\n",
        b"",
    )]);
    let client = GameBananaClient::with_roots(&root, None).unwrap();
    let directory = tempfile::tempdir().unwrap();
    let target = directory.path().join("x.zip");
    let error = client
        .download_file(&candidate(&root, 11, 10), &target, 1 << 20)
        .await
        .unwrap_err();
    server.join().unwrap();
    assert!(error.message.contains("redirected away"), "{error}");

    let (root, _requests, server) =
        crate::test_http::serve_http_bytes(vec![bytes_response("200 OK", "", b"twelve bytes")]);
    let client = GameBananaClient::with_roots(&root, None).unwrap();
    let error = client
        .download_file(&candidate(&root, 12, 5), &target, 1 << 20)
        .await
        .unwrap_err();
    server.join().unwrap();
    assert!(error.message.contains("size"), "{error}");
    // A declared size above the hard cap is refused before any request.
    assert!(
        client
            .download_file(&candidate(&root, 13, 1 << 30), &target, 1 << 20)
            .await
            .is_err()
    );
    // A non-canonical location is never fetched.
    let mut hostile = candidate(&root, 14, 5);
    hostile.download_url = "http://127.0.0.1:1/other".into();
    assert!(
        client
            .download_file(&hostile, &target, 1 << 20)
            .await
            .is_err()
    );
}

#[test]
fn download_deadline_grows_with_size_and_is_capped() {
    assert!(download_deadline(1) >= Duration::from_secs(120));
    assert!(download_deadline(1 << 30) > download_deadline(1 << 20));
    assert_eq!(
        download_deadline(u64::MAX),
        Duration::from_secs(6 * 60 * 60)
    );
}

#[test]
fn projects_with_too_many_files_are_refused_instead_of_truncated() {
    let files = (1..=257u64).map(file).collect::<Vec<_>>();
    let value: Value = serde_json::from_str(&project_json("1.0", files)).unwrap();
    assert!(parse_project(&value, 1, WEB).is_err());
    let files = (1..=256u64).map(file).collect::<Vec<_>>();
    let value: Value = serde_json::from_str(&project_json("1.0", files)).unwrap();
    assert_eq!(parse_project(&value, 1, WEB).unwrap().files.len(), 256);
}

#[tokio::test]
async fn download_redirects_must_keep_the_providers_port() {
    let (root, _requests, server) = crate::test_http::serve_http_bytes(vec![bytes_response(
        "302 Found",
        "Location: http://127.0.0.1:9/elsewhere.zip\r\n",
        b"",
    )]);
    let client = GameBananaClient::with_roots(&root, None).unwrap();
    let directory = tempfile::tempdir().unwrap();
    let error = client
        .download_file(
            &candidate(&root, 15, 10),
            &directory.path().join("x"),
            1 << 20,
        )
        .await
        .unwrap_err();
    server.join().unwrap();
    assert!(error.message.contains("redirected away"), "{error}");
}
