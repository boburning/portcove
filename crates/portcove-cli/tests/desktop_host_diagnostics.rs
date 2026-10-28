//! Owned subprocess qualification of the exact Desktop startup constructors.
//! No Tauri/WebView, installed application, or real game is exercised here.

use std::{
    fs::{self, File, OpenOptions},
    path::{Path, PathBuf},
    process::{Child, Command, Output, Stdio},
    thread,
    time::{Duration, Instant},
};

use portcove_core::{ApplicationUpdateExclusivityGuard, ErrorCode, Library, PortcoveError};
use portcove_diagnostics::{
    HostDiagnostics, SESSION_MARKER, SLOT_NAMES, Surface,
    writer::{FlushState, LOG_FILE_NAME, WRITER_LOCK_NAME},
};
use serde_json::{Value, json};
use tracing_subscriber::{Layer, layer::SubscriberExt};

#[path = "../../../apps/desktop/src-tauri/src/host_startup.rs"]
mod host_startup;

const PROCESS_TIMEOUT: Duration = Duration::from_secs(30);
const HOLD_TIMEOUT: Duration = Duration::from_secs(20);

struct Fixture {
    temporary: tempfile::TempDir,
    preferences: PathBuf,
    logs: PathBuf,
    library: PathBuf,
    runtime: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let temporary = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(temporary.path()).unwrap();
        let host = root.join("private-host-canary");
        fs::create_dir(&host).unwrap();
        Self {
            preferences: host.join("preferences.json"),
            logs: host.join("diagnostics"),
            library: root.join("private-library-canary"),
            runtime: host.join("private-runtime-canary.lock"),
            temporary,
        }
    }

    fn configure(&self, command: &mut Command) {
        command
            .env("PORTCOVE_PREFERENCES", &self.preferences)
            .env("PORTCOVE_APPLICATION_RUNTIME_LOCK", &self.runtime)
            .env("PORTCOVE_LIBRARY", &self.library)
            .env_remove("PORTCOVE_DIAGNOSTICS_DEBUG")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .current_dir(self.temporary.path());
    }

    fn desktop(&self) -> Command {
        let mut command = Command::new(std::env::current_exe().unwrap());
        self.configure(&mut command);
        command
            .args([
                "--exact",
                "desktop_host_fixture_child",
                "--ignored",
                "--nocapture",
            ])
            .env("PORTCOVE_DESKTOP_HOST_FIXTURE", "1")
            .env("PORTCOVE_DESKTOP_HOST_ROOT", self.temporary.path())
            .env_remove("PORTCOVE_DESKTOP_HOST_LOG_ROOT")
            .env_remove("PORTCOVE_DESKTOP_HOST_HOLD")
            .env_remove("PORTCOVE_DESKTOP_HOST_SECOND_LIBRARY");
        command
    }

    fn cli(&self) -> Command {
        let binary = std::env::var_os("NEXTEST_BIN_EXE_portcove")
            .map(PathBuf::from)
            .unwrap_or_else(|| env!("CARGO_BIN_EXE_portcove").into());
        let mut command = Command::new(binary);
        self.configure(&mut command);
        command
    }

    fn summary(&self) -> Value {
        read_json(&self.temporary.path().join("desktop-result.json"))
    }

    fn records(&self, pid: u32) -> Vec<Value> {
        SLOT_NAMES
            .iter()
            .filter_map(|slot| fs::read_to_string(self.logs.join(slot).join(LOG_FILE_NAME)).ok())
            .flat_map(|contents| {
                contents
                    .lines()
                    .map(|line| serde_json::from_str::<Value>(line).unwrap())
                    .collect::<Vec<_>>()
            })
            .filter(|record| record["process_id"] == pid)
            .collect()
    }

    fn occupy_sessions(&self) -> Vec<File> {
        SLOT_NAMES
            .iter()
            .map(|slot| {
                let directory = self.logs.join(slot);
                fs::create_dir_all(&directory).unwrap();
                let lock = OpenOptions::new()
                    .read(true)
                    .write(true)
                    .create(true)
                    .truncate(false)
                    .open(directory.join(WRITER_LOCK_NAME))
                    .unwrap();
                lock.try_lock().unwrap();
                lock
            })
            .collect()
    }

    fn assert_private_inputs_absent(&self, records: &[Value], stderr: &[u8]) {
        let serialized = serde_json::to_string(records).unwrap();
        let stderr = String::from_utf8_lossy(stderr);
        for canary in [
            "private-host-canary",
            "private-runtime-canary",
            "private-library-canary",
            "private-preference-canary",
            "private-database-canary",
            self.temporary.path().to_str().unwrap(),
        ] {
            assert!(!serialized.contains(canary), "private input persisted");
            assert!(!stderr.contains(canary), "private input printed");
        }
    }
}

