//! Exact admitted instances in the original-source registry. The existing
//! registration remains the default for callers that have no profile binding.

use rusqlite::{Connection, OptionalExtension, Transaction, params};
use sha2::{Digest, Sha256};

use crate::{Library, PortcoveError, Result, SourceRecord, profile::OriginalBinding};

const MAX_RECORD_BYTES: usize = 64 * 1024;

pub(crate) fn migrate(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        "CREATE TABLE source_instances (
            requirement_id TEXT NOT NULL,
            instance_id TEXT NOT NULL CHECK(length(instance_id)=64),
            source_json TEXT NOT NULL CHECK(length(CAST(source_json AS BLOB))<=65536),
            PRIMARY KEY(requirement_id, instance_id)
        ) WITHOUT ROWID;",
    )?;
    for source in Library::sources_from(transaction)? {
        record(transaction, &source)?;
    }
    Ok(())
}

pub(crate) fn identity(binding: &OriginalBinding) -> Result<String> {
    Ok(hex::encode(Sha256::digest(serde_json::to_vec(&(
        "portcove-original-instance-v1",
        binding,
    ))?)))
}

pub(crate) fn record(connection: &Connection, source: &SourceRecord) -> Result<()> {
    let requirement = &source.profile_id;
    let id = identity(&crate::profile::bind_original(requirement, source))?;
    let serialized = serde_json::to_string(source)?;
    if serialized.len() > MAX_RECORD_BYTES {
        return Err(PortcoveError::usage("saved original instance is too large"));
    }
    connection.execute(
        "INSERT INTO source_instances(requirement_id, instance_id, source_json) VALUES (?1, ?2, ?3)
         ON CONFLICT(requirement_id, instance_id) DO UPDATE SET source_json=excluded.source_json",
        params![requirement, id, serialized],
    )?;
    Ok(())
}

pub(crate) fn forget(connection: &Connection, source: &SourceRecord) -> Result<()> {
    let id = identity(&crate::profile::bind_original(&source.profile_id, source))?;
    connection.execute(
        "DELETE FROM source_instances WHERE requirement_id=?1 AND instance_id=?2",
        params![source.profile_id, id],
    )?;
    Ok(())
}

pub(crate) fn list(
    connection: &Connection,
    requirement: &str,
) -> Result<Vec<(String, SourceRecord)>> {
    list_limited(connection, requirement, i64::MAX)
}

pub(crate) fn list_limited(
    connection: &Connection,
    requirement: &str,
    limit: i64,
) -> Result<Vec<(String, SourceRecord)>> {
    let mut query = connection.prepare(
        "SELECT instance_id, source_json FROM source_instances
         WHERE requirement_id=?1 ORDER BY instance_id LIMIT ?2",
    )?;
    let rows = query.query_map(params![requirement, limit], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    rows.map(|row| {
        let (id, json) = row?;
        let record = decode(requirement, &id, &json)?;
        Ok((id, record))
    })
    .collect()
}

/// One page of saved originals after `after` in instance order. Callers page
/// through every instance instead of refusing above a total count.
pub(crate) fn list_page(
    connection: &Connection,
    requirement: &str,
    after: Option<&str>,
    limit: i64,
) -> Result<Vec<(String, SourceRecord)>> {
    let mut query = connection.prepare(
        "SELECT instance_id, source_json FROM source_instances
         WHERE requirement_id=?1 AND instance_id > ?2 ORDER BY instance_id LIMIT ?3",
    )?;
    let rows = query.query_map(params![requirement, after.unwrap_or(""), limit], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    rows.map(|row| {
        let (id, json) = row?;
        let record = decode(requirement, &id, &json)?;
        Ok((id, record))
    })
    .collect()
}

/// Export the extra instances. The default source rows already carry their
/// own exact identity, and restoring them recreates those instance rows.
pub(crate) fn export(
    connection: &Connection,
    default_sources: &[SourceRecord],
) -> Result<Vec<SourceRecord>> {
    let defaults = default_sources
        .iter()
        .map(|source| identity(&crate::profile::bind_original(&source.profile_id, source)))
        .collect::<Result<std::collections::BTreeSet<_>>>()?;
    let mut query = connection.prepare(
        "SELECT requirement_id, instance_id, source_json FROM source_instances
         ORDER BY requirement_id, instance_id",
    )?;
    let rows = query.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    let mut instances = Vec::new();
    for row in rows {
        let (requirement, id, json) = row?;
        let source = decode(&requirement, &id, &json)?;
        if !defaults.contains(&id) {
            instances.push(source);
        }
    }
    Ok(instances)
}

pub(crate) fn find(
    connection: &Connection,
    requirement: &str,
    id: &str,
) -> Result<Option<SourceRecord>> {
    let json = connection
        .query_row(
            "SELECT source_json FROM source_instances WHERE requirement_id=?1 AND instance_id=?2",
            params![requirement, id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    json.as_deref()
        .map(|json| decode(requirement, id, json))
        .transpose()
}

fn decode(requirement: &str, id: &str, json: &str) -> Result<SourceRecord> {
    if json.len() > MAX_RECORD_BYTES {
        return Err(PortcoveError::verification(
            "saved original instance is too large",
        ));
    }
    let source: SourceRecord = serde_json::from_str(json)?;
    if source.profile_id != requirement
        || identity(&crate::profile::bind_original(requirement, &source))? != id
    {
        return Err(PortcoveError::verification(
            "saved original identity does not match its registry entry",
        ));
    }
    if let Some(observed) = &source.observed_identity {
        observed.validate_for_record(&source)?;
    }
    Ok(source)
}

#[cfg(test)]
mod paging_tests {
    use super::*;

    fn connection_with(count: usize) -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE source_instances (
                    requirement_id TEXT NOT NULL,
                    instance_id TEXT NOT NULL CHECK(length(instance_id)=64),
                    source_json TEXT NOT NULL,
                    PRIMARY KEY(requirement_id, instance_id)
                ) WITHOUT ROWID;",
            )
            .unwrap();
        for index in 0..count {
            let source = SourceRecord {
                profile_id: "n64-original".into(),
                path: format!("/originals/{index}.z64").into(),
                sha256: format!("{index:064x}"),
                size: 1,
                storage_sha256: format!("{index:064x}"),
                storage_size: 1,
                updated_at: 0,
                observed_identity: None,
            };
            record(&connection, &source).unwrap();
        }
        connection
    }

    #[test]
    fn pages_reach_every_saved_original_beyond_sixteen() {
        let connection = connection_with(40);
        let mut after = None::<String>;
        let mut seen = Vec::new();
        loop {
            let page = list_page(&connection, "n64-original", after.as_deref(), 16).unwrap();
            let Some((last, _)) = page.last() else { break };
            after = Some(last.clone());
            seen.extend(page.into_iter().map(|(id, _)| id));
        }
        let all = list(&connection, "n64-original").unwrap();
        assert_eq!(seen.len(), 40);
        assert_eq!(seen, all.into_iter().map(|(id, _)| id).collect::<Vec<_>>());
    }
}
