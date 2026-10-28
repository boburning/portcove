use std::{
    io::{self, Read, Write},
    net::{TcpListener, TcpStream},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

const REQUEST_CAP: usize = 16 * 1024;
const SOCKET_BUDGET: Duration = Duration::from_secs(2);
const POLL: Duration = Duration::from_millis(1);

#[derive(Default)]
struct Stop {
    finish: AtomicBool,
    cancel: AtomicBool,
}

/// Joining stops admission; dropping also interrupts an incomplete exchange.
pub(crate) struct HttpServer {
    stop: Arc<Stop>,
    thread: Option<JoinHandle<io::Result<usize>>>,
    expected: Option<usize>,
    connected: Receiver<()>,
}

impl HttpServer {
    pub(crate) fn join(mut self) -> io::Result<()> {
        self.stop.finish.store(true, Ordering::SeqCst);
        let handled = self
            .thread
            .take()
            .unwrap()
            .join()
            .map_err(|_| io::Error::other("HTTP fixture thread panicked"))??;
        if let Some(expected) = self.expected
            && handled != expected
        {
            return Err(io::Error::other(format!(
                "HTTP fixture handled {handled} of {expected} required requests"
            )));
        }
        Ok(())
    }
}

impl Drop for HttpServer {
    fn drop(&mut self) {
        self.stop.finish.store(true, Ordering::SeqCst);
        self.stop.cancel.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            // Drain even during unwinding, preserving the original assertion.
            let _ = thread.join();
        }
    }
}

pub(crate) fn serve_http(responses: Vec<String>) -> (String, Receiver<String>, HttpServer) {
    let expected = responses.len();
    let mut responses = responses.into_iter();
    serve_requests(expected, Some(expected), move |_| responses.next().unwrap())
}

pub(crate) fn serve_http_bytes(responses: Vec<Vec<u8>>) -> (String, Receiver<String>, HttpServer) {
    let expected = responses.len();
    let mut responses = responses.into_iter();
    serve_requests(expected, Some(expected), move |_| responses.next().unwrap())
}

pub(crate) fn serve_routed_http(
    request_limit: usize,
    response: impl Fn(&str) -> String + Send + 'static,
) -> (String, Receiver<String>, HttpServer) {
    serve_requests(request_limit, None, response)
}

fn serve_requests<R: AsRef<[u8]>>(
    limit: usize,
    expected: Option<usize>,
    mut response: impl FnMut(&str) -> R + Send + 'static,
) -> (String, Receiver<String>, HttpServer) {
    // Bound ephemeral listener is ready before the address is published.
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    listener.set_nonblocking(true).unwrap();
    let (requests_tx, requests) = mpsc::channel();
    let (connected_tx, connected) = mpsc::channel();
    let stop = Arc::new(Stop::default());
    let worker_stop = Arc::clone(&stop);
    let worker = thread::spawn(move || {
        // Provider construction and trust/proxy setup precede request I/O.
        let accept_deadline = Instant::now() + Duration::from_secs(30);
        let mut handled = 0;
        while handled < limit && !worker_stop.finish.load(Ordering::SeqCst) {
            if Instant::now() >= accept_deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "HTTP fixture exhausted its accept budget",
                ));
            }
            let (mut stream, _) = match listener.accept() {
                Ok(connection) => connection,
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(1));
                    continue;
                }
                Err(error) => return Err(error),
            };
            // Blocking Winsock timeouts leave transfer progress indeterminate.
            // Poll nonblocking I/O so only successful byte counts advance offsets.
            stream.set_nonblocking(true)?;
            let _ = connected_tx.send(());
            let deadline = Instant::now() + SOCKET_BUDGET;
            let request = read_request(&mut stream, deadline, &worker_stop)?;
            // Preserve the old vector helper's early, best-effort notification.
            if expected.is_some() {
                let _ = requests_tx.send(request.clone());
            }
            let bytes = response(&request);
            write_response(&mut stream, bytes.as_ref(), deadline, &worker_stop)?;
            // Routed callers observe requests only after writing the response.
            if expected.is_none() {
                requests_tx
                    .send(request)
                    .map_err(|_| io::Error::other("HTTP fixture request receiver disconnected"))?;
            }
            handled += 1;
        }
        Ok(handled)
    });
    (
        format!("http://{address}"),
        requests,
        HttpServer {
            stop,
            thread: Some(worker),
            expected,
            connected,
        },
    )
}

