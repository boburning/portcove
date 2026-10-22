//! Declaration validation for proposed curated bytes. These types cannot
//! construct an acquisition capability or authenticate their evidence claims.

use crate::{Platform, PortDefinition, PortcoveError, Result};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub(crate) fn migrate(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        "CREATE TABLE curated_artifact_admissions (
            repository_id TEXT NOT NULL CHECK(length(repository_id) BETWEEN 1 AND 20),
            asset_id TEXT NOT NULL CHECK(length(asset_id) BETWEEN 1 AND 20),
            identity_json TEXT NOT NULL CHECK(length(identity_json)<=8192),
            policy_sha256 TEXT NOT NULL CHECK(length(policy_sha256)=64),
            PRIMARY KEY(repository_id,asset_id)
        );
        CREATE TABLE curated_artifact_history (
            singleton INTEGER PRIMARY KEY CHECK(singleton=1),
            admission_count INTEGER NOT NULL CHECK(admission_count>=0),
            transition_count INTEGER NOT NULL CHECK(transition_count>=0),
            scope_count INTEGER NOT NULL CHECK(scope_count>=0)
        );
        CREATE TABLE curated_artifact_scopes (
            repository_id TEXT NOT NULL,
            asset_id TEXT NOT NULL,
            namespace TEXT NOT NULL,
            stable_id TEXT NOT NULL,
            anchor_sha256 TEXT NOT NULL CHECK(length(anchor_sha256)=64),
            policy_sha256 TEXT NOT NULL CHECK(length(policy_sha256)=64),
            PRIMARY KEY(repository_id,asset_id,namespace,stable_id,anchor_sha256),
            FOREIGN KEY(repository_id,asset_id) REFERENCES curated_artifact_admissions(repository_id,asset_id)
        );
        CREATE TABLE curated_transition_receipts (
            policy_sha256 TEXT PRIMARY KEY CHECK(length(policy_sha256)=64),
            policy_json TEXT NOT NULL CHECK(length(policy_json)<=65536),
            provenance_json TEXT NOT NULL CHECK(length(provenance_json)<=16384)
        );
        INSERT INTO curated_artifact_history VALUES(1,0,0,0);",
    )?;
    Ok(())
}

fn require_complete_history(connection: &Connection) -> Result<i64> {
    let expected: Option<i64> = connection
        .query_row(
            "SELECT admission_count FROM curated_artifact_history WHERE singleton=1",
            [],
            |row| row.get(0),
        )
        .optional()?;
    let actual: i64 = connection.query_row(
        "SELECT count(*) FROM curated_artifact_admissions",
        [],
        |row| row.get(0),
    )?;
    if expected != Some(actual) {
        return Err(PortcoveError::state(
            "curated accepted identity history is incomplete",
        ));
    }
    let transitions: i64 = connection.query_row(
        "SELECT transition_count FROM curated_artifact_history WHERE singleton=1",
        [],
        |row| row.get(0),
    )?;
    let receipts: i64 = connection.query_row(
        "SELECT count(*) FROM curated_transition_receipts",
        [],
        |row| row.get(0),
    )?;
    if transitions != receipts || receipts > 256 {
        return Err(PortcoveError::state(
            "curated transition history is incomplete or exceeds its bound",
        ));
    }
    let expected_scopes: i64 = connection.query_row(
        "SELECT scope_count FROM curated_artifact_history WHERE singleton=1",
        [],
        |row| row.get(0),
    )?;
    let actual_scopes: i64 =
        connection.query_row("SELECT count(*) FROM curated_artifact_scopes", [], |row| {
            row.get(0)
        })?;
    if expected_scopes != actual_scopes {
        return Err(PortcoveError::state(
            "curated artifact scope history is incomplete",
        ));
    }
    Ok(actual)
}

