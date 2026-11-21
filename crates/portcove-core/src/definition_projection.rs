//! Lossless interpretation of a shared, terminal catalog contract.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::HashMap, sync::Arc};

use crate::{Catalog, DefinitionContentIndex, DefinitionEntryInspection, PortcoveError, Result};

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ProjectionDocument {
    contract_schema: u32,
    representation: String,
    catalog: Value,
}

impl ProjectionDocument {
    fn validated_catalog(&self) -> Result<Catalog> {
        let catalog_json = serde_json::to_string(&self.catalog)?;
        if catalog_json.len() > crate::signed_catalog::MAX_CATALOG_BYTES {
            return Err(PortcoveError::verification(
                "projected catalog exceeds its existing byte bound",
            ));
        }
        let catalog = Catalog::from_json(&catalog_json)?;
        if catalog
            .ports()
            .iter()
            .any(|port| port.release.reviewed_package_choices_v2.is_some())
        {
            return Err(PortcoveError::unsupported(
                "indexed catalog projections cannot deliver reviewed package choices",
            ));
        }
        for port in catalog.ports() {
            if port.upstream_active_reviewed && self.contract_schema < 2 {
                return Err(PortcoveError::unsupported(
                    "a reviewed active project requires indexed catalog projection schema 2",
                ));
            }
            crate::definition_entry::require_indexed_persistence(port)?;
        }
        Ok(catalog)
    }
}

/// Materializes one proposed port's exact typed contract without opening a library.
pub fn canonical_definition_projection(path: &std::path::Path) -> Result<String> {
    let limit = crate::definition_index::MAX_CONTENT_BYTES;
    let bytes = crate::path::read_bounded_regular(path, limit)?;
    let value: crate::definition_entry::strict_json::UniqueValue = serde_json::from_slice(&bytes)?;
    let mut document: ProjectionDocument = serde_json::from_value(value.0)?;
    if !matches!(document.contract_schema, 1 | 2 | 3)
        || document.representation != "catalog_projection"
    {
        return Err(PortcoveError::unsupported(
            "unsupported definition catalog projection contract",
        ));
    }
    let catalog = document.validated_catalog()?;
    if catalog.ports().len() != 1 {
        return Err(PortcoveError::usage(
            "definition projection preparation requires exactly one port",
        ));
    }
    if catalog.ports()[0].mod_loader.is_some() && document.contract_schema != 3 {
        return Err(PortcoveError::verification(
            "native mod loader bindings require catalog projection schema 3",
        ));
    }
    let typed = serde_json::to_value(catalog.authoritative_document())?;
    if !retains_authored_fields(&document.catalog, &typed) {
        return Err(PortcoveError::verification(
            "canonical projection would omit or change authored fields",
        ));
    }
    document.catalog = typed;
    let output = format!("{}\n", serde_json::to_string_pretty(&document)?);
    if output.len() as u64 > limit {
        return Err(PortcoveError::verification(
            "canonical projection exceeds its byte bound",
        ));
    }
    Ok(output)
}

