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
        .read_timeout(Duration::from_millis(300))
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
                },
            ),
        )
        .await
        .expect("cancellation fixture exceeded thirty seconds")
    });
    server.join().unwrap();
    assert_eq!(result.unwrap_err().code, crate::ErrorCode::Cancelled);
    assert_eq!(requests.try_iter().count(), 2);
    // Everything accepted from both attempts reached the file before return.
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
