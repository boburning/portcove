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

    // Future-only remembers what is already in the folder, recognized or not.
    std::fs::write(games.join("already-here.bin"), b"data").unwrap();
    let future = run(&["--json", "games", "folder-setup", &root_id, "future-only"]);
    assert!(future.status.success(), "{future:?}");
    let future = json_stdout(&future);
    assert_eq!(future["data"]["enrollment"], "future_only");
    assert_eq!(future["data"]["existing_files"], 1);

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
    let pass = json_stdout(&pass);
    assert_eq!(pass["data"]["batches"], serde_json::json!([]));
    assert!(pass["data"].get("game_setup_unavailable").is_none());

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

#[test]
fn standing_setup_machine_result_distinguishes_an_unreadable_game_queue() {
    let temporary = tempfile::tempdir().unwrap();
    let library = temporary.path().join("library");
    drop(portcove_core::Library::open(&library).unwrap());
    let database = rusqlite::Connection::open(library.join("portcove.sqlite3")).unwrap();
    database.execute(
        "INSERT INTO port_intents(port_id, updated_at, record_json) VALUES ('zelda64-recomp', 1, X'00')",
        [],
    ).unwrap();
    drop(database);

    let capabilities = portcove(&library, &["--json", "capabilities"]);
    assert!(capabilities.status.success(), "{capabilities:?}");
    let capabilities = json_stdout(&capabilities);
    let pass = portcove(&library, &["--json", "games", "setup-ready"]);
    assert!(pass.status.success(), "{pass:?}");
    let pass = json_stdout(&pass);
    assert_eq!(pass["schema_version"], portcove_core::API_SCHEMA_VERSION);
    assert_eq!(
        pass["schema_version"],
        capabilities["data"]["schema_version"]
    );
    assert_eq!(pass["command"], "games.setup-ready");
    assert_eq!(pass["ok"], true);
    assert!(pass["error"].is_null());
    assert!(
        pass["data"]["game_setup_unavailable"]
            .as_str()
            .is_some_and(|reason| !reason.is_empty())
    );
    assert_eq!(pass["data"]["batches"], serde_json::json!([]));
}
