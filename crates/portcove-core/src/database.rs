use std::{
    fs::{File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    time::Duration,
};

use fs2::FileExt;
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior};

use crate::{PortcoveError, Result};

pub(crate) const CURRENT_SCHEMA_VERSION: i64 = 12;

struct Migration {
    version: i64,
    name: &'static str,
    apply: fn(&Transaction<'_>) -> Result<()>,
    verify: fn(&Connection) -> Result<()>,
}

const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        name: "library foundation",
        apply: migration_1,
        verify: verify_migration_1,
    },
    Migration {
        version: 2,
        name: "release HTTP cache",
        apply: migration_2,
        verify: verify_migration_2,
    },
    Migration {
        version: 3,
        name: "source storage identity",
        apply: migration_3,
        verify: verify_migration_3,
    },
    Migration {
        version: 4,
        name: "launch history",
        apply: migration_4,
        verify: verify_migration_4,
    },
    Migration {
        version: 5,
        name: "activity history",
        apply: migration_5,
        verify: verify_migration_5,
    },
    Migration {
        version: 6,
        name: "update snapshots",
        apply: migration_6,
        verify: verify_migration_6,
    },
    Migration {
        version: 7,
        name: "recoverable lifecycle operations",
        apply: migration_7,
        verify: verify_migration_7,
    },
    Migration {
        version: 8,
        name: "immutable install identity",
        apply: migration_8,
        verify: verify_migration_8,
    },
    Migration {
        version: 9,
        name: "durable launch sessions",
        apply: migration_9,
        verify: verify_migration_9,
    },
    Migration {
        version: 10,
        name: "phase-aware cancellation",
        apply: migration_10,
        verify: verify_migration_10,
    },
    Migration {
        version: 11,
        name: "signed catalog trust and selection",
        apply: crate::catalog_store::migrate,
        verify: verify_migration_11,
    },
    Migration {
        version: 12,
        name: "immutable bundled runtime identity",
        apply: migration_12,
        verify: verify_migration_12,
    },
];

struct MigrationLock {
    file: File,
}

impl MigrationLock {
    fn acquire(root: &Path) -> Result<Self> {
        let path = root.join("locks").join("migration.lock");
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&path)?;
        file.lock_exclusive().map_err(|error| {
            PortcoveError::state("could not acquire the library migration lock")
                .detail("lock_path", path.display().to_string())
                .detail("cause", error.to_string())
        })?;
        file.set_len(0)?;
        serde_json::to_writer(
            &mut file,
            &serde_json::json!({
                "operation": "database_migration",
                "pid": std::process::id(),
            }),
        )?;
        file.write_all(b"\n")?;
        file.sync_data()?;
        Ok(Self { file })
    }
}

impl Drop for MigrationLock {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.file);
    }
}

pub(crate) fn connect(root: &Path) -> Result<Connection> {
    let connection = Connection::open(database_path(root))?;
    // WAL and a bounded busy timeout remain useful for ordinary concurrent
    // access. Migration serialization is provided separately by MigrationLock.
    connection.busy_timeout(Duration::from_secs(10))?;
    connection.pragma_update(None, "foreign_keys", "ON")?;
    connection.pragma_update(None, "journal_mode", "WAL")?;
    Ok(connection)
}

pub(crate) fn migrate(root: &Path) -> Result<()> {
    migrate_to(root, CURRENT_SCHEMA_VERSION)
}

fn migrate_to(root: &Path, target_version: i64) -> Result<()> {
    let _lock = MigrationLock::acquire(root)?;
    let mut connection = connect(root)?;
    connection.execute(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
           version INTEGER PRIMARY KEY,
           applied_at INTEGER NOT NULL
         )",
        [],
    )?;

    let applied = recorded_versions(&connection)?;
    validate_recorded_versions(&applied)?;
    for migration in MIGRATIONS.iter().take(applied.len()) {
        verify_recorded_migration(&connection, migration)?;
    }

    for migration in MIGRATIONS
        .iter()
        .skip(applied.len())
        .take(target_version.saturating_sub(applied.len() as i64) as usize)
    {
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        (migration.apply)(&transaction).map_err(|error| migration_failure(migration, error))?;
        (migration.verify)(&transaction).map_err(|error| migration_failure(migration, error))?;
        transaction.execute(
            "INSERT INTO schema_migrations(version, applied_at) VALUES (?1, unixepoch())",
            [migration.version],
        )?;
        transaction.commit()?;
    }

    let final_versions = recorded_versions(&connection)?;
    if final_versions.last().copied().unwrap_or_default() != target_version {
        return Err(
            PortcoveError::state("database migration did not reach its target version")
                .detail("expected_version", target_version.to_string())
                .detail(
                    "actual_version",
                    final_versions
                        .last()
                        .copied()
                        .unwrap_or_default()
                        .to_string(),
                ),
        );
    }
    Ok(())
}

