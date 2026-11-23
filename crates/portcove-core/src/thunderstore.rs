//! Thunderstore adapter: community package observations and canonical downloads,
//! never trust or compatibility.
//!
//! Evidence (November 12 and 23, 2026, live, unauthenticated reads): the
//! community listing index `/c/<community>/api/v1/package-listing-index/`
//! redirects to a gzip-compressed JSON list of chunk URLs on
//! `ccdn.thunderstore.io`; each chunk is a gzip-compressed JSON list of packages
//! in the same shape as the single-response `/c/<community>/api/v1/package/`
//! listing, with all versions (version number, size, creation date,
//! dependencies, `is_active`). Chunk URLs are content-addressed (`sha256/...`),
//! so a chunk read once stays valid until the index names another one. A large
//! community spans many chunks (26 for one community on November 23, 2026,
//! each about 0.7 MiB compressed and 14 MiB of JSON), so the single-response
//! listing cannot carry it within one bounded response;
//! `/package/download/<namespace>/<name>/<version>/`
//! redirects to the package zip on `ccdn.thunderstore.io`. A package is named
//! `<namespace>-<name>` and a version is `major.minor.patch`; Thunderstore publishes
//! each version once, so a version stands for one file. No digest is offered, so
//! the computed SHA-256 is the only byte identity.
use std::path::Path;

use serde_json::Value;

use crate::{
    Library, PortcoveError, ProviderFreshness, Result,
    mod_provider::{
        Observed, ProviderFileCandidate, ProviderListing, ProviderPage, ProviderProject,
        ThunderstoreDependency, artwork_url, sanitize_text,
    },
    provider_http::ProviderHttp,
};

pub const PROVIDER: &str = "thunderstore";
const WEB_ROOT: &str = "https://thunderstore.io";
/// Bounds on one listing-index or chunk response. They bound each request, not
/// the community: a community of any size is read as more chunks.
/// Compressed bytes of one response; observed chunks are about 0.7 MiB.
pub(crate) const MAX_COMPRESSED_BYTES: usize = 32 * 1024 * 1024;
/// Decompressed JSON of one response (decompression guard); observed chunks are
/// about 14 MiB and are parsed one package at a time.
const MAX_DECOMPRESSED_BYTES: u64 = 256 * 1024 * 1024;
/// Compressed chunks kept for continuing an interrupted read, least recently
/// used first out. A resource budget: the largest community observed on
/// November 23, 2026 was about 19 MiB compressed. A community larger than the
/// store still completes in one uninterrupted read; only continuation after
/// an interruption re-reads chunks the store could not keep.
const CHUNK_STORE_MAX_BYTES: u64 = 512 * 1024 * 1024;
/// Parsed communities kept in memory, keyed by their chunk lists.
const SNAPSHOT_COMMUNITIES: usize = 4;
const MAX_DEPENDENCIES: usize = 128;

/// Reviewed port → Thunderstore community bindings. A community's own listing is
/// the only route; a package is never matched to a game by name.
const COMMUNITY_BINDINGS: &[(&str, &str)] = &[("zelda64-recomp", "zelda-64-recompiled")];

pub(crate) fn thunderstore_community(port_id: &str) -> Option<&'static str> {
    #[cfg(test)]
    if port_id == "starship" {
        return Some("starship-test");
    }
    COMMUNITY_BINDINGS
        .iter()
        .find(|(port, _)| *port == port_id)
        .map(|(_, community)| *community)
}

#[derive(Clone)]
pub struct ThunderstoreClient {
    http: ProviderHttp,
    web_root: String,
}

impl ThunderstoreClient {
    pub fn for_library(library: &Library) -> Result<Self> {
        Self::build(Some(library.clone()), WEB_ROOT)
    }

    fn build(library: Option<Library>, web_root: &str) -> Result<Self> {
        Ok(Self {
            http: ProviderHttp::new(library, "Thunderstore", "thunderstore.io")?,
            web_root: web_root.trim_end_matches('/').into(),
        })
    }

    #[cfg(test)]
    pub(crate) fn with_root(root: &str, library: Option<Library>) -> Result<Self> {
        Self::build(library, root)
    }

    /// Every readable package in one community, in the provider's listing order.
    pub async fn community(&self, community: &str) -> Result<Observed<Vec<ProviderProject>>> {
        let observed = self.community_catalog(community).await?;
        Ok(Observed {
            value: observed.value.0,
            observed_at: observed.observed_at,
            freshness: observed.freshness,
        })
    }

