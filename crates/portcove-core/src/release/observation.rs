use std::{collections::HashSet, path::Path};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::{GithubRelease, choose_asset, is_beta_release, parse_digest, select_channel_candidate};
use crate::{
    API_SCHEMA_VERSION, AdapterKind, Platform, PortDefinition, PortcoveError, ReleaseAsset,
    ReleaseChannel, ReleaseSource, ResolvedRelease, Result, path::read_bounded_regular,
};

#[derive(Debug, Serialize, JsonSchema)]
pub struct UpstreamObservationReport {
    pub format: u32,
    pub engine_api_schema_version: u32,
    pub port_id: String,
    pub repository_id: u64,
    pub adapter: AdapterKind,
    pub facts_sha256: String,
    pub catalog_definition_sha256: String,
    pub observed_at: String,
    pub eligibility_scope: String,
    pub evidence: ObservationEvidence,
    pub projections: Vec<ChannelObservation>,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct ObservationEvidence {
    pub provider_authenticated: bool,
    pub artifact_bytes_verified: bool,
    pub catalog_admission_assessed: bool,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct ObservedReleaseIdentity {
    pub id: u64,
    pub tag: String,
    pub published_at: Option<String>,
    pub provider_prerelease: bool,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct ObservedResolution {
    pub release_id: u64,
    pub asset_id: u64,
    pub release: ResolvedRelease,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct ChannelObservation {
    pub platform: Platform,
    pub channel: ReleaseChannel,
    pub latest_observed: Option<ObservedReleaseIdentity>,
    pub channel_candidate: Option<ObservedReleaseIdentity>,
    pub latest_eligible: Option<ObservedResolution>,
    pub hold_reasons: Vec<String>,
}

#[derive(Deserialize)]
struct ObservedRelease {
    id: u64,
    #[serde(flatten)]
    provider: GithubRelease,
}

fn json_digest(value: &Value) -> Result<String> {
    // Keep the digest stable even when another workspace member enables
    // serde_json's preserve_order feature.
    let mut canonical = value.clone();
    canonical.sort_all_objects();
    Ok(hex::encode(Sha256::digest(serde_json::to_vec(&canonical)?)))
}

fn metadata_identity(value: &Value) -> Result<u64> {
    value
        .as_u64()
        .filter(|id| *id > 0 && *id <= 9_007_199_254_740_991)
        .ok_or_else(|| {
            PortcoveError::verification("observation identity is not a positive safe integer")
        })
}

fn release_identity(release: &ObservedRelease) -> ObservedReleaseIdentity {
    ObservedReleaseIdentity {
        id: release.id,
        tag: release.provider.tag_name.clone(),
        published_at: release.provider.published_at.clone(),
        provider_prerelease: release.provider.prerelease,
    }
}

fn observation_timestamp(value: &Value) -> Option<time::OffsetDateTime> {
    value.as_str().and_then(|value| {
        time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339).ok()
    })
}

fn validate_facts(facts: &Value, port: &PortDefinition, repository_id: u64) -> Result<()> {
    if repository_id == 0
        || facts["repository"]["id"].as_u64() != Some(repository_id)
        || facts["repository"]["full_name"].as_str() != Some(port.release.repository.as_str())
        || !facts["repository"]["archived"].is_boolean()
    {
        return Err(PortcoveError::verification(
            "observation repository identity differs from the configured scope",
        ));
    }
    let releases = facts["releases"]
        .as_array()
        .filter(|items| items.len() <= 1000)
        .ok_or_else(|| PortcoveError::verification("observation release list exceeds its bound"))?;
    let mut release_ids = HashSet::new();
    let mut asset_ids = HashSet::new();
    for release in releases {
        if !release["draft"].is_boolean()
            || !release["prerelease"].is_boolean()
            || observation_timestamp(&release["created_at"]).is_none()
            || (release["draft"] != true
                && observation_timestamp(&release["published_at"]).is_none())
        {
            return Err(PortcoveError::verification(
                "observation release flags or clocks are invalid",
            ));
        }
        if !release_ids.insert(metadata_identity(&release["id"])?) {
            return Err(PortcoveError::verification(
                "observation repeated a release identity",
            ));
        }
        let tag = release["tag_name"]
            .as_str()
            .filter(|tag| !tag.is_empty() && tag.len() <= 255 && !tag.chars().any(char::is_control))
            .ok_or_else(|| PortcoveError::verification("observation release tag is invalid"))?;
        let assets = release["assets"]
            .as_array()
            .filter(|items| items.len() <= 1000)
            .ok_or_else(|| {
                PortcoveError::verification("observation asset list exceeds its bound")
            })?;
        for asset in assets {
            if observation_timestamp(&asset["created_at"]).is_none()
                || observation_timestamp(&asset["updated_at"]).is_none()
            {
                return Err(PortcoveError::verification(
                    "observation asset clocks are invalid",
                ));
            }
            if !asset_ids.insert(metadata_identity(&asset["id"])?) {
                return Err(PortcoveError::verification(
                    "observation repeated an asset identity",
                ));
            }
            let name = asset["name"]
                .as_str()
                .filter(|name| {
                    !name.is_empty()
                        && !name.chars().any(char::is_control)
                        && name.len() <= 255
                        && !name.contains(['/', '\\'])
                        && *name != "."
                        && *name != ".."
                })
                .ok_or_else(|| {
                    PortcoveError::verification("observation asset filename is invalid")
                })?;
            let url = asset["browser_download_url"]
                .as_str()
                .and_then(|url| reqwest::Url::parse(url).ok())
                .ok_or_else(|| PortcoveError::verification("observation asset URL is invalid"))?;
            let repository = port.release.repository.split('/').collect::<Vec<_>>();
            let mut expected = reqwest::Url::parse("https://github.com").expect("static URL");
            expected
                .path_segments_mut()
                .expect("static hierarchical URL")
                .extend(
                    repository
                        .iter()
                        .copied()
                        .chain(["releases", "download", tag, name]),
                );
            if url.scheme() != "https"
                || url.host_str() != Some("github.com")
                || url.port().is_some()
                || !url.username().is_empty()
                || url.password().is_some()
                || url.query().is_some()
                || url.fragment().is_some()
                || repository.len() != 2
                || url != expected
                || asset["state"].as_str() != Some("uploaded")
                || asset["size"]
                    .as_u64()
                    .is_none_or(|size| size > 9_007_199_254_740_991)
            {
                return Err(PortcoveError::verification(
                    "observation asset escaped its release scope",
                ));
            }
        }
    }
    Ok(())
}

fn project_channel(
    port: &PortDefinition,
    releases: &[ObservedRelease],
    facts: &Value,
    platform: Platform,
    channel: ReleaseChannel,
) -> ChannelObservation {
    let latest = releases.iter().find(|release| !release.provider.draft);
    let candidate = select_channel_candidate(
        releases,
        channel,
        port.release.rolling_tag.as_deref(),
        |release| !release.provider.draft,
        |release| is_beta_release(&release.provider),
        |release| release.provider.tag_name.as_str(),
    );
    let mut output = ChannelObservation {
        platform,
        channel,
        latest_observed: latest.map(release_identity),
        channel_candidate: candidate.map(release_identity),
        latest_eligible: None,
        hold_reasons: Vec::new(),
    };
    if !port.channels.contains(&channel) {
        output.hold_reasons.push("channel-not-offered".into());
    }
    if facts["repository"]["archived"] == true {
        output.hold_reasons.push("upstream-archived".into());
    }
    let Some(candidate) = candidate else {
        output
            .hold_reasons
            .push("no-published-channel-candidate".into());
        return output;
    };
    if !output.hold_reasons.is_empty() {
        return output;
    }
    let asset = match choose_asset(port, platform, &candidate.provider.assets) {
        Ok(asset) => asset,
        Err(_) => {
            output
                .hold_reasons
                .push("asset-missing-or-ambiguous".into());
            return output;
        }
    };
    let Some(sha256) = asset.digest.as_deref().and_then(parse_digest) else {
        output
            .hold_reasons
            .push("authenticated-digest-requires-further-resolution".into());
        return output;
    };
    let raw = facts["releases"]
        .as_array()
        .expect("validated list")
        .iter()
        .find(|raw| raw["id"] == candidate.id)
        .expect("decoded release");
    let asset_id = raw["assets"]
        .as_array()
        .expect("validated assets")
        .iter()
        .find(|raw| {
            raw["name"] == asset.name && raw["browser_download_url"] == asset.browser_download_url
        })
        .expect("decoded asset")["id"]
        .as_u64()
        .expect("validated identity");
    output.latest_eligible = Some(ObservedResolution {
        release_id: candidate.id,
        asset_id,
        release: ResolvedRelease {
            version: candidate.provider.tag_name.clone(),
            channel,
            published_at: candidate.provider.published_at.clone(),
            asset: ReleaseAsset {
                name: asset.name.clone(),
                url: asset.browser_download_url.clone(),
                size: asset.size,
                sha256,
            },
        },
    });
    output
}

/// Interpret an inert observation using the same channel and asset rules as
/// release resolution. This grants no acquisition, catalog or install trust.
pub fn inspect_upstream_observation(
    port: &PortDefinition,
    repository_id: u64,
    path: &Path,
) -> Result<UpstreamObservationReport> {
    if port.release.provider != ReleaseSource::Github {
        return Err(PortcoveError::unsupported(
            "bounded observation currently supports GitHub only",
        ));
    }
    let bytes = read_bounded_regular(path, 4 * 1024 * 1024)?;
    let document: Value = serde_json::from_slice(&bytes)?;
    if document["format"] != 1
        || document["authority"] != "provider-observation-only"
        || document["port_id"] != port.id
    {
        return Err(PortcoveError::verification(
            "observation format or port identity is invalid",
        ));
    }
    let started = observation_timestamp(&document["started_at"]);
    let completed = observation_timestamp(&document["completed_at"]);
    if started.is_none() || completed.is_none() || started > completed {
        return Err(PortcoveError::verification(
            "observation interval is invalid",
        ));
    }
    let facts = &document["facts"];
    let digest = json_digest(facts)?;
    if document["facts_sha256"] != digest {
        return Err(PortcoveError::verification(
            "observation facts digest differs",
        ));
    }
    validate_facts(facts, port, repository_id)?;
    let releases: Vec<ObservedRelease> = serde_json::from_value(facts["releases"].clone())?;
    let projections = port
        .platforms
        .iter()
        .flat_map(|platform| {
            [
                ReleaseChannel::Stable,
                ReleaseChannel::Beta,
                ReleaseChannel::Rolling,
            ]
            .map(|channel| project_channel(port, &releases, facts, *platform, channel))
        })
        .collect();
    Ok(UpstreamObservationReport {
        format: 1,
        engine_api_schema_version: API_SCHEMA_VERSION,
        port_id: port.id.clone(),
        repository_id,
        adapter: port.adapter,
        facts_sha256: digest,
        catalog_definition_sha256: json_digest(&serde_json::to_value(port)?)?,
        observed_at: document["completed_at"]
            .as_str()
            .expect("validated clock")
            .into(),
        eligibility_scope: "core-release-metadata".into(),
        evidence: ObservationEvidence {
            provider_authenticated: false,
            artifact_bytes_verified: false,
            catalog_admission_assessed: false,
        },
        projections,
    })
}

#[cfg(test)]
#[path = "observation_tests.rs"]
mod tests;
