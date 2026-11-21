//! Bounded catalog-specific offline metadata construction.
//! Public input validation and signatures confer no publisher admission or grant.
//! Each signer reads one appointed private key; assembly has no key input.

use crate::initial_root_profile::InitialRootProfile;
use crate::tuf_repository::TufRepositoryError;
use jiff::Timestamp;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    num::NonZeroU64,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tough::schema::{Root, Signed, Targets};

mod bundle;
mod history_checkpoint;
mod io;
mod key_inventory;
mod policy;
mod public_history;
mod repository;
mod signing;
pub use key_inventory::{CatalogKeyInventory, inspect_catalog_key_inventory};
pub use repository::{assemble_definition_repository, verify_definition_repository};
pub use signing::{sign_definition_role, sign_offline_definition_targets};

type Result<T> = std::result::Result<T, TufRepositoryError>;
type Files = BTreeMap<String, Vec<u8>>;
const CONFIG_MAX: u64 = 64 * 1024;
const COVER_CONTEXT_MAX: u64 = CONFIG_MAX + COVER_APPROVALS_MAX as u64;
const COVER_APPROVALS_MAX: usize = 256 * 1024;
const COVER_APPROVALS_CUSTOM: &str = "portcove_cover_approvals_v1";
const ROOT_MAX: u64 = 1024 * 1024;
const ROLE_MAX: u64 = 8 * 1024 * 1024;
const INSPECTION_MAX: u64 = 4 * 1024 * 1024;
const DEFINITION_INDEX_MAX: u64 = 4 * 1024 * 1024;
const DEFINITION_CONTENT_MAX: u64 = 16 * 1024 * 1024;
const BUNDLE_MAX: u64 = 32 * 1024 * 1024;
const BUNDLE_FILES: usize = 16385;
// Leave room for the other Pages components below the measured site bound.
const PUBLIC_REPOSITORY_MAX_BYTES: u64 = 768 * 1024 * 1024;
const PUBLIC_REPOSITORY_MAX_FILES: usize = 65536;

/// Authenticate prepared public inputs and check that their retained targets fit.
pub async fn check_definition_publication_context(path: &Path) -> Result<()> {
    load_context(path).await?;
    Ok(())
}

