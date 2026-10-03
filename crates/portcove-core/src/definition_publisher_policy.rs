//! Independently authenticated exact-definition availability policy.
//! This first policy schema grants no acquisition or lifecycle operation.

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
    let (bytes, provenance) = acquire_target_with_transport(
        trusted_root,
        metadata_base_url,
        targets_base_url,
        transport,
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

async fn acquire_target_with_transport<T>(
    trusted_root: &[u8],
    metadata_base_url: reqwest::Url,
    targets_base_url: reqwest::Url,
    transport: T,
    target_path: &str,
) -> Result<(Vec<u8>, PolicyProvenance)>
where
    T: Transport + Send + Sync + 'static,
{
    let repository =
        super::load_repository(trusted_root, metadata_base_url, targets_base_url, transport)
            .await?;
    let role = policy_role(&repository)?;
    let metadata = role
        .targets
        .as_ref()
        .ok_or_else(|| PortcoveError::verification("publisher policy delegation was not loaded"))?;
    let name = TargetName::new(target_path).map_err(super::map_tough_error)?;
    let target = super::definition_target(role, &repository, &name)?;
    let bytes = super::read_target(&repository, &name, target, MAX_POLICY_BYTES).await?;
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
    fn parse(bytes: &[u8]) -> Result<Self> {
        if bytes.is_empty() || bytes.len() as u64 > MAX_POLICY_BYTES {
            return Err(PortcoveError::verification(
                "publisher policy exceeds its byte bound",
            ));
        }
        let raw: crate::definition_entry::strict_json::UniqueValue = serde_json::from_slice(bytes)?;
        let value: Self = serde_json::from_slice(bytes)?;
        if value.policy_schema != 3
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
        if !matches!(value.policy_schema, 1 | 2 | 3) {
            return Err(PortcoveError::unsupported(
                "unsupported publisher policy schema",
            ));
        }
        let restricted = crate::definition_acquisition::restricted_grant(&value.grant_id);
        if (value.policy_schema == 1
            && (restricted || matches!(value.decision, PolicyDecision::ManagedGithub { .. })))
            || (matches!(value.policy_schema, 2 | 3)
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
            ..
        } = &value.decision
        {
            if (value.policy_schema == 3 && *launch_checks != Some(1))
                || (value.policy_schema != 3 && launch_checks.is_some())
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
            crate::DefinitionAcquisitionScope::validate_port(entry.port())?;
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
) -> Result<Option<(PolicyDocument, PolicyProvenance)>> {
    let row: Option<(String, String, String)> = connection
        .query_row(
            "SELECT anchor_sha256,policy_json,provenance_json FROM definition_publisher_admission
         WHERE namespace=?1 AND stable_id=?2",
            params![namespace, stable_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    row.map(|(anchor, document, provenance)| {
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
        Ok((document, provenance))
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
        if let Some((previous, identity)) = &previous {
            if launch_assessment::established_revision(
                &transaction,
                &policy.document.namespace,
                &policy.document.stable_id,
            )? > 0
                && policy.document.policy_schema != 3
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
        let unchanged = previous.as_ref().is_some_and(|(document, provenance)| {
            document == &policy.document && provenance == &policy.provenance
        }) && floor.as_ref() == Some(&policy.provenance);
        let status = if matches!(policy.document.decision, PolicyDecision::Revoked) {
            "revoked"
        } else {
            "scoped"
        };
        transaction.execute(
            "INSERT INTO definition_publisher_admission
             (namespace,stable_id,anchor_sha256,policy_json,provenance_json)
             VALUES(?1,?2,?3,?4,?5)
             ON CONFLICT(namespace,stable_id) DO UPDATE SET
             anchor_sha256=excluded.anchor_sha256,policy_json=excluded.policy_json,
             provenance_json=excluded.provenance_json",
            params![
                policy.document.namespace,
                policy.document.stable_id,
                policy.provenance.anchor_sha256,
                document,
                provenance
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
    let Some((document, provenance)) =
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
        #[cfg(test)]
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
    let Some((document, provenance)) =
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
    let Some((document, provenance)) = stored_admission(connection, namespace, stable_id)? else {
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
    let Some((document, provenance)) =
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
        .map(|(_, provenance)| {
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

pub(crate) fn allows_operation(
    connection: &Connection,
    identity: &crate::DefinitionSelectionIdentity,
    context: crate::definition_eligibility::DefinitionOperationContext,
) -> Result<bool> {
    let Some((document, provenance)) =
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
