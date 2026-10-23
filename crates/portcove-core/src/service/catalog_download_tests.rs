use super::*;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    io::{Read, Write},
    net::TcpListener,
    sync::{
        Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    thread,
    time::Duration,
};

fn fixture() -> (tempfile::TempDir, PortcoveService, CatalogDownloadRequest) {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let mut service = PortcoveService::new(library).unwrap();
    let listing: PortListing = serde_json::from_value(json!({
        "id":"directory-download-fixture", "name":"Directory download fixture",
        "summary":"An unintegrated upstream project", "project_url":"https://github.com/owner/game",
        "release_url":"https://github.com/owner/game/releases", "platforms":[]
    }))
    .unwrap();
    service.catalog = Catalog::from_json(r#"{"schema_version":1,"source_profiles":[],"ports":[]}"#)
        .unwrap()
        .with_listing_document(crate::CatalogListingDocument {
            format_version: 1,
            listings: vec![listing],
        })
        .unwrap();
    let parent = temporary.path().join("user-games");
    fs::create_dir(&parent).unwrap();
    let request = CatalogDownloadRequest {
        port_id: "directory-download-fixture".into(),
        release_id: 7,
        asset_id: 11,
        destination_parent: fs::canonicalize(parent).unwrap(),
        extract_archive: true,
    };
    (temporary, service, request)
}

fn archive() -> Vec<u8> {
    let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    writer
        .start_file("readme.txt", zip::write::SimpleFileOptions::default())
        .unwrap();
    writer
        .write_all(b"Follow the upstream setup instructions.")
        .unwrap();
    writer.finish().unwrap().into_inner()
}

struct GithubFixture {
    provider: GithubReleaseProvider,
    assets: Arc<Mutex<Vec<Value>>>,
    releases: Arc<Mutex<Vec<Value>>>,
    release_assets: Arc<Mutex<HashMap<u64, Vec<Value>>>>,
    requests: Arc<AtomicUsize>,
    stopped: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}

impl GithubFixture {
    fn new(bytes: Vec<u8>, digest: Option<String>, sidecar: Option<String>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let mut inventory = vec![json!({ "id":11,"name":"game.zip","size":bytes.len(),
            "browser_download_url":format!("{origin}/download/game.zip"),"digest":digest })];
        if let Some(sidecar) = &sidecar {
            inventory.push(
                json!({"id":12,"name":"game.zip.sha256","size":sidecar.len(),
                "browser_download_url":format!("{origin}/download/game.zip.sha256"),"digest":null}),
            );
        }
        let assets = Arc::new(Mutex::new(inventory));
        let releases = Arc::new(Mutex::new(vec![
            json!({"id":7,"tag_name":"v1.0","draft":false,"prerelease":false,"published_at":null,"assets":[]}),
        ]));
        let release_assets: Arc<Mutex<HashMap<u64, Vec<Value>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let stopped = Arc::new(AtomicBool::new(false));
        let requests = Arc::new(AtomicUsize::new(0));
        let (thread_assets, thread_stopped, thread_requests) =
            (assets.clone(), stopped.clone(), requests.clone());
        let (thread_releases, thread_release_assets) = (releases.clone(), release_assets.clone());
        let worker = thread::spawn(move || {
            while !thread_stopped.load(Ordering::SeqCst) {
                let mut stream = match listener.accept() {
                    Ok((stream, _)) => stream,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5));
                        continue;
                    }
                    Err(error) => panic!("fixture accept: {error}"),
                };
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut request = [0; 8192];
                let size = stream.read(&mut request).unwrap();
                let request = String::from_utf8_lossy(&request[..size]);
                let path = request
                    .lines()
                    .next()
                    .unwrap()
                    .split_whitespace()
                    .nth(1)
                    .unwrap();
                thread_requests.fetch_add(1, Ordering::SeqCst);
                let url = reqwest::Url::parse(&format!("http://fixture.test{path}")).unwrap();
                let query = url.query_pairs().collect::<HashMap<_, _>>();
                let page: usize = query
                    .get("page")
                    .map(|value| value.parse().unwrap())
                    .unwrap_or(1);
                let page_size: usize = query
                    .get("per_page")
                    .map(|value| value.parse().unwrap())
                    .unwrap_or(100);
                let page_bytes = |values: &[Value]| {
                    serde_json::to_vec(
                        &values
                            .iter()
                            .skip((page - 1) * page_size)
                            .take(page_size)
                            .collect::<Vec<_>>(),
                    )
                    .unwrap()
                };
                // Deliberately omit embedded assets: the dedicated, paginated
                // endpoint is the complete checksum authority, including sidecars.
                let body = if path.contains("/assets?") {
                    let release_id: u64 = url.path().split('/').nth(5).unwrap().parse().unwrap();
                    let inventory = thread_release_assets
                        .lock()
                        .unwrap()
                        .get(&release_id)
                        .cloned()
                        .unwrap_or_else(|| thread_assets.lock().unwrap().clone());
                    page_bytes(&inventory)
                } else if path == "/repos/owner/game/releases/7" {
                    serde_json::to_vec(&thread_releases.lock().unwrap()[0]).unwrap()
                } else if path.starts_with("/repos/owner/game/releases?") {
                    page_bytes(&thread_releases.lock().unwrap())
                } else if path == "/download/game.zip" {
                    bytes.clone()
                } else if path == "/download/game.zip.sha256" {
                    sidecar.clone().unwrap().into_bytes()
                } else {
                    panic!("unexpected fixture request: {path}")
                };
                let header = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                if stream.write_all(header.as_bytes()).is_ok() {
                    let _ = stream.write_all(&body);
                }
            }
        });
        Self {
            provider: GithubReleaseProvider::with_api_root(origin).unwrap(),
            assets,
            releases,
            release_assets,
            requests,
            stopped,
            worker: Some(worker),
        }
    }
}

