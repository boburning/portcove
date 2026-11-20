//! Descriptive directory delivery under the existing independent catalog policy role.
//! This target cannot create a managed definition, publisher grant or executable contract.
use std::collections::BTreeSet;

use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tough::{Repository, Transport};

use super::{PolicyProvenance, installed_authority_floor, provisioning};
use crate::{
    ActivityOperation, ActivityTargetKind, Catalog, CatalogListingDocument,
    DefinitionRepositorySource, Library, OperationEvent, OperationResult, PortcoveError,
    PortcoveService, Result,
};

pub(crate) const TARGET: &str = "policy/official/catalog.listings.json";
pub(crate) const MAX_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ListingDeliveryDocument {
    pub listing_delivery_schema: u32,
    pub revision: u64,
    pub withdrawn_ids: Vec<String>,
    pub directory: CatalogListingDocument,
}

#[cfg(test)]
mod projection_tests {
    use super::*;

    #[test]
    fn legacy_delivery_preserves_only_same_scope_implementation_descriptions() {
        let baseline = Catalog::embedded().unwrap();
        let original = baseline.listing("zelda64-recomp").unwrap();
        assert!(original.implementation.is_some());
        let legacy = baseline.listing_document().export_format(11).unwrap();
        let legacy = legacy
            .listings
            .iter()
            .find(|listing| listing.id == original.id)
            .unwrap();
        for case in [
            "legacy-same-scope",
            "current-format-omission",
            "changed-project",
            "changed-game",
            "changed-edition",
            "missing-identity",
            "new-id",
        ] {
            let mut delivered = legacy.clone();
            delivered.summary = "Updated delivered summary.".into();
            delivered.download_block_reason = Some("Preserve the delivered prerequisite.".into());
            match case {
                "changed-project" => delivered.project_url = "https://example.invalid/other".into(),
                "changed-game" => {
                    delivered.original_game.as_mut().unwrap().id = "other-game".into()
                }
                "changed-edition" => {
                    delivered.original_game.as_mut().unwrap().source_editions[0].id =
                        "other-edition".into();
                }
                "missing-identity" => delivered.original_game = None,
                "new-id" => delivered.id = "separate-implementation".into(),
                _ => {}
            }
            let id = delivered.id.clone();
            let document = ListingDeliveryDocument {
                listing_delivery_schema: 1,
                revision: 1,
                withdrawn_ids: vec![],
                directory: CatalogListingDocument {
                    format_version: if case == "current-format-omission" {
                        12
                    } else {
                        11
                    },
                    listings: vec![delivered],
                },
            };
            let document =
                ListingDeliveryDocument::parse(&serde_json::to_vec(&document).unwrap()).unwrap();
            let projected = document.project(baseline.clone()).unwrap();
            let listing = projected.listing(&id).unwrap();
            assert_eq!(
                listing.implementation,
                if case == "legacy-same-scope" {
                    original.implementation.clone()
                } else {
                    None
                },
                "{case}"
            );
            assert_eq!(listing.summary, "Updated delivered summary.", "{case}");
            assert_eq!(
                listing.download_block_reason.as_deref(),
                Some("Preserve the delivered prerequisite."),
                "{case}"
            );
            assert_eq!(
                serde_json::to_value(projected.authoritative_document()).unwrap(),
                serde_json::to_value(baseline.authoritative_document()).unwrap(),
                "{case}"
            );
        }
    }

    #[test]
    fn restricted_delivery_promotes_a_legacy_directory_without_granting_managed_authority() {
        let document = ListingDeliveryDocument::parse(
            &serde_json::to_vec(&serde_json::json!({
                "listing_delivery_schema":1,"revision":1,"withdrawn_ids":[],
                "directory":{"format_version":2,"listings":[{
                    "id":"restricted-delivery","name":"Restricted delivery",
                    "summary":"A project with an exact acquisition prerequisite.",
                    "project_url":"https://example.invalid/project",
                    "download_block_reason":"Resolve the upstream component permission."
                }]}
            }))
            .unwrap(),
        )
        .unwrap();
        let legacy = Catalog::from_json(r#"{"schema_version":1,"ports":[]}"#).unwrap();
        assert_eq!(legacy.listing_document().format_version, 1);
        let projected = document.project(legacy).unwrap();
        assert_eq!(projected.listing_document().format_version, 2);
        assert_eq!(
            projected
                .listing("restricted-delivery")
                .unwrap()
                .download_block_reason
                .as_deref(),
            Some("Resolve the upstream component permission.")
        );
        assert!(projected.port("restricted-delivery").is_err());
    }
}

impl ListingDeliveryDocument {
    pub(crate) fn parse(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > MAX_BYTES {
            return Err(PortcoveError::verification(
                "listing delivery exceeds its byte bound",
            ));
        }
        let value: crate::definition_entry::strict_json::UniqueValue =
            serde_json::from_slice(bytes)?;
        let document: Self = serde_json::from_value(value.0)?;
        if document.listing_delivery_schema != 1 {
            return Err(PortcoveError::unsupported(
                "unsupported listing delivery schema",
            ));
        }
        if document.revision == 0
            || document.revision > 9_007_199_254_740_991
            || document.withdrawn_ids.len() > 10_000
        {
            return Err(PortcoveError::verification(
                "invalid listing delivery revision or count",
            ));
        }
        document.directory.validate()?;
        let mut ids = BTreeSet::new();
        for id in &document.withdrawn_ids {
            if id.is_empty()
                || id.len() > 128
                || !id
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
                || !ids.insert(id)
                || document
                    .directory
                    .listings
                    .iter()
                    .any(|listing| &listing.id == id)
            {
                return Err(PortcoveError::verification(
                    "invalid or conflicting listing withdrawal",
                ));
            }
        }
        Ok(document)
    }

