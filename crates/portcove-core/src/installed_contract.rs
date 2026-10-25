//! Immutable version-owned catalog semantics, bound by the install manifest digest.
//!
//! The legacy catalog projection is deliberately self-contained: retaining the
//! complete source graph avoids reconstructing referenced identity/validator or
//! evidence records from a later catalog. This records semantics, not new trust.

use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};

use crate::{Catalog, DefinitionSelectionIdentity, PortcoveError, Result};

// Keep the active and previous immutable interpretations without evicting each
// other on every rollback/status read. Keys retain the complete bounded bytes
// and format, never a mutable path or an authorization result. Installation reads
// still verify current manifest bytes/digests; policy and integrity stay fresh.
static DECODED_CATALOGS: Mutex<Vec<(u32, String, Catalog)>> = Mutex::new(Vec::new());
const DECODED_CATALOG_CAPACITY: usize = 2;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct InstalledContract {
    format: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    original_format: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    preparation_mode: Option<crate::PreparationMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    external_trust: Option<crate::ExternalRuntimeTrust>,
    port_id: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    catalog_json: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    definition: Option<crate::definition_projection::DefinitionSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    admission: Option<DefinitionSelectionIdentity>,
}

impl InstalledContract {
    pub(crate) fn port_id(&self) -> &str {
        &self.port_id
    }

    pub(crate) fn capture(catalog: &Catalog, port_id: &str) -> Result<Self> {
        catalog.port(port_id)?;
        let definition = catalog.definition_snapshot(port_id).cloned();
        let admission = catalog.definition_selection(port_id).cloned();
        let mut contract = Self {
            format: if admission.is_some() {
                3
            } else if definition.is_some() {
                2
            } else {
                1
            },
            original_format: None,
            preparation_mode: None,
            external_trust: None,
            port_id: port_id.into(),
            catalog_json: if definition.is_some() {
                String::new()
            } else {
                serde_json::to_string(&catalog.authoritative_document())?
            },
            definition,
            admission,
        };
        if catalog
            .port(port_id)?
            .release
            .user_prepared
            .values()
            .any(|runtime| runtime.trust == crate::ExternalRuntimeTrust::UserSelected)
        {
            contract.original_format = Some(contract.format);
            contract.format = 5;
            contract.external_trust = Some(crate::ExternalRuntimeTrust::UserSelected);
        } else if catalog.port(port_id)?.mod_package_policy.is_some() {
            contract.original_format = Some(contract.format);
            contract.format = 7;
        } else if crate::persistence::ready_staged_archive(catalog.port(port_id)?) {
            // Embedded/unscoped installs need the same old-reader fence as an
            // indexed capability. Do not rewrite existing retained contracts.
            contract.original_format = Some(contract.format);
            contract.format = 6;
        }
        contract.catalog(port_id)?;
        Ok(contract)
    }

