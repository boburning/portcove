use super::*;
use std::sync::{Mutex, atomic::AtomicUsize};

static NEXT_TEMPORARY: AtomicU64 = AtomicU64::new(1);

struct TemporaryDirectory(PathBuf);

impl TemporaryDirectory {
    fn new() -> Self {
        let ordinal = NEXT_TEMPORARY.fetch_add(1, Ordering::Relaxed);
        let timestamp = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "portcove-diagnostics-{}-{timestamp}-{ordinal}",
            std::process::id()
        ));
        fs::create_dir(&path).unwrap();
        Self(fs::canonicalize(path).unwrap())
    }

    fn log(&self) -> PathBuf {
        self.0.join(LOG_FILE_NAME)
    }
}

impl Drop for TemporaryDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn small_limits() -> Limits {
    Limits {
        queue_capacity: 64,
        max_record_bytes: 32,
        max_file_bytes: 64,
        retained_files: 2,
        ..Limits::default()
    }
}

fn wait_until(mut predicate: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !predicate() {
        assert!(
            Instant::now() < deadline,
            "bounded writer observation timed out"
        );
        thread::sleep(Duration::from_millis(1));
    }
}

#[derive(Default)]
struct NoopSink;

impl DiagnosticSink for NoopSink {
    fn write_record(&mut self, _record: &[u8]) -> Result<(), SinkError> {
        Ok(())
    }

    fn flush(&mut self) -> Result<(), SinkError> {
        Ok(())
    }
}

struct FaultSink {
    fault: SinkError,
    during_initialization: bool,
    during_flush: bool,
}

impl DiagnosticSink for FaultSink {
    fn initialize(&mut self) -> Result<(), SinkError> {
        if self.during_initialization {
            Err(self.fault)
        } else {
            Ok(())
        }
    }

    fn write_record(&mut self, _record: &[u8]) -> Result<(), SinkError> {
        if self.during_flush {
            Ok(())
        } else {
            Err(self.fault)
        }
    }

    fn flush(&mut self) -> Result<(), SinkError> {
        if self.during_flush {
            Err(self.fault)
        } else {
            Ok(())
        }
    }
}

struct HeldSink {
    entered: Option<SyncSender<()>>,
    release: Receiver<()>,
    records: Arc<Mutex<Vec<Vec<u8>>>>,
}

impl DiagnosticSink for HeldSink {
    fn write_record(&mut self, record: &[u8]) -> Result<(), SinkError> {
        if let Some(entered) = self.entered.take() {
            entered.try_send(()).unwrap();
            self.release
                .recv_timeout(Duration::from_secs(10))
                .map_err(|_| SinkError {
                    stage: FailureStage::Write,
                    kind: io::ErrorKind::TimedOut,
                })?;
        }
        self.records.lock().unwrap().push(record.to_vec());
        Ok(())
    }

    fn flush(&mut self) -> Result<(), SinkError> {
        Ok(())
    }
}

type HeldWriter = (
    Producer,
    Guard,
    Receiver<()>,
    SyncSender<()>,
    Arc<Mutex<Vec<Vec<u8>>>>,
);

fn held_writer(limits: Limits) -> HeldWriter {
    let (entered, observe) = mpsc::sync_channel(1);
    let (release, await_release) = mpsc::sync_channel(1);
    let records = Arc::new(Mutex::new(Vec::new()));
    let (producer, guard) = RuntimeWriter::start_with_sink(
        limits,
        HeldSink {
            entered: Some(entered),
            release: await_release,
            records: Arc::clone(&records),
        },
    )
    .unwrap();
    (producer, guard, observe, release, records)
}

#[test]
fn failure_health_is_independent_and_has_closed_reasons() {
    for (stage, kind) in [
        (FailureStage::Open, io::ErrorKind::PermissionDenied),
        (FailureStage::Write, io::ErrorKind::StorageFull),
        (FailureStage::Write, io::ErrorKind::BrokenPipe),
        (FailureStage::Rotation, io::ErrorKind::PermissionDenied),
        (FailureStage::Retention, io::ErrorKind::Other),
        (FailureStage::Flush, io::ErrorKind::StorageFull),
    ] {
        let (producer, mut guard) = RuntimeWriter::start_with_sink(
            small_limits(),
            FaultSink {
                fault: SinkError { stage, kind },
                during_initialization: false,
                during_flush: stage == FailureStage::Flush,
            },
        )
        .unwrap();
        assert_eq!(
            producer.try_record(b"{}\n".to_vec()),
            EnqueueOutcome::Accepted
        );
        let health = guard.shutdown(Duration::from_secs(2));
        assert_eq!(health.admitted, 1);
        assert_eq!(health.flush_state, FlushState::Failed);
        assert_eq!(health.queue_depth, 0);
        assert_eq!(health.open_errors, u64::from(stage == FailureStage::Open));
        assert_eq!(health.write_errors, u64::from(stage == FailureStage::Write));
        assert_eq!(
            health.rotation_errors,
            u64::from(stage == FailureStage::Rotation)
        );
        assert_eq!(
            health.retention_errors,
            u64::from(stage == FailureStage::Retention)
        );
        assert_eq!(health.flush_errors, u64::from(stage == FailureStage::Flush));
        assert_eq!(
            health.permission_errors,
            u64::from(kind == io::ErrorKind::PermissionDenied)
        );
        assert_eq!(
            health.disk_full_errors,
            u64::from(kind == io::ErrorKind::StorageFull)
        );
        assert_eq!(health.written, u64::from(stage == FailureStage::Flush));
        assert_eq!(health.dropped, u64::from(stage != FailureStage::Flush));
    }
}

