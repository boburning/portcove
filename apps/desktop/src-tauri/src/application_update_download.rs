//! Anonymous, bounded acquisition of authenticated application-update payloads.

use std::collections::BTreeSet;
use std::io;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use bytes::Bytes;
use futures_util::stream::{self, BoxStream};
use futures_util::{StreamExt, TryStreamExt};
use reqwest::header::{CONTENT_ENCODING, LOCATION};
use reqwest::{Client, Response};
use tokio::io::{AsyncRead, ReadBuf};
use tokio_util::io::StreamReader;
use url::Url;

use crate::application_update::{
    SelectedCandidate, UpdateMetadataError, validate_artifact_url, validate_selected_candidate,
};
use crate::application_update_network::{PublicDnsError, resolve_public_https_host};

const GITHUB_ASSET_HOST: &str = "release-assets.githubusercontent.com";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const IDLE_TIMEOUT: Duration = Duration::from_secs(30);
const PAYLOAD_DEADLINE: Duration = Duration::from_secs(30 * 60);
const MAX_REDIRECTS: usize = 5;
const MAX_URL_BYTES: usize = 8 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum PayloadDownloadError {
    #[error("application update payload source is not permitted: {0}")]
    InvalidSource(String),
    #[error("application update payload network failed: {0}")]
    Network(String),
    #[error("application update payload request exceeded its deadline")]
    Deadline,
    #[error("application update payload redirect is invalid: {0}")]
    InvalidRedirect(String),
    #[error("application update payload exceeded {MAX_REDIRECTS} redirects")]
    TooManyRedirects,
    #[error("application update payload returned HTTP {0}")]
    HttpStatus(u16),
    #[error(
        "application update payload content length differs from authenticated metadata: expected {expected}, received {actual}"
    )]
    ContentLengthMismatch { expected: u64, actual: u64 },
    #[error(transparent)]
    Candidate(#[from] UpdateMetadataError),
}

type DownloadByteStream = BoxStream<'static, Result<Bytes, io::Error>>;

pub struct PayloadDownload {
    reader: StreamReader<DownloadByteStream, Bytes>,
}

impl AsyncRead for PayloadDownload {
    fn poll_read(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().reader).poll_read(context, buffer)
    }
}

/// Opens the exact immutable release asset named by an authenticated selected
/// candidate. The returned reader carries no credential, follows only bounded
/// GitHub release-asset redirects, and enforces DNS, request, idle, byte and
/// overall deadlines while the staging verifier consumes it.
pub async fn download_payload(
    candidate: &SelectedCandidate,
) -> Result<PayloadDownload, PayloadDownloadError> {
    validate_selected_candidate(candidate)?;
    let initial =
        validate_artifact_url(&candidate.release.artifact.url, &candidate.release.version)?;

    let deadline = Instant::now() + PAYLOAD_DEADLINE;
    let mut current = initial.clone();
    let mut redirects = 0_usize;
    let mut visited = BTreeSet::new();
    loop {
        if !visited.insert(current.as_str().to_owned()) {
            return Err(PayloadDownloadError::InvalidRedirect(
                "redirect loop detected".into(),
            ));
        }
        if current != initial {
            validate_asset_redirect(&current)?;
        }
        let response = request(&current, deadline).await?;
        if response.status().is_redirection() {
            if redirects == MAX_REDIRECTS {
                return Err(PayloadDownloadError::TooManyRedirects);
            }
            let location = response
                .headers()
                .get(LOCATION)
                .ok_or_else(|| {
                    PayloadDownloadError::InvalidRedirect(
                        "redirect response omitted Location".into(),
                    )
                })?
                .to_str()
                .map_err(|_| {
                    PayloadDownloadError::InvalidRedirect(
                        "redirect Location is not valid text".into(),
                    )
                })?;
            current = current.join(location).map_err(|_| {
                PayloadDownloadError::InvalidRedirect("redirect Location is malformed".into())
            })?;
            validate_asset_redirect(&current)?;
            redirects += 1;
            continue;
        }
        if !response.status().is_success() {
            return Err(PayloadDownloadError::HttpStatus(response.status().as_u16()));
        }
        if response.headers().contains_key(CONTENT_ENCODING) {
            return Err(PayloadDownloadError::InvalidSource(
                "encoded payload responses are not permitted".into(),
            ));
        }
        let expected = candidate.release.artifact.bytes;
        if let Some(actual) = response.content_length()
            && actual != expected
        {
            return Err(PayloadDownloadError::ContentLengthMismatch { expected, actual });
        }
        return Ok(PayloadDownload {
            reader: StreamReader::new(bounded_body(response, expected, deadline)),
        });
    }
}

