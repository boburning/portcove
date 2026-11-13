//! Report-only check of whether SteamGridDB still lists the images stored in
//! the library (#527 withdrawal design, revision 2).
//!
//! Absence is never inferred from the picker's lossy listing. The check lists
//! each group by facts that cannot change for a stored image (game, collection,
//! stored dimensions and format, static) with every content flag set to `any`,
//! matches on raw image IDs only, and accepts a listing as exhaustive only when
//! every page echoes the request, `total` is stable, and the unique IDs seen
//! equal `total`. Anything else is unknown. The check changes nothing.

use std::collections::{BTreeMap, HashSet};

use super::*;
use crate::{ArtworkAttribution, ArtworkImageFormat, ArtworkMetadata};

const CHECK_PAGE_LIMIT: u64 = 50;
const MAX_CHECK_PAGES: u64 = 20;
/// Total provider requests one check may make, across every group.
const MAX_CHECK_API_REQUESTS: u32 = 120;
/// Total image-host requests one check may make.
const MAX_CHECK_SOURCE_PROBES: u32 = 60;
/// Spacing between consecutive requests of one check.
const CHECK_PACE: Duration = Duration::from_millis(250);

/// Whether SteamGridDB's own listing still includes a stored image.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SteamGridDbListingStatus {
    /// The image is in a complete, verified listing.
    Listed,
    /// A complete, verified listing does not include the image.
    NotListed,
    /// No complete listing could be verified; see `unknown_reason`.
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SteamGridDbUnknownReason {
    /// Pages disagreed, an entry had no readable ID, or the IDs seen did not match `total`.
    IncompleteListing,
    /// The listing is longer than one check reads.
    TooManyImages,
    /// SteamGridDB answered that the game was not found; not treated as a withdrawal.
    GameNotFound,
    /// The check's request budget ran out before this listing.
    RequestLimit,
    /// The check stopped early; see `stopped`.
    CheckStopped,
    /// SteamGridDB could not be reached or answered with a server error.
    Unavailable,
    /// SteamGridDB's answer did not have the expected listing shape.
    InvalidResponse,
}

/// What SteamGridDB's image server answered for the stored source URL, without the key.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SteamGridDbSourceStatus {
    /// Not asked, because the image is listed or the check stopped.
    NotChecked,
    /// The image server still returns the file.
    Served,
    /// The image server answered 404 or 410.
    Gone,
    /// The probe failed, was refused, or exceeded the check's budget.
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SteamGridDbImageCheck {
    pub asset_sha256: String,
    pub attribution: ArtworkAttribution,
    pub listing: SteamGridDbListingStatus,
    pub unknown_reason: Option<SteamGridDbUnknownReason>,
    pub source: SteamGridDbSourceStatus,
}

/// Why a check ended before every group was read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "reason", rename_all = "snake_case", deny_unknown_fields)]
pub enum SteamGridDbCheckStop {
    /// SteamGridDB asked Portcove to slow down.
    RateLimited { retry_after_seconds: Option<u64> },
    /// SteamGridDB rejected the player's saved key.
    KeyRejected,
}

/// Report only: nothing in the library, its files or Steam changes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SteamGridDbListingReport {
    pub checked_at: i64,
    pub images: Vec<SteamGridDbImageCheck>,
    pub stopped: Option<SteamGridDbCheckStop>,
}

/// One stored provider record and the decoded facts of its image.
pub(crate) struct CheckSubject {
    pub(crate) asset_sha256: String,
    pub(crate) attribution: ArtworkAttribution,
    pub(crate) image: Option<(u32, u32, ArtworkImageFormat)>,
}

pub(crate) fn check_subjects(metadata: &ArtworkMetadata) -> Vec<CheckSubject> {
    metadata
        .providers
        .iter()
        .map(|record| CheckSubject {
            asset_sha256: record.asset_sha256.clone(),
            attribution: record.attribution.clone(),
            image: metadata
                .assets
                .iter()
                .find(|asset| asset.sha256 == record.asset_sha256)
                .map(|asset| (asset.width, asset.height, asset.format)),
        })
        .collect()
}

/// Checks the stored records with the player's key. No key is needed, and no
/// request is made, when nothing is stored.
pub(crate) fn check_stored_listings(
    subjects: Vec<CheckSubject>,
    now: i64,
) -> Result<SteamGridDbListingReport> {
    if subjects.is_empty() {
        return Ok(SteamGridDbListingReport {
            checked_at: now,
            images: Vec::new(),
            stopped: None,
        });
    }
    with_key(|key| {
        Ok(check_listings(
            &HttpTransport,
            key,
            subjects,
            CHECK_PACE,
            now,
        ))
    })
}

