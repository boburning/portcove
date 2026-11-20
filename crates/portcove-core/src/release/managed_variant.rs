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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    explicit_id: Option<String>,
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
    pub(crate) fn validate_explicit_choices(port: &PortDefinition) -> Result<()> {
        let Some(choices) = &port.release.reviewed_package_choices_v2 else {
            return Ok(());
        };
        let target = Platform::WindowsX86_64;
        let mut suffixes = std::collections::BTreeSet::new();
        if port.adapter != AdapterKind::NativePortable
            || port.release.provider != crate::ReleaseSource::Github
            || !port.platforms.contains(&target)
            || !port.channels.contains(&ReleaseChannel::Stable)
            || port.release.rolling_tag.is_some()
            || port.release.curated.contains_key(&target)
            || port.bundled_runtime.contains_key(&target)
            || !(1..=9_007_199_254_740_991).contains(&choices.repository_id)
            || choices.prefix.is_empty()
            || choices.prefix.len() > 70
            || !choices.prefix.bytes().all(|byte| {
                byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'-' | b'_')
            })
            || !(2..=4).contains(&choices.choices.len())
            || choices.choices.iter().any(|(id, suffix)| {
                id.is_empty()
                    || id.len() > 32
                    || !id.split('-').all(|part| {
                        !part.is_empty()
                            && part
                                .bytes()
                                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
                    })
                    || suffix != &format!("_win-{id}.zip")
                    || !suffixes.insert(suffix)
            })
        {
            return Err(PortcoveError::verification(
                "reviewed package choices must name distinct native Windows Stable archive families",
            )
            .detail("port_id", &port.id));
        }
        Ok(())
    }

    pub(crate) fn explicit(
        port: &PortDefinition,
        platform: Platform,
        channel: ReleaseChannel,
        id: &str,
    ) -> Result<Self> {
        Self::validate_explicit_choices(port)?;
        let choices = port.release.reviewed_package_choices_v2.as_ref();
        let Some((choices, suffix)) =
            choices.and_then(|choices| choices.choices.get(id).map(|suffix| (choices, suffix)))
        else {
            return Err(PortcoveError::unsupported(
                "no reviewed package choice matches that ID",
            ));
        };
        if platform != Platform::WindowsX86_64 || channel != ReleaseChannel::Stable {
            return Err(PortcoveError::unsupported(
                "reviewed package choices require the native Windows Stable route",
            ));
        }
        Ok(Self {
            format_version: 2,
            channel,
            platform,
            execution_mode: ExecutionMode::Native,
            repository_id: choices.repository_id,
            source_profile: port.source_profile.clone(),
            prefix: choices.prefix.clone(),
            suffix: suffix.clone(),
            explicit_id: Some(id.to_owned()),
        })
    }

    pub(crate) fn explicit_id(&self) -> Option<&str> {
        self.explicit_id.as_deref()
    }

    pub(crate) fn requires_explicit_proof(&self) -> bool {
        self.format_version == 2 || self.explicit_id.is_some()
    }

    pub(crate) fn names_explicit_family(&self, name: &str) -> bool {
        let name = name.to_ascii_lowercase();
        self.explicit_id.is_some() && name.starts_with(&self.prefix) && name.ends_with(&self.suffix)
    }

    pub(crate) fn require_tag_commit(&self, tag: &str, name: &str, commit: &str) -> Result<()> {
        if self.format_version != 2
            || !self.matches(tag, name)
            || !lower_hex(commit, 40)
            || !self
                .tag_prefix(tag, name)
                .is_some_and(|prefix| commit.starts_with(prefix))
        {
            return Err(PortcoveError::verification(
                "saved package name does not match the exact upstream tag commit",
            ));
        }
        Ok(())
    }

    fn tag_prefix<'a>(&self, tag: &str, name: &'a str) -> Option<&'a str> {
        let version = numeric_version(tag)?;
        let (slot, commit) = name
            .strip_prefix(&self.prefix)?
            .strip_suffix(&self.suffix)?
            .split_once("-git+")?;
        (slot == version && lower_hex(commit, 7)).then_some(commit)
    }

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
            explicit_id: None,
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
        if self.format_version == 2 {
            return self.explicit_id.is_some() && self.tag_prefix(tag, filename).is_some();
        }
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
        if self.format_version == 2
            && let Some(id) = self.explicit_id()
            && Self::explicit(port, platform, channel, id).is_ok_and(|reviewed| reviewed == *self)
        {
            return Ok(());
        }
        if self.format_version != 1
            || self.explicit_id.is_some()
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
        if !matches!(
            (self.format_version, self.explicit_id.is_some()),
            (1, false) | (2, true)
        ) || self.channel != install.channel
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

