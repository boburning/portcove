use serde::{Deserialize, Serialize};

use super::*;

/// An exact release and package chosen for one port, channel and platform.
/// Only the configured provider can supply their current metadata and download URL.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExactReleaseSelection {
    pub port_id: String,
    pub channel: ReleaseChannel,
    pub platform: Platform,
    /// Exact upstream tag or declared direct-manifest version.
    pub version: String,
    pub filename: String,
    pub size: u64,
    pub sha256: String,
    pub identity: ExactReleaseIdentity,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "provider", rename_all = "kebab-case", deny_unknown_fields)]
pub enum ExactReleaseIdentity {
    Github {
        repository_id: u64,
        release_id: u64,
        asset_id: u64,
        commit_sha1: String,
    },
    Gitlab {
        project_id: u64,
        link_id: u64,
        package_file_id: u64,
        commit_sha1: String,
    },
    DirectManifest,
}

impl ExactReleaseSelection {
    pub(crate) fn require_context(
        &self,
        port: &PortDefinition,
        channel: ReleaseChannel,
        platform: Platform,
        scope: Option<&crate::DefinitionAcquisitionScope>,
    ) -> Result<()> {
        let provider = match &self.identity {
            ExactReleaseIdentity::Github { .. } => crate::ReleaseSource::Github,
            ExactReleaseIdentity::Gitlab { .. } => crate::ReleaseSource::Gitlab,
            ExactReleaseIdentity::DirectManifest => crate::ReleaseSource::DirectManifest,
        };
        if self.port_id != port.id
            || self.channel != channel
            || self.platform != platform
            || provider != port.release.provider
            || !port.channels.contains(&channel)
            || !port.platforms.contains(&platform)
        {
            return Err(PortcoveError::verification(
                "the exact release selection does not match this provider, port, channel and platform",
            ));
        }
        if port.release.managed_build.contains_key(&platform) {
            return Err(crate::cartridge_build::retired_creation());
        }
        if scope.is_some() || !port.release.curated.is_empty() {
            return Err(PortcoveError::unsupported(
                "this route requires its authorized curated release selection",
            ));
        }
        if let Some(hold) = &port.managed_acquisition_hold
            && (hold.excluded_artifacts.is_empty() || hold.excludes(&self.version, &self.sha256))
        {
            return Err(PortcoveError::unsupported(hold.reason.clone()));
        }

        let valid_name = |name: &str| {
            !name.is_empty()
                && name.len() <= 255
                && name != "."
                && name != ".."
                && !name.chars().any(|c| c.is_control() || c == '\\')
        };
        let valid_git_tag = || {
            self.version
                .split('/')
                .all(|part| part != "." && part != ".." && !part.is_empty())
        };
        let valid_commit =
            |sha: &str| sha.len() == 40 && sha.bytes().all(|byte| byte.is_ascii_hexdigit());
        let valid_identity = match &self.identity {
            ExactReleaseIdentity::Github {
                repository_id,
                release_id,
                asset_id,
                commit_sha1,
            } => {
                *repository_id > 0
                    && *release_id > 0
                    && *asset_id > 0
                    && valid_commit(commit_sha1)
                    && valid_git_tag()
            }
            ExactReleaseIdentity::Gitlab {
                project_id,
                link_id,
                package_file_id,
                commit_sha1,
            } => {
                *project_id > 0
                    && *link_id > 0
                    && *package_file_id > 0
                    && valid_commit(commit_sha1)
                    && valid_git_tag()
            }
            ExactReleaseIdentity::DirectManifest => true,
        };
        crate::archive::validate_relative_path(&self.filename, false)?;
        crate::archive::validate_download_progress(0, self.size)?;
        if !valid_name(&self.version)
            || !valid_name(&self.filename)
            || self.filename.contains('/')
            || self.filename.to_ascii_lowercase().starts_with(".portcove-")
            || self.size == 0
            || !is_sha256(&self.sha256)
            || !valid_identity
        {
            return Err(PortcoveError::verification(
                "the exact release selection lacks valid artifact identity or SHA-256",
            ));
        }
        Ok(())
    }

    pub(crate) fn require_artifact(&self, release: &ResolvedRelease) -> Result<()> {
        if release.version != self.version
            || release.channel != self.channel
            || release.asset.name != self.filename
            || release.asset.size != self.size
            || !release.asset.sha256.eq_ignore_ascii_case(&self.sha256)
        {
            return Err(PortcoveError::verification(
                "the published release or package differs from the exact selection",
            ));
        }
        Ok(())
    }
}