async fn request(url: &Url, deadline: Instant) -> Result<Response, PayloadDownloadError> {
    let host = url
        .host_str()
        .ok_or_else(|| PayloadDownloadError::InvalidSource("URL has no host".into()))?;
    let addresses = resolve_public_https_host(host, deadline, "application update payload")
        .await
        .map_err(|error| match error {
            PublicDnsError::InvalidDestination(message) => {
                PayloadDownloadError::InvalidSource(message)
            }
            PublicDnsError::Network(message) => PayloadDownloadError::Network(message),
        })?;
    let client = Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .referer(false)
        .connect_timeout(CONNECT_TIMEOUT)
        .read_timeout(IDLE_TIMEOUT)
        .user_agent(concat!(
            "Portcove application updater/",
            env!("CARGO_PKG_VERSION")
        ))
        .resolve_to_addrs(host, &addresses)
        .build()
        .map_err(|_| {
            PayloadDownloadError::Network("could not initialize payload transport".into())
        })?;
    let remaining = deadline
        .checked_duration_since(Instant::now())
        .ok_or(PayloadDownloadError::Deadline)?;
    tokio::time::timeout(remaining, client.get(url.clone()).send())
        .await
        .map_err(|_| PayloadDownloadError::Deadline)?
        .map_err(|_| PayloadDownloadError::Network("request failed".into()))
}

fn validate_common_url(url: &Url) -> Result<(), PayloadDownloadError> {
    if url.as_str().len() > MAX_URL_BYTES
        || url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port_or_known_default() != Some(443)
        || url.fragment().is_some()
        || url.path().contains('%')
    {
        return Err(PayloadDownloadError::InvalidSource(
            "URL must be bounded HTTPS on port 443 without credentials, path escapes or fragment"
                .into(),
        ));
    }
    Ok(())
}

fn validate_asset_redirect(url: &Url) -> Result<(), PayloadDownloadError> {
    validate_common_url(url)
        .map_err(|error| PayloadDownloadError::InvalidRedirect(error.to_string()))?;
    if url.host_str() != Some(GITHUB_ASSET_HOST) {
        return Err(PayloadDownloadError::InvalidRedirect(
            "redirect host is not an approved GitHub release-asset host".into(),
        ));
    }
    let segments = url.path_segments().map(Vec::from_iter).unwrap_or_default();
    if segments.len() != 3
        || segments[0] != "github-production-release-asset"
        || segments[1].is_empty()
        || !segments[1].bytes().all(|byte| byte.is_ascii_digit())
        || !safe_path_segment(segments[2])
    {
        return Err(PayloadDownloadError::InvalidRedirect(
            "redirect path is not a GitHub release-asset identity".into(),
        ));
    }
    Ok(())
}

fn safe_path_segment(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._+-".contains(&byte))
}

fn bounded_body(response: Response, expected: u64, deadline: Instant) -> DownloadByteStream {
    let source: DownloadByteStream = response
        .bytes_stream()
        .map_err(|_| io::Error::other("payload response body failed"))
        .boxed();
    bounded_stream(source, expected, deadline)
}

