//! The mod provider a game has a reviewed binding for. A game has at most one;
//! its binding, never a provider listing, says which community or game ID is
//! authoritative.
use std::path::Path;

use crate::{
    GameBananaClient, Library, PortcoveError, Result, ThunderstoreClient,
    mod_provider::{Observed, ProviderFileCandidate, ProviderPage, ProviderProject},
    provider_install::gamebanana_game,
    thunderstore::thunderstore_community,
};

#[derive(Clone)]
pub(crate) enum ProviderClient {
    GameBanana {
        client: GameBananaClient,
        game: u64,
    },
    Thunderstore {
        client: ThunderstoreClient,
        community: &'static str,
    },
}

impl ProviderClient {
    pub(crate) fn for_port(library: &Library, port_id: &str) -> Result<Self> {
        if let Some(game) = gamebanana_game(port_id) {
            return Ok(Self::GameBanana {
                client: GameBananaClient::for_library(library)?,
                game,
            });
        }
        if let Some(community) = thunderstore_community(port_id) {
            return Ok(Self::Thunderstore {
                client: ThunderstoreClient::for_library(library)?,
                community,
            });
        }
        Err(unbound())
    }

    /// The GameBanana binding with a given client (tests).
    #[cfg(test)]
    pub(crate) fn gamebanana(client: &GameBananaClient, port_id: &str) -> Result<Self> {
        let game = gamebanana_game(port_id).ok_or_else(|| {
            PortcoveError::unsupported("this game has no reviewed GameBanana binding yet")
        })?;
        Ok(Self::GameBanana {
            client: client.clone(),
            game,
        })
    }

    /// The provider's identity as recorded with packages.
    pub(crate) fn provider(&self) -> &'static str {
        match self {
            Self::GameBanana { .. } => crate::gamebanana::PROVIDER,
            Self::Thunderstore { .. } => crate::thunderstore::PROVIDER,
        }
    }

    /// The provider's name in messages.
    pub(crate) fn label(&self) -> &'static str {
        match self {
            Self::GameBanana { .. } => "GameBanana",
            Self::Thunderstore { .. } => "Thunderstore",
        }
    }

    /// The game or community identity a project must carry to belong to this port.
    pub(crate) fn game_id(&self) -> String {
        match self {
            Self::GameBanana { game, .. } => game.to_string(),
            Self::Thunderstore { community, .. } => (*community).to_owned(),
        }
    }

    pub(crate) async fn search(&self, page: u32, per_page: u32) -> Result<Observed<ProviderPage>> {
        match self {
            Self::GameBanana { client, game } => client.search(*game, page, per_page).await,
            Self::Thunderstore { client, community } => {
                client.search(community, page, per_page).await
            }
        }
    }

    pub(crate) async fn project(&self, project_id: &str) -> Result<Observed<ProviderProject>> {
        match self {
            Self::GameBanana { client, .. } => {
                let id = project_id
                    .parse::<u64>()
                    .ok()
                    .filter(|id| *id > 0)
                    .ok_or_else(|| {
                        PortcoveError::usage("GameBanana mod IDs are positive numbers")
                    })?;
                client.project(id).await
            }
            Self::Thunderstore { client, community } => client.project(community, project_id).await,
        }
    }

    pub(crate) async fn download(
        &self,
        project_id: &str,
        file: &ProviderFileCandidate,
        destination: &Path,
        max_bytes: u64,
    ) -> Result<(String, u64)> {
        match self {
            Self::GameBanana { client, .. } => {
                client.download_file(file, destination, max_bytes).await
            }
            Self::Thunderstore { client, .. } => {
                client
                    .download_file(project_id, file, destination, max_bytes)
                    .await
            }
        }
    }

    /// Whether `candidate` was published after the installed file. GameBanana
    /// file IDs grow with each upload. Thunderstore versions are compared by when
    /// they were published, or by version number when the installed version is no
    /// longer listed.
    pub(crate) fn newer_than(
        &self,
        candidate: &ProviderFileCandidate,
        installed_id: &str,
        installed: Option<&ProviderFileCandidate>,
    ) -> bool {
        match (self, installed) {
            (Self::GameBanana { .. }, _) => {
                candidate.file_id.parse::<u64>().unwrap_or_default()
                    > installed_id.parse::<u64>().unwrap_or_default()
            }
            // Published later and numbered higher: a backport published after a
            // newer release is never offered as an update.
            (Self::Thunderstore { .. }, Some(installed)) => {
                candidate.added_at > installed.added_at
                    && version_parts(&candidate.file_id) > version_parts(&installed.file_id)
            }
            // No longer listed: only a higher version number counts as newer.
            (Self::Thunderstore { .. }, None) => {
                version_parts(&candidate.file_id) > version_parts(installed_id)
            }
        }
    }

    /// The sort key that orders a project's files oldest first.
    pub(crate) fn order_key(&self, file: &ProviderFileCandidate) -> (i64, [u64; 3]) {
        match self {
            Self::GameBanana { .. } => (0, [file.file_id.parse().unwrap_or_default(), 0, 0]),
            Self::Thunderstore { .. } => (file.added_at, version_parts(&file.file_id)),
        }
    }
}

fn version_parts(version: &str) -> [u64; 3] {
    let mut parts = [0; 3];
    for (slot, part) in parts.iter_mut().zip(version.split('.')) {
        *slot = part.parse().unwrap_or_default();
    }
    parts
}

pub(crate) fn unbound() -> PortcoveError {
    PortcoveError::unsupported("this game has no reviewed mod provider binding yet")
}
