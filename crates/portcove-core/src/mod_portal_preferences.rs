use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{
    Catalog, ExternalModPortal, ListingModPortal, ModPortalSite, PortcoveError, PortcoveService,
    Result,
    external_mod_portal::{generated_thunderstore_community, is_generated_thunderstore_source},
};

pub(crate) const LOCAL_PAGE_SOURCE: &str = "player:mod-website";
const MAX_HIDDEN_SOURCES: usize = 16;
const MAX_STORED_BYTES: usize = 4096;

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct LocalModPage {
    pub name: String,
    pub url: String,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ModPortalChoices {
    pub local_page: Option<LocalModPage>,
    pub hidden_sources: Vec<String>,
}

impl ModPortalChoices {
    fn validate(&self) -> Result<()> {
        if self.hidden_sources.len() > MAX_HIDDEN_SOURCES
            || self
                .hidden_sources
                .iter()
                .any(|id| !crate::mod_source::valid_id(id))
            || self.hidden_sources.windows(2).any(|ids| ids[0] >= ids[1])
        {
            return Err(PortcoveError::verification(
                "Choose distinct mod sources from this game",
            ));
        }
        if let Some(page) = &self.local_page {
            crate::mod_source::validate_listing_portals(&[ListingModPortal {
                id: "local".into(),
                site: ModPortalSite::CommunitySite,
                name: page.name.clone(),
                url: page.url.clone(),
                instructions: "Your mod website".into(),
            }])?;
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Deserialize, Serialize, JsonSchema)]
pub struct ModPortalPreferences {
    pub revision: u64,
    pub choices: ModPortalChoices,
}

pub(crate) fn migrate(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        "CREATE TABLE mod_portal_preferences (
            port_id TEXT NOT NULL PRIMARY KEY,
            revision INTEGER NOT NULL CHECK(revision > 0),
            choices_json TEXT NOT NULL CHECK(length(CAST(choices_json AS BLOB)) BETWEEN 2 AND 4096)
         ) STRICT;",
    )?;
    verify(transaction)
}

pub(crate) fn verify(connection: &Connection) -> Result<()> {
    crate::database::require_columns(
        connection,
        "mod_portal_preferences",
        &["port_id", "revision", "choices_json"],
    )
}

fn read_choices(connection: &Connection, port_id: &str) -> Result<ModPortalPreferences> {
    let row: Option<(u64, String)> = connection
        .query_row(
            "SELECT revision, choices_json FROM mod_portal_preferences WHERE port_id = ?1",
            [port_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((revision, json)) = row else {
        return Ok(ModPortalPreferences::default());
    };
    Ok(ModPortalPreferences {
        revision,
        choices: decode_choices(&json)?,
    })
}

fn decode_choices(json: &str) -> Result<ModPortalChoices> {
    if json.len() > MAX_STORED_BYTES {
        return Err(PortcoveError::verification(
            "Stored mod source choices exceed their limit",
        ));
    }
    let choices: ModPortalChoices = serde_json::from_str(json)?;
    choices.validate()?;
    Ok(choices)
}

#[derive(Clone, Debug, Eq, Hash, PartialEq, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct HiddenCommunity {
    pub source: String,
    pub community: Option<String>,
}

/// A player's portable mod-browsing choices and exact hidden communities.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct LibraryModPortalPreference {
    pub port_id: String,
    pub preferences: ModPortalPreferences,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub hidden_communities: Vec<HiddenCommunity>,
}