    pub(crate) fn catalog(&self, port_id: &str) -> Result<Catalog> {
        let original_format = match (
            self.format,
            self.original_format,
            self.preparation_mode,
            self.external_trust,
        ) {
            (format @ 1..=3, None, None, None) => format,
            (4, Some(format @ 1..=3), Some(crate::PreparationMode::Ghostship200Legacy), None)
                if self.port_id == "ghostship" =>
            {
                format
            }
            (5, Some(format @ 1..=3), None, Some(crate::ExternalRuntimeTrust::UserSelected)) => {
                format
            }
            (6 | 7, Some(format @ 1..=3), None, None) => format,
            _ => {
                return Err(PortcoveError::verification(
                    "retained preparation interpretation is unsupported or malformed",
                ));
            }
        };
        if self.port_id != port_id
            || !matches!(
                (
                    original_format,
                    self.definition.as_ref(),
                    self.admission.as_ref()
                ),
                (1, None, None) | (2, Some(_), None) | (3, Some(_), Some(_))
            )
            || (original_format >= 2 && !self.catalog_json.is_empty())
        {
            return Err(PortcoveError::verification(
                "retained definition contract does not match this installation",
            ));
        }
        if self.catalog_json.len() > crate::signed_catalog::MAX_CATALOG_BYTES {
            return Err(PortcoveError::verification(
                "retained definition contract exceeds the supported content bound",
            ));
        }
        let mut cache_key = match &self.definition {
            Some(definition) => {
                definition.validate_bounds()?;
                if definition.port_id() != port_id {
                    return Err(PortcoveError::verification(
                        "retained indexed definition has a different port identity",
                    ));
                }
                serde_json::to_string(&(definition, &self.admission))?
            }
            None => self.catalog_json.clone(),
        };
        if matches!(self.format, 4..=7) {
            cache_key = serde_json::to_string(&(
                self.original_format,
                self.preparation_mode,
                self.external_trust,
                cache_key,
            ))?;
        }
        if let Ok(mut cache) = DECODED_CATALOGS.lock()
            && let Some(index) = cache
                .iter()
                .position(|(format, content, _)| *format == self.format && content == &cache_key)
        {
            let entry = cache.remove(index);
            let catalog = entry.2.clone();
            cache.push(entry);
            catalog.port(port_id)?;
            self.require_metadata_semantics(&catalog)?;
            return Ok(catalog);
        }
        let mut catalog = match &self.definition {
            Some(definition) => definition.catalog()?,
            None => Catalog::from_json(&self.catalog_json)?,
        };
        if let Some(admission) = &self.admission {
            catalog.retain_definition_selection(Arc::new(admission.clone()))?;
        }
        catalog.port(port_id)?;
        self.require_metadata_semantics(&catalog)?;
        if self.format == 5
            && !catalog
                .port(port_id)?
                .release
                .user_prepared
                .values()
                .any(|runtime| runtime.trust == crate::ExternalRuntimeTrust::UserSelected)
        {
            return Err(PortcoveError::verification(
                "retained user-selection envelope has no matching trust semantics",
            ));
        }
        // Format 1 stores canonical legacy semantics. Format 2 already ran the
        // strict indexed interpreter; neither route may discard unknown fields.
        if self.definition.is_none()
            && serde_json::from_str::<serde_json::Value>(&self.catalog_json)?
                != serde_json::to_value(catalog.authoritative_document())?
        {
            return Err(PortcoveError::verification(
                "retained definition contains unsupported or noncanonical semantics",
            ));
        }
        if let Ok(mut cache) = DECODED_CATALOGS.lock() {
            // Another reader may have completed the same pure interpretation
            // while this one validated outside the lock.
            cache.retain(|(format, content, _)| *format != self.format || content != &cache_key);
            if cache.len() == DECODED_CATALOG_CAPACITY {
                cache.remove(0);
            }
            cache.push((self.format, cache_key, catalog.clone()));
        }
        Ok(catalog)
    }

    fn require_metadata_semantics(&self, catalog: &Catalog) -> Result<()> {
        if (self.format == 7) != catalog.port(&self.port_id)?.mod_package_policy.is_some() {
            return Err(PortcoveError::verification(
                "versioned mod package semantics require their retained interpretation envelope",
            ));
        }
        if self.format == 6
            && !crate::persistence::ready_staged_archive(catalog.port(&self.port_id)?)
        {
            return Err(PortcoveError::verification(
                "retained metadata-preserving envelope has no matching ready archive semantics",
            ));
        }
        Ok(())
    }