fn database_path(root: &Path) -> PathBuf {
    root.join("portcove.sqlite3")
}

fn recorded_versions(connection: &Connection) -> Result<Vec<i64>> {
    let mut statement =
        connection.prepare("SELECT version FROM schema_migrations ORDER BY version")?;
    let rows = statement.query_map([], |row| row.get(0))?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

fn validate_recorded_versions(versions: &[i64]) -> Result<()> {
    if let Some(version) = versions
        .iter()
        .copied()
        .find(|version| *version > CURRENT_SCHEMA_VERSION)
    {
        return Err(PortcoveError::state(
            "this library was created by a newer Portcove database schema",
        )
        .detail("library_schema_version", version.to_string())
        .detail(
            "supported_schema_version",
            CURRENT_SCHEMA_VERSION.to_string(),
        ));
    }
    for (index, version) in versions.iter().enumerate() {
        let expected = index as i64 + 1;
        if *version != expected {
            return Err(PortcoveError::state(
                "the library migration history is incomplete or out of order",
            )
            .detail("expected_version", expected.to_string())
            .detail("recorded_version", version.to_string()));
        }
    }
    Ok(())
}

fn verify_recorded_migration(connection: &Connection, migration: &Migration) -> Result<()> {
    (migration.verify)(connection).map_err(|error| {
        PortcoveError::state("a recorded database migration is only partially applied")
            .detail("migration_version", migration.version.to_string())
            .detail("migration_name", migration.name)
            .detail("cause", error.to_string())
    })
}

fn migration_failure(migration: &Migration, error: PortcoveError) -> PortcoveError {
    PortcoveError::state("a database migration failed and was rolled back")
        .detail("migration_version", migration.version.to_string())
        .detail("migration_name", migration.name)
        .detail("cause", error.to_string())
}

fn migration_1(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        "CREATE TABLE IF NOT EXISTS sources (
           profile_id TEXT PRIMARY KEY,
           path TEXT NOT NULL,
           sha256 TEXT NOT NULL,
           size INTEGER NOT NULL,
           updated_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS installs (
           id TEXT PRIMARY KEY,
           port_id TEXT NOT NULL,
           version TEXT NOT NULL,
           path TEXT NOT NULL,
           channel TEXT NOT NULL,
           installed_at INTEGER NOT NULL,
           verified INTEGER NOT NULL,
           staged INTEGER NOT NULL DEFAULT 0
         );
         CREATE INDEX IF NOT EXISTS installs_port_id ON installs(port_id);
         CREATE TABLE IF NOT EXISTS port_settings (
           port_id TEXT PRIMARY KEY,
           channel TEXT NOT NULL,
           update_policy TEXT NOT NULL,
           active_install_id TEXT,
           previous_install_id TEXT,
           FOREIGN KEY(active_install_id) REFERENCES installs(id) ON DELETE SET NULL,
           FOREIGN KEY(previous_install_id) REFERENCES installs(id) ON DELETE SET NULL
         );",
    )?;
    Ok(())
}

fn verify_migration_1(connection: &Connection) -> Result<()> {
    require_columns(
        connection,
        "sources",
        &["profile_id", "path", "sha256", "size", "updated_at"],
    )?;
    require_columns(
        connection,
        "installs",
        &[
            "id",
            "port_id",
            "version",
            "path",
            "channel",
            "installed_at",
            "verified",
            "staged",
        ],
    )?;
    require_columns(
        connection,
        "port_settings",
        &[
            "port_id",
            "channel",
            "update_policy",
            "active_install_id",
            "previous_install_id",
        ],
    )?;
    require_index(connection, "installs_port_id")
}

fn migration_2(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        "CREATE TABLE IF NOT EXISTS github_http_cache (
           url TEXT PRIMARY KEY,
           etag TEXT,
           last_modified TEXT,
           body TEXT NOT NULL,
           updated_at INTEGER NOT NULL
         );",
    )?;
    Ok(())
}

fn verify_migration_2(connection: &Connection) -> Result<()> {
    require_columns(
        connection,
        "github_http_cache",
        &["url", "etag", "last_modified", "body", "updated_at"],
    )
}

