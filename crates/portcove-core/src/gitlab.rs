use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::{Duration, Instant},
};

use async_trait::async_trait;
use futures_util::{StreamExt, stream};
use reqwest::{StatusCode, header};
use serde::{Deserialize, de::DeserializeOwned};
use tokio::sync::RwLock;

mod catalog_download;

use crate::{
    ExactReleaseSelection, Library, Platform, PortDefinition, PortcoveError, ReleaseAsset,
    ReleaseChannel, ReleaseProvider, ReleaseSource, ResolvedRelease, Result,
    library::HttpCacheEntry,
    release::{
        ExactReleaseQuery, PROVIDER_JSON_MAX_BYTES, PROVIDER_NETWORK_BOUNDS, ProviderNetworkBounds,
        RELEASE_CACHE_MAX_ENTRIES, ReleaseSelectionCacheKey, bounded_response_bytes, paginated_url,
    },
};

#[derive(Clone)]
pub struct GitlabReleaseProvider {
    client: reqwest::Client,
    api_root: String,
    network_bounds: ProviderNetworkBounds,
    library: Option<Library>,
    cache: Arc<RwLock<HashMap<ReleaseSelectionCacheKey, CachedRelease>>>,
}

#[derive(Debug, Clone)]
struct CachedRelease {
    stored_at: Instant,
    release: ResolvedRelease,
}

const RELEASE_CACHE_TTL: Duration = Duration::from_secs(5 * 60);
/// GitLab's documented maximum `per_page` for offset pagination.
const PROVIDER_PAGE_SIZE: usize = 100;
/// Package-file listings read at once for one release; bounds parallel requests,
/// not how many matching packages a release may have.
const GITLAB_PACKAGE_LOOKUP_CONCURRENCY: usize = 4;

/// One GitLab list read page by page. Every list an operation reads shares the
/// operation's deadline, so the work is bounded by time rather than by a count
/// of releases, packages or files. Running out of that budget is reported as an
/// incomplete inventory and never as an absent release, package or file.
struct GitlabPages {
    label: &'static str,
    next_page: Option<usize>,
    deadline: tokio::time::Instant,
}

impl GitlabPages {
    fn new(label: &'static str, deadline: tokio::time::Instant) -> Self {
        Self {
            label,
            next_page: Some(1),
            deadline,
        }
    }

    fn incomplete(&self, pages_read: usize) -> PortcoveError {
        PortcoveError::network(format!(
            "GitLab {} did not finish within the provider request budget. Try again.",
            self.label
        ))
        .detail("gitlab_inventory", self.label)
        .detail("inventory", "incomplete")
        .detail("pages_read", pages_read.to_string())
    }
}

impl GitlabReleaseProvider {
    pub fn for_library(library: &Library) -> Result<Self> {
        Self::build(Some(library.clone()), "https://gitlab.com/api/v4")
    }

    fn build(library: Option<Library>, api_root: &str) -> Result<Self> {
        Self::build_with_bounds(library, api_root, PROVIDER_NETWORK_BOUNDS)
    }