/// Membership is created only by the authenticated candidate-admission transaction.
/// It survives later omission of this artifact from a definition.
pub(crate) fn retain_scoped_admission(
    connection: &Connection,
    repository_id: u64,
    record: &CuratedAcquisitionRecord,
    namespace: &str,
    stable_id: &str,
    anchor_sha256: &str,
    policy_sha256: &str,
) -> Result<()> {
    retain_admission(connection, repository_id, record, policy_sha256)?;
    let inserted = connection.execute(
        "INSERT INTO curated_artifact_scopes VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(repository_id,asset_id,namespace,stable_id,anchor_sha256) DO NOTHING",
        params![repository_id.to_string(), record.asset_id.to_string(), namespace, stable_id, anchor_sha256, policy_sha256],
    )?;
    if inserted == 1 {
        connection.execute(
            "UPDATE curated_artifact_history SET scope_count=scope_count+1 WHERE singleton=1",
            [],
        )?;
    }
    Ok(())
}

pub(crate) fn require_scoped_artifact(
    connection: &Connection,
    repository_id: u64,
    asset_id: u64,
    sha256: &str,
    namespace: &str,
    stable_id: &str,
    anchor_sha256: &str,
) -> Result<()> {
    require_known_artifact(connection, repository_id, asset_id, sha256)?;
    let admitted: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM curated_artifact_scopes WHERE repository_id=?1 AND asset_id=?2 AND namespace=?3 AND stable_id=?4 AND anchor_sha256=?5)",
        params![repository_id.to_string(), asset_id.to_string(), namespace, stable_id, anchor_sha256],
        |row| row.get(0),
    )?;
    if !admitted {
        return Err(PortcoveError::verification(
            "curated transition has no artifact admission in its authority scope",
        ));
    }
    Ok(())
}

/// Only the independently authenticated policy-admission transaction calls this.
pub(crate) fn retain_transition_receipt(
    connection: &Connection,
    policy_sha256: &str,
    policy_json: &str,
    provenance_json: &str,
) -> Result<()> {
    require_complete_history(connection)?;
    let existing: Option<(String, String)> = connection.query_row("SELECT policy_json,provenance_json FROM curated_transition_receipts WHERE policy_sha256=?1", [policy_sha256], |row| Ok((row.get(0)?, row.get(1)?))).optional()?;
    if let Some(existing) = existing {
        let original: serde_json::Value = serde_json::from_str(&existing.1)?;
        let renewed: serde_json::Value = serde_json::from_str(provenance_json)?;
        if existing.0 != policy_json
            || original.get("anchor_sha256") != renewed.get("anchor_sha256")
        {
            return Err(PortcoveError::verification(
                "curated transition receipt changed at its accepted identity",
            ));
        }
        return Ok(());
    }
    let count: i64 = connection.query_row(
        "SELECT transition_count FROM curated_artifact_history WHERE singleton=1",
        [],
        |row| row.get(0),
    )?;
    if count == 256 {
        return Err(PortcoveError::conflict(
            "curated transition receipt capacity requires review; evidence retained",
        ));
    }
    connection.execute(
        "INSERT INTO curated_transition_receipts VALUES(?1,?2,?3)",
        params![policy_sha256, policy_json, provenance_json],
    )?;
    if connection.execute("UPDATE curated_artifact_history SET transition_count=transition_count+1 WHERE singleton=1 AND transition_count=?1", [count])? != 1 {
        return Err(PortcoveError::conflict("curated transition history changed during admission"));
    }
    Ok(())
}

pub(crate) fn retained_transition_receipts(
    connection: &Connection,
) -> Result<Vec<(String, String, String)>> {
    require_complete_history(connection)?;
    let mut statement = connection.prepare("SELECT policy_sha256,policy_json,provenance_json FROM curated_transition_receipts ORDER BY policy_sha256")?;
    Ok(statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
        .collect::<std::result::Result<Vec<_>, _>>()?)
}

pub(crate) fn require_known_artifact(
    connection: &Connection,
    repository_id: u64,
    asset_id: u64,
    sha256: &str,
) -> Result<()> {
    require_complete_history(connection)?;
    let identity: Option<String> = connection.query_row("SELECT identity_json FROM curated_artifact_admissions WHERE repository_id=?1 AND asset_id=?2", params![repository_id.to_string(),asset_id.to_string()], |row| row.get(0)).optional()?;
    let identity = identity.ok_or_else(|| {
        PortcoveError::verification("curated transition has no previously admitted artifact")
    })?;
    let identity: serde_json::Value = serde_json::from_str(&identity)?;
    if identity.get("sha256").and_then(serde_json::Value::as_str) != Some(sha256) {
        return Err(PortcoveError::verification(
            "curated transition differs from the admitted artifact",
        ));
    }
    Ok(())
}