    /// Preserve the exact verified origin; never recapture authority from a catalog clone.
    pub(crate) fn for_ghostship_legacy_preparation(&self) -> Result<Self> {
        self.catalog("ghostship")?;
        if self.format == 4
            && self.preparation_mode == Some(crate::PreparationMode::Ghostship200Legacy)
        {
            // Rebinding the identical reviewed original preserves this single
            // interpretation, never another envelope around format 4.
            return Ok(self.clone());
        }
        if !matches!(self.format, 1..=3) {
            return Err(PortcoveError::verification(
                "legacy preparation cannot wrap an already prepared interpretation",
            ));
        }
        let mut prepared = self.clone();
        prepared.original_format = Some(self.format);
        prepared.preparation_mode = Some(crate::PreparationMode::Ghostship200Legacy);
        prepared.format = 4;
        prepared.catalog("ghostship")?;
        Ok(prepared)
    }

    pub(crate) fn preparation_mode(&self) -> Option<crate::PreparationMode> {
        self.preparation_mode
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versioned_mod_envelope_preserves_all_origins_and_refuses_downgrades() {
        let original = crate::test_fixture::versioned_mod_catalog();
        let id = &original.ports()[0].id;
        for catalog in [
            original.clone(),
            crate::test_fixture::indexed_catalog(&original, id),
            crate::test_fixture::admitted_indexed_catalog(&original, id),
        ] {
            let captured = InstalledContract::capture(&catalog, id).unwrap();
            assert_eq!(captured.format, 7);
            let bytes = serde_json::to_vec(&captured).unwrap();
            let decoded: InstalledContract = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(
                serde_json::to_vec(
                    &InstalledContract::capture(&decoded.catalog(id).unwrap(), id).unwrap()
                )
                .unwrap(),
                bytes
            );
            for format in [1, 2, 3, 6] {
                let mut downgraded = decoded.clone();
                downgraded.format = format;
                if format < 4 {
                    downgraded.original_format = None;
                }
                assert!(downgraded.catalog(id).is_err());
                decoded.catalog(id).unwrap(); // rejected envelopes cannot poison a warm cache
            }
        }
        let mut old = original.authoritative_document();
        old.ports[0].mod_package_policy = None;
        let old = Catalog::from_json(&serde_json::to_string(&old).unwrap()).unwrap();
        let captured = InstalledContract::capture(&old, id).unwrap();
        assert_eq!(captured.format, 6);
        assert!(
            !serde_json::to_string(&captured)
                .unwrap()
                .contains("mod_package_policy")
        );
        captured.catalog(id).unwrap();
        let mut wrong = captured;
        wrong.format = 7;
        assert!(wrong.catalog(id).is_err());
    }

    #[test]
    fn ready_archive_metadata_fence_preserves_origins_without_rewriting_history() {
        let embedded = Catalog::embedded().unwrap();
        for id in ["alariq-mc2", "crash-team-racing-ctr-native"] {
            for catalog in [
                embedded.clone(),
                crate::test_fixture::indexed_catalog(&embedded, id),
                crate::test_fixture::admitted_indexed_catalog(&embedded, id),
            ] {
                let contract = InstalledContract::capture(&catalog, id).unwrap();
                let value = serde_json::to_value(&contract).unwrap();
                assert_eq!(value["format"], 6);
                assert!(matches!(contract.original_format, Some(1..=3)));
                contract.catalog(id).unwrap();
                let mut historical = contract.clone();
                historical.format = historical.original_format.take().unwrap();
                historical.catalog(id).unwrap();
                assert_eq!(
                    historical.format,
                    value["original_format"].as_u64().unwrap() as u32
                );
                for invalid in [None, Some(4), Some(5), Some(6)] {
                    let mut malformed = contract.clone();
                    malformed.original_format = invalid;
                    assert!(malformed.catalog(id).is_err());
                }
            }
        }
        // A raw catalog shares its complete projection across identities. Even
        // a warmed decode cache must not confer this envelope on another route.
        let _ = InstalledContract::capture(&embedded, "alariq-mc2").unwrap();
        let mut wrong = InstalledContract::capture(&embedded, "fragglet-sdl-sopwith").unwrap();
        wrong.original_format = Some(wrong.format);
        wrong.format = 6;
        assert!(wrong.catalog("fragglet-sdl-sopwith").is_err());
    }

    #[test]
    fn legacy_preparation_preserves_all_three_verified_origins_and_rejects_invalid_envelopes() {
        let embedded = Catalog::embedded().unwrap();
        for catalog in [
            embedded.clone(),
            crate::test_fixture::indexed_catalog(&embedded, "ghostship"),
            crate::test_fixture::admitted_indexed_catalog(&embedded, "ghostship"),
        ] {
            let original = InstalledContract::capture(&catalog, "ghostship").unwrap();
            let before = serde_json::to_value(&original).unwrap();
            assert!(before.get("original_format").is_none());
            assert!(before.get("preparation_mode").is_none());
            let prepared = original.for_ghostship_legacy_preparation().unwrap();
            let after = serde_json::to_value(&prepared).unwrap();
            assert_eq!(after["format"], 4);
            assert_eq!(after["original_format"], before["format"]);
            for field in ["catalog_json", "definition", "admission", "port_id"] {
                assert_eq!(before.get(field), after.get(field), "{field}");
            }
            assert_eq!(
                serde_json::to_value(
                    prepared
                        .catalog("ghostship")
                        .unwrap()
                        .authoritative_document()
                )
                .unwrap(),
                serde_json::to_value(
                    original
                        .catalog("ghostship")
                        .unwrap()
                        .authoritative_document()
                )
                .unwrap()
            );
            assert_eq!(
                serde_json::to_value(prepared.for_ghostship_legacy_preparation().unwrap()).unwrap(),
                after
            );
            for (field, value) in [
                ("original_format", serde_json::Value::Null),
                ("original_format", serde_json::json!(4)),
                ("preparation_mode", serde_json::Value::Null),
                ("preparation_mode", serde_json::json!("default")),
                ("port_id", serde_json::json!("shipwright")),
            ] {
                let mut malformed = after.clone();
                malformed[field] = value;
                let decoded: InstalledContract = serde_json::from_value(malformed).unwrap();
                assert!(decoded.catalog("ghostship").is_err(), "{field}");
                // A rejected envelope cannot poison the pure decode cache.
                prepared.catalog("ghostship").unwrap();
            }
            let mut downgraded = prepared.clone();
            downgraded.format = original.format;
            assert!(downgraded.catalog("ghostship").is_err());
            let mut mode_on_original = original.clone();
            mode_on_original.preparation_mode = Some(crate::PreparationMode::Ghostship200Legacy);
            assert!(mode_on_original.catalog("ghostship").is_err());
            assert_eq!(serde_json::to_value(&original).unwrap(), before);
        }
        assert!(
            InstalledContract::capture(&embedded, "shipwright")
                .unwrap()
                .for_ghostship_legacy_preparation()
                .is_err()
        );
    }

    #[test]
    fn retained_initial_renderer_does_not_follow_later_catalog_choices() {
        let current = Catalog::embedded().unwrap();
        let mut legacy_document = current.authoritative_document();
        legacy_document
            .ports
            .iter_mut()
            .find(|port| port.id == "dr-mario-64-recomp")
            .unwrap()
            .n64_windows_initial_d3d12 = false;
        let legacy = Catalog::from_json(&serde_json::to_string(&legacy_document).unwrap()).unwrap();
        let contracts = [(&legacy, false), (&current, true)].map(|(catalog, expected)| {
            let captured = InstalledContract::capture(catalog, "dr-mario-64-recomp").unwrap();
            let restored: InstalledContract =
                serde_json::from_slice(&serde_json::to_vec(&captured).unwrap()).unwrap();
            (restored, expected)
        });
        // Alternate active/previous semantics through repeated reads. A cached
        // interpretation cannot follow the most recently decoded catalog.
        for index in [0, 1, 0, 1] {
            let (restored, expected) = &contracts[index];
            assert_eq!(
                restored
                    .catalog("dr-mario-64-recomp")
                    .unwrap()
                    .port("dr-mario-64-recomp")
                    .unwrap()
                    .n64_windows_initial_d3d12,
                *expected
            );
        }
    }

    #[test]
    fn exact_successor_bytes_survive_decode_and_recapture_without_canonical_replacement() {
        let original = Catalog::embedded().unwrap();
        let catalog = crate::test_fixture::indexed_catalog(&original, "zelda64-recomp");
        let contract = InstalledContract::capture(&catalog, "zelda64-recomp").unwrap();
        let bytes = serde_json::to_vec(&contract).unwrap();
        let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["format"], 2);
        assert!(value.get("catalog_json").is_none());
        for field in ["index_json", "entry_json", "contract_json"] {
            assert!(value["definition"][field].as_str().unwrap().contains('\n'));
        }
        let decoded: InstalledContract = serde_json::from_slice(&bytes).unwrap();
        let restored = decoded.catalog("zelda64-recomp").unwrap();
        assert_eq!(
            serde_json::to_value(restored.authoritative_document()).unwrap(),
            serde_json::to_value(original.authoritative_document()).unwrap()
        );
        assert_eq!(
            serde_json::to_vec(&InstalledContract::capture(&restored, "zelda64-recomp").unwrap())
                .unwrap(),
            bytes
        );
        // An unselected port in the shared legacy graph never inherits this entry.
        let other = InstalledContract::capture(&catalog, "shipwright").unwrap();
        assert_eq!(other.format, 1);
        assert!(other.definition.is_none());
    }