    /// Every package in the community, read chunk by chunk from the listing
    /// index. Each request is bounded; there is no whole-read deadline, so a
    /// community of any size finishes while chunks keep arriving. Chunks whose
    /// location names their SHA-256 are verified and kept in the library's
    /// chunk store, so a read that fails part way continues with the chunks it
    /// already has. The parsed community is kept in memory for its current
    /// chunk list, so browsing pages and checking many installed packages parse
    /// it once. The second value is the number of package records listed,
    /// readable or not.
    pub(crate) async fn community_catalog(
        &self,
        community: &str,
    ) -> Result<Observed<(Vec<ProviderProject>, usize)>> {
        if !plain_name(community, true) {
            return Err(PortcoveError::usage(
                "a Thunderstore community name is a plain slug",
            ));
        }
        self.read_community(community).await.map_err(|mut error| {
            if error.details.contains_key("response_byte_limit") || error.is_inventory_incomplete()
            {
                let url = format!("{WEB_ROOT}/c/{community}/");
                error.message = format!("{}. Browse the full community at {url}", error.message);
                error.details.insert("provider_browse_url".into(), url);
            }
            error
        })
    }

    async fn read_community(
        &self,
        community: &str,
    ) -> Result<Observed<(Vec<ProviderProject>, usize)>> {
        let index_url = reqwest::Url::parse(&format!(
            "{}/c/{community}/api/v1/package-listing-index/",
            self.web_root
        ))
        .map_err(|error| PortcoveError::state(error.to_string()))?;
        let (chunks, observed_at, freshness) = self.listing_index(&index_url).await?;
        let key = chunks
            .iter()
            .map(|chunk| chunk.to_string())
            .collect::<Vec<_>>();
        let snapshots = self
            .http
            .library()
            .map(|library| &library.thunderstore_listings);
        if let Some(snapshot) = snapshots.and_then(|snapshots| snapshots.get(community, &key)) {
            return Ok(Observed {
                value: (*snapshot).clone(),
                observed_at,
                freshness,
            });
        }
        let mut projects = Vec::new();
        let mut total = 0usize;
        for (position, chunk) in chunks.iter().enumerate() {
            let incomplete = |error: PortcoveError| {
                // Only a failed transfer leaves the listing incomplete; a
                // refused redirect or bad data is its own lasting failure.
                if error.code != crate::ErrorCode::Network {
                    return error;
                }
                crate::failure::inventory_incomplete(
                    crate::failure::FailureProvider::Thunderstore,
                    "community listing",
                    position as u64,
                    Some(chunks.len() as u64),
                )
                .detail("chunks_read", position.to_string())
                .detail("chunks_total", chunks.len().to_string())
                .detail("cause", error.message)
            };
            let read = match self.stored_chunk(chunk) {
                Some(bytes) => match self.parse(bytes, community).await {
                    Ok(read) => Some(read),
                    Err(error) => {
                        // A stored chunk that no longer parses is discarded and
                        // read again rather than failing until it expires.
                        tracing::warn!(%error, "discarding an unreadable stored Thunderstore chunk");
                        self.remove_stored_chunk(chunk);
                        None
                    }
                },
                None => None,
            };
            let read = match read {
                Some(read) => read,
                None if freshness == ProviderFreshness::Stale => {
                    return Err(incomplete(PortcoveError::network(
                        "Thunderstore is unavailable and this part of the community listing was not kept from an earlier read",
                    )));
                }
                None => {
                    let bytes = self
                        .http
                        .read_site_bytes(chunk.clone(), MAX_COMPRESSED_BYTES, true)
                        .await
                        .map_err(incomplete)?;
                    let digest = chunk_digest(chunk);
                    if let Some(expected) = digest {
                        use sha2::Digest;
                        if hex::encode(sha2::Sha256::digest(&bytes)) != expected {
                            return Err(PortcoveError::verification(
                                "a Thunderstore listing chunk does not match the SHA-256 its location names",
                            ));
                        }
                    }
                    let read = self.parse(bytes.clone(), community).await?;
                    // Only verified, parsed chunks are kept: a chunk without a
                    // content address has no identity to reuse it by.
                    if digest.is_some() {
                        self.store_chunk(chunk, &bytes);
                    }
                    read
                }
            };
            total += read.records;
            projects.extend(read.projects);
        }
        let snapshot = std::sync::Arc::new((projects, total));
        if let Some(snapshots) = snapshots {
            snapshots.put(community, key, snapshot.clone());
        }
        Ok(Observed {
            value: (*snapshot).clone(),
            observed_at,
            freshness,
        })
    }