#[derive(Debug, PartialEq, Eq, PartialOrd, Ord)]
struct ListingQuery {
    game_id: u64,
    collection: &'static str,
    dimensions: Option<String>,
    mime: Option<&'static str>,
}

impl ListingQuery {
    fn for_subject(subject: &CheckSubject) -> Self {
        let (collection, accepted) = role_listing(subject.attribution.role);
        let (dimensions, mime) = match subject.image {
            Some((width, height, format)) => {
                let size = format!("{width}x{height}");
                // Only a size the provider documents for this role narrows the
                // listing; any other stored size lists the whole collection.
                let dimensions = accepted
                    .split(',')
                    .any(|value| value == size)
                    .then_some(size);
                let mime = match format {
                    ArtworkImageFormat::Png => "image/png",
                    ArtworkImageFormat::Jpeg => "image/jpeg",
                };
                (dimensions, Some(mime))
            }
            None => (None, None),
        };
        Self {
            game_id: subject.attribution.game_id,
            collection,
            dimensions,
            mime,
        }
    }

    fn path(&self, page: u64) -> String {
        let mut path = format!("/{}/game/{}?", self.collection, self.game_id);
        if let Some(dimensions) = &self.dimensions {
            path.push_str(&format!("dimensions={dimensions}&"));
        }
        if let Some(mime) = self.mime {
            path.push_str(&format!("mimes={mime}&"));
        }
        path.push_str(&format!(
            "types=static&nsfw=any&humor=any&epilepsy=any&limit={CHECK_PAGE_LIMIT}&page={page}"
        ));
        path
    }
}

struct Budget {
    api: u32,
    source: u32,
    pace: Duration,
    started: bool,
}

impl Budget {
    fn take(&mut self, api: bool) -> bool {
        let remaining = if api { &mut self.api } else { &mut self.source };
        if *remaining == 0 {
            return false;
        }
        *remaining -= 1;
        if self.started && !self.pace.is_zero() {
            std::thread::sleep(self.pace);
        }
        self.started = true;
        true
    }
}

enum GroupListing {
    Ids(HashSet<u64>),
    Unknown(SteamGridDbUnknownReason),
}

pub(crate) fn check_listings(
    transport: &impl SteamGridDbTransport,
    key: &str,
    subjects: Vec<CheckSubject>,
    pace: Duration,
    now: i64,
) -> SteamGridDbListingReport {
    let mut budget = Budget {
        api: MAX_CHECK_API_REQUESTS,
        source: MAX_CHECK_SOURCE_PROBES,
        pace,
        started: false,
    };
    let mut groups: BTreeMap<ListingQuery, Vec<usize>> = BTreeMap::new();
    for (index, subject) in subjects.iter().enumerate() {
        groups
            .entry(ListingQuery::for_subject(subject))
            .or_default()
            .push(index);
    }
    let mut listings = vec![
        (
            SteamGridDbListingStatus::Unknown,
            Some(SteamGridDbUnknownReason::CheckStopped)
        );
        subjects.len()
    ];
    let mut stopped = None;
    for (query, members) in &groups {
        let listing = match verified_listing(transport, key, query, &mut budget) {
            Ok(listing) => listing,
            Err(stop) => {
                stopped = Some(stop);
                break;
            }
        };
        for &index in members {
            listings[index] = match &listing {
                GroupListing::Ids(ids) if ids.contains(&subjects[index].attribution.asset_id) => {
                    (SteamGridDbListingStatus::Listed, None)
                }
                GroupListing::Ids(_) => (SteamGridDbListingStatus::NotListed, None),
                GroupListing::Unknown(reason) => (SteamGridDbListingStatus::Unknown, Some(*reason)),
            };
        }
    }
    let mut sources = vec![SteamGridDbSourceStatus::NotChecked; subjects.len()];
    for (index, subject) in subjects.iter().enumerate() {
        if stopped.is_some() {
            break;
        }
        let probe = matches!(
            listings[index],
            (SteamGridDbListingStatus::NotListed, _)
                | (
                    SteamGridDbListingStatus::Unknown,
                    Some(SteamGridDbUnknownReason::GameNotFound)
                )
        );
        if probe {
            sources[index] =
                match probe_source(transport, &subject.attribution.source_url, &mut budget) {
                    Ok(status) => status,
                    Err(stop) => {
                        stopped = Some(stop);
                        SteamGridDbSourceStatus::Unknown
                    }
                };
        }
    }
    SteamGridDbListingReport {
        checked_at: now,
        images: subjects
            .into_iter()
            .zip(listings.into_iter().zip(sources))
            .map(
                |(subject, ((listing, unknown_reason), source))| SteamGridDbImageCheck {
                    asset_sha256: subject.asset_sha256,
                    attribution: subject.attribution,
                    listing,
                    unknown_reason,
                    source,
                },
            )
            .collect(),
        stopped,
    }
}

