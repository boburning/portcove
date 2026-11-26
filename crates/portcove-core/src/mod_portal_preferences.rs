use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{ListingModPortal, ModPortalSite, PortcoveError, PortcoveService, Result};

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
    if json.len() > MAX_STORED_BYTES {
        return Err(PortcoveError::verification(
            "Stored mod source choices exceed their limit",
        ));
    }
    let choices: ModPortalChoices = serde_json::from_str(&json)?;
    choices.validate()?;
    Ok(ModPortalPreferences { revision, choices })
}

impl PortcoveService {
    pub fn mod_portal_preferences(&self, port_id: &str) -> Result<ModPortalPreferences> {
        let connection = self.library().connection()?;
        self.require_mod_portal_subject(&connection, port_id)?;
        read_choices(&connection, port_id)
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
        let current = read_choices(&transaction, port_id)?;
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
        if current.choices == choices {
            return Ok(crate::external_mod_portal::project_mod_portals(
                offered, current,
            ));
        }
        let revision = i64::try_from(expected_revision)
            .ok()
            .and_then(|revision| revision.checked_add(1))
            .ok_or_else(|| PortcoveError::state("Mod source choice revision is exhausted"))?;
        let json = serde_json::to_string(&choices)?;
        transaction.execute(
            "INSERT INTO mod_portal_preferences (port_id, revision, choices_json)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(port_id) DO UPDATE SET revision = excluded.revision,
                 choices_json = excluded.choices_json",
            params![port_id, revision, json],
        )?;
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
        if crate::Library::external_runtime_with_port_from(connection, port_id)?.is_some() {
            return Ok(());
        }
        self.catalog().port(port_id).map(|_| ())
    }
}
