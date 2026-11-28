//! The broad directory is descriptive. Strict managed definitions retain their
//! original validator and are never synthesized from an incomplete listing.
use super::*;
use crate::acquisition_restriction::RESTRICTION_LISTING_FORMAT;
use crate::catalog_media::IGDB_SCENE_LISTING_FORMAT;
use crate::{CatalogListingDocument, IgdbArtwork, ListingAvailability, Platform, PortListing};
use std::{collections::BTreeMap, sync::LazyLock};

// A `static` keeps one copy of the bytes; a `const` may be duplicated per use.
static EMBEDDED_LISTINGS: &str = include_str!("../../catalog/listings.json");

/// SHA-256 of the listings compiled into this binary and merged into the embedded catalog.
pub(crate) fn embedded_listings_sha256() -> String {
    use sha2::Digest;
    hex::encode(sha2::Sha256::digest(EMBEDDED_LISTINGS.as_bytes()))
}
/// Working-memory bound for listing directory text from outside this binary
/// (`catalog inspect-listings`). Twice the largest decoded directory any
/// supported reader admits, so authoring formatting (1.20x for the committed
/// file) never binds before delivery does. Measured basis: SIGNED-CATALOG.md
/// "Size bounds and older clients". The embedded directory has no byte bound.
pub const MAX_LISTING_DIRECTORY_TEXT_BYTES: usize = 64 * 1024 * 1024;
const _: () = assert!(
    MAX_LISTING_DIRECTORY_TEXT_BYTES == 2 * portcove_listing_carrier::MAX_COMPACT_DECODED_BYTES
);
/// Upper bound on a listing's funding links; GitHub's `FUNDING.yml` allows four custom ones.
const MAX_FUNDING_URLS: usize = 12;
pub(crate) const VERIFIED_EDITION_LISTING_FORMAT: u32 = 14;
pub(crate) const MOD_PORTAL_LISTING_FORMAT: u32 = 16;
pub(crate) const REPOSITORY_BOUND_LISTING_FORMAT: u32 = 17;
pub(crate) const OFFICIAL_SETUP_LISTING_FORMAT: u32 = 18;
pub(crate) const ASSIGNED_COVER_LISTING_FORMAT: u32 = 19;

// Keep the directory extras separate from platforms supplied by its embedded
// managed baseline, so a newer selected definition can withdraw its own set.
static EMBEDDED_MANAGED_PLATFORMS: LazyLock<serde_json::Result<BTreeMap<String, Vec<Platform>>>> =
    LazyLock::new(|| {
        let document: CatalogDocument = serde_json::from_str(EMBEDDED_CATALOG)?;
        Ok(document
            .ports
            .into_iter()
            .map(|port| (port.id, port.platforms))
            .collect())
    });

impl From<&PortDefinition> for PortListing {
    fn from(port: &PortDefinition) -> Self {
        let presentation = port.presentation.as_ref();
        Self {
            id: port.id.clone(),
            compatibility: None,
            upstream_observation: None,
            availability_override_reason: None,
            release_maintenance: None,
            name: port.name.clone(),
            summary: port.summary.clone(),
            project_url: port.project_url.clone(),
            original_game_title: presentation.and_then(|value| value.original_game_title.clone()),
            implementation: presentation.and_then(|value| value.implementation.clone()),
            original_game: presentation.and_then(|value| value.original_game.clone()),
            variant_label: presentation.and_then(|value| value.variant_label.clone()),
            issue_number: None,
            listed_at: None,
            funding_urls: None,
            mod_portals: Vec::new(),
            official_setup_id: None,
            platforms: port.platforms.clone(),
            availability: ListingAvailability::Unknown,
            download_block_reason: None,
            restrictions: Vec::new(),
            download_asset_hints: BTreeMap::new(),
            recommended_download_channel: None,
            release_url: None,
            setup_url: presentation
                .and_then(|value| value.manual_setup.as_ref())
                .and_then(|guide| guide.help_url.clone()),
            manual_setup: presentation.and_then(|value| value.manual_setup.clone()),
            artwork: presentation.and_then(|value| value.artwork.clone()),
            collection_covers: presentation.and_then(|value| value.collection_covers.clone()),
            media: presentation
                .and_then(|value| value.media.clone())
                .unwrap_or_default(),
        }
    }
}

fn has_extended_media(listing: &PortListing) -> bool {
    listing.media.iter().any(|asset| {
        matches!(
            asset.role,
            crate::CatalogMediaRole::Logo | crate::CatalogMediaRole::KeyArt
        ) || asset.edition_neutral.is_some()
            || asset.igdb.is_some()
    }) || listing
        .media
        .iter()
        .filter(|asset| asset.role == crate::CatalogMediaRole::Header)
        .count()
        > 1
}

fn has_typed_igdb_scene(listing: &PortListing) -> bool {
    listing
        .media
        .iter()
        .any(crate::CatalogMediaAsset::is_typed_igdb_scene)
}

fn same_original_edition(left: &crate::SourceEdition, right: &crate::SourceEdition) -> bool {
    left.id == right.id && left.system == right.system && left.title == right.title
}

pub(crate) fn same_original_description(
    left: Option<&crate::OriginalGameIdentity>,
    right: Option<&crate::OriginalGameIdentity>,
) -> bool {
    match (left, right) {
        (Some(left), Some(right)) => {
            left.format_version == right.format_version
                && left.id == right.id
                && left.evidence_urls == right.evidence_urls
                && left.source_editions.len() == right.source_editions.len()
                && left
                    .source_editions
                    .iter()
                    .zip(&right.source_editions)
                    .all(|(left, right)| {
                        same_original_edition(left, right)
                            && left.evidence_urls == right.evidence_urls
                    })
        }
        (None, None) => true,
        _ => false,
    }
}

pub(crate) fn strip_verified_sources(listing: &mut PortListing) {
    if let Some(game) = &mut listing.original_game {
        for edition in &mut game.source_editions {
            edition.verified_sources.clear();
        }
    }
}

pub(crate) fn inherit_verified_sources(
    original: &mut crate::OriginalGameIdentity,
    previous: &crate::OriginalGameIdentity,
) {
    if original.id != previous.id {
        return;
    }
    for edition in &mut original.source_editions {
        if let Some(authored) = previous
            .source_editions
            .iter()
            .find(|candidate| same_original_edition(candidate, edition))
        {
            edition
                .verified_sources
                .clone_from(&authored.verified_sources);
        }
    }
}

fn retain_directory_scenes(port: &PortDefinition, listing: &PortListing) -> bool {
    port.project_url == listing.project_url
        && port
            .presentation
            .as_ref()
            .and_then(|presentation| presentation.media.as_ref())
            .is_none_or(|strict| {
                !strict.is_empty()
                    && listing
                        .media
                        .iter()
                        .filter(|asset| !asset.is_typed_igdb_scene())
                        .eq(strict)
            })
}

pub(crate) fn has_verified_source_editions(listing: &PortListing) -> bool {
    listing.original_game.as_ref().is_some_and(|game| {
        game.source_editions
            .iter()
            .any(|edition| !edition.verified_sources.is_empty())
    })
}

impl CatalogListingDocument {
    /// Format 5 retains every reference paragraph in the original flat guide.
    pub fn export_format(&self, format_version: u32) -> Result<Self> {
        if !matches!(format_version, 5..=ASSIGNED_COVER_LISTING_FORMAT) {
            return Err(PortcoveError::unsupported(
                "listing export supports formats 5 through 19",
            ));
        }
        let mut document = self.clone();
        document.format_version = format_version;
        if format_version < OFFICIAL_SETUP_LISTING_FORMAT {
            for listing in &mut document.listings {
                listing.official_setup_id = None;
            }
        }
        if format_version < MOD_PORTAL_LISTING_FORMAT {
            for listing in &mut document.listings {
                listing.mod_portals.clear();
            }
        }
        if format_version < RESTRICTION_LISTING_FORMAT {
            for listing in &mut document.listings {
                // The validated legacy string remains the older readers' hold.
                listing.restrictions.clear();
            }
        }
        if format_version < VERIFIED_EDITION_LISTING_FORMAT {
            for listing in &mut document.listings {
                strip_verified_sources(listing);
            }
        }
        if format_version < IGDB_SCENE_LISTING_FORMAT {
            for listing in &mut document.listings {
                listing.media.retain(|asset| !asset.is_typed_igdb_scene());
            }
        }
        if format_version < 12 {
            for listing in &mut document.listings {
                listing.implementation = None;
            }
        }
        if format_version < 11 {
            for listing in &mut document.listings {
                listing.collection_covers = None;
            }
        }
        if format_version < 10 {
            for listing in &mut document.listings {
                // Funding links are inert; earlier strict readers never see them.
                listing.funding_urls = None;
            }
        }
        if format_version < 9 {
            for listing in &mut document.listings {
                // The first-listed date is inert; earlier strict readers never see it.
                listing.listed_at = None;
            }
        }
        if format_version < 7 {
            for listing in &mut document.listings {
                // Only inert notices are omitted. Acquisition restrictions stay intact.
                listing.compatibility = None;
            }
        }
        if format_version == 5 {
            for listing in &mut document.listings {
                if let Some(guide) = &mut listing.manual_setup {
                    *guide = guide.legacy();
                }
            }
        }
        document.validate()?;
        Ok(document)
    }

    /// Only already accepted facts may be promoted; raw authored documents keep
    /// their declared version and pass the ordinary version checks unchanged.
    pub(super) fn promote_projected_format(&mut self) {
        if self
            .listings
            .iter()
            .any(|listing| listing.official_setup_id.is_some())
        {
            self.format_version = self.format_version.max(OFFICIAL_SETUP_LISTING_FORMAT);
        }
        if self
            .listings
            .iter()
            .any(|listing| listing.admitted_github_repository_id().is_some())
        {
            self.format_version = self.format_version.max(REPOSITORY_BOUND_LISTING_FORMAT);
        }
        if self
            .listings
            .iter()
            .any(|listing| !listing.mod_portals.is_empty())
        {
            self.format_version = self.format_version.max(MOD_PORTAL_LISTING_FORMAT);
        }
        if self
            .listings
            .iter()
            .any(|listing| !listing.restrictions.is_empty())
        {
            self.format_version = self.format_version.max(RESTRICTION_LISTING_FORMAT);
        }
        if self.format_version >= RESTRICTION_LISTING_FORMAT {
            // Retained or delivered older listings keep their legacy hold as a
            // whole-listing download hold; nothing is narrowed or cleared.
            for listing in &mut self.listings {
                if listing.restrictions.is_empty() {
                    listing.restrictions = crate::acquisition_restriction::normalize_legacy_listing(
                        listing.download_block_reason.as_deref(),
                    );
                }
            }
        }
        if self.listings.iter().any(has_verified_source_editions) {
            self.format_version = self.format_version.max(VERIFIED_EDITION_LISTING_FORMAT);
        }
        if self.listings.iter().any(has_typed_igdb_scene) {
            self.format_version = self.format_version.max(IGDB_SCENE_LISTING_FORMAT);
        }
        if self
            .listings
            .iter()
            .any(|listing| listing.implementation.is_some())
        {
            self.format_version = self.format_version.max(12);
        }
        if self
            .listings
            .iter()
            .any(|listing| listing.collection_covers.is_some())
        {
            self.format_version = self.format_version.max(11);
        }
        if self
            .listings
            .iter()
            .any(|listing| listing.compatibility.is_some())
        {
            self.format_version = self.format_version.max(7);
        }
        if self.format_version == 1
            && self
                .listings
                .iter()
                .any(|listing| listing.download_block_reason.is_some())
        {
            self.format_version = 2;
        }
        if matches!(self.format_version, 1 | 2)
            && self
                .listings
                .iter()
                .any(|listing| listing.original_game.is_some() || !listing.media.is_empty())
        {
            self.format_version = 3;
        }
        if self.format_version < 4 && self.has_observation_fields() {
            self.format_version = 4;
        }
        if self.format_version < 5 && self.listings.iter().any(has_extended_media) {
            self.format_version = 5;
        }
        if self.format_version < 6
            && self.listings.iter().any(|listing| {
                listing
                    .manual_setup
                    .as_ref()
                    .is_some_and(|guide| !guide.references.is_empty())
            })
        {
            self.format_version = 6;
        }
        if self.has_gitlab_observations() {
            self.format_version = self.format_version.max(8);
        }
        if self
            .listings
            .iter()
            .any(|listing| listing.listed_at.is_some())
        {
            self.format_version = self.format_version.max(9);
        }
        if self
            .listings
            .iter()
            .any(|listing| listing.funding_urls.is_some())
        {
            self.format_version = self.format_version.max(10);
        }
    }

    fn has_gitlab_observations(&self) -> bool {
        self.listings.iter().any(|listing| {
            listing
                .upstream_observation
                .as_ref()
                .is_some_and(|observation| observation.provider == "gitlab")
        })
    }

    fn has_observation_fields(&self) -> bool {
        self.listings.iter().any(|listing| {
            listing.upstream_observation.is_some()
                || listing.availability_override_reason.is_some()
                || listing.release_maintenance.is_some()
        })
    }

