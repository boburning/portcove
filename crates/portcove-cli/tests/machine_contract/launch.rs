use super::*;
use std::{
    fs,
    path::Path,
    process::Child,
    thread,
    time::{Duration, Instant},
};

const REQUEST: &str = "19C66CF0-656F-4A02-9C0B-DBA89767AB4E";

#[test]
fn launch_observation_is_versioned_nullable_and_rejects_invalid_ids_before_opening() {
    let temporary = tempfile::tempdir().unwrap();
    let library = temporary.path().join("library");
    for args in [
        vec!["--json", "launch", "show", "not-a-uuid"],
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
    assert_eq!(absent["schema_version"], 44);
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
    let schema = json_stdout(&portcove(
        &library,
        &["--json", "schema", "export", "--contract", "output"],
    ));
    assert!(schema["data"]["launch_request"].is_object());
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
