use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{
    CatalogMediaAsset, CatalogMediaRole, CatalogMediaSubject, Library, PortcoveError,
    PortcoveService, Result,
};

mod destination;
mod igdb_cache;
pub(crate) use igdb_cache::RemoteDerivative;
pub(crate) mod steamgriddb;
pub use destination::{
    ARTWORK_HANDOFF_SCHEMA, DestinationArtworkBytes, DestinationArtworkContent,
    DestinationArtworkHandoff, DestinationArtworkRole, DestinationArtworkSource,
    DestinationArtworkUnavailableReason,
};
pub use igdb_cache::IGDB_ARTWORK_WORK_LIMIT;
/// Internal adapter detail distinguishing a downloadable cache miss from an unavailable asset.
pub const ARTWORK_CACHE_MISS: &str = "artwork_download_required";
/// Internal adapter detail indicating an eligible transient image failure.
pub const ARTWORK_RETRY: &str = "artwork_retry_after";
pub use steamgriddb::{
    STEAMGRIDDB_API_ORIGIN, STEAMGRIDDB_KEY_PREFERENCES_URL, SteamGridDbAuthor,
    SteamGridDbCandidate, SteamGridDbCheckEffect, SteamGridDbCheckStop, SteamGridDbFailure,
    SteamGridDbGame, SteamGridDbImageCheck, SteamGridDbKeyStatus, SteamGridDbListingReport,
    SteamGridDbListingResult, SteamGridDbSourceStatus, SteamGridDbUnknownReason,
    clear_steamgriddb_key, search_steamgriddb_games, set_steamgriddb_key, steamgriddb_candidates,
    steamgriddb_credit_url, steamgriddb_key_status, steamgriddb_preview,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ArtworkSlot {
    Cover,
    Detail,
    /// A wide cover, separate from the detail image; Steam's library capsule.
    Landscape,
    Logo,
}

impl ArtworkSlot {
    pub(crate) const ALL: [Self; 4] = [Self::Cover, Self::Detail, Self::Landscape, Self::Logo];

    /// The single stored key for each slot; `from_key` is its exact inverse.
    pub(crate) fn key(self) -> &'static str {
        match self {
            Self::Cover => "cover",
            Self::Detail => "detail",
            Self::Landscape => "landscape",
            Self::Logo => "logo",
        }
    }

    pub(crate) fn from_key(key: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|slot| slot.key() == key)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ArtworkImageFormat {
    Png,
    Jpeg,
}

/// Local integrity and user selection do not establish copyright permission.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct LocalArtworkAsset {
    pub sha256: String,
    pub original_name: String,
    pub format: ArtworkImageFormat,
    pub byte_size: u64,
    pub width: u32,
    pub height: u32,
    pub imported_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ArtworkChoice {
    pub port_id: String,
    pub slot: ArtworkSlot,
    pub revision: u64,
    pub asset_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub framing: Option<ArtworkFraming>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub suppressed: bool,
}

impl ArtworkChoice {
    pub(crate) fn is_automatic(&self) -> bool {
        self.asset_sha256.is_none() && !self.suppressed
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Visibility {
    Automatic,
    Hide,
    Show,
}

/// A focal point on the orientation-corrected image, in ten-thousandths.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ArtworkFocalPoint {
    #[schemars(range(min = 0, max = 10000))]
    pub x: u16,
    #[schemars(range(min = 0, max = 10000))]
    pub y: u16,
}

/// Presentation data for wide and narrow consumers of the same background.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "version", rename_all = "snake_case", deny_unknown_fields)]
pub enum ArtworkFraming {
    V1 {
        wide: ArtworkFocalPoint,
        narrow: ArtworkFocalPoint,
    },
}

impl ArtworkFraming {
    pub(crate) fn validate(self) -> Result<()> {
        let Self::V1 { wide, narrow } = self;
        if [wide.x, wide.y, narrow.x, narrow.y]
            .into_iter()
            .any(|coordinate| coordinate > 10_000)
        {
            return Err(PortcoveError::verification(
                "artwork focal coordinates must be between 0 and 10000",
            ));
        }
        Ok(())
    }
}

/// The full identity of a reviewed image and optional background framing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ArtworkSelectionFraming {
    pub preview_sha256: String,
    pub framing: Option<ArtworkFraming>,
}

impl ArtworkSelectionFraming {
    fn validate(&self, slot: ArtworkSlot) -> Result<()> {
        crate::artwork_store::validate_hash(&self.preview_sha256)?;
        if let Some(framing) = self.framing {
            if slot != ArtworkSlot::Detail {
                return Err(PortcoveError::usage(
                    "framing is available for background artwork",
                ));
            }
            framing.validate()?;
        }
        Ok(())
    }
}

/// A re-resolved provider image awaiting application to the current library.
pub struct PreparedSteamGridDbArtwork {
    library: crate::LibraryIdentity,
    port_id: String,
    slot: ArtworkSlot,
    game_id: u64,
    fetched: steamgriddb::FetchedCandidate,
}

impl PreparedSteamGridDbArtwork {
    pub fn apply(
        self,
        service: &PortcoveService,
        expected_revision: u64,
        framing: Option<ArtworkSelectionFraming>,
    ) -> Result<ArtworkState> {
        if service.library().identity_record()? != self.library {
            return Err(PortcoveError::conflict(
                "the open library changed; review the current selection and try again",
            ));
        }
        let port = service.artwork_port(&self.port_id)?;
        service.choose_fetched_artwork_with_framing(
            &port,
            self.slot,
            self.game_id,
            self.fetched,
            expected_revision,
            framing,
        )
    }
}

/// A bounded, orientation-corrected PNG derived from the exact reviewed bytes.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ArtworkSelectionPreview {
    pub original_sha256: String,
    pub png: Vec<u8>,
}

impl ArtworkSelectionPreview {
    pub(crate) fn from_provider(
        slot: ArtworkSlot,
        fetched: &steamgriddb::FetchedCandidate,
    ) -> Result<Self> {
        let decoded = decode_steamgriddb_artwork(slot, fetched)?;
        Ok(Self::from_decoded(&fetched.bytes, decoded))
    }

    fn from_decoded(bytes: &[u8], decoded: crate::artwork_image::DecodedArtwork) -> Self {
        Self {
            original_sha256: crate::signed_catalog::digest(bytes),
            png: decoded.thumbnail,
        }
    }
}

/// A remote provider an image was chosen from; a local import has none.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum ArtworkProvider {
    Steamgriddb,
}

impl ArtworkProvider {
    pub(crate) fn key(self) -> &'static str {
        match self {
            Self::Steamgriddb => "steamgriddb",
        }
    }
}

/// Artwork categories accepted by the optional SteamGridDB provider client.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SteamGridDbArtworkRole {
    PortraitCover,
    LandscapeCover,
    HeroBanner,
    Logo,
}

