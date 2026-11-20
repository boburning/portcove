//! An exact reviewed native-package family recorded in an installation manifest.
//! The package's shape comes from two authored selectors covering the entire
//! filename around the provider's exact release tag.

use serde::{Deserialize, Serialize};

use crate::{AdapterKind, Platform, PortDefinition, PortcoveError, ReleaseChannel, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum ExecutionMode {
    Native,
}

/// Core passes this opaque evidence from a verified installed manifest to the
/// resolver. It narrows normal eligibility and supplies no acquisition trust.
#[doc(hidden)]
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ManagedPackageVariant {
    format_version: u32,
    channel: ReleaseChannel,
    platform: Platform,
    execution_mode: ExecutionMode,
    repository_id: u64,
    source_profile: Option<String>,
    prefix: String,
    suffix: String,
}

fn numeric_version(tag: &str) -> Option<&str> {
    let digits = tag.strip_prefix(['v', 'V']).unwrap_or(tag);
    let mut parts = digits.split('.');
    (digits.len() <= 32
        && parts.clone().count() == 3
        && parts.all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit())))
    .then_some(digits)
}

fn reviewed_version(tag: &str, channel: ReleaseChannel) -> Option<&str> {
    if let Some(version) = numeric_version(tag) {
        return Some(version);
    }
    if channel != ReleaseChannel::Beta || tag.len() > 48 {
        return None;
    }
    let token = tag.strip_prefix(['v', 'V']).unwrap_or(tag);
    let (version, prerelease) = token.split_once('-')?;
    if numeric_version(version) != Some(version) {
        return None;
    }
    let family = match prerelease.split_once('.') {
        Some((family, number))
            if !number.is_empty()
                && number.len() <= 8
                && number.bytes().all(|byte| byte.is_ascii_digit())
                && (number.len() == 1 || !number.starts_with('0')) =>
        {
            family
        }
        Some(_) => return None,
        None => prerelease,
    };
    ["alpha", "beta", "rc"]
        .into_iter()
        .any(|supported| family.eq_ignore_ascii_case(supported))
        .then_some(token)
}

fn reviewed_anchors(port: &PortDefinition, platform: Platform) -> Option<(&str, &str)> {
    if !matches!(
        port.adapter,
        AdapterKind::NativePortable | AdapterKind::StagedSourcePortable
    ) || port.release.provider != crate::ReleaseSource::Github
        || port.release.rolling_tag.is_some()
        || port.release.curated.contains_key(&platform)
        || port.bundled_runtime.contains_key(&platform)
    {
        return None;
    }
    let [prefix, suffix] = port.release.asset_hints.get(&platform)?.as_slice() else {
        return None;
    };
    let bounded_name = |value: &str| {
        !value.is_empty()
            && value.len() <= 120
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
    };
    (bounded_name(prefix) && bounded_name(suffix) && suffix.starts_with(['-', '_']))
        .then_some((prefix, suffix))
}

fn reviewed_name(
    port: &PortDefinition,
    platform: Platform,
    channel: ReleaseChannel,
    tag: &str,
    filename: &str,
) -> Option<(String, String)> {
    let (prefix, suffix) = reviewed_anchors(port, platform)?;
    let prefix = prefix.to_ascii_lowercase();
    let suffix = suffix.to_ascii_lowercase();
    let version = reviewed_version(tag, channel)?;
    let filename = filename.to_ascii_lowercase();
    let slot = filename.strip_prefix(&prefix)?.strip_suffix(&suffix)?;
    slot.strip_prefix('v')
        .unwrap_or(slot)
        .eq_ignore_ascii_case(version)
        .then_some((prefix, suffix))
}

impl ManagedPackageVariant {
    pub(crate) fn can_record(
        port: &PortDefinition,
        platform: Platform,
        release: &crate::ResolvedRelease,
    ) -> bool {
        reviewed_name(
            port,
            platform,
            release.channel,
            &release.version,
            &release.asset.name,
        )
        .is_some()
    }