impl Drop for GithubFixture {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::SeqCst);
        self.worker.take().unwrap().join().unwrap();
    }
}

#[tokio::test]
async fn bounded_discovery_does_not_claim_no_assets_when_older_releases_are_unchecked() {
    let github = GithubFixture::new(archive(), None, None);
    let older_asset = github.assets.lock().unwrap()[0].clone();
    github.assets.lock().unwrap().clear();
    *github.releases.lock().unwrap() = (1..=11)
        .map(|id| json!({"id":id,"tag_name":format!("v{id}"),"draft":false,"prerelease":false,"published_at":null,"assets":[]}))
        .collect();
    github
        .release_assets
        .lock()
        .unwrap()
        .insert(11, vec![older_asset]);

    let (candidates, coverage) = github
        .provider
        .catalog_release_candidates("owner/game")
        .await
        .unwrap();
    assert!(candidates.is_empty());
    assert_eq!(coverage.releases_checked, 10);
    assert!(!coverage.release_history_complete);
    assert!(coverage.candidates_complete);
    let reason = coverage.reason(true).unwrap();
    assert!(reason.contains("in the recent releases checked here"));
    assert!(reason.contains("Older downloads may be available"));
    // One release page and ten complete empty inventories. The older package
    // remains outside the bounded query, not asserted absent.
    assert_eq!(github.requests.load(Ordering::SeqCst), 11);
}

#[tokio::test]
async fn aggregate_candidate_limit_is_disclosed_without_discarding_valid_choices() {
    let github = GithubFixture::new(archive(), None, None);
    let asset = github.assets.lock().unwrap()[0].clone();
    *github.assets.lock().unwrap() = (1..=75)
        .map(|id| {
            let mut value = asset.clone();
            value["id"] = json!(id);
            value["name"] = json!(format!("game-{id}.zip"));
            value
        })
        .collect();
    *github.releases.lock().unwrap() = (7..=9)
        .map(|id| json!({"id":id,"tag_name":format!("v{id}"),"draft":false,"prerelease":false,"published_at":null,"assets":[]}))
        .collect();

    let (candidates, coverage) = github
        .provider
        .catalog_release_candidates("owner/game")
        .await
        .unwrap();
    assert_eq!(candidates.len(), 200);
    assert_eq!(coverage.releases_checked, 3);
    assert!(coverage.release_history_complete);
    assert!(!coverage.candidates_complete);
    assert!(
        coverage
            .reason(false)
            .unwrap()
            .contains("at most 200 files")
    );
    assert_eq!(candidates.last().unwrap().release_id, 9);
    assert_eq!(github.requests.load(Ordering::SeqCst), 4);
}

