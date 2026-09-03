use std::process::{Command, Output};

use serde_json::Value;

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
    assert!(applied.status.success(), "{:?}", applied);
    let result = json_stdout(&applied);
    assert_eq!(result["command"], "source.relink");
    assert_eq!(result["data"]["path"], relocated.to_str().unwrap());
    assert_eq!(result["data"]["sha256"], plan["data"]["original"]["sha256"]);
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
    assert!(capabilities.contains(" capabilities\nSchema: 4"));
}

#[test]
fn capabilities_are_one_clean_versioned_json_document() {
    let root = tempfile::tempdir().unwrap();
    let output = portcove(root.path(), &["--json", "capabilities"]);

    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    let response = json_stdout(&output);
    assert_eq!(response["schema_version"], 4);
    assert_eq!(response["ok"], true);
    assert_eq!(response["command"], "capabilities");
    assert!(response["error"].is_null());
    assert_eq!(response["data"]["schema_version"], 4);
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
    assert_eq!(response["schema_version"], 4);
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
    assert_eq!(response["schema_version"], 4);
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
    assert_eq!(response["schema_version"], 4);
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