    fn project(&self, catalog: Catalog) -> Result<Catalog> {
        let mut directory = catalog.listing_document().clone();
        // A withdrawal cannot hide a usable managed definition or mutate its retained state.
        directory.listings.retain(|listing| {
            !self.withdrawn_ids.contains(&listing.id) || catalog.port(&listing.id).is_ok()
        });
        for listing in &self.directory.listings {
            match directory
                .listings
                .iter_mut()
                .find(|current| current.id == listing.id)
            {
                Some(current) => {
                    let mut replacement = listing.clone();
                    // Older directories cannot express or withdraw format-12
                    // explanations. Retain only the same project's exact game
                    // scope; all fields that delivery understands remain its own.
                    if self.directory.format_version < 12
                        && replacement.implementation.is_none()
                        && replacement.project_url == current.project_url
                        && replacement.original_game == current.original_game
                    {
                        replacement.implementation = current.implementation.clone();
                    }
                    *current = replacement;
                }
                None => directory.listings.push(listing.clone()),
            }
        }
        // Stable ID ordering makes successive loads independent of publisher array order.
        directory.listings.sort_by(|a, b| a.id.cmp(&b.id));
        catalog.with_projected_listing_document(directory)
    }
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct ListingDeliveryStatus {
    pub delivery_schema: u32,
    pub revision: Option<u64>,
    pub selected: bool,
    pub anchor_sha256: Option<String>,
    pub repository_root_sha256: Option<String>,
    pub target_sha256: Option<String>,
    pub expires_at: Option<String>,
    pub listing_count: usize,
    pub withdrawn_ids: Vec<String>,
    pub fallback_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fallback_code: Option<crate::CatalogFallbackCode>,
}

impl Default for ListingDeliveryStatus {
    fn default() -> Self {
        Self {
            delivery_schema: 1,
            revision: None,
            selected: false,
            anchor_sha256: None,
            repository_root_sha256: None,
            target_sha256: None,
            expires_at: None,
            listing_count: 0,
            withdrawn_ids: vec![],
            fallback_reason: None,
            fallback_code: None,
        }
    }
}

pub(crate) struct AuthenticatedListings {
    bytes: Vec<u8>,
    document: ListingDeliveryDocument,
    provenance: PolicyProvenance,
}

impl AuthenticatedListings {
    fn stored(connection: &Connection) -> Result<Option<Self>> {
        let row: Option<(String, String)> = connection
            .query_row(
                "SELECT document_json,provenance_json FROM listing_delivery WHERE singleton=1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        row.map(|(document, provenance)| {
            if provenance.len() > 16 * 1024 {
                return Err(PortcoveError::state(
                    "stored listing provenance exceeds its bound",
                ));
            }
            let provenance: PolicyProvenance = serde_json::from_str(&provenance)?;
            provenance.validate()?;
            if super::digest(document.as_bytes()) != provenance.target_sha256 {
                return Err(PortcoveError::state(
                    "stored listing bytes differ from admission",
                ));
            }
            Ok(Self {
                document: ListingDeliveryDocument::parse(document.as_bytes())?,
                bytes: document.into_bytes(),
                provenance,
            })
        })
        .transpose()
    }

    fn require_current(&self, connection: &Connection, now: i64) -> Result<()> {
        let floor = installed_authority_floor(connection, &self.provenance.anchor_sha256)?
            .ok_or_else(|| PortcoveError::state("listing authority lost its replay floor"))?;
        // Other policy targets may have advanced shared metadata since this target was admitted.
        floor.check_advance(&self.provenance)?;
        let expiry = OffsetDateTime::parse(&self.provenance.expires_at, &Rfc3339)
            .map_err(|_| PortcoveError::state("invalid listing expiration"))?
            .unix_timestamp();
        if now >= expiry {
            return Err(PortcoveError::verification(
                "listing delivery metadata is expired",
            ));
        }
        Ok(())
    }

