#[cfg(test)]
use crate::test_http::{ResponseTestEvent, ResponseTestPhase, observe_test_response};
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

use crate::acquisition_restriction::{EffectiveRestrictions, Knowledge, RestrictedOperation};
use crate::{
    AdapterKind, GithubAuthSource, GithubAuthStatus, GithubDeviceLogin, GithubDeviceLoginResult,
    GithubDeviceLoginState, GithubRateLimit, Library, Platform, PortDefinition, PortcoveError,
    ReleaseAsset, ReleaseChannel, ResolvedRelease, Result,
    auth::{
        delete_stored_token, environment_token, github_client_id, load_stored_token, store_token,
    },
    library::HttpCacheEntry,
};

mod catalog_download;
mod catalog_download_observation;
mod exact;
#[cfg(any(test, feature = "qualification-fixtures"))]
mod forbidden_memories_qualification;
mod managed_variant;
mod observation;
mod uploader_continuity;
pub(crate) use catalog_download::repository_from_url as catalog_download_repository;
pub(crate) use exact::ExactReleaseRefusal;
pub use exact::{
    ExactReleaseHold, ExactReleaseHoldReason, ExactReleaseIdentity, ExactReleaseSelection,
};
pub(crate) use exact::{
    ExactReleaseQuery, is_published as is_exact_release_published, require_exact_release_route,
};
pub use managed_variant::ManagedPackageVariant;
pub(crate) use observation::encoded_segment_matches as observed_url_segment_matches;
pub use observation::{
    ChannelObservation as UpstreamChannelObservation, ObservationEvidence, ObservedReleaseIdentity,
    ObservedResolution, UpstreamObservationReport, inspect_upstream_observation,
};
pub(crate) use uploader_continuity::{
    RecordedAcquisition, require_recorded as require_recorded_uploader_continuity,
};

#[async_trait]
pub trait ReleaseProvider: Send + Sync {
    async fn resolve(
        &self,
        port: &PortDefinition,
        channel: ReleaseChannel,
        platform: Platform,
    ) -> Result<ResolvedRelease>;

    /// A legacy provider cannot silently accept an authenticated acquisition scope.
    async fn resolve_scoped(
        &self,
        port: &PortDefinition,
        channel: ReleaseChannel,
        platform: Platform,
        scope: Option<&crate::DefinitionAcquisitionScope>,
    ) -> Result<crate::ScopedResolvedRelease> {
        if scope.is_some() {
            return Err(PortcoveError::unsupported(
                "release provider does not implement managed GitHub scope",
            ));
        }
        self.resolve(port, channel, platform)
            .await
            .and_then(|release| {
                crate::ScopedResolvedRelease::legacy(release).for_selection(port, platform, channel)
            })
    }

    /// Observe one tag under the current route rules for later confirmation.
    async fn review_exact(
        &self,
        _port: &PortDefinition,
        _channel: ReleaseChannel,
        _platform: Platform,
        _scope: Option<&crate::DefinitionAcquisitionScope>,
        _version: &str,
    ) -> Result<ExactReleaseSelection> {
        Err(PortcoveError::unsupported(
            "the release provider cannot observe an exact historical release",
        ))
    }

    /// Resolve only the identified historical release and package. Providers
    /// without exact selection support refuse instead of following the channel.
    async fn resolve_exact(
        &self,
        _port: &PortDefinition,
        _channel: ReleaseChannel,
        _platform: Platform,
        _scope: Option<&crate::DefinitionAcquisitionScope>,
        _pin: &ExactReleaseSelection,
    ) -> Result<crate::ScopedResolvedRelease> {
        Err(PortcoveError::unsupported(
            "the release provider cannot resolve an exact historical release",
        ))
    }

    async fn resolve_saved_variant(
        &self,
        _port: &PortDefinition,
        _channel: ReleaseChannel,
        _platform: Platform,
        _scope: Option<&crate::DefinitionAcquisitionScope>,
        _variant: &ManagedPackageVariant,
    ) -> Result<crate::ScopedResolvedRelease> {
        Err(PortcoveError::unsupported(
            "the release provider cannot resolve this saved package choice",
        ))
    }

    async fn resolve_explicit_first_variant(
        &self,
        _port: &PortDefinition,
        _channel: ReleaseChannel,
        _platform: Platform,
        _variant: &ManagedPackageVariant,
    ) -> Result<crate::ScopedResolvedRelease> {
        Err(PortcoveError::unsupported(
            "the release provider cannot resolve an explicit first-install package choice",
        ))
    }

    /// Resolve a reviewed fallback for an already-withheld fresh-install candidate.
    /// Providers without exact reviewed-release selection keep the refusal.
    async fn resolve_shape_fallback(
        &self,
        _port: &PortDefinition,
        _platform: Platform,
        _scope: Option<&crate::DefinitionAcquisitionScope>,
        _withheld: &ResolvedRelease,
    ) -> Result<Option<crate::ScopedResolvedRelease>> {
        Ok(None)
    }

    /// The expected provider cost of one check, read from local state only. A provider
    /// with no per-request limit to protect reports none.
    async fn forecast_request_cost(
        &self,
        _port: &PortDefinition,
        _platform: Platform,
        _scoped: bool,
    ) -> Result<crate::RequestCostForecast> {
        Ok(crate::RequestCostForecast::default())
    }

    /// Provider request budget for a check that must enforce a reviewed package choice.
    fn forecast_saved_variant_request_cost(&self, _scoped: bool) -> crate::RequestCostForecast {
        crate::RequestCostForecast::default()
    }

    fn forecast_explicit_variant_request_cost(&self) -> crate::RequestCostForecast {
        crate::RequestCostForecast::default()
    }

    /// Informational release notes between the installed and offered versions, read
    /// only from metadata this provider already persisted. Never makes a request.
    /// `None` means the provider has no hosted release list for this port.
    fn cached_release_notes(
        &self,
        _port: &PortDefinition,
        _channel: ReleaseChannel,
        _platform: Platform,
        _installed: Option<&str>,
        _offered: &str,
    ) -> Option<crate::UpdateReleaseNotes> {
        None
    }
}

/// The request cost of one GitHub check from what is already cached. An ordinary request
/// is conditional, so a cached resource answers 304 and is not counted. A managed-scope
/// request is unconditional and unauthenticated: it always counts, and signing in never
/// raises its limit. The forecast is a floor for managed-scope curated ports (an
/// annotated tag adds peel requests), ignores pages beyond the first of a long release
/// list and the five-minute in-memory selection cache, and reads the persisted cache
/// without extending it. A provider that cannot forecast reports the default, which
/// means unknown, not free.
fn github_cost_forecast(
    scoped: bool,
    curated: bool,
    repository_cached: bool,
    first_releases_page_cached: bool,
) -> crate::RequestCostForecast {
    if scoped {
        return crate::RequestCostForecast {
            counted_requests: 2 + u32::from(curated),
            sign_in_relief_requests: 0,
        };
    }
    let uncached = u32::from(!repository_cached) + u32::from(!first_releases_page_cached);
    crate::RequestCostForecast {
        counted_requests: uncached,
        sign_in_relief_requests: uncached,
    }
}

#[derive(Clone)]
pub struct GithubReleaseProvider {
    api_transport: reqwest::Client,
    device_transport: reqwest::Client,
    download_client: reqwest::Client,
    network_bounds: ProviderNetworkBounds,
    api_root: String,
    web_root: String,
    library: Option<Library>,
    #[cfg(feature = "qualification-fixtures")]
    qualification_origin: Option<String>,
    credential: Arc<StdRwLock<GithubCredential>>,
    cache: Arc<RwLock<HashMap<ReleaseSelectionCacheKey, CachedRelease>>>,
    device_sessions: Arc<Mutex<HashMap<String, DeviceSession>>>,
}

struct GithubCredential {
    token: Option<String>,
    source: GithubAuthSource,
    environment_variable: Option<&'static str>,
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
    adapter: AdapterKind,
    n64_runtime_at_executable_parent: bool,
    partitioned_archive: bool,
    requires_tar_xz: bool,
    native_appimage: bool,
    native_appimage_two_part: bool,
    restricted_native_archive: bool,
    repository: String,
    channel: ReleaseChannel,
    platform: Platform,
    rolling_tag: Option<String>,
    asset_hints: Vec<String>,
    other_stream_tag_prefixes: Vec<String>,
    accepted_uploaders: Vec<u64>,
    scope_binding: Option<String>,
    acquisition_policy: Option<crate::ManagedAcquisitionHold>,
}

impl ReleaseSelectionCacheKey {
    pub(crate) fn new(port: &PortDefinition, channel: ReleaseChannel, platform: Platform) -> Self {
        let appimage = native_appimage(port, platform);
        Self {
            adapter: port.adapter,
            n64_runtime_at_executable_parent: port.n64_runtime_at_executable_parent,
            partitioned_archive: port.archive_data_compatibility_v1.is_some(),
            requires_tar_xz: port.release.requires_tar_xz(platform),
            native_appimage: appimage.is_some(),
            native_appimage_two_part: matches!(
                appimage,
                Some(NativeAppImage::Versioned {
                    allow_two_part: true,
                    ..
                })
            ),
            restricted_native_archive: crate::native_external_profile::openmohaa::requires_zip(
                port, platform,
            )
                || crate::native_external_profile::quake_linux::requires_ironwail_tar(
                    port, platform,
                )
                || crate::native_external_profile::profile_siblings::requires_openloco_zip(
                    port, platform,
                )
                || crate::native_external_profile::archive_siblings::requires_archive(
                    port, platform,
                )
                || crate::native_external_profile::openjk::requires_archive(port, platform)
                || crate::native_external_profile::vcmi::requires_archive(port, platform)
                || crate::native_portable_data::directory_name(port, platform).is_some(),
            scope_binding: None,
            acquisition_policy: port.managed_acquisition_hold.clone(),
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
            other_stream_tag_prefixes: port.release.github_stream_exclusions(platform).to_vec(),
            accepted_uploaders: {
                let mut ids = port
                    .release
                    .accepted_uploaders
                    .iter()
                    .map(|accepted| accepted.id)
                    .collect::<Vec<_>>();
                ids.sort_unstable();
                ids.dedup();
                ids
            },
        }
    }
}

#[derive(Debug, Clone)]
struct CachedRelease {
    stored_at: Instant,
    release: ResolvedRelease,
    identity: Option<crate::definition_acquisition::GithubArtifactIdentity>,
    fallback_reason: Option<String>,
}

struct ResolvedGithub {
    release: ResolvedRelease,
    identity: Option<crate::definition_acquisition::GithubArtifactIdentity>,
    explicit_tag_commit: Option<String>,
    activity: Option<crate::UpstreamActivity>,
    fallback_reason: Option<String>,
}

