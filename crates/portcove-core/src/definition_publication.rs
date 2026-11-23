//! Inert, local supplied-byte inspection. This is neither TUF authentication nor
//! publisher/operation admission; those authorities remain at existing boundaries.
use crate::definition_repository::publisher_policy::{
    inspect_publication_policy, launch_assessment::inspect_publication_launch,
};
use crate::{DefinitionContentIndex, PortcoveError, Result};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};

const INDEX: &str = "definitions/index.json";
const MAX_FILES: usize = 16385;
const MAX_TOTAL: usize = 32 * 1024 * 1024;
const MAX_LEAF: usize = crate::definition_index::MAX_CONTENT_BYTES as usize;
const MAX_POLICY: usize = 64 * 1024;
fn hash(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}
fn invalid() -> PortcoveError {
    PortcoveError::verification(
        "definition publication bundle is incomplete, changed or outside its fixed bounds",
    )
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct DefinitionPublicationFile {
    pub target: String,
    pub bytes: u64,
    pub sha256: String,
}
#[derive(Debug, Serialize, JsonSchema)]
pub struct DefinitionPublicationIdentity {
    pub namespace: String,
    pub stable_id: String,
    pub revision: u64,
    pub definition_target: String,
    pub policy_target: String,
    pub policy_schema: u32,
    pub policy_revision: u64,
    pub grant_id: String,
    pub launch_target: Option<String>,
    pub launch_revision: Option<u64>,
}
#[derive(Debug, Serialize, JsonSchema)]
pub struct DefinitionPublicationInspection {
    pub publication_schema: u32,
    pub authority: &'static str,
    pub index_sha256: String,
    pub files: Vec<DefinitionPublicationFile>,
    pub definitions: Vec<DefinitionPublicationIdentity>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub listings: Option<ListingPublicationIdentity>,
    pub scope: &'static str,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ListingPublicationIdentity {
    pub target: String,
    pub revision: u64,
    pub sha256: String,
    pub listing_count: usize,
    pub withdrawn_count: usize,
}

fn inspect_listing_publication(
    target: &str,
    bytes: &[u8],
) -> Result<(ListingPublicationIdentity, String)> {
    use crate::definition_repository::publisher_policy::listing_delivery::ListingDeliveryDocument;
    let raw_sha256 = hash(bytes);
    let decoded;
    let (payload, decoded_sha256) = if target == portcove_listing_carrier::COMPACT_TARGET {
        let (value, digest) = portcove_listing_carrier::decode(bytes)
            .map_err(|error| PortcoveError::verification(error.to_string()))?;
        decoded = value;
        (decoded.as_slice(), digest)
    } else {
        (bytes, raw_sha256.clone())
    };
    let document = if target == portcove_listing_carrier::COMPACT_TARGET {
        ListingDeliveryDocument::parse_compact(payload)?
    } else {
        ListingDeliveryDocument::parse(payload)?
    };
    Ok((
        ListingPublicationIdentity {
            target: target.into(),
            revision: document.revision,
            sha256: raw_sha256,
            listing_count: document.directory.listings.len(),
            withdrawn_count: document.withdrawn_ids.len(),
        },
        decoded_sha256,
    ))
}

/// Reuse existing parsers and the complete semantic projection. Unsupported
/// capabilities retain Core's Unsupported error, distinct from malformed input.
pub fn inspect_definition_publication_bytes(
    files: &BTreeMap<String, Vec<u8>>,
) -> Result<DefinitionPublicationInspection> {
    if files.is_empty() || files.len() > MAX_FILES {
        return Err(invalid());
    }
    let mut total = 0usize;
    for (name, bytes) in files {
        let bound = if portcove_listing_carrier::is_listing_target(name) {
            portcove_listing_carrier::MAX_BYTES
        } else if name == INDEX {
            crate::definition_index::MAX_INDEX_BYTES
        } else if name.starts_with("policy/") {
            MAX_POLICY
        } else {
            MAX_LEAF
        };
        total = total.checked_add(bytes.len()).ok_or_else(invalid)?;
        if bytes.is_empty() || bytes.len() > bound || total > MAX_TOTAL {
            return Err(invalid());
        }
    }
    let index_bytes = files.get(INDEX).ok_or_else(invalid)?;
    let index = DefinitionContentIndex::parse(index_bytes)?;
    let index_sha256 = hash(index_bytes);
    let mut expected = BTreeSet::from([INDEX.to_owned()]);
    let mut referenced = BTreeSet::new();
    for (target, _, _) in index.content_records() {
        let bytes = files.get(target).ok_or_else(invalid)?;
        index.verify_content(target, bytes)?;
        expected.insert(target.to_owned());
    }
    let mut inspect_listing = |target: &str| -> Result<_> {
        let inspection = files
            .get(target)
            .map(|bytes| inspect_listing_publication(target, bytes))
            .transpose()?;
        if inspection.is_some() {
            expected.insert(target.into());
        }
        Ok(inspection)
    };
    let legacy = inspect_listing(portcove_listing_carrier::LEGACY_TARGET)?;
    let compact = inspect_listing(portcove_listing_carrier::COMPACT_TARGET)?;
    if let Some((new, new_digest)) = &compact {
        let (old, old_digest) = legacy.as_ref().ok_or_else(invalid)?;
        if new.revision < old.revision || (new.revision == old.revision && new_digest != old_digest)
        {
            return Err(invalid());
        }
    }
    let listings = compact.or(legacy).map(|(record, _)| record);
    let mut definitions = Vec::new();
    for definition in index.definitions() {
        if definition.namespace() != "official" {
            return Err(PortcoveError::unsupported(
                "publication supports only the existing official namespace",
            ));
        }
        let entry_bytes = files.get(definition.target()).ok_or_else(invalid)?;
        let entry =
            index.inspect_entry(definition.namespace(), definition.stable_id(), entry_bytes)?;
        let contract = files.get(entry.execution_contract()).ok_or_else(invalid)?;
        let projection = index.inspect_catalog_projection(
            definition.namespace(),
            definition.stable_id(),
            entry_bytes,
            contract,
        )?;
        crate::definition_candidate::selection::publishable_snapshot_size(projection.snapshot())?;
        referenced.insert(definition.target().to_owned());
        referenced.extend(entry.referenced_targets().map(str::to_owned));
        let policy_target = format!("policy/official/{}.json", definition.stable_id());
        let policy_bytes = files.get(&policy_target).ok_or_else(invalid)?;
        let (policy_schema, policy_revision, grant_id, requires_launch) =
            inspect_publication_policy(policy_bytes, &projection, &index_sha256)?;
        expected.insert(policy_target.clone());
        let (launch_target, launch_revision) = if requires_launch {
            let target = format!("policy/official/{}.launch.json", definition.stable_id());
            let bytes = files.get(&target).ok_or_else(invalid)?;
            let revision = inspect_publication_launch(
                bytes,
                definition.namespace(),
                definition.stable_id(),
                policy_bytes,
            )?;
            expected.insert(target.clone());
            (Some(target), Some(revision))
        } else {
            (None, None)
        };
        definitions.push(DefinitionPublicationIdentity {
            namespace: definition.namespace().into(),
            stable_id: definition.stable_id().into(),
            revision: definition.revision(),
            definition_target: definition.target().into(),
            policy_target,
            policy_schema,
            policy_revision,
            grant_id,
            launch_target,
            launch_revision,
        });
    }
    if referenced
        != index
            .content_records()
            .map(|(name, _, _)| name.to_owned())
            .collect()
        || expected != files.keys().cloned().collect()
    {
        return Err(invalid());
    }
    definitions.sort_by(|a, b| (&a.namespace, &a.stable_id).cmp(&(&b.namespace, &b.stable_id)));
    let report = DefinitionPublicationInspection {
        publication_schema: if listings.is_some() { 2 } else { 1 },
        authority: "none",
        index_sha256,
        files: files
            .iter()
            .map(|(target, bytes)| DefinitionPublicationFile {
                target: target.clone(),
                bytes: bytes.len() as u64,
                sha256: hash(bytes),
            })
            .collect(),
        definitions,
        scope: if listings.is_some() {
            "inert-catalog-publication-inspection"
        } else {
            "inert-managed-definition-publication-inspection"
        },
        listings,
    };
    // Leave space for the existing CLI machine envelope under its caller's
    // 4 MiB captured-manifest budget. This is a producer-only refusal.
    if serde_json::to_vec(&report)?.len() > 4 * 1024 * 1024 - 4096 {
        return Err(invalid());
    }
    Ok(report)
}

/// Local adapter only. The existing stable no-follow/single-link reader bounds
/// every read. A second complete traversal rechecks all bytes and the exact set.
pub fn inspect_definition_publication(directory: &Path) -> Result<DefinitionPublicationInspection> {
    inspect_ancestry(directory)?;
    let root = fs::canonicalize(directory)?;
    let held = crate::external_runtime::open_identity_handle(&root)?;
    if !held.metadata()?.is_dir() {
        return Err(invalid());
    }
    let files = read_bundle(&root)?;
    let report = inspect_definition_publication_bytes(&files)?;
    if files != read_bundle(&root)?
        || fs::canonicalize(directory)? != root
        || !crate::external_runtime::same_file(
            &held,
            &crate::external_runtime::open_identity_handle(&root)?,
        )?
    {
        return Err(invalid());
    }
    inspect_ancestry(directory)?;
    Ok(report)
}

fn inspect_ancestry(path: &Path) -> Result<()> {
    let absolute = std::path::absolute(path)?;
    #[cfg(windows)]
    {
        use std::path::{Component, Prefix};
        if !matches!(absolute.components().next(), Some(Component::Prefix(prefix)) if matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_)))
        {
            return Err(invalid());
        }
    }
    for (depth, ancestor) in absolute.ancestors().enumerate() {
        if depth > 64 {
            return Err(invalid());
        }
        let metadata = fs::symlink_metadata(ancestor)?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(invalid());
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                return Err(invalid());
            }
        }
    }
    Ok(())
}

