//! Optional SteamGridDB artwork lookup with each player's own API key.
//!
//! Owner decision on #527 (2026-11-12): only a player-supplied key is used. It
//! lives in the operating-system secure store, is sent only to the fixed API
//! origin and never to image, CDN or redirect destinations, and is never read
//! back for display, logged, exported or accepted from process arguments or the
//! environment. No project key exists. Results are proposals: they never
//! establish game identity, selection or Steam destination writes on their own.

use std::{sync::OnceLock, time::Duration};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::DestinationArtworkRole;
use crate::{PortcoveError, Result};

/// The only origin that ever receives the player's key.
pub const STEAMGRIDDB_API_ORIGIN: &str = "https://www.steamgriddb.com/api/v2";
/// Image and thumbnail URLs are accepted only from this HTTPS host.
const IMAGE_HOST: &str = "cdn2.steamgriddb.com";
const CREDENTIAL_SERVICE: &str = "io.github.portcove.Portcove";
const CREDENTIAL_USER: &str = "steamgriddb.com";
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const MAX_RESULTS: usize = 50;
const MAX_SEARCH_TERM_CHARS: usize = 120;
const MAX_IMAGE_DIMENSION: u32 = 8192;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SteamGridDbKeyStatus {
    /// Whether a player key is stored; the key itself is never returned.
    pub configured: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SteamGridDbGame {
    pub id: u64,
    pub name: String,
    pub verified: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SteamGridDbAuthor {
    pub name: String,
    pub steam64: Option<String>,
}

/// A proposed static image for one role, with attribution. Not a selection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SteamGridDbCandidate {
    pub id: u64,
    pub role: DestinationArtworkRole,
    pub url: String,
    pub thumb: String,
    pub mime: String,
    pub width: u32,
    pub height: u32,
    pub style: String,
    pub score: i64,
    pub author: SteamGridDbAuthor,
}

/// Player-facing outcome classes; none of them fails ordinary game operations.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SteamGridDbFailure {
    NotConfigured,
    KeyRejected,
    NoMatch,
    RateLimited { retry_after_seconds: Option<u64> },
    Unavailable,
    InvalidResponse,
}

impl From<SteamGridDbFailure> for PortcoveError {
    fn from(failure: SteamGridDbFailure) -> Self {
        match failure {
            SteamGridDbFailure::NotConfigured => PortcoveError::usage(
                "SteamGridDB is not set up; add your own SteamGridDB API key first",
            ),
            SteamGridDbFailure::KeyRejected => {
                PortcoveError::usage("SteamGridDB rejected the saved API key; check or replace it")
            }
            SteamGridDbFailure::NoMatch => {
                PortcoveError::not_found("SteamGridDB has no match for this request")
            }
            SteamGridDbFailure::RateLimited {
                retry_after_seconds,
            } => {
                let error = PortcoveError::network("SteamGridDB asked Portcove to slow down");
                match retry_after_seconds {
                    Some(seconds) => error.detail("retry_after_seconds", seconds.to_string()),
                    None => error,
                }
            }
            SteamGridDbFailure::Unavailable => {
                PortcoveError::network("SteamGridDB could not be reached; try again later")
            }
            SteamGridDbFailure::InvalidResponse => {
                PortcoveError::verification("SteamGridDB returned an unexpected response")
            }
        }
    }
}

/// HTTP access injected so tests use fixtures. Only `get` receives the key, and
/// only for the fixed API origin; `fetch_image` has no key parameter, so the key
/// can never reach the image host.
pub(crate) trait SteamGridDbTransport {
    fn get(&self, path_and_query: &str, key: &str) -> Result<TransportResponse>;
    fn fetch_image(&self, url: &str) -> Result<TransportResponse>;
}

/// A chosen image re-resolved from the provider, with its bounded bytes.
#[derive(Debug)]
pub(crate) struct FetchedCandidate {
    pub(crate) candidate: SteamGridDbCandidate,
    pub(crate) bytes: Vec<u8>,
}

