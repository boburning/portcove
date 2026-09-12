//! Restricted HTTPS transport for application-update metadata.

use std::collections::BTreeMap;
use std::io;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use futures_util::{StreamExt, stream};
use reqwest::Client;
use reqwest::redirect::Policy;
use tough::{Transport, TransportError, TransportErrorKind, TransportStream};
use url::Url;

use crate::application_update_network::{PublicDnsError, resolve_public_https_host};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const IDLE_TIMEOUT: Duration = Duration::from_secs(20);
const METADATA_DEADLINE: Duration = Duration::from_secs(120);
// This covers 32 root transitions, the four top-level roles and the bounded
// delegated-role traversal while still stopping request amplification.
const MAX_REQUESTS: u64 = 64;
const MAX_TOTAL_BYTES: u64 = 8 * 1024 * 1024;
const MAX_ROOT_BYTES: u64 = 256 * 1024;
const MAX_TIMESTAMP_BYTES: u64 = 32 * 1024;
const MAX_ROLE_BYTES: u64 = 1024 * 1024;
const MAX_RECORD_BYTES: u64 = 256 * 1024;

#[derive(Debug, thiserror::Error)]
pub(crate) enum TransportSetupError {
    #[error("{0}")]
    InvalidSource(String),
    #[error("{0}")]
    Network(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BaseKind {
    Metadata,
    Targets,
}

#[derive(Debug, Clone)]
struct TrustedBase {
    url: Url,
    kind: BaseKind,
}

#[derive(Debug)]
struct TransportBudget {
    deadline: Instant,
    requests: AtomicU64,
    bytes: AtomicU64,
}

impl TransportBudget {
    fn new(deadline: Instant) -> Self {
        Self {
            deadline,
            requests: AtomicU64::new(0),
            bytes: AtomicU64::new(0),
        }
    }

    fn remaining(&self) -> Option<Duration> {
        self.deadline.checked_duration_since(Instant::now())
    }

    fn begin_request(&self) -> bool {
        self.remaining().is_some() && reserve(&self.requests, 1, MAX_REQUESTS)
    }

    fn can_fit(&self, bytes: u64) -> bool {
        self.bytes
            .load(Ordering::Acquire)
            .checked_add(bytes)
            .is_some_and(|total| total <= MAX_TOTAL_BYTES)
    }

    fn record_bytes(&self, bytes: u64) -> bool {
        reserve(&self.bytes, bytes, MAX_TOTAL_BYTES)
    }
}

fn reserve(counter: &AtomicU64, amount: u64, maximum: u64) -> bool {
    counter
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
            current
                .checked_add(amount)
                .filter(|updated| *updated <= maximum)
        })
        .is_ok()
}

/// A no-redirect HTTPS client bound to reviewed bases and one DNS result set.
#[derive(Debug, Clone)]
pub(crate) struct PinnedHttpsTransport {
    client: Client,
    bases: [TrustedBase; 2],
    budget: Arc<TransportBudget>,
}

impl PinnedHttpsTransport {
    pub(crate) async fn new(
        metadata_base_url: &Url,
        targets_base_url: &Url,
    ) -> Result<Self, TransportSetupError> {
        let deadline = Instant::now() + METADATA_DEADLINE;
        let metadata = validate_base(metadata_base_url, "metadata")?;
        let targets = validate_base(targets_base_url, "targets")?;
        if metadata.as_str().starts_with(targets.as_str())
            || targets.as_str().starts_with(metadata.as_str())
        {
            return Err(TransportSetupError::InvalidSource(
                "metadata and target HTTPS path prefixes must be distinct".into(),
            ));
        }

        let mut resolved = BTreeMap::<String, Vec<SocketAddr>>::new();
        for base in [&metadata, &targets] {
            let host = base.host_str().expect("validated HTTPS base has a host");
            if resolved.contains_key(host) {
                continue;
            }
            let addresses =
                resolve_public_https_host(host, deadline, "application update metadata")
                    .await
                    .map_err(|error| match error {
                        PublicDnsError::InvalidDestination(message) => {
                            TransportSetupError::InvalidSource(message)
                        }
                        PublicDnsError::Network(message) => TransportSetupError::Network(message),
                    })?;
            resolved.insert(host.to_owned(), addresses);
        }

        let mut builder = Client::builder()
            .https_only(true)
            .redirect(Policy::none())
            .no_proxy()
            .referer(false)
            .connect_timeout(CONNECT_TIMEOUT)
            .read_timeout(IDLE_TIMEOUT)
            .timeout(METADATA_DEADLINE)
            .user_agent("Portcove application updater/1");
        for (host, addresses) in &resolved {
            builder = builder.resolve_to_addrs(host, addresses);
        }
        let client = builder.build().map_err(|_| {
            TransportSetupError::Network(
                "could not initialize application update metadata transport".into(),
            )
        })?;

        Ok(Self {
            client,
            bases: [
                TrustedBase {
                    url: metadata,
                    kind: BaseKind::Metadata,
                },
                TrustedBase {
                    url: targets,
                    kind: BaseKind::Targets,
                },
            ],
            budget: Arc::new(TransportBudget::new(deadline)),
        })
    }