const RELEASE_CACHE_TTL: Duration = Duration::from_secs(5 * 60);
// One complete bulk check must fit in the selector cache, or later items evict
// earlier ones and repeat provider reads within the same TTL. The embedded
// catalog test below keeps every platform's provider selector slots within
// half of this bound, so catalog growth fails CI before it degrades caching.
pub(crate) const RELEASE_CACHE_MAX_ENTRIES: usize = 1024;
pub(crate) const PROVIDER_JSON_MAX_BYTES: usize = 4 * 1024 * 1024;
const CHECKSUM_MAX_BYTES: usize = 1024 * 1024;
const CHECKSUM_MAX_SIDECARS: usize = 8;
const PROVIDER_PAGE_SIZE: usize = 100;
/// Pages the request-cost forecast and offline release notes consider. It is
/// not a selection bound: selection reads as much history as its choice needs.
const GITHUB_MAX_RELEASE_PAGES: usize = 10;
const GITHUB_SAVED_RELEASE_INVENTORY_LIMIT: usize = 10;
/// Asset pages of 100 a release inventory may read: GitHub allows at most
/// 1,000 assets per release, so ten pages always reach the complete inventory.
const GITHUB_ASSET_INVENTORY_PAGE_LIMIT: usize = 10;
/// Asset pages the request-cost forecast budgets for a typical saved package
/// release; the inventory itself reads to completion.
const GITHUB_FORECAST_ASSET_PAGES: usize = 3;
// Small provider metadata and authentication requests get an overall deadline;
// streamed downloads intentionally use only connection and read-idle bounds.
const PROVIDER_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const PROVIDER_READ_IDLE_TIMEOUT: Duration = Duration::from_secs(15);
const PROVIDER_REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
const PROVIDER_USER_AGENT: &str = concat!("Portcove/", env!("CARGO_PKG_VERSION"));
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
    pub(crate) fn for_acquisition_scope(scope: &crate::DefinitionAcquisitionScope) -> Result<Self> {
        scope.require_current()?;
        let origin = "https://api.github.com";
        #[cfg(any(test, feature = "qualification-fixtures"))]
        let origin = if let Some(origin) = &scope.fixture_origin {
            crate::definition_acquisition::validate_fixture_origin(origin)?;
            origin.as_str()
        } else {
            origin
        };
        Self::build_with_credential(
            Some(scope.library.clone()),
            origin,
            "https://github.com",
            PROVIDER_NETWORK_BOUNDS,
            Some(GithubCredential {
                token: None,
                source: GithubAuthSource::Anonymous,
                environment_variable: None,
                intent: 0,
            }),
            origin != "https://api.github.com",
        )
    }

    pub fn for_library(library: &Library) -> Result<Self> {
        Self::build(
            Some(library.clone()),
            "https://api.github.com",
            "https://github.com",
        )
    }

    async fn curated_tag_commit(
        &self,
        port: &PortDefinition,
        record: &crate::CuratedAcquisitionRecord,
        scope: &crate::DefinitionAcquisitionScope,
    ) -> Result<String> {
        self.github_tag_commit(port, &record.tag, Some(scope)).await
    }

    async fn github_tag_commit(
        &self,
        port: &PortDefinition,
        release_tag: &str,
        scope: Option<&crate::DefinitionAcquisitionScope>,
    ) -> Result<String> {
        let mut url = reqwest::Url::parse(&format!(
            "{}/repos/{}",
            self.api_root, port.release.repository
        ))
        .map_err(|_| PortcoveError::verification("invalid curated repository URL"))?;
        url.path_segments_mut()
            .map_err(|_| PortcoveError::verification("invalid curated tag URL"))?
            .extend(["git", "ref", "tags", release_tag]);
        let reference: GithubTagReference = match scope {
            Some(scope) => self.scoped_json(url.as_str(), scope).await?,
            None => self.get_json(url.as_str()).await?,
        };
        if reference.reference != format!("refs/tags/{release_tag}") {
            return Err(PortcoveError::verification("curated tag reference differs"));
        }
        let mut object = reference.object;
        let mut visited = std::collections::BTreeSet::new();
        for _ in 0..5 {
            if object.sha.len() != 40
                || !object
                    .sha
                    .bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
                || !visited.insert(object.sha.clone())
            {
                return Err(PortcoveError::verification(
                    "invalid or cyclic curated tag object",
                ));
            }
            if object.kind == "commit" {
                return Ok(object.sha);
            }
            if object.kind != "tag" {
                return Err(PortcoveError::verification(
                    "curated tag does not identify a commit",
                ));
            }
            let tag_url = format!(
                "{}/repos/{}/git/tags/{}",
                self.api_root, port.release.repository, object.sha
            );
            let tag: GithubAnnotatedTag = match scope {
                Some(scope) => self.scoped_json(&tag_url, scope).await?,
                None => self.get_json(&tag_url).await?,
            };
            if tag.sha != object.sha {
                return Err(PortcoveError::verification(
                    "curated annotated tag identity differs",
                ));
            }
            object = tag.object;
        }
        Err(PortcoveError::verification(
            "curated annotated tag exceeds its peel bound",
        ))
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
        Self::build_with_credential(library, api_root, web_root, bounds, None, false)
    }

    fn build_with_credential(
        library: Option<Library>,
        api_root: &str,
        web_root: &str,
        bounds: ProviderNetworkBounds,
        credential: Option<GithubCredential>,
        qualification: bool,
    ) -> Result<Self> {
        let build_transport = || {
            let mut transport = reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .retry(reqwest::retry::never())
                .user_agent(PROVIDER_USER_AGENT)
                .connect_timeout(bounds.connect)
                .read_timeout(bounds.read_idle)
                .timeout(bounds.request);
            if qualification {
                transport = transport.no_proxy();
            }
            transport
                .build()
                .map_err(|error| PortcoveError::network(error.to_string()))
        };
        let download_builder = reqwest::Client::builder();
        let download_builder = if qualification {
            download_builder.no_proxy()
        } else {
            download_builder
        };
        let download_client = download_builder
            .redirect(reqwest::redirect::Policy::limited(5))
            .user_agent(PROVIDER_USER_AGENT)
            .connect_timeout(bounds.connect)
            .read_timeout(bounds.read_idle)
            .build()
            .map_err(|error| PortcoveError::network(error.to_string()))?;
        Ok(Self {
            api_transport: build_transport()?,
            device_transport: build_transport()?,
            download_client,
            network_bounds: bounds,
            api_root: api_root.into(),
            web_root: web_root.into(),
            library,
            #[cfg(feature = "qualification-fixtures")]
            qualification_origin: None,
            credential: Arc::new(StdRwLock::new(credential.unwrap_or_else(load_credential))),
            cache: Arc::new(RwLock::new(HashMap::new())),
            device_sessions: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    /// Bind an explicitly qualification-capable client to one fixture library.
    #[cfg(feature = "qualification-fixtures")]
    pub fn for_qualification_library(
        library: &Library,
        expected_root: &std::path::Path,
        origin: &str,
    ) -> Result<Self> {
        crate::definition_acquisition::validate_fixture_origin(origin)?;
        let expected = std::fs::canonicalize(expected_root)?;
        let actual = std::fs::canonicalize(library.root())?;
        if expected != actual {
            return Err(PortcoveError::verification(
                "qualification library binding does not match",
            ));
        }
        let mut provider = Self::build_with_credential(
            Some(library.clone()),
            origin,
            origin,
            PROVIDER_NETWORK_BOUNDS,
            Some(GithubCredential {
                token: None,
                source: GithubAuthSource::Anonymous,
                environment_variable: None,
                intent: 0,
            }),
            true,
        )?;
        provider.qualification_origin = Some(origin.to_owned());
        Ok(provider)
    }

    #[cfg(feature = "qualification-fixtures")]
    fn bind_qualification_scope(
        &self,
        scope: Option<&crate::DefinitionAcquisitionScope>,
    ) -> Result<Option<crate::DefinitionAcquisitionScope>> {
        let Some(origin) = &self.qualification_origin else {
            return Ok(scope.cloned());
        };
        crate::definition_acquisition::validate_fixture_origin(origin)?;
        let mut scope = scope.cloned().ok_or_else(|| {
            PortcoveError::verification(
                "qualification acquisition requires an admitted managed definition",
            )
        })?;
        if self
            .library
            .as_ref()
            .is_none_or(|library| library.root() != scope.library.root())
        {
            return Err(PortcoveError::verification(
                "qualification acquisition library does not match",
            ));
        }
        scope.fixture_origin = Some(origin.clone());
        Ok(Some(scope))
    }

    #[cfg(test)]
    pub fn with_api_root(api_root: impl Into<String>) -> Result<Self> {
        let api_root = api_root.into();
        let provider = Self::build(None, &api_root, &api_root)?;
        provider.set_credential(None, GithubAuthSource::Anonymous);
        Ok(provider)
    }

    #[cfg(test)]
    pub(crate) fn with_api_root_and_library(
        api_root: impl Into<String>,
        library: Library,
    ) -> Result<Self> {
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

    fn metadata_headers(
        &self,
        url: &str,
        token: Option<&str>,
        cached: Option<&HttpCacheEntry>,
    ) -> Result<header::HeaderMap> {
        let mut headers = header::HeaderMap::new();
        headers.insert(
            "x-github-api-version",
            header::HeaderValue::from_static("2022-11-28"),
        );
        headers.insert(
            header::CONTENT_LENGTH,
            header::HeaderValue::from_static("0"),
        );
        if same_origin(url, &self.api_root)
            && let Some(token) = token
        {
            let mut value = header::HeaderValue::from_str(&format!("Bearer {token}"))
                .map_err(|error| PortcoveError::network(error.to_string()))?;
            value.set_sensitive(true);
            headers.insert(header::AUTHORIZATION, value);
        }
        if let Some(cached) = cached {
            for (name, value) in [
                (header::IF_NONE_MATCH, cached.etag.as_deref()),
                (header::IF_MODIFIED_SINCE, cached.last_modified.as_deref()),
            ] {
                if let Some(value) = value {
                    headers.insert(
                        name,
                        header::HeaderValue::from_str(value)
                            .map_err(|error| PortcoveError::network(error.to_string()))?,
                    );
                }
            }
        }
        Ok(headers)
    }

    fn metadata_request(
        &self,
        url: &str,
        token: Option<&str>,
        cached: Option<&HttpCacheEntry>,
    ) -> impl std::future::Future<Output = Result<reqwest::Response>> + Send + 'static + use<> {
        let headers = self.metadata_headers(url, token, cached);
        let url = reqwest::Url::parse(url);
        let transport = self.api_transport.clone();
        async move {
            let url = url.map_err(|error| PortcoveError::network(error.to_string()))?;
            // Only Core's explicit headers may authorize an API request.
            let mut request = reqwest::Request::new(reqwest::Method::GET, url);
            *request.headers_mut() = headers?;
            transport
                .execute(request)
                .await
                .map_err(github_request_error)
        }
    }

    async fn device_post(
        &self,
        endpoint: &str,
        fields: &[(&str, &str)],
    ) -> Result<reqwest::Response> {
        self.device_transport
            .post(format!("{}{endpoint}", self.web_root))
            .header(header::ACCEPT, "application/json")
            .form(fields)
            .send()
            .await
            .map_err(github_request_error)
    }

    fn active_token(&self) -> Option<String> {
        self.credential
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .token
            .clone()
    }

    #[cfg(test)]
    fn set_credential(&self, token: Option<String>, source: GithubAuthSource) {
        let mut credential = self
            .credential
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        credential.token = token;
        credential.source = source;
        credential.environment_variable = None;
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
        *credential = GithubCredential {
            intent,
            ..commit()?
        };
        Ok(())
    }

    /// A cached response saves a counted request only when it carries a validator.
    fn has_conditional_cache(&self, url: &str) -> bool {
        self.cached_http_response(url)
            .is_some_and(|entry| entry.etag.is_some() || entry.last_modified.is_some())
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

    async fn get_json<T: DeserializeOwned>(&self, url: &str) -> Result<T> {
        let cached = self.cached_http_response(url);
        let response = self
            .metadata_request(url, self.active_token().as_deref(), cached.as_ref())
            .await?;
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

    async fn scoped_json<T: DeserializeOwned>(
        &self,
        url: &str,
        scope: &crate::DefinitionAcquisitionScope,
    ) -> Result<T> {
        scope.require_current()?;
        let permitted_origin = self.api_root == "https://api.github.com";
        #[cfg(any(test, feature = "qualification-fixtures"))]
        let permitted_origin = if let Some(origin) = &scope.fixture_origin {
            crate::definition_acquisition::validate_fixture_origin(origin)?;
            origin == &self.api_root
        } else {
            permitted_origin
        };
        if !permitted_origin
            || !same_origin(url, &self.api_root)
            || self
                .library
                .as_ref()
                .is_some_and(|library| library.root() != scope.library.root())
        {
            return Err(PortcoveError::verification(
                "managed GitHub metadata origin or library does not match",
            ));
        }
        // Authenticated cache and ambient credentials are not authority for a new
        // managed grant. Revalidate public repository identity on the actual API.
        let response = self.metadata_request(url, None, None).await?;
        if !response.status().is_success() {
            return Err(github_http_error(response.status(), response.headers()));
        }
        let bytes =
            bounded_response_bytes(response, PROVIDER_JSON_MAX_BYTES, "scoped GitHub metadata")
                .await?;
        serde_json::from_slice(&bytes).map_err(|error| PortcoveError::network(error.to_string()))
    }

    async fn releases(&self, repository_url: &str) -> Result<Vec<GithubRelease>> {
        self.releases_scoped(repository_url, None).await
    }

    /// Reads the complete release history, bounded by the provider request budget
    /// rather than by a release count.
    async fn releases_scoped(
        &self,
        repository_url: &str,
        scope: Option<&crate::DefinitionAcquisitionScope>,
    ) -> Result<Vec<GithubRelease>> {
        let mut inventory = self.release_inventory(repository_url);
        self.extend_release_inventory_until(&mut inventory, scope, |_| false)
            .await?;
        Ok(inventory.releases)
    }

    fn release_inventory(&self, repository_url: &str) -> GithubReleaseInventory {
        GithubReleaseInventory {
            repository_url: repository_url.to_string(),
            releases: Vec::new(),
            next_page: Some(1),
            deadline: tokio::time::Instant::now() + self.network_bounds.request,
        }
    }

    /// Adds the next page of release history. Returns `false` when the history
    /// was already complete. Running out of the request budget is reported as an
    /// incomplete inventory, never as an absent release.
    async fn extend_release_inventory(
        &self,
        inventory: &mut GithubReleaseInventory,
        scope: Option<&crate::DefinitionAcquisitionScope>,
    ) -> Result<bool> {
        let Some(page) = inventory.next_page else {
            return Ok(false);
        };
        let incomplete = || {
            PortcoveError::network(
                "GitHub release history did not finish within the provider request budget. Try again.",
            )
            .detail("release_inventory", "incomplete")
            .detail("release_pages_read", (page - 1).to_string())
        };
        if tokio::time::Instant::now() >= inventory.deadline {
            return Err(incomplete());
        }
        let url = paginated_url(
            &inventory.repository_url,
            "releases",
            page,
            PROVIDER_PAGE_SIZE,
        )?;
        let read = async {
            match scope {
                Some(scope) => self.scoped_json::<Vec<GithubRelease>>(&url, scope).await,
                None => self.get_json::<Vec<GithubRelease>>(&url).await,
            }
        };
        let mut current = tokio::time::timeout_at(inventory.deadline, read)
            .await
            .map_err(|_| incomplete())??;
        if current.len() > PROVIDER_PAGE_SIZE {
            return Err(PortcoveError::verification(
                "GitHub returned more releases than the requested page size",
            ));
        }
        inventory.next_page = (current.len() == PROVIDER_PAGE_SIZE).then_some(page + 1);
        inventory.releases.append(&mut current);
        Ok(true)
    }

    /// Reads further pages until `done` holds for the observed prefix or the
    /// history is complete.
    async fn extend_release_inventory_until(
        &self,
        inventory: &mut GithubReleaseInventory,
        scope: Option<&crate::DefinitionAcquisitionScope>,
        mut done: impl FnMut(&[GithubRelease]) -> bool,
    ) -> Result<()> {
        while (inventory.next_page == Some(1) || !done(&inventory.releases))
            && self.extend_release_inventory(inventory, scope).await?
        {}
        Ok(())
    }

    /// Checks uploader continuity, reading older history while it could still
    /// establish the uploader, and completely before accepting that no release
    /// carries uploader facts.
    async fn continuing_uploader(
        &self,
        port: &PortDefinition,
        owner: Option<&uploader_continuity::GithubAccount>,
        inventory: &mut GithubReleaseInventory,
        scope: Option<&crate::DefinitionAcquisitionScope>,
        tag: &str,
        asset: &GithubAsset,
    ) -> Result<uploader_continuity::Continuity> {
        loop {
            match uploader_continuity::require(port, owner, &inventory.releases, tag, asset) {
                Err(_)
                    if inventory.next_page.is_some()
                        && uploader_continuity::history_can_establish(asset) =>
                {
                    self.extend_release_inventory(inventory, scope).await?;
                }
                // "Not observed" means no release carries uploader facts, which
                // only the complete history can establish.
                Ok(uploader_continuity::Continuity::NotObserved)
                    if inventory.next_page.is_some() =>
                {
                    self.extend_release_inventory(inventory, scope).await?;
                }
                result => return result,
            }
        }
    }

    #[cfg(test)]
    async fn cached_release(&self, key: &ReleaseSelectionCacheKey) -> Option<ResolvedRelease> {
        self.cached_selection(key).await.map(|value| value.release)
    }

    async fn cached_selection(&self, key: &ReleaseSelectionCacheKey) -> Option<ResolvedGithub> {
        let mut cache = self.cache.write().await;
        cache.retain(|_, entry| entry.stored_at.elapsed() < RELEASE_CACHE_TTL);
        cache.get(key).map(|entry| ResolvedGithub {
            release: entry.release.clone(),
            identity: entry.identity.clone(),
            explicit_tag_commit: None,
            activity: None,
            fallback_reason: entry.fallback_reason.clone(),
        })
    }

    #[cfg(test)]
    async fn store_release(&self, key: ReleaseSelectionCacheKey, release: ResolvedRelease) {
        self.store_selection(key, release, None, None).await;
    }

    async fn store_selection(
        &self,
        key: ReleaseSelectionCacheKey,
        release: ResolvedRelease,
        identity: Option<crate::definition_acquisition::GithubArtifactIdentity>,
        fallback_reason: Option<String>,
    ) {
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
                identity,
                fallback_reason,
            },
        );
    }

    /// Files a reviewed report as an issue on Portcove's own repository under the
    /// signed-in player's account. The token stays here: the caller passes only
    /// Core-built text, and only Core's headers authorize the request. Without a
    /// sign-in nothing is sent.
    pub fn submit_report(
        &self,
        issue: &crate::ReportIssue,
    ) -> impl std::future::Future<Output = Result<crate::SubmittedReport>> + Send + 'static + use<>
    {
        let url = format!(
            "{}/repos/{}/issues",
            self.api_root,
            crate::REPORT_REPOSITORY
        );
        let expected_prefix = format!("{}/{}/issues/", self.web_root, crate::REPORT_REPOSITORY);
        let token = self.active_token();
        let headers = self.metadata_headers(&url, token.as_deref(), None);
        let payload = serde_json::to_vec(issue);
        let transport = self.api_transport.clone();
        async move {
            if token.is_none() {
                return Err(PortcoveError::state(
                    "sign in to GitHub to submit a report from Portcove",
                ));
            }
            let url = reqwest::Url::parse(&url)
                .map_err(|error| PortcoveError::network(error.to_string()))?;
            let mut headers = headers?;
            headers.remove(header::CONTENT_LENGTH);
            headers.insert(
                header::CONTENT_TYPE,
                header::HeaderValue::from_static("application/json"),
            );
            headers.insert(
                header::ACCEPT,
                header::HeaderValue::from_static("application/vnd.github+json"),
            );
            let payload = payload.map_err(|error| PortcoveError::state(error.to_string()))?;
            let mut request = reqwest::Request::new(reqwest::Method::POST, url);
            *request.headers_mut() = headers;
            *request.body_mut() = Some(payload.into());
            let response = transport
                .execute(request)
                .await
                .map_err(github_request_error)?;
            let status = response.status();
            if status == StatusCode::FORBIDDEN || status == StatusCode::NOT_FOUND {
                // GitHub's secondary limit for creating content answers 403 with
                // retry-after but without an exhausted primary limit.
                let limited = rate_limit_from_headers(response.headers())
                    .is_some_and(|limit| limit.remaining == 0)
                    || response.headers().contains_key(header::RETRY_AFTER);
                if !limited {
                    return Err(PortcoveError::state(
                        "GitHub did not let this sign-in create the report. Open it on GitHub or copy the text instead.",
                    )
                    .detail("status", status.as_u16().to_string()));
                }
            }
            if !status.is_success() {
                return Err(github_http_error(status, response.headers()));
            }
            let created: GithubCreatedIssue =
                parse_bounded_json(response, "GitHub created issue").await?;
            if !created.html_url.starts_with(&expected_prefix) || created.number == 0 {
                return Err(PortcoveError::verification(
                    "GitHub returned an issue outside Portcove's repository",
                ));
            }
            Ok(crate::SubmittedReport {
                number: created.number,
                url: created.html_url,
            })
        }
    }

    pub fn auth_status(
        &self,
    ) -> impl std::future::Future<Output = Result<GithubAuthStatus>> + Send + 'static + use<> {
        let (source, environment_variable, token) = {
            let credential = self
                .credential
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            (
                credential.source,
                credential.environment_variable.map(str::to_owned),
                credential.token.clone(),
            )
        };
        let authenticated = token.is_some();
        let url = if authenticated {
            format!("{}/user", self.api_root)
        } else {
            format!("{}/rate_limit", self.api_root)
        };
        // Authentication observation needs no library/cache authority. Capture
        // only the request and response facts, so a pending network read cannot
        // retain the provider's library lease across a desktop handoff.
        let request = self.metadata_request(&url, token.as_deref(), None);
        async move {
            let response = request.await?;
            let status = response.status();
            let rate_limit = rate_limit_from_headers(response.headers());
            if status == StatusCode::UNAUTHORIZED && authenticated {
                return Ok(GithubAuthStatus {
                    source,
                    environment_variable,
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
                environment_variable,
                authenticated,
                login,
                rate_limit,
                device_login_available: github_client_id().is_some(),
            })
        }
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
            .with_known_cause(crate::failure::KnownFailureCause::DeviceLoginUnavailable)
        })?;
        let response = self
            .device_post("/login/device/code", &[("client_id", client_id.as_str())])
            .await?;
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
                return Err(expired_device_login());
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
        let response = self
            .device_post(
                "/login/oauth/access_token",
                &[
                    ("client_id", client_id.as_str()),
                    ("device_code", device_code.as_str()),
                    ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
                ],
            )
            .await?;
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
                Err(expired_device_login())
            }
            Some("access_denied") => {
                self.device_sessions.lock().await.remove(session_id);
                Err(PortcoveError::conflict("GitHub login was cancelled")
                    .with_known_cause(
                        crate::failure::KnownFailureCause::GithubDeviceAuthorizationDenied,
                    )
                    .with_mutation_state(crate::MutationState::NoChanges))
            }
            Some(error) => Err(PortcoveError::network(format!(
                "GitHub device login failed: {error}"
            ))),
        }
    }

    async fn validate_token(&self, token: &str) -> Result<()> {
        let url = format!("{}/user", self.api_root);
        let response = self.metadata_request(&url, Some(token), None).await?;
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
        self.checksum_from_sidecar_scoped(assets, target, None)
            .await
    }

    async fn checksum_from_sidecar_scoped(
        &self,
        assets: &[GithubAsset],
        target: &GithubAsset,
        scope: Option<&crate::DefinitionAcquisitionScope>,
    ) -> Result<Option<String>> {
        let (exact, sidecars) = checksum_sidecars(assets, target)?;
        let mut checksum = None;
        let client = match scope {
            Some(scope) => reqwest::Client::builder()
                .redirect(scope.redirect_policy())
                .user_agent(concat!("Portcove/", env!("CARGO_PKG_VERSION")))
                .connect_timeout(self.network_bounds.connect)
                .read_timeout(self.network_bounds.read_idle)
                .build()
                .map_err(|error| PortcoveError::network(error.to_string()))?,
            None => self.download_client.clone(),
        };
        for sidecar in sidecars {
            if let Some(scope) = scope {
                scope.require_current()?;
                scope.require_asset_url(&sidecar.browser_download_url)?;
            }
            let response = client
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

/// Pure authority selection shared by resolution and inert observation. Exact
/// per-asset sidecars take precedence; every applicable authority must agree.
fn checksum_sidecars<'a>(
    assets: &'a [GithubAsset],
    target: &GithubAsset,
) -> Result<(bool, Vec<&'a GithubAsset>)> {
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
    Ok((exact, sidecars))
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
    async fn review_exact(
        &self,
        port: &PortDefinition,
        channel: ReleaseChannel,
        platform: Platform,
        scope: Option<&crate::DefinitionAcquisitionScope>,
        version: &str,
    ) -> Result<ExactReleaseSelection> {
        let inferred = self.inferred_acquisition_scope(port, scope)?;
        let query = ExactReleaseQuery::Review(version);
        query.require_route(
            port,
            channel,
            platform,
            crate::ReleaseSource::Github,
            scope.or(inferred.as_ref()),
        )?;
        self.resolve_exact_bounded(port, channel, platform, query)
            .await
            .map(|(_, pin)| pin)
    }

    async fn resolve_exact(
        &self,
        port: &PortDefinition,
        channel: ReleaseChannel,
        platform: Platform,
        scope: Option<&crate::DefinitionAcquisitionScope>,
        pin: &ExactReleaseSelection,
    ) -> Result<crate::ScopedResolvedRelease> {
        self.resolve_scoped_selection(port, channel, platform, scope, GithubSelection::Exact(pin))
            .await
    }

    async fn resolve(
        &self,
        port: &PortDefinition,
        channel: ReleaseChannel,
        platform: Platform,
    ) -> Result<ResolvedRelease> {
        let scope = match &self.library {
            Some(library) => {
                let (catalog, _) = library.load_catalog()?;
                crate::definition_repository::publisher_policy::acquisition_scope(
                    library, &catalog, &port.id,
                )?
            }
            None => None,
        };
        #[cfg(feature = "qualification-fixtures")]
        let scope = self.bind_qualification_scope(scope.as_ref())?;
        self.resolve_with_scope(
            port,
            channel,
            platform,
            scope.as_ref(),
            GithubSelection::Ordinary,
        )
        .await
        .map(|selection| selection.release)
    }

    async fn resolve_scoped(
        &self,
        port: &PortDefinition,
        channel: ReleaseChannel,
        platform: Platform,
        scope: Option<&crate::DefinitionAcquisitionScope>,
    ) -> Result<crate::ScopedResolvedRelease> {
        self.resolve_scoped_selection(port, channel, platform, scope, GithubSelection::Ordinary)
            .await
    }

    async fn resolve_saved_variant(
        &self,
        port: &PortDefinition,
        channel: ReleaseChannel,
        platform: Platform,
        scope: Option<&crate::DefinitionAcquisitionScope>,
        variant: &ManagedPackageVariant,
    ) -> Result<crate::ScopedResolvedRelease> {
        variant.require_contract(port, channel, platform)?;
        self.resolve_scoped_selection(
            port,
            channel,
            platform,
            scope,
            GithubSelection::Saved(variant),
        )
        .await
    }

    async fn resolve_explicit_first_variant(
        &self,
        port: &PortDefinition,
        channel: ReleaseChannel,
        platform: Platform,
        variant: &ManagedPackageVariant,
    ) -> Result<crate::ScopedResolvedRelease> {
        variant.require_contract(port, channel, platform)?;
        if variant.explicit_id().is_none() {
            return Err(PortcoveError::verification(
                "explicit package choice identity is missing",
            ));
        }
        self.resolve_scoped_selection(
            port,
            channel,
            platform,
            None,
            GithubSelection::ExplicitFirst(variant),
        )
        .await
    }

    async fn resolve_shape_fallback(
        &self,
        port: &PortDefinition,
        platform: Platform,
        scope: Option<&crate::DefinitionAcquisitionScope>,
        withheld: &ResolvedRelease,
    ) -> Result<Option<crate::ScopedResolvedRelease>> {
        if port.release.curated.contains_key(&platform)
            || crate::package_shape::reviewed_release_digests(port, platform).is_empty()
        {
            return Ok(None);
        }
        match self
            .resolve_scoped_selection(
                port,
                withheld.channel,
                platform,
                scope,
                GithubSelection::ReviewedFallback(withheld),
            )
            .await
        {
            Ok(selection) => Ok(Some(selection)),
            Err(error) if error.code == crate::ErrorCode::NotFound => Ok(None),
            Err(error) => Err(error),
        }
    }

    async fn forecast_request_cost(
        &self,
        port: &PortDefinition,
        platform: Platform,
        scoped: bool,
    ) -> Result<crate::RequestCostForecast> {
        if port.release.provider != crate::ReleaseSource::Github {
            return Ok(crate::RequestCostForecast::default());
        }
        let repository_url = format!("{}/repos/{}", self.api_root, port.release.repository);
        let releases_url = paginated_url(&repository_url, "releases", 1, PROVIDER_PAGE_SIZE)?;
        Ok(github_cost_forecast(
            scoped,
            port.release.curated.contains_key(&platform),
            self.has_conditional_cache(&repository_url),
            self.has_conditional_cache(&releases_url),
        ))
    }

    fn forecast_saved_variant_request_cost(&self, scoped: bool) -> crate::RequestCostForecast {
        // Budget the full metadata path. Cached conditional responses can cost
        // less, and a stale inline list cannot predict which inventories we need.
        let counted_requests = (1
            + GITHUB_MAX_RELEASE_PAGES
            + GITHUB_SAVED_RELEASE_INVENTORY_LIMIT * GITHUB_FORECAST_ASSET_PAGES)
            as u32;
        crate::RequestCostForecast {
            counted_requests,
            sign_in_relief_requests: if scoped { 0 } else { counted_requests },
        }
    }

    fn forecast_explicit_variant_request_cost(&self) -> crate::RequestCostForecast {
        let inventory = self.forecast_saved_variant_request_cost(false);
        // The exact tag reference plus at most five annotated tag objects.
        let counted_requests = inventory.counted_requests.saturating_add(6);
        crate::RequestCostForecast {
            counted_requests,
            sign_in_relief_requests: counted_requests,
        }
    }

    fn cached_release_notes(
        &self,
        port: &PortDefinition,
        channel: ReleaseChannel,
        platform: Platform,
        installed: Option<&str>,
        offered: &str,
    ) -> Option<crate::UpdateReleaseNotes> {
        if port.release.provider != crate::ReleaseSource::Github {
            return None;
        }
        let repository = crate::release_notes::repository_segments(&port.release.repository);
        let releases_url = repository.and_then(|repository| {
            crate::release_notes::web_url(
                &self.web_root,
                &[repository.as_slice(), &["releases"][..]].concat(),
            )
        });
        let repository_url = format!("{}/repos/{}", self.api_root, port.release.repository);
        let releases: Vec<GithubRelease> = crate::release_notes::cached_pages(
            GITHUB_MAX_RELEASE_PAGES,
            PROVIDER_PAGE_SIZE,
            PROVIDER_JSON_MAX_BYTES,
            |page| {
                paginated_url(&repository_url, "releases", page, PROVIDER_PAGE_SIZE)
                    .ok()
                    .and_then(|url| self.cached_http_response(&url))
            },
        );
        let listed = releases
            .iter()
            .map(|release| crate::release_notes::ListedRelease {
                tag: &release.tag_name,
                title: release.name.as_deref(),
                published_at: release.published_at.as_deref(),
                notes: release.body.as_deref().unwrap_or_default(),
                // Same platform stream as release selection.
                selectable: !release.draft
                    && native_release_applies_to_platform(port, platform, release),
                beta: is_beta_release(release),
            })
            .collect::<Vec<_>>();
        Some(crate::release_notes::between(
            &listed,
            &crate::release_notes::NotesRequest {
                channel,
                rolling_tag: port.release.rolling_tag.as_deref(),
                installed,
                offered,
            },
            releases_url,
            crate::release_notes::ReleasePage::GithubTag,
        ))
    }
}

#[derive(Clone, Copy)]
enum GithubSelection<'a> {
    Ordinary,
    Exact(&'a ExactReleaseSelection),
    ReviewedFallback(&'a ResolvedRelease),
    Saved(&'a ManagedPackageVariant),
    ExplicitFirst(&'a ManagedPackageVariant),
}

/// Newest-first GitHub release history, read one page at a time only as far as
/// a decision needs. Stable and Rolling selection take the first match in
/// provider order, so a prefix containing one gives the full-history answer;
/// Beta's stable fallback needs the complete history (see
/// `decided_github_release_index`). Absence is concluded only once `next_page`
/// is `None`.
struct GithubReleaseInventory {
    repository_url: String,
    releases: Vec<GithubRelease>,
    next_page: Option<usize>,
    deadline: tokio::time::Instant,
}

struct SavedReleaseAssetRefresh {
    refreshed: std::collections::BTreeSet<u64>,
    deadline: tokio::time::Instant,
}

impl SavedReleaseAssetRefresh {
    fn needs(&self, release: &GithubRelease) -> bool {
        release.id.is_none_or(|id| !self.refreshed.contains(&id))
    }
}

impl<'a> GithubSelection<'a> {
    fn variant(self) -> Option<&'a ManagedPackageVariant> {
        match self {
            Self::Saved(variant) | Self::ExplicitFirst(variant) => Some(variant),
            _ => None,
        }
    }

    fn applies(self, port: &PortDefinition, platform: Platform, release: &GithubRelease) -> bool {
        match self {
            Self::ExplicitFirst(variant) => {
                github_tag_in_stream(port, platform, &release.tag_name)
                    && release
                        .assets
                        .iter()
                        .any(|asset| variant.names_explicit_family(&asset.name))
            }
            _ => native_release_applies_to_platform(port, platform, release),
        }
    }

    fn asset<'asset>(
        self,
        port: &PortDefinition,
        platform: Platform,
        release: &'asset GithubRelease,
    ) -> Result<&'asset GithubAsset> {
        match self {
            Self::Saved(variant) | Self::ExplicitFirst(variant) => choose_asset_for_variant(
                port,
                platform,
                &release.assets,
                Some((variant, &release.tag_name)),
            ),
            Self::Ordinary | Self::Exact(_) | Self::ReviewedFallback(_) => {
                choose_asset(port, platform, &release.assets)
            }
        }
    }
}

impl GithubReleaseProvider {
    async fn refresh_saved_release_assets(
        &self,
        port: &PortDefinition,
        channel: ReleaseChannel,
        platform: Platform,
        scope: Option<&crate::DefinitionAcquisitionScope>,
        inventory: &mut GithubReleaseInventory,
        refresh: &mut SavedReleaseAssetRefresh,
        selection: GithubSelection<'_>,
    ) -> Result<()> {
        // Inspect releases in normal channel order until a complete asset
        // inventory establishes the platform candidate. An inline list naming
        // another platform can omit a late upload for this one.
        loop {
            let mut release_ids = std::collections::BTreeSet::new();
            if inventory
                .releases
                .iter()
                .filter_map(|release| release.id)
                .any(|id| !release_ids.insert(id))
            {
                return Err(PortcoveError::verification(
                    "the saved package release inventory repeats a provider release identity",
                ));
            }
            let Some(index) = decided_github_release_index(
                &inventory.releases,
                inventory.next_page.is_none(),
                port,
                channel,
                platform,
                |release| {
                    !release.draft
                        && (refresh.needs(release) || selection.applies(port, platform, release))
                },
            ) else {
                // The candidate may be older than the history read so far.
                if self.extend_release_inventory(inventory, scope).await? {
                    continue;
                }
                break;
            };
            let release = &mut inventory.releases[index];
            if !refresh.needs(release) {
                break;
            }
            let refreshed_assets = self
                .saved_release_assets(&port.release.repository, release, scope, refresh)
                .await?;
            if let Some(variant) = selection
                .variant()
                .filter(|variant| variant.explicit_id().is_some())
                && release.assets.iter().any(|inline| {
                    variant.names_explicit_family(&inline.name)
                        && !refreshed_assets.iter().any(|asset| {
                            inline.id == asset.id
                                && inline.name == asset.name
                                && inline.size == asset.size
                                && inline.browser_download_url == asset.browser_download_url
                                && (inline.digest.is_none() || inline.digest == asset.digest)
                        })
                })
            {
                return Err(PortcoveError::verification(
                    "the selected family changed between the release header and its complete asset inventory",
                )
                .detail("saved_package_variant", "inconsistent-inventory"));
            }
            release.assets = refreshed_assets;
        }
        Ok(())
    }

    async fn saved_release_assets(
        &self,
        repository: &str,
        release: &GithubRelease,
        scope: Option<&crate::DefinitionAcquisitionScope>,
        refresh: &mut SavedReleaseAssetRefresh,
    ) -> Result<Vec<GithubAsset>> {
        if refresh.refreshed.len() >= GITHUB_SAVED_RELEASE_INVENTORY_LIMIT {
            return Err(PortcoveError::verification(
                "the saved package check exceeds the supported release inventory limit",
            )
            .detail("saved_package_variant", "release-inventory-limit"));
        }
        let release_id = fresh_release_id(release)?;
        let assets = tokio::time::timeout_at(
            refresh.deadline,
            self.release_assets_scoped(repository, release_id, scope),
        )
        .await
        .map_err(|_| {
            PortcoveError::network(
                "saved package asset inventory did not complete within the provider request budget",
            )
        })??;
        let mut ids = std::collections::BTreeSet::new();
        if assets
            .iter()
            .any(|asset| !asset.id.is_some_and(|id| id != 0 && ids.insert(id)))
        {
            return Err(PortcoveError::verification(
                "the complete saved package inventory contains missing or repeated asset identities",
            ));
        }
        refresh.refreshed.insert(release_id);
        Ok(assets)
    }

    fn inferred_acquisition_scope(
        &self,
        port: &PortDefinition,
        scope: Option<&crate::DefinitionAcquisitionScope>,
    ) -> Result<Option<crate::DefinitionAcquisitionScope>> {
        if let (None, Some(library)) = (scope, &self.library) {
            let (catalog, _) = library.load_catalog()?;
            return crate::definition_repository::publisher_policy::acquisition_scope(
                library, &catalog, &port.id,
            );
        }
        Ok(None)
    }

    async fn resolve_exact_bounded(
        &self,
        port: &PortDefinition,
        channel: ReleaseChannel,
        platform: Platform,
        query: ExactReleaseQuery<'_>,
    ) -> Result<(ResolvedGithub, ExactReleaseSelection)> {
        tokio::time::timeout(
            self.network_bounds.request,
            self.resolve_exact_observed(port, channel, platform, query),
        )
        .await
        .map_err(|_| {
            PortcoveError::network("the exact GitHub release exceeded the provider request budget")
        })?
    }

    async fn resolve_scoped_selection(
        &self,
        port: &PortDefinition,
        channel: ReleaseChannel,
        platform: Platform,
        scope: Option<&crate::DefinitionAcquisitionScope>,
        selection: GithubSelection<'_>,
    ) -> Result<crate::ScopedResolvedRelease> {
        let inferred = self.inferred_acquisition_scope(port, scope)?;
        let scope = scope.or(inferred.as_ref());
        #[cfg(feature = "qualification-fixtures")]
        let bound_scope = self.bind_qualification_scope(scope)?;
        #[cfg(feature = "qualification-fixtures")]
        let scope = bound_scope.as_ref();
        let selected = self
            .resolve_with_scope(port, channel, platform, scope, selection)
            .await?;
        let mut resolved = match scope {
            Some(scope) => crate::ScopedResolvedRelease::managed(selected.release, scope.clone()),
            None => Ok(crate::ScopedResolvedRelease::legacy(selected.release)),
        }?
        .for_selection(port, platform, channel)?;
        resolved.github_identity = selected.identity;
        resolved.explicit_tag_commit = selected.explicit_tag_commit;
        resolved.upstream_activity = selected.activity;
        resolved.fallback_reason = selected.fallback_reason;
        if let Some(variant) = selection.variant() {
            resolved.saved_variant = Some(variant.clone());
        }
        Ok(resolved)
    }

    async fn resolve_with_scope(
        &self,
        port: &PortDefinition,
        channel: ReleaseChannel,
        platform: Platform,
        scope: Option<&crate::DefinitionAcquisitionScope>,
        selection: GithubSelection<'_>,
    ) -> Result<ResolvedGithub> {
        if let GithubSelection::Exact(pin) = selection {
            pin.require_context(port, channel, platform, scope)?;
            return self
                .resolve_exact_bounded(port, channel, platform, ExactReleaseQuery::Saved(pin))
                .await
                .map(|(release, _)| release);
        }
        if selection
            .variant()
            .is_some_and(|variant| variant.explicit_id().is_some())
            && (scope.is_some()
                || !crate::acquisition_restriction::definition_restrictions(port).is_empty())
        {
            return Err(PortcoveError::unsupported(
                "the active acquisition policy does not authorize explicit package selection",
            ));
        }
        crate::curated_acquisition::require_runtime_scope(port, scope)?;
        if let Some(scope) = scope {
            scope.require_current()?;
            scope.require_port(port)?;
        }
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
        if let Some(record) = port.release.curated.get(&platform)
            && let Some(scope) = scope
        {
            crate::definition_repository::publisher_policy::require_curated_artifact_operation(
                &scope.library.connection()?, scope.repository_id, record,
                crate::definition_repository::publisher_policy::CuratedArtifactOperation::Acquisition,
            )?;
        }
        // Repository facts read before a later failure stay fresh for a fallback;
        // they remain unknown only when the repository document itself was unread.
        let mut observed_activity = None;
        match self
            .resolve_observed(
                port,
                channel,
                platform,
                scope,
                selection,
                &mut observed_activity,
            )
            .await
        {
            Ok(resolved) => Ok(resolved),
            Err(error) => match (port.release.curated.get(&platform), scope) {
                (Some(record), Some(scope))
                    if !record.preserved_locations.is_empty()
                        && error.upstream_failure()
                            == crate::failure::UpstreamFailure::Unavailable =>
                {
                    preserved_resolution(port, channel, record, scope).map(|mut resolved| {
                        resolved.activity = observed_activity;
                        resolved
                    })
                }
                _ => Err(error),
            },
        }
    }

    async fn observed_asset_digest(
        &self,
        port: &PortDefinition,
        release: &GithubRelease,
        asset: &GithubAsset,
        scope: Option<&crate::DefinitionAcquisitionScope>,
    ) -> Result<String> {
        if let Some(scope) = scope {
            scope.require_current()?;
            scope.require_asset_url(&asset.browser_download_url)?;
        }
        if let Some(digest) = asset.digest.as_deref().and_then(parse_digest) {
            return Ok(digest);
        }
        let digest = match scope {
            Some(scope) => {
                self.checksum_from_sidecar_scoped(&release.assets, asset, Some(scope))
                    .await?
            }
            None => self.checksum_from_sidecar(&release.assets, asset).await?,
        };
        digest.ok_or_else(|| {
            PortcoveError::verification(format!(
                "{} does not publish a SHA-256 digest for {}",
                port.name, asset.name
            ))
        })
    }

    /// Fresh upstream observation. Every guard above has already passed.
    async fn resolve_observed(
        &self,
        port: &PortDefinition,
        channel: ReleaseChannel,
        platform: Platform,
        scope: Option<&crate::DefinitionAcquisitionScope>,
        selection: GithubSelection<'_>,
        observed_activity: &mut Option<crate::UpstreamActivity>,
    ) -> Result<ResolvedGithub> {
        let repository_url = format!("{}/repos/{}", self.api_root, port.release.repository);
        let repository: GithubRepository = match scope {
            Some(scope) => self.scoped_json(&repository_url, scope).await?,
            None => self.get_json(&repository_url).await?,
        };
        if let Some(scope) = scope
            && repository.id != Some(scope.repository_id)
        {
            return Err(PortcoveError::verification(
                "GitHub repository stable identity differs from its publisher grant",
            ));
        }
        if let Some(variant) = selection.variant()
            && repository.id != Some(variant.repository_id())
        {
            return Err(PortcoveError::verification(
                "upstream repository identity differs from the saved package choice",
            ));
        }
        // Keep metadata validation before cached selection. Archive state and the
        // latest push are maintenance facts reported to the player; they neither
        // revoke exact release authority nor replace the integrity checks below.
        let activity = Some(repository.activity(&port.release.repository));
        observed_activity.clone_from(&activity);
        let mut cache_key = ReleaseSelectionCacheKey::new(port, channel, platform);
        let withheld = match selection {
            GithubSelection::ReviewedFallback(withheld) => Some(withheld),
            _ => None,
        };
        cache_key.scope_binding = scope.map(|scope| {
            format!(
                "{}:{}:{}",
                scope.anchor_sha256, scope.policy_sha256, scope.port_sha256
            )
        });
        let curated = port.release.curated.get(&platform);
        // Curated and saved selections revalidate mutable provider facts. A
        // previous match cannot prove that its release inventory is unique now.
        let cache_selection = curated.is_none() && matches!(selection, GithubSelection::Ordinary);
        if cache_selection && let Some(mut selection) = self.cached_selection(&cache_key).await {
            if selection
                .identity
                .as_ref()
                .is_some_and(|identity| Some(identity.repository_id) != repository.id)
            {
                return Err(PortcoveError::verification(
                    "GitHub repository identity changed since cached selection",
                ));
            }
            if let Some(scope) = scope {
                scope.require_current()?;
                scope.require_asset_url(&selection.release.asset.url)?;
            }
            selection.activity = activity;
            return Ok(selection);
        }
        let mut inventory = self.release_inventory(&repository_url);
        self.extend_release_inventory(&mut inventory, scope).await?;
        let mut saved_refresh = selection
            .variant()
            .is_some()
            .then(|| SavedReleaseAssetRefresh {
                refreshed: std::collections::BTreeSet::new(),
                deadline: tokio::time::Instant::now() + self.network_bounds.request,
            });
        if let Some(refresh) = &mut saved_refresh {
            self.refresh_saved_release_assets(
                port,
                channel,
                platform,
                scope,
                &mut inventory,
                refresh,
                selection,
            )
            .await?;
        }
        if let Some(record) = curated.filter(|record| !record.preserved_locations.is_empty()) {
            // Failover-capable records only: classify an accepted release or asset
            // that is gone as unavailable. Any partial match (a moved tag, a reused
            // name, a changed ID) falls through to the identity refusal below.
            // Read history until both identities are observed or it is complete.
            self.extend_release_inventory_until(&mut inventory, scope, |releases| {
                releases
                    .iter()
                    .any(|release| release.id == Some(record.release_id))
                    && releases
                        .iter()
                        .any(|release| release.tag_name == record.tag)
            })
            .await?;
            let releases = &inventory.releases;
            let by_id = releases
                .iter()
                .find(|release| release.id == Some(record.release_id));
            let by_tag = releases
                .iter()
                .find(|release| release.tag_name == record.tag);
            let gone = match (by_id, by_tag) {
                (None, None) => true,
                (Some(by_id), Some(by_tag))
                    if by_id.id == by_tag.id && by_id.tag_name == by_tag.tag_name =>
                {
                    !by_id.assets.iter().any(|asset| {
                        asset.id == Some(record.asset_id) || asset.name == record.filename
                    })
                }
                _ => false,
            };
            if gone {
                return Err(PortcoveError::network(
                    "the accepted curated release or asset is no longer published",
                )
                .with_upstream(Some(crate::failure::UpstreamObservation::Status(404))));
            }
        }
        let applies =
            |release: &GithubRelease| !release.draft && selection.applies(port, platform, release);
        while decided_github_release_index(
            &inventory.releases,
            inventory.next_page.is_none(),
            port,
            channel,
            platform,
            applies,
        )
        .is_none()
            && self.extend_release_inventory(&mut inventory, scope).await?
        {}
        let latest_index =
            select_github_release_index(&inventory.releases, port, channel, platform, applies)
                .ok_or_else(|| {
                    PortcoveError::not_found(format!(
                        "no published {channel} release exists for {}",
                        port.name
                    ))
                })?;
        let latest = &inventory.releases[latest_index].clone();
        let mut observed_digest = None;
        let mut fallback_reason = None;
        // The continuity decision for the asset finally selected, kept with the build.
        let mut continuity = None;
        let owner = repository.owner.as_ref();
        let restrictions = EffectiveRestrictions::managed_only(port);
        let mut exclusion_reason = None;
        let reviewed = if let Some(withheld) = withheld {
            let latest_asset = selection.asset(port, platform, latest)?;
            if latest.tag_name != withheld.version
                || latest_asset.name != withheld.asset.name
                || latest_asset.size != withheld.asset.size
                || latest_asset.browser_download_url != withheld.asset.url
                || !self
                    .observed_asset_digest(port, latest, latest_asset, scope)
                    .await?
                    .eq_ignore_ascii_case(&withheld.asset.sha256)
            {
                return Err(PortcoveError::conflict(
                    "the release waiting for review changed; resolve the current release again",
                ));
            }
            fallback_reason = Some(format!(
                "Version {} is waiting for package review. The reviewed version is available.",
                withheld.version
            ));
            Some(crate::package_shape::reviewed_release_digests(
                port, platform,
            ))
        } else if curated.is_none() && restrictions.has_artifact_holds(RestrictedOperation::Install)
        {
            let latest_asset = selection.asset(port, platform, latest)?;
            let latest_continuity = self
                .continuing_uploader(
                    port,
                    owner,
                    &mut inventory,
                    scope,
                    &latest.tag_name,
                    latest_asset,
                )
                .await?
                .record(latest_asset);
            let digest = self
                .observed_asset_digest(port, latest, latest_asset, scope)
                .await?;
            if let Some(excluded) = restrictions.artifact_exclusion(
                RestrictedOperation::Install,
                &latest.tag_name,
                &digest,
            ) {
                fallback_reason = excluded.explanation();
                exclusion_reason.clone_from(&fallback_reason);
                Some(
                    restrictions
                        .permitted_artifacts(
                            RestrictedOperation::Install,
                            Knowledge::Known(platform),
                        )
                        .map(|artifact| (artifact.version.as_str(), artifact.sha256.as_str()))
                        .collect::<Vec<_>>(),
                )
            } else {
                observed_digest = Some(digest);
                continuity = Some(latest_continuity);
                None
            }
        } else {
            None
        };
        let release_index = if let Some(reviewed) = reviewed {
            let latest_tag = latest.tag_name.clone();
            let mut checked = Vec::<usize>::new();
            loop {
                // A saved choice needs complete evidence only for the next
                // reviewed fallback in channel order after the latest digest
                // has actually triggered the hold.
                let releases = &inventory.releases;
                let found = decided_github_release_index(
                    releases,
                    inventory.next_page.is_none(),
                    port,
                    channel,
                    platform,
                    |candidate| {
                        candidate.tag_name != latest_tag
                            && !candidate.draft
                            && !checked
                                .iter()
                                .any(|previous| std::ptr::eq(&releases[*previous], candidate))
                            && reviewed
                                .iter()
                                .any(|(version, _)| *version == candidate.tag_name)
                            && (saved_refresh
                                .as_ref()
                                .is_some_and(|refresh| refresh.needs(candidate))
                                || applies(candidate))
                    },
                );
                let Some(index) = found else {
                    // A reviewed fallback may be older than the history read so far.
                    if self.extend_release_inventory(&mut inventory, scope).await? {
                        continue;
                    }
                    return Err(match (withheld, &exclusion_reason) {
                        (None, Some(reason)) => PortcoveError::unsupported(reason.clone()),
                        _ => PortcoveError::not_found("no reviewed fallback release is available"),
                    });
                };
                checked.push(index);
                let fallback = &mut inventory.releases[index];
                if let Some(refresh) = &mut saved_refresh
                    && refresh.needs(fallback)
                {
                    fallback.assets = self
                        .saved_release_assets(&port.release.repository, fallback, scope, refresh)
                        .await?;
                }
                let fallback = &inventory.releases[index].clone();
                if !applies(fallback) {
                    continue;
                }
                let Ok(asset) = selection.asset(port, platform, fallback) else {
                    continue;
                };
                let fallback_continuity = self
                    .continuing_uploader(
                        port,
                        owner,
                        &mut inventory,
                        scope,
                        &fallback.tag_name,
                        asset,
                    )
                    .await?
                    .record(asset);
                let digest = self
                    .observed_asset_digest(port, fallback, asset, scope)
                    .await?;
                if restrictions
                    .artifact_exclusion(RestrictedOperation::Install, &fallback.tag_name, &digest)
                    .is_none()
                    && reviewed.iter().any(|(version, expected)| {
                        *version == fallback.tag_name && expected.eq_ignore_ascii_case(&digest)
                    })
                {
                    observed_digest = Some(digest);
                    continuity = Some(fallback_continuity);
                    break index;
                }
            }
        } else {
            latest_index
        };
        let release = &inventory.releases[release_index].clone();
        let asset = selection.asset(port, platform, release)?;
        if let Some(scope) = scope {
            scope.require_current()?;
            scope.require_asset_url(&asset.browser_download_url)?;
        }
        // An exact curated record already binds reviewed release and asset IDs;
        // every other selection follows upstream and must continue its uploaders.
        // Refuse before any checksum request or caching.
        if curated.is_none() && observed_digest.is_none() {
            continuity = Some(
                self.continuing_uploader(
                    port,
                    owner,
                    &mut inventory,
                    scope,
                    &release.tag_name,
                    asset,
                )
                .await?
                .record(asset),
            );
        }
        let explicit_tag_commit = match selection.variant() {
            Some(variant) if variant.explicit_id().is_some() => {
                let refresh = saved_refresh
                    .as_ref()
                    .expect("saved selection has a deadline");
                let commit = tokio::time::timeout_at(
                    refresh.deadline,
                    self.github_tag_commit(port, &release.tag_name, None),
                )
                .await
                .map_err(|_| {
                    PortcoveError::network(
                        "the package tag proof exceeded the provider request budget",
                    )
                })??;
                variant.require_tag_commit(&release.tag_name, &asset.name, &commit)?;
                let expected_url = format!(
                    "{}/{}/releases/download/{}/{}",
                    self.web_root, port.release.repository, release.tag_name, asset.name,
                );
                if asset.browser_download_url != expected_url
                    && asset.browser_download_url != expected_url.replace('+', "%2B")
                {
                    return Err(PortcoveError::verification(
                        "the selected package URL differs from its exact provider path",
                    ));
                }
                Some(commit)
            }
            _ => None,
        };
        let sha256 = if explicit_tag_commit.is_some() {
            asset
                .digest
                .as_deref()
                .and_then(parse_digest)
                .ok_or_else(|| {
                    PortcoveError::verification(
                        "the selected package requires its published SHA-256 digest",
                    )
                })?
        } else if let Some(record) = curated {
            let scope = scope.ok_or_else(|| PortcoveError::unsupported("curated scope missing"))?;
            if release.id != Some(record.release_id)
                || release.tag_name != record.tag
                || asset.id != Some(record.asset_id)
            {
                return Err(PortcoveError::verification(
                    "curated release or asset identity changed",
                ));
            }
            let commit = self.curated_tag_commit(port, record, scope).await?;
            let publisher_digest = asset.digest.as_deref().and_then(parse_digest);
            if asset.digest.is_some() && publisher_digest.is_none() {
                return Err(PortcoveError::verification(
                    "curated publisher digest is malformed",
                ));
            }
            let observed_url = asset.browser_download_url.clone();
            #[cfg(any(test, feature = "qualification-fixtures"))]
            let observed_url = if let Some(origin) = &scope.fixture_origin {
                let actual = reqwest::Url::parse(&observed_url)
                    .map_err(|_| PortcoveError::verification("invalid fixture asset URL"))?;
                let expected = reqwest::Url::parse(&record.acquisition_url)
                    .map_err(|_| PortcoveError::verification("invalid curated asset URL"))?;
                if actual.origin().ascii_serialization() != *origin
                    || actual.path() != expected.path()
                    || actual.query().is_some()
                    || actual.fragment().is_some()
                {
                    return Err(PortcoveError::verification(
                        "curated fixture location differs",
                    ));
                }
                expected.to_string()
            } else {
                observed_url
            };
            record.verify_metadata(crate::curated_acquisition::CuratedReleaseMetadata {
                release_id: release.id,
                asset_id: asset.id,
                tag: &release.tag_name,
                commit_sha1: &commit,
                filename: &asset.name,
                url: &observed_url,
                size: asset.size,
                publisher_sha256: publisher_digest.as_deref(),
            })?
        } else if let Some(digest) = observed_digest {
            digest
        } else {
            self.observed_asset_digest(port, release, asset, scope)
                .await?
        };
        let version = release_version(&release.tag_name);
        if let Some(excluded) = EffectiveRestrictions::managed_only(port).artifact_exclusion(
            RestrictedOperation::Install,
            &version,
            &sha256,
        ) {
            excluded.into_result()?;
        }
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
            uploader_continuity: continuity,
        };
        let identity = match (repository.id, release.id, asset.id) {
            (Some(repository_id), Some(release_id), Some(asset_id)) => {
                let identity = crate::definition_acquisition::GithubArtifactIdentity {
                    repository: port.release.repository.clone(),
                    repository_id,
                    release_id,
                    asset_id,
                    tag: release.tag_name.clone(),
                };
                identity.validate()?;
                Some(identity)
            }
            _ if port.archive_data_compatibility_v1.is_some() || selection.variant().is_some() => {
                return Err(PortcoveError::verification(
                    "GitHub release observation is missing exact repository, release or asset identity",
                ));
            }
            _ => None,
        };
        if cache_selection {
            self.store_selection(
                cache_key,
                resolved.clone(),
                identity.clone(),
                fallback_reason.clone(),
            )
            .await;
        }
        Ok(ResolvedGithub {
            release: resolved,
            identity,
            explicit_tag_commit,
            activity,
            fallback_reason,
        })
    }
}

