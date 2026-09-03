use std::process::{Command, Output};

use serde_json::Value;

struct RunningCli(std::process::Child);

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
        Command::new(env!("CARGO_BIN_EXE_portcove"))
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
    output.read_line(&mut started).unwrap();
    let started: Value = serde_json::from_str(&started).unwrap();
    assert_eq!(started["schema_version"], 2);
    assert_eq!(started["type"], "started");
    let id = started["operation_id"].as_str().unwrap();
    let cancelled = portcove(&library, &["--json", "cancel", id]);
    assert!(
        cancelled.status.success(),
        "{}",
        String::from_utf8_lossy(&cancelled.stdout)
    );
    assert_eq!(json_stdout(&cancelled)["data"]["requested"], true);
    let mut rest = String::new();
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
    let ledger = json_stdout(&portcove(&library, &["--json", "activity"]));
    assert_eq!(ledger["data"][0]["id"], id);
    assert_eq!(ledger["data"][0]["status"], "cancelled");
    assert_eq!(
        json_stdout(&portcove(&library, &["--json", "source", "list"]))["data"],
        serde_json::json!([])
    );
    assert_eq!(std::fs::metadata(source).unwrap().len(), 256 * 1024 * 1024);
}

fn portcove(library: &std::path::Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_portcove"))
        .arg("--library")
        .arg(library)
        .args(args)
        .output()
        .expect("Portcove CLI should start")
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

#[test]
fn library_import_is_read_only_until_reviewed_and_usable_by_a_fresh_cli() {
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
    let mut args = vec![
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
    let hash = document["data"]["plan_sha256"].as_str().unwrap();
    args.push("--apply");
    assert_eq!(portcove(&destination, &args).status.code(), Some(2));
    args.extend(["--expected-plan", hash]);
    let restored = portcove(&destination, &args);
    assert!(restored.status.success(), "{restored:?}");
    assert_eq!(json_stdout(&restored)["data"]["completed"], true);
    assert_eq!(
        std::fs::read(destination.join("user/example/save.bin")).unwrap(),
        b"synthetic save"
    );
    let fresh = portcove(&destination, &["--json", "library", "export"]);
    assert!(fresh.status.success());
    let resumed = portcove(&destination, &["--json", "library", "resume-import"]);
    assert!(resumed.status.success(), "{resumed:?}");
    assert_eq!(json_stdout(&resumed)["command"], "library.resume_import");
    assert!(
        !portcove(&destination, &["--json", "library", "abort-import"])
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
    assert_eq!(metadata["data"]["schema_version"], 1);
    assert_eq!(
        metadata["data"]["content_roots"].as_array().unwrap().len(),
        4
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
        1
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
    assert!(
        portcove(
            &library,
            &[
                "--json",
                "source",
                "add",
                "star-fox-64",
                original.to_str().unwrap()
            ]
        )
        .status
        .success()
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
fn default_read_commands_have_human_output_snapshots() {
    let root = tempfile::tempdir().unwrap();

    let catalog = human_stdout(&portcove(root.path(), &["catalog", "list"])).to_owned();
    assert!(catalog.starts_with("Ports ("));
    assert!(catalog.contains("ID"));
    assert!(catalog.contains("lighthouse"));
    assert!(!catalog.trim_start().starts_with('['));

    let status = human_stdout(&portcove(root.path(), &["status", "lighthouse"])).to_owned();
    assert!(status.starts_with("Status (1)\nPORT"));
    assert!(status.contains("lighthouse"));
    assert!(status.contains("stable"));
    assert!(!status.trim_start().starts_with('{'));

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

    let paths = human_stdout(&portcove(root.path(), &["paths", "lighthouse"])).to_owned();
    assert!(paths.starts_with("Paths for lighthouse\nLibrary:"));
    assert!(paths.contains("\nPersistent data:"));

    let storage = human_stdout(&portcove(root.path(), &["storage"])).to_owned();
    assert!(storage.starts_with("Library storage\nRoot:"));
    assert!(storage.contains("\nAvailable:"));

    let doctor = human_stdout(&portcove(root.path(), &["doctor"])).to_owned();
    assert!(doctor.starts_with("Portcove doctor\nPlatform:"));
    assert!(doctor.contains("\nRepair review: no items"));

    let port = human_stdout(&portcove(root.path(), &["catalog", "show", "lighthouse"])).to_owned();
    assert!(port.starts_with("Lighthouse (lighthouse)\nSupport:"));
    assert!(port.contains("\nProject: https://"));

    let capabilities = human_stdout(&portcove(root.path(), &["capabilities"])).to_owned();
    assert!(capabilities.starts_with("Portcove "));
    assert!(capabilities.contains(" capabilities\nSchema: 10"));
}

#[test]
fn capabilities_are_one_clean_versioned_json_document() {
    let root = tempfile::tempdir().unwrap();
    let output = portcove(root.path(), &["--json", "capabilities"]);

    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    let response = json_stdout(&output);
    assert_eq!(response["schema_version"], 10);
    assert_eq!(response["ok"], true);
    assert_eq!(response["command"], "capabilities");
    assert!(response["error"].is_null());
    assert_eq!(response["data"]["schema_version"], 10);
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
    assert_eq!(response["schema_version"], 10);
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
    assert_eq!(response["schema_version"], 10);
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
    assert_eq!(response["schema_version"], 10);
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
