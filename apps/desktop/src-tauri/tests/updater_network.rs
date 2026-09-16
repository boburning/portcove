#![cfg(feature = "application-update-qualification")]

mod updater_trust_support;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use futures_util::TryStreamExt;
use portcove_desktop::application_update::{
    ApplicationChannel, ApplicationCompatibility, ArtifactIdentity, InstallOwner,
    LibraryCompatibility, PackageIdentity, PromotionRecord, QualifiedRun, ReleaseRecord,
    SelectedCandidate, UpdateMetadataError, VersionRange,
};
use portcove_desktop::application_update_download::{
    PayloadDownloadError, download_payload, download_payload_from_controlled_loopback,
};
use portcove_desktop::application_update_payload::{
    PayloadVerificationError, PayloadVerificationKey,
};
use portcove_desktop::application_update_staging::{
    ApplicationUpdateStagingError, ApplicationUpdateStagingStore,
};
use portcove_desktop::application_update_trust::{
    TrustedRepository, TrustedRepositoryError, TrustedRepositoryFailureKind,
    TrustedRepositoryRequest, load_trusted_repository,
    load_trusted_repository_from_controlled_loopback,
};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;
use tough::TargetName;
use url::Url;

use updater_trust_support::{Fixture, expiration};

const PUBLIC_KEY: &str = "untrusted comment: minisign public key E7620F1842B4E81F\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3\n";
const PREHASHED_SIGNATURE: &str = "untrusted comment: signature from minisign secret key\nRUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\ntrusted comment: timestamp:1556193335\tfile:test\ny/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==\n";

#[derive(Clone, Copy)]
enum ResponseMode {
    Normal = 0,
    RateLimited429 = 1,
    RateLimited403 = 2,
    DropTimestamp = 3,
    RedirectTimestamp = 4,
}

#[derive(Clone, Copy)]
enum PayloadResponseMode {
    Normal = 0,
    RateLimited = 1,
    Drop = 2,
    Truncated = 3,
    Overflow = 4,
    AlteredSameLength = 5,
}

struct ControlledPayloadServer {
    address: std::net::SocketAddr,
    mode: Arc<AtomicU8>,
    payload: Arc<Vec<u8>>,
    requests: Arc<Mutex<Vec<String>>>,
    task: JoinHandle<()>,
}

impl ControlledPayloadServer {
    async fn start(payload: Vec<u8>) -> Self {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let mode = Arc::new(AtomicU8::new(PayloadResponseMode::Normal as u8));
        let payload = Arc::new(payload);
        let requests = Arc::new(Mutex::new(Vec::new()));
        let task_mode = Arc::clone(&mode);
        let task_payload = Arc::clone(&payload);
        let task_requests = Arc::clone(&requests);
        let task = tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    return;
                };
                let mode = Arc::clone(&task_mode);
                let payload = Arc::clone(&task_payload);
                let requests = Arc::clone(&task_requests);
                tokio::spawn(async move {
                    serve_payload(stream, &mode, &payload, &requests).await;
                });
            }
        });
        Self {
            address,
            mode,
            payload,
            requests,
            task,
        }
    }

    fn set_mode(&self, mode: PayloadResponseMode) {
        self.mode.store(mode as u8, Ordering::Release);
    }

    fn payload_url(&self) -> Url {
        Url::parse(&format!("http://{}/payload", self.address)).unwrap()
    }

    fn request_count(&self) -> usize {
        self.requests.lock().unwrap().len()
    }
}

impl Drop for ControlledPayloadServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

struct ControlledRepositoryServer {
    address: std::net::SocketAddr,
    mode: Arc<AtomicU8>,
    requests: Arc<Mutex<Vec<String>>>,
    task: JoinHandle<()>,
}