    fn request_limit(&self, url: &Url) -> Option<u64> {
        let base = self.bases.iter().find(|base| accepts(base, url))?;
        if base.kind == BaseKind::Targets {
            return Some(MAX_RECORD_BYTES);
        }
        let filename = url.path().rsplit('/').next()?;
        if filename == "timestamp.json" {
            Some(MAX_TIMESTAMP_BYTES)
        } else if filename == "root.json" || filename.ends_with(".root.json") {
            Some(MAX_ROOT_BYTES)
        } else {
            Some(MAX_ROLE_BYTES)
        }
    }
}

#[async_trait]
impl Transport for PinnedHttpsTransport {
    async fn fetch(&self, url: Url) -> Result<TransportStream, TransportError> {
        let Some(request_limit) = self.request_limit(&url) else {
            return Err(TransportError::new(
                TransportErrorKind::UnsupportedUrlScheme,
                url.as_str(),
            ));
        };
        if !self.budget.begin_request() {
            return Err(other_error(
                &url,
                "metadata request budget or deadline exceeded",
            ));
        }
        let remaining = self
            .budget
            .remaining()
            .ok_or_else(|| other_error(&url, "metadata deadline exceeded"))?;
        let response = tokio::time::timeout(remaining, self.client.get(url.clone()).send())
            .await
            .map_err(|_| other_error(&url, "metadata deadline exceeded"))?
            .map_err(|error| {
                TransportError::new_with_cause(TransportErrorKind::Other, url.as_str(), error)
            })?;
        if !response.status().is_success() {
            let kind = if matches!(response.status().as_u16(), 403 | 404 | 410) {
                TransportErrorKind::FileNotFound
            } else {
                TransportErrorKind::Other
            };
            return Err(TransportError::new_with_cause(
                kind,
                url.as_str(),
                io::Error::other(format!("HTTP {}", response.status())),
            ));
        }
        if response
            .content_length()
            .is_some_and(|length| length > request_limit || !self.budget.can_fit(length))
        {
            return Err(other_error(
                &url,
                "metadata content length exceeds its byte budget",
            ));
        }

        let stream_url = url.clone();
        let source: TransportStream = Box::pin(response.bytes_stream().map(move |result| {
            result.map_err(|error| {
                TransportError::new_with_cause(
                    TransportErrorKind::Other,
                    stream_url.as_str(),
                    error,
                )
            })
        }));
        Ok(bounded_stream(
            source,
            url,
            request_limit,
            Arc::clone(&self.budget),
        ))
    }
}

fn bounded_stream(
    source: TransportStream,
    url: Url,
    request_limit: u64,
    budget: Arc<TransportBudget>,
) -> TransportStream {
    Box::pin(stream::try_unfold(
        (source, 0_u64),
        move |(mut source, received)| {
            let url = url.clone();
            let budget = Arc::clone(&budget);
            async move {
                let remaining = budget
                    .remaining()
                    .ok_or_else(|| other_error(&url, "metadata deadline exceeded"))?;
                let timeout = remaining.min(IDLE_TIMEOUT);
                let next = tokio::time::timeout(timeout, source.next())
                    .await
                    .map_err(|_| other_error(&url, "metadata stream stalled or expired"))?;
                let Some(chunk) = next else {
                    return Ok(None);
                };
                let chunk = chunk?;
                let bytes = u64::try_from(chunk.len())
                    .map_err(|_| other_error(&url, "metadata chunk length overflowed"))?;
                if !budget.record_bytes(bytes) {
                    return Err(other_error(&url, "aggregate metadata byte budget exceeded"));
                }
                let updated = received
                    .checked_add(bytes)
                    .filter(|total| *total <= request_limit)
                    .ok_or_else(|| other_error(&url, "metadata file exceeds its byte budget"))?;
                Ok(Some((chunk, (source, updated))))
            }
        },
    ))
}

