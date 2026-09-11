//! Authenticated, bounded acquisition of an inert successor-definition candidate.
//! Selection, replay-floor persistence and publisher grants remain separate authorities.

use std::{
    collections::{BTreeMap, BTreeSet},
    error::Error as StdError,
    io,
    time::Duration,
};

use async_trait::async_trait;
use futures_util::{StreamExt, TryStreamExt, stream};
use reqwest::{Client, Url, redirect::Policy};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tough::{
    ExpirationEnforcement, Repository, RepositoryLoader, TargetName, Transport, TransportError,
    TransportErrorKind, TransportStream,
    schema::{DelegatedRole, PathSet, Role, Target},
};

use crate::{
    DefinitionCatalogProjection, DefinitionContentIndex, PortcoveError, Result,
    definition_index::{MAX_CONTENT_BYTES, MAX_INDEX_BYTES},
};

const INDEX_TARGET: &str = "definitions/index.json";
const DEFINITION_ROLE: &str = "official-definitions";
const DEFINITION_ROLE_PATHS: [&str; 2] = [INDEX_TARGET, "sha256/*.json"];
const MAX_ROOT_BYTES: usize = 1024 * 1024;
const ACQUISITION_TIMEOUT: Duration = Duration::from_secs(120);
const FETCH_TIMEOUT: Duration = Duration::from_secs(20);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const TARGET_CONCURRENCY: usize = 8;

/// Explicit network locations for one catalog-specific TUF repository.
#[derive(Debug, Clone)]
pub struct DefinitionRepositorySource {
    metadata_base_url: Url,
    targets_base_url: Url,
}

impl DefinitionRepositorySource {
    pub fn new(metadata_base_url: &str, targets_base_url: &str) -> Result<Self> {
        Ok(Self {
            metadata_base_url: parse_https_base(metadata_base_url)?,
            targets_base_url: parse_https_base(targets_base_url)?,
        })
    }

    pub fn metadata_base_url(&self) -> &str {
        self.metadata_base_url.as_str()
    }

    pub fn targets_base_url(&self) -> &str {
        self.targets_base_url.as_str()
    }
}

/// Authenticated metadata facts captured with a candidate. They are not a persisted replay floor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct AuthenticatedDefinitionProvenance {
    pub root_version: u64,
    pub root_sha256: String,
    pub timestamp_version: u64,
    pub timestamp_sha256: String,
    pub snapshot_version: u64,
    pub snapshot_sha256: String,
    pub targets_version: u64,
    pub targets_sha256: String,
    pub definitions_version: u64,
    pub definitions_sha256: String,
    pub earliest_expiration: String,
    pub index_sha256: String,
}

/// Highest authenticated metadata identities accepted with a selected definition snapshot.
///
/// The floor is inert until a later catalog-selection transaction persists it. Each digest is
/// the canonical signed body for that TUF role, excluding replaceable signature bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct DefinitionReplayFloor {
    pub root_version: u64,
    pub root_sha256: String,
    pub timestamp_version: u64,
    pub timestamp_sha256: String,
    pub snapshot_version: u64,
    pub snapshot_sha256: String,
    pub targets_version: u64,
    pub targets_sha256: String,
    pub definitions_version: u64,
    pub definitions_sha256: String,
    pub index_sha256: String,
}

/// Result of comparing one fully authenticated candidate with a retained replay floor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DefinitionReplayDisposition {
    Initial,
    ExactRetry,
    Advance,
}

/// Complete authenticated bytes for one inert repository snapshot.
///
/// Construction authenticates and bounds every content record. It does not persist metadata,
/// select a catalog, grant publisher scope, or authorize an operation.
#[derive(Debug)]
pub struct AuthenticatedDefinitionCandidate {
    provenance: AuthenticatedDefinitionProvenance,
    index: DefinitionContentIndex,
    contents: BTreeMap<String, Vec<u8>>,
}

impl AuthenticatedDefinitionCandidate {
    pub fn provenance(&self) -> &AuthenticatedDefinitionProvenance {
        &self.provenance
    }

    pub fn index(&self) -> &DefinitionContentIndex {
        &self.index
    }

    pub fn content_bytes(&self, target: &str) -> Result<&[u8]> {
        self.contents
            .get(target)
            .map(Vec::as_slice)
            .ok_or_else(|| PortcoveError::not_found("definition content is outside the candidate"))
    }

    pub fn replay_floor(&self) -> DefinitionReplayFloor {
        DefinitionReplayFloor::from(&self.provenance)
    }

