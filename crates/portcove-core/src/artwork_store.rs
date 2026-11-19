use std::collections::BTreeSet;

use rusqlite::{Connection, OptionalExtension, Transaction, params};

use crate::{
    ArtworkAttribution, ArtworkChoice, ArtworkMetadata, ArtworkProviderRecord, ArtworkSlot,
    LocalArtworkAsset, PortcoveError, Result,
};

const MAX_ASSETS: usize = 4096;
const MAX_TOTAL_BYTES: u64 = 1024 * 1024 * 1024;
/// Distinct provider images that resolved to stored bytes; identical bytes from
/// several provider images keep one record each.
const MAX_PROVIDER_RECORDS: usize = 16384;
const MAX_AUTHOR_CHARS: usize = 100;
/// Distinct provider images recorded for one asset; read, write and import agree.
const MAX_PROVIDER_RECORDS_PER_ASSET: usize = 64;
/// Fetch times may sit at most a day ahead of this host's clock.
const MAX_FETCHED_AT_SKEW_SECONDS: i64 = 24 * 60 * 60;

/// Library migration 52: provider provenance beside, never inside, asset payloads,
/// so assets imported locally keep their stored form byte-for-byte.
pub(crate) fn migrate_providers(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        "CREATE TABLE artwork_asset_providers (
            asset_sha256 TEXT NOT NULL REFERENCES artwork_assets(sha256),
            provider TEXT NOT NULL CHECK(provider IN ('steamgriddb')),
            asset_id INTEGER NOT NULL CHECK(asset_id>0),
            record_json TEXT NOT NULL CHECK(length(record_json)<=8192),
            PRIMARY KEY(asset_sha256,provider,asset_id)
        );
        CREATE TABLE artwork_provider_only_assets (
            asset_sha256 TEXT PRIMARY KEY NOT NULL REFERENCES artwork_assets(sha256)
        );",
    )?;
    Ok(())
}

pub(crate) fn validate_attribution(attribution: &ArtworkAttribution) -> Result<()> {
    let name = &attribution.author_name;
    if attribution.asset_id == 0
        || attribution.asset_id > i64::MAX as u64
        || attribution.game_id == 0
        || name.trim() != name
        || name.is_empty()
        || name.chars().count() > MAX_AUTHOR_CHARS
        || name.chars().any(char::is_control)
        || attribution.author_steam64.as_ref().is_some_and(|id| {
            id.is_empty() || id.len() > 20 || !id.bytes().all(|byte| byte.is_ascii_digit())
        })
        || !crate::artwork::steamgriddb::is_image_url(&attribution.source_url)
        || attribution.fetched_at <= 0
    {
        return Err(PortcoveError::verification(
            "invalid artwork provider attribution",
        ));
    }
    Ok(())
}

pub(crate) fn migrate(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch("CREATE TABLE artwork_assets (
        sha256 TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, byte_size INTEGER NOT NULL CHECK(byte_size>0)
    ); CREATE TABLE artwork_choices (
        port_id TEXT NOT NULL, slot TEXT NOT NULL CHECK(slot IN ('cover','detail')),
        revision INTEGER NOT NULL CHECK(revision>0), asset_sha256 TEXT REFERENCES artwork_assets(sha256),
        PRIMARY KEY(port_id,slot)
    ); CREATE TABLE artwork_thumbnails (
        asset_sha256 TEXT PRIMARY KEY NOT NULL REFERENCES artwork_assets(sha256),
        format_version INTEGER NOT NULL, sha256 TEXT NOT NULL, byte_size INTEGER NOT NULL CHECK(byte_size>0)
    );")?;
    Ok(())
}

const LANDSCAPE_CHOICES_TABLE: &str = "CREATE TABLE artwork_choices (
        port_id TEXT NOT NULL, slot TEXT NOT NULL CHECK(slot IN ('cover','detail','landscape')),
        revision INTEGER NOT NULL CHECK(revision>0), asset_sha256 TEXT REFERENCES artwork_assets(sha256),
        PRIMARY KEY(port_id,slot)
    )";

/// Library migration 57: the same choice table with the landscape slot admitted.
/// Nothing references `artwork_choices`, so the rename keeps every constraint.
pub(crate) fn migrate_landscape_slot(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(&format!(
        "ALTER TABLE artwork_choices RENAME TO artwork_choices_v56;
        {LANDSCAPE_CHOICES_TABLE};
        INSERT INTO artwork_choices(port_id,slot,revision,asset_sha256)
            SELECT port_id,slot,revision,asset_sha256 FROM artwork_choices_v56;
        DROP TABLE artwork_choices_v56;"
    ))?;
    Ok(())
}

/// Checked on migration and every later open: the stored definition admits the
/// landscape slot and no intermediate table remains.
pub(crate) fn verify_landscape_slot(connection: &Connection) -> Result<()> {
    let definition: Option<String> = connection
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='artwork_choices'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    let leftover: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='artwork_choices_v56')",
        [],
        |row| row.get(0),
    )?;
    if leftover
        || !definition
            .is_some_and(|sql| sql.contains("CHECK(slot IN ('cover','detail','landscape'))"))
    {
        return Err(PortcoveError::state(
            "artwork choices do not admit the landscape slot",
        ));
    }
    Ok(())
}

/// Library migration 58: listing-check evidence beside each provider record. It
/// is keyed exactly like the record, so grid and hero IDs never mix and an image
/// stored under two assets has one row per asset, and it cascades with the record.
pub(crate) const LISTING_CHECKS_TABLE: &str = "CREATE TABLE artwork_provider_listing_checks (
            asset_sha256 TEXT NOT NULL,
            provider TEXT NOT NULL CHECK(provider IN ('steamgriddb')),
            asset_id INTEGER NOT NULL CHECK(asset_id>0),
            revision INTEGER NOT NULL CHECK(revision>=1),
            last_checked_at INTEGER NOT NULL CHECK(last_checked_at>0),
            last_result TEXT NOT NULL CHECK(last_result IN ('listed','not_listed','unknown')),
            unknown_reason TEXT CHECK(unknown_reason IS NULL OR length(unknown_reason) BETWEEN 1 AND 64),
            not_listed_since INTEGER CHECK(not_listed_since IS NULL OR not_listed_since>0),
            last_listing_total INTEGER CHECK(last_listing_total IS NULL OR last_listing_total>=0),
            last_source_status TEXT CHECK(last_source_status IS NULL OR last_source_status IN ('served','gone','unknown')),
            PRIMARY KEY(asset_sha256,provider,asset_id),
            FOREIGN KEY(asset_sha256,provider,asset_id) REFERENCES artwork_asset_providers(asset_sha256,provider,asset_id) ON DELETE CASCADE,
            CHECK((last_result='unknown')=(unknown_reason IS NOT NULL)),
            CHECK(last_result!='listed' OR not_listed_since IS NULL),
            CHECK(last_result!='not_listed' OR not_listed_since IS NOT NULL)
        )";

