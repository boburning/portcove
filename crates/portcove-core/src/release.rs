use std::{
    collections::HashMap,
    sync::{Arc, RwLock as StdRwLock},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use async_trait::async_trait;
use futures_util::StreamExt;
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

mod observation;
pub use observation::{
    ChannelObservation as UpstreamChannelObservation, ObservationEvidence, ObservedReleaseIdentity,
    ObservedResolution, UpstreamObservationReport, inspect_upstream_observation,
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
    download_client: reqwest::Client,
    api_root: String,
    web_root: String,
    library: Option<Library>,
    credential: Arc<StdRwLock<GithubCredential>>,
    cache: Arc<RwLock<HashMap<ReleaseSelectionCacheKey, CachedRelease>>>,
    device_sessions: Arc<Mutex<HashMap<String, DeviceSession>>>,
}

struct GithubCredential {
    token: Option<String>,
    source: GithubAuthSource,
    intent: u64,
}

struct DeviceSession {
    client_id: String,
    device_code: String,
    intent: u64,
    created_at: Instant,
    expires_at: Instant,
    next_poll_at: Instant,
    interval: Duration,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) struct ReleaseSelectionCacheKey {
    repository: String,
    channel: ReleaseChannel,
    platform: Platform,
    rolling_tag: Option<String>,
    asset_hints: Vec<String>,
}

impl ReleaseSelectionCacheKey {
    pub(crate) fn new(port: &PortDefinition, channel: ReleaseChannel, platform: Platform) -> Self {
        Self {
            repository: port.release.repository.clone(),
            channel,
            platform,
            rolling_tag: port
                .release
                .rolling_tag
                .as_ref()
                .map(|tag| tag.to_ascii_lowercase()),
            asset_hints: port
                .release
                .asset_hints
                .get(&platform)
                .map(|hints| hints.iter().map(|hint| hint.to_ascii_lowercase()).collect())
                .unwrap_or_default(),
        }
    }
}

#[derive(Debug, Clone)]
struct CachedRelease {
    stored_at: Instant,
    release: ResolvedRelease,
}

const RELEASE_CACHE_TTL: Duration = Duration::from_secs(5 * 60);
// The embedded beta catalog currently has 200 platform/channel selector slots.
// One complete inventory therefore fits with headroom for successor definitions.
const RELEASE_CACHE_MAX_ENTRIES: usize = 256;
pub(crate) const PROVIDER_JSON_MAX_BYTES: usize = 4 * 1024 * 1024;
const CHECKSUM_MAX_BYTES: usize = 1024 * 1024;
const CHECKSUM_MAX_SIDECARS: usize = 8;
const PROVIDER_PAGE_SIZE: usize = 100;
const GITHUB_MAX_RELEASE_PAGES: usize = 10;
// Small provider metadata and authentication requests get an overall deadline;
// streamed downloads intentionally use only connection and read-idle bounds.
const PROVIDER_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const PROVIDER_READ_IDLE_TIMEOUT: Duration = Duration::from_secs(15);
const PROVIDER_REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
// A UI and CLI retry can coexist, but abandoned device flows cannot accumulate.
const DEVICE_SESSION_MAX_ENTRIES: usize = 8;
const DEVICE_SESSION_MAX_AGE: Duration = Duration::from_secs(15 * 60);

#[derive(Clone, Copy)]
pub(crate) struct ProviderNetworkBounds {
    pub(crate) connect: Duration,
    pub(crate) read_idle: Duration,
    pub(crate) request: Duration,
}

pub(crate) const PROVIDER_NETWORK_BOUNDS: ProviderNetworkBounds = ProviderNetworkBounds {
    connect: PROVIDER_CONNECT_TIMEOUT,
    read_idle: PROVIDER_READ_IDLE_TIMEOUT,
    request: PROVIDER_REQUEST_TIMEOUT,
};

impl GithubReleaseProvider {
    pub fn for_library(library: &Library) -> Result<Self> {
        Self::build(
            Some(library.clone()),
            "https://api.github.com",
            "https://github.com",
        )
    }

    fn build(library: Option<Library>, api_root: &str, web_root: &str) -> Result<Self> {
        Self::build_with_bounds(library, api_root, web_root, PROVIDER_NETWORK_BOUNDS)
    }

    fn build_with_bounds(
        library: Option<Library>,
        api_root: &str,
        web_root: &str,
        bounds: ProviderNetworkBounds,
    ) -> Result<Self> {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(concat!("Portcove/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(bounds.connect)
            .read_timeout(bounds.read_idle)
            .timeout(bounds.request)
            .build()
            .map_err(|error| PortcoveError::network(error.to_string()))?;
        let download_client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::limited(5))
            .user_agent(concat!("Portcove/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(bounds.connect)
            .read_timeout(bounds.read_idle)
            .build()
            .map_err(|error| PortcoveError::network(error.to_string()))?;
        Ok(Self {
            client,
            download_client,
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

    #[cfg(test)]
    fn with_api_root_and_bounds(
        api_root: impl Into<String>,
        bounds: ProviderNetworkBounds,
    ) -> Result<Self> {
        let api_root = api_root.into();
        let provider = Self::build_with_bounds(None, &api_root, &api_root, bounds)?;
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

    #[cfg(test)]
    fn set_credential(&self, token: Option<String>, source: GithubAuthSource) {
        let mut credential = self
            .credential
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        credential.token = token;
        credential.source = source;
    }

    fn begin_auth_intent(&self) -> u64 {
        let mut credential = self
            .credential
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        credential.intent = credential.intent.wrapping_add(1);
        credential.intent
    }

    fn auth_intent_is_current(&self, intent: u64) -> bool {
        self.credential
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .intent
            == intent
    }

    async fn clear_device_sessions_for_intent(&self, intent: u64) -> Result<()> {
        let mut sessions = self.device_sessions.lock().await;
        let credential = self
            .credential
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if credential.intent != intent {
            return Err(obsolete_auth_intent());
        }
        sessions.clear();
        Ok(())
    }

    fn commit_credential_with(
        &self,
        intent: u64,
        commit: impl FnOnce() -> Result<GithubCredential>,
    ) -> Result<()> {
        let mut credential = self
            .credential
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if credential.intent != intent {
            return Err(obsolete_auth_intent());
        }
        let replacement = commit()?;
        credential.token = replacement.token;
        credential.source = replacement.source;
        Ok(())
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
            let cached = cached
                .ok_or_else(|| PortcoveError::state("GitHub returned 304 without cached data"))?;
            if cached.body.len() > PROVIDER_JSON_MAX_BYTES {
                return Err(PortcoveError::verification(
                    "cached GitHub response exceeds the 4 MiB metadata limit",
                ));
            }
            let parsed = serde_json::from_str(&cached.body)
                .map_err(|error| PortcoveError::network(error.to_string()))?;
            if let Some(library) = &self.library
                && let Err(error) = library.store_http_cache(
                    url,
                    cached.etag.as_deref(),
                    cached.last_modified.as_deref(),
                    &cached.body,
                )
            {
                tracing::warn!(%error, %url, "could not refresh GitHub HTTP cache age");
            }
            return Ok(parsed);
        }
        let status = response.status();
        if !status.is_success() {
            return Err(github_http_error(status, response.headers()));
        }
        let etag = header_text(response.headers(), header::ETAG);
        let last_modified = header_text(response.headers(), header::LAST_MODIFIED);
        let body =
            bounded_response_bytes(response, PROVIDER_JSON_MAX_BYTES, "GitHub response").await?;
        let parsed = serde_json::from_slice(&body)
            .map_err(|error| PortcoveError::network(error.to_string()))?;
        let body = std::str::from_utf8(&body)
            .map_err(|error| PortcoveError::network(error.to_string()))?;
        if let Some(library) = &self.library
            && let Err(error) =
                library.store_http_cache(url, etag.as_deref(), last_modified.as_deref(), body)
        {
            tracing::warn!(%error, %url, "could not persist GitHub HTTP cache");
        }
        Ok(parsed)
    }

    async fn releases(&self, repository_url: &str) -> Result<Vec<GithubRelease>> {
        let mut releases = Vec::new();
        for page in 1..=GITHUB_MAX_RELEASE_PAGES {
            let url = paginated_url(repository_url, "releases", page, PROVIDER_PAGE_SIZE)?;
            let mut current: Vec<GithubRelease> = self.get_json(&url).await?;
            let has_more = current.len() == PROVIDER_PAGE_SIZE;
            releases.append(&mut current);
            if !has_more {
                return Ok(releases);
            }
        }
        Err(PortcoveError::verification(format!(
            "GitHub release discovery exceeds the supported {}-release bound",
            GITHUB_MAX_RELEASE_PAGES * PROVIDER_PAGE_SIZE
        )))
    }

    async fn cached_release(&self, key: &ReleaseSelectionCacheKey) -> Option<ResolvedRelease> {
        let mut cache = self.cache.write().await;
        cache.retain(|_, entry| entry.stored_at.elapsed() < RELEASE_CACHE_TTL);
        cache.get(key).map(|entry| entry.release.clone())
    }

    async fn store_release(&self, key: ReleaseSelectionCacheKey, release: ResolvedRelease) {
        let mut cache = self.cache.write().await;
        cache.retain(|_, entry| entry.stored_at.elapsed() < RELEASE_CACHE_TTL);
        if !cache.contains_key(&key)
            && cache.len() >= RELEASE_CACHE_MAX_ENTRIES
            && let Some(oldest) = cache
                .iter()
                .min_by_key(|(_, entry)| entry.stored_at)
                .map(|(key, _)| key.clone())
        {
            cache.remove(&oldest);
        }
        cache.insert(
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
        if status == StatusCode::UNAUTHORIZED && authenticated {
            return Ok(GithubAuthStatus {
                source,
                authenticated: false,
                login: None,
                rate_limit,
                device_login_available: github_client_id().is_some(),
            });
        }
        if !status.is_success() {
            return Err(github_http_error(status, response.headers()));
        }
        let login = if authenticated {
            Some(
                parse_bounded_json::<GithubUser>(response, "GitHub user response")
                    .await?
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
        let intent = self.begin_auth_intent();
        self.clear_device_sessions_for_intent(intent).await?;
        self.store_personal_token_for_intent(intent, token).await?;
        self.auth_status().await
    }

    pub async fn logout(&self) -> Result<GithubAuthStatus> {
        let intent = self.begin_auth_intent();
        self.clear_device_sessions_for_intent(intent).await?;
        self.commit_credential_with(intent, || {
            delete_stored_token()?;
            Ok(load_credential())
        })?;
        self.auth_status().await
    }

    pub async fn begin_device_login(&self) -> Result<GithubDeviceLogin> {
        let intent = self.begin_auth_intent();
        self.clear_device_sessions_for_intent(intent).await?;
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
        let authorization: DeviceCodeResponse =
            parse_bounded_json(response, "GitHub device-code response").await?;
        let session_id = Uuid::new_v4().to_string();
        let now = Instant::now();
        let interval = Duration::from_secs(authorization.interval.max(1));
        let lifetime =
            Duration::from_secs(authorization.expires_in.max(1)).min(DEVICE_SESSION_MAX_AGE);
        let mut sessions = self.device_sessions.lock().await;
        let credential = self
            .credential
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if credential.intent != intent {
            return Err(obsolete_auth_intent());
        }
        sessions.retain(|_, session| session.expires_at > now && session.intent == intent);
        if sessions.len() >= DEVICE_SESSION_MAX_ENTRIES
            && let Some(oldest) = sessions
                .iter()
                .min_by_key(|(_, session)| session.created_at)
                .map(|(session_id, _)| session_id.clone())
        {
            sessions.remove(&oldest);
        }
        sessions.insert(
            session_id.clone(),
            DeviceSession {
                client_id,
                device_code: authorization.device_code,
                intent,
                created_at: now,
                expires_at: now + lifetime,
                next_poll_at: now + interval,
                interval,
            },
        );
        drop(credential);
        drop(sessions);
        Ok(GithubDeviceLogin {
            session_id,
            user_code: authorization.user_code,
            verification_uri: authorization.verification_uri,
            expires_at: unix_timestamp() + lifetime.as_secs(),
            interval_seconds: authorization.interval.max(1),
        })
    }

    pub async fn poll_device_login(&self, session_id: &str) -> Result<GithubDeviceLoginResult> {
        let (client_id, device_code, intent) = {
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
            if !self.auth_intent_is_current(session.intent) {
                sessions.remove(session_id);
                return Err(obsolete_auth_intent());
            }
            if session.next_poll_at > Instant::now() {
                return Ok(pending_device_login());
            }
            session.next_poll_at = Instant::now() + session.interval;
            (
                session.client_id.clone(),
                session.device_code.clone(),
                session.intent,
            )
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
        let token: DeviceTokenResponse =
            parse_bounded_json(response, "GitHub device-token response").await?;
        if let Some(access_token) = token.access_token {
            self.device_sessions.lock().await.remove(session_id);
            if !self.auth_intent_is_current(intent) {
                return Err(obsolete_auth_intent());
            }
            self.store_personal_token_for_intent(intent, &access_token)
                .await?;
            let status = self.auth_status().await?;
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

    async fn store_personal_token_for_intent(&self, intent: u64, token: &str) -> Result<()> {
        self.validate_token(token).await?;
        let token = token.to_owned();
        self.commit_credential_with(intent, || {
            store_token(&token)?;
            Ok(load_credential())
        })
    }

    async fn checksum_from_sidecar(
        &self,
        assets: &[GithubAsset],
        target: &GithubAsset,
    ) -> Result<Option<String>> {
        let exact_name = format!("{}.sha256", target.name);
        let exact = assets
            .iter()
            .any(|asset| asset.name.eq_ignore_ascii_case(&exact_name));
        let sidecars = assets
            .iter()
            .filter(|asset| {
                if exact {
                    asset.name.eq_ignore_ascii_case(&exact_name)
                } else {
                    ["sha256sums", "sha256sums.txt", "checksums.txt"]
                        .iter()
                        .any(|name| asset.name.eq_ignore_ascii_case(name))
                }
            })
            .take(CHECKSUM_MAX_SIDECARS + 1)
            .collect::<Vec<_>>();
        if sidecars.len() > CHECKSUM_MAX_SIDECARS {
            return Err(PortcoveError::verification(
                "selected checksum authority exceeds the 8-sidecar limit",
            )
            .detail("reason", "checksum_source_limit"));
        }
        let mut checksum = None;
        for sidecar in sidecars {
            let response = self
                .download_client
                .get(&sidecar.browser_download_url)
                .send()
                .await
                .map_err(|error| PortcoveError::network(error.to_string()))?;
            if !response.status().is_success() {
                return Err(PortcoveError::network(format!(
                    "checksum download returned {}",
                    response.status()
                )));
            }
            let body =
                bounded_response_bytes(response, CHECKSUM_MAX_BYTES, "checksum response").await?;
            let body = std::str::from_utf8(&body)
                .map_err(|error| PortcoveError::network(error.to_string()))?;
            merge_checksum_entries(body, &target.name, exact, &mut checksum)?;
        }
        Ok(checksum)
    }
}

fn merge_checksum_entries(
    body: &str,
    target: &str,
    exact: bool,
    checksum: &mut Option<String>,
) -> Result<()> {
    for line in body.lines() {
        let mut fields = line.split_whitespace();
        let Some(hash) = fields.next() else { continue };
        let file = fields
            .next()
            .unwrap_or_default()
            .trim_start_matches('*')
            .trim_start_matches("./");
        let identity_matches = if exact {
            file.is_empty() || file == target
        } else {
            !file.is_empty() && file == target
        };
        if !identity_matches || !is_sha256(hash) {
            continue;
        }
        if let Some(previous) = checksum.as_ref() {
            if !previous.eq_ignore_ascii_case(hash) {
                return Err(PortcoveError::verification(
                    "conflicting SHA-256 values for the selected release asset",
                )
                .detail("reason", "checksum_ambiguity"));
            }
        } else {
            *checksum = Some(hash.to_ascii_lowercase());
        }
    }
    Ok(())
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
        let repository_url = format!("{}/repos/{}", self.api_root, port.release.repository);
        let repository: GithubRepository = self.get_json(&repository_url).await?;
        if repository.archived {
            return Err(PortcoveError::unsupported(format!(
                "{} is archived upstream",
                port.name
            )));
        }
        let cache_key = ReleaseSelectionCacheKey::new(port, channel, platform);
        if let Some(release) = self.cached_release(&cache_key).await {
            return Ok(release);
        }
        let releases = self.releases(&repository_url).await?;
        let release = select_channel_candidate(
            &releases,
            channel,
            port.release.rolling_tag.as_deref(),
            |release| !release.draft,
            is_beta_release,
            |release| release.tag_name.as_str(),
        )
        .ok_or_else(|| {
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
        let version = release_version(&release.tag_name);
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

pub(crate) fn select_channel_candidate<'a, T>(
    releases: &'a [T],
    channel: ReleaseChannel,
    rolling_tag: Option<&str>,
    selectable: impl Fn(&T) -> bool,
    beta: impl Fn(&T) -> bool,
    tag: impl Fn(&T) -> &str,
) -> Option<&'a T> {
    let is_rolling =
        |release: &T| rolling_tag.is_some_and(|rolling| tag(release).eq_ignore_ascii_case(rolling));
    let exact = releases.iter().find(|release| {
        selectable(release)
            && match channel {
                ReleaseChannel::Stable => !beta(release) && !is_rolling(release),
                ReleaseChannel::Beta => beta(release) && !is_rolling(release),
                ReleaseChannel::Rolling => is_rolling(release),
            }
    });
    if exact.is_some() || channel != ReleaseChannel::Beta {
        return exact;
    }
    // Beta means "newest prerelease, otherwise newest stable" for every
    // hosted provider. It never falls through to drafts, upcoming releases,
    // or an unrelated rolling-only tag.
    releases
        .iter()
        .find(|release| selectable(release) && !beta(release) && !is_rolling(release))
}

fn release_version(tag: &str) -> String {
    tag.to_string()
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
            intent: 0,
        };
    }
    match load_stored_token() {
        Ok(Some(token)) => GithubCredential {
            token: Some(token),
            source: GithubAuthSource::CredentialStore,
            intent: 0,
        },
        Ok(None) | Err(_) => GithubCredential {
            token: None,
            source: GithubAuthSource::Anonymous,
            intent: 0,
        },
    }
}

fn obsolete_auth_intent() -> PortcoveError {
    PortcoveError::conflict(
        "GitHub sign-in result is obsolete because a newer login or logout was started",
    )
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
    let message = if status == StatusCode::UNAUTHORIZED {
        "GitHub rejected the sign-in (401). Sign in again, replace the configured token, or log out to use GitHub anonymously.".to_owned()
    } else {
        format!("GitHub API returned {status}")
    };
    let mut error = PortcoveError::network(message);
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

#[derive(Debug, Clone, Deserialize)]
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
    let Some((best_score, best_asset)) = scored.first() else {
        return Err(PortcoveError::not_found(format!(
            "{} has no supported release asset for {platform:?}",
            port.name
        )));
    };
    if scored.get(1).is_some_and(|(score, _)| score == best_score) {
        return Err(PortcoveError::conflict(format!(
            "{} publishes multiple equally qualified release assets for {platform:?}; catalog metadata must select exactly one",
            port.name
        )));
    }
    Ok(*best_asset)
}

pub(crate) async fn bounded_response_bytes(
    response: reqwest::Response,
    limit: usize,
    label: &str,
) -> Result<Vec<u8>> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err(PortcoveError::verification(format!(
            "{label} exceeds the {limit} byte limit"
        )));
    }
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| PortcoveError::network(error.to_string()))?;
        if chunk.len() > limit.saturating_sub(body.len()) {
            return Err(PortcoveError::verification(format!(
                "{label} exceeds the {limit} byte limit"
            )));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

async fn parse_bounded_json<T: DeserializeOwned>(
    response: reqwest::Response,
    label: &str,
) -> Result<T> {
    let body = bounded_response_bytes(response, PROVIDER_JSON_MAX_BYTES, label).await?;
    serde_json::from_slice(&body).map_err(|error| PortcoveError::network(error.to_string()))
}

pub(crate) fn paginated_url(
    base: &str,
    collection: &str,
    page: usize,
    per_page: usize,
) -> Result<String> {
    let mut url =
        reqwest::Url::parse(base).map_err(|error| PortcoveError::state(error.to_string()))?;
    url.path_segments_mut()
        .map_err(|_| PortcoveError::state("provider API root cannot accept path segments"))?
        .push(collection);
    url.query_pairs_mut()
        .append_pair("per_page", &per_page.to_string())
        .append_pair("page", &page.to_string());
    Ok(url.into())
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

    #[test]
    fn beta_selection_falls_back_only_to_a_selectable_stable_release() {
        #[derive(Debug)]
        struct Candidate(&'static str, bool, bool);
        let candidates = [
            Candidate("draft-beta", true, false),
            Candidate("v3-beta", true, true),
            Candidate("v2", false, true),
            Candidate("nightly", true, true),
        ];
        let beta = select_channel_candidate(
            &candidates,
            ReleaseChannel::Beta,
            Some("nightly"),
            |candidate| candidate.2,
            |candidate| candidate.1,
            |candidate| candidate.0,
        )
        .unwrap();
        assert_eq!(beta.0, "v3-beta");

        let fallback_candidates = [&candidates[0], &candidates[2], &candidates[3]];
        let fallback = select_channel_candidate(
            &fallback_candidates,
            ReleaseChannel::Beta,
            Some("nightly"),
            |candidate| candidate.2,
            |candidate| candidate.1,
            |candidate| candidate.0,
        )
        .unwrap();
        assert_eq!(fallback.0, "v2");
        let stable = select_channel_candidate(
            &candidates,
            ReleaseChannel::Stable,
            Some("nightly"),
            |candidate| candidate.2,
            |candidate| candidate.1,
            |candidate| candidate.0,
        )
        .unwrap();
        assert_eq!(stable.0, "v2");
        let rolling = select_channel_candidate(
            &candidates,
            ReleaseChannel::Rolling,
            Some("NIGHTLY"),
            |candidate| candidate.2,
            |candidate| candidate.1,
            |candidate| candidate.0,
        )
        .unwrap();
        assert_eq!(rolling.0, "nightly");
        assert!(
            select_channel_candidate(
                &candidates,
                ReleaseChannel::Rolling,
                Some("missing"),
                |candidate| candidate.2,
                |candidate| candidate.1,
                |candidate| candidate.0,
            )
            .is_none()
        );
        assert!(
            select_channel_candidate(
                &candidates[..1],
                ReleaseChannel::Beta,
                Some("nightly"),
                |candidate| candidate.2,
                |candidate| candidate.1,
                |candidate| candidate.0,
            )
            .is_none()
        );
    }
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::mpsc::{self, Receiver},
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

    fn short_network_bounds() -> ProviderNetworkBounds {
        ProviderNetworkBounds {
            connect: Duration::from_millis(50),
            read_idle: Duration::from_millis(50),
            request: Duration::from_millis(180),
        }
    }

    fn serve_stalled_response(prefix: &'static [u8], stall: Duration) -> (String, JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 4096];
            let _ = stream.read(&mut request).unwrap();
            stream.write_all(prefix).unwrap();
            stream.flush().unwrap();
            thread::sleep(stall);
        });
        (format!("http://{address}"), server)
    }

    fn serve_trickling_response() -> (String, JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 4096];
            let _ = stream.read(&mut request).unwrap();
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n",
                )
                .unwrap();
            for _ in 0..30 {
                if stream.write_all(b" ").is_err() {
                    break;
                }
                let _ = stream.flush();
                thread::sleep(Duration::from_millis(30));
            }
        });
        (format!("http://{address}"), server)
    }

    #[test]
    fn obsolete_auth_intents_cannot_mutate_credentials() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let provider = GithubReleaseProvider::with_api_root("https://example.invalid").unwrap();
        let token_a = provider.begin_auth_intent();
        let logout = provider.begin_auth_intent();
        let obsolete_commit_calls = AtomicUsize::new(0);
        let error = provider
            .commit_credential_with(token_a, || {
                obsolete_commit_calls.fetch_add(1, Ordering::SeqCst);
                Ok(GithubCredential {
                    token: Some("token-a".into()),
                    source: GithubAuthSource::CredentialStore,
                    intent: 0,
                })
            })
            .unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Conflict);
        assert_eq!(obsolete_commit_calls.load(Ordering::SeqCst), 0);

        provider
            .commit_credential_with(logout, || {
                Ok(GithubCredential {
                    token: None,
                    source: GithubAuthSource::Anonymous,
                    intent: 0,
                })
            })
            .unwrap();
        assert!(provider.active_token().is_none());

        let token_b = provider.begin_auth_intent();
        provider
            .commit_credential_with(token_b, || {
                Ok(GithubCredential {
                    token: Some("token-b".into()),
                    source: GithubAuthSource::CredentialStore,
                    intent: 0,
                })
            })
            .unwrap();
        assert_eq!(provider.active_token().as_deref(), Some("token-b"));
    }

    #[tokio::test]
    async fn obsolete_public_auth_flow_cannot_clear_the_current_device_session() {
        let provider = GithubReleaseProvider::with_api_root("https://example.invalid").unwrap();
        let mut sessions = provider.device_sessions.lock().await;
        let obsolete = {
            let provider = provider.clone();
            tokio::spawn(async move { provider.store_personal_token("token-a").await })
        };
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if provider
                    .credential
                    .read()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .intent
                    != 0
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let current_intent = provider.begin_auth_intent();
        let session_id = Uuid::new_v4().to_string();
        sessions.insert(
            session_id.clone(),
            DeviceSession {
                client_id: "client".into(),
                device_code: "device".into(),
                intent: current_intent,
                created_at: Instant::now(),
                expires_at: Instant::now() + Duration::from_secs(60),
                next_poll_at: Instant::now(),
                interval: Duration::from_secs(1),
            },
        );
        drop(sessions);

        let error = obsolete.await.unwrap().unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Conflict);
        assert!(
            provider
                .device_sessions
                .lock()
                .await
                .contains_key(&session_id)
        );
    }

    #[tokio::test]
    async fn delayed_token_validation_cannot_overwrite_a_newer_login() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 4096];
            let _ = stream.read(&mut request).unwrap();
            started_tx.send(()).unwrap();
            release_rx.blocking_recv().unwrap();
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .unwrap();
        });
        let provider = GithubReleaseProvider::with_api_root(format!("http://{address}")).unwrap();
        let token_a_intent = provider.begin_auth_intent();
        let delayed = {
            let provider = provider.clone();
            tokio::spawn(async move {
                provider.validate_token("token-a").await?;
                provider.commit_credential_with(token_a_intent, || {
                    Ok(GithubCredential {
                        token: Some("token-a".into()),
                        source: GithubAuthSource::CredentialStore,
                        intent: 0,
                    })
                })
            })
        };
        started_rx.await.unwrap();
        let token_b_intent = provider.begin_auth_intent();
        provider
            .commit_credential_with(token_b_intent, || {
                Ok(GithubCredential {
                    token: Some("token-b".into()),
                    source: GithubAuthSource::CredentialStore,
                    intent: 0,
                })
            })
            .unwrap();
        release_tx.send(()).unwrap();
        let error = delayed.await.unwrap().unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Conflict);
        assert_eq!(provider.active_token().as_deref(), Some("token-b"));
        server.join().unwrap();
    }

    #[tokio::test]
    async fn delayed_device_completion_cannot_overwrite_logout() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 4096];
            let _ = stream.read(&mut request).unwrap();
            started_tx.send(()).unwrap();
            release_rx.blocking_recv().unwrap();
            let body = r#"{"access_token":"obsolete-device-token"}"#;
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .unwrap();
        });
        let provider = GithubReleaseProvider::with_api_root(format!("http://{address}")).unwrap();
        let session_id = Uuid::new_v4().to_string();
        provider.device_sessions.lock().await.insert(
            session_id.clone(),
            DeviceSession {
                client_id: "client".into(),
                device_code: "device".into(),
                intent: 0,
                created_at: Instant::now(),
                expires_at: Instant::now() + Duration::from_secs(60),
                next_poll_at: Instant::now(),
                interval: Duration::from_secs(1),
            },
        );
        let delayed = {
            let provider = provider.clone();
            tokio::spawn(async move { provider.poll_device_login(&session_id).await })
        };
        started_rx.await.unwrap();
        let logout_intent = provider.begin_auth_intent();
        provider
            .commit_credential_with(logout_intent, || {
                Ok(GithubCredential {
                    token: None,
                    source: GithubAuthSource::Anonymous,
                    intent: 0,
                })
            })
            .unwrap();
        release_tx.send(()).unwrap();
        let error = delayed.await.unwrap().unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Conflict);
        assert!(provider.active_token().is_none());
        server.join().unwrap();
    }

    #[tokio::test]
    async fn metadata_and_auth_requests_enforce_idle_and_overall_bounds() {
        let (metadata_root, metadata_server) = serve_trickling_response();
        let provider = GithubReleaseProvider::with_api_root_and_bounds(
            metadata_root.clone(),
            short_network_bounds(),
        )
        .unwrap();
        let started = Instant::now();
        let error = provider
            .get_json::<serde_json::Value>(&format!("{metadata_root}/metadata"))
            .await
            .unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Network);
        assert!(started.elapsed() < Duration::from_millis(500));
        metadata_server.join().unwrap();

        let (auth_root, auth_server) = serve_stalled_response(b"", Duration::from_millis(600));
        let provider =
            GithubReleaseProvider::with_api_root_and_bounds(auth_root, short_network_bounds())
                .unwrap();
        let started = Instant::now();
        let error = provider.auth_status().await.unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Network);
        assert!(started.elapsed() < Duration::from_millis(500));
        auth_server.join().unwrap();
    }

    #[tokio::test]
    async fn selected_release_cache_prunes_expired_and_oldest_entries() {
        let provider = GithubReleaseProvider::with_api_root("https://example.invalid").unwrap();
        let release = ResolvedRelease {
            version: "v1".into(),
            channel: ReleaseChannel::Stable,
            published_at: None,
            asset: ReleaseAsset {
                name: "port.zip".into(),
                url: "https://example.invalid/port.zip".into(),
                size: 1,
                sha256: "a".repeat(64),
            },
        };
        let oldest_key = ReleaseSelectionCacheKey {
            repository: "owner/repository-0".into(),
            channel: ReleaseChannel::Stable,
            platform: Platform::WindowsX86_64,
            rolling_tag: None,
            asset_hints: Vec::new(),
        };
        provider
            .store_release(oldest_key.clone(), release.clone())
            .await;
        provider
            .cache
            .write()
            .await
            .get_mut(&oldest_key)
            .unwrap()
            .stored_at -= Duration::from_secs(1);
        for index in 1..=RELEASE_CACHE_MAX_ENTRIES {
            provider
                .store_release(
                    ReleaseSelectionCacheKey {
                        repository: format!("owner/repository-{index}"),
                        channel: ReleaseChannel::Stable,
                        platform: Platform::WindowsX86_64,
                        rolling_tag: None,
                        asset_hints: Vec::new(),
                    },
                    release.clone(),
                )
                .await;
        }
        let cache = provider.cache.read().await;
        assert_eq!(cache.len(), RELEASE_CACHE_MAX_ENTRIES);
        assert!(
            !cache
                .keys()
                .any(|key| key.repository == "owner/repository-0")
        );
        assert!(
            cache
                .keys()
                .any(|key| key.repository
                    == format!("owner/repository-{}", RELEASE_CACHE_MAX_ENTRIES))
        );
    }

    fn serve_routed_http(
        request_limit: usize,
        response: impl Fn(&str) -> String + Send + 'static,
    ) -> (String, Receiver<String>, JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let (requests_tx, requests_rx) = mpsc::channel();
        let server = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(3);
            let mut handled = 0;
            while handled < request_limit && Instant::now() < deadline {
                let (mut stream, _) = match listener.accept() {
                    Ok(connection) => connection,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5));
                        continue;
                    }
                    Err(error) => panic!("test server could not accept a request: {error}"),
                };
                stream.set_nonblocking(false).unwrap();
                let mut request = vec![0_u8; 16 * 1024];
                let size = stream.read(&mut request).unwrap();
                let request = String::from_utf8_lossy(&request[..size]).to_string();
                stream.write_all(response(&request).as_bytes()).unwrap();
                requests_tx.send(request).unwrap();
                handled += 1;
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

    fn github_release(tag: &str, draft: bool, asset_name: &str) -> serde_json::Value {
        serde_json::json!({
            "tag_name": tag,
            "draft": draft,
            "prerelease": false,
            "published_at": null,
            "assets": [{
                "name": asset_name,
                "browser_download_url": "https://downloads.example.invalid/game.zip",
                "size": 1,
                "digest": format!("sha256:{}", "a".repeat(64))
            }]
        })
    }

    fn github_selector_releases() -> String {
        serde_json::to_string(
            &[
                ("nightly-a", true),
                ("nightly-b", true),
                ("v2.0.0", false),
            ]
            .map(|(tag, prerelease)| {
                serde_json::json!({
                    "tag_name": tag,
                    "draft": false,
                    "prerelease": prerelease,
                    "published_at": null,
                    "assets": [
                        {
                            "name": "game-first-windows.zip",
                            "browser_download_url": format!("https://downloads.example.invalid/{tag}-first.zip"),
                            "size": 1,
                            "digest": format!("sha256:{}", "a".repeat(64))
                        },
                        {
                            "name": "game-second-windows.zip",
                            "browser_download_url": format!("https://downloads.example.invalid/{tag}-second.zip"),
                            "size": 2,
                            "digest": format!("sha256:{}", "b".repeat(64))
                        }
                    ]
                })
            }),
        )
        .unwrap()
    }

    #[tokio::test]
    async fn rejected_credentials_leave_sign_in_recovery_available_without_hiding_network_failures()
    {
        for (source, response_code) in [
            (GithubAuthSource::CredentialStore, 401),
            (GithubAuthSource::Environment, 401),
            (GithubAuthSource::CredentialStore, 500),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let server = thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                {
                    use std::io::BufRead;
                    let mut reader = std::io::BufReader::new(&mut stream);
                    loop {
                        let mut line = String::new();
                        assert!(reader.read_line(&mut line).unwrap() > 0);
                        if line == "\r\n" {
                            break;
                        }
                    }
                }
                write!(stream, "HTTP/1.1 {response_code} Test\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
            });
            let provider =
                GithubReleaseProvider::with_api_root(format!("http://{address}")).unwrap();
            provider.set_credential(Some("rejected-test-token".into()), source);
            let result = provider.auth_status().await;
            server.join().unwrap();
            if response_code == 401 {
                let status = result.unwrap();
                assert_eq!(status.source, source);
                assert!(!status.authenticated);
                assert!(status.login.is_none());
                assert!(status.device_login_available);
                assert!(
                    !serde_json::to_string(&status)
                        .unwrap()
                        .contains("rejected-test-token")
                );
                assert_eq!(
                    provider.active_token().as_deref(),
                    Some("rejected-test-token")
                );
            } else {
                assert!(result.is_err());
            }
        }
        assert!(
            github_http_error(StatusCode::UNAUTHORIZED, &header::HeaderMap::new())
                .message
                .contains("Sign in again")
        );
    }

    #[tokio::test]
    async fn device_login_polling_handles_pending_slowdown_expiry_and_cancellation() {
        enum Expected {
            Pending,
            SlowDown,
            Expired,
            Cancelled,
        }
        for (body, expected) in [
            (r#"{"error":"authorization_pending"}"#, Expected::Pending),
            (r#"{"error":"slow_down"}"#, Expected::SlowDown),
            (r#"{"error":"expired_token"}"#, Expected::Expired),
            (r#"{"error":"access_denied"}"#, Expected::Cancelled),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let body = body.to_owned();
            let server = thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = [0_u8; 4096];
                let _ = stream.read(&mut request).unwrap();
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                stream.write_all(response.as_bytes()).unwrap();
            });
            let provider =
                GithubReleaseProvider::with_api_root(format!("http://{address}")).unwrap();
            let session_id = Uuid::new_v4().to_string();
            provider.device_sessions.lock().await.insert(
                session_id.clone(),
                DeviceSession {
                    client_id: "client".into(),
                    device_code: "device".into(),
                    intent: 0,
                    created_at: Instant::now(),
                    expires_at: Instant::now() + Duration::from_secs(60),
                    next_poll_at: Instant::now() - Duration::from_secs(1),
                    interval: Duration::from_secs(1),
                },
            );

            let result = provider.poll_device_login(&session_id).await;
            server.join().unwrap();

            match expected {
                Expected::Pending => {
                    assert_eq!(result.unwrap().state, GithubDeviceLoginState::Pending);
                    assert!(
                        provider
                            .device_sessions
                            .lock()
                            .await
                            .contains_key(&session_id)
                    );
                }
                Expected::SlowDown => {
                    assert_eq!(result.unwrap().state, GithubDeviceLoginState::Pending);
                    assert_eq!(
                        provider.device_sessions.lock().await[&session_id].interval,
                        Duration::from_secs(6)
                    );
                }
                Expected::Expired => {
                    assert_eq!(result.unwrap_err().code, crate::ErrorCode::Network);
                    assert!(
                        !provider
                            .device_sessions
                            .lock()
                            .await
                            .contains_key(&session_id)
                    );
                }
                Expected::Cancelled => {
                    assert_eq!(result.unwrap_err().code, crate::ErrorCode::Conflict);
                    assert!(
                        !provider
                            .device_sessions
                            .lock()
                            .await
                            .contains_key(&session_id)
                    );
                }
            }
        }

        let provider = GithubReleaseProvider::with_api_root("https://example.invalid").unwrap();
        let session_id = Uuid::new_v4().to_string();
        provider.device_sessions.lock().await.insert(
            session_id.clone(),
            DeviceSession {
                client_id: "client".into(),
                device_code: "device".into(),
                intent: 0,
                created_at: Instant::now(),
                expires_at: Instant::now() - Duration::from_secs(1),
                next_poll_at: Instant::now(),
                interval: Duration::from_secs(1),
            },
        );
        let expired = provider.poll_device_login(&session_id).await.unwrap_err();
        assert_eq!(expired.code, crate::ErrorCode::Network);
        assert!(
            !provider
                .device_sessions
                .lock()
                .await
                .contains_key(&session_id)
        );

        let obsolete_session = Uuid::new_v4().to_string();
        provider.device_sessions.lock().await.insert(
            obsolete_session.clone(),
            DeviceSession {
                client_id: "client".into(),
                device_code: "device".into(),
                intent: 0,
                created_at: Instant::now(),
                expires_at: Instant::now() + Duration::from_secs(60),
                next_poll_at: Instant::now(),
                interval: Duration::from_secs(1),
            },
        );
        provider.begin_auth_intent();
        let obsolete = provider
            .poll_device_login(&obsolete_session)
            .await
            .unwrap_err();
        assert_eq!(obsolete.code, crate::ErrorCode::Conflict);
        assert!(
            !provider
                .device_sessions
                .lock()
                .await
                .contains_key(&obsolete_session)
        );
    }

    #[test]
    fn parses_github_digest() {
        let digest = "a".repeat(64);
        assert_eq!(parse_digest(&format!("sha256:{digest}")), Some(digest));
        assert_eq!(parse_digest("md5:nope"), None);
    }

    #[test]
    fn display_versions_do_not_embed_artifact_identity() {
        assert_eq!(release_version("devbuild"), "devbuild");
        assert_eq!(release_version("v1.2.3"), "v1.2.3");
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
    fn paperboat_hints_select_exact_runnable_assets_from_the_complete_release_inventory() {
        let catalog = crate::Catalog::embedded().unwrap();
        let port = catalog.port("paperboat").unwrap();
        let assets = [
            ("Paperboat-Mulberry-Alfa-Linux.zip", 'a'),
            ("Paperboat-Mulberry-Alfa-Mac.zip", 'b'),
            ("Paperboat-Mulberry-Alfa-Win64.zip", 'c'),
        ]
        .map(|(name, digest)| GithubAsset {
            name: name.into(),
            browser_download_url: format!("https://downloads.example.invalid/{name}"),
            size: 1,
            digest: Some(format!("sha256:{}", digest.to_string().repeat(64))),
        });

        assert_eq!(
            choose_asset(port, Platform::WindowsX86_64, &assets)
                .unwrap()
                .name,
            "Paperboat-Mulberry-Alfa-Win64.zip"
        );
        assert_eq!(
            choose_asset(port, Platform::LinuxX86_64, &assets)
                .unwrap()
                .name,
            "Paperboat-Mulberry-Alfa-Linux.zip"
        );
    }

    #[tokio::test]
    async fn paperboat_hint_tracks_a_successor_without_a_definition_edit() {
        let catalog = crate::Catalog::embedded().unwrap();
        let port = catalog.port("paperboat").unwrap();
        let release = |tag: &str, digest: char| {
            serde_json::json!({
                "tag_name": tag,
                "draft": false,
                "prerelease": false,
                "published_at": null,
                "assets": [{
                    "name": format!("Paperboat-{tag}-Win64.zip"),
                    "browser_download_url": format!("https://downloads.example.invalid/paperboat-{tag}.zip"),
                    "size": 1,
                    "digest": format!("sha256:{}", digest.to_string().repeat(64))
                }]
            })
        };
        let v1 = release("1.0.0", 'a');
        let v2 = release("1.1.0", 'b');

        let responses = vec![
            ok_json(r#"{"archived":false}"#, ""),
            ok_json(&serde_json::to_string(&vec![v1.clone()]).unwrap(), ""),
        ];
        let (api_root, _, server) = serve_http(responses);
        let baseline = GithubReleaseProvider::with_api_root(api_root)
            .unwrap()
            .resolve(port, ReleaseChannel::Stable, Platform::WindowsX86_64)
            .await
            .unwrap();
        server.join().unwrap();

        let responses = vec![
            ok_json(r#"{"archived":false}"#, ""),
            ok_json(&serde_json::to_string(&vec![v2, v1]).unwrap(), ""),
        ];
        let (api_root, _, server) = serve_http(responses);
        let successor = GithubReleaseProvider::with_api_root(api_root)
            .unwrap()
            .resolve(port, ReleaseChannel::Stable, Platform::WindowsX86_64)
            .await
            .unwrap();
        server.join().unwrap();

        assert_eq!(baseline.version, "1.0.0");
        assert_eq!(successor.version, "1.1.0");
        assert_eq!(successor.asset.sha256, "b".repeat(64));
        assert_ne!(successor.asset.sha256, baseline.asset.sha256);
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
    fn catalog_linux_hints_select_native_packages_across_real_release_layouts() {
        let catalog = crate::Catalog::embedded().unwrap();
        let cases = [
            (
                "zelda64-recomp",
                vec![
                    "Zelda64Recompiled-v1.2.2-Linux-ARM64.zip",
                    "Zelda64Recompiled-v1.2.2-Linux-Flatpak-X64.zip",
                    "Zelda64Recompiled-v1.2.2-Linux-X64.zip",
                ],
                "Zelda64Recompiled-v1.2.2-Linux-X64.zip",
            ),
            (
                "zelda64-recomp",
                vec![
                    "Zelda64Recompiled-v1.2.1-Linux-ARM64.zip",
                    "Zelda64Recompiled-v1.2.1-Linux-X64-Flatpak.zip",
                    "Zelda64Recompiled-v1.2.1-Linux-X64.zip",
                ],
                "Zelda64Recompiled-v1.2.1-Linux-X64.zip",
            ),
            (
                "banjo-recomp",
                vec![
                    "BanjoRecompiled-v1.0.2-Linux-ARM64.tar.gz",
                    "BanjoRecompiled-v1.0.2-Linux-Flatpak-X64.zip",
                    "BanjoRecompiled-v1.0.2-Linux-X64.tar.gz",
                ],
                "BanjoRecompiled-v1.0.2-Linux-X64.tar.gz",
            ),
            (
                "banjo-recomp",
                vec![
                    "BanjoRecompiled-v1.0.1-Linux-ARM64.zip",
                    "BanjoRecompiled-v1.0.1-Linux-Flatpak-X64.zip",
                    "BanjoRecompiled-v1.0.1-Linux-X64.zip",
                ],
                "BanjoRecompiled-v1.0.1-Linux-X64.zip",
            ),
            (
                "bm64-recomp",
                vec![
                    "BM64Recompiled-AppImage-X64-Release.zip",
                    "BM64Recompiled-Flatpak-X64-Release.zip",
                    "BM64Recompiled-Linux-ARM64-Release.zip",
                    "BM64Recompiled-Linux-X64-Release.zip",
                ],
                "BM64Recompiled-Linux-X64-Release.zip",
            ),
            (
                "harvest-moon-64-recomp",
                vec![
                    "HarvestMoon64Recompiled-v1.2.1-Linux-ARM64.zip",
                    "HarvestMoon64Recompiled-v1.2.1-Linux-Flatpak-X64.zip",
                    "HarvestMoon64Recompiled-v1.2.1-Linux-X64.zip",
                ],
                "HarvestMoon64Recompiled-v1.2.1-Linux-X64.zip",
            ),
            (
                "harvest-moon-64-recomp",
                vec![
                    "HarvestMoon64Recompiled-v1.2.0-Linux-ARM64.zip",
                    "HarvestMoon64Recompiled-v1.2.0-Linux-Flatpak-X64.zip",
                    "HarvestMoon64Recompiled-v1.2.0-Linux-X64.zip",
                ],
                "HarvestMoon64Recompiled-v1.2.0-Linux-X64.zip",
            ),
            (
                "bomberman-hero-recomp",
                vec![
                    "BMHeroRecompiled-AppImage-X64-Release.zip",
                    "BMHeroRecompiled-Flatpak-X64-Release.zip",
                    "BMHeroRecompiled-Linux-ARM64-Release.zip",
                    "BMHeroRecompiled-Linux-X64-Release.zip",
                ],
                "BMHeroRecompiled-Linux-X64-Release.zip",
            ),
            (
                "trouble-makers-recomp",
                vec![
                    "TroubleMakers-SteamDeck-x86_64.AppImage",
                    "TroubleMakers-x86_64.AppImage",
                ],
                "TroubleMakers-x86_64.AppImage",
            ),
            (
                "goemon64-recomp",
                vec![
                    "Goemon64Recompiled-AppImage-X64-Release.zip",
                    "Goemon64Recompiled-Flatpak-X64-Release.zip",
                    "Goemon64Recompiled-Linux-ARM64-Release.zip",
                    "Goemon64Recompiled-Linux-X64-Release.zip",
                ],
                "Goemon64Recompiled-Linux-X64-Release.zip",
            ),
            (
                "goemon64-recomp",
                vec![
                    "Goemon64Recompiled-Flatpak-X64.zip",
                    "Goemon64Recompiled-Linux-ARM64.zip",
                    "Goemon64Recompiled-Linux-X64.zip",
                ],
                "Goemon64Recompiled-Linux-X64.zip",
            ),
        ];

        for (port_id, names, expected) in cases {
            let port = catalog.port(port_id).unwrap();
            let assets = names
                .into_iter()
                .map(|name| GithubAsset {
                    name: name.into(),
                    browser_download_url: "https://example.invalid/package.zip".into(),
                    size: 1,
                    digest: Some(format!("sha256:{}", "a".repeat(64))),
                })
                .collect::<Vec<_>>();
            let selected = choose_asset(port, Platform::LinuxX86_64, &assets).unwrap();
            assert_eq!(selected.name, expected, "{port_id}");
        }
    }

    #[tokio::test]
    async fn native_linux_hint_tracks_a_successor_without_a_definition_edit() {
        let catalog = crate::Catalog::embedded().unwrap();
        let port = catalog.port("zelda64-recomp").unwrap();
        let release = |tag: &str, digest: char| {
            serde_json::json!({
                "tag_name": tag,
                "draft": false,
                "prerelease": false,
                "published_at": null,
                "assets": [
                    {
                        "name": format!("Zelda64Recompiled-{tag}-Linux-Flatpak-X64.zip"),
                        "browser_download_url": "https://downloads.example.invalid/flatpak.zip",
                        "size": 1,
                        "digest": format!("sha256:{}", digest.to_string().repeat(64))
                    },
                    {
                        "name": format!("Zelda64Recompiled-{tag}-Linux-X64.zip"),
                        "browser_download_url": "https://downloads.example.invalid/native.zip",
                        "size": 2,
                        "digest": format!("sha256:{}", digest.to_string().repeat(64))
                    }
                ]
            })
        };
        let v1 = release("v1.2.2", 'a');
        let v2 = release("v1.2.3", 'b');

        let responses = vec![
            ok_json(r#"{"archived":false}"#, ""),
            ok_json(&serde_json::to_string(&vec![v1.clone()]).unwrap(), ""),
        ];
        let (api_root, _, server) = serve_http(responses);
        let baseline = GithubReleaseProvider::with_api_root(api_root)
            .unwrap()
            .resolve(port, ReleaseChannel::Stable, Platform::LinuxX86_64)
            .await
            .unwrap();
        server.join().unwrap();

        let responses = vec![
            ok_json(r#"{"archived":false}"#, ""),
            ok_json(&serde_json::to_string(&vec![v2, v1]).unwrap(), ""),
        ];
        let (api_root, _, server) = serve_http(responses);
        let successor = GithubReleaseProvider::with_api_root(api_root)
            .unwrap()
            .resolve(port, ReleaseChannel::Stable, Platform::LinuxX86_64)
            .await
            .unwrap();
        server.join().unwrap();

        assert_eq!(baseline.version, "v1.2.2");
        assert_eq!(successor.version, "v1.2.3");
        assert_eq!(
            successor.asset.name,
            "Zelda64Recompiled-v1.2.3-Linux-X64.zip"
        );
        assert_eq!(successor.asset.sha256, "b".repeat(64));
        assert_ne!(successor.asset.sha256, baseline.asset.sha256);
    }

    #[tokio::test]
    async fn generic_linux_appimage_hint_tracks_a_successor_without_a_definition_edit() {
        let catalog = crate::Catalog::embedded().unwrap();
        let port = catalog.port("trouble-makers-recomp").unwrap();
        let release = |tag: &str, digest: char| {
            serde_json::json!({
                "tag_name": tag,
                "draft": false,
                "prerelease": true,
                "published_at": null,
                "assets": [
                    {
                        "name": "TroubleMakers-SteamDeck-x86_64.AppImage",
                        "browser_download_url": "https://downloads.example.invalid/steamdeck.AppImage",
                        "size": 1,
                        "digest": format!("sha256:{}", digest.to_string().repeat(64))
                    },
                    {
                        "name": "TroubleMakers-x86_64.AppImage",
                        "browser_download_url": "https://downloads.example.invalid/linux.AppImage",
                        "size": 2,
                        "digest": format!("sha256:{}", digest.to_string().repeat(64))
                    }
                ]
            })
        };
        let v1 = release("v0.8.1", 'a');
        let v2 = release("v0.8.2", 'b');

        let responses = vec![
            ok_json(r#"{"archived":false}"#, ""),
            ok_json(&serde_json::to_string(&vec![v1.clone()]).unwrap(), ""),
        ];
        let (api_root, _, server) = serve_http(responses);
        let baseline = GithubReleaseProvider::with_api_root(api_root)
            .unwrap()
            .resolve(port, ReleaseChannel::Beta, Platform::LinuxX86_64)
            .await
            .unwrap();
        server.join().unwrap();

        let responses = vec![
            ok_json(r#"{"archived":false}"#, ""),
            ok_json(&serde_json::to_string(&vec![v2, v1]).unwrap(), ""),
        ];
        let (api_root, _, server) = serve_http(responses);
        let successor = GithubReleaseProvider::with_api_root(api_root)
            .unwrap()
            .resolve(port, ReleaseChannel::Beta, Platform::LinuxX86_64)
            .await
            .unwrap();
        server.join().unwrap();

        assert_eq!(baseline.version, "v0.8.1");
        assert_eq!(successor.version, "v0.8.2");
        assert_eq!(successor.asset.name, "TroubleMakers-x86_64.AppImage");
        assert_eq!(successor.asset.sha256, "b".repeat(64));
        assert_ne!(successor.asset.sha256, baseline.asset.sha256);
    }

    #[tokio::test]
    async fn version_independent_dr_mario_hint_tracks_the_next_stable_release() {
        let catalog = crate::Catalog::embedded().unwrap();
        let port = catalog.port("dr-mario-64-recomp").unwrap();
        let v1 = github_release("1.0.0", false, "Dr.Mario.64.Recompiled-v1.0.0-Windows.zip");
        let v2 = serde_json::json!({
            "tag_name": "1.1.0",
            "draft": false,
            "prerelease": false,
            "published_at": null,
            "assets": [{
                "name": "Dr.Mario.64.Recompiled-v1.1.0-Windows.zip",
                "browser_download_url": "https://downloads.example.invalid/dr-mario-v1.1.0.zip",
                "size": 2,
                "digest": format!("sha256:{}", "b".repeat(64))
            }]
        });

        let responses = vec![
            ok_json(r#"{"archived":false}"#, ""),
            ok_json(&serde_json::to_string(&vec![v1.clone()]).unwrap(), ""),
        ];
        let (api_root, _, server) = serve_http(responses);
        let baseline = GithubReleaseProvider::with_api_root(api_root)
            .unwrap()
            .resolve(port, ReleaseChannel::Stable, Platform::WindowsX86_64)
            .await
            .unwrap();
        server.join().unwrap();
        assert_eq!(baseline.version, "1.0.0");

        let responses = vec![
            ok_json(r#"{"archived":false}"#, ""),
            ok_json(&serde_json::to_string(&vec![v2, v1]).unwrap(), ""),
        ];
        let (api_root, _, server) = serve_http(responses);
        let successor = GithubReleaseProvider::with_api_root(api_root)
            .unwrap()
            .resolve(port, ReleaseChannel::Stable, Platform::WindowsX86_64)
            .await
            .unwrap();
        server.join().unwrap();
        assert_eq!(successor.version, "1.1.0");
        assert_eq!(
            successor.asset.name,
            "Dr.Mario.64.Recompiled-v1.1.0-Windows.zip"
        );
        assert_eq!(successor.asset.sha256, "b".repeat(64));
        assert_ne!(successor.asset.sha256, baseline.asset.sha256);
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
        let catalog = crate::Catalog::embedded().unwrap();
        let key = ReleaseSelectionCacheKey::new(
            catalog.port("re-blue").unwrap(),
            ReleaseChannel::Stable,
            Platform::WindowsX86_64,
        );
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
    fn release_selection_cache_key_preserves_exact_selector_identity() {
        let catalog = crate::Catalog::embedded().unwrap();
        let mut first = catalog.port("re-blue").unwrap().clone();
        first.release.repository = "shared/project".into();
        first.release.rolling_tag = Some("Nightly".into());
        first.release.asset_hints.insert(
            Platform::WindowsX86_64,
            vec!["first".into(), "second".into()],
        );
        let baseline =
            ReleaseSelectionCacheKey::new(&first, ReleaseChannel::Rolling, Platform::WindowsX86_64);

        let mut different_id = first.clone();
        different_id.id = "another-port-id".into();
        assert_eq!(
            ReleaseSelectionCacheKey::new(
                &different_id,
                ReleaseChannel::Rolling,
                Platform::WindowsX86_64,
            ),
            baseline
        );

        let mut reordered = first.clone();
        reordered.release.asset_hints.insert(
            Platform::WindowsX86_64,
            vec!["second".into(), "first".into()],
        );
        assert_ne!(
            ReleaseSelectionCacheKey::new(
                &reordered,
                ReleaseChannel::Rolling,
                Platform::WindowsX86_64,
            ),
            baseline
        );

        let mut equivalent_case = first.clone();
        equivalent_case.release.rolling_tag = Some("nightly".into());
        equivalent_case.release.asset_hints.insert(
            Platform::WindowsX86_64,
            vec!["FIRST".into(), "SECOND".into()],
        );
        assert_eq!(
            ReleaseSelectionCacheKey::new(
                &equivalent_case,
                ReleaseChannel::Rolling,
                Platform::WindowsX86_64,
            ),
            baseline
        );

        let mut changed_tag = first;
        changed_tag.release.rolling_tag = Some("nightly-next".into());
        assert_ne!(
            ReleaseSelectionCacheKey::new(
                &changed_tag,
                ReleaseChannel::Rolling,
                Platform::WindowsX86_64,
            ),
            baseline
        );
    }

    #[tokio::test]
    async fn github_release_cache_is_scoped_to_the_complete_current_selector() {
        let releases = github_selector_releases();
        let (api_root, requests, server) = serve_routed_http(9, move |request| {
            if request.contains("/releases?") {
                ok_json(&releases, "")
            } else {
                ok_json(r#"{"archived":false}"#, "")
            }
        });
        let provider = GithubReleaseProvider::with_api_root(api_root).unwrap();
        let catalog = crate::Catalog::embedded().unwrap();
        let mut first = catalog.port("re-blue").unwrap().clone();
        first.release.repository = "shared/project".into();
        first.channels = vec![ReleaseChannel::Stable, ReleaseChannel::Rolling];
        first.release.asset_hints.insert(
            Platform::WindowsX86_64,
            vec!["first".into(), "windows".into()],
        );

        let initial = provider
            .resolve(&first, ReleaseChannel::Stable, Platform::WindowsX86_64)
            .await
            .unwrap();
        let unchanged = provider
            .resolve(&first, ReleaseChannel::Stable, Platform::WindowsX86_64)
            .await
            .unwrap();
        assert_eq!(initial.asset.name, "game-first-windows.zip");
        assert_eq!(unchanged.version, initial.version);
        assert_eq!(unchanged.asset.name, initial.asset.name);
        assert_eq!(unchanged.asset.sha256, initial.asset.sha256);

        let mut second = first.clone();
        second.id = "same-repository-second-definition".into();
        second.release.asset_hints.insert(
            Platform::WindowsX86_64,
            vec!["second".into(), "windows".into()],
        );
        let changed_hints = provider
            .resolve(&second, ReleaseChannel::Stable, Platform::WindowsX86_64)
            .await
            .unwrap();
        assert_eq!(changed_hints.asset.name, "game-second-windows.zip");

        first.release.rolling_tag = Some("nightly-a".into());
        let first_rolling = provider
            .resolve(&first, ReleaseChannel::Rolling, Platform::WindowsX86_64)
            .await
            .unwrap();
        first.release.rolling_tag = Some("nightly-b".into());
        let changed_rolling = provider
            .resolve(&first, ReleaseChannel::Rolling, Platform::WindowsX86_64)
            .await
            .unwrap();
        server.join().unwrap();

        assert_eq!(first_rolling.version, "nightly-a");
        assert_eq!(changed_rolling.version, "nightly-b");
        let requests = requests.try_iter().collect::<Vec<_>>();
        assert_eq!(requests.len(), 9);
        assert_eq!(
            requests
                .iter()
                .filter(|request| request.contains("/releases?"))
                .count(),
            4
        );
    }

    #[tokio::test]
    async fn concurrent_github_selectors_do_not_share_a_selected_result() {
        let releases = github_selector_releases();
        let (api_root, requests, server) = serve_routed_http(6, move |request| {
            if request.contains("/releases?") {
                ok_json(&releases, "")
            } else {
                ok_json(r#"{"archived":false}"#, "")
            }
        });
        let provider = GithubReleaseProvider::with_api_root(api_root).unwrap();
        let catalog = crate::Catalog::embedded().unwrap();
        let mut first = catalog.port("re-blue").unwrap().clone();
        first.release.repository = "shared/concurrent".into();
        first
            .release
            .asset_hints
            .insert(Platform::WindowsX86_64, vec!["first".into()]);
        let mut second = first.clone();
        second.id = "same-repository-concurrent-definition".into();
        second
            .release
            .asset_hints
            .insert(Platform::WindowsX86_64, vec!["second".into()]);

        let (first_result, second_result) = tokio::join!(
            provider.resolve(&first, ReleaseChannel::Stable, Platform::WindowsX86_64),
            provider.resolve(&second, ReleaseChannel::Stable, Platform::WindowsX86_64)
        );
        let first_cached = provider
            .resolve(&first, ReleaseChannel::Stable, Platform::WindowsX86_64)
            .await
            .unwrap();
        let second_cached = provider
            .resolve(&second, ReleaseChannel::Stable, Platform::WindowsX86_64)
            .await
            .unwrap();
        server.join().unwrap();

        assert_eq!(first_result.unwrap().asset.name, "game-first-windows.zip");
        assert_eq!(second_result.unwrap().asset.name, "game-second-windows.zip");
        assert_eq!(first_cached.asset.name, "game-first-windows.zip");
        assert_eq!(second_cached.asset.name, "game-second-windows.zip");
        let requests = requests.try_iter().collect::<Vec<_>>();
        assert_eq!(requests.len(), 6);
        assert_eq!(
            requests
                .iter()
                .filter(|request| request.contains("/releases?"))
                .count(),
            2
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

    #[tokio::test]
    async fn malformed_success_never_replaces_a_valid_conditional_cache_entry() {
        let valid = r#"{"archived":false}"#;
        let responses = vec![
            ok_json(valid, "ETag: \"good\"\r\n"),
            ok_json("{malformed", "ETag: \"bad\"\r\n"),
            "HTTP/1.1 304 Not Modified\r\nConnection: close\r\n\r\n".into(),
        ];
        let (api_root, requests, server) = serve_http(responses);
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path()).unwrap();
        let provider =
            GithubReleaseProvider::with_api_root_and_library(api_root.clone(), library).unwrap();
        let url = format!("{api_root}/repos/example/project");

        assert!(
            !provider
                .get_json::<GithubRepository>(&url)
                .await
                .unwrap()
                .archived
        );
        assert!(provider.get_json::<GithubRepository>(&url).await.is_err());
        assert!(
            !provider
                .get_json::<GithubRepository>(&url)
                .await
                .unwrap()
                .archived
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
    async fn github_metadata_and_checksum_bodies_are_bounded() {
        let oversized = PROVIDER_JSON_MAX_BYTES + 1;
        let responses = vec![format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {oversized}\r\nConnection: close\r\n\r\n"
        )];
        let (api_root, _, server) = serve_http(responses);
        let provider = GithubReleaseProvider::with_api_root(api_root.clone()).unwrap();
        let error = provider
            .get_json::<serde_json::Value>(&format!("{api_root}/metadata"))
            .await
            .unwrap_err();
        server.join().unwrap();
        assert_eq!(error.code, crate::ErrorCode::Verification);
        assert!(error.message.contains("4194304 byte limit"));

        let responses = vec![format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            CHECKSUM_MAX_BYTES + 1
        )];
        let (download_root, _, server) = serve_http(responses);
        let provider = GithubReleaseProvider::with_api_root("https://api.example.invalid").unwrap();
        let target = GithubAsset {
            name: "game-windows.zip".into(),
            browser_download_url: "https://downloads.example.invalid/game.zip".into(),
            size: 1,
            digest: None,
        };
        let sidecar = GithubAsset {
            name: "game-windows.zip.sha256".into(),
            browser_download_url: format!("{download_root}/game.sha256"),
            size: 1,
            digest: None,
        };
        let error = provider
            .checksum_from_sidecar(&[target.clone(), sidecar], &target)
            .await
            .unwrap_err();
        server.join().unwrap();
        assert_eq!(error.code, crate::ErrorCode::Verification);
        assert!(error.message.contains("1048576 byte limit"));
    }

    #[test]
    fn equally_scored_github_assets_are_ambiguous() {
        let catalog = crate::Catalog::embedded().unwrap();
        let port = catalog.port("re-blue").unwrap();
        let assets = [
            GithubAsset {
                name: "reblue-windows-one.zip".into(),
                browser_download_url: "https://example.invalid/one.zip".into(),
                size: 1,
                digest: None,
            },
            GithubAsset {
                name: "reblue-windows-two.zip".into(),
                browser_download_url: "https://example.invalid/two.zip".into(),
                size: 1,
                digest: None,
            },
        ];
        let error = choose_asset(port, Platform::WindowsX86_64, &assets).unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Conflict);
        assert!(error.message.contains("equally qualified"));
    }

    #[tokio::test]
    async fn aggregate_checksums_require_a_filename_but_exact_sidecars_accept_a_bare_hash() {
        let digest = "a".repeat(64);
        let responses = vec![
            ok_json(&digest, "Content-Type: text/plain\r\n"),
            ok_json(
                &format!("{digest}  game-windows.zip"),
                "Content-Type: text/plain\r\n",
            ),
            ok_json(&digest, "Content-Type: text/plain\r\n"),
        ];
        let (download_root, _, server) = serve_http(responses);
        let provider = GithubReleaseProvider::with_api_root("https://api.example.invalid").unwrap();
        let target = GithubAsset {
            name: "game-windows.zip".into(),
            browser_download_url: "https://downloads.example.invalid/game.zip".into(),
            size: 1,
            digest: None,
        };
        let aggregate = GithubAsset {
            name: "SHA256SUMS.txt".into(),
            browser_download_url: format!("{download_root}/aggregate"),
            size: 1,
            digest: None,
        };
        assert!(
            provider
                .checksum_from_sidecar(&[target.clone(), aggregate], &target)
                .await
                .unwrap()
                .is_none()
        );
        let aggregate = GithubAsset {
            name: "SHA256SUMS.txt".into(),
            browser_download_url: format!("{download_root}/aggregate-named"),
            size: 1,
            digest: None,
        };
        assert_eq!(
            provider
                .checksum_from_sidecar(&[target.clone(), aggregate], &target)
                .await
                .unwrap(),
            Some(digest.clone())
        );
        let exact = GithubAsset {
            name: "game-windows.zip.sha256".into(),
            browser_download_url: format!("{download_root}/exact"),
            size: 1,
            digest: None,
        };
        assert_eq!(
            provider
                .checksum_from_sidecar(&[target.clone(), exact], &target)
                .await
                .unwrap(),
            Some(digest)
        );
        server.join().unwrap();
    }

    #[tokio::test]
    async fn github_release_discovery_reaches_later_pages_and_preserves_rate_limit_errors() {
        let drafts = (0..PROVIDER_PAGE_SIZE)
            .map(|index| github_release(&format!("draft-{index}"), true, "game-windows.zip"))
            .collect::<Vec<_>>();
        let later = vec![github_release("v1.0.0", false, "game-windows.zip")];
        let responses = vec![
            ok_json(r#"{"archived":false}"#, ""),
            ok_json(&serde_json::to_string(&drafts).unwrap(), ""),
            ok_json(&serde_json::to_string(&later).unwrap(), ""),
        ];
        let (api_root, requests, server) = serve_http(responses);
        let provider = GithubReleaseProvider::with_api_root(api_root).unwrap();
        let catalog = crate::Catalog::embedded().unwrap();
        let release = provider
            .resolve(
                catalog.port("re-blue").unwrap(),
                ReleaseChannel::Stable,
                Platform::WindowsX86_64,
            )
            .await
            .unwrap();
        server.join().unwrap();
        assert_eq!(release.version, "v1.0.0");
        let all_requests = requests.try_iter().collect::<Vec<_>>().join("\n");
        assert!(all_requests.contains("page=2"));

        let responses = vec![
            ok_json(r#"{"archived":false}"#, ""),
            ok_json(&serde_json::to_string(&drafts).unwrap(), ""),
            "HTTP/1.1 429 Too Many Requests\r\nX-RateLimit-Limit: 60\r\nX-RateLimit-Remaining: 0\r\nX-RateLimit-Reset: 1234\r\nRetry-After: 30\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into(),
        ];
        let (api_root, _, server) = serve_http(responses);
        let provider = GithubReleaseProvider::with_api_root(api_root).unwrap();
        let error = provider
            .resolve(
                catalog.port("re-blue").unwrap(),
                ReleaseChannel::Stable,
                Platform::WindowsX86_64,
            )
            .await
            .unwrap_err();
        server.join().unwrap();
        assert_eq!(error.code, crate::ErrorCode::Network);
        assert_eq!(
            error.details.get("rate_remaining").map(String::as_str),
            Some("0")
        );
        assert_eq!(
            error.details.get("retry_after").map(String::as_str),
            Some("30")
        );
    }

    #[tokio::test]
    async fn github_release_pagination_stops_at_the_documented_request_bound() {
        let full_page = (0..PROVIDER_PAGE_SIZE)
            .map(|index| github_release(&format!("draft-{index}"), true, "game-windows.zip"))
            .collect::<Vec<_>>();
        let body = serde_json::to_string(&full_page).unwrap();
        let responses = (0..GITHUB_MAX_RELEASE_PAGES)
            .map(|_| ok_json(&body, ""))
            .collect();
        let (api_root, requests, server) = serve_http(responses);
        let provider = GithubReleaseProvider::with_api_root(api_root.clone()).unwrap();
        let error = provider
            .releases(&format!("{api_root}/repos/example/project"))
            .await
            .unwrap_err();
        server.join().unwrap();
        assert_eq!(error.code, crate::ErrorCode::Verification);
        assert!(error.message.contains("1000-release bound"));
        assert_eq!(requests.try_iter().count(), GITHUB_MAX_RELEASE_PAGES);
    }

    #[tokio::test]
    async fn github_release_cache_revalidates_archive_state_and_fails_closed_offline() {
        let release_body =
            serde_json::to_string(&vec![github_release("v1.0.0", false, "game-windows.zip")])
                .unwrap();
        let catalog = crate::Catalog::embedded().unwrap();
        let port = catalog.port("re-blue").unwrap();

        let responses = vec![
            ok_json(r#"{"archived":false}"#, ""),
            ok_json(&release_body, ""),
            ok_json(r#"{"archived":true}"#, ""),
        ];
        let (api_root, requests, server) = serve_http(responses);
        let provider = GithubReleaseProvider::with_api_root(api_root).unwrap();
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
            ok_json(r#"{"archived":false}"#, ""),
            ok_json(&release_body, ""),
            "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                .into(),
        ];
        let (api_root, _, server) = serve_http(responses);
        let provider = GithubReleaseProvider::with_api_root(api_root).unwrap();
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

    #[tokio::test]
    async fn authenticated_api_redirects_are_not_followed() {
        let redirect_target = TcpListener::bind("127.0.0.1:0").unwrap();
        redirect_target.set_nonblocking(true).unwrap();
        let target_url = format!("http://{}/stolen", redirect_target.local_addr().unwrap());
        let responses = vec![format!(
            "HTTP/1.1 302 Found\r\nLocation: {target_url}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        )];
        let (api_root, requests, server) = serve_http(responses);
        let provider = GithubReleaseProvider::with_api_root(api_root.clone()).unwrap();
        provider.set_credential(
            Some("redirect-secret".into()),
            GithubAuthSource::Environment,
        );
        let error = provider
            .get_json::<serde_json::Value>(&format!("{api_root}/repos/example/project"))
            .await
            .unwrap_err();
        server.join().unwrap();
        assert_eq!(error.code, crate::ErrorCode::Network);
        assert!(
            requests
                .recv()
                .unwrap()
                .to_ascii_lowercase()
                .contains("authorization: bearer redirect-secret")
        );
        assert_eq!(
            redirect_target.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }
    async fn checksum_fixture(names: &[&str], bodies: &[String]) -> Result<Option<String>> {
        let responses = bodies.iter().map(|body| ok_json(body, "")).collect();
        checksum_http_fixture(names, responses).await
    }

    async fn checksum_http_fixture(
        names: &[&str],
        responses: Vec<String>,
    ) -> Result<Option<String>> {
        let response_count = responses.len();
        let (root, requests, server) = serve_http(responses);
        let provider = GithubReleaseProvider::with_api_root("https://api.example.invalid").unwrap();
        let target = GithubAsset {
            name: "game-windows.zip".into(),
            browser_download_url: "https://example.invalid/game-windows.zip".into(),
            size: 1,
            digest: None,
        };
        let assets = names
            .iter()
            .enumerate()
            .map(|(index, name)| GithubAsset {
                name: (*name).into(),
                browser_download_url: format!("{root}/{index}"),
                size: 1,
                digest: None,
            })
            .collect::<Vec<_>>();
        let result = provider.checksum_from_sidecar(&assets, &target).await;
        // Check before joining so a regression that skips a response fails promptly.
        assert_eq!(requests.try_iter().count(), response_count);
        server.join().unwrap();
        result
    }

    #[tokio::test]
    async fn contradictory_checksum_lines_fail_in_both_orders() {
        let a = "a".repeat(64);
        let b = "b".repeat(64);
        for (first, second) in [(&a, &b), (&b, &a)] {
            let body = format!("{first}  game-windows.zip\n{second}  game-windows.zip\n");
            let error = checksum_fixture(&["SHA256SUMS"], &[body])
                .await
                .unwrap_err();
            assert_eq!(error.code, crate::ErrorCode::Verification);
            assert_eq!(
                error.details.get("reason").map(String::as_str),
                Some("checksum_ambiguity")
            );
            assert_eq!(error.details.len(), 1);
            assert!(error.message.len() < 160);
            let error = checksum_fixture(
                &["game-windows.zip.sha256"],
                &[format!("{first}\n{second}\n")],
            )
            .await
            .unwrap_err();
            assert_eq!(error.code, crate::ErrorCode::Verification);
            assert_eq!(error.details["reason"], "checksum_ambiguity");
        }
    }

    #[tokio::test]
    async fn later_invalid_checksum_responses_never_return_an_earlier_digest() {
        let valid = ok_json(&format!("{} game-windows.zip\n", "a".repeat(64)), "");
        for (response, code) in [
            (
                // One declared byte truncates the two-byte character: invalid UTF-8.
                "HTTP/1.1 200 OK\r\nContent-Length: 1\r\nConnection: close\r\n\r\né".into(),
                crate::ErrorCode::Network,
            ),
            (
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    CHECKSUM_MAX_BYTES + 1
                ),
                crate::ErrorCode::Verification,
            ),
            (
                "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into(),
                crate::ErrorCode::Network,
            ),
        ] {
            let error = checksum_http_fixture(
                &["SHA256SUMS", "checksums.txt"],
                vec![valid.clone(), response],
            )
            .await
            .unwrap_err();
            assert_eq!(error.code, code);
        }
    }

    #[tokio::test]
    async fn checksum_manifests_agree_or_fail_independently_of_asset_order() {
        let a = "a".repeat(64);
        let b = "b".repeat(64);
        for names in [
            ["SHA256SUMS", "checksums.txt"],
            ["checksums.txt", "SHA256SUMS"],
        ] {
            for hashes in [[&a, &b], [&b, &a]] {
                let bodies = hashes.map(|hash| format!("{hash} *./game-windows.zip\n"));
                let error = checksum_fixture(&names, &bodies).await.unwrap_err();
                assert_eq!(error.code, crate::ErrorCode::Verification);
                assert_eq!(error.details["reason"], "checksum_ambiguity");
            }
            let bodies = [
                format!("{a} game-windows.zip\n"),
                format!("{} game-windows.zip\n", a.to_uppercase()),
            ];
            assert_eq!(
                checksum_fixture(&names, &bodies).await.unwrap(),
                Some(a.clone())
            );
        }
    }

    #[tokio::test]
    async fn checksum_identity_and_consistent_duplicate_lines_are_preserved() {
        let a = "a".repeat(64);
        let b = "b".repeat(64);
        for exact in [false, true] {
            let name = if exact {
                "GAME-WINDOWS.ZIP.SHA256"
            } else {
                "sHa256SuMs.TxT"
            };
            let matching = if exact {
                format!("{a}\n")
            } else {
                format!("{a} ./game-windows.zip\n")
            };
            let unrelated =
                format!("{b} Game-windows.zip\n{b} other.zip\nnot-a-hash game-windows.zip\n");
            for body in [
                format!(
                    "{unrelated}{matching}{} *game-windows.zip\n",
                    a.to_uppercase()
                ),
                format!(
                    "{} *game-windows.zip\n{matching}{unrelated}",
                    a.to_uppercase()
                ),
            ] {
                assert_eq!(
                    checksum_fixture(&[name], &[body]).await.unwrap(),
                    Some(a.clone())
                );
            }
        }
        let body = format!("{a}\n{b} Game-windows.zip\nnot-a-hash game-windows.zip\n");
        assert_eq!(
            checksum_fixture(&["SHA256SUMS"], &[body]).await.unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn exact_checksum_authority_ignores_aggregates_and_compares_duplicate_sidecars() {
        let a = "a".repeat(64);
        let b = "b".repeat(64);
        for names in [
            ["SHA256SUMS", "game-windows.zip.sha256"],
            ["game-windows.zip.sha256", "SHA256SUMS"],
        ] {
            assert_eq!(
                checksum_fixture(&names, std::slice::from_ref(&a))
                    .await
                    .unwrap(),
                Some(a.clone())
            );
            assert_eq!(
                checksum_fixture(&names, &["malformed".into()])
                    .await
                    .unwrap(),
                None
            );
        }
        let names = ["game-windows.zip.sha256", "GAME-WINDOWS.ZIP.SHA256"];
        assert_eq!(
            checksum_fixture(&names, &[a.clone(), a.to_uppercase()])
                .await
                .unwrap(),
            Some(a.clone())
        );
        for bodies in [[a.clone(), b.clone()], [b, a]] {
            let error = checksum_fixture(&names, &bodies).await.unwrap_err();
            assert_eq!(error.code, crate::ErrorCode::Verification);
            assert_eq!(error.details["reason"], "checksum_ambiguity");
        }
    }

    #[tokio::test]
    async fn checksum_request_budget_rejects_before_any_download() {
        let a = "a".repeat(64);
        let names = vec!["SHA256SUMS"; CHECKSUM_MAX_SIDECARS];
        let bodies = vec![format!("{a} game-windows.zip\n"); CHECKSUM_MAX_SIDECARS];
        assert_eq!(
            checksum_fixture(&names, &bodies).await.unwrap(),
            Some(a.clone())
        );
        for name in ["SHA256SUMS", "game-windows.zip.sha256"] {
            let error = checksum_fixture(&[name; CHECKSUM_MAX_SIDECARS + 1], &[])
                .await
                .unwrap_err();
            assert_eq!(error.code, crate::ErrorCode::Verification);
            assert_eq!(error.details["reason"], "checksum_source_limit");
        }
        let mut names = vec!["SHA256SUMS"; CHECKSUM_MAX_SIDECARS + 1];
        names.push("game-windows.zip.sha256");
        assert_eq!(
            checksum_fixture(&names, std::slice::from_ref(&a))
                .await
                .unwrap(),
            Some(a)
        );
    }

    #[tokio::test]
    async fn provider_digest_precedes_even_excessive_conflicting_sidecars() {
        let mut release = github_release("v1.0.0", false, "game-windows.zip");
        for index in 0..CHECKSUM_MAX_SIDECARS + 1 {
            release["assets"].as_array_mut().unwrap().push(serde_json::json!({
                "name": "game-windows.zip.sha256",
                "browser_download_url": format!("https://example.invalid/never-requested-{index}"),
                "size": 1
            }));
        }
        let responses = vec![
            ok_json(r#"{"archived":false}"#, ""),
            ok_json(&serde_json::to_string(&vec![release]).unwrap(), ""),
        ];
        let (root, requests, server) = serve_http(responses);
        let provider = GithubReleaseProvider::with_api_root(root).unwrap();
        let catalog = crate::Catalog::embedded().unwrap();
        let resolved = provider
            .resolve(
                catalog.port("re-blue").unwrap(),
                ReleaseChannel::Stable,
                Platform::WindowsX86_64,
            )
            .await
            .unwrap();
        assert_eq!(requests.try_iter().count(), 2);
        server.join().unwrap();
        assert_eq!(resolved.asset.sha256, "a".repeat(64));
    }
}