/// Every test owns and reaps its direct children, including assertion failures.
struct OwnedChild {
    child: Option<Child>,
    started: Instant,
}

impl OwnedChild {
    fn spawn(command: &mut Command) -> Self {
        Self {
            child: Some(command.spawn().expect("owned host fixture should start")),
            started: Instant::now(),
        }
    }

    fn id(&self) -> u32 {
        self.child.as_ref().unwrap().id()
    }

    fn wait_for_ready(&mut self, path: &Path) {
        while !path.exists() {
            assert!(
                self.child.as_mut().unwrap().try_wait().unwrap().is_none(),
                "Desktop fixture exited before publishing readiness"
            );
            assert!(
                self.started.elapsed() < PROCESS_TIMEOUT,
                "readiness timeout"
            );
            thread::sleep(Duration::from_millis(10));
        }
    }

    fn finish(mut self) -> Output {
        loop {
            if self.child.as_mut().unwrap().try_wait().unwrap().is_some() {
                // Fixtures emit only a fixed stderr line and the small libtest
                // preamble, so pipes cannot fill while the parent observes exit.
                return self.child.take().unwrap().wait_with_output().unwrap();
            }
            assert!(self.started.elapsed() < PROCESS_TIMEOUT, "process timeout");
            thread::sleep(Duration::from_millis(10));
        }
    }
}

impl Drop for OwnedChild {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn read_json(path: &Path) -> Value {
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}

fn publish_json(path: &Path, value: &Value) {
    let temporary = path.with_extension("temporary");
    fs::write(&temporary, serde_json::to_vec(value).unwrap()).unwrap();
    fs::rename(temporary, path).unwrap();
}

fn evidence(name: &str, result: Value) {
    let envelope = json!({
        "format_version": 1,
        "source_revision": std::env::var("PORTCOVE_DIAGNOSTICS_SOURCE_REVISION").ok(),
        "platform": std::env::consts::OS,
        "architecture": std::env::consts::ARCH,
        "crate_version": env!("CARGO_PKG_VERSION"),
        "scope": "Owned subprocesses invoking the production Desktop startup helpers and shared host logger; no Tauri or installed UI qualification",
        "result": result,
    });
    println!("host-diagnostics-evidence {name}: {envelope}");
    if let Some(directory) = std::env::var_os("PORTCOVE_DIAGNOSTICS_EVIDENCE_DIR") {
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            PathBuf::from(directory).join(format!("{name}.json")),
            serde_json::to_vec_pretty(&envelope).unwrap(),
        )
        .unwrap();
    }
}

