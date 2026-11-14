//! Check of whether SteamGridDB still lists the images stored in the library
//! (#527 withdrawal design; slice 2a revision 2). This module only observes and
//! classifies; recording the results is the caller's job.
//!
//! Absence is never inferred from the picker's lossy listing. The check lists
//! each group by facts that cannot change for a stored image (game, collection,
//! stored dimensions and format, static) with every content flag set to `any`,
//! matches on raw image IDs only, and accepts a listing as exhaustive only when
//! every page echoes the request, `total` is stable, and the unique IDs seen
//! equal `total`. An ID seen on any page that passed those envelope checks is
//! evidence that the image is listed, even when the listing as a whole is not
//! verified. Anything else is unknown.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::time::Instant;

use super::*;
use crate::{ArtworkAttribution, ArtworkImageFormat, ArtworkMetadata, ArtworkProvider};

const CHECK_PAGE_LIMIT: u64 = 50;
const MAX_CHECK_PAGES: u64 = 20;
/// Total provider requests one check may make, across every group.
const MAX_CHECK_API_REQUESTS: u32 = 120;
/// Total image-host requests one check may make.
const MAX_CHECK_SOURCE_PROBES: u32 = 60;
/// Spacing between consecutive requests of one check.
const CHECK_PACE: Duration = Duration::from_millis(250);
/// Wall-clock bound for one check; at most one request in flight can run past it.
pub(crate) const CHECK_TIME_LIMIT: Duration = Duration::from_secs(180);
/// Consecutive unreachable listings after which a check stops instead of
/// spending its budget against an outage.
const MAX_CONSECUTIVE_UNAVAILABLE: u32 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SteamGridDbUnknownReason {
    /// Pages disagreed, an entry had no readable ID, or the IDs seen did not match `total`.
    IncompleteListing,
    /// The listing is longer than one check reads.
    TooManyImages,
    /// SteamGridDB answered that the game was not found; not treated as a withdrawal.
    GameNotFound,
    /// SteamGridDB listed no images at all for the game and role, so absence proves nothing.
    EmptyListing,
    /// The check's request budget ran out before this listing was complete.
    RequestLimit,
    /// The check stopped before reaching this image; see `stopped`.
    CheckStopped,
    /// SteamGridDB could not be reached or answered with a server error.
    Unavailable,
    /// SteamGridDB's answer did not have the expected listing shape.
    InvalidResponse,
}

/// Whether SteamGridDB's own listing still includes a stored image.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
pub enum SteamGridDbListingResult {
    /// The image was seen on a listing page that passed the envelope checks.
    Listed,
    /// A complete, verified, non-empty listing does not include the image.
    NotListed,
    /// Neither could be established.
    Unknown { reason: SteamGridDbUnknownReason },
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
    pub listing: SteamGridDbListingResult,
    /// Whether this run requested the image's listing and reached a conclusion
    /// other than running out of budget; images not reached are `false`.
    pub attempted: bool,
    /// The `total` SteamGridDB reported for the image's listing, when one was read.
    pub listing_total: Option<u64>,
    pub source: SteamGridDbSourceStatus,
    /// When a verified listing first lacked this image, as recorded in the
    /// library after this check; cleared only by a later observed listing.
    pub not_listed_since: Option<i64>,
    /// What recording this result changed; `none` when the check was not recorded.
    pub effect: SteamGridDbCheckEffect,
}

/// What recording one image's result changed in the library.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SteamGridDbCheckEffect {
    /// Nothing beyond the recorded evidence.
    #[default]
    None,
    /// The image is now confirmed withdrawn: a second signal followed an
    /// earlier absence. The stored copy is kept, because another credit or the
    /// player's own import still stands behind it.
    Withdrawn,
    /// The image is confirmed withdrawn and Portcove removed its copy. The
    /// choice and the credit are kept.
    Removed,
    /// The image was confirmed withdrawn before and is now listed again; a
    /// removed copy comes back only when the player chooses it again.
    ListedAgain,
}

