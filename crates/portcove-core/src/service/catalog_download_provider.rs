//! Dispatch within the existing downloaded-setup lifecycle, not another
//! release resolver or durable authority.
use super::*;
use crate::{GithubReleaseProvider, GitlabReleaseProvider};

pub(crate) enum CatalogDownloadRepository {
    Github(String),
    Gitlab(String),
}

impl CatalogDownloadRepository {
    pub(crate) fn parse(value: &str) -> Result<Self> {
        let url = reqwest::Url::parse(value).map_err(|_| {
            PortcoveError::unsupported("upstream URL does not identify a supported repository")
        })?;
        if url.host_str() == Some("github.com") {
            return crate::release::catalog_download_repository(value).map(Self::Github);
        }
        if url.scheme() != "https"
            || url.host_str() != Some("gitlab.com")
            || !url.username().is_empty()
            || url.password().is_some()
            || url.port().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(PortcoveError::unsupported(
                "self-service downloads support GitHub and qualified GitLab registry releases",
            ));
        }
        let mut parts = url
            .path_segments()
            .into_iter()
            .flatten()
            .take_while(|part| *part != "-")
            .collect::<Vec<_>>();
        if parts.last() == Some(&"") {
            parts.pop();
        }
        if let Some(last) = parts.last_mut() {
            let value = *last;
            *last = value.strip_suffix(".git").unwrap_or(value);
        }
        if parts.len() < 2
            || parts.iter().any(|part| {
                part.is_empty()
                    || *part == "."
                    || *part == ".."
                    || part.len() > 255
                    || !part
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte))
            })
        {
            return Err(PortcoveError::verification(
                "upstream URL does not identify one GitLab project",
            ));
        }
        Ok(Self::Gitlab(parts.join("/")))
    }

    pub(crate) fn name(&self) -> &str {
        match self {
            Self::Github(name) | Self::Gitlab(name) => name,
        }
    }

    pub(super) fn release_notes_url(&self, tag: &str) -> Option<String> {
        if tag.is_empty() || tag.len() > 512 || tag.chars().any(char::is_control) {
            return None;
        }
        let url = match self {
            Self::Github(repository) => format!("https://github.com/{repository}/releases/tag"),
            Self::Gitlab(repository) => format!("https://gitlab.com/{repository}/-/releases"),
        };
        crate::release_notes::web_url(&url, &[tag])
    }
}

#[derive(Clone)]
pub(super) enum CatalogDownloadProvider {
    Github(GithubReleaseProvider),
    Gitlab(GitlabReleaseProvider),
}

impl CatalogDownloadProvider {
    pub(super) fn for_repository(
        library: &Library,
        repository: &CatalogDownloadRepository,
    ) -> Result<Self> {
        let providers = CompositeReleaseProvider::for_library(library)?;
        Ok(match repository {
            CatalogDownloadRepository::Github(_) => {
                Self::Github(providers.github().as_ref().clone())
            }
            CatalogDownloadRepository::Gitlab(_) => Self::Gitlab(providers.gitlab()),
        })
    }

    pub(super) fn require_repository(&self, repository: &CatalogDownloadRepository) -> Result<()> {
        if matches!(
            (self, repository),
            (Self::Github(_), CatalogDownloadRepository::Github(_))
                | (Self::Gitlab(_), CatalogDownloadRepository::Gitlab(_))
        ) {
            Ok(())
        } else {
            Err(PortcoveError::verification(
                "download provider differs from the selected upstream",
            ))
        }
    }

    pub(super) async fn options(
        &self,
        repository: &str,
        selected: Option<&CatalogDownloadReleaseId>,
        channel: ReleaseChannel,
        rolling_tag: Option<&str>,
        github_other_stream_prefixes: &[String],
        release_window: Option<usize>,
    ) -> Result<(
        Vec<CatalogDownloadCandidate>,
        CatalogDownloadCoverage,
        Vec<CatalogDownloadRelease>,
        Option<CatalogDownloadReleaseId>,
    )> {
        match self {
            Self::Github(provider) => {
                let selected = selected
                    .map(|id| {
                        id.github_id().ok_or_else(|| {
                            PortcoveError::usage("GitLab references cannot select GitHub releases")
                        })
                    })
                    .transpose()?;
                let (candidates, coverage, releases, selected) = provider
                    .catalog_download_options_window(
                        repository,
                        selected,
                        channel,
                        rolling_tag,
                        github_other_stream_prefixes,
                        release_window.unwrap_or(0),
                    )
                    .await?;
                Ok((candidates, coverage, releases, selected.map(Into::into)))
            }
            Self::Gitlab(provider) => {
                provider
                    .catalog_download_options(repository, selected, channel, rolling_tag)
                    .await
            }
        }
    }

    pub(super) async fn candidate(
        &self,
        repository: &str,
        release: &CatalogDownloadReleaseId,
        asset: &CatalogDownloadAssetId,
    ) -> Result<CatalogDownloadCandidate> {
        asset.validate_for(release)?;
        match self {
            Self::Github(provider) => {
                provider
                    .catalog_release_candidate(
                        repository,
                        release.github_id().ok_or_else(|| {
                            PortcoveError::usage("GitLab references cannot select GitHub releases")
                        })?,
                        asset.github_id().ok_or_else(|| {
                            PortcoveError::verification("mixed download provider identity")
                        })?,
                    )
                    .await
            }
            Self::Gitlab(provider) => {
                provider
                    .catalog_download_candidate(repository, release, asset)
                    .await
            }
        }
    }

    pub(super) async fn candidate_release_notes_url(
        &self,
        repository: &str,
        release: &CatalogDownloadReleaseId,
        asset: &CatalogDownloadAssetId,
    ) -> Result<String> {
        asset.validate_for(release)?;
        match self {
            Self::Github(provider) => {
                let (Some(release), Some(asset)) = (release.github_id(), asset.github_id()) else {
                    return Err(PortcoveError::verification(
                        "mixed download provider identity",
                    ));
                };
                provider
                    .catalog_release_notes_url(repository, release, asset)
                    .await
            }
            Self::Gitlab(provider) => provider
                .catalog_download_candidate(repository, release, asset)
                .await
                .map(|candidate| candidate.release_url),
        }
    }

    pub(super) fn client(
        &self,
        repository: &str,
        candidate: &CatalogDownloadCandidate,
    ) -> Result<reqwest::Client> {
        candidate.asset_id.validate_for(&candidate.release_id)?;
        match self {
            Self::Github(provider) if candidate.release_id.github_id().is_some() => {
                provider.catalog_download_client()
            }
            Self::Github(_) => Err(PortcoveError::verification(
                "GitHub transport cannot acquire a GitLab identity",
            )),
            Self::Gitlab(provider) => provider.catalog_download_client(repository, candidate),
        }
    }
}