/// Re-resolves `candidate_id` from the provider's own listing (never trusting a
/// client-supplied URL or author) and fetches its image without the key.
pub(crate) fn fetch_candidate(
    transport: &impl SteamGridDbTransport,
    key: &str,
    game_id: u64,
    role: DestinationArtworkRole,
    candidate_id: u64,
) -> Result<FetchedCandidate> {
    // Only the first listing page is consulted; an image that moved off it is
    // reported as no longer listed and the current artwork is kept.
    let candidate = role_candidates(transport, key, game_id, role)?
        .into_iter()
        .find(|candidate| candidate.id == candidate_id)
        .ok_or_else(|| {
            PortcoveError::not_found(
                "SteamGridDB no longer lists this image for this game and role; list the images again",
            )
        })?;
    if !is_image_url(&candidate.url) {
        return Err(SteamGridDbFailure::InvalidResponse.into());
    }
    let response = transport.fetch_image(&candidate.url)?;
    match response.status {
        200 => {}
        404 => {
            return Err(PortcoveError::not_found(
                "SteamGridDB no longer serves this image; choose another",
            ));
        }
        429 => {
            return Err(SteamGridDbFailure::RateLimited {
                retry_after_seconds: retry_after_seconds(response.retry_after.as_deref()),
            }
            .into());
        }
        500..=599 => return Err(SteamGridDbFailure::Unavailable.into()),
        // Redirects are never followed; any other status is unexpected.
        _ => return Err(SteamGridDbFailure::InvalidResponse.into()),
    }
    if response.body.is_empty()
        || response.body.len() as u64 > crate::artwork_image::MAX_ORIGINAL_BYTES
    {
        return Err(PortcoveError::verification(
            "the SteamGridDB image is empty or exceeds the artwork size limit",
        ));
    }
    Ok(FetchedCandidate {
        candidate,
        bytes: response.body,
    })
}

/// Fetches a chosen candidate with the player's stored key.
pub(crate) fn fetch_chosen_candidate(
    game_id: u64,
    role: DestinationArtworkRole,
    candidate_id: u64,
) -> Result<FetchedCandidate> {
    with_key(|key| fetch_candidate(&HttpTransport, key, game_id, role, candidate_id))
}

fn retry_after_seconds(value: Option<&str>) -> Option<u64> {
    value
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|seconds| *seconds <= 24 * 60 * 60)
}

pub(crate) struct TransportResponse {
    pub status: u16,
    pub retry_after: Option<String>,
    pub body: Vec<u8>,
}

/// Stores the player's key; leading/trailing whitespace is removed.
pub fn set_steamgriddb_key(key: &str) -> Result<SteamGridDbKeyStatus> {
    let key = validate_key(key)?;
    credential_entry()?
        .set_password(&key)
        .map_err(|error| credential_error("write", error))?;
    Ok(SteamGridDbKeyStatus { configured: true })
}

pub fn clear_steamgriddb_key() -> Result<SteamGridDbKeyStatus> {
    match credential_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(SteamGridDbKeyStatus { configured: false }),
        Err(error) => Err(credential_error("delete", error)),
    }
}

pub fn steamgriddb_key_status() -> Result<SteamGridDbKeyStatus> {
    Ok(SteamGridDbKeyStatus {
        configured: stored_key()?.is_some(),
    })
}

/// Bounded game search; results only propose an identity for explicit choice.
pub fn search_steamgriddb_games(term: &str) -> Result<Vec<SteamGridDbGame>> {
    with_key(|key| search_games(&HttpTransport, key, term))
}

/// Static candidates for one role of an explicitly chosen SteamGridDB game.
pub fn steamgriddb_candidates(
    game_id: u64,
    role: DestinationArtworkRole,
) -> Result<Vec<SteamGridDbCandidate>> {
    with_key(|key| role_candidates(&HttpTransport, key, game_id, role))
}

fn with_key<T>(operation: impl FnOnce(&str) -> Result<T>) -> Result<T> {
    let key = stored_key()?.ok_or(SteamGridDbFailure::NotConfigured)?;
    operation(&key)
}

pub(crate) fn search_games(
    transport: &impl SteamGridDbTransport,
    key: &str,
    term: &str,
) -> Result<Vec<SteamGridDbGame>> {
    let term = term.trim();
    // A dot-only term would be a `.`/`..` path segment (even percent-encoded),
    // which URL parsing collapses into a different endpoint.
    if term.is_empty()
        || term.chars().all(|character| character == '.')
        || term.chars().count() > MAX_SEARCH_TERM_CHARS
    {
        return Err(PortcoveError::usage(format!(
            "enter a game name of 1 to {MAX_SEARCH_TERM_CHARS} characters"
        )));
    }
    #[derive(Deserialize)]
    struct Game {
        id: u64,
        name: String,
        #[serde(default)]
        verified: bool,
    }
    let path = format!("/search/autocomplete/{}", encode_segment(term));
    let games: Vec<Game> = request(transport, key, &path)?;
    Ok(games
        .into_iter()
        .filter(|game| game.id > 0 && !game.name.trim().is_empty())
        .take(MAX_RESULTS)
        .map(|game| SteamGridDbGame {
            id: game.id,
            name: game.name.trim().chars().take(200).collect(),
            verified: game.verified,
        })
        .collect())
}

