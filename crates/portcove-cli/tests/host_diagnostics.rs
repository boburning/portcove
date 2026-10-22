//! Actual CLI subprocess coverage for the shared, best-effort host logger.
//! Owned synthetic files and executables; no installed-app or game qualification.

use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read},
    path::{Path, PathBuf},
    process::{Child, Command, Output, Stdio},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use portcove_diagnostics::{
    SLOT_NAMES,
    writer::{LOG_FILE_NAME, WRITER_LOCK_NAME},
};
use serde_json::{Value, json};

fn cli_binary() -> PathBuf {
    std::env::var_os("NEXTEST_BIN_EXE_portcove")
        .map(PathBuf::from)
        .unwrap_or_else(|| env!("CARGO_BIN_EXE_portcove").into())
}

struct Fixture {
    temporary: tempfile::TempDir,
    preferences: PathBuf,
    logs: PathBuf,
    library: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let host = root.join("host");
        fs::create_dir(&host).unwrap();
        Self {
            preferences: host.join("preferences.json"),
            logs: host.join("diagnostics"),
            library: root.join("library"),
            temporary,
        }
    }

    fn command(&self) -> Command {
        let mut command = Command::new(cli_binary());
        command
            .env("PORTCOVE_PREFERENCES", &self.preferences)
            .env(
                "PORTCOVE_APPLICATION_RUNTIME_LOCK",
                self.temporary.path().join("runtime.lock"),
            )
            .env_remove("PORTCOVE_LIBRARY")
            .env_remove("PORTCOVE_DIAGNOSTICS_DEBUG")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command
    }

    fn run(&self, arguments: &[&str]) -> (u32, Output) {
        run(self.command().args(arguments))
    }

    fn records(&self, pid: u32) -> Vec<Value> {
        let mut records = Vec::new();
        for slot in SLOT_NAMES {
            let path = self.logs.join(slot).join(LOG_FILE_NAME);
            let Ok(contents) = fs::read_to_string(path) else {
                continue;
            };
            for line in contents.lines() {
                let record: Value = serde_json::from_str(line).unwrap();
                if record["process_id"] == pid {
                    records.push(record);
                }
            }
        }
        records
    }

    fn occupy_all_sessions(&self) -> Vec<File> {
        SLOT_NAMES
            .iter()
            .map(|slot| {
                let directory = self.logs.join(slot);
                fs::create_dir_all(&directory).unwrap();
                let file = OpenOptions::new()
                    .read(true)
                    .write(true)
                    .create(true)
                    .truncate(false)
                    .open(directory.join(WRITER_LOCK_NAME))
                    .unwrap();
                file.try_lock().unwrap();
                file
            })
            .collect()
    }
}

type Capture = JoinHandle<io::Result<Vec<u8>>>;

/// Retain process ownership before starting capture threads so any assertion or
/// thread-start failure still kills and reaps the exact child we spawned.
struct OwnedChild {
    child: Child,
    stdout: Option<Capture>,
    stderr: Option<Capture>,
}

impl Drop for OwnedChild {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        for capture in [&mut self.stdout, &mut self.stderr] {
            if let Some(capture) = capture.take()
                && capture.is_finished()
            {
                let _ = capture.join();
            }
        }
        // A descendant retaining a pipe cannot turn timeout cleanup into an
        // unbounded join. Remaining readers finish when their pipe reaches EOF.
    }
}

fn capture(mut stream: impl Read + Send + 'static, name: &str) -> Capture {
    thread::Builder::new()
        .name(name.to_owned())
        .spawn(move || {
            let mut bytes = Vec::new();
            stream.read_to_end(&mut bytes)?;
            Ok(bytes)
        })
        .expect("owned CLI capture thread should start")
}

