//! Opt-in, descriptive OpenGOAL community catalog. OpenGOAL owns acquisition.
use reqwest::Url;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use crate::{
    AdapterKind, Platform, PortDefinition, PortcoveError, PortcoveService, ProviderFreshness,
    Result,
    mod_provider::sanitize_text,
    provider_http::{ProviderBackoff, ProviderHttp},
};

pub const JAKMODS_SETUP_URL: &str = "https://jakmods.dev/#installation";
const SOURCE: &str = "https://jakmods.dev/";
const FEED: &str = "https://jakmods.dev/mods.json";
// The feed is read whole under the shared provider response bound, so every row
// is projected. A row count is not a coverage limit: truncating before game
// filtering or date ordering let unrelated or older rows hide eligible ones.

/// Library clones share provider backoff when the host opens a new read service.
#[derive(Debug, Clone, Default)]
pub(crate) struct JakModsProviderState {
    backoff: ProviderBackoff,
    #[cfg(test)]
    pub(super) fixture_feed: std::sync::Arc<std::sync::OnceLock<Url>>,
}

impl JakModsProviderState {
    fn endpoint(&self) -> Url {
        #[cfg(test)]
        if let Some(endpoint) = self.fixture_feed.get() {
            return endpoint.clone();
        }
        Url::parse(FEED).expect("fixed JakMods feed")
    }
}

/// The game scope comes from the reviewed OpenGOAL setup, including its source.
pub fn jakmods_game(port: &PortDefinition) -> Option<&'static str> {
    if port.adapter != AdapterKind::UpstreamManagedSetup
        || !port
            .release
            .repository
            .eq_ignore_ascii_case("open-goal/jak-project")
        || port.setup_arguments.first()?.as_str() != "--game"
        || port.launch_arguments.get(..2)? != port.setup_arguments.get(..2)?
    {
        return None;
    }
    let game = game_key(port.setup_arguments.get(1)?)?;
    (port.source_profile.as_deref()? == format!("opengoal-{game}-disc")).then_some(game)
}