fn immutable_identity(record: &CuratedAcquisitionRecord) -> Result<String> {
    // An asset can serve multiple platforms, but its immutable upstream and byte
    // identities cannot vary by title, policy revision, grant or platform.
    let identity = serde_json::to_string(&serde_json::json!({
        "repository": record.repository,
        "release_id": record.release_id,
        "asset_id": record.asset_id,
        "tag": record.tag,
        "commit_sha1": record.commit_sha1,
        "route": record.route,
        "acquisition_url": record.acquisition_url,
        "filename": record.filename,
        "size": record.size,
        "sha256": record.sha256,
    }))?;
    if identity.len() > 8192 {
        return Err(PortcoveError::verification(
            "curated identity exceeds its bound",
        ));
    }
    Ok(identity)
}

pub(crate) fn retain_admission(
    connection: &Connection,
    repository_id: u64,
    record: &CuratedAcquisitionRecord,
    policy_sha256: &str,
) -> Result<()> {
    let retained_count = require_complete_history(connection)?;
    let identity = immutable_identity(record)?;
    let existing: Option<String> = connection.query_row(
        "SELECT identity_json FROM curated_artifact_admissions WHERE repository_id=?1 AND asset_id=?2",
        params![repository_id.to_string(), record.asset_id.to_string()],
        |row| row.get(0),
    ).optional()?;
    if existing
        .as_ref()
        .is_some_and(|existing| existing != &identity)
    {
        return Err(PortcoveError::verification(
            "curated asset identity cannot replace its previously accepted bytes",
        ));
    }
    if existing.is_none() {
        connection.execute(
            "INSERT INTO curated_artifact_admissions(repository_id,asset_id,identity_json,policy_sha256) VALUES(?1,?2,?3,?4)",
            params![repository_id.to_string(), record.asset_id.to_string(), identity, policy_sha256],
        )?;
        if connection.execute("UPDATE curated_artifact_history SET admission_count=admission_count+1 WHERE singleton=1 AND admission_count=?1", [retained_count])? != 1 {
            return Err(PortcoveError::conflict("curated identity history changed during admission"));
        }
    }
    Ok(())
}

pub(crate) fn require_retained_identity(
    connection: &Connection,
    repository_id: u64,
    record: &CuratedAcquisitionRecord,
) -> Result<()> {
    require_complete_history(connection)?;
    let existing: Option<String> = connection.query_row(
        "SELECT identity_json FROM curated_artifact_admissions WHERE repository_id=?1 AND asset_id=?2",
        params![repository_id.to_string(), record.asset_id.to_string()],
        |row| row.get(0),
    ).optional()?;
    if existing.as_deref() != Some(immutable_identity(record)?.as_str()) {
        return Err(PortcoveError::verification(
            "curated acquisition lost its accepted immutable identity",
        ));
    }
    Ok(())
}

