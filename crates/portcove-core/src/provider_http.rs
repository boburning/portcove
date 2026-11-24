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

/// In-process pause after throttling or a server error with no stated wait.
const DEFAULT_BACKOFF: Duration = Duration::from_secs(60);
/// The longest in-process pause (class 3: a bounded, in-memory request pause
/// that expires and is never stored). A longer stated wait is still honored
/// by unattended work: the failure keeps the provider's `Retry-After`, and the
/// durable retry schedule reads it through the one parser, up to
/// `STATED_WAIT_CEILING_SECONDS`. This cap only keeps one process from
/// refusing the provider's cached reads for longer than this.
const MAX_BACKOFF: Duration = Duration::from_secs(15 * 60);

/// Shared request backoff for a provider across short-lived client instances:
/// until when, and the HTTP status that started it.
#[derive(Clone, Debug, Default)]
pub(crate) struct ProviderBackoff(Arc<Mutex<Option<(Instant, u16)>>>);

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
    #[cfg(test)]
    progress_clock: Option<crate::transfer_progress::ByteClock>,
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
            #[cfg(test)]
            progress_clock: None,
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

    #[cfg(test)]
    fn with_progress_clock(mut self, clock: crate::transfer_progress::ByteClock) -> Self {
        self.progress_clock = Some(clock);
        self
    }

    fn progress_watch(&self) -> ProgressWatch {
        #[cfg(test)]
        if let Some(clock) = &self.progress_clock {
            return ProgressWatch::with_clock(self.progress_floor, clock.clone());
        }
        ProgressWatch::new(self.progress_floor)
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
                self.start_backoff(status, response.headers());
            }
            if !status.is_success() {
                return Err(with_retry_after(
                    PortcoveError::network(format!("download returned {status}")).with_upstream(
                        Some(crate::failure::UpstreamObservation::Status(status.as_u16())),
                    ),
                    response.headers(),
                ));
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
            let mut progress = self.progress_watch();
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

    /// The remaining pause and the status that started it.
    fn backoff_remaining(&self) -> Option<(Duration, u16)> {
        let mut guard = self.blocked_until.0.lock().ok()?;
        match *guard {
            Some((until, status)) if until > Instant::now() => {
                Some((until - Instant::now(), status))
            }
            Some(_) => {
                *guard = None;
                None
            }
            None => None,
        }
    }

    /// Pauses this provider's requests for its stated `Retry-After` (read by
    /// the one shared parser, every HTTP form), or [`DEFAULT_BACKOFF`] when it
    /// stated none, at most [`MAX_BACKOFF`].
    fn start_backoff(&self, status: StatusCode, headers: &header::HeaderMap) {
        let now = crate::Library::now();
        let wait = headers
            .get(header::RETRY_AFTER)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| crate::temporary_failure::parse_retry_after(value, now))
            .map_or(DEFAULT_BACKOFF, |until| {
                Duration::from_secs(u64::try_from(until.saturating_sub(now)).unwrap_or(0))
            })
            .min(MAX_BACKOFF);
        if let Ok(mut guard) = self.blocked_until.0.lock() {
            *guard = Some((Instant::now() + wait, status.as_u16()));
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
        if let Some((wait, status)) = self.backoff_remaining() {
            // The answer that started this back-off is what is recorded: a
            // throttle stays a rate limit, a server error stays one.
            let message = if status >= 500 {
                format!("{} is unavailable right now", self.label)
            } else {
                format!("{} is rate limiting this client", self.label)
            };
            return stale(
                PortcoveError::network(message)
                    .with_upstream(Some(crate::failure::UpstreamObservation::Status(status)))
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
            self.start_backoff(status, response.headers());
            return stale(with_retry_after(
                PortcoveError::network(format!("{} returned {status}", self.label)).with_upstream(
                    Some(crate::failure::UpstreamObservation::Status(status.as_u16())),
                ),
                response.headers(),
            ));
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
        // A connection that ends mid-body is an interruption (temporary); a
        // body over the limit keeps its own lasting verification failure.
        let body = bounded_response_bytes(response, max_bytes, self.label)
            .await
            .map_err(PortcoveError::mark_interrupted_body)?;
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

impl ProviderHttp {
    /// Whether `url` is on this provider's own site: the same origin as
    /// `origin`, or HTTPS on the provider's registrable site or a subdomain.
    pub(crate) fn on_provider_site(&self, origin: &reqwest::Url, url: &reqwest::Url) -> bool {
        let same_origin = url.scheme() == origin.scheme()
            && url.host_str() == origin.host_str()
            && url.port_or_known_default() == origin.port_or_known_default();
        let provider_host = url.scheme() == "https"
            && url.port().is_none()
            && url.host_str().is_some_and(|host| {
                host == self.site || host.ends_with(&format!(".{}", self.site))
            });
        (same_origin || provider_host) && url.username().is_empty() && url.password().is_none()
    }

    /// Reads one bounded response body, following at most four redirects that
    /// stay on the provider's own site. Throttling and server errors start the
    /// provider-wide backoff and keep the answer's status and `Retry-After`;
    /// while the backoff lasts no request is made. A `transfer` (a larger
    /// body) has connection and idle-read bounds and the shared progress
    /// floor but no overall deadline, so it finishes while bytes keep
    /// arriving; other reads also have the metadata request deadline. A body
    /// cut off mid-stream is an interruption (temporary).
    pub(crate) async fn read_site_bytes(
        &self,
        url: reqwest::Url,
        max_bytes: usize,
        transfer: bool,
    ) -> Result<Vec<u8>> {
        if let Some((wait, status)) = self.backoff_remaining() {
            let message = if status >= 500 {
                format!("{} is unavailable right now", self.label)
            } else {
                format!("{} is rate limiting this client", self.label)
            };
            return Err(PortcoveError::network(message)
                .with_upstream(Some(crate::failure::UpstreamObservation::Status(status)))
                .detail("retry_after", wait.as_secs().max(1).to_string()));
        }
        let origin = url.clone();
        let mut current = url;
        for _ in 0..=4 {
            let client = if transfer {
                &self.download_client
            } else {
                &self.client
            };
            let response = client
                .get(current.clone())
                .send()
                .await
                .map_err(|error| transport(&error))?;
            let status = response.status();
            if status.is_redirection() {
                let next = response
                    .headers()
                    .get(header::LOCATION)
                    .and_then(|value| value.to_str().ok())
                    .and_then(|location| current.join(location).ok())
                    .ok_or_else(|| {
                        PortcoveError::network(format!("{} redirect has no location", self.label))
                    })?;
                if !self.on_provider_site(&origin, &next) {
                    return Err(PortcoveError::verification(format!(
                        "{} redirected away from its own site",
                        self.label
                    )));
                }
                current = next;
                continue;
            }
            if status == StatusCode::TOO_MANY_REQUESTS || status.is_server_error() {
                self.start_backoff(status, response.headers());
            }
            if !status.is_success() {
                return Err(with_retry_after(
                    PortcoveError::network(format!("{} returned {status}", self.label))
                        .with_upstream(Some(crate::failure::UpstreamObservation::Status(
                            status.as_u16(),
                        ))),
                    response.headers(),
                ));
            }
            if !transfer {
                return bounded_response_bytes(response, max_bytes, self.label)
                    .await
                    .map_err(PortcoveError::mark_interrupted_body);
            }
            return self.progressing_body(response, max_bytes).await;
        }
        Err(PortcoveError::network(format!(
            "{} redirected too many times",
            self.label
        )))
    }

    /// A bounded body read under the shared progress floor instead of a
    /// whole-response deadline.
    async fn progressing_body(
        &self,
        response: reqwest::Response,
        max_bytes: usize,
    ) -> Result<Vec<u8>> {
        use futures_util::StreamExt;
        let limit_error = || {
            PortcoveError::verification(format!(
                "{} exceeds the {max_bytes} byte limit",
                self.label
            ))
            .detail("response_byte_limit", max_bytes.to_string())
        };
        if response
            .content_length()
            .is_some_and(|length| length > max_bytes as u64)
        {
            return Err(limit_error());
        }
        let mut progress = self.progress_watch();
        let mut body = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| transport(&error))?;
            progress.record(chunk.len() as u64)?;
            if chunk.len() > max_bytes.saturating_sub(body.len()) {
                return Err(limit_error());
            }
            body.extend_from_slice(&chunk);
        }
        Ok(body)
    }

    pub(crate) fn library(&self) -> Option<&Library> {
        self.library.as_ref()
    }
}

fn transport(error: &reqwest::Error) -> PortcoveError {
    PortcoveError::from_transport(error)
}

/// Keeps the provider's stated wait on a failed answer, raw, for the one
/// `Retry-After` parser to read when the failure is classified.
fn with_retry_after(error: PortcoveError, headers: &header::HeaderMap) -> PortcoveError {
    match headers
        .get(header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
    {
        Some(retry_after) => error.detail("retry_after", retry_after),
        None => error,
    }
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
                if !every.is_zero() {
                    tokio::time::sleep(every).await;
                }
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

    /// A 250 ms window that needs 60 bytes: the slow transfer below carries
    /// 600 bytes per window, ten times the floor, over twelve windows.
    const SLOW_FLOOR: ProgressFloor = ProgressFloor {
        window: Duration::from_millis(250),
        minimum_bytes: 60,
    };

    #[tokio::test]
    async fn a_slow_download_that_keeps_progressing_completes() {
        // Under the removed size-derived deadline the same shape (scaled) was
        // cut although bytes kept flowing. Time here is the transfer's own:
        // each byte advances a virtual clock at exactly 2,400 bytes per second
        // (60 bytes every 25 ms), so the result depends on neither scheduler
        // timing nor real waiting, however the bytes are split into reads.
        let body: Vec<u8> = (0..7200u32).map(|value| value as u8).collect();
        let url = paced(body.clone(), 60, Duration::ZERO).await;
        let temporary = tempfile::tempdir().unwrap();
        let destination = temporary.path().join("download.bin");
        let start = Instant::now();
        let latest = Arc::new(Mutex::new(start));
        let clock = {
            let latest = latest.clone();
            crate::transfer_progress::ByteClock(Arc::new(move |received: u64| {
                let now = start + Duration::from_millis(received * 25 / 60);
                *latest.lock().unwrap() = now;
                now
            }))
        };
        let (sha256, size) = client(SLOW_FLOOR)
            .with_progress_clock(clock)
            .download_exact(&url, body.len() as u64, &destination, 1 << 20, false)
            .await
            .unwrap();
        // The transfer's own time spanned twelve floor windows.
        let spanned = latest.lock().unwrap().duration_since(start);
        assert_eq!(spanned, Duration::from_secs(3));
        assert!(spanned >= SLOW_FLOOR.window * 12);
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

    /// Answers one request with `head` and then `body`, then closes.
    async fn answer_once(head: String, body: Vec<u8>) -> reqwest::Url {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                request.push(stream.read_u8().await.unwrap());
            }
            let _ = stream.write_all(head.as_bytes()).await;
            let _ = stream.write_all(&body).await;
            let _ = stream.flush().await;
        });
        reqwest::Url::parse(&format!("http://{address}/listing.json")).unwrap()
    }

    fn echo(value: &Value) -> Result<Value> {
        Ok(value.clone())
    }

    fn direct() -> reqwest::Client {
        reqwest::Client::builder().no_proxy().build().unwrap()
    }

    fn json(body: &[u8]) -> Result<Value> {
        serde_json::from_slice(body).map_err(|error| PortcoveError::network(error.to_string()))
    }

    #[tokio::test]
    async fn a_listing_cut_off_mid_body_is_temporary_and_a_malformed_one_is_lasting() {
        // The connection closes after 10 of the 1,000 declared bytes.
        let url = answer_once(
            "HTTP/1.1 200 OK\r\nContent-Length: 1000\r\nConnection: close\r\n\r\n".into(),
            b"{\"files\":[".to_vec(),
        )
        .await;
        let error = client(FLOOR)
            .observe(url, |value| Ok(value.clone()))
            .await
            .unwrap_err();
        assert_eq!(
            crate::TemporaryFailure::of(&error).map(|failure| failure.cause),
            Some(crate::TemporaryCause::Network),
            "{error:?}"
        );

        // A complete answer that is not the expected document stays lasting.
        let body = b"<html>maintenance</html>".to_vec();
        let url = answer_once(
            format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            ),
            body,
        )
        .await;
        let error = ProviderHttp::new(None, "Fixture", "127.0.0.1")
            .unwrap()
            .observe_bytes(url, PROVIDER_JSON_MAX_BYTES, json)
            .await
            .unwrap_err();
        assert_eq!(crate::TemporaryFailure::of(&error), None, "{error:?}");
    }

    #[tokio::test]
    async fn a_back_off_keeps_the_status_that_started_it_and_reads_any_retry_after_form() {
        // A server error with an HTTP-date wait: the pause follows that date
        // (the one parser), and the refusals while it lasts stay a server
        // error, never a rate limit.
        let now = crate::Library::now();
        let date = time::OffsetDateTime::from_unix_timestamp(now + 120)
            .unwrap()
            .format(&time::format_description::well_known::Rfc2822)
            .unwrap()
            .replace("+0000", "GMT");
        let url = answer_once(
            format!(
                "HTTP/1.1 503 Service Unavailable\r\nRetry-After: {date}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            ),
            Vec::new(),
        )
        .await;
        let provider = client(FLOOR);
        let first = provider.observe(url.clone(), echo).await.unwrap_err();
        assert_eq!(
            crate::TemporaryFailure::of(&first).map(|failure| failure.cause),
            Some(crate::TemporaryCause::ServerUnavailable)
        );
        let (wait, status) = provider.backoff_remaining().unwrap();
        assert_eq!(status, 503);
        assert!(
            wait > Duration::from_secs(60) && wait <= Duration::from_secs(121),
            "{wait:?}"
        );
        // No second connection: the back-off answers.
        let during = provider.observe(url, echo).await.unwrap_err();
        assert!(
            !during.message.contains("rate limiting"),
            "{}",
            during.message
        );
        let failure = crate::TemporaryFailure::of(&during).unwrap();
        assert_eq!(failure.cause, crate::TemporaryCause::ServerUnavailable);
        assert!(failure.stated_reset.is_some_and(|reset| reset > now));

        // A throttle stays a rate limit, and a stated wait over the in-process
        // cap still pauses for at most the cap.
        let url = answer_once(
            "HTTP/1.1 429 Too Many Requests\r\nRetry-After: 7200\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into(),
            Vec::new(),
        )
        .await;
        let provider = client(FLOOR);
        let first = provider.observe(url.clone(), echo).await.unwrap_err();
        let failure = crate::TemporaryFailure::of(&first).unwrap();
        assert_eq!(failure.cause, crate::TemporaryCause::RateLimited);
        // The durable schedule keeps the provider's full stated wait.
        assert!(
            failure
                .stated_reset
                .is_some_and(|reset| reset >= now + 7200)
        );
        let (wait, status) = provider.backoff_remaining().unwrap();
        assert_eq!(status, 429);
        assert!(wait <= MAX_BACKOFF);
        let during = provider.observe(url, echo).await.unwrap_err();
        assert_eq!(
            crate::TemporaryFailure::of(&during).map(|failure| failure.cause),
            Some(crate::TemporaryCause::RateLimited)
        );
    }

    #[tokio::test]
    async fn a_body_cut_off_mid_stream_is_an_interruption() {
        use futures_util::StreamExt;
        let truncated = answer_once(
            "HTTP/1.1 200 OK\r\nContent-Length: 1000\r\nConnection: close\r\n\r\n".into(),
            vec![1; 10],
        )
        .await;
        let response = direct().get(truncated).send().await.unwrap();
        let mut stream = response.bytes_stream();
        let error = loop {
            match stream.next().await {
                Some(Ok(_)) => {}
                Some(Err(error)) => break error,
                None => panic!("a truncated body must end in an error"),
            }
        };
        // reqwest names a cut-off body stream a decode error; it is still an
        // interruption, never a lasting verdict.
        let converted = PortcoveError::from_transport(&error);
        assert!(converted.is_transient_transport(), "{error:?}");
        assert_eq!(
            crate::TemporaryFailure::of(&converted).map(|failure| failure.cause),
            Some(crate::TemporaryCause::Network)
        );
    }
}
