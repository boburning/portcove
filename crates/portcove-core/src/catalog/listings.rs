//! The broad directory is descriptive. Strict managed definitions retain their
//! original validator and are never synthesized from an incomplete listing.
use super::*;
use crate::{CatalogListingDocument, ListingAvailability, PortListing};
use std::collections::BTreeMap;

const EMBEDDED_LISTINGS: &str = include_str!("../../catalog/listings.json");
const MAX_LISTING_BYTES: usize = 8 * 1024 * 1024;

impl From<&PortDefinition> for PortListing {
    fn from(port: &PortDefinition) -> Self {
        let presentation = port.presentation.as_ref();
        Self {
            id: port.id.clone(),
            upstream_observation: None,
            availability_override_reason: None,
            release_maintenance: None,
            name: port.name.clone(),
            summary: port.summary.clone(),
            project_url: port.project_url.clone(),
            original_game_title: presentation.and_then(|value| value.original_game_title.clone()),
            original_game: presentation.and_then(|value| value.original_game.clone()),
            variant_label: presentation.and_then(|value| value.variant_label.clone()),
            issue_number: None,
            platforms: port.platforms.clone(),
            availability: ListingAvailability::Unknown,
            download_block_reason: None,
            download_asset_hints: BTreeMap::new(),
            recommended_download_channel: None,
            release_url: None,
            setup_url: presentation
                .and_then(|value| value.manual_setup.as_ref())
                .and_then(|guide| guide.help_url.clone()),
            manual_setup: presentation.and_then(|value| value.manual_setup.clone()),
            artwork: presentation.and_then(|value| value.artwork.clone()),
            media: presentation
                .and_then(|value| value.media.clone())
                .unwrap_or_default(),
        }
    }
}

impl CatalogListingDocument {
    /// Only already accepted facts may be promoted; raw authored documents keep
    /// their declared version and pass the ordinary version checks unchanged.
    pub(super) fn promote_projected_format(&mut self) {
        // Projection can combine validated format-2 delivery/retained entries
        // with a format-1 directory. Preserve their semantics without accepting
        // a raw format-1 document that falsely advertises those fields.
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
    }

    fn has_observation_fields(&self) -> bool {
        self.listings.iter().any(|listing| {
            listing.upstream_observation.is_some()
                || listing.availability_override_reason.is_some()
                || listing.release_maintenance.is_some()
        })
    }

