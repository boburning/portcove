use std::sync::Arc;

use async_trait::async_trait;

use crate::{
    GithubReleaseProvider, GitlabReleaseProvider, Library, Platform, PortDefinition, PortcoveError,
    ReleaseAsset, ReleaseChannel, ReleaseProvider, ReleaseSource, ResolvedRelease, Result,
};

#[derive(Clone)]
pub struct CompositeReleaseProvider {
    github: Arc<GithubReleaseProvider>,
    gitlab: GitlabReleaseProvider,
}

impl CompositeReleaseProvider {
    pub fn for_library(library: &Library) -> Result<Self> {
        Ok(Self {
            github: Arc::new(GithubReleaseProvider::for_library(library)?),
            gitlab: GitlabReleaseProvider::for_library(library)?,
        })
    }

    pub fn github(&self) -> Arc<GithubReleaseProvider> {
        self.github.clone()
    }
}

#[async_trait]
impl ReleaseProvider for CompositeReleaseProvider {
    async fn resolve(
        &self,
        port: &PortDefinition,
        channel: ReleaseChannel,
        platform: Platform,
    ) -> Result<ResolvedRelease> {
        match port.release.provider {
            ReleaseSource::Github => self.github.resolve(port, channel, platform).await,
            ReleaseSource::Gitlab => self.gitlab.resolve(port, channel, platform).await,
            ReleaseSource::DirectManifest => resolve_direct(port, channel, platform),
        }
    }
}

fn resolve_direct(
    port: &PortDefinition,
    channel: ReleaseChannel,
    platform: Platform,
) -> Result<ResolvedRelease> {
    if channel != ReleaseChannel::Stable || !port.channels.contains(&channel) {
        return Err(PortcoveError::unsupported(format!(
            "{} only offers its pinned stable release",
            port.name
        )));
    }
    let release = port.release.direct.get(&platform).ok_or_else(|| {
        PortcoveError::unsupported(format!(
            "{} has no pinned release for {platform:?}",
            port.name
        ))
    })?;
    let name = reqwest::Url::parse(&release.url)
        .ok()
        .and_then(|url| {
            url.path_segments()
                .and_then(|mut segments| segments.next_back())
                .map(str::to_owned)
        })
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| format!("{}-{}", port.id, release.version));
    Ok(ResolvedRelease {
        version: release.version.clone(),
        channel,
        published_at: release.published_at.clone(),
        asset: ReleaseAsset {
            name,
            url: release.url.clone(),
            size: release.size,
            sha256: release.sha256.to_ascii_lowercase(),
        },
    })
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use crate::{AdapterKind, DirectReleaseSpec, ReleaseSpec, SupportTier, UpstreamStatus};

    use super::*;

    #[test]
    fn direct_manifests_resolve_without_a_host_api() {
        let mut direct = BTreeMap::new();
        direct.insert(
            Platform::WindowsX86_64,
            DirectReleaseSpec {
                version: "1.0.0".into(),
                url: "https://downloads.example/game.zip".into(),
                size: 42,
                sha256: "A".repeat(64),
                published_at: None,
            },
        );
        let port = PortDefinition {
            id: "retired-game".into(),
            name: "Retired Game".into(),
            summary: String::new(),
            project_url: "https://example.invalid".into(),
            support_tier: SupportTier::Stable,
            channels: vec![ReleaseChannel::Stable],
            platforms: vec![Platform::WindowsX86_64],
            automated_tested_platforms: vec![],
            manually_validated_platforms: vec![],
            adapter: AdapterKind::N64RecompPortable,
            release: ReleaseSpec {
                provider: ReleaseSource::DirectManifest,
                repository: String::new(),
                rolling_tag: None,
                asset_hints: BTreeMap::new(),
                direct,
            },
            source_profile: None,
            bios_source_profile: None,
            executable_hints: BTreeMap::new(),
            persistent_paths: vec![],
            portable_marker: false,
            source_environment: None,
            launch_arguments: vec![],
            runtime_subdirectory: None,
            runtime_source_filename: None,
            runtime_source_materialization: None,
            runtime_source_set: Vec::new(),
            launch_from_install_root: false,
            setup_executable_hints: BTreeMap::new(),
            setup_arguments: vec![],
            setup_marker: None,
            upstream_status: UpstreamStatus::Retired,
        };
        let release =
            resolve_direct(&port, ReleaseChannel::Stable, Platform::WindowsX86_64).unwrap();
        assert_eq!(release.asset.name, "game.zip");
        assert_eq!(release.asset.sha256, "a".repeat(64));
    }
}
