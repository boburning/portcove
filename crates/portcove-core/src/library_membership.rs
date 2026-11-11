//! Explicit add-only Library membership.
//!
//! A membership is a saved selection of an independent port. It is neither an
//! installation, an external registration, an acquisition, nor consent to do
//! any of those later. Retained provenance explains why the entry exists and
//! never grants execution trust.

use rusqlite::{OptionalExtension, TransactionBehavior, params};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{Library, PortcoveError, Result};

pub const LIBRARY_MEMBERSHIP_FORMAT_VERSION: u8 = 1;
/// Largest reviewed selection one request may add; larger selections are
/// submitted as several requests rather than truncated.
pub const MAX_LIBRARY_MEMBERSHIP_BATCH: usize = 512;
const MAX_PROVENANCE_SOURCES: usize = 32;
const MAX_RECORD_BYTES: usize = 16 * 1024;
const MAX_EXPORTED_MEMBERSHIPS: usize = 100_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum LibraryMembershipOrigin {
    /// Selected from reviewed game-file discovery results.
    GameFileDiscovery,
    /// Added directly by the player.
    Manual,
}

/// A reviewed original the player associated with the saved entry. This is a
/// hint for explaining requirements; reinspection remains the authority.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct LibraryMembershipSource {
    pub profile_id: String,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct LibraryMembershipRequest {
    pub port_id: String,
    pub origin: LibraryMembershipOrigin,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sources: Vec<LibraryMembershipSource>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct LibraryMembership {
    pub format_version: u8,
    pub port_id: String,
    pub added_at: i64,
    pub origin: LibraryMembershipOrigin,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sources: Vec<LibraryMembershipSource>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum LibraryMembershipOutcomeKind {
    Added,
    /// Already saved; the original record, including its source choice, is kept.
    AlreadySaved,
    /// Installed, externally registered or pending setup already places the
    /// game in the Library; no duplicate record is created.
    AlreadyInLibrary,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct LibraryMembershipOutcome {
    pub port_id: String,
    pub outcome: LibraryMembershipOutcomeKind,
}

impl LibraryMembershipRequest {
    pub(crate) fn validate(&self) -> Result<()> {
        if self.port_id.is_empty()
            || self.port_id.len() > 128
            || !self
                .port_id
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        {
            return Err(PortcoveError::usage("library entry needs a valid port id")
                .detail("port_id", &self.port_id));
        }
        if self.sources.len() > MAX_PROVENANCE_SOURCES {
            return Err(PortcoveError::usage(
                "a library entry can retain at most 32 reviewed source references",
            ));
        }
        for source in &self.sources {
            let digest = source.sha256.len() == 64
                && source
                    .sha256
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
            if source.profile_id.is_empty() || source.profile_id.len() > 128 || !digest {
                return Err(PortcoveError::usage(
                    "a reviewed source reference needs a profile id and lowercase SHA-256",
                ));
            }
        }
        Ok(())
    }
}

fn decode(port_id: &str, json: &str) -> Result<LibraryMembership> {
    let record: LibraryMembership = serde_json::from_str(json).map_err(|error| {
        PortcoveError::state("stored library membership is invalid")
            .detail("port_id", port_id)
            .detail("cause", error.to_string())
    })?;
    if record.format_version != LIBRARY_MEMBERSHIP_FORMAT_VERSION || record.port_id != port_id {
        return Err(
            PortcoveError::state("stored library membership has an unsupported contract")
                .detail("port_id", port_id),
        );
    }
    Ok(record)
}

/// Reviewed export contract: bounded, unique, and structurally valid. Retained
/// provenance never grants execution trust, so import checks shape only.
pub(crate) fn validate_export(entries: &[LibraryMembership]) -> Result<()> {
    if entries.len() > MAX_EXPORTED_MEMBERSHIPS {
        return Err(PortcoveError::verification(
            "library metadata exceeds the saved Library entry limit",
        ));
    }
    let mut seen = std::collections::BTreeSet::new();
    for entry in entries {
        let request = LibraryMembershipRequest {
            port_id: entry.port_id.clone(),
            origin: entry.origin,
            sources: entry.sources.clone(),
        };
        request
            .validate()
            .map_err(|_| PortcoveError::verification("saved Library entry is invalid"))?;
        if entry.format_version != LIBRARY_MEMBERSHIP_FORMAT_VERSION
            || !seen.insert(entry.port_id.as_str())
        {
            return Err(PortcoveError::verification(
                "saved Library entries are duplicated or use an unsupported format",
            ));
        }
    }
    Ok(())
}

pub(crate) fn restore(
    connection: &rusqlite::Connection,
    entries: &[LibraryMembership],
) -> Result<()> {
    for entry in entries {
        let json = serde_json::to_string(entry)?;
        connection.execute(
            "INSERT INTO library_memberships(port_id,added_at,record_json) VALUES (?1,?2,?3)",
            params![entry.port_id, entry.added_at, json],
        )?;
    }
    Ok(())
}

pub(crate) fn any_memberships(connection: &rusqlite::Connection) -> Result<bool> {
    let table: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='library_memberships')",
        [],
        |row| row.get(0),
    )?;
    if !table {
        return Ok(false);
    }
    Ok(connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM library_memberships)",
        [],
        |row| row.get(0),
    )?)
}