/// Where a provider image came from and who made it. Recorded per origin, never
/// replaced by a later identical import, and shown wherever the image is credited.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ArtworkAttribution {
    pub provider: ArtworkProvider,
    /// The provider's identity for this image.
    pub asset_id: u64,
    /// The provider's game the image was listed under; a proposal, not port identity.
    pub game_id: u64,
    pub role: SteamGridDbArtworkRole,
    pub author_name: String,
    pub author_steam64: Option<String>,
    pub source_url: String,
    pub fetched_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ArtworkProviderRecord {
    pub asset_sha256: String,
    pub attribution: ArtworkAttribution,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ArtworkMetadata {
    pub assets: Vec<LocalArtworkAsset>,
    pub choices: Vec<ArtworkChoice>,
    /// Provider provenance; present only under library metadata schema 8.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub providers: Vec<ArtworkProviderRecord>,
    /// Assets that exist only because a provider image was chosen; no local import
    /// of the same bytes was made. Present only under library metadata schema 8.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub provider_only_assets: Vec<String>,
    /// Confirmed withdrawals of provider records; library metadata schema 10.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub withdrawals: Vec<ArtworkWithdrawalRecord>,
    /// Provider-only assets whose originals Portcove removed after every record
    /// was withdrawn. Their files are not carried; schema 10.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub evicted_assets: Vec<ArtworkEvictedAsset>,
}

impl ArtworkMetadata {
    pub(crate) fn contains_suppression(&self) -> bool {
        self.choices.iter().any(|choice| choice.suppressed)
    }

    pub(crate) fn contains_framing(&self) -> bool {
        self.choices.iter().any(|choice| choice.framing.is_some())
    }

    pub(crate) fn contains_logo_records(&self) -> bool {
        self.choices
            .iter()
            .any(|choice| choice.slot == ArtworkSlot::Logo)
            || self
                .providers
                .iter()
                .any(|record| record.attribution.role == SteamGridDbArtworkRole::Logo)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ArtworkWithdrawalRecord {
    pub asset_sha256: String,
    pub provider: ArtworkProvider,
    pub asset_id: u64,
    pub withdrawn_at: i64,
    pub signal: ArtworkWithdrawalSignal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ArtworkEvictedAsset {
    pub asset_sha256: String,
    pub evicted_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ArtworkAvailability {
    Fallback,
    Available,
    Unavailable,
}

/// The source core resolves for one slot before a client attempts to transport
/// or render it. A client can still display the generated fallback if a
/// resolved image cannot be retrieved, decoded or presented safely.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ArtworkResolvedSource {
    LocalImport {
        asset_sha256: String,
    },
    IgdbCover {
        artwork: crate::IgdbArtwork,
        cache_id: String,
    },
    CatalogMedia {
        asset: Box<CatalogMediaAsset>,
    },
    GeneratedFallback,
}

#[derive(PartialEq, Eq)]
struct LandscapeSourceBinding {
    profile: String,
    active_install: Option<String>,
    registration: String,
}

fn select_landscape_cover<'a>(
    port: &'a crate::PortListing,
    verified_edition: impl FnOnce() -> Option<crate::VerifiedOriginalEdition>,
) -> Option<&'a CatalogMediaAsset> {
    let covers = || {
        port.media
            .iter()
            .filter(|asset| asset.role == CatalogMediaRole::LandscapeCover)
    };
    if let Some(asset) = covers().find(|asset| {
        matches!(&asset.subject, CatalogMediaSubject::Port { port_id } if port_id == &port.id)
    }) {
        return Some(asset);
    }
    let game = port.original_game.as_ref()?;
    let original_covers = || {
        covers().filter(|asset| {
        matches!(&asset.subject, CatalogMediaSubject::Original { game_id, .. } if game_id == &game.id)
    })
    };
    if original_covers().any(|asset| asset.edition_neutral != Some(true))
        && let Some(edition) = verified_edition()
        && edition.port_id == port.id
        && edition.original_game_id == game.id
        && let Some(asset) = original_covers().find(|asset| {
            matches!(&asset.subject, CatalogMediaSubject::Original { source_edition_id, .. }
                if source_edition_id == &edition.source_edition_id)
        })
    {
        return Some(asset);
    }
    let mut neutral = original_covers().filter(|asset| asset.edition_neutral == Some(true));
    let first = neutral.next()?;
    neutral
        .all(|candidate| candidate.sha256 == first.sha256)
        .then_some(first)
}

#[cfg(test)]
#[test]
fn landscape_cover_uses_edition_only_when_the_port_and_game_match() {
    let listing = crate::CatalogListingDocument::from_json(
        &serde_json::json!({
            "format_version": 21,
            "listings": [{
                "id": "landscape-fixture",
                "name": "Landscape fixture",
                "summary": "Two source editions.",
                "project_url": "https://github.com/example/game",
                "original_game": {
                    "format_version": 1,
                    "id": "original-game",
                    "evidence_urls": ["https://example.com/game"],
                    "source_editions": [
                        {"id": "retail", "title": "Retail", "evidence_urls": ["https://example.com/retail"]},
                        {"id": "demo", "title": "Demo", "evidence_urls": ["https://example.com/demo"]},
                    ]
                },
                "media": ([false, true].map(|neutral| serde_json::json!({
                    "id": if neutral { "neutral-art" } else { "retail-art" },
                    "role": "landscape_cover",
                    "subject": {
                        "kind": "original",
                        "game_id": "original-game",
                        "source_edition_id": if neutral { "demo" } else { "retail" },
                    },
                    "edition_neutral": neutral,
                    "caption": "Landscape",
                    "url": "https://raw.githubusercontent.com/example/game/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/wide.png",
                    "sha256": "b".repeat(64),
                    "width": 16,
                    "height": 9,
                    "attribution": "Example",
                    "source_url": "https://github.com/example/game",
                    "license": "CC0-1.0",
                    "rights_url": "https://creativecommons.org/publicdomain/zero/1.0/",
                }))),
            }],
        }).to_string(),
    ).unwrap().listings.remove(0);
    let edition = |port: &str, game: &str| {
        Some(crate::VerifiedOriginalEdition {
            port_id: port.into(),
            original_game_id: game.into(),
            source_edition_id: "retail".into(),
        })
    };
    assert_eq!(
        select_landscape_cover(&listing, || None).unwrap().id,
        "neutral-art"
    );
    assert_eq!(
        select_landscape_cover(&listing, || edition("landscape-fixture", "original-game"))
            .unwrap()
            .id,
        "retail-art",
    );
    for evidence in [
        edition("other-port", "original-game"),
        edition("landscape-fixture", "other-game"),
    ] {
        assert_eq!(
            select_landscape_cover(&listing, || evidence).unwrap().id,
            "neutral-art"
        );
    }
    let mut port_art = listing;
    port_art.media.truncate(1);
    port_art.media[0].subject = CatalogMediaSubject::Port {
        port_id: port_art.id.clone(),
    };
    let selected =
        select_landscape_cover(&port_art, || panic!("port artwork needs no edition read"));
    assert_eq!(selected.unwrap().id, "retail-art");
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct GeneratedArtworkFallback {
    pub identity: String,
    pub style_version: u32,
    pub initials: String,
    pub palette_index: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ArtworkState {
    pub choice: ArtworkChoice,
    pub selection: Option<LocalArtworkAsset>,
    pub availability: ArtworkAvailability,
    pub reason: Option<String>,
    pub resolved_source: ArtworkResolvedSource,
    pub generated_fallback: GeneratedArtworkFallback,
    /// Provider credits for the selected image; empty for a purely local import.
    pub attribution: Vec<ArtworkAttribution>,
    /// Recorded listing evidence for the credited images; empty until an image
    /// is chosen from a provider or checked.
    pub provider_listing: Vec<ArtworkProviderListing>,
    /// When Portcove removed the selected image's stored copy because every
    /// provider that supplied it confirmed a withdrawal. The choice and the
    /// credit stay; choosing the image again restores the copy.
    pub evicted_at: Option<i64>,
}

/// A prepared SteamGridDB listing check: the records it starts from and the
/// single-flight lock. It holds no library connection or lease.
pub struct SteamGridDbListingCheck {
    subjects: Vec<steamgriddb::CheckSubject>,
    started_from: std::collections::HashMap<(String, u64), (u64, i64)>,
    /// The library the check was prepared for; it records into no other.
    library_root: PathBuf,
    single_flight: crate::PortOperationGuard,
}

/// A completed network check, ready to be recorded or reported unrecorded.
pub struct CheckedSteamGridDbListings {
    report: steamgriddb::SteamGridDbListingReport,
    server_dates: Vec<Option<steamgriddb::ServerDates>>,
    started_from: std::collections::HashMap<(String, u64), (u64, i64)>,
    library_root: PathBuf,
    single_flight: crate::PortOperationGuard,
}

impl SteamGridDbListingCheck {
    /// The network phase, with the player's key. It stops before the next
    /// request once `cancelled` returns true.
    pub fn check(self, cancelled: &dyn Fn() -> bool) -> Result<CheckedSteamGridDbListings> {
        self.check_with(|subjects, now| {
            steamgriddb::check_stored_listings(subjects, now, cancelled)
        })
    }

    pub(crate) fn check_with<R: Into<steamgriddb::ListingRun>>(
        self,
        check: impl FnOnce(Vec<steamgriddb::CheckSubject>, i64) -> Result<R>,
    ) -> Result<CheckedSteamGridDbListings> {
        let steamgriddb::ListingRun {
            report,
            server_dates,
        } = check(self.subjects, Library::now())?.into();
        Ok(CheckedSteamGridDbListings {
            report,
            server_dates,
            started_from: self.started_from,
            library_root: self.library_root,
            single_flight: self.single_flight,
        })
    }
}

impl CheckedSteamGridDbListings {
    /// The results as seen, for a host whose library changed before recording.
    pub fn unrecorded(self) -> steamgriddb::SteamGridDbListingReport {
        let mut report = self.report;
        report.recorded = report.images.is_empty();
        report
    }
}

/// Recorded evidence of whether a provider still lists a credited image. A
/// confirmed withdrawal (`withdrawn_at`) can remove a provider-only copy; see
/// [`ArtworkState::evicted_at`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ArtworkProviderListing {
    pub provider: ArtworkProvider,
    pub asset_id: u64,
    /// When a check or a choice last established this evidence.
    pub last_checked_at: i64,
    pub last_result: steamgriddb::SteamGridDbListingResult,
    /// When a verified listing first lacked the image; cleared only when it is
    /// seen listed again.
    pub not_listed_since: Option<i64>,
    /// When a later check confirmed the withdrawal; cleared when the image is
    /// seen listed again or chosen again.
    pub withdrawn_at: Option<i64>,
    pub withdrawal_signal: Option<ArtworkWithdrawalSignal>,
}

/// The second signal that confirmed a withdrawal after a first absence.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ArtworkWithdrawalSignal {
    /// SteamGridDB's image server answered that the file is gone.
    Gone,
    /// A check at least 24 hours after the first absence still did not find it.
    AbsentAgain,
}

pub(crate) const EVICTED_REASON: &str = "SteamGridDB no longer lists this image, so Portcove removed its copy. Your choice and the credit are kept. Choose it again if it returns, or pick another image.";
pub(crate) const EVICTED_LISTED_AGAIN_REASON: &str =
    "SteamGridDB lists this image again. Choose it again to restore Portcove's copy.";

fn provider_role(slot: ArtworkSlot) -> SteamGridDbArtworkRole {
    match slot {
        ArtworkSlot::Cover => SteamGridDbArtworkRole::PortraitCover,
        ArtworkSlot::Detail => SteamGridDbArtworkRole::HeroBanner,
        ArtworkSlot::Landscape => SteamGridDbArtworkRole::LandscapeCover,
        ArtworkSlot::Logo => SteamGridDbArtworkRole::Logo,
    }
}

pub(crate) enum IngestOrigin {
    Local,
    Provider(ArtworkAttribution),
}

pub(crate) struct IngestedArtwork<'a> {
    pub(crate) bytes: &'a [u8],
    pub(crate) decoded: &'a crate::artwork_image::DecodedArtwork,
    pub(crate) original_name: String,
    pub(crate) origin: IngestOrigin,
    pub(crate) framing: Option<ArtworkSelectionFraming>,
}

fn read_local_artwork(source: &Path) -> Result<(Vec<u8>, crate::artwork_image::DecodedArtwork)> {
    crate::path::unicode(source, "local artwork")?;
    crate::path::refuse_symlink_ancestors(source)?;
    let bytes =
        crate::path::read_bounded_regular(source, crate::artwork_image::MAX_ORIGINAL_BYTES)?;
    let decoded = crate::artwork_image::decode(&bytes)?;
    Ok((bytes, decoded))
}

fn decode_steamgriddb_artwork(
    slot: ArtworkSlot,
    fetched: &steamgriddb::FetchedCandidate,
) -> Result<crate::artwork_image::DecodedArtwork> {
    let steamgriddb::FetchedCandidate { candidate, bytes } = fetched;
    if candidate.role != provider_role(slot) {
        return Err(PortcoveError::verification(
            "the SteamGridDB image was listed for a different artwork role",
        ));
    }
    // The shared decode also refuses animation the provider's static filter missed.
    let decoded = crate::artwork_image::decode(bytes)?;
    let listed_format = match candidate.mime.as_str() {
        "image/png" => ArtworkImageFormat::Png,
        "image/jpeg" if slot != ArtworkSlot::Logo => ArtworkImageFormat::Jpeg,
        _ => {
            return Err(PortcoveError::verification(
                "the SteamGridDB image type is not supported",
            ));
        }
    };
    if decoded.format != listed_format
        || decoded.width != candidate.width
        || decoded.height != candidate.height
    {
        return Err(PortcoveError::verification(
            "the SteamGridDB image differs from its listing; the current artwork was kept",
        ));
    }
    Ok(decoded)
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ArtworkThumbnail {
    pub asset_sha256: String,
    pub choice_revision: u64,
    pub png: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ArtworkCacheClear {
    pub removed_files: u64,
    pub removed_bytes: u64,
}

impl Library {
    pub fn artwork_cache_epoch(&self) -> Result<ArtworkCacheEpoch> {
        igdb_cache::cache_epoch(self).map(ArtworkCacheEpoch)
    }
}

pub(crate) struct ArtworkListing<'a> {
    listing: std::borrow::Cow<'a, crate::PortListing>,
    cover_resolved: bool,
}

impl AsRef<crate::PortListing> for ArtworkListing<'_> {
    fn as_ref(&self) -> &crate::PortListing {
        &self.listing
    }
}

impl std::ops::Deref for ArtworkListing<'_> {
    type Target = crate::PortListing;

    fn deref(&self) -> &Self::Target {
        self.as_ref()
    }
}

impl ArtworkListing<'_> {
    pub(crate) fn automatic_cover<'a>(
        &'a self,
        catalog: &'a crate::Catalog,
    ) -> Option<&'a crate::IgdbArtwork> {
        if self.cover_resolved {
            self.listing.artwork.as_ref()
        } else {
            catalog.automatic_cover(&self.listing)
        }
    }
}

