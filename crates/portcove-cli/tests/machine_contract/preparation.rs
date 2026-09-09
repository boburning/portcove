use super::*;
use std::fs;

#[test]
fn reviewed_preparation_runs_through_jsonl_and_a_fresh_cli_plays_without_setup() {
    let temporary = tempfile::tempdir().unwrap();
    let library = temporary.path().join("library");
    let original = temporary.path().join("owned-installation");
    fs::create_dir(&original).unwrap();
    let catalog = portcove_core::Catalog::embedded().unwrap();
    let port = catalog.port("opengoal-jak1").unwrap();
    let platform = portcove_core::Platform::current().unwrap();
    let executable = compile_native_fixture(temporary.path());
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
    let source = temporary.path().join("owned.iso");
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