pub(crate) fn repository_for_retained_record(
    connection: &Connection,
    record: &CuratedAcquisitionRecord,
) -> Result<u64> {
    require_complete_history(connection)?;
    let mut statement = connection.prepare("SELECT repository_id FROM curated_artifact_admissions WHERE asset_id=?1 AND identity_json=?2")?;
    let matches = statement
        .query_map(
            params![record.asset_id.to_string(), immutable_identity(record)?],
            |row| row.get::<_, String>(0),
        )?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if matches.len() != 1 {
        return Err(PortcoveError::verification(
            "retained curated record has no unique admitted repository identity",
        ));
    }
    matches[0]
        .parse()
        .map_err(|_| PortcoveError::state("retained curated repository identity is invalid"))
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CuratedEvidenceReference {
    pub url: String,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CuratedAcquisitionRecord {
    pub record_version: u32,
    pub repository: String,
    pub upstream_url: String,
    pub acquisition_host: String,
    pub acquisition_url: String,
    pub release_id: u64,
    pub tag: String,
    pub commit_sha1: String,
    pub asset_id: u64,
    pub platform: Platform,
    pub route: String,
    pub filename: String,
    pub size: u64,
    pub sha256: String,
    pub acquisition_evidence: CuratedEvidenceReference,
    pub distribution_basis: String,
    pub distribution_evidence: CuratedEvidenceReference,
    pub independent_review: CuratedEvidenceReference,
    pub protected_acceptance: CuratedEvidenceReference,
}

fn canonical_hash(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn bounded_text(value: &str, maximum: usize) -> bool {
    !value.trim().is_empty() && value.len() <= maximum && !value.chars().any(char::is_control)
}

fn https_reference(value: &str) -> Option<reqwest::Url> {
    if !bounded_text(value, 2048) {
        return None;
    }
    let url = reqwest::Url::parse(value).ok()?;
    (url.scheme() == "https"
        && url.port_or_known_default() == Some(443)
        && url.username().is_empty()
        && url.password().is_none()
        && url
            .host_str()
            .is_some_and(|host| host.contains('.') && host.parse::<std::net::IpAddr>().is_err()))
    .then_some(url)
}

impl CuratedAcquisitionRecord {
    pub(crate) fn verify_metadata(&self, observed: CuratedReleaseMetadata<'_>) -> Result<String> {
        if observed.release_id != Some(self.release_id)
            || observed.asset_id != Some(self.asset_id)
            || observed.tag != self.tag
            || observed.commit_sha1 != self.commit_sha1
            || observed.filename != self.filename
            || observed.url != self.acquisition_url
            || observed.size != self.size
            || observed
                .publisher_sha256
                .is_some_and(|digest| digest != self.sha256)
        {
            return Err(PortcoveError::verification(
                "upstream metadata differs from the accepted curated identity",
            ));
        }
        Ok(self.sha256.clone())
    }
    /// Checks declared identity and attribution only. No URL is fetched and
    /// neither digest equality nor a claimed acceptance reference grants trust.
    pub(crate) fn validate(&self, repository: &str, platform: Platform) -> Result<()> {
        if !crate::definition_acquisition::valid_github_repository(repository) {
            return Err(PortcoveError::usage(
                "invalid curated repository coordinates",
            ));
        }
        let upstream = format!("https://github.com/{repository}");
        let acquisition = https_reference(&self.acquisition_url);
        let mut expected_acquisition = https_reference(&upstream)
            .ok_or_else(|| PortcoveError::usage("invalid curated upstream declaration"))?;
        expected_acquisition
            .path_segments_mut()
            .map_err(|_| PortcoveError::usage("invalid curated upstream coordinates"))?
            .extend([
                "releases",
                "download",
                self.tag.as_str(),
                self.filename.as_str(),
            ]);
        let tag_valid = bounded_text(&self.tag, 255)
            && self.tag.split('/').all(|part| {
                !part.is_empty()
                    && !part.starts_with('.')
                    && !part.ends_with('.')
                    && !part.ends_with(".lock")
                    && !part.contains("..")
                    && part.bytes().all(|byte| {
                        byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.')
                    })
            });
        let references = [
            &self.acquisition_evidence,
            &self.distribution_evidence,
            &self.independent_review,
            &self.protected_acceptance,
        ];
        if self.record_version != 1
            || self.repository != repository
            || self.upstream_url != upstream
            || self.acquisition_url != expected_acquisition.as_str()
            || self.platform != platform
            || self.route != "github-release-asset"
            || self.release_id == 0
            || self.asset_id == 0
            || !tag_valid
            || !canonical_hash(&self.commit_sha1, 40)
            || !canonical_hash(&self.sha256, 64)
            || self.size == 0
            || self.size > i64::MAX as u64
            || !bounded_text(&self.filename, 255)
            || self.filename.contains(['/', '\\'])
            || matches!(self.filename.as_str(), "." | "..")
            || crate::archive::validate_relative_path(&self.filename, false).is_err()
            || !bounded_text(&self.distribution_basis, 2048)
            || acquisition.as_ref().is_none_or(|url| {
                url.host_str() != Some(self.acquisition_host.as_str())
                    || url.query().is_some()
                    || url.fragment().is_some()
            })
            || references.iter().any(|reference| {
                https_reference(&reference.url).is_none() || !canonical_hash(&reference.sha256, 64)
            })
        {
            return Err(PortcoveError::usage(
                "invalid curated acquisition declaration",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Copy)]
pub(crate) struct CuratedReleaseMetadata<'a> {
    pub(crate) release_id: Option<u64>,
    pub(crate) asset_id: Option<u64>,
    pub(crate) tag: &'a str,
    pub(crate) commit_sha1: &'a str,
    pub(crate) filename: &'a str,
    pub(crate) url: &'a str,
    pub(crate) size: u64,
    pub(crate) publisher_sha256: Option<&'a str>,
}

pub(crate) fn require_runtime_scope(
    port: &PortDefinition,
    scope: Option<&crate::DefinitionAcquisitionScope>,
) -> Result<()> {
    if port.release.curated.is_empty() {
        return Ok(());
    }
    let scope = scope.ok_or_else(|| {
        PortcoveError::unsupported(
            "curated acquisition requires independently admitted capability support",
        )
    })?;
    scope.require_current()?;
    scope.require_port(port)
}

/// Existing publisher-digest grants do not admit curated claims. Every Core
/// acquisition caller must fail before a provider or cached selection can run.
pub(crate) fn require_runtime_authority(port: &PortDefinition) -> Result<()> {
    if !port.release.curated.is_empty() {
        return Err(PortcoveError::unsupported(
            "curated acquisition requires independently admitted capability support",
        ));
    }
    Ok(())
}

#[cfg(test)]
pub(crate) fn fixture_record() -> CuratedAcquisitionRecord {
    let evidence = || CuratedEvidenceReference {
        url: "https://example.invalid/curated-evidence#review".into(),
        sha256: "b".repeat(64),
    };
    CuratedAcquisitionRecord {
        record_version: 1,
        repository: "ThatGuyMcd/DKR-R".into(),
        upstream_url: "https://github.com/ThatGuyMcd/DKR-R".into(),
        acquisition_host: "github.com".into(),
        acquisition_url: "https://github.com/ThatGuyMcd/DKR-R/releases/download/fixture/game.zip"
            .into(),
        release_id: 1,
        tag: "fixture".into(),
        commit_sha1: "a".repeat(40),
        asset_id: 2,
        platform: Platform::WindowsX86_64,
        route: "github-release-asset".into(),
        filename: "game.zip".into(),
        size: 123,
        sha256: "c".repeat(64),
        acquisition_evidence: evidence(),
        distribution_basis: "Synthetic attribution declaration, not a permission grant".into(),
        distribution_evidence: evidence(),
        independent_review: evidence(),
        protected_acceptance: evidence(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn curated_transition_receipts_preserve_renewal_capacity_and_incomplete_history() {
        let directory = tempfile::tempdir().unwrap();
        let library = crate::Library::open(directory.path()).unwrap();
        let mut connection = library.connection().unwrap();
        let original =
            serde_json::json!({"anchor_sha256": "a".repeat(64), "renewal": 1}).to_string();
        let renewed =
            serde_json::json!({"anchor_sha256": "a".repeat(64), "renewal": 2}).to_string();
        let other = serde_json::json!({"anchor_sha256": "b".repeat(64)}).to_string();
        // Storage-only fixtures do not stand in for authenticated admission.
        let transaction = connection.transaction().unwrap();
        for index in 0..256 {
            retain_transition_receipt(&transaction, &format!("{index:064x}"), "{}", &original)
                .unwrap();
        }
        transaction.commit().unwrap();
        retain_transition_receipt(&connection, &format!("{:064x}", 0), "{}", &renewed).unwrap();
        let retained = retained_transition_receipts(&connection).unwrap();
        assert_eq!(retained.len(), 256);
        assert_eq!(retained[0].2, original);
        assert!(
            retain_transition_receipt(&connection, &format!("{:064x}", 0), "{}", &other).is_err()
        );
        assert!(
            retain_transition_receipt(
                &connection,
                &format!("{:064x}", 0),
                "{\"changed\":true}",
                &original
            )
            .is_err()
        );
        let error =
            retain_transition_receipt(&connection, &format!("{:064x}", 256), "{}", &original)
                .unwrap_err();
        assert!(error.to_string().contains("capacity"));
        assert_eq!(retained_transition_receipts(&connection).unwrap(), retained);
        connection
            .execute(
                "DELETE FROM curated_transition_receipts WHERE policy_sha256=?1",
                [format!("{:064x}", 0)],
            )
            .unwrap();
        assert!(retained_transition_receipts(&connection).is_err());
        assert!(
            retain_transition_receipt(&connection, &format!("{:064x}", 0), "{}", &original)
                .is_err()
        );
        let count: i64 = connection
            .query_row(
                "SELECT count(*) FROM curated_transition_receipts",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 255);
    }

    #[test]
    fn curated_admitted_identity_survives_reopen_and_refuses_silent_repin() {
        let directory = tempfile::tempdir().unwrap();
        let library = crate::Library::open(directory.path()).unwrap();
        let record = fixture_record();
        retain_admission(&library.connection().unwrap(), 7, &record, &"a".repeat(64)).unwrap();
        // Independent review/protected evidence can advance without silently
        // replacing the first accepted immutable identity.
        let mut reviewed = record.clone();
        reviewed.independent_review.sha256 = "e".repeat(64);
        retain_admission(
            &library.connection().unwrap(),
            7,
            &reviewed,
            &"b".repeat(64),
        )
        .unwrap();
        drop(library);
        let reopened = crate::Library::open(directory.path()).unwrap();
        let connection = reopened.connection().unwrap();
        require_retained_identity(&connection, 7, &record).unwrap();
        for changed in [
            CuratedAcquisitionRecord {
                sha256: "d".repeat(64),
                ..record.clone()
            },
            CuratedAcquisitionRecord {
                size: record.size + 1,
                ..record.clone()
            },
            CuratedAcquisitionRecord {
                commit_sha1: "d".repeat(40),
                ..record.clone()
            },
        ] {
            assert!(retain_admission(&connection, 7, &changed, &"c".repeat(64)).is_err());
            assert!(require_retained_identity(&connection, 7, &changed).is_err());
        }
        // Distinct upstream assets can receive their own exact admissions.
        let next = CuratedAcquisitionRecord {
            asset_id: record.asset_id + 1,
            sha256: "d".repeat(64),
            ..record.clone()
        };
        retain_admission(&connection, 7, &next, &"c".repeat(64)).unwrap();
        require_retained_identity(&connection, 7, &next).unwrap();
        let first_policy: String = connection.query_row(
            "SELECT policy_sha256 FROM curated_artifact_admissions WHERE repository_id='7' AND asset_id=?1",
            [record.asset_id.to_string()], |row| row.get(0),
        ).unwrap();
        assert_eq!(first_policy, "a".repeat(64));
        // A missing or inconsistent completeness marker is not an empty new
        // library. Neither reads nor policy retries may initialize it again.
        connection
            .execute("UPDATE curated_artifact_history SET admission_count=3", [])
            .unwrap();
        assert!(require_retained_identity(&connection, 7, &record).is_err());
        assert!(retain_admission(&connection, 7, &record, &"c".repeat(64)).is_err());
        connection
            .execute("DELETE FROM curated_artifact_history", [])
            .unwrap();
        assert!(require_retained_identity(&connection, 7, &record).is_err());
        assert!(retain_admission(&connection, 7, &next, &"d".repeat(64)).is_err());
        let retained: i64 = connection
            .query_row(
                "SELECT count(*) FROM curated_artifact_admissions",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(retained, 2);
        // Restore only the owned fixture marker to exercise row loss below;
        // production has no automatic history repair or initialization path.
        connection
            .execute("INSERT INTO curated_artifact_history VALUES(1,2,0,0)", [])
            .unwrap();
        connection
            .execute(
                "DELETE FROM curated_artifact_admissions WHERE repository_id='7' AND asset_id=?1",
                [record.asset_id.to_string()],
            )
            .unwrap();
        assert!(
            require_retained_identity(&connection, 7, &record).is_err(),
            "missing history cannot fall back to a proposal"
        );
        assert!(
            retain_admission(&connection, 7, &record, &"a".repeat(64)).is_err(),
            "an exact retry cannot manufacture missing history"
        );
        assert!(
            retain_admission(&connection, 7, &next, &"d".repeat(64)).is_err(),
            "even a new asset cannot renew an incomplete history"
        );
    }

    #[test]
    fn curated_metadata_never_replaces_the_exact_expected_identity() {
        let record = fixture_record();
        let baseline = CuratedReleaseMetadata {
            release_id: Some(record.release_id),
            asset_id: Some(record.asset_id),
            tag: &record.tag,
            commit_sha1: &record.commit_sha1,
            filename: &record.filename,
            url: &record.acquisition_url,
            size: record.size,
            publisher_sha256: None,
        };
        assert_eq!(record.verify_metadata(baseline).unwrap(), record.sha256);
        assert!(
            record
                .verify_metadata(CuratedReleaseMetadata {
                    publisher_sha256: Some(&record.sha256),
                    ..baseline
                })
                .is_ok()
        );
        for changed in [
            CuratedReleaseMetadata {
                release_id: None,
                ..baseline
            },
            CuratedReleaseMetadata {
                release_id: Some(99),
                ..baseline
            },
            CuratedReleaseMetadata {
                asset_id: None,
                ..baseline
            },
            CuratedReleaseMetadata {
                asset_id: Some(99),
                ..baseline
            },
            CuratedReleaseMetadata {
                tag: "other",
                ..baseline
            },
            CuratedReleaseMetadata {
                commit_sha1: "different",
                ..baseline
            },
            CuratedReleaseMetadata {
                filename: "different.zip",
                ..baseline
            },
            CuratedReleaseMetadata {
                url: "https://other.invalid/game.zip",
                ..baseline
            },
            CuratedReleaseMetadata {
                size: 0,
                ..baseline
            },
            CuratedReleaseMetadata {
                size: record.size + 1,
                ..baseline
            },
            CuratedReleaseMetadata {
                publisher_sha256: Some("different"),
                ..baseline
            },
        ] {
            assert!(record.verify_metadata(changed).is_err());
        }
    }

    #[test]
    fn curated_record_validation_binds_identity_and_bounded_evidence() {
        let record = fixture_record();
        record
            .validate(&record.repository, record.platform)
            .unwrap();
        assert!(record.validate("Other/Project", record.platform).is_err());
        assert!(
            record
                .validate(&record.repository, Platform::LinuxX86_64)
                .is_err()
        );
        let valid = serde_json::to_value(&record).unwrap();
        for (key, child, replacement) in [
            ("record_version", None, serde_json::json!(2)),
            ("release_id", None, serde_json::json!(0)),
            ("asset_id", None, serde_json::json!(0)),
            ("tag", None, serde_json::json!("../bad")),
            ("commit_sha1", None, serde_json::json!("a".repeat(39))),
            ("route", None, serde_json::json!("direct-manifest")),
            ("filename", None, serde_json::json!("../game.zip")),
            ("size", None, serde_json::json!(0)),
            ("sha256", None, serde_json::json!("C".repeat(64))),
            ("acquisition_host", None, serde_json::json!("other.invalid")),
            (
                "acquisition_url",
                None,
                serde_json::json!(
                    "https://github.com/Other/Project/releases/download/fixture/game.zip"
                ),
            ),
            (
                "acquisition_url",
                None,
                serde_json::json!("http://github.com/game.zip"),
            ),
            (
                "acquisition_url",
                None,
                serde_json::json!("https://user:password@github.com/game.zip"),
            ),
            (
                "acquisition_url",
                None,
                serde_json::json!("https://127.0.0.1/game.zip"),
            ),
            (
                "acquisition_url",
                None,
                serde_json::json!("https://github.com/game.zip?token=secret"),
            ),
            (
                "distribution_basis",
                None,
                serde_json::json!("x".repeat(2049)),
            ),
            (
                "independent_review",
                Some("sha256"),
                serde_json::json!("unknown"),
            ),
            (
                "protected_acceptance",
                Some("url"),
                serde_json::json!("file:///claim.json"),
            ),
        ] {
            let mut value = valid.clone();
            let target = value.get_mut(key).unwrap();
            let target = match child {
                Some(child) => target.get_mut(child).unwrap(),
                None => target,
            };
            *target = replacement;
            let changed: CuratedAcquisitionRecord = serde_json::from_value(value).unwrap();
            assert!(
                changed
                    .validate(&record.repository, record.platform)
                    .is_err(),
                "{key}/{child:?}"
            );
        }
        for key in [None, Some("independent_review")] {
            let mut value = valid.clone();
            let target = match key {
                Some(key) => value.get_mut(key).unwrap(),
                None => &mut value,
            };
            target
                .as_object_mut()
                .unwrap()
                .insert("trust_me".into(), serde_json::json!(true));
            assert!(serde_json::from_value::<CuratedAcquisitionRecord>(value).is_err());
        }
    }

    #[test]
    fn curated_proposal_inspection_is_inert_and_rejects_misbound_records() {
        // Exercise the retained GitHub route, not today's non-owning launcher.
        let retained =
            crate::Catalog::from_json(include_str!("../catalog/catalog-schema1-fixture.json"))
                .unwrap();
        let mut value =
            serde_json::to_value(crate::Catalog::embedded().unwrap().document()).unwrap();
        let port = value["ports"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|port| port["id"] == "dkr-r")
            .unwrap();
        *port = serde_json::to_value(retained.port("dkr-r").unwrap()).unwrap();
        port["release"]["curated"] = serde_json::json!({"windows-x86-64": fixture_record()});
        let root = tempfile::tempdir().unwrap();
        let input = root.path().join("proposal.json");
        let bytes = serde_json::to_vec(&value).unwrap();
        std::fs::write(&input, &bytes).unwrap();
        let inspected = crate::Catalog::inspect_proposal(&input).unwrap();
        let port = inspected
            .ports
            .iter()
            .find(|port| port.port_id == "dkr-r")
            .unwrap();
        assert_eq!(port.curated_record_sha256.len(), 1);
        assert!(inspected.scope.contains("no trust"));
        assert_eq!(std::fs::read(&input).unwrap(), bytes);
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 1);
        let parsed = crate::Catalog::from_json(std::str::from_utf8(&bytes).unwrap()).unwrap();
        assert!(require_runtime_authority(parsed.port("dkr-r").unwrap()).is_err());
        for repository in [
            "owner/..",
            "../project",
            "owner/project?alias",
            "owner/project#alias",
            "owner/%2e%2e",
        ] {
            let mut invalid = value.clone();
            let port = invalid["ports"]
                .as_array_mut()
                .unwrap()
                .iter_mut()
                .find(|port| port["id"] == "dkr-r")
                .unwrap();
            port["release"]["repository"] = serde_json::json!(repository);
            let record = &mut port["release"]["curated"]["windows-x86-64"];
            record["repository"] = serde_json::json!(repository);
            record["upstream_url"] = serde_json::json!(format!("https://github.com/{repository}"));
            record["acquisition_url"] =
                serde_json::json!("https://github.com/releases/download/fixture/game.zip");
            std::fs::write(&input, serde_json::to_vec(&invalid).unwrap()).unwrap();
            assert!(
                crate::Catalog::inspect_proposal(&input).is_err(),
                "{repository}"
            );
        }
        value["schema_version"] = serde_json::json!(1);
        assert!(crate::Catalog::from_json(&value.to_string()).is_err());
    }

    #[tokio::test]
    async fn curated_claims_refuse_github_acquisition_before_network() {
        use crate::ReleaseProvider;
        let catalog =
            crate::Catalog::from_json(include_str!("../catalog/catalog-schema1-fixture.json"))
                .unwrap();
        let mut port = catalog.port("dkr-r").unwrap().clone();
        assert!(require_runtime_authority(&port).is_ok());
        assert!(
            !serde_json::to_value(&port.release)
                .unwrap()
                .as_object()
                .unwrap()
                .contains_key("curated")
        );
        port.release
            .curated
            .insert(Platform::WindowsX86_64, fixture_record());
        let provider = crate::GithubReleaseProvider::with_api_root("http://127.0.0.1:9").unwrap();
        let error = provider
            .resolve(
                &port,
                crate::ReleaseChannel::Stable,
                Platform::WindowsX86_64,
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Unsupported);
        assert!(crate::DefinitionAcquisitionScope::validate_port(&port).is_err());
    }
}
