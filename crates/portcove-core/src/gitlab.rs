use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};

use async_trait::async_trait;
use reqwest::{StatusCode, header};
use serde::{Deserialize, de::DeserializeOwned};
use tokio::sync::RwLock;

use crate::{
    Library, Platform, PortDefinition, PortcoveError, ReleaseAsset, ReleaseChannel,
    ReleaseProvider, ReleaseSource, ResolvedRelease, Result, library::HttpCacheEntry,
};

#[derive(Clone)]
pub struct GitlabReleaseProvider {
    client: reqwest::Client,
    api_root: String,
    library: Option<Library>,
    cache: Arc<RwLock<HashMap<CacheKey, CachedRelease>>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct CacheKey {
    repository: String,
    channel: ReleaseChannel,
    platform: Platform,
}

#[derive(Debug, Clone)]
struct CachedRelease {
    stored_at: Instant,
    release: ResolvedRelease,
}

const RELEASE_CACHE_TTL: Duration = Duration::from_secs(5 * 60);

impl GitlabReleaseProvider {
    pub fn for_library(library: &Library) -> Result<Self> {
        Self::build(Some(library.clone()), "https://gitlab.com/api/v4")
    }

    fn build(library: Option<Library>, api_root: &str) -> Result<Self> {
        let client = reqwest::Client::builder()
            .user_agent(concat!("Portcove/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|error| PortcoveError::network(error.to_string()))?;
        Ok(Self {
            client,
            api_root: api_root.trim_end_matches('/').into(),
            library,
            cache: Arc::new(RwLock::new(HashMap::new())),
        })
    }

    #[cfg(test)]
    pub fn with_api_root(api_root: impl AsRef<str>) -> Result<Self> {
        Self::build(None, api_root.as_ref())
    }

    fn project_url(&self, repository: &str) -> Result<String> {
        let mut url = reqwest::Url::parse(&self.api_root)
            .map_err(|error| PortcoveError::state(error.to_string()))?;
        url.path_segments_mut()
            .map_err(|_| PortcoveError::state("GitLab API root cannot accept path segments"))?
            .extend(["projects", repository]);
        Ok(url.into())
    }

    fn cached_http_response(&self, url: &str) -> Option<HttpCacheEntry> {
        self.library.as_ref().and_then(|library| {
            library
                .http_cache(url)
                .map_err(|error| tracing::warn!(%error, %url, "could not read HTTP cache"))
                .ok()
                .flatten()
        })
    }

    async fn get_json<T: DeserializeOwned>(&self, url: &str) -> Result<T> {
        let cached = self.cached_http_response(url);
        let mut request = self.client.get(url);
        if let Some(cached) = cached.as_ref() {
            if let Some(etag) = cached.etag.as_deref() {
                request = request.header(header::IF_NONE_MATCH, etag);
            }
            if let Some(modified) = cached.last_modified.as_deref() {
                request = request.header(header::IF_MODIFIED_SINCE, modified);
            }
        }
        let response = request
            .send()
            .await
            .map_err(|error| PortcoveError::network(error.to_string()))?;
        if response.status() == StatusCode::NOT_MODIFIED {
            let body = cached
                .ok_or_else(|| PortcoveError::state("GitLab returned 304 without cached data"))?
                .body;
            return serde_json::from_str(&body)
                .map_err(|error| PortcoveError::network(error.to_string()));
        }
        if !response.status().is_success() {
            return Err(PortcoveError::network(format!(
                "GitLab API returned {}",
                response.status()
            )));
        }
        let etag = response
            .headers()
            .get(header::ETAG)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let last_modified = response
            .headers()
            .get(header::LAST_MODIFIED)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let body = response
            .text()
            .await
            .map_err(|error| PortcoveError::network(error.to_string()))?;
        if let Some(library) = &self.library
            && let Err(error) =
                library.store_http_cache(url, etag.as_deref(), last_modified.as_deref(), &body)
        {
            tracing::warn!(%error, %url, "could not persist HTTP cache");
        }
        serde_json::from_str(&body).map_err(|error| PortcoveError::network(error.to_string()))
    }

    async fn package_file(
        &self,
        project_url: &str,
        project_id: u64,
        release: &GitlabRelease,
        link: &GitlabReleaseLink,
    ) -> Result<Option<GitlabPackageFile>> {
        let Some(file_id) = package_file_id(&link.url) else {
            return Ok(None);
        };
        let packages_url = format!(
            "{project_url}/packages?package_type=generic&order_by=created_at&sort=desc&per_page=100"
        );
        let packages: Vec<GitlabPackage> = self.get_json(&packages_url).await?;
        let normalized_tag = release.tag_name.trim_start_matches('v');
        let mut package_ids: Vec<u64> = packages
            .iter()
            .filter(|package| {
                package.version == release.tag_name || package.version == normalized_tag
            })
            .map(|package| package.id)
            .collect();
        let remaining: Vec<u64> = packages
            .iter()
            .filter(|package| !package_ids.contains(&package.id))
            .map(|package| package.id)
            .collect();
        package_ids.extend(remaining);
        for package_id in package_ids {
            let url = format!(
                "{}/projects/{project_id}/packages/{package_id}/package_files",
                self.api_root
            );
            let files: Vec<GitlabPackageFile> = self.get_json(&url).await?;
            if let Some(file) = files.into_iter().find(|file| file.id == file_id) {
                return Ok(Some(file));
            }
        }
        Ok(None)
    }

    async fn cached_release(&self, key: &CacheKey) -> Option<ResolvedRelease> {
        self.cache
            .read()
            .await
            .get(key)
            .filter(|entry| entry.stored_at.elapsed() < RELEASE_CACHE_TTL)
            .map(|entry| entry.release.clone())
    }

    async fn store_release(&self, key: CacheKey, release: ResolvedRelease) {
        self.cache.write().await.insert(
            key,
            CachedRelease {
                stored_at: Instant::now(),
                release,
            },
        );
    }
}

#[async_trait]
impl ReleaseProvider for GitlabReleaseProvider {
    async fn resolve(
        &self,
        port: &PortDefinition,
        channel: ReleaseChannel,
        platform: Platform,
    ) -> Result<ResolvedRelease> {
        if port.release.provider != ReleaseSource::Gitlab {
            return Err(PortcoveError::unsupported(format!(
                "{} does not use GitLab releases",
                port.name
            )));
        }
        if !port.channels.contains(&channel) || !port.platforms.contains(&platform) {
            return Err(PortcoveError::unsupported(format!(
                "{} does not offer {channel} releases for {platform:?}",
                port.name
            )));
        }
        let key = CacheKey {
            repository: port.release.repository.clone(),
            channel,
            platform,
        };
        if let Some(release) = self.cached_release(&key).await {
            return Ok(release);
        }
        let project_url = self.project_url(&port.release.repository)?;
        let project: GitlabProject = self.get_json(&project_url).await?;
        if project.archived.unwrap_or(false) {
            return Err(PortcoveError::unsupported(format!(
                "{} is archived upstream",
                port.name
            )));
        }
        let releases: Vec<GitlabRelease> = self
            .get_json(&format!("{project_url}/releases?per_page=30"))
            .await?;
        let release = crate::release::select_channel_candidate(
            &releases,
            channel,
            port.release.rolling_tag.as_deref(),
            |release| !release.upcoming_release,
            |release| is_beta_tag(&release.tag_name),
            |release| release.tag_name.as_str(),
        )
        .ok_or_else(|| {
            PortcoveError::not_found(format!(
                "no published {channel} release exists for {}",
                port.name
            ))
        })?;
        let link = choose_link(port, platform, &release.assets.links)?;
        let package_file = self
            .package_file(&project_url, project.id, release, link)
            .await?;
        let (name, size, sha256) = if let Some(file) = package_file {
            (file.file_name, file.size, file.file_sha256)
        } else {
            let sha256 =
                digest_from_description(&release.description, &link.name).ok_or_else(|| {
                    PortcoveError::verification(format!(
                        "{} does not publish a SHA-256 digest for {}",
                        port.name, link.name
                    ))
                })?;
            (link.name.clone(), 0, sha256)
        };
        let resolved = ResolvedRelease {
            version: release.tag_name.clone(),
            channel,
            published_at: release.released_at.clone(),
            asset: ReleaseAsset {
                name,
                url: link
                    .direct_asset_url
                    .clone()
                    .unwrap_or_else(|| link.url.clone()),
                size,
                sha256,
            },
        };
        self.store_release(key, resolved.clone()).await;
        Ok(resolved)
    }
}

#[derive(Debug, Deserialize)]
struct GitlabProject {
    id: u64,
    #[serde(default)]
    archived: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct GitlabRelease {
    tag_name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    released_at: Option<String>,
    #[serde(default)]
    upcoming_release: bool,
    assets: GitlabReleaseAssets,
}

#[derive(Debug, Deserialize)]
struct GitlabReleaseAssets {
    #[serde(default)]
    links: Vec<GitlabReleaseLink>,
}

#[derive(Debug, Deserialize)]
struct GitlabReleaseLink {
    name: String,
    url: String,
    #[serde(default)]
    direct_asset_url: Option<String>,
    #[serde(default)]
    link_type: String,
}

#[derive(Debug, Deserialize)]
struct GitlabPackage {
    id: u64,
    version: String,
}

#[derive(Debug, Deserialize)]
struct GitlabPackageFile {
    id: u64,
    file_name: String,
    size: u64,
    file_sha256: String,
}

fn choose_link<'a>(
    port: &PortDefinition,
    platform: Platform,
    links: &'a [GitlabReleaseLink],
) -> Result<&'a GitlabReleaseLink> {
    let hints = port
        .release
        .asset_hints
        .get(&platform)
        .cloned()
        .unwrap_or_default();
    let mut scored: Vec<(i32, &GitlabReleaseLink)> = links
        .iter()
        .filter_map(|link| {
            let name = link.name.to_ascii_lowercase();
            if link.link_type != "package" || conflicts_with_platform(&name, platform) {
                return None;
            }
            let platform_score = platform
                .asset_tokens()
                .iter()
                .filter(|token| name.contains(**token))
                .count() as i32
                * 10;
            let hint_score = hints
                .iter()
                .filter(|hint| name.contains(&hint.to_ascii_lowercase()))
                .count() as i32
                * 100;
            Some((platform_score + hint_score, link))
        })
        .collect();
    scored.sort_by(|left, right| {
        right
            .0
            .cmp(&left.0)
            .then_with(|| left.1.name.cmp(&right.1.name))
    });
    scored.first().map(|(_, link)| *link).ok_or_else(|| {
        PortcoveError::not_found(format!(
            "{} has no supported GitLab package for {platform:?}",
            port.name
        ))
    })
}

fn conflicts_with_platform(name: &str, platform: Platform) -> bool {
    match platform {
        Platform::WindowsX86_64 => ["linux", "flatpak", "macos", "darwin", "arm64", "aarch64"],
        Platform::LinuxX86_64 => ["windows", "win64", "macos", "darwin", "arm64", "aarch64"],
        Platform::MacosX86_64 => ["windows", "win64", "linux", "flatpak", "arm64", "aarch64"],
        Platform::MacosAarch64 => ["windows", "win64", "linux", "flatpak", "x86_64", "x64"],
    }
    .iter()
    .any(|value| name.contains(value))
}

fn package_file_id(url: &str) -> Option<u64> {
    let segments: Vec<&str> = url.split('/').collect();
    segments
        .windows(2)
        .find(|parts| parts[0] == "package_files")
        .and_then(|parts| parts[1].parse().ok())
}

fn digest_from_description(description: &str, asset_name: &str) -> Option<String> {
    description.lines().find_map(|line| {
        if !line
            .to_ascii_lowercase()
            .contains(&asset_name.to_ascii_lowercase())
        {
            return None;
        }
        line.split(|character: char| !character.is_ascii_hexdigit())
            .find(|value| value.len() == 64)
            .map(str::to_ascii_lowercase)
    })
}

fn is_beta_tag(tag: &str) -> bool {
    let tag = tag.to_ascii_lowercase();
    [
        "-alpha",
        "-beta",
        "-rc",
        "-pre",
        "-preview",
        "-dev",
        "-nightly",
        "-canary",
        "-experimental",
    ]
    .iter()
    .any(|marker| tag.contains(marker))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_paths_are_percent_encoded() {
        let provider = GitlabReleaseProvider::with_api_root("https://gitlab.example/api/v4")
            .expect("provider");
        assert_eq!(
            provider.project_url("group/project name").unwrap(),
            "https://gitlab.example/api/v4/projects/group%2Fproject%20name"
        );
    }

    #[test]
    fn extracts_package_file_ids_and_description_digests() {
        assert_eq!(
            package_file_id("https://gitlab.example/group/project/-/package_files/123/download"),
            Some(123)
        );
        let digest = "a".repeat(64);
        assert_eq!(
            digest_from_description(
                &format!("game-windows.zip SHA-256: {digest}"),
                "game-windows.zip"
            ),
            Some(digest)
        );
    }
}
