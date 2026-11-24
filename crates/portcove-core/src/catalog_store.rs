//! One transactional authority for public trust, replay protection and catalog selection.
use rusqlite::{Connection, params};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{
    Catalog, CatalogFallbackCode, CatalogProvenance, CatalogTrustKey, Library, PortcoveError,
    Result,
    signed_catalog::{self, CatalogOrigin, LEGACY_MAX_CATALOG_BYTES, MAX_CATALOG_BYTES},
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

struct CatalogStatusEvaluation {
    baseline: Catalog,
    provenance: CatalogProvenance,
    can_rollback: bool,
    can_use_cached: bool,
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
                        // Bundled directory facts remain available while the
                        // signed format continues to select strict definitions.
                        return Ok((value.catalog.with_embedded_listings()?, provenance));
                    }
                    Ok(_) => reasons.push((
                        CatalogFallbackCode::ReplayFloor,
                        "cached catalog exceeds the recorded replay floor".into(),
                    )),
                    Err(error) => reasons.push((
                        error
                            .catalog_fallback()
                            .unwrap_or(CatalogFallbackCode::Unknown),
                        error.message,
                    )),
                }
            }
        }
        let catalog = Catalog::embedded()?;
        let provenance =
            signed_catalog::provenance(&catalog, CatalogOrigin::Embedded, None, reasons)?;
        Ok((catalog, provenance))
    }

    pub fn status(&self, now: i64) -> Result<CatalogStatus> {
        let evaluation = self.evaluate_status(now)?;
        self.status_from_evaluation(&evaluation)
    }

    fn evaluate_status(&self, now: i64) -> Result<CatalogStatusEvaluation> {
        let active = self
            .active
            .as_ref()
            .map(|bytes| signed_catalog::verify(bytes, &self.keys, now));
        let previous = self
            .previous
            .as_ref()
            .map(|bytes| signed_catalog::verify(bytes, &self.keys, now));
        let is_usable = |candidate: &Option<Result<signed_catalog::VerifiedCatalog>>| {
            candidate.as_ref().is_some_and(|result| {
                result
                    .as_ref()
                    .is_ok_and(|value| value.payload.sequence <= self.highest_sequence)
            })
        };
        let active_usable = is_usable(&active);
        let previous_usable = is_usable(&previous);
        let mut reasons = Vec::new();
        let mut selected = None;
        if self.enabled {
            for (candidate, origin) in [
                (&active, CatalogOrigin::SignedActive),
                (&previous, CatalogOrigin::SignedPrevious),
            ] {
                match candidate {
                    None => {}
                    Some(Ok(value)) if value.payload.sequence <= self.highest_sequence => {
                        selected = Some((value, origin));
                        break;
                    }
                    Some(Ok(_)) => reasons.push((
                        CatalogFallbackCode::ReplayFloor,
                        "cached catalog exceeds the recorded replay floor".into(),
                    )),
                    Some(Err(error)) => reasons.push((
                        error
                            .catalog_fallback()
                            .unwrap_or(CatalogFallbackCode::Unknown),
                        error.message.clone(),
                    )),
                }
            }
        }
        let (baseline, provenance) = if let Some((value, origin)) = selected {
            let provenance =
                signed_catalog::provenance(&value.catalog, origin, Some(value), reasons)?;
            (value.catalog.clone(), provenance)
        } else {
            let catalog = Catalog::embedded()?;
            let provenance =
                signed_catalog::provenance(&catalog, CatalogOrigin::Embedded, None, reasons)?;
            (catalog, provenance)
        };
        Ok(CatalogStatusEvaluation {
            baseline,
            provenance,
            can_rollback: previous_usable,
            can_use_cached: active_usable || previous_usable,
        })
    }

    fn status_from_evaluation(
        &self,
        evaluation: &CatalogStatusEvaluation,
    ) -> Result<CatalogStatus> {
        Ok(CatalogStatus {
            provenance: evaluation.provenance.clone(),
            trusted_keys: self.keys.clone(),
            highest_sequence: self.highest_sequence,
            updates_enabled: self.enabled,
            can_rollback: evaluation.can_rollback,
            can_use_cached: evaluation.can_use_cached,
            state_sha256: self.fingerprint()?,
        })
    }
}

