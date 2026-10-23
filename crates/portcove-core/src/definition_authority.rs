//! One-time installation of the release's fixed catalog trust anchor.
//! Candidate data, public API arguments and environment cannot choose this root.

use std::collections::BTreeSet;

use rusqlite::{Connection, TransactionBehavior, params, types::ValueRef};
use schemars::JsonSchema;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tough::schema::{RoleType, Root, Signed};

use crate::{Library, PortcoveError, Result};

const COMPILED_ROOT: &[u8] = include_bytes!("../catalog/official-definition-root.json");
// This appointment belongs to reviewed source, never a downloaded Root or API argument.
const COMPILED_INITIAL_ROOT_PROFILE: &str = "single-owner-one-of-one-v1";
const MAX_ROOT_BYTES: usize = 1024 * 1024;
const MAX_REVIEW_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct DefinitionAuthorityReview {
    pub provisioning_schema: u32,
    pub configured: bool,
    pub library_id: String,
    pub compiled_anchor_sha256: Option<String>,
    pub installed_anchor_sha256: Option<String>,
    pub installed: bool,
    pub expected_plan: String,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct DefinitionAuthorityProvisioning {
    pub changed: bool,
    pub review: DefinitionAuthorityReview,
}

#[derive(Clone, Copy)]
enum InitialRootProfile {
    LegacyTwoOfThreeV1,
    SingleOwnerOneOfOneV1,
}

fn compiled_profile() -> Result<InitialRootProfile> {
    match COMPILED_INITIAL_ROOT_PROFILE {
        "legacy-two-of-three-v1" => Ok(InitialRootProfile::LegacyTwoOfThreeV1),
        "single-owner-one-of-one-v1" => Ok(InitialRootProfile::SingleOwnerOneOfOneV1),
        _ => Err(PortcoveError::state(
            "compiled initial Root profile is unknown",
        )),
    }
}

fn configured_root(bytes: &[u8], profile: InitialRootProfile) -> Result<Option<&str>> {
    if bytes.is_empty() || bytes.len() > MAX_ROOT_BYTES {
        return Err(PortcoveError::state(
            "compiled definition root exceeds its bound",
        ));
    }
    let text = std::str::from_utf8(bytes)
        .map_err(|_| PortcoveError::state("compiled definition root must be UTF-8"))?;
    if text.trim() == "null" {
        return Ok(None);
    }
    let root: Signed<Root> = serde_json::from_slice(bytes)?;
    if root.signed.spec_version != "1.0.0"
        || !root.signed.consistent_snapshot
        || root.signed.roles.len() != 4
    {
        return Err(PortcoveError::verification(
            "compiled catalog root role contract differs",
        ));
    }
    if matches!(profile, InitialRootProfile::SingleOwnerOneOfOneV1)
        && (!root.signed._extra.is_empty()
            || root
                .signed
                .roles
                .values()
                .any(|role| !role._extra.is_empty()))
    {
        return Err(PortcoveError::verification(
            "single-owner catalog Root extensions are unsupported",
        ));
    }
    let mut materials = BTreeSet::new();
    let mut ids = BTreeSet::new();
    for role in [
        RoleType::Root,
        RoleType::Targets,
        RoleType::Snapshot,
        RoleType::Timestamp,
    ] {
        let keys = root.signed.roles.get(&role).ok_or_else(|| {
            PortcoveError::verification("compiled catalog root is missing a role")
        })?;
        let (count, threshold) = if role == RoleType::Root {
            match profile {
                InitialRootProfile::LegacyTwoOfThreeV1 => (3, 2),
                InitialRootProfile::SingleOwnerOneOfOneV1 => (1, 1),
            }
        } else {
            (1, 1)
        };
        if keys.keyids.len() != count || keys.threshold.get() != threshold {
            return Err(PortcoveError::verification(
                "compiled catalog root differs from its appointed initial profile or separated role keys",
            ));
        }
        for id in &keys.keyids {
            let key = root.signed.keys.get(id).ok_or_else(|| {
                PortcoveError::verification("compiled catalog role key is missing")
            })?;
            if matches!(profile, InitialRootProfile::SingleOwnerOneOfOneV1)
                && !matches!(key, tough::schema::key::Key::Ed25519 { .. })
            {
                return Err(PortcoveError::verification(
                    "single-owner catalog roles require Ed25519",
                ));
            }
            let (algorithm, public) = super::signing_material(key);
            if !ids.insert(hex::encode(id.as_ref()))
                || !materials.insert((algorithm.to_owned(), public.to_vec()))
            {
                return Err(PortcoveError::verification(
                    "compiled catalog roles share signing material",
                ));
            }
        }
    }
    if ids.len() != root.signed.keys.len() {
        return Err(PortcoveError::verification(
            "compiled catalog root has unused key material",
        ));
    }
    root.signed
        .verify_role(&root)
        .map_err(|_| PortcoveError::verification("compiled catalog root signatures are invalid"))?;
    // This installs only an immutable trust anchor. Existing TUF loading must
    // authenticate rotations and fresh metadata before any operation is admitted.
    Ok(Some(text))
}

const TABLES: &[(&str, &str)] = &[
    ("definition_publisher_authority", "anchor_sha256"),
    ("definition_publisher_policy", "namespace,stable_id"),
    ("definition_publisher_admission", "namespace,stable_id"),
    ("definition_launch_assessments", "namespace,stable_id"),
    (
        "definition_launch_decisions",
        "namespace,stable_id,subject_sha256,check_id",
    ),
    ("curated_artifact_admissions", "repository_id,asset_id"),
    ("curated_artifact_history", "singleton"),
    (
        "curated_artifact_scopes",
        "repository_id,asset_id,namespace,stable_id,anchor_sha256",
    ),
    ("curated_transition_receipts", "policy_sha256"),
    ("listing_delivery", "singleton"),
];

fn retained_state(connection: &Connection, omit_unadmitted_anchor: bool) -> Result<String> {
    let mut hash = Sha256::new();
    let mut total = 0usize;
    for (table, order) in TABLES {
        hash.update((table.len() as u64).to_be_bytes());
        hash.update(table.as_bytes());
        let omit = *table == "definition_publisher_authority" && omit_unadmitted_anchor;
        let sql = format!(
            "SELECT * FROM {table} {} ORDER BY {order}",
            if omit { "WHERE 0" } else { "" }
        );
        let mut statement = connection.prepare(&sql)?;
        let columns = statement.column_count();
        hash.update((columns as u64).to_be_bytes());
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            hash.update(b"row");
            for column in 0..columns {
                match row.get_ref(column)? {
                    ValueRef::Null => hash.update(b"null"),
                    ValueRef::Integer(value) => {
                        hash.update(b"integer");
                        hash.update(value.to_be_bytes());
                    }
                    ValueRef::Text(bytes) => {
                        total = total
                            .checked_add(bytes.len())
                            .filter(|value| *value <= MAX_REVIEW_BYTES)
                            .ok_or_else(|| {
                                PortcoveError::state(
                                    "definition authority review exceeds its byte bound",
                                )
                            })?;
                        hash.update(b"text");
                        hash.update((bytes.len() as u64).to_be_bytes());
                        hash.update(bytes);
                    }
                    _ => {
                        return Err(PortcoveError::state(
                            "unexpected definition authority storage type",
                        ));
                    }
                }
            }
        }
    }
    Ok(hex::encode(hash.finalize()))
}

