use super::*;
use crate::test_http::serve_routed_http_bytes;

const BODY: &[u8; 16] = b"0123456789abcdef";
const CHANGED: &[u8; 16] = b"ABCDEFGHIJKLMNOP";
const DROPPED_AT: usize = 6;

fn fast(attempts: u32) -> transfer::ResumePolicy {
    transfer::ResumePolicy {
        attempts,
        first_delay: Duration::from_millis(1),
        max_delay: Duration::from_millis(1),
        progress: crate::transfer_progress::PROGRESS_FLOOR,
    }
}

fn head(status: &str, etag: Option<&str>, extra: &str, length: usize) -> Vec<u8> {
    let etag = etag
        .map(|etag| format!("ETag: {etag}\r\n"))
        .unwrap_or_default();
    format!(
        "HTTP/1.1 {status}\r\nContent-Length: {length}\r\n{etag}{extra}Connection: close\r\n\r\n"
    )
    .into_bytes()
}

fn whole(etag: Option<&str>, body: &[u8]) -> Vec<u8> {
    [head("200 OK", etag, "", body.len()), body.to_vec()].concat()
}

/// Declares the whole body, sends a prefix, then closes the connection.
fn dropped(etag: Option<&str>) -> Vec<u8> {
    [
        head("200 OK", etag, "", BODY.len()),
        BODY[..DROPPED_AT].to_vec(),
    ]
    .concat()
}

fn partial(etag: Option<&str>, content_range: &str, body: &[u8]) -> Vec<u8> {
    [
        head(
            "206 Partial Content",
            etag,
            &format!("Content-Range: {content_range}\r\n"),
            body.len(),
        ),
        body.to_vec(),
    ]
    .concat()
}

fn ranged(request: &str) -> Option<String> {
    request
        .to_ascii_lowercase()
        .split("\r\n")
        .find_map(|line| line.strip_prefix("range: ").map(str::to_owned))
}

fn if_range(request: &str) -> Option<String> {
    request.split("\r\n").find_map(|line| {
        line.to_ascii_lowercase()
            .starts_with("if-range: ")
            .then(|| line["if-range: ".len()..].to_owned())
    })
}

struct Outcome {
    result: Result<()>,
    file: Vec<u8>,
    requests: Vec<String>,
    messages: Vec<String>,
    progress: Vec<u64>,
}

fn sample(root: &str, size: u64, sha256: String) -> ReleaseAsset {
    ReleaseAsset {
        name: "sample.zip".into(),
        url: format!("{root}/sample.zip"),
        size,
        sha256,
    }
}

/// Serves `responses` in order and runs one transfer under `policy`.
async fn run(responses: Vec<Vec<u8>>, policy: transfer::ResumePolicy) -> Outcome {
    run_asset(
        responses,
        policy,
        BODY.len() as u64,
        hex::encode(Sha256::digest(BODY)),
    )
    .await
}

async fn run_asset(
    responses: Vec<Vec<u8>>,
    policy: transfer::ResumePolicy,
    size: u64,
    sha256: String,
) -> Outcome {
    let temporary = tempfile::tempdir().unwrap();
    let destination = temporary.path().join("artifact.download");
    let count = responses.len();
    let mut responses = responses.into_iter();
    let (root, requests, server) =
        serve_routed_http_bytes(count, move |_| responses.next().unwrap());
    let asset = sample(&root, size, sha256);
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let operation = OperationCoordinator::new("download", None);
    let mut messages = Vec::new();
    let mut progress = Vec::new();
    let result = tokio::time::timeout(
        Duration::from_secs(30),
        transfer::download(
            &client,
            &asset,
            &destination,
            &operation,
            &mut |event| match event.event {
                crate::OperationEventKind::Message { message, .. } => messages.push(message),
                crate::OperationEventKind::Progress { completed, .. } => progress.push(completed),
                _ => {}
            },
            policy,
        ),
    )
    .await
    .expect("transfer fixture exceeded thirty seconds");
    server.join().unwrap();
    Outcome {
        result,
        file: fs::read(&destination).unwrap_or_default(),
        requests: requests.try_iter().collect(),
        messages,
        progress,
    }
}

#[tokio::test]
async fn dropped_body_continues_from_the_received_offset_with_its_validator() {
    let outcome = run(
        vec![
            dropped(Some("\"v1\"")),
            partial(Some("\"v1\""), "bytes 6-15/16", &BODY[DROPPED_AT..]),
        ],
        fast(3),
    )
    .await;
    outcome.result.unwrap();
    assert_eq!(outcome.file, BODY);
    assert_eq!(outcome.requests.len(), 2);
    assert_eq!(ranged(&outcome.requests[0]), None);
    assert_eq!(ranged(&outcome.requests[1]).as_deref(), Some("bytes=6-"));
    assert_eq!(if_range(&outcome.requests[1]).as_deref(), Some("\"v1\""));
    assert!(outcome.messages[0].contains("Continuing from the bytes already received"));
    // The caller's whole-file digest remains the only acceptance.
    assert_eq!(
        hex::encode(Sha256::digest(&outcome.file)),
        hex::encode(Sha256::digest(BODY))
    );
}

#[tokio::test]
async fn server_that_ignores_range_replaces_the_received_bytes() {
    let outcome = run(
        vec![dropped(Some("\"v1\"")), whole(Some("\"v1\""), BODY)],
        fast(3),
    )
    .await;
    outcome.result.unwrap();
    assert_eq!(outcome.file, BODY);
    assert_eq!(ranged(&outcome.requests[1]).as_deref(), Some("bytes=6-"));
}

