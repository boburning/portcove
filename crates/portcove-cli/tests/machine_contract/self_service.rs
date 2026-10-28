use super::{compile_native_fixture, json_stdout, portcove};
use serde_json::Value;

#[test]
fn broad_listing_inspection_is_inert_and_does_not_accept_operational_fields() {
    let root = tempfile::tempdir().unwrap();
    let library = root.path().join("must-not-be-opened");
    let input = root.path().join("listings.json");
    let document = serde_json::json!({"format_version":1,"listings":[{
        "id":"inert-project","name":"Inert project","summary":"A descriptive project.",
        "project_url":"https://github.com/example/project","platforms":[],"availability":"unknown"
    }]});
    std::fs::write(&input, document.to_string()).unwrap();
    let inspected = portcove(
        &library,
        &[
            "--json",
            "catalog",
            "inspect-listings",
            "--path",
            input.to_str().unwrap(),
        ],
    );
    assert!(inspected.status.success(), "{inspected:?}");
    assert_eq!(json_stdout(&inspected)["data"], document);
    assert!(!library.exists());
    let mut unsafe_document = document;
    unsafe_document["listings"][0]["launch_arguments"] = serde_json::json!(["--run"]);
    std::fs::write(&input, unsafe_document.to_string()).unwrap();
    let refused = portcove(
        &library,
        &[
            "--json",
            "catalog",
            "inspect-listings",
            "--path",
            input.to_str().unwrap(),
        ],
    );
    assert!(!refused.status.success());
    assert!(!library.exists());
}

#[test]
fn listing_only_selected_runtime_survives_cli_restart_relink_and_registration_removal() {
    let root = tempfile::tempdir().unwrap();
    let library = root.path().join("Selected library ü 日本語");
    let runtime = root.path().join("User owned game ü 日本語");
    std::fs::create_dir(&runtime).unwrap();
    let executable = compile_native_fixture(&runtime);
    let replacement = runtime.join(if cfg!(windows) {
        "updated-game.exe"
    } else {
        "updated-game"
    });
    std::fs::copy(&executable, &replacement).unwrap();
    let sentinel = runtime.join("player-save.dat");
    std::fs::write(&sentinel, b"player save stays in place").unwrap();
    // Keep a listing without an operational integration for launch-only registration.
    // This local native fixture is not an upstream package or gameplay observation.
    let port = "openra-openra";
    let listings = portcove(&library, &["--json", "catalog", "listings"]);
    assert!(listings.status.success(), "{listings:?}");
    assert!(
        json_stdout(&listings)["data"]["listings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["id"] == port)
    );
    let strict = json_stdout(&portcove(&library, &["--json", "catalog", "export"]));
    assert!(
        !strict["data"]["ports"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["id"] == port)
    );

    let review = portcove(
        &library,
        &[
            "--json",
            "external",
            "select-preview",
            port,
            executable.to_str().unwrap(),
            "--working-directory",
            runtime.to_str().unwrap(),
            "--arg=--help",
        ],
    );
    assert!(review.status.success(), "{review:?}");
    let hash = json_stdout(&review)["data"]["preview_sha256"]
        .as_str()
        .unwrap()
        .to_owned();
    let registered = portcove(
        &library,
        &[
            "--json",
            "--non-interactive",
            "external",
            "select",
            port,
            executable.to_str().unwrap(),
            "--working-directory",
            runtime.to_str().unwrap(),
            "--arg=--help",
            "--expected-preview",
            &hash,
            "--yes",
        ],
    );
    assert!(registered.status.success(), "{registered:?}");
    let registration = json_stdout(&registered)["data"].clone();
    assert_eq!(registration["archive_sha256"], "");
    let status = portcove(&library, &["--json", "status", port]);
    assert!(status.status.success(), "{status:?}");
    assert_eq!(
        json_stdout(&status)["data"]["external_runtime"]["id"],
        registration["id"]
    );

    // Steam's static manual entry uses the public argument array, without a
    // fixed request UUID or a version-specific game executable.
    let launch = portcove(&library, &["--non-interactive", "exec", port, "--"]);
    assert!(launch.status.success(), "{launch:?}");

    // Moving the standalone CLI requires manual target/Start In repair. The
    // repaired target still selects the same library and runtime registration.
    let cli_directory = root.path().join("Relocated CLI ü 日本語");
    std::fs::create_dir(&cli_directory).unwrap();
    let relocated_cli = cli_directory.join(if cfg!(windows) {
        "portcove.exe"
    } else {
        "portcove"
    });
    std::fs::copy(super::cli_binary(), &relocated_cli).unwrap();
    let launch_relocated = || {
        std::process::Command::new(&relocated_cli)
            .current_dir(&cli_directory)
            .arg("--library")
            .arg(&library)
            .args(["--non-interactive", "exec", port, "--"])
            .output()
            .unwrap()
    };
    let launch = launch_relocated();
    assert!(launch.status.success(), "{launch:?}");

    std::fs::remove_file(&executable).unwrap();
    let unavailable = launch_relocated();
    assert!(!unavailable.status.success(), "{unavailable:?}");
    assert_eq!(
        json_stdout(&portcove(&library, &["--json", "status", port]))["data"]["external_runtime"]["id"],
        registration["id"]
    );
    let review = portcove(
        &library,
        &[
            "--json",
            "external",
            "select-relink-preview",
            port,
            replacement.to_str().unwrap(),
            "--working-directory",
            runtime.to_str().unwrap(),
            "--arg=--help",
        ],
    );
    assert!(review.status.success(), "{review:?}");
    let hash = json_stdout(&review)["data"]["preview_sha256"]
        .as_str()
        .unwrap()
        .to_owned();
    let relinked = portcove(
        &library,
        &[
            "--json",
            "--non-interactive",
            "external",
            "select-relink",
            port,
            replacement.to_str().unwrap(),
            "--working-directory",
            runtime.to_str().unwrap(),
            "--arg=--help",
            "--expected-preview",
            &hash,
            "--yes",
        ],
    );
    assert!(relinked.status.success(), "{relinked:?}");
    assert_eq!(json_stdout(&relinked)["data"]["id"], registration["id"]);
    assert_eq!(
        json_stdout(&relinked)["data"]["registered_at"],
        registration["registered_at"]
    );
    let repaired = launch_relocated();
    assert!(repaired.status.success(), "{repaired:?}");
    let removal = portcove(&library, &["--json", "external", "removal-preview", port]);
    assert!(removal.status.success(), "{removal:?}");
    let hash = json_stdout(&removal)["data"]["preview_sha256"]
        .as_str()
        .unwrap()
        .to_owned();
    let removed = portcove(
        &library,
        &[
            "--json",
            "--non-interactive",
            "external",
            "remove",
            port,
            "--expected-preview",
            &hash,
            "--yes",
        ],
    );
    assert!(removed.status.success(), "{removed:?}");
    assert!(replacement.is_file());
    assert_eq!(
        std::fs::read(&sentinel).unwrap(),
        b"player save stays in place"
    );
    assert_eq!(
        json_stdout(&portcove(&library, &["--json", "status", port]))["data"]["external_runtime"],
        Value::Null
    );
}
