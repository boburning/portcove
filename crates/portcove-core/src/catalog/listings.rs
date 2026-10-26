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
        if !matches!(self.format_version, 1 | 2 | 3) {
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
    pub fn validate(&self) -> Result<()> {
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
        // Projection can combine validated format-2 delivery/retained entries
        // with a format-1 directory. Preserve their semantics without accepting
        // a raw format-1 document that falsely advertises those fields.
        if document.format_version == 1
            && document
                .listings
                .iter()
                .any(|listing| listing.download_block_reason.is_some())
        {
            document.format_version = 2;
        }
        if matches!(document.format_version, 1 | 2)
            && document
                .listings
                .iter()
                .any(|listing| listing.original_game.is_some() || !listing.media.is_empty())
        {
            document.format_version = 3;
        }
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
            json!({"format_version":3,"listings":[]}),
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
