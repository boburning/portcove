use super::*;
use std::fs;

#[test]
fn reviewed_preparation_runs_through_jsonl_and_a_fresh_cli_plays_without_setup() {
    preparation_roundtrip(false, false, None);
}

#[test]
fn reviewed_chd_conversion_retains_both_phases_through_fresh_cli_and_play() {
    preparation_roundtrip(true, false, None);
}

#[test]
fn lost_preparation_output_is_resolved_by_fresh_public_readback_without_replay() {
    preparation_roundtrip(false, true, None);
}

#[test]
fn reusable_preparation_qualification_runs_real_cli_iso_case() {
    preparation_roundtrip(false, false, Some("opengoal-jak1"));
}

#[test]
fn reusable_preparation_qualification_uses_same_sequence_for_another_port_and_chd() {
    preparation_roundtrip(true, false, Some("opengoal-jak2"));
}

fn preparation_roundtrip(chd: bool, lose_output: bool, reuse_port: Option<&str>) {
    let started = std::time::Instant::now();
    let phase = |name: &str| {
        eprintln!(
            "preparation-roundtrip chd={chd} lose_output={lose_output} phase={name} elapsed_ms={}",
            started.elapsed().as_millis()
        );
    };
    phase("fixture-begin");
    let temporary = tempfile::tempdir().unwrap();
    let library = temporary.path().join("library");
    let original = temporary.path().join("owned-installation");
    fs::create_dir(&original).unwrap();
    let catalog = portcove_core::Catalog::embedded().unwrap();
    let port = catalog.port(reuse_port.unwrap_or("opengoal-jak1")).unwrap();
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
    phase("fixture-end");
    phase("adoption-begin");
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
    phase("adoption-end");
    phase("source-plan-begin");
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
    phase("source-plan-end");
    if !chd {
        phase("refusal-controls-begin");
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
        phase("refusal-controls-end");
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
    phase("preparation-begin");
    let prepared = if reuse_port.is_some() {
        let case_path = temporary.path().join("preparation-case.json");
        let plan_path = temporary.path().join("core-plan.json");
        let report_path = temporary.path().join("qualification-report");
        fs::write(&plan_path, serde_json::to_vec(&plan["data"]).unwrap()).unwrap();
        let created = Command::new("node")
            .args([
                "--input-type=module",
                "-e",
                r#"
                import fs from 'node:fs';
                import {createHash} from 'node:crypto';
                const [cli, plan, output] = process.argv.slice(1);
                fs.writeFileSync(output, JSON.stringify({format_version:1,evidence_kind:'synthetic',
                  cli_sha256:createHash('sha256').update(fs.readFileSync(cli)).digest('hex'),
                  environment:{platform:process.platform,arch:process.arch,node:process.version},
                  plan:JSON.parse(fs.readFileSync(plan,'utf8'))}), {flag:'wx'});
            "#,
            ])
            .arg(cli_binary())
            .arg(&plan_path)
            .arg(&case_path)
            .output()
            .unwrap();
        assert!(created.status.success(), "{created:?}");
        let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../scripts/qualification-report.mts");
        let observed = Command::new("node")
            .arg(script)
            .arg("--cli")
            .arg(cli_binary())
            .arg("--library")
            .arg(&library)
            .arg("--output")
            .arg(&report_path)
            .arg("--preparation-case")
            .arg(&case_path)
            .env("PORTCOVE_PREFERENCES", &preferences)
            .env_remove("PORTCOVE_CHDMAN")
            .env_remove("PORTCOVE_DOLPHIN_TOOL")
            .output()
            .unwrap();
        assert!(
            observed.status.success(),
            "{observed:?}; retained at {report_path:?}"
        );
        let receipt: Value =
            serde_json::from_slice(&fs::read(report_path.join("sequence.json")).unwrap()).unwrap();
        assert_eq!(receipt["result"], "passed");
        assert_eq!(receipt["evidence_kind"], "synthetic");
        assert_eq!(receipt["operation_inputs"], plan["data"]["inputs"]);
        assert_eq!(receipt["manual_observations"]["gameplay"], Value::Null);
        let step: Value =
            serde_json::from_slice(&fs::read(report_path.join("preparation-run.json")).unwrap())
                .unwrap();
        let stdout = step["response"]
            .as_array()
            .unwrap()
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n")
            .into_bytes();
        Output { stdout, ..observed }
    } else if lose_output {
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
    phase("preparation-end");
    if lose_output {
        phase("lost-output-readbacks-begin");
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
        phase("lost-output-readbacks-end");
        return;
    }
    phase("diagnostic-readbacks-begin");
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
        assert!(human_log.contains("Both output streams ended. Saved output is shown below."));
        assert!(!human_log.contains("owned-fixture-private-value"));
    }
    assert_eq!(events.last().unwrap()["command"], "preparation.run");
    phase("diagnostic-readbacks-end");
    phase("fresh-status-begin");
    let status = json_stdout(&portcove(&library, &["--json", "status", &port.id]));
    assert_eq!(status["data"]["previous"]["id"], original_id);
    assert_eq!(status["data"]["readiness"]["launchable"], true);
    let installed = std::path::PathBuf::from(status["data"]["active"]["path"].as_str().unwrap());
    let log = installed.join("data/log/setup.log");
    fs::write(&log, b"setup must not run during CLI exec").unwrap();
    phase("fresh-status-end");
    phase("launch-observation-begin");
    let played = if chd {
        portcove(&library, &["exec", &port.id])
    } else {
        super::launch_contract::observe_prepared_launch(&library, &preferences, &port.id)
    };
    assert!(played.status.success(), "{played:?}");
    assert!(String::from_utf8_lossy(&played.stdout).contains("owned game launched"));
    phase("launch-observation-end");
    if !chd {
        phase("interrupted-launch-recovery-begin");
        super::launch_contract::recover_interrupted_prepared_launch(
            &library,
            &preferences,
            &port.id,
        );
        phase("interrupted-launch-recovery-end");
    }
    assert_eq!(
        fs::read(log).unwrap(),
        b"setup must not run during CLI exec"
    );
    phase("complete");
}