impl GithubReleaseProvider {
    pub(super) async fn resolve_exact_observed(
        &self,
        port: &PortDefinition,
        channel: ReleaseChannel,
        platform: Platform,
        pin: &ExactReleaseSelection,
    ) -> Result<ResolvedGithub> {
        let ExactReleaseIdentity::Github {
            repository_id,
            release_id,
            asset_id,
            commit_sha1,
        } = &pin.identity
        else {
            return Err(PortcoveError::verification(
                "expected an exact GitHub selection",
            ));
        };

        let repository_url = format!("{}/repos/{}", self.api_root, port.release.repository);
        let repository: GithubRepository = self.get_json(&repository_url).await?;
        if repository.id != Some(*repository_id) {
            return Err(PortcoveError::verification(
                "the exact selection's GitHub repository identity changed",
            ));
        }
        let mut tag_url = reqwest::Url::parse(&repository_url)
            .map_err(|error| PortcoveError::state(error.to_string()))?;
        tag_url
            .path_segments_mut()
            .map_err(|_| PortcoveError::state("invalid GitHub release URL"))?
            .extend(["releases", "tags", &pin.version]);
        let mut release: GithubRelease = self.get_json(tag_url.as_str()).await?;
        if release.id != Some(*release_id) || release.tag_name != pin.version {
            return Err(PortcoveError::verification(
                "the exact selection's GitHub release identity changed",
            ));
        }
        if select_github_release_index(
            std::slice::from_ref(&release),
            port,
            channel,
            platform,
            |release| !release.draft,
        )
        .is_none()
        {
            return Err(PortcoveError::unsupported(
                "the exact GitHub release is not published in this channel and platform stream",
            ));
        }
        let mut refresh = SavedReleaseAssetRefresh {
            refreshed: Default::default(),
            deadline: tokio::time::Instant::now() + self.network_bounds.request,
        };
        release.assets = self
            .saved_release_assets(&port.release.repository, &release, None, &mut refresh)
            .await?;
        let asset = choose_asset(port, platform, &release.assets)?;
        if asset.id != Some(*asset_id) || asset.name != pin.filename || asset.size != pin.size {
            return Err(PortcoveError::verification(
                "the exact selection's GitHub package identity changed",
            ));
        }
        let mut expected_url =
            reqwest::Url::parse(&format!("{}/{}", self.web_root, port.release.repository))
                .map_err(|error| PortcoveError::state(error.to_string()))?;
        expected_url
            .path_segments_mut()
            .map_err(|_| PortcoveError::state("invalid GitHub asset URL"))?
            .extend(["releases", "download", &pin.version, &pin.filename]);
        if asset.browser_download_url != expected_url.as_str()
            && asset.browser_download_url != expected_url.as_str().replace('+', "%2B")
        {
            return Err(PortcoveError::verification(
                "the exact package URL differs from its GitHub release path",
            ));
        }
        let sha256 = self
            .catalog_candidate(&port.release.repository, &release, asset)?
            .sha256
            .ok_or_else(|| {
                PortcoveError::verification("the exact package requires its published SHA-256")
            })?;
        if !sha256.eq_ignore_ascii_case(&pin.sha256) {
            return Err(PortcoveError::verification(
                "the exact selection's GitHub package SHA-256 changed",
            ));
        }
        if !self
            .github_tag_commit(port, &pin.version, None)
            .await?
            .eq_ignore_ascii_case(commit_sha1)
        {
            return Err(PortcoveError::verification(
                "the exact selection's GitHub tag points to a different commit",
            ));
        }

        // Established uploaders may need the ordinary listing as continuity
        // evidence. That listing cannot select a different release or package.
        let check_uploader = |history: &[GithubRelease]| {
            uploader_continuity::require(
                port,
                repository.owner.as_ref(),
                history,
                &release.tag_name,
                asset,
            )
        };
        let continuity = match check_uploader(&[]) {
            Ok(basis) if basis != uploader_continuity::Continuity::NotObserved => basis,
            _ => check_uploader(&self.releases(&repository_url).await?)?,
        };
        let identity = crate::definition_acquisition::GithubArtifactIdentity {
            repository: port.release.repository.clone(),
            repository_id: *repository_id,
            release_id: *release_id,
            asset_id: *asset_id,
            tag: release.tag_name.clone(),
        };
        identity.validate()?;
        let selected = ResolvedRelease {
            version: release.tag_name.clone(),
            channel,
            published_at: release.published_at.clone(),
            asset: ReleaseAsset {
                name: asset.name.clone(),
                url: asset.browser_download_url.clone(),
                size: asset.size,
                sha256,
            },
            uploader_continuity: Some(continuity.record(asset)),
        };
        pin.require_artifact(&selected)?;
        Ok(ResolvedGithub {
            release: selected,
            identity: Some(identity),
            explicit_tag_commit: None,
            activity: Some(repository.activity(&port.release.repository)),
            fallback_reason: None,
        })
    }
}
