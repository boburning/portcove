//! Compiled CLI read/dispatch continuity for metadata-only archive owners.
use portcove_core::{ArtifactIdentity, InstallRecord, Library, Platform, ReleaseChannel};
use serde_json::{Value, json};
use std::{fs, path::Path};

#[test]
fn unknown_archive_owner_remains_readable_and_update_all_keeps_independent_refusals() {
    const UNKNOWN: &str = "unknown-retained-archive-owner";
    const KNOWN: &str = "shipwright";
    let temporary = tempfile::tempdir().unwrap();
    let library_path = temporary.path().join("library");
    let library = Library::open(&library_path).unwrap();
    // Inert unverified registrations exercise inventory only, never runtime permission.
    for port_id in [KNOWN, UNKNOWN] {
        let path = library.versions_dir().join(port_id).join("inert-fixture");
        fs::create_dir_all(&path).unwrap();
        fs::write(path.join("keep-player-independent-marker"), b"unchanged").unwrap();
        library
            .register_install(
                &InstallRecord {
                    id: format!("inert-{port_id}"),
                    port_id: port_id.into(),
                    version: "inert-fixture".into(),
                    path,
                    channel: ReleaseChannel::Stable,
                    installed_at: 1,
                    verified: false,
                    staged: false,
                    artifact: ArtifactIdentity::default(),
                    runtime: None,
                    manifest_sha256: String::new(),
                    selected_executable: "game.exe".into(),
                },
                true,
            )
            .unwrap();
    }
    let id = uuid::Uuid::new_v4().to_string();
    let private = library
        .downloads_dir()
        .join("update-acquisition-v1")
        .join(&id);
    fs::create_dir_all(&private).unwrap();
    let marker = serde_json::to_vec(&(&id, UNKNOWN)).unwrap();
    fs::write(private.join("owner.json"), &marker).unwrap();
    let partial = b"incomplete private archive";
    fs::write(private.join("0.archive"), partial).unwrap();
    let asset = json!({"name":"incomplete.zip","url":"https://example.invalid/incomplete.zip","size":1024,"sha256":"f".repeat(64)});
    let journal = json!({
        "view":{"id":id,"port_id":UNKNOWN,"platform":Platform::current().unwrap(),
            "release":{"version":"v2","channel":"stable","published_at":null,"asset":asset},
            "phase":"attention_required","created_at":1,"updated_at":1},
        "definition_sha256":"a".repeat(64),"assets":[asset],
    });
    // An interrupted bounded journal is fixture input, not a synthetic descriptor or grant.
    let database = rusqlite::Connection::open(library_path.join("portcove.sqlite3")).unwrap();
    database.execute(
        "INSERT INTO lifecycle_operations(id,kind,port_id,phase,staging_path,created_at,updated_at,update_acquisition_json)
         VALUES (?1,'acquire_update',?2,'preparing',?3,1,1,?4)",
        rusqlite::params![id,UNKNOWN,private.to_str().unwrap(),journal.to_string()],
    ).unwrap();
    drop(database);
    let known_guard = library.try_lock_port(KNOWN, "verify").unwrap();
    let invoke = |arguments: &[&str]| {
        eprintln!("compiled CLI inventory phase: {arguments:?}");
        let output = std::process::Command::new(super::cli_binary())
            .env(
                "PORTCOVE_PREFERENCES",
                temporary.path().join("preferences.json"),
            )
            .env_remove("PORTCOVE_LIBRARY")
            .env_remove("PORTCOVE_GITHUB_TOKEN")
            .env_remove("GH_TOKEN")
            .env_remove("GITHUB_TOKEN")
            .arg("--library")
            .arg(&library_path)
            .args(arguments)
            .output()
            .unwrap();
        assert!(output.status.success(), "{arguments:?}: {output:?}");
        output
    };
    let inventory = invoke(&["--json", "status"]);
    let inventory: Value = serde_json::from_slice(&inventory.stdout).unwrap();
    let rows = inventory["data"].as_array().unwrap();
    assert!(rows.iter().any(|row| row["port_id"] == KNOWN));
    let orphan = rows.iter().find(|row| row["port_id"] == UNKNOWN).unwrap();
    assert_eq!(orphan["acquisition"]["id"], id);
    assert!(orphan["readiness"].is_null());
    let actions = orphan["port_actions"].as_array().unwrap();
    assert!(!actions.is_empty());
    assert!(
        actions
            .iter()
            .all(|action| action["availability"] != "allowed")
    );
    let human = invoke(&["status"]);
    let human = String::from_utf8(human.stdout).unwrap();
    let orphan_row = human.lines().find(|line| line.contains(UNKNOWN)).unwrap();
    assert!(orphan_row.contains("name unavailable"), "{orphan_row}");
    assert!(orphan_row.contains("unknown"), "{orphan_row}");
    assert!(!orphan_row.contains("ready"), "{orphan_row}");

    let human = invoke(&["--non-interactive", "update", "--all"]);
    let human = String::from_utf8(human.stdout).unwrap();
    assert!(
        human.contains("Update results: 2 ports; 0 succeeded, 2 did not succeed"),
        "{human}"
    );
    assert!(human.contains(KNOWN) && human.contains(UNKNOWN), "{human}");
    let machine = invoke(&["--json", "--non-interactive", "update", "--all"]);
    let machine: Value = serde_json::from_slice(&machine.stdout).unwrap();
    let outcomes = machine["data"].as_array().unwrap();
    assert_eq!(outcomes.len(), 2);
    for (port_id, code) in [(KNOWN, "conflict"), (UNKNOWN, "not_found")] {
        let row = outcomes
            .iter()
            .find(|row| row["port_id"] == port_id)
            .unwrap();
        assert_eq!(row["ok"], false);
        assert!(row["result"].is_null());
        assert_eq!(row["error"]["code"], code, "{row}");
    }
    assert_eq!(fs::read(private.join("owner.json")).unwrap(), marker);
    assert_eq!(fs::read(private.join("0.archive")).unwrap(), partial);
    for port_id in [KNOWN, UNKNOWN] {
        assert_eq!(
            library
                .status(port_id, ReleaseChannel::Stable)
                .unwrap()
                .active
                .unwrap()
                .id,
            format!("inert-{port_id}")
        );
        assert_eq!(
            fs::read(
                library
                    .versions_dir()
                    .join(port_id)
                    .join("inert-fixture")
                    .join(Path::new("keep-player-independent-marker"))
            )
            .unwrap(),
            b"unchanged"
        );
    }
    drop(known_guard);
}
