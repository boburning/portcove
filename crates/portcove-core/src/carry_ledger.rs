//! Tier 2 carry ledger (#5359, T2-2): the `carried_files` and
//! `carried_file_outcomes` tables of library schema 61.
//!
//! A `present` row records that a version's copy of a path was these bytes
//! when Portcove last placed or recorded it, and descends from `lineage`. A
//! `pending` row records bytes Portcove intends to place, copied from another
//! installation; it keeps the present row it displaced, so an interrupted
//! switch re-plans against the recorded copy (T2-1 review N1). Rows hold
//! digests only. A row with an unknown `format` reads as no row and is never
//! rewritten, which falls to "keep both copies".

// The carry step (T2-2) is wired in a later checkpoint; until then only tests
// and the migration call this module.
#![cfg_attr(not(test), allow(dead_code))]

use std::collections::BTreeMap;

use rusqlite::{Connection, OptionalExtension, Transaction, params};

use crate::carry_plan::{CarryRow, RowState, bounded_lineage};
use crate::{PortcoveError, Result};

/// The row format this build reads and writes.
pub(crate) const ROW_FORMAT: i64 = 1;

pub(crate) fn migrate_schema(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        "CREATE TABLE carried_files (
            install_id TEXT NOT NULL REFERENCES installs(id) ON DELETE CASCADE,
            path TEXT NOT NULL CHECK(length(path) BETWEEN 1 AND 4096),
            state TEXT NOT NULL CHECK(state IN ('pending','present')),
            sha256 TEXT NOT NULL CHECK(length(sha256)=64),
            source_install_id TEXT,
            replaces_sha256 TEXT CHECK(replaces_sha256 IS NULL OR length(replaces_sha256)=64),
            replaces_lineage TEXT,
            lineage TEXT NOT NULL,
            format INTEGER NOT NULL,
            PRIMARY KEY(install_id, path),
            CHECK(state='pending' OR (source_install_id IS NULL AND replaces_sha256 IS NULL
                AND replaces_lineage IS NULL)),
            CHECK(state='present' OR source_install_id IS NOT NULL),
            CHECK((replaces_sha256 IS NULL) = (replaces_lineage IS NULL))
        );
        CREATE TABLE carried_file_outcomes (
            port_id TEXT PRIMARY KEY,
            from_install_id TEXT,
            to_install_id TEXT,
            outcome TEXT NOT NULL CHECK(length(outcome) <= 65536),
            format INTEGER NOT NULL
        );",
    )?;
    Ok(())
}

pub(crate) fn verify_schema(connection: &Connection) -> Result<()> {
    for (table, columns) in [
        (
            "carried_files",
            &[
                "install_id",
                "path",
                "state",
                "sha256",
                "source_install_id",
                "replaces_sha256",
                "replaces_lineage",
                "lineage",
                "format",
            ][..],
        ),
        (
            "carried_file_outcomes",
            &[
                "port_id",
                "from_install_id",
                "to_install_id",
                "outcome",
                "format",
            ][..],
        ),
    ] {
        let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
        let present = statement
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        if let Some(missing) = columns
            .iter()
            .find(|column| !present.iter().any(|name| name == *column))
        {
            return Err(PortcoveError::state(format!(
                "required database column {table}.{missing} is missing"
            )));
        }
    }
    Ok(())
}

/// A row as stored, before the planner's view of it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct StoredRow {
    pub(crate) row: CarryRow,
    /// Pending only: the present row it displaced.
    pub(crate) replaces: Option<CarryRow>,
}

fn decode_lineage(text: &str) -> Option<Vec<String>> {
    let lineage = serde_json::from_str::<Vec<String>>(text).ok()?;
    lineage
        .iter()
        .all(|digest| is_digest(digest))
        .then(|| bounded_lineage(lineage))
}