    /// Decompresses and parses one chunk on the blocking pool.
    async fn parse(&self, bytes: Vec<u8>, community: &str) -> Result<ChunkRead> {
        let community = community.to_owned();
        let web_root = self.web_root.clone();
        let parses = self
            .http
            .library()
            .map(|library| library.thunderstore_listings.clone());
        tokio::task::spawn_blocking(move || {
            if let Some(parses) = parses {
                parses.count_parse();
            }
            parse_chunk(&bytes, &community, &web_root)
        })
        .await
        .map_err(|error| PortcoveError::state(error.to_string()))?
    }

    fn chunk_path(&self, chunk: &reqwest::Url) -> Option<std::path::PathBuf> {
        let digest = chunk_digest(chunk)?;
        let path = chunk_store(self.http.library()?).join(format!("{digest}.gz"));
        crate::path::refuse_symlink_ancestors(&path).ok()?;
        Some(path)
    }

    /// A verified chunk from the chunk store. Reusing one marks it recently used.
    fn stored_chunk(&self, chunk: &reqwest::Url) -> Option<Vec<u8>> {
        use sha2::Digest;
        let path = self.chunk_path(chunk)?;
        let bytes = std::fs::read(&path).ok()?;
        if Some(hex::encode(sha2::Sha256::digest(&bytes))) != chunk_digest(chunk).map(str::to_owned)
        {
            let _ = std::fs::remove_file(&path);
            return None;
        }
        if let Ok(file) = std::fs::File::options().write(true).open(&path) {
            let _ = file.set_modified(std::time::SystemTime::now());
        }
        Some(bytes)
    }

    fn remove_stored_chunk(&self, chunk: &reqwest::Url) {
        if let Some(path) = self.chunk_path(chunk) {
            let _ = std::fs::remove_file(path);
        }
    }

    fn store_chunk(&self, chunk: &reqwest::Url, bytes: &[u8]) {
        let (Some(path), Some(library)) = (self.chunk_path(chunk), self.http.library()) else {
            return;
        };
        let directory = chunk_store(library);
        let written = std::fs::create_dir_all(&directory).and_then(|()| {
            let temporary = directory.join(format!(".{}.partial", uuid::Uuid::new_v4()));
            std::fs::write(&temporary, bytes)?;
            std::fs::rename(&temporary, &path)
        });
        if let Err(error) = written {
            tracing::warn!(%error, "could not keep a Thunderstore listing chunk");
            return;
        }
        prune_chunk_store(&directory, CHUNK_STORE_MAX_BYTES);
    }

    /// The community's current chunk list. When Thunderstore cannot be read,
    /// the last observed list is used and the result is marked stale.
    async fn listing_index(
        &self,
        url: &reqwest::Url,
    ) -> Result<(Vec<reqwest::Url>, i64, ProviderFreshness)> {
        let key = url.as_str();
        let cached = self
            .http
            .library()
            .and_then(|library| library.http_cache(key).ok().flatten());
        match self
            .http
            .read_site_bytes(url.clone(), MAX_COMPRESSED_BYTES, false)
            .await
        {
            Ok(bytes) => {
                let chunks = parse_index(&bytes, url, &self.http)?;
                let changed = cached.as_ref().is_none_or(|cached| {
                    serde_json::from_str::<Vec<String>>(&cached.body).ok()
                        != Some(chunks.iter().map(|chunk| chunk.to_string()).collect())
                });
                if let Some(library) = self.http.library() {
                    let body = serde_json::to_string(
                        &chunks.iter().map(reqwest::Url::as_str).collect::<Vec<_>>(),
                    )
                    .map_err(|error| PortcoveError::state(error.to_string()))?;
                    let _ = library.store_http_cache(key, None, None, &body);
                }
                let freshness = if changed {
                    ProviderFreshness::Fresh
                } else {
                    ProviderFreshness::Revalidated
                };
                Ok((chunks, crate::Library::now(), freshness))
            }
            Err(error) if error.code == crate::ErrorCode::Network => {
                let cached = cached.ok_or(error)?;
                let chunks = serde_json::from_str::<Vec<String>>(&cached.body)
                    .ok()
                    .and_then(|chunks| {
                        chunks
                            .iter()
                            .map(|chunk| reqwest::Url::parse(chunk).ok())
                            .collect::<Option<Vec<_>>>()
                    })
                    .ok_or_else(|| {
                        PortcoveError::verification(
                            "the cached Thunderstore listing index is unreadable",
                        )
                    })?;
                Ok((chunks, cached.updated_at, ProviderFreshness::Stale))
            }
            Err(error) => Err(error),
        }
    }

