use std::{
    collections::HashMap,
    sync::{Arc, RwLock as StdRwLock},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use async_trait::async_trait;
use reqwest::{StatusCode, header};
use serde::{Deserialize, de::DeserializeOwned};
use tokio::sync::{Mutex, RwLock};
use uuid::Uuid;

use crate::{
    GithubAuthSource, GithubAuthStatus, GithubDeviceLogin, GithubDeviceLoginResult,
    GithubDeviceLoginState, GithubRateLimit, Library, Platform, PortDefinition, PortcoveError,
    ReleaseAsset, ReleaseChannel, ResolvedRelease, Result,
    auth::{
        delete_stored_token, environment_token, github_client_id, load_stored_token, store_token,
    },
    library::HttpCacheEntry,
};

#[async_trait]
pub trait ReleaseProvider: Send + Sync {
    async fn resolve(
        &self,
        port: &PortDefinition,
        channel: ReleaseChannel,
        platform: Platform,
    ) -> Result<ResolvedRelease>;
}

#[derive(Clone)]
pub struct GithubReleaseProvider {
    client: reqwest::Client,
    api_root: String,
    web_root: String,
    library: Option<Library>,
    credential: Arc<StdRwLock<GithubCredential>>,
    cache: Arc<RwLock<HashMap<ReleaseCacheKey, CachedRelease>>>,
    device_sessions: Arc<Mutex<HashMap<String, DeviceSession>>>,
}

struct GithubCredential {
    token: Option<String>,
    source: GithubAuthSource,
}

struct DeviceSession {
    client_id: String,
    device_code: String,
    expires_at: Instant,
    next_poll_at: Instant,
    interval: Duration,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct ReleaseCacheKey {
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

impl GithubReleaseProvider {
    pub fn for_library(library: &Library) -> Result<Self> {
        Self::build(
            Some(library.clone()),
            "https://api.github.com",
            "https://github.com",
        )
    }

    fn build(library: Option<Library>, api_root: &str, web_root: &str) -> Result<Self> {
        let client = reqwest::Client::builder()
            .user_agent(concat!("Portcove/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|error| PortcoveError::network(error.to_string()))?;
        Ok(Self {
            client,
            api_root: api_root.into(),
            web_root: web_root.into(),
            library,
            credential: Arc::new(StdRwLock::new(load_credential())),
            cache: Arc::new(RwLock::new(HashMap::new())),
            device_sessions: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    #[cfg(test)]
    pub fn with_api_root(api_root: impl Into<String>) -> Result<Self> {
        let api_root = api_root.into();
        let provider = Self::build(None, &api_root, &api_root)?;
        provider.set_credential(None, GithubAuthSource::Anonymous);
        Ok(provider)
    }

    #[cfg(test)]
    fn with_api_root_and_library(api_root: impl Into<String>, library: Library) -> Result<Self> {
        let api_root = api_root.into();
        let provider = Self::build(Some(library), &api_root, &api_root)?;
        provider.set_credential(None, GithubAuthSource::Anonymous);
        Ok(provider)
    }

    fn request(&self, url: &str) -> reqwest::RequestBuilder {
        let request = self.client.get(url);
        if same_origin(url, &self.api_root)
            && let Some(token) = self.active_token()
        {
            request.bearer_auth(token)
        } else {
            request
        }
    }

    fn active_token(&self) -> Option<String> {
        self.credential
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .token
            .clone()
    }

    fn credential_source(&self) -> GithubAuthSource {
        self.credential
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .source
    }

    fn set_credential(&self, token: Option<String>, source: GithubAuthSource) {
        let mut credential = self
            .credential
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        credential.token = token;
        credential.source = source;
    }

    fn refresh_credential(&self) {
        let credential = load_credential();
        self.set_credential(credential.token, credential.source);
    }

    fn cached_http_response(&self, url: &str) -> Option<HttpCacheEntry> {
        self.library.as_ref().and_then(|library| {
            library
                .http_cache(url)
                .map_err(|error| tracing::warn!(%error, %url, "could not read GitHub HTTP cache"))
                .ok()
                .flatten()
        })
    }

    fn apply_conditional_headers(
        request: reqwest::RequestBuilder,
        cached: Option<&HttpCacheEntry>,
    ) -> reqwest::RequestBuilder {
        let Some(cached) = cached else { return request };
        let request = if let Some(etag) = cached.etag.as_deref() {
            request.header(header::IF_NONE_MATCH, etag)
        } else {
            request
        };
        if let Some(value) = cached.last_modified.as_deref() {
            request.header(header::IF_MODIFIED_SINCE, value)
        } else {
            request
        }
    }

    async fn get_json<T: DeserializeOwned>(&self, url: &str) -> Result<T> {
        let cached = self.cached_http_response(url);
        let response = Self::apply_conditional_headers(self.request(url), cached.as_ref())
            .send()
            .await
            .map_err(|error| PortcoveError::network(error.to_string()))?;
        if response.status() == StatusCode::NOT_MODIFIED {
            let body = cached
                .ok_or_else(|| PortcoveError::state("GitHub returned 304 without cached data"))?
                .body;
            return serde_json::from_str(&body)
                .map_err(|error| PortcoveError::network(error.to_string()));
        }
        let status = response.status();
        if !status.is_success() {
            return Err(github_http_error(status, response.headers()));
        }
        let etag = header_text(response.headers(), header::ETAG);
        let last_modified = header_text(response.headers(), header::LAST_MODIFIED);
        let body = response
            .text()
            .await
            .map_err(|error| PortcoveError::network(error.to_string()))?;
        if let Some(library) = &self.library
            && let Err(error) =
                library.store_http_cache(url, etag.as_deref(), last_modified.as_deref(), &body)
        {
            tracing::warn!(%error, %url, "could not persist GitHub HTTP cache");
        }
        serde_json::from_str(&body).map_err(|error| PortcoveError::network(error.to_string()))
    }

    async fn cached_release(&self, key: &ReleaseCacheKey) -> Option<ResolvedRelease> {
        self.cache
            .read()
            .await
            .get(key)
            .filter(|entry| entry.stored_at.elapsed() < RELEASE_CACHE_TTL)
            .map(|entry| entry.release.clone())
    }

    async fn store_release(&self, key: ReleaseCacheKey, release: ResolvedRelease) {
        self.cache.write().await.insert(
            key,
            CachedRelease {
                stored_at: Instant::now(),
                release,
            },
        );
    }

    pub async fn auth_status(&self) -> Result<GithubAuthStatus> {
        let source = self.credential_source();
        let authenticated = self.active_token().is_some();
        let url = if authenticated {
            format!("{}/user", self.api_root)
        } else {
            format!("{}/rate_limit", self.api_root)
        };
        let response = self
            .request(&url)
            .send()
            .await
            .map_err(|error| PortcoveError::network(error.to_string()))?;
        let status = response.status();
        let rate_limit = rate_limit_from_headers(response.headers());
        if !status.is_success() {
            return Err(github_http_error(status, response.headers()));
        }
        let login = if authenticated {
            Some(
                response
                    .json::<GithubUser>()
                    .await
                    .map_err(|error| PortcoveError::network(error.to_string()))?
                    .login,
            )
        } else {
            None
        };
        Ok(GithubAuthStatus {
            source,
            authenticated,
            login,
            rate_limit,
            device_login_available: github_client_id().is_some(),
        })
    }

    pub async fn store_personal_token(&self, token: &str) -> Result<GithubAuthStatus> {
        let token = token.trim();
        if token.is_empty() {
            return Err(PortcoveError::usage("GitHub token cannot be empty"));
        }
        self.validate_token(token).await?;
        store_token(token)?;
        self.refresh_credential();
        self.auth_status().await
    }

    pub async fn logout(&self) -> Result<GithubAuthStatus> {
        delete_stored_token()?;
        self.refresh_credential();
        self.auth_status().await
    }

    pub async fn begin_device_login(&self) -> Result<GithubDeviceLogin> {
        let client_id = github_client_id().ok_or_else(|| {
            PortcoveError::unsupported(
                "GitHub device login is not configured in this build; use a token or set PORTCOVE_GITHUB_CLIENT_ID",
            )
        })?;
        let url = format!("{}/login/device/code", self.web_root);
        let response = self
            .client
            .post(url)
            .header(header::ACCEPT, "application/json")
            .form(&[("client_id", client_id.as_str())])
            .send()
            .await
            .map_err(|error| PortcoveError::network(error.to_string()))?;
        let status = response.status();
        if !status.is_success() {
            return Err(github_http_error(status, response.headers()));
        }
        let authorization: DeviceCodeResponse = response
            .json()
            .await
            .map_err(|error| PortcoveError::network(error.to_string()))?;
        let session_id = Uuid::new_v4().to_string();
        let interval = Duration::from_secs(authorization.interval.max(1));
        self.device_sessions.lock().await.insert(
            session_id.clone(),
            DeviceSession {
                client_id,
                device_code: authorization.device_code,
                expires_at: Instant::now() + Duration::from_secs(authorization.expires_in),
                next_poll_at: Instant::now() + interval,
                interval,
            },
        );
        Ok(GithubDeviceLogin {
            session_id,
            user_code: authorization.user_code,
            verification_uri: authorization.verification_uri,
            expires_at: unix_timestamp() + authorization.expires_in,
            interval_seconds: authorization.interval.max(1),
        })
    }

    pub async fn poll_device_login(&self, session_id: &str) -> Result<GithubDeviceLoginResult> {
        let (client_id, device_code) = {
            let mut sessions = self.device_sessions.lock().await;
            let session = sessions.get_mut(session_id).ok_or_else(|| {
                PortcoveError::not_found("GitHub device-login session was not found")
            })?;
            if session.expires_at <= Instant::now() {
                sessions.remove(session_id);
                return Err(PortcoveError::network(
                    "GitHub device-login session expired",
                ));
            }
            if session.next_poll_at > Instant::now() {
                return Ok(pending_device_login());
            }
            session.next_poll_at = Instant::now() + session.interval;
            (session.client_id.clone(), session.device_code.clone())
        };
        let url = format!("{}/login/oauth/access_token", self.web_root);
        let response = self
            .client
            .post(url)
            .header(header::ACCEPT, "application/json")
            .form(&[
                ("client_id", client_id.as_str()),
                ("device_code", device_code.as_str()),
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ])
            .send()
            .await
            .map_err(|error| PortcoveError::network(error.to_string()))?;
        let status = response.status();
        if !status.is_success() {
            return Err(github_http_error(status, response.headers()));
        }
        let token: DeviceTokenResponse = response
            .json()
            .await
            .map_err(|error| PortcoveError::network(error.to_string()))?;
        if let Some(access_token) = token.access_token {
            self.device_sessions.lock().await.remove(session_id);
            let status = self.store_personal_token(&access_token).await?;
            return Ok(GithubDeviceLoginResult {
                state: GithubDeviceLoginState::Complete,
                status: Some(status),
            });
        }
        match token.error.as_deref() {
            Some("authorization_pending") | None => Ok(pending_device_login()),
            Some("slow_down") => {
                if let Some(session) = self.device_sessions.lock().await.get_mut(session_id) {
                    session.interval += Duration::from_secs(5);
                    session.next_poll_at = Instant::now() + session.interval;
                }
                Ok(pending_device_login())
            }
            Some("expired_token") => {
                self.device_sessions.lock().await.remove(session_id);
                Err(PortcoveError::network(
                    "GitHub device-login session expired",
                ))
            }
            Some("access_denied") => {
                self.device_sessions.lock().await.remove(session_id);
                Err(PortcoveError::conflict("GitHub login was cancelled"))
            }
            Some(error) => Err(PortcoveError::network(format!(
                "GitHub device login failed: {error}"
            ))),
        }
    }

    async fn validate_token(&self, token: &str) -> Result<()> {
        let url = format!("{}/user", self.api_root);
        let response = self
            .client
            .get(url)
            .bearer_auth(token)
            .send()
            .await
            .map_err(|error| PortcoveError::network(error.to_string()))?;
        if response.status().is_success() {
            Ok(())
        } else {
            Err(github_http_error(response.status(), response.headers()))
        }
    }

    async fn checksum_from_sidecar(
        &self,
        assets: &[GithubAsset],
        target: &GithubAsset,
    ) -> Result<Option<String>> {
        let exact_name = format!("{}.sha256", target.name);
        let sidecar = assets
            .iter()
            .find(|asset| asset.name.eq_ignore_ascii_case(&exact_name))
            .or_else(|| {
                assets.iter().find(|asset| {
                    let name = asset.name.to_ascii_lowercase();
                    name == "sha256sums" || name == "sha256sums.txt" || name == "checksums.txt"
                })
            });
        let Some(sidecar) = sidecar else {
            return Ok(None);
        };
        let response = self
            .request(&sidecar.browser_download_url)
            .send()
            .await
            .map_err(|error| PortcoveError::network(error.to_string()))?;
        if !response.status().is_success() {
            return Err(PortcoveError::network(format!(
                "checksum download returned {}",
                response.status()
            )));
        }
        let body = response
            .text()
            .await
            .map_err(|error| PortcoveError::network(error.to_string()))?;
        for line in body.lines() {
            let mut fields = line.split_whitespace();
            let Some(hash) = fields.next() else { continue };
            let file = fields.next().unwrap_or_default().trim_start_matches('*');
            if (file.is_empty() || file == target.name) && is_sha256(hash) {
                return Ok(Some(hash.to_ascii_lowercase()));
            }
        }
        Ok(None)
    }
}

#[async_trait]
impl ReleaseProvider for GithubReleaseProvider {
    async fn resolve(
        &self,
        port: &PortDefinition,
        channel: ReleaseChannel,
        platform: Platform,
    ) -> Result<ResolvedRelease> {
        if port.release.provider != crate::ReleaseSource::Github {
            return Err(PortcoveError::unsupported(format!(
                "{} does not use GitHub releases",
                port.name
            )));
        }
        if !port.channels.contains(&channel) {
            return Err(PortcoveError::unsupported(format!(
                "{} does not offer the {channel} channel",
                port.name
            )));
        }
        if !port.platforms.contains(&platform) {
            return Err(PortcoveError::unsupported(format!(
                "{} is not available for {platform:?}",
                port.name
            )));
        }
        let cache_key = ReleaseCacheKey {
            repository: port.release.repository.clone(),
            channel,
            platform,
        };
        if let Some(release) = self.cached_release(&cache_key).await {
            return Ok(release);
        }
        let repository_url = format!("{}/repos/{}", self.api_root, port.release.repository);
        let repository: GithubRepository = self.get_json(&repository_url).await?;
        if repository.archived {
            return Err(PortcoveError::unsupported(format!(
                "{} is archived upstream",
                port.name
            )));
        }
        let releases_url = format!("{repository_url}/releases?per_page=30");
        let releases: Vec<GithubRelease> = self.get_json(&releases_url).await?;
        let mut candidates: Vec<&GithubRelease> = releases
            .iter()
            .filter(|release| !release.draft)
            .filter(|release| match channel {
                ReleaseChannel::Stable => !is_beta_release(release),
                ReleaseChannel::Beta => is_beta_release(release),
                ReleaseChannel::Rolling => port
                    .release
                    .rolling_tag
                    .as_ref()
                    .is_some_and(|tag| release.tag_name.eq_ignore_ascii_case(tag)),
            })
            .collect();
        if channel == ReleaseChannel::Beta && candidates.is_empty() {
            candidates = releases.iter().filter(|release| !release.draft).collect();
        }
        let release = candidates.first().copied().ok_or_else(|| {
            PortcoveError::not_found(format!(
                "no published {channel} release exists for {}",
                port.name
            ))
        })?;
        let asset = choose_asset(port, platform, &release.assets)?;
        let sha256 = match asset.digest.as_deref().and_then(parse_digest) {
            Some(digest) => digest,
            None => self
                .checksum_from_sidecar(&release.assets, asset)
                .await?
                .ok_or_else(|| {
                    PortcoveError::verification(format!(
                        "{} does not publish a SHA-256 digest for {}",
                        port.name, asset.name
                    ))
                })?,
        };
        let version = release_version(&release.tag_name, channel, &sha256);
        let resolved = ResolvedRelease {
            version,
            channel,
            published_at: release.published_at.clone(),
            asset: ReleaseAsset {
                name: asset.name.clone(),
                url: asset.browser_download_url.clone(),
                size: asset.size,
                sha256,
            },
        };
        self.store_release(cache_key, resolved.clone()).await;
        Ok(resolved)
    }
}

fn release_version(tag: &str, channel: ReleaseChannel, sha256: &str) -> String {
    if channel == ReleaseChannel::Rolling {
        format!("{tag}.{}", &sha256[..12])
    } else {
        tag.to_string()
    }
}

fn same_origin(left: &str, right: &str) -> bool {
    let Ok(left) = reqwest::Url::parse(left) else {
        return false;
    };
    let Ok(right) = reqwest::Url::parse(right) else {
        return false;
    };
    left.scheme() == right.scheme()
        && left.host_str() == right.host_str()
        && left.port_or_known_default() == right.port_or_known_default()
}

fn load_credential() -> GithubCredential {
    if let Some(token) = environment_token() {
        return GithubCredential {
            token: Some(token),
            source: GithubAuthSource::Environment,
        };
    }
    match load_stored_token() {
        Ok(Some(token)) => GithubCredential {
            token: Some(token),
            source: GithubAuthSource::CredentialStore,
        },
        Ok(None) | Err(_) => GithubCredential {
            token: None,
            source: GithubAuthSource::Anonymous,
        },
    }
}

fn pending_device_login() -> GithubDeviceLoginResult {
    GithubDeviceLoginResult {
        state: GithubDeviceLoginState::Pending,
        status: None,
    }
}

fn unix_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn header_text(headers: &header::HeaderMap, name: header::HeaderName) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
}

fn rate_limit_from_headers(headers: &header::HeaderMap) -> Option<GithubRateLimit> {
    Some(GithubRateLimit {
        limit: headers
            .get("x-ratelimit-limit")?
            .to_str()
            .ok()?
            .parse()
            .ok()?,
        remaining: headers
            .get("x-ratelimit-remaining")?
            .to_str()
            .ok()?
            .parse()
            .ok()?,
        resets_at: headers
            .get("x-ratelimit-reset")?
            .to_str()
            .ok()?
            .parse()
            .ok()?,
    })
}

fn github_http_error(status: StatusCode, headers: &header::HeaderMap) -> PortcoveError {
    let mut error = PortcoveError::network(format!("GitHub API returned {status}"));
    if let Some(limit) = rate_limit_from_headers(headers) {
        error
            .details
            .insert("rate_limit".into(), limit.limit.to_string());
        error
            .details
            .insert("rate_remaining".into(), limit.remaining.to_string());
        error
            .details
            .insert("rate_reset".into(), limit.resets_at.to_string());
    }
    if let Some(retry_after) = header_text(headers, header::RETRY_AFTER) {
        error.details.insert("retry_after".into(), retry_after);
    }
    error
}

#[derive(Debug, Deserialize)]
struct GithubUser {
    login: String,
}

#[derive(Debug, Deserialize)]
struct DeviceCodeResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    expires_in: u64,
    interval: u64,
}

#[derive(Debug, Deserialize)]
struct DeviceTokenResponse {
    access_token: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GithubRepository {
    archived: bool,
}

#[derive(Debug, Deserialize)]
struct GithubRelease {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    published_at: Option<String>,
    assets: Vec<GithubAsset>,
}

#[derive(Debug, Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
    size: u64,
    digest: Option<String>,
}

fn choose_asset<'a>(
    port: &PortDefinition,
    platform: Platform,
    assets: &'a [GithubAsset],
) -> Result<&'a GithubAsset> {
    let hints = port
        .release
        .asset_hints
        .get(&platform)
        .cloned()
        .unwrap_or_default();
    let mut scored: Vec<(i32, &GithubAsset)> = assets
        .iter()
        .filter_map(|asset| {
            let name = asset.name.to_ascii_lowercase();
            if is_checksum_name(&name)
                || is_auxiliary_package(&name)
                || !is_supported_package(&name)
            {
                return None;
            }
            if conflicts_with_platform(&name, platform) {
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
            let archive_score = if name.ends_with(".zip") || name.ends_with(".tar.gz") {
                3
            } else {
                1
            };
            Some((hint_score + platform_score + archive_score, asset))
        })
        .collect();
    scored.sort_by(|left, right| {
        right
            .0
            .cmp(&left.0)
            .then_with(|| left.1.name.cmp(&right.1.name))
    });
    scored.first().map(|(_, asset)| *asset).ok_or_else(|| {
        PortcoveError::not_found(format!(
            "{} has no supported release asset for {platform:?}",
            port.name
        ))
    })
}

fn conflicts_with_platform(name: &str, platform: Platform) -> bool {
    let name = name.to_ascii_lowercase();
    match platform {
        Platform::WindowsX86_64 => [
            "linux", "appimage", "flatpak", "macos", "mac-", "mac_", "darwin", "arm64", "aarch64",
        ]
        .iter()
        .any(|value| name.contains(value)),
        Platform::LinuxX86_64 => [
            "windows", "win64", ".exe", "macos", "mac-", "mac_", "darwin", "arm64", "aarch64",
        ]
        .iter()
        .any(|value| name.contains(value)),
        Platform::MacosX86_64 => [
            "windows", "win64", ".exe", "linux", "appimage", "arm64", "aarch64",
        ]
        .iter()
        .any(|value| name.contains(value)),
        Platform::MacosAarch64 => [
            "windows", "win64", ".exe", "linux", "appimage", "x86_64", "amd64", "intel",
        ]
        .iter()
        .any(|value| name.contains(value)),
    }
}

fn is_supported_package(name: &str) -> bool {
    name.ends_with(".zip")
        || name.ends_with(".tar.gz")
        || name.ends_with(".tgz")
        || name.ends_with(".appimage")
        || name.ends_with(".exe")
}

fn is_checksum_name(name: &str) -> bool {
    name.ends_with(".sha256") || name.contains("checksum") || name.contains("sha256sum")
}

fn is_auxiliary_package(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    name.contains("symbols") || name.contains("-pdb-") || name.ends_with("-pdb.zip")
}

fn is_beta_release(release: &GithubRelease) -> bool {
    if release.prerelease {
        return true;
    }

    let tag = release.tag_name.to_ascii_lowercase();
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

fn parse_digest(value: &str) -> Option<String> {
    let hash = value.strip_prefix("sha256:").unwrap_or(value);
    is_sha256(hash).then(|| hash.to_ascii_lowercase())
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64 && value.chars().all(|character| character.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::mpsc,
        thread,
    };

    #[test]
    fn parses_github_digest() {
        let digest = "a".repeat(64);
        assert_eq!(parse_digest(&format!("sha256:{digest}")), Some(digest));
        assert_eq!(parse_digest("md5:nope"), None);
    }

    #[test]
    fn rolling_versions_change_when_a_mutable_tag_republishes() {
        let first = format!("{}{}", "a".repeat(12), "0".repeat(52));
        let second = format!("{}{}", "b".repeat(12), "0".repeat(52));

        assert_eq!(
            release_version("devbuild", ReleaseChannel::Rolling, &first),
            "devbuild.aaaaaaaaaaaa"
        );
        assert_eq!(
            release_version("devbuild", ReleaseChannel::Rolling, &second),
            "devbuild.bbbbbbbbbbbb"
        );
        assert_eq!(
            release_version("v1.2.3", ReleaseChannel::Stable, &first),
            "v1.2.3"
        );
    }

    #[test]
    fn mac_named_assets_conflict_with_windows() {
        assert!(conflicts_with_platform(
            "spaghetti-mac-intel-x64.zip",
            Platform::WindowsX86_64
        ));
        assert!(!conflicts_with_platform(
            "spaghetti-windows.zip",
            Platform::WindowsX86_64
        ));
        assert!(conflicts_with_platform(
            "BM64Recompiled-Flatpak-X64-Release.zip",
            Platform::WindowsX86_64
        ));
    }

    #[test]
    fn symbol_archives_are_not_installable_packages() {
        assert!(is_auxiliary_package("reblue-1.0.0-win-amd64-symbols.zip"));
        assert!(is_auxiliary_package(
            "BM64Recompiled-PDB-RelWithDebInfo.zip"
        ));
        assert!(!is_auxiliary_package("reblue-1.0.0-win-amd64.zip"));
    }

    #[test]
    fn development_tag_is_beta_even_when_github_flag_is_missing() {
        let release = GithubRelease {
            tag_name: "v0.2.0-dev".into(),
            draft: false,
            prerelease: false,
            published_at: None,
            assets: Vec::new(),
        };

        assert!(is_beta_release(&release));
    }

    #[test]
    fn ordinary_tag_remains_stable() {
        let release = GithubRelease {
            tag_name: "v1.2.3".into(),
            draft: false,
            prerelease: false,
            published_at: None,
            assets: Vec::new(),
        };

        assert!(!is_beta_release(&release));
    }

    #[test]
    fn runnable_archive_wins_over_matching_symbol_archive() {
        let catalog = crate::Catalog::embedded().unwrap();
        let port = catalog.port("re-blue").unwrap();
        let assets = [
            GithubAsset {
                name: "reblue-1.0.0-win-amd64-symbols.zip".into(),
                browser_download_url: "https://example.invalid/symbols.zip".into(),
                size: 1,
                digest: None,
            },
            GithubAsset {
                name: "reblue-1.0.0-win-amd64.zip".into(),
                browser_download_url: "https://example.invalid/runtime.zip".into(),
                size: 1,
                digest: None,
            },
        ];

        let selected = choose_asset(port, Platform::WindowsX86_64, &assets).unwrap();
        assert_eq!(selected.name, "reblue-1.0.0-win-amd64.zip");
    }

    #[test]
    fn authenticated_requests_use_a_bearer_header() {
        let provider = GithubReleaseProvider::with_api_root("https://example.invalid").unwrap();
        provider.set_credential(Some("test-token".into()), GithubAuthSource::CredentialStore);
        let request = provider
            .request("https://example.invalid/repos/example/project")
            .build()
            .unwrap();
        assert_eq!(
            request
                .headers()
                .get(reqwest::header::AUTHORIZATION)
                .unwrap(),
            "Bearer test-token"
        );
    }

    #[test]
    fn anonymous_requests_do_not_send_authorization() {
        let provider = GithubReleaseProvider::with_api_root("https://example.invalid").unwrap();
        let request = provider
            .request("https://example.invalid/repos/example/project")
            .build()
            .unwrap();
        assert!(
            !request
                .headers()
                .contains_key(reqwest::header::AUTHORIZATION)
        );
    }

    #[test]
    fn tokens_are_not_sent_to_release_asset_origins() {
        let provider = GithubReleaseProvider::with_api_root("https://api.example.invalid").unwrap();
        provider.set_credential(Some("test-token".into()), GithubAuthSource::CredentialStore);
        let request = provider
            .request("https://downloads.example.invalid/checksums.txt")
            .build()
            .unwrap();
        assert!(
            !request
                .headers()
                .contains_key(reqwest::header::AUTHORIZATION)
        );

        let lookalike = provider
            .request("https://api.example.invalid.attacker.test/repos/project")
            .build()
            .unwrap();
        assert!(
            !lookalike
                .headers()
                .contains_key(reqwest::header::AUTHORIZATION)
        );
    }

    #[tokio::test]
    async fn successful_release_resolutions_are_cached() {
        let provider = GithubReleaseProvider::with_api_root("https://example.invalid").unwrap();
        let key = ReleaseCacheKey {
            repository: "example/project".into(),
            channel: ReleaseChannel::Stable,
            platform: Platform::WindowsX86_64,
        };
        let release = ResolvedRelease {
            version: "v1.0.0".into(),
            channel: ReleaseChannel::Stable,
            published_at: None,
            asset: ReleaseAsset {
                name: "project-windows.zip".into(),
                url: "https://example.invalid/project.zip".into(),
                size: 1,
                sha256: "a".repeat(64),
            },
        };

        provider.store_release(key.clone(), release).await;

        assert_eq!(
            provider.cached_release(&key).await.unwrap().version,
            "v1.0.0"
        );
    }

    #[test]
    fn persisted_http_cache_adds_conditional_headers() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path()).unwrap();
        let provider = GithubReleaseProvider::with_api_root_and_library(
            "https://example.invalid",
            library.clone(),
        )
        .unwrap();
        let url = "https://example.invalid/repos/example/project";
        library
            .store_http_cache(
                url,
                Some("\"release-etag\""),
                Some("Mon, 01 Sep 2026 12:00:00 GMT"),
                "{}",
            )
            .unwrap();
        let cached = provider.cached_http_response(url).unwrap();
        let request =
            GithubReleaseProvider::apply_conditional_headers(provider.request(url), Some(&cached))
                .build()
                .unwrap();

        assert_eq!(request.headers()[header::IF_NONE_MATCH], "\"release-etag\"");
        assert_eq!(
            request.headers()[header::IF_MODIFIED_SINCE],
            "Mon, 01 Sep 2026 12:00:00 GMT"
        );
    }

    #[tokio::test]
    async fn persisted_http_cache_survives_provider_restarts_and_handles_304() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (headers_tx, headers_rx) = mpsc::channel();
        let server = thread::spawn(move || {
            for request_index in 0..2 {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = vec![0_u8; 4096];
                let size = stream.read(&mut request).unwrap();
                let request = String::from_utf8_lossy(&request[..size]).to_string();
                headers_tx.send(request).unwrap();
                let response = if request_index == 0 {
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nETag: \"repository-v1\"\r\nContent-Length: 18\r\nConnection: close\r\n\r\n{\"archived\":false}"
                } else {
                    "HTTP/1.1 304 Not Modified\r\nConnection: close\r\n\r\n"
                };
                stream.write_all(response.as_bytes()).unwrap();
            }
        });
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path()).unwrap();
        let api_root = format!("http://{address}");
        let url = format!("{api_root}/repos/example/project");

        let first =
            GithubReleaseProvider::with_api_root_and_library(api_root.clone(), library.clone())
                .unwrap();
        assert!(
            !first
                .get_json::<GithubRepository>(&url)
                .await
                .unwrap()
                .archived
        );
        drop(first);
        let second = GithubReleaseProvider::with_api_root_and_library(api_root, library).unwrap();
        assert!(
            !second
                .get_json::<GithubRepository>(&url)
                .await
                .unwrap()
                .archived
        );
        server.join().unwrap();

        let first_request = headers_rx.recv().unwrap();
        let second_request = headers_rx.recv().unwrap();
        assert!(!first_request.to_ascii_lowercase().contains("if-none-match"));
        assert!(
            second_request
                .to_ascii_lowercase()
                .contains("if-none-match: \"repository-v1\"")
        );
    }
}