#[tokio::test]
async fn changed_file_is_downloaded_whole_instead_of_spliced() {
    // If-Range mismatch: a conforming server sends the new representation whole.
    let outcome = run(
        vec![dropped(Some("\"v1\"")), whole(Some("\"v2\""), CHANGED)],
        fast(3),
    )
    .await;
    outcome.result.unwrap();
    assert_eq!(outcome.file, CHANGED);

    // A partial answer that names a different validator is never appended.
    let outcome = run(
        vec![
            dropped(Some("\"v1\"")),
            partial(Some("\"v2\""), "bytes 6-15/16", &CHANGED[DROPPED_AT..]),
            whole(Some("\"v2\""), CHANGED),
        ],
        fast(3),
    )
    .await;
    outcome.result.unwrap();
    assert_eq!(outcome.file, CHANGED);
    assert_eq!(outcome.requests.len(), 3);
    assert_eq!(ranged(&outcome.requests[2]), None);
    assert!(outcome.messages[1].contains("again from the beginning"));
}

#[tokio::test]
async fn mismatched_content_range_restarts_from_zero() {
    for content_range in [
        "bytes 5-15/16",
        "bytes 6-14/16",
        "bytes 6-15/17",
        "bytes 6-15/*",
        "bytes 6-15",
    ] {
        let outcome = run(
            vec![
                dropped(Some("\"v1\"")),
                partial(Some("\"v1\""), content_range, &BODY[DROPPED_AT..]),
                whole(Some("\"v1\""), BODY),
            ],
            fast(3),
        )
        .await;
        outcome.result.unwrap();
        assert_eq!(outcome.file, BODY, "{content_range}");
        assert_eq!(ranged(&outcome.requests[2]), None, "{content_range}");
    }
}

#[tokio::test]
async fn partial_answer_with_a_wrong_length_or_no_validator_restarts_from_zero() {
    let wrong_length = [
        head(
            "206 Partial Content",
            Some("\"v1\""),
            "Content-Range: bytes 6-15/16\r\n",
            9,
        ),
        BODY[DROPPED_AT..15].to_vec(),
    ]
    .concat();
    let no_validator = partial(None, "bytes 6-15/16", &BODY[DROPPED_AT..]);
    for answer in [wrong_length, no_validator] {
        let outcome = run(
            vec![dropped(Some("\"v1\"")), answer, whole(Some("\"v1\""), BODY)],
            fast(3),
        )
        .await;
        outcome.result.unwrap();
        assert_eq!(outcome.file, BODY);
        assert_eq!(ranged(&outcome.requests[2]), None);
    }
}

#[tokio::test]
async fn range_not_satisfiable_restarts_from_zero() {
    let refused = head(
        "416 Range Not Satisfiable",
        None,
        "Content-Range: bytes */16\r\n",
        0,
    );
    let outcome = run(
        vec![
            dropped(Some("\"v1\"")),
            refused,
            whole(Some("\"v1\""), BODY),
        ],
        fast(3),
    )
    .await;
    outcome.result.unwrap();
    assert_eq!(outcome.file, BODY);
    assert_eq!(ranged(&outcome.requests[1]).as_deref(), Some("bytes=6-"));
    assert_eq!(ranged(&outcome.requests[2]), None);
}

#[tokio::test]
async fn restart_truncates_a_longer_stale_prefix() {
    // Without a declared size, a shorter replacement must not inherit the tail
    // of the abandoned representation.
    let stale = [head("200 OK", Some("\"v1\""), "", 16), BODY[..10].to_vec()].concat();
    let outcome = run_asset(
        vec![stale, whole(Some("\"v2\""), b"WXYZ")],
        fast(3),
        0,
        hex::encode(Sha256::digest(b"WXYZ")),
    )
    .await;
    outcome.result.unwrap();
    assert_eq!(outcome.file, b"WXYZ");
}

#[tokio::test]
async fn restart_resets_visible_progress() {
    // Two megabytes report progress before the drop; the restart must not
    // leave that higher value visible while the replacement arrives.
    const LARGE: usize = 2 * 1024 * 1024;
    let body = vec![7_u8; LARGE];
    let stale = [head("200 OK", None, "", LARGE), body[..LARGE - 1].to_vec()].concat();
    let outcome = run_asset(
        vec![stale, whole(None, &body)],
        fast(3),
        LARGE as u64,
        hex::encode(Sha256::digest(&body)),
    )
    .await;
    outcome.result.unwrap();
    assert_eq!(outcome.file.len(), LARGE);
    let reset = outcome
        .progress
        .iter()
        .position(|completed| *completed == 0)
        .expect("restart reported zero progress");
    assert!(reset > 0 && outcome.progress[..reset].iter().all(|value| *value > 0));
    assert_eq!(outcome.progress.last().copied(), Some(LARGE as u64));
}

#[tokio::test]
async fn short_clean_partial_body_is_an_interruption() {
    // A chunked partial answer may end cleanly before the complete length.
    let chunked = "HTTP/1.1 206 Partial Content\r\nETag: \"v1\"\r\nContent-Range: bytes 6-15/16\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n4\r\n6789\r\n0\r\n\r\n"
        .as_bytes()
        .to_vec();
    let outcome = run_asset(
        vec![
            dropped(Some("\"v1\"")),
            chunked,
            partial(Some("\"v1\""), "bytes 10-15/16", &BODY[10..]),
        ],
        fast(3),
        0,
        hex::encode(Sha256::digest(BODY)),
    )
    .await;
    outcome.result.unwrap();
    assert_eq!(outcome.file, BODY);
    assert_eq!(ranged(&outcome.requests[2]).as_deref(), Some("bytes=10-"));
}

#[tokio::test]
async fn missing_expected_digest_never_resumes_with_range() {
    let outcome = run_asset(
        vec![dropped(Some("\"v1\"")), whole(Some("\"v1\""), BODY)],
        fast(3),
        BODY.len() as u64,
        String::new(),
    )
    .await;
    outcome.result.unwrap();
    assert_eq!(outcome.file, BODY);
    assert_eq!(ranged(&outcome.requests[1]), None);
    assert_eq!(if_range(&outcome.requests[1]), None);
}

