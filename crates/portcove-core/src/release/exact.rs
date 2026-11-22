use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::*;

/// An exact release and package chosen for one port, channel and platform.
/// Only the configured provider can supply their current metadata and download URL.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
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

/// Why Core cannot use a port's saved release pin as written.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum ExactReleaseHoldReason {
    /// The saved pin cannot be read or lacks a valid package identity.
    Unreadable,
    /// The saved pin was made for a different channel than the port follows.
    ChannelMismatch,
}

/// A saved release pin Core cannot use. Update checks and installs for this
/// port stay held instead of silently following the channel; choosing Follow
/// clears it. Other ports are unaffected.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ExactReleaseHold {
    pub reason: ExactReleaseHoldReason,
    /// Technical cause for diagnosis; never player copy.
    pub detail: String,
}

impl ExactReleaseHold {
    pub(crate) fn refusal(&self, port_id: &str) -> PortcoveError {
        PortcoveError::conflict(format!(
            "the saved exact release cannot be used: {}",
            self.detail
        ))
        .detail("port_id", port_id)
        .with_known_cause(crate::failure::KnownFailureCause::ExactRelease(
            match self.reason {
                ExactReleaseHoldReason::Unreadable => ExactReleaseRefusal::PinUnreadable,
                ExactReleaseHoldReason::ChannelMismatch => ExactReleaseRefusal::PinChannelChanged,
            },
        ))
    }
}

/// Player-facing causes of an exact-release refusal. Core owns the wording.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ExactReleaseRefusal {
    /// A restriction holds this artifact; carries the restriction's explanation.
    Held(String),
    /// The release is not published in the saved channel and platform stream.
    OutsideChannel,
    /// The release, library state or pin changed after the review.
    ReviewChanged,
    /// The command named a channel other than the one the pin was made for.
    ChannelDiffers,
    PinUnreadable,
    PinChannelChanged,
}

impl ExactReleaseRefusal {
    /// Keeps a refusal's technical message and adds the player's reason.
    pub(crate) fn attach(self, error: PortcoveError) -> PortcoveError {
        error.with_known_cause(crate::failure::KnownFailureCause::ExactRelease(self))
    }

    /// A restriction refusal at review, explained with the hold's own text.
    pub(crate) fn held(error: PortcoveError) -> PortcoveError {
        let explanation = error.message.clone();
        Self::Held(explanation).attach(error)
    }

    pub(crate) fn presentation(&self) -> (&'static str, String) {
        match self {
            Self::Held(explanation) => (
                "exact_release_held",
                format!(
                    "Portcove can't pin this release because it is held. {explanation} Choose a different release or keep following the channel."
                ),
            ),
            Self::OutsideChannel => (
                "exact_release_outside_channel",
                "This release isn't published in this game's selected channel for this computer. Choose a release from that channel, or change the channel first.".into(),
            ),
            Self::ReviewChanged => (
                "exact_release_review_changed",
                "The release or this game's saved settings changed after the review. Review the release again before pinning it.".into(),
            ),
            Self::ChannelDiffers => (
                "exact_release_channel_differs",
                "This game is pinned to a release from its saved channel. Choose Follow channel before using a different channel.".into(),
            ),
            Self::PinUnreadable => (
                "exact_release_unreadable",
                "Portcove can't read this game's saved release pin, so it won't check for or install updates for this game. Choose Follow channel to clear the pin.".into(),
            ),
            Self::PinChannelChanged => (
                "exact_release_channel_changed",
                "This game's saved release pin belongs to a different channel, so Portcove won't check for or install updates for this game. Choose Follow channel to clear the pin.".into(),
            ),
        }
    }
}