fn remaining(deadline: Instant, stop: &Stop) -> io::Result<Duration> {
    if stop.cancel.load(Ordering::SeqCst) {
        return Err(io::Error::new(
            io::ErrorKind::Interrupted,
            "HTTP fixture exchange cancelled",
        ));
    }
    deadline
        .checked_duration_since(Instant::now())
        .filter(|remaining| !remaining.is_zero())
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::TimedOut,
                "HTTP fixture exhausted its absolute socket budget",
            )
        })
}

fn retryable(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
    )
}

fn read_request(stream: &mut TcpStream, deadline: Instant, stop: &Stop) -> io::Result<String> {
    let mut request = [0_u8; REQUEST_CAP];
    let mut length = 0;
    let mut total = None;
    loop {
        remaining(deadline, stop)?;
        if total.is_none()
            && let Some(at) = request[..length].windows(4).position(|s| s == b"\r\n\r\n")
        {
            let headers = at + 4;
            let body = body_length(&request[..headers])?;
            total = Some(
                headers
                    .checked_add(body)
                    .filter(|n| *n <= REQUEST_CAP)
                    .ok_or_else(|| {
                        io::Error::new(
                            io::ErrorKind::InvalidData,
                            "HTTP fixture request exceeded 16384 bytes",
                        )
                    })?,
            );
        }
        if let Some(total) = total
            && length >= total
        {
            return Ok(String::from_utf8_lossy(&request[..total]).into_owned());
        }
        let end = total.unwrap_or(REQUEST_CAP);
        if length == end {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "HTTP fixture request exceeded 16384 bytes before complete headers",
            ));
        }
        match stream.read(&mut request[length..end]) {
            Ok(0) => {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    if total.is_some() {
                        "HTTP fixture request ended before its declared body"
                    } else {
                        "HTTP fixture request ended before complete headers"
                    },
                ));
            }
            Ok(read) => length += read,
            Err(error) if retryable(&error) => {
                thread::sleep(POLL.min(remaining(deadline, stop)?));
            }
            Err(error) => return Err(error),
        }
    }
}

fn body_length(headers: &[u8]) -> io::Result<usize> {
    let invalid = || {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "HTTP fixture invalid request framing",
        )
    };
    let headers = std::str::from_utf8(headers).map_err(|_| invalid())?;
    let mut length = None;
    for header in headers.split("\r\n").skip(1).filter(|h| !h.is_empty()) {
        let (name, value) = header.split_once(':').ok_or_else(invalid)?;
        // A space before ':' must not hide Content-Length/Transfer-Encoding.
        if name.is_empty()
            || !name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b))
        {
            return Err(invalid());
        }
        if name.eq_ignore_ascii_case("transfer-encoding") {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "HTTP fixture does not support transfer-encoding",
            ));
        }
        if name.eq_ignore_ascii_case("content-length") {
            let value = value.trim();
            if length.is_some() || value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
                return Err(invalid());
            }
            length = Some(value.parse::<usize>().map_err(|_| invalid())?);
        }
    }
    Ok(length.unwrap_or(0))
}