impl PortcoveService {
    pub(crate) fn artwork_port(&self, port_id: &str) -> Result<ArtworkListing<'_>> {
        let unknown = match self.catalog().listing(port_id) {
            Ok(listing) => {
                return Ok(ArtworkListing {
                    listing: std::borrow::Cow::Borrowed(listing),
                    cover_resolved: false,
                });
            }
            Err(unknown) => unknown,
        };
        // Keep the exact admitted-definition boundary for retained managed
        // installs. Invalid managed state must not fall through to another
        // descriptive source and appear to have passed that boundary.
        if let Some(install) = self
            .library()
            .status(port_id, crate::ReleaseChannel::Stable)?
            .active
        {
            let retained = self.installed_catalog(&install)?;
            let Some(identity) = retained.definition_selection(port_id) else {
                return Err(unknown);
            };
            if self
                .library()
                .retained_definition_admission_role(identity)?
                .is_none()
            {
                return Err(unknown);
            }
            return Ok(ArtworkListing {
                listing: std::borrow::Cow::Owned(crate::PortListing::from(retained.port(port_id)?)),
                cover_resolved: false,
            });
        }
        // User-owned registrations and unfinished setup retain their display
        // identity independently of whether a newer directory still lists it.
        // Their validated snapshots grant no managed lifecycle authority.
        let mut budget = crate::library::MAX_RETAINED_REGISTRATION_BYTES;
        let connection = self.library().connection()?;
        if let Some((record, retained)) =
            Library::external_runtime_with_port_bounded_from(&connection, port_id, &mut budget)?
        {
            let listing = retained.listing(port_id)?.clone();
            let (listing, canonical) = if record.user_selected.is_some() {
                Self::personal_listing_projection(self.catalog(), &connection, listing)?
            } else {
                (listing, None)
            };
            return Ok(ArtworkListing {
                listing: std::borrow::Cow::Owned(listing),
                cover_resolved: canonical.is_some(),
            });
        }
        if let Some(pending) = self
            .pending_setups()?
            .into_iter()
            .find(|record| record.port_id == port_id)
        {
            return Ok(ArtworkListing {
                listing: std::borrow::Cow::Owned(pending.listing),
                cover_resolved: false,
            });
        }
        Err(unknown)
    }

    pub(crate) fn require_current_artwork_listing(
        &self,
        expected: &ArtworkListing<'_>,
    ) -> Result<()> {
        let Some(current) = self.current_artwork_service()? else {
            return Ok(());
        };
        let actual = current.artwork_port(&expected.id)?;
        if actual.as_ref() == expected.as_ref()
            && actual.cover_resolved == expected.cover_resolved
            && expected.automatic_cover(self.catalog()) == actual.automatic_cover(current.catalog())
            && self.catalog_companion_cover(&expected.id)
                == current.catalog_companion_cover(&expected.id)
        {
            return Ok(());
        }
        Err(PortcoveError::conflict(
            "catalog artwork changed; refresh its details",
        ))
    }

    fn catalog_companion_cover(&self, port_id: &str) -> Option<&crate::IgdbArtwork> {
        self.catalog()
            .port(port_id)
            .ok()?
            .presentation
            .as_ref()?
            .companion_cover
            .as_ref()
    }

    /// Content identities of remote originals that a currently resolvable port
    /// still references: the current catalog plus the retained installed,
    /// registered and unfinished-setup identities that `artwork_port` serves.
    fn referenced_remote_originals(&self) -> Result<BTreeSet<String>> {
        fn add(referenced: &mut BTreeSet<String>, listing: &crate::PortListing) {
            referenced.extend(listing.artwork.iter().map(|art| art.image_sha256.clone()));
            referenced.extend(
                listing
                    .collection_covers
                    .iter()
                    .flatten()
                    .map(|art| art.image_sha256.clone()),
            );
            referenced.extend(listing.media.iter().map(|asset| asset.sha256.clone()));
        }
        let mut referenced = BTreeSet::new();
        for listing in self.catalog().listings() {
            add(&mut referenced, listing);
        }
        for port in self.catalog().ports() {
            if let Some(cover) = port
                .presentation
                .as_ref()
                .and_then(|p| p.companion_cover.as_ref())
            {
                referenced.insert(cover.image_sha256.clone());
            }
        }
        let connection = self.library().connection()?;
        let mut retained: BTreeSet<String> = Library::installs_from(&connection)?
            .into_iter()
            .map(|install| install.port_id)
            .collect();
        retained.extend(Library::external_runtime_port_ids_from(&connection)?);
        retained.extend(
            Self::pending_setups_from(&connection)?
                .into_iter()
                .map(|record| record.port_id),
        );
        drop(connection);
        for port_id in retained {
            if self.catalog().listing(&port_id).is_ok() {
                continue;
            }
            match self.artwork_port(&port_id) {
                Ok(listing) => add(&mut referenced, &listing),
                // An identity with no resolvable listing presents no remote image.
                Err(error) if error.code == crate::ErrorCode::NotFound => {}
                Err(error) => return Err(error),
            }
        }
        Ok(referenced)
    }

    /// Publishes a verified remote original under the artwork lock and retires
    /// cached remote originals and their derivatives that no resolvable port references any more,
    /// such as a cover replaced or withdrawn by a signed catalog correction.
    /// When references cannot be established, every existing entry is retained.
    pub(crate) fn publish_remote_original(
        &self,
        path: &Path,
        pending_name: &str,
        bytes: &[u8],
    ) -> Result<()> {
        let current = self.current_artwork_service()?;
        let referenced = match current
            .as_ref()
            .unwrap_or(self)
            .referenced_remote_originals()
        {
            Ok(referenced) => Some(referenced),
            Err(error) => {
                tracing::warn!(
                    code = ?error.code,
                    "artwork cache retained every remote original: references unavailable"
                );
                None
            }
        };
        publish_cache_file(
            self.library(),
            path,
            pending_name,
            crate::artwork_image::MAX_ORIGINAL_BYTES,
            bytes,
            referenced.as_ref(),
            None,
        )
    }

    pub fn artwork(&self, port_id: &str, slot: ArtworkSlot) -> Result<ArtworkState> {
        let port = self.artwork_port(port_id)?;
        let artwork =
            self.artwork_for_listing(&port, slot, || port.automatic_cover(self.catalog()))?;
        self.require_current_artwork_listing(&port)?;
        Ok(artwork)
    }

    fn landscape_source_binding(
        &self,
        port: &crate::PortListing,
    ) -> Option<LandscapeSourceBinding> {
        let profile = self
            .catalog()
            .port(&port.id)
            .ok()?
            .source_profile
            .as_deref()?;
        let registered = self.library().source(profile).ok()??;
        let status = self.status_without_rollback_assessment(&port.id).ok()?;
        if status.external_runtime.is_some()
            || (status.active.is_some()
                && !status.readiness.is_some_and(|readiness| {
                    readiness.active_game_source_profile.as_deref() == Some(profile)
                        && matches!(
                            readiness.source,
                            Some(crate::SourceHealth::Current | crate::SourceHealth::NotChecked)
                        )
                }))
        {
            return None;
        }
        Some(LandscapeSourceBinding {
            profile: profile.into(),
            active_install: status.active.map(|active| active.id),
            registration: crate::source_batch::fingerprint(&registered).ok()?,
        })
    }

    fn with_automatic_landscape_cover<T>(
        &self,
        port: &crate::PortListing,
        project: impl Fn(&CatalogMediaAsset) -> Result<T>,
    ) -> Result<Option<T>> {
        let fallback = select_landscape_cover(port, || None);
        let can_verify_edition = !fallback.is_some_and(|asset| matches!(&asset.subject, CatalogMediaSubject::Port { .. }))
            && port.original_game.as_ref().is_some_and(|game| {
                port.media.iter().any(|asset| {
                    asset.role == CatalogMediaRole::LandscapeCover
                        && asset.edition_neutral != Some(true)
                        && matches!(&asset.subject,
                            CatalogMediaSubject::Original { game_id, source_edition_id }
                                if game_id == &game.id && game.source_editions.iter().any(|edition| {
                                    &edition.id == source_edition_id && !edition.verified_sources.is_empty()
                                })
                        )
                })
            });
        if can_verify_edition && let Some(before) = self.landscape_source_binding(port) {
            let verified = self.with_registered_artwork_source(
                &before.profile,
                |report| {
                    let registered = report.registered.as_ref()?;
                    if report.health != crate::SourceHealth::Current
                        || crate::source_batch::fingerprint(registered).ok()? != before.registration
                        || self.landscape_source_binding(port).as_ref() != Some(&before)
                    {
                        return None;
                    }
                    let mut editions = report
                        .original_editions
                        .into_iter()
                        .filter(|edition| edition.port_id == port.id);
                    let edition = editions.next()?;
                    if editions.next().is_some() {
                        return None;
                    }
                    select_landscape_cover(port, || Some(edition))
                        .filter(|asset| asset.edition_neutral != Some(true))
                        .map(&project)
                },
                || {
                    let expected = self.artwork_port(&port.id)?;
                    if expected.as_ref() != port {
                        return Err(PortcoveError::conflict(
                            "catalog artwork changed; refresh its details",
                        ));
                    }
                    self.require_current_artwork_listing(&expected)?;
                    if self.landscape_source_binding(port).as_ref() != Some(&before) {
                        return Err(PortcoveError::conflict(
                            "the original edition changed during landscape cover retrieval",
                        ));
                    }
                    Ok(())
                },
            );
            // Missing, stale and unsupported originals cannot select edition
            // artwork. Port and neutral defaults have independent authority.
            if let Ok(Some(result)) = verified {
                return result.map(Some);
            }
        }
        fallback.map(project).transpose()
    }

    fn artwork_for_listing<'a>(
        &self,
        port: &crate::PortListing,
        slot: ArtworkSlot,
        default_cover: impl FnOnce() -> Option<&'a crate::IgdbArtwork>,
    ) -> Result<ArtworkState> {
        let port_id = &port.id;
        let mut connection = self.library().connection()?;
        let transaction = connection.transaction()?;
        let choice = crate::artwork_store::choice(&transaction, port_id, slot)?;
        let selection = choice
            .asset_sha256
            .as_deref()
            .map(|id| crate::artwork_store::asset(&transaction, id))
            .transpose()?;
        let attribution = match &selection {
            Some(asset) => crate::artwork_store::attributions(&transaction, &asset.sha256)?,
            None => Vec::new(),
        };
        let provider_listing = match &selection {
            Some(asset) => {
                crate::artwork_store::asset_listing_evidence(&transaction, &asset.sha256)?
            }
            None => Vec::new(),
        };
        let evicted_at = match &selection {
            Some(asset) => crate::artwork_store::evicted_at(&transaction, &asset.sha256)?,
            None => None,
        };
        let withdrawn_records = match &selection {
            Some(asset) if evicted_at.is_some() => {
                crate::artwork_store::asset_withdrawals(&transaction, &asset.sha256)?.len()
            }
            _ => 0,
        };
        transaction.commit()?;
        let generated_fallback = generated_fallback(port_id, &port.name, slot)?;
        let (availability, reason, resolved_source) = match &selection {
            // A hidden role keeps its selection without displaying or reading it.
            _ if choice.suppressed => (
                ArtworkAvailability::Fallback,
                None,
                ArtworkResolvedSource::GeneratedFallback,
            ),
            None if slot == ArtworkSlot::Landscape && choice.is_automatic() => {
                match self.with_automatic_landscape_cover(port, |asset| Ok(Box::new(asset.clone())))? {
                    Some(asset) => (
                        ArtworkAvailability::Available,
                        None,
                        ArtworkResolvedSource::CatalogMedia { asset },
                    ),
                    None => (
                        ArtworkAvailability::Fallback,
                        None,
                        ArtworkResolvedSource::GeneratedFallback,
                    ),
                }
            }
            None => match if slot == ArtworkSlot::Cover && choice.is_automatic() {
                default_cover()
            } else {
                None
            } {
                Some(artwork) => (
                    ArtworkAvailability::Available,
                    None,
                    ArtworkResolvedSource::IgdbCover {
                        artwork: artwork.clone(),
                        cache_id: igdb_cache_id(artwork),
                    },
                ),
                None => (
                    ArtworkAvailability::Fallback,
                    None,
                    ArtworkResolvedSource::GeneratedFallback,
                ),
            },
            // The marker decides before any file is read, so a copy still
            // waiting to be deleted is never shown.
            Some(_) if evicted_at.is_some() => (
                ArtworkAvailability::Unavailable,
                Some(
                    if withdrawn_records < attribution.len() {
                        EVICTED_LISTED_AGAIN_REASON
                    } else {
                        EVICTED_REASON
                    }
                    .into(),
                ),
                ArtworkResolvedSource::GeneratedFallback,
            ),
            Some(asset) => match original_bytes(self.library(), asset) {
                Ok(_) => (
                    ArtworkAvailability::Available,
                    None,
                    ArtworkResolvedSource::LocalImport {
                        asset_sha256: asset.sha256.clone(),
                    },
                ),
                Err(_) => (
                    ArtworkAvailability::Unavailable,
                    Some("The selected local image is missing, changed, or unavailable. Its choice has been retained.".into()),
                    ArtworkResolvedSource::GeneratedFallback,
                ),
            },
        };
        Ok(ArtworkState {
            choice,
            selection,
            availability,
            reason,
            resolved_source,
            generated_fallback,
            attribution,
            provider_listing,
            evicted_at,
        })
    }

    pub fn preview_local_artwork(
        &self,
        port_id: &str,
        source: &Path,
    ) -> Result<ArtworkSelectionPreview> {
        self.artwork_port(port_id)?;
        let (bytes, decoded) = read_local_artwork(source)?;
        Ok(ArtworkSelectionPreview::from_decoded(&bytes, decoded))
    }

    pub fn import_artwork(
        &self,
        port_id: &str,
        slot: ArtworkSlot,
        source: &Path,
        expected_revision: u64,
    ) -> Result<ArtworkState> {
        self.import_artwork_with_framing(port_id, slot, source, expected_revision, None)
    }

    pub fn import_artwork_with_framing(
        &self,
        port_id: &str,
        slot: ArtworkSlot,
        source: &Path,
        expected_revision: u64,
        framing: Option<ArtworkSelectionFraming>,
    ) -> Result<ArtworkState> {
        if let Some(framing) = &framing {
            framing.validate(slot)?;
        }
        let port = self.artwork_port(port_id)?;
        let _guard = self.library().try_lock_artwork()?;
        let (bytes, decoded) = read_local_artwork(source)?;
        let original_name = source
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| PortcoveError::usage("artwork needs a Unicode filename"))?
            .to_owned();
        self.ingest_artwork(
            &port,
            slot,
            IngestedArtwork {
                bytes: &bytes,
                decoded: &decoded,
                original_name,
                origin: IngestOrigin::Local,
                framing,
            },
            expected_revision,
        )
    }

    /// Preview a validated original from the provider collection for this slot.
    pub fn preview_steamgriddb_artwork(
        &self,
        port_id: &str,
        slot: ArtworkSlot,
        game_id: u64,
        candidate_id: u64,
    ) -> Result<ArtworkSelectionPreview> {
        self.artwork_port(port_id)?;
        let fetched =
            steamgriddb::fetch_chosen_candidate(game_id, provider_role(slot), candidate_id)?;
        ArtworkSelectionPreview::from_provider(slot, &fetched)
    }

    /// Choose one SteamGridDB image for a port's slot. Re-resolve the candidate
    /// within that slot's provider collection and fetch the bytes before taking
    /// the artwork lock. The revision checks during ingestion reject a stale choice.
    pub fn choose_steamgriddb_artwork(
        &self,
        port_id: &str,
        slot: ArtworkSlot,
        game_id: u64,
        candidate_id: u64,
        expected_revision: u64,
    ) -> Result<ArtworkState> {
        self.choose_steamgriddb_artwork_with_framing(
            port_id,
            slot,
            game_id,
            candidate_id,
            expected_revision,
            None,
        )
    }

    pub fn choose_steamgriddb_artwork_with_framing(
        &self,
        port_id: &str,
        slot: ArtworkSlot,
        game_id: u64,
        candidate_id: u64,
        expected_revision: u64,
        framing: Option<ArtworkSelectionFraming>,
    ) -> Result<ArtworkState> {
        if let Some(framing) = &framing {
            framing.validate(slot)?;
        }
        self.prepare_steamgriddb_artwork(port_id, slot, game_id, candidate_id)?
            .apply(self, expected_revision, framing)
    }

    pub fn prepare_steamgriddb_artwork(
        &self,
        port_id: &str,
        slot: ArtworkSlot,
        game_id: u64,
        candidate_id: u64,
    ) -> Result<PreparedSteamGridDbArtwork> {
        self.artwork_port(port_id)?;
        let library = self.library().identity_record()?;
        let fetched =
            steamgriddb::fetch_chosen_candidate(game_id, provider_role(slot), candidate_id)?;
        Ok(PreparedSteamGridDbArtwork {
            library,
            port_id: port_id.into(),
            slot,
            game_id,
            fetched,
        })
    }

    /// Check whether SteamGridDB still lists each stored SteamGridDB image with
    /// the player's key, and record the evidence beside each provider record. A
    /// withdrawal confirmed by a second signal removes the stored copy of a
    /// provider-only image; choices, credits and Steam entries never change. The
    /// network work holds no artwork lock; only the short recording step does.
    pub fn check_steamgriddb_listings(&self) -> Result<steamgriddb::SteamGridDbListingReport> {
        self.check_steamgriddb_listings_until(&|| false)
    }

    /// As [`Self::check_steamgriddb_listings`], stopping before the next request
    /// once `cancelled` returns true. A cancelled check records nothing.
    pub fn check_steamgriddb_listings_until(
        &self,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<steamgriddb::SteamGridDbListingReport> {
        let checked = self.prepare_steamgriddb_listing_check()?.check(cancelled)?;
        Ok(self.record_steamgriddb_listings(checked, cancelled))
    }

    /// The first of three phases a host can run separately: it takes the
    /// single-flight lock and snapshots the records and their evidence. The
    /// returned check holds no library connection or lease, so the network phase
    /// never keeps a library in use; record it with a service for the same library.
    pub fn prepare_steamgriddb_listing_check(&self) -> Result<SteamGridDbListingCheck> {
        let single_flight = self.library().try_lock_listing_check()?;
        // Removals an earlier check left behind are finished whatever this one
        // finds, even with no key or network; a busy artwork lock defers them.
        if let Ok(_guard) = self.library().try_lock_artwork() {
            let _ = crate::artwork_eviction::complete_pending_evictions(
                self.library(),
                Some(crate::artwork_eviction::REMOVALS_PER_CHECK),
            );
        }
        // One read transaction gives a consistent snapshot of the records and
        // their evidence while choices and removals continue.
        let (metadata, checks) = {
            let mut connection = self.library().connection()?;
            let transaction = connection.transaction()?;
            let metadata = crate::artwork_store::snapshot(&transaction)?;
            let checks =
                crate::artwork_store::listing_checks(&transaction, ArtworkProvider::Steamgriddb)?;
            transaction.commit()?;
            (metadata, checks)
        };
        // Per record: the revision the check started from, and its last check time.
        let started_from: std::collections::HashMap<(String, u64), (u64, i64)> = checks
            .into_iter()
            .map(|row| {
                (
                    (row.asset_sha256, row.asset_id),
                    (row.revision, row.last_checked_at),
                )
            })
            .collect();
        let subjects = steamgriddb::check_subjects(&metadata, |sha, asset_id| {
            started_from
                .get(&(sha.to_owned(), asset_id))
                .map(|(_, checked_at)| *checked_at)
        });
        Ok(SteamGridDbListingCheck {
            subjects,
            started_from,
            library_root: self.library().root().to_path_buf(),
            single_flight,
        })
    }

    /// The last phase: applies a completed check unless it was cancelled. It
    /// never fails; a check it cannot record is returned with `recorded: false`.
    /// A withdrawal confirmed by this check evicts provider-only copies: the
    /// marker is committed with the evidence, then the files are deleted, at most
    /// [`crate::artwork_eviction::REMOVALS_PER_CHECK`] at a time.
    pub fn record_steamgriddb_listings(
        &self,
        checked: CheckedSteamGridDbListings,
        cancelled: &dyn Fn() -> bool,
    ) -> steamgriddb::SteamGridDbListingReport {
        let CheckedSteamGridDbListings {
            mut report,
            server_dates,
            started_from,
            library_root,
            single_flight,
        } = checked;
        if report.images.is_empty() {
            return report;
        }
        // A cancelled check may belong to a library that is changing, and a
        // check prepared for one library never records into another.
        report.recorded = !cancelled()
            && report.stopped != Some(steamgriddb::SteamGridDbCheckStop::Cancelled)
            && self.library().root() == library_root
            && self
                .record_listing_report(&mut report, &server_dates, &started_from)
                .is_ok();
        if !report.recorded {
            for image in &mut report.images {
                image.effect = steamgriddb::SteamGridDbCheckEffect::None;
            }
            report.skipped = 0;
        }
        // Each image shows the library's state after this check, recorded or
        // not, and only from the library it was prepared for.
        if self.library().root() == library_root {
            let _ = self.read_back_listing_state(&mut report);
        }
        drop(single_flight);
        report
    }

    fn read_back_listing_state(
        &self,
        report: &mut steamgriddb::SteamGridDbListingReport,
    ) -> Result<()> {
        let connection = self.library().connection()?;
        let rows = crate::artwork_store::listing_checks(&connection, ArtworkProvider::Steamgriddb)?;
        for image in &mut report.images {
            image.not_listed_since = rows
                .iter()
                .find(|row| {
                    row.asset_sha256 == image.asset_sha256
                        && row.asset_id == image.attribution.asset_id
                })
                .and_then(|row| row.not_listed_since);
            image.withdrawn_at =
                crate::artwork_store::asset_withdrawals(&connection, &image.asset_sha256)?
                    .into_iter()
                    .find(|(provider, row)| {
                        provider == image.attribution.provider.key()
                            && row.asset_id == image.attribution.asset_id
                    })
                    .map(|(_, row)| row.withdrawn_at);
            image.evicted_at = crate::artwork_store::evicted_at(&connection, &image.asset_sha256)?;
        }
        Ok(())
    }

    /// The recording orchestration around one check, separate from the network
    /// work so it can be exercised with prepared reports.
    #[cfg(test)]
    pub(crate) fn run_listing_check<R: Into<steamgriddb::ListingRun>>(
        &self,
        cancelled: &dyn Fn() -> bool,
        check: impl FnOnce(Vec<steamgriddb::CheckSubject>, i64) -> Result<R>,
    ) -> Result<steamgriddb::SteamGridDbListingReport> {
        let prepared = self.prepare_steamgriddb_listing_check()?;
        let checked = prepared.check_with(check)?;
        Ok(self.record_steamgriddb_listings(checked, cancelled))
    }

    /// Applies every attempted result in one immediate transaction, then evicts
    /// what the confirmed withdrawals allow and deletes the files. The artwork
    /// lock is retried briefly, under a library switch's drain, because
    /// thumbnails and handoffs take it routinely.
    fn record_listing_report(
        &self,
        report: &mut steamgriddb::SteamGridDbListingReport,
        server_dates: &[Option<steamgriddb::ServerDates>],
        started_from: &std::collections::HashMap<(String, u64), (u64, i64)>,
    ) -> Result<()> {
        use crate::artwork_store::{Applied, WithdrawalChange};
        use steamgriddb::{
            SteamGridDbCheckEffect as Effect, SteamGridDbListingResult as Listing,
            SteamGridDbSourceStatus as Source,
        };
        let mut attempts = 0;
        let _guard = loop {
            match self.library().try_lock_artwork() {
                Ok(guard) => break guard,
                // Only a busy lock is worth waiting for.
                Err(error) if error.code == crate::ErrorCode::Conflict && attempts < 8 => {
                    attempts += 1;
                    std::thread::sleep(std::time::Duration::from_millis(200));
                }
                Err(error) => return Err(error),
            }
        };
        let mut connection = self.library().connection()?;
        let mut transaction =
            connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let mut skipped = 0;
        let mut effects = vec![Effect::None; report.images.len()];
        // Assets with a record newly confirmed withdrawn in this run.
        let mut fresh_assets = std::collections::BTreeSet::new();
        // Per image: written in this run as a verified absence.
        let mut written_absent = vec![false; report.images.len()];
        // An asset with a record this run could not write may still carry a
        // withdrawal that the unwritten result would have cleared.
        let mut unwritten_assets = std::collections::BTreeSet::new();
        for (index, image) in report.images.iter().enumerate() {
            if !image.attempted {
                continue;
            }
            let (result, reason) = match image.listing {
                Listing::Listed => ("listed", None),
                Listing::NotListed => ("not_listed", None),
                Listing::Unknown { reason } => ("unknown", Some(reason)),
            };
            let reason = reason
                .map(|reason| {
                    serde_json::to_value(reason).map(|value| value.as_str().map(str::to_owned))
                })
                .transpose()?
                .flatten();
            let source = match image.source {
                Source::NotChecked => None,
                Source::Served => Some("served"),
                Source::Gone => Some("gone"),
                Source::Unknown => Some("unknown"),
            };
            // One savepoint per record, so a record that cannot be written is
            // skipped, and counted, without losing the rest of the run.
            let savepoint = transaction.savepoint()?;
            let applied = crate::artwork_store::apply_listing_check(
                &savepoint,
                image.attribution.provider,
                &image.asset_sha256,
                image.attribution.asset_id,
                started_from
                    .get(&(image.asset_sha256.clone(), image.attribution.asset_id))
                    .map(|(revision, _)| *revision),
                &crate::artwork_store::ListingObservation {
                    result,
                    unknown_reason: reason.as_deref(),
                    total: image.listing_total,
                    source,
                    server_dates: server_dates
                        .get(index)
                        .copied()
                        .flatten()
                        .map(|dates| (dates.earliest, dates.latest)),
                },
                report.checked_at,
            );
            match applied {
                Ok(applied) => {
                    savepoint.commit()?;
                    written_absent[index] =
                        applied != Applied::Skipped && image.listing == Listing::NotListed;
                    match applied {
                        Applied::Recorded(WithdrawalChange::Withdrawn) => {
                            effects[index] = Effect::Withdrawn;
                            fresh_assets.insert(image.asset_sha256.clone());
                        }
                        Applied::Recorded(WithdrawalChange::Cleared) => {
                            effects[index] = Effect::ListedAgain;
                        }
                        Applied::Recorded(WithdrawalChange::Unchanged) | Applied::Skipped => {}
                    }
                }
                Err(_) => {
                    skipped += 1;
                    unwritten_assets.insert(image.asset_sha256.clone());
                }
            }
        }
        // After every record is applied, inside the same transaction: an asset
        // is evicted only when every one of its records is withdrawn now. It is
        // evaluated when a record was newly confirmed, or when every one of its
        // records in this report was written as a verified absence, so an asset
        // held back by an earlier write failure is evicted only once fresh
        // evidence agrees with every stored withdrawal.
        let mut candidates = fresh_assets.clone();
        for image in &report.images {
            if report
                .images
                .iter()
                .enumerate()
                .filter(|(_, other)| other.asset_sha256 == image.asset_sha256)
                .all(|(index, _)| written_absent[index])
            {
                candidates.insert(image.asset_sha256.clone());
            }
        }
        let mut newly_evicted = std::collections::BTreeSet::new();
        for asset in candidates.difference(&unwritten_assets) {
            if crate::artwork_store::evictable(&transaction, asset)? {
                crate::artwork_store::mark_evicted(&transaction, asset, report.checked_at)?;
                newly_evicted.insert(asset.clone());
            }
        }
        // A withdrawal confirmed on an asset whose copy is removed, now or by an
        // earlier check, reads as removed.
        let mut removed = Vec::with_capacity(report.images.len());
        for image in report.images.iter() {
            removed.push(
                crate::artwork_store::evicted_at(&transaction, &image.asset_sha256)?.is_some(),
            );
        }
        transaction.commit()?;
        for (index, image) in report.images.iter_mut().enumerate() {
            // This check removed the copy: its absences report removed, even
            // when every withdrawal was confirmed by an earlier check.
            let removed_now = newly_evicted.contains(&image.asset_sha256) && written_absent[index];
            image.effect = if (effects[index] == Effect::Withdrawn && removed[index]) || removed_now
            {
                Effect::Removed
            } else {
                effects[index]
            };
        }
        report.skipped = skipped;
        // The markers are committed; deleting the files can only follow.
        let counts = crate::artwork_eviction::complete_pending_evictions(
            self.library(),
            Some(crate::artwork_eviction::REMOVALS_PER_CHECK),
        )
        .unwrap_or_default();
        report.removed = counts.removed;
        report.removal_deferred = counts.deferred;
        report.removal_failed = counts.failed;
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn choose_fetched_artwork(
        &self,
        port: &crate::PortListing,
        slot: ArtworkSlot,
        game_id: u64,
        fetched: steamgriddb::FetchedCandidate,
        expected_revision: u64,
    ) -> Result<ArtworkState> {
        self.choose_fetched_artwork_with_framing(
            port,
            slot,
            game_id,
            fetched,
            expected_revision,
            None,
        )
    }

    pub(crate) fn choose_fetched_artwork_with_framing(
        &self,
        port: &crate::PortListing,
        slot: ArtworkSlot,
        game_id: u64,
        fetched: steamgriddb::FetchedCandidate,
        expected_revision: u64,
        framing: Option<ArtworkSelectionFraming>,
    ) -> Result<ArtworkState> {
        let decoded = decode_steamgriddb_artwork(slot, &fetched)?;
        let steamgriddb::FetchedCandidate { candidate, bytes } = fetched;
        let extension = match decoded.format {
            ArtworkImageFormat::Png => "png",
            ArtworkImageFormat::Jpeg => "jpg",
        };
        let attribution = ArtworkAttribution {
            provider: ArtworkProvider::Steamgriddb,
            asset_id: candidate.id,
            game_id,
            role: candidate.role,
            author_name: candidate.author.name,
            author_steam64: candidate.author.steam64,
            source_url: candidate.url,
            fetched_at: Library::now(),
        };
        crate::artwork_store::validate_attribution(&attribution)?;
        let _guard = self.library().try_lock_artwork()?;
        self.ingest_artwork(
            port,
            slot,
            IngestedArtwork {
                bytes: &bytes,
                decoded: &decoded,
                original_name: format!("steamgriddb-{}.{extension}", candidate.id),
                origin: IngestOrigin::Provider(attribution),
                framing,
            },
            expected_revision,
        )
    }

    /// The single ingestion path for local and provider images. The caller holds
    /// the artwork lock and has already read and decoded bounded bytes.
    pub(crate) fn ingest_artwork(
        &self,
        port: &crate::PortListing,
        slot: ArtworkSlot,
        image: IngestedArtwork<'_>,
        expected_revision: u64,
    ) -> Result<ArtworkState> {
        let port_id = port.id.as_str();
        let IngestedArtwork {
            bytes,
            decoded,
            original_name,
            origin,
            framing,
        } = image;
        let sha256 = crate::signed_catalog::digest(bytes);
        if let Some(framing) = &framing {
            framing.validate(slot)?;
            if framing.preview_sha256 != sha256 {
                return Err(PortcoveError::conflict(
                    "the selected image changed; preview it again before applying",
                )
                .detail("artwork_preview_changed", "true"));
            }
        }
        let proposed = LocalArtworkAsset {
            sha256,
            original_name,
            format: decoded.format,
            byte_size: bytes.len() as u64,
            width: decoded.width,
            height: decoded.height,
            imported_at: Library::now(),
        };
        crate::artwork_store::validate_asset(&proposed)?;
        let mut connection = self.library().connection()?;
        if framing.is_some() {
            // A staged edit rejected for staleness leaves pending maintenance alone.
            crate::artwork_store::require_revision(&connection, port_id, slot, expected_revision)?;
        }
        // Removals left over from a check are finished first, so a stale copy of
        // an evicted image is never mistaken for the one being restored.
        let _ = crate::artwork_eviction::complete_pending_evictions(
            self.library(),
            Some(crate::artwork_eviction::REMOVALS_PER_CHECK),
        );
        // Reserve the write before reading a revision. Another library writer
        // can otherwise invalidate the read snapshot before the first write.
        let transaction =
            connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        crate::artwork_store::require_revision(&transaction, port_id, slot, expected_revision)?;
        crate::artwork_store::check_capacity(&transaction, &proposed)?;
        let existed = crate::artwork_store::asset_exists(&transaction, &proposed.sha256)?;
        // Restoring an evicted image changes its provenance only after the
        // original is published again, so a failed restore leaves it as it was.
        let restoring = crate::artwork_store::evicted_at(&transaction, &proposed.sha256)?.is_some();
        if restoring && let IngestOrigin::Provider(attribution) = &origin {
            crate::artwork_store::require_compatible_provider_listing(
                &transaction,
                &proposed.sha256,
                attribution,
            )?;
        }
        // Reserve durable inventory before publishing bytes. Interruption leaves
        // a tracked unused asset that can be retried or explicitly removed.
        crate::artwork_store::write_asset(&transaction, &proposed)?;
        if !restoring {
            self.record_ingested_origin(&transaction, &proposed.sha256, &origin, existed)?;
        }
        transaction.commit()?;
        let path = original_path(self.library(), &proposed.sha256)?;
        ensure_parent(&path)?;
        if path.exists() {
            let retained =
                crate::path::read_bounded_regular(&path, crate::artwork_image::MAX_ORIGINAL_BYTES)?;
            if retained != bytes {
                return Err(PortcoveError::verification(
                    "existing artwork content differs from its identity; it was retained",
                ));
            }
        } else {
            crate::artwork_ingestion::publish_original(
                self.library(),
                &proposed.sha256,
                &path,
                bytes,
            )?;
        }
        let transaction =
            connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let current =
            crate::artwork_store::require_revision(&transaction, port_id, slot, expected_revision)?;
        if restoring {
            // The marker goes first, because it requires the provider-only marker
            // that a local import removes.
            crate::artwork_store::clear_eviction(&transaction, &proposed.sha256)?;
            self.record_ingested_origin(&transaction, &proposed.sha256, &origin, existed)?;
        }
        let framing = match framing {
            Some(requested) => requested.framing,
            None if current.asset_sha256.as_deref() == Some(proposed.sha256.as_str()) => {
                current.framing
            }
            None => None,
        };
        crate::artwork_store::write_choice(
            &transaction,
            port_id,
            slot,
            expected_revision,
            crate::artwork_store::ChoiceValue::Image(&proposed.sha256, framing),
        )?;
        // Choices publish only after validated originals. The accepted decode
        // also produced the thumbnail, but its disposable cache cannot make a
        // committed selection appear to fail and invite an unsafe retry.
        transaction.commit()?;
        let _ = publish_thumbnail(
            self.library(),
            &connection,
            &proposed.sha256,
            &decoded.thumbnail,
        );
        self.artwork_for_listing(port, slot, || None)
    }

    /// The provenance an ingestion records: a local import makes the asset the
    /// player's own; a provider image adds its credit and listed evidence.
    fn record_ingested_origin(
        &self,
        transaction: &rusqlite::Transaction<'_>,
        sha256: &str,
        origin: &IngestOrigin,
        existed: bool,
    ) -> Result<()> {
        match origin {
            IngestOrigin::Local => crate::artwork_store::record_local_origin(transaction, sha256),
            IngestOrigin::Provider(attribution) => {
                crate::artwork_store::write_provider(
                    transaction,
                    &ArtworkProviderRecord {
                        asset_sha256: sha256.to_owned(),
                        attribution: attribution.clone(),
                    },
                )?;
                // The image was just re-resolved from the provider's listing.
                crate::artwork_store::mark_listed_on_choose(
                    transaction,
                    attribution.provider,
                    sha256,
                    attribution.asset_id,
                    attribution.fetched_at,
                )?;
                if !existed {
                    crate::artwork_store::mark_provider_only(transaction, sha256)?;
                }
                Ok(())
            }
        }
    }

    /// Change the presentation of the current selected background.
    pub fn set_background_artwork_framing(
        &self,
        port_id: &str,
        expected_revision: u64,
        framing: Option<ArtworkFraming>,
    ) -> Result<ArtworkState> {
        let port = self.artwork_port(port_id)?;
        let slot = ArtworkSlot::Detail;
        let _guard = self.library().try_lock_artwork()?;
        let mut connection = self.library().connection()?;
        let transaction =
            connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let current =
            crate::artwork_store::require_revision(&transaction, port_id, slot, expected_revision)?;
        let Some(asset_sha256) = current.asset_sha256.as_deref() else {
            return Err(PortcoveError::conflict(
                "choose a background image before adjusting its framing",
            ));
        };
        if current.suppressed {
            return Err(PortcoveError::conflict(
                "show the background before adjusting its framing",
            ));
        }
        if current.framing != framing {
            crate::artwork_store::write_choice(
                &transaction,
                port_id,
                slot,
                expected_revision,
                crate::artwork_store::ChoiceValue::Image(asset_sha256, framing),
            )?;
        }
        transaction.commit()?;
        self.artwork_for_listing(&port, slot, || port.automatic_cover(self.catalog()))
    }

    pub fn reset_artwork(
        &self,
        port_id: &str,
        slot: ArtworkSlot,
        expected_revision: u64,
    ) -> Result<ArtworkState> {
        self.set_artwork_without_image(port_id, slot, expected_revision, Visibility::Automatic)
    }

    /// Hide a role. Its selected image and framing stay stored, unshown, until
    /// [`Self::unhide_artwork`] restores exactly that selection.
    pub fn suppress_artwork(
        &self,
        port_id: &str,
        slot: ArtworkSlot,
        expected_revision: u64,
    ) -> Result<ArtworkState> {
        self.set_artwork_without_image(port_id, slot, expected_revision, Visibility::Hide)
    }

    /// Show a hidden role again with the selection it kept while hidden.
    pub fn unhide_artwork(
        &self,
        port_id: &str,
        slot: ArtworkSlot,
        expected_revision: u64,
    ) -> Result<ArtworkState> {
        self.set_artwork_without_image(port_id, slot, expected_revision, Visibility::Show)
    }

    fn set_artwork_without_image(
        &self,
        port_id: &str,
        slot: ArtworkSlot,
        expected_revision: u64,
        visibility: Visibility,
    ) -> Result<ArtworkState> {
        let port = self.artwork_port(port_id)?;
        let _guard = self.library().try_lock_artwork()?;
        let mut connection = self.library().connection()?;
        let transaction =
            connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let current =
            crate::artwork_store::require_revision(&transaction, port_id, slot, expected_revision)?;
        let id = current.asset_sha256.as_deref();
        let value = match visibility {
            Visibility::Hide if current.suppressed => {
                return Err(PortcoveError::conflict("this artwork is already hidden"));
            }
            Visibility::Show if !current.suppressed => {
                return Err(PortcoveError::conflict("this artwork is not hidden"));
            }
            Visibility::Hide => crate::artwork_store::ChoiceValue::Hidden(id, current.framing),
            Visibility::Show => match id {
                Some(id) => crate::artwork_store::ChoiceValue::Image(id, current.framing),
                None => crate::artwork_store::ChoiceValue::Automatic,
            },
            Visibility::Automatic => crate::artwork_store::ChoiceValue::Automatic,
        };
        crate::artwork_store::write_choice(&transaction, port_id, slot, expected_revision, value)?;
        transaction.commit()?;
        if visibility == Visibility::Automatic {
            let _ = crate::artwork_eviction::complete_pending_evictions(
                self.library(),
                Some(crate::artwork_eviction::REMOVALS_PER_CHECK),
            );
        }
        self.artwork_for_listing(&port, slot, || port.automatic_cover(self.catalog()))
    }

    /// Retrieve an admitted collection member only while the player keeps the default cover.
    pub fn collection_cover_thumbnail(
        &self,
        port_id: &str,
        expected_sha256: &str,
        expected_revision: u64,
    ) -> Result<ArtworkThumbnail> {
        crate::artwork_store::validate_hash(expected_sha256)?;
        let listing = self.artwork_port(port_id)?;
        let cover = listing
            .collection_covers
            .as_ref()
            .and_then(|covers| {
                covers
                    .iter()
                    .find(|cover| cover.image_sha256 == expected_sha256)
            })
            .ok_or_else(|| {
                PortcoveError::not_found("this listing has no matching collection cover")
            })?;
        listing.validate()?;
        let require_default = || {
            self.require_current_artwork_listing(&listing)?;
            let connection = self.library().connection()?;
            let current = crate::artwork_store::require_revision(
                &connection,
                port_id,
                ArtworkSlot::Cover,
                expected_revision,
            )?;
            if !current.is_automatic() {
                return Err(PortcoveError::conflict("the artwork choice changed"));
            }
            Ok(())
        };
        require_default()?;
        let mut thumbnail = igdb_thumbnail(
            self.library(),
            cover,
            expected_revision,
            self.remote_artwork,
            |original| {
                require_default()?;
                self.publish_igdb_original(cover, original)
            },
        )?;
        require_default()?;
        thumbnail.asset_sha256 = cover.image_sha256.clone();
        Ok(thumbnail)
    }

    /// Retrieve the companion only for the current, unmodified primary cover.
    pub fn companion_cover_thumbnail(
        &self,
        port_id: &str,
        expected_primary_cache_id: &str,
        expected_sha256: &str,
        expected_revision: u64,
    ) -> Result<ArtworkThumbnail> {
        let listing = self.artwork_port(port_id)?;
        let primary = listing
            .artwork
            .as_ref()
            .ok_or_else(|| PortcoveError::not_found("this listing has no primary cover"))?;
        if igdb_cache_id(primary) != expected_primary_cache_id {
            return Err(PortcoveError::conflict(
                "the primary artwork mapping changed",
            ));
        }
        let companion = self
            .catalog()
            .port(port_id)?
            .presentation
            .as_ref()
            .filter(|presentation| presentation.artwork.as_ref() == Some(primary))
            .and_then(|presentation| presentation.companion_cover.as_ref())
            .filter(|cover| cover.image_sha256 == expected_sha256)
            .ok_or_else(|| {
                PortcoveError::not_found("this listing has no matching companion cover")
            })?;
        let require_default = || {
            self.require_current_artwork_listing(&listing)?;
            let connection = self.library().connection()?;
            let current = crate::artwork_store::require_revision(
                &connection,
                port_id,
                ArtworkSlot::Cover,
                expected_revision,
            )?;
            if !current.is_automatic() {
                return Err(PortcoveError::conflict(
                    "the primary artwork choice changed",
                ));
            }
            Ok(())
        };
        require_default()?;
        let mut thumbnail = igdb_thumbnail(
            self.library(),
            companion,
            expected_revision,
            self.remote_artwork,
            |original| {
                require_default()?;
                self.publish_igdb_original(companion, original)
            },
        )?;
        require_default()?;
        thumbnail.asset_sha256 = companion.image_sha256.clone();
        Ok(thumbnail)
    }

    pub fn artwork_thumbnail(
        &self,
        port_id: &str,
        slot: ArtworkSlot,
        expected_revision: u64,
    ) -> Result<ArtworkThumbnail> {
        let port = self.artwork_port(port_id)?;
        if slot == ArtworkSlot::Landscape {
            let automatic = {
                let connection = self.library().connection()?;
                crate::artwork_store::require_revision(
                    &connection,
                    port_id,
                    slot,
                    expected_revision,
                )?
                .is_automatic()
            };
            if automatic
                && let Some(mut thumbnail) = self
                    .with_automatic_landscape_cover(&port, |asset| {
                        self.catalog_media_thumbnail(port_id, &asset.id, &asset.sha256)
                    })?
            {
                self.require_current_artwork_listing(&port)?;
                let connection = self.library().connection()?;
                if !crate::artwork_store::require_revision(
                    &connection,
                    port_id,
                    slot,
                    expected_revision,
                )?
                .is_automatic()
                {
                    return Err(PortcoveError::conflict(
                        "the artwork choice changed during landscape cover retrieval",
                    ));
                }
                thumbnail.choice_revision = expected_revision;
                return Ok(thumbnail);
            }
        }
        let mapped_cover = if slot == ArtworkSlot::Cover {
            port.automatic_cover(self.catalog())
        } else {
            None
        };
        if let Some(artwork) = mapped_cover {
            let connection = self.library().connection()?;
            let choice = crate::artwork_store::require_revision(
                &connection,
                port_id,
                slot,
                expected_revision,
            )?;
            if choice.is_automatic() {
                drop(connection);
                let thumbnail = igdb_thumbnail(
                    self.library(),
                    artwork,
                    expected_revision,
                    self.remote_artwork,
                    |original| {
                        self.require_current_artwork_listing(&port)?;
                        let connection = self.library().connection()?;
                        let current = crate::artwork_store::require_revision(
                            &connection,
                            port_id,
                            slot,
                            expected_revision,
                        )?;
                        if !current.is_automatic() {
                            return Err(PortcoveError::conflict(
                                "the artwork choice changed during cover retrieval",
                            ));
                        }
                        self.publish_igdb_original(artwork, original)
                    },
                )?;
                self.require_current_artwork_listing(&port)?;
                let connection = self.library().connection()?;
                let current = crate::artwork_store::require_revision(
                    &connection,
                    port_id,
                    slot,
                    expected_revision,
                )?;
                if !current.is_automatic() {
                    return Err(PortcoveError::conflict(
                        "the artwork choice changed during cover retrieval",
                    ));
                }
                return Ok(thumbnail);
            }
        }
        let _guard = self.library().try_lock_artwork()?;
        if let Some(epoch) = self.remote_artwork.epoch {
            epoch.require_current(self.library())?;
        }
        self.require_current_artwork_listing(&port)?;
        let connection = self.library().connection()?;
        let choice =
            crate::artwork_store::require_revision(&connection, port_id, slot, expected_revision)?;
        if choice.suppressed {
            return Err(PortcoveError::not_found("this artwork is hidden"));
        }
        let id = choice
            .asset_sha256
            .ok_or_else(|| PortcoveError::not_found("this artwork slot uses the fallback"))?;
        let asset = crate::artwork_store::asset(&connection, &id)?;
        if crate::artwork_store::evicted_at(&connection, &id)?.is_some() {
            return Err(PortcoveError::not_found(EVICTED_REASON));
        }
        let original = original_bytes(self.library(), &asset)?;
        let cache = thumbnail_path(self.library(), &id)?;
        if let Some((expected_hash, expected_size)) =
            crate::artwork_store::thumbnail(&connection, &id)?
            && let Ok(bytes) =
                crate::path::read_bounded_regular(&cache, crate::artwork_image::MAX_THUMBNAIL_BYTES)
            && bytes.len() as u64 == expected_size
            && crate::signed_catalog::digest(&bytes) == expected_hash
        {
            return Ok(ArtworkThumbnail {
                asset_sha256: id,
                choice_revision: expected_revision,
                png: bytes,
            });
        }
        let decoded = crate::artwork_image::decode(&original)?;
        publish_thumbnail(self.library(), &connection, &id, &decoded.thumbnail)?;
        Ok(ArtworkThumbnail {
            asset_sha256: id,
            choice_revision: expected_revision,
            png: decoded.thumbnail,
        })
    }

    pub fn clear_artwork_cache(&self) -> Result<ArtworkCacheClear> {
        let _guard = self.library().try_lock_artwork()?;
        let _ = crate::artwork_eviction::complete_pending_evictions(
            self.library(),
            Some(crate::artwork_eviction::REMOVALS_PER_CHECK),
        );
        let files = cache_files(self.library())?;
        let result = ArtworkCacheClear {
            removed_files: files.len() as u64,
            removed_bytes: files.iter().try_fold(0_u64, |total, (_, size)| {
                total
                    .checked_add(*size)
                    .ok_or_else(|| PortcoveError::verification("artwork cache size overflow"))
            })?,
        };
        igdb_cache::advance_cache_epoch(self.library())?;
        for (path, _) in files {
            fs::remove_file(path)?;
        }
        self.library()
            .connection()?
            .execute("DELETE FROM artwork_thumbnails", [])?;
        Ok(result)
    }

    /// Which of these stored images Portcove removed because every
    /// SteamGridDB credit behind it was confirmed withdrawn. A destination
    /// such as Steam uses it to point out copies it holds of those images. It
    /// is a display fact only: it never authorizes removing anything. Images
    /// Portcove kept (the player's own import, or one still credited) and
    /// unknown hashes are not reported. At most 64 hashes are accepted.
    pub fn evicted_artwork_sources(
        &self,
        asset_sha256s: &[String],
    ) -> Result<Vec<ArtworkEvictedAsset>> {
        const MAX_SOURCES: usize = 64;
        if asset_sha256s.len() > MAX_SOURCES {
            return Err(PortcoveError::usage(
                "too many artwork sources to look up at once",
            ));
        }
        for id in asset_sha256s {
            crate::artwork_store::validate_hash(id)?;
        }
        let mut connection = self.library().connection()?;
        let transaction = connection.transaction()?;
        let mut found = Vec::new();
        let mut seen = std::collections::BTreeSet::new();
        for id in asset_sha256s {
            if !seen.insert(id) {
                continue;
            }
            if let Some(evicted_at) = crate::artwork_store::evicted_at(&transaction, id)? {
                found.push(ArtworkEvictedAsset {
                    asset_sha256: id.clone(),
                    evicted_at,
                });
            }
        }
        transaction.commit()?;
        Ok(found)
    }

    pub fn unused_local_artwork(&self) -> Result<Vec<LocalArtworkAsset>> {
        let mut connection = self.library().connection()?;
        let transaction = connection.transaction()?;
        let metadata = crate::artwork_store::snapshot(&transaction)?;
        transaction.commit()?;
        Ok(metadata
            .assets
            .into_iter()
            .filter(|asset| {
                !metadata
                    .choices
                    .iter()
                    .any(|choice| choice.asset_sha256.as_deref() == Some(asset.sha256.as_str()))
            })
            .collect())
    }

    pub fn remove_unused_local_artwork(&self, asset_sha256: &str) -> Result<()> {
        let _guard = self.library().try_lock_artwork()?;
        let _ = crate::artwork_eviction::complete_pending_evictions(
            self.library(),
            Some(crate::artwork_eviction::REMOVALS_PER_CHECK),
        );
        let mut connection = self.library().connection()?;
        let transaction = connection.transaction()?;
        let asset = crate::artwork_store::asset(&transaction, asset_sha256)?;
        let selected: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM artwork_choices WHERE asset_sha256=?1)",
            [asset_sha256],
            |row| row.get(0),
        )?;
        if selected {
            return Err(PortcoveError::conflict(
                "this local image is still selected by an artwork slot",
            ));
        }
        let original = original_path(self.library(), asset_sha256)?;
        if original.exists() {
            original_bytes(self.library(), &asset)?;
            fs::remove_file(&original)?;
            crate::durability::sync_publication(&self.library().root().join("artwork"))?;
        }
        crate::artwork_ingestion::remove_staged_original(self.library(), &asset)?;
        let thumbnail = thumbnail_path(self.library(), asset_sha256)?;
        if thumbnail.exists() {
            fs::remove_file(thumbnail)?;
        }
        transaction.execute(
            "DELETE FROM artwork_thumbnails WHERE asset_sha256=?1",
            [asset_sha256],
        )?;
        crate::artwork_store::remove_asset_provenance(&transaction, asset_sha256)?;
        transaction.execute("DELETE FROM artwork_assets WHERE sha256=?1", [asset_sha256])?;
        transaction.commit()?;
        Ok(())
    }
}

