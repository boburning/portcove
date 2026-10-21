//! Independently authenticated exact-definition availability and managed policy.
//! Explicit supported schemas bind acquisition and launch checks to exact inputs.

use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tough::{Repository, TargetName, Transport, schema::PathSet};

use crate::{
    AuthenticatedDefinitionCandidate, DefinitionOperation, Library, PortcoveError, Result,
};

pub(super) const POLICY_ROLE: &str = "official-policy";
pub(super) const POLICY_PATH: &str = "policy/official/*.json";
pub(super) const MAX_POLICY_BYTES: u64 = 64 * 1024;

#[path = "definition_launch_assessment.rs"]
pub(crate) mod launch_assessment;
pub use launch_assessment::{
    AuthenticatedDefinitionLaunchAssessment, acquire_definition_launch_assessment,
};

#[path = "definition_authority.rs"]
pub(crate) mod provisioning;
pub use provisioning::{DefinitionAuthorityProvisioning, DefinitionAuthorityReview};

#[path = "definition_refresh.rs"]
pub(crate) mod refresh;
pub use refresh::{DefinitionRefresh, DefinitionRefreshDisposition};

/// Fetch inert policy under an explicitly supplied independently trusted root.
/// A library still requires its own installed matching authority before admission.
pub async fn acquire_definition_publisher_policy(
    source: &super::DefinitionRepositorySource,
    trusted_root: &[u8],
    namespace: &str,
    stable_id: &str,
) -> Result<AuthenticatedDefinitionPublisherPolicy> {
    let transport = super::DefinitionHttpsTransport::new(source)?;
    tokio::time::timeout(
        super::ACQUISITION_TIMEOUT,
        acquire_with_transport(
            trusted_root,
            source.metadata_base_url.clone(),
            source.targets_base_url.clone(),
            transport,
            namespace,
            stable_id,
        ),
    )
    .await
    .map_err(|_| PortcoveError::network("publisher policy acquisition timed out"))?
}

pub(super) async fn acquire_with_transport<T>(
    trusted_root: &[u8],
    metadata_base_url: reqwest::Url,
    targets_base_url: reqwest::Url,
    transport: T,
    namespace: &str,
    stable_id: &str,
) -> Result<AuthenticatedDefinitionPublisherPolicy>
where
    T: Transport + Send + Sync + 'static,
{
    if namespace != "official" || !valid_identity(stable_id) {
        return Err(PortcoveError::usage(
            "unsupported publisher policy identity",
        ));
    }
    let repository =
        super::load_repository(trusted_root, metadata_base_url, targets_base_url, transport)
            .await?;
    acquire_from_repository(&repository, trusted_root, namespace, stable_id).await
}

async fn acquire_from_repository(
    repository: &Repository,
    trusted_root: &[u8],
    namespace: &str,
    stable_id: &str,
) -> Result<AuthenticatedDefinitionPublisherPolicy> {
    if namespace != "official" || !valid_identity(stable_id) {
        return Err(PortcoveError::usage(
            "unsupported publisher policy identity",
        ));
    }
    let (bytes, provenance) = acquire_target_from_repository(
        repository,
        trusted_root,
        &format!("policy/{namespace}/{stable_id}.json"),
    )
    .await?;
    let document = PolicyDocument::parse(&bytes)?;
    if document.namespace != namespace || document.stable_id != stable_id {
        return Err(PortcoveError::verification(
            "publisher policy target identity differs",
        ));
    }
    Ok(AuthenticatedDefinitionPublisherPolicy {
        document,
        bytes,
        provenance,
    })
}

async fn acquire_target_from_repository(
    repository: &Repository,
    trusted_root: &[u8],
    target_path: &str,
) -> Result<(Vec<u8>, PolicyProvenance)> {
    let role = policy_role(repository)?;
    let metadata = role
        .targets
        .as_ref()
        .ok_or_else(|| PortcoveError::verification("publisher policy delegation was not loaded"))?;
    let name = TargetName::new(target_path).map_err(super::map_tough_error)?;
    let target = super::definition_target(role, repository, &name)?;
    let bytes = super::read_target(repository, &name, target, MAX_POLICY_BYTES).await?;
    let expiration = [
        repository.root().signed.expires,
        repository.timestamp().signed.expires,
        repository.snapshot().signed.expires,
        repository.targets().signed.expires,
        metadata.signed.expires,
    ]
    .into_iter()
    .min()
    .expect("fixed publisher metadata inventory");
    let roles = [
        PolicyRoleIdentity {
            role: "root".into(),
            version: repository.root().signed.version.get(),
            sha256: super::metadata_sha256(&repository.root().signed)?,
        },
        PolicyRoleIdentity {
            role: "timestamp".into(),
            version: repository.timestamp().signed.version.get(),
            sha256: super::metadata_sha256(&repository.timestamp().signed)?,
        },
        PolicyRoleIdentity {
            role: "snapshot".into(),
            version: repository.snapshot().signed.version.get(),
            sha256: super::metadata_sha256(&repository.snapshot().signed)?,
        },
        PolicyRoleIdentity {
            role: "targets".into(),
            version: repository.targets().signed.version.get(),
            sha256: super::metadata_sha256(&repository.targets().signed)?,
        },
        PolicyRoleIdentity {
            role: POLICY_ROLE.into(),
            version: metadata.signed.version.get(),
            sha256: super::metadata_sha256(&metadata.signed)?,
        },
    ];
    let provenance = PolicyProvenance {
        anchor_sha256: digest(trusted_root),
        root_sha256: roles[0].sha256.clone(),
        target_sha256: digest(&bytes),
        roles,
        expires_at: expiration.to_string(),
    };
    provenance.require_fresh()?;
    Ok((bytes, provenance))
}

fn policy_role(repository: &Repository) -> Result<&tough::schema::DelegatedRole> {
    let definitions = super::definition_role(repository)?;
    let delegations = repository
        .targets()
        .signed
        .delegations
        .as_ref()
        .ok_or_else(|| PortcoveError::verification("publisher policy delegation is missing"))?;
    let role = delegations
        .roles
        .iter()
        .find(|role| role.name == POLICY_ROLE)
        .ok_or_else(|| PortcoveError::verification("publisher policy delegation is missing"))?;
    if !role.terminating
        || !matches!(&role.paths, PathSet::Paths(paths) if paths.len() == 1 && paths[0].value() == POLICY_PATH)
        || role.keyids.is_empty()
    {
        return Err(PortcoveError::verification(
            "publisher policy delegation scope is unsupported",
        ));
    }
    for id in &role.keyids {
        let key = delegations.keys.get(id).ok_or_else(|| {
            PortcoveError::verification("publisher policy delegation key is missing")
        })?;
        let policy_key = signing_material(key);
        for other in definitions
            .keyids
            .iter()
            .filter_map(|id| delegations.keys.get(id))
            .chain(repository.root().signed.keys.values())
        {
            if signing_material(other) == policy_key {
                return Err(PortcoveError::verification(
                    "publisher policy requires independent key material",
                ));
            }
        }
    }
    let metadata = role
        .targets
        .as_ref()
        .ok_or_else(|| PortcoveError::verification("publisher policy delegation was not loaded"))?;
    if metadata
        .signed
        .delegations
        .as_ref()
        .is_some_and(|delegations| !delegations.roles.is_empty() || !delegations.keys.is_empty())
    {
        return Err(PortcoveError::verification(
            "nested publisher policy delegations are unsupported",
        ));
    }
    Ok(role)
}