fn migration_3(transaction: &Transaction<'_>) -> Result<()> {
    let columns = table_columns(transaction, "sources")?;
    if !columns.iter().any(|column| column == "storage_sha256") {
        transaction.execute(
            "ALTER TABLE sources ADD COLUMN storage_sha256 TEXT NOT NULL DEFAULT ''",
            [],
        )?;
    }
    if !columns.iter().any(|column| column == "storage_size") {
        transaction.execute(
            "ALTER TABLE sources ADD COLUMN storage_size INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
    }
    transaction.execute(
        "UPDATE sources SET storage_sha256=sha256 WHERE storage_sha256=''",
        [],
    )?;
    transaction.execute(
        "UPDATE sources SET storage_size=size WHERE storage_size=0",
        [],
    )?;
    Ok(())
}

fn verify_migration_3(connection: &Connection) -> Result<()> {
    require_columns(connection, "sources", &["storage_sha256", "storage_size"])?;
    let incomplete: i64 = connection.query_row(
        "SELECT COUNT(*) FROM sources WHERE storage_sha256='' OR storage_size=0",
        [],
        |row| row.get(0),
    )?;
    if incomplete != 0 {
        return Err(PortcoveError::state(
            "source storage identity backfill is incomplete",
        ));
    }
    Ok(())
}

fn migration_4(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        "CREATE TABLE IF NOT EXISTS launch_history (
           port_id TEXT PRIMARY KEY,
           last_launched_at INTEGER NOT NULL,
           successful_launches INTEGER NOT NULL DEFAULT 1
         );",
    )?;
    Ok(())
}

fn verify_migration_4(connection: &Connection) -> Result<()> {
    require_columns(
        connection,
        "launch_history",
        &["port_id", "last_launched_at", "successful_launches"],
    )
}

fn migration_5(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        "CREATE TABLE IF NOT EXISTS activity_history (
           id TEXT PRIMARY KEY,
           operation TEXT NOT NULL,
           target_kind TEXT NOT NULL,
           target_id TEXT,
           status TEXT NOT NULL,
           message TEXT,
           started_at INTEGER NOT NULL,
           finished_at INTEGER
         );
         CREATE INDEX IF NOT EXISTS activity_history_started_at
           ON activity_history(started_at DESC);",
    )?;
    Ok(())
}

fn verify_migration_5(connection: &Connection) -> Result<()> {
    require_columns(
        connection,
        "activity_history",
        &[
            "id",
            "operation",
            "target_kind",
            "target_id",
            "status",
            "message",
            "started_at",
            "finished_at",
        ],
    )?;
    require_index(connection, "activity_history_started_at")
}

fn migration_6(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        "CREATE TABLE IF NOT EXISTS update_snapshots (
           port_id TEXT PRIMARY KEY,
           check_json TEXT NOT NULL,
           checked_at INTEGER NOT NULL
         );",
    )?;
    Ok(())
}

fn verify_migration_6(connection: &Connection) -> Result<()> {
    require_columns(
        connection,
        "update_snapshots",
        &["port_id", "check_json", "checked_at"],
    )
}

fn migration_7(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        "CREATE TABLE IF NOT EXISTS lifecycle_operations (
           id TEXT PRIMARY KEY,
           kind TEXT NOT NULL,
           port_id TEXT NOT NULL,
           phase TEXT NOT NULL,
           staging_path TEXT,
           final_path TEXT,
           quarantine_path TEXT,
           install_json TEXT,
           original_paths_json TEXT NOT NULL DEFAULT '[]',
           activate INTEGER NOT NULL DEFAULT 0,
           last_error TEXT,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS lifecycle_operations_port_id
           ON lifecycle_operations(port_id);",
    )?;
    Ok(())
}

fn verify_migration_7(connection: &Connection) -> Result<()> {
    require_columns(
        connection,
        "lifecycle_operations",
        &[
            "id",
            "kind",
            "port_id",
            "phase",
            "staging_path",
            "final_path",
            "quarantine_path",
            "install_json",
            "original_paths_json",
            "activate",
            "last_error",
            "created_at",
            "updated_at",
        ],
    )?;
    require_index(connection, "lifecycle_operations_port_id")
}

