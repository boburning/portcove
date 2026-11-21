//! Reviewed GitHub mod sources. Browsing is read-only and does not grant native
//! companion installation or profile activation.
use std::path::Path;

use reqwest::Url;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use crate::{
    Platform, PortDefinition, PortcoveError, PortcoveService, ProviderFreshness,
    RecompCompoundReview, Result,
    mod_provider::sanitize_text,
    profile_loader::ModEngine,
    provider_http::ProviderHttp,
    recomp_companion_review::{self, CompanionLayout, MAX_WRAPPER_BYTES},
};

#[path = "github_compound_custody.rs"]
mod custody;
pub use custody::{GithubCompoundConsent, GithubCompoundPlan};

const API: &str = "https://api.github.com";
const MAX_RELEASES: usize = 30;
const MAX_ASSETS: usize = 128;

#[derive(Clone, Copy)]
struct ReviewedSource {
    runtime_repository: &'static str,
    game: &'static str,
    repository: &'static str,
    repository_id: u64,
    asset_name: &'static str,
    companions: &'static [CompanionLayout],
}

const SOURCES: &[ReviewedSource] = &[ReviewedSource {
    runtime_repository: "Zelda64Recomp/Zelda64Recomp",
    game: "mm",
    repository: "RecompRando/MMRecompRando",
    repository_id: 854379059,
    asset_name: "MMRecompRando.zip",
    companions: &[
        CompanionLayout {
            platform: Platform::WindowsX86_64,
            declared_library: "APCpp-Glue",
            files: &["APCpp-Glue.dll", "python311.dll"],
        },
        CompanionLayout {
            platform: Platform::LinuxX86_64,
            declared_library: "APCpp-Glue",
            files: &["APCpp-Glue.so", "libpython3.11.so.1.0"],
        },
    ],
}];

fn reviewed_source(port: &PortDefinition) -> Option<ReviewedSource> {
    let loader = crate::profile_loader::configured_loader(port)?;
    if loader.engine != ModEngine::N64Recomp {
        return None;
    }
    SOURCES.iter().copied().find(|binding| {
        port.release
            .repository
            .eq_ignore_ascii_case(binding.runtime_repository)
            && loader.native_game.as_deref() == Some(binding.game)
    })
}

/// Eligibility to explicitly browse the upstream source, without a network read.
pub fn has_github_mod_source(port: &PortDefinition) -> bool {
    reviewed_source(port).is_some()
}