#[tokio::test]
async fn missing_or_weak_validator_restarts_without_range() {
    for etag in [None, Some("W/\"v1\"")] {
        let outcome = run(vec![dropped(etag), whole(etag, BODY)], fast(3)).await;
        outcome.result.unwrap();
        assert_eq!(outcome.file, BODY);
        assert_eq!(ranged(&outcome.requests[1]), None);
        assert_eq!(if_range(&outcome.requests[1]), None);
    }
}

#[tokio::test]
async fn resume_attempts_are_bounded() {
    let outcome = run(
        vec![dropped(Some("\"v1\"")), dropped(None), dropped(None)],
        fast(2),
    )
    .await;
    let error = outcome.result.unwrap_err();
    assert_eq!(error.code, crate::ErrorCode::Network);
    assert_eq!(
        error
            .details
            .get("download_resume_attempts")
            .map(String::as_str),
        Some("2")
    );
    assert_eq!(outcome.requests.len(), 3);
}

#[tokio::test]
async fn refused_reconnects_consume_retries_and_keep_the_original_classification() {
    // The fixture serves one exchange and then closes its listener, so every
    // reconnect is refused. A refused connection alone would classify as
    // unavailable, but exhaustion reports the original body drop, so failover
    // to preserved locations behaves exactly as before resume existed.
    let outcome = run(
        vec![dropped(Some("\"v1\""))],
        transfer::ResumePolicy {
            attempts: 2,
            first_delay: Duration::from_millis(200),
            max_delay: Duration::from_millis(200),
            progress: crate::transfer_progress::PROGRESS_FLOOR,
        },
    )
    .await;
    let error = outcome.result.unwrap_err();
    assert_eq!(outcome.requests.len(), 1);
    assert_eq!(
        error
            .details
            .get("download_resume_attempts")
            .map(String::as_str),
        Some("2")
    );
    assert!(error.details.contains_key("download_resume_last_error"));
    assert_eq!(
        error.upstream_failure(),
        crate::failure::UpstreamFailure::Other
    );
    assert_eq!(outcome.file, &BODY[..DROPPED_AT]);
}

#[tokio::test]
async fn read_idle_stall_on_a_resumed_attempt_remains_fatal() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (release, released) = tokio::sync::oneshot::channel::<()>();
    let mut stalled = head(
        "206 Partial Content",
        Some("\"v1\""),
        "Content-Range: bytes 6-15/16\r\n",
        10,
    );
    stalled.extend_from_slice(b"67");
    let server = tokio::spawn(async move {
        let mut requests = Vec::new();
        let mut held = None;
        for (index, response) in [dropped(Some("\"v1\"")), stalled].into_iter().enumerate() {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                assert!(request.len() < 8192);
                request.push(stream.read_u8().await.unwrap());
            }
            requests.push(String::from_utf8(request).unwrap());
            stream.write_all(&response).await.unwrap();
            // Closing drops the first body; the second stays open and silent.
            if index == 1 {
                held = Some(stream);
            }
        }
        let _ = tokio::time::timeout(Duration::from_secs(10), released).await;
        drop(held);
        requests
    });
    let temporary = tempfile::tempdir().unwrap();
    let destination = temporary.path().join("artifact.download");
    let asset = sample(
        &format!("http://{address}"),
        BODY.len() as u64,
        hex::encode(Sha256::digest(BODY)),
    );
    let client = reqwest::Client::builder()
        .no_proxy()
        .read_timeout(Duration::from_secs(1))
        .build()
        .unwrap();
    let operation = OperationCoordinator::new("download", None);
    let result = tokio::time::timeout(
        Duration::from_secs(30),
        transfer::download(
            &client,
            &asset,
            &destination,
            &operation,
            &mut |_| {},
            fast(3),
        ),
    )
    .await
    .expect("stall fixture exceeded thirty seconds");
    let _ = release.send(());
    let requests = server.await.unwrap();
    let error = result.unwrap_err();
    assert_eq!(requests.len(), 2);
    assert_eq!(ranged(&requests[1]).as_deref(), Some("bytes=6-"));
    // A stall keeps its timeout classification and is not retried.
    assert_eq!(
        error.upstream_failure(),
        crate::failure::UpstreamFailure::Unavailable,
        "{error:?}"
    );
    assert_eq!(
        error
            .details
            .get("download_resume_attempts")
            .map(String::as_str),
        Some("1")
    );
    assert_eq!(fs::read(&destination).unwrap(), &BODY[..8]);
}

