use std::path::PathBuf;

use super::*;
use crate::{ArtifactIdentity, InstallRecord, Library, ReleaseChannel};

fn digest(label: &str) -> String {
    format!("{label:0>64}")
}

fn library_with(ids: &[&str]) -> (tempfile::TempDir, Library) {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path()).unwrap();
    for id in ids {
        library
            .register_install(
                &InstallRecord {
                    id: (*id).into(),
                    port_id: "lighthouse".into(),
                    version: format!("{id}-version"),
                    path: temporary.path().join(id),
                    channel: ReleaseChannel::Stable,
                    installed_at: Library::now(),
                    verified: true,
                    staged: false,
                    artifact: ArtifactIdentity::default(),
                    manifest_sha256: String::new(),
                    selected_executable: PathBuf::new(),
                    runtime: None,
                },
                false,
            )
            .unwrap();
    }
    (temporary, library)
}

#[test]
fn rows_round_trip_with_pending_replacements() {
    let (_temporary, library) = library_with(&["a", "b"]);
    let mut connection = library.connection().unwrap();
    let present = CarryRow::present(&digest("2"), vec![digest("1"), digest("2")]);
    let pending = CarryRow {
        state: RowState::Pending {
            source_install_id: "a".into(),
        },
        sha256: digest("3"),
        lineage: vec![digest("2"), digest("3")],
    };
    let transaction = connection.transaction().unwrap();
    put(&transaction, "a", "settings.ini", &present, None).unwrap();
    put(&transaction, "b", "settings.ini", &pending, Some(&present)).unwrap();
    // A present row never keeps a replacement.
    assert!(put(&transaction, "a", "other.ini", &present, Some(&present)).unwrap());
    // A displaced record must itself be present.
    assert!(put(&transaction, "b", "x.ini", &pending, Some(&pending)).is_err());
    // A displaced record whose stored lineage lost its own bytes is repaired.
    let malformed = CarryRow {
        state: RowState::Present,
        sha256: digest("2"),
        lineage: vec![digest("1")],
    };
    assert!(put(&transaction, "b", "y.ini", &pending, Some(&malformed)).unwrap());
    transaction.commit().unwrap();

    let a = load(&connection, "a").unwrap();
    assert_eq!(a["settings.ini"].row, present);
    assert_eq!(a["settings.ini"].replaces, None);
    assert_eq!(a["other.ini"].replaces, None);
    let b = load(&connection, "b").unwrap();
    assert_eq!(b["settings.ini"].row, pending);
    assert_eq!(b["settings.ini"].replaces.as_ref(), Some(&present));

    let transaction = connection.transaction().unwrap();
    delete(&transaction, "a", "settings.ini").unwrap();
    transaction.commit().unwrap();
    assert!(!load(&connection, "a").unwrap().contains_key("settings.ini"));
}

#[test]
fn malformed_and_unknown_format_rows_read_as_absent_and_are_never_rewritten() {
    let (_temporary, library) = library_with(&["a"]);
    let mut connection = library.connection().unwrap();
    connection
        .execute_batch(&format!(
            "INSERT INTO carried_files (install_id, path, state, sha256, lineage, format)
             VALUES ('a', 'future.ini', 'present', '{d}', '[\"{d}\"]', 2),
                    ('a', 'bad-lineage.ini', 'present', '{d}', 'not json', 1),
                    ('a', 'bad-digest.ini', 'present', '{d}', '[\"XYZ\"]', 1);",
            d = digest("1")
        ))
        .unwrap();
    assert!(load(&connection, "a").unwrap().is_empty());
    let transaction = connection.transaction().unwrap();
    let row = CarryRow::present(&digest("9"), vec![digest("9")]);
    // Neither write lands, and both say so.
    assert!(!put(&transaction, "a", "future.ini", &row, None).unwrap());
    assert!(delete(&transaction, "a", "future.ini").unwrap());
    assert!(put(&transaction, "a", "fresh.ini", &row, None).unwrap());
    assert!(!delete(&transaction, "a", "fresh.ini").unwrap());
    transaction.commit().unwrap();
    let (format, sha): (i64, String) = connection
        .query_row(
            "SELECT format, sha256 FROM carried_files WHERE install_id='a' AND path='future.ini'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!((format, sha), (2, digest("1")));
}

#[test]
fn rows_need_a_lineage_ending_with_their_bytes_and_a_real_installation() {
    let (_temporary, library) = library_with(&["a"]);
    let mut connection = library.connection().unwrap();
    let transaction = connection.transaction().unwrap();
    let broken = CarryRow {
        state: RowState::Present,
        sha256: digest("2"),
        lineage: vec![digest("1")],
    };
    assert!(put(&transaction, "a", "x.ini", &broken, None).is_err());
    let row = CarryRow::present(&digest("2"), vec![digest("2")]);
    assert!(put(&transaction, "missing", "x.ini", &row, None).is_err());
}

#[test]
fn rows_cascade_with_their_installation_and_keys_stay_consistent() {
    let (_temporary, library) = library_with(&["a", "b"]);
    let mut connection = library.connection().unwrap();
    let transaction = connection.transaction().unwrap();
    let row = CarryRow::present(&digest("2"), vec![digest("2")]);
    put(&transaction, "a", "x.ini", &row, None).unwrap();
    put(&transaction, "b", "x.ini", &row, None).unwrap();
    transaction.commit().unwrap();
    connection
        .execute("DELETE FROM installs WHERE id='a'", [])
        .unwrap();
    assert!(load(&connection, "a").unwrap().is_empty());
    assert_eq!(load(&connection, "b").unwrap().len(), 1);
    let violations: i64 = connection
        .query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(violations, 0);
}

#[test]
fn outcomes_are_one_bounded_record_per_port() {
    let (_temporary, library) = library_with(&["a", "b"]);
    let mut connection = library.connection().unwrap();
    let transaction = connection.transaction().unwrap();
    put_outcome(
        &transaction,
        "lighthouse",
        "a",
        "b",
        &serde_json::json!({"kept_separately": 1}),
    )
    .unwrap();
    put_outcome(
        &transaction,
        "lighthouse",
        "b",
        "a",
        &serde_json::json!({"carried": 2}),
    )
    .unwrap();
    let huge = serde_json::json!({ "paths": "x".repeat(70_000) });
    assert!(put_outcome(&transaction, "lighthouse", "a", "b", &huge).is_err());
    transaction.commit().unwrap();
    let (from, to, value) = outcome(&connection, "lighthouse").unwrap().unwrap();
    assert_eq!((from.as_str(), to.as_str()), ("b", "a"));
    assert_eq!(value["carried"], 2);
    assert!(outcome(&connection, "other").unwrap().is_none());
}
