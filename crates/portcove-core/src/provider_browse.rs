//! Read-only browsing of a bound game's provider mods (GameBanana or Thunderstore).
//!
//! Browsing is limited to games with a reviewed provider binding and only reads:
//! it never downloads, plans or installs. Results are presentation data whose text
//! is sanitized by the adapter; a project from another game is refused, and
//! popularity, names or version labels never establish compatibility. Installing
//! a browsed file goes through `provider-plan` and `provider-apply` as usual.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[cfg(test)]
use crate::GameBananaClient;
use crate::{
    PortcoveError, PortcoveService, ProviderFreshness, ProviderPage, ProviderProject, Result,
    provider_client::ProviderClient,
};

/// Mods listed per browse page.
const BROWSE_PAGE_SIZE: u32 = 20;
/// Pages beyond this are not offered; the provider's own site covers deep browsing.
const MAX_BROWSE_PAGE: u32 = 50;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ProviderBrowsePage {
    pub port_id: String,
    /// The game's catalog name, for presentation.
    pub game_name: String,
    /// Highest page browsing offers.
    pub last_page: u32,
    /// Records on this page the provider labels as another game; not listed.
    pub other_game_records: u32,
    pub provider: String,
    /// One page of mods, most downloaded first. `page.complete` is false when more
    /// pages exist.
    pub page: ProviderPage,
    pub observed_at: i64,
    /// `stale` means the provider could not be reached and this is earlier data.
    pub freshness: ProviderFreshness,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ProviderProjectView {
    pub port_id: String,
    /// The game's catalog name, for presentation.
    pub game_name: String,
    /// The project's files; a file ID with this project ID is what `provider-plan`
    /// reviews.
    pub project: ProviderProject,
    pub observed_at: i64,
    pub freshness: ProviderFreshness,
}

impl PortcoveService {
    /// One page of GameBanana mods for a game with a reviewed binding.
    pub async fn browse_provider_mods(
        &self,
        port_id: &str,
        page: u32,
    ) -> Result<ProviderBrowsePage> {
        self.catalog().port(port_id)?;
        let client = ProviderClient::for_port(&self.library, port_id)?;
        self.browse_provider_mods_via(&client, port_id, page).await
    }

    #[cfg(test)]
    pub(crate) async fn browse_provider_mods_with(
        &self,
        client: &GameBananaClient,
        port_id: &str,
        page: u32,
    ) -> Result<ProviderBrowsePage> {
        self.catalog().port(port_id)?;
        let client = ProviderClient::gamebanana(client, port_id)?;
        self.browse_provider_mods_via(&client, port_id, page).await
    }

    pub(crate) async fn browse_provider_mods_via(
        &self,
        client: &ProviderClient,
        port_id: &str,
        page: u32,
    ) -> Result<ProviderBrowsePage> {
        let game_name = self.catalog().port(port_id)?.name.clone();
        if page == 0 || page > MAX_BROWSE_PAGE {
            return Err(PortcoveError::usage(format!(
                "browse pages run from 1 to {MAX_BROWSE_PAGE}"
            )));
        }
        let mut observed = client.search(page, BROWSE_PAGE_SIZE).await?;
        // The provider filters by game; anything it labels as another game is
        // dropped rather than listed under this one.
        let game_text = client.game_id();
        let before = observed.value.projects.len();
        observed
            .value
            .projects
            .retain(|project| project.game_id.as_deref().is_none_or(|id| id == game_text));
        let other_game_records = (before - observed.value.projects.len()) as u32;
        Ok(ProviderBrowsePage {
            port_id: port_id.into(),
            game_name,
            last_page: MAX_BROWSE_PAGE,
            other_game_records,
            provider: client.provider().into(),
            page: observed.value,
            observed_at: observed.observed_at,
            freshness: observed.freshness,
        })
    }

    /// One project's files, refused when the project belongs to another game.
    pub async fn provider_project(
        &self,
        port_id: &str,
        project_id: &str,
    ) -> Result<ProviderProjectView> {
        self.catalog().port(port_id)?;
        let client = ProviderClient::for_port(&self.library, port_id)?;
        self.provider_project_via(&client, port_id, project_id)
            .await
    }

    #[cfg(test)]
    pub(crate) async fn provider_project_with(
        &self,
        client: &GameBananaClient,
        port_id: &str,
        project_id: u64,
    ) -> Result<ProviderProjectView> {
        self.catalog().port(port_id)?;
        let client = ProviderClient::gamebanana(client, port_id)?;
        self.provider_project_via(&client, port_id, &project_id.to_string())
            .await
    }

    pub(crate) async fn provider_project_via(
        &self,
        client: &ProviderClient,
        port_id: &str,
        project_id: &str,
    ) -> Result<ProviderProjectView> {
        let game_name = self.catalog().port(port_id)?.name.clone();
        let observed = client.project(project_id).await?;
        if observed.value.game_id.as_deref() != Some(client.game_id().as_str()) {
            return Err(PortcoveError::verification(
                "this project does not belong to the game this port is bound to",
            ));
        }
        Ok(ProviderProjectView {
            port_id: port_id.into(),
            game_name,
            project: observed.value,
            observed_at: observed.observed_at,
            freshness: observed.freshness,
        })
    }
}

#[cfg(test)]
#[path = "provider_browse_tests.rs"]
mod tests;