    /// Parse listing text from outside this binary under its working-memory bound.
    pub fn from_json(content: &str) -> Result<Self> {
        if content.len() > MAX_LISTING_DIRECTORY_TEXT_BYTES {
            return Err(PortcoveError::usage(
                "listing document exceeds its byte limit",
            ));
        }
        Self::from_trusted_text(content)
    }

    /// The directory compiled into this binary is already resident and trusted
    /// with the binary itself, so no byte ceiling applies to it. Strict
    /// duplicate-key parsing and record validation still do.
    fn from_trusted_text(content: &str) -> Result<Self> {
        let _: crate::definition_entry::strict_json::UniqueValue = serde_json::from_str(content)?;
        let document: Self = serde_json::from_str(content)?;
        document.validate()?;
        Ok(document)
    }

    pub fn validate(&self) -> Result<()> {
        self.validate_identity_set()?;
        for listing in &self.listings {
            listing.validate()?;
        }
        Ok(())
    }

    fn validate_identity_set(&self) -> Result<()> {
        if !matches!(self.format_version, 1..=ASSIGNED_COVER_LISTING_FORMAT) {
            return Err(PortcoveError::unsupported(format!(
                "listing format {} is not supported",
                self.format_version
            )));
        }
        if self.format_version < OFFICIAL_SETUP_LISTING_FORMAT
            && self
                .listings
                .iter()
                .any(|listing| listing.official_setup_id.is_some())
        {
            return Err(PortcoveError::unsupported(
                "reviewed official setup links require listing format 18",
            ));
        }
        if self.format_version < REPOSITORY_BOUND_LISTING_FORMAT
            && self
                .listings
                .iter()
                .any(|listing| listing.admitted_github_repository_id().is_some())
        {
            return Err(PortcoveError::unsupported(
                "repository-bound GitHub listings require listing format 17",
            ));
        }
        if self.format_version < MOD_PORTAL_LISTING_FORMAT
            && self
                .listings
                .iter()
                .any(|listing| !listing.mod_portals.is_empty())
        {
            return Err(PortcoveError::unsupported(
                "reviewed mod portals require listing format 16",
            ));
        }
        if self.format_version < RESTRICTION_LISTING_FORMAT
            && self
                .listings
                .iter()
                .any(|listing| !listing.restrictions.is_empty())
        {
            return Err(PortcoveError::unsupported(
                "typed acquisition restrictions require listing format 15",
            ));
        }
        if self.format_version >= RESTRICTION_LISTING_FORMAT
            && self.listings.iter().any(|listing| {
                listing.download_block_reason.as_deref()
                    != crate::acquisition_restriction::legacy_download_projection(
                        &listing.restrictions,
                    )
            })
        {
            return Err(PortcoveError::unsupported(
                "a listing download restriction must equal the projection of its typed restrictions",
            ));
        }
        if self.format_version < VERIFIED_EDITION_LISTING_FORMAT
            && self.listings.iter().any(has_verified_source_editions)
        {
            return Err(PortcoveError::usage(
                "verified source edition bindings require listing format 14",
            ));
        }
        if self.format_version < IGDB_SCENE_LISTING_FORMAT
            && self.listings.iter().any(has_typed_igdb_scene)
        {
            return Err(PortcoveError::unsupported(
                "IGDB backgrounds and screenshots require listing format 13",
            ));
        }
        if self.format_version < 12
            && self
                .listings
                .iter()
                .any(|listing| listing.implementation.is_some())
        {
            return Err(PortcoveError::unsupported(
                "implementation descriptions require listing format 12",
            ));
        }
        if self.format_version < 7
            && self
                .listings
                .iter()
                .any(|listing| listing.compatibility.is_some())
        {
            return Err(PortcoveError::unsupported(
                "optional compatibility advisories require listing format 7",
            ));
        }
        if self.format_version < 8 && self.has_gitlab_observations() {
            return Err(PortcoveError::unsupported(
                "GitLab descriptive observations require listing format 8",
            ));
        }
        if self.format_version < 9
            && self
                .listings
                .iter()
                .any(|listing| listing.listed_at.is_some())
        {
            return Err(PortcoveError::unsupported(
                "the first-listed date requires listing format 9",
            ));
        }
        if self.format_version < 10
            && self
                .listings
                .iter()
                .any(|listing| listing.funding_urls.is_some())
        {
            return Err(PortcoveError::unsupported(
                "funding links require listing format 10",
            ));
        }
        if self.format_version < 11
            && self
                .listings
                .iter()
                .any(|listing| listing.collection_covers.is_some())
        {
            return Err(PortcoveError::unsupported(
                "cover collections require listing format 11",
            ));
        }
        if self.format_version == 1
            && self
                .listings
                .iter()
                .any(|listing| listing.download_block_reason.is_some())
        {
            return Err(PortcoveError::unsupported(
                "listing download restrictions require format 2",
            ));
        }
        if self.format_version < 3
            && self
                .listings
                .iter()
                .any(|listing| listing.original_game.is_some() || !listing.media.is_empty())
        {
            return Err(PortcoveError::unsupported(
                "original game identity and media require listing format 3",
            ));
        }
        if self.format_version < 4 && self.has_observation_fields() {
            return Err(PortcoveError::unsupported(
                "listing observations, overrides and maintenance require format 4",
            ));
        }
        if self.format_version < 5 && self.listings.iter().any(has_extended_media) {
            return Err(PortcoveError::unsupported(
                "game identity media and edition applicability require listing format 5",
            ));
        }
        if self.format_version < 6
            && self.listings.iter().any(|listing| {
                listing
                    .manual_setup
                    .as_ref()
                    .is_some_and(|guide| !guide.references.is_empty())
            })
        {
            return Err(PortcoveError::unsupported(
                "setup references require listing format 6",
            ));
        }
        // No lifetime count: each input path bounds the directory's bytes, and
        // the bundled directory is part of this binary.
        let mut ids = HashSet::new();
        for listing in &self.listings {
            if !ids.insert(&listing.id) {
                return Err(PortcoveError::conflict(format!(
                    "duplicate listing id: {}",
                    listing.id
                )));
            }
        }
        Ok(())
    }
}

/// A real calendar date in exactly `YYYY-MM-DD` form, with no time or offset.
fn valid_listed_at(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return false;
    }
    let digits = |range: std::ops::Range<usize>| -> Option<u32> {
        let slice = &value[range];
        slice
            .bytes()
            .all(|byte| byte.is_ascii_digit())
            .then(|| slice.parse().ok())
            .flatten()
    };
    let (Some(year), Some(month), Some(day)) = (digits(0..4), digits(5..7), digits(8..10)) else {
        return false;
    };
    let Ok(month) = time::Month::try_from(month as u8) else {
        return false;
    };
    time::Date::from_calendar_date(year as i32, month, day as u8).is_ok()
}

fn valid_text(value: &str, limit: usize) -> bool {
    !value.is_empty()
        && value.len() <= limit
        && value.trim() == value
        && !value.chars().any(char::is_control)
}

fn valid_url(value: &str) -> bool {
    valid_text(value, 4096)
        && reqwest::Url::parse(value).is_ok_and(|url| {
            url.scheme() == "https"
                && url.host_str().is_some()
                && url.username().is_empty()
                && url.password().is_none()
        })
}

fn observed_release_link(
    value: &str,
    repository: &str,
    version: &str,
    asset: Option<&str>,
    provider: &str,
    repository_id: Option<u64>,
) -> bool {
    let Ok(url) = reqwest::Url::parse(value) else {
        return false;
    };
    if url.scheme() != "https"
        || url.host_str()
            != Some(if provider == "gitlab" {
                "gitlab.com"
            } else {
                "github.com"
            })
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return false;
    }
    if provider == "gitlab" {
        if let Some(name) = asset {
            let parts = url.path().split('/').skip(1).collect::<Vec<_>>();
            return parts.len() == 9
                && parts[..3] == ["api", "v4", "projects"]
                && repository_id.is_some_and(|id| parts[3] == id.to_string())
                && parts[4..6] == ["packages", "generic"]
                && !parts[6].is_empty()
                && (crate::release::observed_url_segment_matches(parts[7], version)
                    || crate::release::observed_url_segment_matches(
                        parts[7],
                        version.strip_prefix('v').unwrap_or(version),
                    ))
                && crate::release::observed_url_segment_matches(parts[8], name);
        }
        return url
            .path()
            .strip_prefix(&format!("/{repository}/-/releases/"))
            .is_some_and(|tag| {
                !tag.contains('/') && crate::release::observed_url_segment_matches(tag, version)
            });
    }
    let prefix = format!(
        "/{repository}/releases/{}",
        if asset.is_some() { "download/" } else { "tag/" }
    );
    let Some(tail) = url.path().strip_prefix(&prefix) else {
        return false;
    };
    let parts: Vec<_> = tail.split('/').collect();
    parts.len() == if asset.is_some() { 2 } else { 1 }
        && crate::release::observed_url_segment_matches(parts[0], version)
        && asset.is_none_or(|name| crate::release::observed_url_segment_matches(parts[1], name))
}

impl crate::OriginalGameIdentity {
    /// Resolve only exact current observations. This result is descriptive and
    /// never participates in source admission or launch compatibility.
    pub(crate) fn verified_edition(
        &self,
        assessment: &crate::SourceAssessment,
    ) -> Option<&crate::SourceEdition> {
        if assessment.health != crate::SourceHealth::Current {
            return None;
        }
        match (&assessment.classification, &assessment.admission) {
            (
                crate::SourceClassification::Recognized { identity },
                crate::SourceAdmission::Admitted {
                    mode: crate::SourceAdmissionMode::ExactIdentity,
                },
            ) => self.source_editions.iter().find(|edition| {
                edition
                    .verified_sources
                    .iter()
                    .any(|source| source.matches(identity))
            }),
            _ => None,
        }
    }

    pub(crate) fn validate(&self) -> Result<()> {
        fn stable_id(value: &str) -> bool {
            !value.is_empty()
                && value.len() <= 128
                && value.split('-').all(|part| {
                    !part.is_empty()
                        && part
                            .bytes()
                            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
                })
        }
        fn evidence(urls: &[String]) -> bool {
            let mut unique = HashSet::new();
            (1..=8).contains(&urls.len())
                && urls.iter().all(|url| valid_url(url) && unique.insert(url))
        }
        let mut editions = HashSet::new();
        let mut verified_sources = HashSet::new();
        if self.format_version != 1
            || !stable_id(&self.id)
            || !evidence(&self.evidence_urls)
            || self.source_editions.len() > 16
            || self.source_editions.iter().any(|edition| {
                !stable_id(&edition.id)
                    || !editions.insert(&edition.id)
                    || !valid_text(&edition.title, 512)
                    || edition
                        .system
                        .as_ref()
                        .is_some_and(|system| !stable_id(system))
                    || !evidence(&edition.evidence_urls)
                    || edition.verified_sources.len() > 16
                    || edition.verified_sources.iter().any(|identity| {
                        !stable_id(&identity.game_id)
                            || !stable_id(&identity.variant_id)
                            || !stable_id(&identity.representation_id)
                            || !verified_sources.insert((
                                &identity.game_id,
                                &identity.variant_id,
                                &identity.representation_id,
                            ))
                    })
            })
        {
            return Err(PortcoveError::usage(
                "invalid original game or source edition identity",
            ));
        }
        Ok(())
    }
}

impl PortListing {
    /// The discovery admission contract reserves `github-<repository ID>`
    /// for canonical automatic listings.
    pub(crate) fn admitted_github_repository_id(&self) -> Option<u64> {
        portcove_listing_carrier::admitted_github_repository_id(&self.id)
    }

    pub(crate) fn observed_github_repository_id(&self) -> Option<u64> {
        let observed = self.upstream_observation.as_ref()?;
        if observed.provider == "github"
            && observed.observed_at.is_some()
            && crate::release::catalog_download_repository(&self.project_url)
                .is_ok_and(|name| name.eq_ignore_ascii_case(&observed.repository))
        {
            observed.repository_id
        } else {
            None
        }
    }

    pub(crate) fn private_github_project(repository_id: u64, full_name: &str) -> Result<Self> {
        Ok(serde_json::from_value(serde_json::json!({
            "id": format!("github-{repository_id}"),
            "name": full_name,
            "summary": "Public upstream project selected for this library.",
            "project_url": format!("https://github.com/{full_name}"),
        }))?)
    }

    fn private_github_repository_id(&self) -> Option<u64> {
        let id = self.admitted_github_repository_id()?;
        // Older registration envelopes use an exact, generated listing for a
        // personal selection. Ordinary retained catalog listings are different.
        let address = crate::release::catalog_download_repository(&self.project_url).ok()?;
        (Self::private_github_project(id, &address).ok().as_ref() == Some(self)).then_some(id)
    }

