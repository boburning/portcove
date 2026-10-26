use super::*;
use crate::{ErrorCode, ReleaseAsset};
use std::{
    net::TcpListener,
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::Duration,
};

const PORT: &str = "acquisition-fixture";
struct Provider(ResolvedRelease);
#[async_trait::async_trait]
impl ReleaseProvider for Provider {
    async fn resolve(
        &self,
        _: &PortDefinition,
        channel: ReleaseChannel,
        _: Platform,
    ) -> Result<ResolvedRelease> {
        let mut release = self.0.clone();
        release.channel = channel;
        Ok(release)
    }
}
struct Server {
    url: String,
    arrived: Arc<AtomicBool>,
    released: Arc<AtomicBool>,
    stopped: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}
impl Server {
    fn new(bytes: Vec<u8>, gated: bool) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let arrived = Arc::new(AtomicBool::new(false));
        let released = Arc::new(AtomicBool::new(!gated));
        let stopped = Arc::new(AtomicBool::new(false));
        let a = arrived.clone();
        let r = released.clone();
        let stop = stopped.clone();
        let worker = thread::spawn(move || {
            let mut stream = loop {
                if stop.load(Ordering::SeqCst) {
                    return;
                }
                match listener.accept() {
                    Ok((stream, _)) => break stream,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2))
                    }
                    Err(error) => panic!("{error}"),
                }
            };
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut request = [0; 4096];
            let _ = stream.read(&mut request);
            let _ = write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                bytes.len()
            );
            let _ = stream.flush();
            a.store(true, Ordering::SeqCst);
            while !r.load(Ordering::SeqCst) && !stop.load(Ordering::SeqCst) {
                thread::sleep(Duration::from_millis(2));
            }
            if !stop.load(Ordering::SeqCst) {
                let _ = stream.write_all(&bytes);
            }
        });
        Self {
            url: format!("http://{address}/update.zip"),
            arrived,
            released,
            stopped,
            worker: Some(worker),
        }
    }
    fn release(&self) {
        self.released.store(true, Ordering::SeqCst);
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::SeqCst);
        self.release();
        if let Some(worker) = self.worker.take() {
            worker.join().unwrap();
        }
    }
}
fn archive() -> Vec<u8> {
    let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    writer
        .start_file(
            "game.exe",
            zip::write::SimpleFileOptions::default().unix_permissions(0o755),
        )
        .unwrap();
    writer.write_all(b"future runtime fixture").unwrap();
    writer.finish().unwrap().into_inner()
}
fn catalog() -> Catalog {
    let platform = serde_json::to_value(Platform::current().unwrap())
        .unwrap()
        .as_str()
        .unwrap()
        .to_owned();
    Catalog::from_json(&serde_json::json!({"schema_version":1,"source_profiles":[],"ports":[{
        "id":PORT,"name":"Immutable acquisition fixture","summary":"Inert exact-byte update control",
        "project_url":"https://example.invalid/fixture","support_tier":"beta","channels":["stable","beta"],
        "platforms":[Platform::current().unwrap()],"adapter":"staged-source-portable","release":{"repository":"fixture/game"},
        "executable_hints":{(platform):["game.exe"]},"persistent_paths":["saves"]
    }]}).to_string()).unwrap()
}
struct TraceLaunch;
impl LifecycleFaultInjector for TraceLaunch {
    fn check(&self, point: LifecycleFaultPoint) -> Result<()> {
        eprintln!("acquisition launch fixture phase: {point:?}");
        Ok(())
    }
}
fn fixture(gated: bool, native: bool) -> (tempfile::TempDir, PortcoveService, Server) {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let catalog = catalog();
    let mut active = crate::test_fixture::register_qualification_install(&library, &catalog, PORT);
    if native {
        let probe = crate::test_fixture::build_probe(temporary.path());
        fs::copy(probe, active.path.join("game.exe")).unwrap();
        crate::permissions::normalize_archive_entry(&active.path.join("game.exe"), false, true)
            .unwrap();
        let qualification =
            InstallQualification::from_catalog(&catalog, PORT, Platform::current().unwrap())
                .unwrap();
        let (hash, _, _) = Installer::new(library.clone())
            .unwrap()
            .create_manifest(
                &active.id,
                PORT,
                &active.version,
                &active.artifact,
                &qualification,
                &active.path,
            )
            .unwrap();
        active.manifest_sha256 = hash;
        library.update_install_manifest(&active).unwrap();
    }
    let bytes = archive();
    let server = Server::new(bytes.clone(), gated);
    let release = ResolvedRelease {
        version: "v2".into(),
        channel: ReleaseChannel::Stable,
        published_at: None,
        asset: ReleaseAsset {
            name: "update.zip".into(),
            url: server.url.clone(),
            size: bytes.len() as u64,
            sha256: crate::signed_catalog::digest(&bytes),
        },
    };
    let mut service = PortcoveService::with_provider(library, Arc::new(Provider(release))).unwrap();
    service.catalog = catalog;
    if native {
        service.faults = Arc::new(TraceLaunch);
    }
    (temporary, service, server)
}
async fn grant(service: &PortcoveService) -> crate::DestructiveAuthorization {
    let plan = service.plan_game_update_acquisition(PORT).await.unwrap();
    service
        .authorize_game_update_acquisition(PORT, &plan.plan_sha256)
        .await
        .unwrap()
}
async fn arrived(server: &Server) {
    tokio::time::timeout(Duration::from_secs(10), async {
        while !server.arrived.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn acquired_archive_survives_restart_and_requires_fresh_exclusive_apply_review() {
    let (_temporary, service, _server) = fixture(false, false);
    let original = service.status(PORT).unwrap().active.unwrap();
    let stale = service.plan_game_update(PORT, false).await.unwrap();
    let stale_grant = service
        .authorize_game_update(PORT, false, &stale.plan_sha256)
        .await
        .unwrap();
    let authorization = grant(&service).await;
    let acquired = service
        .acquire_game_update(PORT, &authorization.token, |_| {})
        .await
        .unwrap();
    assert_eq!(acquired.phase, Phase::Acquired);
    let status = service.status(PORT).unwrap();
    assert_eq!(status.active.unwrap().id, original.id);
    assert!(status.staged.is_none());
    assert!(status.previous.is_none());
    assert_eq!(
        service
            .apply_game_update(PORT, false, &stale_grant.token, |_| {})
            .await
            .unwrap_err()
            .code,
        ErrorCode::Conflict
    );
    let mut reopened = PortcoveService::with_provider(
        Library::open(service.library.root()).unwrap(),
        service.releases.clone(),
    )
    .unwrap();
    reopened.catalog = service.catalog.clone();
    assert_eq!(
        reopened.status(PORT).unwrap().acquisition.unwrap().id,
        acquired.id
    );
    let feed = reopened.library.activity_feed(1).unwrap();
    assert!(feed.records.iter().any(|record| record.id == acquired.id));
    assert!(!feed.recovery_required_activity_ids.contains(&acquired.id));
    let reviewed = reopened.plan_game_update(PORT, false).await.unwrap();
    assert_eq!(reviewed.acquisition.unwrap().id, acquired.id);
    let consent = reopened
        .authorize_game_update(PORT, false, &reviewed.plan_sha256)
        .await
        .unwrap();
    let filework = reopened
        .library
        .try_lock_port(PORT, "verify-file-work")
        .unwrap();
    assert_eq!(
        reopened
            .apply_game_update(PORT, false, &consent.token, |_| {})
            .await
            .unwrap_err()
            .code,
        ErrorCode::Conflict
    );
    assert_eq!(
        reopened.status(PORT).unwrap().active.unwrap().id,
        original.id
    );
    drop(filework);
    let staged = reopened
        .apply_game_update(PORT, false, &consent.token, |_| {})
        .await
        .unwrap();
    assert!(staged.staged);
    assert_eq!(
        reopened.status(PORT).unwrap().active.unwrap().id,
        original.id
    );
    // Server accepts only one transfer; successful preparation therefore reused the exact archive.
    assert!(reopened.verify(PORT).unwrap().valid);
    fs::write(
        file(&root(&reopened.library, &acquired.id).unwrap(), 0),
        b"obsolete archive damage",
    )
    .unwrap();
    let staged_review = reopened.plan_game_update(PORT, true).await.unwrap();
    assert!(staged_review.acquisition.is_none());
    let staged_consent = reopened
        .authorize_game_update(PORT, true, &staged_review.plan_sha256)
        .await
        .unwrap();
    assert_eq!(
        reopened
            .apply_game_update(PORT, true, &staged_consent.token, |_| {})
            .await
            .unwrap()
            .id,
        staged.id
    );
    reopened
        .discard_game_update_acquisition(PORT, &acquired.id)
        .unwrap();
    assert!(reopened.status(PORT).unwrap().acquisition.is_none());
    assert!(staged.path.exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn launch_during_stalled_acquisition_and_finish_while_game_runs() {
    let (temporary, service, server) = fixture(true, true);
    let service = Arc::new(service);
    let authorization = grant(&service).await;
    let worker_service = service.clone();
    let transfer = tokio::spawn(async move {
        worker_service
            .acquire_game_update(PORT, &authorization.token, |_| {})
            .await
    });
    arrived(&server).await;
    let current = service.status(PORT).unwrap().active.unwrap();
    let id = service.status(PORT).unwrap().acquisition.unwrap().id;
    assert_eq!(
        service
            .discard_game_update_acquisition(PORT, &id)
            .unwrap_err()
            .code,
        ErrorCode::Conflict
    );
    // A second client recovery scan cannot discard live private bytes.
    service.recover_pending_operations().unwrap();
    assert_eq!(
        service.status(PORT).unwrap().acquisition.unwrap().phase,
        Phase::Acquiring
    );
    let release_game = temporary.path().join("release-game");
    let args = vec![
        "--game".into(),
        "--owned-wait".into(),
        release_game.display().to_string(),
    ];
    let launch_service = service.clone();
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let launch = tokio::task::spawn_blocking(move || {
        launch_service.supervise_launch_identified(
            IdentifiedLaunchRequest {
                request_id: &Uuid::new_v4().to_string(),
                port_id: PORT,
                source_override: None,
                arguments: &args,
                stdio: LaunchStdio::Null,
            },
            |_| {},
            |_| {
                let _ = started_tx.send(());
            },
        )
    });
    let observed_start = tokio::time::timeout(Duration::from_secs(30), started_rx).await;
    if !matches!(observed_start, Ok(Ok(()))) {
        fs::write(&release_game, b"release after failed start observation").unwrap();
        server.release();
        let outcome = launch.await.unwrap();
        panic!("launch start observation failed: {observed_start:?}; actual launch: {outcome:?}");
    }
    server.release();
    let acquired = transfer.await.unwrap().unwrap();
    assert_eq!(acquired.phase, Phase::Acquired);
    assert!(!launch.is_finished());
    let status = service.status(PORT).unwrap();
    assert_eq!(status.active.unwrap().id, current.id);
    assert!(status.staged.is_none());
    assert!(status.previous.is_none());
    assert_eq!(
        service.plan_game_update(PORT, true).await.unwrap_err().code,
        ErrorCode::Conflict
    );
    fs::write(release_game, b"release").unwrap();
    assert!(launch.await.unwrap().unwrap().successful);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn immutable_acquisition_can_start_after_verified_game_is_already_running() {
    let (temporary, service, server) = fixture(true, true);
    let service = Arc::new(service);
    let release_game = temporary.path().join("release-game");
    let args = vec![
        "--game".into(),
        "--owned-wait".into(),
        release_game.display().to_string(),
    ];
    let launch_service = service.clone();
    let (tx, rx) = tokio::sync::oneshot::channel();
    let launch = tokio::task::spawn_blocking(move || {
        launch_service.supervise_launch_identified(
            IdentifiedLaunchRequest {
                request_id: &Uuid::new_v4().to_string(),
                port_id: PORT,
                source_override: None,
                arguments: &args,
                stdio: LaunchStdio::Null,
            },
            |_| {},
            |_| {
                let _ = tx.send(());
            },
        )
    });
    let observed_start = tokio::time::timeout(Duration::from_secs(30), rx).await;
    if !matches!(observed_start, Ok(Ok(()))) {
        fs::write(&release_game, b"release after failed start observation").unwrap();
        let outcome = launch.await.unwrap();
        panic!("launch start observation failed: {observed_start:?}; actual launch: {outcome:?}");
    }
    let authorization = grant(&service).await;
    let worker_service = service.clone();
    let transfer = tokio::spawn(async move {
        worker_service
            .acquire_game_update(PORT, &authorization.token, |_| {})
            .await
    });
    arrived(&server).await;
    server.release();
    assert_eq!(transfer.await.unwrap().unwrap().phase, Phase::Acquired);
    assert!(!launch.is_finished());
    fs::write(release_game, b"release").unwrap();
    assert!(launch.await.unwrap().unwrap().successful);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancellation_retains_bounded_attention_and_exact_discard_allows_retry() {
    let (_temporary, service, server) = fixture(true, false);
    let service = Arc::new(service);
    let authorization = grant(&service).await;
    let worker_service = service.clone();
    let task = tokio::spawn(async move {
        worker_service
            .acquire_game_update(PORT, &authorization.token, |_| {})
            .await
    });
    arrived(&server).await;
    let id = service.status(PORT).unwrap().acquisition.unwrap().id;
    service.request_cancellation(&id).unwrap();
    assert_eq!(task.await.unwrap().unwrap_err().code, ErrorCode::Cancelled);
    assert_eq!(
        service.status(PORT).unwrap().acquisition.unwrap().phase,
        Phase::AttentionRequired
    );
    service.recover_pending_operations().unwrap();
    assert_eq!(
        service
            .authorize_game_update_acquisition(PORT, "stale")
            .await
            .unwrap_err()
            .code,
        ErrorCode::Conflict
    );
    service.discard_game_update_acquisition(PORT, &id).unwrap();
    assert!(service.plan_game_update_acquisition(PORT).await.is_ok());
}

#[tokio::test]
async fn corrupt_archive_and_changed_source_definition_never_publish_runtime() {
    let (_temporary, mut service, _server) = fixture(false, false);
    let authorization = grant(&service).await;
    let acquired = service
        .acquire_game_update(PORT, &authorization.token, |_| {})
        .await
        .unwrap();
    let reviewed = service.plan_game_update(PORT, true).await.unwrap();
    let consent = service
        .authorize_game_update(PORT, true, &reviewed.plan_sha256)
        .await
        .unwrap();
    let archive = file(&root(&service.library, &acquired.id).unwrap(), 0);
    fs::write(&archive, b"wrong bytes").unwrap();
    assert_eq!(
        service
            .apply_game_update(PORT, true, &consent.token, |_| {})
            .await
            .unwrap_err()
            .code,
        ErrorCode::Verification
    );
    assert!(service.status(PORT).unwrap().staged.is_none());
    let mut document = service.catalog.authoritative_document();
    document.ports[0].summary.push_str(" changed definition");
    service.catalog = Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap();
    assert!(
        service
            .plan_game_update(PORT, true)
            .await
            .unwrap()
            .acquisition
            .is_none()
    );
    service
        .discard_game_update_acquisition(PORT, &acquired.id)
        .unwrap();
}

#[tokio::test]
async fn unregistered_source_requirement_cannot_be_bypassed_by_acquisition() {
    let (_temporary, mut service, server) = fixture(false, false);
    let mut document = service.catalog.authoritative_document();
    document.source_profiles = vec![serde_json::from_value(serde_json::json!({"id":"acquisition-original","label":"Original fixture input","accepted_extensions":["bin"],"accepted_sha256":["a".repeat(64)]})).unwrap()];
    document.ports[0].source_profile = Some("acquisition-original".into());
    service.catalog = Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap();
    let failure = service
        .plan_game_update_acquisition(PORT)
        .await
        .unwrap_err();
    assert_eq!(failure.code, ErrorCode::Verification);
    assert!(!server.arrived.load(Ordering::SeqCst));
    assert!(service.status(PORT).unwrap().acquisition.is_none());
}

#[tokio::test]
async fn foreign_members_or_wrong_resource_discard_refuse_before_removing_bytes() {
    let (_temporary, service, _server) = fixture(false, false);
    let authorization = grant(&service).await;
    let acquired = service
        .acquire_game_update(PORT, &authorization.token, |_| {})
        .await
        .unwrap();
    let private = root(&service.library, &acquired.id).unwrap();
    let original = fs::read(file(&private, 0)).unwrap();
    fs::write(private.join("foreign-save"), b"preserve").unwrap();
    assert!(
        service
            .discard_game_update_acquisition(PORT, &acquired.id)
            .is_err()
    );
    assert_eq!(fs::read(file(&private, 0)).unwrap(), original);
    assert!(service.status(PORT).unwrap().acquisition.is_some());
    fs::remove_file(private.join("foreign-save")).unwrap();
    assert!(
        service
            .discard_game_update_acquisition("other-port", &acquired.id)
            .is_err()
    );
    assert_eq!(fs::read(file(&private, 0)).unwrap(), original);
    service
        .discard_game_update_acquisition(PORT, &acquired.id)
        .unwrap();
}

#[tokio::test]
async fn interrupted_acquisition_becomes_attention_without_auto_preparing_or_activating() {
    let (_temporary, service, _server) = fixture(false, false);
    let authorization = grant(&service).await;
    let acquired = service
        .acquire_game_update(PORT, &authorization.token, |_| {})
        .await
        .unwrap();
    let store = OperationStore::new(service.library.clone());
    let mut record = store.get(&acquired.id).unwrap().unwrap();
    record.update_acquisition.as_mut().unwrap().view.phase = Phase::Verifying;
    store.put(&mut record).unwrap();
    service.recover_pending_operations().unwrap();
    assert_eq!(
        service.status(PORT).unwrap().acquisition.unwrap().phase,
        Phase::AttentionRequired
    );
    assert!(service.status(PORT).unwrap().staged.is_none());
    assert!(root(&service.library, &acquired.id).unwrap().exists());
    service
        .discard_game_update_acquisition(PORT, &acquired.id)
        .unwrap();
}

#[tokio::test]
async fn acquisition_slot_and_bundled_asset_reservations_are_atomic_and_bounded() {
    let (_temporary, service, _server) = fixture(false, false);
    let authorization = grant(&service).await;
    let acquired = service
        .acquire_game_update(PORT, &authorization.token, |_| {})
        .await
        .unwrap();
    let store = OperationStore::new(service.library.clone());
    let record = store.get(&acquired.id).unwrap().unwrap();
    let mut duplicate = record.clone();
    duplicate.id = Uuid::new_v4().to_string();
    duplicate.paths.staging = Some(root(&service.library, &duplicate.id).unwrap());
    duplicate.update_acquisition.as_mut().unwrap().view.id = duplicate.id.clone();
    assert_eq!(
        store.put(&mut duplicate).unwrap_err().code,
        ErrorCode::Conflict
    );
    let mut oversized = record.clone();
    let payload = oversized.update_acquisition.as_mut().unwrap();
    payload.assets.push(ReleaseAsset {
        name: "runtime.zip".into(),
        url: "https://example.invalid/runtime.zip".into(),
        size: MAX_BYTES,
        sha256: "a".repeat(64),
    });
    assert!(store.put(&mut oversized).is_err());
    assert_eq!(
        service.status(PORT).unwrap().acquisition.unwrap().id,
        acquired.id
    );
}

#[tokio::test]
async fn capacity_counts_partial_rows_across_ports_and_refuses_overlong_metadata() {
    let (_temporary, service, _server) = fixture(false, false);
    let authorization = grant(&service).await;
    let acquired = service
        .acquire_game_update(PORT, &authorization.token, |_| {})
        .await
        .unwrap();
    let store = OperationStore::new(service.library.clone());
    let mut record = store.get(&acquired.id).unwrap().unwrap();
    let mut long = record.clone();
    long.update_acquisition
        .as_mut()
        .unwrap()
        .view
        .release
        .version = "x".repeat(MAX_RECORD_BYTES);
    assert_eq!(store.put(&mut long).unwrap_err().code, ErrorCode::Conflict);
    let connection = Connection::open_in_memory().unwrap();
    connection.execute_batch("CREATE TABLE lifecycle_operations(id TEXT,kind TEXT,port_id TEXT,update_acquisition_json TEXT)").unwrap();
    for index in 0..MAX_RECORDS {
        let mut partial = record.update_acquisition.clone().unwrap();
        partial.view.id = Uuid::new_v4().to_string();
        partial.view.port_id = format!("partial-{index}");
        partial.view.phase = Phase::Acquiring;
        partial.assets[0].size = 1;
        partial.view.release.asset.size = 1;
        connection
            .execute(
                "INSERT INTO lifecycle_operations VALUES(?1,'acquire_update',?2,?3)",
                rusqlite::params![
                    partial.view.id,
                    partial.view.port_id,
                    serde_json::to_string(&partial).unwrap()
                ],
            )
            .unwrap();
    }
    assert_eq!(
        require_capacity(
            &connection,
            &record,
            Some(&serde_json::to_string(record.update_acquisition.as_ref().unwrap()).unwrap())
        )
        .unwrap_err()
        .code,
        ErrorCode::Conflict
    );
    connection
        .execute("DELETE FROM lifecycle_operations", [])
        .unwrap();
    let mut partial = record.update_acquisition.clone().unwrap();
    partial.view.id = Uuid::new_v4().to_string();
    partial.view.port_id = "other-port".into();
    partial.view.phase = Phase::Verifying;
    partial.assets[0].size = MAX_BYTES - 1;
    partial.view.release.asset.size = MAX_BYTES - 1;
    connection
        .execute(
            "INSERT INTO lifecycle_operations VALUES(?1,'acquire_update',?2,?3)",
            rusqlite::params![
                partial.view.id,
                partial.view.port_id,
                serde_json::to_string(&partial).unwrap()
            ],
        )
        .unwrap();
    record.update_acquisition.as_mut().unwrap().assets[0].size = 2;
    assert_eq!(
        require_capacity(
            &connection,
            &record,
            Some(&serde_json::to_string(record.update_acquisition.as_ref().unwrap()).unwrap())
        )
        .unwrap_err()
        .code,
        ErrorCode::Conflict
    );
    assert_eq!(
        store
            .get(&acquired.id)
            .unwrap()
            .unwrap()
            .update_acquisition
            .unwrap()
            .view,
        acquired
    );
}

#[tokio::test]
async fn acquired_archive_cannot_bypass_changed_original_source_bytes() {
    let (temporary, mut service, _server) = fixture(false, false);
    let original = b"accepted original source fixture";
    let source_path = temporary.path().join("original.bin");
    fs::write(&source_path, original).unwrap();
    let mut document = service.catalog.authoritative_document();
    document.source_profiles=vec![serde_json::from_value(serde_json::json!({"id":"acquisition-original","label":"Original fixture input","accepted_extensions":["bin"],"accepted_sha256":[crate::signed_catalog::digest(original)]})).unwrap()];
    document.ports[0].source_profile = Some("acquisition-original".into());
    service.catalog = Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap();
    service
        .register_source("acquisition-original", &source_path)
        .unwrap();
    let authorization = grant(&service).await;
    let acquired = service
        .acquire_game_update(PORT, &authorization.token, |_| {})
        .await
        .unwrap();
    let reviewed = service.plan_game_update(PORT, true).await.unwrap();
    assert!(reviewed.acquisition.is_some());
    let consent = service
        .authorize_game_update(PORT, true, &reviewed.plan_sha256)
        .await
        .unwrap();
    fs::write(&source_path, b"changed source bytes").unwrap();
    let error = service
        .apply_game_update(PORT, true, &consent.token, |_| {})
        .await
        .unwrap_err();
    assert!(
        matches!(
            error.code,
            ErrorCode::SourceInvalid | ErrorCode::Verification
        ),
        "{error}"
    );
    assert!(service.status(PORT).unwrap().staged.is_none());
    assert_eq!(
        service.status(PORT).unwrap().active.unwrap().version,
        "qualification-definition-1"
    );
    service
        .discard_game_update_acquisition(PORT, &acquired.id)
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn live_and_completed_acquisitions_block_library_move_with_exact_discard_resume() {
    let (temporary, service, server) = fixture(true, false);
    let service = Arc::new(service);
    let destination = temporary.path().join("moved-library");
    let source = service.library.root().to_path_buf();
    let authorization = grant(&service).await;
    let worker_service = service.clone();
    let transfer = tokio::spawn(async move {
        worker_service
            .acquire_game_update(PORT, &authorization.token, |_| {})
            .await
    });
    arrived(&server).await;
    let acquisition = service.status(PORT).unwrap().acquisition.unwrap();
    let preview_error = service.plan_library_move(&destination).unwrap_err();
    assert_eq!(preview_error.details["acquisition_id"], acquisition.id);
    assert_eq!(
        PortcoveService::move_library(&source, &destination, "unreviewed")
            .unwrap_err()
            .code,
        ErrorCode::Conflict
    );
    server.release();
    let acquired = transfer.await.unwrap().unwrap();
    let metadata = service.export_library_metadata().unwrap();
    assert!(
        !serde_json::to_string(&metadata)
            .unwrap()
            .contains(&acquired.id)
    );
    assert!(
        metadata
            .content_roots
            .iter()
            .all(|root| root.relative_path != "downloads")
    );
    let provider = service.releases.clone();
    let catalog = service.catalog.clone();
    drop(service);
    // With all shared handles gone, the retained journal still refuses absolute-path transfer.
    let error = PortcoveService::move_library(&source, &destination, "unreviewed").unwrap_err();
    assert_eq!(error.details["acquisition_id"], acquired.id);
    assert_eq!(
        error.details["recovery_action"],
        "discard_game_update_acquisition"
    );
    assert!(!destination.exists());
    let library = Library::open(&source).unwrap();
    let mut reopened = PortcoveService::with_provider(library, provider).unwrap();
    reopened.catalog = catalog;
    assert!(file(&root(&reopened.library, &acquired.id).unwrap(), 0).exists());
    reopened
        .discard_game_update_acquisition(PORT, &acquired.id)
        .unwrap();
    // This inert unadmitted fixture may still fail ordinary portability checks; the archive hold is gone.
    if let Err(error) = reopened.plan_library_move(&destination) {
        assert!(!error.details.contains_key("acquisition_id"));
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn removing_managed_runtime_during_transfer_preserves_archive_and_never_resurrects_it() {
    let (_temporary, service, server) = fixture(true, false);
    let service = Arc::new(service);
    let save = service.library.user_dir(PORT).join("player-save");
    fs::create_dir_all(save.parent().unwrap()).unwrap();
    fs::write(&save, b"keep player data").unwrap();
    let authorization = grant(&service).await;
    let worker_service = service.clone();
    let transfer = tokio::spawn(async move {
        worker_service
            .acquire_game_update(PORT, &authorization.token, |_| {})
            .await
    });
    arrived(&server).await;
    let preview = service.preview_removal(PORT).unwrap();
    let consent = service
        .authorize_removal(PORT, &preview.preview_sha256)
        .unwrap();
    service.remove(PORT, &consent.token).unwrap();
    server.release();
    let acquired = transfer.await.unwrap().unwrap();
    let status = service.status(PORT).unwrap();
    assert!(status.active.is_none());
    assert!(status.staged.is_none());
    assert_eq!(status.acquisition.unwrap().id, acquired.id);
    assert_eq!(
        service.plan_game_update(PORT, true).await.unwrap_err().code,
        ErrorCode::NotFound
    );
    assert_eq!(fs::read(&save).unwrap(), b"keep player data");
    service
        .discard_game_update_acquisition(PORT, &acquired.id)
        .unwrap();
    assert_eq!(fs::read(save).unwrap(), b"keep player data");
}

struct CopyGate {
    entered: std::sync::mpsc::Sender<()>,
    gate: Arc<(std::sync::Mutex<bool>, std::sync::Condvar)>,
}
impl LifecycleFaultInjector for CopyGate {
    fn check(&self, point: LifecycleFaultPoint) -> Result<()> {
        if point == LifecycleFaultPoint::UpdateArchiveCopyStarted {
            self.entered.send(()).unwrap();
            let (mutex, condition) = &*self.gate;
            let mut released = mutex.lock().unwrap();
            while !*released {
                let (observed, timeout) = condition
                    .wait_timeout(released, Duration::from_secs(30))
                    .unwrap();
                released = observed;
                if timeout.timed_out() && !*released {
                    return Err(PortcoveError::state(
                        "owned copy test gate was not released within its finite budget",
                    ));
                }
            }
        }
        Ok(())
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancellation_joins_archive_copy_before_cleanup_or_discard_lease_release() {
    let (_temporary, mut service, _server) = fixture(false, false);
    let authorization = grant(&service).await;
    let acquired = service
        .acquire_game_update(PORT, &authorization.token, |_| {})
        .await
        .unwrap();
    let reviewed = service.plan_game_update(PORT, false).await.unwrap();
    let consent = service
        .authorize_game_update(PORT, false, &reviewed.plan_sha256)
        .await
        .unwrap();
    let (entered, observed) = std::sync::mpsc::channel();
    let gate = Arc::new((std::sync::Mutex::new(false), std::sync::Condvar::new()));
    service.faults = Arc::new(CopyGate {
        entered,
        gate: gate.clone(),
    });
    let service = Arc::new(service);
    let activity = Arc::new(std::sync::Mutex::new(None));
    let events = activity.clone();
    let worker_service = service.clone();
    let apply = tokio::spawn(async move {
        worker_service
            .apply_game_update(PORT, false, &consent.token, |event| {
                if matches!(event.event, crate::OperationEventKind::Started) {
                    *events.lock().unwrap() = Some(event.operation_id);
                }
            })
            .await
    });
    tokio::task::spawn_blocking(move || observed.recv_timeout(Duration::from_secs(30)))
        .await
        .unwrap()
        .unwrap();
    let operation_id = activity.lock().unwrap().clone().unwrap();
    service.request_cancellation(&operation_id).unwrap();
    assert!(!apply.is_finished());
    assert_eq!(
        service
            .discard_game_update_acquisition(PORT, &acquired.id)
            .unwrap_err()
            .code,
        ErrorCode::Conflict
    );
    assert!(file(&root(&service.library, &acquired.id).unwrap(), 0).exists());
    {
        let (mutex, condition) = &*gate;
        *mutex.lock().unwrap() = true;
        condition.notify_all();
    }
    assert_eq!(apply.await.unwrap().unwrap_err().code, ErrorCode::Cancelled);
    assert!(service.status(PORT).unwrap().staged.is_none());
    assert_eq!(
        service.status(PORT).unwrap().acquisition.unwrap().phase,
        Phase::Acquired
    );
    service
        .discard_game_update_acquisition(PORT, &acquired.id)
        .unwrap();
}

#[tokio::test]
async fn interrupted_marker_publication_has_bounded_exact_owner_discard_route() {
    let (_temporary, service, _server) = fixture(false, false);
    let authorization = grant(&service).await;
    let acquired = service
        .acquire_game_update(PORT, &authorization.token, |_| {})
        .await
        .unwrap();
    let store = OperationStore::new(service.library.clone());
    let mut record = store.get(&acquired.id).unwrap().unwrap();
    record.update_acquisition.as_mut().unwrap().view.phase = Phase::Acquiring;
    store.put(&mut record).unwrap();
    let private = root(&service.library, &acquired.id).unwrap();
    fs::remove_file(file(&private, 0)).unwrap();
    fs::remove_file(private.join("owner.json")).unwrap();
    let expected = serde_json::to_vec(&(acquired.id.as_str(), PORT)).unwrap();
    fs::write(private.join("owner.pending"), b"foreign marker").unwrap();
    assert!(
        service
            .discard_game_update_acquisition(PORT, &acquired.id)
            .is_err()
    );
    assert!(store.get(&acquired.id).unwrap().is_some());
    fs::write(
        private.join("owner.pending"),
        &expected[..expected.len() / 2],
    )
    .unwrap();
    service.recover_pending_operations().unwrap();
    assert_eq!(
        service.status(PORT).unwrap().acquisition.unwrap().phase,
        Phase::AttentionRequired
    );
    service
        .discard_game_update_acquisition(PORT, &acquired.id)
        .unwrap();
    assert!(!private.exists());
    assert!(service.plan_game_update_acquisition(PORT).await.is_ok());
}