#[tokio::test]
async fn discovery_completeness_requires_the_end_of_each_selected_asset_inventory() {
    for count in [1, 200, 201] {
        let github = GithubFixture::new(archive(), None, None);
        let asset = github.assets.lock().unwrap()[0].clone();
        *github.assets.lock().unwrap() = (1..=count)
            .map(|id| {
                let mut value = asset.clone();
                value["id"] = json!(id);
                value["name"] = json!(format!("game-{id}.zip"));
                value
            })
            .collect();
        let result = github
            .provider
            .catalog_release_candidates("owner/game")
            .await;
        if count > 200 {
            assert!(
                result
                    .unwrap_err()
                    .message
                    .contains("complete 200-asset inventory bound")
            );
        } else {
            let (candidates, coverage) = result.unwrap();
            assert_eq!(candidates.len(), count);
            assert_eq!(coverage.releases_checked, 1);
            assert!(coverage.release_history_complete);
            assert!(coverage.candidates_complete);
            assert!(coverage.reason(false).is_none());
        }
    }
}

#[tokio::test]
async fn download_without_published_digest_retains_honest_provenance_and_non_owning_handoff() {
    let (_temporary, service, request) = fixture();
    let bytes = archive();
    let expected = crate::signed_catalog::digest(&bytes);
    let github = GithubFixture::new(bytes, None, None);
    let preview = service
        .catalog_download_preview_with_provider(&request, &github.provider)
        .await
        .unwrap();
    assert!(preview.artifact.sha256.is_none());
    let pending = service
        .download_catalog_package_with_provider(
            &request,
            &preview.preview_sha256,
            |_| {},
            &github.provider,
        )
        .await
        .unwrap();
    assert_eq!(pending.state, PendingSetupState::Downloaded);
    assert_eq!(pending.archive_sha256, expected);
    assert!(pending.artifact.sha256.is_none());
    assert!(pending.path.join("readme.txt").is_file());
    assert_eq!(
        service
            .pending_setup_folder(&pending.port_id, &pending.id)
            .unwrap(),
        pending.path
    );
    assert!(service.library.all_installs().unwrap().is_empty());
    assert!(service.require_no_pending_setup(&pending.port_id).is_err());
    let reopened = PortcoveService::new(service.library.clone()).unwrap();
    assert!(reopened.catalog.listing(&pending.port_id).is_err());
    let snapshot = reopened.workspace_snapshot(10).unwrap();
    assert_eq!(snapshot.pending_setups, [pending.clone()]);
    assert!(
        snapshot
            .listing_catalog
            .unwrap()
            .listings
            .iter()
            .any(|listing| listing.id == pending.port_id)
    );
    assert!(
        reopened
            .artwork(&pending.port_id, crate::ArtworkSlot::Cover)
            .is_ok()
    );
    fs::write(pending.path.join("player-save.dat"), b"my save").unwrap();
    assert!(
        reopened
            .forget_pending_setup(&pending.port_id, "stale-id")
            .is_err()
    );
    reopened
        .forget_pending_setup(&pending.port_id, &pending.id)
        .unwrap();
    assert!(reopened.pending_setups().unwrap().is_empty());
    assert_eq!(
        fs::read(pending.path.join("player-save.dat")).unwrap(),
        b"my save"
    );
    assert!(pending.path.join("readme.txt").exists());
}