    /// Compare this authenticated snapshot with durable state before semantic selection.
    /// Calling this method never advances the supplied floor.
    pub fn evaluate_replay(
        &self,
        floor: Option<&DefinitionReplayFloor>,
    ) -> Result<DefinitionReplayDisposition> {
        let Some(floor) = floor else {
            return Ok(DefinitionReplayDisposition::Initial);
        };
        floor.evaluate(&self.provenance)
    }

    /// Reuse the existing semantic interpreter for exactly one authenticated identity.
    /// Other entries remain isolated and unselected.
    pub fn inspect_catalog_projection(
        &self,
        namespace: &str,
        stable_id: &str,
    ) -> Result<DefinitionCatalogProjection> {
        let indexed = self
            .index
            .definitions()
            .iter()
            .find(|entry| entry.namespace() == namespace && entry.stable_id() == stable_id)
            .ok_or_else(|| {
                PortcoveError::not_found("definition identity is outside the candidate")
            })?;
        let entry_bytes = self.content_bytes(indexed.target())?;
        let entry = self
            .index
            .inspect_entry(namespace, stable_id, entry_bytes)?;
        let contract_bytes = self.content_bytes(entry.execution_contract())?;
        self.index
            .inspect_catalog_projection(namespace, stable_id, entry_bytes, contract_bytes)
    }
}

impl From<&AuthenticatedDefinitionProvenance> for DefinitionReplayFloor {
    fn from(value: &AuthenticatedDefinitionProvenance) -> Self {
        Self {
            root_version: value.root_version,
            root_sha256: value.root_sha256.clone(),
            timestamp_version: value.timestamp_version,
            timestamp_sha256: value.timestamp_sha256.clone(),
            snapshot_version: value.snapshot_version,
            snapshot_sha256: value.snapshot_sha256.clone(),
            targets_version: value.targets_version,
            targets_sha256: value.targets_sha256.clone(),
            definitions_version: value.definitions_version,
            definitions_sha256: value.definitions_sha256.clone(),
            index_sha256: value.index_sha256.clone(),
        }
    }
}

impl DefinitionReplayFloor {
    pub(crate) fn validate(&self) -> Result<()> {
        for (role, version, digest) in [
            ("root", self.root_version, self.root_sha256.as_str()),
            (
                "timestamp",
                self.timestamp_version,
                self.timestamp_sha256.as_str(),
            ),
            (
                "snapshot",
                self.snapshot_version,
                self.snapshot_sha256.as_str(),
            ),
            (
                "targets",
                self.targets_version,
                self.targets_sha256.as_str(),
            ),
            (
                "official-definitions",
                self.definitions_version,
                self.definitions_sha256.as_str(),
            ),
        ] {
            validate_metadata_identity(role, version, digest)?;
        }
        validate_sha256("accepted index", &self.index_sha256)
    }

    pub(crate) fn evaluate(
        &self,
        candidate: &AuthenticatedDefinitionProvenance,
    ) -> Result<DefinitionReplayDisposition> {
        self.validate()?;
        let roles = [
            (
                "root",
                self.root_version,
                &self.root_sha256,
                candidate.root_version,
                &candidate.root_sha256,
            ),
            (
                "timestamp",
                self.timestamp_version,
                &self.timestamp_sha256,
                candidate.timestamp_version,
                &candidate.timestamp_sha256,
            ),
            (
                "snapshot",
                self.snapshot_version,
                &self.snapshot_sha256,
                candidate.snapshot_version,
                &candidate.snapshot_sha256,
            ),
            (
                "targets",
                self.targets_version,
                &self.targets_sha256,
                candidate.targets_version,
                &candidate.targets_sha256,
            ),
            (
                "official-definitions",
                self.definitions_version,
                &self.definitions_sha256,
                candidate.definitions_version,
                &candidate.definitions_sha256,
            ),
        ];
        let mut advanced = false;
        for (role, accepted_version, accepted_digest, candidate_version, candidate_digest) in roles
        {
            validate_metadata_identity(role, candidate_version, candidate_digest)?;
            if candidate_version < accepted_version {
                return Err(PortcoveError::verification(
                    "definition metadata replay or downgrade was rejected",
                )
                .detail("role", role)
                .detail("accepted_version", accepted_version.to_string())
                .detail("candidate_version", candidate_version.to_string()));
            }
            if candidate_version == accepted_version && candidate_digest != accepted_digest {
                return Err(PortcoveError::verification(
                    "definition metadata changed without a version advance",
                )
                .detail("role", role)
                .detail("version", candidate_version.to_string()));
            }
            advanced |= candidate_version > accepted_version;
        }
        validate_sha256("candidate index", &candidate.index_sha256)?;
        if candidate.definitions_version == self.definitions_version
            && candidate.index_sha256 != self.index_sha256
        {
            return Err(PortcoveError::verification(
                "definition index changed without a delegated metadata version advance",
            ));
        }
        Ok(if advanced {
            DefinitionReplayDisposition::Advance
        } else {
            DefinitionReplayDisposition::ExactRetry
        })
    }
}