    #[test]
    fn successor_records_reject_changed_bytes_identities_formats_and_mixed_authorities() {
        let catalog =
            crate::test_fixture::indexed_catalog(&Catalog::embedded().unwrap(), "zelda64-recomp");
        let contract = InstalledContract::capture(&catalog, "zelda64-recomp").unwrap();
        let original = serde_json::to_value(&contract).unwrap();
        for field in ["entry_json", "contract_json"] {
            let mut changed = original.clone();
            let text = changed["definition"][field].as_str().unwrap().to_owned() + " ";
            changed["definition"][field] = serde_json::json!(text);
            let decoded: InstalledContract = serde_json::from_value(changed).unwrap();
            assert!(decoded.catalog("zelda64-recomp").is_err());
        }
        for field in ["namespace", "stable_id"] {
            let mut changed = original.clone();
            changed["definition"][field] = serde_json::json!("wrong-identity");
            let decoded: InstalledContract = serde_json::from_value(changed).unwrap();
            assert!(decoded.catalog("zelda64-recomp").is_err());
        }
        let mut mixed = contract.clone();
        mixed.catalog_json = serde_json::to_string(&catalog.authoritative_document()).unwrap();
        assert!(mixed.catalog("zelda64-recomp").is_err());
        let mut downgraded = contract.clone();
        downgraded.format = 1;
        assert!(downgraded.catalog("zelda64-recomp").is_err());
        let mut missing = contract.clone();
        missing.definition = None;
        assert!(missing.catalog("zelda64-recomp").is_err());
        let mut future = contract;
        future.format = 4;
        assert!(future.catalog("zelda64-recomp").is_err());
        let mut unknown = original;
        unknown["definition"]["trusted"] = serde_json::json!(true);
        assert!(serde_json::from_value::<InstalledContract>(unknown).is_err());
    }

