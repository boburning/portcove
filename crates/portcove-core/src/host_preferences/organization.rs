//! Private presentation choices; none authorizes operations or records installed state.
use super::*;

const ORGANIZATION_KEY: &str = "organization_by_library";

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct LibraryOrganization {
    #[serde(default)]
    pub revision: u64,
    #[serde(default)]
    pub collections: BTreeMap<String, CollectionPreference>,
    #[serde(default)]
    pub hidden_port_ids: BTreeSet<String>,
    #[serde(default)]
    pub saved_game_ids: BTreeSet<String>,
    #[serde(default)]
    pub update_notices: BTreeMap<String, UpdateNoticeChoice>,
    #[serde(default)]
    pub setup_confirmations: BTreeSet<SetupConfirmation>,
    #[serde(flatten)]
    extensions: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct CollectionPreference {
    pub name: String,
    #[serde(default)]
    pub port_ids: BTreeSet<String>,
    #[serde(flatten)]
    extensions: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct UpdateNoticeChoice {
    pub paused: bool,
    pub skipped_release: Option<UpdateNoticeRelease>,
    #[serde(flatten)]
    extensions: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct UpdateNoticeRelease {
    pub version: String,
    /// Same-tag rebuilds with different bytes must remain visible.
    pub artifact_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum InstallationContext {
    Managed { installation_id: String },
    External { installation_id: String },
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SetupConfirmation {
    pub port_id: String,
    pub context: InstallationContext,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum OrganizationChange {
    SetHidden {
        port_id: String,
        hidden: bool,
    },
    SetSaved {
        game_id: String,
        saved: bool,
    },
    SetSavedGroup {
        game_id: String,
        legacy_port_ids: Vec<String>,
        saved: bool,
    },
    UpsertCollection {
        collection_id: String,
        name: String,
    },
    RemoveCollection {
        collection_id: String,
    },
    SetCollectionPort {
        collection_id: String,
        port_id: String,
        included: bool,
    },
    SetUpdateNotice {
        port_id: String,
        choice: UpdateNoticeChoice,
    },
    SetSetupConfirmation {
        confirmation: SetupConfirmation,
        confirmed: bool,
    },
}

impl HostPreferenceStore {
    pub fn library_organization(&self, library_id: &str) -> Result<LibraryOrganization> {
        validate_favorite_library_id(library_id)?;
        let preferences = self.load()?;
        let libraries = organization_libraries(&preferences)?;
        organization_record(libraries.get(library_id))
    }

    /// Compare and publish within the same host lock; unrelated and future records survive.
    pub fn change_library_organization(
        &self,
        library_id: &str,
        expected_revision: u64,
        change: OrganizationChange,
    ) -> Result<LibraryOrganization> {
        validate_favorite_library_id(library_id)?;
        let _lock = self.lock()?;
        let mut preferences = self.load()?;
        let mut libraries = organization_libraries(&preferences)?;
        let mut record = organization_record(libraries.get(library_id))?;
        if record.revision != expected_revision {
            return Err(PortcoveError::conflict(
                "library choices changed; refresh before saving",
            ));
        }
        match change {
            OrganizationChange::SetHidden { port_id, hidden } => {
                validate_id(&port_id)?;
                set_member(&mut record.hidden_port_ids, port_id, hidden);
            }
            OrganizationChange::SetSaved { game_id, saved } => {
                validate_saved_id(&game_id)?;
                set_member(&mut record.saved_game_ids, game_id, saved);
            }
            OrganizationChange::SetSavedGroup {
                game_id,
                legacy_port_ids,
                saved,
            } => {
                validate_saved_id(&game_id)?;
                if legacy_port_ids.len() > 128 {
                    return Err(PortcoveError::usage("too many Saved project aliases"));
                }
                for id in &legacy_port_ids {
                    validate_id(id)?;
                }
                set_member(&mut record.saved_game_ids, game_id, saved);
                if !saved {
                    for id in legacy_port_ids {
                        record.saved_game_ids.remove(&format!("port-{id}"));
                    }
                }
            }
            OrganizationChange::UpsertCollection {
                collection_id,
                name,
            } => {
                validate_id(&collection_id)?;
                validate_label(&name, 120)?;
                record.collections.entry(collection_id).or_default().name = name;
            }
            OrganizationChange::RemoveCollection { collection_id } => {
                validate_id(&collection_id)?;
                record.collections.remove(&collection_id);
            }
            OrganizationChange::SetCollectionPort {
                collection_id,
                port_id,
                included,
            } => {
                validate_id(&collection_id)?;
                validate_id(&port_id)?;
                let collection = record
                    .collections
                    .get_mut(&collection_id)
                    .ok_or_else(|| PortcoveError::conflict("collection no longer exists"))?;
                set_member(&mut collection.port_ids, port_id, included);
            }
            OrganizationChange::SetUpdateNotice { port_id, choice } => {
                validate_id(&port_id)?;
                validate_notice(&choice)?;
                // Keep unknown choice fields even if an older client changes known fields.
                let current = record.update_notices.entry(port_id).or_default();
                current.paused = choice.paused;
                current.skipped_release = choice.skipped_release;
            }
            OrganizationChange::SetSetupConfirmation {
                confirmation,
                confirmed,
            } => {
                validate_confirmation(&confirmation)?;
                set_member(&mut record.setup_confirmations, confirmation, confirmed);
            }
        }
        record.revision = record
            .revision
            .checked_add(1)
            .ok_or_else(|| PortcoveError::state("library choice revision is exhausted"))?;
        libraries.insert(library_id.to_owned(), serde_json::to_value(&record)?);
        preferences.extensions.insert(
            ORGANIZATION_KEY.to_owned(),
            serde_json::to_value(libraries)?,
        );
        self.publish(&preferences)?;
        Ok(record)
    }
}

fn organization_libraries(
    preferences: &HostPreferences,
) -> Result<BTreeMap<String, serde_json::Value>> {
    preferences.extensions.get(ORGANIZATION_KEY).map_or_else(
        || Ok(BTreeMap::new()),
        |value| {
            serde_json::from_value(value.clone())
                .map_err(|_| PortcoveError::state("saved library choices are malformed"))
        },
    )
}

fn organization_record(value: Option<&serde_json::Value>) -> Result<LibraryOrganization> {
    let record: LibraryOrganization = value.map_or_else(
        || Ok(LibraryOrganization::default()),
        |value| {
            serde_json::from_value(value.clone())
                .map_err(|_| PortcoveError::state("saved library choices are malformed"))
        },
    )?;
    for (id, collection) in &record.collections {
        validate_id(id)?;
        validate_label(&collection.name, 120)?;
        for port in &collection.port_ids {
            validate_id(port)?;
        }
    }
    for id in &record.hidden_port_ids {
        validate_id(id)?;
    }
    for id in &record.saved_game_ids {
        validate_saved_id(id)?;
    }
    for (port, notice) in &record.update_notices {
        validate_id(port)?;
        validate_notice(notice)?;
    }
    for confirmation in &record.setup_confirmations {
        validate_confirmation(confirmation)?;
    }
    Ok(record)
}

fn validate_saved_id(id: &str) -> Result<()> {
    // A Saved key adds its namespace to an unchanged catalog ID (up to 128 bytes).
    if id.len() > 133 {
        return Err(PortcoveError::usage("Saved identity exceeds its limit"));
    }
    validate_favorite_port_id(id)
}

fn validate_id(id: &str) -> Result<()> {
    if id.len() > 128 {
        return Err(PortcoveError::usage("choice identity exceeds its limit"));
    }
    validate_favorite_port_id(id)
}

fn validate_label(value: &str, limit: usize) -> Result<()> {
    if value.trim().is_empty() || value.len() > limit || value.chars().any(char::is_control) {
        return Err(PortcoveError::usage(
            "choice label is empty, too long or contains controls",
        ));
    }
    Ok(())
}

fn validate_notice(choice: &UpdateNoticeChoice) -> Result<()> {
    if let Some(release) = &choice.skipped_release {
        validate_label(&release.version, 256)?;
        if release.artifact_sha256.len() != 64
            || !release
                .artifact_sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(PortcoveError::usage(
                "a skipped release requires its exact artifact SHA-256",
            ));
        }
    }
    Ok(())
}

fn validate_confirmation(confirmation: &SetupConfirmation) -> Result<()> {
    validate_id(&confirmation.port_id)?;
    let (InstallationContext::Managed { installation_id }
    | InstallationContext::External { installation_id }) = &confirmation.context;
    validate_label(installation_id, 128)
}

fn set_member<T: Ord>(set: &mut BTreeSet<T>, id: T, included: bool) {
    if included {
        set.insert(id);
    } else {
        set.remove(&id);
    }
}

#[cfg(test)]
mod tests;
