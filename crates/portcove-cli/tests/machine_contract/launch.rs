use super::*;
use std::{
    fs,
    path::Path,
    process::Child,
    thread,
    time::{Duration, Instant},
};

const REQUEST: &str = "19C66CF0-656F-4A02-9C0B-DBA89767AB4E";
const RECOVERY_REQUEST: &str = "8D7F7B8B-3632-4C77-8B14-3FC8C338D9C3";

#[test]
fn launch_observation_is_versioned_nullable_and_rejects_invalid_ids_before_opening() {
    let temporary = tempfile::tempdir().unwrap();
    let library = temporary.path().join("library");
    for args in [
        vec!["--json", "launch", "show", "not-a-uuid"],
        vec!["--json", "launch", "recover", "not-a-uuid"],
        vec![
            "--json",
            "exec",
            "opengoal-jak1",
            "--request-id",
            "not-a-uuid",
        ],
    ] {
        let invalid = portcove(&library, &args);
        assert_eq!(invalid.status.code(), Some(2));
        assert_eq!(json_stdout(&invalid)["error"]["code"], "usage");
        assert!(!library.exists());
    }
    let absent = json_stdout(&portcove(&library, &["--json", "launch", "show", REQUEST]));
    assert_eq!(absent["schema_version"], portcove_core::API_SCHEMA_VERSION);
    assert_eq!(absent["command"], "launch.show");
    assert_eq!(absent["ok"], true);
    assert!(absent["data"].is_null());
    let stream = json_stdout(&portcove(&library, &["--jsonl", "launch", "show", REQUEST]));
    assert_eq!(stream["type"], "result");
    assert_eq!(stream["data"], absent["data"]);
    let capabilities = json_stdout(&portcove(&library, &["--json", "capabilities"]));
    assert!(
        capabilities["data"]["commands"]
            .as_array()
            .unwrap()
            .contains(&serde_json::json!("launch.show"))
    );
    assert!(
        capabilities["data"]["commands"]
            .as_array()
            .unwrap()
            .contains(&serde_json::json!("launch.recover"))
    );
    let schema = json_stdout(&portcove(
        &library,
        &["--json", "schema", "export", "--contract", "output"],
    ));
    assert!(schema["data"]["launch_request"].is_object());
}

pub(super) fn recover_interrupted_prepared_launch(
    library: &Path,
    preferences: &Path,
    port_id: &str,
) {
    let release = library
        .parent()
        .unwrap()
        .join("release-interrupted-owned-game");
    let read = || {
        json_stdout(&portcove_tool(
            preferences,
            library,
            &["--json", "launch", "show", RECOVERY_REQUEST],
        ))
    };
    let mut supervisor = portcove_core::ChildProcessPolicy::native_command(
        portcove_core::ChildProcessClass::HostIntegration,
        cli_binary(),
    )
    .unwrap()
    .env("PORTCOVE_PREFERENCES", preferences)
    .arg("--library")
    .arg(library)
    .args([
        "--non-interactive",
        "exec",
        port_id,
        "--request-id",
        RECOVERY_REQUEST,
        "--",
        "--owned-wait",
    ])
    .arg(&release)
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .spawn()
    .unwrap();
    let deadline = Instant::now() + Duration::from_secs(8);
    let running = loop {
        let observed = read();
        if observed["data"]["phase"] == "running" {
            break observed["data"].clone();
        }
        assert!(
            supervisor.try_wait().unwrap().is_none(),
            "launch ended before interruption: {observed}"
        );
        assert!(
            Instant::now() < deadline,
            "interrupted launch observation timed out: {observed}"
        );
        thread::sleep(Duration::from_millis(20));
    };
    let child_pid = running["child_pid"].as_u64().unwrap();
    supervisor.kill().unwrap();
    fs::write(&release, b"finish interrupted owned game").unwrap();
    let interrupted = supervisor.wait_with_output().unwrap();
    assert!(!interrupted.status.success());

    let recovered = portcove_tool(
        preferences,
        library,
        &["--json", "launch", "recover", RECOVERY_REQUEST],
    );
    assert!(recovered.status.success(), "{recovered:?}");
    let recovered = json_stdout(&recovered);
    assert_eq!(
        recovered["schema_version"],
        portcove_core::API_SCHEMA_VERSION
    );
    assert_eq!(recovered["command"], "launch.recover");
    assert_eq!(
        recovered["data"]["id"],
        RECOVERY_REQUEST.to_ascii_lowercase()
    );
    assert_eq!(recovered["data"]["port_id"], port_id);
    assert_eq!(recovered["data"]["child_pid"], child_pid);
    // Core persists collection after verified child exit so failed collection is retryable.
    assert_eq!(recovered["data"]["phase"], "collecting");
    assert_eq!(recovered["data"]["outcome"], "failed");
    assert!(recovered["data"]["finished_at"].as_i64().is_some());
    assert!(recovered["data"]["exit_code"].is_null());
    assert!(
        recovered["data"]["message"]
            .as_str()
            .unwrap()
            .contains("recorded session was recovered")
    );
    assert_eq!(read()["data"], recovered["data"]);
    let replay = portcove_tool(
        preferences,
        library,
        &["--json", "launch", "recover", RECOVERY_REQUEST],
    );
    assert_eq!(replay.status.code(), Some(4));
    assert_eq!(json_stdout(&replay)["error"]["code"], "not_found");
}