fn generated_fallback(
    port_id: &str,
    port_name: &str,
    slot: ArtworkSlot,
) -> Result<GeneratedArtworkFallback> {
    const STYLE_VERSION: u32 = 1;
    let identity = crate::signed_catalog::digest(&serde_json::to_vec(&(
        "portcove-generated-artwork",
        STYLE_VERSION,
        port_id,
        port_name,
        slot.key(),
    ))?);
    let palette_index = u8::from_str_radix(&identity[..2], 16)
        .map_err(|_| PortcoveError::verification("generated artwork identity is invalid"))?
        % 6;
    Ok(GeneratedArtworkFallback {
        identity,
        style_version: STYLE_VERSION,
        initials: fallback_initials(port_name),
        palette_index,
    })
}

fn fallback_initials(name: &str) -> String {
    let words = name
        .split_whitespace()
        .filter_map(|word| word.chars().find(|character| character.is_alphanumeric()))
        .take(2)
        .collect::<Vec<_>>();
    let initials = if words.len() == 1 {
        name.chars()
            .filter(|character| character.is_alphanumeric())
            .take(2)
            .collect::<Vec<_>>()
    } else {
        words
    };
    let value = initials
        .into_iter()
        .filter_map(|character| character.to_uppercase().next())
        .collect::<String>();
    if value.is_empty() { "PC".into() } else { value }
}