/// One sequence for every listing-check write, so a revision is never reused,
/// even when a row is removed and created again.
const LISTING_CHECK_REVISIONS_TABLE: &str = "CREATE TABLE artwork_listing_check_revisions (
            id INTEGER PRIMARY KEY CHECK(id=1),
            next INTEGER NOT NULL CHECK(next>=1)
        )";

pub(crate) fn migrate_listing_checks(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(LISTING_CHECKS_TABLE)?;
    transaction.execute_batch(LISTING_CHECK_REVISIONS_TABLE)?;
    Ok(())
}

fn next_listing_revision(connection: &Connection) -> Result<u64> {
    Ok(connection.query_row(
        // The sequence row is created by its first use.
        "INSERT INTO artwork_listing_check_revisions(id,next) VALUES (1,2)
         ON CONFLICT(id) DO UPDATE SET next=next+1 RETURNING next-1",
        [],
        |row| row.get(0),
    )?)
}

/// Checked on migration and every later open: the stored definition keeps the
/// composite key, the cascading foreign key and the state constraints.
pub(crate) fn verify_listing_checks(connection: &Connection) -> Result<()> {
    let definition: Option<String> = connection
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='artwork_provider_listing_checks'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    let required = [
        "PRIMARY KEY(asset_sha256,provider,asset_id)",
        "revision INTEGER NOT NULL CHECK(revision>=1)",
        "FOREIGN KEY(asset_sha256,provider,asset_id) REFERENCES artwork_asset_providers(asset_sha256,provider,asset_id) ON DELETE CASCADE",
        "CHECK((last_result='unknown')=(unknown_reason IS NOT NULL))",
        "CHECK(last_result!='listed' OR not_listed_since IS NULL)",
        "CHECK(last_result!='not_listed' OR not_listed_since IS NOT NULL)",
    ];
    let sequence_table: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='artwork_listing_check_revisions')",
        [],
        |row| row.get(0),
    )?;
    if !definition.is_some_and(|sql| required.iter().all(|clause| sql.contains(clause)))
        || !sequence_table
    {
        return Err(PortcoveError::state(
            "artwork listing checks are missing or incomplete",
        ));
    }
    Ok(())
}

/// Library migration 59: withdrawals and evictions. A withdrawal is decided only
/// when a check applies its observation, and an applied listing deletes it, so the
/// rows always follow the latest verified evidence. An eviction marker names an
/// asset whose original Portcove removed; its record and choice stay.
pub(crate) const WITHDRAWALS_TABLE: &str = "CREATE TABLE artwork_provider_withdrawals (
            asset_sha256 TEXT NOT NULL,
            provider TEXT NOT NULL CHECK(provider IN ('steamgriddb')),
            asset_id INTEGER NOT NULL CHECK(asset_id>0),
            withdrawn_at INTEGER NOT NULL CHECK(withdrawn_at>0),
            signal TEXT NOT NULL CHECK(signal IN ('gone','absent_again')),
            PRIMARY KEY(asset_sha256,provider,asset_id),
            FOREIGN KEY(asset_sha256,provider,asset_id) REFERENCES artwork_asset_providers(asset_sha256,provider,asset_id) ON DELETE CASCADE
        )";

/// The marker requires the provider-only marker. The default `NO ACTION` keeps
/// that enforced at statement end while staying deferrable for table rebuilds.
pub(crate) const EVICTED_ASSETS_TABLE: &str = "CREATE TABLE artwork_evicted_assets (
            asset_sha256 TEXT PRIMARY KEY NOT NULL,
            evicted_at INTEGER NOT NULL CHECK(evicted_at>0),
            FOREIGN KEY(asset_sha256) REFERENCES artwork_provider_only_assets(asset_sha256)
        )";

const SERVER_ABSENCE_COLUMN: &str = "not_listed_since_server INTEGER CHECK(not_listed_since_server IS NULL OR not_listed_since_server>0)";

pub(crate) fn migrate_withdrawals(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(WITHDRAWALS_TABLE)?;
    transaction.execute_batch(EVICTED_ASSETS_TABLE)?;
    transaction.execute_batch(&format!(
        "ALTER TABLE artwork_provider_listing_checks ADD COLUMN {SERVER_ABSENCE_COLUMN}"
    ))?;
    Ok(())
}

fn table_definition(connection: &Connection, name: &str) -> Result<Option<String>> {
    Ok(connection
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name=?1",
            [name],
            |row| row.get(0),
        )
        .optional()?)
}

/// Checked on migration and every later open; definitions only, never data.
pub(crate) fn verify_withdrawals(connection: &Connection) -> Result<()> {
    let complete = |name: &str, required: &[&str]| -> Result<bool> {
        Ok(table_definition(connection, name)?
            .is_some_and(|sql| required.iter().all(|clause| sql.contains(clause))))
    };
    if !complete(
        "artwork_provider_withdrawals",
        &[
            "PRIMARY KEY(asset_sha256,provider,asset_id)",
            "FOREIGN KEY(asset_sha256,provider,asset_id) REFERENCES artwork_asset_providers(asset_sha256,provider,asset_id) ON DELETE CASCADE",
            "CHECK(signal IN ('gone','absent_again'))",
            "CHECK(withdrawn_at>0)",
        ],
    )? || !complete(
        "artwork_evicted_assets",
        &[
            "asset_sha256 TEXT PRIMARY KEY NOT NULL",
            "FOREIGN KEY(asset_sha256) REFERENCES artwork_provider_only_assets(asset_sha256)",
            "CHECK(evicted_at>0)",
        ],
    )? || !complete("artwork_provider_listing_checks", &[SERVER_ABSENCE_COLUMN])?
    {
        return Err(PortcoveError::state(
            "artwork withdrawals are missing or incomplete",
        ));
    }
    Ok(())
}

/// One provider record's stored listing evidence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ListingCheckRow {
    pub(crate) asset_sha256: String,
    pub(crate) asset_id: u64,
    /// Incremented by every write, so a check can tell whether the row changed
    /// while it ran, even within the same second.
    pub(crate) revision: u64,
    pub(crate) last_checked_at: i64,
    /// `listed`, `not_listed` or `unknown`.
    pub(crate) last_result: String,
    pub(crate) unknown_reason: Option<String>,
    /// The first verified absence, kept until an observed listing clears it.
    pub(crate) not_listed_since: Option<i64>,
    pub(crate) last_listing_total: Option<u64>,
    /// `served`, `gone` or `unknown`; kept until a newer probe answers. It is
    /// informational: only a probe in the same check can confirm a withdrawal.
    pub(crate) last_source_status: Option<String>,
    /// SteamGridDB's own `Date` for the first absence, so the 24-hour wait holds
    /// by its clock as well as Portcove's.
    pub(crate) not_listed_since_server: Option<i64>,
}

