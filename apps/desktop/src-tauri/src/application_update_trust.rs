//! Durable host trust for application-update TUF metadata.
//!
//! This loader is deliberately limited to local fixture repositories until the
//! production HTTPS transport enforces the documented origin, redirect, DNS and
//! aggregate-stream bounds. `tough` remains the sole TUF verifier.

use std::collections::BTreeSet;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use fs2::FileExt;
use jiff::Timestamp;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tough::schema::{Root, Signed};
use tough::{ExpirationEnforcement, Limits, Repository, RepositoryLoader};
use url::Url;

const STATE_SCHEMA_VERSION: u32 = 1;
const MAX_STATE_BYTES: u64 = 64 * 1024;
const MAX_ROOT_BYTES: u64 = 256 * 1024;
const MAX_TIMESTAMP_BYTES: u64 = 32 * 1024;
const MAX_SNAPSHOT_BYTES: u64 = 1024 * 1024;
const MAX_TARGETS_BYTES: u64 = 1024 * 1024;
const MAX_ROOT_UPDATES: u64 = 32;
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
    #[error("application update trust state I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("application update metadata authentication failed: {0}")]
    Authentication(#[source] Box<tough::error::Error>),
    #[error("application update trust state serialization failed: {0}")]
    Serialization(#[from] serde_json::Error),
}

impl From<tough::error::Error> for TrustedRepositoryError {
    fn from(error: tough::error::Error) -> Self {
        Self::Authentication(Box::new(error))
    }
}

#[derive(Debug, Clone)]
pub struct TrustedRepositoryRequest<'a> {
    pub bundled_root: &'a [u8],
    pub metadata_base_url: Url,
    pub targets_base_url: Url,
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

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };

    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    // SAFETY: both buffers are NUL-terminated and remain alive for this call.
    if unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(source, destination)
}

fn write_bytes_atomically(
    directory: &Path,
    temporary_name: &str,
    destination_name: &str,
    bytes: &[u8],
) -> Result<(), TrustedRepositoryError> {
    let temporary = directory.join(temporary_name);
    let destination = directory.join(destination_name);
    if temporary.exists() {
        fs::remove_file(&temporary)?;
    }
    let write_result = (|| -> std::io::Result<()> {
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        output.write_all(bytes)?;
        output.sync_all()?;
        replace_file(&temporary, &destination)?;
        #[cfg(unix)]
        File::open(directory)?.sync_all()?;
        Ok(())
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    write_result.map_err(Into::into)
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
    write_bytes_atomically(state_directory, STATE_TEMP_FILE, STATE_FILE, &bytes)
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

/// Loads a local authenticated repository while retaining trust across restarts.
///
/// The file-only source restriction is intentional. Production HTTPS transport
/// remains unavailable until it enforces the updater trust contract's network
/// boundary. Metadata failures never clear the retained replay or time floors.
pub async fn load_trusted_repository(
    request: TrustedRepositoryRequest<'_>,
) -> Result<TrustedRepository, TrustedRepositoryError> {
    validate_fixture_url(&request.metadata_base_url, "metadata URL")?;
    validate_fixture_url(&request.targets_base_url, "targets URL")?;
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
    let loaded = RepositoryLoader::new(
        &trusted_root,
        request.metadata_base_url,
        request.targets_base_url,
    )
    .datastore(&metadata_directory)
    .limits(limits)
    .expiration_enforcement(ExpirationEnforcement::Safe)
    .load()
    .await;

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