/// Why a check ended before every group was read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "reason", rename_all = "snake_case", deny_unknown_fields)]
pub enum SteamGridDbCheckStop {
    /// SteamGridDB asked Portcove to slow down.
    RateLimited { retry_after_seconds: Option<u64> },
    /// SteamGridDB rejected the player's saved key.
    KeyRejected,
    /// SteamGridDB was unreachable for consecutive listings.
    Unavailable,
    /// The check reached its three-minute limit.
    TimeLimit,
    /// The check was cancelled, for example because the library changed.
    Cancelled,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SteamGridDbListingReport {
    pub checked_at: i64,
    pub images: Vec<SteamGridDbImageCheck>,
    pub stopped: Option<SteamGridDbCheckStop>,
    /// Whether these results were recorded in the library. A cancelled check, or
    /// one whose recording failed, still reports what it saw.
    pub recorded: bool,
    /// Attempted results that could not be written and stay unrecorded; they are
    /// checked again first next time.
    pub skipped: u32,
    /// Copies of withdrawn images removed from the library during this check,
    /// including removals left over from earlier checks.
    pub removed: u32,
    /// Removals left for the next check, export or move because one check
    /// removes a bounded number while it holds the library.
    pub removal_deferred: u32,
    /// Removals that failed, usually because another program holds the file.
    /// Portcove no longer shows or hands out these copies.
    pub removal_failed: u32,
}

/// One stored provider record and the decoded facts of its image.
pub(crate) struct CheckSubject {
    pub(crate) asset_sha256: String,
    pub(crate) attribution: ArtworkAttribution,
    pub(crate) image: Option<(u32, u32, ArtworkImageFormat)>,
    /// When a check last attempted this record's listing; never-checked first.
    pub(crate) last_checked_at: Option<i64>,
}

/// SteamGridDB records with the facts of their stored images.
pub(crate) fn check_subjects(
    metadata: &ArtworkMetadata,
    last_checked_at: impl Fn(&str, u64) -> Option<i64>,
) -> Vec<CheckSubject> {
    metadata
        .providers
        .iter()
        .filter(|record| record.attribution.provider == ArtworkProvider::Steamgriddb)
        .map(|record| CheckSubject {
            asset_sha256: record.asset_sha256.clone(),
            attribution: record.attribution.clone(),
            image: metadata
                .assets
                .iter()
                .find(|asset| asset.sha256 == record.asset_sha256)
                .map(|asset| (asset.width, asset.height, asset.format)),
            last_checked_at: last_checked_at(&record.asset_sha256, record.attribution.asset_id),
        })
        .collect()
}

/// Runtime bounds of one check.
pub(crate) struct CheckControl<'a> {
    pub(crate) pace: Duration,
    pub(crate) deadline: Option<Instant>,
    pub(crate) cancelled: &'a dyn Fn() -> bool,
}

/// Checks the stored records with the player's key. No key is needed, and no
/// request is made, when nothing is stored.
pub(crate) fn check_stored_listings(
    subjects: Vec<CheckSubject>,
    now: i64,
    cancelled: &dyn Fn() -> bool,
) -> Result<ListingRun> {
    if subjects.is_empty() {
        return Ok(SteamGridDbListingReport {
            checked_at: now,
            images: Vec::new(),
            stopped: None,
            recorded: true,
            ..SteamGridDbListingReport::default()
        }
        .into());
    }
    with_key(|key| {
        Ok(check_listings_dated(
            &HttpTransport,
            key,
            subjects,
            CheckControl {
                pace: CHECK_PACE,
                deadline: Some(Instant::now() + CHECK_TIME_LIMIT),
                cancelled,
            },
            now,
        ))
    })
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
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

    fn narrowed(&self) -> bool {
        self.dimensions.is_some() || self.mime.is_some()
    }

    /// The same game and collection without the size and format filters.
    fn unfiltered(&self) -> Self {
        Self {
            game_id: self.game_id,
            collection: self.collection,
            dimensions: None,
            mime: None,
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

enum Take {
    Granted,
    Exhausted,
    Stop(SteamGridDbCheckStop),
}

struct Budget<'a> {
    api: u32,
    source: u32,
    control: CheckControl<'a>,
    started: bool,
}

impl Budget<'_> {
    /// Every request passes through here, so cancellation and the deadline are
    /// honoured before each one.
    fn take(&mut self, api: bool) -> Take {
        if (self.control.cancelled)() {
            return Take::Stop(SteamGridDbCheckStop::Cancelled);
        }
        if self
            .control
            .deadline
            .is_some_and(|deadline| Instant::now() >= deadline)
        {
            return Take::Stop(SteamGridDbCheckStop::TimeLimit);
        }
        let remaining = if api { &mut self.api } else { &mut self.source };
        if *remaining == 0 {
            return Take::Exhausted;
        }
        *remaining -= 1;
        if self.started && !self.control.pace.is_zero() {
            std::thread::sleep(self.control.pace);
        }
        self.started = true;
        Take::Granted
    }
}

/// SteamGridDB's own `Date` across the responses one image's listing was read
/// from. The withdrawal rule compares it with the stored first absence, so a
/// local clock running ahead cannot shorten the 24-hour wait.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ServerDates {
    pub(crate) earliest: i64,
    pub(crate) latest: i64,
}

