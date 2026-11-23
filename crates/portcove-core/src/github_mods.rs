//! Reviewed GitHub mod sources. Browsing is read-only and does not grant native
//! companion installation or profile activation.
use std::path::Path;

use reqwest::Url;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use crate::{
    ModSourceAuthority, Platform, PortDefinition, PortcoveError, PortcoveService,
    ProviderFreshness, RecompCompoundReview, Result,
    mod_provider::sanitize_text,
    profile_loader::ModEngine,
    provider_http::ProviderHttp,
    recomp_companion_review::{self, CompanionLayout, MAX_WRAPPER_BYTES},
};

#[path = "github_compound_custody.rs"]
mod custody;
use custody::check_runtime;
pub use custody::{GithubCompoundConsent, GithubCompoundPlan};

const API: &str = "https://api.github.com";
const MAX_RELEASES: usize = 30;
const MAX_ASSETS: usize = 128;

type ReviewedSource<'a> = crate::mod_source::GithubSource<'a>;

/// The port's declared GitHub release source on the platform, when its
/// authority reaches `authority`.
fn reviewed_source(
    port: &PortDefinition,
    platform: Platform,
    authority: ModSourceAuthority,
) -> Option<ReviewedSource<'_>> {
    crate::mod_source::github(port, platform).filter(|source| source.authority >= authority)
}

/// Whether the definition declares a GitHub release mod source on any platform.
pub fn has_github_mod_source(port: &PortDefinition) -> bool {
    port.mod_sources
        .iter()
        .any(|source| matches!(source.source, crate::ModSourceKind::GithubRelease { .. }))
}

/// The declared upstream releases page. A link-out alone grants no native
/// import; that comes only from an installed build.
pub(crate) fn github_mod_release_url(
    port: &PortDefinition,
    platform: Option<Platform>,
) -> Option<String> {
    reviewed_source(port, platform?, ModSourceAuthority::LinkOut)
        .map(|source| source.releases_url())
}

/// The retained definition of an installed build still describes the same
/// Recomp runtime and native game as the current definition that declares
/// the source. Source facts come from the current definition, so withdrawing
/// the source there revokes every use of it.
fn retained_runtime_matches(retained: &PortDefinition, current: &PortDefinition) -> bool {
    let game = |port: &PortDefinition| {
        crate::profile_loader::configured_loader(port)
            .filter(|loader| loader.engine == ModEngine::N64Recomp)
            .and_then(|loader| loader.native_game.clone())
    };
    retained
        .release
        .repository
        .eq_ignore_ascii_case(&current.release.repository)
        && game(retained).is_some()
        && game(retained) == game(current)
}

/// Whether the exact installed runtime admits native companion import on the
/// platform: its own retained definition must bind the reviewed Recomp loader
/// to this build, and the current definition must declare an inspect-level
/// source with a companion layout for the platform. Each mod's minimum
/// runtime is checked separately against the reviewed wrapper.
pub(crate) fn installed_native_import(
    install: &crate::InstallRecord,
    port: &PortDefinition,
    platform: Platform,
) -> Result<bool> {
    let build = crate::install::retained_build_identity_for_install(install)?;
    if build.platform != platform
        || !crate::profile_loader::installed_loader(install, &build)?
            .is_some_and(|loader| loader.engine == ModEngine::N64Recomp)
    {
        return Ok(false);
    }
    let Some(retained) = crate::install::retained_catalog_for_install(install)? else {
        return Ok(false);
    };
    let retained = retained.port(&install.port_id)?;
    Ok(install.port_id == port.id
        && retained.platforms.contains(&platform)
        && retained_runtime_matches(retained, port)
        && reviewed_source(port, platform, ModSourceAuthority::Inspect)
            .is_some_and(|source| source.inspection_layout(platform).is_some()))
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
    /// The active installed build admits native companion import on this
    /// platform. False when the game is not installed or its installed build
    /// predates the reviewed loader; the releases remain a link-out.
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
    /// The active installed build admits native import on the reviewed
    /// platform and its runtime meets every mod's minimum runtime version.
    pub native_import_offered: bool,
}

impl PortcoveService {
    fn active_install(&self, port: &PortDefinition) -> Result<Option<crate::InstallRecord>> {
        Ok(self
            .library()
            .status(&port.id, crate::service::default_channel(port))?
            .active)
    }

