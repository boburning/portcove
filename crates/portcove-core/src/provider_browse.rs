//! Read-only browsing of a bound game's GameBanana mods.
//!
//! Browsing is limited to games with a reviewed provider binding and only reads:
//! it never downloads, plans or installs. Results are presentation data whose text
//! is sanitized by the adapter; a project from another game is refused, and
//! popularity, names or version labels never establish compatibility. Installing
//! a browsed file goes through `provider-plan` and `provider-apply` as usual.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{
    PortcoveError, PortcoveService, ProviderFreshness, ProviderPage, ProviderProject, Result,
    gamebanana::{GameBananaClient, PROVIDER},
    provider_install::gamebanana_game,
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
    pub provider: String,
    /// One page of mods, most downloaded first. `page.complete` is false when more
    /// pages exist.
    pub page: ProviderPage,
    pub observed_at: i64,
    /// `stale` means GameBanana could not be reached and this is earlier data.
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

fn binding(port_id: &str) -> Result<u64> {
    gamebanana_game(port_id).ok_or_else(|| {
        PortcoveError::unsupported("this game has no reviewed GameBanana binding yet")
    })
}

impl PortcoveService {
    /// One page of GameBanana mods for a game with a reviewed binding.
    pub async fn browse_provider_mods(
        &self,
        port_id: &str,
        page: u32,
    ) -> Result<ProviderBrowsePage> {
        let client = GameBananaClient::for_library(&self.library)?;
        self.browse_provider_mods_with(&client, port_id, page).await
    }

    pub(crate) async fn browse_provider_mods_with(
        &self,
        client: &GameBananaClient,
        port_id: &str,
        page: u32,
    ) -> Result<ProviderBrowsePage> {
        let game_name = self.catalog().port(port_id)?.name.clone();
        let game = binding(port_id)?;
        if page == 0 || page > MAX_BROWSE_PAGE {
            return Err(PortcoveError::usage(format!(
                "browse pages run from 1 to {MAX_BROWSE_PAGE}"
            )));
        }
        let mut observed = client.search(game, page, BROWSE_PAGE_SIZE).await?;
        // The provider filters by game; anything it labels as another game is
        // dropped rather than listed under this one.
        let game_text = game.to_string();
        observed
            .value
            .projects
            .retain(|project| project.game_id.as_deref().is_none_or(|id| id == game_text));
        Ok(ProviderBrowsePage {
            port_id: port_id.into(),
            game_name,
            last_page: MAX_BROWSE_PAGE,
            provider: PROVIDER.into(),
            page: observed.value,
            observed_at: observed.observed_at,
            freshness: observed.freshness,
        })
    }

    /// One project's files, refused when the project belongs to another game.
    pub async fn provider_project(
        &self,
        port_id: &str,
        project_id: u64,
    ) -> Result<ProviderProjectView> {
        let client = GameBananaClient::for_library(&self.library)?;
        self.provider_project_with(&client, port_id, project_id)
            .await
    }

    pub(crate) async fn provider_project_with(
        &self,
        client: &GameBananaClient,
        port_id: &str,
        project_id: u64,
    ) -> Result<ProviderProjectView> {
        let game_name = self.catalog().port(port_id)?.name.clone();
        let game = binding(port_id)?;
        let observed = client.project(project_id).await?;
        if observed.value.game_id.as_deref() != Some(game.to_string().as_str()) {
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
