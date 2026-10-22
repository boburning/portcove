//! The exact Desktop writer and tracing layer, exercised without Tauri or a
//! second CLI logging implementation. CLI subprocesses retain their normal logger.

#[path = "../../../apps/desktop/src-tauri/src/diagnostics_events.rs"]
mod diagnostics_events;
#[path = "../../../apps/desktop/src-tauri/src/diagnostics_writer.rs"]
mod diagnostics_writer;

use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use diagnostics_events::DiagnosticLayer;
use diagnostics_writer::{
    DiagnosticSink, FailureStage, FlushState, HealthSnapshot, Limits, Producer, RuntimeWriter,
    SinkError,
};
use portcove_core::{
    ChildProcessClass, ChildProcessPolicy, Library, PortcoveService, UpdatePolicy,
};
use serde_json::{Value, json};
use tracing::{
    Event, Subscriber,
    field::{Field, Visit},
};
use tracing_subscriber::{Layer, layer::SubscriberExt};

const BASELINE_REVISION: &str = "14a83f61d2c7231a5d9378a9f808aa83ff61b81f";
const FLUSH_DEADLINE: Duration = Duration::from_secs(2);

fn cli_binary() -> PathBuf {
    std::env::var_os("NEXTEST_BIN_EXE_portcove")
        .map(PathBuf::from)
        .unwrap_or_else(|| env!("CARGO_BIN_EXE_portcove").into())
}

fn evidence(name: &str, result: Value) {
    let envelope = json!({
        "format_version": 1,
        "source_revision": std::env::var("PORTCOVE_DIAGNOSTICS_SOURCE_REVISION").ok(),
        "platform": std::env::consts::OS,
        "architecture": std::env::consts::ARCH,
        "crate_version": env!("CARGO_PKG_VERSION"),
        "scope": "Owned synthetic runtime diagnostics; no native UI or crash durability claim",
        "result": result,
    });
    println!("runtime-diagnostics-evidence {name}: {envelope}");
    if let Some(directory) = std::env::var_os("PORTCOVE_DIAGNOSTICS_EVIDENCE_DIR") {
        let directory = PathBuf::from(directory);
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            directory.join(format!("{name}.json")),
            serde_json::to_vec_pretty(&envelope).unwrap(),
        )
        .unwrap();
    }
}

fn health_json(health: &HealthSnapshot) -> Value {
    json!({
        "admitted": health.admitted,
        "written": health.written,
        "dropped": health.dropped,
        "dropped_full": health.dropped_full,
        "dropped_closed": health.dropped_closed,
        "dropped_formatting": health.dropped_formatting,
        "dropped_oversized": health.dropped_oversized,
        "truncated_fields": health.truncated_fields,
        "opaque_fields": health.opaque_fields,
        "open_errors": health.open_errors,
        "write_errors": health.write_errors,
        "rotation_errors": health.rotation_errors,
        "retention_errors": health.retention_errors,
        "lease_errors": health.lease_errors,
        "flush_errors": health.flush_errors,
        "permission_errors": health.permission_errors,
        "disk_full_errors": health.disk_full_errors,
        "queue_depth": health.queue_depth,
        "queue_high_water": health.queue_high_water,
        "flush_state": format!("{:?}", health.flush_state),
    })
}

fn limits_json(limits: &Limits) -> Value {
    json!({
        "queue_capacity": limits.queue_capacity,
        "max_record_bytes": limits.max_record_bytes,
        "max_file_bytes": limits.max_file_bytes,
        "retained_files": limits.retained_files,
        "max_age_seconds": limits.max_age.as_secs(),
        "idle_flush_ms": limits.idle_flush.as_millis(),
        "normal_shutdown_deadline_ms": FLUSH_DEADLINE.as_millis(),
        "max_fields": diagnostics_events::MAX_FIELDS,
        "max_field_bytes": diagnostics_events::MAX_FIELD_BYTES,
        "max_value_bytes": diagnostics_events::MAX_VALUE_BYTES,
        "max_formatting_producers": diagnostics_events::MAX_FORMATTING_PRODUCERS,
    })
}

#[derive(Clone, Copy)]
enum InjectedFailure {
    Permission,
    DiskFull,
    Rotation,
}

