//! The broad directory is descriptive. Strict managed definitions retain their
//! original validator and are never synthesized from an incomplete listing.
use super::*;
use crate::{CatalogListingDocument, ListingAvailability, PortListing};

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
            variant_label: presentation.and_then(|value| value.variant_label.clone()),
            issue_number: None,
            platforms: port.platforms.clone(),
            availability: ListingAvailability::Unknown,
            release_url: None,
            setup_url: presentation
                .and_then(|value| value.manual_setup.as_ref())
                .and_then(|guide| guide.help_url.clone()),
            manual_setup: presentation.and_then(|value| value.manual_setup.clone()),
            artwork: presentation.and_then(|value| value.artwork.clone()),
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
        if self.format_version != 1 {
            return Err(PortcoveError::unsupported(format!(
                "listing format {} is not supported",
                self.format_version
            )));
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

impl PortListing {
    pub fn validate(&self) -> Result<()> {
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
        for url in [&self.release_url, &self.setup_url].into_iter().flatten() {
            if !valid_url(url) {
                return Err(PortcoveError::usage(
                    "listing links must be public HTTPS URLs",
                ));
            }
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
        document: CatalogListingDocument,
    ) -> Result<Self> {
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
                let issue_number = listing.issue_number;
                let availability = listing.availability;
                let release_url = listing.release_url.clone();
                let setup_url = listing.setup_url.clone().or(projected.setup_url.clone());
                *listing = PortListing {
                    issue_number,
                    availability,
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
            json!({"format_version":2,"listings":[]}),
            json!({"format_version":1,"listings":[listing(),listing()]}),
            json!({"format_version":1,"listings":[unsafe_listing]}),
            json!({"format_version":1,"listings":[operational_listing]}),
        ] {
            assert!(CatalogListingDocument::from_json(&document.to_string()).is_err());
        }
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