#[tokio::test]
async fn complete_asset_endpoint_supplies_checksum_and_conflicts_fail_before_publication() {
    let (_temporary, service, request) = fixture();
    let bytes = archive();
    let hash = crate::signed_catalog::digest(&bytes);
    let github = GithubFixture::new(bytes.clone(), None, Some(format!("{hash}  game.zip\n")));
    let preview = service
        .catalog_download_preview_with_provider(&request, &github.provider)
        .await
        .unwrap();
    assert_eq!(preview.artifact.sha256.as_deref(), Some(hash.as_str()));
    github.assets.lock().unwrap()[0]["digest"] = json!(format!("sha256:{}", "0".repeat(64)));
    assert!(
        service
            .catalog_download_preview_with_provider(&request, &github.provider)
            .await
            .is_err()
    );
    assert!(service.pending_setups().unwrap().is_empty());
    assert!(!preview.destination_path.exists());
}

#[tokio::test]
async fn checksum_mismatch_and_cancellation_never_publish_a_setup_folder() {
    let (_temporary, service, request) = fixture();
    let github = GithubFixture::new(archive(), Some(format!("sha256:{}", "0".repeat(64))), None);
    let preview = service
        .catalog_download_preview_with_provider(&request, &github.provider)
        .await
        .unwrap();
    let error = service
        .download_catalog_package_with_provider(
            &request,
            &preview.preview_sha256,
            |_| {},
            &github.provider,
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, crate::ErrorCode::Verification);
    assert!(!preview.destination_path.exists());
    let pending = service.pending_setups().unwrap().pop().unwrap();
    assert_eq!(pending.state, PendingSetupState::AttentionRequired);
    assert!(
        service
            .pending_setup_folder(&pending.port_id, &pending.id)
            .is_err()
    );
    service
        .forget_pending_setup(&pending.port_id, &pending.id)
        .unwrap();
    github.assets.lock().unwrap()[0]["digest"] = Value::Null;
    let preview = service
        .catalog_download_preview_with_provider(&request, &github.provider)
        .await
        .unwrap();
    let mut requested = false;
    let error = service
        .download_catalog_package_with_provider(
            &request,
            &preview.preview_sha256,
            |event| {
                if !requested && matches!(event.event, crate::OperationEventKind::Progress { .. }) {
                    service.request_cancellation(&event.operation_id).unwrap();
                    requested = true;
                }
            },
            &github.provider,
        )
        .await
        .unwrap_err();
    assert!(requested);
    assert_eq!(error.code, crate::ErrorCode::Cancelled);
    assert!(!preview.destination_path.exists());
    assert!(
        !fs::read_dir(&request.destination_parent)
            .unwrap()
            .any(|entry| entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".portcove-download-"))
    );
}

#[tokio::test]
async fn stale_review_and_occupied_or_library_destination_are_refused() {
    let (_temporary, service, mut request) = fixture();
    let github = GithubFixture::new(archive(), None, None);
    let preview = service
        .catalog_download_preview_with_provider(&request, &github.provider)
        .await
        .unwrap();
    github.assets.lock().unwrap()[0]["name"] = json!("renamed.zip");
    assert!(
        service
            .download_catalog_package_with_provider(
                &request,
                &preview.preview_sha256,
                |_| {},
                &github.provider
            )
            .await
            .is_err()
    );
    assert!(service.pending_setups().unwrap().is_empty());
    fs::create_dir(&preview.destination_path).unwrap();
    fs::write(preview.destination_path.join("keep.txt"), b"keep").unwrap();
    assert!(
        service
            .catalog_download_preview_with_provider(&request, &github.provider)
            .await
            .is_err()
    );
    assert_eq!(
        fs::read(preview.destination_path.join("keep.txt")).unwrap(),
        b"keep"
    );
    request.destination_parent = service.library.root().to_path_buf();
    let before = github.requests.load(Ordering::SeqCst);
    assert!(
        service
            .catalog_download_preview_with_provider(&request, &github.provider)
            .await
            .is_err()
    );
    assert_eq!(github.requests.load(Ordering::SeqCst), before);
}

