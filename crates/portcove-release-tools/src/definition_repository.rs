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
mod io;
mod policy;
mod repository;
mod signing;
pub use repository::{assemble_definition_repository, verify_definition_repository};
pub use signing::{sign_definition_role, sign_offline_definition_targets};

type Result<T> = std::result::Result<T, TufRepositoryError>;
type Files = BTreeMap<String, Vec<u8>>;
const CONFIG_MAX: u64 = 64 * 1024;
const ROOT_MAX: u64 = 1024 * 1024;
const ROLE_MAX: u64 = 8 * 1024 * 1024;
const INSPECTION_MAX: u64 = 4 * 1024 * 1024;
const BUNDLE_MAX: u64 = 32 * 1024 * 1024;
const BUNDLE_FILES: usize = 16385;
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
    inspection: String,
    inspection_sha256: String,
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
    versions: [NonZeroU64; 4],
    expires: [Timestamp; 4],
    at: Timestamp,
    inputs: Vec<PathBuf>,
    prior: Files,
    readback: Vec<(PathBuf, u64, String)>,
    trees: Vec<(PathBuf, usize, u64, String)>,
}
async fn load_context(path: &Path) -> Result<Context> {
    let config_raw = io::read(path, CONFIG_MAX)?;
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
        (path.to_path_buf(), CONFIG_MAX, sha(&config_raw)),
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
    let mut context = Context {
        root_bytes,
        root,
        top_bytes,
        top,
        next_top: None,
        online_targets,
        targets,
        index_sha256,
        versions,
        expires,
        at,
        inputs: vec![],
        prior: Files::new(),
        readback,
        trees: vec![],
    };
    if let Some(previous) = config.previous_repository.as_str() {
        let previous = io::resolve(base, previous)?;
        context.prior = repository::inspect_prior(&context, &previous).await?;
        trees.push((
            previous.clone(),
            65536,
            128 * 1024 * 1024,
            sha(&serde_json::to_vec(&bundle::identities(&context.prior))?),
        ));
        inputs.push(previous);
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
            &serde_json::to_vec(&bundle::identities(&io::tree(path, *count, *maximum)?))?,
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