fn bounded_stream(
    source: DownloadByteStream,
    expected: u64,
    deadline: Instant,
) -> DownloadByteStream {
    stream::try_unfold((source, 0_u64), move |(mut source, received)| async move {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or_else(|| io::Error::new(io::ErrorKind::TimedOut, "payload deadline exceeded"))?;
        let next = tokio::time::timeout(remaining.min(IDLE_TIMEOUT), source.next())
            .await
            .map_err(|_| {
                io::Error::new(io::ErrorKind::TimedOut, "payload stream stalled or expired")
            })?;
        let Some(chunk) = next else {
            return Ok(None);
        };
        let chunk = chunk?;
        let bytes = u64::try_from(chunk.len())
            .map_err(|_| io::Error::other("payload chunk length overflowed"))?;
        let updated = received
            .checked_add(bytes)
            .filter(|total| *total <= expected)
            .ok_or_else(|| io::Error::other("payload exceeded authenticated length"))?;
        Ok(Some((chunk, (source, updated))))
    })
    .boxed()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncReadExt;

    #[test]
    fn initial_url_is_bound_to_repository_and_version() {
        validate_artifact_url(
            "https://github.com/boburning/portcove/releases/download/v0.2.0/Portcove.exe",
            "0.2.0",
        )
        .unwrap();

        for refused in [
            "http://github.com/boburning/portcove/releases/download/v0.2.0/Portcove.exe",
            "https://user@github.com/boburning/portcove/releases/download/v0.2.0/Portcove.exe",
            "https://github.com/other/portcove/releases/download/v0.2.0/Portcove.exe",
            "https://github.com/boburning/portcove/releases/download/v0.3.0/Portcove.exe",
            "https://github.com/boburning/portcove/releases/download/v0.2.0/sub/Portcove.exe",
            "https://github.com/boburning/portcove/releases/download/v0.2.0/Portcove%2F.exe",
            "https://github.com/boburning/portcove/releases/download/v0.2.0/Portcove.exe?token=1",
        ] {
            assert!(
                validate_artifact_url(refused, "0.2.0").is_err(),
                "{refused}"
            );
        }
    }

    #[test]
    fn redirects_are_limited_to_github_release_asset_identities() {
        let accepted = Url::parse(
            "https://release-assets.githubusercontent.com/github-production-release-asset/1354613114/f2e64ccc-26af-4f55-9ffa-ce621f3adba8?sig=value",
        )
        .unwrap();
        validate_asset_redirect(&accepted).unwrap();

        for refused in [
            "https://objects.githubusercontent.com/github-production-release-asset/1354613114/f2e64ccc",
            "https://release-assets.githubusercontent.com/other/1354613114/f2e64ccc",
            "https://release-assets.githubusercontent.com/github-production-release-asset/not-a-number/f2e64ccc",
            "https://release-assets.githubusercontent.com/github-production-release-asset/1354613114/a/b",
            "https://release-assets.githubusercontent.com/github-production-release-asset/1354613114/f2e64ccc#fragment",
            "http://release-assets.githubusercontent.com/github-production-release-asset/1354613114/f2e64ccc",
        ] {
            assert!(
                validate_asset_redirect(&Url::parse(refused).unwrap()).is_err(),
                "{refused}"
            );
        }
    }

    #[tokio::test]
    async fn body_stream_enforces_authenticated_size_and_deadline() {
        let source: DownloadByteStream = stream::iter([
            Ok(Bytes::from_static(b"four")),
            Ok(Bytes::from_static(b"more")),
        ])
        .boxed();
        let mut reader = StreamReader::new(bounded_stream(
            source,
            4,
            Instant::now() + Duration::from_secs(1),
        ));
        let mut bytes = Vec::new();
        let error = reader.read_to_end(&mut bytes).await.unwrap_err();
        assert!(error.to_string().contains("authenticated length"));

        let source: DownloadByteStream = stream::empty().boxed();
        let mut reader = StreamReader::new(bounded_stream(source, 4, Instant::now()));
        let error = reader.read_to_end(&mut Vec::new()).await.unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
    }
}