#[test]
fn failed_initialization_remains_readable_and_never_admits_later_work() {
    let (producer, mut guard) = RuntimeWriter::start_with_sink(
        small_limits(),
        FaultSink {
            fault: SinkError {
                stage: FailureStage::Open,
                kind: io::ErrorKind::PermissionDenied,
            },
            during_initialization: true,
            during_flush: false,
        },
    )
    .unwrap();
    wait_until(|| producer.health().flush_state == FlushState::Unavailable);
    assert_eq!(
        producer.try_record(b"{}\n".to_vec()),
        EnqueueOutcome::DroppedClosed
    );
    let health = guard.shutdown(Duration::from_secs(2));
    assert_eq!(health.flush_state, FlushState::Unavailable);
    assert_eq!(health.open_errors, 1);
    assert_eq!(health.permission_errors, 1);
    assert_eq!(health.written, 0);
    assert_eq!(health.dropped_closed, 1);
}

#[test]
fn initialization_failure_explicitly_accounts_for_already_accepted_records() {
    struct HeldInitialization {
        entered: SyncSender<()>,
        release: Receiver<()>,
    }
    impl DiagnosticSink for HeldInitialization {
        fn initialize(&mut self) -> Result<(), SinkError> {
            self.entered.try_send(()).unwrap();
            self.release.recv_timeout(Duration::from_secs(5)).unwrap();
            Err(SinkError {
                stage: FailureStage::Open,
                kind: io::ErrorKind::PermissionDenied,
            })
        }
        fn write_record(&mut self, _record: &[u8]) -> Result<(), SinkError> {
            panic!("unavailable sink must not receive a write")
        }
        fn flush(&mut self) -> Result<(), SinkError> {
            panic!("unavailable sink must not receive a flush")
        }
    }
    let (entered, observe) = mpsc::sync_channel(1);
    let (release, await_release) = mpsc::sync_channel(1);
    let (producer, mut guard) = RuntimeWriter::start_with_sink(
        small_limits(),
        HeldInitialization {
            entered,
            release: await_release,
        },
    )
    .unwrap();
    observe.recv_timeout(Duration::from_secs(2)).unwrap();
    for _ in 0..3 {
        assert_eq!(
            producer.try_record(b"{}\n".to_vec()),
            EnqueueOutcome::Accepted
        );
    }
    release.try_send(()).unwrap();
    let health = guard.shutdown(Duration::from_secs(2));
    assert_eq!(health.flush_state, FlushState::Unavailable);
    assert_eq!(health.admitted, 3);
    assert_eq!(health.dropped, 3);
    assert_eq!(health.written, 0);
    assert_eq!(health.queue_depth, 0);
}

#[test]
fn saturation_drops_without_waiting_for_the_held_sink() {
    let limits = Limits {
        queue_capacity: 2,
        ..small_limits()
    };
    let (producer, mut guard, entered, release, records) = held_writer(limits);
    assert_eq!(
        producer.try_record(b"{\"n\":0}\n".to_vec()),
        EnqueueOutcome::Accepted
    );
    entered.recv_timeout(Duration::from_secs(2)).unwrap();
    for value in 1..=2 {
        assert_eq!(
            producer.try_record(format!("{{\"n\":{value}}}\n").into_bytes()),
            EnqueueOutcome::Accepted,
        );
    }
    let started = Instant::now();
    for _ in 0..1_000 {
        assert_eq!(
            producer.try_record(b"{}\n".to_vec()),
            EnqueueOutcome::DroppedFull
        );
    }
    println!(
        "diagnostics-saturation attempts=1000 queue_capacity=2 record_cap=32 elapsed_ns={}",
        started.elapsed().as_nanos()
    );
    let health = producer.health();
    assert_eq!(health.queue_depth, 2);
    assert_eq!(health.queue_high_water, 2);
    assert_eq!(health.dropped_full, 1_000);
    assert!(records.lock().unwrap().is_empty(), "sink is still held");
    release.try_send(()).unwrap();
    let health = guard.shutdown(Duration::from_secs(2));
    assert_eq!(health.flush_state, FlushState::Complete);
    assert_eq!(health.written, 3);
    assert_eq!(health.dropped, 1_000);
    assert_eq!(records.lock().unwrap().len(), 3);
}