impl Library {
    /// Idempotently saves memberships without registering, acquiring, preparing
    /// or installing anything. An existing record is never retargeted.
    pub fn add_library_memberships(
        &self,
        requests: &[LibraryMembershipRequest],
        already_in_library: &std::collections::HashSet<String>,
    ) -> Result<Vec<LibraryMembershipOutcome>> {
        if requests.len() > MAX_LIBRARY_MEMBERSHIP_BATCH {
            return Err(PortcoveError::usage(
                "add at most 512 games per request; submit the rest separately",
            )
            .detail("requested", requests.len().to_string()));
        }
        for request in requests {
            request.validate()?;
        }
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let now = Self::now();
        let mut outcomes = Vec::with_capacity(requests.len());
        for request in requests {
            let kind = if already_in_library.contains(&request.port_id) {
                LibraryMembershipOutcomeKind::AlreadyInLibrary
            } else if transaction
                .query_row(
                    "SELECT 1 FROM library_memberships WHERE port_id=?1",
                    [&request.port_id],
                    |_| Ok(()),
                )
                .optional()?
                .is_some()
            {
                LibraryMembershipOutcomeKind::AlreadySaved
            } else {
                let record = LibraryMembership {
                    format_version: LIBRARY_MEMBERSHIP_FORMAT_VERSION,
                    port_id: request.port_id.clone(),
                    added_at: now,
                    origin: request.origin,
                    sources: request.sources.clone(),
                };
                let json = serde_json::to_string(&record)?;
                if json.len() > MAX_RECORD_BYTES {
                    return Err(PortcoveError::usage("library entry is too large to save"));
                }
                transaction.execute(
                    "INSERT INTO library_memberships(port_id,added_at,record_json) VALUES (?1,?2,?3)",
                    params![request.port_id, now, json],
                )?;
                LibraryMembershipOutcomeKind::Added
            };
            outcomes.push(LibraryMembershipOutcome {
                port_id: request.port_id.clone(),
                outcome: kind,
            });
        }
        transaction.commit()?;
        Ok(outcomes)
    }

    pub fn library_memberships(&self) -> Result<Vec<LibraryMembership>> {
        Self::library_memberships_from(&self.connection()?)
    }

    pub(crate) fn library_memberships_from(
        connection: &rusqlite::Connection,
    ) -> Result<Vec<LibraryMembership>> {
        let mut statement = connection.prepare(
            "SELECT port_id,record_json FROM library_memberships ORDER BY added_at,port_id",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        rows.map(|row| {
            let (port_id, json) = row?;
            decode(&port_id, &json)
        })
        .collect()
    }

    /// Removes only the saved entry; installations, registrations, sources and
    /// originals are untouched.
    pub fn remove_library_membership(&self, port_id: &str) -> Result<bool> {
        Ok(self.connection()?.execute(
            "DELETE FROM library_memberships WHERE port_id=?1",
            [port_id],
        )? > 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn request(port: &str) -> LibraryMembershipRequest {
        LibraryMembershipRequest {
            port_id: port.into(),
            origin: LibraryMembershipOrigin::GameFileDiscovery,
            sources: vec![LibraryMembershipSource {
                profile_id: "profile".into(),
                sha256: "a".repeat(64),
            }],
        }
    }

    #[test]
    fn adding_is_idempotent_persistent_and_keeps_the_first_source_choice() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path()).unwrap();
        let none = HashSet::new();
        let first = library
            .add_library_memberships(&[request("alpha"), request("beta")], &none)
            .unwrap();
        assert!(
            first
                .iter()
                .all(|item| item.outcome == LibraryMembershipOutcomeKind::Added)
        );
        let mut retargeted = request("alpha");
        retargeted.sources[0].sha256 = "b".repeat(64);
        let again = library
            .add_library_memberships(&[retargeted], &none)
            .unwrap();
        assert_eq!(again[0].outcome, LibraryMembershipOutcomeKind::AlreadySaved);
        drop(library);
        let reopened = Library::open(temporary.path()).unwrap();
        let saved = reopened.library_memberships().unwrap();
        assert_eq!(saved.len(), 2);
        assert_eq!(saved[0].sources[0].sha256, "a".repeat(64));
    }

    #[test]
    fn installed_games_are_not_duplicated_and_removal_only_drops_the_entry() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path()).unwrap();
        let installed = HashSet::from(["alpha".to_owned()]);
        let outcomes = library
            .add_library_memberships(&[request("alpha")], &installed)
            .unwrap();
        assert_eq!(
            outcomes[0].outcome,
            LibraryMembershipOutcomeKind::AlreadyInLibrary
        );
        assert!(library.library_memberships().unwrap().is_empty());
        library
            .add_library_memberships(&[request("beta")], &HashSet::new())
            .unwrap();
        assert!(library.remove_library_membership("beta").unwrap());
        assert!(!library.remove_library_membership("beta").unwrap());
    }

    #[test]
    fn oversized_or_invalid_requests_change_nothing() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path()).unwrap();
        let none = HashSet::new();
        let too_many = (0..=MAX_LIBRARY_MEMBERSHIP_BATCH)
            .map(|index| request(&format!("game-{index}")))
            .collect::<Vec<_>>();
        assert!(library.add_library_memberships(&too_many, &none).is_err());
        assert!(
            library
                .add_library_memberships(&[request("ok"), request("Bad Id")], &none)
                .is_err()
        );
        assert!(library.library_memberships().unwrap().is_empty());
    }
}