#[test]
fn cancellation_during_a_resumed_body_returns_after_draining_received_bytes() {
    const LARGE: usize = 2 * 1024 * 1024;
    let body: Vec<u8> = (0..LARGE).map(|index| (index % 251) as u8).collect();
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let service = Arc::new(crate::PortcoveService::new(library.clone()).unwrap());
    let (activity, operation) = service
        .begin_cancellable_activity(
            crate::ActivityOperation::Install,
            crate::ActivityTargetKind::Port,
            Some("sample"),
        )
        .unwrap();
    let destination = temporary.path().join("artifact.download");
    let sent = 1024 * 1024 + 64 * 1024;
    let first = [
        head("200 OK", Some("\"v1\""), "", LARGE),
        body[..DROPPED_AT].to_vec(),
    ]
    .concat();
    let resumed = [
        head(
            "206 Partial Content",
            Some("\"v1\""),
            &format!(
                "Content-Range: bytes {DROPPED_AT}-{}/{LARGE}\r\n",
                LARGE - 1
            ),
            LARGE - DROPPED_AT,
        ),
        body[DROPPED_AT..DROPPED_AT + sent].to_vec(),
    ]
    .concat();
    let mut responses = vec![first, resumed].into_iter();
    let (root, requests, server) = serve_routed_http_bytes(2, move |_| responses.next().unwrap());
    let asset = sample(&root, LARGE as u64, hex::encode(Sha256::digest(&body)));
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let result = runtime.block_on(async {
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        tokio::time::timeout(
            Duration::from_secs(30),
            transfer::download(
                &client,
                &asset,
                &destination,
                &operation,
                &mut |event| {
                    // The first progress report happens inside the resumed body.
                    if matches!(event.event, crate::OperationEventKind::Progress { .. }) {
                        service.request_cancellation(&activity.id).unwrap();
                    }
                },
                transfer::ResumePolicy {
                    attempts: 3,
                    first_delay: Duration::from_millis(1),
                    max_delay: Duration::from_secs(20),
                    progress: crate::transfer_progress::PROGRESS_FLOOR,
                },
            ),
        )
        .await
        .expect("cancellation fixture exceeded thirty seconds")
    });
    // The client may abandon the resumed body mid-write; a server write
    // error then is expected and not part of this contract.
    let _ = server.join();
    drop(requests);
    assert_eq!(result.unwrap_err().code, crate::ErrorCode::Cancelled);
    // More than the first attempt's six bytes proves the resumed body was
    // read, and everything accepted reached the file before return.
    let written = fs::read(&destination).unwrap();
    assert!(written.len() > 1024 * 1024, "{}", written.len());
    assert_eq!(written, &body[..written.len()]);
}

#[test]
fn cancellation_during_resume_back_off_stops_without_another_request() {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let service = Arc::new(crate::PortcoveService::new(library.clone()).unwrap());
    let (activity, operation) = service
        .begin_cancellable_activity(
            crate::ActivityOperation::Install,
            crate::ActivityTargetKind::Port,
            Some("sample"),
        )
        .unwrap();
    let destination = temporary.path().join("artifact.download");
    let mut responses = vec![dropped(Some("\"v1\"")), whole(Some("\"v1\""), BODY)].into_iter();
    let (root, requests, server) = serve_routed_http_bytes(2, move |_| responses.next().unwrap());
    let asset = ReleaseAsset {
        name: "sample.zip".into(),
        url: format!("{root}/sample.zip"),
        size: BODY.len() as u64,
        sha256: hex::encode(Sha256::digest(BODY)),
    };
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let started = std::time::Instant::now();
    let result = runtime.block_on(async {
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        tokio::time::timeout(
            Duration::from_secs(30),
            transfer::download(
                &client,
                &asset,
                &destination,
                &operation,
                &mut |event| {
                    if matches!(event.event, crate::OperationEventKind::Message { .. }) {
                        service.request_cancellation(&activity.id).unwrap();
                    }
                },
                transfer::ResumePolicy {
                    attempts: 3,
                    first_delay: Duration::from_secs(20),
                    max_delay: Duration::from_secs(20),
                    progress: crate::transfer_progress::PROGRESS_FLOOR,
                },
            ),
        )
        .await
        .expect("cancellation fixture exceeded thirty seconds")
    });
    let elapsed = started.elapsed();
    server.join().unwrap();
    assert_eq!(result.unwrap_err().code, crate::ErrorCode::Cancelled);
    assert!(
        elapsed < Duration::from_secs(10),
        "back-off ignored cancellation: {elapsed:?}"
    );
    assert_eq!(requests.try_iter().count(), 1);
    // Received bytes were drained to disk before returning, for private cleanup.
    assert_eq!(fs::read(&destination).unwrap(), &BODY[..DROPPED_AT]);
}

/// Serves `responses` in order to separate transfers that share one asset URL;
/// each transfer stands in for a separate Portcove run.
struct Restarts {
    root: String,
    requests: std::sync::mpsc::Receiver<String>,
    server: crate::test_http::HttpServer,
    client: reqwest::Client,
}

impl Restarts {
    fn serve(responses: Vec<Vec<u8>>) -> Self {
        let count = responses.len();
        let mut responses = responses.into_iter();
        let (root, requests, server) =
            serve_routed_http_bytes(count, move |_| responses.next().unwrap());
        Self {
            root,
            requests,
            server,
            client: reqwest::Client::builder().no_proxy().build().unwrap(),
        }
    }

    fn asset(&self, sha256: String) -> ReleaseAsset {
        sample(&self.root, BODY.len() as u64, sha256)
    }

    async fn transfer(
        &self,
        partials: &partial_download::PartialDownloads,
        destination: &Path,
        sha256: String,
    ) -> (Result<()>, Vec<u8>, Vec<String>) {
        let asset = self.asset(sha256);
        let operation = OperationCoordinator::new("download", None);
        let mut messages = Vec::new();
        let result = tokio::time::timeout(
            Duration::from_secs(30),
            transfer::download_resuming(
                &self.client,
                &asset,
                destination,
                &operation,
                &mut |event| {
                    if let crate::OperationEventKind::Message { message, .. } = event.event {
                        messages.push(message);
                    }
                },
                fast(0),
                Some(transfer::RetainedDownload::private(partials)),
            ),
        )
        .await
        .expect("transfer fixture exceeded thirty seconds");
        (result, fs::read(destination).unwrap_or_default(), messages)
    }

    /// Every request the server answered, in order.
    fn finish(self) -> Vec<String> {
        self.server.join().unwrap();
        self.requests.try_iter().collect()
    }
}

