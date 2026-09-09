use super::*;
use std::fs;

#[test]
fn reviewed_preparation_runs_through_jsonl_and_a_fresh_cli_plays_without_setup() {
    preparation_roundtrip(false);
}

#[test]
fn reviewed_chd_conversion_retains_both_phases_through_fresh_cli_and_play() {
    preparation_roundtrip(true);
}

fn preparation_roundtrip(chd: bool) {
    let temporary = tempfile::tempdir().unwrap();
    let library = temporary.path().join("library");
    let original = temporary.path().join("owned-installation");
    fs::create_dir(&original).unwrap();
    let catalog = portcove_core::Catalog::embedded().unwrap();
    let port = catalog.port("opengoal-jak1").unwrap();
    let platform = portcove_core::Platform::current().unwrap();
    let executable = compile_native_fixture(temporary.path());
    let preferences = temporary.path().join("preferences.json");
    let portcove =
        |library: &std::path::Path, args: &[&str]| portcove_tool(&preferences, library, args);
    if chd {
        let configured = portcove(
            &library,
            &[
                "--json",
                "tool",
                "set-path",
                "chdman",
                executable.to_str().unwrap(),
            ],
        );
        assert!(configured.status.success(), "{configured:?}");
    }
    for relative in [
        &port.executable_hints[&platform][0],
        &port.setup_executable_hints[&platform][0],
    ] {
        let destination = original.join(relative);
        fs::create_dir_all(destination.parent().unwrap()).unwrap();
        fs::copy(&executable, destination).unwrap();
    }
    fs::write(original.join("owned-setup-mode"), "success").unwrap();
    let adopted = portcove(
        &library,
        &[
            "--json",
            "--non-interactive",
            "adopt",
            original.to_str().unwrap(),
            "--port",
            &port.id,
            "--yes",
        ],
    );
    assert!(adopted.status.success(), "{adopted:?}");
    let original_id = json_stdout(&adopted)["data"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let source = temporary
        .path()
        .join(if chd { "owned.chd" } else { "owned.iso" });
    fs::write(&source, b"owned source awaiting upstream validation").unwrap();
    let added = portcove(
        &library,
        &[
            "--json",
            "source",
            "add",
            port.source_profile.as_deref().unwrap(),
            source.to_str().unwrap(),
        ],
    );
    assert!(added.status.success(), "{added:?}");
    let plan = json_stdout(&portcove(
        &library,
        &["--json", "preparation", "plan", &port.id],
    ));
    let fingerprint = plan["data"]["plan_sha256"].as_str().unwrap();
    let denied = portcove(
        &library,
        &[
            "--json",
            "--non-interactive",
            "preparation",
            "run",
            &port.id,
            "--expected-plan",
            fingerprint,
        ],
    );
    assert_eq!(denied.status.code(), Some(2));
    assert_eq!(json_stdout(&denied)["command"], "preparation.run");
    let stale = portcove(
        &library,
        &[
            "--json",
            "--non-interactive",
            "preparation",
            "run",
            &port.id,
            "--expected-plan",
            "stale-plan",
            "--yes",
        ],
    );
    assert_eq!(json_stdout(&stale)["error"]["code"], "conflict");
    let prepared = portcove(
        &library,
        &[
            "--jsonl",
            "--non-interactive",
            "preparation",
            "run",
            &port.id,
            "--expected-plan",
            fingerprint,
            "--yes",
        ],
    );
    assert!(prepared.status.success(), "{prepared:?}");
    let events = String::from_utf8(prepared.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert!(
        events
            .iter()
            .any(|event| event["type"] == "started" && event["operation"] == "prepare")
    );
    assert!(events.iter().any(|event| event["type"] == "finished"));
    let id = events
        .iter()
        .find(|event| event["type"] == "started" && event["operation"] == "prepare")
        .unwrap()["operation_id"]
        .as_str()
        .unwrap();
    let log_json = portcove(&library, &["--json", "activity", "log", id]);
    let log_jsonl = portcove(&library, &["--jsonl", "activity", "log", id]);
    assert!(log_json.status.success() && log_jsonl.status.success());
    let log_json = json_stdout(&log_json);
    let log_jsonl = json_stdout(&log_jsonl);
    assert_eq!(log_json["command"], "activity.log");
    assert_eq!(log_json["data"], log_jsonl["data"]);
    let captures = log_json["data"].as_array().unwrap();
    assert_eq!(captures.len(), if chd { 2 } else { 1 });
    if chd {
        assert_eq!(captures[0]["phase"], "preparation.extract");
        assert_eq!(captures[0]["complete"], true);
        assert!(
            captures[0]["stdout"]["text"]
                .as_str()
                .unwrap()
                .contains("owned conversion began")
        );
        assert!(!log_json.to_string().contains("owned-conversion-secret"));
    }
    let setup = captures.last().unwrap();
    assert_eq!(setup["phase"], "preparation.setup");
    assert_eq!(setup["complete"], true);
    assert!(
        setup["stdout"]["text"]
            .as_str()
            .unwrap()
            .contains("owned setup began")
    );
    assert!(!log_json.to_string().contains("owned-fixture-private-value"));
    let capture = portcove_core::Library::open(&library)
        .unwrap()
        .activity_diagnostic(id)
        .unwrap();
    assert_eq!(log_json["data"], serde_json::to_value(capture).unwrap());
    let human_log = portcove(&library, &["activity", "log", id]);
    let human_log = String::from_utf8(human_log.stdout).unwrap();
    assert!(human_log.contains("Capture reached the end of both streams."));
    assert!(!human_log.contains("owned-fixture-private-value"));
    assert_eq!(events.last().unwrap()["command"], "preparation.run");
    let status = json_stdout(&portcove(&library, &["--json", "status", &port.id]));
    assert_eq!(status["data"]["previous"]["id"], original_id);
    assert_eq!(status["data"]["readiness"]["launchable"], true);
    let installed = std::path::PathBuf::from(status["data"]["active"]["path"].as_str().unwrap());
    let log = installed.join("data/log/setup.log");
    fs::write(&log, b"setup must not run during CLI exec").unwrap();
    let played = portcove(&library, &["exec", &port.id]);
    assert!(played.status.success(), "{played:?}");
    assert!(String::from_utf8_lossy(&played.stdout).contains("owned game launched"));
    assert_eq!(
        fs::read(log).unwrap(),
        b"setup must not run during CLI exec"
    );
}