fn migration_8(transaction: &Transaction<'_>) -> Result<()> {
    let columns = table_columns(transaction, "installs")?;
    for (column, declaration) in [
        ("artifact_name", "TEXT NOT NULL DEFAULT ''"),
        ("artifact_sha256", "TEXT NOT NULL DEFAULT ''"),
        ("artifact_size", "INTEGER NOT NULL DEFAULT 0"),
        ("manifest_sha256", "TEXT NOT NULL DEFAULT ''"),
        ("selected_executable", "TEXT NOT NULL DEFAULT ''"),
    ] {
        if !columns.iter().any(|candidate| candidate == column) {
            transaction.execute(
                &format!("ALTER TABLE installs ADD COLUMN {column} {declaration}"),
                [],
            )?;
        }
    }
    Ok(())
}

fn verify_migration_8(connection: &Connection) -> Result<()> {
    require_columns(
        connection,
        "installs",
        &[
            "artifact_name",
            "artifact_sha256",
            "artifact_size",
            "manifest_sha256",
            "selected_executable",
        ],
    )
}

fn migration_9(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        "CREATE TABLE IF NOT EXISTS launch_sessions (
           id TEXT PRIMARY KEY,
           port_id TEXT NOT NULL UNIQUE,
           install_id TEXT NOT NULL,
           install_root TEXT NOT NULL,
           supervisor_pid INTEGER NOT NULL,
           child_pid INTEGER,
           phase TEXT NOT NULL,
           started_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS launch_sessions_install_id ON launch_sessions(install_id);",
    )?;
    Ok(())
}

fn verify_migration_9(connection: &Connection) -> Result<()> {
    require_columns(
        connection,
        "launch_sessions",
        &[
            "id",
            "port_id",
            "install_id",
            "install_root",
            "supervisor_pid",
            "child_pid",
            "phase",
            "started_at",
            "updated_at",
        ],
    )?;
    require_index(connection, "launch_sessions_install_id")
}

fn migration_10(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        "ALTER TABLE activity_history ADD COLUMN cancellation_phase TEXT CHECK(cancellation_phase IN ('preparing', 'finishing'));
         ALTER TABLE activity_history ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0,1));
         ALTER TABLE activity_history ADD COLUMN cancellation_owner TEXT;",
    )?;
    Ok(())
}

fn verify_migration_10(connection: &Connection) -> Result<()> {
    require_columns(
        connection,
        "activity_history",
        &[
            "cancellation_phase",
            "cancel_requested",
            "cancellation_owner",
        ],
    )
}

fn verify_migration_11(connection: &Connection) -> Result<()> {
    require_columns(connection, "catalog_trust", &["key_id", "public_key"])?;
    require_columns(
        connection,
        "catalog_state",
        &[
            "singleton",
            "revision",
            "highest_sequence",
            "enabled",
            "active",
            "previous",
        ],
    )
}

fn migration_12(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        "ALTER TABLE installs ADD COLUMN runtime_json TEXT;
        DELETE FROM update_snapshots;",
    )?;
    Ok(())
}

fn verify_migration_12(connection: &Connection) -> Result<()> {
    require_columns(connection, "installs", &["runtime_json"])
}

fn table_columns(connection: &Connection, table: &str) -> Result<Vec<String>> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
    let rows = statement.query_map([], |row| row.get::<_, String>(1))?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

fn require_columns(connection: &Connection, table: &str, required: &[&str]) -> Result<()> {
    let columns = table_columns(connection, table)?;
    if columns.is_empty() {
        return Err(PortcoveError::state(format!(
            "required database table {table} is missing"
        )));
    }
    if let Some(column) = required
        .iter()
        .find(|column| !columns.iter().any(|candidate| candidate == **column))
    {
        return Err(PortcoveError::state(format!(
            "required database column {table}.{column} is missing"
        )));
    }
    Ok(())
}