fn stored_entries(root: &Path) -> Vec<String> {
    let mut names = fs::read_dir(root)
        .map(|entries| {
            entries
                .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
                .filter(|name| name != partial_download::INDEX_LOCK)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    names.sort();
    names
}

#[tokio::test]
async fn interrupted_bytes_continue_in_a_later_run_with_the_same_validator() {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let store_root = library.downloads_dir().join("psx-toolchain-partial-v1");
    let partials = partial_download::PartialDownloads::new(store_root.clone());
    let digest = hex::encode(Sha256::digest(BODY));
    let server = Restarts::serve(vec![
        dropped(Some("\"v1\"")),
        partial(Some("\"v1\""), "bytes 6-15/16", &BODY[DROPPED_AT..]),
    ]);
    // First run: the body drops and no reconnect is allowed.
    let first = temporary.path().join("first.download");
    let (result, _, _) = server.transfer(&partials, &first, digest.clone()).await;
    assert!(result.is_err());
    assert!(!first.exists());
    assert_eq!(stored_entries(&store_root).len(), 2);

    // A later run downloads the same asset into a fresh toolchain staging directory.
    let staging = library
        .staging_dir()
        .join(format!("psx-toolchain-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&staging).unwrap();
    let second = staging.join("second.download");
    let _acquisition = library.try_lock_psx_toolchain_acquisition().unwrap();
    assert!(matches!(
        library.try_lock_psx_toolchain_acquisition(),
        Err(error) if error.code == crate::ErrorCode::Conflict
    ));
    let installer = Installer::new(library).unwrap();
    let operation = OperationCoordinator::new("psx_toolchain", None);
    let mut messages = Vec::new();
    tokio::time::timeout(
        Duration::from_secs(30),
        installer.download_psx_toolchain(
            &server.asset(digest),
            &second,
            &operation,
            &mut |event| {
                if let crate::OperationEventKind::Message { message, .. } = event.event {
                    messages.push(message);
                }
            },
        ),
    )
    .await
    .expect("transfer fixture exceeded thirty seconds")
    .unwrap();
    assert_eq!(fs::read(&second).unwrap(), BODY);
    assert!(messages[0].contains("Continuing the earlier download"));
    // A completed download leaves nothing behind.
    assert!(stored_entries(&store_root).is_empty());
    let requests = server.finish();
    assert_eq!(ranged(&requests[0]), None);
    assert_eq!(ranged(&requests[1]).as_deref(), Some("bytes=6-"));
    assert_eq!(if_range(&requests[1]).as_deref(), Some("\"v1\""));
}

#[tokio::test]
async fn interrupted_install_resumes_to_the_owned_external_output() {
    use std::io::{Cursor, Write as _};

    let temporary = tempfile::tempdir().unwrap();
    let library_root = temporary.path().join("library");
    let output_root = temporary.path().join("external-output");
    let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
    archive
        .start_file("sample-game.exe", zip::write::SimpleFileOptions::default())
        .unwrap();
    archive.write_all(b"verified executable").unwrap();
    let bytes = archive.finish().unwrap().into_inner();
    let len = bytes.len();
    let first_part = [
        head("200 OK", Some("\"v1\""), "", len),
        bytes[..DROPPED_AT].to_vec(),
    ]
    .concat();
    let remaining = partial(
        Some("\"v1\""),
        &format!("bytes {DROPPED_AT}-{}/{len}", len - 1),
        &bytes[DROPPED_AT..],
    );
    let server = Restarts::serve(vec![
        first_part,
        head("500 Internal Server Error", None, "", 0),
        remaining,
    ]);
    let request = InstallRequest {
        port_id: "sample".into(),
        output_root: output_root.clone(),
        release: ResolvedRelease {
            version: "v1".into(),
            channel: crate::ReleaseChannel::Stable,
            published_at: None,
            asset: sample(&server.root, len as u64, hex::encode(Sha256::digest(bytes))),
            uploader_continuity: None,
        },
        activate: true,
        managed: None,
        qualification: InstallQualification::test("sample-game.exe"),
    };

    let store_root = {
        let library = Library::open(&library_root).unwrap();
        let installer = Installer::new(library.clone()).unwrap();
        let operation = OperationCoordinator::new("install", None);
        let first = installer.install(request.clone(), &operation, |_| {}).await;
        assert!(first.is_err(), "{first:?}");
        assert!(library.all_installs().unwrap().is_empty());
        assert!(
            OperationStore::new(library.clone())
                .all()
                .unwrap()
                .is_empty()
        );
        let store_root = library.downloads_dir().join("partial-v1");
        assert_eq!(stored_entries(&store_root).len(), 2);
        store_root
    };

    let library = Library::open(&library_root).unwrap();
    let installer = Installer::new(library.clone()).unwrap();
    let operation = OperationCoordinator::new("install", None);
    let install = installer
        .install(request, &operation, |_| {})
        .await
        .unwrap();
    assert!(install.verified);
    assert!(
        install
            .path
            .starts_with(fs::canonicalize(output_root).unwrap())
    );
    assert_eq!(
        fs::read(install.path.join("sample-game.exe")).unwrap(),
        b"verified executable"
    );
    assert_eq!(library.all_installs().unwrap().len(), 1);
    assert!(stored_entries(&store_root).is_empty());
    assert!(OperationStore::new(library).all().unwrap().is_empty());
    let requests = server.finish();
    assert_eq!(ranged(&requests[0]), None);
    assert_eq!(ranged(&requests[1]).as_deref(), Some("bytes=6-"));
    assert_eq!(ranged(&requests[2]).as_deref(), Some("bytes=6-"));
    assert_eq!(if_range(&requests[2]).as_deref(), Some("\"v1\""));
}

#[tokio::test]
async fn bytes_written_before_portcove_stopped_continue_in_the_next_run() {
    let temporary = tempfile::tempdir().unwrap();
    let store_root = temporary.path().join("partial-v1");
    let partials = partial_download::PartialDownloads::new(store_root.clone());
    let digest = hex::encode(Sha256::digest(BODY));
    let server = Restarts::serve(vec![partial(
        Some("\"v1\""),
        "bytes 6-15/16",
        &BODY[DROPPED_AT..],
    )]);
    // A run that stopped without unwinding: its lease recorded the validator
    // and wrote bytes, then the process exit closed it (releasing the lock)
    // without finishing or discarding it.
    {
        use std::io::Write as _;
        let lease = partials.lease(&server.asset(digest.clone())).unwrap();
        lease.describe(Some("\"v1\""), Some(BODY.len() as u64));
        lease
            .writer()
            .unwrap()
            .write_all(&BODY[..DROPPED_AT])
            .unwrap();
    }
    let destination = temporary.path().join("next.download");
    let (result, file, messages) = server.transfer(&partials, &destination, digest).await;
    result.unwrap();
    assert_eq!(file, BODY);
    assert!(messages[0].contains("Continuing the earlier download"));
    let requests = server.finish();
    assert_eq!(ranged(&requests[0]).as_deref(), Some("bytes=6-"));
    assert_eq!(if_range(&requests[0]).as_deref(), Some("\"v1\""));
}

#[tokio::test]
async fn a_changed_representation_in_a_later_run_starts_over() {
    let temporary = tempfile::tempdir().unwrap();
    let store_root = temporary.path().join("partial-v1");
    let partials = partial_download::PartialDownloads::new(store_root.clone());
    let digest = hex::encode(Sha256::digest(BODY));
    let server = Restarts::serve(vec![
        dropped(Some("\"v1\"")),
        // The server now has a different representation and answers whole.
        whole(Some("\"v2\""), CHANGED),
    ]);
    let first = temporary.path().join("first.download");
    server
        .transfer(&partials, &first, digest.clone())
        .await
        .0
        .unwrap_err();
    let second = temporary.path().join("second.download");
    let (result, file, _) = server.transfer(&partials, &second, digest).await;
    result.unwrap();
    // No received byte is spliced into the new representation; the caller's
    // digest check refuses this file.
    assert_eq!(file, CHANGED);
    assert!(stored_entries(&store_root).is_empty());
    server.finish();
}

#[tokio::test]
async fn a_refused_range_request_starts_over_without_a_range() {
    let temporary = tempfile::tempdir().unwrap();
    let store_root = temporary.path().join("partial-v1");
    let partials = partial_download::PartialDownloads::new(store_root.clone());
    let digest = hex::encode(Sha256::digest(BODY));
    let server = Restarts::serve(vec![
        dropped(Some("\"v1\"")),
        head("403 Forbidden", None, "", 0),
        whole(Some("\"v1\""), BODY),
    ]);
    let first = temporary.path().join("first.download");
    server
        .transfer(&partials, &first, digest.clone())
        .await
        .0
        .unwrap_err();
    // With no retries left, the refusal ends this run and keeps nothing.
    let second = temporary.path().join("second.download");
    server
        .transfer(&partials, &second, digest.clone())
        .await
        .0
        .unwrap_err();
    assert!(stored_entries(&store_root).is_empty());
    let third = temporary.path().join("third.download");
    let (result, file, _) = server.transfer(&partials, &third, digest).await;
    result.unwrap();
    assert_eq!(file, BODY);
    let requests = server.finish();
    assert_eq!(ranged(&requests[1]).as_deref(), Some("bytes=6-"));
    assert_eq!(ranged(&requests[2]), None);
}

#[tokio::test]
async fn weak_validators_and_other_assets_never_use_kept_bytes() {
    let temporary = tempfile::tempdir().unwrap();
    let store_root = temporary.path().join("partial-v1");
    let partials = partial_download::PartialDownloads::new(store_root.clone());
    let digest = hex::encode(Sha256::digest(BODY));
    let server = Restarts::serve(vec![
        dropped(Some("W/\"v1\"")),
        dropped(Some("\"v1\"")),
        whole(Some("\"v1\""), BODY),
    ]);
    let weak = temporary.path().join("weak.download");
    server
        .transfer(&partials, &weak, digest.clone())
        .await
        .0
        .unwrap_err();
    assert!(stored_entries(&store_root).is_empty());

    let kept = temporary.path().join("kept.download");
    server
        .transfer(&partials, &kept, digest)
        .await
        .0
        .unwrap_err();
    assert_eq!(stored_entries(&store_root).len(), 2);
    // A different expected digest is a different asset: it starts at zero and
    // leaves the other entry alone.
    let other = temporary.path().join("other.download");
    let (result, _, _) = server
        .transfer(&partials, &other, hex::encode(Sha256::digest(CHANGED)))
        .await;
    result.unwrap();
    assert_eq!(stored_entries(&store_root).len(), 2);
    let requests = server.finish();
    assert_eq!(ranged(&requests[2]), None);
}

fn asset_numbered(index: u8, size: u64) -> ReleaseAsset {
    ReleaseAsset {
        name: "sample.zip".into(),
        url: format!("https://example.invalid/{index}.zip"),
        size,
        sha256: hex::encode(Sha256::digest([index])),
    }
}

/// Leaves an entry as an interrupted transfer would.
fn keep_entry(partials: &partial_download::PartialDownloads, index: u8, bytes: usize) {
    use std::io::Write as _;
    let lease = partials.lease(&asset_numbered(index, 1 << 20)).unwrap();
    lease.describe(Some("\"v\""), Some(1 << 20));
    lease
        .writer()
        .unwrap()
        .write_all(&vec![index; bytes])
        .unwrap();
    drop(lease);
}

fn parts(root: &Path) -> Vec<String> {
    stored_entries(root)
        .into_iter()
        .filter(|name| name.ends_with(".part"))
        .collect()
}

#[test]
fn a_held_partial_survives_eviction_and_publishes_before_the_next_claim() {
    use std::io::Write as _;

    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("partial-v1");
    let partials =
        partial_download::PartialDownloads::with_bounds(root.clone(), 1, 2 << 20, Duration::ZERO);
    let original = b"original release archive";
    let asset = asset_numbered(1, original.len() as u64);
    let held = partials.lease(&asset).unwrap();
    held.describe(Some("\"v\""), Some(asset.size));
    held.writer().unwrap().write_all(original).unwrap();

    // The first lease owns the only slot until it publishes or releases it.
    assert!(partials.lease(&asset_numbered(2, 64)).is_none());
    assert!(partials.lease(&asset).is_none());
    assert_eq!(parts(&root).len(), 1);

    let destination = temporary.path().join("completed.zip");
    std::thread::scope(|scope| {
        let index = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(root.join(partial_download::INDEX_LOCK))
            .unwrap();
        index.lock().unwrap();
        let (started, starting) = std::sync::mpsc::channel();
        let (finished, finishing) = std::sync::mpsc::channel();
        let destination = &destination;
        scope.spawn(move || {
            started.send(()).unwrap();
            finished
                .send(held.finish(destination, || Ok(()), || Ok(())))
                .unwrap();
        });
        starting.recv().unwrap();
        let early = finishing.recv_timeout(Duration::from_millis(50));
        assert!(!destination.exists());
        drop(index);
        assert!(matches!(
            early,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        ));
        finishing.recv().unwrap().unwrap();
    });
    assert!(stored_entries(&root).is_empty());
    let fresh = partials.lease(&asset).unwrap();
    assert!(fresh.resumed().is_none());
    fresh.writer().unwrap().write_all(b"new transfer").unwrap();
    assert_eq!(fs::read(destination).unwrap(), original);
}

#[test]
fn unfinished_active_download_reserves_its_declared_bytes() {
    use std::io::Write as _;

    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("partial-v1");
    let partials = partial_download::PartialDownloads::with_bounds(
        root.clone(),
        4,
        (1 << 20) + 8,
        Duration::from_secs(3600),
    );
    let first = partials.lease(&asset_numbered(1, 1 << 20)).unwrap();
    first.describe(Some("\"v1\""), Some(1 << 20));
    first.writer().unwrap().write_all(b"first").unwrap();
    let second = asset_numbered(2, 1 << 20);

    assert!(partials.lease(&second).is_none());
    assert_eq!(parts(&root).len(), 1);

    drop(first);
    assert!(partials.lease(&second).is_some());
    assert_eq!(parts(&root).len(), 2);
}

#[test]
fn kept_bytes_stay_within_their_entry_and_byte_bounds() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("partial-v1");
    let partials = partial_download::PartialDownloads::with_bounds(
        root.clone(),
        4,
        64 << 20,
        Duration::from_secs(3600),
    );
    for index in 0..6_u8 {
        keep_entry(&partials, index, 4);
        std::thread::sleep(Duration::from_millis(20));
    }
    let kept = parts(&root);
    assert_eq!(kept.len(), 4);
    // The oldest entries went first.
    assert!(
        !kept
            .iter()
            .any(|name| name.starts_with(&asset_numbered(0, 1).sha256))
    );

    let small = temporary.path().join("small");
    let partials = partial_download::PartialDownloads::with_bounds(
        small.clone(),
        8,
        (1 << 20) + 8,
        Duration::from_secs(3600),
    );
    for index in 0..3_u8 {
        keep_entry(&partials, index, 8);
        std::thread::sleep(Duration::from_millis(20));
    }
    // Each new entry reserves its asset's whole size, so only two fit.
    assert_eq!(parts(&small).len(), 2);
}

#[test]
fn expired_and_leftover_entries_are_removed_on_the_next_use() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("partial-v1");
    let partials = partial_download::PartialDownloads::with_bounds(
        root.clone(),
        4,
        64 << 20,
        Duration::from_secs(60),
    );
    keep_entry(&partials, 1, 4);
    let old = std::time::UNIX_EPOCH + Duration::from_secs(1);
    for name in parts(&root) {
        fs::OpenOptions::new()
            .write(true)
            .open(root.join(name))
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(old))
            .unwrap();
    }
    fs::write(root.join(".portcove-partial-leftover"), b"crash").unwrap();
    fs::write(root.join("unpaired.json"), b"{}").unwrap();
    // Using the store for another asset removes the expired entry and the
    // leftovers.
    keep_entry(&partials, 2, 4);
    let names = stored_entries(&root);
    assert!(
        !names
            .iter()
            .any(|name| name.starts_with(".portcove-partial-"))
    );
    assert!(!names.iter().any(|name| name == "unpaired.json"));
    let kept = parts(&root);
    assert_eq!(kept.len(), 1);
    assert!(kept[0].starts_with(&asset_numbered(2, 1).sha256));
    // An expired entry of the same asset is not continued either.
    keep_entry(&partials, 3, 4);
    for name in parts(&root) {
        fs::OpenOptions::new()
            .write(true)
            .open(root.join(name))
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(old))
            .unwrap();
    }
    let lease = partials.lease(&asset_numbered(3, 1 << 20)).unwrap();
    assert!(lease.resumed().is_none());
}