fn invalid<T>(message: &str) -> Result<T> {
    Err(TufRepositoryError::Invalid(message.into()))
}
fn sha(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}
fn expected(bytes: &[u8], digest: &str) -> Result<()> {
    if digest.len() != 64
        || !digest
            .bytes()
            .all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v))
        || sha(bytes) != digest
    {
        return invalid("catalog input SHA-256 differs");
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DefinitionOnlineRole {
    Targets,
    Definitions,
    Policy,
    Snapshot,
    Timestamp,
}
impl DefinitionOnlineRole {
    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "targets" => Ok(Self::Targets),
            "official-definitions" => Ok(Self::Definitions),
            "official-policy" => Ok(Self::Policy),
            "snapshot" => Ok(Self::Snapshot),
            "timestamp" => Ok(Self::Timestamp),
            _ => invalid("unsupported separately authorized catalog role"),
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Self::Targets => "targets",
            Self::Definitions => "official-definitions",
            Self::Policy => "official-policy",
            Self::Snapshot => "snapshot",
            Self::Timestamp => "timestamp",
        }
    }
    fn index(self) -> usize {
        match self {
            Self::Targets => 4,
            Self::Definitions => 0,
            Self::Policy => 1,
            Self::Snapshot => 2,
            Self::Timestamp => 3,
        }
    }
}
#[derive(Debug, Serialize)]
pub struct DefinitionRoleReport {
    pub schema_version: u32,
    pub role: String,
    pub changed: bool,
    pub sha256: String,
    pub bytes: usize,
    pub output: PathBuf,
    pub authority: &'static str,
}
#[derive(Debug, Serialize)]
pub struct DefinitionRepositoryReport {
    pub schema_version: u32,
    pub changed: bool,
    pub files: Vec<DefinitionFile>,
    pub repository_sha256: String,
    pub root_sha256: String,
    pub offline_targets_sha256: String,
    pub timestamp_sha256: String,
    pub snapshot_sha256: String,
    pub versions: BTreeMap<String, String>,
    pub expires: BTreeMap<String, String>,
    pub index_sha256: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cover_approvals: Option<serde_json::Value>,
    pub authority: &'static str,
}
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct DefinitionFile {
    pub target: String,
    pub bytes: u64,
    pub sha256: String,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Four<T> {
    definitions: T,
    policy: T,
    snapshot: T,
    timestamp: T,
}
impl<T: Copy> Four<T> {
    fn values(&self) -> [T; 4] {
        [self.definitions, self.policy, self.snapshot, self.timestamp]
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ContextConfig {
    schema_version: u32,
    #[serde(default)]
    initial_root_profile: InitialRootProfile,
    #[serde(default)]
    top_level_targets_profile: CatalogTargetsProfile,
    generated_at: String,
    trusted_root: String,
    trusted_root_sha256: String,
    offline_targets: String,
    offline_targets_sha256: String,
    prepared_bundle: String,
    #[serde(default)]
    cover_approvals: Option<serde_json::Value>,
    inspection: String,
    inspection_sha256: String,
    #[serde(default)]
    bootstrap_history: bool,
    #[serde(default)]
    history_store: Option<String>,
    previous_repository: serde_json::Value,
    versions: Four<u64>,
    expires: Four<String>,
}
#[derive(Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum CatalogTargetsProfile {
    #[default]
    OfflinePinnedV1,
    OnlineUnchangedAuthorityV1,
}
struct Context {
    root_bytes: Vec<u8>,
    root: Signed<Root>,
    top_bytes: Vec<u8>,
    top: Signed<Targets>,
    next_top: Option<Targets>,
    online_targets: bool,
    targets: Files,
    index_sha256: String,
    cover_approvals: Option<serde_json::Value>,
    versions: [NonZeroU64; 4],
    expires: [Timestamp; 4],
    at: Timestamp,
    inputs: Vec<PathBuf>,
    thin_history: bool,
    history_store: Option<PathBuf>,
    bootstrap_history: bool,
    history: Option<history_checkpoint::PreparedHistory>,
    prior: public_history::PublicHistory,
    readback: Vec<(PathBuf, u64, String)>,
    trees: Vec<(PathBuf, usize, u64, String)>,
}
async fn load_context(path: &Path) -> Result<Context> {
    load_context_mode(path, false).await
}

async fn load_context_mode(path: &Path, thin_history: bool) -> Result<Context> {
    let config_raw = io::read(path, COVER_CONTEXT_MAX)?;
    let config: ContextConfig = serde_json::from_slice(&config_raw)?;
    let online_targets =
        config.top_level_targets_profile == CatalogTargetsProfile::OnlineUnchangedAuthorityV1;
    if online_targets
        && (config.initial_root_profile != InitialRootProfile::SingleOwnerOneOfOneV1
            || !config.previous_repository.is_string())
    {
        return invalid(
            "catalog online Targets requires explicit single-owner profile and authenticated prior",
        );
    }
    let at = policy::generated(config.schema_version, &config.generated_at)?;
    let base = path.parent().unwrap_or(Path::new("."));
    let root_path = io::resolve(base, &config.trusted_root)?;
    let top_path = io::resolve(base, &config.offline_targets)?;
    let root_bytes = io::read(&root_path, ROOT_MAX)?;
    expected(&root_bytes, &config.trusted_root_sha256)?;
    let root: Signed<Root> = serde_json::from_slice(&root_bytes)?;
    policy::root(&root, at, config.initial_root_profile)?;
    let top_bytes = io::read(&top_path, ROLE_MAX)?;
    expected(&top_bytes, &config.offline_targets_sha256)?;
    let top: Signed<Targets> = serde_json::from_slice(&top_bytes)?;
    policy::top(&root.signed, &top, at)?;
    let bundle_path = io::resolve(base, &config.prepared_bundle)?;
    let inspection_path = io::resolve(base, &config.inspection)?;
    let manifest = io::read(&inspection_path, INSPECTION_MAX)?;
    expected(&manifest, &config.inspection_sha256)?;
    let (targets, index_sha256) = bundle::inspect(&bundle_path, &manifest)?;
    let versions = config
        .versions
        .values()
        .map(|v| {
            NonZeroU64::new(v)
                .ok_or_else(|| TufRepositoryError::Invalid("catalog role version is zero".into()))
        })
        .into_iter()
        .collect::<Result<Vec<_>>>()?
        .try_into()
        .map_err(|_| TufRepositoryError::Invalid("catalog role inventory differs".into()))?;
    let expires = [
        &config.expires.definitions,
        &config.expires.policy,
        &config.expires.snapshot,
        &config.expires.timestamp,
    ]
    .into_iter()
    .map(|v| {
        v.parse::<Timestamp>()
            .map_err(|_| TufRepositoryError::Invalid("catalog expiry malformed".into()))
    })
    .collect::<Result<Vec<_>>>()?;
    let expires: [Timestamp; 4] = expires
        .try_into()
        .map_err(|_| TufRepositoryError::Invalid("catalog expiry inventory differs".into()))?;
    for (i, expiry) in expires.iter().enumerate() {
        policy::window(at, *expiry, if i == 3 { 86400 } else { 7 * 86400 })?;
    }
    let readback = vec![
        (path.to_path_buf(), COVER_CONTEXT_MAX, sha(&config_raw)),
        (root_path.clone(), ROOT_MAX, sha(&root_bytes)),
        (top_path.clone(), ROLE_MAX, sha(&top_bytes)),
        (inspection_path.clone(), INSPECTION_MAX, sha(&manifest)),
    ];
    let mut trees = vec![(
        bundle_path.clone(),
        BUNDLE_FILES,
        BUNDLE_MAX,
        sha(&serde_json::to_vec(&bundle::identities(&targets))?),
    )];
    let mut inputs = vec![
        path.to_path_buf(),
        root_path,
        top_path,
        bundle_path,
        inspection_path,
    ];
    let history_store = config
        .history_store
        .as_deref()
        .map(|value| io::resolve(base, value))
        .transpose()?;
    if let Some(store) = &history_store {
        inputs.push(store.clone());
    }
    let mut context = Context {
        root_bytes,
        root,
        top_bytes,
        top,
        next_top: None,
        online_targets,
        targets,
        index_sha256,
        cover_approvals: config.cover_approvals,
        versions,
        expires,
        at,
        inputs: vec![],
        thin_history,
        history_store,
        bootstrap_history: config.bootstrap_history,
        history: None,
        prior: public_history::PublicHistory::default(),
        readback,
        trees: vec![],
    };
    if context.cover_approvals.is_some() && !config.previous_repository.is_string() {
        return invalid("catalog cover approval requires an authenticated prior");
    }
    if let Some(previous) = config.previous_repository.as_str() {
        let previous = io::resolve(base, previous)?;
        let (prior, history, prior_approvals) =
            repository::inspect_prior(&context, &previous).await?;
        context.prior = prior;
        if context.cover_approvals.is_none() {
            context.cover_approvals = prior_approvals;
        }
        if let Some(prepared) = history {
            if context
                .targets
                .insert(
                    history_checkpoint::TARGET.into(),
                    prepared.pointer_bytes.clone(),
                )
                .is_some()
            {
                return invalid("catalog bundle cannot appoint its own history checkpoint");
            }
            context.readback.extend(prepared.readback.iter().cloned());
            context.history = Some(prepared);
        }
        repository::check_proposed_target_capacity(&context.prior, &context.targets)?;
        let (files, bytes) = if context.thin_history && context.history_store.is_some() {
            (
                history_checkpoint::THIN_MAX_FILES,
                history_checkpoint::THIN_MAX_BYTES,
            )
        } else {
            (PUBLIC_REPOSITORY_MAX_FILES, PUBLIC_REPOSITORY_MAX_BYTES)
        };
        trees.push((
            previous.clone(),
            files,
            bytes,
            sha(&serde_json::to_vec(&context.prior.identities())?),
        ));
        inputs.push(previous);
    } else if context
        .targets
        .contains_key(portcove_listing_carrier::COVER_CHECKPOINT_TARGET)
    {
        return invalid("cover observations require a previous authenticated catalog checkpoint");
    } else if context.bootstrap_history || context.history_store.is_some() {
        return invalid("catalog history requires an authenticated predecessor");
    } else if !config.previous_repository.is_null() {
        return invalid("catalog prior repository must be an explicit path or null");
    } else if context.versions.iter().any(|v| v.get() != 1)
        || context.top.signed.version.get() != 1
        || context.root.signed.version.get() != 1
    {
        return invalid(
            "initial catalog publication requires explicit version one for every online role",
        );
    }
    if online_targets {
        let mut next = context.top.signed.clone();
        next.version = NonZeroU64::new(next.version.get().checked_add(1).ok_or_else(|| {
            TufRepositoryError::Invalid("catalog Targets version exhausted".into())
        })?)
        .unwrap();
        next.expires = at
            .checked_add(Duration::from_secs(90 * 86400))
            .map_err(|_| TufRepositoryError::Invalid("catalog Targets time overflow".into()))?
            .min(context.root.signed.expires);
        if next.expires <= context.top.signed.expires {
            return invalid("catalog Targets cannot advance within unchanged Root expiry");
        }
        context.next_top = Some(next);
    }
    context.inputs = inputs;
    context.trees = trees;
    recheck(&context)?;
    Ok(context)
}

#[cfg(test)]
mod tests;

fn recheck(context: &Context) -> Result<()> {
    for (path, maximum, digest) in &context.readback {
        expected(&io::read(path, *maximum)?, digest)?;
    }
    for (path, count, maximum, digest) in &context.trees {
        expected(
            &serde_json::to_vec(&io::inventory(path, *count, *maximum)?)?,
            digest,
        )?;
    }
    if Timestamp::now() >= context.expires.iter().copied().min().unwrap()
        || Timestamp::now() >= context.root.signed.expires
        || Timestamp::now() >= context.top.signed.expires
    {
        return invalid("catalog inputs expired during operation");
    }
    Ok(())
}

fn cover_hash(raw: &serde_json::Value, length: usize) -> bool {
    raw.as_str().is_some_and(|value| {
        value.len() == length
            && value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

#[derive(Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct CoverApprovalMapping {
    cover_id: u64,
    game_id: u64,
    game_slug: String,
    image_id: String,
    image_sha256: String,
    match_kind: String,
}

impl CoverApprovalMapping {
    fn parse(raw: &serde_json::Value) -> Option<Self> {
        let mapping: Self = serde_json::from_value(raw.clone()).ok()?;
        let id = |value| (1..=9_007_199_254_740_991).contains(&value);
        let lowercase_alphanumeric = |byte: u8| byte.is_ascii_lowercase() || byte.is_ascii_digit();
        (id(mapping.cover_id)
            && id(mapping.game_id)
            && mapping.match_kind == "underlying-game"
            && !mapping.game_slug.is_empty()
            && mapping.game_slug.len() <= 255
            && mapping
                .game_slug
                .bytes()
                .all(|byte| lowercase_alphanumeric(byte) || byte == b'-')
            && !mapping.image_id.is_empty()
            && mapping.image_id.len() <= 128
            && mapping.image_id.bytes().all(lowercase_alphanumeric)
            && cover_hash(&raw["image_sha256"], 64))
        .then_some(mapping)
    }

    fn replaced_by(&self, next: &Self) -> bool {
        self.game_id == next.game_id
            && self.game_slug == next.game_slug
            && self.cover_id != next.cover_id
            && self.image_id != next.image_id
            && self.image_sha256 != next.image_sha256
    }
}

fn approved_cover_mappings(row: &serde_json::Value) -> bool {
    let [Some(authored), Some(prior), Some(candidate)] =
        ["authored", "prior", "candidate"].map(|name| CoverApprovalMapping::parse(&row[name]))
    else {
        return false;
    };
    authored.replaced_by(&candidate) && prior.replaced_by(&candidate)
}

fn cover_approval_packets(journal: &serde_json::Value) -> Result<&[serde_json::Value]> {
    let invalid_value =
        || TufRepositoryError::Invalid("catalog cover approval journal differs".into());
    let packets = journal["consumed_packets"]
        .as_array()
        .ok_or_else(invalid_value)?;
    let rows = journal["approvals"].as_array().ok_or_else(invalid_value)?;
    let mut ids = std::collections::BTreeSet::new();
    if journal["format_version"] != 1
        || journal.as_object().map(serde_json::Map::len) != Some(3)
        || packets.is_empty()
        || packets.len() > 256
        || rows.is_empty()
        || rows.len() > 256
        || serde_json::to_vec(journal)?.len() > COVER_APPROVALS_MAX
        || packets.iter().any(|packet| !cover_hash(packet, 64))
        || (0..packets.len()).any(|index| packets[index + 1..].contains(&packets[index]))
        || rows.iter().any(|row| {
            row.as_object().map(serde_json::Map::len) != Some(10)
                || !row["id"]
                    .as_str()
                    .is_some_and(|id| !id.is_empty() && id.len() <= 128 && ids.insert(id))
                || !packets.contains(&row["packet"])
                || !cover_hash(&row["scope"], 64)
                || !cover_hash(&row["source"], 40)
                || row["role"] != "cover"
                || !approved_cover_mappings(row)
                || !row["run"].as_str().is_some_and(|run| {
                    !run.is_empty()
                        && run.len() <= 16
                        && run.as_bytes()[0] != b'0'
                        && run.bytes().all(|byte| byte.is_ascii_digit())
                })
                || !row["bytes"]
                    .as_u64()
                    .is_some_and(|bytes| (1..=16 * 1024 * 1024).contains(&bytes))
        })
    {
        return Err(invalid_value());
    }
    Ok(packets)
}

// Matches coverDeclarationScope in scripts/listing-artwork-checkpoint.mts.
// Both inputs are the actual assembled compatible listing shape. Explicitly
// sort nested objects before hashing, including when serde_json preserves order.
fn cover_approval_scope(
    listing: &serde_json::Value,
    artwork: &serde_json::Value,
) -> Result<String> {
    let mut scope = serde_json::json!([
        listing["id"],
        listing["project_url"],
        listing["original_game_title"],
        listing["original_game"],
        if listing["collection_covers"].is_array() {
            "collection"
        } else {
            "single"
        },
        artwork,
    ]);
    scope.sort_all_objects();
    Ok(sha(&serde_json::to_vec(&scope)?))
}

fn check_cover_approval_successor(
    prior: Option<&serde_json::Value>,
    next: &serde_json::Value,
    prior_compact: &[u8],
    prior_cover: Option<&[u8]>,
    compact: &[u8],
) -> Result<()> {
    let new_packets = cover_approval_packets(next)?;
    let old_packets = prior
        .map(cover_approval_packets)
        .transpose()?
        .unwrap_or_default();
    if !new_packets.starts_with(old_packets) || new_packets.len() != old_packets.len() + 1 {
        return invalid("catalog cover approval does not advance the authenticated journal");
    }
    let final_packet = &new_packets[new_packets.len() - 1];
    let previous = prior
        .and_then(|prior| prior["approvals"].as_array())
        .map(Vec::as_slice)
        .unwrap_or_default();
    let approved = next["approvals"].as_array().unwrap();
    if previous.iter().any(|old| {
        !approved
            .iter()
            .any(|row| row["id"] == old["id"] && (row == old || &row["packet"] == final_packet))
    }) || approved
        .iter()
        .any(|row| &row["packet"] != final_packet && !previous.contains(row))
    {
        return invalid("catalog cover approval altered an unrelated journal row");
    }
    let decode = |bytes| {
        portcove_listing_carrier::decode(bytes)
            .map_err(|error| TufRepositoryError::Invalid(error.to_string()))
    };
    let (decoded_prior, _) = decode(prior_compact)?;
    let prior_directory: serde_json::Value = serde_json::from_slice(&decoded_prior)?;
    let prior_listings = prior_directory["directory"]["listings"]
        .as_array()
        .ok_or_else(|| {
            TufRepositoryError::Invalid("catalog approved cover prior listing differs".into())
        })?;
    let prior_checkpoint = prior_cover
        .map(serde_json::from_slice::<serde_json::Value>)
        .transpose()?;
    let (decoded, _) = decode(compact)?;
    let directory: serde_json::Value = serde_json::from_slice(&decoded)?;
    let listings = directory["directory"]["listings"]
        .as_array()
        .ok_or_else(|| {
            TufRepositoryError::Invalid("catalog approved cover directory differs".into())
        })?;
    let changed = approved
        .iter()
        .filter(|row| &row["packet"] == final_packet)
        .collect::<Vec<_>>();
    if changed.is_empty() {
        return invalid("catalog cover approval packet has no signed cover changes");
    }
    for row in changed {
        let subject = |listing: &&serde_json::Value| listing["id"] == row["id"];
        let Some(held) = prior_listings.iter().find(subject) else {
            return invalid("catalog cover approval subject missing from signed compact prior");
        };
        let Some(proposed) = listings.iter().find(subject) else {
            return invalid("catalog cover approval subject missing from signed compact successor");
        };
        if held["collection_covers"].is_array()
            || proposed["collection_covers"].is_array()
            || row["scope"] != cover_approval_scope(held, &row["authored"])?
            || row["scope"] != cover_approval_scope(proposed, &row["authored"])?
            || proposed["artwork"] != row["candidate"]
        {
            return invalid("catalog approved cover differs from the exact signed subject scope");
        }
        let mut expected = &row["authored"];
        if let Some(former) = previous.iter().find(subject)
            && former["scope"] == cover_approval_scope(held, &former["authored"])?
        {
            if row["authored"] != former["authored"] || row["scope"] != former["scope"] {
                return invalid("catalog cover approval changed an active authored anchor");
            }
            expected = &former["candidate"];
        }
        let gone = if held.get("artwork").is_none() {
            let scope = cover_approval_scope(held, &row["prior"])?;
            prior_checkpoint
                .as_ref()
                .and_then(|checkpoint| checkpoint["entries"].as_array())
                .is_some_and(|entries| {
                    entries.iter().any(|entry| {
                        entry["id"] == row["id"]
                            && entry["scope"] == scope
                            && entry["image_id"] == row["prior"]["image_id"]
                            && entry["prior_sha256"] == row["prior"]["image_sha256"]
                            && entry["state"] == "gone"
                    })
                })
        } else {
            false
        };
        if &row["prior"] != expected || (held["artwork"] != row["prior"] && !gone) {
            return invalid("catalog cover approval does not bind the effective preimage");
        }
    }
    Ok(())
}
