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
/// Provider pages of 50 one catalog read requests. Larger catalogs continue
/// from `ProviderCatalog::next_page` in later reads, so every project stays
/// reachable while each read keeps a bounded request count.
const CATALOG_PAGES_PER_READ: u32 = 12;

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
    /// Current files that Core can review for this port's loader. The bytes
    /// still have to pass the ordinary install review.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub eligible_file_ids: Option<Vec<String>>,
    pub observed_at: i64,
    pub freshness: ProviderFreshness,
}

/// A bounded snapshot for searching, filtering and sorting before paginating.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ProviderCatalog {
    pub projects: Vec<ProviderProject>,
    /// Scope of older unscoped package references, when they belong to this catalog.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub legacy_game_id: Option<String>,
    /// False when additional or unreadable records may exist.
    pub complete: bool,
    /// Provider page to continue from when this read stopped at its request
    /// bound. Absent when the listing ended or could not be read consistently.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_page: Option<u32>,
    /// Records the provider reports for the whole listing, when it reports one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_total: Option<u64>,
    pub observed_at: i64,
    pub freshness: ProviderFreshness,
}

impl PortcoveService {
    pub async fn mod_provider_catalog(
        &self,
        port_id: &str,
        source: &str,
    ) -> Result<ProviderCatalog> {
        self.mod_provider_catalog_from(port_id, source, 1).await
    }

    /// Reads the catalog starting at provider page `start_page` (1 first). A
    /// continuation's `complete` covers only its own pages; the caller merges
    /// reads and checks the merged count against `expected_total`.
    pub async fn mod_provider_catalog_from(
        &self,
        port_id: &str,
        source: &str,
        start_page: u32,
    ) -> Result<ProviderCatalog> {
        if start_page == 0 {
            return Err(PortcoveError::usage("provider catalog pages start at 1"));
        }
        let client = ProviderClient::for_definition(
            &self.library,
            self.catalog().port(port_id)?,
            Some(source),
        )?;
        let legacy_game_id = crate::provider_binding::legacy_binding(port_id, source)
            .filter(|legacy| *legacy == client.binding())
            .map(|_| client.game_id());
        match client {
            ProviderClient::GameBanana { client, game } => {
                gamebanana_catalog(&client, game, start_page, legacy_game_id).await
            }
            ProviderClient::Thunderstore { client, community } => {
                let observed = client.community_catalog(&community).await?;
                let (mut projects, expected) = observed.value;
                let mut seen = std::collections::HashSet::new();
                projects.retain(|project| seen.insert(project.project_id.clone()));
                for project in &mut projects {
                    project.files.clear();
                }
                Ok(ProviderCatalog {
                    legacy_game_id,
                    complete: projects.len() == expected,
                    next_page: None,
                    expected_total: Some(expected as u64),
                    projects,
                    observed_at: observed.observed_at,
                    freshness: observed.freshness,
                })
            }
        }
    }

    /// One page of GameBanana mods for a game with a reviewed binding.
    pub async fn browse_provider_mods(
        &self,
        port_id: &str,
        page: u32,
    ) -> Result<ProviderBrowsePage> {
        self.browse_provider_mods_for_provider(port_id, page, None)
            .await
    }

    pub async fn browse_provider_mods_for_provider(
        &self,
        port_id: &str,
        page: u32,
        provider: Option<&str>,
    ) -> Result<ProviderBrowsePage> {
        let client =
            ProviderClient::for_definition(&self.library, self.catalog().port(port_id)?, provider)?;
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
        if page == 0 {
            return Err(PortcoveError::usage("browse pages start at 1"));
        }
        let mut observed = client.search(page, BROWSE_PAGE_SIZE).await?;
        let last_page = if observed.value.complete {
            page
        } else {
            let reported = observed.value.total.div_ceil(u64::from(BROWSE_PAGE_SIZE));
            u32::try_from(reported)
                .unwrap_or(u32::MAX)
                .max(page.saturating_add(1))
        };
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
            last_page,
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
        self.provider_project_for_provider(port_id, project_id, None)
            .await
    }

    pub async fn provider_project_for_provider(
        &self,
        port_id: &str,
        project_id: &str,
        provider: Option<&str>,
    ) -> Result<ProviderProjectView> {
        let client =
            ProviderClient::for_definition(&self.library, self.catalog().port(port_id)?, provider)?;
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
        let port = self.catalog().port(port_id)?;
        let observed = client.project(project_id).await?;
        if observed.value.game_id.as_deref() != Some(client.game_id().as_str()) {
            return Err(PortcoveError::verification(
                "this project does not belong to the game this port is bound to",
            ));
        }
        let layout = self.optional_deploy_layout(port_id)?;
        let eligible_file_ids = match layout {
            Some(layout) if observed.freshness != ProviderFreshness::Stale => observed
                .value
                .files
                .iter()
                .filter(|file| {
                    crate::provider_install::accepts_provider_file(&layout, file)
                        && crate::provider_install::validate_offer(client, &observed.value, file)
                            .is_ok()
                })
                .map(|file| file.file_id.clone())
                .collect(),
            _ => Vec::new(),
        };
        Ok(ProviderProjectView {
            port_id: port_id.into(),
            game_name: port.name.clone(),
            project: observed.value,
            eligible_file_ids: Some(eligible_file_ids),
            observed_at: observed.observed_at,
            freshness: observed.freshness,
        })
    }
}

#[cfg(test)]
#[path = "provider_browse_tests.rs"]
mod tests;

/// One bounded GameBanana catalog read from `start_page`.
pub(crate) async fn gamebanana_catalog(
    client: &crate::GameBananaClient,
    game: u64,
    start_page: u32,
    legacy_game_id: Option<String>,
) -> Result<ProviderCatalog> {
    let first = client.search(game, start_page, 50).await?;
    let expected = first.value.total;
    let mut freshness = first.freshness;
    let mut observed_at = first.observed_at;
    let mut terminal = first.value.complete;
    let mut projects = first.value.projects;
    let mut consistent = true;
    let last_page = expected.div_ceil(50).min(u64::from(u32::MAX)) as u32;
    let end_page = last_page.min(start_page.saturating_add(CATALOG_PAGES_PER_READ - 1));
    for page in start_page.saturating_add(1)..=end_page {
        let Ok(next) = client.search(game, page, 50).await else {
            consistent = false;
            break;
        };
        if next.value.total != expected
            || (next.freshness == ProviderFreshness::Stale)
                != (first.freshness == ProviderFreshness::Stale)
            || terminal
        {
            consistent = false;
        }
        terminal = next.value.complete;
        observed_at = observed_at.min(next.observed_at);
        if next.freshness == ProviderFreshness::Stale {
            freshness = ProviderFreshness::Stale;
        }
        projects.extend(next.value.projects);
    }
    let game = game.to_string();
    projects.retain(|project| project.game_id.as_deref() == Some(&game));
    let mut seen = std::collections::HashSet::new();
    projects.retain(|project| seen.insert(project.project_id.clone()));
    // GameBanana does not return download counts on every listing.
    // Preserve its Most Downloaded order even when counts are absent.
    let next_page = (consistent && !terminal && end_page < last_page).then(|| end_page + 1);
    let complete = consistent && terminal && (start_page > 1 || projects.len() as u64 == expected);
    Ok(ProviderCatalog {
        legacy_game_id,
        complete,
        next_page,
        expected_total: Some(expected),
        projects,
        observed_at,
        freshness,
    })
}