fn lower_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reviewed_fixture() -> PortDefinition {
        let mut port = crate::Catalog::embedded()
            .unwrap()
            .port("jagged-alliance-2-ja2-stracciatella")
            .unwrap()
            .clone();
        port.release.reviewed_package_choices_v2 = Some(crate::ReviewedPackageChoicesV2 {
            repository_id: 51_711_866,
            prefix: "ja2-stracciatella_".into(),
            choices: [
                ("msvc64-142".into(), "_win-msvc64-142.zip".into()),
                ("mingw64-cross".into(), "_win-mingw64-cross.zip".into()),
            ]
            .into(),
        });
        port
    }

    #[test]
    fn explicit_package_choice_binds_real_tag_commit_without_making_it_the_stable_choice() {
        let platform = Platform::WindowsX86_64;
        let channel = ReleaseChannel::Stable;
        let port = reviewed_fixture();
        let variant =
            ManagedPackageVariant::explicit(&port, platform, channel, "mingw64-cross").unwrap();
        assert!(variant.require_contract(&port, channel, platform).is_ok());
        let first = "ja2-stracciatella_0.22.0-git+b195e15_win-mingw64-cross.zip";
        let next = "ja2-stracciatella_0.22.1-git+11e9430_win-mingw64-cross.zip";
        let first_commit = "b195e15ab9f1f5c8bc17d1e86965d2f66b6ecbb3";
        let next_commit = "11e9430b67d788b73f7a57d22166e8b500c23dab";
        variant
            .require_tag_commit("v0.22.0", first, first_commit)
            .unwrap();
        variant
            .require_tag_commit("v0.22.1", next, next_commit)
            .unwrap();
        assert!(
            variant
                .require_tag_commit("v0.22.1", next, first_commit)
                .is_err()
        );
        assert!(!variant.matches("v0.22.1", &next.replace("mingw64-cross", "msvc64-142")));
        assert!(!variant.matches("v0.22.1", &next.replace(".zip", ".exe")));
        assert!(!variant.matches("v0.22.1", &next.replace("11e9430", "11e943011223")));
        let restored: ManagedPackageVariant =
            serde_json::from_slice(&serde_json::to_vec(&variant).unwrap()).unwrap();
        assert_eq!(restored, variant);
        assert!(!variant.matches("v0.22.1", first));
    }

    #[test]
    fn explicit_package_choices_refuse_unreviewed_targets_and_changed_boundaries() {
        let mut port = reviewed_fixture();
        let approved = ManagedPackageVariant::explicit(
            &port,
            Platform::WindowsX86_64,
            ReleaseChannel::Stable,
            "msvc64-142",
        )
        .unwrap();
        for (platform, channel, id) in [
            (Platform::LinuxX86_64, ReleaseChannel::Stable, "msvc64-142"),
            (Platform::WindowsX86_64, ReleaseChannel::Beta, "msvc64-142"),
            (Platform::WindowsX86_64, ReleaseChannel::Stable, "msvc32"),
        ] {
            assert!(ManagedPackageVariant::explicit(&port, platform, channel, id).is_err());
        }
        port.release
            .reviewed_package_choices_v2
            .as_mut()
            .unwrap()
            .repository_id += 1;
        assert!(
            approved
                .require_contract(&port, ReleaseChannel::Stable, Platform::WindowsX86_64)
                .is_err()
        );
        port.release
            .reviewed_package_choices_v2
            .as_mut()
            .unwrap()
            .choices
            .insert("unsafe".into(), "../setup.exe".into());
        assert!(ManagedPackageVariant::validate_explicit_choices(&port).is_err());
    }
}