fn intent(
    service: &PortcoveService,
    request: &CatalogDownloadRequest,
) -> (PendingSetupRecord, tempfile::TempDir, String) {
    let stage = tempfile::Builder::new()
        .prefix(".portcove-download-")
        .tempdir_in(&request.destination_parent)
        .unwrap();
    let record = PendingSetupRecord {
        id: Uuid::new_v4().to_string(),
        port_id: request.port_id.clone(),
        listing: service.catalog.listing(&request.port_id).unwrap().clone(),
        path: service.download_destination(request).unwrap(),
        state: PendingSetupState::AttentionRequired,
        artifact: CatalogDownloadCandidate {
            release_id: request.release_id,
            asset_id: request.asset_id,
            release_tag: "v1".into(),
            release_url: "https://github.com/owner/game/releases/tag/v1".into(),
            name: "game.zip".into(),
            size: 1,
            download_url: "https://github.com/owner/game/releases/download/v1/game.zip".into(),
            sha256: None,
            can_extract: true,
        },
        archive_sha256: "a".repeat(64),
        downloaded_at: "2026-10-22T00:00:00Z".into(),
        reason: None,
    };
    let review = "b".repeat(64);
    service
        .insert_catalog_download(&record, stage.path(), &review, &Uuid::new_v4().to_string())
        .unwrap();
    service
        .update_catalog_download(&record, "publication-intent", false)
        .unwrap();
    (record, stage, review)
}

#[test]
fn pending_record_writers_bound_utf8_bytes_and_preserve_readable_rows() {
    let (_temporary, service, request) = fixture();
    let (record, stage, review) = intent(&service, &request);
    let mut oversized = record.clone();
    let unicode = "界".repeat(1300);
    oversized.listing.summary = unicode.clone();
    oversized.listing.manual_setup = Some(
        serde_json::from_value(json!({
            "steps": (0..8).map(|_| json!({"title":"Setup", "instruction":unicode})).collect::<Vec<_>>(),
            "warnings": vec![unicode; 8]
        }))
        .unwrap(),
    );
    validate_record(&oversized).unwrap();
    let json = serde_json::to_string(&oversized).unwrap();
    assert!(json.len() > RECORD_LIMIT);
    assert!(json.chars().count() < RECORD_LIMIT);
    assert!(
        service
            .insert_catalog_download(
                &oversized,
                stage.path(),
                &review,
                &Uuid::new_v4().to_string()
            )
            .unwrap_err()
            .message
            .contains("UTF-8 byte limit")
    );
    assert!(
        service
            .update_catalog_download(&oversized, "attention-required", false)
            .is_err()
    );
    // The schema uses byte length too, rather than SQLite's character count.
    assert!(
        service
            .library
            .connection()
            .unwrap()
            .execute(
                "UPDATE catalog_downloads SET record_json=?1 WHERE port_id=?2",
                params![json, record.port_id],
            )
            .is_err()
    );
    assert_eq!(service.pending_setups().unwrap(), vec![record.clone()]);

    let mut boundary = oversized;
    boundary.listing.summary = "s".repeat(3900);
    let guide = boundary.listing.manual_setup.as_mut().unwrap();
    for step in &mut guide.steps {
        step.instruction = "i".repeat(3500);
    }
    guide.warnings = vec!["w".repeat(3500); 8];
    boundary.reason = Some(String::new());
    let remaining = RECORD_LIMIT - serde_json::to_string(&boundary).unwrap().len();
    assert!(remaining < 8192);
    boundary.reason = Some("r".repeat(remaining));
    assert_eq!(
        encoded_download_record(&boundary).unwrap().len(),
        RECORD_LIMIT
    );
    service
        .update_catalog_download(&boundary, "attention-required", false)
        .unwrap();
    assert_eq!(service.pending_setups().unwrap(), vec![boundary.clone()]);
    let mut one_byte_more = boundary.clone();
    one_byte_more.reason.as_mut().unwrap().push('r');
    assert!(
        service
            .update_catalog_download(&one_byte_more, "attention-required", false)
            .is_err()
    );
    assert_eq!(service.pending_setups().unwrap(), vec![boundary]);
}