fn write_response(
    stream: &mut TcpStream,
    mut bytes: &[u8],
    deadline: Instant,
    stop: &Stop,
) -> io::Result<()> {
    while !bytes.is_empty() {
        remaining(deadline, stop)?;
        // Partial writes must recheck the same absolute deadline and stop flag.
        match stream.write(&bytes[..bytes.len().min(64 * 1024)]) {
            Ok(0) => {
                return Err(io::Error::new(
                    io::ErrorKind::WriteZero,
                    "HTTP fixture wrote zero bytes",
                ));
            }
            Ok(written) => bytes = &bytes[written..],
            Err(error) if retryable(&error) => {
                thread::sleep(POLL.min(remaining(deadline, stop)?));
            }
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Shutdown;

    fn client(root: &str, server: &HttpServer) -> TcpStream {
        let stream = TcpStream::connect(root.strip_prefix("http://").unwrap()).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        stream
            .set_write_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        server
            .connected
            .recv_timeout(Duration::from_secs(3))
            .unwrap();
        stream
    }

    fn await_worker(server: &HttpServer) -> bool {
        let deadline = Instant::now() + Duration::from_secs(3);
        while !server.thread.as_ref().unwrap().is_finished() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(1));
        }
        server.thread.as_ref().unwrap().is_finished()
    }

    #[test]
    fn client_refusal_reports_missing_required_requests_after_join() {
        let (_root, _requests, server) = serve_http(vec!["unused".into()]);
        let started = Instant::now();
        let error = server.join().unwrap_err();
        assert!(started.elapsed() < Duration::from_millis(500));
        assert!(
            error
                .to_string()
                .contains("handled 0 of 1 required requests")
        );
    }

    #[test]
    fn patterned_response_survives_delayed_fragmented_receiver() {
        let payload: Vec<u8> = (0..8 * 1024 * 1024)
            .map(|i| ((i / 257) ^ i) as u8)
            .collect();
        let mut response = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            payload.len()
        )
        .into_bytes();
        response.extend_from_slice(&payload);
        let expected = crate::signed_catalog::digest(&response);
        let (root, _requests, server) = serve_http_bytes(vec![response]);
        let mut peer = client(&root, &server);
        peer.write_all(b"GET /pattern.zip HTTP/1.1\r\nHost: fixture\r\n\r\n")
            .unwrap();
        // Exceed the former20ms blocking-send poll while retaining the same
        // absolute exchange budget. A replayed partial send changes the digest.
        thread::sleep(Duration::from_millis(150));
        let mut received = Vec::new();
        let mut fragment = [0_u8; 4093];
        loop {
            let count = peer.read(&mut fragment).unwrap();
            if count == 0 {
                break;
            }
            received.extend_from_slice(&fragment[..count]);
            assert!(received.len() <= payload.len() + 1024);
        }
        assert_eq!(crate::signed_catalog::digest(&received), expected);
        server.join().unwrap();
    }

    #[test]
    fn binary_response_preserves_bytes_after_fragmented_headers() {
        let response = b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\n\0\xff\xfe\0";
        let (root, requests, server) = serve_http_bytes(vec![response.to_vec()]);
        let mut client = client(&root, &server);
        client.write_all(b"GET /archive.zip HTTP/1.1\r\n").unwrap();
        assert!(matches!(
            requests.recv_timeout(Duration::from_millis(20)),
            Err(mpsc::RecvTimeoutError::Timeout)
        ));
        client.write_all(b"Host: fixture\r\n\r\n").unwrap();
        assert_eq!(
            requests.recv_timeout(Duration::from_secs(3)).unwrap(),
            "GET /archive.zip HTTP/1.1\r\nHost: fixture\r\n\r\n"
        );
        let mut bytes = Vec::new();
        client.read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, response);
        server.join().unwrap();
    }

    #[test]
    fn routed_limit_is_an_upper_bound_and_records_the_complete_body() {
        let (root, requests, server) = serve_routed_http(3, |request| {
            assert!(request.ends_with("payload"));
            "response".into()
        });
        let mut client = client(&root, &server);
        client
            .write_all(b"POST / HTTP/1.1\r\nContent-Length: 7\r\n\r\npay")
            .unwrap();
        assert_eq!(requests.try_recv(), Err(mpsc::TryRecvError::Empty));
        client.write_all(b"load").unwrap();
        let request = requests.recv_timeout(Duration::from_secs(3)).unwrap();
        assert_eq!(
            request,
            "POST / HTTP/1.1\r\nContent-Length: 7\r\n\r\npayload"
        );
        let mut bytes = String::new();
        client.read_to_string(&mut bytes).unwrap();
        assert_eq!(bytes, "response");
        let started = Instant::now();
        server.join().unwrap();
        assert!(started.elapsed() < Duration::from_millis(500));
    }

    #[test]
    fn vector_notification_precedes_response_and_ignores_a_closed_receiver() {
        let (continue_tx, continue_rx) = mpsc::channel();
        let (root, requests, server) = serve_requests(1, Some(1), move |_| {
            continue_rx.recv_timeout(Duration::from_secs(2)).unwrap();
            "response".to_owned()
        });
        let mut client = client(&root, &server);
        client.write_all(b"GET / HTTP/1.1\r\n\r\n").unwrap();
        let observed = requests.recv_timeout(Duration::from_secs(3));
        continue_tx.send(()).unwrap();
        assert_eq!(observed.unwrap(), "GET / HTTP/1.1\r\n\r\n");
        let mut bytes = String::new();
        client.read_to_string(&mut bytes).unwrap();
        assert_eq!(bytes, "response");
        server.join().unwrap();

        let (root, requests, server) = serve_http(vec!["response".into()]);
        drop(requests);
        let mut client = self::client(&root, &server);
        client.write_all(b"GET / HTTP/1.1\r\n\r\n").unwrap();
        let mut bytes = String::new();
        client.read_to_string(&mut bytes).unwrap();
        assert_eq!(bytes, "response");
        server.join().unwrap();
    }

    #[test]
    fn routed_receiver_failure_remains_an_error_after_response() {
        let (root, requests, server) = serve_routed_http(1, |_| "response".into());
        drop(requests);
        let mut client = client(&root, &server);
        client.write_all(b"GET / HTTP/1.1\r\n\r\n").unwrap();
        let mut bytes = String::new();
        client.read_to_string(&mut bytes).unwrap();
        assert_eq!(bytes, "response");
        assert!(
            server
                .join()
                .unwrap_err()
                .to_string()
                .contains("receiver disconnected")
        );
    }

    #[test]
    fn partial_headers_and_declared_body_report_eof_after_join() {
        for (bytes, reason) in [
            ("GET / HTTP/1.1\r\n", "before complete headers"),
            (
                "POST / HTTP/1.1\r\nContent-Length: 7\r\n\r\npay",
                "before its declared body",
            ),
        ] {
            let (root, _requests, server) =
                serve_routed_http(1, |_| panic!("incomplete request reached responder"));
            let mut client = client(&root, &server);
            client.write_all(bytes.as_bytes()).unwrap();
            client.shutdown(Shutdown::Write).unwrap();
            assert!(await_worker(&server));
            let error = server.join().unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::UnexpectedEof);
            assert!(error.to_string().contains(reason));
        }
    }

    #[test]
    fn oversized_and_unsupported_request_framing_never_reaches_responder() {
        for bytes in [
            vec![b'x'; REQUEST_CAP],
            b"POST / HTTP/1.1\r\nContent-Length: 16384\r\n\r\n".to_vec(),
            b"POST / HTTP/1.1\r\nContent-Length: 999999999999999999999999999999\r\n\r\n".to_vec(),
            b"POST / HTTP/1.1\r\nContent-Length: 1\r\nContent-Length: 1\r\n\r\n".to_vec(),
            b"POST / HTTP/1.1\r\nContent-Length: +1\r\n\r\n".to_vec(),
            b"POST / HTTP/1.1\r\nContent-Length: invalid\r\n\r\n".to_vec(),
            b"POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n".to_vec(),
            b"POST / HTTP/1.1\r\nContent-Length : 7\r\n\r\npay".to_vec(),
            b"POST / HTTP/1.1\r\nTransfer-Encoding : chunked\r\n\r\n".to_vec(),
            b"POST / HTTP/1.1\r\n Content-Length: 7\r\n\r\npay".to_vec(),
            b"POST / HTTP/1.1\r\n: invalid\r\n\r\n".to_vec(),
        ] {
            let (root, _requests, server) =
                serve_routed_http(1, |_| panic!("invalid request reached responder"));
            let mut client = client(&root, &server);
            client.write_all(&bytes).unwrap();
            assert!(await_worker(&server));
            let error = server.join().unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::InvalidData);
            assert!(error.to_string().starts_with("HTTP fixture"));
        }
    }

    #[test]
    fn stalled_declared_body_exhausts_the_absolute_socket_budget() {
        let (root, _requests, server) =
            serve_routed_http(1, |_| panic!("incomplete body reached responder"));
        let mut client = client(&root, &server);
        client
            .write_all(b"POST / HTTP/1.1\r\nContent-Length: 7\r\n\r\npay")
            .unwrap();
        assert!(await_worker(&server));
        let error = server.join().unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert!(error.to_string().contains("absolute socket budget"));
    }

    #[test]
    fn drop_joins_unconnected_partial_headers_and_partial_bodies() {
        for bytes in [
            None,
            Some("GET / HTTP/1.1\r\n"),
            Some("POST / HTTP/1.1\r\nContent-Length: 7\r\n\r\npay"),
        ] {
            let (sentinel, witness) = mpsc::channel::<()>();
            let (root, _requests, server) = serve_routed_http(1, move |_| {
                let _ = sentinel.send(());
                panic!("incomplete request reached responder")
            });
            let mut client = bytes.map(|_| client(&root, &server));
            if let (Some(client), Some(bytes)) = (client.as_mut(), bytes) {
                client.write_all(bytes.as_bytes()).unwrap();
            }
            let started = Instant::now();
            drop(server);
            assert!(started.elapsed() < Duration::from_millis(500));
            assert_eq!(witness.try_recv(), Err(mpsc::TryRecvError::Disconnected));
        }
    }

    #[test]
    fn drop_stops_and_joins_a_backpressured_response() {
        let (sentinel, witness) = mpsc::channel::<()>();
        let (root, _requests, server) = serve_routed_http(1, move |_| {
            let _keep_alive = &sentinel;
            "x".repeat(16 * 1024 * 1024)
        });
        let mut client = client(&root, &server);
        client.write_all(b"GET / HTTP/1.1\r\n\r\n").unwrap();
        let mut bytes = [0; 4];
        client.read_exact(&mut bytes).unwrap();
        assert_eq!(&bytes, b"xxxx");
        assert!(!server.thread.as_ref().unwrap().is_finished());
        let started = Instant::now();
        drop(server);
        assert!(started.elapsed() < Duration::from_millis(500));
        assert_eq!(witness.try_recv(), Err(mpsc::TryRecvError::Disconnected));
    }

    #[test]
    fn response_progress_does_not_renew_the_absolute_write_budget() {
        let (root, _requests, server) = serve_routed_http(1, |_| "x".repeat(16 * 1024 * 1024));
        let mut client = client(&root, &server);
        client.write_all(b"GET / HTTP/1.1\r\n\r\n").unwrap();
        let (release_tx, release_rx) = mpsc::channel();
        let reader = thread::spawn(move || {
            let mut chunks = 0;
            let mut bytes = [0; 1024];
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                if release_rx.try_recv().is_ok() || Instant::now() >= deadline {
                    break;
                }
                if client.read(&mut bytes).unwrap() == 0 {
                    break;
                }
                chunks += 1;
                thread::sleep(Duration::from_millis(10));
            }
            chunks
        });
        let finished = await_worker(&server);
        let _ = release_tx.send(());
        let chunks = reader.join().unwrap();
        // Drain the peer before assertions so an unexpected outcome cannot leak it.
        assert!(finished, "response progress renewed the write deadline");
        let error = server.join().unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert!(error.to_string().contains("absolute socket budget"));
        assert!(
            chunks >= 3,
            "peer made insufficient response progress: {chunks}"
        );
    }
}