#[derive(Clone, Copy)]
pub(crate) enum ExactReleaseQuery<'a> {
    Review(&'a str),
    Saved(&'a ExactReleaseSelection),
}

impl<'a> ExactReleaseQuery<'a> {
    pub(crate) fn version(self) -> &'a str {
        match self {
            Self::Review(version) => version,
            Self::Saved(pin) => &pin.version,
        }
    }

    pub(crate) fn expected(self) -> Option<&'a ExactReleaseSelection> {
        match self {
            Self::Saved(pin) => Some(pin),
            Self::Review(_) => None,
        }
    }

    pub(crate) fn require_route(
        self,
        port: &PortDefinition,
        channel: ReleaseChannel,
        platform: Platform,
        expected_provider: crate::ReleaseSource,
        scope: Option<&crate::DefinitionAcquisitionScope>,
    ) -> Result<()> {
        require_exact_release_route(port, channel, platform, expected_provider, scope)?;
        require_version(
            self.version(),
            expected_provider != crate::ReleaseSource::DirectManifest,
        )
    }

    pub(crate) fn bind(
        self,
        port: &PortDefinition,
        platform: Platform,
        release: &ResolvedRelease,
        identity: ExactReleaseIdentity,
    ) -> Result<ExactReleaseSelection> {
        let candidate = ExactReleaseSelection {
            port_id: port.id.clone(),
            platform,
            channel: release.channel,
            version: release.version.clone(),
            filename: release.asset.name.clone(),
            size: release.asset.size,
            sha256: release.asset.sha256.to_ascii_lowercase(),
            identity,
        };
        candidate.require_context(port, release.channel, platform, None)?;
        if candidate.version != self.version()
            || self
                .expected()
                .is_some_and(|expected| !candidate.same_artifact(expected))
        {
            return Err(PortcoveError::verification(
                "the published release or package differs from the exact selection",
            ));
        }
        Ok(candidate)
    }
}