pub(crate) fn role_candidates(
    transport: &impl SteamGridDbTransport,
    key: &str,
    game_id: u64,
    role: DestinationArtworkRole,
) -> Result<Vec<SteamGridDbCandidate>> {
    if game_id == 0 {
        return Err(PortcoveError::usage("choose a SteamGridDB game first"));
    }
    let (collection, dimensions) = match role {
        DestinationArtworkRole::PortraitCover => ("grids", "600x900,342x482,660x930"),
        DestinationArtworkRole::LandscapeCover => ("grids", "460x215,920x430"),
        DestinationArtworkRole::HeroBanner => ("heroes", "1920x620,3840x1240,1600x650"),
    };
    let path = format!(
        "/{collection}/game/{game_id}?dimensions={dimensions}&mimes=image/png,image/jpeg\
         &types=static&nsfw=false&humor=false&epilepsy=false&limit={MAX_RESULTS}&page=0"
    );
    #[derive(Deserialize)]
    struct Author {
        name: String,
        steam64: Option<String>,
    }
    #[derive(Deserialize)]
    struct Image {
        id: u64,
        url: String,
        thumb: String,
        mime: String,
        width: u32,
        height: u32,
        #[serde(default)]
        style: String,
        #[serde(default)]
        score: i64,
        #[serde(default)]
        nsfw: bool,
        #[serde(default)]
        humor: bool,
        #[serde(default)]
        epilepsy: bool,
        author: Author,
    }
    let images: Vec<Image> = request(transport, key, &path)?;
    Ok(images
        .into_iter()
        // Requested flag, format and host filters are rechecked; anything unexpected is
        // dropped, not trusted. Responses do not mark animation, so `types=static` relies
        // on the provider and the eventual image import must reject animated files.
        .filter(|image| {
            image.id > 0
                && !image.nsfw
                && !image.humor
                && !image.epilepsy
                && matches!(image.mime.as_str(), "image/png" | "image/jpeg")
                && (1..=MAX_IMAGE_DIMENSION).contains(&image.width)
                && (1..=MAX_IMAGE_DIMENSION).contains(&image.height)
                && is_image_url(&image.url)
                && is_image_url(&image.thumb)
        })
        .take(MAX_RESULTS)
        .map(|image| SteamGridDbCandidate {
            id: image.id,
            role,
            url: image.url,
            thumb: image.thumb,
            mime: image.mime,
            width: image.width,
            height: image.height,
            style: image.style.chars().take(40).collect(),
            score: image.score,
            author: SteamGridDbAuthor {
                name: author_name(&image.author.name),
                steam64: image.author.steam64.filter(|id| {
                    !id.is_empty() && id.len() <= 20 && id.bytes().all(|b| b.is_ascii_digit())
                }),
            },
        })
        .collect())
}

fn request<T: for<'de> Deserialize<'de>>(
    transport: &impl SteamGridDbTransport,
    key: &str,
    path_and_query: &str,
) -> Result<Vec<T>> {
    let response = transport.get(path_and_query, key)?;
    match response.status {
        200 => {}
        401 | 403 => return Err(SteamGridDbFailure::KeyRejected.into()),
        404 => return Err(SteamGridDbFailure::NoMatch.into()),
        429 => {
            return Err(SteamGridDbFailure::RateLimited {
                retry_after_seconds: retry_after_seconds(response.retry_after.as_deref()),
            }
            .into());
        }
        500..=599 => return Err(SteamGridDbFailure::Unavailable.into()),
        _ => return Err(SteamGridDbFailure::InvalidResponse.into()),
    }
    if response.body.len() > MAX_RESPONSE_BYTES {
        return Err(SteamGridDbFailure::InvalidResponse.into());
    }
    #[derive(Deserialize)]
    struct Envelope<T> {
        success: bool,
        #[serde(default = "Vec::new")]
        data: Vec<T>,
    }
    let envelope: Envelope<serde_json::Value> = serde_json::from_slice(&response.body)
        .map_err(|_| PortcoveError::from(SteamGridDbFailure::InvalidResponse))?;
    if !envelope.success {
        return Err(SteamGridDbFailure::InvalidResponse.into());
    }
    // Entries that do not match the expected shape are skipped individually.
    Ok(envelope
        .data
        .into_iter()
        .take(MAX_RESULTS * 2)
        .filter_map(|value| serde_json::from_value(value).ok())
        .collect())
}