#[test]
#[ignore = "invoked only as an owned child by the Desktop host qualification tests"]
fn desktop_host_fixture_child() {
    if std::env::var("PORTCOVE_DESKTOP_HOST_FIXTURE").as_deref() != Ok("1") {
        return;
    }
    let root = PathBuf::from(std::env::var_os("PORTCOVE_DESKTOP_HOST_ROOT").unwrap());
    let (host, mut guard) = match std::env::var_os("PORTCOVE_DESKTOP_HOST_LOG_ROOT") {
        // Isolate the invalid-preference-location constructor case from the
        // real user's fallback directory. All other cases use actual resolution.
        Some(directory) => {
            HostDiagnostics::start_in(&PathBuf::from(directory), Surface::Desktop, false)
        }
        None => HostDiagnostics::start(Surface::Desktop, portcove_diagnostics::debug_requested()),
    };
    let subscriber = tracing_subscriber::registry().with(host.layer().with_filter(host.filter()));
    tracing::subscriber::set_global_default(subscriber).unwrap();
    let session_before = host.session_id().to_owned();
    let slot_before = host
        .session_directory()
        .and_then(Path::file_name)
        .map(|name| name.to_string_lossy().into_owned());
    let outcome = desktop_startup(&root, &host);
    let success = outcome.is_ok();
    let mut summary = match outcome {
        Ok(libraries) => json!({"ok": true, "library_ids": libraries}),
        Err((phase, error)) => {
            eprintln!("{}", host_startup::failure_message(phase, error.code));
            json!({"ok": false, "error_code": error.code})
        }
    };
    summary["session_id_before"] = json!(session_before);
    summary["session_id_after"] = json!(host.session_id());
    summary["slot_before"] = json!(slot_before);
    summary["slot_after"] = json!(
        host.session_directory()
            .and_then(Path::file_name)
            .map(|name| name.to_string_lossy().into_owned())
    );
    summary["logging_enabled"] = json!(guard.is_some());
    summary["bootstrap_timed_out"] = json!(host.bootstrap_timed_out());
    let health = guard
        .as_mut()
        .map(|guard| guard.shutdown(Duration::from_secs(2)))
        .unwrap_or_else(|| host.health());
    summary["flush_complete"] = json!(health.flush_state == FlushState::Complete);
    summary["health"] = json!(format!("{health:?}"));
    summary["records_written"] = json!(health.written);
    publish_json(&root.join("desktop-result.json"), &summary);
    std::process::exit(if success { 0 } else { 1 });
}

fn desktop_startup(
    root: &Path,
    host: &HostDiagnostics,
) -> Result<Vec<String>, (host_startup::EarlyPhase, PortcoveError)> {
    use host_startup::EarlyPhase;
    let preferences =
        host_startup::preference_store().map_err(|error| (EarlyPhase::Preferences, error))?;
    let _runtime =
        host_startup::runtime_guard().map_err(|error| (EarlyPhase::RuntimeLease, error))?;
    let configured = std::env::var_os("PORTCOVE_LIBRARY")
        .filter(|path| !path.is_empty())
        .map(PathBuf::from);
    let selection = host_startup::select_library(&preferences, configured)
        .map_err(|error| (EarlyPhase::Library, error))?;
    let mut library =
        host_startup::open_library(&selection).map_err(|error| (EarlyPhase::Library, error))?;
    let mut libraries = vec![
        library
            .identity_record()
            .map_err(|error| (EarlyPhase::Library, error))?
            .id,
    ];
    if let Some(second) = std::env::var_os("PORTCOVE_DESKTOP_HOST_SECOND_LIBRARY") {
        preferences
            .set_library(&PathBuf::from(second))
            .map_err(|error| (EarlyPhase::Library, error))?;
        drop(library);
        let selection = host_startup::select_library(&preferences, None)
            .map_err(|error| (EarlyPhase::Library, error))?;
        library =
            host_startup::open_library(&selection).map_err(|error| (EarlyPhase::Library, error))?;
        libraries.push(
            library
                .identity_record()
                .map_err(|error| (EarlyPhase::Library, error))?
                .id,
        );
    }
    if std::env::var("PORTCOVE_DESKTOP_HOST_HOLD").as_deref() == Ok("1") {
        publish_json(
            &root.join("desktop-ready.json"),
            &json!({
                "session_id": host.session_id(),
                "slot": host.session_directory().unwrap().file_name().unwrap().to_string_lossy(),
            }),
        );
        let started = Instant::now();
        while !root.join("desktop-release").exists() {
            assert!(
                started.elapsed() < HOLD_TIMEOUT,
                "parent did not release Desktop fixture"
            );
            thread::sleep(Duration::from_millis(10));
        }
    }
    drop(library);
    Ok(libraries)
}

