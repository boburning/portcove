//! Shared HTTP for mod providers: bounded, cached, conditional reads with
//! provider-wide backoff, and bounded downloads that follow redirects only within
//! the provider's own site. Every provider uses the same limits.
use std::{
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use reqwest::{StatusCode, header};
use serde_json::Value;

use crate::{
    Library, PortcoveError, Result,
    mod_provider::{Observed, ProviderFileCandidate, ProviderFreshness},
    release::{
        PROVIDER_JSON_MAX_BYTES, PROVIDER_NETWORK_BOUNDS, ProviderNetworkBounds,
        bounded_response_bytes,
    },
};

const DEFAULT_BACKOFF: Duration = Duration::from_secs(60);
const MAX_BACKOFF: Duration = Duration::from_secs(15 * 60);

#[derive(Clone)]
pub(crate) struct ProviderHttp {
    client: reqwest::Client,
    /// No overall deadline (files can be large); connect and idle-read bounds apply.
    download_client: reqwest::Client,
    library: Option<Library>,
    /// The provider's name in messages.
    label: &'static str,
    /// The provider's registrable site; downloads may redirect to its subdomains.
    site: &'static str,
    /// Provider-wide backoff after throttling or server errors.
    blocked_until: Arc<Mutex<Option<Instant>>>,
}

impl ProviderHttp {
    pub(crate) fn new(
        library: Option<Library>,
        label: &'static str,
        site: &'static str,
    ) -> Result<Self> {
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
            library,
            label,
            site,
            blocked_until: Arc::new(Mutex::new(None)),
        })
    }

    /// Streams one file to `destination`, following at most four redirects that stay
    /// on the provider's own hosts and scheme. Enforces the size the provider
    /// declared and a hard cap, and returns the computed SHA-256 and size. The
    /// provider's MD5 claim is recorded elsewhere but never used as verification.
    pub(crate) async fn download(
        &self,
        file: &ProviderFileCandidate,
        canonical: &str,
        destination: &Path,
        max_bytes: u64,
    ) -> Result<(String, u64)> {
        use futures_util::StreamExt;
        use sha2::{Digest, Sha256};
        use std::io::Write;
        let start = reqwest::Url::parse(&file.download_url)
            .map_err(|error| PortcoveError::state(error.to_string()))?;
        if file.download_url != canonical {
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
                && url.port_or_known_default() == start.port_or_known_default()
                && url.host_str().is_some_and(|host| {
                    Some(host) == start.host_str()
                        || start.host_str() == Some(self.site)
                            && host.ends_with(&format!(".{}", self.site))
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
            let deadline = tokio::time::Instant::now() + download_deadline(file.size);
            while let Some(chunk) = tokio::time::timeout_at(deadline, stream.next())
                .await
                .map_err(|_| {
                    let _ = std::fs::remove_file(destination);
                    PortcoveError::network("the download exceeded its time allowance")
                })?
            {
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
    pub(crate) async fn observe<T>(
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
                PortcoveError::network(format!("{} is rate limiting this client", self.label))
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
            let entry = cached.as_ref().ok_or_else(|| {
                PortcoveError::state(format!("{} returned 304 without cache", self.label))
            })?;
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
                "{} returned {status}",
                self.label
            )));
        }
        if !status.is_success() {
            return Err(PortcoveError::network(format!(
                "{} returned {status}",
                self.label
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
        let body = bounded_response_bytes(response, PROVIDER_JSON_MAX_BYTES, self.label).await?;
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

/// Wall-clock allowance for one download: a floor plus time for the declared size at
/// a deliberately slow 128 KiB/s, capped at six hours. A server dripping bytes just
/// inside the idle bound cannot hold a worker indefinitely.
pub(crate) fn download_deadline(size: u64) -> Duration {
    Duration::from_secs((120 + size / (128 * 1024)).min(6 * 60 * 60))
}
