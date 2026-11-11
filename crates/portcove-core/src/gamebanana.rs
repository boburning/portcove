//! GameBanana adapter: search and project observations, never acquisition.
//!
//! Evidence (November 11, 2026, live API v11, unauthenticated reads): a game ID is
//! resolved with `Util/Game/NameMatch`; `Mod/Index` filtered by `Generic_Game`
//! pages mod summaries; `Mod/<id>` with `_csvProperties` returns the file list.
//! Each file has its own ID, name, size, add date, a canonical `/dl/<id>` location
//! and an MD5 claim. The displayed version and `_tsDateUpdated` are separate from
//! file identity, so file IDs and dates, not version labels, detect changed bytes.
use std::{
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use reqwest::{StatusCode, header};
use serde_json::Value;

use crate::{
    Library, PortcoveError, Result,
    mod_provider::{
        MAX_FILES_PER_PROJECT, Observed, ProviderFileCandidate, ProviderFreshness, ProviderPage,
        ProviderProject, numeric_id, sanitize_text,
    },
    release::{
        PROVIDER_JSON_MAX_BYTES, PROVIDER_NETWORK_BOUNDS, ProviderNetworkBounds,
        bounded_response_bytes,
    },
};

pub const PROVIDER: &str = "gamebanana";
const API_ROOT: &str = "https://gamebanana.com/apiv11";
const MAX_PER_PAGE: u32 = 50;
const DEFAULT_BACKOFF: Duration = Duration::from_secs(60);
const MAX_BACKOFF: Duration = Duration::from_secs(15 * 60);
const FILE_PROPERTIES: &str =
    "_sName,_sVersion,_aFiles,_bIsObsolete,_tsDateUpdated,_sProfileUrl,_aSubmitter";

#[derive(Clone)]
pub struct GameBananaClient {
    client: reqwest::Client,
    /// No overall deadline (files can be large); connect and idle-read bounds apply.
    download_client: reqwest::Client,
    api_root: String,
    web_root: String,
    library: Option<Library>,
    /// Provider-wide backoff after throttling or server errors.
    blocked_until: Arc<Mutex<Option<Instant>>>,
}

impl GameBananaClient {
    pub fn for_library(library: &Library) -> Result<Self> {
        Self::build(Some(library.clone()), API_ROOT, "https://gamebanana.com")
    }

    fn build(library: Option<Library>, api_root: &str, web_root: &str) -> Result<Self> {
        let bounds: ProviderNetworkBounds = PROVIDER_NETWORK_BOUNDS;
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(concat!("Portcove/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(bounds.connect)
            .read_timeout(bounds.read_idle)
            .timeout(bounds.request)
            .build()
            .map_err(|error| PortcoveError::network(error.to_string()))?;
        let download_client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(concat!("Portcove/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(bounds.connect)
            .read_timeout(bounds.read_idle)
            .build()
            .map_err(|error| PortcoveError::network(error.to_string()))?;
        Ok(Self {
            client,
            download_client,
            api_root: api_root.trim_end_matches('/').into(),
            web_root: web_root.trim_end_matches('/').into(),
            library,
            blocked_until: Arc::new(Mutex::new(None)),
        })
    }

    #[cfg(test)]
    pub(crate) fn with_roots(root: &str, library: Option<Library>) -> Result<Self> {
        Self::build(library, &format!("{root}/apiv11"), root)
    }

    /// One page of Mod summaries for a game. `per_page` is clamped to 50.
    pub async fn search(
        &self,
        game_id: u64,
        page: u32,
        per_page: u32,
    ) -> Result<Observed<ProviderPage>> {
        let per_page = per_page.clamp(1, MAX_PER_PAGE);
        let page = page.max(1);
        let mut url = self.url("Mod/Index")?;
        url.query_pairs_mut()
            .append_pair("_nPerpage", &per_page.to_string())
            .append_pair("_nPage", &page.to_string())
            .append_pair("_aFilters[Generic_Game]", &game_id.to_string())
            .append_pair("_sSort", "Generic_MostDownloaded");
        let web_root = self.web_root.clone();
        self.observe(url, move |value| parse_index(value, page, &web_root))
            .await
    }

    /// The exact file list and version for one Mod.
    pub async fn project(&self, project_id: u64) -> Result<Observed<ProviderProject>> {
        if project_id == 0 {
            return Err(PortcoveError::usage("GameBanana project IDs are positive"));
        }
        let mut url = self.url(&format!("Mod/{project_id}"))?;
        url.query_pairs_mut()
            .append_pair("_csvProperties", FILE_PROPERTIES);
        let web_root = self.web_root.clone();
        self.observe(url, move |value| {
            parse_project(value, project_id, &web_root)
        })
        .await
    }

    /// Streams one file to `destination`, following at most four redirects that stay
    /// on the provider's own hosts and scheme. Enforces the size the provider
    /// declared and a hard cap, and returns the computed SHA-256 and size. The
    /// provider's MD5 claim is recorded elsewhere but never used as verification.
    pub(crate) async fn download_file(
        &self,
        file: &ProviderFileCandidate,
        destination: &Path,
        max_bytes: u64,
    ) -> Result<(String, u64)> {
        use futures_util::StreamExt;
        use sha2::{Digest, Sha256};
        use std::io::Write;
        let start = reqwest::Url::parse(&file.download_url)
            .map_err(|error| PortcoveError::state(error.to_string()))?;
        if file.download_url != canonical_download(&self.web_root, &file.file_id) {
            return Err(PortcoveError::verification(
                "the download location is not the provider's canonical file location",
            ));
        }
        if file.size == 0 || file.size > max_bytes {
            return Err(PortcoveError::verification(
                "the provider's declared file size is outside the supported bound",
            )
            .detail("size", file.size.to_string()));
        }
        let allowed = |url: &reqwest::Url| {
            let same_site = url.scheme() == start.scheme()
                && url.host_str().is_some_and(|host| {
                    Some(host) == start.host_str()
                        || (start.host_str() == Some("gamebanana.com")
                            && host.ends_with(".gamebanana.com"))
                });
            same_site && url.username().is_empty() && url.password().is_none()
        };
        let mut url = start.clone();
        for _ in 0..=4 {
            let response = self
                .download_client
                .get(url.clone())
                .send()
                .await
                .map_err(|error| PortcoveError::network(error.to_string()))?;
            let status = response.status();
            if status.is_redirection() {
                let next = response
                    .headers()
                    .get(header::LOCATION)
                    .and_then(|value| value.to_str().ok())
                    .and_then(|location| url.join(location).ok())
                    .ok_or_else(|| PortcoveError::network("download redirect has no location"))?;
                if !allowed(&next) {
                    return Err(PortcoveError::verification(
                        "the download redirected away from the provider's hosts",
                    ));
                }
                url = next;
                continue;
            }
            if status == StatusCode::TOO_MANY_REQUESTS || status.is_server_error() {
                self.start_backoff(response.headers());
            }
            if !status.is_success() {
                return Err(PortcoveError::network(format!(
                    "download returned {status}"
                )));
            }
            if response
                .content_length()
                .is_some_and(|length| length != file.size)
            {
                return Err(PortcoveError::verification(
                    "the download size differs from what the provider declared",
                ));
            }
            let mut output = std::fs::File::create(destination)?;
            let mut hasher = Sha256::new();
            let mut total = 0u64;
            let mut stream = response.bytes_stream();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|error| PortcoveError::network(error.to_string()))?;
                total += chunk.len() as u64;
                if total > file.size {
                    let _ = std::fs::remove_file(destination);
                    return Err(PortcoveError::verification(
                        "the download is larger than the provider declared",
                    ));
                }
                hasher.update(&chunk);
                output.write_all(&chunk)?;
            }
            output.sync_all()?;
            if total != file.size {
                let _ = std::fs::remove_file(destination);
                return Err(PortcoveError::verification(
                    "the download is shorter than the provider declared",
                ));
            }
            return Ok((hex::encode(hasher.finalize()), total));
        }
        Err(PortcoveError::network("too many download redirects"))
    }

    fn url(&self, path: &str) -> Result<reqwest::Url> {
        reqwest::Url::parse(&format!("{}/{path}", self.api_root))
            .map_err(|error| PortcoveError::state(error.to_string()))
    }

    fn backoff_remaining(&self) -> Option<Duration> {
        let mut guard = self.blocked_until.lock().ok()?;
        match *guard {
            Some(until) if until > Instant::now() => Some(until - Instant::now()),
            Some(_) => {
                *guard = None;
                None
            }
            None => None,
        }
    }

    fn start_backoff(&self, headers: &header::HeaderMap) {
        let wait = headers
            .get(header::RETRY_AFTER)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok())
            .map_or(DEFAULT_BACKOFF, Duration::from_secs)
            .min(MAX_BACKOFF);
        if let Ok(mut guard) = self.blocked_until.lock() {
            *guard = Some(Instant::now() + wait);
        }
    }

    /// Conditional, cached, bounded read. An outage or backoff falls back to the
    /// last cached observation and says so; with no cache it is an error, never
    /// an empty result.
    async fn observe<T>(
        &self,
        url: reqwest::Url,
        parse: impl Fn(&Value) -> Result<T>,
    ) -> Result<Observed<T>> {
        let key = url.as_str().to_owned();
        let cached = self
            .library
            .as_ref()
            .and_then(|library| library.http_cache(&key).ok().flatten());
        let stale = |reason: PortcoveError| -> Result<Observed<T>> {
            let entry = cached.as_ref().ok_or(reason)?;
            let value: Value = serde_json::from_str(&entry.body)
                .map_err(|error| PortcoveError::network(error.to_string()))?;
            Ok(Observed {
                value: parse(&value)?,
                observed_at: entry.updated_at,
                freshness: ProviderFreshness::Stale,
            })
        };
        if let Some(wait) = self.backoff_remaining() {
            return stale(
                PortcoveError::network("GameBanana is rate limiting this client")
                    .detail("retry_after_seconds", wait.as_secs().to_string()),
            );
        }
        let mut request = self.client.get(url);
        if let Some(entry) = cached.as_ref() {
            if let Some(etag) = entry.etag.as_deref() {
                request = request.header(header::IF_NONE_MATCH, etag);
            }
            if let Some(modified) = entry.last_modified.as_deref() {
                request = request.header(header::IF_MODIFIED_SINCE, modified);
            }
        }
        let response = match request.send().await {
            Ok(response) => response,
            Err(error) => return stale(PortcoveError::network(error.to_string())),
        };
        let status = response.status();
        if status == StatusCode::NOT_MODIFIED {
            let entry = cached
                .as_ref()
                .ok_or_else(|| PortcoveError::state("GameBanana returned 304 without cache"))?;
            let value: Value = serde_json::from_str(&entry.body)
                .map_err(|error| PortcoveError::network(error.to_string()))?;
            let parsed = parse(&value)?;
            if let Some(library) = &self.library {
                let _ = library.store_http_cache(
                    &key,
                    entry.etag.as_deref(),
                    entry.last_modified.as_deref(),
                    &entry.body,
                );
            }
            return Ok(Observed {
                value: parsed,
                observed_at: crate::Library::now(),
                freshness: ProviderFreshness::Revalidated,
            });
        }
        if status == StatusCode::TOO_MANY_REQUESTS || status.is_server_error() {
            self.start_backoff(response.headers());
            return stale(PortcoveError::network(format!(
                "GameBanana returned {status}"
            )));
        }
        if !status.is_success() {
            return Err(PortcoveError::network(format!(
                "GameBanana returned {status}"
            )));
        }
        let etag = response
            .headers()
            .get(header::ETAG)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let modified = response
            .headers()
            .get(header::LAST_MODIFIED)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let body = bounded_response_bytes(response, PROVIDER_JSON_MAX_BYTES, "GameBanana response")
            .await?;
        let value: Value = serde_json::from_slice(&body)
            .map_err(|error| PortcoveError::network(error.to_string()))?;
        // Parse before caching: a malformed success never replaces a good entry.
        let parsed = parse(&value)?;
        if let (Some(library), Ok(text)) = (&self.library, std::str::from_utf8(&body)) {
            let _ = library.store_http_cache(&key, etag.as_deref(), modified.as_deref(), text);
        }
        Ok(Observed {
            value: parsed,
            observed_at: crate::Library::now(),
            freshness: ProviderFreshness::Fresh,
        })
    }
}

fn canonical_download(web_root: &str, file_id: &str) -> String {
    format!("{web_root}/dl/{file_id}")
}

fn parse_file(value: &Value, web_root: &str) -> Option<ProviderFileCandidate> {
    let file_id = numeric_id(&value["_idRow"])?;
    let file_name = sanitize_text(value["_sFile"].as_str()?);
    if file_name.is_empty() || file_name.contains(['/', '\\']) {
        return None;
    }
    let download_url = canonical_download(web_root, &file_id);
    // A provider-supplied location that disagrees with the canonical one means the
    // record is not trustworthy enough to become a candidate.
    if let Some(supplied) = value["_sDownloadUrl"].as_str()
        && supplied != download_url
    {
        return None;
    }
    let md5 = value["_sMd5Checksum"]
        .as_str()
        .filter(|md5| md5.len() == 32 && md5.bytes().all(|b| b.is_ascii_hexdigit()))
        .map(str::to_ascii_lowercase);
    Some(ProviderFileCandidate {
        file_id,
        file_name,
        size: value["_nFilesize"].as_u64()?,
        added_at: value["_tsDateAdded"].as_i64().unwrap_or_default(),
        download_url,
        claimed_md5: md5,
        archived: value["_bIsArchived"].as_bool().unwrap_or(false),
        claimed_scan: value["_sAvResult"].as_str().map(sanitize_text),
    })
}

fn parse_summary(value: &Value, web_root: &str) -> Option<ProviderProject> {
    let project_id = numeric_id(&value["_idRow"])?;
    let files = match &value["_aFiles"] {
        Value::Array(files) => files
            .iter()
            .take(MAX_FILES_PER_PROJECT)
            .filter_map(|file| parse_file(file, web_root))
            .collect(),
        _ => Vec::new(),
    };
    Some(ProviderProject {
        provider: PROVIDER.into(),
        profile_url: format!("{web_root}/mods/{project_id}"),
        project_id,
        name: sanitize_text(value["_sName"].as_str()?),
        version: value["_sVersion"]
            .as_str()
            .map(sanitize_text)
            .filter(|v| !v.is_empty()),
        game_id: numeric_id(&value["_aGame"]["_idRow"]),
        updated_at: value["_tsDateUpdated"]
            .as_i64()
            .or_else(|| value["_tsDateModified"].as_i64())
            .unwrap_or_default(),
        obsolete: value["_bIsObsolete"].as_bool().unwrap_or(false),
        submitter: value["_aSubmitter"]["_sName"].as_str().map(sanitize_text),
        files,
    })
}

pub(crate) fn parse_index(value: &Value, page: u32, web_root: &str) -> Result<ProviderPage> {
    let records = value["_aRecords"]
        .as_array()
        .ok_or_else(|| PortcoveError::verification("GameBanana index has no record list"))?;
    if records.len() > MAX_PER_PAGE as usize {
        return Err(PortcoveError::verification(
            "GameBanana page exceeds its bound",
        ));
    }
    Ok(ProviderPage {
        projects: records
            .iter()
            .filter_map(|record| parse_summary(record, web_root))
            .collect(),
        total: value["_aMetadata"]["_nRecordCount"]
            .as_u64()
            .unwrap_or_default(),
        page,
        complete: value["_aMetadata"]["_bIsComplete"]
            .as_bool()
            .unwrap_or(false),
    })
}

pub(crate) fn parse_project(
    value: &Value,
    expected_id: u64,
    web_root: &str,
) -> Result<ProviderProject> {
    let mut object = value.clone();
    // The property-filtered response omits the identity; bind it from the request.
    object["_idRow"] = Value::from(expected_id);
    if object["_sName"].as_str().is_none() {
        return Err(PortcoveError::verification(
            "GameBanana project has no name",
        ));
    }
    parse_summary(&object, web_root)
        .ok_or_else(|| PortcoveError::verification("GameBanana project record is invalid"))
}

#[cfg(test)]
#[path = "gamebanana_tests.rs"]
mod tests;