/// First connection: a whole answer whose body starts quickly and then
/// trickles one byte every 100 ms. Later connections honour `Range` exactly.
async fn serve_trickle_then_range(
    body: Vec<u8>,
    fast_prefix: usize,
) -> (String, tokio::task::JoinHandle<Vec<String>>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let mut requests = Vec::new();
        for connection in 0..2 {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                request.push(stream.read_u8().await.unwrap());
            }
            let request = String::from_utf8(request).unwrap();
            if connection == 0 {
                let _ = stream
                    .write_all(&head("200 OK", Some("\"v1\""), "", body.len()))
                    .await;
                let _ = stream.write_all(&body[..fast_prefix]).await;
                for byte in &body[fast_prefix..] {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    if stream.write_all(&[*byte]).await.is_err() {
                        break;
                    }
                }
            } else {
                let offset: usize = ranged(&request)
                    .and_then(|range| {
                        range
                            .strip_prefix("bytes=")?
                            .strip_suffix('-')
                            .map(str::to_owned)
                    })
                    .unwrap()
                    .parse()
                    .unwrap();
                let _ = stream
                    .write_all(&partial(
                        Some("\"v1\""),
                        &format!("bytes {offset}-{}/{}", body.len() - 1, body.len()),
                        &body[offset..],
                    ))
                    .await;
            }
            requests.push(request);
        }
        requests
    });
    (format!("http://{address}"), server)
}