/// Selects an accepted curated artifact from the authenticated, fresh policy
/// record alone after upstream was classified unavailable (#1306). No network
/// request is made; bytes are still verified against the accepted size and
/// SHA-256, trying upstream first and then each preserved location.
fn preserved_resolution(
    port: &PortDefinition,
    channel: ReleaseChannel,
    record: &crate::curated_acquisition::CuratedAcquisitionRecord,
    scope: &crate::DefinitionAcquisitionScope,
) -> Result<ResolvedGithub> {
    if let Some(excluded) = EffectiveRestrictions::managed_only(port).artifact_exclusion(
        RestrictedOperation::Install,
        &record.tag,
        &record.sha256,
    ) {
        excluded.into_result()?;
    }
    scope.require_current()?;
    scope.require_port(port)?;
    crate::definition_repository::publisher_policy::require_curated_artifact_operation(
        &scope.library.connection()?,
        scope.repository_id,
        record,
        crate::definition_repository::publisher_policy::CuratedArtifactOperation::Acquisition,
    )?;
    for location in &record.preserved_locations {
        scope.require_asset_url(&crate::curated_acquisition::transport_url(scope, location)?)?;
    }
    let identity = crate::definition_acquisition::GithubArtifactIdentity {
        repository: port.release.repository.clone(),
        repository_id: scope.repository_id,
        release_id: record.release_id,
        asset_id: record.asset_id,
        tag: record.tag.clone(),
    };
    identity.validate()?;
    Ok(ResolvedGithub {
        release: ResolvedRelease {
            version: release_version(&record.tag),
            channel,
            published_at: None,
            asset: ReleaseAsset {
                name: record.filename.clone(),
                url: crate::curated_acquisition::transport_url(scope, &record.acquisition_url)?,
                size: record.size,
                sha256: record.sha256.clone(),
            },
            uploader_continuity: None,
        },
        identity: Some(identity),
        explicit_tag_commit: None,
        activity: None,
        fallback_reason: None,
    })
}