impl ControlledRepositoryServer {
    async fn start(metadata: PathBuf, targets: PathBuf) -> Self {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let mode = Arc::new(AtomicU8::new(ResponseMode::Normal as u8));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let task_mode = Arc::clone(&mode);
        let task_requests = Arc::clone(&requests);
        let task = tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    return;
                };
                let metadata = metadata.clone();
                let targets = targets.clone();
                let mode = Arc::clone(&task_mode);
                let requests = Arc::clone(&task_requests);
                tokio::spawn(async move {
                    serve(stream, &metadata, &targets, &mode, &requests).await;
                });
            }
        });
        Self {
            address,
            mode,
            requests,
            task,
        }
    }

    fn set_mode(&self, mode: ResponseMode) {
        self.mode.store(mode as u8, Ordering::Release);
    }

    fn metadata_url(&self) -> Url {
        Url::parse(&format!("http://{}/metadata/", self.address)).unwrap()
    }

    fn targets_url(&self) -> Url {
        Url::parse(&format!("http://{}/targets/", self.address)).unwrap()
    }

    fn requests(&self) -> Vec<String> {
        self.requests.lock().unwrap().clone()
    }
}

impl Drop for ControlledRepositoryServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn serve(
    mut stream: TcpStream,
    metadata: &Path,
    targets: &Path,
    mode: &AtomicU8,
    requests: &Mutex<Vec<String>>,
) {
    let mut request = Vec::new();
    let mut buffer = [0_u8; 2048];
    while request.len() <= 16 * 1024 {
        let Ok(read) = stream.read(&mut buffer).await else {
            return;
        };
        if read == 0 {
            return;
        }
        request.extend_from_slice(&buffer[..read]);
        if request.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
    }
    let Some(line_end) = request.windows(2).position(|window| window == b"\r\n") else {
        return;
    };
    let Ok(line) = std::str::from_utf8(&request[..line_end]) else {
        return;
    };
    let mut fields = line.split_whitespace();
    if fields.next() != Some("GET") {
        return;
    }
    let Some(path) = fields.next() else {
        return;
    };
    requests.lock().unwrap().push(path.to_owned());

    let slash = '/';
    let metadata_prefix = format!("{slash}metadata{slash}");
    let targets_prefix = format!("{slash}targets{slash}");
    let timestamp_path = format!("{metadata_prefix}timestamp.json");
    let is_timestamp = path == timestamp_path;
    match mode.load(Ordering::Acquire) {
        value if value == ResponseMode::DropTimestamp as u8 && is_timestamp => return,
        value if value == ResponseMode::RateLimited429 as u8 && is_timestamp => {
            respond(
                &mut stream,
                "429 Too Many Requests",
                &["Retry-After: 120", "X-RateLimit-Remaining: 0"],
                &[],
            )
            .await;
            return;
        }
        value if value == ResponseMode::RateLimited403 as u8 && is_timestamp => {
            respond(
                &mut stream,
                "403 Forbidden",
                &["Retry-After: 60", "X-RateLimit-Remaining: 0"],
                &[],
            )
            .await;
            return;
        }
        value if value == ResponseMode::RedirectTimestamp as u8 && is_timestamp => {
            respond(
                &mut stream,
                "302 Found",
                &["Location: /redirected/timestamp.json"],
                &[],
            )
            .await;
            return;
        }
        _ => {}
    }

    let source = path
        .strip_prefix(&metadata_prefix)
        .map(|relative| (metadata, relative))
        .or_else(|| {
            path.strip_prefix(&targets_prefix)
                .map(|relative| (targets, relative))
        });
    let Some((root, relative)) = source else {
        respond(&mut stream, "404 Not Found", &[], &[]).await;
        return;
    };
    if relative.is_empty() || relative.contains('/') || relative.contains("..") {
        respond(&mut stream, "404 Not Found", &[], &[]).await;
        return;
    }
    match fs::read(root.join(relative)) {
        Ok(body) => respond(&mut stream, "200 OK", &[], &body).await,
        Err(_) => respond(&mut stream, "404 Not Found", &[], &[]).await,
    }
}

async fn respond(stream: &mut TcpStream, status: &str, headers: &[&str], body: &[u8]) {
    let mut response = format!(
        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n",
        body.len()
    );
    for header in headers {
        response.push_str(header);
        response.push_str("\r\n");
    }
    response.push_str("\r\n");
    if stream.write_all(response.as_bytes()).await.is_ok() {
        let _ = stream.write_all(body).await;
    }
}

