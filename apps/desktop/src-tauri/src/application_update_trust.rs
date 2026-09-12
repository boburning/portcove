//! Durable host trust for application-update TUF metadata.
//!
//! Local fixture repositories remain test-only. Production HTTPS bases pass
//! through the host's pinned, no-redirect, bounded transport. `tough` remains
//! the sole TUF verifier.

use std::collections::BTreeSet;
use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use fs2::FileExt;
use jiff::Timestamp;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tough::schema::{PathSet, Root, Signed, Targets};
use tough::{ExpirationEnforcement, Limits, Repository, RepositoryLoader};
use url::Url;

use crate::application_update_storage::write_bytes_atomically;
use crate::application_update_transport::{PinnedHttpsTransport, TransportSetupError};

const STATE_SCHEMA_VERSION: u32 = 1;
const MAX_STATE_BYTES: u64 = 64 * 1024;
const MAX_ROOT_BYTES: u64 = 256 * 1024;
const MAX_TIMESTAMP_BYTES: u64 = 32 * 1024;
const MAX_SNAPSHOT_BYTES: u64 = 1024 * 1024;
const MAX_TARGETS_BYTES: u64 = 1024 * 1024;
const MAX_ROOT_UPDATES: u64 = 32;
const MAX_DELEGATED_ROLES: usize = 16;
const MAX_DELEGATION_DEPTH: usize = 2;
const MAX_METADATA_TARGETS: usize = 1024;
const MAX_DELEGATION_SELECTORS: usize = 1024;
const MAX_ROLE_NAME_BYTES: usize = 128;
const MAX_TARGET_PATH_BYTES: usize = 512;
const STATE_FILE: &str = "trust-state.json";
const STATE_TEMP_FILE: &str = ".trust-state.json.tmp";
const ROOT_TEMP_FILE: &str = ".root.json.tmp";
const LOCK_FILE: &str = "trust-state.lock";
const METADATA_DIRECTORY: &str = "metadata";
const ROOT_FILE: &str = "root.json";

static ACTIVE_TRUST_STATES: OnceLock<Mutex<BTreeSet<PathBuf>>> = OnceLock::new();

#[derive(Debug, thiserror::Error)]
pub enum TrustedRepositoryError {
    #[error("application update trust state is already in use")]
    Busy,
    #[error("application update trust state is invalid: {0}")]
    InvalidState(String),
    #[error(
        "the system clock moved backwards from greatest accepted time {greatest_accepted_time} to {observed_time}"
    )]
    ClockRegression {
        greatest_accepted_time: String,
        observed_time: String,
    },
    #[error("application update repository source is not permitted: {0}")]
    InvalidSource(String),
    #[error("application update metadata transport failed: {0}")]
    Transport(String),
    #[error("application update trust state I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("application update metadata authentication failed: {0}")]
    Authentication(#[source] Box<tough::error::Error>),
    #[error("application update metadata violates host policy: {0}")]
    MetadataPolicy(String),
    #[error("application update trust state serialization failed: {0}")]
    Serialization(#[from] serde_json::Error),
}

impl From<tough::error::Error> for TrustedRepositoryError {
    fn from(error: tough::error::Error) -> Self {
        match error {
            error @ tough::error::Error::Transport { .. } => Self::Transport(error.to_string()),
            error => Self::Authentication(Box::new(error)),
        }
    }
}

#[derive(Debug, Clone)]
pub struct TrustedRepositoryRequest<'a> {
    /// The host-owned trust anchor bundled with the application.
    pub bundled_root: &'a [u8],
    /// Host-selected metadata base. This request is a Rust-only boundary and is
    /// deliberately not deserializable from frontend IPC.
    pub metadata_base_url: Url,
    /// Host-selected target-record base, separate from the metadata namespace.
    pub targets_base_url: Url,
    /// Host-owned state outside downloaded payloads and game libraries.
    pub state_directory: &'a Path,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TrustedRepositoryVersions {
    pub root: u64,
    pub timestamp: u64,
    pub snapshot: u64,
    pub targets: u64,
    pub greatest_accepted_time: String,
}