fn fresh_release_id(release: &GithubRelease) -> Result<u64> {
    release.id.filter(|id| *id != 0).ok_or_else(|| {
        PortcoveError::verification(
            "the current release has no stable provider identity for saved package resolution",
        )
    })
}

fn tag_in_stream(tag: &str, other_stream_prefixes: &[String]) -> bool {
    !other_stream_prefixes
        .iter()
        .any(|prefix| tag.starts_with(prefix))
}

fn github_tag_in_stream(port: &PortDefinition, platform: Platform, tag: &str) -> bool {
    tag_in_stream(tag, port.release.github_stream_exclusions(platform))
}

fn native_release_applies_to_platform(
    port: &PortDefinition,
    platform: Platform,
    release: &GithubRelease,
) -> bool {
    if !github_tag_in_stream(port, platform, &release.tag_name) {
        return false;
    }
    if (port.adapter != AdapterKind::NativePortable && port.archive_data_compatibility_v1.is_none())
        || port.release.curated.contains_key(&platform)
    {
        return true;
    }
    let mut other_platform_player = false;
    for asset in &release.assets {
        let name = asset.name.to_ascii_lowercase();
        let can_extract = [".zip", ".tar.gz", ".tgz"]
            .iter()
            .any(|ext| name.ends_with(ext));
        let (suitability, _, _) = crate::service::package_selection::assess_package_name(
            &name,
            can_extract,
            platform,
            &[],
        );
        if suitability == "auxiliary" {
            if name
                .split(|character: char| !character.is_ascii_alphanumeric())
                .any(|token| token == "debug")
            {
                return true;
            }
            continue;
        }
        if crate::service::package_selection::package_platform_match(&name, platform)
            != crate::service::package_selection::PackagePlatformMatch::Other
        {
            return true;
        }
        other_platform_player |= crate::service::package_selection::is_package_filename(&name);
    }
    // Only explicit other-OS players are outside this platform's release stream.
    // Same/unknown OS and source-only releases retain normal refusal semantics.
    !other_platform_player
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

/// The channel candidate when the observed newest-first prefix already decides
/// it. Stable and Rolling take the first match, which no older page can change.
/// Beta prefers any prerelease and falls back to a stable one only when none
/// exists, so a stable fallback is decided only by the complete history.
fn decided_github_release_index(
    releases: &[GithubRelease],
    complete: bool,
    port: &PortDefinition,
    channel: ReleaseChannel,
    platform: Platform,
    selectable: impl Fn(&GithubRelease) -> bool,
) -> Option<usize> {
    let index = select_github_release_index(releases, port, channel, platform, selectable)?;
    (complete || channel != ReleaseChannel::Beta || is_beta_release(&releases[index]))
        .then_some(index)
}

fn select_github_release_index(
    releases: &[GithubRelease],
    port: &PortDefinition,
    channel: ReleaseChannel,
    platform: Platform,
    selectable: impl Fn(&GithubRelease) -> bool,
) -> Option<usize> {
    let candidate = select_channel_candidate(
        releases,
        channel,
        port.release.rolling_tag.as_deref(),
        // Release headers are enough to exclude a reviewed foreign stream.
        // Only in-stream candidates can request or consume asset inventories.
        |release| github_tag_in_stream(port, platform, &release.tag_name) && selectable(release),
        is_beta_release,
        |release| release.tag_name.as_str(),
    )?;
    releases
        .iter()
        .position(|release| std::ptr::eq(release, candidate))
}

fn release_version(tag: &str) -> String {
    tag.to_string()
}

/// A publisher digest of a release the managed restrictions permit for
/// installation and do not exclude.
fn reviewed_fallback_digest(
    restrictions: &EffectiveRestrictions,
    release: &GithubRelease,
    asset: &GithubAsset,
) -> Option<String> {
    asset
        .digest
        .as_deref()
        .and_then(parse_digest)
        .filter(|digest| {
            restrictions
                .artifact_exclusion(RestrictedOperation::Install, &release.tag_name, digest)
                .is_none()
                && restrictions
                    .permitted_artifacts(RestrictedOperation::Install, Knowledge::Deferred)
                    .chain(
                        restrictions.permitted_artifacts(
                            RestrictedOperation::Activate,
                            Knowledge::Deferred,
                        ),
                    )
                    .any(|artifact| {
                        artifact.version == release.tag_name
                            && artifact.sha256.eq_ignore_ascii_case(digest)
                    })
        })
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
    if let Some((name, token)) = environment_token() {
        return GithubCredential {
            token: Some(token),
            source: GithubAuthSource::Environment,
            environment_variable: Some(name),
            intent: 0,
        };
    }
    match load_stored_token() {
        Ok(Some(token)) => GithubCredential {
            token: Some(token),
            source: GithubAuthSource::CredentialStore,
            environment_variable: None,
            intent: 0,
        },
        Ok(None) | Err(_) => GithubCredential {
            token: None,
            source: GithubAuthSource::Anonymous,
            environment_variable: None,
            intent: 0,
        },
    }
}

fn obsolete_auth_intent() -> PortcoveError {
    PortcoveError::conflict(
        "GitHub sign-in result is obsolete because a newer login or logout was started",
    )
}

fn expired_device_login() -> PortcoveError {
    PortcoveError::network("GitHub device-login session expired")
        .with_known_cause(crate::failure::KnownFailureCause::GithubDeviceCodeExpired)
        .with_mutation_state(crate::MutationState::NoChanges)
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

fn github_request_error(error: reqwest::Error) -> PortcoveError {
    #[cfg(test)]
    observe_test_response(ResponseTestEvent::Failed(
        ResponseTestPhase::Headers,
        error.is_timeout(),
    ));
    let observation = crate::failure::UpstreamObservation::from_reqwest(&error);
    PortcoveError::network(error.to_string()).with_upstream(observation)
}

fn github_http_error(status: StatusCode, headers: &header::HeaderMap) -> PortcoveError {
    let message = if status == StatusCode::UNAUTHORIZED {
        "GitHub rejected the sign-in (401). Sign in again, replace the configured token, or log out to use GitHub anonymously.".to_owned()
    } else {
        format!("GitHub API returned {status}")
    };
    let limit = rate_limit_from_headers(headers);
    let mut error = PortcoveError::network(message).with_known_cause(
        crate::failure::KnownFailureCause::ProviderRequest {
            provider: crate::failure::FailureProvider::Github,
            status: status.as_u16(),
            rate_limited: status == StatusCode::TOO_MANY_REQUESTS
                || (status == StatusCode::FORBIDDEN
                    && limit.as_ref().is_some_and(|limit| limit.remaining == 0)),
            resets_at: limit
                .as_ref()
                .and_then(|limit| i64::try_from(limit.resets_at).ok()),
        },
    );
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
struct GithubCreatedIssue {
    number: u64,
    html_url: String,
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
    #[serde(default)]
    id: Option<u64>,
    archived: bool,
    #[serde(default)]
    owner: Option<uploader_continuity::GithubAccount>,
    /// Kept untyped so an unexpected value is an unknown fact, not a failed check.
    #[serde(default)]
    pushed_at: Option<serde_json::Value>,
}

impl GithubRepository {
    fn activity(&self, repository: &str) -> crate::UpstreamActivity {
        crate::UpstreamActivity {
            repository: repository.to_owned(),
            observed_at: Library::now(),
            archived: self.archived,
            last_change_at: self
                .pushed_at
                .as_ref()
                .and_then(serde_json::Value::as_str)
                .and_then(|value| {
                    time::OffsetDateTime::parse(
                        value,
                        &time::format_description::well_known::Rfc3339,
                    )
                    .ok()
                })
                .map(time::OffsetDateTime::unix_timestamp),
        }
    }
}

#[derive(Debug, Deserialize)]
struct GithubTagObject {
    #[serde(rename = "type")]
    kind: String,
    sha: String,
}

#[derive(Debug, Deserialize)]
struct GithubTagReference {
    #[serde(rename = "ref")]
    reference: String,
    object: GithubTagObject,
}

#[derive(Debug, Deserialize)]
struct GithubAnnotatedTag {
    sha: String,
    object: GithubTagObject,
}

#[derive(Debug, Clone, Deserialize)]
struct GithubRelease {
    #[serde(default)]
    id: Option<u64>,
    tag_name: String,
    /// Informational only: shown as untrusted plain text in update reviews.
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    body: Option<String>,
    draft: bool,
    prerelease: bool,
    published_at: Option<String>,
    assets: Vec<GithubAsset>,
}

#[derive(Debug, Clone, Deserialize)]
struct GithubAsset {
    #[serde(default)]
    id: Option<u64>,
    name: String,
    browser_download_url: String,
    size: u64,
    digest: Option<String>,
    /// Who uploaded the asset and when; retained for uploader continuity.
    #[serde(default)]
    uploader: uploader_continuity::AssetUploader,
    #[serde(default)]
    created_at: Option<String>,
}

pub(crate) enum NativeAppImage<'a> {
    Exact(&'a str),
    Versioned {
        prefix: &'a str,
        suffix: &'a str,
        allow_two_part: bool,
    },
}

impl NativeAppImage<'_> {
    pub(crate) fn matches(&self, name: &str) -> bool {
        match self {
            Self::Exact(expected) => name.eq_ignore_ascii_case(expected),
            Self::Versioned {
                prefix,
                suffix,
                allow_two_part,
            } => versioned_asset_name_matches(name, prefix, suffix, *allow_two_part),
        }
    }
}

pub(crate) fn versioned_asset_name_matches(
    name: &str,
    prefix: &str,
    suffix: &str,
    allow_two_part: bool,
) -> bool {
    let name = name.to_ascii_lowercase();
    let Some(version) = name
        .strip_prefix(prefix)
        .and_then(|name| name.strip_suffix(suffix))
    else {
        return false;
    };
    let mut parts = version.strip_prefix('v').unwrap_or(version).split('.');
    let count = parts.clone().count();
    (count == 3 || (allow_two_part && count == 2))
        && parts.all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
}

pub(crate) fn native_appimage(
    port: &PortDefinition,
    platform: Platform,
) -> Option<NativeAppImage<'_>> {
    if platform != Platform::LinuxX86_64
        || !port.platforms.contains(&platform)
        || !port.bundled_runtime.is_empty()
    {
        return None;
    }
    if matches!(
        port.external_profile_policy,
        Some(
            crate::ExternalProfilePolicy::RecompAppimageV1
                | crate::ExternalProfilePolicy::VkquakeLinuxV1
                | crate::ExternalProfilePolicy::CorsixthLinuxV1
                | crate::ExternalProfilePolicy::OpenlocoUnixV1
                | crate::ExternalProfilePolicy::OpenomfLinuxV1
                | crate::ExternalProfilePolicy::EndlessSkyDesktopV1
        )
    ) {
        let [prefix, suffix] = port.release.asset_hints.get(&platform)?.as_slice() else {
            return None;
        };
        return Some(NativeAppImage::Versioned {
            prefix,
            suffix,
            allow_two_part: port.external_profile_policy
                == Some(crate::ExternalProfilePolicy::OpenlocoUnixV1),
        });
    }
    if !crate::native_temp::has_sibling_platforms(port) {
        return None;
    }
    let [asset] = port.release.asset_hints.get(&platform)?.as_slice() else {
        return None;
    };
    let [executable] = port.executable_hints.get(&platform)?.as_slice() else {
        return None;
    };
    [asset, executable]
        .into_iter()
        .all(|name| !name.contains(['/', '\\']) && name.to_ascii_lowercase().ends_with(".appimage"))
        .then_some(NativeAppImage::Exact(asset))
}

fn choose_asset<'a>(
    port: &PortDefinition,
    platform: Platform,
    assets: &'a [GithubAsset],
) -> Result<&'a GithubAsset> {
    choose_asset_for_variant(port, platform, assets, None)
}