    /// One page of a community, `per_page` packages at a time.
    pub async fn search(
        &self,
        community: &str,
        page: u32,
        per_page: u32,
    ) -> Result<Observed<ProviderPage>> {
        let observed = self.community(community).await?;
        Ok(Observed {
            value: page_of(observed.value, page, per_page),
            observed_at: observed.observed_at,
            freshness: observed.freshness,
        })
    }

    /// One package and its versions, named `<namespace>-<name>`.
    pub async fn project(
        &self,
        community: &str,
        package: &str,
    ) -> Result<Observed<ProviderProject>> {
        let Some((namespace, name)) = package.split_once('-') else {
            return Err(PortcoveError::usage(
                "a Thunderstore package is named NAMESPACE-NAME",
            ));
        };
        if !plain_name(namespace, false) || !plain_name(name, false) {
            return Err(PortcoveError::usage(
                "a Thunderstore package is named NAMESPACE-NAME",
            ));
        }
        let observed = self.community(community).await?;
        let project = observed
            .value
            .into_iter()
            .find(|project| project.project_id == package)
            .ok_or_else(|| PortcoveError::not_found("the community has no such package"))?;
        Ok(Observed {
            value: project,
            observed_at: observed.observed_at,
            freshness: observed.freshness,
        })
    }

    /// Streams one version's zip from its canonical location; see
    /// [`ProviderHttp::download`].
    pub(crate) async fn download_file(
        &self,
        project_id: &str,
        file: &ProviderFileCandidate,
        destination: &Path,
        max_bytes: u64,
    ) -> Result<(String, u64)> {
        let (namespace, name) = project_id.split_once('-').ok_or_else(|| {
            PortcoveError::usage("a Thunderstore package is named NAMESPACE-NAME")
        })?;
        let canonical = canonical_download(&self.web_root, namespace, name, &file.file_id);
        self.http
            .download(file, &canonical, destination, max_bytes)
            .await
    }
}

/// One page of a listing, in the provider's order; `per_page` is clamped to 50.
pub(crate) fn page_of(projects: Vec<ProviderProject>, page: u32, per_page: u32) -> ProviderPage {
    let per_page = per_page.clamp(1, 50) as usize;
    let page = page.max(1);
    let total = projects.len();
    let start = (page as usize - 1).saturating_mul(per_page);
    let projects = projects
        .into_iter()
        .skip(start)
        .take(per_page)
        .collect::<Vec<_>>();
    ProviderPage {
        complete: start + projects.len() >= total,
        projects,
        total: total as u64,
        page,
    }
}

/// Thunderstore namespaces and names use ASCII letters, digits and `_`;
/// community slugs also use `-`.
fn plain_name(value: &str, slug: bool) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || (slug && byte == b'-'))
}

fn version_number(value: &str) -> bool {
    let parts = value.split('.').collect::<Vec<_>>();
    value.len() <= 32
        && parts.len() == 3
        && parts.iter().all(|part| {
            !part.is_empty() && part.len() <= 9 && part.bytes().all(|b| b.is_ascii_digit())
        })
}

fn canonical_download(web_root: &str, namespace: &str, name: &str, version: &str) -> String {
    format!("{web_root}/package/download/{namespace}/{name}/{version}/")
}

fn timestamp(value: &Value) -> Option<i64> {
    time::OffsetDateTime::parse(
        value.as_str()?,
        &time::format_description::well_known::Rfc3339,
    )
    .ok()
    .map(time::OffsetDateTime::unix_timestamp)
}

fn parse_dependency(value: &Value) -> Option<ThunderstoreDependency> {
    let (namespace, rest) = value.as_str()?.split_once('-')?;
    let (package, version) = rest.split_once('-')?;
    if !plain_name(namespace, false) || !plain_name(package, false) || !version_number(version) {
        return None;
    }
    Some(ThunderstoreDependency {
        namespace: namespace.to_owned(),
        package: package.to_owned(),
        version: version.to_owned(),
    })
}

fn parse_dependencies(values: &[Value]) -> Option<Vec<ThunderstoreDependency>> {
    if values.len() > MAX_DEPENDENCIES {
        return None;
    }
    let mut dependencies = values
        .iter()
        .map(parse_dependency)
        .collect::<Option<Vec<_>>>()?;
    dependencies.sort_unstable();
    if dependencies.windows(2).any(|pair| pair[0] == pair[1]) {
        return None;
    }
    Some(dependencies)
}