fn publish_thumbnail(
    library: &Library,
    connection: &rusqlite::Connection,
    id: &str,
    bytes: &[u8],
) -> Result<()> {
    publish_thumbnail_file(library, id, bytes)?;
    crate::artwork_store::write_thumbnail(connection, id, bytes)
}

fn publish_thumbnail_file(library: &Library, id: &str, bytes: &[u8]) -> Result<()> {
    let path = thumbnail_path(library, id)?;
    publish_cache_file(
        library,
        &path,
        "pending-thumbnail",
        crate::artwork_image::MAX_THUMBNAIL_BYTES,
        bytes,
        None,
        None,
    )
}

fn cached_remote_original_digest(path: &Path) -> Option<&str> {
    match path.extension()?.to_str()? {
        "jpg" | "image" => path.file_stem()?.to_str(),
        _ => None,
    }
}

fn retire_unreferenced_remote_cache_files(
    files: &mut Vec<(PathBuf, u64)>,
    destination: &Path,
    referenced: &BTreeSet<String>,
) {
    let retiring: BTreeSet<_> = files
        .iter()
        .filter(|(path, _)| path != destination)
        .filter_map(|(path, _)| cached_remote_original_digest(path))
        .filter(|source| !referenced.contains(*source))
        .map(str::to_owned)
        .collect();
    if retiring.is_empty() {
        return;
    }

    // Read source bindings only when the existing inventory found an original
    // to retire. Remove its derivatives first so a lock or interrupted sweep
    // leaves the original available to find on the next publication.
    let mut blocked = BTreeSet::new();
    files.retain(|(path, size)| {
        let Some(source) = RemoteDerivative::retained_source(path, *size) else {
            return true;
        };
        if !retiring.contains(&source) {
            return true;
        }
        if fs::remove_file(path).is_ok() {
            return false;
        }
        blocked.insert(source);
        true
    });
    files.retain(|(path, _)| {
        path == destination
            || !cached_remote_original_digest(path)
                .is_some_and(|source| retiring.contains(source) && !blocked.contains(source))
            || fs::remove_file(path).is_err()
    });
}