    #[test]
    fn cache_never_confuses_a_successor_snapshot_with_legacy_catalog_content() {
        let catalog =
            crate::test_fixture::indexed_catalog(&Catalog::embedded().unwrap(), "zelda64-recomp");
        let successor = InstalledContract::capture(&catalog, "zelda64-recomp").unwrap();
        successor.catalog("zelda64-recomp").unwrap();
        let impostor = InstalledContract {
            format: 1,
            original_format: None,
            preparation_mode: None,
            external_trust: None,
            port_id: "zelda64-recomp".into(),
            catalog_json: serde_json::to_string(successor.definition.as_ref().unwrap()).unwrap(),
            definition: None,
            admission: None,
        };
        assert!(impostor.catalog("zelda64-recomp").is_err());
        assert!(successor.catalog("zelda64-recomp").is_ok());
    }

    #[test]
    fn successor_content_bounds_and_index_agreement_are_rechecked_before_reuse() {
        let catalog =
            crate::test_fixture::indexed_catalog(&Catalog::embedded().unwrap(), "zelda64-recomp");
        let contract = InstalledContract::capture(&catalog, "zelda64-recomp").unwrap();
        let original = serde_json::to_value(&contract).unwrap();
        for field in ["index_json", "entry_json", "contract_json"] {
            let mut changed = original.clone();
            changed["definition"][field] =
                serde_json::json!(" ".repeat(crate::definition_index::MAX_INDEX_BYTES + 1));
            let decoded: InstalledContract = serde_json::from_value(changed).unwrap();
            assert!(
                decoded
                    .catalog("zelda64-recomp")
                    .unwrap_err()
                    .message
                    .contains("bounds")
            );
        }
        let mut changed = original;
        let mut index: serde_json::Value =
            serde_json::from_str(changed["definition"]["index_json"].as_str().unwrap()).unwrap();
        index["definitions"][0]["revision"] = serde_json::json!(8);
        changed["definition"]["index_json"] =
            serde_json::json!(serde_json::to_string(&index).unwrap());
        let decoded: InstalledContract = serde_json::from_value(changed).unwrap();
        assert!(
            decoded
                .catalog("zelda64-recomp")
                .unwrap_err()
                .message
                .contains("identity differs")
        );
    }

