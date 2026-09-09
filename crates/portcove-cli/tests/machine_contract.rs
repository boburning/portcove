use std::{
    io::Write,
    process::{Command, Output, Stdio},
};

use serde_json::Value;

static CAPACITY_SENSITIVE_TEST: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn cli_binary() -> std::path::PathBuf {
    // Nextest remaps this path when executing an archive on another runner.
    // Cargo's compile-time path remains the fallback for cargo test.
    std::env::var_os("NEXTEST_BIN_EXE_portcove")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| env!("CARGO_BIN_EXE_portcove").into())
}

struct RunningCli(std::process::Child);

#[test]
fn preparation_plan_reports_missing_inputs_without_starting_work() {
    let temporary = tempfile::tempdir().unwrap();
    let library = temporary.path().join("library");
    for (port, code, exit) in [
        ("opengoal-jak1", "not_found", 4),
        ("zelda64-recomp", "unsupported", 3),
    ] {
        let output = portcove(
            &library,
            &["--json", "--non-interactive", "preparation", "plan", port],
        );
        assert_eq!(output.status.code(), Some(exit));
        let response = json_stdout(&output);
        assert_eq!(response["command"], "preparation.plan");
        assert_eq!(response["error"]["code"], code);
    }
    let activities = json_stdout(&portcove(&library, &["--json", "activity"]));
    assert!(activities["data"].as_array().unwrap().is_empty());
    let schema = json_stdout(&portcove(
        &library,
        &["--json", "schema", "export", "--contract", "output"],
    ));
    assert!(schema["data"]["preparation_plan"]["properties"]["inputs"].is_object());
    assert_eq!(
        schema["data"]["preparation_options"]["additionalProperties"],
        false
    );
}

#[test]
fn schema_contract_direction_is_explicit_compatible_and_library_free() {
    let temporary = tempfile::tempdir().unwrap();
    let library = temporary.path().join("unopened");
    let implicit = json_stdout(&portcove(&library, &["--json", "schema", "export"]));
    let input = json_stdout(&portcove(
        &library,
        &["--json", "schema", "export", "--contract", "input"],
    ));
    assert_eq!(implicit, input);
    let output = json_stdout(&portcove(
        &library,
        &["--json", "schema", "export", "--contract", "output"],
    ));
    assert_eq!(output["command"], "schema.export");
    assert_eq!(
        input["data"]
            .as_object()
            .unwrap()
            .keys()
            .collect::<Vec<_>>(),
        output["data"]
            .as_object()
            .unwrap()
            .keys()
            .collect::<Vec<_>>()
    );
    let input_install = &input["data"]["status"]["$defs"]["InstallRecord"];
    let output_install = &output["data"]["status"]["$defs"]["InstallRecord"];
    for field in ["artifact", "manifest_sha256", "selected_executable"] {
        assert!(
            !input_install["required"]
                .as_array()
                .unwrap()
                .contains(&Value::String(field.into()))
        );
        assert!(
            output_install["required"]
                .as_array()
                .unwrap()
                .contains(&Value::String(field.into()))
        );
    }
    let invalid = portcove(
        &library,
        &["--json", "schema", "export", "--contract", "unknown"],
    );
    assert_eq!(invalid.status.code(), Some(2));
    assert_eq!(json_stdout(&invalid)["error"]["code"], "usage");
    assert!(!library.exists());
}

#[test]
fn upstream_observation_is_offline_and_does_not_open_a_library() {
    let temporary = tempfile::tempdir().unwrap();
    let library = temporary.path().join("unopened");
    let observation = temporary.path().join("observation.json");
    std::fs::write(
        &observation,
        include_str!("fixtures/upstream-observation.json"),
    )
    .unwrap();
    let arguments = [
        "--json",
        "catalog",
        "inspect-observation",
        "shipwright",
        observation.to_str().unwrap(),
        "--repository-id",
        "472575717",
    ];
    let output = portcove(&library, &arguments);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let response = json_stdout(&output);
    assert_eq!(response["command"], "catalog.inspect-observation");
    assert_eq!(
        response["data"]["facts_sha256"],
        "cdbe83850467e64c075dc5c4f91089c7844c5375d21e14236b79adb8e0c571ca"
    );
    assert_eq!(
        response["data"]["evidence"]["catalog_admission_assessed"],
        false
    );
    assert!(
        response["data"]["projections"]
            .as_array()
            .unwrap()
            .iter()
            .all(|entry| entry["latest_eligible"].is_null())
    );
    assert!(!library.exists());
    std::fs::write(&observation, "{}").unwrap();
    let rejected = portcove(&library, &arguments);
    assert!(!rejected.status.success());
    assert_eq!(
        json_stdout(&rejected)["command"],
        "catalog.inspect-observation"
    );
    assert!(!library.exists());
    let missing_identity = portcove(&library, &arguments[..5]);
    assert_eq!(missing_identity.status.code(), Some(2));
    assert_eq!(json_stdout(&missing_identity)["error"]["code"], "usage");
    assert!(!library.exists());
}

#[test]
fn exported_source_assessment_separates_facts_without_opening_library() {
    let temporary = tempfile::tempdir().unwrap();
    let library = temporary.path().join("unopened");
    let output = portcove(&library, &["--json", "schema", "export"]);
    assert!(output.status.success());
    let response = json_stdout(&output);
    assert_eq!(response["schema_version"], 36);
    let schema = &response["data"]["source_assessment"];
    for field in [
        "health",
        "classification",
        "contract",
        "admission",
        "evidence",
    ] {
        assert!(schema["properties"][field].is_object(), "{field}");
    }
    assert!(
        schema["$defs"]["SourceHealth"]["enum"]
            .as_array()
            .unwrap()
            .contains(&Value::String("not_baselined".into()))
    );
    assert!(!library.exists());
    let inspection = &response["data"]["source_inspection"];
    for field in [
        "schema_version",
        "profile_id",
        "health",
        "state_code",
        "summary",
        "next_action",
        "registered",
        "inspection",
        "problem",
        "expected_identity",
        "applications",
        "evidence",
        "legacy",
    ] {
        assert!(inspection["properties"][field].is_object(), "{field}");
    }
    assert!(
        inspection["$defs"]["SourceValidatorResult"]["enum"]
            .as_array()
            .unwrap()
            .contains(&Value::String("not_run".into()))
    );
    assert_eq!(
        inspection["$defs"]["SourceComponentKind"]["enum"],
        serde_json::json!(["file_set_member", "optical_disc"])
    );
    let selection = &response["data"]["library_selection"];
    assert!(selection["properties"]["root"].is_object());
    assert_eq!(
        selection["$defs"]["LibrarySelectionSource"]["enum"],
        serde_json::json!(["invocation", "saved", "platform_default"])
    );
    let catalog = &response["data"]["source_catalog"];
    for field in ["evidence", "identities", "contracts", "validators"] {
        assert!(catalog["properties"][field].is_object(), "{field}");
    }
    assert!(
        catalog["$defs"]["DigestScope"]["enum"]
            .as_array()
            .unwrap()
            .contains(&Value::String("canonical-n64-big-endian".into()))
    );
    assert!(response["data"]["catalog"]["properties"]["source_catalog"].is_object());
    let output = &response["data"]["output_destination_preview"];
    for field in [
        "current",
        "proposed",
        "availability",
        "ownership",
        "affected_installs",
        "moves_existing_install",
        "preview_sha256",
    ] {
        assert!(output["properties"][field].is_object(), "{field}");
    }
    assert_eq!(
        output["$defs"]["OutputDestinationAvailability"]["enum"],
        serde_json::json!(["available", "full", "unavailable"])
    );
    assert_eq!(
        output["$defs"]["OutputDestinationOwnership"]["enum"],
        serde_json::json!([
            "library_default",
            "unclaimed",
            "owned_by_port",
            "owned_by_another_port",
            "unrelated_content",
            "invalid",
            "unknown"
        ])
    );
    let relocation = &response["data"]["output_relocation_plan"];
    for field in [
        "current",
        "destination_root",
        "installs",
        "required_bytes",
        "sources_will_move",
        "user_data_will_move",
        "backups_will_move",
        "plan_sha256",
    ] {
        assert!(relocation["properties"][field].is_object(), "{field}");
    }
}