#[test]
fn record_admission_bounds_bytes_and_does_not_retain_spare_vec_capacity() {
    let limits = Limits {
        queue_capacity: 1,
        ..small_limits()
    };
    let (producer, mut guard, entered, release, records) = held_writer(limits);
    assert_eq!(
        producer.try_record(b"{}\n".to_vec()),
        EnqueueOutcome::Accepted
    );
    entered.recv_timeout(Duration::from_secs(2)).unwrap();
    let mut oversized_capacity = Vec::with_capacity(1024 * 1024);
    oversized_capacity.extend_from_slice("{\"message\":\"界🙂\"}\n".as_bytes());
    assert!(oversized_capacity.capacity() > limits.max_record_bytes);
    // The production channel's Box<[u8]> representation retains exactly the
    // admitted byte count, regardless of the caller's former Vec capacity.
    assert_eq!(
        producer.try_record(oversized_capacity),
        EnqueueOutcome::Accepted
    );
    assert_eq!(
        producer.try_record(vec![b'x'; limits.max_record_bytes + 1]),
        EnqueueOutcome::DroppedOversized,
    );
    assert_eq!(producer.health().queue_depth, 1);
    release.try_send(()).unwrap();
    let health = guard.shutdown(Duration::from_secs(2));
    assert_eq!(health.written, 2);
    assert_eq!(health.dropped_oversized, 1);
    let records = records.lock().unwrap();
    assert_eq!(records[1], "{\"message\":\"界🙂\"}\n".as_bytes());
    assert!(
        records
            .iter()
            .all(|record| record.len() <= limits.max_record_bytes)
    );
}

#[test]
fn shutdown_deadline_does_not_join_a_blocked_writer_or_claim_late_success() {
    let limits = Limits {
        queue_capacity: 2,
        ..small_limits()
    };
    let (producer, mut guard, entered, release, _records) = held_writer(limits);
    assert_eq!(
        producer.try_record(b"{}\n".to_vec()),
        EnqueueOutcome::Accepted
    );
    entered.recv_timeout(Duration::from_secs(2)).unwrap();
    for _ in 0..2 {
        assert_eq!(
            producer.try_record(b"{}\n".to_vec()),
            EnqueueOutcome::Accepted
        );
    }
    let started = Instant::now();
    let health = guard.shutdown(Duration::from_millis(50));
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "shutdown waited for the held writer"
    );
    assert_eq!(health.flush_state, FlushState::TimedOut);
    assert_eq!(health.queue_depth, 2);
    assert_eq!(
        producer.try_record(b"{}\n".to_vec()),
        EnqueueOutcome::DroppedClosed
    );
    release.try_send(()).unwrap();
    wait_until(|| producer.health().queue_depth == 0 && producer.health().written == 1);
    let health = guard.shutdown(Duration::from_secs(2));
    assert_eq!(health.flush_state, FlushState::TimedOut);
    assert_eq!(health.dropped, 3);
    assert_eq!(health.written, 1);
}

#[test]
fn guard_drop_has_a_finite_fallback_and_leaves_health_available() {
    let (producer, guard, entered, release, _records) = held_writer(small_limits());
    assert_eq!(
        producer.try_record(b"{}\n".to_vec()),
        EnqueueOutcome::Accepted
    );
    entered.recv_timeout(Duration::from_secs(2)).unwrap();
    let started = Instant::now();
    drop(guard);
    assert!(started.elapsed() < Duration::from_secs(1));
    assert_eq!(producer.health().flush_state, FlushState::TimedOut);
    release.try_send(()).unwrap();
    wait_until(|| producer.health().written == 1);
    assert_eq!(producer.health().flush_state, FlushState::TimedOut);
}

#[test]
fn idle_flush_and_all_sink_work_run_on_the_worker_thread() {
    struct ThreadSink {
        calls: Arc<Mutex<Vec<thread::ThreadId>>>,
        flushes: Arc<AtomicUsize>,
    }
    impl DiagnosticSink for ThreadSink {
        fn initialize(&mut self) -> Result<(), SinkError> {
            self.calls.lock().unwrap().push(thread::current().id());
            Ok(())
        }
        fn write_record(&mut self, _record: &[u8]) -> Result<(), SinkError> {
            self.calls.lock().unwrap().push(thread::current().id());
            Ok(())
        }
        fn flush(&mut self) -> Result<(), SinkError> {
            self.calls.lock().unwrap().push(thread::current().id());
            self.flushes.fetch_add(1, Ordering::Relaxed);
            Ok(())
        }
    }
    let calls = Arc::new(Mutex::new(Vec::new()));
    let flushes = Arc::new(AtomicUsize::new(0));
    let (producer, mut guard) = RuntimeWriter::start_with_sink(
        Limits {
            idle_flush: Duration::from_millis(10),
            ..small_limits()
        },
        ThreadSink {
            calls: Arc::clone(&calls),
            flushes: Arc::clone(&flushes),
        },
    )
    .unwrap();
    assert_eq!(
        producer.try_record(b"{}\n".to_vec()),
        EnqueueOutcome::Accepted
    );
    wait_until(|| flushes.load(Ordering::Relaxed) >= 1);
    assert_eq!(
        guard.shutdown(Duration::from_secs(2)).flush_state,
        FlushState::Complete
    );
    let calls = calls.lock().unwrap();
    assert!(calls.len() >= 4);
    assert!(calls.iter().all(|id| *id != thread::current().id()));
}