pub(crate) fn github_mod_handoff(
    port: &PortDefinition,
    platform: Option<Platform>,
) -> (Option<String>, bool) {
    let Some(source) = reviewed_source(port) else {
        return (None, false);
    };
    let native_import = platform.is_some_and(|platform| {
        port.platforms.contains(&platform)
            && source
                .companions
                .iter()
                .any(|layout| layout.platform == platform)
    });
    (
        Some(format!("https://github.com/{}/releases", source.repository)),
        native_import,
    )
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct GithubModRelease {
    pub release_id: u64,
    pub tag: String,
    pub published_at: Option<i64>,
    pub release_url: String,
    pub asset: GithubModAsset,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct GithubModAsset {
    pub asset_id: u64,
    pub name: String,
    pub bytes: u64,
    pub published_sha256: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct GithubModCatalog {
    pub port_id: String,
    pub platform: Platform,
    pub repository: String,
    pub repository_id: u64,
    pub source_url: String,
    /// The reviewed wrapper has required companions on this platform.
    pub native_import_offered: bool,
    pub releases: Vec<GithubModRelease>,
    pub complete: bool,
    pub observed_at: i64,
    pub freshness: ProviderFreshness,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct GithubModCompoundReview {
    pub port_id: String,
    pub repository: String,
    pub repository_id: u64,
    pub release_id: u64,
    pub asset_id: u64,
    pub review: RecompCompoundReview,
}

impl PortcoveService {
    pub async fn github_mod_catalog(
        &self,
        port_id: &str,
        platform: Platform,
    ) -> Result<GithubModCatalog> {
        let port = self.catalog().port(port_id)?;
        self.github_mod_catalog_for_port(port, platform).await
    }

    async fn github_mod_catalog_for_port(
        &self,
        port: &PortDefinition,
        platform: Platform,
    ) -> Result<GithubModCatalog> {
        let binding = reviewed_source(port).ok_or_else(|| {
            PortcoveError::unsupported("this port has no reviewed GitHub mod source")
        })?;
        let library = self.library();
        let http = ProviderHttp::new(Some(library.clone()), "GitHub Releases", "github.com")?
            .with_backoff(library.github_mod_backoff.clone());
        let repository = format!("{API}/repositories/{}", binding.repository_id);
        let identity = http
            .observe(endpoint(&repository)?, |row| {
                if row["id"].as_u64() != Some(binding.repository_id)
                    || row["full_name"].as_str() != Some(binding.repository)
                    || row["private"].as_bool() != Some(false)
                {
                    return Err(PortcoveError::verification(
                        "GitHub mod repository identity changed",
                    ));
                }
                Ok(())
            })
            .await?;
        let listing = http
            .observe(
                endpoint(&format!("{repository}/releases?per_page={MAX_RELEASES}"))?,
                |value| project_releases(binding, value),
            )
            .await?;
        let (releases, complete) = listing.value;
        let freshness =
            if [identity.freshness, listing.freshness].contains(&ProviderFreshness::Stale) {
                ProviderFreshness::Stale
            } else {
                listing.freshness
            };
        Ok(GithubModCatalog {
            port_id: port.id.clone(),
            platform,
            repository: binding.repository.into(),
            repository_id: binding.repository_id,
            source_url: format!("https://github.com/{}/releases", binding.repository),
            native_import_offered: github_mod_handoff(port, Some(platform)).1,
            releases,
            complete,
            observed_at: identity.observed_at.min(listing.observed_at),
            freshness,
        })
    }
    /// Inspect an intact ZIP against current approved source identities. This
    /// report is not an install plan and cannot be passed to apply.
    pub async fn review_github_mod_archive(
        &self,
        port_id: &str,
        platform: Platform,
        release_id: u64,
        asset_id: u64,
        archive: Option<&Path>,
    ) -> Result<GithubModCompoundReview> {
        let port = self.catalog().port(port_id)?;
        let (source, _, _, staged) = self
            .stage_github_mod_archive(port, platform, release_id, asset_id, None, archive)
            .await?;
        Ok(GithubModCompoundReview {
            port_id: port_id.into(),
            repository: source.repository.into(),
            repository_id: source.repository_id,
            release_id,
            asset_id,
            review: staged.review,
        })
    }

    async fn stage_github_mod_archive(
        &self,
        port: &PortDefinition,
        platform: Platform,
        release_id: u64,
        asset_id: u64,
        expected_tag: Option<&str>,
        archive: Option<&Path>,
    ) -> Result<(
        ReviewedSource,
        CompanionLayout,
        String,
        recomp_companion_review::StagedCompoundReview,
    )> {
        let source = reviewed_source(port).ok_or_else(|| {
            PortcoveError::unsupported("this port has no reviewed GitHub mod source")
        })?;
        let layout = source
            .companions
            .iter()
            .copied()
            .find(|layout| layout.platform == platform && port.platforms.contains(&platform))
            .ok_or_else(|| {
                PortcoveError::unsupported(
                    "this source has no reviewed companion layout for the platform",
                )
            })?;
        let listing = self.github_mod_catalog_for_port(port, platform).await?;
        if listing.freshness == ProviderFreshness::Stale || !listing.complete {
            return Err(PortcoveError::verification(
                "refresh the GitHub source before reviewing the ZIP",
            ));
        }
        let selected = listing
            .releases
            .iter()
            .find(|release| release.release_id == release_id && release.asset.asset_id == asset_id)
            .ok_or_else(|| {
                PortcoveError::verification(
                    "the exact release and asset pair is outside the current reviewed inventory",
                )
            })?;
        if expected_tag.is_some_and(|tag| tag != selected.tag) {
            return Err(PortcoveError::verification(
                "the requested GitHub mod release version changed",
            ));
        }
        let digest = selected.asset.published_sha256.as_deref().ok_or_else(|| {
            PortcoveError::verification("GitHub did not publish a SHA-256 for this local ZIP")
        })?;
        let tag = selected.tag.clone();
        let bytes = selected.asset.bytes;
        let digest = digest.to_owned();
        let (archive, temporary) = if let Some(archive) = archive {
            (archive.to_path_buf(), None)
        } else {
            let temporary = tempfile::tempdir()?;
            let path = temporary.path().join("download.zip");
            let library = self.library();
            let http = ProviderHttp::new(Some(library.clone()), "GitHub Releases", "github.com")?
                .with_backoff(library.github_mod_backoff.clone());
            let (calculated, length) = http
                .download_github_asset(
                    source.repository_id,
                    asset_id,
                    bytes,
                    &path,
                    MAX_WRAPPER_BYTES,
                )
                .await?;
            if calculated != digest || length != bytes {
                return Err(PortcoveError::verification(
                    "download differs from the reviewed GitHub asset",
                ));
            }
            (path, Some(temporary))
        };
        let review = tokio::task::spawn_blocking(move || {
            let _download_custody = temporary;
            recomp_companion_review::stage(
                &archive,
                bytes,
                &digest,
                source.game,
                layout,
                source.companions,
            )
        })
        .await
        .map_err(|_| PortcoveError::state("Recomp wrapper review worker stopped"))??;
        Ok((source, layout, tag, review))
    }
}

fn endpoint(raw: &str) -> Result<Url> {
    Url::parse(raw).map_err(|_| PortcoveError::state("invalid reviewed GitHub mod endpoint"))
}

fn public_id(value: &Value) -> Option<u64> {
    value.as_u64().filter(|id| (1..=(1 << 53) - 1).contains(id))
}

fn parse_asset(row: &Value, binding: ReviewedSource) -> Option<GithubModAsset> {
    let name = row["name"]
        .as_str()
        .filter(|name| *name == binding.asset_name)?;
    let bytes = row["size"]
        .as_u64()
        .filter(|bytes| (1..=MAX_WRAPPER_BYTES).contains(bytes))?;
    if row["state"].as_str() != Some("uploaded") {
        return None;
    }
    let published_sha256 = match &row["digest"] {
        Value::Null => None,
        digest => Some(
            digest
                .as_str()?
                .strip_prefix("sha256:")
                .filter(|hex| {
                    hex.len() == 64
                        && hex
                            .bytes()
                            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                })?
                .to_owned(),
        ),
    };
    Some(GithubModAsset {
        asset_id: public_id(&row["id"])?,
        name: name.into(),
        bytes,
        published_sha256,
    })
}

fn parse_release(binding: ReviewedSource, value: &Value) -> Option<GithubModRelease> {
    let rows = value["assets"]
        .as_array()
        .filter(|rows| rows.len() <= MAX_ASSETS)?;
    let mut assets = rows
        .iter()
        .filter(|row| row["name"].as_str() == Some(binding.asset_name));
    let asset = parse_asset(assets.next()?, binding)?;
    if assets.next().is_some() {
        return None;
    }
    let tag = value["tag_name"].as_str().filter(|text| {
        !text.is_empty()
            && text.len() <= 128
            && sanitize_text(text) == *text
            && *text != "."
            && *text != ".."
    })?;
    let mut release_url = endpoint(&format!(
        "https://github.com/{}/releases/tag",
        binding.repository
    ))
    .ok()?;
    release_url.path_segments_mut().ok()?.push(tag);
    Some(GithubModRelease {
        release_id: public_id(&value["id"])?,
        tag: tag.into(),
        published_at: value["published_at"]
            .as_str()
            .and_then(|text| OffsetDateTime::parse(text, &Rfc3339).ok())
            .map(OffsetDateTime::unix_timestamp),
        release_url: release_url.into(),
        asset,
    })
}

fn project_releases(
    binding: ReviewedSource,
    value: &Value,
) -> Result<(Vec<GithubModRelease>, bool)> {
    let rows = value
        .as_array()
        .filter(|rows| rows.len() <= MAX_RELEASES)
        .ok_or_else(|| {
            PortcoveError::verification(
                "GitHub mod release history exceeds its bound or is unreadable",
            )
        })?;
    let mut complete = rows.len() < MAX_RELEASES;
    let mut releases = Vec::new();
    let mut ids = std::collections::BTreeSet::new();
    let mut asset_ids = std::collections::BTreeSet::new();
    for row in rows {
        match (row["draft"].as_bool(), row["prerelease"].as_bool()) {
            (Some(false), Some(false)) => {}
            (Some(_), Some(_)) => continue,
            _ => {
                complete = false;
                continue;
            }
        }
        let Some(release) = parse_release(binding, row) else {
            complete = false;
            continue;
        };
        if !ids.insert(release.release_id) || !asset_ids.insert(release.asset.asset_id) {
            return Err(PortcoveError::verification(
                "duplicate GitHub mod release or asset identity",
            ));
        }
        releases.push(release);
    }
    releases.sort_by(|a, b| {
        b.published_at
            .cmp(&a.published_at)
            .then_with(|| b.release_id.cmp(&a.release_id))
    });
    Ok((releases, complete))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reviewed_repository_scope_uses_loader_identity() {
        let catalog = crate::Catalog::embedded().unwrap();
        let mut port = catalog.port("zelda64-recomp").unwrap().clone();
        assert!(has_github_mod_source(&port));
        assert!(!has_github_mod_source(catalog.port("shipwright").unwrap()));
        for platform in [Platform::WindowsX86_64, Platform::LinuxX86_64] {
            let (url, native) = github_mod_handoff(&port, Some(platform));
            assert_eq!(
                url.as_deref(),
                Some("https://github.com/RecompRando/MMRecompRando/releases")
            );
            assert!(native);
        }
        for platform in [
            Some(Platform::MacosX86_64),
            Some(Platform::MacosAarch64),
            None,
        ] {
            let (url, native) = github_mod_handoff(&port, platform);
            assert!(url.is_some());
            assert!(!native);
        }
        port.release.repository = "unrelated/unreviewed".into();
        assert!(!has_github_mod_source(&port));
    }

    #[test]
    fn only_the_reviewed_uploaded_asset_is_listed_with_exact_identity() {
        let assets = json!([
            {"id": 22, "name": "EXAMPLE_YAML.yaml", "size": 5, "state": "uploaded"},
            {"id": 17, "name": "MMRecompRando.zip", "size": 100, "state": "uploaded",
             "digest":format!("sha256:{}", "a".repeat(64))}
        ]);
        let ready = json!({
            "id": 91, "draft":false, "prerelease":false, "tag_name":"v1.2.3/preview",
            "assets":assets,
        });
        let (files, complete) = project_releases(SOURCES[0], &json!([ready.clone()])).unwrap();
        assert!(complete);
        assert_eq!(files[0].release_id, 91);
        assert_eq!(files[0].asset.asset_id, 17);
        assert_eq!(
            files[0].asset.published_sha256.as_deref(),
            Some("a".repeat(64).as_str())
        );
        assert!(files[0].release_url.ends_with("v1.2.3%2Fpreview"));
        assert!(project_releases(SOURCES[0], &json!([ready.clone(), ready.clone()])).is_err());
        let mut corrupt = ready;
        corrupt["assets"][1]["digest"] = json!("md5:0000");
        let (files, complete) = project_releases(SOURCES[0], &json!([corrupt])).unwrap();
        assert!(files.is_empty());
        assert!(!complete);
    }

    #[test]
    #[ignore = "requires the real retained GitHub mod release metadata file"]
    fn real_release_successor_retains_numeric_github_identity() {
        let path = std::env::var_os("PORTCOVE_GITHUB_MOD_RELEASES").unwrap();
        let metadata: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        let (releases, _) = project_releases(SOURCES[0], &metadata).unwrap();
        let pair: Vec<_> = releases
            .iter()
            .filter(|release| ["v0.9.5", "v0.9.5a"].contains(&release.tag.as_str()))
            .collect();
        assert_eq!(pair.len(), 2);
        assert_eq!(
            (pair[0].release_id, pair[0].asset.asset_id),
            (274707236, 337279656)
        );
        assert_eq!(
            (pair[1].release_id, pair[1].asset.asset_id),
            (262724936, 319816241)
        );
        assert_ne!(
            pair[0].asset.published_sha256,
            pair[1].asset.published_sha256
        );
    }
}
