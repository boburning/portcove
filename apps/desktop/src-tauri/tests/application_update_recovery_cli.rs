use std::fs;
use std::path::Path;
use std::process::{Command, Output};

fn run(executable: &str, root: &Path, arguments: &[&str]) -> Output {
    Command::new(executable)
        .args(arguments)
        .env(
            "PORTCOVE_APPLICATION_UPDATE_PREFERENCES",
            root.join("preferences.json"),
        )
        .env(
            "PORTCOVE_APPLICATION_UPDATE_SCHEDULE",
            root.join("schedule.json"),
        )
        .env("PORTCOVE_APPLICATION_UPDATE_STAGING", root.join("staging"))
        .output()
        .expect("recovery command should run")
}

fn stdout(output: &Output) -> String {
    String::from_utf8(output.stdout.clone()).expect("stdout should be UTF-8")
}

fn stderr(output: &Output) -> String {
    String::from_utf8(output.stderr.clone()).expect("stderr should be UTF-8")
}

#[test]
fn packaged_entry_point_reports_and_repairs_only_named_invalid_state() {
    let executable = env!("CARGO_BIN_EXE_portcove-desktop");
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path();
    let staging = root.join("staging");
    fs::create_dir_all(&staging).unwrap();
    fs::write(root.join("preferences.json"), b"not-json").unwrap();
    fs::write(root.join("schedule.json"), b"not-json").unwrap();
    fs::write(staging.join("staging.json"), b"not-json").unwrap();
    fs::write(staging.join("apply.json"), b"not-json").unwrap();
    let payload_name = if cfg!(windows) {
        "candidate-installer.exe"
    } else {
        "candidate.payload"
    };
    fs::write(staging.join(payload_name), b"untrusted-junk").unwrap();

    let status = run(
        executable,
        root,
        &["--application-update-recovery", "status"],
    );
    assert_eq!(status.status.code(), Some(1), "{}", stderr(&status));
    let status_output = stdout(&status);
    for area in ["preferences", "schedule", "staging", "apply"] {
        assert!(status_output.contains(&format!("repair {area}")));
    }
    assert!(!status_output.contains(&root.display().to_string()));

    for area in ["preferences", "schedule", "staging", "apply"] {
        let repaired = run(
            executable,
            root,
            &["--application-update-recovery", "repair", area],
        );
        assert_eq!(repaired.status.code(), Some(0), "{}", stderr(&repaired));
        assert!(stdout(&repaired).contains("No update check, download, install, restart"));
    }

    assert!(!staging.join(payload_name).exists());
    let preferences: serde_json::Value =
        serde_json::from_slice(&fs::read(root.join("preferences.json")).unwrap()).unwrap();
    assert_eq!(preferences["choice"], serde_json::Value::Null);

    let healthy = run(
        executable,
        root,
        &["--application-update-recovery", "status"],
    );
    assert_eq!(healthy.status.code(), Some(0), "{}", stderr(&healthy));
    assert!(stdout(&healthy).contains("coordination state is healthy"));

    let stale_repair = run(
        executable,
        root,
        &["--application-update-recovery", "repair", "preferences"],
    );
    assert_eq!(stale_repair.status.code(), Some(1));
    assert!(stderr(&stale_repair).contains("does not require repair"));
}

#[test]
fn malformed_recovery_command_exits_without_starting_the_gui() {
    let executable = env!("CARGO_BIN_EXE_portcove-desktop");
    let temporary = tempfile::tempdir().unwrap();
    let output = run(
        executable,
        temporary.path(),
        &["--application-update-recovery", "repair", "all"],
    );

    assert_eq!(output.status.code(), Some(2));
    assert!(stderr(&output).contains("Usage:"));
}