impl ServerDates {
    fn merge(left: Option<Self>, right: Option<Self>) -> Option<Self> {
        match (left, right) {
            (Some(left), Some(right)) => Some(Self {
                earliest: left.earliest.min(right.earliest),
                latest: left.latest.max(right.latest),
            }),
            (left, right) => left.or(right),
        }
    }
}

/// A check's report with the per-image server dates the recording step needs.
/// The dates are internal: they never appear in the report a host shows.
pub(crate) struct ListingRun {
    pub(crate) report: SteamGridDbListingReport,
    /// One entry per image, in report order.
    pub(crate) server_dates: Vec<Option<ServerDates>>,
}

impl From<SteamGridDbListingReport> for ListingRun {
    fn from(report: SteamGridDbListingReport) -> Self {
        let server_dates = vec![None; report.images.len()];
        Self {
            report,
            server_dates,
        }
    }
}

/// One group's listing as far as this run got.
struct GroupListing {
    /// Every ID of a complete, verified listing, or why there is none.
    outcome: std::result::Result<HashSet<u64>, SteamGridDbUnknownReason>,
    /// IDs seen on pages that passed the envelope checks.
    observed: HashSet<u64>,
    total: Option<u64>,
    /// SteamGridDB's `Date` on the answered pages, when it sent a readable one.
    dates: Option<ServerDates>,
    /// Whether at least one request was issued for this listing.
    requested: bool,
    stop: Option<SteamGridDbCheckStop>,
}

impl GroupListing {
    /// Attempted unless the budget ran out first; a group that triggered a stop
    /// or answered unavailable counts, so rotation moves past it.
    fn attempted(&self) -> bool {
        self.requested && self.outcome != Err(SteamGridDbUnknownReason::RequestLimit)
    }
}

#[cfg(test)]
pub(crate) fn check_listings(
    transport: &impl SteamGridDbTransport,
    key: &str,
    subjects: Vec<CheckSubject>,
    control: CheckControl<'_>,
    now: i64,
) -> SteamGridDbListingReport {
    check_listings_dated(transport, key, subjects, control, now).report
}