    fn validate_observation_metadata(&self) -> Result<()> {
        let invalid = || {
            PortcoveError::usage("invalid descriptive listing observation or maintenance metadata")
        };
        if let Some(reason) = &self.availability_override_reason
            && (!valid_text(reason, 4096) || self.availability == ListingAvailability::Unknown)
        {
            return Err(invalid());
        }
        let clock = |value: &str| {
            time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339)
                .map_err(|_| invalid())
        };
        if let Some(maintenance) = &self.release_maintenance {
            if !valid_text(&maintenance.reason, 4096)
                || !valid_text(&maintenance.reconsider_when, 4096)
                || maintenance.pinned_releases.is_empty()
                || maintenance.pinned_releases.len() > 4
            {
                return Err(invalid());
            }
            let mut platforms = HashSet::new();
            for pin in &maintenance.pinned_releases {
                if !platforms.insert(pin.platform) || !valid_text(&pin.version, 255) {
                    return Err(invalid());
                }
                if let Some(value) = &pin.published_at {
                    clock(value)?;
                }
            }
        }
        let Some(observation) = &self.upstream_observation else {
            return Ok(());
        };
        let source_url = self.release_url.as_deref().unwrap_or(&self.project_url);
        use crate::service::CatalogDownloadRepository;
        let parsed = CatalogDownloadRepository::parse(source_url)?;
        let provider_matches = matches!(
            (&parsed, observation.provider.as_str()),
            (CatalogDownloadRepository::Github(_), "github")
                | (CatalogDownloadRepository::Gitlab(_), "gitlab")
        );
        if !provider_matches {
            return Err(invalid());
        }
        let repository = parsed.name();
        let identity = |id: u64| id > 0 && id <= 9_007_199_254_740_991;
        if !matches!(observation.provider.as_str(), "github" | "gitlab")
            || if observation.provider == "gitlab" {
                observation.repository != repository
            } else {
                !observation.repository.eq_ignore_ascii_case(repository)
            }
            || observation.repository_id.is_some_and(|observed| {
                !identity(observed)
                    || self
                        .admitted_github_repository_id()
                        .is_some_and(|expected| observed != expected)
            })
            || !(1..=4).contains(&observation.release_limit)
            || observation.releases.len() > observation.release_limit
        {
            return Err(invalid());
        }
        let attempted = clock(&observation.attempted_at)?;
        match (
            &observation.observed_at,
            &observation.fresh_until,
            &observation.facts_sha256,
        ) {
            (Some(observed), Some(fresh), Some(hash)) => {
                let observed = clock(observed)?;
                let fresh = clock(fresh)?;
                if observation.repository_id.is_none()
                    || hash.len() != 64
                    || !hash.bytes().all(|byte| byte.is_ascii_hexdigit())
                    || observed > attempted
                    || fresh <= observed
                    || fresh - observed > time::Duration::hours(48)
                {
                    return Err(invalid());
                }
            }
            (None, None, None)
                if observation.status != crate::ListingObservationStatus::Complete
                    && observation.releases.is_empty() => {}
            _ => return Err(invalid()),
        }
        let mut releases = std::collections::BTreeSet::new();
        let mut tags = HashSet::new();
        let mut packages = HashSet::new();
        for release in &observation.releases {
            let valid_identity = match (&release.id, observation.provider.as_str()) {
                (crate::CatalogDownloadReleaseId::Github(id), "github") => identity(*id),
                (
                    crate::CatalogDownloadReleaseId::Foreign(
                        crate::CatalogForeignReleaseId::Gitlab { project_id, tag },
                    ),
                    "gitlab",
                ) => Some(*project_id) == observation.repository_id && tag == &release.version,
                _ => false,
            };
            if !valid_identity
                || !releases.insert(&release.id)
                || !valid_text(&release.version, 255)
                || !tags.insert(&release.version)
                || !valid_url(&release.release_url)
                || !observed_release_link(
                    &release.release_url,
                    &observation.repository,
                    &release.version,
                    None,
                    &observation.provider,
                    observation.repository_id,
                )
                || clock(&release.published_at)? > attempted
                || release.assets.len() > 32
                || (observation.status == crate::ListingObservationStatus::Complete
                    && !release.assets_complete)
            {
                return Err(invalid());
            }
            for package in &release.assets {
                if !identity(package.id)
                    || !packages.insert(package.id)
                    || package.platform_hints.iter().any(|platform| {
                        self.download_asset_hints.get(platform).is_none_or(|hints| {
                            !hints.iter().all(|hint| {
                                package
                                    .name
                                    .to_ascii_lowercase()
                                    .contains(&hint.to_ascii_lowercase())
                            })
                        })
                    })
                    || package.platform_hints.len() > 4
                    || package.platform_hints.iter().collect::<HashSet<_>>().len()
                        != package.platform_hints.len()
                    || !valid_text(&package.name, 255)
                    || package.name.contains(['/', '\\'])
                    || matches!(package.name.as_str(), "." | "..")
                    || package.size > 9_007_199_254_740_991
                    || !valid_url(&package.url)
                    || !observed_release_link(
                        &package.url,
                        &observation.repository,
                        &release.version,
                        Some(&package.name),
                        &observation.provider,
                        observation.repository_id,
                    )
                    || package.sha256.as_ref().is_some_and(|hash| {
                        hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit())
                    })
                {
                    return Err(invalid());
                }
            }
        }
        Ok(())
    }
    pub fn validate(&self) -> Result<()> {
        self.validate_observation_metadata()?;
        crate::mod_source::validate_listing_portals(&self.mod_portals)?;
        if let Some(target) = &self.official_setup_id
            && (target == &self.id
                || target.is_empty()
                || target.len() > 255
                || !target
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
                || self.original_game.is_none())
        {
            return Err(PortcoveError::usage(
                "an official setup link requires a distinct stable ID and an exact original game",
            ));
        }
        if let Some(date) = &self.listed_at
            && !valid_listed_at(date)
        {
            return Err(PortcoveError::usage(
                "the first-listed date must be a real calendar date written YYYY-MM-DD",
            ));
        }
        if let Some(game) = &self.original_game {
            game.validate()?;
        }
        crate::catalog_media::validate_catalog_media(
            &self.id,
            self.original_game.as_ref(),
            &self.media,
        )?;
        if self.id.is_empty()
            || self.id.len() > 128
            || !self
                .id
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
            || !valid_text(&self.name, 512)
            || !valid_text(&self.summary, 4096)
            || !valid_url(&self.project_url)
            || self.issue_number == Some(0)
        {
            return Err(PortcoveError::usage(format!(
                "{} has invalid listing identity or description",
                self.id
            )));
        }
        if self.admitted_github_repository_id().is_some() {
            let project = crate::release::catalog_download_repository(&self.project_url)?;
            if let Some(url) = &self.release_url
                && !crate::release::catalog_download_repository(url)?.eq_ignore_ascii_case(&project)
            {
                return Err(PortcoveError::usage(
                    "repository-bound listing project and release URLs differ",
                ));
            }
        }
        for value in [&self.original_game_title, &self.variant_label]
            .into_iter()
            .flatten()
        {
            if !valid_text(value, 512) {
                return Err(PortcoveError::usage("invalid listing display identity"));
            }
        }
        if self
            .download_block_reason
            .as_ref()
            .is_some_and(|reason| !valid_text(reason, 4096))
        {
            return Err(PortcoveError::usage("invalid listing download restriction"));
        }
        crate::acquisition_restriction::validate(
            &self.restrictions,
            crate::RestrictionCarrier::Listing,
        )?;
        if !self.restrictions.is_empty()
            && self.download_block_reason.as_deref()
                != crate::acquisition_restriction::legacy_download_projection(&self.restrictions)
        {
            return Err(PortcoveError::usage(
                "listing download restriction differs from its typed projection",
            ));
        }
        for url in [&self.release_url, &self.setup_url].into_iter().flatten() {
            if !valid_url(url) {
                return Err(PortcoveError::usage(
                    "listing links must be public HTTPS URLs",
                ));
            }
        }
        if let Some(urls) = &self.funding_urls {
            let mut funding = HashSet::new();
            if urls.is_empty()
                || urls.len() > MAX_FUNDING_URLS
                || urls
                    .iter()
                    .any(|url| !valid_url(url) || !funding.insert(url))
            {
                return Err(PortcoveError::usage(format!(
                    "funding links must be 1 to {MAX_FUNDING_URLS} distinct public HTTPS URLs; omit the field when there are none"
                )));
            }
        }
        for hints in self.download_asset_hints.values() {
            let mut unique = HashSet::new();
            if !(1..=8).contains(&hints.len())
                || hints
                    .iter()
                    .any(|hint| !valid_text(hint, 160) || !unique.insert(hint.to_ascii_lowercase()))
            {
                return Err(PortcoveError::usage("invalid listing download asset hints"));
            }
        }
        if self.recommended_download_channel == Some(ReleaseChannel::Rolling) {
            return Err(PortcoveError::usage(
                "listing download recommendations require stable or beta",
            ));
        }
        let mut platforms = HashSet::new();
        if self
            .platforms
            .iter()
            .any(|platform| !platforms.insert(platform))
        {
            return Err(PortcoveError::usage("duplicate listing platform"));
        }
        if let Some(guide) = &self.manual_setup
            && (!(1..=8).contains(&guide.steps.len())
                || guide.steps.len() + guide.references.len() > 8
                || guide.warnings.len() > 8
                || guide.steps.iter().chain(&guide.references).any(|step| {
                    !valid_text(&step.title, 512) || !valid_text(&step.instruction, 4096)
                })
                || guide
                    .warnings
                    .iter()
                    .any(|warning| !valid_text(warning, 4096))
                || guide.help_url.as_ref().is_some_and(|url| !valid_url(url)))
        {
            return Err(PortcoveError::usage("invalid listing setup guidance"));
        }
        super::validate_cover_collection(
            self.collection_covers.as_deref(),
            self.artwork.is_some(),
        )?;
        for artwork in self
            .artwork
            .iter()
            .chain(self.collection_covers.iter().flatten())
        {
            if artwork.game_id == 0
                || artwork.cover_id == 0
                || artwork.image_id.is_empty()
                || artwork.image_id.len() > 128
                || artwork.image_sha256.len() != 64
                || !artwork
                    .image_sha256
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
                || !artwork
                    .image_id
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
                || artwork.game_slug.is_empty()
                || artwork.game_slug.len() > 512
                || !artwork
                    .game_slug
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
            {
                return Err(PortcoveError::usage("invalid listing artwork mapping"));
            }
        }
        Ok(())
    }
}

impl Catalog {
    pub(crate) fn with_signed_cover_assignments(mut self, signed: &CatalogListingDocument) -> Self {
        self.cover_assignments = Arc::new(
            signed
                .listings
                .iter()
                .filter(|listing| {
                    signed.format_version >= ASSIGNED_COVER_LISTING_FORMAT
                        && listing.artwork.is_none()
                        && listing.collection_covers.is_none()
                })
                .map(|listing| listing.id.clone())
                .collect(),
        );
        self
    }

    /// Signed current-format rows supply their own cover decisions. Legacy
    /// rows can still use a unique exact-edition cover.
    pub(crate) fn automatic_cover<'a>(&'a self, port: &'a PortListing) -> Option<&'a IgdbArtwork> {
        if let Some(cover) = &port.artwork {
            return Some(cover);
        }
        if port.collection_covers.is_some() || self.cover_assignments.contains(&port.id) {
            return None;
        }
        let game = port.original_game.as_ref()?;
        let [edition] = game.source_editions.as_slice() else {
            return None;
        };
        let mut shared = None;
        for candidate in self.listings() {
            let Some((donor, cover)) = candidate
                .original_game
                .as_ref()
                .zip(candidate.artwork.as_ref())
            else {
                continue;
            };
            let [donor_edition] = donor.source_editions.as_slice() else {
                continue;
            };
            if donor.id != game.id
                || donor_edition.id != edition.id
                || donor_edition.system != edition.system
                || cover.match_kind != crate::IgdbArtworkMatch::UnderlyingGame
            {
                continue;
            }
            if shared.is_some_and(|previous| previous != cover) {
                return None;
            }
            shared = Some(cover);
        }
        shared
    }

    /// Export automatic defaults without revealing or applying local choices.
    /// Format 19 exports materialize legacy rows' effective cover assignments.
    pub fn export_listings(&self, format_version: Option<u32>) -> Result<CatalogListingDocument> {
        let mut exported = match format_version {
            Some(format) => self.listing_document().export_format(format)?,
            None => self.listing_document().clone(),
        };
        if exported.format_version >= ASSIGNED_COVER_LISTING_FORMAT {
            for (entry, current) in exported.listings.iter_mut().zip(self.listings()) {
                if entry.artwork.is_none() {
                    entry.artwork = self.automatic_cover(current).cloned();
                }
            }
        }
        Ok(exported)
    }

    pub fn listing_document(&self) -> &CatalogListingDocument {
        &self.listings
    }

    pub fn listings(&self) -> &[PortListing] {
        &self.listings.listings
    }

    pub fn listing(&self, id: &str) -> Result<&PortListing> {
        #[cfg(test)]
        crate::scaling_profile_tests::count_lookup(crate::scaling_profile_tests::Lookup::Listing);
        self.listings
            .position(id)
            .map(|index| &self.listings.listings[index])
            .ok_or_else(|| PortcoveError::not_found(format!("unknown listing id: {id}")))
    }