impl DiagnosticSink for InjectedFailure {
    fn write_record(&mut self, _record: &[u8]) -> Result<(), SinkError> {
        let (stage, kind) = match self {
            Self::Permission => (FailureStage::Write, io::ErrorKind::PermissionDenied),
            Self::DiskFull => (FailureStage::Write, io::ErrorKind::StorageFull),
            Self::Rotation => (FailureStage::Rotation, io::ErrorKind::PermissionDenied),
        };
        Err(SinkError { stage, kind })
    }

    fn flush(&mut self) -> Result<(), SinkError> {
        Ok(())
    }
}

fn retained_state(database: &rusqlite::Connection) -> Value {
    let activity: (String, Option<String>, Option<String>, Option<i64>) = database.query_row(
        "SELECT status,cancellation_phase,cancellation_owner,finished_at FROM activity_history WHERE id='logger-recovery-control'",
        [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    ).unwrap();
    let recovery: (String, String, Option<String>) = database.query_row(
        "SELECT kind,phase,last_error FROM lifecycle_operations WHERE id='logger-recovery-control'",
        [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).unwrap();
    let activity_count: u64 = database
        .query_row("SELECT count(*) FROM activity_history", [], |row| {
            row.get(0)
        })
        .unwrap();
    let capture: String = database
        .query_row(
            "SELECT payload FROM activity_diagnostics WHERE activity_id='logger-recovery-control'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    json!({"activity": activity, "recovery": recovery, "activity_count": activity_count, "capture": capture})
}

fn commit_and_read_through_cli(
    service: &PortcoveService,
    producer: Producer,
    policy: UpdatePolicy,
) -> Value {
    let subscriber = tracing_subscriber::registry().with(DiagnosticLayer::new(producer));
    // This production method commits SQLite preferences and then emits its own
    // status-model tracing event. No fixture fabricates a successful operation.
    let committed = tracing::subscriber::with_default(subscriber, || {
        service.set_update_policy("lighthouse", policy)
    })
    .expect("best-effort logging cannot fail the committed Core operation");
    assert_eq!(committed.update_policy, policy);
    let committed = serde_json::to_value(committed).unwrap();
    let mut results = Vec::new();
    for mode in ["--json", "--jsonl"] {
        let output =
            ChildProcessPolicy::native_command(ChildProcessClass::HostIntegration, cli_binary())
                .expect("owned CLI fixture satisfies the maintained child policy")
                .arg("--library")
                .arg(service.library().root())
                .args([mode, "status", "lighthouse"])
                .env_remove("RUST_LOG")
                .output()
                .expect("actual CLI should start");
        assert_eq!(output.status.code(), Some(0), "{output:?}");
        assert!(output.stderr.is_empty(), "{output:?}");
        let stdout = String::from_utf8(output.stdout).unwrap();
        let records = stdout
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            records.len(),
            1,
            "logging must not contaminate machine stdout"
        );
        let record = &records[0];
        assert_eq!(record["schema_version"], portcove_core::API_SCHEMA_VERSION);
        assert_eq!(record["ok"], true);
        assert_eq!(record["command"], "status");
        assert_eq!(record["data"], committed);
        if mode == "--jsonl" {
            assert_eq!(record["type"], "result");
        } else {
            assert!(record["error"].is_null());
        }
        results.push(json!({"mode": mode, "exit_code": 0, "stdout": record, "stderr_bytes": 0}));
    }
    json!(results)
}

#[test]
fn runtime_diagnostics_failures_preserve_committed_core_and_cli_results() {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("owned library")).unwrap();
    let service = PortcoveService::new(library).unwrap();
    let database =
        rusqlite::Connection::open(service.library().root().join("portcove.sqlite3")).unwrap();
    // These sentinels distinguish runtime logging from activity/capture durability
    // and an already-pending recovery; status must observe them without recovery.
    database.execute(
        "INSERT INTO activity_history(id,operation,target_kind,target_id,status,started_at,cancellation_phase,cancellation_owner) VALUES('logger-recovery-control','prepare','port','owned-recovery-port','running',1,'preparing','owned-interrupted-worker')",
        [],
    ).unwrap();
    database.execute(
        "INSERT INTO lifecycle_operations(id,kind,port_id,phase,created_at,updated_at) VALUES('logger-recovery-control','prepare','owned-recovery-port','preparing',1,1)",
        [],
    ).unwrap();
    let capture = serde_json::to_string(&portcove_core::ActivityDiagnostic {
        activity_id: "logger-recovery-control".into(),
        phase: "preparation.setup".into(),
        stdout: portcove_core::DiagnosticStream {
            text: "retained owned capture".into(),
            observed_bytes: 21,
            truncated: false,
        },
        stderr: portcove_core::DiagnosticStream {
            text: String::new(),
            observed_bytes: 0,
            truncated: false,
        },
        complete: true,
        updated_at: 1,
        stream_limit_bytes: 2 * 1024 * 1024,
    })
    .unwrap();
    database.execute(
        "INSERT INTO activity_diagnostics(activity_id,phase,payload,updated_at,payload_bytes) VALUES('logger-recovery-control','preparation.setup',?1,1,?2)",
        rusqlite::params![capture, capture.len()],
    ).unwrap();
    let before = retained_state(&database);
    let saved = service.library().root().join("owned-save-sentinel");
    fs::write(&saved, b"preserve saved bytes").unwrap();
    let mut cases = Vec::new();
    for (name, fault, policy) in [
        (
            "permission-denied",
            InjectedFailure::Permission,
            UpdatePolicy::Automatic,
        ),
        (
            "disk-full-write",
            InjectedFailure::DiskFull,
            UpdatePolicy::Stage,
        ),
        (
            "rotation-denied",
            InjectedFailure::Rotation,
            UpdatePolicy::Notify,
        ),
    ] {
        let (producer, mut guard) =
            RuntimeWriter::start_with_sink(Limits::default(), fault).unwrap();
        let result = commit_and_read_through_cli(&service, producer, policy);
        let health = guard.shutdown(FLUSH_DEADLINE);
        assert!(
            health.admitted > 0,
            "production Core tracing did not reach the writer"
        );
        assert_eq!(health.written, 0);
        match fault {
            InjectedFailure::Permission => {
                assert!(health.write_errors > 0 && health.permission_errors > 0)
            }
            InjectedFailure::DiskFull => {
                assert!(health.write_errors > 0 && health.disk_full_errors > 0)
            }
            InjectedFailure::Rotation => {
                assert!(health.rotation_errors > 0 && health.permission_errors > 0)
            }
        }
        assert_eq!(retained_state(&database), before);
        assert_eq!(fs::read(&saved).unwrap(), b"preserve saved bytes");
        cases.push(json!({"failure": name, "health": health_json(&health), "cli_results": result}));
    }

    let destination = fs::canonicalize(temporary.path())
        .unwrap()
        .join(diagnostics_writer::LOG_FILE_NAME);
    fs::create_dir(&destination).unwrap();
    fs::write(destination.join("preserve"), b"foreign directory contents").unwrap();
    let (producer, mut guard) =
        RuntimeWriter::start(destination.clone(), Limits::default()).unwrap();
    let result = commit_and_read_through_cli(&service, producer, UpdatePolicy::Automatic);
    let health = guard.shutdown(FLUSH_DEADLINE);
    assert!(
        health.open_errors + health.retention_errors > 0,
        "real non-file log destination was not refused: {health:?}"
    );
    assert_eq!(health.written, 0);
    assert_eq!(retained_state(&database), before);
    assert_eq!(
        fs::read(destination.join("preserve")).unwrap(),
        b"foreign directory contents"
    );
    cases.push(json!({"failure": "real non-file destination", "health": health_json(&health), "cli_results": result}));
    evidence(
        "core-cli-failure-isolation",
        json!({"cases": cases, "activity_recovery_and_capture_unchanged": true, "limits": limits_json(&Limits::default())}),
    );
}

struct MustNotFormat;

impl std::fmt::Debug for MustNotFormat {
    fn fmt(&self, _formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        panic!("opaque formatter must never execute on the producer");
    }
}

#[test]
fn runtime_diagnostics_redacts_bounded_message_span_and_error_inputs() {
    let temporary = tempfile::tempdir().unwrap();
    let path = fs::canonicalize(temporary.path())
        .unwrap()
        .join(diagnostics_writer::LOG_FILE_NAME);
    let limits = Limits::default();
    let (producer, mut guard) = RuntimeWriter::start(path.clone(), limits).unwrap();
    let subscriber = tracing_subscriber::registry().with(DiagnosticLayer::new(producer));
    let oversized = format!("{} token=oversized-canary", "界".repeat(1_024));
    let failure = portcove_core::PortcoveError::state("password=error-canary");
    tracing::subscriber::with_default(subscriber, || {
        let span = tracing::info_span!("owned", private_path = "span-canary");
        let _entered = span.enter();
        tracing::info!(message = "safe token=message-canary public=visible", password = "field-canary", error = ?failure, opaque = ?MustNotFormat);
        tracing::info!(
            message = oversized.as_str(),
            event_name = "oversized multibyte field"
        );
        tracing::info!(
            a = 1,
            b = 2,
            c = 3,
            d = 4,
            e = 5,
            f = 6,
            g = 7,
            h = 8,
            i = 9,
            j = 10,
            k = 11,
            l = 12,
            m = 13,
            n = 14,
            o = 15,
            p = 16,
            q = 17
        );
    });
    let health = guard.shutdown(FLUSH_DEADLINE);
    assert_eq!(health.flush_state, FlushState::Complete);
    assert!(
        health.truncated_fields > 0 && health.opaque_fields >= 2 && health.dropped_formatting > 0
    );
    let bytes = fs::read(&path).unwrap();
    let text = std::str::from_utf8(&bytes).unwrap();
    assert!(text.contains("public=visible"));
    for canary in [
        "message-canary",
        "field-canary",
        "error-canary",
        "span-canary",
        "oversized-canary",
    ] {
        assert!(!text.contains(canary), "persisted privacy canary {canary}");
    }
    let records = text
        .lines()
        .map(|line| {
            assert!(line.len() + 1 <= limits.max_record_bytes);
            serde_json::from_str::<Value>(line).unwrap()
        })
        .collect::<Vec<_>>();
    assert_eq!(records.len(), 2);
    evidence(
        "bounded-event-privacy",
        json!({"health": health_json(&health), "records": records, "retained_bytes": bytes.len(), "limits": limits_json(&limits)}),
    );
}

#[derive(Default)]
struct BaselineWork {
    metadata_calls: AtomicU64,
    open_calls: AtomicU64,
    write_calls: AtomicU64,
    sync_data_calls: AtomicU64,
}

struct SynchronousBaseline {
    path: PathBuf,
    lock: Mutex<()>,
    work: Arc<BaselineWork>,
}

// Bounded reference copied from diagnostics.rs::append/on_event/FieldVisitor at
// BASELINE_REVISION. Events deliberately stay below the old 4MiB rotation bound;
// every recorded baseline event still performs the real metadata/open/write/sync.
impl<S: Subscriber> Layer<S> for SynchronousBaseline {
    fn on_event(&self, event: &Event<'_>, _context: tracing_subscriber::layer::Context<'_, S>) {
        let mut visitor = BaselineVisitor::default();
        event.record(&mut visitor);
        let metadata = event.metadata();
        let entry = json!({
            "timestamp_ms": SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis(),
            "level": metadata.level().to_string(),
            "target": metadata.target(),
            "fields": visitor.fields,
        });
        let _guard = self.lock.lock().unwrap();
        let mut entry = entry.clone();
        portcove_core::redact_diagnostic_value(&mut entry);
        let mut line = serde_json::to_string(&entry).unwrap();
        line.push('\n');
        self.work.metadata_calls.fetch_add(1, Ordering::Relaxed);
        assert!(!self.path.metadata().is_ok_and(|metadata| {
            metadata.len().saturating_add(line.len() as u64) > 4 * 1024 * 1024
        }));
        self.work.open_calls.fetch_add(1, Ordering::Relaxed);
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .unwrap();
        self.work.write_calls.fetch_add(1, Ordering::Relaxed);
        file.write_all(line.as_bytes()).unwrap();
        self.work.sync_data_calls.fetch_add(1, Ordering::Relaxed);
        file.sync_data().unwrap();
    }
}

#[derive(Default)]
struct BaselineVisitor {
    fields: BTreeMap<String, Value>,
}

impl Visit for BaselineVisitor {
    fn record_str(&mut self, field: &Field, value: &str) {
        self.record(field, value.to_owned());
    }

    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        self.record(field, format!("{value:?}"));
    }
}