fn has_retained_history(connection: &Connection) -> Result<bool> {
    for (table, _) in TABLES.iter().skip(1) {
        if *table == "curated_artifact_history" {
            continue;
        }
        let exists: bool = connection.query_row(
            &format!("SELECT EXISTS(SELECT 1 FROM {table})"),
            [],
            |row| row.get(0),
        )?;
        if exists {
            return Ok(true);
        }
    }
    Ok(false)
}

fn review_from(
    library: &Library,
    connection: &Connection,
    root: Option<&str>,
    omit_unadmitted_anchor: bool,
) -> Result<DefinitionAuthorityReview> {
    // Reuse the admission and immutable curated-history validators; this is no
    // repair or policy-admission path and cannot reset a floor or clear a hold.
    super::validate_stored_admissions(connection)?;
    super::retained_curated_transitions(connection)?;
    for table in [
        "definition_publisher_policy",
        "definition_launch_assessments",
        "definition_launch_decisions",
    ] {
        let orphan: bool = connection.query_row(
            &format!("SELECT EXISTS(SELECT 1 FROM {table} AS retained LEFT JOIN definition_publisher_admission AS admission ON retained.namespace=admission.namespace AND retained.stable_id=admission.stable_id WHERE admission.namespace IS NULL)"),
            [], |row| row.get(0),
        )?;
        if orphan {
            return Err(PortcoveError::state(
                "retained definition state lost its admission baseline",
            ));
        }
    }
    super::launch_assessment::validate_retained_baselines(connection)?;
    let mut statement = connection.prepare(
        "SELECT anchor_sha256,trusted_root_json,replay_floor_json FROM definition_publisher_authority ORDER BY anchor_sha256 LIMIT 2",
    )?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if rows.len() > 1 {
        return Err(PortcoveError::conflict(
            "definition authority provisioning cannot replace multiple authorities",
        ));
    }
    let anchor = root.map(|bytes| hex::encode(Sha256::digest(bytes.as_bytes())));
    if let Some((saved, bytes, _)) = rows.first() {
        if bytes.len() > MAX_ROOT_BYTES || hex::encode(Sha256::digest(bytes.as_bytes())) != *saved {
            return Err(PortcoveError::state(
                "stored definition authority bytes differ",
            ));
        }
        super::installed_authority_floor(connection, saved)?;
        if let Some(root) = root
            && (anchor.as_ref() != Some(saved) || bytes != root)
        {
            return Err(PortcoveError::conflict(
                "compiled definition authority differs; provisioning cannot rotate trust",
            ));
        }
    } else if has_retained_history(connection)? {
        return Err(PortcoveError::state(
            "retained definition history is missing its authority",
        ));
    }
    if omit_unadmitted_anchor
        && (rows.len() != 1 || rows[0].2.is_some() || has_retained_history(connection)?)
    {
        return Err(PortcoveError::conflict(
            "initialized authority has advanced since provisioning",
        ));
    }
    let library_id: String = connection.query_row(
        "SELECT id FROM library_identity WHERE singleton=1",
        [],
        |row| row.get(0),
    )?;
    let installed = !rows.is_empty() && !omit_unadmitted_anchor;
    let root_path = std::fs::canonicalize(library.root())?;
    let path = crate::path::unicode(&root_path, "library root")?;
    let state = retained_state(connection, omit_unadmitted_anchor)?;
    let expected_plan = hex::encode(Sha256::digest(serde_json::to_vec(&(
        1,
        &library_id,
        path,
        &anchor,
        installed,
        state,
    ))?));
    Ok(DefinitionAuthorityReview {
        provisioning_schema: 1,
        configured: root.is_some(),
        library_id,
        compiled_anchor_sha256: anchor,
        installed_anchor_sha256: (!omit_unadmitted_anchor)
            .then(|| rows.first().map(|row| row.0.clone()))
            .flatten(),
        installed,
        expected_plan,
    })
}

