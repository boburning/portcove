//! Immutable version-owned catalog semantics, bound by the install manifest digest.
//!
//! The legacy catalog projection is deliberately self-contained: retaining the
//! complete source graph avoids reconstructing referenced identity/validator or
//! evidence records from a later catalog. This records semantics, not new trust.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;

use crate::{Catalog, PortcoveError, Result};

// Cache only pure decoding of one exact bounded content string. Installation
// reads still verify the current manifest bytes and digest first;
// source admission, revocation policy and filesystem integrity are not cached.
static DECODED_CATALOG: Mutex<Option<(String, Catalog)>> = Mutex::new(None);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct InstalledContract {
    format: u32,
    port_id: String,
    catalog_json: String,
}

impl InstalledContract {
    pub(crate) fn port_id(&self) -> &str {
        &self.port_id
    }

    pub(crate) fn capture(catalog: &Catalog, port_id: &str) -> Result<Self> {
        catalog.port(port_id)?;
        let contract = Self {
            format: 1,
            port_id: port_id.into(),
            catalog_json: serde_json::to_string(&catalog.authoritative_document())?,
        };
        contract.catalog(port_id)?;
        Ok(contract)
    }

    pub(crate) fn catalog(&self, port_id: &str) -> Result<Catalog> {
        if self.format != 1 || self.port_id != port_id {
            return Err(PortcoveError::verification(
                "retained definition contract does not match this installation",
            ));
        }
        if self.catalog_json.len() > crate::signed_catalog::MAX_CATALOG_BYTES {
            return Err(PortcoveError::verification(
                "retained definition contract exceeds the supported content bound",
            ));
        }
        if let Ok(cache) = DECODED_CATALOG.lock()
            && let Some((content, catalog)) = cache.as_ref()
            && content == &self.catalog_json
        {
            catalog.port(port_id)?;
            return Ok(catalog.clone());
        }
        let catalog = Catalog::from_json(&self.catalog_json)?;
        catalog.port(port_id)?;
        // This version stores a canonical legacy projection, not arbitrary future
        // definition bytes. Do not silently drop a field we cannot interpret.
        if serde_json::from_str::<serde_json::Value>(&self.catalog_json)?
            != serde_json::to_value(catalog.authoritative_document())?
        {
            return Err(PortcoveError::verification(
                "retained definition contains unsupported or noncanonical semantics",
            ));
        }
        if let Ok(mut cache) = DECODED_CATALOG.lock() {
            *cache = Some((self.catalog_json.clone(), catalog.clone()));
        }
        Ok(catalog)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