pub(crate) fn publish_cache_file(
    library: &Library,
    path: &Path,
    pending_name: &str,
    maximum_bytes: u64,
    bytes: &[u8],
    referenced_remote: Option<&BTreeSet<String>>,
    protected_source: Option<&Path>,
) -> Result<()> {
    if bytes.len() as u64 > maximum_bytes {
        return Err(PortcoveError::verification(
            "artwork cache entry exceeds its byte limit",
        ));
    }
    let mut files = cache_files(library)?;
    if let Some(referenced) = referenced_remote {
        retire_unreferenced_remote_cache_files(&mut files, path, referenced);
    }
    let mut total = files
        .iter()
        .filter(|(existing, _)| existing != path)
        .try_fold(0_u64, |total, (_, size)| {
            total
                .checked_add(*size)
                .ok_or_else(|| PortcoveError::verification("artwork cache size overflow"))
        })?;
    const CACHE_BYTES: u64 = 64 * 1024 * 1024;
    let available = CACHE_BYTES.saturating_sub(bytes.len() as u64);
    if total > available {
        files.sort_by_cached_key(|(file, _)| {
            let metadata = fs::symlink_metadata(file).ok();
            let accessed = metadata.as_ref().and_then(|data| data.accessed().ok());
            let modified = metadata.as_ref().and_then(|data| data.modified().ok());
            accessed.max(modified)
        });
        for (existing, size) in files {
            if total <= available {
                break;
            }
            if existing != path
                && protected_source != Some(existing.as_path())
                && fs::remove_file(existing).is_ok()
            {
                total -= size;
            }
        }
        if total > available {
            return Err(PortcoveError::conflict(
                "artwork cache is busy; retry shortly",
            ));
        }
    }
    ensure_parent(path)?;
    let pending = library.root().join("artwork-cache").join(pending_name);
    crate::path::refuse_symlink_ancestors(&pending)?;
    match fs::symlink_metadata(&pending) {
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {
            fs::remove_file(&pending)?;
        }
        Ok(_) => {
            return Err(PortcoveError::verification(
                "unexpected artwork cache stage",
            ));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    crate::artwork_ingestion::write_staged_file(&pending, bytes)?;
    tempfile::TempPath::try_from_path(pending)?
        .persist(path)
        .map_err(|error| PortcoveError::from(error.error))?;
    crate::durability::sync_publication(&library.root().join("artwork-cache"))?;
    Ok(())
}

fn igdb_thumbnail(
    library: &Library,
    artwork: &crate::IgdbArtwork,
    revision: u64,
    read: RemoteArtworkRead,
    publish: impl FnOnce(&[u8]) -> Result<()>,
) -> Result<ArtworkThumbnail> {
    igdb_thumbnail_with_fetch(
        library,
        artwork,
        revision,
        read,
        publish,
        || fetch_igdb_original(artwork),
        std::time::Instant::now,
    )
}

pub(super) struct IgdbFetchFailure {
    pub(super) error: PortcoveError,
    pub(super) retryable: bool,
}

impl IgdbFetchFailure {
    fn other(error: PortcoveError) -> Self {
        Self {
            error,
            retryable: false,
        }
    }
}

// Disposable request state only: it never changes selection or admitted bytes.
const IGDB_RETRY_DELAY: Duration = Duration::from_secs(30);
const MAX_IGDB_REQUESTS: usize = 256;
const MAX_RETRY_ALIASES: usize = 8;
const MAX_IGDB_RETRY_MESSAGE: usize = 2048;

type IgdbRequestKey = (PathBuf, String, String, String, Option<uuid::Uuid>);
type IgdbRequestState = Arc<Mutex<RemoteArtworkFailures>>;

#[derive(Debug)]
struct ArtworkFailure {
    retry_at: Instant,
    message: String,
}

#[derive(Debug, Default)]
pub(crate) struct RemoteArtworkFailures(BTreeMap<String, ArtworkFailure>);

impl RemoteArtworkFailures {
    pub(crate) fn current(&self, source: &str, now: Instant) -> Option<PortcoveError> {
        let failure = self
            .0
            .get(source)
            .filter(|failure| now < failure.retry_at)?;
        Some(PortcoveError::network(failure.message.clone()).detail(ARTWORK_RETRY, "30"))
    }

    pub(crate) fn remember(&mut self, source: &str, error: &PortcoveError, now: Instant) {
        if error.code != crate::ErrorCode::Network || error.message.len() > MAX_IGDB_RETRY_MESSAGE {
            return;
        }
        self.0.retain(|_, entry| entry.retry_at > now);
        if self.0.len() < MAX_RETRY_ALIASES {
            self.0.insert(
                source.into(),
                ArtworkFailure {
                    retry_at: now + IGDB_RETRY_DELAY,
                    message: error.message.clone(),
                },
            );
        }
    }

    pub(crate) fn clear(&mut self) {
        self.0.clear();
    }
}

#[derive(Default)]
pub(super) struct IgdbRequests {
    entries: BTreeMap<IgdbRequestKey, IgdbRequestState>,
}

impl IgdbRequests {
    pub(super) fn request(&mut self, key: IgdbRequestKey) -> Result<IgdbRequestState> {
        if let Some(state) = self.entries.get(&key) {
            return Ok(Arc::clone(state));
        }
        if self.entries.len() >= MAX_IGDB_REQUESTS {
            // Never evict an active request: that would admit duplicate retrieval.
            let idle = self
                .entries
                .iter()
                .find_map(|(key, state)| (Arc::strong_count(state) == 1).then(|| key.clone()))
                .ok_or_else(|| PortcoveError::conflict("cover retrieval is busy; retry shortly"))?;
            self.entries.remove(&idle);
        }
        let state = Arc::new(Mutex::new(RemoteArtworkFailures::default()));
        self.entries.insert(key, Arc::clone(&state));
        Ok(state)
    }
}

fn igdb_requests() -> &'static Mutex<IgdbRequests> {
    static REQUESTS: OnceLock<Mutex<IgdbRequests>> = OnceLock::new();
    REQUESTS.get_or_init(|| Mutex::new(IgdbRequests::default()))
}

fn igdb_request_state(key: &IgdbRequestKey) -> Result<IgdbRequestState> {
    igdb_requests()
        .lock()
        .map_err(|_| PortcoveError::state("cover request state is unavailable"))?
        .request(key.clone())
}

/// Opaque generation of a library's disposable artwork cache.
#[derive(Clone, Copy)]
pub struct ArtworkCacheEpoch(Option<uuid::Uuid>);

impl ArtworkCacheEpoch {
    pub fn token(self) -> String {
        self.0
            .map_or_else(|| "initial".into(), |epoch| epoch.to_string())
    }

    fn require_current(self, library: &Library) -> Result<()> {
        if self.0 == igdb_cache::cache_epoch(library)? {
            return Ok(());
        }
        Err(PortcoveError::conflict(
            "the artwork cache was cleared during retrieval",
        ))
    }
}

#[derive(Clone, Copy)]
pub(crate) struct RemoteArtworkRead {
    pub(crate) allow_download: bool,
    pub(crate) epoch: Option<ArtworkCacheEpoch>,
}

impl Default for RemoteArtworkRead {
    fn default() -> Self {
        Self {
            allow_download: true,
            epoch: None,
        }
    }
}

pub(crate) struct RemoteArtworkRequest {
    state: IgdbRequestState,
    epoch: Option<uuid::Uuid>,
}

impl RemoteArtworkRequest {
    pub(crate) fn begin(
        library: &Library,
        source: &str,
        rendition: &str,
        read: RemoteArtworkRead,
    ) -> Result<Self> {
        let identity = library.identity_record()?;
        let epoch = read
            .epoch
            .map_or_else(|| igdb_cache::cache_epoch(library), |epoch| Ok(epoch.0))?;
        let state = igdb_request_state(&(
            identity.root,
            identity.id,
            rendition.into(),
            source.into(),
            epoch,
        ))?;
        Ok(Self { state, epoch })
    }

    pub(crate) fn lock(
        &self,
        allow_download: bool,
    ) -> Result<std::sync::MutexGuard<'_, RemoteArtworkFailures>> {
        let unavailable = || PortcoveError::state("artwork request state is unavailable");
        if allow_download {
            return self.state.lock().map_err(|_| unavailable());
        }
        self.state.try_lock().map_err(|error| match error {
            std::sync::TryLockError::WouldBlock => artwork_cache_miss(),
            std::sync::TryLockError::Poisoned(_) => unavailable(),
        })
    }

    pub(crate) fn require_current(&self, library: &Library) -> Result<()> {
        ArtworkCacheEpoch(self.epoch).require_current(library)
    }
}