    /// Loading descriptive facts cannot add or weaken an operational definition.
    pub fn with_listing_document(self, document: CatalogListingDocument) -> Result<Self> {
        document.validate()?;
        self.with_projected_listing_document(document)
    }

    /// Internal projection of already validated authored directory entries and
    /// accepted strict/retained metadata. Historic strict readers allowed display
    /// facts (such as an empty summary) that new authored listings do not; adding
    /// a directory must not retroactively reject those accepted contracts.
    pub(crate) fn with_projected_listing_document(
        mut self,
        mut document: CatalogListingDocument,
    ) -> Result<Self> {
        document.promote_projected_format();
        document.validate_identity_set()?;
        for listing in document
            .listings
            .iter_mut()
            .filter(|listing| has_verified_source_editions(listing))
        {
            if let Ok(port) = self.port(&listing.id) {
                let original = listing
                    .original_game
                    .as_mut()
                    .expect("bindings have an original game");
                let strict = port
                    .presentation
                    .as_ref()
                    .and_then(|presentation| presentation.original_game.as_ref());
                let identities = self
                    .source_catalog()
                    .and_then(|source_catalog| {
                        let contract = source_catalog.contracts.iter().find(|contract| {
                            contract.port_id == port.id
                                && contract.role == crate::PortSourceRole::Game
                                && Some(contract.profile_id.as_str())
                                    == port.source_profile.as_deref()
                        })?;
                        source_catalog.current_source_identities(contract).ok()
                    })
                    .unwrap_or_default();
                for edition in &mut original.source_editions {
                    if port.project_url != listing.project_url
                        || !strict.is_some_and(|game| {
                            game.id == original.id
                                && game
                                    .source_editions
                                    .iter()
                                    .any(|candidate| same_original_edition(candidate, edition))
                        })
                    {
                        edition.verified_sources.clear();
                    } else {
                        edition.verified_sources.retain(|source| {
                            identities.iter().any(|identity| source.matches(identity))
                        });
                    }
                }
            }
        }
        for listing in document
            .listings
            .iter_mut()
            .filter(|listing| has_typed_igdb_scene(listing))
        {
            if let Ok(port) = self.port(&listing.id) {
                let same_authority = retain_directory_scenes(port, listing);
                let original = port
                    .presentation
                    .as_ref()
                    .and_then(|presentation| presentation.original_game.as_ref())
                    .or(listing.original_game.as_ref());
                listing.media.retain(|asset| {
                    !asset.is_typed_igdb_scene()
                        || (same_authority
                            && crate::catalog_media::validate_catalog_media(
                                &port.id,
                                original,
                                std::slice::from_ref(asset),
                            )
                            .is_ok())
                });
            }
        }
        let listed = document
            .listings
            .iter()
            .map(|listing| listing.id.as_str())
            .collect::<HashSet<_>>();
        for port in self.ports() {
            if !listed.contains(port.id.as_str()) {
                return Err(PortcoveError::usage(format!(
                    "listing directory omits operational port {}",
                    port.id
                )));
            }
        }
        self.listings = Arc::new(Indexed::new(document));
        Ok(self)
    }

    pub(crate) fn with_embedded_listings(self) -> Result<Self> {
        // Strict duplicate-key parsing plus validation of the bundled directory
        // is a fixed cost; reuse the validated document and project onto a clone.
        static EMBEDDED_DOCUMENT: LazyLock<Option<CatalogListingDocument>> =
            LazyLock::new(|| CatalogListingDocument::from_trusted_text(EMBEDDED_LISTINGS).ok());
        let mut document = match EMBEDDED_DOCUMENT.as_ref() {
            Some(document) => document.clone(),
            None => CatalogListingDocument::from_trusted_text(EMBEDDED_LISTINGS)?,
        };
        let embedded_managed = EMBEDDED_MANAGED_PLATFORMS
            .as_ref()
            .map_err(|error| PortcoveError::usage(format!("bundled catalog platforms: {error}")))?;
        // Index the first listing per id once instead of scanning per port.
        let mut positions = std::collections::HashMap::with_capacity(document.listings.len());
        for (index, listing) in document.listings.iter().enumerate() {
            positions.entry(listing.id.clone()).or_insert(index);
        }
        for port in self.ports() {
            let projected = PortListing::from(port);
            if let Some(listing) = positions
                .get(&port.id)
                .map(|&index| &mut document.listings[index])
            {
                // Existing signed-catalog presentation corrections must keep
                // reaching their current consumers. Preserve only the directory
                // facts absent from the strict format while projecting its
                // accepted display fields, including artwork, as before.
                let mut original_game = projected
                    .original_game
                    .clone()
                    .or(listing.original_game.clone());
                if let (Some(original), Some(directory)) =
                    (original_game.as_mut(), listing.original_game.as_ref())
                    && listing.project_url == projected.project_url
                    && original.id == directory.id
                    && projected.original_game.is_some()
                {
                    inherit_verified_sources(original, directory);
                }
                let strict_media = port
                    .presentation
                    .as_ref()
                    .and_then(|value| value.media.as_ref());
                // The authored directory owns typed IGDB backgrounds and screenshots.
                // A corrected strict identity or explicit replacement still wins.
                let can_append_typed_media = retain_directory_scenes(port, listing);
                let mut media = strict_media.cloned().unwrap_or_else(|| {
                    // A corrected strict identity cannot inherit another edition's images.
                    listing
                        .media
                        .iter()
                        .filter(|asset| !asset.is_typed_igdb_scene())
                        .filter(|asset| {
                            crate::catalog_media::validate_catalog_media(
                                &port.id,
                                original_game.as_ref(),
                                std::slice::from_ref(*asset),
                            )
                            .is_ok()
                        })
                        .cloned()
                        .collect()
                });
                if can_append_typed_media {
                    media.extend(
                        listing
                            .media
                            .iter()
                            .filter(|asset| {
                                asset.is_typed_igdb_scene()
                                    && crate::catalog_media::validate_catalog_media(
                                        &port.id,
                                        original_game.as_ref(),
                                        std::slice::from_ref(*asset),
                                    )
                                    .is_ok()
                            })
                            .cloned(),
                    );
                }
                let previously_managed = embedded_managed
                    .get(&port.id)
                    .map_or(&[][..], Vec::as_slice);
                let mut platforms = projected.platforms.clone();
                for &platform in &listing.platforms {
                    if !previously_managed.contains(&platform) && !platforms.contains(&platform) {
                        platforms.push(platform);
                    }
                }
                let issue_number = listing.issue_number;
                let availability = listing.availability;
                let download_block_reason = listing.download_block_reason.clone();
                let restrictions = listing.restrictions.clone();
                let download_asset_hints = listing.download_asset_hints.clone();
                let recommended_download_channel = listing.recommended_download_channel;
                let release_url = listing.release_url.clone();
                let setup_url = listing.setup_url.clone().or(projected.setup_url.clone());
                let same_scope = listing.project_url == projected.project_url
                    && same_original_description(
                        listing.original_game.as_ref(),
                        projected.original_game.as_ref(),
                    );
                let implementation = projected
                    .implementation
                    .clone()
                    .or_else(|| same_scope.then(|| listing.implementation.clone()).flatten());
                let mod_portals = if same_scope {
                    std::mem::take(&mut listing.mod_portals)
                } else {
                    Vec::new()
                };
                let official_setup_id = if same_scope {
                    listing.official_setup_id.take()
                } else {
                    None
                };
                *listing = PortListing {
                    implementation,
                    mod_portals,
                    official_setup_id,
                    compatibility: listing.compatibility.clone(),
                    upstream_observation: listing.upstream_observation.clone(),
                    availability_override_reason: listing.availability_override_reason.clone(),
                    release_maintenance: listing.release_maintenance.clone(),
                    original_game,
                    media,
                    issue_number,
                    listed_at: listing.listed_at.clone(),
                    funding_urls: listing.funding_urls.clone(),
                    platforms,
                    availability,
                    download_block_reason,
                    restrictions,
                    download_asset_hints,
                    recommended_download_channel,
                    release_url,
                    setup_url,
                    ..projected
                };
            } else {
                document.listings.push(projected);
            }
        }
        self.with_projected_listing_document(document)
    }

    pub(crate) fn require_personal_project_unlisted(&self, proposed: &PortListing) -> Result<()> {
        let repository_id = proposed.admitted_github_repository_id().ok_or_else(|| {
            PortcoveError::verification("personal registration requires a stable repository ID")
        })?;
        let repository = crate::release::catalog_download_repository(&proposed.project_url)?;
        if self.listings().iter().any(|row| {
            let known_id = row
                .admitted_github_repository_id()
                .or_else(|| row.observed_github_repository_id());
            match known_id {
                Some(known_id) => known_id == repository_id,
                None => crate::release::catalog_download_repository(&row.project_url)
                    .is_ok_and(|name| name.eq_ignore_ascii_case(&repository)),
            }
        }) {
            return Err(PortcoveError::conflict(
                "Portcove already lists this project. Select its catalog entry to use your files.",
            ));
        }
        Ok(())
    }

    pub(crate) fn canonical_for_private_github_listing(
        &self,
        retained: &PortListing,
    ) -> Option<&PortListing> {
        let repository_id = retained.private_github_repository_id()?;
        if self.listing(&retained.id).is_ok() {
            // Same-key admission already resolves directly and needs no association.
            return None;
        }
        let mut matches = self
            .listings()
            .iter()
            .filter(|listing| listing.observed_github_repository_id() == Some(repository_id));
        let candidate = matches.next()?;
        matches.next().is_none().then_some(candidate)
    }

