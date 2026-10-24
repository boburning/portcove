use crate::Result;
mod requests;
#[cfg(any(windows, target_os = "linux"))]
pub(crate) use requests::HttpServer;
pub(crate) use requests::{serve_http, serve_routed_http};
use std::{
    io::{self, Read, Write},
    net::{TcpListener, TcpStream},
    sync::mpsc::{self, Receiver},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

#[derive(Debug, Default)]
pub(crate) struct DeadlineReport {
    pub(crate) armed: bool,
    pub(crate) request_received: bool,
}

/// Owns the server thread and all sockets until explicit finish or Drop.
pub(crate) struct DeadlineServer {
    start: Option<mpsc::Sender<()>>,
    release: mpsc::Sender<()>,
    connected: Receiver<()>,
    thread: Option<JoinHandle<io::Result<DeadlineReport>>>,
}

impl DeadlineServer {
    pub(crate) fn start(&mut self) {
        self.start.take().unwrap().send(()).unwrap();
    }

    pub(crate) fn wait_for_connection(&self) {
        self.connected.recv_timeout(Duration::from_secs(2)).unwrap();
    }

    pub(crate) fn finish(mut self) -> io::Result<DeadlineReport> {
        self.start.take();
        let _ = self.release.send(());
        self.thread
            .take()
            .unwrap()
            .join()
            .map_err(|_| io::Error::other("deadline fixture thread panicked"))?
    }
}

impl Drop for DeadlineServer {
    fn drop(&mut self) {
        self.start.take();
        let _ = self.release.send(());
        if let Some(thread) = self.thread.take() {
            // Preserve a primary test failure while draining bounded I/O.
            let _ = thread.join();
        }
    }
}

/// Scenario code can write or wait, but cannot bypass socket/deadline ownership.
pub(crate) struct DeadlineConnection {
    stream: TcpStream,
    deadline: Instant,
    released: Receiver<()>,
}

impl DeadlineConnection {
    fn remaining(&self) -> io::Result<Duration> {
        self.deadline
            .checked_duration_since(Instant::now())
            .filter(|remaining| !remaining.is_zero())
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::TimedOut,
                    "deadline fixture exhausted its socket budget",
                )
            })
    }

    pub(crate) fn write_all(&mut self, bytes: &[u8]) -> io::Result<()> {
        self.stream.set_write_timeout(Some(self.remaining()?))?;
        self.stream.write_all(bytes)
    }

    pub(crate) fn flush(&mut self) -> io::Result<()> {
        self.stream.set_write_timeout(Some(self.remaining()?))?;
        self.stream.flush()
    }

    /// True means stop/deadline; false means the requested interval elapsed.
    pub(crate) fn wait(&self, duration: Duration) -> bool {
        let remaining = self.deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return true;
        }
        match self.released.recv_timeout(duration.min(remaining)) {
            Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => true,
            Err(mpsc::RecvTimeoutError::Timeout) => Instant::now() >= self.deadline,
        }
    }
}

