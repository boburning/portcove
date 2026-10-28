use std::{
    fs::{File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use fs2::FileExt;
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior};

use crate::{PortcoveError, Result};

#[cfg(test)]
#[path = "database_concurrency_tests.rs"]
mod concurrency_tests;

pub(crate) const CURRENT_SCHEMA_VERSION: i64 = 42;

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
    Migration {
        version: 13,
        name: "durable launch request outcomes",
        apply: migration_13,
        verify: verify_migration_13,
    },
    Migration {
        version: 14,
        name: "per-port output directory",
        apply: migration_14,
        verify: verify_migration_14,
    },
    Migration {
        version: 15,
        name: "external output ownership",
        apply: migration_15,
        verify: verify_migration_15,
    },
    Migration {
        version: 16,
        name: "recoverable output relocation",
        apply: migration_16,
        verify: verify_migration_16,
    },
    Migration {
        version: 17,
        name: "observed source identity",
        apply: migration_17,
        verify: verify_migration_17,
    },
    Migration {
        version: 18,
        name: "recoverable source import",
        apply: migration_18,
        verify: verify_migration_18,
    },
    Migration {
        version: 19,
        name: "managed preparation journal",
        apply: migration_19,
        verify: verify_migration_19,
    },
    Migration {
        version: 20,
        name: "structured activity failures",
        apply: migration_20,
        verify: verify_migration_20,
    },
    Migration {
        version: 21,
        name: "retained activity diagnostics",
        apply: migration_21,
        verify: verify_migration_21,
    },
    Migration {
        version: 22,
        name: "separate preparation phase diagnostics",
        apply: migration_22,
        verify: verify_migration_22,
    },
    Migration {
        version: 23,
        name: "retained installation contract writer protocol",
        apply: migration_23,
        verify: verify_migration_23,
    },
    Migration {
        version: 24,
        name: "managed local artwork",
        apply: crate::artwork_store::migrate,
        verify: verify_migration_24,
    },
    Migration {
        version: 25,
        name: "exact successor contract writer protocol",
        apply: migration_25,
        verify: verify_migration_23,
    },
    Migration {
        version: 26,
        name: "atomic successor definition selection",
        apply: crate::definition_candidate::selection::migrate,
        verify: verify_migration_26,
    },
    Migration {
        version: 27,
        name: "authenticated definition admission writer protocol",
        apply: migration_27,
        verify: verify_migration_26,
    },
    Migration {
        version: 28,
        name: "durable preparation process quiescence",
        apply: migration_28,
        verify: verify_migration_28,
    },
    Migration {
        version: 29,
        name: "private import publication receipts",
        apply: migration_29,
        verify: verify_migration_29,
    },
    Migration {
        version: 30,
        name: "saved game-file roots",
        apply: migration_30,
        verify: verify_migration_30,
    },
    Migration {
        version: 31,
        name: "durable game-file scan snapshot",
        apply: migration_31,
        verify: verify_migration_31,
    },
    Migration {
        version: 32,
        name: "non-owning runtime registration",
        apply: migration_32,
        verify: verify_migration_32,
    },
    Migration {
        version: 33,
        name: "protected definition publisher admission",
        apply: migration_33,
        verify: verify_migration_33,
    },
    Migration {
        version: 34,
        name: "retained publisher authorization continuity",
        apply: migration_34,
        verify: verify_migration_34,
    },
    Migration {
        version: 35,
        name: "accepted exact managed launch decisions",
        apply: migration_35,
        verify: verify_migration_35,
    },
    Migration {
        version: 36,
        name: "retained immutable curated acquisition identities",
        apply: crate::curated_acquisition::migrate,
        verify: verify_migration_36,
    },
    Migration {
        version: 37,
        name: "qualified legacy data snapshots",
        apply: crate::ghostship_data_store::migrate,
        verify: verify_migration_37,
    },
    Migration {
        version: 38,
        name: "exact retained build references",
        apply: crate::retained_build::migrate,
        verify: verify_migration_38,
    },
    Migration {
        version: 39,
        name: "non-owning catalog download handoff",
        apply: migration_39,
        verify: verify_migration_39,
    },
    Migration {
        version: 40,
        name: "authenticated descriptive listing delivery",
        apply: crate::definition_repository::publisher_policy::listing_delivery::migrate,
        verify: verify_migration_40,
    },
    Migration {
        version: 41,
        name: "reviewed external to managed publication",
        apply: migration_41,
        verify: verify_migration_41,
    },
    Migration {
        version: 42,
        name: "owned immutable game update acquisition",
        apply: migration_42,
        verify: verify_migration_42,
    },
];

fn migration_42(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        "ALTER TABLE lifecycle_operations ADD COLUMN update_acquisition_json TEXT;",
    )?;
    verify_migration_42(transaction)
}

fn verify_migration_42(connection: &Connection) -> Result<()> {
    require_columns(
        connection,
        "lifecycle_operations",
        &["update_acquisition_json"],
    )
}

fn migration_41(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch("ALTER TABLE lifecycle_operations ADD COLUMN external_registration_sha256 TEXT CHECK(external_registration_sha256 IS NULL OR (length(external_registration_sha256)=64 AND external_registration_sha256 NOT GLOB '*[^0-9a-f]*'));")?;
    verify_migration_41(transaction)
}

fn verify_migration_41(connection: &Connection) -> Result<()> {
    require_columns(
        connection,
        "lifecycle_operations",
        &["external_registration_sha256"],
    )
}

fn verify_migration_40(connection: &Connection) -> Result<()> {
    require_columns(
        connection,
        "listing_delivery",
        &["singleton", "document_json", "provenance_json"],
    )
}

fn migration_39(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch("CREATE TABLE catalog_downloads (
        port_id TEXT PRIMARY KEY,
        pending_id TEXT NOT NULL UNIQUE,
        record_json TEXT NOT NULL CHECK(length(CAST(record_json AS BLOB))<=65536),
        stage_path TEXT,
        phase TEXT NOT NULL CHECK(phase IN ('preparing','publication-intent','downloaded','attention-required')),
        preview_sha256 TEXT NOT NULL CHECK(length(preview_sha256)=64),
        activity_id TEXT NOT NULL
    );")?;
    Ok(())
}

fn verify_migration_39(connection: &Connection) -> Result<()> {
    require_columns(
        connection,
        "catalog_downloads",
        &[
            "port_id",
            "pending_id",
            "record_json",
            "stage_path",
            "phase",
            "preview_sha256",
            "activity_id",
        ],
    )
}

fn verify_migration_38(connection: &Connection) -> Result<()> {
    require_columns(
        connection,
        "retained_build_references",
        &["id", "port_id", "setup_id", "install_id", "reference_json"],
    )
}

fn verify_migration_37(connection: &Connection) -> Result<()> {
    require_columns(
        connection,
        "lifecycle_operations",
        &["ghostship_recovery_json", "backup_deletion_json"],
    )?;
    require_columns(
        connection,
        "ghostship_runtime_safety",
        &["backup_id", "receipt_sha256", "receipt_json"],
    )?;
    require_columns(
        connection,
        "ghostship_legacy_qualifications",
        &["port_id", "seal_json"],
    )?;
    require_columns(
        connection,
        "ghostship_qualified_backups",
        &["backup_id", "port_id", "manifest_sha256", "seal_json"],
    )
}

fn verify_migration_36(connection: &Connection) -> Result<()> {
    require_columns(
        connection,
        "curated_artifact_admissions",
        &[
            "repository_id",
            "asset_id",
            "identity_json",
            "policy_sha256",
        ],
    )?;
    require_columns(
        connection,
        "curated_artifact_history",
        &[
            "singleton",
            "admission_count",
            "transition_count",
            "scope_count",
        ],
    )?;
    require_columns(
        connection,
        "curated_artifact_scopes",
        &[
            "repository_id",
            "asset_id",
            "namespace",
            "stable_id",
            "anchor_sha256",
            "policy_sha256",
        ],
    )?;
    require_columns(
        connection,
        "curated_transition_receipts",
        &["policy_sha256", "policy_json", "provenance_json"],
    )
}

fn migration_34(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        "ALTER TABLE definition_publisher_admission ADD COLUMN
           retained_launch_revision_floor INTEGER NOT NULL DEFAULT 1
           CHECK(retained_launch_revision_floor > 0);
         UPDATE definition_publisher_admission SET retained_launch_revision_floor=(
           SELECT policy_revision FROM definition_publisher_policy
           WHERE definition_publisher_policy.namespace=definition_publisher_admission.namespace
             AND definition_publisher_policy.stable_id=definition_publisher_admission.stable_id
         );",
    )?;
    verify_migration_34(transaction)?;
    crate::definition_repository::publisher_policy::validate_stored_admissions(transaction)
}

fn verify_migration_34(connection: &Connection) -> Result<()> {
    require_columns(
        connection,
        "definition_publisher_admission",
        &["retained_launch_revision_floor"],
    )
}

fn migration_35(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        "CREATE TABLE definition_launch_assessments (
            namespace TEXT NOT NULL,
            stable_id TEXT NOT NULL,
            document_json TEXT NOT NULL CHECK(length(document_json)<=65536),
            provenance_json TEXT NOT NULL CHECK(length(provenance_json)<=16384),
            inventory_sha256 TEXT NOT NULL CHECK(length(inventory_sha256)=64),
            PRIMARY KEY(namespace,stable_id)
         );
         CREATE TABLE definition_launch_decisions (
            namespace TEXT NOT NULL,
            stable_id TEXT NOT NULL,
            subject_sha256 TEXT NOT NULL CHECK(length(subject_sha256)=64),
            check_id TEXT NOT NULL,
            anchor_sha256 TEXT NOT NULL REFERENCES definition_publisher_authority(anchor_sha256),
            decision_sha256 TEXT NOT NULL CHECK(length(decision_sha256)=64),
            decision_json TEXT NOT NULL CHECK(length(decision_json)<=4096),
            PRIMARY KEY(namespace,stable_id,subject_sha256,check_id)
         );
         ALTER TABLE definition_publisher_admission ADD COLUMN launch_assessment_revision
            INTEGER NOT NULL DEFAULT 0 CHECK(launch_assessment_revision>=0);",
    )?;
    verify_migration_35(transaction)
}

fn verify_migration_35(connection: &Connection) -> Result<()> {
    require_columns(
        connection,
        "definition_publisher_admission",
        &["launch_assessment_revision"],
    )?;
    require_columns(
        connection,
        "definition_launch_assessments",
        &[
            "namespace",
            "stable_id",
            "document_json",
            "provenance_json",
            "inventory_sha256",
        ],
    )?;
    require_columns(
        connection,
        "definition_launch_decisions",
        &[
            "namespace",
            "stable_id",
            "subject_sha256",
            "check_id",
            "anchor_sha256",
            "decision_sha256",
            "decision_json",
        ],
    )
}