    fn status(&self) -> ListingDeliveryStatus {
        ListingDeliveryStatus {
            delivery_schema: 1,
            revision: Some(self.document.revision),
            selected: true,
            anchor_sha256: Some(self.provenance.anchor_sha256.clone()),
            repository_root_sha256: Some(self.provenance.root_sha256.clone()),
            target_sha256: Some(self.provenance.target_sha256.clone()),
            expires_at: Some(self.provenance.expires_at.clone()),
            listing_count: self.document.directory.listings.len(),
            withdrawn_ids: self.document.withdrawn_ids.clone(),
            fallback_reason: None,
            fallback_code: None,
        }
    }
}

pub(crate) fn load(
    connection: &Connection,
    catalog: Catalog,
    now: i64,
) -> (Catalog, ListingDeliveryStatus) {
    let mut status = ListingDeliveryStatus::default();
    let result: Result<Option<Catalog>> = (|| {
        let Some(stored) = AuthenticatedListings::stored(connection)? else {
            return Ok(None);
        };
        status = stored.status();
        stored.require_current(connection, now)?;
        stored.document.project(catalog.clone()).map(Some)
    })();
    match result {
        Ok(Some(projected)) => (projected, status),
        Ok(None) => (catalog, status),
        Err(error) => {
            status.selected = false;
            status.fallback_code = Some(
                error
                    .catalog_fallback()
                    .unwrap_or(crate::CatalogFallbackCode::ListingDirectoryUnavailable),
            );
            status.fallback_reason = Some(error.message);
            (catalog, status)
        }
    }
}

impl Library {
    pub fn listing_delivery_status(&self) -> Result<ListingDeliveryStatus> {
        let connection = self.connection()?;
        let transaction = connection.unchecked_transaction()?;
        let now = Self::now();
        let (baseline, provenance) =
            crate::catalog_store::CatalogState::read(&transaction)?.resolve(now)?;
        let (catalog, _) =
            crate::catalog_store::resolve_before_listings(&transaction, baseline, provenance, now)?;
        let (_, status) = load(&transaction, catalog, now);
        transaction.commit()?;
        Ok(status)
    }

    fn apply_listings(&self, candidate: AuthenticatedListings) -> Result<ListingDeliveryStatus> {
        self.admit_listings(&candidate, true)
    }

    /// Every admission check of `apply_listings`, without writing. A scheduled
    /// refresh uses it so a candidate this client would refuse records nothing.
    pub(crate) fn check_listings(&self, candidate: &AuthenticatedListings) -> Result<()> {
        self.admit_listings(candidate, false).map(|_| ())
    }

