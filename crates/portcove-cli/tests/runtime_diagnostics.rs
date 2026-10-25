//! The shared production writer and tracing layer, exercised without Tauri.
//! CLI subprocesses retain their normal output and host diagnostics boundaries.

use portcove_diagnostics::{events as diagnostics_events, writer as diagnostics_writer};
#[path = "../../../apps/desktop/src-tauri/src/frontend_diagnostics.rs"]
mod frontend_diagnostics;

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
        "max_target_bytes": diagnostics_events::MAX_TARGET_BYTES,
        "max_stored_spans": diagnostics_events::MAX_STORED_SPANS,
        "max_projected_spans": portcove_core::runtime_diagnostics::MAX_SPANS,
        "max_span_fields": portcove_core::runtime_diagnostics::MAX_SPAN_FIELDS,
        "max_span_bytes": portcove_core::runtime_diagnostics::MAX_SPAN_BYTES,
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

/// Returns a previously admitted, exact owned package. No network, catalog
/// override, invented manifest, or fabricated successful activity is involved.
struct OwnedRelease(portcove_core::InstallRecord);

#[async_trait::async_trait]
impl portcove_core::ReleaseProvider for OwnedRelease {
    async fn resolve(
        &self,
        port: &portcove_core::PortDefinition,
        channel: portcove_core::ReleaseChannel,
        _platform: portcove_core::Platform,
    ) -> portcove_core::Result<portcove_core::ResolvedRelease> {
        assert_eq!(port.id, self.0.port_id);
        assert_eq!(channel, self.0.channel);
        Ok(portcove_core::ResolvedRelease {
            version: self.0.version.clone(),
            channel,
            published_at: None,
            asset: portcove_core::ReleaseAsset {
                name: self.0.artifact.asset_name.clone(),
                url: "https://example.invalid/owned-retained-package.zip".into(),
                size: self.0.artifact.size,
                sha256: self.0.artifact.sha256.clone(),
            },
        })
    }
}

fn owned_lifecycle_helper(directory: &Path) -> PathBuf {
    let executable = directory.join(if cfg!(windows) {
        "owned-host-helper.exe"
    } else {
        "owned-host-helper"
    });
    if let Some(prepared) = std::env::var_os("PORTCOVE_HOST_TOOL_FIXTURE") {
        fs::copy(prepared, &executable).unwrap();
    } else {
        let source = directory.join("owned-host-helper.rs");
        fs::write(
            &source,
            include_str!("../../portcove-core/src/testdata/host_tool_probe.rs.txt"),
        )
        .unwrap();
        let compiled =
            ChildProcessPolicy::native_command(ChildProcessClass::ManagedBuilder, "rustc")
                .unwrap()
                .arg("--edition=2024")
                .arg(source)
                .arg("-o")
                .arg(&executable)
                .output()
                .unwrap();
        assert!(
            compiled.status.success(),
            "owned helper compilation failed: {}",
            String::from_utf8_lossy(&compiled.stderr)
        );
    }
    executable
}

fn adopt_owned_package(
    service: &PortcoveService,
    helper: &Path,
    directory: &Path,
    port_id: &str,
    identity: &str,
) -> portcove_core::InstallRecord {
    let platform = portcove_core::Platform::current().unwrap();
    let port = service.catalog().port(port_id).unwrap();
    fs::create_dir(directory).unwrap();
    for relative in port.executable_hints[&platform].iter().chain(
        port.setup_executable_hints
            .get(&platform)
            .into_iter()
            .flatten(),
    ) {
        let destination = directory.join(relative);
        fs::create_dir_all(destination.parent().unwrap()).unwrap();
        fs::copy(helper, destination).unwrap();
    }
    fs::write(directory.join("owned-package-identity"), identity).unwrap();
    if port_id == "opengoal-jak1" {
        fs::write(directory.join("owned-setup-mode"), "success").unwrap();
    }
    let preview = service.preview_adoption(directory, Some(port_id)).unwrap();
    let authorization = service
        .authorize_adoption(directory, Some(port_id), &preview.plan_sha256)
        .unwrap();
    service
        .adopt(directory, Some(port_id), &authorization.token)
        .unwrap()
}