fn require_index(connection: &Connection, index: &str) -> Result<()> {
    let exists = connection
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='index' AND name=?1",
            [index],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if !exists {
        return Err(PortcoveError::state(format!(
            "required database index {index} is missing"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        sync::{Arc, Barrier},
        thread,
    };

    use tempfile::tempdir;

    use super::*;

    fn prepare_root(root: &Path) {
        fs::create_dir_all(root.join("locks")).unwrap();
    }

    #[test]
    fn fresh_and_every_historical_schema_upgrade_in_order() {
        for historical_version in 0..CURRENT_SCHEMA_VERSION {
            let temporary = tempdir().unwrap();
            let root = temporary.path();
            prepare_root(root);
            migrate_to(root, historical_version).unwrap();

            migrate(root).unwrap();

            let connection = connect(root).unwrap();
            assert_eq!(
                recorded_versions(&connection).unwrap(),
                (1..=CURRENT_SCHEMA_VERSION).collect::<Vec<_>>()
            );
            for migration in MIGRATIONS {
                (migration.verify)(&connection).unwrap();
            }
        }
    }

    #[test]
    fn simultaneous_migrations_are_serialized_by_the_library_lock() {
        let temporary = tempdir().unwrap();
        let root = temporary.path().to_path_buf();
        prepare_root(&root);
        let barrier = Arc::new(Barrier::new(4));
        let threads = (0..4)
            .map(|_| {
                let barrier = barrier.clone();
                let root = root.clone();
                thread::spawn(move || {
                    barrier.wait();
                    migrate(&root)
                })
            })
            .collect::<Vec<_>>();

        for thread in threads {
            thread.join().unwrap().unwrap();
        }
        assert_eq!(
            recorded_versions(&connect(&root).unwrap()).unwrap(),
            (1..=CURRENT_SCHEMA_VERSION).collect::<Vec<_>>()
        );
    }

    #[test]
    fn a_future_schema_is_rejected_with_actionable_versions() {
        let temporary = tempdir().unwrap();
        prepare_root(temporary.path());
        let connection = connect(temporary.path()).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE schema_migrations (
                   version INTEGER PRIMARY KEY,
                   applied_at INTEGER NOT NULL
                 );",
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES (?1, 0)",
                [CURRENT_SCHEMA_VERSION + 1],
            )
            .unwrap();
        drop(connection);

        let error = migrate(temporary.path()).unwrap_err();
        assert_eq!(
            error.details["library_schema_version"],
            (CURRENT_SCHEMA_VERSION + 1).to_string()
        );
        assert_eq!(
            error.details["supported_schema_version"],
            CURRENT_SCHEMA_VERSION.to_string()
        );
    }

    #[test]
    fn a_recorded_but_partial_migration_is_rejected() {
        let temporary = tempdir().unwrap();
        prepare_root(temporary.path());
        let connection = connect(temporary.path()).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE schema_migrations (
                   version INTEGER PRIMARY KEY,
                   applied_at INTEGER NOT NULL
                 );
                 INSERT INTO schema_migrations(version, applied_at) VALUES (1, 0);",
            )
            .unwrap();
        drop(connection);

        let error = migrate(temporary.path()).unwrap_err();
        assert_eq!(error.details["migration_version"], "1");
        assert!(error.message.contains("partially applied"));
    }

    #[test]
    fn a_recorded_migration_with_a_missing_column_is_rejected() {
        let temporary = tempdir().unwrap();
        prepare_root(temporary.path());
        migrate(temporary.path()).unwrap();
        let connection = connect(temporary.path()).unwrap();
        connection
            .execute(
                "ALTER TABLE lifecycle_operations DROP COLUMN last_error",
                [],
            )
            .unwrap();
        drop(connection);

        let error = migrate(temporary.path()).unwrap_err();

        assert_eq!(error.details["migration_version"], "7");
        assert!(error.message.contains("partially applied"));
        assert!(error.details["cause"].contains("last_error"));
    }

    #[test]
    fn a_recorded_migration_with_a_missing_index_is_rejected() {
        let temporary = tempdir().unwrap();
        prepare_root(temporary.path());
        migrate(temporary.path()).unwrap();
        let connection = connect(temporary.path()).unwrap();
        connection
            .execute("DROP INDEX lifecycle_operations_port_id", [])
            .unwrap();
        drop(connection);

        let error = migrate(temporary.path()).unwrap_err();

        assert_eq!(error.details["migration_version"], "7");
        assert!(error.message.contains("partially applied"));
        assert!(error.details["cause"].contains("lifecycle_operations_port_id"));
    }

    #[test]
    fn an_unrecorded_partial_step_completes_idempotently() {
        let temporary = tempdir().unwrap();
        prepare_root(temporary.path());
        migrate_to(temporary.path(), 2).unwrap();
        let connection = connect(temporary.path()).unwrap();
        connection
            .execute(
                "INSERT INTO sources(profile_id, path, sha256, size, updated_at)
                 VALUES ('sample', 'sample.rom', 'digest', 42, 0)",
                [],
            )
            .unwrap();
        connection
            .execute(
                "ALTER TABLE sources ADD COLUMN storage_sha256 TEXT NOT NULL DEFAULT ''",
                [],
            )
            .unwrap();
        drop(connection);

        migrate(temporary.path()).unwrap();

        let connection = connect(temporary.path()).unwrap();
        let identity: (String, i64) = connection
            .query_row(
                "SELECT storage_sha256, storage_size FROM sources WHERE profile_id='sample'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(identity, ("digest".into(), 42));
    }
}
