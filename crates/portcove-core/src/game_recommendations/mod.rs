//! Game-centered, read-only discovery. Observations describe an offered artifact;
//! they never grant an operation or change a player's installed/selected identity.
use std::collections::BTreeSet;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{Platform, PortcoveError, ReleaseChannel, Result};

pub(crate) mod metadata;
pub use metadata::{
    ControlsOutcome, GameplayOutcome, MaintenanceOutcome, PerformanceOutcome,
    RECOMMENDATION_METADATA_VERSION, RecommendationCapabilityObservation, RecommendationMetadata,
    RecommendationMetadataState, RecommendationObservation, RecommendationOutcome, SetupOutcome,
    StabilityOutcome,
};
pub(crate) use metadata::{capability_states, normalize};

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct GameComparisonRequest {
    /// A current or retained listing. Only explicit original-game IDs relate alternatives.
    pub port_id: String,
    #[serde(default)]
    pub edition_id: Option<String>,
    #[serde(default)]
    pub platform: Option<Platform>,
    /// An explicit observation environment, not a claim that this machine matches it.
    /// Omission uses an unqualified environment and cannot inherit another device's evidence.
    #[serde(default)]
    pub environment_id: Option<String>,
    #[serde(default)]
    pub required_capabilities: BTreeSet<String>,
    /// Catalog profile IDs only. Omission uses this library's explicit registrations;
    /// presence describes a hypothetical source context, not a fresh file verification.
    #[serde(default)]
    pub source_profile_ids: Option<BTreeSet<String>>,
    /// Reuse the existing provider's conditional requests, cache and network limits.
    #[serde(default)]
    pub refresh: bool,
    /// Explicit replay clock. Adapters must not replace a supplied clock.
    #[serde(default)]
    pub evaluated_at: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ComparisonRelease {
    pub version: String,
    pub channel: ReleaseChannel,
    pub asset_name: String,
    pub artifact_sha256: String,
    pub size: u64,
    pub published_at: Option<String>,
}

impl ComparisonRelease {
    pub(crate) fn from_release(release: &crate::ResolvedRelease) -> Self {
        Self {
            version: release.version.clone(),
            channel: release.channel,
            asset_name: release.asset.name.clone(),
            artifact_sha256: release.asset.sha256.to_ascii_lowercase(),
            size: release.asset.size,
            published_at: release.published_at.clone(),
        }
    }

    pub(crate) fn valid(&self) -> bool {
        metadata::identifier(&self.version)
            && metadata::identifier(&self.asset_name)
            && digest_valid(&self.artifact_sha256)
    }

    pub(crate) fn identity(&self) -> Result<String> {
        fingerprint(&(
            self.channel,
            &self.version,
            &self.asset_name,
            &self.artifact_sha256,
            self.size,
        ))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum ComparisonReleaseState {
    CatalogPinned,
    ProviderResolved,
    CollectionFailed,
    DefinitionChanged,
    Unobserved,
    NotOffered,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ComparisonFreshness {
    pub state: ComparisonReleaseState,
    /// Successful provider resolution may use the provider's existing cache. This
    /// is deliberately not labelled a fresh network request or upstream change time.
    pub last_successful_resolution_at: Option<u64>,
    pub last_attempt_at: Option<u64>,
    pub offered_identity_changed_at: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ComparisonEdition {
    pub id: String,
    pub title: String,
    pub system: Option<String>,
    pub evidence_urls: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ComparisonPort {
    pub port_id: String,
    pub name: String,
    pub project_url: String,
    pub edition_ids: Vec<String>,
    pub declared_platforms: Vec<Platform>,
    pub source_profile_ids: Vec<String>,
    pub metadata: RecommendationMetadataState,
    pub offered_release: Option<ComparisonRelease>,
    pub offered_identity: Option<String>,
    pub freshness: ComparisonFreshness,
    /// Existing Core assessment, not recommendation policy. Never an execution token.
    pub operation: crate::RecommendationOperationEligibility,
    pub source_health: Option<crate::SourceHealth>,
    pub launch_ready: bool,
    pub installed: bool,
    pub followed: bool,
    /// A single current observed change, deduplicated by exact release/artifact identity.
    pub update_notice: Option<ComparisonUpdateNotice>,
    pub limitations: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ComparisonUpdateNotice {
    pub identity: String,
    pub version: String,
    pub artifact_sha256: String,
    pub observed_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct GameComparison {
    pub format_version: u32,
    pub policy_version: String,
    pub game_id: Option<String>,
    pub edition_id: Option<String>,
    pub editions: Vec<ComparisonEdition>,
    pub platform: Platform,
    pub environment_id: String,
    pub source_profile_ids: BTreeSet<String>,
    pub source_context_is_hypothetical: bool,
    pub required_capabilities: BTreeSet<String>,
    pub evaluated_at: u64,
    pub input_id: String,
    pub assessment: Option<crate::PortRecommendationAssessment>,
    pub ports: Vec<ComparisonPort>,
    pub limitations: Vec<String>,
}

pub(crate) fn route_id(port: &crate::PortDefinition) -> String {
    let adapter = serde_json::to_value(port.adapter)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_default();
    let owner = if port.release.provider == crate::ReleaseSource::UserPrepared {
        "user-prepared"
    } else {
        "managed"
    };
    format!("{owner}:{adapter}")
}

pub(crate) fn release_id(release: &ComparisonRelease) -> String {
    format!("{}:{}", release.channel, release.version)
}

pub(crate) fn digest_valid(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

pub(crate) fn fingerprint(value: &impl Serialize) -> Result<String> {
    let mut value = serde_json::to_value(value)?;
    value.sort_all_objects();
    Ok(crate::signed_catalog::digest(&serde_json::to_vec(&value)?))
}

pub(crate) fn evaluation_time(request: &GameComparisonRequest) -> Result<u64> {
    use std::time::{SystemTime, UNIX_EPOCH};
    if !metadata::identifier(&request.port_id)
        || request
            .edition_id
            .as_deref()
            .is_some_and(|value| !metadata::identifier(value))
        || request
            .environment_id
            .as_deref()
            .is_some_and(|value| !metadata::identifier(value))
        || request.required_capabilities.len() > 32
        || request
            .required_capabilities
            .iter()
            .any(|value| !metadata::identifier(value))
        || request.source_profile_ids.as_ref().is_some_and(|ids| {
            ids.len() > 64 || ids.iter().any(|value| !metadata::identifier(value))
        })
    {
        return Err(PortcoveError::usage("invalid game comparison context"));
    }
    request.evaluated_at.map_or_else(
        || {
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|time| time.as_secs())
                .map_err(|_| PortcoveError::state("clock precedes Unix epoch"))
        },
        Ok,
    )
}

#[cfg(test)]
mod tests;
