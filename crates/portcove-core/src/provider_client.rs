//! Provider clients scoped to the coordinates of a reviewed port definition.
use std::path::Path;

use crate::{
    GameBananaClient, Library, ModProviderBinding, PortDefinition, PortcoveError, Result,
    ThunderstoreClient,
    mod_provider::{Observed, ProviderFileCandidate, ProviderPage, ProviderProject},
    provider_binding::{default_binding, reviewed_binding},
};

#[derive(Clone)]
pub(crate) enum ProviderClient {
    GameBanana {
        client: GameBananaClient,
        game: u64,
    },
    Thunderstore {
        client: ThunderstoreClient,
        community: String,
    },
}

impl ProviderClient {
    pub(crate) fn for_definition(
        library: &Library,
        port: &PortDefinition,
        provider: Option<&str>,
    ) -> Result<Self> {
        let binding = match provider {
            Some(provider) => reviewed_binding(port, provider),
            None => default_binding(port),
        };
        match binding {
            Some(binding) => Self::for_scope(library, binding),
            None if provider.is_none()
                && crate::provider_binding::configured_bindings(port)
                    .is_some_and(|bindings| bindings.len() > 1) =>
            {
                Err(PortcoveError::usage(
                    "select one reviewed mod provider for this game",
                ))
            }
            None => Err(unbound()),
        }
    }

    pub(crate) fn for_scope(library: &Library, binding: ModProviderBinding) -> Result<Self> {
        match binding {
            ModProviderBinding::Gamebanana { game_id } => Ok(Self::GameBanana {
                client: GameBananaClient::for_library(library)?,
                game: game_id,
            }),
            ModProviderBinding::Thunderstore { community } => Ok(Self::Thunderstore {
                client: ThunderstoreClient::for_library(library)?,
                community,
            }),
        }
    }

    pub(crate) fn binding(&self) -> ModProviderBinding {
        match self {
            Self::GameBanana { game, .. } => ModProviderBinding::Gamebanana { game_id: *game },
            Self::Thunderstore { community, .. } => ModProviderBinding::Thunderstore {
                community: community.clone(),
            },
        }
    }

    /// The GameBanana binding with a given client (tests).
    #[cfg(test)]
    pub(crate) fn gamebanana(client: &GameBananaClient, port_id: &str) -> Result<Self> {
        let Some(ModProviderBinding::Gamebanana { game_id }) =
            crate::provider_binding::legacy_binding(port_id, crate::gamebanana::PROVIDER)
        else {
            return Err(PortcoveError::unsupported(
                "this game has no reviewed GameBanana binding yet",
            ));
        };
        Ok(Self::GameBanana {
            client: client.clone(),
            game: game_id,
        })
    }

    /// The provider's identity as recorded with packages.
    pub(crate) fn provider(&self) -> &'static str {
        match self {
            Self::GameBanana { .. } => crate::gamebanana::PROVIDER,
            Self::Thunderstore { .. } => crate::thunderstore::PROVIDER,
        }
    }

    /// The game or community identity a project must carry to belong to this port.
    pub(crate) fn game_id(&self) -> String {
        match self {
            Self::GameBanana { game, .. } => game.to_string(),
            Self::Thunderstore { community, .. } => community.clone(),
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

pub(crate) fn version_parts(version: &str) -> [u64; 3] {
    let mut parts = [0; 3];
    for (slot, part) in parts.iter_mut().zip(version.split('.')) {
        *slot = part.parse().unwrap_or_default();
    }
    parts
}

pub(crate) fn unbound() -> PortcoveError {
    PortcoveError::unsupported("this game has no reviewed mod provider binding yet")
}