#[test]
fn concurrent_producers_and_shutdown_account_for_every_submitted_record() {
    let (producer, mut guard) = RuntimeWriter::start_with_sink(
        Limits {
            queue_capacity: 8,
            ..small_limits()
        },
        NoopSink,
    )
    .unwrap();
    let threads = (0..8)
        .map(|_| {
            let producer = producer.clone();
            thread::spawn(move || {
                for _ in 0..1_000 {
                    let _ = producer.try_record(b"{}\n".to_vec());
                }
            })
        })
        .collect::<Vec<_>>();
    let _ = guard.shutdown(Duration::from_secs(2));
    for thread in threads {
        thread.join().unwrap();
    }
    let health = producer.health();
    assert_eq!(health.flush_state, FlushState::Complete);
    assert_eq!(health.written + health.dropped, 8_000);
    assert_eq!(health.admitted, health.written);
    assert_eq!(health.queue_depth, 0);
    assert!(health.queue_high_water <= 8);
}

#[test]
fn dropping_all_producers_allows_worker_completion_without_a_spin() {
    let (producer, mut guard) = RuntimeWriter::start_with_sink(small_limits(), NoopSink).unwrap();
    let shared = Arc::clone(&producer.shared);
    drop(producer);
    wait_until(|| shared.health.snapshot().flush_state == FlushState::Complete);
    assert_eq!(
        guard.shutdown(Duration::from_secs(2)).flush_state,
        FlushState::Complete
    );
}

#[test]
fn real_files_rotate_with_exact_retained_count_and_total_byte_cap() {
    let temporary = TemporaryDirectory::new();
    let limits = Limits {
        max_record_bytes: 16,
        max_file_bytes: 32,
        retained_files: DEFAULT_RETAINED_FILES,
        ..small_limits()
    };
    let (producer, mut guard) = RuntimeWriter::start(temporary.log(), limits).unwrap();
    for index in 0..25 {
        assert_eq!(
            producer.try_record(format!("{{\"event\":{index}}}\n").into_bytes()),
            EnqueueOutcome::Accepted,
        );
    }
    let health = guard.shutdown(Duration::from_secs(5));
    assert_eq!(health.flush_state, FlushState::Complete, "{health:?}");
    assert_eq!(health.written, 25);
    assert_eq!(health.dropped, 0);
    let mut total = 0;
    for index in 0..=limits.retained_files {
        let path = rotated_path(&temporary.log(), index);
        let contents = fs::read(&path).unwrap();
        assert!(contents.len() as u64 <= limits.max_file_bytes);
        assert_eq!(contents.last(), Some(&b'\n'));
        total += contents.len() as u64;
    }
    assert!(total <= (limits.retained_files as u64 + 1) * limits.max_file_bytes);
    assert!(!rotated_path(&temporary.log(), limits.retained_files + 1).exists());
    assert!(temporary.0.join(WRITER_LOCK_NAME).is_file());
}

#[test]
fn seven_day_retention_and_oversize_cleanup_touch_only_fixed_names() {
    let temporary = TemporaryDirectory::new();
    let expired = SystemTime::now() - Duration::from_secs(8 * 24 * 60 * 60);
    for path in [temporary.log(), rotated_path(&temporary.log(), 1)] {
        fs::write(&path, b"old diagnostic\n").unwrap();
        File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(expired)
            .unwrap();
    }
    let oversized = rotated_path(&temporary.log(), 2);
    fs::write(&oversized, vec![b'x'; 65]).unwrap();
    let unrelated = temporary.0.join("portcove-desktop.jsonl.private");
    let extra_generation = rotated_path(&temporary.log(), 6);
    fs::write(&unrelated, b"preserve unrelated file").unwrap();
    fs::write(&extra_generation, b"preserve unowned generation").unwrap();
    let (producer, mut guard) = RuntimeWriter::start(temporary.log(), small_limits()).unwrap();
    assert_eq!(
        producer.try_record(b"{}\n".to_vec()),
        EnqueueOutcome::Accepted
    );
    let health = guard.shutdown(Duration::from_secs(2));
    assert_eq!(health.flush_state, FlushState::Complete, "{health:?}");
    assert_eq!(fs::read(temporary.log()).unwrap(), b"{}\n");
    assert!(!rotated_path(&temporary.log(), 1).exists());
    assert!(!oversized.exists());
    assert_eq!(fs::read(unrelated).unwrap(), b"preserve unrelated file");
    assert_eq!(
        fs::read(extra_generation).unwrap(),
        b"preserve unowned generation"
    );
}