fn migration_33(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        "CREATE TABLE definition_publisher_authority (
            anchor_sha256 TEXT PRIMARY KEY CHECK(length(anchor_sha256)=64),
            trusted_root_json TEXT NOT NULL CHECK(length(trusted_root_json)<=1048576),
            replay_floor_json TEXT CHECK(length(replay_floor_json)<=16384)
         );
         CREATE TABLE definition_publisher_admission (
            namespace TEXT NOT NULL,
            stable_id TEXT NOT NULL,
            anchor_sha256 TEXT NOT NULL REFERENCES definition_publisher_authority(anchor_sha256),
            policy_json TEXT NOT NULL CHECK(length(policy_json)<=65536),
            provenance_json TEXT NOT NULL CHECK(length(provenance_json)<=16384),
            PRIMARY KEY(namespace,stable_id)
         );",
    )?;
    verify_migration_33(transaction)
}

fn verify_migration_33(connection: &Connection) -> Result<()> {
    require_columns(
        connection,
        "definition_publisher_authority",
        &["anchor_sha256", "trusted_root_json", "replay_floor_json"],
    )?;
    require_columns(
        connection,
        "definition_publisher_admission",
        &[
            "namespace",
            "stable_id",
            "anchor_sha256",
            "policy_json",
            "provenance_json",
        ],
    )
}

fn migration_32(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        "CREATE TABLE external_runtime_registrations (
            port_id TEXT PRIMARY KEY,
            record_json TEXT NOT NULL,
            retained_catalog_json TEXT NOT NULL,
            registered_at INTEGER NOT NULL
        );
        ALTER TABLE launch_sessions ADD COLUMN owner_kind TEXT NOT NULL
            DEFAULT 'managed' CHECK(owner_kind IN ('managed','external'));",
    )?;
    Ok(())
}

fn verify_migration_32(connection: &Connection) -> Result<()> {
    require_columns(
        connection,
        "external_runtime_registrations",
        &[
            "port_id",
            "record_json",
            "retained_catalog_json",
            "registered_at",
        ],
    )?;
    require_columns(connection, "launch_sessions", &["owner_kind"])
}

struct MigrationLock {
    file: File,
}

const MIGRATION_LOCK_WAIT: Duration = Duration::from_secs(10);
const MIGRATION_LOCK_POLL: Duration = Duration::from_millis(50);
const MIGRATION_OWNER_LIMIT: u64 = 1024;

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct MigrationLockOwner {
    operation: String,
    pid: u32,
}

impl MigrationLock {
    fn acquire(root: &Path) -> Result<Self> {
        Self::acquire_with_timeout(root, MIGRATION_LOCK_WAIT)
    }

    fn acquire_with_timeout(root: &Path, timeout: Duration) -> Result<Self> {
        let path = root.join("locks").join("migration.lock");
        let owner_path = root.join("locks").join("migration.owner.json");
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&path)?;
        let started = Instant::now();
        let mut first_attempt = true;
        loop {
            if !first_attempt && started.elapsed() >= timeout {
                return Err(Self::timeout_error(&owner_path, timeout));
            }
            first_attempt = false;
            match FileExt::try_lock_exclusive(&file) {
                Ok(()) => break,
                Err(error)
                    if Self::is_contention(&error)
                        || error.kind() == std::io::ErrorKind::Interrupted =>
                {
                    let remaining = timeout.saturating_sub(started.elapsed());
                    if remaining.is_zero() {
                        return Err(Self::timeout_error(&owner_path, timeout));
                    }
                    std::thread::sleep(MIGRATION_LOCK_POLL.min(remaining));
                }
                Err(error) => {
                    return Err(PortcoveError::state(
                        "could not acquire the library migration lock",
                    )
                    .detail("lock_path", path.display().to_string())
                    .detail("cause", error.to_string()));
                }
            }
        }

        let owner = MigrationLockOwner {
            operation: "database_migration".into(),
            pid: std::process::id(),
        };
        file.set_len(0)?;
        serde_json::to_writer(&mut file, &owner)?;
        file.write_all(b"\n")?;
        file.sync_data()?;

        // Windows prevents other processes from reading the exclusively locked
        // file. This separate observation is advisory: publication failure or
        // stale metadata must never become migration or lock-recovery authority.
        let _ = Self::publish_owner(&owner_path, &owner);
        Ok(Self { file })
    }

    fn is_contention(error: &std::io::Error) -> bool {
        error
            .raw_os_error()
            .is_some_and(|code| Some(code) == fs2::lock_contended_error().raw_os_error())
    }

    fn publish_owner(path: &Path, owner: &MigrationLockOwner) -> Result<()> {
        crate::path::refuse_symlink_ancestors(path)?;
        match std::fs::symlink_metadata(path) {
            Ok(metadata) if !metadata.is_file() => {
                return Err(PortcoveError::state(
                    "migration owner diagnostics require a regular file",
                ));
            }
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                return Err(error.into());
            }
            _ => {}
        }
        crate::durability::write_json_atomically(path, owner, true)
    }

    fn observed_owner(path: &Path) -> Option<MigrationLockOwner> {
        let bytes =
            crate::external_runtime::read_stable_metadata(path, MIGRATION_OWNER_LIMIT).ok()?;
        let owner: MigrationLockOwner = serde_json::from_slice(&bytes).ok()?;
        (owner.operation == "database_migration" && owner.pid != 0).then_some(owner)
    }

    fn timeout_error(owner_path: &Path, timeout: Duration) -> PortcoveError {
        let error = PortcoveError::conflict(
            "timed out waiting for the library migration lock; wait for the other operation to finish, then retry",
        )
        .with_known_cause(crate::failure::KnownFailureCause::Busy)
        .detail("wait_timeout_ms", timeout.as_millis().to_string());
        match Self::observed_owner(owner_path) {
            Some(owner) => error
                .detail("owner_metadata", "last observed; may be stale")
                .detail("observed_operation", owner.operation)
                .detail("observed_pid", owner.pid.to_string()),
            None => error.detail("owner_metadata", "unavailable"),
        }
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
    crate::runtime_diagnostics::observe_host_result(
        "database_migration",
        migrate_to(root, CURRENT_SCHEMA_VERSION),
    )
}

pub(crate) fn requires_migration(root: &Path) -> Result<bool> {
    crate::runtime_diagnostics::observe_host_result("database_open", inspect_migration(root))
}

fn inspect_migration(root: &Path) -> Result<bool> {
    let path = database_path(root);
    if !path.exists() {
        return Ok(true);
    }
    let connection = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let has_ledger: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations')",
        [], |row| row.get(0),
    )?;
    if !has_ledger {
        return Ok(true);
    }
    let versions = recorded_versions(&connection)?;
    validate_recorded_versions(&versions)?;
    Ok(versions.last().copied().unwrap_or_default() < CURRENT_SCHEMA_VERSION)
}