pub(super) fn signing_material(key: &tough::schema::key::Key) -> (&'static str, &[u8]) {
    use tough::schema::key::Key;
    match key {
        Key::Rsa { keyval, .. } => ("rsa", &keyval.public),
        Key::Ed25519 { keyval, .. } => ("ed25519", &keyval.public),
        Key::Ecdsa { keyval, .. } | Key::EcdsaOld { keyval, .. } => ("ecdsa-p256", &keyval.public),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PolicyDocument {
    policy_schema: u32,
    namespace: String,
    stable_id: String,
    policy_revision: u64,
    grant_id: String,
    decision: PolicyDecision,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    curated_transitions: Option<CuratedTransitions>,
}

/// Supplied-byte publication inspection only; never constructs an authenticated
/// policy, installs a grant or consumes any durable replay/decision state.
pub(crate) fn inspect_publication_policy(
    bytes: &[u8],
    projection: &crate::DefinitionCatalogProjection,
    index_sha256: &str,
) -> Result<(u32, u64, String, bool)> {
    let document = PolicyDocument::parse(bytes)?;
    if document.namespace != projection.entry().namespace()
        || document.stable_id != projection.entry().port().id
        || (!matches!(document.decision, PolicyDecision::Revoked)
            && !document.binds_projection(projection, index_sha256)?)
    {
        return Err(PortcoveError::verification(
            "publication policy differs from its exact definition",
        ));
    }
    let launch = matches!(
        document.decision,
        PolicyDecision::ManagedGithub {
            launch_checks: Some(1),
            ..
        }
    );
    Ok((
        document.policy_schema,
        document.policy_revision,
        document.grant_id,
        launch,
    ))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CuratedTransitions {
    future_acceptance_lost: bool,
    artifacts: Vec<CuratedArtifactTransition>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CuratedArtifactTransition {
    asset_id: u64,
    sha256: String,
    status: CuratedArtifactStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum CuratedArtifactStatus {
    Revoked,
    DistributionWithdrawn,
    Cleared,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CuratedArtifactOperation {
    Acquisition,
    LocalUse,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
enum PolicyDecision {
    Availability {
        definition_revision: u64,
        index_sha256: String,
        definition_sha256: String,
        template: String,
    },
    ManagedGithub {
        definition_revision: u64,
        index_sha256: String,
        definition_sha256: String,
        template: String,
        repository_id: u64,
        artifact_hosts: Vec<String>,
        max_redirects: u32,
        operations: Vec<String>,
        #[serde(
            rename = "scoped_launch_checks",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        launch_checks: Option<u32>,
        #[serde(
            rename = "curated_acquisition_checks",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        curated_checks: Option<u32>,
    },
    Revoked,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct PolicyRoleIdentity {
    pub(super) role: String,
    pub(super) version: u64,
    pub(super) sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct PolicyProvenance {
    pub(super) anchor_sha256: String,
    pub(super) root_sha256: String,
    pub(super) target_sha256: String,
    pub(super) roles: [PolicyRoleIdentity; 5],
    pub(super) expires_at: String,
}

/// Private construction binds a bounded policy target to independent TUF authority.
/// Authentication alone neither installs that authority nor grants lifecycle scope.
#[derive(Debug)]
pub struct AuthenticatedDefinitionPublisherPolicy {
    document: PolicyDocument,
    bytes: Vec<u8>,
    provenance: PolicyProvenance,
}

fn digest(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_identity(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 255
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

impl PolicyDocument {
    fn continues_managed_authorization(&self, previous: &Self) -> bool {
        if self.policy_schema != previous.policy_schema
            || self.namespace != previous.namespace
            || self.stable_id != previous.stable_id
            || self.grant_id != previous.grant_id
        {
            return false;
        }
        match (&self.decision, &previous.decision) {
            (
                PolicyDecision::ManagedGithub {
                    template,
                    repository_id,
                    artifact_hosts,
                    max_redirects,
                    operations,
                    curated_checks,
                    ..
                },
                PolicyDecision::ManagedGithub {
                    template: old_template,
                    repository_id: old_repository_id,
                    artifact_hosts: old_hosts,
                    max_redirects: old_redirects,
                    operations: old_operations,
                    curated_checks: old_curated_checks,
                    ..
                },
            ) => {
                let same_set = |left: &[String], right: &[String]| {
                    left.len() == right.len() && left.iter().all(|value| right.contains(value))
                };
                template == old_template
                    && repository_id == old_repository_id
                    && same_set(artifact_hosts, old_hosts)
                    && max_redirects == old_redirects
                    && same_set(operations, old_operations)
                    && curated_checks == old_curated_checks
            }
            _ => false,
        }
    }

    fn parse(bytes: &[u8]) -> Result<Self> {
        if bytes.is_empty() || bytes.len() as u64 > MAX_POLICY_BYTES {
            return Err(PortcoveError::verification(
                "publisher policy exceeds its byte bound",
            ));
        }
        let raw: crate::definition_entry::strict_json::UniqueValue = serde_json::from_slice(bytes)?;
        let value: Self = serde_json::from_slice(bytes)?;
        if raw
            .0
            .as_object()
            .is_some_and(|document| document.contains_key("curated_transitions"))
            && (value.policy_schema != 4 || value.curated_transitions.is_none())
        {
            return Err(PortcoveError::unsupported(
                "curated transitions require an explicit schema-4 fact",
            ));
        }
        if let Some(transitions) = &value.curated_transitions {
            if !matches!(
                value.decision,
                PolicyDecision::ManagedGithub {
                    curated_checks: Some(1),
                    ..
                }
            ) || transitions.artifacts.len() > 64
            {
                return Err(PortcoveError::unsupported(
                    "curated transitions exceed their exact managed scope",
                ));
            }
            let mut identities = std::collections::BTreeSet::new();
            for artifact in &transitions.artifacts {
                if artifact.asset_id == 0
                    || !valid_sha256(&artifact.sha256)
                    || !identities.insert(artifact.asset_id)
                {
                    return Err(PortcoveError::verification(
                        "curated transitions contain an invalid or repeated artifact",
                    ));
                }
            }
        }
        if !matches!(value.policy_schema, 3 | 4)
            && raw
                .0
                .get("decision")
                .and_then(serde_json::Value::as_object)
                .is_some_and(|decision| decision.contains_key("scoped_launch_checks"))
        {
            return Err(PortcoveError::unsupported(
                "legacy policy has an unknown safety field",
            ));
        }
        if value.policy_schema != 4
            && raw
                .0
                .get("decision")
                .and_then(serde_json::Value::as_object)
                .is_some_and(|decision| decision.contains_key("curated_acquisition_checks"))
        {
            return Err(PortcoveError::unsupported(
                "legacy policy has an unknown curated safety field",
            ));
        }
        if !matches!(value.policy_schema, 1..=4) {
            return Err(PortcoveError::unsupported(
                "unsupported publisher policy schema",
            ));
        }
        let restricted = crate::definition_acquisition::restricted_grant(&value.grant_id);
        if (value.policy_schema == 1
            && (restricted || matches!(value.decision, PolicyDecision::ManagedGithub { .. })))
            || (matches!(value.policy_schema, 2..=4)
                && (!restricted || matches!(value.decision, PolicyDecision::Availability { .. })))
        {
            return Err(PortcoveError::unsupported(
                "publisher policy schema and grant scope disagree",
            ));
        }
        if let PolicyDecision::ManagedGithub {
            repository_id,
            artifact_hosts,
            max_redirects,
            operations,
            launch_checks,
            curated_checks,
            ..
        } = &value.decision
        {
            if (matches!(value.policy_schema, 3 | 4) && *launch_checks != Some(1))
                || (!matches!(value.policy_schema, 3 | 4) && launch_checks.is_some())
                || (value.policy_schema == 4 && *curated_checks != Some(1))
                || (value.policy_schema != 4 && curated_checks.is_some())
            {
                return Err(PortcoveError::unsupported(
                    "publisher policy requires unsupported launch checks",
                ));
            }
            crate::DefinitionAcquisitionScope::validate_parameters(
                *repository_id,
                artifact_hosts,
                *max_redirects,
                operations,
            )?;
        }
        if value.namespace != "official"
            || !valid_identity(&value.stable_id)
            || !valid_identity(&value.grant_id)
            || value.policy_revision == 0
            || value.policy_revision > i64::MAX as u64
        {
            return Err(PortcoveError::verification(
                "invalid publisher policy identity",
            ));
        }
        if let PolicyDecision::Availability {
            definition_revision,
            index_sha256,
            definition_sha256,
            template,
        }
        | PolicyDecision::ManagedGithub {
            definition_revision,
            index_sha256,
            definition_sha256,
            template,
            ..
        } = &value.decision
            && (*definition_revision == 0
                || !valid_sha256(index_sha256)
                || !valid_sha256(definition_sha256)
                || !valid_identity(template))
        {
            return Err(PortcoveError::verification(
                "invalid availability policy binding",
            ));
        }
        Ok(value)
    }

    fn binds(&self, candidate: &AuthenticatedDefinitionCandidate) -> Result<bool> {
        let (PolicyDecision::Availability {
            definition_revision,
            index_sha256,
            definition_sha256,
            ..
        }
        | PolicyDecision::ManagedGithub {
            definition_revision,
            index_sha256,
            definition_sha256,
            ..
        }) = &self.decision
        else {
            return Ok(false);
        };
        let Some(entry) = candidate.index().definitions().iter().find(|entry| {
            entry.namespace() == self.namespace && entry.stable_id() == self.stable_id
        }) else {
            return Ok(false);
        };
        if entry.revision() != *definition_revision
            || candidate.provenance().index_sha256 != *index_sha256
            || digest(candidate.content_bytes(entry.target())?) != *definition_sha256
        {
            return Ok(false);
        }
        let projection = candidate.inspect_catalog_projection(&self.namespace, &self.stable_id)?;
        self.binds_projection(&projection, index_sha256)
    }

    fn binds_projection(
        &self,
        projection: &crate::DefinitionCatalogProjection,
        candidate_index_sha256: &str,
    ) -> Result<bool> {
        let (PolicyDecision::Availability {
            definition_revision,
            index_sha256,
            definition_sha256,
            template,
        }
        | PolicyDecision::ManagedGithub {
            definition_revision,
            index_sha256,
            definition_sha256,
            template,
            ..
        }) = &self.decision
        else {
            return Ok(false);
        };
        let entry = projection.entry();
        if matches!(self.decision, PolicyDecision::ManagedGithub { .. }) {
            match self.decision {
                PolicyDecision::ManagedGithub {
                    curated_checks: Some(1),
                    ..
                } => {
                    crate::DefinitionAcquisitionScope::validate_port_contract(entry.port())?;
                    if entry.port().release.curated.is_empty() {
                        return Err(PortcoveError::verification(
                            "curated policy has no exact records",
                        ));
                    }
                    for (platform, record) in &entry.port().release.curated {
                        record.validate(&entry.port().release.repository, *platform)?;
                    }
                }
                _ => crate::DefinitionAcquisitionScope::validate_port(entry.port())?,
            }
        }
        Ok(entry.namespace() == self.namespace
            && entry.port().id == self.stable_id
            && entry.revision() == *definition_revision
            && candidate_index_sha256 == index_sha256
            && digest(entry.bytes()) == *definition_sha256
            && serde_json::to_value(entry.port().adapter)?.as_str() == Some(template.as_str()))
    }
}

impl PolicyProvenance {
    fn validate(&self) -> Result<()> {
        let names = ["root", "timestamp", "snapshot", "targets", POLICY_ROLE];
        if !valid_sha256(&self.anchor_sha256)
            || !valid_sha256(&self.root_sha256)
            || !valid_sha256(&self.target_sha256)
            || self.roles.iter().zip(names).any(|(identity, name)| {
                identity.role != name || identity.version == 0 || !valid_sha256(&identity.sha256)
            })
            || self.roles[0].sha256 != self.root_sha256
        {
            return Err(PortcoveError::state(
                "invalid publisher authority replay identity",
            ));
        }
        OffsetDateTime::parse(&self.expires_at, &Rfc3339)
            .map_err(|_| PortcoveError::state("invalid publisher policy expiration"))?;
        Ok(())
    }

    fn require_fresh(&self) -> Result<()> {
        self.validate()?;
        let expires = OffsetDateTime::parse(&self.expires_at, &Rfc3339)
            .map_err(|_| PortcoveError::state("invalid publisher policy expiration"))?;
        if expires.unix_timestamp() <= Library::now() {
            return Err(PortcoveError::verification(
                "publisher policy metadata is expired",
            ));
        }
        Ok(())
    }

    fn check_advance(&self, previous: &Self) -> Result<()> {
        self.validate()?;
        previous.validate()?;
        if self.anchor_sha256 != previous.anchor_sha256 {
            return Err(PortcoveError::conflict(
                "publisher authority anchor changed",
            ));
        }
        for (current, prior) in self.roles.iter().zip(&previous.roles) {
            if current.version < prior.version
                || (current.version == prior.version && current.sha256 != prior.sha256)
            {
                return Err(PortcoveError::verification(
                    "publisher authority metadata replay or equivocation",
                ));
            }
        }
        Ok(())
    }
}

fn stored_admission(
    connection: &Connection,
    namespace: &str,
    stable_id: &str,
) -> Result<Option<(PolicyDocument, PolicyProvenance, u64)>> {
    let row: Option<(String, String, String, i64)> = connection
        .query_row(
            "SELECT anchor_sha256,policy_json,provenance_json,retained_launch_revision_floor FROM definition_publisher_admission
         WHERE namespace=?1 AND stable_id=?2",
            params![namespace, stable_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    row.map(|(anchor, document, provenance, floor)| {
        if provenance.len() > 16 * 1024 {
            return Err(PortcoveError::state(
                "stored publisher provenance exceeds its bound",
            ));
        }
        let target_sha256 = digest(document.as_bytes());
        let document = PolicyDocument::parse(document.as_bytes())?;
        let provenance: PolicyProvenance = serde_json::from_str(&provenance)?;
        provenance.validate()?;
        if provenance.anchor_sha256 != anchor || provenance.target_sha256 != target_sha256 {
            return Err(PortcoveError::state(
                "stored publisher policy bytes differ from admission",
            ));
        }
        if document.namespace != namespace || document.stable_id != stable_id {
            return Err(PortcoveError::state(
                "stored publisher policy identity differs",
            ));
        }
        if floor <= 0 || floor as u64 > document.policy_revision {
            return Err(PortcoveError::state(
                "publisher authorization continuity is invalid",
            ));
        }
        let expected_status = if matches!(document.decision, PolicyDecision::Revoked) {
            "revoked"
        } else {
            "scoped"
        };
        let matches: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM definition_publisher_policy
             WHERE namespace=?1 AND stable_id=?2 AND root_sha256=?3
               AND policy_revision=?4 AND grant_id=?5 AND status=?6)",
            params![
                namespace,
                stable_id,
                provenance.root_sha256,
                document.policy_revision,
                document.grant_id,
                expected_status
            ],
            |row| row.get(0),
        )?;
        if !matches {
            return Err(PortcoveError::state(
                "publisher admission differs from its policy record",
            ));
        }
        Ok((document, provenance, floor as u64))
    })
    .transpose()
}

fn installed_authority_floor(
    connection: &Connection,
    anchor: &str,
) -> Result<Option<PolicyProvenance>> {
    let row: Option<(String, Option<String>)> = connection
        .query_row(
            "SELECT trusted_root_json,replay_floor_json FROM definition_publisher_authority
         WHERE anchor_sha256=?1",
            [anchor],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let (root, floor) = row.ok_or_else(|| {
        PortcoveError::conflict("independent publisher authority is not installed")
    })?;
    if root.len() > 1024 * 1024 || digest(root.as_bytes()) != anchor {
        return Err(PortcoveError::state(
            "installed publisher authority identity is invalid",
        ));
    }
    if floor.is_none()
        && connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM definition_publisher_admission WHERE anchor_sha256=?1)",
            [anchor],
            |row| row.get::<_, bool>(0),
        )?
    {
        return Err(PortcoveError::state(
            "admitted publisher authority is missing its replay floor",
        ));
    }
    floor
        .map(|bytes| {
            if bytes.len() > 16 * 1024 {
                return Err(PortcoveError::state(
                    "publisher authority floor exceeds its bound",
                ));
            }
            let value: PolicyProvenance = serde_json::from_str(&bytes)?;
            value.validate()?;
            if value.anchor_sha256 != anchor {
                return Err(PortcoveError::state(
                    "publisher authority floor belongs to another anchor",
                ));
            }
            Ok(value)
        })
        .transpose()
}

pub(crate) fn validate_stored_admissions(connection: &Connection) -> Result<()> {
    let mut statement =
        connection.prepare("SELECT namespace,stable_id FROM definition_publisher_admission")?;
    let identities = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    for (namespace, stable_id) in identities {
        let (_, provenance, _) = stored_admission(connection, &namespace, &stable_id)?
            .ok_or_else(|| PortcoveError::state("publisher admission disappeared"))?;
        let floor =
            installed_authority_floor(connection, &provenance.anchor_sha256)?.ok_or_else(|| {
                PortcoveError::state("admitted publisher authority has no replay floor")
            })?;
        floor.check_advance(&provenance)?;
    }
    Ok(())
}

fn retained_curated_transitions(
    connection: &Connection,
) -> Result<Vec<(PolicyDocument, PolicyProvenance)>> {
    let mut result = Vec::new();
    for (sha256, bytes, provenance) in
        crate::curated_acquisition::retained_transition_receipts(connection)?
    {
        if bytes.len() > MAX_POLICY_BYTES as usize
            || provenance.len() > 16 * 1024
            || digest(bytes.as_bytes()) != sha256
        {
            return Err(PortcoveError::verification(
                "retained curated transition receipt is invalid",
            ));
        }
        let document = PolicyDocument::parse(bytes.as_bytes())?;
        let provenance: PolicyProvenance = serde_json::from_str(&provenance)?;
        provenance.validate()?;
        if provenance.target_sha256 != sha256
            || document.curated_transitions.is_none()
            || installed_authority_floor(connection, &provenance.anchor_sha256)?.is_none()
        {
            return Err(PortcoveError::state(
                "retained curated transition lost its admitted authority",
            ));
        }
        // Expiry stops new acceptance; it cannot silently erase an observed hold.
        result.push((document, provenance));
    }
    Ok(result)
}

fn future_curated_acceptance_lost(
    connection: &Connection,
    namespace: &str,
    stable_id: &str,
    repository_id: u64,
) -> Result<bool> {
    Ok(retained_curated_transitions(connection)?.into_iter()
        .filter(|(document,_)| document.namespace == namespace && document.stable_id == stable_id && matches!(document.decision, PolicyDecision::ManagedGithub { repository_id: id, .. } if id == repository_id))
        .max_by_key(|(document,_)| document.policy_revision)
        .is_some_and(|(document,_)| document.curated_transitions.is_some_and(|transitions| transitions.future_acceptance_lost)))
}

pub(crate) fn require_curated_artifact_operation(
    connection: &Connection,
    repository_id: u64,
    record: &crate::CuratedAcquisitionRecord,
    operation: CuratedArtifactOperation,
) -> Result<()> {
    let assessment =
        assess_curated_artifact_operation(connection, repository_id, record, operation)?;
    if assessment.outcome == crate::DefinitionEligibilityOutcome::Hold {
        return Err(PortcoveError::conflict(match assessment.reason {
            crate::DefinitionEligibilityReason::CuratedArtifactRevoked => {
                "accepted curated artifact is revoked"
            }
            _ => "curated artifact distribution is withdrawn",
        })
        .detail("repository_id", repository_id.to_string())
        .detail("asset_id", record.asset_id.to_string())
        .detail("sha256", &record.sha256));
    }
    Ok(())
}

/// Read-only projection of the same exact-history guard used by execution.
pub(crate) fn assess_curated_artifact_operation(
    connection: &Connection,
    repository_id: u64,
    record: &crate::CuratedAcquisitionRecord,
    operation: CuratedArtifactOperation,
) -> Result<crate::DefinitionEligibility> {
    crate::curated_acquisition::require_retained_identity(connection, repository_id, record)?;
    let mut latest = std::collections::BTreeMap::new();
    for (document, provenance) in retained_curated_transitions(connection)? {
        if !matches!(document.decision, PolicyDecision::ManagedGithub { repository_id: id, .. } if id == repository_id)
        {
            continue;
        }
        let transitions = document
            .curated_transitions
            .as_ref()
            .expect("validated transition receipt");
        for artifact in &transitions.artifacts {
            if artifact.asset_id == record.asset_id && artifact.sha256 == record.sha256 {
                crate::curated_acquisition::require_scoped_artifact(
                    connection,
                    repository_id,
                    artifact.asset_id,
                    &artifact.sha256,
                    &document.namespace,
                    &document.stable_id,
                    &provenance.anchor_sha256,
                )?;
                let key = (
                    document.namespace.clone(),
                    document.stable_id.clone(),
                    provenance.anchor_sha256.clone(),
                );
                let previous = latest
                    .entry(key)
                    .or_insert((0, CuratedArtifactStatus::Cleared));
                if document.policy_revision > previous.0 {
                    *previous = (document.policy_revision, artifact.status);
                }
            }
        }
    }
    let reason = if latest
        .values()
        .any(|(_, status)| *status == CuratedArtifactStatus::Revoked)
    {
        crate::DefinitionEligibilityReason::CuratedArtifactRevoked
    } else if operation == CuratedArtifactOperation::Acquisition
        && latest
            .values()
            .any(|(_, status)| *status == CuratedArtifactStatus::DistributionWithdrawn)
    {
        crate::DefinitionEligibilityReason::CuratedDistributionWithdrawn
    } else {
        crate::DefinitionEligibilityReason::MandatoryChecksPassed
    };
    Ok(crate::DefinitionEligibility {
        outcome: if reason == crate::DefinitionEligibilityReason::MandatoryChecksPassed {
            crate::DefinitionEligibilityOutcome::Eligible
        } else {
            crate::DefinitionEligibilityOutcome::Hold
        },
        reason,
    })
}

impl Library {
    /// Admit exact availability bytes or revoke a grant under installed independent authority.
    /// No incoming root or policy can create that authority. Returns false for an exact retry.
    pub fn apply_definition_publisher_policy(
        &self,
        policy: &AuthenticatedDefinitionPublisherPolicy,
        candidate: Option<&AuthenticatedDefinitionCandidate>,
    ) -> Result<bool> {
        policy.provenance.require_fresh()?;
        if matches!(
            policy.document.decision,
            PolicyDecision::Availability { .. } | PolicyDecision::ManagedGithub { .. }
        ) {
            let candidate = candidate.ok_or_else(|| {
                PortcoveError::usage(
                    "availability policy requires its exact authenticated candidate",
                )
            })?;
            if policy.provenance.root_sha256 != candidate.provenance().root_sha256
                || !policy.document.binds(candidate)?
            {
                return Err(PortcoveError::verification(
                    "publisher policy differs from its exact definition",
                ));
            }
        }
        let document = std::str::from_utf8(&policy.bytes)
            .map_err(|_| PortcoveError::verification("publisher policy must be UTF-8"))?;
        let provenance = serde_json::to_string(&policy.provenance)?;
        if provenance.len() > 16 * 1024 {
            return Err(PortcoveError::state(
                "publisher policy provenance exceeds its bound",
            ));
        }
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let floor = installed_authority_floor(&transaction, &policy.provenance.anchor_sha256)?;
        if let Some(floor) = &floor {
            policy.provenance.check_advance(floor)?;
        }
        let previous = stored_admission(
            &transaction,
            &policy.document.namespace,
            &policy.document.stable_id,
        )?;
        if let Some((previous, identity, _)) = &previous {
            if launch_assessment::established_revision(
                &transaction,
                &policy.document.namespace,
                &policy.document.stable_id,
            )? > 0
                && !matches!(policy.document.policy_schema, 3 | 4)
                && !matches!(policy.document.decision, PolicyDecision::Revoked)
            {
                return Err(PortcoveError::unsupported(
                    "accepted launch checks cannot be downgraded",
                ));
            }
            if identity.anchor_sha256 != policy.provenance.anchor_sha256 {
                return Err(PortcoveError::conflict("publisher grant authority changed"));
            }
            if policy.document.policy_revision < previous.policy_revision
                || (policy.document.policy_revision == previous.policy_revision
                    && (policy.document != *previous
                        || policy.provenance.target_sha256 != identity.target_sha256))
            {
                return Err(PortcoveError::verification(
                    "publisher grant replay or equivocation",
                ));
            }
        }
        let existing_revision: Option<i64> = transaction.query_row(
            "SELECT policy_revision FROM definition_publisher_policy WHERE namespace=?1 AND stable_id=?2",
            params![policy.document.namespace, policy.document.stable_id],
            |row| row.get(0),
        ).optional()?;
        if previous.is_none()
            && current_restrictive_grant(
                &transaction,
                &policy.document.namespace,
                &policy.document.stable_id,
            )?
        {
            return Err(PortcoveError::state(
                "retained restrictive grant lost its admission",
            ));
        }
        if previous.is_some() && existing_revision.is_none() {
            return Err(PortcoveError::state(
                "accepted publisher admission lost its policy",
            ));
        }
        if existing_revision.is_some_and(|revision| {
            revision < 1
                || policy.document.policy_revision < revision as u64
                || (previous.is_none() && policy.document.policy_revision == revision as u64)
        }) {
            return Err(PortcoveError::verification(
                "publisher policy cannot replace retained authority at its revision",
            ));
        }
        let unchanged = previous.as_ref().is_some_and(|(document, provenance, _)| {
            document == &policy.document && provenance == &policy.provenance
        }) && floor.as_ref() == Some(&policy.provenance);
        let retained_launch_revision_floor = previous.as_ref().map_or(
            policy.document.policy_revision,
            |(document, provenance, floor)| {
                if policy.document.continues_managed_authorization(document)
                    && policy.provenance.anchor_sha256 == provenance.anchor_sha256
                    && policy.provenance.root_sha256 == provenance.root_sha256
                {
                    *floor
                } else {
                    policy.document.policy_revision
                }
            },
        );
        if let PolicyDecision::ManagedGithub {
            repository_id,
            curated_checks: Some(1),
            ..
        } = &policy.document.decision
        {
            let candidate = candidate
                .ok_or_else(|| PortcoveError::state("curated admission lost its candidate"))?;
            let projection = candidate.inspect_catalog_projection(
                &policy.document.namespace,
                &policy.document.stable_id,
            )?;
            if let Some(transitions) = &policy.document.curated_transitions {
                for artifact in &transitions.artifacts {
                    crate::curated_acquisition::require_scoped_artifact(
                        &transaction,
                        *repository_id,
                        artifact.asset_id,
                        &artifact.sha256,
                        &policy.document.namespace,
                        &policy.document.stable_id,
                        &policy.provenance.anchor_sha256,
                    )?;
                }
            }
            let acceptance_lost = match &policy.document.curated_transitions {
                Some(transitions) => transitions.future_acceptance_lost,
                None => future_curated_acceptance_lost(
                    &transaction,
                    &policy.document.namespace,
                    &policy.document.stable_id,
                    *repository_id,
                )?,
            };
            for record in projection.entry().port().release.curated.values() {
                if acceptance_lost {
                    crate::curated_acquisition::require_retained_identity(
                        &transaction,
                        *repository_id,
                        record,
                    )?;
                    crate::curated_acquisition::require_scoped_artifact(
                        &transaction,
                        *repository_id,
                        record.asset_id,
                        &record.sha256,
                        &policy.document.namespace,
                        &policy.document.stable_id,
                        &policy.provenance.anchor_sha256,
                    )?;
                }
                crate::curated_acquisition::retain_scoped_admission(
                    &transaction,
                    *repository_id,
                    record,
                    &policy.document.namespace,
                    &policy.document.stable_id,
                    &policy.provenance.anchor_sha256,
                    &policy.provenance.target_sha256,
                )?;
            }
            if policy.document.curated_transitions.is_some() {
                crate::curated_acquisition::retain_transition_receipt(
                    &transaction,
                    &policy.provenance.target_sha256,
                    document,
                    &provenance,
                )?;
            }
        }
        let status = if matches!(policy.document.decision, PolicyDecision::Revoked) {
            "revoked"
        } else {
            "scoped"
        };
        transaction.execute(
            "INSERT INTO definition_publisher_admission
             (namespace,stable_id,anchor_sha256,policy_json,provenance_json,retained_launch_revision_floor)
             VALUES(?1,?2,?3,?4,?5,?6)
             ON CONFLICT(namespace,stable_id) DO UPDATE SET
             anchor_sha256=excluded.anchor_sha256,policy_json=excluded.policy_json,
             provenance_json=excluded.provenance_json,
             retained_launch_revision_floor=excluded.retained_launch_revision_floor",
            params![
                policy.document.namespace,
                policy.document.stable_id,
                policy.provenance.anchor_sha256,
                document,
                provenance,
                retained_launch_revision_floor
            ],
        )?;
        transaction.execute(
            "INSERT INTO definition_publisher_policy
             (namespace,stable_id,root_sha256,policy_revision,grant_id,status)
             VALUES(?1,?2,?3,?4,?5,?6)
             ON CONFLICT(namespace,stable_id) DO UPDATE SET
             root_sha256=excluded.root_sha256,policy_revision=excluded.policy_revision,
             grant_id=excluded.grant_id,status=excluded.status",
            params![
                policy.document.namespace,
                policy.document.stable_id,
                policy.provenance.root_sha256,
                policy.document.policy_revision as i64,
                policy.document.grant_id,
                status
            ],
        )?;
        transaction.execute(
            "UPDATE definition_publisher_authority SET replay_floor_json=?1 WHERE anchor_sha256=?2",
            params![provenance, policy.provenance.anchor_sha256],
        )?;
        policy.provenance.require_fresh()?;
        transaction.commit()?;
        Ok(!unchanged)
    }
}

fn current_restrictive_grant(
    connection: &Connection,
    namespace: &str,
    stable_id: &str,
) -> Result<bool> {
    let grant: Option<String> = connection
        .query_row(
            "SELECT grant_id FROM definition_publisher_policy WHERE namespace=?1 AND stable_id=?2",
            params![namespace, stable_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten();
    Ok(grant.is_some_and(|grant| crate::definition_acquisition::restricted_grant(&grant)))
}

pub(crate) fn acquisition_scope(
    library: &Library,
    catalog: &crate::Catalog,
    port_id: &str,
) -> Result<Option<crate::DefinitionAcquisitionScope>> {
    let connection = library.connection()?;
    let transaction = connection.unchecked_transaction()?;
    let Some(identity) = catalog.definition_selection(port_id) else {
        if current_restrictive_grant(&transaction, "official", port_id)? {
            return Err(PortcoveError::unsupported(
                "restricted acquisition requires its exact selected definition",
            ));
        }
        return Ok(None);
    };
    let Some((document, provenance, _)) =
        stored_admission(&transaction, &identity.namespace, &identity.stable_id)?
    else {
        if crate::definition_acquisition::restricted_grant(&identity.grant_id)
            || current_restrictive_grant(&transaction, &identity.namespace, &identity.stable_id)?
        {
            return Err(PortcoveError::unsupported(
                "restricted grant has no authenticated acquisition admission",
            ));
        }
        return Ok(None);
    };
    provenance.require_fresh()?;
    let floor =
        installed_authority_floor(&transaction, &provenance.anchor_sha256)?.ok_or_else(|| {
            PortcoveError::state("admitted acquisition authority has no replay floor")
        })?;
    floor.check_advance(&provenance)?;
    let snapshot = catalog
        .definition_snapshot(port_id)
        .ok_or_else(|| PortcoveError::state("scoped acquisition lost its exact definition"))?;
    identity.validate_snapshot(snapshot)?;
    if document.grant_id != identity.grant_id
        || document.policy_revision != identity.policy_revision
        || provenance.root_sha256 != identity.repository_root_sha256
        || !document.binds_projection(&snapshot.projection()?, &snapshot.index_sha256())?
    {
        return Err(PortcoveError::conflict(
            "acquisition publisher scope changed; assess it again",
        ));
    }
    let PolicyDecision::ManagedGithub {
        repository_id,
        artifact_hosts,
        max_redirects,
        curated_checks,
        ..
    } = document.decision
    else {
        return Err(PortcoveError::unsupported(
            "publisher policy does not authorize acquisition",
        ));
    };
    let scope = crate::DefinitionAcquisitionScope {
        library: library.clone(),
        identity: Some(identity.clone()),
        policy_sha256: provenance.target_sha256,
        anchor_sha256: provenance.anchor_sha256,
        port_sha256: crate::DefinitionAcquisitionScope::port_digest(catalog.port(port_id)?)?,
        stable_id: identity.stable_id.clone(),
        repository: catalog.port(port_id)?.release.repository.clone(),
        repository_id,
        artifact_hosts,
        max_redirects,
        grant_id: document.grant_id,
        policy_revision: document.policy_revision,
        curated_checks,
        #[cfg(any(test, feature = "qualification-fixtures"))]
        fixture_origin: None,
    };
    scope.require_port(catalog.port(port_id)?)?;
    transaction.commit()?;
    Ok(Some(scope))
}

pub(crate) fn validate_current_acquisition(
    scope: &crate::DefinitionAcquisitionScope,
) -> Result<()> {
    let identity = scope
        .identity
        .as_ref()
        .ok_or_else(|| PortcoveError::state("acquisition lost its definition identity"))?;
    let connection = scope.library.connection()?;
    let transaction = connection.unchecked_transaction()?;
    let Some((document, provenance, _)) =
        stored_admission(&transaction, &identity.namespace, &identity.stable_id)?
    else {
        return Err(PortcoveError::conflict(
            "acquisition publisher admission disappeared",
        ));
    };
    if !matches!(document.decision, PolicyDecision::ManagedGithub { .. })
        || provenance.target_sha256 != scope.policy_sha256
        || provenance.anchor_sha256 != scope.anchor_sha256
        || document.grant_id != scope.grant_id
        || document.policy_revision != scope.policy_revision
    {
        return Err(PortcoveError::conflict(
            "acquisition publisher scope changed",
        ));
    }
    provenance.require_fresh()?;
    let floor =
        installed_authority_floor(&transaction, &provenance.anchor_sha256)?.ok_or_else(|| {
            PortcoveError::state("acquisition publisher authority lost its replay floor")
        })?;
    floor.check_advance(&provenance)?;
    transaction.commit()?;
    Ok(())
}

pub(crate) fn allows_candidate(
    connection: &Connection,
    candidate: &AuthenticatedDefinitionCandidate,
    namespace: &str,
    stable_id: &str,
) -> Result<bool> {
    let Some((document, provenance, _)) = stored_admission(connection, namespace, stable_id)?
    else {
        // Existing retained/test policy has its own delivered authority path.
        return Ok(!current_restrictive_grant(
            connection, namespace, stable_id,
        )?);
    };
    provenance.require_fresh()?;
    let floor = installed_authority_floor(connection, &provenance.anchor_sha256)?;
    if let Some(floor) = floor {
        floor.check_advance(&provenance)?;
    }
    Ok(
        provenance.root_sha256 == candidate.provenance().root_sha256
            && document.binds(candidate)?,
    )
}

pub(crate) fn allows_projection(
    connection: &Connection,
    projection: &crate::DefinitionCatalogProjection,
    candidate: &crate::AuthenticatedDefinitionProvenance,
) -> Result<bool> {
    let entry = projection.entry();
    let Some((document, provenance, _)) =
        stored_admission(connection, entry.namespace(), &entry.port().id)?
    else {
        return Ok(!current_restrictive_grant(
            connection,
            entry.namespace(),
            &entry.port().id,
        )?);
    };
    provenance.require_fresh()?;
    let floor = installed_authority_floor(connection, &provenance.anchor_sha256)?;
    if let Some(floor) = floor {
        floor.check_advance(&provenance)?;
    }
    Ok(provenance.root_sha256 == candidate.root_sha256
        && document.binds_projection(projection, &candidate.index_sha256)?)
}

pub(crate) fn availability_expiration(
    connection: &Connection,
    namespace: &str,
    stable_id: &str,
) -> Result<Option<i64>> {
    stored_admission(connection, namespace, stable_id)?
        .map(|(_, provenance, _)| {
            OffsetDateTime::parse(&provenance.expires_at, &Rfc3339)
                .map(|expires| expires.unix_timestamp())
                .map_err(|_| PortcoveError::state("invalid publisher policy expiration"))
        })
        .transpose()
}

#[cfg(test)]
pub(super) fn install_authority_for_test(library: &Library, root: &[u8]) -> Result<()> {
    if root.is_empty() || root.len() > 1024 * 1024 {
        return Err(PortcoveError::usage("fixture authority exceeds its bound"));
    }
    let _: tough::schema::Signed<tough::schema::Root> = serde_json::from_slice(root)?;
    let root = std::str::from_utf8(root)
        .map_err(|_| PortcoveError::usage("fixture authority must be UTF-8"))?;
    library.connection()?.execute(
        "INSERT INTO definition_publisher_authority(anchor_sha256,trusted_root_json)
         VALUES(?1,?2)",
        params![digest(root.as_bytes()), root],
    )?;
    Ok(())
}

pub(crate) fn continues_retained_launch(
    connection: &Connection,
    identity: &crate::DefinitionSelectionIdentity,
) -> Result<bool> {
    let Some((document, provenance, floor)) =
        stored_admission(connection, &identity.namespace, &identity.stable_id)?
    else {
        return Ok(false);
    };
    if !matches!(document.decision, PolicyDecision::ManagedGithub { .. })
        || provenance.root_sha256 != identity.repository_root_sha256
        || document.grant_id != identity.grant_id
        || !(floor..=document.policy_revision).contains(&identity.policy_revision)
    {
        return Ok(false);
    }
    // The installed contract keeps its exact old identity. Only independently
    // admitted unchanged authorization can bridge the policy revision here.
    let authority_floor = installed_authority_floor(connection, &provenance.anchor_sha256)?
        .ok_or_else(|| PortcoveError::state("admitted publisher authority has no replay floor"))?;
    authority_floor.check_advance(&provenance)?;
    Ok(true)
}

pub(crate) fn allows_operation(
    connection: &Connection,
    identity: &crate::DefinitionSelectionIdentity,
    context: crate::definition_eligibility::DefinitionOperationContext,
) -> Result<bool> {
    let Some((document, provenance, _)) =
        stored_admission(connection, &identity.namespace, &identity.stable_id)?
    else {
        return Ok(
            !crate::definition_acquisition::restricted_grant(&identity.grant_id)
                && !current_restrictive_grant(
                    connection,
                    &identity.namespace,
                    &identity.stable_id,
                )?,
        );
    };
    let managed = matches!(document.decision, PolicyDecision::ManagedGithub { .. });
    let permitted = match context.operation {
        DefinitionOperation::Availability => !matches!(document.decision, PolicyDecision::Revoked),
        DefinitionOperation::Install
        | DefinitionOperation::Update
        | DefinitionOperation::Prepare => managed,
        DefinitionOperation::Launch => managed && context.retained_contract,
        DefinitionOperation::RegisterExternal => false,
    };
    if !permitted {
        return Ok(false);
    }
    // Assessment reports discovery expiry as eligibility, not a read failure.
    // Actual acquisition still requires fresh proof at each request/publication.
    provenance.validate()?;
    let floor = installed_authority_floor(connection, &provenance.anchor_sha256)?
        .ok_or_else(|| PortcoveError::state("admitted publisher authority has no replay floor"))?;
    floor.check_advance(&provenance)?;
    Ok(true)
}

#[cfg(test)]
mod continuity_tests {
    use super::*;

    #[test]
    fn curated_policy_capability_is_explicit_and_unknown_to_legacy_schemas() {
        let mut supported = serde_json::json!({
            "policy_schema": 4, "namespace": "official", "stable_id": "fixture",
            "policy_revision": 1, "grant_id": "managed-github-v1-fixture",
            "decision": { "status": "managed_github", "definition_revision": 1,
                "index_sha256": "a".repeat(64), "definition_sha256": "b".repeat(64),
                "template": "n64recomp", "repository_id": 1,
                "artifact_hosts": ["github.com"], "max_redirects": 5,
                "operations": ["install", "update", "prepare", "launch"],
                "scoped_launch_checks": 1
            }
        });
        supported["policy_schema"] = 4.into();
        supported["decision"]["curated_acquisition_checks"] = 1.into();
        PolicyDocument::parse(&serde_json::to_vec(&supported).unwrap()).unwrap();
        let transitions = serde_json::json!({
            "future_acceptance_lost": false,
            "artifacts": [{"asset_id": 7, "sha256": "c".repeat(64), "status": "revoked"}]
        });
        let mut transitioned = supported.clone();
        transitioned["curated_transitions"] = transitions.clone();
        PolicyDocument::parse(&serde_json::to_vec(&transitioned).unwrap()).unwrap();
        for value in [
            serde_json::Value::Null,
            serde_json::json!({"artifacts": []}),
            serde_json::json!({"future_acceptance_lost": false, "artifacts": [], "extra": true}),
            serde_json::json!({"future_acceptance_lost": false, "artifacts": [
                {"asset_id": 7, "sha256": "c".repeat(64), "status": "unknown"}]}),
            serde_json::json!({"future_acceptance_lost": false, "artifacts": [
                {"asset_id": 0, "sha256": "c".repeat(64), "status": "revoked"}]}),
            serde_json::json!({"future_acceptance_lost": false, "artifacts": [
                {"asset_id": 7, "sha256": "C".repeat(64), "status": "revoked"}]}),
            serde_json::json!({"future_acceptance_lost": false, "artifacts": [
                transitions["artifacts"][0].clone(), transitions["artifacts"][0].clone()]}),
            serde_json::json!({"future_acceptance_lost": false, "artifacts":
                (1..=65).map(|id| serde_json::json!({"asset_id": id,
                    "sha256": "c".repeat(64), "status": "revoked"})).collect::<Vec<_>>()}),
        ] {
            let mut malformed = supported.clone();
            malformed["curated_transitions"] = value;
            assert!(PolicyDocument::parse(&serde_json::to_vec(&malformed).unwrap()).is_err());
        }
        // Isolate the transition field from the other schema-4 capability.
        for schema in [1, 2, 3] {
            let mut legacy = supported.clone();
            legacy["policy_schema"] = schema.into();
            legacy["decision"]
                .as_object_mut()
                .unwrap()
                .remove("curated_acquisition_checks");
            if schema == 1 {
                legacy["grant_id"] = "availability-v1-fixture".into();
                legacy["decision"] = serde_json::json!({"status":"availability",
                    "definition_revision":1, "index_sha256":"a".repeat(64),
                    "definition_sha256":"b".repeat(64), "template":"n64recomp"});
            }
            if schema < 3 {
                legacy["decision"]
                    .as_object_mut()
                    .unwrap()
                    .remove("scoped_launch_checks");
            }
            PolicyDocument::parse(&serde_json::to_vec(&legacy).unwrap()).unwrap();
            legacy["curated_transitions"] = transitions.clone();
            assert!(PolicyDocument::parse(&serde_json::to_vec(&legacy).unwrap()).is_err());
            legacy["curated_transitions"] = serde_json::Value::Null;
            assert!(PolicyDocument::parse(&serde_json::to_vec(&legacy).unwrap()).is_err());
        }
        for schema in [1, 2, 3] {
            let mut legacy = supported.clone();
            legacy["policy_schema"] = schema.into();
            assert!(PolicyDocument::parse(&serde_json::to_vec(&legacy).unwrap()).is_err());
        }
        for value in [serde_json::Value::Null, 0.into(), 2.into()] {
            let mut unsupported = supported.clone();
            unsupported["decision"]["curated_acquisition_checks"] = value;
            assert!(PolicyDocument::parse(&serde_json::to_vec(&unsupported).unwrap()).is_err());
        }
        let mut missing = supported.clone();
        missing["decision"]
            .as_object_mut()
            .unwrap()
            .remove("curated_acquisition_checks");
        assert!(PolicyDocument::parse(&serde_json::to_vec(&missing).unwrap()).is_err());
    }

    #[test]
    fn authorization_continuity_excludes_only_definition_bindings_and_revision() {
        let baseline = PolicyDocument {
            policy_schema: 2,
            curated_transitions: None,
            namespace: "official".into(),
            stable_id: "owned-fixture".into(),
            policy_revision: 1,
            grant_id: "managed-github-v1-fixture".into(),
            decision: PolicyDecision::ManagedGithub {
                definition_revision: 7,
                index_sha256: "a".repeat(64),
                definition_sha256: "b".repeat(64),
                template: "n64recomp".into(),
                repository_id: 1296269,
                artifact_hosts: vec![
                    "github.com".into(),
                    "release-assets.githubusercontent.com".into(),
                ],
                max_redirects: 5,
                operations: vec![
                    "install".into(),
                    "update".into(),
                    "prepare".into(),
                    "launch".into(),
                ],
                launch_checks: None,
                curated_checks: None,
            },
        };
        let encoded = serde_json::to_value(&baseline).unwrap();
        for (field, value) in [
            ("policy_schema", serde_json::json!(1)),
            ("namespace", serde_json::json!("other")),
            ("stable_id", serde_json::json!("other")),
            ("grant_id", serde_json::json!("managed-github-v1-other")),
            ("template", serde_json::json!("libultraship")),
            ("repository_id", serde_json::json!(1296270)),
            ("artifact_hosts", serde_json::json!(["github.com"])),
            ("max_redirects", serde_json::json!(4)),
            ("operations", serde_json::json!(["launch"])),
        ] {
            let mut changed = encoded.clone();
            if changed.get(field).is_some() {
                changed[field] = value;
            } else {
                changed["decision"][field] = value;
            }
            let changed: PolicyDocument = serde_json::from_value(changed).unwrap();
            assert!(
                !changed.continues_managed_authorization(&baseline),
                "{field}"
            );
        }
        let mut corrected = encoded;
        corrected["policy_revision"] = 2.into();
        corrected["decision"]["definition_revision"] = 8.into();
        corrected["decision"]["index_sha256"] = "c".repeat(64).into();
        corrected["decision"]["definition_sha256"] = "d".repeat(64).into();
        corrected["decision"]["artifact_hosts"] =
            serde_json::json!(["release-assets.githubusercontent.com", "github.com"]);
        corrected["decision"]["operations"] =
            serde_json::json!(["launch", "prepare", "update", "install"]);
        let corrected: PolicyDocument = serde_json::from_value(corrected).unwrap();
        assert!(corrected.continues_managed_authorization(&baseline));
    }
}
