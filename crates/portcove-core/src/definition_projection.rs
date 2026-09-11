//! Lossless interpretation of a shared, terminal catalog contract.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;

use crate::{Catalog, DefinitionContentIndex, DefinitionEntryInspection, PortcoveError, Result};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProjectionDocument {
    contract_schema: u32,
    representation: String,
    catalog: Value,
}

/// Exact interpreted origin. Deserialization alone never establishes validity.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct DefinitionSnapshot {
    namespace: String,
    stable_id: String,
    index_json: String,
    entry_json: String,
    contract_json: String,
}

impl DefinitionSnapshot {
    pub(crate) fn port_id(&self) -> &str {
        &self.stable_id
    }

    pub(crate) fn validate_bounds(&self) -> Result<()> {
        if self.namespace.len() > 255
            || self.stable_id.len() > 255
            || self.index_json.len() > crate::definition_index::MAX_INDEX_BYTES
            || self.entry_json.len() as u64 > crate::definition_index::MAX_CONTENT_BYTES
            || self.contract_json.len() as u64 > crate::definition_index::MAX_CONTENT_BYTES
        {
            return Err(PortcoveError::verification(
                "retained definition exceeds its content bounds",
            ));
        }
        Ok(())
    }

    pub(crate) fn catalog(&self) -> Result<Catalog> {
        self.validate_bounds()?;
        let index = DefinitionContentIndex::parse(self.index_json.as_bytes())?;
        let projection = index.inspect_catalog_projection(
            &self.namespace,
            &self.stable_id,
            self.entry_json.as_bytes(),
            self.contract_json.as_bytes(),
        )?;
        Ok(projection.catalog)
    }
}

/// Validated supplied semantics, with no publisher authentication or operation grant.
/// Only the requested entry is represented; other ports in the retained catalog
/// supply a complete legacy contract graph, not additional indexed definitions.
#[derive(Debug)]
pub struct DefinitionCatalogProjection {
    entry: DefinitionEntryInspection,
    snapshot: Arc<DefinitionSnapshot>,
    catalog: Catalog,
}

impl DefinitionCatalogProjection {
    pub fn entry(&self) -> &DefinitionEntryInspection {
        &self.entry
    }

    pub fn contract_target(&self) -> &str {
        self.entry.execution_contract()
    }

    pub fn contract_bytes(&self) -> &[u8] {
        self.snapshot.contract_json.as_bytes()
    }

    /// Existing catalog validation establishes semantics, never publisher trust.
    pub fn catalog(&self) -> &Catalog {
        &self.catalog
    }
}

impl DefinitionContentIndex {
    /// Interpret one supported entry using the existing complete catalog contract.
    /// The index, entry and contract may all be untrusted supplied bytes. Callers
    /// must separately establish provenance, grants, freshness and selection.
    pub fn inspect_catalog_projection(
        &self,
        namespace: &str,
        stable_id: &str,
        entry_bytes: &[u8],
        contract_bytes: &[u8],
    ) -> Result<DefinitionCatalogProjection> {
        let entry = self.inspect_entry(namespace, stable_id, entry_bytes)?;
        if !entry.capabilities().compatible {
            return Err(PortcoveError::unsupported(
                "definition requires unsupported engine capabilities",
            ));
        }
        let target = entry.execution_contract();
        if entry.persistence_contract() != target
            || entry.source_contracts() != [target]
            || !entry.artifact_bindings().is_empty()
            || !entry.evidence_references().is_empty()
        {
            return Err(PortcoveError::unsupported(
                "catalog projection requires one shared source, execution and persistence leaf",
            ));
        }
        self.verify_content(target, contract_bytes)?;
        let value: crate::definition_entry::strict_json::UniqueValue =
            serde_json::from_slice(contract_bytes)?;
        let document: ProjectionDocument = serde_json::from_value(value.0)?;
        if document.contract_schema != 1 || document.representation != "catalog_projection" {
            return Err(PortcoveError::unsupported(
                "unsupported definition catalog projection contract",
            ));
        }
        let catalog_json = serde_json::to_string(&document.catalog)?;
        if catalog_json.len() > crate::signed_catalog::MAX_CATALOG_BYTES {
            return Err(PortcoveError::verification(
                "projected catalog exceeds its existing byte bound",
            ));
        }
        let mut catalog = Catalog::from_json(&catalog_json)?;
        if serde_json::to_value(catalog.authoritative_document())? != document.catalog {
            return Err(PortcoveError::verification(
                "catalog projection contains unsupported or incomplete semantics",
            ));
        }
        if serde_json::to_value(catalog.port(stable_id)?)? != serde_json::to_value(entry.port())? {
            return Err(PortcoveError::verification(
                "indexed port differs from its catalog projection contract",
            ));
        }
        let snapshot = Arc::new(DefinitionSnapshot {
            namespace: namespace.into(),
            stable_id: stable_id.into(),
            index_json: String::from_utf8(self.bytes().to_vec())
                .map_err(|_| PortcoveError::verification("definition index is not UTF-8"))?,
            entry_json: String::from_utf8(entry_bytes.to_vec())
                .map_err(|_| PortcoveError::verification("definition entry is not UTF-8"))?,
            contract_json: String::from_utf8(contract_bytes.to_vec())
                .map_err(|_| PortcoveError::verification("definition contract is not UTF-8"))?,
        });
        catalog.retain_definition_snapshot(Arc::clone(&snapshot));
        Ok(DefinitionCatalogProjection {
            entry,
            snapshot,
            catalog,
        })
    }
}

#[cfg(test)]
#[path = "definition_projection_tests.rs"]
mod tests;