pub(crate) fn check_listings_dated(
    transport: &impl SteamGridDbTransport,
    key: &str,
    subjects: Vec<CheckSubject>,
    control: CheckControl<'_>,
    now: i64,
) -> ListingRun {
    use SteamGridDbListingResult as Result_;
    use SteamGridDbUnknownReason as Reason;
    let mut budget = Budget {
        api: MAX_CHECK_API_REQUESTS,
        source: MAX_CHECK_SOURCE_PROBES,
        control,
        started: false,
    };
    let mut groups: BTreeMap<ListingQuery, Vec<usize>> = BTreeMap::new();
    for (index, subject) in subjects.iter().enumerate() {
        groups
            .entry(ListingQuery::for_subject(subject))
            .or_default()
            .push(index);
    }
    // Stalest group first (never-checked before any checked), then query order,
    // so a bounded run covers what earlier runs did not reach.
    let mut ordered: Vec<(&ListingQuery, &Vec<usize>)> = groups.iter().collect();
    // `None` sorts before any time, so a group with a never-checked member leads.
    ordered.sort_by_key(|(query, members)| {
        (
            members
                .iter()
                .map(|&index| subjects[index].last_checked_at)
                .min()
                .flatten(),
            (*query).clone(),
        )
    });
    let mut listings = vec![
        Result_::Unknown {
            reason: Reason::CheckStopped
        };
        subjects.len()
    ];
    let mut attempted = vec![false; subjects.len()];
    let mut totals = vec![None; subjects.len()];
    let mut dates = vec![None; subjects.len()];
    let mut corroborations: HashMap<ListingQuery, GroupListing> = HashMap::new();
    let mut stopped = None;
    let mut unavailable = 0;
    for (query, members) in &ordered {
        let listing = verified_listing(transport, key, query, &mut budget);
        // A narrowed listing with no images at all proves nothing on its own:
        // the stored image may be the only one of its size and format.
        let empty_narrowed =
            matches!(&listing.outcome, Ok(ids) if ids.is_empty()) && query.narrowed();
        if empty_narrowed && listing.stop.is_none() {
            let unfiltered = query.unfiltered();
            if !corroborations.contains_key(&unfiltered) {
                let corroboration = verified_listing(transport, key, &unfiltered, &mut budget);
                corroborations.insert(unfiltered.clone(), corroboration);
            }
        }
        let corroboration = empty_narrowed
            .then(|| corroborations.get(&query.unfiltered()))
            .flatten();
        // A corroboration the budget cut off concluded nothing for this run.
        let corroboration_cut_off =
            corroboration.is_some_and(|other| other.outcome == Err(Reason::RequestLimit));
        for &index in members.iter() {
            let asset_id = subjects[index].attribution.asset_id;
            attempted[index] = listing.attempted() && !corroboration_cut_off;
            totals[index] = listing.total;
            dates[index] =
                ServerDates::merge(listing.dates, corroboration.and_then(|other| other.dates));
            let observed = listing.observed.contains(&asset_id)
                || corroboration.is_some_and(|other| other.observed.contains(&asset_id));
            listings[index] = if observed {
                Result_::Listed
            } else {
                match &listing.outcome {
                    Ok(ids) if !ids.is_empty() => Result_::NotListed,
                    Ok(_) => match corroboration.map(|other| &other.outcome) {
                        Some(Ok(ids)) if !ids.is_empty() => Result_::NotListed,
                        Some(Ok(_)) | None => Result_::Unknown {
                            reason: Reason::EmptyListing,
                        },
                        Some(Err(reason)) => Result_::Unknown { reason: *reason },
                    },
                    Err(reason) => Result_::Unknown { reason: *reason },
                }
            };
        }
        if let Some(stop) = listing
            .stop
            .clone()
            .or_else(|| corroboration.and_then(|other| other.stop.clone()))
        {
            stopped = Some(stop);
            break;
        }
        if listing.outcome == Err(Reason::Unavailable) {
            unavailable += 1;
        } else {
            unavailable = 0;
        }
        if unavailable >= MAX_CONSECUTIVE_UNAVAILABLE {
            stopped = Some(SteamGridDbCheckStop::Unavailable);
            break;
        }
    }
    let mut sources = vec![SteamGridDbSourceStatus::NotChecked; subjects.len()];
    // A probe can confirm a withdrawal only beside a verified absence in the same
    // report, so absences are probed first, stalest first; the rest only inform.
    let mut probes: Vec<usize> = ordered
        .iter()
        .flat_map(|(_, members)| members.iter().copied())
        .filter(|&index| {
            matches!(
                listings[index],
                Result_::NotListed
                    | Result_::Unknown {
                        reason: Reason::GameNotFound | Reason::EmptyListing
                    }
            )
        })
        .collect();
    probes.sort_by_key(|&index| {
        (
            listings[index] != Result_::NotListed,
            subjects[index].last_checked_at,
        )
    });
    for index in probes {
        if stopped.is_some() {
            break;
        }
        let (status, stop) = probe_source(
            transport,
            &subjects[index].attribution.source_url,
            &mut budget,
        );
        sources[index] = status;
        stopped = stop;
    }
    let report = SteamGridDbListingReport {
        checked_at: now,
        images: subjects
            .into_iter()
            .enumerate()
            .map(|(index, subject)| SteamGridDbImageCheck {
                asset_sha256: subject.asset_sha256,
                attribution: subject.attribution,
                listing: listings[index],
                attempted: attempted[index],
                listing_total: totals[index],
                source: sources[index],
                not_listed_since: None,
                effect: SteamGridDbCheckEffect::None,
            })
            .collect(),
        stopped,
        recorded: false,
        ..SteamGridDbListingReport::default()
    };
    ListingRun {
        report,
        server_dates: dates,
    }
}

