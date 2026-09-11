//! Immutable version-owned catalog semantics, bound by the install manifest digest.
//!
//! The legacy catalog projection is deliberately self-contained: retaining the
//! complete source graph avoids reconstructing referenced identity/validator or
//! evidence records from a later catalog. This records semantics, not new trust.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;

use crate::{Catalog, PortcoveError, Result};

// Cache only pure decoding of one exact format and bounded content string. Installation
// reads still verify the current manifest bytes and digest first;
// source admission, revocation policy and filesystem integrity are not cached.
static DECODED_CATALOG: Mutex<Option<(u32, String, Catalog)>> = Mutex::new(None);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct InstalledContract {
    format: u32,
    port_id: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    catalog_json: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    definition: Option<crate::definition_projection::DefinitionSnapshot>,
}

impl InstalledContract {
    pub(crate) fn port_id(&self) -> &str {
        &self.port_id
    }

    pub(crate) fn capture(catalog: &Catalog, port_id: &str) -> Result<Self> {
        catalog.port(port_id)?;
        let definition = catalog.definition_snapshot(port_id).cloned();
        let contract = Self {
            format: if definition.is_some() { 2 } else { 1 },
            port_id: port_id.into(),
            catalog_json: if definition.is_some() {
                String::new()
            } else {
                serde_json::to_string(&catalog.authoritative_document())?
            },
            definition,
        };
        contract.catalog(port_id)?;
        Ok(contract)
    }

    pub(crate) fn catalog(&self, port_id: &str) -> Result<Catalog> {
        if self.port_id != port_id
            || !matches!(
                (self.format, self.definition.as_ref()),
                (1, None) | (2, Some(_))
            )
            || (self.format == 2 && !self.catalog_json.is_empty())
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
        let cache_key = match &self.definition {
            Some(definition) => {
                definition.validate_bounds()?;
                if definition.port_id() != port_id {
                    return Err(PortcoveError::verification(
                        "retained indexed definition has a different port identity",
                    ));
                }
                serde_json::to_string(definition)?
            }
            None => self.catalog_json.clone(),
        };
        if let Ok(cache) = DECODED_CATALOG.lock()
            && let Some((format, content, catalog)) = cache.as_ref()
            && *format == self.format
            && content == &cache_key
        {
            catalog.port(port_id)?;
            return Ok(catalog.clone());
        }
        let catalog = match &self.definition {
            Some(definition) => definition.catalog()?,
            None => Catalog::from_json(&self.catalog_json)?,
        };
        catalog.port(port_id)?;
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
        if let Ok(mut cache) = DECODED_CATALOG.lock() {
            *cache = Some((self.format, cache_key, catalog.clone()));
        }
        Ok(catalog)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        future.format = 3;
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
            port_id: "zelda64-recomp".into(),
            catalog_json: serde_json::to_string(successor.definition.as_ref().unwrap()).unwrap(),
            definition: None,
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