fn migrate_to(root: &Path, target_version: i64) -> Result<()> {
    let _lock = MigrationLock::acquire(root)?;
    let fresh_database = !database_path(root).try_exists()?;
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

    let pending = MIGRATIONS
        .iter()
        .skip(applied.len())
        .take(target_version.saturating_sub(applied.len() as i64) as usize);
    if fresh_database && applied.is_empty() {
        initialize_fresh_schema(&mut connection, pending)?;
    } else {
        for migration in pending {
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            apply_recorded_migration(&transaction, migration)?;
            transaction.commit()?;
        }
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

fn apply_recorded_migration(transaction: &Transaction<'_>, migration: &Migration) -> Result<()> {
    (migration.apply)(transaction).map_err(|error| migration_failure(migration, error))?;
    (migration.verify)(transaction).map_err(|error| migration_failure(migration, error))?;
    transaction.execute(
        "INSERT INTO schema_migrations(version, applied_at) VALUES (?1, unixepoch())",
        [migration.version],
    )?;
    Ok(())
}

fn initialize_fresh_schema<'a>(
    connection: &mut Connection,
    migrations: impl Iterator<Item = &'a Migration>,
) -> Result<()> {
    // A new database has no released schema to preserve between versions.
    // Publish its complete verified schema once; failure leaves no partial history.
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    for migration in migrations {
        apply_recorded_migration(&transaction, migration)?;
    }
    transaction.commit()?;
    Ok(())
}

fn database_path(root: &Path) -> PathBuf {
    root.join("portcove.sqlite3")
}

/// Project an owned current fixture onto the real schema-33 migration history.
/// Callers must close SQLite connections first; a Library lease may remain live
/// so the fixture can exercise the normal refusal to upgrade beneath a client.
#[cfg(test)]
pub(crate) fn recreate_schema_33_fixture(root: &Path) -> Result<()> {
    // This is the supported historical payload, not a second schema definition.
    // The real migrations still create every table, index and constraint.
    const TABLES: &[(&str, &str)] = &[
        (
            "sources",
            "profile_id,path,sha256,size,updated_at,storage_sha256,storage_size,observed_identity_json",
        ),
        (
            "installs",
            "id,port_id,version,path,channel,installed_at,verified,staged,artifact_name,artifact_sha256,artifact_size,manifest_sha256,selected_executable,runtime_json",
        ),
        (
            "port_settings",
            "port_id,channel,update_policy,active_install_id,previous_install_id,output_directory",
        ),
        (
            "github_http_cache",
            "url,etag,last_modified,body,updated_at",
        ),
        (
            "launch_history",
            "port_id,last_launched_at,successful_launches",
        ),
        (
            "activity_history",
            "id,operation,target_kind,target_id,status,message,started_at,finished_at,cancellation_phase,cancel_requested,cancellation_owner,failure_json,import_receipt_sha256",
        ),
        ("update_snapshots", "port_id,check_json,checked_at"),
        (
            "lifecycle_operations",
            "id,kind,port_id,phase,staging_path,final_path,quarantine_path,install_json,original_paths_json,activate,last_error,created_at,updated_at,relocation_json,source_import_json,preparation_json,preparation_process_quiesced",
        ),
        ("catalog_trust", "key_id,public_key"),
        (
            "catalog_state",
            "singleton,revision,highest_sequence,enabled,active,previous",
        ),
        (
            "launch_sessions",
            "id,port_id,install_id,install_root,supervisor_pid,supervisor_identity,child_pid,child_identity,phase,outcome,exit_code,message,started_at,updated_at,finished_at,owner_kind",
        ),
        ("library_identity", "singleton,id"),
        (
            "output_roots",
            "path,port_id,marker_id,volume_identity,created_at",
        ),
        (
            "activity_diagnostics",
            "activity_id,phase,payload,updated_at,payload_bytes",
        ),
        ("artwork_assets", "sha256,payload,byte_size"),
        ("artwork_choices", "port_id,slot,revision,asset_sha256"),
        (
            "artwork_thumbnails",
            "asset_sha256,format_version,sha256,byte_size",
        ),
        (
            "definition_publisher_policy",
            "namespace,stable_id,root_sha256,policy_revision,grant_id,status",
        ),
        (
            "definition_selection_state",
            "singleton,revision,replay_floor_json,active_json,previous_json",
        ),
        ("game_file_roots", "id,path,path_key,created_at,updated_at"),
        ("game_file_scan_state", "singleton,snapshot_json"),
        (
            "external_runtime_registrations",
            "port_id,record_json,retained_catalog_json,registered_at",
        ),
        (
            "definition_publisher_authority",
            "anchor_sha256,trusted_root_json,replay_floor_json",
        ),
        (
            "definition_publisher_admission",
            "namespace,stable_id,anchor_sha256,policy_json,provenance_json",
        ),
    ];
    fn quote_identifier(value: &str) -> String {
        format!("\"{}\"", value.replace('"', "\"\""))
    }

    let historical = tempfile::tempdir_in(root)?;
    std::fs::create_dir_all(historical.path().join("locks"))?;
    migrate_to(historical.path(), 33)?;
    let mut connection = connect(historical.path())?;
    connection.pragma_update(None, "journal_mode", "DELETE")?;
    connection.execute(
        "ATTACH DATABASE ?1 AS fixture_source",
        [database_path(root).to_string_lossy().into_owned()],
    )?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    transaction.pragma_update(None, "defer_foreign_keys", "ON")?;
    let source_tables = transaction
        .prepare(
            "SELECT name FROM fixture_source.sqlite_master
             WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='schema_migrations'",
        )?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    for table in source_tables {
        let quoted_table = quote_identifier(&table);
        let columns = transaction
            .prepare(&format!("PRAGMA fixture_source.table_info({quoted_table})"))?
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let Some((_, historical_columns)) = TABLES.iter().find(|(name, _)| *name == table) else {
            // Migration 36 installs this empty-history sentinel on every fresh
            // database. Nonzero counters are meaningful unsupported state.
            let condition = if table == "curated_artifact_history"
                && columns
                    == [
                        "singleton",
                        "admission_count",
                        "transition_count",
                        "scope_count",
                    ] {
                "singleton!=1 OR admission_count!=0 OR transition_count!=0 OR scope_count!=0"
            } else {
                "1"
            };
            let populated: bool = transaction.query_row(
                &format!(
                    "SELECT EXISTS(SELECT 1 FROM fixture_source.{quoted_table} WHERE {condition})"
                ),
                [],
                |row| row.get(0),
            )?;
            if populated {
                return Err(PortcoveError::state(format!(
                    "schema-33 fixture cannot discard populated table {table}"
                )));
            }
            continue;
        };
        for column in columns {
            if historical_columns.split(',').any(|name| name == column) {
                continue;
            }
            let quoted_column = quote_identifier(&column);
            let condition = match (table.as_str(), column.as_str()) {
                // Schema 33 had no evidence of earlier authorization continuity.
                ("definition_publisher_admission", "retained_launch_revision_floor") => continue,
                ("definition_publisher_admission", "launch_assessment_revision") => {
                    format!("{quoted_column}!=0")
                }
                (
                    "lifecycle_operations",
                    "ghostship_recovery_json"
                    | "backup_deletion_json"
                    | "external_registration_sha256",
                ) => {
                    format!("{quoted_column} IS NOT NULL")
                }
                _ => "1".to_owned(),
            };
            let populated: bool = transaction.query_row(
                &format!(
                    "SELECT EXISTS(SELECT 1 FROM fixture_source.{quoted_table} WHERE {condition})"
                ),
                [],
                |row| row.get(0),
            )?;
            if populated {
                return Err(PortcoveError::state(format!(
                    "schema-33 fixture cannot discard column {table}.{column}"
                )));
            }
        }
    }
    for (table, columns) in TABLES {
        let actual_columns = table_columns(&transaction, table)?;
        if actual_columns
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>()
            != columns.split(',').collect::<Vec<_>>()
        {
            return Err(PortcoveError::state(format!(
                "schema-33 fixture column declaration differs for {table}"
            )));
        }
        transaction.execute_batch(&format!(
            "DELETE FROM main.{table};
             INSERT INTO main.{table}({columns}) SELECT {columns} FROM fixture_source.{table};"
        ))?;
    }
    let invalid_foreign_keys: bool = transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_foreign_key_check)",
        [],
        |row| row.get(0),
    )?;
    if invalid_foreign_keys {
        return Err(PortcoveError::state(
            "schema-33 fixture contains invalid historical foreign keys",
        ));
    }
    for migration in MIGRATIONS.iter().take(33) {
        (migration.verify)(&transaction)?;
    }
    transaction.commit()?;
    connection.close().map_err(|(_, error)| error)?;

    // Both files must be self-contained before replacing the fixture database.
    // This also removes the current database's WAL sidecars on Windows.
    let source = connect(root)?;
    source.pragma_update(None, "journal_mode", "DELETE")?;
    source.close().map_err(|(_, error)| error)?;
    std::fs::rename(database_path(historical.path()), database_path(root))?;
    Ok(())
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
        .with_known_cause(crate::failure::KnownFailureCause::NewerLibrary)
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
            .with_known_cause(crate::failure::KnownFailureCause::IncompleteLibrary)
            .detail("expected_version", expected.to_string())
            .detail("recorded_version", version.to_string()));
        }
    }
    Ok(())
}

fn verify_recorded_migration(connection: &Connection, migration: &Migration) -> Result<()> {
    (migration.verify)(connection).map_err(|error| {
        PortcoveError::state("a recorded database migration is only partially applied")
            .with_known_cause(crate::failure::KnownFailureCause::IncompleteLibrary)
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

fn migration_13(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        "ALTER TABLE launch_sessions RENAME TO launch_sessions_v9;
         DROP INDEX IF EXISTS launch_sessions_install_id;
         CREATE TABLE launch_sessions (
           id TEXT PRIMARY KEY,
           port_id TEXT NOT NULL,
           install_id TEXT NOT NULL,
           install_root TEXT NOT NULL,
           supervisor_pid INTEGER NOT NULL,
           supervisor_identity TEXT,
           child_pid INTEGER,
           child_identity TEXT,
           phase TEXT NOT NULL CHECK(phase IN ('preparing','spawning','running','collecting','recovering')),
           outcome TEXT CHECK(outcome IN ('succeeded','failed','cancelled')),
           exit_code INTEGER,
           message TEXT,
           started_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL,
           finished_at INTEGER
         );
         INSERT INTO launch_sessions(
           id, port_id, install_id, install_root, supervisor_pid, child_pid, phase,
           started_at, updated_at
         )
         SELECT id, port_id, install_id, install_root, supervisor_pid, child_pid, phase,
                started_at, updated_at
         FROM launch_sessions_v9;
         DROP TABLE launch_sessions_v9;
         CREATE INDEX launch_sessions_install_id ON launch_sessions(install_id);
         CREATE UNIQUE INDEX launch_sessions_active_port
           ON launch_sessions(port_id) WHERE outcome IS NULL;",
    )?;
    Ok(())
}

fn verify_migration_13(connection: &Connection) -> Result<()> {
    require_columns(
        connection,
        "launch_sessions",
        &[
            "id",
            "port_id",
            "install_id",
            "install_root",
            "supervisor_pid",
            "supervisor_identity",
            "child_pid",
            "child_identity",
            "phase",
            "outcome",
            "exit_code",
            "message",
            "started_at",
            "updated_at",
            "finished_at",
        ],
    )?;
    require_index(connection, "launch_sessions_install_id")?;
    require_index(connection, "launch_sessions_active_port")
}

fn migration_14(transaction: &Transaction<'_>) -> Result<()> {
    if !table_columns(transaction, "port_settings")?
        .iter()
        .any(|column| column == "output_directory")
    {
        transaction.execute(
            "ALTER TABLE port_settings ADD COLUMN output_directory TEXT",
            [],
        )?;
    }
    Ok(())
}

fn verify_migration_14(connection: &Connection) -> Result<()> {
    require_columns(connection, "port_settings", &["output_directory"])
}

fn migration_15(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        "CREATE TABLE IF NOT EXISTS library_identity (
           singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
           id TEXT NOT NULL CHECK(length(id) = 32)
         );
         INSERT OR IGNORE INTO library_identity(singleton, id)
         VALUES (1, lower(hex(randomblob(16))));
         CREATE TABLE IF NOT EXISTS output_roots (
           path TEXT PRIMARY KEY,
           port_id TEXT NOT NULL,
           marker_id TEXT NOT NULL UNIQUE,
           volume_identity TEXT NOT NULL,
           created_at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS output_roots_port_id ON output_roots(port_id);",
    )?;
    Ok(())
}

fn verify_migration_15(connection: &Connection) -> Result<()> {
    require_columns(connection, "library_identity", &["singleton", "id"])?;
    require_columns(
        connection,
        "output_roots",
        &[
            "path",
            "port_id",
            "marker_id",
            "volume_identity",
            "created_at",
        ],
    )?;
    require_index(connection, "output_roots_port_id")?;
    let identity_count: i64 = connection.query_row(
        "SELECT count(*) FROM library_identity WHERE singleton=1 AND length(id)=32",
        [],
        |row| row.get(0),
    )?;
    if identity_count != 1 {
        return Err(PortcoveError::state(
            "library identity is missing or invalid after migration",
        ));
    }
    Ok(())
}

fn migration_16(transaction: &Transaction<'_>) -> Result<()> {
    if !table_columns(transaction, "lifecycle_operations")?
        .iter()
        .any(|column| column == "relocation_json")
    {
        transaction.execute(
            "ALTER TABLE lifecycle_operations ADD COLUMN relocation_json TEXT",
            [],
        )?;
    }
    Ok(())
}

fn verify_migration_16(connection: &Connection) -> Result<()> {
    require_columns(connection, "lifecycle_operations", &["relocation_json"])
}

fn migration_17(transaction: &Transaction<'_>) -> Result<()> {
    let columns = table_columns(transaction, "sources")?;
    if !columns
        .iter()
        .any(|column| column == "observed_identity_json")
    {
        transaction.execute(
            "ALTER TABLE sources ADD COLUMN observed_identity_json TEXT",
            [],
        )?;
    }
    Ok(())
}

fn verify_migration_17(connection: &Connection) -> Result<()> {
    require_columns(connection, "sources", &["observed_identity_json"])
}

fn migration_18(transaction: &Transaction<'_>) -> Result<()> {
    if !table_columns(transaction, "lifecycle_operations")?
        .iter()
        .any(|column| column == "source_import_json")
    {
        transaction.execute(
            "ALTER TABLE lifecycle_operations ADD COLUMN source_import_json TEXT",
            [],
        )?;
    }
    Ok(())
}

fn verify_migration_18(connection: &Connection) -> Result<()> {
    require_columns(connection, "lifecycle_operations", &["source_import_json"])
}

fn migration_23(transaction: &Transaction<'_>) -> Result<()> {
    // No table layout changes: the migration ledger is also the library writer
    // protocol. Older clients must refuse this library before they can replace
    // a schema-6 manifest with one that discards its retained contracts.
    verify_migration_23(transaction)
}

fn migration_25(transaction: &Transaction<'_>) -> Result<()> {
    // Older writers cannot preserve format-2 exact successor contracts. Advance
    // the existing writer protocol under the same exclusive migration lease.
    verify_migration_23(transaction)
}

fn migration_27(transaction: &Transaction<'_>) -> Result<()> {
    // Older writers cannot preserve format-3 authenticated admission provenance
    // while refreshing a schema-6 manifest. Advance the protocol before any new
    // selected-definition installation can be published.
    verify_migration_26(transaction)
}

fn migration_28(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        "ALTER TABLE lifecycle_operations
           ADD COLUMN preparation_process_quiesced INTEGER
           CHECK(preparation_process_quiesced IN (0,1));",
    )?;
    Ok(())
}