    /// Native import eligibility for the active installation only. A port that
    /// is not installed keeps a pure link-out. An installed build whose
    /// retained identity no longer verifies offers no native import; the setups
    /// view reports that build as changed or missing on its own.
    pub(crate) fn github_native_import(
        &self,
        port: &PortDefinition,
        platform: Option<Platform>,
    ) -> Result<bool> {
        let Some(platform) = platform else {
            return Ok(false);
        };
        match self.active_install(port)? {
            Some(install) => Ok(installed_native_import(&install, port, platform).unwrap_or(false)),
            None => Ok(false),
        }
    }

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
        let binding =
            reviewed_source(port, platform, ModSourceAuthority::Browse).ok_or_else(|| {
                PortcoveError::unsupported("this port has no reviewed GitHub mod source")
            })?;
        let library = self.library();
        let http = ProviderHttp::new(Some(library.clone()), "GitHub Releases", "github.com")?
            .with_backoff(library.github_mod_backoff.clone());
        let repository = format!("{API}/repositories/{}", binding.repository_id);
        let identity = http
            .observe(endpoint(&repository)?, |row| {
                require_repository_identity(binding, row)
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
            source_url: binding.releases_url(),
            native_import_offered: self.github_native_import(port, Some(platform))?,
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
        let native_import_offered = match self.active_install(port)? {
            Some(install) => {
                installed_native_import(&install, port, platform)?
                    && check_runtime(&install.version, &staged.review).is_ok()
            }
            None => false,
        };
        Ok(GithubModCompoundReview {
            port_id: port_id.into(),
            repository: source.repository.into(),
            repository_id: source.repository_id,
            release_id,
            asset_id,
            review: staged.review,
            native_import_offered,
        })
    }

    async fn stage_github_mod_archive<'a>(
        &self,
        port: &'a PortDefinition,
        platform: Platform,
        release_id: u64,
        asset_id: u64,
        expected_tag: Option<&str>,
        archive: Option<&Path>,
    ) -> Result<(
        ReviewedSource<'a>,
        &'a CompanionLayout,
        String,
        recomp_companion_review::StagedCompoundReview,
    )> {
        let source =
            reviewed_source(port, platform, ModSourceAuthority::Inspect).ok_or_else(|| {
                PortcoveError::unsupported("this port has no reviewed GitHub mod source")
            })?;
        let layout = source
            .inspection_layout(platform)
            .filter(|_| port.platforms.contains(&platform))
            .ok_or_else(|| {
                PortcoveError::unsupported(
                    "this source has no reviewed companion layout for the platform",
                )
            })?;
        let library = self.library();
        let http = ProviderHttp::new(Some(library.clone()), "GitHub Releases", "github.com")?
            .with_backoff(library.github_mod_backoff.clone());
        let selected =
            observe_exact_release(&http, source, release_id, asset_id, expected_tag).await?;
        let digest = selected.asset.published_sha256.as_deref().ok_or_else(|| {
            PortcoveError::verification("GitHub did not publish a SHA-256 for the selected ZIP")
        })?;
        let tag = selected.tag.clone();
        let bytes = selected.asset.bytes;
        let digest = digest.to_owned();
        let (archive, temporary) = if let Some(archive) = archive {
            (archive.to_path_buf(), None)
        } else {
            let temporary = tempfile::tempdir()?;
            let path = temporary.path().join("download.zip");
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
        let game = source
            .game()
            .ok_or_else(|| PortcoveError::unsupported("the port has no reviewed Recomp game"))?;
        let (selected_layout, companions) = (layout.clone(), source.companions.to_vec());
        let review = tokio::task::spawn_blocking(move || {
            let _download_custody = temporary;
            recomp_companion_review::stage(
                &archive,
                bytes,
                &digest,
                &game,
                &selected_layout,
                &companions,
            )
        })
        .await
        .map_err(|_| PortcoveError::state("Recomp wrapper review worker stopped"))??;
        Ok((source, layout, tag, review))
    }
}

fn require_repository_identity(binding: ReviewedSource<'_>, row: &Value) -> Result<()> {
    if row["id"].as_u64() != Some(binding.repository_id)
        || row["full_name"].as_str() != Some(binding.repository)
        || row["private"].as_bool() != Some(false)
    {
        return Err(PortcoveError::verification(
            "GitHub mod repository identity changed",
        ));
    }
    Ok(())
}

fn exact_release(
    binding: ReviewedSource<'_>,
    row: &Value,
    release_id: u64,
    asset_id: u64,
    expected_tag: Option<&str>,
) -> Result<GithubModRelease> {
    let release = parse_release(binding, row).filter(|release| {
        row["draft"].as_bool() == Some(false)
            && row["prerelease"].as_bool() == Some(false)
            && release.release_id == release_id
            && release.asset.asset_id == asset_id
            && expected_tag.is_none_or(|tag| tag == release.tag)
            && release.asset.published_sha256.is_some()
    });
    release.ok_or_else(|| {
        PortcoveError::verification(
            "the exact GitHub release, tag or reviewed ZIP identity changed or is unavailable",
        )
    })
}

async fn observe_exact_release(
    http: &ProviderHttp,
    binding: ReviewedSource<'_>,
    release_id: u64,
    asset_id: u64,
    expected_tag: Option<&str>,
) -> Result<GithubModRelease> {
    if release_id == 0 || asset_id == 0 {
        return Err(PortcoveError::usage(
            "positive GitHub release and asset IDs are required",
        ));
    }
    let repository = format!("{API}/repositories/{}", binding.repository_id);
    let identity = http
        .observe(endpoint(&repository)?, |row| {
            require_repository_identity(binding, row)
        })
        .await?;
    let exact = http
        .observe(
            endpoint(&format!("{repository}/releases/{release_id}"))?,
            |row| exact_release(binding, row, release_id, asset_id, expected_tag),
        )
        .await?;
    let mut tag_url = endpoint(&format!("{repository}/releases/tags"))?;
    tag_url
        .path_segments_mut()
        .map_err(|_| PortcoveError::verification("invalid GitHub release route"))?
        .push(&exact.value.tag);
    let by_tag = http
        .observe(tag_url, |row| {
            exact_release(binding, row, release_id, asset_id, Some(&exact.value.tag))
        })
        .await?;
    let by_asset = http
        .observe(
            endpoint(&format!("{repository}/releases/assets/{asset_id}"))?,
            |row| {
                parse_asset(row, binding).ok_or_else(|| {
                    PortcoveError::verification("the exact GitHub ZIP is unavailable")
                })
            },
        )
        .await?;
    if [
        identity.freshness,
        exact.freshness,
        by_tag.freshness,
        by_asset.freshness,
    ]
    .contains(&ProviderFreshness::Stale)
        || by_tag.value.asset != exact.value.asset
        || by_asset.value != exact.value.asset
    {
        return Err(PortcoveError::verification(
            "fresh GitHub release and asset records must agree before reviewing this ZIP",
        ));
    }
    Ok(exact.value)
}

fn endpoint(raw: &str) -> Result<Url> {
    Url::parse(raw).map_err(|_| PortcoveError::state("invalid reviewed GitHub mod endpoint"))
}

fn public_id(value: &Value) -> Option<u64> {
    value.as_u64().filter(|id| (1..=(1 << 53) - 1).contains(id))
}

fn parse_asset(row: &Value, binding: ReviewedSource<'_>) -> Option<GithubModAsset> {
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

fn release_tag(value: &Value) -> Option<&str> {
    value["tag_name"].as_str().filter(|text| {
        !text.is_empty()
            && text.len() <= 128
            && sanitize_text(text) == *text
            && *text != "."
            && *text != ".."
    })
}

fn missing_named_asset(binding: ReviewedSource<'_>, value: &Value) -> bool {
    public_id(&value["id"]).is_some()
        && release_tag(value).is_some()
        && value["assets"].as_array().is_some_and(|assets| {
            assets.len() <= MAX_ASSETS
                && assets.iter().all(|asset| {
                    asset["name"]
                        .as_str()
                        .is_some_and(|name| !name.is_empty() && name != binding.asset_name)
                })
        })
}

fn parse_release(binding: ReviewedSource<'_>, value: &Value) -> Option<GithubModRelease> {
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
    let tag = release_tag(value)?;
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
    binding: ReviewedSource<'_>,
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
        if let Some(id) = public_id(&row["id"])
            && !ids.insert(id)
        {
            return Err(PortcoveError::verification(
                "duplicate GitHub mod release identity",
            ));
        }
        let Some(release) = parse_release(binding, row) else {
            complete &= missing_named_asset(binding, row);
            continue;
        };
        if !asset_ids.insert(release.asset.asset_id) {
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
    fn old_releases_without_the_named_zip_do_not_hold_exact_review() {
        let catalog = crate::Catalog::embedded().unwrap();
        let binding = zelda_source(&catalog);
        let release = json!({
            "id": 90, "tag_name": "v2", "draft": false, "prerelease": false,
            "assets": [{"id": 20, "name": binding.asset_name, "size": 24,
                        "state": "uploaded", "digest": format!("sha256:{}", "a".repeat(64))}]
        });
        let previous = json!({
            "id": 89, "tag_name": "v1", "draft": false, "prerelease": false,
            "assets":[{"name":"notes.txt"}]
        });
        let (offerings, complete) =
            project_releases(binding, &json!([release.clone(), previous.clone()])).unwrap();
        assert!(complete);
        assert_eq!(offerings.len(), 1);
        let mut broken_history = previous;
        broken_history["assets"] = Value::Null;
        assert!(
            !project_releases(binding, &json!([release.clone(), broken_history]))
                .unwrap()
                .1
        );
        assert!(exact_release(binding, &release, 90, 20, Some("v2")).is_ok());
        assert!(exact_release(binding, &release, 89, 20, Some("v2")).is_err());
        assert!(exact_release(binding, &release, 90, 19, Some("v2")).is_err());
        assert!(exact_release(binding, &release, 90, 20, Some("v1")).is_err());
        let mut malformed = release.clone();
        malformed["assets"][0]["digest"] = json!("sha256:too-short");
        assert!(exact_release(binding, &malformed, 90, 20, None).is_err());
        let mut denied = release;
        denied["draft"] = json!(true);
        assert!(exact_release(binding, &denied, 90, 20, None).is_err());
    }

    #[test]
    fn declared_source_and_reviewed_loader_decide_each_authority() {
        let catalog = crate::Catalog::embedded().unwrap();
        let linux = Some(Platform::LinuxX86_64);
        let mut port = catalog.port("zelda64-recomp").unwrap().clone();
        assert!(has_github_mod_source(&port));
        assert!(!has_github_mod_source(catalog.port("shipwright").unwrap()));
        assert_eq!(
            github_mod_release_url(&port, linux).as_deref(),
            Some("https://github.com/RecompRando/MMRecompRando/releases")
        );
        assert_eq!(github_mod_release_url(&port, None), None);
        assert_eq!(
            github_mod_release_url(catalog.port("shipwright").unwrap(), linux),
            None
        );
        // An installed build must still describe this runtime and game.
        let retained = port.clone();
        assert!(retained_runtime_matches(&retained, &port));
        let mut other_runtime = retained.clone();
        other_runtime.release.repository = "unrelated/unreviewed".into();
        assert!(!retained_runtime_matches(&other_runtime, &port));
        // Inspection needs the definition's reviewed Recomp loader.
        let mut without_loader = port.clone();
        without_loader.mod_loader = None;
        without_loader.id = "unreviewed-recomp-runtime".into();
        let source = reviewed_source(
            &without_loader,
            Platform::LinuxX86_64,
            ModSourceAuthority::Browse,
        )
        .unwrap();
        assert!(source.inspection_layout(Platform::LinuxX86_64).is_none());
        // Withdrawing the declaration withdraws the link and every reader.
        port.mod_sources.clear();
        assert!(!has_github_mod_source(&port));
        assert_eq!(github_mod_release_url(&port, linux), None);
        assert!(
            reviewed_source(&port, Platform::LinuxX86_64, ModSourceAuthority::LinkOut).is_none()
        );
    }

    fn service_with_install(version: Option<&str>) -> (tempfile::TempDir, PortcoveService) {
        let temporary = tempfile::tempdir().unwrap();
        let library = crate::Library::open(temporary.path().join("library")).unwrap();
        if let Some(version) = version {
            crate::retained_build::tests::install_fixture_port(
                &library,
                &crate::Catalog::embedded().unwrap(),
                "zelda64-recomp",
                "installed",
                version,
                b"recomp runtime",
                true,
            );
        }
        (temporary, PortcoveService::new_read_only(library).unwrap())
    }

    fn zelda_source(catalog: &crate::Catalog) -> ReviewedSource<'_> {
        crate::mod_source::github(
            catalog.port("zelda64-recomp").unwrap(),
            Platform::LinuxX86_64,
        )
        .unwrap()
    }

    fn host_has_layout(platform: Platform) -> bool {
        let catalog = crate::Catalog::embedded().unwrap();
        zelda_source(&catalog)
            .companions
            .iter()
            .any(|layout| layout.platform == platform)
    }

    #[test]
    fn native_import_comes_from_the_installed_build_not_the_definition() {
        let platform = Platform::current().unwrap();
        let (_temporary, service) = service_with_install(Some("v1.2.2"));
        let port = service.catalog().port("zelda64-recomp").unwrap();
        assert_eq!(
            service.github_native_import(port, Some(platform)).unwrap(),
            host_has_layout(platform)
        );
        assert!(!service.github_native_import(port, None).unwrap());
        let other = [Platform::WindowsX86_64, Platform::LinuxX86_64]
            .into_iter()
            .find(|candidate| *candidate != platform)
            .unwrap();
        assert!(!service.github_native_import(port, Some(other)).unwrap());
        let handoff = service.preview_mod_handoff("zelda64-recomp").unwrap();
        assert_eq!(
            handoff.github_release_url.as_deref(),
            Some("https://github.com/RecompRando/MMRecompRando/releases")
        );
        assert_eq!(
            handoff.github_native_import_offered,
            host_has_layout(platform)
        );
    }

    #[test]
    fn an_install_that_predates_the_loader_keeps_only_the_link_out() {
        let platform = Platform::current().unwrap();
        let (_temporary, service) = service_with_install(Some("v1.1.0"));
        let port = service.catalog().port("zelda64-recomp").unwrap();
        assert!(!service.github_native_import(port, Some(platform)).unwrap());
        for view in [
            service.preview_mod_handoff("zelda64-recomp").unwrap(),
            service.preview_mod_setups("zelda64-recomp").unwrap(),
        ] {
            assert!(view.github_release_url.is_some());
            assert!(!view.github_native_import_offered);
        }
    }

    #[test]
    fn a_changed_installed_build_offers_no_native_import() {
        let platform = Platform::current().unwrap();
        let (_temporary, service) = service_with_install(Some("v1.2.2"));
        let port = service.catalog().port("zelda64-recomp").unwrap().clone();
        let install = service.active_install(&port).unwrap().unwrap();
        std::fs::write(install.path.join(".portcove-manifest.json"), b"changed").unwrap();
        assert!(installed_native_import(&install, &port, platform).is_err());
        assert!(!service.github_native_import(&port, Some(platform)).unwrap());
        let view = service.preview_mod_handoff("zelda64-recomp").unwrap();
        assert!(view.github_release_url.is_some());
        assert!(!view.github_native_import_offered);
    }

    #[test]
    fn a_game_that_is_not_installed_is_a_pure_link_out() {
        let platform = Platform::current().unwrap();
        let (_temporary, service) = service_with_install(None);
        let port = service.catalog().port("zelda64-recomp").unwrap();
        assert!(!service.github_native_import(port, Some(platform)).unwrap());
        for view in [
            service.preview_mod_handoff("zelda64-recomp").unwrap(),
            service.preview_mod_setups("zelda64-recomp").unwrap(),
        ] {
            assert_eq!(
                view.github_release_url.as_deref(),
                Some("https://github.com/RecompRando/MMRecompRando/releases")
            );
            assert!(!view.github_native_import_offered);
        }
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
        let catalog = crate::Catalog::embedded().unwrap();
        let source = zelda_source(&catalog);
        let (files, complete) = project_releases(source, &json!([ready.clone()])).unwrap();
        assert!(complete);
        assert_eq!(files[0].release_id, 91);
        assert_eq!(files[0].asset.asset_id, 17);
        assert_eq!(
            files[0].asset.published_sha256.as_deref(),
            Some("a".repeat(64).as_str())
        );
        assert!(files[0].release_url.ends_with("v1.2.3%2Fpreview"));
        assert!(project_releases(source, &json!([ready.clone(), ready.clone()])).is_err());
        let mut corrupt = ready;
        corrupt["assets"][1]["digest"] = json!("md5:0000");
        let (files, complete) = project_releases(source, &json!([corrupt])).unwrap();
        assert!(files.is_empty());
        assert!(!complete);
    }

    #[test]
    #[ignore = "natural-event observation, not ordinary coverage: requires the real retained GitHub release metadata for the reviewed mod source in PORTCOVE_GITHUB_MOD_RELEASES"]
    fn real_release_successor_retains_numeric_github_identity() {
        let path = std::env::var_os("PORTCOVE_GITHUB_MOD_RELEASES").unwrap();
        let metadata: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        let catalog = crate::Catalog::embedded().unwrap();
        let (releases, _) = project_releases(zelda_source(&catalog), &metadata).unwrap();
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