const LISTING_CHECK_COLUMNS: &str = "asset_sha256,asset_id,revision,last_checked_at,last_result,unknown_reason,not_listed_since,last_listing_total,last_source_status,not_listed_since_server";

fn listing_check_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ListingCheckRow> {
    Ok(ListingCheckRow {
        asset_sha256: row.get(0)?,
        asset_id: row.get(1)?,
        revision: row.get(2)?,
        last_checked_at: row.get(3)?,
        last_result: row.get(4)?,
        unknown_reason: row.get(5)?,
        not_listed_since: row.get(6)?,
        last_listing_total: row.get(7)?,
        last_source_status: row.get(8)?,
        not_listed_since_server: row.get(9)?,
    })
}

/// Every stored listing check for one provider, bounded like the records.
pub(crate) fn listing_checks(
    connection: &Connection,
    provider: crate::ArtworkProvider,
) -> Result<Vec<ListingCheckRow>> {
    let mut statement = connection.prepare(&format!(
        "SELECT {LISTING_CHECK_COLUMNS} FROM artwork_provider_listing_checks WHERE provider=?1 ORDER BY asset_sha256,asset_id LIMIT {}",
        MAX_PROVIDER_RECORDS + 1
    ))?;
    let rows = statement
        .query_map([provider.key()], listing_check_row)?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if rows.len() > MAX_PROVIDER_RECORDS {
        return Err(PortcoveError::verification(
            "artwork listing checks exceed their limit",
        ));
    }
    Ok(rows)
}

fn listing_check(
    connection: &Connection,
    provider: crate::ArtworkProvider,
    asset_sha256: &str,
    asset_id: u64,
) -> Result<Option<ListingCheckRow>> {
    Ok(connection
        .query_row(
            &format!(
                "SELECT {LISTING_CHECK_COLUMNS} FROM artwork_provider_listing_checks WHERE asset_sha256=?1 AND provider=?2 AND asset_id=?3"
            ),
            params![asset_sha256, provider.key(), asset_id],
            listing_check_row,
        )
        .optional()?)
}