#[test]
fn existing_log_appends_after_a_clean_restart() {
    let temporary = TemporaryDirectory::new();
    for record in [b"{\"n\":1}\n".as_slice(), b"{\"n\":2}\n".as_slice()] {
        let (producer, mut guard) = RuntimeWriter::start(temporary.log(), small_limits()).unwrap();
        assert_eq!(
            producer.try_record(record.to_vec()),
            EnqueueOutcome::Accepted
        );
        assert_eq!(
            guard.shutdown(Duration::from_secs(2)).flush_state,
            FlushState::Complete
        );
    }
    assert_eq!(
        fs::read(temporary.log()).unwrap(),
        b"{\"n\":1}\n{\"n\":2}\n"
    );
}

#[cfg(windows)]
#[test]
fn ordinary_windows_paths_are_normalized_on_the_worker() {
    let temporary = TemporaryDirectory::new();
    let ordinary = std::env::temp_dir()
        .join(temporary.0.file_name().unwrap())
        .join(LOG_FILE_NAME);
    assert!(ordinary.is_absolute());
    let (producer, mut guard) = RuntimeWriter::start(ordinary, small_limits()).unwrap();
    assert_eq!(
        producer.try_record(b"{}\n".to_vec()),
        EnqueueOutcome::Accepted
    );
    let health = guard.shutdown(Duration::from_secs(2));
    assert_eq!(health.flush_state, FlushState::Complete, "{health:?}");
    assert_eq!(fs::read(temporary.log()).unwrap(), b"{}\n");
}

#[test]
fn concurrent_writers_never_share_rotation_authority_and_lease_is_not_deleted() {
    let temporary = TemporaryDirectory::new();
    let (first, mut first_guard) = RuntimeWriter::start(temporary.log(), small_limits()).unwrap();
    assert_eq!(
        first.try_record(b"{\"n\":1}\n".to_vec()),
        EnqueueOutcome::Accepted
    );
    wait_until(|| first.health().written == 1);
    let (second, mut second_guard) = RuntimeWriter::start(temporary.log(), small_limits()).unwrap();
    wait_until(|| second.health().flush_state == FlushState::Unavailable);
    assert_eq!(
        second.try_record(b"{\"n\":2}\n".to_vec()),
        EnqueueOutcome::DroppedClosed
    );
    let health = second_guard.shutdown(Duration::from_secs(2));
    assert_eq!(health.lease_errors, 1);
    assert_eq!(health.written, 0);
    assert_eq!(
        first_guard.shutdown(Duration::from_secs(2)).flush_state,
        FlushState::Complete
    );
    assert!(temporary.0.join(WRITER_LOCK_NAME).is_file());
    let (third, mut third_guard) = RuntimeWriter::start(temporary.log(), small_limits()).unwrap();
    assert_eq!(
        third.try_record(b"{\"n\":3}\n".to_vec()),
        EnqueueOutcome::Accepted
    );
    assert_eq!(
        third_guard.shutdown(Duration::from_secs(2)).flush_state,
        FlushState::Complete
    );
    assert_eq!(
        fs::read(temporary.log()).unwrap(),
        b"{\"n\":1}\n{\"n\":3}\n"
    );
}

const LEASE_CHILD_DIRECTORY: &str = "PORTCOVE_TEST_DIAGNOSTICS_LEASE_DIRECTORY";
const LEASE_CHILD_EXPECTED: &str = "PORTCOVE_TEST_DIAGNOSTICS_LEASE_EXPECTED";
const LEASE_CHILD_CHALLENGE: &str = "PORTCOVE_TEST_DIAGNOSTICS_LEASE_CHALLENGE";

#[test]
fn writer_lease_child_process() {
    let Some(directory) = std::env::var_os(LEASE_CHILD_DIRECTORY) else {
        // The parent below invokes exactly this test with its owned challenge.
        return;
    };
    let expected = std::env::var(LEASE_CHILD_EXPECTED).unwrap();
    let challenge = std::env::var(LEASE_CHILD_CHALLENGE).unwrap();
    assert!(challenge.len() <= 100);
    assert!(
        challenge
            .bytes()
            .all(|byte| byte.is_ascii_digit() || byte == b'-')
    );
    let (producer, mut guard) =
        RuntimeWriter::start(PathBuf::from(directory).join(LOG_FILE_NAME), small_limits()).unwrap();
    match expected.as_str() {
        "unavailable" => {
            wait_until(|| producer.health().flush_state == FlushState::Unavailable);
            assert_eq!(
                producer.try_record(b"{}\n".to_vec()),
                EnqueueOutcome::DroppedClosed
            );
            let health = guard.shutdown(Duration::from_secs(2));
            assert_eq!(health.lease_errors, 1);
            assert_eq!(health.written, 0);
            assert_eq!(health.flush_state, FlushState::Unavailable);
        }
        "complete" => {
            assert_eq!(
                producer.try_record(b"{\"child\":true}\n".to_vec()),
                EnqueueOutcome::Accepted
            );
            let health = guard.shutdown(Duration::from_secs(2));
            assert_eq!(health.flush_state, FlushState::Complete, "{health:?}");
            assert_eq!(health.lease_errors, 0);
            assert_eq!(health.written, 1);
        }
        _ => panic!("unknown owned lease-fixture expectation"),
    }
    println!("portcove-diagnostics-lease/{challenge}/{expected}");
}

