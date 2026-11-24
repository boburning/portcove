use std::sync::Arc;

use async_trait::async_trait;

use crate::{
    ExactReleaseSelection, GithubReleaseProvider, GitlabReleaseProvider, Library, Platform,
    PortDefinition, PortcoveError, ReleaseAsset, ReleaseChannel, ReleaseProvider, ReleaseSource,
    ResolvedRelease, Result,
};

#[derive(Clone)]
pub struct CompositeReleaseProvider {
    github: Arc<GithubReleaseProvider>,
    gitlab: GitlabReleaseProvider,
    #[cfg(test)]
    forge_fixture: Option<(Library, String)>,
}

impl CompositeReleaseProvider {
    pub fn for_library(library: &Library) -> Result<Self> {
        Ok(Self {
            github: Arc::new(GithubReleaseProvider::for_library(library)?),
            gitlab: GitlabReleaseProvider::for_library(library)?,
            #[cfg(test)]
            forge_fixture: None,
        })
    }

    #[cfg(test)]
    pub(crate) fn with_forge_fixture(library: &Library, origin: &str) -> Result<Self> {
        crate::definition_acquisition::validate_fixture_origin(origin)?;
        let mut provider = Self::for_library(library)?;
        provider.forge_fixture = Some((library.clone(), origin.to_owned()));
        Ok(provider)
    }

    pub fn github(&self) -> Arc<GithubReleaseProvider> {
        self.github.clone()
    }

    pub(crate) fn gitlab(&self) -> GitlabReleaseProvider {
        self.gitlab.clone()
    }
}

#[async_trait]
impl ReleaseProvider for CompositeReleaseProvider {
    async fn review_exact(
        &self,
        port: &PortDefinition,
        channel: ReleaseChannel,
        platform: Platform,
        scope: Option<&crate::DefinitionAcquisitionScope>,
        version: &str,
    ) -> Result<ExactReleaseSelection> {
        match port.release.provider {
            ReleaseSource::Github => {
                self.github
                    .review_exact(port, channel, platform, scope, version)
                    .await
            }
            ReleaseSource::Gitlab => {
                self.gitlab
                    .review_exact(port, channel, platform, scope, version)
                    .await
            }
            ReleaseSource::DirectManifest => {
                let query = crate::release::ExactReleaseQuery::Review(version);
                query.require_route(
                    port,
                    channel,
                    platform,
                    ReleaseSource::DirectManifest,
                    scope,
                )?;
                let release = resolve_direct(port, channel, platform)?;
                query.bind(
                    port,
                    platform,
                    &release,
                    crate::ExactReleaseIdentity::DirectManifest,
                )
            }
            ReleaseSource::ReviewedForge => {
                Err(crate::release::reviewed_forge_exact_release_unsupported())
            }
            ReleaseSource::UserPrepared => Err(PortcoveError::unsupported(
                "a user-prepared runtime has no managed release selection",
            )),
        }
    }

    async fn resolve_exact(
        &self,
        port: &PortDefinition,
        channel: ReleaseChannel,
        platform: Platform,
        scope: Option<&crate::DefinitionAcquisitionScope>,
        pin: &ExactReleaseSelection,
    ) -> Result<crate::ScopedResolvedRelease> {
        match port.release.provider {
            ReleaseSource::Github => {
                self.github
                    .resolve_exact(port, channel, platform, scope, pin)
                    .await
            }
            ReleaseSource::Gitlab => {
                self.gitlab
                    .resolve_exact(port, channel, platform, scope, pin)
                    .await
            }
            ReleaseSource::DirectManifest => {
                pin.require_context(port, channel, platform, scope)?;
                let selected = resolve_direct(port, channel, platform)?;
                pin.require_artifact(&selected)?;
                crate::ScopedResolvedRelease::legacy(selected)
                    .for_selection(port, platform, channel)
            }
            ReleaseSource::ReviewedForge => {
                Err(crate::release::reviewed_forge_exact_release_unsupported())
            }
            ReleaseSource::UserPrepared => Err(PortcoveError::unsupported(
                "a user-prepared runtime has no managed release selection",
            )),
        }
    }

    async fn resolve_scoped(
        &self,
        port: &PortDefinition,
        channel: ReleaseChannel,
        platform: Platform,
        scope: Option<&crate::DefinitionAcquisitionScope>,
    ) -> Result<crate::ScopedResolvedRelease> {
        if port.release.managed_build.contains_key(&platform) {
            return Err(crate::cartridge_build::retired_creation());
        }
        if port.release.provider == ReleaseSource::ReviewedForge {
            let scope = scope.ok_or_else(crate::reviewed_forge::independent_admission_required)?;
            #[cfg(test)]
            let bound;
            #[cfg(test)]
            let scope = if let Some((library, origin)) = &self.forge_fixture {
                if library.root() != scope.library.root() {
                    return Err(PortcoveError::verification(
                        "forge fixture library does not match",
                    ));
                }
                let mut selected = scope.clone();
                selected.fixture_origin = Some(origin.clone());
                bound = selected;
                &bound
            } else {
                scope
            };
            let forge = scope
                .forge
                .as_ref()
                .ok_or_else(crate::reviewed_forge::independent_admission_required)?;
            return forge.resolve_scoped(scope, port, channel, platform).await;
        }
        match scope {
            scope if port.release.provider == ReleaseSource::Github => {
                self.github
                    .resolve_scoped(port, channel, platform, scope)
                    .await
            }
            Some(_) => Err(PortcoveError::unsupported(
                "provider has no qualified managed GitHub acquisition",
            )),
            None => self
                .resolve(port, channel, platform)
                .await
                .and_then(|release| {
                    crate::ScopedResolvedRelease::legacy(release)
                        .for_selection(port, platform, channel)
                }),
        }
    }