    /// Durable launch intent retains only the descriptive project and an explicit
    /// format fence. No managed capability, source authority or adapter is added.
    pub(crate) fn for_user_selected_listing(listing: PortListing) -> Result<Self> {
        listing.validate()?;
        let mut catalog =
            Self::from_json(r#"{"schema_version":1,"source_profiles":[],"ports":[]}"#)?;
        if has_extended_media(&listing) {
            Arc::make_mut(&mut catalog.listings)
                .make_mut()
                .format_version = 5;
        } else if listing.original_game.is_some() || !listing.media.is_empty() {
            Arc::make_mut(&mut catalog.listings)
                .make_mut()
                .format_version = 3;
        } else if listing.download_block_reason.is_some() {
            Arc::make_mut(&mut catalog.listings)
                .make_mut()
                .format_version = 2;
        }
        Arc::make_mut(&mut catalog.listings)
            .make_mut()
            .listings
            .push(listing);
        Arc::make_mut(&mut catalog.listings)
            .make_mut()
            .promote_projected_format();
        catalog.user_selected_listing = true;
        Ok(catalog)
    }

    pub(crate) fn is_user_selected_listing(&self, port_id: &str) -> bool {
        self.user_selected_listing
            && self.ports().is_empty()
            && self.listings().len() == 1
            && self.listings()[0].id == port_id
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn listing() -> serde_json::Value {
        json!({
            "id":"source-only-project", "name":"Source-only project",
            "summary":"Known project; package and platform availability are unknown.",
            "project_url":"https://example.com/project", "availability":"source-only"
        })
    }

    #[test]
    fn repository_bound_listings_cannot_be_read_or_exported_in_older_formats() {
        let mut admitted = listing();
        admitted["id"] = json!("github-890");
        admitted["project_url"] = json!("https://github.com/example/unknown-port");
        admitted["release_url"] = json!("https://github.com/example/unknown-port/releases");
        let mut directory = json!({
            "format_version": MOD_PORTAL_LISTING_FORMAT,
            "listings": [listing(), admitted],
        });
        assert!(CatalogListingDocument::from_json(&directory.to_string()).is_err());
        directory["format_version"] = json!(REPOSITORY_BOUND_LISTING_FORMAT);
        let accepted = CatalogListingDocument::from_json(&directory.to_string()).unwrap();
        assert_eq!(
            accepted.listings[1].admitted_github_repository_id(),
            Some(890)
        );
        assert!(
            accepted
                .export_format(REPOSITORY_BOUND_LISTING_FORMAT)
                .is_ok()
        );
        assert!(accepted.export_format(MOD_PORTAL_LISTING_FORMAT).is_err());

        directory["listings"][1]["release_url"] =
            json!("https://github.com/elsewhere/unknown-port/releases");
        assert!(CatalogListingDocument::from_json(&directory.to_string()).is_err());
    }

    #[test]
    fn personal_project_uses_verified_repository_id_before_the_address() {
        let proposed: PortListing = serde_json::from_value(json!({
            "id": "github-123",
            "name": "Fixture port",
            "summary": "Public repository selected by the player.",
            "project_url": "https://github.com/example/reused"
        }))
        .unwrap();
        let mut row = proposed.clone();
        row.id = "github-456".into();
        let catalog = Catalog::for_user_selected_listing(row.clone()).unwrap();
        assert!(catalog.require_personal_project_unlisted(&proposed).is_ok());

        row.id = proposed.id.clone();
        row.project_url = "https://github.com/example/moved".into();
        let catalog = Catalog::for_user_selected_listing(row.clone()).unwrap();
        assert!(
            catalog
                .require_personal_project_unlisted(&proposed)
                .is_err()
        );

        row.id = "legacy-port".into();
        row.project_url.clone_from(&proposed.project_url);
        let catalog = Catalog::for_user_selected_listing(row.clone()).unwrap();
        assert!(
            catalog
                .require_personal_project_unlisted(&proposed)
                .is_err()
        );

        row.upstream_observation = Some(crate::ListingUpstreamObservation {
            provider: "github".into(),
            repository: "example/reused".into(),
            repository_id: Some(456),
            status: crate::ListingObservationStatus::Complete,
            attempted_at: "2026-09-15T06:00:00Z".into(),
            observed_at: Some("2026-09-15T06:00:00Z".into()),
            fresh_until: Some("2026-09-15T18:00:00Z".into()),
            facts_sha256: Some("a".repeat(64)),
            release_limit: 4,
            releases: Vec::new(),
        });
        let catalog = Catalog::for_user_selected_listing(row.clone()).unwrap();
        assert!(catalog.require_personal_project_unlisted(&proposed).is_ok());

        row.project_url = "https://github.com/example/moved".into();
        let observed = row.upstream_observation.as_mut().unwrap();
        observed.repository = "example/moved".into();
        observed.repository_id = Some(123);
        let catalog = Catalog::for_user_selected_listing(row).unwrap();
        assert!(
            catalog
                .require_personal_project_unlisted(&proposed)
                .is_err()
        );
    }

    /// The release-tools signer binds an added legacy row to
    /// `portcove_listing_carrier::legacy_row_projection` of the compact row;
    /// preparation binds it to this export. Both must agree on every row.
    fn assert_signer_projection_matches_export(document: &CatalogListingDocument) {
        let current = serde_json::to_value(document).unwrap();
        let legacy = serde_json::to_value(document.export_format(11).unwrap()).unwrap();
        let (current, legacy) = (
            current["listings"].as_array().unwrap(),
            legacy["listings"].as_array().unwrap(),
        );
        assert_eq!(current.len(), legacy.len());
        for (row, exported) in current.iter().zip(legacy) {
            let mut exported = exported.clone();
            exported
                .as_object_mut()
                .unwrap()
                .remove("upstream_observation");
            assert_eq!(
                portcove_listing_carrier::legacy_row_projection(row),
                exported,
                "{}",
                row["id"]
            );
            // A compact row's observation never reaches the legacy row.
            let mut observed = row.clone();
            observed["upstream_observation"] = json!({"provider": "github"});
            assert_eq!(
                portcove_listing_carrier::legacy_row_projection(&observed),
                exported
            );
        }
    }

    #[test]
    fn signer_legacy_row_projection_equals_core_format_eleven_export() {
        let committed =
            CatalogListingDocument::from_json(include_str!("../../catalog/listings.json")).unwrap();
        assert_signer_projection_matches_export(&committed);

        // Fixture rows for every format-12+ fact the export removes, and the
        // omission of a media list that held only typed scenes.
        let reason = "Fresh acquisition remains held for the documented permissions.";
        let scene = json!({
            "id":"igdb-screen","role":"screenshot",
            "subject":{"kind":"port","port_id":"held-with-scenes"},
            "caption":"IGDB shot",
            "url":"https://images.igdb.com/igdb/image/upload/t_720p/fixture.png",
            "sha256":"b".repeat(64),"width":1280,"height":720,
            "attribution":"Fixture author","source_url":"https://www.igdb.com/games/fixture",
            "license":"LicenseRef-IGDB-Terms",
            "rights_url":"https://www.twitch.tv/p/en/legal/developer-agreement/",
            "igdb":{"game_id":11,"record_id":21,"kind":"screenshot","image_id":"fixture","game_slug":"fixture"}
        });
        let shot = json!({
            "id":"legacy","role":"screenshot",
            "subject":{"kind":"port","port_id":"open-with-media"},
            "caption":"Legacy shot",
            "url":format!("https://raw.githubusercontent.com/owner/project/{}/shot.png", "a".repeat(40)),
            "sha256":"a".repeat(64),"width":400,"height":200,
            "attribution":"Fixture author","source_url":"https://example.com/source",
            "license":"CC0-1.0","rights_url":"https://example.com/rights"
        });
        let mut mixed_scene = scene.clone();
        mixed_scene["subject"]["port_id"] = json!("open-with-media");
        let implementation = committed
            .listings
            .iter()
            .find_map(|listing| listing.implementation.clone())
            .unwrap();
        let mut held = listing();
        held["id"] = json!("held-with-scenes");
        held["download_block_reason"] = json!(reason);
        held["restrictions"] = json!([{
            "id":"download","effect":"hold","operations":["download"],
            "reason":"bundled-game-data","explanation":reason,"tracking_issue":1
        }]);
        held["implementation"] = serde_json::to_value(&implementation).unwrap();
        held["media"] = json!([scene]);
        held["original_game"] = json!({
            "format_version": 1,
            "id": "original-game",
            "evidence_urls": ["https://example.com/original"],
            "source_editions": [{
                "id": "retail",
                "title": "Retail edition",
                "evidence_urls": ["https://example.com/retail"],
                "verified_sources": [{
                    "game_id": "original-source",
                    "variant_id": "first-release",
                    "representation_id": "retail-file-set",
                }]
            }, {
                "id": "other",
                "title": "Other edition",
                "evidence_urls": ["https://example.com/other"]
            }]
        });
        let mut open = listing();
        open["id"] = json!("open-with-media");
        open["media"] = json!([shot, mixed_scene]);
        let fixtures = CatalogListingDocument::from_json(
            &json!({"format_version": RESTRICTION_LISTING_FORMAT, "listings": [held, open, listing()]})
                .to_string(),
        )
        .unwrap();
        assert_signer_projection_matches_export(&fixtures);
        let projected = serde_json::to_value(fixtures.export_format(11).unwrap()).unwrap();
        let held = &projected["listings"][0];
        for field in ["restrictions", "implementation", "media"] {
            assert!(held.get(field).is_none(), "{field}");
        }
        assert_eq!(held["download_block_reason"], json!(reason));
        assert!(
            held["original_game"]["source_editions"][0]
                .get("verified_sources")
                .is_none()
        );
        assert_eq!(
            projected["listings"][1]["media"].as_array().unwrap().len(),
            1
        );
    }

    #[test]
    fn verified_original_editions_require_format_fourteen_and_unambiguous_bindings() {
        let mut value = listing();
        let exact = json!({
            "game_id": "original-source",
            "variant_id": "first-release",
            "representation_id": "retail-file-set",
        });
        value["original_game"] = json!({
            "format_version": 1,
            "id": "original-game",
            "evidence_urls": ["https://example.com/original"],
            "source_editions": [
                {
                    "id": "retail",
                    "title": "Retail edition",
                    "evidence_urls": ["https://example.com/retail"],
                    "verified_sources": [exact]
                },
                {
                    "id": "other",
                    "title": "Other edition",
                    "evidence_urls": ["https://example.com/other"]
                }
            ]
        });
        let parse = |value: &serde_json::Value, version: u32| {
            CatalogListingDocument::from_json(
                &json!({"format_version": version, "listings": [value]}).to_string(),
            )
        };
        assert!(parse(&value, 13).is_err());
        let document = parse(&value, 14).unwrap();
        let game = document.listings[0].original_game.as_ref().unwrap();
        let mut assessment = crate::SourceAssessment {
            health: crate::SourceHealth::Current,
            classification: crate::SourceClassification::Recognized {
                identity: serde_json::from_value(exact.clone()).unwrap(),
            },
            admission: crate::SourceAdmission::Admitted {
                mode: crate::SourceAdmissionMode::ExactIdentity,
            },
            contract: crate::SourceContractResult::NotEvaluated,
            evidence: Vec::new(),
        };
        assert_eq!(game.verified_edition(&assessment).unwrap().id, "retail");
        assessment.health = crate::SourceHealth::Changed;
        assert!(game.verified_edition(&assessment).is_none());
        assessment.health = crate::SourceHealth::Current;
        assessment.admission = crate::SourceAdmission::Admitted {
            mode: crate::SourceAdmissionMode::StructuralChecks,
        };
        assert!(game.verified_edition(&assessment).is_none());
        assessment.admission = crate::SourceAdmission::Admitted {
            mode: crate::SourceAdmissionMode::ExactIdentity,
        };
        assessment.classification = crate::SourceClassification::Recognized {
            identity: crate::SourceIdentity {
                game_id: "original-source".into(),
                variant_id: "first-release".into(),
                representation_id: "other-file-set".into(),
            },
        };
        assert!(game.verified_edition(&assessment).is_none());

        let projected = document.export_format(13).unwrap();
        let mut legacy = value.clone();
        legacy["original_game"]["source_editions"][0]
            .as_object_mut()
            .unwrap()
            .remove("verified_sources");
        assert_eq!(projected.listings, parse(&legacy, 13).unwrap().listings);
        value["original_game"]["source_editions"][1]["verified_sources"] = json!([exact]);
        assert!(parse(&value, 14).is_err());
        value["original_game"]["source_editions"][1]["verified_sources"] = json!([]);
        assert!(parse(&value, 14).is_err());
        value["original_game"]["source_editions"][1]
            .as_object_mut()
            .unwrap()
            .remove("verified_sources");
        value["original_game"]["source_editions"][0]["verified_sources"][0]["unknown_qualifier"] =
            json!("unknown");
        assert!(parse(&value, 14).is_err());
    }

    #[test]
    fn collection_covers_require_format_eleven_and_legacy_exports_keep_setup_facts() {
        let parse = |value: &serde_json::Value, version: u32| {
            CatalogListingDocument::from_json(
                &json!({"format_version": version, "listings": [value]}).to_string(),
            )
        };
        let mut value = listing();
        let covers = (1..=2).map(|index| json!({
            "game_id": index, "cover_id": index, "image_id": format!("collection{index}"),
            "game_slug": format!("collection-{index}"), "image_sha256": format!("{index:x}").repeat(64),
            "match_kind": "underlying-game"
        })).collect::<Vec<_>>();
        value["collection_covers"] = json!(covers);
        let document = parse(&value, 11).unwrap();
        for version in 1..=10 {
            assert!(parse(&value, version).is_err());
        }
        for version in 5..=10 {
            let legacy = document.export_format(version).unwrap();
            assert!(legacy.listings[0].collection_covers.is_none());
            assert_eq!(legacy.listings[0].name, document.listings[0].name);
            assert_eq!(
                legacy.listings[0].manual_setup,
                document.listings[0].manual_setup
            );
            assert_eq!(
                legacy.listings[0].availability,
                document.listings[0].availability
            );
            assert_eq!(
                legacy.listings[0].download_block_reason,
                document.listings[0].download_block_reason
            );
        }
        let retained = Catalog::for_user_selected_listing(document.listings[0].clone()).unwrap();
        assert_eq!(retained.listing_document().format_version, 11);
        assert_eq!(
            retained.listings()[0].collection_covers,
            document.listings[0].collection_covers
        );
        for invalid in [
            json!(null),
            json!([]),
            json!(vec![covers[0].clone(); 5]),
            json!([covers[0], covers[0]]),
        ] {
            value["collection_covers"] = invalid;
            assert!(parse(&value, 11).is_err());
        }
        value["collection_covers"] = json!(covers);
        value["artwork"] = covers[0].clone();
        assert!(parse(&value, 11).is_err());
        value.as_object_mut().unwrap().remove("artwork");
        value["collection_covers"] = json!([covers[0]]);
        assert!(
            parse(&value, 11).is_ok(),
            "one surviving member remains valid after withdrawal"
        );
    }

    #[test]
    fn strict_constructor_listing_projection_preserves_versions_and_optional_metadata() {
        let mut strict: serde_json::Value =
            serde_json::from_str(include_str!("../../catalog/catalog-schema1-fixture.json"))
                .unwrap();
        strict["ports"].as_array_mut().unwrap().truncate(1);
        let port_id = strict["ports"][0]["id"].as_str().unwrap().to_owned();
        let legacy = Catalog::from_json(&strict.to_string()).unwrap();
        assert_eq!(legacy.listing_document().format_version, 1);
        let source_profile = legacy.source_profile("ocarina-of-time").unwrap();
        let legacy_bytes = serde_json::to_string(legacy.listing_document()).unwrap();
        let legacy_reread = CatalogListingDocument::from_json(&legacy_bytes).unwrap();
        assert_eq!(serde_json::to_string(&legacy_reread).unwrap(), legacy_bytes);
        let game = json!({
            "format_version": 1, "id": "fixture-game",
            "evidence_urls": ["https://example.com/fixture-game"],
            "source_editions": [{
                "id": "unknown-system-edition", "title": "Reviewed edition",
                "evidence_urls": ["https://example.com/fixture-edition"]
            }]
        });
        let media = json!([{
            "id": "fixture-scene", "role": "screenshot",
            "subject": {"kind": "port", "port_id": port_id},
            "caption": "Synthetic test scene", "sha256": "a".repeat(64),
            "url": format!("https://raw.githubusercontent.com/owner/project/{}/shot.png", "a".repeat(40)),
            "width": 2, "height": 1, "attribution": "Portcove test fixture",
            "source_url": "https://github.com/owner/project", "license": "CC0-1.0",
            "rights_url": "https://github.com/owner/project/blob/main/LICENSE"
        }]);
        for (identity, images, version) in [
            (None, None, 1),
            (Some(game), None, 3),
            (None, Some(media), 3),
        ] {
            let mut input = strict.clone();
            input["ports"][0]["presentation"] = json!({
                "installation_method": "portable-package",
                "source_requirements": [{
                    "role": "game", "profile_id": source_profile.id,
                    "label": source_profile.label, "verification": "catalog-identity"
                }],
                "saves_and_settings": "portcove-managed"
            });
            if let Some(game) = identity.as_ref() {
                input["ports"][0]["presentation"]["original_game"] = game.clone();
            }
            if let Some(media) = images.as_ref() {
                input["ports"][0]["presentation"]["media"] = media.clone();
            }
            let catalog = Catalog::from_json(&input.to_string()).unwrap();
            let projected = serde_json::to_value(catalog.listing_document()).unwrap();
            assert_eq!(projected["format_version"], version);
            assert_eq!(
                projected["listings"][0].get("original_game"),
                identity.as_ref()
            );
            assert_eq!(projected["listings"][0].get("media"), images.as_ref());
            let reread = CatalogListingDocument::from_json(&projected.to_string()).unwrap();
            assert_eq!(serde_json::to_value(&reread).unwrap(), projected);
            let restored = catalog.clone().with_listing_document(reread).unwrap();
            assert_eq!(
                serde_json::to_value(restored.port(&port_id).unwrap()).unwrap(),
                serde_json::to_value(catalog.port(&port_id).unwrap()).unwrap()
            );
            assert_eq!(
                serde_json::to_value(restored.listing_document()).unwrap(),
                projected
            );
            if version == 1 {
                // A newer explicit directory remains that version even when
                // optional descriptive metadata is genuinely not specified.
                for declared in [1, 2, 3] {
                    let mut authored = projected.clone();
                    authored["format_version"] = json!(declared);
                    let directory =
                        CatalogListingDocument::from_json(&authored.to_string()).unwrap();
                    let accepted = catalog.clone().with_listing_document(directory).unwrap();
                    assert_eq!(accepted.listing_document().format_version, declared);
                }
            } else {
                for declared in [1, 2] {
                    let mut incompatible = projected.clone();
                    incompatible["format_version"] = json!(declared);
                    assert!(CatalogListingDocument::from_json(&incompatible.to_string()).is_err());
                }
            }
        }
    }

    #[test]
    fn original_game_identity_requires_versioned_descriptive_provenance() {
        let game = json!({
            "format_version": 1, "id": "example-game", "evidence_urls": ["https://example.com/game"],
            "source_editions": [
                {"id":"console-edition", "title":"Console edition", "system":"nintendo-64", "evidence_urls":["https://example.com/console"]},
                {"id":"other-edition", "title":"Other edition", "evidence_urls":["https://example.com/other"]}
            ]
        });
        let mut value = listing();
        value["original_game"] = game.clone();
        let document = CatalogListingDocument::from_json(
            &json!({"format_version":3,"listings":[value.clone()]}).to_string(),
        )
        .unwrap();
        assert_eq!(
            document.listings[0]
                .original_game
                .as_ref()
                .unwrap()
                .source_editions
                .len(),
            2
        );
        let catalog = Catalog::from_json(r#"{"schema_version":1,"ports":[]}"#)
            .unwrap()
            .with_listing_document(document)
            .unwrap();
        assert!(catalog.ports().is_empty());
        assert_eq!(
            serde_json::to_value(catalog.listing_document()).unwrap()["listings"][0]["original_game"],
            game
        );
        let retained = Catalog::for_user_selected_listing(catalog.listings()[0].clone()).unwrap();
        assert_eq!(retained.listing_document().format_version, 3);
        assert!(retained.ports().is_empty());
        for version in [1, 2] {
            assert!(
                CatalogListingDocument::from_json(
                    &json!({"format_version":version,"listings":[value.clone()]}).to_string()
                )
                .is_err()
            );
        }
        for (field, invalid) in [
            ("format_version", json!(2)),
            ("id", json!("title has spaces")),
            ("evidence_urls", json!([])),
            ("evidence_urls", json!(["http://example.com/unsafe"])),
        ] {
            let mut invalid_game = game.clone();
            invalid_game[field] = invalid;
            let mut invalid_listing = listing();
            invalid_listing["original_game"] = invalid_game;
            assert!(
                CatalogListingDocument::from_json(
                    &json!({"format_version":3,"listings":[invalid_listing]}).to_string()
                )
                .is_err()
            );
        }
        let legacy = CatalogListingDocument::from_json(
            &json!({"format_version":1,"listings":[listing()]}).to_string(),
        )
        .unwrap();
        assert!(legacy.listings[0].original_game.is_none());
    }

    #[test]
    fn incomplete_projects_are_inert_and_round_trip_without_operational_facts() {
        let document = CatalogListingDocument::from_json(
            &json!({"format_version":1,"listings":[listing()]}).to_string(),
        )
        .unwrap();
        assert!(document.listings[0].platforms.is_empty());
        let catalog = Catalog::from_json(r#"{"schema_version":1,"ports":[]}"#)
            .unwrap()
            .with_listing_document(document)
            .unwrap();
        assert!(catalog.port("source-only-project").is_err());
        assert_eq!(catalog.listings().len(), 1);
        assert!(
            serde_json::to_value(catalog.listing_document()).unwrap()["listings"][0]
                .get("adapter")
                .is_none()
        );
    }

    #[test]
    fn advisory_download_hints_are_bounded_and_do_not_create_a_managed_port() {
        let mut hinted = listing();
        hinted["download_asset_hints"] = json!({"windows-x86-64":["-Windows_Installer.exe"]});
        hinted["recommended_download_channel"] = json!("beta");
        let document = CatalogListingDocument::from_json(
            &json!({"format_version":1,"listings":[hinted.clone()]}).to_string(),
        )
        .unwrap();
        let catalog = Catalog::from_json(r#"{"schema_version":1,"ports":[]}"#)
            .unwrap()
            .with_listing_document(document)
            .unwrap();
        assert!(catalog.port("source-only-project").is_err());
        assert_eq!(
            catalog
                .listing("source-only-project")
                .unwrap()
                .recommended_download_channel,
            Some(ReleaseChannel::Beta)
        );
        assert_eq!(
            catalog
                .listing("source-only-project")
                .unwrap()
                .download_asset_hints[&crate::Platform::WindowsX86_64],
            ["-Windows_Installer.exe"]
        );
        for invalid_channel in ["rolling", "nightly"] {
            let mut invalid = hinted.clone();
            invalid["recommended_download_channel"] = json!(invalid_channel);
            assert!(
                CatalogListingDocument::from_json(
                    &json!({"format_version":1,"listings":[invalid]}).to_string()
                )
                .is_err()
            );
        }
        for invalid in [
            json!({"other-os":["game.zip"]}),
            json!({"windows-x86-64":[]}),
            json!({"windows-x86-64":["game", "GAME"]}),
            json!({"windows-x86-64":[" bad "]}),
            json!({"windows-x86-64":["bad\nname"]}),
            json!({"windows-x86-64":["x".repeat(161)]}),
            json!({"windows-x86-64":vec!["a";9]}),
        ] {
            hinted["download_asset_hints"] = invalid;
            assert!(
                CatalogListingDocument::from_json(
                    &json!({"format_version":1,"listings":[hinted.clone()]}).to_string()
                )
                .is_err()
            );
        }
    }

    #[test]
    fn cloned_catalog_keeps_listing_changes_and_owned_documents_independent() {
        let original =
            Catalog::for_user_selected_listing(serde_json::from_value(listing()).unwrap()).unwrap();
        let retained = original.clone();
        let mut listings = original.listing_document().clone();
        listings.listings[0].name = "Changed display name".into();
        let changed = original.with_listing_document(listings).unwrap();
        assert_eq!(retained.listings()[0].name, "Source-only project");
        assert_eq!(changed.listings()[0].name, "Changed display name");
        assert!(retained.is_user_selected_listing("source-only-project"));
        assert!(changed.is_user_selected_listing("source-only-project"));
        let mut owned = retained.authoritative_document();
        owned.schema_version = 99;
        assert_eq!(retained.document().schema_version, 1);
        assert_eq!(changed.document().schema_version, 1);
        assert!(Catalog::from_json(&serde_json::to_string(&owned).unwrap()).is_err());
    }

    #[test]
    fn listing_reader_refuses_unknown_semantics_duplicates_and_unsafe_links() {
        let mut unsafe_listing = listing();
        unsafe_listing["project_url"] = json!("file:///tmp/game");
        let mut operational_listing = listing();
        operational_listing["launch_arguments"] = json!(["--run-script"]);
        for document in [
            json!({"format_version":ASSIGNED_COVER_LISTING_FORMAT + 1,"listings":[listing()]}),
            json!({"format_version":1,"listings":[listing(),listing()]}),
            json!({"format_version":1,"listings":[unsafe_listing]}),
            json!({"format_version":1,"listings":[operational_listing]}),
        ] {
            assert!(CatalogListingDocument::from_json(&document.to_string()).is_err());
        }
    }

    #[test]
    fn official_setup_link_requires_format_and_keeps_external_listing_identity() {
        let catalog = Catalog::embedded().unwrap();
        let mut listing = catalog
            .listing("chameleon-twist-recompiled")
            .unwrap()
            .clone();
        let before = listing.clone();
        let target = "chameleon-twist-jp-recompiled";
        listing.official_setup_id = Some(target.into());
        let document = CatalogListingDocument {
            format_version: OFFICIAL_SETUP_LISTING_FORMAT,
            listings: vec![listing],
        };
        document.validate().unwrap();
        let legacy = document.export_format(17).unwrap();
        assert_eq!(legacy.listings, vec![before]);
        assert_eq!(
            portcove_listing_carrier::legacy_row_projection(
                &serde_json::to_value(&document.listings[0]).unwrap()
            ),
            serde_json::to_value(&document.export_format(11).unwrap().listings[0]).unwrap()
        );
        let mut invalid = document.clone();
        invalid.format_version = 17;
        assert!(invalid.validate().is_err());
        invalid.format_version = OFFICIAL_SETUP_LISTING_FORMAT;
        for target in [
            Some("official/chameleon-twist-jp-recompiled"),
            Some("chameleon-twist-recompiled"),
            Some(""),
        ] {
            invalid.listings[0].official_setup_id = target.map(str::to_owned);
            assert!(invalid.validate().is_err());
        }
        invalid.listings[0].official_setup_id = Some(target.into());
        invalid.listings[0].original_game = None;
        assert!(invalid.validate().is_err());
    }

    #[test]
    fn download_restrictions_require_their_format_and_never_grant_an_operation() {
        let mut restricted = listing();
        restricted["download_block_reason"] = json!("Upstream component permission needs review.");
        assert!(
            CatalogListingDocument::from_json(
                &json!({"format_version":1,"listings":[restricted.clone()]}).to_string()
            )
            .is_err()
        );
        let document = CatalogListingDocument::from_json(
            &json!({"format_version":2,"listings":[restricted.clone()]}).to_string(),
        )
        .unwrap();
        let retained = Catalog::for_user_selected_listing(document.listings[0].clone()).unwrap();
        assert_eq!(retained.listing_document().format_version, 2);
        assert!(retained.port("source-only-project").is_err());
        CatalogListingDocument::from_json(
            &serde_json::to_string(retained.listing_document()).unwrap(),
        )
        .unwrap();
        for reason in [
            json!(""),
            json!(" trailing "),
            json!("line\nbreak"),
            json!("x".repeat(4097)),
            json!({"allowed":true}),
        ] {
            restricted["download_block_reason"] = reason;
            assert!(
                CatalogListingDocument::from_json(
                    &json!({"format_version":2,"listings":[restricted.clone()]}).to_string()
                )
                .is_err()
            );
        }
        assert!(
            CatalogListingDocument::from_json(
                &json!({"format_version":2,"listings":[listing()]}).to_string()
            )
            .unwrap()
            .listings[0]
                .download_block_reason
                .is_none()
        );
    }

    #[test]
    fn bundled_package_platforms_remain_separate_from_selected_managed_platforms() {
        use Platform::{LinuxX86_64, MacosAarch64, MacosX86_64, WindowsX86_64};
        let id = "body-harvest-recompiled";
        let catalog = Catalog::embedded().unwrap();
        assert_eq!(
            catalog.port(id).unwrap().platforms,
            [WindowsX86_64, LinuxX86_64]
        );
        assert_eq!(
            catalog.listing(id).unwrap().platforms,
            [WindowsX86_64, LinuxX86_64, MacosX86_64, MacosAarch64]
        );
        let mut accepted = catalog.authoritative_document();
        let port = accepted
            .ports
            .iter_mut()
            .find(|port| port.id == id)
            .unwrap();
        port.platforms = vec![LinuxX86_64];
        port.release.asset_hints.remove(&WindowsX86_64);
        port.executable_hints.remove(&WindowsX86_64);
        let selected = Catalog::from_document(accepted)
            .unwrap()
            .with_embedded_listings()
            .unwrap();
        assert_eq!(selected.port(id).unwrap().platforms, [LinuxX86_64]);
        assert_eq!(
            selected.listing(id).unwrap().platforms,
            [LinuxX86_64, MacosX86_64, MacosAarch64]
        );
    }

    #[test]
    fn bundled_directory_does_not_erase_accepted_operational_presentation_corrections() {
        let mut document = Catalog::embedded().unwrap().authoritative_document();
        let port = document
            .ports
            .iter_mut()
            .find(|port| port.id == "shipwright")
            .unwrap();
        port.summary = "Accepted presentation correction.".into();
        port.presentation.as_mut().unwrap().artwork = None;
        let catalog = Catalog::from_json(&serde_json::to_string(&document).unwrap())
            .unwrap()
            .with_embedded_listings()
            .unwrap();
        let listing = catalog.listing("shipwright").unwrap();
        assert_eq!(listing.summary, "Accepted presentation correction.");
        assert!(listing.artwork.is_none());
        assert!(catalog.listings().len() >= catalog.ports().len());

        let baseline = Catalog::embedded().unwrap();
        let original = baseline.listing("zelda64-recomp").unwrap();
        assert!(original.implementation.is_some());
        for case in [
            "explicit",
            "same-scope",
            "project",
            "game",
            "edition",
            "missing-identity",
        ] {
            let mut document = baseline.authoritative_document();
            let port = document
                .ports
                .iter_mut()
                .find(|port| port.id == original.id)
                .unwrap();
            let presentation = port.presentation.as_mut().unwrap();
            presentation.implementation = None;
            let expected = match case {
                "explicit" => {
                    let mut corrected = original.implementation.clone().unwrap();
                    corrected["methods"][0]["kind"] = json!("source-port");
                    corrected["dependencies"][0]["version_scope"] = json!("accepted correction");
                    presentation.implementation = Some(corrected.clone());
                    Some(corrected)
                }
                "same-scope" => original.implementation.clone(),
                "project" => {
                    port.project_url = "https://example.invalid/corrected-project".into();
                    None
                }
                "game" => {
                    presentation.original_game.as_mut().unwrap().id = "corrected-game".into();
                    None
                }
                "edition" => {
                    presentation.original_game.as_mut().unwrap().source_editions[0].id =
                        "corrected-edition".into();
                    None
                }
                "missing-identity" => {
                    presentation.original_game = None;
                    None
                }
                _ => unreachable!(),
            };
            let projected = Catalog::from_json(&serde_json::to_string(&document).unwrap())
                .unwrap()
                .with_embedded_listings()
                .unwrap();
            assert_eq!(
                projected.listing("zelda64-recomp").unwrap().implementation,
                expected,
                "{case}"
            );
            let exported = projected.listing_document().export_format(12).unwrap();
            assert_eq!(
                exported
                    .listings
                    .iter()
                    .find(|row| row.id == original.id)
                    .unwrap()
                    .implementation,
                expected,
                "{case}"
            );
            assert_eq!(
                serde_json::to_value(projected.authoritative_document()).unwrap(),
                serde_json::to_value(document).unwrap(),
                "{case}"
            );
        }
    }

    #[test]
    fn extended_media_fences_strict_older_listing_readers() {
        let mut value = listing();
        value["media"] = json!([{
            "id":"reviewed-header", "role":"header",
            "subject":{"kind":"port","port_id":value["id"]},
            "caption":"Reviewed landscape", "url":format!("https://raw.githubusercontent.com/owner/project/{}/header.png", "a".repeat(40)),
            "sha256":"a".repeat(64),"width":400,"height":200,
            "attribution":"Fixture author","source_url":"https://example.com/source",
            "license":"CC0-1.0","rights_url":"https://example.com/rights",
            "edition_neutral":false
        }]);
        assert!(
            CatalogListingDocument::from_json(
                &json!({"format_version":3,"listings":[value.clone()]}).to_string()
            )
            .is_err()
        );
        assert!(
            CatalogListingDocument::from_json(
                &json!({"format_version":5,"listings":[value.clone()]}).to_string()
            )
            .is_ok()
        );
        value["media"][0]
            .as_object_mut()
            .unwrap()
            .remove("edition_neutral");
        assert!(
            CatalogListingDocument::from_json(
                &json!({"format_version":3,"listings":[value]}).to_string()
            )
            .is_ok()
        );
        for version in 1..=5 {
            assert!(
                CatalogListingDocument::from_json(
                    &json!({"format_version":version,"listings":[]}).to_string()
                )
                .is_ok()
            );
        }
    }

    #[test]
    fn legacy_media_absence_and_reviewed_empty_media_remain_distinct() {
        let catalog = Catalog::embedded().unwrap();
        let mut port = catalog.port("beetle-recomp").unwrap().clone();
        assert!(port.presentation.as_ref().unwrap().media.is_none());
        assert!(
            serde_json::to_value(&port).unwrap()["presentation"]
                .get("media")
                .is_none()
        );
        port.presentation.as_mut().unwrap().media = Some(vec![]);
        let serialized = serde_json::to_value(&port).unwrap();
        assert_eq!(serialized["presentation"]["media"], json!([]));
        let restored: PortDefinition = serde_json::from_value(serialized).unwrap();
        assert_eq!(restored.presentation.as_ref().unwrap().media, Some(vec![]));
        assert!(PortListing::from(&restored).media.is_empty());
    }

    #[test]
    fn listing_format_13_preserves_typed_scenes_and_legacy_exports_omit_only_them() {
        let mut row = listing();
        row["media"] = json!([{
            "id":"legacy","role":"screenshot",
            "subject":{"kind":"port","port_id":row["id"]},
            "caption":"Legacy shot",
            "url":format!("https://raw.githubusercontent.com/owner/project/{}/shot.png", "a".repeat(40)),
            "sha256":"a".repeat(64),"width":400,"height":200,
            "attribution":"Fixture author","source_url":"https://example.com/source",
            "license":"CC0-1.0","rights_url":"https://example.com/rights"
        },{
            "id":"igdb-screen","role":"screenshot",
            "subject":{"kind":"port","port_id":row["id"]},
            "caption":"IGDB shot",
            "url":"https://images.igdb.com/igdb/image/upload/t_720p/fixture.png",
            "sha256":"b".repeat(64),"width":1280,"height":720,
            "attribution":"Fixture author","source_url":"https://www.igdb.com/games/fixture",
            "license":"LicenseRef-IGDB-Terms","rights_url":"https://www.twitch.tv/p/en/legal/developer-agreement/",
            "igdb":{"game_id":11,"record_id":21,"kind":"screenshot","image_id":"fixture","game_slug":"fixture"}
        }]);
        let raw =
            |version| json!({"format_version": version, "listings": [row.clone()]}).to_string();
        assert!(CatalogListingDocument::from_json(&raw(12)).is_err());
        let current = CatalogListingDocument::from_json(&raw(13)).unwrap();
        for version in 5..13 {
            let older = current.export_format(version).unwrap();
            assert_eq!(older.listings[0].media, current.listings[0].media[..1]);
        }
        assert_eq!(
            current.export_format(13).unwrap().listings[0].media,
            current.listings[0].media
        );
        let embedded = Catalog::embedded().unwrap();
        let mut authored = embedded.authoritative_document();
        let mut directory = embedded.listing_document().clone();
        directory.format_version = directory.format_version.max(13);
        let port = authored
            .ports
            .iter_mut()
            .find(|port| port.id == "beetle-recomp")
            .unwrap();
        let listed = directory
            .listings
            .iter_mut()
            .find(|listing| listing.id == port.id)
            .unwrap();
        listed.project_url = port.project_url.clone();
        listed.media = current.listings[0].media.clone();
        for asset in &mut listed.media {
            asset.subject = crate::CatalogMediaSubject::Port {
                port_id: port.id.clone(),
            };
        }
        let scene = listed.media[1].clone();
        let strict_media = port.presentation.as_mut().unwrap();
        strict_media.media = Some(vec![listed.media[0].clone()]);
        let matched = Catalog::from_document(authored.clone())
            .unwrap()
            .with_listing_document(directory.clone())
            .unwrap();
        assert!(
            matched
                .listing("beetle-recomp")
                .unwrap()
                .media
                .contains(&scene)
        );
        let port = authored
            .ports
            .iter_mut()
            .find(|port| port.id == "beetle-recomp")
            .unwrap();
        port.presentation.as_mut().unwrap().media = Some(vec![]);
        let cleared = Catalog::from_document(authored)
            .unwrap()
            .with_listing_document(directory)
            .unwrap();
        assert!(
            !cleared
                .listing("beetle-recomp")
                .unwrap()
                .media
                .contains(&scene)
        );
    }

    #[test]
    fn old_accepted_ports_retain_reviewed_directory_game_identity() {
        let mut document = Catalog::embedded().unwrap().authoritative_document();
        document
            .ports
            .iter_mut()
            .find(|port| port.id == "beetle-recomp")
            .unwrap()
            .presentation
            .as_mut()
            .unwrap()
            .original_game = None;
        let accepted = Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap();
        let projected = accepted.with_embedded_listings().unwrap();
        assert!(
            projected
                .port("beetle-recomp")
                .unwrap()
                .presentation
                .as_ref()
                .unwrap()
                .original_game
                .is_none()
        );
        assert_eq!(
            projected
                .listing("beetle-recomp")
                .unwrap()
                .original_game
                .as_ref()
                .unwrap()
                .id,
            "beetle-adventure-racing"
        );
        let embedded = CatalogListingDocument::from_json(EMBEDDED_LISTINGS).unwrap();
        assert_eq!(
            projected.listing_document().format_version,
            embedded.format_version
        );
    }

    #[test]
    fn accepted_legacy_presentation_is_not_revalidated_as_new_listing_authority() {
        let mut document = Catalog::embedded().unwrap().authoritative_document();
        document
            .ports
            .iter_mut()
            .find(|port| port.id == "shipwright")
            .unwrap()
            .summary
            .clear();
        let accepted = Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap();
        let projected = accepted.with_embedded_listings().unwrap();
        assert!(projected.port("shipwright").unwrap().summary.is_empty());
        assert!(projected.listing("shipwright").unwrap().summary.is_empty());
        let authored = CatalogListingDocument {
            format_version: 1,
            listings: vec![projected.listing("shipwright").unwrap().clone()],
        };
        assert!(
            CatalogListingDocument::from_json(&serde_json::to_string(&authored).unwrap()).is_err()
        );
    }
}

#[cfg(test)]
mod observation_metadata_tests {
    use super::*;
    use serde_json::{Value, json};

    pub(crate) fn observation() -> Value {
        json!({"provider":"github","repository":"example/game","repository_id":7,
            "status":"complete","attempted_at":"2026-10-27T00:01:00Z",
            "observed_at":"2026-10-27T00:00:00Z","fresh_until":"2026-10-27T12:00:00Z",
            "facts_sha256":"a".repeat(64),"release_limit":4,
            "releases":[{"id":11,"version":"v1.2.0","release_url":"https://github.com/example/game/releases/tag/v1.2.0",
                "published_at":"2026-10-26T00:00:00Z","provider_prerelease":false,"assets_complete":true,
                "assets":[{"id":21,"name":"game-windows-x64.zip","url":"https://github.com/example/game/releases/download/v1.2.0/game-windows-x64.zip","size":42,"sha256":null,"platform_hints":["windows-x86-64"]}]}]})
    }
    fn listing() -> Value {
        json!({"id":"observed-project","name":"Observed project","summary":"Descriptive facts only.",
            "project_url":"https://github.com/example/game","availability":"unknown",
            "download_asset_hints":{"windows-x86-64":["windows","x64"]},"upstream_observation":observation()})
    }
    fn parse(value: &Value, format: u32) -> Result<CatalogListingDocument> {
        CatalogListingDocument::from_json(
            &json!({"format_version":format,"listings":[value]}).to_string(),
        )
    }

    #[test]
    fn repository_bound_listing_observations_reject_reused_github_paths() {
        let mut value = listing();
        value["id"] = json!("github-7");
        assert!(parse(&value, REPOSITORY_BOUND_LISTING_FORMAT).is_ok());

        value["upstream_observation"]["repository_id"] = json!(8);
        assert!(parse(&value, REPOSITORY_BOUND_LISTING_FORMAT).is_err());

        value["id"] = json!("observed-project");
        assert!(parse(&value, REPOSITORY_BOUND_LISTING_FORMAT).is_ok());
    }

    #[test]
    fn descriptive_observation_has_an_explicit_format_fence_and_retains_no_managed_authority() {
        let value = listing();
        for format in [1, 2, 3] {
            assert!(parse(&value, format).is_err());
        }
        let document = parse(&value, 4).unwrap();
        let catalog = Catalog::for_user_selected_listing(document.listings[0].clone()).unwrap();
        assert_eq!(catalog.listing_document().format_version, 4);
        assert_eq!(
            catalog.listings()[0]
                .upstream_observation
                .as_ref()
                .unwrap()
                .repository_id,
            Some(7)
        );
        assert!(catalog.port("observed-project").is_err());
        let retained =
            Catalog::from_json(&serde_json::to_string(&catalog.authoritative_document()).unwrap())
                .unwrap();
        assert!(retained.port("observed-project").is_err());
    }
    #[test]
    fn descriptive_observation_refuses_ambiguous_identity_foreign_links_and_false_completeness() {
        for change in [
            "duplicate-release",
            "duplicate-asset",
            "foreign-url",
            "wrong-tag",
            "future-clock",
            "incomplete",
            "false-platform",
        ] {
            let mut value = listing();
            match change {
                "duplicate-release" => {
                    let row = value["upstream_observation"]["releases"][0].clone();
                    value["upstream_observation"]["releases"]
                        .as_array_mut()
                        .unwrap()
                        .push(row);
                }
                "duplicate-asset" => {
                    let asset = value["upstream_observation"]["releases"][0]["assets"][0].clone();
                    value["upstream_observation"]["releases"][0]["assets"]
                        .as_array_mut()
                        .unwrap()
                        .push(asset);
                }
                "foreign-url" => value["upstream_observation"]["releases"][0]["assets"][0]["url"] =
                    "https://github.com/other/game/releases/download/v1.2.0/game-windows-x64.zip"
                        .into(),
                "wrong-tag" => {
                    value["upstream_observation"]["releases"][0]["release_url"] =
                        "https://github.com/example/game/releases/tag/v0.1.0".into()
                }
                "future-clock" => {
                    value["upstream_observation"]["observed_at"] = "2027-01-01T00:00:00Z".into()
                }
                "incomplete" => {
                    value["upstream_observation"]["releases"][0]["assets_complete"] = false.into()
                }
                "false-platform" => {
                    value["upstream_observation"]["releases"][0]["assets"][0]["platform_hints"] =
                        json!(["linux-x86-64"])
                }
                _ => unreachable!(),
            }
            assert!(parse(&value, 4).is_err(), "{change}");
        }
    }
    #[test]
    fn gitlab_observations_retain_native_tags_and_project_bound_registry_candidates() {
        let mut value = listing();
        value["project_url"] = "https://gitlab.com/example/game".into();
        value["upstream_observation"]["provider"] = "gitlab".into();
        value["upstream_observation"]["releases"][0]["id"] =
            json!({"provider":"gitlab","project_id":7,"tag":"v1.2.0"});
        value["upstream_observation"]["releases"][0]["release_url"] =
            "https://gitlab.com/example/game/-/releases/v1.2.0".into();
        value["upstream_observation"]["releases"][0]["assets"][0]["url"] =
            "https://gitlab.com/api/v4/projects/7/packages/generic/game/1.2.0/game-windows-x64.zip"
                .into();
        for format in 1..=7 {
            assert!(parse(&value, format).is_err());
        }
        let document = parse(&value, 8).unwrap();
        assert!(document.export_format(6).is_err());
        let catalog = Catalog::for_user_selected_listing(document.listings[0].clone()).unwrap();
        assert_eq!(catalog.listing_document().format_version, 8);
        assert!(catalog.port("observed-project").is_err());
        let mut subgroup = value.clone();
        subgroup["project_url"] = "https://gitlab.com/example/subgroup/game".into();
        subgroup["upstream_observation"]["repository"] = "example/subgroup/game".into();
        subgroup["upstream_observation"]["releases"][0]["release_url"] =
            "https://gitlab.com/example/subgroup/game/-/releases/v1.2.0".into();
        assert!(parse(&subgroup, 8).is_ok());
        for change in [
            "numeric-tag",
            "wrong-tag",
            "wrong-project",
            "foreign-host",
            "wrong-version",
            "wrong-file",
        ] {
            let mut changed = value.clone();
            match change {
                "numeric-tag" => changed["upstream_observation"]["releases"][0]["id"] = 11.into(),
                "wrong-tag" => changed["upstream_observation"]["releases"][0]["id"]["tag"] = "v2".into(),
                "wrong-project" => changed["upstream_observation"]["repository_id"] = 8.into(),
                "foreign-host" => changed["upstream_observation"]["releases"][0]["assets"][0]["url"] = "https://other.test/api/v4/projects/7/packages/generic/game/1.2.0/game-windows-x64.zip".into(),
                "wrong-version" => changed["upstream_observation"]["releases"][0]["assets"][0]["url"] = "https://gitlab.com/api/v4/projects/7/packages/generic/game/2.0/game-windows-x64.zip".into(),
                "wrong-file" => changed["upstream_observation"]["releases"][0]["assets"][0]["url"] = "https://gitlab.com/api/v4/projects/7/packages/generic/game/1.2.0/other.zip".into(),
                _ => unreachable!(),
            }
            assert!(parse(&changed, 8).is_err(), "{change}");
        }
    }
    #[test]
    fn combined_advice_and_gitlab_observations_keep_independent_reader_gates() {
        let mut value = listing();
        value["project_url"] = "https://gitlab.com/example/game".into();
        value["upstream_observation"] = crate::test_fixture::gitlab_listing_observation();
        value["compatibility"] = json!({"format_version":99,"future":true});
        assert!(parse(&value, 7).is_err());
        let document = parse(&value, 8).unwrap();
        for format in [5, 6, 7] {
            assert!(document.export_format(format).is_err());
        }
        assert_eq!(
            document.export_format(8).unwrap().listings[0],
            document.listings[0]
        );
        let retained = Catalog::for_user_selected_listing(document.listings[0].clone()).unwrap();
        assert_eq!(retained.listing_document().format_version, 8);
        assert!(retained.port("observed-project").is_err());
        assert!(parse(&value, REPOSITORY_BOUND_LISTING_FORMAT).is_ok());
        let unsupported_format = ASSIGNED_COVER_LISTING_FORMAT + 1;
        let mut future = document;
        future.format_version = unsupported_format;
        future.promote_projected_format();
        assert_eq!(future.format_version, unsupported_format);
        assert!(future.validate().is_err());
        assert!(parse(&value, unsupported_format).is_err());
    }

    #[test]
    fn descriptive_first_failure_and_last_good_facts_remain_distinct() {
        let mut value = listing();
        let observation = &mut value["upstream_observation"];
        observation["status"] = "failed".into();
        observation["attempted_at"] = "2026-10-28T00:00:00Z".into();
        assert!(parse(&value, 4).is_ok());
        let observation = &mut value["upstream_observation"];
        for field in [
            "observed_at",
            "fresh_until",
            "facts_sha256",
            "repository_id",
        ] {
            observation[field] = Value::Null;
        }
        observation["releases"] = json!([]);
        assert!(parse(&value, 4).is_ok());
        value["upstream_observation"]["status"] = "complete".into();
        assert!(parse(&value, 4).is_err());
    }
    #[test]
    fn references_are_versioned_bounded_and_lossless_in_legacy_listings() {
        let current = CatalogListingDocument::from_json(EMBEDDED_LISTINGS).unwrap();
        // Start with format 6 to isolate setup references from later fields.
        let mut document = current.export_format(6).unwrap();
        let legacy = document.export_format(5).unwrap();
        for listing in &document.listings {
            if let Some(guide) = &listing.manual_setup {
                let old = legacy
                    .listings
                    .iter()
                    .find(|old| old.id == listing.id)
                    .unwrap()
                    .manual_setup
                    .as_ref()
                    .unwrap();
                assert_eq!(old.steps, guide.legacy().steps);
                assert_eq!(old.warnings, guide.warnings);
                assert!(old.references.is_empty());
            }
        }
        document.format_version = 5;
        assert!(
            document
                .validate()
                .unwrap_err()
                .message
                .contains("references require")
        );
        document.format_version = 6;
        let guide = document
            .listings
            .iter_mut()
            .find(|listing| listing.id == "syphon-filter-sf-pc-port")
            .unwrap()
            .manual_setup
            .as_mut()
            .unwrap();
        guide.references.push(guide.references[0].clone());
        guide.references.push(guide.references[0].clone());
        assert!(document.validate().is_err());
    }
    #[test]
    fn a_directory_carrying_funding_links_is_projected_as_format_ten() {
        let listing = |urls: Option<&[&str]>| -> PortListing {
            let mut value = serde_json::json!({
                "id": "fixture", "name": "Fixture", "summary": "Fixture",
                "project_url": "https://example.com/fixture"
            });
            if let Some(urls) = urls {
                value["funding_urls"] = serde_json::json!(urls);
            }
            serde_json::from_value(value).unwrap()
        };
        let mut funded = CatalogListingDocument {
            format_version: 6,
            listings: vec![listing(Some(&["https://ko-fi.com/example"]))],
        };
        funded.promote_projected_format();
        assert_eq!(funded.format_version, 10);
        assert!(funded.validate().is_ok());
        let mut unfunded = CatalogListingDocument {
            format_version: 6,
            listings: vec![listing(None)],
        };
        unfunded.promote_projected_format();
        assert_eq!(unfunded.format_version, 6, "no links keep the format");
        // An explicit empty list is refused at every format rather than accepted as inert.
        for format_version in [6, 9, 10] {
            let mut empty = CatalogListingDocument {
                format_version,
                listings: vec![listing(Some(&[]))],
            };
            empty.promote_projected_format();
            assert!(empty.validate().is_err(), "{format_version}");
        }
    }

    #[test]
    fn a_directory_carrying_a_first_listed_date_is_projected_as_format_nine() {
        let listing = |date: Option<&str>| -> PortListing {
            let mut value = serde_json::json!({
                "id": "fixture", "name": "Fixture", "summary": "Fixture",
                "project_url": "https://example.com/fixture"
            });
            if let Some(date) = date {
                value["listed_at"] = serde_json::json!(date);
            }
            serde_json::from_value(value).unwrap()
        };
        let mut dated = CatalogListingDocument {
            format_version: 6,
            listings: vec![listing(Some("2026-11-09"))],
        };
        dated.promote_projected_format();
        assert_eq!(dated.format_version, 9);
        assert!(dated.validate().is_ok());
        let mut undated = CatalogListingDocument {
            format_version: 6,
            listings: vec![listing(None)],
        };
        undated.promote_projected_format();
        assert_eq!(
            undated.format_version, 6,
            "an undated directory keeps its format"
        );
    }
    #[test]
    fn implementation_metadata_is_optional_inert_and_versioned_for_legacy_readers() {
        let original = listing();
        for metadata in [
            json!({"format_version": 1, "methods": [{"kind": "static-recompilation"}]}),
            json!({"format_version": 999}),
            json!("malformed optional enrichment"),
        ] {
            let mut enriched = original.clone();
            enriched["implementation"] = metadata.clone();
            let document = CatalogListingDocument::from_json(
                &json!({"format_version": 12, "listings": [enriched]}).to_string(),
            )
            .unwrap();
            assert_eq!(document.listings[0].implementation, Some(metadata));
            let legacy = document.export_format(11).unwrap();
            assert!(legacy.listings[0].implementation.is_none());
            assert_eq!(legacy.listings[0].platforms, document.listings[0].platforms);
            assert_eq!(
                legacy.listings[0].download_block_reason,
                document.listings[0].download_block_reason
            );
            let retained =
                Catalog::for_user_selected_listing(document.listings[0].clone()).unwrap();
            assert_eq!(retained.listing_document().format_version, 12);
            assert!(
                retained.ports().is_empty(),
                "descriptions never create a managed port"
            );
        }
    }

    #[test]
    fn directory_text_has_a_byte_bound_and_no_listing_count() {
        // Past the former 10,000-listing ceiling, within the text bound.
        let listings = (0..10_001)
            .map(|index| {
                json!({
                    "id": format!("listing-{index}"),
                    "name": "Listing",
                    "summary": "Description.",
                    "project_url": "https://example.org/project",
                })
            })
            .collect::<Vec<_>>();
        let text = json!({"format_version": 15, "listings": listings}).to_string();
        assert_eq!(
            CatalogListingDocument::from_json(&text)
                .unwrap()
                .listings
                .len(),
            10_001
        );
        let oversized = format!("{text}{}", " ".repeat(MAX_LISTING_DIRECTORY_TEXT_BYTES));
        assert!(
            CatalogListingDocument::from_json(&oversized)
                .unwrap_err()
                .message
                .contains("exceeds its byte limit")
        );
        // The bundled directory is parsed without the external text bound,
        // including above the former 8 MiB ceiling.
        assert!(CatalogListingDocument::from_trusted_text(&text).is_ok());
        let summary = "A descriptive listing summary sentence for scale. ".repeat(18);
        let large = json!({
            "format_version": 15,
            "listings": (0..10_001)
                .map(|index| json!({
                    "id": format!("listing-{index}"),
                    "name": "Listing",
                    "summary": summary.trim(),
                    "project_url": "https://example.org/project",
                }))
                .collect::<Vec<_>>(),
        })
        .to_string();
        assert!(large.len() > 8 * 1024 * 1024);
        assert_eq!(
            CatalogListingDocument::from_trusted_text(&large)
                .unwrap()
                .listings
                .len(),
            10_001
        );
    }
}
