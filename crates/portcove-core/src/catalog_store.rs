//! One transactional authority for public trust, replay protection and catalog selection.
use rusqlite::{Connection, params};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{
    Catalog, CatalogProvenance, CatalogTrustKey, Library, PortcoveError, Result,
    signed_catalog::{self, CatalogOrigin, MAX_CATALOG_BYTES},
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct CatalogStatus {
    pub provenance: CatalogProvenance,
    pub trusted_keys: Vec<CatalogTrustKey>,
    pub highest_sequence: i64,
    pub updates_enabled: bool,
    pub can_rollback: bool,
    pub can_use_cached: bool,
    pub state_sha256: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct CatalogState {
    pub revision: i64,
    pub highest_sequence: i64,
    pub enabled: bool,
    pub active: Option<Vec<u8>>,
    pub previous: Option<Vec<u8>>,
    pub keys: Vec<CatalogTrustKey>,
}

impl CatalogState {
    pub fn read(connection: &Connection) -> Result<Self> {
        if connection.is_autocommit() {
            let snapshot = connection.unchecked_transaction()?;
            let state = Self::read_snapshot(&snapshot)?;
            snapshot.commit()?;
            return Ok(state);
        }
        Self::read_snapshot(connection)
    }

    fn read_snapshot(connection: &Connection) -> Result<Self> {
        let mut state = connection.query_row(
            "SELECT revision,highest_sequence,enabled,active,previous FROM catalog_state WHERE singleton=1",
            [], |row| Ok(Self { revision: row.get(0)?, highest_sequence: row.get(1)?, enabled: row.get(2)?,
                active: row.get(3)?, previous: row.get(4)?, keys: Vec::new() }),
        )?;
        let mut statement =
            connection.prepare("SELECT key_id,public_key FROM catalog_trust ORDER BY key_id")?;
        state.keys = statement
            .query_map([], |row| {
                Ok(CatalogTrustKey {
                    key_id: row.get(0)?,
                    public_key: row.get(1)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(state)
    }

    pub fn fingerprint(&self) -> Result<String> {
        Ok(signed_catalog::digest(&serde_json::to_vec(self)?))
    }

    pub fn require_review(&self, expected: &str) -> Result<()> {
        if self.fingerprint()? != expected {
            return Err(PortcoveError::conflict(
                "catalog trust or selection changed; review it again",
            ));
        }
        Ok(())
    }

    pub fn resolve(&self, now: i64) -> Result<(Catalog, CatalogProvenance)> {
        let mut reasons = Vec::new();
        if self.enabled {
            for (bytes, origin) in [
                (&self.active, CatalogOrigin::SignedActive),
                (&self.previous, CatalogOrigin::SignedPrevious),
            ] {
                let Some(bytes) = bytes else { continue };
                match signed_catalog::verify(bytes, &self.keys, now) {
                    Ok(value) if value.payload.sequence <= self.highest_sequence => {
                        let provenance = signed_catalog::provenance(
                            &value.catalog,
                            origin,
                            Some(&value),
                            reasons,
                        )?;
                        return Ok((value.catalog, provenance));
                    }
                    Ok(_) => {
                        reasons.push("cached catalog exceeds the recorded replay floor".into())
                    }
                    Err(error) => reasons.push(error.message),
                }
            }
        }
        let catalog = Catalog::embedded()?;
        let provenance =
            signed_catalog::provenance(&catalog, CatalogOrigin::Embedded, None, reasons)?;
        Ok((catalog, provenance))
    }

    pub fn status(&self, now: i64) -> Result<CatalogStatus> {
        Ok(CatalogStatus {
            provenance: self.resolve(now)?.1,
            trusted_keys: self.keys.clone(),
            highest_sequence: self.highest_sequence,
            updates_enabled: self.enabled,
            can_rollback: self.previous.as_ref().is_some_and(|bytes| {
                signed_catalog::verify(bytes, &self.keys, now)
                    .is_ok_and(|value| value.payload.sequence <= self.highest_sequence)
            }),
            can_use_cached: [&self.active, &self.previous]
                .into_iter()
                .flatten()
                .any(|bytes| {
                    signed_catalog::verify(bytes, &self.keys, now)
                        .is_ok_and(|value| value.payload.sequence <= self.highest_sequence)
                }),
            state_sha256: self.fingerprint()?,
        })
    }
}

impl Library {
    pub(crate) fn load_catalog(&self) -> Result<(Catalog, CatalogProvenance)> {
        CatalogState::read(&self.connection()?)?.resolve(Self::now())
    }

    pub fn catalog_status(&self) -> Result<CatalogStatus> {
        CatalogState::read(&self.connection()?)?.status(Self::now())
    }

    pub fn trust_catalog_key(&self, public_key: &str) -> Result<CatalogStatus> {
        let key = crate::CatalogTrustKey::from_public_key(public_key)?;
        let mut connection = self.connection()?;
        let tx = connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let state = CatalogState::read(&tx)?;
        if !state.keys.contains(&key) {
            if state.keys.len() >= 16 {
                return Err(PortcoveError::usage(
                    "at most 16 catalog keys may be trusted",
                ));
            }
            tx.execute(
                "INSERT INTO catalog_trust(key_id,public_key) VALUES(?1,?2)",
                params![key.key_id, key.public_key],
            )?;
            tx.execute(
                "UPDATE catalog_state SET revision=revision+1 WHERE singleton=1",
                [],
            )?;
        }
        let result = CatalogState::read(&tx)?.status(Self::now())?;
        tx.commit()?;
        Ok(result)
    }

    pub fn revoke_catalog_key(&self, key_id: &str, expected_state: &str) -> Result<CatalogStatus> {
        self.change_catalog_selection(expected_state, |tx, _| {
            if tx.execute("DELETE FROM catalog_trust WHERE key_id=?1", [key_id])? == 0 {
                return Err(PortcoveError::not_found(
                    "catalog trust key is not configured",
                ));
            }
            Ok(())
        })
    }

    pub fn use_embedded_catalog(&self, expected_state: &str) -> Result<CatalogStatus> {
        self.change_catalog_selection(expected_state, |tx, _| {
            tx.execute("UPDATE catalog_state SET enabled=0 WHERE singleton=1", [])?;
            Ok(())
        })
    }

    pub fn rollback_catalog(&self, expected_state: &str) -> Result<CatalogStatus> {
        self.change_catalog_selection(expected_state, |tx, state| {
            let previous = state.previous.as_ref().ok_or_else(|| PortcoveError::not_found("no previous signed catalog"))?;
            let verified = signed_catalog::verify(previous, &state.keys, Self::now())?;
            if verified.payload.sequence > state.highest_sequence {
                return Err(PortcoveError::verification("previous catalog exceeds the replay floor"));
            }
            // Do not swap: the rejected newer version must not become the fallback.
            tx.execute("UPDATE catalog_state SET active=previous,previous=NULL,enabled=1 WHERE singleton=1", [])?;
            Ok(())
        })
    }

    pub fn use_cached_catalog(&self, expected_state: &str) -> Result<CatalogStatus> {
        self.change_catalog_selection(expected_state, |tx, state| {
            if !state.status(Self::now())?.can_use_cached {
                return Err(PortcoveError::verification(
                    "no trusted unexpired cached catalog is available",
                ));
            }
            tx.execute("UPDATE catalog_state SET enabled=1 WHERE singleton=1", [])?;
            Ok(())
        })
    }

    fn change_catalog_selection(
        &self,
        expected: &str,
        change: impl FnOnce(&Connection, &CatalogState) -> Result<()>,
    ) -> Result<CatalogStatus> {
        let mut connection = self.connection()?;
        let tx = connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let state = CatalogState::read(&tx)?;
        state.require_review(expected)?;
        change(&tx, &state)?;
        tx.execute(
            "UPDATE catalog_state SET revision=revision+1 WHERE singleton=1",
            [],
        )?;
        let result = CatalogState::read(&tx)?.status(Self::now())?;
        tx.commit()?;
        Ok(result)
    }
}

pub(crate) fn migrate(transaction: &rusqlite::Transaction<'_>) -> Result<()> {
    transaction.execute_batch(&format!(
        "CREATE TABLE catalog_trust(key_id TEXT PRIMARY KEY, public_key TEXT NOT NULL);
         CREATE TABLE catalog_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1),
           revision INTEGER NOT NULL CHECK(revision>=0), highest_sequence INTEGER NOT NULL CHECK(highest_sequence>=0),
           enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
           active BLOB CHECK(length(active)<={MAX_CATALOG_BYTES}), previous BLOB CHECK(length(previous)<={MAX_CATALOG_BYTES}));
         INSERT INTO catalog_state VALUES(1,0,0,0,NULL,NULL);"
    ))?;
    Ok(())
}
