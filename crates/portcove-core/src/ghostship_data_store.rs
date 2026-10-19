//! Core-owned legacy consumption evidence. Files imported as backups cannot grant it.

use std::{collections::BTreeSet, fs, path::Path};

use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};

use crate::{
    AdoptionCopyFile, AdoptionCopyPlan, InstallRecord, LaunchSessionRecord, PortcoveError, Result,
    SourceRecord,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct LegacyDataSeal {
    pub format_version: u32,
    pub session: LaunchSessionRecord,
    pub install: InstallRecord,
    pub source: SourceRecord,
    pub receipt_sha256: String,
    pub generated_sha256: String,
    pub data: AdoptionCopyPlan,
}

pub(crate) fn migrate(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        "CREATE TABLE ghostship_legacy_qualifications (
           port_id TEXT PRIMARY KEY CHECK(port_id='ghostship'),
           seal_json TEXT NOT NULL
         );
         CREATE TABLE ghostship_qualified_backups (
           backup_id TEXT PRIMARY KEY,
           port_id TEXT NOT NULL CHECK(port_id='ghostship'),
           manifest_sha256 TEXT NOT NULL,
           seal_json TEXT NOT NULL
         );",
    )?;
    Ok(())
}

pub(crate) fn invalidate(connection: &Connection, port_id: &str) -> Result<()> {
    connection.execute(
        "DELETE FROM ghostship_legacy_qualifications WHERE port_id=?1",
        [port_id],
    )?;
    Ok(())
}

pub(crate) fn pending_legacy_work(connection: &Connection) -> Result<bool> {
    Ok(connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM lifecycle_operations WHERE port_id='ghostship')
             OR EXISTS(SELECT 1 FROM launch_sessions WHERE port_id='ghostship' AND outcome IS NULL)",
        [], |row| row.get(0),
    )?)
}

pub(crate) fn seal(connection: &Connection) -> Result<Option<LegacyDataSeal>> {
    let json: Option<String> = connection
        .query_row(
            "SELECT seal_json FROM ghostship_legacy_qualifications WHERE port_id='ghostship'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    json.map(|json| serde_json::from_str(&json).map_err(Into::into))
        .transpose()
}

#[cfg(test)]
#[path = "ghostship_data_store_tests.rs"]
mod tests;

/// Runs in the same transaction that completes this exact launch and activity.
pub(crate) fn finish_consumption(
    transaction: &Transaction<'_>,
    seal: &LegacyDataSeal,
) -> Result<()> {
    let session = &seal.session;
    let identity_matches: bool = transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM launch_sessions
          WHERE id=?1 AND port_id='ghostship' AND install_id=?2 AND install_root=?3
            AND supervisor_pid=?4 AND supervisor_identity=?5
            AND child_pid=?6 AND child_identity=?7 AND owner_kind='managed'
            AND phase='collecting' AND outcome='succeeded' AND exit_code=0
            AND finished_at IS NOT NULL AND started_at=?8)",
        params![
            session.id,
            seal.install.id,
            crate::path::unicode(&seal.install.path, "legacy installation")?,
            session.supervisor_pid,
            session.supervisor_identity,
            session.child_pid,
            session.child_identity,
            session.started_at,
        ],
        |row| row.get(0),
    )?;
    if !identity_matches
        || seal.format_version != 1
        || seal.install.port_id != "ghostship"
        || seal.install.version != "2.0.0"
        || session.port_id != "ghostship"
        || session.install_id != seal.install.id
        || session.install_root != seal.install.path
        || session.supervisor_identity.is_none()
        || session.child_identity.is_none()
        || session.phase != crate::LaunchSessionPhase::Collecting
        || session.outcome != Some(crate::LaunchSessionOutcome::Succeeded)
        || session.exit_code != Some(0)
        || session.finished_at.is_none()
        || session.message.is_some()
    {
        return Err(PortcoveError::verification(
            "legacy data qualification is not bound to this successful owned launch",
        ));
    }
    transaction.execute(
        "INSERT INTO ghostship_legacy_qualifications(port_id, seal_json)
         VALUES ('ghostship',?1)
         ON CONFLICT(port_id) DO UPDATE SET seal_json=excluded.seal_json",
        [serde_json::to_string(seal)?],
    )?;
    Ok(())
}

/// Bounds discovery before hashing. The returned plan includes empty directories
/// and rejects links, aliases, special entries and portable name collisions.
pub(crate) fn reviewed_data(root: &Path) -> Result<AdoptionCopyPlan> {
    const MAX_BYTES: u64 = 1024 * 1024 * 1024;
    fn walk(
        root: &Path,
        directory: &Path,
        depth: usize,
        plan: &mut AdoptionCopyPlan,
        keys: &mut BTreeSet<String>,
    ) -> Result<()> {
        if depth > 24 {
            return Err(PortcoveError::unsupported(
                "legacy data exceeds bounded tree depth",
            ));
        }
        crate::path::refuse_symlink_ancestors(directory)?;
        for entry in fs::read_dir(directory)? {
            let entry = entry?;
            if plan.directories.len() + plan.files.len() >= 4096 {
                return Err(PortcoveError::unsupported(
                    "legacy data exceeds bounded entry count",
                ));
            }
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path)?;
            if metadata.is_symlink() || !(metadata.is_dir() || metadata.is_file()) {
                return Err(PortcoveError::verification(
                    "legacy data contains a link or special entry",
                ));
            }
            let relative = path
                .strip_prefix(root)
                .map_err(|_| PortcoveError::state("legacy data escaped its root"))?;
            let text = crate::portability::portable_relative(relative)?;
            let (relative, key) =
                crate::portable_tree::validate_relative_path(&text, metadata.is_dir())?;
            if !keys.insert(key) {
                return Err(PortcoveError::verification(
                    "legacy data has colliding portable names",
                ));
            }
            if metadata.is_dir() {
                plan.directories.push(relative);
                walk(root, &path, depth + 1, plan, keys)?;
            } else {
                let remaining = MAX_BYTES.saturating_sub(plan.total_bytes);
                let (sha256, size) = crate::external_runtime::hash_stable_regular(
                    &path,
                    remaining.min(512 * 1024 * 1024),
                    &|| Ok(()),
                )?;
                plan.total_bytes += size;
                plan.files.push(AdoptionCopyFile {
                    relative_path: relative,
                    size,
                    sha256,
                });
            }
        }
        Ok(())
    }
    crate::path::refuse_symlink_ancestors(root)?;
    let metadata = fs::symlink_metadata(root)?;
    if !metadata.is_dir() || metadata.is_symlink() {
        return Err(PortcoveError::verification(
            "legacy data root is not an owned directory",
        ));
    }
    let mut plan = AdoptionCopyPlan {
        directories: Vec::new(),
        files: Vec::new(),
        skipped_entries: Vec::new(),
        total_bytes: 0,
    };
    walk(root, root, 0, &mut plan, &mut BTreeSet::new())?;
    plan.directories.sort();
    plan.files
        .sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    Ok(plan)
}

/// Optional consumption qualification must not turn a successfully collected
/// launch into an unfinished session solely because its mutable tree is outside
/// this narrower recovery contract. Storage failures remain errors.
pub(crate) fn consumption_data(root: &Path) -> Result<Option<AdoptionCopyPlan>> {
    match reviewed_data(root) {
        Ok(plan) => Ok(Some(plan)),
        Err(error)
            if matches!(
                error.code,
                crate::ErrorCode::Unsupported | crate::ErrorCode::Verification
            ) =>
        {
            Ok(None)
        }
        Err(error) => Err(error),
    }
}
