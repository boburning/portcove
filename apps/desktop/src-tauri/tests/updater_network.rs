#![cfg(feature = "application-update-qualification")]

mod updater_trust_support;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use futures_util::TryStreamExt;
use portcove_desktop::application_update_trust::{
    TrustedRepository, TrustedRepositoryError, TrustedRepositoryFailureKind,
    TrustedRepositoryRequest, load_trusted_repository,
    load_trusted_repository_from_controlled_loopback,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;
use tough::TargetName;
use url::Url;

use updater_trust_support::{Fixture, expiration};

#[derive(Clone, Copy)]
enum ResponseMode {
    Normal = 0,
    RateLimited429 = 1,
    RateLimited403 = 2,
    DropTimestamp = 3,
    RedirectTimestamp = 4,
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

    let is_timestamp = path == "/metadata/timestamp.json";
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
        .strip_prefix("/metadata/")
        .map(|relative| (metadata, relative))
        .or_else(|| {
            path.strip_prefix("/targets/")
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
