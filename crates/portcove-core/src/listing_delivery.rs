//! Descriptive directory delivery under the existing independent catalog policy role.
//! This target cannot create a managed definition, publisher grant or executable contract.
use std::collections::BTreeSet;

use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tough::Transport;

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
                Some(current) => *current = listing.clone(),
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
        }
    }
}

struct AuthenticatedListings {
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
        candidate.provenance.require_fresh()?;
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let floor = installed_authority_floor(&transaction, &candidate.provenance.anchor_sha256)?;
        if let Some(floor) = &floor {
            candidate.provenance.check_advance(floor)?;
        }
        if let Some(previous) = AuthenticatedListings::stored(&transaction)? {
            if previous.provenance.anchor_sha256 != candidate.provenance.anchor_sha256
                || candidate.document.revision < previous.document.revision
                || (candidate.document.revision == previous.document.revision
                    && candidate.bytes != previous.bytes)
            {
                return Err(PortcoveError::verification(
                    "listing revision replay, equivocation or authority change",
                ));
            }
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

async fn refresh<T: Transport + Send + Sync + 'static>(
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