fn validate_metadata_identity(role: &str, version: u64, digest: &str) -> Result<()> {
    if version == 0 {
        return Err(PortcoveError::state(
            "definition replay floor contains an invalid metadata version",
        )
        .detail("role", role));
    }
    validate_sha256(role, digest)
}

fn validate_sha256(label: &str, digest: &str) -> Result<()> {
    if digest.len() != 64
        || !digest
            .bytes()
            .all(|value| value.is_ascii_digit() || (b'a'..=b'f').contains(&value))
    {
        return Err(PortcoveError::state(
            "definition replay floor contains an invalid SHA-256 identity",
        )
        .detail("identity", label));
    }
    Ok(())
}

fn metadata_sha256(role: &impl Role) -> Result<String> {
    let canonical = role.canonical_form().map_err(|_| {
        PortcoveError::verification("could not bind authenticated definition metadata identity")
    })?;
    Ok(hex::encode(Sha256::digest(canonical)))
}

/// Acquire an authenticated candidate from HTTPS without changing durable Portcove state.
pub async fn acquire_definition_candidate(
    source: &DefinitionRepositorySource,
    trusted_root: &[u8],
) -> Result<AuthenticatedDefinitionCandidate> {
    let transport = DefinitionHttpsTransport::new(source)?;
    tokio::time::timeout(
        ACQUISITION_TIMEOUT,
        acquire_with_transport(
            trusted_root,
            source.metadata_base_url.clone(),
            source.targets_base_url.clone(),
            transport,
        ),
    )
    .await
    .map_err(|_| PortcoveError::network("definition repository acquisition timed out"))?
}

async fn acquire_with_transport<T>(
    trusted_root: &[u8],
    metadata_base_url: Url,
    targets_base_url: Url,
    transport: T,
) -> Result<AuthenticatedDefinitionCandidate>
where
    T: Transport + Send + Sync + 'static,
{
    if trusted_root.is_empty() || trusted_root.len() > MAX_ROOT_BYTES {
        return Err(PortcoveError::verification(
            "trusted definition root exceeds its byte bound",
        ));
    }
    let repository = RepositoryLoader::new(&trusted_root, metadata_base_url, targets_base_url)
        .transport(transport)
        .expiration_enforcement(ExpirationEnforcement::Safe)
        .limits(tough::Limits {
            max_root_size: MAX_ROOT_BYTES as u64,
            max_targets_size: 8 * 1024 * 1024,
            max_timestamp_size: 1024 * 1024,
            max_snapshot_size: 4 * 1024 * 1024,
            max_root_updates: 32,
        })
        .load()
        .await
        .map_err(map_tough_error)?;
    if !repository.root().signed.consistent_snapshot {
        return Err(PortcoveError::verification(
            "definition repository requires consistent snapshots",
        ));
    }
    let role = definition_role(&repository)?;
    let index_name = TargetName::new(INDEX_TARGET).map_err(map_tough_error)?;
    let index_metadata = definition_target(role, &repository, &index_name)?;
    let index_bytes = read_target(
        &repository,
        &index_name,
        index_metadata,
        MAX_INDEX_BYTES as u64,
    )
    .await?;
    let index = DefinitionContentIndex::parse(&index_bytes)?;

    let content_targets = index
        .content_records()
        .map(|(target, expected_sha256, expected_length)| {
            let name = TargetName::new(target).map_err(map_tough_error)?;
            let metadata = definition_target(role, &repository, &name)?;
            if metadata.length != expected_length
                || hex::encode(metadata.hashes.sha256.clone().into_vec()) != expected_sha256
            {
                return Err(PortcoveError::verification(
                    "definition index and authenticated target metadata disagree",
                ));
            }
            Ok((target.to_owned(), name, metadata))
        })
        .collect::<Result<Vec<_>>>()?;
    let contents = stream::iter(content_targets)
        .map(|(target, name, metadata)| {
            let repository = &repository;
            async move {
                let bytes = read_target(repository, &name, metadata, MAX_CONTENT_BYTES).await?;
                Ok::<_, PortcoveError>((target, bytes))
            }
        })
        .buffer_unordered(TARGET_CONCURRENCY)
        .try_collect::<BTreeMap<_, _>>()
        .await?;
    for (target, bytes) in &contents {
        index.verify_content(target, bytes)?;
    }

    let definitions_metadata = role.targets.as_ref().ok_or_else(|| {
        PortcoveError::verification("definition delegation metadata was not loaded")
    })?;
    let expirations = [
        repository.root().signed.expires,
        repository.timestamp().signed.expires,
        repository.snapshot().signed.expires,
        repository.targets().signed.expires,
        definitions_metadata.signed.expires,
    ];
    let earliest_expiration = expirations
        .into_iter()
        .min()
        .expect("fixed metadata expiration inventory");
    Ok(AuthenticatedDefinitionCandidate {
        provenance: AuthenticatedDefinitionProvenance {
            root_version: repository.root().signed.version.get(),
            root_sha256: metadata_sha256(&repository.root().signed)?,
            timestamp_version: repository.timestamp().signed.version.get(),
            timestamp_sha256: metadata_sha256(&repository.timestamp().signed)?,
            snapshot_version: repository.snapshot().signed.version.get(),
            snapshot_sha256: metadata_sha256(&repository.snapshot().signed)?,
            targets_version: repository.targets().signed.version.get(),
            targets_sha256: metadata_sha256(&repository.targets().signed)?,
            definitions_version: definitions_metadata.signed.version.get(),
            definitions_sha256: metadata_sha256(&definitions_metadata.signed)?,
            earliest_expiration: earliest_expiration.to_string(),
            index_sha256: hex::encode(Sha256::digest(index.bytes())),
        },
        index,
        contents,
    })
}