fn game_key(game: &str) -> Option<&'static str> {
    match game {
        "jak1" => Some("jak1"),
        "jak2" => Some("jak2"),
        "jak3" => Some("jak3"),
        _ => None,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum JakModsProjectKind {
    OpenGoalBuild,
    External,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum JakModsBuildStatus {
    Available,
    Unavailable,
    Unknown,
    External,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct JakModsBuild {
    pub platform: Platform,
    /// The upstream download count for this release asset alone.
    pub downloads: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct JakModsRelease {
    pub version: String,
    pub published_at: Option<i64>,
    pub builds: Vec<JakModsBuild>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct JakModsProject {
    pub id: String,
    pub name: String,
    pub summary: Option<String>,
    pub artwork_url: Option<String>,
    pub website_url: Option<String>,
    pub external_url: Option<String>,
    pub supported_games: Vec<String>,
    pub kind: JakModsProjectKind,
    pub build_status: JakModsBuildStatus,
    pub releases: Vec<JakModsRelease>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct JakModsCatalog {
    pub port_id: String,
    pub game: String,
    pub platform: Platform,
    pub projects: Vec<JakModsProject>,
    pub complete: bool,
    pub observed_at: i64,
    pub freshness: ProviderFreshness,
    pub source_url: String,
    pub feed_url: String,
    pub setup_url: String,
}

impl PortcoveService {
    /// Explicit browse. Game availability can be checked locally with `jakmods_game`.
    pub async fn jakmods_catalog(
        &self,
        port_id: &str,
        platform: Platform,
    ) -> Result<JakModsCatalog> {
        let port = self.catalog().port(port_id)?;
        let game = jakmods_game(port).ok_or_else(|| {
            PortcoveError::unsupported("this port has no reviewed JakMods game scope")
        })?;
        if !port.platforms.contains(&platform) {
            return Err(PortcoveError::unsupported(
                "this port does not list that platform",
            ));
        }
        let library = self.library();
        let http = ProviderHttp::new(Some(library.clone()), "JakMods", "jakmods.dev")?
            .with_backoff(library.jakmods.backoff.clone());
        let observed = http
            .observe(library.jakmods.endpoint(), |value| {
                project_feed(value, game, platform)
            })
            .await?;
        let (projects, complete) = observed.value;
        Ok(JakModsCatalog {
            port_id: port_id.into(),
            game: game.into(),
            platform,
            projects,
            complete,
            observed_at: observed.observed_at,
            freshness: observed.freshness,
            source_url: SOURCE.into(),
            feed_url: FEED.into(),
            setup_url: JAKMODS_SETUP_URL.into(),
        })
    }
}

fn scope(value: &Value) -> Option<Vec<String>> {
    let rows = value.as_array()?;
    if rows.is_empty() || rows.len() > 3 {
        return None;
    }
    let mut games = Vec::new();
    for value in rows {
        let game = game_key(value.as_str()?)?;
        if games.iter().any(|entry| entry == game) {
            return None;
        }
        games.push(game.to_owned());
    }
    Some(games)
}

fn text(value: &Value) -> Option<String> {
    Some(sanitize_text(value.as_str()?)).filter(|value| !value.is_empty())
}

fn safe_url(value: &Value) -> Option<Url> {
    let source = value.as_str()?;
    if source.len() > 1024 || source.chars().any(char::is_control) {
        return None;
    }
    let url = Url::parse(source).ok()?;
    if url.scheme() != "https"
        || url.port_or_known_default() != Some(443)
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    // Public DNS names only. Numeric addresses and local names are never handed off.
    let domain = url.domain()?;
    (domain.contains('.') && !domain.ends_with(".local") && !domain.ends_with(".localhost"))
        .then_some(url)
}

fn project_url(value: &Value) -> Option<String> {
    let url = safe_url(value)?;
    matches!(
        url.host_str(),
        Some("github.com" | "jakmods.dev" | "teamruns.web.app")
    )
    .then(|| url.into())
}

fn artwork(value: &Value) -> Option<String> {
    let url = safe_url(value)?;
    matches!(
        url.host_str(),
        Some("raw.githubusercontent.com" | "jakmods.dev")
    )
    .then(|| url.into())
}

fn build_platform(key: &str, asset: &Url) -> Option<Platform> {
    if asset.host_str() != Some("github.com") {
        return None;
    }
    let segments: Vec<_> = asset.path_segments()?.collect();
    let [_, _, "releases", "download", _, file] = segments.as_slice() else {
        return None;
    };
    let (platform, prefix, extension) = match key {
        "windows" => (Platform::WindowsX86_64, "windows-", ".zip"),
        "linux" => (Platform::LinuxX86_64, "linux-", ".tar.gz"),
        "macos" if file.starts_with("macos-intel-") => {
            (Platform::MacosX86_64, "macos-intel-", ".tar.gz")
        }
        "macos" if file.starts_with("macos-arm-") => {
            (Platform::MacosAarch64, "macos-arm-", ".tar.gz")
        }
        _ => return None,
    };
    let version = file.strip_prefix(prefix)?.strip_suffix(extension)?;
    has_build_version(version).then_some(platform)
}

// The retained JakMods feeds use the OpenGOAL mod-build filename convention:
// a v-prefixed numeric version, with optional variant or prerelease labels.
// An explicit conflicting architecture never inherits the platform of the key.
fn has_build_version(stem: &str) -> bool {
    let Some(stem) = stem.strip_prefix('v') else {
        return false;
    };
    let (numeric, variant) = stem
        .split_once('-')
        .map_or((stem, None), |(v, tail)| (v, Some(tail)));
    let mut parts = numeric.split('.');
    (0..3).all(|_| {
        parts
            .next()
            .is_some_and(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
    }) && parts.next().is_none()
        && variant.is_none_or(|variant| {
            variant.split(['.', '-']).all(|part| {
                !part.is_empty()
                    && part.bytes().all(|byte| byte.is_ascii_alphanumeric())
                    && !is_architecture_label(&part.to_ascii_lowercase())
            })
        })
}

fn is_architecture_label(part: &str) -> bool {
    matches!(
        part,
        "x86" | "x32" | "win32" | "32bit" | "universal" | "universal2"
    ) || [
        "arm",
        "aarch",
        "riscv",
        "ppc",
        "mips",
        "s390",
        "loongarch",
        "i386",
        "i486",
        "i586",
        "i686",
    ]
    .iter()
    .any(|prefix| part.starts_with(prefix))
}

fn parse_releases(value: &Value, game: &str) -> (Vec<JakModsRelease>, bool) {
    let Some(rows) = value.as_array() else {
        return (vec![], false);
    };
    let mut complete = true;
    let mut releases = Vec::new();
    for row in rows {
        let Some(games) = scope(&row["supportedGames"]) else {
            complete = false;
            continue;
        };
        if !games.iter().any(|item| item == game) {
            continue;
        }
        let (Some(version), Some(assets)) = (text(&row["version"]), row["assets"].as_object())
        else {
            complete = false;
            continue;
        };
        // The launcher feed expressly distinguishes a null asset from a missing
        // platform field. The latter cannot establish that no build is offered.
        complete &= ["windows", "linux", "macos"]
            .iter()
            .all(|key| assets.contains_key(*key));
        let mut builds = Vec::new();
        for (key, offered) in assets {
            if offered.is_null() {
                continue;
            }
            let Some(platform) = safe_url(offered).and_then(|asset| build_platform(key, &asset))
            else {
                complete = false;
                continue;
            };
            builds.push(JakModsBuild {
                platform,
                downloads: row["assetDownloadCounts"][key].as_u64(),
            });
        }
        builds.sort_by_key(|build| build.platform);
        let published_at = row["publishedDate"]
            .as_str()
            .and_then(|value| OffsetDateTime::parse(value, &Rfc3339).ok())
            .map(OffsetDateTime::unix_timestamp);
        releases.push(JakModsRelease {
            version,
            published_at,
            builds,
        });
    }
    releases.sort_by(|left, right| {
        right
            .published_at
            .cmp(&left.published_at)
            .then_with(|| left.version.cmp(&right.version))
    });
    (releases, complete)
}

fn project_feed(
    value: &Value,
    game: &str,
    platform: Platform,
) -> Result<(Vec<JakModsProject>, bool)> {
    if value["schemaVersion"] != "1.0.0" || value["sourceName"] != "JakMods" {
        return Err(PortcoveError::verification("unrecognized JakMods feed"));
    }
    let rows = value["mods"]
        .as_object()
        .ok_or_else(|| PortcoveError::verification("JakMods feed has no mod inventory"))?;
    let mut complete = true;
    let mut projects = Vec::new();
    for (id, row) in rows {
        let Some(supported_games) = scope(&row["supportedGames"]) else {
            complete = false;
            continue;
        };
        if !supported_games.iter().any(|entry| entry == game) {
            continue;
        }
        let override_for_game = &row["perGameConfig"][game];
        let Some(name) =
            text(&override_for_game["displayName"]).or_else(|| text(&row["displayName"]))
        else {
            complete = false;
            continue;
        };
        if id.is_empty()
            || id.len() > 128
            || !id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            complete = false;
            continue;
        }
        let (releases, release_complete) = parse_releases(&row["versions"], game);
        let external_url = project_url(&row["externalLink"]);
        complete &= row["externalLink"].is_null() || external_url.is_some();
        let (kind, build_status) = if !row["externalLink"].is_null() {
            (JakModsProjectKind::External, JakModsBuildStatus::External)
        } else if releases.iter().any(|release| {
            release
                .builds
                .iter()
                .any(|build| build.platform == platform)
        }) {
            (
                JakModsProjectKind::OpenGoalBuild,
                JakModsBuildStatus::Available,
            )
        } else if release_complete {
            (
                JakModsProjectKind::OpenGoalBuild,
                JakModsBuildStatus::Unavailable,
            )
        } else {
            (
                JakModsProjectKind::OpenGoalBuild,
                JakModsBuildStatus::Unknown,
            )
        };
        complete &= release_complete;
        projects.push(JakModsProject {
            id: id.clone(),
            name,
            summary: text(&override_for_game["description"]).or_else(|| text(&row["description"])),
            artwork_url: artwork(&override_for_game["coverArtUrl"])
                .or_else(|| artwork(&override_for_game["thumbnailArtUrl"]))
                .or_else(|| artwork(&row["coverArtUrl"]))
                .or_else(|| artwork(&row["thumbnailArtUrl"])),
            website_url: project_url(&row["websiteUrl"]),
            external_url,
            supported_games,
            kind,
            build_status,
            releases,
        });
    }
    let rank = |row: &JakModsProject| match row.build_status {
        JakModsBuildStatus::Available => 0,
        JakModsBuildStatus::External => 1,
        JakModsBuildStatus::Unknown => 2,
        JakModsBuildStatus::Unavailable => 3,
    };
    let latest = |row: &JakModsProject| {
        row.releases
            .iter()
            .filter(|release| {
                row.build_status != JakModsBuildStatus::Available
                    || release
                        .builds
                        .iter()
                        .any(|build| build.platform == platform)
            })
            .find_map(|release| release.published_at)
    };
    projects.sort_by(|left, right| {
        rank(left)
            .cmp(&rank(right))
            .then_with(|| latest(right).cmp(&latest(left)))
            .then_with(|| left.id.cmp(&right.id))
    });
    Ok((projects, complete))
}

#[cfg(test)]
#[path = "jakmods_tests.rs"]
mod tests;
