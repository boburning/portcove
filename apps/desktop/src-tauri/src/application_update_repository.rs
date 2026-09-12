//! Bounded bridge from authenticated TUF targets to update selection.

use std::collections::BTreeMap;

use futures_util::TryStreamExt;
use semver::Version;
use tough::TargetName;

use crate::application_update::{
    ApplicationChannel, AuthenticatedRecordPair, CandidateSelection, InstalledApplicationContext,
    UpdateMetadataError, select_authenticated_candidate, validate_context,
};
use crate::application_update_payload::{
    PayloadKeyError, PayloadVerificationKey, select_payload_verification_key,
};
use crate::application_update_trust::{
    TrustedRepository, TrustedRepositoryError, TrustedRepositoryFailureKind,
};

const MAX_INDEXED_TARGETS: usize = 1_024;
const MAX_CHANNEL_RECORDS: usize = 64;
const MAX_RECORD_BYTES: usize = 256 * 1024;
const MAX_RECORD_SET_BYTES: usize = 8 * 1024 * 1024;
const PAYLOAD_KEY_REGISTRY_PATH: &str = "keys/payload.json";

#[derive(Debug, thiserror::Error)]
pub enum CandidateLoadError {
    #[error(transparent)]
    Trust(#[from] TrustedRepositoryError),
    #[error(transparent)]
    Metadata(#[from] UpdateMetadataError),
    #[error(transparent)]
    PayloadKey(#[from] PayloadKeyError),
    #[error("authenticated update repository index is invalid: {0}")]
    InvalidIndex(String),
    #[error("authenticated update record set exceeds its byte budget")]
    TooLarge,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CandidateLoadFailureKind {
    Unreachable,
    Stale,
    Rejected,
}

impl CandidateLoadError {
    pub fn failure_kind(&self) -> CandidateLoadFailureKind {
        match self {
            Self::Trust(error) => match error.failure_kind() {
                TrustedRepositoryFailureKind::Unreachable => CandidateLoadFailureKind::Unreachable,
                TrustedRepositoryFailureKind::Stale => CandidateLoadFailureKind::Stale,
                TrustedRepositoryFailureKind::Rejected => CandidateLoadFailureKind::Rejected,
            },
            _ => CandidateLoadFailureKind::Rejected,
        }
    }
}

impl From<tough::error::Error> for CandidateLoadError {
    fn from(error: tough::error::Error) -> Self {
        Self::Trust(error.into())
    }
}

struct OwnedRecordPair {
    release_path: String,
    release_bytes: Vec<u8>,
    promotion_bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthenticatedCandidateSelection {
    pub selection: CandidateSelection,
    pub payload_key: Option<PayloadVerificationKey>,
}

fn channel_name(channel: ApplicationChannel) -> &'static str {
    match channel {
        ApplicationChannel::Preview => "preview",
        ApplicationChannel::Stable => "stable",
    }
}

fn promotion_paths(
    trusted: &TrustedRepository,
    channel: ApplicationChannel,
    context: &InstalledApplicationContext,
) -> Result<Vec<(Version, String)>, CandidateLoadError> {
    validate_context(context)?;
    if trusted
        .repository
        .targets()
        .signed
        .targets
        .keys()
        .any(|name| name.raw().starts_with("channels/") || name.raw().starts_with("releases/"))
    {
        return Err(CandidateLoadError::InvalidIndex(
            "top-level targets must delegate application update records".into(),
        ));
    }
    let indexed_targets: Vec<_> = trusted.repository.all_targets().collect();
    if indexed_targets.len() > MAX_INDEXED_TARGETS {
        return Err(CandidateLoadError::InvalidIndex(format!(
            "more than {MAX_INDEXED_TARGETS} targets are declared"
        )));
    }
    let mut occurrences = BTreeMap::<String, usize>::new();
    for (name, _) in &indexed_targets {
        *occurrences.entry(name.raw().to_owned()).or_default() += 1;
    }
    if let Some((path, _)) = occurrences.iter().find(|(_, count)| **count != 1) {
        return Err(CandidateLoadError::InvalidIndex(format!(
            "target path is declared by more than one role: {path}"
        )));
    }

    let top_level_roles = trusted
        .repository
        .targets()
        .signed
        .delegations
        .as_ref()
        .ok_or_else(|| CandidateLoadError::InvalidIndex("delegated roles are missing".into()))?;
    let role_name = channel_name(channel);
    let channel_role = top_level_roles
        .roles
        .iter()
        .find(|role| role.name == role_name)
        .ok_or_else(|| {
            CandidateLoadError::InvalidIndex(format!("{role_name} channel role is missing"))
        })?;
    let channel_targets = channel_role.targets.as_ref().ok_or_else(|| {
        CandidateLoadError::InvalidIndex(format!("{role_name} channel role was not loaded"))
    })?;
    let release_role = top_level_roles
        .roles
        .iter()
        .find(|role| role.name == "releases")
        .ok_or_else(|| CandidateLoadError::InvalidIndex("release role is missing".into()))?;
    let release_targets = release_role
        .targets
        .as_ref()
        .ok_or_else(|| CandidateLoadError::InvalidIndex("release role was not loaded".into()))?;
    if let Some(name) = release_targets
        .signed
        .targets
        .keys()
        .find(|name| !name.raw().starts_with("releases/"))
    {
        return Err(CandidateLoadError::InvalidIndex(format!(
            "release role contains an out-of-scope target: {}",
            name.raw()
        )));
    }
    let channel_scope = format!("channels/{role_name}/");
    let prefix = format!(
        "channels/{}/{}/{}/",
        role_name, context.target, context.package_kind
    );
    let mut paths = Vec::new();
    for name in channel_targets.signed.targets.keys() {
        if !name.raw().starts_with(&channel_scope) {
            return Err(CandidateLoadError::InvalidIndex(format!(
                "{role_name} channel role contains an out-of-scope target: {}",
                name.raw()
            )));
        }
        let Some(filename) = name.raw().strip_prefix(&prefix) else {
            continue;
        };
        let Some(version_text) = filename.strip_suffix(".json") else {
            return Err(CandidateLoadError::InvalidIndex(format!(
                "channel target is not a versioned JSON record: {}",
                name.raw()
            )));
        };
        if version_text.contains('/') {
            return Err(CandidateLoadError::InvalidIndex(format!(
                "channel target is nested below its version slot: {}",
                name.raw()
            )));
        }
        let version = Version::parse(version_text).map_err(|_| {
            CandidateLoadError::InvalidIndex(format!(
                "channel target version is not SemVer: {}",
                name.raw()
            ))
        })?;
        if version.to_string() != version_text {
            return Err(CandidateLoadError::InvalidIndex(format!(
                "channel target version is not canonical SemVer: {}",
                name.raw()
            )));
        }
        paths.push((version, name.raw().to_owned()));
    }
    if paths.len() > MAX_CHANNEL_RECORDS {
        return Err(CandidateLoadError::InvalidIndex(format!(
            "more than {MAX_CHANNEL_RECORDS} channel records match the installed package"
        )));
    }
    paths.sort_by(|left, right| left.1.cmp(&right.1));
    Ok(paths)
}

async fn read_record(
    trusted: &TrustedRepository,
    path: &str,
    total_bytes: &mut usize,
) -> Result<Vec<u8>, CandidateLoadError> {
    let name = TargetName::new(path)?;
    let Some(mut stream) = trusted.repository.read_target(&name).await? else {
        return Err(CandidateLoadError::InvalidIndex(format!(
            "authenticated target is missing: {path}"
        )));
    };
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.try_next().await? {
        let record_size = bytes
            .len()
            .checked_add(chunk.len())
            .filter(|size| *size <= MAX_RECORD_BYTES)
            .ok_or(CandidateLoadError::TooLarge)?;
        *total_bytes = total_bytes
            .checked_add(chunk.len())
            .filter(|size| *size <= MAX_RECORD_SET_BYTES)
            .ok_or(CandidateLoadError::TooLarge)?;
        bytes.reserve(record_size - bytes.len());
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

/// Loads the installed package's authenticated channel and release records and
/// delegates compatibility and SemVer selection to `application_update`.
pub async fn select_repository_candidate(
    trusted: &TrustedRepository,
    channel: ApplicationChannel,
    context: &InstalledApplicationContext,
) -> Result<AuthenticatedCandidateSelection, CandidateLoadError> {
    let paths = promotion_paths(trusted, channel, context)?;
    let release_targets = trusted
        .repository
        .targets()
        .signed
        .delegations
        .as_ref()
        .and_then(|delegations| {
            delegations
                .roles
                .iter()
                .find(|role| role.name == "releases")
        })
        .and_then(|role| role.targets.as_ref())
        .ok_or_else(|| CandidateLoadError::InvalidIndex("release role was not loaded".into()))?;
    let mut total_bytes = 0;
    let mut owned = Vec::with_capacity(paths.len());
    for (version, promotion_path) in paths {
        let release_path = format!(
            "releases/{}/{}/{}.json",
            version, context.target, context.package_kind
        );
        let release_name = TargetName::new(&release_path)?;
        if !release_targets.signed.targets.contains_key(&release_name) {
            return Err(CandidateLoadError::InvalidIndex(format!(
                "release role does not contain the promoted target: {release_path}"
            )));
        }
        let promotion_bytes = read_record(trusted, &promotion_path, &mut total_bytes).await?;
        let release_bytes = read_record(trusted, &release_path, &mut total_bytes).await?;
        owned.push(OwnedRecordPair {
            release_path,
            release_bytes,
            promotion_bytes,
        });
    }
    let borrowed: Vec<_> = owned
        .iter()
        .map(|pair| AuthenticatedRecordPair {
            release_path: &pair.release_path,
            release_bytes: &pair.release_bytes,
            promotion_bytes: &pair.promotion_bytes,
        })
        .collect();
    let selection = select_authenticated_candidate(&borrowed, channel, context)?;
    let payload_key = if let Some(candidate) = &selection.candidate {
        let registry_name = TargetName::new(PAYLOAD_KEY_REGISTRY_PATH)?;
        if !trusted
            .repository
            .targets()
            .signed
            .targets
            .contains_key(&registry_name)
        {
            return Err(CandidateLoadError::InvalidIndex(
                "top-level targets does not contain the payload-key registry".into(),
            ));
        }
        let registry_bytes =
            read_record(trusted, PAYLOAD_KEY_REGISTRY_PATH, &mut total_bytes).await?;
        Some(select_payload_verification_key(
            &registry_bytes,
            &candidate.release.artifact.payload_key_id,
        )?)
    } else {
        None
    };
    Ok(AuthenticatedCandidateSelection {
        selection,
        payload_key,
    })
}