fn selected_catalog(
    catalog: Catalog,
    expires_at: i64,
    provenance: CatalogProvenance,
) -> Result<(Catalog, CatalogProvenance)> {
    // Authenticated successors select strict operational definitions. Keep the
    // bundled discovery directory alongside that selection without changing its
    // authoritative document, retained snapshots or operation permissions.
    let catalog = catalog.with_embedded_listings()?;
    let catalog_sha256 = catalog.document_digest()?.sha256.clone();
    Ok((
        catalog,
        CatalogProvenance {
            origin: CatalogOrigin::DefinitionSelected,
            catalog_sha256,
            sequence: None,
            key_id: None,
            expires_at: Some(expires_at),
            fallback_reasons: provenance.fallback_reasons,
            fallback_codes: provenance.fallback_codes,
        },
    ))
}

fn resolve_effective_catalog(
    connection: &Connection,
    state: &CatalogState,
    now: i64,
) -> Result<ResolvedCatalog> {
    let (baseline, provenance) = state.resolve(now)?;
    resolve_effective_catalog_from_baseline(connection, baseline, provenance, now)
}

pub(crate) fn resolve_before_listings(
    connection: &Connection,
    baseline: Catalog,
    mut provenance: CatalogProvenance,
    now: i64,
) -> Result<(Catalog, CatalogProvenance)> {
    let selected = crate::definition_candidate::selection::load_definition_selections(
        connection, &baseline, now,
    );
    let mut report = |subject: Option<String>, error: PortcoveError| {
        let scope = subject.map_or_else(String::new, |id| format!(" for {id}"));
        provenance.push_fallback(
            error
                .catalog_fallback()
                .unwrap_or(CatalogFallbackCode::SelectedDefinitionUnavailable),
            format!(
                "selected definition{scope} was not loaded: {}",
                error.message
            ),
        );
    };
    let selected = match selected {
        Ok(selected) => {
            for (subject, error) in selected.failures {
                report(subject, error);
            }
            selected.catalog
        }
        Err(error) => {
            report(None, error);
            None
        }
    };
    let (mut catalog, provenance) = match selected {
        Some((catalog, expires_at)) => selected_catalog(catalog, expires_at, provenance),
        None => Ok((baseline, provenance)),
    }?;
    let mut statement =
        connection.prepare("SELECT port_id FROM definition_provider_scope_floor")?;
    let held_ports = statement.query_map([], |row| row.get::<_, String>(0))?;
    for port in held_ports {
        catalog.hold_legacy_mod_provider(&port?);
    }
    Ok((catalog, provenance))
}

struct ResolvedCatalog {
    catalog: Catalog,
    provenance: CatalogProvenance,
    reusable_until: i64,
}

fn resolve_effective_catalog_from_baseline(
    connection: &Connection,
    baseline: Catalog,
    provenance: CatalogProvenance,
    now: i64,
) -> Result<ResolvedCatalog> {
    let baseline_expiry = provenance.expires_at;
    let (catalog, mut provenance) = resolve_before_listings(connection, baseline, provenance, now)?;
    let (catalog, listings) =
        crate::definition_repository::publisher_policy::listing_delivery::load(
            connection, catalog, now,
        );
    if let Some(reason) = listings.fallback_reason {
        provenance.push_fallback(
            listings
                .fallback_code
                .unwrap_or(CatalogFallbackCode::ListingDirectoryUnavailable),
            format!("listing directory was not loaded: {reason}"),
        );
    }
    let listing_expiry = listings.expires_at.as_deref().and_then(|expiry| {
        time::OffsetDateTime::parse(expiry, &time::format_description::well_known::Rfc3339)
            .ok()
            .map(time::OffsetDateTime::unix_timestamp)
    });
    // A fallback can change at an issuance boundary, or recover from a
    // transient read error without writing the database. Reevaluate it.
    let reusable_until = if !provenance.fallback_reasons.is_empty() {
        now
    } else {
        [baseline_expiry, provenance.expires_at, listing_expiry]
            .into_iter()
            .flatten()
            .min()
            .unwrap_or(i64::MAX)
    };
    Ok(ResolvedCatalog {
        catalog,
        provenance,
        reusable_until,
    })
}

pub(crate) fn effective_catalog_status(
    connection: &Connection,
    state: &CatalogState,
    now: i64,
) -> Result<CatalogStatus> {
    let evaluation = state.evaluate_status(now)?;
    let resolved = resolve_effective_catalog_from_baseline(
        connection,
        evaluation.baseline.clone(),
        evaluation.provenance.clone(),
        now,
    )?;
    let mut status = state.status_from_evaluation(&evaluation)?;
    status.provenance = resolved.provenance;
    Ok(status)
}

pub(crate) fn load_catalog_from(
    connection: &Connection,
    now: i64,
) -> Result<(Catalog, CatalogProvenance)> {
    let resolved = load_resolved_catalog_from(connection, now)?;
    Ok((resolved.catalog, resolved.provenance))
}