async fn serve_payload(
    mut stream: TcpStream,
    mode: &AtomicU8,
    payload: &[u8],
    requests: &Mutex<Vec<String>>,
) {
    let mut request = Vec::new();
    let mut buffer = [0_u8; 2048];
    while request.len() <= 16 * 1024 {
        let Ok(read) = stream.read(&mut buffer).await else {
            return;
        };
        if read == 0 {
            return;
        }
        request.extend_from_slice(&buffer[..read]);
        if request.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
    }
    let Some(line_end) = request.windows(2).position(|window| window == b"\r\n") else {
        return;
    };
    let Ok(line) = std::str::from_utf8(&request[..line_end]) else {
        return;
    };
    let mut fields = line.split_whitespace();
    if fields.next() != Some("GET") {
        return;
    }
    let Some(path) = fields.next() else {
        return;
    };
    requests.lock().unwrap().push(path.to_owned());
    let slash = '/';
    let payload_path = format!("{slash}payload");
    if path != payload_path {
        respond(&mut stream, "404 Not Found", &[], &[]).await;
        return;
    }

    match mode.load(Ordering::Acquire) {
        value if value == PayloadResponseMode::RateLimited as u8 => {
            respond(
                &mut stream,
                "429 Too Many Requests",
                &["Retry-After: 120", "X-RateLimit-Remaining: 0"],
                &[],
            )
            .await;
        }
        value if value == PayloadResponseMode::Drop as u8 => {}
        value if value == PayloadResponseMode::Truncated as u8 => {
            respond_without_length(&mut stream, &payload[..payload.len() - 1]).await;
        }
        value if value == PayloadResponseMode::Overflow as u8 => {
            let mut oversized = payload.to_vec();
            oversized.push(b'!');
            respond_without_length(&mut stream, &oversized).await;
        }
        value if value == PayloadResponseMode::AlteredSameLength as u8 => {
            let mut altered = payload.to_vec();
            *altered.first_mut().expect("payload fixture is nonempty") ^= 1;
            respond_without_length(&mut stream, &altered).await;
        }
        _ => respond(&mut stream, "200 OK", &[], payload).await,
    }
}