fn verified_listing(
    transport: &impl SteamGridDbTransport,
    key: &str,
    query: &ListingQuery,
    budget: &mut Budget<'_>,
) -> GroupListing {
    use SteamGridDbUnknownReason as Reason;
    let mut listing = GroupListing {
        outcome: Err(Reason::IncompleteListing),
        observed: HashSet::new(),
        total: None,
        dates: None,
        requested: false,
        stop: None,
    };
    let unknown = |mut listing: GroupListing, reason| {
        listing.outcome = Err(reason);
        listing
    };
    let stopped = |mut listing: GroupListing, stop| {
        listing.outcome = Err(Reason::CheckStopped);
        listing.stop = Some(stop);
        listing
    };
    let mut ids = Vec::new();
    for page in 0..MAX_CHECK_PAGES {
        match budget.take(true) {
            Take::Granted => {}
            Take::Exhausted => return unknown(listing, Reason::RequestLimit),
            Take::Stop(stop) => return stopped(listing, stop),
        }
        listing.requested = true;
        let Ok(response) = transport.get(&query.path(page), key) else {
            return unknown(listing, Reason::Unavailable);
        };
        match response.status {
            200 => {}
            401 | 403 => return stopped(listing, SteamGridDbCheckStop::KeyRejected),
            // Only a first-page 404 says anything about the game; a later one
            // means the listing changed under the check.
            404 if page == 0 => return unknown(listing, Reason::GameNotFound),
            404 => return unknown(listing, Reason::IncompleteListing),
            429 => {
                let stop = SteamGridDbCheckStop::RateLimited {
                    retry_after_seconds: retry_after_seconds(response.retry_after.as_deref()),
                };
                return stopped(listing, stop);
            }
            500..=599 => return unknown(listing, Reason::Unavailable),
            _ => return unknown(listing, Reason::InvalidResponse),
        }
        listing.dates = ServerDates::merge(
            listing.dates,
            server_date(response.date.as_deref()).map(|date| ServerDates {
                earliest: date,
                latest: date,
            }),
        );
        let Some(page_listing) = parse_page(&response.body, page) else {
            return unknown(listing, Reason::InvalidResponse);
        };
        // Readable IDs from an envelope-valid page are presence evidence even if
        // the listing as a whole cannot be verified.
        listing.observed.extend(page_listing.ids.iter().copied());
        let expected = *listing.total.get_or_insert(page_listing.total);
        if expected != page_listing.total {
            return unknown(listing, Reason::IncompleteListing);
        }
        if expected > MAX_CHECK_PAGES * CHECK_PAGE_LIMIT {
            return unknown(listing, Reason::TooManyImages);
        }
        if !page_listing.complete {
            return unknown(listing, Reason::IncompleteListing);
        }
        let empty = page_listing.ids.is_empty();
        ids.extend(page_listing.ids);
        if empty || ids.len() as u64 >= expected {
            break;
        }
    }
    let unique: HashSet<u64> = ids.iter().copied().collect();
    if Some(ids.len() as u64) != listing.total || unique.len() != ids.len() {
        return unknown(listing, Reason::IncompleteListing);
    }
    listing.outcome = Ok(unique);
    listing
}

struct ListedPage {
    total: u64,
    /// The readable positive IDs on the page.
    ids: Vec<u64>,
    /// Whether every entry had a readable positive ID.
    complete: bool,
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
    // Totals beyond what the library can store are not a listing anyone serves.
    let total = value
        .get("total")?
        .as_u64()
        .filter(|total| i64::try_from(*total).is_ok())?;
    let data = value.get("data")?.as_array()?;
    if data.len() as u64 > CHECK_PAGE_LIMIT {
        return None;
    }
    let readable: Vec<u64> = data
        .iter()
        .filter_map(|entry| {
            entry
                .get("id")
                .and_then(serde_json::Value::as_u64)
                .filter(|id| *id > 0)
        })
        .collect();
    Some(ListedPage {
        total,
        complete: readable.len() == data.len(),
        ids: readable,
    })
}

fn probe_source(
    transport: &impl SteamGridDbTransport,
    url: &str,
    budget: &mut Budget<'_>,
) -> (SteamGridDbSourceStatus, Option<SteamGridDbCheckStop>) {
    if !is_image_url(url) {
        return (SteamGridDbSourceStatus::Unknown, None);
    }
    match budget.take(false) {
        Take::Granted => {}
        Take::Exhausted => return (SteamGridDbSourceStatus::Unknown, None),
        Take::Stop(stop) => return (SteamGridDbSourceStatus::NotChecked, Some(stop)),
    }
    // Only the status matters; at most two bytes are read.
    let Ok(response) = transport.fetch_image(url, 1) else {
        return (SteamGridDbSourceStatus::Unknown, None);
    };
    match response.status {
        200 => (SteamGridDbSourceStatus::Served, None),
        404 | 410 => (SteamGridDbSourceStatus::Gone, None),
        429 => (
            SteamGridDbSourceStatus::Unknown,
            Some(SteamGridDbCheckStop::RateLimited {
                retry_after_seconds: retry_after_seconds(response.retry_after.as_deref()),
            }),
        ),
        _ => (SteamGridDbSourceStatus::Unknown, None),
    }
}

#[cfg(test)]
#[path = "steamgriddb_check_tests.rs"]
mod tests;