fn verify_migration_28(connection: &Connection) -> Result<()> {
    require_columns(
        connection,
        "lifecycle_operations",
        &["preparation_process_quiesced"],
    )
}

fn migration_29(transaction: &Transaction<'_>) -> Result<()> {
    transaction
        .execute_batch("ALTER TABLE activity_history ADD COLUMN import_receipt_sha256 TEXT;")?;
    verify_migration_29(transaction)
}

fn verify_migration_29(connection: &Connection) -> Result<()> {
    require_columns(connection, "activity_history", &["import_receipt_sha256"])
}

fn migration_30(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        "CREATE TABLE game_file_roots (
            id TEXT PRIMARY KEY,
            path TEXT NOT NULL,
            path_key TEXT NOT NULL UNIQUE,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );",
    )?;
    verify_migration_30(transaction)
}

fn verify_migration_30(connection: &Connection) -> Result<()> {
    require_columns(
        connection,
        "game_file_roots",
        &["id", "path", "path_key", "created_at", "updated_at"],
    )
}

fn migration_31(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        "CREATE TABLE game_file_scan_state (
            singleton INTEGER PRIMARY KEY CHECK(singleton=1),
            snapshot_json TEXT NOT NULL CHECK(length(snapshot_json)<=8388608)
        );",
    )?;
    verify_migration_31(transaction)
}

fn verify_migration_31(connection: &Connection) -> Result<()> {
    require_columns(
        connection,
        "game_file_scan_state",
        &["singleton", "snapshot_json"],
    )
}

fn verify_migration_26(connection: &Connection) -> Result<()> {
    require_columns(
        connection,
        "definition_publisher_policy",
        &[
            "namespace",
            "stable_id",
            "root_sha256",
            "policy_revision",
            "grant_id",
            "status",
        ],
    )?;
    require_columns(
        connection,
        "definition_selection_state",
        &[
            "singleton",
            "revision",
            "replay_floor_json",
            "active_json",
            "previous_json",
        ],
    )
}

fn verify_migration_24(connection: &Connection) -> Result<()> {
    require_columns(
        connection,
        "artwork_assets",
        &["sha256", "payload", "byte_size"],
    )?;
    require_columns(
        connection,
        "artwork_choices",
        &["port_id", "slot", "revision", "asset_sha256"],
    )?;
    require_columns(
        connection,
        "artwork_thumbnails",
        &["asset_sha256", "format_version", "sha256", "byte_size"],
    )
}

fn verify_migration_23(connection: &Connection) -> Result<()> {
    require_columns(
        connection,
        "installs",
        &["manifest_sha256", "selected_executable"],
    )
}

fn migration_22(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch("ALTER TABLE activity_diagnostics RENAME TO activity_diagnostics_v21;
        CREATE TABLE activity_diagnostics (
            activity_id TEXT NOT NULL REFERENCES activity_history(id) ON DELETE CASCADE,
            phase TEXT NOT NULL,
            payload TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            payload_bytes INTEGER NOT NULL CHECK(payload_bytes>=0),
            PRIMARY KEY(activity_id,phase)
        );
        INSERT INTO activity_diagnostics(activity_id,phase,payload,updated_at,payload_bytes)
            SELECT activity_id,'preparation.setup',payload,updated_at,payload_bytes FROM activity_diagnostics_v21;
        DROP TABLE activity_diagnostics_v21;")?;
    Ok(())
}

fn verify_migration_22(connection: &Connection) -> Result<()> {
    require_columns(
        connection,
        "activity_diagnostics",
        &[
            "activity_id",
            "phase",
            "payload",
            "updated_at",
            "payload_bytes",
        ],
    )
}

fn migration_21(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        "CREATE TABLE IF NOT EXISTS activity_diagnostics (
            activity_id TEXT PRIMARY KEY REFERENCES activity_history(id) ON DELETE CASCADE,
            payload TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            payload_bytes INTEGER NOT NULL CHECK(payload_bytes>=0)
        );",
    )?;
    Ok(())
}

fn verify_migration_21(connection: &Connection) -> Result<()> {
    require_columns(
        connection,
        "activity_diagnostics",
        &["activity_id", "payload", "updated_at", "payload_bytes"],
    )
}

fn migration_20(transaction: &Transaction<'_>) -> Result<()> {
    if !table_columns(transaction, "activity_history")?
        .iter()
        .any(|column| column == "failure_json")
    {
        transaction.execute(
            "ALTER TABLE activity_history ADD COLUMN failure_json TEXT",
            [],
        )?;
    }
    Ok(())
}

fn verify_migration_20(connection: &Connection) -> Result<()> {
    require_columns(connection, "activity_history", &["failure_json"])
}

fn migration_19(transaction: &Transaction<'_>) -> Result<()> {
    if !table_columns(transaction, "lifecycle_operations")?
        .iter()
        .any(|column| column == "preparation_json")
    {
        transaction.execute(
            "ALTER TABLE lifecycle_operations ADD COLUMN preparation_json TEXT",
            [],
        )?;
    }
    Ok(())
}