fn review(
    library: &Library,
    bytes: &[u8],
    profile: InitialRootProfile,
) -> Result<DefinitionAuthorityReview> {
    let root = configured_root(bytes, profile)?;
    let mut connection = library.connection()?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Deferred)?;
    let result = review_from(library, &transaction, root, false)?;
    transaction.commit()?;
    Ok(result)
}

fn require_installed(library: &Library, bytes: &[u8], profile: InitialRootProfile) -> Result<()> {
    let reviewed = review(library, bytes, profile)?;
    if !reviewed.configured {
        return Err(PortcoveError::unsupported(
            "this build has no configured definition authority",
        ));
    }
    if !reviewed.installed || reviewed.installed_anchor_sha256 != reviewed.compiled_anchor_sha256 {
        return Err(PortcoveError::conflict(
            "provision this release's fixed definition authority before refresh",
        ));
    }
    Ok(())
}

pub(super) fn installed_compiled_root(library: &Library) -> Result<&'static [u8]> {
    require_installed(library, COMPILED_ROOT, compiled_profile()?)?;
    Ok(COMPILED_ROOT)
}

#[cfg(test)]
pub(crate) fn installed_fixture_root<'a>(library: &Library, bytes: &'a [u8]) -> Result<&'a [u8]> {
    require_installed(library, bytes, InitialRootProfile::LegacyTwoOfThreeV1)?;
    Ok(bytes)
}