async fn respond_without_length(stream: &mut TcpStream, body: &[u8]) {
    if stream
        .write_all(b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n")
        .await
        .is_ok()
    {
        let _ = stream.write_all(body).await;
    }
}

fn payload_key() -> PayloadVerificationKey {
    PayloadVerificationKey {
        id: hex::encode(Sha256::digest(PUBLIC_KEY.as_bytes())),
        tauri_public_key: base64::engine::general_purpose::STANDARD.encode(PUBLIC_KEY.as_bytes()),
    }
}

fn payload_candidate(version: &str, payload: &[u8]) -> SelectedCandidate {
    let target = "linux-x86_64";
    let package = "appimage";
    let release_path = format!("releases/{version}/{target}/{package}.json");
    let release_sha256 = "a".repeat(64);
    SelectedCandidate {
        release_path: release_path.clone(),
        release_sha256: release_sha256.clone(),
        release: ReleaseRecord {
            schema_version: 1,
            version: version.into(),
            source_commit: "b".repeat(40),
            source_tree: "c".repeat(40),
            qualified_run: QualifiedRun {
                workflow: "release.yml".into(),
                workflow_commit: "d".repeat(40),
                run_id: 1,
                attempt: 1,
                inventory_sha256: "e".repeat(64),
            },
            target: target.into(),
            os: "linux".into(),
            architecture: "x86_64".into(),
            execution_context: "desktop".into(),
            package: PackageIdentity {
                kind: package.into(),
                owner: InstallOwner::Portcove,
                product_id: "portcove".into(),
            },
            artifact: ArtifactIdentity {
                url: format!(
                    "https://github.com/boburning/portcove/releases/download/v{version}/Portcove.AppImage"
                ),
                sha256: hex::encode(Sha256::digest(payload)),
                bytes: payload.len() as u64,
                tauri_signature: base64::engine::general_purpose::STANDARD
                    .encode(PREHASHED_SIGNATURE.as_bytes()),
                payload_key_id: payload_key().id,
            },
            compatibility: ApplicationCompatibility {
                minimum_os_version: "1.0.0".into(),
                required_capabilities: Vec::new(),
                cli_protocol: VersionRange { min: 1, max: 1 },
                catalog_formats: vec![1],
                library: LibraryCompatibility {
                    read: VersionRange { min: 1, max: 1 },
                    write_schema: 1,
                    lock_protocol: "portcove-v1".into(),
                },
            },
            evidence_ids: vec!["controlled-payload-http".into()],
        },
        promotion: PromotionRecord {
            schema_version: 1,
            channel: ApplicationChannel::Preview,
            target: target.into(),
            package: package.into(),
            version: version.into(),
            release_path,
            release_sha256,
            eligible: true,
            production_eligible: false,
            withdrawn: false,
            reason: None,
            required_bridge: None,
        },
    }
}

async fn read_controlled_payload(
    server: &ControlledPayloadServer,
    candidate: &SelectedCandidate,
) -> Result<Vec<u8>, String> {
    let mut download = download_payload_from_controlled_loopback(candidate, &server.payload_url())
        .await
        .map_err(|error| error.to_string())?;
    let mut bytes = Vec::new();
    download
        .read_to_end(&mut bytes)
        .await
        .map_err(|error| error.to_string())?;
    Ok(bytes)
}

async fn load(
    server: &ControlledRepositoryServer,
    trusted: &[u8],
    state_directory: &Path,
) -> Result<TrustedRepository, TrustedRepositoryError> {
    load_trusted_repository_from_controlled_loopback(TrustedRepositoryRequest {
        bundled_root: trusted,
        metadata_base_url: server.metadata_url(),
        targets_base_url: server.targets_url(),
        state_directory,
    })
    .await
}

fn persisted_roles(state_directory: &Path) -> serde_json::Value {
    serde_json::from_slice::<serde_json::Value>(
        &fs::read(state_directory.join("trust-state.json")).unwrap(),
    )
    .unwrap()["roles"]
        .clone()
}

#[tokio::test]
async fn controlled_http_consumer_honors_rate_limits_outages_and_redirect_refusal() {
    let fixture = Fixture::new().await;
    let root = fixture.root(1, &fixture.offline, &fixture.online).await;
    let trusted = fixture.sign_root(&root, &root, &fixture.offline).await;
    fixture
        .publish(&trusted, &fixture.online, 1, expiration())
        .await;
    fixture.load(&trusted).await.unwrap();
    let file_state = fixture.directory.path().join("file-positive-state");
    fixture.load_persisted(&trusted, &file_state).await.unwrap();
    assert_eq!(fixture.metadata_url().scheme(), "file");
    assert_eq!(fixture.targets_url().scheme(), "file");
    let server =
        ControlledRepositoryServer::start(fixture.metadata.clone(), fixture.targets.clone()).await;
    let state_directory = fixture.directory.path().join("controlled-http-state");

    let production_error = load_trusted_repository(TrustedRepositoryRequest {
        bundled_root: &trusted,
        metadata_base_url: server.metadata_url(),
        targets_base_url: server.targets_url(),
        state_directory: &state_directory,
    })
    .await
    .unwrap_err();
    assert!(matches!(
        production_error,
        TrustedRepositoryError::InvalidSource(_)
    ));

    let positive = load(&server, &trusted, &state_directory).await.unwrap();
    assert_eq!(positive.versions.timestamp, 1);
    assert_eq!(positive.versions.snapshot, 1);
    assert_eq!(positive.versions.targets, 1);
    let release = positive
        .repository
        .read_target(&TargetName::new("release.json").unwrap())
        .await
        .unwrap()
        .unwrap()
        .try_collect::<Vec<_>>()
        .await
        .unwrap()
        .concat();
    assert_eq!(release, br#"{"schema":1,"version":"0.1.0","fixture":true}"#);
    let accepted_roles = persisted_roles(&state_directory);

    for (mode, minimum_delay) in [
        (ResponseMode::RateLimited429, 120_u64),
        (ResponseMode::RateLimited403, 60_u64),
    ] {
        server.set_mode(mode);
        let before = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let error = load(&server, &trusted, &state_directory).await.unwrap_err();
        assert_eq!(
            error.failure_kind(),
            TrustedRepositoryFailureKind::RateLimited
        );
        let TrustedRepositoryError::RateLimited {
            retry_at_unix_seconds: Some(retry_at),
        } = error
        else {
            panic!("expected provider rate limit with retry hint, got {error}");
        };
        assert!(retry_at >= before + minimum_delay);
        assert!(retry_at <= before + minimum_delay + 5);
        assert_eq!(persisted_roles(&state_directory), accepted_roles);

        server.set_mode(ResponseMode::Normal);
        let recovered = load(&server, &trusted, &state_directory).await.unwrap();
        assert_eq!(recovered.versions.timestamp, 1);
        assert_eq!(persisted_roles(&state_directory), accepted_roles);
    }

    for mode in [ResponseMode::DropTimestamp, ResponseMode::RedirectTimestamp] {
        server.set_mode(mode);
        let error = load(&server, &trusted, &state_directory).await.unwrap_err();
        assert!(matches!(&error, TrustedRepositoryError::Transport(_)));
        assert_eq!(
            error.failure_kind(),
            TrustedRepositoryFailureKind::Unreachable
        );
        assert_eq!(persisted_roles(&state_directory), accepted_roles);

        server.set_mode(ResponseMode::Normal);
        load(&server, &trusted, &state_directory).await.unwrap();
        assert_eq!(persisted_roles(&state_directory), accepted_roles);
    }

    let requests = server.requests();
    assert!(
        requests
            .iter()
            .any(|path| path == "/metadata/timestamp.json")
    );
    assert!(
        !requests
            .iter()
            .any(|path| path == "/redirected/timestamp.json"),
        "the no-redirect transport must not follow the controlled redirect"
    );
}

#[tokio::test]
async fn controlled_payload_consumer_rejects_network_failures_and_recovers() {
    let payload = b"authenticated payload fixture".to_vec();
    let candidate = payload_candidate("1.0.0", &payload);
    let server = ControlledPayloadServer::start(payload.clone()).await;

    let mut loopback_candidate = candidate.clone();
    loopback_candidate.release.artifact.url = server.payload_url().to_string();
    let Err(production_error) = download_payload(&loopback_candidate).await else {
        panic!("production payload transport accepted loopback HTTP");
    };
    assert!(matches!(
        production_error,
        PayloadDownloadError::Candidate(UpdateMetadataError::InvalidIdentity(_))
    ));
    assert_eq!(server.request_count(), 0);

    let retained = tempfile::tempdir().unwrap();
    let retained_payload = retained.path().join("last-accepted-payload");
    fs::write(&retained_payload, &payload).unwrap();
    assert_eq!(
        read_controlled_payload(&server, &candidate).await.unwrap(),
        payload
    );

    server.set_mode(PayloadResponseMode::RateLimited);
    let before = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let Err(rate_limit) =
        download_payload_from_controlled_loopback(&candidate, &server.payload_url()).await
    else {
        panic!("controlled payload transport ignored the provider rate limit");
    };
    let PayloadDownloadError::RateLimited {
        retry_at_unix_seconds: Some(retry_at),
    } = rate_limit
    else {
        panic!("expected provider retry hint, got {rate_limit}");
    };
    assert!((before + 120..=before + 125).contains(&retry_at));
    assert_eq!(fs::read(&retained_payload).unwrap(), payload);
    server.set_mode(PayloadResponseMode::Normal);
    assert_eq!(
        read_controlled_payload(&server, &candidate).await.unwrap(),
        payload
    );

    server.set_mode(PayloadResponseMode::Drop);
    let Err(drop_error) =
        download_payload_from_controlled_loopback(&candidate, &server.payload_url()).await
    else {
        panic!("controlled payload transport accepted a dropped response");
    };
    assert!(matches!(drop_error, PayloadDownloadError::Network(_)));
    assert_eq!(fs::read(&retained_payload).unwrap(), payload);
    server.set_mode(PayloadResponseMode::Normal);
    assert_eq!(
        read_controlled_payload(&server, &candidate).await.unwrap(),
        payload
    );

    for (mode, expected) in [
        (
            PayloadResponseMode::Truncated,
            "ended before authenticated length",
        ),
        (
            PayloadResponseMode::Overflow,
            "exceeded authenticated length",
        ),
    ] {
        server.set_mode(mode);
        let error = read_controlled_payload(&server, &candidate)
            .await
            .unwrap_err();
        assert!(error.contains(expected), "unexpected stream error: {error}");
        assert_eq!(fs::read(&retained_payload).unwrap(), payload);

        server.set_mode(PayloadResponseMode::Normal);
        assert_eq!(
            read_controlled_payload(&server, &candidate).await.unwrap(),
            payload
        );
    }

    assert_eq!(server.payload.as_slice(), payload);
}

#[tokio::test]
async fn controlled_payload_staging_preserves_verified_bytes_and_recovers() {
    let payload = b"test".to_vec();
    let server = ControlledPayloadServer::start(payload.clone()).await;
    let temporary = tempfile::tempdir().unwrap();
    let staging_root = temporary.path().join("staging");
    let staging = ApplicationUpdateStagingStore::new(staging_root.clone()).unwrap();
    let key = payload_key();
    let previous = payload_candidate("1.0.0", &payload);
    let next = payload_candidate("1.1.0", &payload);

    let mut baseline = download_payload_from_controlled_loopback(&previous, &server.payload_url())
        .await
        .unwrap();
    let staged = staging.stage(&mut baseline, &previous, &key).await.unwrap();
    assert_eq!(staged.candidate, previous);
    assert_eq!(fs::read(&staged.payload_path).unwrap(), payload);

    server.set_mode(PayloadResponseMode::AlteredSameLength);
    let mut altered = download_payload_from_controlled_loopback(&next, &server.payload_url())
        .await
        .unwrap();
    assert!(matches!(
        staging.stage(&mut altered, &next, &key).await,
        Err(ApplicationUpdateStagingError::Verification(
            PayloadVerificationError::HashMismatch
        ))
    ));
    let preserved = staging.reconcile().await.unwrap().unwrap();
    assert_eq!(preserved.candidate, previous);
    assert_eq!(fs::read(&preserved.payload_path).unwrap(), payload);
    assert!(!staging_root.join(".candidate.payload.incoming").exists());

    server.set_mode(PayloadResponseMode::Truncated);
    let mut truncated = download_payload_from_controlled_loopback(&next, &server.payload_url())
        .await
        .unwrap();
    let Err(ApplicationUpdateStagingError::Verification(PayloadVerificationError::Io(error))) =
        staging.stage(&mut truncated, &next, &key).await
    else {
        panic!("truncated HTTP payload did not fail through the staging verifier");
    };
    assert_eq!(error.kind(), std::io::ErrorKind::UnexpectedEof);
    let preserved = staging.reconcile().await.unwrap().unwrap();
    assert_eq!(preserved.candidate, previous);
    assert_eq!(fs::read(&preserved.payload_path).unwrap(), payload);
    assert!(!staging_root.join(".candidate.payload.incoming").exists());

    server.set_mode(PayloadResponseMode::Normal);
    let mut recovered = download_payload_from_controlled_loopback(&next, &server.payload_url())
        .await
        .unwrap();
    let staged = staging.stage(&mut recovered, &next, &key).await.unwrap();
    assert_eq!(staged.candidate, next);
    assert_eq!(fs::read(&staged.payload_path).unwrap(), payload);
    assert!(!staging_root.join(".candidate.payload.incoming").exists());
}
