//! Actual CLI adapters compared with the same production Core query. No network or game execution.
use super::*;
use portcove_core::{GameComparisonRequest, HostPreferenceStore, Library, PortcoveService};

#[tokio::test]
async fn comparison_json_and_jsonl_equal_core_and_preserve_pending_recovery_and_saves() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("library");
    let preferences_path = temporary.path().join("preferences.json");
    let library = Library::open(&root).unwrap();
    let preferences = HostPreferenceStore::new(preferences_path.clone()).unwrap();
    let service = PortcoveService::new_read_only(library).unwrap();
    let database = rusqlite::Connection::open(root.join("portcove.sqlite3")).unwrap();
    database.execute(
        "INSERT INTO activity_history (id, operation, target_kind, target_id, status, started_at, cancellation_phase, cancellation_owner)
         VALUES ('comparison-recovery-control', 'prepare', 'port', 'render96ex', 'running', 1, 'preparing', 'interrupted-worker')", [],
    ).unwrap();
    let sentinel = root.join("player-owned-save");
    std::fs::write(&sentinel, b"preserve original player bytes").unwrap();
    let statuses = serde_json::to_value(service.statuses().unwrap()).unwrap();
    let request: GameComparisonRequest = serde_json::from_value(serde_json::json!({
        "port_id": "render96ex", "evaluated_at": 100,
        "required_capabilities": ["multiplayer"], "environment_id": "comparison-fixture"
    }))
    .unwrap();
    let expected = serde_json::to_value(
        service
            .compare_game_ports(&request, &preferences)
            .await
            .unwrap(),
    )
    .unwrap();
    for mode in ["--json", "--jsonl"] {
        let output = portcove_tool(
            &preferences_path,
            &root,
            &[
                mode,
                "catalog",
                "compare",
                "render96ex",
                "--evaluated-at",
                "100",
                "--require",
                "multiplayer",
                "--environment",
                "comparison-fixture",
            ],
        );
        assert!(output.status.success(), "{output:?}");
        let envelope = json_stdout(&output);
        assert_eq!(
            envelope["schema_version"],
            portcove_core::API_SCHEMA_VERSION
        );
        assert_eq!(envelope["data"], expected);
        assert!(output.stderr.is_empty());
    }
    assert_eq!(
        serde_json::to_value(service.statuses().unwrap()).unwrap(),
        statuses
    );
    let pending: (String, Option<i64>) = database.query_row(
        "SELECT status, finished_at FROM activity_history WHERE id='comparison-recovery-control'", [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).unwrap();
    assert_eq!(pending, ("running".into(), None));
    assert_eq!(
        std::fs::read(sentinel).unwrap(),
        b"preserve original player bytes"
    );
}

#[test]
fn comparison_cli_rejects_unknown_context_without_touching_player_data() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("library");
    let preferences = temporary.path().join("preferences.json");
    drop(Library::open(&root).unwrap());
    let output = portcove_tool(
        &preferences,
        &root,
        &[
            "--json",
            "catalog",
            "compare",
            "render96ex",
            "--platform",
            "unknown-host",
        ],
    );
    assert!(!output.status.success());
    assert!(!preferences.exists());
}