/// The recorded evidence for every provider record of one asset.
pub(crate) fn asset_listing_evidence(
    connection: &Connection,
    asset_sha256: &str,
) -> Result<Vec<crate::ArtworkProviderListing>> {
    validate_hash(asset_sha256)?;
    let mut statement = connection.prepare(&format!(
        "SELECT provider,{LISTING_CHECK_COLUMNS} FROM artwork_provider_listing_checks WHERE asset_sha256=?1 ORDER BY provider,asset_id LIMIT {}",
        MAX_PROVIDER_RECORDS_PER_ASSET + 1
    ))?;
    let rows = statement
        .query_map([asset_sha256], |row| {
            let provider: String = row.get(0)?;
            Ok((
                provider,
                ListingCheckRow {
                    asset_sha256: row.get(1)?,
                    asset_id: row.get(2)?,
                    revision: row.get(3)?,
                    last_checked_at: row.get(4)?,
                    last_result: row.get(5)?,
                    unknown_reason: row.get(6)?,
                    not_listed_since: row.get(7)?,
                    last_listing_total: row.get(8)?,
                    last_source_status: row.get(9)?,
                    not_listed_since_server: row.get(10)?,
                },
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if rows.len() > MAX_PROVIDER_RECORDS_PER_ASSET {
        return Err(PortcoveError::verification(
            "artwork asset has too many listing checks",
        ));
    }
    let withdrawals = asset_withdrawals(connection, asset_sha256)?;
    rows.into_iter()
        .map(|(provider, row)| {
            let provider = match provider.as_str() {
                "steamgriddb" => crate::ArtworkProvider::Steamgriddb,
                _ => {
                    return Err(PortcoveError::verification(
                        "artwork listing check names an unknown provider",
                    ));
                }
            };
            let last_result = match (row.last_result.as_str(), row.unknown_reason.as_deref()) {
                ("listed", None) => crate::SteamGridDbListingResult::Listed,
                ("not_listed", None) => crate::SteamGridDbListingResult::NotListed,
                ("unknown", Some(reason)) => crate::SteamGridDbListingResult::Unknown {
                    reason: serde_json::from_value(serde_json::Value::String(reason.to_owned()))
                        .map_err(|_| {
                            PortcoveError::verification(
                                "artwork listing check has an unknown reason",
                            )
                        })?,
                },
                _ => {
                    return Err(PortcoveError::verification(
                        "artwork listing check has an invalid result",
                    ));
                }
            };
            let withdrawal = withdrawals
                .iter()
                .find(|(key, withdrawal)| {
                    key == provider.key() && withdrawal.asset_id == row.asset_id
                })
                .map(|(_, withdrawal)| withdrawal);
            Ok(crate::ArtworkProviderListing {
                provider,
                asset_id: row.asset_id,
                last_checked_at: row.last_checked_at,
                last_result,
                not_listed_since: row.not_listed_since,
                withdrawn_at: withdrawal.map(|withdrawal| withdrawal.withdrawn_at),
                withdrawal_signal: withdrawal
                    .map(|withdrawal| match withdrawal.signal.as_str() {
                        "gone" => Ok(crate::ArtworkWithdrawalSignal::Gone),
                        "absent_again" => Ok(crate::ArtworkWithdrawalSignal::AbsentAgain),
                        _ => Err(PortcoveError::verification(
                            "artwork withdrawal has an unknown signal",
                        )),
                    })
                    .transpose()?,
            })
        })
        .collect()
}

/// Choosing an image re-resolves it from the provider's own listing, which is
/// the strongest presence evidence there is: it clears any absence clock. Runs
/// in the same transaction as the provider record it follows.
pub(crate) fn mark_listed_on_choose(
    connection: &Connection,
    provider: crate::ArtworkProvider,
    asset_sha256: &str,
    asset_id: u64,
    now: i64,
) -> Result<()> {
    let revision = next_listing_revision(connection)?;
    // The file was just downloaded, so an earlier source answer no longer applies.
    connection.execute(
        "INSERT INTO artwork_provider_listing_checks(asset_sha256,provider,asset_id,revision,last_checked_at,last_result)
         VALUES (?1,?2,?3,?5,?4,'listed')
         ON CONFLICT(asset_sha256,provider,asset_id) DO UPDATE SET
            revision=excluded.revision,
            last_checked_at=excluded.last_checked_at,
            last_result='listed',
            unknown_reason=NULL,
            not_listed_since=NULL,
            last_source_status=NULL,
            not_listed_since_server=NULL",
        params![asset_sha256, provider.key(), asset_id, now.max(1), revision],
    )?;
    connection.execute(
        "DELETE FROM artwork_provider_withdrawals WHERE asset_sha256=?1 AND provider=?2 AND asset_id=?3",
        params![asset_sha256, provider.key(), asset_id],
    )?;
    Ok(())
}

/// What one check concluded for one record.
pub(crate) struct ListingObservation<'a> {
    /// `listed`, `not_listed` or `unknown`.
    pub(crate) result: &'a str,
    pub(crate) unknown_reason: Option<&'a str>,
    pub(crate) total: Option<u64>,
    /// `served`, `gone` or `unknown`; `None` when the source was not probed.
    pub(crate) source: Option<&'a str>,
    /// SteamGridDB's `Date` across this listing's responses, when readable.
    pub(crate) server_dates: Option<(i64, i64)>,
}

/// How long a first absence must stand, by both clocks, before a second
/// verified absence confirms a withdrawal.
pub(crate) const WITHDRAWAL_WAIT_SECONDS: i64 = 24 * 60 * 60;

/// What applying one observation did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Applied {
    /// The record changed or was removed during the check; nothing was written.
    Skipped,
    Recorded(WithdrawalChange),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WithdrawalChange {
    Unchanged,
    /// This observation confirmed the withdrawal.
    Withdrawn,
    /// An observed listing cleared an earlier withdrawal.
    Cleared,
}

/// The withdrawal rule, decided only from the observation being applied:
/// a verified absence (`not_listed`) plus either a `gone` answer from a probe
/// in the same check, or an earlier absence that has stood for 24 hours by both
/// Portcove's clock and SteamGridDB's `Date`. An unknown result, a probe from an
/// earlier check, or a missing date can never confirm one.
fn withdrawal_signal(
    observation: &ListingObservation<'_>,
    previous: Option<&ListingCheckRow>,
    now: i64,
) -> Option<&'static str> {
    // A confirmation dated by a clock outside any plausible range would make
    // the library's metadata unreadable, so it confirms nothing.
    if observation.result != "not_listed" || !valid_event_time(now) {
        return None;
    }
    if observation.source == Some("gone") {
        return Some("gone");
    }
    let first = previous?.not_listed_since?;
    let first_server = previous?.not_listed_since_server?;
    let (earliest, _) = observation.server_dates?;
    (now.checked_sub(first)? >= WITHDRAWAL_WAIT_SECONDS
        && earliest.checked_sub(first_server)? >= WITHDRAWAL_WAIT_SECONDS)
        .then_some("absent_again")
}

/// Applies one observation only if the record still exists and its stored
/// `revision` is still the one the check started from, so a choice,
/// removal or concurrent check in between is never overwritten. An absence keeps
/// its first time; only an observed listing clears it; an unknown result never
/// sets or clears it. A withdrawal is recorded only by [`withdrawal_signal`] and
/// deleted by an observed listing, so stored withdrawals follow the latest
/// verified evidence.
pub(crate) fn apply_listing_check(
    connection: &Connection,
    provider: crate::ArtworkProvider,
    asset_sha256: &str,
    asset_id: u64,
    expected_revision: Option<u64>,
    observation: &ListingObservation<'_>,
    now: i64,
) -> Result<Applied> {
    let record_exists: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM artwork_asset_providers WHERE asset_sha256=?1 AND provider=?2 AND asset_id=?3)",
        params![asset_sha256, provider.key(), asset_id],
        |row| row.get(0),
    )?;
    if !record_exists {
        return Ok(Applied::Skipped);
    }
    let current = listing_check(connection, provider, asset_sha256, asset_id)?;
    if current.as_ref().map(|row| row.revision) != expected_revision {
        return Ok(Applied::Skipped);
    }
    let previous_absence = current.as_ref().and_then(|row| row.not_listed_since);
    let previous_server = current.as_ref().and_then(|row| row.not_listed_since_server);
    let (not_listed_since, not_listed_since_server) = match observation.result {
        "listed" => (None, None),
        // The server date is filled by the first absence that carries one, so
        // a row without it (an older check, or no readable `Date`) catches up.
        "not_listed" => (
            Some(previous_absence.unwrap_or(now)),
            previous_server.or(observation.server_dates.map(|(_, latest)| latest)),
        ),
        "unknown" => (previous_absence, previous_absence.and(previous_server)),
        _ => {
            return Err(PortcoveError::state("unknown artwork listing result"));
        }
    };
    let signal = withdrawal_signal(observation, current.as_ref(), now);
    let source = match observation.source {
        // An observed listing supersedes any earlier source answer.
        _ if observation.result == "listed" => None,
        Some(status @ ("served" | "gone")) => Some(status.to_owned()),
        // An unanswered probe never erases an earlier answer.
        Some("unknown") | None => current
            .as_ref()
            .and_then(|row| row.last_source_status.clone())
            .or_else(|| observation.source.map(str::to_owned)),
        Some(_) => {
            return Err(PortcoveError::state("unknown artwork source status"));
        }
    };
    let total = observation
        .total
        .filter(|total| i64::try_from(*total).is_ok())
        .or_else(|| current.as_ref().and_then(|row| row.last_listing_total));
    let revision = next_listing_revision(connection)?;
    connection.execute(
        "INSERT INTO artwork_provider_listing_checks(asset_sha256,provider,asset_id,revision,last_checked_at,last_result,unknown_reason,not_listed_since,last_listing_total,last_source_status,not_listed_since_server)
         VALUES (?1,?2,?3,?10,?4,?5,?6,?7,?8,?9,?11)
         ON CONFLICT(asset_sha256,provider,asset_id) DO UPDATE SET
            revision=excluded.revision,
            last_checked_at=excluded.last_checked_at,
            last_result=excluded.last_result,
            unknown_reason=excluded.unknown_reason,
            not_listed_since=excluded.not_listed_since,
            last_listing_total=excluded.last_listing_total,
            last_source_status=excluded.last_source_status,
            not_listed_since_server=excluded.not_listed_since_server",
        params![
            asset_sha256,
            provider.key(),
            asset_id,
            now.max(1),
            observation.result,
            observation.unknown_reason,
            not_listed_since,
            total,
            source,
            revision,
            not_listed_since_server,
        ],
    )?;
    let change = if observation.result == "listed" {
        let cleared = connection.execute(
            "DELETE FROM artwork_provider_withdrawals WHERE asset_sha256=?1 AND provider=?2 AND asset_id=?3",
            params![asset_sha256, provider.key(), asset_id],
        )?;
        if cleared > 0 {
            WithdrawalChange::Cleared
        } else {
            WithdrawalChange::Unchanged
        }
    } else if let Some(signal) = signal {
        // An existing withdrawal keeps its first confirmation.
        let inserted = connection.execute(
            "INSERT INTO artwork_provider_withdrawals(asset_sha256,provider,asset_id,withdrawn_at,signal)
             VALUES (?1,?2,?3,?4,?5) ON CONFLICT DO NOTHING",
            params![asset_sha256, provider.key(), asset_id, now.max(1), signal],
        )?;
        if inserted > 0 {
            WithdrawalChange::Withdrawn
        } else {
            WithdrawalChange::Unchanged
        }
    } else {
        WithdrawalChange::Unchanged
    };
    Ok(Applied::Recorded(change))
}