fn definition_role(repository: &Repository) -> Result<&DelegatedRole> {
    let role = repository
        .targets()
        .signed
        .delegations
        .as_ref()
        .and_then(|delegations| {
            delegations
                .roles
                .iter()
                .find(|role| role.name == DEFINITION_ROLE)
        })
        .ok_or_else(|| {
            PortcoveError::verification("definition repository is missing its direct delegation")
        })?;
    let paths = match &role.paths {
        PathSet::Paths(paths) => paths
            .iter()
            .map(|path| path.value())
            .collect::<BTreeSet<_>>(),
        PathSet::PathHashPrefixes(_) => {
            return Err(PortcoveError::verification(
                "definition delegation must use explicit bounded paths",
            ));
        }
    };
    if !role.terminating
        || paths.len() != DEFINITION_ROLE_PATHS.len()
        || DEFINITION_ROLE_PATHS
            .iter()
            .any(|required| !paths.contains(required))
    {
        return Err(PortcoveError::verification(
            "definition delegation scope is wider than the supported contract",
        ));
    }
    let metadata = role.targets.as_ref().ok_or_else(|| {
        PortcoveError::verification("definition delegation metadata was not loaded")
    })?;
    if metadata
        .signed
        .delegations
        .as_ref()
        .is_some_and(|delegations| !delegations.roles.is_empty() || !delegations.keys.is_empty())
    {
        return Err(PortcoveError::verification(
            "nested definition delegations are unsupported",
        ));
    }
    Ok(role)
}

fn definition_target<'a>(
    role: &'a DelegatedRole,
    repository: &'a Repository,
    name: &TargetName,
) -> Result<&'a Target> {
    if repository.targets().signed.targets.contains_key(name) {
        return Err(PortcoveError::verification(
            "definition target bypasses its scoped delegation",
        ));
    }
    role.targets
        .as_ref()
        .and_then(|metadata| metadata.signed.targets.get(name))
        .ok_or_else(|| PortcoveError::verification("authenticated definition target is missing"))
}