    async fn resolve_saved_variant(
        &self,
        port: &PortDefinition,
        channel: ReleaseChannel,
        platform: Platform,
        scope: Option<&crate::DefinitionAcquisitionScope>,
        variant: &crate::ManagedPackageVariant,
    ) -> Result<crate::ScopedResolvedRelease> {
        if port.release.provider == ReleaseSource::ReviewedForge {
            return Err(crate::reviewed_forge::independent_admission_required());
        }
        if port.release.managed_build.contains_key(&platform) {
            return Err(crate::cartridge_build::retired_creation());
        }
        self.github
            .resolve_saved_variant(port, channel, platform, scope, variant)
            .await
    }

    async fn resolve_explicit_first_variant(
        &self,
        port: &PortDefinition,
        channel: ReleaseChannel,
        platform: Platform,
        variant: &crate::ManagedPackageVariant,
    ) -> Result<crate::ScopedResolvedRelease> {
        if port.release.provider != ReleaseSource::Github {
            return Err(PortcoveError::unsupported(
                "the release provider cannot resolve an explicit native package",
            ));
        }
        self.github
            .resolve_explicit_first_variant(port, channel, platform, variant)
            .await
    }

    async fn resolve_shape_fallback(
        &self,
        port: &PortDefinition,
        platform: Platform,
        scope: Option<&crate::DefinitionAcquisitionScope>,
        withheld: &ResolvedRelease,
    ) -> Result<Option<crate::ScopedResolvedRelease>> {
        if port.release.provider != ReleaseSource::Github {
            return Ok(None);
        }
        if port.release.managed_build.contains_key(&platform) {
            return Err(crate::cartridge_build::retired_creation());
        }
        self.github
            .resolve_shape_fallback(port, platform, scope, withheld)
            .await
    }

    async fn forecast_request_cost(
        &self,
        port: &PortDefinition,
        platform: Platform,
        scoped: bool,
    ) -> Result<crate::RequestCostForecast> {
        match port.release.provider {
            ReleaseSource::Github => {
                self.github
                    .forecast_request_cost(port, platform, scoped)
                    .await
            }
            _ => Ok(crate::RequestCostForecast::default()),
        }
    }

    fn forecast_saved_variant_request_cost(&self, scoped: bool) -> crate::RequestCostForecast {
        // Saved package choices are GitHub inventories; the service asks only for them.
        self.github.forecast_saved_variant_request_cost(scoped)
    }

    fn forecast_explicit_variant_request_cost(&self) -> crate::RequestCostForecast {
        self.github.forecast_explicit_variant_request_cost()
    }

    fn ordinary_allowance(&self, port: &PortDefinition) -> Option<&'static str> {
        match port.release.provider {
            ReleaseSource::Github => self.github.ordinary_allowance(port),
            _ => None,
        }
    }

    fn cached_release_notes(
        &self,
        port: &PortDefinition,
        channel: ReleaseChannel,
        platform: Platform,
        installed: Option<&str>,
        offered: &str,
    ) -> Option<crate::UpdateReleaseNotes> {
        match port.release.provider {
            ReleaseSource::Github => self
                .github
                .cached_release_notes(port, channel, platform, installed, offered),
            ReleaseSource::Gitlab => self
                .gitlab
                .cached_release_notes(port, channel, platform, installed, offered),
            ReleaseSource::ReviewedForge
            | ReleaseSource::DirectManifest
            | ReleaseSource::UserPrepared => None,
        }
    }

    async fn resolve(
        &self,
        port: &PortDefinition,
        channel: ReleaseChannel,
        platform: Platform,
    ) -> Result<ResolvedRelease> {
        if port.release.managed_build.contains_key(&platform) {
            return Err(crate::cartridge_build::retired_creation());
        }
        match port.release.provider {
            ReleaseSource::Github => self.github.resolve(port, channel, platform).await,
            ReleaseSource::Gitlab => self.gitlab.resolve(port, channel, platform).await,
            ReleaseSource::ReviewedForge => {
                Err(crate::reviewed_forge::independent_admission_required())
            }
            ReleaseSource::DirectManifest => resolve_direct(port, channel, platform),
            ReleaseSource::UserPrepared => Err(PortcoveError::unsupported(format!(
                "{} has a user-prepared runtime; Portcove does not acquire it",
                port.name
            ))),
        }
    }
}