pub(crate) fn artwork_cache_miss() -> PortcoveError {
    PortcoveError::not_found("artwork needs to be downloaded").detail(ARTWORK_CACHE_MISS, "true")
}

fn cached_igdb_thumbnail(
    library: &Library,
    artwork: &crate::IgdbArtwork,
    revision: u64,
    derivative: &RemoteDerivative,
    request: &RemoteArtworkRequest,
) -> Result<Option<ArtworkThumbnail>> {
    let path = igdb_original_path(library, artwork)?;
    let started = Instant::now();
    let read = crate::path::read_bounded_regular(&path, crate::artwork_image::MAX_ORIGINAL_BYTES);
    tracing::debug!(
        elapsed_us = started.elapsed().as_micros() as u64,
        input_bytes = read.as_ref().map_or(0, |bytes| bytes.len() as u64),
        success = read.is_ok(),
        message = "Cover original disk lookup"
    );
    if let Ok(original) = read
        && verify_igdb_original(&original, artwork).is_ok()
    {
        let png = if let Some(png) = derivative.read() {
            png
        } else {
            let Ok(decoded) = decode_verified_igdb_original(&original) else {
                return Ok(None);
            };
            if let Ok(_guard) = library.try_lock_artwork() {
                request.require_current(library)?;
                derivative.retain(library, &path, &decoded.thumbnail);
            }
            decoded.thumbnail
        };
        request.require_current(library)?;
        return Ok(Some(ArtworkThumbnail {
            asset_sha256: igdb_cache_id(artwork),
            choice_revision: revision,
            png,
        }));
    }
    Ok(None)
}