pub(crate) fn verify_wrapper_manifest(
    bytes: &[u8],
    project_id: &str,
    file: &ProviderFileCandidate,
) -> Result<()> {
    #[derive(serde::Deserialize)]
    struct Manifest {
        name: String,
        version_number: String,
        dependencies: Vec<Value>,
    }
    let error = || {
        PortcoveError::verification(
        "the Thunderstore wrapper manifest does not match the exact listing; check the provider listing and review again",
    ).detail("project", project_id).detail("version", &file.file_id)
    };
    let manifest = serde_json::from_slice::<Manifest>(bytes).map_err(|_| error())?;
    let (_, package) = project_id.split_once('-').ok_or_else(error)?;
    let dependencies = parse_dependencies(&manifest.dependencies).ok_or_else(error)?;
    if manifest.name != package
        || manifest.version_number != file.file_id
        || Some(&dependencies) != file.thunderstore_dependencies.as_ref()
    {
        return Err(error());
    }
    Ok(())
}

fn parse_version(
    value: &Value,
    namespace: &str,
    name: &str,
    web_root: &str,
) -> Option<ProviderFileCandidate> {
    let version = value["version_number"].as_str()?;
    if !version_number(version) || value["name"].as_str() != Some(name) {
        return None;
    }
    let download_url = canonical_download(web_root, namespace, name, version);
    // A listed location that disagrees with the canonical one makes the record
    // untrustworthy as a candidate.
    if value["download_url"].as_str() != Some(download_url.as_str()) {
        return None;
    }
    let file_name = format!("{namespace}-{name}-{version}.zip");
    if !crate::profile::valid_native_id(&file_name) {
        return None;
    }
    let dependencies = parse_dependencies(value["dependencies"].as_array()?)?;
    let active = crate::mod_provider::provider_status_flag(value, "is_active");
    Some(ProviderFileCandidate {
        file_id: version.to_owned(),
        file_name,
        size: value["file_size"].as_u64()?,
        added_at: timestamp(&value["date_created"])?,
        download_url,
        claimed_md5: None,
        // An inactive version is no longer offered by the community.
        archived: !active.unwrap_or(false),
        status_unknown: active.err(),
        claimed_scan: None,
        thunderstore_dependencies: Some(dependencies),
    })
}

fn parse_package(value: &Value, community: &str, web_root: &str) -> Option<ProviderProject> {
    let namespace = value["owner"].as_str()?;
    let name = value["name"].as_str()?;
    if !plain_name(namespace, false) || !plain_name(name, false) {
        return None;
    }
    let project_id = format!("{namespace}-{name}");
    if value["full_name"].as_str() != Some(project_id.as_str()) {
        return None;
    }
    let (files, unreadable_files) = match &value["versions"] {
        Value::Array(versions) => {
            let parsed = versions
                .iter()
                .filter_map(|version| parse_version(version, namespace, name, web_root))
                .collect::<Vec<_>>();
            let unreadable = versions.len() - parsed.len();
            (parsed, unreadable)
        }
        _ => (Vec::new(), 1),
    };
    let latest = files
        .iter()
        .filter(|file| !file.archived && file.status_unknown.is_none())
        .max_by_key(|file| file.added_at)
        .map(|file| file.file_id.clone());
    let versions = value["versions"].as_array();
    let artwork = versions
        .and_then(|versions| {
            versions
                .iter()
                .find(|version| version["version_number"].as_str() == latest.as_deref())
        })
        .and_then(|version| artwork_url(version["icon"].as_str()?, "ccdn.thunderstore.io"));
    let deprecated = crate::mod_provider::provider_status_flag(value, "is_deprecated");
    Some(ProviderProject {
        listing: Some(ProviderListing {
            categories: value["categories"]
                .as_array()
                .into_iter()
                .flatten()
                .take(32)
                .filter_map(Value::as_str)
                .map(sanitize_text)
                .filter(|name| !name.is_empty())
                .collect(),
            artwork,
            created_at: timestamp(&value["date_created"]),
            downloads: versions
                .filter(|versions| !versions.is_empty())
                .and_then(|versions| {
                    versions.iter().try_fold(0u64, |total, version| {
                        total.checked_add(version["downloads"].as_u64()?)
                    })
                }),
            likes: None,
            ratings: value["rating_score"].as_u64(),
        }),
        provider: PROVIDER.into(),
        profile_url: format!("{web_root}/c/{community}/p/{namespace}/{name}/"),
        project_id,
        name: sanitize_text(name),
        version: latest,
        // The community listing is the binding: every package in it belongs to it.
        game_id: Some(community.to_owned()),
        updated_at: timestamp(&value["date_updated"]).unwrap_or_default(),
        obsolete: deprecated.unwrap_or(false),
        status_unknown: deprecated.err(),
        submitter: Some(sanitize_text(namespace)),
        files,
        unreadable_files: u32::try_from(unreadable_files).unwrap_or(u32::MAX),
    })
}