pub(crate) fn validate_export(entries: &[LibraryModPortalPreference]) -> Result<()> {
    if entries
        .windows(2)
        .any(|pair| pair[0].port_id >= pair[1].port_id)
    {
        return Err(PortcoveError::verification(
            "Portable mod source choices are duplicated or out of order",
        ));
    }
    for entry in entries {
        let communities = &entry.hidden_communities;
        let choices = &entry.preferences.choices;
        choices.validate()?;
        let mut distinct = std::collections::HashSet::new();
        if entry.port_id.is_empty()
            || entry.port_id.len() > 128
            || !entry
                .port_id
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
            || !(1..=i64::MAX as u64).contains(&entry.preferences.revision)
            || communities.len() > MAX_HIDDEN_SOURCES
            || serde_json::to_vec(choices)?.len() > MAX_STORED_BYTES
            || serde_json::to_vec(communities)?.len() > MAX_STORED_BYTES
            || choices
                .hidden_sources
                .iter()
                .filter(|source| !communities.iter().any(|entry| entry.source == **source))
                .count()
                + communities.len()
                > MAX_HIDDEN_SOURCES
            || communities.iter().any(|binding| {
                !is_generated_thunderstore_source(&binding.source)
                    || !distinct.insert(binding)
                    || binding.community.as_ref().is_some_and(|community| {
                        !(crate::ModProviderBinding::Thunderstore {
                            community: community.clone(),
                        })
                        .valid_coordinates()
                    })
            })
        {
            return Err(
                PortcoveError::verification("Portable mod source choices are invalid")
                    .detail("port_id", &entry.port_id),
            );
        }
    }
    Ok(())
}

pub(crate) fn export(connection: &Connection) -> Result<Vec<LibraryModPortalPreference>> {
    let query = if has_community_table(connection)? {
        "SELECT choices.port_id, choices.revision, choices.choices_json, communities.bindings_json
         FROM mod_portal_preferences AS choices
         LEFT JOIN mod_portal_hidden_communities AS communities
           ON choices.port_id = communities.port_id
          AND choices.revision = communities.preference_revision
         ORDER BY choices.port_id"
    } else {
        "SELECT port_id, revision, choices_json, NULL
         FROM mod_portal_preferences ORDER BY port_id"
    };
    let mut statement = connection.prepare(query)?;
    let mut rows = statement.query([])?;
    let mut entries = Vec::new();
    while let Some(row) = rows.next()? {
        let port_id: String = row.get(0)?;
        let revision = row.get(1)?;
        let json: String = row.get(2)?;
        let choices = decode_choices(&json)?;
        let bindings: Option<String> = row.get(3)?;
        entries.push(LibraryModPortalPreference {
            hidden_communities: decode_hidden_communities(bindings.as_deref())?,
            port_id,
            preferences: ModPortalPreferences { revision, choices },
        });
    }
    validate_export(&entries)?;
    Ok(entries)
}

pub(crate) fn restore(
    transaction: &Transaction<'_>,
    entries: &[LibraryModPortalPreference],
) -> Result<()> {
    for entry in entries {
        let revision = entry.preferences.revision;
        transaction.execute(
            "INSERT INTO mod_portal_preferences (port_id, revision, choices_json) VALUES (?1, ?2, ?3)",
            params![
                entry.port_id,
                revision,
                serde_json::to_string(&entry.preferences.choices)?
            ],
        )?;
        write_communities(
            transaction,
            &entry.port_id,
            revision,
            &entry.hidden_communities,
        )?;
    }
    Ok(())
}

pub(crate) fn any_preferences(connection: &Connection) -> Result<bool> {
    let table = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master
         WHERE type='table' AND name='mod_portal_preferences')",
        [],
        |row| row.get::<_, bool>(0),
    )?;
    if table
        && connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM mod_portal_preferences)",
            [],
            |row| row.get::<_, bool>(0),
        )?
    {
        return Ok(true);
    }
    Ok(has_community_table(connection)?
        && connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM mod_portal_hidden_communities)",
            [],
            |row| row.get::<_, bool>(0),
        )?)
}