    pub(crate) fn from_review(
        port: &PortDefinition,
        platform: Platform,
        release: &crate::ScopedResolvedRelease,
    ) -> Option<Self> {
        // A Core preview is not enough on its own. Only the provider can bind
        // the reviewed bytes to the exact repository, tag and asset IDs.
        release
            .require_selection(port, platform, release.release.channel)
            .ok()?;
        Self::from_github_package(
            port,
            platform,
            release.release.channel,
            &release.release.version,
            &release.release.asset.name,
            release.github_identity.as_ref()?,
        )
    }

    pub(crate) fn from_retained_prerelease(
        port: &PortDefinition,
        platform: Platform,
        install: &crate::InstallRecord,
        identity: &crate::definition_acquisition::GithubArtifactIdentity,
    ) -> Option<Self> {
        if Self::supports_manifest_receipt(&install.version) {
            return None;
        }
        Self::from_github_package(
            port,
            platform,
            install.channel,
            &install.version,
            &install.artifact.asset_name,
            identity,
        )
    }

    fn from_github_package(
        port: &PortDefinition,
        platform: Platform,
        channel: ReleaseChannel,
        tag: &str,
        filename: &str,
        identity: &crate::definition_acquisition::GithubArtifactIdentity,
    ) -> Option<Self> {
        if identity.validate().is_err()
            || !port.channels.contains(&channel)
            || !port.platforms.contains(&platform)
            || !identity
                .repository
                .eq_ignore_ascii_case(&port.release.repository)
            || identity.tag != tag
        {
            return None;
        }
        let (prefix, suffix) = reviewed_name(port, platform, channel, tag, filename)?;
        Some(Self {
            format_version: 1,
            channel,
            platform,
            execution_mode: ExecutionMode::Native,
            repository_id: identity.repository_id,
            source_profile: port.source_profile.clone(),
            prefix,
            suffix,
        })
    }

    pub(crate) fn supports_manifest_receipt(tag: &str) -> bool {
        // Older readers expect a numeric tag when this manifest receipt is set.
        // Suffixed installations recover the choice from their acquisition facts.
        numeric_version(tag).is_some()
    }

    pub(crate) fn repository_id(&self) -> u64 {
        self.repository_id
    }

    pub(crate) fn matches(&self, tag: &str, filename: &str) -> bool {
        let Some(version) = reviewed_version(tag, self.channel) else {
            return false;
        };
        let name = filename.to_ascii_lowercase();
        name.strip_prefix(&self.prefix)
            .and_then(|name| name.strip_suffix(&self.suffix))
            .is_some_and(|slot| {
                slot.strip_prefix('v')
                    .unwrap_or(slot)
                    .eq_ignore_ascii_case(version)
            })
    }

    pub(crate) fn require_contract(
        &self,
        port: &PortDefinition,
        channel: ReleaseChannel,
        platform: Platform,
    ) -> Result<()> {
        if self.format_version != 1
            || self.channel != channel
            || self.platform != platform
            || self.repository_id == 0
            || self.source_profile != port.source_profile
            || !reviewed_anchors(port, platform).is_some_and(|(prefix, suffix)| {
                self.prefix.eq_ignore_ascii_case(prefix) && self.suffix.eq_ignore_ascii_case(suffix)
            })
        {
            return Err(PortcoveError::conflict(
                "the saved native package choice differs from the current release contract; review the installed version before changing packages",
            ).detail("saved_package_variant", "changed-contract"));
        }
        Ok(())
    }

    pub(crate) fn require_installed(
        &self,
        install: &crate::InstallRecord,
        platform: Option<Platform>,
    ) -> Result<()> {
        if self.format_version != 1
            || self.channel != install.channel
            || Some(self.platform) != platform
            || !self.matches(&install.version, &install.artifact.asset_name)
        {
            return Err(PortcoveError::verification(
                "saved package choice differs from the installed package identity",
            ));
        }
        Ok(())
    }
}