#[cfg(test)]
pub(crate) fn parse_listing(
    value: &Value,
    community: &str,
    web_root: &str,
) -> Result<Vec<ProviderProject>> {
    let packages = value
        .as_array()
        .ok_or_else(|| PortcoveError::verification("Thunderstore listing is not a list"))?;
    Ok(packages
        .iter()
        .filter_map(|package| parse_package(package, community, web_root))
        .collect())
}

fn chunk_store(library: &Library) -> std::path::PathBuf {
    library
        .downloads_dir()
        .join("provider-listing-v1")
        .join("thunderstore")
}

/// The SHA-256 a Thunderstore blob location names (`.../sha256/<hex>...`):
/// the digest of the compressed bytes it serves.
fn chunk_digest(chunk: &reqwest::Url) -> Option<&str> {
    let (_, rest) = chunk.path().split_once("/sha256/")?;
    let digest = rest.get(..64)?;
    (digest
        .bytes()
        .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
        && !rest[64..].starts_with(|c: char| c.is_ascii_hexdigit()))
    .then_some(digest)
}

/// Removes the least recently used stored chunks until the store fits.
fn prune_chunk_store(directory: &Path, max_bytes: u64) {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    let mut files = entries
        .flatten()
        .filter_map(|entry| {
            let metadata = entry.metadata().ok()?;
            metadata.is_file().then(|| {
                (
                    metadata.modified().unwrap_or(std::time::UNIX_EPOCH),
                    metadata.len(),
                    entry.path(),
                )
            })
        })
        .collect::<Vec<_>>();
    files.sort();
    let mut size = files.iter().map(|(_, len, _)| len).sum::<u64>();
    for (_, len, path) in files {
        if size <= max_bytes {
            break;
        }
        if std::fs::remove_file(&path).is_ok() {
            size -= len;
        }
    }
}

/// Parsed communities shared by every Thunderstore client of one library.
#[derive(Clone, Default)]
pub(crate) struct ListingSnapshots(std::sync::Arc<std::sync::Mutex<SnapshotState>>);

#[derive(Default)]
struct SnapshotState {
    /// Most recently used last: (community, chunk list, parsed listing).
    entries: Vec<(String, Vec<String>, Snapshot)>,
    parses: usize,
}

type Snapshot = std::sync::Arc<(Vec<ProviderProject>, usize)>;

impl std::fmt::Debug for ListingSnapshots {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("ListingSnapshots")
    }
}

impl ListingSnapshots {
    fn get(&self, community: &str, chunks: &[String]) -> Option<Snapshot> {
        let mut state = self.0.lock().ok()?;
        let position = state
            .entries
            .iter()
            .position(|(name, key, _)| name == community && key == chunks)?;
        let entry = state.entries.remove(position);
        let snapshot = entry.2.clone();
        state.entries.push(entry);
        Some(snapshot)
    }

    fn put(&self, community: &str, chunks: Vec<String>, snapshot: Snapshot) {
        let Ok(mut state) = self.0.lock() else {
            return;
        };
        state.entries.retain(|(name, _, _)| name != community);
        state.entries.push((community.to_owned(), chunks, snapshot));
        while state.entries.len() > SNAPSHOT_COMMUNITIES {
            state.entries.remove(0);
        }
    }

    fn count_parse(&self) {
        if let Ok(mut state) = self.0.lock() {
            state.parses += 1;
        }
    }

    /// Chunks parsed so far, for tests that establish parse reuse.
    #[cfg(test)]
    pub(crate) fn parses(&self) -> usize {
        self.0.lock().map(|state| state.parses).unwrap_or_default()
    }
}

/// Packages read from one listing chunk.
struct ChunkRead {
    projects: Vec<ProviderProject>,
    /// Package records in the chunk, readable or not.
    records: usize,
}

/// Decompresses at most `MAX_DECOMPRESSED_BYTES` of gzip data.
fn gunzip(bytes: &[u8]) -> impl std::io::Read + '_ {
    struct Bounded<R>(R, u64);
    impl<R: std::io::Read> std::io::Read for Bounded<R> {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            let read = self.0.read(buffer)?;
            self.1 = self.1.saturating_sub(read as u64);
            if self.1 == 0 && read > 0 {
                return Err(std::io::Error::other(
                    "Thunderstore listing data exceeds its decompressed bound",
                ));
            }
            Ok(read)
        }
    }
    Bounded(
        flate2::read::GzDecoder::new(bytes),
        MAX_DECOMPRESSED_BYTES + 1,
    )
}