#[cfg(test)]
pub(crate) fn record_portability_fixture(library: &crate::Library) -> LibraryModPortalPreference {
    let source = "obs-gh-thunderstore-12345";
    let entry = LibraryModPortalPreference {
        port_id: "zelda64-recomp".into(),
        preferences: ModPortalPreferences {
            revision: 7,
            choices: ModPortalChoices {
                local_page: Some(LocalModPage {
                    name: "My mods".into(),
                    url: "https://thunderstore.io/c/fixture-active/".into(),
                }),
                hidden_sources: vec![source.into()],
            },
        },
        hidden_communities: vec![
            HiddenCommunity {
                source: source.into(),
                community: Some("fixture-active".into()),
            },
            HiddenCommunity {
                source: source.into(),
                community: Some("fixture-dormant".into()),
            },
            HiddenCommunity {
                source: "obs-gh-thunderstore-54321".into(),
                community: None,
            },
        ],
    };
    let mut database = library.connection().unwrap();
    let transaction = database.transaction().unwrap();
    restore(&transaction, std::slice::from_ref(&entry)).unwrap();
    transaction.commit().unwrap();
    entry
}

fn has_community_table(connection: &Connection) -> Result<bool> {
    Ok(connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master
         WHERE type='table' AND name='mod_portal_hidden_communities')",
        [],
        |row| row.get(0),
    )?)
}

fn hidden_communities(
    connection: &Connection,
    port_id: &str,
    revision: u64,
) -> Result<Vec<HiddenCommunity>> {
    if !has_community_table(connection)? {
        return Ok(Vec::new());
    }
    let stored: Option<String> = connection
        .query_row(
            "SELECT bindings_json FROM mod_portal_hidden_communities
             WHERE port_id = ?1 AND preference_revision = ?2",
            params![port_id, revision],
            |row| row.get(0),
        )
        .optional()?;
    decode_hidden_communities(stored.as_deref())
}

fn decode_hidden_communities(stored: Option<&str>) -> Result<Vec<HiddenCommunity>> {
    let Some(json) = stored else {
        return Ok(Vec::new());
    };
    if json.len() > MAX_STORED_BYTES {
        return Err(PortcoveError::verification(
            "Stored hidden mod communities exceed their limit",
        ));
    }
    let communities: Vec<HiddenCommunity> = serde_json::from_str(json)?;
    if communities.len() > MAX_HIDDEN_SOURCES {
        return Err(PortcoveError::verification(
            "Too many stored hidden mod communities",
        ));
    }
    Ok(communities)
}

fn write_communities(
    transaction: &Transaction<'_>,
    port_id: &str,
    revision: u64,
    communities: &[HiddenCommunity],
) -> Result<()> {
    if communities.is_empty() {
        if has_community_table(transaction)? {
            transaction.execute(
                "DELETE FROM mod_portal_hidden_communities WHERE port_id = ?1",
                [port_id],
            )?;
        }
        return Ok(());
    }
    if communities.len() > MAX_HIDDEN_SOURCES {
        return Err(PortcoveError::verification(
            "Too many hidden mod communities",
        ));
    }
    // Optional descriptive metadata. Previous readers retain their existing
    // raw source choices and can still open the same library.
    transaction.execute_batch(
        "CREATE TABLE IF NOT EXISTS mod_portal_hidden_communities (
            port_id TEXT NOT NULL PRIMARY KEY,
            preference_revision INTEGER NOT NULL CHECK(preference_revision > 0),
            bindings_json TEXT NOT NULL CHECK(length(CAST(bindings_json AS BLOB)) BETWEEN 2 AND 4096)
         ) STRICT;",
    )?;
    transaction.execute(
        "INSERT INTO mod_portal_hidden_communities VALUES (?1, ?2, ?3)
         ON CONFLICT(port_id) DO UPDATE SET preference_revision = excluded.preference_revision,
             bindings_json = excluded.bindings_json",
        params![port_id, revision, serde_json::to_string(communities)?],
    )?;
    Ok(())
}

fn bind_legacy_choices(
    choices: &ModPortalChoices,
    offered: &[ExternalModPortal],
    communities: &mut Vec<HiddenCommunity>,
) {
    for portal in offered {
        if choices.hidden_sources.binary_search(&portal.source).is_ok()
            && !communities
                .iter()
                .any(|entry| entry.source == portal.source)
            && let Some(community) = generated_thunderstore_community(portal)
        {
            communities.push(HiddenCommunity {
                source: portal.source.clone(),
                community: Some(community),
            });
        }
    }
}