fn load_resolved_catalog_from(connection: &Connection, now: i64) -> Result<ResolvedCatalog> {
    let state = CatalogState::read(connection)?;
    resolve_effective_catalog(connection, &state, now)
}

pub(crate) struct ArtworkCatalogCache {
    // SQLite data_version comparisons only apply to this same connection.
    connection: Connection,
    resolved: Option<ArtworkCatalogObservation>,
}

impl std::fmt::Debug for ArtworkCatalogCache {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ArtworkCatalogCache")
            .field("has_snapshot", &self.resolved.is_some())
            .finish()
    }
}

struct ArtworkCatalogObservation {
    version: i64,
    observed_at: i64,
    resolved: ResolvedCatalog,
}

impl Library {
    pub(crate) fn load_catalog(&self) -> Result<(Catalog, CatalogProvenance)> {
        let connection = self.connection()?;
        let transaction = connection.unchecked_transaction()?;
        let started = std::time::Instant::now();
        let result = load_catalog_from(&transaction, Self::now());
        tracing::debug!(
            elapsed_us = started.elapsed().as_micros() as u64,
            success = result.is_ok(),
            message = "Effective catalog resolution"
        );
        let result = result?;
        transaction.commit()?;
        Ok(result)
    }

    /// Reuse only a resolution on the same library lease, before the first
    /// applicable expiry and without an intervening commit on another
    /// connection. No mutable artwork choice is stored here.
    pub(crate) fn load_artwork_catalog(&self) -> Result<(Catalog, CatalogProvenance)> {
        #[cfg(feature = "qualification-fixtures")]
        if std::env::var_os("PORTCOVE_QUALIFICATION_CATALOG").is_some() {
            return self.load_catalog();
        }
        self.load_artwork_catalog_at(Self::now())
    }

    fn load_artwork_catalog_at(&self, now: i64) -> Result<(Catalog, CatalogProvenance)> {
        let mut slot = self
            .artwork_catalog
            .lock()
            .map_err(|_| PortcoveError::state("artwork catalog cache is unavailable"))?;
        if slot.is_none() {
            *slot = Some(ArtworkCatalogCache {
                connection: self.connection()?,
                resolved: None,
            });
        }
        let cache = slot.as_mut().expect("catalog cache was initialized");
        let version = crate::library::data_version(&cache.connection)?;
        if let Some(observation) = &cache.resolved
            && observation.version == version
            && (observation.observed_at..observation.resolved.reusable_until).contains(&now)
        {
            tracing::debug!(message = "Artwork catalog snapshot reused");
            return Ok((
                observation.resolved.catalog.clone(),
                observation.resolved.provenance.clone(),
            ));
        }
        cache.resolved = None;
        let transaction = cache.connection.unchecked_transaction()?;
        let started = std::time::Instant::now();
        let resolved = load_resolved_catalog_from(&transaction, now);
        tracing::debug!(
            elapsed_us = started.elapsed().as_micros() as u64,
            success = resolved.is_ok(),
            message = "Effective catalog resolution"
        );
        let resolved = resolved?;
        transaction.commit()?;
        let result = (resolved.catalog.clone(), resolved.provenance.clone());
        if crate::library::data_version(&cache.connection)? == version {
            cache.resolved = Some(ArtworkCatalogObservation {
                version,
                observed_at: now,
                resolved,
            });
        }
        Ok(result)
    }

    pub fn catalog_status(&self) -> Result<CatalogStatus> {
        let connection = self.connection()?;
        let transaction = connection.unchecked_transaction()?;
        let state = CatalogState::read(&transaction)?;
        let result = effective_catalog_status(&transaction, &state, Self::now())?;
        transaction.commit()?;
        Ok(result)
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
        let state = CatalogState::read(&tx)?;
        let result = effective_catalog_status(&tx, &state, Self::now())?;
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
        let state = CatalogState::read(&tx)?;
        let result = effective_catalog_status(&tx, &state, Self::now())?;
        tx.commit()?;
        Ok(result)
    }
}

fn catalog_state_table(name: &str, bound: usize) -> String {
    format!(
        "CREATE TABLE {name}(singleton INTEGER PRIMARY KEY CHECK(singleton=1),
           revision INTEGER NOT NULL CHECK(revision>=0), highest_sequence INTEGER NOT NULL CHECK(highest_sequence>=0),
           enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
           active BLOB CHECK(length(active)<={bound}), previous BLOB CHECK(length(previous)<={bound}));"
    )
}