fn choose_asset_for_variant<'a>(
    port: &PortDefinition,
    platform: Platform,
    assets: &'a [GithubAsset],
    saved: Option<(&ManagedPackageVariant, &str)>,
) -> Result<&'a GithubAsset> {
    let explicit = saved.filter(|(variant, _)| variant.explicit_id().is_some());
    if let Some((variant, tag)) = explicit {
        let mut matches = assets
            .iter()
            .filter(|asset| variant.names_explicit_family(&asset.name));
        let first = matches.next().ok_or_else(|| {
            PortcoveError::conflict(
                "the current release has no verified package matching the saved choice",
            )
            .detail("saved_package_variant", "no-matching-package")
        })?;
        if matches.next().is_some() {
            return Err(PortcoveError::conflict(
                "the current release has more than one package matching the saved choice",
            )
            .detail("saved_package_variant", "ambiguous"));
        }
        if !variant.matches(tag, &first.name) {
            return Err(PortcoveError::verification(
                "the selected package filename differs from its exact release tag",
            ));
        }
    }
    let requires_tar_xz = port.release.requires_tar_xz(platform);
    let standalone = native_appimage(port, platform);
    let hints = if let Some((variant, _)) = explicit {
        // The named, checked family replaces the default package preference;
        // portable suitability, package format and profile restrictions still apply.
        vec![variant.explicit_archive_hint().to_owned()]
    } else {
        port.release
            .asset_hints
            .get(&platform)
            .cloned()
            .unwrap_or_default()
    };
    let mut scored: Vec<(i32, &GithubAsset)> = assets
        .iter()
        .filter_map(|asset| {
            if saved.is_some_and(|(variant, tag)| !variant.matches(tag, &asset.name)) {
                return None;
            }
            let name = asset.name.to_ascii_lowercase();
            if !crate::native_external_profile::openmohaa::matches_asset(port, platform, &name)
                || !crate::native_external_profile::openjk::matches_asset(
                    port,
                    platform,
                    &asset.name,
                )
                || !crate::native_external_profile::quake_linux::matches_ironwail_tar(
                    port, platform, &name,
                )
                || !crate::native_external_profile::profile_siblings::matches_openloco_zip(
                    port, platform, &name,
                )
                || !crate::native_external_profile::archive_siblings::matches_asset(
                    port, platform, &name,
                )
                || !crate::native_portable_data::matches_archive(port, platform, &name)
                || !crate::native_external_profile::vcmi::matches_asset(port, platform, &name)
                || !crate::native_external_profile::endless_sky::matches_asset(
                    port, platform, &name,
                )
            {
                return None;
            }
            let supported_package = if let Some(expected) = &standalone {
                expected.matches(&name)
            } else if requires_tar_xz {
                name.ends_with(".tar.xz")
            } else {
                is_supported_package(&name)
            };
            if is_checksum_name(&name) || is_auxiliary_package(&name) || !supported_package {
                return None;
            }
            let can_extract = requires_tar_xz
                || [".zip", ".tar.gz", ".tgz"]
                    .iter()
                    .any(|extension| name.ends_with(extension));
            if (port.adapter == AdapterKind::NativePortable
                || port.n64_runtime_at_executable_parent)
                && !can_extract
                && standalone.is_none()
            {
                return None;
            }
            if matches!(
                port.adapter,
                AdapterKind::NativePortable | AdapterKind::StagedSourcePortable
            ) || port.n64_runtime_at_executable_parent
            {
                // Reusable portable rules and the download recommendation share
                // native suitability. A selected variant cannot become optional
                // when a successor publishes only another package class.
                if !hints
                    .iter()
                    .all(|hint| name.contains(&hint.to_ascii_lowercase()))
                {
                    return None;
                }
                let (_, _, score) = crate::service::package_selection::assess_package_name(
                    &name,
                    can_extract,
                    platform,
                    &hints,
                );
                return score.map(|score| (score as i32, asset));
            }
            if conflicts_with_platform(&name, platform) {
                return None;
            }
            if (port.adapter == AdapterKind::PsxRecompManaged
                || port.release.tar_xz_platforms.contains(&platform))
                && !hints
                    .iter()
                    .all(|hint| name.contains(&hint.to_ascii_lowercase()))
            {
                // Preparation-kit and declared TAR.XZ package choices stay mandatory.
                // PSX kits retain their own supported archive contract; source
                // preparation is not a native-player package disqualifier.
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
        if saved.is_some() {
            return Err(PortcoveError::conflict(
                "the current release has no verified package matching the saved choice",
            )
            .detail("saved_package_variant", "no-matching-package"));
        }
        return Err(PortcoveError::not_found(format!(
            "{} has no supported release asset for {platform:?}",
            port.name
        )));
    };
    if saved.is_some() && scored.len() > 1 {
        return Err(PortcoveError::conflict(
            "the current release has more than one package matching the saved choice",
        )
        .detail("saved_package_variant", "ambiguous"));
    }
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
    #[cfg(test)]
    observe_test_response(ResponseTestEvent::Headers);
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err(
            PortcoveError::verification(format!("{label} exceeds the {limit} byte limit"))
                .detail("response_byte_limit", limit.to_string()),
        );
    }
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| {
            #[cfg(test)]
            observe_test_response(ResponseTestEvent::Failed(
                ResponseTestPhase::Body,
                error.is_timeout(),
            ));
            PortcoveError::network(error.to_string())
        })?;
        if chunk.len() > limit.saturating_sub(body.len()) {
            return Err(PortcoveError::verification(format!(
                "{label} exceeds the {limit} byte limit"
            ))
            .detail("response_byte_limit", limit.to_string()));
        }
        body.extend_from_slice(&chunk);
        #[cfg(test)]
        if !chunk.is_empty() {
            observe_test_response(ResponseTestEvent::Body(chunk.len()));
        }
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
    name.contains("symbols")
        || name.contains("-pdb-")
        || name.ends_with("-pdb.zip")
        || crate::service::package_selection::is_server_package(&name)
        || crate::service::package_selection::is_license_compliance_archive(&name)
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
        // Some upstreams publish tags such as Version1.0.5beta12 with the
        // GitHub prerelease flag unset. Recognize a numbered beta suffix,
        // without treating unrelated words containing "beta" as prereleases.
        || tag.match_indices("beta").any(|(offset, _)| {
            offset > 0
                && tag.as_bytes()[offset - 1].is_ascii_digit()
                && tag.as_bytes().get(offset + 4).is_some_and(u8::is_ascii_digit)
        })
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
    use crate::test_http::{
        DeadlineServer, observe_response, serve_deadline, serve_http, serve_http_bytes,
        serve_routed_http,
    };

    mod unchanged_definition;
    mod uploader_progression;

    #[tokio::test]
    async fn exact_exclusion_uses_reviewed_fallback_and_allows_a_later_release() {
        let catalog = crate::Catalog::embedded().unwrap();
        let mut port = catalog.port("super-metroid-recomp").unwrap().clone();
        let hold = port.managed_acquisition_hold.as_mut().unwrap();
        hold.reviewed_artifacts = vec![crate::ReviewedHoldArtifact {
            version: "v0.4.5".into(),
            sha256: "a".repeat(64),
        }];
        hold.excluded_artifacts = vec![crate::ReviewedHoldArtifact {
            version: "v0.4.6".into(),
            sha256: "b".repeat(64),
        }];

        let response = |value: serde_json::Value| {
            let body = value.to_string();
            format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
        };
        let release = |id: u64, version: &str, digit: &str| {
            let name = format!("supermetroid-{version}-windows-x64.zip");
            serde_json::json!({
                "id": id,
                "tag_name": format!("v{version}"),
                "draft": false,
                "prerelease": false,
                "assets": [{
                    "id": id + 100,
                    "name": name,
                    "size": 42,
                    "digest": format!("sha256:{}", digit.repeat(64)),
                    "browser_download_url": format!(
                        "https://github.com/mstan/SuperMetroidRecomp/releases/download/v{version}/{name}"
                    ),
                }],
            })
        };
        let repository = || response(serde_json::json!({"id": 1, "archived": false}));
        let reviewed = release(45, "0.4.5", "a");
        let excluded = release(46, "0.4.6", "b");
        let unreviewed = release(44, "0.4.4", "c");
        let (origin, _, server) = serve_http(vec![
            repository(),
            response(serde_json::json!([
                excluded.clone(),
                reviewed.clone(),
                unreviewed.clone()
            ])),
        ]);
        let provider = GithubReleaseProvider::with_api_root(origin).unwrap();
        let fallback = provider
            .resolve_scoped(&port, ReleaseChannel::Stable, Platform::WindowsX86_64, None)
            .await
            .unwrap();
        assert_eq!(fallback.release.version, "v0.4.5");
        assert_eq!(fallback.release.asset.sha256, "a".repeat(64));
        assert_eq!(
            fallback.fallback_reason.as_deref(),
            port.managed_acquisition_hold
                .as_ref()
                .map(|hold| hold.reason.as_str())
        );
        assert_eq!(fallback.github_identity.unwrap().asset_id, 145);
        server.join().unwrap();

        let checksum = format!("{}  supermetroid-0.4.5-windows-x64.zip\n", "a".repeat(64));
        let (checksum_origin, checksum_requests, checksum_server) = serve_http(vec![format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{checksum}",
            checksum.len()
        )]);
        let mut sidecar_release = reviewed;
        let assets = sidecar_release["assets"].as_array_mut().unwrap();
        assets[0]["digest"] = serde_json::Value::Null;
        assets.push(serde_json::json!({
            "id": 245,
            "name": "SHA256SUMS",
            "size": checksum.len(),
            "browser_download_url": format!("{checksum_origin}/SHA256SUMS"),
        }));
        let (origin, _, server) = serve_http(vec![
            repository(),
            response(serde_json::json!([excluded.clone(), sidecar_release])),
        ]);
        let provider = GithubReleaseProvider::with_api_root(origin).unwrap();
        let fallback = provider
            .resolve_scoped(&port, ReleaseChannel::Stable, Platform::WindowsX86_64, None)
            .await
            .unwrap();
        assert_eq!(fallback.release.version, "v0.4.5");
        assert_eq!(fallback.release.asset.sha256, "a".repeat(64));
        assert!(
            checksum_requests
                .try_recv()
                .unwrap()
                .starts_with("GET /SHA256SUMS ")
        );
        server.join().unwrap();
        checksum_server.join().unwrap();

        let (origin, _, server) = serve_http(vec![
            repository(),
            response(serde_json::json!([excluded.clone(), unreviewed])),
        ]);
        let provider = GithubReleaseProvider::with_api_root(origin).unwrap();
        let refusal = provider
            .resolve_scoped(&port, ReleaseChannel::Stable, Platform::WindowsX86_64, None)
            .await
            .unwrap_err();
        assert_eq!(refusal.code, crate::ErrorCode::Unsupported);
        server.join().unwrap();

        let (origin, _, server) = serve_http(vec![
            repository(),
            response(serde_json::json!([release(47, "0.4.7", "d"), excluded])),
        ]);
        let provider = GithubReleaseProvider::with_api_root(origin).unwrap();
        let later = provider
            .resolve_scoped(&port, ReleaseChannel::Stable, Platform::WindowsX86_64, None)
            .await
            .unwrap();
        assert_eq!(later.release.version, "v0.4.7");
        assert!(later.fallback_reason.is_none());
        assert_eq!(later.github_identity.unwrap().asset_id, 147);
        server.join().unwrap();
    }

    #[tokio::test]
    async fn shape_fallback_selects_the_newest_exact_review_and_preserves_ordinary_selection() {
        let catalog = crate::Catalog::embedded().unwrap();
        let port = catalog.port("super-mario-world-recomp").unwrap();
        let platform = Platform::WindowsX86_64;
        let reviewed = crate::package_shape::reviewed_release_digests(port, platform);
        let digest = |tag| {
            reviewed
                .iter()
                .find(|(version, _)| *version == tag)
                .unwrap()
                .1
        };
        let response = |value: serde_json::Value| {
            let body = value.to_string();
            format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len(),
            )
        };
        let asset = |version: &str, hash: &str| {
            let name = format!("SuperMarioWorldRecomp-windows-x64-{version}.zip");
            ReleaseAsset {
                url: format!(
                    "https://github.com/{}/releases/download/{version}/{name}",
                    port.release.repository
                ),
                name,
                size: 42,
                sha256: hash.into(),
            }
        };
        let release = |id: u64, tag: &str, sha256: &str| {
            let asset = asset(tag, sha256);
            serde_json::json!({
                "id": id,
                "tag_name": tag,
                "draft": false,
                "prerelease": false,
                "assets": [{
                    "id": id + 100,
                    "name": asset.name,
                    "size": asset.size,
                    "digest": format!("sha256:{}", asset.sha256),
                    "browser_download_url": asset.url,
                }],
            })
        };
        let candidate_hash = "b".repeat(64);
        let latest = release(16, "v0.16.0", &candidate_hash);
        let latest_replaced = release(16, "v0.16.0", &"c".repeat(64));
        let releases = serde_json::json!([
            latest,
            release(15, "v0.15.10", &"a".repeat(64)),
            release(14, "v0.15.9", digest("v0.15.9")),
            release(12, "v0.12.0", digest("v0.12.0")),
        ]);
        let repository = || response(serde_json::json!({ "id": 1, "archived": false }));
        let (origin, _, server) = serve_http(vec![
            repository(),
            response(releases.clone()),
            repository(),
            response(serde_json::json!([latest_replaced])),
            repository(),
            response(releases),
        ]);
        let provider = GithubReleaseProvider::with_api_root(origin).unwrap();
        let withheld = ResolvedRelease {
            version: "v0.16.0".into(),
            channel: ReleaseChannel::Stable,
            published_at: None,
            asset: asset("v0.16.0", &candidate_hash),
            uploader_continuity: None,
        };

        let fallback = provider
            .resolve_shape_fallback(port, platform, None, &withheld)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(fallback.release.version, "v0.15.9");
        assert_eq!(fallback.release.asset.sha256, digest("v0.15.9"));
        assert_eq!(fallback.github_identity.unwrap().asset_id, 114);
        assert!(fallback.fallback_reason.unwrap().contains("v0.16.0"));

        let replaced = provider
            .resolve_shape_fallback(port, platform, None, &withheld)
            .await
            .unwrap_err();
        assert_eq!(replaced.code, crate::ErrorCode::Conflict);

        let ordinary = provider
            .resolve_scoped(port, ReleaseChannel::Stable, platform, None)
            .await
            .unwrap();
        assert_eq!(ordinary.release.version, withheld.version);
        assert_eq!(ordinary.release.asset, withheld.asset);
        assert!(ordinary.fallback_reason.is_none());
        server.join().unwrap();
    }

    #[tokio::test]
    async fn github_selection_retains_exact_ids_through_cache_and_refuses_repository_rebinding() {
        let port = crate::Catalog::embedded()
            .unwrap()
            .port("shipwright")
            .unwrap()
            .clone();
        let response = |value: serde_json::Value| {
            let body = value.to_string();
            format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
        };
        let repository = serde_json::json!({"id":1,"archived":false});
        let releases = serde_json::json!([{"id":2,"tag_name":"fixture-n","draft":false,"prerelease":false,
            "assets":[{"id":3,"name":"game-windows.zip","size":42,"digest":format!("sha256:{}","a".repeat(64)),
            "browser_download_url":"https://github.com/HarbourMasters/Shipwright/releases/download/fixture-n/game-windows.zip"}]}]);
        let (origin, _, server) = serve_http(vec![
            response(repository.clone()),
            response(releases),
            response(repository),
            response(serde_json::json!({"id":4,"archived":false})),
        ]);
        let provider = GithubReleaseProvider::with_api_root(origin).unwrap();
        let first = provider
            .resolve_scoped(&port, ReleaseChannel::Stable, Platform::WindowsX86_64, None)
            .await
            .unwrap();
        let identity = first.github_identity.unwrap();
        assert_eq!(
            (
                identity.repository_id,
                identity.release_id,
                identity.asset_id
            ),
            (1, 2, 3)
        );
        assert_eq!(identity.tag, "fixture-n");
        let cached = provider
            .resolve_scoped(&port, ReleaseChannel::Stable, Platform::WindowsX86_64, None)
            .await
            .unwrap();
        assert_eq!(cached.github_identity, Some(identity));
        assert_eq!(cached.release.asset.sha256, "a".repeat(64));
        assert!(
            provider
                .resolve_scoped(&port, ReleaseChannel::Stable, Platform::WindowsX86_64, None)
                .await
                .unwrap_err()
                .message
                .contains("repository identity changed")
        );
        server.join().unwrap();
    }

    #[tokio::test]
    async fn github_selection_reports_repository_activity_from_existing_metadata() {
        let port = crate::Catalog::embedded()
            .unwrap()
            .port("shipwright")
            .unwrap()
            .clone();
        let response = |value: serde_json::Value| {
            let body = value.to_string();
            format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
        };
        let releases = serde_json::json!([{"id":2,"tag_name":"fixture-n","draft":false,"prerelease":false,
            "assets":[{"id":3,"name":"game-windows.zip","size":42,"digest":format!("sha256:{}","a".repeat(64)),
            "browser_download_url":"https://github.com/HarbourMasters/Shipwright/releases/download/fixture-n/game-windows.zip"}]}]);
        // Two selections: the second is served from the selection cache, so the
        // only provider reads are the two repository documents and one release list.
        let (origin, _, server) = serve_http(vec![
            response(serde_json::json!({
                "id":1,"archived":true,"pushed_at":"2023-04-05T06:07:08Z"
            })),
            response(releases),
            response(serde_json::json!({"id":1,"archived":false,"pushed_at":7})),
        ]);
        let provider = GithubReleaseProvider::with_api_root(origin).unwrap();
        let before = Library::now();
        let archived = provider
            .resolve_scoped(&port, ReleaseChannel::Stable, Platform::WindowsX86_64, None)
            .await
            .unwrap()
            .upstream_activity
            .unwrap();
        assert!(archived.archived);
        assert_eq!(archived.repository, port.release.repository);
        assert_eq!(archived.last_change_at, Some(1_680_674_828));
        assert!(archived.observed_at >= before);
        // A malformed push time is an unknown fact, never a failed selection.
        let cached = provider
            .resolve_scoped(&port, ReleaseChannel::Stable, Platform::WindowsX86_64, None)
            .await
            .unwrap()
            .upstream_activity
            .unwrap();
        assert!(!cached.archived);
        assert_eq!(cached.last_change_at, None);
        server.join().unwrap();
    }

    #[tokio::test]
    async fn pending_auth_status_http_observation_releases_library_lease() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path()).unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let (entered, observed) = tokio::sync::oneshot::channel();
        let (release, resume) = std::sync::mpsc::channel();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
            let mut request = [0; 4096];
            assert!(std::io::Read::read(&mut stream, &mut request).unwrap() > 0);
            entered.send(()).unwrap();
            resume
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap();
            std::io::Write::write_all(
                &mut stream,
                b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
            )
            .unwrap();
        });
        let provider = GithubReleaseProvider::build_with_credential(
            Some(library.clone()),
            &origin,
            &origin,
            PROVIDER_NETWORK_BOUNDS,
            Some(GithubCredential {
                token: None,
                source: GithubAuthSource::Anonymous,
                environment_variable: None,
                intent: 0,
            }),
            true,
        )
        .unwrap();
        let pending = provider.auth_status();
        drop(provider);
        drop(library);
        let observation = tokio::spawn(pending);
        tokio::time::timeout(std::time::Duration::from_secs(5), observed)
            .await
            .unwrap()
            .unwrap();
        let exclusive = crate::library_access::LibraryLease::with_access(
            temporary.path(),
            crate::library_access::LibraryAccess::Exclusive,
        )
        .expect("an in-flight auth HTTP observation must not retain a library lease");
        drop(exclusive);
        release.send(()).unwrap();
        assert!(!observation.await.unwrap().unwrap().authenticated);
        server.join().unwrap();
    }

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
        sync::mpsc,
        thread,
    };

    fn short_network_bounds() -> ProviderNetworkBounds {
        ProviderNetworkBounds {
            connect: Duration::from_millis(50),
            read_idle: Duration::from_millis(50),
            request: Duration::from_millis(180),
        }
    }

    enum DeadlineResponse {
        HeaderStall,
        BodyStall,
        Trickle,
    }

    fn serve_deadline_response(mode: DeadlineResponse) -> (String, DeadlineServer) {
        serve_deadline(move |connection| {
            if !matches!(mode, DeadlineResponse::HeaderStall) {
                connection.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 10000\r\n\r\n")?;
                connection.write_all(b"{")?;
                connection.flush()?;
            }
            if matches!(mode, DeadlineResponse::Trickle) {
                while !connection.wait(Duration::from_millis(10)) {
                    if connection
                        .write_all(b" ")
                        .and_then(|()| connection.flush())
                        .is_err()
                    {
                        break;
                    }
                }
            } else {
                connection.wait(Duration::from_millis(600));
            }
            Ok(())
        })
    }

    #[test]
    fn deadline_fixture_can_stop_before_or_after_arming_without_a_client() {
        for armed in [false, true] {
            let (_, mut server) = serve_deadline_response(DeadlineResponse::HeaderStall);
            if armed {
                server.start();
            }
            let started = Instant::now();
            let report = server.finish().unwrap();
            assert_eq!(report.armed, armed);
            assert!(!report.request_received);
            assert!(started.elapsed() < Duration::from_millis(500));
        }
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
                    environment_variable: None,
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
                    environment_variable: None,
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
                    environment_variable: None,
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
                        environment_variable: None,
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
                    environment_variable: None,
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
                    environment_variable: None,
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
    async fn metadata_body_progress_exhausts_the_overall_request_bound() {
        let (metadata_root, mut metadata_server) =
            serve_deadline_response(DeadlineResponse::Trickle);
        // Keep a wide gap between trickle cadence, idle guard and total bound.
        // Windows observed a 25.68ms last-chunk gap at the old 25ms guard;
        // the same phase assertions below must still exclude read-idle expiry.
        let bounds = ProviderNetworkBounds {
            connect: Duration::from_millis(200),
            read_idle: Duration::from_millis(200),
            request: Duration::from_millis(800),
        };
        let provider =
            GithubReleaseProvider::with_api_root_and_bounds(metadata_root.clone(), bounds).unwrap();
        metadata_server.start();
        let started = Instant::now();
        let (result, observed) = observe_response(
            provider.get_json::<serde_json::Value>(&format!("{metadata_root}/metadata")),
        )
        .await;
        let elapsed = started.elapsed();
        let server = metadata_server.finish();
        eprintln!("metadata deadline: {elapsed:?}; observation={observed:?}; fixture={server:?}");
        let error = result.unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Network);
        assert!(elapsed < Duration::from_millis(1500));
        let server = server.unwrap();
        assert!(server.armed && server.request_received);
        assert!(observed.headers.is_some(), "{observed:?}");
        assert!(observed.body_bytes >= 3, "{observed:?}");
        assert_eq!(observed.failed_phase, Some(ResponseTestPhase::Body));
        assert!(observed.timed_out);
        assert!(
            observed
                .last_body
                .unwrap()
                .duration_since(observed.first_body.unwrap())
                >= bounds.read_idle * 2,
            "{observed:?}"
        );
        assert!(
            observed
                .failed_at
                .unwrap()
                .duration_since(observed.last_body.unwrap())
                < bounds.read_idle / 2,
            "recent body progress must exclude read-idle exhaustion: {observed:?}"
        );
        assert!(
            elapsed >= bounds.request.saturating_sub(Duration::from_millis(10)),
            "{elapsed:?}; {observed:?}"
        );
    }

    #[tokio::test]
    async fn authenticated_status_partial_body_exhausts_the_read_idle_bound() {
        let (auth_root, mut auth_server) = serve_deadline_response(DeadlineResponse::BodyStall);
        // The 50ms fixture guard expired before the Windows server received
        // the request (62ms, no headers/body). Leave room to reach the body,
        // while retaining the assertions that idle expiry precedes total expiry.
        let bounds = ProviderNetworkBounds {
            connect: Duration::from_millis(200),
            read_idle: Duration::from_millis(200),
            request: Duration::from_millis(800),
        };
        let provider = GithubReleaseProvider::with_api_root_and_bounds(auth_root, bounds).unwrap();
        provider.set_credential(
            Some("fixed-phase-fixture-token".into()),
            GithubAuthSource::CredentialStore,
        );
        auth_server.start();
        let started = Instant::now();
        let (result, observed) = observe_response(provider.auth_status()).await;
        let elapsed = started.elapsed();
        let server = auth_server.finish();
        eprintln!(
            "authenticated body deadline: {elapsed:?}; observation={observed:?}; fixture={server:?}"
        );
        let error = result.unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Network);
        assert!(elapsed < Duration::from_millis(500));
        let server = server.unwrap();
        assert!(server.armed && server.request_received);
        assert!(observed.headers.is_some(), "{observed:?}");
        assert_eq!(observed.body_bytes, 1, "{observed:?}");
        assert_eq!(observed.failed_phase, Some(ResponseTestPhase::Body));
        assert!(observed.timed_out);
        assert!(
            observed
                .failed_at
                .unwrap()
                .duration_since(observed.last_body.unwrap())
                >= bounds.read_idle / 2,
            "{observed:?}"
        );
        assert!(
            elapsed < bounds.request,
            "idle timeout must precede total deadline: {elapsed:?}; {observed:?}"
        );
    }

    #[tokio::test]
    async fn authentication_request_reaches_server_before_header_idle_timeout() {
        let (auth_root, mut auth_server) = serve_deadline_response(DeadlineResponse::HeaderStall);
        let bounds = short_network_bounds();
        let provider = GithubReleaseProvider::with_api_root_and_bounds(auth_root, bounds).unwrap();
        auth_server.start();
        let started = Instant::now();
        let (result, observed) = observe_response(provider.auth_status()).await;
        let elapsed = started.elapsed();
        let server = auth_server.finish();
        eprintln!(
            "authentication header deadline: {elapsed:?}; observation={observed:?}; fixture={server:?}"
        );
        assert_eq!(result.unwrap_err().code, crate::ErrorCode::Network);
        assert!(elapsed < Duration::from_millis(500));
        let server = server.unwrap();
        assert!(server.armed && server.request_received);
        assert!(observed.headers.is_none(), "{observed:?}");
        assert_eq!(observed.body_bytes, 0);
        assert_eq!(observed.failed_phase, Some(ResponseTestPhase::Headers));
        assert!(observed.timed_out);
        assert!(elapsed < bounds.request, "{elapsed:?}; {observed:?}");
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
            uploader_continuity: None,
        };
        let oldest_key = ReleaseSelectionCacheKey {
            adapter: AdapterKind::NativePortable,
            n64_runtime_at_executable_parent: false,
            partitioned_archive: false,
            requires_tar_xz: false,
            native_appimage: false,
            native_appimage_two_part: false,
            restricted_native_archive: false,
            scope_binding: None,
            repository: "owner/repository-0".into(),
            channel: ReleaseChannel::Stable,
            platform: Platform::WindowsX86_64,
            rolling_tag: None,
            asset_hints: Vec::new(),
            other_stream_tag_prefixes: Vec::new(),
            acquisition_policy: None,
            accepted_uploaders: Vec::new(),
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
                        adapter: AdapterKind::NativePortable,
                        n64_runtime_at_executable_parent: false,
                        partitioned_archive: false,
                        requires_tar_xz: false,
                        native_appimage: false,
                        native_appimage_two_part: false,
                        restricted_native_archive: false,
                        scope_binding: None,
                        repository: format!("owner/repository-{index}"),
                        channel: ReleaseChannel::Stable,
                        platform: Platform::WindowsX86_64,
                        rolling_tag: None,
                        asset_hints: Vec::new(),
                        other_stream_tag_prefixes: Vec::new(),
                        acquisition_policy: None,
                        accepted_uploaders: Vec::new(),
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

    #[test]
    fn release_cache_holds_every_embedded_selector_slot_with_headroom() {
        let catalog = crate::Catalog::embedded().unwrap();
        for platform in [
            Platform::WindowsX86_64,
            Platform::LinuxX86_64,
            Platform::MacosX86_64,
            Platform::MacosAarch64,
        ] {
            let slots: usize = catalog
                .ports()
                .iter()
                .filter(|port| {
                    matches!(
                        port.release.provider,
                        crate::ReleaseSource::Github | crate::ReleaseSource::Gitlab
                    ) && !port.release.repository.is_empty()
                        && port.platforms.contains(&platform)
                })
                .map(|port| port.channels.len())
                .sum();
            assert!(
                slots * 2 <= RELEASE_CACHE_MAX_ENTRIES,
                "{platform:?} has {slots} provider selector slots; raise RELEASE_CACHE_MAX_ENTRIES"
            );
        }
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
            let environment_variable =
                (source == GithubAuthSource::Environment).then_some("GH_TOKEN");
            provider.credential.write().unwrap().environment_variable = environment_variable;
            let result = provider.auth_status().await;
            server.join().unwrap();
            if response_code == 401 {
                let status = result.unwrap();
                assert_eq!(status.source, source);
                assert_eq!(status.environment_variable.as_deref(), environment_variable);
                let serialized = serde_json::to_value(&status).unwrap();
                if let Some(name) = environment_variable {
                    assert_eq!(serialized["source"], "environment");
                    assert_eq!(serialized["environment_variable"], name);
                } else {
                    assert_eq!(serialized["source"], "credential_store");
                    assert!(serialized.get("environment_variable").is_none());
                }
                assert!(!serialized.to_string().contains("rejected-test-token"));
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
                    let failure = result.unwrap_err().report();
                    assert_eq!(failure.code, crate::ErrorCode::Network);
                    assert_eq!(
                        failure.presentation.presentation_key,
                        "github_device_code_expired"
                    );
                    assert_eq!(
                        failure.presentation.mutation_state,
                        crate::MutationState::NoChanges
                    );
                    assert!(
                        !provider
                            .device_sessions
                            .lock()
                            .await
                            .contains_key(&session_id)
                    );
                }
                Expected::Cancelled => {
                    let failure = result.unwrap_err().report();
                    assert_eq!(failure.code, crate::ErrorCode::Conflict);
                    assert_eq!(
                        failure.presentation.presentation_key,
                        "github_device_authorization_denied"
                    );
                    assert_eq!(
                        failure.presentation.mutation_state,
                        crate::MutationState::NoChanges
                    );
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
        assert_eq!(
            expired.report().presentation.presentation_key,
            "github_device_code_expired"
        );
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
            id: None,
            tag_name: "v0.2.0-dev".into(),
            name: None,
            body: None,
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
            id: None,
            tag_name: "v1.2.3".into(),
            name: None,
            body: None,
            draft: false,
            prerelease: false,
            published_at: None,
            assets: Vec::new(),
        };

        assert!(!is_beta_release(&release));
    }

    #[test]
    fn numbered_beta_suffix_is_not_a_stable_release() {
        for tag in ["Version1.0.5beta12", "v2.0BETA3"] {
            let release: GithubRelease =
                serde_json::from_value(github_release(tag, false, "game-windows.zip")).unwrap();
            assert!(is_beta_release(&release), "{tag}");
        }
        for tag in ["betamax1.0", "v1.0alphabetagamma", "Version1.0.4"] {
            let release: GithubRelease =
                serde_json::from_value(github_release(tag, false, "game-windows.zip")).unwrap();
            assert!(!is_beta_release(&release), "{tag}");
        }
    }

    #[tokio::test]
    async fn dkr_numbered_beta_does_not_replace_the_stable_release() {
        // Existing managed DKR-R definitions retain their release semantics;
        // the current user-selected route offers no managed acquisition.
        let catalog =
            crate::Catalog::from_json(include_str!("../catalog/catalog-schema1-fixture.json"))
                .unwrap();
        let port = catalog.port("dkr-r").unwrap();
        for platform in [Platform::WindowsX86_64, Platform::LinuxX86_64] {
            let asset = |version: &str| match platform {
                Platform::WindowsX86_64 => format!("DKR-R-{version}-Windows-x64.zip"),
                Platform::LinuxX86_64 => format!("DKR-R-{version}-Linux-x86_64.AppImage"),
                _ => unreachable!(),
            };
            let releases = vec![
                github_release("Version1.0.5beta12", false, &asset("1.0.5-beta.12")),
                github_release("Version1.0.4", false, &asset("1.0.4")),
            ];
            let (api_root, _, server) = serve_http(vec![
                ok_json(r#"{"archived":false}"#, ""),
                ok_json(&serde_json::to_string(&releases).unwrap(), ""),
            ]);
            let stable = GithubReleaseProvider::with_api_root(api_root)
                .unwrap()
                .resolve(port, ReleaseChannel::Stable, platform)
                .await
                .unwrap();
            server.join().unwrap();
            assert_eq!(stable.version, "Version1.0.4");
            assert_eq!(stable.asset.name, asset("1.0.4"));

            // The unchanged catalog does not offer Beta. Classification must
            // not silently grant that channel or make a network request.
            let beta = GithubReleaseProvider::with_api_root("http://127.0.0.1:9")
                .unwrap()
                .resolve(port, ReleaseChannel::Beta, platform)
                .await
                .unwrap_err();
            assert_eq!(beta.code, crate::ErrorCode::Unsupported);

            let (api_root, _, server) = serve_http(vec![
                ok_json(r#"{"archived":false}"#, ""),
                ok_json(&serde_json::to_string(&releases[..1]).unwrap(), ""),
            ]);
            let unavailable = GithubReleaseProvider::with_api_root(api_root)
                .unwrap()
                .resolve(port, ReleaseChannel::Stable, platform)
                .await
                .unwrap_err();
            server.join().unwrap();
            assert_eq!(unavailable.code, crate::ErrorCode::NotFound);
        }
    }

    #[test]
    fn battleship_offered_managed_platforms_resolve_from_the_published_package_inventory() {
        let release: GithubRelease = serde_json::from_str(include_str!(
            "testdata/battleship-v1.6-release-2026-10-25.json"
        ))
        .unwrap();
        let catalog = crate::Catalog::embedded().unwrap();
        let port = catalog.port("battleship").unwrap();
        for &platform in &port.platforms {
            let asset = choose_asset(port, platform, &release.assets).unwrap_or_else(|error| {
                panic!("offered BattleShip platform {platform:?} has no supported package: {error}")
            });
            assert!(!asset.name.contains("-JP"), "the source contract is USA");
        }
        assert!(
            release
                .assets
                .iter()
                .any(|asset| asset.name == "BattleShip.dmg")
        );
        assert!(!is_supported_package("battleship.dmg"));
        assert!(!port.platforms.contains(&Platform::MacosAarch64));
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
            id: None,
            name: name.into(),
            browser_download_url: format!("https://downloads.example.invalid/{name}"),
            size: 1,
            digest: Some(format!("sha256:{}", digest.to_string().repeat(64))),
            uploader: Default::default(),
            created_at: None,
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

    #[tokio::test]
    async fn open_nectar_windows_hint_tracks_a_successor_without_a_definition_edit() {
        let catalog = crate::Catalog::embedded().unwrap();
        let port = catalog.port("open-nectar-pikmin").unwrap();
        let release = |tag: &str, digest: char| {
            serde_json::json!({
                "tag_name": tag,
                "draft": false,
                "prerelease": false,
                "published_at": null,
                "assets": [{
                    "name": format!("nectar-windows-{tag}.zip"),
                    "browser_download_url": format!("https://downloads.example.invalid/nectar-{tag}.zip"),
                    "size": 1,
                    "digest": format!("sha256:{}", digest.to_string().repeat(64))
                }]
            })
        };
        let v1 = release("0.8.5", 'a');
        let v2 = release("0.8.6", 'b');

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

        assert_eq!(baseline.version, "0.8.5");
        assert_eq!(successor.version, "0.8.6");
        assert_eq!(baseline.asset.name, "nectar-windows-0.8.5.zip");
        assert_eq!(successor.asset.name, "nectar-windows-0.8.6.zip");
        assert_eq!(successor.asset.sha256, "b".repeat(64));
        assert_ne!(successor.asset.sha256, baseline.asset.sha256);
    }

    #[tokio::test]
    async fn open_nectar_selector_rejects_wrong_platform_ambiguous_assets_and_missing_digest() {
        let catalog = crate::Catalog::embedded().unwrap();
        let port = catalog.port("open-nectar-pikmin").unwrap();
        let unsupported = GithubReleaseProvider::with_api_root("https://api.example.invalid")
            .unwrap()
            .resolve(port, ReleaseChannel::Stable, Platform::LinuxX86_64)
            .await
            .unwrap_err();
        assert_eq!(unsupported.code, crate::ErrorCode::Unsupported);

        let ambiguous = [
            GithubAsset {
                id: None,
                name: "nectar-windows-one.zip".into(),
                browser_download_url: "https://downloads.example.invalid/one.zip".into(),
                size: 1,
                digest: Some(format!("sha256:{}", "a".repeat(64))),
                uploader: Default::default(),
                created_at: None,
            },
            GithubAsset {
                id: None,
                name: "nectar-windows-two.zip".into(),
                browser_download_url: "https://downloads.example.invalid/two.zip".into(),
                size: 1,
                digest: Some(format!("sha256:{}", "b".repeat(64))),
                uploader: Default::default(),
                created_at: None,
            },
        ];
        let error = choose_asset(port, Platform::WindowsX86_64, &ambiguous).unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Conflict);
        assert!(error.message.contains("equally qualified"));

        let unchecksummed = serde_json::json!({
            "tag_name": "0.8.5",
            "draft": false,
            "prerelease": false,
            "published_at": null,
            "assets": [{
                "name": "nectar-windows.zip",
                "browser_download_url": "https://downloads.example.invalid/nectar-windows.zip",
                "size": 1,
                "digest": null
            }]
        });
        let responses = vec![
            ok_json(r#"{"archived":false}"#, ""),
            ok_json(&serde_json::to_string(&vec![unchecksummed]).unwrap(), ""),
        ];
        let (api_root, _, server) = serve_http(responses);
        let error = GithubReleaseProvider::with_api_root(api_root)
            .unwrap()
            .resolve(port, ReleaseChannel::Stable, Platform::WindowsX86_64)
            .await
            .unwrap_err();
        server.join().unwrap();
        assert_eq!(error.code, crate::ErrorCode::Verification);
        assert!(error.message.contains("does not publish a SHA-256 digest"));
    }

    #[test]
    fn runnable_archive_wins_over_matching_symbol_archive() {
        let catalog = crate::Catalog::embedded().unwrap();
        let port = catalog.port("re-blue").unwrap();
        let assets = [
            GithubAsset {
                id: None,
                name: "reblue-1.0.0-win-amd64-symbols.zip".into(),
                browser_download_url: "https://example.invalid/symbols.zip".into(),
                size: 1,
                digest: None,
                uploader: Default::default(),
                created_at: None,
            },
            GithubAsset {
                id: None,
                name: "reblue-1.0.0-win-amd64.zip".into(),
                browser_download_url: "https://example.invalid/runtime.zip".into(),
                size: 1,
                digest: None,
                uploader: Default::default(),
                created_at: None,
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
                    id: None,
                    name: name.into(),
                    browser_download_url: "https://example.invalid/package.zip".into(),
                    size: 1,
                    digest: Some(format!("sha256:{}", "a".repeat(64))),
                    uploader: Default::default(),
                    created_at: None,
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
        let headers = provider
            .metadata_headers(
                "https://example.invalid/repos/example/project",
                provider.active_token().as_deref(),
                None,
            )
            .unwrap();
        assert_eq!(headers[header::AUTHORIZATION], "Bearer test-token");
        assert!(headers[header::AUTHORIZATION].is_sensitive());
    }

    #[test]
    fn anonymous_requests_do_not_send_authorization() {
        let provider = GithubReleaseProvider::with_api_root("https://example.invalid").unwrap();
        let headers = provider
            .metadata_headers(
                "https://example.invalid/repos/example/project",
                provider.active_token().as_deref(),
                None,
            )
            .unwrap();
        assert!(!headers.contains_key(header::AUTHORIZATION));
    }

    #[test]
    fn tokens_are_not_sent_to_release_asset_origins() {
        let provider = GithubReleaseProvider::with_api_root("https://api.example.invalid").unwrap();
        provider.set_credential(Some("test-token".into()), GithubAuthSource::CredentialStore);
        let token = provider.active_token();
        for url in [
            "https://downloads.example.invalid/checksums.txt",
            "https://api.example.invalid.attacker.test/repos/project",
            "https://api.example.invalid:444/repos/project",
            "http://api.example.invalid/repos/project",
        ] {
            let headers = provider
                .metadata_headers(url, token.as_deref(), None)
                .unwrap();
            assert!(!headers.contains_key(header::AUTHORIZATION), "{url}");
        }
    }

    fn created_issue(html_url: &str) -> String {
        let body = format!(r#"{{"number":7,"html_url":"{html_url}"}}"#);
        format!(
            "HTTP/1.1 201 Created\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    fn report_issue_fixture() -> crate::ReportIssue {
        crate::ReportIssue {
            title: "[Feedback] Setup was slow".into(),
            body: "### What happened?\n\nSetup was slow\n".into(),
            labels: vec!["needs-triage".into()],
        }
    }

    #[tokio::test]
    async fn submitting_a_report_needs_a_sign_in_and_sends_nothing_without_one() {
        let anonymous = GithubReleaseProvider::with_api_root("http://127.0.0.1:9").unwrap();
        let refused = anonymous
            .submit_report(&report_issue_fixture())
            .await
            .unwrap_err();
        assert!(refused.message.contains("sign in"), "{}", refused.message);
    }

    #[tokio::test]
    async fn submitted_reports_post_core_text_to_portcove_with_the_stored_token() {
        // The fixture origin is only known once the server listens, so the
        // response is built from a request-time closure.
        let (origin, requests, server) = crate::test_http::serve_routed_http(1, |request: &str| {
            let host = request
                .lines()
                .find_map(|line| line.strip_prefix("host: ").or(line.strip_prefix("Host: ")))
                .unwrap_or_default()
                .trim()
                .to_owned();
            created_issue(&format!("http://{host}/boburning/portcove/issues/7"))
        });
        let provider = GithubReleaseProvider::with_api_root(origin).unwrap();
        provider.set_credential(
            Some("player-token".into()),
            GithubAuthSource::CredentialStore,
        );
        let submitted = provider
            .submit_report(&report_issue_fixture())
            .await
            .unwrap();
        assert_eq!(submitted.number, 7);
        assert!(submitted.url.ends_with("/boburning/portcove/issues/7"));
        server.join().unwrap();
        let request = requests.recv().unwrap();
        let (headers, body) = request.split_once("\r\n\r\n").unwrap();
        let headers = headers.to_ascii_lowercase();
        assert!(headers.starts_with("post /repos/boburning/portcove/issues "));
        assert!(headers.contains("\r\nauthorization: bearer player-token\r\n"));
        assert!(headers.contains("\r\ncontent-type: application/json\r\n"));
        let sent: serde_json::Value = serde_json::from_str(body).unwrap();
        assert_eq!(sent["title"], "[Feedback] Setup was slow");
        assert_eq!(sent["labels"], serde_json::json!(["needs-triage"]));
    }

    #[tokio::test]
    async fn a_refused_or_foreign_submission_is_reported_not_trusted() {
        let forbidden = "HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}".to_owned();
        let slowed = "HTTP/1.1 403 Forbidden\r\nRetry-After: 60\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}".to_owned();
        let (origin, _requests, server) = serve_http(vec![
            forbidden,
            slowed,
            created_issue("https://example.com/other/repo/issues/7"),
        ]);
        let provider = GithubReleaseProvider::with_api_root(origin).unwrap();
        provider.set_credential(
            Some("player-token".into()),
            GithubAuthSource::CredentialStore,
        );
        let refused = provider
            .submit_report(&report_issue_fixture())
            .await
            .unwrap_err();
        assert!(
            refused.message.contains("did not let this sign-in"),
            "{}",
            refused.message
        );
        // The secondary limit for creating content keeps its retry hint.
        let slowed = provider
            .submit_report(&report_issue_fixture())
            .await
            .unwrap_err();
        assert!(
            !slowed.message.contains("did not let this sign-in"),
            "{}",
            slowed.message
        );
        assert_eq!(
            slowed.details.get("retry_after").map(String::as_str),
            Some("60")
        );
        let foreign = provider
            .submit_report(&report_issue_fixture())
            .await
            .unwrap_err();
        assert!(
            foreign.message.contains("outside Portcove's repository"),
            "{}",
            foreign.message
        );
        server.join().unwrap();
    }

    #[tokio::test]
    async fn github_device_posts_use_the_anonymous_form_protocol() {
        let (origin, requests, server) = serve_http(vec![
            ok_json(r#"{"login":"fixture"}"#, ""),
            ok_json(
                r#"{"device_code":"device&code","user_code":"ABCD","verification_uri":"https://github.com/login/device","expires_in":120,"interval":5}"#,
                "",
            ),
            ok_json(r#"{"error":"authorization_pending"}"#, ""),
        ]);
        let provider = GithubReleaseProvider::with_api_root(origin).unwrap();
        provider.set_credential(Some("api-secret".into()), GithubAuthSource::CredentialStore);
        assert_eq!(
            provider.auth_status().await.unwrap().login.as_deref(),
            Some("fixture")
        );
        let response = provider
            .device_post("/login/device/code", &[("client_id", "client id")])
            .await
            .unwrap();
        let code: DeviceCodeResponse = parse_bounded_json(response, "fixture code").await.unwrap();
        let now = Instant::now();
        provider.device_sessions.lock().await.insert(
            "fixture".into(),
            DeviceSession {
                client_id: "client id".into(),
                device_code: code.device_code,
                intent: 0,
                created_at: now,
                expires_at: now + Duration::from_secs(60),
                next_poll_at: now,
                interval: Duration::from_secs(5),
            },
        );
        assert_eq!(
            provider.poll_device_login("fixture").await.unwrap().state,
            GithubDeviceLoginState::Pending
        );
        server.join().unwrap();
        let api_request = requests.recv().unwrap().to_ascii_lowercase();
        let agent = format!(
            "\r\nuser-agent: {}",
            PROVIDER_USER_AGENT.to_ascii_lowercase()
        );
        assert!(api_request.starts_with("get /user "));
        assert!(api_request.contains("\r\nauthorization: bearer api-secret\r\n"));
        assert!(api_request.contains("\r\nx-github-api-version: 2022-11-28\r\n"));
        assert!(api_request.contains("\r\ncontent-length: 0\r\n"));
        assert!(api_request.contains(&agent));
        for (path, body) in [
            ("/login/device/code", "client_id=client+id"),
            (
                "/login/oauth/access_token",
                "client_id=client+id&device_code=device%26code&grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code",
            ),
        ] {
            let request = requests.recv().unwrap();
            let (headers, received) = request.split_once("\r\n\r\n").unwrap();
            let headers = headers.to_ascii_lowercase();
            assert!(headers.starts_with(&format!("post {path} ")));
            assert!(headers.contains("\r\naccept: application/json"));
            assert!(headers.contains("\r\ncontent-type: application/x-www-form-urlencoded"));
            let content_length = format!("content-length: {}", body.len());
            assert!(headers.lines().any(|line| line == content_length));
            assert!(!headers.contains("\r\nauthorization:"));
            assert!(!headers.contains("\r\nx-github-api-version:"));
            assert!(headers.contains(&agent));
            assert_eq!(received, body);
        }
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
            uploader_continuity: None,
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
        let mut provider = GithubReleaseProvider::with_api_root(api_root).unwrap();
        // The one-request-per-connection fixture cannot accept a socket
        // abandoned by the client's pooled connection checkout race.
        provider.api_transport = reqwest::Client::builder()
            .no_proxy()
            .pool_max_idle_per_host(0)
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .user_agent(PROVIDER_USER_AGENT)
            .connect_timeout(provider.network_bounds.connect)
            .read_timeout(provider.network_bounds.read_idle)
            .timeout(provider.network_bounds.request)
            .build()
            .unwrap();
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
            .await;
        let second_cached = provider
            .resolve(&second, ReleaseChannel::Stable, Platform::WindowsX86_64)
            .await;
        // Drain the server before unwrapping client outcomes. Otherwise a
        // later request can mask the socket error that shut the fixture down.
        let served = server.join();
        assert!(
            served.is_ok(),
            "fixture failed: {served:?}; requests: {:?}",
            requests.try_iter().collect::<Vec<_>>()
        );

        assert_eq!(first_result.unwrap().asset.name, "game-first-windows.zip");
        assert_eq!(second_result.unwrap().asset.name, "game-second-windows.zip");
        assert_eq!(first_cached.unwrap().asset.name, "game-first-windows.zip");
        assert_eq!(second_cached.unwrap().asset.name, "game-second-windows.zip");
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
        let headers = provider.metadata_headers(url, None, Some(&cached)).unwrap();

        assert_eq!(headers[header::IF_NONE_MATCH], "\"release-etag\"");
        assert_eq!(
            headers[header::IF_MODIFIED_SINCE],
            "Mon, 01 Sep 2026 12:00:00 GMT"
        );
    }

    fn notes_port(repository: &str) -> PortDefinition {
        let mut port = crate::Catalog::embedded()
            .unwrap()
            .port("zelda64-recomp")
            .unwrap()
            .clone();
        port.release.provider = crate::ReleaseSource::Github;
        port.release.repository = repository.into();
        port.release.rolling_tag = None;
        port
    }

    fn notes_release(tag: &str, draft: bool, prerelease: bool, body: &str) -> serde_json::Value {
        serde_json::json!({"id":1,"tag_name":tag,"name":format!("Release {tag}"),
            "draft":draft,"prerelease":prerelease,"published_at":"2026-11-01T00:00:00Z",
            "body":body,"html_url":"javascript:alert(1)","assets":[]})
    }

    fn note_versions(notes: &crate::UpdateReleaseNotes) -> Vec<&str> {
        notes
            .entries
            .iter()
            .map(|entry| entry.version.as_str())
            .collect()
    }

    #[tokio::test]
    async fn update_release_notes_come_from_the_cached_release_list_without_requests() {
        let page = serde_json::json!([
            notes_release(
                "v4",
                false,
                false,
                "Four <!-- hidden -->\r\n<img src=x onerror=alert(1)>"
            ),
            notes_release("v3-rc1", false, true, "candidate"),
            notes_release("v3.5", true, false, "draft"),
            notes_release("v3", false, false, "Three"),
            notes_release("v2", false, false, "installed"),
        ])
        .to_string();
        let (api_root, requests, server) =
            serve_http(vec![ok_json(&page, "ETag: \"releases\"\r\n")]);
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path()).unwrap();
        let provider =
            GithubReleaseProvider::with_api_root_and_library(api_root.clone(), library.clone())
                .unwrap();
        let mut port = notes_port("owner/repo");
        let windows = Platform::WindowsX86_64;

        // Nothing cached: only the release list link is known.
        let unknown = provider
            .cached_release_notes(&port, ReleaseChannel::Stable, windows, Some("v2"), "v4")
            .unwrap();
        assert!(unknown.entries.is_empty());
        assert_eq!(
            unknown.coverage,
            crate::UpdateReleaseNotesCoverage::Unavailable
        );
        assert_eq!(
            unknown.releases_url,
            Some(format!("{api_root}/owner/repo/releases"))
        );

        // Release resolution persists the list; notes then read it offline.
        provider
            .releases(&format!("{api_root}/repos/owner/repo"))
            .await
            .unwrap();
        server.join().unwrap();
        assert_eq!(requests.try_iter().count(), 1);
        let notes = provider
            .cached_release_notes(&port, ReleaseChannel::Stable, windows, Some("v2"), "v4")
            .unwrap();
        assert_eq!(notes.coverage, crate::UpdateReleaseNotesCoverage::Complete);
        assert_eq!(note_versions(&notes), ["v4", "v3"]);
        assert_eq!(notes.entries[0].notes, "Four\n<img src=x onerror=alert(1)>");
        assert_eq!(notes.entries[0].title.as_deref(), Some("Release v4"));
        // GitHub release pages sit under the list's `tag/` path.
        assert_eq!(
            notes.entries[0].url,
            Some(format!("{api_root}/owner/repo/releases/tag/v4"))
        );
        let beta = provider
            .cached_release_notes(&port, ReleaseChannel::Beta, windows, Some("v2"), "v4")
            .unwrap();
        assert_eq!(beta.entries.len(), 3);
        let missing = provider
            .cached_release_notes(&port, ReleaseChannel::Stable, windows, Some("v2"), "v5")
            .unwrap();
        assert!(missing.entries.is_empty());
        port.release.provider = crate::ReleaseSource::Gitlab;
        assert!(
            provider
                .cached_release_notes(&port, ReleaseChannel::Stable, windows, Some("v2"), "v4")
                .is_none()
        );
    }

    #[test]
    fn update_release_notes_skip_releases_outside_this_platform_stream() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path()).unwrap();
        let api_root = "https://api.example.test";
        let provider =
            GithubReleaseProvider::with_api_root_and_library(api_root, library.clone()).unwrap();
        let mut port = notes_port("owner/repo");
        port.adapter = AdapterKind::NativePortable;
        port.archive_data_compatibility_v1 = None;
        port.release.curated.clear();
        let with_assets = |tag: &str, asset: &str| {
            let mut release = notes_release(tag, false, false, tag);
            release["assets"] = serde_json::json!([{"id":1,"name":asset,
                "browser_download_url":format!("https://example.test/{asset}"),"size":1,"digest":null}]);
            release
        };
        let page = serde_json::json!([
            with_assets("v4", "game-windows-x64.zip"),
            with_assets("v3-linux", "game-linux-x86_64.tar.gz"),
            with_assets("portmaster-v3", "game-portmaster.zip"),
            with_assets("v3", "game-windows-x64.zip"),
            with_assets("v2", "game-windows-x64.zip"),
        ]);
        let url = paginated_url(
            &format!("{api_root}/repos/owner/repo"),
            "releases",
            1,
            PROVIDER_PAGE_SIZE,
        )
        .unwrap();
        library
            .store_http_cache(&url, Some("\"page\""), None, &page.to_string())
            .unwrap();
        let notes = provider
            .cached_release_notes(
                &port,
                ReleaseChannel::Stable,
                Platform::WindowsX86_64,
                Some("v2"),
                "v4",
            )
            .unwrap();
        assert_eq!(note_versions(&notes), ["v4", "v3"]);
        assert_eq!(notes.coverage, crate::UpdateReleaseNotesCoverage::Complete);
    }

    #[test]
    fn preview_skips_a_newer_portmaster_only_prerelease_for_the_desktop_release() {
        // Vurus publishes PortMaster-only prereleases after its desktop build;
        // the desktop -beta tag is not flagged as a provider prerelease.
        let port = crate::Catalog::embedded()
            .unwrap()
            .port("vyruz-destruction-of-the-untel-empire-vurus")
            .unwrap()
            .clone();
        let release = |tag: &str, prerelease: bool, names: &[&str]| -> GithubRelease {
            let assets = names
                .iter()
                .enumerate()
                .map(|(index, name)| {
                    serde_json::json!({"id": index, "name": name, "size": 1, "digest": null,
                        "browser_download_url": format!("https://example.test/{tag}/{name}")})
                })
                .collect::<Vec<_>>();
            serde_json::from_value(serde_json::json!({"id": 1, "tag_name": tag,
                "draft": false, "prerelease": prerelease,
                "published_at": "2026-11-01T00:00:00Z", "assets": assets}))
            .unwrap()
        };
        let desktop = [
            "vurus-windows-amd64.zip",
            "vurus-linux.tar.gz",
            "vurus-darwin-arm64.zip",
            "vurus-darwin-x86_64.zip",
            "SHA256SUMS.txt",
        ];
        let releases = [
            release(
                "portmaster-v202611071731-beta",
                true,
                &["vurus-portmaster.zip", "SHA256SUMS.txt"],
            ),
            release("v202610242327-beta", false, &desktop),
            release("v0.1.7", false, &desktop),
        ];
        for platform in [
            Platform::WindowsX86_64,
            Platform::LinuxX86_64,
            Platform::MacosX86_64,
            Platform::MacosAarch64,
        ] {
            let selected = select_channel_candidate(
                &releases,
                ReleaseChannel::Beta,
                None,
                |release| {
                    !release.draft && native_release_applies_to_platform(&port, platform, release)
                },
                is_beta_release,
                |release| release.tag_name.as_str(),
            )
            .unwrap();
            assert_eq!(selected.tag_name, "v202610242327-beta", "{platform:?}");
        }
    }

    #[test]
    fn update_release_notes_never_join_pages_from_different_observations() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path()).unwrap();
        let api_root = "https://api.example.test";
        let provider =
            GithubReleaseProvider::with_api_root_and_library(api_root, library.clone()).unwrap();
        let port = notes_port("owner/repo");
        let repository_url = format!("{api_root}/repos/owner/repo");
        let page_url =
            |page| paginated_url(&repository_url, "releases", page, PROVIDER_PAGE_SIZE).unwrap();
        let first = (0..PROVIDER_PAGE_SIZE)
            .map(|index| notes_release(&format!("v{}", 200 - index), false, false, ""))
            .collect::<Vec<_>>();
        // The stale second page repeats a tag and lacks the releases that moved.
        let second = serde_json::json!([
            notes_release("v101", false, false, "stale"),
            notes_release("v50", false, false, "installed"),
        ]);
        library
            .store_http_cache(
                &page_url(1),
                Some("\"1\""),
                None,
                &serde_json::json!(first).to_string(),
            )
            .unwrap();
        library
            .store_http_cache(&page_url(2), Some("\"2\""), None, &second.to_string())
            .unwrap();
        let request = |provider: &GithubReleaseProvider| {
            provider
                .cached_release_notes(
                    &port,
                    ReleaseChannel::Stable,
                    Platform::WindowsX86_64,
                    Some("v50"),
                    "v200",
                )
                .unwrap()
        };
        // Pages confirmed together are one list; the bound applies.
        let together = request(&provider);
        assert_eq!(together.entries.len(), crate::release_notes::MAX_RELEASES);
        assert_eq!(
            together.coverage,
            crate::UpdateReleaseNotesCoverage::Shortened
        );
        // A second page confirmed long before the first is not joined to it.
        library
            .connection()
            .unwrap()
            .execute(
                "UPDATE github_http_cache SET updated_at=updated_at-?1 WHERE url=?2",
                rusqlite::params![crate::release_notes::PAGE_SKEW_SECONDS + 60, page_url(2)],
            )
            .unwrap();
        let installed_older = provider
            .cached_release_notes(
                &port,
                ReleaseChannel::Stable,
                Platform::WindowsX86_64,
                Some("v50"),
                "v105",
            )
            .unwrap();
        assert_eq!(
            installed_older.coverage,
            crate::UpdateReleaseNotesCoverage::InstalledNotListed
        );
        assert!(
            installed_older
                .entries
                .iter()
                .all(|entry| entry.notes != "stale")
        );
        assert_ne!(
            request(&provider).coverage,
            crate::UpdateReleaseNotesCoverage::Complete
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
            id: None,
            name: "game-windows.zip".into(),
            browser_download_url: "https://downloads.example.invalid/game.zip".into(),
            size: 1,
            digest: None,
            uploader: Default::default(),
            created_at: None,
        };
        let sidecar = GithubAsset {
            id: None,
            name: "game-windows.zip.sha256".into(),
            browser_download_url: format!("{download_root}/game.sha256"),
            size: 1,
            digest: None,
            uploader: Default::default(),
            created_at: None,
        };
        let error = provider
            .checksum_from_sidecar(&[target.clone(), sidecar], &target)
            .await
            .unwrap_err();
        server.join().unwrap();
        assert_eq!(error.code, crate::ErrorCode::Verification);
        assert!(error.message.contains("1048576 byte limit"));
    }

    #[tokio::test]
    async fn github_caps_chunked_metadata_before_parsing_or_caching() {
        let mut response = format!(
            "HTTP/1.1 200 OK\r\nETag: \"fixture\"\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{PROVIDER_JSON_MAX_BYTES:x}\r\n"
        )
        .into_bytes();
        response.resize(response.len() + PROVIDER_JSON_MAX_BYTES, b' ');
        response.extend_from_slice(b"\r\n1\r\nx\r\n0\r\n\r\n");
        let (root, _, server) = serve_http_bytes(vec![response]);
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path()).unwrap();
        let provider =
            GithubReleaseProvider::with_api_root_and_library(root.clone(), library).unwrap();
        let url = format!("{root}/metadata");
        let error = provider
            .get_json::<serde_json::Value>(&url)
            .await
            .unwrap_err();
        server.join().unwrap();
        assert_eq!(error.code, crate::ErrorCode::Verification);
        assert!(error.message.contains("4194304 byte limit"));
        assert!(provider.cached_http_response(&url).is_none());
    }

    #[tokio::test]
    async fn dropping_github_metadata_body_closes_the_incomplete_response() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let root = format!("http://{}", listener.local_addr().unwrap());
        let peer = tokio::spawn(async move {
            tokio::time::timeout(Duration::from_secs(3), async {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut buffer = [0; 4096];
                assert!(stream.read(&mut buffer).await.unwrap() > 0);
                stream
                    .write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\n{\r\n")
                    .await
                    .unwrap();
                match stream.read(&mut buffer).await {
                    Ok(0) => {}
                    Err(error)
                        if matches!(
                            error.kind(),
                            std::io::ErrorKind::ConnectionReset
                                | std::io::ErrorKind::ConnectionAborted
                        ) => {}
                    result => panic!("incomplete metadata connection remained active: {result:?}"),
                }
            })
            .await
            .unwrap();
        });
        let provider = GithubReleaseProvider::with_api_root(&root).unwrap();
        let mut response = provider
            .metadata_request(&format!("{root}/metadata"), None, None)
            .await
            .unwrap();
        assert_eq!(response.chunk().await.unwrap().unwrap().as_ref(), b"{");
        drop(response);
        peer.await.unwrap();
    }

    #[test]
    fn equally_scored_github_assets_are_ambiguous() {
        let catalog = crate::Catalog::embedded().unwrap();
        let port = catalog.port("re-blue").unwrap();
        let assets = [
            GithubAsset {
                id: None,
                name: "reblue-windows-one.zip".into(),
                browser_download_url: "https://example.invalid/one.zip".into(),
                size: 1,
                digest: None,
                uploader: Default::default(),
                created_at: None,
            },
            GithubAsset {
                id: None,
                name: "reblue-windows-two.zip".into(),
                browser_download_url: "https://example.invalid/two.zip".into(),
                size: 1,
                digest: None,
                uploader: Default::default(),
                created_at: None,
            },
        ];
        let error = choose_asset(port, Platform::WindowsX86_64, &assets).unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Conflict);
        assert!(error.message.contains("equally qualified"));
    }

    #[test]
    fn native_mac_bundle_tar_xz_selects_reflectionhle_for_all_siblings() {
        let catalog = crate::Catalog::embedded().unwrap();
        let ports: Vec<_> = catalog
            .ports()
            .iter()
            .filter(|port| port.release.repository == "ReflectionHLE/ReflectionHLE")
            .collect();
        assert_eq!(ports.len(), 9);
        let asset = |name: &str| GithubAsset {
            id: None,
            name: name.into(),
            browser_download_url: format!("https://example.invalid/{name}"),
            size: 1,
            digest: None,
            uploader: Default::default(),
            created_at: None,
        };
        let excluded = [
            asset("reflectionhle-macos-universal2-next.zip"),
            asset("reflectionhle-macos-arm64-next.tar.xz"),
            asset("reflectionhle-linux-x86_64-next.tar.xz"),
        ];
        for port in ports {
            for platform in [Platform::MacosX86_64, Platform::MacosAarch64] {
                assert!(choose_asset(port, platform, &excluded).is_err());
                for package in [
                    "reflectionhle-macos-universal2-20260606.tar.xz",
                    "reflectionhle-macos-universal2-next.tar.xz",
                ] {
                    let mut assets = excluded.to_vec();
                    assets.push(asset(package));
                    assert_eq!(choose_asset(port, platform, &assets).unwrap().name, package);
                }
            }
        }
    }

    #[test]
    fn generated_cache_mac_tar_xz_refuses_a_successor_without_the_declared_package() {
        let catalog = crate::Catalog::embedded().unwrap();
        let port = catalog.port("perfect-dark").unwrap();
        let asset = |name: &str| GithubAsset {
            id: None,
            name: name.into(),
            browser_download_url: format!("https://example.invalid/{name}"),
            size: 1,
            digest: None,
            uploader: Default::default(),
            created_at: None,
        };
        for (platform, selected, other) in [
            (
                Platform::MacosX86_64,
                "pd-x86_64-osx.tar.xz",
                "pd-arm64-osx.tar.xz",
            ),
            (
                Platform::MacosAarch64,
                "pd-arm64-osx.tar.xz",
                "pd-x86_64-osx.tar.xz",
            ),
        ] {
            let incompatible = [asset(other), asset("pd-osx.tar.xz"), asset("pd-osx.zip")];
            assert!(choose_asset(port, platform, &incompatible).is_err());
            assert_eq!(
                choose_asset(port, platform, &[asset(selected)])
                    .unwrap()
                    .name,
                selected
            );
        }
    }

    #[test]
    fn native_portable_replacement_requires_the_same_native_package_variant() {
        let catalog = crate::Catalog::embedded().unwrap();
        let mut port = catalog.port("fragglet-sdl-sopwith").unwrap().clone();
        port.release
            .asset_hints
            .insert(Platform::WindowsX86_64, vec!["game".into()]);
        let asset = |name: &str| GithubAsset {
            id: None,
            name: name.into(),
            browser_download_url: "https://example.invalid/package.zip".into(),
            size: 1,
            digest: None,
            uploader: Default::default(),
            created_at: None,
        };
        for name in [
            "game-win32.zip",
            "game-windows-32bit.zip",
            "game-windows-32-bit.zip",
            "game-windows-x32.zip",
            "game-windows-armv6.zip",
            "game-windows-x86.zip",
            "game-linux-x64.zip",
            "game-macos-universal.zip",
            "game-windows-arm64.zip",
            "game-windows-x64-debug.zip",
            "game-source.zip",
            "unknown.zip",
        ] {
            assert!(
                choose_asset(&port, Platform::WindowsX86_64, &[asset(name)]).is_err(),
                "{name}"
            );
        }
        let candidates = [
            asset("game-windows-x64.zip"),
            asset("game-hd-windows-x64.zip"),
        ];
        assert!(choose_asset(&port, Platform::WindowsX86_64, &candidates).is_err());
        port.release
            .asset_hints
            .insert(Platform::WindowsX86_64, vec!["game-hd".into()]);
        assert_eq!(
            choose_asset(&port, Platform::WindowsX86_64, &candidates)
                .unwrap()
                .name,
            "game-hd-windows-x64.zip"
        );
        assert!(choose_asset(&port, Platform::WindowsX86_64, &candidates[..1]).is_err());
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
            id: None,
            name: "game-windows.zip".into(),
            browser_download_url: "https://downloads.example.invalid/game.zip".into(),
            size: 1,
            digest: None,
            uploader: Default::default(),
            created_at: None,
        };
        let aggregate = GithubAsset {
            id: None,
            name: "SHA256SUMS.txt".into(),
            browser_download_url: format!("{download_root}/aggregate"),
            size: 1,
            digest: None,
            uploader: Default::default(),
            created_at: None,
        };
        assert!(
            provider
                .checksum_from_sidecar(&[target.clone(), aggregate], &target)
                .await
                .unwrap()
                .is_none()
        );
        let aggregate = GithubAsset {
            id: None,
            name: "SHA256SUMS.txt".into(),
            browser_download_url: format!("{download_root}/aggregate-named"),
            size: 1,
            digest: None,
            uploader: Default::default(),
            created_at: None,
        };
        assert_eq!(
            provider
                .checksum_from_sidecar(&[target.clone(), aggregate], &target)
                .await
                .unwrap(),
            Some(digest.clone())
        );
        let exact = GithubAsset {
            id: None,
            name: "game-windows.zip.sha256".into(),
            browser_download_url: format!("{download_root}/exact"),
            size: 1,
            digest: None,
            uploader: Default::default(),
            created_at: None,
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
        assert_eq!(
            error.presentation().presentation_key,
            "provider_rate_limited"
        );
        assert!(error.presentation().summary.contains("GitHub"));
        assert!(
            error
                .presentation()
                .summary
                .contains("1970-01-01T00:20:34Z")
        );
    }

    /// Releases whose assets the project's own automation uploaded, so uploader
    /// continuity is decided without reading older history.
    fn attributed(mut release: serde_json::Value) -> serde_json::Value {
        release["assets"][0]["uploader"] =
            serde_json::json!({"id": 41_898_282, "login": "github-actions[bot]", "type": "Bot"});
        release
    }

    fn release_page(first: usize, count: usize, draft: bool) -> String {
        let page = (first..first + count)
            .map(|index| {
                attributed(github_release(
                    &format!("v{index}.0.0"),
                    draft,
                    "game-windows.zip",
                ))
            })
            .collect::<Vec<_>>();
        ok_json(&serde_json::to_string(&page).unwrap(), "")
    }

    #[tokio::test]
    async fn github_release_history_is_not_capped_at_one_thousand_releases() {
        let mut responses = (0..GITHUB_MAX_RELEASE_PAGES)
            .map(|page| release_page(page * PROVIDER_PAGE_SIZE, PROVIDER_PAGE_SIZE, true))
            .collect::<Vec<_>>();
        responses.push(release_page(1_000, 1, false));
        let (api_root, requests, server) = serve_http(responses);
        let provider = GithubReleaseProvider::with_api_root(api_root.clone()).unwrap();
        let releases = provider
            .releases(&format!("{api_root}/repos/example/project"))
            .await
            .unwrap();
        server.join().unwrap();
        assert_eq!(releases.len(), 1_001);
        assert_eq!(releases[1_000].tag_name, "v1000.0.0");
        let requests = requests.try_iter().collect::<Vec<_>>();
        assert_eq!(requests.len(), GITHUB_MAX_RELEASE_PAGES + 1);
        assert!(requests[GITHUB_MAX_RELEASE_PAGES].contains("page=11"));
    }

    #[tokio::test]
    async fn github_resolution_reads_only_the_history_its_selection_needs() {
        let catalog = crate::Catalog::embedded().unwrap();
        let port = catalog.port("re-blue").unwrap();
        // A full first page would continue, but its newest release already
        // answers first-match channel selection.
        let responses = vec![
            ok_json(r#"{"archived":false}"#, ""),
            release_page(1, PROVIDER_PAGE_SIZE, false),
        ];
        let (api_root, requests, server) = serve_http(responses);
        let provider = GithubReleaseProvider::with_api_root(api_root).unwrap();
        let resolved = provider
            .resolve(port, ReleaseChannel::Stable, Platform::WindowsX86_64)
            .await
            .unwrap();
        server.join().unwrap();
        assert_eq!(resolved.version, "v1.0.0");
        assert_eq!(requests.try_iter().count(), 2);
    }

    #[tokio::test]
    async fn github_resolution_finds_a_candidate_after_one_thousand_releases() {
        let catalog = crate::Catalog::embedded().unwrap();
        let port = catalog.port("re-blue").unwrap();
        let mut responses = vec![ok_json(r#"{"archived":false}"#, "")];
        responses.extend(
            (0..GITHUB_MAX_RELEASE_PAGES)
                .map(|page| release_page(page * PROVIDER_PAGE_SIZE, PROVIDER_PAGE_SIZE, true)),
        );
        responses.push(release_page(1_000, 1, false));
        let (api_root, requests, server) = serve_http(responses);
        let provider = GithubReleaseProvider::with_api_root(api_root).unwrap();
        let resolved = provider
            .resolve(port, ReleaseChannel::Stable, Platform::WindowsX86_64)
            .await
            .unwrap();
        server.join().unwrap();
        assert_eq!(resolved.version, "v1000.0.0");
        assert_eq!(requests.try_iter().count(), GITHUB_MAX_RELEASE_PAGES + 2);
    }

    #[tokio::test]
    async fn github_beta_reads_past_a_full_stable_page_for_an_older_prerelease() {
        let catalog = crate::Catalog::embedded().unwrap();
        let mut port = catalog.port("re-blue").unwrap().clone();
        port.channels.push(ReleaseChannel::Beta);
        let port = &port;
        let mut prerelease = attributed(github_release("v0.9.0-beta", false, "game-windows.zip"));
        prerelease["prerelease"] = serde_json::Value::Bool(true);
        let responses = vec![
            ok_json(r#"{"archived":false}"#, ""),
            release_page(1, PROVIDER_PAGE_SIZE, false),
            ok_json(&serde_json::to_string(&vec![prerelease]).unwrap(), ""),
        ];
        let (api_root, requests, server) = serve_http(responses);
        let provider = GithubReleaseProvider::with_api_root(api_root).unwrap();
        let resolved = provider
            .resolve(port, ReleaseChannel::Beta, Platform::WindowsX86_64)
            .await
            .unwrap();
        server.join().unwrap();
        assert_eq!(resolved.version, "v0.9.0-beta");
        assert_eq!(requests.try_iter().count(), 3);
    }

    #[tokio::test]
    async fn github_release_history_budget_exhaustion_is_incomplete_not_absent() {
        let (api_root, _requests, server) = serve_http(vec![]);
        let provider = GithubReleaseProvider::with_api_root(api_root.clone()).unwrap();
        let mut inventory =
            provider.release_inventory(&format!("{api_root}/repos/example/project"));
        inventory.deadline = tokio::time::Instant::now();
        let error = provider
            .extend_release_inventory(&mut inventory, None)
            .await
            .unwrap_err();
        server.join().unwrap();
        assert!(inventory.releases.is_empty());
        assert_eq!(error.code, crate::ErrorCode::Network);
        assert_eq!(
            error.details.get("release_inventory").map(String::as_str),
            Some("incomplete")
        );
    }

    #[tokio::test]
    async fn github_archived_upstream_keeps_exact_release_usable_but_metadata_failure_still_holds()
    {
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
        let cached = provider
            .resolve(port, ReleaseChannel::Stable, Platform::WindowsX86_64)
            .await
            .unwrap();
        server.join().unwrap();
        assert_eq!(cached.asset.sha256, "a".repeat(64));
        assert_eq!(requests.try_iter().count(), 3);

        let responses = vec![
            ok_json(r#"{"archived":true}"#, ""),
            ok_json(&release_body, ""),
        ];
        let (api_root, _, server) = serve_http(responses);
        let provider = GithubReleaseProvider::with_api_root(api_root).unwrap();
        let archived = provider
            .resolve(port, ReleaseChannel::Stable, Platform::WindowsX86_64)
            .await
            .unwrap();
        server.join().unwrap();
        assert_eq!(archived.asset.sha256, "a".repeat(64));

        let mut missing_digest = github_release("v1.0.0", false, "game-windows.zip");
        missing_digest["assets"][0]["digest"] = serde_json::Value::Null;
        let missing_digest_body = serde_json::to_string(&vec![missing_digest]).unwrap();
        let responses = vec![
            ok_json(r#"{"archived":true}"#, ""),
            ok_json(&missing_digest_body, ""),
        ];
        let (api_root, _, server) = serve_http(responses);
        let provider = GithubReleaseProvider::with_api_root(api_root).unwrap();
        let error = provider
            .resolve(port, ReleaseChannel::Stable, Platform::WindowsX86_64)
            .await
            .unwrap_err();
        server.join().unwrap();
        assert_eq!(error.code, crate::ErrorCode::Verification);

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
            id: None,
            name: "game-windows.zip".into(),
            browser_download_url: "https://example.invalid/game-windows.zip".into(),
            size: 1,
            digest: None,
            uploader: Default::default(),
            created_at: None,
        };
        let assets = names
            .iter()
            .enumerate()
            .map(|(index, name)| GithubAsset {
                id: None,
                name: (*name).into(),
                browser_download_url: format!("{root}/{index}"),
                size: 1,
                digest: None,
                uploader: Default::default(),
                created_at: None,
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

    /// Counts what one check of a library actually asks of `api.github.com`, using the real
    /// provider and its persisted ETag cache against a fake API that answers 304 when the
    /// conditional header matches. GitHub does not count a 304 against the primary limit,
    /// so only the 200 responses are "counted" requests. Results are recorded in
    /// `docs/ARCHITECTURE.md` (anonymous update-check request cost).
    #[tokio::test]
    async fn measure_the_request_cost_of_checking_a_library() {
        use std::sync::{Arc, Mutex};
        #[derive(Clone, Copy, Default, Debug, PartialEq, Eq)]
        struct Cost {
            requests: usize,
            releases_pages: usize,
            counted: usize,
            not_modified: usize,
        }
        // Cost is exactly linear (a 50-game library was measured once at 100 requests), so two
        // sizes pin the pattern without approaching the hosted harness budget.
        for ports in [10_usize, 25] {
            let releases = github_selector_releases();
            let log: Arc<Mutex<Vec<(String, u16)>>> = Arc::default();
            let changed: Arc<Mutex<Option<String>>> = Arc::default();
            let handler_log = Arc::clone(&log);
            let handler_changed = Arc::clone(&changed);
            // 150 sequential requests with SQLite writes can outlast the 30s default accept
            // budget on a slow hosted runner, so allow the finite maximum-friendly 180s.
            let (api_root, _requests, server) = crate::test_http::serve_routed_http_with_budget(
                100_000,
                std::time::Duration::from_secs(180),
                move |request| {
                    let path = request
                        .lines()
                        .next()
                        .and_then(|line| line.split_whitespace().nth(1))
                        .unwrap_or("")
                        .to_owned();
                    // The ETag is derived from the resource, plus a revision once a repository changes.
                    let revision = handler_changed
                        .lock()
                        .unwrap()
                        .as_ref()
                        .filter(|repository| {
                            // Exact repository match: `repo-1` must not also match `repo-10`.
                            path == format!("/repos/{repository}")
                                || path.starts_with(&format!("/repos/{repository}/"))
                        })
                        .map_or(0, |_| 1);
                    let etag = format!(
                        "\"etag-{revision}-{}\"",
                        path.replace(['/', '?', '=', '&'], "_")
                    );
                    let lowered = request.to_ascii_lowercase();
                    let conditional =
                        lowered.contains(&format!("if-none-match: {}", etag.to_ascii_lowercase()));
                    let status = if conditional { 304 } else { 200 };
                    handler_log.lock().unwrap().push((path.clone(), status));
                    if conditional {
                        return format!(
                            "HTTP/1.1 304 Not Modified\r\nETag: {etag}\r\nConnection: close\r\n\r\n"
                        );
                    }
                    let body = if path.contains("/releases?") {
                        releases.clone()
                    } else {
                        r#"{"archived":false}"#.to_owned()
                    };
                    ok_json(&body, &format!("ETag: {etag}\r\n"))
                },
            );
            let temporary = tempfile::tempdir().unwrap();
            let library = Library::open(temporary.path()).unwrap();
            let catalog = crate::Catalog::embedded().unwrap();
            let template = catalog.port("re-blue").unwrap().clone();
            let library_ports = (0..ports)
                .map(|index| {
                    let mut port = template.clone();
                    port.id = format!("measured-{index}");
                    port.release.repository = format!("owner/repo-{index}");
                    port.release.asset_hints.insert(
                        Platform::WindowsX86_64,
                        vec!["first".into(), "windows".into()],
                    );
                    port
                })
                .collect::<Vec<_>>();
            let measure = |before: usize| {
                let entries = log.lock().unwrap();
                let slice = &entries[before..];
                Cost {
                    requests: slice.len(),
                    releases_pages: slice
                        .iter()
                        .filter(|(path, _)| path.contains("/releases?"))
                        .count(),
                    counted: slice.iter().filter(|(_, status)| *status == 200).count(),
                    not_modified: slice.iter().filter(|(_, status)| *status == 304).count(),
                }
            };
            // A fresh provider per pass is a Portcove restart: only the persisted cache survives.
            let check_all = || async {
                let provider = GithubReleaseProvider::with_api_root_and_library(
                    api_root.clone(),
                    library.clone(),
                )
                .unwrap();
                for port in &library_ports {
                    provider
                        .resolve(port, ReleaseChannel::Stable, Platform::WindowsX86_64)
                        .await
                        .unwrap();
                }
            };
            let cold = {
                let before = log.lock().unwrap().len();
                check_all().await;
                measure(before)
            };
            let warm = {
                let before = log.lock().unwrap().len();
                check_all().await;
                measure(before)
            };
            let one_changed = {
                *changed.lock().unwrap() = Some("owner/repo-0".into());
                let before = log.lock().unwrap().len();
                check_all().await;
                measure(before)
            };
            server.join().unwrap();
            // Each game costs two requests: one `releases` page and one repository-metadata call.
            assert_eq!(
                cold,
                Cost {
                    requests: 2 * ports,
                    releases_pages: ports,
                    counted: 2 * ports,
                    not_modified: 0
                },
                "a cold check counts every request against the provider limit ({ports} games)"
            );
            // After a restart the persisted ETags answer everything with 304, which is not counted.
            assert_eq!(
                warm,
                Cost {
                    requests: 2 * ports,
                    releases_pages: ports,
                    counted: 0,
                    not_modified: 2 * ports
                },
                "a warm check counts nothing ({ports} games)"
            );
            // A changed repository is re-fetched in full: its two requests count, the rest stay free.
            assert_eq!(
                one_changed,
                Cost {
                    requests: 2 * ports,
                    releases_pages: ports,
                    counted: 2,
                    not_modified: 2 * ports - 2
                },
                "one changed repository counts two requests ({ports} games)"
            );
        }
    }

    #[test]
    fn cost_forecast_counts_only_what_is_uncached_and_never_relieves_a_managed_scope() {
        let forecast = |scoped, curated, repository, releases| {
            let value = github_cost_forecast(scoped, curated, repository, releases);
            (value.counted_requests, value.sign_in_relief_requests)
        };
        // Ordinary path: a cached resource answers 304, which is not counted, and a token helps.
        assert_eq!(forecast(false, false, false, false), (2, 2));
        assert_eq!(forecast(false, false, true, false), (1, 1));
        assert_eq!(forecast(false, false, false, true), (1, 1));
        assert_eq!(forecast(false, false, true, true), (0, 0));
        // A managed scope is unconditional and unauthenticated: it always counts, a cache
        // changes nothing, and signing in never raises its limit. Curated adds a tag lookup.
        assert_eq!(forecast(true, false, true, true), (2, 0));
        assert_eq!(forecast(true, false, false, false), (2, 0));
        assert_eq!(forecast(true, true, true, true), (3, 0));
    }

    #[tokio::test]
    async fn the_provider_forecast_reads_the_persisted_cache_without_any_network_call() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path()).unwrap();
        // An unreachable origin proves the forecast never touches the network.
        let provider = GithubReleaseProvider::with_api_root_and_library(
            "https://example.invalid",
            library.clone(),
        )
        .unwrap();
        let catalog = crate::Catalog::embedded().unwrap();
        let mut port = catalog.port("re-blue").unwrap().clone();
        port.release.repository = "owner/forecast".into();
        let platform = Platform::WindowsX86_64;
        let cost = |provider: &GithubReleaseProvider, port: &PortDefinition, scoped| {
            let provider = provider.clone();
            let port = port.clone();
            async move {
                provider
                    .forecast_request_cost(&port, platform, scoped)
                    .await
                    .unwrap()
            }
        };
        assert_eq!(cost(&provider, &port, false).await.counted_requests, 2);
        let repository = "https://example.invalid/repos/owner/forecast";
        let releases = paginated_url(repository, "releases", 1, PROVIDER_PAGE_SIZE).unwrap();
        library
            .store_http_cache(repository, Some("\"r\""), None, "{}")
            .unwrap();
        assert_eq!(cost(&provider, &port, false).await.counted_requests, 1);
        library
            .store_http_cache(&releases, Some("\"p\""), None, "[]")
            .unwrap();
        assert_eq!(
            cost(&provider, &port, false).await,
            crate::RequestCostForecast::default()
        );
        // A cached body with no validator is sent unconditionally, so it saves nothing.
        library
            .store_http_cache(repository, None, None, "{}")
            .unwrap();
        assert_eq!(cost(&provider, &port, false).await.counted_requests, 1);
        library
            .store_http_cache(repository, Some("\"r\""), None, "{}")
            .unwrap();
        // The same warm cache does not help a managed-scope port.
        assert_eq!(
            cost(&provider, &port, true).await,
            crate::RequestCostForecast {
                counted_requests: 2,
                sign_in_relief_requests: 0
            }
        );
        // A provider other than GitHub has no GitHub allowance to protect.
        port.release.provider = crate::ReleaseSource::Gitlab;
        assert_eq!(
            cost(&provider, &port, false).await,
            crate::RequestCostForecast::default()
        );
    }

    #[tokio::test]
    async fn the_service_forecast_adds_up_a_cold_library_and_a_warm_one() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path()).unwrap();
        let provider = GithubReleaseProvider::with_api_root_and_library(
            "https://example.invalid",
            library.clone(),
        )
        .unwrap();
        let service =
            crate::PortcoveService::with_provider(library.clone(), Arc::new(provider)).unwrap();
        let platform = Platform::current().unwrap();
        let ports = crate::Catalog::embedded()
            .unwrap()
            .ports()
            .iter()
            .filter(|port| {
                port.release.provider == crate::ReleaseSource::Github
                    && !port.release.repository.is_empty()
                    && port.platforms.contains(&platform)
            })
            .take(6)
            .map(|port| (port.id.clone(), port.release.repository.clone()))
            .collect::<Vec<_>>();
        assert_eq!(ports.len(), 6, "the embedded catalog has GitHub ports");
        let ids = || ports.iter().map(|(id, _)| id.clone());
        let cold = service.forecast_update_checks(ids()).await.unwrap();
        assert_eq!(cold.games, 6);
        assert_eq!(cold.counted_requests, 12);
        assert_eq!(cold.sign_in_relief_requests, 12);
        for (_, repository) in &ports {
            let url = format!("https://example.invalid/repos/{repository}");
            let releases = paginated_url(&url, "releases", 1, PROVIDER_PAGE_SIZE).unwrap();
            library
                .store_http_cache(&url, Some("\"r\""), None, "{}")
                .unwrap();
            library
                .store_http_cache(&releases, Some("\"p\""), None, "[]")
                .unwrap();
        }
        let warm = service.forecast_update_checks(ids()).await.unwrap();
        assert_eq!(warm.games, 6);
        assert_eq!(warm.counted_requests, 0);
        assert!(
            !warm.sign_in_would_help(0),
            "nothing counted, nothing to relieve"
        );
    }

    #[test]
    fn sign_in_is_offered_only_when_the_allowance_falls_short_and_it_would_help() {
        let forecast = |counted, relief| crate::UpdateCheckForecast {
            games: 10,
            counted_requests: counted,
            sign_in_relief_requests: relief,
        };
        // 40 counted against 60 left fits; 40 against 30 left does not.
        assert!(!forecast(40, 40).sign_in_would_help(60));
        assert!(forecast(40, 40).sign_in_would_help(30));
        // Exactly the allowance still fits.
        assert!(!forecast(60, 60).sign_in_would_help(60));
        // Managed-scope ports are counted but signing in cannot relieve them.
        assert!(!forecast(60, 0).sign_in_would_help(5));
        // A mix offers sign-in because part of the cost can be relieved.
        assert!(forecast(60, 20).sign_in_would_help(30));
    }
}