fn resolve_hidden(
    choices: &mut ModPortalChoices,
    offered: &[ExternalModPortal],
    communities: &mut [HiddenCommunity],
) {
    choices
        .hidden_sources
        .retain(|id| !communities.iter().any(|entry| entry.source == *id));
    for entry in communities {
        let Some(community) = entry.community.as_deref() else {
            continue;
        };
        if let Some(portal) = offered
            .iter()
            .find(|portal| generated_thunderstore_community(portal).as_deref() == Some(community))
        {
            entry.source.clone_from(&portal.source);
            choices.hidden_sources.push(portal.source.clone());
        }
    }
    choices.hidden_sources.sort_unstable();
    choices.hidden_sources.dedup();
}

/// Save legacy choices from the visible predecessor and rebind their raw IDs
/// alongside existing coordinate preferences as part of signed selection.
pub(crate) fn retain_generated_thunderstore_choices(
    transaction: &Transaction<'_>,
    previous: Option<&Catalog>,
    selected: &Catalog,
) -> Result<()> {
    let table = has_community_table(transaction)?;
    let query = if table {
        "SELECT port_id FROM mod_portal_preferences
         WHERE instr(choices_json, 'obs-ts-') > 0 OR instr(choices_json, 'obs-gh-thunderstore-') > 0
            OR port_id IN (SELECT port_id FROM mod_portal_hidden_communities)"
    } else {
        "SELECT port_id FROM mod_portal_preferences
         WHERE instr(choices_json, 'obs-ts-') > 0 OR instr(choices_json, 'obs-gh-thunderstore-') > 0"
    };
    let ids = transaction
        .prepare(query)?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let platform = crate::Platform::current().ok();
    for id in ids {
        let Ok(mut preferences) = read_choices(transaction, &id) else {
            continue;
        };
        let Ok(mut communities) = hidden_communities(transaction, &id, preferences.revision) else {
            continue;
        };
        let original = communities.clone();
        if let Some(previous) = previous {
            bind_legacy_choices(
                &preferences.choices,
                &crate::external_mod_portal::portals(previous, &id, platform),
                &mut communities,
            );
        }
        for id in &preferences.choices.hidden_sources {
            if is_generated_thunderstore_source(id)
                && !communities.iter().any(|entry| entry.source == *id)
            {
                communities.push(HiddenCommunity {
                    source: id.clone(),
                    community: None,
                });
            }
        }
        if communities.is_empty() {
            continue;
        }
        let original_choices = preferences.choices.clone();
        resolve_hidden(
            &mut preferences.choices,
            &crate::external_mod_portal::portals(selected, &id, platform),
            &mut communities,
        );
        if preferences.choices.validate().is_err() {
            continue;
        }
        let rebound = preferences.choices != original_choices;
        if rebound {
            preferences.revision = next_revision(preferences.revision)? as u64;
            transaction.execute(
                "UPDATE mod_portal_preferences SET revision = ?2, choices_json = ?3 WHERE port_id = ?1",
                params![id, preferences.revision, serde_json::to_string(&preferences.choices)?],
            )?;
        }
        if rebound || communities != original {
            write_communities(transaction, &id, preferences.revision, &communities)?;
        }
    }
    Ok(())
}

fn next_revision(current: u64) -> Result<i64> {
    i64::try_from(current)
        .ok()
        .and_then(|revision| revision.checked_add(1))
        .ok_or_else(|| PortcoveError::state("Mod source choice revision is exhausted"))
}

impl PortcoveService {
    pub fn mod_portal_preferences(&self, port_id: &str) -> Result<ModPortalPreferences> {
        let connection = self.library().connection()?;
        self.require_mod_portal_subject(&connection, port_id)?;
        self.current_mod_portal_choices(&connection, port_id)
    }