pub(crate) fn admit_image_work() -> Result<igdb_cache::WorkPermit<'static>> {
    static WORK: igdb_cache::WorkBudget = igdb_cache::WorkBudget::new();
    WORK.try_acquire()
}

pub(crate) fn admit_cached_image_work() -> Result<igdb_cache::WorkPermit<'static>> {
    static WORK: igdb_cache::WorkBudget = igdb_cache::WorkBudget::new();
    WORK.acquire_until(Duration::from_secs(2))
}

pub(super) fn igdb_thumbnail_with_fetch(
    library: &Library,
    artwork: &crate::IgdbArtwork,
    revision: u64,
    read: RemoteArtworkRead,
    publish: impl FnOnce(&[u8]) -> Result<()>,
    fetch: impl FnOnce() -> std::result::Result<Vec<u8>, IgdbFetchFailure>,
    now: impl Fn() -> Instant,
) -> Result<ArtworkThumbnail> {
    let derivative = RemoteDerivative::new(
        library,
        &artwork.image_sha256,
        &format!(
            "cover:{}x{}",
            crate::artwork_image::THUMBNAIL_WIDTH,
            crate::artwork_image::THUMBNAIL_HEIGHT,
        ),
    )?;
    let request =
        RemoteArtworkRequest::begin(library, &artwork.image_sha256, derivative.key(), read)?;
    let mut retry = request.lock(read.allow_download)?;
    request.require_current(library)?;
    {
        let _permit = admit_cached_image_work()?;
        if let Some(thumbnail) =
            cached_igdb_thumbnail(library, artwork, revision, &derivative, &request)?
        {
            retry.clear();
            return Ok(thumbnail);
        }
    }
    if !read.allow_download {
        return Err(artwork_cache_miss());
    }
    if let Some(failure) = retry.current(&artwork.image_id, now()) {
        return Err(failure);
    }
    let _permit = admit_image_work()?;
    let fetch_started = Instant::now();
    let fetched = fetch();
    tracing::debug!(
        elapsed_us = fetch_started.elapsed().as_micros() as u64,
        input_bytes = fetched.as_ref().map_or(0, |bytes| bytes.len() as u64),
        success = fetched.is_ok(),
        message = "Cover download"
    );
    let original = match fetched {
        Ok(original) => original,
        Err(failure) => {
            if failure.retryable
                && failure.error.code == crate::ErrorCode::Network
                && failure.error.message.len() <= MAX_IGDB_RETRY_MESSAGE
                && failure.error.details.is_empty()
            {
                retry.remember(&artwork.image_id, &failure.error, now());
                return Err(failure.error.detail(ARTWORK_RETRY, "30"));
            }
            return Err(failure.error);
        }
    };
    verify_igdb_original(&original, artwork)?;
    let decoded = decode_verified_igdb_original(&original)?;
    let _guard = library.try_lock_artwork()?;
    request.require_current(library)?;
    publish(&original)?;
    derivative.retain(
        library,
        &igdb_original_path(library, artwork)?,
        &decoded.thumbnail,
    );
    Ok(ArtworkThumbnail {
        asset_sha256: igdb_cache_id(artwork),
        choice_revision: revision,
        png: decoded.thumbnail,
    })
}

pub(super) fn igdb_status_retryable(status: reqwest::StatusCode) -> bool {
    status == reqwest::StatusCode::REQUEST_TIMEOUT
        || status == reqwest::StatusCode::TOO_MANY_REQUESTS
        || status.is_server_error()
}

fn fetch_igdb_original(
    artwork: &crate::IgdbArtwork,
) -> std::result::Result<Vec<u8>, IgdbFetchFailure> {
    let url = format!(
        "https://images.igdb.com/igdb/image/upload/t_cover_big/{}.jpg",
        artwork.image_id
    );
    let response = igdb_http_client()?
        .get(url)
        .send()
        .map_err(|error| IgdbFetchFailure {
            retryable: error.is_timeout() || error.is_connect(),
            error: PortcoveError::network(format!("IGDB image request failed: {error}")),
        })?;
    read_igdb_response(response)
}

pub(crate) fn igdb_http_client()
-> std::result::Result<&'static reqwest::blocking::Client, IgdbFetchFailure> {
    static CLIENT: OnceLock<reqwest::blocking::Client> = OnceLock::new();
    if let Some(client) = CLIENT.get() {
        return Ok(client);
    }
    let client = reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|error| {
            IgdbFetchFailure::other(PortcoveError::network(format!(
                "IGDB image client failed: {error}"
            )))
        })?;
    Ok(CLIENT.get_or_init(|| client))
}

fn read_igdb_response(
    response: reqwest::blocking::Response,
) -> std::result::Result<Vec<u8>, IgdbFetchFailure> {
    if !response.status().is_success() {
        return Err(IgdbFetchFailure {
            retryable: igdb_status_retryable(response.status()),
            error: PortcoveError::network(format!(
                "IGDB cover unavailable (HTTP {}).",
                response.status()
            )),
        });
    }
    if response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_none_or(|value| !value.starts_with("image/jpeg"))
    {
        return Err(IgdbFetchFailure::other(PortcoveError::verification(
            "IGDB cover did not return JPEG content",
        )));
    }
    if response
        .content_length()
        .is_some_and(|length| length > crate::artwork_image::MAX_ORIGINAL_BYTES)
    {
        return Err(IgdbFetchFailure::other(PortcoveError::verification(
            "IGDB cover exceeds the encoded byte limit",
        )));
    }
    let mut original = Vec::new();
    response
        .take(crate::artwork_image::MAX_ORIGINAL_BYTES + 1)
        .read_to_end(&mut original)
        .map_err(|error| IgdbFetchFailure::other(error.into()))?;
    Ok(original)
}

fn decode_verified_igdb_original(original: &[u8]) -> Result<crate::artwork_image::DecodedArtwork> {
    let decoded = crate::artwork_image::decode(original)?;
    if decoded.format != ArtworkImageFormat::Jpeg {
        return Err(PortcoveError::verification(
            "IGDB cover is not a static JPEG",
        ));
    }
    Ok(decoded)
}

fn verify_igdb_original(original: &[u8], artwork: &crate::IgdbArtwork) -> Result<()> {
    let started = Instant::now();
    let valid = original.len() as u64 <= crate::artwork_image::MAX_ORIGINAL_BYTES
        && crate::signed_catalog::digest(original) == artwork.image_sha256;
    tracing::debug!(
        elapsed_us = started.elapsed().as_micros() as u64,
        input_bytes = original.len() as u64,
        success = valid,
        message = "Cover original verification"
    );
    if !valid {
        return Err(PortcoveError::verification(
            "IGDB cover no longer matches its catalog identity",
        ));
    }
    Ok(())
}

fn igdb_original_path(library: &Library, artwork: &crate::IgdbArtwork) -> Result<PathBuf> {
    crate::artwork_store::validate_hash(&artwork.image_sha256)?;
    let path = library
        .root()
        .join("artwork-cache")
        .join(format!("{}.jpg", artwork.image_sha256));
    crate::path::refuse_symlink_ancestors(&path)?;
    Ok(path)
}

impl PortcoveService {
    pub(crate) fn publish_igdb_original(
        &self,
        artwork: &crate::IgdbArtwork,
        original: &[u8],
    ) -> Result<()> {
        self.publish_remote_original(
            &igdb_original_path(self.library(), artwork)?,
            "pending-igdb-original",
            original,
        )
    }
}

fn igdb_cache_id(artwork: &crate::IgdbArtwork) -> String {
    crate::signed_catalog::digest(format!("igdb-cover-big:{}", artwork.image_sha256).as_bytes())
}

fn cache_files(library: &Library) -> Result<Vec<(PathBuf, u64)>> {
    let root = library.root().join("artwork-cache");
    crate::path::refuse_symlink_ancestors(&root)?;
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut files = Vec::new();
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let path = entry.path();
        let stem = path
            .file_stem()
            .and_then(|name| name.to_str())
            .ok_or_else(|| PortcoveError::verification("unexpected artwork cache entry"))?;
        let name = path.file_name().and_then(|name| name.to_str());
        let pending_thumbnail = name == Some("pending-thumbnail");
        let pending_original = matches!(
            name,
            Some("pending-igdb-original" | "pending-catalog-media-original")
        );
        let pending = pending_thumbnail || pending_original;
        if !pending {
            crate::artwork_store::validate_hash(stem)?;
        }
        let metadata = fs::symlink_metadata(&path)?;
        let extension = path.extension().and_then(|extension| extension.to_str());
        if (!pending && !matches!(extension, Some("png" | "jpg" | "image")))
            || !metadata.is_file()
            || metadata.file_type().is_symlink()
            || files.len() >= 4097
        {
            return Err(PortcoveError::verification(
                "artwork cache contains an unexpected entry; it was retained",
            ));
        }
        files.push((path, metadata.len()));
    }
    files.sort_by(|left, right| left.0.cmp(&right.0));
    Ok(files)
}

pub(crate) fn original_path(library: &Library, id: &str) -> Result<PathBuf> {
    crate::artwork_store::validate_hash(id)?;
    let path = library.root().join("artwork").join(id);
    crate::path::refuse_symlink_ancestors(&path)?;
    Ok(path)
}

pub(crate) fn thumbnail_path(library: &Library, id: &str) -> Result<PathBuf> {
    crate::artwork_store::validate_hash(id)?;
    let path = library
        .root()
        .join("artwork-cache")
        .join(format!("{id}.png"));
    crate::path::refuse_symlink_ancestors(&path)?;
    Ok(path)
}

pub(crate) fn original_bytes(library: &Library, asset: &LocalArtworkAsset) -> Result<Vec<u8>> {
    let bytes = crate::path::read_bounded_regular(
        &original_path(library, &asset.sha256)?,
        crate::artwork_image::MAX_ORIGINAL_BYTES,
    )?;
    if bytes.len() as u64 != asset.byte_size
        || crate::signed_catalog::digest(&bytes) != asset.sha256
    {
        return Err(PortcoveError::verification(
            "local artwork no longer matches its retained identity",
        ));
    }
    Ok(bytes)
}

fn ensure_parent(path: &Path) -> Result<()> {
    crate::path::refuse_symlink_ancestors(path)?;
    fs::create_dir_all(
        path.parent()
            .ok_or_else(|| PortcoveError::state("artwork path has no parent"))?,
    )?;
    crate::path::refuse_symlink_ancestors(path)
}