    pub fn from_json(content: &str) -> Result<Self> {
        if content.len() > MAX_LISTING_BYTES {
            return Err(PortcoveError::usage(
                "listing document exceeds its byte limit",
            ));
        }
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
        if !matches!(self.format_version, 1..=4) {
            return Err(PortcoveError::unsupported(format!(
                "listing format {} is not supported",
                self.format_version
            )));
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
        if self.format_version < 4
            && self.listings.iter().any(|listing| {
                listing.upstream_observation.is_some()
                    || listing.availability_override_reason.is_some()
                    || listing.release_maintenance.is_some()
            })
        {
            return Err(PortcoveError::unsupported(
                "listing observations, overrides and maintenance require format 4",
            ));
        }
        if self.listings.len() > 10_000 {
            return Err(PortcoveError::usage(
                "listing document exceeds its entry limit",
            ));
        }
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
) -> bool {
    let Ok(url) = reqwest::Url::parse(value) else {
        return false;
    };
    if url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return false;
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
    fn validate_observation_metadata(&self) -> Result<()> {
        let invalid = || {
            PortcoveError::usage("invalid descriptive listing observation or maintenance metadata")
        };
        if let Some(reason) = &self.availability_override_reason {
            if !valid_text(reason, 4096) || self.availability == ListingAvailability::Unknown {
                return Err(invalid());
            }
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
        let repository = crate::release::catalog_download_repository(
            self.release_url.as_deref().unwrap_or(&self.project_url),
        )?;
        let identity = |id: u64| id > 0 && id <= 9_007_199_254_740_991;
        if observation.provider != "github"
            || !observation.repository.eq_ignore_ascii_case(&repository)
            || observation.repository_id.is_some_and(|id| !identity(id))
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
        let mut releases = HashSet::new();
        let mut tags = HashSet::new();
        let mut packages = HashSet::new();
        for release in &observation.releases {
            if !identity(release.id)
                || !releases.insert(release.id)
                || !valid_text(&release.version, 255)
                || !tags.insert(&release.version)
                || !valid_url(&release.release_url)
                || !observed_release_link(
                    &release.release_url,
                    &observation.repository,
                    &release.version,
                    None,
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
        for url in [&self.release_url, &self.setup_url].into_iter().flatten() {
            if !valid_url(url) {
                return Err(PortcoveError::usage(
                    "listing links must be public HTTPS URLs",
                ));
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
                || guide.warnings.len() > 8
                || guide.steps.iter().any(|step| {
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
        if let Some(artwork) = &self.artwork
            && (artwork.game_id == 0
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
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-'))
        {
            return Err(PortcoveError::usage("invalid listing artwork mapping"));
        }
        Ok(())
    }
}

impl Catalog {
    pub fn listing_document(&self) -> &CatalogListingDocument {
        &self.listings
    }

    pub fn listings(&self) -> &[PortListing] {
        &self.listings.listings
    }

    pub fn listing(&self, id: &str) -> Result<&PortListing> {
        self.listings()
            .iter()
            .find(|listing| listing.id == id)
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
        for port in self.ports() {
            if !document
                .listings
                .iter()
                .any(|listing| listing.id == port.id)
            {
                return Err(PortcoveError::usage(format!(
                    "listing directory omits operational port {}",
                    port.id
                )));
            }
        }
        self.listings = Arc::new(document);
        Ok(self)
    }

    pub(crate) fn with_embedded_listings(self) -> Result<Self> {
        let mut document = CatalogListingDocument::from_json(EMBEDDED_LISTINGS)?;
        for port in self.ports() {
            let projected = PortListing::from(port);
            if let Some(listing) = document
                .listings
                .iter_mut()
                .find(|listing| listing.id == port.id)
            {
                // Existing signed-catalog presentation corrections must keep
                // reaching their current consumers. Preserve only the directory
                // facts absent from the strict format while projecting its
                // accepted display fields, including artwork, as before.
                let original_game = projected
                    .original_game
                    .clone()
                    .or(listing.original_game.clone());
                let media = port
                    .presentation
                    .as_ref()
                    .and_then(|value| value.media.clone())
                    .unwrap_or_else(|| {
                        // A corrected strict identity cannot inherit another edition's images.
                        listing
                            .media
                            .iter()
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
                let issue_number = listing.issue_number;
                let availability = listing.availability;
                let download_block_reason = listing.download_block_reason.clone();
                let download_asset_hints = listing.download_asset_hints.clone();
                let recommended_download_channel = listing.recommended_download_channel;
                let release_url = listing.release_url.clone();
                let setup_url = listing.setup_url.clone().or(projected.setup_url.clone());
                *listing = PortListing {
                    upstream_observation: listing.upstream_observation.clone(),
                    availability_override_reason: listing.availability_override_reason.clone(),
                    release_maintenance: listing.release_maintenance.clone(),
                    original_game,
                    media,
                    issue_number,
                    availability,
                    download_block_reason,
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

    /// Durable launch intent retains only the descriptive project and an explicit
    /// format fence. No managed capability, source authority or adapter is added.
    pub(crate) fn for_user_selected_listing(listing: PortListing) -> Result<Self> {
        listing.validate()?;
        let mut catalog =
            Self::from_json(r#"{"schema_version":1,"source_profiles":[],"ports":[]}"#)?;
        if listing.original_game.is_some() || !listing.media.is_empty() {
            Arc::make_mut(&mut catalog.listings).format_version = 3;
        } else if listing.download_block_reason.is_some() {
            Arc::make_mut(&mut catalog.listings).format_version = 2;
        }
        Arc::make_mut(&mut catalog.listings).listings.push(listing);
        Arc::make_mut(&mut catalog.listings).promote_projected_format();
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
            json!({"format_version":5,"listings":[]}),
            json!({"format_version":1,"listings":[listing(),listing()]}),
            json!({"format_version":1,"listings":[unsafe_listing]}),
            json!({"format_version":1,"listings":[operational_listing]}),
        ] {
            assert!(CatalogListingDocument::from_json(&document.to_string()).is_err());
        }
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
        assert_eq!(projected.listing_document().format_version, 3);
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
}