#[derive(Debug, Clone)]
pub struct TrustedRepository {
    pub repository: Repository,
    pub versions: TrustedRepositoryVersions,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PersistedMetadataIdentity {
    version: u64,
    signed_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PersistedRoleVersions {
    timestamp: Option<PersistedMetadataIdentity>,
    snapshot: Option<PersistedMetadataIdentity>,
    targets: Option<PersistedMetadataIdentity>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PersistedTrustedRepositoryState {
    schema_version: u32,
    greatest_accepted_time: String,
    root: PersistedMetadataIdentity,
    roles: PersistedRoleVersions,
}

struct TrustStateLock(File);

struct ProcessTrustStateLock(PathBuf);

impl Drop for TrustStateLock {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.0);
    }
}

impl Drop for ProcessTrustStateLock {
    fn drop(&mut self) {
        if let Ok(mut active) = ACTIVE_TRUST_STATES
            .get_or_init(|| Mutex::new(BTreeSet::new()))
            .lock()
        {
            active.remove(&self.0);
        }
    }
}

fn validate_fixture_url(url: &Url, label: &str) -> Result<(), TrustedRepositoryError> {
    if url.scheme() != "file"
        || url.host_str().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.cannot_be_a_base()
    {
        return Err(TrustedRepositoryError::InvalidSource(label.into()));
    }
    Ok(())
}

async fn repository_transport(
    metadata_base_url: &Url,
    targets_base_url: &Url,
) -> Result<Option<PinnedHttpsTransport>, TrustedRepositoryError> {
    match (metadata_base_url.scheme(), targets_base_url.scheme()) {
        ("file", "file") => {
            validate_fixture_url(metadata_base_url, "metadata URL")?;
            validate_fixture_url(targets_base_url, "targets URL")?;
            Ok(None)
        }
        ("https", "https") => PinnedHttpsTransport::new(metadata_base_url, targets_base_url)
            .await
            .map(Some)
            .map_err(|error| match error {
                TransportSetupError::InvalidSource(message) => {
                    TrustedRepositoryError::InvalidSource(message)
                }
                TransportSetupError::Network(message) => TrustedRepositoryError::Transport(message),
            }),
        _ => Err(TrustedRepositoryError::InvalidSource(
            "metadata and target bases must both be local fixtures or trusted HTTPS".into(),
        )),
    }
}

fn ensure_directory(path: &Path) -> Result<(), TrustedRepositoryError> {
    fs::create_dir_all(path)?;
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(TrustedRepositoryError::InvalidState(format!(
            "{} is not a direct directory",
            path.display()
        )));
    }
    Ok(())
}

fn acquire_lock(state_directory: &Path) -> Result<TrustStateLock, TrustedRepositoryError> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(state_directory.join(LOCK_FILE))?;
    match file.try_lock_exclusive() {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
            return Err(TrustedRepositoryError::Busy);
        }
        Err(error) => return Err(error.into()),
    }
    Ok(TrustStateLock(file))
}

fn acquire_process_lock(
    state_directory: &Path,
) -> Result<ProcessTrustStateLock, TrustedRepositoryError> {
    let path = fs::canonicalize(state_directory)?;
    let mut active = ACTIVE_TRUST_STATES
        .get_or_init(|| Mutex::new(BTreeSet::new()))
        .lock()
        .map_err(|_| TrustedRepositoryError::InvalidState("process lock was poisoned".into()))?;
    if !active.insert(path.clone()) {
        return Err(TrustedRepositoryError::Busy);
    }
    Ok(ProcessTrustStateLock(path))
}

fn read_bounded(path: &Path, maximum: u64, label: &str) -> Result<Vec<u8>, TrustedRepositoryError> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > maximum {
        return Err(TrustedRepositoryError::InvalidState(format!(
            "{label} is not a bounded direct file"
        )));
    }
    let bytes = fs::read(path)?;
    if bytes.is_empty() || bytes.len() as u64 > maximum {
        return Err(TrustedRepositoryError::InvalidState(format!(
            "{label} is empty or exceeds its limit"
        )));
    }
    Ok(bytes)
}