/// Historical migration 11. Its schema keeps the 4 MiB bound that released
/// clients created; migration 60 rebuilds the table with the current bound.
pub(crate) fn migrate(transaction: &rusqlite::Transaction<'_>) -> Result<()> {
    transaction.execute_batch(&format!(
        "CREATE TABLE catalog_trust(key_id TEXT PRIMARY KEY, public_key TEXT NOT NULL);
         {}
         INSERT INTO catalog_state VALUES(1,0,0,0,NULL,NULL);",
        catalog_state_table("catalog_state", LEGACY_MAX_CATALOG_BYTES)
    ))?;
    Ok(())
}

/// The bound migration 60 wrote. Frozen: recorded migrations are re-verified on
/// every open, so a later raise of `MAX_CATALOG_BYTES` must add its own rebuild
/// migration instead of changing what schema 60 means.
pub(crate) const CATALOG_BOUND_V60: usize = 16 * 1024 * 1024;
// Stored envelopes must fit the table's checks; a larger runtime bound needs a
// new rebuild migration first.
const _: () = assert!(MAX_CATALOG_BYTES <= CATALOG_BOUND_V60);

/// Rebuild `catalog_state` with BLOB checks at `bound`. SQLite cannot alter a
/// CHECK in place. The singleton row is copied unchanged inside the caller's
/// migration transaction; a failure rolls the whole migration back.
pub(crate) fn rebuild_catalog_state(
    transaction: &rusqlite::Transaction<'_>,
    bound: usize,
) -> Result<()> {
    transaction.execute_batch(&format!(
        "{}
         INSERT INTO catalog_state_rebuild(singleton,revision,highest_sequence,enabled,active,previous)
           SELECT singleton,revision,highest_sequence,enabled,active,previous FROM catalog_state;
         DROP TABLE catalog_state;
         ALTER TABLE catalog_state_rebuild RENAME TO catalog_state;",
        catalog_state_table("catalog_state_rebuild", bound)
    ))?;
    Ok(())
}

/// Migration 60: widen the 4 MiB checks to the frozen schema-60 bound.
pub(crate) fn migrate_catalog_bound(transaction: &rusqlite::Transaction<'_>) -> Result<()> {
    rebuild_catalog_state(transaction, CATALOG_BOUND_V60)?;
    verify_catalog_bound(transaction)
}

fn stored_bound(schema: &str, column: &str) -> Option<usize> {
    let prefix = format!("length({column})<=");
    let start = schema.find(&prefix)? + prefix.len();
    let digits: String = schema[start..]
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    digits.parse().ok()
}

/// Schema 60 holds while exactly one singleton row remains and both BLOB checks
/// admit at least the schema-60 bound. A later migration may widen them again.
pub(crate) fn verify_catalog_bound(connection: &Connection) -> Result<()> {
    let schema: String = connection.query_row(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='catalog_state'",
        [],
        |row| row.get(0),
    )?;
    let rows: i64 =
        connection.query_row("SELECT count(*) FROM catalog_state", [], |row| row.get(0))?;
    let admits =
        |column| stored_bound(&schema, column).is_some_and(|bound| bound >= CATALOG_BOUND_V60);
    if rows != 1 || !admits("active") || !admits("previous") {
        return Err(PortcoveError::state(
            "signed catalog state does not admit the schema-60 catalog bound",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod artwork_cache_tests {
    use super::*;

    #[test]
    fn artwork_catalog_reuses_reads_until_a_commit_or_clock_boundary() {
        let directory = tempfile::tempdir().unwrap();
        let library = Library::open(directory.path().join("library")).unwrap();
        let now = Library::now();
        let (_, original) = library.load_artwork_catalog_at(now).unwrap();
        let observed_at = || {
            let cache = library.artwork_catalog.lock().unwrap();
            cache
                .as_ref()
                .unwrap()
                .resolved
                .as_ref()
                .unwrap()
                .observed_at
        };
        let (_, reused) = library.load_artwork_catalog_at(now + 1).unwrap();
        assert_eq!(original, reused);
        assert_eq!(observed_at(), now);

        library
            .connection()
            .unwrap()
            .execute(
                "UPDATE catalog_state SET revision=revision+1 WHERE singleton=1",
                [],
            )
            .unwrap();
        library.load_artwork_catalog_at(now + 2).unwrap();
        assert_eq!(observed_at(), now + 2);

        library.load_artwork_catalog_at(now - 1).unwrap();
        assert_eq!(observed_at(), now - 1);

        {
            let mut cache = library.artwork_catalog.lock().unwrap();
            cache
                .as_mut()
                .unwrap()
                .resolved
                .as_mut()
                .unwrap()
                .resolved
                .reusable_until = now;
        }
        library.load_artwork_catalog_at(now).unwrap();
        assert_eq!(observed_at(), now);
    }
}