#[tokio::test]
async fn a_starved_transfer_is_cut_and_continues_byte_identically_after_a_restart() {
    let body: Vec<u8> = (0..96u8).collect();
    let digest = hex::encode(Sha256::digest(&body));
    let (root, server) = serve_trickle_then_range(body.clone(), 40).await;
    let asset = ReleaseAsset {
        name: "sample.zip".into(),
        url: format!("{root}/sample.zip"),
        size: body.len() as u64,
        sha256: digest.clone(),
    };
    let temporary = tempfile::tempdir().unwrap();
    let store_root = temporary.path().join("partial-v1");
    // The trickle (about three bytes per window) never trips the read-idle
    // bound, but falls below this floor in its second window.
    let policy = transfer::ResumePolicy {
        progress: crate::transfer_progress::ProgressFloor {
            window: Duration::from_millis(300),
            minimum_bytes: 5,
        },
        ..fast(0)
    };
    let client = reqwest::Client::builder()
        .no_proxy()
        .read_timeout(Duration::from_secs(15))
        .build()
        .unwrap();
    let first = temporary.path().join("first.download");
    let error = tokio::time::timeout(
        Duration::from_secs(30),
        transfer::download_resuming(
            &client,
            &asset,
            &first,
            &OperationCoordinator::new("download", None),
            &mut |_| {},
            policy,
            Some(transfer::RetainedDownload::private(
                &partial_download::PartialDownloads::new(store_root.clone()),
            )),
        ),
    )
    .await
    .expect("the progress floor must cut the trickle")
    .unwrap_err();
    assert_eq!(error.code, crate::ErrorCode::Network);
    assert!(
        error
            .details
            .contains_key(crate::transfer_progress::PROGRESS_FLOOR_DETAIL)
    );
    // Unattended setup treats the cut as temporary, never as a lasting verdict.
    assert_eq!(
        crate::TemporaryFailure::of(&error).map(|failure| failure.cause),
        Some(crate::TemporaryCause::Network)
    );
    // The received prefix is kept, bound to its validator.
    assert_eq!(stored_entries(&store_root).len(), 2);

    // A new store over the same directory stands in for the next Portcove run.
    let second = temporary.path().join("second.download");
    let mut messages = Vec::new();
    tokio::time::timeout(
        Duration::from_secs(30),
        transfer::download_resuming(
            &client,
            &asset,
            &second,
            &OperationCoordinator::new("download", None),
            &mut |event| {
                if let crate::OperationEventKind::Message { message, .. } = event.event {
                    messages.push(message);
                }
            },
            policy,
            Some(transfer::RetainedDownload::private(
                &partial_download::PartialDownloads::new(store_root.clone()),
            )),
        ),
    )
    .await
    .expect("transfer fixture exceeded thirty seconds")
    .unwrap();
    let file = fs::read(&second).unwrap();
    assert_eq!(file, body);
    assert_eq!(hex::encode(Sha256::digest(&file)), digest);
    assert!(messages[0].contains("Continuing the earlier download"));
    assert!(stored_entries(&store_root).is_empty());
    let requests = server.await.unwrap();
    let resumed_from: usize = ranged(&requests[1])
        .and_then(|range| {
            range
                .strip_prefix("bytes=")?
                .strip_suffix('-')
                .map(str::to_owned)
        })
        .unwrap()
        .parse()
        .unwrap();
    assert!(resumed_from >= 40, "{resumed_from}");
    assert_eq!(if_range(&requests[1]).as_deref(), Some("\"v1\""));
}