async fn read_target(
    repository: &Repository,
    name: &TargetName,
    metadata: &Target,
    maximum: u64,
) -> Result<Vec<u8>> {
    if metadata.length == 0 || metadata.length > maximum {
        return Err(PortcoveError::verification(
            "authenticated definition target exceeds its byte bound",
        ));
    }
    let mut chunks = repository
        .read_target(name)
        .await
        .map_err(map_tough_error)?
        .ok_or_else(|| PortcoveError::verification("authenticated definition target is missing"))?;
    let mut bytes = Vec::with_capacity(metadata.length as usize);
    while let Some(chunk) = chunks.try_next().await.map_err(map_tough_error)? {
        if chunk.len() as u64 > maximum.saturating_sub(bytes.len() as u64) {
            return Err(PortcoveError::verification(
                "authenticated definition target exceeds its byte bound",
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    if bytes.len() as u64 != metadata.length
        || hex::encode(Sha256::digest(&bytes))
            != hex::encode(metadata.hashes.sha256.clone().into_vec())
    {
        return Err(PortcoveError::verification(
            "authenticated definition target length or digest mismatch",
        ));
    }
    Ok(bytes)
}

fn parse_https_base(value: &str) -> Result<Url> {
    if value.len() > 4096 {
        return Err(PortcoveError::usage(
            "definition repository HTTPS URL exceeds its byte bound",
        ));
    }
    let mut url = Url::parse(value)
        .map_err(|_| PortcoveError::usage("invalid definition repository HTTPS URL"))?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(PortcoveError::usage(
            "definition repository requires HTTPS without credentials, a query or a fragment",
        ));
    }
    if !url.path().ends_with('/') {
        let path = format!("{}/", url.path());
        url.set_path(&path);
    }
    Ok(url)
}

#[derive(Debug, Clone)]
struct DefinitionHttpsTransport {
    client: Client,
    bases: [Url; 2],
}

impl DefinitionHttpsTransport {
    fn new(source: &DefinitionRepositorySource) -> Result<Self> {
        let client = Client::builder()
            .https_only(true)
            .redirect(Policy::none())
            .no_proxy()
            .referer(false)
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(FETCH_TIMEOUT)
            .user_agent("Portcove definition repository/1")
            .build()
            .map_err(|_| {
                PortcoveError::network("could not initialize definition repository transport")
            })?;
        Ok(Self {
            client,
            bases: [
                source.metadata_base_url.clone(),
                source.targets_base_url.clone(),
            ],
        })
    }

    fn accepts(&self, url: &Url) -> bool {
        url.scheme() == "https"
            && url.query().is_none()
            && url.fragment().is_none()
            && url.username().is_empty()
            && url.password().is_none()
            && self
                .bases
                .iter()
                .any(|base| url.as_str().starts_with(base.as_str()))
    }
}

#[async_trait]
impl Transport for DefinitionHttpsTransport {
    async fn fetch(&self, url: Url) -> std::result::Result<TransportStream, TransportError> {
        if !self.accepts(&url) {
            return Err(TransportError::new(
                TransportErrorKind::UnsupportedUrlScheme,
                url.as_str(),
            ));
        }
        let response = self.client.get(url.clone()).send().await.map_err(|error| {
            TransportError::new_with_cause(TransportErrorKind::Other, url.as_str(), error)
        })?;
        if !response.status().is_success() {
            let kind = if matches!(response.status().as_u16(), 403 | 404 | 410) {
                TransportErrorKind::FileNotFound
            } else {
                TransportErrorKind::Other
            };
            return Err(TransportError::new_with_cause(
                kind,
                url.as_str(),
                io::Error::other(format!("HTTP {}", response.status())),
            ));
        }
        let stream_url = url;
        let stream = response.bytes_stream().map_err(move |error| {
            TransportError::new_with_cause(TransportErrorKind::Other, stream_url.as_str(), error)
        });
        Ok(Box::pin(stream))
    }
}

fn map_tough_error(error: tough::error::Error) -> PortcoveError {
    let mut current: Option<&(dyn StdError + 'static)> = Some(&error);
    let mut network = false;
    while let Some(value) = current {
        if let Some(tough) = value.downcast_ref::<tough::error::Error>() {
            match tough {
                tough::error::Error::ExpiredMetadata { .. } => {
                    return PortcoveError::verification(
                        "definition repository metadata is expired",
                    );
                }
                tough::error::Error::OlderMetadata { .. }
                | tough::error::Error::OlderSnapshotInTimestamp { .. }
                | tough::error::Error::SnapshotRoleRollback { .. } => {
                    return PortcoveError::verification(
                        "definition repository metadata replay was rejected",
                    );
                }
                tough::error::Error::HashMismatch { .. }
                | tough::error::Error::MaxSizeExceeded { .. }
                | tough::error::Error::MaxUpdatesExceeded { .. }
                | tough::error::Error::VerifyMetadata { .. }
                | tough::error::Error::VerifyRoleMetadata { .. }
                | tough::error::Error::VerifyTrustedMetadata { .. }
                | tough::error::Error::VersionMismatch { .. }
                | tough::error::Error::DelegatedRolesNotConsistent { .. }
                | tough::error::Error::DuplicateKeyid { .. }
                | tough::error::Error::InvalidThreshold { .. }
                | tough::error::Error::UnstableRoot { .. } => {
                    return PortcoveError::verification(
                        "definition repository authentication failed",
                    );
                }
                tough::error::Error::Transport { .. } => network = true,
                _ => {}
            }
        }
        current = value.source();
    }
    if network {
        PortcoveError::network("could not acquire authenticated definition repository")
    } else {
        PortcoveError::verification("definition repository authentication failed")
    }
}

#[cfg(test)]
#[path = "definition_repository_tests.rs"]
mod tests;