#[test]
fn pending_storage_capacity_counts_insertions_and_replacements_in_bytes() {
    // Exercise the storage inventory bounds independently of the semantic record
    // validator, with one writer transaction for each projected replacement.
    let mut connection = rusqlite::Connection::open_in_memory().unwrap();
    connection
        .execute_batch(
            "CREATE TABLE catalog_downloads(port_id TEXT PRIMARY KEY, record_json TEXT NOT NULL)",
        )
        .unwrap();
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .unwrap();
    let full = format!("\"{}\"", "x".repeat(RECORD_LIMIT - 2));
    for index in 0..TOTAL_RECORD_BYTES / RECORD_LIMIT {
        transaction
            .execute(
                "INSERT INTO catalog_downloads VALUES(?1,?2)",
                params![index.to_string(), full],
            )
            .unwrap();
    }
    assert!(require_download_record_capacity(&transaction, "another", "{}").is_err());
    assert!(require_download_record_capacity(&transaction, "0", &full).is_ok());
    transaction
        .execute("DELETE FROM catalog_downloads WHERE port_id='0'", [])
        .unwrap();
    assert!(require_download_record_capacity(&transaction, "another", &full).is_ok());
    assert!(
        require_download_record_capacity(&transaction, "another", &(full.clone() + " ")).is_err()
    );
    transaction
        .execute("DELETE FROM catalog_downloads", [])
        .unwrap();
    for index in 0..RECORDS_LIMIT {
        transaction
            .execute(
                "INSERT INTO catalog_downloads VALUES(?1,'{}')",
                [index.to_string()],
            )
            .unwrap();
    }
    assert!(require_download_record_capacity(&transaction, "another", "{}").is_err());
    assert!(require_download_record_capacity(&transaction, "0", "{}").is_ok());
}

#[test]
fn restart_finishes_proven_handoff_but_never_adopts_or_deletes_a_collision() {
    let (_temporary, service, request) = fixture();
    let (record, stage, review) = intent(&service, &request);
    let payload = stage.path().join("payload");
    fs::create_dir(&payload).unwrap();
    fs::write(payload.join("game.dat"), b"downloaded").unwrap();
    crate::durability::write_json_atomically(
        &payload.join(RECEIPT_NAME),
        &PublicationReceipt {
            format_version: 1,
            pending_id: record.id.clone(),
            port_id: record.port_id.clone(),
            preview_sha256: review,
            archive_sha256: record.archive_sha256.clone(),
        },
        false,
    )
    .unwrap();
    crate::durability::rename_noreplace(&payload, &record.path).unwrap();
    drop(stage);
    let reopened = PortcoveService::new(service.library.clone()).unwrap();
    let completed = reopened.pending_setups().unwrap().pop().unwrap();
    assert_eq!(completed.state, PendingSetupState::Downloaded);
    assert_eq!(completed.archive_sha256, record.archive_sha256);
    reopened
        .forget_pending_setup(&record.port_id, &record.id)
        .unwrap();
    // A different operation with an occupied destination cannot interpret those
    // existing user bytes as its own published folder, even on restart.
    let mut another = request.clone();
    another.asset_id = 22;
    let (other, stage, _) = intent(&service, &another);
    fs::create_dir(&other.path).unwrap();
    fs::write(other.path.join("keep.dat"), b"mine").unwrap();
    drop(stage);
    let reopened = PortcoveService::new(service.library.clone()).unwrap();
    let held = reopened.pending_setups().unwrap().pop().unwrap();
    assert_eq!(held.state, PendingSetupState::AttentionRequired);
    assert!(
        reopened
            .pending_setup_folder(&other.port_id, &other.id)
            .is_err()
    );
    reopened
        .forget_pending_setup(&other.port_id, &other.id)
        .unwrap();
    assert_eq!(fs::read(other.path.join("keep.dat")).unwrap(), b"mine");
    assert_eq!(
        fs::read(record.path.join("game.dat")).unwrap(),
        b"downloaded"
    );
}