struct OwnedLeaseChild(std::process::Child);

impl OwnedLeaseChild {
    fn stop_and_reap(&mut self) -> io::Result<std::process::ExitStatus> {
        if let Some(status) = self.0.try_wait()? {
            return Ok(status);
        }
        let _ = self.0.kill();
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if let Some(status) = self.0.try_wait()? {
                return Ok(status);
            }
            if Instant::now() >= deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "lease fixture child did not reap after kill",
                ));
            }
            thread::sleep(Duration::from_millis(1));
        }
    }
}

impl Drop for OwnedLeaseChild {
    fn drop(&mut self) {
        let _ = self.stop_and_reap();
    }
}

fn capture_child_output(stream: impl io::Read + Send + 'static) -> JoinHandle<io::Result<Vec<u8>>> {
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let mut bounded = stream.take(64 * 1024 + 1);
        io::Read::read_to_end(&mut bounded, &mut bytes)?;
        if bytes.len() > 64 * 1024 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "lease fixture output exceeded its bound",
            ));
        }
        Ok(bytes)
    })
}

fn collected_child_output(reader: JoinHandle<io::Result<Vec<u8>>>) -> Vec<u8> {
    let deadline = Instant::now() + Duration::from_secs(2);
    while !reader.is_finished() {
        assert!(
            Instant::now() < deadline,
            "lease fixture output drain exceeded its deadline"
        );
        thread::sleep(Duration::from_millis(1));
    }
    // This join is only performed after completion, never on a blocked pipe.
    reader.join().unwrap().unwrap()
}