impl BaselineVisitor {
    fn record(&mut self, field: &Field, value: String) {
        let value = if portcove_core::sensitive_diagnostic_field(field.name()) {
            "[REDACTED]".to_owned()
        } else {
            portcove_core::redact_diagnostic_text(&value)
        };
        self.fields
            .insert(field.name().to_owned(), Value::String(value));
    }
}

fn measure_events(subscriber: impl Subscriber + Send + Sync + 'static, count: u64) -> Vec<u128> {
    tracing::subscriber::with_default(subscriber, || {
        (0..count)
            .map(|sequence| {
                let started = Instant::now();
                tracing::info!(
                    sequence,
                    phase = "complete",
                    message = "Synthetic runtime observation"
                );
                started.elapsed().as_nanos()
            })
            .collect()
    })
}

fn latency_summary(mut samples: Vec<u128>) -> Value {
    samples.sort_unstable();
    json!({
        "samples": samples.len(),
        "total_ns": samples.iter().sum::<u128>(),
        "p50_ns": samples[samples.len() / 2],
        "p95_ns": samples[(samples.len() * 95 / 100).min(samples.len() - 1)],
        "max_ns": samples.last().unwrap(),
    })
}

#[test]
fn runtime_diagnostics_measures_producer_work_against_synchronous_baseline() {
    const EVENTS: u64 = 64;
    let temporary = tempfile::tempdir().unwrap();
    let baseline_path = temporary.path().join("baseline.jsonl");
    let work = Arc::new(BaselineWork::default());
    let baseline = measure_events(
        tracing_subscriber::registry().with(SynchronousBaseline {
            path: baseline_path.clone(),
            lock: Mutex::new(()),
            work: Arc::clone(&work),
        }),
        EVENTS,
    );
    let candidate_path = fs::canonicalize(temporary.path())
        .unwrap()
        .join(diagnostics_writer::LOG_FILE_NAME);
    let limits = Limits::default();
    let (producer, mut guard) = RuntimeWriter::start(candidate_path.clone(), limits).unwrap();
    let candidate = measure_events(
        tracing_subscriber::registry().with(DiagnosticLayer::new(producer)),
        EVENTS,
    );
    let flush_started = Instant::now();
    let health = guard.shutdown(FLUSH_DEADLINE);
    let shutdown_ns = flush_started.elapsed().as_nanos();
    assert_eq!(health.flush_state, FlushState::Complete);
    assert_eq!(health.admitted, EVENTS);
    assert_eq!(health.written, EVENTS);
    assert_eq!(health.dropped, 0);
    for counter in [
        &work.metadata_calls,
        &work.open_calls,
        &work.write_calls,
        &work.sync_data_calls,
    ] {
        assert_eq!(counter.load(Ordering::Relaxed), EVENTS);
    }
    let fields = |path: &Path| {
        fs::read_to_string(path)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap()["fields"].clone())
            .collect::<Vec<_>>()
    };
    assert_eq!(fields(&baseline_path), fields(&candidate_path));
    evidence(
        "latency-comparison",
        json!({
            "baseline_revision": BASELINE_REVISION,
            "baseline_scope": "Exact prior small-event path; real per-event sync_data; rotation not triggered",
            "candidate_scope": "Exact production Desktop event layer and background file writer",
            "event_count": EVENTS,
            "baseline_producer_latency": latency_summary(baseline),
            "candidate_producer_latency": latency_summary(candidate),
            "candidate_shutdown_ns": shutdown_ns,
            "baseline_producer_work": {
                "metadata_calls": work.metadata_calls.load(Ordering::Relaxed),
                "open_calls": work.open_calls.load(Ordering::Relaxed),
                "write_calls": work.write_calls.load(Ordering::Relaxed),
                "sync_data_calls": work.sync_data_calls.load(Ordering::Relaxed),
            },
            "candidate_filesystem_owner": "background writer; producer only formats bounded fields and attempts bounded queue admission",
            "health": health_json(&health),
            "limits": limits_json(&limits),
            "interpretation": "Observed host samples, no absolute speed gate or causal claim about previous timeouts; abrupt exit may lose queued events",
        }),
    );
}