fn run(command: &mut Command) -> (u32, Output) {
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut owned = OwnedChild {
        child: command.spawn().expect("owned CLI should start"),
        stdout: None,
        stderr: None,
    };
    let pid = owned.child.id();
    let stdout = owned.child.stdout.take().expect("CLI stdout is piped");
    owned.stdout = Some(capture(stdout, "host-fixture-stdout"));
    let stderr = owned.child.stderr.take().expect("CLI stderr is piped");
    owned.stderr = Some(capture(stderr, "host-fixture-stderr"));
    loop {
        if let Some(status) = owned
            .child
            .try_wait()
            .expect("owned CLI status is readable")
            && owned.stdout.as_ref().unwrap().is_finished()
            && owned.stderr.as_ref().unwrap().is_finished()
        {
            let stdout = owned.stdout.take().unwrap().join().unwrap().unwrap();
            let stderr = owned.stderr.take().unwrap().join().unwrap().unwrap();
            return (
                pid,
                Output {
                    status,
                    stdout,
                    stderr,
                },
            );
        }
        assert!(
            Instant::now() < deadline,
            "owned CLI {pid} exceeded its 30-second process/capture deadline"
        );
        thread::sleep(Duration::from_millis(10));
    }
}

fn evidence(name: &str, result: Value) {
    let envelope = json!({
        "format_version": 1,
        "source_revision": std::env::var("PORTCOVE_DIAGNOSTICS_SOURCE_REVISION").ok(),
        "platform": std::env::consts::OS,
        "architecture": std::env::consts::ARCH,
        "crate_version": env!("CARGO_PKG_VERSION"),
        "scope": "Owned CLI subprocesses with synthetic startup faults and native helper streams",
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
fn early_failures_retain_actual_typed_phases_without_private_error_text() {
    let mut observed = Vec::new();
    for scenario in [
        "preference_decode",
        "preference_read",
        "library_open",
        "database",
        "migration",
    ] {
        let fixture = Fixture::new();
        let mut arguments = vec!["--json", "status"];
        match scenario {
            "preference_decode" => {
                fs::write(&fixture.preferences, b"{token=private-preference-canary").unwrap()
            }
            "preference_read" => fs::create_dir(&fixture.preferences).unwrap(),
            "library_open" => fs::write(&fixture.library, b"private-library-canary").unwrap(),
            "database" => {
                fs::create_dir(&fixture.library).unwrap();
                fs::write(
                    fixture.library.join("portcove.sqlite3"),
                    b"private-database-canary",
                )
                .unwrap();
            }
            "migration" => {
                drop(portcove_core::Library::open(&fixture.library).unwrap());
                let database =
                    rusqlite::Connection::open(fixture.library.join("portcove.sqlite3")).unwrap();
                database
                    .execute(
                        "INSERT INTO schema_migrations(version, applied_at) VALUES (999999, 0)",
                        [],
                    )
                    .unwrap();
            }
            _ => unreachable!(),
        }
        if !scenario.starts_with("preference_") {
            arguments.extend(["--library", fixture.library.to_str().unwrap()]);
        }
        let (pid, output) = fixture.run(&arguments);
        assert!(!output.status.success(), "{scenario}: {output:?}");
        assert!(
            output.stderr.is_empty(),
            "machine error remains on stdout: {output:?}"
        );
        let response: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(response["ok"], false);
        let code = &response["error"]["code"];
        let records = fixture.records(pid);
        assert!(
            !records.is_empty(),
            "host diagnostics unavailable for {scenario}"
        );
        assert!(records.iter().all(|record| record["surface"] == "cli"));
        let phase = if scenario.starts_with("preference_") {
            "library_selection"
        } else {
            "library_open"
        };
        assert!(
            records.iter().any(|record| {
                record["fields"]["phase"] == phase
                    && record["fields"]["success"] == false
                    && &record["fields"]["code"] == code
            }),
            "missing actual {phase}/{code} failure: {records:?}"
        );
        let core_phase = match scenario {
            "preference_decode" => Some("preference_decode"),
            "preference_read" => Some("preference_read"),
            "database" | "migration" => Some("database_open"),
            _ => None,
        };
        if let Some(core_phase) = core_phase {
            assert!(
                records.iter().any(|record| {
                    record["fields"]["phase"] == core_phase
                        && record["fields"]["success"] == false
                        && &record["fields"]["code"] == code
                }),
                "missing actual Core {core_phase}/{code} failure: {records:?}"
            );
        }
        let serialized = serde_json::to_string(&records).unwrap();
        for private in [
            "private-preference-canary",
            "private-library-canary",
            "private-database-canary",
            fixture.temporary.path().to_str().unwrap(),
        ] {
            assert!(
                !serialized.contains(private),
                "private startup input persisted"
            );
        }
        observed.push(json!({"scenario": scenario, "phase": phase, "core_phase": core_phase, "code": code, "exit_code": output.status.code(), "records": records.len()}));
    }
    evidence(
        "host-cli-startup-failures",
        json!({"cases": observed, "private_canaries_absent": true}),
    );
}

#[test]
fn occupied_logging_sessions_preserve_machine_human_and_valid_library_outcomes() {
    let fixture = Fixture::new();
    let commands: &[&[&str]] = &[
        &["--json", "about"],
        &["--jsonl", "about"],
        &["about"],
        &["--help"],
    ];
    let baseline: Vec<_> = commands
        .iter()
        .map(|arguments| {
            let (_, output) = fixture.run(arguments);
            assert!(output.status.success());
            assert!(output.stderr.is_empty());
            output.stdout
        })
        .collect();
    let active = fixture.occupy_all_sessions();
    let before: Vec<_> = SLOT_NAMES
        .iter()
        .map(|slot| fs::read(fixture.logs.join(slot).join(LOG_FILE_NAME)).ok())
        .collect();
    for (arguments, stdout) in commands.iter().zip(&baseline) {
        let (pid, output) = fixture.run(arguments);
        assert!(output.status.success());
        assert_eq!(&output.stdout, stdout);
        assert!(output.stderr.is_empty());
        assert!(
            fixture.records(pid).is_empty(),
            "occupied sessions must not be adopted"
        );
    }
    let (_, output) = run(fixture
        .command()
        .arg("--library")
        .arg(&fixture.library)
        .args(["--json", "status"]));
    assert!(
        output.status.success(),
        "logging contention must not prevent valid startup: {output:?}"
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stdout).unwrap()["ok"],
        true
    );
    assert!(fixture.library.join("portcove.sqlite3").is_file());
    assert!(output.stderr.is_empty());
    let after: Vec<_> = SLOT_NAMES
        .iter()
        .map(|slot| fs::read(fixture.logs.join(slot).join(LOG_FILE_NAME)).ok())
        .collect();
    assert_eq!(
        before, after,
        "another process's leased files are preserved"
    );
    drop(active);
    evidence(
        "host-cli-unavailable-sink",
        json!({"occupied_sessions": SLOT_NAMES.len(), "exact_stdout_modes": ["json", "jsonl", "human", "help"], "valid_library_startup": true, "stderr_bytes": 0, "active_files_preserved": true}),
    );
}

#[test]
fn explicit_verbosity_and_temporary_debug_reset_without_persisting_preferences() {
    let fixture = Fixture::new();
    let mut baseline = None;
    let mut observations = Vec::new();
    for (verbosity, temporary_debug, debug_expected) in [
        (None, None, false),
        (Some("-v"), None, false),
        (Some("-vv"), None, true),
        (None, Some("1"), true),
        (None, Some("true"), false),
        (None, None, false),
    ] {
        let mut command = fixture.command();
        command.args(["--json", "about"]);
        if let Some(verbosity) = verbosity {
            command.arg(verbosity);
        }
        if let Some(value) = temporary_debug {
            command.env("PORTCOVE_DIAGNOSTICS_DEBUG", value);
        }
        let (pid, output) = run(&mut command);
        assert!(output.status.success(), "{output:?}");
        assert!(
            output.stderr.is_empty(),
            "file-only startup diagnostics must not alter stderr"
        );
        assert_eq!(
            baseline.get_or_insert_with(|| output.stdout.clone()),
            &output.stdout
        );
        let records = fixture.records(pid);
        assert!(!records.is_empty());
        let debug = records
            .iter()
            .filter(|record| record["level"] == "DEBUG")
            .count();
        assert_eq!(debug > 0, debug_expected, "{records:?}");
        assert!(
            !fixture.preferences.exists(),
            "diagnostic verbosity must not save preferences"
        );
        observations.push(json!({"verbosity": verbosity, "temporary_debug": temporary_debug, "debug_records": debug, "session_id": records[0]["session_id"]}));
    }
    evidence(
        "host-cli-session-debug",
        json!({"observations": observations, "stdout_identical": true, "stderr_bytes": 0, "preferences_created": false}),
    );
}

fn raw_stream_helper(directory: &Path) -> PathBuf {
    let source = directory.join("owned-raw-stream.rs");
    let executable = directory.join(if cfg!(windows) {
        "owned-raw-stream.exe"
    } else {
        "owned-raw-stream"
    });
    fs::write(
        &source,
        r#"use std::io::Write;
fn main() {
    std::io::stdout().write_all(b"\0owned stdout\xff\n").unwrap();
    std::io::stderr().write_all(b"owned stderr\xfe\n").unwrap();
    std::process::exit(7);
}"#,
    )
    .unwrap();
    // This is fixture compilation with the invoking toolchain, not a game or
    // managed product build. Keep its configured rustup/toolchain location.
    let compiled = Command::new("rustc")
        .arg("--edition=2024")
        .arg(&source)
        .arg("-o")
        .arg(&executable)
        .output()
        .unwrap();
    assert!(
        compiled.status.success(),
        "{}",
        String::from_utf8_lossy(&compiled.stderr)
    );
    executable
}

#[test]
fn raw_child_bytes_and_exit_code_survive_debug_and_logging_failure() {
    let fixture = Fixture::new();
    let helper = raw_stream_helper(fixture.temporary.path());
    let service = portcove_core::PortcoveService::new(
        portcove_core::Library::open(&fixture.library).unwrap(),
    )
    .unwrap();
    let port = service.catalog().port("zelda64-recomp").unwrap();
    let platform = portcove_core::Platform::current().unwrap();
    let package = fixture.temporary.path().join("owned-package");
    fs::create_dir(&package).unwrap();
    for relative in &port.executable_hints[&platform] {
        let destination = package.join(relative);
        fs::create_dir_all(destination.parent().unwrap()).unwrap();
        fs::copy(&helper, &destination).unwrap();
    }
    let preview = service.preview_adoption(&package, Some(&port.id)).unwrap();
    let authorization = service
        .authorize_adoption(&package, Some(&port.id), &preview.plan_sha256)
        .unwrap();
    service
        .adopt(&package, Some(&port.id), &authorization.token)
        .unwrap();
    for unavailable in [false, true] {
        let _active = unavailable.then(|| fixture.occupy_all_sessions());
        for debug in [false, true] {
            let mut command = fixture.command();
            command
                .arg("--library")
                .arg(&fixture.library)
                .args(["exec", &port.id]);
            if debug {
                command.env("PORTCOVE_DIAGNOSTICS_DEBUG", "1");
            }
            let (_, output) = run(&mut command);
            assert_eq!(output.status.code(), Some(7), "{output:?}");
            assert_eq!(output.stdout, b"\0owned stdout\xff\n");
            assert_eq!(output.stderr, b"owned stderr\xfe\n");
        }
    }
    let activities = service.library().activities(100).unwrap();
    let launches: Vec<_> = activities
        .iter()
        .filter(|activity| activity.operation == portcove_core::ActivityOperation::Launch)
        .collect();
    assert_eq!(launches.len(), 4);
    assert!(
        launches
            .iter()
            .all(|activity| activity.status == portcove_core::ActivityStatus::Failed)
    );
    evidence(
        "host-cli-raw-streams",
        json!({"launches": launches.len(), "child_exit_code": 7, "durable_outcome": "failed", "stdout_bytes": 15, "stderr_bytes": 14, "raw_non_utf8_preserved": true, "temporary_debug_and_occupied_sinks": true}),
    );
}