#[test]
fn an_asset_larger_than_the_byte_budget_keeps_its_progress_alone() {
    use std::io::Write as _;
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("partial-v1");
    // Formerly an asset over the budget could never keep bytes, so a large
    // game interrupted on a slow link always started over.
    let partials = partial_download::PartialDownloads::with_bounds(
        root.clone(),
        4,
        1 << 20,
        Duration::from_secs(3600),
    );
    keep_entry(&partials, 1, 8);
    let large = asset_numbered(9, 4 << 20);
    let lease = partials
        .lease(&large)
        .expect("the large asset may keep bytes");
    lease.describe(Some("\"v\""), Some(4 << 20));
    lease.writer().unwrap().write_all(&[9; 64]).unwrap();
    drop(lease);
    // The idle smaller entry made room; the large one's bytes continue.
    let kept = parts(&root);
    assert_eq!(kept.len(), 1, "{kept:?}");
    assert!(kept[0].starts_with(&large.sha256));
    let resumed = partials.lease(&large).unwrap();
    assert_eq!(resumed.resumed().unwrap().bytes, 64);
    drop(resumed);
    // While the large transfer is active, another asset cannot push the store
    // past the budget.
    let active = partials.lease(&large).unwrap();
    assert!(partials.lease(&asset_numbered(2, 1 << 20)).is_none());
    drop(active);
}