fn verify_migration_19(connection: &Connection) -> Result<()> {
    require_columns(connection, "lifecycle_operations", &["preparation_json"])
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

    use sha2::{Digest, Sha256};
    use tempfile::tempdir;

    use super::*;

    fn prepare_root(root: &Path) {
        fs::create_dir_all(root.join("locks")).unwrap();
    }

    struct MigrationHolder {
        child: std::process::Child,
        root: PathBuf,
        log: PathBuf,
    }

    impl MigrationHolder {
        fn start(root: &Path) -> Self {
            let log = root.join("migration-holder.log");
            let output = File::create(&log).unwrap();
            let mut command = crate::ChildProcessPolicy::native_command(
                crate::ChildProcessClass::HostTool,
                std::env::current_exe().unwrap(),
            )
            .unwrap();
            command
                .args([
                    "--exact",
                    "database::tests::migration_lock_holder_child",
                    "--ignored",
                    "--nocapture",
                ])
                .env("PORTCOVE_MIGRATION_LOCK_TEST_ROOT", root)
                .stdin(std::process::Stdio::null())
                .stdout(output.try_clone().unwrap())
                .stderr(output);
            let mut holder = Self {
                child: command.spawn().unwrap(),
                root: root.to_owned(),
                log,
            };
            let started = Instant::now();
            while !root.join("migration-holder-ready").exists() {
                assert!(
                    holder.child.try_wait().unwrap().is_none()
                        && started.elapsed() < Duration::from_secs(5),
                    "migration holder did not become ready: {}",
                    fs::read_to_string(&holder.log).unwrap_or_default()
                );
                thread::sleep(Duration::from_millis(10));
            }
            holder
        }

        fn release(mut self) {
            fs::write(self.root.join("migration-holder-release"), b"release").unwrap();
            let started = Instant::now();
            loop {
                if let Some(status) = self.child.try_wait().unwrap() {
                    assert!(
                        status.success(),
                        "migration holder failed: {}",
                        fs::read_to_string(&self.log).unwrap_or_default()
                    );
                    break;
                }
                assert!(
                    started.elapsed() < Duration::from_secs(5),
                    "migration holder did not release its lock"
                );
                thread::sleep(Duration::from_millis(10));
            }
        }

        fn interrupt(mut self) {
            self.child.kill().unwrap();
            self.child.wait().unwrap();
        }
    }

    impl Drop for MigrationHolder {
        fn drop(&mut self) {
            // Reap only this fixture's owned child, including assertion failures.
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }

    #[test]
    #[ignore = "invoked explicitly by migration-lock subprocess tests"]
    fn migration_lock_holder_child() {
        let root = PathBuf::from(std::env::var_os("PORTCOVE_MIGRATION_LOCK_TEST_ROOT").unwrap());
        let _lock = MigrationLock::acquire(&root).unwrap();
        fs::write(root.join("migration-holder-ready"), b"ready").unwrap();
        let started = Instant::now();
        while !root.join("migration-holder-release").exists() {
            assert!(
                started.elapsed() < Duration::from_secs(15),
                "migration holder exceeded its fixture lifetime"
            );
            thread::sleep(Duration::from_millis(10));
        }
    }

    fn assert_migration_recovers(root: &Path) {
        migrate(root).unwrap();
        assert_eq!(
            recorded_versions(&connect(root).unwrap()).unwrap(),
            (1..=CURRENT_SCHEMA_VERSION).collect::<Vec<_>>()
        );
    }

    #[test]
    fn migration_lock_times_out_with_observed_owner_and_recovers_after_release() {
        let temporary = tempdir().unwrap();
        let root = fs::canonicalize(temporary.path())
            .unwrap()
            .join("library with spaces");
        prepare_root(&root);
        let holder = MigrationHolder::start(&root);
        let owner_path = root.join("locks/migration.owner.json");
        let owner_before = fs::read(&owner_path).unwrap();
        let wait = Duration::from_millis(150);
        let started = Instant::now();
        let error = MigrationLock::acquire_with_timeout(&root, wait)
            .err()
            .expect("the other process still owns the migration lock");
        assert!(started.elapsed() >= wait);
        assert!(started.elapsed() < Duration::from_secs(5));
        assert_eq!(error.code, crate::ErrorCode::Conflict);
        assert_eq!(error.details["wait_timeout_ms"], "150");
        assert_eq!(error.details["observed_operation"], "database_migration");
        assert_eq!(error.details["observed_pid"], holder.child.id().to_string());
        assert_eq!(
            error.details["owner_metadata"],
            "last observed; may be stale"
        );
        assert!(!database_path(&root).exists());
        assert_eq!(fs::read(&owner_path).unwrap(), owner_before);
        holder.release();
        assert_migration_recovers(&root);
    }

    #[test]
    fn migration_lock_waits_for_release_within_its_deadline() {
        let temporary = tempdir().unwrap();
        let canonical_root = fs::canonicalize(temporary.path()).unwrap();
        let root = canonical_root.as_path();
        prepare_root(root);
        let holder = MigrationHolder::start(root);
        let (started_send, started_receive) = std::sync::mpsc::channel();
        let (acquired_send, acquired_receive) = std::sync::mpsc::channel();
        thread::scope(|scope| {
            let waiter = scope.spawn(|| {
                started_send.send(()).unwrap();
                let _lock = MigrationLock::acquire_with_timeout(root, Duration::from_secs(3))
                    .expect("the holder is released before the acquisition deadline");
                acquired_send.send(()).unwrap();
            });
            started_receive
                .recv_timeout(Duration::from_secs(1))
                .unwrap();
            assert_eq!(
                acquired_receive.recv_timeout(Duration::from_millis(150)),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout)
            );
            holder.release();
            acquired_receive
                .recv_timeout(Duration::from_secs(3))
                .unwrap();
            waiter.join().unwrap();
        });
        assert_migration_recovers(root);
    }

    #[test]
    fn migration_lock_recovers_after_holder_interruption_and_stale_owner_metadata() {
        let temporary = tempdir().unwrap();
        let canonical_root = fs::canonicalize(temporary.path()).unwrap();
        let root = canonical_root.as_path();
        prepare_root(root);
        let holder = MigrationHolder::start(root);
        let owner_path = root.join("locks/migration.owner.json");
        let stale_owner = fs::read(&owner_path).unwrap();
        holder.interrupt();
        assert_eq!(fs::read(&owner_path).unwrap(), stale_owner);
        let lock = MigrationLock::acquire_with_timeout(root, Duration::from_millis(150)).unwrap();
        assert_eq!(
            MigrationLock::observed_owner(&owner_path).unwrap().pid,
            std::process::id()
        );
        drop(lock);
        assert_migration_recovers(root);
    }

    #[test]
    fn migration_lock_rejects_untrusted_owner_metadata_without_leaking_it() {
        let temporary = tempdir().unwrap();
        let canonical_root = fs::canonicalize(temporary.path()).unwrap();
        let root = canonical_root.as_path();
        prepare_root(root);
        let holder = MigrationHolder::start(root);
        let owner_path = root.join("locks/migration.owner.json");
        let mut boundary = fs::read(&owner_path).unwrap();
        boundary.resize(MIGRATION_OWNER_LIMIT as usize, b' ');
        fs::write(&owner_path, &boundary).unwrap();
        let error = MigrationLock::acquire_with_timeout(root, Duration::ZERO)
            .err()
            .expect("valid owner metadata cannot release the OS lock");
        assert_eq!(error.details["observed_operation"], "database_migration");
        assert_eq!(error.details["observed_pid"], holder.child.id().to_string());
        assert_eq!(fs::read(&owner_path).unwrap(), boundary);
        boundary.push(b' ');
        let mut invalid = vec![
            b"".to_vec(),
            br#"{"operation":"database_migration","pid":"private-canary"}"#.to_vec(),
            br#"{"operation":"private-canary","pid":42}"#.to_vec(),
            br#"{"operation":"database_migration","pid":42,"secret":"private-canary"}"#.to_vec(),
            br#"{"operation":"database_migration","pid":42,"pid":43}"#.to_vec(),
            br#"{"operation":"database_migration","pid":0}"#.to_vec(),
            br#"{"operation":"database_migration","pid":-1}"#.to_vec(),
            br#"{"operation":"database_migration","pid":1.5}"#.to_vec(),
            br#"{"operation":"database_migration","pid":4294967296}"#.to_vec(),
            br#"{"operation":"database_migration"}"#.to_vec(),
            br#"{"pid":42}"#.to_vec(),
            br#"{"operation":"database_migration","pid":"#.to_vec(),
            br#"["private-canary"]"#.to_vec(),
        ];
        invalid.push(boundary);
        for record in invalid {
            fs::write(&owner_path, &record).unwrap();
            let error = MigrationLock::acquire_with_timeout(root, Duration::ZERO)
                .err()
                .expect("metadata cannot grant access to a held OS lock");
            assert_eq!(error.code, crate::ErrorCode::Conflict);
            assert_eq!(error.details["owner_metadata"], "unavailable");
            assert_eq!(error.details.len(), 2);
            assert!(!format!("{error:?}").contains("private-canary"));
            assert_eq!(fs::read(&owner_path).unwrap(), record);
        }
        fs::remove_file(&owner_path).unwrap();
        let error = MigrationLock::acquire_with_timeout(root, Duration::ZERO)
            .err()
            .expect("missing metadata cannot release the OS lock");
        assert_eq!(error.details["owner_metadata"], "unavailable");
        holder.release();
        assert_migration_recovers(root);
    }

    #[test]
    fn migration_lock_owner_publication_failure_does_not_prevent_migration() {
        let temporary = tempdir().unwrap();
        let canonical_root = fs::canonicalize(temporary.path()).unwrap();
        let root = canonical_root.as_path();
        prepare_root(root);
        let owner_path = root.join("locks/migration.owner.json");
        fs::create_dir(&owner_path).unwrap();
        let holder = MigrationHolder::start(root);
        let error = MigrationLock::acquire_with_timeout(root, Duration::ZERO)
            .err()
            .expect("diagnostic publication failure cannot weaken the OS lock");
        assert_eq!(error.details["owner_metadata"], "unavailable");
        holder.release();
        assert_migration_recovers(root);
        assert!(owner_path.is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn migration_lock_owner_symlink_is_not_read_or_overwritten() {
        let temporary = tempdir().unwrap();
        let canonical_root = fs::canonicalize(temporary.path()).unwrap();
        let root = canonical_root.as_path();
        prepare_root(root);
        let target = root.join("private-owner-canary");
        let contents = br#"{"operation":"database_migration","pid":42}"#;
        fs::write(&target, contents).unwrap();
        let owner_path = root.join("locks/migration.owner.json");
        std::os::unix::fs::symlink(&target, &owner_path).unwrap();
        let holder = MigrationHolder::start(root);
        let error = MigrationLock::acquire_with_timeout(root, Duration::ZERO)
            .err()
            .expect("linked metadata is not lock authority");
        assert_eq!(error.details["owner_metadata"], "unavailable");
        holder.release();
        assert_migration_recovers(root);
        assert_eq!(fs::read(&target).unwrap(), contents);
        assert!(
            fs::symlink_metadata(&owner_path)
                .unwrap()
                .file_type()
                .is_symlink()
        );
    }

    #[cfg(unix)]
    #[test]
    fn migration_lock_owner_fifo_does_not_block_timeout_or_migration() {
        use std::os::unix::{ffi::OsStrExt, fs::FileTypeExt};
        let temporary = tempdir().unwrap();
        let canonical_root = fs::canonicalize(temporary.path()).unwrap();
        let root = canonical_root.as_path();
        prepare_root(root);
        let owner_path = root.join("locks/migration.owner.json");
        let name = std::ffi::CString::new(owner_path.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        let holder = MigrationHolder::start(root);
        let started = Instant::now();
        let error = MigrationLock::acquire_with_timeout(root, Duration::ZERO)
            .err()
            .expect("a FIFO cannot provide owner metadata or release the OS lock");
        assert!(started.elapsed() < Duration::from_secs(5));
        assert_eq!(error.details["owner_metadata"], "unavailable");
        holder.release();
        assert_migration_recovers(root);
        assert!(
            fs::symlink_metadata(&owner_path)
                .unwrap()
                .file_type()
                .is_fifo()
        );
    }

    #[test]
    fn migration_lock_classifies_only_the_os_contention_code() {
        let contention = fs2::lock_contended_error();
        assert!(MigrationLock::is_contention(&contention));
        assert!(!MigrationLock::is_contention(&std::io::Error::new(
            contention.kind(),
            "same kind without the contention OS code",
        )));
        #[cfg(windows)]
        for code in [6, 50] {
            // Invalid-handle and unsupported-lock errors share the contention
            // error's broad kind on Windows, but must retain their real cause.
            let other = std::io::Error::from_raw_os_error(code);
            assert_eq!(other.kind(), contention.kind());
            assert!(!MigrationLock::is_contention(&other));
        }
    }

    #[test]
    fn migration_lock_non_contention_failure_returns_without_waiting() {
        let temporary = tempdir().unwrap();
        let canonical_root = fs::canonicalize(temporary.path()).unwrap();
        let root = canonical_root.as_path();
        prepare_root(root);
        fs::create_dir(root.join("locks/migration.lock")).unwrap();
        let started = Instant::now();
        let error = MigrationLock::acquire(root)
            .err()
            .expect("a directory cannot be the migration lock file");
        assert!(started.elapsed() < Duration::from_secs(5));
        assert_eq!(error.code, crate::ErrorCode::State);
        assert!(!error.details.contains_key("wait_timeout_ms"));
        assert!(!database_path(root).exists());
    }

    #[test]
    fn failed_fresh_schema_initialization_rolls_back_every_version() {
        let temporary = tempdir().unwrap();
        let root = temporary.path();
        prepare_root(root);
        let mut connection = connect(root).unwrap();
        connection.execute_batch(
            "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
             CREATE TABLE retained_marker(value TEXT NOT NULL);
             INSERT INTO retained_marker VALUES ('preserved');",
        ).unwrap();
        let failing = Migration {
            verify: |_| Err(PortcoveError::state("injected verification failure")),
            ..MIGRATIONS[1]
        };
        let error =
            initialize_fresh_schema(&mut connection, [&MIGRATIONS[0], &failing].into_iter())
                .unwrap_err();
        assert!(
            error.details["cause"].contains("injected verification failure"),
            "{error}"
        );
        assert_eq!(error.details["migration_version"], "2");
        assert!(recorded_versions(&connection).unwrap().is_empty());
        for table in ["installs", "sources", "github_http_cache"] {
            assert!(
                table_columns(&connection, table).unwrap().is_empty(),
                "{table}"
            );
        }
        assert_eq!(
            connection
                .query_row("SELECT value FROM retained_marker", [], |row| row
                    .get::<_, String>(0))
                .unwrap(),
            "preserved"
        );
        drop(connection);
        migrate(root).unwrap();
        assert_eq!(
            recorded_versions(&connect(root).unwrap()).unwrap(),
            (1..=CURRENT_SCHEMA_VERSION).collect::<Vec<_>>()
        );
    }

    #[test]
    fn existing_unversioned_database_keeps_completed_versions_on_later_failure() {
        let temporary = tempdir().unwrap();
        let root = temporary.path();
        prepare_root(root);
        let connection = connect(root).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE github_http_cache(retained TEXT NOT NULL);
             INSERT INTO github_http_cache VALUES ('preserved');",
            )
            .unwrap();
        drop(connection);
        let error = migrate_to(root, 2).unwrap_err();
        assert!(
            error.details["cause"].contains("required database column"),
            "{error}"
        );
        let connection = connect(root).unwrap();
        assert_eq!(error.details["migration_version"], "2");
        assert_eq!(recorded_versions(&connection).unwrap(), vec![1]);
        (MIGRATIONS[0].verify)(&connection).unwrap();
        assert_eq!(
            connection
                .query_row("SELECT retained FROM github_http_cache", [], |row| row
                    .get::<_, String>(
                    0
                ))
                .unwrap(),
            "preserved"
        );
    }

    #[test]
    fn fresh_schema_matches_existing_unversioned_initialization() {
        let temporary = tempdir().unwrap();
        let fresh = temporary.path().join("fresh");
        let upgraded = temporary.path().join("upgraded");
        prepare_root(&fresh);
        prepare_root(&upgraded);
        drop(connect(&upgraded).unwrap());
        crate::test_fixture::phase("fresh schema: one publication", || migrate(&fresh).unwrap());
        crate::test_fixture::phase("existing schema: per-version publications", || {
            migrate(&upgraded).unwrap()
        });
        let fresh = connect(&fresh).unwrap();
        let upgraded = connect(&upgraded).unwrap();
        assert_eq!(schema_fingerprint(&fresh), schema_fingerprint(&upgraded));
        for connection in [&fresh, &upgraded] {
            assert_eq!(
                recorded_versions(connection).unwrap(),
                (1..=CURRENT_SCHEMA_VERSION).collect::<Vec<_>>()
            );
            for migration in MIGRATIONS {
                (migration.verify)(connection).unwrap();
            }
        }
    }

    #[test]
    fn writer_protocol_upgrade_waits_for_previously_opened_clients() {
        let temporary = tempdir().unwrap();
        let root = temporary.path();
        prepare_root(root);
        migrate_to(root, 22).unwrap();
        let old_client = crate::library_access::LibraryLease::acquire(root).unwrap();
        let error = crate::Library::open(root).unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Conflict);
        assert_eq!(
            recorded_versions(&connect(root).unwrap()).unwrap().last(),
            Some(&22)
        );
        drop(old_client);
        let current = crate::Library::open(root).unwrap();
        assert_eq!(
            recorded_versions(&connect(root).unwrap()).unwrap().last(),
            Some(&CURRENT_SCHEMA_VERSION)
        );
        // Current clients retain normal concurrent shared access after migration.
        let other = crate::Library::open(root).unwrap();
        drop((current, other));
    }

    #[test]
    fn selection_writer_protocol_waits_for_schema_25_clients() {
        let temporary = tempdir().unwrap();
        let root = temporary.path();
        prepare_root(root);
        migrate_to(root, 25).unwrap();
        let previous = crate::library_access::LibraryLease::acquire(root).unwrap();
        assert_eq!(
            crate::Library::open(root).unwrap_err().code,
            crate::ErrorCode::Conflict
        );
        assert_eq!(
            recorded_versions(&connect(root).unwrap()).unwrap().last(),
            Some(&25)
        );
        drop(previous);
        let current = crate::Library::open(root).unwrap();
        assert_eq!(
            recorded_versions(&connect(root).unwrap()).unwrap().last(),
            Some(&CURRENT_SCHEMA_VERSION)
        );
        drop(current);
    }

    #[test]
    fn retained_build_reference_upgrade_preserves_installs_and_waits_for_schema_37_clients() {
        let temporary = tempdir().unwrap();
        let root = temporary.path();
        prepare_root(root);
        migrate_to(root, 37).unwrap();
        insert_alpha_one_install(
            &connect(root).unwrap(),
            "retained-before-upgrade",
            "v1",
            &root.join("versions/starship/v1"),
            false,
        );
        let previous = crate::library_access::LibraryLease::acquire(root).unwrap();
        assert_eq!(
            crate::Library::open(root).unwrap_err().code,
            crate::ErrorCode::Conflict
        );
        assert_eq!(
            recorded_versions(&connect(root).unwrap()).unwrap().last(),
            Some(&37)
        );
        drop(previous);
        let current = crate::Library::open(root).unwrap();
        assert_eq!(
            current.all_installs().unwrap()[0].id,
            "retained-before-upgrade"
        );
        assert!(
            crate::retained_build::references_from(&current.connection().unwrap())
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            recorded_versions(&connect(root).unwrap()).unwrap().last(),
            Some(&CURRENT_SCHEMA_VERSION)
        );
    }

    #[test]
    fn admission_writer_protocol_waits_for_schema_26_clients() {
        let temporary = tempdir().unwrap();
        let root = temporary.path();
        prepare_root(root);
        migrate_to(root, 26).unwrap();
        let previous = crate::library_access::LibraryLease::acquire(root).unwrap();
        assert_eq!(
            crate::Library::open(root).unwrap_err().code,
            crate::ErrorCode::Conflict
        );
        assert_eq!(
            recorded_versions(&connect(root).unwrap()).unwrap().last(),
            Some(&26)
        );
        drop(previous);
        let current = crate::Library::open(root).unwrap();
        assert_eq!(
            recorded_versions(&connect(root).unwrap()).unwrap().last(),
            Some(&CURRENT_SCHEMA_VERSION)
        );
        drop(current);
    }

    fn schema_fingerprint(connection: &Connection) -> String {
        let mut statement = connection
            .prepare(
                "SELECT type, name, tbl_name, sql
                 FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name",
            )
            .unwrap();
        let rows = statement
            .query_map([], |row| {
                Ok(format!(
                    "{}|{}|{}|{}",
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .unwrap()
            .collect::<std::result::Result<Vec<_>, _>>()
            .unwrap();
        hex::encode(Sha256::digest(rows.join("\n").as_bytes()))
    }

    #[test]
    fn schema_33_fixture_accepts_empty_future_tables_and_preserves_historical_state() {
        let temporary = tempdir().unwrap();
        let root = temporary.path();
        prepare_root(root);
        migrate(root).unwrap();
        let connection = connect(root).unwrap();
        insert_alpha_one_install(
            &connection,
            "historical-install",
            "v1",
            &root.join("versions/starship/v1"),
            false,
        );
        connection
            .execute_batch(
                "CREATE TABLE future_fixture_state(payload TEXT NOT NULL);
                 INSERT INTO port_settings(port_id,channel,update_policy,active_install_id)
                   VALUES('starship','stable','notify','historical-install');
                 UPDATE schema_migrations SET applied_at=0;",
            )
            .unwrap();
        let identity: String = connection
            .query_row("SELECT id FROM library_identity", [], |row| row.get(0))
            .unwrap();
        drop(connection);

        recreate_schema_33_fixture(root).unwrap();

        let reference = tempdir().unwrap();
        prepare_root(reference.path());
        migrate_to(reference.path(), 33).unwrap();
        let connection = connect(root).unwrap();
        assert_eq!(
            schema_fingerprint(&connection),
            schema_fingerprint(&connect(reference.path()).unwrap())
        );
        assert_eq!(
            recorded_versions(&connection).unwrap(),
            (1..=33).collect::<Vec<_>>()
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT count(*) FROM schema_migrations WHERE applied_at=0",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0,
            "the historical ledger must come from the real forward migrations"
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT installs.id,port_settings.active_install_id,library_identity.id
                     FROM installs,port_settings,library_identity",
                    [],
                    |row| Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?
                    )),
                )
                .unwrap(),
            (
                "historical-install".into(),
                "historical-install".into(),
                identity
            )
        );
    }

    #[test]
    fn schema_33_fixture_refuses_incompatible_state_without_replacing_source() {
        for (newer_state, expected) in [
            (
                "CREATE TABLE future_fixture_state(payload TEXT NOT NULL);
                 INSERT INTO future_fixture_state VALUES('retained future payload');",
                "populated table future_fixture_state",
            ),
            (
                "ALTER TABLE installs ADD COLUMN future_payload TEXT;
                 UPDATE installs SET future_payload='retained future payload';",
                "column installs.future_payload",
            ),
            (
                "UPDATE curated_artifact_history SET admission_count=1;",
                "populated table curated_artifact_history",
            ),
            (
                "INSERT INTO lifecycle_operations(id,kind,port_id,phase,created_at,updated_at,ghostship_recovery_json)
                 VALUES('retained-operation','restore','starship','preparing',1,1,'{}');",
                "column lifecycle_operations.ghostship_recovery_json",
            ),
        ] {
            let temporary = tempdir().unwrap();
            let root = temporary.path();
            prepare_root(root);
            migrate(root).unwrap();
            let connection = connect(root).unwrap();
            insert_alpha_one_install(
                &connection,
                "retained-install",
                "v1",
                &root.join("versions/starship/v1"),
                false,
            );
            connection.execute_batch(newer_state).unwrap();
            connection.pragma_update(None, "journal_mode", "DELETE").unwrap();
            drop(connection);
            let before = fs::read(database_path(root)).unwrap();

            let error = recreate_schema_33_fixture(root).unwrap_err();

            assert!(error.to_string().contains(expected), "{error}");
            assert_eq!(fs::read(database_path(root)).unwrap(), before);
        }
    }

    #[test]
    fn schema_33_fixture_refuses_invalid_historical_foreign_keys() {
        let temporary = tempdir().unwrap();
        let root = temporary.path();
        prepare_root(root);
        migrate(root).unwrap();
        let connection = connect(root).unwrap();
        connection
            .execute_batch(
                "PRAGMA foreign_keys=OFF;
                 INSERT INTO port_settings(port_id,channel,update_policy,active_install_id)
                   VALUES('starship','stable','notify','missing-install');
                 PRAGMA journal_mode=DELETE;",
            )
            .unwrap();
        drop(connection);
        let before = fs::read(database_path(root)).unwrap();

        let error = recreate_schema_33_fixture(root).unwrap_err();

        assert!(
            error
                .to_string()
                .contains("invalid historical foreign keys")
        );
        assert_eq!(fs::read(database_path(root)).unwrap(), before);
    }

    fn insert_alpha_one_install(
        connection: &Connection,
        id: &str,
        version: &str,
        path: &Path,
        staged: bool,
    ) {
        connection
            .execute(
                "INSERT INTO installs(
                   id, port_id, version, path, channel, installed_at, verified, staged,
                   artifact_name, artifact_sha256, artifact_size, manifest_sha256,
                   selected_executable, runtime_json
                 ) VALUES (?1, 'starship', ?2, ?3, 'stable', 7, 1, ?4,
                           'game.zip', ?5, 42, ?6, 'game.exe', NULL)",
                rusqlite::params![
                    id,
                    version,
                    path.display().to_string(),
                    i64::from(staged),
                    "a".repeat(64),
                    "b".repeat(64),
                ],
            )
            .unwrap();
    }

    fn assert_historical_schema_upgrade(historical_version: i64) {
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

    #[test]
    fn phase_diagnostic_migration_preserves_legacy_payload_and_cascade() {
        let temporary = tempdir().unwrap();
        let root = temporary.path();
        prepare_root(root);
        migrate_to(root, 21).unwrap();
        let connection = connect(root).unwrap();
        connection.execute("INSERT INTO activity_history(id,operation,target_kind,status,started_at) VALUES('owned','prepare','port','failed',1)", []).unwrap();
        let payload = "{\"owned\":\"legacy bytes retained exactly\"}";
        connection.execute("INSERT INTO activity_diagnostics(activity_id,payload,updated_at,payload_bytes) VALUES('owned',?1,2,?2)", rusqlite::params![payload,payload.len()]).unwrap();
        drop(connection);
        migrate(root).unwrap();
        let connection = connect(root).unwrap();
        let actual: (String,String,i64,i64) = connection.query_row("SELECT phase,payload,updated_at,payload_bytes FROM activity_diagnostics WHERE activity_id='owned'", [], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?))).unwrap();
        assert_eq!(
            actual,
            (
                "preparation.setup".into(),
                payload.into(),
                2,
                payload.len() as i64
            )
        );
        connection.execute("INSERT INTO activity_diagnostics(activity_id,phase,payload,updated_at,payload_bytes) VALUES('owned','preparation.extract',?1,3,?2)", rusqlite::params![payload,payload.len()]).unwrap();
        connection
            .execute("DELETE FROM activity_history WHERE id='owned'", [])
            .unwrap();
        let remaining: i64 = connection
            .query_row("SELECT count(*) FROM activity_diagnostics", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(remaining, 0);
    }

    macro_rules! historical_schema_tests {
        ($($name:ident: $version:literal),+ $(,)?) => {
            #[test]
            fn historical_schema_cases_cover_every_migration() {
                assert_eq!(vec![$($version),+], (0..CURRENT_SCHEMA_VERSION).collect::<Vec<_>>());
            }
            $(#[test]
            fn $name() { assert_historical_schema_upgrade($version); })+
        };
    }

    historical_schema_tests! {
        schema_0: 0,
        schema_1: 1,
        schema_2: 2,
        schema_3: 3,
        schema_4: 4,
        schema_5: 5,
        schema_6: 6,
        schema_7: 7,
        schema_8: 8,
        schema_9: 9,
        schema_10: 10,
        schema_11: 11,
        schema_12: 12,
        schema_13: 13,
        schema_14: 14,
        schema_15: 15,
        schema_16: 16,
        schema_17: 17,
        schema_18: 18,
        schema_19: 19,
        schema_20: 20,
        schema_21: 21,
        schema_22: 22,
        schema_23: 23,
        schema_24: 24,
        schema_25: 25,
        schema_26: 26,
        schema_27: 27,
        schema_28: 28,
        schema_29: 29,
        schema_30: 30,
        schema_31: 31,
        schema_32: 32,
        schema_33: 33,
        schema_34: 34,
        schema_35: 35,
        schema_36: 36,
        schema_37: 37,
        schema_38: 38,
        schema_39: 39,
        schema_40: 40,
        schema_41: 41,
    }

    #[test]
    fn continuity_upgrade_failure_preserves_schema_33_and_admission_bytes() {
        let temporary = tempdir().unwrap();
        let root = temporary.path();
        prepare_root(root);
        migrate_to(root, 33).unwrap();
        let connection = connect(root).unwrap();
        let anchor = "a".repeat(64);
        connection
            .execute(
                "INSERT INTO definition_publisher_authority(anchor_sha256,trusted_root_json)
             VALUES(?1,'{}')",
                [&anchor],
            )
            .unwrap();
        // A missing corresponding policy record cannot supply a current bound.
        connection
            .execute(
                "INSERT INTO definition_publisher_admission
             (namespace,stable_id,anchor_sha256,policy_json,provenance_json)
             VALUES('official','owned-fixture',?1,'owned policy bytes','owned provenance bytes')",
                [&anchor],
            )
            .unwrap();
        drop(connection);
        let error = migrate(root).unwrap_err();
        assert_eq!(error.details["migration_version"], "34");
        let connection = connect(root).unwrap();
        assert_eq!(
            recorded_versions(&connection).unwrap(),
            (1..=33).collect::<Vec<_>>()
        );
        assert!(
            connection
                .prepare(
                    "SELECT retained_launch_revision_floor FROM definition_publisher_admission"
                )
                .is_err()
        );
        let bytes: String = connection
            .query_row(
                "SELECT policy_json FROM definition_publisher_admission",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(bytes, "owned policy bytes");
    }

    #[test]
    fn launch_assessment_upgrade_preserves_schema_34_continuity_and_admission_bytes() {
        let temporary = tempdir().unwrap();
        let root = temporary.path();
        prepare_root(root);
        migrate_to(root, 34).unwrap();
        let connection = connect(root).unwrap();
        let anchor = "a".repeat(64);
        connection
            .execute(
                "INSERT INTO definition_publisher_authority(anchor_sha256,trusted_root_json)
                 VALUES(?1,'{}')",
                [&anchor],
            )
            .unwrap();
        // Opaque owned database bytes exercise migration preservation only;
        // authenticated policy admission is qualified by the policy fixtures.
        connection
            .execute(
                "INSERT INTO definition_publisher_admission
                 (namespace,stable_id,anchor_sha256,policy_json,provenance_json,
                  retained_launch_revision_floor)
                 VALUES('official','owned-fixture',?1,'owned policy bytes',
                        'owned provenance bytes',7)",
                [&anchor],
            )
            .unwrap();
        drop(connection);

        migrate(root).unwrap();
        let connection = connect(root).unwrap();
        let preserved: (String, String, i64, i64) = connection
            .query_row(
                "SELECT policy_json,provenance_json,retained_launch_revision_floor,
                        launch_assessment_revision FROM definition_publisher_admission",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(
            preserved,
            (
                "owned policy bytes".into(),
                "owned provenance bytes".into(),
                7,
                0
            )
        );
        assert_eq!(
            recorded_versions(&connection).unwrap(),
            (1..=CURRENT_SCHEMA_VERSION).collect::<Vec<_>>()
        );
        verify_migration_34(&connection).unwrap();
        verify_migration_35(&connection).unwrap();
        verify_migration_36(&connection).unwrap();
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
        assert_eq!(
            error.presentation().presentation_key,
            "library_version_newer"
        );
        assert_eq!(
            error.presentation().mutation_state,
            crate::MutationState::Unknown
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
        assert_eq!(
            error.presentation().presentation_key,
            "library_history_incomplete"
        );
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

    #[test]
    fn alpha_1_schema_adds_an_empty_output_setting_without_reinterpreting_installs() {
        let temporary = tempdir().unwrap();
        prepare_root(temporary.path());
        migrate_to(temporary.path(), 13).unwrap();
        let connection = connect(temporary.path()).unwrap();
        connection
            .execute(
                "INSERT INTO installs(
                   id, port_id, version, path, channel, installed_at, verified, staged,
                   artifact_name, artifact_sha256, artifact_size, manifest_sha256,
                   selected_executable, runtime_json
                 ) VALUES ('active', 'starship', 'v1', 'E:/old/active', 'stable', 7, 1, 0,
                           'game.zip', ?1, 42, ?2, 'game.exe', NULL)",
                ["a".repeat(64), "b".repeat(64)],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO port_settings(
                   port_id, channel, update_policy, active_install_id, previous_install_id
                 ) VALUES ('starship', 'stable', 'notify', 'active', NULL)",
                [],
            )
            .unwrap();
        drop(connection);

        migrate(temporary.path()).unwrap();

        let connection = connect(temporary.path()).unwrap();
        let install: (String, String, String, String, i64, i64) = connection
            .query_row(
                "SELECT id, port_id, version, path, installed_at, verified
                 FROM installs WHERE id='active'",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(
            install,
            (
                "active".into(),
                "starship".into(),
                "v1".into(),
                "E:/old/active".into(),
                7,
                1,
            )
        );
        let settings: (Option<String>, Option<String>, Option<String>) = connection
            .query_row(
                "SELECT active_install_id, previous_install_id, output_directory
                 FROM port_settings WHERE port_id='starship'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(settings, (Some("active".into()), None, None));
    }

    #[test]
    fn released_alpha_one_library_upgrades_on_a_copy_without_reinterpreting_state() {
        // Generated with the published v0.1.0-alpha.1 Windows CLI archive
        // (SHA-256 8d7b49aa563982f08e8416d3d5bf34da9b04125f01690221a47bcd79d9b697dd)
        // from release target d10c331d1d8a06b512f047f9ba5be721e1cfe4fa.
        const ALPHA_ONE_SCHEMA_FINGERPRINT: &str =
            "b857e2507b32b44cf30a06f611bc7eac63a8509b4c3d05f257ed3f39636d37bc";

        let original = tempdir().unwrap();
        let candidate = tempdir().unwrap();
        prepare_root(original.path());
        prepare_root(candidate.path());
        migrate_to(original.path(), 13).unwrap();

        let candidate_root = std::path::absolute(candidate.path()).unwrap();
        let exact_source = candidate_root.join("offline").join("exact-source.z64");
        let legacy_source = candidate_root.join("offline").join("legacy-source.wad");
        let active_path = candidate_root
            .join("versions")
            .join("starship")
            .join("active");
        let previous_path = candidate_root
            .join("versions")
            .join("starship")
            .join("previous");
        let staged_path = candidate_root
            .join("versions")
            .join("starship")
            .join("staged");

        let connection = connect(original.path()).unwrap();
        assert_eq!(
            schema_fingerprint(&connection),
            ALPHA_ONE_SCHEMA_FINGERPRINT
        );
        connection
            .execute(
                "INSERT INTO sources(profile_id, path, sha256, size, updated_at, storage_sha256, storage_size)
                 VALUES ('star-fox-64', ?1, ?2, 64, 5, ?3, 64),
                        ('doom-wad', ?4, ?5, 128, 6, ?6, 128)",
                rusqlite::params![
                    exact_source.display().to_string(),
                    "1".repeat(64),
                    "2".repeat(64),
                    legacy_source.display().to_string(),
                    "3".repeat(64),
                    "4".repeat(64),
                ],
            )
            .unwrap();
        insert_alpha_one_install(&connection, "active", "v2", &active_path, false);
        insert_alpha_one_install(&connection, "previous", "v1", &previous_path, false);
        insert_alpha_one_install(&connection, "staged", "v3", &staged_path, true);
        connection
            .execute(
                "INSERT INTO port_settings(port_id, channel, update_policy, active_install_id, previous_install_id)
                 VALUES ('starship', 'stable', 'stage', 'active', 'previous')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO activity_history(id, operation, target_kind, target_id, status, message, started_at, finished_at)
                 VALUES ('activity', 'restore', 'port', 'starship', 'succeeded', 'restored', 8, 9)",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO launch_history(port_id, last_launched_at, successful_launches)
                 VALUES ('starship', 10, 2)",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO launch_sessions(
                   id, port_id, install_id, install_root, supervisor_pid, phase, outcome,
                   exit_code, message, started_at, updated_at, finished_at
                 ) VALUES ('launch', 'starship', 'active', ?1, 1, 'collecting', 'succeeded',
                           0, 'completed', 10, 11, 11)",
                [active_path.display().to_string()],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO lifecycle_operations(
                   id, kind, port_id, phase, staging_path, final_path, quarantine_path,
                   install_json, original_paths_json, activate, last_error, created_at, updated_at
                 ) VALUES ('recovery', 'install', 'starship', 'committed', NULL, ?1, NULL,
                           NULL, '[]', 0, NULL, 12, 13)",
                [active_path.display().to_string()],
            )
            .unwrap();
        connection
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
            .unwrap();
        drop(connection);

        for (path, bytes) in [
            (active_path.join("game.exe"), b"active".as_slice()),
            (previous_path.join("game.exe"), b"previous".as_slice()),
            (staged_path.join("game.exe"), b"staged".as_slice()),
            (
                candidate_root.join("user/starship/save.dat"),
                b"save".as_slice(),
            ),
            (
                candidate_root.join("user/starship/settings.ini"),
                b"settings".as_slice(),
            ),
            (
                candidate_root.join("backups/starship/backup-1/backup.json"),
                b"backup manifest".as_slice(),
            ),
            (
                candidate_root.join("backups/starship/backup-1/save.dat"),
                b"backup save".as_slice(),
            ),
            (
                candidate_root.join("recovery/alpha-one-note.json"),
                b"recovery note".as_slice(),
            ),
        ] {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, bytes).unwrap();
        }
        fs::copy(
            database_path(original.path()),
            database_path(candidate.path()),
        )
        .unwrap();

        let library = crate::Library::open(candidate.path().to_path_buf()).unwrap();
        assert_eq!(library.root(), candidate_root);
        let upgraded = connect(candidate.path()).unwrap();
        assert_eq!(
            recorded_versions(&upgraded).unwrap(),
            (1..=CURRENT_SCHEMA_VERSION).collect::<Vec<_>>()
        );
        let sources = upgraded
            .prepare(
                "SELECT profile_id, path, sha256, storage_sha256, observed_identity_json
                 FROM sources ORDER BY profile_id",
            )
            .unwrap()
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            })
            .unwrap()
            .collect::<std::result::Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(sources.len(), 2);
        assert_eq!(sources[0].0, "doom-wad");
        assert_eq!(sources[0].1, legacy_source.display().to_string());
        assert_eq!(sources[0].2, "3".repeat(64));
        assert_eq!(sources[0].3, "4".repeat(64));
        assert_eq!(sources[0].4, None);
        assert_eq!(sources[1].0, "star-fox-64");
        assert_eq!(sources[1].1, exact_source.display().to_string());
        assert_eq!(sources[1].2, "1".repeat(64));
        assert_eq!(sources[1].3, "2".repeat(64));
        assert_eq!(sources[1].4, None);

        let pointers: (String, String, String, Option<String>) = upgraded
            .query_row(
                "SELECT active_install_id, previous_install_id, update_policy, output_directory
                 FROM port_settings WHERE port_id='starship'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(
            pointers,
            ("active".into(), "previous".into(), "stage".into(), None)
        );
        let installs: Vec<(String, String, String, i64)> = upgraded
            .prepare("SELECT id, version, path, staged FROM installs ORDER BY id")
            .unwrap()
            .query_map([], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })
            .unwrap()
            .collect::<std::result::Result<_, _>>()
            .unwrap();
        assert_eq!(
            installs,
            vec![
                (
                    "active".into(),
                    "v2".into(),
                    active_path.display().to_string(),
                    0
                ),
                (
                    "previous".into(),
                    "v1".into(),
                    previous_path.display().to_string(),
                    0,
                ),
                (
                    "staged".into(),
                    "v3".into(),
                    staged_path.display().to_string(),
                    1
                ),
            ]
        );
        let retained_records: (i64, i64, i64, Option<String>, Option<String>) = upgraded
            .query_row(
                "SELECT
                   (SELECT count(*) FROM activity_history WHERE id='activity'),
                   (SELECT count(*) FROM launch_sessions WHERE id='launch' AND outcome='succeeded'),
                   (SELECT successful_launches FROM launch_history WHERE port_id='starship'),
                   (SELECT relocation_json FROM lifecycle_operations WHERE id='recovery'),
                   (SELECT source_import_json FROM lifecycle_operations WHERE id='recovery')",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(retained_records, (1, 1, 2, None, None));
        assert_eq!(
            upgraded
                .query_row("SELECT count(*) FROM output_roots", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );

        assert_eq!(fs::read(active_path.join("game.exe")).unwrap(), b"active");
        assert_eq!(
            fs::read(previous_path.join("game.exe")).unwrap(),
            b"previous"
        );
        assert_eq!(fs::read(staged_path.join("game.exe")).unwrap(), b"staged");
        assert_eq!(
            fs::read(candidate_root.join("user/starship/save.dat")).unwrap(),
            b"save"
        );
        assert_eq!(
            fs::read(candidate_root.join("user/starship/settings.ini")).unwrap(),
            b"settings"
        );
        assert_eq!(
            fs::read(candidate_root.join("backups/starship/backup-1/save.dat")).unwrap(),
            b"backup save"
        );
        assert_eq!(
            fs::read(candidate_root.join("recovery/alpha-one-note.json")).unwrap(),
            b"recovery note"
        );

        let unchanged_original = connect(original.path()).unwrap();
        assert_eq!(
            recorded_versions(&unchanged_original).unwrap().last(),
            Some(&13)
        );
        assert_eq!(
            schema_fingerprint(&unchanged_original),
            ALPHA_ONE_SCHEMA_FINGERPRINT
        );
    }

    #[test]
    fn interrupted_output_setting_migration_completes_idempotently() {
        let temporary = tempdir().unwrap();
        prepare_root(temporary.path());
        migrate_to(temporary.path(), 13).unwrap();
        let connection = connect(temporary.path()).unwrap();
        connection
            .execute(
                "ALTER TABLE port_settings ADD COLUMN output_directory TEXT",
                [],
            )
            .unwrap();
        drop(connection);

        migrate(temporary.path()).unwrap();

        let connection = connect(temporary.path()).unwrap();
        assert_eq!(
            recorded_versions(&connection).unwrap(),
            (1..=CURRENT_SCHEMA_VERSION).collect::<Vec<_>>()
        );
        verify_migration_14(&connection).unwrap();
    }

    #[test]
    fn output_ownership_migration_assigns_one_stable_library_identity() {
        let temporary = tempdir().unwrap();
        prepare_root(temporary.path());
        migrate_to(temporary.path(), 14).unwrap();

        migrate(temporary.path()).unwrap();
        let first: String = connect(temporary.path())
            .unwrap()
            .query_row(
                "SELECT id FROM library_identity WHERE singleton=1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(first.len(), 32);

        migrate(temporary.path()).unwrap();
        let second: String = connect(temporary.path())
            .unwrap()
            .query_row(
                "SELECT id FROM library_identity WHERE singleton=1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(second, first);
        verify_migration_15(&connect(temporary.path()).unwrap()).unwrap();
    }

    #[test]
    fn interrupted_output_relocation_migration_completes_idempotently() {
        let temporary = tempdir().unwrap();
        prepare_root(temporary.path());
        migrate_to(temporary.path(), 15).unwrap();
        let connection = connect(temporary.path()).unwrap();
        connection
            .execute(
                "ALTER TABLE lifecycle_operations ADD COLUMN relocation_json TEXT",
                [],
            )
            .unwrap();
        drop(connection);

        migrate(temporary.path()).unwrap();

        let connection = connect(temporary.path()).unwrap();
        assert_eq!(
            recorded_versions(&connection).unwrap(),
            (1..=CURRENT_SCHEMA_VERSION).collect::<Vec<_>>()
        );
        verify_migration_16(&connection).unwrap();
    }

    #[test]
    fn observed_identity_migration_preserves_legacy_rows_as_not_evaluated() {
        let temporary = tempdir().unwrap();
        prepare_root(temporary.path());
        migrate_to(temporary.path(), 16).unwrap();
        let connection = connect(temporary.path()).unwrap();
        connection
            .execute(
                "INSERT INTO sources(profile_id, path, sha256, size, storage_sha256, storage_size, updated_at)
                 VALUES ('legacy', 'legacy.z64', ?1, 42, ?1, 42, 7)",
                ["a".repeat(64)],
            )
            .unwrap();
        drop(connection);

        migrate(temporary.path()).unwrap();

        let connection = connect(temporary.path()).unwrap();
        let row: (String, String, i64, Option<String>) = connection
            .query_row(
                "SELECT profile_id, path, updated_at, observed_identity_json FROM sources WHERE profile_id='legacy'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(row, ("legacy".into(), "legacy.z64".into(), 7, None));
    }

    #[test]
    fn interrupted_partially_populated_observed_identity_migration_completes() {
        let temporary = tempdir().unwrap();
        prepare_root(temporary.path());
        migrate_to(temporary.path(), 16).unwrap();
        let connection = connect(temporary.path()).unwrap();
        connection
            .execute(
                "ALTER TABLE sources ADD COLUMN observed_identity_json TEXT",
                [],
            )
            .unwrap();
        for profile_id in ["legacy", "observed"] {
            connection
                .execute(
                    "INSERT INTO sources(profile_id, path, sha256, size, storage_sha256, storage_size, updated_at)
                     VALUES (?1, ?2, ?3, 42, ?3, 42, 7)",
                    rusqlite::params![profile_id, format!("{profile_id}.z64"), "a".repeat(64)],
                )
                .unwrap();
        }
        let identity = serde_json::json!({
            "schema_version": 1,
            "digests": [{
                "algorithm": "sha256",
                "scope": "original-file",
                "value": "a".repeat(64),
                "size": 42
            }]
        });
        connection
            .execute(
                "UPDATE sources SET observed_identity_json=?1 WHERE profile_id='observed'",
                [identity.to_string()],
            )
            .unwrap();
        drop(connection);

        migrate(temporary.path()).unwrap();

        let connection = connect(temporary.path()).unwrap();
        assert_eq!(
            recorded_versions(&connection).unwrap(),
            (1..=CURRENT_SCHEMA_VERSION).collect::<Vec<_>>()
        );
        let populated: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sources WHERE observed_identity_json IS NOT NULL",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(populated, 1);
        verify_migration_17(&connection).unwrap();
    }

    #[test]
    fn recorded_partial_observed_identity_migration_is_rejected() {
        let temporary = tempdir().unwrap();
        prepare_root(temporary.path());
        migrate_to(temporary.path(), 16).unwrap();
        let connection = connect(temporary.path()).unwrap();
        connection
            .execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES (17, 0)",
                [],
            )
            .unwrap();
        drop(connection);

        let error = migrate(temporary.path()).unwrap_err();
        assert_eq!(error.details["migration_version"], "17");
        assert!(error.message.contains("partially applied"));
        assert!(error.details["cause"].contains("observed_identity_json"));
    }
}
