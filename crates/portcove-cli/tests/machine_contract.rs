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

#[test]
fn capabilities_are_one_clean_versioned_json_document() {
    let root = tempfile::tempdir().unwrap();
    let output = portcove(root.path(), &["--json", "capabilities"]);

    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    let response = json_stdout(&output);
    assert_eq!(response["schema_version"], 2);
    assert_eq!(response["ok"], true);
    assert_eq!(response["command"], "capabilities");
    assert!(response["error"].is_null());
    assert_eq!(response["data"]["schema_version"], 2);
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
    assert_eq!(response["schema_version"], 2);
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
    assert_eq!(response["schema_version"], 2);
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
    assert_eq!(response["schema_version"], 2);
    assert_eq!(response["type"], "result");
    assert_eq!(response["ok"], true);
    assert_eq!(response["command"], "capabilities");
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
