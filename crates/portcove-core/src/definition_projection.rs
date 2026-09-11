//! Lossless interpretation of a shared, terminal catalog contract.
use serde::Deserialize;
use serde_json::Value;

use crate::{Catalog, DefinitionContentIndex, DefinitionEntryInspection, PortcoveError, Result};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProjectionDocument {
    contract_schema: u32,
    representation: String,
    catalog: Value,
}

/// Validated supplied semantics, with no publisher authentication or operation grant.
/// Only the requested entry is represented; other ports in the retained catalog
/// supply a complete legacy contract graph, not additional indexed definitions.
#[derive(Debug)]
pub struct DefinitionCatalogProjection {
    entry: DefinitionEntryInspection,
    contract_bytes: Vec<u8>,
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
        &self.contract_bytes
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
        let catalog = Catalog::from_json(&catalog_json)?;
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
        Ok(DefinitionCatalogProjection {
            entry,
            contract_bytes: contract_bytes.to_vec(),
            catalog,
        })
    }
}

#[cfg(test)]
#[path = "definition_projection_tests.rs"]
mod tests;
