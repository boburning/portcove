use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};

use async_trait::async_trait;
use futures_util::{StreamExt, stream};
use reqwest::{StatusCode, header};
use serde::{Deserialize, de::DeserializeOwned};
use tokio::sync::RwLock;

use crate::{
    Library, Platform, PortDefinition, PortcoveError, ReleaseAsset, ReleaseChannel,
    ReleaseProvider, ReleaseSource, ResolvedRelease, Result,
    library::HttpCacheEntry,
    release::{PROVIDER_JSON_MAX_BYTES, bounded_response_bytes, paginated_url},
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
const PROVIDER_PAGE_SIZE: usize = 100;
const GITLAB_MAX_RELEASE_PAGES: usize = 10;
const GITLAB_MAX_PACKAGE_PAGES: usize = 10;
const GITLAB_MAX_MATCHING_PACKAGES: usize = 16;
const GITLAB_MAX_PACKAGE_FILE_PAGES: usize = 5;
const GITLAB_PACKAGE_LOOKUP_CONCURRENCY: usize = 4;

impl GitlabReleaseProvider {
    pub fn for_library(library: &Library) -> Result<Self> {
        Self::build(Some(library.clone()), "https://gitlab.com/api/v4")
    }

    fn build(library: Option<Library>, api_root: &str) -> Result<Self> {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
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

    #[cfg(test)]
    fn with_api_root_and_library(api_root: impl AsRef<str>, library: Library) -> Result<Self> {
        Self::build(Some(library), api_root.as_ref())
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
        self.get_optional_json(url).await?.ok_or_else(|| {
            PortcoveError::not_found(format!("GitLab resource was not found: {url}"))
        })
    }

    async fn get_optional_json<T: DeserializeOwned>(&self, url: &str) -> Result<Option<T>> {
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
            if body.len() > PROVIDER_JSON_MAX_BYTES {
                return Err(PortcoveError::verification(
                    "cached GitLab response exceeds the 4 MiB metadata limit",
                ));
            }
            return serde_json::from_str(&body)
                .map(Some)
                .map_err(|error| PortcoveError::network(error.to_string()));
        }
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !response.status().is_success() {
            return Err(gitlab_http_error(response.status(), response.headers()));
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
        let body =
            bounded_response_bytes(response, PROVIDER_JSON_MAX_BYTES, "GitLab response").await?;
        let parsed = serde_json::from_slice(&body)
            .map_err(|error| PortcoveError::network(error.to_string()))?;
        let body = std::str::from_utf8(&body)
            .map_err(|error| PortcoveError::network(error.to_string()))?;
        if let Some(library) = &self.library
            && let Err(error) =
                library.store_http_cache(url, etag.as_deref(), last_modified.as_deref(), body)
        {
            tracing::warn!(%error, %url, "could not persist HTTP cache");
        }
        Ok(Some(parsed))
    }

    async fn releases(&self, project_url: &str) -> Result<Vec<GitlabRelease>> {
        let mut releases = Vec::new();
        for page in 1..=GITLAB_MAX_RELEASE_PAGES {
            let url = paginated_url(project_url, "releases", page, PROVIDER_PAGE_SIZE)?;
            let mut current: Vec<GitlabRelease> = self.get_json(&url).await?;
            let has_more = current.len() == PROVIDER_PAGE_SIZE;
            releases.append(&mut current);
            if !has_more {
                return Ok(releases);
            }
        }
        Err(PortcoveError::verification(format!(
            "GitLab release discovery exceeds the supported {}-release bound",
            GITLAB_MAX_RELEASE_PAGES * PROVIDER_PAGE_SIZE
        )))
    }

    async fn packages(&self, project_url: &str) -> Result<Vec<GitlabPackage>> {
        let mut packages = Vec::new();
        for page in 1..=GITLAB_MAX_PACKAGE_PAGES {
            let url = paginated_url(project_url, "packages", page, PROVIDER_PAGE_SIZE)?;
            let mut url = reqwest::Url::parse(&url)
                .map_err(|error| PortcoveError::state(error.to_string()))?;
            url.query_pairs_mut()
                .append_pair("package_type", "generic")
                .append_pair("order_by", "created_at")
                .append_pair("sort", "desc");
            let mut current: Vec<GitlabPackage> = self.get_json(url.as_str()).await?;
            let has_more = current.len() == PROVIDER_PAGE_SIZE;
            packages.append(&mut current);
            if !has_more {
                return Ok(packages);
            }
        }
        Err(PortcoveError::verification(format!(
            "GitLab package discovery exceeds the supported {}-package bound",
            GITLAB_MAX_PACKAGE_PAGES * PROVIDER_PAGE_SIZE
        )))
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
        let packages = self.packages(project_url).await?;
        let normalized_tag = release.tag_name.trim_start_matches('v');
        let package_ids: Vec<u64> = packages
            .into_iter()
            .filter(|package| {
                package.version == release.tag_name || package.version == normalized_tag
            })
            .map(|package| package.id)
            .collect();
        if package_ids.len() > GITLAB_MAX_MATCHING_PACKAGES {
            return Err(PortcoveError::verification(format!(
                "GitLab release {} maps to more than {} matching packages",
                release.tag_name, GITLAB_MAX_MATCHING_PACKAGES
            )));
        }
        let requests = package_ids.into_iter().map(|package_id| async move {
            self.package_file_in_package(project_id, package_id, file_id)
                .await
        });
        let results = stream::iter(requests)
            .buffered(GITLAB_PACKAGE_LOOKUP_CONCURRENCY)
            .collect::<Vec<_>>()
            .await;
        let mut matched = None;
        for result in results {
            let Some(file) = result? else { continue };
            if file.id != file_id {
                return Err(PortcoveError::verification(
                    "GitLab package-file endpoint returned a mismatched identity",
                ));
            }
            if matched.is_some() {
                return Err(PortcoveError::conflict(
                    "GitLab package-file identity is ambiguous across matching release packages",
                ));
            }
            matched = Some(file);
        }
        Ok(matched)
    }

    async fn package_file_in_package(
        &self,
        project_id: u64,
        package_id: u64,
        file_id: u64,
    ) -> Result<Option<GitlabPackageFile>> {
        let package_url = format!(
            "{}/projects/{project_id}/packages/{package_id}",
            self.api_root
        );
        for page in 1..=GITLAB_MAX_PACKAGE_FILE_PAGES {
            let url = paginated_url(&package_url, "package_files", page, PROVIDER_PAGE_SIZE)?;
            let files: Vec<GitlabPackageFile> = self.get_json(&url).await?;
            let has_more = files.len() == PROVIDER_PAGE_SIZE;
            if let Some(file) = files.into_iter().find(|file| file.id == file_id) {
                return Ok(Some(file));
            }
            if !has_more {
                return Ok(None);
            }
        }
        Err(PortcoveError::verification(format!(
            "GitLab package {package_id} exceeds the supported {}-file lookup bound",
            GITLAB_MAX_PACKAGE_FILE_PAGES * PROVIDER_PAGE_SIZE
        )))
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
        let project_url = self.project_url(&port.release.repository)?;
        let project: GitlabProject = self.get_json(&project_url).await?;
        if project.archived.unwrap_or(false) {
            return Err(PortcoveError::unsupported(format!(
                "{} is archived upstream",
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
        let releases = self.releases(&project_url).await?;
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
    let Some((best_score, best_link)) = scored.first() else {
        return Err(PortcoveError::not_found(format!(
            "{} has no supported GitLab package for {platform:?}",
            port.name
        )));
    };
    if scored.get(1).is_some_and(|(score, _)| score == best_score) {
        return Err(PortcoveError::conflict(format!(
            "{} publishes multiple equally qualified GitLab packages for {platform:?}; catalog metadata must select exactly one",
            port.name
        )));
    }
    Ok(*best_link)
}

fn gitlab_http_error(status: StatusCode, headers: &header::HeaderMap) -> PortcoveError {
    let mut error = PortcoveError::network(format!("GitLab API returned {status}"));
    for (header_name, detail_name) in [
        ("ratelimit-limit", "rate_limit"),
        ("ratelimit-remaining", "rate_remaining"),
        ("ratelimit-reset", "rate_reset"),
        ("retry-after", "retry_after"),
    ] {
        if let Some(value) = headers
            .get(header_name)
            .and_then(|value| value.to_str().ok())
        {
            error.details.insert(detail_name.into(), value.into());
        }
    }
    error
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
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
            mpsc::{self, Receiver},
        },
        thread::{self, JoinHandle},
    };

    fn serve_http(responses: Vec<String>) -> (String, Receiver<String>, JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (requests_tx, requests_rx) = mpsc::channel();
        let server = thread::spawn(move || {
            for response in responses {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut request = vec![0_u8; 16 * 1024];
                let size = stream.read(&mut request).unwrap();
                let _ = requests_tx.send(String::from_utf8_lossy(&request[..size]).to_string());
                stream.write_all(response.as_bytes()).unwrap();
            }
        });
        (format!("http://{address}"), requests_rx, server)
    }

    fn ok_json(body: &str, extra_headers: &str) -> String {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n{extra_headers}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    fn gitlab_release(asset_url: &str) -> serde_json::Value {
        let asset_name = "ExtremeG-Windows-RelWithDebInfo.zip";
        serde_json::json!({
            "tag_name": "v1.0.0",
            "description": format!("{asset_name} SHA-256: {}", "a".repeat(64)),
            "released_at": null,
            "upcoming_release": false,
            "assets": {"links": [{
                "name": asset_name,
                "url": asset_url,
                "direct_asset_url": asset_url,
                "link_type": "package"
            }]}
        })
    }

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

    #[tokio::test]
    async fn malformed_success_never_replaces_a_valid_gitlab_cache_entry() {
        let responses = vec![
            ok_json(r#"{"id":1,"archived":false}"#, "ETag: \"good\"\r\n"),
            ok_json("{malformed", "ETag: \"bad\"\r\n"),
            "HTTP/1.1 304 Not Modified\r\nConnection: close\r\n\r\n".into(),
        ];
        let (server_root, requests, server) = serve_http(responses);
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path()).unwrap();
        let provider = GitlabReleaseProvider::with_api_root_and_library(
            format!("{server_root}/api/v4"),
            library,
        )
        .unwrap();
        let url = provider.project_url("group/project").unwrap();

        assert!(
            !provider
                .get_json::<GitlabProject>(&url)
                .await
                .unwrap()
                .archived
                .unwrap()
        );
        assert!(provider.get_json::<GitlabProject>(&url).await.is_err());
        assert!(
            !provider
                .get_json::<GitlabProject>(&url)
                .await
                .unwrap()
                .archived
                .unwrap()
        );
        server.join().unwrap();

        let first = requests.recv().unwrap();
        let second = requests.recv().unwrap();
        let third = requests.recv().unwrap();
        assert!(!first.to_ascii_lowercase().contains("if-none-match"));
        assert!(
            second
                .to_ascii_lowercase()
                .contains("if-none-match: \"good\"")
        );
        assert!(
            third
                .to_ascii_lowercase()
                .contains("if-none-match: \"good\"")
        );
        assert!(!third.contains("\"bad\""));
    }

    #[tokio::test]
    async fn gitlab_metadata_bodies_are_bounded_and_rate_limits_remain_structured() {
        let responses = vec![format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            PROVIDER_JSON_MAX_BYTES + 1
        )];
        let (server_root, _, server) = serve_http(responses);
        let provider =
            GitlabReleaseProvider::with_api_root(format!("{server_root}/api/v4")).unwrap();
        let error = provider
            .get_json::<serde_json::Value>(&format!("{server_root}/metadata"))
            .await
            .unwrap_err();
        server.join().unwrap();
        assert_eq!(error.code, crate::ErrorCode::Verification);
        assert!(error.message.contains("4194304 byte limit"));

        let responses = vec!["HTTP/1.1 429 Too Many Requests\r\nRateLimit-Limit: 60\r\nRateLimit-Remaining: 0\r\nRateLimit-Reset: 1234\r\nRetry-After: 30\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into()];
        let (server_root, _, server) = serve_http(responses);
        let provider =
            GitlabReleaseProvider::with_api_root(format!("{server_root}/api/v4")).unwrap();
        let error = provider
            .get_json::<serde_json::Value>(&format!("{server_root}/metadata"))
            .await
            .unwrap_err();
        server.join().unwrap();
        assert_eq!(
            error.details.get("rate_remaining").map(String::as_str),
            Some("0")
        );
        assert_eq!(
            error.details.get("retry_after").map(String::as_str),
            Some("30")
        );
    }

    #[test]
    fn equally_scored_gitlab_links_are_ambiguous() {
        let catalog = crate::Catalog::embedded().unwrap();
        let port = catalog.port("extreme-g-recompiled").unwrap();
        let links = [
            GitlabReleaseLink {
                name: "ExtremeG-Windows-RelWithDebInfo-one.zip".into(),
                url: "https://example.invalid/one.zip".into(),
                direct_asset_url: None,
                link_type: "package".into(),
            },
            GitlabReleaseLink {
                name: "ExtremeG-Windows-RelWithDebInfo-two.zip".into(),
                url: "https://example.invalid/two.zip".into(),
                direct_asset_url: None,
                link_type: "package".into(),
            },
        ];
        let error = choose_link(port, Platform::WindowsX86_64, &links).unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Conflict);
        assert!(error.message.contains("equally qualified"));
    }

    #[tokio::test]
    async fn gitlab_package_lookup_paginates_and_has_a_hard_candidate_bound() {
        let first_page = (0..PROVIDER_PAGE_SIZE)
            .map(|index| serde_json::json!({"id": index + 1, "version": "v0.9.0"}))
            .collect::<Vec<_>>();
        let second_page = serde_json::json!([{"id": 501, "version": "v1.0.0"}]);
        let package_file = serde_json::json!({
            "id": 77,
            "file_name": "ExtremeG-Windows-RelWithDebInfo.zip",
            "size": 42,
            "file_sha256": "a".repeat(64)
        });
        let responses = vec![
            ok_json(&serde_json::to_string(&first_page).unwrap(), ""),
            ok_json(&second_page.to_string(), ""),
            ok_json(&serde_json::to_string(&vec![package_file]).unwrap(), ""),
        ];
        let (server_root, requests, server) = serve_http(responses);
        let provider =
            GitlabReleaseProvider::with_api_root(format!("{server_root}/api/v4")).unwrap();
        let project_url = provider.project_url("group/project").unwrap();
        let release = GitlabRelease {
            tag_name: "v1.0.0".into(),
            description: String::new(),
            released_at: None,
            upcoming_release: false,
            assets: GitlabReleaseAssets { links: vec![] },
        };
        let link = GitlabReleaseLink {
            name: "ExtremeG-Windows-RelWithDebInfo.zip".into(),
            url: format!("{server_root}/group/project/-/package_files/77/download"),
            direct_asset_url: None,
            link_type: "package".into(),
        };
        let file = provider
            .package_file(&project_url, 9, &release, &link)
            .await
            .unwrap()
            .unwrap();
        server.join().unwrap();
        assert_eq!(file.id, 77);
        let requests = requests.try_iter().collect::<Vec<_>>();
        assert_eq!(requests.len(), 3);
        assert!(requests[0].contains("page=1"));
        assert!(requests[1].contains("page=2"));
        assert!(requests[2].contains("/packages/501/package_files?"));

        let too_many = (0..=GITLAB_MAX_MATCHING_PACKAGES)
            .map(|index| serde_json::json!({"id": index + 1, "version": "v1.0.0"}))
            .collect::<Vec<_>>();
        let responses = vec![ok_json(&serde_json::to_string(&too_many).unwrap(), "")];
        let (server_root, requests, server) = serve_http(responses);
        let provider =
            GitlabReleaseProvider::with_api_root(format!("{server_root}/api/v4")).unwrap();
        let project_url = provider.project_url("group/project").unwrap();
        let error = provider
            .package_file(&project_url, 9, &release, &link)
            .await
            .unwrap_err();
        server.join().unwrap();
        assert_eq!(error.code, crate::ErrorCode::Verification);
        assert!(error.message.contains("more than 16 matching packages"));
        assert_eq!(requests.try_iter().count(), 1);
    }

    #[tokio::test]
    async fn gitlab_package_pagination_stops_at_the_documented_request_bound() {
        let full_page = (0..PROVIDER_PAGE_SIZE)
            .map(|index| serde_json::json!({"id": index + 1, "version": "v0.9.0"}))
            .collect::<Vec<_>>();
        let body = serde_json::to_string(&full_page).unwrap();
        let responses = (0..GITLAB_MAX_PACKAGE_PAGES)
            .map(|_| ok_json(&body, ""))
            .collect();
        let (server_root, requests, server) = serve_http(responses);
        let provider =
            GitlabReleaseProvider::with_api_root(format!("{server_root}/api/v4")).unwrap();
        let project_url = provider.project_url("group/project").unwrap();
        let error = provider.packages(&project_url).await.unwrap_err();
        server.join().unwrap();
        assert_eq!(error.code, crate::ErrorCode::Verification);
        assert!(error.message.contains("1000-package bound"));
        assert_eq!(requests.try_iter().count(), GITLAB_MAX_PACKAGE_PAGES);
    }

    #[tokio::test]
    async fn gitlab_package_file_requests_use_the_documented_concurrency_bound() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let active = Arc::new(AtomicUsize::new(0));
        let maximum = Arc::new(AtomicUsize::new(0));
        let measured = maximum.clone();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 16 * 1024];
            let _ = stream.read(&mut request).unwrap();
            let packages = (1..=8)
                .map(|id| serde_json::json!({"id": id, "version": "v1.0.0"}))
                .collect::<Vec<_>>();
            stream
                .write_all(ok_json(&serde_json::to_string(&packages).unwrap(), "").as_bytes())
                .unwrap();

            let mut workers = Vec::new();
            for _ in 0..8 {
                let (mut stream, _) = listener.accept().unwrap();
                let active = active.clone();
                let maximum = maximum.clone();
                workers.push(thread::spawn(move || {
                    let mut request = [0_u8; 16 * 1024];
                    let _ = stream.read(&mut request).unwrap();
                    let current = active.fetch_add(1, Ordering::SeqCst) + 1;
                    maximum.fetch_max(current, Ordering::SeqCst);
                    thread::sleep(Duration::from_millis(50));
                    stream
                        .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n[]")
                        .unwrap();
                    active.fetch_sub(1, Ordering::SeqCst);
                }));
            }
            for worker in workers {
                worker.join().unwrap();
            }
        });
        let server_root = format!("http://{address}");
        let provider =
            GitlabReleaseProvider::with_api_root(format!("{server_root}/api/v4")).unwrap();
        let release = GitlabRelease {
            tag_name: "v1.0.0".into(),
            description: String::new(),
            released_at: None,
            upcoming_release: false,
            assets: GitlabReleaseAssets { links: vec![] },
        };
        let link = GitlabReleaseLink {
            name: "game.zip".into(),
            url: format!("{server_root}/group/project/-/package_files/77/download"),
            direct_asset_url: None,
            link_type: "package".into(),
        };
        assert!(
            provider
                .package_file(
                    &provider.project_url("group/project").unwrap(),
                    9,
                    &release,
                    &link
                )
                .await
                .unwrap()
                .is_none()
        );
        server.join().unwrap();
        assert_eq!(
            measured.load(Ordering::SeqCst),
            GITLAB_PACKAGE_LOOKUP_CONCURRENCY
        );
    }

    #[tokio::test]
    async fn gitlab_release_cache_revalidates_archive_state_and_fails_closed_offline() {
        let release_body = serde_json::to_string(&vec![gitlab_release(
            "https://downloads.example.invalid/extreme-g.zip",
        )])
        .unwrap();
        let catalog = crate::Catalog::embedded().unwrap();
        let port = catalog.port("extreme-g-recompiled").unwrap();
        let responses = vec![
            ok_json(r#"{"id":9,"archived":false}"#, ""),
            ok_json(&release_body, ""),
            ok_json(r#"{"id":9,"archived":true}"#, ""),
        ];
        let (server_root, requests, server) = serve_http(responses);
        let provider =
            GitlabReleaseProvider::with_api_root(format!("{server_root}/api/v4")).unwrap();
        provider
            .resolve(port, ReleaseChannel::Stable, Platform::WindowsX86_64)
            .await
            .unwrap();
        let error = provider
            .resolve(port, ReleaseChannel::Stable, Platform::WindowsX86_64)
            .await
            .unwrap_err();
        server.join().unwrap();
        assert_eq!(error.code, crate::ErrorCode::Unsupported);
        assert!(error.message.contains("archived upstream"));
        assert_eq!(requests.try_iter().count(), 3);

        let responses = vec![
            ok_json(r#"{"id":9,"archived":false}"#, ""),
            ok_json(&release_body, ""),
            "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                .into(),
        ];
        let (server_root, _, server) = serve_http(responses);
        let provider =
            GitlabReleaseProvider::with_api_root(format!("{server_root}/api/v4")).unwrap();
        provider
            .resolve(port, ReleaseChannel::Stable, Platform::WindowsX86_64)
            .await
            .unwrap();
        let error = provider
            .resolve(port, ReleaseChannel::Stable, Platform::WindowsX86_64)
            .await
            .unwrap_err();
        server.join().unwrap();
        assert_eq!(error.code, crate::ErrorCode::Network);
        assert!(error.message.contains("503"));
    }
}