    fn current_mod_portal_choices(
        &self,
        connection: &Connection,
        port_id: &str,
    ) -> Result<ModPortalPreferences> {
        let mut preferences = read_choices(connection, port_id)?;
        let mut communities = hidden_communities(connection, port_id, preferences.revision)?;
        resolve_hidden(
            &mut preferences.choices,
            &crate::external_mod_portal::portals(
                self.catalog(),
                port_id,
                crate::Platform::current().ok(),
            ),
            &mut communities,
        );
        Ok(preferences)
    }

    /// Change browser-only choices on this device. The current catalog remains
    /// the source of provider and installation authority, including for installed mods.
    pub fn set_mod_portal_preferences(
        &self,
        port_id: &str,
        expected_revision: u64,
        mut choices: ModPortalChoices,
    ) -> Result<crate::ModPortalsView> {
        choices.hidden_sources.sort_unstable();
        choices.validate()?;
        let mut connection = self.library().connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        self.require_mod_portal_subject(&transaction, port_id)?;
        let current = self.current_mod_portal_choices(&transaction, port_id)?;
        if current.revision != expected_revision {
            return Err(PortcoveError::conflict(
                "Mod source choices changed. Review the current choices before saving.",
            ));
        }
        let offered = crate::external_mod_portal::portals(
            self.catalog(),
            port_id,
            crate::Platform::current().ok(),
        );
        if choices.hidden_sources.iter().any(|id| {
            current.choices.hidden_sources.binary_search(id).is_err()
                && offered.iter().all(|portal| &portal.source != id)
        }) {
            return Err(PortcoveError::verification(
                "The selected mod source does not belong to this game",
            ));
        }
        if current.choices == choices && choices != ModPortalChoices::default() {
            return Ok(crate::external_mod_portal::project_mod_portals(
                offered, current,
            ));
        }
        let old_communities = hidden_communities(&transaction, port_id, current.revision)?;
        if current.choices == choices && old_communities.is_empty() {
            return Ok(crate::external_mod_portal::project_mod_portals(
                offered, current,
            ));
        }
        let mut communities = Vec::new();
        if choices != ModPortalChoices::default() {
            bind_legacy_choices(&choices, &offered, &mut communities);
            communities.extend(old_communities.into_iter().filter(|entry| {
                if let Some(community) = entry.community.as_deref() {
                    !offered.iter().any(|portal| {
                        generated_thunderstore_community(portal).as_deref() == Some(community)
                    })
                } else {
                    choices.hidden_sources.binary_search(&entry.source).is_err()
                }
            }));
        }
        let unbound = choices
            .hidden_sources
            .iter()
            .filter(|id| !communities.iter().any(|entry| entry.source == **id))
            .count();
        if unbound + communities.len() > MAX_HIDDEN_SOURCES {
            return Err(PortcoveError::verification(
                "Too many hidden mod sources and communities",
            ));
        }
        let revision = next_revision(expected_revision)?;
        let json = serde_json::to_string(&choices)?;
        transaction.execute(
            "INSERT INTO mod_portal_preferences (port_id, revision, choices_json)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(port_id) DO UPDATE SET revision = excluded.revision,
                 choices_json = excluded.choices_json",
            params![port_id, revision, json],
        )?;
        write_communities(&transaction, port_id, revision as u64, &communities)?;
        transaction.commit()?;
        Ok(crate::external_mod_portal::project_mod_portals(
            offered,
            ModPortalPreferences {
                revision: revision as u64,
                choices,
            },
        ))
    }

    fn require_mod_portal_subject(&self, connection: &Connection, port_id: &str) -> Result<()> {
        if self.catalog().listing(port_id).is_ok() || self.catalog().port(port_id).is_ok() {
            return Ok(());
        }
        // A pending setup still identifies the player's entry after catalog
        // withdrawal. Its retained record does not supply automatic mod links.
        if Self::pending_download_port_ids_from(connection, Some(port_id))?.contains(port_id)
            || crate::Library::external_runtime_with_port_from(connection, port_id)?.is_some()
        {
            return Ok(());
        }
        self.catalog().port(port_id).map(|_| ())
    }
}