pub(crate) fn resolve_direct(
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
        uploader_continuity: None,
    })
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use crate::{AdapterKind, DirectReleaseSpec, ReleaseSpec, SupportTier, UpstreamStatus};

    use super::*;

    /// The provider desktop and CLI use must forecast its GitHub ports, not report
    /// the trait default of nothing.
    #[tokio::test]
    async fn the_composite_provider_forecasts_through_its_github_provider() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path()).unwrap();
        let composite = CompositeReleaseProvider::for_library(&library).unwrap();
        let catalog = crate::Catalog::embedded().unwrap();
        let port = catalog
            .ports()
            .iter()
            .find(|port| port.release.provider == ReleaseSource::Github)
            .unwrap();
        let platform = Platform::WindowsX86_64;
        assert_eq!(
            composite
                .forecast_request_cost(port, platform, false)
                .await
                .unwrap(),
            composite
                .github()
                .forecast_request_cost(port, platform, false)
                .await
                .unwrap(),
        );
        // A cold ordinary check reads at least the repository and one releases page.
        assert!(
            composite
                .forecast_request_cost(port, platform, false)
                .await
                .unwrap()
                .counted_requests
                >= 2
        );
        assert_eq!(
            composite.forecast_saved_variant_request_cost(true),
            composite.github().forecast_saved_variant_request_cost(true)
        );
        let mut gitlab = port.clone();
        gitlab.release.provider = ReleaseSource::Gitlab;
        assert_eq!(
            composite
                .forecast_request_cost(&gitlab, platform, false)
                .await
                .unwrap(),
            crate::RequestCostForecast::default()
        );
    }

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
                managed_build: BTreeMap::new(),
                curated: BTreeMap::new(),
                provider: ReleaseSource::DirectManifest,
                repository: String::new(),
                rolling_tag: None,
                github_other_stream_tag_prefixes: BTreeMap::new(),
                asset_hints: BTreeMap::new(),
                reviewed_package_choices_v2: None,
                linux_tar_xz: false,
                tar_xz_platforms: Vec::new(),
                archive_file_links: false,
                grant_declared_executable: false,
                direct,
                user_prepared: BTreeMap::new(),
                accepted_uploaders: Vec::new(),
            },
            bundled_runtime: BTreeMap::new(),
            source_profile: None,
            bios_source_profile: None,
            executable_hints: BTreeMap::new(),
            persistent_paths: vec![],
            persistent_file_patterns: vec![],
            archive_data_compatibility_v1: None,
            archive_data_transition_v1: None,
            runtime_mutable_paths: vec![],
            runtime_mutable_file_patterns: vec![],
            windows_runtime_path_policy: None,
            windows_temp_directory: None,
            portable_marker: false,
            portable_marker_file: None,
            linux_portable_data_directory: None,
            n64_windows_initial_d3d12: false,
            n64_runtime_at_executable_parent: false,
            managed_initialization: None,
            runtime_data_policy: None,
            external_profile_policy: None,
            mod_package_policy: None,
            game_settings: None,
            windows_shipwright_persistence: false,
            windows_tracked_handoff: false,
            linux_packaged_library: None,
            managed_shared_preferences: None,
            managed_shared_preferences_save_id: None,
            managed_runtime_applies_to: None,
            source_environment: None,
            user_data_environment: None,
            launch_environment: BTreeMap::new(),
            launch_arguments: vec![],
            reviewed_launch_contract_v1: None,
            runtime_subdirectory: None,
            runtime_subdirectory_by_platform: BTreeMap::new(),
            runtime_source_filename: None,
            runtime_source_materialization: None,
            launch_disc_choice: None,
            runtime_source_hashes: BTreeMap::new(),
            runtime_disc_image: None,
            runtime_stfs_package: None,
            runtime_rom_patch: None,
            optional_game_source: false,
            runtime_source_set: Vec::new(),
            launch_from_install_root: false,
            setup_executable_hints: BTreeMap::new(),
            setup_arguments: vec![],
            setup_marker: None,
            setup_output_paths: vec![],
            upstream_status: UpstreamStatus::Retired,
            upstream_active_reviewed: false,
            mod_provider_bindings: None,
            legacy_mod_provider_held: false,
            mod_sources: Vec::new(),
            mod_loader: None,
            managed_acquisition_hold: None,
            reviewed_package_layouts: BTreeMap::new(),
            reviewed_predecessor_package_layouts_v1: BTreeMap::new(),
            presentation: None,
        };
        let release =
            resolve_direct(&port, ReleaseChannel::Stable, Platform::WindowsX86_64).unwrap();
        assert_eq!(release.asset.name, "game.zip");
        assert_eq!(release.asset.sha256, "a".repeat(64));
    }
}

#[cfg(test)]
mod exact_tests;