fn assert_failed_phase(records: &[Value], target: &str, phase: &str, code: ErrorCode) {
    assert!(
        records.iter().any(|record| {
            record["target"] == target
                && record["fields"]["phase"] == phase
                && record["fields"]["success"] == false
                && record["fields"]["code"] == portcove_diagnostics::code_label(code)
        }),
        "missing actual {target}/{phase}/{code:?} failure: {records:?}"
    );
}

#[test]
fn desktop_early_failures_keep_typed_phases_and_fixed_private_safe_stderr() {
    let mut observed = Vec::new();
    for (scenario, phase, core_phase, code) in [
        ("preference_location", "preferences", None, ErrorCode::Usage),
        (
            "preference_read",
            "library_selection",
            Some("preference_read"),
            ErrorCode::Verification,
        ),
        (
            "preference_decode",
            "library_selection",
            Some("preference_decode"),
            ErrorCode::State,
        ),
        ("runtime_lease", "runtime_lease", None, ErrorCode::Conflict),
        (
            "runtime_location",
            "runtime_lease",
            None,
            ErrorCode::Verification,
        ),
        ("library", "library_open", None, ErrorCode::State),
        (
            "database",
            "library_open",
            Some("database_open"),
            ErrorCode::State,
        ),
        (
            "future_schema",
            "library_open",
            Some("database_open"),
            ErrorCode::State,
        ),
        (
            "partial_migration",
            "library_open",
            Some("database_migration"),
            ErrorCode::State,
        ),
    ] {
        let fixture = Fixture::new();
        let mut command = fixture.desktop();
        let mut exclusive_runtime = None;
        match scenario {
            "preference_location" => {
                command
                    .env(
                        "PORTCOVE_PREFERENCES",
                        "private-preference-canary/preferences.json",
                    )
                    .env("PORTCOVE_DESKTOP_HOST_LOG_ROOT", &fixture.logs);
            }
            "preference_read" => {
                fs::create_dir(&fixture.preferences).unwrap();
                command.env_remove("PORTCOVE_LIBRARY");
            }
            "preference_decode" => {
                fs::write(&fixture.preferences, b"{token=private-preference-canary").unwrap();
                command.env_remove("PORTCOVE_LIBRARY");
            }
            "runtime_lease" => {
                exclusive_runtime =
                    Some(ApplicationUpdateExclusivityGuard::acquire(&fixture.runtime).unwrap());
            }
            "runtime_location" => fs::create_dir(&fixture.runtime).unwrap(),
            "library" => fs::write(&fixture.library, b"private-library-canary").unwrap(),
            "database" => {
                fs::create_dir(&fixture.library).unwrap();
                fs::write(
                    fixture.library.join("portcove.sqlite3"),
                    b"private-database-canary",
                )
                .unwrap();
            }
            "future_schema" | "partial_migration" => {
                fs::create_dir(&fixture.library).unwrap();
                let database =
                    rusqlite::Connection::open(fixture.library.join("portcove.sqlite3")).unwrap();
                database.execute_batch("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);").unwrap();
                database
                    .execute(
                        "INSERT INTO schema_migrations(version, applied_at) VALUES (?1, 0)",
                        [if scenario == "future_schema" {
                            999999
                        } else {
                            1
                        }],
                    )
                    .unwrap();
            }
            _ => unreachable!(),
        }
        let child = OwnedChild::spawn(&mut command);
        let pid = child.id();
        let output = child.finish();
        assert_eq!(output.status.code(), Some(1), "{scenario}: {output:?}");
        let message = match scenario {
            "preference_location" => {
                "Portcove could not open host preferences. Check the preference file setting, then try again."
            }
            "runtime_lease" => {
                "Portcove cannot start while an application update is replacing it. Let the update finish, then try again."
            }
            "runtime_location" => {
                "Portcove could not open its runtime lease. Check access to the application state location, then try again."
            }
            _ => "Portcove could not open its library. Check the selected library, then try again.",
        };
        assert_eq!(
            String::from_utf8_lossy(&output.stderr),
            format!("{message} [{code:?}]\n")
        );
        let summary = fixture.summary();
        assert_eq!(summary["ok"], false);
        assert_eq!(summary["error_code"], json!(code));
        assert_eq!(summary["flush_complete"], true, "{scenario}: {summary}");
        let records = fixture.records(pid);
        assert!(!records.is_empty());
        assert!(records.iter().all(|record| record["surface"] == "desktop"));
        assert_failed_phase(&records, "portcove_desktop::host_diagnostics", phase, code);
        if let Some(core_phase) = core_phase {
            assert_failed_phase(
                &records,
                "portcove_core::host_diagnostics",
                core_phase,
                code,
            );
        }
        fixture.assert_private_inputs_absent(&records, &output.stderr);
        observed.push(json!({"scenario": scenario, "desktop_phase": phase, "core_phase": core_phase, "code": code, "exit_code": 1, "records": records.len()}));
        drop(exclusive_runtime);
    }
    evidence(
        "host-desktop-startup-failures",
        json!({"cases": observed, "fixed_stderr": true, "private_canaries_absent": true}),
    );
}