fn verified_listing(
    transport: &impl SteamGridDbTransport,
    key: &str,
    query: &ListingQuery,
    budget: &mut Budget,
) -> std::result::Result<GroupListing, SteamGridDbCheckStop> {
    use SteamGridDbUnknownReason as Reason;
    let mut ids = Vec::new();
    let mut total = None;
    for page in 0..MAX_CHECK_PAGES {
        if !budget.take(true) {
            return Ok(GroupListing::Unknown(Reason::RequestLimit));
        }
        let Ok(response) = transport.get(&query.path(page), key) else {
            return Ok(GroupListing::Unknown(Reason::Unavailable));
        };
        match response.status {
            200 => {}
            401 | 403 => return Err(SteamGridDbCheckStop::KeyRejected),
            404 => return Ok(GroupListing::Unknown(Reason::GameNotFound)),
            429 => {
                return Err(SteamGridDbCheckStop::RateLimited {
                    retry_after_seconds: retry_after_seconds(response.retry_after.as_deref()),
                });
            }
            500..=599 => return Ok(GroupListing::Unknown(Reason::Unavailable)),
            _ => return Ok(GroupListing::Unknown(Reason::InvalidResponse)),
        }
        let Some(listed) = parse_page(&response.body, page) else {
            return Ok(GroupListing::Unknown(Reason::InvalidResponse));
        };
        let expected = *total.get_or_insert(listed.total);
        if expected != listed.total {
            return Ok(GroupListing::Unknown(Reason::IncompleteListing));
        }
        if expected > MAX_CHECK_PAGES * CHECK_PAGE_LIMIT {
            return Ok(GroupListing::Unknown(Reason::TooManyImages));
        }
        let Some(page_ids) = listed.ids else {
            return Ok(GroupListing::Unknown(Reason::IncompleteListing));
        };
        let empty = page_ids.is_empty();
        ids.extend(page_ids);
        if empty || ids.len() as u64 >= expected {
            break;
        }
    }
    let unique: HashSet<u64> = ids.iter().copied().collect();
    if Some(ids.len() as u64) != total || unique.len() != ids.len() {
        return Ok(GroupListing::Unknown(Reason::IncompleteListing));
    }
    Ok(GroupListing::Ids(unique))
}

struct ListedPage {
    total: u64,
    /// `None` when any entry lacks a readable positive ID.
    ids: Option<Vec<u64>>,
}

/// Accepts only a page that echoes the request and carries `data` and `total`.
fn parse_page(body: &[u8], page: u64) -> Option<ListedPage> {
    if body.len() > MAX_RESPONSE_BYTES {
        return None;
    }
    let value: serde_json::Value = serde_json::from_slice(body).ok()?;
    if !value.get("success")?.as_bool()?
        || value.get("page")?.as_u64()? != page
        || value.get("limit")?.as_u64()? != CHECK_PAGE_LIMIT
    {
        return None;
    }
    let total = value.get("total")?.as_u64()?;
    let data = value.get("data")?.as_array()?;
    if data.len() as u64 > CHECK_PAGE_LIMIT {
        return None;
    }
    let ids = data
        .iter()
        .map(|entry| {
            entry
                .get("id")
                .and_then(serde_json::Value::as_u64)
                .filter(|id| *id > 0)
        })
        .collect();
    Some(ListedPage { total, ids })
}

fn probe_source(
    transport: &impl SteamGridDbTransport,
    url: &str,
    budget: &mut Budget,
) -> std::result::Result<SteamGridDbSourceStatus, SteamGridDbCheckStop> {
    if !is_image_url(url) || !budget.take(false) {
        return Ok(SteamGridDbSourceStatus::Unknown);
    }
    // Only the status matters; at most two bytes are read.
    let Ok(response) = transport.fetch_image(url, 1) else {
        return Ok(SteamGridDbSourceStatus::Unknown);
    };
    Ok(match response.status {
        200 => SteamGridDbSourceStatus::Served,
        404 | 410 => SteamGridDbSourceStatus::Gone,
        429 => {
            return Err(SteamGridDbCheckStop::RateLimited {
                retry_after_seconds: retry_after_seconds(response.retry_after.as_deref()),
            });
        }
        _ => SteamGridDbSourceStatus::Unknown,
    })
}

#[cfg(test)]
#[path = "steamgriddb_check_tests.rs"]
mod tests;
