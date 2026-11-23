//! Identity joins and serialized digests over exactly one catalog document revision.
//!
//! An [`Indexed`] value owns its document together with the lazily built id
//! index and serialized digest. It deliberately implements `Deref` but not
//! `DerefMut`: the only mutable route is [`Indexed::make_mut`], which discards
//! both first, so neither can answer for a different revision than the one it
//! was derived from. Clones start empty, and nothing here is global: the derived
//! values live and die with the catalog value that holds the document. They are
//! inert observations; no permission or eligibility decision is stored.

use std::collections::HashMap;
use std::ops::Deref;
use std::sync::OnceLock;

/// A document whose entries carry a stable identity.
pub(crate) trait IdentifiedEntries {
    fn entry_ids(&self) -> impl Iterator<Item = &str>;
}

impl IdentifiedEntries for crate::CatalogDocument {
    fn entry_ids(&self) -> impl Iterator<Item = &str> {
        self.ports.iter().map(|port| port.id.as_str())
    }
}

impl IdentifiedEntries for crate::CatalogListingDocument {
    fn entry_ids(&self) -> impl Iterator<Item = &str> {
        self.listings.iter().map(|listing| listing.id.as_str())
    }
}

#[derive(Debug)]
pub(crate) struct Indexed<T> {
    value: T,
    /// Entry id to the position of its first occurrence, matching a linear
    /// `iter().find`/`position` over the same entries.
    positions: OnceLock<HashMap<Box<str>, usize>>,
    digest: OnceLock<DocumentDigest>,
}

/// Canonical serialization facts of one document revision.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DocumentDigest {
    /// Lowercase hex SHA-256 of the canonical (authoritative) JSON bytes.
    pub(crate) sha256: String,
    /// Length of those canonical bytes.
    pub(crate) canonical_bytes: usize,
    /// Length of the document's own JSON bytes as stored in the catalog value.
    pub(crate) document_bytes: usize,
}

impl<T> Indexed<T> {
    pub(crate) fn new(value: T) -> Self {
        Self {
            value,
            positions: OnceLock::new(),
            digest: OnceLock::new(),
        }
    }

    /// The only mutable access. It drops the index and digest before handing
    /// out the document, so later reads derive them from the changed revision.
    pub(crate) fn make_mut(&mut self) -> &mut T {
        self.positions = OnceLock::new();
        self.digest = OnceLock::new();
        &mut self.value
    }

    /// Compute this revision's digest once. A failed computation is not kept.
    pub(crate) fn digest(
        &self,
        compute: impl FnOnce(&T) -> crate::Result<DocumentDigest>,
    ) -> crate::Result<&DocumentDigest> {
        if let Some(digest) = self.digest.get() {
            return Ok(digest);
        }
        let digest = compute(&self.value)?;
        Ok(self.digest.get_or_init(|| digest))
    }
}

impl<T: IdentifiedEntries> Indexed<T> {
    /// Position of the first entry with `id`, or `None` exactly when a linear
    /// scan of the same revision finds none.
    pub(crate) fn position(&self, id: &str) -> Option<usize> {
        self.positions
            .get_or_init(|| {
                let mut positions = HashMap::new();
                for (index, entry) in self.value.entry_ids().enumerate() {
                    positions.entry(Box::from(entry)).or_insert(index);
                }
                positions
            })
            .get(id)
            .copied()
    }
}

impl<T> Deref for Indexed<T> {
    type Target = T;

    fn deref(&self) -> &T {
        &self.value
    }
}

