//! Independently accepted exact managed Launch failures and explicit corrections.
//! Observations and missing metadata cannot establish or erase these decisions.
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{PolicyDecision, PolicyProvenance, digest, valid_identity, valid_sha256};
use crate::{Library, Platform, PortcoveError, ReleaseChannel, Result};

const MAX_DECISIONS: usize = 128;

/// Order the final managed authority read and child creation against admission.
/// No session writes or child waiting belong in this bounded interval.
pub(crate) fn with_launch_admission<T>(
    library: &Library,
    launch: impl FnOnce() -> Result<T>,
) -> Result<T> {
    let mut connection = library.connection()?;
    let _guard = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    launch()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Artifact {
    asset_name: String,
    sha256: String,
    size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Operation {
    Launch,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Subject {
    version: String,
    channel: ReleaseChannel,
    platform: Platform,
    artifact: Artifact,
    operation: Operation,
}

impl Subject {
    fn key(&self) -> Result<[u8; 32]> {
        if self.version.is_empty()
            || self.version.len() > 255
            || self.version.chars().any(char::is_control)
            || self.artifact.asset_name.is_empty()
            || self.artifact.asset_name.len() > 255
            || self.artifact.asset_name.chars().any(char::is_control)
            || !valid_sha256(&self.artifact.sha256)
            || self.artifact.size == 0
        {
            return Err(PortcoveError::verification(
                "invalid exact launch assessment subject",
            ));
        }
        Ok(Sha256::digest(serde_json::to_vec(self)?).into())
    }
}

/// Only the manifest verifier supplies this subject to managed lifecycle consumers.
pub(crate) fn verified_subject_key(
    install: &crate::InstallRecord,
    platform: Platform,
) -> Result<[u8; 32]> {
    Subject {
        version: install.version.clone(),
        channel: install.channel,
        platform,
        artifact: Artifact {
            asset_name: install.artifact.asset_name.clone(),
            sha256: install.artifact.sha256.clone(),
            size: install.artifact.size,
        },
        operation: Operation::Launch,
    }
    .key()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
enum Decision {
    Held {
        failure_sha256: String,
    },
    Cleared {
        previous_decision_sha256: String,
        correction_sha256: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Assessment {
    subject: Subject,
    check_id: String,
    check_input_sha256: String,
    revision: u64,
    decision: Decision,
}

impl Assessment {
    fn validate(&self) -> Result<()> {
        self.subject.key()?;
        let hashes = match &self.decision {
            Decision::Held { failure_sha256 } => vec![failure_sha256],
            Decision::Cleared {
                previous_decision_sha256,
                correction_sha256,
            } => vec![previous_decision_sha256, correction_sha256],
        };
        if !valid_identity(&self.check_id)
            || !valid_sha256(&self.check_input_sha256)
            || self.revision == 0
            || self.revision > i64::MAX as u64
            || hashes.into_iter().any(|hash| !valid_sha256(hash))
        {
            return Err(PortcoveError::verification(
                "invalid accepted launch decision",
            ));
        }
        Ok(())
    }
    fn sha256(&self) -> Result<String> {
        Ok(digest(&serde_json::to_vec(self)?))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Document {
    assessment_schema: u32,
    namespace: String,
    stable_id: String,
    policy_sha256: String,
    revision: u64,
    assessments: Vec<Assessment>,
}

impl Document {
    fn parse(bytes: &[u8]) -> Result<Self> {
        if bytes.is_empty() || bytes.len() as u64 > super::MAX_POLICY_BYTES {
            return Err(PortcoveError::verification(
                "launch assessments exceed their byte bound",
            ));
        }
        let _: crate::definition_entry::strict_json::UniqueValue = serde_json::from_slice(bytes)?;
        let document: Self = serde_json::from_slice(bytes)?;
        if document.assessment_schema != 1 {
            return Err(PortcoveError::unsupported(
                "unsupported launch assessment format",
            ));
        }
        if document.namespace != "official"
            || !valid_identity(&document.stable_id)
            || !valid_sha256(&document.policy_sha256)
            || document.revision == 0
            || document.revision > i64::MAX as u64
            || document.assessments.len() > MAX_DECISIONS
        {
            return Err(PortcoveError::verification(
                "invalid launch assessment identity",
            ));
        }
        let mut keys = std::collections::BTreeSet::new();
        for assessment in &document.assessments {
            assessment.validate()?;
            if assessment.revision > document.revision
                || !keys.insert((assessment.subject.key()?, &assessment.check_id))
            {
                return Err(PortcoveError::verification(
                    "duplicate or conflicting launch assessments",
                ));
            }
        }
        Ok(document)
    }
}

/// Private construction binds inert bytes to the existing independent policy role.
#[derive(Debug)]
pub struct AuthenticatedDefinitionLaunchAssessment {
    document: Document,
    bytes: Vec<u8>,
    provenance: PolicyProvenance,
}

impl AuthenticatedDefinitionLaunchAssessment {
    /// Canonical exact decision identities for a subsequent explicit correction.
    /// Authentication and this inspection do not imply library admission.
    pub fn decision_sha256s(&self) -> Result<Vec<String>> {
        self.document
            .assessments
            .iter()
            .map(Assessment::sha256)
            .collect()
    }
}

pub async fn acquire_definition_launch_assessment(
    source: &crate::DefinitionRepositorySource,
    trusted_root: &[u8],
    namespace: &str,
    stable_id: &str,
) -> Result<AuthenticatedDefinitionLaunchAssessment> {
    let transport = super::super::DefinitionHttpsTransport::new(source)?;
    tokio::time::timeout(
        super::super::ACQUISITION_TIMEOUT,
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
    .map_err(|_| PortcoveError::network("launch assessment acquisition timed out"))?
}

pub(crate) async fn acquire_with_transport<T>(
    trusted_root: &[u8],
    metadata_base_url: reqwest::Url,
    targets_base_url: reqwest::Url,
    transport: T,
    namespace: &str,
    stable_id: &str,
) -> Result<AuthenticatedDefinitionLaunchAssessment>
where
    T: tough::Transport + Send + Sync + 'static,
{
    if namespace != "official" || !valid_identity(stable_id) {
        return Err(PortcoveError::usage(
            "unsupported launch assessment identity",
        ));
    }
    // A dot cannot occur in a grant stable ID, so this cannot alias its target.
    let (bytes, provenance) = super::acquire_target_with_transport(
        trusted_root,
        metadata_base_url,
        targets_base_url,
        transport,
        &format!("policy/{namespace}/{stable_id}.launch.json"),
    )
    .await?;
    let document = Document::parse(&bytes)?;
    if document.namespace != namespace || document.stable_id != stable_id {
        return Err(PortcoveError::verification(
            "launch assessment target identity differs",
        ));
    }
    Ok(AuthenticatedDefinitionLaunchAssessment {
        document,
        bytes,
        provenance,
    })
}

fn stored_decision(
    connection: &Connection,
    namespace: &str,
    stable_id: &str,
    subject: &str,
    check: &str,
) -> Result<Option<(Assessment, String)>> {
    let row: Option<(String, String, String)> = connection
        .query_row(
            "SELECT decision_json,anchor_sha256,decision_sha256 FROM definition_launch_decisions
         WHERE namespace=?1 AND stable_id=?2 AND subject_sha256=?3 AND check_id=?4",
            params![namespace, stable_id, subject, check],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    row.map(|(bytes, anchor, expected_sha256)| {
        if bytes.len() > 4096 || !valid_sha256(&anchor) {
            return Err(PortcoveError::state(
                "stored launch decision exceeds its bounds",
            ));
        }
        let _: crate::definition_entry::strict_json::UniqueValue = serde_json::from_str(&bytes)?;
        let assessment: Assessment = serde_json::from_str(&bytes)?;
        assessment.validate()?;
        if hex::encode(assessment.subject.key()?) != subject
            || assessment.check_id != check
            || assessment.sha256()? != expected_sha256
        {
            return Err(PortcoveError::state(
                "stored launch decision identity differs",
            ));
        }
        Ok((assessment, anchor))
    })
    .transpose()
}

impl Library {
    /// Atomically accept independent Launch decisions; omission never clears a hold.
    /// This does not provision trust or mutate the definition/acquisition grant.
    pub fn apply_definition_launch_assessment(
        &self,
        accepted: &AuthenticatedDefinitionLaunchAssessment,
    ) -> Result<bool> {
        let document = &accepted.document;
        accepted.provenance.require_fresh()?;
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (grant, grant_provenance) =
            super::stored_admission(&transaction, &document.namespace, &document.stable_id)?
                .ok_or_else(|| {
                    PortcoveError::conflict("launch assessment requires its installed grant")
                })?;
        grant_provenance.require_fresh()?;
        if grant.policy_schema != 3
            || !matches!(
                grant.decision,
                PolicyDecision::ManagedGithub {
                    launch_checks: Some(1),
                    ..
                }
            )
            || grant_provenance.target_sha256 != document.policy_sha256
            || grant_provenance.anchor_sha256 != accepted.provenance.anchor_sha256
            || grant_provenance.root_sha256 != accepted.provenance.root_sha256
        {
            return Err(PortcoveError::conflict(
                "launch assessment differs from its supported grant",
            ));
        }
        let floor =
            super::installed_authority_floor(&transaction, &accepted.provenance.anchor_sha256)?
                .ok_or_else(|| {
                    PortcoveError::state("launch assessment authority has no replay floor")
                })?;
        accepted.provenance.check_advance(&floor)?;
        let established =
            established_revision(&transaction, &document.namespace, &document.stable_id)?;
        let previous: Option<(String, String, String)> = transaction.query_row(
            "SELECT document_json,provenance_json,inventory_sha256 FROM definition_launch_assessments
             WHERE namespace=?1 AND stable_id=?2", params![document.namespace, document.stable_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).optional()?;
        let prior_inventory = inventory(&transaction, &document.namespace, &document.stable_id)?;
        let unchanged = if let Some((bytes, provenance, expected_inventory)) = &previous {
            if provenance.len() > 16 * 1024 || prior_inventory.0 != *expected_inventory {
                return Err(PortcoveError::state(
                    "stored launch decision inventory differs",
                ));
            }
            let prior = Document::parse(bytes.as_bytes())?;
            if established == 0 || prior.revision != established {
                return Err(PortcoveError::state(
                    "accepted launch assessment lost its established floor",
                ));
            }
            let provenance: PolicyProvenance = serde_json::from_str(provenance)?;
            provenance.validate()?;
            if provenance.target_sha256 != digest(bytes.as_bytes())
                || prior.namespace != document.namespace
                || prior.stable_id != document.stable_id
            {
                return Err(PortcoveError::state(
                    "stored launch assessment identity differs",
                ));
            }
            if document.revision < prior.revision
                || (document.revision == prior.revision && accepted.bytes != bytes.as_bytes())
            {
                return Err(PortcoveError::verification(
                    "launch assessment replay or equivocation",
                ));
            }
            document == &prior && accepted.provenance == provenance && accepted.provenance == floor
        } else {
            if established > 0 || !prior_inventory.1.is_empty() {
                return Err(PortcoveError::state(
                    "accepted launch decisions lost their baseline",
                ));
            }
            false
        };
        for assessment in &document.assessments {
            let key = hex::encode(assessment.subject.key()?);
            let prior = stored_decision(
                &transaction,
                &document.namespace,
                &document.stable_id,
                &key,
                &assessment.check_id,
            )?;
            if let Some((prior, anchor)) = &prior
                && (anchor != &accepted.provenance.anchor_sha256
                    || assessment.revision < prior.revision
                    || (assessment.revision == prior.revision && assessment != prior))
            {
                return Err(PortcoveError::verification(
                    "launch decision replay or equivocation",
                ));
            }
            if let Decision::Cleared {
                previous_decision_sha256,
                ..
            } = &assessment.decision
            {
                let prior = prior.as_ref().ok_or_else(|| {
                    PortcoveError::verification("correction has no accepted failure")
                })?;
                // Exact retries retain the accepted correction. New correction must
                // bind the current failure, not another scope or an older failure.
                if assessment != &prior.0
                    && (!matches!(prior.0.decision, Decision::Held { .. })
                        || prior.0.sha256()? != *previous_decision_sha256)
                {
                    return Err(PortcoveError::verification(
                        "correction differs from its accepted failure",
                    ));
                }
            }
            let bytes = serde_json::to_string(assessment)?;
            if bytes.len() > 4096 {
                return Err(PortcoveError::verification(
                    "accepted launch decision exceeds its bound",
                ));
            }
            transaction.execute("INSERT INTO definition_launch_decisions
                (namespace,stable_id,subject_sha256,check_id,anchor_sha256,decision_sha256,decision_json)
                VALUES(?1,?2,?3,?4,?5,?6,?7)
                ON CONFLICT(namespace,stable_id,subject_sha256,check_id) DO UPDATE SET
                anchor_sha256=excluded.anchor_sha256,decision_sha256=excluded.decision_sha256,
                decision_json=excluded.decision_json",
                params![document.namespace, document.stable_id, key, assessment.check_id,
                    accepted.provenance.anchor_sha256, assessment.sha256()?, bytes])?;
        }
        let count: i64 = transaction.query_row(
            "SELECT COUNT(*) FROM definition_launch_decisions
            WHERE namespace=?1 AND stable_id=?2",
            params![document.namespace, document.stable_id],
            |row| row.get(0),
        )?;
        if count > MAX_DECISIONS as i64 {
            return Err(PortcoveError::verification(
                "retained launch decisions exceed their bound",
            ));
        }
        let bytes = std::str::from_utf8(&accepted.bytes)
            .map_err(|_| PortcoveError::verification("launch assessments must be UTF-8"))?;
        let provenance = serde_json::to_string(&accepted.provenance)?;
        let inventory_sha256 = inventory(&transaction, &document.namespace, &document.stable_id)?.0;
        transaction.execute("INSERT INTO definition_launch_assessments
            (namespace,stable_id,document_json,provenance_json,inventory_sha256) VALUES(?1,?2,?3,?4,?5)
            ON CONFLICT(namespace,stable_id) DO UPDATE SET
            document_json=excluded.document_json,provenance_json=excluded.provenance_json,
            inventory_sha256=excluded.inventory_sha256",
            params![document.namespace, document.stable_id, bytes, provenance, inventory_sha256])?;
        transaction.execute(
            "UPDATE definition_publisher_authority SET replay_floor_json=?1
            WHERE anchor_sha256=?2",
            params![provenance, accepted.provenance.anchor_sha256],
        )?;
        accepted.provenance.require_fresh()?;
        grant_provenance.require_fresh()?;
        transaction.execute(
            "UPDATE definition_publisher_admission SET launch_assessment_revision=?1
            WHERE namespace=?2 AND stable_id=?3",
            params![
                document.revision as i64,
                document.namespace,
                document.stable_id
            ],
        )?;
        transaction.commit()?;
        Ok(!unchanged)
    }
}

pub(super) fn established_revision(
    connection: &Connection,
    namespace: &str,
    stable_id: &str,
) -> Result<u64> {
    let revision: Option<i64> = connection
        .query_row(
            "SELECT launch_assessment_revision
        FROM definition_publisher_admission WHERE namespace=?1 AND stable_id=?2",
            params![namespace, stable_id],
            |row| row.get(0),
        )
        .optional()?;
    match revision {
        Some(revision) if revision >= 0 => Ok(revision as u64),
        None => Ok(0),
        _ => Err(PortcoveError::state(
            "invalid accepted launch assessment floor",
        )),
    }
}

fn inventory(
    connection: &Connection,
    namespace: &str,
    stable_id: &str,
) -> Result<(String, Vec<(Assessment, String)>)> {
    let mut statement = connection.prepare(
        "SELECT subject_sha256,check_id
        FROM definition_launch_decisions WHERE namespace=?1 AND stable_id=?2
        ORDER BY subject_sha256,check_id LIMIT 129",
    )?;
    let keys = statement
        .query_map(params![namespace, stable_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if keys.len() > MAX_DECISIONS {
        return Err(PortcoveError::state(
            "retained launch decisions exceed their bound",
        ));
    }
    let mut identities = Vec::new();
    let mut assessments = Vec::new();
    for (key, check) in keys {
        let (assessment, anchor) = stored_decision(connection, namespace, stable_id, &key, &check)?
            .ok_or_else(|| PortcoveError::state("accepted launch decision disappeared"))?;
        identities.push((key, check, assessment.sha256()?, anchor.clone()));
        assessments.push((assessment, anchor));
    }
    Ok((digest(&serde_json::to_vec(&identities)?), assessments))
}

/// None is a missing supported assessment/subject, never an accepted failure.
pub(crate) fn requires_subject(
    connection: &Connection,
    identity: &crate::DefinitionSelectionIdentity,
) -> Result<bool> {
    Ok(
        super::stored_admission(connection, &identity.namespace, &identity.stable_id)?.is_some_and(
            |(grant, _)| {
                matches!(
                    grant.decision,
                    PolicyDecision::ManagedGithub {
                        launch_checks: Some(1),
                        ..
                    }
                ) && grant.policy_schema == 3
            },
        ),
    )
}

pub(crate) fn checks_passed(
    connection: &Connection,
    identity: &crate::DefinitionSelectionIdentity,
    context: crate::definition_eligibility::DefinitionOperationContext,
) -> Result<Option<bool>> {
    if context.operation != crate::DefinitionOperation::Launch {
        return Ok(Some(true));
    }
    let Some((grant, provenance)) =
        super::stored_admission(connection, &identity.namespace, &identity.stable_id)?
    else {
        return Ok(Some(true));
    };
    // Explicit revocation remains the typed refusal; its lower-schema document
    // does not clear or reset any accepted subject decision or revision floor.
    if matches!(grant.decision, PolicyDecision::Revoked) {
        return Ok(Some(true));
    }
    let established = established_revision(connection, &identity.namespace, &identity.stable_id)?;
    if grant.policy_schema != 3 && established > 0 {
        return Err(PortcoveError::state(
            "accepted launch check format was downgraded",
        ));
    }
    if grant.policy_schema != 3 {
        return Ok(Some(true));
    }
    let Some(subject) = context.launch_subject else {
        return Ok(None);
    };
    let row: Option<(String, String, String)> = connection.query_row(
        "SELECT document_json,provenance_json,inventory_sha256 FROM definition_launch_assessments
         WHERE namespace=?1 AND stable_id=?2", params![identity.namespace, identity.stable_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).optional()?;
    let Some((bytes, proof, expected_inventory)) = row else {
        if established > 0 {
            return Err(PortcoveError::state("accepted launch baseline disappeared"));
        }
        return Ok(None);
    };
    if proof.len() > 16 * 1024 {
        return Err(PortcoveError::state("launch provenance exceeds its bound"));
    }
    let document = Document::parse(bytes.as_bytes())?;
    if established == 0 || established != document.revision {
        return Err(PortcoveError::state(
            "accepted launch baseline differs from its established floor",
        ));
    }
    let proof: PolicyProvenance = serde_json::from_str(&proof)?;
    proof.validate()?;
    if document.namespace != identity.namespace
        || document.stable_id != identity.stable_id
        || proof.target_sha256 != digest(bytes.as_bytes())
        || proof.anchor_sha256 != provenance.anchor_sha256
    {
        return Err(PortcoveError::state(
            "stored launch baseline identity differs",
        ));
    }
    let floor = super::installed_authority_floor(connection, &proof.anchor_sha256)?
        .ok_or_else(|| PortcoveError::state("launch assessment authority lost its replay floor"))?;
    floor.check_advance(&proof)?;
    // A changed grant cannot supply a baseline for a newly interpreted contract.
    // Existing accepted failures are durable and are not deleted by that refresh.
    if document.policy_sha256 != provenance.target_sha256 {
        return Ok(None);
    }
    let (inventory_sha256, assessments) =
        inventory(connection, &identity.namespace, &identity.stable_id)?;
    if inventory_sha256 != expected_inventory {
        return Err(PortcoveError::state(
            "stored launch decision inventory differs",
        ));
    }
    let mut passed = true;
    for (assessment, anchor) in assessments {
        if anchor != proof.anchor_sha256 {
            return Err(PortcoveError::state(
                "accepted launch decision authority differs",
            ));
        }
        if assessment.subject.key()? == subject {
            passed &= !matches!(assessment.decision, Decision::Held { .. });
        }
    }
    Ok(Some(passed))
}