fn sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn canonical_signed_sha256<T: Serialize>(value: &T) -> Result<String, TrustedRepositoryError> {
    let canonical = serde_json::to_vec(&serde_json::to_value(value)?)?;
    Ok(sha256(&canonical))
}

fn root_identity(bytes: &[u8]) -> Result<PersistedMetadataIdentity, TrustedRepositoryError> {
    if bytes.is_empty() || bytes.len() as u64 > MAX_ROOT_BYTES {
        return Err(TrustedRepositoryError::InvalidState(
            "trusted root is empty or exceeds its limit".into(),
        ));
    }
    let root: Signed<Root> = serde_json::from_slice(bytes)
        .map_err(|error| TrustedRepositoryError::InvalidState(error.to_string()))?;
    root.signed.verify_role(&root).map_err(|error| {
        TrustedRepositoryError::InvalidState(format!("trusted root signature is invalid: {error}"))
    })?;
    Ok(PersistedMetadataIdentity {
        version: root.signed.version.get(),
        signed_sha256: canonical_signed_sha256(&root.signed)?,
    })
}

fn validate_identity(
    identity: &PersistedMetadataIdentity,
    label: &str,
) -> Result<(), TrustedRepositoryError> {
    if identity.version == 0
        || identity.signed_sha256.len() != 64
        || !identity
            .signed_sha256
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(TrustedRepositoryError::InvalidState(format!(
            "{label} identity is invalid"
        )));
    }
    Ok(())
}

fn validate_state(
    state: &PersistedTrustedRepositoryState,
) -> Result<Timestamp, TrustedRepositoryError> {
    if state.schema_version != STATE_SCHEMA_VERSION {
        return Err(TrustedRepositoryError::InvalidState(
            "unsupported trust state schema".into(),
        ));
    }
    validate_identity(&state.root, "root")?;
    let present = [
        state.roles.timestamp.as_ref(),
        state.roles.snapshot.as_ref(),
        state.roles.targets.as_ref(),
    ];
    if !(present.iter().all(Option::is_none) || present.iter().all(Option::is_some)) {
        return Err(TrustedRepositoryError::InvalidState(
            "role replay floors are inconsistent".into(),
        ));
    }
    for (identity, label) in [
        (state.roles.timestamp.as_ref(), "timestamp"),
        (state.roles.snapshot.as_ref(), "snapshot"),
        (state.roles.targets.as_ref(), "targets"),
    ] {
        if let Some(identity) = identity {
            validate_identity(identity, label)?;
        }
    }
    let timestamp = state
        .greatest_accepted_time
        .parse::<Timestamp>()
        .map_err(|_| TrustedRepositoryError::InvalidState("accepted time is invalid".into()))?;
    if timestamp.to_string() != state.greatest_accepted_time {
        return Err(TrustedRepositoryError::InvalidState(
            "accepted time is not canonical".into(),
        ));
    }
    Ok(timestamp)
}

fn read_state(
    state_directory: &Path,
) -> Result<Option<PersistedTrustedRepositoryState>, TrustedRepositoryError> {
    let path = state_directory.join(STATE_FILE);
    if !path.exists() {
        return Ok(None);
    }
    let bytes = read_bounded(&path, MAX_STATE_BYTES, "trust state")?;
    let state: PersistedTrustedRepositoryState = serde_json::from_slice(&bytes)?;
    validate_state(&state)?;
    Ok(Some(state))
}