fn activity_from_events(
    library: &Library,
    events: &[portcove_core::OperationEvent],
    operation: portcove_core::ActivityOperation,
) -> portcove_core::ActivityRecord {
    let started = events
        .iter()
        .find(|event| {
            event.operation == operation.to_string()
                && event.parent_operation_id.is_none()
                && matches!(event.event, portcove_core::OperationEventKind::Started)
        })
        .expect("production operation must emit its actual start");
    let activity = library
        .activities(100)
        .unwrap()
        .into_iter()
        .find(|activity| activity.id == started.operation_id)
        .expect("event identity must name the existing durable activity");
    assert_eq!(activity.operation, operation);
    assert_eq!(activity.status, portcove_core::ActivityStatus::Succeeded);
    assert!(activity.finished_at.is_some());
    assert!(events.iter().any(|event| {
        event.operation_id == activity.id
            && matches!(
                event.event,
                portcove_core::OperationEventKind::Finished {
                    result: portcove_core::OperationResult::Succeeded
                }
            )
    }));
    activity
}

fn correlated_records<'a>(records: &'a [Value], operation_id: &str) -> Vec<&'a Value> {
    records
        .iter()
        .filter(|record| record["fields"]["operation_id"] == operation_id)
        .collect()
}

#[test]
fn runtime_diagnostics_correlates_real_install_update_prepare_and_launch() {
    const PORT: &str = "opengoal-jak1";
    let started = std::time::Instant::now();
    let phase = |name: &str| {
        eprintln!(
            "runtime-diagnostics-lifecycle phase={name} elapsed_ms={}",
            started.elapsed().as_millis()
        );
    };
    phase("fixture-begin");
    let temporary = tempfile::tempdir().unwrap();
    let helper = owned_lifecycle_helper(temporary.path());
    let helper_bytes = fs::read(&helper).unwrap();
    let library = Library::open(temporary.path().join("owned-library")).unwrap();
    let service = PortcoveService::new(library.clone()).unwrap();
    let package_a = temporary.path().join("owned-package-a");
    let package_b = temporary.path().join("owned-package-b");
    let first = adopt_owned_package(&service, &helper, &package_a, PORT, "package-a");
    let second = adopt_owned_package(&service, &helper, &package_b, PORT, "package-b");
    assert_ne!(first.artifact.sha256, second.artifact.sha256);
    let source = temporary.path().join("owned.iso");
    fs::write(&source, b"owned source awaiting upstream validation").unwrap();
    let profile = service
        .catalog()
        .port(PORT)
        .unwrap()
        .source_profile
        .as_deref()
        .unwrap();
    service.register_source(profile, &source).unwrap();
    let failing_port = "zelda64-recomp";
    let failed_install = adopt_owned_package(
        &service,
        &helper,
        &temporary.path().join("owned-failing-game"),
        failing_port,
        "nonzero-game",
    );
    drop(service);
    phase("fixture-end");

    let log_path = fs::canonicalize(temporary.path())
        .unwrap()
        .join(diagnostics_writer::LOG_FILE_NAME);
    let (producer, mut guard) = RuntimeWriter::start(log_path.clone(), Limits::default()).unwrap();
    let subscriber = tracing_subscriber::registry().with(DiagnosticLayer::new(producer));
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let (operations, prepared, launch, failed_launch) =
        tracing::subscriber::with_default(subscriber, || {
            runtime.block_on(async {
                let install_service = PortcoveService::with_provider(
                    library.clone(),
                    Arc::new(OwnedRelease(first.clone())),
                )
                .unwrap();
                // Adoption legitimately activates B. The generic install route
                // can reuse A; the game workspace's first-install action is
                // intentionally unavailable while an installation is active.
                phase("install-begin");
                let plan = install_service.plan_install(PORT, None).await.unwrap();
                assert_eq!(plan.action, portcove_core::InstallPlanAction::ReuseRetained);
                let mut install_events = Vec::new();
                let installed = install_service
                    .install(PORT, None, None, None, true, |event| {
                        install_events.push(event)
                    })
                    .await
                    .unwrap();
                assert_eq!(installed.id, first.id);
                let install_activity = activity_from_events(
                    &library,
                    &install_events,
                    portcove_core::ActivityOperation::Install,
                );
                drop(install_service);
                phase("install-end");

                let service = PortcoveService::with_provider(
                    library.clone(),
                    Arc::new(OwnedRelease(second.clone())),
                )
                .unwrap();
                phase("update-begin");
                let review = service.plan_game_update(PORT, true).await.unwrap();
                assert_eq!(
                    review.plan.action,
                    portcove_core::InstallPlanAction::ReuseRetained
                );
                let grant = service
                    .authorize_game_update(PORT, true, &review.plan_sha256)
                    .await
                    .unwrap();
                let mut update_events = Vec::new();
                let updated = service
                    .apply_game_update(PORT, true, &grant.token, |event| update_events.push(event))
                    .await
                    .unwrap();
                assert_eq!(updated.id, second.id);
                let update_activity = activity_from_events(
                    &library,
                    &update_events,
                    portcove_core::ActivityOperation::Update,
                );
                let status = service.status(PORT).unwrap();
                assert_eq!(status.active.unwrap().id, second.id);
                assert_eq!(status.previous.unwrap().id, first.id);
                phase("update-end");

                let options = portcove_core::PreparationOptions {
                    target: portcove_core::Platform::current().unwrap(),
                    mode: portcove_core::PreparationMode::Default,
                };
                phase("preparation-begin");
                let review = service.plan_preparation(PORT, options).unwrap();
                let grant = service
                    .authorize_preparation(PORT, options, &review.plan_sha256)
                    .unwrap();
                let mut preparation_events = Vec::new();
                let prepared = service
                    .prepare(PORT, options, &grant.token, |event| {
                        preparation_events.push(event)
                    })
                    .unwrap();
                let preparation_activity = activity_from_events(
                    &library,
                    &preparation_events,
                    portcove_core::ActivityOperation::Prepare,
                );
                assert_eq!(prepared.id, preparation_activity.id);
                let captures = library
                    .activity_diagnostic(&preparation_activity.id)
                    .unwrap();
                assert_eq!(captures.len(), 1);
                assert_eq!(captures[0].activity_id, preparation_activity.id);
                assert_eq!(captures[0].phase, "preparation.setup");
                assert!(captures[0].complete);
                assert!(captures[0].stdout.text.contains("owned setup began"));
                assert!(
                    !captures[0]
                        .stdout
                        .text
                        .contains("owned-fixture-private-value")
                );
                let exported_capture = serde_json::to_value(
                    portcove_core::SupportBundleData::activity_captures(&captures),
                )
                .unwrap();
                assert_eq!(exported_capture[0]["activity_id"], preparation_activity.id);
                assert_eq!(exported_capture[0]["complete"], true);
                assert!(
                    !exported_capture
                        .to_string()
                        .contains("owned-fixture-private-value")
                );

                phase("preparation-end");
                phase("launch-begin");
                let request = uuid::Uuid::new_v4().to_string();
                let launched = service
                    .supervise_launch_identified(
                        portcove_core::IdentifiedLaunchRequest {
                            request_id: &request,
                            port_id: PORT,
                            source_override: None,
                            arguments: &[],
                            stdio: portcove_core::LaunchStdio::Null,
                        },
                        |session| assert_eq!(session.id, request),
                        |_| {},
                    )
                    .unwrap();
                assert!(launched.successful);
                assert_eq!(launched.exit_code, Some(0));
                let launch = library.launch_request(&request).unwrap().unwrap();
                assert_eq!(launch.id, request);
                assert_eq!(launch.install_id, prepared.id);
                assert_eq!(
                    launch.outcome,
                    Some(portcove_core::LaunchSessionOutcome::Succeeded)
                );

                let request = uuid::Uuid::new_v4().to_string();
                let failed = service
                    .supervise_launch_identified(
                        portcove_core::IdentifiedLaunchRequest {
                            request_id: &request,
                            port_id: failing_port,
                            source_override: None,
                            arguments: &["--nonzero".into()],
                            stdio: portcove_core::LaunchStdio::Null,
                        },
                        |session| assert_eq!(session.id, request),
                        |_| {},
                    )
                    .unwrap();
                assert!(
                    !failed.successful,
                    "Ok supervision must not imply a successful child exit"
                );
                assert_eq!(failed.exit_code, Some(7));
                let failed_launch = library.launch_request(&request).unwrap().unwrap();
                assert_eq!(failed_launch.install_id, failed_install.id);
                assert_eq!(
                    failed_launch.outcome,
                    Some(portcove_core::LaunchSessionOutcome::Failed)
                );
                assert!(library.launch_sessions().unwrap().is_empty());
                phase("launch-end");
                (
                    vec![install_activity, update_activity, preparation_activity],
                    prepared,
                    launch,
                    failed_launch,
                )
            })
        });
    phase("flush-begin");
    let health = guard.shutdown(FLUSH_DEADLINE);
    phase("flush-end");
    assert_eq!(health.flush_state, FlushState::Complete);
    assert_eq!(health.dropped, 0, "{health:?}");
    let raw = fs::read_to_string(log_path).unwrap();
    assert!(!raw.contains("owned-fixture-private-value"));
    assert!(!raw.contains(&source.to_string_lossy().to_string()));
    let records = raw
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    let exported = raw
        .lines()
        .map(|line| {
            serde_json::to_value(portcove_core::SupportBundleData::runtime_log_line(line)).unwrap()
        })
        .collect::<Vec<_>>();
    assert!(
        !serde_json::to_string(&exported)
            .unwrap()
            .contains("owned-fixture-private-value")
    );
    for activity in &operations {
        let observed = correlated_records(&records, &activity.id);
        assert!(!observed.is_empty());
        for phase in ["started", "finished"] {
            assert_eq!(
                observed
                    .iter()
                    .filter(|record| record["fields"]["observation"] == "event"
                        && record["fields"]["phase"] == phase)
                    .count(),
                1,
                "duplicate or absent {phase}: {observed:?}"
            );
        }
        let terminal = observed
            .iter()
            .find(|record| record["fields"]["observation"] == "activity")
            .unwrap();
        assert_eq!(terminal["fields"]["activity_id"], activity.id);
        assert_eq!(terminal["fields"]["observed_result"], "succeeded");
        assert_eq!(terminal["fields"]["activity_recorded"], true);
        let elapsed = observed
            .iter()
            .filter_map(|record| record["fields"]["elapsed_ms"].as_u64())
            .collect::<Vec<_>>();
        assert!(elapsed.len() >= 2 && elapsed.windows(2).all(|pair| pair[0] <= pair[1]));
        let export = correlated_records(&exported, &activity.id);
        assert_eq!(export.len(), observed.len());
        assert!(
            export
                .iter()
                .any(|record| record["fields"]["activity_recorded"] == true)
        );
        let expected_release = match activity.operation {
            portcove_core::ActivityOperation::Install => &first.version,
            portcove_core::ActivityOperation::Update
            | portcove_core::ActivityOperation::Prepare => &second.version,
            _ => panic!("unexpected fixture operation"),
        };
        for projected in [&observed, &export] {
            let resolved: Vec<_> = projected
                .iter()
                .filter(|record| record["fields"]["phase"] == "resolved")
                .collect();
            assert_eq!(resolved.len(), 1);
            assert_eq!(resolved[0]["fields"]["release"], *expected_release);
            if activity.operation == portcove_core::ActivityOperation::Prepare {
                assert_eq!(resolved[0]["fields"]["install_id"], second.id);
            } else {
                assert!(
                    resolved[0]["fields"].get("install_id").is_none(),
                    "an unresolved install identity must remain absent"
                );
            }
        }
    }
    let preparation = correlated_records(&records, &prepared.id);
    for phase in ["preparation.extract", "preparation.setup"] {
        assert_eq!(
            preparation
                .iter()
                .filter(|record| record["fields"]["observation"] == "event"
                    && record["fields"]["phase"] == phase)
                .count(),
            1,
            "real preparation must retain its {phase} boundary"
        );
    }
    let captures = library.activity_diagnostic(&prepared.id).unwrap();
    let capture = &captures[0];
    for projected in [&records, &exported] {
        let capture_records = projected
            .iter()
            .filter(|record| {
                record["fields"]["observation"] == "capture"
                    && record["fields"]["activity_id"] == prepared.id
            })
            .collect::<Vec<_>>();
        assert_eq!(capture_records.len(), 1);
        let fields = &capture_records[0]["fields"];
        assert_eq!(fields["phase"], capture.phase);
        assert_eq!(fields["capture_recorded"], true);
        assert_eq!(fields["stream_complete"], capture.complete);
        assert_eq!(fields["stdout_bytes"], capture.stdout.observed_bytes);
        assert_eq!(fields["stderr_bytes"], capture.stderr.observed_bytes);
        assert_eq!(
            fields["truncated"],
            capture.stdout.truncated || capture.stderr.truncated
        );
    }
    for (launch, expected) in [(&launch, "succeeded"), (&failed_launch, "failed")] {
        let observed = correlated_records(&records, &launch.id);
        let terminal = observed
            .iter()
            .filter(|record| {
                record["fields"]["observation"] == "launch_session"
                    && record["fields"]["phase"] == "finished"
            })
            .collect::<Vec<_>>();
        assert_eq!(terminal.len(), 1);
        assert_eq!(terminal[0]["fields"]["observed_result"], expected);
        assert_eq!(terminal[0]["fields"]["activity_id"], launch.id);
        assert_eq!(terminal[0]["fields"]["activity_recorded"], true);
        assert_eq!(
            terminal[0]["fields"]["exit_code"],
            launch.exit_code.unwrap()
        );
        assert!(
            observed
                .iter()
                .all(|record| record["fields"].get("stream_complete").is_none())
        );
        let activity = library
            .activities(100)
            .unwrap()
            .into_iter()
            .find(|activity| activity.id == launch.id)
            .unwrap();
        assert_eq!(serde_json::to_value(activity.status).unwrap(), expected);
        assert!(library.activity_diagnostic(&launch.id).unwrap().is_empty());
        assert_eq!(
            correlated_records(&exported, &launch.id).len(),
            observed.len()
        );
        let expected_install = if expected == "succeeded" {
            &prepared
        } else {
            &failed_install
        };
        for projected in [&records, &exported] {
            let resolved: Vec<_> = projected
                .iter()
                .filter(|record| {
                    record["fields"]["operation_id"] == launch.id
                        && record["fields"]["phase"] == "resolved"
                })
                .collect();
            assert_eq!(resolved.len(), 1);
            assert_eq!(resolved[0]["fields"]["release"], expected_install.version);
            assert_eq!(resolved[0]["fields"]["install_id"], expected_install.id);
        }
    }
    assert_eq!(
        fs::read(&source).unwrap(),
        b"owned source awaiting upstream validation"
    );
    assert_eq!(
        fs::read(package_a.join("owned-package-identity")).unwrap(),
        b"package-a"
    );
    assert_eq!(
        fs::read(package_b.join("owned-package-identity")).unwrap(),
        b"package-b"
    );
    let platform = portcove_core::Platform::current().unwrap();
    let catalog = portcove_core::Catalog::embedded().unwrap();
    let port = catalog.port(PORT).unwrap();
    for package in [&package_a, &package_b] {
        for relative in port.executable_hints[&platform].iter().chain(
            port.setup_executable_hints
                .get(&platform)
                .into_iter()
                .flatten(),
        ) {
            assert_eq!(fs::read(package.join(relative)).unwrap(), helper_bytes);
        }
    }
    let reopened = PortcoveService::new(Library::open(library.root()).unwrap()).unwrap();
    assert_eq!(
        reopened.status(PORT).unwrap().active.unwrap().id,
        prepared.id
    );
    assert_eq!(
        reopened
            .library()
            .launch_request(&launch.id)
            .unwrap()
            .unwrap(),
        launch
    );
    evidence(
        "typed-lifecycle-correlation",
        json!({
            "operations": operations.iter().map(|activity| json!({"id": activity.id, "operation": activity.operation, "status": activity.status})).collect::<Vec<_>>(),
            "prepared_install_id": prepared.id,
            "launch": {"id": launch.id, "outcome": launch.outcome, "exit_code": launch.exit_code},
            "nonzero_launch": {"id": failed_launch.id, "outcome": failed_launch.outcome, "exit_code": failed_launch.exit_code},
            "runtime_records": records.len(), "exported_runtime_records": exported.len(),
            "resolved_observations": records.iter().filter(|record| record["fields"]["phase"] == "resolved").map(|record| &record["fields"]).collect::<Vec<_>>(),
            "health": health_json(&health), "source_bytes_preserved": true,
            "scope": "Owned native helper, real planned retained-install and reviewed update/setup with supervised launch; no game compatibility or download qualification",
        }),
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
            assert!(line.len() < limits.max_record_bytes);
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
            .map(|line| {
                // The retained baseline wrote primitive strings. Compare their
                // supported export meaning with the new typed envelope without
                // changing the measured historical producer implementation.
                serde_json::to_value(portcove_core::SupportBundleData::runtime_log_line(line))
                    .unwrap()["fields"]
                    .clone()
            })
            .collect::<Vec<_>>()
    };
    assert_eq!(fields(&baseline_path), fields(&candidate_path));
    evidence(
        "latency-comparison",
        json!({
            "baseline_revision": BASELINE_REVISION,
            "baseline_scope": "Exact prior small-event path; real per-event sync_data; rotation not triggered",
            "candidate_scope": "Exact production Desktop event layer and background file writer",
            "field_comparison": "Equivalent support-export values; historical numeric strings become typed numbers",
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