/// Attribution text shown to players and stored with provenance: no control
/// characters, trimmed, bounded, and never empty.
pub(crate) fn author_name(value: &str) -> String {
    let name = value
        .chars()
        .filter(|character| !character.is_control())
        .take(100)
        .collect::<String>()
        .trim()
        .to_owned();
    if name.is_empty() {
        UNKNOWN_AUTHOR.into()
    } else {
        name
    }
}

pub(crate) const UNKNOWN_AUTHOR: &str = "Unnamed SteamGridDB artist";

pub(crate) fn is_image_url(value: &str) -> bool {
    match reqwest::Url::parse(value) {
        Ok(url) => {
            url.scheme() == "https"
                && url.host_str() == Some(IMAGE_HOST)
                && url.port().is_none()
                && url.username().is_empty()
                && url.password().is_none()
                && value.len() <= 2048
        }
        Err(_) => false,
    }
}

fn encode_segment(value: &str) -> String {
    // Percent-encode everything outside RFC 3986's unreserved set.
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                (byte as char).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

fn validate_key(key: &str) -> Result<String> {
    let key = key.trim();
    if key.len() < 16 || key.len() > 128 || !key.bytes().all(|byte| byte.is_ascii_alphanumeric()) {
        return Err(PortcoveError::usage(
            "a SteamGridDB API key is 16 to 128 letters and digits; copy it from your SteamGridDB preferences",
        ));
    }
    Ok(key.to_owned())
}

fn stored_key() -> Result<Option<String>> {
    match credential_entry()?.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(credential_error("read", error)),
    }
}

fn credential_entry() -> Result<keyring::Entry> {
    keyring::Entry::new(CREDENTIAL_SERVICE, CREDENTIAL_USER)
        .map_err(|error| credential_error("open", error))
}

fn credential_error(action: &str, error: keyring::Error) -> PortcoveError {
    crate::credential_store::store_error("SteamGridDB key", action, error)
}

struct HttpTransport;

impl SteamGridDbTransport for HttpTransport {
    fn get(&self, path_and_query: &str, key: &str) -> Result<TransportResponse> {
        let response = http_client()?
            .get(format!("{STEAMGRIDDB_API_ORIGIN}{path_and_query}"))
            .bearer_auth(key)
            .send()
            .map_err(|_| PortcoveError::from(SteamGridDbFailure::Unavailable))?;
        let status = response.status().as_u16();
        let retry_after = response
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let mut body = Vec::new();
        use std::io::Read;
        response
            .take(MAX_RESPONSE_BYTES as u64 + 1)
            .read_to_end(&mut body)
            .map_err(|_| PortcoveError::from(SteamGridDbFailure::Unavailable))?;
        Ok(TransportResponse {
            status,
            retry_after,
            body,
        })
    }

    fn fetch_image(&self, url: &str) -> Result<TransportResponse> {
        self.fetch(url)
    }
}

impl HttpTransport {
    fn fetch(&self, url: &str) -> Result<TransportResponse> {
        if !is_image_url(url) {
            return Err(SteamGridDbFailure::InvalidResponse.into());
        }
        // No `bearer_auth`: the image host never receives the player's key.
        let response = http_client()?
            .get(url)
            .timeout(Duration::from_secs(60))
            .send()
            .map_err(|_| PortcoveError::from(SteamGridDbFailure::Unavailable))?;
        let status = response.status().as_u16();
        let retry_after = response
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let mut body = Vec::new();
        use std::io::Read;
        // The cap is enforced while reading; one extra byte detects overflow.
        response
            .take(crate::artwork_image::MAX_ORIGINAL_BYTES + 1)
            .read_to_end(&mut body)
            .map_err(|_| PortcoveError::from(SteamGridDbFailure::Unavailable))?;
        Ok(TransportResponse {
            status,
            retry_after,
            body,
        })
    }
}

fn http_client() -> Result<&'static reqwest::blocking::Client> {
    static CLIENT: OnceLock<std::result::Result<reqwest::blocking::Client, String>> =
        OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::blocking::Client::builder()
                // Never follow redirects: the key must not leave the fixed origin.
                .redirect(reqwest::redirect::Policy::none())
                .user_agent(concat!("Portcove/", env!("CARGO_PKG_VERSION")))
                .connect_timeout(Duration::from_secs(5))
                .timeout(Duration::from_secs(15))
                .build()
                .map_err(|error| error.to_string())
        })
        .as_ref()
        .map_err(|error| PortcoveError::network(format!("SteamGridDB client unavailable: {error}")))
}

#[cfg(test)]
#[path = "steamgriddb_tests.rs"]
mod tests;