    fn build_with_bounds(
        library: Option<Library>,
        api_root: &str,
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
        Ok(Self {
            client,
            api_root: api_root.trim_end_matches('/').into(),
            network_bounds: bounds,
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

    #[cfg(test)]
    fn with_api_root_and_bounds(
        api_root: impl AsRef<str>,
        bounds: ProviderNetworkBounds,
    ) -> Result<Self> {
        Self::build_with_bounds(None, api_root.as_ref(), bounds)
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
        let response = request.send().await.map_err(|error| {
            #[cfg(test)]
            crate::test_http::observe_test_response(crate::test_http::ResponseTestEvent::Failed(
                crate::test_http::ResponseTestPhase::Headers,
                error.is_timeout(),
            ));
            PortcoveError::network(error.to_string())
        })?;
        if response.status() == StatusCode::NOT_MODIFIED {
            let cached = cached
                .ok_or_else(|| PortcoveError::state("GitLab returned 304 without cached data"))?;
            if cached.body.len() > PROVIDER_JSON_MAX_BYTES {
                return Err(PortcoveError::verification(
                    "cached GitLab response exceeds the 4 MiB metadata limit",
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
                tracing::warn!(%error, %url, "could not refresh GitLab HTTP cache age");
            }
            return Ok(Some(parsed));
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

    fn operation_deadline(&self) -> tokio::time::Instant {
        tokio::time::Instant::now() + self.network_bounds.request
    }

    /// Reads the next page of `pages` from `url(page)`. Returns `None` once the
    /// provider has listed everything. A short page ends the list; a full page
    /// is followed by another read, so a list that ends exactly on a page
    /// boundary is proven complete by the following empty page.
    async fn next_page<T: DeserializeOwned>(
        &self,
        pages: &mut GitlabPages,
        url: impl FnOnce(usize) -> Result<String>,
    ) -> Result<Option<Vec<T>>> {
        let Some(page) = pages.next_page else {
            return Ok(None);
        };
        if tokio::time::Instant::now() >= pages.deadline {
            return Err(pages.incomplete(page - 1));
        }
        let url = url(page)?;
        let current: Vec<T> = tokio::time::timeout_at(pages.deadline, self.get_json(&url))
            .await
            .map_err(|_| pages.incomplete(page - 1))??;
        if current.len() > PROVIDER_PAGE_SIZE {
            return Err(PortcoveError::verification(format!(
                "GitLab {} page exceeds the requested page size",
                pages.label
            )));
        }
        pages.next_page = (current.len() == PROVIDER_PAGE_SIZE).then_some(page + 1);
        Ok(Some(current))
    }

    /// Newest-first release history, read only until `decided` holds for the
    /// observed prefix (`true` as the second argument once the history is
    /// complete). A release added upstream while the history is being read shifts
    /// older entries onto the next page; the repeated entry is the same release
    /// and is kept once, so the shift never hides one.
    async fn release_prefix(
        &self,
        project_url: &str,
        deadline: tokio::time::Instant,
        mut decided: impl FnMut(&[GitlabRelease], bool) -> bool,
    ) -> Result<Vec<GitlabRelease>> {
        let mut pages = GitlabPages::new("release history", deadline);
        let mut releases: Vec<GitlabRelease> = Vec::new();
        let mut tags = HashSet::new();
        while let Some(current) = self
            .next_page::<GitlabRelease>(&mut pages, |page| {
                paginated_url(project_url, "releases", page, PROVIDER_PAGE_SIZE)
            })
            .await?
        {
            releases.extend(
                current
                    .into_iter()
                    .filter(|release| tags.insert(release.tag_name.clone())),
            );
            if decided(&releases, pages.next_page.is_none()) {
                break;
            }
        }
        Ok(releases)
    }

    /// The complete release history within one operation budget.
    #[cfg(test)]
    async fn releases(&self, project_url: &str) -> Result<Vec<GitlabRelease>> {
        self.release_prefix(project_url, self.operation_deadline(), |_, _| false)
            .await
    }

    /// The release the channel selects. A rolling tag is looked up exactly
    /// (`GET /projects/:id/releases/:tag_name`,
    /// https://docs.gitlab.com/api/releases/#get-a-release-by-a-tag-name); other
    /// channels read newest-first history only as far as the choice needs.
    async fn channel_release(
        &self,
        project_url: &str,
        channel: ReleaseChannel,
        rolling_tag: Option<&str>,
        deadline: tokio::time::Instant,
    ) -> Result<Option<GitlabRelease>> {
        if channel == ReleaseChannel::Rolling
            && let Some(tag) = rolling_tag
        {
            let mut url = reqwest::Url::parse(project_url)
                .map_err(|_| PortcoveError::state("invalid GitLab project URL"))?;
            url.path_segments_mut()
                .map_err(|_| PortcoveError::state("invalid GitLab project URL"))?
                .extend(["releases", tag]);
            let release: Option<GitlabRelease> =
                tokio::time::timeout_at(deadline, self.get_optional_json(url.as_str()))
                    .await
                    .map_err(|_| GitlabPages::new("rolling release", deadline).incomplete(0))??;
            return Ok(release.filter(|release| {
                release.tag_name.eq_ignore_ascii_case(tag) && !release.upcoming_release
            }));
        }
        let releases = self
            .release_prefix(project_url, deadline, |releases, complete| {
                channel_decided(releases, complete, channel, rolling_tag)
            })
            .await?;
        Ok(select_gitlab_release(&releases, channel, rolling_tag).cloned())
    }

    /// Generic packages whose version is this release's tag, with or without a
    /// leading `v`, using the registry's version filter
    /// (`GET /projects/:id/packages?package_version=`,
    /// https://docs.gitlab.com/api/packages/#for-a-project) instead of scanning
    /// unrelated package history. The filter is applied again locally, so a
    /// registry that ignores it still yields only matching packages after a
    /// complete read.
    async fn release_packages(
        &self,
        project_url: &str,
        tag: &str,
        deadline: tokio::time::Instant,
    ) -> Result<Vec<GitlabPackage>> {
        let normalized = tag.strip_prefix('v').unwrap_or(tag);
        let mut versions = vec![tag];
        if normalized != tag {
            versions.push(normalized);
        }
        let mut packages = Vec::new();
        let mut ids = HashSet::new();
        for version in versions {
            let mut pages = GitlabPages::new("package registry", deadline);
            while let Some(current) = self
                .next_page::<GitlabPackage>(&mut pages, |page| {
                    let url = paginated_url(project_url, "packages", page, PROVIDER_PAGE_SIZE)?;
                    let mut url = reqwest::Url::parse(&url)
                        .map_err(|error| PortcoveError::state(error.to_string()))?;
                    url.query_pairs_mut()
                        .append_pair("package_type", "generic")
                        .append_pair("package_version", version)
                        .append_pair("order_by", "created_at")
                        .append_pair("sort", "desc");
                    Ok(url.into())
                })
                .await?
            {
                // A package published during the read shifts older ones onto the
                // next page; the repeated row is the same package.
                packages.extend(current.into_iter().filter(|package| {
                    (package.version == tag || package.version == normalized)
                        && ids.insert(package.id)
                }));
            }
        }
        Ok(packages)
    }

    async fn package_file(
        &self,
        project_url: &str,
        project_id: u64,
        release: &GitlabRelease,
        link: &GitlabReleaseLink,
        deadline: tokio::time::Instant,
    ) -> Result<Option<GitlabPackageFile>> {
        let Some(file_id) = package_file_id(&link.url) else {
            return Ok(None);
        };
        let package_ids: Vec<u64> = self
            .release_packages(project_url, &release.tag_name, deadline)
            .await?
            .into_iter()
            .map(|package| package.id)
            .collect();
        let requests = package_ids.into_iter().map(|package_id| async move {
            self.package_file_in_package(project_id, package_id, file_id, deadline)
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

    /// GitLab has no read endpoint for one package file, so the package's own
    /// file list is read until the file appears or the list ends.
    async fn package_file_in_package(
        &self,
        project_id: u64,
        package_id: u64,
        file_id: u64,
        deadline: tokio::time::Instant,
    ) -> Result<Option<GitlabPackageFile>> {
        let package_url = format!(
            "{}/projects/{project_id}/packages/{package_id}",
            self.api_root
        );
        let mut pages = GitlabPages::new("package files", deadline);
        while let Some(files) = self
            .next_page::<GitlabPackageFile>(&mut pages, |page| {
                paginated_url(&package_url, "package_files", page, PROVIDER_PAGE_SIZE)
            })
            .await?
        {
            if let Some(file) = files.into_iter().find(|file| file.id == file_id) {
                return Ok(Some(file));
            }
        }
        Ok(None)
    }

    async fn generic_package_file(
        &self,
        project_url: &str,
        project_id: u64,
        release: &GitlabRelease,
        link: &GitlabReleaseLink,
        deadline: tokio::time::Instant,
    ) -> Result<Option<(GitlabPackageFile, reqwest::Url)>> {
        let Some(url) = generic_package_url(project_url, &self.api_root, project_id, &link.url)?
        else {
            return Ok(None);
        };
        let packages = self
            .release_packages(project_url, &release.tag_name, deadline)
            .await?;
        let selected = &url;
        let requests = packages.into_iter().map(|package| async move {
            self.generic_files_in_package(project_url, project_id, &package, selected, deadline)
                .await
        });
        let results = stream::iter(requests)
            .buffered(GITLAB_PACKAGE_LOOKUP_CONCURRENCY)
            .collect::<Vec<_>>()
            .await;
        let mut candidates = Vec::new();
        let mut identities = HashSet::new();
        for result in results {
            for file in result? {
                if !identities.insert(file.id) {
                    return Err(PortcoveError::verification(
                        "GitLab generic registry repeats a package-file identity",
                    ));
                }
                candidates.push(file);
            }
        }
        if candidates.len() > 1 {
            // The official versioned endpoint identifies its current upload;
            // expected integrity still comes from an independently joined row.
            let response = self
                .client
                .head(url.clone())
                .send()
                .await
                .map_err(|error| PortcoveError::network(error.to_string()))?;
            if !response.status().is_success() {
                return Err(gitlab_http_error(response.status(), response.headers()));
            }
            let headers = response.headers();
            let checksums: Vec<_> = headers.get_all("x-checksum-sha256").iter().collect();
            let checksum = checksums
                .first()
                .filter(|_| checksums.len() == 1)
                .and_then(|value| value.to_str().ok())
                .filter(|value| {
                    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
                })
                .ok_or_else(|| {
                    PortcoveError::verification(
                        "GitLab generic upload needs one published SHA-256 header to resolve duplicate registry files",
                    )
                })?;
            let size = headers
                .get(header::CONTENT_LENGTH)
                .map(|value| {
                    value
                        .to_str()
                        .ok()
                        .and_then(|value| value.parse::<u64>().ok())
                        .ok_or_else(|| {
                            PortcoveError::verification(
                                "GitLab generic upload has an invalid published size",
                            )
                        })
                })
                .transpose()?;
            candidates.retain(|file| {
                file.file_sha256.eq_ignore_ascii_case(checksum)
                    && size.is_none_or(|size| file.size == size)
            });
        }
        if candidates.len() != 1 {
            return Err(PortcoveError::verification(
                "GitLab generic upload does not identify exactly one published registry file",
            ));
        }
        let file = candidates.pop().unwrap();
        if file.id == 0
            || file.size == 0
            || file.file_sha256.len() != 64
            || !file
                .file_sha256
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(PortcoveError::verification(
                "GitLab generic registry file lacks a valid identity, size or SHA-256",
            ));
        }
        Ok(Some((file, url)))
    }

    async fn generic_files_in_package(
        &self,
        project_url: &str,
        project_id: u64,
        package: &GitlabPackage,
        selected: &reqwest::Url,
        deadline: tokio::time::Instant,
    ) -> Result<Vec<GitlabPackageFile>> {
        let package_url = format!(
            "{}/projects/{project_id}/packages/{}",
            self.api_root, package.id
        );
        let mut matched = Vec::new();
        let mut identities = HashSet::new();
        let mut pages = GitlabPages::new("package files", deadline);
        while let Some(files) = self
            .next_page::<GitlabPackageFile>(&mut pages, |page| {
                paginated_url(&package_url, "package_files", page, PROVIDER_PAGE_SIZE)
            })
            .await?
        {
            for file in files {
                if !identities.insert(file.id) {
                    return Err(PortcoveError::verification(
                        "GitLab package-file pages repeat an identity",
                    ));
                }
                for project in [
                    project_url.to_owned(),
                    format!("{}/projects/{project_id}", self.api_root),
                ] {
                    let mut expected = reqwest::Url::parse(&project)
                        .map_err(|error| PortcoveError::state(error.to_string()))?;
                    expected
                        .path_segments_mut()
                        .map_err(|_| PortcoveError::state("invalid GitLab package URL"))?
                        .extend([
                            "packages",
                            "generic",
                            &package.name,
                            &package.version,
                            &file.file_name,
                        ]);
                    if expected == *selected {
                        matched.push(file);
                        break;
                    }
                }
            }
        }
        Ok(matched)
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
}

#[async_trait]
impl ReleaseProvider for GitlabReleaseProvider {
    async fn review_exact(
        &self,
        port: &PortDefinition,
        channel: ReleaseChannel,
        platform: Platform,
        scope: Option<&crate::DefinitionAcquisitionScope>,
        version: &str,
    ) -> Result<ExactReleaseSelection> {
        let query = ExactReleaseQuery::Review(version);
        query.require_route(port, channel, platform, ReleaseSource::Gitlab, scope)?;
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
        pin.require_context(port, channel, platform, scope)?;
        let (selected, _) = self
            .resolve_exact_bounded(port, channel, platform, ExactReleaseQuery::Saved(pin))
            .await?;
        crate::ScopedResolvedRelease::legacy(selected).for_selection(port, platform, channel)
    }

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
        // An archived project may still expose an exact usable release. Keep
        // metadata validation before cache reuse, then apply the same asset
        // identity and integrity rules as any other hosted project.
        let _archived = project.archived;
        let key = ReleaseSelectionCacheKey::new(port, channel, platform);
        if let Some(release) = self.cached_release(&key).await {
            return Ok(release);
        }
        let deadline = self.operation_deadline();
        let release = self
            .channel_release(
                &project_url,
                channel,
                port.release.rolling_tag.as_deref(),
                deadline,
            )
            .await?
            .ok_or_else(|| {
                PortcoveError::not_found(format!(
                    "no published {channel} release exists for {}",
                    port.name
                ))
            })?;
        let release = &release;
        let link = choose_link(port, platform, &release.assets.links)?;
        let package_file = self
            .package_file(&project_url, project.id, release, link, deadline)
            .await?;
        let description_digest = digest_from_description(&release.description, &link.name);
        let generic = if package_file.is_none() && description_digest.is_none() {
            self.generic_package_file(&project_url, project.id, release, link, deadline)
                .await?
        } else {
            None
        };
        let resolved = resolve_observed_asset(
            port,
            channel,
            platform,
            release,
            link,
            GitlabObservedAsset {
                package_file,
                generic,
                description_digest,
            },
        )?;
        self.store_release(key, resolved.clone()).await;
        Ok(resolved)
    }

    fn cached_release_notes(
        &self,
        port: &PortDefinition,
        channel: ReleaseChannel,
        _platform: Platform,
        installed: Option<&str>,
        offered: &str,
    ) -> Option<crate::UpdateReleaseNotes> {
        if port.release.provider != ReleaseSource::Gitlab {
            return None;
        }
        let releases_url = self
            .api_root
            .strip_suffix("/api/v4")
            .zip(crate::release_notes::repository_segments(
                &port.release.repository,
            ))
            .and_then(|(web_root, repository)| {
                crate::release_notes::web_url(
                    web_root,
                    &[repository.as_slice(), &["-", "releases"][..]].concat(),
                )
            });
        let project_url = self.project_url(&port.release.repository).ok()?;
        // Only pages a resolution already read are cached; reading stops at the
        // first uncached page, so no page count bounds the history.
        let releases: Vec<GitlabRelease> = crate::release_notes::cached_pages(
            usize::MAX,
            PROVIDER_PAGE_SIZE,
            PROVIDER_JSON_MAX_BYTES,
            |page| {
                paginated_url(&project_url, "releases", page, PROVIDER_PAGE_SIZE)
                    .ok()
                    .and_then(|url| self.cached_http_response(&url))
            },
        );
        let listed = releases
            .iter()
            .map(|release| crate::release_notes::ListedRelease {
                tag: &release.tag_name,
                title: release.name.as_deref(),
                published_at: release.released_at.as_deref(),
                notes: &release.description,
                // Same selection rule as GitLab release resolution.
                selectable: !release.upcoming_release,
                beta: is_beta_tag(&release.tag_name),
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
            crate::release_notes::ReleasePage::GitlabRelease,
        ))
    }
}

#[derive(Debug, Deserialize)]
struct GitlabProject {
    id: u64,
    #[serde(default)]
    path_with_namespace: Option<String>,
    #[serde(default)]
    archived: Option<bool>,
}

#[derive(Deserialize)]
struct GitlabTag {
    name: String,
    commit: GitlabCommit,
}

#[derive(Deserialize)]
struct GitlabCommit {
    id: String,
}

#[derive(Debug, Clone, Deserialize)]
struct GitlabRelease {
    tag_name: String,
    /// Informational only: shown as untrusted plain text in update reviews.
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    description: String,
    #[serde(default)]
    released_at: Option<String>,
    #[serde(default)]
    upcoming_release: bool,
    assets: GitlabReleaseAssets,
}

#[derive(Debug, Clone, Deserialize)]
struct GitlabReleaseAssets {
    #[serde(default)]
    links: Vec<GitlabReleaseLink>,
}

#[derive(Debug, Clone, Deserialize)]
struct GitlabReleaseLink {
    #[serde(default)]
    id: Option<u64>,
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
    #[serde(default)]
    name: String,
}

#[derive(Debug, Deserialize)]
struct GitlabPackageFile {
    id: u64,
    file_name: String,
    size: u64,
    file_sha256: String,
}

fn select_gitlab_release<'a>(
    releases: &'a [GitlabRelease],
    channel: ReleaseChannel,
    rolling_tag: Option<&str>,
) -> Option<&'a GitlabRelease> {
    crate::release::select_channel_candidate(
        releases,
        channel,
        rolling_tag,
        |release| !release.upcoming_release,
        |release| is_beta_tag(&release.tag_name),
        |release| release.tag_name.as_str(),
    )
}

/// Whether the newest-first prefix already decides the channel's release.
/// Stable and Rolling take the first match, which no older page can change.
/// Beta prefers any prerelease and falls back to a stable release only when
/// none exists, which only the complete history establishes.
fn channel_decided(
    releases: &[GitlabRelease],
    complete: bool,
    channel: ReleaseChannel,
    rolling_tag: Option<&str>,
) -> bool {
    complete
        || select_gitlab_release(releases, channel, rolling_tag).is_some_and(|release| {
            channel != ReleaseChannel::Beta || is_beta_tag(&release.tag_name)
        })
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
    let mut role_held = false;
    let mut scored: Vec<(i32, &GitlabReleaseLink)> = links
        .iter()
        .filter_map(|link| {
            let name = link.name.to_ascii_lowercase();
            if link.link_type != "package"
                || crate::service::package_selection::is_server_package(&name)
                || conflicts_with_platform(&name, platform)
            {
                return None;
            }
            // The same typed-role gate as every other release route (#8602).
            if link_role_hold(port.adapter, &name, &hints).is_some() {
                role_held |= !crate::route_facts::suggest_from_filename(&name)
                    .os
                    .excludes(platform);
                return None;
            }
            if port.n64_runtime_at_executable_parent {
                return crate::service::package_selection::assess_package_name(
                    &name, true, platform, &hints,
                )
                .2
                .filter(|_| {
                    hints
                        .iter()
                        .all(|hint| name.contains(&hint.to_ascii_lowercase()))
                })
                .map(|score| (score as i32, link));
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
        if role_held {
            return Err(wrong_role_refusal(port, platform));
        }
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

/// The typed-role gate for a GitLab release link. A link label often omits
/// the file extension, so a label without a package form is classified as the
/// package download a `package` link is; the final registry filename is gated
/// again with its real form before anything is cached.
fn link_role_hold(
    adapter: crate::AdapterKind,
    name: &str,
    hints: &[String],
) -> Option<crate::route_facts::RouteHold> {
    if crate::route_facts::suggest_from_filename(name).package_form {
        let can_extract = GITLAB_EXTRACTABLE
            .iter()
            .any(|extension| name.ends_with(extension));
        crate::route_facts::package_role_hold(adapter, name, can_extract, hints)
    } else {
        crate::route_facts::package_role_hold(adapter, &format!("{name}.zip"), true, hints)
    }
}

const GITLAB_EXTRACTABLE: &[&str] = &[".zip", ".tar.gz", ".tgz"];

fn wrong_role_refusal(port: &PortDefinition, platform: Platform) -> PortcoveError {
    PortcoveError::not_found(format!(
        "{} has no game package for {platform:?} in this release; its matching downloads are installers, tools, debug builds or source archives, which Portcove does not install as the game",
        port.name
    ))
    .detail(
        "route_hold",
        crate::route_facts::RouteHold::WrongRole.as_str(),
    )
}

fn native_archive_score(name: &str, platform: Platform, hints: &[String]) -> Option<i32> {
    let can_extract = [".zip", ".tar.gz", ".tgz"]
        .iter()
        .any(|extension| name.ends_with(extension));
    if !can_extract
        || !hints
            .iter()
            .all(|hint| name.contains(&hint.to_ascii_lowercase()))
    {
        return None;
    }
    crate::service::package_selection::assess_package_name(name, can_extract, platform, hints)
        .2
        .map(|score| score as i32)
}

fn gitlab_http_error(status: StatusCode, headers: &header::HeaderMap) -> PortcoveError {
    let numeric_header = |name: &str| headers.get(name)?.to_str().ok()?.parse::<i64>().ok();
    let mut error = PortcoveError::network(format!("GitLab API returned {status}"))
        .with_known_cause(crate::failure::KnownFailureCause::ProviderRequest {
            provider: crate::failure::FailureProvider::Gitlab,
            status: status.as_u16(),
            rate_limited: status == StatusCode::TOO_MANY_REQUESTS
                || (status == StatusCode::FORBIDDEN
                    && numeric_header("ratelimit-remaining") == Some(0)),
            resets_at: numeric_header("ratelimit-reset"),
        });
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

pub(crate) fn generic_package_url(
    project_url: &str,
    api_root: &str,
    project_id: u64,
    link: &str,
) -> Result<Option<reqwest::Url>> {
    let url = reqwest::Url::parse(link)
        .map_err(|_| PortcoveError::verification("invalid GitLab release URL"))?;
    if !url.path().contains("/packages/generic/") {
        return Ok(None);
    }
    let scoped = [
        format!("{project_url}/packages/generic/"),
        format!("{api_root}/projects/{project_id}/packages/generic/"),
    ]
    .iter()
    .any(|prefix| {
        url.as_str().strip_prefix(prefix).is_some_and(|tail| {
            let parts: Vec<_> = tail.split('/').collect();
            parts.len() == 3 && parts.iter().all(|part| !part.is_empty())
        })
    });
    if !scoped
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(PortcoveError::verification(
            "GitLab generic release URL must name this project's exact official package endpoint",
        ));
    }
    Ok(Some(url))
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

struct GitlabObservedAsset {
    package_file: Option<GitlabPackageFile>,
    generic: Option<(GitlabPackageFile, reqwest::Url)>,
    description_digest: Option<String>,
}

fn resolve_observed_asset(
    port: &PortDefinition,
    channel: ReleaseChannel,
    platform: Platform,
    release: &GitlabRelease,
    link: &GitlabReleaseLink,
    metadata: GitlabObservedAsset,
) -> Result<ResolvedRelease> {
    let GitlabObservedAsset {
        package_file,
        generic,
        description_digest,
    } = metadata;
    let (name, size, sha256, download_url) = if let Some((file, url)) = generic {
        if native_archive_score(
            &file.file_name.to_ascii_lowercase(),
            platform,
            port.release
                .asset_hints
                .get(&platform)
                .map(Vec::as_slice)
                .unwrap_or_default(),
        )
        .is_none()
        {
            return Err(PortcoveError::verification(
                "GitLab generic registry filename does not match the selected native archive",
            ));
        }
        (file.file_name, file.size, file.file_sha256, url.into())
    } else if let Some(file) = package_file {
        (
            file.file_name,
            file.size,
            file.file_sha256,
            link.direct_asset_url
                .clone()
                .unwrap_or_else(|| link.url.clone()),
        )
    } else {
        let sha256 = description_digest.ok_or_else(|| {
            PortcoveError::verification(format!(
                "{} does not publish a SHA-256 digest for {}",
                port.name, link.name
            ))
        })?;
        (
            link.name.clone(),
            0,
            sha256,
            link.direct_asset_url
                .clone()
                .unwrap_or_else(|| link.url.clone()),
        )
    };
    if crate::service::package_selection::is_server_package(&name) {
        return Err(PortcoveError::verification(
            "GitLab package filename identifies a dedicated server",
        ));
    }
    if link_role_hold(
        port.adapter,
        &name.to_ascii_lowercase(),
        port.release
            .asset_hints
            .get(&platform)
            .map(Vec::as_slice)
            .unwrap_or_default(),
    )
    .is_some()
    {
        // The link passed the gate, so its registry file differs from it.
        return Err(PortcoveError::verification(
            "GitLab package filename identifies an installer, tool, debug build or source archive, not the game package",
        )
        .detail(
            "route_hold",
            crate::route_facts::RouteHold::WrongRole.as_str(),
        ));
    }
    if port.n64_runtime_at_executable_parent
        && native_archive_score(
            &name.to_ascii_lowercase(),
            platform,
            port.release
                .asset_hints
                .get(&platform)
                .map(Vec::as_slice)
                .unwrap_or_default(),
        )
        .is_none()
    {
        return Err(PortcoveError::verification(
            "GitLab package filename does not match the reviewed native archive rules",
        ));
    }
    Ok(ResolvedRelease {
        version: release.tag_name.clone(),
        channel,
        published_at: release.released_at.clone(),
        asset: ReleaseAsset {
            name,
            url: download_url,
            size,
            sha256,
        },
        uploader_continuity: None,
    })
}

/// Offline metadata projection. Provider facts grant no artifact or publication trust.
pub(crate) fn project_observed_releases(
    port: &PortDefinition,
    facts: &serde_json::Value,
) -> Result<serde_json::Value> {
    use serde_json::{Value, json};
    let fail =
        || PortcoveError::verification("GitLab observation has incomplete or foreign identities");
    let project_id = facts["project"]["id"]
        .as_u64()
        .filter(|id| *id > 0)
        .ok_or_else(fail)?;
    if facts["project"]["path_with_namespace"] != port.release.repository
        || (!facts["project"]["archived"].is_boolean() && !facts["project"]["archived"].is_null())
        || facts["coverage"]["releases"] != true
        || facts["coverage"]["packages"] != true
    {
        return Err(fail());
    }
    let raw = facts["releases"].as_array().ok_or_else(fail)?;
    let mut tags = HashSet::new();
    let mut links = HashSet::new();
    for release in raw {
        let tag = release["tag_name"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 255 && !s.chars().any(char::is_control))
            .ok_or_else(fail)?;
        if !tags.insert(tag)
            || !release["upcoming_release"].is_boolean()
            || release["released_at"]
                .as_str()
                .and_then(|s| {
                    time::OffsetDateTime::parse(s, &time::format_description::well_known::Rfc3339)
                        .ok()
                })
                .is_none()
        {
            return Err(fail());
        }
        for link in release["assets"]["links"].as_array().ok_or_else(fail)? {
            if !links.insert(link["id"].as_u64().filter(|id| *id > 0).ok_or_else(fail)?) {
                return Err(fail());
            }
            for field in ["url", "direct_asset_url"] {
                if let Some(url) = link[field].as_str() {
                    let url = reqwest::Url::parse(url).map_err(|_| fail())?;
                    if url.scheme() != "https"
                        || url.host_str() != Some("gitlab.com")
                        || url.port().is_some()
                        || !url.username().is_empty()
                        || url.password().is_some()
                        || url.query().is_some()
                        || url.fragment().is_some()
                    {
                        return Err(fail());
                    }
                }
            }
        }
    }
    let releases: Vec<GitlabRelease> = serde_json::from_value(facts["releases"].clone())?;
    let packages: Vec<GitlabPackage> = serde_json::from_value(facts["packages"].clone())?;
    let mut package_ids = HashSet::new();
    let mut file_ids = HashSet::new();
    for package in &packages {
        if package.id == 0 || !package_ids.insert(package.id) {
            return Err(fail());
        }
        if let Some(rows) = facts["package_files"].get(package.id.to_string()) {
            let files: Vec<GitlabPackageFile> = serde_json::from_value(rows.clone())?;
            for file in files {
                if file.id == 0
                    || file.size == 0
                    || !file_ids.insert(file.id)
                    || file.file_sha256.len() != 64
                    || !file.file_sha256.bytes().all(|b| b.is_ascii_hexdigit())
                {
                    return Err(fail());
                }
            }
        }
    }
    let project_url = format!(
        "https://gitlab.com/api/v4/projects/{}",
        urlencoding_repository(&port.release.repository)
    );
    let mut projections = Vec::new();
    for &platform in &port.platforms {
        for channel in [
            ReleaseChannel::Stable,
            ReleaseChannel::Beta,
            ReleaseChannel::Rolling,
        ] {
            let candidate = crate::release::select_channel_candidate(
                &releases,
                channel,
                port.release.rolling_tag.as_deref(),
                |r| !r.upcoming_release,
                |r| is_beta_tag(&r.tag_name),
                |r| r.tag_name.as_str(),
            );
            let latest = releases
                .iter()
                .find(|r| !r.upcoming_release)
                .map(|r| json!({"tag":r.tag_name,"published_at":r.released_at}));
            let mut row = json!({"platform":platform,"channel":channel,"latest_observed":latest,"channel_candidate":candidate.map(|r| json!({"tag":r.tag_name,"published_at":r.released_at})),"latest_eligible":null,"hold_reasons":[]});
            let resolution = (|| -> Result<Value> {
                if !port.channels.contains(&channel) {
                    return Err(PortcoveError::unsupported("channel-not-offered"));
                }
                let release = candidate
                    .ok_or_else(|| PortcoveError::not_found("no-published-channel-candidate"))?;
                let link = choose_link(port, platform, &release.assets.links)?;
                let file_id = package_file_id(&link.url);
                if let Some(file_id) = file_id {
                    let expected = format!(
                        "https://gitlab.com/{}/-/package_files/{file_id}/download",
                        port.release.repository
                    );
                    if link.url != expected
                        || link
                            .direct_asset_url
                            .as_ref()
                            .is_some_and(|url| url != &expected)
                    {
                        return Err(PortcoveError::verification(
                            "package-file-url-escaped-reviewed-project",
                        ));
                    }
                }
                let description_digest = digest_from_description(&release.description, &link.name);
                let matching: Vec<_> = packages
                    .iter()
                    .filter(|p| {
                        p.version == release.tag_name
                            || p.version == release.tag_name.trim_start_matches('v')
                    })
                    .collect();
                let mut files = Vec::new();
                for package in matching {
                    let rows = match facts["package_files"].get(package.id.to_string()) {
                        Some(rows) => rows,
                        None if file_id.is_none() && description_digest.is_some() => continue,
                        None => {
                            return Err(PortcoveError::verification(
                                "selected-package-files-incomplete",
                            ));
                        }
                    };
                    for file in serde_json::from_value::<Vec<GitlabPackageFile>>(rows.clone())? {
                        files.push((package, file));
                    }
                }
                let mut selected: Vec<_> = files
                    .into_iter()
                    .filter(|(package, file)| {
                        if let Some(id) = file_id {
                            return file.id == id;
                        }
                        [
                            project_url.clone(),
                            format!("https://gitlab.com/api/v4/projects/{project_id}"),
                        ]
                        .iter()
                        .any(|base| {
                            let Ok(mut expected) = reqwest::Url::parse(base) else {
                                return false;
                            };
                            let Ok(mut segments) = expected.path_segments_mut() else {
                                return false;
                            };
                            segments.extend([
                                "packages",
                                "generic",
                                &package.name,
                                &package.version,
                                &file.file_name,
                            ]);
                            drop(segments);
                            expected.as_str() == link.url
                        })
                    })
                    .map(|(_, file)| file)
                    .collect();
                if selected.len() > 1 {
                    return Err(PortcoveError::verification(
                        "ambiguous-registry-upload-needs-published-checksum-header",
                    ));
                }
                let mut file = selected.pop();
                if file_id.is_none()
                    && let Some(digest) = &description_digest
                {
                    if file
                        .as_ref()
                        .is_some_and(|file| !file.file_sha256.eq_ignore_ascii_case(digest))
                    {
                        return Err(PortcoveError::verification(
                            "description-and-registry-checksums-conflict",
                        ));
                    }
                    file = None;
                }
                let selected_file_id = file.as_ref().map(|file| file.id);
                let digest = description_digest;
                let generic_url = if file_id.is_none() && digest.is_none() {
                    generic_package_url(
                        &project_url,
                        "https://gitlab.com/api/v4",
                        project_id,
                        &link.url,
                    )?
                } else {
                    None
                };
                let (package_file, generic) = match (file, generic_url) {
                    (Some(file), Some(url)) => (None, Some((file, url))),
                    (file, _) => (file, None),
                };
                let resolved = resolve_observed_asset(
                    port,
                    channel,
                    platform,
                    release,
                    link,
                    GitlabObservedAsset {
                        package_file,
                        generic,
                        description_digest: digest,
                    },
                )?;
                let raw_link = raw
                    .iter()
                    .find(|r| r["tag_name"] == release.tag_name)
                    .and_then(|r| r["assets"]["links"].as_array())
                    .and_then(|links| {
                        links
                            .iter()
                            .find(|l| l["name"] == link.name && l["url"] == link.url)
                    })
                    .ok_or_else(fail)?;
                Ok(
                    json!({"identity":{"project_id":project_id,"tag":release.tag_name,"link_id":raw_link["id"],"package_file_id":selected_file_id},"release":resolved}),
                )
            })();
            match resolution {
                Ok(value) => row["latest_eligible"] = value,
                Err(error) => row["hold_reasons"] = json!([error.to_string()]),
            }
            projections.push(row);
        }
    }
    Ok(
        json!({"provider_identity":{"provider":"gitlab","project_id":project_id,"repository":port.release.repository,"archived":facts["project"]["archived"]},"projections":projections}),
    )
}

fn urlencoding_repository(repository: &str) -> String {
    repository.replace('/', "%2F")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_http::{
        DeadlineServer, ResponseTestPhase, observe_response, serve_deadline, serve_http,
        serve_routed_http,
    };
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::{
            Arc, Condvar, Mutex,
            atomic::{AtomicUsize, Ordering},
        },
        thread,
    };

    fn short_network_bounds() -> ProviderNetworkBounds {
        // CI41003906042/a1 Windows1 reached the50ms cutoff before headers
        // at58.224ms, so it never exercised the intended partial-body phase.
        // Calibrate only this test's injected bounds; retain every body/idle
        // assertion, the500ms elapsed ceiling and production provider defaults.
        let (idle_ms, request_ms) = if cfg!(windows) { (200, 800) } else { (50, 180) };
        ProviderNetworkBounds {
            connect: Duration::from_millis(idle_ms),
            read_idle: Duration::from_millis(idle_ms),
            request: Duration::from_millis(request_ms),
        }
    }

    fn serve_deadline_metadata(trickle: bool) -> (String, DeadlineServer) {
        serve_deadline(move |connection| {
            // Preserve the old idle case's exact response; total needs more bytes.
            if trickle {
                connection.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 10000\r\n\r\n{")?;
            } else {
                connection.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{")?;
            }
            connection.flush()?;
            if trickle {
                loop {
                    if connection.wait(Duration::from_millis(10)) {
                        break;
                    }
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

    #[tokio::test]
    async fn gitlab_metadata_body_progress_exhausts_the_overall_request_bound() {
        let (metadata_root, mut metadata_server) = serve_deadline_metadata(true);
        let bounds = ProviderNetworkBounds {
            connect: Duration::from_millis(200),
            read_idle: Duration::from_millis(200),
            request: Duration::from_millis(800),
        };
        let provider =
            GitlabReleaseProvider::with_api_root_and_bounds(&metadata_root, bounds).unwrap();
        metadata_server.start();
        let started = Instant::now();
        let (result, observed) = observe_response(
            provider.get_json::<serde_json::Value>(&format!("{metadata_root}/metadata")),
        )
        .await;
        let elapsed = started.elapsed();
        let server = metadata_server.finish();
        eprintln!(
            "GitLab metadata deadline: {elapsed:?}; observation={observed:?}; fixture={server:?}"
        );
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
    async fn gitlab_metadata_partial_body_exhausts_the_read_idle_bound() {
        let (auth_root, mut auth_server) = serve_deadline_metadata(false);
        let bounds = short_network_bounds();
        let provider = GitlabReleaseProvider::with_api_root_and_bounds(&auth_root, bounds).unwrap();
        auth_server.start();
        let started = Instant::now();
        let (result, observed) = observe_response(
            provider.get_json::<serde_json::Value>(&format!("{auth_root}/metadata")),
        )
        .await;
        let elapsed = started.elapsed();
        let server = auth_server.finish();
        eprintln!(
            "GitLab body deadline: {elapsed:?}; observation={observed:?}; fixture={server:?}"
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
    async fn gitlab_selected_release_cache_evicts_the_oldest_entry() {
        let provider = GitlabReleaseProvider::with_api_root("https://example.invalid").unwrap();
        let mut port = crate::Catalog::embedded()
            .unwrap()
            .port("re-blue")
            .unwrap()
            .clone();
        port.release.repository = "owner/repository-0".into();
        let oldest_key =
            ReleaseSelectionCacheKey::new(&port, ReleaseChannel::Stable, Platform::WindowsX86_64);
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
            port.release.repository = format!("owner/repository-{index}");
            provider
                .store_release(
                    ReleaseSelectionCacheKey::new(
                        &port,
                        ReleaseChannel::Stable,
                        Platform::WindowsX86_64,
                    ),
                    release.clone(),
                )
                .await;
        }
        let cache = provider.cache.read().await;
        assert_eq!(cache.len(), RELEASE_CACHE_MAX_ENTRIES);
        assert!(!cache.contains_key(&oldest_key));
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

    fn gitlab_selector_releases() -> String {
        serde_json::to_string(
            &["nightly-a", "nightly-b", "v2.0.0"].map(|tag| {
                let first = "game-first-windows.zip";
                let second = "game-second-windows.zip";
                serde_json::json!({
                    "tag_name": tag,
                    "description": format!(
                        "{first} SHA-256: {}\n{second} SHA-256: {}",
                        "a".repeat(64),
                        "b".repeat(64)
                    ),
                    "released_at": null,
                    "upcoming_release": false,
                    "assets": {"links": [
                        {
                            "name": first,
                            "url": format!("https://downloads.example.invalid/{tag}-first.zip"),
                            "direct_asset_url": format!("https://downloads.example.invalid/{tag}-first.zip"),
                            "link_type": "package"
                        },
                        {
                            "name": second,
                            "url": format!("https://downloads.example.invalid/{tag}-second.zip"),
                            "direct_asset_url": format!("https://downloads.example.invalid/{tag}-second.zip"),
                            "link_type": "package"
                        }
                    ]}
                })
            }),
        )
        .unwrap()
    }

    #[test]
    fn update_release_notes_read_only_the_cached_gitlab_release_list() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path()).unwrap();
        let provider = GitlabReleaseProvider::with_api_root_and_library(
            "https://gitlab.example.test/api/v4",
            library.clone(),
        )
        .unwrap();
        let mut port = generic_test_port();
        port.release.provider = ReleaseSource::Gitlab;
        port.release.rolling_tag = None;
        let release = |tag: &str, upcoming: bool, description: &str| {
            serde_json::json!({"tag_name":tag,"name":tag,"description":description,
                "released_at":"2026-11-01T00:00:00Z","upcoming_release":upcoming,
                "assets":{"links":[]}})
        };
        let unknown = provider
            .cached_release_notes(
                &port,
                ReleaseChannel::Stable,
                Platform::WindowsX86_64,
                Some("v1.0"),
                "v1.2",
            )
            .unwrap();
        assert!(unknown.entries.is_empty());
        assert_eq!(
            unknown.releases_url.as_deref(),
            Some("https://gitlab.example.test/group/project/-/releases")
        );
        let url = paginated_url(
            &provider.project_url("group/project").unwrap(),
            "releases",
            1,
            PROVIDER_PAGE_SIZE,
        )
        .unwrap();
        let page = serde_json::json!([
            release("v1.3", true, "upcoming"),
            release("v1.2", false, "Fixes\u{202E} audio"),
            release("v1.2-beta", false, "beta"),
            release("v1.1", false, "Adds widescreen"),
            release("v1.0", false, "installed"),
        ]);
        library
            .store_http_cache(&url, Some("\"releases\""), None, &page.to_string())
            .unwrap();
        let notes = provider
            .cached_release_notes(
                &port,
                ReleaseChannel::Stable,
                Platform::WindowsX86_64,
                Some("v1.0"),
                "v1.2",
            )
            .unwrap();
        assert_eq!(notes.coverage, crate::UpdateReleaseNotesCoverage::Complete);
        assert_eq!(
            notes
                .entries
                .iter()
                .map(|entry| (entry.version.as_str(), entry.notes.as_str()))
                .collect::<Vec<_>>(),
            [("v1.2", "Fixes audio"), ("v1.1", "Adds widescreen")]
        );
        assert_eq!(notes.entries[0].title, None);
        // GitLab release pages sit directly under the release list.
        assert_eq!(
            notes.entries[0].url.as_deref(),
            Some("https://gitlab.example.test/group/project/-/releases/v1.2")
        );
    }

    fn generic_test_port() -> PortDefinition {
        let mut port = crate::Catalog::embedded()
            .unwrap()
            .port("extreme-g-recompiled")
            .unwrap()
            .clone();
        port.release.repository = "group/project".into();
        port.release.asset_hints.insert(
            Platform::WindowsX86_64,
            vec!["game-".into(), "windows".into()],
        );
        port
    }

    fn generic_test_file(id: u64, name: &str, digest: char) -> serde_json::Value {
        serde_json::json!({"id":id,"file_name":name,"size":42,"file_sha256":digest.to_string().repeat(64)})
    }

    fn generic_test_response(
        request: &str,
        tag: &str,
        name: &str,
        files: &serde_json::Value,
        head: &str,
    ) -> String {
        if request.starts_with("HEAD ") {
            return head.into();
        }
        if request.contains("/package_files?") {
            return ok_json(&files.to_string(), "");
        }
        if request.contains("/packages?") {
            // The registry honors the version filter: only the unprefixed
            // version names this package.
            let version = tag.trim_start_matches('v');
            let packages = if request.contains(&format!("package_version={version}&")) {
                serde_json::json!([{"id":501,"name":"game","version":version}])
            } else {
                serde_json::json!([])
            };
            return ok_json(&packages.to_string(), "");
        }
        if request.contains("/releases?") {
            let host = request
                .lines()
                .find_map(|line| {
                    let (key, value) = line.split_once(':')?;
                    key.eq_ignore_ascii_case("host").then_some(value.trim())
                })
                .unwrap();
            let mut url = reqwest::Url::parse(&format!(
                "http://{host}/api/v4/projects/group%2Fproject/packages/generic/game/{}",
                tag.trim_start_matches('v')
            ))
            .unwrap();
            url.path_segments_mut().unwrap().push(name);
            return ok_json(
                &serde_json::json!([{
                    "tag_name":tag,"assets":{"links":[{
                        "name":"game-Windows","link_type":"package","url":url.as_str(),
                        "direct_asset_url":"https://unrelated.invalid/other.zip"
                    }]}
                }])
                .to_string(),
                "",
            );
        }
        ok_json(r#"{"id":9,"archived":false}"#, "")
    }

    #[tokio::test]
    async fn generic_packages_follow_successors_with_one_unchanged_definition() {
        let version = Arc::new(AtomicUsize::new(1));
        let published = version.clone();
        let (root, requests, server) = serve_routed_http(19, move |request| {
            let version = published.load(Ordering::SeqCst);
            let name = format!("game-v{version}-windows-x64.zip");
            let digest = if version == 1 { 'b' } else { 'd' };
            let head = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: 42\r\nX-Checksum-Sha256: {}\r\nConnection: close\r\n\r\n",
                digest.to_string().repeat(64)
            );
            generic_test_response(
                request,
                &format!("v{version}.0.0"),
                &name,
                &serde_json::json!([
                    generic_test_file(77, &name, 'a'),
                    generic_test_file(78, &name, digest)
                ]),
                &head,
            )
        });
        let provider = GitlabReleaseProvider::with_api_root(format!("{root}/api/v4")).unwrap();
        let port = generic_test_port();
        let original = serde_json::to_value(&port).unwrap();
        let first = provider
            .resolve(&port, ReleaseChannel::Stable, Platform::WindowsX86_64)
            .await
            .unwrap();
        assert_eq!(first.version, "v1.0.0");
        assert_eq!(first.asset.sha256, "b".repeat(64));
        version.store(2, Ordering::SeqCst);
        let cached = provider
            .resolve(&port, ReleaseChannel::Stable, Platform::WindowsX86_64)
            .await
            .unwrap();
        assert_eq!(cached.version, first.version);
        for value in provider.cache.write().await.values_mut() {
            value.stored_at -= RELEASE_CACHE_TTL + Duration::from_secs(1);
        }
        let next = provider
            .resolve(&port, ReleaseChannel::Stable, Platform::WindowsX86_64)
            .await
            .unwrap();
        let fresh = GitlabReleaseProvider::with_api_root(format!("{root}/api/v4"))
            .unwrap()
            .resolve(&port, ReleaseChannel::Stable, Platform::WindowsX86_64)
            .await
            .unwrap();
        assert_eq!(next.version, "v2.0.0");
        assert_eq!(next.asset.name, "game-v2-windows-x64.zip");
        assert_eq!(next.asset.sha256, "d".repeat(64));
        assert_eq!(fresh.asset, next.asset);
        assert_eq!(
            next.asset.url,
            format!(
                "{root}/api/v4/projects/group%2Fproject/packages/generic/game/2.0.0/game-v2-windows-x64.zip"
            )
        );
        assert_eq!(serde_json::to_value(&port).unwrap(), original);
        server.join().unwrap();
        let requests: Vec<_> = requests.try_iter().collect();
        assert_eq!(requests.len(), 19);
        assert_eq!(
            requests
                .iter()
                .filter(|request| request.starts_with("HEAD "))
                .count(),
            3
        );
        assert!(!requests.iter().any(|request| {
            request.starts_with("GET /api/v4/projects/group%2Fproject/packages/generic/")
        }));
    }

    #[tokio::test]
    async fn generic_packages_refuse_ambiguous_or_invalid_integrity_without_caching() {
        let valid = "b".repeat(64);
        for (headers, same_hash) in [
            (String::new(), false),
            ("X-Checksum-Sha256: bad\r\n".into(), false),
            (
                format!("X-Checksum-Sha256: {valid}\r\nX-Checksum-Sha256: {valid}\r\n"),
                false,
            ),
            (format!("X-Checksum-Sha256: {}\r\n", "c".repeat(64)), false),
            (
                format!("X-Checksum-Sha256: {valid}\r\nContent-Length: 41\r\n"),
                false,
            ),
            (format!("X-Checksum-Sha256: {valid}\r\n"), true),
        ] {
            let (root, requests, server) = serve_routed_http(6, move |request| {
                let name = "game-windows-x64.zip";
                generic_test_response(
                    request,
                    "v1.0.0",
                    name,
                    &serde_json::json!([
                        generic_test_file(77, name, if same_hash { 'b' } else { 'a' }),
                        generic_test_file(78, name, 'b')
                    ]),
                    &format!("HTTP/1.1 200 OK\r\n{headers}Connection: close\r\n\r\n"),
                )
            });
            let provider = GitlabReleaseProvider::with_api_root(format!("{root}/api/v4")).unwrap();
            let result = provider
                .resolve(
                    &generic_test_port(),
                    ReleaseChannel::Stable,
                    Platform::WindowsX86_64,
                )
                .await;
            assert_eq!(result.unwrap_err().code, crate::ErrorCode::Verification);
            assert!(provider.cache.read().await.is_empty());
            server.join().unwrap();
            assert_eq!(requests.try_iter().count(), 6);
        }
    }

    #[tokio::test]
    async fn generic_packages_check_real_filenames_and_unique_row_integrity() {
        for (name, digest) in [
            ("game-windows-x64.zip", 'b'),
            ("game windows-x64.zip", 'b'),
            ("game-linux-x64.zip", 'b'),
            ("game-windows-arm64.zip", 'b'),
            ("game-windows-x64.exe", 'b'),
            ("game-windows-x64.zip", 'z'),
        ] {
            let (root, requests, server) = serve_routed_http(5, move |request| {
                generic_test_response(
                    request,
                    "v1.0.0",
                    name,
                    &serde_json::json!([generic_test_file(77, name, digest)]),
                    "unexpected HEAD",
                )
            });
            let provider = GitlabReleaseProvider::with_api_root(format!("{root}/api/v4")).unwrap();
            let mut port = generic_test_port();
            port.release.asset_hints.insert(
                Platform::WindowsX86_64,
                vec!["game".into(), "windows".into()],
            );
            let result = provider
                .resolve(&port, ReleaseChannel::Stable, Platform::WindowsX86_64)
                .await;
            if name.ends_with("x64.zip") && !name.contains("linux") && digest == 'b' {
                let resolved = result.unwrap();
                assert_eq!(resolved.asset.name, name);
                assert_eq!(resolved.asset.sha256, "b".repeat(64));
                assert!(resolved.asset.url.starts_with(&root));
            } else {
                assert_eq!(result.unwrap_err().code, crate::ErrorCode::Verification);
                assert!(provider.cache.read().await.is_empty());
            }
            server.join().unwrap();
            assert_eq!(requests.try_iter().count(), 5);
        }
    }

    #[tokio::test]
    async fn generic_packages_consume_later_pages_and_refuse_repeated_identities() {
        for repeated_id in [false, true] {
            let (root, requests, server) = serve_routed_http(7, move |request| {
                let name = "game-windows-x64.zip";
                let files = if request.contains("&page=1 ") {
                    let mut files: Vec<_> = (100..199)
                        .map(|id| generic_test_file(id, "other-windows.zip", 'a'))
                        .collect();
                    files.push(generic_test_file(77, name, 'b'));
                    serde_json::json!(files)
                } else {
                    serde_json::json!([generic_test_file(
                        if repeated_id { 77 } else { 300 },
                        name,
                        'b'
                    )])
                };
                generic_test_response(
                    request,
                    "v1.0.0",
                    name,
                    &files,
                    &format!(
                        "HTTP/1.1 200 OK\r\nX-Checksum-Sha256: {}\r\nContent-Length: 42\r\nConnection: close\r\n\r\n",
                        "b".repeat(64)
                    ),
                )
            });
            let provider = GitlabReleaseProvider::with_api_root(format!("{root}/api/v4")).unwrap();
            let error = provider
                .resolve(
                    &generic_test_port(),
                    ReleaseChannel::Stable,
                    Platform::WindowsX86_64,
                )
                .await
                .unwrap_err();
            assert_eq!(error.code, crate::ErrorCode::Verification);
            assert!(error.message.contains(if repeated_id {
                "repeat an identity"
            } else {
                "exactly one published"
            }));
            assert!(provider.cache.read().await.is_empty());
            server.join().unwrap();
            let requests: Vec<_> = requests.try_iter().collect();
            assert_eq!(requests.len(), if repeated_id { 6 } else { 7 });
            assert!(
                requests
                    .iter()
                    .any(|request| request.contains("/package_files?per_page=100&page=2 "))
            );
            assert_eq!(
                requests
                    .iter()
                    .filter(|request| request.starts_with("HEAD "))
                    .count(),
                usize::from(!repeated_id)
            );
        }
    }

    #[tokio::test]
    async fn generic_packages_read_file_pages_past_the_old_five_page_bound() {
        // The removed bound stopped after 5 pages of 100 files. The upload is on
        // page 7 of 8; a complete read finds it without a HEAD request.
        let (root, requests, server) = serve_routed_http(13, move |request| {
            let name = "game-windows-x64.zip";
            let files = if request.contains("/package_files?") {
                let target = request.split_whitespace().nth(1).unwrap();
                let query = target.split_once('?').unwrap().1;
                let page: u64 = query
                    .split('&')
                    .find_map(|part| part.strip_prefix("page="))
                    .unwrap()
                    .parse()
                    .unwrap();
                let count = if page == 8 { 3 } else { 100 };
                serde_json::json!(
                    (0..count)
                        .map(|index| generic_test_file(
                            page * 100 + index,
                            if page == 7 && index == 42 {
                                name
                            } else {
                                "other-windows.zip"
                            },
                            'b'
                        ))
                        .collect::<Vec<_>>()
                )
            } else {
                serde_json::json!([])
            };
            generic_test_response(request, "v1.0.0", name, &files, "unexpected HEAD")
        });
        let provider = GitlabReleaseProvider::with_api_root(format!("{root}/api/v4")).unwrap();
        let resolved = provider
            .resolve(
                &generic_test_port(),
                ReleaseChannel::Stable,
                Platform::WindowsX86_64,
            )
            .await
            .unwrap();
        assert_eq!(resolved.asset.sha256, "b".repeat(64));
        server.join().unwrap();
        let requests: Vec<_> = requests.try_iter().collect();
        // Project, releases, two filtered package reads and eight file pages.
        assert_eq!(requests.len(), 12, "{requests:#?}");
        assert!(!requests.iter().any(|request| request.starts_with("HEAD ")));
    }

    #[tokio::test]
    async fn generic_packages_head_respects_cancellation_and_network_deadlines() {
        for cancel in [false, true] {
            let entered = Arc::new(tokio::sync::Notify::new());
            let observed = entered.clone();
            let (release, wait) = std::sync::mpsc::channel();
            let (root, requests, server) = serve_routed_http(6, move |request| {
                if request.starts_with("HEAD ") {
                    observed.notify_one();
                    wait.recv_timeout(Duration::from_secs(3)).unwrap();
                }
                let name = "game-windows-x64.zip";
                generic_test_response(
                    request,
                    "v1.0.0",
                    name,
                    &serde_json::json!([
                        generic_test_file(77, name, 'a'),
                        generic_test_file(78, name, 'b')
                    ]),
                    &format!(
                        "HTTP/1.1 200 OK\r\nX-Checksum-Sha256: {}\r\nContent-Length: 42\r\nConnection: close\r\n\r\n",
                        "b".repeat(64)
                    ),
                )
            });
            let provider = GitlabReleaseProvider::with_api_root_and_bounds(
                format!("{root}/api/v4"),
                ProviderNetworkBounds {
                    connect: Duration::from_secs(2),
                    read_idle: if cancel {
                        Duration::from_secs(2)
                    } else {
                        Duration::from_millis(200)
                    },
                    request: if cancel {
                        Duration::from_secs(4)
                    } else {
                        Duration::from_millis(500)
                    },
                },
            )
            .unwrap();
            let current = provider.clone();
            let task = tokio::spawn(async move {
                current
                    .resolve(
                        &generic_test_port(),
                        ReleaseChannel::Stable,
                        Platform::WindowsX86_64,
                    )
                    .await
            });
            tokio::time::timeout(Duration::from_secs(2), entered.notified())
                .await
                .unwrap();
            if cancel {
                task.abort();
                assert!(task.await.unwrap_err().is_cancelled());
            } else {
                assert_eq!(
                    task.await.unwrap().unwrap_err().code,
                    crate::ErrorCode::Network
                );
            }
            assert!(provider.cache.read().await.is_empty());
            release.send(()).unwrap();
            if let Err(error) = server.join() {
                assert!(
                    matches!(
                        error.kind(),
                        std::io::ErrorKind::BrokenPipe
                            | std::io::ErrorKind::ConnectionReset
                            | std::io::ErrorKind::ConnectionAborted
                    ),
                    "{error}"
                );
            }
            assert!(requests.try_iter().all(|request| {
                !request.starts_with("GET /api/v4/projects/group%2Fproject/packages/generic/")
            }));
        }
    }

    #[tokio::test]
    async fn generic_packages_refuse_foreign_or_decorated_urls_before_registry_or_head() {
        for replacement in [
            "/projects/other%2Fproject/packages/generic/game/1.0.0/game-windows-x64.zip",
            "https://elsewhere.invalid/api/v4/projects/9/packages/generic/game/1.0.0/game-windows-x64.zip",
            "/projects/group%2Fproject/packages/generic/game/1.0.0/game-windows-x64.zip?token=hidden",
            "/projects/group%2Fproject/packages/generic/game/1.0.0/game-windows-x64.zip#fragment",
        ] {
            let (root, requests, server) = serve_routed_http(2, move |request| {
                let response = generic_test_response(
                    request,
                    "v1.0.0",
                    "game-windows-x64.zip",
                    &serde_json::json!([]),
                    "unexpected HEAD",
                );
                if request.contains("/releases?") {
                    let mut releases: serde_json::Value =
                        serde_json::from_str(response.split_once("\r\n\r\n").unwrap().1).unwrap();
                    let old = releases[0]["assets"]["links"][0]["url"].as_str().unwrap();
                    let origin = old.split("/api/v4/").next().unwrap();
                    releases[0]["assets"]["links"][0]["url"] =
                        serde_json::json!(if replacement.starts_with("https:") {
                            replacement.to_owned()
                        } else {
                            format!("{origin}/api/v4{replacement}")
                        });
                    ok_json(&releases.to_string(), "")
                } else {
                    response
                }
            });
            let provider = GitlabReleaseProvider::with_api_root(format!("{root}/api/v4")).unwrap();
            let error = provider
                .resolve(
                    &generic_test_port(),
                    ReleaseChannel::Stable,
                    Platform::WindowsX86_64,
                )
                .await
                .unwrap_err();
            assert_eq!(error.code, crate::ErrorCode::Verification);
            assert!(error.message.contains("exact official package endpoint"));
            assert!(provider.cache.read().await.is_empty());
            server.join().unwrap();
            assert_eq!(requests.try_iter().count(), 2);
        }
    }

    #[tokio::test]
    async fn generic_packages_do_not_follow_head_redirects_or_cache_them() {
        let (root, requests, server) = serve_routed_http(7, move |request| {
            let name = "game-windows-x64.zip";
            if request.starts_with("HEAD /alternate ") {
                return format!(
                    "HTTP/1.1 200 OK\r\nX-Checksum-Sha256: {}\r\nContent-Length: 42\r\nConnection: close\r\n\r\n",
                    "b".repeat(64)
                );
            }
            generic_test_response(
                request,
                "v1.0.0",
                name,
                &serde_json::json!([
                    generic_test_file(77, name, 'a'),
                    generic_test_file(78, name, 'b')
                ]),
                "HTTP/1.1 302 Found\r\nLocation: /alternate\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            )
        });
        let provider = GitlabReleaseProvider::with_api_root(format!("{root}/api/v4")).unwrap();
        let error = provider
            .resolve(
                &generic_test_port(),
                ReleaseChannel::Stable,
                Platform::WindowsX86_64,
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Network);
        assert!(error.message.contains("302"));
        assert!(provider.cache.read().await.is_empty());
        server.join().unwrap();
        let requests: Vec<_> = requests.try_iter().collect();
        assert_eq!(requests.len(), 6);
        assert!(
            !requests
                .iter()
                .any(|request| request.contains("/alternate "))
        );
    }

    #[test]
    fn generic_package_urls_bind_the_official_project_and_exact_path() {
        let api = "https://gitlab.example/api/v4";
        let project = format!("{api}/projects/group%2Fproject");
        for prefix in [&project, &format!("{api}/projects/9")] {
            assert!(
                generic_package_url(
                    &project,
                    api,
                    9,
                    &format!("{prefix}/packages/generic/game/1/game-windows.zip")
                )
                .unwrap()
                .is_some()
            );
        }
        for url in [
            format!("{api}/projects/10/packages/generic/game/1/game.zip"),
            "https://elsewhere.invalid/api/v4/projects/9/packages/generic/game/1/game.zip".into(),
            "https://user@gitlab.example/api/v4/projects/9/packages/generic/game/1/game.zip".into(),
            format!("{project}/packages/generic/game/1/game.zip?token=hidden"),
            format!("{project}/packages/generic/game/1/game.zip#fragment"),
            format!("{project}/packages/generic/game/1/../game.zip"),
            format!("{project}/packages/generic/game//game.zip"),
        ] {
            assert!(generic_package_url(&project, api, 9, &url).is_err());
        }
        assert!(
            generic_package_url(&project, api, 9, "https://downloads.example/game.zip")
                .unwrap()
                .is_none()
        );
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
        assert_eq!(
            error.presentation().presentation_key,
            "provider_rate_limited"
        );
        assert!(error.presentation().summary.contains("GitLab"));
        assert!(
            error
                .presentation()
                .summary
                .contains("1970-01-01T00:20:34Z")
        );
    }

    #[test]
    fn equally_scored_gitlab_links_are_ambiguous() {
        let catalog = crate::Catalog::embedded().unwrap();
        let port = catalog.port("extreme-g-recompiled").unwrap();
        let links = [
            GitlabReleaseLink {
                id: None,
                name: "ExtremeG-Windows-RelWithDebInfo-one.zip".into(),
                url: "https://example.invalid/one.zip".into(),
                direct_asset_url: None,
                link_type: "package".into(),
            },
            GitlabReleaseLink {
                id: None,
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

    /// Release links apply the same typed-role gate as every other route
    /// (#8602): host-named debug, source and installer links that match the
    /// reviewed hint never become the game package, with or without a file
    /// extension in the link label, and the refusal is typed.
    #[test]
    fn gitlab_links_refuse_wrong_role_downloads_that_match_the_hint() {
        let catalog = crate::Catalog::embedded().unwrap();
        let port = catalog.port("extreme-g-recompiled").unwrap();
        let link = |name: &str| GitlabReleaseLink {
            id: None,
            name: name.into(),
            url: "https://example.invalid/package".into(),
            direct_asset_url: None,
            link_type: "package".into(),
        };
        let game = "ExtremeGRecompiled-v1.0.0-Windows-RelWithDebInfo";
        let decoys = [
            "ExtremeGRecompiled-v1.0.0-Windows-RelWithDebInfo-debug.zip",
            "ExtremeGRecompiled-v1.0.0-Windows-RelWithDebInfo-debug",
            "ExtremeGRecompiled-v1.0.0-Windows-RelWithDebInfo-source.zip",
            "ExtremeGRecompiled-v1.0.0-Windows-RelWithDebInfo-Source",
            "ExtremeGRecompiled-v1.0.0-Windows-RelWithDebInfo-setup.exe",
            "ExtremeGRecompiled-v1.0.0-Windows-RelWithDebInfo-Installer",
            "ExtremeGRecompiled-v1.0.0-Windows-RelWithDebInfo-Installer.zip",
        ];
        for decoy in decoys {
            let error = choose_link(port, Platform::WindowsX86_64, &[link(decoy)]).unwrap_err();
            assert_eq!(error.code, crate::ErrorCode::NotFound, "{decoy}");
            assert_eq!(
                error.details.get("route_hold").map(String::as_str),
                Some("wrong-role"),
                "{decoy}"
            );
            let mut links = vec![link(decoy), link(game)];
            assert_eq!(
                choose_link(port, Platform::WindowsX86_64, &links)
                    .unwrap()
                    .name,
                game,
                "{decoy}"
            );
            links.reverse();
            assert_eq!(
                choose_link(port, Platform::WindowsX86_64, &links)
                    .unwrap()
                    .name,
                game,
                "{decoy}"
            );
        }
        // Another host's decoy is refused by host, not as a wrong role.
        let error = choose_link(
            port,
            Platform::WindowsX86_64,
            &[link(
                "ExtremeGRecompiled-v1.0.0-Linux-X64-Release-source.zip",
            )],
        )
        .unwrap_err();
        assert!(error.details.get("route_hold").is_none(), "{error:?}");
    }

    /// A neutral link label cannot carry a wrong-role registry file past the
    /// gate: the final filename is gated again before anything is cached.
    #[test]
    fn gitlab_final_filename_refuses_a_wrong_role_package() {
        let catalog = crate::Catalog::embedded().unwrap();
        let port = catalog.port("extreme-g-recompiled").unwrap();
        let link = GitlabReleaseLink {
            id: None,
            name: "ExtremeGRecompiled-v1.0.0-Windows-RelWithDebInfo".into(),
            url: "https://example.invalid/package".into(),
            direct_asset_url: None,
            link_type: "package".into(),
        };
        let release = GitlabRelease {
            tag_name: "v1.0.0".into(),
            name: None,
            description: String::new(),
            released_at: None,
            upcoming_release: false,
            assets: GitlabReleaseAssets { links: Vec::new() },
        };
        let observed = |file_name: &str| GitlabObservedAsset {
            package_file: Some(GitlabPackageFile {
                id: 1,
                file_name: file_name.into(),
                size: 1,
                file_sha256: "a".repeat(64),
            }),
            generic: None,
            description_digest: None,
        };
        for file_name in [
            "ExtremeGRecompiled-v1.0.0-Windows-RelWithDebInfo-source.zip",
            "ExtremeGRecompiled-v1.0.0-Windows-RelWithDebInfo-debug.zip",
            "ExtremeGRecompiled-v1.0.0-Windows-RelWithDebInfo-setup.exe",
        ] {
            let error = resolve_observed_asset(
                port,
                ReleaseChannel::Stable,
                Platform::WindowsX86_64,
                &release,
                &link,
                observed(file_name),
            )
            .unwrap_err();
            assert_eq!(error.code, crate::ErrorCode::Verification, "{file_name}");
            assert_eq!(
                error.details.get("route_hold").map(String::as_str),
                Some("wrong-role"),
                "{file_name}"
            );
        }
        let resolved = resolve_observed_asset(
            port,
            ReleaseChannel::Stable,
            Platform::WindowsX86_64,
            &release,
            &link,
            observed("ExtremeGRecompiled-v1.0.0-Windows-RelWithDebInfo.zip"),
        )
        .unwrap();
        assert_eq!(
            resolved.asset.name,
            "ExtremeGRecompiled-v1.0.0-Windows-RelWithDebInfo.zip"
        );
    }

    #[test]
    fn executable_parent_n64_links_require_the_selected_native_archive_variant() {
        let catalog = crate::Catalog::embedded().unwrap();
        let mut port = catalog.port("road-rash-64-recompiled").unwrap().clone();
        port.n64_runtime_at_executable_parent = true;
        port.release
            .asset_hints
            .insert(Platform::WindowsX86_64, vec!["win64".into()]);
        let link = |name: &str| GitlabReleaseLink {
            id: None,
            name: name.into(),
            url: "https://example.invalid/package.zip".into(),
            direct_asset_url: None,
            link_type: "package".into(),
        };
        for name in [
            "RoadRash64Recompiled-v1.4.9-Source.zip",
            "RoadRash64Recompiled-v1.4.9-Win32.zip",
            "RoadRash64Recompiled-v1.4.9-WinARM64.zip",
            "RoadRash64Recompiled-v1.4.9-Win64-source.zip",
        ] {
            assert_eq!(
                choose_link(&port, Platform::WindowsX86_64, &[link(name)])
                    .unwrap_err()
                    .code,
                crate::ErrorCode::NotFound,
                "{name}"
            );
        }
        let links = [link("RoadRash64Recompiled-v1.4.9-Win64.zip")];
        assert_eq!(
            choose_link(&port, Platform::WindowsX86_64, &links)
                .unwrap()
                .name,
            links[0].name
        );
        let ambiguous = [
            link("RoadRash64Recompiled-one-Win64.zip"),
            link("RoadRash64Recompiled-two-Win64.zip"),
        ];
        assert_eq!(
            choose_link(&port, Platform::WindowsX86_64, &ambiguous)
                .unwrap_err()
                .code,
            crate::ErrorCode::Conflict
        );
    }

    #[tokio::test]
    async fn executable_parent_n64_checks_the_final_gitlab_package_filename_before_caching() {
        let catalog = crate::Catalog::embedded().unwrap();
        let mut port = catalog.port("road-rash-64-recompiled").unwrap().clone();
        port.n64_runtime_at_executable_parent = true;
        port.release
            .asset_hints
            .insert(Platform::WindowsX86_64, vec!["win64".into()]);
        port.release.provider = ReleaseSource::Gitlab;
        port.release.repository = "group/project".into();
        let selected_name = "RoadRash64Recompiled-v1.4.8-Win64.zip";
        let display_name = "RoadRash64Recompiled-v1.4.8-Win64";
        for name in [
            "RoadRash64Recompiled-v1.4.8-Source.zip",
            "RoadRash64Recompiled-v1.4.8-Win64.exe",
            selected_name,
        ] {
            let releases = serde_json::json!([{
                "tag_name":"v1.4.8", "description":"", "assets":{"links":[{
                    "name":display_name,"link_type":"package",
                    "url":"https://gitlab.com/group/project/-/package_files/77/download"
                }]}
            }]);
            let files = serde_json::json!([{"id":77,"file_name":name,"size":42,"file_sha256":"b".repeat(64)}]);
            let (root, requests, server) = serve_http(vec![
                ok_json(r#"{"id":9,"archived":false}"#, ""),
                ok_json(&releases.to_string(), ""),
                ok_json(r#"[{"id":501,"version":"v1.4.8"}]"#, ""),
                // The unprefixed version filter matches no further package.
                ok_json("[]", ""),
                ok_json(&files.to_string(), ""),
            ]);
            let provider = GitlabReleaseProvider::with_api_root(format!("{root}/api/v4")).unwrap();
            let result = provider
                .resolve(&port, ReleaseChannel::Stable, Platform::WindowsX86_64)
                .await;
            server.join().unwrap();
            assert_eq!(requests.try_iter().count(), 5);
            if name == selected_name {
                assert_eq!(result.unwrap().asset.name, selected_name);
            } else {
                let error = result.unwrap_err();
                assert_eq!(error.code, crate::ErrorCode::Verification);
                if name.ends_with("-Source.zip") {
                    assert_eq!(
                        error.details.get("route_hold").map(String::as_str),
                        Some("wrong-role")
                    );
                }
                assert!(provider.cache.read().await.is_empty());
            }
        }
    }

    fn release_row(tag: &str) -> serde_json::Value {
        serde_json::json!({"tag_name": tag, "upcoming_release": false, "assets": {"links": []}})
    }

    fn query_number(request: &str, name: &str) -> usize {
        let target = request.split_whitespace().nth(1).unwrap();
        let url = reqwest::Url::parse(&format!("http://fixture{target}")).unwrap();
        url.query_pairs()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.parse().unwrap())
            .unwrap()
    }

    /// A simulated newest-first history of `total` releases: release `n` (1 is
    /// the newest) is tagged by `tag(n)`.
    fn release_history_page(request: &str, total: usize, tag: impl Fn(usize) -> String) -> String {
        let page = query_number(request, "page");
        let first = (page - 1) * PROVIDER_PAGE_SIZE + 1;
        let rows = (first..=total.min(first + PROVIDER_PAGE_SIZE - 1))
            .map(|index| release_row(&tag(index)))
            .collect::<Vec<_>>();
        ok_json(&serde_json::to_string(&rows).unwrap(), "")
    }

    // The removed `GITLAB_MAX_RELEASE_PAGES` stopped at 10 pages of 100.
    const OLD_RELEASE_WINDOW: usize = 1_000;

    #[tokio::test]
    async fn gitlab_release_history_reads_ten_times_past_the_old_thousand_release_window() {
        let total = 10 * OLD_RELEASE_WINDOW + 1;
        let pages = total.div_ceil(PROVIDER_PAGE_SIZE);
        let (root, requests, server) = serve_routed_http(pages, move |request| {
            release_history_page(request, total, |index| format!("v0.0.{index}"))
        });
        let provider = GitlabReleaseProvider::with_api_root(format!("{root}/api/v4")).unwrap();
        let releases = provider
            .releases(&provider.project_url("group/project").unwrap())
            .await
            .unwrap();
        server.join().unwrap();
        assert_eq!(releases.len(), total);
        assert_eq!(releases[total - 1].tag_name, format!("v0.0.{total}"));
        assert_eq!(requests.try_iter().count(), pages);
    }

    #[tokio::test]
    async fn gitlab_stable_selection_finds_a_release_beyond_the_old_window_and_stops_there() {
        // Only prereleases inside the old window; the first stable release is
        // the 1,001st. Selection reads that page and no further.
        let total = 2 * OLD_RELEASE_WINDOW;
        let (root, requests, server) = serve_routed_http(11, move |request| {
            release_history_page(request, total, |index| {
                if index <= OLD_RELEASE_WINDOW {
                    format!("v9.0.{index}-beta")
                } else {
                    format!("v1.0.{index}")
                }
            })
        });
        let provider = GitlabReleaseProvider::with_api_root(format!("{root}/api/v4")).unwrap();
        let release = provider
            .channel_release(
                &provider.project_url("group/project").unwrap(),
                ReleaseChannel::Stable,
                None,
                provider.operation_deadline(),
            )
            .await
            .unwrap()
            .unwrap();
        server.join().unwrap();
        assert_eq!(release.tag_name, "v1.0.1001");
        assert_eq!(requests.try_iter().count(), 11);

        // The newest release decides Stable on the first page.
        let (root, requests, server) = serve_routed_http(1, move |request| {
            release_history_page(request, total, |index| format!("v1.0.{index}"))
        });
        let provider = GitlabReleaseProvider::with_api_root(format!("{root}/api/v4")).unwrap();
        let release = provider
            .channel_release(
                &provider.project_url("group/project").unwrap(),
                ReleaseChannel::Stable,
                None,
                provider.operation_deadline(),
            )
            .await
            .unwrap()
            .unwrap();
        server.join().unwrap();
        assert_eq!(release.tag_name, "v1.0.1");
        assert_eq!(requests.try_iter().count(), 1);
    }

    #[tokio::test]
    async fn gitlab_rolling_tag_is_looked_up_exactly_instead_of_scanning_history() {
        // The rolling tag would sit far beyond the old window in history; the
        // exact endpoint finds it with one request and reads no history.
        let (root, requests, server) = serve_routed_http(1, |request| {
            assert!(
                request.starts_with("GET /api/v4/projects/group%2Fproject/releases/nightly "),
                "{request}"
            );
            ok_json(&release_row("nightly").to_string(), "")
        });
        let provider = GitlabReleaseProvider::with_api_root(format!("{root}/api/v4")).unwrap();
        let release = provider
            .channel_release(
                &provider.project_url("group/project").unwrap(),
                ReleaseChannel::Rolling,
                Some("nightly"),
                provider.operation_deadline(),
            )
            .await
            .unwrap()
            .unwrap();
        server.join().unwrap();
        assert_eq!(release.tag_name, "nightly");
        assert_eq!(requests.try_iter().count(), 1);

        // A missing rolling release is absent only because the exact lookup said so.
        let (root, _requests, server) = serve_routed_http(1, |_| {
            "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into()
        });
        let provider = GitlabReleaseProvider::with_api_root(format!("{root}/api/v4")).unwrap();
        assert!(
            provider
                .channel_release(
                    &provider.project_url("group/project").unwrap(),
                    ReleaseChannel::Rolling,
                    Some("nightly"),
                    provider.operation_deadline(),
                )
                .await
                .unwrap()
                .is_none()
        );
        server.join().unwrap();
    }

    #[tokio::test]
    async fn gitlab_release_published_mid_read_neither_repeats_nor_hides_a_release() {
        // 250 releases; after page 1 is read, three more are published, so every
        // older release shifts three places onto later pages.
        let published = Arc::new(AtomicUsize::new(0));
        let observed = published.clone();
        let (root, _requests, server) = serve_routed_http(3, move |request| {
            let page = query_number(request, "page");
            let added = if page == 1 { 0 } else { 3 };
            observed.store(added, Ordering::SeqCst);
            let first = (page - 1) * PROVIDER_PAGE_SIZE + 1;
            let rows = (first..=(250 + added).min(first + PROVIDER_PAGE_SIZE - 1))
                .map(|position| {
                    // Positions 1..=added are the new releases.
                    if position <= added {
                        release_row(&format!("v2.0.{position}"))
                    } else {
                        release_row(&format!("v1.0.{}", position - added))
                    }
                })
                .collect::<Vec<_>>();
            ok_json(&serde_json::to_string(&rows).unwrap(), "")
        });
        let provider = GitlabReleaseProvider::with_api_root(format!("{root}/api/v4")).unwrap();
        let releases = provider
            .releases(&provider.project_url("group/project").unwrap())
            .await
            .unwrap();
        server.join().unwrap();
        assert_eq!(published.load(Ordering::SeqCst), 3);
        let tags = releases
            .iter()
            .map(|release| release.tag_name.as_str())
            .collect::<HashSet<_>>();
        assert_eq!(tags.len(), releases.len(), "no release is listed twice");
        for index in 1..=250 {
            assert!(
                tags.contains(format!("v1.0.{index}").as_str()),
                "v1.0.{index}"
            );
        }
    }

    #[tokio::test]
    async fn gitlab_package_lookup_filters_by_release_version_and_checks_every_match() {
        // Twenty matching packages: more than the removed 16-package ceiling. The
        // registry is asked only for this release's versions, never for its
        // unrelated package history; the file is in the last package.
        let (root, requests, server) = serve_routed_http(22, |request| {
            if request.contains("/package_files?") {
                let files = if request.contains("packages/20/package_files") {
                    serde_json::json!([{
                        "id": 77, "file_name": "game.zip", "size": 42,
                        "file_sha256": "a".repeat(64)
                    }])
                } else {
                    serde_json::json!([])
                };
                return ok_json(&files.to_string(), "");
            }
            let packages = if request.contains("package_version=v1.0.0") {
                (1..=10)
                    .map(|id| serde_json::json!({"id": id, "version": "v1.0.0"}))
                    .collect::<Vec<_>>()
            } else {
                assert!(request.contains("package_version=1.0.0&"), "{request}");
                (11..=20)
                    .map(|id| serde_json::json!({"id": id, "version": "1.0.0"}))
                    .collect()
            };
            ok_json(&serde_json::to_string(&packages).unwrap(), "")
        });
        let provider = GitlabReleaseProvider::with_api_root(format!("{root}/api/v4")).unwrap();
        let release = GitlabRelease {
            tag_name: "v1.0.0".into(),
            name: None,
            description: String::new(),
            released_at: None,
            upcoming_release: false,
            assets: GitlabReleaseAssets { links: vec![] },
        };
        let link = GitlabReleaseLink {
            id: None,
            name: "game.zip".into(),
            url: format!("{root}/group/project/-/package_files/77/download"),
            direct_asset_url: None,
            link_type: "package".into(),
        };
        let file = provider
            .package_file(
                &provider.project_url("group/project").unwrap(),
                9,
                &release,
                &link,
                provider.operation_deadline(),
            )
            .await
            .unwrap()
            .unwrap();
        server.join().unwrap();
        assert_eq!(file.id, 77);
        let requests = requests.try_iter().collect::<Vec<_>>();
        assert_eq!(requests.len(), 22);
        assert!(
            requests
                .iter()
                .filter(|request| request.contains("/packages?"))
                .all(|request| request.contains("package_type=generic")
                    && request.contains("package_version="))
        );
    }

    #[tokio::test]
    async fn gitlab_budget_exhaustion_is_incomplete_and_a_retry_resumes_from_cached_pages() {
        // Four pages. The first read spends its whole budget after two pages; it
        // reports an incomplete inventory, never a short history. Pages already
        // read are revalidated with their validators (304, no body) on the
        // retry, which then finishes the history.
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path()).unwrap();
        let total = 3 * PROVIDER_PAGE_SIZE + 50;
        let (root, requests, server) = serve_routed_http(6, move |request| {
            let page = query_number(request, "page");
            let etag = format!("\"page-{page}\"");
            if request
                .lines()
                .any(|line| line.eq_ignore_ascii_case(&format!("if-none-match: {etag}")))
            {
                return "HTTP/1.1 304 Not Modified\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    .into();
            }
            release_history_page(request, total, |index| format!("v0.0.{index}")).replacen(
                "\r\n",
                &format!("\r\nETag: {etag}\r\n"),
                1,
            )
        });
        let provider =
            GitlabReleaseProvider::with_api_root_and_library(format!("{root}/api/v4"), library)
                .unwrap();
        let project_url = provider.project_url("group/project").unwrap();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        let error = provider
            .release_prefix(&project_url, deadline, |releases, _| {
                if releases.len() == 2 * PROVIDER_PAGE_SIZE {
                    // Simulate the budget running out while the history continues.
                    std::thread::sleep(deadline - tokio::time::Instant::now());
                }
                false
            })
            .await
            .unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Network);
        assert_eq!(
            error.details.get("inventory").map(String::as_str),
            Some("incomplete")
        );
        assert_eq!(
            error.details.get("pages_read").map(String::as_str),
            Some("2")
        );
        let releases = provider.releases(&project_url).await.unwrap();
        server.join().unwrap();
        assert_eq!(releases.len(), total);
        assert_eq!(releases[total - 1].tag_name, format!("v0.0.{total}"));
        let requests = requests.try_iter().collect::<Vec<_>>();
        let transferred = requests
            .iter()
            .filter(|request| !request.to_ascii_lowercase().contains("if-none-match"))
            .count();
        // Every page's body was transferred once; the retry only revalidated the prefix.
        assert_eq!((requests.len(), transferred), (6, 4), "{requests:?}");
    }

    #[tokio::test]
    async fn gitlab_package_file_requests_use_the_documented_concurrency_bound() {
        #[derive(Default)]
        struct LookupWindow {
            arrivals: usize,
            released: bool,
        }

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let active = Arc::new(AtomicUsize::new(0));
        let maximum = Arc::new(AtomicUsize::new(0));
        let measured = maximum.clone();
        let first_wave = Arc::new((Mutex::new(LookupWindow::default()), Condvar::new()));
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 16 * 1024];
            let _ = stream.read(&mut request).unwrap();
            let packages = (1..=8)
                .map(|id| serde_json::json!({"id": id, "version": "1.0.0"}))
                .collect::<Vec<_>>();
            stream
                .write_all(ok_json(&serde_json::to_string(&packages).unwrap(), "").as_bytes())
                .unwrap();

            let mut workers = Vec::new();
            for _ in 0..8 {
                let (mut stream, _) = listener.accept().unwrap();
                let active = active.clone();
                let maximum = maximum.clone();
                let first_wave = first_wave.clone();
                workers.push(thread::spawn(move || {
                    let mut request = [0_u8; 16 * 1024];
                    let _ = stream.read(&mut request).unwrap();
                    let (window, ready) = &*first_wave;
                    let mut wave = window.lock().unwrap();
                    let current = active.fetch_add(1, Ordering::SeqCst) + 1;
                    maximum.fetch_max(current, Ordering::SeqCst);
                    wave.arrivals += 1;
                    if wave.arrivals == GITLAB_PACKAGE_LOOKUP_CONCURRENCY {
                        // Observe overfill only after the expected window is full.
                        drop(wave);
                        thread::sleep(Duration::from_millis(50));
                        wave = window.lock().unwrap();
                        wave.released = true;
                        ready.notify_all();
                    }
                    // Hold the initial responses until the client fills its request window.
                    let (wave, _) = ready
                        .wait_timeout_while(wave, Duration::from_secs(5), |wave| !wave.released)
                        .unwrap();
                    let filled_window = wave.released;
                    drop(wave);
                    active.fetch_sub(1, Ordering::SeqCst);
                    stream
                        .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n[]")
                        .unwrap();
                    filled_window
                }));
            }
            let mut filled_window = true;
            for worker in workers {
                filled_window &= worker.join().unwrap();
            }
            assert!(filled_window, "initial package lookup window did not fill");
        });
        let server_root = format!("http://{address}");
        let provider =
            GitlabReleaseProvider::with_api_root(format!("{server_root}/api/v4")).unwrap();
        let release = GitlabRelease {
            tag_name: "1.0.0".into(),
            name: None,
            description: String::new(),
            released_at: None,
            upcoming_release: false,
            assets: GitlabReleaseAssets { links: vec![] },
        };
        let link = GitlabReleaseLink {
            id: None,
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
                    &link,
                    provider.operation_deadline(),
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
    async fn gitlab_release_cache_is_scoped_to_the_complete_current_selector() {
        let releases = gitlab_selector_releases();
        let (server_root, requests, server) = serve_routed_http(9, move |request| {
            if request.contains("/releases?") {
                ok_json(&releases, "")
            } else if let Some(tag) = ["nightly-a", "nightly-b"]
                .into_iter()
                .find(|tag| request.contains(&format!("/releases/{tag} ")))
            {
                // A rolling tag is read by the exact release endpoint.
                let releases: Vec<serde_json::Value> = serde_json::from_str(&releases).unwrap();
                let release = releases
                    .into_iter()
                    .find(|release| release["tag_name"] == tag)
                    .unwrap();
                ok_json(&release.to_string(), "")
            } else {
                ok_json(r#"{"id":9,"archived":false}"#, "")
            }
        });
        let provider =
            GitlabReleaseProvider::with_api_root(format!("{server_root}/api/v4")).unwrap();
        let catalog = crate::Catalog::embedded().unwrap();
        let mut first = catalog.port("extreme-g-recompiled").unwrap().clone();
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
        // Two Stable selectors read history; the two rolling selectors use the
        // exact release endpoint.
        assert_eq!(
            requests
                .iter()
                .filter(|request| request.contains("/releases?"))
                .count(),
            2
        );
        assert_eq!(
            requests
                .iter()
                .filter(|request| request.contains("/releases/nightly-"))
                .count(),
            2
        );
    }

    #[tokio::test]
    async fn concurrent_gitlab_selectors_do_not_share_a_selected_result() {
        let releases = gitlab_selector_releases();
        let (server_root, requests, server) = serve_routed_http(6, move |request| {
            if request.contains("/releases?") {
                ok_json(&releases, "")
            } else {
                ok_json(r#"{"id":9,"archived":false}"#, "")
            }
        });
        let provider =
            GitlabReleaseProvider::with_api_root(format!("{server_root}/api/v4")).unwrap();
        let catalog = crate::Catalog::embedded().unwrap();
        let mut first = catalog.port("extreme-g-recompiled").unwrap().clone();
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

    #[tokio::test]
    async fn gitlab_archived_upstream_keeps_exact_release_usable_but_metadata_failure_still_holds()
    {
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
        let cached = provider
            .resolve(port, ReleaseChannel::Stable, Platform::WindowsX86_64)
            .await
            .unwrap();
        server.join().unwrap();
        assert_eq!(cached.asset.sha256, "a".repeat(64));
        assert_eq!(requests.try_iter().count(), 3);

        let responses = vec![
            ok_json(r#"{"id":9,"archived":true}"#, ""),
            ok_json(&release_body, ""),
        ];
        let (server_root, _, server) = serve_http(responses);
        let provider =
            GitlabReleaseProvider::with_api_root(format!("{server_root}/api/v4")).unwrap();
        let archived = provider
            .resolve(port, ReleaseChannel::Stable, Platform::WindowsX86_64)
            .await
            .unwrap();
        server.join().unwrap();
        assert_eq!(archived.asset.sha256, cached.asset.sha256);

        let mut missing_digest = gitlab_release("https://downloads.example.invalid/extreme-g.zip");
        missing_digest["description"] = serde_json::json!("");
        let missing_digest_body = serde_json::to_string(&vec![missing_digest]).unwrap();
        let responses = vec![
            ok_json(r#"{"id":9,"archived":true}"#, ""),
            ok_json(&missing_digest_body, ""),
        ];
        let (server_root, _, server) = serve_http(responses);
        let provider =
            GitlabReleaseProvider::with_api_root(format!("{server_root}/api/v4")).unwrap();
        let error = provider
            .resolve(port, ReleaseChannel::Stable, Platform::WindowsX86_64)
            .await
            .unwrap_err();
        server.join().unwrap();
        assert_eq!(error.code, crate::ErrorCode::Verification);

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