pub(crate) fn serve_deadline(
    response: impl FnOnce(&mut DeadlineConnection) -> io::Result<()> + Send + 'static,
) -> (String, DeadlineServer) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    listener.set_nonblocking(true).unwrap();
    let (start, started) = mpsc::channel();
    let (release, released) = mpsc::channel();
    let (connected_tx, connected) = mpsc::channel();
    let server = thread::spawn(move || {
        // Trust/proxy setup happens before arming this request-phase budget.
        if started.recv_timeout(Duration::from_secs(30)).is_err() {
            return Ok(DeadlineReport::default());
        }
        let deadline = Instant::now() + Duration::from_secs(2);
        let stopped = || DeadlineReport {
            armed: true,
            request_received: false,
        };
        let stream = loop {
            if released.try_recv().is_ok() || Instant::now() >= deadline {
                return Ok(stopped());
            }
            match listener.accept() {
                Ok((stream, _)) => break stream,
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(1))
                }
                Err(error) => return Err(error),
            }
        };
        stream.set_nonblocking(false)?;
        let _ = connected_tx.send(());
        let mut connection = DeadlineConnection {
            stream,
            deadline,
            released,
        };
        let mut request = [0_u8; 4096];
        let mut length = 0;
        while !request[..length].ends_with(b"\r\n\r\n") {
            if connection.released.try_recv().is_ok() {
                return Ok(stopped());
            }
            if length == request.len() {
                return Err(io::Error::other(
                    "deadline fixture request exceeded 4096 bytes",
                ));
            }
            // Poll stop during incomplete headers; retain the absolute I/O cap.
            connection
                .stream
                .set_read_timeout(Some(connection.remaining()?.min(Duration::from_millis(20))))?;
            match connection.stream.read(&mut request[length..]) {
                Ok(0) => {
                    return Err(io::Error::new(
                        io::ErrorKind::UnexpectedEof,
                        "deadline fixture request ended before headers",
                    ));
                }
                Ok(read) => length += read,
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::WouldBlock
                            | io::ErrorKind::TimedOut
                            | io::ErrorKind::Interrupted
                    ) =>
                {
                    continue;
                }
                Err(error) => return Err(error),
            }
        }
        response(&mut connection)?;
        Ok(DeadlineReport {
            armed: true,
            request_received: true,
        })
    });
    (
        format!("http://{address}"),
        DeadlineServer {
            start: Some(start),
            release,
            connected,
            thread: Some(server),
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partial_headers_report_eof_after_join() {
        let (root, mut server) = serve_deadline(|_| panic!("incomplete request reached scenario"));
        server.start();
        let mut client = TcpStream::connect(root.strip_prefix("http://").unwrap()).unwrap();
        server.wait_for_connection();
        client.write_all(b"GET / HTTP/1.1\r\n").unwrap();
        client.shutdown(std::net::Shutdown::Write).unwrap();
        // Wait for the server's terminal result rather than sending stop first.
        let deadline = Instant::now() + Duration::from_secs(3);
        while !server.thread.as_ref().unwrap().is_finished() && Instant::now() < deadline {
            thread::yield_now();
        }
        assert!(server.thread.as_ref().unwrap().is_finished());
        let error = server.finish().unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::UnexpectedEof);
        assert!(error.to_string().contains("before headers"));
    }

    #[test]
    fn oversized_request_reports_its_bound_after_join() {
        let (root, mut server) = serve_deadline(|_| panic!("oversized request reached scenario"));
        server.start();
        let mut client = TcpStream::connect(root.strip_prefix("http://").unwrap()).unwrap();
        server.wait_for_connection();
        client.write_all(&[b'x'; 4096]).unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        while !server.thread.as_ref().unwrap().is_finished() && Instant::now() < deadline {
            thread::yield_now();
        }
        assert!(server.thread.as_ref().unwrap().is_finished());
        let error = server.finish().unwrap_err();
        assert!(error.to_string().contains("exceeded 4096"));
    }

    #[test]
    fn drop_joins_unarmed_unconnected_and_incomplete_requests() {
        for phase in 0..3 {
            let (sentinel, witness) = mpsc::channel::<()>();
            let (root, mut server) = serve_deadline(move |_| {
                let _ = sentinel.send(());
                panic!("incomplete request reached scenario")
            });
            if phase > 0 {
                server.start();
            }
            let mut client = (phase == 2)
                .then(|| TcpStream::connect(root.strip_prefix("http://").unwrap()).unwrap());
            if let Some(client) = client.as_mut() {
                server.wait_for_connection();
                client.write_all(b"GET / HTTP/1.1\r\n").unwrap();
            }
            let started = Instant::now();
            drop(server);
            assert!(started.elapsed() < Duration::from_millis(500));
            assert_eq!(witness.try_recv(), Err(mpsc::TryRecvError::Disconnected));
        }
    }

    #[test]
    fn drop_stops_and_joins_an_entered_body_stall() {
        let (sentinel, witness) = mpsc::channel::<()>();
        let (root, mut server) = serve_deadline(move |connection| {
            connection.write_all(b"body")?;
            connection.flush()?;
            connection.wait(Duration::from_millis(600));
            drop(sentinel);
            Ok(())
        });
        server.start();
        let mut client = TcpStream::connect(root.strip_prefix("http://").unwrap()).unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        client.write_all(b"GET / HTTP/1.1\r\n\r\n").unwrap();
        let mut body = [0; 4];
        client.read_exact(&mut body).unwrap();
        assert_eq!(&body, b"body");
        let started = Instant::now();
        drop(server);
        assert!(started.elapsed() < Duration::from_millis(500));
        assert_eq!(witness.try_recv(), Err(mpsc::TryRecvError::Disconnected));
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ResponseTestPhase {
    Headers,
    Body,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct ResponseTestObservation {
    pub(crate) headers: Option<Instant>,
    pub(crate) first_body: Option<Instant>,
    pub(crate) last_body: Option<Instant>,
    pub(crate) body_bytes: usize,
    pub(crate) failed_phase: Option<ResponseTestPhase>,
    pub(crate) timed_out: bool,
    pub(crate) failed_at: Option<Instant>,
}

pub(crate) enum ResponseTestEvent {
    Headers,
    Body(usize),
    Failed(ResponseTestPhase, bool),
}

tokio::task_local! {
    static RESPONSE_TEST_OBSERVATION: std::cell::RefCell<ResponseTestObservation>;
}

pub(crate) fn observe_test_response(event: ResponseTestEvent) {
    let _ = RESPONSE_TEST_OBSERVATION.try_with(|state| {
        let mut state = state.borrow_mut();
        let now = Instant::now();
        match event {
            ResponseTestEvent::Headers => state.headers = Some(now),
            ResponseTestEvent::Body(bytes) => {
                state.first_body.get_or_insert(now);
                state.last_body = Some(now);
                state.body_bytes += bytes;
            }
            ResponseTestEvent::Failed(phase, timeout) => {
                state.failed_phase = Some(phase);
                state.timed_out = timeout;
                state.failed_at = Some(now);
            }
        }
    });
}

pub(crate) async fn observe_response<T>(
    future: impl std::future::Future<Output = Result<T>>,
) -> (Result<T>, ResponseTestObservation) {
    RESPONSE_TEST_OBSERVATION
        .scope(std::cell::RefCell::default(), async {
            let result = future.await;
            let observation = RESPONSE_TEST_OBSERVATION.with(|state| state.borrow().clone());
            (result, observation)
        })
        .await
}