fn is_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Every readable row of an installation, by path. Rows with an unknown
/// format or a malformed digest or lineage are skipped (read as no row).
pub(crate) fn load(
    connection: &Connection,
    install_id: &str,
) -> Result<BTreeMap<String, StoredRow>> {
    let mut statement = connection.prepare(
        "SELECT path, state, sha256, source_install_id, replaces_sha256, replaces_lineage, lineage, format
         FROM carried_files WHERE install_id=?1",
    )?;
    let rows = statement
        .query_map(params![install_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, i64>(7)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut loaded = BTreeMap::new();
    for (path, state, sha256, source, replaces_sha256, replaces_lineage, lineage, format) in rows {
        if format != ROW_FORMAT || !is_digest(&sha256) {
            continue;
        }
        let Some(lineage) = decode_lineage(&lineage) else {
            continue;
        };
        let state = match (state.as_str(), source) {
            ("present", None) => RowState::Present,
            ("pending", Some(source_install_id)) => RowState::Pending { source_install_id },
            _ => continue,
        };
        let replaces = match (replaces_sha256, replaces_lineage) {
            (Some(sha), Some(text)) if is_digest(&sha) => match decode_lineage(&text) {
                Some(lineage) => Some(CarryRow::present(&sha, lineage)),
                None => continue,
            },
            (None, None) => None,
            _ => continue,
        };
        loaded.insert(
            path,
            StoredRow {
                row: CarryRow {
                    state,
                    sha256,
                    lineage,
                },
                replaces,
            },
        );
    }
    Ok(loaded)
}

/// Replace an installation's row for a path. A pending row must name its
/// source; `replaces` is kept only on a pending row and must be a present
/// row. Returns whether a row was written: `false` when a row of an unknown
/// format occupies the path, which the caller treats as "kept separately".
pub(crate) fn put(
    transaction: &Transaction<'_>,
    install_id: &str,
    path: &str,
    row: &CarryRow,
    replaces: Option<&CarryRow>,
) -> Result<bool> {
    let well_formed =
        |row: &CarryRow| is_digest(&row.sha256) && row.lineage.last() == Some(&row.sha256);
    if !well_formed(row) {
        return Err(PortcoveError::state(
            "a carried-file record must end its lineage with its own digest",
        ));
    }
    if replaces
        .is_some_and(|replaced| replaced.state != RowState::Present || !is_digest(&replaced.sha256))
    {
        return Err(PortcoveError::state(
            "a displaced carried-file record must be a present record",
        ));
    }
    // A stored row read back with a lineage not ending in its own bytes is
    // repaired here rather than failing the switch.
    let replaces =
        replaces.map(|replaced| CarryRow::present(&replaced.sha256, replaced.checked_lineage()));
    let replaces = replaces.as_ref();
    let (state, source, replaces) = match &row.state {
        RowState::Present => ("present", None, None),
        RowState::Pending { source_install_id } => {
            ("pending", Some(source_install_id.as_str()), replaces)
        }
    };
    let lineage = serde_json::to_string(&bounded_lineage(row.lineage.clone()))?;
    let replaces_lineage = replaces
        .map(|replaced| serde_json::to_string(&bounded_lineage(replaced.lineage.clone())))
        .transpose()?;
    let written = transaction.execute(
        "INSERT INTO carried_files
            (install_id, path, state, sha256, source_install_id, replaces_sha256, replaces_lineage, lineage, format)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(install_id, path) DO UPDATE SET
            state=excluded.state, sha256=excluded.sha256,
            source_install_id=excluded.source_install_id,
            replaces_sha256=excluded.replaces_sha256,
            replaces_lineage=excluded.replaces_lineage,
            lineage=excluded.lineage, format=excluded.format
         WHERE carried_files.format=?9",
        params![
            install_id,
            path,
            state,
            row.sha256,
            source,
            replaces.map(|replaced| replaced.sha256.as_str()),
            replaces_lineage,
            lineage,
            ROW_FORMAT,
        ],
    )?;
    Ok(written == 1)
}

/// Delete an installation's row for a path, unless its format is unknown.
/// Returns whether a row of an unknown format still occupies the path.
pub(crate) fn delete(transaction: &Transaction<'_>, install_id: &str, path: &str) -> Result<bool> {
    transaction.execute(
        "DELETE FROM carried_files WHERE install_id=?1 AND path=?2 AND format=?3",
        params![install_id, path, ROW_FORMAT],
    )?;
    let remaining: i64 = transaction.query_row(
        "SELECT count(*) FROM carried_files WHERE install_id=?1 AND path=?2",
        params![install_id, path],
        |row| row.get(0),
    )?;
    Ok(remaining > 0)
}

/// The last switch's outcome for a port, as bounded JSON.
pub(crate) fn put_outcome(
    transaction: &Transaction<'_>,
    port_id: &str,
    from_install_id: &str,
    to_install_id: &str,
    outcome: &serde_json::Value,
) -> Result<()> {
    let text = serde_json::to_string(outcome)?;
    if text.len() > 65_536 {
        return Err(PortcoveError::state(
            "carried-file outcome is too large to record",
        ));
    }
    transaction.execute(
        "INSERT INTO carried_file_outcomes (port_id, from_install_id, to_install_id, outcome, format)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(port_id) DO UPDATE SET from_install_id=excluded.from_install_id,
            to_install_id=excluded.to_install_id, outcome=excluded.outcome, format=excluded.format",
        params![port_id, from_install_id, to_install_id, text, ROW_FORMAT],
    )?;
    Ok(())
}

/// The recorded outcome for a port, if one exists in a known format.
pub(crate) fn outcome(
    connection: &Connection,
    port_id: &str,
) -> Result<Option<(String, String, serde_json::Value)>> {
    let row = connection
        .query_row(
            "SELECT from_install_id, to_install_id, outcome, format FROM carried_file_outcomes
             WHERE port_id=?1",
            params![port_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            },
        )
        .optional()?;
    Ok(match row {
        Some((Some(from), Some(to), text, ROW_FORMAT)) => serde_json::from_str(&text)
            .ok()
            .map(|value| (from, to, value)),
        _ => None,
    })
}

#[cfg(test)]
#[path = "carry_ledger/tests.rs"]
mod tests;