fn write_state_atomically(
    state_directory: &Path,
    state: &PersistedTrustedRepositoryState,
) -> Result<(), TrustedRepositoryError> {
    let mut bytes = serde_json::to_vec_pretty(state)?;
    bytes.push(b'\n');
    if bytes.len() as u64 > MAX_STATE_BYTES {
        return Err(TrustedRepositoryError::InvalidState(
            "serialized trust state exceeds its limit".into(),
        ));
    }
    write_bytes_atomically(state_directory, STATE_TEMP_FILE, STATE_FILE, &bytes).map_err(Into::into)
}

fn select_trusted_root(
    request: &TrustedRepositoryRequest<'_>,
    metadata_directory: &Path,
    existing_state: Option<&PersistedTrustedRepositoryState>,
) -> Result<(Vec<u8>, PersistedMetadataIdentity), TrustedRepositoryError> {
    let persisted_path = metadata_directory.join(ROOT_FILE);
    let bytes = if persisted_path.exists() {
        read_bounded(&persisted_path, MAX_ROOT_BYTES, "persisted trusted root")?
    } else {
        if existing_state.is_some() {
            return Err(TrustedRepositoryError::InvalidState(
                "persisted trusted root is missing".into(),
            ));
        }
        request.bundled_root.to_vec()
    };
    let identity = root_identity(&bytes)?;
    if let Some(state) = existing_state {
        if identity.version < state.root.version
            || (identity.version == state.root.version
                && identity.signed_sha256 != state.root.signed_sha256)
        {
            return Err(TrustedRepositoryError::InvalidState(
                "persisted trusted root is below or differs from its replay floor".into(),
            ));
        }
    }
    Ok((bytes, identity))
}

fn metadata_identity<T: Serialize>(
    version: u64,
    signed: &T,
) -> Result<PersistedMetadataIdentity, TrustedRepositoryError> {
    Ok(PersistedMetadataIdentity {
        version,
        signed_sha256: canonical_signed_sha256(signed)?,
    })
}

fn ensure_floor(
    current: &PersistedMetadataIdentity,
    floor: Option<&PersistedMetadataIdentity>,
    label: &str,
) -> Result<(), TrustedRepositoryError> {
    if floor.is_some_and(|floor| {
        current.version < floor.version
            || (current.version == floor.version && current.signed_sha256 != floor.signed_sha256)
    }) {
        return Err(TrustedRepositoryError::InvalidState(format!(
            "{label} metadata is below or differs from its replay floor"
        )));
    }
    Ok(())
}

fn repository_identities(
    repository: &Repository,
) -> Result<PersistedRoleVersions, TrustedRepositoryError> {
    Ok(PersistedRoleVersions {
        timestamp: Some(metadata_identity(
            repository.timestamp().signed.version.get(),
            &repository.timestamp().signed,
        )?),
        snapshot: Some(metadata_identity(
            repository.snapshot().signed.version.get(),
            &repository.snapshot().signed,
        )?),
        targets: Some(metadata_identity(
            repository.targets().signed.version.get(),
            &repository.targets().signed,
        )?),
    })
}

#[derive(Default)]
struct MetadataStructureCounts {
    delegated_roles: usize,
    targets: usize,
    delegation_selectors: usize,
}

fn add_bounded(
    current: &mut usize,
    additional: usize,
    maximum: usize,
    label: &str,
) -> Result<(), TrustedRepositoryError> {
    *current = current.checked_add(additional).ok_or_else(|| {
        TrustedRepositoryError::MetadataPolicy(format!("{label} count overflowed"))
    })?;
    if *current > maximum {
        return Err(TrustedRepositoryError::MetadataPolicy(format!(
            "{label} count exceeds {maximum}"
        )));
    }
    Ok(())
}