fn parse_index(
    bytes: &[u8],
    index: &reqwest::Url,
    http: &ProviderHttp,
) -> Result<Vec<reqwest::Url>> {
    let chunks: Vec<String> = serde_json::from_reader(gunzip(bytes)).map_err(|error| {
        PortcoveError::verification(format!(
            "the Thunderstore listing index is unreadable: {error}"
        ))
    })?;
    let mut seen = std::collections::HashSet::new();
    chunks
        .iter()
        .map(|chunk| {
            reqwest::Url::parse(chunk)
                .ok()
                .filter(|url| http.on_provider_site(index, url) && seen.insert(url.clone()))
                .ok_or_else(|| {
                    PortcoveError::verification(
                        "the Thunderstore listing index names a chunk outside Thunderstore or twice",
                    )
                })
        })
        .collect()
}

/// Parses one chunk a package at a time, so memory follows the parsed result
/// rather than the decompressed JSON.
fn parse_chunk(bytes: &[u8], community: &str, web_root: &str) -> Result<ChunkRead> {
    struct Packages<'a> {
        community: &'a str,
        web_root: &'a str,
    }
    impl<'de> serde::de::DeserializeSeed<'de> for Packages<'_> {
        type Value = ChunkRead;
        fn deserialize<D: serde::Deserializer<'de>>(
            self,
            deserializer: D,
        ) -> std::result::Result<ChunkRead, D::Error> {
            deserializer.deserialize_seq(self)
        }
    }
    impl<'de> serde::de::Visitor<'de> for Packages<'_> {
        type Value = ChunkRead;
        fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
            formatter.write_str("a list of Thunderstore packages")
        }
        fn visit_seq<A: serde::de::SeqAccess<'de>>(
            self,
            mut packages: A,
        ) -> std::result::Result<ChunkRead, A::Error> {
            let mut read = ChunkRead {
                projects: Vec::new(),
                records: 0,
            };
            while let Some(package) = packages.next_element::<Value>()? {
                read.records += 1;
                read.projects
                    .extend(parse_package(&package, self.community, self.web_root));
            }
            Ok(read)
        }
    }
    use serde::de::DeserializeSeed;
    let mut deserializer = serde_json::Deserializer::from_reader(gunzip(bytes));
    let read = Packages {
        community,
        web_root,
    }
    .deserialize(&mut deserializer)
    .and_then(|read| deserializer.end().map(|()| read))
    .map_err(|error| {
        PortcoveError::verification(format!(
            "a Thunderstore listing chunk is unreadable: {error}"
        ))
    })?;
    Ok(read)
}

/// Exact provider files, with requirements before their dependants. The root
/// file is last. Native requirements are established separately by inspection.
pub(crate) fn resolve_dependencies<'a>(
    listing: &'a [ProviderProject],
    project_id: &str,
    file_id: &str,
) -> Result<Vec<(&'a ProviderProject, &'a ProviderFileCandidate)>> {
    const MAX_CLOSURE: usize = 64;

    struct Resolution<'a> {
        listing: &'a [ProviderProject],
        versions: std::collections::BTreeMap<String, String>,
        visiting: std::collections::BTreeSet<String>,
        files: Vec<(&'a ProviderProject, &'a ProviderFileCandidate)>,
    }

    impl<'a> Resolution<'a> {
        fn visit(&mut self, project_id: &str, file_id: &str) -> Result<()> {
            let with_coordinate = |error: PortcoveError| {
                error
                    .detail("project", project_id)
                    .detail("version", file_id)
            };
            if let Some(existing) = self.versions.get(project_id) {
                if existing != file_id {
                    return Err(with_coordinate(
                        PortcoveError::conflict(
                            "Thunderstore requires two versions of the same package",
                        )
                        .detail("other_version", existing),
                    ));
                }
                if self.visiting.contains(project_id) {
                    return Err(with_coordinate(PortcoveError::conflict(
                        "the Thunderstore package requirements form a cycle",
                    )));
                }
                return Ok(());
            }
            if self.versions.len() >= MAX_CLOSURE {
                return Err(with_coordinate(PortcoveError::unsupported(
                    "the Thunderstore dependency closure exceeds the supported size",
                )));
            }
            let project = exact_listing_entry(
                self.listing
                    .iter()
                    .filter(|entry| entry.project_id == project_id),
                &with_coordinate,
            )?;
            let file = exact_listing_entry(
                project.files.iter().filter(|file| file.file_id == file_id),
                &with_coordinate,
            )?;
            if project.status_unknown.is_some() || file.status_unknown.is_some() {
                return Err(with_coordinate(PortcoveError::verification(
                    crate::mod_provider::UNKNOWN_PROVIDER_ELIGIBILITY,
                )));
            }
            if project.obsolete || file.archived {
                return Err(with_coordinate(PortcoveError::unsupported(
                    "the exact Thunderstore package version is no longer offered",
                )));
            }
            let requirements = file.thunderstore_dependencies.as_deref().ok_or_else(|| {
                with_coordinate(PortcoveError::verification(
                    "the exact Thunderstore package version has unreadable dependency metadata",
                ))
            })?;
            self.versions.insert(project_id.into(), file_id.into());
            self.visiting.insert(project_id.into());
            for requirement in requirements {
                let required_project = format!("{}-{}", requirement.namespace, requirement.package);
                self.visit(&required_project, &requirement.version)?;
            }
            self.visiting.remove(project_id);
            self.files.push((project, file));
            Ok(())
        }
    }

    let mut resolution = Resolution {
        listing,
        versions: Default::default(),
        visiting: Default::default(),
        files: Vec::new(),
    };
    resolution.visit(project_id, file_id)?;
    Ok(resolution.files)
}

