use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use crate::{AdapterKind, Platform, PortDefinition, PortcoveError, ReleaseSource, Result};

const MAX_TERMS: usize = 12;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ReviewedLaunchContractV1 {
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub asset_rules: BTreeMap<Platform, AssetRules>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub package_format: BTreeMap<Platform, PackageFormat>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub launch: BTreeMap<Platform, LaunchValues>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AssetRules {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub include: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub exclude: Vec<String>,
    /// An exact tag or a literal tag prefix ending in a single asterisk.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tag_pattern: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prerelease: Option<PrereleaseRule>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum PrereleaseRule {
    Flag,
    Markers,
    Never,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub enum PackageFormat {
    #[serde(rename = "zip")]
    Zip,
    #[serde(rename = "tar.gz")]
    TarGzip,
    #[serde(rename = "tar.xz")]
    TarXz,
    #[serde(rename = "7z")]
    SevenZip,
}

impl PackageFormat {
    pub(crate) fn matches(self, name: &str) -> bool {
        let name = name.to_ascii_lowercase();
        match self {
            Self::Zip => name.ends_with(".zip"),
            Self::TarGzip => name.ends_with(".tar.gz") || name.ends_with(".tgz"),
            Self::TarXz => name.ends_with(".tar.xz"),
            Self::SevenZip => name.ends_with(".7z"),
        }
    }

    pub(crate) fn matches_magic(self, magic: &[u8]) -> bool {
        match self {
            Self::Zip => magic.starts_with(b"PK\x03\x04") || magic.starts_with(b"PK\x05\x06"),
            Self::TarGzip => magic.starts_with(b"\x1f\x8b\x08"),
            Self::TarXz => magic.starts_with(b"\xfd7zXZ\0"),
            Self::SevenZip => magic.starts_with(b"7z\xbc\xaf\x27\x1c"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct LaunchValues {
    /// Replaces the declaration's static argument list before adapter arguments.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arguments: Option<Vec<LaunchValue>>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub environment: BTreeMap<String, LaunchValue>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum LaunchValue {
    Text(String),
    Path(LaunchPathValue),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct LaunchPathValue {
    pub path: crate::launch_paths::LaunchPath,
}

impl AssetRules {
    pub(crate) fn tag_matches(&self, tag: &str) -> bool {
        self.tag_pattern.as_deref().is_none_or(|pattern| {
            pattern
                .strip_suffix('*')
                .map_or(tag == pattern, |prefix| tag.starts_with(prefix))
        })
    }
}

impl LaunchValue {
    pub(crate) fn resolve(&self, paths: &crate::launch_paths::LaunchPaths<'_>) -> Result<String> {
        match self {
            Self::Text(text) => Ok(text.clone()),
            Self::Path(value) => paths.expand(value.path),
        }
    }
}

pub(crate) fn validate(port: &PortDefinition) -> Result<()> {
    let Some(contract) = &port.reviewed_launch_contract_v1 else {
        return Ok(());
    };
    if port.adapter != AdapterKind::NativePortable
        || port.release.provider != ReleaseSource::Github
        || !port.bundled_runtime.is_empty()
        || !port.release.managed_build.is_empty()
    {
        return Err(invalid(
            "named package and launch declarations require a native GitHub runtime",
        ));
    }
    for (&platform, rules) in &contract.asset_rules {
        if !port.platforms.contains(&platform)
            || port.release.curated.contains_key(&platform)
            || port.release.reviewed_package_choices_v2.is_some()
            || port.release.direct.contains_key(&platform)
            || (rules.include.is_empty()
                && rules.exclude.is_empty()
                && rules.tag_pattern.is_none()
                && rules.prerelease.is_none())
            || rules.include.len() > MAX_TERMS
            || rules.exclude.len() > MAX_TERMS
            || rules
                .include
                .iter()
                .chain(&rules.exclude)
                .any(|term| !valid_term(term))
            || rules
                .tag_pattern
                .as_ref()
                .is_some_and(|tag| !valid_term(tag.strip_suffix('*').unwrap_or(tag)))
        {
            return Err(invalid("invalid or conflicting reviewed asset rule"));
        }
    }
    for &platform in contract.package_format.keys() {
        if !port.platforms.contains(&platform)
            || port.release.requires_tar_xz(platform)
            || port.release.curated.contains_key(&platform)
            || port.release.reviewed_package_choices_v2.is_some()
            || port.external_profile_policy.is_some()
        {
            return Err(invalid("invalid or conflicting reviewed package format"));
        }
    }
    for (&platform, launch) in &contract.launch {
        let value_safe = |value: &LaunchValue| match value {
            LaunchValue::Text(text) => {
                !text.is_empty() && text.len() <= 4096 && !text.chars().any(char::is_control)
            }
            LaunchValue::Path(path) => {
                path.path != crate::launch_paths::LaunchPath::Source
                    || port.source_profile.is_some()
            }
        };
        if !port.platforms.contains(&platform)
            || (launch.arguments.is_none() && launch.environment.is_empty())
            || port.managed_initialization.is_some()
            || launch.arguments.as_ref().is_some_and(|args| {
                args.len() > 64
                    || args.iter().any(|arg| !value_safe(arg))
                    || !port.launch_arguments.is_empty()
            })
            || launch.environment.len() > 32
            || launch.environment.iter().any(|(name, value)| {
                !crate::catalog::is_safe_environment_name(name)
                    || matches!(
                        name.as_str(),
                        "SDL_DYNAMIC_API" | "QT_PLUGIN_PATH" | "QT_QPA_PLATFORM_PLUGIN_PATH"
                    )
                    || name.starts_with("LD_")
                    || name.starts_with("DYLD_")
                    || port.launch_environment.contains_key(name)
                    || port.source_environment.as_ref() == Some(name)
                    || port.user_data_environment.as_ref() == Some(name)
                    || !value_safe(value)
            })
        {
            return Err(invalid("invalid or conflicting typed launch value"));
        }
    }
    if contract.asset_rules.is_empty()
        && contract.package_format.is_empty()
        && contract.launch.is_empty()
    {
        return Err(invalid("empty named package and launch declaration"));
    }
    Ok(())
}

fn valid_term(term: &str) -> bool {
    !matches!(term, "" | "." | "..")
        && term.len() <= 128
        && term
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte))
}

fn invalid(message: &str) -> PortcoveError {
    PortcoveError::verification(message)
}