#[test]
fn desktop_valid_startup_survives_all_logging_sessions_being_busy() {
    let fixture = Fixture::new();
    let leases = fixture.occupy_sessions();
    let child = OwnedChild::spawn(&mut fixture.desktop());
    let pid = child.id();
    let output = child.finish();
    assert!(output.status.success(), "{output:?}");
    assert!(output.stderr.is_empty());
    let summary = fixture.summary();
    assert_eq!(summary["ok"], true);
    assert_eq!(summary["logging_enabled"], false);
    assert_eq!(summary["records_written"], 0);
    assert!(fixture.records(pid).is_empty());
    let library = Library::open(&fixture.library).unwrap();
    assert_eq!(
        summary["library_ids"][0],
        library.identity_record().unwrap().id
    );
    assert!(
        SLOT_NAMES
            .iter()
            .all(|slot| !fixture.logs.join(slot).join(SESSION_MARKER).exists())
    );
    drop(leases);
    evidence(
        "host-desktop-unavailable-sink",
        json!({"startup_succeeded": true, "stderr_empty": true, "library_identity_retained": true, "occupied_sessions_untouched": true}),
    );
}

#[test]
fn simultaneous_desktop_and_cli_own_distinct_sessions_and_preserve_active_lease() {
    let fixture = Fixture::new();
    let mut desktop = OwnedChild::spawn(fixture.desktop().env("PORTCOVE_DESKTOP_HOST_HOLD", "1"));
    let desktop_pid = desktop.id();
    desktop.wait_for_ready(&fixture.temporary.path().join("desktop-ready.json"));
    let ready = read_json(&fixture.temporary.path().join("desktop-ready.json"));
    let slot = fixture.logs.join(ready["slot"].as_str().unwrap());
    let marker = fs::read(slot.join(SESSION_MARKER)).unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&marker).unwrap()["complete"],
        false
    );
    let probe = OpenOptions::new()
        .read(true)
        .write(true)
        .open(slot.join(WRITER_LOCK_NAME))
        .unwrap();
    assert!(
        probe.try_lock().is_err(),
        "Desktop lease must remain held while CLI starts"
    );
    let cli = OwnedChild::spawn(fixture.cli().args(["--json", "about"]));
    let cli_pid = cli.id();
    let cli_output = cli.finish();
    assert!(cli_output.status.success(), "{cli_output:?}");
    assert!(cli_output.stderr.is_empty());
    assert_eq!(
        serde_json::from_slice::<Value>(&cli_output.stdout).unwrap()["ok"],
        true
    );
    assert_eq!(fs::read(slot.join(SESSION_MARKER)).unwrap(), marker);
    assert!(
        probe.try_lock().is_err(),
        "CLI completion must not release Desktop's lease"
    );
    let cli_records = fixture.records(cli_pid);
    assert!(!cli_records.is_empty());
    let cli_session = cli_records[0]["session_id"].clone();
    assert_ne!(cli_session, ready["session_id"]);
    assert!(
        cli_records
            .iter()
            .all(|record| record["surface"] == "cli" && record["session_id"] == cli_session)
    );
    fs::write(fixture.temporary.path().join("desktop-release"), b"release").unwrap();
    let desktop_output = desktop.finish();
    assert!(desktop_output.status.success(), "{desktop_output:?}");
    assert!(desktop_output.stderr.is_empty());
    let desktop_records = fixture.records(desktop_pid);
    assert!(!desktop_records.is_empty());
    assert!(desktop_records.iter().all(
        |record| record["surface"] == "desktop" && record["session_id"] == ready["session_id"]
    ));
    assert_eq!(read_json(&slot.join(SESSION_MARKER))["complete"], true);
    probe
        .try_lock()
        .expect("completed Desktop must release its session lease");
    fixture.assert_private_inputs_absent(&desktop_records, &desktop_output.stderr);
    fixture.assert_private_inputs_absent(&cli_records, &cli_output.stderr);
    evidence(
        "host-desktop-cli-isolation",
        json!({"overlapping_processes": true, "distinct_sessions": true, "active_marker_preserved": true, "active_lease_preserved": true, "desktop_records": desktop_records.len(), "cli_records": cli_records.len()}),
    );
}