pub(super) fn observe_prepared_launch(library: &Path, preferences: &Path, port_id: &str) -> Output {
    let release = library.parent().unwrap().join("release-owned-game");
    let read = || {
        json_stdout(&portcove_tool(
            preferences,
            library,
            &["--json", "launch", "show", REQUEST],
        ))
    };
    assert!(read()["data"].is_null());
    let child = portcove_core::ChildProcessPolicy::native_command(
        portcove_core::ChildProcessClass::HostIntegration,
        cli_binary(),
    )
    .unwrap()
    .env("PORTCOVE_PREFERENCES", preferences)
    .arg("--library")
    .arg(library)
    .args([
        "--non-interactive",
        "exec",
        port_id,
        "--request-id",
        REQUEST,
        "--",
        "--owned-wait",
    ])
    .arg(&release)
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .spawn()
    .unwrap();
    let mut owned = OwnedLaunch {
        child: Some(child),
        release,
    };
    let deadline = Instant::now() + Duration::from_secs(8);
    let running = loop {
        let observed = read();
        if observed["data"]["phase"] == "running" {
            break observed["data"].clone();
        }
        assert!(
            owned.child.as_mut().unwrap().try_wait().unwrap().is_none(),
            "launch ended before running observation: {observed}"
        );
        assert!(
            Instant::now() < deadline,
            "launch observation timed out: {observed}"
        );
        thread::sleep(Duration::from_millis(20));
    };
    assert_eq!(running["id"], REQUEST.to_ascii_lowercase());
    assert_eq!(running["port_id"], port_id);
    assert_eq!(
        running["supervisor_pid"],
        owned.child.as_ref().unwrap().id()
    );
    assert!(running["child_pid"].as_u64().is_some());
    assert!(running["outcome"].is_null());
    assert_eq!(
        running["install_id"],
        json_stdout(&portcove_tool(
            preferences,
            library,
            &["--json", "status", port_id]
        ))["data"]["active"]["id"]
    );
    fs::write(&owned.release, b"finish owned game").unwrap();
    let output = owned.child.take().unwrap().wait_with_output().unwrap();
    assert!(output.status.success(), "{output:?}");
    assert!(String::from_utf8_lossy(&output.stdout).contains("owned game launched"));
    let finished = read();
    assert_eq!(finished["data"]["outcome"], "succeeded");
    assert_eq!(finished["data"]["exit_code"], 0);
    assert!(finished["data"]["finished_at"].as_i64().is_some());
    assert_eq!(finished["data"]["install_id"], running["install_id"]);
    let replay = portcove_tool(
        preferences,
        library,
        &["exec", port_id, "--request-id", REQUEST],
    );
    assert!(!replay.status.success());
    assert!(!String::from_utf8_lossy(&replay.stdout).contains("owned game launched"));
    assert_eq!(
        read(),
        finished,
        "reusing a completed request must not replace its outcome"
    );
    output
}

struct OwnedLaunch {
    child: Option<Child>,
    release: std::path::PathBuf,
}

impl Drop for OwnedLaunch {
    fn drop(&mut self) {
        let _ = fs::write(&self.release, b"release fixture after test failure");
        if let Some(child) = self.child.as_mut() {
            let deadline = Instant::now() + Duration::from_secs(5);
            while matches!(child.try_wait(), Ok(None)) && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(20));
            }
            if matches!(child.try_wait(), Ok(None)) {
                let _ = child.kill();
            }
            let _ = child.wait();
        }
    }
}

#[test]
fn launch_show_explains_only_failed_sessions_and_never_invents_a_cause() {
    let temporary = tempfile::tempdir().unwrap();
    let library = temporary.path().join("library");
    drop(portcove_core::Library::open(&library).unwrap());
    let database = rusqlite::Connection::open(library.join("portcove.sqlite3")).unwrap();
    let cases = [
        (
            "11111111-1111-4111-8111-111111111111",
            "failed",
            -1_073_741_515_i32,
        ),
        ("22222222-2222-4222-8222-222222222222", "failed", 3),
        ("33333333-3333-4333-8333-333333333333", "succeeded", 0),
        ("44444444-4444-4444-8444-444444444444", "cancelled", 1),
    ];
    for (id, outcome, exit_code) in cases {
        database
            .execute(
                "INSERT INTO launch_sessions(
                   id, port_id, install_id, install_root, supervisor_pid, phase, outcome,
                   exit_code, started_at, updated_at, finished_at, owner_kind
                 ) VALUES (?1, 'zelda64-recomp', 'install', '/install', 1, 'running', ?2,
                           ?3, 1, 2, 2, 'managed')",
                rusqlite::params![id, outcome, exit_code],
            )
            .unwrap();
    }
    let show = |id: &str| json_stdout(&portcove(&library, &["--json", "launch", "show", id]));

    let missing_dll = show(cases[0].0);
    let explanation = &missing_dll["data"]["exit_explanation"];
    assert_eq!(explanation["key"], "dll_not_found");
    assert_eq!(explanation["raw_code"], "0xC0000135");
    assert!(
        explanation["explanation"]
            .as_str()
            .unwrap()
            .contains("most likely")
    );
    assert_eq!(missing_dll["data"]["exit_code"], -1_073_741_515);
    assert_eq!(missing_dll["data"]["outcome"], "failed");

    let unmapped = show(cases[1].0);
    assert_eq!(
        unmapped["data"]["exit_explanation"]["key"],
        "unexplained_exit"
    );
    assert_eq!(unmapped["data"]["exit_explanation"]["raw_code"], "3");

    for (id, _, _) in &cases[2..] {
        let quiet = show(id);
        assert!(quiet["data"].is_object());
        assert!(quiet["data"].get("exit_explanation").is_none(), "{quiet}");
    }
}