#[test]
fn continuation_registration_uses_retained_listing_and_consumes_only_matching_pending_identity() {
    let (_temporary, mut service, request) = fixture();
    let (record, stage, _) = intent(&service, &request);
    // Upstream's native installer can place the executable elsewhere. The
    // explicit user intent binds that exact executable and CWD, not an inferred
    // relationship to the downloaded package's folder.
    let working = request.destination_parent.join("upstream-installed");
    fs::create_dir(&working).unwrap();
    let executable = crate::test_fixture::build_probe(&working);
    fs::write(working.join("save.dat"), b"mine").unwrap();
    let preview = service
        .preview_user_selected_runtime(&record.port_id, &executable, &working, &[])
        .unwrap();
    let authorization = service
        .authorize_user_selected_runtime(
            &record.port_id,
            &executable,
            &working,
            &[],
            &preview.preview_sha256,
        )
        .unwrap();
    service
        .forget_pending_setup(&record.port_id, &record.id)
        .unwrap();
    let (replacement, replacement_stage, _) = intent(&service, &request);
    assert!(
        service
            .register_user_selected_runtime(
                &record.port_id,
                &executable,
                &working,
                &[],
                &authorization.token
            )
            .is_err()
    );
    assert_eq!(service.pending_setups().unwrap()[0].id, replacement.id);
    service.catalog =
        Catalog::from_json(r#"{"schema_version":1,"source_profiles":[],"ports":[]}"#).unwrap();
    let preview = service
        .preview_user_selected_runtime(&record.port_id, &executable, &working, &[])
        .unwrap();
    let authorization = service
        .authorize_user_selected_runtime(
            &record.port_id,
            &executable,
            &working,
            &[],
            &preview.preview_sha256,
        )
        .unwrap();
    let selected = service
        .register_user_selected_runtime(
            &record.port_id,
            &executable,
            &working,
            &[],
            &authorization.token,
        )
        .unwrap();
    assert_eq!(selected.port_id, record.port_id);
    assert!(service.pending_setups().unwrap().is_empty());
    assert!(service.library.all_installs().unwrap().is_empty());
    assert_eq!(fs::read(working.join("save.dat")).unwrap(), b"mine");
    assert!(executable.exists());
    assert!(stage.path().exists() && replacement_stage.path().exists());
}

#[test]
fn workspace_retains_legacy_registered_description_without_new_listing_revalidation() {
    let (_temporary, service, request) = fixture();
    let platform = serde_json::to_value(Platform::current().unwrap())
        .unwrap()
        .as_str()
        .unwrap()
        .to_owned();
    let legacy = Catalog::from_json(&json!({
        "schema_version":1,"source_profiles":[],"ports":[{
            "id":"retained-legacy-listing","name":"Legacy selected runtime","summary":"",
            "project_url":"https://example.com/upstream","support_tier":"beta","channels":["stable"],
            "platforms":[Platform::current().unwrap()],"adapter":"staged-source-portable",
            "release":{"provider":"user-prepared","user_prepared":{
                (platform):{"trust":"user-selected","version":"user-managed","archive_name":"","archive_size":0,
                    "archive_sha256":"","immutable_tree_sha256":"","executable":"","mutable_paths":[]}
            }}
        }]
    }).to_string()).unwrap();
    let record = ExternalRuntimeRecord {
        id: Uuid::new_v4().to_string(),
        port_id: "retained-legacy-listing".into(),
        path: request.destination_parent,
        executable: std::env::current_exe().unwrap(),
        version: "user-managed".into(),
        platform: Platform::current().unwrap(),
        archive_sha256: String::new(),
        immutable_tree_sha256: String::new(),
        registered_at: Library::now(),
        retained_definition: None,
        shared_preferences: None,
        user_selected: Some(crate::UserSelectedLaunch { arguments: vec![] }),
    };
    service
        .library
        .register_external_runtime(&record, &legacy)
        .unwrap();
    let snapshot = service.workspace_snapshot(10).unwrap();
    assert!(
        snapshot
            .listing_catalog
            .unwrap()
            .listings
            .iter()
            .find(|listing| listing.id == record.port_id)
            .unwrap()
            .summary
            .is_empty()
    );
    assert!(
        snapshot
            .listing_statuses
            .iter()
            .any(|status| status.port_id == record.port_id
                && status.status.external_runtime.is_some())
    );
}