#[test]
fn desktop_saved_library_switch_preserves_host_session_and_location() {
    let fixture = Fixture::new();
    let second = fixture
        .library
        .with_file_name("second-private-library-canary");
    let second_id = Library::open(&second)
        .unwrap()
        .identity_record()
        .unwrap()
        .id;
    let child = OwnedChild::spawn(
        fixture
            .desktop()
            .env("PORTCOVE_DESKTOP_HOST_SECOND_LIBRARY", &second),
    );
    let pid = child.id();
    let output = child.finish();
    assert!(output.status.success(), "{output:?}");
    assert!(output.stderr.is_empty());
    let summary = fixture.summary();
    assert_eq!(summary["library_ids"].as_array().unwrap().len(), 2);
    assert_ne!(summary["library_ids"][0], summary["library_ids"][1]);
    assert_eq!(summary["library_ids"][1], second_id);
    assert_eq!(summary["session_id_before"], summary["session_id_after"]);
    assert_eq!(summary["slot_before"], summary["slot_after"]);
    assert_eq!(summary["flush_complete"], true);
    let saved = portcove_core::HostPreferenceStore::new(fixture.preferences.clone())
        .unwrap()
        .load()
        .unwrap();
    assert_eq!(
        saved.library_root.unwrap(),
        fs::canonicalize(&second).unwrap()
    );
    let records = fixture.records(pid);
    assert!(
        records
            .iter()
            .all(|record| record["session_id"] == summary["session_id_before"])
    );
    assert_eq!(
        records
            .iter()
            .filter(
                |record| record["target"] == "portcove_desktop::host_diagnostics"
                    && record["fields"]["phase"] == "library_open"
                    && record["fields"]["success"] == true
            )
            .count(),
        2
    );
    assert!(!fixture.library.join("diagnostics").exists());
    assert!(!second.join("diagnostics").exists());
    fixture.assert_private_inputs_absent(&records, &output.stderr);
    evidence(
        "host-desktop-library-switch",
        json!({"distinct_library_identities": true, "saved_selection_changed": true, "host_session_unchanged": true, "host_location_unchanged": true, "records": records.len()}),
    );
}