fn read_bundle(root: &Path) -> Result<BTreeMap<String, Vec<u8>>> {
    let mut files = BTreeMap::new();
    let mut pending = vec![PathBuf::new()];
    let mut total = 0usize;
    while let Some(relative) = pending.pop() {
        let directory = root.join(&relative);
        let held = crate::external_runtime::open_identity_handle(&directory)?;
        if !held.metadata()?.is_dir() {
            return Err(invalid());
        }
        for item in fs::read_dir(&directory)? {
            let item = item?;
            let path = item.path();
            let name = item.file_name().into_string().map_err(|_| invalid())?;
            if name.is_empty() || !name.is_ascii() || name.len() > 255 || name.contains(['\\', '/'])
            {
                return Err(invalid());
            }
            let relative = relative.join(name);
            let target = relative.to_str().ok_or_else(invalid)?.replace('\\', "/");
            let metadata = fs::symlink_metadata(&path)?;
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if metadata.file_attributes() & 0x400 != 0 {
                    return Err(invalid());
                }
            }
            if metadata.file_type().is_symlink() {
                return Err(invalid());
            }
            if metadata.is_dir() {
                if !matches!(
                    target.as_str(),
                    "definitions" | "sha256" | "policy" | "policy/official"
                ) {
                    return Err(invalid());
                }
                pending.push(relative);
            } else {
                if !metadata.is_file() || files.len() >= MAX_FILES {
                    return Err(invalid());
                }
                let cap = if portcove_listing_carrier::is_listing_target(&target) {
                    portcove_listing_carrier::MAX_BYTES
                } else if target == INDEX {
                    crate::definition_index::MAX_INDEX_BYTES
                } else if target.starts_with("policy/") {
                    MAX_POLICY
                } else {
                    MAX_LEAF
                };
                let bytes = crate::external_runtime::read_single_link_metadata(
                    &path,
                    cap.min(MAX_TOTAL - total) as u64,
                )?;
                total = total.checked_add(bytes.len()).ok_or_else(invalid)?;
                if bytes.is_empty() || total > MAX_TOTAL || files.insert(target, bytes).is_some() {
                    return Err(invalid());
                }
            }
        }
        if !crate::external_runtime::same_file(
            &held,
            &crate::external_runtime::open_identity_handle(&directory)?,
        )? {
            return Err(invalid());
        }
    }
    Ok(files)
}

#[cfg(test)]
#[path = "definition_publication_tests.rs"]
mod tests;
