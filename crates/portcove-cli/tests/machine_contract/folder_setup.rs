//! Compiled CLI coverage for folder automatic setup (#966).

use super::*;

#[test]
fn folder_setup_is_off_by_default_and_records_an_explicit_boundary() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path();
    let games = root.join("games");
    std::fs::create_dir(&games).unwrap();
    let library = root.join("library");
    let preferences = root.join("preferences.json");
    let run = |args: &[&str]| portcove_tool(&preferences, &library, args);

    let added = run(&["--json", "source", "roots", "add", games.to_str().unwrap()]);
    assert!(added.status.success(), "{added:?}");
    let root_id = json_stdout(&added)["data"]["id"]
        .as_str()
        .unwrap()
        .to_owned();

    // Adding a folder turns nothing on.
    let listed = run(&["--json", "games", "folder-setups"]);
    assert!(listed.status.success(), "{listed:?}");
    assert_eq!(json_stdout(&listed)["data"], serde_json::json!([]));

    // Future-only needs a complete scan of the folder first.
    let refused = run(&["--json", "games", "folder-setup", &root_id, "future-only"]);
    assert!(!refused.status.success(), "{refused:?}");
    assert!(
        json_stdout(&run(&["--json", "games", "folder-setups"]))["data"]
            .as_array()
            .unwrap()
            .is_empty()
    );

    let enabled = run(&[
        "--json",
        "games",
        "folder-setup",
        &root_id,
        "existing-and-future",
    ]);
    assert!(enabled.status.success(), "{enabled:?}");
    let enabled = json_stdout(&enabled);
    assert_eq!(enabled["command"], "games.folder-setup");
    assert_eq!(enabled["data"]["enrollment"], "existing_and_future");

    // Files several games can use need a game that actually uses them.
    let wrong = run(&[
        "--json",
        "games",
        "folder-setup-choose",
        &root_id,
        "--files",
        "majoras-mask",
        "--game",
        "opengoal-jak1",
    ]);
    assert!(!wrong.status.success(), "{wrong:?}");
    let chosen = run(&[
        "--json",
        "games",
        "folder-setup-choose",
        &root_id,
        "--files",
        "majoras-mask",
        "--game",
        "zelda64-recomp",
    ]);
    assert!(chosen.status.success(), "{chosen:?}");
    assert_eq!(
        json_stdout(&chosen)["data"]["implementations"],
        serde_json::json!([{"profile_id": "majoras-mask", "port_id": "zelda64-recomp"}])
    );

    // An empty folder sets up nothing and launches nothing.
    let pass = run(&["--json", "games", "setup-ready"]);
    assert!(pass.status.success(), "{pass:?}");
    assert_eq!(json_stdout(&pass)["data"]["batches"], serde_json::json!([]));

    let human = run(&["games", "folder-setups"]);
    assert!(human.status.success(), "{human:?}");
    assert!(
        String::from_utf8_lossy(&human.stdout).contains("Automatic setup is on for folder"),
        "{human:?}"
    );

    let off = run(&["--json", "games", "folder-setup", &root_id, "off"]);
    assert!(off.status.success(), "{off:?}");
    assert!(json_stdout(&off)["data"].is_null());
    assert_eq!(
        json_stdout(&run(&["--json", "games", "folder-setups"]))["data"],
        serde_json::json!([])
    );
}