impl<T: Clone> Clone for Indexed<T> {
    /// A clone exists to be changed (`Arc::make_mut`); it rebuilds on demand.
    fn clone(&self) -> Self {
        Self::new(self.value.clone())
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;
    use std::sync::Arc;

    use super::Indexed;
    use crate::{Catalog, CatalogDocument, CatalogListingDocument, ErrorCode};

    fn linear_port<'a>(
        document: &'a CatalogDocument,
        id: &str,
    ) -> crate::Result<&'a crate::PortDefinition> {
        document
            .ports
            .iter()
            .find(|port| port.id == id)
            .ok_or_else(|| crate::PortcoveError::not_found(format!("unknown port id: {id}")))
    }

    fn linear_listing<'a>(
        document: &'a CatalogListingDocument,
        id: &str,
    ) -> crate::Result<&'a crate::PortListing> {
        document
            .listings
            .iter()
            .find(|listing| listing.id == id)
            .ok_or_else(|| crate::PortcoveError::not_found(format!("unknown listing id: {id}")))
    }

    fn same<T>(indexed: crate::Result<&T>, linear: crate::Result<&T>) {
        match (indexed, linear) {
            (Ok(indexed), Ok(linear)) => assert!(std::ptr::eq(indexed, linear)),
            (Err(indexed), Err(linear)) => {
                assert_eq!(indexed.code, linear.code);
                assert_eq!(indexed.message, linear.message);
            }
            (indexed, linear) => panic!(
                "indexed and linear lookups disagree: {:?} / {:?}",
                indexed.is_ok(),
                linear.is_ok()
            ),
        }
    }

    /// Every known id, every id of the other document, and ids no document holds.
    fn probes(catalog: &Catalog) -> Vec<String> {
        let mut probes = catalog
            .ports()
            .iter()
            .map(|port| port.id.clone())
            .chain(catalog.listings().iter().map(|listing| listing.id.clone()))
            .collect::<Vec<_>>();
        probes.extend(
            ["", "unknown-port", "SHIPWRIGHT", "shipwright ", "-xscale1"]
                .into_iter()
                .map(String::from),
        );
        probes
    }

    fn assert_equivalent(catalog: &Catalog) {
        for id in probes(catalog) {
            same(catalog.port(&id), linear_port(catalog.document(), &id));
            same(
                catalog.listing(&id),
                linear_listing(catalog.listing_document(), &id),
            );
        }
    }

    /// Lookups need no validation, so generated documents are indexed directly.
    fn unvalidated(document: CatalogDocument, listings: CatalogListingDocument) -> Catalog {
        Catalog {
            document: Arc::new(Indexed::new(document)),
            listings: Arc::new(Indexed::new(listings)),
            user_selected_listing: false,
            retained_definitions: Arc::default(),
        }
    }

    #[test]
    fn indexed_lookups_match_linear_scans_on_the_real_catalog() {
        let catalog = Catalog::embedded().unwrap();
        assert_equivalent(&catalog);
        let error = catalog.port("unknown-port").unwrap_err();
        assert_eq!(error.code, ErrorCode::NotFound);
        assert_eq!(error.message, "unknown port id: unknown-port");
        let error = catalog.listing("unknown-port").unwrap_err();
        assert_eq!(error.code, ErrorCode::NotFound);
        assert_eq!(error.message, "unknown listing id: unknown-port");
    }

    #[test]
    fn indexed_lookups_match_linear_scans_on_generated_catalogs() {
        for factor in [2, 5] {
            let (document, listings) =
                crate::scaling_profile_tests::scaled_documents_excluding(factor, &HashSet::new());
            assert_equivalent(&unvalidated(document, listings));
        }
    }

    #[test]
    fn duplicate_ids_resolve_to_the_first_entry_like_a_linear_scan() {
        let embedded = Catalog::embedded().unwrap();
        let mut document = CatalogDocument::clone(embedded.document());
        let mut listings = embedded.listing_document().clone();
        let mut port = document.ports[3].clone();
        port.name = "a later duplicate".into();
        document.ports.push(port);
        let mut listing = listings.listings[7].clone();
        listing.name = "a later duplicate".into();
        listings.listings.insert(0, listing);
        let catalog = unvalidated(document, listings);
        assert_equivalent(&catalog);
        assert_ne!(
            catalog.port(&catalog.ports()[3].id).unwrap().name,
            "a later duplicate"
        );
        assert_eq!(
            catalog.listing(&catalog.listings()[0].id).unwrap().name,
            "a later duplicate"
        );
    }

    #[test]
    fn a_changed_revision_never_answers_from_the_previous_index() {
        let original = Catalog::embedded().unwrap();
        let first = original.ports()[0].id.clone();
        let last = original.ports().last().unwrap().id.clone();
        // Build both indexes before deriving a changed revision.
        assert_equivalent(&original);

        let mut overlay = original.clone();
        {
            let ports = &mut Arc::make_mut(&mut overlay.document).make_mut().ports;
            ports.swap(0, 1);
            ports.pop();
        }
        assert_equivalent(&overlay);
        assert_eq!(
            overlay.port(&first).unwrap().id,
            first,
            "moved entry is found at its new position"
        );
        assert_eq!(overlay.port(&last).unwrap_err().code, ErrorCode::NotFound);
        // The source value keeps its own revision and index.
        assert_equivalent(&original);
        assert!(original.port(&last).is_ok());

        // Replacing the listing directory carries a fresh index with it.
        let mut listings = original.listing_document().clone();
        let listing_only = listings
            .listings
            .iter()
            .position(|listing| original.port(&listing.id).is_err())
            .unwrap();
        let removed = listings.listings.remove(listing_only).id;
        let replaced = original
            .clone()
            .with_projected_listing_document(listings)
            .unwrap();
        assert_eq!(
            replaced.listing(&removed).unwrap_err().code,
            ErrorCode::NotFound
        );
        assert!(original.listing(&removed).is_ok());
        assert_equivalent(&replaced);
    }

    #[test]
    fn clones_and_mutation_reset_the_index() {
        let embedded = Catalog::embedded().unwrap();
        let mut indexed = Indexed::new(CatalogDocument::clone(embedded.document()));
        let id = indexed.ports[0].id.clone();
        assert_eq!(indexed.position(&id), Some(0));
        let digest = |_: &CatalogDocument| {
            Ok(super::DocumentDigest {
                sha256: String::new(),
                canonical_bytes: 1,
                document_bytes: 1,
            })
        };
        indexed.digest(digest).unwrap();
        let clone = indexed.clone();
        assert!(clone.positions.get().is_none());
        assert!(clone.digest.get().is_none());
        indexed.make_mut().ports.remove(0);
        assert!(indexed.positions.get().is_none());
        assert!(indexed.digest.get().is_none());
        assert_eq!(indexed.position(&id), None);
        assert_eq!(clone.position(&id), Some(0));
    }

    fn assert_digest_matches_owned_serialization(catalog: &Catalog) {
        let canonical = serde_json::to_vec(&catalog.authoritative_document()).unwrap();
        assert_eq!(
            serde_json::to_vec(&catalog.authoritative_view()).unwrap(),
            canonical
        );
        let digest = catalog.document_digest().unwrap();
        assert_eq!(digest.sha256, crate::signed_catalog::digest(&canonical));
        assert_eq!(digest.canonical_bytes, canonical.len());
        assert_eq!(
            digest.document_bytes,
            serde_json::to_vec(catalog.document()).unwrap().len()
        );
    }

    #[test]
    fn cached_digest_matches_the_owned_authoritative_serialization() {
        assert_digest_matches_owned_serialization(&Catalog::embedded().unwrap());
        let schema1 =
            Catalog::from_json(include_str!("../../catalog/catalog-schema1-fixture.json")).unwrap();
        assert!(schema1.document().source_catalog.is_none());
        assert!(!schema1.document().source_profiles.is_empty());
        assert_digest_matches_owned_serialization(&schema1);
        let (document, listings) =
            crate::scaling_profile_tests::scaled_documents_excluding(3, &HashSet::new());
        assert_digest_matches_owned_serialization(&unvalidated(document, listings));
    }

    #[test]
    fn a_changed_revision_recomputes_its_digest() {
        let original = Catalog::embedded().unwrap();
        let before = original.document_digest().unwrap().clone();
        let mut changed = original.clone();
        Arc::make_mut(&mut changed.document).make_mut().ports[0].name = "changed".into();
        assert_ne!(changed.document_digest().unwrap(), &before);
        assert_digest_matches_owned_serialization(&changed);
        // Clones that did not change keep answering for their own revision.
        assert_eq!(original.document_digest().unwrap(), &before);
        assert_eq!(original.clone().document_digest().unwrap(), &before);
        // Overlay helpers mutate through the same reset.
        let mut held = original.clone();
        let id = held
            .ports()
            .iter()
            .find(|port| port.mod_provider_bindings.is_none())
            .unwrap()
            .id
            .clone();
        held.document_digest().unwrap();
        held.hold_legacy_mod_provider(&id);
        assert!(
            held.ports()
                .iter()
                .any(|port| port.legacy_mod_provider_held)
        );
        assert!(held.document.digest.get().is_none());
        assert!(held.document.positions.get().is_none());
        assert_digest_matches_owned_serialization(&held);
        assert_equivalent(&held);
    }
}