fn exact_listing_entry<T>(
    mut matches: impl Iterator<Item = T>,
    describe: &impl Fn(PortcoveError) -> PortcoveError,
) -> Result<T> {
    let entry = matches.next().ok_or_else(|| {
        describe(PortcoveError::not_found(
            "the Thunderstore listing does not offer the exact requested package version",
        ))
    })?;
    if matches.next().is_some() {
        return Err(describe(PortcoveError::verification(
            "the Thunderstore listing has ambiguous records for the exact package version",
        )));
    }
    Ok(entry)
}

/// Fixture routes for a simulated Thunderstore community listing: the listing
/// index and its content-addressed chunks, named like Thunderstore's blobs
/// (`.../sha256/<digest of the compressed chunk>.blob`). Built once per
/// fixture so a large community is compressed once.
#[cfg(test)]
pub(crate) struct ListingFixture {
    index_path: String,
    index: Vec<u8>,
    chunks: std::collections::HashMap<String, Vec<u8>>,
}

#[cfg(test)]
pub(crate) fn gzip_fixture(value: &Value) -> Vec<u8> {
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    std::io::Write::write_all(&mut encoder, value.to_string().as_bytes()).unwrap();
    encoder.finish().unwrap()
}

#[cfg(test)]
pub(crate) fn ok_bytes(body: &[u8]) -> Vec<u8> {
    let mut response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )
    .into_bytes();
    response.extend_from_slice(body);
    response
}

#[cfg(test)]
impl ListingFixture {
    pub(crate) fn new(web: &str, community: &str, chunks: &[Value]) -> Self {
        use sha2::Digest;
        let chunks = chunks
            .iter()
            .map(|chunk| {
                let body = gzip_fixture(chunk);
                (hex::encode(sha2::Sha256::digest(&body)), body)
            })
            .collect::<Vec<_>>();
        let index = gzip_fixture(&serde_json::json!(
            chunks
                .iter()
                .map(|(sha, _)| format!("{web}/listing-chunk/sha256/{sha}.blob"))
                .collect::<Vec<_>>()
        ));
        Self {
            index_path: format!("/c/{community}/api/v1/package-listing-index/"),
            index,
            chunks: chunks
                .into_iter()
                .map(|(sha, body)| (format!("/listing-chunk/sha256/{sha}.blob"), body))
                .collect(),
        }
    }

    /// The response for `path`, or `None` when it is not one of these routes.
    pub(crate) fn respond(&self, path: &str) -> Option<Vec<u8>> {
        if path == self.index_path {
            return Some(ok_bytes(&self.index));
        }
        self.chunks.get(path).map(|body| ok_bytes(body))
    }
}

/// One-off fixture route; see [`ListingFixture`].
#[cfg(test)]
pub(crate) fn listing_fixture(
    path: &str,
    web: &str,
    community: &str,
    chunks: &[Value],
) -> Option<Vec<u8>> {
    ListingFixture::new(web, community, chunks).respond(path)
}

#[cfg(test)]
#[path = "thunderstore_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "provider_thunderstore_tests.rs"]
mod lifecycle_tests;