fn run_lease_child(directory: &Path, expected: &str) {
    let challenge = format!(
        "{}-{}-{}",
        std::process::id(),
        NEXT_TEMPORARY.fetch_add(1, Ordering::Relaxed),
        SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
    );
    let module = module_path!().split_once("::").unwrap().1;
    let child_test = format!("{module}::writer_lease_child_process");
    // Direct launch is limited to this exact current test binary and exact child
    // test, in the reviewed test-only child-process spelling allowlist.
    let mut child = OwnedLeaseChild(
        std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", &child_test, "--nocapture"])
            .env(LEASE_CHILD_DIRECTORY, directory)
            .env(LEASE_CHILD_EXPECTED, expected)
            .env(LEASE_CHILD_CHALLENGE, &challenge)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let stdout = capture_child_output(child.0.stdout.take().unwrap());
    let stderr = capture_child_output(child.0.stderr.take().unwrap());
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut timed_out = false;
    let status = loop {
        if let Some(status) = child.0.try_wait().unwrap() {
            break status;
        }
        if Instant::now() >= deadline {
            timed_out = true;
            break child.stop_and_reap().unwrap();
        }
        thread::sleep(Duration::from_millis(1));
    };
    let stdout = String::from_utf8(collected_child_output(stdout)).unwrap();
    let stderr = String::from_utf8(collected_child_output(stderr)).unwrap();
    assert!(
        !timed_out,
        "lease fixture child exceeded its deadline: {stdout}\n{stderr}"
    );
    assert!(status.success(), "lease fixture failed: {stdout}\n{stderr}");
    let response = format!("portcove-diagnostics-lease/{challenge}/{expected}");
    assert_eq!(
        stdout.matches(&response).count(),
        1,
        "child did not return its exact challenge: {stdout}"
    );
    println!("diagnostics-cross-process-lease verified={expected} challenge={challenge}");
}

#[test]
fn independent_processes_observe_exclusion_then_release_of_the_writer_lease() {
    let temporary = TemporaryDirectory::new();
    let (producer, mut guard) = RuntimeWriter::start(temporary.log(), small_limits()).unwrap();
    assert_eq!(
        producer.try_record(b"{\"parent\":true}\n".to_vec()),
        EnqueueOutcome::Accepted
    );
    // A successful append proves this parent actually owns the real file lease
    // before the child is launched; process creation alone is not readiness.
    wait_until(|| producer.health().written == 1);
    run_lease_child(&temporary.0, "unavailable");
    assert_eq!(
        guard.shutdown(Duration::from_secs(2)).flush_state,
        FlushState::Complete
    );
    run_lease_child(&temporary.0, "complete");
    assert_eq!(
        fs::read(temporary.log()).unwrap(),
        b"{\"parent\":true}\n{\"child\":true}\n"
    );
    assert!(temporary.0.join(WRITER_LOCK_NAME).is_file());
}

#[test]
fn unsafe_log_or_lease_hardlinks_preserve_foreign_bytes() {
    for name in [LOG_FILE_NAME, WRITER_LOCK_NAME, "portcove-desktop.jsonl.2"] {
        let temporary = TemporaryDirectory::new();
        let foreign = temporary.0.join("foreign-data");
        fs::write(&foreign, b"never modify foreign bytes").unwrap();
        fs::hard_link(&foreign, temporary.0.join(name)).unwrap();
        let (producer, mut guard) = RuntimeWriter::start(temporary.log(), small_limits()).unwrap();
        let _ = producer.try_record(b"{}\n".to_vec());
        let health = guard.shutdown(Duration::from_secs(2));
        assert_eq!(
            health.flush_state,
            FlushState::Unavailable,
            "{name}: {health:?}"
        );
        assert!(health.permission_errors >= 1);
        assert_eq!(health.written, 0);
        assert_eq!(fs::read(foreign).unwrap(), b"never modify foreign bytes");
    }
}

#[test]
fn a_replaced_rotation_leaf_stops_rotation_without_growing_the_active_file() {
    let temporary = TemporaryDirectory::new();
    let limits = Limits {
        max_record_bytes: 8,
        max_file_bytes: 8,
        ..small_limits()
    };
    let (producer, mut guard) = RuntimeWriter::start(temporary.log(), limits).unwrap();
    assert_eq!(
        producer.try_record(b"{\"n\":1}\n".to_vec()),
        EnqueueOutcome::Accepted
    );
    wait_until(|| producer.health().written == 1);
    let obstructed = rotated_path(&temporary.log(), 1);
    fs::create_dir(&obstructed).unwrap();
    fs::write(obstructed.join("foreign"), b"preserve directory content").unwrap();
    assert_eq!(
        producer.try_record(b"{\"n\":2}\n".to_vec()),
        EnqueueOutcome::Accepted
    );
    let health = guard.shutdown(Duration::from_secs(2));
    assert_eq!(health.flush_state, FlushState::Failed);
    assert_eq!(health.rotation_errors, 1);
    assert_eq!(health.dropped, 1);
    assert_eq!(fs::read(temporary.log()).unwrap(), b"{\"n\":1}\n");
    assert_eq!(
        fs::read(obstructed.join("foreign")).unwrap(),
        b"preserve directory content"
    );
}

#[test]
fn partial_write_failure_cannot_make_later_records_exceed_the_segment_cap() {
    struct PartialSink {
        inner: FileSink,
        fail_next: bool,
    }
    impl DiagnosticSink for PartialSink {
        fn initialize(&mut self) -> Result<(), SinkError> {
            self.inner.initialize()
        }
        fn write_record(&mut self, record: &[u8]) -> Result<(), SinkError> {
            if self.fail_next {
                self.fail_next = false;
                self.inner.write_record(&record[..4])?;
                return Err(SinkError {
                    stage: FailureStage::Write,
                    kind: io::ErrorKind::StorageFull,
                });
            }
            self.inner.write_record(record)
        }
        fn flush(&mut self) -> Result<(), SinkError> {
            self.inner.flush()
        }
    }
    let temporary = TemporaryDirectory::new();
    let limits = Limits {
        max_record_bytes: 8,
        max_file_bytes: 8,
        ..small_limits()
    };
    let (producer, mut guard) = RuntimeWriter::start_with_sink(
        limits,
        PartialSink {
            inner: FileSink::new(temporary.log(), limits),
            fail_next: true,
        },
    )
    .unwrap();
    for record in [b"{\"n\":1}\n", b"{\"n\":2}\n"] {
        assert_eq!(
            producer.try_record(record.to_vec()),
            EnqueueOutcome::Accepted
        );
    }
    let health = guard.shutdown(Duration::from_secs(2));
    assert_eq!(health.flush_state, FlushState::Failed);
    assert_eq!(health.write_errors, 1);
    assert_eq!(health.disk_full_errors, 1);
    assert_eq!(health.dropped, 1);
    assert_eq!(health.written, 1);
    assert_eq!(fs::read(temporary.log()).unwrap(), b"{\"n\":2}\n");
    assert_eq!(
        fs::read(rotated_path(&temporary.log(), 1)).unwrap(),
        b"{\"n\""
    );
    assert!(fs::metadata(temporary.log()).unwrap().len() <= limits.max_file_bytes);
    assert!(
        fs::metadata(rotated_path(&temporary.log(), 1))
            .unwrap()
            .len()
            <= limits.max_file_bytes
    );
}

#[cfg(unix)]
#[test]
fn symlink_leaf_and_ancestor_are_rejected_without_writing_their_targets() {
    use std::os::unix::fs::symlink;
    let temporary = TemporaryDirectory::new();
    let target = temporary.0.join("foreign");
    fs::write(&target, b"preserve foreign bytes").unwrap();
    symlink(&target, temporary.log()).unwrap();
    let (producer, mut guard) = RuntimeWriter::start(temporary.log(), small_limits()).unwrap();
    let _ = producer.try_record(b"{}\n".to_vec());
    assert_eq!(
        guard.shutdown(Duration::from_secs(2)).flush_state,
        FlushState::Unavailable
    );
    assert_eq!(fs::read(&target).unwrap(), b"preserve foreign bytes");
    let alias = temporary.0.join("alias");
    let foreign_directory = temporary.0.join("foreign-directory");
    fs::create_dir(&foreign_directory).unwrap();
    symlink(&foreign_directory, &alias).unwrap();
    let (producer, mut guard) =
        RuntimeWriter::start(alias.join(LOG_FILE_NAME), small_limits()).unwrap();
    let _ = producer.try_record(b"{}\n".to_vec());
    assert_eq!(
        guard.shutdown(Duration::from_secs(2)).flush_state,
        FlushState::Unavailable
    );
    assert!(!foreign_directory.join(LOG_FILE_NAME).exists());
    assert!(!foreign_directory.join(WRITER_LOCK_NAME).exists());
}

// Linux accepts arbitrary non-NUL filename bytes. Default macOS filesystems
// reject this fixture before the writer starts; every host exercises Unicode
// parent preservation in the adjacent test instead.
#[cfg(target_os = "linux")]
#[test]
fn rotation_preserves_non_unicode_parent_paths() {
    use std::os::unix::ffi::OsStringExt;
    let temporary = TemporaryDirectory::new();
    let directory = temporary.0.join(OsString::from_vec(b"logs-\xff".to_vec()));
    fs::create_dir(&directory).unwrap();
    assert_rotation_preserves_parent(directory);
}

#[test]
fn rotation_preserves_unicode_parent_paths() {
    let temporary = TemporaryDirectory::new();
    let directory = temporary.0.join("logs-雪-é");
    fs::create_dir(&directory).unwrap();
    assert_rotation_preserves_parent(directory);
}

fn assert_rotation_preserves_parent(directory: PathBuf) {
    let path = directory.join(LOG_FILE_NAME);
    let limits = Limits {
        max_record_bytes: 8,
        max_file_bytes: 8,
        ..small_limits()
    };
    let (producer, mut guard) = RuntimeWriter::start(path.clone(), limits).unwrap();
    for record in [b"{\"n\":1}\n", b"{\"n\":2}\n"] {
        assert_eq!(
            producer.try_record(record.to_vec()),
            EnqueueOutcome::Accepted
        );
    }
    assert_eq!(
        guard.shutdown(Duration::from_secs(2)).flush_state,
        FlushState::Complete
    );
    assert_eq!(fs::read(&path).unwrap(), b"{\"n\":2}\n");
    assert_eq!(fs::read(rotated_path(&path, 1)).unwrap(), b"{\"n\":1}\n");
}

#[test]
fn admission_counters_remain_available_when_logging_is_disabled() {
    let producer = Producer::disabled(io::ErrorKind::PermissionDenied);
    producer.note_truncated(3);
    producer.note_opaque_omitted(2);
    producer.note_dropped();
    assert_eq!(
        producer.try_record(b"{}\n".to_vec()),
        EnqueueOutcome::DroppedClosed
    );
    let health = producer.health();
    assert_eq!(health.flush_state, FlushState::Unavailable);
    assert_eq!(health.open_errors, 1);
    assert_eq!(health.permission_errors, 1);
    assert_eq!(health.truncated_fields, 3);
    assert_eq!(health.opaque_fields, 2);
    assert_eq!(health.dropped_formatting, 1);
    assert_eq!(health.dropped_closed, 1);
    assert_eq!(health.dropped, 2);
}

#[test]
fn invalid_capacities_cannot_expand_the_production_policy() {
    for limits in [
        Limits {
            queue_capacity: 0,
            ..Limits::default()
        },
        Limits {
            queue_capacity: DEFAULT_QUEUE_CAPACITY + 1,
            ..Limits::default()
        },
        Limits {
            max_record_bytes: DEFAULT_MAX_RECORD_BYTES + 1,
            ..Limits::default()
        },
        Limits {
            max_file_bytes: 1,
            ..Limits::default()
        },
        Limits {
            retained_files: DEFAULT_RETAINED_FILES + 1,
            ..Limits::default()
        },
        Limits {
            max_age: Duration::ZERO,
            ..Limits::default()
        },
    ] {
        assert!(RuntimeWriter::start_with_sink(limits, NoopSink).is_err());
    }
}