fn retains_authored_fields(authored: &Value, typed: &Value) -> bool {
    match (authored, typed) {
        (Value::Object(authored), Value::Object(typed)) => authored.iter().all(|(name, value)| {
            typed
                .get(name)
                .is_some_and(|field| retains_authored_fields(value, field))
        }),
        (Value::Array(authored), Value::Array(typed)) => {
            authored.len() == typed.len()
                && authored
                    .iter()
                    .zip(typed)
                    .all(|(a, b)| retains_authored_fields(a, b))
        }
        _ => authored == typed,
    }
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
    pub(crate) fn namespace(&self) -> &str {
        &self.namespace
    }

    pub(crate) fn port_id(&self) -> &str {
        &self.stable_id
    }

    pub(crate) fn index_sha256(&self) -> String {
        use sha2::{Digest, Sha256};
        hex::encode(Sha256::digest(self.index_json.as_bytes()))
    }

    pub(crate) fn validate_bounds(&self) -> Result<()> {
        if self.namespace.len() > 255
            || self.stable_id.len() > 255
            || self.index_json.len() > crate::definition_index::MAX_INDEX_BYTES
            || self.entry_json.len() > crate::definition_index::MAX_ENTRY_BYTES
            || self.contract_json.len() as u64 > crate::definition_index::MAX_CONTENT_BYTES
        {
            return Err(PortcoveError::verification(
                "retained definition exceeds its content bounds",
            ));
        }
        Ok(())
    }

    pub(crate) fn catalog(&self) -> Result<Catalog> {
        Ok(self.projection()?.catalog)
    }

    pub(crate) fn projection(&self) -> Result<DefinitionCatalogProjection> {
        self.validate_bounds()?;
        let index = DefinitionContentIndex::parse(self.index_json.as_bytes())?;
        index.inspect_retained_catalog_projection(
            &self.namespace,
            &self.stable_id,
            self.entry_json.as_bytes(),
            self.contract_json.as_bytes(),
        )
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

    pub(crate) fn catalog_for_selection(&self, baseline: &Catalog) -> Result<Catalog> {
        let selected = self.snapshot.port_id();
        let schema = self.catalog.document().schema_version;
        let legacy_addition = schema == 2 && baseline.port(selected).is_err();
        // A complete one-port catalog keeps the same transition checks as a
        // complete multi-port catalog, including source graph ordering.
        let sparse_schema_three =
            schema == 3 && baseline.ports().iter().any(|port| port.id != selected);
        let legacy_layout_correction = schema == 2
            && baseline.document().schema_version == 3
            && self.is_legacy_layout_correction(baseline, selected)?;
        let mut catalog = if self.catalog.ports().len() == 1
            && baseline.document().schema_version == 3
            && (sparse_schema_three || legacy_addition || legacy_layout_correction)
        {
            // A single-port projection supplies only its admitted contract.
            // Keep the baseline's catalog and unrelated source graph.
            let mut supplied = self.catalog.authoritative_document();
            let port = supplied
                .ports
                .pop()
                .ok_or_else(|| PortcoveError::state("projected port is missing"))?;
            let mut document = baseline.authoritative_document();
            let sources = document
                .source_catalog
                .as_mut()
                .ok_or_else(|| PortcoveError::state("baseline catalog source graph is missing"))?;
            let crate::SourceCatalog {
                evidence,
                identities,
                contracts,
                validators,
                qualification,
            } = supplied
                .source_catalog
                .ok_or_else(|| PortcoveError::state("projected catalog source graph is missing"))?;
            if let Some(previous) = document
                .ports
                .iter_mut()
                .find(|previous| previous.id == selected)
            {
                *previous = port;
                sources
                    .contracts
                    .retain(|contract| contract.port_id != selected);
                sources
                    .qualification
                    .retain(|record| record.scope.port_id != selected);
            } else {
                document.ports.push(port);
            }
            if sparse_schema_three {
                extend_shared_source_records(&mut sources.evidence, evidence, |record| &record.id)?;
                extend_shared_source_records(&mut sources.identities, identities, |record| {
                    &record.id
                })?;
                extend_shared_source_records(&mut sources.validators, validators, |record| {
                    &record.id
                })?;
            } else {
                // Keep the legacy new-port contract's duplicate-ID checks.
                sources.evidence.extend(evidence);
                sources.identities.extend(identities);
                sources.validators.extend(validators);
            }
            sources.contracts.extend(contracts);
            sources.qualification.extend(qualification);
            let mut catalog = Catalog::from_document(document)?;
            catalog.retain_definition_snapshot(Arc::clone(&self.snapshot), self.entry.revision());
            catalog
        } else {
            self.catalog.clone()
        };
        catalog.retain_embedded_file_patterns(baseline, selected)?;
        catalog.retain_unrelated_upstream_reviews(baseline, selected);
        crate::definition_loader::validate_definition_transition(baseline, &catalog, selected)?;
        Ok(catalog)
    }

    // A legacy schema-2 singleton could initially add a subject that a later
    // build embeds. Allow its reviewed layout to carry forward without giving
    // the older projection authority to replace other fields or source records.
    fn is_legacy_layout_correction(&self, baseline: &Catalog, selected: &str) -> Result<bool> {
        let ([next], Ok(previous), Some(supplied), Some(prior)) = (
            self.catalog.ports(),
            baseline.port(selected),
            self.catalog.source_catalog(),
            baseline.source_catalog(),
        ) else {
            return Ok(false);
        };
        if next.reviewed_package_layouts.is_empty()
            || !supplied.evidence.is_empty()
            || !supplied.identities.is_empty()
            || !supplied.contracts.is_empty()
            || !supplied.validators.is_empty()
            || !supplied.qualification.is_empty()
            || previous.source_profile.is_some()
            || previous.bios_source_profile.is_some()
            || prior
                .contracts
                .iter()
                .any(|record| record.port_id == selected)
            || prior
                .qualification
                .iter()
                .any(|record| record.scope.port_id == selected)
        {
            return Ok(false);
        }
        let mut previous = previous.clone();
        previous.reviewed_package_layouts = next.reviewed_package_layouts.clone();
        Ok(serde_json::to_value(next)? == serde_json::to_value(previous)?)
    }

    pub(crate) fn snapshot(&self) -> &DefinitionSnapshot {
        &self.snapshot
    }
}

fn extend_shared_source_records<T: PartialEq>(
    baseline: &mut Vec<T>,
    supplied: Vec<T>,
    id: impl Fn(&T) -> &str,
) -> Result<()> {
    let existing: HashMap<_, _> = baseline.iter().map(|record| (id(record), record)).collect();
    let mut added = Vec::new();
    for record in supplied {
        match existing.get(id(&record)) {
            Some(previous) if *previous != &record => {
                return Err(PortcoveError::conflict(format!(
                    "projected source record conflicts with the baseline: {}",
                    id(&record)
                )));
            }
            Some(_) => {}
            None => added.push(record),
        }
    }
    baseline.extend(added);
    Ok(())
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
        self.inspect_catalog_projection_mode(
            namespace,
            stable_id,
            entry_bytes,
            contract_bytes,
            false,
        )
    }

    pub(crate) fn inspect_retained_catalog_projection(
        &self,
        namespace: &str,
        stable_id: &str,
        entry_bytes: &[u8],
        contract_bytes: &[u8],
    ) -> Result<DefinitionCatalogProjection> {
        self.inspect_catalog_projection_mode(
            namespace,
            stable_id,
            entry_bytes,
            contract_bytes,
            true,
        )
    }

    fn inspect_catalog_projection_mode(
        &self,
        namespace: &str,
        stable_id: &str,
        entry_bytes: &[u8],
        contract_bytes: &[u8],
        retained: bool,
    ) -> Result<DefinitionCatalogProjection> {
        let entry = if retained {
            self.inspect_retained_entry(namespace, stable_id, entry_bytes)?
        } else {
            self.inspect_entry(namespace, stable_id, entry_bytes)?
        };
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
        if document.contract_schema != entry.schema_version()
            || document.representation != "catalog_projection"
        {
            return Err(PortcoveError::unsupported(
                "unsupported definition catalog projection contract",
            ));
        }
        let mut catalog = document.validated_catalog()?;
        let port = catalog.port(stable_id)?;
        if let Some(sources) = catalog.source_catalog() {
            for contract in sources
                .contracts
                .iter()
                .filter(|contract| contract.variant_list_recognition_only)
            {
                if contract.port_id != stable_id {
                    return Err(PortcoveError::verification(
                        "optional original recognition must belong to the selected definition",
                    ));
                }
                let (template, minimum) =
                    crate::definition_capabilities::original_recognition_capability(port.adapter)
                        .ok_or_else(|| {
                        PortcoveError::unsupported(
                            "the selected adapter has no optional original recognition capability",
                        )
                    })?;
                if !entry.capabilities().checks.iter().any(|check| {
                    check.requirement.template == template
                        && check.requirement.minimum_version >= minimum
                }) {
                    return Err(PortcoveError::verification(format!(
                        "optional original recognition requires {template} capability version {minimum}",
                    )));
                }
            }
        }
        if let Some(sources) = catalog.source_catalog() {
            for contract in sources
                .contracts
                .iter()
                .filter(|contract| !contract.n64_recomp_inputs_v1.is_empty())
            {
                if contract.port_id != stable_id
                    || !entry.capabilities().checks.iter().any(|check| {
                        check.requirement.template == "n64-recomp-portable"
                        && check.requirement.minimum_version
                            >= crate::definition_capabilities::N64_RECOMP_RELEASE_INPUT_CAPABILITY
                    })
                {
                    return Err(PortcoveError::verification(
                        "N64 release input requires the selected definition and its release-input reader capability",
                    ));
                }
            }
        }
        // Track counts live in the source profile, so only the projection can
        // tell that the entry's disc set needs a reader that keeps every track.
        if catalog.requires_psx_multi_track_set(port)
            && !entry.capabilities().checks.iter().any(|check| {
                check.requirement.template == "psx-recomp-managed"
                    && check.requirement.minimum_version
                        >= crate::adapter::PSX_MULTI_TRACK_SET_CAPABILITY
            })
        {
            return Err(PortcoveError::verification(format!(
                "managed PS1 disc sets with more than one track per disc require capability version {}",
                crate::adapter::PSX_MULTI_TRACK_SET_CAPABILITY
            )));
        }
        // The representation kind lives in the source catalog, so only the
        // projection can tell that its admission needs the copier-header reader.
        if catalog.snes_copier_header_profile(port) != crate::catalog::SnesCopierHeaderUse::None
            && !entry.capabilities().checks.iter().any(|check| {
                check.requirement.template == "staged-source-portable"
                    && check.requirement.minimum_version
                        >= crate::adapter::SNES_COPIER_HEADER_CAPABILITY
            })
        {
            return Err(PortcoveError::verification(
                "copier-header-optional SNES sources require staged-source capability version 36",
            ));
        }
        if serde_json::to_value(catalog.authoritative_document())? != document.catalog {
            return Err(PortcoveError::verification(
                "catalog projection contains unsupported or incomplete semantics",
            ));
        }
        if serde_json::to_value(port)? != serde_json::to_value(entry.port())? {
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
        catalog.retain_definition_snapshot(Arc::clone(&snapshot), entry.revision());
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