fn validate_targets_structure(
    targets: &Targets,
    depth: usize,
    seen_roles: &mut BTreeSet<String>,
    counts: &mut MetadataStructureCounts,
) -> Result<(), TrustedRepositoryError> {
    add_bounded(
        &mut counts.targets,
        targets.targets.len(),
        MAX_METADATA_TARGETS,
        "target",
    )?;
    for name in targets.targets.keys() {
        if name.raw().len() > MAX_TARGET_PATH_BYTES {
            return Err(TrustedRepositoryError::MetadataPolicy(format!(
                "target path exceeds {MAX_TARGET_PATH_BYTES} bytes"
            )));
        }
    }

    let Some(delegations) = &targets.delegations else {
        return Ok(());
    };
    for role in &delegations.roles {
        let role_depth = depth + 1;
        if role_depth > MAX_DELEGATION_DEPTH {
            return Err(TrustedRepositoryError::MetadataPolicy(format!(
                "delegation depth exceeds {MAX_DELEGATION_DEPTH}"
            )));
        }
        if role.name.is_empty() || role.name.len() > MAX_ROLE_NAME_BYTES {
            return Err(TrustedRepositoryError::MetadataPolicy(format!(
                "delegated role name is empty or exceeds {MAX_ROLE_NAME_BYTES} bytes"
            )));
        }
        if !seen_roles.insert(role.name.clone()) {
            return Err(TrustedRepositoryError::MetadataPolicy(format!(
                "delegated role name is repeated: {}",
                role.name
            )));
        }
        add_bounded(
            &mut counts.delegated_roles,
            1,
            MAX_DELEGATED_ROLES,
            "delegated role",
        )?;

        let selectors = match &role.paths {
            PathSet::Paths(patterns) => patterns.len(),
            PathSet::PathHashPrefixes(prefixes) => prefixes.len(),
        };
        add_bounded(
            &mut counts.delegation_selectors,
            selectors,
            MAX_DELEGATION_SELECTORS,
            "delegation selector",
        )?;

        match &role.paths {
            PathSet::Paths(patterns) => {
                for pattern in patterns {
                    if pattern.value().len() > MAX_TARGET_PATH_BYTES {
                        return Err(TrustedRepositoryError::MetadataPolicy(format!(
                            "delegation path exceeds {MAX_TARGET_PATH_BYTES} bytes"
                        )));
                    }
                }
            }
            PathSet::PathHashPrefixes(prefixes) => {
                for prefix in prefixes {
                    if prefix.value().is_empty()
                        || prefix.value().len() > 64
                        || !prefix.value().bytes().all(|byte| byte.is_ascii_hexdigit())
                    {
                        return Err(TrustedRepositoryError::MetadataPolicy(
                            "delegation hash prefix is not 1-64 hexadecimal bytes".into(),
                        ));
                    }
                }
            }
        }

        let child = role.targets.as_ref().ok_or_else(|| {
            TrustedRepositoryError::MetadataPolicy(format!(
                "delegated role metadata is unavailable: {}",
                role.name
            ))
        })?;
        validate_targets_structure(&child.signed, role_depth, seen_roles, counts)?;
    }
    Ok(())
}

fn validate_repository_structure(repository: &Repository) -> Result<(), TrustedRepositoryError> {
    validate_targets_structure(
        &repository.targets().signed,
        0,
        &mut BTreeSet::new(),
        &mut MetadataStructureCounts::default(),
    )
}

fn ensure_role_floors(
    state: &PersistedTrustedRepositoryState,
    current: &PersistedRoleVersions,
) -> Result<(), TrustedRepositoryError> {
    for (current, floor, label) in [
        (
            current.timestamp.as_ref(),
            state.roles.timestamp.as_ref(),
            "timestamp",
        ),
        (
            current.snapshot.as_ref(),
            state.roles.snapshot.as_ref(),
            "snapshot",
        ),
        (
            current.targets.as_ref(),
            state.roles.targets.as_ref(),
            "targets",
        ),
    ] {
        let current = current.ok_or_else(|| {
            TrustedRepositoryError::InvalidState("loaded role identity is missing".into())
        })?;
        ensure_floor(current, floor, label)?;
    }
    Ok(())
}