#[test]
fn catalog_trust_commands_require_review_and_preserve_embedded_offline_use() {
    let temporary = tempfile::tempdir().unwrap();
    let library = temporary.path().join("library");
    let original = json_stdout(&portcove(&library, &["--json", "catalog", "status"]));
    assert_eq!(original["data"]["provenance"]["origin"], "embedded");
    assert_eq!(original["data"]["highest_sequence"], 0);
    // RFC 8032 test-vector public key, never a production signing identity.
    let public_key = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
    let no_consent = portcove(
        &library,
        &[
            "--json",
            "--non-interactive",
            "catalog",
            "trust-key",
            public_key,
        ],
    );
    assert!(!no_consent.status.success());
    let trust = portcove(
        &library,
        &["--json", "catalog", "trust-key", public_key, "--yes"],
    );
    assert!(trust.status.success());
    let data = json_stdout(&trust)["data"].clone();
    assert_eq!(data["provenance"]["origin"], "embedded");
    assert_eq!(data["trusted_keys"][0]["public_key"], public_key);
    let id = data["trusted_keys"][0]["key_id"].as_str().unwrap();
    let stale = portcove(
        &library,
        &[
            "--json",
            "catalog",
            "revoke-key",
            id,
            "--expected-state",
            original["data"]["state_sha256"].as_str().unwrap(),
        ],
    );
    assert_eq!(json_stdout(&stale)["error"]["code"], "conflict");
    let revoke = portcove(
        &library,
        &[
            "--json",
            "catalog",
            "revoke-key",
            id,
            "--expected-state",
            data["state_sha256"].as_str().unwrap(),
        ],
    );
    assert!(revoke.status.success());
    assert_eq!(
        json_stdout(&revoke)["data"]["trusted_keys"],
        serde_json::json!([])
    );
    let doctor = json_stdout(&portcove(&library, &["--json", "doctor"]));
    assert_eq!(doctor["data"]["catalog_provenance"]["origin"], "embedded");
}
impl Drop for RunningCli {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn cancellation_from_another_cli_stops_discovery_with_a_durable_cancelled_result() {
    use std::io::{BufRead, Read};
    eprintln!("CLI cancellation: prepare source");
    let _capacity_guard = CAPACITY_SENSITIVE_TEST.lock().unwrap();
    let temporary = tempfile::tempdir().unwrap();
    let sources = temporary.path().join("sources");
    std::fs::create_dir(&sources).unwrap();
    let source = sources.join("synthetic.z64");
    std::fs::File::create(&source)
        .unwrap()
        .set_len(256 * 1024 * 1024)
        .unwrap();
    let library = temporary.path().join("library");
    let mut child = RunningCli(
        Command::new(cli_binary())
            .arg("--library")
            .arg(&library)
            .args(["--jsonl", "source", "discover", "--root"])
            .arg(&sources)
            .args(["--profile", "mario-kart-64"])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap(),
    );
    let mut output = std::io::BufReader::new(child.0.stdout.take().unwrap());
    let mut started = String::new();
    eprintln!("CLI cancellation: await started event");
    output.read_line(&mut started).unwrap();
    let started: Value = serde_json::from_str(&started).unwrap();
    assert_eq!(started["schema_version"], 2);
    assert_eq!(started["type"], "started");
    let id = started["operation_id"].as_str().unwrap();
    eprintln!("CLI cancellation: request cancellation");
    let cancelled = portcove(&library, &["--json", "cancel", id]);
    assert!(
        cancelled.status.success(),
        "{}",
        String::from_utf8_lossy(&cancelled.stdout)
    );
    assert_eq!(json_stdout(&cancelled)["data"]["requested"], true);
    let mut rest = String::new();
    eprintln!("CLI cancellation: await exit");
    output.read_to_string(&mut rest).unwrap();
    assert_eq!(child.0.wait().unwrap().code(), Some(130));
    let lines = rest
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert!(lines.iter().any(|line| line["operation_id"] == id
        && line["type"] == "finished"
        && line["result"] == "cancelled"));
    assert_eq!(lines.last().unwrap()["error"]["code"], "cancelled");
    eprintln!("CLI cancellation: verify durable activity");
    let ledger = json_stdout(&portcove(&library, &["--json", "activity"]));
    assert_eq!(ledger["data"][0]["id"], id);
    assert_eq!(ledger["data"][0]["status"], "cancelled");
    eprintln!("CLI cancellation: verify empty source registry");
    assert_eq!(
        json_stdout(&portcove(&library, &["--json", "source", "list"]))["data"],
        serde_json::json!([])
    );
    assert_eq!(std::fs::metadata(source).unwrap().len(), 256 * 1024 * 1024);
}

fn portcove(library: &std::path::Path, args: &[&str]) -> Output {
    Command::new(cli_binary())
        .arg("--library")
        .arg(library)
        .args(args)
        .output()
        .expect("Portcove CLI should start")
}

fn portcove_preferences(preferences: &std::path::Path, args: &[&str]) -> Output {
    Command::new(cli_binary())
        .env("PORTCOVE_PREFERENCES", preferences)
        .args(args)
        .output()
        .expect("Portcove CLI should start")
}

fn portcove_tool(
    preferences: &std::path::Path,
    library: &std::path::Path,
    args: &[&str],
) -> Output {
    Command::new(cli_binary())
        .env("PORTCOVE_PREFERENCES", preferences)
        .env_remove("PORTCOVE_CHDMAN")
        .env_remove("PORTCOVE_DOLPHIN_TOOL")
        .arg("--library")
        .arg(library)
        .args(args)
        .output()
        .expect("Portcove CLI should start")
}

fn compile_chdman_fixture(directory: &std::path::Path) -> std::path::PathBuf {
    if let Some(prepared) = std::env::var_os("PORTCOVE_HOST_TOOL_FIXTURE") {
        let executable = directory.join(if cfg!(windows) {
            "chdman-fixture.exe"
        } else {
            "chdman-fixture"
        });
        std::fs::copy(prepared, &executable).unwrap();
        return executable;
    }
    let source = directory.join("chdman_fixture.rs");
    std::fs::write(
        &source,
        r#"fn main() {
    if std::env::args().nth(1).as_deref() == Some("-help") {
        println!("chdman verify extractdvd");
    } else {
        println!("unexpected arguments");
        std::process::exit(7);
    }
}"#,
    )
    .unwrap();
    let executable = directory.join(if cfg!(windows) {
        "chdman-fixture.exe"
    } else {
        "chdman-fixture"
    });
    let compiled = Command::new("rustc")
        .arg(&source)
        .arg("-o")
        .arg(&executable)
        .output()
        .unwrap();
    assert!(
        compiled.status.success(),
        "fixture compilation failed: {}",
        String::from_utf8_lossy(&compiled.stderr)
    );
    executable
}