fn validate_base(url: &Url, label: &str) -> Result<Url, TransportSetupError> {
    let host = url.host_str().ok_or_else(|| {
        TransportSetupError::InvalidSource(format!("{label} HTTPS base has no host"))
    })?;
    if url.as_str().len() > 4096
        || url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port_or_known_default() != Some(443)
        || url.query().is_some()
        || url.fragment().is_some()
        || url.cannot_be_a_base()
        || !url.path().ends_with('/')
        || url.path().contains('%')
        || host.eq_ignore_ascii_case("localhost")
        || host.ends_with(".local")
        || host.parse::<IpAddr>().is_ok()
    {
        return Err(TransportSetupError::InvalidSource(format!(
            "{label} requires a domain HTTPS base on port 443 with a trailing path separator and no credentials, escapes, query or fragment"
        )));
    }
    Ok(url.clone())
}

fn accepts(base: &TrustedBase, url: &Url) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port_or_known_default() == Some(443)
        && url.query().is_none()
        && url.fragment().is_none()
        && !url.path().contains('%')
        && url.origin() == base.url.origin()
        && url.as_str().starts_with(base.url.as_str())
}

fn other_error(url: &Url, message: &str) -> TransportError {
    TransportError::new_with_cause(
        TransportErrorKind::Other,
        url.as_str(),
        io::Error::other(message),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::TryStreamExt;

    #[test]
    fn https_bases_are_unambiguous_and_path_scoped() {
        let metadata = TrustedBase {
            url: validate_base(
                &Url::parse("https://updates.example/portcove/metadata/").unwrap(),
                "metadata",
            )
            .unwrap(),
            kind: BaseKind::Metadata,
        };
        assert!(accepts(
            &metadata,
            &Url::parse("https://updates.example/portcove/metadata/timestamp.json").unwrap()
        ));
        for refused in [
            "http://updates.example/portcove/metadata/timestamp.json",
            "https://updates.example/portcove/other/timestamp.json",
            "https://other.example/portcove/metadata/timestamp.json",
            "https://updates.example/portcove/metadata/timestamp.json?old=true",
        ] {
            assert!(
                !accepts(&metadata, &Url::parse(refused).unwrap()),
                "{refused}"
            );
        }
    }

    #[test]
    fn unsafe_https_bases_are_refused() {
        for refused in [
            "http://updates.example/metadata/",
            "https://user@updates.example/metadata/",
            "https://updates.example:444/metadata/",
            "https://updates.example/metadata",
            "https://updates.example/meta%2fdata/",
            "https://127.0.0.1/metadata/",
            "https://localhost/metadata/",
        ] {
            assert!(validate_base(&Url::parse(refused).unwrap(), "metadata").is_err());
        }
    }

    #[tokio::test]
    async fn streams_enforce_file_and_aggregate_caps_without_content_length() {
        let url = Url::parse("https://updates.example/metadata/targets.json").unwrap();
        let budget = Arc::new(TransportBudget::new(Instant::now() + METADATA_DEADLINE));
        let source: TransportStream = Box::pin(stream::iter(vec![
            Ok(vec![0_u8; 3].into()),
            Ok(vec![0_u8; 3].into()),
        ]));
        let error = bounded_stream(source, url, 5, budget)
            .try_collect::<Vec<_>>()
            .await
            .unwrap_err();
        assert!(error.to_string().contains("file exceeds its byte budget"));

        let budget = Arc::new(TransportBudget {
            deadline: Instant::now() + METADATA_DEADLINE,
            requests: AtomicU64::new(0),
            bytes: AtomicU64::new(MAX_TOTAL_BYTES - 2),
        });
        let source: TransportStream = Box::pin(stream::iter(vec![Ok(vec![0_u8; 3].into())]));
        let error = bounded_stream(
            source,
            Url::parse("https://updates.example/metadata/snapshot.json").unwrap(),
            MAX_ROLE_BYTES,
            budget,
        )
        .try_collect::<Vec<_>>()
        .await
        .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("aggregate metadata byte budget exceeded")
        );
    }
}