fn apply(
    library: &Library,
    bytes: &[u8],
    expected: &str,
    profile: InitialRootProfile,
) -> Result<DefinitionAuthorityProvisioning> {
    if expected.len() != 64
        || !expected
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(PortcoveError::usage(
            "definition authority apply requires an exact reviewed plan",
        ));
    }
    let root = configured_root(bytes, profile)?.ok_or_else(|| {
        PortcoveError::unsupported("this build has no configured definition authority")
    })?;
    let mut connection = library.connection()?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let current = review_from(library, &transaction, Some(root), false)?;
    if current.expected_plan != expected {
        // Accept a lost response only for the exact still-unadmitted insertion.
        // Once a policy/floor/history advances, the original preimage is stale.
        if !current.installed
            || review_from(library, &transaction, Some(root), true)?.expected_plan != expected
        {
            return Err(PortcoveError::conflict(
                "definition authority review is stale",
            ));
        }
    }
    let changed = !current.installed;
    if changed {
        transaction.execute(
            "INSERT INTO definition_publisher_authority(anchor_sha256,trusted_root_json) VALUES(?1,?2)",
            params![current.compiled_anchor_sha256, root],
        )?;
    }
    let review = review_from(library, &transaction, Some(root), false)?;
    transaction.commit()?;
    Ok(DefinitionAuthorityProvisioning { changed, review })
}

impl Library {
    /// Review only the root compiled into this release; no candidate root input.
    pub fn review_definition_authority(&self) -> Result<DefinitionAuthorityReview> {
        review(self, COMPILED_ROOT, compiled_profile()?)
    }

    /// Explicit one-time installation of this release's separately approved
    /// anchor. This grants no policy, selects no definition and performs no I/O
    /// outside the library transaction. Existing trust/floors are never replaced.
    pub fn provision_definition_authority(
        &self,
        expected_plan: &str,
    ) -> Result<DefinitionAuthorityProvisioning> {
        apply(self, COMPILED_ROOT, expected_plan, compiled_profile()?)
    }
}

#[cfg(test)]
pub(crate) fn review_fixture(library: &Library, bytes: &[u8]) -> Result<DefinitionAuthorityReview> {
    review(library, bytes, InitialRootProfile::LegacyTwoOfThreeV1)
}

#[cfg(test)]
pub(crate) fn apply_fixture(
    library: &Library,
    bytes: &[u8],
    expected: &str,
) -> Result<DefinitionAuthorityProvisioning> {
    apply(
        library,
        bytes,
        expected,
        InitialRootProfile::LegacyTwoOfThreeV1,
    )
}

#[cfg(test)]
pub(crate) fn review_single_owner_fixture(
    library: &Library,
    bytes: &[u8],
) -> Result<DefinitionAuthorityReview> {
    review(library, bytes, InitialRootProfile::SingleOwnerOneOfOneV1)
}

#[cfg(test)]
pub(crate) fn apply_single_owner_fixture(
    library: &Library,
    bytes: &[u8],
    expected: &str,
) -> Result<DefinitionAuthorityProvisioning> {
    apply(
        library,
        bytes,
        expected,
        InitialRootProfile::SingleOwnerOneOfOneV1,
    )
}