#[test]
fn disc_tool_commands_are_library_free_restart_safe_and_machine_readable() {
    let temporary = tempfile::tempdir().unwrap();
    let preferences = temporary.path().join("config/preferences.json");
    let library = temporary.path().join("must-not-be-opened");
    let helper = compile_chdman_fixture(temporary.path());
    let helper_text = helper.to_str().unwrap();

    let listed = portcove_tool(&preferences, &library, &["--json", "tool", "list"]);
    assert!(listed.status.success());
    let listed = json_stdout(&listed);
    assert_eq!(listed["command"], "tool.list");
    assert_eq!(listed["data"].as_array().unwrap().len(), 2);
    assert_eq!(
        listed["data"][0]["official_url"],
        "https://docs.mamedev.org/tools/chdman.html"
    );
    assert!(!library.exists());
    assert!(!preferences.exists());

    let configured = json_stdout(&portcove_tool(
        &preferences,
        &library,
        &["--json", "tool", "set-path", "chdman", helper_text],
    ));
    assert_eq!(configured["command"], "tool.set-path");
    assert_eq!(configured["data"]["state"], "success");
    assert_eq!(configured["data"]["persisted"], true);
    assert!(configured["data"]["sha256"].as_str().is_some());
    assert!(!library.exists());

    let restarted = json_stdout(&portcove_tool(
        &preferences,
        &library,
        &["--json", "tool", "list"],
    ));
    let chdman = restarted["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|tool| tool["id"] == "chdman")
        .unwrap();
    assert_eq!(chdman["state"], "available");
    assert_eq!(chdman["source"], "saved");
    assert_eq!(chdman["path"], helper_text);

    let missing = temporary.path().join("missing-chdman");
    let rejected = json_stdout(&portcove_tool(
        &preferences,
        &library,
        &[
            "--json",
            "tool",
            "set-path",
            "chdman",
            missing.to_str().unwrap(),
        ],
    ));
    assert_eq!(rejected["data"]["state"], "missing");
    assert_eq!(rejected["data"]["persisted"], false);
    let preserved = json_stdout(&portcove_tool(
        &preferences,
        &library,
        &["--json", "tool", "list"],
    ));
    let chdman = preserved["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|tool| tool["id"] == "chdman")
        .unwrap();
    assert_eq!(chdman["path"], helper_text);
    assert_eq!(chdman["source"], "saved");

    let cleared = json_stdout(&portcove_tool(
        &preferences,
        &library,
        &["--jsonl", "tool", "clear-path", "chdman"],
    ));
    assert_eq!(cleared["type"], "result");
    assert_eq!(cleared["command"], "tool.clear-path");
    assert_ne!(cleared["data"]["source"], "saved");

    let unknown = portcove_tool(
        &preferences,
        &library,
        &["--json", "tool", "clear-path", "https://example.com"],
    );
    assert_eq!(unknown.status.code(), Some(2));
    assert_eq!(json_stdout(&unknown)["error"]["code"], "usage");

    let human = portcove_tool(&preferences, &library, &["tool", "list"]);
    let human = String::from_utf8(human.stdout).unwrap();
    assert!(human.contains("Disc tools (2)"));
    assert!(human.contains("OFFICIAL SITE"));
    assert!(!library.exists());
}

#[test]
fn library_preference_commands_are_library_free_recoverable_and_shared_with_startup() {
    let temporary = tempfile::tempdir().unwrap();
    let preferences = temporary.path().join("config/preferences.json");
    let selected = temporary.path().join("selected");
    std::fs::create_dir(&selected).unwrap();

    let initial = json_stdout(&portcove_preferences(
        &preferences,
        &["--json", "library", "show"],
    ));
    assert_eq!(initial["data"]["source"], "platform_default");
    assert!(!preferences.exists());

    let saved = json_stdout(&portcove_preferences(
        &preferences,
        &["--json", "library", "set", selected.to_str().unwrap()],
    ));
    assert_eq!(saved["data"]["source"], "saved");
    assert_eq!(
        saved["data"]["root"],
        std::fs::canonicalize(&selected).unwrap().to_str().unwrap()
    );
    assert_eq!(std::fs::read_dir(&selected).unwrap().count(), 0);

    let storage = json_stdout(&portcove_preferences(&preferences, &["--json", "storage"]));
    assert_eq!(storage["data"]["library_root"], saved["data"]["root"]);

    std::fs::write(&preferences, b"{").unwrap();
    let damaged = portcove_preferences(&preferences, &["--json", "library", "show"]);
    assert!(!damaged.status.success());
    assert_eq!(json_stdout(&damaged)["error"]["code"], "state");
    let reset = json_stdout(&portcove_preferences(
        &preferences,
        &["--json", "library", "reset"],
    ));
    assert_eq!(reset["data"]["source"], "platform_default");
    assert!(selected.join("portcove.sqlite3").is_file());
}

#[test]
fn declining_backup_deletion_is_a_neutral_non_mutating_result() {
    let temporary = tempfile::tempdir().unwrap();
    let library = temporary.path().join("library");
    let user = library.join("user/zelda64-recomp");
    std::fs::create_dir_all(&user).unwrap();
    std::fs::write(user.join("save.dat"), b"preserve").unwrap();
    let created = json_stdout(&portcove(
        &library,
        &["--json", "backup", "create", "zelda64-recomp"],
    ));
    let backup_id = created["data"]["id"].as_str().unwrap();
    let mut child = Command::new(cli_binary())
        .arg("--library")
        .arg(&library)
        .args(["backup", "delete", "zelda64-recomp", backup_id])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.as_mut().unwrap().write_all(b"n\n").unwrap();
    let declined = child.wait_with_output().unwrap();

    assert!(declined.status.success());
    assert!(
        String::from_utf8_lossy(&declined.stdout)
            .contains("Backup deletion cancelled. No changes were made.")
    );
    let listed = json_stdout(&portcove(
        &library,
        &["--json", "backup", "list", "zelda64-recomp"],
    ));
    assert_eq!(listed["data"]["state"], "healthy");
    assert_eq!(listed["data"]["backups"][0]["id"], backup_id);
}

fn json_stdout(output: &Output) -> Value {
    let stdout = std::str::from_utf8(&output.stdout).expect("stdout should be UTF-8");
    assert_eq!(stdout.lines().count(), 1, "machine stdout: {stdout:?}");
    serde_json::from_str(stdout).expect("stdout should contain one JSON document")
}

fn human_stdout(output: &Output) -> &str {
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    std::str::from_utf8(&output.stdout).expect("stdout should be UTF-8")
}

#[test]
fn library_move_requires_review_and_redirects_later_cli_processes() {
    let temporary = tempfile::tempdir().unwrap();
    let source = temporary.path().join("source");
    let destination = temporary.path().join("destination");
    let reviewed = portcove(
        &source,
        &["--json", "library", "move", destination.to_str().unwrap()],
    );
    assert!(reviewed.status.success());
    let plan = json_stdout(&reviewed);
    let digest = plan["data"]["plan_sha256"].as_str().unwrap();
    assert!(!destination.exists());
    let missing = portcove(
        &source,
        &[
            "--json",
            "library",
            "move",
            destination.to_str().unwrap(),
            "--apply",
        ],
    );
    assert_eq!(missing.status.code(), Some(2));
    let moved = portcove(
        &source,
        &[
            "--json",
            "library",
            "move",
            destination.to_str().unwrap(),
            "--apply",
            "--expected-plan",
            digest,
        ],
    );
    assert!(moved.status.success(), "{moved:?}");
    assert_eq!(json_stdout(&moved)["data"]["completed"], true);
    let exported = portcove(&source, &["--json", "library", "export"]);
    assert!(exported.status.success());
    assert_eq!(
        json_stdout(&exported)["data"]["original_root"],
        std::fs::canonicalize(destination)
            .unwrap()
            .to_str()
            .unwrap()
    );
    let resumed = portcove(&source, &["--json", "library", "resume-move"]);
    assert!(resumed.status.success());
    assert_eq!(json_stdout(&resumed)["command"], "library.resume_move");
}

struct CliImportFixture {
    _temporary: tempfile::TempDir,
    destination: std::path::PathBuf,
    metadata: std::path::PathBuf,
    content: std::path::PathBuf,
    plan: Value,
}

impl CliImportFixture {
    fn new() -> Self {
        let temporary = tempfile::tempdir().unwrap();
        let source = temporary.path().join("source");
        let metadata = temporary.path().join("metadata.json");
        let content = temporary.path().join("copied-content");
        let destination = temporary.path().join("restored");
        let exported = portcove(
            &source,
            &[
                "--json",
                "library",
                "export",
                "--output",
                metadata.to_str().unwrap(),
            ],
        );
        assert!(exported.status.success());
        std::fs::create_dir_all(content.join("user/example")).unwrap();
        std::fs::write(content.join("user/example/save.bin"), b"synthetic save").unwrap();
        let args = vec![
            "--json",
            "library",
            "import",
            metadata.to_str().unwrap(),
            content.to_str().unwrap(),
        ];
        let planned = portcove(&destination, &args);
        assert!(planned.status.success(), "{planned:?}");
        assert!(!destination.exists());
        assert!(!content.join("portcove.sqlite3").exists());
        let document = json_stdout(&planned);
        Self {
            _temporary: temporary,
            destination,
            metadata,
            content,
            plan: document,
        }
    }

    fn arguments(&self) -> [&str; 5] {
        [
            "--json",
            "library",
            "import",
            self.metadata.to_str().unwrap(),
            self.content.to_str().unwrap(),
        ]
    }

    fn apply(&self) {
        let mut args = self.arguments().to_vec();
        args.extend([
            "--apply",
            "--expected-plan",
            self.plan["data"]["plan_sha256"].as_str().unwrap(),
        ]);
        let restored = portcove(&self.destination, &args);
        assert!(restored.status.success(), "{restored:?}");
        assert_eq!(json_stdout(&restored)["data"]["completed"], true);
        assert_eq!(
            std::fs::read(self.destination.join("user/example/save.bin")).unwrap(),
            b"synthetic save"
        );
    }
}

#[test]
fn library_import_is_read_only_until_reviewed() {
    let fixture = CliImportFixture::new();
    let mut args = fixture.arguments().to_vec();
    args.push("--apply");
    assert_eq!(portcove(&fixture.destination, &args).status.code(), Some(2));
    assert!(!fixture.destination.exists());
    assert!(!fixture.content.join("portcove.sqlite3").exists());
}

#[test]
fn reviewed_library_import_is_usable_by_a_fresh_cli() {
    let fixture = CliImportFixture::new();
    fixture.apply();
    let fresh = portcove(&fixture.destination, &["--json", "library", "export"]);
    assert!(fresh.status.success());
}

#[test]
fn completed_library_import_resumes_idempotently_and_cannot_be_aborted() {
    let fixture = CliImportFixture::new();
    fixture.apply();
    let resumed = portcove(
        &fixture.destination,
        &["--json", "library", "resume-import"],
    );
    assert!(resumed.status.success(), "{resumed:?}");
    assert_eq!(json_stdout(&resumed)["command"], "library.resume_import");
    assert!(
        !portcove(&fixture.destination, &["--json", "library", "abort-import"])
            .status
            .success()
    );
}

#[test]
fn library_metadata_export_is_versioned_and_does_not_replace_an_existing_file() {
    let temporary = tempfile::tempdir().unwrap();
    let library = temporary.path().join("library");
    let output = portcove(&library, &["--json", "library", "export"]);
    assert!(output.status.success());
    let metadata = json_stdout(&output);
    assert_eq!(metadata["command"], "library.export");
    assert_eq!(metadata["data"]["schema_version"], 2);
    assert_eq!(
        metadata["data"]["content_roots"].as_array().unwrap().len(),
        5
    );
    assert!(
        metadata["data"]["source_references"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let file = temporary.path().join("library.json");
    let args = [
        "--json",
        "library",
        "export",
        "--output",
        file.to_str().unwrap(),
    ];
    let written = portcove(&library, &args);
    assert!(written.status.success());
    assert_eq!(
        json_stdout(&written)["data"]["sha256"]
            .as_str()
            .unwrap()
            .len(),
        64
    );
    let contents = std::fs::read(&file).unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&contents).unwrap()["schema_version"],
        2
    );
    assert!(!portcove(&library, &args).status.success());
    assert_eq!(std::fs::read(file).unwrap(), contents);
}

#[test]
fn source_relink_requires_a_current_plan_and_preserves_registered_content() {
    let temporary = tempfile::tempdir().unwrap();
    let library = temporary.path().join("library");
    let original = temporary.path().join("original.z64");
    let relocated = temporary.path().join("relocated.z64");
    std::fs::write(&original, b"synthetic source fixture").unwrap();
    std::fs::copy(&original, &relocated).unwrap();
    let added = portcove(
        &library,
        &[
            "--json",
            "source",
            "add",
            "star-fox-64",
            original.to_str().unwrap(),
        ],
    );
    assert!(added.status.success());
    let added = json_stdout(&added);
    assert_eq!(added["data"]["observed_identity"]["schema_version"], 1);
    assert_eq!(
        added["data"]["observed_identity"]["digests"][0]["algorithm"],
        "sha1"
    );
    let args = [
        "--json",
        "source",
        "relink",
        "star-fox-64",
        relocated.to_str().unwrap(),
    ];
    let plan = json_stdout(&portcove(&library, &args));
    assert_eq!(plan["command"], "source.relink");
    assert_eq!(plan["data"]["original"]["path"], original.to_str().unwrap());
    assert_eq!(
        plan["data"]["replacement"]["observed_identity"],
        plan["data"]["original"]["observed_identity"]
    );
    let fingerprint = plan["data"]["preview_sha256"].as_str().unwrap();
    assert_eq!(fingerprint.len(), 64);
    let mut apply = args.to_vec();
    apply.push("--apply");
    let missing_plan = portcove(&library, &apply);
    assert_eq!(missing_plan.status.code(), Some(2));
    assert_eq!(json_stdout(&missing_plan)["error"]["code"], "usage");
    apply.extend(["--expected-plan", fingerprint]);
    std::fs::write(&relocated, b"changed synthetic bytes").unwrap();
    let rejected = portcove(&library, &apply);
    assert!(!rejected.status.success());
    assert_eq!(json_stdout(&rejected)["error"]["code"], "source_invalid");
    let unchanged = json_stdout(&portcove(&library, &["--json", "source", "list"]));
    assert_eq!(unchanged["data"][0]["path"], original.to_str().unwrap());
    std::fs::copy(&original, &relocated).unwrap();
    std::fs::remove_file(original).unwrap();
    let applied = portcove(&library, &apply);
    assert!(applied.status.success(), "{applied:?}");
    let result = json_stdout(&applied);
    assert_eq!(result["command"], "source.relink");
    assert_eq!(result["data"]["path"], relocated.to_str().unwrap());
    assert_eq!(result["data"]["sha256"], plan["data"]["original"]["sha256"]);
    assert_eq!(
        result["data"]["observed_identity"],
        plan["data"]["replacement"]["observed_identity"]
    );
}

#[test]
fn source_inspect_is_read_only_complete_and_equivalent_across_output_modes() {
    let temporary = tempfile::tempdir().unwrap();
    let library = temporary.path().join("library");
    let source = temporary.path().join("selected.z64");
    std::fs::write(&source, b"synthetic source fixture").unwrap();
    let added = portcove(
        &library,
        &[
            "--json",
            "source",
            "add",
            "star-fox-64",
            source.to_str().unwrap(),
        ],
    );
    assert!(added.status.success(), "{added:?}");

    let json = json_stdout(&portcove(
        &library,
        &["--json", "source", "inspect", "star-fox-64"],
    ));
    assert_eq!(json["schema_version"], 36);
    assert_eq!(json["command"], "source.inspect");
    assert_eq!(json["data"]["schema_version"], 1);
    assert_eq!(json["data"]["health"], "current");
    assert_eq!(json["data"]["state_code"], "accepted_identity_unknown");
    assert_eq!(
        json["data"]["inspection"]["assessment"]["health"],
        "current"
    );
    assert!(json["data"]["expected_identity"]["variants"].is_array());
    assert!(json["data"]["applications"].is_array());
    assert!(json["data"]["evidence"].is_array());
    let actual_sha256 = json["data"]["inspection"]["observed_digests"]
        .as_array()
        .unwrap()
        .iter()
        .find(|digest| digest["algorithm"] == "sha256")
        .unwrap()["value"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(actual_sha256.len(), 64);

    let jsonl = json_stdout(&portcove(
        &library,
        &["--jsonl", "source", "inspect", "star-fox-64"],
    ));
    assert_eq!(jsonl["type"], "result");
    assert_eq!(jsonl["data"], json["data"]);

    let human = portcove(&library, &["source", "inspect", "star-fox-64"]);
    assert!(human.status.success(), "{human:?}");
    let human = String::from_utf8(human.stdout).unwrap();
    for text in [
        "Source inspection: star-fox-64",
        "State: accepted_identity_unknown",
        "Observed identities:",
        "Expected identity:",
        "Reviewed port requirements:",
        "Next:",
        &actual_sha256,
    ] {
        assert!(human.contains(text), "missing {text:?} in {human}");
    }

    let verified = json_stdout(&portcove(
        &library,
        &["--json", "source", "verify", "star-fox-64"],
    ));
    assert_eq!(verified["data"]["inspection"], json["data"]);

    std::fs::write(&source, b"changed synthetic source fixture").unwrap();
    let changed = json_stdout(&portcove(
        &library,
        &["--json", "source", "inspect", "star-fox-64"],
    ));
    assert_eq!(changed["data"]["health"], "changed");
    assert_eq!(changed["data"]["state_code"], "source_changed");
    assert_ne!(
        changed["data"]["registered"]["sha256"],
        changed["data"]["inspection"]["observed_digests"][1]["value"]
    );

    std::fs::remove_file(&source).unwrap();
    let missing = json_stdout(&portcove(
        &library,
        &["--json", "source", "inspect", "star-fox-64"],
    ));
    assert_eq!(missing["data"]["health"], "missing");
    assert_eq!(missing["data"]["state_code"], "source_missing");
    assert!(missing["data"]["inspection"].is_null());
    assert!(missing["data"]["problem"]["code"].is_string());
}

#[test]
fn source_discovery_requires_explicit_scope_and_never_registers_implicitly() {
    let temporary = tempfile::tempdir().unwrap();
    let library = temporary.path().join("library");
    let source_root = temporary.path().join("sources");
    std::fs::create_dir(&source_root).unwrap();
    std::fs::write(source_root.join("candidate.z64"), b"synthetic source").unwrap();
    let missing = portcove(
        &library,
        &[
            "--json",
            "source",
            "discover",
            "--root",
            source_root.to_str().unwrap(),
        ],
    );
    assert_eq!(missing.status.code(), Some(2));
    let result = portcove(
        &library,
        &[
            "--json",
            "source",
            "discover",
            "--root",
            source_root.to_str().unwrap(),
            "--profile",
            "mario-kart-64",
            "--max-hash-bytes",
            "1",
        ],
    );
    assert!(result.status.success(), "{result:?}");
    let data = json_stdout(&result);
    assert_eq!(data["command"], "source.discover");
    assert_eq!(data["data"]["hash_bytes"], 0);
    assert_eq!(data["data"]["candidates"], serde_json::json!([]));
    assert_eq!(
        data["data"]["limits_reached"],
        serde_json::json!(["hash_bytes"])
    );
    let sources = portcove(&library, &["--json", "source", "list"]);
    assert_eq!(json_stdout(&sources)["data"], serde_json::json!([]));
    assert_eq!(
        std::fs::read(source_root.join("candidate.z64")).unwrap(),
        b"synthetic source"
    );
    let refused = portcove(
        &library,
        &[
            "--json",
            "source",
            "add",
            "star-fox-64",
            source_root.join("candidate.z64").to_str().unwrap(),
            "--expected-sha256",
            &"a".repeat(64),
        ],
    );
    assert!(!refused.status.success());
    assert_eq!(
        json_stdout(&portcove(&library, &["--json", "source", "list"]))["data"],
        serde_json::json!([])
    );
}

#[test]
fn source_inbox_controls_share_stable_scan_and_import_activity_ids() {
    let temporary = tempfile::tempdir().unwrap();
    let library = temporary.path().join("library");
    let profile = "opengoal-jak1-disc";

    let paths = json_stdout(&portcove(
        &library,
        &["--json", "source", "inbox", "path", profile],
    ));
    let profile_path = std::path::PathBuf::from(paths["data"]["profile"].as_str().unwrap());
    assert!(!profile_path.exists());

    let scan = json_stdout(&portcove(
        &library,
        &["--json", "source", "inbox", "scan", profile],
    ));
    assert_eq!(scan["schema_version"], 36);
    assert_eq!(scan["command"], "source.inbox.scan");
    assert_eq!(scan["data"]["state"], "unresolved");
    let scan_id = scan["data"]["operation_id"].as_str().unwrap();
    let activity = json_stdout(&portcove(&library, &["--json", "activity"]));
    assert_eq!(activity["data"][0]["id"], scan_id);
    assert_eq!(activity["data"][0]["operation"], "discover_sources");

    let original = temporary.path().join("original.iso");
    std::fs::write(&original, b"synthetic desktop and CLI parity source").unwrap();
    let original_text = original.to_str().unwrap();
    let plan = json_stdout(&portcove(
        &library,
        &[
            "--json",
            "source",
            "inbox",
            "import",
            profile,
            original_text,
        ],
    ));
    assert_eq!(plan["command"], "source.inbox.import");
    assert_eq!(plan["data"]["mode"], "copy");
    let fingerprint = plan["data"]["plan_sha256"].as_str().unwrap();
    let applied = json_stdout(&portcove(
        &library,
        &[
            "--json",
            "source",
            "inbox",
            "import",
            profile,
            original_text,
            "--apply",
            "--expected-plan",
            fingerprint,
        ],
    ));
    assert_eq!(applied["data"]["outcome"], "copied");
    assert!(original.exists());
    let destination =
        std::path::PathBuf::from(applied["data"]["registered"]["path"].as_str().unwrap());
    assert_eq!(
        std::fs::read(&destination).unwrap(),
        std::fs::read(&original).unwrap()
    );
    let import_id = applied["data"]["import_id"].as_str().unwrap();
    let activity = json_stdout(&portcove(&library, &["--json", "activity"]));
    assert!(
        activity["data"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["id"] == import_id && item["operation"] == "import_source")
    );

    let current = temporary.path().join("current.iso");
    std::fs::write(&current, b"synthetic current location source").unwrap();
    let current_text = current.to_str().unwrap();
    let current_plan = json_stdout(&portcove(
        &library,
        &[
            "--json",
            "source",
            "inbox",
            "import",
            profile,
            current_text,
            "--mode",
            "use-current-location",
        ],
    ));
    let current_fingerprint = current_plan["data"]["plan_sha256"].as_str().unwrap();
    let output = portcove(
        &library,
        &[
            "--jsonl",
            "source",
            "inbox",
            "import",
            profile,
            current_text,
            "--mode",
            "use-current-location",
            "--apply",
            "--expected-plan",
            current_fingerprint,
        ],
    );
    assert!(output.status.success(), "{output:?}");
    let events = std::str::from_utf8(&output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    let started_id = events
        .iter()
        .find(|event| event["type"] == "started")
        .unwrap()["operation_id"]
        .as_str()
        .unwrap();
    let result = events.last().unwrap();
    assert_eq!(result["type"], "result");
    assert_eq!(result["data"]["import_id"], started_id);
    assert_eq!(result["data"]["outcome"], "registered_current_location");
    assert!(current.exists());

    let move_source = temporary.path().join("move.iso");
    std::fs::write(&move_source, b"synthetic unauthorized move source").unwrap();
    let move_text = move_source.to_str().unwrap();
    let move_plan = json_stdout(&portcove(
        &library,
        &[
            "--json", "source", "inbox", "import", profile, move_text, "--mode", "move",
        ],
    ));
    let rejected = portcove(
        &library,
        &[
            "--json",
            "--non-interactive",
            "source",
            "inbox",
            "import",
            profile,
            move_text,
            "--mode",
            "move",
            "--apply",
            "--expected-plan",
            move_plan["data"]["plan_sha256"].as_str().unwrap(),
        ],
    );
    assert_eq!(rejected.status.code(), Some(2));
    assert_eq!(json_stdout(&rejected)["error"]["code"], "usage");
    assert!(move_source.exists());
}

#[test]
fn catalog_list_has_human_output_snapshot() {
    let root = tempfile::tempdir().unwrap();
    let catalog = human_stdout(&portcove(root.path(), &["catalog", "list"])).to_owned();
    assert!(catalog.starts_with("Ports ("));
    assert!(catalog.contains("ID"));
    assert!(catalog.contains("lighthouse"));
    assert!(!catalog.trim_start().starts_with('['));
}

#[test]
fn port_status_has_human_output_snapshot() {
    let root = tempfile::tempdir().unwrap();
    let status = human_stdout(&portcove(root.path(), &["status", "lighthouse"])).to_owned();
    assert!(status.starts_with("Status (1)\nPORT"));
    assert!(status.contains("lighthouse"));
    assert!(status.contains("stable"));
    assert!(!status.trim_start().starts_with('{'));
}

#[test]
fn empty_library_lists_has_human_output_snapshot() {
    let root = tempfile::tempdir().unwrap();
    assert_eq!(
        human_stdout(&portcove(root.path(), &["source", "list"])),
        "No registered sources.\n",
    );
    assert_eq!(
        human_stdout(&portcove(root.path(), &["backup", "list", "lighthouse"])),
        "No backups for lighthouse.\n",
    );
    assert_eq!(
        human_stdout(&portcove(root.path(), &["activity"])),
        "No activity records.\n",
    );
}

#[test]
fn paths_has_human_output_snapshot() {
    let root = tempfile::tempdir().unwrap();
    let paths = human_stdout(&portcove(root.path(), &["paths", "lighthouse"])).to_owned();
    assert!(paths.starts_with("Paths for lighthouse\nLibrary:"));
    assert!(paths.contains("\nPersistent data:"));
}

#[test]
fn storage_has_human_output_snapshot() {
    let root = tempfile::tempdir().unwrap();
    let storage = human_stdout(&portcove(root.path(), &["storage"])).to_owned();
    assert!(storage.starts_with("Library storage\nRoot:"));
    assert!(storage.contains("\nAvailable:"));
}

#[test]
fn doctor_has_human_output_snapshot() {
    let root = tempfile::tempdir().unwrap();
    let doctor = human_stdout(&portcove(root.path(), &["doctor"])).to_owned();
    assert!(doctor.starts_with("Portcove doctor\nPlatform:"));
    assert!(doctor.contains("\nRepair review: no items"));
}

#[test]
fn catalog_show_has_human_output_snapshot() {
    let root = tempfile::tempdir().unwrap();
    let port = human_stdout(&portcove(root.path(), &["catalog", "show", "lighthouse"])).to_owned();
    assert!(port.starts_with("Lighthouse (lighthouse)\nSupport:"));
    assert!(port.contains("\nProject: https://"));
}

#[test]
fn capabilities_has_human_output_snapshot() {
    let root = tempfile::tempdir().unwrap();
    let capabilities = human_stdout(&portcove(root.path(), &["capabilities"])).to_owned();
    assert!(capabilities.starts_with("Portcove "));
    assert!(capabilities.contains(" capabilities\nSchema: 36"));
}

struct OutputFixture {
    _capacity_guard: std::sync::MutexGuard<'static, ()>,
    _temporary: tempfile::TempDir,
    library: std::path::PathBuf,
    destination: std::path::PathBuf,
    preview: serde_json::Value,
}

impl OutputFixture {
    fn new() -> Self {
        let _capacity_guard = CAPACITY_SENSITIVE_TEST.lock().unwrap();
        let temporary = tempfile::tempdir().unwrap();
        let library = temporary.path().join("library");
        let destination = temporary.path().join("future-games");
        let destination_text = destination.to_str().unwrap();

        let preview = json_stdout(&portcove(
            &library,
            &[
                "--json",
                "output",
                "preview",
                "lighthouse",
                destination_text,
            ],
        ));
        assert_eq!(preview["command"], "output.preview");
        assert_eq!(preview["data"]["ownership"], "unclaimed");
        assert_eq!(preview["data"]["availability"], "available");
        assert_eq!(preview["data"]["moves_existing_install"], false);
        assert!(!destination.exists());
        Self {
            _capacity_guard,
            _temporary: temporary,
            library,
            destination,
            preview,
        }
    }

    fn apply(&self) {
        let library = &self.library;
        let destination = &self.destination;
        let destination_text = destination.to_str().unwrap();
        let preview = &self.preview;
        let fingerprint = preview["data"]["preview_sha256"].as_str().unwrap();
        let applied = json_stdout(&portcove(
            library,
            &[
                "--json",
                "output",
                "set",
                "lighthouse",
                destination_text,
                "--expected-preview",
                fingerprint,
                "--yes",
            ],
        ));
        assert_eq!(applied["command"], "output.set");
        assert_eq!(applied["ok"], true, "{applied}");
        assert_eq!(
            applied["data"]["effective_output_directory"],
            preview["data"]["proposed"]["effective_output_directory"]
        );
        assert!(!destination.exists());
    }
}

#[test]
fn output_preview_agrees_across_modes() {
    let fixture = OutputFixture::new();
    let library = &fixture.library;
    let destination_text = fixture.destination.to_str().unwrap();
    let fingerprint = fixture.preview["data"]["preview_sha256"].as_str().unwrap();
    let human_preview = human_stdout(&portcove(
        library,
        &["output", "preview", "lighthouse", destination_text],
    ))
    .to_owned();
    assert!(human_preview.starts_with("Export / install folder preview for lighthouse"));
    assert!(human_preview.contains(fingerprint));
    let jsonl_preview = json_stdout(&portcove(
        library,
        &[
            "--jsonl",
            "output",
            "preview",
            "lighthouse",
            destination_text,
        ],
    ));
    assert_eq!(jsonl_preview["type"], "result");
    assert_eq!(jsonl_preview["data"]["preview_sha256"], fingerprint);
}

#[test]
fn output_set_rejects_stale_review_and_show_agrees_across_modes() {
    let fixture = OutputFixture::new();
    let library = &fixture.library;
    let destination_text = fixture.destination.to_str().unwrap();
    let fingerprint = fixture.preview["data"]["preview_sha256"].as_str().unwrap();
    fixture.apply();
    let stale = portcove(
        library,
        &[
            "--json",
            "output",
            "set",
            "lighthouse",
            destination_text,
            "--expected-preview",
            fingerprint,
            "--yes",
        ],
    );
    assert_eq!(stale.status.code(), Some(14));
    assert_eq!(json_stdout(&stale)["error"]["code"], "conflict");

    let show = portcove(library, &["output", "show", "lighthouse"]);
    let human = human_stdout(&show);
    assert!(human.starts_with("Export / install folder for lighthouse\nEffective:"));
    assert!(human.contains("Existing installs are not moved"));
    let json_show = json_stdout(&portcove(
        library,
        &["--json", "output", "show", "lighthouse"],
    ));
    assert_eq!(json_show["command"], "output.show");
    let jsonl_show = json_stdout(&portcove(
        library,
        &["--jsonl", "output", "show", "lighthouse"],
    ));
    assert_eq!(jsonl_show["type"], "result");
    assert_eq!(jsonl_show["command"], "output.show");
}

#[test]
fn output_reapply_human_preserves_the_shared_contract() {
    let fixture = OutputFixture::new();
    let library = &fixture.library;
    let destination_text = fixture.destination.to_str().unwrap();
    fixture.apply();
    let set_again_preview = json_stdout(&portcove(
        library,
        &[
            "--json",
            "output",
            "preview",
            "lighthouse",
            destination_text,
        ],
    ));
    let set_again_fingerprint = set_again_preview["data"]["preview_sha256"]
        .as_str()
        .unwrap();
    let human_set = human_stdout(&portcove(
        library,
        &[
            "output",
            "set",
            "lighthouse",
            destination_text,
            "--expected-preview",
            set_again_fingerprint,
            "--yes",
        ],
    ))
    .to_owned();
    assert!(human_set.contains("existing installs will not move"));
}

#[test]
fn output_reapply_jsonl_preserves_the_shared_contract() {
    let fixture = OutputFixture::new();
    let library = &fixture.library;
    let destination_text = fixture.destination.to_str().unwrap();
    fixture.apply();
    let jsonl_set_preview = json_stdout(&portcove(
        library,
        &[
            "--json",
            "output",
            "preview",
            "lighthouse",
            destination_text,
        ],
    ));
    let jsonl_set_fingerprint = jsonl_set_preview["data"]["preview_sha256"]
        .as_str()
        .unwrap();
    let jsonl_set = json_stdout(&portcove(
        library,
        &[
            "--jsonl",
            "output",
            "set",
            "lighthouse",
            destination_text,
            "--expected-preview",
            jsonl_set_fingerprint,
            "--yes",
        ],
    ));
    assert_eq!(jsonl_set["type"], "result");
    assert_eq!(jsonl_set["command"], "output.set");
}

#[test]
fn output_reset_human_uses_the_reviewed_default() {
    let fixture = OutputFixture::new();
    let library = &fixture.library;
    fixture.apply();
    let reset_preview = json_stdout(&portcove(
        library,
        &["--jsonl", "output", "preview", "lighthouse"],
    ));
    assert_eq!(reset_preview["type"], "result");
    assert_eq!(reset_preview["data"]["reset_to_default"], true);
    let reset_fingerprint = reset_preview["data"]["preview_sha256"].as_str().unwrap();
    let human_reset = human_stdout(&portcove(
        library,
        &[
            "output",
            "reset",
            "lighthouse",
            "--expected-preview",
            reset_fingerprint,
            "--yes",
        ],
    ))
    .to_owned();
    assert!(human_reset.contains("existing installs will not move"));
}

#[test]
fn output_reset_jsonl_uses_the_reviewed_default() {
    let fixture = OutputFixture::new();
    let library = &fixture.library;
    fixture.apply();
    let jsonl_reset_preview = json_stdout(&portcove(
        library,
        &["--jsonl", "output", "preview", "lighthouse"],
    ));
    let jsonl_reset_fingerprint = jsonl_reset_preview["data"]["preview_sha256"]
        .as_str()
        .unwrap();
    let jsonl_reset = json_stdout(&portcove(
        library,
        &[
            "--jsonl",
            "output",
            "reset",
            "lighthouse",
            "--expected-preview",
            jsonl_reset_fingerprint,
            "--yes",
        ],
    ));
    assert_eq!(jsonl_reset["type"], "result");
    assert_eq!(jsonl_reset["command"], "output.reset");
}

#[test]
fn output_reset_json_uses_the_reviewed_default() {
    let fixture = OutputFixture::new();
    let library = &fixture.library;
    fixture.apply();
    let json_reset_preview = json_stdout(&portcove(
        library,
        &["--json", "output", "preview", "lighthouse"],
    ));
    let json_reset_fingerprint = json_reset_preview["data"]["preview_sha256"]
        .as_str()
        .unwrap();
    let reset = json_stdout(&portcove(
        library,
        &[
            "--json",
            "output",
            "reset",
            "lighthouse",
            "--expected-preview",
            json_reset_fingerprint,
            "--yes",
        ],
    ));
    assert_eq!(reset["command"], "output.reset");
    assert_eq!(reset["data"]["selection_source"], "library_default");
}

#[test]
fn capabilities_are_one_clean_versioned_json_document() {
    let root = tempfile::tempdir().unwrap();
    let output = portcove(root.path(), &["--json", "capabilities"]);

    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    let response = json_stdout(&output);
    assert_eq!(response["schema_version"], 36);
    assert_eq!(response["ok"], true);
    assert_eq!(response["command"], "capabilities");
    assert!(response["error"].is_null());
    assert_eq!(response["data"]["schema_version"], 36);
    assert_eq!(
        response["data"]["raw_stream_commands"],
        serde_json::json!(["exec"])
    );
    assert_eq!(
        response["data"]["product_version"],
        env!("CARGO_PKG_VERSION")
    );
}

#[test]
fn command_errors_keep_the_machine_envelope_and_stable_exit_code() {
    let root = tempfile::tempdir().unwrap();
    let output = portcove(
        root.path(),
        &["--json", "catalog", "show", "not-a-portcove-port"],
    );

    assert_eq!(output.status.code(), Some(4));
    assert!(output.stderr.is_empty());
    let response = json_stdout(&output);
    assert_eq!(response["schema_version"], 36);
    assert_eq!(response["ok"], false);
    assert_eq!(response["command"], "catalog.show");
    assert!(response["data"].is_null());
    assert_eq!(response["error"]["code"], "not_found");
}

#[test]
fn parser_errors_are_structured_for_machine_callers() {
    let root = tempfile::tempdir().unwrap();
    let library = root.path().join("must-not-be-opened");
    let output = portcove(&library, &["--json", "not-a-command"]);

    assert_eq!(output.status.code(), Some(2));
    assert!(output.stderr.is_empty());
    assert!(!library.exists());
    let response = json_stdout(&output);
    assert_eq!(response["schema_version"], 36);
    assert_eq!(response["ok"], false);
    assert_eq!(response["command"], "cli");
    assert_eq!(response["error"]["code"], "usage");
    assert!(
        response["error"]["message"]
            .as_str()
            .unwrap()
            .contains("unrecognized subcommand")
    );
}

#[test]
fn jsonl_read_commands_end_with_one_result_event() {
    let root = tempfile::tempdir().unwrap();
    let output = portcove(root.path(), &["--jsonl", "capabilities"]);

    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    let response = json_stdout(&output);
    assert_eq!(response["schema_version"], 36);
    assert_eq!(response["type"], "result");
    assert_eq!(response["ok"], true);
    assert_eq!(response["command"], "capabilities");
}

#[test]
fn exec_rejects_machine_output_before_starting_a_game() {
    let root = tempfile::tempdir().unwrap();
    let output = portcove(root.path(), &["--json", "exec", "lighthouse"]);

    assert_eq!(output.status.code(), Some(2));
    assert!(output.stderr.is_empty());
    let response = json_stdout(&output);
    assert_eq!(response["ok"], false);
    assert_eq!(response["command"], "exec");
    assert_eq!(response["error"]["code"], "usage");
    assert!(
        response["error"]["message"]
            .as_str()
            .unwrap()
            .contains("inherits the game's streams")
    );
}

#[test]
fn about_is_branded_for_people_and_structured_for_automation_without_opening_a_library() {
    let root = tempfile::tempdir().unwrap();
    let human_library = root.path().join("human-library");
    let human = portcove(&human_library, &["about"]);

    assert!(human.status.success());
    assert!(human.stderr.is_empty());
    assert!(!human_library.exists());
    let human_stdout = std::str::from_utf8(&human.stdout).unwrap();
    assert!(human_stdout.starts_with("Portcove "));
    assert!(human_stdout.contains("Native ports, kept current."));

    let machine_library = root.path().join("machine-library");
    let machine = portcove(&machine_library, &["--json", "about"]);

    assert!(machine.status.success());
    assert!(machine.stderr.is_empty());
    assert!(!machine_library.exists());
    let response = json_stdout(&machine);
    assert_eq!(response["ok"], true);
    assert_eq!(response["command"], "about");
    assert_eq!(response["data"]["product"], "Portcove");
}
