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
    transfer_progress::{PROGRESS_FLOOR, ProgressFloor, ProgressWatch},
};

const DEFAULT_BACKOFF: Duration = Duration::from_secs(60);
const MAX_BACKOFF: Duration = Duration::from_secs(15 * 60);

/// Shared request backoff for a provider across short-lived client instances.
#[derive(Clone, Debug, Default)]
pub(crate) struct ProviderBackoff(Arc<Mutex<Option<Instant>>>);

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
    blocked_until: ProviderBackoff,
    /// Minimum progress a download connection must sustain.
    progress_floor: ProgressFloor,
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
            blocked_until: ProviderBackoff::default(),
            progress_floor: PROGRESS_FLOOR,
        })
    }

    pub(crate) fn with_backoff(mut self, backoff: ProviderBackoff) -> Self {
        self.blocked_until = backoff;
        self
    }

    #[cfg(test)]
    pub(crate) fn with_progress_floor(mut self, floor: ProgressFloor) -> Self {
        self.progress_floor = floor;
        self
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
        if file.download_url != canonical {
            return Err(PortcoveError::verification(
                "the download location is not the provider's canonical file location",
            ));
        }
        self.download_exact(canonical, file.size, destination, max_bytes, false)
            .await
    }

    /// Start with the exact numeric asset in the approved public repository.
    /// Only GitHub's release-asset origins may serve the redirected bytes.
    pub(crate) async fn download_github_asset(
        &self,
        repository_id: u64,
        asset_id: u64,
        size: u64,
        destination: &Path,
        max_bytes: u64,
    ) -> Result<(String, u64)> {
        self.download_exact(
            &format!(
                "https://api.github.com/repositories/{repository_id}/releases/assets/{asset_id}"
            ),
            size,
            destination,
            max_bytes,
            true,
        )
        .await
    }

    async fn download_exact(
        &self,
        canonical: &str,
        size: u64,
        destination: &Path,
        max_bytes: u64,
        github_numeric: bool,
    ) -> Result<(String, u64)> {
        use futures_util::StreamExt;
        use sha2::{Digest, Sha256};
        use std::io::Write;
        let start = reqwest::Url::parse(canonical)
            .map_err(|error| PortcoveError::state(error.to_string()))?;
        if size == 0 || size > max_bytes {
            return Err(PortcoveError::verification(
                "the provider's declared file size is outside the supported bound",
            )
            .detail("size", size.to_string()));
        }
        let allowed = |url: &reqwest::Url| {
            let same_site = url.scheme() == start.scheme()
                && url.port_or_known_default() == start.port_or_known_default()
                && url.host_str().is_some_and(|host| {
                    Some(host) == start.host_str()
                        || start.host_str() == Some(self.site)
                            && host.ends_with(&format!(".{}", self.site))
                });
            let github_asset = github_numeric
                && url.scheme() == "https"
                && url.port().is_none()
                && matches!(
                    url.host_str(),
                    Some(
                        "release-assets.githubusercontent.com"
                            | "objects.githubusercontent.com"
                            | "github-releases.githubusercontent.com"
                    )
                );
            let safe_host = if github_numeric {
                github_asset
            } else {
                same_site
            };
            safe_host && url.username().is_empty() && url.password().is_none()
        };
        let mut url = start.clone();
        for hop in 0..=4 {
            let mut request = self.download_client.get(url.clone());
            if github_numeric && hop == 0 {
                request = request
                    .header(header::ACCEPT, "application/octet-stream")
                    .header(header::CACHE_CONTROL, "no-cache");
            }
            let response = request.send().await.map_err(|error| transport(&error))?;
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
                return Err(
                    PortcoveError::network(format!("download returned {status}")).with_upstream(
                        Some(crate::failure::UpstreamObservation::Status(status.as_u16())),
                    ),
                );
            }
            if response
                .content_length()
                .is_some_and(|length| length != size)
            {
                return Err(PortcoveError::verification(
                    "the download size differs from what the provider declared",
                ));
            }
            let mut output = std::fs::File::create(destination)?;
            let mut hasher = Sha256::new();
            let mut total = 0u64;
            let mut stream = response.bytes_stream();
            // No whole-transfer deadline: a progressing download finishes at
            // any size or link speed. The transport's read-idle bound cuts a
            // silent connection and the progress floor cuts a trickle.
            let mut progress = ProgressWatch::new(self.progress_floor);
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|error| transport(&error))?;
                if let Err(error) = progress.record(chunk.len() as u64) {
                    let _ = std::fs::remove_file(destination);
                    return Err(error);
                }
                total += chunk.len() as u64;
                if total > size {
                    let _ = std::fs::remove_file(destination);
                    return Err(PortcoveError::verification(
                        "the download is larger than the provider declared",
                    ));
                }
                hasher.update(&chunk);
                output.write_all(&chunk)?;
            }
            output.sync_all()?;
            if total != size {
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
        let mut guard = self.blocked_until.0.lock().ok()?;
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
        if let Ok(mut guard) = self.blocked_until.0.lock() {
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
        self.observe_bytes(url, PROVIDER_JSON_MAX_BYTES, |body| {
            let value = serde_json::from_slice(body)
                .map_err(|error| PortcoveError::network(error.to_string()))?;
            parse(&value)
        })
        .await
    }

    /// Reuses the same read-only transport, cache, and backoff for a pinned
    /// non-JSON provider endpoint with its own tighter response bound.
    pub(crate) async fn observe_bytes<T>(
        &self,
        url: reqwest::Url,
        max_bytes: usize,
        parse: impl Fn(&[u8]) -> Result<T>,
    ) -> Result<Observed<T>> {
        let key = url.as_str().to_owned();
        let cached = self
            .library
            .as_ref()
            .and_then(|library| library.http_cache(&key).ok().flatten());
        let stale = |reason: PortcoveError| -> Result<Observed<T>> {
            let entry = cached.as_ref().ok_or(reason)?;
            Ok(Observed {
                value: parse(entry.body.as_bytes())?,
                observed_at: entry.updated_at,
                freshness: ProviderFreshness::Stale,
            })
        };
        if let Some(wait) = self.backoff_remaining() {
            return stale(
                PortcoveError::network(format!("{} is rate limiting this client", self.label))
                    // The provider's own throttling started this back-off.
                    .with_upstream(Some(crate::failure::UpstreamObservation::Status(429)))
                    .detail("retry_after", wait.as_secs().max(1).to_string()),
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
            Err(error) => return stale(transport(&error)),
        };
        let status = response.status();
        if status == StatusCode::NOT_MODIFIED {
            let entry = cached.as_ref().ok_or_else(|| {
                PortcoveError::state(format!("{} returned 304 without cache", self.label))
            })?;
            let parsed = parse(entry.body.as_bytes())?;
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
        let github_throttle = self.site == "github.com"
            && status == StatusCode::FORBIDDEN
            && (response.headers().contains_key(header::RETRY_AFTER)
                || response
                    .headers()
                    .get("x-ratelimit-remaining")
                    .is_some_and(|remaining| remaining == "0"));
        if status == StatusCode::TOO_MANY_REQUESTS || status.is_server_error() || github_throttle {
            self.start_backoff(response.headers());
            let mut error = PortcoveError::network(format!("{} returned {status}", self.label))
                .with_upstream(Some(crate::failure::UpstreamObservation::Status(
                    status.as_u16(),
                )));
            if let Some(retry_after) = response
                .headers()
                .get(header::RETRY_AFTER)
                .and_then(|value| value.to_str().ok())
            {
                error = error.detail("retry_after", retry_after);
            }
            return stale(error);
        }
        if !status.is_success() {
            return Err(
                PortcoveError::network(format!("{} returned {status}", self.label)).with_upstream(
                    Some(crate::failure::UpstreamObservation::Status(status.as_u16())),
                ),
            );
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
        let body = bounded_response_bytes(response, max_bytes, self.label).await?;
        // Parse before caching: a malformed success never replaces a good entry.
        let parsed = parse(&body)?;
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

fn transport(error: &reqwest::Error) -> PortcoveError {
    PortcoveError::from_transport(error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// Serves one download whose body arrives `piece` bytes every `every`.
    async fn paced(body: Vec<u8>, piece: usize, every: Duration) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                request.push(stream.read_u8().await.unwrap());
            }
            let head = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            if stream.write_all(head.as_bytes()).await.is_err() {
                return;
            }
            for part in body.chunks(piece) {
                tokio::time::sleep(every).await;
                if stream.write_all(part).await.is_err() || stream.flush().await.is_err() {
                    return;
                }
            }
        });
        format!("http://{address}/file.zip")
    }

    fn client(floor: ProgressFloor) -> ProviderHttp {
        ProviderHttp::new(None, "Fixture", "127.0.0.1")
            .unwrap()
            .with_progress_floor(floor)
    }

    const FLOOR: ProgressFloor = ProgressFloor {
        window: Duration::from_millis(200),
        minimum_bytes: 100,
    };

    /// One 60-byte piece per one-second window keeps the slow transfer above
    /// the floor however unevenly the scheduler delivers its pieces.
    const SLOW_FLOOR: ProgressFloor = ProgressFloor {
        window: Duration::from_secs(1),
        minimum_bytes: 60,
    };

    #[tokio::test]
    async fn a_slow_download_that_keeps_progressing_completes() {
        // Under the removed size-derived deadline the same shape (scaled) was
        // cut although bytes kept flowing.
        let body: Vec<u8> = (0..2400u32).map(|value| value as u8).collect();
        let url = paced(body.clone(), 60, Duration::from_millis(25)).await;
        let temporary = tempfile::tempdir().unwrap();
        let destination = temporary.path().join("download.bin");
        let started = Instant::now();
        let (sha256, size) = client(SLOW_FLOOR)
            .download_exact(&url, body.len() as u64, &destination, 1 << 20, false)
            .await
            .unwrap();
        // Forty pieces 25 ms apart: the transfer really was slow.
        assert!(
            started.elapsed() >= Duration::from_millis(900),
            "{:?}",
            started.elapsed()
        );
        assert_eq!(size, body.len() as u64);
        assert_eq!(sha256, hex::encode(Sha256::digest(&body)));
        assert_eq!(std::fs::read(&destination).unwrap(), body);
    }

    #[tokio::test]
    async fn a_trickle_that_defeats_the_idle_bound_is_cut_by_the_progress_floor() {
        // One byte every 50 ms never trips the 15 second read-idle bound.
        let body = vec![7_u8; 4096];
        let url = paced(body.clone(), 1, Duration::from_millis(50)).await;
        let temporary = tempfile::tempdir().unwrap();
        let destination = temporary.path().join("download.bin");
        let error = tokio::time::timeout(
            Duration::from_secs(10),
            client(FLOOR).download_exact(&url, body.len() as u64, &destination, 1 << 20, false),
        )
        .await
        .expect("the progress floor must cut the trickle")
        .unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Network);
        assert!(
            error
                .details
                .contains_key(crate::transfer_progress::PROGRESS_FLOOR_DETAIL)
        );
        assert!(!destination.exists());
        assert_eq!(
            crate::TemporaryFailure::of(&error).map(|failure| failure.cause),
            Some(crate::TemporaryCause::Network)
        );
    }
}