fn persisted_root_after_load(
    metadata_directory: &Path,
    previous: &PersistedMetadataIdentity,
) -> Result<PersistedMetadataIdentity, TrustedRepositoryError> {
    let bytes = read_bounded(
        &metadata_directory.join(ROOT_FILE),
        MAX_ROOT_BYTES,
        "persisted trusted root",
    )?;
    let current = root_identity(&bytes)?;
    if current.version < previous.version
        || (current.version == previous.version && current.signed_sha256 != previous.signed_sha256)
    {
        return Err(TrustedRepositoryError::InvalidState(
            "trusted root moved below or differs from its replay floor".into(),
        ));
    }
    Ok(current)
}

/// Loads an authenticated repository while retaining trust across restarts.
///
/// Local files are accepted only by the fixture transport. HTTPS metadata is
/// constrained by trusted base paths, pinned public DNS results, no redirects,
/// and per-request plus aggregate deadlines and byte limits. Metadata failures
/// never clear the retained replay or time floors.
pub async fn load_trusted_repository(
    request: TrustedRepositoryRequest<'_>,
) -> Result<TrustedRepository, TrustedRepositoryError> {
    let transport =
        repository_transport(&request.metadata_base_url, &request.targets_base_url).await?;
    root_identity(request.bundled_root)?;
    if !request.state_directory.is_absolute() {
        return Err(TrustedRepositoryError::InvalidState(
            "trust state directory must be absolute".into(),
        ));
    }
    ensure_directory(request.state_directory)?;
    let _process_lock = acquire_process_lock(request.state_directory)?;
    let _lock = acquire_lock(request.state_directory)?;
    let metadata_directory = request.state_directory.join(METADATA_DIRECTORY);
    ensure_directory(&metadata_directory)?;

    let prior_state = read_state(request.state_directory)?;
    let (trusted_root, root) =
        select_trusted_root(&request, &metadata_directory, prior_state.as_ref())?;
    let observed_time = Timestamp::now();
    let mut state = match prior_state {
        Some(state) => {
            let greatest = validate_state(&state)?;
            if observed_time < greatest {
                return Err(TrustedRepositoryError::ClockRegression {
                    greatest_accepted_time: greatest.to_string(),
                    observed_time: observed_time.to_string(),
                });
            }
            state
        }
        None => PersistedTrustedRepositoryState {
            schema_version: STATE_SCHEMA_VERSION,
            greatest_accepted_time: observed_time.to_string(),
            root: root.clone(),
            roles: PersistedRoleVersions {
                timestamp: None,
                snapshot: None,
                targets: None,
            },
        },
    };
    state.greatest_accepted_time = observed_time.to_string();
    state.root = root.clone();
    write_state_atomically(request.state_directory, &state)?;
    let persisted_root = metadata_directory.join(ROOT_FILE);
    if !persisted_root.exists() {
        write_bytes_atomically(
            &metadata_directory,
            ROOT_TEMP_FILE,
            ROOT_FILE,
            &trusted_root,
        )?;
    }

    let limits = Limits {
        max_root_size: MAX_ROOT_BYTES,
        max_timestamp_size: MAX_TIMESTAMP_BYTES,
        max_snapshot_size: MAX_SNAPSHOT_BYTES,
        max_targets_size: MAX_TARGETS_BYTES,
        max_root_updates: MAX_ROOT_UPDATES,
    };
    let loader = RepositoryLoader::new(
        &trusted_root,
        request.metadata_base_url,
        request.targets_base_url,
    )
    .datastore(&metadata_directory)
    .limits(limits)
    .expiration_enforcement(ExpirationEnforcement::Safe);
    let loaded = match transport {
        Some(transport) => loader.transport(transport).load().await,
        None => loader.load().await,
    };

    state.root = persisted_root_after_load(&metadata_directory, &root)?;
    let repository = match loaded {
        Ok(repository) => repository,
        Err(error) => {
            write_state_atomically(request.state_directory, &state)?;
            return Err(error.into());
        }
    };
    let identities = repository_identities(&repository)?;
    ensure_role_floors(&state, &identities)?;
    if repository.root().signed.version.get() != state.root.version {
        return Err(TrustedRepositoryError::InvalidState(
            "loaded root differs from persisted trusted root".into(),
        ));
    }
    if let Err(error) = validate_repository_structure(&repository) {
        state.roles = identities;
        write_state_atomically(request.state_directory, &state)?;
        return Err(error);
    }
    let timestamp = identities
        .timestamp
        .as_ref()
        .map(|role| role.version)
        .ok_or_else(|| {
            TrustedRepositoryError::InvalidState("loaded timestamp identity is missing".into())
        })?;
    let snapshot = identities
        .snapshot
        .as_ref()
        .map(|role| role.version)
        .ok_or_else(|| {
            TrustedRepositoryError::InvalidState("loaded snapshot identity is missing".into())
        })?;
    let targets = identities
        .targets
        .as_ref()
        .map(|role| role.version)
        .ok_or_else(|| {
            TrustedRepositoryError::InvalidState("loaded targets identity is missing".into())
        })?;
    state.roles = identities;
    write_state_atomically(request.state_directory, &state)?;

    Ok(TrustedRepository {
        versions: TrustedRepositoryVersions {
            root: state.root.version,
            timestamp,
            snapshot,
            targets,
            greatest_accepted_time: state.greatest_accepted_time,
        },
        repository,
    })
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::num::NonZeroU64;

    use tough::TargetName;
    use tough::schema::decoded::{Decoded, Hex};
    use tough::schema::{DelegatedRole, Delegations, Hashes, PathHashPrefix, PathPattern, Target};

    use super::*;

    fn empty_targets() -> Targets {
        Targets::new(
            "1.0.0".into(),
            NonZeroU64::new(1).unwrap(),
            Timestamp::now(),
        )
    }

    fn delegated_role(name: impl Into<String>, targets: Targets) -> DelegatedRole {
        DelegatedRole {
            name: name.into(),
            keyids: Vec::new(),
            threshold: NonZeroU64::new(1).unwrap(),
            paths: PathSet::Paths(vec![PathPattern::new("*").unwrap()]),
            terminating: false,
            targets: Some(Signed {
                signed: targets,
                signatures: Vec::new(),
            }),
        }
    }

    fn target() -> Target {
        Target {
            length: 0,
            hashes: Hashes {
                sha256: Decoded::<Hex>::from(vec![0; 32]),
                _extra: HashMap::new(),
            },
            custom: HashMap::new(),
            _extra: HashMap::new(),
        }
    }

    fn append_role(parent: &mut Targets, role: DelegatedRole) {
        parent
            .delegations
            .get_or_insert_with(Delegations::new)
            .roles
            .push(role);
    }

    fn validate(targets: &Targets) -> Result<(), TrustedRepositoryError> {
        validate_targets_structure(
            targets,
            0,
            &mut BTreeSet::new(),
            &mut MetadataStructureCounts::default(),
        )
    }

    #[test]
    fn delegation_role_limit_accepts_exact_boundary_and_rejects_next_role() {
        let mut targets = empty_targets();
        for index in 0..MAX_DELEGATED_ROLES {
            append_role(
                &mut targets,
                delegated_role(format!("role-{index}"), empty_targets()),
            );
        }
        validate(&targets).unwrap();

        append_role(
            &mut targets,
            delegated_role("one-role-too-many", empty_targets()),
        );
        assert!(matches!(
            validate(&targets),
            Err(TrustedRepositoryError::MetadataPolicy(message))
                if message.contains("delegated role count exceeds 16")
        ));
    }

    #[test]
    fn delegation_depth_accepts_two_and_rejects_three() {
        let mut depth_one = empty_targets();
        append_role(&mut depth_one, delegated_role("depth-two", empty_targets()));
        let mut targets = empty_targets();
        append_role(&mut targets, delegated_role("depth-one", depth_one));
        validate(&targets).unwrap();

        let mut depth_two = empty_targets();
        append_role(
            &mut depth_two,
            delegated_role("depth-three", empty_targets()),
        );
        let mut depth_one = empty_targets();
        append_role(&mut depth_one, delegated_role("depth-two", depth_two));
        let mut targets = empty_targets();
        append_role(&mut targets, delegated_role("depth-one", depth_one));
        assert!(matches!(
            validate(&targets),
            Err(TrustedRepositoryError::MetadataPolicy(message))
                if message.contains("delegation depth exceeds 2")
        ));
    }

    #[test]
    fn duplicate_role_names_and_unavailable_metadata_fail_closed() {
        let mut targets = empty_targets();
        append_role(&mut targets, delegated_role("duplicate", empty_targets()));
        append_role(&mut targets, delegated_role("duplicate", empty_targets()));
        assert!(matches!(
            validate(&targets),
            Err(TrustedRepositoryError::MetadataPolicy(message))
                if message.contains("delegated role name is repeated")
        ));

        let mut targets = empty_targets();
        let mut role = delegated_role("missing", empty_targets());
        role.targets = None;
        append_role(&mut targets, role);
        assert!(matches!(
            validate(&targets),
            Err(TrustedRepositoryError::MetadataPolicy(message))
                if message.contains("delegated role metadata is unavailable")
        ));
    }

    #[test]
    fn target_and_selector_limits_reject_the_first_excess_entry() {
        let target = target();
        let mut targets = empty_targets();
        for index in 0..=MAX_METADATA_TARGETS {
            targets.targets.insert(
                TargetName::new(format!("target-{index}")).unwrap(),
                target.clone(),
            );
        }
        assert!(matches!(
            validate(&targets),
            Err(TrustedRepositoryError::MetadataPolicy(message))
                if message.contains("target count exceeds 1024")
        ));

        let mut targets = empty_targets();
        let mut role = delegated_role("selectors", empty_targets());
        role.paths = PathSet::Paths(
            (0..=MAX_DELEGATION_SELECTORS)
                .map(|index| PathPattern::new(format!("path-{index}")).unwrap())
                .collect(),
        );
        append_role(&mut targets, role);
        assert!(matches!(
            validate(&targets),
            Err(TrustedRepositoryError::MetadataPolicy(message))
                if message.contains("delegation selector count exceeds 1024")
        ));
    }

    #[test]
    fn metadata_names_and_selectors_are_bounded_and_well_formed() {
        let mut targets = empty_targets();
        targets.targets.insert(
            TargetName::new("t".repeat(MAX_TARGET_PATH_BYTES + 1)).unwrap(),
            target(),
        );
        assert!(matches!(
            validate(&targets),
            Err(TrustedRepositoryError::MetadataPolicy(message))
                if message.contains("target path exceeds 512 bytes")
        ));

        let mut targets = empty_targets();
        append_role(
            &mut targets,
            delegated_role("r".repeat(MAX_ROLE_NAME_BYTES + 1), empty_targets()),
        );
        assert!(matches!(
            validate(&targets),
            Err(TrustedRepositoryError::MetadataPolicy(message))
                if message.contains("delegated role name is empty or exceeds 128 bytes")
        ));

        let mut targets = empty_targets();
        let mut role = delegated_role("long-path", empty_targets());
        role.paths = PathSet::Paths(vec![
            PathPattern::new("p".repeat(MAX_TARGET_PATH_BYTES + 1)).unwrap(),
        ]);
        append_role(&mut targets, role);
        assert!(matches!(
            validate(&targets),
            Err(TrustedRepositoryError::MetadataPolicy(message))
                if message.contains("delegation path exceeds 512 bytes")
        ));

        let mut targets = empty_targets();
        let mut role = delegated_role("bad-prefix", empty_targets());
        role.paths = PathSet::PathHashPrefixes(vec![PathHashPrefix::new("not-hex").unwrap()]);
        append_role(&mut targets, role);
        assert!(matches!(
            validate(&targets),
            Err(TrustedRepositoryError::MetadataPolicy(message))
                if message.contains("delegation hash prefix is not 1-64 hexadecimal bytes")
        ));
    }
}