pub(crate) fn require_exact_release_route(
    port: &PortDefinition,
    channel: ReleaseChannel,
    platform: Platform,
    expected_provider: crate::ReleaseSource,
    scope: Option<&crate::DefinitionAcquisitionScope>,
) -> Result<()> {
    if port.release.provider != expected_provider
        || !port.channels.contains(&channel)
        || !port.platforms.contains(&platform)
    {
        return Err(PortcoveError::verification(
            "the exact release selection does not match this provider, channel and platform",
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
    // Route-wide managed holds stop before any provider request. A hold that
    // names exact artifacts cannot be decided until the package is known; the
    // review and every install recheck it with the observed version and digest.
    crate::acquisition_restriction::EffectiveRestrictions::managed_only(port).require(
        &crate::acquisition_restriction::RestrictionSubject::deferred(
            crate::acquisition_restriction::RestrictedOperation::Install,
        )
        .on(platform),
    )?;
    if expected_provider == crate::ReleaseSource::UserPrepared {
        return Err(PortcoveError::unsupported(
            "a user-prepared runtime has no managed release selection",
        ));
    }
    Ok(())
}

fn require_version(version: &str, hosted: bool) -> Result<()> {
    if version.is_empty()
        || version.len() > 255
        || version.chars().any(|c| c.is_control() || c == '\\')
        || (hosted
            && version
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == ".."))
    {
        return Err(PortcoveError::verification(
            "the exact release has an invalid tag or version",
        ));
    }
    Ok(())
}

pub(crate) fn is_published(published_at: Option<&str>) -> bool {
    published_at
        .and_then(|value| {
            time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339).ok()
        })
        .is_some_and(|instant| instant <= time::OffsetDateTime::now_utc())
}

impl ExactReleaseIdentity {
    fn provider(&self) -> crate::ReleaseSource {
        match self {
            Self::Github { .. } => crate::ReleaseSource::Github,
            Self::Gitlab { .. } => crate::ReleaseSource::Gitlab,
            Self::DirectManifest => crate::ReleaseSource::DirectManifest,
        }
    }

    fn valid(&self) -> bool {
        let valid_commit = |sha: &str| {
            sha.len() == 40
                && sha
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        };
        match self {
            Self::Github {
                repository_id,
                release_id,
                asset_id,
                commit_sha1,
            } => {
                *repository_id > 0 && *release_id > 0 && *asset_id > 0 && valid_commit(commit_sha1)
            }
            Self::Gitlab {
                project_id,
                link_id,
                package_file_id,
                commit_sha1,
            } => {
                *project_id > 0 && *link_id > 0 && *package_file_id > 0 && valid_commit(commit_sha1)
            }
            Self::DirectManifest => true,
        }
    }
}

impl ExactReleaseSelection {
    pub(crate) fn require_context(
        &self,
        port: &PortDefinition,
        channel: ReleaseChannel,
        platform: Platform,
        scope: Option<&crate::DefinitionAcquisitionScope>,
    ) -> Result<()> {
        self.require_persisted(&port.id, channel)?;
        if self.platform != platform {
            return Err(PortcoveError::verification(
                "the saved exact release belongs to a different platform",
            ));
        }
        ExactReleaseQuery::Saved(self).require_route(
            port,
            channel,
            platform,
            self.identity.provider(),
            scope,
        )
    }

    pub(crate) fn require_persisted(&self, port_id: &str, channel: ReleaseChannel) -> Result<()> {
        if self.port_id != port_id || self.channel != channel {
            return Err(PortcoveError::verification(
                "the saved exact release belongs to a different port or channel",
            ));
        }
        require_version(
            &self.version,
            self.identity.provider() != crate::ReleaseSource::DirectManifest,
        )?;
        crate::archive::validate_relative_path(&self.filename, false)?;
        crate::archive::validate_download_progress(0, self.size)?;
        if self.filename.is_empty()
            || self.filename.len() > 255
            || self.filename.contains(['/', '\\'])
            || self.filename.to_ascii_lowercase().starts_with(".portcove-")
            || self.size == 0
            || !is_sha256(&self.sha256)
            || !self.identity.valid()
        {
            return Err(PortcoveError::verification(
                "the exact release selection lacks valid artifact identity or SHA-256",
            ));
        }
        Ok(())
    }

    pub(crate) fn decode(
        port_id: &str,
        channel: ReleaseChannel,
        json: Option<&str>,
    ) -> Result<Option<Self>> {
        json.map(|json| {
            let pin: Self = serde_json::from_str(json)?;
            pin.require_persisted(port_id, channel)?;
            Ok(pin)
        })
        .transpose()
    }

    /// Reads one port's stored pin without letting it fail anything else:
    /// a pin Core cannot use becomes that port's hold.
    pub(crate) fn decode_or_hold(
        port_id: &str,
        channel: ReleaseChannel,
        json: Option<&str>,
    ) -> std::result::Result<Option<Self>, ExactReleaseHold> {
        Self::decode(port_id, channel, json).map_err(|error| {
            let mismatched = json
                .and_then(|json| serde_json::from_str::<Self>(json).ok())
                .is_some_and(|pin| {
                    pin.port_id == port_id
                        && pin.channel != channel
                        && pin.require_persisted(port_id, pin.channel).is_ok()
                });
            ExactReleaseHold {
                reason: if mismatched {
                    ExactReleaseHoldReason::ChannelMismatch
                } else {
                    ExactReleaseHoldReason::Unreadable
                },
                detail: crate::failure::redact_diagnostic_text(&error.message),
            }
        })
    }

    pub(crate) fn require_saved_variant(
        &self,
        port: &PortDefinition,
        variant: &ManagedPackageVariant,
    ) -> Result<Option<String>> {
        variant.require_contract(port, self.channel, self.platform)?;
        let ExactReleaseIdentity::Github {
            repository_id,
            commit_sha1,
            ..
        } = &self.identity
        else {
            return Err(PortcoveError::conflict(
                "the exact selection differs from the installed package choice",
            ));
        };
        if *repository_id != variant.repository_id()
            || !variant.matches(&self.version, &self.filename)
        {
            return Err(PortcoveError::conflict(
                "the exact selection differs from the installed package choice",
            ));
        }
        if variant.requires_explicit_proof() {
            variant.require_tag_commit(&self.version, &self.filename, commit_sha1)?;
            return Ok(Some(commit_sha1.clone()));
        }
        Ok(None)
    }

    fn same_artifact(&self, expected: &Self) -> bool {
        self.identity == expected.identity
            && self.port_id == expected.port_id
            && self.platform == expected.platform
            && self.channel == expected.channel
            && self.version == expected.version
            && self.filename == expected.filename
            && self.size == expected.size
            && self.sha256.eq_ignore_ascii_case(&expected.sha256)
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
        query: ExactReleaseQuery<'_>,
    ) -> Result<(ResolvedGithub, ExactReleaseSelection)> {
        let tag = query.version();
        let expected = query.expected();
        let repository_url = format!("{}/repos/{}", self.api_root, port.release.repository);
        let repository: GithubRepository = self.get_json(&repository_url).await?;
        let repository_id = repository.id.filter(|id| *id > 0).ok_or_else(|| {
            PortcoveError::verification("the GitHub repository has no stable identity")
        })?;
        if expected.is_some_and(|pin| !matches!(&pin.identity,
            ExactReleaseIdentity::Github { repository_id: previous, .. } if *previous == repository_id
        )) {
            return Err(PortcoveError::verification(
                "the exact selection's GitHub repository identity changed",
            ));
        }
        let mut tag_url = reqwest::Url::parse(&repository_url)
            .map_err(|error| PortcoveError::state(error.to_string()))?;
        tag_url
            .path_segments_mut()
            .map_err(|_| PortcoveError::state("invalid GitHub release URL"))?
            .extend(["releases", "tags", tag]);
        let mut release: GithubRelease = self.get_json(tag_url.as_str()).await?;
        let release_id = fresh_release_id(&release)?;
        if release.tag_name != tag || expected.is_some_and(|pin| {
            !matches!(&pin.identity,
                ExactReleaseIdentity::Github { release_id: previous, .. } if *previous == release_id
            )
        }) {
            return Err(PortcoveError::verification(
                "the exact selection's GitHub release identity changed",
            ));
        }
        if select_github_release_index(
            std::slice::from_ref(&release),
            port,
            channel,
            platform,
            |release| !release.draft && is_published(release.published_at.as_deref()),
        )
        .is_none()
        {
            return Err(PortcoveError::unsupported(
                "the exact GitHub release is not published in this channel and platform stream",
            )
            .with_known_cause(crate::failure::KnownFailureCause::ExactRelease(
                ExactReleaseRefusal::OutsideChannel,
            )));
        }
        let mut refresh = SavedReleaseAssetRefresh {
            refreshed: Default::default(),
            deadline: tokio::time::Instant::now() + self.network_bounds.request,
        };
        release.assets = self
            .saved_release_assets(&port.release.repository, &release, None, &mut refresh)
            .await?;
        let asset = choose_asset(port, platform, &release.assets)?;
        let asset_id = asset
            .id
            .expect("complete inventory requires a stable asset ID");
        if expected.is_some_and(|pin| {
            pin.filename != asset.name
                || pin.size != asset.size
                || !matches!(&pin.identity,
                    ExactReleaseIdentity::Github { asset_id: previous, .. } if *previous == asset_id
                )
        }) {
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
            .extend(["releases", "download", tag, &asset.name]);
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
        if expected.is_some_and(|pin| !sha256.eq_ignore_ascii_case(&pin.sha256)) {
            return Err(PortcoveError::verification(
                "the exact selection's GitHub package SHA-256 changed",
            ));
        }
        let commit_sha1 = self.github_tag_commit(port, tag, None).await?;
        if expected.is_some_and(|pin| !matches!(&pin.identity,
            ExactReleaseIdentity::Github { commit_sha1: previous, .. } if previous == &commit_sha1
        )) {
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
            repository_id,
            release_id,
            asset_id,
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
        let pin = query.bind(
            port,
            platform,
            &selected,
            ExactReleaseIdentity::Github {
                repository_id,
                release_id,
                asset_id,
                commit_sha1,
            },
        )?;
        Ok((
            ResolvedGithub {
                release: selected,
                identity: Some(identity),
                explicit_tag_commit: None,
                activity: Some(repository.activity(&port.release.repository)),
                fallback_reason: None,
            },
            pin,
        ))
    }
}
