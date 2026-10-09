use super::*;
use std::fs;

#[test]
fn reviewed_preparation_runs_through_jsonl_and_a_fresh_cli_plays_without_setup() {
    preparation_roundtrip(false, false);
}

#[test]
fn reviewed_chd_conversion_retains_both_phases_through_fresh_cli_and_play() {
    preparation_roundtrip(true, false);
}

#[test]
fn lost_preparation_output_is_resolved_by_fresh_public_readback_without_replay() {
    preparation_roundtrip(false, true);
}

fn preparation_roundtrip(chd: bool, lose_output: bool) {
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
    if !chd {
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
    }
    let preparation_args = [
        "--jsonl",
        "--non-interactive",
        "preparation",
        "run",
        &port.id,
        "--expected-plan",
        fingerprint,
        "--yes",
    ];
    let prepared = if lose_output {
        portcove_core::ChildProcessPolicy::native_command(
            portcove_core::ChildProcessClass::HostIntegration,
            cli_binary(),
        )
        .unwrap()
        .env("PORTCOVE_PREFERENCES", &preferences)
        .env_remove("PORTCOVE_CHDMAN")
        .env_remove("PORTCOVE_DOLPHIN_TOOL")
        .arg("--library")
        .arg(&library)
        .args(preparation_args)
        .stdout(Stdio::null())
        .output()
        .expect("Portcove CLI should start")
    } else {
        portcove(&library, &preparation_args)
    };
    assert!(prepared.status.success(), "{prepared:?}");
    if lose_output {
        assert!(prepared.stdout.is_empty());
        let status = json_stdout(&portcove(&library, &["--json", "status", &port.id]));
        assert_eq!(status["data"]["previous"]["id"], original_id);
        assert_eq!(status["data"]["readiness"]["launchable"], true);
        let activity = json_stdout(&portcove(&library, &["--json", "activity"]));
        let preparation = activity["data"]["records"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|record| record["operation"] == "prepare")
            .collect::<Vec<_>>();
        assert_eq!(preparation.len(), 1, "{activity}");
        let preparation = preparation[0];
        assert_eq!(preparation["status"], "succeeded");
        assert_eq!(preparation["target_id"], port.id);
        let id = preparation["id"].as_str().unwrap();
        let logs = json_stdout(&portcove(&library, &["--json", "activity", "log", id]));
        let captures = logs["data"].as_array().unwrap();
        assert_eq!(captures.len(), 1);
        assert_eq!(captures[0]["phase"], "preparation.setup");
        assert_eq!(captures[0]["complete"], true);
        assert!(
            captures[0]["stdout"]["text"]
                .as_str()
                .unwrap()
                .contains("owned setup began")
        );
        assert!(!logs.to_string().contains("owned-fixture-private-value"));
        assert_eq!(
            json_stdout(&portcove(&library, &["--json", "status", &port.id])),
            status
        );
        assert_eq!(
            json_stdout(&portcove(&library, &["--json", "activity"])),
            activity
        );
        assert_eq!(
            fs::read(&source).unwrap(),
            b"owned source awaiting upstream validation"
        );
        assert!(original.is_dir());
        return;
    }
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
    assert!(log_json.status.success());
    let log_json = json_stdout(&log_json);
    assert_eq!(log_json["command"], "activity.log");
    if !chd {
        let log_jsonl = json_stdout(&portcove(&library, &["--jsonl", "activity", "log", id]));
        assert_eq!(log_json["data"], log_jsonl["data"]);
    }
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
    if !chd {
        let human_log = portcove(&library, &["activity", "log", id]);
        let human_log = String::from_utf8(human_log.stdout).unwrap();
        assert!(human_log.contains("Capture reached the end of both streams."));
        assert!(!human_log.contains("owned-fixture-private-value"));
    }
    assert_eq!(events.last().unwrap()["command"], "preparation.run");
    let status = json_stdout(&portcove(&library, &["--json", "status", &port.id]));
    assert_eq!(status["data"]["previous"]["id"], original_id);
    assert_eq!(status["data"]["readiness"]["launchable"], true);
    let installed = std::path::PathBuf::from(status["data"]["active"]["path"].as_str().unwrap());
    let log = installed.join("data/log/setup.log");
    fs::write(&log, b"setup must not run during CLI exec").unwrap();
    let played = if chd {
        portcove(&library, &["exec", &port.id])
    } else {
        super::launch_contract::observe_prepared_launch(&library, &preferences, &port.id)
    };
    assert!(played.status.success(), "{played:?}");
    assert!(String::from_utf8_lossy(&played.stdout).contains("owned game launched"));
    if !chd {
        super::launch_contract::recover_interrupted_prepared_launch(
            &library,
            &preferences,
            &port.id,
        );
    }
    assert_eq!(
        fs::read(log).unwrap(),
        b"setup must not run during CLI exec"
    );
}