    #[test]
    fn retention_keeps_complete_catalog_and_source_graph_before_later_edits() {
        let original = Catalog::embedded().unwrap();
        let contract = InstalledContract::capture(&original, "zelda64-recomp").unwrap();
        let mut changed = original.authoritative_document();
        let port = changed
            .ports
            .iter_mut()
            .find(|port| port.id == "zelda64-recomp")
            .unwrap();
        port.persistent_paths.push("replacement-saves".into());
        port.launch_arguments = vec!["changed-argument".into()];
        let changed = Catalog::from_json(&serde_json::to_string(&changed).unwrap()).unwrap();
        let retained = contract.catalog("zelda64-recomp").unwrap();
        assert_eq!(
            serde_json::to_value(retained.authoritative_document()).unwrap(),
            serde_json::to_value(original.authoritative_document()).unwrap()
        );
        assert_ne!(
            retained.port("zelda64-recomp").unwrap().persistent_paths,
            changed.port("zelda64-recomp").unwrap().persistent_paths
        );
        assert_ne!(
            retained.port("zelda64-recomp").unwrap().launch_arguments,
            changed.port("zelda64-recomp").unwrap().launch_arguments
        );
    }

    #[test]
    fn retained_content_rejects_unknown_semantics_identity_and_resource_overflow() {
        let catalog = Catalog::embedded().unwrap();
        let contract = InstalledContract::capture(&catalog, "shipwright").unwrap();
        assert!(contract.catalog("starship").is_err());
        let mut unknown = contract.clone();
        let mut value: serde_json::Value = serde_json::from_str(&unknown.catalog_json).unwrap();
        value["ports"][0]["arbitrary_setup_script"] = serde_json::json!("unrecognized");
        unknown.catalog_json = serde_json::to_string(&value).unwrap();
        assert!(
            unknown
                .catalog("shipwright")
                .unwrap_err()
                .message
                .contains("unsupported")
        );
        let mut future = contract.clone();
        future.format = 2;
        assert!(future.catalog("shipwright").is_err());
        let mut oversized = contract;
        oversized.catalog_json = " ".repeat(crate::signed_catalog::MAX_CATALOG_BYTES + 1);
        assert!(
            oversized
                .catalog("shipwright")
                .unwrap_err()
                .message
                .contains("bound")
        );
    }
}