    fn admit_listings(
        &self,
        candidate: &AuthenticatedListings,
        publish: bool,
    ) -> Result<ListingDeliveryStatus> {
        candidate.provenance.require_fresh()?;
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let floor = installed_authority_floor(&transaction, &candidate.provenance.anchor_sha256)?;
        if let Some(floor) = &floor {
            candidate.provenance.check_advance(floor)?;
        }
        if let Some(previous) = AuthenticatedListings::stored(&transaction)?
            && (previous.provenance.anchor_sha256 != candidate.provenance.anchor_sha256
                || candidate.document.revision < previous.document.revision
                || (candidate.document.revision == previous.document.revision
                    && candidate.bytes != previous.bytes))
        {
            return Err(PortcoveError::verification(
                "listing revision replay, equivocation or authority change",
            ));
        }
        let now = Self::now();
        let (baseline, provenance) =
            crate::catalog_store::CatalogState::read(&transaction)?.resolve(now)?;
        let (catalog, _) =
            crate::catalog_store::resolve_before_listings(&transaction, baseline, provenance, now)?;
        candidate.document.project(catalog)?;
        candidate.provenance.require_fresh()?;
        let provenance = serde_json::to_string(&candidate.provenance)?;
        let document = std::str::from_utf8(&candidate.bytes)
            .map_err(|_| PortcoveError::verification("listing target must be UTF-8"))?;
        if !publish {
            // Dropping the transaction rolls it back; nothing was written.
            return Ok(candidate.status());
        }
        transaction.execute(
            "INSERT INTO listing_delivery(singleton,document_json,provenance_json) VALUES(1,?1,?2)
             ON CONFLICT(singleton) DO UPDATE SET document_json=excluded.document_json,provenance_json=excluded.provenance_json",
            params![document, provenance],
        )?;
        transaction.execute(
            "UPDATE definition_publisher_authority SET replay_floor_json=?1 WHERE anchor_sha256=?2",
            params![provenance, candidate.provenance.anchor_sha256],
        )?;
        transaction.commit()?;
        Ok(candidate.status())
    }
}

impl PortcoveService {
    /// A new service consumes the durable directory; this instance keeps its original snapshot.
    pub async fn refresh_listings(
        &self,
        source: &DefinitionRepositorySource,
        emit: impl FnMut(OperationEvent),
    ) -> Result<ListingDeliveryStatus> {
        let root = provisioning::installed_compiled_root(self.library())?;
        let transport = super::super::DefinitionHttpsTransport::new(source)?;
        refresh(self, source, root, transport, emit).await
    }
}

pub(crate) async fn refresh<T: Transport + Send + Sync + 'static>(
    service: &PortcoveService,
    source: &DefinitionRepositorySource,
    root: &[u8],
    transport: T,
    mut emit: impl FnMut(OperationEvent),
) -> Result<ListingDeliveryStatus> {
    let (activity, operation) = service.begin_cancellable_activity(
        ActivityOperation::UpdateCatalog,
        ActivityTargetKind::Library,
        None,
    )?;
    emit(operation.started());
    let result = tokio::time::timeout(super::super::ACQUISITION_TIMEOUT, async {
        let repository = operation
            .interruptible(super::super::load_repository(
                root,
                source.metadata_base_url.clone(),
                source.targets_base_url.clone(),
                transport,
            ))
            .await?;
        let (bytes, provenance) = operation
            .interruptible(super::acquire_target_with_limit(
                &repository,
                root,
                TARGET,
                MAX_BYTES as u64,
            ))
            .await?;
        let document = ListingDeliveryDocument::parse(&bytes)?;
        operation.checkpoint()?;
        operation.begin_publication()?;
        service.library().apply_listings(AuthenticatedListings {
            bytes,
            document,
            provenance,
        })
    })
    .await
    .unwrap_or_else(|_| {
        Err(PortcoveError::network(
            "listing refresh acquisition timed out",
        ))
    });
    let result = service.finish_activity(activity, result);
    emit(operation.finished(OperationResult::from_result(&result)));
    result
}

/// The scheduled refresh's acquisition: the same authenticated TUF path and
/// strict parser as `refresh`, followed by every admission check, with no
/// activity and no write. A candidate this client would refuse (outage, absent
/// or expired publication, bad signature, newer format, replay) records nothing.
pub(crate) async fn acquire_admissible(
    library: &Library,
    repository: &Repository,
    root: &[u8],
) -> Result<AuthenticatedListings> {
    let (bytes, provenance) =
        super::acquire_target_with_limit(repository, root, TARGET, MAX_BYTES as u64).await?;
    let document = ListingDeliveryDocument::parse(&bytes)?;
    let candidate = AuthenticatedListings {
        bytes,
        document,
        provenance,
    };
    library.check_listings(&candidate)?;
    Ok(candidate)
}

/// Publishes an already acquired and checked candidate through the ordinary
/// activity, cancellation and atomic admission owner.
pub(crate) fn publish_acquired(
    service: &PortcoveService,
    candidate: AuthenticatedListings,
    mut emit: impl FnMut(OperationEvent),
) -> Result<ListingDeliveryStatus> {
    let (activity, operation) = service.begin_cancellable_activity(
        ActivityOperation::UpdateCatalog,
        ActivityTargetKind::Library,
        None,
    )?;
    emit(operation.started());
    let result = (|| {
        operation.checkpoint()?;
        operation.begin_publication()?;
        service.library().apply_listings(candidate)
    })();
    let result = service.finish_activity(activity, result);
    emit(operation.finished(OperationResult::from_result(&result)));
    result
}

pub(crate) fn migrate(transaction: &rusqlite::Transaction<'_>) -> Result<()> {
    transaction.execute_batch(&format!(
        "CREATE TABLE listing_delivery(
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        document_json TEXT NOT NULL CHECK(length(CAST(document_json AS BLOB))<={MAX_BYTES}),
        provenance_json TEXT NOT NULL CHECK(length(CAST(provenance_json AS BLOB))<=16384));"
    ))?;
    Ok(())
}

#[cfg(test)]
pub(crate) async fn refresh_fixture<T: Transport + Send + Sync + 'static>(
    service: &PortcoveService,
    source: &DefinitionRepositorySource,
    root: &[u8],
    transport: T,
    emit: impl FnMut(OperationEvent),
) -> Result<ListingDeliveryStatus> {
    provisioning::installed_fixture_root(service.library(), root)?;
    refresh(service, source, root, transport, emit).await
}
