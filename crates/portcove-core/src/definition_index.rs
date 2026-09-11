//! Bounded successor content inventory. Structural validity is not publisher trust.
use std::collections::{BTreeMap, HashSet};

use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::{PortcoveError, Result};

pub(crate) const MAX_INDEX_BYTES: usize = 4 * 1024 * 1024;
const MAX_DEFINITIONS: usize = 4096;
pub(crate) const MAX_CONTENT_BYTES: u64 = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct IndexDocument {
    index_schema: u32,
    definitions: Vec<IndexedDefinition>,
    contents: Vec<IndexedDefinitionContent>,
}

/// One definition identity in a snapshot; its target still needs semantic validation.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IndexedDefinition {
    namespace: String,
    stable_id: String,
    revision: u64,
    target: String,
}

impl IndexedDefinition {
    pub fn namespace(&self) -> &str {
        &self.namespace
    }

    pub fn stable_id(&self) -> &str {
        &self.stable_id
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn target(&self) -> &str {
        &self.target
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct IndexedDefinitionContent {
    target: String,
    sha256: String,
    length: u64,
}

/// An immutable, structurally validated inventory with its exact input bytes.
/// This type supplies neither authenticated provenance nor permission to load/run content.
#[derive(Debug)]
pub struct DefinitionContentIndex {
    bytes: Vec<u8>,
    definitions: Vec<IndexedDefinition>,
    contents: BTreeMap<String, IndexedDefinitionContent>,
}

impl DefinitionContentIndex {
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > MAX_INDEX_BYTES {
            return Err(PortcoveError::verification(
                "definition index exceeds its byte bound",
            ));
        }
        let document: IndexDocument = serde_json::from_slice(bytes)?;
        if document.index_schema != 1 {
            return Err(PortcoveError::unsupported(
                "unsupported definition index schema",
            ));
        }
        if document.definitions.len() > MAX_DEFINITIONS {
            return Err(PortcoveError::verification(
                "definition index has too many entries",
            ));
        }
        let mut contents = BTreeMap::new();
        let mut total = 0_u64;
        for content in document.contents {
            content.validate()?;
            total = total
                .checked_add(content.length)
                .ok_or_else(|| PortcoveError::verification("definition content total overflow"))?;
            if total > MAX_TOTAL_BYTES {
                return Err(PortcoveError::verification(
                    "definition content exceeds its total byte bound",
                ));
            }
            if contents.insert(content.target.clone(), content).is_some() {
                return Err(PortcoveError::conflict(
                    "duplicate definition content target",
                ));
            }
        }
        let mut identities = HashSet::new();
        for definition in &document.definitions {
            if !valid_identity_component(&definition.namespace)
                || !valid_identity_component(&definition.stable_id)
                || definition.revision == 0
            {
                return Err(PortcoveError::verification(
                    "invalid indexed definition identity",
                ));
            }
            if !identities.insert((&definition.namespace, &definition.stable_id)) {
                return Err(PortcoveError::conflict(
                    "duplicate indexed definition identity",
                ));
            }
            if !contents.contains_key(&definition.target) {
                return Err(PortcoveError::verification(
                    "definition target is outside the index",
                ));
            }
        }
        Ok(Self {
            bytes: bytes.to_vec(),
            definitions: document.definitions,
            contents,
        })
    }

    /// Preserve exact content, including whitespace, for later authenticated bindings.
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    pub fn definitions(&self) -> &[IndexedDefinition] {
        &self.definitions
    }

    /// Give a transport the validated per-target read bound before acquisition.
    pub fn content_length(&self, target: &str) -> Result<u64> {
        Ok(self.content(target)?.length)
    }

    pub(crate) fn content_records(&self) -> impl Iterator<Item = (&str, &str, u64)> {
        self.contents.values().map(|content| {
            (
                content.target.as_str(),
                content.sha256.as_str(),
                content.length,
            )
        })
    }

    /// Verify supplied bytes against this inventory. Does not fetch, parse or execute them.
    /// Transport must independently authenticate the index and bound acquisition.
    pub fn verify_content(&self, target: &str, bytes: &[u8]) -> Result<()> {
        let content = self.content(target)?;
        if bytes.len() as u64 != content.length
            || hex::encode(Sha256::digest(bytes)) != content.sha256
        {
            return Err(PortcoveError::verification(
                "definition target length or digest mismatch",
            ));
        }
        Ok(())
    }

    fn content(&self, target: &str) -> Result<&IndexedDefinitionContent> {
        self.contents.get(target).ok_or_else(|| {
            PortcoveError::verification("definition content reference is outside the index")
        })
    }
}

impl IndexedDefinitionContent {
    fn validate(&self) -> Result<()> {
        if self.sha256.len() != 64
            || !self
                .sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            || self.target != format!("sha256/{}.json", self.sha256)
            || self.length == 0
            || self.length > MAX_CONTENT_BYTES
        {
            return Err(PortcoveError::verification(
                "invalid content-addressed definition target",
            ));
        }
        Ok(())
    }
}

fn valid_identity_component(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 255
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

#[cfg(test)]
#[path = "definition_index_tests.rs"]
mod tests;