/// One confirmed withdrawal of a provider record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WithdrawalRow {
    pub(crate) asset_id: u64,
    pub(crate) withdrawn_at: i64,
    /// `gone` or `absent_again`.
    pub(crate) signal: String,
}

pub(crate) fn asset_withdrawals(
    connection: &Connection,
    asset_sha256: &str,
) -> Result<Vec<(String, WithdrawalRow)>> {
    let mut statement = connection.prepare(&format!(
        "SELECT provider,asset_id,withdrawn_at,signal FROM artwork_provider_withdrawals WHERE asset_sha256=?1 ORDER BY provider,asset_id LIMIT {}",
        MAX_PROVIDER_RECORDS_PER_ASSET + 1
    ))?;
    let rows = statement
        .query_map([asset_sha256], |row| {
            Ok((
                row.get::<_, String>(0)?,
                WithdrawalRow {
                    asset_id: row.get(1)?,
                    withdrawn_at: row.get(2)?,
                    signal: row.get(3)?,
                },
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if rows.len() > MAX_PROVIDER_RECORDS_PER_ASSET {
        return Err(PortcoveError::verification(
            "artwork asset has too many withdrawals",
        ));
    }
    Ok(rows)
}

/// Whether an asset meets the eviction rule now: Portcove holds it only for
/// provider records, it has at least one, and every one is withdrawn. A
/// player's own import is never provider-only, so it is never evicted.
pub(crate) fn evictable(connection: &Connection, asset_sha256: &str) -> Result<bool> {
    Ok(connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM artwork_provider_only_assets p
            WHERE p.asset_sha256=?1
              AND NOT EXISTS(SELECT 1 FROM artwork_evicted_assets e WHERE e.asset_sha256=p.asset_sha256)
              AND EXISTS(SELECT 1 FROM artwork_asset_providers r WHERE r.asset_sha256=p.asset_sha256)
              AND NOT EXISTS(SELECT 1 FROM artwork_asset_providers r
                    WHERE r.asset_sha256=p.asset_sha256
                      AND NOT EXISTS(SELECT 1 FROM artwork_provider_withdrawals w
                            WHERE w.asset_sha256=r.asset_sha256 AND w.provider=r.provider AND w.asset_id=r.asset_id)))",
        [asset_sha256],
        |row| row.get(0),
    )?)
}

pub(crate) fn mark_evicted(connection: &Connection, asset_sha256: &str, now: i64) -> Result<()> {
    validate_hash(asset_sha256)?;
    connection.execute(
        "INSERT INTO artwork_evicted_assets(asset_sha256,evicted_at) VALUES (?1,?2) ON CONFLICT DO NOTHING",
        params![asset_sha256, now.max(1)],
    )?;
    Ok(())
}

/// When Portcove removed this asset's original, if it did. The marker is the
/// authority for every reader: an evicted original is never read or handed out,
/// even while its file is still waiting to be deleted.
pub(crate) fn evicted_at(connection: &Connection, asset_sha256: &str) -> Result<Option<i64>> {
    Ok(connection
        .query_row(
            "SELECT evicted_at FROM artwork_evicted_assets WHERE asset_sha256=?1",
            [asset_sha256],
            |row| row.get(0),
        )
        .optional()?)
}

/// Every evicted asset, bounded like the assets.
pub(crate) fn evicted_assets(connection: &Connection) -> Result<Vec<(String, i64)>> {
    let mut statement = connection.prepare(&format!(
        "SELECT asset_sha256,evicted_at FROM artwork_evicted_assets ORDER BY asset_sha256 LIMIT {}",
        MAX_ASSETS + 1
    ))?;
    let rows = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if rows.len() > MAX_ASSETS {
        return Err(PortcoveError::verification(
            "evicted artwork exceeds its limit",
        ));
    }
    Ok(rows)
}

/// Restores an evicted asset after its original was published again: the
/// marker goes first, so the provider-only marker it requires can follow.
pub(crate) fn clear_eviction(connection: &Connection, asset_sha256: &str) -> Result<()> {
    connection.execute(
        "DELETE FROM artwork_evicted_assets WHERE asset_sha256=?1",
        [asset_sha256],
    )?;
    Ok(())
}

pub(crate) fn validate_hash(id: &str) -> Result<()> {
    if id.len() != 64
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(PortcoveError::verification(
            "invalid artwork content identity",
        ));
    }
    Ok(())
}

pub(crate) fn validate_asset(asset: &LocalArtworkAsset) -> Result<()> {
    validate_hash(&asset.sha256)?;
    if asset.original_name.is_empty()
        || asset.original_name.len() > 255
        || asset
            .original_name
            .chars()
            .any(|character| character.is_control() || matches!(character, '/' | '\\'))
        || asset.byte_size == 0
        || asset.byte_size > crate::artwork_image::MAX_ORIGINAL_BYTES
        || asset.width == 0
        || asset.height == 0
        || asset.width > 8192
        || asset.height > 8192
        || u64::from(asset.width) * u64::from(asset.height) > crate::artwork_image::MAX_PIXELS
    {
        return Err(PortcoveError::verification(
            "invalid local artwork metadata",
        ));
    }
    Ok(())
}

pub(crate) fn asset(connection: &Connection, id: &str) -> Result<LocalArtworkAsset> {
    validate_hash(id)?;
    let payload: String = connection
        .query_row(
            "SELECT payload FROM artwork_assets WHERE sha256=?1",
            [id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| PortcoveError::verification("artwork choice lost its retained asset"))?;
    let asset: LocalArtworkAsset = serde_json::from_str(&payload)?;
    validate_asset(&asset)?;
    if asset.sha256 != id {
        return Err(PortcoveError::verification(
            "artwork record identity differs from its key",
        ));
    }
    Ok(asset)
}

pub(crate) fn choice(
    connection: &Connection,
    port_id: &str,
    slot: ArtworkSlot,
) -> Result<ArtworkChoice> {
    let recorded = connection
        .query_row(
            "SELECT revision,asset_sha256 FROM artwork_choices WHERE port_id=?1 AND slot=?2",
            params![port_id, slot.key()],
            |row| Ok((row.get::<_, u64>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .optional()?;
    let (revision, asset_sha256) = recorded.unwrap_or((0, None));
    if let Some(id) = &asset_sha256 {
        validate_hash(id)?;
    }
    Ok(ArtworkChoice {
        port_id: port_id.into(),
        slot,
        revision,
        asset_sha256,
    })
}

pub(crate) fn require_revision(
    connection: &Connection,
    port_id: &str,
    slot: ArtworkSlot,
    expected: u64,
) -> Result<ArtworkChoice> {
    let current = choice(connection, port_id, slot)?;
    if current.revision != expected {
        return Err(PortcoveError::conflict(
            "artwork choice changed; review the current selection before replacing it",
        )
        .detail("expected_revision", expected.to_string())
        .detail("current_revision", current.revision.to_string()));
    }
    Ok(current)
}

pub(crate) fn check_capacity(connection: &Connection, proposed: &LocalArtworkAsset) -> Result<()> {
    let exists: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM artwork_assets WHERE sha256=?1)",
        [&proposed.sha256],
        |row| row.get(0),
    )?;
    // A removed original's bytes no longer count, so restoring one is checked
    // like a new import.
    let evicted = evicted_at(connection, &proposed.sha256)?.is_some();
    if exists && !evicted {
        return Ok(());
    }
    let (count, bytes): (u64, u64) = connection.query_row(
        "SELECT COUNT(*),COALESCE(SUM(CASE WHEN sha256 IN (SELECT asset_sha256 FROM artwork_evicted_assets) THEN 0 ELSE byte_size END),0) FROM artwork_assets",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    if (!exists && count >= MAX_ASSETS as u64)
        || bytes
            .checked_add(proposed.byte_size)
            .is_none_or(|size| size > MAX_TOTAL_BYTES)
    {
        return Err(PortcoveError::conflict(
            "local artwork storage is full; remove unused local images before importing more",
        ));
    }
    Ok(())
}

pub(crate) fn write_asset(connection: &Connection, asset: &LocalArtworkAsset) -> Result<()> {
    validate_asset(asset)?;
    connection.execute("INSERT INTO artwork_assets(sha256,payload,byte_size) VALUES (?1,?2,?3) ON CONFLICT(sha256) DO NOTHING", params![asset.sha256, serde_json::to_string(asset)?, asset.byte_size])?;
    Ok(())
}

pub(crate) fn asset_exists(connection: &Connection, id: &str) -> Result<bool> {
    Ok(connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM artwork_assets WHERE sha256=?1)",
        [id],
        |row| row.get(0),
    )?)
}

/// Keeps the first record for a provider image; attribution is never dropped or
/// rewritten by a later identical import.
pub(crate) fn write_provider(
    connection: &Connection,
    record: &ArtworkProviderRecord,
) -> Result<()> {
    validate_hash(&record.asset_sha256)?;
    validate_attribution(&record.attribution)?;
    // Only new writes (a choice or an import) are bounded by this host's clock;
    // stored records stay readable if the clock later moves back.
    if record.attribution.fetched_at
        > crate::Library::now().saturating_add(MAX_FETCHED_AT_SKEW_SECONDS)
    {
        return Err(PortcoveError::verification(
            "artwork provider attribution is dated in the future",
        ));
    }
    let (recorded, total): (u64, u64) = connection.query_row(
        "SELECT (SELECT COUNT(*) FROM artwork_asset_providers WHERE asset_sha256=?1 AND NOT (provider=?2 AND asset_id=?3)),
                (SELECT COUNT(*) FROM artwork_asset_providers)",
        params![
            record.asset_sha256,
            record.attribution.provider.key(),
            record.attribution.asset_id
        ],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    if recorded >= MAX_PROVIDER_RECORDS_PER_ASSET as u64 || total >= MAX_PROVIDER_RECORDS as u64 {
        return Err(PortcoveError::conflict(
            "artwork provenance storage is full; remove unused images before choosing more",
        ));
    }
    connection.execute(
        "INSERT INTO artwork_asset_providers(asset_sha256,provider,asset_id,record_json) VALUES (?1,?2,?3,?4)
         ON CONFLICT(asset_sha256,provider,asset_id) DO NOTHING",
        params![
            record.asset_sha256,
            record.attribution.provider.key(),
            record.attribution.asset_id,
            serde_json::to_string(&record.attribution)?
        ],
    )?;
    Ok(())
}

pub(crate) fn mark_provider_only(connection: &Connection, id: &str) -> Result<()> {
    validate_hash(id)?;
    connection.execute(
        "INSERT INTO artwork_provider_only_assets(asset_sha256) VALUES (?1) ON CONFLICT DO NOTHING",
        [id],
    )?;
    Ok(())
}

/// A local import of the same bytes makes the player the origin as well, so a
/// later provider withdrawal can never evict it.
pub(crate) fn record_local_origin(connection: &Connection, id: &str) -> Result<()> {
    connection.execute(
        "DELETE FROM artwork_provider_only_assets WHERE asset_sha256=?1",
        [id],
    )?;
    Ok(())
}

pub(crate) fn attributions(connection: &Connection, id: &str) -> Result<Vec<ArtworkAttribution>> {
    validate_hash(id)?;
    let mut statement = connection.prepare(
        "SELECT provider,asset_id,record_json FROM artwork_asset_providers WHERE asset_sha256=?1 ORDER BY provider,asset_id LIMIT 65",
    )?;
    let records = statement
        .query_map([id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, u64>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if records.len() > MAX_PROVIDER_RECORDS_PER_ASSET {
        return Err(PortcoveError::verification(
            "artwork asset has too many provider records",
        ));
    }
    records
        .iter()
        .map(|(provider, asset_id, json)| {
            let attribution: ArtworkAttribution = serde_json::from_str(json)?;
            validate_attribution(&attribution)?;
            // The key columns and the stored record must agree.
            if attribution.provider.key() != provider || attribution.asset_id != *asset_id {
                return Err(PortcoveError::verification(
                    "artwork provider record differs from its key",
                ));
            }
            Ok(attribution)
        })
        .collect()
}

/// Stored credits for one provider image, whichever asset holds them.
pub(crate) fn provider_image_attributions(
    connection: &Connection,
    provider: crate::ArtworkProvider,
    asset_id: u64,
) -> Result<Vec<ArtworkAttribution>> {
    let mut statement = connection.prepare(
        "SELECT record_json FROM artwork_asset_providers WHERE provider=?1 AND asset_id=?2 LIMIT 65",
    )?;
    let records = statement
        .query_map(params![provider.key(), asset_id], |row| {
            row.get::<_, String>(0)
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    records
        .iter()
        .take(MAX_PROVIDER_RECORDS_PER_ASSET)
        .map(|json| {
            let attribution: ArtworkAttribution = serde_json::from_str(json)?;
            validate_attribution(&attribution)?;
            Ok(attribution)
        })
        .collect()
}

pub(crate) fn remove_asset_provenance(connection: &Connection, id: &str) -> Result<()> {
    // Explicit, so correctness never rests on the foreign-key pragma alone. The
    // eviction marker goes first because it requires the provider-only marker.
    connection.execute(
        "DELETE FROM artwork_evicted_assets WHERE asset_sha256=?1",
        [id],
    )?;
    connection.execute(
        "DELETE FROM artwork_provider_withdrawals WHERE asset_sha256=?1",
        [id],
    )?;
    connection.execute(
        "DELETE FROM artwork_provider_listing_checks WHERE asset_sha256=?1",
        [id],
    )?;
    connection.execute(
        "DELETE FROM artwork_asset_providers WHERE asset_sha256=?1",
        [id],
    )?;
    connection.execute(
        "DELETE FROM artwork_provider_only_assets WHERE asset_sha256=?1",
        [id],
    )?;
    Ok(())
}

pub(crate) fn write_choice(
    connection: &Connection,
    port_id: &str,
    slot: ArtworkSlot,
    previous: u64,
    id: Option<&str>,
) -> Result<()> {
    let revision = previous
        .checked_add(1)
        .filter(|value| *value <= i64::MAX as u64)
        .ok_or_else(|| PortcoveError::state("artwork revision is exhausted"))?;
    connection.execute("INSERT INTO artwork_choices(port_id,slot,revision,asset_sha256) VALUES (?1,?2,?3,?4)
        ON CONFLICT(port_id,slot) DO UPDATE SET revision=excluded.revision,asset_sha256=excluded.asset_sha256", params![port_id,slot.key(),revision,id])?;
    Ok(())
}

/// Version 2 thumbnails apply the original's embedded orientation; older
/// disposable entries are ignored and rebuilt on the next read.
pub(crate) const THUMBNAIL_FORMAT_VERSION: u32 = 2;

pub(crate) fn thumbnail(connection: &Connection, id: &str) -> Result<Option<(String, u64)>> {
    Ok(connection.query_row("SELECT sha256,byte_size FROM artwork_thumbnails WHERE asset_sha256=?1 AND format_version=?2", params![id,THUMBNAIL_FORMAT_VERSION], |row| Ok((row.get(0)?,row.get(1)?))).optional()?)
}

pub(crate) fn write_thumbnail(connection: &Connection, id: &str, bytes: &[u8]) -> Result<()> {
    connection.execute("INSERT INTO artwork_thumbnails(asset_sha256,format_version,sha256,byte_size) VALUES (?1,?4,?2,?3)
        ON CONFLICT(asset_sha256) DO UPDATE SET format_version=excluded.format_version,sha256=excluded.sha256,byte_size=excluded.byte_size", params![id,crate::signed_catalog::digest(bytes),bytes.len() as u64,THUMBNAIL_FORMAT_VERSION])?;
    Ok(())
}

pub(crate) fn snapshot(connection: &Connection) -> Result<ArtworkMetadata> {
    let mut statement =
        connection.prepare("SELECT sha256 FROM artwork_assets ORDER BY sha256 LIMIT 4097")?;
    let ids = statement
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if ids.len() > MAX_ASSETS {
        return Err(PortcoveError::verification(
            "artwork asset inventory exceeds its limit",
        ));
    }
    let assets = ids
        .iter()
        .map(|id| asset(connection, id))
        .collect::<Result<Vec<_>>>()?;
    let mut statement = connection.prepare("SELECT port_id,slot,revision,asset_sha256 FROM artwork_choices ORDER BY port_id,slot LIMIT 8193")?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, u64>(2)?,
            row.get::<_, Option<String>>(3)?,
        ))
    })?;
    let choices = rows
        .map(|row| {
            let (port_id, slot, revision, asset_sha256) = row?;
            let slot = ArtworkSlot::from_key(&slot)
                .ok_or_else(|| PortcoveError::verification("unknown artwork slot"))?;
            Ok(ArtworkChoice {
                port_id,
                slot,
                revision,
                asset_sha256,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let mut statement = connection.prepare(&format!(
        "SELECT asset_sha256,provider,asset_id,record_json FROM artwork_asset_providers ORDER BY asset_sha256,provider,asset_id LIMIT {}",
        MAX_PROVIDER_RECORDS + 1
    ))?;
    let providers = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, u64>(2)?,
                row.get::<_, String>(3)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?
        .into_iter()
        .map(|(asset_sha256, provider, asset_id, json)| {
            let attribution: ArtworkAttribution = serde_json::from_str(&json)?;
            if attribution.provider.key() != provider || attribution.asset_id != asset_id {
                return Err(PortcoveError::verification(
                    "artwork provider record differs from its key",
                ));
            }
            Ok(ArtworkProviderRecord {
                asset_sha256,
                attribution,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let mut statement = connection.prepare(&format!(
        "SELECT asset_sha256 FROM artwork_provider_only_assets ORDER BY asset_sha256 LIMIT {}",
        MAX_ASSETS + 1
    ))?;
    let provider_only_assets = statement
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let mut statement = connection.prepare(&format!(
        "SELECT asset_sha256,provider,asset_id,withdrawn_at,signal FROM artwork_provider_withdrawals ORDER BY asset_sha256,provider,asset_id LIMIT {}",
        MAX_PROVIDER_RECORDS + 1
    ))?;
    let withdrawals = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, u64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, String>(4)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?
        .into_iter()
        .map(|(asset_sha256, provider, asset_id, withdrawn_at, signal)| {
            Ok(crate::ArtworkWithdrawalRecord {
                asset_sha256,
                provider: match provider.as_str() {
                    "steamgriddb" => crate::ArtworkProvider::Steamgriddb,
                    _ => {
                        return Err(PortcoveError::verification(
                            "artwork withdrawal names an unknown provider",
                        ));
                    }
                },
                asset_id,
                withdrawn_at,
                signal: match signal.as_str() {
                    "gone" => crate::ArtworkWithdrawalSignal::Gone,
                    "absent_again" => crate::ArtworkWithdrawalSignal::AbsentAgain,
                    _ => {
                        return Err(PortcoveError::verification(
                            "artwork withdrawal has an unknown signal",
                        ));
                    }
                },
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let evicted_assets = evicted_assets(connection)?
        .into_iter()
        .map(|(asset_sha256, evicted_at)| crate::ArtworkEvictedAsset {
            asset_sha256,
            evicted_at,
        })
        .collect();
    let metadata = ArtworkMetadata {
        assets,
        choices,
        providers,
        provider_only_assets,
        withdrawals,
        evicted_assets,
    };
    validate_provenance(&metadata, &ids.iter().collect())?;
    Ok(metadata)
}

/// Every record names a retained asset exactly once per provider image, and a
/// provider-only marker requires at least one provider record for that asset.
fn validate_provenance(metadata: &ArtworkMetadata, ids: &BTreeSet<&String>) -> Result<()> {
    if metadata.providers.len() > MAX_PROVIDER_RECORDS
        || metadata.provider_only_assets.len() > MAX_ASSETS
    {
        return Err(PortcoveError::verification(
            "artwork provenance exceeds its record limit",
        ));
    }
    let mut records = BTreeSet::new();
    let mut per_asset = std::collections::BTreeMap::<&String, usize>::new();
    for record in &metadata.providers {
        let count = per_asset.entry(&record.asset_sha256).or_default();
        *count += 1;
        if *count > MAX_PROVIDER_RECORDS_PER_ASSET {
            return Err(PortcoveError::verification(
                "artwork asset has too many provider records",
            ));
        }
        validate_hash(&record.asset_sha256)?;
        validate_attribution(&record.attribution)?;
        if !ids.contains(&record.asset_sha256)
            || !records.insert((
                &record.asset_sha256,
                record.attribution.provider,
                record.attribution.asset_id,
            ))
        {
            return Err(PortcoveError::verification(
                "artwork provenance is repeated or names a missing asset",
            ));
        }
    }
    let mut only = BTreeSet::new();
    for id in &metadata.provider_only_assets {
        validate_hash(id)?;
        if !ids.contains(id)
            || !only.insert(id)
            || !metadata
                .providers
                .iter()
                .any(|record| &record.asset_sha256 == id)
        {
            return Err(PortcoveError::verification(
                "provider-only artwork marker is repeated or unbound",
            ));
        }
    }
    // Withdrawals name stored records once each. An eviction needs only a
    // provider-only asset: every record had to be withdrawn when it happened,
    // but a record seen listed again since then no longer is.
    if metadata.withdrawals.len() > MAX_PROVIDER_RECORDS
        || metadata.evicted_assets.len() > MAX_ASSETS
    {
        return Err(PortcoveError::verification(
            "artwork withdrawals exceed their record limit",
        ));
    }
    let mut withdrawn = BTreeSet::new();
    for withdrawal in &metadata.withdrawals {
        if !valid_event_time(withdrawal.withdrawn_at)
            || !records.contains(&(
                &withdrawal.asset_sha256,
                withdrawal.provider,
                withdrawal.asset_id,
            ))
            || !withdrawn.insert((
                &withdrawal.asset_sha256,
                withdrawal.provider,
                withdrawal.asset_id,
            ))
        {
            return Err(PortcoveError::verification(
                "artwork withdrawal is repeated, unbound or undated",
            ));
        }
    }
    let mut evicted = BTreeSet::new();
    for asset in &metadata.evicted_assets {
        if !valid_event_time(asset.evicted_at)
            || !only.contains(&asset.asset_sha256)
            || !evicted.insert(&asset.asset_sha256)
        {
            return Err(PortcoveError::verification(
                "evicted artwork is repeated, undated or not provider-only",
            ));
        }
    }
    Ok(())
}

/// A recorded withdrawal or eviction time: after 2020 and before 2200.
fn valid_event_time(seconds: i64) -> bool {
    (1_577_836_800..7_258_118_400).contains(&seconds)
}

pub(crate) fn validate_metadata_with(
    metadata: &ArtworkMetadata,
    mut require_port: impl FnMut(&str) -> Result<()>,
) -> Result<()> {
    if metadata.assets.len() > MAX_ASSETS || metadata.choices.len() > 8192 {
        return Err(PortcoveError::verification(
            "artwork metadata exceeds its record limit",
        ));
    }
    let mut ids = BTreeSet::new();
    let mut bytes = 0_u64;
    // A removed original's bytes are no longer stored, as in the live library.
    let evicted: BTreeSet<&String> = metadata
        .evicted_assets
        .iter()
        .map(|asset| &asset.asset_sha256)
        .collect();
    for asset in &metadata.assets {
        validate_asset(asset)?;
        if !ids.insert(&asset.sha256) {
            return Err(PortcoveError::verification(
                "artwork metadata repeats an asset",
            ));
        }
        if evicted.contains(&asset.sha256) {
            continue;
        }
        bytes = bytes
            .checked_add(asset.byte_size)
            .ok_or_else(|| PortcoveError::verification("artwork size overflow"))?;
    }
    if bytes > MAX_TOTAL_BYTES {
        return Err(PortcoveError::verification(
            "artwork metadata exceeds its byte limit",
        ));
    }
    validate_provenance(metadata, &ids)?;
    let mut choices = BTreeSet::new();
    for choice in &metadata.choices {
        require_port(&choice.port_id)?;
        if choice.revision == 0
            || choice.revision > i64::MAX as u64
            || !choices.insert((&choice.port_id, choice.slot.key()))
            || choice
                .asset_sha256
                .as_ref()
                .is_some_and(|id| !ids.contains(id))
        {
            return Err(PortcoveError::verification(
                "artwork metadata has a repeated, unbound, or invalid choice",
            ));
        }
    }
    Ok(())
}

pub(crate) fn restore(connection: &Connection, metadata: &ArtworkMetadata) -> Result<()> {
    for asset in &metadata.assets {
        write_asset(connection, asset)?;
    }
    for record in &metadata.providers {
        write_provider(connection, record)?;
    }
    for id in &metadata.provider_only_assets {
        mark_provider_only(connection, id)?;
    }
    for withdrawal in &metadata.withdrawals {
        connection.execute(
            "INSERT INTO artwork_provider_withdrawals(asset_sha256,provider,asset_id,withdrawn_at,signal) VALUES (?1,?2,?3,?4,?5)",
            params![
                withdrawal.asset_sha256,
                withdrawal.provider.key(),
                withdrawal.asset_id,
                withdrawal.withdrawn_at,
                match withdrawal.signal {
                    crate::ArtworkWithdrawalSignal::Gone => "gone",
                    crate::ArtworkWithdrawalSignal::AbsentAgain => "absent_again",
                },
            ],
        )?;
    }
    for asset in &metadata.evicted_assets {
        mark_evicted(connection, &asset.asset_sha256, asset.evicted_at)?;
    }
    for choice in &metadata.choices {
        write_choice(
            connection,
            &choice.port_id,
            choice.slot,
            choice.revision - 1,
            choice.asset_sha256.as_deref(),
        )?;
    }
    Ok(())
}

pub(crate) fn validate_transfer_inventory(
    metadata: &crate::LibraryMetadata,
    content: &[crate::LibraryTreePlan],
) -> Result<()> {
    let Some(artwork) = &metadata.artwork else {
        return Ok(());
    };
    let tree = content
        .iter()
        .find(|tree| tree.kind == crate::LibraryContentKind::LocalArtwork)
        .ok_or_else(|| PortcoveError::verification("artwork payload root is missing"))?;
    // A removed original is not carried: the files are exactly the assets
    // whose originals the library still holds.
    let evicted = artwork
        .evicted_assets
        .iter()
        .map(|asset| asset.asset_sha256.as_str())
        .collect::<BTreeSet<_>>();
    let assets = artwork
        .assets
        .iter()
        .filter(|asset| !evicted.contains(asset.sha256.as_str()))
        .map(|asset| (asset.sha256.as_str(), asset))
        .collect::<std::collections::BTreeMap<_, _>>();
    if !tree.copy.directories.is_empty()
        || !tree.copy.skipped_entries.is_empty()
        || tree.copy.files.len() != assets.len()
        || tree.copy.files.iter().any(|file| {
            file.relative_path
                .to_str()
                .and_then(|name| assets.get(name))
                .is_none_or(|asset| file.sha256 != asset.sha256 || file.size != asset.byte_size)
        })
    {
        return Err(PortcoveError::verification(
            "artwork payload inventory differs from its metadata; unexpected or missing originals were retained",
        ));
    }
    Ok(())
}
