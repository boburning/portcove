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
}

/// Serves `responses` in order and runs one transfer under `policy`.
async fn run(responses: Vec<Vec<u8>>, policy: transfer::ResumePolicy) -> Outcome {
    let temporary = tempfile::tempdir().unwrap();
    let destination = temporary.path().join("artifact.download");
    let count = responses.len();
    let mut responses = responses.into_iter();
    let (root, requests, server) =
        serve_routed_http_bytes(count, move |_| responses.next().unwrap());
    let asset = ReleaseAsset {
        name: "sample.zip".into(),
        url: format!("{root}/sample.zip"),
        size: BODY.len() as u64,
        sha256: hex::encode(Sha256::digest(BODY)),
    };
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let operation = OperationCoordinator::new("download", None);
    let mut messages = Vec::new();
    let result = tokio::time::timeout(
        Duration::from_secs(30),
        transfer::download(
            &client,
            &asset,
            &destination,
            &operation,
            &mut |event| {
                if let crate::OperationEventKind::Message { message, .. } = event.event {
                    messages.push(message);
                }
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
    assert!(outcome.messages[0].contains("Continuing sample.zip"));
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
    assert!(outcome.messages[1].contains("again from the start"));
}

#[tokio::test]
async fn mismatched_content_range_restarts_from_zero() {
    for content_range in [
        "bytes 5-15/16",
        "bytes 6-14/16",
        "bytes 6-15/17",
        "bytes 6-15/*",
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
